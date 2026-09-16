// 附件路由（M2）：上传 / 列表 / 下载 / 删除。
// 安全红线都在这里落地：数量与大小限制、类型白名单（嗅探真实字节）、下载鉴权、文件名清洗。
import { getDb } from '../db.js'
import { badRequest, conflict, forbidden, handler, notFound } from '../errors.js'
import { logAction } from '../audit.js'
import { canViewRequest, getRequestOr404, listAttachments } from '../flow/engine.js'
import { serializeAttachment } from '../serialize.js'
import {
  deleteUpload,
  isAllowedMime,
  makeStoredName,
  maxFilesPerRequest,
  maxUploadBytes,
  readUpload,
  safeDownloadName,
  saveUpload,
  sniffMime,
} from '../lib/storage.js'

// 只有「申请人 + 单据处于可编辑态」才能增删附件。
// 与「提交后不可改表单」保持一致 —— 附件也是单据内容的一部分，提交后就锁定。
const EDITABLE = ['draft', 'rejected']

const findAttachment = (id) => getDb().prepare(`SELECT * FROM attachments WHERE id = ?`).get(Number(id))

export default async function attachmentRoutes(app) {
  // 上传：POST /api/requests/:id/attachments （multipart/form-data，文件字段名 file）
  app.post(
    '/api/requests/:id/attachments',
    handler(async (req, reply) => {
      const row = getRequestOr404(req.params.id)
      // ① 只有申请人能加附件：审批人 / 无关的人一律 403
      if (row.applicant_id !== req.ctx.user.id) throw forbidden('只有申请人本人能给该单据添加附件')
      // ② 只有可编辑态能改：已提交 / 已归档 → 409（不是 403，这是状态冲突不是权限问题）
      if (!EDITABLE.includes(row.status)) {
        throw conflict(`单据当前状态（${row.status}）不允许增删附件`)
      }
      // ③ 数量上限
      const n = getDb()
        .prepare(`SELECT COUNT(*) AS n FROM attachments WHERE request_id = ?`)
        .get(row.id).n
      if (n >= maxFilesPerRequest()) throw badRequest(`附件数量已达上限（${maxFilesPerRequest()} 个）`)

      if (!req.isMultipart || !req.isMultipart()) {
        throw badRequest('请用 multipart/form-data 上传，文件字段名为 file')
      }
      const part = await req.file()
      if (!part) throw badRequest('缺少文件字段（form-data 字段名应为 file）')

      // 读进内存（有大小上限兜底）；超限时插件会把 truncated 置真（未开 throwFileSizeLimit）
      const buffer = await part.toBuffer()
      if (part.file?.truncated || buffer.length > maxUploadBytes()) {
        throw badRequest(`文件超过大小上限（${Math.round(maxUploadBytes() / 1024 / 1024)}MB）`)
      }
      if (!buffer.length) throw badRequest('文件内容为空')

      // ④ 类型：以**真实字节**为准，不看客户端声明的 mimetype（改名 exe→png 在这里被挡下）
      const mime = sniffMime(buffer)
      if (!mime || !isAllowedMime(mime)) {
        throw badRequest('不支持的文件类型（只允许 PNG / JPEG / GIF / WebP / PDF）')
      }

      const storedName = makeStoredName(mime) // 随机名，不含用户输入 → 防路径穿越
      saveUpload(storedName, buffer)
      // ④ 数量上限的**权威判定**在这里：把「数一遍」和「插一行」压进同一条 SQL。
      //    上面那次 pre-check 只是为了尽早拒绝、别把 body 读进内存，它与插入之间隔着
      //    `await part.toBuffer()`，并发请求会一起通过（典型 TOCTOU）—— 数出来都是 0。
      //    SQL 语句内部不会被打断，所以这条带子查询的条件插入才是真正的防线；
      //    与「并发审批用条件更新查 changes」是同一套路子。
      const info = getDb()
        .prepare(
          `INSERT INTO attachments (request_id, uploader_id, original_name, stored_name, mime, size)
           SELECT ?, ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM attachments WHERE request_id = ?) < ?`,
        )
        .run(
          row.id,
          req.ctx.user.id,
          safeDownloadName(part.filename),
          storedName,
          mime,
          buffer.length,
          row.id,
          maxFilesPerRequest(),
        )

      if (info.changes === 0) {
        // 被并发挤掉：刚落的盘要收回去，否则磁盘留下没人认领的孤儿文件
        deleteUpload(storedName)
        throw badRequest(`附件数量已达上限（${maxFilesPerRequest()} 个）`)
      }

      logAction({
        userId: req.userId,
        action: 'attachment.upload',
        targetType: 'request',
        targetId: row.id,
        detail: { name: part.filename, size: buffer.length, mime },
      })
      const created = findAttachment(info.lastInsertRowid)
      return reply.code(201).send(serializeAttachment({ ...created, uploader_name: req.ctx.user.real_name }))
    }),
  )

  // 列表：能看单据的人都能看附件列表（横向越权防线与单据详情一致）
  app.get(
    '/api/requests/:id/attachments',
    handler(async (req) => {
      const row = getRequestOr404(req.params.id)
      if (!canViewRequest(row, req.ctx)) throw forbidden('无权查看该单据')
      const items = listAttachments(row.id).map(serializeAttachment)
      return { items, total: items.length }
    }),
  )

  // 下载：同样要求「能看这张单据」，否则 403（附件不因为随机名就能绕过鉴权）
  app.get(
    '/api/attachments/:id',
    handler(async (req, reply) => {
      const att = findAttachment(req.params.id)
      if (!att) throw notFound('附件不存在')
      const row = getRequestOr404(att.request_id)
      if (!canViewRequest(row, req.ctx)) throw forbidden('无权下载该附件')

      let buf
      try {
        buf = readUpload(att.stored_name)
      } catch {
        // 磁盘缺失只报 404，不把服务端路径泄漏给客户端
        throw notFound('附件文件已丢失')
      }

      const name = safeDownloadName(att.original_name)
      const encoded = encodeURIComponent(name)
      return reply
        .header('Content-Type', att.mime)
        .header('Content-Length', String(buf.length))
        // RFC 5987：中文文件名用 filename* 编码下发，避免响应头里出现裸非 ASCII（防头注入）
        .header('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`)
        .send(buf)
    }),
  )

  // 删除：仅上传者本人 + 可编辑态（别人删不了，锁定后也删不了）
  app.delete(
    '/api/attachments/:id',
    handler(async (req) => {
      const att = findAttachment(req.params.id)
      if (!att) throw notFound('附件不存在')
      if (att.uploader_id !== req.ctx.user.id) throw forbidden('只有上传者本人能删除该附件')
      const row = getRequestOr404(att.request_id)
      if (!EDITABLE.includes(row.status)) {
        throw conflict(`单据当前状态（${row.status}）不允许增删附件`)
      }

      getDb().prepare(`DELETE FROM attachments WHERE id = ?`).run(att.id)
      deleteUpload(att.stored_name)
      logAction({
        userId: req.userId,
        action: 'attachment.delete',
        targetType: 'request',
        targetId: row.id,
        detail: { name: att.original_name, attachmentId: att.id },
      })
      return { ok: true }
    }),
  )
}
