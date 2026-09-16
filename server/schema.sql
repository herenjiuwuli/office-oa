-- 办公 OA · M1 表结构（9 张表）
-- 设计说明见 方案文档 §3.1。这里只写「为什么这么建」的关键注释，方便关源码时能讲出来。

PRAGMA foreign_keys = ON;

-- 组织架构：部门（树形，靠 parent_id 自关联）
CREATE TABLE IF NOT EXISTS departments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  parent_id  INTEGER REFERENCES departments(id),
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 员工：dept_id 决定归属部门，manager_id 是「直属上级」（单汇报线，多汇报线属过度设计）
-- manager_id 允许为空（老板 / 未配置），但流程引擎必须给出明确业务错误，不能 500
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  real_name     TEXT    NOT NULL,
  dept_id       INTEGER REFERENCES departments(id),
  position      TEXT    NOT NULL DEFAULT '',
  manager_id    INTEGER REFERENCES users(id),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 角色 / 权限：标准 RBAC 四张表。
-- M1 只做权限「检查」（要测越权），权限「增删改界面」砍到二期。
CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id),
  role_id INTEGER NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS permissions (
  code   TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  module TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id         INTEGER NOT NULL REFERENCES roles(id),
  permission_code TEXT    NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (role_id, permission_code)
);

-- 流程模板：type 是单据类型的唯一标识（leave / material / purchase ...）
CREATE TABLE IF NOT EXISTS flows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1
);

-- 流程步骤：独立表而不是 steps(JSON)，因为它是「配置数据」（能加外键、能查、能做界面）。
--   approver_type = role    → approver_ref 是角色 code（该角色下在职员工会收到任务）
--   approver_type = user    → approver_ref 是用户 id
--   approver_type = manager → 取申请人的直属上级（approver_ref 留空）
--   mode = any（或签：任一人批即过） / all（会签：全批才过，任一人驳回即驳回）
--   dept_scoped（M2 加）：role 类型是否「只限申请人所在部门」。
--     0（默认）= 该角色下所有在职员工都收任务（如 material 跨部门会签要两个部门经理都批）；
--     1         = 只取申请人归属部门的该角色员工（如 purchase 单步或签，避免外部门经理抢批）。
--     M2 修的「审批人按部门收敛」缺口：原实现 role 类型会跨学科/部门命中所有人。
CREATE TABLE IF NOT EXISTS flow_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id       INTEGER NOT NULL REFERENCES flows(id),
  step_no       INTEGER NOT NULL,
  name          TEXT    NOT NULL,
  approver_type TEXT    NOT NULL CHECK (approver_type IN ('role','user','manager')),
  approver_ref  TEXT    NOT NULL DEFAULT '',
  mode          TEXT    NOT NULL DEFAULT 'any' CHECK (mode IN ('all','any')),
  dept_scoped   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (flow_id, step_no)
);

-- 单据：通用表 + JSON form_data（一期重点是审批引擎，不是单据字段）。
-- ★ flow_snapshot：提交时把当时的流程步骤「快照」进来。
--   之后管理员改流程模板，在途单据仍按老流程走完 —— 真实 OA 必须这样，也是最容易被漏的点。
-- 注意：type 故意不加外键约束，改由应用层校验（模板可能被停用/改版，DB 层报错信息不可读）。
CREATE TABLE IF NOT EXISTS requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL,
  applicant_id  INTEGER NOT NULL REFERENCES users(id),
  title         TEXT    NOT NULL,
  form_data     TEXT    NOT NULL DEFAULT '{}',
  status        TEXT    NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','pending','approved','rejected','cancelled')),
  current_step  INTEGER NOT NULL DEFAULT 0,
  -- round：第几轮提交。驳回后重提会 +1，这样上一轮「谁因为什么驳回」的痕迹能留下来，
  --        而不是被新任务覆盖掉。这是 OA 里很容易被漏、面试又常问的一个点。
  round         INTEGER NOT NULL DEFAULT 1,
  flow_snapshot TEXT    NOT NULL DEFAULT '[]',
  submitted_at  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 审批任务：一人一步一行（会签/或签都靠「多行」表达）。
--   action IS NULL  = 待审
--   approve/reject  = 人做的决定
--   skip            = 该步已由别人完成（或签已过 / 已驳回），系统自动关闭，避免残留在待办里
-- UNIQUE(request_id, step_no, approver_id, round) 天然防重复分配，且允许「第二轮」重新分配；
-- 条件更新（WHERE action IS NULL）则是并发抢单的防线，见 server/flow/engine.js
CREATE TABLE IF NOT EXISTS approval_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES requests(id),
  step_no     INTEGER NOT NULL,
  round       INTEGER NOT NULL DEFAULT 1,
  approver_id INTEGER NOT NULL REFERENCES users(id),
  action      TEXT    CHECK (action IN ('approve','reject','skip')),
  comment     TEXT    NOT NULL DEFAULT '',
  acted_at    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id, step_no, approver_id, round)
);

CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  author_id  INTEGER NOT NULL REFERENCES users(id),
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 审计日志：只记关键操作（登录、增删改、审批）。是测「审计完整性」的靶子。
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT    NOT NULL,
  target_type TEXT    NOT NULL DEFAULT '',
  target_id   TEXT    NOT NULL DEFAULT '',
  detail      TEXT    NOT NULL DEFAULT '',
  ip          TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_dept      ON users(dept_id);
CREATE INDEX IF NOT EXISTS idx_users_manager   ON users(manager_id);
CREATE INDEX IF NOT EXISTS idx_req_applicant   ON requests(applicant_id, status);
CREATE INDEX IF NOT EXISTS idx_req_status      ON requests(status, current_step);
CREATE INDEX IF NOT EXISTS idx_task_pending    ON approval_tasks(approver_id, action);
CREATE INDEX IF NOT EXISTS idx_log_user        ON audit_logs(user_id, created_at);
