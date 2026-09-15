// ============================================================================
// D~I：审批全链路 + 驳回重提 + 归档语义 + 移动端 + 登出
//
// 串行执行：每一步都建立在上一步的状态上（单据 id 逐段传递），中途失败后面的没有意义。
//   D 员工建单并提交 → E 直属上级同意 → F 人事复核归档
//   G 归档单据的文案语义（★ 曾经写错的那条）
//   H 驳回不填理由被拦 → 驳回 → 重提（轮次保留）
//   I 移动端 390px / 登出
// ============================================================================
import { test, expect } from '@playwright/test'
import {
  loginAs,
  logout,
  goTodo,
  goDetail,
  clickRowAction,
  fillField,
  countActionButtons,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

test.describe('审批全链路', () => {
  let reqId = null // 单据 A：走完审批并归档
  let reqId2 = null // 单据 B：被驳回后重提

  test('D. 员工（赵西）建单并提交 → 详情页「审批中」+ 流程快照固化', async ({ page }) => {
    await loginAs(page, 'ops02')
    const title = `E2E 验收单 ${Date.now()}`

    await page.goto('/requests/new')
    await page.getByRole('button', { name: '请假申请' }).click()
    await page.locator('[data-t=title]').fill(title)
    await fillField(page, 'startDate', '2026-10-08')
    await fillField(page, 'endDate', '2026-10-09')
    await fillField(page, 'reason', 'E2E：家中有事需要请假')
    await page.getByRole('button', { name: '保存并提交' }).click()

    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/requests\/\d+$/)
    reqId = new URL(page.url()).pathname.split('/').pop()
    expect(reqId).toMatch(/^\d+$/)

    // 详情是异步拉的，等它渲染出来再断言（否则随机假失败）
    await page.waitForFunction(() => !!document.querySelector('.kv'))
    const body = page.locator('body')
    await expect(body).toContainText('审批中')
    await expect(body).toContainText('直属上级审批')
    await expect(body).toContainText('等待审批')
    // 流程快照：提交那一刻的步骤被固化进单据（第 1、2 步都在）
    await expect(body).toContainText('第1步')
    await expect(body).toContainText('第2步')
  })

  test('E. 一级审批：直属上级（王东）同意 → 推进到第 2 步', async ({ page }) => {
    await loginAs(page, 'ops01')
    await goTodo(page)
    await expect(page.locator('body')).toContainText(`#${reqId}`)

    await clickRowAction(page, `#${reqId}`, '处理')
    const drawer = page.locator('.drawer')
    await expect(drawer).toBeVisible()
    // 抽屉里应直接带出申请人 + 事由，审批人不用先去详情页翻
    await expect(drawer).toContainText('赵西')
    await expect(drawer).toContainText('家中有事')

    await page.locator('[data-t=comment]').fill('同意，注意工作交接')
    await page.locator('.drawer-foot').getByRole('button', { name: '同意' }).click()
    await expect(page.locator('.drawer')).toHaveCount(0)

    await goDetail(page, reqId)
    const body = page.locator('body')
    await expect(body).toContainText('审批中') // 一级通过 ≠ 结束，还要走第 2 步
    await expect(body).toContainText('已通过') // 第 1 步已通过
    await expect(body).toContainText('人事复核') // 第 2 步待审
    await expect(body).toContainText('同意，注意工作交接') // 审批意见进时间线
  })

  test('F. 二级审批：人事（李南）同意 → 归档「已通过」且无可执行操作', async ({ page }) => {
    await loginAs(page, 'hr01')
    await goTodo(page)
    await expect(page.locator('body')).toContainText(`#${reqId}`)
    await clickRowAction(page, `#${reqId}`, '处理')
    await expect(page.locator('.drawer')).toBeVisible()
    await page.locator('[data-t=comment]').fill('已核对，批准')
    await page.locator('.drawer-foot').getByRole('button', { name: '同意' }).click()
    await expect(page.locator('.drawer')).toHaveCount(0)

    await goDetail(page, reqId)
    const body = page.locator('body')
    await expect(body).toContainText('已通过')
    // ★★ 全链路归档：归档后页面上不该再有任何可执行操作按钮
    expect(await countActionButtons(page)).toBe(0)
  })

  test('G. ★ 归档单据给「已审过的审批人」看：显示「单据已结束」，不是「还没轮到你」', async ({ page }) => {
    // 王东（ops01）是这张单据第 1 步的审批人，单据已被 hr01 归档。
    // 曾经这里的分支顺序写反了 → 单据都结束了还提示「但当前还没轮到你」，会让人以为还要继续等。
    await loginAs(page, 'ops01')
    await goDetail(page, reqId)
    const body = page.locator('body')
    await expect(body).toContainText('单据已结束')
    await expect(body).not.toContainText('还没轮到你')
  })

  test('H. 驳回不填理由被前端拦下 → 驳回 → 改后重提（轮次保留）', async ({ page }) => {
    // --- 再建一张，这次走驳回 ---
    await loginAs(page, 'ops02')
    await page.goto('/requests/new')
    await page.getByRole('button', { name: '请假申请' }).click()
    await page.locator('[data-t=title]').fill(`E2E 驳回验收单 ${Date.now()}`)
    await fillField(page, 'startDate', '2026-11-02')
    await fillField(page, 'endDate', '2026-11-03')
    await fillField(page, 'reason', 'E2E：需要连休两天')
    await page.getByRole('button', { name: '保存并提交' }).click()
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/requests\/\d+$/)
    reqId2 = new URL(page.url()).pathname.split('/').pop()

    // --- 上级驳回：先故意不写理由 ---
    await logout(page)
    await loginAs(page, 'ops01')
    await goTodo(page)
    await clickRowAction(page, `#${reqId2}`, '处理')
    await expect(page.locator('.drawer')).toBeVisible()
    await page.locator('.drawer-foot').getByRole('button', { name: '驳回' }).click()
    await expect(page.locator('.drawer')).toContainText('驳回必须填写理由')

    await page.locator('[data-t=comment]').fill('材料不齐，补充交接安排后重提')
    await page.locator('.drawer-foot').getByRole('button', { name: '驳回' }).click()
    await expect(page.locator('.drawer')).toHaveCount(0)

    await goDetail(page, reqId2)
    await expect(page.locator('body')).toContainText('已驳回')
    await expect(page.locator('body')).toContainText('材料不齐')

    // --- 申请人改后重提：round 应变成第 2 轮，且上一轮痕迹保留 ---
    await logout(page)
    await loginAs(page, 'ops02')
    await goDetail(page, reqId2)
    await expect(page.locator('body')).toContainText('修改后重新提交')
    await page.getByRole('button', { name: /修改后重新提交/ }).click()

    // ⚠️ 判据不能用「第 2 轮」这种字符串：提交按钮的文案本身就写着「修改后重新提交（第 2 轮）」，
    //    一上来就命中提交前的状态，断言会**假通过**。
    //    改用「时间线上出现 2 个轮次分隔符」——只有重提真的生成了 round=2 的任务才会出现。
    await expect(page.locator('.round-sep')).toHaveCount(2)
    const seps = await page.locator('.round-sep').allInnerTexts()
    expect(seps[1]).toContain('第 2 轮')
    const body = page.locator('body')
    await expect(body).toContainText('审批中')
    // ★ 上一轮的驳回痕迹必须还在（否则「谁因为什么驳回」就被覆盖没了）
    expect(seps[0]).toContain('第 1 轮')
    await expect(body).toContainText('材料不齐')
  })

  test('I. 移动端 390px 无横向溢出（真改视口，不靠截图）', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loginAs(page, 'ops02')
    await goDetail(page, reqId2)
    const m = await page.evaluate(() => {
      const de = document.documentElement
      return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth }
    })
    expect(
      m.scrollWidth,
      `scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth}`,
    ).toBeLessThanOrEqual(m.clientWidth + 1)
  })

  test('J. 退出登录 → 回到登录页且本地 token 已清除', async ({ page }) => {
    await loginAs(page, 'ops02')
    expect(await page.evaluate(() => localStorage.getItem('oa.token') !== null)).toBe(true)
    await logout(page)
    expect(await page.evaluate(() => localStorage.getItem('oa.token'))).toBeNull()
  })
})
