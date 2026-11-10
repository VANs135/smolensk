import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'

import { canOverrun, evaluateStep } from '@/engine/rules'
import type { MoveContext, MoveUnitView, StepSuccess } from '@/engine/rules'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import { useWorkbenchStore } from '@/stores'

/**
 * 14.8b / 14.8c：**运输破坏区（TZ）**对地面移动与突袭进格的计费
 *
 * 原文（规则书 14.8）：
 *   · 14.8c「运输破坏区会影响**敌方**地面单位的移动和铁路费用。
 *     **地面单位每进入一个处于 TZ 中的格，地形消耗必须增加 1MP**。」
 *   · 14.8b「运输破坏区(TZ)是指带有运输破坏标记的格加上相邻的六个格。
 *     （**例外：使用步行 MP 移动时，运输破坏区仅限于标记所在格**）。」
 *   · 14.8c 末句「**绝不会因为多个 TZ 重叠而对一个格产生额外效果**，而且 **TZ 对撤退也没有影响**。」
 *   · 8.1b「进入格 MP（**格内＋格边＋运输破坏**）≤ 3」⇒ 突袭进格把 +1 算在同一笔里。
 *
 * 故本文件钉住：标记格 / 相邻六格 +1；步行 MP 只认标记格；己方（放置方）不受影响；
 * 重叠不叠计；突袭 `entryCost` 含 +1、并因此可能撞上 8.1b 的 3 MP 上限。
 */

const FROM: HexRef = { col: 36, row: 13 }
const TO: HexRef = { col: 36, row: 14 }
/** TO 的相邻格（用几何模块取，避免手写坐标在奇偶列错位下不相邻） */
const NEAR: HexRef = neighbor(TO, HEX_DIRECTIONS[0])

function unit(over: Partial<MoveUnitView> = {}): MoveUnitView {
  return {
    id: 'u1',
    side: 'axis',
    isCombat: true,
    attackCapable: true,
    hasTraceSupply: true,
    hex: { ...FROM },
    mobility: 'leg',
    ma: 6,
    re: 2,
    mode: 'combat',
    orientation: 'combat',
    dg: false,
    exploit: false,
    releasedFromReserve: false,
    fuelled: false,
    mpLockedThisPhase: false,
    ...over,
  }
}

function context(units: readonly MoveUnitView[], over: Partial<MoveContext> = {}): MoveContext {
  return {
    phase: 'movement',
    activeSide: 'axis',
    map: {
      onMap: () => true,
      terrainsAt: () => ['Open'],
      crossingBetween: () => null,
    },
    units,
    ...over,
  }
}

const tzSoviet = (hexes: readonly HexRef[]) => ({
  trainbustingMarksBySide: { axis: [] as HexRef[], soviet: [...hexes] },
})

function expectOk(outcome: ReturnType<typeof evaluateStep>): StepSuccess {
  if (!outcome.ok) throw new Error(`预期成功，实得失败：${outcome.reason} / ${outcome.rule}`)
  return outcome
}

describe('14.8c：地面单位进入 TZ 每格 +1 MP（敌方）', () => {
  it('★ 进入标记格：Open 1 + 1 = 2 MP（hexCost 仍如实报地形）', () => {
    const step = expectOk(evaluateStep(context([unit()], tzSoviet([TO])), 'u1', TO))
    expect(step.cost).toBe(2)
    expect(step.hexCost).toBe(1)
    expect(step.trainbustingCost).toBe(1)
  })

  it('★ 进入相邻六格：同样 +1（TZ ＝ 标记格 + 相邻六格；用轮式避开 14.8b 步行例外）', () => {
    const step = expectOk(
      evaluateStep(
        context([unit({ mobility: 'truck', fuelled: true })], tzSoviet([NEAR])),
        'u1',
        TO,
      ),
    )
    expect(step.cost).toBe(2)
    expect(step.trainbustingCost).toBe(1)
  })

  it('★ 14.8b 步行例外：步行 MP 的 TZ 只到标记格，邻格不加', () => {
    const step = expectOk(evaluateStep(context([unit()], tzSoviet([NEAR])), 'u1', TO))
    expect(step.cost).toBe(1)
    expect(step.trainbustingCost).toBe(0)
    // 同一枚标记，走进标记格仍 +1
    const onMark = expectOk(
      evaluateStep(context([unit({ hex: { ...FROM } })], tzSoviet([TO])), 'u1', TO),
    )
    expect(onMark.cost).toBe(2)
  })

  it('★ 只影响「敌方」：放置方自己走进标记格不加', () => {
    const ctx = context([unit()], {
      trainbustingMarksBySide: { axis: [{ ...TO }], soviet: [] },
    })
    const step = expectOk(evaluateStep(ctx, 'u1', TO))
    expect(step.cost).toBe(1)
    expect(step.trainbustingCost).toBe(0)
  })

  it('★ 重叠不叠计：两个 TZ 都覆盖同一格也只 +1（原文明确禁止叠加）', () => {
    const step = expectOk(
      evaluateStep(
        context([unit({ mobility: 'truck', fuelled: true })], tzSoviet([TO, NEAR])),
        'u1',
        TO,
      ),
    )
    expect(step.cost).toBe(2)
    expect(step.trainbustingCost).toBe(1)
  })
})

describe('8.1b：突袭进格的 MP 上限含运输破坏', () => {
  const overrun = (ctx: MoveContext) =>
    canOverrun({
      context: ctx,
      unitIds: ['u1'],
      target: TO,
      startedStackedTogether: true,
      mpRemaining: 6,
    })

  it('★ entryCost ＝ 格内＋格边＋运输破坏（Open + TZ = 2）', () => {
    const result = overrun(context([unit()], tzSoviet([TO])))
    if (!result.ok) throw new Error(`预期可突袭，实得 ${result.reason} / ${result.rule}`)
    expect(result.entryCost).toBe(2)
    expect(result.mpCost).toBe(3)
    // 无标记时同一格的进入费
    const plain = overrun(context([unit()]))
    if (!plain.ok) throw new Error('预期可突袭')
    expect(plain.entryCost).toBe(1)
  })

  it('★ 超过 3 MP 的进入格被 8.1b 拒（Forest 步行 2 + 小河 1 + TZ 1 = 4）', () => {
    const withTz = context([unit()], {
      ...tzSoviet([TO]),
      map: {
        onMap: () => true,
        terrainsAt: () => ['Forest'],
        crossingBetween: () => ({ river: 'Minor River', routes: [] }),
      },
    })
    const result = overrun(withTz)
    if (result.ok) throw new Error('预期被 8.1b 拒绝')
    expect(result).toMatchObject({ rule: '8.1b' })
    // 同一地形去掉 TZ ⇒ 3 MP，正好在上限内（证明拒绝的原因就是运输破坏那一格）
    const withoutTz = context([unit()], {
      map: withTz.map,
    })
    const allowed = overrun(withoutTz)
    if (!allowed.ok) throw new Error(`预期可突袭，实得 ${allowed.reason}`)
    expect(allowed.entryCost).toBe(3)
  })
})

describe('store 接线：账本上的运输破坏标记进入移动上下文', () => {
  it('★ 按放置方分组，供引擎按「移动方 ≠ 放置方」取用', () => {
    setActivePinia(createPinia())
    const store = useWorkbenchStore()
    store.trainbustingMarks = [{ id: 'tz-1', hex: { ...TO }, side: 'soviet' }]

    expect(store.moveContext.trainbustingMarksBySide).toEqual({
      axis: [],
      soviet: [{ ...TO }],
    })
  })
})
