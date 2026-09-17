// 站内通知（M3）：每个人只看得到自己的通知。
//
// ★ 这里**刻意不挂任何权限码**（对比 departments/users/flows 都挂了 requirePerm）：
//   通知是「我自己的东西」，不是某个角色的职能 —— 用权限码管它只会造出
//   「要有 inbox:read 才能看自己收件箱」这种没意义的配置。
//   安全边界靠「SQL 层强制 user_id = 当前用户」，而不是靠权限表。
//
// ★ 单条已读的越权处理：**别人的通知**与**不存在的通知**返回**完全相同**的 404。
//   如果前者 404、后者 403，就等于送出一个「哪些通知 id 存在」的枚举探针 ——
//   和引擎里「授权先于状态」防的是同一件事（见 server/flow/engine.js 的 ①）。
//   这里与单据接口的取舍不同（单据选显式 403 方便排查），原因是：
//   **通知是纯私有资源，组织内不存在「可见但无权限」的中间态。**
import { getDb } from '../db.js'
import { badRequest, handler, notFound } from '../errors.js'
import { serializeNotification } from '../serialize.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function unreadCount(userId) {
  return getDb()
    .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL`)
    .get(userId).n
}

export default async function notificationRoutes(app) {
  // 我的通知列表。?unread=1 只看未读；?limit= 控制条数（上限 200）
  app.get(
    '/api/notifications',
    handler(async (req) => {
      const { unread, limit } = req.query || {}
      const where = ['user_id = ?']
      const args = [req.ctx.user.id]
      if (unread === '1' || unread === 'true') where.push('read_at IS NULL')

      const raw = Number(limit)
      const n = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), MAX_LIMIT) : DEFAULT_LIMIT

      const items = getDb()
        .prepare(`SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
        .all(...args, n)
        .map(serializeNotification)

      // unread 是**全量**未读数，不是「当前页里有几条未读」——
      // 分页之后用后者当角标会少算，这种「看起来对、其实会撒谎」的数字最坑。
      return { items, total: items.length, unread: unreadCount(req.ctx.user.id) }
    }),
  )

  // 未读数：给页头角标用，单独一个轻接口
  app.get(
    '/api/notifications/unread-count',
    handler(async (req) => ({ unread: unreadCount(req.ctx.user.id) })),
  )

  // 标记单条已读。已读**幂等**：重复标记返回 200 + changed:false，不报错。
  app.post(
    '/api/notifications/:id/read',
    handler(async (req) => {
      const db = getDb()
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) throw badRequest('通知 id 必须是正整数')

      const row = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id)
      // 「不是你的」和「不存在」给同一个 404、同一句文案 —— 不泄漏存在性（见文件头注释）
      if (!row || row.user_id !== req.ctx.user.id) throw notFound('通知不存在')

      if (row.read_at) {
        return { ...serializeNotification(row), changed: false, unread: unreadCount(req.ctx.user.id) }
      }

      // 条件更新：只改「还没读」的那一行，重复并发标记时第二次 changes=0，不产生额外写入
      db.prepare(
        `UPDATE notifications SET read_at = datetime('now')
          WHERE id = ? AND user_id = ? AND read_at IS NULL`,
      ).run(id, req.ctx.user.id)

      const after = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id)
      return { ...serializeNotification(after), changed: true, unread: unreadCount(req.ctx.user.id) }
    }),
  )

  // 全部已读：只影响自己的未读
  app.post(
    '/api/notifications/read-all',
    handler(async (req) => {
      const info = getDb()
        .prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`)
        .run(req.ctx.user.id)
      return { updated: info.changes, unread: 0 }
    }),
  )
}
