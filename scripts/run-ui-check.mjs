// 一条命令跑完 ④ 真机断言：自己准备隔离环境、自己起服务、跑完自己收尾。
//
// 为什么需要它：`npm run verify` 一直**不包含 ④** —— README 里得补一句
// 「④ 需要先起服务，所以单独跑」。也就是说「本地一条命令复现 CI」这句话
// 对不上 CI 实际跑的东西。而 ④ 恰恰是 M5/M6/M7/M8 的 UI 行为在 CI 里的**唯一**保护，
// 本地忘了跑它，等于这几块在提交前没有任何 UI 层回归。
//
// 三个刻意的设计（都踩过或见过对应的坑）：
// 1. **独立库 + 独立端口 + 独立上传目录**：沿用 e2e 的做法（data/e2e.db / 3300）。
//    绝不能让「跑一次验证」顺手清掉开发库 —— CI 上 `seed --force` 无所谓（干净检出），
//    本机上是真会疼的。
// 2. **谁拉起的服务谁收尾**：本来就在跑的服务（比如你自己 `npm start` 的那个）
//    就复用、绝不 kill —— 否则「跑个验证」会把用户的开发服务杀掉。
// 3. **失败也要收尾，且退出码原样透传**：用 try/catch 显式 cleanup 再抛，
//    不写 `finally`（有教训：写在 finally 里会让报错/输出被吞，见 cdp-browser-check skill）。
//
// 用法：node scripts/run-ui-check.mjs
//   UI_CHECK_PORT=3400 可换端口；DB_PATH / UPLOAD_DIR 固定指向 data/ 下的隔离文件
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.UI_CHECK_PORT || 3400)
const BASE = `http://127.0.0.1:${PORT}`
const DB = path.join(ROOT, 'data', 'ui-check.db')
const UPLOAD = path.join(ROOT, 'data', 'uploads-ui-check')
const CHILD_ENV = { ...process.env, DB_PATH: DB, UPLOAD_DIR: UPLOAD, DEEPSEEK_API_KEY: '' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 注意：用 node 原生 fetch 探活，不走 curl —— 沙箱里有透明代理，curl 打 127.0.0.1
// 会被代理掉（要 --noproxy），而 undici 默认不读 HTTP_PROXY。
async function healthy() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) })
    return r.ok
  } catch {
    return false
  }
}

function runInherit(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env })
    p.on('exit', (c) => resolve(c ?? 1))
    p.on('error', reject)
  })
}

async function main() {
  fs.mkdirSync(path.dirname(DB), { recursive: true })
  fs.mkdirSync(UPLOAD, { recursive: true })

  console.log(`[ui-check] 隔离环境：库 data/ui-check.db · 上传 data/uploads-ui-check · 端口 ${PORT}`)
  const seedCode = await runInherit(['seed.js', '--force'], CHILD_ENV)
  if (seedCode !== 0) throw new Error(`种子数据写入失败（退出码 ${seedCode}）`)

  let server = null
  if (await healthy()) {
    console.log(`[ui-check] ${BASE} 已有服务在跑 → 复用（本脚本不负责收尾它）`)
  } else {
    server = spawn(process.execPath, ['index.js'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...CHILD_ENV, PORT: String(PORT) },
    })
    const t0 = Date.now()
    while (Date.now() - t0 < 40_000) {
      if (await healthy()) break
      if (server.exitCode !== null) throw new Error(`服务进程提前退出（退出码 ${server.exitCode}）`)
      await sleep(300)
    }
    if (!(await healthy())) throw new Error(`服务 40 秒内没就绪：${BASE}/health`)
    console.log('[ui-check] 服务已就绪')
  }

  const cleanup = () => {
    if (server && server.exitCode === null) {
      console.log('[ui-check] 收尾：停掉本脚本拉起的服务')
      server.kill()
    }
  }

  let code = 1
  try {
    // 透传当前环境（含沙箱/CI 变量），但 base 用参数传，避免子脚本读错端口
    code = await runInherit(['scripts/oa-ui-check.mjs', BASE], process.env)
  } catch (e) {
    cleanup()
    throw e
  }
  cleanup()

  console.log(code === 0 ? '[ui-check] ④ 真机断言通过' : `[ui-check] ④ 真机断言未通过（退出码 ${code}）`)
  process.exit(code)
}

main().catch((e) => {
  console.error('[ui-check] 失败：' + e.message)
  process.exit(1)
})
