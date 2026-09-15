// ============================================================================
// 真机浏览器验收：把一张单据从「提交」跑到「归档」，再跑一遍「驳回 → 重提」。
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
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
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

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log((pass ? '  OK   ' : '  FAIL ') + name + (detail ? '  → ' + detail : ''))
  return pass
}

async function withBrowser(fn) {
  const CHROME = findChrome()
  const PORT = 9334
  const userDataDir = path.join(os.tmpdir(), 'oa-cdp-' + Date.now())
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--remote-allow-origins=*', // 必须：否则 WS 握手 403
      '--user-data-dir=' + userDataDir, // 必须：临时隔离，用完删
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
  try {
    const ver = await waitJson(`http://127.0.0.1:${PORT}/json/version`)
    console.log('Chrome:', ver.Browser)
    const tgt = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json())
    ws = new WebSocket(tgt.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', rej)
    })
    const cdp = new CDP(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    return await fn(cdp)
  } finally {
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

  console.log('\n--- H. 移动端布局（真改视口，不靠截图）---')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await goDetail(cdp, reqId2)
  const ov = await cdp.eval(`window.__t.overflow()`)
  check('390px 无横向溢出', !ov.overflow, `scrollWidth=${ov.scrollWidth} clientWidth=${ov.clientWidth}`)
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
    process.exitCode = 2
  })
