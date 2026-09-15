// 扫 .vue 的 <template>：报告「组件标签 / 事件处理器」未在 script 中声明
// 补上纯 script 扫描的盲区（template 里引用不存在的东西，vite build 同样不报错）
//
// 用法：node scripts/check-vue-tpl.mjs <src-dir>  （默认 src）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const VUE_BUILTIN = new Set([
  'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense',
  'RouterLink', 'RouterView',
])

// vue-router $router 全局方法（$router.push/replace/back/...)
const ROUTER_METHODS = new Set([
  'push', 'replace', 'go', 'back', 'forward',
])
// window/浏览器内置常用方法名（即使存在引用链浏览器里也都有）
const DOM_METHODS = new Set([
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'fetch', 'alert', 'confirm', 'open', 'close',
  'scrollTo', 'requestAnimationFrame', 'cancelAnimationFrame',
  'getComputedStyle',
])

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith('.vue')) out.push(p)
  }
  return out
}

function collectDeclared(code) {
  const d = new Set()
  const clean = code
    .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (s, p) => p + s.slice(1).replace(/./g, ' '))
  for (const m of clean.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) d.add(m[1])
  for (const m of clean.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1])
  for (const m of clean.matchAll(/\bimport\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      const as = t.match(/\s+as\s+([A-Za-z_$][\w$]*)$/)
      d.add(as ? as[1] : t)
    }
  }
  for (const m of clean.matchAll(/\b(?:const|let|var)\s+([^=;]+)/g)) {
    for (const dm of m[1].matchAll(/[{\[]([^\]}]*)[}\]]/g)) {
      for (const part of dm[1].split(',')) {
        const t = part.trim().split(/\s*[:=]\s*/)[0].replace(/^\.\.\./, '').trim()
        if (/^[A-Za-z_$][\w$]*$/.test(t)) d.add(t)
      }
    }
    for (const part of m[1].replace(/[{\[]([^\]}]*)[}\]]/g, '').split(',')) {
      const t = part.trim().split(/\s*=\s*/)[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(t)) d.add(t)
    }
  }
  for (const m of clean.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) d.add(m[1])
  for (const m of clean.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1])
  return d
}

const files = walk(resolve(process.argv[2] || 'src'))
let total = 0
for (const f of files) {
  const src = readFileSync(f, 'utf-8')
  const tpl = src.match(/<template[^>]*>([\s\S]*?)<\/template>/)
  const scriptM = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  if (!tpl) continue
  const declared = collectDeclared(scriptM ? scriptM[1] : '')
  const tplCode = tpl[1]
  const tplOffset = src.slice(0, tpl.index).split('\n').length - 1
  const lines = tplCode.split('\n')
  const hits = []

  lines.forEach((line, i) => {
    const no = i + 1 + tplOffset
    for (const m of line.matchAll(/<([A-Z][\w]*)/g)) {
      const name = m[1]
      if (VUE_BUILTIN.has(name) || declared.has(name)) continue
      hits.push({ no, kind: '组件', name, text: line.trim().slice(0, 80) })
    }
    for (const m of line.matchAll(/@[\w.:-]+\s*=\s*"([^"]*)"/g)) {
      const expr = m[1]
      for (const fm of expr.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = fm[1]
        if (declared.has(name)) continue
        // 常见误报：vue-router / window / event 上的方法，等同于「未声明但全局可用」
        if (ROUTER_METHODS.has(name) || DOM_METHODS.has(name)) continue
        // v-for 里的 item/index 等常用变量名，跳过
        if (/^(item|index|row|a|e|el|err|error)$/.test(name)) continue
        hits.push({ no, kind: '事件', name, text: `@..="${expr}"`.slice(0, 80) })
      }
      const bare = expr.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(bare) && !declared.has(bare)) {
        hits.push({ no, kind: '事件', name: bare, text: `@..="${bare}"` })
      }
    }
  })

  if (hits.length) {
    total += hits.length
    console.log(`\n📄 ${f}`)
    for (const h of hits) console.log(`   L${h.no} [${h.kind}] ${h.name}   ${h.text}`)
  }
}
console.log(`\n合计可疑: ${total}`)
process.exit(total > 0 ? 1 : 0)
