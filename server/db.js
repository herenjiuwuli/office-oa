// SQLite 封装（Node 22 内置 node:sqlite，零原生依赖）。
// 路径可由 DB_PATH 覆盖（测试用 :memory:），默认 data/app.db。
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url))

// ⚠️ DB_PATH 必须在 getDb() 内部「惰性求值」，不能写成模块顶层 const！
// 原因：测试里 process.env.DB_PATH=':memory:' 可能在 import 之后才赋值，
// 若顶层 const 提前把路径快照下来，:memory: 就永远不生效，
// 测试会把数据写进真实 data/app.db（污染生产库）。
function resolveDbPath() {
  return process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'app.db')
}

let _db = null

export function getDb() {
  if (_db) return _db
  const dbPath = resolveDbPath()
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  _db = new DatabaseSync(dbPath)
  // 外键约束默认不开，必须显式打开，否则 REFERENCES 形同虚设
  _db.exec('PRAGMA foreign_keys = ON;')
  // 建表：schema.sql 里全是 IF NOT EXISTS，可反复执行
  _db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  // 迁移：旧库可能没有 dept_scoped 列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列）
  const flowStepCols = _db.prepare(`PRAGMA table_info(flow_steps)`).all().map((c) => c.name)
  if (!flowStepCols.includes('dept_scoped')) {
    _db.exec(`ALTER TABLE flow_steps ADD COLUMN dept_scoped INTEGER NOT NULL DEFAULT 0`)
  }
  return _db
}

export function closeDb() {
  if (_db) {
    try {
      _db.close()
    } catch {
      // 忽略重复关闭
    }
    _db = null
  }
}

/**
 * 测试专用：丢弃当前连接并重开一个空库（:memory: 下重开即得到全新数据库）。
 * 比逐表 DELETE 更干净，也不用操心外键删除顺序。
 */
export function resetDb() {
  closeDb()
  return getDb()
}

export function dbPath() {
  return resolveDbPath()
}
