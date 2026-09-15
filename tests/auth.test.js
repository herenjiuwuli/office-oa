// 认证 / Token 相关用例
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { api, breakSignature, ID, login, makeApp, PASSWORD, tamperPayload, U } from './helpers.js'

describe('认证与 Token', () => {
  let app
  beforeEach(async () => {
    app = await makeApp()
  })
  afterEach(async () => {
    await app.close()
  })

  test('正确账号密码登录 → 200，并返回角色与权限码', async () => {
    const r = await api(app).post('/api/auth/login', { username: U.ops1, password: PASSWORD })
    expect(r.status).toBe(200)
    expect(typeof r.body.token).toBe('string')
    expect(r.body.token.split('.')).toHaveLength(3)
    expect(r.body.user.username).toBe(U.ops1)
    expect(r.body.user.roles).toContain('employee')
    expect(r.body.user.permissions).toContain('flow:read')
    // 绝不能把密码哈希吐给客户端
    expect(r.body.user.password_hash).toBeUndefined()
    expect(JSON.stringify(r.body)).not.toContain('scrypt')
  })

  test('密码错误 → 401', async () => {
    const r = await api(app).post('/api/auth/login', { username: U.ops1, password: 'wrong-password' })
    expect(r.status).toBe(401)
  })

  test('用户不存在与密码错误返回同样的提示（防用户名枚举）', async () => {
    const a = await api(app).post('/api/auth/login', { username: 'not-exist-user', password: 'x' })
    const b = await api(app).post('/api/auth/login', { username: U.ops1, password: 'x' })
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(a.body.error).toBe(b.body.error)
  })

  test('缺少用户名或密码 → 400', async () => {
    expect((await api(app).post('/api/auth/login', { username: U.ops1 })).status).toBe(400)
    expect((await api(app).post('/api/auth/login', {})).status).toBe(400)
  })

  test('不带 token 访问受保护接口 → 401', async () => {
    for (const url of ['/api/me', '/api/users', '/api/requests', '/api/todo', '/api/announcements']) {
      expect((await api(app).get(url)).status).toBe(401)
    }
  })

  test('token 格式错误 → 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer not-a-jwt' } })
    expect(r.statusCode).toBe(401)
  })

  test('token 签名被篡改 → 401', async () => {
    const token = await login(app, U.ops1)
    const r = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${breakSignature(token)}` } })
    expect(r.statusCode).toBe(401)
  })

  test('★ 篡改 token 里的 sub 冒充别人 → 401（签名不匹配）', async () => {
    const token = await login(app, U.ops1)
    const forged = tamperPayload(token, { sub: ID.admin })
    const r = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${forged}` } })
    expect(r.statusCode).toBe(401)
  })

  test('Authorization 头格式不对（缺 Bearer）→ 401', async () => {
    const token = await login(app, U.ops1)
    const r = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: token } })
    expect(r.statusCode).toBe(401)
  })

  test('GET /api/me 返回自己的档案 + 角色 + 权限码', async () => {
    const r = await api(app, await login(app, U.hr)).get('/api/me')
    expect(r.status).toBe(200)
    expect(r.body.username).toBe(U.hr)
    expect(r.body.roles).toEqual(['hr'])
    expect(r.body.permissions).toContain('user:write')
    expect(r.body.deptName).toBe('人力行政部')
  })

  test('★ 用户被停用后，旧 token 立即失效 → 401（最容易漏的一条）', async () => {
    const victimToken = await login(app, U.ops1)
    const hrToken = await login(app, U.hr)

    // 停用前：旧 token 正常
    expect((await api(app, victimToken).get('/api/me')).status).toBe(200)

    // 人事把该员工停用
    const patched = await api(app, hrToken).patch(`/api/users/${ID.ops1}`, { status: 'disabled' })
    expect(patched.status).toBe(200)
    expect(patched.body.status).toBe('disabled')

    // 旧 token 必须立刻不能再用了（如果只在 token 里缓存身份，这里就会漏）
    expect((await api(app, victimToken).get('/api/me')).status).toBe(401)
  })

  test('已停用的账号无法登录 → 401', async () => {
    const hrToken = await login(app, U.hr)
    await api(app, hrToken).patch(`/api/users/${ID.ops2}`, { status: 'disabled' })
    const r = await api(app).post('/api/auth/login', { username: U.ops2, password: PASSWORD })
    expect(r.status).toBe(401)
  })

  test('登出 → 200 且写入审计日志', async () => {
    const hrToken = await login(app, U.hr)
    const out = await api(app, hrToken).post('/api/auth/logout')
    expect(out.status).toBe(200)

    const logs = await api(app, await login(app, U.admin)).get('/api/audit-logs')
    const actions = logs.body.items.map((l) => l.action)
    expect(actions).toContain('auth.logout')
    expect(actions).toContain('auth.login')
  })

  test('登录失败也会留下审计记录（便于排查撞库）', async () => {
    await api(app).post('/api/auth/login', { username: U.ops1, password: 'bad' })
    const logs = await api(app, await login(app, U.admin)).get('/api/audit-logs')
    expect(logs.body.items.map((l) => l.action)).toContain('auth.login.failed')
  })

  test('/health 与登录接口免鉴权', async () => {
    expect((await api(app).get('/health')).status).toBe(200)
  })
})
