// AI 审批摘要的 E2E —— 只覆盖【降级 / 未启用】这条路径。
//
// 为什么 E2E 不做「真调用」：
//   · 成本：每跑一次 CI 就真花一次钱
//   · 稳定性：外部服务的延迟/限流会让 CI 随机变红，红了你也不知道是谁的锅
//   · 可断言性：模型输出每次都不一样，写不出稳定断言（难道断言「摘要里有 880 元」？）
// 所以分工是：
//   · tests/ai.test.js  —— mock fetch，覆盖成功 / 超时 / 5xx / 垃圾返回 / 注入防护（快、确定）
//   · 本文件           —— 只保证「未启用时界面不崩、按钮置灰、原因说清楚、且不泄漏无权单据」
// playwright.config.js 里已把 DEEPSEEK_API_KEY 显式置空，因此这里的结果是确定的。
import { expect, test } from '@playwright/test'
import { goDetail, loginAs } from './helpers.js'

const aiCard = (page) => page.locator('.card').filter({ hasText: 'AI 审批摘要' })

test.describe('AI 审批摘要 · 未启用时的降级路径', () => {
  test('单据详情有 AI 卡片：按钮置灰、写明未启用、并声明仅供参考', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    await loginAs(page, 'ops02') // 单据 1 的申请人
    await goDetail(page, 1)

    const card = aiCard(page)
    await expect(card).toBeVisible()
    await expect(card).toContainText('仅供参考')
    await expect(card.getByRole('button', { name: '生成摘要' })).toBeDisabled()
    await expect(card).toContainText('未启用')
    // 说清楚「不影响审批」，避免用户以为系统坏了
    await expect(card).toContainText('未配置')

    expect(pageErrors, 'AI 卡片不应引入任何未捕获异常').toEqual([])
  })

  test('已归档的单据也能看到 AI 卡片（它是只读能力，不受单据状态限制）', async ({ page }) => {
    await loginAs(page, 'ops01') // 王东：单据 3 第 1 步的审批人
    await goDetail(page, 3)

    await expect(aiCard(page)).toBeVisible()
    await expect(aiCard(page).getByRole('button', { name: '生成摘要' })).toBeDisabled()
    // 与「单据已结束」的提示并存，不互相顶掉
    await expect(page.getByText('单据已结束')).toBeVisible()
  })

  test('无权查看的单据不渲染 AI 卡片（越权时不该多出一条新的信息泄漏口）', async ({ page }) => {
    await loginAs(page, 'ops02') // 与单据 2 无关：不是申请人也不是审批人
    await goDetail(page, 2)

    await expect(page.getByText('无权查看该单据')).toBeVisible()
    await expect(aiCard(page)).toHaveCount(0)
  })
})
