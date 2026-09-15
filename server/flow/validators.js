// 单据表单校验：每种单据类型一套规则。
// 为什么不用 Fastify 的 JSON Schema 直接校验 form_data？
//   form_data 是「按 type 变化的结构」，用 Fastify schema 需要写成 anyOf 分支，可读性极差，
//   而且错误信息对用户不友好。这里手写明确规则，顺便让「非法 form_data」成为可测的 400 场景。
import { badRequest } from '../errors.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (s) =>
  typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
const isStr = (v) => typeof v === 'string'

export const REQUEST_TYPES = {
  leave: {
    name: '请假申请',
    fields: ['startDate', 'endDate', 'days', 'reason'],
    validate(d) {
      const errs = []
      if (!d || typeof d !== 'object' || Array.isArray(d)) return ['表单数据必须是对象']
      if (!isDate(d.startDate)) errs.push('startDate 必须是 YYYY-MM-DD 格式的日期')
      if (!isDate(d.endDate)) errs.push('endDate 必须是 YYYY-MM-DD 格式的日期')
      if (isDate(d.startDate) && isDate(d.endDate) && d.endDate < d.startDate) {
        errs.push('endDate 不能早于 startDate')
      }
      if (!isStr(d.reason) || d.reason.trim().length < 2) errs.push('reason 至少 2 个字')
      else if (d.reason.length > 200) errs.push('reason 不能超过 200 个字')
      if (d.days !== undefined && d.days !== null) {
        if (!Number.isFinite(Number(d.days)) || Number(d.days) <= 0) {
          errs.push('days 必须是大于 0 的数字')
        }
      }
      return errs
    },
  },

  material: {
    name: '活动物料审批',
    fields: ['activityName', 'items', 'link', 'amount'],
    validate(d) {
      const errs = []
      if (!d || typeof d !== 'object' || Array.isArray(d)) return ['表单数据必须是对象']
      if (!isStr(d.activityName) || d.activityName.trim().length < 2) errs.push('activityName 至少 2 个字')
      else if (d.activityName.length > 100) errs.push('activityName 不能超过 100 个字')

      if (!Array.isArray(d.items) || d.items.length === 0) {
        errs.push('items 必须是非空数组')
      } else if (d.items.length > 50) {
        errs.push('items 最多 50 条')
      } else {
        d.items.forEach((it, i) => {
          if (!it || typeof it !== 'object') return errs.push(`items[${i}] 必须是对象`)
          if (!isStr(it.name) || !it.name.trim()) errs.push(`items[${i}].name 必填`)
          if (!Number.isFinite(Number(it.qty)) || Number(it.qty) <= 0) {
            errs.push(`items[${i}].qty 必须是大于 0 的数字`)
          }
        })
      }
      // M1 不做附件上传，用链接代替
      if (d.link !== undefined && d.link !== null && d.link !== '' && !/^https?:\/\//i.test(String(d.link))) {
        errs.push('link 必须是 http(s) 链接')
      }
      if (d.amount !== undefined && d.amount !== null) {
        if (!Number.isFinite(Number(d.amount)) || Number(d.amount) < 0) {
          errs.push('amount 必须是不小于 0 的数字')
        }
      }
      return errs
    },
  },

  purchase: {
    name: '采购申请',
    fields: ['item', 'amount', 'reason'],
    validate(d) {
      const errs = []
      if (!d || typeof d !== 'object' || Array.isArray(d)) return ['表单数据必须是对象']
      if (!isStr(d.item) || d.item.trim().length < 2) errs.push('item 至少 2 个字')
      else if (d.item.length > 100) errs.push('item 不能超过 100 个字')
      if (!Number.isFinite(Number(d.amount)) || Number(d.amount) <= 0) errs.push('amount 必须是大于 0 的数字')
      if (d.reason !== undefined && isStr(d.reason) && d.reason.length > 200) {
        errs.push('reason 不能超过 200 个字')
      }
      return errs
    },
  },
}

export const REQUEST_TYPE_CODES = Object.keys(REQUEST_TYPES)

export function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(REQUEST_TYPES, type)
}

/** 校验失败直接抛 400，附上全部问题（不是只报第一条，方便前端一次改完） */
export function validateFormData(type, formData) {
  if (!isKnownType(type)) {
    throw badRequest(`不支持的单据类型：${type}（可选：${REQUEST_TYPE_CODES.join(', ')}）`)
  }
  const errs = REQUEST_TYPES[type].validate(formData)
  if (errs.length) throw badRequest('表单校验失败：' + errs.join('；'))
  return true
}

export const MAX_TITLE_LEN = 200
