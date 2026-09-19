// 统计报表（M6）
//
// ★ 这一节的靶子不是图表（前端只是纯 CSS 条块，零依赖），而是**聚合接口的数据范围权限**。
//
// 单据详情的越权面是「一行」：你能看哪一单。统计的越权面是「一批」：
// 一个聚合接口如果不收敛范围，普通员工把它当字典查（按状态反复请求），
// 就能拼出「全公司谁提了多少单、谁的单总被驳回」—— 每个数字单独看都无害，
// 合起来就是组织敏感信息。所以统计的 scope 必须按身份收敛：
//
//   mine —— 所有人（只算自己提交的单据）
//   dept —— dept_manager（本部门所有人的单据）
//   all  —— 有 request:read:all 的人（总经理 / 人事）
//
// 关键决策：**复用 request:read:all，不新造一个 stats:read**。
// 「谁能看全部单据」和「谁能看全部单据的统计」是同一个问题，两套权限码
// 迟早会配出「看得见单据看不见统计」或反过来的怪状态。
//
// scope 语义：显式传 scope 超出自己的最高可用范围 → 403（不是静默降级 ——
// 静默降级会让「经理以为在看全公司、实际只看到本部门」这种错误结论变得无法察觉）。

import { getDb } from '../db.js'
import { badRequest, forbidden, handler } from '../errors.js'
import { hasPerm } from '../permissions.js'

// scope 越高越靠前；maxScopeFor 返回一个人可用的最高范围
const SCOPE_ORDER = ['mine', 'dept', 'all']

function maxScopeFor(ctx) {
  if (hasPerm(ctx, 'request:read:all')) return 'all'
  if (ctx.roles.includes('dept_manager') || ctx.roles.includes('boss')) return 'dept'
  return 'mine'
}

export default async function statsRoutes(app) {
  app.get(
    '/api/stats/overview',
    handler(async (req) => {
      const ctx = req.ctx
      const max = maxScopeFor(ctx)
      const scope = req.query?.scope || max
      if (!SCOPE_ORDER.includes(scope)) throw badRequest(`scope 只能是 ${SCOPE_ORDER.join(' / ')}`)
      if (SCOPE_ORDER.indexOf(scope) > SCOPE_ORDER.indexOf(max)) {
        throw forbidden(`没有查看「${scope}」范围统计的权限（你的最高可用范围是「${max}」）`)
      }

      const db = getDb()
      // 范围过滤：一条 SQL 片段 + 参数，所有聚合共用 —— 范围只在这一处定义，
      // 否则「状态分布按全公司、月度趋势按自己」这种精神分裂迟早出现
      let where = '1=1'
      const args = []
      if (scope === 'mine') {
        where = 'r.applicant_id = ?'
        args.push(ctx.user.id)
      } else if (scope === 'dept') {
        where = 'r.applicant_id IN (SELECT id FROM users WHERE dept_id = ?)'
        args.push(ctx.user.dept_id)
      }
      const scoped = (sql) => sql.replace('__WHERE__', where)

      // ── 按状态 ────────────────────────────────────────────────
      const byStatusRows = db
        .prepare(scoped(`SELECT status, COUNT(*) n FROM requests r WHERE __WHERE__ GROUP BY status`))
        .all(...args)
      const byStatus = {}
      let total = 0
      for (const row of byStatusRows) {
        byStatus[row.status] = row.n
        total += row.n
      }

      // ── 按类型 ────────────────────────────────────────────────
      const byType = db
        .prepare(
          scoped(`SELECT r.type, COUNT(*) n FROM requests r WHERE __WHERE__ GROUP BY r.type ORDER BY n DESC`),
        )
        .all(...args)

      // ── 近 6 个月提交趋势 ─────────────────────────────────────
      // 按「提交时间」算：草稿没有 submitted_at，天然不进趋势 —— 趋势回答的是
      // 「流程被发起的节奏」，把草稿算进来反而让这个数字说不清是什么
      const monthly = db
        .prepare(
          scoped(
            `SELECT strftime('%Y-%m', r.submitted_at) ym, COUNT(*) n
               FROM requests r
              WHERE __WHERE__ AND r.submitted_at IS NOT NULL
                AND r.submitted_at >= datetime('now', '-6 months')
              GROUP BY ym ORDER BY ym`,
          ),
        )
        .all(...args)

      // ── 审批效率 ──────────────────────────────────────────────
      // 只统计「走完流程」的单（approved）：rejected 的耗时混着等待重提的时间，口径会脏
      const eff = db
        .prepare(
          scoped(
            `SELECT COUNT(*) n,
                    AVG((julianday(r.updated_at) - julianday(r.submitted_at)) * 24) avg_hours,
                    AVG(r.round) avg_rounds
               FROM requests r
              WHERE __WHERE__ AND r.status = 'approved' AND r.submitted_at IS NOT NULL`,
          ),
        )
        .get(...args)

      // ── 会议室（M5）：范围跟着单据走（谁的数据就统计谁的预订）──
      let roomWhere = '1=1'
      const roomArgs = []
      if (scope === 'mine') {
        roomWhere = 'b.user_id = ?'
        roomArgs.push(ctx.user.id)
      } else if (scope === 'dept') {
        roomWhere = 'b.user_id IN (SELECT id FROM users WHERE dept_id = ?)'
        roomArgs.push(ctx.user.dept_id)
      }
      const roomTotal = db
        .prepare(`SELECT COUNT(*) n FROM room_bookings b WHERE ${roomWhere} AND b.status = 'booked'`)
        .get(...roomArgs).n
      const byRoom = db
        .prepare(
          `SELECT r.name, COUNT(*) n
             FROM room_bookings b JOIN meeting_rooms r ON r.id = b.room_id
            WHERE ${roomWhere} AND b.status = 'booked'
            GROUP BY b.room_id ORDER BY n DESC`,
        )
        .all(...roomArgs)

      return {
        scope,
        maxScope: max,
        requests: { total, byStatus, byType },
        monthly,
        efficiency: {
          archivedCount: eff.n,
          // 未归档任何单时 avg 是 null —— 前端显示「—」，不要把 null 当 0 骗人
          avgHours: eff.avg_hours == null ? null : Math.round(eff.avg_hours * 10) / 10,
          avgRounds: eff.avg_rounds == null ? null : Math.round(eff.avg_rounds * 100) / 100,
        },
        rooms: { total: roomTotal, byRoom },
      }
    }),
  )
}
