import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  actionGateOf,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * 第五批 A4（docs/第五批修改方案.md 族 A4）：专规 2.3d —— 苏军炮兵合并轰炸**须同堆叠**
 *
 * 原文（Smolensk_Rules_v1.1.txt:329-331，§17.126 亲验）：
 * 「To combine for a single Barrage, **all of the firing Soviet artillery units must be stacked together**.」
 *
 * 病灶：引擎 `BarrageUnitRequest` 没有 hex 字段 ⇒ 引擎无从判"同堆叠"；store 候选＝本方任一
 * 有轰炸值单位（任意格）⇒ 跨格合并苏炮畅通无阻；数据标签 `sov_artillery_stack_to_combine`
 * （units-soviet.json 两门炮：`su-artillery-ru-arty-bde` / `su-motorized-ru-1-mot-13-arty`）零消费。
 *
 * ★ 测法边界（如实）：端到端只覆盖"两门带标签苏炮跨格被拒 / 同格放行 / 德方跨格放行 /
 *   候选灰显"四态；标签驱动的范围（本作数据只有 2 条带标签）随数据登记，若要覆盖全部苏军
 *   炮兵须扩数据标签（已登记，等用户口径）。面板像素无断言（无组件渲染测试）。
 */

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

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

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

/** 目标格的两个图内邻格（射程 1 ≤ 3 ⇒ 都在射程内） */
const NEIGHBOR_HEXES: HexRef[] = (() => {
  const found: HexRef[] = []
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(TARGET_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
    ) {
      found.push(candidate)
      if (found.length === 2) return found
    }
  }
  throw new Error('目标格没有两个图内邻格')
})()

/** 带专规 2.3d 标签的苏军炮兵记录（units-soviet.json 里只有两门 ⇒ 恰好凑"合并"现场） */
const taggedRecords = (): ReturnType<typeof unitChoices>[number][] => {
  const found = unitChoices('soviet').filter((record) =>
    (record.specialAbilities ?? []).includes('sov_artillery_stack_to_combine'),
  )
  if (found.length < 2) throw new Error('苏军单位库里带 2.3d 标签的炮兵不足两门')
  return found.slice(0, 2)
}

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** 苏方视角摆两门带标签炮 + 声明补给来源（打到"宣布前"） */
function setupSovietBarrage(store: ReturnType<typeof newStore>, hexB: HexRef): void {
  store.setActiveSide('soviet')
  store.setPhase('combat')
  goToActionStep(store, 'barrage.declare')
  store.setBarrageActive(true)
  const [recordA, recordB] = taggedRecords()
  if (recordA === undefined || recordB === undefined) throw new Error('带标签炮兵不足两门')
  place(store, recordA, NEIGHBOR_HEXES[0]!, 'soviet', 's-arty-0')
  place(store, recordB, hexB, 'soviet', 's-arty-1')
  store.battleTarget = { hex: TARGET_HEX, defenderIds: [] }
  store.toggleBarrageUnit('s-arty-0')
  store.toggleBarrageUnit('s-arty-1')
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('第五批 A4：专规 2.3d 苏军炮兵合并轰炸须同堆叠', () => {
  it('两门带标签苏炮分处两格 ⇒ 宣布被拒（专规 2.3d）', () => {
    const store = newStore()
    setupSovietBarrage(store, NEIGHBOR_HEXES[1]!)
    expect(store.beginBarrageNow()).toBe(false)
    expect(store.barrageError).toMatchObject({ rule: '专规 2.3d' })
  })

  it('同格 ⇒ 放行（宣布成功）', () => {
    const store = newStore()
    setupSovietBarrage(store, NEIGHBOR_HEXES[0]!)
    expect(store.beginBarrageNow()).toBe(true)
    expect(store.barrageState?.step).toBe('supply')
  })

  it('德方两门炮跨格 ⇒ 不受此限（对照；无标签）', () => {
    const store = newStore()
    store.setPhase('combat')
    goToActionStep(store, 'barrage.declare')
    store.setBarrageActive(true)
    const axisArtillery = unitChoices('axis').find(
      (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
    )
    if (axisArtillery === undefined) throw new Error('轴心国单位库里没有带轰炸值的炮')
    place(store, axisArtillery, NEIGHBOR_HEXES[0]!, 'axis', 'g-arty-0')
    place(store, axisArtillery, NEIGHBOR_HEXES[1]!, 'axis', 'g-arty-1')
    store.battleTarget = { hex: TARGET_HEX, defenderIds: [] }
    store.toggleBarrageUnit('g-arty-0')
    store.toggleBarrageUnit('g-arty-1')
    expect(store.beginBarrageNow()).toBe(true)
  })

  it('候选灰显：已选一枚带标签苏炮 ⇒ 另一格的带标签苏炮给 2.3d 灰显原因', () => {
    const store = newStore()
    setupSovietBarrage(store, NEIGHBOR_HEXES[1]!)
    const other = store.barrageUnitChoices.find((item) => item.unit.instanceId === 's-arty-1')
    if (other === undefined) throw new Error('候选阵列里找不到第二门苏炮')
    expect(other.disabledReason).toContain('专规 2.3d')
  })
})
