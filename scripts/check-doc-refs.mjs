// 扫文档 / CI 里引用的「仓库内文件路径」，核对磁盘上是否真的存在。
//
// 为什么值得单独扫一遍（2026-09-19 实测）：
//   资源被重命名过一次，文档里的引用没跟着改 —— 而且**渲染出来毫无异样**
//   （Markdown 表格里它只是行内代码，不是链接）。实测 README 截图表指向
//   `docs/screenshots/10-移动端390.png`，而磁盘上只有 `15-移动端390.png`，
//   那一行已经挂了很久，没人发现。
//   同一张表还漏了 4 张图（磁盘上有、文档里一张都没提）—— 反向差集也顺手报。
//
// 与「规模数字」是同一族问题（文档抄了一份磁盘事实 → 一定会腐烂），
// 但**路径比数字好判**：存在就是存在。所以它可以当门禁，数字不行
// （数字散在散文里、大量是历史值，误报会多到没人看）。
//
// 已知取舍：宁可漏报，不要误报 —— 误报会让人养成「扫描器喊狼来了就 ignore」
// 的习惯（同 check-vue-refvalue.mjs 的注释）。所以只认「以仓库顶层源码目录开头 +
// 带扩展名」的引用，形如 `web/dist`、`evidence/` 这类无扩展名/运行时目录一律不认。
//
// 反例怎么办：文档里**故意**提到一个坏路径（比如「以前写成 xxx，已修」）是合理内容，
// 但会被误判成真引用。这类行加上标记即可（任意注释形式都行）：
//   <!-- refcheck-ignore -->   /   # refcheck-ignore
//
// 用法：node scripts/check-doc-refs.mjs
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()

// 只扫这几个顶层目录下的源码/文档引用。刻意不含 data/（运行时数据，随时可能不在）。
const SOURCE_DIRS = ['docs', 'web', 'server', 'tests', 'e2e', 'scripts', '.github']

// 跨仓引用：这份文档在讲另一个仓库的文件。写清楚理由，别用「先加白名单再说」。
const EXTERNAL = {
  'tests/runnerQuery.test.js': 'api-test-platform（测试平台）侧的文件，README 在讲平台能力时引用',
}

const SCAN = [
  'README.md',
  '.github/workflows/ci.yml',
  ...fs
    .readdirSync('docs')
    .filter((f) => f.endsWith('.md'))
    .map((f) => 'docs/' + f),
]

const dirAlt = SOURCE_DIRS.map((d) => d.replace('.', '\\.')).join('|')
const re = new RegExp(
  `(?:^|[\\s\`("'\\[>])((?:${dirAlt})/[A-Za-z0-9_\\-./\\u4e00-\\u9fa5]*\\.[A-Za-z0-9]{1,6})`,
  'g',
)

const refs = new Map() // path -> [出现在哪些文件]
for (const f of SCAN) {
  if (!fs.existsSync(f)) {
    console.log(`!! 待扫文件本身不存在，跳过: ${f}`)
    continue
  }
  // 逐行扫：带 refcheck-ignore 标记的行整行跳过（那是在拿坏路径当反例）
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (line.includes('refcheck-ignore')) continue
    for (const m of line.matchAll(re)) {
      const p = m[1]
      if (!refs.has(p)) refs.set(p, [])
      if (!refs.get(p).includes(f)) refs.get(p).push(f)
    }
  }
}

const missing = []
for (const [p, where] of [...refs].sort()) {
  if (EXTERNAL[p]) continue
  if (!fs.existsSync(path.join(ROOT, p))) missing.push([p, where])
}

console.log(`扫了 ${SCAN.length} 个文档，引用到 ${refs.size} 个不同的仓库内路径`)
for (const [p, why] of Object.entries(EXTERNAL)) console.log(`  （跳过跨仓引用）${p} —— ${why}`)

if (!missing.length) {
  console.log('✅ 引用全部有效：没有一个指向不存在的文件')
  process.exit(0)
}

console.log('')
for (const [p, where] of missing) console.log(`❌ 指向不存在的文件: ${p}\n     出现在: ${where.join(', ')}`)
console.log(`\n共 ${missing.length} 处失效引用。`)
console.log('修法二选一：① 引用改成真实路径；② 若是跨仓引用，在上面 EXTERNAL 里写明理由。')
process.exit(1)
