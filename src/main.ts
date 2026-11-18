import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import '@/styles/base.css'
import '@/styles/android.css'
import { applyPlatformAttribute } from '@/shared/platform'
import { useWorkbenchStore } from '@/stores/workbench'
import { useThemeStore } from '@/stores/theme'

/**
 * 应用装配（Global Step 00：脚手架）
 *
 * 顺序：挂平台属性 → 创建应用 → 挂 Pinia → 挂根组件。
 * 平台属性先挂：首帧就能命中 `html[data-platform='android']`，避免闪一下桌面尺度。
 */
applyPlatformAttribute()

const app = createApp(App)

const pinia = createPinia()
app.use(pinia)
// 盘面持久化与阶段执行器属于应用装配，不能依赖用户是否曾打开对局台。
useWorkbenchStore(pinia)
// 主题同样在装配时创建：进店即把 data-theme 挂到根元素，避免首屏闪一下浅色。
useThemeStore(pinia)

app.mount('#app')
