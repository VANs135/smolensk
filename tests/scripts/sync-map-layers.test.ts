import { describe, expect, it } from 'vitest'

import {
  PRINTED_HEDGEHOG_EXCLUSIONS,
  selectPrintedHedgehogs,
} from '../../scripts/sync-map-layers.mjs'

/** 源库工事条目的最小形状 */
function facility(hexId: string, kind = 'printed_hedgehog') {
  return { kind, hex_id: hexId, level: 1, permanent: true, cannot_reduce: true }
}

/**
 * 印刷永久工事筛选单测（门禁加固 B0①）
 *
 * 两处人工改判：36.18（2026-09-14 目检）与 7.8（2026-09-15 像素复核，用户指出），
 * 权威源仍含这两条。若脚本不显式排除，重跑就会把它们恢复回来，使产物与剧本归属账本自相矛盾。
 */
describe('印刷永久工事筛选', () => {
  it('排除 36.18 与 7.8，其余原样进入产物', () => {
    const out = selectPrintedHedgehogs([
      facility('36.17'),
      facility('36.18'),
      facility('36.19'),
      facility('7.7'),
      facility('7.8'),
      facility('7.9'),
    ])
    const labels = out.map((item) => `${item.col}.${item.row}`)
    expect(labels).toEqual(['36.17', '36.19', '7.7', '7.9'])
  })

  it('只收印刷工事：同格的其它 kind 不进入产物', () => {
    // 排除项必须留在输入里，否则会先触发「排除项在源库中已不存在」的保护
    const out = selectPrintedHedgehogs([
      facility('36.17', 'airbase'),
      facility('36.17'),
      facility('36.18'),
      facility('7.8'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ col: 36, row: 17, permanent: true, cannotReduce: true })
  })

  it('源库已不含排除项时抛错（避免排除项退化为永不生效的死规则）', () => {
    expect(() => selectPrintedHedgehogs([facility('36.17'), facility('7.8')])).toThrow(/36\.18/)
    expect(() => selectPrintedHedgehogs([facility('36.17'), facility('36.18')])).toThrow(/7\.8/)
  })

  it('排除清单是可审计的显式常量', () => {
    expect([...PRINTED_HEDGEHOG_EXCLUSIONS]).toEqual(['36.18', '7.8'])
  })
})
