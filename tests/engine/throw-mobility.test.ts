import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import type { TraceSupplyFacts } from '@/engine/rules'
import { countSupplyDistanceToUnitViaTable } from '@/engine/rules'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import type { SupplyMobility } from '@/engine/rules'
import { toConsoleUnit, toThrowHqView, unitChoices } from '@/stores'

/**
 * R4（12.3a / 12.3b）：HQ 投递距离的**移动类型是可参数化的**
 *
 * ## 原文
 *   · **12.3a**：HQ「投递距离为**步行或履带**的，用对应的移动类型计数」（缺省是轮式）。
 *   · **12.3b**：「投递距离印值的**颜色**表示其移动类型」。
 *
 * ## 设计
 *   · 数据侧新增可选 `throwMobility`（`leg` / `track` / `truck`）；
 *   · 缺省不写 ⇒ `toThrowHqView` 取 `truck`（12.3a 默认口径），行为与此前**逐字节一致**；
 *   · 计费**不另写代价表**：`countSupplyDistanceToUnitViaTable` 的 `mobility` 直接进入
 *     `supplyStepCost → selectMovementTerrain`（与单位移动同一套地形/道路/河流代价）。
 *
 * ## 本夹具
 *   同一座 HQ、同一张盘面，仅把投递类型从 `truck` 改成 `leg` ⇒ 距离按徒步/轮式各自的每格代价重算。
 */

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`
const START: HexRef = { col: 20, row: 10 }
const DIRECTION = HEX_DIRECTIONS[0]!

function corridor(length: number): HexRef[] {
  const hexes: HexRef[] = [START]
  for (let index = 1; index < length; index += 1) {
    hexes.push(neighbor(hexes[index - 1]!, DIRECTION))
  }
  return hexes
}

const LINE = corridor(40)
const ON_LINE = new Set(LINE.map(label))

/** 轮式 0.5 MP/格（道路）；徒步 1 MP/格（同一套地形代价表的两种类型） */
const COST: Record<SupplyMobility, number> = { truck: 0.5, track: 0.5, leg: 1 }

function makeFacts(): TraceSupplyFacts {
  return {
    onMap: (hex) => ON_LINE.has(label(hex)),
    sourcesFor: () => [],
    extendersFor: () => [],
    throwHqsFor: () => [],
    dumpsFor: () => [],
    hasEnemyCombatUnit: () => false,
    inEnemyZoc: () => false,
    stepCost: (from, to, mobility) =>
      ON_LINE.has(label(from)) && ON_LINE.has(label(to)) ? COST[mobility] : null,
  }
}

const HQ_RECORD = unitChoices('axis').find((record) => (record.throwRange?.combatFace ?? 0) === 10)
if (HQ_RECORD === undefined) throw new Error('轴心单位库里找不到 10 MP 投递的 HQ')

function hqUnit(throwMobility?: 'leg' | 'tracked' | 'truck', face: 'combat' | 'move' = 'move') {
  const record =
    throwMobility === undefined
      ? HQ_RECORD!
      : { ...HQ_RECORD!, throwMobility: { combatFace: throwMobility, moveFace: throwMobility } }
  return toConsoleUnit({
    record,
    instanceId: 'hq-probe',
    hex: START,
    side: 'axis',
    face,
  })
}

describe('12.3a/b：投递移动类型', () => {
  it('★ 数据无 `throwMobility` ⇒ 缺省 `truck`（与修前一致）', () => {
    const view = toThrowHqView(hqUnit())
    expect(view.throwMobility).toBe('truck')
    expect(view.throwRangeMp).toBe(7) // 移动面印值 10/7 的 7
  })

  it('★ 数据写 `throwMobility: leg` ⇒ 视图取徒步（不写死 truck）', () => {
    const view = toThrowHqView(hqUnit('leg'))
    expect(view.throwMobility).toBe('leg')
  })

  it('★ 逐面：战斗面写 leg、移动面不写 ⇒ 战斗面 leg、移动面回退 truck', () => {
    const record = {
      ...HQ_RECORD!,
      throwMobility: { combatFace: 'leg' as const },
    }
    const combat = toConsoleUnit({
      record,
      instanceId: 'hq-face',
      hex: START,
      side: 'axis',
      face: 'combat',
    })
    const move = toConsoleUnit({
      record,
      instanceId: 'hq-face',
      hex: START,
      side: 'axis',
      face: 'move',
    })
    expect(toThrowHqView(combat).throwMobility).toBe('leg')
    expect(toThrowHqView(move).throwMobility).toBe('truck')
  })

  it('★ 同一 HQ 改徒步后距离按徒步代价重算：10 MP 只覆盖 10 格', () => {
    const facts = makeFacts()
    const unit = hqUnit('leg')
    const view = toThrowHqView(unit)
    const maxMp = 10
    const reach = (index: number, mobility: SupplyMobility) =>
      countSupplyDistanceToUnitViaTable(facts, {
        from: view.hex,
        unitHex: LINE[index]!,
        side: 'axis',
        mobility,
        maxMp,
      })

    // `countSupplyDistanceToUnitViaTable` 是 12.3c 口径（单位格或其相邻格取最小）：
    // 轮式 0.5 MP/格 ⇒ 第 20 格的邻格 19 = 9.5 MP；徒步 1 MP/格 ⇒ 第 10 格的邻格 9 = 9 MP
    expect(reach(20, 'truck')).toEqual({ ok: true, mp: 9.5 })
    expect(reach(20, 'leg')).toEqual({ ok: false, reason: 'unreachable' })
    expect(reach(10, 'leg')).toEqual({ ok: true, mp: 9 })
    // 第 11 格因邻格=第 10 格（10.0 MP）而可得；第 12 格的邻格 11 已 11 MP ⇒ 不可
    expect(reach(11, 'leg')).toEqual({ ok: true, mp: 10 })
    expect(reach(12, 'leg')).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('★ 缺省与显式 truck 的投递距离逐字段相同', () => {
    const implicit = toThrowHqView(hqUnit())
    const explicit = toThrowHqView(hqUnit('truck'))
    expect(implicit).toEqual(explicit)
  })
})
