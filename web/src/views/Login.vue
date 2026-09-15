<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api.js'
import { setSession } from '../store.js'

const route = useRoute()
const router = useRouter()

const form = reactive({ username: '', password: '' })
const loading = ref(false)
const error = ref('')

// 演示环境的账号清单（全为虚构人物）。点一下直接填表，
// 因为验收要「两个浏览器窗口分别用申请人和审批人登录」，手打 8 个用户名太烦。
const DEMO = [
  { u: 'admin', n: '张北', r: '总经理' },
  { u: 'hr01', n: '李南', r: '人事' },
  { u: 'ops01', n: '王东', r: '运营经理' },
  { u: 'ops02', n: '赵西', r: '员工' },
  { u: 'ops03', n: '孙小', r: '员工' },
  { u: 'exe01', n: '周大', r: '执行经理' },
  { u: 'exe02', n: '吴小', r: '员工' },
  { u: 'gy01', n: '郑无', r: '无上级' },
]

const DEMO_PASSWORD = 'oa123456'

const expiredHint = computed(() => route.query.expired === '1')

onMounted(() => {
  if (expiredHint.value) error.value = '登录状态已失效（token 过期或账号被停用），请重新登录。'
})

function fill(username) {
  form.username = username
  form.password = DEMO_PASSWORD
  error.value = ''
}

async function onLogin() {
  error.value = ''
  if (!form.username || !form.password) {
    error.value = '请输入用户名和密码'
    return
  }
  loading.value = true
  try {
    const res = await api.login(form.username.trim(), form.password)
    setSession(res.token, res.user)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    router.push(redirect)
  } catch (e) {
    error.value = e.message || '登录失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-left">
        <h1>星野 OA</h1>
        <p class="tagline">
          一个专门用来「被测试」的办公审批系统。<br />
          不是又一个管理系统，而是一个理想的被测系统。
        </p>
        <ul>
          <li>登录鉴权 · 组织架构 · RBAC 权限</li>
          <li>多级审批 · 或签 / 会签 · 流程快照</li>
          <li>状态机 · 并发抢单 · 越权防线</li>
        </ul>
      </div>

      <div class="login-right">
        <h2 style="font-size: 17px; margin-bottom: 4px">登录</h2>
        <p style="font-size: 12.5px; color: var(--text-3); margin: 0 0 16px">
          演示数据全部虚构，仅在本机运行
        </p>

        <div v-if="error" class="alert alert-error">{{ error }}</div>

        <form @submit.prevent="onLogin">
          <div class="field">
            <label>用户名<span class="req">*</span></label>
            <input
              v-model="form.username"
              data-t="username"
              type="text"
              autocomplete="username"
              placeholder="如 ops02"
            />
          </div>
          <div class="field">
            <label>密码<span class="req">*</span></label>
            <input
              v-model="form.password"
              data-t="password"
              type="password"
              autocomplete="current-password"
              placeholder="统一密码 oa123456"
              @keyup.enter="onLogin"
            />
          </div>
          <button class="btn btn-primary" type="submit" :disabled="loading" style="width: 100%">
            {{ loading ? '登录中…' : '登 录' }}
          </button>
        </form>

        <div class="demo-accounts">
          <div class="hint">
            快速填充演示账号（密码统一 <code>oa123456</code>）——
            验证审批链路时，用<b>两个浏览器窗口</b>分别登申请人和审批人
          </div>
          <div class="demo-btns">
            <button v-for="d in DEMO" :key="d.u" type="button" @click="fill(d.u)">
              {{ d.u }} · {{ d.n }}（{{ d.r }}）
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
