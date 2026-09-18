// 导出 CSV（M4）：把「数据」安全地变成「文件」的四个考点
//   ① RFC4180 转义（逗号 / 引号 / 换行）—— 错了不是「显示难看」，是**行结构整体错位**
//   ② ⭐ 公式注入 —— 错了是「审批人用 Excel 打开，执行了别人写在标题里的代码」
//   ③ 可见性 —— 导出必须与列表共用同一套规则，否则是**沉默的**越权（不报错、没人发现）
//   ④ 响应头 —— 平台以前断言不了响应头，这一轮顺手给它补上了（api-test-platform M14）
//
// ⚠️ 条数断言一律**从列表接口动态取**（`/api/requests`），不写死：
//    种子数据里每个员工本来就有一条自己的草稿，写死「表头 + 2 行」会随种子变化假失败。
//    —— 这条正是上一轮写进 skill 的教训，这轮自己先撞了一次。
import { describe, expect, it } from 'vitest'
import { CSV_BOM, csvCell, csvFilename, toCsv } from '../server/lib/csv.js'
import { api, createAndSubmit, login, makeApp, LEAVE_FORM, MATERIAL_FORM, U } from './helpers.js'

const HEADER = '单据号,类型,标题,申请人,状态,轮次,金额,创建时间'

/** 直接看原始响应（CSV 不是 JSON：helpers.api() 那层会把 body parse 掉，也看不到 headers） */
async function rawGet(app, token, url, query) {
  const res = await app.inject({
    method: 'GET',
    url,
    query,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { status: res.statusCode, headers: res.headers, text: res.rawPayload.toString('utf8') }
}

/** 去掉 BOM 后按 CRLF 切行（空行丢掉） */
const linesOf = (text) => text.replace(CSV_BOM, '').split('\r\n').filter(Boolean)

// ---------------------------------------------------------------------------
// 单元：csvCell / toCsv —— 规则本身对不对
// ---------------------------------------------------------------------------
describe('csv.js 单元：转义与防注入', () => {
  it('普通文本原样输出（不加多余的引号）；null/undefined 视作空串', () => {
    expect(csvCell('正常标题')).toBe('正常标题')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
    expect(csvCell(0)).toBe('0')
  })

  it('含逗号 → 整个字段用双引号包起来（否则列会整体右移）', () => {
    expect(csvCell('买椅子,共6把')).toBe('"买椅子,共6把"')
  })

  it('含双引号 → 字段包引号 + 内部引号翻倍', () => {
    expect(csvCell('他说"好"')).toBe('"他说""好"""')
  })

  it('含换行 → 字段包引号（换行是合法字段内容，但不该被拆成两行记录）', () => {
    expect(csvCell('第一行\n第二行')).toBe('"第一行\n第二行"')
    expect(csvCell('回车\r\n换行')).toBe('"回车\r\n换行"')
  })

  it('⭐ 以 = 开头 → 加单引号前缀（Excel 会把它当公式执行）', () => {
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1")
    // 注意这会**同时**触发两条规则：先加前缀，再因为含逗号/引号而整体包引号 + 内部引号翻倍
    expect(csvCell('=HYPERLINK("http://evil","点我")')).toBe('"\'=HYPERLINK(""http://evil"",""点我"")"')
  })

  it('⭐ 以 @ / + / - 开头且不是数字 → 同样加前缀（DDE 与公式）', () => {
    expect(csvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)")
    expect(csvCell('+1+1')).toBe("'+1+1")
    expect(csvCell('-1+1')).toBe("'-1+1")
    expect(csvCell('\t=1+1')).toBe("'\t=1+1") // tab 是绕过「只看 =」的经典手法
  })

  it('⭐ 合法数字不误伤：-5 / +3.5 / 1e3 原样输出', () => {
    // 取舍：若一律按首字符判定，`-5` 会被写成 `'-5`（Excel 里显示正常，
    // 但下游按字节解析会多出一个前缀）。所以只对「看起来像公式」的才加前缀。
    expect(csvCell('-5')).toBe('-5')
    expect(csvCell('+3.5')).toBe('+3.5')
    expect(csvCell('1e3')).toBe('1e3')
    expect(csvCell('-5.5e3')).toBe('-5.5e3')
  })

  it('先加前缀、再做引号包裹（顺序反了前缀会落到引号外面）', () => {
    expect(csvCell('=1,2')).toBe('"\'=1,2"')
  })

  it('toCsv：带 BOM + CRLF 分隔 + 末尾有换行；空数组只给 BOM', () => {
    expect(toCsv([['a', 'b'], [1, 2]])).toBe(`${CSV_BOM}a,b\r\n1,2\r\n`)
    expect(toCsv([])).toBe(CSV_BOM)
  })

  it('csvFilename：ASCII 名字 + 稳定的时间戳格式', () => {
    const name = csvFilename('requests', new Date(2026, 8, 17, 9, 5, 3))
    expect(name).toBe('requests-20260917-090503.csv')
    // 全 ASCII：Content-Disposition 里放中文要走 filename*=UTF-8''… 的编码，各浏览器行为参差
    expect(/^[\x20-\x7e]+$/.test(name)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 接口：GET /api/requests/export.csv
// ---------------------------------------------------------------------------
describe('GET /api/requests/export.csv', () => {
  it('未登录 → 401', async () => {
    const app = await makeApp()
    expect((await rawGet(app, null, '/api/requests/export.csv')).status).toBe(401)
  })

  it('响应头：text/csv; charset=utf-8 + attachment 下载（文件名纯 ASCII）+ X-Total-Count', async () => {
    const app = await makeApp()
    const t = await login(app, U.ops1)
    const res = await rawGet(app, t, '/api/requests/export.csv')
    const listed = await api(app, t).get('/api/requests')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="requests-\d{8}-\d{6}\.csv"$/)
    // 条数用头传：前端提示「已导出 N 条」就不用去数 CSV 的行（含换行的字段会把行数数错）
    expect(Number(res.headers['x-total-count'])).toBe(listed.body.total)
  })

  it('内容：开头是 UTF-8 BOM（否则 Excel 打开中文乱码）', async () => {
    const app = await makeApp()
    const t = await login(app, U.ops1)
    const res = await rawGet(app, t, '/api/requests/export.csv')
    expect(res.text.charCodeAt(0)).toBe(0xfeff)
  })

  it('内容：首行是表头；条数 = 列表接口条数；类型/金额取自服务端数据', async () => {
    const app = await makeApp()
    const t = await login(app, U.ops1)
    await createAndSubmit(app, t, { title: '导出测试单 A' })
    await createAndSubmit(app, t, { title: '导出测试单 B', type: 'material', formData: MATERIAL_FORM })

    const listed = await api(app, t).get('/api/requests')
    const res = await rawGet(app, t, '/api/requests/export.csv')
    const lines = linesOf(res.text)

    expect(lines[0]).toBe(HEADER)
    expect(lines.length).toBe(1 + listed.body.total) // 表头 + 列表里所有的（含种子）
    expect(res.text).toContain('导出测试单 A')
    expect(res.text).toContain('活动物料审批') // 类型用服务端 REQUEST_TYPES 的中文名
    expect(res.text).toContain('880') // 金额取自 form_data
  })

  it('⭐ 越权：普通员工导出**只含自己的**单据', async () => {
    const app = await makeApp()
    const t1 = await login(app, U.ops1)
    const t2 = await login(app, U.ops2)
    await createAndSubmit(app, t1, { title: 'ops1 的私密单据' })

    const res = await rawGet(app, t2, '/api/requests/export.csv')
    const mine = await api(app, t2).get('/api/requests')
    expect(res.status).toBe(200)
    expect(res.text).not.toContain('ops1 的私密单据')
    expect(linesOf(res.text).length).toBe(1 + mine.body.total) // 全部是 t2 自己的
    expect(res.text).toContain('孙小') // 申请人列只会有自己（U.ops2）
    expect(res.text).not.toContain('赵西') // 另一位员工（U.ops1）的名字不该出现
  })

  it('有 request:read:all 的角色（admin）能导出全部', async () => {
    const app = await makeApp()
    await createAndSubmit(app, await login(app, U.ops1), { title: 'ops1 的单据' })
    const all = await api(app, await login(app, U.admin)).get('/api/requests')

    const res = await rawGet(app, await login(app, U.admin), '/api/requests/export.csv')
    expect(all.body.scope).toBe('all')
    expect(res.text).toContain('ops1 的单据')
    expect(linesOf(res.text).length).toBe(1 + all.body.total)
    expect(linesOf(res.text).length).toBeGreaterThan(2)
  })

  it('?mine=1：即使有全量权限也能自愿缩回「只看自己」', async () => {
    const app = await makeApp()
    const ta = await login(app, U.admin)
    await createAndSubmit(app, await login(app, U.ops1), { title: 'ops1 的单据' })

    const res = await rawGet(app, ta, '/api/requests/export.csv', { mine: '1' })
    const mine = await api(app, ta).get('/api/requests', { mine: '1' })
    expect(res.text).not.toContain('ops1 的单据')
    expect(linesOf(res.text).length).toBe(1 + mine.body.total)
  })

  it('筛选条件生效，且导出行数恒等于列表条数（导出不能比列表多给数据）', async () => {
    const app = await makeApp()
    const t = await login(app, U.ops1)
    const client = api(app, t)
    await createAndSubmit(app, t, { title: '已提交的单' })
    await client.post('/api/requests', { type: 'leave', title: '还是草稿的单', formData: LEAVE_FORM })

    const listed = await client.get('/api/requests', { status: 'draft' })
    const exported = await rawGet(app, t, '/api/requests/export.csv', { status: 'draft' })

    expect(listed.body.total).toBeGreaterThanOrEqual(1)
    expect(linesOf(exported.text).length - 1).toBe(listed.body.total)
    expect(exported.text).toContain('还是草稿的单')
    expect(exported.text).not.toContain('已提交的单')
  })

  it('⭐⭐ 公式注入端到端：标题里写载荷，导出后那一格必须带前缀（否则 Excel 一开就执行）', async () => {
    const app = await makeApp()
    const t = await login(app, U.ops1)
    const payload = "=cmd|'/c calc'!A1"
    await createAndSubmit(app, t, { title: payload })

    const res = await rawGet(app, t, '/api/requests/export.csv')
    expect(res.text).toContain(`'${payload}`) // 带前缀 = 被当文本
    // 反证：裸公式的形态是「逗号后**直接**跟 =」。带前缀的 `,'=cmd` 是安全形态，不算命中。
    expect(res.text).not.toContain(',=cmd')
  })

  it('导出是「把数据带走」的动作 → 必须留下审计日志，且写得清范围', async () => {
    const app = await makeApp()
    const t = await login(app, U.ops1)
    await createAndSubmit(app, t, { title: '留痕测试单' })
    await rawGet(app, t, '/api/requests/export.csv')

    const logs = await api(app, await login(app, U.admin)).get('/api/audit-logs', { limit: 50 })
    const exportLogs = logs.body.items.filter((l) => l.action === 'request.export')
    expect(exportLogs.length).toBe(1)
    expect(exportLogs[0].detail).toContain('仅本人') // 「全量导出」和「只看自己」在日志里要分得清
    expect(exportLogs[0].userId).toBe(4) // ops1
  })
})
