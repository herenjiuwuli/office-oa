import { clearSession, getToken } from './store.js'

// 统一的 API 层：只负责「拼 URL + 带 token + 把后端的 {error} 转成异常」。
// 业务规则不在这里 —— 后端才是唯一的裁判。
const BASE = '/api'

function qs(params) {
  if (!params) return ''
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

async function request(path, { method = 'GET', body, query } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(BASE + path + qs(query), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    // 401 = 未登录 / token 失效 / 账号已被停用。清掉本地会话并回登录页，
    // 否则界面会停在一个「看起来登录着、但每个请求都失败」的假死状态。
    if (res.status === 401) {
      clearSession()
      if (path !== '/auth/login' && window.location.pathname !== '/login') {
        window.location.replace('/login?expired=1')
      }
    }
    const err = new Error(data.error || `请求失败（HTTP ${res.status}）`)
    err.status = res.status
    throw err
  }

  return data
}

export const api = {
  // --- 认证 ---
  login: (username, password) => request('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/auth/logout', { method: 'POST', body: {} }),
  me: () => request('/me'),

  // --- 组织架构 ---
  departments: {
    list: (flat) => request('/departments', { query: flat ? { flat: 1 } : undefined }),
    create: (data) => request('/departments', { method: 'POST', body: data }),
    update: (id, data) => request(`/departments/${id}`, { method: 'PATCH', body: data }),
  },

  // --- 员工 ---
  users: {
    list: (query) => request('/users', { query }),
    create: (data) => request('/users', { method: 'POST', body: data }),
    update: (id, data) => request(`/users/${id}`, { method: 'PATCH', body: data }),
  },

  // --- 流程 ---
  requestTypes: () => request('/request-types'),
  flows: () => request('/flows'),

  // --- 单据 ---
  requests: {
    list: (query) => request('/requests', { query }),
    create: (data) => request('/requests', { method: 'POST', body: data }),
    get: (id) => request(`/requests/${id}`),
    submit: (id) => request(`/requests/${id}/submit`, { method: 'POST', body: {} }),
    approve: (id, comment) => request(`/requests/${id}/approve`, { method: 'POST', body: { comment } }),
    reject: (id, comment) => request(`/requests/${id}/reject`, { method: 'POST', body: { comment } }),
    cancel: (id) => request(`/requests/${id}/cancel`, { method: 'POST', body: {} }),
  },

  // --- 待办 ---
  todo: () => request('/todo'),

  // --- AI 摘要（可选能力）---
  // 注意：未配置 key / AI 挂了都不算「错误」——后端会返回 200 + available:false，
  // 所以这里的 summarize 正常情况下不会抛异常，前端按 available 分支渲染即可。
  ai: {
    status: () => request('/ai/status'),
    summarize: (id) => request(`/requests/${id}/ai-summary`, { method: 'POST', body: {} }),
  },

  // --- 公告 ---
  announcements: {
    list: () => request('/announcements'),
    create: (data) => request('/announcements', { method: 'POST', body: data }),
  },

  // --- 审计 ---
  auditLogs: {
    list: (query) => request('/audit-logs', { query }),
  },
}
