<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api.js'
import { can, session, setUser } from '../store.js'

// 角色清单：M1 后端刻意没有 /api/roles 接口（权限管理界面砍到二期），所以先写死。
// M2 加了权限管理界面后改成从接口取，这里留个 TODO 是诚实的做法。
const ROLE_OPTIONS = [
  { code: 'boss', name: '总经理（全权限）' },
  { code: 'hr', name: '人事（组织+员工+公告+看全部单据）' },
  { code: 'dept_manager', name: '部门经理' },
  { code: 'employee', name: '员工' },
]

const loading = ref(true)
const error = ref('')
const errStatus = ref(0)
const items = ref([])
const depts = ref([])

const filters = reactive({ q: '', deptId: '', status: '' })

const canWrite = computed(() => can('user:write'))

const drawer = reactive({ open: false, mode: 'create', id: null })
const form = reactive({
  username: '',
  password: '',
  realName: '',
  deptId: '',
  position: '',
  managerId: '',
  status: 'active',
  roles: [],
})
const saving = ref(false)
const formError = ref('')

async function load() {
  loading.value = true
  error.value = ''
  errStatus.value = 0
  try {
    const [u, d] = await Promise.all([api.users.list({ ...filters }), api.departments.list(true)])
    items.value = u.items || []
    depts.value = d.items || []
  } catch (e) {
    error.value = e.message
    errStatus.value = e.status || 0
    items.value = []
  } finally {
    loading.value = false
  }
}

onMounted(load)

const deptName = (id) => depts.value.find((d) => d.id === id)?.name || '—'
const managerName = (id) => items.value.find((u) => u.id === id)?.realName || (id ? `#${id}` : '—')

function reset() {
  form.username = ''
  form.password = ''
  form.realName = ''
  form.deptId = ''
  form.position = ''
  form.managerId = ''
  form.status = 'active'
  form.roles = []
}

function openCreate() {
  reset()
  drawer.open = true
  drawer.mode = 'create'
  drawer.id = null
  formError.value = ''
}

function openEdit(u) {
  reset()
  drawer.open = true
  drawer.mode = 'edit'
  drawer.id = u.id
  form.realName = u.realName || ''
  form.deptId = u.deptId == null ? '' : String(u.deptId)
  form.position = u.position || ''
  form.managerId = u.managerId == null ? '' : String(u.managerId)
  form.status = u.status || 'active'
  form.roles = Array.isArray(u.roles) ? [...u.roles] : []
  formError.value = ''
}

function close() {
  drawer.open = false
  formError.value = ''
}

function toggleRole(code) {
  const i = form.roles.indexOf(code)
  if (i >= 0) form.roles.splice(i, 1)
  else form.roles.push(code)
}

async function save() {
  formError.value = ''
  // 前端先拦必填，别让用户点一次保存才知道缺什么（后端仍会再校验）
  if (drawer.mode === 'create') {
    if (!form.username.trim()) return (formError.value = '用户名必填')
    if (!form.realName.trim()) return (formError.value = '姓名必填')
    if (form.password.length < 6) return (formError.value = '密码至少 6 位')
  } else if (!form.realName.trim()) {
    return (formError.value = '姓名必填')
  }

  saving.value = true
  try {
    if (drawer.mode === 'create') {
      await api.users.create({
        username: form.username.trim(),
        password: form.password,
        realName: form.realName.trim(),
        deptId: form.deptId === '' ? null : Number(form.deptId),
        position: form.position.trim(),
        managerId: form.managerId === '' ? null : Number(form.managerId),
        roles: form.roles,
      })
    } else {
      await api.users.update(drawer.id, {
        realName: form.realName.trim(),
        deptId: form.deptId === '' ? null : Number(form.deptId),
        position: form.position.trim(),
        managerId: form.managerId === '' ? null : Number(form.managerId),
        status: form.status,
        roles: form.roles,
      })
    }
    close()
    await load()

    // 如果改的是自己，权限可能变了（比如被停用），同步刷新本地会话
    if (drawer.mode === 'edit' && drawer.id === session.user?.id) {
      try {
        setUser(await api.me())
      } catch {
        // 自己已经被停用 → api 层已把会话清掉并跳登录页，这里什么都不用做
      }
    }
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
        <h1 class="page-title">员工管理</h1>
        <p class="page-desc">
          需要 <code class="t-mono">user:read</code> 权限。普通员工打开这个页面会拿到后端的 403。
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="load">刷新</button>
        <button v-if="canWrite" class="btn btn-primary" @click="openCreate">+ 新增员工</button>
      </div>
    </div>

    <!-- 403 用后端原话展示：这就是纵向越权的现场 -->
    <div v-if="errStatus === 403" class="card">
      <div class="alert alert-warn" style="margin-bottom: 0">
        <b>HTTP 403</b> · {{ error }}
      </div>
      <p class="t-muted" style="font-size: 12.5px; margin-bottom: 0">
        这是后端的纵向越权防线。换成 <code class="t-mono">hr01</code> 或 <code class="t-mono">admin</code>
        登录就能正常访问 —— 前端没有把数据藏起来，是后端根本没返回。
      </p>
    </div>

    <template v-else>
      <div v-if="error" class="alert alert-error">{{ error }}</div>

      <div v-if="canWrite" class="card">
        <div class="inline-form">
          <div class="field">
            <label>搜索</label>
            <input v-model="filters.q" type="text" placeholder="用户名或姓名" @keyup.enter="load" />
          </div>
          <div class="field">
            <label>部门</label>
            <select v-model="filters.deptId" @change="load">
              <option value="">全部部门</option>
              <option v-for="d in depts" :key="d.id" :value="String(d.id)">{{ d.name }}</option>
            </select>
          </div>
          <div class="field">
            <label>状态</label>
            <select v-model="filters.status" @change="load">
              <option value="">全部</option>
              <option value="active">在职</option>
              <option value="disabled">已停用</option>
            </select>
          </div>
          <div class="field" style="flex: 0 0 auto">
            <button class="btn" @click="load">查询</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>共 {{ items.length }} 人</span>
          <span class="hint">停用账号后，旧 token 下一次请求就会失效（守卫每请求回查状态）</span>
        </div>

        <div v-if="loading" class="empty">加载中…</div>
        <div v-else-if="!items.length" class="empty">没有符合条件的员工</div>
        <div v-else class="table-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th style="width: 56px">ID</th>
                <th style="width: 100px">用户名</th>
                <th style="width: 90px">姓名</th>
                <th style="width: 130px">部门</th>
                <th style="width: 130px">岗位</th>
                <th style="width: 100px">直属上级</th>
                <th>角色</th>
                <th style="width: 76px">状态</th>
                <th v-if="canWrite" style="width: 76px" class="t-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in items" :key="u.id">
                <td class="t-mono t-muted">{{ u.id }}</td>
                <td class="t-mono">{{ u.username }}</td>
                <td>
                  {{ u.realName }}
                  <span v-if="u.id === session.user?.id" class="badge st-draft" style="margin-left: 4px">本人</span>
                </td>
                <td class="t-muted">{{ u.deptName || deptName(u.deptId) }}</td>
                <td class="t-muted">{{ u.position || '—' }}</td>
                <td>
                  <span v-if="u.managerId">{{ u.managerName || managerName(u.managerId) }}</span>
                  <span v-else class="badge st-pending">未配置</span>
                </td>
                <td>
                  <span v-for="r in u.roles" :key="r" class="chip gray t-mono">{{ r }}</span>
                  <span v-if="!u.roles?.length" class="t-muted">—</span>
                </td>
                <td>
                  <span class="badge" :class="u.status === 'active' ? 'st-approved' : 'st-cancelled'">
                    {{ u.status === 'active' ? '在职' : '停用' }}
                  </span>
                </td>
                <td v-if="canWrite" class="t-right">
                  <button class="btn btn-sm" @click="openEdit(u)">编辑</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <template v-if="drawer.open">
      <div class="drawer-mask" @click="close"></div>
      <div class="drawer">
        <div class="drawer-head">
          <span>{{ drawer.mode === 'create' ? '新增员工' : `编辑员工 #${drawer.id}` }}</span>
          <button class="btn-link" @click="close">关闭</button>
        </div>

        <div class="drawer-body">
          <div v-if="formError" class="alert alert-error">{{ formError }}</div>

          <template v-if="drawer.mode === 'create'">
            <div class="field">
              <label>用户名<span class="req">*</span></label>
              <input v-model="form.username" type="text" placeholder="登录用，不可重复（重复返回 409）" />
            </div>
            <div class="field">
              <label>初始密码<span class="req">*</span></label>
              <input v-model="form.password" type="password" placeholder="至少 6 位" />
            </div>
          </template>

          <div class="field">
            <label>姓名<span class="req">*</span></label>
            <input v-model="form.realName" type="text" />
          </div>

          <div class="form-row">
            <div class="field">
              <label>部门</label>
              <select v-model="form.deptId">
                <option value="">未分配</option>
                <option v-for="d in depts" :key="d.id" :value="String(d.id)">{{ d.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>岗位</label>
              <input v-model="form.position" type="text" placeholder="如 内容运营专员" />
            </div>
          </div>

          <div class="field">
            <label>直属上级</label>
            <select v-model="form.managerId">
              <option value="">未配置</option>
              <option v-for="u in items" :key="u.id" :value="String(u.id)">
                {{ u.realName }}（{{ u.username }}）
              </option>
            </select>
            <div class="t-muted" style="font-size: 12px; margin-top: 4px">
              流程里的「直属上级审批」环节就靠它；留空的话，该员工提交这类单据会被流程引擎拒掉
            </div>
          </div>

          <template v-if="drawer.mode === 'edit'">
            <div class="field">
              <label>状态</label>
              <select v-model="form.status">
                <option value="active">在职</option>
                <option value="disabled">停用（旧 token 立即失效）</option>
              </select>
            </div>
          </template>

          <div class="field">
            <label>角色</label>
            <div style="display: flex; flex-direction: column; gap: 6px">
              <label
                v-for="r in ROLE_OPTIONS"
                :key="r.code"
                style="display: flex; align-items: center; gap: 8px; font-weight: 400; font-size: 13px; cursor: pointer"
              >
                <input
                  type="checkbox"
                  style="width: auto"
                  :checked="form.roles.includes(r.code)"
                  @change="toggleRole(r.code)"
                />
                <span class="t-mono">{{ r.code }}</span>
                <span class="t-muted">{{ r.name }}</span>
              </label>
            </div>
            <div class="t-muted" style="font-size: 12px; margin-top: 6px">
              角色决定权限码；改完角色，该用户下一次请求就按新权限执行（不缓存在 token 里）
            </div>
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
