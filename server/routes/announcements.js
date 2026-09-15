// 公告
import { getDb } from '../db.js'
import { badRequest, handler } from '../errors.js'
import { requirePerm } from '../permissions.js'
import { logAction } from '../audit.js'

export default async function announcementRoutes(app) {
  app.get(
    '/api/announcements',
    handler(async () => {
      const items = getDb()
        .prepare(
          `SELECT a.id, a.title, a.body, a.pinned, a.created_at, a.author_id,
                  u.real_name AS author_name
             FROM announcements a
             JOIN users u ON u.id = a.author_id
            ORDER BY a.pinned DESC, a.id DESC
            LIMIT 100`,
        )
        .all()
        .map((a) => ({
          id: a.id,
          title: a.title,
          body: a.body,
          pinned: !!a.pinned,
          authorId: a.author_id,
          authorName: a.author_name,
          createdAt: a.created_at,
        }))
      return { items, total: items.length }
    }),
  )

  app.post(
    '/api/announcements',
    { preHandler: requirePerm('announcement:write') },
    handler(async (req, reply) => {
      const { title, body = '', pinned = false } = req.body || {}
      if (typeof title !== 'string' || !title.trim()) throw badRequest('title 必填')
      if (title.trim().length > 100) throw badRequest('title 不能超过 100 个字')
      if (typeof body !== 'string') throw badRequest('body 必须是字符串')
      if (body.length > 5000) throw badRequest('body 不能超过 5000 个字')

      const info = getDb()
        .prepare(`INSERT INTO announcements (title, body, author_id, pinned) VALUES (?, ?, ?, ?)`)
        .run(title.trim(), body, req.ctx.user.id, pinned ? 1 : 0)

      logAction({
        userId: req.userId,
        action: 'announcement.create',
        targetType: 'announcement',
        targetId: info.lastInsertRowid,
      })
      const created = getDb().prepare(`SELECT * FROM announcements WHERE id = ?`).get(info.lastInsertRowid)
      return reply.code(201).send(created)
    }),
  )
}
