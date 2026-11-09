import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * ⑦ 补给改为地图点选（12.3a / 12.3b）
 *
 * 用户口径：点受补给单位 → 地图高亮**可点来源格** → 点格选定；再点同一格取消。
 * 判据一律取既有事实层（`supplySources` 的 `ok` 与 `isSpBearingSource`），本测试只钉界面分派：
 *   · 高亮集合 = 可用且带 SP 的来源格（不多不少）；
 *   · 点格即选定、再点即取消；
 *   · 不可用来源点不动，只出一行原因；
 *   · 同格并列不隐式择一（回面板点选）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 六邻皆图内的格（同 `supply-interaction-flow`：距离 0，判据不受地形影响） */
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

/** 与核心格相距 ≥ 10 格的图内格（12.3a 的 5 MP 拖取距离外 ⇒ 该补给站不可用） */
const FAR_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find(
    (hex) => hexDistance(CORE_HEX, { col: hex.col, row: hex.row }) >= 10,
  )
  if (found === undefined) throw new Error('地图上找不到足够远的格')
  return { col: found.col, row: found.row }
})()

/** 无任何来源的格（与核心格/远格都不同，且在图上） */
const EMPTY_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return (
      label(ref) !== label(CORE_HEX) &&
      label(ref) !== label(FAR_HEX) &&
      hexDistance(CORE_HEX, ref) === 3
    )
  })
  if (found === undefined) throw new Error('地图上找不到空来源格')
  return { col: found.col, row: found.row }
})()

function combatRecord(side: Side): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(
    (record) => record.isCombat === true && (record.reSize ?? 0) > 0,
  )
  if (found === undefined) throw new Error(`${side} 单位库中没有带规模的战斗单位`)
  return found
}

/**
 * 基线局面：轴方战斗单位在核心格；核心格有 1 SP 补给站 + 一条 12.6a 追溯源
 * ⇒ 来源清单 = dump（可用）+ baseSource（不可拖取，无 SP）+ eatOffTheMap（不可用）
 */
function setupTrace(): {
  store: ReturnType<typeof newStore>
  unit: ReturnType<typeof toConsoleUnit>
} {
  const store = newStore()
  store.setSupplyActive(true)
  const unit = toConsoleUnit({
    record: combatRecord('axis'),
    instanceId: 'u1',
    hex: CORE_HEX,
    side: 'axis',
  })
  store.units.push(unit)
  store.spDumpDraft = { hexText: label(CORE_HEX), sp: 2, t: 0 }
  expect(store.addSpDump()).toBe(true)
  store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
  expect(store.addSupplySource()).toBe(true)
  store.setPhase('supply')
  expect(store.beginSupplyCheckNow(unit.instanceId)).toBe(true)
  return { store, unit }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('⑦ 选源：地图高亮集合（12.3a / 12.3b）', () => {
  it('只高亮「可用且带 SP」的来源格；不可用与无算子来源不出现（不多不少）', () => {
    const { store } = setupTrace()
    expect(store.supplyState?.step).toBe('selectSource')

    const expected = new Set(
      store.supplySources
        .filter(
          (source) =>
            source.ok &&
            (source.kind === 'dump' || source.kind === 'hqThrow') &&
            source.hex !== null,
        )
        .map((source) => {
          const hex = source.hex
          return hex === null ? '' : label(hex)
        }),
    )
    const actual = store.supplyPickSourceHints.map((hint) => label(hint.hex))

    expect(new Set(actual)).toEqual(expected)
    // 同格去重：一格一条
    expect(actual).toHaveLength(expected.size)
    // 12.6c 吃图上补给没有来源格（hex = null），不得进高亮
    expect(store.supplySources.some((source) => source.kind === 'eatOffTheMap')).toBe(true)
    expect(actual).not.toContain(label(FAR_HEX))
  })
})

describe('⑦ 选源：点格选定 / 再点取消', () => {
  it('点可点来源格 ⇒ 选定该来源并进入 pickup 步（高亮转为已选）', () => {
    const { store } = setupTrace()
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(true)
    expect(store.supplyState?.step).toBe('pickup')
    expect(store.supplySummary?.chosenSource?.kind).toBe('dump')
    expect(
      store.supplyPickSourceHints.find((hint) => label(hint.hex) === label(CORE_HEX))?.selected,
    ).toBe(true)
  })

  it('再点已选来源同一格 ⇒ 取消选择、退回 selectSource（12.3）', () => {
    const { store } = setupTrace()
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(true)
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(true)
    expect(store.supplySummary?.chosenSource).toBeNull()
    expect(store.supplyState?.step).toBe('selectSource')
  })
})

describe('⑦ 选源：不可点与不拦截', () => {
  it('点不可用的来源格 ⇒ 状态不变，只出一行原因（12.3a）', () => {
    const { store } = setupTrace()
    store.spDumpDraft = { hexText: label(FAR_HEX), sp: 2, t: 0 }
    expect(store.addSpDump()).toBe(true)
    expect(store.beginSupplyCheckNow(store.supplyUnitId!)).toBe(true)

    const far = store.supplySources.find(
      (source) =>
        source.kind === 'dump' && source.hex !== null && label(source.hex) === label(FAR_HEX),
    )
    expect(far?.ok).toBe(false)

    const before = store.log.length
    expect(store.pickSupplySourceAtHexNow(FAR_HEX)).toBe(true)
    expect(store.supplyState?.step).toBe('selectSource')
    expect(store.supplySummary?.chosenSource).toBeNull()
    // 只多出一条日志（一行原因），并带该来源的规则号
    expect(store.log.length).toBe(before + 1)
    expect(store.log[0]?.kind).toBe('warning')
    expect(store.log[0]?.text).toContain(label(FAR_HEX))
    expect(store.log[0]?.rule).toBe(far?.rule)
  })

  it('存在但不可拖取的来源（12.6a 追溯源，无 SP）⇒ 不选、一行提示', () => {
    const { store } = setupTrace()
    // 注入一条「可用但不带 SP」的来源（baseSource）到无来源格，专测界面分支；判据仍来自引擎口径
    const state = store.supplyState!
    store.supplyState = {
      ...state,
      sources: [
        ...state.sources,
        {
          kind: 'baseSource',
          hex: EMPTY_HEX,
          path: null,
          distanceMp: null,
          viaAdjacency: false,
          ok: true,
          rule: '12.6a',
          detail: '追溯源',
        },
      ],
    }
    expect(store.pickSupplySourceAtHexNow(EMPTY_HEX)).toBe(true)
    expect(store.supplyState?.step).toBe('selectSource')
    expect(store.log[0]?.kind).toBe('warning')
    expect(store.log[0]?.text).toContain(label(EMPTY_HEX))
  })

  it('同格两条可用来源 ⇒ 不隐式择一，提示回面板（并列）', () => {
    const { store } = setupTrace()
    const state = store.supplyState!
    const dump = state.sources.find((source) => source.kind === 'dump' && source.hex !== null)!
    store.supplyState = {
      ...state,
      sources: [
        ...state.sources,
        { ...dump, distanceMp: 1, viaAdjacency: true, detail: '同格并列（注入）' },
      ],
    }
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(true)
    expect(store.supplySummary?.chosenSource).toBeNull()
    expect(store.supplyState?.step).toBe('selectSource')
    expect(store.log[0]?.kind).toBe('warning')
    expect(store.log[0]?.text).toContain('并列')
  })

  it('未开始检查 / 已结算完成时点格不拦截（交回常规分派）', () => {
    const { store } = setupTrace()
    store.cancelSupply()
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(false)
    // 重新开始后走到 done（非选源步）也不拦截
    expect(store.beginSupplyCheckNow('u1')).toBe(true)
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(true)
    store.supplyInputs.purpose = 'fuel'
    expect(store.confirmSupplyPickupNow()).toBe(true)
    expect(store.supplyState?.step).toBe('done')
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(false)
  })

  it('点没有任何来源的格 ⇒ 不拦截（false）', () => {
    const { store } = setupTrace()
    expect(store.pickSupplySourceAtHexNow(EMPTY_HEX)).toBe(false)
  })
})
