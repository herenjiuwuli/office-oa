// 权限（纵向越权 / 横向越权）+ 管理类接口边界
// 这是本项目最该写厚的一组用例：面试问「给你一个系统怎么设计用例」，答案就在这个文件里。
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ID, MATERIAL_FORM, PURCHASE_FORM, U, api, createAndSubmit, login, makeApp } from './helpers.js'

describe('权限控制', () => {
  let app
  let tokens
  beforeEach(async () => {
    app = await makeApp()
    tokens = {
      admin: await login(app, U.admin),
      hr: await login(app, U.hr),
      opsMgr: await login(app, U.opsMgr),
      ops1: await login(app, U.ops1),
      ops2: await login(app, U.ops2),
      exeMgr: await login(app, U.exeMgr),
      exe1: await login(app, U.exe1),
      noMgr: await login(app, U.noMgr),
    }
  })
  afterEach(async () => {
    await app.close()
  })

  // ---------------- 纵向越权：低权限角色碰高权限接口 ----------------

  test('★ 纵向越权：普通员工读员工列表 → 403（不是 401、也不是 200）', async () => {
    const r = await api(app, tokens.ops1).get('/api/users')
    expect(r.status).toBe(403)
    expect(r.body.error).toContain('user:read')
  })

  test('人事 / 部门经理 / 总经理读员工列表 → 200', async () => {
    expect((await api(app, tokens.hr).get('/api/users')).status).toBe(200)
    expect((await api(app, tokens.opsMgr).get('/api/users')).status).toBe(200)
    expect((await api(app, tokens.admin).get('/api/users')).status).toBe(200)
  })

  test('普通员工增改员工 → 403', async () => {
    const post = await api(app, tokens.ops1).post('/api/users', {
      username: 'hacker',
      password: 'oa123456',
      realName: '越权用户',
    })
    expect(post.status).toBe(403)
    expect((await api(app, tokens.ops1).patch(`/api/users/${ID.ops2}`, { position: '被篡改' })).status).toBe(403)
    // 确认真的没改进去
    const list = await api(app, tokens.hr).get('/api/users')
    expect(list.body.items.find((u) => u.id === ID.ops2).position).toBe('内容运营专员')
  })

  test('普通员工管理组织架构 → 403；人事 → 201', async () => {
    expect((await api(app, tokens.ops1).post('/api/departments', { name: '偷偷加的部门' })).status).toBe(403)
    const ok = await api(app, tokens.hr).post('/api/departments', { name: '市场合作部', parentId: 1 })
    expect(ok.status).toBe(201)
  })

  test('普通员工发公告 → 403；人事 → 201', async () => {
    expect((await api(app, tokens.ops1).post('/api/announcements', { title: '我发的公告' })).status).toBe(403)
    expect((await api(app, tokens.hr).post('/api/announcements', { title: '正常公告', body: '内容' })).status).toBe(201)
  })

  test('审计日志仅 audit:read 可见：员工/人事/部门经理 403，总经理 200', async () => {
    expect((await api(app, tokens.ops1).get('/api/audit-logs')).status).toBe(403)
    expect((await api(app, tokens.hr).get('/api/audit-logs')).status).toBe(403)
    expect((await api(app, tokens.opsMgr).get('/api/audit-logs')).status).toBe(403)
    expect((await api(app, tokens.admin).get('/api/audit-logs')).status).toBe(200)
  })

  test('流程模板：所有角色都有 flow:read → 200', async () => {
    for (const t of [tokens.ops1, tokens.exe1, tokens.noMgr]) {
      expect((await api(app, t).get('/api/flows')).status).toBe(200)
    }
  })

  test('缺权限返回 403 且提示缺哪个权限码（便于排查）', async () => {
    const r = await api(app, tokens.ops1).get('/api/users')
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/user:read/)
  })

  // ---------------- 横向越权：同级别之间互相偷看 ----------------

  test('★ 横向越权：同事 A 读同事 B 的单据 → 403', async () => {
    // 单据 3 属于 孙小(ops2)
    const r = await api(app, tokens.ops1).get('/api/requests/3')
    expect(r.status).toBe(403)
  })

  test('单据列表默认只看自己的（scope=mine）', async () => {
    const r = await api(app, tokens.ops1).get('/api/requests')
    expect(r.status).toBe(200)
    expect(r.body.scope).toBe('mine')
    expect(r.body.items.every((x) => x.applicantId === ID.ops1)).toBe(true)
  })

  test('有 request:read:all 的角色（人事/总经理）能看全部单据', async () => {
    const r = await api(app, tokens.hr).get('/api/requests')
    expect(r.status).toBe(200)
    expect(r.body.scope).toBe('all')
    expect((await api(app, tokens.hr).get('/api/requests/3')).status).toBe(200)
    // 也可以强制只看自己
    const mine = await api(app, tokens.hr).get('/api/requests', { mine: '1' })
    expect(mine.body.scope).toBe('mine')
  })

  test('审批人可以查看自己经手的单据（即使不是申请人）', async () => {
    // 单据 3 属于 孙小，其直属上级是 王东(opsMgr)
    expect((await api(app, tokens.opsMgr).get('/api/requests/3')).status).toBe(200)
  })

  test('与单据无关的员工既看不到详情，也审不了', async () => {
    // 吴小(exe1) 与单据 3 完全无关
    expect((await api(app, tokens.exe1).get('/api/requests/3')).status).toBe(403)
    expect((await api(app, tokens.exe1).post('/api/requests/3/approve', { comment: 'x' })).status).toBe(403)
  })

  test('★ 不能审批自己提交的单据（自批）', async () => {
    // 王东(opsMgr) 自己是 dept_manager，purchase 流程第一级审批人就是 dept_manager → 包含他自己
    const t = await createAndSubmit(app, tokens.opsMgr, { type: 'purchase', formData: PURCHASE_FORM })
    expect(t.status).toBe(200)

    const self = await api(app, tokens.opsMgr).post(`/api/requests/${t.id}/approve`, { comment: '自己批自己' })
    expect(self.status).toBe(403)
    expect(self.body.error).toContain('自己')

    // 但别的部门经理批是允许的
    const other = await api(app, tokens.exeMgr).post(`/api/requests/${t.id}/approve`, { comment: '同意' })
    expect(other.status).toBe(200)
  })

  test('★ 只有申请人能提交/撤回自己的单据', async () => {
    const t = await createAndSubmit(app, tokens.ops1)
    // 孙小 想撤回 赵西 的单据
    expect((await api(app, tokens.ops2).post(`/api/requests/${t.id}/cancel`)).status).toBe(403)
    // 孙小 想提交 赵西 的草稿
    const draft = await api(app, tokens.ops1).post('/api/requests', {
      type: 'leave',
      title: '草稿',
      formData: { startDate: '2026-11-01', endDate: '2026-11-02', reason: '测试越权提交' },
    })
    expect((await api(app, tokens.ops2).post(`/api/requests/${draft.body.id}/submit`)).status).toBe(403)
  })
})

describe('管理类接口边界', () => {
  let app
  let hrToken
  beforeEach(async () => {
    app = await makeApp()
    hrToken = await login(app, U.hr)
  })
  afterEach(async () => {
    await app.close()
  })

  test('新建员工：用户名重复 → 409', async () => {
    const r = await api(app, hrToken).post('/api/users', {
      username: U.ops1,
      password: 'oa123456',
      realName: '重名用户',
    })
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('已存在')
  })

  test('新建员工：密码少于 6 位 → 400', async () => {
    const r = await api(app, hrToken).post('/api/users', { username: 'newbie', password: '123', realName: '小明' })
    expect(r.status).toBe(400)
  })

  test('新建员工：缺 username / realName → 400', async () => {
    expect((await api(app, hrToken).post('/api/users', { password: 'oa123456', realName: '小明' })).status).toBe(400)
    expect((await api(app, hrToken).post('/api/users', { username: 'x1', password: 'oa123456' })).status).toBe(400)
  })

  test('新建员工：部门不存在 → 404', async () => {
    const r = await api(app, hrToken).post('/api/users', {
      username: 'deptless',
      password: 'oa123456',
      realName: '无部门',
      deptId: 9999,
    })
    expect(r.status).toBe(404)
  })

  test('新建员工：可以一次带上角色', async () => {
    const r = await api(app, hrToken).post('/api/users', {
      username: 'newhr',
      password: 'oa123456',
      realName: '新人事',
      deptId: 4,
      roles: ['hr'],
    })
    expect(r.status).toBe(201)
    expect(r.body.roles).toEqual(['hr'])
  })

  test('修改不存在的员工 → 404', async () => {
    expect((await api(app, hrToken).patch('/api/users/9999', { position: 'x' })).status).toBe(404)
  })

  test('直属上级不能设成自己 → 409', async () => {
    const r = await api(app, hrToken).patch(`/api/users/${ID.opsMgr}`, { managerId: ID.opsMgr })
    expect(r.status).toBe(409)
  })

  test('status 只能是 active/disabled → 400', async () => {
    expect((await api(app, hrToken).patch(`/api/users/${ID.ops1}`, { status: 'deleted' })).status).toBe(400)
  })

  test('新建部门：缺 name → 400；上级部门不存在 → 404', async () => {
    expect((await api(app, hrToken).post('/api/departments', {})).status).toBe(400)
    expect((await api(app, hrToken).post('/api/departments', { name: '孤儿部门', parentId: 9999 })).status).toBe(404)
  })

  test('部门树的层级正确', async () => {
    const r = await api(app, hrToken).get('/api/departments')
    expect(r.status).toBe(200)
    expect(r.body.items).toHaveLength(1)
    expect(r.body.items[0].name).toBe('星野文化（虚构）')
    expect(r.body.items[0].children.map((c) => c.name)).toContain('内容运营部')
  })

  test('新建公告：缺 title → 400；超长 → 400', async () => {
    expect((await api(app, hrToken).post('/api/announcements', { body: '没有标题' })).status).toBe(400)
    expect((await api(app, hrToken).post('/api/announcements', { title: 'a'.repeat(101) })).status).toBe(400)
  })

  test('未知接口 → 404 且返回 JSON（不是 HTML 兜底页）', async () => {
    const r = await api(app, hrToken).get('/api/not-exist-endpoint')
    expect(r.status).toBe(404)
    expect(typeof r.body.error).toBe('string')
  })
})
