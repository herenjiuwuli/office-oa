// ============================================================================
// A/B/C：未登录守卫 · 登录页布局 · RBAC 菜单 · 纵向越权
//
// 这一组是「权限」的正面与反面：
//   正面 = 菜单按权限隐藏（UX）
//   反面 = 直接敲 URL，后端仍然拒绝（安全）
// 前端**刻意不拦**越权路由，就是为了让反面这件事在界面上看得见、能被断言。
// ============================================================================
import { test, expect } from '@playwright/test'
import { loginAs, expectPath } from './helpers.js'

test.describe('未登录守卫 & 登录页', () => {
  test('未登录访问 / → 重定向到 /login，且登录页不套 App 外壳', async ({ page }) => {
    await page.goto('/')
    await expectPath(page, '/login')

    await expect(page.locator('.demo-btns button')).toHaveCount(8)

    // ★ 这条是补的：曾经 App.vue 无条件套 App 外壳，登录页左边多出一条侧边栏，
    //   而当时 84 条接口用例 + 静态扫描全绿 —— 因为断言只看了 pathname 和按钮，**没看布局**。
    //   断言写太窄等于没测。
    await expect(page.locator('.sidebar')).toHaveCount(0)

    // 登录页应占满整屏（没被外壳的内容区 padding 挤窄）
    const wrapW = await page.locator('.login-wrap').evaluate((el) => el.getBoundingClientRect().width)
    const innerW = await page.evaluate(() => window.innerWidth)
    expect(Math.abs(wrapW - innerW)).toBeLessThan(2)
  })
})

test.describe('RBAC 菜单 & 纵向越权', () => {
  test('普通员工：菜单按权限隐藏，但直接敲 URL 会看到后端真实 403', async ({ page }) => {
    await loginAs(page, 'ops02')

    const sidebar = page.locator('.sidebar')
    await expect(sidebar).toContainText('赵西')
    await expect(sidebar).toContainText('employee')

    // 有 dept:read → 看得到；缺 user:read / audit:read → 看不到
    await expect(sidebar).toContainText('部门架构')
    await expect(sidebar).not.toContainText('员工管理')
    await expect(sidebar).not.toContainText('审计日志')

    // ★ 纵向越权：不信前端，直接把 /users 敲进地址栏。
    //   前端**故意不拦**（守卫只管登录），所以页面会显示后端真实返回的 403 + 缺哪个权限码。
    //   这个设计让「越权」这件事看得见、可验证，而不是被前端伪装成「页面不存在」。
    await page.goto('/users')
    await expect(page.locator('body')).toContainText('403')
    await expect(page.locator('body')).toContainText('user:read')
  })
})
