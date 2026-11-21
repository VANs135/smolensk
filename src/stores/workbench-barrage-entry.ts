/**
 * C7/C9 入口判据与候选集合（炮击 10.1a/10.1b、空军轰炸 10.2b/10.2c、低空扫射 14.7d）
 *
 * 从 `workbench.ts` 的「三操作统一流程」整段搬出（B3-2b23）：9 个声明 / 183 行，函数体只做
 * deps 前缀改写（6 个晚声明必须晚绑定，见下），其余逐字不动。
 * 端口 31 项 = 22 依赖（16 按值 + 6 晚绑定 getter）+ 9 返回。
 * 六个 getter 对应的声明都在本段之后（`segmentGateQuery` / `barrageKindsInSegment` / `actionRefusal` /
 * `scenarioId` / `airMissionSegmentKind` / `airMissionKindChoices`），只在函数被调用时求值，故无 TDZ。
 */
import { computed } from 'vue'
import type { HexRef, Side } from '@/data'
import { hexDistance } from '@/engine/hex-geometry'
import {
  barrageTableMeta,
  barrageTableWithScenarioRule,
  canBarrageAtRange,
  canFlyMission,
  canHipShoot,
  canPerformMissionThisPhase,
  holdingsToT,
} from '@/engine/rules'
import type {
  AirInteractionState,
  AirMissionKind,
  AirMissionSegment,
  BarrageKind,
  BarrageTargetKind,
} from '@/engine/rules'
import {
  isBarrageCapableUnit,
  isGroundBarrageEligible,
  isInReserveOrStrat,
} from './workbench-model'
import type { ActionGateQuery, ActionKey } from './workbench-model'
import type { AirInputs, ConsoleAirUnit, ConsoleUnit, ConsolePhase } from './workbench-model'

export interface BarrageEntryDeps {
  activeSide: { value: Side }
  units: { readonly value: readonly ConsoleUnit[] }
  phase: { value: ConsolePhase }
  airState: { value: AirInteractionState | null }
  airInputs: { value: AirInputs }
  airActingSide: { value: Side }
  ownAirUnits: { readonly value: readonly ConsoleAirUnit[] }
  airDistanceFromRealBase: (air: ConsoleAirUnit, hex: HexRef) => number
  barrageState: { readonly value: { finished: boolean } | null }
  barragedHexesThisPhase: { readonly value: readonly string[] }
  barragedUnitIdsThisPhase: { readonly value: readonly string[] }
  canReplaceBarrage: () => boolean
  actionAllowedNow: (key: ActionKey) => boolean
  hexLabel: (hex: HexRef) => string
  barrageFacts: { readonly value: { hasSpotter(hex: HexRef): boolean } }
  airMissionAllowedInPhase: { readonly value: boolean }
  defaultBarrageTargetKindAt: (hex: HexRef) => BarrageTargetKind
  deliverableDumpsFor: (
    side: Side,
    candidates: readonly ConsoleUnit[],
  ) => readonly { sp: number; t: number }[]
  /** 环节闸查询（声明晚于本切片建域点 ⇒ 晚绑定） */
  get segmentGateQuery(): { readonly value: ActionGateQuery }
  /** 本环节允许的轰炸种类（同上） */
  get barrageKindsInSegment(): { readonly value: readonly BarrageKind[] }
  /** 地图内拒绝提示行（同上） */
  get actionRefusal(): { value: { key: ActionKey; rule: string; reason: string } | null }
  /** 剧本 id（同上） */
  get scenarioId(): { readonly value: string }
  /** 本环节的空军任务段（同上） */
  get airMissionSegmentKind(): { readonly value: AirMissionSegment | null }
  /** 可宣布的任务类型（同上） */
  get airMissionKindChoices(): { readonly value: readonly { key: AirMissionKind; label: string }[] }
}

export function createBarrageEntryDomain(deps: BarrageEntryDeps) {
  const {
    activeSide,
    units,
    phase,
    airState,
    airInputs,
    airActingSide,
    ownAirUnits,
    airDistanceFromRealBase,
    barrageState,
    barragedHexesThisPhase,
    barragedUnitIdsThisPhase,
    canReplaceBarrage,
    actionAllowedNow,
    hexLabel,
    barrageFacts,
    airMissionAllowedInPhase,
    defaultBarrageTargetKindAt,
    deliverableDumpsFor,
  } = deps

  /**
   * 10.1a：**能打到这一格**的炮兵（射程内、可轰炸、非预备/战略）
   *
   * 规格 §3 的硬要求：右键入口「该项是否出现」与窗内候选必须来自**同一个**筛选函数。
   * 13.4a 的预备/战略模式不参炸 ⇒ 直接从候选里剔除（不摆灰项）。
   */
  function barrageCandidatesAt(hex: HexRef): ConsoleUnit[] {
    const side = deps.segmentGateQuery.value.side ?? activeSide.value
    return units.value.filter(
      (unit) =>
        unit.side === side &&
        isBarrageCapableUnit(unit) &&
        !isInReserveOrStrat(unit) &&
        // 2.2：反应 / 进击的射击只认已释放的预备（原文见 `isGroundBarrageEligible`）
        isGroundBarrageEligible(phase.value, unit) &&
        unit.raw.range !== undefined &&
        canBarrageAtRange({
          rangeHexes: unit.raw.range,
          distanceHexes: hexDistance(unit.hex, hex),
        }),
    )
  }

  /** 10.2b：能对该格执行**空军轰炸**的飞机（可出动、未出任务、航程够、有印值） */
  function bombingCandidatesAt(hex: HexRef): ConsoleAirUnit[] {
    return ownAirUnits.value.filter(
      (air) =>
        (air.barrageStrength ?? 0) > 0 &&
        canFlyMission(air.airStatus) &&
        canPerformMissionThisPhase(air.missionsFlownThisPhase) &&
        airDistanceFromRealBase(air, hex) <= air.rangeHexes,
    )
  }

  /** 14.7d-B：能对该格**低空扫射**的飞机（单机上限在宣布时由引擎判） */
  function hipShootCandidatesAt(hex: HexRef): ConsoleAirUnit[] {
    if (!canHipShoot(airActingSide.value, airInputs.value.weatherNormal)) return []
    return ownAirUnits.value.filter(
      (air) =>
        air.canHipShoot &&
        canFlyMission(air.airStatus) &&
        canPerformMissionThisPhase(air.missionsFlownThisPhase) &&
        airDistanceFromRealBase(air, hex) <= air.rangeHexes,
    )
  }

  /**
   * 10.1b + 10.0e：**炮击**这一项该不该出现在右键菜单里
   *
   * 判据全部取既有入口/事实，不新写规则：
   *   · 环节闸 `barrage.declare`（10.0 第二段）；
   *   · 10.0e-A 该格本阶段未炸过；10.0e-B 有未炸过的炮兵；
   *   · 10.1a 至少一门炮射程覆盖目标格（`barrageCandidatesAt`，与窗内同源）；
   *   · 10.1b **付得起**：初始列成本 ≤ 可达补给来源里最大的一份（付不起 ⇒ 项缺席，不灰显）。
   */
  function barrageEntryEligible(hex: HexRef): boolean {
    if (!actionAllowedNow('barrage.declare')) return false
    /*
     * 10.0e-D / 10.0 第二段：**炮击入口只在本环节允许炮兵轰炸时出现**。
     *
     * `barrage.declare` 的闸门在移动环节也会放行——那是给「低空扫射的空军」（14.7d）开的口子，
     * 不是给火炮的；移动环节的火炮进不了任何轰炸流程。修前这里只看闸门，移动环节右键敌方
     * 就会冒出「炮击」三步骤、点进去走不通（用户 #11）。
     */
    if (!deps.barrageKindsInSegment.value.includes('artillery')) return false
    if (!canReplaceBarrage()) return false
    if (barrageState.value !== null && !barrageState.value.finished) return false
    if (barragedHexesThisPhase.value.includes(hexLabel(hex))) return false
    const candidates = barrageCandidatesAt(hex).filter(
      (unit) => !barragedUnitIdsThisPhase.value.includes(unit.instanceId),
    )
    if (candidates.length === 0) return false
    const total = candidates.reduce((sum, unit) => sum + (unit.raw.barrage ?? 0), 0)
    if (total < 1) return false
    // 10.0d / 10.0c：整体目标决定用哪张表（成本取该表的初始列）
    const target = defaultBarrageTargetKindAt(hex)
    const side = deps.segmentGateQuery.value.side ?? activeSide.value
    /*
     * 剧本级炮击折扣（10.1b；Intro: Vitebsk 德军 −2T）必须与 `beginBarrage` 同口径：
     * 只在这里用原价判“付得起”会把折后 0T 的炮击误判成付不起，连右键「炮击」入口都不出现。
     */
    const cost = barrageTableWithScenarioRule(barrageTableMeta({ target, valueRange: total }), {
      scenarioId: deps.scenarioId.value,
      side,
    }).costT
    if (cost <= 0) return true
    const dumps = deliverableDumpsFor(side, candidates)
    return dumps.some((dump) => holdingsToT({ sp: dump.sp, t: dump.t }) >= cost)
  }

  /**
   * 右键敌方却看不到「炮击」时，**具体卡在哪条规则**（只在炮击环节、且该格确有敌方地面战斗单位时给）
   *
   * 用户 2026-11-16：DG 目标本身不挡炮击（10.0a「对敌方战斗单位进行轰炸」；5.10a「已经处于
   * DG 模式的单位不会承受额外的效果」——`不会额外 DG`不等于`不能作为目标`）。
   * 真正会让菜单项不出现的是：10.0e-A 同格本阶段已炸、10.0e-B 本阶段已射击、10.0e-D 不在
   * 炮击环节、10.0e-C 火力不足、10.1b 付不起。菜单项按口径「不可用不出现」，所以这里把原因
   * 交给地图内提示行，避免玩家把「没有炮击项」误判成「DG 单位不能打」。
   */
  function barrageEntryBlockReason(hex: HexRef): { rule: string; reason: string } | null {
    if (!actionAllowedNow('barrage.declare')) return null
    const side = deps.segmentGateQuery.value.side ?? activeSide.value
    const hasEnemyCombat = units.value.some(
      (unit) =>
        unit.side !== side && unit.isCombat && unit.hex.col === hex.col && unit.hex.row === hex.row,
    )
    if (!hasEnemyCombat) return null
    if (barrageEntryEligible(hex)) return null
    if (!deps.barrageKindsInSegment.value.includes('artillery')) {
      return { rule: '10.0e-D', reason: '本环节不允许火炮轰炸（火炮只在炮击环节）' }
    }
    if (!canReplaceBarrage() || (barrageState.value !== null && !barrageState.value.finished)) {
      return { rule: '10.0e', reason: '已有一单炮击在流程中，先完成或取消' }
    }
    if (barragedHexesThisPhase.value.includes(hexLabel(hex))) {
      return { rule: '10.0e-A', reason: '该格本阶段已被炮击过一次（同一格每阶段只能炸一次）' }
    }
    const candidates = barrageCandidatesAt(hex).filter(
      (unit) => !barragedUnitIdsThisPhase.value.includes(unit.instanceId),
    )
    if (candidates.length === 0) {
      return { rule: '10.0e-B', reason: '射程内没有可用的炮击单位（或本阶段已射击过）' }
    }
    const total = candidates.reduce((sum, unit) => sum + (unit.raw.barrage ?? 0), 0)
    if (total < 1) return { rule: '10.0e-C', reason: '参炸炮兵合计不足 1 点轰炸值' }
    return { rule: '10.1b', reason: '没有付得起这记炮击的补给站（每点至少 1T）' }
  }

  /** 把「炮击项为何缺席」写进地图内提示行（`actionRefusal` 通道，下一次动作/换段即清） */
  function noteBarrageBlocked(reason: { rule: string; reason: string }): void {
    deps.actionRefusal.value = { key: 'barrage.declare', rule: reason.rule, reason: reason.reason }
  }

  /** 10.2c + 10.0e：**轰炸**这一项该不该出现（空军轰炸免补给 ⇒ 不判 10.1b） */
  function bombingEntryEligible(hex: HexRef): boolean {
    if (!actionAllowedNow('air.mission')) return false
    if (!airMissionAllowedInPhase.value) return false
    if (!deps.airMissionKindChoices.value.some((item) => item.key === 'barrage')) return false
    if (airState.value !== null && !airState.value.finished) return false
    if (barragedHexesThisPhase.value.includes(hexLabel(hex))) return false
    return bombingCandidatesAt(hex).length > 0
  }

  /**
   * 本环节**任意一个可宣布轰炸的敌方格**（供提示层与右键入口同源联动）
   *
   * 2026-11-14 E 段实点：hint 曾承诺「右键敌方格选轰炸」，但判据不成立时右键既无菜单
   * 也无反馈。提示层复用同一组 `barrageEntryEligible` / `bombingEntryEligible`；
   * 没有目标就**不教这一步**（7.0b / 10.0d）。
   */
  const barrageTargetsNow = computed<HexRef[]>(() => {
    const side = deps.segmentGateQuery.value.side ?? activeSide.value
    const seen = new Set<string>()
    const out: HexRef[] = []
    for (const unit of units.value) {
      if (unit.side === side) continue
      const key = hexLabel(unit.hex)
      if (seen.has(key)) continue
      seen.add(key)
      if (barrageEntryEligible(unit.hex) || bombingEntryEligible(unit.hex)) out.push(unit.hex)
    }
    return out
  })

  /**
   * 14.7d + 10.0b：**右键敌方算子 ⇒「低空扫射」**的入口判据（用户 2026-11-09 口径）
   *
   * 只回答"这一格现在值不值得出现这个菜单项"，全部复用既有谓词，不在组件里写规则：
   *   · 环节闸 `actionAllowedNow('air.mission')`（14.2e：低空扫射在移动环节）；
   *   · 阵营/天气 `canHipShoot`（专规 2.2a 苏军不得、3.2a 轴方须天气允许）；
   *   · 观察员 `barrageFacts.hasSpotter`（10.0b 低空扫射必需正确观察员）；
   *   · 至少一架**具备低空扫射能力**且航程够得到的己方飞机（14.1a 须激活）。
   * 缺任何一条 ⇒ 菜单项**不出现**（不灰按钮）。任务已在跑时不覆盖（14.2f）。
   */
  function hipShootEntryEligible(hex: HexRef): boolean {
    // 14.2e：低空扫射属**移动环节**；轰炸环节即使闸门开着也不出这一项
    if (deps.airMissionSegmentKind.value !== 'movementSegment') return false
    if (!actionAllowedNow('air.mission')) return false
    if (airState.value !== null && !airState.value.finished) return false
    if (!canHipShoot(airActingSide.value, airInputs.value.weatherNormal)) return false
    if (!barrageFacts.value.hasSpotter(hex)) return false
    return hipShootCandidatesAt(hex).length > 0
  }

  return {
    barrageCandidatesAt,
    bombingCandidatesAt,
    hipShootCandidatesAt,
    barrageEntryEligible,
    barrageEntryBlockReason,
    noteBarrageBlocked,
    bombingEntryEligible,
    barrageTargetsNow,
    hipShootEntryEligible,
  }
}
