// 站内通知（M3）
//
// 这块的测试重点不是「有没有通知」，而是四个容易漏的性质：
//   ① ★ 通知正文里的轮次是**快照** —— 单据重提后旧通知不许改口
//   ② ★ 「不是你的通知」与「不存在的通知」必须**完全一样**地失败（不泄漏存在性）
//   ③ ★ 写通知与状态变更**同事务** —— 审批回滚了不许留下通知，审批成功也不许漏通知
//   ④ ★ 不给自己发通知，且撤回只通知「还没处理的人」
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ID, MATERIAL_FORM, U, api, createAndSubmit, login, makeApp } from './helpers.js'
import { getDb } from '../server/db.js'

describe('站内通知（M3）', () => {
  let app
  let ops1 // 申请人：内容运营专员，直属上级 = opsMgr
  let opsMgr // 内容运营经理（leave 第 1 级 / material 会签之一）
  let hr // 人事（leave 第 2 级）
  let exeMgr // 艺人执行经理（material 会签之一）
  let exe1 // 无关的另一个部门员工（用于横向越权）

  beforeEach(async () => {
    app = await makeApp()
    ops1 = await login(app, U.ops1)
    opsMgr = await login(app, U.opsMgr)
    hr = await login(app, U.hr)
    exeMgr = await login(app, U.exeMgr)
    exe1 = await login(app, U.exe1)
  })
  afterEach(async () => {
    await app.close()
  })

  const inbox = async (token, query) => {
    const r = await api(app, token).get('/api/notifications', query)
    expect(r.status).toBe(200)
    return r.body
  }
  const unread = async (token) => (await api(app, token).get('/api/notifications/unread-count')).body.unread

  // -------------------------------------------------------------------------
  // A. 谁该收到、谁不该收到
  // -------------------------------------------------------------------------

  test('提交后 → 第一级审批人收到「待审批」通知，申请人自己不收到', async () => {
    const { id } = await createAndSubmit(app, ops1, { title: '国庆请假' })

    const mgrBox = await inbox(opsMgr)
    expect(mgrBox.total).toBe(1)
    expect(mgrBox.items[0].type).toBe('task')
    expect(mgrBox.items[0].title).toContain('国庆请假')
    expect(mgrBox.items[0].requestId).toBe(id)
    expect(mgrBox.items[0].round).toBe(1)
    // 正文要说清「谁提的、什么类型、第几轮、卡在哪个环节」
    expect(mgrBox.items[0].body).toContain('赵西') // 申请人姓名（不是用户名）
    expect(mgrBox.items[0].body).toContain('直属上级审批')
    expect(mgrBox.items[0].read).toBe(false)

    // ★ 申请人自己不该收到任何通知（提交这件事是他自己做的）
    expect(await unread(ops1)).toBe(0)
  })

  test('会签（dept_scoped=0）：同角色下每个经理都收到', async () => {
    await createAndSubmit(app, ops1, { type: 'material', title: '活动物料', formData: MATERIAL_FORM })

    expect(await unread(opsMgr)).toBe(1)
    expect(await unread(exeMgr)).toBe(1) // 跨部门经理也在会签名单里
    expect(await unread(exe1)).toBe(0) // 专员不是审批人
  })

  test('★ 自己不给自己发：经理提交、自己又在该角色审批人名单里时，跳过自己', async () => {
    // material 第 1 级是 role=dept_manager / dept_scoped=0 → 命中 opsMgr 与 exeMgr
    // 申请人正是 opsMgr → 他应该只收到「exeMgr 那份是别人的」，自己那份不发
    await createAndSubmit(app, opsMgr, { type: 'material', title: '经理自己的物料单', formData: MATERIAL_FORM })

    expect(await unread(opsMgr)).toBe(0)
    expect(await unread(exeMgr)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // B. 推进 / 归档 / 驳回
  // -------------------------------------------------------------------------

  test('一级通过 → 推进到下一级，通知下一级审批人', async () => {
    const { id } = await createAndSubmit(app, ops1, { title: '请假' })
    expect(await unread(hr)).toBe(0)

    const r = await api(app, opsMgr).post(`/api/requests/${id}/approve`, { comment: '同意' })
    expect(r.status).toBe(200)
    expect(r.body.currentStep).toBe(2)

    const hrBox = await inbox(hr)
    expect(hrBox.total).toBe(1)
    expect(hrBox.items[0].type).toBe('task')
    expect(hrBox.items[0].body).toContain('人事复核')
  })

  test('最后一级通过 → 归档，通知申请人（正文含审批人姓名）', async () => {
    const { id } = await createAndSubmit(app, ops1, { title: '请假' })
    await api(app, opsMgr).post(`/api/requests/${id}/approve`, { comment: '同意' })
    const r = await api(app, hr).post(`/api/requests/${id}/approve`, { comment: '复核通过' })
    expect(r.body.status).toBe('approved')

    const my = await inbox(ops1)
    expect(my.total).toBe(1)
    expect(my.items[0].type).toBe('approved')
    expect(my.items[0].title).toContain('已通过')
    // 「谁批的」要写进正文（用真实姓名，不是用户名），而不是让前端再回查一次
    expect(my.items[0].body).toContain('李南')
  })

  test('驳回 → 通知申请人，且把驳回意见带进正文', async () => {
    const { id } = await createAndSubmit(app, ops1, { title: '请假' })
    await api(app, opsMgr).post(`/api/requests/${id}/reject`, { comment: '人手不足，改到下周' })

    const my = await inbox(ops1)
    expect(my.total).toBe(1)
    expect(my.items[0].type).toBe('rejected')
    expect(my.items[0].body).toContain('人手不足，改到下周')
    expect(my.items[0].round).toBe(1)
  })

  // -------------------------------------------------------------------------
  // C. ★ round 是快照
  // -------------------------------------------------------------------------

  test('★ 驳回后重提：新通知是第 2 轮，但旧的那条仍是第 1 轮（不许改口）', async () => {
    const { id } = await createAndSubmit(app, ops1, { title: '请假' })
    await api(app, opsMgr).post(`/api/requests/${id}/reject`, { comment: '重写理由' })

    const first = (await inbox(ops1)).items[0]
    expect(first.round).toBe(1)

    // 重提 → round 变 2
    const again = await api(app, ops1).post(`/api/requests/${id}/submit`)
    expect(again.body.round).toBe(2)

    // 单据现在是第 2 轮，但**那条第 1 轮的驳回通知必须原样不动**
    const all = await inbox(ops1)
    expect(all.total).toBe(1)
    expect(all.items[0].id).toBe(first.id)
    expect(all.items[0].round).toBe(1)
    expect(all.items[0].title).toContain('被驳回')

    // 新的「第 2 轮待审批」通知发给经理，轮次是 2
    const newTasks = (await inbox(opsMgr)).items.filter((n) => n.type === 'task')
    expect(newTasks.length).toBe(2)
    expect(newTasks[0].round).toBe(2)
    expect(newTasks[1].round).toBe(1)
  })

  // -------------------------------------------------------------------------
  // D. 撤回
  // -------------------------------------------------------------------------

  test('撤回 → 通知「还没处理」的审批人', async () => {
    const { id } = await createAndSubmit(app, ops1, { title: '请假' })
    const r = await api(app, ops1).post(`/api/requests/${id}/cancel`)
    expect(r.body.status).toBe('cancelled')

    const mgrBox = await inbox(opsMgr)
    const cancelled = mgrBox.items.filter((n) => n.type === 'cancelled')
    expect(cancelled.length).toBe(1)
    expect(cancelled[0].body).toContain('撤回')
  })

  test('★ 撤回只通知「还没处理的人」：已经批过的审批人不该再收到撤回通知', async () => {
    const { id } = await createAndSubmit(app, ops1, { title: '请假' })
    await api(app, opsMgr).post(`/api/requests/${id}/approve`, { comment: '同意' }) // opsMgr 已处理完
    await api(app, ops1).post(`/api/requests/${id}/cancel`)

    // hr 是当前未处理的人 → 收到撤回通知
    expect((await inbox(hr)).items.filter((n) => n.type === 'cancelled').length).toBe(1)
    // opsMgr 处理完了 → 不该被这条撤回打扰
    expect((await inbox(opsMgr)).items.filter((n) => n.type === 'cancelled').length).toBe(0)
  })

  test('撤草稿 → 没有待审任务，因此没有任何撤回通知', async () => {
    const c = await api(app, ops1).post('/api/requests', {
      type: 'leave',
      title: '还没提交',
      formData: { startDate: '2026-10-08', endDate: '2026-10-09', days: 1, reason: '先留着' },
    })
    await api(app, ops1).post(`/api/requests/${c.body.id}/cancel`)
    expect(await unread(opsMgr)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // E. 列表 / 未读数
  // -------------------------------------------------------------------------

  test('列表只返回自己的通知（跨用户隔离）', async () => {
    await createAndSubmit(app, ops1, { title: 'A' })
    const mine = await inbox(opsMgr)
    const others = await inbox(exe1)
    expect(mine.total).toBe(1)
    expect(others.total).toBe(0)
    expect(others.unread).toBe(0)
  })

  test('新的在前（id 倒序）', async () => {
    await createAndSubmit(app, ops1, { title: '第一单' })
    await createAndSubmit(app, ops1, { title: '第二单' })
    const box = await inbox(opsMgr)
    expect(box.items[0].title).toContain('第二单')
    expect(box.items[1].title).toContain('第一单')
  })

  test('?unread=1 只返回未读', async () => {
    const { id } = await createAndSubmit(app, ops1, { title: '请假' })
    await api(app, opsMgr).post(`/api/requests/${id}/reject`, { comment: '不行' }) // 再给 opsMgr 攒一条？
    await createAndSubmit(app, ops1, { title: '第二单' })

    const all = await inbox(opsMgr)
    expect(all.total).toBe(2)
    await api(app, opsMgr).post(`/api/notifications/${all.items[0].id}/read`)

    const onlyUnread = await inbox(opsMgr, { unread: 1 })
    expect(onlyUnread.total).toBe(1)
    expect(onlyUnread.items[0].read).toBe(false)
  })

  test('★ 列表返回的 unread 是「全量未读」，不是「本页未读」（分页不许把角标算少）', async () => {
    await createAndSubmit(app, ops1, { title: '单1' })
    await createAndSubmit(app, ops1, { title: '单2' })
    await createAndSubmit(app, ops1, { title: '单3' })

    const page = await inbox(opsMgr, { limit: 1 })
    expect(page.items.length).toBe(1)
    expect(page.unread).toBe(3) // ← 若用「本页未读数」会得到 1，角标就撒谎了
  })

  // -------------------------------------------------------------------------
  // F. 已读
  // -------------------------------------------------------------------------

  test('标记已读 → read=true、changed=true、未读数 -1', async () => {
    await createAndSubmit(app, ops1, { title: '请假' })
    const n = (await inbox(opsMgr)).items[0]

    const r = await api(app, opsMgr).post(`/api/notifications/${n.id}/read`)
    expect(r.status).toBe(200)
    expect(r.body.read).toBe(true)
    expect(r.body.changed).toBe(true)
    expect(r.body.unread).toBe(0)
    expect(r.body.readAt).toBeTruthy()
  })

  test('★ 重复标记已读是幂等的：返回 200 + changed:false，且不改动首次已读时间', async () => {
    await createAndSubmit(app, ops1, { title: '请假' })
    const n = (await inbox(opsMgr)).items[0]

    const first = await api(app, opsMgr).post(`/api/notifications/${n.id}/read`)
    const second = await api(app, opsMgr).post(`/api/notifications/${n.id}/read`)

    expect(second.status).toBe(200)
    expect(second.body.changed).toBe(false)
    expect(second.body.readAt).toBe(first.body.readAt) // 第二次不该把时间刷成新的
  })

  test('全部已读 → 只清自己的未读；再点一次 updated=0', async () => {
    await createAndSubmit(app, ops1, { title: '单1' })
    await createAndSubmit(app, ops1, { title: '单2' })
    await createAndSubmit(app, exe1, { title: '别的部门' }) // exe1 的上级是 exeMgr

    const r = await api(app, opsMgr).post('/api/notifications/read-all')
    expect(r.body.updated).toBe(2)
    expect(r.body.unread).toBe(0)
    expect(await unread(opsMgr)).toBe(0)

    const again = await api(app, opsMgr).post('/api/notifications/read-all')
    expect(again.body.updated).toBe(0)

    // ★ 不许顺手把别人的未读也清掉
    expect(await unread(exeMgr)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // G. ★ 越权：不泄漏「这条通知存不存在」
  // -------------------------------------------------------------------------

  test('★ 别人的通知 与 不存在的通知 → 完全相同的 404（含文案）', async () => {
    await createAndSubmit(app, ops1, { title: '请假' })
    const others = (await inbox(opsMgr)).items[0]

    const stolen = await api(app, exe1).post(`/api/notifications/${others.id}/read`)
    const missing = await api(app, exe1).post('/api/notifications/999999/read')

    expect(stolen.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(stolen.body).toEqual(missing.body) // 一模一样，连文案都不给差分
  })

  test('别人的通知不会因为「读一下」变成已读', async () => {
    await createAndSubmit(app, ops1, { title: '请假' })
    const n = (await inbox(opsMgr)).items[0]
    await api(app, exe1).post(`/api/notifications/${n.id}/read`)
    expect(await unread(opsMgr)).toBe(1)
  })

  test('id 非正整数 → 400', async () => {
    expect((await api(app, opsMgr).post('/api/notifications/abc/read')).status).toBe(400)
    expect((await api(app, opsMgr).post('/api/notifications/0/read')).status).toBe(400)
  })

  test('未登录读通知 → 401', async () => {
    expect((await api(app, null).get('/api/notifications')).status).toBe(401)
    expect((await api(app, null).get('/api/notifications/unread-count')).status).toBe(401)
    expect((await api(app, null).post('/api/notifications/read-all')).status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // H. ★ 同事务：审批回滚了不许留下通知
  // -------------------------------------------------------------------------

  test('★ 审批因流程配置问题回滚时：不留半截状态，也不留下通知', async () => {
    const { id } = await createAndSubmit(app, ops1, { title: '请假' })

    // 把人事停用 → leave 第 2 级（role=hr）解析不出审批人 → 推进时抛 409 并回滚
    const off = await api(app, await login(app, U.admin)).patch(`/api/users/${ID.hr}`, { status: 'disabled' })
    expect(off.status).toBe(200)

    const r = await api(app, opsMgr).post(`/api/requests/${id}/approve`, { comment: '同意' })
    expect(r.status).toBe(409)

    // ① 状态没有半截：单据还停在第 1 步，opsMgr 的任务仍是「待审」
    const detail = await api(app, opsMgr).get(`/api/requests/${id}`)
    expect(detail.body.status).toBe('pending')
    expect(detail.body.currentStep).toBe(1)
    expect(detail.body.tasks.filter((t) => t.round === 1).every((t) => t.action === null)).toBe(true)

    // ② 通知也没有漏出来（否则会出现「有人收到通知、但单据没动」的鬼状态）。
    //    这里直接查库而不是调接口：hr 已被停用，接口层会先 401 —— 那正好顺带证明了
    //    「停用账号后旧 token 立刻失效」，是另一条已有用例在管的事。
    const leaked = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?`)
      .get(ID.hr).n
    expect(leaked).toBe(0)
    // 半截状态也没留：opsMgr 那条任务没被写成 approve
    const acted = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM approval_tasks WHERE request_id = ? AND action IS NOT NULL`)
      .get(id).n
    expect(acted).toBe(0)
  })

  test('审批成功后 → 通知一定在（不许出现「批了但没人知道」）', async () => {
    const { id } = await createAndSubmit(app, ops1, { title: '请假' })
    await api(app, opsMgr).post(`/api/requests/${id}/approve`, { comment: '同意' })

    const hrBox = await inbox(hr)
    expect(hrBox.total).toBe(1)
    expect(hrBox.items[0].requestId).toBe(id)
  })
})
