/**
 * 15.4 / 13.8d：工程兵缩减基地的**施工额度**守卫
 *
 * `reduceBaseNow` 只走 15.4 的 `canReduceAirBase`（RE/工程能力/距离），不读
 * `constructionLedgers`；于是一名 HQ 可以先建基地/工事，再缩另一个基地，或连续缩两个基地，
 * 绕过 13.8d「只能在一个格内、只能一种建造」。守卫把施工域的闸门与账本接到 15.4 入口。
 */
import type { RuleFailure } from '@/engine/result-types'

import type { HexRef } from '@/data'

import type { ConsoleUnit } from './workbench-model'

export interface AirReductionLedgerGuardDeps {
  /** 本基地当前合法的 15.4 候选（已含 2 格工程兵路线） */
  candidates: (baseId: string) => readonly ConsoleUnit[]
  /** 全局 `reductionUnitIds`（可能残留别基地的指定） */
  selectedIds: () => readonly string[]
  engineerCapableNow: (unit: ConsoleUnit) => boolean
  baseHexOf: (baseId: string) => HexRef | null
  /** 15.4 原实现（只判 RE/工程能力/距离/基地等级） */
  reduce: (baseId: string) => boolean
  /** 15.4 原预检（不含 13.8d 额度） */
  missing: (baseId: string) => string | null
  gate: (task: 'reduceAirBase', engineer: ConsoleUnit | null) => RuleFailure | null
  note: (task: 'reduceAirBase', hex: HexRef, engineerId: string) => void
  log: (kind: 'warning', text: string, rule: string) => void
  text: (failure: RuleFailure) => string
}

export function createAirReductionLedgerGuard(deps: AirReductionLedgerGuardDeps) {
  /** 被指定且真正走工程能力路线的执行者；纯 1RE 战斗小队不受 13.8d 账本约束 */
  function reductionEngineer(baseId: string): ConsoleUnit | null {
    const selected = deps.selectedIds()
    return (
      deps
        .candidates(baseId)
        .find((unit) => selected.includes(unit.instanceId) && deps.engineerCapableNow(unit)) ?? null
    )
  }

  function reduceBaseNow(baseId: string): boolean {
    const engineer = reductionEngineer(baseId)
    if (engineer !== null) {
      const gate = deps.gate('reduceAirBase', engineer)
      if (gate !== null) {
        deps.log('warning', `缩减基地被拒（13.8d）：${deps.text(gate)}（${gate.rule}）`, gate.rule)
        return false
      }
    }
    const ok = deps.reduce(baseId)
    if (ok && engineer !== null) {
      const hex = deps.baseHexOf(baseId)
      if (hex !== null) deps.note('reduceAirBase', hex, engineer.instanceId)
    }
    return ok
  }

  function airReductionMissing(baseId: string): string | null {
    const missing = deps.missing(baseId)
    if (missing !== null) return missing
    const engineer = reductionEngineer(baseId)
    if (engineer === null) return null
    const gate = deps.gate('reduceAirBase', engineer)
    return gate === null ? null : `还差：${deps.text(gate)}（${gate.rule}）`
  }

  return { reduceBaseNow, airReductionMissing }
}
