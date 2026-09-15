<script setup>
import { onMounted, ref } from 'vue'
import { api } from '../api.js'
import { fmt } from '../labels.js'

const loading = ref(true)
const error = ref('')
const errStatus = ref(0)
const items = ref([])
const limit = ref('100')

async function load() {
  loading.value = true
  error.value = ''
  errStatus.value = 0
  try {
    const res = await api.auditLogs.list({ limit: limit.value })
    items.value = res.items || []
  } catch (e) {
    error.value = e.message
    errStatus.value = e.status || 0
    items.value = []
  } finally {
    loading.value = false
  }
}

onMounted(load)

/** 审计里的动作码按前缀分组，读起来更顺 */
const actionCls = (action) => {
  if (!action) return 'st-draft'
  if (action.includes('failed')) return 'st-rejected'
  if (action.endsWith('.create') || action === 'auth.login') return 'st-approved'
  if (action.endsWith('.reject')) return 'st-rejected'
  if (action.endsWith('.approve') || action.endsWith('.submit')) return 'st-pending'
  return 'st-draft'
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">审计日志</h1>
        <p class="page-desc">
          需要 <code class="t-mono">audit:read</code> 权限（只有总经理角色有）。
          登录失败也留痕 —— 这是排查「谁在爆破」的原始材料。
        </p>
      </div>
      <div class="head-actions">
        <select v-model="limit" style="width: auto" @change="load">
          <option value="50">最近 50 条</option>
          <option value="100">最近 100 条</option>
          <option value="300">最近 300 条</option>
        </select>
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>

    <div v-if="errStatus === 403" class="card">
      <div class="alert alert-warn" style="margin-bottom: 0"><b>HTTP 403</b> · {{ error }}</div>
      <p class="t-muted" style="font-size: 12.5px; margin-bottom: 0">
        用 <code class="t-mono">admin</code> 登录才能看到这份列表。
      </p>
    </div>

    <template v-else>
      <div v-if="error" class="alert alert-error">{{ error }}</div>

      <div class="card">
        <div class="card-title">
          <span>共 {{ items.length }} 条</span>
          <span class="hint">按时间倒序</span>
        </div>

        <div v-if="loading" class="empty">加载中…</div>
        <div v-else-if="!items.length" class="empty">暂无日志</div>
        <div v-else class="table-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th style="width: 52px">ID</th>
                <th style="width: 100px">操作者</th>
                <th style="width: 175px">动作</th>
                <th style="width: 140px">对象</th>
                <th>详情</th>
                <th style="width: 130px">IP</th>
                <th style="width: 140px">时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in items" :key="l.id">
                <td class="t-mono t-muted">{{ l.id }}</td>
                <td>{{ l.userName || (l.userId ? '#' + l.userId : '匿名') }}</td>
                <td>
                  <span class="badge" :class="actionCls(l.action)">{{ l.action }}</span>
                </td>
                <td class="t-mono t-muted">{{ l.targetType || '—' }}{{ l.targetId ? ' #' + l.targetId : '' }}</td>
                <td class="t-muted t-mono" style="font-size: 12px; max-width: 320px; word-break: break-all">
                  {{ l.detail || '—' }}
                </td>
                <td class="t-mono t-muted">{{ l.ip || '—' }}</td>
                <td class="t-muted t-nowrap">{{ fmt(l.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>
