// 单据 + 审批动作路由。审批动作本身只是「转发给引擎」，业务规则全在 server/flow/engine.js
import { getDb } from '../db.js'
import { badRequest, forbidden, handler, notFound } from '../errors.js'
import { requirePerm, hasPerm } from '../permissions.js'
import { logAction } from '../audit.js'
import { serializeAttachment, serializeRequest, serializeTask } from '../serialize.js'
import {
  actOnRequest,
  batchActOnRequest,
  canViewRequest,
  cancelRequest,
  getRequestOr404,
  listAttachments,
  listTasks,
  parseSnapshot,
  submitRequest,
} from '../flow/engine.js'
import { MAX_TITLE_LEN, REQUEST_TYPES, isKnownType, validateFormData } from '../flow/validators.js'
import { csvFilename, toCsv } from '../lib/csv.js'

const SELECT_REQUEST = `
  SELECT r.*, u.real_name AS applicant_name
    FROM requests r
    JOIN users u ON u.id = r.applicant_id`

/**
 * 「谁能看到哪些单据」的唯一判断处 —— **列表与导出必须共用它**。
 * 分成两处写的后果不会报错、也不会有人发现：列表看着是对的，导出却悄悄多给了数据。
 * 「导出的比看得到的多」就是一个越权口子，而且是沉默的。
 * @returns {{seeAll: boolean, where: string[], args: any[]}}
 */
function scopeFilter(ctx, { mine } = {}) {
  // 有 request:read:all 才看全部；?mine=1 可以自愿缩回「只看自己」
  const seeAll = hasPerm(ctx, 'request:read:all') && mine !== '1' && mine !== 'true'
  const where = []
  const args = []
  if (!seeAll) {
    where.push('r.applicant_id = ?')
    args.push(ctx.user.id)
  }
  return { seeAll, where, args }
}

/**
 * 按「可见范围 + 筛选条件」查出单据行 —— 列表与导出共用。
 * 抽出来的第二个理由：筛选条件（status / type）也必须是同一套，
 * 否则会出现「列表我筛了已驳回，导出来却是全部」这种「看着像功能差异、其实是泄露」的问题。
 */
function queryRequests(ctx, { status, type, mine } = {}) {
  const { seeAll, where, args } = scopeFilter(ctx, { mine })
  if (status) {
    where.push('r.status = ?')
    args.push(String(status))
  }
  if (type) {
    where.push('r.type = ?')
    args.push(String(type))
  }
  const sql = `${SELECT_REQUEST} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC`
  return { seeAll, rows: getDb().prepare(sql).all(...args) }
}

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
      const { seeAll, rows } = queryRequests(req.ctx, req.query || {})
      const items = rows.map(serializeRequest)
      return { items, total: items.length, scope: seeAll ? 'all' : 'mine' }
    }),
  )

  // 导出 CSV（M4）。
  // ⭐ 这个接口的意义不在「能导出」，而在它把三个平时看不见的坑摆到了台面上：
  //    ① 公式注入：把 title 写成 `=cmd|'/c calc'!A1`，审批人导出用 Excel 打开就会执行；
  //    ② 越权导出：可见性必须复用 scopeFilter，否则「导出的比看得到的多」是个沉默的洞；
  //    ③ 敏感操作要留痕：导出全量单据是典型的数据外带动作，必须进审计日志。
  app.get(
    '/api/requests/export.csv',
    handler(async (req, reply) => {
      const { seeAll, rows } = queryRequests(req.ctx, req.query || {})
      // 走同一个序列化函数：导出与接口对「一条单据长什么样」只应该有一种说法，
      // 不然字段名/嵌套结构一变，导出的列就跟接口悄悄对不上了
      const items = rows.map(serializeRequest)

      const header = ['单据号', '类型', '标题', '申请人', '状态', '轮次', '金额', '创建时间']
      const body = items.map((r) => [
        r.id,
        // 单据类型用服务端的 REQUEST_TYPES（单一来源），不另抄一份文案表
        REQUEST_TYPES[r.type]?.name || r.type,
        r.title,
        r.applicantName || '',
        // 状态**导出原始码**而不是中文文案：文案属于界面、会随 UI 改；
        // 导出是数据，要的是稳定、能二次处理（透视 / 导入比对）。
        r.status,
        r.round,
        r.formData.amount ?? '',
        r.createdAt,
      ])

      // 导出是「把数据带走」的动作，必须留痕（谁、导了多少、范围多大）
      logAction({
        userId: req.ctx.user.id,
        action: 'request.export',
        targetType: 'requests',
        targetId: String(rows.length),
        detail: `导出 ${rows.length} 条（范围：${seeAll ? '全部' : '仅本人'}）`,
        ip: req.ip,
      })

      // 文件名用 ASCII：Content-Disposition 里放中文要走 filename*=UTF-8''… 的编码，
      // 各浏览器/代理行为参差，一个纯 ASCII 名能省掉一整类坑（中文标题在文件内容里就够了）
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="${csvFilename('requests')}"`)
      // 条数用头传，让前端提示「已导出 N 条」时**不用去数 CSV 的行** ——
      // 含换行的字段会被引号包着跨行，前端按 \n 数必然数错（少一条能数出两条）。
      // 这是「谁的数据谁负责数」：行数在服务端就是已知的，没必要让客户端再猜一次。
      reply.header('X-Total-Count', String(items.length))
      return reply.send(toCsv([header, ...body]))
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

  // 批量审批。
  // ⚠️ 路径刻意写成两段 `/batch-approve`，而不是三段的 `/batch/approve`：
  //    后者会被上面的 `/api/requests/:id/approve` 按注册顺序先匹配掉（:id = "batch"），
  //    然后 Number("batch") = NaN 一路走到 SQL 里变成一个 500。
  //    这和前端 router 里「/requests/new 必须放在 /requests/:id 之前」是**同一个坑的两种形态**：
  //    **带通配段的路径能吞掉任何同形状的固定路径，而它不会报错，只会走进错误的处理器。**
  app.post(
    '/api/requests/batch-approve',
    handler(async (req, reply) => {
      const { ids, action, comment = '' } = req.body || {}
      if (action !== 'approve' && action !== 'reject') throw badRequest('action 只能是 approve 或 reject')
      if (typeof comment !== 'string') throw badRequest('comment 必须是字符串')
      if (comment.length > 500) throw badRequest('comment 不能超过 500 个字')

      const out = batchActOnRequest(ids, req.ctx.user.id, action, comment)
      const { httpStatus, ...body } = out
      // 200 全成功 / 207 部分成功 / 400 全失败 —— 单条原因都在 body.results 里。
      // 全失败时额外补一句 error：通用错误处理（只看 {error}）拿不到 results，
      // 不给它一句话，界面上就只能显示「请求失败（HTTP 400）」，等于什么都没说。
      const payload = httpStatus === 400 ? { error: `${out.total} 条全部未能处理`, ...body } : body
      return reply.code(httpStatus).send(payload)
    }),
  )

  app.post(
    '/api/requests/:id/cancel',
    handler(async (req) => {
      const row = cancelRequest(req.params.id, req.ctx.user.id)
      return serializeRequest(row)
    }),
  )
}
