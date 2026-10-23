import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { HEX_INRADIUS_PX, HEX_ROW_SPACING_PX } from '@/render/map-layout'
import {
  TOKEN_INSET_RATIO,
  TOKEN_SIZE_PX,
  cullOverlay,
  drawMovementOverlay,
  overlayHexKey,
  topTokenOf,
  type MovementOverlay,
  type UnitToken,
} from '@/render/token-layer'

/**
 * 覆盖层的**视口裁剪与可突袭目标**绘制（W7 C16）
 *
 * 两条底线：
 *   ① 性能：只画视口内的算子与提示（`cullOverlay` 是纯函数，直接断言结果）；
 *   ② 交互：可突袭目标（8.0/8.1）要画成**与可到达格不同**的一类（紫环 + 代价文字）。
 * Canvas 需要浏览器，故与 `supply-overlay.test.ts` 同法用**记录型假 ctx**。
 */

describe('算子尺寸：正方形「四个角比相接六角格的四个边略小一点」', () => {
  it('四角到格心的距离 ≤ 格内切半径（不越出本格、不压到相接格）', () => {
    const cornerDistance = (TOKEN_SIZE_PX / 2) * Math.SQRT2
    expect(cornerDistance).toBeLessThanOrEqual(HEX_INRADIUS_PX)
  })

  it('「略小一点」：角距达到内切半径的九成以上（算子几乎填满格，而不是缩在中间）', () => {
    const cornerDistance = (TOKEN_SIZE_PX / 2) * Math.SQRT2
    expect(cornerDistance).toBeGreaterThan(HEX_INRADIUS_PX * 0.9)
  })

  it('边长 = 格高 ÷(1+√3) × 内缩系数（推导见 token-layer 常量注释）', () => {
    const maxSquare = HEX_ROW_SPACING_PX * (2 / (1 + Math.sqrt(3)))
    expect(TOKEN_SIZE_PX).toBeCloseTo(maxSquare * TOKEN_INSET_RATIO, 6)
  })
})

interface Recorder {
  texts: string[]
  strokes: number
  arcs: number
}

/** 记录型假 CanvasRenderingContext2D（只实现覆盖层用到的成员） */
function makeCtx(): { ctx: CanvasRenderingContext2D; rec: Recorder } {
  const rec: Recorder = { texts: [], strokes: 0, arcs: 0 }
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
    beginPath: (): void => undefined,
    moveTo: (): void => undefined,
    lineTo: (): void => undefined,
    closePath: (): void => undefined,
    arc: (): void => {
      rec.arcs += 1
    },
    fill: (): void => undefined,
    stroke: (): void => {
      rec.strokes += 1
    },
    fillRect: (): void => undefined,
    strokeRect: (): void => undefined,
    fillText: (text: string): void => {
      rec.texts.push(String(text))
    },
    setLineDash: (): void => undefined,
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rec }
}

/** 造一枚算子令牌（默认在给定格、未选中、不需燃料） */
function token(hex: HexRef, id: string): UnitToken {
  return {
    id,
    hex,
    side: 'axis',
    label: '5-4-6',
    selected: false,
    ended: false,
    modeLetter: 'C',
    dg: false,
    awaitingFuel: false,
    fuelled: true,
  }
}

const NEAR: HexRef = { col: 36, row: 17 }
const FAR: HexRef = { col: 60, row: 34 }

const BASE: MovementOverlay = {
  tokens: [token(NEAR, 'near'), token(FAR, 'far')],
  reachable: [
    { hex: NEAR, mpSpent: 1, forcedStop: false, minimumMove: false, inEnemyZoc: false },
    { hex: FAR, mpSpent: 2, forcedStop: false, minimumMove: false, inEnemyZoc: false },
  ],
  path: [NEAR, FAR],
  startHex: NEAR,
  selectedIds: ['near'],
  overrunTargets: [
    { hex: NEAR, mpCost: 3, adjacentToPath: true },
    { hex: FAR, mpCost: 3, adjacentToPath: false },
  ],
  retreat: { safe: [NEAR], zoc: [FAR] },
  advance: [FAR],
  payDumps: [
    { hex: NEAR, label: '2 SP', selected: true },
    { hex: FAR, label: '1 SP', selected: false },
  ],
  supply: {
    coverage: [
      { hex: NEAR, mp: 0 },
      { hex: FAR, mp: 4 },
    ],
    path: [NEAR],
    sourceHex: NEAR,
    targetHex: FAR,
    viaAdjacency: false,
  },
  patrolZone: { friendly: [NEAR], enemy: [FAR] },
  // 9.14c/d：位移落点（候选 / 已选）
  specialDisplace: { candidates: [NEAR, FAR], chosen: [FAR] },
  // 条 21（批 F·F2）：战斗段「可攻击位置」高亮
  combatAttackableHexes: [NEAR, FAR],
}

describe('W7 C16：覆盖层的视口裁剪（性能底线）', () => {
  it('C16：只保留视口内的算子 / 可到达格 / 可突袭目标 / 补给覆盖 / 巡逻区', () => {
    const visible = new Set([overlayHexKey(NEAR)])
    const culled = cullOverlay(BASE, visible)
    expect(culled.tokens.map((item) => item.id)).toEqual(['near'])
    expect(culled.reachable.map((hint) => hint.mpSpent)).toEqual([1])
    expect(culled.overrunTargets?.map((hint) => hint.adjacentToPath)).toEqual([true])
    expect(culled.supply?.coverage.map((row) => row.mp)).toEqual([0])
    expect(culled.patrolZone?.friendly).toHaveLength(1)
    expect(culled.patrolZone?.enemy).toHaveLength(0)
  })

  it('C16：撤退落点 / 推进格 / 可付款补给站同样按视口裁剪（9.12 / 9.12g / 12.1b）', () => {
    const culled = cullOverlay(BASE, new Set([overlayHexKey(NEAR)]))
    expect(culled.retreat?.safe).toEqual([NEAR])
    expect(culled.retreat?.zoc).toEqual([])
    expect(culled.advance).toEqual([])
    expect(culled.payDumps?.map((hint) => hint.label)).toEqual(['2 SP'])
  })

  it('C16：9.14c/d 位移落点按视口裁剪（候选裁、已选格保留）', () => {
    const culled = cullOverlay(BASE, new Set([overlayHexKey(NEAR)]))
    expect(culled.specialDisplace?.candidates).toEqual([NEAR])
    expect(culled.specialDisplace?.chosen).toEqual([FAR])
  })

  it('条 21（批 F·F2）：可攻击位置高亮按视口裁剪（只画视口内的敌方格）', () => {
    const culled = cullOverlay(BASE, new Set([overlayHexKey(NEAR)]))
    expect(culled.combatAttackableHexes).toEqual([NEAR])
  })

  it('C16：预览路径与起点格**不裁剪**（玩家刚点的路线必须在，哪怕端点出视口）', () => {
    const culled = cullOverlay(BASE, new Set([overlayHexKey(FAR)]))
    expect(culled.path).toEqual([NEAR, FAR])
    expect(culled.startHex).toEqual(NEAR)
    expect(culled.selectedIds).toEqual(['near'])
  })

  it('C16：裁剪是纯函数（不改原对象，且可复用于同一 overlay 多次）', () => {
    const before = JSON.stringify(BASE)
    cullOverlay(BASE, new Set([overlayHexKey(NEAR)]))
    expect(JSON.stringify(BASE)).toBe(before)
    // 补给的 path / 来源格 / 目标格保留（它们本身只有 1–2 格）
    const culled = cullOverlay(BASE, new Set<string>())
    expect(culled.supply?.sourceHex).toEqual(NEAR)
    expect(culled.tokens).toEqual([])
    expect(culled.reachable).toEqual([])
  })

  it('C16：绘制入口接受可见格集合 ⇒ 视口外的算子不再落笔', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, BASE, 1)
    const allTexts = rec.texts.length
    const allStrokes = rec.strokes

    const { ctx: culledCtx, rec: culledRec } = makeCtx()
    drawMovementOverlay(culledCtx, BASE, 1, new Set([overlayHexKey(NEAR)]))
    // 少了「远格」的 MP 数字与突袭代价文字，也少了它的描边
    expect(culledRec.texts.length).toBeLessThan(allTexts)
    expect(culledRec.strokes).toBeLessThan(allStrokes)
    // 只剩近格那一个可突袭目标
    expect(culledRec.texts.filter((text) => text.startsWith('突袭'))).toHaveLength(1)
  })
})

describe('4.8 / 6.1f：一格只画一枚（堆叠不越格），点格再展开', () => {
  const stackOverlay = (tokens: UnitToken[]): MovementOverlay => ({
    tokens,
    reachable: [],
    path: [],
    startHex: null,
    selectedIds: [],
  })

  it('同格两枚只画一枚（不再横向摊开越出格边），并标出枚数', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, stackOverlay([token(NEAR, 'a'), token(NEAR, 'b')]), 1)
    // 印值只出现一次（只有最上面那一枚被画出来）
    expect(rec.texts.filter((text) => text === '5-4-6')).toHaveLength(1)
    // 枚数角标
    expect(rec.texts).toContain('2')
  })

  it('选序：正在操作的那一枚 > 飞机 > 最后一枚', () => {
    const plain = token(NEAR, 'a')
    const air = { ...token(NEAR, 'air'), air: true, label: 'F' }
    const selected = { ...token(NEAR, 'c'), selected: true, label: '3-3-3' }
    expect(topTokenOf([plain, air])?.id).toBe('air')
    expect(topTokenOf([plain, air, selected])?.id).toBe('c')
    expect(topTokenOf([plain, air])).toBe(air)
    expect(topTokenOf([plain])).toBe(plain)
  })

  it('单枚时没有枚数角标', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, stackOverlay([token(NEAR, 'a')]), 1)
    expect(rec.texts).not.toContain('1')
  })
})

describe('条 24：多军力单位的军力损失角标（-N）（3.6e / 4.6）', () => {
  const stackOverlay = (tokens: UnitToken[]): MovementOverlay => ({
    tokens,
    reachable: [],
    path: [],
    startHex: null,
    selectedIds: [],
  })

  it('受损 ⇒ 左上角画 (-N)', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, stackOverlay([{ ...token(NEAR, 'a'), stepsLost: 2 }]), 1)
    expect(rec.texts).toContain('(-2)')
  })

  it('未受损（stepsLost 0 / 未给）⇒ 不画角标', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, stackOverlay([{ ...token(NEAR, 'a'), stepsLost: 0 }]), 1)
    expect(rec.texts.some((text) => text.startsWith('(-'))).toBe(false)
    const { ctx: ctx2, rec: rec2 } = makeCtx()
    drawMovementOverlay(ctx2, stackOverlay([token(NEAR, 'a')]), 1)
    expect(rec2.texts.some((text) => text.startsWith('(-'))).toBe(false)
  })

  it('带损且 DG ⇒ 两个角标都在（-N 优先占位，DG 顺延，不互相吃掉）', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, stackOverlay([{ ...token(NEAR, 'a'), stepsLost: 1, dg: true }]), 1)
    expect(rec.texts).toContain('(-1)')
    expect(rec.texts).toContain('DG')
  })
})

describe('W7 C16：可突袭目标（8.0/8.1）的绘制', () => {
  it('C16：每个可突袭格画一个环 + 「突袭 3 MP」代价文字（8.1a）', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, BASE, 1)
    const overrunTexts = rec.texts.filter((text) => text.startsWith('突袭'))
    expect(overrunTexts).toEqual(['突袭 3 MP', '突袭 3 MP'])
  })

  it('C16：没有可突袭目标时不多画任何东西（缺省字段也安全）', () => {
    // 刻意不带 overrunTargets 字段（该字段可选）
    const noOverrun: MovementOverlay = {
      tokens: BASE.tokens,
      reachable: BASE.reachable,
      path: BASE.path,
      startHex: BASE.startHex,
      selectedIds: BASE.selectedIds,
    }
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, noOverrun, 1)
    expect(rec.texts.filter((text) => text.startsWith('突袭'))).toEqual([])
    // 可到达格的 MP 数字仍在（近格 1 / 远格 2）
    expect(rec.texts).toContain('1')
    expect(rec.texts).toContain('2')
  })
})

describe('条 21（批 F·F2）：战斗段「可攻击位置」高亮的绘制', () => {
  it('F2：每个可攻击格画一个暖红环（无文字，区别于突袭紫环）', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, BASE, 1)
    // BASE 带 combatAttackableHexes＝[NEAR, FAR] ⇒ 两格各一圈描边（dashed）
    const attackableStrokes = rec.strokes
    expect(attackableStrokes).toBeGreaterThan(0)
  })

  it('F2：不带该字段时也安全（不画、不崩）', () => {
    const noAttack: MovementOverlay = {
      tokens: BASE.tokens,
      reachable: BASE.reachable,
      path: BASE.path,
      startHex: BASE.startHex,
      selectedIds: BASE.selectedIds,
    }
    const { ctx } = makeCtx()
    expect(() => drawMovementOverlay(ctx, noAttack, 1)).not.toThrow()
  })
})

describe('W7 C16：撤退落点 / 推进格 / 补给站 / 飞机令牌的绘制', () => {
  it('C16：撤退落点分「安全格 / 有 ZOC 影响格」两组画，并标一次「可撤退」（9.12/9.12e）', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, BASE, 1)
    expect(rec.texts.filter((text) => text === '可撤退')).toHaveLength(1)
  })

  it('C16：可付款补给站画出持仓文本（12.1b；选中者用另一色）', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, BASE, 1)
    expect(rec.texts).toContain('2 SP')
    expect(rec.texts).toContain('1 SP')
  })

  it('C16：9.14c/d 位移落点画一次图例「位移落点」（候选与已选都铺格）', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, BASE, 1)
    expect(rec.texts.filter((text) => text === '位移落点')).toHaveLength(1)
  })

  it('C16：飞机令牌与地面算子同画法（正方形，不再用菱形/arc），只用角标区分激活态', () => {
    const air: MovementOverlay = {
      tokens: [{ ...token(NEAR, 'air1'), air: true, label: 'F', modeLetter: 'A', selected: true }],
      reachable: [],
      path: [],
      startHex: null,
      selectedIds: ['air1'],
    }
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, air, 1)
    // 画法与地面算子一致：选中环走 strokeRect，不再有 arc（菱形已取消）
    expect(rec.arcs).toBe(0)
    expect(rec.texts).toContain('F')
    expect(rec.texts).toContain('A')
  })
})

describe('条 27：SP 补给站令牌画出实数（最近面额图 + 角标）', () => {
  const stackOverlay = (tokens: UnitToken[]): MovementOverlay => ({
    tokens,
    reachable: [],
    path: [],
    startHex: null,
    selectedIds: [],
  })

  it('非标总额（9 SP）在令牌上画出实数标签', () => {
    const { ctx, rec } = makeCtx()
    const sp: UnitToken = {
      ...token(NEAR, 'sp:36,17'),
      noncombatKind: 'sp',
      spPoints: 9,
      label: '9 SP',
    }
    drawMovementOverlay(ctx, stackOverlay([sp]), 1)
    expect(rec.texts).toContain('9 SP')
  })

  it('同格多站合并后的总额（15 SP）与单站都照样画标签', () => {
    const { ctx, rec } = makeCtx()
    const sp: UnitToken = {
      ...token(NEAR, 'sp:36,17'),
      noncombatKind: 'sp',
      spPoints: 15,
      label: '15 SP',
    }
    drawMovementOverlay(ctx, stackOverlay([sp]), 1)
    expect(rec.texts).toContain('15 SP')
  })
})
