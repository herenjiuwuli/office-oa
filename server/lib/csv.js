// CSV 生成（M4 导出）：自写，不引库 —— 和项目其他部分一致，且规则小到能完整测住。
//
// 三个真实的坑，每个都值得讲（这也是「导出」这个功能真正的难点，不是拼字符串）：
//
//   ① RFC4180 转义：字段里出现 逗号 / 双引号 / 换行 时，必须用双引号把整个字段包起来，
//      字段内部的双引号再翻倍（"" 表示一个字面量引号）。否则「标题里带个逗号」就能把
//      后面所有列整体右移一位 —— 打开看着是数据错了，实际是**行结构错了**。
//
//   ② ⭐ CSV 公式注入（CSV Injection / Formula Injection）：
//      单元格内容以 = + - @ 开头时，Excel / WPS / Numbers 打开会**当公式执行**。
//      典型 payload：`=cmd|'/c calc'!A1`（点开就弹计算器）、`=HYPERLINK("http://evil","点我")`、
//      `@SUM(...)`（DDE）。攻击面是「我在 OA 里提了一条标题叫 `=cmd|...` 的请假单，
//      审批人导出 CSV 用 Excel 打开 → 在**他的机器上**执行了」。
//      这是 OA / 报表类系统里非常典型的一条：**导出把「数据」变成了「代码」**。
//      防法：在字段前加一个单引号 —— Excel 会把整格当文本（且**不显示**这个引号）。
//
//   ③ Excel 打开中文乱码：Excel 默认按系统本地编码解释 .csv，读 UTF-8 中文会花屏。
//      加 UTF-8 BOM（\ufeff）能让它正确识别编码。代价是「用代码读这个文件时」会多出
//      一个不可见字符（下游解析器需要剥掉）—— 这个代价我们认，因为人打开 Excel 是主场景。
//
// 明确不做：分隔符可选（分号/制表符）、引号可选、编码可选。
// 「导出」这件事只要**一个**确定的格式，选项一多，测的就不是导出而是配置了。

/** 一个字段会被 Excel 当公式的起始字符。tab / CR 也在内 —— 它们是绕过「只看 =」的经典手法。 */
const FORMULA_START = /^[=+\-@\t\r]/
/** 「就是一个普通数字」的字段：负数/正数/小数/科学计数法。它们不该被加前缀（否则下游解析器要多剥一层） */
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/

/**
 * 把一个值转成「安全的 CSV 字段」。
 * @param {*} value 任意值（null / undefined 视为空串）
 * @returns {string}
 */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value)

  // ⭐ 先防公式注入，再做 RFC4180 转义 —— 顺序不能反：
  //    先加前缀再判断是否要包引号，引号才会包住「前缀 + 内容」这一整块。
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) {
    s = `'${s}`
  }

  if (/[",\r\n]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** UTF-8 BOM：让 Excel 正确识别编码（代价：下游按字节读会多一个不可见字符） */
export const CSV_BOM = '\ufeff'

/**
 * 把二维数组拼成 CSV 文本。
 * @param {Array<Array<*>>} rows 第一行通常是表头
 * @param {{bom?: boolean, eol?: string}} opts
 * @returns {string}
 */
export function toCsv(rows, { bom = true, eol = '\r\n' } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return bom ? CSV_BOM : ''
  const body = rows.map((r) => (Array.isArray(r) ? r : [r]).map(csvCell).join(',')).join(eol)
  // 结尾补一个换行：RFC4180 要求最后一行也有行结束符，少了它有些解析器会把最后一行吞掉
  return (bom ? CSV_BOM : '') + body + eol
}

/** 下载用的文件名（ASCII，避免 Content-Disposition 里的中文编码坑） */
export function csvFilename(prefix = 'export', now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `${prefix}-${stamp}.csv`
}
