// 会议室预订（M5）
//
// ★ 这一节的看点不是「又一个 CRUD」，而是**时段冲突怎么防**。
//
// 直觉做法是「先查有没有重叠，没有再插」。它看起来对，实际上有个窗口：
// 「查」和「插」是两步，中间只要有 await、多进程、或将来冒出第二个写入口，
// 两个人就能同时通过检查、各插一条。而且这种 bug 只在并发下出现，单测很难撞上。
//
// 这里的做法是**把冲突下沉到数据库**：
//   ① 时间一律折算成 30 分钟槽序号（08:00 → 16），预订就是把 [start,end) 里
//      每个槽往 `room_slots` 插一行；
//   ② `room_slots` 的主键是 (room_id, date, slot) —— 同一个槽插第二行必然撞
//      UNIQUE，由 SQLite 判定，不经过应用层的「判断」；
//   ③ 整件事在一个 `BEGIN IMMEDIATE` 事务里：要么全插进去，要么一条都不留
//      （不会出现「订到了一半」的半成品）；
//   ④ 撞唯一约束 → 查出来是哪条预订占着 → 409 并告诉客户端「谁、占了几点的哪间」。
//
// ⭐ 一句话：**并发防线放在离数据最近的地方。应用层的检查可以绕过，唯一约束绕不过。**
//
// 明确不做的（写下来是为了别的人别当成 bug）：
//   · 不支持跨天预订（22:00–次日 02:00 不收）—— 跨天会让「同一天」这个坐标失效；
//   · 不支持循环预订（每周三固定开会）—— 那是另一套 recurrence 模型；
//   · 不支持「预订需审批」—— 本项目里审批流的主战场是 requests，会议室保持轻量。

import { getDb } from '../db.js'
import { badRequest, conflict, forbidden, handler, notFound } from '../errors.js'
import { hasPerm, requirePerm } from '../permissions.js'
import { logAction } from '../audit.js'

// ── 时间坐标 ────────────────────────────────────────────────────
// 槽序号 = 距 00:00 经过的 30 分钟个数。可预订窗口 08:00–22:00。
export const SLOT_MIN = 16 // 08:00
export const SLOT_MAX = 44 // 22:00（最后一个可预订槽是 43 = 21:30–22:00）
const MAX_SPAN = 8 // 单次最多 4 小时，防一个人占满一整天

/** 'HH:MM' → 槽序号；格式不对或没对齐到 30 分钟抛 400 */
function toSlot(hhmm, label) {
  if (typeof hhmm !== 'string' || !/^\d{2}:\d{2}$/.test(hhmm)) {
    throw badRequest(`${label} 必须是 HH:MM，例如 09:30`)
  }
  const [h, m] = hhmm.split(':').map(Number)
  if (h > 23 || m > 59) throw badRequest(`${label} 不是合法时间`)
  if (m !== 0 && m !== 30) throw badRequest(`${label} 必须对齐到整点或半点（如 09:00 / 09:30）`)
  return h * 2 + (m === 30 ? 1 : 0)
}

/** 槽序号 → 'HH:MM' */
function fromSlot(slot) {
  const h = Math.floor(slot / 2)
  const m = slot % 2 === 1 ? 30 : 0
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 校验日期串：既要形如 YYYY-MM-DD，也要是真实存在的一天（2026-02-30 要拒） */
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw badRequest('date 必须是 YYYY-MM-DD')
  }
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || !d.toISOString().startsWith(s)) {
    throw badRequest(`date 不是一个真实的日期：${s}`)
  }
  return s
}

/** 取「本地现在」的 YYYY-MM-DD（与 SQLite 的 datetime('now') 同为 UTC，统一用本地字符串即可） */
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── 序列化：一条预订对外长什么样，只有这一个地方说了算 ──────────────
function serializeBooking(b) {
  return {
    id: b.id,
    roomId: b.room_id,
    roomName: b.room_name,
    userId: b.user_id,
    userName: b.user_name,
    date: b.date,
    startSlot: b.start_slot,
    endSlot: b.end_slot,
    startTime: fromSlot(b.start_slot),
    endTime: fromSlot(b.end_slot),
    title: b.title,
    status: b.status,
    createdAt: b.created_at,
    cancelledAt: b.cancelled_at,
    // 前端要判断「能不能取消」：与其把权限逻辑抄一份到前端，不如后端直接给结论
    ...(b.canCancel !== undefined ? { canCancel: !!b.canCancel } : {}),
  }
}

const BOOKING_SELECT = `
  SELECT b.*, r.name AS room_name, u.real_name AS user_name
    FROM room_bookings b
    JOIN meeting_rooms r ON r.id = b.room_id
    JOIN users u ON u.id = b.user_id`

export default async function meetingRoutes(app) {
  // ── 会议室列表 ────────────────────────────────────────────────
  // 不设权限：谁都得看得见会议室，否则没法避开别人的预订。
  app.get(
    '/api/meeting-rooms',
    handler(async () => {
      const items = getDb()
        .prepare(
          // 停用房排最后（不能按 status 字符串排：'disabled' 字母序在 'active' 前面，会顶到第一排）
          `SELECT id, name, location, capacity, status, created_at
             FROM meeting_rooms
            ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name`,
        )
        .all()
        .map((r) => ({
          id: r.id,
          name: r.name,
          location: r.location,
          capacity: r.capacity,
          status: r.status,
          disabled: r.status !== 'active',
          createdAt: r.created_at,
        }))
      return { items, total: items.length }
    }),
  )

  // ── 新增会议室（room:manage）──────────────────────────────────
  app.post(
    '/api/meeting-rooms',
    { preHandler: requirePerm('room:manage') },
    handler(async (req, reply) => {
      const { name, location = '', capacity = 10 } = req.body || {}
      if (typeof name !== 'string' || !name.trim()) throw badRequest('会议室名称必填')
      if (name.trim().length > 40) throw badRequest('会议室名称不能超过 40 个字')
      const cap = Number(capacity)
      if (!Number.isInteger(cap) || cap < 1 || cap > 500) throw badRequest('容纳人数必须是 1–500 的整数')

      const exists = getDb().prepare(`SELECT id FROM meeting_rooms WHERE name = ?`).get(name.trim())
      if (exists) throw conflict(`已存在同名会议室：${name.trim()}`)

      const info = getDb()
        .prepare(`INSERT INTO meeting_rooms (name, location, capacity) VALUES (?, ?, ?)`)
        .run(name.trim(), String(location || '').slice(0, 80), cap)
      logAction({
        userId: req.userId,
        action: 'room.create',
        targetType: 'meeting_room',
        targetId: info.lastInsertRowid,
        detail: name.trim(),
      })
      return reply.code(201).send({ id: info.lastInsertRowid, name: name.trim(), capacity: cap })
    }),
  )

  // ── 停用 / 启用会议室（room:manage）─────────────────────────────
  // 停用后**已有的预订不受影响**（历史要留痕），只是不能再新订 —— 这是刻意的选择：
  // 删掉别人已订好的会，等于无声地毁约。
  app.patch(
    '/api/meeting-rooms/:id/status',
    { preHandler: requirePerm('room:manage') },
    handler(async (req) => {
      const id = Number(req.params.id)
      const { status } = req.body || {}
      if (status !== 'active' && status !== 'disabled') throw badRequest('status 只能是 active 或 disabled')
      const room = getDb().prepare(`SELECT * FROM meeting_rooms WHERE id = ?`).get(id)
      if (!room) throw notFound('会议室不存在')
      getDb().prepare(`UPDATE meeting_rooms SET status = ? WHERE id = ?`).run(status, id)
      logAction({
        userId: req.userId,
        action: status === 'active' ? 'room.enable' : 'room.disable',
        targetType: 'meeting_room',
        targetId: id,
        detail: room.name,
      })
      return { id, status }
    }),
  )

  // ── 某一天的预订（默认今天）───────────────────────────────────
  // 不设权限：会议室是公共资源，看不见别人的预订就没法避让。
  app.get(
    '/api/room-bookings',
    handler(async (req) => {
      const date = req.query?.date ? parseDate(req.query.date) : todayStr()
      const roomId = req.query?.roomId ? Number(req.query.roomId) : null
      if (roomId !== null && !Number.isInteger(roomId)) throw badRequest('roomId 必须是整数')

      // 只返回还有效的（status='booked'）。取消的记录留着（审计要查），但不当作占用。
      const where = [`b.date = ?`, `b.status = 'booked'`]
      const args = [date]
      if (roomId !== null) {
        where.push(`b.room_id = ?`)
        args.push(roomId)
      }
      const rows = getDb()
        .prepare(`${BOOKING_SELECT} WHERE ${where.join(' AND ')} ORDER BY b.room_id, b.start_slot`)
        .all(...args)

      const items = rows.map((b) =>
        serializeBooking({ ...b, canCancel: b.user_id === req.ctx.user.id || hasPerm(req.ctx, 'room:manage') }),
      )
      return { date, items, total: items.length }
    }),
  )

  // ── 预订 ──────────────────────────────────────────────────────
  app.post(
    '/api/room-bookings',
    handler(async (req, reply) => {
      const { roomId, date, startTime, endTime, title } = req.body || {}
      const db = getDb()

      const rid = Number(roomId)
      if (!Number.isInteger(rid)) throw badRequest('roomId 必填且必须是整数')
      const room = db.prepare(`SELECT * FROM meeting_rooms WHERE id = ?`).get(rid)
      if (!room) throw notFound('会议室不存在')
      if (room.status !== 'active') throw badRequest(`会议室「${room.name}」已停用，不能预订`)

      const d = parseDate(date)
      const s = toSlot(startTime, 'startTime')
      const e = toSlot(endTime, 'endTime')
      if (e <= s) throw badRequest('结束时间必须晚于开始时间')
      if (s < SLOT_MIN || e > SLOT_MAX) {
        throw badRequest(`可预订时段是 ${fromSlot(SLOT_MIN)}–${fromSlot(SLOT_MAX)}`)
      }
      if (e - s > MAX_SPAN) throw badRequest(`单次预订不能超过 ${MAX_SPAN / 2} 小时`)

      const t = String(title || '').trim()
      if (!t) throw badRequest('会议主题必填')
      if (t.length > 60) throw badRequest('会议主题不能超过 60 个字')

      // 不能预订已经过去的时段：拿「今天」和「现在这个槽」比
      const now = new Date()
      const nowSlot = now.getHours() * 2 + (now.getMinutes() >= 30 ? 1 : 0)
      if (d < todayStr() || (d === todayStr() && s < nowSlot)) {
        throw badRequest('不能预订已经过去的时段')
      }

      // ★ 事务：插预订 + 插占用槽，要么全成要么全回滚。
      //   BEGIN IMMEDIATE 立刻拿写锁，避免读到别人尚未提交的中间状态。
      let bookingId
      db.exec('BEGIN IMMEDIATE')
      try {
        const info = db
          .prepare(
            `INSERT INTO room_bookings (room_id, user_id, date, start_slot, end_slot, title)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(rid, req.ctx.user.id, d, s, e, t)
        bookingId = info.lastInsertRowid

        const insSlot = db.prepare(
          `INSERT INTO room_slots (room_id, date, slot, booking_id) VALUES (?, ?, ?, ?)`,
        )
        for (let slot = s; slot < e; slot++) {
          insSlot.run(rid, d, slot, bookingId)
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        // 唯一约束被撞 = 时段冲突（SQLite 的报错里带 UNIQUE 关键字）
        if (String(err?.message || '').includes('UNIQUE')) {
          // 查出是谁占着，好让前端能说清楚「不是系统不让你订，是这个时段已经有人了」
          const clash = db
            .prepare(
              `SELECT b.id, b.title, b.start_slot, b.end_slot, u.real_name AS user_name
                 FROM room_slots s
                 JOIN room_bookings b ON b.id = s.booking_id
                 JOIN users u ON u.id = b.user_id
                WHERE s.room_id = ? AND s.date = ? AND s.slot >= ? AND s.slot < ? AND b.status = 'booked'
                ORDER BY s.slot LIMIT 1`,
            )
            .get(rid, d, s, e)
          if (clash) {
            throw conflict(
              `该时段已被占用：${fromSlot(clash.start_slot)}–${fromSlot(clash.end_slot)}`
                + `「${clash.title}」（${clash.user_name}预订）`,
            )
          }
          throw conflict('该时段已被占用')
        }
        throw err
      }

      logAction({
        userId: req.userId,
        action: 'room.booking.create',
        targetType: 'room_booking',
        targetId: bookingId,
        detail: `${room.name} ${d} ${fromSlot(s)}-${fromSlot(e)} ${t}`,
      })

      const row = db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(bookingId)
      return reply.code(201).send(serializeBooking({ ...row, canCancel: true }))
    }),
  )

  // ── 取消预订 ──────────────────────────────────────────────────
  // 横向越权面：只能取消自己的，除非有 room:manage。
  app.delete(
    '/api/room-bookings/:id',
    handler(async (req) => {
      const id = Number(req.params.id)
      const db = getDb()
      const b = db.prepare(`SELECT * FROM room_bookings WHERE id = ?`).get(id)
      if (!b) throw notFound('预订不存在')

      const isOwner = b.user_id === req.ctx.user.id
      const isManager = hasPerm(req.ctx, 'room:manage')
      if (!isOwner && !isManager) throw forbidden('只能取消自己的预订')

      // 幂等的反面：重复取消要报错，别假装成功 —— 静默成功会掩盖「我到底取消了没」
      if (b.status === 'cancelled') throw conflict('这条预订已经取消过了')

      // 事务：清占用槽 + 标状态。释放槽位后，同一时段可以被别人重新预订（有测试证明）
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`DELETE FROM room_slots WHERE booking_id = ?`).run(id)
        db.prepare(
          `UPDATE room_bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?`,
        ).run(id)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }

      logAction({
        userId: req.userId,
        action: 'room.booking.cancel',
        targetType: 'room_booking',
        targetId: id,
        detail: isOwner ? '本人取消' : '管理员代取消',
      })
      return { id, status: 'cancelled' }
    }),
  )
}
