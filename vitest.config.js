import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // 在任何测试模块 import 之前把 DB 切成内存库，保证测试完全隔离、不碰真实 data/app.db。
    // 注意：DB_PATH 必须在 server/db.js 的 getDb() 内部「惰性求值」才生效（见该文件注释）。
    setupFiles: ['tests/setup.js'],
    // 每个测试文件跑在自己的环境里 => 各自一份 :memory: 数据库，天然互不干扰
    fileParallelism: true,
  },
})
