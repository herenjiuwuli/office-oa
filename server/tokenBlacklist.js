// Token 黑名单（M2 · 让「登出」真正生效）
// JWT 本身无状态，服务端无法主动销毁会话；这里给每个 token 一个 jti，
// 登出时把 jti 写入 token_blacklist，守卫每次请求查表命中即 401。
// 只依赖 getDb()，与 auth.js 的「纯函数」定位解耦（auth.js 不碰数据库）。
import { getDb } from './db.js'

/**
 * 把一个 token 加入黑名单（登出时调用）。
 * @param {{ jti: string, userId?: number|null, reason?: string, expiredAt?: string|null }} opts
 */
export function blacklistToken({ jti, userId = null, reason = 'logout', expiredAt = null }) {
  if (!jti) return
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO token_blacklist (jti, user_id, reason, expired_at, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .run(jti, userId, reason, expiredAt)
}

/** 该 jti 是否已被登出作废。无 jti（旧 token）一律视为有效。 */
export function isTokenBlacklisted(jti) {
  if (!jti) return false
  const row = getDb().prepare(`SELECT 1 AS ok FROM token_blacklist WHERE jti = ?`).get(jti)
  return !!row
}
