import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'
import { useGameSessionStore, useMapViewStore, useWorkbenchStore } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 3.4b：**解除日前的德军 SP 到场即归属，不再有「未归属」入口**
 *
 * 用户 2026-11-11 口径：专规 3.4 解除日（19 August）之前，任何德军 SP 到场都必须由玩家
 * 指定 Guderian / Hoth；不提供「不属任何集群」选项。初设 / 增援 / 补给列车 / 可变增援 /
 * 手工新增共用 `addSpAtHex` 这一处判据。
 *
 * 历史存档里遗留的未归属站仍按原样投影（G / H / ? 三枚令牌、来源三行），本文件同时钉住
 * 这条**只读兼容**路径；新入口不再产生未归属站。
 */

const HEX: HexRef = { col: 36, row: 13 }

function newStore(turn = 12): ReturnType<typeof useWorkbenchStore> {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  const session = useGameSessionStore()
  const index = session.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM)
  if (index < 0) throw new Error('开场共识清单里没有 3.4b 这一条')
  session.setAgreedCheck(index, true)
  store.setTurn(turn)
  return store
}

/** 手工落一条轴方 SP：带集群即当场归属，不带则走 3.4b 闸门 */
function addSp(
  store: ReturnType<typeof useWorkbenchStore>,
  sp: number,
  group?: 'guderian' | 'hoth',
): boolean {
  store.spDumpDraft = { hexText: `${HEX.col}.${HEX.row}`, sp, t: 0, panzerGroup: group ?? null }
  return store.addSpDump()
}

function seedGroups(store: ReturnType<typeof useWorkbenchStore>): void {
  store.spDumps.push({ id: 'sd-g', hex: { ...HEX }, side: 'axis', sp: 4, t: 0 })
  store.spDumps.push({ id: 'sd-h', hex: { ...HEX }, side: 'axis', sp: 3, t: 0 })
  store.setDumpPanzerGroupNow('sd-g', 'guderian')
  store.setDumpPanzerGroupNow('sd-h', 'hoth')
}

/** 旧档遗留的未归属站（新入口已不产生，这里模拟读档后的盘面） */
function seedLegacyUnassigned(store: ReturnType<typeof useWorkbenchStore>, sp: number): void {
  store.spDumps.push({ id: 'sd-legacy', hex: { ...HEX }, side: 'axis', sp, t: 0 })
}

function dumpLabels(): string[] {
  return useMapViewStore()
    .overlay.tokens.filter((token) => token.id.startsWith('sp:'))
    .map((token) => token.label)
    .sort()
}

describe('3.4b：解除日前的德军 SP 归属', () => {
  it('★ 同格已有 G/H 时再落未指定集群 ⇒ 拒收，不产生第三本', () => {
    const store = newStore()
    seedGroups(store)
    expect(addSp(store, 2)).toBe(false)
    expect(store.spDumps).toHaveLength(2)
    // 既有两本账一分没多
    expect(store.spDumps.find((dump) => dump.id === 'sd-g')!.sp).toBe(4)
    expect(store.spDumps.find((dump) => dump.id === 'sd-h')!.sp).toBe(3)
  })

  it('★ 拒收时日志留一条 3.4b 告警（不静默）', () => {
    const store = newStore()
    seedGroups(store)
    addSp(store, 2)
    expect(
      store.log.some((entry) => entry.rule === '3.4b' && entry.text.includes('未指定装甲集群')),
    ).toBe(true)
  })

  it('★ 同格已有 G/H，指定 G ⇒ 并入 G 那本（12.1a，不新建）', () => {
    const store = newStore()
    seedGroups(store)
    expect(addSp(store, 2, 'guderian')).toBe(true)
    expect(store.spDumps).toHaveLength(2)
    expect(store.spDumps.find((dump) => dump.id === 'sd-g')!.sp).toBe(6)
    expect(store.spDumps.find((dump) => dump.id === 'sd-h')!.sp).toBe(3)
  })

  it('★ 历史存档的未归属站：来源投影仍列三行 Guderian / Hoth / 未归属', () => {
    const store = newStore()
    seedGroups(store)
    seedLegacyUnassigned(store, 2)
    // 12.6a：须有一个可溯源的检查单位，引擎才会给出 sources
    const record = groundRecord(
      'axis',
      (item) =>
        item.isCombat === true &&
        item.attackCapable === true &&
        (item.reSize ?? 0) > 0 &&
        item.panzerGroup == null,
    )
    const unit = placeGround(store, record, CORE_HEX, 'axis', 'plain')
    store.supplySourceDraft = {
      hexText: `${CORE_HEX.col}.${CORE_HEX.row}`,
      kind: 'supplySourceHex',
    }
    expect(store.addSupplySource()).toBe(true)
    store.setSupplyActive(true)
    store.setPhase('supply')
    expect(store.beginSupplyCheckNow(unit.instanceId)).toBe(true)
    const groups = store.supplySourceGroups.filter((row) => row.source.kind === 'dump')
    expect(groups.map((row) => row.group).sort()).toEqual(['guderian', 'hoth', null].sort())
  })

  it('★ 历史存档的未归属站：地图仍画第三枚令牌（G / H / ?）', () => {
    const store = newStore()
    seedGroups(store)
    seedLegacyUnassigned(store, 2)
    expect(dumpLabels()).toEqual(['? 2 SP', 'G 4 SP', 'H 3 SP'])
  })

  it('★ 3.4b 未生效（19 August 后）：同格落账照旧合并，不要求归属', () => {
    const store = newStore(13)
    expect(addSp(store, 4)).toBe(true)
    expect(addSp(store, 2)).toBe(true)
    expect(store.spDumps).toHaveLength(1)
    expect(store.spDumps[0]!.sp).toBe(6)
    expect(store.log.some((entry) => entry.rule === '3.4b')).toBe(false)
  })
})
