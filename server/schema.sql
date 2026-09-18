-- 办公 OA · 表结构（14 张表：M1 主体 9 张 + M2 新增 flow_steps.dept_scoped / attachments / token_blacklist）
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

-- 附件（M2）：活动物料要传图/传 PDF，M1 用「链接字段」凑合，这里改成真上传。
-- ★ stored_name 是磁盘上的**随机名**（与原始文件名无关），两个作用：
--   ① 防路径穿越：用户传 `../../etc/passwd` 也只会存成 `<uuid>.png`，磁盘路径永不拼接用户输入；
--   ② 防覆盖/猜测：随机名让「猜 URL 下载别人附件」失效（且下载还要过鉴权）。
--   original_name 只用于展示与下载时的文件名（下发前会做头注入清洗）。
-- mime 以**服务端嗅探的真实字节**为准（见 server/lib/storage.js），不信任客户端声明的类型。
CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL REFERENCES requests(id),
  uploader_id   INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT    NOT NULL,
  stored_name   TEXT    NOT NULL UNIQUE,
  mime          TEXT    NOT NULL,
  size          INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 站内通知（M3）：把「待你审批」「你的单据通过了/被驳回了」「单据被撤回了」这些
-- **已经发生的事件**写下来供人回看。
--
-- ★ 为什么是「独立的一张表」而不是「按 approval_tasks 实时 join 出来的视图」：
--   ① round 是**事件发生时的快照**：单据驳回后重提会 +1，若实时 join，
--      「第 1 轮被驳回」这条历史通知会自己改口成第 2 轮（同 flow_snapshot 一条教训）；
--   ② 撤回会把待审任务改成 skip、重提会新增任务行 —— join 出来的「事件」会凭空出现或消失；
--   ③ read_at（已读）只属于「通知」本身，从单据/任务里推导不出来。
--   所以：通知是**当时写下的那句话**，不是指向单据的视图。
--
-- ★ 写入必须与状态变更**在同一个事务里**（见 server/lib/notify.js 与 flow/engine.js）：
--   审批已经 COMMIT、通知才补写失败的话，用户永远不知道自己被驳回了。
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),   -- 收件人
  type       TEXT    NOT NULL CHECK (type IN ('task','approved','rejected','cancelled')),
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  request_id INTEGER REFERENCES requests(id),
  round      INTEGER NOT NULL DEFAULT 1,              -- ★ 事件发生时的轮次快照
  read_at    TEXT,                                    -- NULL = 未读
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

CREATE INDEX IF NOT EXISTS idx_attach_request  ON attachments(request_id, id);

-- 收件箱：按「谁的 + 读没读 + 新在前」查，正好是列表与未读数的形状
CREATE INDEX IF NOT EXISTS idx_notif_inbox     ON notifications(user_id, read_at, id);

-- Token 黑名单（M2）：JWT 本是无状态的，服务端没法主动销毁会话，
-- 所以「登出」原本只是前端丢掉 token —— 旧 token 在 24h 过期前仍能用，等于没登出。
-- 解法：每个 token 带一个唯一 jti，登出时把 jti 写进这张表；
-- 守卫每次请求查表，命中即 401。这样登出才真正生效。
-- expired_at 存 token 本身的 exp，方便日后写定时清理（过期的黑名单项已无意义，可 prune）。
CREATE TABLE IF NOT EXISTS token_blacklist (
  jti        TEXT    PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  reason     TEXT    NOT NULL DEFAULT 'logout',
  expired_at TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ===== M5 会议室预订 =====
-- 会议室。时段是「独占资源」：同一间房同一时段只能有一个预订。
CREATE TABLE IF NOT EXISTS meeting_rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  location   TEXT    NOT NULL DEFAULT '',
  capacity   INTEGER NOT NULL DEFAULT 10,
  status     TEXT    NOT NULL DEFAULT 'active',     -- active | disabled
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 预订单。时间不做字符串比较，一律折算成 **30 分钟槽序号**（距 00:00）：
--   08:00 → 16，09:30 → 19，22:00 → 44。左闭右开 [start_slot, end_slot)。
-- 这么存有三个好处：① 重叠判断变成整数区间比较，不用解析时间字符串；
-- ② 跨语言/跨时区没有歧义；③ 与下面的占用表共用同一套坐标。
-- ⚠️ 明确边界：**不支持跨天**（22:00–次日 02:00 这种不收），date 只存一天。
CREATE TABLE IF NOT EXISTS room_bookings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id      INTEGER NOT NULL REFERENCES meeting_rooms(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  date         TEXT    NOT NULL,                    -- YYYY-MM-DD
  start_slot   INTEGER NOT NULL,
  end_slot     INTEGER NOT NULL,                    -- 不含
  title        TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'booked',   -- booked | cancelled
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT
);

-- ★★ 占用表 = M5 的并发防线。一行 = 一个被占用的 30 分钟槽。
--    PRIMARY KEY (room_id, date, slot) 就是「同一间房同一天同一槽只能有一行」，
--    **冲突由数据库唯一约束兜底**，不靠应用层「先查再插」。
--    为什么不用「查重叠再插入」：那套在应用层看起来对，但一旦将来加入 await、
--    多进程或第二个写入口，「查」和「插」之间就存在窗口；而唯一约束无论谁写、
--    怎么写、怎么写错，都挡得住。代价是多一张表，且写入要在一个事务里做。
--    WITHOUT ROWID：这张表没有自己的 rowid 需求，主键就是全部内容，省一层间接。
CREATE TABLE IF NOT EXISTS room_slots (
  room_id    INTEGER NOT NULL REFERENCES meeting_rooms(id),
  date       TEXT    NOT NULL,
  slot       INTEGER NOT NULL,
  booking_id INTEGER NOT NULL REFERENCES room_bookings(id),
  PRIMARY KEY (room_id, date, slot)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_booking_room_date ON room_bookings(room_id, date, status);
CREATE INDEX IF NOT EXISTS idx_booking_user      ON room_bookings(user_id, date);

CREATE INDEX IF NOT EXISTS idx_blacklist_user ON token_blacklist(user_id);
