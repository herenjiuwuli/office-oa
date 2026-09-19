// 统计报表（M6）
//
// 这一组的靶子不是「数字算得对不对」这一件事，而是两个：
//   ① 数据范围权限：聚合接口的越权面是「一批」—— 员工反复按状态请求就能拼出
//      全公司的组织画像，所以 scope 必须按身份收敛，且超出要 403（不能静默降级）
//   ② 数字与库里的事实一致：用 seed 里的已知单据断言具体值，而不是只断言 200
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { getDb } from '../server/db.js'
import { api, ID, login, makeApp, U } from './helpers.js'

describe('统计报表（M6）', () => {
  let app
  beforeEach(async () => {
    app = await makeApp()
  })
  afterEach(async () => {
    await app.close()
  })

  // ── 范围权限（核心）───────────────────────────────────────────
  test('★ 员工请求 scope=all → 403（不是静默降级 —— 降级会让错误结论无法察觉）', async () => {
    const c = api(app, await login(app, U.ops1)) // employee
    const res = await c.get('/api/stats/overview', { scope: 'all' })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain('all')
    expect(res.body.error).toContain('mine') // 提示里要说明你自己的最高范围
  })

  test('★ 经理可用 dept；请求 all 仍 → 403', async () => {
    const c = api(app, await login(app, U.opsMgr)) // dept_manager
    expect((await c.get('/api/stats/overview', { scope: 'dept' })).status).toBe(200)
    expect((await c.get('/api/stats/overview', { scope: 'all' })).status).toBe(403)
  })

  test('admin 有 request:read:all → scope=all 放行', async () => {
    const c = api(app, await login(app, U.admin))
    const res = await c.get('/api/stats/overview', { scope: 'all' })
    expect(res.status).toBe(200)
    expect(res.body.scope).toBe('all')
  })

  test('不传 scope 默认给「最高可用范围」，且响应里带 maxScope', async () => {
    const emp = api(app, await login(app, U.ops1))
    const r1 = await emp.get('/api/stats/overview')
    expect(r1.body.scope).toBe('mine')
    expect(r1.body.maxScope).toBe('mine')

    const mgr = api(app, await login(app, U.opsMgr))
    expect((await mgr.get('/api/stats/overview')).body.scope).toBe('dept')

    const hr = api(app, await login(app, U.hr)) // hr 有 request:read:all
    expect((await hr.get('/api/stats/overview')).body.scope).toBe('all')
  })

  test('非法 scope → 400', async () => {
    const c = api(app, await login(app, U.admin))
    expect((await c.get('/api/stats/overview', { scope: 'everyone' })).status).toBe(400)
  })

  test('未登录 → 401', async () => {
    expect((await api(app, null).get('/api/stats/overview')).status).toBe(401)
  })

  // ── 数字与事实一致（用 seed 的已知数据断言具体值）────────────────
  test('★ scope=all 的状态分布与库里的真实数据一致', async () => {
    const c = api(app, await login(app, U.admin))
    const res = await c.get('/api/stats/overview', { scope: 'all' })
    expect(res.status).toBe(200)

    // seed：1 张草稿、1 张审批中、1 张已通过
    expect(res.body.requests.byStatus.draft).toBe(1)
    expect(res.body.requests.byStatus.pending).toBe(1)
    expect(res.body.requests.byStatus.approved).toBe(1)
    expect(res.body.requests.total).toBe(3)

    // 分布之和 == total（自洽性：这类接口最容易被「各分项之和 ≠ 总数」打脸）
    const sum = Object.values(res.body.requests.byStatus).reduce((a, b) => a + b, 0)
    expect(sum).toBe(res.body.requests.total)
  })

  test('★ 范围真的在过滤：dept 只含本部门，mine 只含自己', async () => {
    const db = getDb()
    // seed 里 3 张单：2 张是内容运营部（dept 2：id 2 王东、id 4 赵西），1 张是人事李南（dept 4）
    const mgr = api(app, await login(app, U.opsMgr))
    const dept = await mgr.get('/api/stats/overview', { scope: 'dept' })
    expect(dept.body.requests.total).toBe(
      db.prepare(`SELECT COUNT(*) n FROM requests WHERE applicant_id IN (SELECT id FROM users WHERE dept_id = 2)`).get().n,
    )

    const emp = api(app, await login(app, U.ops1)) // id 4，提交过 1 张草稿
    const mine = await emp.get('/api/stats/overview', { scope: 'mine' })
    expect(mine.body.requests.total).toBe(1)
    expect(mine.body.requests.byStatus.draft).toBe(1)
  })

  test('审批效率：只有已归档的单参与平均，且带小数（未归档时是 null 不是 0）', async () => {
    const c = api(app, await login(app, U.admin))
    const res = await c.get('/api/stats/overview', { scope: 'all' })
    // seed 里只有 3 号单是 approved（提交 09-10，归档 09-11 → 有耗时可算）
    expect(res.body.efficiency.archivedCount).toBe(1)
    expect(res.body.efficiency.avgHours).toBeGreaterThan(0)
    // 一个没有任何 approved 单的员工 → null，前端显示「—」而不是假 0
    const emp = api(app, await login(app, U.ops1))
    const mine = await emp.get('/api/stats/overview', { scope: 'mine' })
    expect(mine.body.efficiency.archivedCount).toBe(0)
    expect(mine.body.efficiency.avgHours).toBeNull()
  })

  test('月度趋势：只统计提交过的单（草稿不进趋势），月份升序', async () => {
    const c = api(app, await login(app, U.admin))
    const res = await c.get('/api/stats/overview', { scope: 'all' })
    const totalInMonthly = res.body.monthly.reduce((a, m) => a + m.n, 0)
    // seed 有 submitted_at 的单是 2 张（2 号物料单、3 号请假单）
    expect(totalInMonthly).toBe(2)
    const yms = res.body.monthly.map((m) => m.ym)
    expect([...yms].sort()).toEqual(yms) // 升序
  })

  test('会议室统计跟着同一个 scope 走（预订 1 条后数字 +1）', async () => {
    const c = api(app, await login(app, U.ops1))
    const before = (await c.get('/api/stats/overview', { scope: 'mine' })).body.rooms.total

    const far = '2027-07-01'
    await c.post('/api/room-bookings', { roomId: 2, date: far, startTime: '09:00', endTime: '10:00', title: '统计测试会' })
    const after = (await c.get('/api/stats/overview', { scope: 'mine' })).body.rooms.total
    expect(after).toBe(before + 1)

    // 别人的 scope=mine 看不到这条
    const other = api(app, await login(app, U.ops2))
    const otherStats = await other.get('/api/stats/overview', { scope: 'mine' })
    const byRoomSum = otherStats.body.rooms.byRoom.reduce((a, r) => a + r.n, 0)
    expect(byRoomSum).toBe(otherStats.body.rooms.total)
  })
})
