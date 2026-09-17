<script setup>
// 消息中心（M3）：只读自己的通知。
// 与「我的待办」的区别写进页面描述里 —— 这两个页面长得像，但回答的是两个不同问题：
//   待办 = 「现在需要我做什么」（可以没有，也可以过期失效）
//   通知 = 「已经发生了什么」（发生过就一定留痕）
import { computed, onMounted, ref } from 'vue'
import { api } from '../api.js'
import { notifyCls, notifyText, shortTime } from '../labels.js'
import { inbox, setUnread } from '../store.js'

const loading = ref(true)
const error = ref('')
const items = ref([])
const tab = ref('all') // all | unread
const busy = ref(false)

const unreadCount = computed(() => inbox.unread)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await api.notifications.list(tab.value === 'unread' ? { unread: 1 } : undefined)
    items.value = res.items || []
    // ★ 用后端返回的全量未读数写进共享状态（不是数本页有几条未读）—— 角标才不会算少
    setUnread(res.unread)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(load)

function switchTab(next) {
  if (tab.value === next) return
  tab.value = next
  load()
}

/** 标记单条已读：写完后用后端返回的 unread 覆盖共享状态（谁写谁 set） */
async function markRead(n) {
  if (n.read || busy.value) return
  busy.value = true
  try {
    const res = await api.notifications.read(n.id)
    n.read = res.read
    n.readAt = res.readAt
    setUnread(res.unread)
    // 未读视图依赖服务端 unread 过滤；本地已读后要从列表移除，否则行留着只有角标-1（鬼状态）
    if (tab.value === 'unread') {
      const i = items.value.findIndex((x) => x.id === n.id)
      if (i !== -1) items.value.splice(i, 1)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function markAll() {
  if (!unreadCount.value || busy.value) return
  busy.value = true
  try {
    await api.notifications.readAll()
    setUnread(0)
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">消息中心</h1>
        <p class="page-desc">
          记录「已经发生的事」：有新任务等你审批、你的单据被通过或被驳回、单据被撤回。
          与「我的待办」不同 —— 待办会随着别人处理而消失，通知不会。
        </p>
      </div>
      <div class="head-actions">
        <button class="btn btn-sm" :class="{ 'btn-primary': tab === 'all' }" @click="switchTab('all')">
          全部
        </button>
        <button class="btn btn-sm" :class="{ 'btn-primary': tab === 'unread' }" @click="switchTab('unread')">
          未读<span v-if="unreadCount">（{{ unreadCount }}）</span>
        </button>
        <button class="btn btn-sm" :disabled="!unreadCount || busy" @click="markAll">全部标为已读</button>
        <button class="btn" @click="load">刷新</button>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div class="card">
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!items.length" class="empty">
        {{ tab === 'unread' ? '没有未读消息 🎉' : '还没有任何消息' }}
      </div>
      <div v-else class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width: 88px">类型</th>
              <th>内容</th>
              <th style="width: 76px">轮次</th>
              <th style="width: 104px">时间</th>
              <th style="width: 150px" class="t-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="n in items" :key="n.id">
              <td>
                <span class="badge" :class="notifyCls(n.type)">{{ notifyText(n.type) }}</span>
                <div v-if="!n.read" class="chip gray" style="margin-top: 4px">未读</div>
              </td>
              <td>
                <div :style="n.read ? '' : 'font-weight: 600'">{{ n.title }}</div>
                <div class="t-muted" style="font-size: 12.5px; margin-top: 2px">{{ n.body }}</div>
              </td>
              <td class="t-muted t-nowrap">第 {{ n.round }} 轮</td>
              <td class="t-muted t-nowrap">{{ shortTime(n.createdAt) }}</td>
              <td class="t-right">
                <button v-if="!n.read" class="btn btn-sm" :disabled="busy" @click="markRead(n)">标为已读</button>
                <router-link v-if="n.requestId" :to="`/requests/${n.requestId}`" class="btn-link" style="margin-left: 8px">
                  查看单据
                </router-link>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="alert alert-info" style="font-size: 12.5px">
      通知的「轮次」是<strong>事件发生那一刻的快照</strong> —— 单据被驳回后重提会变成第 2 轮，
      但那条「第 1 轮被驳回」的历史消息不会跟着改口。
    </div>
  </div>
</template>
