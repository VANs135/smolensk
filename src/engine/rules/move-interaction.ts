import type { HexRef, Side } from '@/data'

import { hexDistance } from '../hex-geometry'
import { fail, succeed, type RuleOutcome } from '../result-types'
import { computeReachableHexes, evaluateStepFrom, findMoveUnit, inEnemyZocAt } from './move'
import type { MoveContext, MoveUnitView, StepFailure } from './move-types'
import type { OverrunMovePlan } from './overrun'
import { zocEntryEffect } from './zoc'
import {
  canSwitchMode,
  modeUnitClass,
  type BaseMode,
  type ModeSwitchResult,
  type ModeUnitClass,
  type ModeUnitProfile,
  type ModeState,
  type Orientation,
} from './modes'
import {
  computeFuelCost,
  requiresFuelToSpendMp,
  type FuelDuration,
  type FuelMarker,
  type FuelMethod,
} from './fuel'

/**
 * 移动交互（C5，OCS 6.0 / 6.1 / 6.3 / 4.5 / 5.4 / 12.5）——**纯函数状态机**
 *
 * 定位：把「玩家选单位/堆叠 → 看可到达范围 → 逐格点过去 → 不想走了就结束」这套交互
 * 里**所有需要按规则裁决的东西**集中到本模块，界面层只负责画图与收点击。
 * 单位的位置与 MP 仍由状态层（Pinia）持有，本模块通过 `MoveUnitRuntime` 视图读取，
 * 并把「这一步该改什么」以 `patches` 交还状态层 —— 引擎不写状态，符合 CODE_SPEC §3.1。
 *
 * ## 条文索引（中文规则书）
 *   - 6.1    可单独或以**堆叠**移动；移动必须沿连续格；一个单位或堆叠结束移动后才动下一个
 *   - 6.1a   每进入一格、每穿越一格边消耗 MP；按**单位或堆叠**记录消耗总值
 *   - 6.1b   MA 是一个阶段的 MP **总额度**（故本模块以「本阶段已耗 MP」为基数）
 *   - 6.1c   允许移动且 MA>0 时，MP 不足也总能走一格（引擎在 mpSpent=0 时才放行）
 *   - 6.1e   堆叠内各单位的 MA 与消耗**彼此独立**，不能互相转移 MP
 *   - 6.1f   堆叠可一起开始移动，途中可把单位**留在经过的格中**从而离开堆叠；
 *           一旦离开堆叠，该单位不能再继续移动（即使还有剩余 MA）
 *   - 6.1g   一旦一个单位开始移动，就必须持续移动直到该单位移动结束
 *   - 4.5a-A 轮式单位进入未抵消的敌方 ZOC 后，必须就地结束移动或进行突袭
 *   - 4.5b   格内有友方战斗单位则抵消该格敌方 ZOC（但该单位本阶段起不能再消耗 MP）
 *   - 5.8a   战略模式单位不可进入敌方 ZOC（引擎直接拒绝，无需确认）
 *   - 5.4    主动模式切换只在本方移动阶段、且在**单位或堆叠开始移动时**进行；切换不消耗 MP
 *   - 12.5a  轮式/履带 MP 的战斗单位要消耗 MP 必须先付燃料
 *   - 12.5c  三种加油方法：编队法 1SP / HQ 法 1SP / 单单位法每单位 1T
 *   - 12.5e  HQ 法覆盖其投递距离内的所有独立单位（投递距离在移动开始前一次算定）
 */

/* ────────────────────────────── 运行态视图 ────────────────────────────── */

/**
 * 参移单位的运行态（由状态层给出）
 *
 * 字段与 `state-types.Unit` 一一对应：`hex`→`hex`、`spentMp`→（本阶段累计已耗 MP）、
 * `ended`→`movementEnded`（4.5a-A / 6.1c / 6.2b 的「本轮必须停止」）。
 */
export interface MoveUnitRuntime {
  unitId: string
  hex: HexRef
  /** 本阶段已耗 MP（含进入本次移动之前的基数；6.1b） */
  spentMp: number
  /** 本轮移动是否已结束 */
  ended: boolean
}

/** 由运行态列表取某单位（找不到返回 null） */
export function runtimeOf(
  runtime: readonly MoveUnitRuntime[],
  unitId: string,
): MoveUnitRuntime | null {
  return runtime.find((item) => item.unitId === unitId) ?? null
}

/* ────────────────────────────── 交互状态与步骤记录 ────────────────────────────── */

/**
 * 步骤类别：正常迈步 / 玩家主动结束移动（6.1 末句）/ **突袭（8.0）**
 *
 * 突袭在移动记账里也是一「步」：它消耗 3 MP（8.1a），并可能把参突单位送进防御方格（8.0）。
 * 记成独立类别而不是 `'step'`，是为了让日志与撤销都说得清「这一步不是走路，是打了一仗」。
 */
export type MoveStepKind = 'step' | 'end' | 'overrun'

/** 一步移动的记录（**撤销 = 还原 `before`**，避免反推规则） */
export interface MoveStepRecord {
  kind: MoveStepKind
  from: HexRef
  to: HexRef
  /** 提交前的各单位运行态快照 */
  before: MoveUnitRuntime[]
  /** 本步随行的单位（真的换了格） */
  movedIds: string[]
  /** 因本步走不动而留在原格的单位（6.1f：离开堆叠即不得再移动） */
  droppedIds: string[]
  /** 进入未抵消敌方 ZOC 后被迫停止的单位（4.5a-A） */
  zocStoppedIds: string[]
  /** 各随行单位本步消耗的 MP（6.1e：彼此独立） */
  costById: Record<string, number>
  /** 本步依据的规则条款（供日志与回放） */
  rules: string[]
}

/** 移动交互的记账（单位位置与 MP 不在本类型里，由状态层持有） */
export interface MoveInteractionState {
  /** 参移单位（选中顺序） */
  unitIds: string[]
  /** 起始格 */
  start: HexRef
  /** 已提交的步骤（含撤销快照） */
  steps: MoveStepRecord[]
  /** 本次移动是否已结束（全部单位都停了） */
  finished: boolean
}

/** 开始一次移动：校验 1 个或 1 个堆叠（6.1）能否移动 */
export function beginMove(input: {
  context: MoveContext
  unitIds: readonly string[]
  runtime: readonly MoveUnitRuntime[]
}): RuleOutcome<MoveInteractionState> {
  const { context, unitIds, runtime } = input
  if (unitIds.length === 0) return fail('6.1', '未选择任何单位')

  const start = runtimeOf(runtime, unitIds[0]!)?.hex ?? null
  if (start === null) return fail('6.1', `找不到单位 ${unitIds[0]}`)

  for (const unitId of unitIds) {
    const item = runtimeOf(runtime, unitId)
    if (item === null) return fail('6.1', `找不到单位 ${unitId}`)
    if (item.ended) return fail('6.1g', `${unitId} 本轮移动已结束，不能再开始移动`)
    // 就绪检查（阶段 6.0 / MA 6.1b / 垫人锁 4.5b / 燃料 12.5a / 延补队面 12.7）统一问引擎
    const readiness = computeReachableHexes(context, unitId)
    if (!readiness.ok) return fail(readiness.rule, `${unitId}：${readiness.reason}`)
  }

  return succeed('6.1', {
    unitIds: [...unitIds],
    start,
    steps: [],
    finished: false,
  })
}

/* ────────────────────────────── 可到达范围（可移动范围渲染） ────────────────────────────── */

/** 单个参移单位的就绪情况 */
export interface ActiveUnitReachability {
  unitId: string
  /** 能否移动（阶段/MA/垫人锁/燃料，6.0/6.1b/4.5b/12.5a） */
  ok: boolean
  /** 不可移动时的原因（含规则号） */
  blocked?: StepFailure
  /** 可用 MA（6.1h：不取整） */
  ma: number
  /** 本阶段已耗 MP */
  spentMp: number
  /** 剩余 MP */
  remaining: number
}

/** 可到达格（堆叠取并集：只要有一个活跃单位能走到，堆叠就能沿该路径前进） */
export interface GroupReachableHex {
  hex: HexRef
  /** 走到该格的累计 MP（取最小者；含各单位已耗基数） */
  mpSpent: number
  /** 到达后被迫停止（4.5a-A） */
  forcedStop: boolean
  /** 只能靠 6.1c 最小移动到达 */
  minimumMove: boolean
  /** 该格处于未抵消的敌方 ZOC（4.5a-A：进入须确认；5.8a 战略模式禁入） */
  inEnemyZoc: boolean
  /** 能到达该格的单位及其累计 MP（升序） */
  byUnit: { unitId: string; mpSpent: number }[]
  /** 推荐路径（取自累计 MP 最小的那个单位；供 6.1 逐格预览） */
  path: HexRef[]
}

/** 可移动范围查询结果 */
export interface GroupReachable {
  units: ActiveUnitReachability[]
  hexes: GroupReachableHex[]
}

/** 本次移动中仍在移动的单位（未结束） */
function activeUnitIds(
  interaction: MoveInteractionState,
  runtime: readonly MoveUnitRuntime[],
): string[] {
  if (interaction.finished) return []
  return interaction.unitIds.filter((unitId) => runtimeOf(runtime, unitId)?.ended !== true)
}

/**
 * 当前仍在移动的单位的可到达范围（6.1/6.1b/6.1f）
 *
 * 每个单位各算一次（`computeReachableHexes`，与逐格 `evaluateStep` 同一套判据），
 * 再按「本阶段已耗 MP」过滤剩余额度、取并集 —— 堆叠正是这样前进的：
 * 个别单位走不动时它留在原格（6.1f），堆叠继续走（见 `planStep` 的 `droppedIds`）。
 */
export function reachableForMove(input: {
  context: MoveContext
  interaction: MoveInteractionState
  runtime: readonly MoveUnitRuntime[]
}): GroupReachable {
  const { context, interaction, runtime } = input
  const units: ActiveUnitReachability[] = []
  const merged = new Map<string, GroupReachableHex>()

  for (const unitId of interaction.unitIds) {
    const item = runtimeOf(runtime, unitId)
    if (item === null) continue
    const view = viewOf(context, unitId)
    if (view === null) continue
    const result = computeReachableHexes(context, unitId)
    if (!result.ok) {
      units.push({
        unitId,
        ok: false,
        blocked: result,
        ma: 0,
        spentMp: item.spentMp,
        remaining: 0,
      })
      continue
    }
    const remaining = result.ma - item.spentMp
    units.push({ unitId, ok: true, ma: result.ma, spentMp: item.spentMp, remaining })
    // 已结束本轮移动的单位不再参与范围（4.5a-A / 6.1c / 6.2b / 掉队）
    if (item.ended || interaction.finished || remaining <= 0) continue

    for (const node of result.reachable) {
      if (node.mpSpent > remaining) continue
      const absolute = node.mpSpent + item.spentMp
      const key = hexKey(node.hex)
      const existing = merged.get(key)
      if (existing === undefined) {
        merged.set(key, {
          hex: node.hex,
          mpSpent: absolute,
          forcedStop: node.forcedStop,
          minimumMove: node.minimumMove,
          // 4.5a-A / 5.8a：该格是否处于未抵消的敌方 ZOC（界面据此提示与确认）
          inEnemyZoc: inEnemyZocAt(context, node.hex, view.side),
          byUnit: [{ unitId, mpSpent: absolute }],
          path: node.path,
        })
        continue
      }
      existing.byUnit.push({ unitId, mpSpent: absolute })
      // 推荐路径取「先到者」：MP 更小，或同 MP 但原路径更短
      if (
        absolute < existing.mpSpent ||
        (absolute === existing.mpSpent && node.path.length < existing.path.length)
      ) {
        existing.mpSpent = absolute
        existing.path = node.path
        existing.minimumMove = node.minimumMove
        existing.forcedStop = node.forcedStop
      }
    }
  }

  const hexes = [...merged.values()]
  for (const item of hexes)
    item.byUnit.sort((a, b) => a.mpSpent - b.mpSpent || a.unitId.localeCompare(b.unitId))
  hexes.sort(
    (a, b) =>
      hexDistance(interaction.start, a.hex) - hexDistance(interaction.start, b.hex) ||
      a.mpSpent - b.mpSpent ||
      a.hex.col - b.hex.col ||
      a.hex.row - b.hex.row,
  )
  return { units, hexes }
}

/** 格键（对象坐标不作字符串键，仅本模块内部合并用） */
function hexKey(hex: HexRef): string {
  return `${hex.col}.${hex.row}`
}

/** 两个格号是否相同 */
export function sameHexRef(a: HexRef | null, b: HexRef | null): boolean {
  if (a === null || b === null) return a === b
  return a.col === b.col && a.row === b.row
}

/* ────────────────────────────── 单步预览与提交 ────────────────────────────── */

/** 随行单位的本步明细 */
export interface StepMovingUnit {
  unitId: string
  /** 本步 MP（6.1a） */
  cost: number
  hexCost: number
  hexsideCost: number
  /** 是否走了 6.2a 道路优先 */
  roadOverride: boolean
  /** 是否过桥 */
  crossedOnBridge: boolean
  /** 是否借 6.1c 最小移动 */
  minimumMove: boolean
  /** 本步之后必须结束移动（4.5a-A / 6.2b All / 6.1c / 5.8b） */
  mustEndMove: boolean
}

/** 单步预览（点击/悬停某格时给界面看的东西） */
export interface StepPreview {
  to: HexRef
  /** 可否提交：至少一个活跃单位能走这一步 */
  ok: boolean
  /** 全部走不动时的原因（取首个失败者） */
  blocked?: StepFailure
  /** 随行单位 */
  moving: StepMovingUnit[]
  /** 本步走不动、将留在原格的单位（6.1f） */
  droppingIds: string[]
  /** 5.8a：战略模式单位不能进入敌方 ZOC（这些单位只能留下） */
  stratBlockedIds: string[]
  /** 4.5a-A：目标格是否处于未抵消的敌方 ZOC */
  enteringEnemyZoc: boolean
  /** 进入 ZOC 后必须就停的轮式单位（4.5a-A） */
  zocStoppingIds: string[]
  /** 是否需要玩家确认（4.5a-A 的「就地停止或突袭」二选一） */
  needsConfirm: boolean
  /** 逐格预览路径（起点…目标；取自 MP 最小的能到者） */
  path: HexRef[]
  /** 本步涉及的规则条款 */
  rules: string[]
}

/** 取单位视图；找不到返回 null */
function viewOf(context: MoveContext, unitId: string): MoveUnitView | null {
  return findMoveUnit(context, unitId)
}

/**
 * 预览一步（不写任何状态）
 *
 * 逐步判定一律走引擎的 `evaluateStepFrom`（与可到达格 BFS 同一套判据），
 * 故「高亮的格」「预览的消耗」「真的走进去」三者永远一致。
 */
export function previewStep(input: {
  context: MoveContext
  interaction: MoveInteractionState
  runtime: readonly MoveUnitRuntime[]
  to: HexRef
  /** 逐格预览路径（由调用方从 `reachableForMove` 取；省略则只给起点与终点） */
  path?: readonly HexRef[]
}): StepPreview {
  const { context, interaction, runtime, to } = input
  const activeIds = activeUnitIds(interaction, runtime)
  const moving: StepMovingUnit[] = []
  const droppingIds: string[] = []
  const stratBlockedIds: string[] = []
  const rules = new Set<string>()
  let blocked: StepFailure | undefined
  let side: Side | null = null

  for (const unitId of activeIds) {
    const item = runtimeOf(runtime, unitId)
    const view = viewOf(context, unitId)
    if (item === null || view === null) continue
    side = view.side
    const outcome = evaluateStepFrom(context, view, item.hex, to, { mpSpent: item.spentMp })
    if (!outcome.ok) {
      if (outcome.reason === 'stratIntoEzoc') stratBlockedIds.push(unitId)
      droppingIds.push(unitId)
      rules.add(outcome.rule)
      blocked ??= outcome
      continue
    }
    moving.push({
      unitId,
      cost: outcome.cost,
      hexCost: outcome.hexCost,
      hexsideCost: outcome.hexsideCost,
      roadOverride: outcome.roadOverride,
      crossedOnBridge: outcome.crossedOnBridge,
      minimumMove: outcome.minimumMove,
      mustEndMove: outcome.mustEndMove,
    })
    rules.add(outcome.forcedStop ? '4.5a-A' : '6.1a')
  }

  // 4.5a-A：目标格是否处于（未被抵消的）敌方 ZOC
  const enteringEnemyZoc = side === null ? false : inEnemyZocAt(context, to, side)
  const zocStoppingIds = enteringEnemyZoc
    ? moving
        .filter((item) => {
          const view = viewOf(context, item.unitId)
          return view !== null && zocEntryEffect(view.mobility) === 'mustStopOrOverrun'
        })
        .map((item) => item.unitId)
    : []
  if (enteringEnemyZoc) rules.add('4.5a-A')

  const path =
    input.path !== undefined
      ? [...input.path]
      : sameHexRef(interaction.start, to)
        ? [to]
        : [interaction.start, to]

  return {
    to,
    ok: moving.length > 0,
    ...(blocked === undefined ? {} : { blocked }),
    moving,
    droppingIds,
    stratBlockedIds,
    enteringEnemyZoc,
    zocStoppingIds,
    needsConfirm: zocStoppingIds.length > 0,
    path,
    rules: [...rules],
  }
}

/** 提交一步后要写回状态层的单位变更 */
export interface MoveStepPlan {
  /** 需要写回的单位运行态（只含变化过的） */
  patches: MoveUnitRuntime[]
  /** 提交后的交互状态 */
  interaction: MoveInteractionState
  /** 已提交的步骤记录 */
  record: MoveStepRecord
  /** 预览明细（供日志显示） */
  preview: StepPreview
}

/**
 * 提交一步（6.1a/6.1e/6.1f/4.5a-A）
 *
 * 变更规则：
 *   - 能走的单位 → 换格、按**各自**的费率累加 MP（6.1e）；
 *   - 走不动的单位 → 留在原格并**就此结束本轮移动**（6.1f：离开堆叠即不得再移动）；
 *   - 引擎判 `mustEndMove`（4.5a-A 强制停止 / 6.2b All / 6.1c 最小移动 / 5.8b 战略）→ 该单位就地结束。
 */
export function planStep(input: {
  context: MoveContext
  interaction: MoveInteractionState
  runtime: readonly MoveUnitRuntime[]
  to: HexRef
  path?: readonly HexRef[]
}): RuleOutcome<MoveStepPlan> {
  const { context, interaction, runtime, to } = input
  const activeIds = activeUnitIds(interaction, runtime)
  if (activeIds.length === 0) return fail('6.1', '本次移动已结束')

  const preview = previewStep({
    context,
    interaction,
    runtime,
    to,
    ...(input.path === undefined ? {} : { path: input.path }),
  })
  if (!preview.ok) {
    const reason = preview.blocked
    if (reason === undefined) return fail('6.1', '没有任何单位能走这一步')
    return fail(
      reason.rule,
      `${reason.reason}${reason.detail === undefined ? '' : `（${reason.detail}）`}`,
    )
  }

  const before: MoveUnitRuntime[] = interaction.unitIds
    .map((unitId) => runtimeOf(runtime, unitId))
    .filter((item): item is MoveUnitRuntime => item !== null)
    .map((item) => ({ ...item, hex: { ...item.hex } }))

  const patches: MoveUnitRuntime[] = []
  const costById: Record<string, number> = {}
  const movedIds: string[] = []
  const zocStoppedIds: string[] = []

  for (const item of preview.moving) {
    const current = runtimeOf(runtime, item.unitId)
    if (current === null) continue
    movedIds.push(item.unitId)
    costById[item.unitId] = item.cost
    if (preview.zocStoppingIds.includes(item.unitId)) zocStoppedIds.push(item.unitId)
    patches.push({
      unitId: item.unitId,
      hex: { ...to },
      spentMp: current.spentMp + item.cost,
      ended: current.ended || item.mustEndMove,
    })
  }

  // 6.1f：走不动的单位留在原格，本轮不再移动
  for (const unitId of preview.droppingIds) {
    const current = runtimeOf(runtime, unitId)
    if (current === null || current.ended) continue
    patches.push({ ...current, hex: { ...current.hex }, ended: true })
  }

  const endedAfter = interaction.unitIds.every((unitId) => {
    const patched = patches.find((item) => item.unitId === unitId)
    return (patched ?? runtimeOf(runtime, unitId))?.ended === true
  })

  const record: MoveStepRecord = {
    kind: 'step',
    from: runtimeOf(runtime, movedIds[0] ?? activeIds[0]!)?.hex ?? interaction.start,
    to,
    before,
    movedIds,
    droppedIds: preview.droppingIds,
    zocStoppedIds,
    costById,
    rules: preview.rules,
  }

  return succeed('6.1', {
    patches,
    interaction: {
      ...interaction,
      steps: [...interaction.steps, record],
      finished: endedAfter,
    },
    record,
    preview,
  })
}

/* ────────────────────────────── 结束、撤销、取消 ────────────────────────────── */

/** 撤销 / 结束的结果：交互状态 + 要写回状态层的单位变更 */
export interface MoveRevert {
  interaction: MoveInteractionState
  patches: MoveUnitRuntime[]
}

/**
 * 玩家主动结束本次移动（6.1 末句：一个单位或堆叠结束移动后，再移动另一个）
 *
 * 效果 = 仍在移动的单位就地停止；本操作**同样入历史**，故可撤销。
 */
export function endMoveEarly(input: {
  interaction: MoveInteractionState
  runtime: readonly MoveUnitRuntime[]
}): MoveRevert & { record: MoveStepRecord | null } {
  const { interaction, runtime } = input
  const activeIds = activeUnitIds(interaction, runtime)
  if (activeIds.length === 0) {
    return { interaction: { ...interaction, finished: true }, patches: [], record: null }
  }

  const before: MoveUnitRuntime[] = interaction.unitIds
    .map((unitId) => runtimeOf(runtime, unitId))
    .filter((item): item is MoveUnitRuntime => item !== null)
    .map((item) => ({ ...item, hex: { ...item.hex } }))

  const patches: MoveUnitRuntime[] = activeIds
    .map((unitId) => runtimeOf(runtime, unitId))
    .filter((item): item is MoveUnitRuntime => item !== null)
    .map((item) => ({ ...item, hex: { ...item.hex }, ended: true }))

  const here = runtimeOf(runtime, activeIds[0]!)?.hex ?? interaction.start
  const record: MoveStepRecord = {
    kind: 'end',
    from: here,
    to: here,
    before,
    movedIds: [],
    droppedIds: [],
    zocStoppedIds: [],
    costById: {},
    rules: ['6.1'],
  }

  return {
    interaction: { ...interaction, steps: [...interaction.steps, record], finished: true },
    patches,
    record,
  }
}

/** 撤销上一步（还原该步提交前的运行态快照） */
export function undoMoveStep(interaction: MoveInteractionState): MoveRevert {
  const last = interaction.steps.at(-1)
  if (last === undefined) {
    return { interaction: { ...interaction, finished: false }, patches: [] }
  }
  return {
    interaction: {
      ...interaction,
      steps: interaction.steps.slice(0, -1),
      // 撤销必然让至少一个单位回到「还能动」，故结束标记清零（若确已全停，下一步提交会重算）
      finished: false,
    },
    patches: last.before.map((item) => ({ ...item, hex: { ...item.hex } })),
  }
}

/** 取消整次移动（回到本次移动开始前的状态） */
export function cancelMove(interaction: MoveInteractionState): MoveRevert {
  const first = interaction.steps[0]
  if (first === undefined) {
    return { interaction: { ...interaction, steps: [], finished: false }, patches: [] }
  }
  return {
    interaction: { ...interaction, steps: [], finished: false },
    patches: first.before.map((item) => ({ ...item, hex: { ...item.hex } })),
  }
}

/* ────────────────────────────── 模式切换（5.4 + 5.x） ────────────────────────────── */

/** 模式切换时机判定输入 */
export interface ModeSwitchNowInput {
  context: MoveContext
  unitId: string
  runtime: readonly MoveUnitRuntime[]
  /** 目标主动模式（5.3：被动模式不可选择） */
  to: BaseMode
  /** 目标朝向（5.7a 预备可任选；5.8 战略须移动面） */
  orientation: Orientation
  /**
   * 该单位的规则类别（5.5c 补员/运输点数不得进战斗模式、5.7f 运输点数不得进预备、
   * 5.8c 运输点数不得进战略、6.1b 设施无 MA）
   *
   * 由状态层用 `modes.modeUnitClass(profile)` 归类后传入——`MoveUnitView` 不含
   * `specialized`/`noncombatKind` 这两个静态字段，引擎不自行臆造。
   */
  unitClass: ModeUnitClass
  /** 当前日期（ISO，专规 2.3e 苏军战略模式闸门用） */
  date?: string
}

/**
 * 此刻能否切换主动模式（5.4 / 5.4 末句 / 5.5c / 5.7c / 5.8a / 5.8c / 专规 2.3e）
 *
 * 5.4 的**时机**要求是本函数相对 `modes.canSwitchMode` 多出来的一层：
 * 切换模式「是在每个单位或堆叠开始移动时进行的」，故**已消耗过 MP**（6.1g 一旦开始就必须走完）
 * 或本轮移动已结束的单位都不能再切。
 */
export function canSwitchModeNow(input: ModeSwitchNowInput): ModeSwitchResult {
  const { context, unitId, runtime, to, orientation, unitClass, date } = input
  const view = viewOf(context, unitId)
  if (view === null) return { ok: false, rule: '5.4', reason: `找不到单位 ${unitId}` }
  const item = runtimeOf(runtime, unitId)
  if (item === null) return { ok: false, rule: '5.4', reason: `找不到单位 ${unitId}` }

  if (item.ended)
    return { ok: false, rule: '5.4', reason: '本轮移动已结束，不能再切换模式（6.1g）' }
  if (item.spentMp > 0)
    return {
      ok: false,
      rule: '5.4',
      reason: '模式切换只在该单位开始移动时进行，本阶段已消耗过 MP（6.1g）',
    }

  return canSwitchMode({
    to,
    orientation,
    // 4.5b：已抵消的 ZOC 不算（引擎在 inEnemyZocAt 里已计入抵消）
    inEnemyZoc: inEnemyZocAt(context, item.hex, view.side),
    unitClass,
    side: view.side,
    phase: context.phase,
    ...(date === undefined ? {} : { date }),
  })
}

/**
 * 施加模式切换（5.5/5.6/5.7a/5.8）
 *
 * 战斗/移动模式就定义在对应那一面上，故 `to` 为二者时朝向随之确定（5.5/5.6）；
 * 预备可任选朝向（5.7a）；战略必须移动面（5.8，已由 `canSwitchMode` 拦下）。
 * 被动标记（DG/进击）**不因主动模式切换而改变**——它们只能在该玩家的清理阶段移除（5.4 / 5.10）。
 */
export function applyModeSwitch(
  state: ModeState,
  to: BaseMode,
  orientation: Orientation,
): ModeState {
  if (to === 'combat') return { ...state, mode: 'combat', orientation: 'combat' }
  if (to === 'move') return { ...state, mode: 'move', orientation: 'move' }
  return { ...state, mode: to, orientation }
}

/** 该单位建议的模式类别（供界面在调用 canSwitchModeNow 前归类，5.5c/5.7f/5.8c/6.1b） */
export function classifyForMode(profile: ModeUnitProfile): ModeUnitClass {
  return modeUnitClass(profile)
}

/* ────────────────────────────── 燃料支付（12.5） ────────────────────────────── */

/** 燃料支付方案（引擎算价；实际扣减由状态层的补给池执行） */
export interface FuelPaymentPlan {
  /** 本次加油覆盖的单位（付完即视为已加注，12.5c） */
  unitIds: string[]
  method: FuelMethod
  costSp: number
  costT: number
  duration: FuelDuration
  marker: FuelMarker
  rule: string
}

/** 燃料支付判定输入 */
export interface FuelPaymentInput {
  context: MoveContext
  unitIds: readonly string[]
  method: FuelMethod
  /**
   * 12.5c-A / 12.5e：这些单位是否**共用同一来源**
   *
   * 编队法要求共用同一 HQ 投递 / 同一补给站直接拖取；
   * HQ 法要求这些独立单位都在该 HQ 的投递距离内（投递距离在移动开始前算定）。
   * 补给网尚未在操作台建模，故由玩家在界面上声明，本函数只据声明判合法性。
   */
  commonSource: boolean
  /** 当前可用的 SP / T（由状态层给出，12.5c） */
  availableSp: number
  availableT: number
}

/**
 * 规划一次燃料支付（12.5a / 12.5c / 12.5e / 12.5g）
 *
 * 只判「该不该付、付多少、付给谁」；真正扣减补给池与打标记由状态层执行。
 * 12.5b 的「攻击/防御/轰炸/撤退/战后推进不需要燃料」不在此判——那些行动不走本入口。
 */
export function planFuelPayment(input: FuelPaymentInput): RuleOutcome<FuelPaymentPlan> {
  const { context, unitIds, method } = input
  if (unitIds.length === 0) return fail('12.5a', '未选择任何单位')

  // 12.5a：只有「轮式/履带 MP 的战斗单位」需要燃料；不需要的单位不该出现在这里
  for (const unitId of unitIds) {
    const view = viewOf(context, unitId)
    if (view === null) return fail('12.5a', `找不到单位 ${unitId}`)
    if (!requiresFuelToSpendMp({ isCombat: view.isCombat, mobility: view.mobility }))
      return fail('12.5a', `${unitId} 不需要燃料（非战斗单位或步行 MP）`)
  }

  /*
   * 12.5c：「共用同一来源」只是**编队法（A）与指挥部法（B）**的前提，**单独单位法（C）没有这条**——
   * 原文：「为每个需要燃料补给的单位支付 1T。**任何单位都可以使用此方法**，无论其 RE 规模或军力多少，
   * 也无论它是独立单位、多军力单位，还是多单位编队中的单位。」
   * ⇒ 修前这里无条件要求 `commonSource`，于是"每枚各付 1T"这条最常用的方法**永远走不通**
   *   （玩家只能看到一句"HQ 法要求这些独立单位都在该 HQ 的投递距离内"，而他要的明明是 C）。
   */
  if (input.commonSource === false && method !== 'singleUnit')
    return fail(
      method === 'formation' ? '12.5c-A' : '12.5c-B',
      method === 'formation'
        ? '编队内单位未共用同一 HQ/补给站来源，这些单位只能改走单单位法'
        : 'HQ 法要求这些独立单位都在该 HQ 的投递距离内（12.5e）',
    )

  const cost = computeFuelCost({
    method,
    commonSource: input.commonSource,
    unitsNeedingFuel: unitIds.length,
  })
  if (!cost.ok) return fail(cost.rule, cost.reason)

  if (cost.sp > input.availableSp)
    return fail('12.5c', `可用 SP 不足：需 ${cost.sp}，只有 ${input.availableSp}`)
  if (cost.t > input.availableT)
    return fail('12.5c', `可用 T 不足：需 ${cost.t}，只有 ${input.availableT}`)

  return succeed(cost.rule, {
    unitIds: [...unitIds],
    method,
    costSp: cost.sp,
    costT: cost.t,
    duration: cost.duration,
    marker: cost.marker,
    rule: cost.rule,
  })
}

/** 该单位当前是否需要先付燃料（12.5a；供界面提示） */
export function needsFuelToMove(view: MoveUnitView): boolean {
  return requiresFuelToSpendMp({ isCombat: view.isCombat, mobility: view.mobility })
}

/** 单个单位的可用 MA 与剩余额度（供界面显示；失败时给出原因） */
export function unitMoveBudget(
  context: MoveContext,
  unitId: string,
  spentMp: number,
): RuleOutcome<{ ma: number; spentMp: number; remaining: number }> {
  const result = computeReachableHexes(context, unitId)
  if (!result.ok) return fail(result.rule, result.reason)
  return succeed('6.1b', {
    ma: result.ma,
    spentMp,
    remaining: result.ma - spentMp,
  })
}

/** 从可达结果里取某格的可到达节点（供界面做悬停预览） */
export function reachableNodeAt(
  hexes: readonly GroupReachableHex[],
  to: HexRef,
): GroupReachableHex | null {
  return hexes.find((item) => sameHexRef(item.hex, to)) ?? null
}

/* ────────────────────────────── 8.0 突袭步骤（W7 C16） ────────────────────────────── */

/**
 * 8.0 / 8.1a / 8.1g：把一次突袭记成移动交互的一步
 *
 * 移动中的突袭既**消耗 MP**（8.1a：每次 3 MP）又**可能改变位置**（8.0：防御方离开该格时
 * 所有参突单位必须进入该格，且不额外扣 MP）——所以它必须是交互状态里可撤销的一步，
 * 而不是「在别处偷偷改数值」。本函数只做记账与快照，资格与后果分别由
 * `move.ts#canOverrun`、`overrun.ts#planOverrunMove` 给出（本模块不重算规则）。
 *
 * @param input.plan `overrun.ts#planOverrunMove` 的结论
 */
export function applyOverrunMove(input: {
  interaction: MoveInteractionState
  /** 提交前的运行态（与 `planStep` 同一份来源：状态层的 `moveRuntime`） */
  runtime: readonly MoveUnitRuntime[]
  plan: OverrunMovePlan
}): RuleOutcome<MoveStepPlan> {
  const { interaction, plan } = input
  if (interaction.finished) {
    return fail('8.0', 'moveAlreadyFinished')
  }
  if (plan.patches.length === 0) {
    return fail('8.1g', 'noOverrunParticipant')
  }

  const before = input.runtime
    .filter((unit) => interaction.unitIds.includes(unit.unitId))
    .map((unit) => ({ ...unit }))
  const current = before.find((unit) => unit.unitId === plan.participantIds[0]) ?? before[0]
  if (current === undefined) return fail('8.1g', 'noOverrunParticipant')

  const patches: MoveUnitRuntime[] = []
  const movedIds: string[] = []
  const costById: Record<string, number> = {}
  for (const patch of plan.patches) {
    const unit = before.find((item) => item.unitId === patch.unitId)
    if (unit === undefined) continue
    const hex = patch.hex ?? unit.hex
    if (!sameHexRef(hex, unit.hex)) movedIds.push(patch.unitId)
    costById[patch.unitId] = patch.spentMp - unit.spentMp
    patches.push({ unitId: patch.unitId, hex, spentMp: patch.spentMp, ended: patch.ended })
  }

  const to = patches.find((unit) => unit.unitId === plan.participantIds[0])?.hex ?? current.hex
  const record: MoveStepRecord = {
    kind: 'overrun',
    from: current.hex,
    to,
    before,
    movedIds,
    droppedIds: [],
    zocStoppedIds: [],
    costById,
    rules: ['8.0', '8.1a', plan.rule],
  }

  const nextRuntime: MoveUnitRuntime[] = before.map((unit) => {
    const patch = patches.find((item) => item.unitId === unit.unitId)
    return patch ?? unit
  })
  const allEnded = nextRuntime.every((unit) => unit.ended)

  const interactionNext: MoveInteractionState = {
    ...interaction,
    steps: [...interaction.steps, record],
    finished: allEnded,
  }

  return succeed(plan.rule, {
    patches: nextRuntime,
    interaction: interactionNext,
    record,
    preview: {
      to,
      ok: true,
      moving: patches.map((unit) => ({
        unitId: unit.unitId,
        cost: costById[unit.unitId] ?? 0,
        hexCost: 0,
        hexsideCost: 0,
        roadOverride: false,
        crossedOnBridge: false,
        minimumMove: false,
        mustEndMove: unit.ended,
      })),
      droppingIds: [],
      stratBlockedIds: [],
      enteringEnemyZoc: false,
      zocStoppingIds: [],
      needsConfirm: false,
      path: [current.hex, to],
      rules: ['8.0', '8.1a'],
    },
  })
}
