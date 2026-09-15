import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    // 5273 避开 job-hunter 的 5173 / api-test-platform 的 5173
    port: 5273,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3200', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:3200', changeOrigin: true },
    },
  },
  build: {
    target: 'es2018',
    chunkSizeWarningLimit: 1500,
  },
})
