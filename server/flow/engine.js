// ============================================================================
// 审批引擎（本项目最核心的文件）
//
// 一期只支持：多级审批（step_no 递增）+ 或签/会签（mode = any | all）
// 六个关键点，按顺序读 actOnRequest()：
//   ① 授权（防自批 + 必须与本单位有关系 → 403）  ② 状态校验（409）  ③ 当前步身份（403）
//   ④ ★条件更新防并发（409）                    ⑤ 结算该步        ⑥ 推进 or 归档
//
//   ⚠️ ① 排在 ② 之前是**故意的**，不是随手写的顺序：
//      先返回「状态不对」的 409，无关的人就能靠状态码探测出这张单据存不存在、走没走完。
//      所以「你跟这张单据有没有关系」必须先判。这条是写接口用例时改出来的，别再调回去。
//
// 想加新能力时看这里：
//   · 新审批人类型（如「部门主管」）→ resolveApprovers 加一个分支
//   · 让某个 role 步骤只限本部门 → flow_steps 加 dept_scoped 列，在 resolveApprovers 的 role 分支按申请人部门过滤
//   · 加签 / 转交 / 超时自动通过    → 属于 M2/M3，当前刻意不做
//   · 让 AI 参与审批               → 不做。AI 只做摘要展示（server/lib/ai.js），不碰状态机
// ============================================================================
import { getDb } from '../db.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { logAction } from '../audit.js'

const SUBMITTABLE = ['draft', 'rejected']
const CANCELLABLE = ['draft', 'pending']

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export function getRequestOr404(id) {
  const r = getDb()
    .prepare(
      // 一次 join 出申请人姓名，避免各路由再查一遍
      `SELECT r.*, u.real_name AS applicant_name
         FROM requests r
         JOIN users u ON u.id = r.applicant_id
        WHERE r.id = ?`,
    )
    .get(Number(id))
  if (!r) throw notFound('单据不存在')
  return r
}

export function parseSnapshot(req) {
  try {
    const s = JSON.parse(req.flow_snapshot || '[]')
    return Array.isArray(s) ? s : []
  } catch {
    return []
  }
}

export function listTasks(requestId) {
  return getDb()
    .prepare(
      `SELECT t.*, u.real_name AS approver_name
         FROM approval_tasks t
         JOIN users u ON u.id = t.approver_id
        WHERE t.request_id = ?
        ORDER BY t.round ASC, t.step_no ASC, t.id ASC`,
    )
    .all(Number(requestId))
}

/** 我的待办：只查「待审 + 单据仍在审批中」，已关闭/已归档的不出现 */
export function listTodo(userId) {
  return getDb()
    .prepare(
      `SELECT t.id AS task_id, t.step_no, t.round, t.created_at AS assigned_at,
              r.id AS request_id, r.type, r.title, r.status, r.current_step, r.form_data,
              u.real_name AS applicant_name
         FROM approval_tasks t
         JOIN requests r ON r.id = t.request_id
         JOIN users u   ON u.id = r.applicant_id
        WHERE t.approver_id = ? AND t.action IS NULL AND r.status = 'pending'
        ORDER BY t.created_at DESC, t.id DESC`,
    )
    .all(Number(userId))
}

/**
 * 能否查看某单据：申请人本人 / 该单据任一环节的审批人 / 有 request:read:all 权限。
 * 三者都不满足 → 403（横向越权的核心防线）。
 */
export function canViewRequest(req, ctx) {
  if (ctx.permissions.includes('request:read:all')) return true
  if (req.applicant_id === ctx.user.id) return true
  const hit = getDb()
    .prepare(`SELECT 1 AS ok FROM approval_tasks WHERE request_id = ? AND approver_id = ? LIMIT 1`)
    .get(req.id, ctx.user.id)
  return !!hit
}

// ---------------------------------------------------------------------------
// 解析审批人
// ---------------------------------------------------------------------------

/**
 * 把流程步骤解析成「具体审批人 id 列表」。
 * 解析不出来时抛业务错误（409），**绝不能变成 500** —— 这是配置问题，不是系统故障。
 */
export function resolveApprovers(step, request) {
  const db = getDb()

  if (step.approver_type === 'user') {
    const id = Number(step.approver_ref)
    const u = db.prepare(`SELECT id FROM users WHERE id = ? AND status = 'active'`).get(id)
    if (!u) throw conflict(`流程步骤「${step.name}」配置的审批人（id=${step.approver_ref}）不存在或已停用`)
    return [u.id]
  }

  if (step.approver_type === 'role') {
    // ★ dept_scoped 是「流程步骤」的属性（随快照带入），不是角色表的属性
    const roleExists = db.prepare(`SELECT 1 AS ok FROM roles WHERE code = ?`).get(step.approver_ref)
    if (!roleExists) throw conflict(`流程步骤「${step.name}」的角色（${step.approver_ref}）不存在`)

    let sql =
      `SELECT u.id FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles r       ON r.id = ur.role_id
       WHERE r.code = ? AND u.status = 'active'`
    const args = [step.approver_ref]

    // ★ 按部门收敛：只取申请人归属部门的该角色员工（避免外部门经理抢批）
    if (step.dept_scoped) {
      const applicant = db
        .prepare(`SELECT id, real_name, dept_id FROM users WHERE id = ?`)
        .get(request.applicant_id)
      if (!applicant) throw conflict('申请人不存在')
      if (applicant.dept_id == null) {
        throw conflict(`申请人「${applicant.real_name}」没有归属部门，无法确定部门审批人`)
      }
      sql += ` AND u.dept_id = ?`
      args.push(applicant.dept_id)
    }

    sql += ` ORDER BY u.id`
    const rows = db.prepare(sql).all(...args)
    if (!rows.length) {
      const msg = step.dept_scoped
        ? `申请人所在部门没有在职的「${step.approver_ref}」审批人`
        : `流程步骤「${step.name}」的角色（${step.approver_ref}）下没有在职员工`
      throw conflict(msg)
    }
    return rows.map((r) => r.id)
  }

  if (step.approver_type === 'manager') {
    const applicant = db.prepare(`SELECT id, real_name, manager_id FROM users WHERE id = ?`).get(request.applicant_id)
    if (!applicant) throw conflict('申请人不存在')
    if (!applicant.manager_id) {
      // 测试点 11：上级为空必须有明确业务错误，不能 500
      throw conflict(`申请人「${applicant.real_name}」没有配置直属上级，无法提交「${step.name}」环节`)
    }
    const mgr = db
      .prepare(`SELECT id, real_name FROM users WHERE id = ? AND status = 'active'`)
      .get(applicant.manager_id)
    if (!mgr) throw conflict(`申请人的直属上级不存在或已停用（manager_id=${applicant.manager_id}）`)
    return [mgr.id]
  }

  throw badRequest(`不支持的审批人类型：${step.approver_type}`)
}

function insertTasks(requestId, step, approvers, round) {
  const db = getDb()
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO approval_tasks (request_id, step_no, round, approver_id, action)
     VALUES (?, ?, ?, ?, NULL)`,
  )
  for (const uid of approvers) stmt.run(requestId, step.step_no, round, uid)
}

/** 该步已经结束时，把本步剩下的待审任务标成 skip（否则会永远挂在别人待办里） */
function closeRemainingTasks(requestId, stepNo, round) {
  getDb()
    .prepare(
      `UPDATE approval_tasks SET action = 'skip', acted_at = datetime('now')
        WHERE request_id = ? AND step_no = ? AND round = ? AND action IS NULL`,
    )
    .run(requestId, stepNo, round)
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

export function submitRequest(requestId, userId) {
  const db = getDb()
  const req = getRequestOr404(requestId)

  if (req.applicant_id !== userId) throw forbidden('只能提交自己的单据')
  if (!SUBMITTABLE.includes(req.status)) {
    throw conflict(`单据当前状态为「${req.status}」，不可提交`)
  }

  const flow = db.prepare(`SELECT * FROM flows WHERE type = ? AND enabled = 1`).get(req.type)
  if (!flow) throw conflict(`单据类型「${req.type}」没有启用中的审批流程`)

  const steps = db
    .prepare(`SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY step_no ASC`)
    .all(flow.id)
  if (!steps.length) throw conflict('审批流程没有配置任何步骤')

  // ★ 快照：把流程步骤固化进单据。之后模板被改/被停用，在途单据仍按老流程走完。
  const snapshot = steps.map((s) => ({
    step_no: s.step_no,
    name: s.name,
    approver_type: s.approver_type,
    approver_ref: s.approver_ref,
    mode: s.mode,
    dept_scoped: s.dept_scoped, // 连同「是否按部门收敛」一起快照，在途单据不被后续模板改动影响
  }))

  // 驳回后重提：轮次 +1，上一轮的审批痕迹保留
  const nextRound = req.status === 'rejected' ? req.round + 1 : req.round

  // 事务外先解析审批人（配置错误要能干净地失败，不留半截状态）
  const approvers = resolveApprovers(snapshot[0], req)

  db.exec('BEGIN')
  try {
    db.prepare(
      `UPDATE requests
          SET status = 'pending', current_step = ?, round = ?, flow_snapshot = ?,
              submitted_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`,
    ).run(snapshot[0].step_no, nextRound, JSON.stringify(snapshot), requestId)

    insertTasks(requestId, snapshot[0], approvers, nextRound)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  logAction({
    userId,
    action: 'request.submit',
    targetType: 'request',
    targetId: requestId,
    detail: { type: req.type, round: nextRound, firstStep: snapshot[0]?.name },
  })
  return getRequestOr404(requestId)
}

// ---------------------------------------------------------------------------
// 审批（同意 / 驳回）—— 六步
// ---------------------------------------------------------------------------

export function actOnRequest(requestId, userId, action, comment = '') {
  if (action !== 'approve' && action !== 'reject') throw badRequest('action 只能是 approve 或 reject')

  const db = getDb()
  const req = getRequestOr404(requestId)

  // ① 先做授权，再谈状态 —— 顺序很重要：
  //    如果先返回「状态不对」的 409，无关的人就能靠状态码探测出这张单据存不存在、走没走完。
  //    所以「你跟这张单据有没有关系」必须先判。
  // ①-1 防自批：申请人不能审批自己提交的单据（真实 OA 的基本规矩）
  if (req.applicant_id === userId) throw forbidden('不能审批自己提交的单据')

  // ①-2 你至少得是这张单据某个环节的审批人
  const related = db
    .prepare(`SELECT 1 AS ok FROM approval_tasks WHERE request_id = ? AND approver_id = ? LIMIT 1`)
    .get(requestId, userId)
  if (!related) throw forbidden('你不是该单据的审批人')

  // ② 状态校验：只有 pending 能审。重复提交、已归档、已撤回都在这里挡下 → 409
  if (req.status !== 'pending') {
    throw conflict(`单据当前状态为「${req.status}」，不可审批`)
  }

  const snapshot = parseSnapshot(req)
  const step = snapshot.find((s) => s.step_no === req.current_step)
  if (!step) throw conflict('流程快照与当前进度不一致，无法审批')

  // ③ 身份细分：必须是「当前这一步」的审批人。别的步骤的审批人也不行 → 403
  const task = db
    .prepare(
      `SELECT * FROM approval_tasks
        WHERE request_id = ? AND step_no = ? AND round = ? AND approver_id = ?`,
    )
    .get(requestId, step.step_no, req.round, userId)
  if (!task) throw forbidden('你不是当前步骤的审批人')

  let outcome = null

  db.exec('BEGIN')
  try {
    // ④ ★ 条件更新：WHERE action IS NULL 是并发防线。
    //    两个人同时点「同意」、或同一个人连点两次时，只有第一次能改到行（changes === 1），
    //    第二次 changes === 0 → 409。靠数据库原子性，不靠应用层加锁。
    const upd = db
      .prepare(
        `UPDATE approval_tasks SET action = ?, comment = ?, acted_at = datetime('now')
          WHERE id = ? AND action IS NULL`,
      )
      .run(action, String(comment || ''), task.id)
    if (upd.changes === 0) throw conflict('该审批任务已被处理（重复提交或并发抢单）')

    // ⑤ 结算该步
    const tasks = db
      .prepare(`SELECT * FROM approval_tasks WHERE request_id = ? AND step_no = ? AND round = ?`)
      .all(requestId, step.step_no, req.round)
    const hasReject = tasks.some((t) => t.action === 'reject')
    const allDone = tasks.every((t) => t.action !== null)
    const anyApprove = tasks.some((t) => t.action === 'approve')
    const passed = !hasReject && (step.mode === 'any' ? anyApprove : allDone)

    if (hasReject) {
      // ⑥-a 驳回：本步结束，其余待审任务关闭（保留本轮痕迹）
      closeRemainingTasks(requestId, step.step_no, req.round)
      db.prepare(`UPDATE requests SET status = 'rejected', updated_at = datetime('now') WHERE id = ?`).run(requestId)
      outcome = 'rejected'
    } else if (passed) {
      closeRemainingTasks(requestId, step.step_no, req.round)
      const nextStep = snapshot.find((s) => s.step_no > step.step_no)
      if (nextStep) {
        // ⑥-b 还有下一步：推进 current_step + 为新步骤分配任务
        const approvers = resolveApprovers(nextStep, req) // 配置错误 → 回滚，不留半截状态
        db.prepare(`UPDATE requests SET current_step = ?, updated_at = datetime('now') WHERE id = ?`).run(
          nextStep.step_no,
          requestId,
        )
        insertTasks(requestId, nextStep, approvers, req.round)
        outcome = 'advanced'
      } else {
        // ⑥-c 最后一步通过 → 归档
        db.prepare(`UPDATE requests SET status = 'approved', updated_at = datetime('now') WHERE id = ?`).run(requestId)
        outcome = 'approved'
      }
    }
    // passed === false（会签还没集齐）→ 保持 pending，什么都不做

    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  logAction({
    userId,
    action: `request.${action}`,
    targetType: 'request',
    targetId: requestId,
    detail: { step: step.step_no, round: req.round, outcome, comment: String(comment || '') },
  })
  return getRequestOr404(requestId)
}

// ---------------------------------------------------------------------------
// 撤回
// ---------------------------------------------------------------------------

export function cancelRequest(requestId, userId) {
  const db = getDb()
  const req = getRequestOr404(requestId)

  if (req.applicant_id !== userId) throw forbidden('只能撤回自己的单据')
  if (!CANCELLABLE.includes(req.status)) {
    throw conflict(`单据当前状态为「${req.status}」，不可撤回`)
  }

  db.exec('BEGIN')
  try {
    db.prepare(`UPDATE requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(requestId)
    // 未审的任务全部关闭，避免残留在别人待办里
    db.prepare(
      `UPDATE approval_tasks SET action = 'skip', acted_at = datetime('now')
        WHERE request_id = ? AND action IS NULL`,
    ).run(requestId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  logAction({ userId, action: 'request.cancel', targetType: 'request', targetId: requestId })
  return getRequestOr404(requestId)
}
