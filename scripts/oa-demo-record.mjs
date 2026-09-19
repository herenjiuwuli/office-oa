// ============================================================================
// 演示录屏：把一条完整业务链路（登录 → 建单 → 两级审批 → 归档 → 通知 → 导出 →
// 批量审批）录成一段 webm，给「别人第一眼」用。
//
// 零依赖：
//   · 抓帧用 CDP Page.startScreencast（系统已装的 Chrome，不下载 Chromium）
//   · 编码用浏览器自带的 MediaRecorder（canvas.captureStream + VP8）
//     —— 本机没有 ffmpeg，也不需要它
//
// 用法（服务需先跑起来）：
//   npm start                            # 另开一个终端
//   node scripts/oa-demo-record.mjs      # 默认 http://127.0.0.1:3200
//   → 产物 docs/demo/oa-demo.webm
//
// ⚠️ 与 oa-ui-check.mjs 一样会**真实写库**（新增 1 张单据 + 2 条审批记录）。
//    本脚本不做断言，它只负责把画面录下来；但关键步骤等不到元素时会立刻报错，
//    避免录出一段「页面根本没加载」的废视频。
// ============================================================================

import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const BASE = (process.argv[2] || 'http://127.0.0.1:3200').replace(/\/$/, '')
const PORT = Number(process.env.DEMO_CDP_PORT || 9335)
const FPS_CAP = 15 // 抓帧上限：screencast 原始约 50fps，不限制会攒出几千帧
const MAX_FRAME_MS = 700 // 单帧最长停留（把「等接口」的快进掉，不然视频全是干等）
const OUT_DIR = path.join(process.cwd(), 'docs', 'demo')
const OUT_FILE = path.join(OUT_DIR, 'oa-demo.webm')

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p
  throw new Error('没找到 Chrome，试过：\n' + CHROME_CANDIDATES.join('\n'))
}

async function waitJson(url, timeout = 25000) {
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url)
      if (r.ok) return await r.json()
      last = 'HTTP ' + r.status
    } catch (e) {
      last = e.message
    }
    await sleep(300)
  }
  throw new Error('等待超时 ' + url + ' :: ' + last)
}

// 页面里用的小工具（与 oa-ui-check.mjs 同源，只留录屏需要的）
const HELPERS = `
window.__t = {
  vis(e) {
    if (!e) return false;
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  },
  click(t) {
    const els = [...document.querySelectorAll('button, a, [role=button]')].filter(e => window.__t.vis(e));
    const exact = els.find(e => e.textContent.trim() === t);
    if (exact) { exact.click(); return 'CLICKED'; }
    const loose = els.find(e => e.textContent.includes(t));
    if (loose) { loose.click(); return 'CLICKED_LOOSE'; }
    return 'NOT_FOUND';
  },
  set(sel, val) {
    const el = document.querySelector(sel);
    if (!el) return 'NOT_FOUND';
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'OK';
  },
  clickInRow(rowText, btnText) {
    const rows = [...document.querySelectorAll('tr')].filter(e => window.__t.vis(e));
    const row = rows.find(r => r.textContent.includes(rowText));
    if (!row) return 'ROW_NOT_FOUND';
    const btn = [...row.querySelectorAll('button')].find(b => b.textContent.trim().includes(btnText));
    if (!btn) return 'BTN_NOT_FOUND';
    btn.click();
    return 'CLICKED';
  },
  text() { return document.body.innerText; },
  navItems() { return [...document.querySelectorAll('.nav-item')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()); },
};
// screencast 只在**画面变化**时发帧。静止阅读的时间会整段消失，
// 时间轴被压扁 → 视频快到看不清。贴一个 2x2 的隐形心跳，让画面持续有微小变化。
(() => {
  if (window.__hb) return 'hb-exists';
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;z-index:2147483647;pointer-events:none;opacity:.03';
  document.body.appendChild(d);
  let k = 0;
  window.__hb = setInterval(() => { k++; d.style.background = (k % 2) ? '#000' : '#fff'; }, 55);
  return 'hb-on';
})();
'helpers-ready'
`

// 录屏时贴在左下角的步骤字幕。整页导航会销毁它，所以每次导航后重新贴。
function captionScript(text) {
  return `(() => {
    let el = document.getElementById('__cap');
    if (!el) {
      el = document.createElement('div');
      el.id = '__cap';
      el.style.cssText = 'position:fixed;left:18px;bottom:18px;z-index:2147483647;'
        + 'background:rgba(15,23,42,.85);color:#fff;padding:9px 15px;border-radius:9px;'
        + 'font:600 15px/1.4 "Segoe UI",system-ui,sans-serif;letter-spacing:.2px;'
        + 'box-shadow:0 6px 20px rgba(0,0,0,.28);pointer-events:none;max-width:70vw';
      document.body.appendChild(el);
    }
    el.textContent = ${JSON.stringify(text)};
    return 'ok';
  })()`
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method && this.handlers.has(m.method)) {
        try { this.handlers.get(m.method)(m.params) } catch {}
      }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error('CDP error: ' + JSON.stringify(m.error)))
        else resolve(m.result)
      }
    })
  }
  on(method, fn) { this.handlers.set(method, fn) }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result.value
  }
  /** 导航 + 注入 helpers + 等业务就绪 + 重新贴字幕 */
  async go(url, readyExpr = 'document.body && document.body.innerText.length > 60', caption = null, timeout = 20000) {
    await this.send('Page.navigate', { url })
    const t0 = Date.now()
    while (Date.now() - t0 < 5000) {
      try { if (await this.eval('!!document.body')) break } catch {}
      await sleep(150)
    }
    await this.eval(HELPERS)
    if (caption) await this.eval(captionScript(caption))
    await this.waitFor(readyExpr, '页面就绪 ' + url, timeout)
    return true
  }
  async waitFor(expr, label, timeout = 12000) {
    const t0 = Date.now()
    let last = ''
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.eval(expr)) return true
      } catch (e) { last = e.message }
      await sleep(200)
    }
    throw new Error(`等待超时（${label}）：${expr}${last ? ' :: ' + last : ''}`)
  }
}

async function connect(port) {
  const tgt = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json())
  const ws = new WebSocket(tgt.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const cdp = new CDP(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  return { cdp, ws }
}

// ----------------------------------------------------------------------------
// 业务链路（演示版：节奏平滑、每步留出看清画面的时间）
// ----------------------------------------------------------------------------

async function loginAs(cdp, username, caption = '① 用演示账号登录（点击快捷填充）') {
  await cdp.go(`${BASE}/login`, `!!document.querySelector('[data-t=username]')`, caption)
  const filled = await cdp.eval(`window.__t.click(${JSON.stringify(username)})`)
  if (filled === 'NOT_FOUND') throw new Error('登录页找不到演示账号：' + username)
  await sleep(700)
  await cdp.eval(`window.__t.click('登')`)
  await cdp.waitFor(`location.pathname === '/' && !!document.querySelector('.sidebar')`, `登录为 ${username}`)
}

async function logout(cdp) {
  const r = await cdp.eval(`window.__t.click('退出登录')`)
  if (r === 'NOT_FOUND') throw new Error('侧边栏找不到「退出登录」')
  await cdp.waitFor(`location.pathname === '/login'`, '退出登录')
}

async function runDemo(cdp) {
  // ① 登录
  await loginAs(cdp, 'ops02', '① 申请人 赵西 登录 · 演示账号一键填充')
  await sleep(1200)

  // ② 我的单据列表
  await cdp.go(
    `${BASE}/requests`,
    `document.querySelectorAll('table.tbl tbody tr').length > 0 || window.__t.text().includes('还没有')`,
    '② 我的单据列表 · 可见范围按角色收敛',
  )
  await sleep(1500)

  // ③ 新建请假单
  const title = `演示单 ${new Date().toISOString().slice(0, 10)}`
  await cdp.go(`${BASE}/requests/new`, `!!document.querySelector('[data-t=title]')`, '③ 新建请假单 · 填写表单')
  await cdp.eval(`window.__t.click('请假申请')`)
  await sleep(400)
  await cdp.eval(`window.__t.set('[data-t=title]', ${JSON.stringify(title)})`)
  await cdp.eval(`window.__t.set('[data-field=startDate]', '2026-10-08')`)
  await cdp.eval(`window.__t.set('[data-field=endDate]', '2026-10-09')`)
  await sleep(500)
  await cdp.eval(`window.__t.set('[data-field=reason]', '家中有事，需要请假两天，工作已安排交接。')`)
  await sleep(900)

  await cdp.eval(captionScript('④ 保存并提交 · 流程快照在这一刻固化'))
  await cdp.eval(`window.__t.click('保存并提交')`)
  await cdp.waitFor(`/^\\/requests\\/\\d+$/.test(location.pathname)`, '跳转到详情页')
  const reqId = (await cdp.eval('location.pathname')).split('/').pop()
  await cdp.waitFor(`!!document.querySelector('.kv')`, '详情数据加载完成')
  await cdp.eval(captionScript(`⑤ 已提交 · 单据 #${reqId} 状态「审批中」`))
  await sleep(2000)

  // ⑥ 一级审批：直属上级
  await logout(cdp)
  await loginAs(cdp, 'ops01', '⑥ 切换审批人 · 王东（直属上级）')
  await cdp.go(
    `${BASE}/todo`,
    `document.querySelectorAll('table.tbl tbody tr').length > 0 || window.__t.text().includes('没有待你审批')`,
    '⑥ 待办里出现这张单',
  )
  await sleep(1400)
  await cdp.eval(captionScript('⑦ 打开处理抽屉 · 填写意见 → 同意'))
  const opened = await cdp.eval(`window.__t.clickInRow('#${reqId}', '处理')`)
  if (opened !== 'CLICKED') throw new Error('待办里点不到「处理」：' + opened)
  await cdp.waitFor(`!!document.querySelector('.drawer')`, '审批抽屉出现')
  await sleep(900)
  await cdp.eval(`window.__t.set('[data-t=comment]', '同意，注意工作交接')`)
  await sleep(900)
  await cdp.eval(`window.__t.click('同意')`)
  await cdp.waitFor(`!document.querySelector('.drawer')`, '抽屉关闭')
  await sleep(700)

  // ⑧ 二级审批：人事复核 → 归档
  await logout(cdp)
  await loginAs(cdp, 'hr01', '⑧ 二级审批 · 李南（人事复核）')
  await cdp.go(
    `${BASE}/todo`,
    `document.querySelectorAll('table.tbl tbody tr').length > 0 || window.__t.text().includes('没有待你审批')`,
    '⑧ 人事待办 · 同一张单推进到第 2 步',
  )
  await sleep(1200)
  if ((await cdp.eval(`window.__t.clickInRow('#${reqId}', '处理')`)) !== 'CLICKED') {
    throw new Error('人事待办里点不到「处理」')
  }
  await cdp.waitFor(`!!document.querySelector('.drawer')`, '审批抽屉出现')
  await sleep(800)
  await cdp.eval(`window.__t.set('[data-t=comment]', '已核对，批准')`)
  await sleep(800)
  await cdp.eval(`window.__t.click('同意')`)
  await cdp.waitFor(`!document.querySelector('.drawer')`, '抽屉关闭')

  await cdp.go(`${BASE}/requests/${reqId}`, `!!document.querySelector('.kv')`, `⑨ 两级通过 → 归档「已通过」· 时间线留下每一轮意见`)
  await sleep(2200)

  // ⑩ 站内通知
  await logout(cdp)
  await loginAs(cdp, 'ops02', '⑩ 切回申请人 赵西')
  await cdp.go(
    `${BASE}/notifications`,
    `document.querySelectorAll('table.tbl tbody tr').length > 0 || window.__t.text().includes('没有')`,
    '⑩ 消息中心 · 提交/通过与归档每步都有通知',
  )
  await sleep(1800)

  // ⑪ 导出 CSV
  await cdp.go(
    `${BASE}/requests`,
    `document.querySelectorAll('table.tbl tbody tr').length > 0 || window.__t.text().includes('还没有')`,
    '⑪ 导出 CSV · 条数与列表同源（可见性共用同一段代码）',
  )
  await sleep(1000)
  await cdp.eval(`window.__t.click('导出 CSV')`)
  await cdp.waitFor(`window.__t.text().includes('已导出')`, '导出完成提示')
  await sleep(1600)

  // ⑫ 统计与考勤
  await cdp.go(
    `${BASE}/stats`,
    `document.body.innerText.length > 200`,
    '⑫ 统计报表 · 数字按角色收敛（scope）',
    25000,
  )
  await sleep(1800)
  await cdp.go(
    `${BASE}/attendance`,
    `!!document.querySelector('[data-t="att-clock-in"]')`,
    '⑬ 考勤打卡 · 缺卡分母只算「已经过去」的工作日',
    25000,
  )
  await sleep(1600)

  // ⑭ 批量审批（M8）：先攒出几张待批单
  const stamp = Date.now().toString().slice(-6)
  const batchIds = []
  for (const n of [1, 2, 3]) {
    await cdp.go(
      `${BASE}/requests/new`,
      `!!document.querySelector('[data-t=title]')`,
      n === 1 ? '⑭ 再提交三张单 · 给批量审批备好待办' : null,
    )
    await cdp.eval(`window.__t.click('请假申请')`)
    await sleep(300)
    await cdp.eval(`window.__t.set('[data-t=title]', ${JSON.stringify(`批量演示单 ${stamp}-${n}`)})`)
    await cdp.eval(`window.__t.set('[data-field=startDate]', '2026-10-12')`)
    await cdp.eval(`window.__t.set('[data-field=endDate]', '2026-10-13')`)
    await sleep(300)
    await cdp.eval(`window.__t.set('[data-field=reason]', '批量审批演示用，工作已安排交接。')`)
    await sleep(500)
    await cdp.eval(`window.__t.click('保存并提交')`)
    await cdp.waitFor(`/^\\/requests\\/\\d+$/.test(location.pathname)`, '提交后跳详情')
    batchIds.push((await cdp.eval('location.pathname')).split('/').pop())
    await sleep(600)
  }

  // ⑮ 审批人登录 → 待办多选
  await logout(cdp)
  await loginAs(cdp, 'ops01', '⑮ 审批人 王东 · 待办里现在有好几张')
  await cdp.go(
    `${BASE}/todo`,
    `document.querySelectorAll('table.tbl tbody input[type=checkbox]').length >= 3`,
    '⑮ 待办列表支持多选 · 一次处理一批',
  )
  await sleep(1300)
  const picked = await cdp.eval(`(() => {
    const want = ${JSON.stringify(batchIds)}
    let n = 0
    for (const r of document.querySelectorAll('table.tbl tbody tr')) {
      const a = r.querySelector('a[href^="/requests/"]')
      if (!a || !want.includes(a.getAttribute('href').split('/').pop())) continue
      const cb = r.querySelector('input[type=checkbox]')
      if (cb) { cb.click(); n++ }
    }
    return n
  })()`)
  if (picked !== 3) throw new Error(`只勾中 ${picked} 张，期望 3 张`)
  await cdp.waitFor(`!!document.querySelector('.batch-bar')`, '批量操作栏出现')
  await sleep(900)

  // 制造「部分成功」：其中一张已被别处先批掉（等价于另一个审批人抢先处理）
  const pre = await cdp.eval(`fetch('/api/requests/${batchIds[0]}/approve', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + localStorage.getItem('oa.token'), 'content-type': 'application/json' },
    body: JSON.stringify({ comment: '抢先处理' }),
  }).then(r => r.status)`)
  if (pre !== 200) throw new Error(`构造数据陈旧失败：HTTP ${pre}`)

  await cdp.eval(captionScript('⑯ 批量同意 · 逐条结果各带原因（一张已被别处处理 → 部分成功 207）'))
  await sleep(700)
  await cdp.eval(`window.__t.set('[data-t=batch-comment]', '批量同意，已核对')`)
  await sleep(800)
  await cdp.eval(`document.querySelector('[data-t=batch-approve]').click()`)
  await cdp.waitFor(`!!document.querySelector('.batch-result')`, '批量结果面板出现')
  await sleep(2600)

  return reqId
}

// ----------------------------------------------------------------------------
// 编码：把抓到的 JPEG 帧交给浏览器自己的 MediaRecorder 编成 webm
// ----------------------------------------------------------------------------

async function encode(cdp, frames) {
  const parts = frames.map((f, i) => {
    if (i >= frames.length - 1) return { d: f.data, ms: 300 }
    const raw = (frames[i + 1].ts - frames[i].ts) * 1000
    return { d: f.data, ms: Math.max(40, Math.min(MAX_FRAME_MS, Math.round(raw))) }
  })

  await cdp.eval('window.__f = []')
  const CHUNK = 20
  for (let i = 0; i < parts.length; i += CHUNK) {
    await cdp.eval(`window.__f.push(...${JSON.stringify(parts.slice(i, i + CHUNK))})`)
  }

  const info = await cdp.eval(`(async () => {
    const fs2 = window.__f
    const imgs = []
    for (const f of fs2) {
      const img = new Image()
      img.src = 'data:image/jpeg;base64,' + f.d
      try { await img.decode() } catch {}
      imgs.push(img)
    }
    const W = imgs[0].naturalWidth || 1280
    const H = imgs[0].naturalHeight || 800
    const c = document.createElement('canvas')
    c.width = W; c.height = H
    document.body.appendChild(c)
    const ctx = c.getContext('2d')
    const stream = c.captureStream(0)
    const track = stream.getVideoTracks()[0]
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 2500000 })
    const chunks = []
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
    const stopped = new Promise((res) => { rec.onstop = res })
    rec.start()
    let total = 0
    for (let i = 0; i < imgs.length; i++) {
      ctx.drawImage(imgs[i], 0, 0, W, H)
      track.requestFrame()
      await new Promise((res) => setTimeout(res, fs2[i].ms))
      total += fs2[i].ms
    }
    await new Promise((res) => setTimeout(res, 150))
    rec.stop(); await stopped
    const blob = new Blob(chunks, { type: 'video/webm' })
    const u8 = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    const STEP = 8192
    for (let i = 0; i < u8.length; i += STEP) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + STEP))
    }
    window.__out = btoa(bin)
    return { size: u8.length, secs: +(total / 1000).toFixed(1), w: W, h: H }
  })()`)

  const totalLen = await cdp.eval('window.__out.length')
  const STEP = 2 * 1024 * 1024
  let b64 = ''
  for (let i = 0; i < totalLen; i += STEP) {
    b64 += await cdp.eval(`window.__out.slice(${i}, ${i + STEP})`)
  }
  return { info, buf: Buffer.from(b64, 'base64') }
}

// ----------------------------------------------------------------------------

let child = null
let wsPage = null
let wsEnc = null
let userDataDir = null

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })

  // 录屏会把画面原样录下来 —— 库里残留的测试单据（"UI 验收单"、CSV 公式注入样本）
  // 会一起进视频，看着不像产品、像测试现场。只读探测一下，有就提示，不擅自改数据。
  const dbFile = path.join(process.cwd(), 'data', 'app.db')
  if (fs.existsSync(dbFile)) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const probe = new DatabaseSync(dbFile, { readOnly: true })
      const n = probe.prepare(
        `SELECT COUNT(*) AS c FROM requests WHERE title LIKE 'UI %' OR title LIKE '%=%' OR title LIKE '%验收单%'`,
      ).get().c
      probe.close()
      if (n > 0) {
        console.log(`⚠️  库里检测到 ${n} 条测试遗留单据（UI 验收单 / 公式注入样本），画面会显得脏。`)
        console.log('   想要干净的演示画面，先跑一次： node seed.js --force')
      }
    } catch {
      // 探测失败不影响录制（例如库结构变了），静默跳过
    }
  }

  userDataDir = path.join(os.tmpdir(), 'oa-demo-' + Date.now())
  child = spawn(findChrome(), [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // 后台标签会被节流：不关掉的话编码阶段的重放会忽快忽慢
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1280,800',
    'about:blank',
  ], { stdio: 'ignore', detached: false })

  const ver = await waitJson(`http://127.0.0.1:${PORT}/json/version`)
  console.log('Chrome:', ver.Browser)

  const page = await connect(PORT)
  wsPage = page.ws
  const cdp = page.cdp

  // 固定视口，否则录出来的尺寸会随窗口抖动
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  })

  const frames = []
  let lastKept = -1
  let ackFail = 0
  cdp.on('Page.screencastFrame', (p) => {
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => { ackFail++ })
    const ts = p.metadata.timestamp
    if (ts - lastKept < 1 / FPS_CAP) return // 降采样：screencast 原始帧率远高于 FPS_CAP
    lastKept = ts
    frames.push({ data: p.data, ts })
  })

  // 先让登录页渲染好再开录，视频第一帧就是画面而不是白屏
  await cdp.go(`${BASE}/login`, `!!document.querySelector('[data-t=username]')`)

  console.log('开始录制…')
  const t0 = Date.now()
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 62, maxWidth: 1280, maxHeight: 800 })
  // startScreencast 的头一帧常是合成器重绘中的空白（实测录出来就是白屏开头），直接丢掉；
  // 顺带给心跳留出启动时间，保证后面时间轴是连续的。
  await sleep(450)
  frames.length = 0
  const reqId = await runDemo(cdp)
  await cdp.send('Page.stopScreencast')
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  console.log(`录制结束：${frames.length} 帧 / ${secs}s（ack 失败 ${ackFail}）`)
  if (!frames.length) throw new Error('一帧都没抓到，screencast 可能没生效')

  // 想看「视频里到底录到了什么」，把采样帧落成 jpg（默认不产出，免得仓库里多一堆图）
  if (process.env.DEMO_STILLS) {
    const stillDir = path.join(OUT_DIR, 'frames')
    fs.mkdirSync(stillDir, { recursive: true })
    const step = Math.max(1, Math.floor(frames.length / 24))
    frames.filter((_, i) => i % step === 0).forEach((f, i) => {
      fs.writeFileSync(path.join(stillDir, String(i).padStart(2, '0') + '.jpg'), Buffer.from(f.data, 'base64'))
    })
    console.log('抽帧:', stillDir)
  }

  console.log('开始编码（用浏览器自己的 MediaRecorder，本机无需 ffmpeg）…')
  const enc = await connect(PORT)
  wsEnc = enc.ws
  const { info, buf } = await encode(enc.cdp, frames)
  wsEnc.close()
  wsEnc = null

  fs.writeFileSync(OUT_FILE, buf)
  const hex = buf.subarray(0, 4).toString('hex')

  console.log('')
  console.log('产物 :', OUT_FILE)
  console.log('规格 :', `${info.w}x${info.h} · ${info.secs}s · ${(buf.length / 1024 / 1024).toFixed(2)} MB`)
  console.log('校验 :', hex, hex === '1a45dfa3' ? '✅ 合法 webm（EBML）' : '❌ 文件头异常')
  console.log('单据 : #' + reqId + '（已真实写入库）')
  return OUT_FILE
}

main()
  .catch((e) => {
    console.error('\n录屏失败:', e.message)
    process.exitCode = 2
  })
  .finally(async () => {
    try { if (wsPage) wsPage.close() } catch {}
    try { if (wsEnc) wsEnc.close() } catch {}
    try { if (child) child.kill() } catch {}
    await sleep(600)
    try { if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  })
