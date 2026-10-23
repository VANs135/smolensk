import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'

import { neighbor } from '@/engine/hex-geometry'
import {
  applyModeSwitch,
  beginMove,
  canSwitchModeNow,
  cancelMove,
  endMoveEarly,
  planFuelPayment,
  planStep,
  previewStep,
  reachableForMove,
  reachableNodeAt,
  undoMoveStep,
} from '@/engine/rules'
import type { MoveContext, MoveUnitRuntime, MoveUnitView } from '@/engine/rules'

/**
 * 移动交互（C5；OCS 6.1 / 6.1a / 6.1b / 6.1e / 6.1f / 6.1g / 4.5a-A / 4.5b / 5.4 / 5.8a / 12.5）
 *
 * 用**合成地图**（默认全 Open，1 MP/格）隔离规则，断言逐步的 MP 记账、堆叠掉队、
 * ZOC 强制停止、撤销快照、模式切换时机与燃料费用。
 */

const key = (hex: HexRef): string => `${hex.col}.${hex.row}`

function makeMap(terrains: Record<string, readonly string[]> = {}) {
  return {
    onMap: () => true,
    terrainsAt: (hex: HexRef): readonly string[] => terrains[key(hex)] ?? ['Open'],
    crossingBetween: () => null,
  }
}

/** 单位视图夹具：默认轴方步行战斗单位、战斗模式、MA 6、已加注燃料 */
function unit(over: Partial<MoveUnitView> = {}): MoveUnitView {
  return {
    id: 'u1',
    side: 'axis',
    isCombat: true,
    attackCapable: true,
    hasTraceSupply: true,
    hex: { col: 10, row: 10 },
    mobility: 'leg',
    ma: 6,
    re: 2,
    mode: 'combat',
    orientation: 'combat',
    dg: false,
    exploit: false,
    releasedFromReserve: false,
    fuelled: true,
    mpLockedThisPhase: false,
    ...over,
  }
}

/** 敌方 ZOC 源（战斗模式 + 可攻击 + 非断补 + 未混乱） */
function enemy(hex: HexRef, over: Partial<MoveUnitView> = {}): MoveUnitView {
  return unit({ id: `enemy-${key(hex)}`, side: 'soviet', hex, ...over })
}

function context(units: readonly MoveUnitView[], over: Partial<MoveContext> = {}): MoveContext {
  return { phase: 'movement', activeSide: 'axis', map: makeMap(), units, ...over }
}

/** 由单位视图造运行态（初始：未耗 MP、未结束） */
function runtimeOf(unitViews: readonly MoveUnitView[]): MoveUnitRuntime[] {
  return unitViews.map((view) => ({
    unitId: view.id,
    hex: view.hex!,
    spentMp: 0,
    ended: false,
  }))
}

/** 把引擎给的 patches 落到运行态上（与 store 的落盘同规） */
function applyPatches(
  runtime: readonly MoveUnitRuntime[],
  patches: readonly MoveUnitRuntime[],
): MoveUnitRuntime[] {
  return runtime.map((item) => {
    const patch = patches.find((candidate) => candidate.unitId === item.unitId)
    return patch === undefined ? { ...item } : { ...patch }
  })
}

/** 开始一次移动（夹具收窄辅助） */
function startMove(ctx: MoveContext, unitIds: string[], runtime: MoveUnitRuntime[]) {
  const result = beginMove({ context: ctx, unitIds, runtime })
  if (!result.ok) throw new Error(`预期能开始移动，实得：${result.reason} / ${result.rule}`)
  return result.data
}

describe('6.1 开始移动（单位或堆叠）', () => {
  it('单个单位可以开始移动', () => {
    const views = [unit()]
    const state = startMove(context(views), ['u1'], runtimeOf(views))
    expect(state.unitIds).toEqual(['u1'])
    expect(state.start).toEqual({ col: 10, row: 10 })
    expect(state.steps).toEqual([])
    expect(state.finished).toBe(false)
  })

  it('堆叠可以一起开始移动（6.1）', () => {
    const views = [unit(), unit({ id: 'u2' })]
    const state = startMove(context(views), ['u1', 'u2'], runtimeOf(views))
    expect(state.unitIds).toEqual(['u1', 'u2'])
  })

  it('6.1b：无 MA 的单位不能开始移动', () => {
    const views = [unit({ ma: 0 })]
    const result = beginMove({
      context: context(views),
      unitIds: ['u1'],
      runtime: runtimeOf(views),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rule).toBe('6.1b')
  })

  it('6.1g：本轮移动已结束的单位不能再次开始移动', () => {
    const views = [unit()]
    const runtime = runtimeOf(views).map((item) => ({ ...item, ended: true }))
    const result = beginMove({ context: context(views), unitIds: ['u1'], runtime })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rule).toBe('6.1g')
  })

  it('12.5a：轮式战斗单位未加注燃料不能开始移动', () => {
    const views = [unit({ mobility: 'truck', fuelled: false })]
    const result = beginMove({
      context: context(views),
      unitIds: ['u1'],
      runtime: runtimeOf(views),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rule).toBe('12.5a')
  })
})

describe('6.1b / 6.1e / 6.1f 可移动范围', () => {
  it('空地 1 MP/格：MA 6 的步行单位可到达这些格且 MP 为格数', () => {
    const views = [unit()]
    const ctx = context(views)
    const state = startMove(ctx, ['u1'], runtimeOf(views))
    const reach = reachableForMove({ context: ctx, interaction: state, runtime: runtimeOf(views) })
    expect(reach.units).toHaveLength(1)
    expect(reach.units[0]!.ok).toBe(true)
    expect(reach.units[0]!.remaining).toBe(6)
    const node = reachableNodeAt(reach.hexes, { col: 11, row: 10 })
    expect(node).not.toBeNull()
    expect(node!.mpSpent).toBe(1)
    expect(node!.path[0]).toEqual({ col: 10, row: 10 })
    expect(node!.path.at(-1)).toEqual({ col: 11, row: 10 })
  })

  it('6.1b：已耗 MP 会压缩剩余额度（阶段总额度）', () => {
    const views = [unit()]
    const ctx = context(views)
    const state = startMove(ctx, ['u1'], runtimeOf(views))
    const spent = runtimeOf(views).map((item) => ({ ...item, spentMp: 4 }))
    const reach = reachableForMove({ context: ctx, interaction: state, runtime: spent })
    expect(reach.units[0]!.remaining).toBe(2)
    // 距离 3 的格已超出剩余额度
    expect(reachableNodeAt(reach.hexes, { col: 13, row: 10 })).toBeNull()
  })

  it('6.1f：堆叠取并集 —— 个别单位走不到的格，只要还有人能到就算可到达', () => {
    const views = [unit(), unit({ id: 'u2', ma: 1 })]
    const ctx = context(views)
    const state = startMove(ctx, ['u1', 'u2'], runtimeOf(views))
    const reach = reachableForMove({ context: ctx, interaction: state, runtime: runtimeOf(views) })
    const far = reachableNodeAt(reach.hexes, { col: 14, row: 10 })
    expect(far).not.toBeNull()
    expect(far!.byUnit.map((item) => item.unitId)).toEqual(['u1'])
    const near = reachableNodeAt(reach.hexes, { col: 11, row: 10 })
    expect(near!.byUnit.map((item) => item.unitId).sort()).toEqual(['u1', 'u2'])
  })

  it('已结束本轮移动的单位不再贡献可到达范围', () => {
    const views = [unit()]
    const ctx = context(views)
    const state = startMove(ctx, ['u1'], runtimeOf(views))
    const ended = runtimeOf(views).map((item) => ({ ...item, ended: true }))
    const reach = reachableForMove({ context: ctx, interaction: state, runtime: ended })
    expect(reach.hexes).toHaveLength(0)
  })

  it('4.5a-A：可到达格会标出「处于未抵消敌方 ZOC」', () => {
    const target = { col: 11, row: 10 }
    const enemyHex = neighbor(target, 'NE')
    const views = [unit(), enemy(enemyHex)]
    const ctx = context(views)
    const state = startMove(ctx, ['u1'], runtimeOf(views))
    const reach = reachableForMove({ context: ctx, interaction: state, runtime: runtimeOf(views) })
    expect(reachableNodeAt(reach.hexes, target)!.inEnemyZoc).toBe(true)
    expect(reachableNodeAt(reach.hexes, { col: 10, row: 11 })!.inEnemyZoc).toBe(false)
  })
})

describe('6.1a / 4.5a-A 单步预览', () => {
  it('预览给出路径、消耗与 6.2 明细', () => {
    const views = [unit()]
    const ctx = context(views)
    const runtime = runtimeOf(views)
    const state = startMove(ctx, ['u1'], runtime)
    const preview = previewStep({
      context: ctx,
      interaction: state,
      runtime,
      to: { col: 11, row: 10 },
    })
    expect(preview.ok).toBe(true)
    expect(preview.moving).toHaveLength(1)
    expect(preview.moving[0]!.cost).toBe(1)
    expect(preview.needsConfirm).toBe(false)
    expect(preview.path).toEqual([
      { col: 10, row: 10 },
      { col: 11, row: 10 },
    ])
  })

  it('4.5a-A：轮式单位进入敌方 ZOC → 必须确认并就地停止', () => {
    const target = { col: 11, row: 10 }
    const views = [unit({ mobility: 'truck' }), enemy(neighbor(target, 'NE'))]
    const ctx = context(views)
    const runtime = runtimeOf(views)
    const state = startMove(ctx, ['u1'], runtime)
    const preview = previewStep({ context: ctx, interaction: state, runtime, to: target })
    expect(preview.enteringEnemyZoc).toBe(true)
    expect(preview.zocStoppingIds).toEqual(['u1'])
    expect(preview.needsConfirm).toBe(true)
  })

  it('4.5a-A 括注：步行/履带单位不受 ZOC 影响（无需确认）', () => {
    const target = { col: 11, row: 10 }
    const views = [unit({ mobility: 'leg' }), enemy(neighbor(target, 'NE'))]
    const ctx = context(views)
    const runtime = runtimeOf(views)
    const state = startMove(ctx, ['u1'], runtime)
    const preview = previewStep({ context: ctx, interaction: state, runtime, to: target })
    expect(preview.enteringEnemyZoc).toBe(true)
    expect(preview.zocStoppingIds).toEqual([])
    expect(preview.needsConfirm).toBe(false)
  })

  it('5.8a：战略模式单位不可进入敌方 ZOC（该单位只能留下）', () => {
    const target = { col: 11, row: 10 }
    const views = [unit({ mode: 'strat', orientation: 'move' }), enemy(neighbor(target, 'NE'))]
    const ctx = context(views)
    const runtime = runtimeOf(views)
    const state = startMove(ctx, ['u1'], runtime)
    const preview = previewStep({ context: ctx, interaction: state, runtime, to: target })
    expect(preview.stratBlockedIds).toEqual(['u1'])
    expect(preview.ok).toBe(false)
  })
})

describe('6.1a / 6.1e / 6.1f 提交单步', () => {
  it('单一单位前进一步：位置、MP、历史都正确', () => {
    const views = [unit()]
    const ctx = context(views)
    let runtime = runtimeOf(views)
    let state = startMove(ctx, ['u1'], runtime)

    const step = planStep({ context: ctx, interaction: state, runtime, to: { col: 11, row: 10 } })
    expect(step.ok).toBe(true)
    if (!step.ok) return
    runtime = applyPatches(runtime, step.data.patches)
    state = step.data.interaction

    expect(runtime[0]!.hex).toEqual({ col: 11, row: 10 })
    expect(runtime[0]!.spentMp).toBe(1)
    expect(state.steps).toHaveLength(1)
    expect(state.steps[0]!.movedIds).toEqual(['u1'])
    expect(state.steps[0]!.costById).toEqual({ u1: 1 })
  })

  it('6.1e：堆叠内各单位分别记账（同一格、不同移动类型 ⇒ 消耗不同）', () => {
    // Forest 的 TEC 费率：步行 2 / 履带 3 / 轮式 4（charts-tec.json）
    const target = { col: 11, row: 10 }
    const views = [unit(), unit({ id: 'u2', mobility: 'track' })]
    const ctx = context(views, { map: makeMap({ [key(target)]: ['Forest'] }) })
    let runtime = runtimeOf(views)
    const state = startMove(ctx, ['u1', 'u2'], runtime)

    const step = planStep({ context: ctx, interaction: state, runtime, to: target })
    expect(step.ok).toBe(true)
    if (!step.ok) return
    runtime = applyPatches(runtime, step.data.patches)
    // 6.1e：MA 与消耗彼此独立，不能互相转移
    expect(step.data.record.costById).toEqual({ u1: 2, u2: 3 })
    expect(runtime.find((item) => item.unitId === 'u1')!.spentMp).toBe(2)
    expect(runtime.find((item) => item.unitId === 'u2')!.spentMp).toBe(3)
    // 引擎为纯函数：入参 state 不被就地修改，新状态在返回值里
    expect(state.steps).toHaveLength(0)
    expect(step.data.interaction.steps).toHaveLength(1)
  })

  it('6.1f：跟不上堆叠的单位留在原格并结束本轮移动', () => {
    const views = [unit(), unit({ id: 'u2', ma: 1 })]
    const ctx = context(views)
    let runtime = runtimeOf(views)
    let state = startMove(ctx, ['u1', 'u2'], runtime)

    // 第 1 步：两个都能走
    const first = planStep({ context: ctx, interaction: state, runtime, to: { col: 11, row: 10 } })
    if (!first.ok) throw new Error('第 1 步应可提交')
    runtime = applyPatches(runtime, first.data.patches)
    state = first.data.interaction
    expect(runtime.every((item) => item.spentMp === 1)).toBe(true)

    // 第 2 步：u2 的 MA=1 已用尽 → 留在 (11,10) 并结束；u1 继续
    const second = planStep({ context: ctx, interaction: state, runtime, to: { col: 12, row: 10 } })
    if (!second.ok) throw new Error('第 2 步应可提交（至少 u1 能走）')
    expect(second.data.record.droppedIds).toEqual(['u2'])
    runtime = applyPatches(runtime, second.data.patches)
    state = second.data.interaction

    const u1 = runtime.find((item) => item.unitId === 'u1')!
    const u2 = runtime.find((item) => item.unitId === 'u2')!
    expect(u1.hex).toEqual({ col: 12, row: 10 })
    expect(u1.ended).toBe(false)
    expect(u2.hex).toEqual({ col: 11, row: 10 })
    expect(u2.ended).toBe(true) // 6.1f：离开堆叠即不得再移动
    expect(state.finished).toBe(false)
  })

  it('4.5a-A：轮式单位进入敌方 ZOC 后落下 ended 标记', () => {
    const target = { col: 11, row: 10 }
    const views = [unit({ mobility: 'truck' }), enemy(neighbor(target, 'NE'))]
    const ctx = context(views)
    let runtime = runtimeOf(views)
    const state = startMove(ctx, ['u1'], runtime)

    const step = planStep({ context: ctx, interaction: state, runtime, to: target })
    if (!step.ok) throw new Error('该步应可提交')
    runtime = applyPatches(runtime, step.data.patches)
    expect(step.data.record.zocStoppedIds).toEqual(['u1'])
    expect(runtime[0]!.ended).toBe(true)
    expect(step.data.interaction.finished).toBe(true)
  })

  it('6.1b/6.1c：MP 用尽后不能再走（最小移动只在 mpSpent=0 时放行）', () => {
    const views = [unit({ ma: 1 })]
    const ctx = context(views)
    let runtime = runtimeOf(views)
    let state = startMove(ctx, ['u1'], runtime)

    const first = planStep({ context: ctx, interaction: state, runtime, to: { col: 11, row: 10 } })
    if (!first.ok) throw new Error('第 1 步应可提交')
    runtime = applyPatches(runtime, first.data.patches)
    state = first.data.interaction

    const second = planStep({ context: ctx, interaction: state, runtime, to: { col: 12, row: 10 } })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.rule).toBe('6.1a')
  })

  it('不相邻的格不能走（6.1：移动必须沿连续格）', () => {
    const views = [unit()]
    const ctx = context(views)
    const runtime = runtimeOf(views)
    const state = startMove(ctx, ['u1'], runtime)
    const step = planStep({ context: ctx, interaction: state, runtime, to: { col: 13, row: 10 } })
    expect(step.ok).toBe(false)
    if (!step.ok) expect(step.rule).toBe('6.1')
  })
})

describe('撤销 / 取消 / 结束移动', () => {
  it('撤销一步回到该步之前（位置与 MP 都还原）', () => {
    const views = [unit()]
    const ctx = context(views)
    let runtime = runtimeOf(views)
    let state = startMove(ctx, ['u1'], runtime)

    const step = planStep({ context: ctx, interaction: state, runtime, to: { col: 11, row: 10 } })
    if (!step.ok) throw new Error('该步应可提交')
    runtime = applyPatches(runtime, step.data.patches)
    state = step.data.interaction

    const reverted = undoMoveStep(state)
    runtime = applyPatches(runtime, reverted.patches)
    state = reverted.interaction
    expect(runtime[0]!.hex).toEqual({ col: 10, row: 10 })
    expect(runtime[0]!.spentMp).toBe(0)
    expect(state.steps).toHaveLength(0)

    // 撤销后原格重新可走
    const again = planStep({ context: ctx, interaction: state, runtime, to: { col: 11, row: 10 } })
    expect(again.ok).toBe(true)
  })

  it('取消整次移动回到起点（多步一并还原）', () => {
    const views = [unit()]
    const ctx = context(views)
    let runtime = runtimeOf(views)
    let state = startMove(ctx, ['u1'], runtime)
    for (const to of [
      { col: 11, row: 10 },
      { col: 12, row: 10 },
    ]) {
      const step = planStep({ context: ctx, interaction: state, runtime, to })
      if (!step.ok) throw new Error('该步应可提交')
      runtime = applyPatches(runtime, step.data.patches)
      state = step.data.interaction
    }
    expect(runtime[0]!.spentMp).toBe(2)

    const cancelled = cancelMove(state)
    runtime = applyPatches(runtime, cancelled.patches)
    expect(runtime[0]!.hex).toEqual({ col: 10, row: 10 })
    expect(runtime[0]!.spentMp).toBe(0)
    expect(cancelled.interaction.steps).toHaveLength(0)
  })

  it('6.1：结束移动把仍在移动的单位就地停下，且该步本身可撤销', () => {
    const views = [unit(), unit({ id: 'u2' })]
    const ctx = context(views)
    let runtime = runtimeOf(views)
    let state = startMove(ctx, ['u1', 'u2'], runtime)
    const step = planStep({ context: ctx, interaction: state, runtime, to: { col: 11, row: 10 } })
    if (!step.ok) throw new Error('该步应可提交')
    runtime = applyPatches(runtime, step.data.patches)
    state = step.data.interaction

    const ended = endMoveEarly({ interaction: state, runtime })
    expect(ended.record?.kind).toBe('end')
    runtime = applyPatches(runtime, ended.patches)
    state = ended.interaction
    expect(runtime.every((item) => item.ended)).toBe(true)
    expect(state.finished).toBe(true)

    // 撤销「结束移动」这一步 ⇒ 重新回到移动中
    const reverted = undoMoveStep(state)
    runtime = applyPatches(runtime, reverted.patches)
    state = reverted.interaction
    expect(runtime.every((item) => !item.ended)).toBe(true)
    expect(state.finished).toBe(false)
    expect(state.steps).toHaveLength(1)
  })
})

describe('5.4 模式切换时机与形态', () => {
  const base = {
    context: context([unit()]),
    unitId: 'u1',
    to: 'move' as const,
    orientation: 'move' as const,
    unitClass: 'combat' as const,
  }

  it('5.4：未开始移动时可以切换（本阶段已耗 MP = 0）', () => {
    const views = base.context.units as readonly MoveUnitView[]
    const verdict = canSwitchModeNow({ ...base, runtime: runtimeOf(views) })
    expect(verdict.ok).toBe(true)
  })

  it('5.4 + 6.1g：已消耗过 MP 就不能再切（切换发生在开始移动时）', () => {
    const views = base.context.units as readonly MoveUnitView[]
    const runtime = runtimeOf(views).map((item) => ({ ...item, spentMp: 1 }))
    const verdict = canSwitchModeNow({ ...base, runtime })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.rule).toBe('5.4')
  })

  it('5.4：只能在移动阶段切换', () => {
    const views = [unit()]
    const verdict = canSwitchModeNow({
      ...base,
      context: context(views, { phase: 'reaction' }),
      runtime: runtimeOf(views),
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.rule).toBe('5.4')
  })

  it('5.8a：在敌方 ZOC 内不可进入战略模式', () => {
    const hex = { col: 10, row: 10 }
    const views = [unit({ hex }), enemy(neighbor(hex, 'NE'))]
    const verdict = canSwitchModeNow({
      ...base,
      context: context(views),
      to: 'strat',
      orientation: 'move',
      runtime: runtimeOf(views),
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.rule).toBe('5.8a')
  })

  it('专规 2.3e：8 月 1 日前苏军不可进入战略模式', () => {
    const views = [unit({ side: 'soviet' })]
    const verdict = canSwitchModeNow({
      ...base,
      context: context(views, { activeSide: 'soviet' }),
      to: 'strat',
      orientation: 'move',
      date: '1941-07-19',
      runtime: runtimeOf(views),
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.rule).toBe('专规 2.3e')
  })

  it('5.5/5.6：战斗/移动模式切换会一并把朝向设到对应面；预备保留所选朝向', () => {
    const state = {
      mode: 'combat' as const,
      orientation: 'combat' as const,
      dg: false,
      exploit: false,
    }
    expect(applyModeSwitch(state, 'move', 'move')).toEqual({
      mode: 'move',
      orientation: 'move',
      dg: false,
      exploit: false,
    })
    expect(applyModeSwitch(state, 'combat', 'combat').mode).toBe('combat')
    // 5.7a：预备可任选朝向
    expect(applyModeSwitch(state, 'reserve', 'move').orientation).toBe('move')
  })
})

describe('12.5 燃料支付', () => {
  const views = [unit({ mobility: 'truck' })]
  const ctx = context(views)

  it('12.5c-C：单单位法 = 每单位 1T', () => {
    const plan = planFuelPayment({
      context: ctx,
      unitIds: ['u1'],
      method: 'singleUnit',
      commonSource: true,
      availableSp: 0,
      availableT: 2,
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.data.costT).toBe(1)
      expect(plan.data.costSp).toBe(0)
      expect(plan.data.rule).toBe('12.5c-C')
    }
  })

  it('12.5c-A：编队法 = 1SP（须共用同一来源）', () => {
    const plan = planFuelPayment({
      context: ctx,
      unitIds: ['u1'],
      method: 'formation',
      commonSource: true,
      availableSp: 1,
      availableT: 0,
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.data.costSp).toBe(1)

    const noSource = planFuelPayment({
      context: ctx,
      unitIds: ['u1'],
      method: 'formation',
      commonSource: false,
      availableSp: 1,
      availableT: 0,
    })
    expect(noSource.ok).toBe(false)
    if (!noSource.ok) expect(noSource.rule).toBe('12.5c-A')
  })

  it('12.5c：补给不足则付不出', () => {
    const plan = planFuelPayment({
      context: ctx,
      unitIds: ['u1'],
      method: 'singleUnit',
      commonSource: true,
      availableSp: 0,
      availableT: 0,
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.rule).toBe('12.5c')
  })

  it('12.5a：不需要燃料的单位不该走燃料入口', () => {
    const legViews = [unit()]
    const plan = planFuelPayment({
      context: context(legViews),
      unitIds: ['u1'],
      method: 'singleUnit',
      commonSource: true,
      availableSp: 9,
      availableT: 9,
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.rule).toBe('12.5a')
  })
})
