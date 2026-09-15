// 扫 src/ 下所有 .vue：报告 script 里「用 .value 但未声明」的 ref 漏声明
// 已知唯一误报：DOM 事件对象属性 `e.target.value`
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
