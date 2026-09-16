<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api.js'
import { can } from '../store.js'
import { fmt } from '../labels.js'

const loading = ref(true)
const error = ref('')
const items = ref([])

const canWrite = computed(() => can('announcement:write'))

const drawer = reactive({ open: false })
const form = reactive({ title: '', body: '', pinned: false })
const saving = ref(false)
const formError = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await api.announcements.list()
    items.value = res.items || []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(load)

function open() {
  form.title = ''
  form.body = ''
  form.pinned = false
  formError.value = ''
  drawer.open = true
}

function close() {
  drawer.open = false
  formError.value = ''
}

async function save() {
  formError.value = ''
  if (!form.title.trim()) {
    formError.value = '标题必填'
    return
  }
  saving.value = true
  try {
    await api.announcements.create({ title: form.title.trim(), body: form.body, pinned: form.pinned })
    close()
    await load()
  } catch (e) {
    formError.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">公告</h1>
        <p class="page-desc">所有登录用户都能看；发布需要 <code class="t-mono">announcement:write</code>。</p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="load">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="open">+ 发布公告</button>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!items.length" class="empty">暂无公告</div>
    <div v-else>
      <div v-for="n in items" :key="n.id" class="card">
        <div class="card-title">
          <span>
            <span v-if="n.pinned" class="badge st-pending" style="margin-right: 6px">置顶</span>
            {{ n.title }}
          </span>
          <span class="hint">{{ n.authorName }} · {{ fmt(n.createdAt) }}</span>
        </div>
        <div v-if="n.body" style="white-space: pre-wrap; color: var(--text-2); font-size: 13.5px">
          {{ n.body }}
        </div>
      </div>
    </div>

    <template v-if="drawer.open">
      <div class="drawer-mask" @click="close"></div>
      <div class="drawer">
        <div class="drawer-head">
          <span>发布公告</span>
          <button class="btn-link" @click="close">关闭</button>
        </div>

        <div class="drawer-body">
          <div v-if="formError" class="alert alert-error">{{ formError }}</div>

          <div class="field">
            <label>标题<span class="req">*</span></label>
            <input v-model="form.title" type="text" placeholder="最多 100 字" />
          </div>

          <div class="field">
            <label>正文</label>
            <textarea v-model="form.body" style="min-height: 160px" placeholder="最多 5000 字"></textarea>
          </div>

          <div class="field">
            <label style="display: flex; align-items: center; gap: 8px; font-weight: 400; cursor: pointer">
              <input v-model="form.pinned" type="checkbox" style="width: auto" />
              <span>置顶（列表里排在最前）</span>
            </label>
          </div>
        </div>

        <div class="drawer-foot">
          <button class="btn" @click="close">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? '发布中…' : '发布' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
