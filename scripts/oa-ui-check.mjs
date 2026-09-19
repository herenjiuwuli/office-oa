// ============================================================================
// 真机浏览器验收：把一张单据从「提交」跑到「归档」，再跑一遍「驳回 → 重提」，
// 最后验证消息中心（站内通知）的角标同步与轮次快照。
//
// 零依赖：用系统已装的 Chrome + Node 内置 WebSocket 直连 CDP（不下载 Chromium）。
// 前提：Node >= 21（全局 WebSocket）+ 已安装 Chrome。
//
// 用法（服务需先跑起来）：
//   npm start                        # 或 npm run dev
//   node scripts/oa-ui-check.mjs     # 默认 http://127.0.0.1:3200
//
// ⚠️ 这个脚本会**真实写库**（每跑一次新增 2 张单据、若干审批记录），因为它走的是真链路。
//    跑多次会让 data/app.db 越来越脏；想重置用 `node seed.js --force`。
//    单据 id 由脚本从 URL 里读出来，所以累积的数据不会让脚本失效。
//
// 为什么不用 curl 就够：curl 只能证明「HTTP 200 / HTML 有内容」，
// 证明不了「点下去真的跳转、v-model 真的绑上了、按钮真的按权限隐藏了」。
// ============================================================================

import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { getDb } from '../server/db.js'

const BASE = (process.argv[2] || 'http://127.0.0.1:3200').replace(/\/$/, '')

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

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    // 顺手把**页面自己报的错**收下来 —— 失败留证时这是最值钱的一块：
    // 「白屏 / ReferenceError」这类问题在断言层面只表现为「找不到元素」，
    // 真正的原因只出现在这里。
    this.exceptions = []
    this.consoleErrors = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params?.exceptionDetails
        const txt = d?.exception?.description || d?.text || ''
        if (txt) this.exceptions.push(String(txt).split('\n')[0].slice(0, 300))
        return
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
        const txt = (m.params.args || [])
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')
          .slice(0, 300)
        if (txt) this.consoleErrors.push(txt)
        return
      }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error('CDP error: ' + JSON.stringify(m.error)))
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
    if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result.value
  }
  /** 导航并轮询「业务就绪」（不等 load 事件：SPA 里它早于 Vue 挂载完成） */
  async nav(url, readyExpr = "document.body && document.body.innerText.length > 60", timeout = 20000) {
    await this.send('Page.navigate', { url })
    const t0 = Date.now()
    // 先等基础 DOM，立刻注入 helpers —— 整页导航会销毁旧 JS 上下文，
    // 而 readyExpr 里可能用到 window.__t。注入晚于就绪判断的话，这种写法会静默超时。
    while (Date.now() - t0 < 5000) {
      try {
        if (await this.eval('!!document.body')) break
      } catch {}
      await sleep(150)
    }
    await this.eval(HELPERS)
    await this.waitFor(readyExpr, '页面渲染 ' + url, timeout)
    return true
  }
  async waitFor(expr, label, timeout = 12000) {
    const t0 = Date.now()
    let last = ''
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.eval(expr)) return true
      } catch (e) {
        last = e.message
      }
      await sleep(200)
    }
    throw new Error(`等待超时（${label}）：${expr}${last ? ' :: ' + last : ''}`)
  }
}

// 注入页面的工具函数。
// 注意 vis()：**不能**用 offsetParent === null 判可见性 —— 抽屉/弹窗是 position:fixed，
// offsetParent 本身就是 null，会被误判成「不可见」而点不到按钮。
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
  navItems() { return [...document.querySelectorAll('.nav-item')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()); },
  text() { return document.body.innerText; },
  overflow() {
    const de = document.documentElement;
    return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, overflow: de.scrollWidth > de.clientWidth + 1 };
  },
};
'ok';
`

// ---------------------------------------------------------------------------
// 失败留证
//
// 为什么必须有：这一层是 M5/M6/M7 UI 行为的**唯一**保护，而它以前失败时
// 只往 stdout 打几行字。CI 里没人盯着 stdout —— 于是「最近三个模块的 UI 回归
// 坏了」这件事，你是**拿不到现场**的（不知道页面停在哪个 URL、长什么样、
// 控制台报了什么）。断言只告诉你「没找到元素」，不告诉你为什么。
//
// ⚠️ 铁律：留证代码**自己永不抛错**。抓现场失败绝不能把原始失败顶掉、
//    也不能让「本来跑得通的脚本」因为留证而红。所以这里每一层都 try/catch 兜住。
// ---------------------------------------------------------------------------
// ⚠️ 刻意**不放在 `test-results/` 里**：那是 Playwright 的产物目录，它每次启动都会清空它。
//    实测（2026-09-19）：把证据放进去之后，`npm run verify` 时 Playwright 清理该目录撞上
//    沙箱的批量删除保护（588 个文件 > 阈值 50）→ **一条 E2E 都没跑就死了**。
//    「证据被别人的清理顺手删掉」和「证据害得别人的清理失败」，两个都不想要 —— 所以另起目录。
const EVIDENCE_DIR = path.join(process.cwd(), 'evidence')
const EVIDENCE_MAX = 6 // 刷屏没意义：一次运行最多留 6 张，其余只进文字报告

let currentCdp = null
let evidenceCount = 0
let lastEvidenceUrl = null
const evidenceTasks = []
const evidenceLog = [] // 收尾时写进 report.txt

const safeName = (s) => String(s).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40)

/**
 * 抓一份失败现场：截图 + 文字（URL / 页面文本 / 页面异常 / 当前失败清单）。
 * @param {boolean} force 异常路径用 true —— 此时即使同一 URL 已留过证也要再抓一张
 * @returns {Promise<string|null>} 证据文件基名
 */
async function captureEvidence(cdp, label, force = false) {
  try {
    if (!cdp || (!force && evidenceCount >= EVIDENCE_MAX)) return null

    let url = ''
    try {
      url = await cdp.eval('location.href')
    } catch {
      url = '(取不到：CDP 可能已断)'
    }
    // 同一个页面上连续多条断言失败 → 只留第一张，避免 6 张全是同一个画面
    if (!force && url && url === lastEvidenceUrl) return null
    lastEvidenceUrl = url
    evidenceCount++

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const base = `${stamp}-${safeName(label)}`
    const files = []

    // ① 截图
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const png = path.join(EVIDENCE_DIR, base + '.png')
      fs.writeFileSync(png, Buffer.from(shot.data, 'base64'))
      files.push(path.basename(png))
    } catch (e) {
      files.push(`(截图失败: ${e.message})`)
    }

    // ② 页面可见文本
    let pageText = ''
    try {
      pageText = await cdp.eval('document.body ? document.body.innerText : ""')
    } catch {
      pageText = '(取不到页面文本)'
    }

    // ③ 文字现场
    const passed = checks.filter((c) => c.pass).length
    const lines = [
      '# office-oa 真机断言 · 失败现场',
      '',
      `时间：${new Date().toISOString()}`,
      `触发：${label}`,
      `页面：${url}`,
      `进度：通过 ${passed} / 已执行 ${checks.length}`,
      '',
      '## 失败清单（截至目前）',
      ...(checks.filter((c) => !c.pass).length
        ? checks.filter((c) => !c.pass).map((c) => `- ${c.name}${c.detail ? '  → ' + c.detail : ''}`)
        : ['（无）']),
      '',
      '## 页面异常 Runtime.exceptionThrown',
      ...(cdp.exceptions.length ? cdp.exceptions : ['（无）']),
      '',
      '## console.error',
      ...(cdp.consoleErrors.length ? cdp.consoleErrors : ['（无）']),
      '',
      '## 页面可见文本（前 4000 字）',
      '```',
      String(pageText).slice(0, 4000),
      '```',
      '',
    ]
    const txt = path.join(EVIDENCE_DIR, base + '.txt')
    fs.writeFileSync(txt, lines.join('\n'), 'utf8')
    files.push(path.basename(txt))

    evidenceLog.push({ label, url, files })
    console.log(`  ⤷ 已留证：evidence/${files.join(' , ')}`)
    return base
  } catch {
    return null // 留证失败就算了，绝不往上抛
  }
}

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log((pass ? '  OK   ' : '  FAIL ') + name + (detail ? '  → ' + detail : ''))
  // 失败即留证（不 await：check 是同步的。任务记进队列，收尾统一 flush）
  if (!pass) evidenceTasks.push(captureEvidence(currentCdp, name))
  return pass
}

/** 写总报告：不管成功失败都写，CI 里一并上传（成功时的报告也有价值：它是验收记录） */
function writeReport(thrown) {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
    const passed = checks.filter((c) => c.pass).length
    const failed = checks.filter((c) => !c.pass)
    const lines = [
      '# office-oa 真机断言报告',
      '',
      `时间：${new Date().toISOString()}`,
      `目标：${BASE}`,
      `结果：通过 ${passed} / ${checks.length}${thrown ? '（脚本异常中断）' : ''}`,
      thrown ? `\n异常：${thrown.message}` : '',
      '',
      '## 全部断言',
      ...checks.map((c) => `${c.pass ? '[OK]  ' : '[FAIL]'} ${c.name}${c.detail ? '  → ' + c.detail : ''}`),
      '',
      '## 留证文件',
      ...(evidenceLog.length ? evidenceLog.map((e) => `- ${e.label} @ ${e.url}\n  ${e.files.join('\n  ')}`) : ['（本次无失败，未留证）']),
      '',
    ]
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'report.txt'), lines.filter((l) => l !== '').join('\n'), 'utf8')
  } catch {
    /* 报告写不了也不影响退出码 */
  }
}

async function withBrowser(fn) {
  const CHROME = findChrome()
  const PORT = 9334
  const userDataDir = path.join(os.tmpdir(), 'oa-cdp-' + Date.now())
  // ⚠️ 这两条是**保险，不是必需** —— 别把注释写成「不加就起不来」：
  //    实测平台的同类脚本（同样是裸起系统 Chrome、且**没带**这两个参数）在
  //    ubuntu-latest 上照样跑通（api-test-platform 的 run #17，第 ⑤ 层 success），
  //    所以「不加必起不来」并不成立。
  //    留着它的真正理由：换 runner / 进容器时 sandbox 可能不可用，
  //    而容器 /dev/shm 太小会让渲染进程崩。本机不加（保持沙箱开启），只在 CI 生效。
  const ciFlags = process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--remote-allow-origins=*', // 必须：否则 WS 握手 403
      '--user-data-dir=' + userDataDir, // 必须：临时隔离，用完删
      ...ciFlags,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  )

  let ws = null
  let cdp = null
  let thrown = null
  try {
    const ver = await waitJson(`http://127.0.0.1:${PORT}/json/version`)
    console.log('Chrome:', ver.Browser)
    const tgt = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json())
    ws = new WebSocket(tgt.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', rej)
    })
    cdp = new CDP(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    currentCdp = cdp
    return await fn(cdp)
  } catch (e) {
    thrown = e
    // ⭐ 脚本被中断时的现场最值钱：此刻页面还活着，之后的分组一条都不会再跑。
    //    以前这里只有一行 `脚本异常: xxx`，等于「知道挂了、不知道为什么挂」。
    if (cdp) await captureEvidence(cdp, 'exception_' + safeName(e.message || 'unknown'), true)
    throw e
  } finally {
    // ⚠️ 顺序要紧：先把排队的证据 flush 完（还要用 ws 截图），再关连接
    await Promise.allSettled(evidenceTasks)
    writeReport(thrown)
    if (evidenceCount) console.log(`\n失败现场已写入 evidence/（${evidenceCount} 份截图 + report.txt）`)
    try { if (ws) ws.close() } catch {}
    try { child.kill() } catch {}
    await sleep(500)
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  }
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

async function loginAs(cdp, username) {
  await cdp.nav(`${BASE}/login`)
  const filled = await cdp.eval(`window.__t.click(${JSON.stringify(username)})`)
  if (filled === 'NOT_FOUND') throw new Error('登录页找不到演示账号按钮：' + username)
  const got = await cdp.eval(`document.querySelector('[data-t=username]').value`)
  if (got !== username) throw new Error(`快捷填充没生效：期望 ${username}，实际 ${got}`)
  await cdp.eval(`window.__t.click('登')`)
  await cdp.waitFor(`location.pathname === '/' && !!document.querySelector('.sidebar')`, `登录为 ${username}`)
}

async function logout(cdp) {
  const r = await cdp.eval(`window.__t.click('退出登录')`)
  if (r === 'NOT_FOUND') throw new Error('侧边栏找不到「退出登录」按钮')
  await cdp.waitFor(`location.pathname === '/login'`, '退出登录')
}

// ⚠️ 别直接 cdp.nav() 就断言：nav 的就绪条件（innerText.length > 60）只证明「框架渲染了」，
//    侧边栏的字数就够了。待办列表和单据详情都是**异步 fetch** 出来的，
//    不等它们到位就断言，会随机器快慢随机假失败（踩过一次）。
async function goTodo(cdp) {
  await cdp.nav(`${BASE}/todo`)
  await cdp.waitFor(
    `document.querySelectorAll('table.tbl tbody tr').length > 0 || window.__t.text().includes('没有待你审批')`,
    '待办列表加载完成',
  )
}

async function goDetail(cdp, id) {
  await cdp.nav(`${BASE}/requests/${id}`)
  // .kv 只在「详情加载成功」时存在；403/404 走错误卡片分支
  await cdp.waitFor(
    `!!document.querySelector('.kv') || window.__t.text().includes('403') || window.__t.text().includes('404')`,
    `单据 #${id} 详情加载完成`,
  )
}

/** 消息中心（M3）。同样要等**异步列表**到位，不能 nav 完就断言。 */
async function goNotifications(cdp) {
  await cdp.nav(`${BASE}/notifications`)
  await cdp.waitFor(
    `window.__t.text().includes('消息中心') &&
     (document.querySelectorAll('table.tbl tbody tr').length > 0 ||
      window.__t.text().includes('还没有任何消息') ||
      window.__t.text().includes('没有未读消息'))`,
    '消息中心加载完成',
  )
}

/** 会议室页：填表并点「预订」。返回「是否预订成功」（撞冲突时返回 false，冲突原文留在页面上） */
async function bookRoom(cdp, title, start, end) {
  await cdp.eval(`(() => {
    const set = (sel, val) => {
      const el = document.querySelector(sel)
      if (!el) return 'NO:' + sel
      el.value = val
      el.dispatchEvent(new Event('change', { bubbles: true }))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return 'OK'
    }
    const r1 = set('[data-t=booking-start]', ${JSON.stringify(start)})
    const r2 = set('[data-t=booking-end]', ${JSON.stringify(end)})
    const r3 = set('[data-t=booking-title]', ${JSON.stringify(title)})
    return [r1, r2, r3].join(',')
  })()`)
  await cdp.eval(`window.__t.click('预订')`)
  // 等结果落地：成功（列表出现该标题）或失败（页面出现错误提示）都算落地
  const t0 = Date.now()
  while (Date.now() - t0 < 10000) {
    const txt = await cdp.eval(`window.__t.text()`)
    if (txt.includes(title) || txt.includes('已被占用') || txt.includes('必填')) break
    await sleep(200)
  }
  return (await cdp.eval(`window.__t.text()`)).includes(title)
}

async function goRequests(cdp) {
  await cdp.nav(`${BASE}/requests`)
  // 就绪条件要**页面专属**：等「导出 CSV」这个按钮出现，比等「表格里有行」稳
  // （表格有行可能是上一条路由留下的旧 DOM）
  await cdp.waitFor(
    `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '导出 CSV')`,
    '单据列表加载完成',
  )
}

/** 取出「某张单据」在消息中心里的所有行文本（新在前） */
const notifRows = (cdp, titleText) =>
  cdp.eval(
    `[...document.querySelectorAll('table.tbl tbody tr')]
       .filter(x => x.textContent.includes(${JSON.stringify(titleText)}))
       .map(x => x.innerText)`,
  )

/** 读侧边栏未读角标的数字（没有角标 = 0） */
const unreadBadge = async (cdp) => {
  const t = await cdp.eval(
    `(document.querySelector('.nav-item[href="/notifications"] .nav-badge') || {}).textContent || ''`,
  )
  return Number(String(t).trim() || 0)
}

const reason = (n) => `UI 验收第 ${n} 步：家中有事需要请假`

async function scenario(cdp) {
  console.log('\n--- A. 未登录守卫 ---')
  await cdp.nav(`${BASE}/`)
  check('未登录访问 / 被重定向到 /login', (await cdp.eval('location.pathname')) === '/login', '实际 ' + (await cdp.eval('location.pathname')))
  const demoCount = await cdp.eval(`document.querySelectorAll('.demo-btns button').length`)
  check('登录页提供 8 个演示账号快捷填充', demoCount === 8, '实际 ' + demoCount)
  // 这条是补的：一开始 App.vue 无条件套外壳，登录卡片左边多出一条侧边栏，
  // 而当时所有断言都只看 pathname / 按钮，全都通过了 —— 断言写太窄等于没测。
  const hasSidebar = await cdp.eval(`!!document.querySelector('.sidebar')`)
  check('★ 登录页不渲染 App 外壳（无侧边栏）', !hasSidebar)
  const loginFullWidth = await cdp.eval(
    `Math.abs(document.querySelector('.login-wrap').getBoundingClientRect().width - window.innerWidth) < 2`,
  )
  check('★ 登录页占满整屏宽度（没被内容区 padding 挤窄）', loginFullWidth)

  console.log('\n--- B. 登录为普通员工（赵西 ops02）---')
  await loginAs(cdp, 'ops02')
  check('登录后进入总览页', (await cdp.eval('location.pathname')) === '/')
  const sideText = await cdp.eval(`document.querySelector('.sidebar').innerText`)
  check('侧边栏显示当前用户「赵西」', sideText.includes('赵西') && sideText.includes('employee'))
  const navItems = await cdp.eval(`window.__t.navItems()`)
  check('菜单含「部门架构」', navItems.some((t) => t.includes('部门架构')), navItems.join(' / '))
  check('★ 员工看不到「员工管理」（缺 user:read）', !navItems.some((t) => t.includes('员工管理')))
  check('★ 员工看不到「审计日志」（缺 audit:read）', !navItems.some((t) => t.includes('审计日志')))

  console.log('\n--- C. 纵向越权：不信前端，直接敲 /users 的 URL ---')
  await cdp.nav(`${BASE}/users`)
  await cdp.waitFor(`window.__t.text().includes('user:read')`, '403 错误卡片渲染完成')
  const usersText = await cdp.eval(`window.__t.text()`)
  check(
    '★ 页面显示后端真实 403 + 权限码（不是前端假装藏起来）',
    usersText.includes('403') && usersText.includes('user:read'),
    usersText.slice(0, 60).replace(/\n/g, ' | '),
  )

  console.log('\n--- D. 员工新建请假单并提交 ---')
  const title = `UI 验收单 ${Date.now()}`
  await cdp.nav(`${BASE}/requests/new`)
  await cdp.eval(`window.__t.click('请假申请')`)
  await cdp.eval(`window.__t.set('[data-t=title]', ${JSON.stringify(title)})`)
  await cdp.eval(`window.__t.set('[data-field=startDate]', '2026-10-08')`)
  await cdp.eval(`window.__t.set('[data-field=endDate]', '2026-10-09')`)
  await cdp.eval(`window.__t.set('[data-field=reason]', ${JSON.stringify(reason(1))})`)
  await cdp.eval(`window.__t.click('保存并提交')`)
  await cdp.waitFor(`/^\\/requests\\/\\d+$/.test(location.pathname)`, '跳转到详情页')
  const reqUrl = await cdp.eval('location.pathname')
  const reqId = reqUrl.split('/').pop()
  check(`提交成功并跳到详情页（${reqUrl}）`, /^\d+$/.test(reqId))
  // 详情是异步拉的，等它渲染出来再断言，避免竞态假失败
  await cdp.waitFor(`!!document.querySelector('.kv')`, '详情数据加载完成')
  let dText = await cdp.eval(`window.__t.text()`)
  check('详情页状态为「审批中」', dText.includes('审批中'))
  check('时间线出现第 1 步「直属上级审批」等待审批', dText.includes('直属上级审批') && dText.includes('等待审批'))
  check('流程快照已固化（第1步 + 第2步都在）', dText.includes('第1步') && dText.includes('第2步'))

  console.log('\n--- E. 一级审批：直属上级（王东 ops01）---')
  await logout(cdp)
  await loginAs(cdp, 'ops01')
  await goTodo(cdp)
  check(`王东的待办里出现 #${reqId}`, await cdp.eval(`window.__t.text().includes('#${reqId}')`))
  const opened = await cdp.eval(`window.__t.clickInRow('#${reqId}', '处理')`)
  check('点「处理」打开审批抽屉', opened === 'CLICKED', opened)
  await cdp.waitFor(`!!document.querySelector('.drawer')`, '抽屉出现')
  const drawerText = await cdp.eval(`document.querySelector('.drawer').innerText`)
  check('抽屉里带出申请人「赵西」和事由', drawerText.includes('赵西') && drawerText.includes('家中有事'))
  await cdp.eval(`window.__t.set('[data-t=comment]', '同意，注意工作交接')`)
  await cdp.eval(`window.__t.click('同意')`)
  await cdp.waitFor(`!document.querySelector('.drawer')`, '抽屉关闭')
  await goDetail(cdp, reqId)
  dText = await cdp.eval(`window.__t.text()`)
  check('一级通过后单据仍为「审批中」（推进到第 2 步）', dText.includes('审批中'))
  check('时间线显示第 1 步「已通过」+ 第 2 步人事复核待审', dText.includes('已通过') && dText.includes('人事复核'))
  check('审批意见已记录进时间线', dText.includes('同意，注意工作交接'))

  console.log('\n--- F. 二级审批：人事复核（李南 hr01）→ 归档 ---')
  await logout(cdp)
  await loginAs(cdp, 'hr01')
  await goTodo(cdp)
  check(`人事的待办里出现 #${reqId}`, await cdp.eval(`window.__t.text().includes('#${reqId}')`))
  const opened2 = await cdp.eval(`window.__t.clickInRow('#${reqId}', '处理')`)
  check('人事也能打开处理抽屉', opened2 === 'CLICKED', opened2)
  await cdp.waitFor(`!!document.querySelector('.drawer')`, '抽屉出现')
  await cdp.eval(`window.__t.set('[data-t=comment]', '已核对，批准')`)
  await cdp.eval(`window.__t.click('同意')`)
  await cdp.waitFor(`!document.querySelector('.drawer')`, '抽屉关闭')
  await goDetail(cdp, reqId)
  dText = await cdp.eval(`window.__t.text()`)
  check('★★ 全链路归档：状态变为「已通过」', dText.includes('已通过'))
  check('归档后没有可执行操作', dText.includes('没有可执行的操作'))
  const opBtns = await cdp.eval(
    `[...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => ['同意','驳回','提交审批','撤回'].some(k => t.includes(k))).length`,
  )
  check('归档后页面上「同意/驳回/提交/撤回」按钮数 = 0', opBtns === 0, '实际 ' + opBtns)

  console.log('\n--- G. 驳回 → 改后重提（验证 round 轮次保留）---')
  await logout(cdp)
  await loginAs(cdp, 'ops02')
  const title2 = `UI 驳回验收单 ${Date.now()}`
  await cdp.nav(`${BASE}/requests/new`)
  await cdp.eval(`window.__t.click('请假申请')`)
  await cdp.eval(`window.__t.set('[data-t=title]', ${JSON.stringify(title2)})`)
  await cdp.eval(`window.__t.set('[data-field=startDate]', '2026-11-02')`)
  await cdp.eval(`window.__t.set('[data-field=endDate]', '2026-11-03')`)
  await cdp.eval(`window.__t.set('[data-field=reason]', ${JSON.stringify(reason(2))})`)
  await cdp.eval(`window.__t.click('保存并提交')`)
  await cdp.waitFor(`/^\\/requests\\/\\d+$/.test(location.pathname)`, '跳转到详情页')
  const reqId2 = (await cdp.eval('location.pathname')).split('/').pop()
  check(`第二张单据已提交（#${reqId2}）`, /^\d+$/.test(reqId2))

  await logout(cdp)
  await loginAs(cdp, 'ops01')
  await goTodo(cdp)
  await cdp.eval(`window.__t.clickInRow('#${reqId2}', '处理')`)
  await cdp.waitFor(`!!document.querySelector('.drawer')`, '抽屉出现')
  await cdp.eval(`window.__t.click('驳回')`)
  await cdp.waitFor(`window.__t.text().includes('驳回必须填写理由')`, '空理由被前端拦下')
  check('★ 驳回不填理由 → 前端拦下并提示', true)
  await cdp.eval(`window.__t.set('[data-t=comment]', '材料不齐，补充交接安排后重提')`)
  await cdp.eval(`window.__t.click('驳回')`)
  await cdp.waitFor(`!document.querySelector('.drawer')`, '抽屉关闭')
  await goDetail(cdp, reqId2)
  dText = await cdp.eval(`window.__t.text()`)
  check('驳回后状态为「已驳回」', dText.includes('已驳回'))
  check('驳回理由出现在时间线上', dText.includes('材料不齐'))

  // 申请人改后重提 → round 应变成第 2 轮，且上一轮痕迹保留
  await logout(cdp)
  await loginAs(cdp, 'ops02')
  await goDetail(cdp, reqId2)
  check('申请人看到「修改后重新提交」按钮', (await cdp.eval(`window.__t.text()`)).includes('修改后重新提交'))
  await cdp.eval(`window.__t.click('修改后重新提交')`)
  // ⚠️ 判据不能用「第 2 轮」这种字符串：提交按钮的文案本身就写着「修改后重新提交（第 2 轮）」，
  //    一上来就会命中提交前的状态，断言会假通过。
  //    改用「时间线出现 2 个轮次分隔符」——只有重提真的生成了 round=2 的任务才会出现。
  await cdp.waitFor(
    `window.__t.text().includes('审批中') && document.querySelectorAll('.round-sep').length === 2`,
    '重提后进入第 2 轮',
    15000,
  )
  dText = await cdp.eval(`window.__t.text()`)
  const seps = await cdp.eval(`[...document.querySelectorAll('.round-sep')].map(e => e.textContent.trim())`)
  check('重提后进入第 2 轮（时间线出现 2 个轮次分隔）', seps.length === 2 && seps[1].includes('第 2 轮'), JSON.stringify(seps))
  check('重提后状态回到「审批中」', dText.includes('审批中'))
  check('★ 上一轮驳回痕迹保留（第 1 轮记录还在）', seps[0].includes('第 1 轮') && dText.includes('材料不齐'))

  console.log('\n--- G2. 消息中心（M3 站内通知）---')
  // 此刻 ops02（申请人赵西）刚在第 G 节被驳回、又重提过 —— 他的收件箱里应该有一条
  // 「被驳回（第 1 轮）」的通知，而单据本身已经是第 2 轮了。这正是快照要证明的东西。
  await goNotifications(cdp)

  const myRows = await notifRows(cdp, title2)
  check(`消息中心出现本单的驳回通知（${title2}）`, myRows.length >= 1, `匹配 ${myRows.length} 行`)
  check('通知类型徽标为「已驳回」', (myRows[0] || '').includes('已驳回'), (myRows[0] || '').slice(0, 70))
  check('通知正文带回驳回理由（不用点进单据也知道为什么被驳）', (myRows[0] || '').includes('材料不齐'))
  check('通知正文写清「谁驳回的」（王东）', (myRows[0] || '').includes('王东'))
  // ★ 关键：这条通知发生在第 1 轮，而单据已经重提到第 2 轮 —— 历史通知不许跟着改口
  check('★ 这条通知仍写「第 1 轮」（事件快照），而单据此刻已是第 2 轮', (myRows[0] || '').includes('第 1 轮'))

  // 与单据详情对一次账，证明上面那条不是碰巧（单据确实已经是第 2 轮）
  await goDetail(cdp, reqId2)
  const sepsNow = await cdp.eval(`[...document.querySelectorAll('.round-sep')].map(e => e.textContent.trim())`)
  check(
    '对照：单据详情时间线已推进到第 2 轮',
    sepsNow.some((s) => s.includes('第 2 轮')),
    JSON.stringify(sepsNow),
  )

  // ★ 角标 = 全量未读数（不是「本页有几条未读」），且跨组件同步
  await goNotifications(cdp)
  const badge1 = await unreadBadge(cdp)
  check('侧边栏「消息中心」出现未读角标', badge1 > 0, '角标 = ' + badge1)

  await cdp.eval(`window.__t.click('未读')`)
  await sleep(700)
  const unreadRows = await cdp.eval(`document.querySelectorAll('table.tbl tbody tr').length`)
  check(
    '「未读」筛选：行数 = 角标数字（页面 limit 50，超过时按 50 截断）',
    unreadRows === Math.min(badge1, 50),
    `行数 ${unreadRows} / 角标 ${badge1}`,
  )

  const marked = await cdp.eval(`window.__t.clickInRow(${JSON.stringify(title2)}, '标为已读')`)
  check('在未读列表里点「标为已读」', marked === 'CLICKED', marked)
  await sleep(700)
  const badge2 = await unreadBadge(cdp)
  check(
    '★ 标为已读后侧边栏角标当场 -1（跨组件共享状态真同步，不用刷新页面）',
    badge2 === badge1 - 1,
    `${badge1} → ${badge2}`,
  )
  check('单条已读后该消息从「未读」列表消失', !(await cdp.eval(`window.__t.text()`)).includes(title2))

  await cdp.eval(`window.__t.click('全部标为已读')`)
  await sleep(900)
  check('★ 「全部标为已读」后侧边栏角标消失', (await unreadBadge(cdp)) === 0)
  const markBtns = await cdp.eval(
    `[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '标为已读').length`,
  )
  check('全部已读后列表里「标为已读」按钮数 = 0', markBtns === 0, '实际 ' + markBtns)

  await cdp.eval(`window.__t.click('全部')`)
  await sleep(700)
  check('「全部」里历史消息仍在（已读 ≠ 删除）', await cdp.eval(`window.__t.text().includes(${JSON.stringify(title2)})`))
  check(
    '★ 申请人看不到任何「待你审批」通知（收件人隔离，不是靠前端过滤）',
    !(await cdp.eval(`window.__t.text()`)).includes('待你审批'),
  )

  // 审批人侧：同一张单据的「第 1 轮」与「第 2 轮」两条待审批通知应当并存、各自写着当时的轮次
  await logout(cdp)
  await loginAs(cdp, 'ops01')
  await goNotifications(cdp)
  const mgrRows = await notifRows(cdp, title2)
  check('审批人王东收到该单据的「待你审批」通知', mgrRows.length >= 1, `匹配 ${mgrRows.length} 行`)
  check(
    '★ 两轮通知并存（新在前）：第 2 轮 / 第 1 轮各一条，互不覆盖',
    mgrRows.length === 2 && mgrRows[0].includes('第 2 轮') && mgrRows[1].includes('第 1 轮'),
    `共 ${mgrRows.length} 行 · ` + mgrRows.map((r) => (r.includes('第 2 轮') ? '第2轮' : r.includes('第 1 轮') ? '第1轮' : '?')).join(','),
  )

  console.log('\n--- G3. 单据导出 CSV（M4）---')
  // 导出的验收点有一半在响应头里（平台那边用新补的头断言查）。真机这一层要看的是**链路**：
  // 按钮必须走 fetch 带上 token（写成裸 <a href> 会 401），并且把后端给的条数/文件名如实显示出来
  // —— 提示里的文件名是从 Content-Disposition 读出来的，所以这条断言同时证明了「响应头读到了」。
  await logout(cdp)
  await loginAs(cdp, 'ops02')
  await goRequests(cdp)

  check(
    '单据列表有「导出 CSV」按钮',
    await cdp.eval(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '导出 CSV')`),
  )
  check(
    '按钮旁写明「导出与列表同一条数据范围」（不让用户误以为是全量导出）',
    await cdp.eval(`window.__t.text().includes('导出会带上当前筛选条件')`),
  )

  const clicked = await cdp.eval(`window.__t.click('导出 CSV')`)
  await cdp.waitFor(`window.__t.text().includes('已导出')`, '导出完成提示')
  const flash = await cdp.eval(
    `(window.__t.text().match(/已导出 \\d+ 条 → requests-\\d{8}-\\d{6}\\.csv/) || ['(没匹配到)'])[0]`,
  )
  check(
    '★ 点「导出 CSV」→ 提示写明条数 + 后端给的文件名（token 带上了、响应头也读到了）',
    /^已导出 \d+ 条 → requests-\d{8}-\d{6}\.csv$/.test(flash),
    `${clicked} · ${flash}`,
  )

  console.log('\n--- G4. 会议室预订（M5）：时段冲突 ---')
  // 真机这一层要证明的不是「能订」，而是**冲突在页面上说得清清楚楚**：
  // 后端 409 的原文（谁、占了哪一段）要原样显示，而不是前端自己造一句「时间冲突」。
  await logout(cdp)
  await loginAs(cdp, 'ops02')

  await cdp.nav(`${BASE}/meetings`)
  await cdp.waitFor(`document.querySelectorAll('.tl-row').length > 1`, '会议室时间轴渲染')
  check(
    '菜单里有「会议室」入口',
    (await cdp.eval(`window.__t.navItems().join(',')`)).includes('会议室'),
  )
  const slotCount = await cdp.eval(`document.querySelectorAll('.tl-row:first-child .tl-head').length`)
  check('时间轴按半小时切格（08:00–22:00 = 28 格）', slotCount === 28, `${slotCount} 格`)

  // 用一个够远的日期，避开 seed 里明天的示例预订，也避开别的测试留下的记录
  const meetDate = await cdp.eval(`(() => {
    const d = new Date(Date.now() + 7 * 86400000)
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  })()`)
  await cdp.eval(`window.__t.set('input[type=date]', ${JSON.stringify(meetDate)})`)
  await cdp.waitFor(`!window.__t.text().includes('加载中')`, '切换日期后重新加载')

  const titleA = `真机会议 A ${Date.now()}`
  const booked = await bookRoom(cdp, titleA, '14:00', '15:00')
  check('预订成功 → 列表里出现这条预订', booked, `${titleA}`)

  const takenCells = await cdp.eval(
    `document.querySelectorAll('.tl-cell.taken').length`,
  )
  check('时间轴上出现占用格（14:00-15:00 = 2 格）', takenCells >= 2, `${takenCells} 格`)

  // 同一时段再订一次 → 页面必须把 409 的原文显示出来
  await bookRoom(cdp, `真机会议 B ${Date.now()}`, '14:00', '15:00')
  await cdp.waitFor(`window.__t.text().includes('已被占用')`, '冲突提示出现', 8000)
  const clashText = await cdp.eval(
    `(window.__t.text().match(/该时段已被占用[^\\n]*/) || ['(没匹配到)'])[0]`,
  )
  check(
    '★ 冲突提示写明「被谁占了哪一段」（后端 409 原文，不是前端自己造的话）',
    clashText.includes('真机会议 A'),
    clashText.slice(0, 60),
  )

  // 换成别人的账号：别人的预订不该出现「取消」按钮（canCancel 由后端给结论）
  await logout(cdp)
  await loginAs(cdp, 'ops03')
  await cdp.nav(`${BASE}/meetings`)
  await cdp.eval(`window.__t.set('input[type=date]', ${JSON.stringify(meetDate)})`)
  await cdp.waitFor(`window.__t.text().includes('真机会议 A')`, '别人的账号也能看到这条预订')
  const cancelBtns = await cdp.eval(`document.querySelectorAll('[data-t=booking-cancel]').length`)
  check(
    '★ 别人的预订不显示「取消」按钮（后端 canCancel=false，前端不自己判断）',
    cancelBtns === 0,
    `${cancelBtns} 个取消按钮`,
  )

  // 本人回来取消 → 槽位释放，时间轴占用格消失
  await logout(cdp)
  await loginAs(cdp, 'ops02')
  await cdp.nav(`${BASE}/meetings`)
  await cdp.eval(`window.__t.set('input[type=date]', ${JSON.stringify(meetDate)})`)
  await cdp.waitFor(`document.querySelectorAll('[data-t=booking-cancel]').length > 0`, '本人看到取消按钮')
  await cdp.eval(`window.__t.click('取消')`)
  await cdp.waitFor(`window.__t.text().includes('已取消')`, '取消成功提示')
  const leftCells = await cdp.eval(`document.querySelectorAll('.tl-cell.taken').length`)
  check('取消后时间轴占用格被释放', leftCells === 0, `剩 ${leftCells} 格`)

  console.log('\n--- G5. 统计看板（M6）：数据范围收敛 ---')
  // 员工视角：只有「我的」一个范围可看（tab 不渲染 = 想点都没有，但真正的防线在后端 403）
  await cdp.nav(`${BASE}/stats`)
  await cdp.waitFor(`document.querySelectorAll('.stat-card').length >= 5`, '统计卡片渲染')
  const empTabs = await cdp.eval(`document.querySelectorAll('.tabs .btn').length`)
  check('★ 员工只有「我的」一个范围（dept/all 的 tab 不渲染）', empTabs === 1, `${empTabs} 个 tab`)
  const empNum = await cdp.eval(`document.querySelector('.stat-num').innerText.trim()`)
  check('员工看板渲染出自己的单据数', /^\d+$/.test(empNum), empNum)

  // admin：三个范围都可见，默认全公司；切到「我的」数字必须变（证明范围真的在过滤，不是换皮）
  await logout(cdp)
  await loginAs(cdp, 'admin')
  await cdp.nav(`${BASE}/stats`)
  await cdp.waitFor(`document.querySelectorAll('.tabs .btn').length === 3`, 'admin 三个范围 tab')
  await cdp.waitFor(`document.querySelector('.tabs .btn-primary').textContent.includes('全公司')`, '默认落在全公司')
  const allNum = await cdp.eval(`parseInt(document.querySelector('.stat-num').innerText)`)
  await cdp.eval(`window.__t.click('我的')`)
  await cdp.waitFor(`document.querySelector('.tabs .btn-primary').textContent.includes('我的')`, '切到我的', 8000)
  await sleep(500) // 等 load 完成（tab 先变、数字后到）
  const mineNum = await cdp.eval(`parseInt(document.querySelector('.stat-num').innerText)`)
  check(
    '★ 切范围后数字真的变了（all → mine 不是同一份数据换皮）',
    Number.isFinite(mineNum) && mineNum <= allNum,
    `all=${allNum} mine=${mineNum}`,
  )

  // ★ 跨层对账：页面上那个数字，必须等于**接口自己算出来的**同一个数。
  //   否则前端可能在自己算一份 —— 而「两处各算一份」正是 M4 导出（越权）、
  //   M6 统计（口径漂移）反复踩的那类问题。这里从页面里直接带 token 打接口来比。
  const apiMine = await cdp.eval(
    `fetch('/api/stats/overview?scope=mine', { headers: { authorization: 'Bearer ' + localStorage.getItem('oa.token') } })
       .then(r => r.json()).then(d => d.requests.total)`,
  )
  check(
    '★ 页面数字 == 接口 scope=mine 的 total（不是前端自己算的）',
    mineNum === apiMine,
    `UI=${mineNum} API=${apiMine}`,
  )

  console.log('\n--- G6. 考勤打卡（M7）：打卡幂等 + 范围收敛 ---')
  // 跑前清掉两名测试账号「今天」的打卡，让本段每次都从干净状态开始
  // （打卡写的是真实日期，不清场第二轮按钮就是禁用的，断言会假失败）
  {
    const today = new Date().toISOString().slice(0, 10)
    const db = getDb()
    db.prepare(`DELETE FROM attendance WHERE user_id IN (3, 4) AND date = ?`).run(today)
  }
  await logout(cdp)
  await loginAs(cdp, 'ops02') // 普通员工（id 4）
  await cdp.nav(`${BASE}/attendance`)
  await cdp.waitFor(`!!document.querySelector('[data-t="att-clock-in"]')`, '考勤页渲染')

  // 员工只有「我的」一个范围 tab（dept/all 不渲染；真正的防线在后端 403，已由单测覆盖）
  const attTabs = await cdp.eval(
    `Array.from(document.querySelectorAll('.tabs .btn')).filter(b => b.getAttribute('data-t')?.startsWith('att-scope')).length`,
  )
  check('★ 员工只有「我的」一个范围 tab', attTabs === 1, `${attTabs} 个`)

  // 上班打卡 → 今天状态出现「上班 HH:MM」（注意：waitFor 不能只查 includes('上班')，
  // 因为按钮文字本身就叫「上班打卡」，会永远匹配；必须等到真的出现「上班 时间」）
  await cdp.eval(`window.__t.click('上班打卡')`)

  const dbToday = () => {
    try {
      const d = new Date().toISOString().slice(0, 10)
      const row = getDb().prepare(`SELECT * FROM attendance WHERE user_id=4 AND date=?`).get(d)
      return row ? `id4 ${row.date} in=${row.clock_in} out=${row.clock_out}` : `id4 ${d} 无记录`
    } catch (x) {
      return 'db-err:' + x.message
    }
  }

  let inOk = false
  try {
    await cdp.waitFor(
      `!!document.querySelector('[data-t="att-today-status"]').textContent.match(/上班\\s+\\d{2}:\\d{2}/)`,
      '今天状态出现上班时间',
      8000,
    )
    inOk = true
  } catch (e) {
    const errTxt = await cdp.eval(`document.querySelector('[data-t="att-error"]')?.textContent || ''`)
    const raw = await cdp.eval(`document.querySelector('[data-t="att-today-status"]')?.textContent || ''`)
    console.log('  ↳ 打卡未刷新的现场：', { 页面提示: errTxt, 状态栏: raw.trim().slice(0, 40), 数据库: dbToday() })
  }
  const inShown = await cdp.eval(`document.querySelector('[data-t="att-today-status"]').textContent`)
  check('★ 上班打卡后页面显示打卡时间（不自己编造）', inOk && /上班\s+\d{2}:\d{2}/.test(inShown), inShown.trim().slice(0, 40))

  // 下班打卡 → 出现「下班 HH:MM」
  await cdp.eval(`window.__t.click('下班打卡')`)
  let outOk = false
  try {
    await cdp.waitFor(
      `!!document.querySelector('[data-t="att-today-status"]').textContent.match(/下班\\s+\\d{2}:\\d{2}/)`,
      '今天状态出现下班时间',
      8000,
    )
    outOk = true
  } catch (e) {
    const errTxt = await cdp.eval(`document.querySelector('[data-t="att-error"]')?.textContent || ''`)
    console.log('  ↳ 下班打卡未刷新的现场：', { 页面提示: errTxt, 数据库: dbToday() })
  }
  const outShown = await cdp.eval(`document.querySelector('[data-t="att-today-status"]').textContent`)
  check('下班打卡后页面显示下班时间', outOk && /下班\s+\d{2}:\d{2}/.test(outShown), outShown.trim().slice(0, 40))

  // 统计卡片有数（今天这条打卡会让 recordedDays >= 1；种子已给 6 天，打完卡应 >= 7）
  const recDays = await cdp.eval(`parseInt(document.querySelector('[data-t="att-summary-recorded"]').textContent)`)
  check('★ 统计看板的有打卡天数 >= 7（今天这条真的算进去了）', recDays >= 7, `${recDays}`)

  console.log('\n--- G7. 批量审批（M8）：逐条独立 + 部分成功看得见 ---')
  // 真机这层要证明的不是「能一次批多条」，而是三件接口层看不见的事：
  //   ① 勾选框真的绑上了（不是渲染出来好看而已）
  //   ② 结果面板**逐条**列出，而不是只报一个总数
  //   ③ 「部分成功」在界面上说得清 —— 这条必须靠「别人先批了」来构造：
  //      待办列表天然只列「还没人处理的」，部分成功只会从这种数据陈旧里冒出来。
  await logout(cdp)
  await loginAs(cdp, 'ops02')
  const batchIds = []
  for (const n of [1, 2]) {
    await cdp.nav(`${BASE}/requests/new`)
    await cdp.waitFor(`!!document.querySelector('[data-t=title]')`, '新建页就绪')
    await cdp.eval(`window.__t.click('请假申请')`)
    await cdp.eval(`window.__t.set('[data-t=title]', ${JSON.stringify(`批量验证单 ${Date.now()}-${n}`)})`)
    await cdp.eval(`window.__t.set('[data-field=startDate]', '2026-10-12')`)
    await cdp.eval(`window.__t.set('[data-field=endDate]', '2026-10-13')`)
    await cdp.eval(`window.__t.set('[data-field=reason]', '批量审批真机验证')`)
    await cdp.eval(`window.__t.click('保存并提交')`)
    await cdp.waitFor(`/^\\/requests\\/\\d+$/.test(location.pathname)`, '提交后跳详情')
    batchIds.push((await cdp.eval('location.pathname')).split('/').pop())
  }

  await logout(cdp)
  await loginAs(cdp, 'ops01')
  await goTodo(cdp)

  const boxCount = await cdp.eval(`document.querySelectorAll('table.tbl tbody input[type=checkbox]').length`)
  check('待办列表每行都有勾选框', boxCount >= 2, `${boxCount} 个`)

  const picked = await cdp.eval(`(() => {
    const want = ${JSON.stringify(batchIds)}
    let n = 0
    for (const r of document.querySelectorAll('table.tbl tbody tr')) {
      const a = r.querySelector('a[href^="/requests/"]')
      if (!a) continue
      if (!want.includes(a.getAttribute('href').split('/').pop())) continue
      const cb = r.querySelector('input[type=checkbox]')
      if (cb) { cb.click(); n++ }
    }
    return n
  })()`)
  check('★ 勾选框点得动（勾中刚提交的两张单）', picked === 2, `勾中 ${picked} 个`)
  await cdp.waitFor(`!!document.querySelector('.batch-bar')`, '批量操作栏出现')
  const barText = await cdp.eval(`document.querySelector('.batch-bar').innerText.replace(/\\s+/g, ' ')`)
  check('★ 勾选后出现批量操作栏并写明已选条数', barText.includes('已选 2 条'), barText.slice(0, 60))

  // 构造「别人先批了」：在页面里直接调接口把其中一张推走（等价于另一个标签页/另一个审批人）
  const pre = await cdp.eval(`fetch('/api/requests/${batchIds[0]}/approve', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + localStorage.getItem('oa.token'), 'content-type': 'application/json' },
    body: JSON.stringify({ comment: '抢先处理' }),
  }).then(r => r.status)`)
  check('（构造数据陈旧）其中一张已被别人先批掉', pre === 200, `HTTP ${pre}`)

  await cdp.eval(`window.__t.set('[data-t=batch-comment]', '批量同意，已核对')`)
  await cdp.eval(`document.querySelector('[data-t=batch-approve]').click()`)
  await cdp.waitFor(`!!document.querySelector('.batch-result')`, '批量结果面板出现')

  const resHead = await cdp.eval(`document.querySelector('.batch-result-head').innerText.replace(/\\s+/g, ' ')`)
  check(
    '★★ 结果面板如实报「成功 1 条、失败 1 条」（部分成功在界面上说得清）',
    resHead.includes('成功 1') && resHead.includes('失败 1'),
    resHead,
  )
  const batchLines = await cdp.eval(
    `[...document.querySelectorAll('.batch-result-list li')].map(li => li.innerText.replace(/\\s+/g, ' ').trim())`,
  )
  check('★ 逐条列出而不是只报总数', batchLines.length === 2, batchLines.join(' / ').slice(0, 140))
  check(
    '失败那条给的是后端原话（不是前端自己编一句「操作失败」）',
    batchLines.some((l) => l.includes('不是当前步骤的审批人')),
    batchLines.find((l) => !l.includes('已通过')) || '(没找到)',
  )

  // 刷新后：两张单都不该再挂在 ops01 的待办里（都被推进到第 2 步了）
  await goTodo(cdp)
  const stillThere = await cdp.eval(
    `[...document.querySelectorAll('table.tbl tbody tr')].filter(r => ${JSON.stringify(batchIds)}.some(id => r.textContent.includes('#' + id))).length`,
  )
  check('批量处理后两张单都离开了他的待办（推进到第 2 步）', stillThere === 0, `还剩 ${stillThere} 行`)

  console.log('\n--- H. 移动端布局（真改视口，不靠截图）---')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await goDetail(cdp, reqId2)
  const ov = await cdp.eval(`window.__t.overflow()`)
  check('390px 无横向溢出', !ov.overflow, `scrollWidth=${ov.scrollWidth} clientWidth=${ov.clientWidth}`)

  // 新增的消息中心也要过一遍 —— 一个带 5 列的表格在窄屏上很容易撑破
  await goNotifications(cdp)
  const ov2 = await cdp.eval(`window.__t.overflow()`)
  check('消息中心 390px 无横向溢出', !ov2.overflow, `scrollWidth=${ov2.scrollWidth} clientWidth=${ov2.clientWidth}`)

  // 单据列表这轮多了一个按钮，一起过一遍窄屏
  await goRequests(cdp)
  const ov3 = await cdp.eval(`window.__t.overflow()`)
  check('单据列表 390px 无横向溢出', !ov3.overflow, `scrollWidth=${ov3.scrollWidth} clientWidth=${ov3.clientWidth}`)

  await cdp.send('Emulation.clearDeviceMetricsOverride')

  console.log('\n--- I. 退出登录 ---')
  await cdp.nav(`${BASE}/`)
  await logout(cdp)
  check('退出登录后回到 /login', (await cdp.eval('location.pathname')) === '/login')
  const tokenGone = await cdp.eval(`localStorage.getItem('oa.token') === null`)
  check('本地 token 已清除', tokenGone)

  return { reqId, reqId2 }
}

withBrowser(scenario)
  .then((r) => {
    console.log(`\n（本次产生的单据：#${r.reqId} 已归档、#${r.reqId2} 已重提待审）`)
    const pass = checks.filter((c) => c.pass).length
    console.log(`\n通过 ${pass} / ${checks.length}`)
    if (checks.some((c) => !c.pass)) {
      console.log('\n失败项：')
      for (const c of checks.filter((x) => !x.pass)) console.log('  - ' + c.name + (c.detail ? ' → ' + c.detail : ''))
      process.exitCode = 1
    }
  })
  .catch((e) => {
    console.error('\n脚本异常:', e.message)
    if (e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'))
    // 异常时也要说清「死在半路的哪儿」—— 只报一句异常等于没法排查
    const pass = checks.filter((c) => c.pass).length
    console.error(`（异常前已执行断言：通过 ${pass} / 共 ${checks.length}）`)
    console.error('现场（截图 + 页面文本 + 页面异常）见 evidence/')
    process.exitCode = 2
  })
