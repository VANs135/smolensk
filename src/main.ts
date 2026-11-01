import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import '@/styles/base.css'
import { useWorkbenchStore } from '@/stores/workbench'

/**
 * 应用装配（Global Step 00：脚手架）
 *
 * 顺序：创建应用 → 挂 Pinia → 挂根组件。
 * 数据加载管线（校验→冻结→类型）在接入 src/data/index.ts 后于此扩展。
 */
const app = createApp(App)

const pinia = createPinia()
app.use(pinia)
// 盘面持久化与阶段执行器属于应用装配，不能依赖用户是否曾打开对局台。
useWorkbenchStore(pinia)

app.mount('#app')
