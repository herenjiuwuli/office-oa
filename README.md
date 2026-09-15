# office-oa · 办公 OA 系统（M1 后端 + 前端完成 · M2 Playwright E2E + CI 完成）

> **这不是「又一个管理系统」，而是一个「专门用来被测试的 OA」。**
> 自用练手 + 求职作品。需求原型取自真实 MCN 办公场景（请假 / 活动物料 / 采购审批），
> 但它真正的价值是：**天然带权限、多角色、单据状态机、并发审批 —— 一个理想的被测系统（SUT）。**

配合 `api-test-platform` 使用，可以讲出这样一句话：

> 「我写了一个被测系统（SUT），又用自己的测试平台把它测穿了。」

---

## ⛔ 安全红线（不许破）

1. **绝不接公司真实数据。** 本仓库所有数据（人名、部门、单据内容）均为虚构。
2. **不做生产部署。** 只在本机跑，不上公司内网、不给同事开账号。
3. **对外展示脱敏。** 任何截图 / 演示都不含真实业务信息。
4. **不签任何交付。** 公司真要用，走正式外包 / 合同，不做口头承诺。

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Node 22 + **Fastify 5** | 内置 JSON Schema 校验，路由契约清晰 |
| 存储 | **node:sqlite**（Node 内置） | 零原生依赖；关系型数据必须用关系库 |
| 鉴权 | **自写 JWT**（scrypt + 手写 HS256） | 不引第三方库，见 `server/auth.js` |
| 前端 | **Vue 3.5 + vite + vue-router** | 纯 CSS、无 UI 框架、**不用 Pinia**（单例 reactive 就够） |
| 前端测试 | 自写三个零依赖静态扫描脚本 | 抓「build 过但运行时 ReferenceError」 |
| 接口测试 | **vitest** | 84 条用例，见 `tests/` |
| 真机验收 | 自写零依赖 CDP 脚本 | 走真实 Chrome 跑完审批全链路，见 `scripts/oa-ui-check.mjs` |
| UI 自动化 | **Playwright**（`channel: 'chrome'`） | 9 条用例，见 `e2e/`。**不下载浏览器**，详见「UI 自动化」一节 |
| CI | **GitHub Actions** | 静态扫描 → 构建 → 接口测试 → UI 测试，见 `.github/workflows/ci.yml` |
| 语言 | 全 JavaScript | 不用 TypeScript（M1 不引入额外复杂度） |
| 端口 | **3200**（前端 dev 用 5273，E2E 用 3300） | 3001 = api-test-platform，3100 = job-hunter |

---

## 快速开始

```bash
npm install --legacy-peer-deps      # ⚠️ 见下方「已知坑」
npm install --prefix web --legacy-peer-deps
npm run seed                        # 灌入虚构种子数据（库里没数据时）

# 方式一：开发（前端热更新，后端热重载）
npm run dev                         # 打开 http://127.0.0.1:5273

# 方式二：单端口（先构建，后端起在 3200 同时托管前端）
npm run build
npm start                           # 打开 http://127.0.0.1:3200

npm test                            # ② 跑全部 84 条接口用例
npm run check:frontend              # ① 前端静态扫描（commit 前必跑）
node scripts/oa-ui-check.mjs        # ③ 真机浏览器跑完「提交→两级审批→归档 + 驳回重提」（36 断言）
npm run test:e2e                    # ③ Playwright 跑同一链路（9 条，自动起 3300 端口的服务）
npm run verify                      # 一条命令：静态扫描 + 构建 + 接口测试 + UI 测试（= CI 跑的东西）
```

重置数据（会清空全部表）：

```bash
node seed.js --force
```

### 种子账号

密码统一 `oa123456`。人名全为虚构。

| 用户名 | 姓名 | 角色 | 说明 |
|---|---|---|---|
| `admin` | 张北 | boss | 总经理，全权限 |
| `hr01` | 李南 | hr | 人事：组织架构 + 员工 + 公告 + 看全部单据 |
| `ops01` | 王东 | dept_manager | 内容运营经理，同时是 `ops02`/`ops03` 的直属上级 |
| `ops02` | 赵西 | employee | 普通员工（上层越权测试用这个） |
| `ops03` | 孙小 | employee | 普通员工 |
| `exe01` | 周大 | dept_manager | 艺人执行经理（会签的第二个审批人） |
| `exe02` | 吴小 | employee | 普通员工 |
| `gy01` | 郑无 | employee | **故意不设直属上级** —— 用于验证「上级为空」的兜底 |

---

## 接口一览

状态码规范：`400` 参数校验失败 · `401` 未登录/token 失效/账号停用 · `403` 无权限/不是审批人/横向越权 · `404` 不存在 · `409` 状态冲突（重名/状态机非法流转/并发抢单）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/auth/login` | 公开 | 登录，返回 token + 角色 + 权限码 |
| POST | `/api/auth/logout` | 登录 | 记审计（JWT 无状态，真正登出是前端丢 token） |
| GET | `/api/me` | 登录 | 当前用户档案 + 角色 + 权限码 |
| GET | `/api/departments` | 登录 | 部门树（`?flat=1` 返回平铺） |
| POST / PATCH | `/api/departments` `/:id` | `dept:write` | 增改部门 |
| GET | `/api/users` | `user:read` | 员工列表（支持 `deptId`/`status`/`q` 过滤） |
| POST / PATCH | `/api/users` `/:id` | `user:write` | 增改员工（用户名重复 → 409） |
| GET | `/api/request-types` | 登录 | 单据类型元数据（前端据此渲染表单） |
| GET | `/api/flows` | `flow:read` | 流程模板 + 步骤 |
| GET | `/api/requests` | 登录 | 单据列表，**默认只看自己的**；`request:read:all` 可看全部（`?mine=1` 强制只看自己） |
| POST | `/api/requests` | 登录 | 建单（只建草稿，提交是单独一步） |
| GET | `/api/requests/:id` | 申请人 / 审批人 / `request:read:all` | 详情 + 流程快照 + 审批时间线 |
| POST | `/api/requests/:id/submit` | 申请人 | 提交（草稿 / 已驳回可提交） |
| POST | `/api/requests/:id/approve` | 当前步审批人 | 同意 |
| POST | `/api/requests/:id/reject` | 当前步审批人 | 驳回（带批注） |
| POST | `/api/requests/:id/cancel` | 申请人 | 撤回（草稿 / 审批中可撤回） |
| GET | `/api/todo` | 登录 | 我的待办 |
| GET | `/api/announcements` | 登录 | 公告列表 |
| POST | `/api/announcements` | `announcement:write` | 发公告 |
| GET | `/api/audit-logs` | `audit:read` | 审计日志 |
| GET | `/health` | 公开 | 健康检查 |

---

## 前端

Vue 3.5 + vue-router + 纯 CSS。**不引 UI 框架、不用 Pinia** —— 共享状态只有「当前登录者」，一个 `reactive` 单例（`web/src/store.js`）就够，引 Pinia 是加复杂度不加分。

| 视图 | 路径 | 说明 |
|---|---|---|
| 登录 | `/login` | 8 个演示账号一键填充（验收要两个窗口分别登申请人和审批人） |
| 总览 | `/` | 待办数 / 我的单据统计 / 最近公告 / **我的角色与权限码**（RBAC 可视化） |
| 我的待办 | `/todo` | 只列「轮到你 + 单据仍在审批中」；同意/驳回在同一抽屉里，避免误点 |
| 单据中心 | `/requests` | 筛选 + 数据范围（有 `request:read:all` 才能切「全部」） |
| 新建单据 | `/requests/new` | 表单字段从后端 `/api/request-types` 拉，前端只决定「怎么渲染」 |
| 单据详情 | `/requests/:id` | 审批时间线（含多轮历史）+ 流程快照 + 按身份算出的操作按钮 |
| 部门架构 | `/departments` | 树形，`dept:write` 才有增改入口 |
| 员工管理 | `/users` | 需 `user:read`；**普通员工打开会看到后端真实 403** |
| 流程模板 | `/flows` | 只读，展示步骤 / 审批人类型 / 或签会签 |
| 公告 | `/announcements` | 列表 + 发布抽屉（`announcement:write`） |
| 审计日志 | `/audit-logs` | 需 `audit:read`（仅总经理） |

### ⭐ 前端刻意「不拦」越权

路由守卫**只做一件事：没登录就赶去登录页**。它**不按权限拦路由**。

理由：
- 前端拦不拦都不影响安全 —— 后端每个接口都独立校验，前端藏起来只是整洁；
- **放行之后页面会显示后端真实返回的 403「缺少权限：user:read」**，比前端悄悄跳转更有价值：
  **越权这件事看得见、能被验证**，而不是被前端伪装成「页面不存在」；
- 菜单项仍然按权限隐藏（`can()`），但那是 UX，不是安全。

评价一个系统的权限，看不该只是「点不到」，而应该是「**点了会被后端拒绝**」。这个设计就是为了让这一点在界面上可见。

### ⭐ 测试钩子

关键输入框带 `data-t="..."` / `data-field="..."` / `data-item="N"` 属性，供 `scripts/oa-ui-check.mjs`（以及 M2 的 Playwright）定位。这些属性是惰性的，不影响运行时。

### 界面截图

截图由脚本生成（真机 Chrome 拍，不是手截的）：`node scripts/oa-screenshots.mjs` → `docs/screenshots/`

| 页面 | 图 |
|---|---|
| 登录页（8 个演示账号一键填充） | `docs/screenshots/01-登录页.png` |
| 总览（身份 + 权限码可视化） | `docs/screenshots/02-总览-身份与权限.png` |
| 我的待办 | `docs/screenshots/03-我的待办.png` |
| 审批抽屉 | `docs/screenshots/04-审批抽屉.png` |
| 单据详情（**会签时间线**） | `docs/screenshots/05-单据详情-会签时间线.png` |
| 单据详情（已归档） | `docs/screenshots/06-单据详情-已归档.png` |
| 部门架构 | `docs/screenshots/07-部门架构.png` |
| 员工管理（RBAC） | `docs/screenshots/08-员工管理-RBAC.png` |
| **越权：普通员工访问员工管理 → 后端真实 403** | `docs/screenshots/09-越权-后端真实403.png` |
| 移动端 390px | `docs/screenshots/10-移动端390.png` |

---

## 关键设计决策（面试可讲）

### 1. ⭐ 流程快照 `requests.flow_snapshot`

提交单据时，把当时的流程步骤**快照**进单据本身。

**为什么**：管理员事后改了流程模板（比如把两级审批改成一级），**在途单据仍必须按老流程走完**，否则会凭空多出/少掉审批人。真实 OA 必须这样，也是最容易漏、面试官最常追问的一点。

测试用例：`tests/flow.test.js` → 「流程快照：审批中修改流程模板，在途单据仍按老流程走完」

### 2. ⭐ 并发防线：条件更新，不靠应用层加锁

```sql
UPDATE approval_tasks SET action = ?, comment = ?, acted_at = datetime('now')
 WHERE id = ? AND action IS NULL          -- ★ 只看还「待审」的行
```

检查返回的 `changes`：为 0 说明已被处理（重复点击 / 并发抢单）。靠数据库单语句的**原子性**，不需要锁、不需要事务排队。

测试用例：`tests/flow.test.js` → 「同一人重复审批 → 第二次 409」「并发：同时提交两次 → 恰好一个 200、一个 409」

### 3. ⭐ 授权先于状态（这条是写测试时改出来的）

`actOnRequest` 里原本先判「状态是不是 pending」（409），再判「你是不是审批人」（403）。
写测试时发现：**无关的人拿一个已归档的单据 id 去调审批接口，会收到 409 —— 等于告诉他「这单存在、且不是待审」。** 这是一个信息泄漏。

改成 **先授权、后状态**：先确认「你跟这张单据有关系」，再谈状态。

测试用例：`tests/permission.test.js` → 「与单据无关的员工既看不到详情，也审不了」

### 4. `round` 字段：驳回后重提要保留上一轮痕迹

如果重提时直接删掉旧任务，上一轮「谁因为什么驳回」就没了。所以 `requests.round` 和 `approval_tasks.round` 配套：重提时 +1，两轮的记录都留着。

### 5. 权限不缓存进 token

`server/guards.js` 每次请求都回查数据库拿角色和权限。原因有两个：
- 账号被停用后，旧 token 必须**立刻**失效（否则离职员工的 token 还能用到过期）
- 角色/权限调整后不能拿签发时的快照用到底

代价是每请求一次多几次查询，M1 规模完全可接受。

### 6. 单据用「通用表 + JSON form_data」

一期重点是**审批引擎**，不是单据字段。通用表 + JSON 让「加一种单据类型」的成本降到近乎为零（加一个 validator 即可）。JSON 字段顺便还是测边界的好靶子（非法 JSON / 超长 / 类型错）。

代价：无法用外键约束 form_data 内部结构，查询统计弱。M2 若需要报表再考虑拆表。

---

## 测试（三层）

```bash
npm run verify     # 一条命令跑完下面三层 + 构建（本地复现 CI）
```

| 层 | 命令 | 规模 | 能发现什么 |
|---|---|---|---|
| ① 静态扫描 | `npm run check:frontend` | 3 个零依赖脚本 | 前端「未声明标识符 / 模板里组件或事件函数没声明 / ref 忘了 .value」——**`vite build` 会放过这些，运行时才炸** |
| ② 接口测试 | `npm test` | **84 条**（vitest） | 权限、越权、状态机、并发、边界（看不到界面） |
| ③ UI 测试 | `npm run test:e2e`（Playwright）／`node scripts/oa-ui-check.mjs`（自写 CDP） | **9 条** / **36 条断言** | 布局、跳转、真实 403、归档后按钮该不该在 |

> ⭐ 这三层**不是重复，是递进**：第 ② 层 84 条全绿的时候，第 ③ 层照样抓出了两个真缺陷
> （登录页多出一条侧边栏、归档单据提示「还没轮到你」）。
> **测试的层次决定你能看见什么层次的缺陷。**

### 接口测试（vitest）

- **84 条用例，4 个文件**：`auth` / `permission` / `flow` / `requests`
- 其中**越权 + 边界**类 ≥ 20 条（纵向越权、横向越权、自批、token 篡改、停用账号、上级为空、并发抢单、状态机非法流转）
- 隔离方式：`tests/setup.js` 把 `DB_PATH` 设成 `:memory:`，每个测试文件跑在自己的环境里 → 各自一份内存库，天然互不干扰
- 每个用例前 `resetDb()` 丢掉旧连接、重开空库再灌种子 → 用例之间零耦合
- **故意不提供「测试旁路开关」**：一个 `API_AUTH_DISABLED` 之类的开关会悄悄把鉴权整个关掉，测试全绿但生产裸奔。测试一律走真实登录拿 token。

### 真机浏览器验收（UI 层）

```bash
npm start                        # 或 npm run dev（dev 时改传 http://127.0.0.1:5273）
node scripts/oa-ui-check.mjs     # 36 条断言，走一段就全过
```

用系统已装的 Chrome + Node 内置 WebSocket 直连 CDP，**不下载 Chromium、零 npm 依赖**。断言按业务语义写，覆盖：

| 分组 | 关键断言 |
|---|---|
| A 未登录守卫 | `/` 被重定向到 `/login`；登录页**不渲染 App 外壳**、占满整屏 |
| B 登录 + RBAC | 员工登录后菜单**看不到**「员工管理」「审计日志」 |
| C 纵向越权 | 直接敲 `/users` 的 URL → 页面显示后端真实 **403 + `user:read`** |
| D 提交 | 建单 → 提交 → 详情页「审批中」+ 第 1 步等待审批 + 流程快照固化 |
| E 一级审批 | 上级待办里出现该单 → 抽屉带出申请人与事由 → 同意后推进到第 2 步 |
| F 二级审批 | 人事复核通过 → **归档「已通过」**，且页面上「同意/驳回/提交/撤回」按钮数 = 0 |
| G 驳回重提 | 不填理由被前端拦下；驳回后状态「已驳回」；重提后**时间线出现 2 个轮次分隔**，第 1 轮驳回痕迹保留 |
| H 移动端 | 真改视口到 390px，量 `scrollWidth`（不靠截图，截图会造假象） |
| I 登出 | 回到 `/login` 且 localStorage 里的 token 已清除 |

> ⚠️ 这个脚本会**真实写库**（每跑一次新增 2 张单据）。它靠单据 id 定位，所以累积数据不会让脚本失效；想清干净跑 `node seed.js --force`。

跑这段脚本的价值：它抓出了两个我自己写代码时没意识到的缺陷 ——
1. **登录页旁边渲染出了侧边栏**（`App.vue` 无条件套外壳）——当时所有接口用例和静态扫描全绿，**因为断言只看了 pathname 和按钮，没看布局**；
2. **归档单据上给已审过的审批人显示了「但当前还没轮到你」**——文案分支顺序写反了，单据都结束了还说"没轮到你"。

这两条都不是「代码报错」，是 36 条业务断言逼出来的。光靠 `npm test` + `npm run check:frontend` 一个都发现不了。

---

## UI 自动化（M2：Playwright）

```bash
npm run test:e2e        # 重置 E2E 专用库 → 自动拉起后端（3300）→ 跑 9 条用例
npm run test:e2e:report # 看 HTML 报告
npm run verify          # 本地一条命令复现整条 CI：静态扫描 → 构建 → 接口 → UI
```

**为什么 M1 已经有自写 CDP 脚本了还要 Playwright？两者分工不同：**

| | `scripts/oa-ui-check.mjs`（自写 CDP） | `e2e/`（Playwright） |
|---|---|---|
| 依赖 | **零**，系统 Chrome + Node 内置 WebSocket | 需装 `@playwright/test` |
| 断言/重试/报告 | 自己写（36 条手写断言） | 框架自带（自动等待、重试、trace、HTML 报告） |
| 失败留痕 | 只有控制台输出 | trace 可回放 + 失败截图 |
| 定位 | **本机随手验一遍**（离线也能跑） | **接 CI 做回归** |

两者跑的是**同一条业务链路**，互为交叉验证。

### ⭐ 不下载浏览器：`channel: 'chrome'`

Playwright 默认要 `npx playwright install` 下载几百 MB Chromium。这个项目**直接复用系统已装的 Chrome**：

```js
use: { channel: 'chrome' }   // playwright.config.js
```

装包时也要跳过下载：`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -D @playwright/test`。
GitHub Actions 的 `ubuntu-latest` 镜像**自带 Google Chrome stable**，所以 CI 里同样免下载。

### ⭐ E2E 用独立数据库

`e2e/seed-e2e.mjs` 把 `DB_PATH` 指到 `data/e2e.db`（不是开发用的 `data/app.db`），每次跑之前 `--force` 重置。
→ **跑测试不污染开发库**，也不需要「跑完记得手动清库」。

### 覆盖的 9 条用例

| 文件 | 用例 |
|---|---|
| `e2e/guard-rbac.spec.js` | 未登录守卫 + 登录页不套外壳 / RBAC 菜单隐藏 + **纵向越权看到真实 403** |
| `e2e/approval-flow.spec.js` | 提交 → 一级审批 → 二级审批 → 归档 / **归档文案语义** / 驳回不填理由被拦 → 驳回 → 重提（轮次保留）/ 移动端 390px / 登出清 token |

> 其中「归档单据给已审过的审批人看」这条比 CDP 脚本更严：CDP 只断言了「没有可执行的操作」（三个分支都命中，其实证明不了什么），
> Playwright 直接断言 **`单据已结束` 出现且 `还没轮到你` 不出现** —— 这才是当年那个文案 bug 的精确判据。

---

## CI（GitHub Actions）

`.github/workflows/ci.yml`：push / PR 时按顺序跑

1. **静态扫描** `npm run check:frontend`（拦「build 过但运行时 ReferenceError」）
2. **构建前端** `npm run build`（后端要托管 `web/dist`）
3. **接口测试** `npm test`（84 条）
4. **UI 测试** `npm run test:e2e`（9 条，用 runner 自带 Chrome）

失败时自动上传 Playwright HTML 报告（artifact，保留 7 天）。

> ⚠️ 三个准备动作按顺序不能少：静态扫描要在构建前发现问题，构建要在 UI 测试前（否则后端没有前端产物可托管）。

---

## 已知坑（踩过的）

| 坑 | 现象 | 解法 |
|---|---|---|
| **npm 10.9 arborist 崩** | `npm install` 报 `Cannot read properties of null (reading 'edgesOut')`，栈在 `@npmcli/arborist/build-ideal-tree.js` 的 `#loadPeerSet` | 用 `npm install --legacy-peer-deps` 跳过 peer 解析（本仓库 vitest 的 peer 树会触发这个 bug） |
| **Git Bash 路径污染 npm 缓存** | `npm install --cache /c/Users/...` 被解释成 `D:\c\Users\...`（相对当前盘符） | 缓存路径写 Windows 原生形式：`--cache "C:/Users/..."` |
| **curl 打本机返回 502** | 沙箱透明代理把 127.0.0.1 也代理了 | `curl --noproxy "*" http://127.0.0.1:3200/...` |
| **`:memory:` 不生效、测试写进真实库** | 模块顶层 `const` 提前把 DB_PATH 快照下来 | `DB_PATH` 必须在 `getDb()` 内部**惰性求值**（见 `server/db.js` 注释） |
| **外键不生效** | SQLite 默认不开外键 | 打开连接后 `PRAGMA foreign_keys = ON` |
| **`vite build` 通过 ≠ 运行时无错** | 引用了未声明标识符只 warning | 前端 commit 前跑 `npm run check:frontend`（三个零依赖静态扫描脚本） |
| **静态扫描把正则当标识符** | `/^[A-Z]+$/`、`/[T ]/` 里的 `A`/`T` 被报成「未声明的大写标识符」 | 脚本 `strip()` 原来只去注释/字符串，没去**正则字面量**。已在 `check-vue-undef.mjs` 里补上（只在「可能开始正则」的位置剥，避免把 `a / b / c` 的除号也吃掉） |
| **单端口跑起来后 `/` 是 404** | 后端只注册了 `/api/*` 和 `/health`，没托管前端 | `index.js` 里注册 `@fastify/static` 指向 `web/dist`（没构建过就跳过，后端仍可独立当 API 用） |
| **刷新子路由 404 / API 404 变成 HTML** | SPA history 模式 + 统一 404 互相打架 | `setNotFoundHandler` 分流：`/api/*` 返 JSON 404，其余 GET 交给 `index.html` |
| **CDP 脚本点不到抽屉里的按钮** | 用 `offsetParent === null` 判「不可见」 | **规范规定 `position: fixed` 元素的 `offsetParent` 就是 `null`**（实测 Chrome 152：明明可点，宽 100）。改用 `getComputedStyle` + `getBoundingClientRect()` |
| **真机断言随机假失败** | `nav()` 后就断言「列表里有 #N」，此时异步数据还没回来 | 就绪条件 `innerText.length > 60` 太松（侧边栏字数就够）。要再等**页面专属**条件（见 `oa-ui-check.mjs` 的 `goTodo()` / `goDetail()`） |
| **CDP 脚本「静默超时」** | 想用 `window.__t.text().includes(...)` 当就绪条件，结果一直等到超时 | **整页导航会销毁旧 JS 上下文**，而原实现是「等就绪**之后**才注入 helpers」→ 条件里引用 `window.__t` 永远为假。已改成导航后先注入 helpers 再轮询 |
| **Playwright 装包时偷偷下几百 MB 浏览器** | `npm i -D @playwright/test` 的 postinstall 会去下载 Chromium | 装包时加 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`；配置里用 `channel: 'chrome'` 复用系统 Chrome |
| **E2E 断言「第 2 轮」会假通过** | 提交按钮文案本身就写着「修改后重新提交（第 2 轮）」，`includes('第 2 轮')` 一上来就命中提交**前**的状态 | 改用「时间线上出现 2 个 `.round-sep`」——只有重提真的生成了 round=2 的任务才会出现 |

---

## M1 边界（**刻意不做**，防膨胀）

| 不做 | 原因 |
|---|---|
| 权限管理界面 | 权限「检查」才是核心；M1 用 `server/permissions.js` 常量 + 种子数据 |
| 考勤打卡 / 统计报表 | 与审批流主干无关，属纯 CRUD |
| 文件附件上传 | 活动物料要传图 → M1 用「链接字段」代替 |
| AI 审批摘要 | M2 |
| 消息通知（站内信 / 邮件） | 待办列表已能替代 |
| 组织架构拖拽排序 | M1 用 `sort` 数字字段 |
| Playwright E2E | M1 不做；**M2 已补**（见「UI 自动化」一节）。M1 用自写的零依赖 CDP 脚本覆盖了同样的链路 |
| Docker / 上线部署 | 见安全红线 |
| TypeScript / Pinia | 加复杂度不加分 |

### M2 进度

1. ✅ **Playwright UI 自动化 + 接 CI** —— 9 条用例（`e2e/`）+ GitHub Actions（`.github/workflows/ci.yml`），见「UI 自动化」与「CI」两节
2. **AI 审批摘要**：审批人不用看全文，AI 给摘要 + 风险提示（复用 job-hunter 的 DeepSeek 配方）
3. 权限管理界面
4. 审批人会签范围按部门收敛（现在 `role=dept_manager` 会命中所有部门经理）
5. 附件上传
6. token 黑名单 / 主动失效

---

## 面试材料

| 文件 | 内容 |
|---|---|
| [`docs/面试弹药-office-oa.md`](docs/面试弹药-office-oa.md) | 一句话定位 / 6 个技术亮点 / 「我改过的点 + 为什么」候选清单 / 13 道高频深挖题 + 答案 / 一句话收尾 |
| [`docs/关源码复现-office-oa.md`](docs/关源码复现-office-oa.md) | 9 道复现练习 + 示范轮（第 2 题给了 `actOnRequest()` 六步标准答案）+ 评分标准 + 错题本模板 |

> ⚠️ 两份都写明**诚实边界**：本项目是「我定需求 + AI 实现」的协作产出，**不能装成全独立手写**。正确讲法是「需求、验收标准、缺陷判定是我定的；技术方案逐条复现，能讲清为什么这么设计」。
> 这个项目和别的练手项目最大的不同：**它本身就是被测系统（SUT）**，配合 `api-test-platform` 一起讲 = 「我写了一个被测系统，又用自己的测试平台把它测穿了」。

---

## 目录结构

```
office-oa/
├─ index.js                     只做装配：守卫 + 路由注册 + 静态托管 + 监听
├─ seed.js                      虚构种子数据
├─ playwright.config.js         E2E 配置（channel: chrome 不下载浏览器 / E2E 独立库 / 自动起服务）
├─ .github/workflows/ci.yml     静态扫描 → 构建 → 接口测试 → UI 测试
├─ server/
│  ├─ db.js                     SQLite 封装（DB_PATH 惰性求值）
│  ├─ schema.sql                12 张表 + 索引
│  ├─ auth.js                   scrypt + 手写 HS256 JWT（纯函数，不碰库）
│  ├─ guards.js                 全局鉴权守卫（每次回查用户状态与权限）
│  ├─ permissions.js            权限码字典 + requirePerm 中间件
│  ├─ errors.js                 BusinessError + 统一错误出口
│  ├─ audit.js                  审计日志
│  ├─ serialize.js              DB snake_case → API camelCase
│  ├─ flow/
│  │  ├─ engine.js            ⭐ 审批引擎（本项目最核心的文件）
│  │  └─ validators.js          各单据类型的 form_data 校验
│  └─ routes/                   auth / departments / users / requests / todo / announcements / auditLogs
├─ web/                         前端（独立 package.json）
│  ├─ index.html
│  ├─ vite.config.js            dev 端口 5273，代理 /api → 3200
│  └─ src/
│     ├─ App.vue                外壳：登录页不套侧边栏；菜单按权限隐藏
│     ├─ router.js              守卫只做「登录与否」，不按权限拦路由（见「前端」章节）
│     ├─ store.js               单例 reactive session（不用 Pinia）
│     ├─ api.js                 统一 fetch + 401 自动回登录页
│     ├─ labels.js              状态机 / 动作 / 审批人类型的展示映射
│     ├─ forms.js               单据表单字段元数据（渲染 + 归一化 + 必填校验）
│     ├─ style.css              纯 CSS 设计系统（含 820px 响应式）
│     └─ views/                 11 个视图
├─ docs/                        面试材料（面试弹药 + 关源码复现练习）
├─ docs/screenshots/            真机截图（由 scripts/oa-screenshots.mjs 生成）
├─ tests/                       setup + helpers + 4 个测试文件（84 用例）
├─ e2e/                         Playwright UI 用例（9 条）+ 专用库重置脚本
└─ scripts/
   ├─ check-vue-undef.mjs       静态扫描：未声明的大写标识符（已修「正则字面量误报」）
   ├─ check-vue-tpl.mjs         静态扫描：模板里未声明的组件/事件函数
   ├─ check-vue-refvalue.mjs    静态扫描：ref 忘了 .value
   ├─ oa-ui-check.mjs           真机浏览器验收：审批全链路 + 越权 + 移动端（36 断言）
   └─ oa-screenshots.mjs        真机截图
```

---

## 状态机

```
draft ──submit──▶ pending ──┬──(当前步通过 且 是最后一步)──▶ approved
                            ├──(当前步通过 且 还有下一步)──▶ pending (current_step+1，生成新任务)
                            ├──(当前步驳回)────────────────▶ rejected ──resubmit──▶ pending (round+1)
                            └──(申请人撤回)────────────────▶ cancelled
```
