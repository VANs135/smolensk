import { describe, expect, it } from 'vitest'

import {
  isReserveMarkerGroupInUse,
  placeReserveMarkersAtEntry,
  rebuildReserveMarkerLedger,
  reserveMarkersInUse,
  reserveQuarterMa,
  type ReserveMarkerLedger,
} from '@/engine/rules'

/**
 * 5.4a / 5.7 预备标记账本（电子版＝额度）
 *
 * 口径（原文 + 用户 2026-11-06 裁定）：
 *   ① 准入：已耗 MP ≤ 当前面 MA 的 1/4（0 MP 也满足）——在 `move-interaction.test.ts` 里断言；
 *   ② **转入预备那一刻即占额度**；
 *   ③ 一个标记覆盖"堆叠中一部分单位"，同组只占一枚；
 *   ④ 组内**部分释放**（5.7b）**不归还**，整组走空（5.7b / 5.7d / 5.10c）才归还。
 */

const cap = (axis: number, soviet: number): Record<'axis' | 'soviet', number> => ({ axis, soviet })

function emptyLedger(over: Partial<ReserveMarkerLedger> = {}): ReserveMarkerLedger {
  return { cap: cap(2, 2), groups: [], ...over }
}

describe('5.4a 计量单位＝标记（覆盖组）', () => {
  it('同批转入的两枚共占一枚（5.4a「堆叠中一部分单位」）', () => {
    const result = placeReserveMarkersAtEntry({
      ledger: emptyLedger({ cap: cap(1, 0) }),
      side: 'axis',
      origin: '10.10',
      enteringIds: ['u1', 'u2'],
      isReserveUnit: () => false,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.ledger.groups).toHaveLength(1)
    expect(result.data.ledger.groups[0]!.unitIds).toEqual(['u1', 'u2'])
    expect(reserveMarkersInUse(result.data.ledger, 'axis', () => true)).toBe(1)
  })

  it('并入同格已有预备组不占新额度（`mergeGroupId`）', () => {
    const first = placeReserveMarkersAtEntry({
      ledger: emptyLedger({ cap: cap(1, 0) }),
      side: 'axis',
      origin: '10.10',
      enteringIds: ['u1'],
      isReserveUnit: () => false,
    })
    if (!first.ok) throw new Error('第一组应可放置')
    const second = placeReserveMarkersAtEntry({
      ledger: first.data.ledger,
      side: 'axis',
      origin: '10.10',
      enteringIds: ['u2'],
      isReserveUnit: (id) => id === 'u1',
      mergeGroupId: first.data.groupId ?? undefined,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.ledger.groups).toHaveLength(1)
    expect(second.data.groupId).toBe(first.data.groupId)
    expect(second.data.ledger.groups[0]!.unitIds).toEqual(['u1', 'u2'])
  })

  it('不同格转入是不同组（各组各占一枚）', () => {
    const first = placeReserveMarkersAtEntry({
      ledger: emptyLedger(),
      side: 'axis',
      origin: '10.10',
      enteringIds: ['u1'],
      isReserveUnit: () => false,
    })
    if (!first.ok) throw new Error('第一组应可放置')
    const second = placeReserveMarkersAtEntry({
      ledger: first.data.ledger,
      side: 'axis',
      origin: '11.11',
      enteringIds: ['u2'],
      isReserveUnit: () => false,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.ledger.groups).toHaveLength(2)
  })
})

describe('5.4a 额度上限与拒绝', () => {
  it('池空（cap 0）⇒ 拒绝，规则号 5.4a / noReserveMarkerAvailable', () => {
    const result = placeReserveMarkersAtEntry({
      ledger: emptyLedger({ cap: cap(0, 0) }),
      side: 'axis',
      origin: '10.10',
      enteringIds: ['u1'],
      isReserveUnit: () => false,
    })
    expect(result).toMatchObject({
      ok: false,
      rule: '5.4a',
      reason: 'noReserveMarkerAvailable:axis',
    })
  })

  it('并发达上限时第 N+1 组被拒（cap 1，两组已占）', () => {
    const first = placeReserveMarkersAtEntry({
      ledger: emptyLedger({ cap: cap(1, 0) }),
      side: 'axis',
      origin: '10.10',
      enteringIds: ['u1'],
      isReserveUnit: () => false,
    })
    if (!first.ok) throw new Error('第一组应可放置')
    const second = placeReserveMarkersAtEntry({
      ledger: first.data.ledger,
      side: 'axis',
      origin: '11.11',
      enteringIds: ['u2'],
      isReserveUnit: (id) => id === 'u1',
    })
    expect(second).toMatchObject({ ok: false, rule: '5.4a' })
  })

  it('cap 为 null（剧本未给）⇒ 不校验', () => {
    const result = placeReserveMarkersAtEntry({
      ledger: { cap: null, groups: [] },
      side: 'soviet',
      origin: '1.1',
      enteringIds: ['u9'],
      isReserveUnit: () => false,
    })
    expect(result.ok).toBe(true)
  })
})

describe('5.4a + 5.7b 部分释放与归还时点', () => {
  /**
   * 5.7b 原句：「A player can release a unit and have it move and overrun before deciding to
   * release other Reserves.」⇒ **部分释放合法**；但一枚标记覆盖的是"部分堆叠"这个整体，
   * 组里只要还有预备成员，这枚就仍被占着 ⇒ **部分释放不归还额度**。
   */
  it('部分释放不归还：组内还有预备成员 ⇒ 仍占 1 枚，新组被拒', () => {
    const ledger: ReserveMarkerLedger = {
      cap: cap(1, 0),
      groups: [{ id: 'g1', side: 'axis', unitIds: ['u1', 'u2'] }],
    }
    expect(isReserveMarkerGroupInUse(ledger.groups[0]!, (id) => id === 'u2')).toBe(true)
    expect(reserveMarkersInUse(ledger, 'axis', (id) => id === 'u2')).toBe(1)
    const next = placeReserveMarkersAtEntry({
      ledger,
      side: 'axis',
      origin: '20.20',
      enteringIds: ['u3'],
      isReserveUnit: (id) => id === 'u2',
    })
    expect(next).toMatchObject({ ok: false, rule: '5.4a' })
  })

  it('整组走空才归还：全部释放后额度可再用', () => {
    const ledger: ReserveMarkerLedger = {
      cap: cap(1, 0),
      groups: [{ id: 'g1', side: 'axis', unitIds: ['u1', 'u2'] }],
    }
    expect(reserveMarkersInUse(ledger, 'axis', () => false)).toBe(0)
    const next = placeReserveMarkersAtEntry({
      ledger,
      side: 'axis',
      origin: '20.20',
      enteringIds: ['u3'],
      isReserveUnit: () => false,
    })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    // 走空的老条目保留在账本里（不回收 id），但不计入占用
    expect(next.data.ledger.groups).toHaveLength(2)
    expect(reserveMarkersInUse(next.data.ledger, 'axis', (id) => id === 'u3')).toBe(1)
  })

  it('重新转入：整组走空后在同格再进 ⇒ 新组（占新额度），不会复用老条目', () => {
    const ledger: ReserveMarkerLedger = {
      cap: cap(1, 0),
      groups: [{ id: 'g1', side: 'axis', unitIds: ['u1'] }],
    }
    const again = placeReserveMarkersAtEntry({
      ledger,
      side: 'axis',
      origin: '10.10',
      enteringIds: ['u1'],
      isReserveUnit: () => false,
    })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.data.groupId).not.toBe('g1')
    expect(again.data.ledger.groups).toHaveLength(2)
  })
})

describe('5.4a 读档重建（从 session.log 反推，不新增存档字段）', () => {
  it('按时间顺序重放：同 id 的条目并入同一组', () => {
    const ledger = rebuildReserveMarkerLedger(
      [
        { groupId: 'g1', side: 'axis', unitIds: ['u1'] },
        { groupId: 'g1', side: 'axis', unitIds: ['u2'] },
        { groupId: 'g2', side: 'axis', unitIds: ['u3'] },
      ],
      cap(2, 0),
    )
    expect(ledger.groups).toHaveLength(2)
    expect(ledger.groups[0]!.unitIds).toEqual(['u1', 'u2'])
    expect(reserveMarkersInUse(ledger, 'axis', (id) => id === 'u2' || id === 'u3')).toBe(2)
  })

  it('重放后额度仍按当前模式实时判定（部分释放不归还）', () => {
    const ledger = rebuildReserveMarkerLedger(
      [{ groupId: 'g1', side: 'axis', unitIds: ['u1', 'u2'] }],
      cap(1, 0),
    )
    expect(reserveMarkersInUse(ledger, 'axis', (id) => id === 'u2')).toBe(1)
  })
})

describe('5.4a 25% 边界', () => {
  it('U4 绝不取整：MA 5 的 25% 是 1.25（不是 1）', () => {
    expect(reserveQuarterMa(5)).toBe(1.25)
    expect(reserveQuarterMa(6)).toBe(1.5)
  })
})
