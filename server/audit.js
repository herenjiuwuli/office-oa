// 审计日志：只记关键操作（登录、增删改、审批动作）。
// 注意：审计写失败**绝不能**阻断主流程（否则日志表一出问题整个系统就瘫了）。
import { getDb } from './db.js'

export function logAction({ userId, action, targetType = '', targetId = '', detail = '', ip = '' }) {
  try {
    getDb()
      .prepare(
        `INSERT INTO audit_logs (user_id, action, target_type, target_id, detail, ip)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId ?? null,
        String(action),
        String(targetType),
        String(targetId ?? ''),
        typeof detail === 'string' ? detail : JSON.stringify(detail ?? ''),
        String(ip || ''),
      )
  } catch {
    // 故意吞掉：审计失败不影响业务
  }
}

export function listLogs({ limit = 100, userId = null } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const db = getDb()
  if (userId) {
    return db
      .prepare(
        `SELECT l.*, u.real_name AS user_name
           FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
          WHERE l.user_id = ? ORDER BY l.id DESC LIMIT ?`,
      )
      .all(userId, n)
  }
  return db
    .prepare(
      `SELECT l.*, u.real_name AS user_name
         FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        ORDER BY l.id DESC LIMIT ?`,
    )
    .all(n)
}
