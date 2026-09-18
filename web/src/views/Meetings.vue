<script setup>
// 会议室预订（M5）
//
// 前端刻意不做「时段冲突判断」——冲突是后端用数据库唯一约束判的（见 server/routes/meetings.js）。
// 这里只负责把后端的结论显示清楚：**409 的原文直接展示**，因为那句话里写了
// 「谁、占了哪一段」，比前端自己造一句「时间冲突」有用得多。
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api.js'
import { can } from '../store.js'

// 与后端对齐的可预订窗口：08:00–22:00，30 分钟一格
const SLOT_MIN = 16
const SLOT_MAX = 44

const loading = ref(true)
const error = ref('')
const rooms = ref([])
const bookings = ref([])
const date = ref(todayStr())
const roomFilter = ref('')

const canManage = computed(() => can('room:manage'))

const form = reactive({ roomId: '', startTime: '09:00', endTime: '10:00', title: '' })
const submitting = ref(false)
const flash = ref('')

/** 时间下拉的候选项：08:00 … 22:00（结束时间最晚到 22:00） */
const timeOptions = computed(() => {
  const out = []
  for (let s = SLOT_MIN; s <= SLOT_MAX; s++) out.push(slotText(s))
  return out
})

const roomOptions = computed(() => rooms.value.filter((r) => !r.disabled))

/** 时间轴要展示的会议室（按筛选） */
const shownRooms = computed(() =>
  roomFilter.value ? rooms.value.filter((r) => String(r.id) === String(roomFilter.value)) : rooms.value,
)

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function slotText(slot) {
  const h = Math.floor(slot / 2)
  const m = slot % 2 === 1 ? 30 : 0
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 某间房在某个槽上被谁占着（没有则返回 null） */
function bookingAt(roomId, slot) {
  return (
    bookings.value.find((b) => b.roomId === roomId && slot >= b.startSlot && slot < b.endSlot) || null
  )
}

/** 时间轴格子：该槽是否是某条预订的**起点**（用来决定要不要显示文字，避免每格重复） */
function isStart(b, slot) {
  return b && b.startSlot === slot
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [r, b] = await Promise.all([
      api.rooms.list(),
      api.bookings.list({ date: date.value }),
    ])
    rooms.value = r.items || []
    bookings.value = b.items || []
    // 第一次进来把「预订表单的会议室」落到第一间可用的房
    if (!form.roomId && roomOptions.value.length) form.roomId = roomOptions.value[0].id
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function submit() {
  error.value = ''
  flash.value = ''
  if (!form.roomId) {
    error.value = '请选择会议室'
    return
  }
  if (!form.title.trim()) {
    error.value = '会议主题必填'
    return
  }
  submitting.value = true
  try {
    await api.bookings.create({
      roomId: Number(form.roomId),
      date: date.value,
      startTime: form.startTime,
      endTime: form.endTime,
      title: form.title.trim(),
    })
    flash.value = '预订成功'
    form.title = ''
    await load()
  } catch (e) {
    // 409 的原文里带着「谁占了哪一段」，直接展示
    error.value = e.message
  } finally {
    submitting.value = false
  }
}

async function cancel(id) {
  error.value = ''
  flash.value = ''
  try {
    await api.bookings.cancel(id)
    flash.value = '已取消'
    await load()
  } catch (e) {
    error.value = e.message
  }
}

async function toggleRoom(room) {
  error.value = ''
  try {
    await api.rooms.setStatus(room.id, room.disabled ? 'active' : 'disabled')
    await load()
  } catch (e) {
    error.value = e.message
  }
}

/** 换日期/换会议室都要重新拉：占用情况是按天查的 */
function reload() {
  load()
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">会议室</h1>
        <p class="page-desc">
          谁都能订、都得看得见别人的预订才能避开。冲突由<b>后端数据库唯一约束</b>判，
          冲突时会直接告诉你被谁占了哪一段。
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="reload">刷新</button>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>
    <div v-if="flash" class="alert alert-ok">{{ flash }}</div>

    <!-- 预订表单 -->
    <div class="card">
      <div class="card-title"><span>预订</span></div>
      <div class="inline-form">
        <div class="field">
          <label>会议室<span class="req">*</span></label>
          <select v-model="form.roomId" data-t="booking-room">
            <option v-for="r in roomOptions" :key="r.id" :value="r.id">
              {{ r.name }}（{{ r.capacity }} 人 · {{ r.location }}）
            </option>
          </select>
        </div>
        <div class="field">
          <label>日期</label>
          <input v-model="date" type="date" @change="reload" />
        </div>
        <div class="field">
          <label>开始<span class="req">*</span></label>
          <select v-model="form.startTime" data-t="booking-start">
            <option v-for="t in timeOptions" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>
        <div class="field">
          <label>结束<span class="req">*</span></label>
          <select v-model="form.endTime" data-t="booking-end">
            <option v-for="t in timeOptions" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>
        <div class="field" style="flex: 1 1 200px">
          <label>主题<span class="req">*</span></label>
          <input v-model="form.title" type="text" data-t="booking-title" placeholder="例如：双周会（最多 60 字）" />
        </div>
        <div class="field" style="flex: 0 0 auto">
          <button class="btn btn-primary" :disabled="submitting" @click="submit">
            {{ submitting ? '预订中…' : '预订' }}
          </button>
        </div>
      </div>
      <p class="page-desc" style="margin: 10px 0 0">
        可预订 08:00–22:00，按半小时对齐；单次最多 4 小时；不支持跨天。
      </p>
    </div>

    <!-- 占用时间轴 -->
    <div class="card">
      <div class="card-title">
        <span>{{ date }} 的占用情况</span>
        <select v-model="roomFilter" style="width: auto" @change="reload">
          <option value="">全部会议室</option>
          <option v-for="r in rooms" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!shownRooms.length" class="empty">没有会议室</div>
      <!-- 用 div grid 而不是 table：28 列在 table 布局下会被长表头挤爆（实测），grid 每列等宽可控 -->
      <div v-else class="tl">
        <div class="tl-row tl-header">
          <div class="tl-room">会议室</div>
          <div v-for="s in SLOT_MAX - SLOT_MIN" :key="'h' + s" class="tl-head">
            {{ (s - 1) % 2 === 0 ? slotText(SLOT_MIN + s - 1) : '' }}
          </div>
        </div>
        <div v-for="r in shownRooms" :key="r.id" class="tl-row">
          <div class="tl-room">
            {{ r.name }}
            <span v-if="r.disabled" class="chip gray">停用</span>
            <div class="hint">{{ r.capacity }} 人 · {{ r.location }}</div>
          </div>
          <div
            v-for="s in SLOT_MAX - SLOT_MIN"
            :key="r.id + '-' + s"
            class="tl-cell"
            :class="{
              taken: !!bookingAt(r.id, SLOT_MIN + s - 1),
              mine: bookingAt(r.id, SLOT_MIN + s - 1)?.canCancel,
              off: r.disabled,
            }"
            :title="
              bookingAt(r.id, SLOT_MIN + s - 1)
                ? `${bookingAt(r.id, SLOT_MIN + s - 1).startTime}-${bookingAt(r.id, SLOT_MIN + s - 1).endTime} ${bookingAt(r.id, SLOT_MIN + s - 1).title}（${bookingAt(r.id, SLOT_MIN + s - 1).userName}）`
                : `${slotText(SLOT_MIN + s - 1)} 空闲`
            "
          >
            <span v-if="isStart(bookingAt(r.id, SLOT_MIN + s - 1), SLOT_MIN + s - 1)" class="tl-text">
              {{ bookingAt(r.id, SLOT_MIN + s - 1).title }}
            </span>
          </div>
        </div>
      </div>
      <p class="page-desc" style="margin: 10px 0 0">
        <span class="chip gray">浅灰</span> 空闲 ·
        <span class="chip st-pending">蓝色</span> 已被预订（深色=你自己的，可取消）· 鼠标悬停看详情
      </p>
    </div>

    <!-- 当日预订列表 -->
    <div class="card">
      <div class="card-title">
        <span>共 {{ bookings.length }} 条预订</span>
      </div>
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!bookings.length" class="empty">这一天还没有预订</div>
      <div v-else class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>时段</th>
              <th>会议室</th>
              <th>主题</th>
              <th>预订人</th>
              <th class="t-right" style="width: 90px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in bookings" :key="b.id">
              <td class="t-mono">{{ b.startTime }}–{{ b.endTime }}</td>
              <td>{{ b.roomName }}</td>
              <td>{{ b.title }}</td>
              <td>{{ b.userName }}</td>
              <td class="t-right">
                <button
                  v-if="b.canCancel"
                  class="btn btn-sm btn-danger"
                  data-t="booking-cancel"
                  @click="cancel(b.id)"
                >
                  取消
                </button>
                <span v-else class="hint">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 管理侧（room:manage） -->
    <div v-if="canManage" class="card">
      <div class="card-title"><span>会议室管理（{{ 'room:manage' }}）</span></div>
      <div class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>名称</th>
              <th>位置</th>
              <th style="width: 80px">容纳</th>
              <th class="t-right" style="width: 110px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rooms" :key="r.id">
              <td>{{ r.name }}</td>
              <td class="hint">{{ r.location }}</td>
              <td>{{ r.capacity }}</td>
              <td class="t-right">
                <button class="btn btn-sm" data-t="room-toggle" @click="toggleRoom(r)">
                  {{ r.disabled ? '启用' : '停用' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="page-desc" style="margin: 10px 0 0">
        停用后<b>不能再新订</b>，但已有的预订不受影响 —— 悄悄删掉别人订好的会，等于无声毁约。
      </p>
    </div>
  </div>
</template>

<style scoped>
/* 时间轴：div grid（28 列在 table 布局下会被挤爆，实测）。窄屏横向滚动 */
.tl {
  overflow-x: auto;
}
.tl-row {
  display: grid;
  grid-template-columns: 150px repeat(28, minmax(24px, 1fr));
  align-items: stretch;
  border-top: 1px solid var(--border);
}
.tl-row:first-child {
  border-top: none;
}
.tl-header .tl-head {
  font-size: 10px;
  color: var(--text-3);
  text-align: left;
  padding: 4px 1px;
  white-space: nowrap;
}
.tl-room {
  padding: 6px 8px;
  font-size: 12.5px;
  font-weight: 500;
}
.tl-cell {
  height: 34px;
  background: var(--bg-2);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
.tl-cell.taken {
  background: #bfdbfe;
  border-radius: 2px;
}
.tl-cell.mine {
  background: #60a5fa;
}
.tl-cell.off {
  background: repeating-linear-gradient(45deg, #f3f4f6, #f3f4f6 4px, #e5e7eb 4px, #e5e7eb 8px);
}
.tl-text {
  display: block;
  font-size: 10px;
  line-height: 1.2;
  color: #1e3a8a;
  overflow: hidden;
  white-space: nowrap;
}
.tl-cell.mine .tl-text {
  color: #fff;
}
</style>
