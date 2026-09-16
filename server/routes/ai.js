// AI 路由（M2，可选能力）。
// 单独成一个文件的理由：这是本项目唯一「依赖外部服务」的模块。
// 放在独立文件里，能一眼看清它的边界 —— 只读、只展示、不落库、失败即降级。
//
// 设计红线（对应 tests/ai.test.js 的用例）：
//   · 复用 canViewRequest —— 能看单据的人才配拿摘要，否则是横向越权
//   · 结果【不写库】：AI 的输出是「展示物」，不是事实，不能污染 requests 表
//   · 失败不抛错：一律 200 + { available:false, reason }，前端自己决定怎么提示
import { forbidden, handler } from '../errors.js'
import { logAction } from '../audit.js'
import { serializeRequest } from '../serialize.js'
import { canViewRequest, getRequestOr404 } from '../flow/engine.js'
import { aiStatus, summarizeRequest } from '../lib/ai.js'

export default async function aiRoutes(app) {
  // 前端据此决定「AI 摘要」按钮是否可点（没配 key 就别让用户白点）
  app.get(
    '/api/ai/status',
    handler(async () => aiStatus()),
  )

  // 用 POST 而不是 GET：这是一次「要花钱、有副作用（调用量/计费）」的动作，
  // 不是可以随便被预取、被缓存、被 <img src> 触发的安全读取。
  app.post(
    '/api/requests/:id/ai-summary',
    handler(async (req) => {
      const row = getRequestOr404(req.params.id)
      // 与「查看单据详情」用同一条横向越权防线，避免出现「看不到单据却能拿到摘要」的第二条路
      if (!canViewRequest(row, req.ctx)) throw forbidden('无权查看该单据')

      const result = await summarizeRequest({
        type: row.type,
        title: row.title,
        formData: serializeRequest(row).formData,
      })

      // 记审计：谁在什么时候对哪张单据要过摘要、成没成。降级也算一次调用，值得留痕。
      logAction({
        userId: req.userId,
        action: 'request.ai_summary',
        targetType: 'request',
        targetId: row.id,
        detail: { available: result.available, reason: result.reason, points: result.points.length },
      })

      return result
    }),
  )
}
