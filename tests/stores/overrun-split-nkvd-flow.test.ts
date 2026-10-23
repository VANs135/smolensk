import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { splitOverrunStack } from '@/engine/rules'
import { nkvdArRequired } from '@/engine/rules/nkvd'
import { useWorkbenchStore } from '@/stores'

import { CORE_HEX, combatRecord, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * M6⑤ 的收口回归（表模块与 `rules/` 同答）见 `tests/engine/tables/tables.test.ts`；
 * 本文件覆盖 **M6⑥⑧**：8.1g/h 的突袭堆叠拆分 与 专规 2.3b 的 NKVD 行动值要求。
 *
 * 条文：
 *   · **8.1g**「一个堆叠进行突袭时，堆叠中的**部分单位**可以留在原地。」
 *   · **8.1h** 留驻单位**仍计入** 4.8a 的堆叠上限判定，但**不参突、也不受突袭结果影响**。
 *   · **专规 2.3b**「堆叠内有 NKVD 边防团时，守方的行动值单位**必须**由它担任，
 *     且守方全部选项都吃成军力损失（不许撤退抵消）」。
 *
 * ★ 修前 `splitOverrunStack` 与 `nkvdArRequired` **零消费**：突袭一律「整堆叠参突」
 *   （8.1g 的部分参突无法表达），面板上的守方 AR 候选也不受 2.3b 约束
 *   （只能靠引擎在宣布时否决，玩家得先选错再被拒）。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('8.1g / 8.1h：突袭堆叠的拆分（引擎唯一实现）', () => {
  it('引擎：按参突名单分「参突 / 留驻」，原格战斗 RE 只计战斗单位', () => {
    const split = splitOverrunStack({
      side: 'axis',
      friendlyUnits: [
        { id: 'a', re: 4, isCombat: true },
        { id: 'b', re: 2, isCombat: true },
        { id: 'c', re: 1, isCombat: false },
      ],
      participantIds: ['a'],
    })
    expect(split.participantIds).toEqual(['a'])
    expect(split.stayIds).toEqual(['b', 'c'])
    // 4.8a：原格战斗 RE 只算战斗单位（b 的 2 RE；非战斗的 c 不计）
    expect(split.originStackRe).toBe(6)
    expect(split.rule).toBe('8.1g')
  })

  it('store：不勾选时＝仍在移动的全部单位（与修前行为一致）', () => {
    const store = newStore()
    const record = combatRecord('axis')
    const a = placeGround(store, record, CORE_HEX, 'axis', 'a1')
    const b = placeGround(store, record, CORE_HEX, 'axis', 'a2')
    store.moveInteraction = { unitIds: ['a1', 'a2'], records: [], step: 'moving' } as never
    // 未勾选任何人 ⇒ 拆分里全部参突、无人留驻
    const split = store.overrunSplitNow
    expect(split).not.toBeNull()
    expect(split!.participantIds.sort()).toEqual([a.instanceId, b.instanceId].sort())
    expect(split!.stayIds).toEqual([])
  })

  it('store：勾选其一 ⇒ 只有它参突，另一枚留驻（8.1g）', () => {
    const store = newStore()
    const record = combatRecord('axis')
    const a = placeGround(store, record, CORE_HEX, 'axis', 'a1')
    const b = placeGround(store, record, CORE_HEX, 'axis', 'a2')
    store.moveInteraction = { unitIds: ['a1', 'a2'], records: [], step: 'moving' } as never
    store.toggleOverrunParticipant(a.instanceId)

    const split = store.overrunSplitNow!
    expect(split.participantIds).toEqual([a.instanceId])
    expect(split.stayIds).toEqual([b.instanceId])
    // 再点一次取消勾选 ⇒ 回到「全部参突」
    store.toggleOverrunParticipant(a.instanceId)
    expect(store.overrunSplitNow!.stayIds).toEqual([])
  })
})

describe('专规 2.3b：NKVD 边防团强制担任守方行动值单位', () => {
  it('引擎：判据是能力标签 `nkvd_border_forced_roll`（不按番号推定）', () => {
    expect(nkvdArRequired([{ id: 'n1', specialAbilities: ['nkvd_border_forced_roll'] }])).toBe(true)
    expect(nkvdArRequired([{ id: 'p1', specialAbilities: ['engineering'] }])).toBe(false)
    expect(nkvdArRequired([])).toBe(false)
  })

  it('store：守方候选表在被迫时**收窄到 NKVD**；无 NKVD 时与全部候选一致', () => {
    const store = newStore()
    const nkvdRecord = groundRecord('soviet', (item) =>
      (item.specialAbilities ?? []).includes('nkvd_border_forced_roll'),
    )
    const plainRecord = groundRecord(
      'soviet',
      (item) => item.isCombat === true && item.attackCapable === true,
    )
    // 造一场战斗：把 NKVD 团与普通战斗单位都作为守方
    const nkvd = placeGround(store, nkvdRecord, CORE_HEX, 'soviet', 'def-nkvd')
    const plain = placeGround(store, plainRecord, CORE_HEX, 'soviet', 'def-plain')
    store.battleTarget = { hex: { ...CORE_HEX }, defenderIds: [nkvd.instanceId, plain.instanceId] }

    expect(store.nkvdArRequiredNow).toBe(true)
    // 2.3b：候选表只剩 NKVD（界面上选不出违规的行动值单位）
    expect(store.combatDefenderArChoices.map((option) => option.id)).toEqual([nkvd.instanceId])
    // 全部候选仍可见（供对照与说明）
    expect(store.combatDefenderArOptions.map((option) => option.id)).toEqual([
      nkvd.instanceId,
      plain.instanceId,
    ])
  })

  it('store：守方没有 NKVD 时两表一致（不误收窄）', () => {
    const store = newStore()
    const plainRecord = groundRecord(
      'soviet',
      (item) => item.isCombat === true && item.attackCapable === true,
    )
    const plain = placeGround(store, plainRecord, CORE_HEX, 'soviet', 'def-1')
    store.battleTarget = { hex: { ...CORE_HEX }, defenderIds: [plain.instanceId] }
    expect(store.nkvdArRequiredNow).toBe(false)
    expect(store.combatDefenderArChoices).toEqual(store.combatDefenderArOptions)
  })
})
