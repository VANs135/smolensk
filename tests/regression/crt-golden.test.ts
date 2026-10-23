import { describe, expect, it } from 'vitest'

import { chartsCrt } from '@/data'
import { crtLookup, CRT_TERRAIN_TYPES, TableLookupError } from '@/engine/tables'

/**
 * W7 D3 回归基线 · **CRT 195 格黄金样本**（OCS 9.9）
 *
 * ## 为什么是「黄金样本」
 *   CRT 是**每一场战斗都要查**的表：15 掷骰行 × 13 攻防比列 = **195 格**。
 *   数据（`charts-crt.json`）来自已双重核验的矩阵，任何一次不经意的编辑都会让整局结果漂移，
 *   故这里把 195 格**逐格冻结成字面量**——数据一改即红，逼着改的人走「有意更新黄金样本」的流程。
 *
 * ## 三层断言
 *   ① **数据本身**：矩阵 15×13、四类地形列位各 13 列、掷骰行标 15 个，与黄金字面量逐位一致；
 *   ② **取表映射**：195 格逐格 `crtLookup(骰值, 地形, odds)` ⇒ 命中对应黄金格；
 *      四类地形各走一遍（4 × 195 = 780 次），确认「列位→列下标」的换算一致；
 *   ③ **边界口径**：行有界区（`1 or less` / `15 or more`）、列夹取（odds 越界取最近边界列）、
 *      非法地形抛错 —— 都是规则 9.1g / 9.7b 明写的口径。
 */

/** 黄金矩阵：15 行 × 13 列（源自 charts-crt.json 的已核验矩阵，冻结于此） */
const GOLDEN_MATRIX: readonly (readonly string[])[] = [
  [
    'AL2',
    'AL2',
    'AL2',
    'AL2',
    'AL2',
    'AL2',
    'AL2',
    'AL1o1',
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1 Do1',
    'AL1 Do1',
    'AL1 DL1o1',
  ],
  [
    'AL2',
    'AL2',
    'AL2',
    'AL2',
    'AL2',
    'AL2',
    'AL1o1',
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1 Do1',
    'AL1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
  ],
  [
    'AL2',
    'AL2',
    'AL2',
    'AL2',
    'AL2',
    'AL1o1',
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1 Do1',
    'AL1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
  ],
  [
    'AL2',
    'AL2',
    'AL2',
    'AL2',
    'AL1o1',
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1 Do1',
    'AL1 Do1',
    'Ao1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 e4 DL1o2',
  ],
  [
    'AL2',
    'AL2',
    'AL2',
    'AL1o1',
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1 Do1',
    'AL1 Do1',
    'Ao1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 e4 DL1o2',
    'Ae4 DL1o2',
  ],
  [
    'AL2',
    'AL2',
    'AL1o1',
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1 Do1',
    'AL1 Do1',
    'Ao1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ae4 DL1o2',
    'Ae4 DL1o2',
  ],
  [
    'AL1o1',
    'AL1o1',
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1 Do1',
    'Ao1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 e4 DL1o2',
    'Ae4 DL1o2',
    'Ae3 DL2o2DG',
  ],
  [
    'AL1o1',
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1 Do1',
    'Ao1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 e4 DL1o2',
    'Ae4 DL1o2',
    'Ae4 DL1o2',
    'Ae3 DL2o2DG',
  ],
  [
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1 Do1',
    'Ao1 Do1',
    'Ao1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 e4 DL1o2',
    'Ae4 DL1o2',
    'Ae4 DL1o2',
    'Ae3 DL2o2DG',
    'Ae3 DL2o2DG',
  ],
  [
    'AL1o1 Do1',
    'AL1o1 Do1',
    'AL1 Do1',
    'Ao1 Do1',
    'Ao1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 e4 DL1o2',
    'Ae4 DL1o2',
    'Ae4 DL1o2',
    'Ae3 DL2o2DG',
    'Ae3 DL2o2DG',
    'Ae2 DL2o3DG',
  ],
  [
    'AL1o1 Do1',
    'AL1 Do1',
    'Ao1 Do1',
    'Ao1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ae4 DL1o2',
    'Ae4 DL1o2',
    'Ae3 DL2o2DG',
    'Ae3 DL2o2DG',
    'Ae3 DL2o2DG',
    'Ae2 DL2o3DG',
  ],
  [
    'AL1o1 Do1',
    'Ao1 Do1',
    'Ao1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 e4 DL1o2',
    'Ae4 DL1o2',
    'Ae3 DL2o2DG',
    'Ae3 DL2o2DG',
    'Ae3 DL2o2DG',
    'Ae2 DL2o3DG',
    'Ae2 DL2o3DG',
  ],
  [
    'Ao1 Do1',
    'Ao1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 DL1o2',
    'Ao1 e4 DL1o2',
    'Ae4 DL1o2',
    'Ae3 DL2o2DG',
    'Ae3 DL2o2DG',
    'Ae3 DL2o2DG',
    'Ae2 DL2o3DG',
    'Ae2 DL2o3DG',
    'Ae2 DL2o3DG',
  ],
  [
    'Ao1 Do1',
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 e4 DL1o2',
    'Ao1 e4 DL1o2',
    'Ae4 DL1o2',
    'Ae3 DL2o2DG',
    'Ae3 DL2o2DG',
    'Ae3 DL2o2DG',
    'Ae2 DL2o3DG',
    'Ae2 DL2o3DG',
    'Ae2 DL2o3DG',
    'Ae2 DL2o3DG',
  ],
  [
    'Ao1 DL1o1',
    'Ao1 DL1o1',
    'Ao1 e4 DL1o2',
    'Ae4 DL1o2',
    'Ae4 DL1o2',
    'Ae3 DL2o2DG',
    'Ae3 DL2o2DG',
    'Ae2 DL2o3DG',
    'Ae2 DL2o3DG',
    'Ae2 DL2o3DG',
    'Ae2 DL2o3DG',
    'Ae2 DL2o3DG',
    'Ae2 DL2o3DG',
  ],
]

/** 黄金掷骰行标（15 行；第 1 / 末行为有界区） */
const GOLDEN_DICE_ROWS: readonly string[] = [
  '1 or less',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15 or more',
]

/** 黄金地形列位（4 类 × 13 列；决定 odds 标签落在哪一列） */
const GOLDEN_TERRAIN_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'Extr Close': [
    '1:2',
    '1:1',
    '2:1',
    '3:1',
    '4:1',
    '8:1',
    '12:1',
    '16:1',
    '20:1',
    '28:1',
    '36:1',
    '44:1',
    '52:1',
  ],
  'Very Close': [
    '1:3',
    '1:2',
    '1:1',
    '2:1',
    '3:1',
    '4:1',
    '6:1',
    '9:1',
    '12:1',
    '15:1',
    '18:1',
    '21:1',
    '24:1',
  ],
  Close: [
    '1:4',
    '1:3',
    '1:2',
    '1:1',
    '2:1',
    '3:1',
    '4:1',
    '6:1',
    '8:1',
    '10:1',
    '12:1',
    '15:1',
    '18:1',
  ],
  Open: [
    '1:5',
    '1:4',
    '1:3',
    '1:2',
    '1:1',
    '2:1',
    '3:1',
    '4:1',
    '5:1',
    '7:1',
    '9:1',
    '11:1',
    '13:1',
  ],
}

const ROW_COUNT = 15
const COLUMN_COUNT = 13

describe('W7 D3：CRT 195 格黄金样本 —— 数据本身', () => {
  it('9.9：矩阵为 15 掷骰行 × 13 攻防比列（共 195 格），与黄金样本逐位一致', () => {
    expect(chartsCrt.crt.matrix).toHaveLength(ROW_COUNT)
    for (const row of chartsCrt.crt.matrix) expect(row).toHaveLength(COLUMN_COUNT)
    expect(ROW_COUNT * COLUMN_COUNT).toBe(195)
    expect(chartsCrt.crt.matrix).toEqual(GOLDEN_MATRIX)
  })

  it('9.9：掷骰行标 15 个（首行 `1 or less`、末行 `15 or more`），与黄金样本一致', () => {
    expect(chartsCrt.crt.diceRows).toEqual(GOLDEN_DICE_ROWS)
  })

  it('9.9：四类地形各有 13 个 odds 列位，与黄金样本一致（列位即 9.7 的攻防比档）', () => {
    expect(CRT_TERRAIN_TYPES).toEqual(['Extr Close', 'Very Close', 'Close', 'Open'])
    for (const terrain of CRT_TERRAIN_TYPES) {
      const columns = chartsCrt.crt.terrainColumns[terrain]
      expect(columns).toHaveLength(COLUMN_COUNT)
      expect(columns).toEqual(GOLDEN_TERRAIN_COLUMNS[terrain])
    }
  })
})

describe('W7 D3：CRT 195 格黄金样本 —— 逐格取表', () => {
  it('9.9：195 格逐格取表全部命中黄金样本（骰值 1–15 × 列位 0–12）', () => {
    const labels = GOLDEN_TERRAIN_COLUMNS['Extr Close'] ?? []
    let checked = 0
    for (let rowIndex = 0; rowIndex < ROW_COUNT; rowIndex += 1) {
      // 行标 `1 or less` / `2` … `15 or more`：骰值 = 行号 + 1（1..15 恰好覆盖 15 行）
      const roll = rowIndex + 1
      for (let columnIndex = 0; columnIndex < COLUMN_COUNT; columnIndex += 1) {
        const odds = labels[columnIndex]
        if (odds === undefined) throw new Error(`黄金样本列位缺 ${columnIndex}`)
        const result = crtLookup(roll, 'Extr Close', odds)
        expect(result.rowIndex).toBe(rowIndex)
        expect(result.columnIndex).toBe(columnIndex)
        expect(result.columnLabel).toBe(odds)
        expect(result.code).toBe(GOLDEN_MATRIX[rowIndex]?.[columnIndex])
        checked += 1
      }
    }
    expect(checked).toBe(195)
  })

  it('9.9：四类地形各走一遍（4 × 195 = 780 次）—— 列位换算一致、格值一致', () => {
    let checked = 0
    for (const terrain of CRT_TERRAIN_TYPES) {
      const labels = GOLDEN_TERRAIN_COLUMNS[terrain] ?? []
      for (let rowIndex = 0; rowIndex < ROW_COUNT; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex < COLUMN_COUNT; columnIndex += 1) {
          const odds = labels[columnIndex]
          if (odds === undefined) throw new Error(`${terrain} 列位缺 ${columnIndex}`)
          const result = crtLookup(rowIndex + 1, terrain, odds)
          expect(result.columnIndex).toBe(columnIndex)
          expect(result.code).toBe(GOLDEN_MATRIX[rowIndex]?.[columnIndex])
          checked += 1
        }
      }
    }
    expect(checked).toBe(780)
  })
})

describe('W7 D3：CRT 黄金样本 —— 边界口径（9.1g / 9.7b 夹取）', () => {
  it('9.9：行有界区 —— 骰值 0 落 `1 or less`、骰值 16 落 `15 or more`', () => {
    expect(crtLookup(0, 'Open', '1:1').rowIndex).toBe(0)
    expect(crtLookup(0, 'Open', '1:1').rowLabel).toBe('1 or less')
    expect(crtLookup(1, 'Open', '1:1').rowIndex).toBe(0)
    expect(crtLookup(16, 'Open', '1:1').rowIndex).toBe(14)
    expect(crtLookup(16, 'Open', '1:1').rowLabel).toBe('15 or more')
  })

  it('9.1g / 9.7b：odds 超出表范围时夹取到最近边界列（取最后一列 / 第一列）', () => {
    for (const terrain of CRT_TERRAIN_TYPES) {
      const labels = GOLDEN_TERRAIN_COLUMNS[terrain] ?? []
      const largest = crtLookup(8, terrain, '99:1')
      expect(largest.columnIndex).toBe(COLUMN_COUNT - 1)
      expect(largest.columnLabel).toBe(labels[COLUMN_COUNT - 1])
      expect(largest.code).toBe(GOLDEN_MATRIX[7]?.[COLUMN_COUNT - 1])

      const smallest = crtLookup(8, terrain, '1:99')
      expect(smallest.columnIndex).toBe(0)
      expect(smallest.columnLabel).toBe(labels[0])
      expect(smallest.code).toBe(GOLDEN_MATRIX[7]?.[0])
    }
  })

  it('9.9：非法地形类 / 无法解析的 odds 一律抛 TableLookupError（不静默兜底）', () => {
    expect(() => crtLookup(7, 'Fog' as 'Open', '1:1')).toThrow(TableLookupError)
    expect(() => crtLookup(7, 'Open', '不是攻防比')).toThrow(TableLookupError)
  })
})
