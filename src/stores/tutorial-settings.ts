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

/**
 * 教学局的苏军首回合移动力开关（用户 2026-11-19 第 6 条）
 *
 * 剧本专规「苏军首回合地面单位 ×1/2 MA」叠加反应阶段 ×1/2 后，18 Tk Div 只剩 2 MP，
 * 连 8.1a 的 3 MP 突袭门槛都够不到，反应阶段就无法安排一次合法的苏军进攻。
 * 教学局关掉这一条**剧本专规**（不是通用规则），让反击能真实发生；
 * 引擎的突袭/战斗判定一条不改。
 */
export const tutorialSovietFirstTurnFullMa = ref(false)

export function setTutorialSovietFirstTurnFullMa(on: boolean): void {
  tutorialSovietFirstTurnFullMa.value = on
}
