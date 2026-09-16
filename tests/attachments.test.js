// 附件上传 / 下载 / 删除（M2）
//
// 这一组用例的重点不是「能传文件」，而是**安全边界**：
//   类型靠嗅探真实字节（改名 exe→png 挡下）、大小/数量有上限、
//   落盘名与用户输入解耦（路径穿越无效）、下载要过单据可见性鉴权。
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { getDb } from '../server/db.js'
import {
  api,
  downloadAttachment,
  FAKE_EXE_BYTES,
  ID,
  LEAVE_FORM,
  login,
  makeApp,
  PDF_BYTES,
  PNG_BYTES,
  U,
  uploadAttachment,
} from './helpers.js'

/** 建一张草稿（可编辑态，允许传附件） */
async function newDraft(app, token) {
  const r = await api(app, token).post('/api/requests', { type: 'leave', title: '附件测试单', formData: LEAVE_FORM })
  if (r.status !== 201) throw new Error(`建单失败：${r.status} ${JSON.stringify(r.body)}`)
  return r.body.id
}

describe('附件（上传 / 下载 / 删除）', () => {
  let app
  beforeEach(async () => {
    app = await makeApp()
  })
  afterEach(async () => {
    delete process.env.MAX_UPLOAD_BYTES
    delete process.env.MAX_FILES_PER_REQUEST
    await app.close()
  })

  test('申请人给草稿上传 PNG → 201，返回名称/类型/大小/下载地址', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    const r = await uploadAttachment(app, token, id, '活动海报.png', PNG_BYTES, { contentType: 'image/png' })
    expect(r.status).toBe(201)
    expect(r.body.name).toBe('活动海报.png')
    expect(r.body.mime).toBe('image/png')
    expect(r.body.size).toBe(PNG_BYTES.length)
    expect(r.body.url).toBe(`/api/attachments/${r.body.id}`)
  })

  test('PDF 也在白名单内 → 201（mime=application/pdf）', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    const r = await uploadAttachment(app, token, id, '物料清单.pdf', PDF_BYTES)
    expect(r.status).toBe(201)
    expect(r.body.mime).toBe('application/pdf')
  })

  test('上传后出现在单据详情的 attachments 里', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    await uploadAttachment(app, token, id, 'a.png', PNG_BYTES)
    await uploadAttachment(app, token, id, 'b.png', PNG_BYTES)
    const d = await api(app, token).get(`/api/requests/${id}`)
    expect(d.status).toBe(200)
    expect(d.body.attachments.map((a) => a.name)).toEqual(['a.png', 'b.png'])
  })

  test('未登录上传 → 401', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    const r = await uploadAttachment(app, null, id, 'x.png', PNG_BYTES)
    expect(r.status).toBe(401)
  })

  test('★ 非申请人上传 → 403（附件是单据内容，不是谁都能加）', async () => {
    const owner = await login(app, U.ops1)
    const id = await newDraft(app, owner)
    const other = await login(app, U.ops2)
    const r = await uploadAttachment(app, other, id, 'x.png', PNG_BYTES)
    expect(r.status).toBe(403)
  })

  test('★ 单据已提交（非可编辑态）再传附件 → 409', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    expect((await api(app, token).post(`/api/requests/${id}/submit`)).status).toBe(200)
    const r = await uploadAttachment(app, token, id, 'x.png', PNG_BYTES)
    expect(r.status).toBe(409)
  })

  test('★★ 伪装成 .png 的可执行文件（MZ 头）→ 400（类型看真实字节，不看文件名）', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    const r = await uploadAttachment(app, token, id, 'invoice.png', FAKE_EXE_BYTES, { contentType: 'image/png' })
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toContain('不支持的文件类型')
  })

  test('★ 超过大小上限 → 400（不是 500）', async () => {
    process.env.MAX_UPLOAD_BYTES = '1024'
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(4096, 0x41)])
    const r = await uploadAttachment(app, token, id, 'big.png', big)
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toContain('大小上限')
  })

  test('★ 附件数量上限 → 400', async () => {
    process.env.MAX_FILES_PER_REQUEST = '1'
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    expect((await uploadAttachment(app, token, id, '1.png', PNG_BYTES)).status).toBe(201)
    const r = await uploadAttachment(app, token, id, '2.png', PNG_BYTES)
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toContain('数量已达上限')
  })

  test('★★ 文件名带 ../ 的路径穿越尝试：不穿越（解析器去路径 + 落盘随机名）', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    const r = await uploadAttachment(app, token, id, '../../../../evil.png', PNG_BYTES)
    expect(r.status).toBe(201)
    // 第一道防线：multipart 解析器（busboy）默认剥掉文件名里的目录部分
    expect(r.body.name).toBe('evil.png')
    expect(r.body.name).not.toContain('/')
    // 第二道（真正的根因）：磁盘落盘名是随机 UUID，和用户输入彻底解耦 → 拼不出 ../ 也猜不到
    const row = getDb().prepare(`SELECT stored_name FROM attachments WHERE id = ?`).get(r.body.id)
    expect(row.stored_name).toMatch(/^[0-9a-f-]{36}\.png$/)
  })

  test('下载：申请人可下载，返回正确类型与原始内容', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    const up = await uploadAttachment(app, token, id, '图.png', PNG_BYTES)
    const r = await downloadAttachment(app, token, up.body.id)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('image/png')
    expect(Buffer.compare(r.body, PNG_BYTES)).toBe(0)
    // 中文文件名按 RFC 5987 编码，响应头里不出现裸非 ASCII
    expect(r.headers['content-disposition']).toContain("filename*=UTF-8''")
  })

  test('★ 下载要过单据可见性：无关同事 → 403', async () => {
    const owner = await login(app, U.ops1)
    const id = await newDraft(app, owner)
    const up = await uploadAttachment(app, owner, id, 'x.png', PNG_BYTES)
    const other = await login(app, U.ops2)
    const r = await downloadAttachment(app, other, up.body.id)
    expect(r.status).toBe(403)
  })

  test('★ 下载要过单据可见性：该单据的审批人（提交后）可以下载', async () => {
    const owner = await login(app, U.ops1)
    const id = await newDraft(app, owner)
    const up = await uploadAttachment(app, owner, id, 'x.png', PNG_BYTES)
    // 提交后 ops1 的直属上级（ops01，id=3）成为第一级审批人
    await api(app, owner).post(`/api/requests/${id}/submit`)
    const mgr = await login(app, U.opsMgr)
    const r = await downloadAttachment(app, mgr, up.body.id)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('image/png')
  })

  test('下载不存在的附件 → 404', async () => {
    const token = await login(app, U.admin)
    expect((await downloadAttachment(app, token, 999999)).status).toBe(404)
  })

  test('删除：非上传者 → 403；上传者本人 + 可编辑态 → 200 且列表清空', async () => {
    const owner = await login(app, U.ops1)
    const id = await newDraft(app, owner)
    const up = await uploadAttachment(app, owner, id, 'x.png', PNG_BYTES)

    const other = await login(app, U.ops2)
    expect((await api(app, other).del(`/api/attachments/${up.body.id}`)).status).toBe(403)

    expect((await api(app, owner).del(`/api/attachments/${up.body.id}`)).status).toBe(200)
    const list = await api(app, owner).get(`/api/requests/${id}/attachments`)
    expect(list.body.items).toEqual([])
  })

  test('★ 附件列表接口：审批人看得到、无关同事 403（与单据可见性一致）', async () => {
    const owner = await login(app, U.ops1)
    const id = await newDraft(app, owner)
    await uploadAttachment(app, owner, id, 'x.png', PNG_BYTES)

    const other = await login(app, U.ops2)
    expect((await api(app, other).get(`/api/requests/${id}/attachments`)).status).toBe(403)

    const hr = await login(app, U.hr) // 有 request:read:all
    const r = await api(app, hr).get(`/api/requests/${id}/attachments`)
    expect(r.status).toBe(200)
    expect(r.body.total).toBe(1)
  })

  test('上传会写审计日志（谁在什么时候传了什么）', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    await uploadAttachment(app, token, id, 'audit.png', PNG_BYTES)
    const logs = await api(app, await login(app, U.admin)).get('/api/audit-logs')
    expect(logs.body.items.map((l) => l.action)).toContain('attachment.upload')
  })
})
