// 鉴权核心：零原生依赖实现（复用 api-test-platform 已验证的写法）
//  - 密码哈希：Node 内置 crypto.scrypt（加盐，timingSafeEqual 防时序攻击）
//  - JWT：手写 HS256（header.payload.signature，base64url 编码），不引第三方库
// 这里只做「密码 + Token 的纯函数」，不碰数据库，方便单独测。
import crypto from 'node:crypto'

// 密钥：生产务必用环境变量覆盖；本地缺省给一个明确提示用的开发密钥。
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-oa'
const TOKEN_TTL_SEC = Number(process.env.JWT_TTL_SEC || 60 * 60 * 24) // 默认 24h

// ---------- 密码哈希 ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, 64)
  return salt.toString('hex') + ':' + hash.toString('hex')
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':')
  if (!saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const actual = crypto.scryptSync(String(password), salt, 64)
  // 长度不一致直接 false，避免 timingSafeEqual 抛错
  if (expected.length !== actual.length) return false
  return crypto.timingSafeEqual(expected, actual)
}

// ---------- JWT（HS256）----------
function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj))
}

export function signToken(payload) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const body = {
    ...payload,
    // jti：每个 token 的唯一标识。登出时把 jti 写进 token_blacklist，
    // 守卫查表即可在过期前强制作废该 token（见 server/guards.js）。
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + TOKEN_TTL_SEC,
  }
  const signingInput = `${b64urlJson(header)}.${b64urlJson(body)}`
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(signingInput).digest()
  return `${signingInput}.${b64url(sig)}`
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') throw new Error('token 缺失')
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('token 格式错误')
  const [h, p, s] = parts
  const expected = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest())
  // 防时序攻击比较
  const a = Buffer.from(s)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('token 签名无效')
  }
  let payload
  try {
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
  } catch {
    throw new Error('token 解析失败')
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('token 已过期')
  }
  return payload
}
