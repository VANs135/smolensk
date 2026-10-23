import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import '@/styles/base.css'

/**
 * 应用装配（Global Step 00：脚手架）
 *
 * 顺序：创建应用 → 挂 Pinia → 挂根组件。
 * 数据加载管线（校验→冻结→类型）在接入 src/data/index.ts 后于此扩展。
 */
const app = createApp(App)

app.use(createPinia())

app.mount('#app')
