// 审计日志查询（仅 audit:read 权限可见 → 员工访问必须 403）
import { handler } from '../errors.js'
import { requirePerm } from '../permissions.js'
import { listLogs } from '../audit.js'

export default async function auditLogRoutes(app) {
  app.get(
    '/api/audit-logs',
    { preHandler: requirePerm('audit:read') },
    handler(async (req) => {
      const { limit, userId } = req.query || {}
      const items = listLogs({ limit, userId: userId ? Number(userId) : null }).map((l) => ({
        id: l.id,
        userId: l.user_id,
        userName: l.user_name ?? null,
        action: l.action,
        targetType: l.target_type,
        targetId: l.target_id,
        detail: l.detail,
        ip: l.ip,
        createdAt: l.created_at,
      }))
      return { items, total: items.length }
    }),
  )
}
