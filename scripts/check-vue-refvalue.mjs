// 扫 src/ 下所有 .vue：报告 script 里「用 .value 但未声明」的 ref 漏声明
// 已知接受的取舍：函数参数 / for-of 循环变量也进 declared（如 map((opt) => opt.value)）。
// 代价：参数名恰好与顶层 ref 同名且真的漏声明时会被漏报 —— 漏报比误报好，
// 误报会让人养成「扫描器喊狼来了就 ignore」的习惯，那才是真危险。
//
// 用法：node scripts/check-vue-refvalue.mjs <views-dir>  （默认 src/views）
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] || 'src/views')
const files = readdirSync(dir).filter((f) => f.endsWith('.vue'))
let issues = 0

for (const f of files) {
  const raw = readFileSync(join(dir, f), 'utf8')
  const m = raw.match(/<script setup>([\s\S]*?)<\/script>/)
  if (!m) continue
  const code = m[1]
  const declared = new Set()

  for (const mm of code.matchAll(/^\s*(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) declared.add(mm[1])
  for (const mm of code.matchAll(/import\s*\{([^}]*)\}/g)) {
    mm[1].split(',').forEach((s) => {
      const n = s.trim().split(/\s+as\s+/).pop().trim()
      if (n) declared.add(n)
    })
  }
  for (const mm of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) declared.add(mm[1])
  for (const mm of code.matchAll(/^\s*(?:const|let)\s*\{([^}]*)\}\s*=/gm)) {
    mm[1].split(',').forEach((s) => {
      const n = s.trim().split(':').pop().trim()
      if (n) declared.add(n)
    })
  }
  // 函数参数（箭头函数 + 普通函数，含解构）与 for 循环变量：
  // `opt.value` / `({ value }) => ...` 里的是普通属性访问，不是 ref。
  // 注意箭头函数常写 `((opt) => ({...})`——返回对象字面量，所以只认 `) =>` 不认 `) => {`
  for (const mm of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    mm[1]
      .split(',')
      .map((s) => s.trim().split(':').pop().trim().replace(/^\{|\}$/g, '').trim())
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
      .forEach((n) => declared.add(n))
  }
  for (const mm of code.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) {
    mm[1]
      .split(',')
      .map((s) => s.trim().split(':')[0].trim())
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
      .forEach((n) => declared.add(n))
  }
  for (const mm of code.matchAll(/\bfor\s*\(\s*(?:const|let)\s+([A-Za-z_$][\w$]*)/g)) declared.add(mm[1])

  const used = new Set()
  for (const mm of code.matchAll(/\b([A-Za-z_$][\w$]*)\.value\b/g)) {
    // 排除 DOM 事件对象属性误报：e.target.value / ev.target.value / event.target.value
    // （正则只会捕获到 `target.value` 这一段；代价是 ref 名恰好叫 target 的会被漏报，可接受）
    if (mm[0] === 'target.value') continue
    used.add(mm[1])
  }
  const missing = [...used].filter((u) => !declared.has(u))
  if (missing.length) {
    console.log(`${f}: 未声明却用了 .value -> ${missing.join(', ')}`)
    issues++
  }
}
console.log(`--- 扫描 ${files.length} 个 .vue，发现 ${issues} 处 ---`)
process.exit(issues > 0 ? 1 : 0)
