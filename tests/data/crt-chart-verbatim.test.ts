import { describe, expect, it } from 'vitest'

import { chartsCrt } from '@/data'

/**
 * CRT（9.9）与印表 `v4.3 Charts (final)-3 1000.png` 的**抽样逐格**核对（2026-11-01）
 *
 * 全表 15×13 格不逐格抄（容易抄错），这里钉两样：
 *   ① **四条地形列的 odds 表头**（印表逐列印出，改动即错）；
 *   ② **已经逐格读清的样本格**：第 1/2 行（顶栏）与第 13/14/15+ 行（底栏）。
 * 其余格由 `tests/engine/tables/crt.test.ts` 的结构与取表用例兜底。
 */

const M = chartsCrt.crt.matrix

describe('CRT 列头（四条地形线 × 13 个 odds）照印表', () => {
  it('Extr Close / Very Close / Close / Open 四行', () => {
    expect(chartsCrt.crt.terrainColumns['Extr Close']).toEqual([
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
    ])
    expect(chartsCrt.crt.terrainColumns['Very Close']).toEqual([
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
    ])
    expect(chartsCrt.crt.terrainColumns['Close']).toEqual([
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
    ])
    expect(chartsCrt.crt.terrainColumns['Open']).toEqual([
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
    ])
  })

  it('骰行 15 条（1 or less … 15 or more）', () => {
    expect(chartsCrt.crt.diceRows).toEqual([
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
    ])
  })
})

describe('CRT 样本格（按印表逐格读出的部分）', () => {
  it('第 1 行「1 or less」：前 7 格（1:2…12:1）全为 AL2，第 8 格（16:1）起 = AL1o1', () => {
    // 印表：AL2 AL2 AL2 AL2 AL2 AL2 AL2 | AL1o1 | AL1o1 Do1 …
    expect(M[0]!.slice(0, 7)).toEqual(['AL2', 'AL2', 'AL2', 'AL2', 'AL2', 'AL2', 'AL2'])
    expect(M[0]![7]).toBe('AL1o1')
  })

  it('第 2 行「2」：前 6 格（1:2…8:1）为 AL2，第 7 格（12:1）= AL1o1', () => {
    expect(M[1]!.slice(0, 6)).toEqual(['AL2', 'AL2', 'AL2', 'AL2', 'AL2', 'AL2'])
    expect(M[1]![6]).toBe('AL1o1')
  })

  it('底栏 13 / 14 / 15+ 的左侧 7 格照印表', () => {
    // 13：Ao1 Do1 | Ao1 Do1 | Ao1 DL1o1 | Ao1 DL1o1 | Ao1 DL1o2 | Ao1 e4 DL1o2 | Ae4 DL1o2
    expect(M[12]!.slice(0, 7)).toEqual([
      'Ao1 Do1',
      'Ao1 Do1',
      'Ao1 DL1o1',
      'Ao1 DL1o1',
      'Ao1 DL1o2',
      'Ao1 e4 DL1o2',
      'Ae4 DL1o2',
    ])
    // 14：Ao1 Do1 | Ao1 DL1o1 | Ao1 DL1o1 | Ao1 e4 DL1o2 | Ao1 e4 DL1o2 | Ae4 DL1o2 | Ae3 DL2o2DG
    expect(M[13]!.slice(0, 7)).toEqual([
      'Ao1 Do1',
      'Ao1 DL1o1',
      'Ao1 DL1o1',
      'Ao1 e4 DL1o2',
      'Ao1 e4 DL1o2',
      'Ae4 DL1o2',
      'Ae3 DL2o2DG',
    ])
    // 15 or more：Ao1 DL1o1 | Ao1 DL1o1 | Ao1 e4 DL1o2 | Ae4 DL1o2 | Ae4 DL1o2 | Ae3 DL2o2DG | Ae3 DL2o2DG
    expect(M[14]!.slice(0, 7)).toEqual([
      'Ao1 DL1o1',
      'Ao1 DL1o1',
      'Ao1 e4 DL1o2',
      'Ae4 DL1o2',
      'Ae4 DL1o2',
      'Ae3 DL2o2DG',
      'Ae3 DL2o2DG',
    ])
  })

  it('每格只由印表词表组成，且矩阵为 15×13', () => {
    for (const row of M) {
      expect(row).toHaveLength(13)
      for (const cell of row) expect(cell).toMatch(/^[ADL eoDG0-9]+$/)
    }
    // 结构完备性：印表里出现过的词元都要在矩阵里出现过
    const all = M.flat().join(' ')
    for (const token of ['AL2', 'Ao1', 'Ae4', 'DG']) expect(all).toContain(token)
  })
})
