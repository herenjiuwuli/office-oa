// 全局鉴权守卫：挂在 Fastify 的 onRequest 钩子上，在所有路由之前生效。
// ⚠️ 这里**故意不提供「测试旁路」开关**。
//    原因：本项目就是为了练越权测试，一个 API_AUTH_DISABLED 之类的开关
//    会悄悄把鉴权整个关掉，测试全绿但生产裸奔 —— 这类「测试骗过自己」的坑不值得留。
//    测试一律走真实登录拿 token。
import { verifyToken } from './auth.js'
import { loadUserContext } from './permissions.js'
import { isTokenBlacklisted } from './tokenBlacklist.js'

// 免鉴权路径（精确匹配）
const PUBLIC_PATHS = new Set(['/health', '/api/auth/login'])

export async function authGuard(req, reply) {
  const url = (req.url || '').split('?')[0]

  if (PUBLIC_PATHS.has(url)) return
  // 非 /api 路径（静态资源、前端 SPA 页面）公开，否则登录页自身都打不开
  if (!url.startsWith('/api')) return

  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)
  if (!m) return reply.code(401).send({ error: '未登录或缺少 token' })

  let payload
  try {
    payload = verifyToken(m[1])
  } catch (e) {
    return reply.code(401).send({ error: 'token 无效或已过期：' + e.message })
  }

  // ★ Token 黑名单（M2）：登出后该 token 的 jti 会被写进 token_blacklist，
  //   这里命中即 401 —— 否则「登出」只是前端丢掉 token，服务端在过期前还认旧 token。
  //   注意：只作废「这个具体 token」（按 jti），不影响同一用户的其他会话。
  if (payload.jti && isTokenBlacklisted(payload.jti)) {
    return reply.code(401).send({ error: 'token 已登出，请重新登录' })
  }

  // ★ 每次请求都回查数据库，不在 token 里缓存权限。两个理由：
  //   1) 用户可能已被停用 → 旧 token 必须立刻失效（返回 401）
  //   2) 角色/权限可能已被调整 → 不能拿签发时的权限快照用到底
  const ctx = loadUserContext(payload.sub)
  if (!ctx) return reply.code(401).send({ error: '用户不存在或已被删除' })
  if (ctx.user.status !== 'active') {
    return reply.code(401).send({ error: '账号已停用，请联系管理员' })
  }

  req.ctx = ctx
  req.userId = ctx.user.id
  // 透传给登出接口：logout 需要当前 token 的 jti 才能精确拉黑它（而不是整用户）
  req.tokenJti = payload.jti
  req.tokenExp = payload.exp
}
