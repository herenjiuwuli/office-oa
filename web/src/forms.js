// 单据表单的字段元数据。
//
// 为什么前端要有一份？后端 /api/request-types 只告诉前端「有哪些字段」，
// 但「这个字段该渲染成日期选择器还是文本域」是展示层的事，不该塞进后端。
// 所以：字段清单来自后端（唯一事实来源），渲染方式来自这里（缺省按文本框渲染）。

export const FIELD_META = {
  startDate: { label: '开始日期', type: 'date', required: true },
  endDate: { label: '结束日期', type: 'date', required: true },
  days: { label: '请假天数', type: 'number', step: '0.5', min: '0.5', placeholder: '如 2' },
  reason: { label: '事由', type: 'textarea', required: true, placeholder: '至少 2 个字，最多 200 字' },

  activityName: { label: '活动名称', type: 'text', required: true, placeholder: '如：长隆万圣节现场执行' },
  items: { label: '物料清单', type: 'items', required: true },
  link: { label: '参考链接', type: 'text', placeholder: 'https://...（选填）' },
  amount: { label: '金额（元）', type: 'number', min: '0', step: '0.01', placeholder: '选填' },

  item: { label: '采购物品', type: 'text', required: true, placeholder: '如：移动硬盘 × 2' },
}

export const metaOf = (field) => FIELD_META[field] || { label: field, type: 'text' }
export const labelOf = (field) => metaOf(field).label

/** 按字段清单造一份空表单 */
export function emptyFormData(fieldNames) {
  const out = {}
  for (const f of fieldNames) {
    const meta = metaOf(f)
    if (meta.type === 'items') out[f] = [{ name: '', qty: 1 }]
    else if (meta.type === 'number') out[f] = ''
    else out[f] = ''
  }
  return out
}

/**
 * 提交前的归一化：
 *  - 数字字段把 '' 变成 undefined（后端对选填数字允许缺省，但不接受空串）
 *  - items 的 qty 转成数字、丢掉整行为空的项
 * 日期字段保持 'YYYY-MM-DD' 字符串（后端就是这么校验的）。
 */
export function normalizeFormData(fieldNames, raw) {
  const out = {}
  for (const f of fieldNames) {
    const meta = metaOf(f)

    if (meta.type === 'items') {
      const rows = Array.isArray(raw[f]) ? raw[f] : []
      out[f] = rows
        .map((r) => ({ name: String(r.name ?? '').trim(), qty: Number(r.qty) }))
        .filter((r) => r.name || Number.isFinite(r.qty))
      continue
    }

    const v = raw[f]
    if (meta.type === 'number') {
      if (v === '' || v === null || v === undefined) continue // 选填数字：留空就不提交
      out[f] = Number(v)
      continue
    }

    if (typeof v === 'string') {
      const t = v.trim()
      if (t === '' && !meta.required) continue
      out[f] = t
      continue
    }

    if (v !== undefined && v !== null) out[f] = v
  }
  return out
}

/**
 * 前端先拦一道必填 —— 不为了替代后端，而是别让用户点一次保存才被告知
 * 「第 3 个字段没填」。后端仍然是唯一裁判。
 */
export function validateRequired(fieldNames, raw) {
  const missing = []
  for (const f of fieldNames) {
    const meta = metaOf(f)
    if (!meta.required) continue
    if (meta.type === 'items') {
      const rows = Array.isArray(raw[f]) ? raw[f] : []
      if (!rows.some((r) => String(r.name ?? '').trim() && Number(r.qty) > 0)) missing.push(meta.label)
    } else if (String(raw[f] ?? '').trim() === '') {
      missing.push(meta.label)
    }
  }
  return missing
}

/** 列表里显示的一行摘要，让人不用点进去就知道这张单在讲什么 */
export function summaryOf(type, formData = {}) {
  if (type === 'leave') {
    return formData.startDate ? `${formData.startDate} ~ ${formData.endDate}` : '—'
  }
  if (type === 'material') {
    const n = Array.isArray(formData.items) ? formData.items.length : 0
    return `${formData.activityName || '—'}${n ? ` · ${n} 项物料` : ''}`
  }
  if (type === 'purchase') {
    return formData.item ? `${formData.item}${formData.amount != null ? ` · ¥${formData.amount}` : ''}` : '—'
  }
  return '—'
}

/** 详情页把某个字段值渲染成可读文本 */
export function displayValue(field, value) {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) {
    if (!value.length) return '—'
    // items: [{name, qty}]
    if (typeof value[0] === 'object' && value[0] !== null) {
      return value.map((r) => `${r.name} × ${r.qty}`).join('、')
    }
    return value.join('、')
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
