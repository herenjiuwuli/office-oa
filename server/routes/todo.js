// 我的待办
import { handler } from '../errors.js'
import { listTodo } from '../flow/engine.js'

export default async function todoRoutes(app) {
  app.get(
    '/api/todo',
    handler(async (req) => {
      const items = listTodo(req.ctx.user.id).map((t) => {
        let formData = {}
        try {
          formData = JSON.parse(t.form_data)
        } catch {
          formData = {}
        }
        return {
          taskId: t.task_id,
          requestId: t.request_id,
          stepNo: t.step_no,
          round: t.round,
          type: t.type,
          title: t.title,
          status: t.status,
          currentStep: t.current_step,
          applicantName: t.applicant_name,
          assignedAt: t.assigned_at,
          formData,
        }
      })
      return { items, total: items.length }
    }),
  )
}
