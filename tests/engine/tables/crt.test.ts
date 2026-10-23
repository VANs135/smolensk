import { describe, expect, it } from 'vitest'

import { chartsCrt } from '@/data'
import { crtLookup, CRT_TERRAIN_TYPES } from '@/engine/tables'

/**
 * CRT 取表黄金样本（数据源 charts-crt.json，源自已双重核验的 195 格矩阵）
 */

describe('crtLookup（9.9）', () => {
  it('按掷骰行与 Close 地形列位取格（黄金样本）', () => {
    const closeColumns = chartsCrt.crt.terrainColumns['Close']!
    const result = crtLookup(8, 'Close', '3:1')
    expect(closeColumns.indexOf('3:1')).toBe(5)
    expect(result.columnIndex).toBe(5)
    expect(result.code).toBe('Ao1 Do1') // rows['8'] 第 6 格
  })

  it('掷骰行支持有界区标（≤1 与 ≥15）', () => {
    expect(crtLookup(1, 'Open', '1:1').rowLabel).toBe('1 or less')
    expect(crtLookup(0, 'Open', '1:1').rowLabel).toBe('1 or less')
    expect(crtLookup(16, 'Open', '1:1').rowLabel).toBe('15 or more')
  })

  it('Open 地形下超大 odds 夹取到末列', () => {
    const result = crtLookup(8, 'Open', '20:1')
    // Open 列位最大为 '13:1'
    expect(chartsCrt.crt.terrainColumns['Open']!.at(-1)).toBe('13:1')
    expect(result.columnIndex).toBe(12)
    expect(result.code).toBe('Ae3 DL2o2DG')
  })

  it('Extr Close 首列对极小 odds 夹取到首列', () => {
    const result = crtLookup(2, 'Extr Close', '1:4')
    expect(chartsCrt.crt.terrainColumns['Extr Close']![0]).toBe('1:2')
    expect(result.columnIndex).toBe(0)
    expect(result.code).toBe('AL2')
  })

  it('矩阵尺寸：15 骰行 × 13 列，四类列位一一对应', () => {
    expect(chartsCrt.crt.matrix).toHaveLength(15)
    for (const row of chartsCrt.crt.matrix) {
      expect(row).toHaveLength(13)
    }
    for (const terrain of CRT_TERRAIN_TYPES) {
      expect(chartsCrt.crt.terrainColumns[terrain]).toHaveLength(13)
    }
  })

  it('非法地形类抛错', () => {
    expect(() => crtLookup(7, 'Fog' as 'Open', '1:1')).toThrow()
  })
})
