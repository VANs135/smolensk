/**
 * workbench-air-primitives.ts —— C9 空军原语（14.1a 激活 / 14.1b 损失 / 14.2e 已飞标记 / 掷骰）
 *
 * B3-2b19（2026-11-21）：从 facade 的 C9 段搬出 7 个声明 / 57 行，函数体**零改写**：
 * `setAirStatus` / `applyAirStepLoss` / `markAirMissionFlown` / `toggleAirUnitStatus` /
 * `drawAir2d6` / `drawAir1d6` / `drawD6`。
 *
 * ## 为什么装配点必须在这（air 域之前）
 *   `createAirDomain` 的 deps **按值**吃 `setAirStatus` / `markAirMissionFlown` / `drawAir2d6` /
 *   `applyAirStepLoss` / `drawAir1d6`（建域即求值）⇒ 本切片必须先建好；而更早的 fire 域
 *   （`createFireResolutionDomain`）也按值吃 `applyAirStepLoss` ⇒ facade 侧那一处改成转发箭头。
 *
 * ## 端口（13 项 = 6 依赖 + 7 返回）
 *   按值 5：`airUnits` / `rng` / `drawCount` / `pushLog` / `eliminateEntry`（后两者是 `function` 声明，提升）。
 *   转发箭头 1：`airStatusLabel`——它来自 air 域解构、晚于本装配点，包一层箭头把求值推迟到调用期。
 *   7 个函数 facade 内部仍要用 ⇒ 全部 return。
 */

import type { Ref, WritableComputedRef } from 'vue'
import type { AirStatus, RngState } from '@/engine/state-types'
import { roll1d6, roll2d6 } from '@/engine/rng'
import type { Derivation } from '@/engine/derivation'
import type { ConsoleAirUnit, DeadPileEntry, WorkbenchLogEntry } from './workbench-model'

/** C9 空军原语域的端口（13 项 = 6 依赖 + 7 返回，2026-11-21 实测）。 */
export interface AirPrimitiveDeps {
  airUnits: Ref<ConsoleAirUnit[]>
  rng: WritableComputedRef<RngState>
  drawCount: WritableComputedRef<number>
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  eliminateEntry: (entry: DeadPileEntry, rule: string, text: string, refresh?: boolean) => void
  /** air 域解构，晚于装配点 ⇒ 转发箭头 */
  airStatusLabel: (status: AirStatus) => string
}

export function createAirPrimitivesDomain(deps: AirPrimitiveDeps) {
  const { airUnits, rng, drawCount, pushLog, eliminateEntry, airStatusLabel } = deps

  /** C9：14.1a 激活状态写盘（整备 ⇒ 激活；返航 ⇒ 非激活） */
  function setAirStatus(instanceId: string, status: AirStatus): void {
    const air = airUnits.value.find((item) => item.instanceId === instanceId)
    if (air !== undefined) air.airStatus = status
  }

  /** C9：14.1b 军力损失（每机 2 点；损失第二点即摧毁并**移入死亡堆**——与地面单位同一个堆） */
  function applyAirStepLoss(instanceId: string): void {
    const air = airUnits.value.find((item) => item.instanceId === instanceId)
    if (air === undefined) return
    air.steps -= 1
    if (air.steps > 0) {
      pushLog('warning', `${air.name} 损失 1 点军力（14.1b；现 ${air.steps} 点）`, '14.1b')
      return
    }
    // 与其他淘汰点同一入口：原先这里只把飞机从 airUnits 里滤掉，死亡堆里查不到它
    eliminateEntry(air, '14.1b', `${air.name} 军力归零，移入死亡堆（14.1b）`)
  }

  /** C9：14.2e 标记该机本阶段已执行过任务 */
  function markAirMissionFlown(instanceId: string): void {
    const air = airUnits.value.find((item) => item.instanceId === instanceId)
    if (air !== undefined) air.missionsFlownThisPhase += 1
  }

  /** C9：手改某机的激活状态（部署/演示用；规则上的转换由整备 15.1 与返航 14.1c 驱动） */
  function toggleAirUnitStatus(instanceId: string): boolean {
    const air = airUnits.value.find((item) => item.instanceId === instanceId)
    if (air === undefined) return false
    air.airStatus = air.airStatus === 'active' ? 'inactive' : 'active'
    pushLog('info', `${air.name} → ${airStatusLabel(air.airStatus)}`, '14.1a')
    return true
  }

  /** C9：掷 2 骰（14.4e 防空 / 14.3e 拦截空战），并推进 rng 与计数 */
  function drawAir2d6(): number {
    const draw = roll2d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    return draw.value.total
  }

  /** C9：掷 1 骰（14.4f 的损失归属骰 / 14.3e-C 的损失骰） */
  function drawAir1d6(): number {
    const draw = roll1d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    return draw.value.total
  }

  /** 9.14：掷 1 骰（9.14b/c 夺取表；与其余掷骰同源，走 `state.rng` 可复算） */
  function drawD6(): number {
    const draw = roll1d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    return draw.value.total
  }
  return {
    setAirStatus,
    applyAirStepLoss,
    markAirMissionFlown,
    toggleAirUnitStatus,
    drawAir2d6,
    drawAir1d6,
    drawD6,
  }
}
