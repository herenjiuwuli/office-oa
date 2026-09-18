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

// 筛选条件只在这里拼一次：列表和导出**必须**用同一份 —— 否则会出现
// 「我筛了已驳回，导出的却是全部」这种「看着像功能差异、其实是泄露」的问题
function buildQuery() {
  const query = {}
  if (filters.status) query.status = filters.status
  if (filters.type) query.type = filters.type
  if (canSeeAll.value && filters.mine === '1') query.mine = 1
  return query
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await api.requests.list(buildQuery())
    items.value = res.items || []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

const exporting = ref(false)
const flash = ref('')

async function onExport() {
  exporting.value = true
  error.value = ''
  flash.value = ''
  try {
    // 条数来自响应头（后端数的），前端不解析 CSV —— 含换行的字段会把行数数错
    const { filename, total } = await api.requests.exportCsv(buildQuery())
    flash.value = `已导出 ${total} 条 → ${filename}`
  } catch (e) {
    error.value = e.message
  } finally {
    exporting.value = false
  }
}

onMounted(async () => {
  // 有 request:read:all 的人默认看「全部单据」——页面文案承诺的是这个（横向越权的对照组）。
  // 之前默认挂在「只看我的」：admin 打开是 0 条，文案却说要切到全部，属于文案与行为打架。
  // 普通员工没有这个权限，保持「只看我的」不变（下拉也不渲染）。
  if (canSeeAll.value) filters.mine = '0'
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
        <div class="field" style="flex: 0 0 auto">
          <button class="btn" :disabled="exporting" @click="onExport">
            {{ exporting ? '导出中…' : '导出 CSV' }}
          </button>
        </div>
      </div>
      <p class="page-desc" style="margin: 10px 0 0">
        导出会带上当前筛选条件；能看到哪些单据，导出就只有哪些（与上面的列表同一条规则，后端强制）。
      </p>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>
    <div v-if="flash" class="alert alert-ok">{{ flash }}</div>

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
