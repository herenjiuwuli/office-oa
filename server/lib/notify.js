// ============================================================================
// 站内通知（M3）
//
// 两条前提，决定了这里所有函数的形状：
//
// ① **通知是「事件发生时写下的那句话」，不是「指向单据的一个视图」。**
//    所以正文里的轮次用 round 列**存下来**，而不是读的时候 join requests 现查 ——
//    否则「第 1 轮被驳回」这条通知，会在申请人重提到第 2 轮之后自己改口。
//    （和 requests.flow_snapshot、平台 runs 的环境快照是同一条教训的第三次出现：
//     **任何会变的值，一旦要写进历史记录，就必须在当时抄一份。**）
//
// ② **写通知必须跟状态变更在同一个事务里。**
//    审批已经 COMMIT、通知才补写失败的话，用户永远不知道自己被驳回了 ——
//    这类「主操作成功、副作用静默丢失」的 bug 不会报错，只会让人少收到东西。
//    因此本文件的函数**只管往当前连接里 INSERT**，事务边界由调用方（flow/engine.js）掌握。
//
// ③ 一条通用规矩：**不给自己发通知**（审批人恰好是申请人这类配置错误不该变成自己的骚扰）。
// ============================================================================
import { REQUEST_TYPES } from '../flow/validators.js'

const typeName = (t) => REQUEST_TYPES[t]?.name || t

/** 往「当前事务」里插一行。userId 为空则跳过（配置缺人时不该整单失败）。 */
export function pushNotification(db, { userId, type, title, body = '', requestId = null, round = 1 }) {
  if (!userId) return
  db.prepare(
    `INSERT INTO notifications (user_id, type, title, body, request_id, round)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(Number(userId), type, title, body, Number(requestId) || null, Number(round) || 1)
}

/** 通知「有新任务等你审批」—— 提交时发给第一级，推进到下一步时发给下一级 */
export function notifyTaskAssigned(db, { request, stepName, round, approverIds = [] }) {
  for (const uid of approverIds) {
    if (Number(uid) === Number(request.applicant_id)) continue
    pushNotification(db, {
      userId: uid,
      type: 'task',
      title: `待你审批：${request.title}`,
      body: `${request.applicant_name || '申请人'} 提交的${typeName(request.type)}（第 ${round} 轮），当前环节「${stepName}」。`,
      requestId: request.id,
      round,
    })
  }
}

/** 通知申请人「审批结果」—— 归档通过 / 被驳回 */
export function notifyResult(db, { request, round, ok, stepName, comment = '', actorName = '' }) {
  const who = actorName ? `${actorName} ` : ''
  const reason = comment ? `，意见：${comment}` : ''
  pushNotification(db, {
    userId: request.applicant_id,
    type: ok ? 'approved' : 'rejected',
    title: `${ok ? '已通过' : '被驳回'}：${request.title}`,
    body: `${who}在「${stepName}」环节${ok ? '通过' : '驳回'}了你的${typeName(request.type)}（第 ${round} 轮）${reason}。`,
    requestId: request.id,
    round,
  })
}

/** 通知「单据已被撤回」—— approverIds 传「还有待审任务的人」（已处理完的不必知道） */
export function notifyCancelled(db, { request, round, approverIds = [], applicantName = '' }) {
  for (const uid of approverIds) {
    if (Number(uid) === Number(request.applicant_id)) continue
    pushNotification(db, {
      userId: uid,
      type: 'cancelled',
      title: `已撤回：${request.title}`,
      body: `${applicantName || '申请人'} 撤回了这条${typeName(request.type)}（第 ${round} 轮），你无需再处理。`,
      requestId: request.id,
      round,
    })
  }
}
