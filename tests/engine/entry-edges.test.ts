import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { ENTRY_EDGE_LETTERS, entryEdgeHexes } from '@/engine/rules/entry-edges'

const mapConfig = JSON.parse(readFileSync('src/data/map-config.json', 'utf8')) as {
  entryHexes: Record<string, HexRef[]>
}

const labels = (hexes: readonly HexRef[]) => new Set(hexes.map((hex) => `${hex.col}.${hex.row}`))

/**
 * 3.1 / 2.1（用户 2026-11-11 追加裁定）：
 * 图边＝地图库已配置的**字母入场段**，不是「所有边缘格」，也不写死格号。
 */
describe('图边 = 字母入场段', () => {
  it('两侧各读自己的字母表', () => {
    expect(ENTRY_EDGE_LETTERS.axis).toEqual(['K', 'J', 'I', 'H', 'G', 'F'])
    expect(ENTRY_EDGE_LETTERS.soviet).toEqual(['A', 'B', 'C', 'D', 'E', 'L'])
  })

  it('轴方 K–F：落在段内的格算，西缘但在段外的 4.00 不算', () => {
    const { hexes, missing } = entryEdgeHexes('axis', mapConfig.entryHexes)
    expect(missing).toEqual([])
    expect(labels(hexes)).toEqual(new Set(['1.26', '1.19', '1.12', '1.7', '1.3', '1.4', '8.0']))
    expect(labels(hexes).has('4.0')).toBe(false)
  })

  it('苏方 A–E/L：按字母表读，不是「所有边缘格」', () => {
    const { hexes, missing } = entryEdgeHexes('soviet', mapConfig.entryHexes)
    expect(missing).toEqual([])
    expect(labels(hexes)).toEqual(
      new Set([
        '62.33',
        '62.34',
        '62.35',
        '62.22',
        '62.23',
        '62.12',
        '62.3',
        '62.4',
        '42.0',
        '43.1',
        '44.0',
        '20.35',
      ]),
    )
    // 苏方 live 清单里的非字母边格（如 13.01）不再自动算图边补给源
    expect(labels(hexes).has('13.1')).toBe(false)
  })

  it('缺字母映射：报缺口，不静默退化成全边缘', () => {
    const table = { ...mapConfig.entryHexes }
    delete table.I
    const { hexes, missing } = entryEdgeHexes('axis', table)
    expect(missing).toEqual(['I'])
    expect(hexes).toHaveLength(6)
    // 只剩其余 5 个字母对应的 6 格，没有把西缘其它格补进来
    const others = ['K', 'J', 'H', 'G', 'F'].flatMap((letter) => mapConfig.entryHexes[letter] ?? [])
    expect(hexes.every((hex) => labels(others).has(`${hex.col}.${hex.row}`))).toBe(true)
  })

  it('同格去重', () => {
    const table: Record<string, HexRef[] | undefined> = {
      ...mapConfig.entryHexes,
      K: [
        { col: 1, row: 26 },
        { col: 1, row: 26 },
      ],
    }
    const result = entryEdgeHexes('axis', table)
    expect(result.hexes.filter((hex) => hex.col === 1 && hex.row === 26)).toHaveLength(1)
  })
})
