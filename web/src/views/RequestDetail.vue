<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api.js'
import { session } from '../store.js'
import { ACTION, APPROVER_TYPE, MODE, statusCls, statusText, shortTime, fmt } from '../labels.js'
import { displayValue, labelOf } from '../forms.js'

const route = useRoute()
const router = useRouter()

const id = computed(() => route.params.id)
const loading = ref(true)
const error = ref('')
const errStatus = ref(0)
const detail = ref(null)

const flash = ref(route.query.submitted === '1' ? '已提交，等待审批' : route.query.drafted === '1' ? '已存为草稿' : '')

const comment = ref('')
const acting = ref(false)
const showReject = ref(false)
const actionError = ref('')

const me = computed(() => session.user)

async function load() {
  loading.value = true
  error.value = ''
  errStatus.value = 0
  try {
    detail.value = await api.requests.get(id.value)
  } catch (e) {
    error.value = e.message
    errStatus.value = e.status || 0
    detail.value = null
  } finally {
    loading.value = false
  }
}

// --- 我是谁、我能做什么 ---
const isApplicant = computed(() => !!detail.value && detail.value.applicantId === me.value?.id)
// 「可编辑态」：草稿 / 被驳回（可改了重提）。附件增删与「能否提交」共用同一个判断。
const isEditable = computed(() => ['draft', 'rejected'].includes(detail.value?.status))
const canSubmit = computed(() => isApplicant.value && isEditable.value)
const canCancel = computed(() => isApplicant.value && ['draft', 'pending'].includes(detail.value?.status))

/** 我是「当前这一步」的待审审批人吗？注意必须同时匹配 round / stepNo / 未处理 */
const myTask = computed(() => {
  const d = detail.value
  if (!d || d.status !== 'pending') return null
  return (
    (d.tasks || []).find(
      (t) => t.approverId === me.value?.id && t.stepNo === d.currentStep && t.round === d.round && !t.action,
    ) || null
  )
})

/** 只是「某个环节的审批人」但没轮到我 —— 用于给出友好提示，而不是让人对着没按钮的页面发呆 */
const isOtherStepApprover = computed(() => {
  const d = detail.value
  if (!d || !me.value) return false
  return (d.tasks || []).some((t) => t.approverId === me.value.id) && !myTask.value
})

// --- 审批时间线 ---
const timeline = computed(() => {
  const d = detail.value
  if (!d) return []
  const snap = d.flowSnapshot || []
  const tasks = d.tasks || []
  const rounds = [...new Set(tasks.map((t) => t.round))]
  if (!rounds.length) rounds.push(d.round || 1)
  rounds.sort((a, b) => a - b)

  return rounds.map((round) => ({
    round,
    steps: snap.map((s) => {
      const stepTasks = tasks.filter((t) => t.round === round && t.stepNo === s.step_no)
      const isCurrent = d.status === 'pending' && round === d.round && s.step_no === d.currentStep

      let state = 'future'
      if (stepTasks.length) {
        if (stepTasks.some((t) => t.action === 'reject')) state = 'rejected'
        else if (stepTasks.every((t) => t.action !== null)) state = 'done'
        else if (stepTasks.some((t) => t.action !== null)) state = 'partial'
        else state = 'waiting'
      }
      if (isCurrent && (state === 'waiting' || state === 'partial')) state = 'current'

      return { ...s, tasks: stepTasks, isCurrent, state, key: `${round}-${s.step_no}` }
    }),
  }))
})

const totalRounds = computed(() => timeline.value.length)

function dotClass(step) {
  if (step.state === 'done') return 'done'
  if (step.state === 'rejected') return 'reject'
  if (step.isCurrent) return 'current'
  return ''
}

function stepStateText(step) {
  if (step.state === 'done') return '已通过'
  if (step.state === 'rejected') return '已驳回'
  if (step.state === 'partial') return '会签中（部分已批）'
  if (step.isCurrent) return '等待审批'
  if (step.state === 'waiting') return '排队中'
  return '未开始'
}
function stepStateCls(step) {
  if (step.state === 'done') return 'st-approved'
  if (step.state === 'rejected') return 'st-rejected'
  if (step.state === 'partial' || step.isCurrent) return 'st-pending'
  return 'st-draft'
}

// --- 动作 ---
async function doAction(fn) {
  acting.value = true
  actionError.value = ''
  try {
    await fn()
    flash.value = ''
    showReject.value = false
    comment.value = ''
    await load()
  } catch (e) {
    actionError.value = e.message
  } finally {
    acting.value = false
  }
}

const onSubmit = () => doAction(() => api.requests.submit(id.value))
const onCancel = () => doAction(() => api.requests.cancel(id.value))
const onApprove = () => doAction(() => api.requests.approve(id.value, comment.value.trim()))

function onReject() {
  if (!comment.value.trim()) {
    actionError.value = '驳回必须填写理由'
    return
  }
  doAction(() => api.requests.reject(id.value, comment.value.trim()))
}

const formFields = computed(() => Object.keys(detail.value?.formData || {}))
const statusInfo = computed(() =>
  detail.value ? { text: statusText(detail.value.status), cls: statusCls(detail.value.status) } : null,
)

// --- AI 摘要（M2，可选能力）---
// 三条前端约定：
//   1. AI 关闭 / 失败都是【正常状态】，不是报错 —— 所以降级用 alert-warn 展示，不用红色错误块
//   2. 结果旁边永远写着「以原始表单为准」—— 模型输出是展示物，不是事实
//   3. 按钮在没配置时就置灰，别让用户白点一次
const aiEnabled = ref(false)
const aiHint = ref('')
const aiBusy = ref(false)
const aiResult = ref(null)
const aiError = ref('')

async function loadAiStatus() {
  try {
    const s = await api.ai.status()
    aiEnabled.value = !!s.enabled
    aiHint.value = s.reason || ''
  } catch {
    // 拿不到状态就当没启用：AI 是可选能力，不该影响主流程
    aiEnabled.value = false
    aiHint.value = '无法获取 AI 状态'
  }
}

async function genSummary() {
  aiBusy.value = true
  aiError.value = ''
  try {
    aiResult.value = await api.ai.summarize(id.value)
  } catch (e) {
    // 走到这里说明连 HTTP 都失败了（网络/越权/404），跟「AI 服务不可用」是两件事
    aiError.value = e.message
    aiResult.value = null
  } finally {
    aiBusy.value = false
  }
}

onMounted(() => {
  load()
  loadAiStatus()
})

// --- 附件（M2）---
// 前端只负责「谁能看到上传/删除按钮」的 UX；真正的规则（申请人 + 可编辑态、
// 类型白名单、大小上限、下载鉴权）全在后端，前端拦不住也不打算拦。
const attachBusy = ref(false)
const attachError = ref('')
const canEditAttachments = computed(() => isApplicant.value && isEditable.value)

function fmtSize(n) {
  if (!n && n !== 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function onPickFile(e) {
  const file = e.target.files?.[0]
  if (!file) return
  attachBusy.value = true
  attachError.value = ''
  try {
    await api.attachments.upload(id.value, file)
    await load()
  } catch (err) {
    attachError.value = err.message
  } finally {
    attachBusy.value = false
    e.target.value = '' // 清空，允许连续上传同一个文件
  }
}

async function onDownloadAttachment(a) {
  attachError.value = ''
  try {
    await api.attachments.download(a.id, a.name)
  } catch (err) {
    attachError.value = err.message
  }
}

async function onDeleteAttachment(a) {
  if (!window.confirm(`确定删除附件「${a.name}」？`)) return
  attachError.value = ''
  try {
    await api.attachments.remove(a.id)
    await load()
  } catch (err) {
    attachError.value = err.message
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">
          单据 #{{ id }}
          <span v-if="detail" class="badge" :class="statusInfo.cls" style="vertical-align: middle; margin-left: 6px">
            {{ statusInfo.text }}
          </span>
        </h1>
        <p class="page-desc" v-if="detail">{{ detail.title }}</p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="load">刷新</button>
        <router-link to="/requests"><button class="btn">返回列表</button></router-link>
      </div>
    </div>

    <div v-if="flash" class="alert alert-ok">{{ flash }}</div>
    <div v-if="loading" class="empty">加载中…</div>

    <!-- 403 / 404 用后端原话展示：越权这件事要看得见，而不是被前端悄悄藏起来 -->
    <div v-else-if="error" class="card">
      <div class="alert" :class="errStatus === 403 ? 'alert-warn' : 'alert-error'" style="margin-bottom: 0">
        <b>HTTP {{ errStatus || '—' }}</b> · {{ error }}
      </div>
      <p class="t-muted" style="font-size: 12.5px; margin-bottom: 0">
        <template v-if="errStatus === 403">
          这是后端的横向越权防线：只有申请人、该单据的审批人、或持有
          <code class="t-mono">request:read:all</code> 的人才能查看这张单据。
          换个有权限的账号登录就能看到 —— 前端没有能力绕过它。
        </template>
        <template v-else-if="errStatus === 404">这张单据不存在。</template>
      </p>
    </div>

    <template v-else-if="detail">
      <!-- 操作区 -->
      <div v-if="actionError" class="alert alert-error">{{ actionError }}</div>

      <div class="card">
        <div class="card-title">
          <span>可执行的操作</span>
          <span class="hint">按钮是按「你的身份 + 单据状态」算出来的；后端仍会再校验一次</span>
        </div>

        <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center">
          <button v-if="canSubmit" class="btn btn-primary" :disabled="acting" @click="onSubmit">
            {{ detail.status === 'rejected' ? '修改后重新提交（第 ' + (detail.round + 1) + ' 轮）' : '提交审批' }}
          </button>

          <template v-if="myTask">
            <button class="btn btn-ok" :disabled="acting" @click="onApprove">同意</button>
            <button class="btn btn-danger" :disabled="acting" @click="showReject = !showReject">驳回</button>
          </template>

          <button v-if="canCancel" class="btn" :disabled="acting" @click="onCancel">撤回</button>

          <span v-if="!canSubmit && !myTask && !canCancel" class="t-muted" style="font-size: 13px">
            <!-- 顺序很重要：先判「单据是否已结束」。
                 反过来写的话，一个已经审过的人看归档单据会看到「但当前还没轮到你」——
                 单据都结束了，这句是错的，会让人以为还要继续等。 -->
            <template v-if="detail.status !== 'pending'">
              单据已结束（{{ statusInfo.text }}），没有可执行的操作。
            </template>
            <template v-else-if="isOtherStepApprover">
              你是这张单据某个环节的审批人，但当前还没轮到你。
            </template>
            <template v-else>当前在等审批人处理，你没有可执行的操作。</template>
          </span>
        </div>

        <div v-if="showReject && myTask" style="margin-top: 12px">
          <div class="field">
            <label>驳回理由<span class="req">*</span></label>
            <textarea v-model="comment" placeholder="写清楚要申请人改什么（最多 500 字）"></textarea>
          </div>
          <div style="display: flex; gap: 8px; justify-content: flex-end">
            <button class="btn" @click="showReject = false">取消</button>
            <button class="btn btn-danger" :disabled="acting" @click="onReject">确认驳回</button>
          </div>
        </div>

        <div v-if="myTask" style="margin-top: 12px">
          <div class="field">
            <label>审批意见（同意时可选）</label>
            <textarea v-model="comment" placeholder="如：已核对活动预算"></textarea>
          </div>
        </div>
      </div>

      <!-- AI 审批摘要（M2，可选能力）。
           它存在的意义只有一个：让审批人不用逐字读表单就能抓到重点。
           注意它的三条产品边界 —— 只读、只展示、失败即降级（后端已保证，前端负责如实呈现）。 -->
      <div class="card">
        <div class="card-title">
          <span>AI 审批摘要</span>
          <span class="hint">AI 生成，仅供参考；请以下方「表单内容」为准</span>
        </div>

        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
          <button class="btn" :disabled="aiBusy || !aiEnabled" @click="genSummary">
            {{ aiBusy ? '生成中…' : aiResult?.available ? '重新生成' : '生成摘要' }}
          </button>
          <span v-if="!aiEnabled" class="t-muted" style="font-size: 12.5px">
            未启用{{ aiHint ? '：' + aiHint : '' }}
          </span>
          <span v-else-if="aiResult?.available" class="t-muted" style="font-size: 12px">
            模型 {{ aiResult.model }}
            <template v-if="aiResult.usage?.promptTokens !== null">
              · 用量 {{ aiResult.usage.promptTokens }}+{{ aiResult.usage.completionTokens }} tokens
            </template>
          </span>
        </div>

        <div v-if="aiError" class="alert alert-error" style="margin-top: 10px; margin-bottom: 0">
          {{ aiError }}
        </div>

        <!-- 降级：AI 挂了是【正常状态】，不是错误页 —— 所以用 warn 而不是 error，
             并且明确告诉用户「不影响审批」，避免他以为系统坏了。 -->
        <div
          v-else-if="aiResult && !aiResult.available"
          class="alert alert-warn"
          style="margin-top: 10px; margin-bottom: 0"
        >
          AI 摘要暂时不可用：{{ aiResult.reason }}
          <div class="t-muted" style="font-size: 12.5px; margin-top: 4px">
            这不影响单据本身和审批操作，直接看下方的「表单内容」即可。
          </div>
        </div>

        <template v-else-if="aiResult?.available">
          <ul style="margin: 10px 0 0; padding-left: 20px; font-size: 13.5px; line-height: 1.9">
            <li v-for="(p, i) in aiResult.points" :key="'ai-p' + i">{{ p }}</li>
          </ul>

          <div v-if="aiResult.risks && aiResult.risks.length" class="alert alert-warn" style="margin: 10px 0 0">
            <b>需要留意</b>
            <ul style="margin: 6px 0 0; padding-left: 20px; font-size: 13px; line-height: 1.8">
              <li v-for="(r, i) in aiResult.risks" :key="'ai-r' + i">{{ r }}</li>
            </ul>
          </div>

          <div class="t-muted" style="font-size: 12px; margin-top: 10px">
            AI 只做归纳，不参与审批判断 —— 它在系统里没有任何修改单据状态的能力。
            <template v-if="myTask"> 审批前请核对下方的原始表单。</template>
          </div>
        </template>
      </div>

      <div class="two-col">
        <!-- 左：单据信息 -->
        <div>
          <div class="card">
            <div class="card-title">单据信息</div>
            <dl class="kv">
              <dt>单号</dt>
              <dd class="t-mono">#{{ detail.id }}</dd>
              <dt>标题</dt>
              <dd>{{ detail.title }}</dd>
              <dt>类型</dt>
              <dd class="t-mono">{{ detail.type }}</dd>
              <dt>申请人</dt>
              <dd>
                {{ detail.applicantName || '—' }}
                <span v-if="isApplicant" class="badge st-draft" style="margin-left: 4px">本人</span>
              </dd>
              <dt>审批轮次</dt>
              <dd>第 {{ detail.round }} 轮{{ totalRounds > 1 ? `（共 ${totalRounds} 轮记录）` : '' }}</dd>
              <dt>当前环节</dt>
              <dd>{{ detail.status === 'pending' ? `第 ${detail.currentStep} 步` : '已结束' }}</dd>
              <dt>提交时间</dt>
              <dd>{{ fmt(detail.submittedAt) }}</dd>
              <dt>更新时间</dt>
              <dd>{{ fmt(detail.updatedAt) }}</dd>
            </dl>
          </div>

          <div class="card">
            <div class="card-title">
              <span>表单内容</span>
              <span class="hint">来自 form_data（JSON）</span>
            </div>
            <dl class="kv">
              <template v-for="f in formFields" :key="f">
                <dt>{{ labelOf(f) }}</dt>
                <dd>{{ displayValue(f, detail.formData[f]) }}</dd>
              </template>
              <template v-if="!formFields.length">
                <dt>—</dt>
                <dd class="t-muted">无内容</dd>
              </template>
            </dl>
          </div>

          <div class="card">
            <div class="card-title">
              <span>附件</span>
              <span class="hint">活动物料 / 报销凭证等，随单据一起流转</span>
            </div>

            <div v-if="attachError" class="alert alert-error" style="margin-bottom: 10px">{{ attachError }}</div>

            <div v-if="!detail.attachments?.length" class="t-muted" style="font-size: 13px">暂无附件</div>

            <div v-else data-t="attach-list" style="display: flex; flex-direction: column; gap: 6px">
              <div
                v-for="a in detail.attachments"
                :key="a.id"
                data-t="attach-item"
                style="display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap"
              >
                <span class="chip gray t-nowrap">{{ a.mime }}</span>
                <b style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px">{{ a.name }}</b>
                <span class="t-muted t-nowrap">{{ fmtSize(a.size) }}</span>
                <span class="t-muted t-nowrap">· {{ a.uploaderName }}</span>
                <button class="btn btn-sm" @click="onDownloadAttachment(a)">下载</button>
                <button v-if="canEditAttachments" class="btn btn-sm btn-danger" @click="onDeleteAttachment(a)">删除</button>
              </div>
            </div>

            <div v-if="canEditAttachments" style="margin-top: 12px">
              <label class="btn" :class="{ disabled: attachBusy }">
                {{ attachBusy ? '上传中…' : '选择文件上传' }}
                <input
                  type="file"
                  data-t="attach-input"
                  style="display: none"
                  accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
                  :disabled="attachBusy"
                  @change="onPickFile"
                />
              </label>
              <div class="t-muted" style="font-size: 12px; margin-top: 4px">
                允许 PNG / JPEG / GIF / WebP / PDF，单文件 ≤ 5MB。提交后附件锁定，不能再增删。
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-title">
              <span>流程快照</span>
              <span class="hint">提交时固化，改模板不影响本单</span>
            </div>
            <div
              v-for="s in detail.flowSnapshot"
              :key="s.step_no"
              style="display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 13px"
            >
              <span class="t-mono t-muted">第{{ s.step_no }}步</span>
              <b>{{ s.name }}</b>
              <span class="chip gray">{{ APPROVER_TYPE[s.approver_type] || s.approver_type }}</span>
              <span class="chip gray">{{ MODE[s.mode] || s.mode }}</span>
            </div>
            <div v-if="!detail.flowSnapshot?.length" class="t-muted" style="font-size: 13px">
              还没提交，快照为空
            </div>
          </div>
        </div>

        <!-- 右：审批时间线 -->
        <div class="card">
          <div class="card-title">
            <span>审批时间线</span>
            <span class="hint">含已驳回后重提的历史轮次</span>
          </div>

          <div v-if="!detail.flowSnapshot?.length" class="empty">单据尚未提交，暂无审批记录</div>

          <template v-else>
            <div v-for="r in timeline" :key="r.round">
              <div v-if="totalRounds > 1" class="round-sep">第 {{ r.round }} 轮</div>

              <div class="timeline">
                <div v-for="step in r.steps" :key="step.key" class="tl-item">
                  <span class="tl-dot" :class="dotClass(step)"></span>

                  <div class="tl-head">
                    <span class="tl-step">第{{ step.step_no }}步 · {{ step.name }}</span>
                    <span class="badge" :class="stepStateCls(step)">{{ stepStateText(step) }}</span>
                    <span class="tl-meta">
                      {{ APPROVER_TYPE[step.approver_type] || step.approver_type }}
                      <template v-if="step.approver_ref">· {{ step.approver_ref }}</template>
                      · {{ MODE[step.mode] || step.mode }}
                    </span>
                  </div>

                  <div v-if="step.tasks.length" style="margin-top: 6px">
                    <div
                      v-for="t in step.tasks"
                      :key="t.id"
                      style="display: flex; gap: 8px; align-items: baseline; font-size: 13px; padding: 2px 0"
                    >
                      <span style="min-width: 62px">{{ t.approverName || '#' + t.approverId }}</span>
                      <span
                        class="badge"
                        :class="t.action ? ACTION[t.action]?.cls : 'st-draft'"
                        style="min-width: 62px; text-align: center"
                      >
                        {{ t.action ? ACTION[t.action].text : '待审' }}
                      </span>
                      <span class="t-muted t-nowrap" style="font-size: 12px">{{ shortTime(t.actedAt || t.createdAt) }}</span>
                    </div>
                    <div v-for="t in step.tasks.filter((x) => x.comment)" :key="'c' + t.id" class="tl-comment">
                      <b>{{ t.approverName }}：</b>{{ t.comment }}
                    </div>
                  </div>
                  <div v-else class="tl-meta" style="margin-top: 3px">尚未生成审批任务</div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>
