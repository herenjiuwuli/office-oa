// 认证路由：登录 / 登出 / 当前用户
import { getDb } from '../db.js'
import { signToken, verifyPassword } from '../auth.js'
import { loadUserContext } from '../permissions.js'
import { blacklistToken } from '../tokenBlacklist.js'
import { badRequest, handler, unauthorized } from '../errors.js'
import { logAction } from '../audit.js'
import { serializeUser } from '../serialize.js'

export default async function authRoutes(app) {
  app.post(
    '/api/auth/login',
    handler(async (req) => {
      const { username, password } = req.body || {}
      if (!username || !password) throw badRequest('用户名和密码必填')

      const u = getDb().prepare(`SELECT * FROM users WHERE username = ?`).get(String(username))

      // 统一提示「用户名或密码错误」，不区分是哪种 —— 否则等于送给攻击者一个用户名枚举接口
      if (!u || !verifyPassword(password, u.password_hash)) {
        logAction({
          userId: u?.id ?? null,
          action: 'auth.login.failed',
          targetType: 'user',
          targetId: String(username),
          ip: req.ip,
        })
        throw unauthorized('用户名或密码错误')
      }
      if (u.status !== 'active') throw unauthorized('账号已停用，请联系管理员')

      const token = signToken({ sub: u.id, username: u.username })
      logAction({ userId: u.id, action: 'auth.login', targetType: 'user', targetId: u.id, ip: req.ip })

      return { token, user: serializeUser(loadUserContext(u.id)) }
    }),
  )

  // M2：JWT 本无状态，服务端无法主动销毁会话。
  // 这里把当前 token 的 jti 写进 token_blacklist，守卫下次请求查到就 401 ——
  // 旧 token 立刻作废（不等 24h 过期）。前端也要同时丢弃本地 token。
  // 只作废「这个具体 token」（按 jti），同一用户的其他会话不受影响。
  app.post(
    '/api/auth/logout',
    handler(async (req) => {
      const jti = req.tokenJti
      if (jti) blacklistToken({ jti, userId: req.userId, reason: 'logout', expiredAt: req.tokenExp ? new Date(req.tokenExp * 1000).toISOString() : null })
      logAction({ userId: req.userId, action: 'auth.logout', ip: req.ip, detail: jti ? `jti=${jti}` : '' })
      return { ok: true }
    }),
  )

  app.get(
    '/api/me',
    handler(async (req) => serializeUser(req.ctx)),
  )
}
