<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api.js'
import { emptyFormData, metaOf, normalizeFormData, validateRequired } from '../forms.js'

const router = useRouter()

const loading = ref(true)
const error = ref('')
const types = ref([]) // [{ type, name, fields }]
const selected = ref('')

const title = ref('')
const form = reactive({ data: {} })

const saving = ref(false)

const currentType = computed(() => types.value.find((t) => t.type === selected.value) || null)
const fields = computed(() => currentType.value?.fields || [])

// 切换类型 → 重建一份空表单（不同单据的字段完全不同）
watch(selected, () => {
  form.data = emptyFormData(fields.value)
  error.value = ''
})

onMounted(async () => {
  try {
    const res = await api.requestTypes()
    types.value = res.items || []
    if (types.value.length) selected.value = types.value[0].type
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

// --- 物料清单的动态行 ---
function addItem() {
  if (!Array.isArray(form.data.items)) form.data.items = []
  form.data.items.push({ name: '', qty: 1 })
}
function removeItem(i) {
  form.data.items.splice(i, 1)
}

async function save({ submitNow }) {
  error.value = ''

  if (!title.value.trim()) {
    error.value = '标题必填'
    return
  }
  const missing = validateRequired(fields.value, form.data)
  if (missing.length) {
    error.value = `请填写必填项：${missing.join('、')}`
    return
  }

  saving.value = true
  try {
    const payload = {
      type: selected.value,
      title: title.value.trim(),
      formData: normalizeFormData(fields.value, form.data),
    }
    const created = await api.requests.create(payload)
    if (submitNow) {
      await api.requests.submit(created.id)
      router.push({ path: `/requests/${created.id}`, query: { submitted: '1' } })
    } else {
      router.push({ path: `/requests/${created.id}`, query: { drafted: '1' } })
    }
  } catch (e) {
    // 后端会把**所有**校验问题一次性返回（不是只报第一条），直接展示原话
    error.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">新建单据</h1>
        <p class="page-desc">
          「存为草稿」和「提交」是两步 —— 草稿还在你手里，提交后才会算出「该谁审」并生成审批任务。
        </p>
      </div>
      <div class="head-actions">
        <router-link to="/requests"><button class="btn">返回列表</button></router-link>
      </div>
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>
    <div v-if="loading" class="empty">加载单据类型…</div>

    <template v-else>
      <div class="card">
        <div class="card-title">选择单据类型</div>
        <div style="display: flex; gap: 10px; flex-wrap: wrap">
          <button
            v-for="t in types"
            :key="t.type"
            class="btn"
            :class="{ 'btn-primary': selected === t.type }"
            @click="selected = t.type"
          >
            {{ t.name }}
            <span style="opacity: 0.7; font-size: 12px">（{{ t.type }}）</span>
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>填写内容</span>
          <span class="hint">字段清单来自后端 <code class="t-mono">/api/request-types</code></span>
        </div>

        <div class="field">
          <label>标题<span class="req">*</span></label>
          <input
            v-model="title"
            data-t="title"
            type="text"
            placeholder="一句话说明这张单在申请什么（最多 200 字）"
          />
        </div>

        <div class="form-row">
          <template v-for="f in fields" :key="f">
            <div v-if="metaOf(f).type !== 'items'" class="field">
              <label>
                {{ metaOf(f).label }}
                <span v-if="metaOf(f).required" class="req">*</span>
              </label>

              <textarea
                v-if="metaOf(f).type === 'textarea'"
                v-model="form.data[f]"
                :data-field="f"
                :placeholder="metaOf(f).placeholder"
              ></textarea>

              <input
                v-else-if="metaOf(f).type === 'date'"
                v-model="form.data[f]"
                :data-field="f"
                type="date"
              />

              <input
                v-else-if="metaOf(f).type === 'number'"
                v-model="form.data[f]"
                :data-field="f"
                type="number"
                :min="metaOf(f).min"
                :step="metaOf(f).step"
                :placeholder="metaOf(f).placeholder"
              />

              <input
                v-else
                v-model="form.data[f]"
                :data-field="f"
                type="text"
                :placeholder="metaOf(f).placeholder"
              />
            </div>
          </template>
        </div>

        <!-- 物料清单（数组字段单独渲染） -->
        <div v-for="f in fields.filter((x) => metaOf(x).type === 'items')" :key="f" class="field">
          <label>
            {{ metaOf(f).label }}
            <span v-if="metaOf(f).required" class="req">*</span>
          </label>
          <div
            v-for="(row, i) in form.data[f] || []"
            :key="i"
            style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center"
          >
            <input v-model="row.name" :data-item="i" type="text" placeholder="物料名称" style="flex: 2" />
            <input v-model="row.qty" :data-item-qty="i" type="number" min="1" step="1" placeholder="数量" style="flex: 1" />
            <button class="btn btn-sm btn-danger" type="button" @click="removeItem(i)">删除</button>
          </div>
          <button class="btn btn-sm" type="button" @click="addItem">+ 添加一项</button>
        </div>

        <div class="form-actions">
          <button class="btn" :disabled="saving" @click="save({ submitNow: false })">存为草稿</button>
          <button class="btn btn-primary" :disabled="saving" @click="save({ submitNow: true })">
            {{ saving ? '提交中…' : '保存并提交审批' }}
          </button>
        </div>
      </div>

      <div class="alert alert-info" style="font-size: 12.5px">
        提交后流程会按<b>当前启用</b>的模板解析出审批人，并把流程步骤<b>快照</b>进这张单据。
        之后管理员改模板，也不会影响在途单据 —— 这是真实 OA 必须有的行为。
      </div>
    </template>
  </div>
</template>
