// 会议室预订（M5）
//
// 这一组的重点不是「能订会议室」，而是**时段冲突的防线在哪一层**。
// 最有价值的两条用例：
//   ① 同一时段订两次 → 第二次 409，且 room_slots 里**没有多出一行**（没有脏占用）
//   ② 绕过应用层直接往 room_slots 插冲突行 → **数据库**报 UNIQUE
//      （证明防线在数据库，不在「先查再插」的应用层判断里）
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { getDb } from '../server/db.js'
import { api, ID, login, makeApp, U } from './helpers.js'

/** 明天：预订不能落在过去，所以一律用明天 */
function tomorrow() {
  const d = new Date(Date.now() + 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** 后天：避开种子里「明天」已有的 3 条示例预订，免得用例撞上种子数据 */
function dayAfterTomorrow() {
  const d = new Date(Date.now() + 2 * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const D = tomorrow()
const D2 = dayAfterTomorrow()

describe('会议室预订（M5）', () => {
  let app
  beforeEach(async () => {
    app = await makeApp()
  })
  afterEach(async () => {
    await app.close()
  })

  // ── 基础 ──────────────────────────────────────────────────────
  test('会议室列表：停用房排最后且带 disabled 标记', async () => {
    const res = await api(app, await login(app, U.ops1)).get('/api/meeting-rooms')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(4)
    const disabled = res.body.items.filter((r) => r.disabled)
    expect(disabled).toHaveLength(1)
    // 停用的必须排在最后
    expect(res.body.items[res.body.items.length - 1].disabled).toBe(true)
  })

  test('普通员工也能看会议室与预订（公共资源的可见性不该被权限挡）', async () => {
    const c = api(app, await login(app, U.ops1)) // employee，无 room:manage
    expect((await c.get('/api/meeting-rooms')).status).toBe(200)
    expect((await c.get('/api/room-bookings', { date: D })).status).toBe(200)
  })

  test('预订成功 → 201，返回可读时段 + 占用槽数与时长一致', async () => {
    const c = api(app, await login(app, U.ops1))
    const res = await c.post('/api/room-bookings', {
      roomId: 1, date: D2, startTime: '14:00', endTime: '15:00', title: '周会',
    })
    expect(res.status).toBe(201)
    expect(res.body.startTime).toBe('14:00')
    expect(res.body.endTime).toBe('15:00')
    expect(res.body.canCancel).toBe(true)

    // 14:00-15:00 = 2 个槽
    const slots = getDb()
      .prepare(`SELECT COUNT(*) n FROM room_slots WHERE booking_id = ?`)
      .get(res.body.id).n
    expect(slots).toBe(2)
  })

  // ── 冲突（核心）────────────────────────────────────────────────
  test('★ 同一时段订两次 → 第二次 409，且不留下多余占用槽', async () => {
    const c = api(app, await login(app, U.ops1))
    const first = await c.post('/api/room-bookings', {
      roomId: 2, date: D2, startTime: '09:00', endTime: '10:00', title: '我的会',
    })
    expect(first.status).toBe(201)

    const second = await c.post('/api/room-bookings', {
      roomId: 2, date: D2, startTime: '09:00', endTime: '10:00', title: '抢占',
    })
    expect(second.status).toBe(409)
    // 错误信息要能告诉用户「是谁占了哪一段」，而不是干巴巴一句「冲突」
    expect(second.body.error).toContain('已被占用')
    expect(second.body.error).toContain('我的会')

    const still = getDb().prepare(`SELECT COUNT(*) n FROM room_slots WHERE room_id = 2 AND date = ?`).get(D2).n
    expect(still).toBe(2) // 只有第一次那 2 个槽，第二次没插进任何东西
  })

  test('★ 部分重叠也算冲突（09:30-10:30 撞上 09:00-10:00）', async () => {
    const c = api(app, await login(app, U.ops1))
    await c.post('/api/room-bookings', { roomId: 2, date: D2, startTime: '09:00', endTime: '10:00', title: '占坑' })
    const clash = await c.post('/api/room-bookings', { roomId: 2, date: D2, startTime: '09:30', endTime: '10:30', title: '半个重叠' })
    expect(clash.status).toBe(409)
  })

  test('★ 防线在数据库：绕过应用层直接插冲突槽 → UNIQUE 报错', async () => {
    const db = getDb()
    const c = api(app, await login(app, U.ops1))
    const b = await c.post('/api/room-bookings', { roomId: 2, date: D2, startTime: '09:00', endTime: '10:00', title: '占坑' })
    expect(b.status).toBe(201)

    // 模拟「有人绕过 API 直接写库」：拿另一个 booking_id 硬插**已被占用的那一个槽**
    // （第一次预订是 09:00-10:00 → 占用槽 18、19）
    const other = db
      .prepare(`INSERT INTO room_bookings (room_id, user_id, date, start_slot, end_slot, title) VALUES (2, ?, ?, 18, 19, '绕过')`)
      .run(ID.ops1, D2).lastInsertRowid
    expect(() => {
      db.prepare(`INSERT INTO room_slots (room_id, date, slot, booking_id) VALUES (2, ?, 18, ?)`).run(D2, other)
    }).toThrow(/UNIQUE/i)
  })

  test('取消后同一时段可以重新预订（槽位真的被释放了）', async () => {
    const c = api(app, await login(app, U.ops1))
    const b = await c.post('/api/room-bookings', { roomId: 3, date: D2, startTime: '16:00', endTime: '16:30', title: '先订了' })
    expect(b.status).toBe(201)

    const cancel = await c.del(`/api/room-bookings/${b.body.id}`)
    expect(cancel.status).toBe(200)

    const slots = getDb().prepare(`SELECT COUNT(*) n FROM room_slots WHERE booking_id = ?`).get(b.body.id).n
    expect(slots).toBe(0)

    const again = await c.post('/api/room-bookings', { roomId: 3, date: D2, startTime: '16:00', endTime: '16:30', title: '别人订' })
    expect(again.status).toBe(201)
  })

  // ── 越权 ──────────────────────────────────────────────────────
  test('★ 横向越权：取消别人的预订 → 403', async () => {
    const mine = api(app, await login(app, U.ops1))
    const b = await mine.post('/api/room-bookings', { roomId: 3, date: D2, startTime: '11:00', endTime: '11:30', title: '我的' })
    expect(b.status).toBe(201)

    const other = api(app, await login(app, U.ops2)) // 另一个普通员工
    const res = await other.del(`/api/room-bookings/${b.body.id}`)
    expect(res.status).toBe(403)
    // 真的没被取消
    expect(getDb().prepare(`SELECT status FROM room_bookings WHERE id = ?`).get(b.body.id).status).toBe('booked')
  })

  test('管理员（room:manage）可以代取消别人的预订', async () => {
    const mine = api(app, await login(app, U.ops1))
    const b = await mine.post('/api/room-bookings', { roomId: 3, date: D2, startTime: '13:00', endTime: '13:30', title: '我的' })

    const hr = api(app, await login(app, U.hr)) // hr 有 room:manage
    expect((await hr.del(`/api/room-bookings/${b.body.id}`)).status).toBe(200)
  })

  test('列表里 canCancel 由后端给结论：自己的 true、别人的 false', async () => {
    const mine = api(app, await login(app, U.ops1))
    await mine.post('/api/room-bookings', { roomId: 3, date: D2, startTime: '11:00', endTime: '11:30', title: '我的' })

    const other = api(app, await login(app, U.ops2))
    const list = await other.get('/api/room-bookings', { date: D2 })
    const mineRow = list.body.items.find((b) => b.title === '我的')
    expect(mineRow.canCancel).toBe(false)
  })

  test('无 room:manage 的人不能新建/停用会议室', async () => {
    const c = api(app, await login(app, U.ops1))
    expect((await c.post('/api/meeting-rooms', { name: '私自加的房', capacity: 5 })).status).toBe(403)
    expect((await c.patch('/api/meeting-rooms/1/status', { status: 'disabled' })).status).toBe(403)
  })

  // ── 边界 ──────────────────────────────────────────────────────
  test('时间必须对齐到整点/半点（09:15 不收）', async () => {
    const c = api(app, await login(app, U.ops1))
    const res = await c.post('/api/room-bookings', { roomId: 1, date: D2, startTime: '09:15', endTime: '10:00', title: '不对齐' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('整点或半点')
  })

  test('结束早于/等于开始 → 400', async () => {
    const c = api(app, await login(app, U.ops1))
    expect((await c.post('/api/room-bookings', { roomId: 1, date: D2, startTime: '10:00', endTime: '09:00', title: '倒着' })).status).toBe(400)
    expect((await c.post('/api/room-bookings', { roomId: 1, date: D2, startTime: '10:00', endTime: '10:00', title: '零长' })).status).toBe(400)
  })

  test('超出可预订窗口（07:00 或 23:00）→ 400', async () => {
    const c = api(app, await login(app, U.ops1))
    expect((await c.post('/api/room-bookings', { roomId: 1, date: D2, startTime: '07:00', endTime: '08:00', title: '太早' })).status).toBe(400)
    expect((await c.post('/api/room-bookings', { roomId: 1, date: D2, startTime: '21:30', endTime: '23:00', title: '太晚' })).status).toBe(400)
  })

  test('单次超过 4 小时 → 400（防一个人占满一整天）', async () => {
    const c = api(app, await login(app, U.ops1))
    const res = await c.post('/api/room-bookings', { roomId: 1, date: D2, startTime: '08:00', endTime: '13:00', title: '占半天' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('4 小时')
  })

  test('不能预订过去的时段', async () => {
    const c = api(app, await login(app, U.ops1))
    expect((await c.post('/api/room-bookings', { roomId: 1, date: '2020-01-01', startTime: '09:00', endTime: '10:00', title: '穿越' })).status).toBe(400)
  })

  test('不存在的日期（2026-02-30）→ 400（光看格式不够，还得是真的一天）', async () => {
    const c = api(app, await login(app, U.ops1))
    expect((await c.post('/api/room-bookings', { roomId: 1, date: '2026-02-30', startTime: '09:00', endTime: '10:00', title: '假日期' })).status).toBe(400)
  })

  test('停用的会议室不能预订（但历史预订不受影响）', async () => {
    const c = api(app, await login(app, U.ops1))
    const res = await c.post('/api/room-bookings', { roomId: 4, date: D2, startTime: '09:00', endTime: '10:00', title: '订停用房' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('停用')
  })

  test('重复取消 → 409（不假成功，否则掩盖「到底取消没」）', async () => {
    const c = api(app, await login(app, U.ops1))
    const b = await c.post('/api/room-bookings', { roomId: 3, date: D2, startTime: '15:00', endTime: '15:30', title: '取消两次' })
    expect((await c.del(`/api/room-bookings/${b.body.id}`)).status).toBe(200)
    expect((await c.del(`/api/room-bookings/${b.body.id}`)).status).toBe(409)
  })

  test('预订不存在的会议室 → 404；取消不存在的预订 → 404', async () => {
    const c = api(app, await login(app, U.ops1))
    expect((await c.post('/api/room-bookings', { roomId: 999, date: D2, startTime: '09:00', endTime: '10:00', title: '无此房' })).status).toBe(404)
    expect((await c.del('/api/room-bookings/999')).status).toBe(404)
  })

  test('主题必填且不能超长', async () => {
    const c = api(app, await login(app, U.ops1))
    expect((await c.post('/api/room-bookings', { roomId: 1, date: D2, startTime: '09:00', endTime: '10:00', title: '   ' })).status).toBe(400)
    expect((await c.post('/api/room-bookings', { roomId: 1, date: D2, startTime: '09:00', endTime: '10:00', title: 'x'.repeat(61) })).status).toBe(400)
  })

  test('未登录不能预订', async () => {
    const c = api(app, null)
    expect((await c.post('/api/room-bookings', { roomId: 1, date: D2, startTime: '09:00', endTime: '10:00', title: '匿名' })).status).toBe(401)
  })

  // ── 管理侧 ────────────────────────────────────────────────────
  test('hr 新建会议室 → 201；重名 → 409', async () => {
    const c = api(app, await login(app, U.hr))
    const created = await c.post('/api/meeting-rooms', { name: '新洽谈室', location: '5 楼 501', capacity: 8 })
    expect(created.status).toBe(201)
    expect((await c.post('/api/meeting-rooms', { name: '新洽谈室', capacity: 8 })).status).toBe(409)
  })

  test('停用会议室后不能再订；重新启用后可以', async () => {
    const hr = api(app, await login(app, U.hr))
    const c = api(app, await login(app, U.ops1))
    expect((await hr.patch('/api/meeting-rooms/2/status', { status: 'disabled' })).status).toBe(200)
    expect((await c.post('/api/room-bookings', { roomId: 2, date: D2, startTime: '09:00', endTime: '10:00', title: '订停用房' })).status).toBe(400)
    expect((await hr.patch('/api/meeting-rooms/2/status', { status: 'active' })).status).toBe(200)
    expect((await c.post('/api/room-bookings', { roomId: 2, date: D2, startTime: '09:00', endTime: '10:00', title: '启用了再订' })).status).toBe(201)
  })

  test('预订与取消都进审计日志', async () => {
    const c = api(app, await login(app, U.ops1))
    const b = await c.post('/api/room-bookings', { roomId: 3, date: D2, startTime: '17:00', endTime: '17:30', title: '留痕测试' })
    await c.del(`/api/room-bookings/${b.body.id}`)

    const acts = getDb()
      .prepare(`SELECT action FROM audit_logs WHERE target_type = 'room_booking' ORDER BY id`)
      .all()
      .map((r) => r.action)
    expect(acts).toEqual(['room.booking.create', 'room.booking.cancel'])
  })
})
