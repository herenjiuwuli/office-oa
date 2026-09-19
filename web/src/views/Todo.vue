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

// ---------------------------------------------------------------------------
// 批量审批
// ---------------------------------------------------------------------------

const selected = ref([]) // 选中的 taskId
const batchComment = ref('')
const batchBusy = ref(false)
const batchError = ref('')
const batchResult = ref(null) // { httpStatus, succeeded, failed, results }

const allSelected = computed(() => items.value.length > 0 && selected.value.length === items.value.length)

function toggleOne(taskId) {
  const i = selected.value.indexOf(taskId)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(taskId)
}

function toggleAll() {
  selected.value = allSelected.value ? [] : items.value.map((t) => t.taskId)
}

/** 批量接口按**单据**维度收口（同一张单据可能同时有我名下的多个 task） */
const selectedRequestIds = computed(() =>
  items.value.filter((t) => selected.value.includes(t.taskId)).map((t) => t.requestId),
)

async function batchAct(action) {
  if (!selectedRequestIds.value.length) return
  // 和单条驳回同一条规则：不写理由，申请人不知道该改什么
  if (action === 'reject' && !batchComment.value.trim()) {
    batchError.value = '批量驳回必须填写理由 —— 不写理由，申请人不知道该改什么'
    return
  }
  batchBusy.value = true
  batchError.value = ''
  batchResult.value = null
  try {
    batchResult.value = await api.requests.batchApprove(selectedRequestIds.value, action, batchComment.value.trim())
    selected.value = []
    batchComment.value = ''
    await load()
  } catch (e) {
    batchError.value = e.message
  } finally {
    batchBusy.value = false
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">我的待办</h1>
        <p class="page-desc">
          只列出「还轮到你、且单据仍在审批中」的任务；别人已处理或已归档的不会挂在这里。
          勾选多条可批量处理：批量里每条互不影响（能批的先批掉），没成的那几条会逐条说明原因。
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>
    <div v-if="batchError" class="alert alert-error">{{ batchError }}</div>

    <!-- 批量结果：**逐条列出**。「成功 2 条、失败 1 条」这种汇总句不够用 ——
         用户真正要知道的是「哪条没成、为什么」。这正是批量操作最容易糊弄过去的地方：
         只报个总数，剩下的让人自己去列表里找。 -->
    <div v-if="batchResult" class="batch-result" :class="batchResult.failed ? 'has-fail' : ''">
      <div class="batch-result-head">
        批量完成：成功 <b>{{ batchResult.succeeded }}</b> 条<template v-if="batchResult.failed"
          >，失败 <b>{{ batchResult.failed }}</b> 条</template
        >
        <span v-if="batchResult.httpStatus === 207" class="chip-207">部分成功 207</span>
      </div>
      <ul class="batch-result-list">
        <li v-for="r in batchResult.results" :key="r.id" :class="r.ok ? 'is-ok' : 'is-bad'">
          <span class="t-mono">#{{ r.id }}</span>
          <span v-if="r.ok">已通过，流程继续流转</span>
          <span v-else>{{ r.message }}</span>
        </li>
      </ul>
      <button class="btn-link" @click="batchResult = null">知道了</button>
    </div>

    <!-- 勾选之后才出现的批量操作栏 -->
    <div v-if="selected.length" class="batch-bar">
      <span class="batch-count">已选 {{ selected.length }} 条</span>
      <input
        v-model="batchComment"
        class="batch-comment"
        placeholder="批量意见（同意可留空；驳回必填）"
        data-t="batch-comment"
      />
      <button class="btn btn-danger btn-sm" :disabled="batchBusy" @click="batchAct('reject')">批量驳回</button>
      <button
        class="btn btn-ok btn-sm"
        :disabled="batchBusy"
        @click="batchAct('approve')"
        data-t="batch-approve"
      >
        {{ batchBusy ? '处理中…' : '批量同意' }}
      </button>
      <button class="btn-link" @click="selected = []">取消选择</button>
    </div>

    <div class="card">
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!items.length" class="empty">当前没有待你审批的单据 🎉</div>
      <div v-else class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width: 44px">
                <input type="checkbox" :checked="allSelected" @change="toggleAll" aria-label="全选" />
              </th>
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
              <td>
                <input
                  type="checkbox"
                  :checked="selected.includes(t.taskId)"
                  @change="toggleOne(t.taskId)"
                  :aria-label="`选择单据 #${t.requestId}`"
                />
              </td>
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
