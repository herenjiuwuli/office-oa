// ============================================================================
// 跨模块口径对账（列表 / 导出 / 统计 / 通知）
//
// 每个模块内部都有自己的用例：导出测了转义与公式注入、统计测了 scope 与越界 403、
// 通知测了收件人隔离与幂等、列表测了可见性。它们全绿。
//
// 这个文件只问一件事：**模块之间对得上吗？**
//
// 为什么必须单独一层 —— 口径不一致是**沉默的**：
//   · 列表说 18 条、导出悄悄给你 20 条 → 两个页面都「正常」，没有一条断言会红；
//   · 统计说「全公司 37 条」、列表说 36 条 → 没人会去对着看；
//   · 更糟的是「导出的比看得到的多」根本不是显示问题，**它就是越权**，而且不报错。
//
// M4 把可见性抽成 `scopeFilter()` 让列表与导出共用，正是为了防这个 ——
// 但「抽出来了」只是**代码约定**。在写下这个文件之前，**没有任何一条用例证明
// 它真的被共用了**：全靠人读代码相信。这个文件把「相信」换成「证明」。
//
// ⚠️ 条数一律**动态取基准**（先读一次列表再比），绝不写死种子条数 ——
//    seed 一改，写死的数字就会假失败（export.test.js 的注释里记过这个教训）。
// ============================================================================
import { describe, expect, it } from 'vitest'
import { CSV_BOM } from '../server/lib/csv.js'
import { LEAVE_FORM, api, login, makeApp, U } from './helpers.js'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 一次登录取多个账号的 token */
async function loginAll(app, names) {
  const out = {}
  for (const n of names) out[n] = await login(app, U[n])
  return out
}

/** 直连 inject 取原始响应（导出是 CSV 不是 JSON，helpers.api 那层会把 body 吃掉） */
async function rawGet(app, token, url, query) {
  const res = await app.inject({
    method: 'GET',
    url,
    query,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { status: res.statusCode, headers: res.headers, text: res.rawPayload.toString('utf8') }
}

/**
 * 按 RFC4180 数「记录数」（含表头）——**引号内的 CRLF 不算换行**。
 *
 * ⭐ 这里的考究不是炫技：导出 CSV 里有自由文本字段（标题），
 *    标题里带换行时，用「按 \r\n 切行」的朴素写法会**多算出几行**。
 *    于是「CSV 行数 == 列表条数」这条断言会**因为数错而假红**，
 *    更坏的情况是有人为了让它变绿去改断言 —— 那就把真正的对账弄丢了。
 *    要断言两处数字相等，得先保证「数数的方式」本身是对的。
 */
function csvRecordCount(text) {
  const t = String(text).replace(CSV_BOM, '')
  let count = 0
  let inQuote = false
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inQuote) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          cur += '"'
          i++ // 转义的双引号，跳过下一个
        } else {
          inQuote = false
        }
      } else {
        cur += ch // 引号内的 \r\n 属于字段内容，不换记录
      }
      continue
    }
    if (ch === '"') {
      inQuote = true
      continue
    }
    if (ch === '\r' && t[i + 1] === '\n') {
      count++
      cur = ''
      i++
      continue
    }
    cur += ch
  }
  if (cur.trim() !== '') count++ // 末行没跟换行的情况
  return count
}

/** CSV 里的数据行数（去掉表头） */
const csvRows = (text) => csvRecordCount(text) - 1

const statsTotal = async (client, scope) =>
  (await client.get('/api/stats/overview', scope ? { scope } : undefined)).body.requests.total

// ---------------------------------------------------------------------------
// A. 列表 ↔ 导出：同一筛选下必须同数
// ---------------------------------------------------------------------------
describe('A. 列表 ↔ 导出 CSV', () => {
  it('★ 全量视角：列表条数 == 导出数据行数 == X-Total-Count', async () => {
    const app = await makeApp()
    const t = await loginAll(app, ['admin'])
    const client = api(app, t.admin)

    const list = await client.get('/api/requests')
    const csv = await rawGet(app, t.admin, '/api/requests/export.csv')

    expect(csv.status).toBe(200)
    expect(list.body.scope).toBe('all') // admin 有 request:read:all
    expect(csvRows(csv.text)).toBe(list.body.total)
    expect(Number(csv.headers['x-total-count'])).toBe(list.body.total)
  })

  it('★ 员工视角：导出的就是他自己那份，不多给 —— 列表与导出同时被收敛', async () => {
    const app = await makeApp()
    const t = await loginAll(app, ['admin', 'ops1'])

    const mine = await api(app, t.ops1).get('/api/requests')
    const all = await api(app, t.admin).get('/api/requests')
    const csv = await rawGet(app, t.ops1, '/api/requests/export.csv')

    expect(mine.body.scope).toBe('mine')
    expect(csvRows(csv.text)).toBe(mine.body.total)
    // 关键：这两处**必须一起收敛**。只收敛了列表、忘了导出，就是沉默越权
    expect(mine.body.total).toBeLessThan(all.body.total)
  })

  it('★ 带筛选时仍然一致：列表筛「草稿」，导出不能借机把全部给你', async () => {
    const app = await makeApp()
    const t = await loginAll(app, ['admin'])
    const client = api(app, t.admin)

    // 造一条状态不同的单据，保证筛选前后条数确实不同（否则这条断言会恒真）
    const created = await client.post('/api/requests', { type: 'leave', title: '草稿专用', formData: LEAVE_FORM })
    expect(created.status).toBe(201)

    const q = { status: 'draft' }
    const list = await client.get('/api/requests', q)
    const csv = await rawGet(app, t.admin, '/api/requests/export.csv', q)

    expect(csvRows(csv.text)).toBe(list.body.total)
    // 筛选真的起作用了：比不筛时少，说明上面那条不是在比两份「全部」
    const allCsv = await rawGet(app, t.admin, '/api/requests/export.csv')
    expect(csvRows(csv.text)).toBeLessThan(csvRows(allCsv.text))
    expect(Number(csv.headers['x-total-count'])).toBe(list.body.total)
  })

  it('⭐ 标题里带换行/逗号/引号：CSV 记录数仍 == 列表条数（朴素按行切会数多）', async () => {
    const app = await makeApp()
    const t = await loginAll(app, ['admin'])
    const client = api(app, t.admin)

    // ⚠️ 这里故意用 **CRLF**（\r\n）而不是裸 \n：CSV 本身按 CRLF 分行，
    //    只有字段内也出现 CRLF 时，朴素 split('\r\n') 才会数多。
    //    第一版写成裸 \n，反证不成立（naive === records，这条断言会假红）—— 记在这里。
    const title = '第一行\r\n第二行 "带引号" 与,逗号'
    const created = await client.post('/api/requests', { type: 'leave', title, formData: LEAVE_FORM })
    expect(created.status).toBe(201)
    expect(created.body.title).toContain('\n') // 内部换行被保留（只 trim 首尾）

    const list = await client.get('/api/requests')
    const csv = await rawGet(app, t.admin, '/api/requests/export.csv')
    const records = csvRows(csv.text)

    expect(records).toBe(list.body.total) // 正确数法：相等

    // 反证：朴素「按 \r\n 切行」会多算 —— 这就是不能偷懒用 split 的原因
    const naive = csv.text.replace(CSV_BOM, '').split('\r\n').filter(Boolean).length - 1
    expect(naive).toBeGreaterThan(records)
  })

  it('?mine=1 自愿缩回：列表缩回，导出也一起缩回', async () => {
    const app = await makeApp()
    const t = await loginAll(app, ['admin'])
    const client = api(app, t.admin)

    const forced = await client.get('/api/requests', { mine: '1' })
    const csv = await rawGet(app, t.admin, '/api/requests/export.csv', { mine: '1' })

    expect(forced.body.scope).toBe('mine')
    expect(csvRows(csv.text)).toBe(forced.body.total)
  })
})

// ---------------------------------------------------------------------------
// B. 列表 ↔ 统计：同一范围下必须同数
// ---------------------------------------------------------------------------
describe('B. 列表 ↔ 统计看板', () => {
  it('★ 全量视角：统计 scope=all 的总数 == 列表条数', async () => {
    const app = await makeApp()
    const t = await loginAll(app, ['admin'])
    const client = api(app, t.admin)

    const list = await client.get('/api/requests')
    expect(list.body.scope).toBe('all')
    expect(await statsTotal(client, 'all')).toBe(list.body.total)
  })

  it('★ 员工视角：统计 scope=mine 的总数 == 他自己的列表条数', async () => {
    const app = await makeApp()
    const t = await loginAll(app, ['ops1'])
    const client = api(app, t.ops1)

    const list = await client.get('/api/requests')
    expect(await statsTotal(client, 'mine')).toBe(list.body.total)
  })

  it('⭐ 部门经理：统计看得见「本部门」，单据明细只看得到自己 —— 这个不对称是刻意的，钉住它', async () => {
    const app = await makeApp()
    const t = await loginAll(app, ['opsMgr', 'ops1'])
    const mgr = api(app, t.opsMgr)

    // 让部门里多出**别人的**一条单据，这样「部门 > 自己」才有确定性，
    // 不能指望种子数据里刚好有同事的单据（那会随 seed 变化）
    const colleague = await api(app, t.ops1).post('/api/requests', {
      type: 'leave',
      title: '部门同事的单据',
      formData: LEAVE_FORM,
    })
    expect(colleague.status).toBe(201)

    const deptTotal = await statsTotal(mgr, 'dept')
    const mineTotal = await statsTotal(mgr, 'mine')
    const list = await mgr.get('/api/requests')
    const csv = await rawGet(app, t.opsMgr, '/api/requests/export.csv')

    // ① 聚合：经理能看整个部门（maxScopeFor 认 dept_manager 角色）
    expect(deptTotal).toBeGreaterThan(mineTotal)

    // ② 明细：没有 request:read:all，所以列表/导出都收敛到自己
    //    —— 老板让他看「部门有多少单」，不等于让他看「部门每个人分别写了什么」
    expect(list.body.scope).toBe('mine')
    expect(list.body.total).toBe(mineTotal)
    expect(csvRows(csv.text)).toBe(list.body.total)

    // ⚠️ 这里是刻意保留的不对称，不是 bug。真要改，注意 request:read:all
    //    只有「全部」一档、**没有「仅本部门」这一档**：给 dept_manager 加上它，
    //    拿到的是**全公司**明细，而不是他部门 —— 爆炸半径比想象中大。
  })
})

// ---------------------------------------------------------------------------
// C. 通知 ↔ 业务事件：事件数必须一一对应（不静默丢失、不重复）
// ---------------------------------------------------------------------------
describe('C. 通知 ↔ 业务事件', () => {
  const unread = async (client) => (await client.get('/api/notifications/unread-count')).body.unread

  it('★ 提交一次 = 审批人恰好 +1 条（不多不少）', async () => {
    const app = await makeApp()
    const t = await loginAll(app, ['ops1', 'opsMgr'])
    const applicant = api(app, t.ops1)
    const approver = api(app, t.opsMgr)

    const before = await unread(approver)
    const created = await applicant.post('/api/requests', { type: 'leave', title: '对账用单据', formData: LEAVE_FORM })
    expect(created.status).toBe(201)

    // 建单（草稿）不该惊动任何人
    expect(await unread(approver)).toBe(before)

    expect((await applicant.post(`/api/requests/${created.body.id}/submit`)).status).toBe(200)
    expect(await unread(approver)).toBe(before + 1)

    // 通知与单据对得上（round、关联的单据 id）
    const list = await approver.get('/api/notifications', { unread: '1' })
    const n = list.body.items.find((x) => x.requestId === created.body.id)
    expect(n).toBeTruthy()
    expect(n.type).toBe('task')
    expect(n.round).toBe(1)
  })

  it('★ 归档一次 = 申请人恰好 +1 条结果通知（主操作成功，副作用没丢）', async () => {
    const app = await makeApp()
    const t = await loginAll(app, ['ops1', 'opsMgr', 'hr'])
    const applicant = api(app, t.ops1)

    const created = await applicant.post('/api/requests', { type: 'leave', title: '归档对账', formData: LEAVE_FORM })
    const id = created.body.id
    await applicant.post(`/api/requests/${id}/submit`)

    const before = await unread(applicant)
    expect((await api(app, t.opsMgr).post(`/api/requests/${id}/approve`, { comment: '同意' })).status).toBe(200)
    // 一级通过只是推进，还没归档 → 这时不该有结果通知
    expect(await unread(applicant)).toBe(before)

    expect((await api(app, t.hr).post(`/api/requests/${id}/approve`, { comment: '复核通过' })).status).toBe(200)
    expect(await unread(applicant)).toBe(before + 1)

    const list = await applicant.get('/api/notifications', { unread: '1' })
    expect(list.body.items.find((x) => x.requestId === id && x.type === 'approved')).toBeTruthy()
  })

  it('★ 撤回一次 = 待审的人各收 1 条 task + 1 条 cancelled，且撤回的人不给自己发', async () => {
    const app = await makeApp()
    const t = await loginAll(app, ['ops1', 'opsMgr'])
    const applicant = api(app, t.ops1)
    const approver = api(app, t.opsMgr)

    const created = await applicant.post('/api/requests', { type: 'leave', title: '撤回对账', formData: LEAVE_FORM })
    const id = created.body.id
    await applicant.post(`/api/requests/${id}/submit`)

    const approverBefore = await unread(approver)
    const applicantBefore = await unread(applicant)

    expect((await applicant.post(`/api/requests/${id}/cancel`)).status).toBe(200)

    expect(await unread(approver)).toBe(approverBefore + 1) // 「已撤回」
    expect(await unread(applicant)).toBe(applicantBefore) // 自己不该收到自己那单的通知
    const list = await approver.get('/api/notifications', { unread: '1' })
    expect(list.body.items.find((x) => x.requestId === id && x.type === 'cancelled')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// D. 端到端对账：一个动作，四处数字必须同时动
// ---------------------------------------------------------------------------
describe('D. 端到端对账（一条链路走完，四处口径同步）', () => {
  it('★★ 建单 → 提交 → 一级 → 二级 → 归档：列表 / 导出 / 统计 / 通知 同步 +1', async () => {
    const app = await makeApp()
    const t = await loginAll(app, ['admin', 'ops1', 'opsMgr', 'hr'])
    const applicant = api(app, t.ops1)
    const boss = api(app, t.admin)

    const snapshot = async () => ({
      list: (await boss.get('/api/requests')).body.total,
      csv: csvRows((await rawGet(app, t.admin, '/api/requests/export.csv')).text),
      stats: await statsTotal(boss, 'all'),
      approverUnread: (await api(app, t.opsMgr).get('/api/notifications/unread-count')).body.unread,
      applicantUnread: (await applicant.get('/api/notifications/unread-count')).body.unread,
    })

    const before = await snapshot()
    // 三处同源的口径在动作前就已经对齐（否则后面的 +1 没有意义）
    expect(before.list).toBe(before.csv)
    expect(before.list).toBe(before.stats)

    const created = await applicant.post('/api/requests', { type: 'leave', title: '端到端对账专用', formData: LEAVE_FORM })
    const id = created.body.id
    expect((await applicant.post(`/api/requests/${id}/submit`)).status).toBe(200)
    expect((await api(app, t.opsMgr).post(`/api/requests/${id}/approve`, { comment: '同意' })).status).toBe(200)
    expect((await api(app, t.hr).post(`/api/requests/${id}/approve`, { comment: '复核通过' })).status).toBe(200)

    const after = await snapshot()

    // ① 三个「看数据」的口径必须**同时** +1。任何一个没动，都说明它算的是别的东西
    expect(after.list).toBe(before.list + 1)
    expect(after.csv).toBe(before.csv + 1)
    expect(after.stats).toBe(before.stats + 1)

    // ② 单据真的归档了（不是靠数字猜的）
    const detail = await boss.get(`/api/requests/${id}`)
    expect(detail.body.status).toBe('approved')

    // ③ 两个「该收到通知的人」必须各收到，且都没多收
    expect(after.approverUnread).toBe(before.approverUnread + 1) // 「待你审批」
    expect(after.applicantUnread).toBe(before.applicantUnread + 1) // 「已通过」
  })
})
