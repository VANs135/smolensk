import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'
import { useGameSessionStore, useMapViewStore, useWorkbenchStore } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 3.4b：**未归属 SP 不得静默并入已归属站**
 *
 * 用户 2026-11-09 裁定：
 *   · 同格若真出现未归属 SP，单独画第三枚「未归属」比并进首条清楚；
 *   · 3.4b 生效期内本不该出现未归属，出现了就说明有漏 ⇒ 日志留一条告警，不要静默合并。
 *
 * 同时钉住：只有**纯未归属**的同格落账才继续 12.1a 合并（否则待归属那套全失效）。
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

/** 手工落一条轴方 SP（不带 panzerGroup ⇒ 走"未声明归属"那条路） */
function addUnassigned(store: ReturnType<typeof useWorkbenchStore>, sp: number): void {
  store.spDumpDraft = { hexText: `${HEX.col}.${HEX.row}`, sp, t: 0 }
  expect(store.addSpDump()).toBe(true)
}

function seedGroups(store: ReturnType<typeof useWorkbenchStore>): void {
  store.spDumps.push({ id: 'sd-g', hex: { ...HEX }, side: 'axis', sp: 4, t: 0 })
  store.spDumps.push({ id: 'sd-h', hex: { ...HEX }, side: 'axis', sp: 3, t: 0 })
  store.setDumpPanzerGroupNow('sd-g', 'guderian')
  store.setDumpPanzerGroupNow('sd-h', 'hoth')
}

function dumpLabels(): string[] {
  return useMapViewStore()
    .overlay.tokens.filter((token) => token.id.startsWith('sp:'))
    .map((token) => token.label)
    .sort()
}

describe('3.4b：同格未归属 SP', () => {
  it('★ 同格已有 G/H 时再落一份未归属 ⇒ 单独第三本账，不动既有两本', () => {
    const store = newStore()
    seedGroups(store)
    addUnassigned(store, 2)
    expect(store.spDumps).toHaveLength(3)
    const fresh = store.spDumps.find((dump) => dump.id !== 'sd-g' && dump.id !== 'sd-h')!
    expect(store.panzerGroupOfDump(fresh.id)).toBeNull()
    expect(fresh.sp).toBe(2)
    // 既有两本账一分没多
    expect(store.spDumps.find((dump) => dump.id === 'sd-g')!.sp).toBe(4)
    expect(store.spDumps.find((dump) => dump.id === 'sd-h')!.sp).toBe(3)
  })

  it('★ 未归属出现时日志留一条 3.4b 告警（不静默）', () => {
    const store = newStore()
    seedGroups(store)
    addUnassigned(store, 2)
    expect(
      store.log.some(
        (entry) => entry.rule === '3.4b' && entry.text.includes('未归属') && entry.kind !== 'info',
      ),
    ).toBe(true)
  })

  it('★ 来源投影三行：Guderian / Hoth / 未归属', () => {
    const store = newStore()
    seedGroups(store)
    addUnassigned(store, 2)
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

  it('★ 地图画第三枚未归属令牌（G / H / ?）', () => {
    const store = newStore()
    seedGroups(store)
    addUnassigned(store, 2)
    expect(dumpLabels()).toEqual(['? 2 SP', 'G 4 SP', 'H 3 SP'])
  })

  it('★ 同格只有未归属站时，再加未归属 SP 仍按 12.1a 合并（不产生第二本）', () => {
    const store = newStore()
    addUnassigned(store, 4)
    addUnassigned(store, 2)
    expect(store.spDumps).toHaveLength(1)
    expect(store.spDumps[0]!.sp).toBe(6)
  })

  it('★ 3.4b 未生效：同格落账照旧合并（不进第三本、不告警）', () => {
    const store = newStore(13)
    addUnassigned(store, 4)
    addUnassigned(store, 2)
    expect(store.spDumps).toHaveLength(1)
    expect(store.spDumps[0]!.sp).toBe(6)
    expect(store.log.some((entry) => entry.rule === '3.4b')).toBe(false)
  })
})
