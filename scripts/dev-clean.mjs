// scripts/dev-clean.mjs
// 通用开发栈启动器（零依赖，仅 Node 内置模块）
//
// 作用：
//   1) 启动前清掉各服务端口上的残留进程（解决“上次的旧后端/孤儿 vite 占着端口 → 新进程起不来/端口漂移”）
//   2) 同时拉起多个服务（前端 + 后端）
//   3) watch 服务异常退出后自动重启（后端被环境信号带走也能自愈）
//   4) Ctrl+C 正确把信号转发给所有子进程
//
// 用法：在 package.json 里 "dev": "node scripts/dev-clean.mjs"
// 按项目只改下面的 SERVICES 配置即可。
//
// 服务字段：
//   name : 名称（仅日志）
//   cmd  : 可执行文件，如 'node' / 'npm'
//   args : 参数数组，如 ['index.js'] / ['--prefix','web','run','dev']
//   cwd  : 相对项目根目录的工作目录，默认 '.'
//   port : 该服务监听的端口（用于启动前清残留）；不监听填 null
//   watch: true 表示异常退出自动重启（通常给后端）
//   env  : 额外环境变量（可选）

const SERVICES = [
  { name: 'be', cmd: 'node', args: ['--watch', 'index.js'], port: 3200, watch: true },
  { name: 'fe', cmd: 'npm',  args: ['--prefix', 'web', 'run', 'dev'], port: 5273, watch: false },
]

import { spawn, execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const shuttingDown = { value: false }
const children = new Map()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pidsOnPort(port) {
  try {
    const out = execSync("netstat -ano -p TCP", { encoding: "utf8" })
    const set = new Set()
    for (const line of out.split("\n")) {
      const cols = line.trim().split(/\s+/)
      // 列: Proto  LocalAddress  ForeignAddress  State  PID
      if (cols.length >= 5 && cols[3] === "LISTENING") {
        const local = cols[1] // 例如 [::1]:5181 / 0.0.0.0:3001 / 127.0.0.1:3001
        if (local === `[::]:${port}` || local === `0.0.0.0:${port}` || local === `127.0.0.1:${port}` || local.endsWith(`:${port}`)) {
          const pid = parseInt(cols[4], 10)
          if (!Number.isNaN(pid)) set.add(pid)
        }
      }
    }
    return [...set]
  } catch {
    return []
  }
}

function killPid(pid) {
  try {
    if (isWin) execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' })
    else execSync(`kill -9 ${pid}`, { stdio: 'ignore' })
  } catch {}
}

async function clearPort(port) {
  if (port == null) return
  const pids = pidsOnPort(port)
  if (pids.length) {
    console.log(`[dev-clean] 端口 ${port} 被 PID ${pids.join(', ')} 占用，清理残留进程…`)
    pids.forEach(killPid)
    for (let i = 0; i < 40; i++) {
      await sleep(200)
      if (pidsOnPort(port).length === 0) {
        console.log(`[dev-clean] 端口 ${port} 已释放`)
        return
      }
    }
    console.warn(`[dev-clean] 警告：端口 ${port} 在 5s 内未释放，仍尝试启动（可能端口冲突）`)
  }
}

function runService(s) {
  const child = spawn(s.cmd, s.args, {
    cwd: path.resolve(root, s.cwd || '.'),
    env: { ...process.env, ...(s.env || {}) },
    stdio: 'inherit',
    shell: isWin,
  })
  children.set(s.name, child)
  console.log(`[dev-clean] 启动 ${s.name} (PID ${child.pid})：${s.cmd} ${s.args.join(' ')}`)
  let restarts = 0
  child.on('exit', (code, signal) => {
    if (shuttingDown.value) return
    if (s.watch) {
      restarts += 1
      if (restarts > 100) {
        console.error(`[dev-clean] ${s.name} 反复崩溃（>100 次），停止自动重启。请查看上方日志。`)
        return
      }
      console.warn(`[dev-clean] ${s.name} 退出（code=${code} signal=${signal}），准备重启…`)
      clearPort(s.port).then(() => sleep(400)).then(() => runService(s))
    } else {
      console.log(`[dev-clean] ${s.name} 退出（code=${code} signal=${signal}）`)
    }
  })
  return child
}

async function main() {
  if (!SERVICES.length) {
    console.error('[dev-clean] SERVICES 为空，请在 scripts/dev-clean.mjs 顶部配置服务。')
    process.exit(1)
  }
  for (const s of SERVICES) await clearPort(s.port)
  for (const s of SERVICES) runService(s)

  const stop = () => {
    if (shuttingDown.value) return
    shuttingDown.value = true
    console.log('\n[dev-clean] 收到退出信号，关闭所有子进程…')
    for (const [, child] of children) {
      try {
        if (isWin) execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' })
        else child.kill('SIGKILL')
      } catch {}
    }
    setTimeout(() => process.exit(0), 1500)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)
}

main()
