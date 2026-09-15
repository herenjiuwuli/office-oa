// Fastify 入口。业务规则不在这里 —— 这里只做「装配」：守卫 + 路由注册 + 静态托管 + 监听。
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { authGuard } from './server/guards.js'
import { dbPath, getDb } from './server/db.js'
import { handler } from './server/errors.js'

import authRoutes from './server/routes/auth.js'
import departmentRoutes from './server/routes/departments.js'
import userRoutes from './server/routes/users.js'
import requestRoutes from './server/routes/requests.js'
import todoRoutes from './server/routes/todo.js'
import announcementRoutes from './server/routes/announcements.js'
import auditLogRoutes from './server/routes/auditLogs.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const WEB_DIST = join(HERE, 'web', 'dist')

/**
 * @param {object} [opts]
 * @param {boolean} [opts.serveStatic] 是否托管 web/dist。测试传 false，
 *   让「接口测试」不依赖「前端有没有构建过」——两件事不该互相耦合。
 */
export function buildApp({ serveStatic = true } = {}) {
  const app = Fastify({ logger: false })

  // 全局鉴权守卫：onRequest 在所有路由之前执行（非 /api 路径直接放行，见 server/guards.js）
  app.addHook('onRequest', authGuard)

  app.get('/health', async () => ({ ok: true, service: 'office-oa', ts: Date.now() }))

  app.register(authRoutes)
  app.register(departmentRoutes)
  app.register(userRoutes)
  app.register(requestRoutes)
  app.register(todoRoutes)
  app.register(announcementRoutes)
  app.register(auditLogRoutes)

  // 前端构建产物（web/dist）。没构建过就跳过 —— 后端依然能独立当 API 服务用。
  const hasWeb = serveStatic && existsSync(join(WEB_DIST, 'index.html'))
  if (hasWeb) {
    app.register(fastifyStatic, { root: WEB_DIST, prefix: '/' })
  }

  // 兜底 404。要区分两类「找不到」：
  //   /api/*  → JSON 404（前端 fetch 依赖这个，返回 HTML 会让它解析失败）
  //   其他    → 交给前端 index.html，让 vue-router 自己处理（history 模式下刷新子路由必须这样）
  app.setNotFoundHandler((req, reply) => {
    const url = (req.url || '').split('?')[0]
    if (url.startsWith('/api')) {
      return reply.code(404).send({ error: `接口不存在：${req.method} ${req.url}` })
    }
    if (hasWeb && req.method === 'GET') {
      return reply.sendFile('index.html')
    }
    return reply.code(404).send({
      error: hasWeb
        ? `路径不存在：${req.method} ${req.url}`
        : '前端还没构建。先跑 `npm run build`，或用 `npm run dev` 起开发服务器。',
    })
  })

  // 统一错误出口（异常兜底，业务错误已在 handler 内处理）
  app.setErrorHandler((err, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: '参数校验失败：' + err.message })
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message })
    }
    return reply.code(500).send({ error: '服务器内部错误：' + err.message })
  })

  // 供 smoke 检查用：证明装配成功
  app.get(
    '/api/_ping',
    handler(async (req) => ({ ok: true, user: req.ctx.user.username })),
  )

  return app
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const port = Number(process.env.PORT) || 3200
  const app = buildApp()
  getDb() // 确保建表（首次运行自动建）
  const hasUser = getDb().prepare(`SELECT COUNT(*) AS n FROM users`).get().n > 0
  if (!hasUser) {
    console.warn('[office-oa] 数据库里还没有用户，先跑 `npm run seed` 灌入种子数据。')
  }
  if (!existsSync(join(WEB_DIST, 'index.html'))) {
    console.warn('[office-oa] 没找到 web/dist —— 只提供 API。要看界面请跑 `npm run dev`，或先 `npm run build`。')
  }
  app
    .listen({ port, host: '127.0.0.1' })
    .then(() => {
      console.log(`[office-oa] http://127.0.0.1:${port}  (db: ${dbPath()})`)
    })
    .catch((e) => {
      console.error('[office-oa] 启动失败：', e.message)
      process.exit(1)
    })
}
