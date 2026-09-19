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

    // 导出 CSV（M4）。和下载附件同源：**必须带 Authorization 头**，
    // 所以不能写成一个裸 <a href="/api/requests/export.csv">（那样带不上 token，会 401）。
    // 文件名听后端的（Content-Disposition），前端只负责把它落到磁盘 —— 名字该由「谁生成谁命名」。
    exportCsv: async (query) => {
      const headers = {}
      const token = getToken()
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetch(`${BASE}/requests/export.csv${qs(query)}`, { headers })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (res.status === 401) {
          clearSession()
          if (window.location.pathname !== '/login') window.location.replace('/login?expired=1')
        }
        const err = new Error(data.error || `导出失败（HTTP ${res.status}）`)
        err.status = res.status
        throw err
      }
      const cd = res.headers.get('Content-Disposition') || ''
      const matched = /filename="([^"]+)"/.exec(cd)
      const filename = matched ? matched[1] : 'requests.csv'
      // 条数走响应头 —— 前端**不数 CSV 的行**：含换行的字段会被引号包着跨行，按 \n 数必然错
      const total = Number(res.headers.get('X-Total-Count') || 0)

      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      return { filename, total }
    },
  },

  // --- 待办 ---
  todo: () => request('/todo'),

  // --- 站内通知（M3）---
  // 不需要任何权限码：通知是「我自己的东西」，后端按 user_id 强制过滤。
  notifications: {
    list: (query) => request('/notifications', { query }),
    unreadCount: () => request('/notifications/unread-count'),
    read: (id) => request(`/notifications/${id}/read`, { method: 'POST', body: {} }),
    readAll: () => request('/notifications/read-all', { method: 'POST', body: {} }),
  },

  // --- 附件（M2）---
  // 上传/下载不能走上面的 request()：上传要 multipart（不是 JSON），
  // 下载要拿二进制 blob，而且**必须带 Authorization 头**（所以不能用裸 <a href>）。
  attachments: {
    list: (requestId) => request(`/requests/${requestId}/attachments`),
    remove: (id) => request(`/attachments/${id}`, { method: 'DELETE' }),

    upload: async (requestId, file) => {
      const fd = new FormData()
      fd.append('file', file)
      const headers = {}
      const token = getToken()
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetch(`${BASE}/requests/${requestId}/attachments`, { method: 'POST', headers, body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 401) {
          clearSession()
          if (window.location.pathname !== '/login') window.location.replace('/login?expired=1')
        }
        const err = new Error(data.error || `上传失败（HTTP ${res.status}）`)
        err.status = res.status
        throw err
      }
      return data
    },

    download: async (id, filename) => {
      const token = getToken()
      // 用成员赋值而不是对象字面量 { Authorization: ... }：既和 request() 保持一致，
      // 也避开静态扫描把大写键名误判成「未声明标识符」。
      const headers = {}
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetch(`${BASE}/attachments/${id}`, { headers })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (res.status === 401) {
          clearSession()
          if (window.location.pathname !== '/login') window.location.replace('/login?expired=1')
        }
        const err = new Error(data.error || `下载失败（HTTP ${res.status}）`)
        err.status = res.status
        throw err
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename || 'download'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    },
  },

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

  // --- M5 会议室 ---
  rooms: {
    list: () => request('/meeting-rooms'),
    create: (data) => request('/meeting-rooms', { method: 'POST', body: data }),
    setStatus: (id, status) => request(`/meeting-rooms/${id}/status`, { method: 'PATCH', body: { status } }),
  },
  bookings: {
    list: (query) => request('/room-bookings', { query }),
    create: (data) => request('/room-bookings', { method: 'POST', body: data }),
    cancel: (id) => request(`/room-bookings/${id}`, { method: 'DELETE' }),
  },

  // --- M6 统计 ---
  stats: {
    overview: (query) => request('/stats/overview', { query }),
  },
}
