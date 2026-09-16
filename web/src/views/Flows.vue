<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../api.js'
import { APPROVER_TYPE, MODE } from '../labels.js'

const loading = ref(true)
const error = ref('')
const errStatus = ref(0)
const flows = ref([])

async function load() {
  loading.value = true
  error.value = ''
  errStatus.value = 0
  try {
    const res = await api.flows()
    flows.value = res.items || []
  } catch (e) {
    error.value = e.message
    errStatus.value = e.status || 0
  } finally {
    loading.value = false
  }
}

onMounted(load)

const enabledCount = computed(() => flows.value.filter((f) => f.enabled).length)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">流程模板</h1>
        <p class="page-desc">
          只读。<b>改这里不会影响在途单据</b> —— 单据提交时已把步骤快照进自己身上。
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>

    <div v-if="errStatus === 403" class="card">
      <div class="alert alert-warn" style="margin-bottom: 0"><b>HTTP 403</b> · {{ error }}</div>
      <p class="t-muted" style="font-size: 12.5px; margin-bottom: 0">
        需要 <code class="t-mono">flow:read</code> 权限。
      </p>
    </div>

    <template v-else>
      <div v-if="error" class="alert alert-error">{{ error }}</div>

      <div v-if="loading" class="empty">加载中…</div>
      <template v-else>
        <div class="alert alert-info" style="font-size: 12.5px">
          共 {{ flows.length }} 条流程，其中 {{ enabledCount }} 条启用中。
          流程「启用」的判定在提交那一刻发生：<code class="t-mono">WHERE type = ? AND enabled = 1</code>。
        </div>

        <div v-for="f in flows" :key="f.id" class="card">
          <div class="card-title">
            <span>
              {{ f.name }}
              <span class="chip gray t-mono">{{ f.type }}</span>
              <span class="badge" :class="f.enabled ? 'st-approved' : 'st-cancelled'">
                {{ f.enabled ? '启用中' : '已停用' }}
              </span>
            </span>
            <span class="hint">{{ f.description }}</span>
          </div>

          <div class="table-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th style="width: 56px">步骤</th>
                  <th>环节名称</th>
                  <th style="width: 120px">审批人类型</th>
                  <th style="width: 140px">审批人引用</th>
                  <th style="width: 78px">会签方式</th>
                  <th>含义</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in f.steps" :key="s.step_no">
                  <td class="t-mono">{{ s.step_no }}</td>
                  <td>{{ s.name }}</td>
                  <td>
                    <span class="chip gray">{{ APPROVER_TYPE[s.approver_type] || s.approver_type }}</span>
                  </td>
                  <td class="t-mono t-muted">{{ s.approver_ref || '（取申请人上级）' }}</td>
                  <td>
                    <span class="badge" :class="s.mode === 'all' ? 'st-pending' : 'st-draft'">
                      {{ MODE[s.mode] || s.mode }}
                    </span>
                  </td>
                  <td class="t-muted" style="font-size: 12.5px">
                    <template v-if="s.approver_type === 'manager'">取申请人档案里的 manager_id</template>
                    <template v-else-if="s.approver_type === 'role'">
                      命中该角色的在职员工；<b v-if="s.dept_scoped">只限申请人所在部门</b><span v-else>全部部门（跨部门会签用）</span>
                    </template>
                    <template v-else>指定的某个人（按 user id）</template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
