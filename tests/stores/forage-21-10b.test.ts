import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { countSupplyDistanceToUnitViaTable, hasTraceSupply } from '@/engine/rules'
import { hexDistance } from '@/engine/hex-geometry'
import type { ConsoleUnit, unitChoices } from '@/stores'
import {
  CORE_HEX,
  NEAR_HEX,
  groundRecord,
  newConsole,
  placeGround,
  type Workbench,
} from '../flows/sop-harness'

/**
 * 21.10b **Forage**
 *
 * 用户 2026-11-13 定稿：
 * - 不区分断补原因：只要 `cutSinceTurn === 当前回合` 即首次失补【口径】；
 * - **HQ 自己也算受益**（连同投递范围内可合法追溯它的己方单位）；
 * - 入口与 12.6c 同面板两选项；首次失补才出现，第二次只剩吃图上补给；
 * - 1 枚 Supply Cache 二选一、用掉消失；阶段内可撤销，跨阶段不可逆。
 *
 * API：`store.forageOptions` / `store.useForageNow(hqId)` /
 * `store.undoSupplyCacheUse()`；单位字段 `foragedTurn`。
 */

interface ForageOption {
  hqId: string
  hex: HexRef
  throwRangeMp: number
  coveredUnitIds: string[]
}

interface FutureWorkbench {
  readonly turn: number
  readonly forageOptions: ForageOption[]
  useForageNow(hqId: string): boolean
  undoSupplyCacheUse(): boolean
}

const future = (store: Workbench) => store as unknown as FutureWorkbench
const withForage = (unit: ConsoleUnit) => unit as ConsoleUnit & { foragedTurn?: number | null }

/** 印值投递距离（单位库可能按战斗面/移动面分列，取战斗面优先） */
const throwRangeOf = (record: ReturnType<typeof unitChoices>[number]): number => {
  const range = record.throwRange
  return typeof range === 'number' ? range : (range?.combatFace ?? range?.moveFace ?? 0)
}

/** HQ：真实单位库里 `branch === 'hq'` 的记录（投递距离按战斗面 8 或 10） */
const hqRecord = () =>
  groundRecord('axis', (record) => record.branch === 'hq' && throwRangeOf(record) > 0)

/** 离 HQ 足够远的同阵营战斗单位（印值最大 10，取 ≥ 12 必在投递距离外） */
const FAR_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return hexDistance(ref, CORE_HEX) >= 12
  })
  if (found === undefined) throw new Error('地图上找不到离 CORE_HEX ≥ 12 格的格')
  return { col: found.col, row: found.row }
})()

function setup() {
  setActivePinia(createPinia())
  const store = newConsole()
  store.setPhase('supply')
  const hq = placeGround(store, hqRecord(), CORE_HEX, 'axis', 'hq-forage')
  const near = placeGround(
    store,
    groundRecord('axis', (r) => r.isCombat === true),
    NEAR_HEX,
    'axis',
    'u-near',
  )
  const far = placeGround(
    store,
    groundRecord('axis', (r) => r.isCombat === true),
    FAR_HEX,
    'axis',
    'u-far',
  )
  for (const unit of [hq, near, far]) {
    unit.cutSinceTurn = store.turn
    unit.hasTraceSupply = false
  }
  store.supplyCacheHoldings.axis = 1
  return { store, hq, near, far }
}

describe('21.10b Forage', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('F1/F2/F8：首次失补 ⇒ 选项出现，覆盖 HQ 自身 + 投递距离内单位，距离取印值', () => {
    const { store, hq, near, far } = setup()
    const options = future(store).forageOptions
    expect(options).toHaveLength(1)
    expect(options[0]?.hqId).toBe(hq.instanceId)
    expect(options[0]?.throwRangeMp).toBe(throwRangeOf(hqRecord()))
    expect(options[0]?.coveredUnitIds).toEqual(
      expect.arrayContaining([hq.instanceId, near.instanceId]),
    )
    expect(options[0]?.coveredUnitIds).not.toContain(far.instanceId)
  })

  it('F1 + 用户定稿②：使用后 HQ 自己也视为吃了图内补给，远处单位不受影响', () => {
    const { store, hq, near, far } = setup()
    const turn = future(store).turn
    expect(future(store).useForageNow(hq.instanceId)).toBe(true)

    for (const unit of [hq, near]) {
      expect(unit.sustainedBySpecialSupplyTurn).toBe(turn)
      const outOfSupply = (
        store as unknown as { isOutOfSupplyNow?: (instanceId: string) => boolean }
      ).isOutOfSupplyNow?.(unit.instanceId)
      expect(outOfSupply ?? false).toBe(false)
    }
    expect(far.sustainedBySpecialSupplyTurn).not.toBe(turn)
    expect(store.supplyCacheHoldings.axis).toBe(0)
    expect(withForage(hq).foragedTurn).toBe(turn)
    // 用户定稿：HQ 的断补锚点**不清**（否则下一回合会被重记成"第一回合"而反复 Forage）
    expect(hq.cutSinceTurn).toBe(turn)
  })

  it('F4：同回合第二次不可用；选项消失', () => {
    const { store, hq } = setup()
    expect(future(store).useForageNow(hq.instanceId)).toBe(true)
    expect(future(store).useForageNow(hq.instanceId)).toBe(false)
    expect(future(store).forageOptions).toHaveLength(0)
    expect(store.supplyCacheHoldings.axis).toBe(0)
  })

  it('F4：第二次失补（cutSinceTurn < 当前回合）⇒ 选项不出现', () => {
    const { store, hq, near, far } = setup()
    const turn = future(store).turn
    for (const unit of [hq, near, far]) unit.cutSinceTurn = turn - 1
    expect(future(store).forageOptions).toHaveLength(0)
  })

  it('§5 撤销：阶段内退回标记、清 foragedTurn 与续命标', () => {
    const { store, hq, near } = setup()
    const turn = future(store).turn
    expect(future(store).useForageNow(hq.instanceId)).toBe(true)
    expect(future(store).undoSupplyCacheUse()).toBe(true)

    expect(store.supplyCacheHoldings.axis).toBe(1)
    expect(withForage(hq).foragedTurn ?? null).toBeNull()
    expect(hq.sustainedBySpecialSupplyTurn).not.toBe(turn)
    expect(near.sustainedBySpecialSupplyTurn).not.toBe(turn)
    // 快照回退：受益单位的断补锚点也回到使用前（`markSustainedBySpecialSupply` 会清它）
    expect(near.cutSinceTurn).toBe(turn)
  })

  it('§5 跨阶段不可逆：离开补给阶段后撤销被拒，标记与 foragedTurn 保留', () => {
    const { store, hq } = setup()
    const turn = future(store).turn
    expect(future(store).useForageNow(hq.instanceId)).toBe(true)
    store.setPhase('movement')
    expect(future(store).undoSupplyCacheUse()).toBe(false)
    expect(store.supplyCacheHoldings.axis).toBe(0)
    expect(withForage(hq).foragedTurn).toBe(turn)
  })

  it('F6：Forage 覆盖的单位从 12.6c 喂食候选中排除（计划重算）', () => {
    /*
     * 现场构造（全部用真实地图/真实规则判据找格，不手填距离）：
     * - HQ 格与受益单位格都要**真断补**（空盘无补给源声明 ⇒ 内陆格无源可达）；
     * - 两格相距 6–8 MP：> 12.3a 的 5 点直拖（HQ 拿不到站、无投递资格），
     *   又在 HQ 印值投递距离 8 内（Forage 覆盖成立）；
     * - 补给站放在受益单位格 ⇒ 12.6c「no trace supply available」下可喂。
     */
    setActivePinia(createPinia())
    const store = newConsole()
    store.setPhase('supply')
    const hexes = mapLayers.hexes.map((hex) => ({ col: hex.col, row: hex.row }))
    const inTrace = (hex: HexRef): boolean =>
      hasTraceSupply(store.supplyFacts, { hex, side: 'axis', mobility: 'truck' }).ok
    const pair = (() => {
      for (const hqHex of hexes) {
        if (inTrace(hqHex)) continue
        for (const nearHex of hexes) {
          if (inTrace(nearHex)) continue
          const distance = countSupplyDistanceToUnitViaTable(store.supplyFacts, {
            from: hqHex,
            unitHex: nearHex,
            side: 'axis',
            mobility: 'truck',
            maxMp: 8,
          })
          if (distance.ok && (distance.mp ?? 0) >= 6) return { hqHex, nearHex }
        }
      }
      throw new Error('地图上找不到「真断补且相距 6–8 MP」的两格')
    })()

    const hq = placeGround(store, hqRecord(), pair.hqHex, 'axis', 'hq-forage')
    const near = placeGround(
      store,
      groundRecord('axis', (r) => r.isCombat === true),
      pair.nearHex,
      'axis',
      'u-near',
    )
    store.spDumps.push({ id: 'd1', hex: { ...pair.nearHex }, side: 'axis', sp: 4, t: 0 })
    for (const unit of [hq, near]) {
      unit.cutSinceTurn = store.turn
      unit.hasTraceSupply = false
    }
    store.supplyCacheHoldings.axis = 1
    store.supplyPhaseInputs = { availableT: 0, eatOffTheMap: { [near.instanceId]: true } }

    expect(store.planSupplyPhaseNow()).toBe(true)
    const before = store.supplyPhasePlan?.feeding.map((item) => item.unitId) ?? []
    expect(before).toContain(near.instanceId)

    expect(future(store).useForageNow(hq.instanceId)).toBe(true)
    const after = store.supplyPhasePlan?.feeding.map((item) => item.unitId) ?? []
    expect(after).not.toContain(near.instanceId)
    expect(after).not.toContain(hq.instanceId)
  })

  it('F5/F7（静态）：专规面板不再有 Shells 分支，Shells 指向炮击面板；Forage 表单待迁出', () => {
    const exclusive = readFileSync('src/components/exclusive/ExclusiveRulesPanel.vue', 'utf8')
    expect(exclusive).not.toMatch(/use === 'shells'/)
    expect(exclusive).not.toMatch(/barrageCostT/)
    expect(exclusive).toMatch(/Shells 请在炮击面板/)
    // 实现后：Forage 表单整体消失（入口迁到补给阶段 D 段），故这里断言不再有「用法」下拉
    expect(exclusive).not.toMatch(/用法\s*<select/)
  })
})
