// ============================================================================
// K：附件上传（UI 层）
//
// 为什么这条值得单独有一条 UI 用例：
//   接口测试能证明「后端能收能存能鉴权」，但证明不了**前端真的拼得对 multipart**。
//   上传走的是 FormData + 原生 fetch（没走统一的 JSON api()），是这套前端里
//   唯一一处「非 JSON」的请求 —— 正是最容易被接口测试漏掉的地方。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { loginAs, fillField } from './helpers.js'

// 造一个魔数合法的 PNG 夹具（后端按真实字节判类型，随便写几个字节会被 400）
const FIXTURE = path.join(os.tmpdir(), `oa-e2e-attach-${process.pid}.png`)

test.beforeAll(() => {
  fs.writeFileSync(
    FIXTURE,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('e2e-attachment-png-body-0123456789'),
    ]),
  )
})

test.describe('附件上传（UI 层）', () => {
  test('K. 草稿上传附件 → 列表出现 → 删除 → 恢复空态', async ({ page }) => {
    await loginAs(page, 'ops02')

    // 建一张草稿（草稿才允许传附件；提交后锁定）
    await page.goto('/requests/new')
    await page.getByRole('button', { name: '请假申请' }).click()
    await page.locator('[data-t=title]').fill(`E2E 附件单 ${Date.now()}`)
    await fillField(page, 'startDate', '2026-10-08')
    await fillField(page, 'endDate', '2026-10-09')
    await fillField(page, 'reason', 'E2E：附件上传用例')
    await page.getByRole('button', { name: '存为草稿' }).click()

    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/requests\/\d+$/)
    await page.waitForFunction(() => !!document.querySelector('.kv'))

    // 一开始是空态
    await expect(page.locator('body')).toContainText('暂无附件')

    // 上传（走隐藏的 file input；setInputFiles 不要求元素可见）
    await page.locator('[data-t=attach-input]').setInputFiles(FIXTURE)

    // ⚠️ 上传是异步的：必须等列表真的出现该项，不能只等一次渲染
    await page.waitForFunction(() => document.querySelectorAll('[data-t=attach-item]').length > 0)
    const item = page.locator('[data-t=attach-item]').first()
    await expect(item).toContainText('image/png')
    await expect(page.locator('body')).not.toContainText('暂无附件')

    // 删除（带 confirm 弹窗，必须接住它，否则会卡住）
    page.once('dialog', (d) => d.accept())
    await item.getByRole('button', { name: '删除' }).click()
    await page.waitForFunction(() => document.querySelectorAll('[data-t=attach-item]').length === 0)
    await expect(page.locator('body')).toContainText('暂无附件')
  })
})
