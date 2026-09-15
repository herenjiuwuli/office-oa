<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../api.js'
import { shortTime } from '../labels.js'
import { displayValue, labelOf, summaryOf } from '../forms.js'

const loading = ref(true)
const error = ref('')
const items = ref([])

const acting = ref(null) // 当前正在处理的待办
const comment = ref('')
const submitting = ref(false)
const actionError = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await api.todo()
    items.value = res.items || []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(load)

const current = computed(() => items.value.find((t) => t.taskId === acting.value) || null)

function openDrawer(task) {
  acting.value = task.taskId
  comment.value = ''
  actionError.value = ''
}

function closeDrawer() {
  acting.value = null
  comment.value = ''
  actionError.value = ''
}

/** 抽屉里展示该单据的表单字段（从 formData 反推字段清单） */
const currentFields = computed(() => {
  if (!current.value) return []
  return Object.keys(current.value.formData || {})
})

async function act(action) {
  if (!current.value) return
  if (action === 'reject' && !comment.value.trim()) {
    actionError.value = '驳回必须填写理由 —— 不写理由，申请人不知道该改什么'
    return
  }
  submitting.value = true
  actionError.value = ''
  try {
    if (action === 'approve') await api.requests.approve(current.value.requestId, comment.value.trim())
    else await api.requests.reject(current.value.requestId, comment.value.trim())
    closeDrawer()
    await load()
  } catch (e) {
    // 409 = 已被处理（并发抢单 / 重复提交），把后端的原话给用户，不要自己编
    actionError.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">我的待办</h1>
        <p class="page-desc">只列出「还轮到你、且单据仍在审批中」的任务；别人已处理或已归档的不会挂在这里。</p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div class="card">
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!items.length" class="empty">当前没有待你审批的单据 🎉</div>
      <div v-else class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width: 72px">单号</th>
              <th>标题</th>
              <th style="width: 150px">关键信息</th>
              <th style="width: 100px">申请人</th>
              <th style="width: 92px">环节</th>
              <th style="width: 104px">分配时间</th>
              <th style="width: 130px" class="t-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in items" :key="t.taskId">
              <td class="t-mono">
                <router-link :to="`/requests/${t.requestId}`">#{{ t.requestId }}</router-link>
              </td>
              <td>
                <router-link :to="`/requests/${t.requestId}`">{{ t.title }}</router-link>
              </td>
              <td class="t-muted">{{ summaryOf(t.type, t.formData) }}</td>
              <td>{{ t.applicantName }}</td>
              <td class="t-muted">第 {{ t.stepNo }} 步</td>
              <td class="t-muted t-nowrap">{{ shortTime(t.assignedAt) }}</td>
              <td class="t-right">
                <button class="btn btn-primary btn-sm" @click="openDrawer(t)">处理</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 处理抽屉：同意 / 驳回放在一起，避开误点 -->
    <template v-if="current">
      <div class="drawer-mask" @click="closeDrawer"></div>
      <div class="drawer">
        <div class="drawer-head">
          <span>处理单据 #{{ current.requestId }}</span>
          <button class="btn-link" @click="closeDrawer">关闭</button>
        </div>

        <div class="drawer-body">
          <div v-if="actionError" class="alert alert-error">{{ actionError }}</div>

          <div class="card" style="box-shadow: none; background: #fafbfd">
            <div class="card-title">{{ current.title }}</div>
            <dl class="kv">
              <dt>类型</dt>
              <dd>{{ current.type }}</dd>
              <dt>申请人</dt>
              <dd>{{ current.applicantName }}</dd>
              <dt>当前环节</dt>
              <dd>第 {{ current.stepNo }} 步</dd>
              <template v-for="f in currentFields" :key="f">
                <dt>{{ labelOf(f) }}</dt>
                <dd>{{ displayValue(f, current.formData[f]) }}</dd>
              </template>
            </dl>
          </div>

          <div class="field">
            <label>审批意见</label>
            <textarea v-model="comment" data-t="comment" placeholder="同意可留空；驳回必须写理由（最多 500 字）"></textarea>
          </div>

          <div class="alert alert-info" style="font-size: 12.5px">
            并发提示：如果这条单据刚被（别人或你自己）处理过，本操作会返回
            <code>409</code> —— 那是条件更新防线在生效，刷新即可看到最新状态。
          </div>

          <router-link :to="`/requests/${current.requestId}`" class="btn-link">查看完整详情与审批时间线 →</router-link>
        </div>

        <div class="drawer-foot">
          <button class="btn btn-danger" :disabled="submitting" @click="act('reject')">驳回</button>
          <button class="btn btn-ok" :disabled="submitting" @click="act('approve')">
            {{ submitting ? '提交中…' : '同意' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
