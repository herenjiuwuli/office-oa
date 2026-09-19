<script setup>
// 统计看板（M6）
//
// ⭐ 刻意不引图表库：状态条 / 趋势柱都是纯 CSS（div 宽高按百分比）。
// 这个项目的卖点是「零原生依赖」，为一个看板破坏调性不划算；
// 而且统计页真正的难点在**后端 scope 收敛**（见 server/routes/stats.js），不在画图。
import { computed, onMounted, ref } from 'vue'
import { api } from '../api.js'
import { STATUS_OPTIONS, statusText } from '../labels.js'

const loading = ref(true)
const error = ref('')
const scope = ref('')
const data = ref(null)

// 后端给的 maxScope 决定 tab 里能点哪些（mine 人人都有；dept/all 逐级收敛）
const tabs = computed(() => {
  const max = data.value?.maxScope || 'mine'
  const all = [
    { key: 'mine', label: '我的' },
    { key: 'dept', label: '本部门' },
    { key: 'all', label: '全公司' },
  ]
  const limit = { mine: 1, dept: 2, all: 3 }[max]
  return all.slice(0, limit)
})

const maxMonthly = computed(() => Math.max(1, ...(data.value?.monthly || []).map((m) => m.n)))
const statusRows = computed(() => {
  const by = data.value?.requests?.byStatus || {}
  const total = data.value?.requests?.total || 0
  return STATUS_OPTIONS.map((opt) => ({
    status: opt.value,
    n: by[opt.value] || 0,
    pct: total ? Math.round(((by[opt.value] || 0) / total) * 100) : 0,
  })).filter((r) => r.n > 0)
})
const typeNames = { leave: '请假申请', material: '物料申请', purchase: '采购申请' }

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await api.stats.overview(scope.value ? { scope: scope.value } : {})
    scope.value = data.value.scope
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function switchScope(key) {
  scope.value = key
  load()
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">统计看板</h1>
        <p class="page-desc">
          聚合接口按身份收敛数据范围：员工只看自己的，经理加本部门，
          <code class="t-mono">request:read:all</code> 才有全公司 —— 超出范围后端直接 403，不做静默降级。
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>

    <div class="tabs" style="margin-bottom: 14px">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="btn btn-sm"
        :class="{ 'btn-primary': scope === t.key }"
        :data-t="`stats-scope-${t.key}`"
        @click="switchScope(t.key)"
      >
        {{ t.label }}
      </button>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-else-if="data">
      <!-- 效率卡片 -->
      <div class="stat-row">
        <div class="card stat-card">
          <div class="stat-num">{{ data.requests.total }}</div>
          <div class="stat-label">单据总数（{{ tabs.find((t) => t.key === data.scope)?.label }}）</div>
        </div>
        <div class="card stat-card">
          <div class="stat-num">{{ data.efficiency.archivedCount }}</div>
          <div class="stat-label">已归档</div>
        </div>
        <div class="card stat-card">
          <div class="stat-num">{{ data.efficiency.avgHours == null ? '—' : data.efficiency.avgHours + 'h' }}</div>
          <div class="stat-label">平均归档耗时</div>
        </div>
        <div class="card stat-card">
          <div class="stat-num">{{ data.efficiency.avgRounds ?? '—' }}</div>
          <div class="stat-label">平均轮次</div>
        </div>
        <div class="card stat-card">
          <div class="stat-num">{{ data.rooms.total }}</div>
          <div class="stat-label">有效会议室预订</div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start">
        <!-- 状态分布 -->
        <div class="card">
          <div class="card-title"><span>单据状态分布</span></div>
          <div v-if="!statusRows.length" class="empty">这个范围还没有单据</div>
          <div v-else>
            <div v-for="r in statusRows" :key="r.status" style="margin-bottom: 10px">
              <div style="display: flex; justify-content: space-between; font-size: 12.5px; margin-bottom: 3px">
                <span>{{ statusText(r.status) }}</span>
                <span class="hint">{{ r.n }} 条 · {{ r.pct }}%</span>
              </div>
              <div class="bar-track">
                <div class="bar-fill" :class="`bar-${r.status}`" :style="{ width: r.pct + '%' }"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- 月度趋势 -->
        <div class="card">
          <div class="card-title"><span>近 6 个月提交趋势</span></div>
          <div v-if="!data.monthly.length" class="empty">近 6 个月没有提交过单据</div>
          <div v-else class="chart">
            <div v-for="m in data.monthly" :key="m.ym" class="chart-col">
              <div class="chart-bar" :style="{ height: Math.max(8, (m.n / maxMonthly) * 120) + 'px' }">
                <span class="chart-n">{{ m.n }}</span>
              </div>
              <div class="chart-ym">{{ m.ym.slice(5) }}</div>
            </div>
          </div>
          <p class="page-desc" style="margin: 8px 0 0">
            只统计提交过的单：草稿没有 submitted_at，不进趋势 —— 趋势回答的是「流程被发起的节奏」。
          </p>
        </div>
      </div>

      <!-- 类型分布 + 会议室分布 -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start">
        <div class="card">
          <div class="card-title"><span>按单据类型</span></div>
          <div v-if="!data.requests.byType.length" class="empty">暂无数据</div>
          <table v-else class="tbl">
            <thead>
              <tr><th>类型</th><th style="width: 90px" class="t-right">数量</th></tr>
            </thead>
            <tbody>
              <tr v-for="t in data.requests.byType" :key="t.type">
                <td>{{ typeNames[t.type] || t.type }}</td>
                <td class="t-right t-mono">{{ t.n }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="card">
          <div class="card-title"><span>会议室预订分布</span></div>
          <div v-if="!data.rooms.byRoom.length" class="empty">暂无预订</div>
          <table v-else class="tbl">
            <thead>
              <tr><th>会议室</th><th style="width: 90px" class="t-right">有效预订</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in data.rooms.byRoom" :key="r.name">
                <td>{{ r.name }}</td>
                <td class="t-right t-mono">{{ r.n }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.stat-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
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
.bar-track {
  height: 8px;
  border-radius: 4px;
  background: var(--bg-2);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 4px;
  min-width: 2px;
}
.bar-pending { background: #f59e0b; }
.bar-approved { background: #10b981; }
.bar-rejected { background: #ef4444; }
.bar-draft { background: #9ca3af; }
.bar-cancelled { background: #d1d5db; }
.chart {
  display: flex;
  align-items: flex-end;
  gap: 14px;
  height: 160px;
  padding: 0 6px;
}
.chart-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}
.chart-bar {
  width: 34px;
  background: #3b82f6;
  border-radius: 4px 4px 0 0;
  position: relative;
}
.chart-n {
  position: absolute;
  top: -18px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: var(--text-2);
}
.chart-ym {
  font-size: 10.5px;
  color: var(--text-3);
}
@media (max-width: 760px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  div[style*='grid-template-columns: 1fr 1fr'] { grid-template-columns: 1fr !important; }
}
</style>
