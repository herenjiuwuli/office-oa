// ============================================================================
// 把 E2E 专用库重置成种子态（Playwright 跑之前调用，见 package.json 的 test:e2e）
//
// 为什么不直接 `DB_PATH=... node seed.js --force`：
//   npm scripts 在 Windows 上走 cmd.exe，`VAR=x cmd` 这种前置赋值语法不通用。
//   所以这里用 Node 设好环境变量，再复用 seed.js 导出的 seed()——不重造轮子，逻辑只有一份。
// ============================================================================
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = fileURLToPath(new URL('../data/e2e.db', import.meta.url))

const { seed } = await import('../seed.js')
const { getDb, closeDb, dbPath } = await import('../server/db.js')

const summary = seed(getDb(), { force: true })
console.log('[e2e] E2E 库已重置 →', dbPath())
console.log('[e2e] 种子数据：', summary)
closeDb()
