import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'
import { useGameSessionStore, useMapViewStore, useWorkbenchStore } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 12.1b + 3.4b：**同一格的 SP 是一个补给站**
 *
 * 用户裁定：
 *   · 同格多份 SP ⇒ 选源只出一条，不再出「并列来源」提示；
 *   · 3.4b 勾选且 8.19 前，同格轴方 SP 按集群拆成 Guderian / Hoth 两个算子显示（仅显示与付款口径，
 *     总量仍是同格总量）；
 *   · 德军多单位编队只能扣本集群，错集群被拒（3.4b）；
 *   · 德军非编队单位在同格两集群并存时**可二选一**，只有一个集群有 SP 时自动扣、不出选择；
 *   · 苏联单位始终视为单站，不出现集群选择；8.19 之后不再拆、不再要求选择。
 */

function newStore(): Workbench {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  const session = useGameSessionStore()
  const index = session.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM)
  if (index < 0) throw new Error('开场共识清单里没有 3.4b 这一条')
  session.setAgreedCheck(index, true)
  return store
}

function placeAxis(store: Workbench, formation: 'none' | 'guderian') {
  const record = groundRecord(
    'axis',
    (item) =>
      item.isCombat === true &&
      item.attackCapable === true &&
      (item.reSize ?? 0) > 0 &&
      (formation === 'none' ? item.panzerGroup == null : item.panzerGroup === 'guderian'),
  )
  return placeGround(store, record, CORE_HEX, 'axis', formation === 'none' ? 'plain' : 'gud')
}

function placeSoviet(store: Workbench) {
  const record = groundRecord(
    'soviet',
    (item) => item.isCombat === true && item.attackCapable === true && (item.reSize ?? 0) > 0,
  )
  const unit = placeGround(store, record, CORE_HEX, 'soviet', 'sov')
  store.setActiveSide('soviet')
  return unit
}

/** 同格两座补给站：Guderian 4 SP + Hoth 3 SP（账本两条，id 各带归属） */
function twoGroupDumps(store: Workbench): void {
  store.spDumps.push({ id: 'sd-g', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 })
  store.spDumps.push({ id: 'sd-h', hex: { ...CORE_HEX }, side: 'axis', sp: 3, t: 0 })
  store.setDumpPanzerGroupNow('sd-g', 'guderian')
  store.setDumpPanzerGroupNow('sd-h', 'hoth')
}

function begin(store: Workbench, instanceId: string): void {
  // 12.6a：本格须有补给源声明，单位才有追溯补给 ⇒ 才会走到「选来源」步
  store.supplySourceDraft = { hexText: `${CORE_HEX.col}.${CORE_HEX.row}`, kind: 'supplySourceHex' }
  expect(store.addSupplySource()).toBe(true)
  store.setSupplyActive(true)
  store.setPhase('supply')
  expect(store.beginSupplyCheckNow(instanceId)).toBe(true)
}

const spOf = (store: Workbench, id: string): number =>
  store.spDumps.find((dump) => dump.id === id)?.sp ?? -1

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('12.1b 同格多 SP：一个补给站、一条来源', () => {
  it('同格两座账本（不同集群）⇒ 选源只出一条，点格不再提示「并列」', () => {
    const store = newStore()
    store.setTurn(12)
    expect(store.panzerGroupRulesOn).toBe(true)
    const unit = placeAxis(store, 'none')
    twoGroupDumps(store)
    begin(store, unit.instanceId)

    const dumpSources = store.supplySources.filter((source) => source.kind === 'dump')
    expect(dumpSources.length).toBe(2)
    // 面板来源按集群拆成两个算子（3.4b），仍是同一格
    const groups = store.supplySourceGroups.filter((item) => item.source.kind === 'dump')
    expect(groups.map((item) => item.group).sort()).toEqual(['guderian', 'hoth'])

    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(true)
    expect(store.log.some((entry) => entry.text.includes('并列'))).toBe(false)
    expect(store.supplyState?.step).toBe('pickup')
  })

  it('3.4b 未生效（8.19 起）⇒ 同格合并为一条来源、一个算子', () => {
    const store = newStore()
    store.setTurn(13)
    expect(store.panzerGroupRulesOn).toBe(false)
    const unit = placeAxis(store, 'none')
    twoGroupDumps(store)
    begin(store, unit.instanceId)

    const groups = store.supplySourceGroups.filter((item) => item.source.kind === 'dump')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.group).toBeNull()
  })
})

describe('3.4b：同格双集群的算子选择（非编队）', () => {
  it('双集群并存 ⇒ 非编队德军可二选一，扣对应账本；总量不变', () => {
    const store = newStore()
    store.setTurn(12)
    const unit = placeAxis(store, 'none')
    twoGroupDumps(store)
    begin(store, unit.instanceId)
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(true)

    expect(store.supplyPayDumpCandidates.map((dump) => dump.id).sort()).toEqual(['sd-g', 'sd-h'])
    store.toggleSupplyPayDump('sd-h')
    store.supplyInputs = { ...store.supplyInputs, purpose: 'fuel' }
    expect(store.confirmSupplyPickupNow()).toBe(true)
    expect(spOf(store, 'sd-h')).toBeLessThan(3)
    expect(spOf(store, 'sd-g')).toBe(4)
  })

  it('只有一个集群有 SP ⇒ 不出选择、直接扣该站', () => {
    const store = newStore()
    store.setTurn(12)
    const unit = placeAxis(store, 'none')
    store.spDumps.push({ id: 'sd-g', hex: { ...CORE_HEX }, side: 'axis', sp: 4, t: 0 })
    store.setDumpPanzerGroupNow('sd-g', 'guderian')
    begin(store, unit.instanceId)
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(true)

    expect(store.supplyPayDumpCandidates).toHaveLength(0)
    store.supplyInputs = { ...store.supplyInputs, purpose: 'fuel' }
    expect(store.confirmSupplyPickupNow()).toBe(true)
    expect(spOf(store, 'sd-g')).toBeLessThan(4)
  })
})

describe('3.4b：多单位编队强制本集群', () => {
  it('Guderian 编队选了 Hoth 的算子 ⇒ 拒付（3.4b），账本不动', () => {
    const store = newStore()
    store.setTurn(12)
    const unit = placeAxis(store, 'guderian')
    twoGroupDumps(store)
    begin(store, unit.instanceId)
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(true)

    store.toggleSupplyPayDump('sd-h')
    store.supplyInputs = { ...store.supplyInputs, purpose: 'fuel' }
    expect(store.confirmSupplyPickupNow()).toBe(false)
    expect(spOf(store, 'sd-h')).toBe(3)
    expect(spOf(store, 'sd-g')).toBe(4)
    expect(store.log.some((entry) => entry.rule === '3.4b')).toBe(true)
  })

  it('Guderian 编队自动取到本集群算子（未点选）⇒ 通过', () => {
    const store = newStore()
    store.setTurn(12)
    const unit = placeAxis(store, 'guderian')
    twoGroupDumps(store)
    begin(store, unit.instanceId)
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(true)

    store.supplyInputs = { ...store.supplyInputs, purpose: 'fuel' }
    expect(store.confirmSupplyPickupNow()).toBe(true)
    expect(spOf(store, 'sd-g')).toBeLessThan(4)
    expect(spOf(store, 'sd-h')).toBe(3)
  })
})

describe('3.4b：苏军与失效期', () => {
  it('苏军同格多份 SP ⇒ 无集群选择（始终单站）', () => {
    const store = newStore()
    store.setTurn(12)
    const unit = placeSoviet(store)
    store.spDumps.push({ id: 'sv-1', hex: { ...CORE_HEX }, side: 'soviet', sp: 2, t: 0 })
    store.spDumps.push({ id: 'sv-2', hex: { ...CORE_HEX }, side: 'soviet', sp: 2, t: 0 })
    begin(store, unit.instanceId)
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(true)

    expect(store.supplyPayDumpCandidates).toHaveLength(0)
    expect(store.supplySourceGroups.filter((item) => item.source.kind === 'dump')).toHaveLength(1)
  })

  it('8.19 之后 ⇒ 不拆算子、不要求选择', () => {
    const store = newStore()
    store.setTurn(13)
    const unit = placeAxis(store, 'guderian')
    twoGroupDumps(store)
    begin(store, unit.instanceId)
    expect(store.pickSupplySourceAtHexNow(CORE_HEX)).toBe(true)

    expect(store.supplyPayDumpCandidates).toHaveLength(0)
    store.supplyInputs = { ...store.supplyInputs, purpose: 'fuel' }
    expect(store.confirmSupplyPickupNow()).toBe(true)
  })
})

describe('3.4b：地图上两个算子', () => {
  it('生效期内同格按集群拆成两枚令牌（G/H 标注）；失效后并回一枚', () => {
    const store = newStore()
    store.setTurn(12)
    twoGroupDumps(store)
    const view = useMapViewStore()
    const tokens = (): ReturnType<typeof view.overlay.tokens.filter> =>
      view.overlay.tokens.filter((token) => token.id.startsWith('sp:'))
    expect(
      tokens()
        .map((token) => token.label)
        .sort(),
    ).toEqual(['G 4 SP', 'H 3 SP'])

    store.setTurn(13)
    expect(tokens()).toHaveLength(1)
    expect(tokens()[0]?.label).toBe('7 SP')
  })
})
