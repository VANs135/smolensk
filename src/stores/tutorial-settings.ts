import { ref } from 'vue'

/**
 * Vitebsk 教学模式的**开局事实开关**（用户 2026-11-18 第 2 条）
 *
 * 教学局允许把空军盒内的飞机设为未激活，好让「去盒里整备（14.1a）」这一步有真实对象。
 * 这是**开局数据的取舍**，不是规则改动：判定仍走 `planAirSetup` / `refitAirBox` 原路。
 *
 * 单独成模块（不放进任何 store）是为了让 `setup` 与 `tutorial` 都能读，又不会互相 import 成环。
 */
export const tutorialAirAllInactive = ref(false)

export function setTutorialAirAllInactive(on: boolean): void {
  tutorialAirAllInactive.value = on
}
