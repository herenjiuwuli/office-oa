// 种子数据（**全部为虚构内容**，见 README 安全红线：绝不接真实公司数据）
//
// 用法：
//   npm run seed            → 库里没数据时灌入
//   node seed.js --force    → 清空全部表后重新灌入（开发时重置用）
import { closeDb, getDb } from './server/db.js'
import { hashPassword } from './server/auth.js'
import { PERMISSIONS } from './server/permissions.js'
import { pathToFileURL } from 'node:url'

export const DEFAULT_PASSWORD = 'oa123456'
export const DEFAULT_PASSWORD_LABEL = '统一测试密码'

const TABLES_TO_CLEAR = [
  'approval_tasks',
  'requests',
  'flow_steps',
  'flows',
  'role_permissions',
  'user_roles',
  'permissions',
  'roles',
  'announcements',
  'audit_logs',
  'users',
  'departments',
]

// 角色 → 权限码
const ROLE_PERMISSIONS = {
  boss: PERMISSIONS.map((p) => p.code), // 总经理：全权限
  hr: [
    'dept:read',
    'dept:write',
    'user:read',
    'user:write',
    'flow:read',
    'request:read:all',
    'announcement:write',
  ],
  dept_manager: ['dept:read', 'user:read', 'flow:read'],
  employee: ['dept:read', 'flow:read'],
}

// 部门（树形）
const DEPARTMENTS = [
  { id: 1, name: '星野文化（虚构）', parent_id: null, sort: 0 },
  { id: 2, name: '内容运营部', parent_id: 1, sort: 1 },
  { id: 3, name: '艺人执行部', parent_id: 1, sort: 2 },
  { id: 4, name: '人力行政部', parent_id: 1, sort: 3 },
]

// 员工（人名/岗位全为虚构）
// 注意 id=8 的「郑无」故意不设上级 —— 用来验证「上级为空」时流程引擎给出明确业务错误（不是 500）
const USERS = [
  { id: 1, username: 'admin', real_name: '张北', dept_id: 1, position: '总经理', manager_id: null, roles: ['boss'] },
  { id: 2, username: 'hr01', real_name: '李南', dept_id: 4, position: '人事经理', manager_id: 1, roles: ['hr'] },
  { id: 3, username: 'ops01', real_name: '王东', dept_id: 2, position: '内容运营经理', manager_id: 1, roles: ['dept_manager'] },
  { id: 4, username: 'ops02', real_name: '赵西', dept_id: 2, position: '内容运营专员', manager_id: 3, roles: ['employee'] },
  { id: 5, username: 'ops03', real_name: '孙小', dept_id: 2, position: '内容运营专员', manager_id: 3, roles: ['employee'] },
  { id: 6, username: 'exe01', real_name: '周大', dept_id: 3, position: '艺人执行经理', manager_id: 1, roles: ['dept_manager'] },
  { id: 7, username: 'exe02', real_name: '吴小', dept_id: 3, position: '艺人执行专员', manager_id: 6, roles: ['employee'] },
  { id: 8, username: 'gy01', real_name: '郑无', dept_id: 3, position: '艺人执行专员', manager_id: null, roles: ['employee'] },
]

const ROLES = [
  { code: 'boss', name: '总经理', description: '全权限' },
  { code: 'hr', name: '人事', description: '组织架构 + 员工管理 + 公告 + 看全部单据' },
  { code: 'dept_manager', name: '部门经理', description: '查看组织架构与员工、查看流程' },
  { code: 'employee', name: '员工', description: '基础权限：提单据、看流程' },
]

// 流程模板
//   leave    两级审批：直属上级 → 人事复核
//   material 会签（两个部门经理都批才过）+ 总经办审批  ← 会签/并发测试的靶子
//   purchase 单级或签（任一部门经理批即过）           ← 并发抢单测试的靶子
const FLOWS = [
  {
    type: 'leave',
    name: '请假申请',
    description: '直属上级审批 → 人事复核',
    steps: [
      { step_no: 1, name: '直属上级审批', approver_type: 'manager', approver_ref: '', mode: 'any' },
      { step_no: 2, name: '人事复核', approver_type: 'role', approver_ref: 'hr', mode: 'any', dept_scoped: 0 },
    ],
  },
  {
    type: 'material',
    name: '活动物料审批',
    description: '部门经理会签（跨部门的，两个部门经理都要批）→ 总经办审批',
    steps: [
      // dept_scoped=0：跨部门会签，两个部门经理都收任务
      { step_no: 1, name: '部门经理会签', approver_type: 'role', approver_ref: 'dept_manager', mode: 'all', dept_scoped: 0 },
      { step_no: 2, name: '总经办审批', approver_type: 'user', approver_ref: '1', mode: 'any' },
    ],
  },
  {
    type: 'purchase',
    name: '采购申请',
    description: '本部门经理审批（或签，按部门收敛，外部门经理不能抢批）',
    steps: [
      // dept_scoped=1：只取申请人所在部门的经理，避免外部门经理抢批（M2 修的已知缺口）
      { step_no: 1, name: '部门经理审批', approver_type: 'role', approver_ref: 'dept_manager', mode: 'any', dept_scoped: 1 },
    ],
  },
]

export function seed(db = getDb(), { force = false } = {}) {
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n
  if (existing > 0 && !force) {
    throw new Error('数据库已有数据。要重置请用 `node seed.js --force`（会清空全部表）')
  }

  // 统一口令只哈希一次：scrypt 较慢，8 个用户各哈希一次会让 seed 明显变慢
  const pwHash = hashPassword(DEFAULT_PASSWORD)

  db.exec('BEGIN')
  try {
    if (force) {
      db.exec('PRAGMA foreign_keys = OFF')
      for (const t of TABLES_TO_CLEAR) db.exec(`DELETE FROM ${t}`)
      db.exec(`DELETE FROM sqlite_sequence`)
      db.exec('PRAGMA foreign_keys = ON')
    }

    // 权限字典（以代码里的 PERMISSIONS 为单一事实来源）
    const insPerm = db.prepare(`INSERT OR IGNORE INTO permissions (code, name, module) VALUES (?, ?, ?)`)
    for (const p of PERMISSIONS) insPerm.run(p.code, p.name, p.module)

    const insRole = db.prepare(`INSERT INTO roles (id, code, name, description) VALUES (?, ?, ?, ?)`)
    ROLES.forEach((r, i) => insRole.run(i + 1, r.code, r.name, r.description))

    const insRolePerm = db.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
       SELECT id, ? FROM roles WHERE code = ?`,
    )
    for (const [roleCode, perms] of Object.entries(ROLE_PERMISSIONS)) {
      for (const p of perms) insRolePerm.run(p, roleCode)
    }

    const insDept = db.prepare(`INSERT INTO departments (id, name, parent_id, sort) VALUES (?, ?, ?, ?)`)
    for (const d of DEPARTMENTS) insDept.run(d.id, d.name, d.parent_id, d.sort)

    const insUser = db.prepare(
      `INSERT INTO users (id, username, password_hash, real_name, dept_id, position, manager_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
    )
    for (const u of USERS) insUser.run(u.id, u.username, pwHash, u.real_name, u.dept_id, u.position, u.manager_id)

    const insUserRole = db.prepare(
      `INSERT OR IGNORE INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = ?`,
    )
    for (const u of USERS) for (const r of u.roles) insUserRole.run(u.id, r)

    const insFlow = db.prepare(`INSERT INTO flows (id, type, name, description, enabled) VALUES (?, ?, ?, ?, 1)`)
    const insStep = db.prepare(
      `INSERT INTO flow_steps (flow_id, step_no, name, approver_type, approver_ref, mode, dept_scoped)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    FLOWS.forEach((f, i) => {
      const flowId = i + 1
      insFlow.run(flowId, f.type, f.name, f.description)
      for (const s of f.steps) {
        insStep.run(flowId, s.step_no, s.name, s.approver_type, s.approver_ref, s.mode, s.dept_scoped ? 1 : 0)
      }
    })

    const insAnn = db.prepare(`INSERT INTO announcements (title, body, author_id, pinned) VALUES (?, ?, ?, ?)`)
    insAnn.run('欢迎使用星野 OA（演示数据）', '本系统为练手/作品项目，所有数据均为虚构。', 2, 1)
    insAnn.run('请假流程调整通知', '即日起请假需直属上级审批后再由人事复核。', 2, 0)

    // 几张示例单据，让前端有东西可看
    const snapshotOf = (type) => {
      const f = FLOWS.find((x) => x.type === type)
      return JSON.stringify(f.steps.map((s) => ({ ...s })))
    }
    const insReq = db.prepare(
      `INSERT INTO requests (id, type, applicant_id, title, form_data, status, current_step, round, flow_snapshot, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insReq.run(
      1, 'leave', 4, '赵西的请假申请（草稿）',
      JSON.stringify({ startDate: '2026-10-08', endDate: '2026-10-09', days: 2, reason: '家中有事' }),
      'draft', 0, 1, '[]', null,
    )
    insReq.run(
      2, 'material', 7, '长隆活动现场物料申请',
      JSON.stringify({ activityName: '长隆万圣节现场执行', items: [{ name: '折叠椅', qty: 6 }, { name: '冰桶', qty: 4 }], link: 'https://example.com/list', amount: 880 }),
      'pending', 1, 1, snapshotOf('material'), '2026-09-15 09:00:00',
    )
    insReq.run(
      3, 'leave', 5, '孙小的年假申请',
      JSON.stringify({ startDate: '2026-09-21', endDate: '2026-09-23', days: 3, reason: '年假外出' }),
      'approved', 2, 1, snapshotOf('leave'), '2026-09-10 10:00:00',
    )

    const insTask = db.prepare(
      `INSERT INTO approval_tasks (request_id, step_no, round, approver_id, action, comment, acted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insTask.run(2, 1, 1, 3, null, '', null) // 待 王东 会签
    insTask.run(2, 1, 1, 6, null, '', null) // 待 周大 会签
    insTask.run(3, 1, 1, 3, 'approve', '同意', '2026-09-10 14:00:00')
    insTask.run(3, 2, 1, 2, 'approve', '已核对', '2026-09-11 09:30:00')

    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  return {
    departments: DEPARTMENTS.length,
    users: USERS.length,
    roles: ROLES.length,
    permissions: PERMISSIONS.length,
    flows: FLOWS.length,
    requests: 3,
    password: DEFAULT_PASSWORD,
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const force = process.argv.includes('--force')
  try {
    const summary = seed(getDb(), { force })
    console.log('[office-oa] 种子数据写入完成：', summary)
    console.log(`[office-oa] 登录账号示例：admin / hr01 / ops01 / ops02 / exe01 / gy01，密码统一 ${summary.password}`)
  } catch (e) {
    console.error('[office-oa] seed 失败：', e.message)
    process.exitCode = 1
  } finally {
    closeDb()
  }
}
