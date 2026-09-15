<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from './api.js'
import { can, clearSession, session } from './store.js'

const route = useRoute()
const router = useRouter()

const active = computed(() => route.path)
const user = computed(() => session.user)

// 待办角标：进页面拉一次，之后每次切换路由再刷一次（本地 SQLite，成本可忽略）。
// 目的很实际 —— 审批人得一眼看到「有几单等我」。
const todoCount = ref(0)

async function refreshTodo() {
  if (!session.token) {
    todoCount.value = 0
    return
  }
  try {
    const res = await api.todo()
    todoCount.value = res.total ?? (res.items || []).length
  } catch {
    todoCount.value = 0 // 角标失败不该打扰用户
  }
}

onMounted(refreshTodo)
watch(() => route.path, refreshTodo)

async function onLogout() {
  try {
    await api.logout()
  } catch {
    // 登出接口只是记一条审计，失败也不该卡住用户
  }
  clearSession()
  router.push('/login')
}

const isActive = (path) => active.value === path
const isPrefix = (path) => active.value === path || active.value.startsWith(path + '/')

// 登录页不套 App 外壳。否则登录卡片左边会多出一条侧边栏（而且它还会渲染出导航链接，
// 因为菜单项是按权限 v-if 的，登录页没有用户，员工级的项照样全出来）。
const isLogin = computed(() => route.path === '/login')
</script>

<template>
  <!-- 登录页：整屏，无侧边栏、无内容内边距 -->
  <router-view v-if="isLogin" />

  <div v-else class="app">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-dot"></span>
        <span>
          星野 OA
          <small>办公审批系统 · 演示环境</small>
        </span>
      </div>

      <nav class="nav">
        <div class="nav-group">
          <div class="nav-group-title">工作台</div>
          <router-link to="/" class="nav-item" :class="{ active: isActive('/') }">总览</router-link>
          <router-link to="/todo" class="nav-item" :class="{ active: isActive('/todo') }">
            <span>我的待办</span>
            <span v-if="todoCount" class="nav-badge">{{ todoCount }}</span>
          </router-link>
        </div>

        <div class="nav-group">
          <div class="nav-group-title">单据</div>
          <router-link to="/requests" class="nav-item" :class="{ active: isPrefix('/requests') }">
            单据中心
          </router-link>
          <router-link to="/requests/new" class="nav-item" :class="{ active: isActive('/requests/new') }">
            新建单据
          </router-link>
        </div>

        <div class="nav-group">
          <div class="nav-group-title">组织与流程</div>
          <router-link to="/departments" class="nav-item" :class="{ active: isActive('/departments') }">
            部门架构
          </router-link>
          <router-link v-if="can('user:read')" to="/users" class="nav-item" :class="{ active: isActive('/users') }">
            员工管理
          </router-link>
          <router-link v-if="can('flow:read')" to="/flows" class="nav-item" :class="{ active: isActive('/flows') }">
            流程模板
          </router-link>
        </div>

        <div class="nav-group">
          <div class="nav-group-title">其他</div>
          <router-link to="/announcements" class="nav-item" :class="{ active: isActive('/announcements') }">
            公告
          </router-link>
          <router-link
            v-if="can('audit:read')"
            to="/audit-logs"
            class="nav-item"
            :class="{ active: isActive('/audit-logs') }"
          >
            审计日志
          </router-link>
        </div>
      </nav>

      <div class="sidebar-footer">
        <div v-if="user">
          <div style="color: var(--text-2); font-weight: 600">{{ user.realName }} · {{ user.position || '—' }}</div>
          <div>{{ user.deptName || '未分配部门' }}</div>
          <div style="margin-top: 4px">
            <span v-for="r in user.roles" :key="r" class="chip gray">{{ r }}</span>
          </div>
          <button class="btn btn-sm" style="width: 100%; margin-top: 8px" @click="onLogout">退出登录</button>
        </div>
      </div>
    </aside>

    <main class="content">
      <router-view :key="route.fullPath" />
    </main>
  </div>
</template>
