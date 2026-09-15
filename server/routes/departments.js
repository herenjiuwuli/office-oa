// 组织架构：部门（树形）
import { getDb } from '../db.js'
import { badRequest, conflict, handler, notFound } from '../errors.js'
import { requirePerm } from '../permissions.js'
import { logAction } from '../audit.js'

function buildTree(rows) {
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]))
  const roots = []
  for (const node of byId.values()) {
    if (node.parent_id != null && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

export default async function departmentRoutes(app) {
  // 读部门：登录即可（员工需要看到组织架构来选人/看流程）
  app.get(
    '/api/departments',
    handler(async (req) => {
      const { flat } = req.query || {}
      const rows = getDb()
        .prepare(`SELECT id, name, parent_id, sort, created_at FROM departments ORDER BY sort ASC, id ASC`)
        .all()
      if (flat === '1' || flat === 'true') return { items: rows }
      return { items: buildTree(rows) }
    }),
  )

  app.post(
    '/api/departments',
    { preHandler: requirePerm('dept:write') },
    handler(async (req, reply) => {
      const { name, parentId = null, sort = 0 } = req.body || {}
      if (typeof name !== 'string' || !name.trim()) throw badRequest('name 必填')
      if (name.trim().length > 50) throw badRequest('name 不能超过 50 个字')

      const db = getDb()
      if (parentId != null) {
        const parent = db.prepare(`SELECT id FROM departments WHERE id = ?`).get(Number(parentId))
        if (!parent) throw notFound('上级部门不存在')
      }
      const info = db
        .prepare(`INSERT INTO departments (name, parent_id, sort) VALUES (?, ?, ?)`)
        .run(name.trim(), parentId == null ? null : Number(parentId), Number(sort) || 0)
      const created = db.prepare(`SELECT * FROM departments WHERE id = ?`).get(info.lastInsertRowid)
      logAction({ userId: req.userId, action: 'dept.create', targetType: 'department', targetId: created.id, detail: { name } })
      return reply.code(201).send(created)
    }),
  )

  app.patch(
    '/api/departments/:id',
    { preHandler: requirePerm('dept:write') },
    handler(async (req) => {
      const db = getDb()
      const id = Number(req.params.id)
      const dept = db.prepare(`SELECT * FROM departments WHERE id = ?`).get(id)
      if (!dept) throw notFound('部门不存在')

      const { name, parentId, sort } = req.body || {}
      if (parentId !== undefined && parentId !== null) {
        const pid = Number(parentId)
        if (pid === id) throw conflict('上级部门不能是自己')
        if (!db.prepare(`SELECT id FROM departments WHERE id = ?`).get(pid)) throw notFound('上级部门不存在')
      }
      if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw badRequest('name 不能为空')

      db.prepare(
        `UPDATE departments
            SET name = COALESCE(?, name),
                parent_id = CASE WHEN ? = 1 THEN ? ELSE parent_id END,
                sort = COALESCE(?, sort)
          WHERE id = ?`,
      ).run(
        name === undefined ? null : name.trim(),
        parentId === undefined ? 0 : 1,
        parentId === undefined || parentId === null ? null : Number(parentId),
        sort === undefined ? null : Number(sort) || 0,
        id,
      )
      logAction({ userId: req.userId, action: 'dept.update', targetType: 'department', targetId: id })
      return db.prepare(`SELECT * FROM departments WHERE id = ?`).get(id)
    }),
  )
}
