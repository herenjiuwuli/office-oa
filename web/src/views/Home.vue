<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../api.js'
import { session } from '../store.js'
import { shortTime } from '../labels.js'
import { summaryOf } from '../forms.js'

const user = computed(() => session.user)

const loading = ref(true)
const error = ref('')
const todo = ref([])
const mine = ref([])
const notices = ref([])

const mineCounts = computed(() => {
  const c = { total: mine.value.length, draft: 0, pending: 0, approved: 0, rejected: 0, cancelled: 0 }
  for (const r of mine.value) if (c[r.status] !== undefined) c[r.status] += 1
  return c
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    // 三个请求互不依赖，并行发
    const [t, m, a] = await Promise.all([
      api.todo(),
      api.requests.list({ mine: 1 }),
      api.announcements.list(),
    ])
    todo.value = t.items || []
    mine.value = m.items || []
    notices.value = (a.items || []).slice(0, 3)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(load)

const permissions = computed(() => (user.value?.permissions || []))
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">总览</h1>
        <p class="page-desc">
          你好，{{ user?.realName || '—' }}（{{ user?.deptName || '未分配部门' }} · {{ user?.position || '—' }}）
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="load">刷新</button>
        <router-link to="/requests/new"><button class="btn btn-primary">+ 新建单据</button></router-link>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div class="grid-cards">
      <div class="stat">
        <div class="stat-label">待我审批</div>
        <div class="stat-value" :class="{ warn: todo.length > 0 }">{{ todo.length }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">我的单据</div>
        <div class="stat-value">{{ mineCounts.total }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">草稿（未提交）</div>
        <div class="stat-value accent">{{ mineCounts.draft }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">已通过</div>
        <div class="stat-value ok">{{ mineCounts.approved }}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>待我审批</span>
        <router-link to="/todo" class="hint">全部 →</router-link>
      </div>
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!todo.length" class="empty">当前没有待你审批的单据</div>
      <table v-else class="tbl">
        <thead>
          <tr>
            <th style="width: 75px">单号</th>
            <th>标题</th>
            <th style="width: 130px">关键信息</th>
            <th style="width: 105px">申请人</th>
            <th style="width: 100px">当前环节</th>
            <th style="width: 105px">分配时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in todo.slice(0, 5)" :key="t.taskId" class="clickable">
            <td class="t-mono">
              <router-link :to="`/requests/${t.requestId}`">#{{ t.requestId }}</router-link>
            </td>
            <td>{{ t.title }}</td>
            <td class="t-muted">{{ summaryOf(t.type, t.formData) }}</td>
            <td>{{ t.applicantName }}</td>
            <td class="t-muted">第 {{ t.stepNo }} 步</td>
            <td class="t-muted t-nowrap">{{ shortTime(t.assignedAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-title">
        <span>最近的公告</span>
        <router-link to="/announcements" class="hint">全部 →</router-link>
      </div>
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!notices.length" class="empty">暂无公告</div>
      <div v-else>
        <div v-for="n in notices" :key="n.id" style="padding: 9px 0; border-bottom: 1px solid var(--border)">
          <div style="display: flex; gap: 8px; align-items: center">
            <span v-if="n.pinned" class="badge st-pending">置顶</span>
            <b>{{ n.title }}</b>
            <span class="t-muted" style="font-size: 12px">· {{ n.authorName }} · {{ shortTime(n.createdAt) }}</span>
          </div>
          <div v-if="n.body" class="t-muted" style="font-size: 13px; margin-top: 3px">{{ n.body }}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>我的权限（RBAC 实测）</span>
        <span class="hint">菜单会按这份清单隐藏，但后端才是真正的裁判</span>
      </div>
      <div class="kv" style="grid-template-columns: 88px 1fr">
        <dt>角色</dt>
        <dd>
          <span v-for="r in user?.roles || []" :key="r" class="chip">{{ r }}</span>
          <span v-if="!user?.roles?.length" class="t-muted">无</span>
        </dd>
        <dt>权限码</dt>
        <dd>
          <span v-for="p in permissions" :key="p" class="chip gray t-mono">{{ p }}</span>
          <span v-if="!permissions.length" class="t-muted">无</span>
        </dd>
        <dt>直属上级</dt>
        <dd>
          <span v-if="user?.managerId">ID {{ user.managerId }}</span>
          <span v-else class="t-muted">未配置 —— 用这个账号走「直属上级审批」环节会被流程引擎拒掉（这是刻意的兜底设计）</span>
        </dd>
      </div>
    </div>
  </div>
</template>
