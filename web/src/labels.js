// 展示层文案与颜色映射：状态机 / 审批动作 / 审批人类型 / 会签方式。
// 集中一处，避免每个页面各写一份 switch（字段名对不上就出事）。

export const STATUS = {
  draft: { text: '草稿', cls: 'st-draft' },
  pending: { text: '审批中', cls: 'st-pending' },
  approved: { text: '已通过', cls: 'st-approved' },
  rejected: { text: '已驳回', cls: 'st-rejected' },
  cancelled: { text: '已撤回', cls: 'st-cancelled' },
}

export const STATUS_OPTIONS = Object.entries(STATUS).map(([value, v]) => ({ value, text: v.text }))

export const ACTION = {
  approve: { text: '同意', cls: 'st-approved' },
  reject: { text: '驳回', cls: 'st-rejected' },
  skip: { text: '系统关闭', cls: 'st-cancelled' },
}

export const APPROVER_TYPE = {
  user: '指定人',
  role: '角色',
  manager: '直属上级',
}

export const MODE = {
  any: '或签',
  all: '会签',
}

export const statusText = (s) => STATUS[s]?.text || s
export const statusCls = (s) => STATUS[s]?.cls || 'st-draft'
export const actionText = (a) => (a ? ACTION[a]?.text || a : '待审')

/** 后端给的是 'YYYY-MM-DD HH:MM:SS'（SQLite datetime），直接展示即可，空值统一显示「—」 */
export const fmt = (s) => (s ? String(s) : '—')

/** 只要日期部分 */
export const fmtDate = (s) => (s ? String(s).slice(0, 10) : '—')

export function shortTime(s) {
  if (!s) return '—'
  // '2026-09-15 09:00:00' → '09-15 09:00'
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(s)
}
