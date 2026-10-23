import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * 条 27 / §5-C：**账本为唯一事实、地图投影账本**。
 *
 * 现状 `spDumps` 只在面板选择器里用、地图上完全看不到补给站。本组用例钉住：
 *   ① 同格多枚合并成**一枚**令牌（点数求和）；
 *   ② 不同格各自一枚；
 *   ③ 消耗（改账本）后 overlay 即时重算（贴图/角标跟着变）；
 *   ④ 空站（SP/T 都为 0）不画。
 */
describe('条 27：SP 账本 → 地图令牌', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const spTokensOf = (mv: ReturnType<typeof useMapViewStore>) =>
    mv.overlay.tokens.filter((token) => token.id.startsWith('sp:'))

  it('同格多枚合并成一枚，点数求和，label 显示实数', () => {
    const wb = useWorkbenchStore()
    const mv = useMapViewStore()
    const side = wb.activeSide
    const hex = { col: 10, row: 10 }
    wb.spDumps.push({ id: 'd1', hex: { ...hex }, side, sp: 6, t: 0 })
    wb.spDumps.push({ id: 'd2', hex: { ...hex }, side, sp: 3, t: 0 })

    const tokens = spTokensOf(mv)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ spPoints: 9, noncombatKind: 'sp', label: '9 SP' })
  })

  it('不同格各自一枚', () => {
    const wb = useWorkbenchStore()
    const mv = useMapViewStore()
    const side = wb.activeSide
    wb.spDumps.push({ id: 'd1', hex: { col: 1, row: 1 }, side, sp: 2, t: 0 })
    wb.spDumps.push({ id: 'd2', hex: { col: 2, row: 2 }, side, sp: 3, t: 0 })

    const tokens = spTokensOf(mv)
    expect(tokens).toHaveLength(2)
    expect(tokens.map((token) => token.spPoints).sort()).toEqual([2, 3])
  })

  it('消耗后即时刷新：改账本 ⇒ overlay 重算（点数/标签跟着变）', () => {
    const wb = useWorkbenchStore()
    const mv = useMapViewStore()
    const side = wb.activeSide
    wb.spDumps.push({ id: 'd1', hex: { col: 5, row: 5 }, side, sp: 9, t: 0 })

    expect(spTokensOf(mv)[0]?.spPoints).toBe(9)

    // 消耗 5 点（12.x 的扣款实际改的就是这条账本）
    wb.spDumps[0]!.sp = 4
    const after = spTokensOf(mv)[0]
    expect(after?.spPoints).toBe(4)
    expect(after?.label).toBe('4 SP')
  })

  it('空站（SP/T 都为 0）不画，避免幽灵站', () => {
    const wb = useWorkbenchStore()
    const mv = useMapViewStore()
    wb.spDumps.push({ id: 'd1', hex: { col: 7, row: 7 }, side: wb.activeSide, sp: 0, t: 0 })
    expect(spTokensOf(mv)).toHaveLength(0)
  })

  it('只有 T 的站在地图上仍可见（运输点数走运输面 B，不是"0 SP"）', () => {
    const wb = useWorkbenchStore()
    const mv = useMapViewStore()
    wb.spDumps.push({ id: 'd1', hex: { col: 8, row: 8 }, side: wb.activeSide, sp: 0, t: 3 })
    const tokens = spTokensOf(mv)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ spPoints: 3, face: 'move', label: '3 T' })
  })

  it('有整 SP 时走补给面 F（t 作为余数不改变面）', () => {
    const wb = useWorkbenchStore()
    const mv = useMapViewStore()
    wb.spDumps.push({ id: 'd1', hex: { col: 9, row: 9 }, side: wb.activeSide, sp: 2, t: 2 })
    expect(spTokensOf(mv)[0]).toMatchObject({ spPoints: 2, face: 'combat', label: '2 SP' })
  })

  it('同格合并时 sp 与 t 分别求和（不会把 T 当成 SP 加进去）', () => {
    const wb = useWorkbenchStore()
    const mv = useMapViewStore()
    const side = wb.activeSide
    wb.spDumps.push({ id: 'd1', hex: { col: 4, row: 4 }, side, sp: 1, t: 2 })
    wb.spDumps.push({ id: 'd2', hex: { col: 4, row: 4 }, side, sp: 1, t: 1 })
    // sp=2、t=3 ⇒ 有整 SP ⇒ 补给面、点数 2
    expect(spTokensOf(mv)[0]).toMatchObject({ spPoints: 2, face: 'combat', label: '2 SP' })
  })
})
