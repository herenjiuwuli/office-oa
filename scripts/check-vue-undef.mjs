// 扫 src/ 下所有 .js / .vue 的 script 部分，报告「用到但未在文件内声明」的大写开头标识符
// 专抓 import 漏写、常量漏声明（vite build 只 warning 不报错，真机一运行才炸）
//
// 用法：node scripts/check-vue-undef.mjs <src-dir>  （默认 src）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BUILTIN = new Set([
  'Object','Array','JSON','Math','Promise','Date','String','Number','Boolean','RegExp',
  'Error','TypeError','RangeError','SyntaxError','Map','Set','WeakMap','WeakSet','Symbol',
  'Reflect','Proxy','Function','BigInt','Intl','URL','URLSearchParams','AbortController',
  'Blob','File','FormData','Headers','Request','Response','Event','CustomEvent','MutationObserver',
  'IntersectionObserver','ResizeObserver','ArrayBuffer','Uint8Array','DataView',
  'console','window','document','globalThis','process','Buffer','require','module','exports',
  'Infinity','NaN','undefined','null','true','false','localStorage','sessionStorage','navigator',
  'setTimeout','clearTimeout','setInterval','clearInterval','fetch','alert','confirm',
  'defineProps','defineEmits','defineExpose','withDefaults','defineOptions','defineModel',
  'Vue','Element','HTMLElement','Node','NodeList','DOMParser','XMLHttpRequest','WebSocket',
  'TextEncoder','TextDecoder','structuredClone','performance','location','history',
  // 浏览器内置 API（cv 项目里常用且容易误判）
  'FileReader',
])

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|vue)$/.test(e)) out.push(p)
  }
  return out
}

function extractScript(src, isVue) {
  if (!isVue) return { code: src, offset: 0 }
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return { code: '', offset: 0 }
  return { code: m[1], offset: src.slice(0, m.index).split('\n').length - 1 }
}

// 去注释 + 去字符串 + 去正则（保留换行，避免行号漂移）
function strip(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (s, p) => p + s.slice(1).replace(/./g, ' '))
    .replace(/'(?:\\.|[^'\\])*'/g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/"(?:\\.|[^"\\])*"/g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/`(?:\\.|[^`\\])*`/g, (s) => s.replace(/[^\n]/g, ' '))
    // 正则字面量也要剥离：/^[A-Z]+$/、/[T ]/ 里的 A、T 会被误判成「未声明的大写标识符」，
    // 这是最常见的误报来源。只在「可能开始正则」的位置剥（前面是分隔符/运算符或行首），
    // 这样 `a / b / c` 这类真正的除号不会被吃掉（把真代码当注释剥掉会漏掉真问题）。
    // 注意顺序：必须放在去字符串之后，否则字符串里的 `/` 会先被当成正则起止符。
    .replace(
      /(^|[([{,:;=!&|?+\-*%<>~^]\s*)\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+\/[dgimsuvy]*/gm,
      (s, p) => p + s.slice(p.length).replace(/[^\n]/g, ' '),
    )
}

function collectDeclared(code) {
  const d = new Set()
  for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) d.add(m[1])
  for (const m of code.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1])
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      const as = t.match(/\s+as\s+([A-Za-z_$][\w$]*)$/)
      d.add(as ? as[1] : t)
    }
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([^=;]+)/g)) {
    const seg = m[1]
    for (const dm of seg.matchAll(/[{\[]([^\]}]*)[}\]]/g)) {
      for (const part of dm[1].split(',')) {
        const t = part.trim().split(/\s*[:=]\s*/)[0].replace(/^\.\.\./, '').trim()
        if (/^[A-Za-z_$][\w$]*$/.test(t)) d.add(t)
      }
    }
    const plain = seg.replace(/[{\[]([^\]}]*)[}\]]/g, '')
    for (const part of plain.split(',')) {
      const t = part.trim().split(/\s*=\s*/)[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(t)) d.add(t)
    }
  }
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) d.add(m[1])
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1])
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) d.add(m[1])
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s*[:=]\s*/)[0].replace(/^\.\.\./, '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(t)) d.add(t)
    }
  }
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) d.add(m[1])
  return d
}

const files = walk(resolve(process.argv[2] || 'src'))
let total = 0
for (const f of files) {
  const src = readFileSync(f, 'utf-8')
  const { code, offset } = extractScript(src, f.endsWith('.vue'))
  if (!code.trim()) continue
  const clean = strip(code)
  const declared = collectDeclared(clean)
  const lines = clean.split('\n')
  const hits = []
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\b([A-Z][\w$]*)\b/g)) {
      const name = m[1]
      if (BUILTIN.has(name) || declared.has(name)) continue
      const idx = m.index
      if (idx > 0 && line[idx - 1] === '.') continue
      hits.push({ line: i + 1 + offset, name, text: line.trim().slice(0, 90) })
    }
  })
  if (hits.length) {
    total += hits.length
    console.log(`\n📄 ${f}`)
    for (const h of hits) console.log(`   L${h.line}  [${h.name}]  ${h.text}`)
  }
}
console.log(`\n合计可疑引用: ${total}`)
// 有可疑时退出码 1，方便 CI / 调用方发现
process.exit(total > 0 ? 1 : 0)
