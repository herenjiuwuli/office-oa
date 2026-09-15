<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api.js'
import { can } from '../store.js'
import { shortTime } from '../labels.js'

const loading = ref(true)
const error = ref('')
const tree = ref([])
const flat = ref([])

const canWrite = computed(() => can('dept:write'))

const drawer = reactive({ open: false, mode: 'create', id: null })
const form = reactive({ name: '', parentId: '', sort: 0 })
const saving = ref(false)
const formError = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    // 树用于展示，平铺用于「上级部门」下拉，两个请求并行
    const [t, f] = await Promise.all([api.departments.list(), api.departments.list(true)])
    tree.value = t.items || []
    flat.value = f.items || []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(load)

/** 把树压平成带缩进层级的行 —— 比写递归组件简单，也更好加「第 N 层」这类信息 */
function flatten(nodes, depth = 0, out = []) {
  for (const n of nodes) {
    out.push({ ...n, depth })
    if (Array.isArray(n.children) && n.children.length) flatten(n.children, depth + 1, out)
  }
  return out
}

const rows = computed(() => flatten(tree.value))

const parentOptions = computed(() => flat.value.filter((d) => d.id !== drawer.id))

function openCreate(parentId = '') {
  drawer.open = true
  drawer.mode = 'create'
  drawer.id = null
  form.name = ''
  form.parentId = parentId === null || parentId === undefined ? '' : String(parentId)
  form.sort = 0
  formError.value = ''
}

function openEdit(row) {
  drawer.open = true
  drawer.mode = 'edit'
  drawer.id = row.id
  form.name = row.name
  form.parentId = row.parent_id === null || row.parent_id === undefined ? '' : String(row.parent_id)
  form.sort = row.sort ?? 0
  formError.value = ''
}

function close() {
  drawer.open = false
  formError.value = ''
}

async function save() {
  formError.value = ''
  if (!form.name.trim()) {
    formError.value = '部门名称必填'
    return
  }
  saving.value = true
  try {
    const payload = {
      name: form.name.trim(),
      parentId: form.parentId === '' ? null : Number(form.parentId),
      sort: Number(form.sort) || 0,
    }
    if (drawer.mode === 'create') await api.departments.create(payload)
    else await api.departments.update(drawer.id, payload)
    close()
    await load()
  } catch (e) {
    formError.value = e.message
  } finally {
    saving.value = false
  }
}

const usedCount = (deptId) => flat.value.filter((d) => d.parent_id === deptId).length
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">部门架构</h1>
        <p class="page-desc">
          组织架构是所有审批流的底座 —— 流程里的「直属上级」就靠员工的 manager_id 解析。
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="load">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openCreate('')">+ 新增部门</button>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div v-if="!canWrite" class="alert alert-info" style="font-size: 12.5px">
      你的角色没有 <code class="t-mono">dept:write</code>，因此看不到新增/编辑入口。
      但就算直接构造请求，后端也会返回 403 —— 前端隐藏只是整洁，不是安全。
    </div>

    <div class="card">
      <div class="card-title">
        <span>部门树（共 {{ flat.length }} 个）</span>
        <span class="hint">缩进代表层级</span>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!rows.length" class="empty">暂无部门</div>
      <div v-else>
        <div v-for="d in rows" :key="d.id" class="tree-row">
          <span style="width: 20px" :style="{ marginLeft: d.depth * 20 + 'px' }" class="t-muted t-mono">
            {{ d.depth ? '└' : '·' }}
          </span>
          <span class="tree-name">{{ d.name }}</span>
          <span class="chip gray t-mono">id {{ d.id }}</span>
          <span v-if="usedCount(d.id)" class="chip gray">下辖 {{ usedCount(d.id) }} 个子部门</span>
          <span class="t-muted" style="font-size: 12px">sort {{ d.sort }}</span>
          <span class="t-muted" style="font-size: 12px; margin-left: auto">{{ shortTime(d.created_at) }}</span>
          <template v-if="canWrite">
            <button class="btn btn-sm" @click="openCreate(d.id)">加子部门</button>
            <button class="btn btn-sm" @click="openEdit(d)">编辑</button>
          </template>
        </div>
      </div>
    </div>

    <template v-if="drawer.open">
      <div class="drawer-mask" @click="close"></div>
      <div class="drawer">
        <div class="drawer-head">
          <span>{{ drawer.mode === 'create' ? '新增部门' : `编辑部门 #${drawer.id}` }}</span>
          <button class="btn-link" @click="close">关闭</button>
        </div>

        <div class="drawer-body">
          <div v-if="formError" class="alert alert-error">{{ formError }}</div>

          <div class="field">
            <label>部门名称<span class="req">*</span></label>
            <input v-model="form.name" type="text" placeholder="最多 50 字" />
          </div>

          <div class="field">
            <label>上级部门</label>
            <select v-model="form.parentId">
              <option value="">（作为顶级部门）</option>
              <option v-for="d in parentOptions" :key="d.id" :value="String(d.id)">{{ d.name }}</option>
            </select>
            <div class="t-muted" style="font-size: 12px; margin-top: 4px">
              上级不能选自己（后端会返回 409，可以拿去测）
            </div>
          </div>

          <div class="field">
            <label>排序值</label>
            <input v-model="form.sort" type="number" step="1" />
            <div class="t-muted" style="font-size: 12px; margin-top: 4px">数字越小越靠前</div>
          </div>
        </div>

        <div class="drawer-foot">
          <button class="btn" @click="close">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
