import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  allowedActionsOf,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'

/**
 * G①（P0）：**空军轰炸与低空扫射真的进轰炸引擎**（14.7b / 14.7d / 10.2）
 *
 * ## 原文
 *   · **14.7b** 空军轰炸：任务在 10.0 的轰炸环节宣布、按 10.2 结算（10.2a 飞机须**放在目标上**结算、
 *     10.2b 短程 +1 列、**10.2c 空军轰炸没有补给消耗**、14.7「最多四个飞机参与同一次轰炸」）。
 *   · **14.7d** 低空扫射：**单机**（14.7d-B）、需正确观察员（10.0b）、**不得**做运输破坏（14.7d-D）。
 *   · **10.0e-C**：空军/海军轰炸只在**移动/反应/进击**段；F 段轰炸环节**仅炮兵**（2.2 SOP 的 C 段括注
 *     「air & ship only」、F 段「artillery only」）。
 *
 * ## 修前的病灶（用户报的第 1 条）
 *   `autoResolveAirMissionNow` 在 `resolveMission` 直接调 `confirmAirMissionNow()` —— 那只写一条备注就转返航，
 *   于是**空军轰炸从未进轰炸引擎**，日志每次都是「任务结算（14.2f-F）：（未填结果）」；
 *   低空扫射连那条半桥都没有（`beginAirBarrageNow` 只认 `kind === 'barrage'`）。
 *
 * ## 测法边界（如实交代）
 *   · 用真实地图格、真实飞机库与真实单位库；结论全部来自 store 与引擎；
 *   · 横移（10.0a）是**目标玩家**的选择 ⇒ 自动连跑取"不横移"（合法选择之一）；要自己选横移仍走
 *     轰击面板的逐步按钮（验证页）；
 *   · **不覆盖界面**（仓库无组件渲染测试）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

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

function airBaseRecord() {
  const found = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')
  if (found === undefined) throw new Error('单位库中没有空军基地算子')
  return found
}

/** 能轰炸的轴方机（T/S 型、带轰炸值）；`filter` 可选（低空扫射要 `canHipShoot`） */
function bomberRecord(
  side: Side,
  filter: (record: ReturnType<typeof aircraftChoices>[number]) => boolean = () => true,
) {
  const found = aircraftChoices(side).find(
    (record) =>
      (record.barrageStrength ?? 0) > 0 &&
      record.airAbilities?.canBarrage !== false &&
      filter(record),
  )
  if (found === undefined) throw new Error(`${side} 飞机库中没有满足条件的机`)
  return found
}

/** 摆「本方基地 + 参炸机 + 目标格上的敌方单位」的现场（目标格与基地相邻） */
function setupBarrage(
  store: ReturnType<typeof newStore>,
  count = 2,
  /** 选机型的额外条件（低空扫射要 `canHipShoot`） */
  recordFilter: (record: ReturnType<typeof aircraftChoices>[number]) => boolean = () => true,
) {
  const target: HexRef =
    HEX_DIRECTIONS.map((direction) => neighbor(CORE_HEX, direction)).find(
      (hex) =>
        isOnMap(hex) &&
        mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row),
    ) ?? CORE_HEX
  store.setAirActive(true)
  store.units.push(
    toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
  )
  /*
   * 10.0b：低空扫射要求「与目标格**相邻**的友方**战斗单位**」作正确观察员 ⇒ 起点格（与目标格相邻）
   * 摆一枚本方战斗单位。空军轰炸本身不需要观察员，但一起摆上不影响它（事实多给不算错）。
   */
  const spotter = unitChoices('axis').find((item) => item.isCombat === true)
  if (spotter === undefined) throw new Error('轴方单位库里没有战斗单位')
  store.units.push(
    toConsoleUnit({ record: spotter, instanceId: 'spot-1', hex: CORE_HEX, side: 'axis' }),
  )
  // 目标格上的苏军战斗单位（10.0a 的损失承受者候选）
  const defender = unitChoices('soviet').find((item) => item.isCombat === true)
  if (defender === undefined) throw new Error('苏方单位库里没有战斗单位')
  store.units.push(
    toConsoleUnit({ record: defender, instanceId: 'def-1', hex: target, side: 'soviet' }),
  )
  for (let index = 0; index < count; index += 1) {
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: bomberRecord('axis', recordFilter),
        instanceId: `bmb-${String(index + 1)}`,
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )
  }
  expect(store.setAirTargetFromText(label(target))).toBe(true)
  for (let index = 0; index < count; index += 1)
    store.toggleAirMissionUnit(`bmb-${String(index + 1)}`)
  return target
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('G①：空军轰炸（14.7b / 10.2）真的落 CRT', () => {
  it('★ C 段宣布空军轰炸 ⇒ 自动跑完轰炸链（不是只写一条备注就返航）', () => {
    const store = newStore()
    store.setPhase('movement')
    // 进入 C 段的轰炸环节（2.2 SOP：air & ship only）
    const index = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.barrage')
    expect(store.setSegmentStepIndex(index)).toBe(true)
    setupBarrage(store)

    expect(store.runAirMissionWithKind('barrage')).toBe(true)
    // ① 轰炸引擎真的跑过：状态机走完 + 结果落在会话日志里
    expect(store.barrageState?.finished).toBe(true)
    expect(store.log.some((entry) => (entry.text ?? '').includes('轰炸结果（10.0a）'))).toBe(true)
    // ② 任务本身也收尾（14.2f-F），日志里不再出现"（未填结果）"
    expect(store.log.some((entry) => (entry.text ?? '').includes('（未填结果）'))).toBe(false)
  })

  it('★ 低空扫射（14.7d）也走同一条轰炸链，且是**单机**任务', () => {
    const store = newStore()
    store.setPhase('movement')
    // 14.7d 属**移动环节**（14.2e：低空扫射在移动环节）⇒ 进 `movement.modeAndMovement`
    const index = store.playerSegmentSteps.findIndex(
      (step) => step.id === 'movement.modeAndMovement',
    )
    expect(store.setSegmentStepIndex(index)).toBe(true)
    setupBarrage(store, 1, (record) => record.airAbilities?.canHipShoot === true)
    // 10.0b：低空扫射需要**正确观察员**（面板上的事实声明）
    store.barrageInputs = { ...store.barrageInputs, hasSpotter: true }

    expect(store.runAirMissionWithKind('hip_shoot')).toBe(true)
    expect(store.barrageState?.finished).toBe(true)
    // 14.7d-B：「A Hip Shoot must be made by a **single aircraft**」⇒ 参炸机恰一枚
    expect(store.barrageAirIds.length).toBe(1)
    expect(store.barrageKind).toBe('air')
    expect(store.log.some((entry) => (entry.text ?? '').includes('（未填结果）'))).toBe(false)
    /*
     * ★ 条 13（A2）契约变更（**不是放宽**）：干净低空扫射**全自动到返航并变非激活** ——
     *   修前 `runAirMissionWithKind` 只到 `returnToBase`，玩家还得再点一次「返航」逐机确认；
     *   现对 hip_shoot 自动补完返航步（`completeAirReturnNow` ⇒ 14.1c 逐机转非激活）。
     *   barrage（14.7b）不在此列，仍停 returnToBase（见上一例与 G① 口径）。
     */
    expect(store.airState?.step).toBe('done')
    expect(store.airState?.finished).toBe(true)
    expect(store.airUnits.find((air) => air.instanceId === 'bmb-1')?.airStatus).toBe('inactive')
  })
})

describe('G①：F 段轰炸环节**不**放行空中任务（2.2 SOP + 10.0e-C）', () => {
  it('★ 闸门对齐：air.mission 不在 combat.barrage；barrage.declare 也不给炮兵以外的段', () => {
    // 10.0e-C：空军轰炸只在移动/反应/进击段 ⇒ F 段（combat.barrage）不得放行空中任务
    const inCombatBarrage = allowedActionsOf({
      phase: 'combat',
      segment: 'combat.barrage',
      role: 'active',
      side: 'axis',
    })
    expect(inCombatBarrage.has('air.mission')).toBe(false)
    expect(inCombatBarrage.has('barrage.declare')).toBe(true)
    // C 段的轰炸环节仍放行空中任务（SOP：「air & ship only」）
    expect(
      allowedActionsOf({
        phase: 'movement',
        segment: 'movement.barrage',
        role: 'active',
        side: 'axis',
      }).has('air.mission'),
    ).toBe(true)
  })
})
