<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api.js'
import { can, session } from '../store.js'
import { STATUS_OPTIONS, shortTime, statusCls, statusText } from '../labels.js'
import { summaryOf } from '../forms.js'

const loading = ref(true)
const error = ref('')
const items = ref([])
const typeNames = ref({}) // type code → 中文名（来自后端 /api/request-types）

const filters = reactive({ status: '', type: '', mine: '1' })

// 有 view-all 权限的人才能切「全部 / 只看我的」；普通员工列表天然只有自己的
const canSeeAll = computed(() => can('request:read:all'))

async function loadTypes() {
  try {
    const res = await api.requestTypes()
    const map = {}
    for (const t of res.items || []) map[t.type] = t.name
    typeNames.value = map
  } catch {
    typeNames.value = {}
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const query = {}
    if (filters.status) query.status = filters.status
    if (filters.type) query.type = filters.type
    if (canSeeAll.value && filters.mine === '1') query.mine = 1
    const res = await api.requests.list(query)
    items.value = res.items || []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadTypes()
  await load()
})

const typeLabel = (t) => typeNames.value[t] || t

const counts = computed(() => {
  const c = {}
  for (const r of items.value) c[r.status] = (c[r.status] || 0) + 1
  return c
})
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">单据中心</h1>
        <p class="page-desc">
          <template v-if="canSeeAll">
            你拥有 <code class="t-mono">request:read:all</code>，默认已切到「全部单据」——这是横向越权的对照组。
          </template>
          <template v-else>
            你的角色没有 <code class="t-mono">request:read:all</code>，所以只能看到自己提交的单据（后端强制的数据范围）。
          </template>
        </p>
      </div>
      <div class="head-actions">
        <router-link to="/requests/new"><button class="btn btn-primary">+ 新建单据</button></router-link>
      </div>
    </div>

    <div class="card">
      <div class="inline-form">
        <div class="field">
          <label>状态</label>
          <select v-model="filters.status" @change="load">
            <option value="">全部状态</option>
            <option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value">{{ o.text }}</option>
          </select>
        </div>
        <div class="field">
          <label>类型</label>
          <select v-model="filters.type" @change="load">
            <option value="">全部类型</option>
            <option v-for="(name, code) in typeNames" :key="code" :value="code">{{ name }}</option>
          </select>
        </div>
        <div v-if="canSeeAll" class="field">
          <label>数据范围</label>
          <select v-model="filters.mine" @change="load">
            <option value="1">只看我的</option>
            <option value="0">全部单据</option>
          </select>
        </div>
        <div class="field" style="flex: 0 0 auto">
          <button class="btn" @click="load">刷新</button>
        </div>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div class="card">
      <div class="card-title">
        <span>
          共 {{ items.length }} 条
          <span v-for="(n, s) in counts" :key="s" class="chip gray" style="margin-left: 6px">
            {{ statusText(s) }} {{ n }}
          </span>
        </span>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!items.length" class="empty">没有符合条件的单据</div>
      <div v-else class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width: 72px">单号</th>
              <th>标题</th>
              <th style="width: 120px">类型</th>
              <th style="width: 84px">状态</th>
              <th style="width: 160px">关键信息</th>
              <th style="width: 100px">申请人</th>
              <th style="width: 104px">提交时间</th>
              <th style="width: 104px">更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in items" :key="r.id" class="clickable">
              <td class="t-mono">
                <router-link :to="`/requests/${r.id}`">#{{ r.id }}</router-link>
              </td>
              <td>
                <router-link :to="`/requests/${r.id}`">{{ r.title }}</router-link>
                <span
                  v-if="r.applicantId === session.user?.id"
                  class="badge st-draft"
                  style="margin-left: 6px"
                >
                  我提交的
                </span>
              </td>
              <td class="t-muted">{{ typeLabel(r.type) }}</td>
              <td><span class="badge" :class="statusCls(r.status)">{{ statusText(r.status) }}</span></td>
              <td class="t-muted">{{ summaryOf(r.type, r.formData) }}</td>
              <td>{{ r.applicantName || '—' }}</td>
              <td class="t-muted t-nowrap">{{ shortTime(r.submittedAt) }}</td>
              <td class="t-muted t-nowrap">{{ shortTime(r.updatedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
