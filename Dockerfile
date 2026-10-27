# office-oa（被测系统）· 多阶段构建
#
# 为什么这个项目也要有 Docker：
# 它是「被测试的那个系统」，演示时最常被要求的一句话是「能起一下看看吗」。
# 只有 API 测试平台有 Dockerfile、被测系统没有，等于「工具能一键起、被测的东西不能」——
# 面试里这就是个说不圆的地方。
#
# 特点：零原生依赖（node:sqlite 是 Node 内置），所以 alpine 够用，不需要编译工具链。
#
#   docker compose up -d --build     # 起在 http://localhost:3200
#   docker compose down              # 停
#   docker compose down -v           # 连数据一起删（下次启动会重新 seed）

# ---- 构建阶段：装依赖 + 构建前端 ----
FROM node:22-alpine AS build
WORKDIR /app

# 先只拷依赖清单，让这层缓存能被复用（改业务代码不用重装依赖）
COPY package.json package-lock.json* ./
# --legacy-peer-deps：npm 10.9.x 解析这棵依赖树时会崩在 arborist 的 edgesOut，
# 本地与 CI 都踩过（CI 里裸 npm ci 6 秒就红）。这里统一带上，别改回裸 install。
RUN npm install --legacy-peer-deps

COPY . .
# 前端在 web/ 子目录，单独装依赖再构建（后端同源托管 web/dist，单端口）
RUN npm --prefix web install --legacy-peer-deps && npm --prefix web run build

# ---- 运行阶段 ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3200
# ⚠️ 必须绑 0.0.0.0：容器内默认只监听 127.0.0.1 的话，宿主的端口映射连不进来
# （docker-proxy 转发到容器 IP，不是容器回环），表现是「容器在跑但浏览器连不上」。
ENV HOST=0.0.0.0

COPY --from=build /app /app
# 只留生产依赖：Playwright / vitest / concurrently 不进镜像
# ⚠️ prune 也要 --legacy-peer-deps —— 同一个 npm 10.9.x arborist 崩溃
# （Cannot read properties of null (reading 'edgesOut')）在**三条独立命令**上都会犯：
# 本地 npm install、CI 的 npm ci、镜像里的 npm prune。
# 2026-10-28 CI 的 docker job 第一次跑就红在这行（前两处早修了，这处漏了）——
# 这正是「Dockerfile 只做静态校验不够」的实证：它构建能过、运行期才炸。
RUN npm prune --omit=dev --legacy-peer-deps && npm cache clean --force

EXPOSE 3200
# SQLite 数据库落在这里。⚠️ 不挂卷 = 重启后单据和账号全没
VOLUME ["/app/data"]

# 健康检查用 node 原生 fetch（alpine 里没有 curl，别写成 curl 否则永远 unhealthy）
HEALTHCHECK --interval=30s --timeout=3s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3200/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 首次启动自动写入演示数据（8 个账号 + 单据 + 会议室 + 考勤），
# 否则打开页面连登录都登不进去 —— schema 会自动建表，但表里没有人。
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
