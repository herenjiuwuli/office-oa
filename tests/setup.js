// 测试前置：必须在任何业务模块 import 之前执行（vitest setupFiles 保证这一点）
// 强制内存库，杜绝测试把数据写进真实 data/app.db
process.env.DB_PATH = ':memory:'
// 固定测试密钥，避免受本地环境变量影响
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod'
// AI 摘要是唯一会「真花钱、不稳定」的外部依赖：
// 这里显式清掉真实 key，强制 tests/ai.test.js 自己 mock fetch。
// 否则在一台真配了 key 的机器上跑测试，会真的打到 DeepSeek（花钱 + 结果不可预期）。
delete process.env.DEEPSEEK_API_KEY
