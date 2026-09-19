// 考勤打卡（M7）
//
// 这一组的靶子有两个，和统计（M6）同源：
//   ① 打卡的幂等与边界：一天只能打一次上班/下班；下班必须先上班；缺卡不落行（用工作日减出来）
//   ② 数据范围权限：考勤是隐私，但「本部门谁老迟到」对经理是管理信息，
//      所以查询同样按 mine / dept / all 收敛，复用 request:read:all，越界 403 不降级
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { getDb } from '../server/db.js'
import { api, ID, login, makeApp, U } from './helpers.js'

// 用固定的「过去月份」造数：既远离「本月」的 seed 演示数据，又能让「应出勤 = 已过工作日」
// 走到「整月」这条分支（未来月份会截成 0，测不到数字一致）。
const MONTH = '2026-03'

describe('考勤打卡（M7）', () => {
  let app
  beforeEach(async () => {
    app = await makeApp()
  })
  afterEach(async () => {
    await app.close()
  })

  // 给 id4（ops1）造 6 条打卡：其中 2 条迟到
  function seedOps1() {
    const db = getDb()
    const rows = [
      ['2026-03-02', '09:02:11', 'normal'],
      ['2026-03-03', '09:02:11', 'normal'],
      ['2026-03-04', '10:15:00', 'late'],
      ['2026-03-05', '09:02:11', 'normal'],
      ['2026-03-09', '09:02:11', 'normal'],
      ['2026-03-10', '10:15:00', 'late'],
    ]
    const ins = db.prepare(
      `INSERT INTO attendance (user_id, date, clock_in, clock_out, status) VALUES (?, ?, ?, ?, ?)`,
    )
    for (const [date, cin, st] of rows) ins.run(ID.ops1, date, cin, '18:30:00', st)
  }

  // ── 打卡动作 ──────────────────────────────────────────────────
  test('★ 上班打卡 → 200，返回 clockIn 与状态', async () => {
    const c = api(app, await login(app, U.ops1))
    const res = await c.post('/api/attendance/clock', { type: 'in' })
    expect(res.status).toBe(200)
    expect(res.body.clockIn).not.toBeNull()
    expect(res.body.date).toBe(new Date().toISOString().slice(0, 10))
  })

  test('★ 重复打上班卡 → 409（UNIQUE(user_id, date) 挡住，不是插出第二行）', async () => {
    const c = api(app, await login(app, U.ops1))
    expect((await c.post('/api/attendance/clock', { type: 'in' })).status).toBe(200)
    expect((await c.post('/api/attendance/clock', { type: 'in' })).status).toBe(409)
  })

  test('下班卡必须先有上班卡 → 400', async () => {
    const c = api(app, await login(app, U.ops1))
    expect((await c.post('/api/attendance/clock', { type: 'out' })).status).toBe(400)
  })

  test('先上班再下班 → 200，clockOut 被填', async () => {
    const c = api(app, await login(app, U.ops1))
    await c.post('/api/attendance/clock', { type: 'in' })
    const res = await c.post('/api/attendance/clock', { type: 'out' })
    expect(res.status).toBe(200)
    expect(res.body.clockOut).not.toBeNull()
  })

  test('重复打下班卡 → 409', async () => {
    const c = api(app, await login(app, U.ops1))
    await c.post('/api/attendance/clock', { type: 'in' })
    await c.post('/api/attendance/clock', { type: 'out' })
    expect((await c.post('/api/attendance/clock', { type: 'out' })).status).toBe(409)
  })

  test('非法 type → 400', async () => {
    const c = api(app, await login(app, U.ops1))
    expect((await c.post('/api/attendance/clock', { type: 'noon' })).status).toBe(400)
  })

  test('未登录打卡 → 401', async () => {
    expect((await api(app, null).post('/api/attendance/clock', { type: 'in' })).status).toBe(401)
  })

  // ── 本人记录 ──────────────────────────────────────────────────
  test('★ 本人记录只含自己，且按日期倒序', async () => {
    seedOps1()
    const c = api(app, await login(app, U.ops1))
    const res = await c.get('/api/attendance/me', { month: MONTH })
    expect(res.status).toBe(200)
    expect(res.body.items.length).toBe(6)
    expect(res.body.items[0].date >= res.body.items[1].date).toBe(true)
    // 迟到那条 status 真的是 late
    expect(res.body.items.find((i) => i.date === '2026-03-04').status).toBe('late')
    expect(res.body.items.find((i) => i.date === '2026-03-02').status).toBe('normal')
  })

  test('他人看不到我的记录（me 按 ctx.user 锁死）', async () => {
    seedOps1()
    const other = api(app, await login(app, U.ops2))
    const res = await other.get('/api/attendance/me', { month: MONTH })
    expect(res.body.items.length).toBe(0) // 没给 ops2 造数
  })

  // ── 统计范围权限（核心）────────────────────────────────────────
  test('★ 员工请求 scope=all → 403（不静默降级）', async () => {
    const c = api(app, await login(app, U.ops1))
    const res = await c.get('/api/attendance/overview', { scope: 'all' })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain('mine')
  })

  test('经理可用 dept；请求 all 仍 → 403', async () => {
    const c = api(app, await login(app, U.opsMgr))
    expect((await c.get('/api/attendance/overview', { scope: 'dept' })).status).toBe(200)
    expect((await c.get('/api/attendance/overview', { scope: 'all' })).status).toBe(403)
  })

  test('admin 有 request:read:all → scope=all 放行', async () => {
    const c = api(app, await login(app, U.admin))
    const res = await c.get('/api/attendance/overview', { scope: 'all' })
    expect(res.status).toBe(200)
    expect(res.body.scope).toBe('all')
  })

  test('不传 scope 默认给最高可用范围，且带 maxScope', async () => {
    const emp = api(app, await login(app, U.ops1))
    expect((await emp.get('/api/attendance/overview')).body.scope).toBe('mine')
    const mgr = api(app, await login(app, U.opsMgr))
    expect((await mgr.get('/api/attendance/overview')).body.scope).toBe('dept')
  })

  test('非法 scope → 400；非法 month → 400', async () => {
    const c = api(app, await login(app, U.admin))
    expect((await c.get('/api/attendance/overview', { scope: 'x' })).status).toBe(400)
    expect((await c.get('/api/attendance/overview', { month: '2027-13' })).status).toBe(400)
  })

  test('未登录 → 401', async () => {
    expect((await api(app, null).get('/api/attendance/overview')).status).toBe(401)
  })

  // ── 数字与事实一致 ────────────────────────────────────────────
  test('★ mine 的统计与库里自己真实打卡数一致（迟到/缺卡都算对）', async () => {
    seedOps1()
    const c = api(app, await login(app, U.ops1))
    const res = await c.get('/api/attendance/overview', { scope: 'mine', month: MONTH })
    expect(res.status).toBe(200)
    expect(res.body.summary.recordedDays).toBe(6)
    expect(res.body.summary.lateDays).toBe(2)
    // 缺卡 = 工作日 - 有上班卡的天数（非负），且 self-consistent
    expect(res.body.summary.absentDays).toBe(res.body.workingDays - 6)
    expect(res.body.summary.absentDays).toBeGreaterThanOrEqual(0)
    // 只看自己时 perUser 为空（冗余）
    expect(res.body.perUser).toEqual([])
  })

  test('★ 范围真的过滤：dept 只含本部门，all 含全公司，且分项之和 == 汇总', async () => {
    seedOps1() // 只给 id4（内容运营部 dept 2）造数
    const db = getDb()
    const mgr = api(app, await login(app, U.opsMgr)) // 内容运营经理，管 dept 2
    const dept = await mgr.get('/api/attendance/overview', { scope: 'dept', month: MONTH })

    // dept 2 下的用户 = id3(经理自己) + id4 + id5；只有 id4 有打卡 → 汇总 recordedDays = 6
    const expectDeptUsers = db.prepare(`SELECT COUNT(*) n FROM users WHERE dept_id = 2`).get().n
    expect(dept.body.perUser.length).toBe(expectDeptUsers)
    expect(dept.body.summary.recordedDays).toBe(6)
    expect(dept.body.summary.lateDays).toBe(2)

    // 分项之和 == 汇总（这类聚合接口最容易被「各人之和 ≠ 总数」打脸）
    const sum = dept.body.perUser.reduce((a, u) => a + u.recordedDays, 0)
    expect(sum).toBe(dept.body.summary.recordedDays)

    // admin 看全公司：perUser 含全部用户，汇总仍只有 id4 的 6 天
    const admin = api(app, await login(app, U.admin))
    const all = await admin.get('/api/attendance/overview', { scope: 'all', month: MONTH })
    expect(all.body.perUser.length).toBe(db.prepare(`SELECT COUNT(*) n FROM users`).get().n)
    expect(all.body.summary.recordedDays).toBe(6)
  })

  test('★ 没有打卡的「过去月份」：recordedDays=0，缺卡=整月工作日（>0）', async () => {
    const c = api(app, await login(app, U.ops1))
    const res = await c.get('/api/attendance/overview', { scope: 'mine', month: '2026-02' })
    expect(res.body.summary.recordedDays).toBe(0)
    expect(res.body.summary.lateDays).toBe(0)
    // 过去的月份，整月工作日已经全部过去 → 缺卡 = 整月工作日
    expect(res.body.workingDays).toBeGreaterThan(0)
    expect(res.body.summary.absentDays).toBe(res.body.workingDays)
  })

  test('★ 应出勤只算「已经过去」的工作日——未来的天不能凭空变成缺卡', async () => {
    // 这条守的是真缺陷：overview 一开始把「整月工作日」当分母，
    // 月中打开看板时 9/20 之后的未来工作日也被算成应出勤，全公司缺卡直接飙到 163 天。
    const admin = api(app, await login(app, U.admin))
    const now = new Date().toISOString().slice(0, 7)
    const cur = await admin.get('/api/attendance/overview', { scope: 'all', month: now })
    expect(cur.status).toBe(200)

    // 本月：应出勤 = 截至今天已过的工作日，严格小于整月工作日（除非今天正好是月末最后一个工作日）
    const [y, m] = now.split('-').map(Number)
    let wholeMonth = 0
    for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) {
      const wd = new Date(y, m - 1, d).getDay()
      if (wd >= 1 && wd <= 5) wholeMonth++
    }
    expect(cur.body.workingDays).toBeLessThanOrEqual(wholeMonth)
    const todayDom = Number(new Date().toISOString().slice(8, 10))
    const isMonthEnd = todayDom >= new Date(y, m, 0).getDate() - 2 // 容错：月末最后几天可能相等
    if (!isMonthEnd) expect(cur.body.workingDays).toBeLessThan(wholeMonth)

    // 未来月份：一天都还没过去 → 应出勤 0，缺卡 0（不能凭空造欠勤）
    const future = await admin.get('/api/attendance/overview', { scope: 'all', month: '2030-06' })
    expect(future.body.workingDays).toBe(0)
    expect(future.body.summary.absentDays).toBe(0)
  })
})
