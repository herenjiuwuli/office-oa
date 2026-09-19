// ============================================================================
// 用真机 Chrome 截几张关键页面图（作品集 / README / 复盘都用得上）。
// 零依赖：系统 Chrome + Node 内置 WebSocket 直连 CDP。
//
// 用法（服务需先跑起来）：
//   npm start
//   node scripts/oa-screenshots.mjs            # 输出到 docs/screenshots/
//   node scripts/oa-screenshots.mjs 5273       # 也可以用 vite dev 端口
// ============================================================================

import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const PORT_ARG = process.argv[2]
const BASE = `http://127.0.0.1:${PORT_ARG || 3200}`
const OUT = path.resolve('docs', 'screenshots')

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p
  throw new Error('没找到 Chrome')
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error(JSON.stringify(m.error)))
        else resolve(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  async nav(url, readyExpr = "document.body && document.body.innerText.length > 60", timeout = 20000) {
    await this.send('Page.navigate', { url })
    const t0 = Date.now()
    // 先等基础 DOM 出来，立刻注入 helpers。
    // 为什么必须在这里注入：整页导航会销毁旧 JS 上下文，上次注入的 window.__s 已经没了；
    // 而 readyExpr 里很可能用到 window.__s（比如 text().includes(...)）。
    // 之前把注入放在就绪判断之后，于是「用 __s 写就绪条件」会永远为假 → 静默超时。
    while (Date.now() - t0 < 5000) {
      try {
        if (await this.eval('!!document.body')) break
      } catch {}
      await sleep(150)
    }
    await this.eval(HELPERS)
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.eval(readyExpr)) return true
      } catch {}
      await sleep(200)
    }
    throw new Error('渲染超时: ' + url)
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT, name)
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    console.log('  ✓', name, `(${Math.round(fs.statSync(file).size / 1024)} KB)`)
  }
}

const HELPERS = `
window.__s = {
  vis(e) {
    if (!e) return false;
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  },
  click(t) {
    const els = [...document.querySelectorAll('button, a')].filter(e => window.__s.vis(e));
    const hit = els.find(e => e.textContent.trim() === t) || els.find(e => e.textContent.includes(t));
    if (!hit) return 'NOT_FOUND';
    hit.click(); return 'CLICKED';
  },
  set(sel, val) {
    const el = document.querySelector(sel);
    if (!el) return 'NOT_FOUND';
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'OK';
  },
  clickInRow(rowText, btnText) {
    const row = [...document.querySelectorAll('tr')].find(r => r.textContent.includes(rowText));
    if (!row) return 'ROW_NOT_FOUND';
    const btn = [...row.querySelectorAll('button')].find(b => b.textContent.trim().includes(btnText));
    if (!btn) return 'BTN_NOT_FOUND';
    btn.click(); return 'CLICKED';
  },
  text() { return document.body.innerText; },
};
'ok';
`

async function waitFor(cdp, expr, label, timeout = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      if (await cdp.eval(expr)) return
    } catch {}
    await sleep(200)
  }
  throw new Error('等待超时: ' + label)
}

async function loginAs(cdp, username) {
  await cdp.nav(`${BASE}/login`, `!!document.querySelector('[data-t=username]')`)
  await cdp.eval(HELPERS)
  await cdp.eval(`window.__s.click(${JSON.stringify(username)})`)
  await cdp.eval(`window.__s.click('登')`)
  await waitFor(cdp, `location.pathname === '/' && !!document.querySelector('.sidebar')`, '登录完成')
}

const CHROME = findChrome()
const PORT = 9335
const userDataDir = path.join(os.tmpdir(), 'oa-shot-' + Date.now())
const child = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let ws = null
try {
  fs.mkdirSync(OUT, { recursive: true })

  let ver
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) { ver = await r.json(); break }
    } catch {}
    await sleep(300)
  }
  if (!ver) throw new Error('Chrome 没起来')
  console.log('Chrome:', ver.Browser, '\n输出目录:', OUT, '\n')

  const tgt = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json())
  ws = new WebSocket(tgt.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const cdp = new CDP(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  // 统一视口 + 2x 缩放，截图清晰
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 940, deviceScaleFactor: 2, mobile: false,
  })

  // 1) 登录页
  await cdp.nav(`${BASE}/login`, `!!document.querySelector('.login-card')`)
  await cdp.eval(HELPERS)
  await sleep(400)
  await cdp.shot('01-登录页.png')

  // 2) 以「王东」登录（有 :2 物料单等他签）—— 总览
  await loginAs(cdp, 'ops01')
  await waitFor(cdp, `window.__s.text().includes('待我审批')`, '总览渲染')
  await sleep(400)
  await cdp.shot('02-总览-身份与权限.png')

  // 3) 我的待办
  await cdp.nav(`${BASE}/todo`, `document.querySelectorAll('table.tbl tbody tr').length > 0`)
  await cdp.eval(HELPERS)
  await sleep(300)
  await cdp.shot('03-我的待办.png')

  // 4) 打开处理抽屉（审批动作 + 并发提示）
  await cdp.eval(`window.__s.clickInRow('#2', '处理')`)
  await waitFor(cdp, `!!document.querySelector('.drawer')`, '抽屉打开')
  await sleep(400)
  await cdp.shot('04-审批抽屉.png')
  await cdp.eval(`window.__s.click('关闭')`)
  await sleep(300)

  // 5) 单据详情：会签进行中的物料单（时间线 + 流程快照 + 权限）
  await cdp.nav(`${BASE}/requests/2`, `!!document.querySelector('.kv')`)
  await cdp.eval(HELPERS)
  await sleep(400)
  await cdp.shot('05-单据详情-会签时间线.png')

  // 6) 已归档的请假单（两级审批都通过 + 无操作按钮）
  //    id 用 seed 里的那张 approved 请假单（3 号）。⚠️ 别硬编码一个「跑着跑着才存在」的 id：
  //    seed --force 重建后库里只剩种子那几条，写 9 就会白等 12 秒超时。
  await cdp.nav(`${BASE}/requests/3`, `!!document.querySelector('.kv')`)
  await cdp.eval(HELPERS)
  await sleep(400)
  await cdp.shot('06-单据详情-已归档.png')

  // 7) 部门架构
  await cdp.nav(`${BASE}/departments`, `!!document.querySelector('.tree-row')`)
  await cdp.eval(HELPERS)
  await sleep(300)
  await cdp.shot('07-部门架构.png')

  // 8) 员工管理（hr 才有权限）
  await cdp.eval(`window.__s.click('退出登录')`)
  await waitFor(cdp, `location.pathname === '/login'`, '登出')
  await loginAs(cdp, 'hr01')
  await cdp.nav(`${BASE}/users`, `document.querySelectorAll('table.tbl tbody tr').length > 0`)
  await cdp.eval(HELPERS)
  await sleep(300)
  await cdp.shot('08-员工管理-RBAC.png')

  // 9) 纵向越权现场：普通员工访问员工管理 → 后端真实 403
  await cdp.eval(`window.__s.click('退出登录')`)
  await waitFor(cdp, `location.pathname === '/login'`, '登出')
  await loginAs(cdp, 'ops02')
  await cdp.nav(`${BASE}/users`, `window.__s.text().includes('user:read')`)
  await cdp.eval(HELPERS)
  await sleep(400)
  await cdp.shot('09-越权-后端真实403.png')

  // 11) 消息中心（M3）：站内通知 + 收件人隔离
  await cdp.eval(`window.__s.click('退出登录')`)
  await waitFor(cdp, `location.pathname === '/login'`, '登出')
  await loginAs(cdp, 'admin')
  await cdp.nav(`${BASE}/notifications`, `!!document.querySelector('.card')`)
  await cdp.eval(HELPERS)
  await waitFor(
    cdp,
    `document.querySelectorAll('table.tbl tbody tr').length > 0 || !!document.querySelector('.empty')`,
    '消息中心渲染',
  )
  await sleep(400)
  await cdp.shot('11-消息中心-M3.png')

  // 12) 单据中心（M4 的导出按钮在这里）；admin 有 request:read:all，能看到全量
  // 就绪条件要**页面专属**：等「导出 CSV」按钮出现，比等「表格里有行」稳
  // （表格有行可能是上一条路由留下的旧 DOM）—— oa-ui-check.mjs 里踩过一次
  await cdp.nav(
    `${BASE}/requests`,
    `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '导出 CSV')`,
  )
  await cdp.eval(HELPERS)
  await sleep(300)
  await cdp.shot('12-单据中心-导出CSV-M4.png')

  // 13) 会议室（M5）：时间轴 + 占用格 + 我的预订
  await cdp.eval(`window.__s.click('退出登录')`)
  await waitFor(cdp, `location.pathname === '/login'`, '登出')
  await loginAs(cdp, 'ops01')
  await cdp.nav(
    `${BASE}/meetings`,
    `document.querySelectorAll('.timeline tbody tr').length > 0 || document.querySelectorAll('.tl-row').length > 0`,
  )
  await cdp.eval(HELPERS)
  // 种子的示例预订在**明天**（过去时段本来就不让订）；跳到明天，时间轴上才有东西可看。
  // ⚠️ v-model 在 date input 上监听的是 input 事件，只发 change 切不过去（实测在这卡过）
  await cdp.eval(`(() => {
    const el = document.querySelector('input[type=date]');
    const d = new Date(Date.now() + 86400000);
    el.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'OK';
  })()`)
  await waitFor(cdp, `!!document.querySelector('.tl-cell.taken')`, '时间轴出现占用格', 8000)
  await sleep(400)
  await cdp.shot('13-会议室-占用时间轴-M5.png')

  // 14) 审计日志：预订/取消这类动作必须留痕 —— 但 audit:read 只有 admin 有，
  //     上一步是 ops01，直接跳过去只会拍到一张 403（就绪条件也就永远等不到表格行）
  await cdp.eval(`window.__s.click('退出登录')`)
  await waitFor(cdp, `location.pathname === '/login'`, '登出')
  await loginAs(cdp, 'admin')
  await cdp.nav(`${BASE}/audit-logs`, `document.querySelectorAll('table.tbl tbody tr').length > 0`)
  await cdp.eval(HELPERS)
  await sleep(400)
  await cdp.shot('14-审计日志.png')

  // 13b) 统计看板（M6）：admin 能看到「我的 / 本部门 / 全公司」三个范围 tab，
  //      按 scope 聚合的卡片 + 纯 CSS 柱状图都渲染出来
  await cdp.nav(`${BASE}/stats`, `!!document.querySelector('[data-t="stats-scope-all"]')`)
  await cdp.eval(HELPERS)
  await waitFor(cdp, `document.querySelectorAll('.stat-card').length > 0`, '统计卡片渲染', 8000)
  await sleep(400)
  await cdp.shot('13b-统计看板-M6.png')

  // 13c) 考勤打卡（M7）：admin 有全部三个范围 tab；打卡区 + 数字卡 + 逐人明细表都渲染出来
  await cdp.nav(`${BASE}/attendance`, `!!document.querySelector('[data-t="att-scope-all"]')`)
  await cdp.eval(HELPERS)
  await waitFor(cdp, `!!document.querySelector('[data-t="att-summary-recorded"]')`, '考勤数字卡渲染', 8000)
  await sleep(400)
  await cdp.shot('13c-考勤打卡-M7.png')

  // 14) 移动端（真改视口）
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  })
  await cdp.nav(`${BASE}/`, `!!document.querySelector('.sidebar')`)
  await cdp.eval(HELPERS)
  await sleep(400)
  await cdp.shot('15-移动端390.png')
  await cdp.send('Emulation.clearDeviceMetricsOverride')

  console.log('\n完成。')
} catch (e) {
  console.error('截图失败:', e.message)
  process.exitCode = 1
} finally {
  try { if (ws) ws.close() } catch {}
  try { child.kill() } catch {}
  await sleep(500)
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}
