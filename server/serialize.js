// 统一的对外数据形状。DB 是 snake_case，API 给 camelCase —— 转换只在这里做，
// 避免每个路由各写一遍导致字段不一致（前端最烦这个）。

export function serializeUser(ctx) {
  const u = ctx.user
  return {
    id: u.id,
    username: u.username,
    realName: u.real_name,
    deptId: u.dept_id,
    deptName: u.dept_name ?? null,
    position: u.position,
    managerId: u.manager_id,
    status: u.status,
    roles: ctx.roles,
    permissions: ctx.permissions,
  }
}

export function serializeUserRow(row) {
  return {
    id: row.id,
    username: row.username,
    realName: row.real_name,
    deptId: row.dept_id,
    deptName: row.dept_name ?? null,
    position: row.position,
    managerId: row.manager_id,
    managerName: row.manager_name ?? null,
    status: row.status,
    roles: row.roles ? String(row.roles).split(',').filter(Boolean) : [],
  }
}

function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text)
    return v ?? fallback
  } catch {
    return fallback
  }
}

export function serializeRequest(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status,
    currentStep: row.current_step,
    round: row.round,
    applicantId: row.applicant_id,
    applicantName: row.applicant_name ?? null,
    formData: safeJson(row.form_data, {}),
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function serializeTask(row) {
  return {
    id: row.id,
    stepNo: row.step_no,
    round: row.round,
    approverId: row.approver_id,
    approverName: row.approver_name ?? null,
    action: row.action, // null=待审 / approve / reject / skip
    comment: row.comment,
    actedAt: row.acted_at,
    createdAt: row.created_at,
  }
}
