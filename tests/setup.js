// 测试前置：必须在任何业务模块 import 之前执行（vitest setupFiles 保证这一点）
// 强制内存库，杜绝测试把数据写进真实 data/app.db
process.env.DB_PATH = ':memory:'
// 固定测试密钥，避免受本地环境变量影响
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod'
