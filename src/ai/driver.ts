/**
 * B3：基线 AI 的**驱动层**（把 `policy.ts` 的纯决策翻译成既有 submit 入口调用）
 *
 * 硬约束：
 * - 只调用 workbench / setup / session 已公开的提交入口；不直接改 `units` / `spDumps` / session 内部状态。
 *   仅按既有 UI 语义给「输入对象」赋值（`combatInputs` / `combatSupplyDumpIds` / `combatRetreatPlans` /
 *   `barrageInputs` / `attritionAllocation` / `selectedId`）。
 * - 不使用 `Math.random`，不额外消费引擎骰流；同种子 + 同盘面 ⇒ 同决策。
 * - 提交失败就记录（按 rule 分组）并换下一个候选，不做「我认为合法」的预判。
 */
import { nextTick } from 'vue'

import {
  activeStackingLimitOf,
  arrivalCopiesOf,
  canonicalMode,
  holdingsToT,
  refitCapacity,
  SP_TO_T,
  transportPointLoadCost,
} from '@/engine/rules'
import { hexDistance } from '@/engine/hex-geometry'
import { useContainersStore } from '@/stores/containers'
import { formatHexPath, needsFuelOf } from '@/stores/workbench-model'
import type { useGameSessionStore } from '@/stores/session'
import type { useSetupStore } from '@/stores/setup'
import type { useWorkbenchStore } from '@/stores/workbench'

import {
  actionKeyOf,
  aiControlsSide,
  compareHex,
  decideAiAction,
  hexKeyOf,
  isAiAction,
  type AiAction,
  type AiArrivalEntry,
  type AiControlMode,
  type AiHex,
  type AiMoveBranchSnapshot,
  type AiRebuildSnapshot,
  type AiRefitBase,
  type AiReinSupplySnapshot,
  type AiSnapshot,
  type AiSide,
} from './policy'
import { aiProfileOf, type AiProfile } from './scenario-posture'
import { projectPanel } from './training/panel-steps'
import type { AiStepRecord } from './trace'

export interface AiContext {
  workbench: ReturnType<typeof useWorkbenchStore>
  session: ReturnType<typeof useGameSessionStore>
  setup: ReturnType<typeof useSetupStore>
  /**
   * 剧本 id 覆盖（测试用：快照按它取 `scenarioId`，不读会话）。
   * 仅给测试钉"完整档 / 简化档"用；运行时一律取 `session.scenarioId`。
   */
  scenarioId?: string
  /** 档位覆盖（仅测试用：规则覆盖回归要跑完整档；运行时取 `aiProfileOf(scenarioId)`） */
  aiProfile?: AiProfile
}

export interface AiMemory {
  token: string
  movedUnitIds: string[]
  moveTargets: string[]
  reserveUnitIds: string[]
  barrageTargets: string[]
  combatHexes: string[]
  /** 已打过（或试过）的空军任务目标格 */
  airTargets: string[]
  /** 已出动过的飞机（避免反复点名同一架） */
  airAircraft: string[]
  /** 已飞过任务的「回合/阶段」标记 */
  airSorties: string[]
  /** 引擎拒绝结算而终止的任务「回合/阶段」（不再推进同一份陈旧任务态） */
  airAborted: string[]
  /** 批 1：本环节已整备过的基地（15.1A：每基地每阶段一次） */
  refitBaseIds: string[]
  /** 批 1：本环节已试过的到货条目下标 */
  arrivalTried: string[]
  /** 批 1：本环节已试过的重建单位（避免同一枚反复被拒） */
  rebuildUnitIds: string[]
  /** 批 1：本环节是否已做过一次整编 */
  consolidated: boolean
  /** 批 2：本环节已试过换模式单位 */
  modeSwitchTried: string[]
  /** 5.7b：本环节已试过释放的预备单位（避免同一枚反复被拒） */
  reserveReleasedIds: string[]
  /** 12.5a：本环节已试过付燃料的单位（无来源时不再反复被拒） */
  fuelTriedIds: string[]
  /** 批 2：本环节已试过的突袭目标格 */
  overrunTried: string[]
  /** 批 2：本环节已试过铁路运输的单位 / 起运站 */
  railTriedUnits: string[]
  railTriedDumps: string[]
  /** 批 2：铁路候选扫过一次且无可用（避免每步重复 BFS） */
  railScanned: boolean
  /** 批 2：本环节已试过的运输点数装卸 */
  transportTried: string[]
  /** 批 2：本环节已用过建造标记 */
  constructionDone: boolean
  /** 批 2：本环节已试过换轨的铁路修理单位 */
  gaugeTried: string[]
  /** 12.11a：本环节已试过销毁的补给站（失败后不再反复选同一座） */
  dumpBlowTried: string[]
}

export function createAiMemory(): AiMemory {
  return {
    token: '',
    movedUnitIds: [],
    moveTargets: [],
    reserveUnitIds: [],
    barrageTargets: [],
    combatHexes: [],
    airTargets: [],
    airAircraft: [],
    airSorties: [],
    airAborted: [],
    refitBaseIds: [],
    arrivalTried: [],
    rebuildUnitIds: [],
    consolidated: false,
    modeSwitchTried: [],
    reserveReleasedIds: [],
    fuelTriedIds: [],
    overrunTried: [],
    railTriedUnits: [],
    railTriedDumps: [],
    railScanned: false,
    transportTried: [],
    constructionDone: false,
    gaugeTried: [],
    dumpBlowTried: [],
  }
}

export interface AiStepResult {
  turn: number
  phase: string
  segment: string
  side: AiSide
  intent: string
  ok: boolean
  rule?: string
  reason?: string
  /** B4：玩家控制的一方有待办 ⇒ 停下并给出等待文案（此时未提交任何动作） */
  waiting?: string
  /**
   * 外部策略（`decider`）给出的动作**结构非法**、已回退脚本策略
   *
   * 只表示"不是一个合法形状的 AiAction"（见 `isAiAction`）；引擎按规则拒绝不算此列。
   */
  fellBack?: boolean
}

export interface AiRefusal {
  turn: number
  phase: string
  segment: string
  side: AiSide
  intent: string
  rule: string
  reason: string
}

export interface AiSelfPlayReport {
  scenarioId?: string
  turn: number
  phase: string
  segment: string
  activeSide: AiSide
  targetTurn: number
  reachedTarget: boolean
  terminated: boolean
  iterations: number
  stalls: string[]
  refused: AiRefusal[]
  refusedByRule: Record<string, number>
  /** 本次自对打期间出现过的规则号（去重、按首次出现顺序；日志有 60 条上限，故在驱动侧累积） */
  rules: string[]
  warnings: string[]
  noLegal: number
  /** 外部策略给出的动作结构非法、回退脚本策略的次数（没有外部策略时恒为 0） */
  aiIllegal: number
  awaiting: boolean
  /** B4：因玩家侧待办而停下时的文案（双 AI 模式下正常为 undefined） */
  waiting?: string
}

export interface AiSelfPlayOptions {
  ctx: AiContext
  targetTurns: number
  scenarioId?: string
  limit?: number
  memory?: AiMemory
  /** B4：控制方（默认 `both`，与 B3 行为一致） */
  control?: AiControlMode
  /**
   * 外部策略（训练/评估用；默认 `decideAiAction`）
   *
   * 结构非法/抛异常 ⇒ 该步回退脚本策略，并在报告里累计 `aiIllegal`；
   * 引擎按规则拒绝仍按原有 `refusedByRule` 记账，两者不混。
   */
  decider?: AiDecider
  /** 每步回调（采集用）：只读记录，不得改盘面；抛异常即整局失败（采集器应作废该局） */
  onStep?: (record: AiStepRecord) => void
}

function tokenOf(w: ReturnType<typeof useWorkbenchStore>): string {
  return `${String(w.turn)}|${String(w.phase)}|${String(w.activeSide)}|${String(w.segmentStepIndex)}`
}

function sideOf(w: ReturnType<typeof useWorkbenchStore>): AiSide {
  return (w.segmentGateQuery.side ?? w.activeSide) as AiSide
}

function syncMemory(memory: AiMemory, w: ReturnType<typeof useWorkbenchStore>): void {
  const token = tokenOf(w)
  if (memory.token === token) return
  memory.token = token
  memory.movedUnitIds = []
  memory.moveTargets = []
  memory.reserveUnitIds = []
  memory.barrageTargets = []
  memory.combatHexes = []
  memory.airTargets = []
  memory.airAircraft = []
  memory.airSorties = []
  memory.airAborted = []
  memory.refitBaseIds = []
  memory.arrivalTried = []
  memory.rebuildUnitIds = []
  memory.consolidated = false
  memory.modeSwitchTried = []
  memory.reserveReleasedIds = []
  memory.fuelTriedIds = []
  memory.overrunTried = []
  memory.railTriedUnits = []
  memory.railTriedDumps = []
  memory.railScanned = false
  memory.transportTried = []
  memory.constructionDone = false
  memory.gaugeTried = []
  memory.dumpBlowTried = []
}

function dedupeSortedHexes(hexes: readonly AiHex[]): AiHex[] {
  const seen = new Map<string, AiHex>()
  for (const hex of hexes) seen.set(hexKeyOf(hex), hex)
  return [...seen.values()].sort((a, b) => a.col - b.col || a.row - b.row)
}

/** 码点序：跨 locale 稳定，用于名字/文本兜底（不要用 localeCompare 做训练可复现排序） */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 稳定排序键：`格号|单位库键`
 *
 * `instanceId` 由 `shared/id.ts` 的 `Date.now()` + 进程内序号拼成，跨进程不稳定；
 * 传入本函数的 `unitId` 必须是**单位库主键**（如 `unitId` / `aircraftId`），不是 `instanceId`。
 * 若同格同库键有多份副本（如拆分出的同型单位），先按格号再稳定排序保留输入顺序；
 * 输入数组本身由既有投影按固定规则构造，不在比较器里回退到实例 id。
 * 故快照里所有「需要挑一个」的列表都在这里按**盘面位置 + 单位库键**排好，策略层不再排序。
 */
function compareStableUnit(
  a: { hex: AiHex; unitId: string },
  b: { hex: AiHex; unitId: string },
): number {
  const ac = a.hex.col
  const bc = b.hex.col
  if (ac !== bc) return ac - bc
  if (a.hex.row !== b.hex.row) return a.hex.row - b.hex.row
  return a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0
}

/**
 * 批 1：B 重建 / 整编候选（一次只给一个）
 *
 * 死亡堆重建要逐格预演（`rebuildLegalHexes`，与提交入口同一判据），因此**只在重建环节**
 * 顺序扫描：扫过的非法候选记进记忆，避免每步重复预演；找到一个合法可做的就返回。
 * 整编（13.9）每环节只做一对（`mergePartnerIds` 只列同格唯一伙伴，不替玩家挑）。
 */
function rebuildSnapshotOf(
  w: ReturnType<typeof useWorkbenchStore>,
  memory: AiMemory,
): AiRebuildSnapshot | null {
  if (w.segmentStep?.id !== 'reinforcement.rebuild') return null
  const candidates = w.rebuildCandidates
    .slice()
    .sort((a, b) => compareHex(a.hex, b.hex) || compareText(a.name, b.name))
  for (const unit of candidates) {
    if (memory.rebuildUnitIds.includes(unit.instanceId)) continue
    if ('aircraftId' in unit) {
      if (w.canRebuildAircraftIntoBoxNow(unit.instanceId))
        return {
          unitId: unit.instanceId,
          kind: 'airBox',
          hex: null,
          consolidate: null,
          rebuildRow: w.rebuildRowOf(unit.instanceId),
        }
      memory.rebuildUnitIds.push(unit.instanceId)
      continue
    }
    if (w.canRebuildOnMapNow(unit.instanceId))
      return {
        unitId: unit.instanceId,
        kind: 'onMap',
        hex: null,
        consolidate: null,
        rebuildRow: w.rebuildRowOf(unit.instanceId),
      }
    const legal = sortByLoad(
      w.rebuildLegalHexes(unit.instanceId).map((hex) => ({ col: hex.col, row: hex.row })),
      loadMapOf(w),
    )
    if (legal.length > 0 && legal[0] !== undefined)
      return {
        unitId: unit.instanceId,
        kind: 'dead',
        hex: legal[0],
        consolidate: null,
        rebuildRow: w.rebuildRowOf(unit.instanceId),
      }
    memory.rebuildUnitIds.push(unit.instanceId)
  }
  if (!memory.consolidated) {
    // 只挑**第一处**同格 ≥2 枚本方地面单位的堆叠去问伙伴：`mergePartnerIds` 内部要预演，
    // 对 300 枚单位逐个问一次会把一次快照拖到十几秒（实测），而整编每段只做一对。
    const groups = new Map<string, { unit: (typeof w.units)[number]; others: number }>()
    for (const unit of w.units) {
      if (unit.side !== w.activeSide || (unit.noncombatKind ?? null) !== null) continue
      const key = `${String(unit.hex.col)}.${String(unit.hex.row)}`
      const group = groups.get(key)
      if (group === undefined) groups.set(key, { unit, others: 0 })
      else group.others += 1
    }
    const first = [...groups.values()]
      .filter((group) => group.others > 0)
      .map((group) => group.unit)
      .sort((a, b) => compareHex(a.hex, b.hex) || compareText(a.name, b.name))[0]
    if (first !== undefined) {
      const partners = w.mergePartnerIds(first.instanceId)
      if (partners.length === 1 && partners[0] !== undefined)
        return {
          unitId: first.instanceId,
          kind: 'onMap',
          hex: null,
          consolidate: { keepId: first.instanceId, removeId: partners[0] },
          rebuildRow: '',
        }
    }
  }
  return null
}

/** 该格本方**激活**飞机数（14.2a 堆叠 / 15.1B 整备余额共用） */
function activeAircraftAt(w: ReturnType<typeof useWorkbenchStore>, hex: AiHex): number {
  return w.airUnits.filter(
    (unit) =>
      unit.side === w.activeSide &&
      unit.airStatus === 'active' &&
      unit.hex.col === hex.col &&
      unit.hex.row === hex.row,
  ).length
}

/**
 * 14.2a：该基地格还能不能再落 `copies` 架激活飞机（上限 = 4 + 基地等级；简易机场恒为 4）
 *
 * 只做落位前的预检，拦的是 `placeArrivalNow` 一定会以 14.2a 拒绝的基地；
 * 判据与引擎同一个 `activeStackingLimitOf`，不另写阈值。
 */
function aircraftBaseHasRoom(
  w: ReturnType<typeof useWorkbenchStore>,
  copies: number,
  hex: AiHex,
): boolean {
  const base = w.airBases.find(
    (item) => item.side === w.activeSide && item.hex.col === hex.col && item.hex.row === hex.row,
  )
  if (base === undefined) return false
  return activeAircraftAt(w, hex) + copies <= activeStackingLimitOf(base)
}

/**
 * 13.6：这条到达需求此刻是否有**可解析的算子/编成**
 *
 * 与 `placeArrivalNow` 同源判据：编成条目用 `resolveArrivalFormation`（缺枚即不可投），
 * 单枚用 `arrivalRecordOf`；飞机走 13.6 的独立解析，并预检 14.2a 的基地容量。
 * 预检只为**避免把必被拒的投放当成动作发出去**（13.6/14.2a 拒绝会污染双 AI 回归计数）。
 */
function arrivalResolvable(w: ReturnType<typeof useWorkbenchStore>, index: number): boolean {
  const demand = w.arrivalPlan?.units[index]
  if (demand === undefined) return false
  if (demand.kind === 'aircraft') return aircraftArrivalCandidates(w, index).length > 0
  if (demand.kind === 'sp' || demand.kind === 'unclassified') return false
  const formation = w.resolveArrivalFormation(index)
  if (formation !== null) return formation.missing.length === 0
  return w.arrivalRecordOf(index) !== null
}

/** 飞机到场只在**还有容量**的友方基地格里选（14.2a），其余条目原样给候选 */
function aircraftArrivalCandidates(
  w: ReturnType<typeof useWorkbenchStore>,
  index: number,
): readonly AiHex[] {
  const demand = w.arrivalPlan?.units[index]
  if (demand === undefined || demand.kind !== 'aircraft') return []
  const copies = arrivalCopiesOf(demand)
  return (w.arrivalCandidates[index] ?? [])
    .map((hex) => ({ col: hex.col, row: hex.row }))
    .filter((hex) => aircraftBaseHasRoom(w, copies, hex))
}

/** 场上各格现有战斗单位 RE 之和（4.8a：每格 10 RE；到场/重建时优先挑轻格） */
function loadMapOf(w: ReturnType<typeof useWorkbenchStore>): Map<string, number> {
  const loads = new Map<string, number>()
  for (const unit of w.units) {
    const key = `${String(unit.hex.col)}.${String(unit.hex.row)}`
    loads.set(key, (loads.get(key) ?? 0) + unit.re)
  }
  return loads
}

/** 落点排序：先挑当前 RE 最轻的格，再按格号稳定（每快照只建一次 load 表，避免逐次比较扫全场） */
function sortByLoad(hexes: readonly AiHex[], loads: Map<string, number>): AiHex[] {
  return hexes
    .slice()
    .sort(
      (a, b) =>
        (loads.get(`${String(a.col)}.${String(a.row)}`) ?? 0) -
          (loads.get(`${String(b.col)}.${String(b.row)}`) ?? 0) || compareHex(a, b),
    )
}

/**
 * 批 2：C 段支线快照（每个字段只留一个经既有投影筛过的候选）
 *
 * 纪律：这里的筛选只回答「入口会不会必然拒绝」与「值不值得做」，判据全部来自既有投影
 * （`switchableModesOf` / `railMoveFacts` / `railPathBetween` / `detrainableHexes` /
 * `transportLoadableSpOf` / `overrunTargets`）；真正的合法性仍由各提交入口再判一次。
 */
function moveBranchOf(
  w: ReturnType<typeof useWorkbenchStore>,
  memory: AiMemory,
  side: AiSide,
  enemyHexes: readonly AiHex[],
  moveActive: boolean,
  hasStepped: boolean,
  candidates: readonly string[],
): AiMoveBranchSnapshot {
  const can = w.segmentActionKeys
  const nearestEnemy = (hex: AiHex): number => {
    let best = Number.POSITIVE_INFINITY
    for (const enemy of enemyHexes) best = Math.min(best, hexDistance(hex, enemy))
    return best
  }

  // 专规 3.5：建造标记只能在**任何单位移动之前**由轴方放置
  let constructionMarker: AiMoveBranchSnapshot['constructionMarker'] = null
  if (
    side === 'axis' &&
    can.has('move.construction') &&
    !memory.constructionDone &&
    w.constructionMarkers > 0 &&
    w.units.every((unit) => unit.mpSpent === 0 && (unit.airTransportThisPhase ?? 0) === 0) &&
    !w.airUnitCargoManifest.some((item) => item.fate === 'aboard')
  ) {
    const hex = dedupeSortedHexes(
      w.units.filter((unit) => unit.side === 'axis' && unit.isCombat).map((unit) => unit.hex),
    )[0]
    if (hex !== undefined) constructionMarker = { marker: 'bridge', hex }
  }

  // 12.11a：销毁己方补给站（反应段按 `actingSide`；每站每阶段只能试一次）
  let dumpBlow: AiMoveBranchSnapshot['dumpBlow'] = null
  if (can.has('move.dumpBlow')) {
    const dump = w.actingSpDumps
      .filter(
        (item) =>
          item.sp > 0 &&
          (w.dumpDestructionAttempts[item.id] ?? 0) === 0 &&
          !memory.dumpBlowTried.includes(item.id),
      )
      .sort((a, b) => compareHex(a.hex, b.hex) || compareText(a.id, b.id))[0]
    if (dump !== undefined) dumpBlow = { dumpId: dump.id }
  }

  // 5.4：strat→move 以便开拔；已结束且邻敌的 move→combat 转入战斗姿态
  let modeSwitch: AiMoveBranchSnapshot['modeSwitch'] = null
  if (can.has('move.modeChange')) {
    for (const id of candidates) {
      if (memory.modeSwitchTried.includes(id)) continue
      const unit = w.units.find((item) => item.instanceId === id)
      if (unit === undefined || unit.mode.mode !== 'strat') continue
      if (!w.switchableModesOf(id).includes('move')) continue
      modeSwitch = { unitId: id, mode: 'move' }
      break
    }
    if (modeSwitch === null) {
      const ended = w.units
        .filter(
          (unit) =>
            unit.side === side &&
            unit.movementEnded &&
            unit.mode.mode === 'move' &&
            !memory.modeSwitchTried.includes(unit.instanceId),
        )
        .filter((unit) =>
          w.units.some(
            (enemy) =>
              enemy.side !== side && enemy.isCombat && hexDistance(unit.hex, enemy.hex) === 1,
          ),
        )
        .sort(compareStableUnit)
      for (const unit of ended) {
        if (!w.switchableModesOf(unit.instanceId).includes('combat')) continue
        modeSwitch = { unitId: unit.instanceId, mode: 'combat' }
        break
      }
    }
  }

  // 13.3e：铁路运输（单位货 → SP 货）。只在还没开拔、且本回合仍有铁路容量时提案。
  let railUnit: AiMoveBranchSnapshot['railUnit'] = null
  let railSp: AiMoveBranchSnapshot['railSp'] = null
  if (
    !moveActive &&
    !memory.railScanned &&
    can.has('move.railTransport') &&
    w.railCapRemaining[side] > 0
  ) {
    const facts = w.railMoveFacts
    const destinations = dedupeSortedHexes(w.detrainableHexes)
      .filter((hex) => facts.hasRail(hex) && facts.railGaugeUsable(hex, side))
      .filter((hex) => !facts.enemyOccupies(hex, side) && !facts.hasEnemyCombatUnit(hex, side))
      .filter((hex) => !facts.inEnemyZoc(hex, side))
    const closerTargets = (from: AiHex): readonly AiHex[] => {
      const here = nearestEnemy(from)
      return destinations
        .filter((hex) => !(hex.col === from.col && hex.row === from.row))
        .filter((hex) => nearestEnemy(hex) < here)
        .sort((a, b) => nearestEnemy(a) - nearestEnemy(b) || compareHex(a, b))
        .slice(0, 6)
    }
    const units = w.units
      .filter((unit) => unit.side === side && !unit.movementEnded && !unit.mode.dg)
      .filter((unit) => {
        // 13.3g-B：铁路修理单位可整 MA 铁路移动；其余须移动模式（5.6a）且登车前 ≤ 半 MA（13.3e-1）
        if (facts.isRailRepairUnit(unit.instanceId)) return unit.mpSpent <= unit.raw.ma
        return unit.mode.mode === 'move' && unit.mpSpent * 2 <= unit.raw.ma
      })
      .filter((unit) => facts.hasRail(unit.hex))
      .sort(compareStableUnit)
    for (const unit of units) {
      if (memory.railTriedUnits.includes(unit.instanceId)) continue
      const toHex = closerTargets(unit.hex).find(
        (hex) => w.railPathBetween(unit.hex, hex, side) !== null,
      )
      if (toHex !== undefined) {
        railUnit = { unitId: unit.instanceId, toHex }
        break
      }
    }
    if (railUnit === null) {
      const dumps = w.spDumps
        .filter(
          (dump) =>
            dump.side === side &&
            dump.sp > 0 &&
            !memory.railTriedDumps.includes(dump.id) &&
            facts.hasRail(dump.hex),
        )
        .sort((a, b) => compareHex(a.hex, b.hex) || a.sp - b.sp || a.t - b.t)
      for (const dump of dumps) {
        const toHex = closerTargets(dump.hex).find(
          (hex) => w.railPathBetween(dump.hex, hex, side) !== null,
        )
        if (toHex !== undefined) {
          railSp = { dumpId: dump.id, amount: 1, toHex }
          break
        }
      }
    }
    // 扫过一次仍无候选 ⇒ 本环节不再重复 BFS（位置变化由下一环节重算）
    if (railUnit === null && railSp === null) memory.railScanned = true
  }

  // 13.2f：装卸（load 优先；同格有补给站时不卸，避免「装上又卸下」空转）
  let transport: AiMoveBranchSnapshot['transport'] = null
  if (!moveActive && can.has('move.loadUnload')) {
    const points = w.transportPointsOfSide.slice().sort(compareStableUnit)
    for (const point of points) {
      if (memory.transportTried.includes(point.instanceId)) continue
      // 13.2f / 6.1a：装卸都按印刷 MA 的 10% 计费，MP 不够时入口必拒
      const cost = transportPointLoadCost(point.raw.ma)
      if (point.mpSpent + cost > point.raw.ma) continue
      const load = w.transportLoadableSpOf(point.instanceId)
      if (load > 0) {
        /*
         * 13.2f：入口要求**单本账**独自付清（`transportLoadDumpFor`），
         * 而 `transportLoadableSpOf` 是按全格合计给的 ⇒ 这里再取「单本账最多能付多少」，
         * 否则同格两本各 1 SP、界面预填 2 时会被 13.2f 拒。
         */
        const perDump = Math.max(
          0,
          ...w
            .transportDumpsOf(point.instanceId)
            .map((dump) => Math.floor(holdingsToT({ sp: dump.sp, t: dump.t }) / SP_TO_T)),
        )
        const amount = Math.min(Math.floor(load), perDump)
        if (amount > 0) {
          transport = { pointId: point.instanceId, mode: 'load', amount }
          break
        }
      }
      const unload = w.transportUnloadableSpOf(point.instanceId)
      // 只在「本环节真的开过车」之后卸货；同格有补给站也不卸，避免原地装上又卸下
      // 12.1a：余载按 T 记（可为 0.25 SP）⇒ AI 只提案整 SP 的卸载，不足 1 SP 的零头留给玩家
      if (unload >= 1 && point.movementEnded && w.transportDumpsOf(point.instanceId).length === 0) {
        transport = { pointId: point.instanceId, mode: 'unload', amount: Math.floor(unload) }
        break
      }
    }
  }

  // 13.3f：本阶段刚走入非本方轨距格的铁路修理单位（换轨是「移动进入」的副产品）
  // ★ 「刚进入」不在 AI 这边复刻 `steps`：改读 store 的只读投影 `justEnteredHexOf`
  //   （地面逐格与 13.3e 铁路抵达同一份会计，且自动回退与交互收起都已在 store 里处理）。
  let gauge: AiMoveBranchSnapshot['gauge'] = null
  if (moveActive && hasStepped && can.has('move.railConversion')) {
    for (const id of w.moveInteraction?.unitIds ?? []) {
      if (memory.gaugeTried.includes(id)) continue
      const facts = w.railMoveFacts
      if (!facts.isRailRepairUnit(id)) continue
      // 13.3g-A「不能接力」：本阶段已用铁路走过刚换轨的格 ⇒ 不再换轨
      if (
        w.railMovedNewTrackThisPhase.some((item) => item.instanceId === id && item.hexes.length > 0)
      )
        continue
      const unit = w.units.find((item) => item.instanceId === id)
      if (unit === undefined) continue
      if (w.justEnteredHexOf(id, unit.hex) === null) continue
      if (!facts.hasRail(unit.hex) || facts.railGaugeUsable(unit.hex, side)) continue
      if (facts.inEnemyZoc(unit.hex, side)) continue
      // 13.3g-D / 5.10e：须战斗模式，或 DG 但朝向战斗面
      if (!(unit.mode.mode === 'combat' || (unit.mode.dg && unit.mode.orientation === 'combat')))
        continue
      gauge = { unitId: id, hex: { col: unit.hex.col, row: unit.hex.row } }
      break
    }
  }

  // 8.0：移动中尚未落子时的可突袭相邻敌格（投影与 `overrunNow` 同源）
  const triedOverrun = new Set(memory.overrunTried)
  const overrunTargets =
    moveActive && !hasStepped && can.has('move.overrun')
      ? dedupeSortedHexes(w.overrunTargets.map((hint) => hint.hex)).filter(
          (hex) => !triedOverrun.has(hexKeyOf(hex)),
        )
      : []

  return {
    modeSwitch,
    overrunTargets,
    railUnit,
    railSp,
    transport,
    constructionMarker,
    gauge,
    dumpBlow,
  }
}

/**
 * 把 store 的既有只读投影拼成 `AiSnapshot`（**观测的唯一来源**）
 *
 * 对外开放（2026-11-25）：训练/采集侧必须用这一份快照当观测，不要从 store 自拼一套
 * （自拼必然漏字段，规则改版后也不会跟着变）。写盘前请过 `serializeObservation`。
 *
 * ★ 副作用：会调用 `syncMemory`（跨环节时清空"本环节已试过 …"）。这是策略侧的过程状态，
 *   重置本身与盘面无关；但**不要**在一步里对同一 `memory` 反复调用来"检视未来"。
 */
export function snapshotOf(
  ctx: AiContext,
  memory: AiMemory,
  controlMode: AiControlMode,
): AiSnapshot {
  const w = ctx.workbench
  const side = sideOf(w)
  syncMemory(memory, w)

  const friendly = w.units.filter((unit) => unit.side === side)
  const enemy = w.units.filter((unit) => unit.side !== side)
  const enemyHexes = dedupeSortedHexes(enemy.map((unit) => unit.hex))
  const participating = [...w.participatingUnitIds]
  const candidates = participating
    .map((id) => w.units.find((unit) => unit.instanceId === id))
    .filter((unit): unit is NonNullable<typeof unit> => unit !== undefined)
    .filter((unit) => unit.side === side && !unit.movementEnded)
    .sort(compareStableUnit)
    .map((unit) => unit.instanceId)

  const interaction = w.moveInteraction
  const moveActive = interaction !== null && !interaction.finished
  const hasStepped = interaction !== null && interaction.steps.length > 0
  const currentHexKeys = new Set(friendly.map((unit) => hexKeyOf(unit.hex)))
  const visitedHexKeys = new Set(interaction?.steps.map((step) => hexKeyOf(step.to)) ?? [])
  /*
   * 可到达格：**每一步之后都要给**
   *
   * 修前此处在 `hasStepped` 之后返回空集（原本只是"groupReachable 是重投影，别每步都算"的
   * 性能取舍），结果训练/桥接客户端一旦落了一步就再也看不到 `moveClick` 候选，表现为
   * "一次落点即结束移动"，与规则相反：`reachableForMove` 本身按 `ma - spentMp` 过滤
   * （engine/rules/move-interaction.ts），剩余 MP 与合法地形都算在里面，逐格走是正道。
   *
   * 代价是每步多算一次重投影；只在"移动交互仍活着"时算，结束(`finished`)/余量为 0 时
   * `groupReachable` 自己会返回空集，不会白算太久。
   * 仍然排除"已走过的格"和"当前所在格"——不是规则禁止，而是候选集不必把"原地不动"当选项。
   */
  const reachableHexes = moveActive
    ? (w.groupReachable.hexes as { hex: AiHex; mpSpent: number; path?: AiHex[] }[])
        .filter(
          (node) =>
            !visitedHexKeys.has(hexKeyOf(node.hex)) && !currentHexKeys.has(hexKeyOf(node.hex)),
        )
        // 带上累计 MP：客户端在绿格上标数字（Web 版「圈内数字＝累计 MP」同口径）
        // 带上引擎自己算的推荐路径：客户端悬停画路线（Web 版 dragPath 同口径），**不在地图端重算路径**
        .map((node) => ({
          col: node.hex.col,
          row: node.hex.row,
          mp: node.mpSpent,
          path: Array.isArray(node.path)
            ? node.path.map((step) => ({ col: step.col, row: step.row }))
            : undefined,
        }))
    : []

  /*
   * 相邻的敌方守方格（仅作候选；合法性由 select/begin 入口判定）
   *
   * 只给**会主动进攻**的档算：简化档（非 Intro）不宣战、不选攻击目标，
   * 这一步的 O(敌×友) 扫描整段战斗/进击阶段都白算 —— 用户 2026-11-23「还卡」的主要来源之一。
   */
  const aiProfile = ctx.aiProfile ?? aiProfileOf(ctx.scenarioId ?? ctx.session.scenarioId)
  const attackPlanRelevant =
    aiProfile === 'full' && (w.phase === 'combat' || w.phase === 'exploitation')
  const combatRelevant = attackPlanRelevant || w.combatState !== null || w.battleTarget !== null
  const adjacentDefenderHexes = combatRelevant
    ? dedupeSortedHexes(
        enemy
          .filter((unit) => unit.isCombat)
          .filter((unit) =>
            friendly.some((friend) => {
              if (!friend.attackCapable) return false
              const d = Math.abs(friend.hex.col - unit.hex.col)
              const r = Math.abs(friend.hex.row - unit.hex.row)
              return (d === 1 && r === 0) || (d === 0 && r === 1) || (d === 1 && r === 1)
            }),
          )
          .map((unit) => unit.hex),
      ).filter((hex) => !w.attackPhaseLedger.hexes.some((key) => key === hexKeyOf(hex)))
    : []

  const supplyDumps = combatRelevant ? w.combatSupplyDumps : []
  const attackerDumpIds = supplyDumps
    .filter((entry) => entry.side === 'attacker')
    .flatMap((entry) => entry.dumps.map((dump) => dump.id))
  const defenderDumpIds = supplyDumps
    .filter((entry) => entry.side === 'defender')
    .flatMap((entry) => entry.dumps.map((dump) => dump.id))

  const barrageState = w.barrageState
  const barrageRelevant = barrageState !== null || (w.segmentStep?.id ?? '').endsWith('.barrage')
  /*
   * 炮击入口（桥接/训练端）：`barrage.state` 只有 `beginBarrageNow()` 之后才非空，而候选面旧实现
   * 把 `barrageTarget` / `barrageBegin` 整块压在 `state !== null` 里 ⇒ 谁也没法开出第一枪（自锁）。
   * 这里只摊平 store 既有判据 `barrageEntryEligible`（10.0e-A/B/D + 10.1a + 10.1b 同一处），
   * AI 侧不另立口径；能不能真打仍由 `clickHex` / `beginBarrageNow` 判。
   */
  const barrageEntryHexes =
    barrageState === null && barrageRelevant
      ? enemyHexes.filter((hex) => w.barrageEntryEligible(hex))
      : []
  const barrageOutcome = barrageState?.outcome
  const outcomeStepLosses =
    barrageOutcome !== undefined &&
    barrageOutcome !== null &&
    'value' in barrageOutcome &&
    typeof barrageOutcome.value === 'object' &&
    barrageOutcome.value !== null &&
    'stepLosses' in barrageOutcome.value &&
    typeof barrageOutcome.value.stepLosses === 'number'
      ? barrageOutcome.value.stepLosses
      : 0

  const airState = w.airState
  const airRelevant = airState !== null || w.segmentActionKeys.has('air.mission')
  // 14.2f-B：目标只取「引擎判定可打」的敌方战斗单位格；打过的记进 memory，避免同格重试
  const airTargets = airRelevant
    ? dedupeSortedHexes(
        enemy
          .filter((unit) => unit.isCombat)
          .filter((unit) => w.canAirMissionTarget('hip_shoot', unit.hex))
          .map((unit) => unit.hex),
      ).filter((hex) => !memory.airTargets.includes(hexKeyOf(hex)))
    : []
  // 14.2b：只判断「本方还有能打低空扫射的飞机」（含图外空军盒）；够不够得到目标由点名时判
  const airPlane = airRelevant
    ? w.airMissionBaseGroupsWithBox
        .flatMap((group) => group.aircraft)
        .filter((item) => item.air.canHipShoot)[0]
    : undefined

  const plan = w.phase === 'supply' ? w.supplyPhasePlan : null
  const duties =
    plan?.attritionDuty.map((duty) => {
      const key = `${String(duty.hex.col)}.${String(duty.hex.row)}`
      const result = w.attritionResults[key]
      return {
        key,
        applied: w.attritionAppliedHexes.includes(key),
        rolled: result !== undefined,
        needAllocation: result !== undefined && w.attritionNeedsAllocation(key),
        lossesKind: result?.losses.kind ?? 'none',
        lossesSteps: result?.losses.kind === 'steps' ? result.losses.steps : 0,
        units: duty.unitIds
          .map((id) => w.units.find((unit) => unit.instanceId === id))
          .filter((unit): unit is NonNullable<typeof unit> => unit !== undefined)
          .sort(compareStableUnit)
          .map((unit) => ({ id: unit.instanceId, steps: unit.steps })),
      }
    }) ?? []

  // 与 legal-actions-store 的 `advance.available` 同一口径（段锁定 / 初设时不可推进）
  const advanceAvailable = !w.segmentLocked && !w.initialSetupInProgress

  /*
   * B4：控制权换算（只做「角色 → 阵营」映射，不新增判据）
   *   · 攻方＝当前行动方（与 `combatSupplyDumps` 的 attackerSide 同源，workbench:2743-2758）；
   *   · 守方取既有投影 `combatDefenderSide`；
   *   · 撤退归属取各撤退计划自身的 `side`，未选齐的才需要决定；
   *   · 初设归属取 `setupSideCursor`。
   */
  const active = w.activeSide as AiSide
  /*
   * 反应段的行动方是**非行进方**（`actingSideFor`，game-lifecycle.ts:26）。
   * 用户 2026-11-20：PVE 下 AI 执守方 ⇒ 反应段必须认得"现在轮到我"，否则
   * 苏军在反应段永远 wait，不移动、不进攻。
   */
  const acting = (w.segmentGateQuery.side ?? active) as AiSide
  const defenderSide = w.combatDefenderSide as AiSide
  const question = ctx.session.awaiting ? ctx.session.question : null
  const requirement = w.combatRequirement
  const retreatPending = w.combatRetreatPlans.filter((plan) => !plan.complete)
  const setupRemaining = ctx.setup.pendingPlacement
    .filter((item) => item.kind === 'self' || item.kind === 'air')
    .reduce((total, item) => total + item.remaining, 0)

  /*
   * 批 1：初设 / A 整备 / B 增援（到货、到货 SP、补给列车、重建整编）
   *
   * 全部取自既有投影；列表一律按「格号 + 名称」排定，不用含时间戳的 `instanceId` 当先后判据。
   */
  const setupShiftFormationIds = w.initialSetupInProgress
    ? useContainersStore()
        .pendingShiftWestPlacements.filter((item) => item.hexText === null)
        .map((item) => item.formationId)
        .sort()
    : []
  const refitBases: AiRefitBase[] =
    w.phase === 'aircraftRefit' &&
    w.segmentStep?.id === 'aircraftRefit.refit' &&
    !w.initialSetupInProgress
      ? w.refitStartBases
          .filter((base) => !memory.refitBaseIds.includes(base.id))
          .slice()
          .sort((a, b) => compareHex(a.hex, b.hex) || a.level - b.level)
          .flatMap((base) => {
            const inactive = w
              .airInactiveAtBase(base.id)
              .slice()
              .sort((a, b) => compareText(a.name, b.name))
            /*
             * 15.1B：一次整备最多 `min(等级×2 / 简易机场 1, 激活堆叠余额)` 架。
             * 超过这个数引擎会以 15.1B 拒绝（实测把整基地一次塞进去连吃 16 条拒绝）。
             */
            const capacity = refitCapacity({
              isAirstrip: base.isAirstrip === true,
              level: base.level,
            }).capacity
            const room = activeStackingLimitOf(base) - activeAircraftAt(w, base.hex)
            const aircraft = inactive.slice(0, Math.max(0, Math.min(capacity, room)))
            const dump = w
              .airRefitPayDumps(base.id)
              .slice()
              .sort(
                (a, b) =>
                  compareHex(a.hex, b.hex) || a.sp + a.t - (b.sp + b.t) || a.sp - b.sp || a.t - b.t,
              )[0]
            if (aircraft.length === 0 || dump === undefined) return []
            return [
              {
                baseId: base.id,
                hex: { col: base.hex.col, row: base.hex.row },
                aircraftIds: aircraft.map((item) => item.instanceId),
                dumpId: dump.id,
              },
            ]
          })
      : []

  const arrivalEntries: AiArrivalEntry[] = []
  if (w.segmentStep?.id === 'reinforcement.arrival' && !w.initialSetupInProgress) {
    const plan = w.arrivalPlan
    if (plan !== null) {
      const loads = loadMapOf(w)
      plan.units.forEach((unit, index) => {
        if (unit.kind === 'sp' || unit.kind === 'unclassified') return
        if (w.arrivalPlaced[index] === true) return
        if (memory.arrivalTried.includes(String(index))) return
        const candidates = sortByLoad(
          unit.kind === 'aircraft'
            ? aircraftArrivalCandidates(w, index)
            : (w.arrivalCandidates[index] ?? []).map((hex) => ({ col: hex.col, row: hex.row })),
          loads,
        )
        const resolvable = arrivalResolvable(w, index)
        arrivalEntries.push({
          index,
          hex: resolvable ? (candidates[0] ?? null) : null,
          airBox: resolvable && w.arrivalAirBoxAvailable(index),
        })
      })
    }
  }

  const inReplRoll = w.segmentStep?.id === 'reinforcement.replRoll'
  const needsSp = inReplRoll && w.supplyArrivalSp > 0
  const needsTrain = inReplRoll && w.supplyTrainPending
  const arrivalSp = needsSp ? w.supplyArrivalSp : 0
  const reinSupply: AiReinSupplySnapshot = {
    sp: arrivalSp,
    picked: needsSp ? w.freeRailPicked.map((hex) => ({ col: hex.col, row: hex.row })) : [],
    cityCandidates: needsSp
      ? w.freeRailCityCandidates
          .map((item) => item.hex)
          .slice()
          .sort(compareHex)
      : [],
    edgeHex: (() => {
      if (!needsSp) return null
      const edge = w.freeRailEdgeHex ?? w.openSupplySourceHexes[0]
      return edge === undefined ? null : { col: edge.col, row: edge.row }
    })(),
    planReady: needsSp && w.freeRailPlan !== null,
    panzerGroupRulesOn: needsSp && w.panzerGroupRulesOn,
    groupTargets: needsSp
      ? w.arrivalSpGroupTargets
          .map((target) => ({ hexText: target.hexText, sp: target.sp, group: target.group }))
          .sort((a, b) => compareText(a.hexText, b.hexText))
      : [],
    trainPending: needsTrain,
    trainHexes: needsTrain
      ? w.supplyTrainPlacementHexes
          .map((hex) => ({ col: hex.col, row: hex.row }))
          .slice()
          .sort(compareHex)
      : [],
    trainGroupRequired: needsTrain && w.panzerGroupRulesOn && w.supplyTrainGroup === null,
  }

  const rebuild = rebuildSnapshotOf(w, memory)
  const branch = moveBranchOf(w, memory, side, enemyHexes, moveActive, hasStepped, candidates)

  /*
   * 4.8a：超堆叠待处理
   *
   * 只有**所有**超堆叠格都属于当前行动方时才接手：`destroyOverstackPicksNow` 要求每一格都回到
   * ≤10 RE 才整批落盘，若别方还有一格未处理，勾了也会被整批拒绝。
   */
  const overstackDuties = w.phase === 'reinforcement' ? [] : w.overstackDuties
  const overstackActive =
    overstackDuties.length > 0 &&
    !w.overstackSettled &&
    overstackDuties.every((duty) => duty.side === side)

  const setupActive =
    ctx.session.session === null &&
    (w.initialSetupInProgress ||
      ctx.setup.setupDrawEntryVisible ||
      ctx.setup.setupStartEntryVisible ||
      ctx.setup.setupSideCursor !== null)

  return {
    turn: w.turn,
    scenarioId: ctx.scenarioId ?? ctx.session.scenarioId,
    aiProfile: ctx.aiProfile,
    phase: w.phase,
    segment: w.segmentStep?.id ?? '',
    segmentStepIndex: w.segmentStepIndex,
    activeSide: active,
    defenderSide,
    terminated: ctx.session.terminated,
    awaitingOptionIds: question === null ? [] : (question.options ?? []).map((o) => o.id),
    awaitingResponder: question === null ? null : (question.responder as AiSide),
    awaitingPrompt: question?.prompt ?? '',
    setup: {
      active: setupActive,
      cursorActive: ctx.setup.setupSideCursor !== null,
      remaining: setupRemaining,
      drawVisible: ctx.setup.setupDrawEntryVisible,
      shiftFormationIds: setupShiftFormationIds,
    },
    refit: { bases: refitBases },
    rein: {
      arrival: { removalsPending: w.arrivalRemovalsPending, entries: arrivalEntries },
      supply: reinSupply,
      rebuild,
    },
    overstack: { active: overstackActive },
    setupRemaining,
    /*
     * 13.5a：重建圆心（友方、战斗模式或 DG 朝战斗面）——**读侧投影直取 store**（`rebuildHqHexes`），
     * 不在这里另算一份「2 格内」的圆心集合；距离判据由 `rebuildLegalHexes` 的引擎预演负责。
     */
    rebuildHqHexes: w.rebuildHqHexes.map((hex) => ({ col: hex.col, row: hex.row })),

    /*
     * 专规 5.0c：胜利格归属（地图事实层，不是算子、不可选中）。
     * **判据只在 store**：`victoryHexes` 是剧本所列胜利格，`victoryControlOf` 内部已把
     * 「格内可攻击单位」与「最后控制者账本」拼给引擎的 `controlOfHex`；这里只做摊平，
     * 不重算控制，客户端也就不用自己猜归属。
     */
    mapFacts: {
      controlMarkers: w.victoryHexes
        .map((hex) => ({ hex: { col: hex.col, row: hex.row }, side: w.victoryControlOf(hex) }))
        .filter((marker) => marker.side !== null)
        .map((marker) => ({
          col: marker.hex.col,
          row: marker.hex.row,
          side: marker.side as AiSide,
        })),
    },

    /*
     * 会话框：标题 / 规则角标 / 关闭语义 / 待决清单**整段读 web 的 mapView store**（`panel-steps.ts`），
     * 客户端只渲染、不造句、也不判"该不该关"。改 web 面板即等于改客户端。
     */
    panel: projectPanel(),

    control: {
      // 反应段按 `acting`（非行进方）算控制权；其余阶段两者同值
      activeSide: aiControlsSide(controlMode, acting),
      responder: question !== null && aiControlsSide(controlMode, question.responder as AiSide),
      attacker: aiControlsSide(controlMode, acting),
      defender: aiControlsSide(controlMode, defenderSide),
      // 14.5：拦截应答归守方 —— PVE 下 AI 替守方应答（用户 2026-11-20「以 PVE 为基础」）
      interceptAnswer:
        w.airState !== null &&
        w.airState.step === 'interception' &&
        aiControlsSide(controlMode, (w.airState.side === 'axis' ? 'soviet' : 'axis') as AiSide),
      requirement:
        requirement !== null &&
        aiControlsSide(controlMode, requirement.side === 'attacker' ? active : defenderSide),
      retreat: retreatPending.every((plan) =>
        aiControlsSide(controlMode, plan.side === 'attacker' ? active : defenderSide),
      ),
      setup:
        ctx.setup.setupSideCursor === null
          ? controlMode !== 'off'
          : aiControlsSide(controlMode, ctx.setup.setupSideCursor),
    },
    setupInProgress: w.initialSetupInProgress,
    locked: w.segmentLocked,
    can: w.segmentActionKeys,
    advanceAvailable: advanceAvailable && !w.initialSetupInProgress,
    specialPending: w.specialPending !== null,
    reserveUnitIds: friendly
      .filter((unit) => unit.mode.mode === 'reserve' && participating.includes(unit.instanceId))
      .sort(compareStableUnit)
      .map((unit) => unit.instanceId),
    reserveTriedUnitIds: memory.reserveUnitIds,
    /*
     * 5.7g：与 `segmentAdvanceBlock`（workbench.ts，段末闸门）**同一判据**——
     * 「本方 + 规范模式仍是预备 + 所在格有环形工事」⇒ 段末必被拦。判据取 `canonicalMode`：
     * 已按 5.7b 释放的预备只剩临时旗标，不再受约束，AI 也不该再去释放它。
     */
    reserveOnHedgehogIds: friendly
      .filter((unit) => canonicalMode(unit.mode) === 'reserve' && w.hedgehogLevelOf(unit.hex) > 0)
      .sort(compareStableUnit)
      .map((unit) => unit.instanceId),
    reserveReleasedUnitIds: memory.reserveReleasedIds,
    // 12.5a：本方「需要燃料但仍未加注」的战斗单位（判据取引擎 `needsFuelOf`，不另立一套）
    fuel: {
      unfuelledUnitIds: friendly
        .filter((unit) => needsFuelOf(unit) && !unit.fuelled)
        .sort(compareStableUnit)
        .map((unit) => unit.instanceId),
      triedUnitIds: memory.fuelTriedIds,
    },
    move: {
      active: moveActive,
      hasStepped,
      selectedIds: moveActive ? (interaction?.unitIds ?? []) : [],
      reachableHexes,
      triedUnits: memory.movedUnitIds,
      triedTargets: memory.moveTargets,
      candidates,
      enemyHexes,
    },
    branch,
    air: {
      inProgress:
        airState !== null &&
        !airState.finished &&
        !memory.airAborted.includes(`${w.turn}/${w.phase}`),
      flownThisPhase: memory.airSorties.includes(`${w.turn}/${w.phase}`),
      inMovementPhase: w.phase === 'movement',
      weatherNormal: w.airInputs.weatherNormal,
      target: airTargets[0] ?? null,
      aircraftId: airPlane?.air.instanceId ?? null,
      missionSide: airState !== null ? (airState.side as AiSide) : null,
      driveable:
        airState === null || aiControlsSide(controlMode, (airState.side ?? active) as AiSide),
    },
    airInterception:
      airState !== null && !airState.finished && airState.step === 'interception'
        ? {
            missionSide: airState.side as AiSide,
            candidates: w.airInterceptorCandidates.map((item) => item.instanceId).sort(),
            controlled: aiControlsSide(
              controlMode,
              (airState.side === 'axis' ? 'soviet' : 'axis') as AiSide,
            ),
          }
        : null,
    barrage: {
      state:
        barrageState === null
          ? null
          : {
              step: barrageState.step,
              kind: barrageState.kind,
              targetHex: barrageState.targetHex ?? null,
              costT: barrageState.table.costT,
            },
      choices: barrageRelevant
        ? w.barrageUnitChoices
            .map((choice) => choice.unit)
            .sort(compareStableUnit)
            .map((unit) => ({
              unitId: unit.instanceId,
              disabled: w.barrageUnitChoices.find((c) => c.unit.instanceId === unit.instanceId)
                ?.disabledReason
                ? true
                : false,
            }))
        : [],
      selectedUnitIds: barrageRelevant ? w.barrageUnits.map((unit) => unit.instanceId) : [],
      targetHex: barrageRelevant ? w.barrageTargetHex : null,
      supplyDumpIds: barrageRelevant ? w.barrageSupplyDumpChoices.map((dump) => dump.id) : [],
      triedTargets: memory.barrageTargets,
      enemyHexes,
      entryHexes: barrageEntryHexes,
      outcomeStepLosses,
      lossTargets: barrageRelevant
        ? w.barrageLossTargets
            .slice()
            .sort(compareStableUnit)
            .map((unit) => ({ unitId: unit.instanceId, steps: unit.steps }))
        : [],
    },
    combat: {
      state:
        w.combatState === null
          ? null
          : {
              step: w.combatState.step,
              finished: w.combatState.finished,
              declaredAttackerArUnitId: w.combatState.declaredAttackerArUnitId,
            },
      defenderHex: w.battleTarget?.hex ?? null,
      adjacentDefenderHexes,
      attackerDumpIds,
      defenderDumpIds,
      attackerSupplyConfirmed: w.combatInputs.supplyConfirmed.attacker,
      defenderSupplyConfirmed: w.combatInputs.supplyConfirmed.defender,
      /*
       * 12.10a：图上取得不到所需 SP 才可动储备（store 的同一个判据，不在 AI 另立口径）；
       * 剧本页明禁攻方储备时 store 已恒 false。
       */
      attackerStocksApplicable: w.combatAttackerStocksApplicable,
      defenderStocksApplicable: w.combatDefenderStocksApplicable,
      requirement:
        w.combatRequirement === null
          ? null
          : {
              side: w.combatRequirement.side,
              losses: w.combatRequirement.losses,
              options: w.combatRequirement.options,
            },
      /*
       * 9.10a / 9.12：选项步的落点预演与可用军力（只在选项步取，避免每步都算路径）。
       * 这是「能不能安全撤退」在选项面板上唯一的出处 —— `retreatPlans` 此时还没建。
       */
      optionLadder: w.combatState?.step === 'options' ? w.combatOptionRetreatLadder : [],
      optionCapacity: w.combatState?.step === 'options' ? w.combatOptionCapacity : 0,
      /*
       * 撤退计划只在一场战斗真正在走时才算（`combatState` / 已出需求）——
       * 修前整段战斗/进击阶段每步都为所有堆叠预算落点，是「进战斗阶段就卡」的主因。
       */
      retreatPlans:
        w.combatState !== null || w.combatRequirement !== null
          ? w.combatRetreatPlans.flatMap((plan) =>
              plan.units.map((row) => ({
                unitId: row.unitId,
                role: plan.side,
                chosen: row.chosen,
                destinations: row.destinations.map((destination) => ({
                  hex: destination.hex,
                  forcedDestruction: destination.forcedDestruction,
                  inEnemyZoc: destination.inEnemyZoc,
                  path: destination.path,
                })),
              })),
            )
          : [],
      triedDefenderHexes: memory.combatHexes,
      /*
       * 9.6：行动值**候选单位**（web 面板的那两份清单，直接取 store 投影）
       *
       * `combatAttackerArOptions` 给攻方全体参战；`combatDefenderArChoices` 已按专规 2.3b
       * （NKVD 在场时必须由它担任）收窄过 ⇒ 客户端不必自己筛。
       * `selected*` 是引擎当前预选（默认"AR 最高"），客户端只显示谁被选中。
       */
      arOptions: {
        attacker: w.combatAttackerArOptions.map((option) => ({
          unitId: option.id,
          label: option.label,
          selected: w.combatInputs.attackerArUnitId === option.id,
        })),
        defender: w.combatDefenderArChoices.map((option) => ({
          unitId: option.id,
          label: option.label,
          selected: w.combatInputs.defenderArUnitId === option.id,
        })),
      },
      /*
       * 9.11a/c：损失分担。只在 `losses` 步给（别的步这两份计算值没有意义），
       * `canonical / swapChoices` 都是 store 原样投影 —— 合规余地由 store 判，AI 不另立口径。
       */
      lossPlan:
        w.combatState?.step === 'losses'
          ? (() => {
              const canonical = w.combatCanonicalLosses.map((item) => ({
                unitId: item.unitId,
                steps: item.steps,
              }))
              /*
               * 9.11b：需求点数超出该方可承受军力时，剩下的被忽略 —— 这个差额就是「忽略 N 点」。
               * 两个数都来自 store（`combatRequirement.losses` 与 `combatCanonicalLosses`），这里只相减。
               */
              const required = w.combatRequirement?.losses ?? 0
              const planned = canonical.reduce((sum, item) => sum + item.steps, 0)
              return {
                canonical,
                swapChoices: w.combatLossSwapChoices.map((choice) => ({
                  unitId: choice.unitId,
                  label: choice.label,
                })),
                takerId: w.combatInputs.lossTakerId,
                ignored: Math.max(0, required - planned),
              }
            })()
          : undefined,
    },
    supply: {
      planLoaded: plan !== null && plan !== undefined,
      recoverySettled: w.supplyRecoverySettled,
      feedingSettled: w.supplyFeedingSettled,
      duties,
    },
  }
}

function ruleFromStores(w: ReturnType<typeof useWorkbenchStore>): string | null {
  return (
    w.actionRefusal?.rule ??
    w.moveBlocked?.rule ??
    w.combatError?.rule ??
    w.barrageError?.rule ??
    w.supplyPhaseError?.rule ??
    null
  )
}

function execute(
  action: AiAction,
  ctx: AiContext,
  memory: AiMemory,
  presetSide: AiSide | null,
): boolean {
  const w = ctx.workbench
  switch (action.kind) {
    case 'answer':
      return ctx.session.answerNow(action.optionId)
    case 'advance': {
      if (w.advanceSegmentNow() !== null) return true
      /*
       * 1.6b：第二段有未落位手牌时，流程条按规则挡住（补员不得跨方串账）。
       * 基线 AI 不做补员落位 ⇒ 走面板的「结束本段」并确认放弃上场；
       * 2.3c 的方面军预备队是「必须当即领取」，先领再放弃（领取本身是规则义务）。
       */
      if (
        w.phase === 'reinforcement' &&
        w.segmentStep?.id === 'reinforcement.replRoll' &&
        w.rollHandPending
      ) {
        if (
          w.activeSide === 'soviet' &&
          w.frontalReservesToday !== null &&
          !w.frontalReservesClaimed.includes(w.frontalReservesToday.date)
        ) {
          w.claimFrontalReservesNow()
        }
        // 3.3c：轴方撤离若停在「选同印值算子顶替」，基线 AI 取第一个合法候选。
        if (w.variableExitSelectionOpen) {
          const substitute = w.variableExitSelectionSet.eligibleIds[0]
          if (substitute !== undefined) w.confirmVariableExitSubstitute(substitute)
        }
        // 1.6c 独立一掷：AI 也不复用 1.6b 的骰面
        useContainersStore().drawSpecialRepl(w.activeSide)
        return w.endRollSegmentNow(true)
      }
      return false
    }
    case 'preset': {
      // B4：只预设 AI 控制的一方；另一方（玩家）的自由落位保留
      const result =
        presetSide === null
          ? ctx.setup.presetSelfSetupNow()
          : ctx.setup.presetSelfSetupNow({ onlySide: presetSide })
      return result.failures.length === 0 && (presetSide !== null || result.remaining === 0)
    }
    case 'setupPreset':
      return execute({ kind: 'preset' }, ctx, memory, presetSide)
    case 'setupDraw':
      return ctx.setup.drawSetupEffectsNow()
    case 'setupConfirm':
      return ctx.setup.startGameNow()
    case 'setupShiftPlace': {
      // ch10：西移缺落点 ⇒ 用初设面板同一入口，从候选里取稳定序第一格
      if (!ctx.setup.beginShiftPlacement(action.formationId)) return false
      const candidates = (ctx.setup.placing?.candidates ?? []).slice().sort(compareHex)
      const hex = candidates[0]
      if (hex === undefined) {
        ctx.setup.cancelPlacement()
        return false
      }
      return ctx.setup.placeAtHex({ col: hex.col, row: hex.row })
    }
    case 'refitBase': {
      memory.refitBaseIds.push(action.baseId)
      return w.refitBaseNow(action.baseId, [...action.aircraftIds], action.dumpId)
    }
    case 'arrivalRemovals': {
      w.applyArrivalRemovalsNow()
      return w.arrivalRemovalsPending === false
    }
    case 'arrivalPlace': {
      const ok =
        action.hex === null
          ? w.placeArrivalInAirBoxNow(action.index)
          : w.placeArrivalNow(
              action.index,
              w.arrivalRecordOf(action.index)?.id,
              `${String(action.hex.col)}.${String(action.hex.row)}`,
            )
      if (!ok) memory.arrivalTried.push(String(action.index))
      return ok
    }
    case 'arrivalSkip':
      memory.arrivalTried.push(String(action.index))
      return true
    case 'supplyArrivalPick': {
      w.toggleFreeRailPick(action.hex)
      return w.freeRailPicked.some(
        (hex) => hex.col === action.hex.col && hex.row === action.hex.row,
      )
    }
    case 'supplyArrivalGroup': {
      w.setArrivalSpGroup(action.hexText, action.group)
      return (
        w.arrivalSpGroupTargets.find((target) => target.hexText === action.hexText)?.group ===
        action.group
      )
    }
    case 'supplyArrivals':
      return w.applySupplyArrivalsNow()
    case 'supplyTrainGroup': {
      w.setSupplyTrainGroup(action.group)
      return w.supplyTrainGroup === action.group
    }
    case 'supplyTrainPlace':
      return w.placeSupplyTrainSpNow(action.hex)
    case 'rebuild': {
      let ok = false
      if (action.mode === 'airBox') ok = w.rebuildAircraftIntoBoxNow(action.unitId)
      else if (action.mode === 'onMap') ok = w.rebuildOnMapUnitNow(action.unitId)
      else if (action.hex !== null) {
        const opened = w.beginDeadPileRebuildNow(action.unitId)
        if (opened) w.pickHexFor(action.hex)
        ok = w.rebuildPlacedThisSegment.some((item) => item.instanceId === action.unitId)
      }
      if (!ok) memory.rebuildUnitIds.push(action.unitId)
      return ok
    }
    case 'consolidate': {
      const ok = w.consolidateUnitsNow(action.keepId, action.removeId)
      memory.consolidated = true
      return ok
    }
    case 'overstackDestroy': {
      // 4.8a 默认取舍：先毁 RE 最大的（损失枚数最少），同 RE 按名称稳定
      for (const duty of w.overstackDuties) {
        const units = duty.units.slice().sort((a, b) => b.re - a.re || compareText(a.name, b.name))
        let remaining = duty.combatRe
        for (const unit of units) {
          if (remaining <= 10) break
          w.toggleOverstackPick(duty.key, unit.instanceId)
          remaining -= unit.re
        }
      }
      return w.destroyOverstackPicksNow()
    }
    case 'wait':
      return false
    case 'modeChange': {
      memory.reserveUnitIds.push(action.unitId)
      w.selectedId = action.unitId
      w.switchUnitMode('combat')
      const unit = w.units.find((item) => item.instanceId === action.unitId)
      return unit !== undefined && unit.mode.mode === 'combat'
    }
    case 'reserveRelease': {
      memory.reserveReleasedIds.push(action.unitId)
      w.selectedId = action.unitId
      // 5.7b：入口只认「选中的那一枚」（`releaseReserveNow` 取 `selectedUnit`）
      if (!w.releaseReserveNow()) return false
      const unit = w.units.find((item) => item.instanceId === action.unitId)
      return unit !== undefined && canonicalMode(unit.mode) !== 'reserve'
    }
    case 'fuelPay': {
      /*
       * 12.5a / 12.5c-C：与玩家右键同一入口 —— `openFuelNow` 落**受注单位**（`fuelSubjectId`，
       * `fuelTargets` 优先取它），再声明图上来源（`fuelDumpChoices` = 该单位此刻拖得到的站，
       * 12.3a ∪ 12.1b 的运输点装载），按单独单位法付 1T。
       *
       * ★ 只给 `selectedId` 不行：`fuelTargets` 的优先级是「开拔中的堆叠 > 取子清单 > 选中那一枚」，
       *   刚结束的一次移动若还留着 `moveUnits`，付款就会算到那叠（12.5a「选中的单位都不需要燃料」）——
       *   2026-11-24 Intro 的 `Ge 12.Pz 22 MC` 就是这样白付不到的。
       */
      memory.fuelTriedIds.push(action.unitId)
      if (!w.openFuelNow(action.unitId, 'singleUnit')) return false
      const dump = w.fuelDumpChoices[0]
      if (dump === undefined) {
        w.closeFuelNow()
        return false
      }
      if (!w.pickFuelDump(dump.id)) {
        w.closeFuelNow()
        return false
      }
      w.payFuel('singleUnit')
      const unit = w.units.find((item) => item.instanceId === action.unitId)
      const ok = unit !== undefined && unit.fuelled
      w.closeFuelNow()
      /*
       * 12.5a 的"未加注不能动"被拒，加完油就该能再点（Web 版就是这么用的）。
       * 修前被拒的单位永久留在 `movedUnitIds` 里 ⇒ 候选表整段不给它，加油也救不回来。
       */
      if (ok) memory.movedUnitIds = memory.movedUnitIds.filter((id) => id !== action.unitId)
      return ok
    }
    case 'moveBegin': {
      const ok = w.beginMoveFor([action.unitId])
      /*
       * 只在**被规则拒**时记账（不是每次开拔都记）
       *
       * 修前每次 `moveBegin` 都推进 `movedUnitIds`，而候选表按它过滤 ⇒
       * ① 玩家"点一下看看可达范围"再收工，这个单位本段的移动机会就没了；
       * ② 先点被 12.5a 拒、之后加油，同段也再点不动（Web 版里这两种都能继续）。
       * AI 侧需要记住的只是"这个单位试了也进不去"，所以被拒才记；真走过步的在
       * `moveClick` 里记（见下），不在这里重复。
       */
      if (!ok) memory.movedUnitIds.push(action.unitId)
      return ok
    }
    case 'moveClick': {
      const stepsBefore = w.moveInteraction?.steps.length ?? 0
      w.clickHex(action.hex)
      const stepsAfter = w.moveInteraction?.steps.length ?? 0
      const finished = w.moveInteraction?.finished ?? false
      const ok = finished || stepsAfter > stepsBefore
      if (!ok) memory.moveTargets.push(hexKeyOf(action.hex))
      if (stepsAfter > stepsBefore) {
        for (const id of w.moveInteraction?.unitIds ?? []) {
          if (!memory.movedUnitIds.includes(id)) memory.movedUnitIds.push(id)
        }
      }
      return ok
    }
    case 'moveFinish':
      w.finishMove()
      return true
    /*
     * 6.1：两个回退动作的返回值就是 store 的判决（`refuseRollback` / 封盘 / 8.1a 突袭未收束都在里面），
     * 这里不另判一遍 —— 拒绝原因由 store 写进 moveBlocked + 日志，客户端照 `info.reason` 透传。
     */
    case 'moveUndo':
      return w.undoLastStep()
    case 'moveCancel': {
      /*
       * store 的 `cancelWholeMove()` 只回 void（封盘 / 8.1a 突袭未收束这类拒绝由它自己写
       * `moveBlocked` + 日志，理由由 `runAiStep` 从日志栈顶取）⇒ 这里用「整次移动是否真被收掉」判成败，
       * 不能靠返回值（那会恒 true，把被拒的动作报成 OK）。
       */
      const before = w.moveInteraction
      w.cancelWholeMove()
      return before !== null && (w.moveInteraction === null || w.moveInteraction.steps.length === 0)
    }
    /* ────────── 批 2：C 段支线 ────────── */
    case 'modeChangeTo': {
      memory.modeSwitchTried.push(action.unitId)
      w.movePick = null
      w.selectedId = action.unitId
      w.switchUnitMode(action.mode)
      const unit = w.units.find((item) => item.instanceId === action.unitId)
      return unit !== undefined && unit.mode.mode === action.mode
    }
    case 'dumpBlow': {
      const ok = w.destructDumpNow(action.dumpId)
      if (!ok) memory.dumpBlowTried.push(action.dumpId)
      return ok
    }
    case 'overrun': {
      memory.overrunTried.push(hexKeyOf(action.hex))
      return w.overrunNow(action.hex)
    }
    case 'railMove': {
      memory.railTriedUnits.push(action.unitId)
      w.selectedId = action.unitId
      w.railMoveInputs = { ...w.railMoveInputs, toHexText: hexKeyOf(action.toHex) }
      // 试算已含「校验 + 当日容量」两道判据：不过就不提交（不计规则拒绝，也不改货物）
      if (!w.railMoveNow('unit', true)) return true
      return w.railMoveNow('unit')
    }
    case 'railMoveSp': {
      memory.railTriedDumps.push(action.dumpId)
      w.railMoveInputs = {
        ...w.railMoveInputs,
        fromDumpId: action.dumpId,
        spAmount: action.amount,
        toHexText: hexKeyOf(action.toHex),
      }
      if (!w.railMoveNow('sp', true)) return true
      return w.railMoveNow('sp')
    }
    case 'transportLoad': {
      memory.transportTried.push(action.pointId)
      w.selectTransportLoadPointNow(action.pointId)
      w.transportLoadInputs = { ...w.transportLoadInputs, loadAmount: action.amount }
      return w.loadTransportPointNow()
    }
    case 'transportUnload': {
      memory.transportTried.push(action.pointId)
      w.selectTransportLoadPointNow(action.pointId)
      w.transportLoadInputs = { ...w.transportLoadInputs, unloadAmount: action.amount }
      return w.unloadTransportPointNow()
    }
    case 'constructionMarker': {
      memory.constructionDone = true
      return w.useConstructionMarkerNow(action.marker, hexKeyOf(action.hex))
    }
    case 'gaugeConvert': {
      memory.gaugeTried.push(action.unitId)
      return w.convertRailGaugeNow(action.unitId, hexKeyOf(action.hex))
    }
    case 'specialConfirm': {
      for (const item of w.specialPending?.items ?? []) {
        const candidate = item.candidates[0]
        if (item.chosen === null && candidate !== undefined)
          w.setSpecialDisplacement(item.unitId, candidate)
      }
      return w.confirmSpecialCombatNow()
    }
    case 'interceptAnswer': {
      /*
       * 14.5：守方应答拦截 —— 有候选机就派第一架（教学局=I.153 起飞后被打回），
       * 没有就宣布不拦。只做"应答 + 空战结算"，任务其余步骤仍归任务方。
       */
      if (w.airState === null || w.airState.step !== 'interception' || w.airState.finished)
        return false
      const candidate = w.airInterceptorCandidates[0]
      if (candidate !== undefined) {
        w.airInputs = {
          ...w.airInputs,
          interceptDeclared: true,
          interceptorId: candidate.instanceId,
        }
        if (!w.declareInterceptionNow()) return false
        return w.resolveInterceptionCombatNow()
      }
      w.airInputs = { ...w.airInputs, interceptDeclared: false }
      return w.declareInterceptionNow()
    }
    case 'airMission': {
      /*
       * 14.2f A→G：未起任务就先「定种类 + 定目标 + 点名飞机」再宣布；
       * 已起任务则按当前步推进——空战（14.3）、拦截应答（14.5，默认不拦）、
       * 防空（14.4）、任务结算（14.2f-F）、返航（G）。
       * 天气受限时 `air.mission` 本就不在 `can` 里，驱动不会走到这里（按原文不飞）。
       */
      const air = { target: action.target, aircraftId: action.aircraftId }
      if (w.airState !== null && w.airState.finished) w.cancelAir()
      if (w.airState === null) {
        if (air.target === null) return false
        const target = air.target
        w.setAirMissionKind('hip_shoot')
        if (!w.setAirTargetFromText(hexKeyOf(target))) {
          memory.airTargets.push(hexKeyOf(target))
          return false
        }
        // 定好目标后按引擎口径挑第一架够得到的低空扫射机（含图外空军盒，1.4a）
        const pick = w.airMissionBaseGroupsWithBox
          .flatMap((group) => group.aircraft)
          .filter(
            (item) =>
              item.disabledReason === null &&
              item.air.canHipShoot &&
              !memory.airAircraft.includes(item.air.instanceId),
          )
          .sort((a, b) =>
            compareStableUnit(
              { hex: a.air.hex, unitId: a.air.aircraftId },
              { hex: b.air.hex, unitId: b.air.aircraftId },
            ),
          )[0]
        if (pick === undefined) {
          memory.airTargets.push(hexKeyOf(target))
          return false
        }
        w.toggleAirMissionUnit(pick.air.instanceId)
        memory.airTargets.push(hexKeyOf(target))
        memory.airAircraft.push(pick.air.instanceId)
      }
      for (let guard = 0; guard < 16; guard += 1) {
        const state = w.airState
        if (state === null) return w.runAirMissionNow()
        if (state.finished) {
          // 已收束：登记「本阶段飞过」，并清掉任务态（否则下一架会被陈旧状态挡住）
          memory.airSorties.push(`${w.turn}/${w.phase}`)
          w.cancelAir()
          return true
        }
        switch (state.step) {
          case 'airCombat':
            if (!w.autoResolveAirMissionNow()) {
              memory.airSorties.push(`${w.turn}/${w.phase}`)
              w.cancelAir()
              return false
            }
            continue
          case 'interception':
            w.airInputs = { ...w.airInputs, interceptDeclared: false }
            if (!w.declareInterceptionNow()) {
              memory.airSorties.push(`${w.turn}/${w.phase}`)
              w.cancelAir()
              return false
            }
            continue
          case 'flak':
            if (!w.autoResolveAirMissionNow()) {
              memory.airSorties.push(`${w.turn}/${w.phase}`)
              w.cancelAir()
              return false
            }
            continue
          case 'resolveMission':
            if (!w.settleAirMissionNow()) {
              // 引擎拒绝结算（如 10.0/10.0b 观察员不合法）⇒ 记一次、本阶段不再推进该任务
              w.cancelAir()
              memory.airAborted.push(`${w.turn}/${w.phase}`)
              memory.airSorties.push(`${w.turn}/${w.phase}`)
              return false
            }
            continue
          case 'returnToBase':
            if (!w.completeAirReturnNow()) {
              memory.airSorties.push(`${w.turn}/${w.phase}`)
              w.cancelAir()
              return false
            }
            continue
          default:
            return true
        }
      }
      return true
    }
    case 'barrageTarget': {
      w.clickHex(action.hex)
      return w.barrageTargetHex !== null && hexKeyOf(w.barrageTargetHex) === hexKeyOf(action.hex)
    }
    case 'barrageToggleUnit': {
      w.toggleBarrageUnit(action.unitId)
      return w.barrageUnits.some((unit) => unit.instanceId === action.unitId)
    }
    case 'barrageBegin': {
      const ok = w.beginBarrageNow()
      if (!ok && w.barrageTargetHex !== null)
        memory.barrageTargets.push(hexKeyOf(w.barrageTargetHex))
      return ok
    }
    case 'barrageSupply':
      if (action.dumpId !== null) w.pickBarrageSupplyDump(action.dumpId)
      return w.confirmBarrageSupplyStep()
    case 'barrageShifts':
      return w.confirmBarrageShiftsStep()
    case 'barrageDice':
      return w.rollBarrageDiceStep()
    case 'barrageOutcome': {
      const losses: Record<string, number> = {}
      for (const loss of action.losses) losses[loss.unitId] = loss.steps
      w.barrageInputs = { ...w.barrageInputs, losses }
      return w.confirmBarrageOutcomeStep()
    }
    case 'barrageCancel':
      w.cancelBarrage()
      return true
    case 'combatSelect': {
      w.selectCombatDefenderHex(action.hex)
      const ok = w.battleTarget !== null && hexKeyOf(w.battleTarget.hex) === hexKeyOf(action.hex)
      if (!ok) memory.combatHexes.push(hexKeyOf(action.hex))
      return ok
    }
    case 'combatBegin': {
      const ok = w.beginCombatNow()
      if (!ok && w.battleTarget !== null) memory.combatHexes.push(hexKeyOf(w.battleTarget.hex))
      return ok
    }
    case 'combatSupply': {
      /*
       * 12.4 / 9.5b：AI 只落 `action.side` 这一侧；两侧都归 AI（自对打）才由 `advance` 推进。
       * 旧实现一次确认两侧 ⇒ PVE 里 AI 攻方连带代答人类守方的付款（自动扣 / 自动拒付）。
       *
       * 付款次序按原文：
       *   ① 12.3a/12.3b —— 把该侧**可达的每一座站**逐座点上，直到图上 T 够整笔
       *      （12.4 允许不同单位各取各站；需求＝攻方逐单位 steps 之和 / 守方整笔 2T）；
       *   ② 12.10a —— **图上仍不够**才可动部队储备（图上够额时绝不动储备）；
       *   ③ 两样都凑不出 —— 攻方弃攻（12.4「或者根本不攻击」）/ 守方拒付（9.5-B，半战斗值防御）。
       * 12.10c：本侧只要有**耗尽**单位就不喂储备方案（引擎必拒，且退化为「整场开打不了」）。
       */
      const attackerNeedT = w.combatAttackerViews
        .filter((view) => w.combatAttackerIds.includes(view.id))
        .reduce((sum, view) => sum + view.steps, 0)
      const defenderNeedT = w.combatSupplyNeedT.defender
      const hasExhausted = (side: 'attacker' | 'defender'): boolean =>
        (side === 'attacker' ? w.combatAttackerViews : w.combatDefenderViews).some(
          (view) => view.internalStocks === 'exhausted',
        )
      /** 把该侧可达站逐座点上，直到图上 T 够额；返回该侧当前的图上可用 T */
      const coverWithMap = (
        side: 'attacker' | 'defender',
        needT: number,
        firstId: string | null,
      ): number => {
        const entry = w.combatSupplyDumps.find((item) => item.side === side)
        /*
         * 12.3a：每个单位只从**一座**站取满 ⇒ 先点**容量大**的站（同容量按 id 定序）。
         * 若按 id 顺序点，可能先点掉几座小站、总额够了但某个大需求单位单座取不满，
         * 落账时被判「付不清」。
         */
        const dumps = [...(entry?.dumps ?? [])].sort(
          (a, b) =>
            holdingsToT({ sp: b.sp, t: b.t }) - holdingsToT({ sp: a.sp, t: a.t }) ||
            a.sp - b.sp ||
            a.t - b.t,
        )
        const picked = new Set(w.combatSupplyDumpPicks[side])
        const availableT = (): number =>
          side === 'attacker'
            ? w.combatInputs.attackerAvailableT
            : w.combatInputs.defenderAvailableT
        const pick = (id: string): void => {
          if (picked.has(id)) return
          if (!w.pickCombatSupplyDump(side, id)) return
          picked.add(id)
        }
        if (firstId !== null) pick(firstId)
        for (const dump of dumps) {
          if (availableT() >= needT) break
          pick(dump.id)
        }
        return availableT()
      }
      /** 落一方的付款输入：图上次序在前，12.10a 判定后才允许动储备 */
      const applySide = (
        side: 'attacker' | 'defender',
        dumpId: string | null,
        wantStocks: boolean,
        needT: number,
      ): number => {
        const availableT = coverWithMap(side, needT, dumpId)
        const stocks = wantStocks && availableT < needT && !hasExhausted(side)
        w.combatInputs =
          side === 'attacker'
            ? { ...w.combatInputs, attackerUsesInternalStocks: stocks }
            : {
                ...w.combatInputs,
                /*
                 * 9.5-B：守方"支付"与"拒付"是自己选的 —— 有来源（图上或储备）就付，
                 * 两者都没有才是拒付（以一半战斗值防御），不留一份空账去撞 12.4。
                 */
                defenderProvides: dumpId !== null || stocks,
                defenderUsesInternalStocks: stocks,
              }
        return availableT
      }
      if (action.side === 'attacker') {
        applySide(
          'attacker',
          action.attackerDumpId,
          action.attackerUsesInternalStocks === true,
          attackerNeedT,
        )
        return w.confirmCombatSupplySide('attacker')
      }
      if (action.side === 'defender') {
        applySide(
          'defender',
          action.defenderDumpId,
          action.defenderUsesInternalStocks === true,
          defenderNeedT,
        )
        return w.confirmCombatSupplySide('defender')
      }
      applySide(
        'attacker',
        action.attackerDumpId,
        action.attackerUsesInternalStocks === true,
        attackerNeedT,
      )
      applySide(
        'defender',
        action.defenderDumpId,
        action.defenderUsesInternalStocks === true,
        defenderNeedT,
      )
      const ok = w.confirmCombatSupply()
      if (!ok && w.battleTarget !== null) {
        memory.combatHexes.push(hexKeyOf(w.battleTarget.hex))
        w.cancelCombat()
      }
      return ok
    }
    case 'combatDeclareAr':
      return w.declareCombatArStep(action.side)
    /*
     * 9.6 选择（不是宣布）：照 web 面板的同一条写法，只写 `combatInputs` 的预选。
     * 合法性由随后的 `declareCombatArStep` 判（含专规 2.3b 的 NKVD 收窄）——这里不另立门槛。
     */
    case 'combatArUnit': {
      if (action.side === 'attacker') {
        w.combatInputs.attackerArUnitId = action.unitId
      } else {
        w.combatInputs.defenderArUnitId = action.unitId
      }
      return true
    }
    case 'combatAutoResolve':
      return w.autoResolveCombatToOutcome()
    case 'combatLosses':
      return w.confirmCombatLosses()
    /*
     * 9.11a/c：只写玩家意图（web 面板同一条路：直接赋 `combatInputs.lossTakerId`），
     * 合法性由随后 `combatLosses` 交给引擎的 `validateBattleLossAllocation` 判 ⇒ 这里只挡"候选之外的单位"。
     */
    case 'combatLossTaker': {
      if (
        action.unitId !== null &&
        !w.combatLossSwapChoices.some((c) => c.unitId === action.unitId)
      )
        return false
      w.combatInputs = { ...w.combatInputs, lossTakerId: action.unitId }
      return true
    }
    case 'combatOptions': {
      const requirement = w.combatRequirement
      if (requirement === null) return false
      const attempt = (
        retreatHexes: number,
        lossPoints: number,
        ignoreOptions: boolean,
      ): boolean => {
        w.combatInputs = {
          ...w.combatInputs,
          optionRetreatHexes: retreatHexes,
          optionLossPoints: lossPoints,
          ignoreOptions,
        }
        return w.confirmCombatOptions()
      }
      if (attempt(action.retreatHexes, action.lossPoints, action.ignoreOptions)) return true
      /*
       * 9.10a：修前兜底只有「全吃」与「守方忽略」两档 —— 当损失点数超过该方可用军力（9.11）
       * 时两档都被拒，AI 每分钟几十次重试同一动作（0ms 重排），界面表现为卡死。
       * 这里按 store 的候选切分（与策略层同一份 `planOptionSplits`）补上「退 k + 吃 N-k」。
       */
      for (const split of w.combatOptionAttempts) {
        if (split.retreatHexes === action.retreatHexes && split.lossPoints === action.lossPoints)
          continue
        if (attempt(split.retreatHexes, split.lossPoints, false)) return true
      }
      if (attempt(0, requirement.options, false)) return true
      if (requirement.side === 'defender' && attempt(requirement.options, 0, true)) return true
      return false
    }
    case 'combatRetreatPaths': {
      const retreatPaths = { ...w.combatInputs.retreatPaths }
      for (const entry of action.paths) retreatPaths[entry.unitId] = formatHexPath(entry.path)
      w.combatInputs = { ...w.combatInputs, retreatPaths }
      return w.confirmCombatRetreats()
    }
    case 'combatAdvance':
      return w.confirmCombatAdvance()
    case 'combatSkip':
      if (w.battleTarget !== null) memory.combatHexes.push(hexKeyOf(w.battleTarget.hex))
      w.cancelCombat()
      return true
    case 'supplyPlan':
      return w.planSupplyPhaseNow()
    case 'supplyRecovery':
      return w.applySupplyPhaseRecoveryNow()
    case 'supplyFeeding':
      return w.applySupplyPhaseFeedingNow()
    case 'attritionRoll':
      return w.rollAttritionNow(action.key)
    case 'attritionApply': {
      for (const entry of action.allocation)
        w.setAttritionAllocation(action.key, entry.unitId, entry.steps)
      return w.applyAttritionNow(action.key)
    }
    case 'none':
      return false
  }
}

/**
 * 外部策略：**只**把快照翻成一个动作
 *
 * 契约：不掷骰、不改盘面、不预判规则；结构非法/抛异常由驱动回退脚本策略。
 */
export type AiDecider = (snapshot: AiSnapshot) => AiAction

export interface AiStepOptions {
  memory?: AiMemory
  control?: AiControlMode
  decider?: AiDecider
  onStep?: (record: AiStepRecord) => void
}

/**
 * 单步记录（`onStep` 的回调载荷）
 *
 * ★ 与 `runAiStep` 一一对应：等待玩家时也会回调（`ok:false` + `reason`），便于采集器画轨迹边界。
 */
function stepRecordOf(
  snapshot: AiSnapshot,
  side: AiSide,
  action: AiAction,
  outcome: { ok: boolean; rule?: string; reason?: string; terminal: boolean; fellBack: boolean },
): AiStepRecord {
  return {
    turn: snapshot.turn,
    phase: snapshot.phase,
    segment: snapshot.segment,
    step: snapshot.segment,
    side,
    intent: actionKeyOf(action),
    act: action,
    obs: snapshot,
    ok: outcome.ok,
    ...(outcome.rule === undefined ? {} : { rule: outcome.rule }),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    terminal: outcome.terminal,
    ...(outcome.fellBack ? { fellBack: true } : {}),
  }
}

export function runAiStep(ctx: AiContext, options?: AiStepOptions): AiStepResult {
  const memory = options?.memory ?? createAiMemory()
  const control = options?.control ?? 'both'
  const w = ctx.workbench
  const snapshot = snapshotOf(ctx, memory, control)

  /*
   * 外部策略（可选）：先拿脚本策略兜底，再尝试外部动作。
   * 只有**结构**非法才回退（`isAiAction`）；参数是否合规一律交给 store 入口判（唯一判据原则），
   * 入口拒绝照旧记进 `refusedByRule`，不在这里预筛。
   */
  let action = decideAiAction(snapshot)
  let fellBack = false
  if (options?.decider !== undefined) {
    try {
      const picked: unknown = options.decider(snapshot)
      if (isAiAction(picked)) action = picked
      else fellBack = true
    } catch {
      fellBack = true
    }
  }

  // B4：玩家控制的一方有待办 ⇒ 不提交任何动作，只回报等待文案
  if (action.kind === 'wait') {
    const waiting = action.reason
    options?.onStep?.(
      stepRecordOf(snapshot, sideOf(w), action, {
        ok: false,
        reason: waiting,
        terminal: ctx.session.terminated,
        fellBack,
      }),
    )
    return {
      turn: snapshot.turn,
      phase: snapshot.phase,
      segment: snapshot.segment,
      side: sideOf(w),
      intent: 'wait',
      ok: false,
      reason: waiting,
      waiting,
      ...(fellBack ? { fellBack: true } : {}),
    }
  }

  /*
   * 诊断：`pushLog` 用 `unshift` 且把 `log` 截到 60 条（workbench.ts:4968-4975），
   * 满 60 后长度不再增长 ⇒ 用「执行前后的长度差」取新增日志会在整局后段恒为空，
   * 拒绝原因随之退化成 `unknown`。改为按**栈顶 id** 取边界：新条目都在旧栈顶之上。
   */
  const topBefore = w.log[0]?.id ?? null
  const presetSide: AiSide | null = control === 'both' || control === 'off' ? null : control
  const ok = execute(action, ctx, memory, presetSide)
  const added =
    topBefore === null
      ? [...w.log]
      : w.log.slice(
          0,
          Math.max(
            0,
            w.log.findIndex((entry) => entry.id === topBefore),
          ),
        )
  /*
   * 取「本次提交最早一条带 rule 的新增日志」：日志是 `unshift`（新在前），故从尾部回溯。
   * 驱动自身的收尾日志（如 `combatSupply` 失败后补 `cancelCombat`）会盖在最上面，
   * 用最新的那条会把真实拒绝原因遮成「放弃本场战斗（9.2）」。
   */
  let failureEntry: (typeof w.log)[number] | undefined
  for (let index = added.length - 1; index >= 0; index -= 1) {
    const entry = added[index]!
    if (typeof entry.rule === 'string') {
      failureEntry = entry
      break
    }
  }
  failureEntry ??= added[added.length - 1]
  const rule = ok ? undefined : (failureEntry?.rule ?? ruleFromStores(w) ?? 'unknown')
  const reason = ok ? undefined : (failureEntry?.text ?? `提交被拒：${action.kind}`)

  options?.onStep?.(
    stepRecordOf(snapshot, sideOf(w), action, {
      ok,
      rule,
      reason,
      terminal: ctx.session.terminated,
      fellBack,
    }),
  )

  return {
    turn: snapshot.turn,
    phase: snapshot.phase,
    segment: snapshot.segment,
    side: sideOf(w),
    intent: actionKeyOf(action),
    ok,
    rule,
    reason,
    ...(fellBack ? { fellBack: true } : {}),
  }
}

/**
 * 双 AI 自对打：同一进程内驱动到 `targetTurns`（或会话正常终止）。
 *
 * 死锁判据：`turn|phase|activeSide|segmentStepIndex` + awaiting + 已落盘损耗数
 * 与**同一条决策**连续 3 次无进展 ⇒ 记录 stall 并停止。
 */
export async function runAiSelfPlay(options: AiSelfPlayOptions): Promise<AiSelfPlayReport> {
  const { ctx } = options
  const w = ctx.workbench
  const memory = options.memory ?? createAiMemory()
  const control = options.control ?? 'both'
  const limit = options.limit ?? 12000
  const targetTurn = w.turn + options.targetTurns
  const stalls: string[] = []
  const refused: AiRefusal[] = []
  const refusedByRule: Record<string, number> = {}
  const warnings: string[] = []
  const rules: string[] = []
  let waiting: string | undefined
  let noLegal = 0
  let aiIllegal = 0
  let iterations = 0
  let lastToken = ''
  let lastDecision = ''
  let sameState = 0
  /** 上一步的日志栈顶 id：日志是 `unshift` 且截到 60 条，按 id 取边界才不会漏记 */
  let lastTopId = w.log[0]?.id ?? null

  // 到达目标回合时若还挂着盘面提问（回合开始的天气/先手等），先把它答完再收尾——
  // 否则报告会停在「有未处理 awaiting」的状态，而这并非 AI 漏判。
  while (
    !ctx.session.terminated &&
    (w.turn < targetTurn || ctx.session.awaiting) &&
    iterations < limit
  ) {
    const result = runAiStep(ctx, {
      memory,
      control,
      ...(options.decider === undefined ? {} : { decider: options.decider }),
      ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
    })
    iterations += 1
    if (result.fellBack === true) aiIllegal += 1

    // B4：单侧控制时遇到玩家待办 ⇒ 停下（不是 stall，也不是拒绝）
    if (result.intent === 'wait') {
      waiting = result.waiting ?? result.reason ?? ''
      break
    }

    const fresh: typeof w.log = []
    for (const entry of w.log) {
      if (entry.id === lastTopId) break
      fresh.push(entry)
    }
    lastTopId = w.log[0]?.id ?? null
    for (const entry of fresh) {
      if (entry.kind === 'warning' || entry.kind === 'danger') warnings.push(entry.text)
      if (typeof entry.rule === 'string')
        for (const rule of entry.rule.split(' / '))
          if (rule !== '' && !rules.includes(rule)) rules.push(rule)
    }

    if (!result.ok) {
      const rule = result.rule ?? 'unknown'
      refused.push({
        turn: result.turn,
        phase: result.phase,
        segment: result.segment,
        side: result.side,
        intent: result.intent,
        rule,
        reason: result.reason ?? '',
      })
      refusedByRule[rule] = (refusedByRule[rule] ?? 0) + 1
    }

    if (result.intent === 'none') noLegal += 1

    const token = `${String(w.turn)}|${String(w.phase)}|${String(w.activeSide)}|${String(w.segmentStepIndex)}|${String(
      ctx.session.awaiting,
    )}|${String(w.attritionAppliedHexes.length)}`
    if (token === lastToken && result.intent === lastDecision) sameState += 1
    else {
      sameState = 1
      lastToken = token
      lastDecision = result.intent
    }
    if (sameState >= 3) {
      const latest = w.log[0]?.text ?? ''
      stalls.push(
        `剧本 ${options.scenarioId ?? '?'} 回合 ${String(w.turn)} 阶段 ${w.phase} 环节 ${w.segmentStep?.id ?? ''} ` +
          `决策 ${result.intent} 连续 3 次无进展；rule=${result.rule ?? 'unknown'} reason=${result.reason ?? ''} 最近日志=${latest}`,
      )
      break
    }

    if (noLegal >= 3) {
      stalls.push(
        `剧本 ${options.scenarioId ?? '?'} 回合 ${String(w.turn)} 阶段 ${w.phase} 环节 ${w.segmentStep?.id ?? ''} ` +
          `noLegal 连续 ${String(noLegal)} 次：视图无可提交动作且无法推进/无待答`,
      )
      break
    }

    await nextTick()
  }

  return {
    scenarioId: options.scenarioId,
    turn: w.turn,
    phase: w.phase,
    segment: w.segmentStep?.id ?? '',
    activeSide: w.activeSide as AiSide,
    targetTurn,
    reachedTarget: w.turn >= targetTurn,
    terminated: ctx.session.terminated,
    iterations,
    stalls,
    refused,
    refusedByRule,
    rules,
    warnings,
    noLegal,
    aiIllegal,
    awaiting: ctx.session.awaiting,
    waiting,
  }
}
