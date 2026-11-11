/**
 * U1-b：会话步骤门的注入键
 *
 * `MapDock` 在宿主席（地图会话框）里 provide 当前**唯一待决事项**；
 * 面板里的 `<SessionStep :item="…">` 只在 id 命中时渲染。
 *
 * 没有宿主 provide 时（引擎验证页 / 右栏只读面板）门自动放行 —— 那里照旧全量渲染，
 * 不受"一次一件事"的对局台纪律约束。
 */

import type { ComputedRef, InjectionKey } from 'vue'

import type { SessionStepItem } from '@/stores/session-steps'

export const SESSION_STEP_GATE: InjectionKey<ComputedRef<SessionStepItem | null>> =
  Symbol('session-step-gate')

/**
 * 批二：**是否有宿主**（对局台 dock 为 true；验证页 / 右栏不 provide）
 *
 * 只靠 `SESSION_STEP_GATE` 无法区分「没有宿主」和「宿主当前无待决」：
 * 两者都表现为 `null`，旧逻辑一律全量渲染，导致无待决时整块面板铺满（用户截图）。
 */
export const SESSION_STEP_HOSTED: InjectionKey<boolean> = Symbol('session-step-hosted')
