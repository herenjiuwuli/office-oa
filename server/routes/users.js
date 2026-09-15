// 员工管理
// 注意 GET /api/users 需要 user:read 权限 —— 普通员工访问必须是 403（纵向越权测试点）
import { getDb } from '../db.js'
import { hashPassword } from '../auth.js'
import { badRequest, conflict, handler, notFound } from '../errors.js'
import { requirePerm } from '../permissions.js'
import { logAction } from '../audit.js'
import { serializeUserRow } from '../serialize.js'

const SELECT_USER = `
  SELECT u.id, u.username, u.real_name, u.dept_id, u.position, u.manager_id, u.status, u.created_at,
         d.name AS dept_name,
         m.real_name AS manager_name,
         (SELECT group_concat(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id) AS roles
    FROM users u
    LEFT JOIN departments d ON d.id = u.dept_id
    LEFT JOIN users m       ON m.id = u.manager_id`

export default async function userRoutes(app) {
  app.get(
    '/api/users',
    { preHandler: requirePerm('user:read') },
    handler(async (req) => {
      const { deptId, status, q } = req.query || {}
      const where = []
      const args = []
      if (deptId) {
        where.push('u.dept_id = ?')
        args.push(Number(deptId))
      }
      if (status) {
        where.push('u.status = ?')
        args.push(String(status))
      }
      if (q) {
        where.push('(u.username LIKE ? OR u.real_name LIKE ?)')
        args.push(`%${q}%`, `%${q}%`)
      }
      const sql = `${SELECT_USER} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.id ASC`
      const items = getDb()
        .prepare(sql)
        .all(...args)
        .map(serializeUserRow)
      return { items, total: items.length }
    }),
  )

  app.post(
    '/api/users',
    { preHandler: requirePerm('user:write') },
    handler(async (req, reply) => {
      const { username, password, realName, deptId = null, position = '', managerId = null, roles = [] } = req.body || {}
      if (typeof username !== 'string' || !username.trim()) throw badRequest('username 必填')
      if (typeof realName !== 'string' || !realName.trim()) throw badRequest('realName 必填')
      if (typeof password !== 'string' || password.length < 6) throw badRequest('password 至少 6 位')

      const db = getDb()
      const dup = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username.trim())
      if (dup) throw conflict(`用户名「${username}」已存在`) // 测试点：409

      if (deptId != null && !db.prepare(`SELECT id FROM departments WHERE id = ?`).get(Number(deptId))) {
        throw notFound('部门不存在')
      }
      if (managerId != null && !db.prepare(`SELECT id FROM users WHERE id = ?`).get(Number(managerId))) {
        throw notFound('直属上级不存在')
      }

      db.exec('BEGIN')
      let info
      try {
        info = db
          .prepare(
            `INSERT INTO users (username, password_hash, real_name, dept_id, position, manager_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            username.trim(),
            hashPassword(password),
            realName.trim(),
            deptId == null ? null : Number(deptId),
            String(position || ''),
            managerId == null ? null : Number(managerId),
          )
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO user_roles (user_id, role_id)
           SELECT ?, id FROM roles WHERE code = ?`,
        )
        for (const code of Array.isArray(roles) ? roles : []) stmt.run(info.lastInsertRowid, String(code))
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }

      logAction({ userId: req.userId, action: 'user.create', targetType: 'user', targetId: info.lastInsertRowid })
      const row = db.prepare(`${SELECT_USER} WHERE u.id = ?`).get(info.lastInsertRowid)
      return reply.code(201).send(serializeUserRow(row))
    }),
  )

  app.patch(
    '/api/users/:id',
    { preHandler: requirePerm('user:write') },
    handler(async (req) => {
      const db = getDb()
      const id = Number(req.params.id)
      if (!db.prepare(`SELECT id FROM users WHERE id = ?`).get(id)) throw notFound('员工不存在')

      const { realName, deptId, position, managerId, status, roles } = req.body || {}
      if (status !== undefined && !['active', 'disabled'].includes(status)) {
        throw badRequest('status 只能是 active 或 disabled')
      }
      if (managerId !== undefined && managerId !== null) {
        if (Number(managerId) === id) throw conflict('直属上级不能是自己')
        if (!db.prepare(`SELECT id FROM users WHERE id = ?`).get(Number(managerId))) throw notFound('直属上级不存在')
      }
      if (deptId !== undefined && deptId !== null) {
        if (!db.prepare(`SELECT id FROM departments WHERE id = ?`).get(Number(deptId))) throw notFound('部门不存在')
      }

      db.exec('BEGIN')
      try {
        db.prepare(
          `UPDATE users
              SET real_name  = COALESCE(?, real_name),
                  position   = COALESCE(?, position),
                  status     = COALESCE(?, status),
                  dept_id    = CASE WHEN ? = 1 THEN ? ELSE dept_id END,
                  manager_id = CASE WHEN ? = 1 THEN ? ELSE manager_id END
            WHERE id = ?`,
        ).run(
          realName === undefined ? null : String(realName),
          position === undefined ? null : String(position),
          status === undefined ? null : status,
          deptId === undefined ? 0 : 1,
          deptId === undefined || deptId === null ? null : Number(deptId),
          managerId === undefined ? 0 : 1,
          managerId === undefined || managerId === null ? null : Number(managerId),
          id,
        )
        if (Array.isArray(roles)) {
          db.prepare(`DELETE FROM user_roles WHERE user_id = ?`).run(id)
          const stmt = db.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = ?`)
          for (const code of roles) stmt.run(id, String(code))
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }

      logAction({
        userId: req.userId,
        action: 'user.update',
        targetType: 'user',
        targetId: id,
        // 停用是敏感操作，必须留痕
        detail: status === 'disabled' ? { status, note: '停用账号' } : undefined,
      })
      return serializeUserRow(db.prepare(`${SELECT_USER} WHERE u.id = ?`).get(id))
    }),
  )
}
