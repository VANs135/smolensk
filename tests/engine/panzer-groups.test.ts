import { describe, expect, it } from 'vitest'

import { areAdjacent, sameHex } from '@/engine/hex-geometry'
import {
  PANZER_GROUP_FORBIDDEN_PURPOSES,
  PANZER_GROUPS,
  allowedSideOf,
  boundarySideOf,
  checkPanzerGroupSpPayment,
  dividingLineObligations,
  inDividingLineScope,
  isExemptFromPanzerGroupRules,
  splitSupplyTableSp,
  type PanzerGroupBoundary,
  type PanzerGroupUnitView,
} from '@/engine/rules'

/**
 * 装甲集群分界线与补给分配（Smolensk 专规 3.4 / 3.4a / 3.4b）
 *
 * 条文（ch03 引录）：
 *   - 3.4：多单位编队（装甲、摩托化、骑兵师）分属 Guderian 的 2nd Panzer Group 与 Hoth 的
 *     3rd Panzer Group；**仅 19 August 前生效，且只约束多单位编队**（步兵师与独立单位不受限）。
 *   - 3.4a：分界线自 **19.19 到 62.23**；Guderian 编队应在**线上或南**、Hoth 在**线上或北**。
 *     ① 与另一集群单位**同堆叠或相邻**、或 ② 位于**错误一侧且在 Orsha 以东**（19.xx 以西不受约束）
 *     ⇒ 相位末对**该编队一个单位投 DG**。
 *   - 3.4b：Supply Table 增援**平均分给**两集群、**奇数点归 Guderian**；「错误」集群的 SP
 *     **不能**支付多单位编队的**燃油 / 战斗 / 轰炸**成本；所有新到 SP **必须立即归属某一集群**。
 */

/** 产品数据 map-config.panzerGroupBoundary（19.19 → 62.23） */
const BOUNDARY: PanzerGroupBoundary = { west: { col: 19, row: 19 }, east: { col: 62, row: 23 } }

/** 产品数据 map-layers 的城市名 Orsha = 18.18 */
const ORSHA = { col: 18, row: 18 }

const SCOPE = { boundary: BOUNDARY, orshaHex: ORSHA }

/** 分界线在 col 40 处的行号：19 + (40−19)/43 × (23−19) ≈ 20.95 ⇒ 21 在线上、22 在北、20 在南 */
const SOUTH_OF_LINE = { col: 40, row: 20 }
const ON_LINE = { col: 40, row: 21 }
const NORTH_OF_LINE = { col: 40, row: 22 }
/** 19.xx 以西（列 19 之左）⇒ 不受分界线约束 */
const WEST_OF_LINE = { col: 10, row: 30 }

function unit(
  id: string,
  group: 'guderian' | 'hoth' | null,
  hex: { col: number; row: number },
  inMultiUnitFormation = true,
): PanzerGroupUnitView {
  return { id, group, inMultiUnitFormation, hex }
}

describe('3.4a：分界线的两侧判定', () => {
  it('3.4a：两端点之间按列线性插值；行号大＝北，与插值线相差不足半行＝在线上', () => {
    expect(boundarySideOf(SOUTH_OF_LINE, BOUNDARY)).toBe('south')
    expect(boundarySideOf(ON_LINE, BOUNDARY)).toBe('onLine')
    expect(boundarySideOf(NORTH_OF_LINE, BOUNDARY)).toBe('north')
    // 西端点即 19.19 本身
    expect(boundarySideOf({ col: 19, row: 19 }, BOUNDARY)).toBe('onLine')
  })

  it('3.4a：判据只在「列 ≥ 分界线起点列 且 Orsha 以东」的格生效（19.xx 以西不受约束）', () => {
    expect(inDividingLineScope(SOUTH_OF_LINE, SCOPE)).toBe(true)
    expect(inDividingLineScope(WEST_OF_LINE, SCOPE)).toBe(false)
    // Orsha 格自身（18.18）在 19.xx 以西 ⇒ 不生效
    expect(inDividingLineScope(ORSHA, SCOPE)).toBe(false)
  })

  it('3.4：合规一侧为「Guderian 线上或南 / Hoth 线上或北」', () => {
    expect(allowedSideOf('guderian')).toBe('south')
    expect(allowedSideOf('hoth')).toBe('north')
    expect([...PANZER_GROUPS]).toEqual(['guderian', 'hoth'])
  })
})

describe('3.4a：相位末的分界线义务', () => {
  it('3.4a①：与另一装甲集群的单位**同堆叠或相邻** ⇒ 该编队一个单位 DG', () => {
    const outcome = dividingLineObligations({
      units: [
        unit('g1', 'guderian', SOUTH_OF_LINE),
        unit('h1', 'hoth', SOUTH_OF_LINE), // 同堆叠
      ],
      scope: SCOPE,
      date: '1941-07-12',
      adjacent: areAdjacent,
      sameHex,
    })
    expect(outcome.map((item) => [item.group, item.reason])).toEqual([
      ['guderian', 'crossGroupStackedOrAdjacent'],
      ['hoth', 'crossGroupStackedOrAdjacent'],
    ])
    // DG 落在**该编队内一个单位**上 ⇒ 给出编队全部成员供选
    expect(outcome[0]?.unitIds).toEqual(['g1'])
    expect(outcome[0]?.rule).toBe('3.4a')

    const adjacentCase = dividingLineObligations({
      units: [unit('g1', 'guderian', SOUTH_OF_LINE), unit('h1', 'hoth', ON_LINE)],
      scope: SCOPE,
      date: '1941-07-12',
      adjacent: areAdjacent,
      sameHex,
    })
    expect(adjacentCase.length).toBe(2)
  })

  it('3.4a②：位于「错误一侧」且 Orsha 以东 ⇒ 该编队一个单位 DG', () => {
    // Guderian 跑到分界线之北 ⇒ 错误一侧
    const guderianWrong = dividingLineObligations({
      units: [unit('g1', 'guderian', NORTH_OF_LINE)],
      scope: SCOPE,
      date: '1941-07-12',
      adjacent: areAdjacent,
      sameHex,
    })
    expect(guderianWrong.map((item) => item.reason)).toEqual(['wrongSideOfLineEastOfOrsha'])
    expect(guderianWrong[0]?.detail).toContain('g1')

    // Hoth 跑到分界线之南 ⇒ 错误一侧
    const hothWrong = dividingLineObligations({
      units: [unit('h1', 'hoth', SOUTH_OF_LINE)],
      scope: SCOPE,
      date: '1941-07-12',
      adjacent: areAdjacent,
      sameHex,
    })
    expect(hothWrong.map((item) => item.reason)).toEqual(['wrongSideOfLineEastOfOrsha'])
  })

  it('3.4a：在线上、或各自在合规一侧 ⇒ 无义务', () => {
    const outcome = dividingLineObligations({
      units: [
        unit('g1', 'guderian', SOUTH_OF_LINE), // col 40：南
        unit('g2', 'guderian', { col: 45, row: 21 }), // col 45：在线上
        unit('h1', 'hoth', { col: 50, row: 24 }), // col 50：北
        unit('h2', 'hoth', { col: 55, row: 22 }), // col 55：在线上
      ],
      scope: SCOPE,
      date: '1941-07-12',
      adjacent: areAdjacent,
      sameHex,
    })
    expect(outcome).toEqual([])
  })

  it('3.4a：错误一侧但位于 19.xx 以西 ⇒ 不受分界线约束（无义务）', () => {
    const outcome = dividingLineObligations({
      units: [unit('g1', 'guderian', WEST_OF_LINE)],
      scope: SCOPE,
      date: '1941-07-12',
      adjacent: areAdjacent,
      sameHex,
    })
    expect(outcome).toEqual([])
  })

  it('3.4：步兵师与独立单位（不属集群 / 非多单位编队）完全不受限', () => {
    expect(isExemptFromPanzerGroupRules({ group: null, inMultiUnitFormation: true })).toBe(true)
    expect(isExemptFromPanzerGroupRules({ group: 'hoth', inMultiUnitFormation: false })).toBe(true)
    const outcome = dividingLineObligations({
      units: [
        unit('inf', null, NORTH_OF_LINE), // 独立单位／步兵师
        unit('h1', 'hoth', NORTH_OF_LINE, false), // 非多单位编队
      ],
      scope: SCOPE,
      date: '1941-07-12',
      adjacent: areAdjacent,
      sameHex,
    })
    expect(outcome).toEqual([])
  })

  it('3.4：19 August 及以后约束失效（不再有义务）', () => {
    const outcome = dividingLineObligations({
      units: [unit('g1', 'guderian', NORTH_OF_LINE), unit('h1', 'hoth', SOUTH_OF_LINE)],
      scope: SCOPE,
      date: '1941-08-19',
      adjacent: areAdjacent,
      sameHex,
    })
    expect(outcome).toEqual([])
    // 前一天仍生效
    expect(
      dividingLineObligations({
        units: [unit('g1', 'guderian', NORTH_OF_LINE)],
        scope: SCOPE,
        date: '1941-08-15',
        adjacent: areAdjacent,
        sameHex,
      }).length,
    ).toBe(1)
  })
})

describe('3.4b：Supply Table 的均分', () => {
  it('3.4b：平均分给两集群；奇数点归 Guderian（例：7 SP ⇒ Hoth 3、Guderian 4）', () => {
    expect(splitSupplyTableSp(7)).toEqual({ hoth: 3, guderian: 4 })
    expect(splitSupplyTableSp(8)).toEqual({ hoth: 4, guderian: 4 })
    expect(splitSupplyTableSp(1)).toEqual({ hoth: 0, guderian: 1 })
    expect(splitSupplyTableSp(0)).toEqual({ hoth: 0, guderian: 0 })
    // 负值与非整数不产生负数分配
    expect(splitSupplyTableSp(-3)).toEqual({ hoth: 0, guderian: 0 })
    expect(splitSupplyTableSp(5.9)).toEqual({ hoth: 2, guderian: 3 })
  })
})

describe('3.4b：错误集群的 SP 不得支付燃油 / 战斗 / 轰炸', () => {
  it('3.4b：受约束的三种用途（燃油 / 战斗 / 轰炸）', () => {
    expect([...PANZER_GROUP_FORBIDDEN_PURPOSES]).toEqual(['fuel', 'combat', 'barrage'])
  })

  it('3.4b：付费集群 = 编队集群 ⇒ 允许', () => {
    for (const purpose of PANZER_GROUP_FORBIDDEN_PURPOSES) {
      const outcome = checkPanzerGroupSpPayment({
        agreedByConsensus: true,
        spGroup: 'hoth',
        formationGroup: 'hoth',
        purpose,
        date: '1941-07-12',
        inMultiUnitFormation: true,
      })
      expect(outcome.ok).toBe(true)
    }
  })

  it('3.4b：付费集群 ≠ 编队集群 ⇒ 拒（原因码含两集群与用途）', () => {
    const outcome = checkPanzerGroupSpPayment({
      agreedByConsensus: true,
      spGroup: 'hoth',
      formationGroup: 'guderian',
      purpose: 'fuel',
      date: '1941-07-12',
      inMultiUnitFormation: true,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.rule).toBe('3.4b')
      expect(outcome.reason).toBe('wrongPanzerGroupSp:hoth≠guderian:fuel')
    }
  })

  it('3.4b：非受约束用途（other）、非多单位编队、19 August 起 ⇒ 一律不受限', () => {
    expect(
      checkPanzerGroupSpPayment({
        agreedByConsensus: true,
        spGroup: 'hoth',
        formationGroup: 'guderian',
        purpose: 'other',
        date: '1941-07-12',
        inMultiUnitFormation: true,
      }).ok,
    ).toBe(true)
    expect(
      checkPanzerGroupSpPayment({
        agreedByConsensus: true,
        spGroup: 'hoth',
        formationGroup: 'guderian',
        purpose: 'combat',
        date: '1941-07-12',
        inMultiUnitFormation: false,
      }).ok,
    ).toBe(true)
    expect(
      checkPanzerGroupSpPayment({
        agreedByConsensus: true,
        spGroup: null,
        formationGroup: null,
        purpose: 'barrage',
        date: '1941-07-12',
        inMultiUnitFormation: true,
      }).ok,
    ).toBe(true)
    expect(
      checkPanzerGroupSpPayment({
        agreedByConsensus: true,
        spGroup: 'hoth',
        formationGroup: 'guderian',
        purpose: 'barrage',
        date: '1941-08-19',
        inMultiUnitFormation: true,
      }).ok,
    ).toBe(true)
  })

  it('3.4b：所有新到的轴方 SP 必须立即归属某一装甲集群（未归属 ⇒ 拒）', () => {
    const outcome = checkPanzerGroupSpPayment({
      agreedByConsensus: true,
      spGroup: null,
      formationGroup: 'guderian',
      purpose: 'fuel',
      date: '1941-07-12',
      inMultiUnitFormation: true,
      unassigned: true,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('newSpMustBeAssignedToAPanzerGroup')
  })
  /*
   * B50（用户 2026-09-17 口径）：3.4b 是专规 4.1a 的**可选项**，进开场共识。
   * 未采纳 ⇒ 这一整条不生效（连"新到的 SP 必须立即归属"也不再拦）。
   */
  it('4.1a 可选项未采纳 ⇒ 3.4b 整条不生效（未归属也不拦）', () => {
    const outcome = checkPanzerGroupSpPayment({
      agreedByConsensus: false,
      spGroup: null,
      formationGroup: 'guderian',
      purpose: 'fuel',
      date: '1941-07-19',
      inMultiUnitFormation: true,
      unassigned: true,
    })
    expect(outcome).toMatchObject({ ok: true, rule: '4.1a' })
  })

  it('共识采纳但已过 19 August ⇒ 也不约束（两条互不掩盖）', () => {
    const outcome = checkPanzerGroupSpPayment({
      agreedByConsensus: true,
      spGroup: 'hoth',
      formationGroup: 'guderian',
      purpose: 'fuel',
      date: '1941-08-19',
      inMultiUnitFormation: true,
      unassigned: true,
    })
    expect(outcome).toMatchObject({ ok: true, rule: '3.4' })
  })
})
