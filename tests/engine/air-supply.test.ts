import { describe, expect, it } from 'vitest'
import { planAirSupplyLoad, settleAirSupply } from '@/engine/rules/air-supply'
import { resolveAirTransportDelivery } from '@/engine/rules/air-interaction'

const hex = { col: 20, row: 20 }
function plan(requestedT = 3) {
  return planAirSupplyLoad({
    side: 'axis',
    requestedT,
    origins: [{ hex, offMap: false }],
    sources: [
      { id: 'a', hex, side: 'axis', sp: 0, t: 2 },
      { id: 'b', hex, side: 'axis', sp: 1, t: 0 },
    ],
  })
}
describe('12.1a / 14.9：空运SP实物账本', () => {
  it('同基地可合并实际库存，找零与逐T货单精确对应', () => {
    const result = plan()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.debits).toEqual([
      { id: 'a', after: { sp: 0, t: 0 } },
      { id: 'b', after: { sp: 0, t: 3 } },
    ])
    expect(result.data.manifest!.items.map((item) => item.sourceId)).toEqual(['a', 'a', 'b'])
  })
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '非法数量 %s 在建单前拒绝',
    (quantity) => {
      expect(plan(quantity)).toMatchObject({ ok: false, reason: 'invalidAirSupplyQuantity' })
    },
  )
  it('库存不足不能借用异地、敌军或载货卡车的SP', () => {
    expect(
      planAirSupplyLoad({
        side: 'axis',
        requestedT: 1,
        origins: [{ hex, offMap: false }],
        sources: [
          { id: 'enemy', side: 'soviet', hex, sp: 9, t: 0 },
          { id: 'remote', side: 'axis', hex: { col: 21, row: 20 }, sp: 9, t: 0 },
          { id: 'loaded', side: 'axis', hex, sp: 9, t: 0, carriedBy: 'truck' },
        ],
      }),
    ).toMatchObject({ ok: false, reason: 'airSupplyStockInsufficient' })
    expect(plan(7)).toMatchObject({ ok: false, reason: 'airSupplyStockInsufficient' })
  })
  it('离图来源和跨基地分装不凭空生成库存', () => {
    for (const origins of [
      [{ hex, offMap: true }],
      [
        { hex, offMap: false },
        { hex: { col: 21, row: 20 }, offMap: false },
      ],
    ])
      expect(planAirSupplyLoad({ side: 'axis', requestedT: 1, origins, sources: [] }).ok).toBe(
        false,
      )
    expect(plan(0)).toMatchObject({ ok: true, data: { manifest: null, debits: [] } })
  })
  it('14.9（T15）：多起点各扣各的库存，总量相加校验', () => {
    const other = { col: 21, row: 20 }
    const result = planAirSupplyLoad({
      side: 'axis',
      requestedT: 2,
      origins: [
        { hex, offMap: false, requestedT: 1 },
        { hex: other, offMap: false, requestedT: 1 },
      ],
      sources: [
        { id: 'a', hex, side: 'axis', sp: 0, t: 2 },
        { id: 'b', hex: other, side: 'axis', sp: 0, t: 2 },
      ],
    })
    expect(result).toMatchObject({
      ok: true,
      data: {
        debits: [
          { id: 'a', after: { sp: 0, t: 1 } },
          { id: 'b', after: { sp: 0, t: 1 } },
        ],
      },
    })
    expect(
      result.ok && result.data.manifest!.items.map((item) => [item.id, item.sourceId]),
    ).toEqual([
      ['sp:1', 'a'],
      ['sp:2', 'b'],
    ])
    expect(
      planAirSupplyLoad({
        side: 'axis',
        requestedT: 2,
        origins: [
          { hex, offMap: false, requestedT: 1 },
          { hex: other, offMap: false, requestedT: 1 },
        ],
        sources: [{ id: 'a', hex, side: 'axis', sp: 0, t: 5 }],
      }),
    ).toMatchObject({ ok: false, reason: 'airSupplyStockInsufficient' })
  })
  it('同一T不能既送达又退回，重复提交也不能再结算', () => {
    const load = plan()
    if (!load.ok || load.data.manifest === null) throw new Error('fixture')
    let manifest = settleAirSupply(load.data.manifest, ['sp:1'], 'delivered')
    manifest = settleAirSupply(manifest, ['sp:2'], 'lost')
    manifest = settleAirSupply(manifest, ['sp:1', 'sp:2', 'sp:3'], 'returned')
    expect(manifest.items.map((item) => item.fate)).toEqual(['delivered', 'lost', 'returned'])
    expect(load.data.manifest.items.every((item) => item.fate === 'aboard')).toBe(true)
  })
  it('14.9：普通空运不使用空投成功表，没有虚构骰面', () => {
    const result = resolveAirTransportDelivery([{ id: 'sp:1', kind: 'sp', t: 1 }])
    expect(result).toMatchObject({
      ok: true,
      data: { items: [{ fate: 'placed', die2d6: null, threshold: null }] },
    })
  })
})
