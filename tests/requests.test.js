// 表单校验边界 + 列表/详情
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ID, MATERIAL_FORM, U, api, createAndSubmit, login, makeApp } from './helpers.js'

const VALID_LEAVE = { startDate: '2026-10-08', endDate: '2026-10-09', days: 2, reason: '家中有事需要请假' }

describe('单据表单校验', () => {
  let app
  let token
  beforeEach(async () => {
    app = await makeApp()
    token = await login(app, U.ops1)
  })
  afterEach(async () => {
    await app.close()
  })

  const create = (payload) => api(app, token).post('/api/requests', payload)

  test('合法请假单 → 201', async () => {
    const r = await create({ type: 'leave', title: '请假', formData: VALID_LEAVE })
    expect(r.status).toBe(201)
    expect(r.body.formData).toEqual(VALID_LEAVE)
  })

  test('合法物料单 → 201', async () => {
    const r = await create({ type: 'material', title: '物料申请', formData: MATERIAL_FORM })
    expect(r.status).toBe(201)
  })

  test('未知单据类型 → 400', async () => {
    const r = await create({ type: 'reimburse', title: '报销', formData: {} })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('不支持的单据类型')
  })

  test('缺 title / title 全空格 → 400', async () => {
    expect((await create({ type: 'leave', formData: VALID_LEAVE })).status).toBe(400)
    expect((await create({ type: 'leave', title: '   ', formData: VALID_LEAVE })).status).toBe(400)
  })

  test('title 超过 200 字 → 400', async () => {
    const r = await create({ type: 'leave', title: '长'.repeat(201), formData: VALID_LEAVE })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('200')
  })

  test('formData 不是对象 → 400', async () => {
    expect((await create({ type: 'leave', title: 'x', formData: 'not-an-object' })).status).toBe(400)
    expect((await create({ type: 'leave', title: 'x', formData: [1, 2, 3] })).status).toBe(400)
  })

  test('请假：日期格式不对 → 400', async () => {
    const r = await create({ type: 'leave', title: 'x', formData: { ...VALID_LEAVE, startDate: '2026/10/08' } })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('startDate')
  })

  test('★ 请假：结束日期早于开始日期 → 400', async () => {
    const r = await create({
      type: 'leave',
      title: 'x',
      formData: { ...VALID_LEAVE, startDate: '2026-10-10', endDate: '2026-10-08' },
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('endDate 不能早于 startDate')
  })

  test('请假：理由太短 → 400', async () => {
    const r = await create({ type: 'leave', title: 'x', formData: { ...VALID_LEAVE, reason: '事' } })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('reason')
  })

  test('请假：days 为 0 或负数 → 400', async () => {
    expect((await create({ type: 'leave', title: 'x', formData: { ...VALID_LEAVE, days: 0 } })).status).toBe(400)
    expect((await create({ type: 'leave', title: 'x', formData: { ...VALID_LEAVE, days: -1 } })).status).toBe(400)
  })

  test('物料：items 空数组 → 400', async () => {
    const r = await create({ type: 'material', title: 'x', formData: { ...MATERIAL_FORM, items: [] } })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('items')
  })

  test('物料：qty 非正数 → 400', async () => {
    const r = await create({
      type: 'material',
      title: 'x',
      formData: { ...MATERIAL_FORM, items: [{ name: '折叠椅', qty: 0 }] },
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('qty')
  })

  test('物料：link 不是 http(s) → 400', async () => {
    const r = await create({ type: 'material', title: 'x', formData: { ...MATERIAL_FORM, link: 'ftp://a.com/x' } })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('link')
  })

  test('★ 一次返回全部校验问题，而不是只报第一条', async () => {
    const r = await create({ type: 'leave', title: 'x', formData: { startDate: 'bad', endDate: 'bad', reason: 'a' } })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('startDate')
    expect(r.body.error).toContain('endDate')
    expect(r.body.error).toContain('reason')
  })
})

describe('单据列表与详情', () => {
  let app
  let tokens
  beforeEach(async () => {
    app = await makeApp()
    tokens = {
      hr: await login(app, U.hr),
      ops1: await login(app, U.ops1),
      opsMgr: await login(app, U.opsMgr),
    }
  })
  afterEach(async () => {
    await app.close()
  })

  test('列表支持按状态/类型过滤', async () => {
    await createAndSubmit(app, tokens.ops1, { title: '待审请假' })
    const pending = await api(app, tokens.ops1).get('/api/requests', { status: 'pending' })
    expect(pending.body.items.every((x) => x.status === 'pending')).toBe(true)
    expect(pending.body.items.some((x) => x.title === '待审请假')).toBe(true)

    const drafts = await api(app, tokens.ops1).get('/api/requests', { status: 'draft' })
    expect(drafts.body.items.every((x) => x.type === 'leave' || x.type === 'material')).toBe(true)
  })

  test('单据详情包含申请人与审批时间线', async () => {
    const t = await createAndSubmit(app, tokens.ops1, { title: '带时间线的单据' })
    const r = await api(app, tokens.ops1).get(`/api/requests/${t.id}`)
    expect(r.status).toBe(200)
    expect(r.body.applicantName).toBe('赵西')
    expect(Array.isArray(r.body.tasks)).toBe(true)
    expect(r.body.tasks.length).toBeGreaterThan(0)
    expect(r.body.tasks[0]).toHaveProperty('approverName')
    expect(r.body.tasks[0]).toHaveProperty('stepNo')
    expect(r.body.tasks[0]).toHaveProperty('round')
  })

  test('审批轨道完整走完后，tasks 里能看到两级都 approve', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '一级同意' })
    await api(app, tokens.hr).post(`/api/requests/${t.id}/approve`, { comment: '二级同意' })

    const r = await api(app, tokens.ops1).get(`/api/requests/${t.id}`)
    const approved = r.body.tasks.filter((x) => x.action === 'approve')
    expect(approved).toHaveLength(2)
    expect(approved.map((x) => x.stepNo).sort()).toEqual([1, 2])
  })

  test('单据类型元数据接口可用（前端据此渲染表单）', async () => {
    const r = await api(app, tokens.ops1).get('/api/request-types')
    expect(r.status).toBe(200)
    const types = r.body.items.map((x) => x.type)
    expect(types).toEqual(expect.arrayContaining(['leave', 'material', 'purchase']))
  })

  test('公告列表：登录即可读，置顶排前面', async () => {
    const r = await api(app, tokens.ops1).get('/api/announcements')
    expect(r.status).toBe(200)
    expect(r.body.items.length).toBeGreaterThan(0)
    expect(r.body.items[0].pinned).toBe(true)
  })

  test('审计日志：审批动作被记录下来（可追溯谁在什么时候批了什么）', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '同意' })

    const logs = await api(app, await login(app, U.admin)).get('/api/audit-logs')
    const actions = logs.body.items.map((l) => l.action)
    expect(actions).toContain('request.create')
    expect(actions).toContain('request.submit')
    expect(actions).toContain('request.approve')
    const approveLog = logs.body.items.find((l) => l.action === 'request.approve')
    expect(approveLog.userId).toBe(ID.opsMgr)
    expect(approveLog.targetId).toBe(String(t.id))
  })
})
