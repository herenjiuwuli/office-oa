// 考勤打卡（M7）
//
// ★ 这一节的靶子同样是**数据范围权限**，和 M6 统计是同一个故事：
// 一个人的打卡记录是个人隐私，但「本部门谁经常迟到、谁老缺卡」对经理是管理信息。
// 所以查询同样按 mine / dept / all 收敛，复用 request:read:all，越界 403 不降级。
//
// 打卡本身很简单（上班 / 下班，本人当天），但有两处「坑」是写测试时才会注意到的：
//   1. UNIQUE(user_id, date) 挡住「一天打两次上班卡」—— 重复打卡变成更新同一行，不是插第二行；
//   2. 缺卡(absent)不在表里落行：当天没有任何记录就是缺卡，overview 用
//      「已经过去的工作日 − 有上班卡的天数」算出来。否则「今天还没过完，系统就给你贴 absent」是错的；
//      而且「已经过去」必须按到**今天**为止——月中把未来工作日也算进去，就会凭空造出一堆缺卡。

import { getDb } from '../db.js'
import { badRequest, conflict, forbidden, handler } from '../errors.js'
import { hasPerm } from '../permissions.js'

// 上班晚于这个时间点算迟到（含本点：09:30:01 起算 late）
const LATE_AFTER = '09:30:00'

// scope 越高越靠前；maxScopeFor 返回一个人可用的最高范围（与 stats 完全一致）
const SCOPE_ORDER = ['mine', 'dept', 'all']

function maxScopeFor(ctx) {
  if (hasPerm(ctx, 'request:read:all')) return 'all'
  if (ctx.roles.includes('dept_manager') || ctx.roles.includes('boss')) return 'dept'
  return 'mine'
}

// 本地今天 YYYY-MM-DD（与 SQLite datetime('now') 同为 UTC 字符串，统一用本地即可）
function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

// 当月「已经过去」的工作日数（周一到周五，不含法定节假日——本系统不做节假日表，这是刻意的简化）
//
// ⭐ 为什么不是整月工作日：月中打开看板时，如果把 9/20 之后的未来工作日也算进「应出勤」，
//    每个人都会背上一堆「还没发生的缺卡」——截图里就出现过「全公司缺卡 163 天」这种荒谬数字。
//    缺卡只能统计已经过去的日子。所以：过去月份 = 整月；当前月 = 截至今天；未来月份 = 0。
function elapsedWorkingDays(month) {
  const [y, m] = month.split('-').map(Number)
  const today = todayStr()
  const thisMonth = today.slice(0, 7)
  if (month > thisMonth) return 0 // 未来月份：一天都还没过去
  // 该月最后一天；当前月截到「今天」，过去月份截到月末
  const lastDay =
    month === thisMonth
      ? Number(today.slice(8, 10))
      : new Date(y, m, 0).getDate()
  let count = 0
  for (let d = 1; d <= lastDay; d++) {
    const wd = new Date(y, m - 1, d).getDay() // 0=周日, 6=周六
    if (wd >= 1 && wd <= 5) count++
  }
  return count
}

function serialize(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    date: row.date,
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    status: row.status,
    note: row.note || '',
  }
}

function computeStatus(clockIn) {
  if (!clockIn) return 'pending'
  return clockIn > LATE_AFTER ? 'late' : 'normal'
}

export default async function attendanceRoutes(app) {
  // ── 打卡：上班 / 下班（本人当天）─────────────────────────────
  app.post(
    '/api/attendance/clock',
    handler(async (req) => {
      const ctx = req.ctx
      const date = todayStr()
      const type = (req.body?.type || 'in').toString()
      if (type !== 'in' && type !== 'out') throw badRequest('type 只能是 in 或 out')

      const db = getDb()
      const existing = db
        .prepare(`SELECT * FROM attendance WHERE user_id = ? AND date = ?`)
        .get(ctx.user.id, date)

      if (type === 'in') {
        if (existing && existing.clock_in) throw conflict('今天已经打过上班卡了')
        const now = new Date().toISOString().slice(11, 19) // HH:MM:SS
        if (existing) {
          db.prepare(
            `UPDATE attendance SET clock_in = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
          ).run(now, computeStatus(now), existing.id)
        } else {
          db.prepare(
            `INSERT INTO attendance (user_id, date, clock_in, status) VALUES (?, ?, ?, ?)`,
          ).run(ctx.user.id, date, now, computeStatus(now))
        }
      } else {
        // out：必须先有上班卡
        if (!existing || !existing.clock_in) throw badRequest('请先打上班卡，再打下班卡')
        if (existing.clock_out) throw conflict('今天已经打过下班卡了')
        const now = new Date().toISOString().slice(11, 19)
        db.prepare(
          `UPDATE attendance SET clock_out = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(now, existing.id)
      }

      const row = db
        .prepare(`SELECT * FROM attendance WHERE user_id = ? AND date = ?`)
        .get(ctx.user.id, date)
      return serialize(row)
    }),
  )

  // ── 本人记录（按月）─────────────────────────────────────────
  app.get(
    '/api/attendance/me',
    handler(async (req) => {
      const ctx = req.ctx
      const month = (req.query?.month || todayStr().slice(0, 7)).toString()
      const mMatch = /^(\d{4})-(\d{2})$/.exec(month)
      if (!mMatch) throw badRequest('month 必须是 YYYY-MM')
      if (Number(mMatch[2]) < 1 || Number(mMatch[2]) > 12) throw badRequest('month 的月份必须是 01–12')
      const db = getDb()
      const rows = db
        .prepare(
          `SELECT * FROM attendance WHERE user_id = ? AND date LIKE ? ORDER BY date DESC`,
        )
        .all(ctx.user.id, `${month}%`)
      return { month, items: rows.map(serialize) }
    }),
  )

  // ── 考勤统计（M7，数据范围权限）────────────────────────────
  app.get(
    '/api/attendance/overview',
    handler(async (req) => {
      const ctx = req.ctx
      const max = maxScopeFor(ctx)
      const scope = (req.query?.scope || max).toString()
      if (!SCOPE_ORDER.includes(scope)) throw badRequest(`scope 只能是 ${SCOPE_ORDER.join(' / ')}`)
      if (SCOPE_ORDER.indexOf(scope) > SCOPE_ORDER.indexOf(max)) {
        throw forbidden(`没有查看「${scope}」范围考勤的权限（你的最高可用范围是「${max}」）`)
      }
      const month = (req.query?.month || todayStr().slice(0, 7)).toString()
      const mMatch = /^(\d{4})-(\d{2})$/.exec(month)
      if (!mMatch) throw badRequest('month 必须是 YYYY-MM')
      if (Number(mMatch[2]) < 1 || Number(mMatch[2]) > 12) throw badRequest('month 的月份必须是 01–12')

      const db = getDb()
      const workingDays = elapsedWorkingDays(month)

      // 范围锁定的用户集合：mine 只自己；dept 本部门；all 全公司
      let userWhere = '1=1'
      const userArgs = []
      if (scope === 'mine') {
        userWhere = 'id = ?'
        userArgs.push(ctx.user.id)
      } else if (scope === 'dept') {
        userWhere = 'dept_id = ?'
        userArgs.push(ctx.user.dept_id)
      }
      const users = db
        .prepare(`SELECT id, real_name name FROM users WHERE ${userWhere} ORDER BY id`)
        .all(...userArgs)

      // 范围内每个人：有上班卡的天数 / 迟到天数 / 缺卡天数
      const perUser = users.map((u) => {
        const rows = db
          .prepare(`SELECT clock_in FROM attendance WHERE user_id = ? AND date LIKE ?`)
          .all(u.id, `${month}%`)
        const recordedDays = rows.filter((r) => r.clock_in).length
        const lateDays = rows.filter((r) => r.clock_in && r.clock_in > LATE_AFTER).length
        return {
          userId: u.id,
          name: u.name,
          recordedDays,
          lateDays,
          absentDays: Math.max(0, workingDays - recordedDays),
        }
      })

      const summary = {
        recordedDays: perUser.reduce((s, u) => s + u.recordedDays, 0),
        lateDays: perUser.reduce((s, u) => s + u.lateDays, 0),
        absentDays: perUser.reduce((s, u) => s + u.absentDays, 0),
      }

      return {
        scope,
        maxScope: max,
        month,
        workingDays,
        summary,
        // 只看自己时不返回 perUser（冗余）；经理 / 总经理才需要逐人列表
        perUser: scope === 'mine' ? [] : perUser,
      }
    }),
  )
}
