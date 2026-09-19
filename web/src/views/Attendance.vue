<script setup>
// 考勤打卡（M7）
//
// ⭐ 同样零图表库：出勤/迟到/缺卡都是纯 CSS 数字卡 + 表格。
// 真正的难点在后端：① 打卡幂等（UNIQUE(user_id,date) 挡重复）② 统计的 scope 收敛
// （和 M6 统计同一套语义，复用 request:read:all，越界 403 不降级）。
import { computed, onMounted, ref } from 'vue'
import { api } from '../api.js'

const today = new Date().toISOString().slice(0, 10)
const thisMonth = today.slice(0, 7)

const month = ref(thisMonth)
const scope = ref('')
const loading = ref(true)
const error = ref('')

const todayRec = ref(null) // 今天的打卡记录
const overview = ref(null) // 统计看板
const myRows = ref([]) // 本人月度记录

const tabs = computed(() => {
  const max = overview.value?.maxScope || 'mine'
  const all = [
    { key: 'mine', label: '我的' },
    { key: 'dept', label: '本部门' },
    { key: 'all', label: '全公司' },
  ]
  const limit = { mine: 1, dept: 2, all: 3 }[max]
  return all.slice(0, limit)
})

const summary = computed(() => overview.value?.summary || { recordedDays: 0, lateDays: 0, absentDays: 0 })
const statusText = (s) => ({ normal: '正常', late: '迟到', pending: '待下班' }[s] || s)

// 打卡按钮的可用态（和后端状态一致：重复打卡会被 409，前端也先置灰）
const canClockIn = computed(() => !todayRec.value?.clockIn)
const canClockOut = computed(() => !!todayRec.value?.clockIn && !todayRec.value?.clockOut)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const me = await api.attendance.me({ month: month.value })
    myRows.value = me.items
    todayRec.value = me.items.find((r) => r.date === today) || null
    overview.value = await api.attendance.overview(
      scope.value ? { scope: scope.value, month: month.value } : { month: month.value },
    )
    scope.value = overview.value.scope
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function clock(type) {
  error.value = ''
  try {
    await api.attendance.clock(type)
    await load()
  } catch (e) {
    error.value = e.message // 重复打卡 / 没上班先打下班会显示后端原文
  }
}

function switchScope(key) {
  scope.value = key
  load()
}

function changeMonth() {
  load()
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">考勤打卡</h1>
        <p class="page-desc">
          上班 / 下班本人当天各一次（重复打卡由数据库唯一约束拦截）。统计按身份收敛范围：
          员工只看自己，经理加本部门，<code class="t-mono">request:read:all</code> 才有全公司 —— 超出范围后端 403，不静默降级。
        </p>
      </div>
      <div class="head-actions">
        <input type="month" class="input" v-model="month" @change="changeMonth" :data-t="'att-month'" />
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>

    <div v-if="error" class="alert alert-error" :data-t="'att-error'">{{ error }}</div>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-else>
      <!-- 今天打卡 -->
      <div class="stat-row">
        <div class="card stat-card" style="grid-column: span 2">
          <div class="stat-label">今天 {{ today }}</div>
          <div style="display: flex; gap: 10px; align-items: center; margin-top: 8px" :data-t="'att-today-status'">
            <button class="btn btn-primary" :disabled="!canClockIn" @click="clock('in')" :data-t="'att-clock-in'">
              上班打卡
            </button>
            <button class="btn" :disabled="!canClockOut" @click="clock('out')" :data-t="'att-clock-out'">
              下班打卡
            </button>
            <span class="hint" v-if="todayRec">
              上班 {{ todayRec.clockIn || '—' }} · 下班 {{ todayRec.clockOut || '—' }} ·
              <b :class="todayRec.status === 'late' ? 'warn' : ''">{{ statusText(todayRec.status) }}</b>
            </span>
            <span class="hint" v-else>今天还没打上班卡</span>
          </div>
        </div>
      </div>

      <!-- 统计看板 -->
      <div class="tabs" style="margin-bottom: 14px">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="btn btn-sm"
          :class="{ 'btn-primary': scope === t.key }"
          :data-t="`att-scope-${t.key}`"
          @click="switchScope(t.key)"
        >
          {{ t.label }}
        </button>
      </div>

      <div class="stat-row">
        <div class="card stat-card">
          <div class="stat-num" :data-t="'att-summary-recorded'">{{ summary.recordedDays }}</div>
          <div class="stat-label">有打卡天数</div>
        </div>
        <div class="card stat-card">
          <div class="stat-num warn">{{ summary.lateDays }}</div>
          <div class="stat-label">迟到天数</div>
        </div>
        <div class="card stat-card">
          <div class="stat-num danger">{{ summary.absentDays }}</div>
          <div class="stat-label">缺卡天数</div>
        </div>
        <div class="card stat-card">
          <div class="stat-num" :data-t="'att-summary-working'">{{ overview.workingDays }}</div>
          <div class="stat-label">应出勤天数（截至今天）</div>
        </div>
      </div>

      <!-- 逐人列表（只看自己时为空，由后端决定） -->
      <div class="card" v-if="overview.perUser && overview.perUser.length">
        <div class="card-title"><span>逐人考勤（{{ tabs.find((t) => t.key === overview.scope)?.label }}）</span></div>
        <table class="tbl">
          <thead>
            <tr>
              <th>姓名</th>
              <th style="width: 100px" class="t-right">有打卡</th>
              <th style="width: 100px" class="t-right">迟到</th>
              <th style="width: 100px" class="t-right">缺卡</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in overview.perUser" :key="u.userId" :data-t="`att-user-${u.userId}`">
              <td>{{ u.name }}</td>
              <td class="t-right t-mono">{{ u.recordedDays }}</td>
              <td class="t-right t-mono warn">{{ u.lateDays }}</td>
              <td class="t-right t-mono danger">{{ u.absentDays }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 本人月度记录 -->
      <div class="card" style="margin-top: 14px">
        <div class="card-title"><span>我的打卡记录（{{ month }}）</span></div>
        <div v-if="!myRows.length" class="empty">这个月还没有打卡记录</div>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th>日期</th>
              <th style="width: 120px">上班</th>
              <th style="width: 120px">下班</th>
              <th style="width: 90px">状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in myRows" :key="r.date" :data-t="`att-row-${r.date}`">
              <td class="t-mono">{{ r.date }}</td>
              <td class="t-mono">{{ r.clockIn || '—' }}</td>
              <td class="t-mono">{{ r.clockOut || '—' }}</td>
              <td>
                <span :class="r.status === 'late' ? 'warn' : ''">{{ statusText(r.status) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.stat-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 14px;
}
.stat-card {
  padding: 14px 16px;
}
.stat-num {
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stat-label {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
.warn {
  color: #f59e0b;
}
.danger {
  color: #ef4444;
}
@media (max-width: 760px) {
  .stat-row {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
