import { describe, expect, it } from 'vitest'

import { mapConfig } from '@/data'
import {
  centerByCalibration,
  parseHexRef,
  verifyCalibration,
} from '../../scripts/sync-map-config.mjs'

/** A3 网格标定加载冒烟 + 同步脚本转换函数（数据源 map_hexes / entry_hexes / rules，2026-09-12 标定） */
describe('map-config.json 网格标定', () => {
  it('几何：flat-top、偶数列下移半格（even-q）', () => {
    expect(mapConfig.orientation).toBe('flat')
    expect(mapConfig.offset).toBe('even-q')
    expect(mapConfig.geometry.hexWidthPx).toBe(94.905)
    expect(mapConfig.geometry.hexHeightPx).toBe(109.584)
    expect(mapConfig.geometry.originX).toBe(112.5)
    expect(mapConfig.geometry.originY).toBe(3947.5)
  })

  it('行列范围：col 1–62 × row 0–35', () => {
    expect(mapConfig.bounds).toEqual({ colStart: 1, colEnd: 62, rowStart: 0, rowEnd: 35 })
  })

  it('rowDecode 恒等（印刷行 = 程序行，无需转换）', () => {
    expect(mapConfig.rowDecode).toEqual({})
  })

  it('入口字母聚合为坐标列表（A 对应东缘多格）', () => {
    const letters = Object.keys(mapConfig.entryHexes!).sort()
    expect(letters.length).toBe(12) // A–L
    expect(letters[0]).toBe('A')
    const a = mapConfig.entryHexes!['A']!
    expect(a.length).toBeGreaterThan(1)
    for (const hex of a) {
      expect(hex.col).toBe(62) // Entry A 在东缘
    }
  })

  it('胜利格 11 处（5.0c 通用清单）', () => {
    expect(mapConfig.victoryLocations).toHaveLength(11)
    expect(mapConfig.victoryLocations!).toContainEqual({ col: 36, row: 13 }) // Pochinok
    expect(mapConfig.victoryLocations!).toContainEqual({ col: 48, row: 25 }) // Pusii
    expect(mapConfig.victoryLocations!).toContainEqual({ col: 52, row: 9 }) // Spas Demyansk
  })

  it('分界线端点：19.19 → 62.23（专规 3.4a）', () => {
    expect(mapConfig.panzerGroupBoundary![0]).toEqual([
      { col: 19, row: 19 },
      { col: 62, row: 23 },
    ])
  })

  it('深度冻结（嵌套不可写）', () => {
    expect(Object.isFrozen(mapConfig)).toBe(true)
    expect(Object.isFrozen(mapConfig.geometry)).toBe(true)
    expect(Object.isFrozen(mapConfig.entryHexes)).toBe(true)
    expect(Object.isFrozen(mapConfig.victoryLocations)).toBe(true)
    expect(Object.isFrozen(mapConfig.victoryLocations![0])).toBe(true)
  })
})

describe('sync-map-config 转换函数（脚本级）', () => {
  it('格心公式与标定 VERIFIED 公式一致（flat-top、偶数列偏移、首末列）', () => {
    const a = centerByCalibration(1, 1)
    expect(a[0]).toBeCloseTo(112.5, 5)
    expect(a[1]).toBeCloseTo(3837.916, 3)

    const b = centerByCalibration(2, 1) // 偶数列下移半格
    expect(b[0]).toBeCloseTo(207.405, 5)
    expect(b[1]).toBeCloseTo(3837.916 - 54.792, 3)

    const c = centerByCalibration(62, 33) // 末列南缘
    expect(c[0]).toBeCloseTo(112.5 + 61 * 94.905, 3)
    expect(c[1]).toBeCloseTo(3947.5 - 33 * 109.584 - 54.792, 3)
  })

  it('格号解析（无字母前缀）', () => {
    expect(parseHexRef('36.13')).toEqual({ col: 36, row: 13 })
    expect(parseHexRef('1.1')).toEqual({ col: 1, row: 1 })
    expect(() => parseHexRef('xx.1')).toThrow(/无法解析格号/)
  })

  it('verifyCalibration 对违规数据返回差异（护栏行为）', () => {
    const bad = [{ hex_id: '1.1', col: 1, row: 1, center_px: [0, 0], on_map: true, state: 'full' }]
    const errors = verifyCalibration(bad)
    expect(errors.length).toBeGreaterThan(0)
  })
})
