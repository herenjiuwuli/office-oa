// 附件（第二轮）：越权 / 并发 / 边界
//
// 第一轮（attachments.test.js）回答的是「红线在不在」：类型嗅探、大小、数量、路径穿越、下载鉴权。
// 这一轮换三个角度问更难的问题：
//   ① 顺序 —— 越权的判据是「授权先于状态」还是反过来？（顺序错了就是信息泄漏）
//   ② 并发 —— 「先查数量再插入」在同时到达时还成立吗？（典型 TOCTOU）
//   ③ 边界 —— 上限的「等于」和「多一字节」分别落在哪一侧？文件名能不能污染响应头？
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import { getDb } from '../server/db.js'
import { uploadDir } from '../server/lib/storage.js'
import {
  api,
  downloadAttachment,
  FAKE_EXE_BYTES,
  LEAVE_FORM,
  login,
  makeApp,
  PNG_BYTES,
  U,
  uploadAttachment,
} from './helpers.js'

/** 建一张可编辑态（draft）的单据 */
async function newDraft(app, token) {
  const r = await api(app, token).post('/api/requests', { type: 'leave', title: '附件边界测试单', formData: LEAVE_FORM })
  if (r.status !== 201) throw new Error(`建单失败：${r.status} ${JSON.stringify(r.body)}`)
  return r.body.id
}

/** 建草稿（可编辑）→ 上传一个附件 → 提交（锁定）→ 返回 { id, attId } */
async function newLockedRequestWithFile(app, token) {
  const id = await newDraft(app, token)
  const up = await uploadAttachment(app, token, id, 'locked.png', PNG_BYTES)
  if (up.status !== 201) throw new Error(`上传失败：${up.status} ${JSON.stringify(up.body)}`)
  const submitted = await api(app, token).post(`/api/requests/${id}/submit`)
  if (submitted.status !== 200) throw new Error(`提交失败：${submitted.status} ${JSON.stringify(submitted.body)}`)
  return { id, attId: up.body.id }
}

describe('附件 · 越权（顺序与身份）', () => {
  let app
  beforeEach(async () => {
    app = await makeApp()
  })
  afterEach(async () => {
    delete process.env.MAX_UPLOAD_BYTES
    delete process.env.MAX_FILES_PER_REQUEST
    await app.close()
  })

  test('★★ 删除：同一张已提交单据，上传者 → 409、无关人 → 403（授权先于状态）', async () => {
    const owner = await login(app, U.ops1)
    const { attId } = await newLockedRequestWithFile(app, owner)

    // 上传者本人：身份没问题，是**状态**不允许（单据已提交，附件随之锁定）→ 409
    expect((await api(app, owner).del(`/api/attachments/${attId}`)).status).toBe(409)

    // 同部门的无关同事：连「能不能操作这张单据」都不成立 → 403
    const other = await login(app, U.ops2)
    expect((await api(app, other).del(`/api/attachments/${attId}`)).status).toBe(403)

    // 该单据的第一级审批人：有读权、能下载，但删不了别人的附件 → 403
    const mgr = await login(app, U.opsMgr)
    expect((await api(app, mgr).del(`/api/attachments/${attId}`)).status).toBe(403)

    // 顺序钉死的意义：如果先判状态再判身份，上面两个 403 会一起变成 409,
    // 等于向无关的人确认了「这张单据存在、且已经提交」—— 单看一个错误码永远看不出来。
  })

  test('★ 管理员也不给别人的单据加附件：读权限 ≠ 写权限', async () => {
    const owner = await login(app, U.ops1)
    const id = await newDraft(app, owner)
    const admin = await login(app, U.admin) // 有 request:read:all / request:approve:all
    // 管理员的读权限覆盖所有单据，但「附件属于单据内容」，加附件仍是申请人专属动作
    expect((await uploadAttachment(app, admin, id, 'boss.png', PNG_BYTES)).status).toBe(403)
    // 对照：同一张单据，管理员**看得见**（证明上面的 403 是写权限而非读权限问题）
    expect((await api(app, admin).get(`/api/requests/${id}`)).status).toBe(200)
  })

  test('★ 附件列表：未登录 401（守卫在前），无关同事 403（不是 404/空列表）', async () => {
    const owner = await login(app, U.ops1)
    const id = await newDraft(app, owner)
    await uploadAttachment(app, owner, id, 'x.png', PNG_BYTES)

    expect((await api(app, null).get(`/api/requests/${id}/attachments`)).status).toBe(401)
    const other = await login(app, U.ops2)
    expect((await api(app, other).get(`/api/requests/${id}/attachments`)).status).toBe(403)
  })

  test('列表严格按单据过滤：两张单各传一个，互不串门', async () => {
    const token = await login(app, U.ops1)
    const idA = await newDraft(app, token)
    const idB = await newDraft(app, token)
    await uploadAttachment(app, token, idA, 'a.png', PNG_BYTES)
    await uploadAttachment(app, token, idB, 'b.png', PNG_BYTES)

    const a = await api(app, token).get(`/api/requests/${idA}/attachments`)
    const b = await api(app, token).get(`/api/requests/${idB}/attachments`)
    expect(a.body.items.map((x) => x.name)).toEqual(['a.png'])
    expect(b.body.items.map((x) => x.name)).toEqual(['b.png'])
  })

  test('父资源不存在时先 404：上传到不存在的单据、删除不存在的附件', async () => {
    const token = await login(app, U.ops1)
    expect((await uploadAttachment(app, token, 999999, 'x.png', PNG_BYTES)).status).toBe(404)
    expect((await api(app, token).del('/api/attachments/999999')).status).toBe(404)
  })
})

describe('附件 · 并发', () => {
  let app
  beforeEach(async () => {
    app = await makeApp()
  })
  afterEach(async () => {
    delete process.env.MAX_UPLOAD_BYTES
    delete process.env.MAX_FILES_PER_REQUEST
    await app.close()
  })

  test('★★ 并发上传不能绕过数量上限（上限检查与插入之间是 TOCTOU）', async () => {
    process.env.MAX_FILES_PER_REQUEST = '2'
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)

    // 5 个请求同时到达：每个都会「先数一遍现在有几个」，而插入发生在 await 之后
    // 先拍一张磁盘快照：本用例之后新增的落盘文件，只有真正入库的那些才配留在盘上
    const listDir = () => (fs.existsSync(uploadDir()) ? fs.readdirSync(uploadDir()) : [])
    const before = new Set(listDir())
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => uploadAttachment(app, token, id, `c${i}.png`, PNG_BYTES)),
    )
    const created = results.filter((r) => r.status === 201).length
    const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM attachments WHERE request_id = ?`).get(id).n

    // 落库条数必须守住上限 —— 无论有多少个请求「同时」通过检查
    expect(rows).toBeLessThanOrEqual(2)
    expect(rows).toBe(created)
    // 被拒的必须是 400（可预期的业务错误），不能是 500
    expect(results.filter((r) => r.status === 400).length).toBe(5 - created)
    expect(results.every((r) => r.status === 201 || r.status === 400)).toBe(true)

    // 磁盘上不能留下「插库被拒、文件却已经落盘」的孤儿：被挤掉的那一次要把盘收回去
    const added = listDir().filter((f) => !before.has(f))
    expect(added).toHaveLength(created)
  })

  test('★ 并发上传同名文件：各自独立落盘，内容不互相覆盖', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)

    // 三个不同的 PNG 内容，客户端全叫同一个名字
    const contents = [0, 1, 2].map((i) => Buffer.concat([PNG_BYTES, Buffer.from(`#payload-${i}`)]))
    const results = await Promise.all(
      contents.map((buf) => uploadAttachment(app, token, id, 'same.png', buf)),
    )
    expect(results.map((r) => r.status)).toEqual([201, 201, 201])

    const rows = getDb().prepare(`SELECT id, stored_name FROM attachments WHERE request_id = ?`).all(id)
    expect(rows).toHaveLength(3)
    // 关键：随机落盘名 → 同名上传既不覆盖磁盘文件，也猜不到彼此
    expect(new Set(rows.map((r) => r.stored_name)).size).toBe(3)

    // 每个下载回来必须是「自己那份」，不能串
    for (const r of results) {
      const dl = await downloadAttachment(app, token, r.body.id)
      const idx = results.indexOf(r)
      expect(Buffer.compare(dl.body, contents[idx])).toBe(0)
    }
  })

  test('并发删除同一个附件：不 500，最终状态一致（列表为空）', async () => {
    const owner = await login(app, U.ops1)
    const id = await newDraft(app, owner)
    const up = await uploadAttachment(app, owner, id, 'x.png', PNG_BYTES)

    const [r1, r2] = await Promise.all([
      api(app, owner).del(`/api/attachments/${up.body.id}`),
      api(app, owner).del(`/api/attachments/${up.body.id}`),
    ])
    // 第二个请求的「合理结局」有两种：要么也 200（幂等删除），要么 404（已被删掉）——但不能 500
    expect([r1.status, r2.status].every((s) => s === 200 || s === 404)).toBe(true)
    expect((await api(app, owner).get(`/api/requests/${id}/attachments`)).body.total).toBe(0)
  })
})

describe('附件 · 边界', () => {
  let app
  beforeEach(async () => {
    app = await makeApp()
  })
  afterEach(async () => {
    delete process.env.MAX_UPLOAD_BYTES
    delete process.env.MAX_FILES_PER_REQUEST
    await app.close()
  })

  test('空文件 → 400（0 字节连魔数都没有，不能当「无害小文件」放进来）', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    const r = await uploadAttachment(app, token, id, 'empty.png', Buffer.alloc(0))
    expect(r.status).toBe(400)
  })

  test('大小上限的临界：恰好等于上限 → 201；多 1 字节 → 400', async () => {
    process.env.MAX_UPLOAD_BYTES = '1024'
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)

    const exact = Buffer.concat([PNG_BYTES, Buffer.alloc(1024 - PNG_BYTES.length, 0x41)])
    expect(exact.length).toBe(1024)
    expect((await uploadAttachment(app, token, id, 'exact.png', exact)).status).toBe(201)

    const over = Buffer.concat([exact, Buffer.from('x')])
    expect(over.length).toBe(1025)
    expect((await uploadAttachment(app, token, id, 'over.png', over)).status).toBe(400)
  })

  test('★ 文件名里的引号/分号被清洗：既污染不了响应头，也污染不了下游展示', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    const nasty = 'evil"; X-Injected: 1; .png'
    const r = await uploadAttachment(app, token, id, nasty, PNG_BYTES)
    expect(r.status).toBe(201)

    // 落库/回显的名字里不能有裸引号（否则任何拼接它进 header 的地方都可能被撕开）
    expect(r.body.name).not.toContain('"')

    const dl = await downloadAttachment(app, token, r.body.id)
    const cd = dl.headers['content-disposition']
    // 头部形状仍然是标准的「两个引号包住 filename + RFC5987 的 filename*」
    expect(cd).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''[^"]*$/)
  })

  test('魔数不足 12 字节 → 400（嗅探需要足够字节，宁拒勿放）', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    // 只有 PNG 的 8 字节签名，没有任何后续内容 —— 不可能是一张合法图片
    const stub = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const r = await uploadAttachment(app, token, id, 'tiny.png', stub)
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toContain('不支持的文件类型')
  })

  test('改名伪装：exe 内容 + pdf 扩展名，同样按真实字节挡下', async () => {
    const token = await login(app, U.ops1)
    const id = await newDraft(app, token)
    const r = await uploadAttachment(app, token, id, 'report.pdf', FAKE_EXE_BYTES, {
      contentType: 'application/pdf',
    })
    expect(r.status).toBe(400)
  })
})
