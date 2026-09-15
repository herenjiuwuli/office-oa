import { reactive } from 'vue'

// 单例 store（不引 Pinia —— M1 的共享状态就这么点，一个 reactive 对象足够）。
// 职责：持有「当前登录者」的 token + 档案 + 角色 + 权限码，并落 localStorage 抗刷新。

const TOKEN_KEY = 'oa.token'
const USER_KEY = 'oa.user'

function safeParse(text) {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

export const session = reactive({
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: safeParse(localStorage.getItem(USER_KEY)),
})

/** 登录成功后写入；同时把用户档案（含权限码）缓存下来，供菜单渲染 */
export function setSession(token, user) {
  session.token = token || ''
  session.user = user || null
  if (session.token) localStorage.setItem(TOKEN_KEY, session.token)
  if (session.user) localStorage.setItem(USER_KEY, JSON.stringify(session.user))
}

/** 刷新当前用户（改完角色/部门后调用 /api/me 同步最新权限） */
export function setUser(user) {
  session.user = user || null
  if (session.user) localStorage.setItem(USER_KEY, JSON.stringify(session.user))
  else localStorage.removeItem(USER_KEY)
}

export function clearSession() {
  session.token = ''
  session.user = null
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export const getToken = () => session.token
export const isLoggedIn = () => !!session.token
export const currentUser = () => session.user

/**
 * 界面级权限判断。注意它**只负责隐藏/禁用按钮**，真正的拦截永远在后端 ——
 * 前端藏起来不等于安全，这一点在 README 里写清了。
 */
export function can(code) {
  return !!session.user && Array.isArray(session.user.permissions) && session.user.permissions.includes(code)
}

/** 是否拥有其中任意一个权限 */
export function canAny(...codes) {
  return codes.some((c) => can(c))
}
