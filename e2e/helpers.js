// E2E 公共操作。抽出来的原因：登录/登出/等页面就绪在每条用例里都要用，
// 各写一遍的话「就绪条件」迟早写歪（写歪的后果 = 随机假失败，见下面 goTodo 的注释）。
import { expect } from '@playwright/test'

/** 等 URL 的 pathname 变成指定值（比 toHaveURL 更稳：不依赖端口、能等路由跳转） */
export async function expectPath(page, path) {
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe(path)
}

/** 用「演示账号快捷填充」登录——刻意走和真人一样的路径，不塞 localStorage 抄近道 */
export async function loginAs(page, username) {
  await page.goto('/login')
  await page.locator('.demo-btns button').filter({ hasText: `${username} ·` }).click()
  await expect(page.locator('[data-t=username]')).toHaveValue(username)
  await page.locator('button[type=submit]').click()
  await expectPath(page, '/')
  await expect(page.locator('.sidebar')).toBeVisible()
}

export async function logout(page) {
  await page.getByRole('button', { name: '退出登录' }).click()
  await expectPath(page, '/login')
}

/**
 * 进「我的待办」并等**数据真的到位**。
 *
 * ⚠️ 别只 `goto` 就断言：SPA 的框架渲染完 ≠ 异步 fetch 的数据回来了，
 *    侧边栏的字数就够骗过「页面有内容」这种粗判据。不等数据到位，断言会随机器快慢随机假失败。
 *    空态（没有待你审批）也算「到位」，否则永远不会满足。
 */
export async function goTodo(page) {
  await page.goto('/todo')
  await page.waitForFunction(
    () =>
      document.querySelectorAll('table.tbl tbody tr').length > 0 ||
      document.body.innerText.includes('没有待你审批'),
  )
}

/** 进单据详情并等详情渲染完成（`.kv` 只在加载成功时存在；403/404 走错误卡片） */
export async function goDetail(page, id) {
  await page.goto(`/requests/${id}`)
  await page.waitForFunction(
    () =>
      !!document.querySelector('.kv') ||
      document.body.innerText.includes('403') ||
      document.body.innerText.includes('404'),
  )
}

/**
 * 在指定行里点按钮。
 * ⚠️ 列表里每个单据都有一个叫「处理」的按钮，**不能全局点第一个** ——
 *    那样点到的是别的单据，脚本还「看起来通过」。必须先用行内唯一特征（如 #12）定位到行。
 */
export async function clickRowAction(page, rowText, btnText) {
  await page
    .locator('table.tbl tbody tr')
    .filter({ hasText: rowText })
    .first()
    .getByRole('button', { name: btnText })
    .click()
}

/** 填表单字段（走 data-field 钩子，字段清单本身来自后端 /api/request-types） */
export async function fillField(page, field, value) {
  await page.locator(`[data-field=${field}]`).fill(value)
}

/** 数页面上还剩几个「可执行操作」按钮（归档后应为 0） */
export async function countActionButtons(page) {
  return page.locator('button').evaluateAll(
    (els) =>
      els
        .map((e) => (e.textContent || '').trim())
        .filter((t) => ['同意', '驳回', '提交审批', '撤回'].some((k) => t.includes(k))).length,
  )
}
