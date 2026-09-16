// 单据 + 审批动作路由。审批动作本身只是「转发给引擎」，业务规则全在 server/flow/engine.js
import { getDb } from '../db.js'
import { badRequest, forbidden, handler, notFound } from '../errors.js'
import { requirePerm, hasPerm } from '../permissions.js'
import { logAction } from '../audit.js'
import { serializeAttachment, serializeRequest, serializeTask } from '../serialize.js'
import {
  actOnRequest,
  canViewRequest,
  cancelRequest,
  getRequestOr404,
  listAttachments,
  listTasks,
  parseSnapshot,
  submitRequest,
} from '../flow/engine.js'
import { MAX_TITLE_LEN, REQUEST_TYPES, isKnownType, validateFormData } from '../flow/validators.js'

const SELECT_REQUEST = `
  SELECT r.*, u.real_name AS applicant_name
    FROM requests r
    JOIN users u ON u.id = r.applicant_id`

function detail(req, ctx) {
  const row = getRequestOr404(req.params.id)
  // 横向越权防线：非申请人、非审批人、无 request:read:all → 403（不是 404，方便排查）
  if (!canViewRequest(row, ctx)) throw forbidden('无权查看该单据')
  return {
    ...serializeRequest(row),
    flowSnapshot: parseSnapshot(row),
    tasks: listTasks(row.id).map(serializeTask),
    attachments: listAttachments(row.id).map(serializeAttachment),
  }
}

export default async function requestRoutes(app) {
  // 单据类型元数据（前端据此渲染表单；也让「有哪些类型」这件事只有一个来源）
  app.get(
    '/api/request-types',
    handler(async () => ({
      items: Object.entries(REQUEST_TYPES).map(([type, def]) => ({
        type,
        name: def.name,
        fields: def.fields,
      })),
    })),
  )

  app.get(
    '/api/flows',
    { preHandler: requirePerm('flow:read') },
    handler(async () => {
      const db = getDb()
      const flows = db.prepare(`SELECT * FROM flows ORDER BY id ASC`).all()
      return {
        items: flows.map((f) => ({
          id: f.id,
          type: f.type,
          name: f.name,
          description: f.description,
          enabled: !!f.enabled,
          steps: db
            .prepare(`SELECT step_no, name, approver_type, approver_ref, mode FROM flow_steps WHERE flow_id = ? ORDER BY step_no`)
            .all(f.id),
        })),
      }
    }),
  )

  // 列表：默认只看自己的；有 request:read:all 才看全部（可用 ?mine=1 强制只看自己）
  app.get(
    '/api/requests',
    handler(async (req) => {
      const { status, type, mine } = req.query || {}
      const seeAll = hasPerm(req.ctx, 'request:read:all') && mine !== '1' && mine !== 'true'
      const where = []
      const args = []
      if (!seeAll) {
        where.push('r.applicant_id = ?')
        args.push(req.ctx.user.id)
      }
      if (status) {
        where.push('r.status = ?')
        args.push(String(status))
      }
      if (type) {
        where.push('r.type = ?')
        args.push(String(type))
      }
      const sql = `${SELECT_REQUEST} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC`
      const items = getDb()
        .prepare(sql)
        .all(...args)
        .map(serializeRequest)
      return { items, total: items.length, scope: seeAll ? 'all' : 'mine' }
    }),
  )

  // 建单：只建草稿，提交是单独一步 —— 让状态机保持干净，也让「重复提交/非法提交」可测
  app.post(
    '/api/requests',
    handler(async (req, reply) => {
      const { type, title, formData } = req.body || {}
      if (!isKnownType(type)) {
        throw badRequest(`不支持的单据类型：${type}（可选：${Object.keys(REQUEST_TYPES).join(', ')}）`)
      }
      if (typeof title !== 'string' || !title.trim()) throw badRequest('title 必填')
      if (title.trim().length > MAX_TITLE_LEN) throw badRequest(`title 不能超过 ${MAX_TITLE_LEN} 个字`)
      validateFormData(type, formData)

      const info = getDb()
        .prepare(`INSERT INTO requests (type, applicant_id, title, form_data) VALUES (?, ?, ?, ?)`)
        .run(type, req.ctx.user.id, title.trim(), JSON.stringify(formData))

      logAction({
        userId: req.userId,
        action: 'request.create',
        targetType: 'request',
        targetId: info.lastInsertRowid,
        detail: { type, title: title.trim() },
      })
      const row = getDb().prepare(`${SELECT_REQUEST} WHERE r.id = ?`).get(info.lastInsertRowid)
      return reply.code(201).send(serializeRequest(row))
    }),
  )

  app.get(
    '/api/requests/:id',
    handler(async (req) => detail(req, req.ctx)),
  )

  app.post(
    '/api/requests/:id/submit',
    handler(async (req) => {
      const row = submitRequest(req.params.id, req.ctx.user.id)
      return serializeRequest(row)
    }),
  )

  const approveAction = (action) =>
    handler(async (req) => {
      const { comment = '' } = req.body || {}
      if (typeof comment !== 'string') throw badRequest('comment 必须是字符串')
      if (comment.length > 500) throw badRequest('comment 不能超过 500 个字')
      const row = actOnRequest(req.params.id, req.ctx.user.id, action, comment)
      return serializeRequest(row)
    })

  app.post('/api/requests/:id/approve', approveAction('approve'))
  app.post('/api/requests/:id/reject', approveAction('reject'))

  app.post(
    '/api/requests/:id/cancel',
    handler(async (req) => {
      const row = cancelRequest(req.params.id, req.ctx.user.id)
      return serializeRequest(row)
    }),
  )
}
