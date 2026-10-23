import { readFileSync } from 'node:fs'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/**
 * 第五批 A1（docs/第五批修改方案.md 族 A1）：轰炸 10.0a / 10.0c 的**输入源**接线
 *
 * 病灶：`BarragePanel` 的损失分配与飞机掷骰输入都取 `battleDefenders`（9.x 战斗工具的守方），
 * 而引擎按**轰炸目标格**校验 ⇒ 正常对局（无战斗会话）里输入清单为空：
 * 出「#」点数结果时 ⑤ 永远填不满＝死锁；对空军基地轰炸时飞机骰还挂在地面单位上，
 * 且设施结果里的逐机损失（`FacilityOutcome.aircraftLosses`）在交互层被丢弃、从未落盘。
 * 规则原文：10.0a「他还需要选择**堆叠中的**哪些战斗单位来承受此次轰炸造成的军力损失」
 * （`_ocs_v43_clean.txt:1573-1574`）；10.0c-A「检查该格内**所有敌方飞机**的损失情况，对每个飞机分别掷骰」
 * （txt:1595-1600）。
 *
 * ★ 测法边界（如实）：引擎侧 `planBarrageOutcome` 的损失校验**本来就按目标格判**（本切片不改这段校验），
 *   真正缺的是「候选投影 + 面板接线 + 设施逐机损失的落盘」——故红检落在两条新投影、
 *   设施掉步的端到端断言与源码守卫上；10.0a 的分配断言随掷出的结果码走条件分支
 *   （骰面注入是确定的，但 2d6 → 结果码的映射随目标格事实变化，不适合作确定性断言）。
 *   面板像素无断言（本仓库无组件渲染测试），接线靠源码守卫。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

/** 目标格：六邻皆图内 */
const TARGET_HEX: HexRef = (() => {
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

/** 参炸格：目标格的图内邻格（射程 1 恒合法） */
const FIRING_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(TARGET_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
    ) {
      return candidate
    }
  }
  throw new Error('目标格没有图内邻格')
})()

/** 大轰炸值火炮（两门 30 ⇒ 总值 60 ⇒ 设施表落「41-80」列，骰 1 ⇒ `(5)`） */
function heavyArtilleryRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find(
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) >= 30,
  )
  if (found === undefined) throw new Error('轴心国单位库中没有轰炸值 ≥30 的火炮')
  return found
}

function defenderRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('soviet').find((record) => record.isCombat === true)
  if (found === undefined) throw new Error('苏联单位库中没有战斗单位')
  return found
}

/** 中立空军基地算子（摆放时按己方决定归属；这里摆在苏方） */
function airBaseRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')
  if (found === undefined) throw new Error('单位库中没有空军基地算子')
  return found
}

/** 苏军战术轰炸机（10.0c-A 的机损对象；类型/印值与本切片无关，只要"是架飞机"） */
function sovietBomberRecord(): ReturnType<typeof aircraftChoices>[number] {
  const found = aircraftChoices('soviet').find((record) => record.aircraftType === 'T')
  if (found === undefined) throw new Error('苏联飞机库中没有战术轰炸机')
  return found
}

/** 走完 ①宣布 → ②补给 → ③横移 ⇒ 停在 ④掷骰（调用方先自行布景到"宣布前"） */
function driveToDice(store: ReturnType<typeof newStore>): void {
  if (!store.beginBarrageNow()) {
    throw new Error(
      `beginBarrageNow refused: error=${JSON.stringify(store.barrageError)} ` +
        `refusal=${JSON.stringify(store.actionRefusal)} ` +
        `picks=${JSON.stringify(store.barrageUnitIds)} targetHex=${JSON.stringify(store.barrageTargetHex)}`,
    )
  }
  const id = `bd-${store.spDumps.length}`
  store.spDumps.push({ id, hex: FIRING_HEX, side: store.activeSide, sp: 0, t: 20 })
  expect(store.pickBarrageSupplyDump(id)).toBe(true)
  const group = store.groupOfUnit(store.units.find((unit) => unit.side === store.activeSide)!)
  if (group !== null) store.setDumpPanzerGroupNow(id, group)
  expect(store.confirmBarrageSupplyStep()).toBe(true)
  expect(store.confirmBarrageShiftsStep()).toBe(true)
  expect(store.barrageState?.step).toBe('dice')
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('第五批 A1：轰炸输入源按目标格（10.0a / 10.0c）', () => {
  it('10.0a：损失分配候选＝目标格内敌方战斗单位（与 battleDefenders 脱钩）', () => {
    const store = newStore()
    store.setPhase('combat')
    goToActionStep(store, 'barrage.declare')
    store.setBarrageActive(true)
    for (let i = 0; i < 2; i++) {
      store.units.push(
        toConsoleUnit({
          record: heavyArtilleryRecord(),
          instanceId: `art-${i}`,
          hex: FIRING_HEX,
          side: 'axis',
        }),
      )
      store.toggleBarrageUnit(`art-${i}`)
    }
    expect(store.barrageUnitIds, 'picks after toggles').toEqual(['art-0', 'art-1'])
    store.units.push(
      ...['def-1', 'def-2', 'def-3'].map((instanceId) =>
        toConsoleUnit({
          record: defenderRecord(),
          instanceId,
          hex: TARGET_HEX,
          side: 'soviet',
        }),
      ),
    )
    expect(store.barrageUnitIds, 'picks after defenders').toEqual(['art-0', 'art-1'])
    // 战斗目标**留空守军**（正常对局没有战斗会话 ⇒ 修前面板的输入清单为空）
    store.battleTarget = { hex: TARGET_HEX, defenderIds: [] }
    expect(store.barrageUnitIds, 'picks after battleTarget').toEqual(['art-0', 'art-1'])

    driveToDice(store)
    store.barrageInputs.die = 12
    store.barrageInputs.halfDie = 4
    expect(store.rollBarrageDiceStep()).toBe(true)
    expect(store.barrageState?.step).toBe('outcome')

    // 修前面板取 battleDefenders ⇒ 空清单（＝⑤ 填不满的死锁前提）
    expect(store.battleDefenders).toEqual([])
    // 新投影：目标格内的敌方战斗单位（三个守军都在）
    expect(store.barrageLossTargets.map((unit) => unit.instanceId)).toEqual([
      'def-1',
      'def-2',
      'def-3',
    ])

    // 出点数结果时按投影足额分配 ⇒ ⑤ 走得通（修前玩家在界面上根本填不了）
    const required = store.barrageSummary?.unitOutcome?.stepLosses ?? 0
    if (required > 0) {
      const losses: Record<string, number> = {}
      let remaining = required
      for (const unit of [...store.barrageLossTargets].sort((a, b) => b.steps - a.steps)) {
        if (remaining <= 0) break
        const take = Math.min(remaining, unit.steps)
        if (take > 0) {
          losses[unit.instanceId] = take
          remaining -= take
        }
      }
      expect(remaining).toBe(0)
      store.barrageInputs.losses = losses
    }
    expect(store.confirmBarrageOutcomeStep()).toBe(true)
    expect(store.barrageState?.finished).toBe(true)
  })

  it('10.0c-A：飞机掷骰候选＝目标格内所有敌方飞机；达标者真掉步（修前被丢弃）', () => {
    const store = newStore()
    store.setPhase('combat')
    goToActionStep(store, 'barrage.declare')
    store.setBarrageActive(true)
    for (let i = 0; i < 2; i++) {
      store.units.push(
        toConsoleUnit({
          record: heavyArtilleryRecord(),
          instanceId: `art-${i}`,
          hex: FIRING_HEX,
          side: 'axis',
        }),
      )
      store.toggleBarrageUnit(`art-${i}`)
    }
    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-su',
        hex: TARGET_HEX,
        side: 'soviet',
      }),
    )
    const planeA = toConsoleAirUnit({
      aircraft: sovietBomberRecord(),
      instanceId: 'plane-a',
      hex: TARGET_HEX,
      side: 'soviet',
      airStatus: 'active',
    })
    const planeB = toConsoleAirUnit({
      aircraft: sovietBomberRecord(),
      instanceId: 'plane-b',
      hex: TARGET_HEX,
      side: 'soviet',
      airStatus: 'active',
    })
    store.airUnits.push(planeA, planeB)
    store.battleTarget = { hex: TARGET_HEX, defenderIds: [] }
    store.setBarrageTargetKind('airBase')

    driveToDice(store)
    store.barrageInputs.die = 1
    expect(store.rollBarrageDiceStep()).toBe(true)
    // 夹具守卫：总值 60 ⇒ 「41-80」列，骰 1 ⇒ `(5)`（含机损阈值）
    expect(store.barrageState?.result?.code).toContain('(')

    // 新投影：格内两架敌机（修前这里是 battleDefenders ⇒ 地面单位、清单为空）
    expect(store.barrageAircraftRollTargets.map((air) => air.instanceId)).toEqual([
      'plane-a',
      'plane-b',
    ])

    // 阈值 5：plane-a 掷 6 ⇒ 掉步；plane-b 掷 4 ⇒ 安全（修前两机都不掉）
    store.barrageInputs.aircraftRolls = { 'plane-a': 6, 'plane-b': 4 }
    const stepsABefore = planeA.steps
    const stepsBBefore = planeB.steps
    expect(store.confirmBarrageOutcomeStep()).toBe(true)
    expect(store.barrageState?.finished).toBe(true)
    expect(planeA.steps).toBe(stepsABefore - 1)
    expect(planeB.steps).toBe(stepsBBefore)
  })

  it('源码守卫：面板的两处输入都读新投影，不再读 battleDefenders', () => {
    const panel = readFileSync('src/components/barrage/BarragePanel.vue', 'utf8')
    expect(panel).toContain('workbench.barrageLossTargets')
    expect(panel).toContain('workbench.barrageAircraftRollTargets')
    expect(panel).not.toContain('workbench.battleDefenders')
  })
})
