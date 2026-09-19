// 批量审批：一次处理多条，每条一个独立事务。
//
// 这个文件盯的不是「能一次批多条」（那显而易见），而是三类单条审批里
// **根本不存在**的问题：
//   ① 部分成功 —— 一批里有的成了、有的没成，返回什么？前端怎么讲清楚？
//   ② id 去重 —— [5,5,5] 不去重就会把同一张单据的状态机推进三次
//   ③ 存在性探测 —— 批量接口很容易变成一个「单号枚举器」
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '../server/db.js'
import { api, createAndSubmit, login, makeApp, U } from './helpers.js'

let app

beforeEach(async () => {
  app = await makeApp()
})

/** 建 n 张「待直属上级审批」的请假单，返回 id 数组（升序） */
async function makePending(n, applicant = U.ops1) {
  const token = await login(app, applicant)
  const ids = []
  for (let i = 0; i < n; i++) {
    const { id } = await createAndSubmit(app, token, { title: `批量单 ${i + 1}` })
    ids.push(id)
  }
  return ids
}

const rowOf = (id) => getDb().prepare('SELECT status, current_step, round FROM requests WHERE id = ?').get(id)
const notifCount = () => getDb().prepare('SELECT COUNT(*) AS c FROM notifications').get().c

/** 批量审批调用 */
async function batch(token, ids, action = 'approve', comment = '') {
  const c = api(app, token)
  return c.post('/api/requests/batch-approve', { ids, action, comment })
}

// ---------------------------------------------------------------------------

describe('批量审批 · 全成功', () => {
  it('3 条全部可批 → 200，且每条都被推进到第 2 步', async () => {
    const ids = await makePending(3)
    const mgr = await login(app, U.opsMgr)

    const res = await batch(mgr, ids)
    expect(res.status).toBe(200)
    expect(res.body.succeeded).toBe(3)
    expect(res.body.failed).toBe(0)
    expect(res.body.total).toBe(3)

    for (const id of ids) {
      expect(rowOf(id).status).toBe('pending')
      expect(rowOf(id).current_step).toBe(2) // leave 第 1 步通过 → 推进到人事复核
    }
  })

  it('批量结果与「逐条单独批」完全一致（状态 + 通知条数都要一致）', async () => {
    // 组 A：批量批 3 条
    const a = await makePending(3)
    const mgr = await login(app, U.opsMgr)
    const before = notifCount()
    await batch(mgr, a)
    const batchDelta = notifCount() - before

    // 组 B：再建 3 条，逐条批
    const b = await makePending(3)
    const before2 = notifCount()
    const one = api(app, mgr)
    for (const id of b) {
      const r = await one.post(`/api/requests/${id}/approve`, { comment: '' })
      expect(r.status).toBe(200)
    }
    const singleDelta = notifCount() - before2

    // 状态一致
    for (let i = 0; i < 3; i++) {
      expect(rowOf(a[i]).status).toBe(rowOf(b[i]).status)
      expect(rowOf(a[i]).current_step).toBe(rowOf(b[i]).current_step)
    }
    // ⭐ 通知条数一致 —— 批量不该多发也不该漏发（漏发就是「状态变了但没人知道」）
    expect(batchDelta).toBe(singleDelta)
  })
})

describe('批量审批 · 部分成功', () => {
  it('3 条里 1 条已归档 → 207，且失败项带着自己的原因', async () => {
    const ids = await makePending(3)
    const mgr = await login(app, U.opsMgr)
    const one = api(app, mgr)

    // 把 #2 一路批到归档（两级都过）
    await one.post(`/api/requests/${ids[1]}/approve`, {})
    const hr = await login(app, U.hr)
    await api(app, hr).post(`/api/requests/${ids[1]}/approve`, {})
    expect(rowOf(ids[1]).status).toBe('approved')

    const res = await batch(mgr, ids)
    expect(res.status).toBe(207)
    expect(res.body.succeeded).toBe(2)
    expect(res.body.failed).toBe(1)

    const bad = res.body.results.find((r) => !r.ok)
    expect(bad.id).toBe(ids[1])
    expect(bad.status).toBe(409)
    expect(bad.code).toBe('conflict')
    expect(bad.message).toContain('approved') // 后端的原话原样带出来，不自己编
  })

  it('★ 部分成功的语义是「能批的先批掉」：失败的那条不影响其它条', async () => {
    const ids = await makePending(3)
    const mgr = await login(app, U.opsMgr)
    // 先归档第 1 条，让它在批量里必然失败
    await api(app, mgr).post(`/api/requests/${ids[0]}/approve`, {})
    await api(app, await login(app, U.hr)).post(`/api/requests/${ids[0]}/approve`, {})

    const res = await batch(mgr, ids)
    expect(res.status).toBe(207)
    // 后面两条**照样被推进了** —— 没有因为第 1 条失败整批回滚
    expect(rowOf(ids[1]).current_step).toBe(2)
    expect(rowOf(ids[2]).current_step).toBe(2)
  })

  it('批量驳回同样支持部分成功', async () => {
    const ids = await makePending(3)
    const mgr = await login(app, U.opsMgr)
    await api(app, mgr).post(`/api/requests/${ids[0]}/approve`, {}) // 让它不再待批

    const res = await batch(mgr, ids, 'reject', '材料不齐')
    expect(res.status).toBe(207)
    expect(res.body.succeeded).toBe(2)
    expect(rowOf(ids[1]).status).toBe('rejected')
    expect(rowOf(ids[2]).status).toBe('rejected')
  })
})

describe('批量审批 · 全失败', () => {
  it('全部不可批 → 400（这一批整体没有被接受）', async () => {
    const ids = await makePending(2)
    const mgr = await login(app, U.opsMgr)
    // 两张都先批掉，让批量时无一条可批
    for (const id of ids) await api(app, mgr).post(`/api/requests/${id}/approve`, {})

    const res = await batch(mgr, ids)
    expect(res.status).toBe(400)
    expect(res.body.succeeded).toBe(0)
    expect(res.body.failed).toBe(2)
    // 单条原因仍然逐条给出
    expect(res.body.results.every((r) => r.ok === false)).toBe(true)
  })
})

describe('★ 批量审批 · id 去重（最容易漏、后果最重）', () => {
  it('[5,5,5] 只处理一次：状态机只推进一格', async () => {
    const [id] = await makePending(1)
    const mgr = await login(app, U.opsMgr)

    const res = await batch(mgr, [id, id, id])
    expect(res.status).toBe(200)
    expect(res.body.requested).toBe(3)
    expect(res.body.total).toBe(1) // 去重后只剩 1 条
    expect(res.body.succeeded).toBe(1)

    // ⭐ 关键断言：只推进了一格。没去重的话第二次会拿到 409，
    //    更糟的是「会签 / 多步」场景下可能被连推两级。
    expect(rowOf(id).current_step).toBe(2)
    expect(rowOf(id).round).toBe(1)
  })

  it('去重不影响正常 id 的处理', async () => {
    const ids = await makePending(2)
    const mgr = await login(app, U.opsMgr)
    const res = await batch(mgr, [ids[0], ids[0], ids[1], ids[1], ids[1]])
    expect(res.body.requested).toBe(5)
    expect(res.body.total).toBe(2)
    expect(res.body.succeeded).toBe(2)
  })
})

describe('★ 批量审批 · 不泄露单据是否存在', () => {
  it('「不存在」与「存在但无权」返回完全一样的 code / status / message', async () => {
    const ids = await makePending(1)
    // exe01 是本部门外的经理：既不是这条单据的申请人，也不是它任何环节的审批人
    const outsider = await login(app, U.exeMgr)

    const res = await batch(outsider, [ids[0], 999999])
    expect(res.status).toBe(400) // 两个都失败

    const [exists, missing] = res.body.results
    expect(exists.ok).toBe(false)
    expect(missing.ok).toBe(false)
    // 除了 id 本身，其它字段必须一模一样 —— 否则挨个试单号就能问出「哪些单据存在」
    expect(exists.code).toBe(missing.code)
    expect(exists.status).toBe(missing.status)
    expect(exists.message).toBe(missing.message)
    expect(exists.code).toBe('not_permitted')
    expect(exists.status).toBe(403)
  })

  it('越权批别人的单据：逐条 403，不因为「批了别人的」而整体 500', async () => {
    const ids = await makePending(1, U.ops2) // ops03 的单据
    const other = await login(app, U.exe1) // 完全无关的人
    const res = await batch(other, ids)
    expect(res.status).toBe(400)
    expect(res.body.results[0].status).toBe(403)
    expect(rowOf(ids[0]).current_step).toBe(1) // 状态没被碰
  })

  it('批量批自己提交的单据 → 逐条 403（防自批在批量下同样生效）', async () => {
    const ids = await makePending(2, U.ops1)
    const self = await login(app, U.ops1)
    const res = await batch(self, ids)
    expect(res.status).toBe(400)
    expect(res.body.results.every((r) => r.status === 403)).toBe(true)
    expect(rowOf(ids[0]).current_step).toBe(1)
  })
})

describe('批量审批 · 参数校验', () => {
  it('ids 不是数组 → 400', async () => {
    const mgr = await login(app, U.opsMgr)
    const res = await batch(mgr, 'not-an-array')
    expect(res.status).toBe(400)
  })

  it('ids 空数组 → 400', async () => {
    const mgr = await login(app, U.opsMgr)
    const res = await batch(mgr, [])
    expect(res.status).toBe(400)
  })

  it.each([['abc'], [1.5], [-1], [0], [null]])('ids 含非正整数 %j → 400', async (bad) => {
    const mgr = await login(app, U.opsMgr)
    const res = await batch(mgr, [bad])
    expect(res.status).toBe(400)
  })

  it('超过上限 50 条 → 400（不是默默截断）', async () => {
    const mgr = await login(app, U.opsMgr)
    const res = await batch(mgr, Array.from({ length: 51 }, (_, i) => i + 1))
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('50')
  })

  it('action 非法 → 400', async () => {
    const mgr = await login(app, U.opsMgr)
    const res = await batch(mgr, [1], 'archive')
    expect(res.status).toBe(400)
  })

  it('comment 超 500 字 → 400', async () => {
    const mgr = await login(app, U.opsMgr)
    const res = await batch(mgr, [1], 'approve', 'x'.repeat(501))
    expect(res.status).toBe(400)
  })
})

describe('批量审批 · 通知与审计', () => {
  it('批量 3 条成功后，审计里留下一条汇总记录', async () => {
    const ids = await makePending(3)
    const mgr = await login(app, U.opsMgr)
    await batch(mgr, ids)

    const log = getDb()
      .prepare(`SELECT * FROM audit_logs WHERE action = 'request.batch_approve' ORDER BY id DESC LIMIT 1`)
      .get()
    expect(log).toBeTruthy()
    const detail = JSON.parse(log.detail)
    expect(detail.succeeded).toBe(3)
    expect(detail.ids).toEqual(ids)
  })

  it('全失败时不写汇总审计（没有成功的操作可记）', async () => {
    const ids = await makePending(1)
    const outsider = await login(app, U.exeMgr)
    await batch(outsider, ids)
    const n = getDb().prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'request.batch_approve'`).get().c
    expect(n).toBe(0)
  })
})

describe('批量审批 · 幂等（同一批被提交两次）', () => {
  it('并发提交同一批 → 每个 id 只被成功处理一次，不会重复推进', async () => {
    const ids = await makePending(3)
    const mgr = await login(app, U.opsMgr)

    const [r1, r2] = await Promise.all([batch(mgr, ids), batch(mgr, ids)])

    const okIds = [...r1.body.results, ...r2.body.results].filter((r) => r.ok).map((r) => r.id)
    // 每个 id 恰好成功一次
    expect(okIds.sort()).toEqual([...ids].sort())
    for (const id of ids) expect(rowOf(id).current_step).toBe(2) // 只推进一格
  })
})
