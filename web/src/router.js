import { createRouter, createWebHistory } from 'vue-router'
import { isLoggedIn } from './store.js'

import Home from './views/Home.vue'
import Login from './views/Login.vue'
import Todo from './views/Todo.vue'
import Requests from './views/Requests.vue'
import RequestNew from './views/RequestNew.vue'
import RequestDetail from './views/RequestDetail.vue'
import Departments from './views/Departments.vue'
import Users from './views/Users.vue'
import Flows from './views/Flows.vue'
import Announcements from './views/Announcements.vue'
import AuditLogs from './views/AuditLogs.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: Login },

    { path: '/', component: Home },
    { path: '/todo', component: Todo },

    { path: '/requests', component: Requests },
    { path: '/requests/new', component: RequestNew }, // 放在 :id 之前，避免 /new 被当成 id
    { path: '/requests/:id', component: RequestDetail },

    { path: '/departments', component: Departments },
    { path: '/users', component: Users },
    { path: '/flows', component: Flows },
    { path: '/announcements', component: Announcements },
    { path: '/audit-logs', component: AuditLogs },

    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

/**
 * 守卫只做一件事：**没登录就赶去登录页**。
 *
 * 刻意不做「按权限拦路由」——因为前端拦不拦都不影响安全（后端每个接口都独立校验），
 * 而放行之后页面会显示后端真实返回的 403「缺少权限：user:read」，
 * 这比前端悄悄跳转更有价值：**越权这件事看得见**。
 * 菜单项仍然按权限隐藏，那是为了整洁，不是安全。
 */
router.beforeEach((to) => {
  if (to.path === '/login') {
    return isLoggedIn() ? { path: '/' } : true
  }
  if (!isLoggedIn()) {
    return { path: '/login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
  }
  return true
})

export default router
