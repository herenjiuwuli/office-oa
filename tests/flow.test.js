// 审批引擎用例：状态机 / 多级审批 / 会签或签 / 并发 / 流程快照
// 这组用例是「我是怎么测自己的系统」的直接证据，面试时可以直接拿出来讲。
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { getDb } from '../server/db.js'
import { ID, MATERIAL_FORM, PURCHASE_FORM, U, api, createAndSubmit, login, makeApp } from './helpers.js'

const LEAVE_DRAFT = { startDate: '2026-10-08', endDate: '2026-10-09', reason: '家中有事需要请假' }

describe('审批引擎', () => {
  let app
  let tokens
  beforeEach(async () => {
    app = await makeApp()
    tokens = {
      admin: await login(app, U.admin),
      hr: await login(app, U.hr),
      opsMgr: await login(app, U.opsMgr), // 王东：赵西/孙小 的直属上级
      ops1: await login(app, U.ops1), // 赵西：申请人
      exeMgr: await login(app, U.exeMgr), // 周大：另一个部门经理
    }
  })
  afterEach(async () => {
    await app.close()
  })

  // ---------------- 建单与提交 ----------------

  test('建单只生成草稿，不自动进入审批', async () => {
    const r = await api(app, tokens.ops1).post('/api/requests', {
      type: 'leave',
      title: '请假',
      formData: LEAVE_DRAFT,
    })
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('draft')
    expect(r.body.currentStep).toBe(0)
    expect(r.body.round).toBe(1)
  })

  test('提交草稿 → pending / currentStep=1 / 生成第一步待审任务', async () => {
    const t = await createAndSubmit(app, tokens.ops1, { title: '赵西请假' })
    expect(t.status).toBe(200)
    expect(t.body.status).toBe('pending')
    expect(t.body.currentStep).toBe(1)

    const detail = await api(app, tokens.ops1).get(`/api/requests/${t.id}`)
    expect(detail.body.flowSnapshot).toHaveLength(2) // 两级审批
    const pending = detail.body.tasks.filter((x) => x.action === null)
    expect(pending).toHaveLength(1)
    expect(pending[0].approverId).toBe(ID.opsMgr) // 直属上级
    expect(pending[0].stepNo).toBe(1)
  })

  test('待办列表：审批人看得到，无关的人看不到', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    const managerTodo = await api(app, tokens.opsMgr).get('/api/todo')
    expect(managerTodo.body.items.some((i) => i.requestId === t.id)).toBe(true)

    const ownTodo = await api(app, tokens.ops1).get('/api/todo')
    expect(ownTodo.body.items.some((i) => i.requestId === t.id)).toBe(false)

    const unrelated = await api(app, tokens.exeMgr).get('/api/todo')
    expect(unrelated.body.items.some((i) => i.requestId === t.id)).toBe(false)
  })

  test('★ 状态机：重复提交 → 409', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    const again = await api(app, tokens.ops1).post(`/api/requests/${t.id}/submit`)
    expect(again.status).toBe(409)
    expect(again.body.error).toContain('pending')
  })

  // ---------------- 多级审批 ----------------

  test('一级通过 → 推进到第二级并重新分配任务', async () => {
    const t = await createAndSubmit(app, tokens.ops1)

    const step1 = await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '同意' })
    expect(step1.status).toBe(200)
    expect(step1.body.status).toBe('pending')
    expect(step1.body.currentStep).toBe(2)

    // 第一级的待办消失，第二级（人事）出现
    expect((await api(app, tokens.opsMgr).get('/api/todo')).body.items.some((i) => i.requestId === t.id)).toBe(false)
    expect((await api(app, tokens.hr).get('/api/todo')).body.items.some((i) => i.requestId === t.id)).toBe(true)
  })

  test('两级都通过 → approved', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '同意' })
    const last = await api(app, tokens.hr).post(`/api/requests/${t.id}/approve`, { comment: '复核通过' })
    expect(last.status).toBe(200)
    expect(last.body.status).toBe('approved')
  })

  test('一级驳回 → rejected，且批注落库', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    const r = await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/reject`, { comment: '这周人手不够，改期' })
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('rejected')

    const detail = await api(app, tokens.ops1).get(`/api/requests/${t.id}`)
    const rejected = detail.body.tasks.find((x) => x.action === 'reject')
    expect(rejected.comment).toBe('这周人手不够，改期')
    expect(rejected.approverId).toBe(ID.opsMgr)
    expect(rejected.actedAt).toBeTruthy()
  })

  test('★ 与单据无关的人审批 → 403（人事不能抢先审第一级）', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    const r = await api(app, tokens.hr).post(`/api/requests/${t.id}/approve`, { comment: '我先批了' })
    expect(r.status).toBe(403)
    expect(r.body.error).toContain('审批人')
  })

  test('★ 相关但不是「当前这一步」的审批人 → 403（上一级审完就不能再插手）', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '同意' }) // 已推进到第 2 步

    const r = await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '我再批一次' })
    expect(r.status).toBe(403)
    expect(r.body.error).toContain('不是当前步骤')
  })

  test('★ 已归档的单据不能再审批/驳回 → 409', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '同意' })
    await api(app, tokens.hr).post(`/api/requests/${t.id}/approve`, { comment: '同意' })

    expect((await api(app, tokens.hr).post(`/api/requests/${t.id}/approve`)).status).toBe(409)
    expect((await api(app, tokens.hr).post(`/api/requests/${t.id}/reject`, { comment: '反悔' })).status).toBe(409)
  })

  test('★ 驳回后重提：轮次 +1，且上一轮的审批痕迹保留', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/reject`, { comment: '材料不全' })

    const resubmitted = await api(app, tokens.ops1).post(`/api/requests/${t.id}/submit`)
    expect(resubmitted.status).toBe(200)
    expect(resubmitted.body.status).toBe('pending')
    expect(resubmitted.body.round).toBe(2)

    const detail = await api(app, tokens.ops1).get(`/api/requests/${t.id}`)
    const round1 = detail.body.tasks.filter((x) => x.round === 1)
    const round2 = detail.body.tasks.filter((x) => x.round === 2)
    // 第一轮的驳回记录还在（不是被覆盖）
    expect(round1.some((x) => x.action === 'reject' && x.comment === '材料不全')).toBe(true)
    // 第二轮重新生成了待审任务
    expect(round2.filter((x) => x.action === null)).toHaveLength(1)
  })

  // ---------------- 会签 / 或签 ----------------

  test('★ 会签（all）：一人批完仍 pending，集齐后推进', async () => {
    const t = await createAndSubmit(app, tokens.ops1, { type: 'material', formData: MATERIAL_FORM })
    expect(t.status).toBe(200)

    const first = await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '内容没问题' })
    expect(first.status).toBe(200)
    expect(first.body.status).toBe('pending') // 关键：不能提前通过
    expect(first.body.currentStep).toBe(1)

    const second = await api(app, tokens.exeMgr).post(`/api/requests/${t.id}/approve`, { comment: '同意' })
    expect(second.body.currentStep).toBe(2) // 会签集齐才推进

    const final = await api(app, tokens.admin).post(`/api/requests/${t.id}/approve`, { comment: '批准' })
    expect(final.body.status).toBe('approved')
  })

  test('★ 会签中有人驳回 → 立即 rejected，同轮其他人的待审被关闭', async () => {
    const t = await createAndSubmit(app, tokens.ops1, { type: 'material', formData: MATERIAL_FORM })
    const r = await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/reject`, { comment: '预算超标' })
    expect(r.body.status).toBe('rejected')

    // 周大的待审任务不该再挂在待办里
    expect((await api(app, tokens.exeMgr).get('/api/todo')).body.items.some((i) => i.requestId === t.id)).toBe(false)
    const detail = await api(app, tokens.ops1).get(`/api/requests/${t.id}`)
    expect(detail.body.tasks.find((x) => x.approverId === ID.exeMgr).action).toBe('skip')
  })

  test('★ 或签（any）：任一人批即通过；第二人再批 → 409', async () => {
    const t = await createAndSubmit(app, tokens.ops1, { type: 'purchase', formData: PURCHASE_FORM })
    const first = await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '同意' })
    expect(first.status).toBe(200)
    expect(first.body.status).toBe('approved') // 单步或签，直接归档

    const second = await api(app, tokens.exeMgr).post(`/api/requests/${t.id}/approve`, { comment: '我也同意' })
    expect(second.status).toBe(409)
  })

  // ---------------- 并发 / 重复提交 ----------------

  test('★ 同一人重复审批同一任务 → 第二次 409（条件更新防线）', async () => {
    const t = await createAndSubmit(app, tokens.ops1, { type: 'material', formData: MATERIAL_FORM })
    const first = await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '第一次' })
    expect(first.status).toBe(200)

    const second = await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '第二次' })
    expect(second.status).toBe(409)
    expect(second.body.error).toContain('已被处理')
  })

  test('★ 并发：同一审批人同时提交两次 → 恰好一个 200、一个 409', async () => {
    const t = await createAndSubmit(app, tokens.ops1, { type: 'material', formData: MATERIAL_FORM })
    const url = `/api/requests/${t.id}/approve`

    const [a, b] = await Promise.all([
      api(app, tokens.opsMgr).post(url, { comment: '并发 A' }),
      api(app, tokens.opsMgr).post(url, { comment: '并发 B' }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])

    // 只应写入一条决定
    const detail = await api(app, tokens.ops1).get(`/api/requests/${t.id}`)
    const mine = detail.body.tasks.filter((x) => x.approverId === ID.opsMgr)
    expect(mine.filter((x) => x.action === 'approve')).toHaveLength(1)
  })

  // ---------------- 撤回 ----------------

  test('撤回待审单据 → cancelled，待审任务被关闭', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    const r = await api(app, tokens.ops1).post(`/api/requests/${t.id}/cancel`)
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('cancelled')
    expect((await api(app, tokens.opsMgr).get('/api/todo')).body.items.some((i) => i.requestId === t.id)).toBe(false)
  })

  test('★ 已归档的单据不能撤回 → 409（种子单据 3 属于孙小且已 approved）', async () => {
    const ops2 = await login(app, U.ops2)
    const r = await api(app, ops2).post('/api/requests/3/cancel')
    expect(r.status).toBe(409)
  })

  // ---------------- 边界 ----------------

  test('★ 申请人没有直属上级 → 409 且有可读提示（不是 500），单据回滚为草稿', async () => {
    const noMgr = await login(app, U.noMgr)
    const client = api(app, noMgr)
    const created = await client.post('/api/requests', { type: 'leave', title: '无上级的请假', formData: LEAVE_DRAFT })
    expect(created.status).toBe(201)

    const submitted = await client.post(`/api/requests/${created.body.id}/submit`)
    expect(submitted.status).toBe(409)
    expect(submitted.body.error).toContain('直属上级')

    const detail = await client.get(`/api/requests/${created.body.id}`)
    expect(detail.body.status).toBe('draft') // 事务干净回滚，没留半截状态
  })

  test('单据不存在 → 404（提交/审批/撤回都是）', async () => {
    expect((await api(app, tokens.ops1).get('/api/requests/9999')).status).toBe(404)
    expect((await api(app, tokens.ops1).post('/api/requests/9999/submit')).status).toBe(404)
    expect((await api(app, tokens.opsMgr).post('/api/requests/9999/approve')).status).toBe(404)
    expect((await api(app, tokens.ops1).post('/api/requests/9999/cancel')).status).toBe(404)
  })

  test('审批批注超长 → 400', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    const r = await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: 'x'.repeat(501) })
    expect(r.status).toBe(400)
  })

  test('★ 流程快照：审批中修改流程模板，在途单据仍按老流程走完', async () => {
    const t = await createAndSubmit(app, tokens.ops1) // leave 快照 = 2 步

    // 管理员把 leave 模板改成「只剩一步」（模拟流程改版）
    const db = getDb()
    db.prepare(`DELETE FROM flow_steps WHERE flow_id = 1`).run()
    db.prepare(
      `INSERT INTO flow_steps (flow_id, step_no, name, approver_type, approver_ref, mode)
       VALUES (1, 1, '唯一审批人（新模板）', 'user', '1', 'any')`,
    ).run()

    // 在途单据仍应按「快照里的两步」走：一级通过后应推进到第 2 步，而不是直接归档
    const after1 = await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '同意' })
    expect(after1.status).toBe(200)
    expect(after1.body.status).toBe('pending')
    expect(after1.body.currentStep).toBe(2)

    // 第二级（人事复核）仍按快照分配给了 hr
    const after2 = await api(app, tokens.hr).post(`/api/requests/${t.id}/approve`, { comment: '复核通过' })
    expect(after2.body.status).toBe('approved')

    // 对照：新提交的单据才会用新模板（只有一步，直属上级就不再是审批人了）
    const fresh = await createAndSubmit(app, tokens.ops1, { title: '改版后新提交' })
    const detail = await api(app, tokens.ops1).get(`/api/requests/${fresh.id}`)
    expect(detail.body.flowSnapshot).toHaveLength(1)
    expect(detail.body.flowSnapshot[0].name).toBe('唯一审批人（新模板）')
  })
})
