import { describe, expect, it } from 'vitest'

import { planCargoLoss, transportCapacityOf, validateCargoLossChoice } from '@/engine/rules'

/**
 * 批 F 切片 6（B49 收尾之②）：**14.4g 货物损失** ＋ **14.4f 减损面容量**
 *
 * ## 原文（先读再动）
 *   · **14.4f**：「如果防空造成损失，则其中一个执行任务的飞机会在执行任务之前承受损失。……
 *     **剩下一 点军力的飞机将使用其减少后的数值来完成任务。**」
 *   · **14.4g**：「如果运输任务的货物容量因防空而发生变化，则**重新计算可用的装载量**（注意 14.9e 的距离效果），
 *     并根据新的容量，**摧毁超出部分**的货物（**由玩家自主选择**）。**取整时，按有利于货物存留的方式取整**
 *     （举例，如果运输 1T 的货物，而飞机容量从 1T 下降到 1/2T，则按 1T 取整，使 1T 的货物存留并可成功抵达目的地）。」
 *   · **14.9b**：「1/2T 的容量……也**不能取整为 1T**。（**例外：货物损失，14.4g**）」⇒ 向上取整**只**在本场景适用。
 *
 * ## 测法边界（如实交代）
 *   · 本文件钉**引擎判据**（容量按军力取正/减损面、允许装载量的取整、摧毁清单的覆盖校验）；
 *   · **载货 T 的口径只数 SP 货物**（与装载时的 14.9a 校验同一口径；单位货物的 RE 当量未纳入，
 *     属已登记的边界，见回执 §17.114）；
 *   · 数据面（Ju.52 / TB.3 的减损面容量＝1/2T）由商店用例的端到端场景覆盖；**不覆盖界面**。
 */

const plane = (overrides: Partial<Parameters<typeof transportCapacityOf>[0]>) => ({
  transportCapacity: 1,
  transportCapacityBack: 0.5,
  steps: 2,
  ...overrides,
})

describe('批 F 切片 6：14.4f 减损面容量', () => {
  it('★ 完好（2 步）取正面印值；减损（1 步）取减损面印值；数据缺减损面 ⇒ 视为与正面相同', () => {
    expect(transportCapacityOf(plane({ steps: 2 }))).toBe(1)
    expect(transportCapacityOf(plane({ steps: 1 }))).toBe(0.5)
    // 数据没有减损面（如 He.111 正/反面同为 1/2T）⇒ 不猜、不折半
    expect(transportCapacityOf(plane({ transportCapacityBack: null, steps: 1 }))).toBe(1)
    expect(transportCapacityOf(plane({ transportCapacityBack: undefined, steps: 1 }))).toBe(1)
  })
})

describe('批 F 切片 6：14.4g 货物损失', () => {
  it('★ 原文的例子：载 1T、容量由 1T 降到 1/2T ⇒ 按 1T 取整，**无超出部分**（1T 货物存留）', () => {
    const outcome = planCargoLoss({ cargo: [{ id: 'sp:1', t: 1 }], capacityAfter: 0.5 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.allowedT).toBe(1)
    expect(outcome.data.excessT).toBe(0)
    expect(
      validateCargoLossChoice({
        cargo: [{ id: 'sp:1', t: 1 }],
        capacityAfter: 0.5,
        destroyedIds: [],
      }).ok,
    ).toBe(true)
  })

  it('★ 容量掉到 1T 而载 2T ⇒ 超出 1T；摧毁量不足即拒（14.4g），达标即通过', () => {
    const cargo = [
      { id: 'sp:a', t: 1 },
      { id: 'sp:b', t: 1 },
    ]
    const plan = planCargoLoss({ cargo, capacityAfter: 1 })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.data.excessT).toBe(1)

    const tooSmall = validateCargoLossChoice({ cargo, capacityAfter: 1, destroyedIds: [] })
    expect(tooSmall.ok).toBe(false)
    if (!tooSmall.ok) expect(tooSmall.rule).toBe('14.4g')

    const ok = validateCargoLossChoice({ cargo, capacityAfter: 1, destroyedIds: ['sp:a'] })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.data.destroyedT).toBe(1)

    // 玩家可以多摧毁（选择权在他）
    const more = validateCargoLossChoice({
      cargo,
      capacityAfter: 1,
      destroyedIds: ['sp:a', 'sp:b'],
    })
    expect(more.ok).toBe(true)
    if (more.ok) expect(more.data.destroyedT).toBe(2)
  })

  it('★ 拒绝面：不存在的货件 id / 同一件重复勾 / 容量为负', () => {
    const cargo = [{ id: 'sp:a', t: 1 }]
    const unknown = validateCargoLossChoice({ cargo, capacityAfter: 0, destroyedIds: ['sp:zzz'] })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.rule).toBe('14.4g')

    const dup = validateCargoLossChoice({ cargo, capacityAfter: 0, destroyedIds: ['sp:a', 'sp:a'] })
    expect(dup.ok).toBe(false)

    const bad = planCargoLoss({ cargo, capacityAfter: -1 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.rule).toBe('14.4g')
  })

  it('★ 容量足以装下全部货物 ⇒ 无超出（不必摧毁任何东西）', () => {
    const plan = planCargoLoss({ cargo: [{ id: 'sp:a', t: 2 }], capacityAfter: 2 })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.data.excessT).toBe(0)
  })
})
