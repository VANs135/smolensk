import { describe, expect, it } from 'vitest'

import { unitsAxis, unitsSoviet } from '@/data'

/**
 * 逐面机动类型的数据守卫（3.1a / 5.6b / 13.5；用户 2026-09-17 三轮裁定）
 *
 * 3.1a：机动类型由**该面印值 MA 的颜色**决定 ⇒ **逐面**成立，两面不同是正常现象，不是错。
 * 词表与引擎一致：`MobilityType = 'leg' | 'truck' | 'tracked'`（黄框红字＝`tracked`）。
 * 本用例钉的正是"裁定之后的全库形态"，代替一直悬着的 **D-5**（"三个叶子单位待裁定"）——
 * 那条现在**找不到对象**：源库 435 条按「`mobility_type` 缺失」「`mobility_src` 含待定」两种口径
 * 盘点各为 0，应用侧同样 0。所以这里不再问"哪三枚"，而是把**已裁定的结论**变成可执行的守卫。
 *
 * 用户裁定原话（2026-09-17，见 `docs/单位机动类型待裁定清单.md`）：
 *   「骑兵全徒步、筑垒全徒步」；「除了『摩托化步兵师』和『摩托化侦察』里的独立单位是**两面轮式**、
 *   其它摩托化单位全是**正面徒步背面轮式**」；「编内卡车只有移动模式，两面是空载和满载」；
 *   「轴心的 aufk 和 krd 两面都是**履带**，苏军的 Ru_1_Mtr_93_Recon_BN 两面都是**轮式**」。
 *
 * ⇒ 全库只允许一个方向：**正面 leg → 背面 truck**（`truck→leg` 必须是 0）。
 */
const MOBILITY = ['leg', 'truck', 'tracked'] as const

const ALL = [
  ...unitsAxis.units.map((record) => ({ side: 'axis' as const, record })),
  ...unitsSoviet.units.map((record) => ({ side: 'soviet' as const, record })),
]

describe('逐面机动类型（3.1a；D-5 的收口守卫）', () => {
  it('每条记录的每一面都读出了机动类型（缺失即无法计 MP，属数据缺口）', () => {
    const missing = ALL.filter(({ record }) => {
      const faces = record.mobilityByFace ?? {}
      return faces.combat == null && faces.move == null
    }).map(({ side, record }) => `${side}:${record.vassalName}`)
    expect(missing, '这些记录两面都没有机动类型').toEqual([])
  })

  it('机动类型只能是 leg / truck / tracked（不许出现其它词）', () => {
    const bad: string[] = []
    for (const { side, record } of ALL) {
      for (const face of ['combat', 'move'] as const) {
        const value = (record.mobilityByFace ?? {})[face]
        if (value === undefined || value === null) continue
        if (!(MOBILITY as readonly string[]).includes(value))
          bad.push(`${side}:${record.vassalName}:${face}=${String(value)}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('两面不同**只允许**「正面 leg → 背面 truck」（`truck→leg` 必须为 0）', () => {
    const wrong: string[] = []
    const directions = new Map<string, number>()
    for (const { side, record } of ALL) {
      const faces = record.mobilityByFace ?? {}
      const combat = faces.combat
      const move = faces.move
      if (combat === undefined || combat === null) continue
      if (move === undefined || move === null) continue
      if (combat === move) continue
      const key = `${combat}→${move}`
      directions.set(key, (directions.get(key) ?? 0) + 1)
      if (key !== 'leg→truck') wrong.push(`${side}:${record.vassalName}（${key}）`)
    }
    expect(wrong, '这些记录的方向与 2026-09-17 三轮裁定不符').toEqual([])
    // 形态本身也钉住（轴 57 / 苏 11，全部 leg→truck）——数字变了说明有人动了机动类型
    expect([...directions.keys()]).toEqual(['leg→truck'])
    expect(directions.get('leg→truck')).toBe(57 + 11)
  })
})
