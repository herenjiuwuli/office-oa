// 业务错误：用 statusCode 明确对应 HTTP 状态码，避免路由里到处 if/else 拼错误响应。
// 状态码规范（写接口用例的基准）：
//   400 参数校验失败          401 未登录 / token 失效 / 用户已停用
//   403 已登录但无权限 / 不是该单据审批人 / 横向越权
//   404 资源不存在             409 状态冲突（重名 / 状态机非法流转 / 并发抢单）
export class BusinessError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'BusinessError'
    this.statusCode = statusCode
  }
}

export const badRequest = (msg) => new BusinessError(400, msg)
export const unauthorized = (msg) => new BusinessError(401, msg)
export const forbidden = (msg) => new BusinessError(403, msg)
export const notFound = (msg) => new BusinessError(404, msg)
export const conflict = (msg) => new BusinessError(409, msg)

/**
 * 统一错误出口。已知业务错误按其 statusCode 返回；未知异常一律 500，
 * 且**不把堆栈吐给客户端**（只给一条可读信息，详情留在服务端日志）。
 */
export function toReply(reply, e) {
  if (e instanceof BusinessError) {
    return reply.code(e.statusCode).send({ error: e.message })
  }
  // Fastify schema 校验失败
  if (e && e.validation) {
    return reply.code(400).send({ error: '参数校验失败：' + e.message })
  }
  return reply.code(500).send({ error: '服务器内部错误：' + (e?.message || String(e)) })
}

/** 把 async 处理器包一层，自动 catch 成统一错误响应 */
export function handler(fn) {
  return async (req, reply) => {
    try {
      return await fn(req, reply)
    } catch (e) {
      return toReply(reply, e)
    }
  }
}
