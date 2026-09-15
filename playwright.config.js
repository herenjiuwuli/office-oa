// ============================================================================
// Playwright E2E 配置（M2：把「审批全链路」接进 CI 做回归）
//
// ⭐ 关键设计：channel: 'chrome'
//    直接用系统已装的 Chrome，**不需要 `npx playwright install` 下载几百 MB Chromium**。
//    GitHub Actions 的 ubuntu-latest 镜像自带 Google Chrome stable，所以 CI 里同样免下载。
//
// 与 scripts/oa-ui-check.mjs 的分工：
//   · oa-ui-check.mjs  零依赖（系统 Chrome + Node 内置 WebSocket 直连 CDP），
//                      离线可跑、不装任何东西，适合本机随手验一遍；
//   · Playwright（这里）有标准的断言/重试/报告/失败留痕，**适合接 CI 做回归**。
//    两者跑的是同一条业务链路，互为交叉验证。
// ============================================================================
import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.E2E_PORT || 3300)
const BASE_URL = `http://127.0.0.1:${PORT}`

// ⚠️ E2E 用**独立数据库**：跑测试不会污染 data/app.db（那是真机验收脚本和开发自用的库）
const E2E_DB = fileURLToPath(new URL('./data/e2e.db', import.meta.url))

export default defineConfig({
  testDir: './e2e',
  // 整条审批链路串起来会跑几十秒，给宽一点
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // E2E 打的是同一个 SQLite 文件，多个 worker 并行写会互相干扰（也会让断言互相打架）
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],

  use: {
    baseURL: BASE_URL,
    channel: 'chrome', // ★ 用系统 Chrome，不下载浏览器
    headless: true,
    viewport: { width: 1440, height: 900 },
    // 失败时留证据：trace 可回放、截图可直看
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  // 自动拉起后端（同一个端口同时托管前端产物，所以只需一个进程）
  webServer: {
    command: 'node index.js',
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { DB_PATH: E2E_DB, PORT: String(PORT) },
  },
})
