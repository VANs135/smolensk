import { describe, expect, it } from 'vitest'

import { planFreeRailArrivals, type FreeRailCandidate } from '@/engine/rules'
import type { HexRef } from '@/data'

/**
 * 批 F 切片 3：**免费铁运**（专规 2.1 / 3.1 + 通规 13.3c）的引擎判据
 *
 * ## 原文（先读再动，见 §17.111 的摘录）
 *   - 专规 2.1 / 3.1（源库 `rules.json → free_rail_cap_sp` 的 `rule_text_free_rail`）：
 *     「**补给表到货**中，**每个可卸载城市格**可放 **1 SP**（用**免费** Rail Cap），
 *      这些格须有**合法的铁路移动路径**（依 OCS 13.3e，苏方宽轨／轴方标准轨）；
 *      **其余 SP 放地图边缘补给源格**。」
 *   - 通规 13.3c：可卸货格的三条（村庄／城市／港口／工程 HQ + 受控 + 免 EZOC 铁路路径回补给源）；
 *     运行时结论由调用方注入（引擎不持地图）——本模块只判"玩家勾的格在不在候选里、每格有没有超 1 SP"。
 *   - 通规 13.3b：铁路运量每回合清零、只在移动阶段用 ⇒ 免费铁运**不扣**运量（`railCapUsed` 恒 0）。
 *   - 专规 3.6：**Supply Train** ⇒ 轴方在**任一可卸货格**得 **2 SP**，**同样不用 Rail Cap**。
 *
 * ## 测法边界（如实交代）
 *   - 本文件用**合成格号**（引擎不持地图），只钉"每格 1 SP / 其余放图边源 / 三条拒绝面 / 免费"；
 *   - "哪些格真的可卸货"（13.3c 的运行期结论）不在本文件：它由 `rail-supply.ts` 算、由 store 注入，
 *     数据面与流程面在 `tests/stores/free-rail-arrival-flow.test.ts`；
 *   - **不覆盖界面**（仓库无组件渲染测试）：面板上的勾选按钮由 store 用例与源码守卫间接盯。
 */

const hex = (col: number, row: number): HexRef => ({ col, row })
const key = (h: HexRef): string => `${h.col}.${h.row}`

/** 三个"可卸载城市格"（合成）＋ 两个图边补给源格 */
const CITY_A = hex(2, 2)
const CITY_B = hex(15, 10)
const CITY_C = hex(19, 27)
const EDGE_1 = hex(1, 3)
const EDGE_2 = hex(4, 0)

const candidates: readonly FreeRailCandidate[] = [
  { hex: CITY_A, name: 'Bobruysk' },
  { hex: CITY_B, name: 'Mogilev' },
  { hex: CITY_C, name: 'Vitebsk' },
]
const detrainable: readonly HexRef[] = [CITY_A, CITY_B, CITY_C, hex(5, 27)]
const edgeSourceHexes: readonly HexRef[] = [EDGE_1, EDGE_2]

describe('批 F 切片 3：免费铁运落点（专规 2.1 / 3.1 + 13.3c）', () => {
  it('★ 每格 1 SP、其余放图边补给源格，且**不扣铁路容量**（13.3b：免费）', () => {
    const outcome = planFreeRailArrivals({
      sp: 7,
      candidates,
      detrainableHexes: detrainable,
      picked: [CITY_A, CITY_C],
      edgeHex: EDGE_1,
      edgeSourceHexes,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const plan = outcome.data
    expect(plan.freeSp).toBe(2)
    expect(plan.edgeSp).toBe(5)
    expect(plan.railCapUsed).toBe(0)
    expect(plan.placements.map((item) => `${key(item.hex)}:${item.sp}:${item.reason}`)).toEqual([
      `${key(CITY_A)}:1:freeRail`,
      `${key(CITY_C)}:1:freeRail`,
      `${key(EDGE_1)}:5:edgeSource`,
    ])
    expect(plan.rule).toContain('2.1')
  })

  it('★ 一格都没勾 ⇒ 全部落图边补给源格（原文"其余 SP 放图边补给源格"的退化态）', () => {
    const outcome = planFreeRailArrivals({
      sp: 4,
      candidates,
      detrainableHexes: detrainable,
      picked: [],
      edgeHex: EDGE_2,
      edgeSourceHexes,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.placements.map((item) => `${key(item.hex)}:${item.sp}`)).toEqual([
      `${key(EDGE_2)}:4`,
    ])
    expect(outcome.data.freeSp).toBe(0)
    expect(outcome.data.edgeSp).toBe(4)
  })

  it('★ 拒绝面：非候选格（13.3c）／重复勾同一格／勾的比到货 SP 还多（各给规则号）', () => {
    const base = {
      sp: 3,
      candidates,
      detrainableHexes: detrainable,
      edgeHex: EDGE_1,
      edgeSourceHexes,
    }
    const notCity = planFreeRailArrivals({ ...base, picked: [hex(5, 27)] })
    expect(notCity.ok).toBe(false)
    if (!notCity.ok) expect(notCity.rule).toBe('13.3c')

    const dup = planFreeRailArrivals({ ...base, picked: [CITY_A, CITY_A] })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.rule).toBe('2.1')

    const tooMany = planFreeRailArrivals({ ...base, sp: 1, picked: [CITY_A, CITY_B] })
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.rule).toBe('2.1')
  })

  it('★ 有余额就必须给图边补给源格：缺格／给了非源格都拒（2.1）', () => {
    const absent = planFreeRailArrivals({
      sp: 2,
      candidates,
      detrainableHexes: detrainable,
      picked: [CITY_A],
      edgeHex: null,
      edgeSourceHexes,
    })
    expect(absent.ok).toBe(false)
    if (!absent.ok) expect(absent.rule).toBe('2.1')

    const notSource = planFreeRailArrivals({
      sp: 2,
      candidates,
      detrainableHexes: detrainable,
      picked: [CITY_A],
      edgeHex: hex(30, 13),
      edgeSourceHexes,
    })
    expect(notSource.ok).toBe(false)
    if (!notSource.ok) expect(notSource.rule).toBe('2.1')

    // 正好装完（7 格候选放 7 SP）时**不需要**图边格
    const exact = planFreeRailArrivals({
      sp: 3,
      candidates,
      detrainableHexes: detrainable,
      picked: [CITY_A, CITY_B, CITY_C],
      edgeHex: null,
      edgeSourceHexes,
    })
    expect(exact.ok).toBe(true)
    if (exact.ok) expect(exact.data.edgeSp).toBe(0)
  })

  it('★ 候选必须是"可卸货格"（接线守卫：候选 ⊄ 运行期 13.3c 结论即拒）', () => {
    const outcome = planFreeRailArrivals({
      sp: 1,
      candidates,
      detrainableHexes: [CITY_A],
      picked: [CITY_A],
      edgeHex: null,
      edgeSourceHexes,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.rule).toBe('2.1')
  })

  it('★ 3.6 Supply Train：2 SP 落**任一可卸货格**且不用 Rail Cap；落点不可卸货即拒', () => {
    const ok = planFreeRailArrivals({
      sp: 0,
      candidates,
      detrainableHexes: detrainable,
      picked: [],
      edgeHex: null,
      edgeSourceHexes,
      supplyTrainSp: 2,
      supplyTrainHex: hex(5, 27),
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(
        ok.data.placements.map((item) => `${key(item.hex)}:${item.sp}:${item.reason}`),
      ).toEqual(['5.27:2:supplyTrain'])
      expect(ok.data.railCapUsed).toBe(0)
    }

    const bad = planFreeRailArrivals({
      sp: 0,
      candidates,
      detrainableHexes: detrainable,
      picked: [],
      edgeHex: null,
      edgeSourceHexes,
      supplyTrainSp: 2,
      supplyTrainHex: hex(30, 13),
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.rule).toBe('3.6')

    const missingHex = planFreeRailArrivals({
      sp: 0,
      candidates,
      detrainableHexes: detrainable,
      picked: [],
      edgeHex: null,
      edgeSourceHexes,
      supplyTrainSp: 2,
      supplyTrainHex: null,
    })
    expect(missingHex.ok).toBe(false)
    if (!missingHex.ok) expect(missingHex.rule).toBe('3.6')
  })

  it('★ SP 数必须是非负整数（2.1）', () => {
    for (const sp of [-1, 1.5]) {
      const outcome = planFreeRailArrivals({
        sp,
        candidates,
        detrainableHexes: detrainable,
        picked: [],
        edgeHex: EDGE_1,
        edgeSourceHexes,
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.rule).toBe('2.1')
    }
  })
})
