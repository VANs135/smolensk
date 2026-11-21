/**
 * workbench-air-state.ts —— C9 空军状态原语（14.0 开关 / 15.x 收束 / 统一收引擎结论）
 *
 * B3-2b20（2026-11-21）：从 facade 的 C9 段搬出 3 个声明 / 40 行，函数体**零改写**：
 * `setAirActive`（14.0 开关）/ `clearAir`（15.x 中间态收束）/ `acceptAir`（引擎结论统一入口）。
 *
 * ## 装配点放在 `} = airDomain` 之后（与 b17 相反的选择）
 *   这三个函数读写 11 个 air 域状态与 `airMissionDomain`，它们全部来自 air 域解构（2469–2595）。
 *   把装配点放到解构之后 ⇒ 一律**按值**传、**零** `deps.` 改写；反之（放在 air 域之前）要 12 个 getter
 *   加 15 处前缀改写。`createAirInputs` 由 `./workbench-model` 直接 import，不占端口。
 *
 * ## 两端的边界
 *   前：air 域 deps（建域点 2355）原本按值吃这两个 `function` 声明（提升）；搬走后提升消失，
 *   facade 侧那两处已改**转发箭头**（`acceptAir` 是泛型，箭头显式写 `<T>`），建域期只构造不求值。
 *   后：`setAirActive` / `clearAir` 是 store 公开面；`acceptAir` 不在公开面，但 facade 的
 *   `accept*` 调用点（13253 / 13327）要用 ⇒ 3 项全 return。
 *
 * ## 端口（16 项 = 13 依赖 + 3 返回）
 */

import type { Ref } from 'vue'
import type { HexRef } from '@/data'
import type {
  AirBaseReductionPlan,
  AirInteractionState,
  BaseRefitPlan,
  BaseTransferPlan,
} from '@/engine/rules'
import type { Derivation } from '@/engine/derivation'
import type { RuleOutcome } from '@/engine/result-types'
import { createAirInputs, type AirInputs, type WorkbenchLogEntry } from './workbench-model'

/** C9 空军状态域的端口（16 项 = 13 依赖 + 3 返回，2026-11-21 实测）。 */
export interface AirStateDeps {
  airActive: Ref<boolean>
  airMissionAirIds: Ref<string[]>
  airMissionAbortPending: Ref<boolean>
  airTargetHex: Ref<HexRef | null>
  airInputs: Ref<AirInputs>
  airState: Ref<AirInteractionState | null>
  airError: Ref<{ rule: string; reason: string } | null>
  lastRefit: Ref<BaseRefitPlan | null>
  lastTransfer: Ref<BaseTransferPlan | null>
  lastReduction: Ref<AirBaseReductionPlan | null>
  refitTargetBaseId: Ref<string | null>
  airMissionDomain: { canReplace(): boolean }
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
}

export function createAirStateDomain(deps: AirStateDeps) {
  const {
    airActive,
    airMissionAirIds,
    airMissionAbortPending,
    airTargetHex,
    airInputs,
    airState,
    airError,
    lastRefit,
    lastTransfer,
    lastReduction,
    refitTargetBaseId,
    airMissionDomain,
    pushLog,
  } = deps

  /** C9：开/关空军工具（开启时清空上一场；基地声明与飞机保留） */
  function setAirActive(on: boolean): void {
    if (!airMissionDomain.canReplace()) return
    airActive.value = on
    clearAir()
    pushLog('info', on ? '空军工具已开启（14.0 / 15.0 章）' : '空军工具已关闭', '14.0')
  }

  /** C9：清空本次空军交互（飞机与基地声明保留；换方/换阶段/重置/关闭时调用） */
  function clearAir(): void {
    if (!airMissionDomain.canReplace()) return
    airMissionAirIds.value = []
    airMissionAbortPending.value = false
    airTargetHex.value = null
    airInputs.value = { ...airInputs.value, targetHexText: '' }
    airState.value = null
    airError.value = null
    lastRefit.value = null
    lastTransfer.value = null
    lastReduction.value = null
    // 15.1：整备交互的中间态一并收束（选飞机 / 选补给）
    refitTargetBaseId.value = null
    // 保留「天气是否允许飞行」等盘面事实，其余玩家输入复位
    airInputs.value = {
      ...createAirInputs(),
      flyingAllowed: airInputs.value.flyingAllowed,
      weatherNormal: airInputs.value.weatherNormal,
    }
  }

  /** C9：统一收引擎结论（失败即记 `airError` 与日志并返回 null） */
  function acceptAir<T>(outcome: RuleOutcome<T>, action: string): T | null {
    if (outcome.ok) {
      airError.value = null
      return outcome.data
    }
    airError.value = { rule: outcome.rule, reason: outcome.reason }
    pushLog('danger', `${action}被拒绝：${outcome.reason}（${outcome.rule}）`, outcome.rule)
    return null
  }
  return {
    setAirActive,
    clearAir,
    acceptAir,
  }
}
