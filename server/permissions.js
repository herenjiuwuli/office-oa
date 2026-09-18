// 权限：权限码常量 + 从库里查用户的「角色 + 权限码」+ requirePerm 中间件。
// M1 只做权限「检查」，不做权限管理界面（砍到二期）。
import { getDb } from './db.js'

// 权限字典：单一事实来源。seed.js 会把这份清单写进 permissions 表。
export const PERMISSIONS = [
  { code: 'dept:read', name: '查看部门', module: 'org' },
  { code: 'dept:write', name: '管理部门', module: 'org' },
  { code: 'user:read', name: '查看员工', module: 'org' },
  { code: 'user:write', name: '管理员工', module: 'org' },
  { code: 'flow:read', name: '查看流程模板', module: 'flow' },
  { code: 'request:read:all', name: '查看全部单据', module: 'flow' },
  { code: 'announcement:write', name: '发布公告', module: 'notice' },
  { code: 'audit:read', name: '查看审计日志', module: 'audit' },
  // M5 会议室：**预订不需要权限**（会议室是公共资源，谁都能订、都得看得见别人的预订才能避开）；
  // 只有「管理会议室本身」（新增/停用/取消任意人的预订）才要权限。
  { code: 'room:manage', name: '管理会议室', module: 'meeting' },
]

export const PERMISSION_CODES = PERMISSIONS.map((p) => p.code)

/**
 * 查出用户的完整上下文：档案 + 角色码 + 权限码。
 * 找不到用户返回 null（由调用方决定 401 还是 404）。
 */
export function loadUserContext(userId) {
  const db = getDb()
  const user = db
    .prepare(
      `SELECT u.id, u.username, u.real_name, u.dept_id, u.position, u.manager_id, u.status,
              d.name AS dept_name
         FROM users u
         LEFT JOIN departments d ON d.id = u.dept_id
        WHERE u.id = ?`,
    )
    .get(userId)
  if (!user) return null

  const roles = db
    .prepare(
      `SELECT r.code FROM roles r
         JOIN user_roles ur ON ur.role_id = r.id
        WHERE ur.user_id = ?
        ORDER BY r.code`,
    )
    .all(userId)
    .map((r) => r.code)

  const permissions = db
    .prepare(
      `SELECT DISTINCT rp.permission_code AS code
         FROM role_permissions rp
         JOIN user_roles ur ON ur.role_id = rp.role_id
        WHERE ur.user_id = ?
        ORDER BY code`,
    )
    .all(userId)
    .map((r) => r.code)

  return { user, roles, permissions }
}

export const hasPerm = (ctx, code) => !!ctx && ctx.permissions.includes(code)

/**
 * 路由守卫：要求某个权限码。缺权限统一 403（不是 401——401 留给「没登录」）。
 * 用法：app.get('/api/users', { preHandler: requirePerm('user:read') }, handler)
 */
export function requirePerm(code, ...moreCodes) {
  const needed = [code, ...moreCodes]
  return async (req, reply) => {
    if (!req.ctx) return reply.code(401).send({ error: '未登录或缺少 token' })
    const missing = needed.filter((c) => !req.ctx.permissions.includes(c))
    if (missing.length) {
      return reply.code(403).send({ error: `缺少权限：${missing.join(', ')}` })
    }
  }
}
