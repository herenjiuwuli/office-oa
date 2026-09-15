// 测试公共工具：建 app、登录取 token、带 token 发请求
import { resetDb } from '../server/db.js'
import { buildApp } from '../index.js'
import { DEFAULT_PASSWORD, seed } from '../seed.js'

export const PASSWORD = DEFAULT_PASSWORD

/** 种子账号（值 = 用户名，键 = 语义名）。id 与 seed.js 中一致 */
export const U = {
  admin: 'admin', // id 1 总经理 boss
  hr: 'hr01', // id 2 人事 hr
  opsMgr: 'ops01', // id 3 内容运营经理 dept_manager（同时是 4、5 的上级）
  ops1: 'ops02', // id 4 内容运营专员 employee（上级=3）
  ops2: 'ops03', // id 5 内容运营专员 employee（上级=3）
  exeMgr: 'exe01', // id 6 艺人执行经理 dept_manager
  exe1: 'exe02', // id 7 艺人执行专员 employee（上级=6）
  noMgr: 'gy01', // id 8 艺人执行专员 employee（**上级为空**，见测试点 11）
}

export const ID = {
  admin: 1,
  hr: 2,
  opsMgr: 3,
  ops1: 4,
  ops2: 5,
  exeMgr: 6,
  exe1: 7,
  noMgr: 8,
}

/** 重置成干净的 :memory: 库并灌种子数据 */
export function freshDb() {
  const db = resetDb()
  seed(db)
  return db
}

/** 每个用例前调用：新库 + 新 app */
export async function makeApp() {
  freshDb()
  // serveStatic:false —— 接口测试不该依赖「前端是否构建过」
  const app = buildApp({ serveStatic: false })
  await app.ready()
  return app
}

export async function login(app, username, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })
  if (res.statusCode !== 200) {
    throw new Error(`登录失败（${username}）：${res.statusCode} ${res.body}`)
  }
  return JSON.parse(res.body).token
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** 返回 { status, body }，让断言写起来短 */
export function api(app, token) {
  const call = async (method, url, payload, query) => {
    const res = await app.inject({
      method,
      url,
      payload,
      query,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    return { status: res.statusCode, body: safeJson(res.body) }
  }
  return {
    get: (url, query) => call('GET', url, undefined, query),
    post: (url, payload) => call('POST', url, payload),
    patch: (url, payload) => call('PATCH', url, payload),
  }
}

/** 篡改 JWT 的 payload（签名不变 → 校验必然失败） */
export function tamperPayload(token, patch) {
  const [h, p, s] = token.split('.')
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
  Object.assign(payload, patch)
  const np = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${h}.${np}.${s}`
}

/** 破坏 JWT 签名 */
export function breakSignature(token) {
  const parts = token.split('.')
  const s = parts[2]
  parts[2] = (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
  return parts.join('.')
}

// ---------------------------------------------------------------------------
// 业务便捷方法
// ---------------------------------------------------------------------------

export const LEAVE_FORM = {
  startDate: '2026-10-08',
  endDate: '2026-10-09',
  days: 2,
  reason: '家中有事，需要请假两天',
}

export const MATERIAL_FORM = {
  activityName: '大学城 GOGO 新天地 coser 执行',
  items: [{ name: '折叠椅', qty: 6 }],
  link: 'https://example.com/list',
  amount: 880,
}

export const PURCHASE_FORM = { item: '一次性雨衣 100 件', amount: 300, reason: '线下活动备用' }

/** 建单 + 提交，返回 { id, status, body } */
export async function createAndSubmit(app, token, { type = 'leave', title = '测试单据', formData = LEAVE_FORM } = {}) {
  const client = api(app, token)
  const created = await client.post('/api/requests', { type, title, formData })
  if (created.status !== 201) throw new Error(`建单失败：${created.status} ${JSON.stringify(created.body)}`)
  const id = created.body.id
  const submitted = await client.post(`/api/requests/${id}/submit`)
  return { id, status: submitted.status, body: submitted.body }
}
