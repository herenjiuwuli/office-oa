// 认证路由：登录 / 登出 / 当前用户
import { getDb } from '../db.js'
import { signToken, verifyPassword } from '../auth.js'
import { loadUserContext } from '../permissions.js'
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

  // JWT 是无状态的，服务端没有会话可销毁。
  // 这里只记一条审计；真正的「登出」是前端丢弃 token。
  // （要做到服务端强制作废，需要引入 token 黑名单/版本号，属 M2）
  app.post(
    '/api/auth/logout',
    handler(async (req) => {
      logAction({ userId: req.userId, action: 'auth.logout', ip: req.ip })
      return { ok: true }
    }),
  )

  app.get(
    '/api/me',
    handler(async (req) => serializeUser(req.ctx)),
  )
}
