import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'

import { evaluateStep } from '@/engine/rules'
import type { MoveContext, MoveUnitView, StepOutcome } from '@/engine/rules'

/**
 * 13.8b 末句例外：**失能后可用自己架的桥离开该格**
 *
 * 原文：「当单位不再具备工程能力时，架的桥就会消失。（例外：具有工程能力的单位在通过切换模式或朝向
 *   而失去工程能力后，**可以使用自己架的桥离开该格**。）」
 *
 * 修前：`MoveContext` 只有**按格**的 `bridgedHexesBySide`。切成移动模式后该格立即从清单消失，
 * 于是"用自己架的桥离格"这条例外**整局不可达**（连该单位自己也被判成无桥）。
 *
 * 本组钉四件事（全部走合成地图，与产品地图无关）：
 *   ① 该单位自有桥格 = 本步出格 ⇒ 降级；
 *   ② 同格**别的**单位不吃这份桥（桥对第三方已消失）；
 *   ③ 自有桥格指向别处 ⇒ 不降级；
 *   ④ 突袭步（8.1c）照旧不得借桥过河。
 */

const key = (hex: HexRef): string => `${hex.col}.${hex.row}`
const normalized = (a: HexRef, b: HexRef): string => {
  const [x, y] = [key(a), key(b)].sort()
  return `${x}|${y}`
}

const FROM: HexRef = { col: 36, row: 13 }
const TO: HexRef = { col: 36, row: 14 }

function makeMap(river: string) {
  return {
    onMap: () => true,
    terrainsAt: (): readonly string[] => ['Open'],
    crossingBetween: (a: HexRef, b: HexRef) =>
      normalized(a, b) === '36.13|36.14' ? { river, routes: [] } : null,
  }
}

/** 已切成移动模式的单位（`canEngineer=false` 的时点，故不在 `bridgedHexesBySide` 里） */
function unit(over: Partial<MoveUnitView> = {}): MoveUnitView {
  return {
    id: 'u1',
    side: 'axis',
    isCombat: true,
    attackCapable: true,
    hasTraceSupply: true,
    hex: FROM,
    mobility: 'truck',
    ma: 6,
    re: 2,
    mode: 'move',
    orientation: 'move',
    dg: false,
    exploit: false,
    releasedFromReserve: false,
    fuelled: true,
    mpLockedThisPhase: false,
    ...over,
  }
}

function context(units: readonly MoveUnitView[], over: Partial<MoveContext> = {}): MoveContext {
  return { phase: 'movement', activeSide: 'axis', map: makeMap('Major River'), units, ...over }
}

function expectOk(outcome: StepOutcome): Extract<StepOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`预期成功，实得失败：${outcome.reason} / ${outcome.rule}`)
  return outcome
}

describe('13.8b 例外：失能单位可用**自己架的桥**离开该格', () => {
  it('★ 该单位自有桥格 = 本步出格 ⇒ 大河降为小河，轮式可通过（修前不可）', () => {
    const plain = context([unit()])
    // 13.8b 前半句已不成立（该格此刻无工程能力单位）⇒ 大河对轮式仍是禁入
    expect(plain.ownBridgeHexByUnitId).toBeUndefined()
    const before = evaluateStep(plain, 'u1', TO)
    expect(before.ok).toBe(false)
    if (!before.ok) expect(before.reason).toBe('prohibited')

    const own = context([unit()], { ownBridgeHexByUnitId: { u1: FROM } })
    // 大河 → 小河：Open 1 + 轮式过小河 5 = 6
    expect(expectOk(evaluateStep(own, 'u1', TO)).cost).toBe(6)
  })

  it('桥对该单位已消失 ⇒ **同格第三方**不能借这座桥（按单位通道不通）', () => {
    const other = unit({ id: 'u2' })
    const onlyFirstHasBridge = context([unit(), other], {
      ownBridgeHexByUnitId: { u1: FROM },
    })
    expect(expectOk(evaluateStep(onlyFirstHasBridge, 'u1', TO)).cost).toBe(6)
    const forOther = evaluateStep(onlyFirstHasBridge, 'u2', TO)
    expect(forOther.ok).toBe(false)
    if (!forOther.ok) expect(forOther.reason).toBe('prohibited')
  })

  it('自有桥格**不是**本步出格 ⇒ 不降级（例外只授权离开那一格）', () => {
    const wrongHex = context([unit()], { ownBridgeHexByUnitId: { u1: TO } })
    const outcome = evaluateStep(wrongHex, 'u1', TO)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('prohibited')
  })

  it('8.1c：突袭步照旧**不得**借（自己架的）桥过河', () => {
    const own = context([unit()], { ownBridgeHexByUnitId: { u1: FROM } })
    expect(expectOk(evaluateStep(own, 'u1', TO)).cost).toBe(6)
    expect(evaluateStep(own, 'u1', TO, { forOverrun: true }).ok).toBe(false)
  })

  it('步行过小河：自有桥格 = 出格 ⇒ 无额外消耗（2 MP → 1 MP）', () => {
    const leg = () => unit({ mobility: 'leg' })
    const plain = {
      ...context([leg()], { ownBridgeHexByUnitId: { u1: FROM } }),
      map: makeMap('Minor River'),
    }
    expect(expectOk(evaluateStep(plain, 'u1', TO)).cost).toBe(1)
    const without = { ...plain, ownBridgeHexByUnitId: undefined }
    expect(expectOk(evaluateStep(without, 'u1', TO)).cost).toBe(2)
  })
})
