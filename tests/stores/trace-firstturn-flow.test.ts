import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  aircraftChoices,
  useWorkbenchStore,
} from '@/stores'
import { mapLayers } from '@/data'
import { createPinia, setActivePinia } from 'pinia'

import { placeGround } from '../flows/sop-harness'

/**
 * 批 F 切片 5（B49 收尾之①）：**断补状态的逐回合跟踪**（12.8e 首回合 / 12.6h 空投豁免）
 *
 * ## 原文（先读再动）
 *   · **12.8e**：「任何**当前没有追溯补给**的（在此环节中检查追溯补给）……战斗单位，在它们的突围环节中，
 *     如果满足以下条件，则可尝试突围：A) 到有追溯补给的友方单位的路径…… B) 15 格内…… **在一个单位发现
 *     自己没有追溯补给的第一个回合（不是在「吃图上补给」之后，也不是在使用补给储备或树皮汤等特殊的追溯
 *     补给方式之后），上述条件将被免除**，且成功概率会提高，即获得 **+1 的掷骰修正**，并且**运输点数
 *     也允许进行突围**。」
 *   · **12.6h**：「进行计划中的空投（14.10b）的单位，**在被空投那个回合中不需要追溯补给**。」
 *
 * ## 修前的病灶（本轮要修的）
 *   `breakoutVerdictOf` 把「首回合」写成 `firstTurnOutOfSupply: !unit.hasTraceSupply`（`workbench.ts:6532`）
 *   —— 那是"**此刻**没有追溯补给"，于是**任何**断补单位永远自动免除 A/B 条件并白拿 +1 DRM，12.8e 的
 *   A/B 两条在实战中等于从未生效。
 *
 * ## 测法边界（如实交代）
 *   · 用真实单位库与真实地图格（不造数）；结论全部走 store 的视图与引擎判据；
 *   · 「第一个回合」的判据落在 `ConsoleUnit.cutSinceTurn`（**连续无补给的起点回合**）——本文件钉它，
 *     而不是钉某个界面文案；
 *   · 12.6h 的「被空投那个回合」按**回合**比（`airDropExemptTurn === turn`），跨回合的豁免期结束；
 *   · **不覆盖**界面（仓库无组件渲染测试）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 六邻皆图内的格：断补/突围现场避开地图形状的干扰 */
const CORE_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 摆一个**没有追溯补给**的轴方战斗单位（不声明任何补给源 ⇒ 12.6 判定为断补） */
function strandedUnit(hex: HexRef = CORE_HEX, instanceId = 'u1') {
  const record = unitChoices('axis').find((item) => item.isCombat === true && item.attackCapable)
  if (record === undefined) throw new Error('轴方单位库里没有战斗单位')
  return toConsoleUnit({ record, instanceId, hex, side: 'axis' })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('12.8e：断补「第一个回合」的真跟踪（修前恒为首回合）', () => {
  it('★ 首次断补 ⇒ cutSinceTurn ＝ 当前回合，突围免除 A/B 且 +1 DRM', () => {
    const store = newStore()
    store.setPhase('movement')
    const unit = strandedUnit()
    store.units.push(unit)

    const outOfSupply = store.evaluateTraceSupplyNow()
    expect(outOfSupply).toBeGreaterThan(0)
    expect(unit.hasTraceSupply).toBe(false)
    expect(unit.cutSinceTurn).toBe(store.turn)

    // 现场刻意**不给** A/B 的任何事实（附近没有有追溯补给的友军）⇒ 只有首回合豁免才能放行
    const candidate = store.breakoutCandidates.find((item) => item.unit.instanceId === 'u1')
    expect(candidate?.ok).toBe(true)
    expect(candidate?.detail ?? '').toContain('首回合')
  })

  it('★ 换回合后仍在断补 ⇒ 不再算首回合：A/B 不成立即拒（12.8e）', () => {
    const store = newStore()
    store.setPhase('movement')
    const unit = strandedUnit()
    store.units.push(unit)
    store.evaluateTraceSupplyNow()
    expect(unit.cutSinceTurn).toBe(store.turn)

    const firstTurn = store.turn
    store.setTurn(firstTurn + 1)
    store.setPhase('movement') // 进入移动段 ⇒ 自动重判（12.6）
    expect(unit.hasTraceSupply).toBe(false)
    // 计数**不变**：它仍然是从那个回合起连续断补
    expect(unit.cutSinceTurn).toBe(firstTurn)

    const candidate = store.breakoutCandidates.find((item) => item.unit.instanceId === 'u1')
    expect(candidate?.ok).toBe(false)
    expect(candidate?.reason ?? '').toContain('12.8e')
    // 突围动作同样被拒（闸门之外，判据仍在 12.8e）
    expect(store.breakoutNow('u1')).toBe(false)
  })

  it('★ 恢复补给 ⇒ 计数清零；再次断补 ⇒ 重新从"首回合"算起', () => {
    const store = newStore()
    store.setPhase('movement')
    const unit = strandedUnit()
    store.units.push(unit)
    store.evaluateTraceSupplyNow()
    const firstCut = store.turn
    expect(unit.cutSinceTurn).toBe(firstCut)

    // 12.6a①：同格声明一个补给源 ⇒ 恢复追溯补给
    store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
    expect(store.addSupplySource()).toBe(true)
    expect(store.evaluateTraceSupplyNow()).toBe(0)
    expect(unit.hasTraceSupply).toBe(true)
    expect(unit.cutSinceTurn).toBe(null)

    // 撤掉源 ⇒ 再次断补：从**新的**回合重新算首回合
    const declaration = store.supplySourceDecls[0]
    expect(declaration).toBeDefined()
    store.removeSupplySource(declaration!.id)
    store.setTurn(firstCut + 3)
    store.evaluateTraceSupplyNow()
    expect(unit.hasTraceSupply).toBe(false)
    expect(unit.cutSinceTurn).toBe(firstCut + 3)
    const candidate = store.breakoutCandidates.find((item) => item.unit.instanceId === 'u1')
    expect(candidate?.ok).toBe(true)
  })

  it('★ 12.8e 括注：当回合靠「吃图上补给」续命 ⇒ 该回合不算"被切断的第一个回合"', () => {
    const store = newStore()
    const unit = strandedUnit()
    store.units.push(unit)
    store.setPhase('supply')
    const index = store.playerSegmentSteps.findIndex((step) => step.id.startsWith('supply.'))
    expect(store.setSegmentStepIndex(index)).toBe(true)

    // 12.1b：喂食要有粮 ⇒ 同格摆一座补给站
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 2, t: 0 }
    expect(store.addSpDump()).toBe(true)
    // 12.6c：自愿吃图上补给（面板勾选后才进计划）
    store.supplyPhaseInputs = {
      ...store.supplyPhaseInputs,
      availableT: 4,
      eatOffTheMap: { u1: true },
    }
    expect(store.planSupplyPhaseNow()).toBe(true)
    expect(store.applySupplyPhaseFeedingNow()).toBe(true)
    // 喂饱 ⇒ 该回合不是断补；且按括注，这一回合**不算**"被切断的第一个回合"
    store.evaluateTraceSupplyNow()
    expect(unit.hasTraceSupply).toBe(true)
    expect(unit.sustainedBySpecialSupplyTurn).toBe(store.turn)
    expect(unit.cutSinceTurn).not.toBe(store.turn)

    // 下一回合不再喂 ⇒ 这才是它的"第一个断补回合"
    const fedTurn = store.turn
    store.setTurn(fedTurn + 1)
    store.setPhase('movement')
    expect(unit.hasTraceSupply).toBe(false)
    expect(unit.cutSinceTurn).toBe(fedTurn + 1)
  })
})

describe('12.6h：空投当回合豁免追溯补给', () => {
  it('★ 空投着陆的单位在本回合不被标断补；跨回合后照常判定', () => {
    const store = newStore()
    store.setPhase('movement')
    // 现场：本方空军基地 + 一架运输机（载 1 单位货物），目标格是基地之外的一格
    const base = unitChoices('axis').find((item) => item.noncombatKind === 'air_base')
    if (base === undefined) throw new Error('单位库里没有空军基地算子')
    store.units.push(
      toConsoleUnit({ record: base, instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
    )
    const transportRecord = aircraftChoices('axis').find((item) => item.aircraftType === 'Tpt')
    if (transportRecord === undefined) throw new Error('飞机库里没有运输机')
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: transportRecord,
        instanceId: 'tpt-1',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )

    // 12.0/12.6：目标格所在处**没有任何补给源** ⇒ 不豁免就是断补
    const targetHex: HexRef = (() => {
      for (const direction of HEX_DIRECTIONS) {
        const candidate = neighbor(CORE_HEX, direction)
        if (
          isOnMap(candidate) &&
          mapLayers.hexes.some((hex) => hex.col === candidate.col && hex.row === candidate.row)
        ) {
          return candidate
        }
      }
      throw new Error('核心格没有图内邻格')
    })()

    const para = placeGround(
      store,
      unitChoices('axis').find((item) => item.isCombat)!,
      targetHex,
      'axis',
      'para-1',
      'move',
    )
    // 空投：把单位作为货物（14.10）——先把它从图上挪开（货物须"在基地格"由面板勾选，这里直接进候选）
    para.hex = { ...CORE_HEX }
    store.setAirActive(true)
    store.setAirMissionKind('air_drop')
    store.toggleAirCargoUnit('para-1')
    // 14.10a：空投战斗单位须声明 Para 资格（界面上的复选框）
    store.airInputs.cargoUnitsParaCapable = true
    expect(store.setAirTargetFromText(label(targetHex))).toBe(true)
    store.toggleAirMissionUnit('tpt-1')
    // 14.10b：计划空投须**早于执行回合 ≥2 回合**（与既有用例同一现场：计划 1 → 执行 3）
    store.setTurn(3)
    store.airInputs.airdropPlannedTurn = 1
    store.airInputs.airdropScheduledTurn = 3
    expect(store.beginAirMissionNow()).toBe(true)
    // 14.2f 逐步：C 空战（无对手 ⇒ 直接过）→ D 拦截（放弃）→ E 防空（不命中）
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    store.airInputs.flakDie = 2
    expect(store.resolveFlakNow()).toBe(true)
    store.airInputs.cargoDice = 12 // 表 17-4：2 骰 12 必成功
    expect(store.resolveAirCargoNow()).toBe(true)
    expect(para.hex).toEqual(targetHex)
    expect(para.airDropExemptTurn).toBe(store.turn)

    // 12.6h：本回合无论怎么重判，它都不被标断补
    store.evaluateTraceSupplyNow()
    expect(para.hasTraceSupply).toBe(true)
    expect(para.cutSinceTurn).toBe(null)

    // 跨回合：豁免期结束 ⇒ 照常按 12.6 判定
    const dropTurn = store.turn
    store.setTurn(dropTurn + 1)
    store.setPhase('movement')
    expect(para.hasTraceSupply).toBe(false)
    expect(para.cutSinceTurn).toBe(dropTurn + 1)
  })
})
