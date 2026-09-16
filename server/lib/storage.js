// 附件存储（M2）——本地磁盘 + 「不信任客户端」三原则：
//   ① 落盘名 = 随机名（不含任何用户输入）→ 天然免疫路径穿越 / 覆盖 / 猜名
//   ② 类型 = 嗅探**真实字节**（魔数），不看客户端声明的 content-type
//   ③ 路径 = 每次拼接后再校验仍在上传目录内（纵深防御，防 DB 被写脏）
//
// 上传目录默认 data/uploads（可用 UPLOAD_DIR 覆盖，测试指向临时目录）。
// 注意：这个目录**不参与静态托管** —— 附件只能通过带鉴权的 /api/attachments/:id 下载，
//      绝不能把 data/ 挂到静态根下，否则「随机名」也挡不住直接猜 URL。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// 限制用**函数**而不是常量：在调用时读 env，测试/部署可随时覆盖（常量会在 import 时就固定死）。
export const maxUploadBytes = () => Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024) // 单文件默认 5MB
export const maxFilesPerRequest = () => Number(process.env.MAX_FILES_PER_REQUEST || 5) // 每张单据默认最多 5 个

// 白名单：key = 嗅探出的 mime，value = 落盘扩展名（我们不靠扩展名判类型，仅用于存储可读性）
const ALLOWED = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
}

export function uploadDir() {
  return process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'data', 'uploads')
}

export function ensureUploadDir() {
  const dir = uploadDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 魔数嗅探：返回真实 mime，认不出返回 null。
 * 只信字节 —— 把 exe 改名成 .png 也过不了这一关（这是本项目最重要的安全点之一）。
 */
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buf.toString('ascii', 0, 4) === '%PDF') return 'application/pdf'
  return null
}

export function isAllowedMime(mime) {
  return Object.prototype.hasOwnProperty.call(ALLOWED, mime)
}

/** 生成存盘名：随机 UUID + 白名单扩展名。**绝不含用户输入** → 免疫路径穿越。 */
export function makeStoredName(mime) {
  return `${crypto.randomUUID()}${ALLOWED[mime] || '.bin'}`
}

/**
 * stored_name → 绝对路径。拼接后**再校验一次前缀**（纵深防御）：
 * 即便 DB 里被写入了 `../../x`，这里也会抛错而不是读到目录外。
 */
export function resolveStoredPath(storedName) {
  const base = uploadDir()
  const full = path.resolve(base, String(storedName))
  const rel = path.relative(base, full)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('非法的存储路径')
  }
  return full
}

export function saveUpload(storedName, buffer) {
  ensureUploadDir()
  fs.writeFileSync(resolveStoredPath(storedName), buffer)
  return storedName
}

export function readUpload(storedName) {
  return fs.readFileSync(resolveStoredPath(storedName))
}

export function deleteUpload(storedName) {
  try {
    fs.rmSync(resolveStoredPath(storedName), { force: true })
  } catch {
    // 文件已不在就当删过了：删 DB 记录不该因为磁盘缺文件而失败
  }
}

/** 清洗下载文件名：去路径分隔与 CR/LF/引号（防响应头注入），保留中文，限长。 */
export function safeDownloadName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[\r\n"]/g, '')
    .trim()
    .slice(0, 200)
  return cleaned || 'download'
}
