import { createGroundMovementDomain } from './ground-movement'
import { hasUnitMovementThisPhase } from '@/engine/rules/air-unit-movement'
import { isSpBearingSource } from '@/engine/rules/supply-interaction'
import type { MoveStepSnapshot } from './movement-types'
import { tutorialFixedReinforcement, tutorialSovietFirstTurnFullMa } from './tutorial-settings'
import { inEnemyZocForAction } from '@/engine/rules/move'
import { ruleErrorTextOf } from '@/engine/rules/rule-error-text'
import { createFireResolutionDomain } from './fire-resolution'
import { createBarrageDomain } from './workbench-barrage'
import { createAirDomain } from './workbench-air'
import { createMovementDomain } from './workbench-move'
import { createStackPickDomain } from './workbench-stack-pick'
import { createFuelDomain } from './workbench-fuel'
import { createCombatOptionsDomain } from './workbench-combat-options'
import { createCombatSettleDomain } from './workbench-combat-settle'
import { createCombatIgnoreDomain } from './workbench-combat-ignore'
import { createCombatAdvanceDomain } from './workbench-combat-advance'
import { createSupplyDumpsDomain } from './workbench-supply-dumps'
import { createTransportPointsDomain } from './workbench-transport-points'
import { createExtendersDomain } from './workbench-extenders'
import { createHedgehogsDomain } from './workbench-hedgehogs'
import { createConstructionDomain } from './workbench-construction'
import { createAirFacilityDomain } from './workbench-air-facility'
import { createSupplyLabelsDomain } from './workbench-supply-labels'
import { createAirPrimitivesDomain } from './workbench-air-primitives'
import { createAirStateDomain } from './workbench-air-state'
import { createCombatInputs } from './engagement-inputs'
import { defineStore } from 'pinia'
import { computed, ref, toRaw, watch, type Ref } from 'vue'

import type { HexRef, MarkerSide, RailGauge, Side } from '@/data'
import {
  DATA_VERSION,
  mapConfig,
  mapLayers,
  markers,
  rulesConstants,
  scenarios,
  unitsAxis,
} from '@/data'
import {
  HEX_DIRECTIONS,
  allMapHexes,
  areAdjacent,
  hexDistance,
  isNorthEdge,
  isSouthEdge,
  neighbor,
  neighbors,
  sameHex,
} from '@/engine/hex-geometry'
import { DERIVATION_KEY, type Derivation } from '@/engine/derivation'
import { combatDerivation, surpriseDerivation } from '@/engine/derivation-builders'
import { createRngState, RNG_ALGORITHM, roll1d6, roll2d6 } from '@/engine/rng'
import { validBoardEntities } from '@/engine/board-validation'
import { actingSideFor } from '@/engine/game-lifecycle'
import { createSnapshotRegistry } from './snapshot-registry'
// B0（解构第一批）：日志与结算账本的实现搬到 workbench-core，facade 只留薄转发
import { createWorkbenchCore, type SettlementRecordInput } from './workbench-core'
// B0（解构第二批）：环节闸门搬到 workbench-gates，facade 只留同名转发
import { createWorkbenchGates } from './workbench-gates'
import { createPhaseCoordinator } from './phase-coordinator'
import { createSupplyPhaseDomain } from './supply-phase'
import type { SpDump } from './supply-types'
// B37：分界线的渲染投影类型（渲染层只画被给的东西）
import type { BoundaryLine } from '@/render/map-render'
import { battleArOf, createRailFacts, createTraceSupplyAt, setupEntryViews } from '@/engine/rules'
import { entryEdgeHexes } from '@/engine/rules/entry-edges'
import { buildUnitSelectionSet, type UnitSelectionSet } from '@/engine/rules/unit-selection'
// B8：环节链（当前环节由本文件的 `segmentStep` 从这张表推出）
import {
  isSpecialReplAvailable,
  reinforcementSegmentOf,
  reinforcementSegmentsOf,
  sopStepsOf,
  type ReinforcementSegment,
  type SopSegmentStep,
} from '@/engine/rules'
import { fail, type RuleFailure, type RuleOutcome } from '@/engine/result-types'
import type {
  DiceRoll,
  GamePhase,
  Marker,
  RngState,
  VictoryLocationState,
} from '@/engine/state-types'
import {
  BARRAGE_SOURCES_BY_PHASE,
  DIRECT_DRAW_RANGE_MP,
  SP_TO_T,
  airBoxEdgeColumn,
  claimFrontalReserves,
  frontalReservesBatch,
  PANZER_GROUP_CONSTRAINT_END,
  checkPanzerGroupSpBeneficiaries,
  normalizeSupplyDumps,
  remapSupplyDumpAmounts,
  panzerGroupRulesActive,
  PANZER_GROUP_OPTION_ITEM,
  isVariableExitActive,
  VARIABLE_EXIT_START,
  rollVariableExit,
  variableExitFormationOf,
  type VariableExitResult,
  activeAircraftInBase,
  activeStackingLimitOf,
  allocateBattleLosses,
  barrageStepChecklist,
  barrageTableMeta,
  barrageTableWithScenarioRule,
  barrageTerrainLines,
  beginCombat,
  beginSupplyCheck,
  canFlyMission,
  canHipShoot,
  canMissionInPhase,
  canJoinRetreat,
  canAddAircraftAtStep,
  canJoinMission,
  canPerformMissionThisPhase,
  canVoluntarilyReturn,
  missionSegmentOf,
  nkvdArRequired,
  splitOverrunStack,
  canDrawFromCarrier,
  canBreakout,
  resolveBreakout,
  createMapFacts,
  createMultiTrackRailFacts,
  panzerGroupBoundaryPath,
  inEnemyZocAt,
  isOutOfSupplyNow,
  selectMovementTerrain,
  buildStepFacts,
  type MoveContext,
  type MoveStepFacts,
  type BreakoutConditions,
  type BreakoutEligibility,
  type BreakoutPathFacts,
  checkDefenderArChoice,
  checkLegality,
  chooseSupplySource,
  isSavableRepl,
  clearReleasedFromReserve,
  computeCombatSupplyCost,
  computeFuelCost,
  canAttemptDumpDestruction,
  dumpDestructionPercent,
  needsFuelToMove,
  planDumpDestruction,
  confirmOosResolution,
  confirmSupplyPickup,
  countSupplyDistanceToUnitViaTable,
  currentResolver,
  declareCombatAr,
  declareCombatTerrain,
  declareInterceptionStep,
  describeCost,
  drawableDumpsFor,
  endMoveEarly,
  evaluateStep,
  evaluateStepFrom,
  findMoveUnit,
  fuelExpiresOnPhaseChange,
  getPrintedHedgehog,
  holdingsToT,
  formationTraceTradeoff,
  insidePlayArea,
  isEnemySafeEdgeHex,
  isFacilityBarrage,
  isLegal,
  isNkvdBorderRegiment,
  liveRetreatSides,
  lossesOf,
  markersAfterDg,
  needsRetreat,
  nkvdDefenderOptionOverride,
  optionsOf,
  arrivalCopiesOf,
  arrivalComponentNames,
  arrivalNamedCopiesOf,
  planArrivals,
  breakdownAbsorbObligations,
  planBreakdownAbsorb,
  planBreakdownCreate,
  planCombatSupply,
  planCombatSupplyFunding,
  planDefenderCombatSupplyFunding,
  planConsolidation,
  planLosses,
  planRebuild,
  type RebuildRequest,
  planRetreatDestinations,
  planSlowMobilization,
  slowMobilizationQuotaRemaining,
  type SlowMobilizationArmy,
  planSpPayment,
  planTransportSplit,
  tToHoldings,
  planVariableReinforcement,
  planStep,
  previewStep,
  engineerCapableHqAt,
  railSupplyPath,
  reachableForMove,
  reachableNodeAt,
  resolveAdvance,
  arrivalPlacementCandidates,
  arrivalPlacementAirBox,
  airBaseAt,
  resolveArrivalPlacement,
  entryClosedForAllSides,
  resolveInterception,
  resolveRetreats,
  resolveSpecialCombat,
  stepChecklist,
  supplyCoverage,
  supplyStepChecklist,
  suggestRebuildRow,
  transportDisplacementCandidates,
  transportGroupOf,
  validateGaugeConversion,
  validateRailMovement,
  validateTransportPointLoad,
  validateTransportPointUnload,
  convertedRailRun,
  deriveRailheads,
  addSupplyCache,
  allVictoryConditionHexes,
  breakdownPoolTotal,
  checkRedAirForceMission,
  checkSecurityNeeds,
  cleanupPatchById,
  dividingLineObligations,
  checkTurnEndVictory,
  checkTurnStartVictory,
  controlOfHex,
  evaluateFinalVictory,
  exclusiveTimingCalendar,
  initialSupplyCacheHoldings,
  isCleanUpNoop,
  isScenarioFinalTurn,
  listedVictoryHexes,
  planCleanUp,
  planConstructionMarkerUse,
  isConstructionMarkerDestroyed,
  planFreeRailArrivals,
  railCapacitiesOn,
  removalAllowedNow,
  removalReasonOf,
  requiresTraceSupply,
  railEntrySupplySources,
  scenarioTurnRange,
  splitSupplyTableSp,
  summarizeVictoryControl,
  supplySourceStatuses,
  timingsOn,
  traceCoverageHas,
  traceCoverageHexes,
  type AirCombatWindow,
  type AirMissionSegment,
  type AirMissionKind,
  type AirMissionPhase,
  type ArrivalPlacementFacts,
  type ArrivalPlacementResult,
  type ArrivalPlan,
  type ArrivalUnitDemand,
  type BarrageKind,
  type BarrageTargetKind,
  type BarrageUnitPatch,
  type BaseMode,
  type BaseSourceKind,
  type BattleUnitView,
  type BreakdownCreateTiming,
  type CombatStep,
  type CombatInteractionState,
  type CombatLine,
  type CombatRole,
  type CombatUnitPatch,
  type ConsolidationPlan,
  type FacilityPatch,
  type FreeRailCandidate,
  type FreeRailPlan,
  type FuelMethod,
  type FrontalReservesBatch,
  type DrawableDump,
  type SupplyMobility,
  type GroupReachable,
  type LegalityVerdict,
  type MoveStepRecord,
  type MoveInteractionState,
  type MoveUnitRuntime,
  type OverrunMovePlan,
  type MovementSegmentPhase,
  type OosAction,
  type RebuildPlan,
  type RailCargoView,
  type ReplHoldings,
  type RetreatDestinationPlan,
  type RetreatFacts,
  type SpHoldings,
  type StepFailure,
  type SpecialObjectView,
  type StackTerrainChoice,
  type StepPreview,
  type SupplyInteractionState,
  type SupplyPurpose,
  type SupplyReachableHex,
  type SupplySourceOption,
  type TransportPointActor,
  type VariableReinforcementPlan,
  type DividingLineObligation,
  type ExclusiveTimingEntry,
  type PanzerGroup,
  type PanzerGroupSpPurpose,
  type PanzerGroupBoundary,
  type PanzerGroupUnitView,
  type RedAirForceCheckResult,
  type SecurityCheckCityView,
  type SecurityNeedsResult,
  type TrainbustingRemovalReason,
  type SupplyCacheHoldings,
  type SupplyShutdownFacts,
  type SupplySourceStatus,
  type TrainbustingMarkerView,
  type ScenarioTurnRange,
  type VictoryAssessment,
  type VictoryControlLookup,
  type VictoryControlSummary,
  applyOverrunMove,
  OVERRUN_COST_MP,
  overrunEligibility,
  planOverrunMove,
  resolveOverrunAftermath,
  canBarrageAtRange,
  allowReserveEntryAtHex,
  hasMarker,
  hasDirectDrawTraceSupply,
  reserveHexesInUse,
  FIRST_TURN_HALF_MA_MULT,
  SHORT_RANGE_BARRAGE_HEXES,
  stackingObligations,
  STACKING_LIMIT_RE,
  type UnitSupplyAssessment,
} from '@/engine/rules'
import { createGameSeed, createId } from '@/shared'

import { opponentOf } from '@/engine/turn-driver'

import { useGameSessionStore, type AdvanceOutcome as SessionAdvanceOutcome } from './session'
import { useRecorderStore, type RecorderEventInput } from './recorder'

import {
  TURN_TRACK,
  aircraftChoices,
  attackForceForHex,
  attackersForHex,
  availableMaOf,
  bridgedHexesBySide,
  buildLegalityRequest,
  buildMoveContext,
  createBarrageFacts,
  createBattleFacts,
  createRetreatFacts,
  createSupplyFacts,
  createRailSupplyFacts,
  defaultDefenseTerrain,
  defenseTerrainChoices,
  effectiveMobilityOf,
  hedgehogLevelAt,
  hexLabel,
  hexsideTerrainNames,
  isExtenderUnit,
  isHqUnit,
  throwRangeMpOf,
  throwMobilityOf,
  isInReserveOrStrat,
  isGroundBarrageEligible,
  isRailHexAt,
  isReplUnit,
  deadPileDispositionOf,
  replRecordOf,
  type ReplKind,
  isStrategicBomberAircraft,
  modeUnitClassOf,
  parseConvertedRailRun,
  parseHexPath,
  printedHedgehogLevelAt,
  railNeighborHexes,
  railNeighborSource,
  recordNameOf,
  unitNameKey,
  unitNameTokenSet,
  resolveBattle,
  airBarrageStrengthOf,
  airCombatRatingOf,
  airPrintedStepsOf,
  needsFuelOf,
  isAirDeadPileEntry,
  toBattleUnitView,
  supplyStatusOf,
  toBreakdownSideView,
  toConsolidationGroundView,
  toConsoleAirUnit,
  toConsoleUnit,
  engineerCapableNow,
  toMoveRuntime,
  mobilityOf,
  toMoveUnitView,
  toExtenderView,
  toNkvdDefenseView,
  toThrowHqView,
  turnDateOf,
  unitChoices,
  counterImageUrlOf,
  type AircraftRecordView,
  type AirMissionJoinChoice,
  type BattleReport,
  type ConsoleAirUnit,
  type ConsoleUnit,
  type DeadPileEntry,
  type UnitRecordView,
  isBarrageCapableUnit,
  combatModeAttackBlocked,
  participatesIn,
  mapHintOf,
  type MapHint,
  actionGateOf,
  allowedActionsOf,
  segmentLabelsOfAction,
  type ActionGate,
  type ActionGateQuery,
  type ActionKey,
  type BattleTarget,
  type ConsolePhase,
  type TransportHandlingUndoEntry,
  type WorkbenchLogEntry,
  currentReOf,
  earlyRailCorridors,
  columnOneHexes,
  movementPhaseOf,
  type SpecialCombatPending,
  type SpecialTransportSplit,
  type HexPickCandidates,
  type PendingHexPick,
} from './workbench-model'
import { actionFamilyRowsAt } from './action-families'

/**
 * 骨架操作台（U0）状态
 *
 * 定位：**让引擎有可点的验证入口**——不是最终界面，但每一步都必须真实经过引擎：
 *   · 走一步 → `evaluateStep`（6.1/6.2/4.5a-A/12.5a…），显示本次 MP 消耗与拒绝原因；
 *   · 打一仗 → `roll2d6`（B2 种子化 RNG）+ `resolveCombat`（9.9），显示骰点与战果；
 *   · 每次动作前 → `checkLegality`（B21 七族前置校验），把违规/提示/义务一并列出。
 *
 * 纪律：本 store **不做规则计算**（CODE_SPEC：UI 无规则计算），只持状态、调引擎、记日志；
 * 种子与掷骰次数全部留在本 store，可复算（B2）。
 */

/*
 * P2-1（2026-11-20）：原先在这四个位置声明的 `WorkbenchLogEntry` / `ConsolePhase` /
 * `SettlementLock` / `BattleTarget` 已迁进 `workbench-model.ts`（原因：三个域切片都要用，
 * 放在 facade 会让每个切片留一条 `import type … from './workbench'` 的回边）。
 * 这里原样转出，外部 `from '@/stores/workbench'` 的导入路径不变。
 */
export type {
  BattleTarget,
  ConsolePhase,
  SettlementLock,
  WorkbenchLogEntry,
} from './workbench-model'

/** C5：一步移动的展示快照（全部来自引擎给出的步骤记录，界面不重算规则） */
export type { MoveStepSnapshot } from './movement-types'

/**
 * 2.2：**没有移动环节**的段（A 整备 / B 增援 / D 补给 / F 战斗 / H 清理）
 *
 * 「有移动环节」的段只有 C 移动 / E 反应 / G 进击（6.0/6.3a/11.0a）；
 * 其余段落到 `movementPhaseOf` 只为给引擎一个合法枚举值，移动本身由 `beginMoveFor` 拦下。
 */
const NO_MOVEMENT_PHASES: readonly ConsolePhase[] = [
  'preTurn',
  'aircraftRefit',
  'reinforcement',
  'supply',
  'combat',
  'cleanUp',
]

/**
 * 可突袭目标提示（与渲染层 `render/token-layer.ts` 的 `OverrunTargetHint` **同形**）
 *
 * 刻意用本地结构类型而不是从 render 导入：依赖方向是 `stores → engine`，
 * 状态层不该反向依赖渲染层；两侧同形由 TS 结构化类型自动对接（`MovementOverlay.overrunTargets`）。
 */
export interface WorkbenchOverrunTarget {
  hex: HexRef
  mpCost: number
  adjacentToPath: boolean
}

/**
 * W7 C16：**一名**需撤退单位的落点规划（9.12；地图优先交互）
 *
 * `destinations` 来自引擎 `planRetreatDestinations`（已在完整撤退距离上的合法落点），
 * `chosen` 是玩家当前已点选的落点（null＝未选）。
 */
export interface CombatRetreatUnitPlan {
  unitId: string
  label: string
  /** 起始格（撤退格号的起点） */
  from: HexRef
  /** 已选落点（null＝未选） */
  chosen: HexRef | null
  /** 该单位可选的落点（含路径、是否在敌方 ZOC 内、是否会被消灭） */
  destinations: RetreatDestinationPlan[]
  /**
   * 9.12 第三 bullet：排除 9.12f 不可通行格后**一个落点都没有**
   *
   * ⇒ 第 9 步不再要求点落点，确认后按「无合法落点 ⇒ 消灭」兜底（界面必须红字明示）。
   */
  noLanding?: boolean
}

/**
 * W7 C16 + 9.12d：跟随撤退者（随其同格的主撤退单位一起撤）
 *
 * 界面只做展示：路径自动沿用宿主的（9.12c「以一整个堆叠进行撤退」），故无「chosen」。
 */
export interface CombatRetreatTagalongPlan {
  unitId: string
  label: string
  /** 宿主（同格的主撤退单位） */
  hostId: string
  hostLabel: string
}

/**
 * W7 C16：**一方**的撤退落点规划（9.12c：双方各自撤自己的单位；攻方先、守方后）
 *
 * `safe` / `zoc` / `doomed` 是该方全部参与者落点的并集：界面据此在地图上分别渲染
 * 「安全撤退格」「有控制区影响的撤退格」（9.12e）与「选了会被消灭的落点」（9.12/9.12b）。
 */
export interface CombatRetreatSidePlan {
  side: CombatRole
  /** 9.12：该方需要的撤退格数（＝9.10a 选项里的撤退格数） */
  distance: number
  units: CombatRetreatUnitPlan[]
  /** 9.12d：已点选随该方撤退的跟随者 */
  tagalongs: CombatRetreatTagalongPlan[]
  /** 该方是否每个单位都已选好落点（齐了才允许确认撤退） */
  complete: boolean
  safe: HexRef[]
  zoc: HexRef[]
  /** 9.12 / 9.12b：选了会被消灭的落点（界面单独标注） */
  doomed: HexRef[]
}

/*
 * B2-2a（2026-11-20）：`SpecialTransportSplit` / `SpecialDisplacementItem` / `SpecialCombatPending`
 * 与 `movementPhaseOf` 已迁进 `workbench-model.ts`（原因同 P2-1：空军动作切片要用，留在 facade 会造回边）。
 * 这里原样转出，外部 `from '@/stores/workbench'` 的导入路径不变。
 */
export type {
  SpecialCombatPending,
  SpecialDisplacementItem,
  SpecialTransportSplit,
} from './workbench-model'
export { movementPhaseOf } from './workbench-model'

/**
 * 空军任务可发生的三个环节（14.1g：C 移动 / E 反应 / G 进击）
 *
 * 其余段（A 整备 / B 增援 / D 补给 / F 战斗 / H 清理）不会宣布空军任务，故返回 null，
 * 供专规 2.2 的阵营层预检跳过。
 */
function airMissionPhaseOf(phase: ConsolePhase): AirMissionPhase | null {
  return phase === 'movement' || phase === 'reaction' || phase === 'exploitation' ? phase : null
}

/**
 * C6：一场战斗里的玩家输入（界面 v-model 绑定）
 *
 * 纪律：本项**只承载玩家的选择**，不含任何规则结论；一切数值与可行性由引擎裁决
 * （`combat-interaction.ts` 的九步状态机）。
 */
export type { CombatInputs, BarrageInputs } from './engagement-inputs'

/** 攻守角色名（日志与提示用） */
function roleLabel(role: CombatRole): string {
  return role === 'attacker' ? '攻方' : '守方'
}

/**
 * 3.6：表 3-3 的机型名是否命中某个飞机算子
 *
 * 表里写的是**机型名**（`Bf.110`），而 `ConsoleAirUnit.aircraftType` 是 14.1 的机型代号
 * （`F` / `T` / `comb` / `Tpt`），算子 `name` 又带国别前缀（`Ge Bf.110`）⇒ 不能直接比字面。
 * 按「去前缀 + 去标点 + 全小写」后同名来判，避免写死 `Ge ` 前缀或某一方的命名习惯。
 */
function matchesEventAircraftModel(eventModel: string, airName: string): boolean {
  const normalize = (text: string): string =>
    text
      .replace(/^[A-Za-z]{2}\s+/, '')
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
  return normalize(eventModel) === normalize(airName)
}

/**
 * C8：一条 **SP 持仓**（12.1b：任何含 SP 的位置都是补给站）
 *
 * 本操作台用账本（`spDumps`）代替盘面上的 SP 算子：12.1a 的拆分/找零需要**多枚**等额算子，
 * 拼图式的算子摆放在操作台里无法表达，故以账本为唯一记账处（引擎只看持仓数值，与算子无关）。
 */
export type { SpDump } from './supply-types'

/**
 * C8：一条**基础补给源**声明（12.6a①②）
 *
 * 来源格来自**专规/剧本**（边缘铁路格、专规列出的补给源格、火车卸货格），单位库里没有该数据，
 * 故由玩家在操作台声明——不臆造。
 */
export interface SupplySourceDecl {
  id: string
  hex: HexRef
  side: Side
  kind: BaseSourceKind
}

/**
 * C8：一次补给交互里的玩家输入（界面 v-model 绑定）
 *
 * 纪律同 C6/C7：本项**只承载玩家的选择**，不含任何规则结论；来源是否可用、要付多少、
 * 能不能吃图上补给一律由引擎裁决（`supply-interaction.ts`）。
 */
export interface SupplyInputs {
  /** 12.1a：本次要拆成 T 的整 SP 数（拆分/找零） */
  spToSplit: number
  /**
   * 12.3：本次拖取/投递的 T 数
   *
   * ★ 批 B 切片 2（裁定⑤）：**只有"数量即内容"的用途才用它**（12.10 补充部队储备 / 13.8 建造费用）；
   *   燃料（12.5）/ 整备（15.1）/ 战斗（12.4）的 T 数由**费率**算（见 `supplyPickupRequirement`）。
   */
  amountT: number
  /** 12.3：用途（燃料/战斗/整备/部队储备/建造） */
  purpose: SupplyPurpose
  /** 12.3b：投递时**实际被扣 SP 的补给站**（HQ 先按 12.3a 从它拖取，再前送） */
  payFromDumpId: string | null
  /** 12.6c/d：断补处置去向 */
  oosAction: OosAction
}

/**
 * C8：本次补给交互的初始输入（数值一律由玩家填入，界面不代猜）
 *
 * ★ 批 B 切片 2：**`forImmediateUse` 这个字段已删** —— 12.3b-A「指挥部只能投递需要立即被使用的
 *   补给」是**规则强制的必答项**（裁定②：不允许预取）⇒ 由 store 恒传 `true`，
 *   不再做成面板上一个"可以取消的勾选框"（取消即被引擎拒，等于给玩家一个必然踩的坑）。
 */
function createSupplyInputs(): SupplyInputs {
  return {
    spToSplit: 0,
    amountT: 1,
    purpose: 'fuel',
    payFromDumpId: null,
    oosAction: 'eatOffTheMap',
  }
}

/** 逐机输入表：删掉某一架机的键（返航三选一切换时用） */
function omitRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

/** C9：14.2e 的任务类型中文名（拦截与基地转移不在「任务分配」入口，另走专用操作） */
const AIR_MISSION_KIND_LABELS: Record<string, string> = {
  barrage: '空军轰炸（14.7b）',
  hip_shoot: '低空扫射（14.7d）',
  trainbusting: '运输破坏（14.8）',
  air_transport: '空运（14.9）',
  air_drop: '空投（14.10）',
  fighter_sweep: '战机扫荡（14.6）',
  base_transfer: '基地转移（14.11）',
  interception: '拦截（14.5）',
}

/**
 * P8：14.2e「任务分配」入口的**全量来源**（真正可选清单由 store 内 `airMissionKindChoices` 按环节过滤）
 *
 * 唯一来源＝`AIR_MISSION_KIND_LABELS`；只排除**另走专用操作**的拦截与基地转移。
 * 界面（地图小窗 / 空军面板）只读 store 的过滤结果，不再各存一张六项字面量。
 */
const AIR_MISSION_KIND_CHOICES = (Object.keys(AIR_MISSION_KIND_LABELS) as AirMissionKind[])
  .filter((key) => key !== 'base_transfer' && key !== 'interception')
  .map((key) => ({ key, label: AIR_MISSION_KIND_LABELS[key] ?? key }))

/** C9：14.1a 激活状态中文名 */
const AIR_STATUS_LABELS: Record<string, string> = {
  active: '激活（14.1a）',
  inactive: '非激活（14.1a）',
}

/**
 * 2.1a：补给源关闭判据的地图事实
 *
 * 只依赖产品数据（`map-config.entryHexes` 与图内格清单），**与对局状态无关**，
 * 故放在模块级：这样"安全边剔除已关闭源"与"补给源当日状态"两处用的是同一份事实，
 * 不会因声明顺序产生前向引用。
 */
const SHUTDOWN_FACTS: SupplyShutdownFacts = {
  entryLHexes: (mapConfig.entryHexes?.L ?? []).map((hex) => ({ ...hex })),
  entryEHexes: (mapConfig.entryHexes?.E ?? []).map((hex) => ({ ...hex })),
  // 南缘＝没有图内南邻（奇数列没有第 0 行，故不能用 row === bounds.rowStart）
  isSouthEdge: (hex) => isSouthEdge(hex),
}

/**
 * 3.1 / 2.1（用户 2026-11-11 追加裁定）：图边 = 地图库的**字母入场段**
 *
 * 轴：K/J/I/H/G/F；苏：A/B/C/D/E/L。缺字母只报缺口，**不**退化成「全部边缘格」。
 */
const ENTRY_EDGE = {
  axis: entryEdgeHexes('axis', mapConfig.entryHexes ?? {}),
  soviet: entryEdgeHexes('soviet', mapConfig.entryHexes ?? {}),
} as const
for (const side of ['axis', 'soviet'] as const) {
  if (ENTRY_EDGE[side].missing.length > 0) {
    // 登记缺口（不静默退化）：报告与日志都留痕
    console.error(
      `[3.1/2.1] 地图库缺少 ${side} 入场段：${ENTRY_EDGE[side].missing.join('/')}；不使用全边缘兜底`,
    )
  }
}

/** B37：专规面板的分节标识（与面板里的 6 节一一对应；1.7 只保留台账，Forage 入口在补给阶段面板） */
export type ExclusiveSection =
  'panzer' | 'security' | 'hedgehog' | 'constructionMarker' | 'supplyCache' | 'airRestriction'

/** 4.8a：超堆叠格内一枚**可被拥有者选择摧毁**的本方战斗单位 */
export interface OverstackDutyUnit {
  instanceId: string
  name: string
  re: number
}

/**
 * 4.8a：一格超堆叠义务
 *
 * `rule` / `detail` 直接来自引擎 `stackingObligations()`（含 13.6 增援豁免与 >10 RE 判据），
 * 操作台只负责把盘面按格汇总、给玩家勾选与落盘。
 */
export interface OverstackDuty {
  key: string
  hex: HexRef
  side: Side
  combatRe: number
  rule: string
  detail: string
  units: OverstackDutyUnit[]
}

export const useWorkbenchStore = defineStore('workbench', () => {
  // ── 对局骨架状态（2.2 流程：当前方 / 阶段 / 回合 / 日期） ──
  //
  // ★ 联调（**单一权威**）：有会话时，「当前方 / 阶段 / 回合」以**会话的记录轨 `Records`** 为准，
  //   这里只做投影；无会话时退回本地演练值（未开局也能独立演练，与既有测试口径一致）。
  //   写入方向相反：手动切方 / 切段 / 改回合经 `session.patchRecords` 落回记录轨。
  //   缝法与下方随机数完全一致（读：会话优先；写：有会话则写会话），故两处口径统一。
  const localActiveSide = ref<Side>('axis')
  const localPhase = ref<ConsolePhase>('movement')
  const localTurn = ref(1)

  // ── 随机数（B2：种子入存档、可复算；禁 Math.random） ──
  //
  // ⑭ 接线：**唯一骰源**。会话日志（D2）的重放是「按日志逐条、以 `session.state.rng` 这
  // **同一颗** PRNG 重掷并比对骰面」，故只要开着会话，操作台的掷骰就必须推进会话那颗 PRNG
  // （否则重放读到的是一颗没被用过的 PRNG，必然报分歧）。没有会话时退回操作台自带的演示种子，
  // 未开局也能独立演练。实现上把这三个量做成「读：会话优先；写：有会话则写会话」的读写器，
  // 于是既有的 `rng.value = draw.rng` / `drawCount.value += 1` 写法无需改动即自动走会话。
  const session = useGameSessionStore()
  // ⑧：对局记录器（只记事实；未开启时 `note` 立即返回，零开销）
  const recorder = useRecorderStore()
  // E4：新局默认种子。测试环境由 `createGameSeed()` 固定为 TEST_FIXED_SEED，
  // 生产环境取系统熵；同一毫秒内多次建店也不会共用同一个随机种子。
  const initialSeed = createGameSeed()
  const localSeed = ref(initialSeed)
  const localRng = ref<RngState>(createRngState(initialSeed))
  /** 本地演练用的已掷骰次数（有会话时以会话 RNG 的 drawCount 为准） */
  const localDrawCount = ref(0)

  /* ── 联调：流程事实的**投影**（2.2）—— 有会话时读记录轨、无会话时读本地演练值 ── */

  /**
   * 2.2 阶段 → 操作台段（投影口径）
   *
   * 会话的 `GamePhase` 与操作台段几乎同名，只有两处不同：
   *   · `preTurn`（天气 / 先手判定）**原样投影**——它没有行动段，但界面停在这里，
   *     引擎的 `phase/segmentStep` 也必须停在这里（否则会沿用本地段的 C 移动，
   *     等待 2.3 应答时地图点击就按移动段分派）；
   *   · `turnEnd` ⇒ 归入 `cleanUp`（收束动作都发生在 H 清理段）。
   */
  function consolePhaseOf(gamePhase: GamePhase): ConsolePhase {
    if (gamePhase === 'turnEnd') return 'cleanUp'
    return gamePhase
  }

  /** 当前方（切方按钮）：决定「谁可以动」与合法性层的行动者判定 */
  const activeSide = computed<Side>({
    get: () => session.records?.activeSide ?? localActiveSide.value,
    set: (next) => {
      if (!session.patchRecords({ activeSide: next })) localActiveSide.value = next
    },
  })

  /** 当前阶段（2.2 SOP 段） */
  const phase = computed<ConsolePhase>({
    get: () => {
      const fromRecords = session.records === null ? null : consolePhaseOf(session.records.phase)
      return fromRecords ?? localPhase.value
    },
    set: (next) => {
      if (!session.patchRecords({ phase: next })) localPhase.value = next
    },
  })

  /**
   * 2.2：本环节**没有行动段**（会话停在 `preTurn` 判定环节）
   *
   * 2.2 流程表里 `preTurn`（天气判定 → 先手判定）**不属于 A–H 任何一段**，此刻玩家手上
   * 没有任何可做的事。而上面 `phase` 的投影在 `preTurn` 时只能撤回本地演练值，开机即
   * 「沿用 `localPhase` 的初值 `movement`」——于是**判定还没做完，移动环节就已经放行**
   * （实测：开局即点单位可走 38 格，而切到 D 补给段同样的单位可走 0 格）。
   *
   * 故此处给出**显式的「无段」**：一切段闸动作（移动 / 轰炸 / 空军 / 增援类 …）
   * 在锁定期间一律拒绝并给 `2.2`，而不是「沿用上一次的段」。
   */
  const segmentLocked = computed<boolean>(() => session.records?.phase === 'preTurn')

  /** 锁定期间统一的拒绝口径（供各段闸入口复用，保证规则号与文案一致） */
  function refuseWhileLocked(action: string): false {
    const reason = `会话停在回合准备环节（天气 / 先手判定），该环节没有行动段（2.2）：不能${action}`
    moveBlocked.value = { rule: '2.2', reason }
    pushLog('warning', reason, '2.2')
    return false
  }

  /** 回合号（1–19，第 1 回合 = 1941-07-08） */
  const turn = computed<number>({
    get: () => session.records?.turn ?? localTurn.value,
    set: (next) => {
      if (!session.patchRecords({ turn: next })) localTurn.value = next
    },
  })

  /**
   * 当前日期（ISO；引擎的时点 / 容量判定都用它）
   *
   * **由回合号派生**（回合轨是唯一来源）：此前 `date` 与 `turn` 是两个各自赋值的量，
   * 一旦有一条路径只改其一就会漂移；改为派生后不可能不一致。
   */
  const date = computed<string>(() => turnDateOf(turn.value))

  /**
   * E4：把种子写入当前骰源（初设前写本地，已有会话则写会话）
   *
   * 仅供「重置局」这类**显式开新局**的入口使用；日常改种子走 `setSeed`（对局中锁定）。
   */
  function applySeed(next: number): void {
    if (session.session === null) {
      localSeed.value = next
      localRng.value = createRngState(next)
    } else {
      session.setSessionRng(createRngState(next))
    }
  }

  /**
   * E4：设定种子（**开局后锁定**）
   *
   * B2 的复算前提是「一局一个种子」：对局进行中改种子会让已有日志无法按种子重放，
   * 故只允许在无会话时设定；要换种子必须走「重置局」（`resetAll` / `resetBoardNow`）。
   */
  function setSeed(next: number): boolean {
    if (!Number.isFinite(next) || next <= 0) {
      pushLog('warning', `种子必须是正整数：${String(next)}`, 'B2')
      return false
    }
    if (session.session !== null) {
      pushLog('warning', '对局进行中不能改种子（B2：日志按种子复算）；请用「重置局」开新局', 'B2')
      return false
    }
    applySeed(Math.trunc(next))
    return true
  }

  const seed = computed<number>({
    get: () => session.session?.state.rng.seed ?? localSeed.value,
    set: (next) => {
      setSeed(next)
    },
  })

  /**
   * ⑭ 接线：**已掷未报**的骰子缓冲（`recordSettlement` 消费它）
   *
   * 操作台里有几处是「先掷骰、再交引擎裁决」；若引擎拒绝（步骤不符等），那颗骰子已经消耗掉、
   * 却没有结算条目 —— D2 的重放会因此与实际序列错位。故在**骰源写入**这一唯一收口点
   * 就把本次推进还原成 `DiceRoll` 存进缓冲，由下一笔结算一并入账（顺序即掷骰顺序）。
   */
  const pendingRolls: DiceRoll[] = []

  /**
   * 由「掷骰前 / 掷骰后」两个 RNG 状态还原本次掷出的骰子
   *
   * 操作台的掷骰全部是 `roll1d6` / `roll2d6`（无其它抽取），而 `drawCount` 每枚骰 +1，
   * 故按推进步数即可判定是 1d6 还是 2d6，再用同一颗 PRNG 复算一次取骰面；
   * 复算结果的状态对不上（例如换种子、或罕见的拒绝采样多推了一步）则返回 null，不臆造。
   */
  function detectDraw(prev: RngState, next: RngState): DiceRoll | null {
    if (next.seed !== prev.seed) return null
    const delta = next.drawCount - prev.drawCount
    if (delta !== 1 && delta !== 2) return null
    const candidate = delta === 1 ? roll1d6(prev) : roll2d6(prev)
    return candidate.rng.state === next.state ? candidate.value : null
  }

  const rng = computed<RngState>({
    get: () => session.session?.state.rng ?? localRng.value,
    set: (next) => {
      const drawn = detectDraw(rng.value, next)
      if (drawn !== null) pendingRolls.push(drawn)
      if (session.session === null) localRng.value = next
      else session.setSessionRng(next)
    },
  })
  /**
   * 已掷骰次数（复算用）
   *
   * 有会话时读会话 RNG 的 `drawCount`——引擎的掷骰函数自己会 +1，故 `drawCount.value += 1`
   * 在此等价于「读到最新值」（写入被忽略，避免与引擎重复计数）。
   */
  const drawCount = computed<number>({
    get: () => session.session?.state.rng.drawCount ?? localDrawCount.value,
    set: (next) => {
      if (session.session === null) localDrawCount.value = next
    },
  })

  // ── 摆子 ──
  const units = ref<ConsoleUnit[]>([])
  /**
   * 4.8a：环节/阶段末的**超堆叠义务**（战斗单位 >10 RE 的格）
   *
   * 规则原文：「超堆叠，是指在**任何环节或阶段结束时**，某一格内的战斗单位超过 10RE……
   *   超堆叠格内单位的拥有者必须摧毁单位，直到满足限制。」
   * ★ 判据（>10 RE、13.6 增援豁免、规则号与文案）一律问引擎 `stackingObligations()`；
   *   本 store 只做「按格汇总盘面 + 给出勾选/摧毁入口」，不另写阈值。
   */
  const overstackDuties = computed<OverstackDuty[]>(() => {
    const buckets = new Map<
      string,
      { hex: HexRef; side: Side; combatRe: number; units: OverstackDutyUnit[] }
    >()
    for (const unit of units.value) {
      if (!unit.isCombat) continue
      const key = hexLabel(unit.hex)
      let bucket = buckets.get(key)
      if (bucket === undefined) {
        bucket = { hex: unit.hex, side: unit.side, combatRe: 0, units: [] }
        buckets.set(key, bucket)
      }
      const re = currentReOf(unit)
      bucket.combatRe += re
      bucket.units.push({ instanceId: unit.instanceId, name: unit.name, re })
    }
    const duties: OverstackDuty[] = []
    for (const bucket of buckets.values()) {
      const [obligation] = stackingObligations(bucket.hex, bucket.combatRe, phase.value)
      if (obligation === undefined) continue
      duties.push({
        ...bucket,
        key: hexLabel(bucket.hex),
        rule: obligation.rule,
        detail: obligation.detail ?? '',
      })
    }
    // 稳定顺序：界面不随 Map 迭代顺序跳动
    return duties.sort((a, b) => a.key.localeCompare(b.key))
  })
  /** 4.8a 面板勾选：格号 → 拟摧毁的实例 id（只认该格清单里的本方战斗单位） */
  const overstackPicks = ref<Record<string, string[]>>({})
  /** 各超堆叠格**勾选后剩余的**战斗 RE（界面与提交判据共用） */
  const overstackRemainingRe = computed<Record<string, number>>(() => {
    const out: Record<string, number> = {}
    for (const duty of overstackDuties.value) {
      const picked = new Set(overstackPicks.value[duty.key] ?? [])
      const destroyed = duty.units.reduce(
        (sum, unit) => (picked.has(unit.instanceId) ? sum + unit.re : sum),
        0,
      )
      out[duty.key] = duty.combatRe - destroyed
    }
    return out
  })
  /** 4.8a：当前勾选是否**已够**（每一格都回到 ≤10 RE）——界面只用它决定提交可用态 */
  const overstackSettled = computed<boolean>(() =>
    overstackDuties.value.every(
      (duty) => (overstackRemainingRe.value[duty.key] ?? duty.combatRe) <= STACKING_LIMIT_RE,
    ),
  )
  /** 1.4b：盒内算子仍属于盘面，入盒回合防止同一移动阶段再次出盒。 */
  const edgeBoxHoldings = ref<Record<'northeast' | 'southeast', ConsoleUnit[]>>({
    northeast: [],
    southeast: [],
  })
  const edgeBoxEnteredOn = ref<Record<string, number>>({})
  /** 当前选中的算子实例 id */
  const selectedId = ref<string | null>(null)
  /** 待摆放的单位库记录（从单位列表里点选后进入「摆放模式」） */
  const pendingRecord = ref<UnitRecordView | null>(null)
  /** 工具模式：点地图时做什么（放大镜/摆子/打一仗） */
  const tool = ref<'move' | 'place' | 'battle'>('move')

  // ── 结果与日志 ──
  /** C5：最近一步的展示快照（撤销后为 null） */
  const lastStep = ref<MoveStepSnapshot | null>(null)
  const lastBattle = ref<BattleReport | null>(null)
  const log = ref<WorkbenchLogEntry[]>([])

  /*
   * ── B0 装配（解构第一批）──────────────────────────────────────────────
   * 日志与结算账本的实现已搬进 `workbench-core.ts`；这里只组装依赖并让同名函数转发。
   * 存量 669 处 `pushLog(...)` 与 77 处 `recordSettlement(...)` **一个调用点都不用改**。
   *
   * 依赖一律传引用或 getter：
   * - `log` / `pendingRolls` 是稳定引用（后者靠 `splice` 就地出账）；
   * - `segmentStepId` 必须用 getter —— `segmentStep` 在文件后段（`B8 环节闸门` 分节）才声明，
   *   装配期直接取值会是 `undefined`。
   * ────────────────────────────────────────────────────────────────────
   */
  const core = createWorkbenchCore({
    log,
    recorder,
    turn: () => turn.value,
    phase: () => phase.value,
    activeSide: () => activeSide.value,
    segmentStepId: () => segmentStep.value?.id ?? null,
    pendingRolls,
    sealUndo,
    appendSettlement: (entry) => session.appendSettlement(entry),
  })

  // ── C5 移动交互（W4 C5） ──
  /**
   * 本次移动的记账（null = 尚未开始移动）
   *
   * 单位的位置与 MP 始终写在 `units` 上（引擎给出的 patches 由本 store 落盘），
   * 本项只保存「参移名单 + 起始格 + 步骤历史」，**撤销即还原历史快照**。
   */
  /*
   * ── B3-1 薄转发：C5 移动交互的实现已搬进 `workbench-move.ts` ──
   * 这 4 个名字被**更早创建**的域当端口吃（`groundMovement` 1113–1122 / 轰炸 1567 / 空军 2159、2222 /
   * 7066），而移动域建在原区间位置（那里才有 `movePick`/`stackSelect`/`moveUnits`）。故此处各留一行转发；
   * 其余 15 个搬走的名字由 `movementDomain` 直接解构。
   * ────────────────────────────────────────────────────────────────────
   */
  function nameOf(unitId: string): string {
    return movementDomain.nameOf(unitId)
  }

  function applyMovePatches(patches: readonly MoveUnitRuntime[]): void {
    movementDomain.applyMovePatches(patches)
  }

  function refuseWhileSettling(action: string): boolean {
    return movementDomain.refuseWhileSettling(action)
  }

  function closeBreakdownWindows(timing?: BreakdownCreateTiming): void {
    movementDomain.closeBreakdownWindows(timing)
  }

  /** ── B3-2a 薄转发：C5 堆叠取子已搬进 `workbench-stack-pick.ts` ──
   *  `snapshotOf`(1138) / `stepTextOf`(1139) 被 `createGroundMovementDomain` 当端口吃，
   *  `movePickPoolAt`(5768、7552) / `defaultMovePickIdsAt`(7553) 被移动域当端口吃，
   *  而本域建在原区间位置，故此处各留一行转发（其余 9 名由 `stackPickDomain` 直接解构）。
   */
  function movePickPoolAt(hex: HexRef): ConsoleUnit[] {
    return stackPickDomain.movePickPoolAt(hex)
  }

  function defaultMovePickIdsAt(hex: HexRef): string[] {
    return stackPickDomain.defaultMovePickIdsAt(hex)
  }

  function stepTextOf(record: MoveStepRecord): string {
    return stackPickDomain.stepTextOf(record)
  }

  function snapshotOf(record: MoveStepRecord): MoveStepSnapshot {
    return stackPickDomain.snapshotOf(record)
  }

  const groundMovement = createGroundMovementDomain({
    context: () => moveContext.value,
    runtime: () => moveRuntime.value,
    unitNameOf: (unitId) => units.value.find((unit) => unit.instanceId === unitId)?.name ?? unitId,
    lastStep,
    applyMovePatches,
    pushLog,
    recordSettlement,
    snapshotOf,
    stepTextOf,
    triggerSpecialCombatAfterStep,
    mayMutate() {
      if (refuseWhileSettling('移动或撤销')) return false
      if (specialPending.value !== null || (airState.value !== null && !airState.value.finished)) {
        moveBlocked.value = { rule: '6.1', reason: '先完成当前特殊位移或空军任务，再继续地面移动' }
        return false
      }
      return true
    },
    undoSealReason: () => moveUndoSealReasonNow(),
  })
  const { moveInteraction, zocStoppedMoveUnitIds, moveBlocked } = groundMovement
  /**
   * 用户 2026-11-18：**掷骰即封撤销**
   *
   * 「经过任何掷骰判定后的操作不得撤销」——按**本段**（回合/方/段/环节）计：
   * 一旦本段有任何掷骰结算（战斗、补给掷骰、抽签、特殊补员……），
   * 该段的撤销入口（移动撤销/放弃、初设撤回、增援撤回）一律直接不可用。
   * 换段/换方/换回合后 key 不同，封印自然失效，不跨段误伤。
   */
  const undoSeal = ref<{ seq: number; key: string; session: number | null; reason: string } | null>(
    null,
  )
  /**
   * 用户 2026-11-20：封账按**笔**走，不按阶段连坐。
   *
   * `session` = 掷骰发生在哪一次移动交互（开拔一次加一）。同一次交互内步骤不可退
   * （骰前的步也不能退），但下一支堆叠开拔是新的 session ⇒ 它的移动仍可撤。
   * 不在移动交互里的掷骰（补给/抽签/补员）保持原来的段级口径（`session = null`）。
   */
  const moveSessionSeq = ref(0)
  function sealUndo(reason: string): void {
    undoSeal.value = {
      seq: undoTrailSeq,
      key: undoScopeKeyOf(),
      session: moveInteraction.value === null ? null : moveSessionSeq.value,
      reason,
    }
  }

  /** 移动撤销的封账判据：只有**同一次开拔**的掷骰才连坐 */
  function moveUndoSealReasonNow(): string | null {
    const seal = undoSeal.value
    if (seal === null || seal.key !== undoScopeKeyOf()) return null
    if (seal.session === null) return seal.reason
    return seal.session === moveSessionSeq.value ? seal.reason : null
  }

  /**
   * 用户 2026-11-20：**全局共用撤销账**（最近一笔可撤操作）
   *
   * 每个动作族在**成功落账时**登记一条；族内既有撤销按钮走完也要销账。
   * `undoLastOperationNow()` 只看栈顶，按族分派到该族既有实现（或整盘快照），
   * 因此「移动 → 装卸 → 撤销 → 再撤销」严格按发生顺序回退，不再出现两本账各退一半。
   *
   * 作用域＝`undoScopeKeyOf()`：换段/换方/换回合后旧账不再可撤（不跨段误伤）。
   */
  type UndoFamily = 'move.step' | 'transport' | 'setup' | 'draft' | 'arrival' | 'cache' | 'snapshot'
  interface UndoTrailEntry {
    seq: number
    family: UndoFamily
    label: string
    scope: string
  }
  const undoTrail = ref<UndoTrailEntry[]>([])
  /** snapshot 族的整盘快照（只在内存；读档/换段即失效，不进存档） */
  const undoSnapshots = new Map<number, unknown>()
  /** 各族撤销实现（'setup' 由 setup store 在初始化时注册，避免循环依赖） */
  const undoFamilyHandlers = new Map<UndoFamily, () => boolean>()
  let undoTrailSeq = 0

  /** 登记一笔可撤操作（family='snapshot' 时附整盘快照） */
  function noteUndoable(family: UndoFamily, label: string, snapshot?: unknown): number {
    undoTrailSeq += 1
    const entry: UndoTrailEntry = { seq: undoTrailSeq, family, label, scope: undoScopeKeyOf() }
    undoTrail.value = [...undoTrail.value, entry]
    if (snapshot !== undefined) undoSnapshots.set(entry.seq, snapshot)
    return entry.seq
  }

  /** 快照族登记：先整盘快照再落账；取不到快照（如空军载货在途）就只登记跳过撤销 */
  function captureUndoSnapshot(label: string): number | null {
    try {
      return noteUndoable('snapshot', label, snapshotBoard())
    } catch {
      return null
    }
  }

  function dropUndoBySeq(seq: number): void {
    undoSnapshots.delete(seq)
    undoTrail.value = undoTrail.value.filter((entry) => entry.seq !== seq)
  }

  /** 销掉该族**最近**的一笔（族内按钮直接撤销后调用） */
  function dropUndoOf(family: UndoFamily): void {
    const trail = undoTrail.value
    for (let index = trail.length - 1; index >= 0; index -= 1) {
      if (trail[index]!.family === family) {
        dropUndoBySeq(trail[index]!.seq)
        return
      }
    }
  }

  /** 整族销账（如放弃整次移动时，移动步与装卸一起作废） */
  function dropUndoFamilies(families: readonly UndoFamily[]): void {
    const dead = new Set(
      undoTrail.value.filter((entry) => families.includes(entry.family)).map((entry) => entry.seq),
    )
    if (dead.size === 0) return
    for (const seq of dead) undoSnapshots.delete(seq)
    undoTrail.value = undoTrail.value.filter((entry) => !dead.has(entry.seq))
  }

  function clearUndoTrail(): void {
    undoTrail.value = []
    undoSnapshots.clear()
  }

  /** 各族把「撤销自己最近一笔」的实现注册进来（统一入口据此分派） */
  function registerUndoFamily(family: UndoFamily, handler: () => boolean): void {
    undoFamilyHandlers.set(family, handler)
  }

  /** 统一入口的按钮态：本段未封账且栈顶属于当前作用域 */
  const canUndoOperation = computed<boolean>(() => {
    const entry = undoTrail.value[undoTrail.value.length - 1]
    if (entry === undefined || entry.scope !== undoScopeKeyOf()) return false
    // 移动类：本次移动已结束（=提交）⇒ 栈顶这两族不再可撤
    if (
      (entry.family === 'move.step' || entry.family === 'transport') &&
      (moveInteraction.value === null || moveInteraction.value.finished)
    )
      return false
    // 用户 2026-11-20：封账只压住它之前落在**同一作用域**的笔；之后的新操作照常可撤
    const seal = undoSeal.value
    if (seal !== null && seal.key === entry.scope && entry.seq <= seal.seq) return false
    return true
  })

  /** 栈顶那一笔的人话（供按钮提示） */
  const undoOperationLabel = computed<string | null>(
    () => undoTrail.value[undoTrail.value.length - 1]?.label ?? null,
  )

  /**
   * 用户 2026-11-20：**全局共用撤销入口**（同一个 action / 同一套「最近一笔」语义）
   *
   * 顺序：先查本段掷骰封账 → 再看栈顶 → 分派到该族撤销。
   * 覆盖所有不涉及掷骰检定的操作：移动步、装卸、初设落位、战果草稿、增援铁路抵达、
   * 补给缓存，以及换轨/建造/建造标记/加油/整备（整盘快照族）。
   */
  function undoLastOperationNow(): boolean {
    const entry = undoTrail.value[undoTrail.value.length - 1]
    if (entry === undefined) {
      pushLog('info', '没有可撤销的操作')
      return false
    }
    if (entry.scope !== undoScopeKeyOf()) {
      clearUndoTrail()
      pushLog('warning', '上一环节的操作已封存，不能再撤销', '6.1')
      return false
    }
    // 移动类：结束移动＝提交（用户 2026-11-18）⇒ 之后不再回退
    if (
      (entry.family === 'move.step' || entry.family === 'transport') &&
      (moveInteraction.value === null || moveInteraction.value.finished)
    ) {
      dropUndoBySeq(entry.seq)
      pushLog('warning', '本次移动已结束（6.1）：结束即提交，不能再撤销', '6.1')
      return false
    }
    /*
     * 用户 2026-11-20：封账只作用于**它那一笔及其之前的账**（同一作用域）；
     * 掷骰之后的新操作序号更大 ⇒ 照常可撤，不被前一笔连坐。
     */
    const seal = undoSeal.value
    if (seal !== null && seal.key === entry.scope && entry.seq <= seal.seq) {
      // 这些笔已经不能撤了，一并摘掉，免得入口卡在一笔废账上
      const dead = new Set(
        undoTrail.value
          .filter((item) => item.scope === entry.scope && item.seq <= seal.seq)
          .map((item) => item.seq),
      )
      for (const seq of dead) undoSnapshots.delete(seq)
      undoTrail.value = undoTrail.value.filter((item) => !dead.has(item.seq))
      pushLog('warning', seal.reason, '6.1')
      return false
    }
    if (entry.family === 'snapshot') {
      const board = undoSnapshots.get(entry.seq)
      if (board === undefined) {
        dropUndoBySeq(entry.seq)
        pushLog('warning', `「${entry.label}」没有可还原的快照`, '6.1')
        return false
      }
      /*
       * 整盘还原会重置移动/战斗等会话；但快照是**该动作发生前**拍的，
       * 当时的移动会话仍成立 ⇒ 把会话壳原样放回去，撤销一个建造/加油不该把移动打断。
       */
      const interaction = moveInteraction.value
      const pick = movePick.value
      restoreBoard(board, true)
      moveInteraction.value = interaction
      movePick.value = pick
      dropUndoBySeq(entry.seq)
      pushLog('info', `撤销：${entry.label}（盘面还原）`, '6.1')
      return true
    }
    const handler = undoFamilyHandlers.get(entry.family)
    if (handler === undefined) {
      dropUndoBySeq(entry.seq)
      pushLog('warning', `「${entry.label}」暂不支持撤销`, '6.1')
      return false
    }
    const ok = handler()
    if (!ok) {
      // 族实现已拒绝（并给出原因）；把这一笔从账上摘掉，避免入口卡死
      dropUndoBySeq(entry.seq)
    }
    return ok
  }
  /**
   * H7（用户 2026-11-16）：**结束一次移动后不立刻收窗**
   *
   * 移动工具仍就绪，地图会话留在"点下一支己方堆叠"状态，连续移动不被打断；
   * 点 × / Esc 或进入新一次开拔时清掉。
   */
  const moveLinger = ref(false)
  /**
   * 13.2f：本次移动开始时已有的装卸撤销账条数 —— 放弃/结束时只结算本段新产生的装卸，
   * 不误伤开拔前的那一笔（那属于上一次动作）。
   */
  const transportHandlingBaseline = ref(0)
  /** 悬停格（用于路径与消耗预览） */
  const hoverHex = ref<HexRef | null>(null)
  /**
   * 4.5a-A：**本次移动中因进入未抵消敌方 ZOC 而被迫停车**的单位 id
   *
   * 原文（`_ocs_v43_clean.txt:508-515`）：「拥有轮式 MP 类型的单位，在进入一个敌方 ZOC 后，
   * 要么必须在此处**结束移动**，要么必须**进行突袭**。如果选择突袭，则每次突袭后，还能进行
   * 下一次突袭，以此方式单位能连续通过多个 ZOC。」
   *
   * ⇒ 「停车」与「还能突袭」是**同一次移动**里的两个分支，不是互斥的两件事。
   *   停车由 `planStep` 把运行态的 `ended` 置真（→ 状态层 `movementEnded`），
   *   而它同时意味着「这一枚仍被允许改用突袭」——本账本就是那句"仍被允许"的唯一来源：
   *   修前突袭候选只取 `activeMoveUnits`（`movementEnded` 为假者）⇒ 停车后 `overrunTargets`
   *   恒为空，4.5a-A 的后一半**实际不可达**（第六批条 14）。
   */
  /** 是否按堆叠选择（同一格内当前方的全部单位一起移动；6.1） */
  const stackSelect = ref(false)
  /**
   * C5：堆叠取子（6.1 / 8.1g / 8.1h）——点堆叠格后**先选哪几枚开拔**，再由玩家确认
   *
   * 为什么需要它：
   *   - 6.1f 的玩家说明「若想让每个单位分别移动到不同的位置，就不要以堆叠形式开始移动」，
   *     故必须能在开拔前拆分堆叠；
   *   - 8.1h 允许「不参与突袭的友方单位留在格内」，而 `canOverrun` 要求**每一名参突者**都合格
   *     ⇒ 只要整堆叠里混有一枚不可攻击的单位（卡车/炮兵/HQ…），整堆突袭会被整体否决；
   *     能按单位取子才可能按 8.1g/8.1h 只让合格者参突。
   * 非空时界面在堆叠处给出勾选清单；确认后以所选子集 `beginMoveFor`。
   */
  const movePick = ref<{ hex: HexRef; ids: string[] } | null>(null)
  /**
   * 5.4a / 5.7：预备额度＝**此刻有预备单位的格子**
   *
   * 5.4a「玩家可以用一个预备标记（4.8b），表示**堆叠中一部分单位全部处于预备模式**」⇒ 一枚标记
   * 覆盖**一个格子**里处于预备模式的那部分单位：同格多枚只算 1 格，异格各算 1 格（用户
   * 2026-11-06 裁定「算不算额度得看同一格有没有预备模式的其它单位」）。剧本 `setup.reserveMarkers`
   * 给几枚 ＝ 能同时保持几个格子处于预备；未给按 `0`（「没有就是 0」⇒ 无预备权）。
   *
   * 额度**不从账本读**：直接由 `units` 的当前模式派生 ⇒ 释放后标记天然留在未释放的单位上
   * （5.7b 逐枚摘标记），读档也无需重放日志（`units` 本来就随档往返）。
   */
  function hexKeyOf(unit: ConsoleUnit): string {
    return `${String(unit.hex.col)}.${String(unit.hex.row)}`
  }

  /** 某方此刻有预备单位的格子（去重；界面/测试读它核对额度占用） */
  function reservedHexes(side: Side): string[] {
    return reserveHexesInUse(
      units.value.map((unit) => ({
        hex: hexKeyOf(unit),
        side: unit.side,
        inReserve: hasMarker(unit.mode, 'reserve'),
      })),
      side,
    )
  }

  /**
   * 5.4a：某方预备标记的 上限 / 占用 / 剩余（**显示与转入闸门共用这一份派生值**）
   *
   * 用户 2026-11-18：「预备标记要能在标记盒里看到，并在玩家消耗时即时减少；消耗入口与显示
   * 同源，不要各存一份计数。」⇒ 不新增账本：`used` 仍由 `reservedHexes`（单位的当前模式）
   * 派生，`cap` 读剧本数据；标记盒卡与 `canEnterReserveMode` 都读本函数。
   */
  function reserveMarkerStatusOf(side: Side): { cap: number; used: number; remaining: number } {
    const cap = session.scenarioInfo?.setup.reserveMarkers?.[side] ?? 0
    const used = reservedHexes(side).length
    return { cap, used, remaining: Math.max(0, cap - used) }
  }

  /**
   * 13.2a：已「暂停移动」的运输点数（原文「运输点数可以移动、暂停移动……然后继续移动」）
   *
   * 只记**玩家主动结束移动**的运输点数：它们在同一移动阶段内可以再次开拔（6.1g 的
   * 「本轮已结束」对 13.2a 让路）；同时原文限制「必须在另一个单位移动之前完成它的移动」
   * ⇒ 暂停期间别的单位不得开拔（见 `beginMoveFor`）。
   * 阶段/换方/换回合清空（`resetMovementTracking`）。
   */
  const pausedTransportIds = ref<string[]>([])

  /**
   * 12.2a / 12.2b：本阶段的 SP 接力账本
   *
   * 原文只给「同一个 SP」的规则，本作没有逐 SP 身份 ⇒ 按「格 + 方 + 方式 + T」近似记账；
   * 12.2b 的「立即使用」边界取「同阶段该站持仓减少」，更细的时点原文未给，不扩展。
   * 只在内存中按阶段存活（`resetMovementTracking` 清零），不进存档。
   */
  const spRelayLocks = ref<
    Array<{ phaseKey: string; hex: string; side: Side; mode: 'transport' | 'rail'; t: number }>
  >([])

  const transportHandlingUndo = ref<TransportHandlingUndoEntry[]>([])

  function spRelayPhaseKey(): string {
    return `${turn.value}|${activeSide.value}|${phase.value}`
  }

  function hexKeyText(hex: HexRef): string {
    return `${hex.col}.${hex.row}`
  }

  /** 12.2a：该格该方本阶段已由**其他方式**移动过的 T（同方式不锁） */
  function spRelayLockedT(hex: HexRef, side: Side, mode: 'transport' | 'rail'): number {
    const key = spRelayPhaseKey()
    const hexKey = hexKeyText(hex)
    return spRelayLocks.value
      .filter(
        (lock) =>
          lock.phaseKey === key && lock.hex === hexKey && lock.side === side && lock.mode !== mode,
      )
      .reduce((sum, lock) => sum + lock.t, 0)
  }

  /** 12.2a：在该格记下「这批 T 已由某种方式移动」 */
  function addSpRelayLock(hex: HexRef, side: Side, mode: 'transport' | 'rail', t: number): void {
    if (t <= 0) return
    const phaseKey = spRelayPhaseKey()
    const hexKey = hexKeyText(hex)
    const existing = spRelayLocks.value.find(
      (lock) =>
        lock.phaseKey === phaseKey &&
        lock.hex === hexKey &&
        lock.side === side &&
        lock.mode === mode,
    )
    if (existing !== undefined) {
      existing.t += t
      return
    }
    spRelayLocks.value = [...spRelayLocks.value, { phaseKey, hex: hexKey, side, mode, t }]
  }

  /** 12.2b：该站持仓减少 ⇒ 按最早锁优先释放（原文「立即使用掉」在本实现取同阶段边界） */
  function releaseSpRelayLocks(hex: HexRef, side: Side, t: number): void {
    if (t <= 0) return
    const phaseKey = spRelayPhaseKey()
    const hexKey = hexKeyText(hex)
    let remaining = t
    spRelayLocks.value = spRelayLocks.value.flatMap((lock) => {
      if (
        remaining <= 0 ||
        lock.phaseKey !== phaseKey ||
        lock.hex !== hexKey ||
        lock.side !== side
      ) {
        return [lock]
      }
      const used = Math.min(lock.t, remaining)
      remaining -= used
      return lock.t - used > 0 ? [{ ...lock, t: lock.t - used }] : []
    })
  }
  /** 上次移动被拒/受阻的原因（供界面显示） */
  /**
   * 演示用补给池（12.5c 的 SP / T）
   *
   * 真实补给账本属 B10/B11（追溯补给与补给阶段）；操作台只用它演示「付得出 / 付不出」，
   * 故初值为 0，由玩家在界面填入 —— **不臆造数值**。
   */
  const fuelPool = ref<{ sp: number; t: number }>({ sp: 0, t: 0 })

  // ── 打一仗的选定（9.3b 由防御方选地形；9.6 由双方各选一个参战单位的行动值）──
  /** 已选定的交战国标格（null = 尚未选定） */
  const battleTarget = ref<BattleTarget | null>(null)
  /** 防御方选定的地形（9.3b；选定目标格时先置为「对防御方最有利」的默认值） */
  const battleTerrain = ref<string>('')
  /** 防御方选定的行动值来源单位（9.6；null = 取参战单位中最高者） */
  const battleDefenderArId = ref<string | null>(null)

  // ── C6 战斗交互（W4 C6：9.2 九步流程；引擎状态机在 combat-interaction.ts） ──
  /** 战斗工具的模式：quick＝一键查表（9.9 便捷入口）；full＝9.2 九步完整流程 */
  const battleMode = ref<'quick' | 'full'>('full')
  /** C6：参战攻方单位 id（可跨多个相邻攻击格；9.1b 允许只取堆叠中的一部分） */
  const combatAttackerIds = ref<string[]>([])
  const fireResolution = createFireResolutionDomain({
    rng,
    drawCount,
    acceptCombat,
    acceptBarrage,
    applyCombatPatches,
    stripReserveMarkersAfterDefense,
    logCombatSurprise,
    pushLog,
    recordSettlement,
    nameOf,
    barrageLossTargets: () => barrageLossTargets.value,
    applyBarragePatches,
    applyAirStepLoss: (id) => applyAirStepLoss(id),
    applyFacilityPatch: applyBarrageFacilityPatch,
    barrageAircraftTargets: () => barrageAircraftRollTargets.value,
    facilityFacts: barrageFacilityFacts,
    retreatPlans: () => combatRetreatPlans.value,
    hasPendingSpecial: () => specialPending.value !== null,
    applyRetreatCrossing({ unitId, hex }) {
      const unit = units.value.find((item) => item.instanceId === unitId)
      if (unit !== undefined) resolveSpecialCombatAt(hex, unit.side, false, [unitId])
    },
  })
  const {
    combatState,
    combatError,
    combatSurpriseDie,
    combatSurpriseRoll,
    combatShiftRoll,
    combatDiceRoll,
    combatAwaitingShiftDie,
    combatInputs,
    combatSupplyCommitted,
    barrageState,
    barrageError,
    barrageInputs,
    barrageAwaitingHalfDie,
    barrageCommitted,
  } = fireResolution

  // ── C7 轰炸交互（W5 C7：10.0 通用流程；引擎状态机在 barrage-interaction.ts） ──
  /** C7：轰炸工具是否已开启（点「轰炸」按钮进入；<CombatPanel/> 走九步）*/
  const barrageActive = ref(false)
  /**
   * 轰炸工具是不是**进入轰炸环节时自动开的**（用于换段时收回；玩家手动开的留给他）
   *
   * ★ 只在两条 watch 之间用：开工具的那条置真，换段归零的那条据此关闭。
   *   否则换段这一拍的"旧下标 → 本段轰炸环"中间态会把工具带进新段
   *   （见 `isBarrageSegment` 的 watch）。
   */
  let barrageAutoOpened = false
  /** C7：参炸单位类别（10.0e-F：一次轰炸只能同一类型） */
  const barrageKind = ref<BarrageKind>('artillery')
  /** C7：10.0d 宣布的整体目标（决定用哪张表） */
  const barrageTargetKind = ref<BarrageTargetKind>('combatUnits')
  /** C7：参炸单位 id（当前方，可只取一部分） */
  const barrageUnitIds = ref<string[]>([])
  /**
   * 条 13：本次炮击的**作用域格**（右键某格进入时锁定；工具条直接开为 null＝全场）
   *
   * 只影响阵列的**视图收窄**，判据仍是 `barrageUnitChoices`。
   */
  const barrageScopeHex = ref<HexRef | null>(null)

  /**
   * **10.0e-A/B 的轰炸账本**（按阶段；A 组接线 2026-09-16）
   *
   * 条文：「每格每阶段只允许被轰炸**一次**；**已宣布但被防空/拦截完全摧毁或返航的任务也算**」
   * （10.0e-A）、「一个单位每阶段只能轰炸一次、不能拆分轰炸值」（10.0e-B）。
   *
   * ★ 修前这两条**只靠面板上的一个玩家勾选**自报（`barrageInputs.hexAlreadyBarragedThisPhase`），
   *   不勾就没人拦 ⇒ 同一格/同一单位能在同一个阶段里反复轰炸。
   *   现在由本账本按阶段记账、直接喂给引擎的 `BarrageFacts`（引擎侧的判定位一直在，缺的是喂它的人）。
   *   记账时点＝**付完补给之后**：10.1b 明写「付不出则全部取消，且**不视为已轰炸过**」。
   *   换阶段 / 换回合 / 复位即清空（与 `gaugeConversionsThisPhase` 等同一口径）。
   */
  const barragedHexesThisPhase = ref<string[]>([])
  const barragedUnitIdsThisPhase = ref<string[]>([])

  /** 账本的可读投影（界面上"本阶段已轰炸：N 格 / M 单位"，也是留痕） */
  const barragePhaseLedger = computed(() => ({
    hexes: [...barragedHexesThisPhase.value],
    unitIds: [...barragedUnitIdsThisPhase.value],
  }))

  /**
   * **9.1c 的战斗环节攻击账本**（按环节；与上面 10.0e-A/B 的轰炸账本同族）
   *
   * 条文：「在一个战斗环节中，**同一个单位只能攻击一次，同一格只能被攻击一次**。一个格可以被任意
   * 数量的相邻格攻击，由攻击方玩家决定。」紧接的下一条把**移动环节的突袭**排除在外 ——「在一个移动
   * 环节中，同一个单位可以进行多次突袭，突袭同一个格的次数没有限制」⇒ 本账本只在**常规战斗**上生效
   * （8.1 的突袭不受限），且只在**战斗环节**内有意义。
   *
   * 记账时点＝**战斗补给这一关过了之后**（9.5b：付不出全额就「减少参战单位、动用部队储备、或者根本
   * 不攻击」⇒ 那份被"根本不攻击"作废的战斗不该占掉本环节的这一次；与 10.1b 的轰炸账本同口径）。
   * 换环节 / 换段 / 换方 / 换回合即清空（`clearAttackPhaseLedger`）。
   */
  const attackedUnitIdsThisPhase = ref<string[]>([])
  const attackedHexesThisPhase = ref<string[]>([])

  /** 账本的可读投影（界面"本环节已攻击：N 单位 / M 格"，也是留痕） */
  const attackPhaseLedger = computed(() => ({
    unitIds: [...attackedUnitIdsThisPhase.value],
    hexes: [...attackedHexesThisPhase.value],
  }))
  /**
   * C7：**空军算子**（14.1a：摆在**空军基地格**上，其所在格即 10.2b 所说的「它们基地」）
   *
   * 飞机的印值来自 `aircraft.json`（A5 空军专表），与地面算子库（`units-*.json`）分开。
   */
  const airUnits = ref<ConsoleAirUnit[]>([])
  /**
   * 专规 1.4a：当前驻在**地图外空军盒**里的飞机 id
   *
   * 为什么这本账在**操作台**而不是 `containers`：
   *   ① 盒本身就是飞机的一个**空军基地**（容量无限、整备免费）⇒ 它决定任务航程
   *      （「从对应行入场，剩余航程 = 印刷航程 − 20/30 格」），任务判定在操作台/引擎这一侧；
   *   ② 它是**盘面状态**，必须进存档——原先记在 `containers` 里、不在任何快照字段表，
   *      于是"存档再读档，盒里的飞机就回到图上"（1.4a 的事实被静默丢掉）。
   * 用户 2026-10-30 口径：不可能没有空军基地（至少有图外的）；若剧本不允许用图外盒，
   * 或基地被占后航程不够飞去新基地，则该机**视为被摧毁**。
   */
  const airBoxMembers = ref<string[]>([])
  /** C7：参炸**飞机** id（与地面参炸单位分开收集；10.0e-F 的同类型限制由引擎裁决） */
  const barrageAirIds = ref<string[]>([])
  /** C7：摆放飞机的输入（机型 id + 基地格文本 `列.行`） */
  const airPlacement = ref<{ aircraftId: string | null; hexText: string }>({
    aircraftId: null,
    hexText: '',
  })

  // ── B27：通用「待点格」——凡是要一个格号的动作，都在**那一刻**让玩家点地图 ──

  /**
   * B27（用户口径 2026-09-16 #9）：
   * 「目前 UI 里需要玩家输入格子编号的所有项目全改为在该操作发生时玩家点击地图上格子作为选择，
   *   交互一定要简洁、有效、可靠」。
   *
   * 机制只有三件事：
   *   · `beginHexPick`：**由动作自己**声明"现在要选一个格"（用途名、规则号、候选、写回回调）；
   *   · `pickHexFor`：地图点击分派调它 —— 命中候选就写回并收态，否则就地一行提示；
   *   · `cancelHexPick`：Esc / 取消按钮退态。
   *
   * ★ 分层：候选与写回都由 **store 的动作**给出（`beginXxxHexPickNow(...)` 一族），组件只调它们；
   *   于是"这条规则的候选是什么"永远只有一处，组件里不会冒出第二个判据。
   * ★ 候选 `'any'` ＝ 合法性由**引擎在提交时**校验（13.6 的入场格由裁判按卡面判定、
   *   12.1b「任何含 SP 的位置都是补给站」…），此时地图不预筛也不铺高亮，只把"点哪儿"这件事
   *   从手打格号变成点一下。
   */
  const pendingHexPick = ref<PendingHexPick | null>(null)

  /** 待点格的界面投影（不含回调；组件只读它画提示与高亮） */
  const hexPickView = computed<{
    label: string
    rule: string
    candidates: HexPickCandidates
  } | null>(() => {
    const pick = pendingHexPick.value
    if (pick === null) return null
    return { label: pick.label, rule: pick.rule, candidates: pick.candidates }
  })

  /** 一句提示（地图内与流程条共用；没有待点态时为空串） */
  const hexPickHint = computed<string>(() => {
    const view = hexPickView.value
    if (view === null) return ''
    const where = view.candidates === 'any' ? '点地图上任意一格' : '点地图上高亮的格'
    return `正在选格：${view.label}（${view.rule}）｜${where}；Esc 取消`
  })

  /** 开始一次待点格（只有本 store 的动作会调） */
  function beginHexPick(pick: PendingHexPick): void {
    pendingHexPick.value = pick
    pushLog('info', `请在**地图上点一格**：${pick.label}（${pick.rule}）`, pick.rule)
  }

  /** 退掉待点态（Esc / 取消按钮） */
  function cancelHexPick(): boolean {
    const pick = pendingHexPick.value
    if (pick === null) return false
    pendingHexPick.value = null
    pushLog('info', `已取消选格：${pick.label}`, '—')
    return true
  }

  /** 格号文本（写回各输入用的统一格式：`列.行`） */
  function hexTextOf(hex: HexRef): string {
    return `${hex.col}.${hex.row}`
  }

  /**
   * 地图点了一格：若正在待点 ⇒ 命中即写回
   *
   * @returns 该次点击是否被待点态消费（false ⇒ 交回常规的地图点击分派）
   */
  function pickHexFor(hex: HexRef): boolean {
    const pick = pendingHexPick.value
    if (pick === null) return false
    const hit =
      pick.candidates === 'any' ||
      pick.candidates.some((candidate) => candidate.col === hex.col && candidate.row === hex.row)
    if (!hit) {
      pushLog(
        'warning',
        `${hexTextOf(hex)} 不是「${pick.label}」的候选格（${pick.rule}）`,
        pick.rule,
      )
      return true
    }
    if (!pick.apply(hex)) return true
    pendingHexPick.value = null
    return true
  }

  /* ────────── C8f：16.0b/c 环形工事的修建与缩减（＋专规 1.3a 印刷工事） ────────── */

  /*
   * B3-2b14（2026-11-21）：21 个声明搬进 `workbench-hedgehogs.ts`。
   * ★ 装配点**前移**到本位置（声明区原在 C8e 段之后）：`hedgehogInputs` 被下面 B27a 段的
   *   `beginHedgehogHexPickNow` 写、`hedgehogLevelOf` 与 `hedgehogHexState` 被 C5 的建域参数
   *   按值传——三处都在声明区之前。端口 29 项 = 13 依赖 + 16 返回。
   * ★ 13 项依赖里的 `requireAction` / `pushLog` / `dumpById` / `captureUndoSnapshot` /
   *   `dropUndoBySeq` / `engineerExecutorFor` / `constructionGateNow` / `noteConstruction` /
   *   `payConstructionFee` 全是 `function` 声明（提升），晚于本装配点也能按值传。
   */
  const hedgehogsDomain = createHedgehogsDomain({
    activeSide,
    date,
    units,
    session,
    pushLog,
    requireAction,
    deliverableDumpsFor,
    dumpById,
    captureUndoSnapshot,
    dropUndoBySeq,
    // 这 4 项在 b16 之后搬到 C8g 切片、其解构晚于本装配点（1765 < 2,1xx），
    // 故包成转发箭头：deps 在建域时按值取的是箭头本身，真正调用发生在其后（无 TDZ）。
    engineerExecutorFor: (engineer, target) => engineerExecutorFor(engineer, target),
    constructionGateNow: (task, engineer) => constructionGateNow(task, engineer),
    noteConstruction: (task, hex, engineerId) => noteConstruction(task, hex, engineerId),
    payConstructionFee: (dumpId, wantT, rule) => payConstructionFee(dumpId, wantT, rule),
  })
  const {
    hedgehogInputs,
    hedgehogExecutorMode,
    hedgehogEngineerId,
    hedgehogUsesEngineerRoute,
    hedgehogTargetHex,
    hedgehogEngineer,
    hedgehogEngineerLegRange,
    pickedHedgehogEngineer,
    hedgehogError,
    hedgehogTurnLedger,
    hedgehogLevelOf,
    hedgehogHexState,
    isPrintedHedgehogAt,
    printedHedgehogPositions,
    buildHedgehogNow,
    reduceHedgehogNow,
    hedgehogPayDumps,
    hedgehogPayPick,
    toggleHedgehogPayPick,
    pickHedgehogPayDumpNow,
  } = hedgehogsDomain

  /** 15.3 / 15.2A 的玩家输入（目标格 / 施工的工程单位 / 付款站） */
  const constructionInputs = ref<{
    hexText: string
    engineerId: string | null
    payDumpId: string | null
  }>({ hexText: '', engineerId: null, payDumpId: null })

  /* ── 各动作的待点格入口（B27a：目标状态已在 store 的那些） ── */

  /**
   * 13.6：到达投放的落点（★ 候选＝**卡面口径**，不是"任意格"）
   *
   * 13.6 的原文是「放置在它们的**入场格**中」⇒ 落点由卡面限定：`Entry K` 的条目只能落在
   * Entry K 那几格（被敌方堵住时按 13.6b 退到最近的未被阻挡边缘格）。
   * 修前候选是 `'any'` ⇒ 实测能把增援摆到地图任意一格（用户 2026-10-25 实测 BUG①）。
   * 候选为空（进死亡堆 / 没有友方空军基地 / 入口全关）⇒ **不进**待点态，并如实说明原因。
   */
  function beginArrivalHexPickNow(index: number): boolean {
    const allowed = arrivalCandidates.value[index] ?? []
    if (allowed.length === 0) {
      const detail = arrivalPlacements.value[index]?.detail ?? '该条目没有可放的格'
      pushLog('warning', `该到达条目**不能在地图上选格**：${detail}（13.6）`, '13.6')
      return false
    }
    beginHexPick({
      label: `增援到达落点（第 ${String(index + 1)} 条）`,
      rule: '13.6',
      candidates: [...allowed],
      apply: (hex) => {
        setArrivalHexOverride(index, hexTextOf(hex))
        return true
      },
    })
    return true
  }

  /**
   * 13.6：手牌式到达投放（2026-11-09）
   *
   * 点算子 → 地图高亮候选格 → 点格**立即投放**（省掉"再点投放"）；落点仍走既有候选与
   * `placeArrivalNow` 的校验，界面不自己算、不放宽。
   */
  function beginArrivalPlacePickNow(index: number, recordId?: string): boolean {
    // 1.6a 先于放置：强制移除未执行时不允许开始落位
    if (arrivalRemovalsPending.value) {
      reinforcementError.value = { rule: '1.6a', reason: 'arrivalRemovalsFirst' }
      return false
    }
    const allowed = arrivalCandidates.value[index] ?? []
    if (allowed.length === 0) {
      const detail = arrivalPlacements.value[index]?.detail ?? '该条目没有可放的格'
      pushLog('warning', `该到达条目**不能在地图上选格**：${detail}（13.6）`, '13.6')
      return false
    }
    beginHexPick({
      label: `增援落点（第 ${String(index + 1)} 条）`,
      rule: '13.6',
      candidates: [...allowed],
      arrivalIndex: index,
      apply: (hex) => placeArrivalNow(index, recordId, hexTextOf(hex)),
    })
    return true
  }

  /** 16.0b/c：环形工事的修建 / 缩减格（合法性由 `planHedgehogBuild` 在提交时判） */
  function beginHedgehogHexPickNow(purpose: 'build' | 'reduce'): void {
    beginHexPick({
      label: purpose === 'build' ? '修建环形工事的格' : '缩减环形工事的格',
      rule: purpose === 'build' ? '16.0b' : '16.0c',
      candidates: 'any',
      apply: (hex) => {
        hedgehogInputs.value = { ...hedgehogInputs.value, hexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /** 12.1b：新增补给站（任何含 SP 的位置都是补给站 ⇒ 候选任意格） */
  function beginSpDumpHexPickNow(): void {
    beginHexPick({
      label: '新补给站所在格',
      rule: '12.1b',
      candidates: 'any',
      apply: (hex) => {
        spDumpDraft.value = { ...spDumpDraft.value, hexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /** 12.6a①②：基础补给源声明（边缘铁路格等，合法性在提交时判） */
  function beginSupplySourceHexPickNow(): void {
    beginHexPick({
      label: '基础补给源所在格',
      rule: '12.6a',
      candidates: 'any',
      apply: (hex) => {
        supplySourceDraft.value = { ...supplySourceDraft.value, hexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /**
   * 13.3c/13.3e：点地图选**卸货格**（不再手打格号、也不再全图高亮）
   *
   * 候选与 `railMoveNow` 同源：只取本方的**可卸货城市格**，并用 `railPathBetween` 预筛掉
   * 走不通的终点（轨距/控制/敌军/EZOC 全交给同一条引擎判据）；点中后立即执行运货。
   */
  function beginRailMoveHexPickNow(kind: 'unit' | 'sp' | 'transportPoint'): void {
    const side = activeSide.value
    let from: HexRef | null = null
    if (kind === 'unit' || kind === 'transportPoint') {
      const unit = selectedUnit.value
      if (unit === null) {
        pushLog('warning', '铁路运货：请先在地图上选中要运输的单位（13.3e）', '13.3e')
        return
      }
      if (unit.side !== side) {
        pushLog('warning', `${unit.name} 不是本方单位（13.3b 只用本方铁路容量）`, '13.3b')
        return
      }
      from = unit.hex
    } else {
      const dump = spDumps.value.find((item) => item.id === railMoveInputs.value.fromDumpId) ?? null
      if (dump === null || dump.side !== side) {
        pushLog('warning', 'SP 铁路运货：请先指定**己方**的起运补给站（13.3a）', '13.3a')
        return
      }
      from = dump.hex
    }
    const candidates = detrainableHexes.value.filter(
      (hex) => !sameHex(hex, from!) && railPathBetween(from!, hex, side) !== null,
    )
    if (candidates.length === 0) {
      pushLog(
        'warning',
        '没有可卸货的铁路格（13.3c：须受控、轨距正确、铁路连通且免 EZOC）',
        '13.3c',
      )
      return
    }
    beginHexPick({
      label: '铁路运货的卸货格（13.3c 可卸货格）',
      rule: '13.3e',
      candidates,
      apply: (hex) => {
        railMoveInputs.value = { ...railMoveInputs.value, toHexText: hexTextOf(hex) }
        // 裁定 3：点目的地只**试算**，进确认窗；确认后才落盘扣点
        if (!railMoveNow(kind, true)) return false
        const preview = railMovePreview.value
        if (preview === null) return false
        pendingRailTransport.value = {
          kind,
          side,
          to: { ...hex },
          cost: preview.cost,
          label: `${hexLabel(from!)} → ${hexLabel(hex)}｜${preview.detail}`,
          rule: '13.3e',
        }
        return true
      },
    })
  }

  /** 14.1a：摆放飞机的空军基地格（候选＝本方**已有的**空军基地格，真能预筛） */
  function beginAirPlacementHexPickNow(): void {
    beginHexPick({
      label: '停放飞机的空军基地格',
      rule: '14.1a',
      candidates: ownAirBases.value.map((base) => ({ col: base.hex.col, row: base.hex.row })),
      apply: (hex) => {
        airPlacement.value = { ...airPlacement.value, hexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /** 14.11：飞机转移的目的地（航程在提交时判） */
  function beginAirTransferHexPickNow(): void {
    beginHexPick({
      label: '飞机转移的目的地',
      rule: '14.11',
      candidates: 'any',
      apply: (hex) => {
        airInputs.value = { ...airInputs.value, transferToHexText: hexTextOf(hex) }
        return true
      },
    })
  }

  /** 14.1c：返航到“其它己方基地”——只高亮剩余航程内的可用基地格 */
  function beginAirReturnBasePickNow(aircraftId: string): boolean {
    const choice = airMissionReturnChoices.value.find((item) => item.aircraftId === aircraftId)
    if (choice === undefined || choice.otherBases.length === 0) return false
    beginHexPick({
      label: '返航基地格',
      rule: '14.1c',
      candidates: choice.otherBases,
      apply: (hex) => {
        airInputs.value = {
          ...airInputs.value,
          returnHexText: { ...airInputs.value.returnHexText, [aircraftId]: hexTextOf(hex) },
          returnToBox: omitRecordKey(airInputs.value.returnToBox, aircraftId),
        }
        return true
      },
    })
    return true
  }

  /** 14.1c / 专规 1.4a：返航三选一——出发基地（图上基地或原图外盒） */
  function chooseAirReturnDepartureNow(aircraftId: string): boolean {
    const choice = airMissionReturnChoices.value.find((item) => item.aircraftId === aircraftId)
    if (choice === undefined || !choice.departureAvailable) return false
    if (choice.fromBox) {
      airInputs.value = {
        ...airInputs.value,
        returnToBox: { ...airInputs.value.returnToBox, [aircraftId]: true },
        returnHexText: omitRecordKey(airInputs.value.returnHexText, aircraftId),
      }
      return true
    }
    airInputs.value = {
      ...airInputs.value,
      returnHexText: {
        ...airInputs.value.returnHexText,
        [aircraftId]: hexTextOf(choice.departureHex),
      },
      returnToBox: omitRecordKey(airInputs.value.returnToBox, aircraftId),
    }
    return true
  }

  /** 专规 1.4a：返航三选一——移入图外空军盒（点即移入，不高亮地图） */
  function chooseAirReturnOffMapBoxNow(aircraftId: string): boolean {
    const choice = airMissionReturnChoices.value.find((item) => item.aircraftId === aircraftId)
    if (choice === undefined || !choice.offMapBoxAvailable) return false
    airInputs.value = {
      ...airInputs.value,
      returnToBox: { ...airInputs.value.returnToBox, [aircraftId]: true },
      returnHexText: omitRecordKey(airInputs.value.returnHexText, aircraftId),
    }
    return true
  }

  /** 15.2A / 15.3：修建空军基地 / 简易机场升格的格（工程兵距离在提交时判） */
  function beginAirBaseHexPickNow(): void {
    beginHexPick({
      label: '修建 / 升格空军设施的格',
      rule: '15.2A / 15.3',
      candidates: 'any',
      apply: (hex) => {
        constructionInputs.value = { ...constructionInputs.value, hexText: hexTextOf(hex) }
        return true
      },
    })
  }

  // ── C8 补给交互与 SP 管理（W5 C8：OCS 12.0 章；引擎状态机在 supply-interaction.ts） ──
  /**
   * C8：补给工具是否已开启
   *
   * ★ 用户口径：正式游戏界面里**必要模块默认开启**（补给是每回合必做的判定，
   * 不该让玩家先找开关）⇒ 默认 `true`。
   */
  const supplyActive = ref(true)
  /** C8：SP 账本（12.1b：含 SP 的位置即补给站；12.1a 的拆分/加总在此逐条结算） */
  const spDumps = ref<SpDump[]>([])
  /**
   * 14.9（T16）：图外空军盒补给库存账本，键为 `${side}:${box}`，只记账不设上限（数据缺口）。
   * 旧存档（v6）缺该键 ⇒ 读成 `{}`，不报错、不动 `spDumps`。
   */
  const offMapSupplyStocks = ref<Record<string, SpHoldings>>({})
  /** C8：基础补给源声明（12.6a①②；来自专规/剧本，操作台由玩家声明） */
  const supplySourceDecls = ref<SupplySourceDecl[]>([])
  /** C8：正在做补给检查的单位实例 id */
  const supplyUnitId = ref<string | null>(null)
  /** C8：补给交互状态机（null＝未开始） */
  const supplyState = ref<SupplyInteractionState | null>(null)
  /** C8：最近一次被引擎拒绝的步骤（供界面提示；成功后清空） */
  const supplyError = ref<{ rule: string; reason: string } | null>(null)
  /** C8：玩家在本次补给交互里的各项输入（界面 v-model 绑定） */
  const supplyInputs = ref<SupplyInputs>(createSupplyInputs())
  /** C8：界面上悬停预览的来源序号（用于把该来源的覆盖范围画到地图上；null＝用已选来源） */
  const supplyPreviewIndex = ref<number | null>(null)
  /** C8：新增 SP 账本条目的输入（格号文本 + SP/T 数 + 3.4b 装甲集群） */
  const spDumpDraft = ref<{
    hexText: string
    sp: number
    t: number
    /** 3.4b：解除日前的德军新到 SP 归属（`null`/缺省＝未选，落账会被拒） */
    panzerGroup?: PanzerGroup | null
  }>({ hexText: '', sp: 1, t: 0, panzerGroup: null })
  /** C8：新增基础补给源声明的输入（格号文本 + 类别） */
  const supplySourceDraft = ref<{ hexText: string; kind: BaseSourceKind }>({
    hexText: '',
    kind: 'supplySourceHex',
  })

  /*
   * B3-2b11（2026-11-21）：C8 的 SP 账本（`addSpAtHex` 等 10 个动作）搬进 `workbench-supply-dumps.ts`。
   * 装配**必须在 air 域装配段之前**（`const airDomain = createAirDomain`）：`addSpAtHex` 是 air 的端口，
   * `setSpDumpHoldings` 也被紧随其后的一个域收走 ⇒ 收它的域在前，本域就必须更前。
   * 三个晚声明状态：`panzerGroupRulesOn`（3.4b 段的 computed ⇒ getter）、
   * `spDumpPanzerGroups` / `pendingSpGroupAssignment`（3.4b 段的两个 `ref`，本块只整体重置 ⇒ 写穿回调）。
   */
  const supplyDumpsDomain = createSupplyDumpsDomain({
    spDumps,
    spDumpDraft,
    activeSide,
    units,
    pushLog,
    acceptSupply,
    releaseSpRelayLocks,
    panzerGroupOfDump,
    setDumpPanzerGroupNow,
    panzerGroupRulesOn: () => panzerGroupRulesOn.value,
    resetSpDumpPanzerGroups: () => {
      spDumpPanzerGroups.value = {}
    },
    resetPendingSpGroupAssignment: () => {
      pendingSpGroupAssignment.value = []
    },
  })
  const {
    addSpAtHex,
    addSpDump,
    setSpDumpDraftGroup,
    removeSpDump,
    landSetupSpDumps,
    clearSpDumps,
    setSpDumpHoldings,
    mergeSpDumpHoldings,
    grantSpDumpT,
    splitSpDumpHoldings,
  } = supplyDumpsDomain

  /* ────────── 13.8d 施工前提与付款（15.3 / 15.2A / 16.0b 共用，B3-2b16） ────────── */

  /*
   * B3-2b16（2026-11-21）：13.8d 的账本 / 公共前提 / 付款唯一入口搬进 `workbench-construction.ts`。
   * ★ `constructionInputs` 留在 facade（见上方前移处）：B27a 的 `beginAirBaseHexPickNow` 在声明区之前写它；
   *   前移声明后作为端口按值传。`setSpDumpHoldings`（b11）已解构；`pickedEngineer` 见下方转发箭头
   *   （B3-2b17 起它已搬进空中设施切片）。
   * ★ 端口 21 项 = 8 依赖 + 13 返回。
   */
  const constructionDomain = createConstructionDomain({
    constructionInputs,
    // pickedEngineer 已在 B3-2b17 搬走（解构晚于本装配点）⇒ 转发箭头
    pickedEngineer: () => pickedEngineer(),
    activeSide,
    phase,
    pushLog,
    dumpById,
    deliverableDumpsFor,
    setSpDumpHoldings,
  })
  const {
    constructionLedgers,
    constructionLedgerOf,
    constructionError,
    constructionPayDumps,
    constructionPayPick,
    toggleConstructionPayPick,
    pickConstructionPayDumpNow,
    constructionLegRangeTo,
    engineerExecutorFor,
    constructionGateNow,
    noteConstruction,
    constructionFeeT,
    payConstructionFee,
  } = constructionDomain

  /* ── C8b：D 段**补给阶段总计划**（12.1–12.2 / 12.6 / 12.8 / 12.10e） ── */

  /**
   * 本阶段的补给阶段计划（引擎 `planSupplyPhase` 的结论；null＝尚未载入）
   *
   * 顺序由引擎给死（12.10e-A：**恢复优先于以 SP 代 trace**）：
   *   ① 部队储备强制恢复 → ② 逐单位补给评估（12.6）→ ③ 吃图上补给分配（12.6c）
   *   → ④ 断补标记置/除（12.6d）→ ⑤ 需掷损耗的堆叠（12.8a/b）。
   */
  const supplyPhaseDomain = createSupplyPhaseDomain({
    units: () => units.value,
    activeSide: () => activeSide.value,
    turn: () => turn.value,
    facts: () => supplyFacts.value,
    step: () => segmentStep.value?.id,
    enterCheck: () =>
      setSegmentStepIndex(playerSegmentSteps.value.findIndex((step) => step.id === 'supply.check')),
    requireAction,
    actionAllowedNow,
    deliverableDumpsFor,
    /**
     * 12.6c / 12.3a·b：D 段供养的付款来源事实（工作台只提交事实，取整规则在引擎算）。
     *
     * 组键＝该单位**可达补给站 id 的有序集合**（与 `payFromUnitReachableDumps` 同一个
     * `deliverableDumpsFor`）：同一组才共享 12.6c 的批量取整额度；部分重叠或完全不同来源
     * 各自起批，避免把甲站已付过的 1T 零头借给乙站的单位免费解除断补。
     * `availableT` 取这些站的实际持有量，不采用玩家输入的数字。
     */
    feedingSources() {
      const facts: Record<string, { sourceKey: string | null; availableT: number }> = {}
      for (const unit of units.value) {
        if (unit.side !== activeSide.value || !unit.isCombat) continue
        const dumps = deliverableDumpsFor(unit.side, [unit])
        facts[unit.instanceId] = {
          sourceKey:
            dumps.length === 0
              ? null
              : dumps
                  .map((dump) => dump.id)
                  .sort()
                  .join('|'),
          availableT: dumps.reduce((sum, dump) => sum + holdingsToT({ sp: dump.sp, t: dump.t }), 0),
        }
      }
      return facts
    },
    payFromSideDumps,
    payFromUnitReachableDumps,
    markTraceSupply,
    markSustainedBySpecialSupply,
    // 12.6：唯一判定入口写下的本回合结论（逐单位检查 / 阶段末总计划共读）
    traceSettlementStatus() {
      const settlement = traceSettlement.value
      return settlement !== null && settlement.turn === turn.value ? settlement.byUnit : {}
    },
    eliminateEntry,
    pushLog,
    recordSettlement,
    rollDice() {
      const draw = roll2d6(rng.value)
      rng.value = draw.rng
      drawCount.value += 1
      return draw.value.total
    },
  })
  const {
    supplyPhasePlan,
    supplyFeedingCandidates,
    supplyRecoverySettled,
    supplyFeedingSettled,
    supplyRecoveryOutcome,
    supplyFeedingOutcome,
    attritionAppliedHexes,
    supplyPhaseError,
    supplyPhaseInputs,
    attritionInputs,
    attritionResults,
    attritionNeedsAllocation,
    supplyPhaseAvailableCap,
  } = supplyPhaseDomain
  /** 12.11a：本阶段各补给站的销毁尝试次数（每阶段每站只能尝试一次） */
  const dumpDestructionAttempts = ref<Record<string, number>>({})

  /* ────────── C8g 空中设施（15.3 / 15.4 / 15.2A，B3-2b17） ────────── */

  /*
   * B3-2b17（2026-11-21）：15 项空中设施声明搬进 `workbench-air-facility.ts`。
   * ★ 装配点必须早于 air 建域——`createAirDomain` 的 `airUnloadedTAt` 是**按值** deps（建域即求值）。
   * ★ `airstripBaseIds` / `airBases` 来自 air 域解构（本处之后）⇒ deps 给 getter，切片不解构它们。
   * ★ `pickedEngineer` 随本批搬走 ⇒ b16 的施工域构造处改成转发箭头。
   * ★ 端口 31 项 = 18 依赖 + 13 返回（placeAirBaseOperator 只被切片内部的 build* 用 ⇒ 不 return）。
   */
  const airFacilityDomain = createAirFacilityDomain({
    activeSide,
    units,
    spDumps,
    constructionInputs,
    pushLog,
    requireAction,
    captureUndoSnapshot,
    dropUndoBySeq,
    isConstructionMarkerAirBaseId,
    canEngineerInPhase,
    constructionError,
    constructionFeeT,
    constructionGateNow,
    noteConstruction,
    engineerExecutorFor,
    payConstructionFee,
    get airstripBaseIds() {
      return airstripBaseIds
    },
    get airBases() {
      return airBases
    },
  })
  const {
    airBaseTurnLedger,
    airUnloadLedger,
    airUnloadedTAt,
    engineerChoices,
    airBaseUnitAt,
    isAirstripAt,
    airBaseLevelAt,
    hexHasAirFacility,
    airBaseBuildCostSpPerLevel,
    pickedEngineer,
    buildAirBaseNow,
    buildAirstripNow,
    upgradeAirstripNow,
  } = airFacilityDomain

  /* ────────── C8 补给标签（12.3 / 12.6 / 12.7 的界面文案，B3-2b18） ────────── */

  /*
   * B3-2b18（2026-11-21）：6 个声明搬进 `workbench-supply-labels.ts`（含 `SUPPLY_STATUS_LABELS` 常量）。
   * ★ 4 个依赖全是 `function` 声明（提升）、6 处调用（`placeAt` / `removeAt` 的摆子钩子、
   *   `addSupplySource` / `beginSupplyCheckNow` / `chooseSupplySourceNow` / `pickSupplySourceAtHexNow`
   *   的日志文案 + store 返回）全在运行期 ⇒ 无 TDZ 约束，装配点就近选在此处。
   * ★ `affectsSupplyNet` 不在公开面，但摆子钩子要用 ⇒ 仍 return 并解构。
   * ★ 端口 9 项 = 4 依赖 + 5 返回。
   */
  const supplyLabelsDomain = createSupplyLabelsDomain({
    clearSupply,
    dumpById,
    pushLog,
    supplyStockLabelOf,
  })
  const {
    affectsSupplyNet,
    cancelSupply,
    supplySourceKindLabel,
    supplySourceLabel,
    supplyStatusLabel,
  } = supplyLabelsDomain

  /* ────────── C9 空军原语（14.1a / 14.1b / 14.2e 与掷骰，B3-2b19） ────────── */

  /*
   * B3-2b19（2026-11-21）：7 个声明搬进 `workbench-air-primitives.ts`（57 行零改写）。
   * ★ 装配点必须**早于** `createAirDomain`：它的 deps 按值吃 setAirStatus / markAirMissionFlown /
   *   drawAir2d6 / applyAirStepLoss / drawAir1d6（建域即求值）。
   * ★ fire 域（`createFireResolutionDomain`）更早，按值吃 applyAirStepLoss ⇒ 那一处改转发箭头。
   * ★ `airStatusLabel` 来自 air 域解构（晚于本处）⇒ deps 给转发箭头。
   * ★ 端口 13 项 = 6 依赖（5 按值 + 1 箭头）+ 7 返回。
   */
  const airPrimitivesDomain = createAirPrimitivesDomain({
    airUnits,
    rng,
    drawCount,
    pushLog,
    eliminateEntry,
    airStatusLabel: (status) => airStatusLabel(status),
  })
  const {
    setAirStatus,
    applyAirStepLoss,
    markAirMissionFlown,
    toggleAirUnitStatus,
    drawAir2d6,
    drawAir1d6,
    drawD6,
  } = airPrimitivesDomain

  // ── C9 空军交互（W6 C9：OCS 14.0 / 15.0；引擎状态机在 air-interaction.ts） ──
  // ── B2-1：空军状态 + 派生已搬进 workbench-air（25 端口，其中 5 项晚绑定走 getter） ──
  const airDomain = createAirDomain({
    activeSide,
    rng,
    units,
    selectedId,
    airUnits,
    offMapSupplyStocks,
    pushLog,
    recordSettlement,
    nameOf,
    setAirInBoxMembership,
    addSpAtHex,
    airUnloadedTAt,
    acceptAir: <T>(outcome: RuleOutcome<T>, action: string) => acceptAir(outcome, action),
    setAirStatus,
    markAirMissionFlown,
    drawAir2d6,
    constructionMarkerAirBaseId,
    // B2-2b：按值（声明早于建域点，或函数声明可提升）
    barrageState,
    beginHexPick,
    hexTextOf,
    setAirTargetFromText,
    declareInterceptionNow,
    resolveInterceptionCombatNow,
    // B2-2c：按值（轰炸链动作为函数声明可提升；三个 ref 早于建域点）
    barrageInputs,
    barrageKind,
    barrageTargetKind,
    barrageUnitIds,
    barragedHexesThisPhase,
    barragedUnitIdsThisPhase,
    barrageAirIds,
    canReplaceBarrage,
    clearBarrage,
    beginBarrageNow,
    confirmBarrageSupplyStep,
    confirmBarrageShiftsStep,
    confirmBarrageLossNow,
    rollBarrageDiceStep,
    confirmBarrageOutcomeStep,
    // B2-2c 晚绑定：声明晚于建域点（3644 / 27646 / 27648），用访问器传
    get barragePickHex() {
      return barragePickHex
    },
    get barrageLossRequired() {
      return barrageLossRequired
    },
    get barrageLossReady() {
      return barrageLossReady
    },
    // 晚绑定：声明在 4192–27836，用访问器传，切片只在 computed 求值时取值
    get zocOnlySupplyFacts() {
      return zocOnlySupplyFacts
    },
    get segmentGateQuery() {
      return segmentGateQuery
    },
    get constructionMarkerPieces() {
      return constructionMarkerPieces
    },
    phase,
    airBoxMembers,
    hqDeliveryDumpKeys,
    actionAllowedNow,
    isConstructionMarkerAirBaseId,
    turn,
    groundMovement,
    moveInteraction,
    spDumps,
    supplyState,
    clearMoveInteraction,
    refuseWhileSettling,
    eliminateEntry,
    applyAirStepLoss,
    drawAir1d6,
    requireAction,
    noteUnitEnteredHex,
    // B2-2d：按值（建域点前声明 / 可提升函数声明）
    captureUndoSnapshot,
    dropUndoBySeq,
    setSpDumpHoldings,
    clearAir: () => clearAir(),
    AIR_MISSION_KIND_LABELS,
    AIR_STATUS_LABELS,
    // 晚绑定（B2-2a）：声明在 3682–22425，晚于建域点
    get barrageFacts() {
      return barrageFacts
    },
    get railMoveFacts() {
      return railMoveFacts
    },
    get airUnloadLedger() {
      return airUnloadLedger
    },
    get airMissionJoinChoices() {
      return airMissionJoinChoices
    },
    get specialPending() {
      return specialPending
    },
    get airMissionSegmentKind() {
      return airMissionSegmentKind
    },
    get airMissionKindChoices() {
      return airMissionKindChoices
    },
    get allSpDumps() {
      return allSpDumps
    },
    get supplyFacts() {
      return supplyFacts
    },
  })
  const {
    airActive,
    airMissionKind,
    airTargetHex,
    airMissionAirIds,
    airMissionAbortPending,
    airSupply,
    airSupplyManifest,
    airUnitTransit,
    airUnitCargoManifest,
    airMissionDomain,
    airState,
    airError,
    airCargoUnloadReceipt,
    airCargoUnloadChoices,
    airInputs,
    refitDoneBaseIds,
    refitTargetBaseId,
    refitStage,
    transferMode,
    transferFromBox,
    transferSelectedIds,
    reducedBaseIds,
    airstripBaseIds,
    lastRefit,
    lastTransfer,
    lastReduction,
    airActingSide,
    allAirViews,
    ownAirUnits,
    airBases,
    ownAirBases,
    airTransportProfiles,
    airOverLimitAircraftInactive,
    airMissionAirUnits,
    airMissionRosterNow,
    airMissionFlyingUnits,
    airMissionReturnOrigins,
    airMissionReturnChoices,
    airReturnSelectionLabel,
    airReturnChosen,
    airCombatAttackerPlanes,
    airCombatDefenderPlanes,
    airCombatRoundBudget,
    airInterceptionDefender,
    toggleAirCargoUnit,
    airCargoUnitChoices,
    airMissionHasFighter,
    airChecklist,
    airTargetInEnemyPatrolZone,
    airInterceptionResponse,
    airInterceptorCandidates,
    airTargetBaseLevel,
    airTargetBaseIsAirstrip,
    airEnemyAtTarget,
    capturableEnemyAirBases,
    airPatrolZoneHexes,
    airEnemyPatrolZoneHexes,
    airInactiveAtBase,
    airRefitPayDumps,
    airReductionCandidates,
    refitDoneBases,
    refitBase,
    refitCandidates,
    refitSelectedIds,
    refitSelectLimit,
    refitPayDumps,
    refitPayNeedT,
    transferBase,
    transferCandidates,
    transferBoxReady,
    transferBaseCandidates,
    transferHasBoxOption,
    transferHasBaseOption,
    canTransferAirToBaseNow,
    beginTransferNow,
    toggleTransferAircraft,
    cancelTransferNow,
    completeTransferToBaseNow,
    refitStartBases,
    refitAirbaseHexes,
    refitBlockReasonAt,
    reducedBases,
    beginAirMissionNow,
    confirmAirCombatNow,
    isAirInOffMapBox,
    onMapAirUnits,
    airUnitsAt,
    airTypeCanPerformKind,
    canAirMissionTarget,
    airMissionTargetCandidates,
    airDistanceFromRealBase,
    resolveAirCargoNow,
    captureAirBaseNow,
    // B2-2b
    airMissionCargoCapacityNow,
    airCargoLossPending,
    airCargoLossPicked,
    toggleAirCargoLossPick,
    confirmAirCargoLossNow,
    hasCargoOwnership,
    resolveFlakNow,
    beginAirTargetHexPickNow,
    runAirMissionNow,
    autoResolveAirMissionNow,
    // B2-2c：搬走后回补（区外仍引用）
    confirmAirMissionNow,
    completeAirReturnNow,
    beginAirBarrageNow,
    settleAirMissionNow,
    recordAbortedAirBarrage,
    // B2-2d：搬走后回补（区外仍引用）
    cancelAir,
    toggleAirstripBase,
    refitBaseNow,
    beginRefitNow,
    confirmRefitSelectionNow,
    toggleRefitAircraft,
    cancelRefitNow,
    pickRefitPayDump,
    confirmRefitPaymentNow,
    transferAircraftNow,
    toggleAirReductionUnit,
    reduceBaseNow,
    airMissionKindLabel,
    airStatusLabel,
  } = airDomain
  /*
   * 14.1f / 专规 1.5：**天气是 Pre-Turn 掷出来的盘面事实**（`records.weather`），不是玩家的第二份输入。
   * 修前「天气正常」复选框只由玩家手动勾——换回合后天气在记录轨里已经变了，空军面板仍沿用上一回合的
   * 勾选（受限飞行时会误放行反应/进击段任务与低空扫射，或反过来把正常天气当受限）。天气一变即同步。
   * 无会话（未开局演练）时 `records` 为 null，保留手动输入。
   */
  watch(
    () => session.records?.weather.air ?? null,
    (air) => {
      if (air === null) return
      airInputs.value.weatherNormal = air === 'normal'
    },
    { immediate: true },
  )

  /* ────────── C9 空军状态原语（14.0 开关 / 15.x 收束 / 统一收引擎结论，B3-2b20） ────────── */

  /*
   * B3-2b20（2026-11-21）：3 个声明搬进 `workbench-air-state.ts`（40 行零改写）。
   * ★ 装配点选在 `} = airDomain` 之后：11 个状态与 `airMissionDomain` 全部已解构 ⇒ 按值传、零改写。
   * ★ air 域 deps 的 `acceptAir` / `clearAir` 原本吃 function 声明（提升），搬走后提升消失
   *   ⇒ 这两处改转发箭头（`acceptAir` 是泛型，箭头必须显式写 `<T>`），建域期只构造不求值。
   * ★ 端口 16 项 = 13 依赖 + 3 返回；`createAirInputs` 直接 import model，不进端口。
   */
  const airStateDomain = createAirStateDomain({
    airActive,
    airMissionAirIds,
    airMissionAbortPending,
    airTargetHex,
    airInputs,
    airState,
    airError,
    lastRefit,
    lastTransfer,
    lastReduction,
    refitTargetBaseId,
    airMissionDomain,
    pushLog,
  })
  const { setAirActive, clearAir, acceptAir } = airStateDomain

  // ── 派生 ──
  /** 选中的算子 */
  const selectedUnit = computed(
    () => units.value.find((unit) => unit.instanceId === selectedId.value) ?? null,
  )
  /** 当前方可选的单位库记录 */
  const choices = computed(() => unitChoices(activeSide.value))
  /**
   * 13.8b：**架桥生效格**（按归属）——有工程能力的本方单位所在格 + 建造标记的「桥」面
   *
   * 修前 `bridgedCrossing` 在 `src/` 内**零调用**：规则写了、单测测了，但走路时没人用 ⇒
   * 大河/小河永远按原价收费，"HQ 在河边架桥"这条规则整局不生效。这里把它接进移动上下文与战斗事实
   * 的**同一份**判据（"能走过去"与"能打过去"必须同源）。
   * ★ 判据只用**模式级**的 `canEngineer`（`bridgedHexesBySide` 内部），不用 `canEngineerInPhase`：
   *   后者要 `moveContext` 当输入，而本 computed 正是它的一部分（会成环）。
   */
  const bridgedHexes = computed(() =>
    bridgedHexesBySide(
      units.value,
      constructionMarkerPieces.value
        .filter((piece) => piece.kind === 'bridge')
        .map((piece) => piece.hex),
    ),
  )
  /**
   * 13.8b 末句例外：**按单位**的自有桥格（`unitId → hex`）
   *
   * 「具有工程能力的单位在通过切换模式或朝向而失去工程能力后，可以**使用自己架的桥离开该格**。」
   * ⇒ 只在"因模式/朝向切换而失能"那一刻记下当时的格；该单位离开该格后清除（重返不再享受降费）。
   * 瞬时事实，不进存档；只有**该单位自己**能消费（见 `MoveContext.ownBridgeHexByUnitId`）。
   */
  const ownBridgeHexByUnitId = ref<Record<string, HexRef>>({})

  /** 清掉某单位的自有桥记录（恢复工程能力、或已离开该格时） */
  function clearOwnBridgeHex(unitId: string): void {
    if (!(unitId in ownBridgeHexByUnitId.value)) return
    const next = { ...ownBridgeHexByUnitId.value }
    delete next[unitId]
    ownBridgeHexByUnitId.value = next
  }

  /**
   * 13.8b 末句例外：切换**之后**结算这次能力变化
   *
   * `wasCapable` 由调用方在 `applyModeSwitch` / `flipOrientation` **之前**取（13.8a 的 `canEngineer`）。
   * 由真变假 ⇒ 记下当时所在格；由假变真 ⇒ 桥恢复为常规架桥格，记录不再需要。
   */
  function noteEngineerCapabilityAfter(unit: ConsoleUnit, wasCapable: boolean): void {
    const nowCapable = engineerCapableNow(unit)
    if (wasCapable && !nowCapable && unit.hex !== null) {
      ownBridgeHexByUnitId.value = {
        ...ownBridgeHexByUnitId.value,
        [unit.instanceId]: { ...unit.hex },
      }
      return
    }
    if (nowCapable) clearOwnBridgeHex(unit.instanceId)
  }

  /** 单位离开记录格 ⇒ 清记录（例外的授权只到"离开该格"为止） */
  function noteUnitLeftOwnBridgeHex(unit: ConsoleUnit): void {
    const recorded = ownBridgeHexByUnitId.value[unit.instanceId]
    if (recorded === undefined) return
    if (unit.hex !== null && sameHex(recorded, unit.hex)) return
    clearOwnBridgeHex(unit.instanceId)
  }
  // `scenarioTurnRange` 每次都要查剧本库 + 扫回合轨；`moveContext` 会逐单位调用，故先用 computed 缓存
  const scenarioFirstTurn = computed(() => scenarioTurnRange(scenarioId.value).firstTurn)
  const sovietFirstTurnHalfMaActive = computed(
    () =>
      session.scenarioInfo?.sovietFirstTurnHalfMa !== undefined &&
      turn.value === scenarioFirstTurn.value,
  )

  /**
   * 专规 1.5 / 剧本 1–2：苏方**地面单位**在剧本首回合以 1/2 MA 移动
   *
   * 原文「The Soviets are in disarray, so all of their ground units move at 1/2 MA on the first
   * turn. This can be further adjusted by mode effects (e.g., DG).」
   * ⇒ 仅当剧本顶层数据位 `sovietFirstTurnHalfMa` 存在、阵营为苏方、且当前回合 = 本剧本首回合
   *   时返回 0.5；其余 1。与模式折算**相乘**（`availableMa` 内完成），6.1h 不取整。
   * 本 store 的 `units` 只含地面单位（飞机在 `airUnits`）⇒ 无需再判空地。
   */
  function sovietFirstTurnMaFactor(unit: ConsoleUnit): number {
    if (unit.side !== 'soviet') return 1
    // 教学局关掉「苏军首回合 ×1/2」这条剧本专规（见 tutorial-settings 的说明）
    if (tutorialSovietFirstTurnFullMa.value) return 1
    return sovietFirstTurnHalfMaActive.value ? FIRST_TURN_HALF_MA_MULT : 1
  }

  /**
   * 14.8b / 14.8c：运输破坏标记按**放置方**分组
   *
   * 「运输破坏区会影响**敌方**地面单位的移动……每进入一个处于 TZ 中的格 +1MP」⇒ 引擎按
   * 「移动方 ≠ 放置方」取用；这里只把账本上的标记整理成引擎要的形状（标记格，不含邻格——
   * 邻格的 TZ 判定与 14.8b 的步行例外都在 `move.ts` 里一处算）。
   */
  const trainbustingMarksByPlacer = computed<{
    axis: HexRef[]
    soviet: HexRef[]
  }>(() => {
    const out: { axis: HexRef[]; soviet: HexRef[] } = { axis: [], soviet: [] }
    for (const mark of trainbustingMarks.value) {
      out[mark.side].push({ col: mark.hex.col, row: mark.hex.row })
    }
    return out
  })

  /**
   * 剧本**活动区**格集（用户 2026-11-15 口径：限定在截图内可见的六角格）
   *
   * 读数只从剧本走（`scenarios[].playArea.hexes`，逐格清单，不用包围盒推导）；
   * 缺省（未声明）= 全图不限。范围外的格不删、照旧渲染，只是不可进入。
   */
  const playAreaHexes = computed<HexRef[] | undefined>(() => {
    const declared = session.scenarioInfo?.playArea?.hexes
    if (declared === undefined) return undefined
    return declared.flatMap((text) => parseHexPath(text))
  })

  /** 当前移动上下文（每次派生都重建，保证与摆子/切方一致） */
  const moveContext = computed(() =>
    buildMoveContext({
      units: units.value,
      activeSide: activeSide.value,
      // F 战斗段与 A 整备段没有移动环节（2.2）：映射为 movement 只为给 computed 一个合法值，
      // 移动本身已在 moveOneStep 里按非移动段明确拦下。
      phase: movementPhaseOf(phase.value),
      // 专规 1.1b：敌方安全边缘格（作为补给源的地图边格）不得被敌方地面单位进入
      safeEdgeHexesBySide: safeEdgeHexesBySide.value,
      // 13.8b：架桥（与 createBattleFacts 同一份，见上面的 computed）
      bridgedHexesBySide: bridgedHexes.value,
      // 13.8b 末句例外：因模式/朝向切换而失能的单位，可用**自己架的桥**离开该格
      ownBridgeHexByUnitId: ownBridgeHexByUnitId.value,
      /*
       * 5.8b：战略模式单位**必须**在有追溯补给的格上结束移动。
       * 引擎的判据写在 `move.ts`，但要求调用方注入 `traceSupplyAt` —— 不注入则那条 if
       * 永远进不去（修前实测：战略模式单位可以随便停在断补格）。
       * 这里注入的是与 12.6 同一份事实（`createTraceSupplyAt(supplyFacts)`，见 C9 段）。
       */
      traceSupplyAt: (hex, side) => traceSupplyAtForMove.value(hex, side),
      /*
       * 5.7g（用户 2026-11-01 口径）：预备单位**不能进工事格**。
       * 工事等级取与工事面板同一处（`hedgehogLevelOf`：印刷永久工事 + 本回合已建 − 已降）。
       */
      hedgehogLevelAt: (hex) => hedgehogLevelOf(hex),
      // 14.8b/14.8c：运输破坏区（对放置方的敌方地面单位 +1 MP/格；含 8.1 突袭进格）
      trainbustingMarksBySide: trainbustingMarksByPlacer.value,
      // 4.5a-A（R9）：突袭进 ZOC 后「不得离开」的事实（引擎据此拦普通走法；再突袭不受限）
      ...(zocHeldFact.value === undefined ? {} : { zocHeld: zocHeldFact.value }),
      // 剧本活动区（用户 2026-11-15 口径）：范围外不可进入；未声明即全图不限
      ...(playAreaHexes.value === undefined ? {} : { playAreaHexes: playAreaHexes.value }),
      // 专规 1.5：首回合苏军地面单位 ×1/2（与模式折算相乘）
      maFactorOf: sovietFirstTurnMaFactor,
    }),
  )
  /** 已选定交战的守方单位（9.3b/9.6 用；按实例 id 保持摆放顺序） */
  const battleDefenders = computed<ConsoleUnit[]>(() => {
    const target = battleTarget.value
    if (target === null) return []
    return target.defenderIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
  })

  /* ── C6 战斗交互：派生（一切结论来自引擎；此处只做视图整形） ── */

  /**
   * C6：参战攻方单位
   *
   * 未开始时＝玩家点选集合（9.1b 可取堆叠的一部分）；已开始时＝构成锁定后的名单
   * （9.5b 允许在付不出全额补给时**减少参战单位**，故以 `composition` 为准）。
   */
  const combatAttackers = computed<ConsoleUnit[]>(() => {
    const state = combatState.value
    const ids = state === null ? combatAttackerIds.value : state.composition.attackerIds
    return ids
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
  })

  /** C6：防御方阵营（9.4e 的 AT 判定只取该方单位；攻方即当前方，故守方为其对手） */
  const combatDefenderSide = computed<Side>(() => {
    const first = battleDefenders.value[0]
    if (first !== undefined) return first.side
    return activeSide.value === 'axis' ? 'soviet' : 'axis'
  })

  /**
   * 6.3a / 7.0a：本阶段**行动方**
   *
   * 反应段由**非**阶段玩家行动（`activeSide` 仍是阶段玩家），其余段两者相同。
   * 突袭的「我方/敌方」取子、4.5a 的 ZOC 判定、推进的安全边缘格与 9.14 结算都必须用它，
   * 不能用 `activeSide`——否则反应段会把阶段玩家的守军滤掉（7.0b 的突袭走不通）。
   * 与 `segmentGateQuery.side` 同源（`actingSideFor` 是唯一实现）。
   */
  const actingSide = computed<Side>(
    () => actingSideFor({ phase: phase.value, activeSide: activeSide.value }) ?? activeSide.value,
  )

  /** C6：攻方/守方单位视图（引擎 `BattleUnitView`；随落盘自动刷新） */
  const combatAttackerViews = computed<BattleUnitView[]>(() =>
    combatAttackers.value.map((unit) => toBattleUnitView(unit, turn.value)),
  )
  const combatDefenderViews = computed<BattleUnitView[]>(() =>
    battleDefenders.value.map((unit) => toBattleUnitView(unit, turn.value)),
  )

  /** C6：战斗事实（9.1f/9.4b/9.4c/9.4e/9.9）——取自地图产物与单位库，不臆造 */
  const combatFacts = computed(() =>
    createBattleFacts({
      units: units.value,
      defenderSide: combatDefenderSide.value,
      // 13.8b：与 moveContext 用**同一份**架桥格（否则"能走过去"与"能打过去"会不一致）
      bridgedHexesBySide: bridgedHexes.value,
      /*
       * 9.1c：本战斗环节的攻击账本 ⇒ 引擎在 `beginCombat` 里拒"同一单位第二次攻击 / 同一格第二次被攻击"。
       * 账本是 store 事实（引擎不持状态），故在这里喂进去——**判据只有一处**，界面不另写一份。
       */
      attackedUnitIdsThisSegment: attackedUnitIdsThisPhase.value,
      attackedHexesThisSegment: attackedHexesThisPhase.value,
    }),
  )

  /** C6：9.2 九步清单（含本步已否；供界面按规则顺序提示） */
  const combatChecklist = computed(() =>
    combatState.value === null ? [] : stepChecklist(combatState.value),
  )

  /** C6：当前该由哪一方结算（9.10b：攻方先、守方后） */
  const combatResolver = computed<CombatRole | null>(() =>
    combatState.value === null ? null : currentResolver(combatState.value),
  )

  /** C6：本步所需的强制损失点数与选项点数（当前结算方） */
  const combatRequirement = computed<{
    side: CombatRole
    losses: number
    options: number
  } | null>(() => {
    const state = combatState.value
    if (state === null || state.dice === undefined) return null
    const side = currentResolver(state)
    return {
      side,
      losses: lossesOf(state.dice.result, side),
      options: optionsOf(state.dice.result, side),
    }
  })

  /**
   * C6：当前结算方的**规范损失分配**（9.11c）
   *
   * 9.11c 的两条限制（AR 单位先受第一点；每人各受一点后才有人受第二点）在给定各单位军力后
   * 唯一确定分布，故界面直接展示引擎给出的规范值（9.11a 的「拥有者选择」在此只剩确认）。
   */
  const combatCanonicalLosses = computed<{ unitId: string; steps: number }[]>(() => {
    const state = combatState.value
    if (state === null || state.dice === undefined) return []
    const stage = state.resolution.stage
    if (stage !== 'attackerLosses' && stage !== 'defenderLosses') return []
    const side = currentResolver(state)
    const views = side === 'attacker' ? combatAttackerViews.value : combatDefenderViews.value
    const arUnitId = side === 'attacker' ? state.ar?.attackerUnitId : state.ar?.defenderUnitId
    return allocateBattleLosses({
      required: lossesOf(state.dice.result, side),
      units: views.map((unit) => ({ id: unit.id, steps: unit.steps })),
      ...(arUnitId === undefined ? {} : { arUnitId }),
    }).allocation
  })

  /**
   * 9.11a（批 F 切片 2）：**能把"多受的那一点"改派给谁**（拥有者的选择权）
   *
   * 原文：「**在 9.11c 的限制范围内**，由**拥有者玩家**决定由哪个或哪些单位承受军力损失」；
   * 9.11c 的两条约束是"AR 单位先受第一点"与"各受一点之后才有人受第二点"。
   * ⇒ 当规范分配里**某单位受 2 点**而有**别的单位只受 1 点**时，把那一点**换一枚单位承受**
   *   （两枚互换点数）仍是合规分配 —— 这就是玩家可选的余地。
   * 候选＝「规范分配里点数＝最多者 − 1」的那些单位（互换后步数多重集不变）；没有这种单位时为空。
   */
  const combatLossSwapChoices = computed<{ unitId: string; label: string }[]>(() => {
    const canonical = combatCanonicalLosses.value
    if (canonical.length === 0) return []
    const max = Math.max(...canonical.map((item) => item.steps))
    if (max < 2) return []
    const extras = canonical.filter((item) => item.steps === max)
    // 多受者只有一枚时，"改成谁"＝点数＝max−1 的那些单位；多受者有多枚时，让玩家在多受者之间对调没有意义 ⇒ 仍给 max−1 的候选
    return canonical
      .filter((item) => item.steps === max - 1 && item.steps >= 1)
      .filter((item) => !extras.some((extra) => extra.unitId === item.unitId))
      .map((item) => ({ unitId: item.unitId, label: nameOf(item.unitId) }))
  })

  /**
   * 9.11a：把规范分配按"玩家指定的承受者"改派 —— 从**点数最多**的那一枚移一点给指定单位
   *
   * 只做"平移一点"（不改总量、不改多重集），故一定满足 9.11c 的两条约束；
   * 引擎侧仍会再校验一遍（`validateBattleLossAllocation`），界面不代它下结论。
   */
  function combatLossAllocationNow(): { unitId: string; steps: number }[] | undefined {
    const canonical = combatCanonicalLosses.value
    const chosen = combatInputs.value.lossTakerId
    if (chosen === null || canonical.length === 0) return undefined
    if (!combatLossSwapChoices.value.some((item) => item.unitId === chosen)) return undefined
    const max = Math.max(...canonical.map((item) => item.steps))
    const extra = canonical.find((item) => item.steps === max)
    if (extra === undefined) return undefined
    return canonical.map((item) => {
      if (item.unitId === extra.unitId) return { ...item, steps: item.steps - 1 }
      if (item.unitId === chosen) return { ...item, steps: item.steps + 1 }
      return { ...item }
    })
  }

  /** C6：CRT 结果摘要（9.9；可直接显示） */
  const combatSummary = computed(() => {
    const state = combatState.value
    if (state === null || state.dice === undefined) return null
    const result = state.dice.result
    return {
      die: state.dice.die,
      modifiedDice: state.dice.modifiedDice,
      raw: result.raw,
      terrainLine: state.odds?.terrain.combatLine ?? '',
      ratio: state.surprise?.finalColumnLabel ?? state.odds?.oddsLabel ?? '',
      surprise: state.surprise ?? null,
      attacker: {
        losses: lossesOf(result, 'attacker'),
        options: optionsOf(result, 'attacker'),
        exploit: result.attacker.exploitationAR,
        notation: result.attacker.notation,
        optionTaken: state.resolution.attacker.option ?? null,
      },
      defender: {
        losses: lossesOf(result, 'defender'),
        options: optionsOf(result, 'defender'),
        dg: result.defender.disorganized,
        notation: result.defender.notation,
        optionTaken: state.resolution.defender.option ?? null,
        ignorable: state.resolution.defender.optionIgnorable === true,
        ignored: state.resolution.defender.optionIgnored === true,
      },
    }
  })

  /**
   * C6：本次战斗的**结算复核过程**（W7 C11）
   *
   * 奇袭已判 ⇒ 给奇袭段；战斗骰已掷 ⇒ 给战斗段（含取列与查表）。
   * 逐项字段全部取自引擎已算出的结论（`state.ar` / `state.odds` / `state.surprise` / `state.dice`），
   * 骰面取自本 store 的真实掷骰记录 —— 界面据此展开复核，不重算任何规则。
   */
  const combatReview = computed<Derivation | null>(() => {
    const state = combatState.value
    if (state === null) return null

    if (state.dice !== undefined) {
      const ar = state.ar
      return combatDerivation({
        roll: combatDiceRoll.value,
        die: state.dice.die,
        attackerAr: ar?.attackerAr ?? 0,
        attackerArSource:
          ar === undefined
            ? '未指定'
            : ar.attackerUnitId === ''
              ? '攻方 AR 单位已被消灭（无领队，9.6）'
              : `攻方 AR 单位 ${nameOf(ar.attackerUnitId)}`,
        defenderAr: ar?.defenderAr ?? 0,
        defenderArSource:
          ar === undefined
            ? '未指定'
            : ar.defenderUnitId === ''
              ? '守方 AR 单位已被消灭（无领队，9.6）'
              : `守方 AR 单位 ${nameOf(ar.defenderUnitId)}`,
        hedgehogLevel: state.hedgehogLevel,
        modifiedDice: state.dice.modifiedDice,
        raw: state.dice.result.raw,
        terrainLine: state.dice.result.terrainLine,
        columnLabel: state.surprise?.finalColumnLabel ?? state.odds?.columnLabel ?? '',
        ...(state.odds === undefined ? {} : { oddsLabel: state.odds.oddsLabel }),
        ...(state.odds === undefined ? {} : { terrain: state.odds.terrain.defenderTerrain }),
        ...(state.odds === undefined
          ? {}
          : {
              attackerStrength: state.odds.attackerTotal,
              defenderStrength: state.odds.defenderTotal,
              attackerStrengthById: state.odds.attackerStrengthById.map((item) => ({
                unitId: item.unitId,
                strength: item.strength,
              })),
            }),
      })
    }

    if (state.surprise !== undefined) {
      return surpriseDerivation({
        roll: combatSurpriseRoll.value,
        die: combatSurpriseDie.value ?? 0,
        arDifferential: state.ar?.drm ?? 0,
        defenderInHedgehog: state.defenderInHedgehog,
        side: state.surprise.side,
        shiftRoll: combatShiftRoll.value,
        shift: state.surprise.shift,
      })
    }

    return null
  })

  /** 9.6a：AR 候选/默认值统一用**有效** AR（DG −1、战略 0），与引擎 `battleArOf` 同源 */
  function effectiveArOf(unit: ConsoleUnit): number {
    return battleArOf({ ar: unit.raw.ar, dg: unit.mode.dg, mode: unit.mode.mode })
  }

  /** C6：攻方/守方的 AR 候选（9.6：每方只能选一个参战单位） */
  const combatAttackerArOptions = computed(() =>
    combatAttackers.value.map((unit) => ({
      id: unit.instanceId,
      label: `${unit.name}（AR${effectiveArOf(unit)}）`,
    })),
  )
  const combatDefenderArOptions = computed(() =>
    battleDefenders.value.map((unit) => ({
      id: unit.instanceId,
      label: `${unit.name}（AR${effectiveArOf(unit)}）`,
    })),
  )

  /**
   * 专规 2.3b：守方堆叠内是否有 **NKVD 边防团**（有则行动值单位必须由它担任）
   *
   * 取引擎的 `nkvdArRequired`（判据即 2.3b 的强制候选集）；并据此把**候选表收窄到那几个单位**——
   * 界面上于是根本选不出违规的行动值单位（权威否决仍是引擎的 `checkDefenderArChoice`）。
   */
  const nkvdArRequiredNow = computed<boolean>(() =>
    nkvdArRequired(combatNkvdDefenders.value.map(toNkvdDefenseView)),
  )

  /** 2.3b：守方**可选的**行动值单位（被迫时只剩 NKVD 边防团） */
  const combatDefenderArChoices = computed(() =>
    nkvdArRequiredNow.value
      ? combatDefenderArOptions.value.filter((option) =>
          combatNkvdDefenders.value.some((unit) => unit.instanceId === option.id),
        )
      : combatDefenderArOptions.value,
  )

  /**
   * B30：**默认的行动值单位**（9.6；用户口径 2026-09-16 #19「可选的前提下默认选交战双方 AR 最高的单位」）
   *
   * 判据：取该方**可选集合**里**有效** AR 最大者（DG −1、战略 0，与引擎 `battleArOf` 同源）；
   * 同 AR 取战斗力（印值 attack）**最小**者（少牺牲强单位），再按实例 id 稳定排序兜底。
   * 守方走 `combatDefenderArChoices`——那一条已经把专规 2.3b（NKVD 在场时行动值单位必须由它担任）
   * 收窄过了，故默认值天然合法。默认值只影响开战时的预选，玩家仍可换。
   *
   * `unitIds` 用于**本场战斗内部**改名单后重算（9.5b 减员）：此时 `composition` 还是旧的
   * （提交补给才落盘），默认值必须按玩家**当前意图**的名单取，而不是按 `combatAttackers`。
   */
  function defaultArUnitIdOf(side: CombatRole, unitIds?: readonly string[]): string | null {
    const rows =
      unitIds ??
      (side === 'attacker'
        ? combatAttackerArOptions.value.map((row) => row.id)
        : combatDefenderArChoices.value.map((row) => row.id))
    const pool = rows
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
    if (pool.length === 0) return null
    return pool.slice().sort((a, b) => {
      const arDiff = effectiveArOf(b) - effectiveArOf(a)
      if (arDiff !== 0) return arDiff
      const strengthDiff = a.raw.attack - b.raw.attack
      if (strengthDiff !== 0) return strengthDiff
      return a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0
    })[0]!.instanceId
  }

  /** C6：守方格的地形候选（9.4c：**只能**格内地形） */
  const combatDefenderTerrainOptions = computed<string[]>(() => {
    const target = battleTarget.value
    if (target === null) return []
    return [...combatFacts.value.hexTerrainsAt(target.hex)]
  })

  /**
   * C6：逐攻击堆叠的地形候选（9.4b）
   *
   * 「可以是**防御格内**的地形（如山丘或树林），或者是该堆叠的**攻击穿越的格边地形**」——
   * 故候选 = 防御格内地形 ∪ 该堆叠与防御格之间的格边地形（二者只能选其一，不累计）。
   */
  const combatStackTerrainOptions = computed<
    { key: string; label: string; options: { kind: 'hex' | 'hexside'; terrain: string }[] }[]
  >(() => {
    const target = battleTarget.value
    if (target === null) return []
    return combatAttackers.value.map((unit) => ({
      key: hexLabel(unit.hex),
      label: `${hexLabel(unit.hex)}（${unit.name}）`,
      options: [
        ...combatDefenderTerrainOptions.value.map((terrain) => ({
          kind: 'hex' as const,
          terrain,
        })),
        ...hexsideTerrainNames(unit.hex, target.hex).map((terrain) => ({
          kind: 'hexside' as const,
          terrain,
        })),
      ],
    }))
  })

  /**
   * 9.12g-B：**攻方把选项当撤退**（哪怕只有 1 格）⇒ 本场不推进。
   * 引擎 `resolveAdvance` 已按此收口（成功但推进 0 单位）；这里把同一条事实供给三个派生，
   * 免得界面继续铺推进格/候选，把玩家引到一张只能空点的卡上。
   */
  const combatAttackerRetreated = computed<boolean>(() => {
    const state = combatState.value
    if (state === null) return false
    return (state.resolution.attacker.option?.retreatHexes ?? 0) > 0
  })

  /**
   * B33（9.12g-D）：这次的战后推进是不是**强制**的
   *
   * 突袭成功后**必须**推进（规则原文 9.12g-D）；常规战斗由拥有者选择（可都不推）。
   * 界面据此隐藏「不推进」，并把按钮改成"必须推进并收束"。
   */
  const combatAdvanceMandatory = computed<boolean>(() => {
    const state = combatState.value
    if (state === null) return false
    // 9.12g-B 优先于 9.12g-D：攻方已撤退 ⇒ 突袭也不推进
    if (combatAttackerRetreated.value) return false
    return state.attackType === 'overrun'
  })

  /**
   * C6：**仍在进行中的**战斗步（已收束 ⇒ null）—— 界面渲染战斗块时只读它
   *
   * 为什么需要它（2026-09-18 修，用户报「战斗框里的『确认推进并收束』点了没反应、会话框一直在」）：
   * 引擎在推进步把 `finished` 置真，但**刻意不改写 `step`**（仍是 `advance`，历史与既有用例都依赖它）——
   * 于是"按 `combatState?.step` 渲染"的就近小窗会在战斗**已收束**之后继续挂着推进块与收束按钮；
   * 再点一次只是把同一笔推进又跑一遍（幂等、界面无变化）⇒ 看起来"点了没反应"。
   * ★ 判据只有这一处：`combatState === null || finished ⇒ null`。
   */
  const combatLiveStep = computed<CombatStep | null>(() => {
    const state = combatState.value
    if (state === null || state.finished) return null
    return state.step
  })

  /** C6：需要撤退的格数（9.12：撤退格数＝剩余选项数） */
  const combatRetreatRequirement = computed(() => {
    const state = combatState.value
    if (state === null) return { attacker: 0, defender: 0 }
    return {
      attacker: state.resolution.attacker.option?.retreatHexes ?? 0,
      defender: state.resolution.defender.option?.retreatHexes ?? 0,
    }
  })

  /*
   * ★ 已删（2026-09-16）`combatRetreatingUnits`：它是给战斗面板那一列 `列.行,列.行` 文本框
   *   准备的扁名单。撤退改成**地图点格**后（用户口径），面板读的是 `combatRetreatPlans`
   *   （含每人的候选落点与已选落点），这份只够显示名字的名单没有调用方了 ⇒ 删掉，
   *   免得留一条"无人使用的第二口径"。
   */

  /**
   * 9.12f：**战斗开始时**的盘面快照（格/归属/是否战斗单位）——「撤退不可穿越战斗开始时含敌方
   * 战斗单位的格」的唯一依据（因此不能穿越攻方承受损失或选项后腾空的格）
   */
  const combatStartSnapshot = ref<
    { hex: HexRef; side: Side; isCombat: boolean; instanceId: string; name: string }[]
  >([])

  /** 拍下 9.12f 的战斗开始快照（9.2 第 1 步成立时调用；此后任意损失都不影响它） */
  function captureCombatStartSnapshot(): void {
    combatStartSnapshot.value = units.value.map((unit) => ({
      hex: { col: unit.hex.col, row: unit.hex.row },
      side: unit.side,
      isCombat: unit.isCombat,
      instanceId: unit.instanceId,
      name: unit.name,
    }))
  }

  /** C6（9.12d）：已点选「加入撤退」的跟随者（未参战战斗单位 / 编内卡车） */
  const combatTagalongIds = ref<string[]>([])

  /**
   * C6（9.12d）：**可以跟随撤退**的候选
   *
   * 「未参加战斗的战斗单位和编内卡车可以在它们所在格中加入撤退」⇒ 候选须同时满足：
   *   ① 与该方某一**参战撤退单位同格**；② 不是参战者本人；③ 是战斗单位或编内卡车
   *   （`canJoinRetreat`，其余非战斗单位必须留在原格）。
   */
  const combatTagalongCandidates = computed<
    { unit: ConsoleUnit; side: CombatRole; hostId: string; hostLabel: string }[]
  >(() => {
    const state = combatState.value
    if (state === null) return []
    const out: { unit: ConsoleUnit; side: CombatRole; hostId: string; hostLabel: string }[] = []
    for (const side of ['attacker', 'defender'] as const) {
      if (!needsRetreat(state, side)) continue
      // 9.12 以单位为对象：军力归零/已进死亡堆的参战者不再是「可动作对象」
      const stack = (side === 'attacker' ? combatAttackers.value : battleDefenders.value).filter(
        (unit) => unit.steps > 0,
      )
      const participantIds = new Set(stack.map((unit) => unit.instanceId))
      for (const unit of units.value) {
        if (participantIds.has(unit.instanceId)) continue
        if (!canJoinRetreat(unit).ok) continue
        const host = stack.find(
          (item) => item.hex.col === unit.hex.col && item.hex.row === unit.hex.row,
        )
        if (host === undefined) continue
        out.push({ unit, side, hostId: host.instanceId, hostLabel: host.name })
      }
    }
    return out
  })

  /** C6（9.12d）：加入/移出「跟随撤退」名单 */
  function toggleCombatTagalong(unitId: string): void {
    if (combatTagalongIds.value.includes(unitId)) {
      combatTagalongIds.value = combatTagalongIds.value.filter((id) => id !== unitId)
      return
    }
    const candidate = combatTagalongCandidates.value.find((item) => item.unit.instanceId === unitId)
    if (candidate === undefined) {
      pushLog('warning', '该单位不能跟随撤退（9.12d：仅未参战战斗单位与编内卡车可加入）', '9.12d')
      return
    }
    combatTagalongIds.value = [...combatTagalongIds.value, unitId]
    pushLog(
      'info',
      `${candidate.unit.name} 加入撤退（9.12d：与 ${candidate.hostLabel} 同格，随该堆叠一起撤）`,
      '9.12d',
    )
  }

  /** C6：撤退事实（9.12/9.12b/9.12e/9.12f；注入引擎） */
  const combatRetreatFacts = computed<RetreatFacts>(() => {
    const state = combatState.value
    const liveIds = new Set(
      units.value.filter((unit) => unit.steps > 0).map((unit) => unit.instanceId),
    )
    // 9.12 以单位为对象：已进死亡堆的成员不再参与撤退事实（其位置/ZOC 不得继续阻挡）
    const retreating: string[] = []
    if (state !== null) {
      if (needsRetreat(state, 'attacker'))
        retreating.push(...state.composition.attackerIds.filter((id) => liveIds.has(id)))
      if (needsRetreat(state, 'defender'))
        retreating.push(...state.composition.defenderIds.filter((id) => liveIds.has(id)))
    }
    // 9.12d：跟随撤退的单位也参与「撤退中的这一堆」
    retreating.push(...combatTagalongIds.value.filter((id) => liveIds.has(id)))
    return createRetreatFacts({
      units: units.value,
      context: moveContext.value,
      retreatingUnitIds: retreating,
      // 9.12f：用「战斗开始时」的快照判「该格当时是否有敌方战斗单位」
      combatStartSnapshot: combatStartSnapshot.value,
    })
  })

  /** C6：防御格是否已空（9.12g：全被消灭或撤退才可推进） */
  const combatDefendingHexCleared = computed(() => {
    const target = battleTarget.value
    if (target === null) return false
    return !units.value.some(
      (unit) =>
        unit.side === combatDefenderSide.value &&
        unit.isCombat &&
        unit.steps > 0 &&
        unit.hex.col === target.hex.col &&
        unit.hex.row === target.hex.row,
    )
  })

  /** C6：可推进的候选单位（9.12g-A：只有付了战斗补给的攻击单位才能推进；9.12b：不可移动者不能） */
  const combatAdvanceCandidates = computed<
    { id: string; label: string; paid: boolean; immobile: boolean }[]
  >(() => {
    const state = combatState.value
    if (state === null) return []
    // 9.12g-B：攻方在选项中撤退 ⇒ 没有可推进者（连候选都不列）
    if (combatAttackerRetreated.value) return []
    const paid = state.supply?.attacker.paid === true
    return combatAttackers.value
      .filter((unit) => unit.steps > 0)
      .map((unit) => ({
        id: unit.instanceId,
        label: unit.name,
        paid,
        // 9.12b 末句：在任何模式下都不可移动的单位也无法战后推进
        immobile: combatRetreatFacts.value.immobile(unit.instanceId),
      }))
  })

  /**
   * B14c（用户口径⑪）：**战后推进**的算子图阵列数据（9.12g-A / 9.12b 的两条否决转成人话）
   *
   * 候选就是 `combatAdvanceCandidates`（`paid` / `immobile` 两个事实已经算好），
   * 本 getter 只把两条否决翻成给玩家看的原因：
   *   · **9.12g-A** 未付战斗补给的单位不得推进（含战斗值为零者）；
   *   · **9.12b** 末句「在任何模式下都不可移动的单位」也不得推进。
   * 两条否决都由引擎在 `confirmCombatAdvance` 里裁定（灰显只是提前告知）。
   */
  const combatAdvanceChoices = computed<
    readonly { unit: ConsoleUnit; selected: boolean; disabledReason: string | null }[]
  >(() => {
    /*
     * 9.12g：没有推进格（防御格未空 / 攻方已撤 / 专规 1.1b 禁入）⇒ 这件事不存在，
     * 面板一枚都不给（引擎本来就会忽略勾选，摆出按钮只会造成"点了没用"的假入口）。
     * 与地图同源：推进格由 `combatAdvanceHex` 唯一给出。
     */
    if (combatAdvanceHex.value === null) return []
    return combatAdvanceCandidates.value.flatMap((candidate) => {
      const unit = units.value.find((item) => item.instanceId === candidate.id)
      if (unit === undefined) return []
      return [
        {
          unit,
          selected: combatInputs.value.advanceUnitIds.includes(candidate.id),
          disabledReason: !candidate.paid
            ? '9.12g-A：该单位未付战斗补给 ⇒ 不得推进'
            : candidate.immobile
              ? '9.12b：在任何模式下都不可移动的单位不得推进'
              : null,
        },
      ]
    })
  })

  /* ──────────── W7 C16：战斗收尾的**地图优先**交互（撤退落点 / 推进格 / 补给站） ──────────── */

  /**
   * 9.12g：战后推进格（防御格已清空 ⇒ 攻方可推进到这里；否则 null）
   *
   * 数据来源：`combatDefendingHexCleared`（9.12g 的「全被消灭或撤退」事实）+ 选定的防御格坐标；
   * 是否**可以**推进仍由引擎 `resolveAdvance` 在下一步裁决（本项只是把它画到地图上）。
   * 专规 1.1b：防御格若是敌方安全边缘格（补给源边格）⇒ 不可进入，故不给推进格。
   */
  const combatAdvanceHex = computed<HexRef | null>(() => {
    /*
     * 9.2 收束（finished=true）后本场不再铺推进格：引擎在推进结果里把 `step` 留在 'advance'，
     * 只看 step 会把收束后的防御格继续涂成暗绿（用户 2026-11-16 报的突袭残留）；
     * 突袭自动推进与常规战斗确认推进两条路径都以 finished=true 收尾，这一道门同时覆盖。
     */
    const state = combatState.value
    if (state !== null && state.finished === true) return null
    const target = battleTarget.value
    if (target === null) return null
    // 9.12g-B：攻方撤退 ⇒ 防御格再空也不铺推进格
    if (combatAttackerRetreated.value) return null
    if (!combatDefendingHexCleared.value) return null
    const hex = { col: target.hex.col, row: target.hex.row }
    if (isEnemySafeEdgeHex(moveContext.value, hex, activeSide.value)) return null
    return hex
  })

  /** 9.12：某方需撤退的单位的落点规划（地图优先交互数据源） */
  const combatRetreatPlans = computed<CombatRetreatSidePlan[]>(() => {
    const state = combatState.value
    // 9.2 收束后同 `combatAdvanceHex`：旧战斗的撤退计划不再对外给（落点图层 / 提示 / 点格分派）
    if (state === null || state.finished === true) return []
    const plans: CombatRetreatSidePlan[] = []
    for (const side of ['attacker', 'defender'] as const) {
      // 9.12c/9.12e：攻方先撤、守方后撤；该方撤退格数为 0 则不参与
      if (!needsRetreat(state, side)) continue
      const record = side === 'attacker' ? state.resolution.attacker : state.resolution.defender
      const distance = record.option?.retreatHexes ?? 0
      if (distance <= 0) continue
      const sideUnits = (
        side === 'attacker' ? combatAttackers.value : battleDefenders.value
      ).filter((unit) => unit.steps > 0)
      // 9.12 以单位为对象：该方已无存活参战单位 ⇒ 不建「空计划」，
      // 否则 `complete = rows.every(...)` 会在空数组上恒为 true，界面误以为已选齐。
      if (sideUnits.length === 0) continue
      const rows: CombatRetreatUnitPlan[] = sideUnits.map((unit) => {
        const escaped = combatInputs.value.retreatPaths[unit.instanceId] ?? ''
        const chosen = parseHexPath(escaped)
        const destinations = planRetreatDestinations({
          from: unit.hex,
          distance,
          mobility: effectiveMobilityOf(unit),
          side: unit.side,
          facts: combatRetreatFacts.value,
          immobile: combatRetreatFacts.value.immobile(unit.instanceId),
          // 5.8a：战略模式单位撤退路径进入敌方 ZOC ⇒ 被摧毁
          strat: unit.mode.mode === 'strat',
        })
        return {
          unitId: unit.instanceId,
          label: unit.name,
          from: { col: unit.hex.col, row: unit.hex.row },
          chosen: chosen.length > 0 ? chosen[chosen.length - 1]! : null,
          destinations,
          // 9.12 第三 bullet：排除 9.12f 不可通行格后一个落点都没有 ⇒ 确认后兜底消灭
          ...(destinations.length === 0 ? { noLanding: true } : {}),
        }
      })
      // 地图上画「该方能退到哪」的并集：安全格 / 有 ZOC 影响格 / 选了会被消灭的格
      const safe: HexRef[] = []
      const zoc: HexRef[] = []
      const doomed: HexRef[] = []
      for (const row of rows) {
        for (const destination of row.destinations) {
          const bucket = destination.forcedDestruction
            ? doomed
            : destination.inEnemyZoc
              ? zoc
              : safe
          if (!bucket.some((hex) => sameHex(hex, destination.hex))) bucket.push(destination.hex)
        }
      }
      // 9.12d：跟随者（随其同格宿主一起撤；路径自动沿用宿主）
      const tagalongs: CombatRetreatTagalongPlan[] = combatTagalongIds.value.flatMap((id) => {
        const candidate = combatTagalongCandidates.value.find(
          (item) => item.unit.instanceId === id && item.side === side,
        )
        return candidate === undefined
          ? []
          : [
              {
                unitId: candidate.unit.instanceId,
                label: candidate.unit.name,
                hostId: candidate.hostId,
                hostLabel: candidate.hostLabel,
              },
            ]
      })
      plans.push({
        side,
        distance,
        units: rows,
        tagalongs,
        complete: rows.every((row) => row.chosen !== null || row.noLanding === true),
        safe,
        zoc,
        doomed,
      })
    }
    return plans
  })

  /**
   * 9.12e：额外 1 点军力损失的**承受者候选**（撤退步、落点选齐后才算）
   *
   * 「由拥有者玩家从撤退中的 DG 单位中选择承受损失」⇒ 候选必须与确认时引擎认的那一份同源：
   * 这里用 `retreatResolutionInput` + `resolveRetreats` 做**纯预演**，不落盘、不改状态；
   * 落点没选齐时返回 null（不猜）。
   */
  const combatExtraLossPreview = computed<{
    points: number
    choices: { unit: ConsoleUnit; selected: boolean }[]
  } | null>(() => {
    const state = combatState.value
    if (state === null || state.step !== 'retreat') return null
    if (combatRetreatPlans.value.some((plan) => !plan.complete)) return null
    const input = retreatResolutionInput()
    if (input === null) return null
    const outcome = resolveRetreats(state, input)
    if (!outcome.ok) return null
    const extra = outcome.data.extraLoss
    if (extra.points <= 0 || extra.eligibleUnitIds.length === 0) return null
    const chosen = combatInputs.value.extraLossTakerId
    // 没选 / 选的已不在候选里 ⇒ 与确认时的仲裁同口径：落在第一枚
    const effective =
      chosen !== null && extra.eligibleUnitIds.includes(chosen) ? chosen : extra.eligibleUnitIds[0]!
    return {
      points: extra.points,
      choices: extra.eligibleUnitIds.flatMap((id) => {
        const unit = units.value.find((item) => item.instanceId === id)
        return unit === undefined ? [] : [{ unit, selected: id === effective }]
      }),
    }
  })

  /** 9.12e：点选额外损失的承受者（只写玩家意图；候选以预演为界，最终由引擎仲裁） */
  function chooseExtraLossTaker(unitId: string): boolean {
    const preview = combatExtraLossPreview.value
    if (preview === null) return false
    if (!preview.choices.some((choice) => choice.unit.instanceId === unitId)) return false
    combatInputs.value = { ...combatInputs.value, extraLossTakerId: unitId }
    return true
  }

  /**
   * 9.12（C1）：选项步的**当场提示**——按当前撤退格数，逐单位预演第 9 步落点
   *
   * `doomed`：只有必被消灭的落点；`noLanding`：排除 9.12f 不可通行格后一个落点都没有
   * （确认撤退后按 9.12 第三 bullet 兜底消灭）。选项步与撤退步共用同一套判据，避免先放行后灰显。
   */
  const combatOptionRetreatWarning = computed<
    { unitId: string; label: string; kind: 'doomed' | 'noLanding' }[]
  >(() => {
    const state = combatState.value
    if (state === null || state.step !== 'options') return []
    const distance = combatInputs.value.optionRetreatHexes
    if (distance <= 0) return []
    const side = currentResolver(state)
    const sideUnits = (side === 'attacker' ? combatAttackers.value : battleDefenders.value).filter(
      (unit) => unit.steps > 0,
    )
    return sideUnits.flatMap(
      (unit): { unitId: string; label: string; kind: 'doomed' | 'noLanding' }[] => {
        const landings = planRetreatDestinations({
          from: unit.hex,
          distance,
          mobility: effectiveMobilityOf(unit),
          side: unit.side,
          facts: combatRetreatFacts.value,
          immobile: combatRetreatFacts.value.immobile(unit.instanceId),
          strat: unit.mode.mode === 'strat',
        })
        if (landings.length === 0)
          return [{ unitId: unit.instanceId, label: unit.name, kind: 'noLanding' as const }]
        if (landings.every((landing) => landing.forcedDestruction))
          return [{ unitId: unit.instanceId, label: unit.name, kind: 'doomed' as const }]
        return []
      },
    )
  })

  /**
   * 9.12：点名要撤退、但该方**已无存活参战单位**（9.10a 的义务在、9.12 的对象不在）
   *
   * 与 `combatRetreatPlans` 同口径：该方不建计划、撤退格数记 0；面板只在标签后注明。
   */
  const combatRetreatSkippedSides = computed<CombatRole[]>(() => {
    const state = combatState.value
    if (state === null) return []
    const steps = new Map(units.value.map((unit) => [unit.instanceId, unit.steps]))
    const live = liveRetreatSides(state, steps)
    return (['attacker', 'defender'] as const).filter(
      (side) => needsRetreat(state, side) && !live.includes(side),
    )
  })

  /*
   * ★ 已删（2026-09-16）`combatRetreatSide`：它取 `combatRetreatPlans[0]`（永远是攻方），
   *   而界面真正该跟着走的是「**第一个未选齐的一方**」（`map-view.retreatSidePlan`）——
   *   两个口径并存时，攻方选齐后"地图已切到守方、小窗还列攻方"。现在只留一处（在 map-view）。
   */

  /**
   * C16：战斗补给按方给出的**可动用补给站**
   *
   * 条文（12.4 前段）：「**直接拖取(12.3a)和指挥部投递(12.3b)都可用于接收及分配战斗补给(9.5)**」
   * ⇒ 该方在**本战斗格**能取到的 SP 来源有两类：
   *   - **12.3a 直接拖取**：本格（或其相邻格，12.3c）在拖取距离内能直接拖到的补给站；
   *   - **12.3b HQ 投递**：本方可投递的 HQ 能拖到、且能把补给**投递到本格**的那些补给站
   *     （HQ 自身须能拖取、非战略模式、且非"由别的 HQ 投递获得"，12.3b-C/D）。
   *
   * ★ 原实现只写「该方**全部**补给站」：既不校验距离（可在全图任意远处付款，违反 12.3a），
   *   也**完全漏掉 HQ 投递**这条合法途径。
   */
  const combatSupplyDumps = computed<{ side: CombatRole; dumps: SpDump[] }[]>(() => {
    const defenderSide = combatDefenderSide.value
    // 7.0a：反应段的突袭由非阶段玩家发起 ⇒ 攻方是 `actingSide`，不是 `activeSide`
    const attackerSide = actingSide.value

    /**
     * 该方在本次战斗能动员的补给站（12.3a ∪ 12.3b；13.2g-B 的编内卡车资格同样在 `deliverableDumpsFor` 里）
     *
     * ★ G②（2026-09-19）：改用**受益单位**（参战的那一叠）而不是"防御格及其邻格"作锚点 ——
     *   12.3b 的投递距离是"从指挥部到**需要补给的部队**处"算的，且 13.2g-B 的编队资格也是**按单位**写的。
     *   修前那版还会让非同编队的同伴蹭到编内卡车上的油（用 `some` 判"堆叠里有没有同编队单位"）。
     */
    const fundableDumps = (side: Side): SpDump[] =>
      deliverableDumpsFor(side, combatBeneficiariesOf(side, attackerSide))

    return [
      { side: 'attacker' as const, dumps: fundableDumps(attackerSide) },
      { side: 'defender' as const, dumps: fundableDumps(defenderSide) },
    ]
  })

  /** C16：已点选为战斗补给来源的补给站 id（null＝未选；保留单值以兼容既有界面/测试） */
  const combatSupplyDumpIds = ref<{ attacker: string | null; defender: string | null }>({
    attacker: null,
    defender: null,
  })

  /**
   * 12.4：本次战斗各方的**需求 T**（供「可选补给源」角标区分"本次可付 / 不够付"）
   *
   * 攻方每攻击军力 1T；守方每次战斗 2T（≤1RE 为 1T）——与 `confirmCombatSupply` 同一成本函数。
   */
  const combatSupplyNeedT = computed<{ attacker: number; defender: number }>(() => {
    const attacker = combatAttackers.value.reduce((sum, unit) => sum + unit.steps, 0)
    const defenderRe = combatDefenderViews.value.reduce((sum, unit) => sum + unit.re, 0)
    return {
      attacker,
      defender: computeCombatSupplyCost({ attackerSteps: 0, defenderRE: defenderRe }).defenderT,
    }
  })

  /**
   * 12.4：战斗补给允许**各单位分别取源**（原文未写「必须同源」，10.1b-A 的同源只约束炮击）。
   *
   * 每个阵营可点选多座补给站；落盘时按单位逐个分配到他真正拖得到的那一座。
   * `combatSupplyDumpIds` 仍记第一座，供既有单源界面/测试读取。
   */
  const combatSupplyDumpPicks = ref<{ attacker: string[]; defender: string[] }>({
    attacker: [],
    defender: [],
  })

  /**
   * C16：点地图上的某个撤退落点 ⇒ 为该单位写入 9.12 撤退路径
   *
   * 路径由引擎 `planRetreatDestinations` 给出（单调走法，长度恰等于完整撤退距离），
   * 本函数只把它写成 `combatInputs.retreatPaths` 的文本（与手填格号走的是同一条输入）。
   */
  function setRetreatDestinationNow(unitId: string, hex: HexRef): boolean {
    for (const plan of combatRetreatPlans.value) {
      const row = plan.units.find((item) => item.unitId === unitId)
      if (row === undefined) continue
      const destination = row.destinations.find((item) => sameHex(item.hex, hex))
      if (destination === undefined) {
        pushLog(
          'warning',
          `${hexLabel(hex)} 不是 ${row.label} 的合法撤退落点（9.12：落点须在完整撤退距离上、且路径可走）`,
          '9.12',
        )
        return false
      }
      combatInputs.value = {
        ...combatInputs.value,
        retreatPaths: {
          ...combatInputs.value.retreatPaths,
          [unitId]: destination.path.map((item) => hexLabel(item)).join(','),
        },
      }
      pushLog(
        'info',
        `${row.label} 撤退至 ${hexLabel(hex)}（${plan.distance} 格）` +
          (destination.inEnemyZoc ? '；该格在敌方 ZOC 内 ⇒ 进入即 DG（9.12e）' : ''),
        '9.12',
      )
      return true
    }
    return false
  }

  /**
   * C16：点地图上的**推进格** ⇒ 按 9.12g-A 选出可推进的单位（付了战斗补给者）
   *
   * 常规战斗可自愿不推进，故只写候选、由玩家再确认；突袭后必须推进（8.1f 的强制进格）。
   */
  function advanceNow(hex: HexRef): boolean {
    const target = combatAdvanceHex.value
    if (target === null || !sameHex(target, hex)) {
      pushLog('warning', '防御方尚未离开该格（9.12g：全被消灭或撤退后才可推进）', '9.12g')
      return false
    }
    /*
     * 9.12g-A + 9.12b：可推进者＝**付了战斗补给**且**并非任何模式下都不可移动**。
     * ★ 修前只筛 `paid`（漏了 9.12b）⇒ 会把不可移动单位也选进 `advanceUnitIds`，
     *   随后 `confirmCombatAdvance` 被引擎以 `immobileUnitCannotAdvance` 拒（9.12b）
     *   ⇒ 玩家点「推进到该格」后再点确认却报错。判据与 `resolveAdvanceAfterCombat` 对齐。
     */
    const eligible = combatAdvanceCandidates.value.filter(
      (item) => item.paid && item.immobile !== true,
    )
    if (eligible.length === 0) {
      pushLog(
        'warning',
        combatAdvanceCandidates.value.length === 0
          ? '没有可推进的攻击单位（9.12g）'
          : '没有付过战斗补给、且在任何模式下都非不可移动的攻击单位可以推进（9.12g-A / 9.12b）',
        '9.12g-A',
      )
      return false
    }
    combatInputs.value = { ...combatInputs.value, advanceUnitIds: eligible.map((item) => item.id) }
    pushLog('info', `准备推进（9.12g）：${eligible.map((item) => item.label).join('、')}`, '9.12g')
    return true
  }

  /** C16：放弃推进（9.12g：常规战斗可都不推） */
  function clearAdvanceNow(): void {
    combatInputs.value = { ...combatInputs.value, advanceUnitIds: [] }
  }

  /**
   * 9.12g-D：逐单位勾选推进单位 —— 「由拥有者玩家选择**哪些**攻击单位进行推进（如果有的话）」
   *
   * 只写 `combatInputs.advanceUnitIds`；能不能推由引擎在 `confirmCombatAdvance` 里裁定
   * （9.12g-A 未付战斗补给 / 9.12b 不可移动 ⇒ 界面灰显，判据见 `combatAdvanceChoices`）。
   * 突袭（`mandatory`）下引擎一律取全部合格单位，勾选不影响结果（8.0 / 9.12g-D）。
   */
  function toggleAdvanceUnit(unitId: string): void {
    const current = combatInputs.value.advanceUnitIds
    combatInputs.value = {
      ...combatInputs.value,
      advanceUnitIds: current.includes(unitId)
        ? current.filter((id) => id !== unitId)
        : [...current, unitId],
    }
  }

  /**
   * C16：点地图上的**补给站** ⇒ 声明战斗补给的付款来源（12.4）
   *
   * 12.4 的战斗补给是 T；本函数把该补给站的 T 持仓写入引擎输入（`attackerAvailableT` /
   * `defenderAvailableT`），并记下被点的那一枚（供地图高亮与界面显示）。
   * 「付不付得出 / 够不够」仍由引擎 `planCombatSupply` 裁决。
   */
  function pickCombatSupplyDump(side: CombatRole, dumpId: string): boolean {
    const entry = combatSupplyDumps.value.find((item) => item.side === side)
    const dump = entry?.dumps.find((item) => item.id === dumpId)
    if (dump === undefined) {
      pushLog('warning', '该补给站不属于这一方（12.1b）', '12.1b')
      return false
    }
    // 12.4：点另一座＝追加；再点同一座＝取消该方来源（撤空后可用 T 归零）
    const current = combatSupplyDumpPicks.value[side]
    const next = current.includes(dumpId)
      ? current.filter((id) => id !== dumpId)
      : [...current, dumpId]
    combatSupplyDumpPicks.value = { ...combatSupplyDumpPicks.value, [side]: next }
    combatSupplyDumpIds.value = { ...combatSupplyDumpIds.value, [side]: next[0] ?? null }
    // 12.1a：可用量必须**含 SP 折算**（1 SP = 4 T），并按多选来源求和
    const availableT = next.reduce((sum, id) => {
      const picked = entry?.dumps.find((item) => item.id === id)
      return picked === undefined ? sum : sum + holdingsToT({ sp: picked.sp, t: picked.t })
    }, 0)
    combatInputs.value =
      side === 'attacker'
        ? { ...combatInputs.value, attackerAvailableT: availableT }
        : { ...combatInputs.value, defenderAvailableT: availableT }
    // B4：玩家正在补来源 ⇒ 上一条「来源为『—』」的红字随即失效，不残留到点击确认时
    combatError.value = null
    pushLog(
      'info',
      next.length === 0
        ? `${side === 'attacker' ? '攻方' : '守方'}战斗补给来源已清空`
        : `${side === 'attacker' ? '攻方' : '守方'}战斗补给来源 ${next.length} 座，合计 ${availableT} T（12.4）`,
      '12.4',
    )
    return true
  }

  /* ── C7 轰炸交互：派生（一切结论来自引擎；此处只做视图整形） ── */

  /** C7：参炸单位（当前方；随落盘自动刷新） */
  const barrageUnits = computed<ConsoleUnit[]>(() => {
    const state = barrageState.value
    const ids = state === null ? barrageUnitIds.value : state.units.map((unit) => unit.unitId)
    return ids
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
  })

  /**
   * B14b（用户口径⑪）：**参炸单位**的算子图阵列数据（可选性由引擎判据逐枚转述）
   *
   * 候选＝当前方**有印刷轰炸值**的单位（`raw.barrage > 0`，10.0e-B 的印值基准）。
   * 灰显原因有两个：**13.4a**（火炮处于预备/战略模式不得轰炸）与**专规 2.3d**（第五批 A4：
   * 已选一枚带 `sov_artillery_stack_to_combine` 标签的苏炮 ⇒ 其它格的带标签苏炮不得并入合并齐射）。
   * 2.3d 的最终裁决在引擎 `beginBarrage`（同一次宣布里判），此处只做同口径的**提前灰显**。
   *
   * ★ **不在这里替引擎判**别的（10.0e-A/B 的逐格/逐单位账本、10.0e-F 的类别相符）——
   *   那些引擎目前没接线，若在此处拦下来，界面会比引擎"更严"，反而掩盖规则缺口（已登记待改）。
   */
  const barrageUnitChoices = computed<
    readonly {
      unit: ConsoleUnit
      selected: boolean
      /** 10.1a：能否打到当前目标格；目标未定时无从判距离 ⇒ true（交引擎裁决） */
      inRange: boolean
      disabledReason: string | null
    }[]
  >(() => {
    /*
     * 10.0e-F：一次轰炸只能用**同一类型** ⇒ 候选按**当前单位类别**收口：
     * 选了"空军"就不该再列火炮（H②：用户报"炮兵轰炸时结算页面上还有空军"，这是它的镜像面）。
     */
    if (barrageKind.value !== 'artillery') return []
    // 专规 2.3d：已选的带标签苏炮的所在格（合并齐射的"锚点"；标签在 ConsoleUnit 顶层，与 NKVD 判据同源）
    const anchor = units.value.find(
      (unit) =>
        barrageUnitIds.value.includes(unit.instanceId) &&
        (unit.specialAbilities ?? []).includes('sov_artillery_stack_to_combine'),
    )
    const target = barrageTargetHex.value
    return units.value
      .filter(
        (unit) =>
          unit.side === segmentGateQuery.value.side &&
          isBarrageCapableUnit(unit) &&
          /*
           * 2.2：反应 / 进击的射击只认已释放的预备（与 `barrageCandidatesAt` 同一条判据）。
           * 不可用的单位不列出来——否则玩家点了、宣布时才被 7.0a / 11.0a 拒。
           */
          isGroundBarrageEligible(phase.value, unit),
      )
      .map((unit) => {
        const range = unit.raw.range
        const distance = target === null ? null : hexDistance(unit.hex, target)
        const outOfRange =
          distance !== null &&
          range !== undefined &&
          !canBarrageAtRange({ rangeHexes: range, distanceHexes: distance })
        return {
          unit,
          selected: barrageUnitIds.value.includes(unit.instanceId),
          /*
           * 10.1a（第六批条 20）：候选**按射程标出够不着者**（引擎侧同一条判据已在 `beginBarrage` 生效）。
           *   界面只做"说清楚"，最终裁决仍在引擎（CODE_SPEC §3.1：规则结算只在引擎）。
           *   目标格未选定时无从判距离 ⇒ 不标。
           */
          inRange: !outOfRange,
          disabledReason: isInReserveOrStrat(unit)
            ? '13.4a：预备/战略模式的火炮不得轰炸'
            : outOfRange
              ? `10.1a：射程 ${range} 格，目标在 ${distance} 格外`
              : anchor !== undefined &&
                  unit.instanceId !== anchor.instanceId &&
                  (unit.specialAbilities ?? []).includes('sov_artillery_stack_to_combine') &&
                  !sameHex(unit.hex, anchor.hex)
                ? '专规 2.3d：苏军炮兵合并轰炸须同堆叠（与已选参炸炮同格）'
                : null,
        }
      })
  })

  /**
   * 条 13 + K2：炮击阵列只看**打得到当前目标**的炮；右键入口再按**该格**收窄
   *
   * · 10.1a：目标格已定时，射程外的炮（`inRange === false`）不再列出——旧路径（工具条直接开）
   *   以前把全场炮兵都列出来、只靠灰显说明"够不着"，玩家看到满屏不可点项；
   * · 右键某枚/某堆炮兵进炮击时，候选再收窄为"这一枚 + 同格合法炮兵"；
   * · **已选中的**成员始终保留（多格联合炮击 B15c；目标改点后也还能取消），否则玩家一点别格
   *   查看就把已选丢了。
   * 判据仍只来自 `barrageUnitChoices`，这里只做视图收窄。
   */
  const barrageVisibleChoices = computed(() => {
    const inRange = barrageUnitChoices.value.filter((choice) => choice.inRange || choice.selected)
    const scope = barrageScopeHex.value
    return scope === null
      ? inRange
      : inRange.filter((choice) => choice.selected || sameHex(choice.unit.hex, scope))
  })

  /**
   * #9（用户 2026-11-10）：**本环节还允许的参炸名单里有东西吗**
   *
   * 10.0e-C/D：炮兵只在战斗 / 反应 / 进击段的轰炸环节可轰炸。从轰炸环节退回移动环节时，
   * `barrageUnitIds` 仍是旧名单；会话框若不看环节就会继续弹「宣布轰炸（10.0d）」。
   * 判据与 `barrageKindsInSegment` 同源，不另写一份。
   */
  const barrageSelectionAllowedNow = computed<boolean>(() => {
    const kinds = barrageKindsInSegment.value
    if (barrageUnitIds.value.length + barrageAirIds.value.length === 0) return false
    // 无环节上下文（引擎验证页 / 夹具）：不按环节收口，保持工具本来的行为
    if (kinds.length === 0) return true
    return (
      (barrageUnitIds.value.length > 0 && kinds.includes('artillery')) ||
      (barrageAirIds.value.length > 0 && kinds.includes('air'))
    )
  })

  /**
   * C7：**本环节里点地图选定的**轰炸目标格（10.0d）
   *
   * ★ 批 A 切片 2（用户口径「正式界面由环节驱动」）：修前 `barrageTargetHex` 直接取 `battleTarget?.hex` ——
   *   于是对局台一旦删掉"打一仗"工具按钮，**炮兵连目标格都点不了**（面板还提示"去工具里点"）。
   *   现在改为"**轰炸环节里点格**"为第一来源；`battleTarget` 降为**后备**（验证页与既有夹具仍可用它）。
   */
  const barragePickHex = ref<HexRef | null>(null)

  /** C7：轰炸目标格（环节点格优先；缺省退回战斗目标，兼容验证页与既有夹具） */
  const barrageTargetHex = computed<HexRef | null>(
    () => barrageState.value?.targetHex ?? barragePickHex.value ?? battleTarget.value?.hex ?? null,
  )

  /**
   * C7：轰炸事实（10.0a 密度 / 工事 / 战略模式；10.0b 观察员）
   *
   * 目标格未定时给出「无事实」的桩（全部返回中性值），避免界面在未选目标时误算横移。
   */
  const barrageFacts = computed(() =>
    createBarrageFacts({
      units: units.value,
      activeSide: segmentGateQuery.value.side ?? activeSide.value,
    }),
  )

  /** C7：目标格的密度 RE / 工事等级 / 战略模式 / 观察员（供界面显示与横移预览） */
  const barrageTargetFacts = computed(() => {
    const hex = barrageTargetHex.value
    if (hex === null) {
      return { enemyREInHex: 0, hedgehogLevel: 0, stratModeInHex: false, hasSpotter: false }
    }
    return {
      enemyREInHex: barrageFacts.value.enemyREInHex(hex),
      hedgehogLevel: barrageFacts.value.hedgehogLevelInHex(hex),
      stratModeInHex: barrageFacts.value.stratModeInHex(hex),
      hasSpotter: barrageFacts.value.hasSpotter(hex),
    }
  })

  /** C7：步骤清单（10.0 通用流程；给界面打勾用） */
  const barrageChecklist = computed(() =>
    barrageState.value === null ? [] : barrageStepChecklist(barrageState.value),
  )

  /**
   * B39 / A-1：**宣布的轰炸目标类别**能不能落在该格 —— 按盘面事实判（10.0c / 10.0d）
   *
   * 引擎只判"这一类型与参炸单位是否匹配"，它**不持盘面** ⇒ 这一层必须在宣布前给：
   *   · `airBase`：该格须有**空军基地**（印刷的或算子，都由 `airBases` 投影给出）；
   *   · `trainbusting`：该格须有**铁路**（14.8c 的运输破坏标记只能落在铁路格上）；
   *   · `combatUnits`：任何格都可以宣布（表 10.0a 打的是战斗单位）；
   *   · `port`：**本作数据里没有港口字段**（地图数据只有 terrain/terrainsPresent/city —— 见
   *     `src/data/schema/map-layers.schema.ts`）⇒ **判不了**，故不拦，只在这里如实标注缺口。
   */
  const barrageTargetKindIssue = computed<{ rule: string; reason: string } | null>(() => {
    const hex = barrageTargetHex.value
    if (hex === null) return null
    const kind = barrageTargetKind.value
    if (kind === 'airBase') {
      const hasBase = airBases.value.some((base) => sameHex(base.hex, hex))
      if (!hasBase) return { rule: '10.0c', reason: `空袭目标宣布为"空军基地"，但该格没有空军基地` }
      return null
    }
    if (kind === 'trainbusting') {
      if (!railMoveFacts.value.hasRail(hex))
        return { rule: '14.8c', reason: `空袭目标宣布为"运输破坏"，但该格没有铁路` }
      return null
    }
    return null
  })

  /**
   * C7：10.0a 目标玩家**可选**的地形线
   *
   * 「由目标玩家选择可能提供横移的地形」⇒ 选项只来自目标格**实际存在**的格内地形
   * （与 9.3b 的候选集同源），避免任取最有利的一条白拿左移。
   */
  const barrageTerrainLineOptions = computed<CombatLine[]>(() => {
    const hex = barrageTargetHex.value
    if (hex === null) return []
    return barrageTerrainLines(defenseTerrainChoices(hex))
  })

  /**
   * 10.0d / 10.0c：该格**可宣布的整体目标**（炮击统一流程第 1 步的选项）
   *
   * 原文 10.0c：「玩家必须预先指定他的具体目标：空军基地或港口（**或作为空军任务执行的运输破坏**）」
   * ⇒ 火炮炮击不提供运输破坏；本作无港口与海军，故只剩战斗单位与空军基地。
   */
  const barrageTargetKindChoicesAt = computed<readonly ('combatUnits' | 'airBase')[]>(() => {
    const hex = barrageTargetHex.value
    if (hex === null) return ['combatUnits']
    const side = segmentGateQuery.value.side ?? activeSide.value
    const hasEnemyCombat = units.value.some(
      (unit) => unit.side !== side && sameHex(unit.hex, hex) && unit.isCombat,
    )
    const hasEnemyBase = airBases.value.some((base) => base.side !== side && sameHex(base.hex, hex))
    const choices: ('combatUnits' | 'airBase')[] = []
    if (hasEnemyCombat || !hasEnemyBase) choices.push('combatUnits')
    if (hasEnemyBase) choices.push('airBase')
    return choices
  })

  /* ── C7 空军：10.2b 短程加成的数据源 ── */

  /** C7：可选机型（A5 空军专表；当前方） */
  const airUnitChoices = computed<AircraftRecordView[]>(() => aircraftChoices(activeSide.value))

  /** C7：参炸飞机（当前方、**当前面**有轰炸值者；随落盘自动刷新）——**只有类别＝空军时才给**（10.0e-F） */
  const barrageAirCandidates = computed<ConsoleAirUnit[]>(() =>
    barrageKind.value === 'air'
      ? airUnits.value.filter(
          (unit) => unit.side === segmentGateQuery.value.side && airBarrageStrengthOf(unit) > 0,
        )
      : [],
  )

  /** C7：本次实际选中的参炸飞机 */
  const barrageAirUnits = computed<ConsoleAirUnit[]>(() => {
    const state = barrageState.value
    const ids = state === null ? barrageAirIds.value : state.units.map((unit) => unit.unitId)
    return ids
      .map((id) => airUnits.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleAirUnit => unit !== undefined)
  })

  /**
   * C7：参炸飞机的 10.2b 事实（距基地格数 / 是否战略轰炸机）
   *
   * 「距基地格数」= 飞机所在格（14.1a：即其空军基地格）到目标格的格距；
   * 引擎会用**最远者**判「所有飞机都在 10 格以内」，并对战略轰炸机（14.1e）永不给予 +1。
   */
  const barrageAirFacts = computed(() => {
    const target = barrageTargetHex.value
    return barrageAirCandidates.value.map((unit) => {
      const distance = target === null ? null : airDistanceFromRealBase(unit, target)
      return {
        id: unit.instanceId,
        name: unit.name,
        aircraftType: unit.aircraftType,
        /** 10.2b：距其基地（= 所在格）的格数；目标格未选时为 null */
        rangeFromBase: distance,
        /** 14.1e：战略轰炸机（10.2b 永不享受短程 +1） */
        strategic: isStrategicBomberAircraft(unit.aircraftType),
        /** 14.1：航程是否够到目标格（够不到则本不该出击） */
        inRange: distance === null ? null : distance <= unit.rangeHexes,
      }
    })
  })

  /**
   * B14b（用户口径⑪）：**参炸飞机**的算子图阵列数据
   *
   * 直接建在 `barrageAirFacts` 上（10.2b 的距基地格数 / 14.1e 战略轰炸机 / 14.1 航程够不够），
   * 再并进「本次选中与否」与灰显原因：**航程够不到目标格**的飞机不可参炸（14.1）。
   */
  const barrageAirChoices = computed(() =>
    barrageAirFacts.value.map((fact) => ({
      ...fact,
      selected: barrageAirIds.value.includes(fact.id),
      disabledReason: fact.inRange === false ? '14.1：该机航程够不到目标格' : null,
    })),
  )

  /** C7：结果摘要（格值 / 横移后列位 / 成本 / 损失，供界面显示） */
  const barrageSummary = computed(() => {
    const state = barrageState.value
    if (state === null) return null
    const outcome = state.outcome
    return {
      /** 本次整体目标与所用表（10.0d） */
      targetKind: state.targetKind,
      facility: isFacilityBarrage(state),
      totalValue: state.totalValue,
      initialColumnLabel: state.table.columnLabel,
      costT: state.table.costT,
      shifts: state.shifts,
      finalColumn: state.finalColumn,
      die: state.dice?.die ?? null,
      halfDie: state.dice?.halfDie ?? null,
      code: state.result?.code ?? null,
      /** 10.0a 的解释（DG / 损失点数）；设施轰炸为 null */
      unitOutcome: outcome?.table === 'barrage' ? outcome.value : null,
      /** 10.0c 的设施结果 */
      facilityOutcome: outcome?.table === 'barrage-vs-facility' ? outcome.value : null,
      losses: state.losses,
      finished: state.finished,
    }
  })

  /** C7：当前该谁操作（轰炸方始终是当前方；10.0a 的地形与损失由**目标玩家**选） */
  const barrageRequiresDefenderInput = computed<boolean>(() => {
    const state = barrageState.value
    if (state === null) return false
    // 10.0a：地形横移与损失承受单位都由**目标玩家**（防御方）选择
    return state.step === 'shifts' || state.step === 'outcome'
  })

  /* ── C8 补给交互与 SP 管理：派生（一切结论来自引擎；此处只做视图整形） ── */

  /** C8：当前方的 SP 账本条目（12.1b） */
  const spDumpsOfSide = computed<SpDump[]>(() =>
    spDumps.value.filter((dump) => dump.side === activeSide.value),
  )

  /**
   * 12.1b + 13.2f：**装载在运输点数上的 SP 也是补给站**（"SP 使用前并不需要被卸载"）
   *
   * 每枚 loadedSpT > 0 的算子按其所在格生成一条来源（id 前缀 "unit:"）：
   *   · 13.2g：编内卡车恒 1 SP（数据侧运力就是 1）；通用运输点数"有几点运力就是几"（用户裁定）；
   *   · 13.2b：运输点数**永不需要燃料**，故它自己不进"要加油的单位"集合（needsFuelOf 早已如此）。
   *
   * ★ 同格并存（12.1b）：地面账本与装载在运输点数上的 SP 同格时，来源清单按**每份持仓**各给一条
   *   （地面那条仍算一个补给站）⇒ 玩家明确选一处；地图点格遇到两处来源**不默认取第一条**，
   *   只提示去清单里选（`expandSameHexStocks` / `pickSupplySourceAtHexNow`）。
   */
  const carriedSpDumps = computed<SpDump[]>(() =>
    units.value
      .filter((unit) => unit.loadedSpT > 0)
      .map((unit) => ({
        id: 'unit:' + unit.instanceId,
        hex: unit.hex,
        side: unit.side,
        sp: Math.floor(unit.loadedSpT / SP_TO_T),
        t: unit.loadedSpT % SP_TO_T,
        carriedBy: unit.instanceId,
        // 13.2g-B：编内卡车的 SP **只许同一多单位编队**内的单位拖取（判据在引擎 `canDrawFromCarrier`）
        carrierIsOrganicTruck: unit.noncombatKind === 'organic_truck',
        carrierFormation: unit.formation,
      })),
  )

  /** 12.1b：**全部**含 SP 的位置（账本条目 + 装载在运输点数上的）——取补与候选一律走这一份 */
  const allSpDumps = computed<SpDump[]>(() => [...spDumps.value, ...carriedSpDumps.value])

  /** 12.1b：当前方的全部补给站（含装载中的 `unit:` 来源；付款/回退统一走这一份） */
  const allSpDumpsOfSide = computed<SpDump[]>(() =>
    allSpDumps.value.filter((dump) => dump.side === activeSide.value),
  )

  /** 12.1b：按 id 取补给站——地面账本与装载中来源一视同仁 */
  function dumpById(dumpId: string): SpDump | undefined {
    return allSpDumps.value.find((dump) => dump.id === dumpId)
  }

  /**
   * 付款站日志名：地面账本写格号；装载中的 SP（`unit:`）写「格号 承运车名」
   *
   * 装载中的来源不在 `spDumps` 里，修前按 `spDumps` 查格号就回落到 `{0,0}` ⇒ 日志成「付款站 0.0」。
   */
  function spDumpLabelOf(dumpId: string): string {
    const dump = dumpById(dumpId)
    if (dump === undefined) return dumpId
    const carrier =
      dump.carriedBy === undefined
        ? undefined
        : units.value.find((unit) => unit.instanceId === dump.carriedBy)
    return carrier === undefined ? hexLabel(dump.hex) : `${hexLabel(dump.hex)} ${carrier.name}`
  }

  /** 12.1b / 13.2f：**一份持仓**的界面名（地面账本 / 装载在运输点数上；编内卡车另标 13.2g-B） */
  function supplyStockLabelOf(dump: SpDump): string {
    if (dump.carriedBy === undefined) return `地面补给站 ${dump.sp} SP + ${dump.t} T（12.1b）`
    const carrier = units.value.find((unit) => unit.instanceId === dump.carriedBy)
    const name = carrier?.name ?? dump.carriedBy
    if (dump.carrierIsOrganicTruck !== true)
      return `装载在 ${name} 上 ${dump.sp} SP + ${dump.t} T（12.1b / 13.2f）`
    return (
      `编内卡车 ${name}（编队 ${dump.carrierFormation ?? '—'}）${dump.sp} SP + ${dump.t} T` +
      `｜13.2g-B：仅同一多单位编队可取`
    )
  }

  /** C8：被检查的单位（null＝未开始） */
  const supplyUnit = computed<ConsoleUnit | null>(() => {
    const id = supplyUnitId.value
    return id === null ? null : (units.value.find((unit) => unit.instanceId === id) ?? null)
  })

  /**
   * C8：**追溯补给事实**（12.1b / 12.3b / 12.6a / 12.7）
   *
   * 判定与可视化**共用同一份事实**，避免口径漂移：
   *   - dumps ← SP 账本（12.1b）；
   *   - throwHqs ← 摆好的 HQ 算子（投递距离取 13.1b 印值）；
   *   - extenders ← 摆好的延补队算子（距离取印值 MA，12.7b）；
   *   - sources ← **专规 2.1 / 3.1 的图边补给源格** + 玩家声明的 12.6a① 源 +
   *     **由 13.3c 派生的火车卸货格**（12.6a②；见下方 `railSupply`：铁路可达 ∧
   *     村庄/城市/港口/工程 HQ ∧ 受控 ∧ 无未抵消敌 ZOC）。
   *
   * ★ 2026-11-16 修（用户实玩：轴方单位在 1.26 判成"无抽象补给"）：修前此处只收
   *   「玩家手声明的源 + 铁路卸货格」，而 2.1 / 3.1 的图边源是**数据即判据**
   *   （`scenarios.json → supplySources.axisLive / sovietLive`，原文例：1.03 / 1.26 / 4.00）——
   *   1.26 这种**非铁路格边源**于是从不进入追溯链路。现并入 `openSourceHexesBySide`（含 2.1a 关停过滤）。
   */
  const supplyFacts = computed(() =>
    createSupplyFacts({
      units: units.value,
      turn: turn.value,
      // 12.1b：含 SP 的位置 —— **账本条目 + 装载在运输点数上的**（B32 步骤 5）
      dumps: allSpDumps.value.map((dump) => ({ hex: dump.hex, side: dump.side })),
      sources: [
        // 2.1 / 3.1：图边补给源格（剧本清单 ∪ 入场铁路格；按方，含 1.26 这类非铁路源）
        ...(['axis', 'soviet'] as const).flatMap((side) =>
          openSourceHexesBySide.value[side].map((hex) => ({
            hex,
            side,
            kind: 'supplySourceHex' as const,
          })),
        ),
        ...supplySourceDecls.value
          .filter((decl) => decl.kind !== 'detrainable')
          .map((decl) => ({ hex: decl.hex, side: decl.side, kind: decl.kind })),
        // 13.3c / 12.6a②：铁路派生的火车卸货格（当前方）
        ...(['axis', 'soviet'] as const).flatMap((side) =>
          railSupplyBySide.value[side].detrainableHexes.map((hex) => ({
            hex,
            side,
            kind: 'detrainable' as const,
          })),
        ),
      ],
    }),
  )

  /**
   * C9：只用于**敌方 ZOC 判定**的追溯事实（不含派生的卸货格，避免与 `railSupply` 循环依赖）
   */
  const zocOnlySupplyFacts = computed(() =>
    createSupplyFacts({
      units: units.value,
      turn: turn.value,
      // 12.1b：含 SP 的位置 —— **账本条目 + 装载在运输点数上的**（B32 步骤 5）
      dumps: allSpDumps.value.map((dump) => ({ hex: dump.hex, side: dump.side })),
      sources: [
        // 2.1 / 3.1：图边补给源格（与 `supplyFacts` 同一份判据）
        ...(['axis', 'soviet'] as const).flatMap((side) =>
          openSourceHexesBySide.value[side].map((hex) => ({
            hex,
            side,
            kind: 'supplySourceHex' as const,
          })),
        ),
        ...supplySourceDecls.value
          .filter((decl) => decl.kind !== 'detrainable')
          .map((decl) => ({ hex: decl.hex, side: decl.side, kind: decl.kind })),
      ],
    }),
  )

  /**
   * 13.8c 例外（用户 2026-11-19 裁定）：工程 HQ 铁路卸车时当场生成的卸货格
   *
   * 「工程 HQ 就是可以随铁路运输规则登车、卸车；它卸车所在的位置即成为卸货格。」
   * ★ 只记**卸车那一刻的落点**（格的状态），不是单位的随行光环：HQ 在移动模式里一路走，
   *   不会沿途带出卸货格；换移动模式时原格失能仍按 13.8c 原义由「工程能力 HQ 占据」实时判定。
   * ★ 与 13.8b 的 `ownBridgeHexByUnitId` 分开记账，互不推断、互不复用。
   */
  const engineerHqDetrainableHexes = ref<{ hex: HexRef; side: Side }[]>([])

  /**
   * C9：铁路补给事实（13.3a / 13.3c / 12.7a-B/C）
   *
   * - sources ← **专规 2.1 / 3.1 的进场铁路格**，按连通性分属两方各自的网（用户 2026-11-11 裁定：
   *   不存在交叉可用 / 共用段；多轨与单轨只差 13.3c 运量费用，不影响归属）；
   * - extenders ← 摆好的延补队（12.7b：距离＝印值 MA）；
   * - enemyOccupies（阻断②③）：格内是否有敌方单位 —— 铁路没有归属/控制/占领（用户 2026-11-12 口径），
   *   原先的 `controlByHex` 近似已删除；「同格卸货城镇被敌占」同样用这一项判；
   * - zocAt（13.3c③）：复用追溯事实的 `inEnemyZoc`（已按 4.5b 处理「格内有己方战斗单位即抵消」）。
   * - railEdgeUsable（13.3f）：**逐边**轨距 —— 一条边两端都为本方可用轨距时，本方才能通过。
   */
  const railSupplyFacts = computed(() =>
    createRailSupplyFacts({
      sources: [
        ...entryRailSeedsBySide.value.axis.map((hex) => ({ hex, side: 'axis' as Side })),
        ...entryRailSeedsBySide.value.soviet.map((hex) => ({ hex, side: 'soviet' as Side })),
      ],
      extenders: units.value.filter(isExtenderUnit).map(toExtenderView),
      enemyOccupies: (hex, side) =>
        units.value.some((unit) => unit.side !== side && sameHex(unit.hex, hex)),
      zocAt: (hex, side) => zocOnlySupplyFacts.value.inEnemyZoc(hex, side),
      // 13.3c①后半 / 13.8a / 5.5b：本方具工程能力的指挥部。
      // 港口分支恒 false 属预期：本作无港口地形与港口专规（用户裁定 2026-11-05），非遗漏。
      hasPortOrEngineerHqAt: (hex, side) =>
        engineerCapableHqAt(units.value, hex, side) ||
        // 13.8c 例外：工程 HQ 卸车时生成的卸货格（与「当前占据的工程 HQ」分开记账）
        engineerHqDetrainableHexes.value.some(
          (item) => item.side === side && sameHex(item.hex, hex),
        ),
      // 13.3f／专规 1.2：轨距只回答「谁能用这条铁路」（与 13.3a 多轨的运量费用无关）
      railGaugeUsable: (hex, side) => isRailGaugeUsableAt(hex, side),
      // 13.3f：逐边查 gauge —— 两端都必须是本方可用轨距（混合边任一方都不通过）
      railEdgeUsable: (from, to, side) =>
        isRailGaugeUsableAt(from, side) && isRailGaugeUsableAt(to, side),
      // 12.7b：延补队回连距离用 trace-supply 的**同一实现**（MP 沿补给路径），不使用格数近似
      traceFacts: zocOnlySupplyFacts.value,
    }),
  )

  /** C9：铁路补给线与**火车卸货格**（13.3c / 12.7a-B/C；当前方视角） */
  const railSupplyBySide = computed(() => ({
    axis: railSupplyPath(railSupplyFacts.value, 'axis'),
    soviet: railSupplyPath(railSupplyFacts.value, 'soviet'),
  }))
  const railSupply = computed(() => railSupplyBySide.value[activeSide.value])

  /**
   * U17（用户 2026-11-13 批准）：2.1/3.1 **免费铁运**专用的卸货格
   *
   * 与 `railSupply` 的区别只有一条：BFS 只走铁路边、**不接延补队**（延补队接续的是补给线，
   * 不是「货物可在该格卸车」）。只替换免费铁运这一个消费方；追溯补给仍用 `railSupply`。
   */
  const cargoDetrainableHexesBySide = computed(() => ({
    axis: railSupplyPath(railSupplyFacts.value, 'axis', { cargoOnly: true }).detrainableHexes,
    soviet: railSupplyPath(railSupplyFacts.value, 'soviet', { cargoOnly: true }).detrainableHexes,
  }))
  const cargoDetrainableHexes = computed(() => cargoDetrainableHexesBySide.value[activeSide.value])

  /** C9：火车卸货格（13.3c）——已连接的铁路格，可作 12.6a① 补给源 */
  const detrainableHexes = computed(() => railSupply.value.detrainableHexes)

  /**
   * 12.6 / 5.8b：**追溯补给的逐格判定**（与 `supplyFacts` 同源，一处构造、多处消费）
   *
   * 消费方：装备 `traceSupplyAt` 的移动上下文（5.8b 战略模式须停在有补给的格）、
   * 9.14d 特殊战斗的落点条件。两者必须问**同一份**事实，否则「同一个格，一处说有补给、
   * 另一处说没有」。
   */
  const traceSupplyAtForMove = computed(() => createTraceSupplyAt(supplyFacts.value))

  /* ────────────────── C9b：轨距账本（13.3f / 专规 1.2） ────────────────── */

  /**
   * 印刷轨距（专规 1.2：本作地图铁路「最初除剧本初设另有注明者外，全部为宽轨」）
   *
   * 规则常量是权威来源；`map-layers.json` 顶层 `railGauge` 是同值的图层副本，
   * 两者不一致即数据有误——由 `tests/data/...` 的一致性用例钉住，代码只读常量。
   */
  const printedRailGauge: RailGauge = rulesConstants.smolensk.railGauge.printed

  /** 换轨的**目标**轨距＝非印刷轨距的那一种（本作：印刷宽轨 ⇒ 转换后为标准轨） */
  const convertedRailGauge: RailGauge = printedRailGauge === 'broad' ? 'standard' : 'broad'

  /**
   * C9b：**已换轨的格**（13.3f）——本作即「宽轨 → 标准轨」的逐格账本
   *
   * 为什么需要它：专规 1.2 明言就「铁路运货**与获得追溯补给**」而言，苏方**只能**用宽轨、
   * 轴方**只能**用标准轨。印刷图全是宽轨，轴方要能用铁路就必须先换轨——换轨状态是**运行期**的，
   * 数据层只有印刷值，故必须在此记账（写入点：剧本初设 `convertedAxisRails` 的推导结果、
   * 13.3f 转换动作、裁判手工订正）。
   *
   * ★ 与 13.3a 的「多轨／单轨」严格分开：那是**地形**，管**运量费用**；本账本只管**谁能用**。
   *
   * ★ 账本是**单向**的：只记「已换成标准轨」的格。13.3f 的转换动作按本方轨距入账或出账
   *   （轴方入账、苏方出账），故苏方把轴方换过的轨换回来时账本会**缩短**——见 `convertRailGaugeNow`。
   */
  const convertedRailHexes = ref<string[]>([])

  /** 已换轨格的索引（O(1) 查询用） */
  const convertedRailKeySet = computed<Set<string>>(() => new Set(convertedRailHexes.value))

  /** C9b：本阶段各单位的换轨格数（13.3g-D 每阶段 ≤ min(4, MA) 格的账本；换阶段即清零） */
  const gaugeConversionsThisPhase = ref<{ instanceId: string; count: number }[]>([])

  /**
   * 13.3g-A：**本阶段被换过轨的格**（按格记账；换阶段即清零）
   *
   * 原文：「一个铁路修理单位可在移动阶段将铁路移动与轨距转换结合起来。（例外：如果**用于铁路移动的格**
   * 刚刚在**当前阶段内**进行了轨距转换，则不能这样做。**不能接力！**）」
   * ⇒ 判这条例外需要"哪些格是本阶段换的"，而 `gaugeConversionsThisPhase` 是**按算子**计数的、
   *   答不了这个问题（§17.85 登记的缺口）⇒ 另记一本**按格**的阶段账本。
   */
  const convertedHexesThisPhase = ref<string[]>([])

  /**
   * 13.3g-A：本阶段各铁路修理单位**用铁路移动走过**的"刚换过轨的格"
   *
   * 引擎的入参是布尔（`usedNewlyConvertedRailThisPhase`）⇒ 这一手由 store 判定并留账
   * （哪个单位、走过哪些格）。按**单位**记：另一个单位没走过这些格，就不受这条例外牵连。
   */
  const railMovedNewTrackThisPhase = ref<{ instanceId: string; hexes: string[] }[]>([])

  /** 13.3f：该格**此刻**的轨距（印刷值 ⊕ 换轨账本） */
  function railGaugeAt(hex: HexRef): RailGauge {
    return convertedRailKeySet.value.has(hexLabel(hex)) ? convertedRailGauge : printedRailGauge
  }

  /**
   * 13.3f / 专规 1.2：`side` 在 `hex` 能否使用这条铁路
   *
   * 这就是「谁可以用」的全部内容——轨距**不**参与运量费用（费用侧是多轨/单轨地形，13.3a）。
   */
  function isRailGaugeUsableAt(hex: HexRef, side: Side): boolean {
    return rulesConstants.smolensk.railGauge.usableBySide[side] === railGaugeAt(hex)
  }

  /**
   * C9b：推导某剧本的初设换轨格清单（纯推导，不写日志、不触发重判）
   *
   * 剧本页只给两个端点，给的是**那一条铁路线**；逐格清单由引擎沿铁路邻接图取唯一最短路径
   * （`convertedRailRun`，分叉或不连通即失败——把不该给的格标成已换轨，等于把整段铁路白送给轴方）。
   * 任一走线失败即整体作废（`keys` 为空）并把原因放进 `problems`，由调用方决定告警口径。
   */
  function deriveConvertedRailHexes(id: string): {
    keys: string[]
    problems: string[]
    runs: number
  } {
    const decl = scenarios.scenarios.find((item) => item.id === id)?.setup.convertedAxisRails
    if (decl === undefined) return { keys: [], problems: [], runs: 0 }
    const keys: string[] = []
    const problems: string[] = []
    let runs = 0
    for (const run of decl.runs) {
      const endpoints = parseConvertedRailRun(run)
      if (endpoints === null) {
        problems.push(`${run}（端点原文无法解析，期望「列.行 to 列.行」）`)
        continue
      }
      const outcome = convertedRailRun(railNeighborSource, endpoints)
      if (!outcome.ok) {
        problems.push(`${run}（${outcome.reason}）`)
        continue
      }
      runs += 1
      for (const hex of outcome.data.hexes) keys.push(hexLabel(hex))
    }
    return problems.length > 0
      ? { keys: [], problems, runs }
      : { keys: [...new Set(keys)], problems, runs }
  }

  /**
   * C9b：剧本初设换轨（专规 1.2 剧本页 `Converted Axis Rails: A to B`）
   *
   * 剧本页只给两个端点，给的是**那一条铁路线**；逐格清单由引擎沿铁路邻接图取唯一最短路径
   * （`convertedRailRun`，分叉即失败）。本动作**清空并重算**账本，故重复调用幂等；
   * 解析或推导失败时账本置空（宁可少给：不给轴方任何未证成的铁路使用权）并逐条告警。
   */
  function seedConvertedRailsNow(): boolean {
    const derived = deriveConvertedRailHexes(scenarioId.value)
    const decl = scenarios.scenarios.find((item) => item.id === scenarioId.value)?.setup
      .convertedAxisRails
    convertedRailHexes.value = derived.keys
    if (derived.problems.length > 0) {
      for (const problem of derived.problems)
        pushLog('warning', `初设换轨未能推导：${problem}——账本保持为空（宁可少给）`, '13.3f')
      return false
    }
    pushLog(
      'info',
      decl === undefined
        ? `剧本 ${scenarioId.value} 未登记初设换轨（专规 1.2：除初设注明者外全部为宽轨）⇒ 换轨账本为空`
        : `初设换轨：剧本 ${scenarioId.value} 共 ${decl.runs.length} 段走线 → ${derived.keys.length} 格转为标准轨` +
            `（专规 1.2：轴方只能使用标准轨，苏方只能使用宽轨）`,
      '专规 1.2',
    )
    return true
  }

  /** 13.3d：railhead 标记的静态记录 id（markers.json） */
  const MK_38_RAILHEAD_RECORD_ID = 'mk-38'

  /**
   * 13.3d：railhead 标记（`mk-38`）的静态定义 —— **全仓唯一的 side / 图名出处**
   *
   * 铁路端点标记在 `markers.json` 里定义为 `neutral`（它是磁贴，不归属任何一方）；
   * 数据改了这里自动跟随，避免「初设写 neutral、渲染写 axis」这类两处各说一套。
   */
  const RAILHEAD_MARKER = (() => {
    const record = markers.markers.find((item) => item.id === MK_38_RAILHEAD_RECORD_ID)
    if (record === undefined)
      throw new Error(`markers.json 缺 ${MK_38_RAILHEAD_RECORD_ID}（13.3d）`)
    return { recordId: record.id, side: record.side ?? 'neutral', front: record.front }
  })()

  /**
   * 13.3d/13.3f：**铁路端头**标记实例（`mk-38`，画在 `Neutral_Railhead.png` 上）
   *
   * 原文（13.3f）只要求「用 Railhead 标记跟踪各路轨距的当前范围」，没有给端头取法，也没有让玩家摆：
   * 所以这里**由换轨账本 `convertedRailHexes` + 铁路连通推导**（`deriveRailheads`）：
   *   - 轴方换进 ⇒ 端头前移；苏方换回 ⇒ 端头后撤；
   *   - 一条线到尽头一个端头，分叉的每个尽头各一个，同一条线不重复；
   *   - 标记是**地图事实**：不参与命中测试、不改任何判定，也不提供手动摆放入口。
   * 换剧本/重置时无需再播种——账本一变，端头就跟着变。
   */
  const railheadMarkers = computed<Marker[]>(() => {
    const converted = convertedRailHexes.value
      .map((key) => parseHexPath(key)[0])
      .filter((hex): hex is HexRef => hex !== undefined)
    return deriveRailheads({ converted, railNeighbors: railNeighborHexes }).map((hex) => ({
      id: `mk-38:${hex.col}.${hex.row}`,
      recordId: RAILHEAD_MARKER.recordId,
      // 统一取 markers.json 的 side（neutral），不在初设或渲染层另写一份
      side: RAILHEAD_MARKER.side as MarkerSide,
      hex,
      track: null,
    }))
  })

  /** C9b：清空换轨账本（裁判订正用；13.3f 的初设之外不应有「已换轨」） */
  function clearConvertedRailsNow(): void {
    const before = convertedRailHexes.value.length
    convertedRailHexes.value = []
    pushLog('info', `换轨账本已清空（原 ${before} 格）——铁路恢复印刷轨距（专规 1.2）`, '13.3f')
  }

  /** 13.3g：该实例是否为**铁路修理单位**（数据标记 `specialized` 含 `'rail_repair'`） */
  function isRailRepairUnit(instanceId: string): boolean {
    return (
      units.value
        .find((unit) => unit.instanceId === instanceId)
        ?.specialized.includes('rail_repair') ?? false
    )
  }

  /**
   * 13.3g：当前行动方盘面上可用的铁路修理单位（只读投影）
   *
   * 换轨是“移动进入”动作，必须有**盘面实例**与位置：单位库里有记录，不等于本局已落位/已到场。
   * 候选只列本方（`activeSide`），避免把对方 RR 单位摆成可点入口；判定仍由 `convertRailGaugeNow`
   * 交给引擎复核，本投影不改变任何结论。
   */
  const railRepairUnits = computed<ConsoleUnit[]>(() =>
    units.value.filter(
      (unit) => unit.side === activeSide.value && isRailRepairUnit(unit.instanceId),
    ),
  )

  /**
   * 专规 4.1c（可选）：轴心 RR 单位的早期换轨走廊限制
   *
   * 返回 null ＝ 不限制（未启用 / 不是这两个单位 / 目标城市已换轨 / 走廊解不出唯一线路）。
   * 「抵达后才按该规则正常行动」⇒ 目标城市格进了换轨账本就解除。
   */
  function earlyRouteRestrictionOf(
    unit: ConsoleUnit,
    targetHex: HexRef,
  ): { allowedHexKeys: readonly string[]; detail: string } | null {
    if (!session.rule4On('rrRepairRestriction')) return null
    if (unit.side !== 'axis' || !isRailRepairUnit(unit.instanceId)) return null
    const corridor = earlyRailCorridors().find((item) => item.unitId === unit.unitId)
    if (corridor === undefined || corridor.unresolved !== null || corridor.objectiveHexKey === null)
      return null
    if (convertedRailHexes.value.includes(corridor.objectiveHexKey)) return null
    return {
      allowedHexKeys: corridor.hexKeys,
      detail: `专规 4.1c：早期只能沿 ${corridor.label} 走廊换轨，${hexLabel(targetHex)} 不在这条线上`,
    }
  }

  /**
   * 13.3f-B：该单位**最近一次移动进入**的格（只认最终仍停留在的格）
   *
   * 两个入口都要算：
   *   - 地面逐格移动：取本次移动里**最后一笔**「该单位真的换了格」的步骤（`movedIds`，`kind === 'step'`），
   *     撤销上一步后自然回退到更早的一笔；
   *   - 13.3e 铁路移动：取本阶段最后一次铁路抵达（`railArrived`，换阶段即清空）。
   * 两者都要求结果等于单位**当前**所在格（否则是旧记录，不能据此远程换轨）。
   */
  function justEnteredHexFor(instanceId: string, currentHex: HexRef): HexRef | null {
    const steps = moveInteraction.value?.steps ?? []
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]!
      if (step.kind !== 'step' || !step.movedIds.includes(instanceId)) continue
      // 最后一笔地面移动就是它当前所在格 ⇒ 成立；否则它此后多半是铁路移动，转去查 `railArrived`
      if (sameHex(step.to, currentHex)) return step.to
      break
    }
    /*
     * 13.3f-B 的事实是「本阶段**移动进入**过该格」，不是「移动交互还开着」：
     * 交互被别的单位替换/收起后，仍认本阶段最后一次地面入格（撤销时由 `syncGroundEntries` 回退）。
     */
    const ground = lastGroundEntryByUnit.value[instanceId]
    if (ground !== undefined) {
      const entered = parseHexPath(ground)[0]
      if (entered !== undefined && sameHex(entered, currentHex)) return entered
    }
    const rail = railArrived.value
    if (rail === null || rail.instanceId !== instanceId) return null
    const hex = parseHexPath(rail.hexText)[0]
    return hex !== undefined && sameHex(hex, currentHex) ? hex : null
  }

  /**
   * C9b：13.3f／13.3g 轨距转换（铁路修理单位**移动进入**铁路格即转换该格）
   *
   * - **13.3f-B：只能转换本单位刚移动进入的那一格**——换轨是"移动进入"的副产品，
   *   进入该格的地形 MP 已由那一步移动支付（原文只说不付**额外** MP，见引擎 `validateGaugeConversion`
   *   的 `mpCost: 0`）；原地不动 / 远程指定格一律拒绝并给出可读原因；
   * - 转换不消耗 SP 也不消耗额外 MP（13.3f-B）；
   * - 敌方 ZOC 内不可转换且**不可抵消**（13.3f-A）；
   * - 仅移动阶段，每阶段至多 `min(4, 当前 MA)` 格，且不得「接力」（13.3g-A/D）；
   * - 须处于战斗模式，或 DG 但朝向战斗面（13.3g-D via 5.10e）。
   *
   * 数据侧：三支铁路修理单位（苏 West RR Rgt、德 I-2 / II-2 RR Bn）已于 2026-09-15 入库并推进到
   * `valued`，`specialized` 均含 `'rail_repair'`（印值经用户裁定）⇒ 本条与 13.3g 的铁路例外均已生效。
   */
  function convertRailGaugeNow(instanceId: string, targetHexText: string): boolean {
    if (!requireAction('move.railConversion', '换轨')) return false
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) {
      pushLog('warning', `轨距转换：找不到单位实例 ${instanceId}`, '13.3f')
      return false
    }
    const hex = parseHexPath(targetHexText)[0]
    if (hex === undefined) {
      pushLog('warning', `轨距转换：目标格格式应为「列.行」，收到「${targetHexText}」`, '13.3f')
      return false
    }
    /*
     * 13.3f-B：「一个铁路修理单位只需**移动进入**一个铁路格，就可转换该铁路格的轨距。」
     * ⇒ 换轨不是独立动作，而是"移动进入"的副产品：
     *   ① 单位必须**正在**目标格内；
     *   ② 目标格必须是它**最近一次移动进入**的格（地面逐格移动或 13.3e 铁路移动皆可）；
     *   ③ 进入该格的地形 MP 已由那一步支付；本动作只给 0 MP（不付**额外** MP）。
     * 不满足即拒（远程换轨 / 原地换轨都不成立），并把原因写进日志。
     */
    if (!sameHex(unit.hex, hex)) {
      const reason = `13.3f-B：单位不在 ${hexLabel(hex)}，不能转换（换轨须是移动进入该格的副产品，不能远程换轨）`
      pushLog('warning', `轨距转换被拒：${reason}`, '13.3f')
      return false
    }
    const entered = justEnteredHexFor(instanceId, unit.hex)
    if (entered === null || !sameHex(entered, hex)) {
      const reason =
        entered === null
          ? `13.3f-B：${unit.name} 本阶段尚未移动进入任何格，不能转换 ${hexLabel(hex)}（不能远程换轨）`
          : `13.3f-B：只能转换刚走进的格——${unit.name} 最近进入的是 ${hexLabel(entered)}，不是 ${hexLabel(hex)}`
      pushLog('warning', `轨距转换被拒：${reason}`, '13.3f')
      return false
    }
    const early = earlyRouteRestrictionOf(unit, hex)
    const outcome = validateGaugeConversion({
      phase: phase.value as GamePhase,
      unit: { id: unit.instanceId, side: unit.side },
      targetHex: hex,
      ...(early === null ? {} : { earlyRouteRestriction: early }),
      convertedThisPhase:
        gaugeConversionsThisPhase.value.find((item) => item.instanceId === instanceId)?.count ?? 0,
      mode: unit.mode.mode,
      orientation: unit.mode.orientation,
      dg: unit.mode.dg,
      currentMa: unit.raw.ma,
      usedNewlyConvertedRailThisPhase:
        (railMovedNewTrackThisPhase.value.find((item) => item.instanceId === instanceId)?.hexes
          .length ?? 0) > 0,
      facts: {
        hasRail: (ref) => isRailHexAt(ref),
        inEnemyZoc: (ref, side) =>
          inEnemyZocForAction(moveContext.value, ref, side, 'railConversion'),
        isRailRepairUnit: (id) => isRailRepairUnit(id),
      },
    })
    if (!outcome.ok) {
      pushLog('warning', `轨距转换被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const key = hexLabel(hex)
    /*
     * 13.3f：双方**各换各的**轨距——账本的语义是「该格已换成标准轨（轴方可用）」，
     * 故轴方转换＝入账，苏方转换＝**出账**（恢复印刷宽轨）。
     * 按**本方可用轨距**判定（不写死阵营），印刷轨距若改则行为自动跟随。
     */
    captureUndoSnapshot(`换轨 ${key}`)
    const wasOwnGauge = isRailGaugeUsableAt(hex, unit.side)
    if (rulesConstants.smolensk.railGauge.usableBySide[unit.side] === convertedRailGauge) {
      if (!convertedRailHexes.value.includes(key)) convertedRailHexes.value.push(key)
    } else {
      convertedRailHexes.value = convertedRailHexes.value.filter((item) => item !== key)
    }
    const previous =
      gaugeConversionsThisPhase.value.find((item) => item.instanceId === instanceId)?.count ?? 0
    gaugeConversionsThisPhase.value = [
      ...gaugeConversionsThisPhase.value.filter((item) => item.instanceId !== instanceId),
      { instanceId, count: previous + 1 },
    ]
    // 13.3g-A：本阶段"刚换过轨的格"按格记账（同一格重复转换不重复记账）
    if (!convertedHexesThisPhase.value.includes(key))
      convertedHexesThisPhase.value = [...convertedHexesThisPhase.value, key]
    pushLog(
      'info',
      `${outcome.data.detail}；` +
        (wasOwnGauge
          ? '该格原就是本方轨距，转换后仍供本方使用'
          : isRailGaugeUsableAt(hex, unit.side)
            ? '该格现已可供本方铁路使用'
            : '该格轨距仍非本方可用'),
      '13.3f',
    )
    // 13.3f：铁路源/卸货格由 `railSupplyPath` 实时派生；不重判断补标记（12.8a）
    return true
  }

  /* ────────── C9c：13.3 铁路运货（13.3a 容量 / 13.3b 移动阶段 / 13.3e 三步） ────────── */

  /**
   * 13.3e：铁路运货的玩家输入（卸货格 / SP 货量 / SP 的起运补给站）
   *
   * 货物本身取「当前选中单位」（单位货）或「指定补给站」（SP 货）——与 13.3a 允许的三类货物
   * （战斗单位 / 运输点数 / SP）一致；运输点数作货物见本节的登记。
   */
  const railMoveInputs = ref<{ toHexText: string; spAmount: number; fromDumpId: string | null }>({
    toHexText: '',
    spAmount: 1,
    fromDumpId: null,
  })

  /** 13.3 的错误（统一形状） */
  const railMoveError = ref<{ rule: string; reason: string } | null>(null)

  /**
   * 13.3b：**本回合**各方已用的铁路容量点数
   *
   * 「每个铁路运量点数可以运输一个 SP 或 RE，距离不限」＋当日容量（1.2：轴 0/苏 2，7 月 19 日起
   * 轴 1/苏 3）⇒ 额度是**按回合**计的，故换回合清零（与 16.0b/c 的每回合额度同构）。
   */
  const railCapSpentThisTurn = ref<{ side: Side; points: number }[]>([])

  /** 13.3b：该方本回合已用 / 剩余容量点数 */
  function railCapUsedBy(side: Side): number {
    return railCapSpentThisTurn.value.find((item) => item.side === side)?.points ?? 0
  }
  function spendRailCapacity(side: Side, points: number): void {
    railCapSpentThisTurn.value = [
      ...railCapSpentThisTurn.value.filter((item) => item.side !== side),
      { side, points: railCapUsedBy(side) + points },
    ]
  }
  /** 裁定 3：撤回时退回已扣运力（同回合额度不应被界面撤回吃掉） */
  function refundRailCapacity(side: Side, points: number): void {
    railCapSpentThisTurn.value = [
      ...railCapSpentThisTurn.value.filter((item) => item.side !== side),
      { side, points: Math.max(0, railCapUsedBy(side) - points) },
    ]
  }
  const railCapRemaining = computed<{ axis: number; soviet: number }>(() => ({
    axis: railCapToday.value.axis - railCapUsedBy('axis'),
    soviet: railCapToday.value.soviet - railCapUsedBy('soviet'),
  }))

  /**
   * 13.3：铁路运货的运行期事实（`RailFacts` 的**唯一组装点**）
   *
   * 静态图层（哪格有铁路 / 两格是否以铁路相接）由引擎 `createRailFacts` 从 `map-layers` 建索引；
   * 运行期各项分别取仓里既有结论：
   *   · 13.3e-2「未控制」← **敌方单位占据**（`enemyOccupies`，与补给侧阻断②同源）。用户 2026-11-12
   *     裁定：铁路本身没有归属/控制/占领，能被占领的是同格城镇/村镇；故不再有独立的控制权账本；
   *   · 13.3f 轨距 ← `isRailGaugeUsableAt`（专规 1.2 的轨距账本，与 13.3f 的转换共用）；
   *   · EZOC ← `inEnemyZocForAction(…, 'railTransport')`：`zoc-effects` 把 `railTransport` 定为
   *     **不可抵消**（4.5a-C ／ 13.3c 末句「运货时 EZOC 不可抵消」）；仅「连接补给源」的判定
   *     （`zocOnlySupplyFacts`）才按 4.5b 抵消，两处不可混用；
   *   · 敌方战斗单位 ← 盘面推出（给出专码）；非战斗敌方单位由 `enemyOccupies` 一并阻断；
   *   · 13.3c 可火车卸货格 ← 补给层的 `detrainableHexes`（**同一份结论**，不另立一条判据）；
   *   · 14.8 运输破坏区 ← `trainbustingMarks`。
   */
  const railMoveFacts = computed(() =>
    createRailFacts({
      railGaugeUsable: (hex, side) => isRailGaugeUsableAt(hex, side),
      inEnemyZoc: (hex, side) => inEnemyZocForAction(moveContext.value, hex, side, 'railTransport'),
      hasEnemyCombatUnit: (hex, side) =>
        units.value.some((unit) => unit.side !== side && unit.isCombat && sameHex(unit.hex, hex)),
      // 13.3e-2 的「未控制」＝该格（含同格卸货城镇）有敌方单位；与补给侧 `enemyOccupies` 同一判据
      enemyOccupies: (hex, side) =>
        units.value.some((unit) => unit.side !== side && sameHex(unit.hex, hex)),
      // 13.3c 的结论由补给层按**当前行动方**给出；13.3b 也只允许本方使用自己的铁路容量
      isDetrainable: (hex, side) =>
        side === activeSide.value &&
        railSupply.value.detrainableHexes.some((item) => sameHex(item, hex)),
      isRailRepairUnit: (id) => isRailRepairUnit(id),
      isTrainbusting: (hex) => hasTrainbustingAt(hex),
    }),
  )

  /**
   * 13.3e-2：沿铁路的最短**待检**路径（只作提案，裁定仍在引擎）
   *
   * BFS 走引擎的铁路邻接（`railNeighborHexes` → `createRailGraph`），并跳过按同一批事实**已不可能通行**
   * 的格（错误轨距 / 未控制 / 敌方战斗单位 / EZOC）；终点照给，让引擎给出准确的拒绝理由。
   * ★ 刻意不在这里下结论：本函数只回答「有没有一条看起来能走的路」，合法性一律交
   *   `validateRailMovement`（与逐格移动的「BFS 提案 + 引擎裁定」同一模式）。
   */
  /**
   * 13.3e-2：沿铁路的最短**待检**路径（只作提案，裁定仍在引擎）
   *
   * BFS 走引擎的铁路邻接（`railNeighborHexes` → `createRailGraph`），并跳过按同一批事实**已不可能通行**
   * 的格（错误轨距 / 未控制 / 敌方战斗单位 / EZOC）；终点照给，让引擎给出准确的拒绝理由。
   * ★ 刻意不在这里下结论：本函数只回答「有没有一条看起来能走的路」，合法性一律交
   *   `validateRailMovement`（与逐格移动的「BFS 提案 + 引擎裁定」同一模式）。
   *
   * ★ 13.3a 的路径选择：**先试「全程多轨」**（整条路都走在多轨格边上 ⇒ 容量费减半），
   *   找不到才退回普通最短待检路径。理由：容量费与距离无关，只在**全程多轨**时减半，
   *   故全程多轨的那条路永远不比别的路贵——这是玩家会选的那条。两次搜索都只作提案，
   *   合法性仍由 `validateRailMovement` 裁定。
   */
  function railPathBetween(from: HexRef, to: HexRef, side: Side): HexRef[] | null {
    const facts = railMoveFacts.value
    const key = (hex: HexRef): string => `${hex.col}.${hex.row}`
    const goal = key(to)
    /**
     * 13.6b：起点是本方**入场格**时，登车已按「地图外登车」放行（引擎 §①），
     * 提案阶段不得再按轨距/敌情把整条路预先滤掉，否则界面只剩 `noRailPath`，
     * 拿不到 13.3f / 13.3e-2 的真实拒绝原因。故入场起步只搜连通性，合法性全交引擎。
     */
    const entryStart = facts.isEntryHex(from, side)

    /** `multiOnly` = 只走多轨格边（用于先试「全程多轨」） */
    function search(multiOnly: boolean): HexRef[] | null {
      const previous = new Map<string, HexRef>()
      const seen = new Set<string>([key(from)])
      const queue: HexRef[] = [from]
      while (queue.length > 0) {
        const hex = queue.shift()!
        if (key(hex) === goal) break
        for (const next of railNeighborHexes(hex)) {
          const nextKey = key(next)
          if (seen.has(nextKey)) continue
          if (multiOnly && !facts.isMultiTrackEdge(hex, next)) continue
          if (nextKey !== goal && !entryStart) {
            if (!facts.railGaugeUsable(next, side)) continue
            // 13.3e-2 的「未控制」＝该格被敌方单位占据（任意单位；与补给侧同源）
            if (facts.enemyOccupies(next, side)) continue
            if (facts.hasEnemyCombatUnit(next, side)) continue
            if (facts.inEnemyZoc(next, side)) continue
          }
          seen.add(nextKey)
          previous.set(nextKey, hex)
          queue.push(next)
        }
      }
      if (!seen.has(goal)) return null
      const path: HexRef[] = [to]
      let cursor = to
      while (key(cursor) !== key(from)) {
        const before = previous.get(key(cursor))
        if (before === undefined) return null
        path.unshift(before)
        cursor = before
      }
      return path
    }

    return search(true) ?? search(false)
  }

  /** 13.3e：最近一次铁路运货的结论（界面回执） */
  const lastRailMove = ref<{
    rule: string
    detail: string
    cost: number
    path: HexRef[]
  } | null>(null)

  /**
   * 13.3f-B：**本阶段最后一次经铁路移动进入的格**（按单位）
   *
   * 「一个铁路修理单位只需**移动进入**一个铁路格，就可转换该铁路格的轨距」——铁路移动同样是
   * "移动进入"（13.3g-A 明确允许把铁路移动与换轨结合），故它与地面逐格移动并列作为
   * `convertRailGaugeNow` 的入口依据；换阶段即清空（`resetSegmentTransient`）。
   */
  const railArrived = ref<{ instanceId: string; hexText: string } | null>(null)

  /**
   * 13.3f-B：**本阶段各单位的最后一次地面入格**（按单位）
   *
   * 「移动进入」是本阶段的事实，不随移动交互结束、被替换而消失：`moveInteraction.steps` 只保留
   * **当前这一组**单位的移动，玩家换去操作别的单位后原单位的历史就没了 —— 实玩里
   * 「走一格 → 换一格 → 再走下一格」会因此被误拒（端头也就不前移）。
   * 每笔地面步落盘时写入、撤销/取消时回退、换阶段清空。
   */
  const lastGroundEntryByUnit = ref<Record<string, string>>({})

  /**
   * 裁定 3：铁路运输的**待确认**落点
   *
   * 通用流程：合法位置点「铁路运输」→ 有运力则高亮可达目的地 → 点目的地**只进本状态** →
   * 「确认」才落盘扣点，「撤回」清态且不动运力。移动阶段与增援铁路运输共用本状态。
   *
   * M2（用户 2026-11-16）：**增援铁路抵达**那一支不再进本状态——点卸货格即落子，
   * 原位只留一条「撤回」（`arrivalRailUndo`），撤回时退回算子与本笔运力。
   */
  interface PendingRailTransport {
    kind: 'unit' | 'sp' | 'transportPoint'
    side: Side
    to: HexRef
    cost: number
    label: string
    rule: string
  }
  const pendingRailTransport = ref<PendingRailTransport | null>(null)
  /** 移动阶段铁路运货的**试算**结果（点目的地时由 `railMoveNow(kind, true)` 填入） */
  const railMovePreview = ref<{ cost: number; detail: string } | null>(null)
  /** 13.6b：本回合经铁路抵达的到达条目 → 已扣点数（手牌撤回时按此退回） */
  const arrivalRailSpent = ref<Record<number, number>>({})
  /**
   * M2：刚完成的**增援铁路抵达**（落子即完成，只保留"一步撤回"）
   *
   * 撤回走 `withdrawArrivalNow(index)`：算子回手牌、本笔运力退回（13.6b / 裁定 3）。
   */
  const arrivalRailUndo = ref<{ index: number; label: string; cost: number; side: Side } | null>(
    null,
  )

  /* ────────── 13.2f：运输点数装载 / 卸载 SP ────────── */

  /** 13.2f 的输入（哪一个运输点数、装/卸各多少 SP、本次装载选定的补给站） */
  const transportLoadInputs = ref<{
    pointId: string | null
    /** P3：本次装载选定的补给站 id（地面账本或 `unit:` 装载来源） */
    dumpId: string | null
    /** P6：装、卸各用自己的数量，互不串用 */
    loadAmount: number
    unloadAmount: number
  }>({
    pointId: null,
    dumpId: null,
    loadAmount: 1,
    unloadAmount: 1,
  })

  /** 13.2f 的错误（统一形状） */
  const transportLoadError = ref<{ rule: string; reason: string } | null>(null)

  /** 13.2f：该运输点数算子 → 引擎的 `TransportPointActor`（唯一组装点） */
  function transportPointActorOf(unit: ConsoleUnit): TransportPointActor {
    return {
      id: unit.instanceId,
      type: transportKindOf(unit),
      // 13.2f：「支付它**印刷 MA** 的 10%」——按印值而非当前值（故取朝向面印值）
      printedMa: unit.raw.ma,
      // 13.2g：编内卡车（13.2g-A 永远不能在地图上卸载）
      isOrganicTruck: unit.noncombatKind === 'organic_truck',
    }
  }

  /**
   * 12.1b（用户 2026-11-13）：**该格、该方的补给站**——地面账本在前、装载中（`unit:`）在后
   *
   * 原文：「Any location containing Supply Points, whether on the ground or loaded on a
   * Transport Point, is called a dump.」⇒ 装载中的 SP 也能作为装载来源，不能再只看 `spDumps`。
   */
  function transportDumpsAt(unit: ConsoleUnit): readonly SpDump[] {
    return allSpDumps.value.filter((item) => item.side === unit.side && sameHex(item.hex, unit.hex))
  }

  /** 13.2f / 6.1a：本次费用是否会把该点数推过印刷 MA（>0 ⇒ 超支 MP） */
  function transportMpShortfall(unit: ConsoleUnit, costMp: number): number {
    return unit.mpSpent + costMp - unit.raw.ma
  }

  /**
   * 13.2f：该格实际可装多少 SP（运力余量 ∩ 该格可动用 T，且 12.2a 锁先扣）
   *
   * `lockedT` 是**格级**账（不是某一本账的属性）⇒ 先从全格合计里扣一次，再摊到"装多少"。
   */
  function transportLoadableAt(unit: ConsoleUnit): number {
    const dumps = transportDumpsAt(unit)
    if (dumps.length === 0) return 0
    const lockedT = spRelayLockedT(unit.hex, unit.side, 'transport')
    const groundT = dumps.reduce((sum, dump) => sum + holdingsToT({ sp: dump.sp, t: dump.t }), 0)
    const usableT = Math.max(0, groundT - lockedT)
    const roomSp = unit.noncombatTransport - unit.loadedSpT / SP_TO_T
    return Math.max(0, Math.min(Math.floor(roomSp), Math.floor(usableT / SP_TO_T)))
  }

  /**
   * 13.2f（P3）：选一本**能独自付清本次数量**的账本
   *
   * 同格可能有多本（G/H 两本地面账，或若干装载中的运输点数）⇒ 取"够付且持仓最大"的那本，
   * 不让玩家再多做一次下拉/手输。
   */
  function transportLoadDumpFor(unit: ConsoleUnit, wantT: number): SpDump | null {
    const able = transportDumpsAt(unit).filter(
      (dump) => holdingsToT({ sp: dump.sp, t: dump.t }) >= wantT,
    )
    return (
      able.sort(
        (a, b) => holdingsToT({ sp: b.sp, t: b.t }) - holdingsToT({ sp: a.sp, t: a.t }),
      )[0] ?? null
    )
  }

  /**
   * 13.2f：**装载 SP**（运输点数与补给站同格；支付印刷 MA 的 10%）
   *
   * 「运输点数必须与**补给站**位于同一格中才能装载 SP」「运输点数可在**任何格**内装载」
   * ⇒ 位置前提只有「同格有补给站」。装载的 SP 从该站扣、记到点数的 `loadedSpT` 上。
   */
  function loadTransportPointNow(): boolean {
    if (!requireAction('move.loadUnload', '装载 SP')) return false
    const unit = units.value.find((item) => item.instanceId === transportLoadInputs.value.pointId)
    if (unit === undefined) {
      pushLog('warning', '先选择要装载的运输点数（13.2f）', '13.2f')
      return false
    }
    const dumps = transportDumpsAt(unit)
    const outcome = validateTransportPointLoad({
      transportPoint: transportPointActorOf(unit),
      dumpInHex: dumps.length > 0,
    })
    if (!outcome.ok) {
      transportLoadError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `装载被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    // 13.2f / 6.1a：费用按正常方式计入本阶段 MP，不得把 mpSpent 推过印刷 MA
    const shortfall = transportMpShortfall(unit, outcome.data.cost)
    if (shortfall > 0) {
      transportLoadError.value = {
        rule: '13.2f',
        reason: `剩余 MP 不足：装载需 ${outcome.data.cost} MP，超支 ${shortfall} MP（6.1a）`,
      }
      pushLog(
        'warning',
        `${unit.name} 剩余 MP 不足以支付装载费 ${outcome.data.cost} MP（13.2f / 6.1a）`,
        '13.2f',
      )
      return false
    }
    const amount = Math.max(1, Math.trunc(transportLoadInputs.value.loadAmount))
    // 13.2c/4.7c：运输点数的运载能力**不超过其规模**（以 SP 为单位）
    if (unit.loadedSpT / SP_TO_T + amount > unit.noncombatTransport) {
      transportLoadError.value = { rule: '13.2c', reason: 'loadExceedsCapacity' }
      pushLog(
        'warning',
        `该运输点数运力 ${unit.noncombatTransport} SP，装不下 ${amount} SP（13.2c）`,
        '13.2c',
      )
      return false
    }
    // 12.2a：该格本阶段若已有 SP 由**其他**运输方式卸下，则这批 T 不能再装到运输点数上
    const lockedT = spRelayLockedT(unit.hex, unit.side, 'transport')
    if (lockedT > 0) {
      const availableT =
        dumps.reduce((sum, dump) => sum + holdingsToT({ sp: dump.sp, t: dump.t }), 0) - lockedT
      if (amount * SP_TO_T > availableT) {
        transportLoadError.value = { rule: '12.2a', reason: 'relayLockedOtherMode' }
        pushLog(
          'warning',
          `12.2a：该格本阶段由其他运输方式卸下的 ${lockedT} T 不能再装于运输点数（可换回原方式，或等下一阶段）`,
          '12.2a',
        )
        return false
      }
    }
    // P3：同格多本账时选能**独自付清**本次数量的那本；选中的 id 落进输入，付款走同一扣账入口
    const dump = transportLoadDumpFor(unit, amount * SP_TO_T)
    const payment = planSpPayment({
      holdings: { sp: dump?.sp ?? 0, t: dump?.t ?? 0 },
      wantT: amount * SP_TO_T,
    })
    if (dump === null || !payment.ok) {
      transportLoadError.value = { rule: '13.2f', reason: 'loadNotPayable' }
      pushLog(
        'warning',
        `该站的 SP 不足 ${amount} 点（装载不消耗 SP 之外的东西，但货得真的在站上；13.2f）`,
        '13.2f',
      )
      return false
    }
    transportLoadInputs.value.dumpId = dump.id
    const loadedBefore = unit.loadedSpT
    const mpBefore = unit.mpSpent
    const dumpHoldingsBefore: SpHoldings = { sp: dump.sp, t: dump.t }
    setSpDumpHoldings(dump.id, payment.data.holdingsAfter)
    unit.loadedSpT += amount * SP_TO_T
    // 13.2f：装载要支付印刷 MA 的 10%（按 6.1a 计入本阶段已耗 MP）
    unit.mpSpent += outcome.data.cost
    transportLoadError.value = null
    pushLog(
      'success',
      `${unit.name} 装载 ${amount} SP（${outcome.data.detail}）⇒ 已载 ${unit.loadedSpT / SP_TO_T} SP；付款站 ${hexLabel(dump.hex)}`,
      outcome.rule,
    )
    recordSettlement({
      action: 'transportLoad',
      rule: outcome.rule,
      data: {
        pointId: unit.instanceId,
        sp: amount,
        costMp: outcome.data.cost,
        dumpHex: { ...dump.hex },
      },
    })
    transportHandlingUndo.value = [
      ...transportHandlingUndo.value,
      {
        kind: 'load',
        unitId: unit.instanceId,
        loadedBefore,
        mpBefore,
        stepsAt: moveInteraction.value?.steps.length ?? 0,
        dumpId: dump.id,
        dumpHoldingsBefore,
      },
    ]
    // 用户 2026-11-20：装卸也是一笔可撤操作（与移动步共用一个撤销栈，按发生顺序回退）
    noteUndoable('transport', `装载 ${amount} SP：${unit.name}`)
    return true
  }

  /**
   * 13.2f：**卸载 SP**（只在含友方战斗单位/港口/空军基地/已卸载补给站的格；同样支付 10% 印值 MA）
   *
   * 13.2g-A：**编内卡车永远不能在地图上卸载它们的 SP**（引擎按 `isOrganicTruck` 拒）。
   */
  function unloadTransportPointNow(): boolean {
    if (!requireAction('move.loadUnload', '卸载 SP')) return false
    const unit = units.value.find((item) => item.instanceId === transportLoadInputs.value.pointId)
    if (unit === undefined) {
      pushLog('warning', '先选择要卸载的运输点数（13.2f）', '13.2f')
      return false
    }
    // 13.2f：「只能在包含**友方战斗单位、港口、空军基地或已经有已卸载的补给站**的格内卸载」
    const hasFriendlyCombat = units.value.some(
      (item) => item.side === unit.side && item.isCombat && sameHex(item.hex, unit.hex),
    )
    const hasFacility = airBases.value.some((base) => sameHex(base.hex, unit.hex))
    const hasDump = spDumps.value.some(
      (item) => item.side === unit.side && sameHex(item.hex, unit.hex),
    )
    const outcome = validateTransportPointUnload({
      transportPoint: transportPointActorOf(unit),
      hexAllowsUnload: hasFriendlyCombat || hasFacility || hasDump,
    })
    if (!outcome.ok) {
      transportLoadError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `卸载被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    // 13.2f / 6.1a：卸载费同样不得把 mpSpent 推过印刷 MA
    const shortfall = transportMpShortfall(unit, outcome.data.cost)
    if (shortfall > 0) {
      transportLoadError.value = {
        rule: '13.2f',
        reason: `剩余 MP 不足：卸载需 ${outcome.data.cost} MP，超支 ${shortfall} MP（6.1a）`,
      }
      pushLog(
        'warning',
        `${unit.name} 剩余 MP 不足以支付卸载费 ${outcome.data.cost} MP（13.2f / 6.1a）`,
        '13.2f',
      )
      return false
    }
    const amount = Math.max(1, Math.trunc(transportLoadInputs.value.unloadAmount))
    const loaded = unit.loadedSpT / SP_TO_T
    if (loaded < amount) {
      transportLoadError.value = {
        rule: '13.2f',
        reason: `unloadExceedsLoaded:${amount}>${loaded}`,
      }
      pushLog('warning', `该点数只载了 ${loaded} SP，卸不出 ${amount} SP（13.2f）`, '13.2f')
      return false
    }
    const loadedBefore = unit.loadedSpT
    const mpBefore = unit.mpSpent
    const dumpBefore =
      spDumps.value.find((item) => item.side === unit.side && sameHex(item.hex, unit.hex)) ?? null
    const relayLocksBefore = spRelayLocks.value.map((lock) => ({ ...lock }))
    unit.loadedSpT -= amount * SP_TO_T
    grantSpDumpT(unit.hex, unit.side, amount * SP_TO_T)
    // 12.2a：这批 T 本阶段已由「运输点数」卸下 ⇒ 之后不能再用铁路等其他方式运走
    addSpRelayLock(unit.hex, unit.side, 'transport', amount * SP_TO_T)
    unit.mpSpent += outcome.data.cost
    transportLoadError.value = null
    pushLog(
      'success',
      `${unit.name} 卸载 ${amount} SP（${outcome.data.detail}）⇒ 余载 ${unit.loadedSpT / SP_TO_T} SP；落 ${hexLabel(unit.hex)}`,
      outcome.rule,
    )
    recordSettlement({
      action: 'transportUnload',
      rule: outcome.rule,
      data: {
        pointId: unit.instanceId,
        sp: amount,
        costMp: outcome.data.cost,
        hex: { ...unit.hex },
      },
    })
    const dumpAfter =
      dumpBefore === null
        ? (spDumps.value.find((item) => item.side === unit.side && sameHex(item.hex, unit.hex)) ??
          null)
        : null
    transportHandlingUndo.value = [
      ...transportHandlingUndo.value,
      {
        kind: 'unload',
        unitId: unit.instanceId,
        loadedBefore,
        mpBefore,
        stepsAt: moveInteraction.value?.steps.length ?? 0,
        ...(dumpBefore === null ? {} : { dumpId: dumpBefore.id }),
        ...(dumpBefore === null
          ? {}
          : { dumpHoldingsBefore: { sp: dumpBefore.sp, t: dumpBefore.t } }),
        ...(dumpAfter === null ? {} : { dumpCreatedId: dumpAfter.id }),
        relayLocksBefore,
      },
    ]
    // 用户 2026-11-20：装卸也是一笔可撤操作（与移动步共用一个撤销栈，按发生顺序回退）
    noteUndoable('transport', `卸载 SP：${unit.name}`)
    return true
  }

  /**
   * 13.2f：右键**运输点数 / 编内卡车**的「装卸 SP」现在值不值得出现
   *
   * 用户 2026-11-09 口径：「只列当前真正可用的项」。装卸的真判仍是
   * `loadTransportPointNow` / `unloadTransportPointNow`（落账前再走一遍引擎），
   * 这里只复用同一批引擎校验 + 两条事实（站里有货、运力没满）来回答"能不能做"：
   *   · 装载：`validateTransportPointLoad` + 同格补给站有货 + `13.2c` 运力未满；
   *   · 卸载：`validateTransportPointUnload`（含 13.2g-A 编内卡车永不卸）+ 车上真有 SP。
   * 环节闸 `move.loadUnload` 两者共同前置。
   */
  function transportLoadReadyAt(instanceId: string): boolean {
    if (!actionAllowedNow('move.loadUnload')) return false
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return false
    const dumps = transportDumpsAt(unit)
    const outcome = validateTransportPointLoad({
      transportPoint: transportPointActorOf(unit),
      dumpInHex: dumps.length > 0,
    })
    if (!outcome.ok || dumps.length === 0) return false
    // 13.2f / 6.1a：付不起这次装载费就不该出现入口
    if (transportMpShortfall(unit, outcome.data.cost) > 0) return false
    return transportLoadableAt(unit) > 0
  }

  function transportUnloadReadyAt(instanceId: string): boolean {
    if (!actionAllowedNow('move.loadUnload')) return false
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined || unit.loadedSpT <= 0) return false
    const hasFriendlyCombat = units.value.some(
      (item) => item.side === unit.side && item.isCombat && sameHex(item.hex, unit.hex),
    )
    const hasFacility = airBases.value.some((base) => sameHex(base.hex, unit.hex))
    const hasDump = spDumps.value.some(
      (item) => item.side === unit.side && sameHex(item.hex, unit.hex),
    )
    const outcome = validateTransportPointUnload({
      transportPoint: transportPointActorOf(unit),
      hexAllowsUnload: hasFriendlyCombat || hasFacility || hasDump,
    })
    if (!outcome.ok) return false
    // 13.2f / 6.1a：付不起这次卸载费就不该出现入口
    return transportMpShortfall(unit, outcome.data.cost) <= 0
  }

  function transportHandlingReadyAt(instanceId: string): boolean {
    return transportLoadReadyAt(instanceId) || transportUnloadReadyAt(instanceId)
  }

  /**
   * 13.2f：撤销最近一次装卸（MP / 载荷 / 补给站 / 12.2a 接力锁一并回退）
   *
   * 与移动步共用「撤销一步」：只有装卸发生在**最后一个移动步之后**时才先退它；
   * 否则返回 false，让 `undoLastStep()` 先退移动（按发生顺序）。
   */
  function undoTransportHandlingNow(): boolean {
    if (moveUndoSealReasonNow() !== null) return false
    const entry = transportHandlingUndo.value[transportHandlingUndo.value.length - 1]
    if (entry === undefined) return false
    const currentSteps = moveInteraction.value?.steps.length ?? 0
    if (entry.stepsAt !== currentSteps) return false
    const ok = revertTransportHandlingEntry(transportHandlingUndo.value.length - 1)
    if (ok) dropUndoOf('transport')
    return ok
  }

  /** 把一条装卸账回退（不看步数；供"按发生顺序"与"整次放弃"共用） */
  function revertTransportHandlingEntry(index: number): boolean {
    const entry = transportHandlingUndo.value[index]
    if (entry === undefined) return false
    const unit = units.value.find((item) => item.instanceId === entry.unitId)
    if (unit === undefined) {
      transportHandlingUndo.value = transportHandlingUndo.value.filter((_, at) => at !== index)
      return false
    }
    unit.loadedSpT = entry.loadedBefore
    unit.mpSpent = entry.mpBefore
    if (entry.dumpId !== undefined && entry.dumpHoldingsBefore !== undefined) {
      setSpDumpHoldings(entry.dumpId, entry.dumpHoldingsBefore)
    } else if (entry.dumpCreatedId !== undefined) {
      removeSpDump(entry.dumpCreatedId)
    }
    if (entry.relayLocksBefore !== undefined) {
      spRelayLocks.value = entry.relayLocksBefore.map((lock) => ({ ...lock }))
    }
    transportHandlingUndo.value = transportHandlingUndo.value.filter((_, at) => at !== index)
    pushLog(
      'info',
      `撤销${entry.kind === 'load' ? '装载' : '卸载'}：${unit.name} 回到 ${unit.loadedSpT / SP_TO_T} SP（13.2f）`,
      '13.2f',
    )
    return true
  }

  /**
   * 13.2f：本次移动开始后产生的装卸全部回退（按相反顺序）
   *
   * 用于「放弃本次移动」与「关窗回滚」：位置/MP 由引擎快照回退，
   * SP 持仓、落点、12.2a 接力锁也必须一起回退，二者同账。
   */
  function revertTransportHandlingSinceBaseline(): void {
    while (transportHandlingUndo.value.length > transportHandlingBaseline.value) {
      if (!revertTransportHandlingEntry(transportHandlingUndo.value.length - 1)) break
    }
  }

  /**
   * 13.2f：结束移动＝提交 —— 把本段装卸账封存（之后的撤销不得再退回这些装卸）
   */
  function sealTransportHandlingForCommit(): void {
    transportHandlingUndo.value = transportHandlingUndo.value.slice(
      0,
      transportHandlingBaseline.value,
    )
    transportHandlingBaseline.value = transportHandlingUndo.value.length
  }

  /** 按实例 id 取算子（只读；避免在"界面可点到"的读函数里直接摸 `units.value`） */
  function unitOfInstance(instanceId: string): (typeof units.value)[number] | undefined {
    return units.value.find((item) => item.instanceId === instanceId)
  }

  /**
   * 13.2f：这一枚运输点数此刻最多还能**装**多少 SP（0 ⇒ 不能装）
   *
   * 用户 2026-11-11（批四 #14 全流程）：装卸窗不该让玩家自己猜数字。
   * 与 `loadTransportPointNow` 同一批判据：运力余量、同格站上可动用的 T（扣掉 12.2a 锁）、
   * 以及 12.2a「其他方式卸下的 T 不能再装」。
   */
  function transportLoadableSpOf(instanceId: string): number {
    if (!transportLoadReadyAt(instanceId)) return 0
    const unit = unitOfInstance(instanceId)
    return unit === undefined ? 0 : transportLoadableAt(unit)
  }

  /** 13.2f：这一枚运输点数此刻最多能**卸**多少 SP（0 ⇒ 不能卸） */
  function transportUnloadableSpOf(instanceId: string): number {
    if (!transportUnloadReadyAt(instanceId)) return 0
    const unit = unitOfInstance(instanceId)
    return unit === undefined ? 0 : Math.floor(unit.loadedSpT / SP_TO_T)
  }

  /** 12.1b：该运输点数所在格的补给站（地面 + 装载中）——装卸共用同一份事实 */
  function transportDumpsOf(instanceId: string): readonly SpDump[] {
    const unit = unitOfInstance(instanceId)
    return unit === undefined ? [] : transportDumpsAt(unit)
  }

  /** 13.2f：点选装卸对象时预填数量——装、卸各用各的上限（P6） */
  function selectTransportLoadPointNow(instanceId: string): void {
    transportLoadInputs.value.pointId = instanceId
    transportLoadInputs.value.dumpId = null
    const load = transportLoadableSpOf(instanceId)
    const unload = transportUnloadableSpOf(instanceId)
    transportLoadInputs.value.loadAmount = Math.max(1, load)
    transportLoadInputs.value.unloadAmount = Math.max(1, unload)
  }

  /**
   * 4.7d：本阶段**已用铁路运输过**的单位实例 id
   *
   * 「同一个阶段不能使用超过一种运输类型」是**跨动作的阶段级记账**（引擎自注：须由命令层累计，
   * 因为 `rail.ts` 是无状态纯函数）。此处把它落成阶段账本，供界面提示与规则登记。
   */
  const railMovedUnitIdsThisPhase = ref<string[]>([])

  /**
   * 13.3e：**执行一次铁路运货**（登车 → 沿铁路移动 → 卸货，三步同阶段）
   *
   * 货类两种（13.3a）：**单位**（当前选中者）与 **SP**（指定补给站里的若干点）。
   * 硬条件全由引擎判（`validateRailMovement`：13.3b 移动阶段、13.3e 的登车/沿途/卸货、
   * 5.6a 移动模式、5.10d 非 DG、13.3e-1 登车前 ≤ 半 MA、13.3f 轨距、13.3h 控制）；
   * 本处负责：提案路径、**扣铁路容量**（13.3b 的当日额度）、落盘（改货物位置/账本）与留痕。
   */
  function railMoveNow(kind: 'unit' | 'sp' | 'transportPoint', dryRun = false): boolean {
    if (!requireAction('move.railTransport', '铁路运输')) return false
    const to = parseHexPath(railMoveInputs.value.toHexText)[0]
    if (to === undefined) {
      railMoveError.value = { rule: '13.3e', reason: 'railMoveNeedsDestination' }
      pushLog(
        'warning',
        `铁路运货须给卸货格「列.行」，收到「${railMoveInputs.value.toHexText}」（13.3e）`,
        '13.3e',
      )
      return false
    }
    const side = activeSide.value
    const facts = railMoveFacts.value

    // 货物：单位（选中者）或 SP（指定站）
    let from: HexRef
    let cargo: RailCargoView
    /** 13.8c 例外：货物是工程 HQ 时，登车/卸车都跳过「可卸货格」判定 */
    let engineerHqRailMove = false
    if (kind === 'unit') {
      const unit = selectedUnit.value
      if (unit === null) {
        railMoveError.value = { rule: '13.3e', reason: 'railMoveNeedsSelectedUnit' }
        pushLog('warning', '铁路运货（单位）：请先在地图上选中要运输的单位（13.3e）', '13.3e')
        return false
      }
      if (unit.side !== side) {
        railMoveError.value = { rule: '13.3b', reason: 'railMoveOnlyOwnUnits' }
        pushLog('warning', `${unit.name} 不是本方单位（13.3b 只用本方铁路容量）`, '13.3b')
        return false
      }
      from = unit.hex
      // 13.8c：工程能力 HQ 才享有自行登车/卸车的例外；本作 HQ 即工程能力单位（Pioneer 不算）
      engineerHqRailMove = (unit.specialized ?? []).includes('hq')
      cargo = {
        kind: 'unit',
        id: unit.instanceId,
        side,
        re: unit.re,
        // 4.7b：运输当量按**移动模式下的印刷 MA** ⇒ 机动类型也取**移动面**（3.1a 两面可能不同：
        //   如「移动面 leg MA 2」的单位属 4.7b 的短腿减半，而按记录级 truck 会算成全价）
        mobility: unit.faces.move.mobility,
        // 4.7b：运输当量按**移动模式下的印刷 MA**（故取移动面印值，不取当前朝向面）
        moveMa: unit.faces.move.ma,
        mode: unit.mode.mode,
        dg: unit.mode.dg,
        // 13.3e-1：当前生效面的印刷 MA 与登车前已耗 MP
        currentMa: unit.raw.ma,
        preLoadMp: unit.mpSpent,
      }
    } else if (kind === 'transportPoint') {
      /*
       * B-3（13.3a / 4.7）：**以运输点数本身作货物** —— 当量＝它的**运力点数**（size）；
       * 通用前提（登车格可卸货 / 轨距 / 控制 / 无敌军与 EZOC）与容量成本都复用同一条链，
       * 故这里只把「哪一枚、多大」补齐（与 unit / sp 两条同构）。
       */
      const unit = selectedUnit.value
      if (unit === null) {
        railMoveError.value = { rule: '13.3e', reason: 'railMoveNeedsSelectedTransportPoint' }
        pushLog('warning', '铁路运货（运输点数）：请先在地图上选中那枚运输点数（13.3e）', '13.3e')
        return false
      }
      // 13.3b：只用**本方**的铁路容量；运输点数＝运力点数 > 0 的非战斗单位
      if (unit.side !== side || unit.noncombatTransport <= 0) {
        railMoveError.value = { rule: '13.3b', reason: 'railMoveNeedsOwnTransportPoint' }
        pushLog(
          'warning',
          unit.name +
            ' 不是本方的运输点数（13.3b 只用本方铁路容量；运输点数看 noncombatTransport > 0）',
          '13.3b',
        )
        return false
      }
      from = unit.hex
      cargo = { kind: 'transportPoint', id: unit.instanceId, side, size: unit.noncombatTransport }
    } else {
      const dump = spDumps.value.find((item) => item.id === railMoveInputs.value.fromDumpId) ?? null
      if (dump === null || dump.side !== side) {
        railMoveError.value = { rule: '13.3a', reason: 'railMoveSpNeedsOwnDump' }
        pushLog('warning', 'SP 铁路运货：请先指定**己方**的起运补给站（13.3a）', '13.3a')
        return false
      }
      const amount = Math.max(1, Math.trunc(railMoveInputs.value.spAmount))
      from = dump.hex
      cargo = { kind: 'sp', id: dump.id, side, amount }
    }

    const path = railPathBetween(from, to, side)
    if (path === null) {
      railMoveError.value = { rule: '13.3e', reason: 'noRailPath' }
      pushLog(
        'warning',
        `${hexLabel(from)} → ${hexLabel(to)} 之间没有一条可用的铁路路径（13.3e-2：须相连、轨距正确、受控、无敌军与 EZOC）`,
        '13.3e',
      )
      return false
    }
    const outcome = validateRailMovement({
      phase: phase.value as GamePhase,
      cargo,
      from,
      to,
      path,
      facts,
      engineerHqRailMove,
    })
    if (!outcome.ok) {
      railMoveError.value = { rule: outcome.rule, reason: outcome.reason }
      pushLog('warning', `铁路运货被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    // 13.3b：当日额度（1.2）——超出即拒，**不改动任何货物**
    const remaining = railCapRemaining.value[side]
    if (outcome.data.cost > remaining) {
      railMoveError.value = {
        rule: '13.3b',
        reason: `railCapExceeded:${outcome.data.cost}>${remaining}`,
      }
      pushLog(
        'warning',
        `铁路容量不足：本次需 ${outcome.data.cost} 点、本回合余 ${remaining} 点（13.3b；当日额度 ${railCapToday.value[side]}）`,
        '13.3b',
      )
      return false
    }

    // 裁定 3：试算（点目的地时）——校验/计价全部走完，但不改货物、不扣点、不写日志
    if (dryRun) {
      railMovePreview.value = { cost: outcome.data.cost, detail: outcome.data.detail }
      return true
    }

    // ── 落盘 ──
    /*
     * 13.8c：HQ 卸车点「当场成为卸货格」——只在该格**本来不是**可卸货格时新增一条，
     * 避免给城镇/村庄格重复记账；判定取**移动前**的结论（HQ 挪位后实时判定会变）。
     */
    const detrainHexAlreadyUsable =
      engineerHqRailMove &&
      cargo.kind === 'unit' &&
      cargoDetrainableHexesBySide.value[side].some((hex) => sameHex(hex, to))
    let detrainCreated = false
    // B-3：运输点数货物与单位货物一样是**把那枚算子挪过去**（13.3e-3 卸货）
    if (cargo.kind === 'unit' || cargo.kind === 'transportPoint') {
      const unit = units.value.find((item) => item.instanceId === cargo.id)
      if (unit !== undefined) {
        unit.hex = { col: to.col, row: to.row }
        // 13.8c：工程 HQ 的卸车点立刻成为卸货格，供后续铁路运输使用
        if (engineerHqRailMove && !detrainHexAlreadyUsable) {
          const alreadyRecorded = engineerHqDetrainableHexes.value.some(
            (item) => item.side === side && sameHex(item.hex, to),
          )
          if (!alreadyRecorded) {
            engineerHqDetrainableHexes.value = [
              ...engineerHqDetrainableHexes.value,
              { hex: { col: to.col, row: to.row }, side },
            ]
          }
          detrainCreated = true
        }
        // 13.3f-B：铁路移动也是"移动进入"，记下该单位本阶段最后进入的格（供换轨判定）
        railArrived.value = { instanceId: unit.instanceId, hexText: hexLabel(to) }
        // 13.8b 末句例外：铁路离开记录格后，这条例外即用尽
        noteUnitLeftOwnBridgeHex(unit)
        // 4.7d / 13.3e-3：卸货后不得再移动（13.3g-B 的铁路修理单位例外，其剩余 MP 已由引擎给出）
        unit.movementEnded = outcome.data.postDetrainMp <= 0
        railMovedUnitIdsThisPhase.value = [
          ...new Set([...railMovedUnitIdsThisPhase.value, unit.instanceId]),
        ]
        /*
         * 13.3g-A：铁路修理单位用铁路移动走过"本阶段刚换过轨的格" ⇒ 记账，
         * 此后它再换轨会被 13.3g-A 拦下（"不能接力"）。
         * ★ 取值范围按原文的**「用于铁路移动的格」**取**整条路径（含登车格）**；
         *   引擎入参的注释写的是"进入过"，若日后要收窄成"仅进入段"，只改这一处 filter 即可。
         */
        if (isRailRepairUnit(unit.instanceId)) {
          const walkedKeys = path
            .map((hex) => hexLabel(hex))
            .filter((text) => convertedHexesThisPhase.value.includes(text))
          if (walkedKeys.length > 0) {
            const before =
              railMovedNewTrackThisPhase.value.find((item) => item.instanceId === unit.instanceId)
                ?.hexes ?? []
            railMovedNewTrackThisPhase.value = [
              ...railMovedNewTrackThisPhase.value.filter(
                (item) => item.instanceId !== unit.instanceId,
              ),
              { instanceId: unit.instanceId, hexes: [...new Set([...before, ...walkedKeys])] },
            ]
          }
        }
      }
    } else {
      const amountT = cargo.amount * SP_TO_T
      const dump = spDumps.value.find((item) => item.id === railMoveInputs.value.fromDumpId) ?? null
      // 12.2a：该格本阶段若已有 SP 由**其他**运输方式卸下，则这批 T 不能再上铁路
      if (dump !== null) {
        const lockedT = spRelayLockedT(dump.hex, dump.side, 'rail')
        const availableT = holdingsToT({ sp: dump.sp, t: dump.t }) - lockedT
        if (lockedT > 0 && amountT > availableT) {
          railMoveError.value = { rule: '12.2a', reason: 'railRelayLockedOtherMode' }
          pushLog(
            'warning',
            `12.2a：该格本阶段由其他运输方式卸下的 ${lockedT} T 不能再上铁路（可换回原方式，或等下一阶段）`,
            '12.2a',
          )
          return false
        }
      }
      const payment = planSpPayment({
        holdings: { sp: dump?.sp ?? 0, t: dump?.t ?? 0 },
        wantT: amountT,
      })
      if (dump === null || !payment.ok) {
        railMoveError.value = { rule: '13.3a', reason: 'railMoveSpNotPayable' }
        pushLog('warning', 'SP 铁路运货：起运站的 SP 不足（13.3a）', '13.3a')
        return false
      }
      setSpDumpHoldings(dump.id, payment.data.holdingsAfter)
      grantSpDumpT(to, side, amountT)
      // 12.2a：这批 T 本阶段已由「铁路」运达 ⇒ 之后不能再换其他方式
      addSpRelayLock(to, side, 'rail', amountT)
    }
    spendRailCapacity(side, outcome.data.cost)
    railMoveError.value = null
    lastRailMove.value = {
      rule: outcome.data.rule,
      detail: outcome.data.detail,
      cost: outcome.data.cost,
      path: path.map((hex) => ({ ...hex })),
    }
    pushLog(
      'success',
      `${outcome.data.detail}；${hexLabel(from)} → ${hexLabel(to)}（${path.length - 1} 格）｜` +
        `本回合已用容量 ${railCapUsedBy(side)}/${railCapToday.value[side]}` +
        (detrainCreated ? `｜13.8c：卸车点 ${hexLabel(to)} 成为卸货格` : ''),
      outcome.data.rule,
    )
    recordSettlement({
      action: 'railMove',
      rule: outcome.data.rule,
      data: {
        cargoKind: cargo.kind,
        cargoId: cargo.id,
        from: { ...from },
        to: { ...to },
        hexes: path.length,
        cost: outcome.data.cost,
        equivalent: outcome.data.equivalent,
        factor: outcome.data.factor,
      },
    })
    return true
  }

  /** C8：步骤清单（12.6 判定 → 12.3 选源/拖取 → 12.6c/d 断补处置；给界面打勾用） */
  const supplyChecklist = computed(() =>
    supplyState.value === null ? [] : supplyStepChecklist(supplyState.value),
  )

  /** C8：来源清单（含距离与路径；可用性由引擎逐条裁定） */
  const supplySources = computed<SupplySourceOption[]>(() => supplyState.value?.sources ?? [])

  /** C8：地图上要画的那条来源（优先界面预览项，其次已选项） */
  const supplyFocusSource = computed<SupplySourceOption | null>(() => {
    const state = supplyState.value
    if (state === null) return null
    const index = supplyPreviewIndex.value
    if (index !== null) return state.sources[index] ?? null
    return state.chosenSource ?? null
  })

  /**
   * C8：焦点来源的**投递/拖取覆盖范围**（12.3d：沿补给路径逐格移动能到的全部格）
   *
   * 供地图铺色「这个补给站/指挥部能够到哪」——与单点判定共用 `supplyCoverage`（同一 `stepMp`）。
   */
  const supplyCoverageHexes = computed<SupplyReachableHex[]>(() => {
    const state = supplyState.value
    const source = supplyFocusSource.value
    if (state === null || source === null) return []
    const hex = source.hex
    if (hex === null) return []
    // 12.3a：直接拖取按**轮式 MP** 计（5 MP）
    if (source.kind === 'dump')
      return supplyCoverage(supplyFacts.value, {
        from: hex,
        side: state.side,
        mobility: 'truck',
        maxMp: DIRECT_DRAW_RANGE_MP,
      })
    // 12.3b：投递按 HQ 的印值投递距离与「颜色所示的机动类型」计
    if (source.kind === 'hqThrow') {
      const hq = units.value.find(
        (unit) => unit.side === state.side && sameHex(unit.hex, hex) && isHqUnit(unit),
      )
      if (hq === undefined) return []
      const view = toThrowHqView(hq)
      return supplyCoverage(supplyFacts.value, {
        from: hex,
        side: state.side,
        mobility: view.throwMobility,
        maxMp: view.throwRangeMp,
      })
    }
    // 12.6a 的追溯源只提供连通性（没有距离上限），不画覆盖范围
    return []
  })

  /**
   * 13.2g-B：把**按格**给的来源展开成「每份持仓一条」（12.1b + 13.2f）
   *
   * 引擎的来源表按格给（12.1b 的「位置」），不知道同格里还分地面账本与装载在运输点数上的 SP。
   * 同格两处来源都合法（原文没有取用先后），但 13.2g-B 只允许**同一多单位编队**拖取编内卡车的
   * SP ⇒ 必须逐份复核，不能像修前那样只看同格第一条（那样地面账本排在前时，编内卡车的限制整个失效）。
   *
   * 装载来源的那几条写上 `stockId`，把付款钉到那一辆（`resolvePayDump` 据此扣账）。
   */
  function expandSameHexStocks(
    sources: readonly SupplySourceOption[],
    drawer: ConsoleUnit,
  ): SupplySourceOption[] {
    // 引擎按格给来源，但同格两处持仓时也可能给两条 ⇒ 展开前按格去重（否则一份持仓会被数两遍）
    const seenHex = new Set<string>()
    return sources.flatMap((source) => {
      if (source.kind !== 'dump' || source.hex === null) return [source]
      const hex = source.hex
      const key = hexTextOf(hex)
      const stocks = allSpDumps.value.filter(
        (dump) => dump.side === drawer.side && sameHex(dump.hex, hex),
      )
      const carriers = stocks.filter((stock) => stock.carriedBy !== undefined)
      // 纯地面：12.1b 同格就是一个补给站，保持引擎原样（3.4b 的集群拆分另行处理）
      if (carriers.length === 0) return [source]
      if (seenHex.has(key)) return []
      seenHex.add(key)
      /*
       * 12.1b：同格的**地面** SP 仍是一个补给站（3.4b 的集群拆分只是显示与扣哪一摞的差别，
       * 由 `supplyPayDumpCandidates` 承担）⇒ 地面那一条**不**写 `stockId`、不按账本条目展开。
       * 装载在运输点数上的 SP（13.2f）是另一处来源（13.2g-B 另限编队）⇒ 逐辆一条。
       */
      const groundT = stocks
        .filter((stock) => stock.carriedBy === undefined)
        .reduce((sum, stock) => sum + stock.sp * SP_TO_T + stock.t, 0)
      const hasGround = groundT > 0
      const ground: SupplySourceOption[] = hasGround
        ? [
            {
              ...source,
              // 地面那一条不写 `stockId`（3.4b 的集群拆分仍由 `supplyPayDumpCandidates` 承担），
              // 只在同格还有装载来源时补一句"这是地面补给站"，让玩家能明确选哪一处
              ...(carriers.length > 0
                ? {
                    stockLabel: `地面补给站 ${Math.floor(groundT / SP_TO_T)} SP + ${groundT % SP_TO_T} T（12.1b）`,
                  }
                : {}),
            },
          ]
        : []
      return [
        ...ground,
        ...carriers.map((stock) => {
          const allowed = canDrawFromCarrier({
            carrierIsOrganicTruck: stock.carrierIsOrganicTruck === true,
            carrierFormation: stock.carrierFormation ?? null,
            drawerFormation: drawer.formation,
          })
          const detail = `${source.detail}｜本格来源：${supplyStockLabelOf(stock)}`
          return {
            ...source,
            stockId: stock.id,
            ...(allowed
              ? { detail }
              : { ok: false, rule: '13.2g-B', reason: 'carrierFormationMismatch', detail }),
          }
        }),
      ]
    })
  }

  /**
   * 12.3a：该格该方能**直接拖到**的补给站（引擎结论原样，含距离与路径）
   *
   * 唯一可达性判据是引擎的 `drawableDumpsFor`（12.3a 的 5 MP 直拖 + 12.3c 的「相邻即可」）。
   * 本函数只是把「用哪份地图事实」这一句固定下来——修前这句话在仓里抄了四遍
   * （HQ 投递候选 / 吃图上补给的最近站 / 机场整备付款 / 作战格付款），任一处漏了 `.filter(ok)`
   * 都会让「拖不到」的补给站混进候选。
   */
  function drawableDumpsAt(hex: HexRef, side: Side, mobility?: SupplyMobility): DrawableDump[] {
    return drawableDumpsFor(supplyFacts.value, {
      hex,
      side,
      ...(mobility === undefined ? {} : { mobility }),
    }).filter((dump) => dump.ok)
  }

  /**
   * 12.3a：把上一项映射回**补给站账本条目**（按格匹配；账本是 `spDumps` 的唯一来源）
   *
   * ★ 13.2g-B（B42）：给了 `drawer` 时，装载在**编内卡车**上的来源还要过一遍"同一多单位编队"的资格 ——
   *   「只允许**同一多单位编队内的单位**拖取它们的 SP」（判据在引擎 `canDrawFromCarrier`，此处只消费结论）。
   *   不给 `drawer`（例如"这座站在哪"的纯地理查询）则不施加该项检查。
   */
  function drawableSpDumpsAt(
    hex: HexRef,
    side: Side,
    mobility?: SupplyMobility,
    drawer?: ConsoleUnit | null,
  ): SpDump[] {
    const keys = new Set(drawableDumpsAt(hex, side, mobility).map((dump) => hexLabel(dump.hex)))
    // 12.1b（B32 步骤 5）：**装载在运输点数上的 SP** 同样是可拖取的来源
    return allSpDumps.value.filter(
      (dump) =>
        dump.side === side &&
        keys.has(hexLabel(dump.hex)) &&
        (drawer === undefined ||
          drawer === null ||
          canDrawFromCarrier({
            carrierIsOrganicTruck: dump.carrierIsOrganicTruck === true,
            carrierFormation: dump.carrierFormation ?? null,
            drawerFormation: drawer.formation,
          })),
    )
  }

  /**
   * C8：投递时的**付款补给站**候选（12.3b：HQ 先按 12.3a 从补给站拖取 SP，再前送给目标单位）
   *
   * 结论由引擎 `drawableDumpsFor` 给出（把「该格」换成 HQ 所在格），与 HQ 能否投递的判据同源。
   */
  const supplyPayDumpCandidates = computed<SpDump[]>(() => {
    const state = supplyState.value
    if (state === null) return []
    const source = state.chosenSource
    if (source === undefined) return []
    if (source.kind === 'dump') {
      // 12.1b：来源已按每份持仓展开 ⇒ 付款落点就是玩家选中的那一份，不再出「同格选哪一摞」
      if (source.stockId !== undefined) return []
      /*
       * 3.4b（用户补充裁定）：同格同时有 Guderian / Hoth 两份 SP 时，**非编队德军**可以选扣哪一份；
       * 只有一个集群有 SP 时不出选择（`resolvePayDump` 直接扣那一条）。苏联单位与失效期不出现。
       */
      const sourceHex = source.hex
      if (!panzerGroupRulesOn.value || state.side !== 'axis' || sourceHex === null) return []
      const sameHexDumps = spDumpsOfSide.value.filter(
        (dump) => sameHex(dump.hex, sourceHex) && (dump.sp > 0 || dump.t > 0),
      )
      const groups = new Set(sameHexDumps.map((dump) => panzerGroupOfDump(dump.id)))
      return groups.size > 1 ? sameHexDumps : []
    }
    if (source.kind !== 'hqThrow') return []
    const hex = source.hex
    if (hex === null) return []
    const hq = units.value.find(
      (unit) => unit.side === state.side && sameHex(unit.hex, hex) && isHqUnit(unit),
    )
    const mobility = hq === undefined ? 'truck' : toThrowHqView(hq).throwMobility
    /*
     * ★ 批 B 切片 2：把指挥部自己作为**拖取者**传进去 —— 13.2g 末句「玩家可以使用指挥部，将装载于
     *   编内卡车的补给，投递给同一多单位编队内的单位」⇒ 指挥部从编内卡车拖取同样受 13.2g-B 的
     *   "同一多单位编队"约束（判据还是那一条 `canDrawFromCarrier`）。
     */
    return drawableSpDumpsAt(hex, state.side, mobility, hq ?? null)
  })

  /**
   * B14d（用户口径⑪）：在算子图阵列里**点选/再点取消**投递的付款补给站
   *
   * 旧下拉的第一项是「（自动）」＝`payFromDumpId: null`（由引擎取候选第一座），阵列没有"空档"
   * ⇒ 用「点同一座即回到自动」补上这条退路（与轰炸面板的付款站、15.4 的被指定单位同一手感）。
   */
  function toggleSupplyPayDump(dumpId: string): void {
    const current = supplyInputs.value.payFromDumpId
    supplyInputs.value = {
      ...supplyInputs.value,
      payFromDumpId: current === dumpId ? null : dumpId,
    }
  }

  /**
   * C8：吃图上补给（12.6c）的付款补给站
   *
   * 12.6c 的前提是「单位在补给站的拖取或投递距离内」⇒ 取该单位能拖到的**最近**那个补给站付款
   * （多个都在距离内时任选其一皆合法，取最近者仅为确定性）。
   *
   * ★ 抽成具名函数是为了让 `beginSupplyCheckNow` 能在**评估之前**就知道付款站——
   *   12.6c 的批量费率要按「已从**同一补给站**喂过的 RE」取整（见 `oosFedReByDump`）。
   */
  function nearestDrawableDump(hex: HexRef, side: Side): SpDump | null {
    const drawable = drawableDumpsAt(hex, side)
    if (drawable.length === 0) return null
    const nearest = drawable.reduce((a, b) =>
      (a.distanceMp ?? Number.POSITIVE_INFINITY) <= (b.distanceMp ?? Number.POSITIVE_INFINITY)
        ? a
        : b,
    )
    return (
      allSpDumps.value.find((dump) => dump.side === side && sameHex(dump.hex, nearest.hex)) ?? null
    )
  }

  /**
   * 12.6c：本环节各补给站**已喂过的 RE 总量**（批量费率取整用）
   *
   * 条文「每消耗 1T，就可以为最多 2RE ……所有小数向上取整；例如，**6.5 的 RE 需消耗 4T**」
   * ——6.5 RE 只能是**一批单位合计**，故取整作用在批次总量上。界面是一个单位一次地喂，
   * 故用本账本累计"同一补给站本环节已喂了多少 RE"，收费时只付**增量**
   * （`ceil((已喂+本次)/2) − ceil(已喂/2)`），累计恰等于批量口径。
   * 换阶段即清空（批次以本环节为单位）。
   */
  const oosFedReByDump = ref<Record<string, number>>({})

  /** 该补给站本环节已喂的 RE 总量 */
  function fedReOf(dumpId: string | null): number {
    return dumpId === null ? 0 : (oosFedReByDump.value[dumpId] ?? 0)
  }

  /** 12.6c：吃图上补给的付款站（供界面显示） */
  const supplyOosPayDump = computed<SpDump | null>(() => {
    const state = supplyState.value
    if (state === null) return null
    return nearestDrawableDump(state.unitHex, state.side)
  })

  /** C8：结论摘要（12.6 判定 / 12.3 结算 / 12.6c-d 处置；供界面显示） */
  const supplySummary = computed(() => {
    const state = supplyState.value
    if (state === null) return null
    return {
      step: state.step,
      branch: state.branch,
      unitHex: state.unitHex,
      /** 12.6 的判定结论（inSupply / canEatOffTheMap / outOfSupply / notRequired） */
      status: state.assessment.status,
      /** 12.6 追溯结论（含所连到的源） */
      trace: state.assessment.trace,
      /** 12.6c：能否吃图上补给及其代价 */
      canEatOffTheMap: state.assessment.canEatOffTheMap,
      eatingCostT: state.assessment.eatingCostT,
      sourceCount: state.sources.length,
      chosenSource: state.chosenSource ?? null,
      pickup: state.pickup ?? null,
      oos: state.oos ?? null,
      finished: state.finished,
    }
  })

  /**
   * 12.3 + 12.4 / 12.5 / 15.1：本次拖取/投递**应付多少 T**（用户 2026-09-17 裁定⑤「获取即付款」）
   *
   * 「在玩家任何需要补给（追溯补给、**燃料**、**战斗**、建造、补充部队储备，或**飞机整备**）的时候，
   *   都需要使用直接拖取和指挥部投递中的同一种相同的机制进行补给」（12.3 重要提示）
   * ⇒ **获取与用途是同一个动作的两面**，费率由**用途**决定：
   *   · **燃料（12.5）** ⇒ 12.5c-C **单独单位法**：每单位 1 T（本条链是**逐单位**的；
   *     整编队的 12.5c-A 与 HQ 的 12.5c-B 在移动面板里按整编队/指挥部整批付）。判据走引擎
   *     `computeFuelCost`——**费率不在这里另写一份**；
   *   · **飞机整备（15.1）** ⇒ 1 T（15.1B，与 `refitBaseNow` 的 `availableT: 1` 同一口径）；
   *   · **战斗补给（12.4）** ⇒ **不在本链付**（裁定⑥：只在战斗会话内付）⇒ 返回 null，调用方按 12.4 拒绝；
   *   · **补充部队储备（12.10）/ 建造（13.8）** ⇒ **数量即内容** ⇒ 用玩家填的 T 数（补多少储备、
   *     修什么工事），这两条是裁定⑤明许保留手填的例外。
   *
   * ★ 为什么不能再让玩家手填 T 数：12.4/12.5 的费率是死的 ⇒ 自由填 T 数＝允许少付
   *   （修前那条链只扣玩家声明的数字，扣 1T 也能把一辆坦克"加油"）。
   */
  const supplyPickupRequirement = computed<{
    /** 应付 T（`manual` 为真时是玩家填的那个数） */
    t: number
    rule: string
    detail: string
    /** 数量即内容（12.10 储备 / 13.8 建造）⇒ 由玩家填；其余由费率算 */
    manual: boolean
  } | null>(() => {
    const purpose = supplyInputs.value.purpose
    // 12.4 / 裁定⑥：战斗补给只在战斗会话内付（本链不付）
    if (purpose === 'combat') return null
    if (purpose === 'fuel') {
      const cost = computeFuelCost({ method: 'singleUnit', unitsNeedingFuel: 1 })
      if (!cost.ok) return null
      return {
        t: cost.t,
        rule: cost.rule,
        detail: '12.5c-C 单独单位法：每单位 1 T（只在本阶段有效，12.5c-C/12.5d）',
        manual: false,
      }
    }
    if (purpose === 'refit') {
      return { t: 1, rule: '15.1B', detail: '15.1B：整备一次付 1 T', manual: false }
    }
    const manual = Math.max(0, Math.trunc(supplyInputs.value.amountT))
    return purpose === 'internalStocks'
      ? {
          t: manual,
          rule: '12.10',
          detail: `12.10：补给多少部队储备就付多少 T（数量即内容）`,
          manual: true,
        }
      : {
          t: manual,
          rule: '13.8',
          detail: `13.8：建造费用按数量付（数量即内容）`,
          manual: true,
        }
  })

  /**
   * C5：全部单位的运行态视图（引擎 `move-interaction` 函数的输入）
   *
   * 与 `state-types.Unit` 的对应：`spentMp`→（本阶段累计已耗 MP）、`ended`→`movementEnded`。
   */
  const moveRuntime = computed<MoveUnitRuntime[]>(() => units.value.map(toMoveRuntime))
  /**
   * M1（用户 2026-11-16）：取子清单的**预演交互**（还没开拔时的可到达范围）
   *
   * 只用于算高亮与预览：`{unitIds, start, steps: [], finished: false}` 喂给同一个
   * `reachableForMove`，不写盘面、不改 `movePick`。真开拔仍走 `confirmMovePick`。
   */
  const movePickPreviewInteraction = computed<MoveInteractionState | null>(() => {
    if (moveInteraction.value !== null) return null
    const pick = movePick.value
    if (pick === null) return null
    const pool = new Set(movePickPoolAt(pick.hex).map((unit) => unit.instanceId))
    const ids = pick.ids.filter((id) => pool.has(id))
    if (ids.length === 0) return null
    return {
      unitIds: ids,
      start: { col: pick.hex.col, row: pick.hex.row },
      steps: [],
      finished: false,
    }
  })
  /**
   * 可走格此刻**该不该投**
   *
   * 用户 2026-11-18：初设（只做选中/堆叠显示）与 A 整备段一律不投；只有移动类环节
   * （`.modeAndMovement` / `.movement`）才投。`groupReachable` 与地图覆盖层共用这一条判据，
   * 不再各写一遍。真正"有没有 MP / 有没有合法落点"仍由引擎的 `reachableForMove` 决定。
   */
  const moveRangeDisplayLive = computed<boolean>(() => {
    if (initialSetupInProgress.value) return false
    const stepId = segmentStep.value?.id ?? ''
    return stepId.endsWith('.modeAndMovement') || stepId.endsWith('.movement')
  })

  /**
   * C5：本次移动的可到达范围（堆叠取并集；6.1/6.1b/6.1f）
   *
   * 结论全部来自引擎 `reachableForMove`（底层是 `computeReachableHexes`，与逐格 `evaluateStep`
   * 同一套判据）；F 战斗段没有移动环节（2.2），故此处不会存在「已经开始移动」的状态。
   *
   * M1：还没开拔时用取子清单的**预演交互**算同样的范围 ⇒ 勾选后地图上就有可落点高亮。
   */
  const groupReachable = computed<GroupReachable>(() => {
    /*
     * ★ 用户 2026-11-18：可走格的**唯一闸门**＝「是不是移动环节」。
     *   初设（`initialSetupInProgress`）与 A 整备段都不投：初设左键只做选中与堆叠显示，
     *   整备段没有任何走位提示。修前初设的地图阶段值沿用 `movement` 默认 ⇒ 点格摊堆叠
     *   就会建待开拔集并画出可走格（用户实测），A 段残留的未结束交互也会继续投。
     */
    if (!moveRangeDisplayLive.value) return { units: [], hexes: [] }
    const interaction = moveInteraction.value ?? movePickPreviewInteraction.value
    if (interaction === null) return { units: [], hexes: [] }
    // 2.2：回合准备环节没有行动段 ⇒ 不给出任何可走格（否则界面会"看起来能走"）
    if (segmentLocked.value) return { units: [], hexes: [] }
    /*
     * 用户 2026-11-13：9.2 战斗会话**进行中**（含从移动发起的突袭）不铺移动范围。
     * 常规战斗本就没有 `moveInteraction`；突袭必须保留它（3MP 记账 / K5 撤销锚 / 8.1e 收束后
     * 继续走），所以只能在这里按会话态早退。收束（`finished`）即恢复——面板可能还开着给玩家
     * 看结算，但范围与紫环已可回到 8.1e 的「继续移动」状态。
     */
    if (combatState.value !== null && combatState.value.finished !== true)
      return { units: [], hexes: [] }
    return reachableForMove({
      context: moveContext.value,
      interaction,
      runtime: moveRuntime.value,
    })
  })

  /**
   * G1（用户 2026-11-17 实走）：**选了单位却零高亮时必须就地说明原因**
   *
   * 实走现场：进击段选中无燃料的履带单位，高亮 0 格，面板仍写「已选 1 枚 · 点地图高亮格开拔」，
   * 顶部提示仍教「点己方算子＝显示可移动范围」——点了没反应且没有解释。
   * 引擎其实已把逐单位判据放在 `groupReachable.units[].blocked`（12.5a 未加油 / 4.5b 已承诺 /
   * 6.1b 无 MA …），这里只把 StepFailure 折成人话；判据本身不另写一份。
   */
  function moveFailureNote(failure: StepFailure): {
    rule: string
    text: string
  } {
    const rule = failure.rule
    /*
     * 用户 2026-11-18：界面只写人话，**任何内部码都不许漏出去**。
     * 地形名这类 detail 由引擎给（中文），可以拼进来；`reason` 代码本身一律不打印。
     */
    const detail = failure.detail === undefined ? '' : `：${failure.detail}`
    switch (failure.reason) {
      case 'needsFuel':
        return { rule, text: '未加注燃料（12.5a）：右键该单位 →「加油」付款后再开拔' }
      case 'mpLocked':
        return { rule, text: '本阶段已承诺不再耗 MP（4.5b）：本阶段不能再移动它' }
      case 'immobile':
      case 'noMa':
        return { rule, text: '该单位没有移动力（6.1b）' }
      case 'extenderCannotMove':
        return { rule, text: '延补队面不可移动（12.7）：先翻回运输点数面' }
      case 'prohibited':
        return { rule, text: `地形不可进${detail}（${rule}）` }
      case 'notEnoughMp':
        return { rule, text: `MA 不足（6.1a）：${failure.detail ?? ''}` }
      case 'enemyOccupied':
        return { rule, text: '敌占格：须用突袭进入（6.3b）' }
      case 'enemySafeEdge':
        return { rule, text: '敌方安全边缘格不可进入（专规 1.1b）' }
      case 'outsidePlayArea':
        return { rule, text: '该格在剧本活动区之外（专规 1.4）' }
      case 'destinationOffMap':
        return { rule, text: '该格在地图之外（专规 1.4）' }
      case 'notAdjacent':
        return { rule, text: '该格与单位不相邻（6.1）' }
      case 'stratIntoEzoc':
        return { rule, text: '战略模式不能进入敌方 ZOC（5.8a）' }
      case 'stratMustEndInSupply':
        return { rule, text: '战略模式必须在有追溯补给的格内结束移动（5.8b）' }
      case 'stackingLimit':
        return { rule, text: '目标格超出堆叠上限（4.8）' }
      case 'reciprocity':
        return { rule, text: '该格进得去、回不来（6.1d 互逆性）' }
      case 'unknownTerrain':
      case 'noTerrain':
        return { rule, text: '该格地形无法判定（地形数据问题）' }
      case 'notOnMap':
        return { rule, text: '该单位不在图上' }
      case 'notAttackCapable':
        return { rule, text: '该单位不能攻击（4.4）' }
      case 'phaseNotAllowed':
        return { rule, text: `本阶段不能移动该单位（${rule}）${detail}` }
      default:
        return { rule, text: `该步不可进入（${rule}）` }
    }
  }

  /**
   * G1：待开拔清单「有选中、但一格也走不进去」时的原因（没有就返回 null）
   *
   * 两种来源分开说：引擎已给的单位级 `blocked`（12.5a 等）原样用；
   * 单位本身能动、但 BFS 一个可停格都没产生（被地形/敌军/MP 围死）⇒ 说「四周没有可进入的格」。
   */
  const movePickBlockNote = computed<{ rule: string; text: string } | null>(() => {
    const pick = movePick.value
    if (pick === null || moveInteraction.value !== null || pick.ids.length === 0) return null
    if (groupReachable.value.hexes.length > 0) return null
    const blocked = groupReachable.value.units.find((item) => !item.ok)
    if (blocked !== undefined && !blocked.ok && blocked.blocked !== undefined)
      return moveFailureNote(blocked.blocked)
    return {
      rule: '6.1a',
      text: '所选单位四周没有可进入的格（地形 / 过河 / MP 不足，6.1a / 6.2）—— 换选别的算子，或点「进入下一环节」',
    }
  })

  /**
   * G1：点了一个走不进的格 ⇒ 说清是**哪种**走不进（未加油 / 地形 / MA / 敌占 / 出界）
   *
   * 判据全部来自引擎：先按单位当前位置问 `evaluateStep`（相邻格拿到的是第一手原因）；
   * 非相邻格则从「最省 MP 的可落点」再问一次最后一步，尽量把原因落到地形或 MA 上。
   * 都没有就落回「MA 不足或路线被地形截断」，不再用笼统的"不在可到达范围内"盖住一切。
   */
  function moveRejectNoteAt(hex: HexRef): { rule: string; text: string } {
    const unitId = movePick.value?.ids[0]
    const view = unitId === undefined ? null : findMoveUnit(moveContext.value, unitId)
    if (view === null)
      return {
        rule: '6.1',
        text: '该格不在所选单位的可到达范围内（6.1）：点地图高亮格开拔',
      }
    const direct = evaluateStep(moveContext.value, view.id, hex)
    // 单步判定对「远处的格」只会回 notAdjacent（那不是原因，是距离）⇒ 继续做最后一格分析
    if (!direct.ok && direct.reason !== 'notAdjacent')
      return {
        rule: direct.rule,
        text: `走不进 ${hex.col}.${hex.row}：${moveFailureNote(direct).text}`,
      }
    const approach = groupReachable.value.hexes
      .filter((node) => areAdjacent(node.hex, hex))
      .sort((a, b) => a.mpSpent - b.mpSpent)[0]
    if (approach !== undefined) {
      const last = evaluateStepFrom(moveContext.value, view, approach.hex, hex, {
        mpSpent: approach.mpSpent,
      })
      if (!last.ok)
        return {
          rule: last.rule,
          text: `走不进 ${hex.col}.${hex.row}：${moveFailureNote(last).text}`,
        }
    }
    return {
      rule: '6.1a',
      text: `走不到 ${hex.col}.${hex.row}：MA 不足或路线被地形截断（6.1a）：点地图高亮格开拔`,
    }
  }

  /** C5：参移单位（选中顺序；界面显示与模式/燃料面板用） */
  const moveUnits = computed<ConsoleUnit[]>(() => {
    const interaction = moveInteraction.value
    if (interaction === null) return []
    return interaction.unitIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
  })

  /** C5：仍在本轮移动中的参移单位（未结束） */
  const activeMoveUnits = computed<ConsoleUnit[]>(() =>
    moveUnits.value.filter((unit) => !unit.movementEnded),
  )

  /**
   * 4.5a-A：**可发起突袭**的参移单位（第六批条 14）
   *
   * ＝ 仍在移动者 **加上** 「本轮因进入未抵消敌方 ZOC 而被迫停车」者。
   *   后者由 `zocStoppedMoveUnitIds` 记账：它们的 `movementEnded` 已被 `planStep` 置真，
   *   但 4.5a-A 明写这一枚「要么结束移动、要么进行突袭」⇒ 停车**不等于**丧失突袭资格。
   *   （反过来，因 6.1f 主动放下、8.1f 选项撤退、走完 MA 等而结束的单位**不在**账本里 ⇒ 不再可突袭。）
   */
  const overrunCandidateUnits = computed<ConsoleUnit[]>(() =>
    moveUnits.value.filter(
      (unit) => !unit.movementEnded || zocStoppedMoveUnitIds.value.includes(unit.instanceId),
    ),
  )

  /**
   * 突袭发起格（4.5a-A：停车后仍在原地 ⇒ 取候选里第一枚的当前格）
   *
   * ★ 8.1g：已锁定参突者（`overrunParticipantIds`）时**以它们所在格为准**——
   *   参突者必须同格（8.1 的资格判据之一），而候选里第一枚未必是被锁定的那一枚
   *   （例：混编堆叠里步行单位走到了别处，停车的轮式单位才是要突袭的那一批）。
   *   不按参突者取格的话，"进 ZOC 后立即突袭"这一路会从错误的格子发起（第六批 BUG ①）。
   */
  const overrunStackHex = computed<HexRef | null>(() => {
    const pinned = overrunParticipantIds.value
    const pool =
      pinned.length > 0
        ? moveUnits.value.filter((unit) => pinned.includes(unit.instanceId))
        : overrunCandidateUnits.value
    const unit = pool[0]
    return unit === undefined ? null : { col: unit.hex.col, row: unit.hex.row }
  })

  /** C5：悬停格的单步预览（路径与消耗预览；不在范围内则为 null） */
  const stepPreview = computed<StepPreview | null>(() => {
    const interaction = moveInteraction.value ?? movePickPreviewInteraction.value
    const hover = hoverHex.value
    if (interaction === null || hover === null) return null
    const node = reachableNodeAt(groupReachable.value.hexes, hover)
    if (node === null) return null
    return previewStep({
      context: moveContext.value,
      interaction,
      runtime: moveRuntime.value,
      to: hover,
      path: node.path,
    })
  })

  /**
   * C5：悬停格对应的**可到达节点**（路径 + 累计 MP）
   *
   * 悬停远处格时「单步预览」会因不相邻而判 blocked，故界面要的是这个：
   * 路径与走过去的**累计消耗**（6.1a）；单步明细只在相邻时才有意义。
   */
  const hoverNode = computed(() => {
    const hover = hoverHex.value
    if (hover === null) return null
    return reachableNodeAt(groupReachable.value.hexes, hover)
  })
  /**
   * H2（用户 2026-11-16）：**悬停预览的一行文本**（只读）
   *
   * 与 `hoverNode` / `stepPreview` 同一套引擎结论：只回答"走到这一格要多少 MP"，
   * 不写 `hoverHex`、不记步、不改单位与选中集合。画布只拿到这段文本（不读 store）。
   */
  function hoverPreviewAt(hex: HexRef | null): string | null {
    if (hex === null) return null
    const interaction = moveInteraction.value ?? movePickPreviewInteraction.value
    if (interaction === null) return null
    const node = reachableNodeAt(groupReachable.value.hexes, hex)
    if (node === null) return null
    const preview = previewStep({
      context: moveContext.value,
      interaction,
      runtime: moveRuntime.value,
      to: hex,
      path: node.path,
    })
    const stepCost = preview.moving.reduce((sum, item) => sum + item.cost, 0)
    const parts = [`累计 ${node.mpSpent} MP`]
    if (preview.ok && stepCost > 0) parts.push(`本步 ${stepCost} MP`)
    if (preview.zocStoppingIds.length > 0) parts.push('进敌方 ZOC 后停车')
    if (preview.needsConfirm) parts.push('需确认')
    return `可走 · ${parts.join(' · ')}`
  }
  /**
   * P5（UI4/UI5）：**移动额度投影**（逐参移单位的可用 / 已耗 / 剩余，供移动面板显示）
   *
   * 额度判据来自引擎 `availableMaOf`（与 `moveMinRemainingMp` 同一处调用），
   * 本投影**不另立规则**、只做减法（6.1h：不取整）；界面据此查表，不自己算额度。
   */
  const moveBudgetRows = computed<
    {
      instanceId: string
      name: string
      availableMa: number
      spent: number
      remaining: number
      ended: boolean
    }[]
  >(() =>
    moveUnits.value.map((unit) => {
      const availableMa = availableMaOf(
        unit,
        movementPhaseOf(phase.value),
        sovietFirstTurnMaFactor(unit),
      )
      return {
        instanceId: unit.instanceId,
        name: unit.name,
        availableMa,
        spent: unit.mpSpent,
        remaining: availableMa - unit.mpSpent,
        ended: unit.movementEnded,
      }
    }),
  )
  /** P8：选中算子的本阶段可用 MA（6.1h 不取整；与 `moveBudgetRows` 同一换算，供界面只读） */
  const selectedAvailableMa = computed(() =>
    selectedUnit.value === null
      ? 0
      : availableMaOf(
          selectedUnit.value,
          movementPhaseOf(phase.value),
          sovietFirstTurnMaFactor(selectedUnit.value),
        ),
  )
  /** 当前方在选中算子处的合法性（B21 探针：不选单位时不判） */
  const selectedLegality = computed<LegalityVerdict | null>(() => {
    const unit = selectedUnit.value
    if (unit === null) return null
    return checkLegality(
      buildLegalityRequest({
        action: 'move',
        unit,
        context: moveContext.value,
        units: units.value,
        date: date.value,
        fuelPaid: unit.fuelled,
        phase: phase.value,
      }),
    )
  })

  /**
   * ⑧：把事实投给对局记录器
   *
   * 记录是**旁路**：未开启时 `note` 立即返回；任何异常都在这里吞掉，绝不影响对局。
   */
  function noteRecord(input: RecorderEventInput): void {
    core.noteRecord(input)
  }

  function pushLog(
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ): void {
    core.pushLog(kind, text, rule, derivation)
  }

  /**
   * E4：日志头（种子 + 算法 + 数据契约）
   *
   * `log` 是新条目在前的数组，故把日志头 push 到末尾（最旧的一端），一局只在开头有一条；
   * 已有头则跳过。复算方式：同一日志按该种子与算法重掷，即得同一骰序（B2）。
   */
  function recordLogHeader(): void {
    if (log.value.some((entry) => entry.text.startsWith('本局种子：'))) return
    const text = `本局种子：${seed.value}（RNG 算法 ${RNG_ALGORITHM}；数据契约 ${DATA_VERSION}；同一日志可按此复算）`
    log.value.push({ id: createId('log'), kind: 'info', text, rule: 'B2' })
    noteRecord({
      kind: 'log',
      level: 'info',
      text,
      rule: 'B2',
      turn: turn.value,
      phase: phase.value,
      side: activeSide.value,
      step: segmentStep.value?.id ?? null,
    })
  }

  /**
   * ⑭ 接线：把操作台的**一笔结算**写进会话日志（D2 的检索与重放随即覆盖它）
   *
   * 与会话日志条目同构：`turn / phase / side / action / rolls / outcome`。其中 `turn/phase`
   * 取操作台**自己的局面钟**——操作台是裁判台，它记的是「这手棋发生在哪一段」。
   *
   * `rolls`：**以骰源缓冲为准**（见 `pendingRolls`）——凡是「掷了骰」就必有记录，
   * 因为操作台里有几处是「先掷骰、再问引擎」，若引擎拒绝则那一步没有结算条目；
   * 缓冲会把这类骰子顺延记进下一笔结算，保证 D2 的重放不会因漏记而与实际序列错位。
   * 缓冲为空时才用调用方给的 `input.rolls`（两处内容等价，只是兜底不同）。
   *
   * **未开局**（没有会话）时静默跳过，操作台照常独立演练。
   *
   * @param input.action 审计标签（如 `move` / `combat` / `barrage` / `fuel` / `cleanUp`）
   * @param input.data   结算数据（进 `outcome.data`；放复核过程时用 `[DERIVATION_KEY]`）
   * @returns 是否真的入账（未开局 ⇒ false）
   */
  function recordSettlement(input: SettlementRecordInput): boolean {
    return core.recordSettlement(input)
  }

  /** 该格的算子（按摆放顺序） */
  function unitsAt(hex: HexRef): ConsoleUnit[] {
    return units.value.filter((unit) => unit.hex.col === hex.col && unit.hex.row === hex.row)
  }

  /* ────────────────────────────── W7 C16：移动中的突袭（8.0 / 8.1） ────────────────────────────── */

  /**
   * 本次突袭的托管信息（结算完就地记账用）
   *
   * 突袭是「移动里夹一仗」：宣布时先记下参突者与突袭前的剩余 MP，
   * 等 C6 九步走完（推进步）再把这些换算成移动记账（8.1a 扣 3 MP、8.0 必须进格、8.1f 结束移动）。
   */
  const overrunContext = ref<{
    target: HexRef
    participantIds: string[]
    mpRemainingBefore: number
    runtimeBefore: MoveUnitRuntime[]
  } | null>(null)

  /**
   * 条 17（批 F·F2）：4.5a 标记——**突袭强行进入敌方 ZOC 的格**后，该格的单位
   * 「不得离开、须再突袭或停」（8.0 的进入是强制的，故 4.5a 的约束在其后就位）。
   *
   * 突袭记账把单位落进 `context.target` 且该格处于敌方 ZOC 时置位；移动交互收束时清掉。
   * R9 起它不只提示：同一事实经 `zocHeldFact` 注入 `MoveContext`，普通走法离开该格会被引擎拒。
   */
  const overrunZocHeldHex = ref<HexRef | null>(null)
  /**
   * 4.5a-A（R9）：处于「突袭进敌方 ZOC 后不得离开」状态的参突单位
   *
   * 与 `overrunZocHeldHex` 同步置/清；作为**事实**注入 `MoveContext.zocHeld`（引擎不读 store），
   * 由 `evaluateStepFrom` 拦掉离开该格的普通走法（再突袭仍放行）。
   */
  const overrunZocHeldUnitIds = ref<string[]>([])

  /** 4.5a-A（R9）：传给移动引擎的「进 ZOC 后不得离开」事实（缺省不注入 ⇒ 不约束） */
  const zocHeldFact = computed(() => {
    const hex = overrunZocHeldHex.value
    if (hex === null || overrunZocHeldUnitIds.value.length === 0) return undefined
    return { hex, unitIds: [...overrunZocHeldUnitIds.value] }
  })

  /** 4.5a：当前移动交互里是否有一格"须再突袭或停"的 ZOC 约束（UI 提示用） */
  const overrunZocHeld = computed(() =>
    overrunZocHeldHex.value === null ? null : { ...overrunZocHeldHex.value },
  )

  /**
   * 8.1g：本次突袭的**参突单位**（空数组 ＝ 仍在移动的全部单位）
   *
   * 「一个堆叠进行突袭时，堆叠中的**部分单位**可以留在原地（8.1h：它们仍计入 4.8a，
   *  但不参突、也不受结果影响）」——故这是一份显式选择，而不是「整堆叠一律参突」。
   */
  const overrunParticipantIds = ref<string[]>([])

  /** 8.1g：勾选/取消一个参突单位 */
  function toggleOverrunParticipant(instanceId: string): void {
    overrunParticipantIds.value = overrunParticipantIds.value.includes(instanceId)
      ? overrunParticipantIds.value.filter((id) => id !== instanceId)
      : [...overrunParticipantIds.value, instanceId]
  }

  /**
   * 8.1b：本次突袭里**没跟上的单位**那一行提示（没有落下者 ⇒ null）
   *
   * 进格费不够的单位被留在原格、本次移动结束。玩家必须看到结果，但不另开清单面板——
   * 就在移动/突袭面板里用一行说清「哪几枚、留在哪、本次移动结束」（用户 2026-11-14 口径）。
   */
  const overrunLeftBehindNotice = ref<string | null>(null)

  /** 8.1g：本格的参突/留驻拆分（引擎 `splitOverrunStack` 的唯一消费点；供界面显示） */
  const overrunSplitNow = computed(() => {
    const hex = overrunStackHex.value
    if (hex === null) return null
    // 4.5a-A：同上 —— 停车者仍可作为参突者被勾选
    const movingIds = overrunCandidateUnits.value.map((unit) => unit.instanceId)
    const chosen =
      overrunParticipantIds.value.length > 0
        ? overrunParticipantIds.value.filter((id) => movingIds.includes(id))
        : movingIds
    return splitOverrunStack({
      side: actingSide.value,
      friendlyUnits: unitsAt(hex).map((unit) => ({
        id: unit.instanceId,
        re: unit.re,
        isCombat: unit.isCombat,
      })),
      participantIds: chosen,
    })
  })

  /** 本次移动中活跃单位的**当前格**（整堆叠移动 ⇒ 取第一枚活跃单位的位置） */
  const moveStackHex = computed<HexRef | null>(() => {
    const unit = overrunCandidateUnits.value[0] ?? activeMoveUnits.value[0]
    return unit === undefined ? null : { col: unit.hex.col, row: unit.hex.row }
  })

  /**
   * **突袭候选**里**最紧**的剩余 MP（8.1a：参突者都要 ≥3 MP，故取最小值当门槛）
   *
   * ★ 4.5a-A（第六批条 14）：因进 ZOC 停车的单位（`movementEnded` 为真、但在
   *   `zocStoppedMoveUnitIds` 账本里）**仍要计入**——它们正是"停车后改突袭"的那一批。
   */
  const moveMinRemainingMp = computed<number>(() => {
    const interaction = moveInteraction.value
    if (interaction === null) return 0
    let min = Number.POSITIVE_INFINITY
    for (const id of interaction.unitIds) {
      const unit = units.value.find((item) => item.instanceId === id)
      if (unit === undefined) continue
      if (unit.movementEnded && !zocStoppedMoveUnitIds.value.includes(id)) continue
      const ma = availableMaOf(unit, movementPhaseOf(phase.value), sovietFirstTurnMaFactor(unit))
      min = Math.min(min, ma - unit.mpSpent)
    }
    return Number.isFinite(min) ? min : 0
  })

  /**
   * 8.1：这些单位**在本环节开始时**是否同格堆叠在一起
   *
   * 判据＝「环节起始格快照（`phaseStartHex`）与当前堆叠求交」：全部参突者的起始格必须是
   * 同一格。本环节内才移动过来汇合的单位起始格不同 ⇒ 整组突袭不合 8.1（修前恒传 `true`，
   * 等于「此刻同格就能突袭」）。
   *
   * 单枚单位恒成立（自己与自己同格）；快照缺失（旧档/旧读档）按「不追溯」读成当前格。
   */
  function startedStackedTogether(ids: readonly string[]): boolean {
    if (ids.length <= 1) return true
    let start: HexRef | null = null
    for (const id of ids) {
      const unit = units.value.find((item) => item.instanceId === id)
      const hex = unit?.phaseStartHex ?? null
      if (hex === null) {
        const here = unit?.hex ?? null
        if (here === null) return false
        if (start === null) start = here
        else if (start.col !== here.col || start.row !== here.row) return false
        continue
      }
      if (start === null) start = hex
      else if (start.col !== hex.col || start.row !== hex.row) return false
    }
    return true
  }

  /**
   * 8.1 / 8.1a / 8.1h：从**进格后同格**的候选里取本格真正合格的参突者
   *
   * 4.5a-A 只规定「轮式单位进敌方 ZOC 后必须停或突袭」——**被强制停车的只有轮式**，
   * 同行的其它单位仍会进格并可参突（8.1g），故候选不能取 `zocStoppingIds`（那只是停车者）。
   *
   * 逐单位过 `overrunEligibility`（资格一律引擎给）：不合格者（DG 5.10b / 不可攻击 / MP < 3 8.1a）
   * **不参突、也不阻塞其余单位**（8.1h 允许其留驻，仍计 4.8a）；再把合格集合整体过一次
   * （起突格堆叠上限 4.8a、进格费 8.1b 等按整堆叠口径）。
   *
   * @returns null ＝ 这一格整体不可突袭（没有合格参突者或整组资格被拒）
   */
  function pickOverrunParticipants(input: {
    context: MoveContext
    /** 进格后会在同一格的全部候选（含被 ZOC 停车者与继续移动者） */
    candidates: readonly ConsoleUnit[]
    target: HexRef
    defenders: readonly { id: string; isCombat: boolean }[]
    /** 该候选在本步之后剩余的 MP（8.1a 需要逐单位 ≥3） */
    mpRemainingOf: (unit: ConsoleUnit) => number
  }): {
    participantIds: string[]
    mpRemaining: number
    mpCost: number
    entryCost: number
    /** 8.1b：进格费不够而不参突、留原格的候选（用户 2026-11-13 裁定） */
    entryExcludedIds: string[]
  } | null {
    // 判据与常规侧共用 `attackForceForHex`（P2/M3）；突袭的逐人过滤保留在引擎里
    const force = attackForceForHex({
      attackType: 'overrun',
      side: actingSide.value,
      hex: input.target,
      candidates: input.candidates,
      overrun: {
        context: input.context,
        phase: movementPhaseOf(phase.value),
        defenders: input.defenders,
        startedStackedTogether,
        mpRemainingOf: input.mpRemainingOf,
      },
    })
    if (force === null || force.attackType !== 'overrun') return null
    return {
      participantIds: force.unitIds,
      mpRemaining: force.mpRemaining,
      mpCost: force.mpCost,
      entryCost: force.entryCost,
      entryExcludedIds: force.entryExcludedIds,
    }
  }

  /**
   * 可突袭目标（8.0 / 8.1）——移动中随位置实时重算
   *
   * 候选＝**当前格的相邻敌方格**（8.1d：每次针对一个相邻敌方格）。资格一律交给
   * `engine/rules/overrun.ts#overrunEligibility`（本层不重算规则），界面据此画紫环，
   * 玩家点它即发起突袭。
   *
   * R12（K2）：修前还把「悬停/预览终点相邻的敌方格」作为虚线环塞进集合，注释称点它会
   * “先沿路径走过去再突袭”，但 `overrunNow` 从不执行走路，且指针移到该环上时预览终点
   * 改变、环随即消失，点击落到普通移动分支报 6.3b。该入口不可实现（8.1b 的进格费与
   * 8.1 的起突位置都以“此刻相邻”为前提），故只保留相邻环。
   */
  const overrunTargets = computed<WorkbenchOverrunTarget[]>(() => {
    const interaction = moveInteraction.value
    const from = overrunStackHex.value
    if (interaction === null || from === null) return []
    // 用户 2026-11-13：战斗会话进行中不铺紫环（含突袭自己这一场）；收束（finished）即恢复
    if (combatState.value !== null && combatState.value.finished !== true) return []
    if (overrunCandidateUnits.value.length === 0) return []

    const anchors = neighbors(from).map((item) => item.hex)

    const found: WorkbenchOverrunTarget[] = []
    for (const anchor of anchors) {
      const defenders = unitsAt(anchor).filter(
        (unit) => unit.side !== actingSide.value && unit.isCombat,
      )
      if (defenders.length === 0) continue
      // 8.1h：不合格单位（DG / MP 不足 / 不可攻击）不阻塞其余单位 ⇒ 按人取合格子集
      const picked = pickOverrunParticipants({
        context: moveContext.value,
        candidates: overrunCandidateUnits.value,
        target: anchor,
        defenders: defenders.map((unit) => ({ id: unit.instanceId, isCombat: unit.isCombat })),
        mpRemainingOf: (unit) =>
          availableMaOf(unit, movementPhaseOf(phase.value), sovietFirstTurnMaFactor(unit)) -
          unit.mpSpent,
      })
      if (picked === null) continue
      found.push({ hex: anchor, mpCost: picked.mpCost, adjacentToPath: true })
    }
    return found
  })

  /** 该格是否在本次移动的可突袭目标里（界面点选判定用） */
  const overrunTargetHexes = computed<HexRef[]>(() => overrunTargets.value.map((hint) => hint.hex))

  /**
   * 战斗环节「可攻击位置」高亮（9.0/9.1；随选人实时算）
   *
   * 触发：战斗环节（闸门允许 `combat.declare`）或「打一仗」工具激活，且尚未选定防御格。
   * 含义：把「当前攻方选择集能合法攻击的敌方战斗单位所在格」实时算出来画到地图上，
   * 玩家点它即 `selectCombatDefenderHex` 选定防御格并直接进入 9.2 结算。
   *
   * 多堆叠口径（用户 2026-11-18）：一次选中多个堆叠时取**堆叠间交集** ——
   * 每一堆叠都至少有一枚能打到的目标格才高亮；某堆叠打不到就整体不高亮。
   *
   * 每枚候选防御格的合法性一律交给引擎 `checkLegality`（`action:'attack'`），本层不重算规则。
   * 只在战斗环节/战斗工具态、且未选防御格时给（选定后高亮即撤，避免与战斗流程图层打架）。
   */
  const combatAttackableHexes = computed<HexRef[]>(() => {
    // 战斗环节由闸门驱动，不需要玩家先切工具（工具只在验证页显式使用）
    if (!combatPickActive.value && tool.value !== 'battle') return []
    if (battleTarget.value !== null) return []
    const side = activeSide.value
    const attackers =
      combatAttackerIds.value.length > 0
        ? combatAttackerIds.value
            .map((id) => units.value.find((unit) => unit.instanceId === id))
            .filter((unit): unit is ConsoleUnit => unit !== undefined)
        : // 11.0a：未点选时的"全集"也要先过本环节的参战判据（进击段只先进击/已释放预备）
          units.value.filter(
            (unit) =>
              unit.side === side &&
              unit.isCombat &&
              unit.steps > 0 &&
              combatAttackerVerdict(unit).ok,
          )
    if (attackers.length === 0) return []
    /** 按所在格分组：交集以**堆叠**为单位，不是以单枚为单位 */
    const stacks = new Map<string, ConsoleUnit[]>()
    for (const unit of attackers) {
      const key = `${unit.hex.col}.${unit.hex.row}`
      const group = stacks.get(key)
      if (group === undefined) stacks.set(key, [unit])
      else group.push(unit)
    }
    // 候选防御格＝所有敌方战斗单位所在格（去重）
    const enemyHexKey = new Map<string, HexRef>()
    for (const unit of units.value) {
      if (unit.side !== side && unit.isCombat && unit.steps > 0) {
        enemyHexKey.set(`${unit.hex.col}.${unit.hex.row}`, unit.hex)
      }
    }
    const result: HexRef[] = []
    for (const hex of enemyHexKey.values()) {
      // 9.1c：本环节已被攻击过的格不能再次攻击（与 `beginCombat` 的账本同一份事实）
      if (combatFacts.value.attackedThisSegmentAt(hex)) continue
      // P2（M3）：先用**同一份参战投影**取合格者（与 `attackersForHex` / 突袭共用判据），再问合法性层
      const canStackAttack = (group: ConsoleUnit[]): boolean => {
        const force = attackForceForHex({
          attackType: 'regular',
          side,
          hex,
          candidates: group,
        })
        if (force === null) return false
        const eligible = new Set(force.unitIds)
        return group.some((unit) => {
          if (!eligible.has(unit.instanceId)) return false
          if (!combatAttackerVerdict(unit).ok) return false
          /*
           * 9.1f / 8.1c：与结算共用 `combatFacts.canEnterForAttack` —— 高亮不再只看
           * 相邻与模式，移动规则禁止进入的格（含 6.1d 反向禁入）在这里同样被排除；
           * 只能沿路进入的格仍照常高亮（常规战斗允许，8.1c 只禁突袭）。
           */
          if (
            !combatFacts.value.canEnterForAttack(toBattleUnitView(unit, turn.value), unit.hex, hex)
          )
            return false
          const verdict = checkLegality(
            buildLegalityRequest({
              action: 'attack',
              unit,
              context: moveContext.value,
              units: units.value,
              date: date.value,
              target: hex,
              phase: phase.value,
            }),
          )
          return verdict.ok
        })
      }
      // 交集：每一个已选堆叠都要能打到该格
      if ([...stacks.values()].every(canStackAttack)) result.push(hex)
    }
    return result
  })

  /**
   * 发起突袭（8.0 / 8.1a）
   *
   * 流程：资格判定（引擎）→ 记下突袭前状态 → 以 `attackType:'overrun'` 走 9.2 九步流程
   * （与常规战斗同一条路，只是奇袭表用 9.8 的 overrun 行、且 9.13b-B 不给进击标记）；
   * 结算到推进步时再由 `settleOverrunMove` 把 3 MP 与进格记回移动交互。
   *
   * ★ **8.1g / 8.1h 的堆叠拆分**：参突单位由 `overrunParticipantIds` 指定（缺省＝仍在移动的全部
   *   单位，此时行为与修前一致）；未被指定的单位**留在原格**（8.1h：仍计入 4.8a，但不参突、
   *   也不受突袭结果影响）。拆分口径的唯一实现是引擎的 `splitOverrunStack`。
   */
  function overrunNow(hex: HexRef): boolean {
    if (!canReplaceCombat() || !canReplaceBarrage()) return false
    if (!requireAction('move.overrun', '突袭')) return false
    const interaction = moveInteraction.value
    // 4.5a-A：发起格取突袭候选（含"进 ZOC 停车但仍可突袭"者），不是 `activeMoveUnits`
    const from = overrunStackHex.value
    if (interaction === null || from === null) {
      pushLog('warning', '先选中己方单位/堆叠并开始移动，再点相邻敌方格发起突袭（8.0）', '8.0')
      return false
    }
    // 9.2 未收束时不得再开一场：否则前一场会被静默顶掉（其结果与记账都丢）
    if (combatState.value !== null && !combatState.value.finished) {
      pushLog(
        'warning',
        `本场战斗（${hexLabel(battleTarget.value?.hex ?? from)}）尚未结算完 9.2 流程：` +
          `请先走完推进步，或点「放弃本场战斗 / 突袭」`,
        '9.2',
      )
      return false
    }
    // 8.0/8.1d：突袭目标必须与当前格相邻（R12 起不再有“虚线环自动走过去”的第二入口）
    if (!areAdjacent(from, hex)) {
      pushLog(
        'warning',
        `${hexLabel(hex)} 与当前格不相邻：先走到它旁边的格，再点它发起突袭（8.0）`,
        '8.0',
      )
      return false
    }

    /*
     * 8.1g / 8.1h：参突单位是**仍在移动（含因进 ZOC 停车）的单位中合格的一批**。
     *   未显式勾选时＝全部合格者；不合格者（DG 5.10b / MP<3 8.1a / 不可攻击）不参突，
     *   也不得阻塞其余单位（8.1h 允许其留驻、仍计 4.8a）。
     * 拆分（谁参突 / 谁留驻 / 原格战斗 RE）的唯一实现是引擎的 `splitOverrunStack`。
     */
    const candidates = overrunCandidateUnits.value
    const movingIds = candidates.map((unit) => unit.instanceId)
    const defenders = unitsAt(hex).filter((unit) => unit.side !== actingSide.value && unit.isCombat)
    const mpRemainingOf = (unit: ConsoleUnit) =>
      availableMaOf(unit, movementPhaseOf(phase.value), sovietFirstTurnMaFactor(unit)) -
      unit.mpSpent
    const picked = pickOverrunParticipants({
      context: moveContext.value,
      candidates,
      target: hex,
      defenders: defenders.map((unit) => ({ id: unit.instanceId, isCombat: unit.isCombat })),
      mpRemainingOf,
    })
    const chosen =
      overrunParticipantIds.value.length > 0
        ? overrunParticipantIds.value.filter((id) => movingIds.includes(id))
        : (picked?.participantIds ?? [])
    const split = splitOverrunStack({
      side: actingSide.value,
      friendlyUnits: unitsAt(from).map((unit) => ({
        id: unit.instanceId,
        re: unit.re,
        isCombat: unit.isCombat,
      })),
      participantIds: chosen,
    })
    const participants = [...split.participantIds]
    if (participants.length === 0) {
      // 8.1：把「本环节内才汇合」的拒绝理由说清楚（否则一律报 6.1g，玩家看不出病根）
      if (!startedStackedTogether(movingIds)) {
        combatError.value = { rule: '8.1', reason: 'notStackedAtPhaseStart' }
        pushLog(
          'warning',
          '不能突袭：参突单位须在本环节开始时就同格堆叠（本环节内才汇合的单位不合 8.1）',
          '8.1',
        )
        return false
      }
      pushLog('warning', '没有仍在移动中的单位可以突袭（6.1g）', '6.1g')
      return false
    }
    // 8.1a：取参突者里最紧的剩余 MP（不合格者已被排除，不再拖累整组）
    const participantsMp = Math.min(
      ...participants.map((id) => {
        const unit = units.value.find((item) => item.instanceId === id)
        return unit === undefined ? 0 : mpRemainingOf(unit)
      }),
    )
    const eligibility = overrunEligibility({
      phase: movementPhaseOf(phase.value),
      context: moveContext.value,
      unitIds: participants,
      target: hex,
      mpRemaining: participantsMp,
      startedStackedTogether: startedStackedTogether(participants),
      defenders: defenders.map((unit) => ({ id: unit.instanceId, isCombat: unit.isCombat })),
    })
    if (!eligibility.ok) {
      combatError.value = { rule: eligibility.rule, reason: eligibility.reason }
      pushLog(
        'warning',
        `不能突袭 ${hexLabel(hex)}：${eligibility.reason}（${eligibility.rule}）`,
        eligibility.rule,
      )
      return false
    }

    /*
     * 8.1b（用户 2026-11-13 裁定）：进格费不够的单位被**落下**——留原格、本次移动结束。
     * 不写成走格步：撤销上一步时由该步 `before` 快照把 `ended` 恢复成 false，
     * 玩家撤回后仍可单独移动它（0 步就突袭则无步可撤，按裁定保持已结束）。
     * `moveRuntime` 是由单位派生的 computed，改 `movementEnded` 即同步。
     */
    const leftBehind = (picked?.entryExcludedIds ?? []).filter((id) => movingIds.includes(id))
    if (leftBehind.length > 0) {
      for (const unit of units.value)
        if (leftBehind.includes(unit.instanceId)) unit.movementEnded = true
      const names = leftBehind.map((id) => nameOf(id)).join('、')
      overrunLeftBehindNotice.value =
        `8.1b：${names} 没跟上——留在 ${hexLabel(from)}，本次移动结束` +
        '（要单独移动，请先撤回到移动前）'
      pushLog(
        'info',
        `8.1b：${leftBehind.length} 个单位进格费超过 3 MP，留在 ${hexLabel(from)} 且本次移动结束` +
          '（要单独移动，请先撤回到移动前）',
        '8.1b',
      )
    } else {
      overrunLeftBehindNotice.value = null
    }

    // 记下突袭前状态（结算后据此记账；撤销一步也能整步还原）
    overrunContext.value = {
      target: { ...hex },
      participantIds: [...participants],
      mpRemainingBefore: participantsMp,
      runtimeBefore: moveRuntime.value
        .filter((unit) => participants.includes(unit.unitId))
        .map((unit) => ({ ...unit, hex: { ...unit.hex } })),
    }
    battleTarget.value = {
      hex,
      defenderIds: defenders.map((unit) => unit.instanceId),
    }
    combatAttackerIds.value = [...participants]
    /*
     * ②b-2（用户实测复现：连续两次突袭 ⇒ 第二次窗口列的是第一次的进攻单位）：
     * `combatAttackers` 在 `combatState !== null` 时读 composition；上一场已 finished 仍非 null，
     * 于是本场 beginCombat 拿到的是**上一场的 attackerIds**。这里两点一起收：
     *   ① 本场攻方直接用 `participants`（8.1g 的当前选择），不经过投影；
     *   ② 丢掉上一场的 finished 战斗态（普通战斗在 setBattleTarget 里也这么做）。
     */
    combatState.value = null
    const participantUnits = units.value.filter((unit) => participants.includes(unit.instanceId))
    battleMode.value = 'full'
    const composed = acceptCombat(
      beginCombat({
        attackers: participantUnits.map((unit) => toBattleUnitView(unit, turn.value)),
        defenders: battleDefenders.value.map((unit) => toBattleUnitView(unit, turn.value)),
        facts: combatFacts.value,
        attackType: 'overrun',
        phase: phase.value,
      }),
      '突袭构成',
    )
    if (composed === null) {
      overrunContext.value = null
      clearOverrunSelectionAfterConclusion()
      return false
    }
    combatState.value = composed
    // 8.1b 落下者已在上面按「留原格 + 本次移动结束」记账，不再重复报成 8.1h「留驻」
    const stayIds = split.stayIds.filter((id) => !leftBehind.includes(id))
    beginGroundAttack({
      attackType: 'overrun',
      hex,
      text:
        `发起突袭（8.0）：${participants.length} 个参突单位 → ${hexLabel(hex)}` +
        `（守方 ${defenders.length} 个）；每次 3 MP（8.1a），请按 9.2 九步结算`,
      // 8.1h：留驻单位仍计入原格 4.8a 的战斗 RE，但不参突、也不受结果影响
      extraLogs:
        stayIds.length > 0
          ? [
              {
                text: `8.1g/h：留驻 ${stayIds.length} 个单位（原格战斗 RE ${split.originStackRe}）`,
                rule: '8.1h',
              },
            ]
          : [],
      // ⑭ 接线：突袭的宣布入会话日志（8.0；本笔不掷骰，骰子在 9.2 九步里逐笔记账）
      settlementData: {
        stage: 'declare',
        target: { ...hex },
        participantIds: [...participants],
        defenderIds: defenders.map((unit) => unit.instanceId),
        mpRemainingBefore: moveMinRemainingMp.value,
      },
    })
    return true
  }

  /** 突袭记账的**纯规划**（M4 事务化：只读，不写任何 store） */
  type OverrunSettlementDraft = {
    context: NonNullable<typeof overrunContext.value>
    plan: OverrunMovePlan
    attackerRetreated: boolean
    /** 推进步给出的「防御格已清空」事实（8.0 的进入判据） */
    defenderLeftHex: boolean
    liveParticipantIds: string[]
    /** 参突者全部离场 ⇒ 就地结束移动（`endMoveEarly` 的结果） */
    closed: { interaction: MoveInteractionState; patches: MoveUnitRuntime[] } | null
    /** 正常记账结果 */
    applied: { interaction: MoveInteractionState; patches: MoveUnitRuntime[] } | null
    /** 记账被引擎拒（8.1g/8.0 等） */
    rejected: { reason: string; rule: string } | null
    /** 要写回的移动交互新状态（closed / applied 二选一） */
    nextInteraction: MoveInteractionState | null
    /** 要写回的单位运行态补丁 */
    movePatches: MoveUnitRuntime[]
  }

  /**
   * 突袭结算的**补丁计算**（8.1a 3 MP / 8.0 必须进格 / 8.1f 结束移动 / 8.1g 只动参突者）
   *
   * `defenderLeftHex` 由推进步的结论给出（防御格已清空）；攻方是否在选项里撤退取
   * 本场战斗的选项结算结论（9.10c：攻方用选项撤退后不再进格）。
   *
   * ★ M4：本函数**不落盘**。`confirmCombatAdvance` 先把它与 9.12g 的战斗补丁一起算出、
   *   再一次性 apply，从而没有「战斗已推进、突袭 3 MP 却没记」的半截状态（K5 的结构性根因）。
   */
  function planOverrunSettlement(
    defenderLeftHex: boolean,
    /**
     * M4 事务化：本次推进同时会把哪些参突者打成 0 军力（取 `data.patches` 的 `steps<=0`）。
     * 修前这段记账发生在 `applyCombatPatches` 之后，运行态已不含阵亡者；现在补丁要一次算出，
     * 故由调用方把「即将离场」的 id 显式交进来，账目与修前一致。
     */
    eliminatedIds: ReadonlySet<string> = new Set(),
  ): OverrunSettlementDraft | null {
    const context = overrunContext.value
    if (context === null) return null
    const state = combatState.value
    /*
     * M5 / R1（U4 裁定＝A）：9.5b 允许在补给步**减少参战攻方**（`composition.attackerIds` 已按
     * 新名单重算）。突袭的 3 MP 与 8.0 的进格只作用于**真正参突**的单位 ⇒ 以结算时的编成为准，
     * 与 `composition` 取交集（编成只可能 ⊆ 宣布时的 `participantIds`）。
     * 被减掉的单位按用户口径「视同移动中放下」处理（见下方 staying 补丁）。
     */
    const compositionIds = state?.composition.attackerIds ?? context.participantIds
    const settledIds = context.participantIds.filter((id) => compositionIds.includes(id))
    // 剩余 MP 也按新名单重算（8.1a 的门槛/提示取参突者里最紧的一枚）
    const mpRemainingBefore = (() => {
      if (settledIds.length === context.participantIds.length) return context.mpRemainingBefore
      let min = Number.POSITIVE_INFINITY
      for (const id of settledIds) {
        const unit = units.value.find((item) => item.instanceId === id)
        if (unit === undefined) continue
        min = Math.min(
          min,
          availableMaOf(unit, movementPhaseOf(phase.value), sovietFirstTurnMaFactor(unit)) -
            unit.mpSpent,
        )
      }
      return Number.isFinite(min) ? min : context.mpRemainingBefore
    })()
    const attackerRetreated = (state?.resolution.attacker.option?.retreatHexes ?? 0) > 0
    const aftermath = resolveOverrunAftermath({
      mpRemainingBefore,
      attackerRetreatedInOptions: attackerRetreated,
      defenderLeftHex,
    })
    const plan = planOverrunMove({
      runtime: context.runtimeBefore,
      participantIds: settledIds,
      target: context.target,
      aftermath,
    })
    // 视同「阵亡者已移出盘面」——与修前 `applyCombatPatches` 之后再记账的运行态一致
    const runtime =
      eliminatedIds.size === 0
        ? moveRuntime.value
        : moveRuntime.value.filter((unit) => !eliminatedIds.has(unit.unitId))
    // 参突单位若已在战斗中阵亡/移出盘面 ⇒ 8.1a 的 3 MP 与 8.0 的进格都**没有对象可记**
    const liveParticipantIds = plan.participantIds.filter((id) =>
      runtime.some((unit) => unit.unitId === id),
    )
    const interaction = moveInteraction.value
    const base = { context, plan, attackerRetreated, defenderLeftHex, liveParticipantIds }
    if (liveParticipantIds.length === 0) {
      const closed = interaction === null ? null : endMoveEarly({ interaction, runtime })
      return {
        ...base,
        closed,
        applied: null,
        rejected: null,
        nextInteraction: closed?.interaction ?? null,
        movePatches: closed === null ? [] : [...closed.patches],
      }
    }
    if (interaction === null)
      return {
        ...base,
        closed: null,
        applied: null,
        rejected: null,
        nextInteraction: null,
        movePatches: [],
      }
    const result = applyOverrunMove({ interaction, runtime, plan })
    if (!result.ok)
      return {
        ...base,
        closed: null,
        applied: null,
        rejected: { reason: result.reason, rule: result.rule },
        nextInteraction: null,
        movePatches: [],
      }
    /*
     * 8.1g/h（U4＝A）：堆叠里**没有参与这次突袭**的单位视同 6.1f「移动中放下」——
     *   留在出发格、本次移动结束；不扣 3 MP、也不随突袭进格（8.1g：只有参突者能随堆叠移动）。
     */
    const stayingIds = new Set(
      runtime
        .filter(
          (unit) =>
            interaction.unitIds.includes(unit.unitId) &&
            !settledIds.includes(unit.unitId) &&
            !unit.ended,
        )
        .map((unit) => unit.unitId),
    )
    const mergedPatches = result.data.patches.map((patch) =>
      stayingIds.has(patch.unitId) ? { ...patch, ended: true } : patch,
    )
    const endedIds = new Set(
      mergedPatches.filter((patch) => patch.ended).map((patch) => patch.unitId),
    )
    const nextInteraction = interaction.unitIds.every((id) => endedIds.has(id))
      ? { ...result.data.interaction, finished: true }
      : result.data.interaction
    return {
      ...base,
      closed: null,
      applied: { interaction: nextInteraction, patches: [...mergedPatches] },
      rejected: null,
      nextInteraction,
      movePatches: [...mergedPatches],
    }
  }

  /**
   * 把突袭记账规划**落盘并收尾**
   *
   * @param patchesAlreadyApplied 事务化路径（`confirmCombatAdvance`）已在同一次 apply 里
   *   写过 `movePatches` 与 `nextInteraction`，此处只做收尾与日志，避免二次落盘。
   */
  function settleOverrunPlan(
    draft: OverrunSettlementDraft,
    patchesAlreadyApplied = false,
  ): boolean {
    const { context, plan, attackerRetreated, liveParticipantIds } = draft
    if (!patchesAlreadyApplied) {
      if (draft.nextInteraction !== null) moveInteraction.value = draft.nextInteraction
      if (draft.movePatches.length > 0) applyMovePatches(draft.movePatches)
    }
    /*
     * K5：突袭的撤销边界在**收束点**锚定（此时 9.5 补给与战损/撤退/推进已落盘）。
     * interaction 已含 `kind:'overrun'` 这一步（事务路在 `confirmCombatAdvance` 里先赋值，
     * 非事务路在上一段赋值）⇒ `rollbackFloor = steps.length`，撤销链在这一步之前截断；
     * 修前锚在补给提交时（步还没进 interaction），收束后会放行一次「只退位置/MP」的撤销。
     */
    groundMovement.markIrreversible('突袭战斗（8.0/9.2）')
    if (plan.missingParticipantIds.length > 0) {
      pushLog(
        'warning',
        `突袭记账：活跃单位里找不到参突者 ${plan.missingParticipantIds.join('、')} ⇒ 这些单位未记账`,
        '8.1g',
      )
    }
    if (liveParticipantIds.length === 0) {
      pushLog(
        'warning',
        `参突单位已不在盘面（阵亡或移除）⇒ 突袭无需记账；本次移动就地收束（8.1a）`,
        '8.1a',
      )
      overrunContext.value = null
      // ②b-2：与正常收束分支同一口径 —— 参突 pin / 攻方名单 / 跟随者一场即作废
      clearOverrunSelectionAfterConclusion()
      pushLog('info', plan.detail, plan.rule)
      // ⑭ 接线：参突者已不在盘面 ⇒ 8.1a 的 3 MP 与 8.0 的进格无对象可记（本笔无骰）
      recordSettlement({
        action: 'overrun',
        rule: plan.rule,
        data: {
          stage: 'settle',
          participantsGone: true,
          mayContinueMoving: plan.mayContinueMoving,
          defenderLeftHex: draft.defenderLeftHex,
          attackerRetreated,
          detail: plan.detail,
        },
      })
      return true
    }
    if (draft.applied !== null) {
      /*
       * 4.5a-A：突袭记账落盘后，这一枚**不再处于"进 ZOC 停车"状态**——
       *   它要么已进防御方格（8.0）、要么原地相持，总之这次"停车"已用掉。
       *   不摘掉的话，随后它因别的原因结束移动时仍会被当成可突袭者（账本失真）。
       *   若它真的进了新的敌方 ZOC，下一步 `planStep` 会重新记账。
       */
      zocStoppedMoveUnitIds.value = zocStoppedMoveUnitIds.value.filter(
        (id) => !plan.participantIds.includes(id),
      )
      /*
       * 条 17（批 F·F2）＋ R9：4.5a 标记。防御方离格 ⇒ 参突者强行进入防御方格（8.0 的进入是强制的）；
       * 若该格处于敌方 ZOC（"挺进 ZOC"），按 4.5a 此单位"不得离开、须再突袭或停"。
       *
       * 进入防御格＝已经离开了旧格 ⇒ 旧的「不得离开」事实作废；只有新格仍在敌方 ZOC
       * 才重新置位。未进入（相持 / 选项撤退）时保持旧事实不变（那个单位确实还在原格）。
       *
       * R11（K1b）：只有**真的进场**才重算。攻方在选项中撤退时（9.12g-B）防御方即便全灭也不进格，
       * 此时旧条件 `defenderLeftHex` 会把标记打到「没人进的格」，并藏掉面板按钮。
       * 判据以 `plan.enterDefenderHex`（＝8.0 强制进入）为准，再显式排除撤退分支。
       */
      if (draft.defenderLeftHex && plan.enterDefenderHex && !attackerRetreated) {
        /*
         * 4.5a-A：「**只有**以 Truck MP 移动的单位进入敌方 ZOC 后须停/再突袭；
         *   movement using Leg or Track MP is unaffected by ZOCs」⇒ 只把轮式参突者收进名单，
         *   履带/徒步即便一起进格也照常可走（混合堆叠逐单位判定）。
         */
        const heldIds = plan.participantIds.filter(
          (id) => units.value.find((unit) => unit.instanceId === id)?.raw.mobility === 'truck',
        )
        overrunZocHeldHex.value = null
        overrunZocHeldUnitIds.value = []
        if (
          heldIds.length > 0 &&
          inEnemyZocAt(moveContext.value, context.target, actingSide.value)
        ) {
          overrunZocHeldHex.value = { ...context.target }
          overrunZocHeldUnitIds.value = heldIds
          pushLog(
            'warning',
            `4.5a：轮式单位突袭进入 ${hexLabel(context.target)}（敌方 ZOC）⇒ 不得离开、须再突袭或停`,
            '4.5a',
          )
        }
      }
    } else if (draft.rejected !== null) {
      pushLog(
        'warning',
        `突袭记账被拒：${draft.rejected.reason}（${draft.rejected.rule}）`,
        draft.rejected.rule,
      )
    } else {
      // 移动交互已在别处清空 ⇒ 3 MP 与进格无处落盘。静默跳开会让人以为「结算过了」，
      // 故显式报出（8.1a 的 MP 未记、8.0 的进格未做），便于就地补记。
      pushLog(
        'warning',
        `突袭记账无法落盘：本次移动交互已结束（${plan.mayContinueMoving ? '仍可再动' : '本阶段移动结束'}）；` +
          `8.1a 的 ${OVERRUN_COST_MP} MP 与 8.0 的进格需按 ${plan.participantIds.length} 枚参突单位补记`,
        '8.1a',
      )
    }
    overrunContext.value = null
    /*
     * ②b（用户实测复现：A 突袭完 → B 堆叠突袭 → 参战的是 A、且改选不动）：
     * 参突 pin / 攻方名单 / 跟随者都是**本场战斗的临时选择**，突袭一收束即作废。
     * 不清的话 `overrunStackHex` 与 `chosen` 会沿用上一场的 id ⇒ 下一场从错误的格子发起。
     * （组成本身已锁在 `combatState` 里，清选择器不影响这场的结果与结算。）
     */
    clearOverrunSelectionAfterConclusion()
    pushLog('info', plan.detail, plan.rule)
    // ⑭ 接线：突袭记账（8.1a 的 3 MP / 8.0 的进格 / 8.1f 的收束）入会话日志（本笔无骰）
    recordSettlement({
      action: 'overrun',
      rule: plan.rule,
      data: {
        stage: 'settle',
        participantIds: [...plan.participantIds],
        missingParticipantIds: [...plan.missingParticipantIds],
        mayContinueMoving: plan.mayContinueMoving,
        defenderLeftHex: draft.defenderLeftHex,
        attackerRetreated,
        detail: plan.detail,
      },
    })
    // 8.1f：不撤退就继续移动（剩余不足 3 MP 只是不能再突袭，不结束移动）；只有选了撤退才结束
    if (!plan.mayContinueMoving && moveInteraction.value !== null) {
      pushLog('info', `突袭后剩余 MP 不足以再次突袭（8.1a）⇒ 仍可继续移动，只是不能再突袭`, '8.1a')
    }
    return true
  }

  /** 突袭结算后把移动记账落盘（8.1a 3 MP / 8.0 必须进格 / 8.1f 结束移动 / 8.1g 只动参突者） */
  function settleOverrunMove(defenderLeftHex: boolean): boolean {
    const draft = planOverrunSettlement(defenderLeftHex)
    return draft === null ? false : settleOverrunPlan(draft)
  }

  /**
   * ②b：突袭收束/放弃 ⇒ 作废本场战斗的**临时选择器**
   *
   * 只清选择器（参突 pin 8.1g / 攻方 9.1b / 跟随撤退 9.12d），不动已锁进 `combatState`
   * 的构成与结算结果。修前这三个 ref 会跨场存活，导致下一场突袭沿用上一场的 id。
   */
  function clearOverrunSelectionAfterConclusion(): void {
    overrunParticipantIds.value = []
    combatAttackerIds.value = []
    combatTagalongIds.value = []
  }

  /** 放弃本次突袭（关掉战斗流程即撤销「突袭前」的托管信息；MP 尚未记账，故无需回滚） */
  function cancelOverrunContext(): void {
    overrunContext.value = null
    clearOverrunSelectionAfterConclusion()
  }

  /** C5：该格中**当前方**的算子（按摆放顺序；可整堆叠移动作战） */
  function friendlyUnitsAt(hex: HexRef): ConsoleUnit[] {
    return unitsAt(hex).filter((unit) => unit.side === segmentGateQuery.value.side)
  }

  /** C5：清空本次移动交互（选子变化 / 换阶段 / 换方 / 重置时调用） */
  function clearMoveInteraction(): void {
    moveInteraction.value = null
    movePick.value = null
    moveBlocked.value = null
    lastStep.value = null
    // H7：撤回 / 中止后不再留"移动工具就绪"
    moveLinger.value = false
    // ②b：上一轮移动里的参突勾选不带到下一轮（否则新堆叠的突袭会沿用旧 id）
    overrunParticipantIds.value = []
    // 8.1b：本次移动已收束 ⇒ 上一场的「落下名单」提示不再挂
    overrunLeftBehindNotice.value = null
    // 4.5a-A：本次移动已收束 ⇒ 停车账本随之作废
    zocStoppedMoveUnitIds.value = []
    // 条 17（批 F·F2）：移动收束 ⇒ 4.5a 标记作废
    overrunZocHeldHex.value = null
    overrunZocHeldUnitIds.value = []
    // 条 22（批 T）：移动收束 ⇒ 20.0a 的「开始移动」时机窗口随之关闭
    closeBreakdownWindows('startMove')
  }

  /**
   * 清空所有单位的「本阶段已耗 MP」与「本轮已结束移动」标记
   *
   * 依据 6.1b：MA 是**一个阶段**可消耗的 MP 总额度 → 换方/换阶段/换回合时全体重置；
   * 4.5a-A / 6.1c / 6.2b 的「必须停止」也只在本轮移动内有效，故一并清除。
   * 4.5b：垫人的「本阶段不再消耗 MP」承诺同样止于本阶段结束。
   * 14.2e：飞机「每个阶段只能执行一次任务」同属阶段级事实，一并清零。
   */
  function resetMovementTracking(): void {
    // 13.2f：装卸撤销账只在当前阶段有效（换段/换方/换回合后不得跨段回退）
    transportHandlingUndo.value = []
    for (const unit of units.value) {
      unit.mpSpent = 0
      unit.airTransportThisPhase = null
      unit.movementEnded = false
      // 8.1：拍下**环节开始时**的位置，供突袭判「阶段开始即同格堆叠」
      unit.phaseStartHex = { col: unit.hex.col, row: unit.hex.row }
      // 5.7a：朝向锁只在本移动阶段内有效 ⇒ 换段/换方/换回合即解锁
      unit.reserveEnteredThisPhase = false
      unit.mpLockedThisPhase = false
      // 5.7b：`releasedFromReserve` 只表示「本阶段刚释放」，换段/换方/换回合即失效——
      // 释放本身已把预备标记永久摘掉，陈旧旗标会让该单位凭空获得反应/进击阶段的移动资格
      unit.mode = clearReleasedFromReserve(unit.mode)
      // 12.5c-C：单单位法的燃料「只在当前阶段有效」⇒ 换段/换方/换回合即失效；
      // 编队法 / HQ 法（12.5c-A/B）持续到**本方清理阶段**，不在此清（见 H 段 planCleanUp，12.5d）
      // 专规 4.2c：最省供油的标记按原文在**相位末**摘除 ⇒ 与单单位法同一处清
      if (unit.fuelled && unit.minimalFuel === true) {
        unit.fuelled = false
        unit.fuelMethod = null
        unit.minimalFuel = false
      } else if (
        unit.fuelled &&
        unit.fuelMethod !== null &&
        fuelExpiresOnPhaseChange(unit.fuelMethod)
      ) {
        unit.fuelled = false
        unit.fuelMethod = null
      }
    }
    for (const entry of deadPile.value)
      if (!isAirDeadPileEntry(entry)) entry.airTransportThisPhase = null
    for (const air of airUnits.value) air.missionsFlownThisPhase = 0
    moveInteraction.value = null
    /*
     * 缺陷 B（2026-11-14 实点）：换段/换方/换回合必须清**待开拔集**——
     * 段内点出来的选择集属于上一步的现场，带到下一段会让「移动准备」会话顶着
     * 上一段的单位重新弹出（反应段给轴方开出一张苏军移动面板）。
     */
    movePick.value = null
    moveBlocked.value = null
    lastStep.value = null
    hoverHex.value = null
    // 4.5a-A：停车账本只在本轮移动内有效（换段/换方/换回合 ⇒ 新的移动）
    zocStoppedMoveUnitIds.value = []
    // 13.2a：暂停账本同样只在本阶段内有效（换段/换方/换回合 ⇒ 运输点数重新按 MA 计）
    pausedTransportIds.value = []
    // 12.2a：接力账本只在本阶段内有效（且不进存档）
    spRelayLocks.value = []
  }

  /** 切方（2.3/2.2：先手方与后手方轮流；U0 直接手动切换） */
  function switchSide(): void {
    if (!airMissionDomain.canReplace()) return
    if (!canReplaceCombat() || !canReplaceBarrage()) return
    activeSide.value = activeSide.value === 'axis' ? 'soviet' : 'axis'
    selectedId.value = null
    pendingRecord.value = null
    battleTarget.value = null
    lastStep.value = null
    lastBattle.value = null
    resetMovementTracking()
    clearCombat()
    clearBarrage()
    clearSupply()
    clearAir()
    pendingHexPick.value = null
    // H1：换方＝上一步的现场结束，拒绝文案不跟到对方回合（与 G2 换选、换段同口径）
    moveBlocked.value = null
    // 15.1A / 15.4：整备与缩减都是「每基地每阶段一次」，换阶段即清零
    refitDoneBaseIds.value = []
    reducedBaseIds.value = []
    // 13.8d：一格一任务按**移动阶段**、按**单位**计，换阶段即清零
    constructionLedgers.value = {}
    constructionError.value = null
    // 15.1 整备交互的中间态一并收束（换方后不该还停在「选飞机」）
    refitTargetBaseId.value = null
    // 10.0e-A/B：换方＝进入对方的阶段序列 ⇒ 轰炸账本同样归零（与 `resetSegmentTransient` 同口径）
    clearBarragePhaseLedger()
    pushLog('info', `切方 → ${activeSide.value === 'axis' ? '轴心国' : '苏联'}`)
  }
  /**
   * W7 C13：把当前行动方设为**指定方**（脚本/测试与直接设方用）
   *
   * 与 `switchSide()`（翻转）区分：要落到**明确的一方**，连点两次不会转回原方。
   * 清理动作与 `switchSide` 完全一致（走同一个函数，避免两处漂移）。
   */
  function setActiveSide(side: Side): void {
    if (activeSide.value === side) return
    switchSide()
  }

  /** 阶段名（照 2.2 流程表） */
  const PHASE_LABELS: Record<ConsolePhase, string> = {
    preTurn: '回合准备',
    aircraftRefit: 'A 飞机整备',
    reinforcement: 'B 增援',
    movement: 'C 移动',
    supply: 'D 补给',
    reaction: 'E 反应',
    combat: 'F 战斗',
    exploitation: 'G 进击',
    cleanUp: 'H 清理',
  }

  /** 主动模式名（5.3） */
  const MODE_LABELS: Record<BaseMode, string> = {
    combat: '战斗模式',
    move: '移动模式',
    reserve: '预备模式',
    strat: '战略模式',
  }

  /** 加油方法名（12.5c） */
  const FUEL_METHOD_LABELS: Record<FuelMethod, string> = {
    formation: '编队法',
    hq: 'HQ 法',
    singleUnit: '单单位法',
  }

  /**
   * 换段 / 换方 / 换回合时清掉**盘面上的中间态**
   *
   * 依据：段内的半截动作不能带到下一段——一场打到一半的战斗、一次走到一半的移动、
   * 已选好的防御格，都属于"上一步的现场"。原先这套清理只写在 `setPhase()` 里（手动切段用），
   * B5 起「进入下一环节」也会换段，故抽出来两处共用，避免两条路径各清一半。
   */
  function resetSegmentTransient(): void {
    battleTarget.value = null
    lastStep.value = null
    resetMovementTracking()
    clearCombat()
    clearBarrage()
    clearSupply()
    clearAir()
    // 15.1A / 15.4：整备与缩减都是「每基地每阶段一次」，换阶段即清零
    refitDoneBaseIds.value = []
    reducedBaseIds.value = []
    // 14.9f / 15.0b-C：空运卸载限额是「**每个移动环节**每基地」⇒ 换环节即清零
    airUnloadLedger.value = {}
    // 13.8d：一格一任务按**移动阶段**、按**单位**计，换阶段即清零
    constructionLedgers.value = {}
    constructionError.value = null
    refitTargetBaseId.value = null
    // 9.1c：攻击账本按**战斗环节**计 ⇒ 换段 / 换方 / 换回合即清零（同段的换环节见 `stepToNextSegmentStep`）
    clearAttackPhaseLedger()
    /*
     * 10.0e-A/B：轰炸账本按**阶段**计（每格 / 每单位每阶段一次）⇒ 换段即清零。
     * ★ 修前（第六批条 23）本行只写在 `setPhase()` 里，而**正式推进换段走的是
     *   `advanceSegmentNow()` → `session.advanceToNextStop()` → 本函数**，那条路径根本不清
     *   ⇒ C 段空军炸过的格到 F 段仍在账本里，10.0e-A 把炮兵的合法轰炸一并拒掉。
     *   现在 `setPhase` / `setTurn` / 换段共用这一个清零点，两条路径口径一致。
     */
    clearBarragePhaseLedger()
    oosFedReByDump.value = {}
    dumpDestructionAttempts.value = {}
    gaugeConversionsThisPhase.value = []
    convertedHexesThisPhase.value = []
    railMovedNewTrackThisPhase.value = []
    railMovedUnitIdsThisPhase.value = []
    railArrived.value = null
    lastGroundEntryByUnit.value = {}
    // 4.8a：换段后上一次的勾选一律作废（盘面可能已变；未处理的义务仍会被台账重新列出）
    overstackPicks.value = {}
    /*
     * 11 号：换段/换方/换回合 ⇒ 退掉残留的「等玩家点一格」态。
     * 修前它只认 Esc，切段后仍挂着 ⇒ 之后每一次点图都被当成上一次的选格（错格还吞点击），
     * 正是"突袭后残留选格分派吃掉后续点击"那一类。取消入口统一，过渡也必须收口。
     */
    pendingHexPick.value = null
    // H1：拒绝文案只描述「当前这一步」——换段/换环节/换方/换回合一律清掉，不得跨段存活
    moveBlocked.value = null
  }

  function resetSupplyPhaseLedger(): void {
    supplyPhaseDomain.reset()
  }

  /**
   * **唯一「进入下一环节」**（B5；用户口径「点击自动进入下一环节，不需要额外的按钮」）
   *
   * 做三件事，顺序不能颠倒：
   *   ① 会话**连跑到下一个需要玩家的地方**（自动段一路结算完：天气 / 清理 / 换回合）；
   *   ② 若回合 / 阶段 / 行动方真的动了 ⇒ 清掉盘面中间态（上一步的现场不能带过来）；
   *   ③ 记一行日志（含"连跑了几步、停在哪"），让自动段的过程可追溯。
   *
   * 有**进行中的会话框**（战斗 / 轰炸）时拒绝：那次操作属于当前段，段没了它就没了；
   * 请先走完或按 Esc 放弃（规则号照 9.2 / 10.0 给，不自己编）。
   */
  function advanceSegmentNow(): SessionAdvanceOutcome | null {
    advanceBlocked.value = null
    if (session.terminated) return null
    // 初设未收束：与下面各挡下点同一口径（写原因 + 落日志），不再静默返回
    if (initialSetupInProgress.value) {
      advanceBlocked.value = {
        rule: '2.2',
        reason: '初设未收束：先在地图左上角「初设」栏完成布设 / 抽签，再进入下一环节',
      }
      pushLog('warning', `${advanceBlocked.value.reason}（2.2）`, '2.2')
      return null
    }
    /*
     * ★ 死操作①（用户 2026-11-08）：「进入下一环节」曾被补给检定等必须应答的场景挡下后
     *   **静默 return null** —— 按钮可点、点了无反应，像程序坏了。
     *   现在每个挡下点都写进 `advanceBlocked`（流程条就地显示原因）并落一行 warning 日志。
     *   判据仍来自既有闸门/义务链（`segmentAdvanceBlock()` 与 `supplyPhaseDomain.exitBlock`），
     *   这里不新写规则。
     */
    const gate = segmentAdvanceBlock()
    if (gate !== null) {
      advanceBlocked.value = gate
      pushLog('warning', `${gate.reason}（${gate.rule}）`, gate.rule)
      return null
    }
    /*
     * B8：先在**本段内**推进环节（用户口径：不想做这一环就点同一个按钮过去），
     * 环节全部走完才推进会话步（换段）。环节是**段内**的进度，故不消耗会话步（steps = 0），
     * 返回的 `stoppedBy: 'player'` 如实表示"仍停在需要玩家的环节上"。
     */
    if (!segmentLocked.value && !settleSegmentObligations()) {
      advanceBlocked.value = supplyPhaseDomain.exitBlock.value ?? {
        rule: '12.8b',
        reason: '补给阶段还有未完成的义务：请先在补给面板处理',
      }
      const blocked = advanceBlocked.value
      pushLog('warning', `${blocked.reason}（${blocked.rule}）`, blocked.rule)
      return null
    }
    if (!segmentLocked.value && stepToNextSegmentStep())
      return { steps: 0, stoppedBy: 'player', driver: 'player' }
    const before = `${turn.value}|${phase.value}|${activeSide.value}`
    const outcome = session.advanceToNextStop()
    const after = `${turn.value}|${phase.value}|${activeSide.value}`
    if (outcome.steps > 0 && after !== before) segmentStepIndex.value = 0
    if (outcome.steps > 0) {
      pushLog(
        'info',
        `进入下一环节：自动段连跑 ${outcome.steps} 步 → 停在${stopLabel(outcome)}`,
        '2.2',
      )
    } else if (outcome.stoppedBy === 'refused') {
      const error = session.error
      advanceBlocked.value =
        error === null
          ? { rule: '2.2', reason: '内核拒绝推进（未给出原因）' }
          : { rule: error.rule, reason: error.reason }
      pushLog(
        'warning',
        `未能进入下一环节：${advanceBlocked.value.reason}（${advanceBlocked.value.rule}）`,
        advanceBlocked.value.rule,
      )
    }
    return outcome
  }

  /**
   * 作答（2.3 先手判定：**作答即自动推进到 A 段**）
   *
   * 用户 2026-11-14 裁定：先手这条答完不再要求多点一次「进入下一环节」——
   * 作答成功就继续连跑到下一个停点（A 飞机整备）。其余问题保持原语义（答完停住，
   * 由玩家自己决定何时推进），故只在 `initiative` 上续跑。
   */
  function answerQuestionNow(optionId?: string): boolean {
    const kind = session.question?.kind
    if (!session.answerNow(optionId)) return false
    if (kind === 'initiative') advanceSegmentNow()
    return true
  }

  /** 连跑去向的中文说法（界面与日志共用一处，免得两处口径漂移） */
  function stopLabel(outcome: SessionAdvanceOutcome): string {
    if (outcome.stoppedBy === 'question') return `待答（${session.question?.rule ?? '2.3'}）`
    if (outcome.stoppedBy === 'terminated') return '本局终止（5.0a / 5.0b）'
    if (outcome.stoppedBy === 'refused') return `内核拒绝（${session.error?.reason ?? '未知'}）`
    if (outcome.stoppedBy === 'limit') return '连跑上限（异常，请报告）'
    const step = session.guidance
    return step === null ? '玩家环节' : `${step.step.label}（${step.step.rule}）`
  }

  /** 切阶段（2.2 SOP 段；换段即重置各单位的 MA 额度） */
  function setPhase(next: ConsolePhase): void {
    // preTurn等时点的界面阶段会回退到localPhase，须比较真实会话阶段而非回退投影。
    if ((session.records?.phase ?? localPhase.value) === next) return
    if (!airMissionDomain.canReplace()) return
    if (!canReplaceCombat() || !canReplaceBarrage()) return
    phase.value = next
    resetSegmentTransient()
    resetSupplyPhaseLedger()
    pushLog('info', `阶段 → ${PHASE_LABELS[next]}`)
    /*
     * 12.6：追溯补给的**唯一自动判定时点**＝进入补给阶段（判当前方一次并落标记）。
     * 进入移动阶段**不再**重判：抽象补给不因走位立刻断补（用户 2026-11-13 口径）；
     * 突围资格改由 `breakout*` 就地实时查询（12.8e 的「在此环节中检查」）。
     */
    if (next === 'supply') refreshTraceSupply('进入补给阶段')
    // 12.6c：批量费率的"本环节"以段为单位 ⇒ 换阶段即清空已喂 RE 账本
    oosFedReByDump.value = {}
    // 12.11a（第五批 B1）：销毁补给站的限额是「**每个阶段**每站一次」⇒ 换阶段即清空尝试账本
    // （修前从不清零 ⇒ 同一站被永久拒绝，"每阶段一次"实际成了"每局一次"）
    dumpDestructionAttempts.value = {}
    // 13.3g-D：换轨上限是「每**移动阶段** ≤ min(4, MA) 格」⇒ 换阶段即清零计数
    gaugeConversionsThisPhase.value = []
    // 13.3g-A：同上 —— 换阶段后，"本阶段刚换过轨的格"与"走过这些格的单位"都不再算数
    convertedHexesThisPhase.value = []
    railMovedNewTrackThisPhase.value = []
    railArrived.value = null
    // 4.7d：铁路运输的「同一阶段只用一种运输类型」按阶段记账 ⇒ 换阶段即清零
    railMovedUnitIdsThisPhase.value = []
    // 10.0e-A/B：轰炸账本按**阶段**计（每格/每单位每阶段一次）⇒ 换阶段即清零
    // （已并入上面的 `resetSegmentTransient()`，此处不再重复调，保持单一清零点）
    /*
     * ★ 12.5d（用户 2026-09-20 裁定）：**燃料窗口不随换阶段清零** ——
     *   编队标记 / 指挥部燃料标记都「持续到**下一个友方清理阶段**」，而"下一个友方清理阶段"可能
     *   落在**另一个阶段的半场**之后（例：敌方回合的己方反应阶段付的油，要活到己方回合的移动阶段，
     *   直到**己方**清理阶段才翻回）。故 `hqFuelThrows` / `formationFuelThrows` 都**不在本函数里清**，
     *   而是在 `runCleanUpNow`（本方清理、与 `fuelled` 标记同一处落盘）里按方清。
     */
  }

  /** 清空 10.0e-A/B 的轰炸账本（换段 / 换阶段 / 换回合 / 复位时调用；现由 `resetSegmentTransient` 统一清） */
  function clearBarragePhaseLedger(): void {
    barragedHexesThisPhase.value = []
    barragedUnitIdsThisPhase.value = []
  }

  /** 清空 9.1c 的攻击账本（换环节 / 换段 / 换方 / 换回合时调用） */
  function clearAttackPhaseLedger(): void {
    attackedUnitIdsThisPhase.value = []
    attackedHexesThisPhase.value = []
  }

  /**
   * 记一笔 9.1c（**战斗补给付过之后**调用；一场战斗只走到这里一次）
   *
   * 记的是**最终参战名单**（9.5b 允许在补给步减少参战单位 ⇒ 以那份减少后的名单为准）与**被攻击的格**。
   */
  function recordAttackThisSegment(attackerIds: readonly string[], defendingHex: HexRef): void {
    attackedUnitIdsThisPhase.value = [
      ...new Set([...attackedUnitIdsThisPhase.value, ...attackerIds]),
    ]
    attackedHexesThisPhase.value = [
      ...new Set([...attackedHexesThisPhase.value, `${defendingHex.col}.${defendingHex.row}`]),
    ]
  }

  /**
   * 设置回合号与对应日期
   *
   * ★ 日期取自工程数据 markers.json 的 turnTrack（**半周轨**：日号 `1-5-8-12-15-19-22-26-29`
   *   每月重复 ⇒ 1=07-08、2=07-12、7=07-29、8=**08-01**、17=**09-01**…），
   *   绝不能按固定天数推算——日期是专规闸门的唯一输入（专规 2.3e 战略模式、专规 1.2 铁路容量）。
   */
  function setTurn(next: number): void {
    if (!airMissionDomain.canReplace()) return
    if (!canReplaceCombat() || !canReplaceBarrage()) return
    const first = TURN_TRACK[0]?.turn ?? 1
    const last = TURN_TRACK[TURN_TRACK.length - 1]?.turn ?? first
    const clamped = Math.min(last, Math.max(first, Math.trunc(next)))
    turn.value = clamped
    lastStep.value = null
    resetMovementTracking()
    // 11 号：换回合同样退掉残留的待点格（与换段/换方同口径）
    pendingHexPick.value = null
    // H1：换回合同样清掉上一条拒绝（不得跨回合存活）
    moveBlocked.value = null
    /*
     * 16.0b/c：工事修建/缩减的额度是「**每格每回合**」⇒ 换回合即清零。
     * ★ 本账本按**格**键（`hedgehogTurnLedger`），故必须在这里显式清，否则"本回合已提升"会跨回合一直拦。
     */
    hedgehogTurnLedger.value = {}
    // 15.3：空军基地的「每回合 +1 级」同样是按格按回合的额度
    airBaseTurnLedger.value = {}
    // 13.8d：一格一任务按移动阶段计 ⇒ 新回合＝新的移动环节
    constructionLedgers.value = {}
    constructionError.value = null
    // 10.0e-A/B：轰炸账本按阶段计 ⇒ 新回合也是新的阶段序列（与 13.8d 同口径）
    clearBarragePhaseLedger()
    // 9.1c：攻击账本按环节计 ⇒ 新回合必然是新的战斗环节（与上面同口径）
    clearAttackPhaseLedger()
    /*
     * ★ 12.5d（用户 2026-09-20 裁定）：燃料窗口**也不随换回合清零** ——
     *   标记持续到"下一个**友方**清理阶段"，而付款可以发生在**敌方半场**的己方反应阶段
     *   （例：后手方在第一半场的反应阶段投递 ⇒ 己方清理阶段在下一次己方半场）
     *   ⇒ 该窗口会正常跨过回合边界，清零只发生在那次清理（见 `runCleanUpNow`）。
     */
    // 13.3b：铁路容量是「**每回合**每方若干点」（1.2）⇒ 换回合即清零
    railCapSpentThisTurn.value = []
    // 专规 2.1/3.1：到货 SP 的落点按**回合**清（每回合的补给表到货各落各的）
    freeRailPicked.value = []
    supplyArrivalSp.value = 0
    supplyTrainHex.value = null
    clearArrivalSpGroups()
    // ⑬ 接线：回合变了，5.0b 的时点（19 Aug 起）与 5.0a 的末回合判定都随之变，重推结论
    pushVictoryToSessionNow()
    pushLog('info', `回合 ${clamped}（${date.value}）`)
  }

  /** 选一个单位库记录进入摆放模式（自动切到摆子工具） */
  function pickRecord(record: UnitRecordView): void {
    pendingRecord.value = record
    tool.value = 'place'
    pushLog('info', `待摆放：${record.nameZh ?? record.id}（点地图空格放置）`)
  }

  /** 切工具模式 */
  function setTool(next: 'move' | 'place' | 'battle'): void {
    tool.value = next
    pushLog('info', `工具 → ${{ move: '选格/走一步', place: '摆算子', battle: '打一仗' }[next]}`)
  }

  /** 在指定格摆放待摆放的单位 */
  function placeAt(hex: HexRef): boolean {
    const record = pendingRecord.value
    if (record === null) return false
    // 中立算子（side='both'）由玩家指定按当前方上场
    const side: Side = record.side === 'both' ? activeSide.value : (record.side ?? activeSide.value)
    const unit = toConsoleUnit({ record, instanceId: createId('u'), hex, side })
    // 摆放方以单位库的 side 为准；若与当前方不一致，提示但不拦（便于快速对比双方）
    units.value.push(unit)
    selectedId.value = unit.instanceId
    pendingRecord.value = null
    battleTarget.value = null
    pushLog(
      'success',
      `摆放 ${unit.name} @ ${hex.col}.${hex.row}（A${unit.raw.attack} AR${unit.raw.ar} MA${unit.raw.ma}，${effectiveMobilityOf(unit)}，${unit.re}RE）`,
    )
    // 12.3b / 12.7：初设/编辑器里摆上 HQ 或延补队会改变补给网；对局内回合不重判标记（12.8a）
    if (initialSetupInProgress.value && affectsSupplyNet(unit))
      refreshTraceSupply(`摆上 ${unit.name}`)
    return true
  }

  /** 移除某格最上面的算子 */
  function removeAt(hex: HexRef): boolean {
    const index = [...units.value]
      .reverse()
      .findIndex((unit) => unit.hex.col === hex.col && unit.hex.row === hex.row)
    if (index === -1) return false
    const realIndex = units.value.length - 1 - index
    const [removed] = units.value.splice(realIndex, 1)
    if (removed !== undefined && selectedId.value === removed.instanceId) selectedId.value = null
    battleTarget.value = null
    pushLog('info', `移除 ${removed?.name ?? '算子'} @ ${hex.col}.${hex.row}`)
    // 12.3b / 12.7：初设/编辑器里移除 HQ 或延补队 ⇒ 补给网变化；对局内不重判标记（12.8a）
    if (removed !== undefined && initialSetupInProgress.value && affectsSupplyNet(removed))
      refreshTraceSupply(`移除 ${removed.name}`)
    return true
  }

  /* ──────────────── C5 移动交互：实现在 workbench-move.ts（B3-1），此处只装配 ──────────────── */

  const movementDomain = createMovementDomain({
    NO_MOVEMENT_PHASES,
    session,
    groundMovement,
    airUnitTransit,
    selectedUnit,
    choices,
    moveUnits,
    PHASE_LABELS,
    // B-4 端口束试点（2026-11-21）：共享面各收成 1 项，切片内仍按原名解构，函数体零改动
    core: {
      pushLog,
      noteUndoable,
      requireAction,
      actionAllowedNow,
      refuseWhileLocked,
      moveUndoSealReasonNow,
      undoTransportHandlingNow,
      dropUndoOf,
      dropUndoFamilies,
      revertTransportHandlingSinceBaseline,
      sealTransportHandlingForCommit,
      clearMoveInteraction,
    },
    board: {
      activeSide,
      phase,
      segmentLocked,
      units,
      selectedId,
      lastStep,
      moveBlocked,
      moveInteraction,
      moveSessionSeq,
      transportHandlingBaseline,
      stackSelect,
      movePick,
      pausedTransportIds,
      transportHandlingUndo,
      combatState,
      barrageState,
      lastGroundEntryByUnit,
      activeMoveUnits,
      moveContext,
      moveRuntime,
      movePickPreviewInteraction,
      groupReachable,
      unitsAt,
      friendlyUnitsAt,
      movePickPoolAt,
      defaultMovePickIdsAt,
      moveLinger,
      hoverHex,
      overrunContext,
      combatDefendingHexCleared,
      date,
    },
    helpers: {
      noteUnitLeftOwnBridgeHex,
      unitOfInstance,
      noteUnitEnteredHex,
      nationalityOfUnit,
      reserveMarkerStatusOf,
      reservedHexes,
      hexKeyOf,
      hexTextOf,
      moveFailureNote,
      applyFormationFuelCoverageToIds,
      resolveSpecialCombatAt,
      hexLabel,
      allowReserveEntryAtHex,
      previewStep,
      planStep,
      reachableNodeAt,
      sameHex,
      areAdjacent,
      settleOverrunMove,
      snapshotOf,
      recordSettlement,
      hedgehogLevelOf,
      endMoveEarly,
      zocStoppedMoveUnitIds,
      MODE_LABELS,
      hedgehogHexState,
      noteEngineerCapabilityAfter,
    },
    // 晚绑定：声明在建域点之后，用访问器传，切片只在调用/求值时取值
    get breakdownPool() {
      return breakdownPool
    },
    get initialSetupInProgress() {
      return initialSetupInProgress
    },
    get gates() {
      return gates
    },
    get specialPending() {
      return specialPending
    },
    get confirmMovePick() {
      return confirmMovePick
    },
  })
  // B3-1：搬走后回补（区外仍引用；nameOf/unitNameOf*/applyMovePatches/refuseWhileSettling/
  // closeBreakdownWindows 走上面的薄转发或此处解构）
  const {
    unitNameOf,
    previewDraggedPath,
    moveAlongDraggedPath,
    tryMoveTo,
    settlementInProgress,
    beginMoveFor,
    setupBreakdownCandidates,
    openBreakdownWindow,
    canCreateBreakdownNow,
    breakdownRecordChoicesFor,
    breakdownAbsorbChoicesFor,
    canAbsorbBreakdownNow,
    retryBeginMove,
    selectForMove,
    setupWiggleParents,
    setupWiggleOn,
    setupWiggleRemaining,
    breakdownTimingOf,
  } = movementDomain
  /* B3-2b2：撤销 / 收束族（区外仍引用；`concludeMove` 只被族内调用，不进公开面） */
  const {
    undoLastStep,
    cancelWholeMove,
    abortMoveNow,
    finishMove,
    pauseTransportMove,
    dismissFinishedMoveNow,
    dismissMoveLinger,
    setHoverHex,
    dropUnitFromMove,
    sealEdgeBoxTransferNow,
  } = movementDomain
  /* B3-2b3：模式切换 / 初设模式判据（`SETUP_MODES_ALL` 只被族内用，不进 facade） */
  const {
    setStackSelect,
    switchUnitMode,
    switchableModesOf,
    setupSwitchableModesOf,
    setupModeBlockNote,
    noteSetupModeBlocked,
  } = movementDomain
  /* B3-2b4：初设设模式 / 预备换面（全部只在公开面被引用） */
  const {
    setUnitModeAtSetup,
    setupReserveSummary,
    releaseReserveNow,
    switchReserveFaceNow,
    canEditReserveModeOf,
    flipUnitOrientation,
    canReleaseReserveOf,
    cancelReserveModeNow,
  } = movementDomain

  /**
   * B3-2b1：`triggerSpecialCombatAfterStep` 在 1110 行就被当端口传给 `groundMovement`，
   * 早于本域解构 ⇒ facade 只能保留**函数声明**形式（提升）的一行薄转发。
   */
  function triggerSpecialCombatAfterStep(to: HexRef, movedIds: readonly string[]): void {
    movementDomain.triggerSpecialCombatAfterStep(to, movedIds)
  }

  /* ──────────── C5：堆叠取子（已搬进 `workbench-stack-pick.ts`） ──────────── */
  const stackPickDomain = createStackPickDomain({
    activeSide,
    phase,
    units,
    moveBlocked,
    movePick,
    pausedTransportIds,
    nameOf,
    pushLog,
    friendlyUnitsAt,
    beginMoveFor,
    applyFormationFuelCoverage,
    applyFormationFuelCoverageToIds,
    // 晚绑定：声明在 19100，用访问器传，切片只在求值时取值
    get initialSetupInProgress() {
      return initialSetupInProgress
    },
  })
  const {
    movePickHex,
    movePickChoices,
    toggleMovePick,
    setMovePickOnly,
    setMovePickAll,
    beginMovePick,
    setMovePickIds,
    cancelMovePick,
    confirmMovePick,
  } = stackPickDomain

  /* ──────────── 12.5 燃料域（B3-2b5：payFuel + 燃料来源/面板整块，已搬进 `workbench-fuel.ts`） ──────────── */
  const fuelDomain = createFuelDomain({
    core: { pushLog, recordSettlement, actionAllowedNow, requireAction, captureUndoSnapshot },
    board: {
      session,
      activeSide,
      units,
      movePick,
      selectedUnit,
      moveContext,
      actingSide,
      supplyFacts,
      moveUnits,
      drawableDumpsAt,
      drawableSpDumpsAt,
      fuelPool,
      allSpDumps,
    },
    helpers: {
      nameOf,
      FUEL_METHOD_LABELS,
      retryBeginMove,
      setSpDumpHoldings,
      deliverableDumpsFor,
      panzerGroupSpGate,
      panzerGroupSpRefusal,
    },
  })
  const {
    payFuel,
    fuelDumpId,
    hqFuelThrows,
    formationFuelThrows,
    hqFuelThrowOriginOf,
    formationFuelThrowOf,
    fuelTargets,
    fuelPendingUnits,
    fuelPaymentDue,
    supplyCheckCandidates,
    fuelMethod,
    fuelSubjectId,
    fuelMethodChoices,
    minimalFuelingOn,
    fuelMethodEffective,
    fuelMethodsForUnitNow,
    openFuelNow,
    closeFuelNow,
    fuelMethodLabel,
    fuelSourcePartition,
    fuelDumpChoices,
    fuelDump,
    fuelPayNeedT,
    fuelFormationCoverage,
    pickFuelDump,
    setFuelPool,
    setUnitFuelled,
  } = fuelDomain
  /*
   * B3-2b5：`applyFormationFuelCoverage*` 在 7600/7712 就被当端口传给 stack-pick / movement，
   * 早于本域解构 ⇒ facade 只能保留**函数声明**（提升）形式的一行薄转发。
   */
  function applyFormationFuelCoverage(unit: ConsoleUnit): void {
    fuelDomain.applyFormationFuelCoverage(unit)
  }
  function applyFormationFuelCoverageToIds(ids: readonly string[]): void {
    fuelDomain.applyFormationFuelCoverageToIds(ids)
  }

  /*
   * B3-2b7（2026-11-21）：9.10a 选项草稿账本整族搬进 `workbench-combat-options.ts`。
   * 族内 13 声明、9 个外部名全部声明在本处之前（1578 的 fireResolution 解构、2560–2607 的战斗视图、
   * 1099 起的 nameOf 等），故无 getter；见切片头注释的"解构位置"约束。
   */
  const combatOptionsDomain = createCombatOptionsDomain({
    combatState,
    combatInputs,
    combatAttackers,
    battleDefenders,
    combatAttackerViews,
    combatDefenderViews,
    nameOf,
    noteUndoable,
    dropUndoOf,
  })
  const {
    optionDraftPoints,
    optionDraftUsed,
    optionDraftRemaining,
    optionDraftEntries,
    optionRetreatUnits,
    canTakeOptionLossPoint,
    applyOptionDraftLoss,
    applyOptionDraftRetreat,
    applyOptionDraftRetreatFor,
    undoOptionDraftLast,
    resetOptionDraft,
  } = combatOptionsDomain

  /*
   * B3-2b9（2026-11-21）：C6 第 8 步（b）选项结算搬进 `workbench-combat-settle.ts`。
   * 依赖全部早于本处（1578 的 fireResolution 解构、984 units、2606/2609 视图、3049 撤退事实、
   * 7820 的草稿域派生），`roleLabel`/`acceptCombat`/`settlePassiveCombatSteps` 都是提升函数 ⇒ 无 getter。
   * 本域必须先于 `combatIgnoreDomain` 建，后者把 `confirmCombatOptions` 当端口收。
   */
  const combatSettleDomain = createCombatSettleDomain({
    combatState,
    combatInputs,
    combatError,
    units,
    combatAttackerViews,
    combatDefenderViews,
    combatRetreatFacts,
    optionDraftRemaining,
    resetOptionDraft,
    pushLog,
    recordSettlement,
    acceptCombat,
    applyCombatPatches,
    roleLabel,
    settlePassiveCombatSteps,
  })
  const { combatOptionLossTargets, confirmCombatOptions } = combatSettleDomain

  /*
   * B3-2b10（2026-11-21）：9.12 撤退与 9.12f 撤退穿越搬进 `workbench-combat-advance.ts`。
   * 依赖全部早于本处（882 turn 不在端口内、984 units、1595 的 fireResolution 解构、2922/2994/3049/3074/3088 的
   * 战斗派生、7641 openBreakdownWindow）；`specialPending`（14466 的 ref）是唯一 getter。
   * `retreatResolutionInput`（facade 10379）被 3258/3268 的 computed 早读 ⇒ 只能留在 facade，反向当端口传。
   */
  const combatAdvanceDomain = createCombatAdvanceDomain({
    combatState,
    combatInputs,
    units,
    combatRetreatFacts,
    combatTagalongIds,
    combatDefendingHexCleared,
    combatAttackerRetreated,
    combatAdvanceCandidates,
    openBreakdownWindow,
    scheduleRetreatCrossings: (crossings) => fireResolution.scheduleRetreatCrossings(crossings),
    retreatResolutionInput,
    nameOf,
    pushLog,
    recordSettlement,
    acceptCombat,
    applyCombatPatches,
    takeCombatLoss,
    confirmCombatAdvance,
    settleOverrunAdvanceIfRequired,
    specialPending: () => specialPending.value,
  })
  const { confirmCombatRetreats } = combatAdvanceDomain

  /*
   * B3-2b8（2026-11-21）：9.10c 忽略权三件搬进 `workbench-combat-ignore.ts`。
   * `combatNkvdForcedLosses`（16690 声明）是唯一晚于本处的依赖 ⇒ 唯一一个 getter。
   */
  const combatIgnoreDomain = createCombatIgnoreDomain({
    combatState,
    combatInputs,
    combatAttackerViews,
    combatNkvdForcedLosses: () => combatNkvdForcedLosses.value,
    confirmCombatOptions,
  })
  const { attackerWipedNow, optionIgnoreAvailableNow, confirmCombatIgnoreOptions } =
    combatIgnoreDomain

  /* ────────── B47（12.8e）：突围尝试 ────────── */

  /** 12.8e：本次突围的骰值（留空即自动掷；供裁判订正 / 复算） */
  const breakoutInputs = ref<{ die: number | null; returnDie: number | null }>({
    die: null,
    returnDie: null,
  })

  /**
   * 12.8e：**成功突围后离图、等待返场**的单位
   *
   * 「成功的单位**离图**，并在未来的某个回合**作为增援返回**」（保留军力损失标记、清除其他标记）。
   * 它们**不进死亡堆**（那不是"被消灭"，也不该出现在重建候选里）⇒ 单列一张表，
   * 到回合由 `deployBreakoutReturnNow` 按**增援入场**的规则放回。
   */
  const breakoutReturns = ref<{ unit: ConsoleUnit; returnsOnTurn: number }[]>([])

  /**
   * 12.8e-A：**一次求值内复用**的单位索引（按格聚合**阵营**）
   *
   * 原实现对**每个格**各扫一遍全单位（`isTracedFriend` / `enemyCombatAt`），一个候选要扫
   * 8 024 格 × 2 遍 ⇒ 每格都要 `toWrapped → toReactive` 逐元素包装。这里把两张判据表一次建好，
   * 之后每次查询只做一次 `Map.get`；聚合的是**阵营集合**，因此多方（轴/苏）语义不变。
   */
  interface BreakoutUnitIndex {
    /** 该格有**追溯补给**的友方单位阵营（12.8e-A：路径能否"摸到友军"） */
    tracedFriendIds: Map<number, Side[]>
    /** 该格有**战斗**单位的阵营（12.8e-A：路径上是否有敌方战斗单位） */
    enemyCombatIds: Map<number, Side[]>
  }

  /**
   * 一次求值内共享的只读事实（索引 + 地图 + 记忆化 + ZOC 查询；都与具体候选无关）
   *
   * 档2（性能）：洪泛对同一格/同一条格边会反复查询（正反两向、两趟洪泛、多个候选），
   * 故按格/按边记忆化；`zocOf` 按方惰性构建一次（仅轮式候选会用到）。
   */
  interface BreakoutSharedFacts {
    index: BreakoutUnitIndex
    map: ReturnType<typeof createMapFacts>
    /** 地形按格记忆化（与 `mapLayers` 静态数据等价） */
    terrainsAt: (hex: HexRef) => readonly string[]
    /** 格边按**无序**格对记忆化（`hexsideOf` 归一，正反同一边） */
    crossingBetween: (
      a: HexRef,
      b: HexRef,
    ) => ReturnType<ReturnType<typeof createMapFacts>['crossingBetween']>
    /** 单步通行性按「机动类型 + 有序格对（数字键）」记忆化 */
    passability: Map<string, Map<number, boolean>>
    /** 六邻表（**只含在图内**、保持 `HEX_DIRECTIONS` 顺序），按数字格键缓存 */
    neighborsOf: (id: number, hex: HexRef) => readonly BreakoutNeighbor[]
    /** 4.5 的 ZOC 查询（按方惰性构建） */
    zocOf: (side: Side) => MoveStepFacts
  }

  /** 洪泛里的一步：数字格键 + 其 `HexRef`（预生成后跨候选复用，不再逐步 `neighbor()` 分配） */
  interface BreakoutNeighbor {
    id: number
    hex: HexRef
  }

  /**
   * 静态地图事实缓存（store 生命周期内复用）
   *
   * `createMapFacts()` 只依赖只读静态的 `mapLayers`，与回合/盘面无关；
   * 而 `breakoutCandidates` 在依赖环里可能被重算多次（`moveContext` ← 合法性 ← 候选），
   * 把按格/按边的结果放在这里才能做到「一次求值只算一次」。
   */
  const staticBreakoutMapCaches: {
    terrains: Map<string, readonly string[]>
    crossings: Map<string, ReturnType<ReturnType<typeof createMapFacts>['crossingBetween']>>
    passability: Map<string, Map<number, boolean>>
    neighbors: Map<number, readonly BreakoutNeighbor[]>
    zoc: Map<Side, { context: MoveContext; facts: MoveStepFacts }>
  } = {
    terrains: new Map(),
    crossings: new Map(),
    passability: new Map(),
    neighbors: new Map(),
    zoc: new Map(),
  }

  /** 建一份记忆化的地图事实 + 空缓存（候选间复用） */
  function buildBreakoutSharedFacts(): BreakoutSharedFacts {
    const map = createMapFacts()
    const terrains = staticBreakoutMapCaches.terrains
    const crossings = staticBreakoutMapCaches.crossings
    const zoc = staticBreakoutMapCaches.zoc
    return {
      index: buildBreakoutUnitIndex(),
      map,
      terrainsAt(hex) {
        const key = hexLabel(hex)
        const cached = terrains.get(key)
        if (cached !== undefined) return cached
        const value = map.terrainsAt(hex)
        terrains.set(key, value)
        return value
      },
      crossingBetween(a, b) {
        const left = hexLabel(a)
        const right = hexLabel(b)
        const key = left < right ? `${left}|${right}` : `${right}|${left}`
        const cached = crossings.get(key)
        if (cached !== undefined) return cached
        const value = map.crossingBetween(a, b)
        crossings.set(key, value)
        return value
      },
      passability: staticBreakoutMapCaches.passability,
      neighborsOf(id, hex) {
        const neighbors = staticBreakoutMapCaches.neighbors
        const cached = neighbors.get(id)
        if (cached !== undefined) return cached
        const built: BreakoutNeighbor[] = []
        for (const direction of HEX_DIRECTIONS) {
          const next = neighbor(hex, direction)
          // 原实现在洪泛里逐步 `!map.onMap(next) → continue`；这里等价地**只保留在图内**的邻格
          if (!map.onMap(next)) continue
          built.push({ id: next.col * 128 + next.row, hex: next })
        }
        neighbors.set(id, built)
        return built
      },
      zocOf(side) {
        const context = moveContext.value
        const cached = zoc.get(side)
        if (cached !== undefined && cached.context === context) return cached.facts
        // 12.8e-A 的 EZOC 判据直接复用引擎的 4.5 投影（与逐格现算等价）
        const facts = buildStepFacts(context, side)
        zoc.set(side, { context, facts })
        return facts
      },
    }
  }

  /**
   * 建一次索引，供本次求值的**全部候选**复用
   *
   * 建表读 `toRaw` 后的原始数组；但**依赖登记**仍必须经响应式数组读一遍判据字段
   * （否则 computed 会丢掉 `hasTraceSupply` / `isCombat` / `hex` 的依赖而算旧值）。
   */
  function buildBreakoutUnitIndex(): BreakoutUnitIndex {
    const tracedFriendIds = new Map<number, Side[]>()
    const enemyCombatIds = new Map<number, Side[]>()
    const record = (table: Map<number, Side[]>, key: number, side: Side): void => {
      const sides = table.get(key)
      if (sides === undefined) table.set(key, [side])
      else if (!sides.includes(side)) sides.push(side)
    }
    // 依赖登记：只读、不参与建表（值本身取自下面的 toRaw 遍历）
    for (const unit of units.value) {
      void unit.side
      void unit.hasTraceSupply
      void unit.isCombat
      void unit.hex.col
      void unit.hex.row
    }
    for (const element of toRaw(units.value)) {
      const unit = toRaw(element)
      const hex = toRaw(unit.hex)
      const id = hex.col * 128 + hex.row
      // 12.8e：突围环节**就地实时**判「有追溯补给的友方单位」，不读回合初的结算标记
      if (hasLiveTraceSupply(unit)) record(tracedFriendIds, id, unit.side)
      if (unit.isCombat) record(enemyCombatIds, id, unit.side)
    }
    return { tracedFriendIds, enemyCombatIds }
  }

  /**
   * 12.8e / 12.6：该单位**此刻**是否有追溯补给（只读查询，不写标记）
   *
   * 12.8e 括注明写「在此环节中检查追溯补给」，故突围资格不能沿用补给阶段的标记。
   * 12.6h 空投当回合与 12.9 非战斗单位照旧视为有补给；12.6f 的同源取舍
   * 属补给阶段判定，回合内沿用最近一次结论（`traceSettlement.denied`）。
   */
  /** 本回合是否有"可能突围"的候选（标记断补）；没有就不必为突围资格做实时洪泛 */
  const cutSideFlags = computed<Record<Side, boolean>>(() => {
    const flags: Record<Side, boolean> = { axis: false, soviet: false }
    for (const unit of units.value) if (!unit.hasTraceSupply) flags[unit.side] = true
    return flags
  })

  /**
   * 12.6：该单位**此刻的实时补给线**（只读查询；不写标记、不结算）
   *
   * 与 `settleTraceSupplyNow` 不同，这里不做整场判定，只回答"按当前盘面它能不能连到源"：
   * 供 12.8e 突围资格与界面的「当前补给线」提示共用，避免两处各写一套。
   * ★ 12.6f 的同源取舍仍取本回合判定快照的 `denied`（那是结算结论，不实时重算）。
   */
  function liveTraceLineOf(unit: ConsoleUnit): boolean {
    if ((unit.airDropExemptTurn ?? null) === turn.value) return true
    if (!requiresTraceSupply(unit)) return true
    const denied = traceSettlement.value?.denied[unit.side]
    if (denied !== undefined && denied.includes(unit.instanceId)) return false
    return traceSupplyAtForMove.value(unit.hex, unit.side)
  }

  function hasLiveTraceSupply(unit: ConsoleUnit): boolean {
    // 12.8e 的突围环节只在移动阶段出现；其余阶段（初设/补给/反应/exploit）不做
    // 这份实时洪泛，避免每次存店都白算一遍（读标记即可，结果本来也不被使用）。
    if (phase.value !== 'movement' || !cutSideFlags.value[unit.side]) return unit.hasTraceSupply
    return liveTraceLineOf(unit)
  }

  /**
   * 12.6：界面提示用的一行文字（**只有文字**）
   *
   * 仅在「实时线」与「本回合标记」不一致时给出：实时通但被标记断补、或标记在补但线已断。
   * ★ 用户 2026-11-13 口径：这是效果提示，不是结算 ⇒ 不写标记、不染地图色、不加角标。
   */
  function supplyLineHintOf(unit: ConsoleUnit): string | null {
    if (!requiresTraceSupply(unit)) return null
    const live = liveTraceLineOf(unit)
    const marked = supplyStatusOf(unit, turn.value).marked
    if (marked === !live) return null
    return `当前补给线：${live ? '通' : '断'}`
  }

  /**
   * 12.8e-A：从该单位所在格出发，按**移动模式的 MA 类型**判"长度任意的路径"
   *
   * 原文：「必须有一条**长度任意**的路径……路径上必须**没有敌方战斗单位**，也**没有移动禁入的地形**
   *   （以该突围单位**移动模式**的 MA 类型判断）。如果是**轮式 MP** 单位，这条路径上还必须没有
   *   **未被抵消的 EZOC**。」
   *
   * 做法：**两趟洪泛** ——
   *   ① **干净洪泛**：避开上述三类障碍格，若能摸到"有追溯补给的友方单位" ⇒ 存在这样的路径（A 成立）；
   *   ② **无限制洪泛**：只为给失败原因取证（记录路上遇到哪些障碍），若它连一个"有追溯补给的友方单位"
   *      都摸不到，则 A 的两项事实一律报 false —— 让引擎按 **B（15 格内）** 去判，不臆造原因。
   *
   * 档1（性能）：`shared` 由 `breakoutCandidates` 每次求值建一份（索引 + 地图事实），全候选复用；
   * 单独调用（如 `breakoutNow`）时按原样就地构建，判据不变。
   */
  function breakoutPathFacts(
    unit: ConsoleUnit,
    sharedInput?: BreakoutSharedFacts,
  ): {
    path: BreakoutPathFacts
    reachedTracedFriend: boolean
  } {
    const shared = sharedInput ?? buildBreakoutSharedFacts()
    const index = shared.index
    const mobility = unit.faces.move.mobility // 12.8e-A：以**移动模式**的 MA 类型判
    const side = unit.side
    // 起点克隆成 plain：原实现每个节点都读 `unit.hex`（Pinia 代理）做 sameHex，放大响应式开销
    const start: HexRef = { col: unit.hex.col, row: unit.hex.row }
    const startId = start.col * 128 + start.row
    const isTracedFriendId = (id: number): boolean => {
      if (id === startId) return false
      return index.tracedFriendIds.get(id)?.includes(side) ?? false
    }
    const enemyCombatAtId = (id: number): boolean => {
      const sides = index.enemyCombatIds.get(id)
      if (sides === undefined) return false
      for (const other of sides) if (other !== side) return true
      return false
    }
    let zocFacts: MoveStepFacts | null = null
    const ezocAt = (hex: HexRef): boolean => {
      if (mobility !== 'truck') return false
      if (zocFacts === null) zocFacts = shared.zocOf(side)
      return inEnemyZocAt(moveContext.value, hex, side, zocFacts)
    }
    // 通行性按「机动类型 → 有序格对数字键」记忆化（整次求值内跨候选、跨两趟洪泛复用）
    let passabilityOfMobility = shared.passability.get(mobility)
    if (passabilityOfMobility === undefined) {
      passabilityOfMobility = new Map<number, boolean>()
      shared.passability.set(mobility, passabilityOfMobility)
    }
    const passability = passabilityOfMobility
    const stepPassable = (from: BreakoutNeighbor, to: BreakoutNeighbor): boolean => {
      // 数字格键 `fromId * 16384 + toId`（col/row 均 < 128 ⇒ id < 16384，不会碰撞）
      const key = from.id * 16384 + to.id
      const cached = passability.get(key)
      if (cached !== undefined) return cached
      const ok = selectMovementTerrain({
        terrainsPresent: shared.terrainsAt(to.hex),
        mobility,
        crossing: shared.crossingBetween(from.hex, to.hex),
        followingRoad: false,
        forOverrun: false,
      }).ok
      passability.set(key, ok)
      return ok
    }
    const flood = (
      avoidObstacles: boolean,
    ): {
      reached: boolean
      hasEnemyCombatUnit: boolean
      hasProhibitedTerrain: boolean
      hasUnnegatedEzoc: boolean
    } => {
      const seen = new Set<number>([startId])
      const queue: BreakoutNeighbor[] = [{ id: startId, hex: start }]
      let hasEnemyCombatUnit = false
      let hasProhibitedTerrain = false
      let hasUnnegatedEzoc = false
      // 读指针出队：FIFO 顺序与 `shift()` 完全一致（拒绝理由的取证顺序不变），但不 O(n) 挪数组
      for (let head = 0; head < queue.length; head += 1) {
        const current = queue[head]!
        if (isTracedFriendId(current.id)) {
          return { reached: true, hasEnemyCombatUnit, hasProhibitedTerrain, hasUnnegatedEzoc }
        }
        // 六邻表按格预生成（只含图内格、`HEX_DIRECTIONS` 序），逐步不再分配/判图
        for (const next of shared.neighborsOf(current.id, current.hex)) {
          if (seen.has(next.id)) continue
          if (enemyCombatAtId(next.id)) {
            hasEnemyCombatUnit = true
            if (avoidObstacles) continue
          }
          if (!stepPassable(current, next)) {
            hasProhibitedTerrain = true
            if (avoidObstacles) continue
          }
          if (ezocAt(next.hex)) {
            hasUnnegatedEzoc = true
            if (avoidObstacles) continue
          }
          seen.add(next.id)
          queue.push(next)
        }
      }
      return { reached: false, hasEnemyCombatUnit, hasProhibitedTerrain, hasUnnegatedEzoc }
    }

    // 全图都没有本方"有追溯补给的友军"（起点格除外）⇒ 两趟洪泛必然都摸不到，直接返回
    let anyTracedFriend = false
    for (const [id, sides] of index.tracedFriendIds) {
      if (id !== startId && sides.includes(side)) {
        anyTracedFriend = true
        break
      }
    }
    if (!anyTracedFriend) {
      return {
        reachedTracedFriend: false,
        path: {
          mobility,
          hasEnemyCombatUnit: false,
          hasProhibitedTerrain: false,
          hasUnnegatedEzoc: false,
        },
      }
    }

    const clean = flood(true)
    if (clean.reached) {
      return {
        reachedTracedFriend: true,
        path: {
          mobility,
          hasEnemyCombatUnit: false,
          hasProhibitedTerrain: false,
          hasUnnegatedEzoc: false,
        },
      }
    }
    const unrestricted = flood(false)
    if (unrestricted.reached) {
      // 路存在但不干净 ⇒ 把**取证到**的障碍报给引擎（它据此给出带条文号的拒绝理由）
      return {
        reachedTracedFriend: false,
        path: {
          mobility,
          hasEnemyCombatUnit: unrestricted.hasEnemyCombatUnit,
          hasProhibitedTerrain: unrestricted.hasProhibitedTerrain,
          hasUnnegatedEzoc: unrestricted.hasUnnegatedEzoc,
        },
      }
    }
    // 连无限制洪泛都摸不到 ⇒ A 的两项事实一律 false，让引擎按 B 判（不臆造原因）
    return {
      reachedTracedFriend: false,
      path: {
        mobility,
        hasEnemyCombatUnit: false,
        hasProhibitedTerrain: false,
        hasUnnegatedEzoc: false,
      },
    }
  }

  /** 12.8e-B：最近的"**有追溯补给的友方战斗单位**"的**直线**距离（格；无 ⇒ null） */
  function nearestTracedCombatFriendDistance(unit: ConsoleUnit): number | null {
    let best: number | null = null
    for (const other of units.value) {
      if (other.side !== unit.side || !other.isCombat || !hasLiveTraceSupply(other)) continue
      const distance = hexDistance(unit.hex, other.hex)
      if (best === null || distance < best) best = distance
    }
    return best
  }

  /**
   * 12.8e：该单位此刻的**突围**是否处在「发现没有追溯补给的第一个回合」
   *
   * 回合序列（2.2 SOP / OCS v4.3 英文版 p.3「Movement Phase → Breakout Segment → Supply Phase」）：
   * **先突围、后补给**。断补是在补给阶段结尾才落标记（12.8a），而突围在该回合早已执行过
   * ⇒ 断补后的**第一次**突围必定发生在**下一回合**的运动阶段。
   * 故判据＝`cutSinceTurn === 当前回合 - 1`（12.8e「第一个回合」的突围可执行窗口）。
   * 括注：靠 12.6c/12.10e/21.10 续命的回合不落 `cutSinceTurn`（见 `markSustainedBySpecialSupply`），
   * 所以"吃图上补给之后"的下一回合自然不会命中本判据。
   */
  function isFirstTurnOfBeingCut(unit: ConsoleUnit): boolean {
    return (unit.cutSinceTurn ?? null) === turn.value - 1
  }

  /* ────────── 21.10：补给缓存（Forage 入口在补给阶段面板） ────────── */

  /**
   * 12.8e：该单位此刻的突围资格
   *
   * 判据一律交给引擎（`canBreakout`）：调用方只负责把 12.8e-A/B 的**事实**备齐。
   * 「断补首回合豁免」由 `isFirstTurnOfBeingCut` 判（**连续**无补给的起点回合，见 12.8e 括注）。
   */
  function breakoutVerdictOf(
    unit: ConsoleUnit,
    shared?: BreakoutSharedFacts,
  ): RuleOutcome<BreakoutEligibility> {
    const { path, reachedTracedFriend } = breakoutPathFacts(unit, shared)
    const conditions: BreakoutConditions = {
      path,
      nearestTracedCombatFriendDistance: reachedTracedFriend
        ? 0
        : nearestTracedCombatFriendDistance(unit),
    }
    return canBreakout({
      phase: phase.value,
      unit: {
        id: unit.instanceId,
        isCombat: unit.isCombat,
        isTransportPoint: unit.noncombatKind === 'transport_point',
        moveMa: unit.faces.move.ma,
        // 12.8e：本环节就地实时判（不读补给阶段的结算标记）
        hasTraceSupply: hasLiveTraceSupply(unit),
      },
      /* 12.8e：首回合＝**连续**无补给的起点回合（且非靠 12.6c/12.10e/21.10 续命的那一回合） */
      firstTurnOutOfSupply: isFirstTurnOfBeingCut(unit),
      conditions,
    })
  }

  /** 12.8e：本方可尝试突围的单位（含结论与原因，供界面阵列逐条灰显） */
  const breakoutCandidates = computed<
    { unit: ConsoleUnit; ok: boolean; reason: string | null; detail: string }[]
  >(() => {
    const candidates = units.value.filter(
      (unit) => unit.side === activeSide.value && !hasLiveTraceSupply(unit),
    )
    // 档1/2：索引、地图事实、通行性与 ZOC 查询**每次求值建一份**，本次全部候选复用
    // （都只依赖静态 `mapLayers` 与本单位阵营，与候选无关）
    const shared: BreakoutSharedFacts = buildBreakoutSharedFacts()
    return candidates.map((unit) => {
      const verdict = breakoutVerdictOf(unit, shared)
      return {
        unit,
        ok: verdict.ok,
        reason: verdict.ok ? null : `${verdict.reason}（${verdict.rule}）`,
        detail: verdict.ok ? verdict.data.detail : `${verdict.reason}（${verdict.rule}）`,
      }
    })
  })

  /**
   * 12.8e：**宣布一次突围尝试**（逐单位；运输点数须逐个分别掷骰 ⇒ 本动作一次只处理一个实例）
   *
   * 落盘：失败 ⇒ 进死亡堆（可正常重建）；成功 ⇒ **离图**并登记返场回合（保留军力损失、清除其他标记）。
   * 界面上必须**只在突围环节**可用（动作闸 `move.breakout` 只挂在 `movement.breakout`）。
   */
  function breakoutNow(instanceId: string): boolean {
    if (!requireAction('move.breakout', '突围尝试')) return false
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) {
      pushLog('warning', `突围：找不到单位实例 ${instanceId}（12.8e）`, '12.8e')
      return false
    }
    const verdict = breakoutVerdictOf(unit)
    if (!verdict.ok) {
      pushLog('danger', `突围被拒：${verdict.reason}（${verdict.rule}）`, verdict.rule)
      return false
    }
    const inputs = breakoutInputs.value
    const die = inputs.die ?? drawD6()
    const firstTurn = verdict.data.firstTurn
    const resolution = resolveBreakout({
      die,
      firstTurnOutOfSupply: firstTurn,
      currentTurn: turn.value,
      ...(inputs.returnDie === null ? {} : { returnDie: inputs.returnDie }),
      lastTurn: TURN_TRACK[TURN_TRACK.length - 1]?.turn,
    })
    // 成功且未给返场骰 ⇒ 引擎要求**再掷一次**（12.8e：为每个成功单位再掷一骰）
    const returnDie =
      resolution.pendingReturnDie && inputs.returnDie === null ? drawD6() : inputs.returnDie
    const final =
      resolution.pendingReturnDie && returnDie !== null
        ? resolveBreakout({
            die,
            firstTurnOutOfSupply: firstTurn,
            currentTurn: turn.value,
            returnDie,
            lastTurn: TURN_TRACK[TURN_TRACK.length - 1]?.turn,
          })
        : resolution
    const attempt = final.attempt
    if (attempt.success) {
      breakoutReturns.value = [
        ...breakoutReturns.value,
        {
          unit,
          returnsOnTurn: final.returnInfo?.returnsOnTurn ?? turn.value + (returnDie ?? 0),
        },
      ]
      units.value = units.value.filter((item) => item.instanceId !== unit.instanceId)
      // 12.8a：离图不重判其他单位的断补标记（标记保留到下一个友方补给阶段）
      pushLog('success', `${unit.name} 突围成功：${attempt.detail}`, '12.8e')
      pushLog('info', final.returnInfo?.detail ?? '（未定返场回合）', '12.8e')
    } else {
      eliminateEntry(unit, '12.8e', `${unit.name} 突围失败，进入死亡堆（12.8e）`)
      pushLog('danger', `${unit.name} 突围失败：${attempt.detail}`, '12.8e')
    }
    recordSettlement({
      action: 'breakoutAttempt',
      rule: '12.8e',
      rolls: [{ count: 1, faces: [die], total: die }],
      data: {
        unitId: unit.instanceId,
        die,
        modifiedDie: attempt.modifiedDie,
        success: attempt.success,
        disposition: attempt.disposition,
        returnsOnTurn: final.returnInfo?.returnsOnTurn ?? null,
      },
    })
    return true
  }

  /**
   * 12.8e：把**到期的**突围单位按**增援入场**的规则放回地图
   *
   * 「……作为增援返回」⇒ 落点走 13.6b 的入场规则（本方**地图边缘入场格**、且未被敌方单位阻挡）；
   * 回合未到（`turn < returnsOnTurn`）一律拒绝。
   */
  function deployBreakoutReturnNow(instanceId: string, hexText: string): boolean {
    const entry = breakoutReturns.value.find((item) => item.unit.instanceId === instanceId)
    if (entry === undefined) {
      pushLog('warning', `返场：待返场清单里没有 ${instanceId}（12.8e）`, '12.8e')
      return false
    }
    if (turn.value < entry.returnsOnTurn) {
      pushLog(
        'danger',
        `${entry.unit.name} 要到回合 ${entry.returnsOnTurn} 才能返场（12.8e）`,
        '12.8e',
      )
      return false
    }
    const hex = parseHexPath(hexText)[0] ?? null
    if (hex === null) {
      pushLog('warning', `落点格号应为「列.行」：${hexText}`, '13.6b')
      return false
    }
    const facts = arrivalFacts.value
    const isOwnEntryHex = facts.edgeSupplySourceHexes().some((item) => sameHex(item, hex))
    if (!isOwnEntryHex) {
      pushLog(
        'danger',
        `${hexLabel(hex)} 不是本方的地图边缘入场格（12.8e 按增援返回 / 专规 2.1·3.1）`,
        '12.8e',
      )
      return false
    }
    if (facts.isBlocked(hex)) {
      pushLog(
        'danger',
        `${hexLabel(hex)} 被敌方单位阻挡：按 13.6b 请改选最近的未被阻挡边缘格`,
        '13.6b',
      )
      return false
    }
    const unit = entry.unit
    unit.hex = { ...hex }
    unit.hasTraceSupply = true
    unit.movementEnded = true
    // 12.8e 末段：返回时**清除其他标记**（DG 等），军力损失**保留**（本作的军力由 `steps` 承载，故不动）
    unit.mode = { ...unit.mode, dg: false }
    units.value = [...units.value, unit]
    breakoutReturns.value = breakoutReturns.value.filter(
      (item) => item.unit.instanceId !== instanceId,
    )
    // 12.8a：返场不重判其他单位的标记（12.8e 只要求本环节就地检查突围资格）
    pushLog(
      'success',
      `${unit.name} 于回合 ${turn.value} 作为增援返场 ${hexLabel(hex)}（12.8e）`,
      '12.8e',
    )
    return true
  }

  /** 4.5b：以某单位许诺「本阶段不再消耗 MP」，抵消其所在格的敌方 ZOC */
  function lockZocNegation(instanceId: string): void {
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return
    if (!unit.isCombat) {
      pushLog('warning', `${unit.name} 不是战斗单位，不能用于抵消敌方 ZOC（4.5b）`, '4.5b')
      return
    }
    unit.mpLockedThisPhase = true
    pushLog(
      'info',
      `${unit.name} 许诺本阶段不再消耗 MP → 抵消 ${unit.hex.col}.${unit.hex.row} 格的敌方 ZOC（4.5b）`,
      '4.5b',
    )
  }

  /**
   * 4.5b：当前选中单位此刻能否承担「垫人」（许诺本阶段不再消耗 MP，抵消其所在格敌方 ZOC）
   *
   * 用户 2026-11-14 口径「不可用项不出现」：面板不再摆一个点了只会提示"不是战斗单位"的按钮。
   * 判据与 `lockZocNegation` 同源：战斗单位、且本阶段尚未承诺过。
   */
  const canLockZocNegationNow = computed<boolean>(() => {
    const unit = selectedUnit.value
    return unit !== null && unit.isCombat && !unit.mpLockedThisPhase
  })

  /**
   * 「打一仗」的点击分派（C6 九步流程的选格）
   *
   * ★ 批 A 切片 2：本函数是**唯一实现** —— 验证页的"工具＝battle"与对局台**战斗环节**的点击都调它，
   *   不再各写一遍"点敌方格选防御格 / 点己方单位加减攻方"。
   */
  function battleToolClick(hex: HexRef): void {
    if (specialPending.value !== null) return
    if (combatState.value?.finished === true) clearCombat()
    // C6 九步流程进行中：先按 9.2 结算完（或明确放弃），避免盘面在流程中途漂移
    if (combatState.value !== null) {
      pushLog('warning', '本场战斗进行中：请先结算完 9.2 流程，或点「放弃本场战斗」', '9.2')
      return
    }
    if (battleMode.value === 'full') {
      // C6：点敌方格＝选防御格；点己方算子＝加入/移出攻方（9.1b）
      const atHex = unitsAt(hex)
      if (atHex.some((unit) => unit.side !== activeSide.value)) {
        // 用户 2026-11-13 批 F：点可攻击格＝直接发起战斗（进补给步），不再停在"只有入口"的卡上
        if (selectCombatDefenderHex(hex)) beginCombatNow()
        return
      }
      if (atHex.some((unit) => unit.side === activeSide.value)) {
        const pick = [...atHex].reverse().find((unit) => unit.side === activeSide.value)!
        toggleCombatAttacker(pick.instanceId)
        return
      }
      battleTarget.value = null
      pushLog('info', `${hexLabel(hex)} 是空格；点己方算子加入攻方，点敌方算子所在格选定防御格`)
      return
    }
    // quick：一键查表（9.9 便捷入口）——点己方算子设为攻方，再点敌方格选定交战
    const top = [...units.value]
      .reverse()
      .find((item) => item.hex.col === hex.col && item.hex.row === hex.row)
    const attacker = selectedUnit.value
    if (top !== undefined && (attacker === null || top.side === activeSide.value)) {
      selectedId.value = top.instanceId
      battleTarget.value = null
      pushLog('info', `攻方 → ${top.name} @ ${hex.col}.${hex.row}（再点敌方算子所在格选定交战）`)
      return
    }
    openBattle(hex)
  }

  /**
   * 点地图：按工具模式分派（摆子 / 打一仗 / C5 移动交互）
   *
   * C5 的交互流（用户需求）：
   *   选单位或堆叠 → 显示可移动范围 → 点格逐格移动（每格重算范围）→ 不想走了点「结束移动」。
   * 全部规则结论来自引擎（`move-interaction` 系列函数），本函数只做分派与落盘。
   */
  function clickHex(hex: HexRef): void {
    /*
     * ★ 批 A 切片 2（用户口径「正式界面由流程驱动」）：**环节优先**，其余照旧 ——
     *   ① 当前环节是某段的**轰炸环节** ⇒ 点地图＝选**轰炸目标格**（10.0d）；
     *   ② 当前环节是**战斗环节** ⇒ 点敌方格＝选防御格、点己方单位＝加入/移出攻方（9.1b/c）。
     *   对局台因此**不需要任何工具切换**；验证页的工具分派与对局台的移动交互都排在后面、原样保留。
     */
    if (isBarrageSegment.value) {
      pickBarrageTargetAt(hex)
      return
    }
    if (isCombatPickSegment.value) {
      battleToolClick(hex)
      return
    }
    if (tool.value === 'place') {
      if (pendingRecord.value === null) {
        pushLog('warning', '先从单位列表选一个算子，再点地图摆放')
        return
      }
      placeAt(hex)
      return
    }
    if (tool.value === 'battle') {
      battleToolClick(hex)
      return
    }
    /*
     * v7.1 §1.1 / §4.5：重建段内**再点本段刚重建出的算子 ⇒ 收回并退点**。
     * 只在本段有效（`rebuildPlacedThisSegment` 随段清空），且该格恰好一枚时消费这次点击；
     * 其余情况交回常规点击，不吞掉玩家的选/移动。
     */
    if (segmentStep.value?.id === 'reinforcement.rebuild' && withdrawRebuildAtHexNow(hex)) {
      return
    }

    // C5：已在移动中 → 这一点是「走到该格」
    let interaction = moveInteraction.value
    // 6.1 末句：一个单位/堆叠结束移动后再动下一个 —— 若上一轮已 finished，
    // 则点地图意味着玩家要开始新动作（选别的单位或发起突袭），此时惰性清空
    // 上轮 interaction，让后续分派正确落到「选单位 / 突袭目标」分支。
    if (interaction !== null && interaction.finished) {
      clearMoveInteraction()
      interaction = null
    }
    if (interaction !== null) {
      const staying = interaction.unitIds
        .map((id) => units.value.find((item) => item.instanceId === id))
        .find(
          (unit) =>
            unit !== undefined &&
            !unit.movementEnded &&
            unit.hex.col === hex.col &&
            unit.hex.row === hex.row,
        )
      if (staying !== undefined) {
        /*
         * ★ B26（用户口径 2026-09-16 #21）：「**点选单位移动落子后，再点击单位即移动结束**，
         *   不需要额外的移动结束按钮」。所以点到自己所在格＝收束本次移动（不是报错）。
         * 加一条"至少走过一步"的判据：刚点开还没动就再点一下，不该把这次移动关掉
         * （那时玩家多半是想换人/换格，弹一句提示更合适）。
         */
        if (interaction.steps.length === 0) {
          pushLog('info', '还没移动：点高亮格走一格（6.1）；点别的己方算子可换人', '6.1')
          return
        }
        finishMove()
        // 8.1a：突袭未收束时 `finishMove` 会拒绝并已就地给出原因 ⇒ 不再补一句"已结束"
        if (moveInteraction.value?.finished !== true) return
        pushLog('info', '再点本单位 ＝ 结束本次移动（6.1）', '6.1')
        return
      }
      tryMoveTo(hex)
      return
    }

    /*
     * M1（用户 2026-11-16）：**取子清单存在 ⇒ 点高亮格＝同一击开拔并落子**。
     * 不再要求先按「开始移动」：开拔由 `confirmMovePick` 建（拒绝原因仍由它给），
     * 随后 `tryMoveTo` 走同一条落子链 ⇒ 撤销（U/Backspace）与点击路径完全一致。
     */
    const pick = movePick.value
    if (pick !== null && (pick.hex.col !== hex.col || pick.hex.row !== hex.row)) {
      /*
       * 2026-11-18：**可进入格优先按落点处理**（用户走查）。
       *   修前只有"没有己方堆叠"的格才算落点 ⇒ 点到可进入、且格内有己方单位的邻格时，
       *   这一击被堆叠/换选吃掉，单位走不进去。现在先问引擎：可达就开拔并落子；
       *   不可达才回落到"点另一支己方堆叠＝换选"。
       */
      const node = reachableNodeAt(groupReachable.value.hexes, hex)
      if (node !== null) {
        if (!confirmMovePick()) return
        tryMoveTo(hex)
        return
      }
      if (friendlyUnitsAt(hex).length === 0) {
        /*
         * G1（用户 2026-11-17 实走）：点不到的格要说清**缺什么**——
         * 未加油 / 地形不可进 / MA 不足 / 敌占 / 出界各一句（判据来自引擎 `evaluateStep`）。
         */
        const note = moveRejectNoteAt(hex)
        moveBlocked.value = { rule: note.rule, reason: note.text }
        pushLog('warning', moveBlocked.value.reason, note.rule)
        return
      }
      // 有己方堆叠且不可达 ⇒ 换选（既有口径）
    }

    // C5：未开始移动 → 选单位或堆叠（当前方优先；6.1 可单独或以堆叠移动）
    if (friendlyUnitsAt(hex).length > 0) {
      selectForMove(hex)
      return
    }
    const atHex = [...units.value]
      .reverse()
      .find((item) => item.hex.col === hex.col && item.hex.row === hex.row)
    selectedId.value = atHex?.instanceId ?? null
    clearMoveInteraction()
    pushLog(
      'info',
      atHex === undefined
        ? `选中格 ${hex.col}.${hex.row}（空格）`
        : `选中 ${atHex.name}（非当前方，仅供查看，不能移动）`,
    )
  }

  /** 把 B21 的违规项折成一行可读文本 */
  function violationText(verdict: Extract<LegalityVerdict, { ok: false }>): string {
    return verdict.violations
      .map(
        (violation) =>
          `${violation.family}:${violation.detail ?? violation.reason}（${violation.rule}）`,
      )
      .join('；')
  }

  /**
   * 选定交战（9.0/9.1）：校验 9.1a 相邻、3.2b 可攻击，并按 B21 判时机/模式
   *
   * 通过后只**记下目标**，由面板确认 9.3b 地形与 9.6 行动值后再结算（防御方有选择权）。
   */
  function openBattle(defenderHex: HexRef): void {
    // 9.1：宣告交战在战斗段的「战斗环节」（F 段首环是炮击，那一刻还不能宣告战斗）
    if (!requireAction('combat.declare', '宣告交战')) return
    const attacker = selectedUnit.value
    if (attacker === null) {
      pushLog('warning', '先选中一个算子作为攻方（点己方算子）')
      return
    }
    const defenders = unitsAt(defenderHex)
    if (defenders.length === 0) {
      pushLog('warning', `${defenderHex.col}.${defenderHex.row} 没有守方单位`)
      return
    }
    if (defenders[0]!.side === attacker.side) {
      pushLog('warning', '攻守必须为敌对双方')
      return
    }
    // 9.1a：进攻必须由相邻格的单位发起
    if (!areAdjacent(attacker.hex, defenderHex)) {
      pushLog(
        'warning',
        `${attacker.name} @ ${attacker.hex.col}.${attacker.hex.row} 与 ${defenderHex.col}.${defenderHex.row} 不相邻，不能进攻（9.1a）`,
        '9.1a',
      )
      return
    }
    // 3.2b/9.4：无攻击能力或战斗值为 0 的单位不能进攻（也避免把 0 军力送进 CRT）
    if (!attacker.attackCapable || attacker.raw.attack <= 0) {
      pushLog(
        'warning',
        `${attacker.name} 不可进攻（attackCapable=${attacker.attackCapable}，战斗值 ${attacker.raw.attack}）`,
        '3.2b',
      )
      return
    }
    // 2.2 时机（常规战斗仅 F/G 段）+ 5.x 模式：统一问 B21
    const verdict = checkLegality(
      buildLegalityRequest({
        action: 'attack',
        unit: attacker,
        context: moveContext.value,
        units: units.value,
        date: date.value,
        target: defenderHex,
        // F 战斗段没有移动环节，必须显式给出当前 SOP 段，否则会被当成 C 段
        phase: phase.value,
      }),
    )
    if (!verdict.ok) {
      pushLog('danger', `不能进攻：${violationText(verdict)}`, verdict.violations[0]!.rule)
      return
    }
    battleTarget.value = { hex: defenderHex, defenderIds: defenders.map((unit) => unit.instanceId) }
    // 9.3b：地形由防御方选，先给「对防御方最有利」的默认值；9.6：行动值默认取最高（null）
    battleTerrain.value = defaultDefenseTerrain(defenderHex)
    battleDefenderArId.value = null
    pushLog(
      'info',
      `选定交战：${attacker.name} → ${defenderHex.col}.${defenderHex.row}（守方 ${defenders.length} 个）；确认地形/行动值后点「结算战斗」`,
      '9.1',
    )
  }

  /** 结算已选定的交战（9.3b 地形 + 9.6 行动值 + 16.0 环形工事 + 9.9 CRT） */
  function resolveBattleNow(): void {
    const attacker = selectedUnit.value
    const target = battleTarget.value
    if (attacker === null || target === null) {
      pushLog('warning', '尚未选定交战（先选攻方，再点敌方算子所在格）')
      return
    }
    const defenders = battleDefenders.value
    if (defenders.length === 0) {
      pushLog('warning', '守方单位已不在目标格，请重新选定交战')
      battleTarget.value = null
      return
    }
    const chosenTerrain =
      battleTerrain.value !== '' ? battleTerrain.value : defaultDefenseTerrain(target.hex)
    // 9.6：守方指定的参战单位（未指定则由引擎退回「取最高」）
    const defenderArUnit = defenders.find((unit) => unit.instanceId === battleDefenderArId.value)
    const outcome = resolveBattle({
      rng: rng.value,
      attackers: [attacker],
      defenders,
      chosenTerrain,
      // 16.0/9.9：守方环形工事等级（含专规 1.3a 的**地图印刷永久工事**，与 createBattleFacts 同口径）
      hedgehogLevel: Math.max(
        printedHedgehogLevelAt(target.hex),
        hedgehogLevelAt(units.value, target.hex),
      ),
      // 9.6：攻方只有 1 个参战单位；守方按玩家指定
      attackerAr: attacker.raw.ar,
      ...(defenderArUnit === undefined ? {} : { defenderAr: defenderArUnit.raw.ar }),
    })
    if (!outcome.ok) {
      pushLog('danger', `打不起来：${outcome.reason}`, '9.9')
      return
    }
    rng.value = outcome.rng
    drawCount.value += 1
    lastBattle.value = outcome.report
    const report = outcome.report
    pushLog(
      'success',
      `2d6 = ${report.dice.faces.join('+')} = ${report.dice.total}；修正骰 ${report.rule.modifiedDice}（AR ${report.attackerAR}−${report.defenderAR}，工事 ${report.hedgehogLevel}）；` +
        `地形 ${report.terrain}（${report.terrainLine}）；军力 ${report.attackerStrength} : ${report.defenderStrength} = ${report.rule.ratio}；` +
        `CRT「${report.rule.raw}」→ 攻方 L${report.rule.attacker.losses}${report.rule.attacker.hasOption ? ' + 选项' : ''}` +
        `${report.rule.attacker.exploitationAR === undefined ? '' : ` e${report.rule.attacker.exploitationAR}`}` +
        `／守方 L${report.rule.defender.losses}${report.rule.defender.hasOption ? ' + 选项' : ''}` +
        `${report.rule.defender.disorganized ? ' + DG' : ''}`,
      '9.9',
    )
    // ⑭ 接线：一键查表（9.9 战斗表）入会话日志；rolls 取引擎报告的 2d6
    recordSettlement({
      action: 'combatDice',
      rule: '9.9',
      rolls: [report.dice],
      data: {
        mode: 'quick',
        terrain: report.terrain,
        attackerAR: report.attackerAR,
        defenderAR: report.defenderAR,
        hedgehogLevel: report.hedgehogLevel,
        modifiedDice: report.rule.modifiedDice,
        ratio: report.rule.ratio,
        raw: report.rule.raw,
        attackerLosses: report.rule.attacker.losses,
        defenderLosses: report.rule.defender.losses,
        defenderDisorganized: report.rule.defender.disorganized,
      },
    })
  }

  /* ──────────────── C6 战斗交互：选子 → 9.2 九步流程动作（全部问引擎） ──────────────── */

  /**
   * 9.2：当前战斗会话**不能放弃**的原因（唯一判据，`cancelCombat` 与 UI 投影共用）
   *
   * 查询与提交复用同一来源：界面只读它，不自己判「是否已提交」。
   */
  function combatCancelBlocker(): string | null {
    if (combatSupplyCommitted.value && combatState.value !== null && !combatState.value.finished) {
      return '战斗结果待结算：请先完成损失、选项、撤退与推进'
    }
    return null
  }
  /**
   * 10.0：当前轰炸会话**不能放弃**的原因（唯一判据，`canReplaceBarrage` 与 UI 投影共用）
   */
  function barrageCancelBlocker(): string | null {
    return barrageCommitted.value ? '轰炸已提交，请先完成掷骰和目标损失结算' : null
  }
  function canReplaceBarrage(): boolean {
    const blocker = barrageCancelBlocker()
    if (blocker === null) return true
    barrageError.value = { rule: '10.0', reason: 'barrageOutcomePending' }
    pushLog('warning', blocker, '10.0')
    return false
  }
  function canReplaceCombat(): boolean {
    if (!combatSupplyCommitted.value) return true
    combatError.value = { rule: '9.2', reason: '请先完成已经提交的战斗' }
    pushLog('warning', '战斗已提交，请先完成损失、选项、撤退与推进', '9.2')
    return false
  }
  /** C6：切战斗工具模式（quick＝一键查表 9.9；full＝9.2 九步完整流程） */
  function setBattleMode(next: 'quick' | 'full'): void {
    if (!canReplaceCombat()) return
    battleMode.value = next
    clearCombat()
    battleTarget.value = null
    pushLog(
      'info',
      next === 'full' ? '战斗工具 → 九步完整流程（9.2）' : '战斗工具 → 一键查表（9.9）',
    )
  }

  /** C6：清空本场战斗的全部交互状态（换方/换阶段/重置/关闭时调用） */
  function clearCombat(force = false): void {
    if (
      !force &&
      combatSupplyCommitted.value &&
      combatState.value !== null &&
      !combatState.value.finished
    ) {
      pushLog('warning', '本场战斗已提交补给，必须完成战损、选项、撤退与推进', '9.2')
      return
    }
    resetOptionDraft()
    combatAttackerIds.value = []
    fireResolution.resetCombat()
    // W7 C16：战斗补给的来源声明随本场战斗一并作废（ids 与真正付款用的 picks 必须一起清）
    combatSupplyDumpIds.value = { attacker: null, defender: null }
    combatSupplyDumpPicks.value = { attacker: [], defender: [] }
    // 9.12d / 9.12f：跟随者名单与「战斗开始时」快照随之作废
    combatTagalongIds.value = []
    combatStartSnapshot.value = []
    // 选定目标一并清掉：战斗结束后防御格可能已易手，留着旧目标会误导下一次选择
    battleTarget.value = null
  }

  /**
   * 13.5 / 13.5b / 13.5c / 13.5e：地面条目**离场后的唯一去向分派**
   *
   * 返回 `true` 表示确实进了死亡堆；`false` 表示已按判据改道：
   * - 拆分单位 ⇒ 拆分资源池（13.5b）；
   * - 补员 / 13.5c 黄点 / 重建表无行的设施与标记 ⇒ 永久移除（13.5 / 13.5c）。
   *
   * ★ 修前 `eliminateEntry` 只拦补员与 13.5c，`sendToDeadPileNow` 更是完全不过判据：
   *   空军基地、SP、工事、延补队会从这两条路进死亡堆，再漏进重建候选与 1.6c 特殊补员池。
   */
  function admitGroundDeadPile(
    entry: ConsoleUnit,
    rule: string,
    text: string,
    tone: 'danger' | 'info' = 'danger',
  ): boolean {
    const disposition = deadPileDispositionOf(entry)
    if (disposition === 'pool') {
      const nationality = nationalityOfUnit(entry)
      breakdownPool.value = {
        ...breakdownPool.value,
        [nationality]: (breakdownPool.value[nationality] ?? 0) + 1,
      }
      pushLog(tone, `${text}（13.5b：拆分单位被毁 ⇒ 返回拆分资源池，不进死亡堆）`, rule)
      return false
    }
    if (disposition === 'remove') {
      if (isReplUnit(entry)) {
        pushLog(tone, `${text}（13.5：补员算子被摧毁即消灭，不进死亡堆）`, rule)
        return false
      }
      if (entry.rebuildable === false) {
        removedForever.value = [...removedForever.value, entry]
        pushLog(tone, `${text}（13.5c：AR 后有黄点 ⇒ 摧毁即永久移除，不进死亡堆）`, rule)
        return false
      }
      pushLog(tone, `${text}（13.5：重建表无对应行 ⇒ 设施/标记不进死亡堆，直接移除）`, rule)
      return false
    }
    deadPile.value = [...deadPile.value, entry]
    pushLog(tone, text, rule)
    return true
  }

  /**
   * 淘汰落盘：把**被摧毁**的算子移出盘面并**放进死亡堆**（唯一入口）
   *
   * ★ 为什么必须集中一处：死亡堆是 13.5 重建与专规 1.6c「随机重建一个师」的**唯一来源**
   *   （`containers.rebuildCandidates` / `freeSpecialReplPool(deadPile)`，界面上的 C12 死亡堆盒
   *   也直接读它）。原先战斗、轰炸、空投三处淘汰各自只做 `splice`/`filter` 并打一句
   *   「移入死亡堆」，盘面里却查不到该单位——规则链就断在这里，且因为断言只看结论、
   *   不看盘面账本，2255 个用例全绿也发现不了。
   * ★ **地面与空军共用本入口与同一个死亡堆**（用户裁定；依据 14.1b 飞机亦可重建）：
   *   按判别字段决定从 `units` 还是 `airUnits` 移除，并顺带清掉与它绑定的选中/任务态。
   * ★ `text` 由调用方给出（各条的规则出处不同），但「进死亡堆」这一动作由本函数保证。
   */
  function eliminateEntry(entry: DeadPileEntry, rule: string, text: string, _refresh = true): void {
    if (isAirDeadPileEntry(entry)) {
      airUnits.value = airUnits.value.filter((item) => item.instanceId !== entry.instanceId)
      airMissionAirIds.value = airMissionAirIds.value.filter((id) => id !== entry.instanceId)
    } else {
      units.value = units.value.filter((item) => item.instanceId !== entry.instanceId)
      // 选中态可能正指着这个单位；不清会留下悬空选中
      if (selectedId.value === entry.instanceId) selectedId.value = null
    }
    /*
     * 13.5 / 13.5b / 13.5c / 13.5e：按**唯一判据**决定去向（`deadPileDispositionOf`）。
     *
     * 修前只拦了补员与 13.5c 黄点 ⇒ 空军基地、SP、工事、延补队等**重建表里没有行的
     * 设施/标记**也会被打进死亡堆，进而出现在死亡堆盒、重建候选与 1.6c 特殊补员池里。
     * 13.5b 的拆分单位也被错打进死亡堆（应返回拆分资源池）。
     */
    if (!isAirDeadPileEntry(entry)) {
      admitGroundDeadPile(entry, rule, text)
      return
    }
    deadPile.value = [...deadPile.value, entry]
    pushLog('danger', text, rule)
    // 12.8a：同上 —— 标记保留到下一个友方补给阶段
  }

  /**
   * 5.10 / 5.10c：给单位施加 **DG**（混乱模式）——**被动模式替代当前模式**
   *
   * 条文：「可用 DG 标记来标记混乱模式，并**保持单位当前移动或战斗面的朝向**。
   *   **从该堆叠中移除其他所有模式标记**。」5.10c：运输点数不受 DG 影响，
   *   其中处于预备模式的**编内卡车**只是失去预备标记。
   *
   * ★ 此前两处施加点都只做 `unit.mode.dg = true`，**不清** 预备 / 战略 / 进击标记 ——
   *   于是 DG 与被动的模式标记叠加，B1 修好的模式折算会错上加错
   *   （战略模式战斗值应为 0，却按 DG ×½ 或预备 ×½ 算）。判据本身早已写在
   *   `engine/rules/modes.ts#markersAfterDg` 里，本函数是它的**唯一落盘点**。
   */
  function applyDgToUnit(unit: ConsoleUnit): void {
    const markers = markersAfterDg({ unitClass: modeUnitClassOf(unit), state: unit.mode })
    if (markers === 'loseReserveMarkerOnly') {
      // 5.10c：运输点数不受 DG 影响；处于预备模式的编内卡车失去预备标记
      if (unit.mode.mode === 'reserve')
        unit.mode = { ...unit.mode, mode: unit.mode.orientation, releasedFromReserve: false }
      return
    }
    // 5.10：移除其他所有模式标记（预备 / 战略 / 进击），朝向不变，只留 DG
    unit.mode = {
      mode: unit.mode.orientation,
      orientation: unit.mode.orientation,
      dg: true,
      exploit: false,
      releasedFromReserve: false,
    }
  }

  /**
   * C6：把引擎给出的战斗变更落盘（引擎不写状态，CODE_SPEC §3.1）；军力归零者移入死亡堆（9.11）
   *
   * M4：可选的 `movePatches` 让「9.12g 战斗推进补丁 + 8.0 突袭移动补丁」**一次算、一次落盘**
   * （K5 的结构性根因：修前先写战斗、再写突袭，中途失败会留下「已推进却没扣 3 MP」的半截状态）。
   * 合并后每枚单位只写一遍，字段次序仍沿用修前口径（军力→格→DG→进击→移动格/MP/结束标记）；
   * 「进入某格」（专规 3.5）按**最终格**只判一次（两处同格时与修前的第二次空操作等价）。
   */
  function applyCombatPatches(
    patches: readonly CombatUnitPatch[],
    movePatches: readonly MoveUnitRuntime[] = [],
  ): void {
    const moveById = new Map(movePatches.map((patch) => [patch.unitId, patch]))
    const ids =
      movePatches.length === 0
        ? patches.map((patch) => patch.unitId)
        : [...new Set([...patches.map((patch) => patch.unitId), ...moveById.keys()])]
    /*
     * 9.12g + 9.13：引擎对**同一单位**可能一次给多张补丁（推进的 `hex` 与进击标记 `exploit` 各一张）。
     * 修前按 unitId 建 Map 直接覆盖 ⇒ 后一张顶掉前一张，推进的换格补丁被丢掉：
     * 守方撤退后玩家点推进格，战斗显示已收束，单位却还停在原格（2026-11-15 F 段实点）。
     * 这里按字段合并，补丁没给的字段保持原值。
     */
    const patchById = new Map<string, CombatUnitPatch>()
    for (const patch of patches) {
      const prev = patchById.get(patch.unitId)
      if (prev === undefined) {
        patchById.set(patch.unitId, patch)
        continue
      }
      const merged: CombatUnitPatch = { unitId: patch.unitId }
      const steps = patch.steps ?? prev.steps
      if (steps !== undefined) merged.steps = steps
      const hex = patch.hex ?? prev.hex
      if (hex !== undefined) merged.hex = hex
      if (patch.dg === true || prev.dg === true) merged.dg = true
      if (patch.exploit === true || prev.exploit === true) merged.exploit = true
      patchById.set(patch.unitId, merged)
    }
    const eliminated: ConsoleUnit[] = []
    for (const id of ids) {
      const unit = units.value.find((item) => item.instanceId === id)
      if (unit === undefined) continue
      const patch = patchById.get(id)
      const move = moveById.get(id)
      let dead = false
      if (patch?.steps !== undefined) {
        unit.steps = patch.steps
        if (patch.steps <= 0) {
          dead = true
          eliminated.push(unit)
        }
      }
      // 9.11 阵亡者：修前 `applyCombatPatches` 之后即移入死亡堆，后续移动补丁对它不再生效
      if (dead) continue
      if (patch?.hex !== undefined) unit.hex = { ...patch.hex }
      if (patch?.dg === true) applyDgToUnit(unit)
      if (patch?.exploit === true) unit.mode.exploit = true
      if (move !== undefined) {
        unit.hex = { ...move.hex }
        unit.mpSpent = move.spentMp
        unit.movementEnded = move.ended
        // 13.8b 末句例外：离开自有桥格后，这条例外即用尽
        noteUnitLeftOwnBridgeHex(unit)
      }
      // 专规 3.5：战斗后推进/撤退（以及 8.0 的突袭进格）同样是"进入某格"，按最终格判一次
      const finalHex = move?.hex ?? patch?.hex
      if (finalHex !== undefined) noteUnitEnteredHex(unit, finalHex)
    }
    for (const unit of eliminated)
      eliminateEntry(unit, '9.11', `${unit.name} 军力归零，移入死亡堆（9.11）`)
    syncCombatArReference()
  }

  /**
   * 批 12（9.6 / 9.11c）：战斗窗的**领队引用**必须随单位离场同步
   *
   * 9.6 的 AR 单位在**掷骰前**宣布，写进 `state.ar.*UnitId`；9.11c 的损失自它起算，9.13b-A 也拿它判 DG。
   * 它在结算中被消灭（强制损失 / 选项损失 / 9.12e 额外损失）后，`state.ar` 仍指向已进死亡堆的实例 id
   * ⇒ 战斗窗的领队栏与取数投影会继续引用一个不在 `units` 里的单位。
   *
   * 口径：**允许无领队**。AR 单位是掷骰前宣布的（9.6），被消灭后规则里没有"改选"，故把该侧引用
   * 置空（`''`）；9.11c 的损失顺序与 9.13b-A 的 DG 判定按剩余单位自然落空，后续步骤不再依赖领队。
   * 该侧仍有参战单位时也不改选 —— 改选会让 9.11c"AR 单位先受第一点"落到一个并非 AR 的单位上。
   */
  function syncCombatArReference(): void {
    const state = combatState.value
    if (state === null || state.finished === true || state.ar === undefined) return
    const alive = new Set(units.value.map((unit) => unit.instanceId))
    const attackerUnitId = alive.has(state.ar.attackerUnitId) ? state.ar.attackerUnitId : ''
    const defenderUnitId = alive.has(state.ar.defenderUnitId) ? state.ar.defenderUnitId : ''
    if (attackerUnitId === state.ar.attackerUnitId && defenderUnitId === state.ar.defenderUnitId)
      return
    const cleared = [
      attackerUnitId === state.ar.attackerUnitId ? null : '攻方',
      defenderUnitId === state.ar.defenderUnitId ? null : '守方',
    ].filter((label): label is string => label !== null)
    combatState.value = { ...state, ar: { ...state.ar, attackerUnitId, defenderUnitId } }
    pushLog(
      'warning',
      `${cleared.join('、')}行动值（AR）单位已进死亡堆 ⇒ 本场战斗不再有${cleared.join('、')}领队` +
        '（9.6：AR 单位在掷骰前宣布，被消灭后无人接替；9.11c 的损失顺序与 9.13b-A 按剩余单位判）',
      '9.6',
    )
  }

  /**
   * 5.7d：防御方承受战斗结果后的**预备标记移除**
   *
   * 原文：「5.7d **接敌**。在**突袭或常规战斗中防御**时，如果承受了**任何类型的战斗结果**
   *   （**即使是被忽略的 Do1**），那么便要从堆叠中移除所有预备标记。这些单位**现在处于
   *   战斗或移动模式，由它们的朝向决定**（5.7a）。」
   *
   * ★ 修（2026-11-01）：修前没有这一条。后果是防御过的预备单位仍带预备标记 ——
   *   在本方反应阶段还能被"释放"并按 5.7b-B 以半 MA 移动，等于白赚一次反应阶段行动。
   *   `releasedFromReserve: false` 一并清掉：它只表示"本阶段刚释放"，不是预备状态的残留位。
   */
  function stripReserveMarkersAfterDefense(state: CombatInteractionState): void {
    const hex = state.composition.defendingHex
    for (const unit of units.value) {
      if (unit.mode.mode !== 'reserve') continue
      if (!sameHex(unit.hex, hex)) continue
      const orientation = unit.mode.orientation === 'move' ? 'move' : 'combat'
      unit.mode = { ...unit.mode, mode: orientation, releasedFromReserve: false }
      pushLog(
        'info',
        `${unit.name} 防御后移除预备标记 ⇒ ${orientation === 'move' ? '移动' : '战斗'}模式（5.7d）`,
        '5.7d',
      )
    }
  }

  /** C6：扣某单位若干点军力（9.12e 额外损失等；绝对值写回） */
  function takeCombatLoss(unitId: string, points: number): void {
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined) return
    applyCombatPatches([{ unitId, steps: Math.max(0, unit.steps - points) }])
  }

  /** C6：统一收引擎结论（失败即记 `combatError` 与日志并返回 null） */
  function acceptCombat<T>(outcome: RuleOutcome<T>, action: string): T | null {
    if (outcome.ok) {
      combatError.value = null
      return outcome.data
    }
    combatError.value = { rule: outcome.rule, reason: outcome.reason }
    pushLog('danger', `${action}被拒绝：${outcome.reason}（${outcome.rule}）`, outcome.rule)
    return null
  }

  /** C6：点选/取消一个攻方单位（9.1a 只有当前方；9.1b 可取堆叠的一部分；9.0 须与防御格相邻） */
  function toggleCombatAttacker(unitId: string): void {
    if (!canReplaceCombat()) return
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined) return
    if (unit.side !== activeSide.value) {
      pushLog('warning', '只有当前方的单位可以攻击（9.1a）', '9.1a')
      return
    }
    if (!unit.isCombat || !unit.attackCapable) {
      pushLog('warning', `${unit.name} 不可攻击（3.2b/9.1e）`, '9.1e')
      return
    }
    /*
     * 11.0a：进击阶段可以战斗的地面单位，只有进击模式单位与从预备模式中释放的单位。
     * 与 `participatesIn('exploitation.combat')` 同一条判据；此处拦下"地图直接点"这条旁路。
     */
    if (
      phase.value === 'exploitation' &&
      !unit.mode.exploit &&
      unit.mode.releasedFromReserve !== true
    ) {
      pushLog(
        'warning',
        `${unit.name} 不在进击模式且非已释放预备，本阶段不能战斗（11.0a）`,
        '11.0a',
      )
      return
    }
    const target = battleTarget.value
    if (target !== null && !areAdjacent(unit.hex, target.hex)) {
      pushLog(
        'warning',
        `${unit.name} 与防御格 ${hexLabel(target.hex)} 不相邻，不能攻击（9.0）`,
        '9.0',
      )
      return
    }
    if (combatAttackerIds.value.includes(unitId)) {
      combatAttackerIds.value = combatAttackerIds.value.filter((id) => id !== unitId)
      pushLog('info', `移出攻方：${unit.name}`)
    } else {
      /*
       * 9.1e：手动点选也拦在点击层（与自动带攻方 `attackersForHex` 同一条判据）。
       * 修前这里只拦 isCombat / attackCapable / 进击阶段 ⇒ 战略模式与未释放预备能手滑加进去，
       * 直到「开始战斗」才被引擎以 `stratCannotAttack:<id>` 打回并直出原因码。
       * 已在名单里的允许点掉（不拦截"移出"），避免模式变化后玩家反而选不回来。
       */
      const blocked = combatModeAttackBlocked(unit)
      if (blocked !== null) {
        pushLog(
          'warning',
          blocked === 'strat'
            ? `${unit.name} 处于战略模式，不能进攻（9.1e）`
            : `${unit.name} 是未释放的预备，不能进攻（9.1e）`,
          '9.1e',
        )
        return
      }
      combatAttackerIds.value = [...combatAttackerIds.value, unitId]
      pushLog(
        'info',
        `加入攻方：${unit.name}${target === null ? '（再点敌方格选定防御格）' : ''}`,
        '9.1b',
      )
    }
    selectedId.value = unitId
    combatState.value = null
    combatError.value = null
  }

  /**
   * C6：9.5b 减员 —— 补给步里勾选/取消参战攻方
   *
   * 与 `toggleCombatAttacker` 的区别：此时构成已锁定，本动作**只改玩家意图**，
   * 提交时由引擎 `planCombatSupply({ attackerUnitIds })` 校验子集合法性，不在此重置战斗状态。
   */
  function toggleCombatSupplyAttacker(unitId: string): void {
    if (!canReplaceCombat()) return
    /*
     * 9.5b 的原文是**减少参战单位**（composition 已由 9.1 锁定）⇒ 只允许在本场编成里增删。
     * 修前对任何己方算子都放行：点一枚编成外的单位会被塞进 `combatAttackerIds`，面板与 AR 候选
     * 都把它当参战，直到提交补给才被引擎以 9.5b `attackerNotInComposition` 拒绝（假入口）。
     */
    const composition = combatState.value?.composition.attackerIds ?? []
    if (!composition.includes(unitId)) {
      pushLog('warning', `${nameOf(unitId)} 不在本场编成里：9.5b 只能减少已参战的攻方`, '9.5b')
      return
    }
    if (combatAttackerIds.value.includes(unitId)) {
      if (combatAttackerIds.value.length <= 1) {
        pushLog('warning', '至少要保留一个参战单位（9.1b）', '9.5b')
        return
      }
      combatAttackerIds.value = combatAttackerIds.value.filter((id) => id !== unitId)
      // 被减掉的若是当前 AR 预选 ⇒ 预选回到新名单里的默认值（否则 AR 屏无金框、宣布被 9.6 拒）
      if (combatInputs.value.attackerArUnitId === unitId) {
        combatInputs.value = {
          ...combatInputs.value,
          attackerArUnitId: defaultArUnitIdOf('attacker', combatAttackerIds.value),
        }
      }
      pushLog('info', `移出参战：${nameOf(unitId)}（9.5b 减员）`, '9.5b')
      return
    }
    combatAttackerIds.value = [...combatAttackerIds.value, unitId]
    pushLog('info', `加入参战：${nameOf(unitId)}（9.5b）`, '9.5b')
  }

  /**
   * B15b：把地图上**某一格**的选择集**镜像**到战斗的参与集合（方案 §4.2）
   *
   * 「选择集就是后续动作的参与集合：战斗/炮击/补给/移动共用同一套「展开 + 选择」，
   *  不存在「面板里再选一次」」——地图上摊开的那一圈金色边框就是参与者名单。
   *
   * 语义是**逐格同步**（不是覆盖全局名单）：只把**该格**的单位按选择集增删，
   * 别格的参战单位原样保留（多格联合攻击时，玩家会分别在各格摊开选）。
   * 两步都落到既有的 `toggleCombatAttacker`（9.1 选攻方）/ `toggleCombatSupplyAttacker`（9.5b 减员）
   * —— 那两个动作各自带着自己的合法性（9.1a 归属 / 9.1e 可攻击 / 9.0 相邻 / 9.1b 至少留一枚），
   * 所以镜像**不会**绕过它们，也不会产生第二套判定。
   */
  function syncCombatParticipants(hex: HexRef, selectedIds: readonly string[]): void {
    const atHex = unitsAt(hex).filter((unit) => unit.side === activeSide.value)
    if (atHex.length === 0) return
    const locked = combatState.value !== null && combatState.value.step === 'combatSupply'
    for (const unit of atHex) {
      const wanted = selectedIds.includes(unit.instanceId)
      const has = combatAttackerIds.value.includes(unit.instanceId)
      if (wanted === has) continue
      if (locked) toggleCombatSupplyAttacker(unit.instanceId)
      else toggleCombatAttacker(unit.instanceId)
    }
  }

  /**
   * 11.0a：这一枚此刻能不能当**常规战斗**的攻方（自动取攻方 / 可攻击高亮 / 开战三处共用一条判据）
   *
   * 直接转调 `participatesIn`——进击段那里只放行「进击模式」与「已释放预备」，
   * 战斗段则照旧只要求可攻击 + 本环节未攻击过。修前自动路径只按 9.0/9.1 取人，
   * 于是进击段会把没有进击资格的单位一键收进编成（规则上不存在的战斗）。
   */
  function combatAttackerVerdict(unit: ConsoleUnit) {
    return participatesIn({
      unit,
      phase: phase.value,
      segment: segmentStep.value?.id ?? '',
      activeSide: activeSide.value,
      attackedUnitIds: attackedUnitIdsThisPhase.value,
    })
  }

  /** C6：选定防御格（9.0：只能攻击含敌方**战斗**单位的格；非战斗单位走 9.14 特殊战斗） */
  function selectCombatDefenderHex(hex: HexRef): boolean {
    if (!canReplaceCombat()) return false
    const atHex = unitsAt(hex)
    const enemyCombat = atHex.filter(
      (unit) => unit.side !== activeSide.value && unit.isCombat && unit.steps > 0,
    )
    if (enemyCombat.length === 0) {
      pushLog(
        'warning',
        atHex.length === 0
          ? `${hexLabel(hex)} 没有单位`
          : `${hexLabel(hex)} 没有敌方战斗单位：常规战斗不适用（9.0；非战斗单位走 9.14 特殊战斗）`,
        '9.0',
      )
      return false
    }
    // 9.0：已有攻方时，逐个复核与防御格的相邻性（不相邻者不得参战）
    const notAdjacent = combatAttackerIds.value.filter((id) => {
      const unit = units.value.find((item) => item.instanceId === id)
      return unit !== undefined && !areAdjacent(unit.hex, hex)
    })
    if (notAdjacent.length > 0) {
      pushLog(
        'warning',
        `已选攻方中 ${notAdjacent.map(nameOf).join('、')} 与 ${hexLabel(hex)} 不相邻（9.0）`,
        '9.0',
      )
      return false
    }
    if (combatAttackerIds.value.length === 0) {
      // 11.0a / 9.1b：自动取攻方也要过"本环节能不能战斗"（进击段只先进击/已释放预备）
      const auto = attackersForHex(units.value, hex, activeSide.value).filter(
        (unit) => combatAttackerVerdict(unit).ok,
      )
      if (auto.length === 0) {
        pushLog('warning', `没有与 ${hexLabel(hex)} 相邻的可攻击己方单位（9.0/9.1a）`, '9.1a')
        return false
      }
      combatAttackerIds.value = auto.map((unit) => unit.instanceId)
    }
    battleTarget.value = { hex, defenderIds: enemyCombat.map((unit) => unit.instanceId) }
    combatState.value = null
    combatError.value = null
    combatInputs.value.defenderTerrain = defaultDefenseTerrain(hex)
    combatInputs.value.stackTerrain = {}
    combatInputs.value.retreatPaths = {}
    pushLog(
      'info',
      `选定防御格 ${hexLabel(hex)}（守方 ${enemyCombat.length} 个战斗单位）；攻方 ${combatAttackerIds.value.length} 个`,
      '9.1',
    )
    return true
  }

  /**
   * 9.2 开战后的**公共段**（P1 合并：常规战斗与突袭只留一份）
   *
   * 两型在 `beginCombat` 之后的动作逐项相同：9.12f 快照 → 清骰 → 建输入 → AR 预填 →
   * 战斗补给可用量归零 → 默认防御地形 → 开战日志 → 记账。差别只有「日志文案」与
   * 「记账数据」，故由调用方给出；规则号与会话 `action` 由 `attackType` 定。
   *
   * ★ 突袭的**前置**（`moveInteraction` / `overrunContext` / ZOC 停车者 / 8.1g 参突 pin）
   *   差异太大，不并入本函数——那是「能否发起」的事，这里是「发起之后」的事。
   */
  function beginGroundAttack(input: {
    attackType: 'regular' | 'overrun'
    /** 防御格（默认防御地形取它） */
    hex: HexRef
    /** 开战日志文案（规则号按 attackType 取 9.1 / 8.0） */
    text: string
    /** 追加日志（如突袭的 8.1h 留驻说明），按顺序排在主日志之后、记账之前 */
    extraLogs?: readonly { text: string; rule: string }[]
    /** 会话记账数据（两型形状不同，由调用方给） */
    settlementData: Record<string, unknown>
  }): void {
    const rule = input.attackType === 'overrun' ? '8.0' : '9.1'
    // 9.12f：此刻即「战斗开始时」⇒ 拍快照（撤退穿越只认它）
    captureCombatStartSnapshot()
    combatSurpriseDie.value = null
    combatAwaitingShiftDie.value = false
    const inputs = createCombatInputs()
    /*
     * B30：行动值单位**预填为双方 AR 最高者**（9.6 的选择仍是玩家的动作 —— 面板可改，
     * 只是不再逼玩家从零挑一个）。放在这里而不是 UI：它是"盘面事实"的推导，且验证页同样受益。
     */
    inputs.attackerArUnitId = defaultArUnitIdOf('attacker')
    inputs.defenderArUnitId = defaultArUnitIdOf('defender')
    /*
     * 12.4 / 12.6：**战斗补给只能从己方补给站扣**（12.3a 直接拖取 / 12.3b HQ 投递）。
     * 除专规的补给储备标记（1.7 / 21.10：Shells 抵付炮击成本、Forage 在补给阶段提供追溯补给）外，
     * SP 不存在「凭空可用的池子」。故未声明来源时可用量为 **0**，由引擎按 12.4 裁决
     * （攻方付不出 ⇒ 不能攻击；守方付不出 ⇒ 以一半战斗值防御，9.5-B）。
     */
    inputs.attackerAvailableT = 0
    inputs.defenderAvailableT = 0
    /*
     * 12.4：来源声明属于**本场战斗**。可用量归零的同时必须把上一场的声明（ids / picks）也清掉，
     * 否则连续突袭（8.1a）时第二场会显示"来源已声明"、可用量却为 0 ⇒ 12.4 永远拒绝。
     */
    combatSupplyDumpIds.value = { attacker: null, defender: null }
    combatSupplyDumpPicks.value = { attacker: [], defender: [] }
    inputs.defenderTerrain = defaultDefenseTerrain(input.hex)
    combatInputs.value = inputs
    pushLog('info', input.text, rule)
    for (const entry of input.extraLogs ?? []) pushLog('info', entry.text, entry.rule)
    recordSettlement({
      action: input.attackType === 'overrun' ? 'overrun' : 'combatDeclare',
      rule,
      data: input.settlementData,
    })
  }

  /** C6 第 1 步：开始战斗（9.1 战斗构成） */
  function beginCombatNow(): boolean {
    if (!canReplaceCombat() || (barrageState.value !== null && !barrageState.value.finished))
      return false
    if (combatSupplyCommitted.value && combatState.value !== null && !combatState.value.finished) {
      combatError.value = { rule: '9.2', reason: '请先完成已经提交的战斗' }
      return false
    }
    if (!requireAction('combat.declare', '开始战斗')) return false
    const target = battleTarget.value
    if (target === null) {
      pushLog('warning', '尚未选定防御格（在「打一仗」工具下点敌方格）', '9.1')
      return false
    }
    if (phase.value !== 'combat' && phase.value !== 'exploitation') {
      const reason = `常规战斗只在战斗阶段与进击阶段的战斗环节进行（当前 ${PHASE_LABELS[phase.value]}，9.0）`
      combatError.value = { rule: '9.0', reason }
      pushLog('warning', reason, '9.0')
      return false
    }
    const attackers = combatAttackers.value
    if (attackers.length === 0) {
      pushLog('warning', '先点己方算子把它们加入攻方（9.1b）', '9.1b')
      return false
    }
    const defenders = battleDefenders.value
    if (defenders.length === 0) {
      pushLog('warning', '防御格内没有敌方战斗单位（9.0）', '9.0')
      battleTarget.value = null
      return false
    }
    // 9.0：攻击单位必须与被攻击的格相邻（引擎 9.1 构成不含此判据，故在此按规则拦下）
    const notAdjacent = attackers.filter((unit) => !areAdjacent(unit.hex, target.hex))
    if (notAdjacent.length > 0) {
      const reason = `攻击单位必须与被攻击的格相邻：${notAdjacent.map((unit) => unit.name).join('、')}`
      combatError.value = { rule: '9.0', reason }
      pushLog('warning', `${reason}（9.0）`, '9.0')
      return false
    }
    const composition = acceptCombat(
      beginCombat({
        attackers: attackers.map((unit) => toBattleUnitView(unit, turn.value)),
        defenders: defenders.map((unit) => toBattleUnitView(unit, turn.value)),
        facts: combatFacts.value,
        attackType: 'regular',
        phase: phase.value,
      }),
      '战斗构成',
    )
    if (composition === null) return false
    combatState.value = composition
    beginGroundAttack({
      attackType: 'regular',
      hex: target.hex,
      text:
        `开始战斗（9.2 第 1 步）：攻方 ${attackers.length} 个 → 防御格 ${hexLabel(target.hex)}` +
        `（守方 ${defenders.length} 个）。请确认战斗补给（9.5/12.4）`,
      settlementData: {
        attackType: 'regular',
        targetHex: { ...target.hex },
        attackerIds: attackers.map((unit) => unit.instanceId),
        defenderIds: defenders.map((unit) => unit.instanceId),
        step: composition.step,
      },
    })
    return true
  }

  /**
   * 12.4：攻方本场要付的 T（按当前参战名单；9.5b 减员后只剩名单内的单位）
   */
  const combatAttackerRequiredT = computed<number>(() => {
    const ids = combatAttackerIds.value
    return combatAttackerViews.value
      .filter((unit) => ids.includes(unit.id))
      .reduce((sum, unit) => sum + unit.steps, 0)
  })

  /** 12.4：守方本场要付的 T（每场战斗 2T，≤1 RE 取 1T） */
  const combatDefenderRequiredT = computed<number>(
    () =>
      computeCombatSupplyCost({
        attackerSteps: 0,
        defenderRE: combatDefenderViews.value.reduce((sum, unit) => sum + unit.re, 0),
      }).defenderT,
  )

  /**
   * 剧本级：攻方不得动用部队储备（12.10；Intro: Vitebsk 剧本页明文）
   *
   * 剧本级规则，不改 12.10 全局：只在本剧本关掉战斗补给窗里的「攻方用储备」。
   */
  const attackerInternalsForbidden = computed<boolean>(() => {
    const stated = scenarios.scenarios.find((item) => item.id === scenarioId.value)?.setup
      .attackerInternalsForbidden
    return stated === true
  })

  /**
   * 12.10a：**部队储备**这一项是否适用（不适用就不出现在窗内）
   *
   * 原文：只有该单位"无法从图上补给（直接拖取或 HQ 投递）取得所需 SP"时才可用储备。
   * 这里与引擎 `planCombatSupplyFunding` 同一判据：图上可用 T 已够全额 ⇒ 储备不适用；
   * 已耗尽（12.10c）的单位也不能再用 ⇒ 若全方都耗尽，这一项也不出现。
   */
  const combatAttackerStocksApplicable = computed<boolean>(() => {
    // 剧本页明示禁令 ⇒ 本剧本不出现该项（按「不可用项不出现」的规矩，不置灰）
    if (attackerInternalsForbidden.value) return false
    const ids = combatAttackerIds.value
    const views = combatAttackerViews.value.filter((unit) => ids.includes(unit.id))
    return (
      combatAttackerRequiredT.value > combatInputs.value.attackerAvailableT &&
      views.some((unit) => unit.internalStocks !== 'exhausted')
    )
  })
  const combatDefenderStocksApplicable = computed<boolean>(() => {
    if (!combatInputs.value.defenderProvides) return false
    /*
     * 12.10a 原文：只有单位**无法**经直接拖取（12.3a）或 HQ 投递（12.3b）从图上取得所需 SP
     * 时才可用储备。故这里不看"玩家已点选那座站的 T"，而看**守方全部可达来源**里有没有
     * 任何一座能单座付足（12.4 的守方需求是一次性整笔）。
     * 12.10a 的括注例外保留：唯一够额的那座是**编内卡车**上的 SP ⇒ 仍可出现储备行。
     */
    const needT = combatDefenderRequiredT.value
    const reachable = combatSupplyDumps.value.find((item) => item.side === 'defender')?.dumps ?? []
    const payableFromMap = reachable.some(
      (dump) =>
        dump.carrierIsOrganicTruck !== true && holdingsToT({ sp: dump.sp, t: dump.t }) >= needT,
    )
    return (
      !payableFromMap &&
      combatDefenderViews.value.some((unit) => unit.internalStocks !== 'exhausted')
    )
  })

  /**
   * 9.5（热座）：确认某一方的补给（只翻标记，不落盘）
   *
   * 真正的付款仍由共用出口 `confirmCombatSupply()` 一次校验、一次原子扣款；
   * 两侧都确认后界面才给共用出口，避免一方确认就把整步推过去。
   */
  function confirmCombatSupplySide(side: CombatRole): boolean {
    const state = combatState.value
    if (state === null || state.step !== 'combatSupply') return false
    const confirmed = combatInputs.value.supplyConfirmed
    // B4：先翻成「已确认」再把缺来源推给「进入行动值」＝误导性的死路，故确认这一步就拦。
    if (!confirmed[side]) {
      const blocker = combatSupplyConfirmBlocker(side)
      if (blocker !== null) {
        combatError.value = blocker
        pushLog('warning', ruleErrorTextOf(blocker), blocker.rule)
        return false
      }
    }
    combatError.value = null
    combatInputs.value = {
      ...combatInputs.value,
      supplyConfirmed: { ...confirmed, [side]: !confirmed[side] },
    }
    return true
  }

  /**
   * B4（用户 2026-11-17）：逐方确认前的**付款来源**闸门（9.5 / 12.4）
   *
   * 只拦「这一方根本没有付款来源」：图上声明 0 T 且未动用部队储备（守方还须已声明支付）。
   * 有来源但付不清整笔（余额不足 / 逐单位分配不出）仍由共用出口 `confirmCombatSupply()`
   * 一次裁决并给出逐单位原因——这里只避免先显示「已确认」、再把错误推给下一步。
   */
  function combatSupplyConfirmBlocker(side: CombatRole): { rule: string; reason: string } | null {
    const useStocks =
      side === 'attacker'
        ? combatInputs.value.attackerUsesInternalStocks && !attackerInternalsForbidden.value
        : combatInputs.value.defenderUsesInternalStocks && combatDefenderStocksApplicable.value
    if (useStocks) return null
    // 9.5-B：守方选择不支付＝以一半战斗值防御，无来源本来就能确认
    if (side === 'defender' && !combatInputs.value.defenderProvides) return null
    const available =
      side === 'attacker'
        ? combatInputs.value.attackerAvailableT
        : combatInputs.value.defenderAvailableT
    if (available > 0) return null
    if (side === 'attacker') {
      return {
        rule: '12.4',
        reason: `攻方战斗补给：来源为「—」，本场共需 ${combatAttackerRequiredT.value} T —— 先在地图上点补给站付款，或勾「攻方用储备」（12.4 / 12.10）`,
      }
    }
    return {
      rule: '12.4',
      reason: `守方已声明支付，但来源为「—」：本场需 ${combatDefenderRequiredT.value} T —— 先在地图上点补给站付款；不付请取消「守方支付」，以一半战斗值防御（9.5-B）`,
    }
  }

  // 任一方改自己的输入 ⇒ 撤销该方确认；攻方改动连带撤销守方（守方看到的是改前的攻方来源）
  watch(
    () =>
      `${combatInputs.value.attackerAvailableT}|${combatInputs.value.attackerUsesInternalStocks}|${combatAttackerIds.value.join(',')}`,
    () => {
      const confirmed = combatInputs.value.supplyConfirmed
      if (!confirmed.attacker && !confirmed.defender) return
      combatInputs.value = {
        ...combatInputs.value,
        supplyConfirmed: { attacker: false, defender: false },
      }
    },
    { flush: 'sync' },
  )
  watch(
    () =>
      `${combatInputs.value.defenderAvailableT}|${combatInputs.value.defenderProvides}|${combatInputs.value.defenderUsesInternalStocks}`,
    () => {
      if (!combatInputs.value.supplyConfirmed.defender) return
      combatInputs.value = {
        ...combatInputs.value,
        supplyConfirmed: { ...combatInputs.value.supplyConfirmed, defender: false },
      }
    },
    { flush: 'sync' },
  )

  /** C6 第 2 步：确认战斗补给（9.5/12.4；守方可拒付 ⇒ 以一半战斗值防御） */
  function confirmCombatSupply(): boolean {
    const state = combatState.value
    if (state === null) return false
    // 9.5b：付不出全额时可减少参战单位（界面通过勾选攻方实现）
    const reduced = combatAttackerIds.value.filter((id) =>
      state.composition.attackerIds.includes(id),
    )
    const useReduction = reduced.length > 0 && reduced.length < state.composition.attackerIds.length

    /*
     * 12.10：**先算"图上 + 可动用部队储备"能凑多少**，再把它喂给引擎。
     *
     * 次序很重要：引擎的 9.5/12.4 判据（`battleCombatSupply`）看到 `attackerAvailableT` 不足
     * 整笔就拒（12.4「无法满足完整战斗补给消耗要求的单位无法攻击」），所以"动用储备"这件事
     * **必须体现在喂进去的可用量里**——否则勾了也会被引擎先挡掉。
     *
     * 逐单位定"图上付 / 储备付"由引擎的 `planCombatSupplyFunding` 给结论（12.10a/b/c/g/h 都在
     * 那里，含规则书的两个例子）；本处只做两件事：① 把总额喂给引擎；② 引擎接受后按结论落盘。
     */
    const useAttackerStocks =
      combatInputs.value.attackerUsesInternalStocks && !attackerInternalsForbidden.value
    const attackerPlan = useAttackerStocks
      ? planCombatSupplyFunding({
          units: combatAttackerViews.value.map((unit) => ({
            unitId: unit.id,
            requiredT: unit.steps,
            internalStocks: unit.internalStocks ?? null,
          })),
          availableMapT: combatInputs.value.attackerAvailableT,
        })
      : null
    if (attackerPlan !== null && !attackerPlan.ok) {
      pushLog(
        'danger',
        `攻方动用部队储备被拒：${attackerPlan.reason}（${attackerPlan.rule}）`,
        attackerPlan.rule,
      )
      combatError.value = { rule: attackerPlan.rule, reason: attackerPlan.reason }
      return false
    }
    const attackerEffectiveT =
      attackerPlan === null
        ? combatInputs.value.attackerAvailableT
        : attackerPlan.data.funding.reduce((sum, item) => sum + item.t, 0)

    const defenderViews = combatDefenderViews.value
    const defenderRequiredT = combatDefenderRequiredT.value
    /*
     * 12.4：守方需求是**整笔**（2T；≤1 RE 时 1T），但 12.10b/12.10d 的降级是**逐单位**的。
     * 修前把整笔 2T 记在 `defenderViews.slice(0, 1)` 名下 ⇒ 两枚以上堆叠只降首枚；
     * 那等于其余单位借用首枚的部队储备，12.10d 明禁（"即使是堆叠在一起也不行"）。
     * 现在把**整堆叠每一枚**交给守方专用计划：储备路径下每枚各用自己的储备、各降一级。
     */
    const defenderPlan =
      combatInputs.value.defenderUsesInternalStocks && combatInputs.value.defenderProvides
        ? planDefenderCombatSupplyFunding({
            units: defenderViews.map((unit) => ({
              unitId: unit.id,
              internalStocks: unit.internalStocks ?? null,
            })),
            requiredT: defenderRequiredT,
            availableMapT: combatInputs.value.defenderAvailableT,
          })
        : null
    if (defenderPlan !== null && !defenderPlan.ok) {
      pushLog(
        'danger',
        `守方动用部队储备被拒：${defenderPlan.reason}（${defenderPlan.rule}）`,
        defenderPlan.rule,
      )
      combatError.value = { rule: defenderPlan.rule, reason: defenderPlan.reason }
      return false
    }
    const defenderEffectiveT =
      defenderPlan === null
        ? combatInputs.value.defenderAvailableT
        : defenderPlan.data.funding.some((item) => item.source === 'stocks')
          ? // 12.10b：储备替代的是守方整笔战斗补给 ⇒ 对 9.5 而言守方已获补给
            defenderRequiredT
          : defenderPlan.data.mapTUsed

    /*
     * 12.4：原文**没有**要求多方/多单位必须同源（10.1b-A 的同源只约束炮击）。
     * 因此落账时按「每座已选站各自持有多少 T」+「单位各自拖得到哪座站」逐单位分配；
     * 一个单位只从一座站付（12.3a/12.3b），不同单位可以用不同站。
     */
    const picksFor = (side: CombatRole): SpDump[] => {
      const ids = combatSupplyDumpPicks.value[side]
      const fallback = combatSupplyDumpIds.value[side]
      const wanted = ids.length > 0 ? ids : fallback === null ? [] : [fallback]
      return wanted
        .map((id) => allSpDumps.value.find((item) => item.id === id))
        .filter((item): item is SpDump => item !== undefined)
    }

    /**
     * 12.4 / 12.3a：把每个参战单位逐一落到**一座**它拖得到、且余额够的已选站上
     *
     * 每个单位一次只能从一座站取满（12.3a），但**不同单位可以用不同的站** ⇒ 这是"单位 → 站"的
     * 装箱问题，**不能用先到先得**：名单顺序 2/2/3/3、已选两座各 5T 时，先到先得会把两枚 2 都
     * 塞进第一座（剩 1），最后一枚 3 无处可取 ⇒ 整笔被判付不清。而引擎的 12.4 只按**总额**判
     * （10 ≥ 10）已经放行，于是界面既不报红字、账也不扣、步也不进（用户实测的多攻方形态）。
     * 规模很小（一叠参战单位 × 数座已选站），用回溯求一个可行分配。
     */
    function assignDumpsToUnits(
      side: CombatRole,
      payees: readonly { unitId: string; needT: number }[],
    ): Map<string, string> | null {
      const assignment = new Map<string, string>()
      if (payees.length === 0) return assignment
      const dumps = picksFor(side)
      const capacity = new Map<string, number>()
      for (const dump of dumps) capacity.set(dump.id, holdingsToT({ sp: dump.sp, t: dump.t }))
      const legal = new Map<string, string[]>()
      for (const payee of payees) {
        const unit = units.value.find((item) => item.instanceId === payee.unitId)
        if (unit === undefined) return null
        const drawable = new Set(deliverableDumpsFor(unit.side, [unit]).map((dump) => dump.id))
        legal.set(
          payee.unitId,
          dumps.filter((dump) => drawable.has(dump.id)).map((dump) => dump.id),
        )
      }
      const order = [...payees].sort((a, b) => b.needT - a.needT)
      const walk = (index: number): boolean => {
        if (index === order.length) return true
        const payee = order[index]!
        const candidates = (legal.get(payee.unitId) ?? [])
          .filter((id) => (capacity.get(id) ?? 0) >= payee.needT)
          // 先紧后松：余额刚好够的先试，把宽裕的站留给后面的大需求
          .sort((a, b) => (capacity.get(a) ?? 0) - (capacity.get(b) ?? 0))
        for (const dumpId of candidates) {
          capacity.set(dumpId, (capacity.get(dumpId) ?? 0) - payee.needT)
          assignment.set(payee.unitId, dumpId)
          if (walk(index + 1)) return true
          capacity.set(dumpId, (capacity.get(dumpId) ?? 0) + payee.needT)
          assignment.delete(payee.unitId)
        }
        return false
      }
      return walk(0) ? assignment : null
    }

    /*
     * 12.4：喂给引擎的"可用量"必须与**真正付得清的额度**一致，否则会出现
     * 「引擎按总额放行 → 逐单位分配付不出 ⇒ 静默失败」。这里先求分配，再让引擎裁决；
     * 分配不出来就把原因写成红字（12.4）与结算日志，不再"点了没反应"。
     */
    const attackerPayees = (
      attackerPlan === null
        ? (useReduction
            ? combatAttackerViews.value.filter((unit) => reduced.includes(unit.id))
            : combatAttackerViews.value
          ).map((unit) => ({ unitId: unit.id, needT: unit.steps }))
        : attackerPlan.data.funding
            .filter((item) => item.source === 'map' && item.t > 0)
            .map((item) => ({ unitId: item.unitId, needT: item.t }))
    ).filter((payee) => payee.needT > 0)
    const attackerAssignment = assignDumpsToUnits('attacker', attackerPayees)
    if (attackerAssignment === null) {
      const detail = attackerPayees
        .map((payee) => `${nameOf(payee.unitId)} 需 ${payee.needT} T`)
        .join('、')
      pushLog(
        'danger',
        `战斗补给：已选来源付不清这些单位——${detail}；每个单位只能从一座它拖得到的站取满（12.4/12.3a）。` +
          '再点一座站，或用 9.5b 减少参战单位',
        '12.4',
      )
      combatError.value = { rule: '12.4', reason: 'attackSupplyNotFull' }
      return false
    }

    const data = acceptCombat(
      planCombatSupply(state, {
        attackers: combatAttackerViews.value,
        defenders: combatDefenderViews.value,
        attackerAvailableT: attackerEffectiveT,
        defenderProvides: combatInputs.value.defenderProvides,
        defenderAvailableT: defenderEffectiveT,
        ...(useReduction ? { attackerUnitIds: reduced } : {}),
      }),
      '战斗补给',
    )
    if (data === null) return false
    const supply = data.state.supply!

    /*
     * 12.4 / 12.6：**攻守各自付款，且扣款只能落在己方补给站上**。
     *
     * 12.3a 直接拖取 / 12.3b HQ 投递是仅有的两条取补途径；除专规的补给储备标记
     * （1.7 / 21.10 的 Shells 与 Forage，各由引擎的专用动作处理）外，SP 不存在
     * 「凭空可用的池子」——共用演示池不得充作战斗补给的付款来源。
     *
     * 原先这里从 `fuelPool` 扣并带 `Math.max(0, …)` 夹断：声明了来源却不动它
     * （同一座站可反复"支付"），池子不够时又夹到 0（**攻击照样通过＝免费攻击**）。
     * 现在：**先全部校验、再一次性落盘**（避免只扣一半的半截状态），不足即整笔拒绝。
     */
    type CombatNeed = { dumpId: string; side: CombatRole; wantT: number; unitIds: Set<string> }
    const needs = new Map<string, CombatNeed>()
    const addNeed = (
      dumpId: string,
      side: CombatRole,
      wantT: number,
      unitIds: Iterable<string>,
    ): void => {
      if (wantT <= 0) return
      const current = needs.get(dumpId)
      if (current === undefined) {
        needs.set(dumpId, { dumpId, side, wantT, unitIds: new Set(unitIds) })
        return
      }
      current.wantT += wantT
      for (const id of unitIds) current.unitIds.add(id)
    }

    const remainingT = new Map<string, number>()
    for (const dump of [...picksFor('attacker'), ...picksFor('defender')]) {
      if (!remainingT.has(dump.id)) {
        remainingT.set(dump.id, holdingsToT({ sp: dump.sp, t: dump.t }))
      }
    }

    /** 一次性需求（守方整场 2T / 12.10h 浪费）不按单位拆，落在任一已选站的余额上 */
    const allocateLump = (side: CombatRole, wantT: number, unitIds: Iterable<string>): boolean => {
      if (wantT <= 0) return true
      const ids = [...unitIds]
      for (const dump of picksFor(side)) {
        if ((remainingT.get(dump.id) ?? 0) < wantT) continue
        remainingT.set(dump.id, (remainingT.get(dump.id) ?? 0) - wantT)
        addNeed(dump.id, side, wantT, ids)
        return true
      }
      pushLog(
        'danger',
        `战斗补给：${side === 'attacker' ? '攻方' : '守方'}合计需要 ${wantT} T，已选来源余额不足（12.4）`,
        '12.4',
      )
      combatError.value = {
        rule: '12.4',
        reason: `战斗补给：${side === 'attacker' ? '攻方' : '守方'}合计需要 ${wantT} T，已选来源余额不足`,
      }
      return false
    }

    /*
     * 攻方逐单位落账：用前段求得的**可行分配**（不是先到先得），
     * 这样"2/2/3/3 + 两座各 5T"这类付得清的组合不会再被分配顺序卡死。
     */
    for (const payee of attackerPayees) {
      const dumpId = attackerAssignment.get(payee.unitId)
      if (dumpId === undefined) {
        pushLog('danger', `战斗补给：找不到付款单位 ${payee.unitId}（12.4）`, '12.4')
        combatError.value = { rule: '12.4', reason: '战斗补给：找不到付款单位（12.4）' }
        return false
      }
      remainingT.set(dumpId, (remainingT.get(dumpId) ?? 0) - payee.needT)
      addNeed(dumpId, 'attacker', payee.needT, [payee.unitId])
    }
    if (attackerPlan !== null) {
      const assignedT = attackerPayees.reduce((sum, payee) => sum + payee.needT, 0)
      // 12.10h：凑不满任何单位的图上 T 会被一并消耗（引擎计入 mapTUsed）
      if (
        !allocateLump(
          'attacker',
          attackerPlan.data.mapTUsed - assignedT,
          combatAttackers.value.map((unit) => unit.instanceId),
        )
      ) {
        return false
      }
    }
    const defenderMapT =
      defenderPlan === null
        ? supply.defender.paid
          ? supply.defender.requiredT
          : 0
        : defenderPlan.data.mapTUsed
    if (
      !allocateLump(
        'defender',
        defenderMapT,
        combatDefenderViews.value.map((unit) => unit.id),
      )
    ) {
      return false
    }

    const settled: { dumpId: string; after: SpHoldings }[] = []
    for (const need of needs.values()) {
      const holdings = allSpDumps.value.find((item) => item.id === need.dumpId) ?? null
      if (holdings === null) {
        pushLog('danger', '战斗补给付款失败：声明的补给站已不存在（12.1b）', '12.4')
        combatError.value = { rule: '12.1b', reason: '战斗补给付款失败：声明的补给站已不存在' }
        return false
      }
      /*
       * 3.4b：错误集群的 SP 不能支付**多单位编队**的战斗成本。
       * 受益方＝这一笔实际分配到该站的单位（12.4 多源后不再是"整方一堆"）。
       */
      const beneficiaries =
        need.unitIds.size > 0
          ? [...need.unitIds]
          : need.side === 'attacker'
            ? combatAttackers.value.map((unit) => unit.instanceId)
            : (battleTarget.value?.defenderIds ?? [])
      const restricted = panzerGroupSpGate({
        dumpId: need.dumpId,
        purpose: 'combat',
        beneficiaryUnitIds: beneficiaries,
      })
      if (restricted !== null) {
        const refusal = panzerGroupSpRefusal(restricted, '战斗', need.dumpId)
        pushLog('danger', `战斗补给付款被拒（3.4b）：${refusal}——本次不改动任何账本`, '3.4b')
        combatError.value = { rule: '3.4b', reason: refusal }
        return false
      }
      const payment = planSpPayment({
        holdings: { sp: holdings.sp, t: holdings.t },
        wantT: need.wantT,
      })
      if (!payment.ok) {
        pushLog(
          'danger',
          `战斗补给付不出 ${need.wantT} T：${payment.reason}（${payment.rule}）——本次不改动任何账本`,
          payment.rule,
        )
        combatError.value = {
          rule: payment.rule,
          reason: `战斗补给：所选来源付不出 ${need.wantT} T`,
        }
        return false
      }
      settled.push({ dumpId: need.dumpId, after: payment.data.holdingsAfter })
    }
    for (const item of settled) setSpDumpHoldings(item.dumpId, item.after)
    combatState.value = data.state
    if (useReduction) combatAttackerIds.value = [...data.state.composition.attackerIds]

    // 12.10b：动用储备的单位降一级（ready→low、low→exhausted）——落盘在图上扣款之后
    for (const plan of [attackerPlan?.data ?? null, defenderPlan?.data ?? null]) {
      if (plan === null) continue
      for (const item of plan.funding) {
        if (item.source !== 'stocks' || item.to === null) continue
        const unit = units.value.find((entry) => entry.instanceId === item.unitId)
        if (unit === undefined) continue
        unit.internalStocks = item.to
      }
      pushLog('info', `12.10 部队储备：${plan.detail}`, plan.rule)
    }

    pushLog(
      'success',
      `战斗补给（9.5/12.4）：攻方付 ${supply.attacker.requiredT} T；守方` +
        (supply.defender.paid
          ? `付 ${supply.defender.requiredT} T`
          : '选择不付 ⇒ 以一半战斗值防御（9.5-B）'),
      '9.5',
    )
    // ⑭ 接线：战斗补给（9.5 / 12.4）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'combatSupply',
      rule: '9.5',
      data: {
        attackerRequiredT: supply.attacker.requiredT,
        defenderPaid: supply.defender.paid,
        defenderRequiredT: supply.defender.requiredT,
        attackerUnitIds: [...data.state.composition.attackerIds],
      },
    })
    /*
     * 9.1c 记账：走到这里＝战斗补给这一关过了 ⇒ 这一仗"打出去了"。
     * 之所以**不在宣布时**就记：9.5b 允许付不出时「减少参战单位 / 用部队储备 / **根本不攻击**」，
     * 那份作废的战斗不该占掉本环节的这一次（与 10.1b 的轰炸账本同一时点口径）。
     */
    recordAttackThisSegment(data.state.composition.attackerIds, data.state.composition.defendingHex)
    /*
     * K5：这里**不再**锚定撤销边界。9.5b 允许在补给步减员/根本不攻击，且 `kind:'overrun'` 这一步
     * 要到 9.12g 推进收束（`applyOverrunMove`）才进 interaction；此时 `steps.length` 少 1，
     * 锚早了会让收束后的「撤销一步」放行（只还原位置/MP，战损与补给不回滚）。
     * 锚点移到 `settleOverrunPlan` 落盘之后——那里 interaction 已含突袭步。
     */
    return true
  }

  /** C6 第 3 步：宣布行动值（9.6：攻方先、守方后；每方只能选一个参战单位） */
  function declareCombatArStep(side: CombatRole): boolean {
    const state = combatState.value
    if (state === null) return false
    const inputs = combatInputs.value
    if (inputs.attackerArUnitId === null) {
      pushLog('warning', '先选择攻方的行动值单位（9.6）', '9.6')
      return false
    }
    if (side === 'attacker') {
      const pending = acceptCombat(
        declareCombatAr(state, {
          attackers: combatAttackerViews.value,
          defenders: combatDefenderViews.value,
          attackerUnitId: inputs.attackerArUnitId,
        }),
        '攻方宣布行动值',
      )
      if (pending === null) return false
      combatState.value = pending.state
      pushLog(
        'info',
        `攻方宣布行动值单位：${nameOf(inputs.attackerArUnitId)}（9.6：按规则由守方后宣布）`,
        '9.6',
      )
      // ⑭ 接线：攻方宣布行动值（9.6，前半）入会话日志（本笔不掷骰）
      recordSettlement({
        action: 'combatAr',
        rule: '9.6',
        data: {
          side: 'attacker',
          attackerArUnitId: inputs.attackerArUnitId,
          step: pending.state.step,
        },
      })
      return true
    }
    if (inputs.defenderArUnitId === null) {
      pushLog('warning', '先选择守方的行动值单位（9.6）', '9.6')
      return false
    }
    if (state.declaredAttackerArUnitId === undefined) {
      combatError.value = { rule: '9.6', reason: 'attackerArMustBeDeclaredFirst' }
      return false
    }
    // 专规 2.3b：守方堆叠内有 NKVD 边防团时，它**必须**担任行动值单位
    const nkvdCheck = checkDefenderArChoice(
      combatDefenderViews.value.map(toNkvdDefenseView),
      inputs.defenderArUnitId,
    )
    if (!nkvdCheck.ok) {
      combatError.value = { rule: nkvdCheck.rule, reason: nkvdCheck.reason }
      pushLog(
        'danger',
        `守方行动值单位被拒：${nkvdCheck.reason}（${nkvdCheck.rule}：NKVD 边防团被攻击时必须担任行动值单位）`,
        nkvdCheck.rule,
      )
      return false
    }
    if (nkvdCheck.data.forced) {
      pushLog(
        'warning',
        `${nameOf(inputs.defenderArUnitId)} 担任行动值单位（专规 2.3b：NKVD 边防团被攻击时必须担任）；代价是**所有防御选项都须当作损失吃下**`,
        '专规 2.3b',
      )
    }
    const data = acceptCombat(
      declareCombatAr(state, {
        attackers: combatAttackerViews.value,
        defenders: combatDefenderViews.value,
        attackerUnitId: inputs.attackerArUnitId,
        defenderUnitId: inputs.defenderArUnitId,
      }),
      '守方宣布行动值',
    )
    if (data === null) return false
    combatState.value = data.state
    const ar = data.state.ar!
    pushLog(
      'success',
      `行动值（9.6）：攻方 ${ar.attackerAr} − 守方 ${ar.defenderAr} ⇒ DRM ${ar.drm}`,
      '9.6',
    )
    // ⑭ 接线：双方行动值宣布（9.6）入会话日志（本笔不掷骰；NKVD 强制见专规 2.3b）
    recordSettlement({
      action: 'combatAr',
      rule: '9.6',
      data: {
        side: 'defender',
        attackerArUnitId: inputs.attackerArUnitId,
        defenderArUnitId: inputs.defenderArUnitId,
        attackerAr: ar.attackerAr,
        defenderAr: ar.defenderAr,
        drm: ar.drm,
        nkvdForced: nkvdCheck.data.forced,
      },
    })
    return true
  }

  /** C6 第 4 步：宣布地形并确定初始攻防比（9.4b 逐堆叠 / 9.4c 守方格 / 9.7） */
  /**
   * B30：**地形确认之后自动连跑到战果**（用户口径 #19）
   *
   * 「选中 AR 之后选地形也是玩家操作，但是**攻防比 / 奇袭 / 战斗骰**这三步是骰子和查表，做成自动的」
   * ⇒ 本函数依次调既有的**单一实现**（不另写一套规则）：
   *   `declareCombatTerrainStep`（含 9.7 的初始攻防比）→ `rollCombatSurprise`（9.8；出奇袭时自动补横移骰）
   *   → `rollCombatDice`（9.9），停在 **`losses`（战果）** 步等玩家分配与选项。
   *
   * 骰面一律走种子化 `rng`（B28 的口径），结算日志可复算；任何一步被拒即**就地停下并保留原因**
   * （`combatError` + 日志），不会把状态推成半截。
   */
  function autoResolveCombatToOutcome(): boolean {
    const state = combatState.value
    if (state === null) return false
    if (state.step === 'declareAr') return false
    if (state.step === 'declareTerrain' && !declareCombatTerrainStep()) return false
    // 9.8：奇袭（含"发生奇袭 ⇒ 再掷横移骰"的那一次补掷）
    if (combatState.value?.step === 'surprise') {
      if (!rollCombatSurprise()) return false
      if (combatAwaitingShiftDie.value && !rollCombatShiftDie()) return false
    }
    // 9.9：战斗骰
    if (combatState.value?.step === 'battleDice' && !rollCombatDice()) return false
    // 零点数的损失 / 选项、无对象的撤退 ⇒ 不停在只有一个「确认」的空屏上
    settlePassiveCombatSteps()
    return true
  }

  function declareCombatTerrainStep(): boolean {
    const state = combatState.value
    if (state === null) return false
    const target = battleTarget.value
    if (target === null) return false
    const stackChoices: StackTerrainChoice[] = []
    for (const [key, choice] of Object.entries(combatInputs.value.stackTerrain)) {
      const [colText, rowText] = key.split('.')
      const col = Number(colText)
      const row = Number(rowText)
      if (!Number.isInteger(col) || !Number.isInteger(row)) continue
      stackChoices.push({ hex: { col, row }, kind: choice.kind, terrain: choice.terrain })
    }
    const data = acceptCombat(
      declareCombatTerrain(state, {
        attackers: combatAttackerViews.value,
        defenders: combatDefenderViews.value,
        facts: combatFacts.value,
        ...(stackChoices.length === 0 ? {} : { stackChoices }),
        defenderTerrain:
          combatInputs.value.defenderTerrain === ''
            ? defaultDefenseTerrain(target.hex)
            : combatInputs.value.defenderTerrain,
        // 专规 4.2b（可选）：4 步轴心步兵师末步攻 ×1/4、守 ×1/2（未启用＝原值）
        ...(session.rule4On('effectsOfLosses') ? { effectsOfLosses: true } : {}),
      }),
      '地形宣布',
    )
    if (data === null) return false
    combatState.value = data.state
    const odds = data.state.odds!
    pushLog(
      'success',
      `地形（9.4）：守方格 ${odds.terrain.defenderTerrain}（${odds.terrain.combatLine}）；` +
        `军力 ${odds.attackerTotal}（${odds.attackerStrengthById
          .map((item) => `${nameOf(item.unitId)} ${item.strength}`)
          .join('、')}）: ${odds.defenderTotal}（${odds.defenderStrengthById
          .map((item) => `${nameOf(item.unitId)} ${item.strength}`)
          .join('、')}）⇒ ${odds.oddsLabel}`,
      '9.4',
    )
    // ⑭ 接线：地形宣布与初始攻防比（9.4 / 9.7）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'combatTerrain',
      rule: '9.4',
      data: {
        defenderTerrain: odds.terrain.defenderTerrain,
        combatLine: odds.terrain.combatLine,
        attackerTotal: odds.attackerTotal,
        defenderTotal: odds.defenderTotal,
        oddsLabel: odds.oddsLabel,
      },
    })
    return true
  }

  /**
   * C6：把奇袭结论写进日志（9.8；附 W7 C11 的复核过程）
   *
   * ⑭ 接线：`rolls` 由调用方传入本步**真实掷出**的骰子（奇袭 2d6 或横移 1d6），
   * 避免用 `combatSurpriseRoll`/`combatShiftRoll` 这两个跨场残留的展示缓存拼骰面。
   */
  function logCombatSurprise(state: CombatInteractionState, rolls: readonly DiceRoll[]): void {
    const surprise = state.surprise
    if (surprise === undefined) return
    const derivation = surpriseDerivation({
      roll: combatSurpriseRoll.value,
      die: combatSurpriseDie.value ?? 0,
      arDifferential: state.ar?.drm ?? 0,
      defenderInHedgehog: state.defenderInHedgehog,
      side: surprise.side,
      shiftRoll: combatShiftRoll.value,
      shift: surprise.shift,
    })
    if (surprise.side === null) {
      pushLog(
        'info',
        `奇袭判定（9.8）：无奇袭；列位 ${surprise.finalColumnLabel}`,
        '9.8',
        derivation,
      )
      // ⑭ 接线：奇袭判定（9.8，无奇袭）入会话日志；rolls＝本步真实掷出的骰子
      recordSettlement({
        action: 'combatSurprise',
        rule: '9.8',
        rolls: [...rolls],
        data: {
          [DERIVATION_KEY]: derivation,
          side: null,
          finalColumnLabel: surprise.finalColumnLabel,
        },
      })
      return
    }
    pushLog(
      'success',
      `奇袭（9.8）：${roleLabel(surprise.side === 'attacker' ? 'attacker' : 'defender')}奇袭，` +
        `横移 ${surprise.shift >= 0 ? '+' : ''}${surprise.shift} 列 ⇒ ${surprise.finalColumnLabel}` +
        `${surprise.clamped ? '（超出表范围，按 9.1g 取端列）' : ''}`,
      '9.8',
      derivation,
    )
    // ⑭ 接线：奇袭判定（9.8，含横移）入会话日志；rolls＝本步真实掷出的骰子
    recordSettlement({
      action: 'combatSurprise',
      rule: '9.8',
      rolls: [...rolls],
      data: {
        [DERIVATION_KEY]: derivation,
        side: surprise.side,
        shift: surprise.shift,
        finalColumnLabel: surprise.finalColumnLabel,
        clamped: surprise.clamped,
      },
    })
  }

  /** C6 第 6 步：奇袭判定（9.8）；发生奇袭时须再掷 1 骰做横移 */
  function rollCombatSurprise(): boolean {
    return fireResolution.rollCombatSurprise()
  }

  /** C6 第 6 步（续）：横移骰（9.8） */
  function rollCombatShiftDie(): boolean {
    return fireResolution.rollCombatShiftDie()
  }

  /** C6 第 7 步：战斗掷骰（9.9：2d6 + AR 差 − 环形工事完整等级） */
  function rollCombatDice(): boolean {
    return fireResolution.rollCombatDice()
  }

  /** C6 第 8 步（a）：强制军力损失（9.11c：AR 单位先受第一点；每人各受一点后才有人受第二点） */
  function confirmCombatLosses(): boolean {
    const state = combatState.value
    if (state === null) return false
    const side = currentResolver(state)
    const allocation = combatLossAllocationNow()
    const data = acceptCombat(
      planLosses(state, {
        units: [...combatAttackerViews.value, ...combatDefenderViews.value],
        // 9.11a：玩家把"多受的那一点"改派给别人时，把这份分配交给引擎校验（它判 9.11c 的两条约束）
        ...(allocation === undefined ? {} : { allocation }),
      }),
      '强制损失结算',
    )
    if (data === null) return false
    combatState.value = data.state
    const record = data.state.resolution[side]
    const detail = (record.forcedLosses ?? [])
      .map((item) => `${nameOf(item.unitId)} −${item.steps}`)
      .join('、')
    applyCombatPatches(data.patches)
    pushLog(
      data.rule === '9.10c' ? 'warning' : 'success',
      `${roleLabel(side)}强制损失（9.11c）：${detail === '' ? '无' : detail}` +
        `${(record.ignoredLosses ?? 0) > 0 ? `；超出承受范围的 ${record.ignoredLosses} 点忽略（9.11b）` : ''}` +
        /*
         * 9.10c 例 B：攻方在承受选项前被摧毁 ⇒ 防御者可忽略其选项 ⇒ 攻方选项页**不再出现**
         * （修前会停在一个填不动的选项页上，只能靠"死人撤退"凑过 9.10a）。
         */
        (record.optionsSkipped === 'attackerWipedOut'
          ? '；攻方已全灭 ⇒ **跳过攻方的选项**（9.10c 例 B：防御者可以忽略），直接进守方结算'
          : record.optionsSkipped === 'defenderWipedOut'
            ? '；守方已全灭 ⇒ **跳过守方的选项**（9.10a 的选项与 9.12 的撤退都无单位可承受），直接进撤退/收束'
            : ''),
      data.rule === '9.10c' ? '9.10c' : '9.11c',
    )
    // ⑭ 接线：强制军力损失（9.11c）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'combatLosses',
      rule: data.rule === '9.10c' ? '9.10c' : '9.11c',
      data: {
        side,
        forcedLosses: (record.forcedLosses ?? []).map((item) => ({
          unitId: item.unitId,
          steps: item.steps,
        })),
        ignoredLosses: record.ignoredLosses ?? 0,
        optionsSkipped: record.optionsSkipped ?? null,
      },
    })
    // 零损失的这一方不停屏；继续把下一方的零点数步一并跳掉
    settlePassiveCombatSteps()
    return true
  }

  /** C6 第 9 步：撤退（9.12：撤退格数＝剩余选项数；落点须满足完整撤退距离） */
  /**
   * 9.12：当前撤退输入的**唯一组装点**
   *
   * 确认撤退与 9.12e 的承受者候选预演共用这一份（路径 / 无落点兜底 / 跟随者 / 战斗视图），
   * 避免「界面候选」和「引擎仲裁」各算一遍而分叉。
   */
  function retreatResolutionInput(): Parameters<typeof resolveRetreats>[1] | null {
    const state = combatState.value
    if (state === null) return null
    const paths = Object.entries(combatInputs.value.retreatPaths)
      .map(([unitId, text]) => ({ unitId, path: parseHexPath(text) }))
      .filter((item) => item.path.length > 0)
    // 9.12 第三 bullet：排除 9.12f 不可通行格后一个落点都没有的单位（确认后兜底消灭）
    const noLandingUnitIds = combatRetreatPlans.value.flatMap((plan) =>
      plan.units.filter((unit) => unit.noLanding === true).map((unit) => unit.unitId),
    )
    return {
      // 9.12d：跟随者不是参战者，故这里给**全部盘面单位**（引擎只认构成里的参战者，
      // 但仍然需要能在名单里找到跟随者）
      units: units.value.map((unit) => toBattleUnitView(unit, turn.value)),
      paths,
      facts: combatRetreatFacts.value,
      ...(noLandingUnitIds.length === 0 ? {} : { noLandingUnitIds }),
      // 9.12d：加入撤退的跟随者（未参战战斗单位 / 编内卡车）
      ...(combatTagalongIds.value.length === 0 ? {} : { tagalongIds: combatTagalongIds.value }),
    }
  }

  /**
   * 跳过没有决策的结算屏（用户 2026-11-12 第二批）
   *
   * 9.11 的损失点数为 0、9.10a 的选项点数为 0、9.12 的这一方没有撤退对象时，
   * 屏上只剩一个「确认」按钮 —— 这类步**自动确认**，不再让玩家空点一次。
   * 只连调既有的 confirm 函数，不改任何引擎判定；最多 8 跳，防止异常状态成环。
   */
  function settlePassiveCombatSteps(): void {
    for (let hop = 0; hop < 8; hop += 1) {
      const state = combatState.value
      if (state === null || state.finished === true) return
      if (state.step === 'losses' && (combatRequirement.value?.losses ?? 0) === 0) {
        if (!confirmCombatLosses()) return
        continue
      }
      if (state.step === 'options' && (combatRequirement.value?.options ?? 0) === 0) {
        if (!confirmCombatOptions()) return
        continue
      }
      if (state.step === 'retreat' && combatRetreatPlans.value.length === 0) {
        if (!confirmCombatRetreats()) return
        continue
      }
      return
    }
  }

  /** C6 第 9 步：战后推进与进击标记（9.12g / 9.13） */
  function confirmCombatAdvance(): boolean {
    const state = combatState.value
    if (state === null) return false
    /*
     * 幂等守卫：推进步已收束（突袭自动推进会先收一次，见 9.12g-D）⇒ 再点一次只报成功，
     * **不重复落盘**（否则补丁会二次应用：单位被再挪一次、进击标记再发一遍）。
     */
    if (state.finished === true) return true
    if (specialPending.value !== null) return false
    const arUnit = units.value.find((unit) => unit.instanceId === state.ar?.attackerUnitId)
    const candidates = combatAdvanceCandidates.value.map((item) => ({
      id: item.id,
      paidCombatSupply: item.paid,
      // 9.12b：任何模式下都不可移动者不得战后推进
      immobile: item.immobile,
    }))
    const chosen = combatInputs.value.advanceUnitIds
    const data = acceptCombat(
      resolveAdvance(state, {
        defendingHexCleared: combatDefendingHexCleared.value,
        candidates,
        ...(chosen.length === 0 ? {} : { chosenUnitIds: chosen }),
        // 专规 1.1b：防御格若是敌方安全边缘格（补给源边格）⇒ 不得推进进去
        advanceIntoForbiddenHex: isEnemySafeEdgeHex(
          moveContext.value,
          battleTarget.value?.hex ?? { col: 0, row: 0 },
          actingSide.value,
        ),
        // 剧本活动区（用户 2026-11-15 口径）：防御格在活动区外 ⇒ 不得推进进去
        advanceIntoOutsidePlayArea: !insidePlayArea(
          playAreaHexes.value,
          battleTarget.value?.hex ?? { col: 0, row: 0 },
        ),
        // 9.13b-A：攻方 AR 单位处于 DG ⇒ 不给进击标记
        attackerArDg: arUnit?.mode.dg === true,
        /*
         * 9.13：进击标记是**逐单位**的（图表第 2 页 `e# Attackers with action ratings of # or more
         *   are exploitation marked`；9.13b-A 又规定"非 DG 的攻击单位可正常结算"）⇒ 把参战攻方
         *   各自的 AR / DG 一并交给引擎，由它按单位发补丁。此前引擎只能看"宣布的 AR 单位"一个，
         *   于是 AR 5 与 AR 4 一起攻击时**只有 1 个单位**被标记。
         */
        attackerUnits: combatAttackers.value.map((unit) => ({
          unitId: unit.instanceId,
          ar: unit.raw.ar,
          dg: unit.mode.dg,
        })),
      }),
      '战后推进',
    )
    if (data === null) {
      // W7 C16：推进被拒（例如 9.12g-A「候选未付战斗补给」）时，**突袭的 3 MP 与 8.0 后果仍须记账** ——
      // 否则突袭会卡在托管态、MP 永不扣除，也无法继续移动（8.1a/8.1f）。
      if (overrunContext.value !== null) settleOverrunMove(combatDefendingHexCleared.value)
      return false
    }
    /*
     * M4：先把「9.12g 战斗推进补丁」与「8.0 突袭移动补丁」**一次算出**，再一次性 apply。
     * 修前是 applyCombatPatches 先写、settleOverrunMove 末尾再写：中途失败会留下
     * 「战斗已推进、突袭 3 MP 却没记」的半截状态（K5 的结构性根因）。
     */
    const overrunDraft = planOverrunSettlement(
      combatDefendingHexCleared.value,
      new Set(
        data.patches
          .filter((patch) => patch.steps !== undefined && patch.steps <= 0)
          .map((patch) => patch.unitId),
      ),
    )
    applyCombatPatches(data.patches, overrunDraft?.movePatches ?? [])
    combatState.value = data.state
    if (overrunDraft?.nextInteraction !== null && overrunDraft?.nextInteraction !== undefined)
      moveInteraction.value = overrunDraft.nextInteraction
    // 9.12g-C：推进进入防御格后，立即按 9.14 处置该格（夺取环形工事 9.14e / 空军基地 9.14f /
    //   补给站 9.14b / 运输点与延补队 9.14c-d；位移落点由玩家在地图上选）
    const entered = battleTarget.value?.hex ?? null
    if (entered !== null && data.advanceUnitIds.length > 0) {
      resolveSpecialCombatAt(entered, actingSide.value, true)
      fireResolution.trackSpecialPending()
    }
    pushLog(
      'success',
      `战后推进（9.12g）：${data.advanceUnitIds.length === 0 ? '不推进' : data.advanceUnitIds.map(nameOf).join('、')}` +
        `${data.state.advance?.mandatory === true ? '（突袭后必须推进）' : ''}；` +
        /*
         * E3（批 F·F2）：修前写死"授予 AR 单位"——而 9.13b-A 是**逐单位**授予
         * （AR ≥ e# 且自身未 DG 的参战单位各自获得）⇒ 文案与事实不符。
         * 现在改为列出引擎实际授予的那些单位（`exploit.unitIds`）。
         */
        `进击标记（9.13）：${
          data.exploit.granted
            ? `授予 ${(data.exploit.unitIds ?? []).map(nameOf).join('、') || '（无单位）'}（逐单位，9.13b-A）`
            : `不授予（${data.exploit.reason}）`
        }`,
      '9.12g',
    )
    /*
     * R-4（用户 2026-11-14）：结束不单开屏——只给 toast（map-view 的 finished 翻转）+ 这里一行回执入日志。
     * 回执口径：CRT 记号 · 修正骰 ⇒ 守方 L/o（条款号随日志一并留痕，日志条目本身就是"结算回执"）。
     */
    const receipt = combatSummary.value
    if (receipt !== null) {
      pushLog(
        'success',
        `战斗回执（9.9 / 9.10）：CRT ${receipt.defender.notation} · 2d6=${receipt.modifiedDice} ⇒ 守方 L${receipt.defender.losses} o${receipt.defender.options}`,
        '9.10',
      )
    }
    // 9.2：推进步已落盘即整场战斗收束（无推进候选的收尾也走本函数，故收束日志只此一处）
    pushLog('success', '本场战斗收束（9.2）：结算已落账，可继续下一步', '9.2')
    recordSettlement({
      action: 'combatAdvance',
      rule: '9.12g',
      data: {
        advanceUnitIds: [...data.advanceUnitIds],
        mandatory: data.state.advance?.mandatory === true,
        exploitGranted: data.exploit.granted,
        exploitReason: data.exploit.reason,
      },
    })
    /*
     * 条 22（批 T）：20.0a 的第二个时机＝**战后推进**（仅真正推进进去的那些单位）。
     * 一个都没推进 ⇒ 不开窗（没有单位处在"战后推进"这件事里）。
     */
    if (data.advanceUnitIds.length > 0)
      openBreakdownWindow('advanceAfterCombat', data.advanceUnitIds)
    // W7 C16：若本场是**突袭**（8.0），推进步就是它的收束点 ⇒ 3 MP 与进格已在上面的事务里落盘，
    // 这里只做收尾（ZOC 账本、4.5a 标记、日志与记账），不再二次写补丁。
    if (overrunDraft !== null) settleOverrunPlan(overrunDraft, true)
    return true
  }

  /** C6：放弃本场战斗（中止 9.2 流程；已落盘的结果不自动回滚） */
  function cancelCombat(): void {
    const blocker = combatCancelBlocker()
    if (blocker !== null) {
      pushLog('warning', blocker, '9.2')
      return
    }
    // W7 C16：放弃突袭只丢托管信息（3 MP 尚未记账，故无需回滚）
    if (overrunContext.value !== null) {
      cancelOverrunContext()
      pushLog('info', '放弃本场突袭：未记账 ⇒ 不消耗 MP（8.1a）', '8.1a')
    }
    clearCombat()
    pushLog('info', '放弃本场战斗（9.2 流程中止）', '9.2')
  }

  /* ──────────────── C7 轰炸交互：实现已搬进 `workbench-barrage.ts`（B1，纯搬移） ──────────────── */
  /* 仍被外部引用的动作在此留同名转发（函数声明会提升，故 1909/1917/1919/1921/2446 处的裸引用照旧可用）。 */

  function setBarrageActive(on: boolean): void {
    return barrage.setBarrageActive(on)
  }
  function clearBarrage(): void {
    return barrage.clearBarrage()
  }
  function acceptBarrage<T>(outcome: RuleOutcome<T>, action: string): T | null {
    return barrage.acceptBarrage(outcome, action)
  }
  function applyBarragePatches(patches: readonly BarrageUnitPatch[]): void {
    return barrage.applyBarragePatches(patches)
  }
  function toggleBarrageUnit(unitId: string): void {
    return barrage.toggleBarrageUnit(unitId)
  }
  function setAirInBoxMembership(instanceId: string, inBox: boolean): void {
    return barrage.setAirInBoxMembership(instanceId, inBox)
  }
  function clearAirBoxMembers(): void {
    return barrage.clearAirBoxMembers()
  }
  function addAirUnit(aircraftId: string | null, hexText: string): boolean {
    return barrage.addAirUnit(aircraftId, hexText)
  }
  function removeAirUnit(instanceId: string): void {
    return barrage.removeAirUnit(instanceId)
  }
  function toggleBarrageAirUnit(instanceId: string): void {
    return barrage.toggleBarrageAirUnit(instanceId)
  }
  function syncBarrageParticipants(hex: HexRef, selectedIds: readonly string[]): void {
    return barrage.syncBarrageParticipants(hex, selectedIds)
  }
  function clearBarrageSelectionNow(): void {
    return barrage.clearBarrageSelectionNow()
  }
  function setBarrageKind(kind: BarrageKind): void {
    return barrage.setBarrageKind(kind)
  }
  function setBarrageTargetKind(kind: BarrageTargetKind): void {
    return barrage.setBarrageTargetKind(kind)
  }
  function beginBarrageNow(): boolean {
    return barrage.beginBarrageNow()
  }
  function hqDeliveryDumpKeys(side: Side, beneficiaries: readonly { hex: HexRef }[]): Set<string> {
    return barrage.hqDeliveryDumpKeys(side, beneficiaries)
  }
  function deliverableDumpsFor(side: Side, beneficiaries: readonly ConsoleUnit[]): SpDump[] {
    return barrage.deliverableDumpsFor(side, beneficiaries)
  }
  function combatBeneficiariesOf(side: Side, attackerSide: Side): ConsoleUnit[] {
    return barrage.combatBeneficiariesOf(side, attackerSide)
  }
  function pickBarrageSupplyDump(dumpId: string | null): boolean {
    return barrage.pickBarrageSupplyDump(dumpId)
  }
  function toggleBarrageSupplyDump(dumpId: string): void {
    return barrage.toggleBarrageSupplyDump(dumpId)
  }
  function confirmBarrageSupplyStep(): boolean {
    return barrage.confirmBarrageSupplyStep()
  }
  function confirmBarrageShiftsStep(autoTerrain = true): boolean {
    return barrage.confirmBarrageShiftsStep(autoTerrain)
  }
  function runBarrageResolution(): 'finished' | 'loss' | 'failed' {
    return barrage.runBarrageResolution()
  }
  function refundBarrageSupply(): void {
    return barrage.refundBarrageSupply()
  }
  function cancelOpsBarrage(): void {
    return barrage.cancelOpsBarrage()
  }
  function barrageLossPointsOf(unitId: string): number {
    return barrage.barrageLossPointsOf(unitId)
  }
  function addBarrageLossPoint(unitId: string): void {
    return barrage.addBarrageLossPoint(unitId)
  }
  function removeBarrageLossPoint(unitId: string): void {
    return barrage.removeBarrageLossPoint(unitId)
  }
  function confirmBarrageLossNow(): boolean {
    return barrage.confirmBarrageLossNow()
  }
  function prepareOpsBarrage(hex: HexRef, targetKind: BarrageTargetKind): boolean {
    return barrage.prepareOpsBarrage(hex, targetKind)
  }
  function defaultBarrageTargetKindAt(hex: HexRef): BarrageTargetKind {
    return barrage.defaultBarrageTargetKindAt(hex)
  }
  function drawDumpDestructionDie(): number {
    return barrage.drawDumpDestructionDie()
  }
  function rollBarrageDiceStep(): boolean {
    return barrage.rollBarrageDiceStep()
  }
  function barrageFacilityFacts(hex: HexRef) {
    return barrage.barrageFacilityFacts(hex)
  }
  function applyBarrageFacilityPatch(patch: FacilityPatch, hex: HexRef): void {
    return barrage.applyBarrageFacilityPatch(patch, hex)
  }
  function confirmBarrageOutcomeStep(): boolean {
    return barrage.confirmBarrageOutcomeStep()
  }
  function cancelBarrage(): void {
    return barrage.cancelBarrage()
  }
  function targetKindLabel(kind: BarrageTargetKind): string {
    return barrage.targetKindLabel(kind)
  }

  /* ──────────────── C8 补给交互与 SP 管理：账本 → 12.1a → 12.6/12.3 流程（全部问引擎） ──────────────── */

  /** C8：开/关补给工具（开启时清空上一场；账本与来源声明保留） */
  function setSupplyActive(on: boolean): void {
    supplyActive.value = on
    clearSupply()
    pushLog('info', on ? '补给工具已开启（12.0 章）' : '补给工具已关闭', '12.0')
  }

  /** C8：清空本次补给交互（SP 账本与来源声明保留；换方/换阶段/重置/关闭时调用） */
  function clearSupply(): void {
    supplyUnitId.value = null
    supplyState.value = null
    supplyError.value = null
    supplyPreviewIndex.value = null
    supplyInputs.value = createSupplyInputs()
  }

  /** C8：统一收引擎结论（失败即记 `supplyError` 与日志并返回 null） */
  function acceptSupply<T>(outcome: RuleOutcome<T>, action: string): T | null {
    if (outcome.ok) {
      supplyError.value = null
      return outcome.data
    }
    supplyError.value = { rule: outcome.rule, reason: outcome.reason }
    pushLog('danger', `${action}被拒绝：${outcome.reason}（${outcome.rule}）`, outcome.rule)
    return null
  }

  /** C8：新增一条基础补给源声明（12.6a①②；来源格来自专规/剧本，故由玩家声明） */
  function addSupplySource(): boolean {
    const draft = supplySourceDraft.value
    const hex = parseHexPath(draft.hexText)[0] ?? null
    if (hex === null) {
      pushLog('warning', `补给源格号应为「列.行」（如 36.13），收到「${draft.hexText}」`, '12.6a')
      return false
    }
    supplySourceDecls.value = [
      ...supplySourceDecls.value,
      { id: createId('src'), hex, side: activeSide.value, kind: draft.kind },
    ]
    pushLog(
      'info',
      `声明补给源 ${hexLabel(hex)}（${supplySourceKindLabel(draft.kind)}，12.6a）`,
      '12.6a',
    )
    return true
  }

  /** C8：移除一条基础补给源声明 */
  function removeSupplySource(id: string): void {
    const found = supplySourceDecls.value.find((decl) => decl.id === id)
    supplySourceDecls.value = supplySourceDecls.value.filter((decl) => decl.id !== id)
    if (found !== undefined)
      pushLog('info', `移除补给源 ${hexLabel(found.hex)}（${found.kind}）`, '12.6a')
  }

  /** C8：悬停预览某个来源（把它的覆盖范围画到地图上；null＝回到已选来源） */
  function setSupplyPreview(index: number | null): void {
    supplyPreviewIndex.value = index
  }

  /** C8 第 1 步：对该单位做**补给检查**（12.6 判定 + 来源枚举；结论决定分支） */
  function beginSupplyCheckNow(unitId: string): boolean {
    if (!requireAction('supply.draw', '补给检查（拖取 / 投递）')) return false
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined) {
      pushLog('warning', `找不到单位 ${unitId}（12.6）`, '12.6')
      return false
    }
    if (unit.side !== activeSide.value) {
      pushLog('warning', '只能对**当前方**的单位做补给检查（12.6：补给按方归属）', '12.6')
      return false
    }
    const settlement = traceSettlement.value
    const settledStatus =
      settlement !== null && settlement.turn === turn.value ? settlement.byUnit[unitId] : undefined
    const data = acceptSupply(
      beginSupplyCheck({
        side: activeSide.value,
        phase: phase.value,
        unit: {
          id: unit.instanceId,
          side: unit.side,
          hex: unit.hex,
          isCombat: unit.isCombat,
          re: unit.re,
          mode: unit.mode.mode,
        },
        facts: supplyFacts.value,
        // 12.6：结论读本阶段唯一入口的快照；来源/费率等付款细节仍按此刻事实算
        ...(settledStatus === undefined ? {} : { settledStatus }),
        // 12.6c：把"同一补给站本环节已喂过的 RE"带进评估，使显示的代价就是**本次增量**
        alreadyFedRe: fedReOf(nearestDrawableDump(unit.hex, unit.side)?.id ?? null),
      }),
      '补给检查',
    )
    if (data === null) return false
    supplyUnitId.value = unitId
    supplyState.value = { ...data, sources: expandSameHexStocks(data.sources, unit) }
    supplyPreviewIndex.value = null
    pushLog(
      'info',
      `${unit.name} @ ${hexLabel(unit.hex)}：${supplyStatusLabel(data.assessment.status)}` +
        `（${data.assessment.rule}）｜来源 ${data.sources.length} 条｜分支 ${data.branch}`,
      data.assessment.rule,
    )
    // ⑭ 接线：补给检查/追溯判定（12.6）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'supplyTrace',
      rule: data.assessment.rule,
      data: {
        unitId,
        status: data.assessment.status,
        branch: data.branch,
        sourceCount: data.sources.length,
      },
    })
    return true
  }

  /** C8 第 2 步：选定来源（12.3a/b/c；只做选择，不改状态） */
  function chooseSupplySourceNow(index: number): boolean {
    const state = supplyState.value
    if (state === null) return false
    const data = acceptSupply(chooseSupplySource(state, { index }), '选择来源')
    if (data === null) return false
    supplyState.value = data.state
    supplyPreviewIndex.value = null
    // 12.3b：换来源即重置付款补给站（改由 `supplyPayDumpCandidates` 的默认值接管）
    supplyInputs.value = { ...supplyInputs.value, payFromDumpId: null }
    const source = data.state.chosenSource
    pushLog(
      'info',
      `选定来源：${source === undefined ? '—' : supplySourceLabel(source)}`,
      source?.rule ?? '12.3',
    )
    return true
  }

  /**
   * ⑦ 12.3a / 12.3b：**地图上可点的来源格**（一格一条 ⇒ 12.1b 同格多份 SP 是同一个补给站）
   *
   * 口径全部来自引擎：只收 `ok` 且 `isSpBearingSource(kind)` 的来源（12.6a 追溯源 / 12.6c
   * 吃图上补给没有可拖取的 SP，也不参与选源）。3.4b 的两集群拆分只在**算子显示与付款**上，
   * 这里始终一格一条，不产生「并列来源」。
   */
  const supplyPickSourceHints = computed<readonly { hex: HexRef; selected: boolean }[]>(() => {
    const state = supplyState.value
    if (state === null) return []
    if (state.step !== 'selectSource' && state.step !== 'pickup') return []
    const chosen = state.chosenSource
    const chosenKey = chosen === undefined || chosen.hex === null ? null : hexTextOf(chosen.hex)
    const seen = new Set<string>()
    const hints: { hex: HexRef; selected: boolean }[] = []
    for (const source of state.sources) {
      if (!source.ok || !isSpBearingSource(source.kind) || source.hex === null) continue
      const key = hexTextOf(source.hex)
      if (seen.has(key)) continue
      seen.add(key)
      hints.push({ hex: { ...source.hex }, selected: chosenKey === key })
    }
    return hints
  })

  /**
   * 12.1b / 3.4b：**补给站来源列表**（面板/地图共用）
   *
   * 每**一份持仓**一条（`expandSameHexStocks` 已按格展开）：同格的地面补给站与装载在运输点数上的
   * SP 各占一行，玩家据此明确选一处（原文没有取用先后）。3.4b 勾选且生效期内的轴方仍给集群标签
   * （Guderian / Hoth / 未归属），只影响显示与扣哪一摞，不是两个补给站。
   */
  const supplySourceGroups = computed<
    readonly {
      sourceIndex: number
      source: SupplySourceOption
      dumpId: string | null
      group: PanzerGroup | null
    }[]
  >(() => {
    const state = supplyState.value
    if (state === null) return []
    const out: {
      sourceIndex: number
      source: SupplySourceOption
      dumpId: string | null
      group: PanzerGroup | null
    }[] = []
    const seenDumpHex = new Set<string>()
    state.sources.forEach((source, index) => {
      if (source.kind !== 'dump' || source.hex === null) {
        out.push({ sourceIndex: index, source, dumpId: null, group: null })
        return
      }
      // 12.1b / 13.2f：装载在运输点数上的 SP 是**另一处来源** ⇒ 每份持仓各一行
      if (source.stockId !== undefined) {
        const dump = dumpById(source.stockId)
        out.push({
          sourceIndex: index,
          source,
          dumpId: dump?.id ?? null,
          group:
            dump !== undefined && panzerGroupRulesOn.value && state.side === 'axis'
              ? panzerGroupOfDump(dump.id)
              : null,
        })
        return
      }
      // 12.1b：同格的**地面** SP 仍是一个补给站 ⇒ 按格折一条；3.4b 再按集群拆行
      const sourceHex = source.hex
      const key = hexTextOf(sourceHex)
      if (seenDumpHex.has(key)) return
      seenDumpHex.add(key)
      const dumps = spDumpsOfSide.value.filter(
        (dump) => dump.side === state.side && sameHex(dump.hex, sourceHex),
      )
      if (panzerGroupRulesOn.value && state.side === 'axis' && dumps.length > 0) {
        for (const dump of dumps) {
          out.push({
            sourceIndex: index,
            source,
            dumpId: dump.id,
            group: panzerGroupOfDump(dump.id),
          })
        }
        return
      }
      out.push({ sourceIndex: index, source, dumpId: dumps[0]?.id ?? null, group: null })
    })
    return out
  })

  /**
   * 该格**可点**的来源下标（引擎已判 `ok`）
   *
   * 12.1b：同格的地面 SP 是**一个补给站** ⇒ 引擎给几条都只算一处；装载在运输点数上的 SP
   * （`stockId`）是另一处，各算一处。
   */
  function supplyPickIndexesAt(hex: HexRef): number[] {
    const state = supplyState.value
    if (state === null) return []
    const key = hexTextOf(hex)
    const out: number[] = []
    let groundSeen = false
    state.sources.forEach((source, index) => {
      if (!source.ok || !isSpBearingSource(source.kind) || source.hex === null) return
      if (hexTextOf(source.hex) !== key) return
      if (source.kind === 'dump' && source.stockId === undefined) {
        if (groundSeen) return
        groundSeen = true
      }
      out.push(index)
    })
    return out
  }

  /**
   * ⑦ 12.3：**地图上点来源格**
   *
   * @returns 这一击是否被选源消费（false ⇒ 交回常规地图点击分派）
   */
  function pickSupplySourceAtHexNow(hex: HexRef): boolean {
    const state = supplyState.value
    if (state === null) return false
    const key = hexTextOf(hex)
    // 再点已选来源同一格 ⇒ 取消，退回「选来源」（12.3；与 12.3b 付款站同口径）
    if (state.step === 'pickup') {
      const chosen = state.chosenSource
      if (chosen !== undefined && chosen.hex !== null && hexTextOf(chosen.hex) === key) {
        supplyState.value = { ...state, chosenSource: undefined, step: 'selectSource' }
        supplyPreviewIndex.value = null
        pushLog('info', `取消来源：${hexLabel(hex)}（12.3）`, '12.3')
        return true
      }
      return false
    }
    if (state.step !== 'selectSource') return false
    const indexes = supplyPickIndexesAt(hex)
    /*
     * 12.1b：同格可能有多份持仓（地面补给站 / 装载在运输点数上的 SP）——原文**没有**规定先吃哪一处，
     * 故这里**不默认取第一条**（修前总取引擎顺序第一格账本 ⇒ 编内卡车永远点不到），要求玩家在
     * 来源清单里明确选一处（13.2g-B 的编队资格也只对其中部分持仓成立）。
     */
    if (indexes.length === 1) return chooseSupplySourceNow(indexes[0]!)
    if (indexes.length > 1) {
      const choices = indexes.map((index) => supplySourceLabel(state.sources[index]!)).join('；')
      pushLog(
        'warning',
        `${hexLabel(hex)} 同格有 ${indexes.length} 处来源：${choices} —— 请在来源清单里选一处（12.1b）`,
        '12.1b',
      )
      return true
    }
    // 该格有来源但不可点（距离外 / 无 SP）：只出一行原因
    const blocking = state.sources.find(
      (source) => source.hex !== null && hexTextOf(source.hex) === key,
    )
    if (blocking === undefined) return false
    const why = blocking.ok
      ? '该来源不含 SP，不能拖取'
      : `${blocking.rule}：${blocking.reason ?? blocking.detail}`
    pushLog(
      'warning',
      `${hexLabel(hex)} 不能作为来源：${why}`,
      blocking.ok ? '12.1b' : blocking.rule,
    )
    return true
  }

  /** C8：本次拖取/投递的**付款补给站**（12.3a 直接从它拖取；12.3b 由 HQ 从它拖取后再前送） */
  function resolvePayDump(
    source: SupplySourceOption,
    candidates: readonly SpDump[],
  ): SpDump | null {
    if (source.kind === 'dump') {
      const hex = source.hex
      if (hex === null) return null
      // 12.1b / 13.2f：来源已按**每份持仓**展开 ⇒ 扣玩家选中的那一份（地面账本 or 装载在车上）
      if (source.stockId !== undefined) return dumpById(source.stockId) ?? null
      // 12.1b（用户 2026-11-13）：装载中的 SP 也是补给站 ⇒ 与地面账本一起参与解析
      const sameHexDumps = allSpDumpsOfSide.value.filter((dump) => sameHex(dump.hex, hex))
      if (!panzerGroupRulesOn.value) return sameHexDumps[0] ?? null
      /*
       * 3.4b（用户补充裁定）：
       *   · 玩家点选过哪一个算子 ⇒ 扣那一条（非编队德军可在 G/H 之间二选一）；
       *   · 没点选 ⇒ 多单位编队取本集群；非编队/未归属取第一条（同格总量不变）。
       * 编队扣错集群由 `confirmSupplyPickupNow` 的 3.4b 闸门拒付并给出条款号。
       */
      const chosen = sameHexDumps.find((dump) => dump.id === supplyInputs.value.payFromDumpId)
      if (chosen !== undefined) return chosen
      const payer = units.value.find((unit) => unit.instanceId === supplyState.value?.unitId)
      if (payer !== undefined && payer.panzerGroup != null) {
        return sameHexDumps.find((dump) => panzerGroupOfDump(dump.id) === payer.panzerGroup) ?? null
      }
      return sameHexDumps[0] ?? null
    }
    if (source.kind === 'hqThrow') {
      if (candidates.length === 0) return null
      const chosen = candidates.find((dump) => dump.id === supplyInputs.value.payFromDumpId)
      return chosen ?? candidates[0]!
    }
    // 12.6a 的追溯源与 12.6c 的吃图上补给都不在这里扣款（后者走 `confirmOosResolutionNow`）
    return null
  }

  /**
   * 12.8d：把「该单位此刻是否有补给」这一结论落到单位上（唯一写入口）
   *
   * 消费方：`battle.unitBattleStrength`（断补战斗值 ×½）、`zoc`（断补不投射 ZOC）、
   * `map-view` / `hotseat`（断补图标）、`breakout.canBreakout`（须无追溯补给方可突围）。
   *
   * ★ 原先该字段在 `toConsoleUnit` 里恒为 `true`，且全库**没有任何一处写 false**
   *   ⇒ 12.8 整条链（减半 / 无 ZOC / 逐回合损耗 / 突围资格 / 断补图标）全部空转。
   *   本函数与补给面板的两条结论对接：12.3a/b 拖取成功 ⇒ 有补给；
   *   12.6c/d 断补处置 ⇒ 按引擎的 `markedOutOfSupply` 落盘。
   */
  function markTraceSupply(instanceId: string | null, hasTraceSupply: boolean): void {
    if (instanceId === null) return
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return
    unit.hasTraceSupply = hasTraceSupply
    // 12.8e：12.3a/b 拖取成功（有补给）⇒ 连续断补期结束；标记为断补时起点由 `refreshTraceSupply` 落值
    if (hasTraceSupply) unit.cutSinceTurn = null
    else if ((unit.cutSinceTurn ?? null) === null) unit.cutSinceTurn = turn.value
    // 单向定向写入（12.3a 拖取成功 / 断补处置）同步进本阶段快照的**结论**，避免逐单位检查读到旧状态
    const settlement = traceSettlement.value
    const previous = settlement?.byUnit[instanceId]
    if (settlement !== null && previous !== undefined) {
      traceSettlement.value = {
        ...settlement,
        byUnit: { ...settlement.byUnit, [instanceId]: hasTraceSupply ? 'inSupply' : 'outOfSupply' },
      }
    }
  }

  /**
   * 12.8e 括注：把「本回合靠**特殊续命**维生」记到单位上
   *
   * 三种方式：**12.6c 吃图上补给**（`applySupplyPhaseFeedingNow`）、**12.10e 部队储备恢复**
   * （`applySupplyPhaseRecoveryNow`）、**21.10 补给缓存**（Forage / Shells）。它们不构成追溯补给，
   * 但按 12.8e 的括注，这些单位在续命当回合**不算**"被切断的第一个回合"⇒ 首回合豁免顺延。
   */
  function markSustainedBySpecialSupply(instanceIds: readonly string[]): void {
    if (instanceIds.length === 0) return
    const keys = new Set(instanceIds)
    for (const unit of units.value) {
      if (!keys.has(unit.instanceId)) continue
      unit.sustainedBySpecialSupplyTurn = turn.value
      /*
       * 12.8e 括注的时序：若这次续命恰好发生在「发现没有追溯补给的**当回合**」，
       * 则该回合不算"被切断的第一个回合" ⇒ 豁免顺延到下一个**真断补**回合。
       * 若连续断补早已开始（`cutSinceTurn < turn`），续命**不重置**起点（否则会白送新的豁免）。
       */
      if ((unit.cutSinceTurn ?? null) === turn.value) unit.cutSinceTurn = null
    }
  }

  /** C8 第 3 步：结算拖取/投递（12.3），扣付款补给站的 SP 并把余额交回账本 */
  function confirmSupplyPickupNow(): boolean {
    const state = supplyState.value
    if (state === null) return false
    const source = state.chosenSource
    if (source === undefined) {
      pushLog('warning', '请先选定来源（12.3a/b）', '12.3')
      return false
    }
    const pay = resolvePayDump(source, supplyPayDumpCandidates.value)
    if (pay === null) {
      pushLog('warning', '找不到可付款的补给站（12.1b：只有含 SP 的位置才能被拖取/投递）', '12.1b')
      return false
    }
    const inputs = supplyInputs.value
    /*
     * 3.4b（用户补充裁定）：付款站的集群必须与受益编队的集群一致 ——
     * 多单位编队扣错集群就在这里拒，并给出条款号（12.3 拖取同样受 3.4b 约束）。
     * 苏军/非编队/失效期由既有闸门自己放行（`panzerGroupSpGate` 只约束轴方编队）。
     */
    const panzerPurpose =
      inputs.purpose === 'fuel' || inputs.purpose === 'combat' ? inputs.purpose : null
    if (panzerPurpose !== null) {
      const gate = panzerGroupSpGate({
        dumpId: pay.id,
        purpose: panzerPurpose,
        beneficiaryUnitIds: [state.unitId],
      })
      if (gate !== null) {
        pushLog(
          'danger',
          `${panzerGroupSpRefusal(gate, panzerPurpose === 'fuel' ? '燃油' : '战斗补给', pay.id)}（3.4b）`,
          '3.4b',
        )
        return false
      }
    }
    /*
     * 裁定⑤「获取即付款」：**T 数由用途的费率算**，玩家不再手填（12.4/12.5 的费率是死的，
     * 手填等于允许少付）；只有 12.10 储备 / 13.8 建造这类"数量即内容"的用途才用手填值。
     * 裁定⑥：战斗补给**不在本链付**（只在战斗会话内付）⇒ 这里按 12.4 拒绝。
     */
    const requirement = supplyPickupRequirement.value
    if (requirement === null) {
      pushLog(
        'danger',
        '12.4：战斗补给在**战斗的当口**支付（9.5 的「战斗补给」步 / 12.4），不在补给检查里预付 —— ' +
          '请在战斗会话的「战斗补给（12.4）」里点补给站付款',
        '12.4',
      )
      return false
    }
    const amountT = requirement.manual ? Math.trunc(inputs.amountT) : requirement.t
    if (amountT <= 0) {
      pushLog('warning', '待拖取/投递的 T 数应为正数（12.3a：「所需补给」）', '12.3')
      return false
    }
    const data = acceptSupply(
      confirmSupplyPickup(state, {
        holdings: { sp: pay.sp, t: pay.t },
        amountT,
        purpose: inputs.purpose,
        /*
         * 12.3b-A + 裁定②：拖取/投递**必须当场用于某个用途** ⇒ 立即使用是**结构性恒真**
         * （修前是面板上一个可以取消的勾选框 ⇒ 取消即被 12.3b-A 拒，等于把一个必答项做成了选项）。
         */
        forImmediateUse: true,
      }),
      '拖取/投递',
    )
    if (data === null) return false
    setSpDumpHoldings(pay.id, data.pickup.sourceAfter)
    supplyState.value = data.state
    // 12.3a/b：拖取/投递成功 ⇒ 该单位本回合已有补给（清除可能残留的断补标记）
    markTraceSupply(supplyUnitId.value, true)
    pushLog(
      'success',
      `拖取/投递 ${data.pickup.deliveredT} T（付款站 ${hexLabel(pay.hex)}；${requirement.detail}）；${data.pickup.detail}`,
      data.pickup.rule,
    )
    /*
     * ★ 批 B 切片 2 的**核心**：把**用途落到状态**（修前扣完款就结束了 ⇒ 玩家看到"扣了 SP 但单位
     *   还是不能走"）。12.3 重要提示把"获取"与"用途"写成同一个动作的两面，故这里当场生效。
     */
    const target = units.value.find((unit) => unit.instanceId === supplyUnitId.value) ?? null
    let purposeApplied: Record<string, unknown> = {}
    if (target !== null && inputs.purpose === 'fuel') {
      // 12.5c-C：单单位法，状态只在本阶段有效（12.5d 单单位法不进编队标记）
      target.fuelled = true
      target.fuelMethod = 'singleUnit'
      /*
       * 「取完补给立刻开拔」：**只在确有开拔意图时**重试（取子清单/正在移动/就是选中那一枚）——
       * 否则会拿一次"当前环节不允许移动"的拒绝去打扰玩家（补给段本来就不能移动，见 2.2）。
       */
      const wasPending =
        moveUnits.value.some((unit) => unit.instanceId === target.instanceId) ||
        (movePick.value?.ids ?? []).includes(target.instanceId) ||
        selectedUnit.value?.instanceId === target.instanceId
      if (wasPending) retryBeginMove()
      pushLog(
        'success',
        `${target.name} 已加注（12.5c-C：1 T）；燃料已补给状态**只在本阶段有效**（12.5c-C）` +
          `${wasPending ? '；已按当前开拔意图重试移动' : '；现在可以移动'}`,
        '12.5c-C',
      )
      purposeApplied = { fuelApplied: true, fuelMethod: 'singleUnit' }
    }
    // ⑭ 接线：拖取 / HQ 投递（12.3a / 12.3b）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'supplyPickup',
      rule: data.pickup.rule,
      data: {
        unitId: supplyUnitId.value,
        sourceKind: source.kind,
        payDumpHex: { ...pay.hex },
        deliveredT: data.pickup.deliveredT,
        purpose: inputs.purpose,
        // 裁定②：立即使用是恒真项；这里如实记进会话日志（留痕）
        forImmediateUse: true,
        rateRule: requirement.rule,
        manualAmount: requirement.manual,
        ...purposeApplied,
        detail: data.pickup.detail,
      },
    })
    return true
  }

  /** C8 分支 B：断补处置（12.6c 吃图上补给 / 12.6d 接受断补） */
  function confirmOosResolutionNow(): boolean {
    const state = supplyState.value
    if (state === null) return false
    const inputs = supplyInputs.value
    const pay = supplyOosPayDump.value
    // 12.6c：本批已从该站喂过多少 RE —— 收费取**增量**，累计恰等于批量费率
    const fedBefore = fedReOf(pay === null ? null : pay.id)
    const data = acceptSupply(
      confirmOosResolution(state, {
        holdings: pay === null ? { sp: 0, t: 0 } : { sp: pay.sp, t: pay.t },
        action: inputs.oosAction,
        alreadyFedRe: fedBefore,
      }),
      '断补处置',
    )
    if (data === null) return false
    if (data.resolution.action === 'eatOffTheMap' && pay !== null) {
      setSpDumpHoldings(pay.id, data.resolution.holdingsAfter)
      // 记账：本单位已从该站被喂过（下次同站收费只付增量）
      oosFedReByDump.value = { ...oosFedReByDump.value, [pay.id]: fedBefore + state.assessment.re }
    }
    supplyState.value = data.state
    // 12.6c/d：把断补结论**落到单位上**（原先只进日志 ⇒ 12.8 的效果与逐回合损耗无处生效）。
    // `acceptOutOfSupply` ⇒ 标记断补（hasTraceSupply=false）；
    // `eatOffTheMap` ⇒ **不写** `hasTraceSupply`（吃图上补给不构成追溯补给，用户 2026-11-06 裁定），
    //   只记「本回合续命」⇒ 12.8e 括注：该回合不算"被切断的第一个回合"。
    if (data.resolution.markedOutOfSupply) markTraceSupply(supplyUnitId.value, false)
    else if (supplyUnitId.value !== null) markSustainedBySpecialSupply([supplyUnitId.value])
    pushLog(
      data.resolution.markedOutOfSupply ? 'warning' : 'success',
      `断补处置：${data.resolution.detail}` +
        (pay === null ? '' : `（付款站 ${hexLabel(pay.hex)}）`),
      data.resolution.rule,
    )
    // ⑭ 接线：断补结算（12.6c 吃图上补给 / 12.6d 接受断补）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'supplyOos',
      rule: data.resolution.rule,
      data: {
        unitId: supplyUnitId.value,
        action: data.resolution.action,
        markedOutOfSupply: data.resolution.markedOutOfSupply,
        payDumpHex: pay === null ? null : { ...pay.hex },
        detail: data.resolution.detail,
      },
    })
    return true
  }

  /**
   * 12.6f：本侧各**多单位编队**里被"同源取舍"排除掉的单位（须吃图上补给，否则断补）
   *
   * 判据只有一处：引擎 `formationTraceTradeoff`（分组由本函数给 —— 它只吃"已分好组的单位列表"）。
   * 分组键＝`unit.formation`（3.1c 的多单位编队番号，**由数据定死**；用户 2026-09-17 裁定）。
   * 编队只有 1 个战斗单位时无从谈"同源"，直接跳过（不给单人编队编戏）。
   */
  function formationTraceDeniedIds(
    side: Side,
    reason: string,
    facts = supplyFacts.value,
    silent = false,
  ): Set<string> {
    const byFormation = new Map<string, ConsoleUnit[]>()
    for (const unit of units.value) {
      if (unit.side !== side) continue
      if (!requiresTraceSupply(unit)) continue
      const formation = unit.formation
      if (formation === null) continue
      const members = byFormation.get(formation)
      if (members === undefined) byFormation.set(formation, [unit])
      else members.push(unit)
    }
    const denied = new Set<string>()
    for (const [formation, members] of byFormation) {
      if (members.length < 2) continue
      const result = formationTraceTradeoff(facts, {
        side,
        // 与补给网的覆盖集同口径（`traceCoverageHexes` 也按 truck 算）
        mobility: 'truck',
        units: members.map((unit) => ({ id: unit.instanceId, hex: unit.hex })),
      })
      if (result.sameSource) continue
      for (const id of result.uncoveredUnitIds) denied.add(id)
      if (silent) continue
      const namesOf = (ids: readonly string[]): string =>
        ids.map((id) => units.value.find((unit) => unit.instanceId === id)?.name ?? id).join('、')
      pushLog(
        'warning',
        `12.6f：编队 ${formation} 的战斗单位**未 trace 到同一来源**（${reason}）⇒ ` +
          `${namesOf(result.coveredUnitIds)} 仍获追溯补给` +
          (result.commonSource === null
            ? ''
            : `（共同来源 ${hexLabel(result.commonSource.hex)}）`) +
          `，${namesOf(result.uncoveredUnitIds)} 必须**吃图上补给**（12.6c），否则断补（12.6d）`,
        '12.6f',
      )
    }
    return denied
  }

  /** 本回合已落盘的追溯补给判定快照（补给阶段唯一入口写入；回合内只读） */
  interface TraceSettlement {
    turn: number
    /** null＝裁判手动全场重判 */
    side: Side | null
    byUnit: Record<string, UnitSupplyAssessment['status']>
    denied: Record<Side, string[]>
    marked: number
    cleared: number
    outOfSupply: number
    reason: string
  }
  const traceSettlement = ref<TraceSettlement | null>(null)

  /**
   * 12.6 / 12.8：**唯一的自动判定入口**
   *
   * 只在「自己的补给阶段」判一次当前方（裁判入口可传 `side:null` 全场强制重判）；
   * 同一回合同一方重复调用直接复用快照，不重写标记 —— 12.8a 要求断补标记
   * 保留到下一个友方补给阶段重新判定。
   *
   * 判定结论同时写入 `traceSettlement.byUnit`，逐单位检查与阶段末总计划都只读快照，
   * 不再各自现算一遍。
   */
  function settleTraceSupplyNow(
    reason: string,
    options: { side: Side | null; force?: boolean; seedCutTurn?: boolean },
  ): number {
    const side = options.side
    const existing = traceSettlement.value
    if (
      options.force !== true &&
      existing !== null &&
      existing.turn === turn.value &&
      existing.side === side
    )
      return existing.outOfSupply
    // 12.8a：连续断补起点只在**补给阶段**落值（裁判在别的阶段重判不落起点）
    const seedCutTurn = options.seedCutTurn ?? phase.value === 'supply'
    const facts = supplyFacts.value
    const sides: readonly Side[] = side === null ? (['axis', 'soviet'] as const) : [side]
    const byUnit: Record<string, UnitSupplyAssessment['status']> = {}
    const deniedBySide: Record<Side, string[]> = { axis: [], soviet: [] }
    let marked = 0
    let cleared = 0
    let outOfSupply = 0
    for (const currentSide of sides) {
      const covered = traceCoverageHexes(facts, { side: currentSide, mobility: 'truck' })
      // 12.6f（＝13.7a 的追溯那一半）：编队同源取舍在本阶段判一次，回合内沿用结论。
      const denied = formationTraceDeniedIds(currentSide, reason, facts)
      deniedBySide[currentSide] = [...denied]
      for (const unit of units.value) {
        if (unit.side !== currentSide) continue
        // 12.6h 空投当回合 / 12.9 非战斗单位不受追溯约束 / 覆盖集命中且未被 12.6f 排除
        const inSupply =
          (unit.airDropExemptTurn ?? null) === turn.value ||
          !requiresTraceSupply(unit) ||
          (traceCoverageHas(covered, unit.hex) && !denied.has(unit.instanceId))
        byUnit[unit.instanceId] = !requiresTraceSupply(unit)
          ? 'notRequired'
          : inSupply
            ? 'inSupply'
            : 'outOfSupply'
        const before = unit.hasTraceSupply
        unit.hasTraceSupply = inSupply
        if (before !== inSupply) {
          if (inSupply) cleared += 1
          else marked += 1
        }
        // 12.8e：连续无追溯补给的起点只在补给阶段落值
        if (inSupply) unit.cutSinceTurn = null
        else if (
          seedCutTurn &&
          isOutOfSupplyNow(unit, turn.value) &&
          (unit.cutSinceTurn ?? null) === null
        )
          unit.cutSinceTurn = turn.value
        if (isOutOfSupplyNow(unit, turn.value)) outOfSupply += 1
      }
    }
    traceSettlement.value = {
      turn: turn.value,
      side,
      byUnit,
      denied: deniedBySide,
      marked,
      cleared,
      outOfSupply,
      reason,
    }
    pushLog(
      'info',
      `追溯补给判定（12.6，${reason}）：断补 ${outOfSupply} 个单位（置 ${marked} / 除 ${cleared}）`,
      '12.6',
    )
    // ⑭ 接线：全场补给判定（12.6）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'supplyTrace',
      rule: '12.6',
      data: { reason, outOfSupply, marked, cleared },
    })
    return outOfSupply
  }

  /**
   * 12.6：自动入口（进入补给阶段 / 协调器阶段切换）
   *
   * 只有补给阶段才真正结算；非补给阶段一律不写标记（用户 2026-11-13 口径：
   * 抽象补给不因走出范围立刻断补，回合内沿用同一结论）。
   */
  function refreshTraceSupply(reason: string): number {
    if (phase.value !== 'supply') return 0
    return settleTraceSupplyNow(reason, { side: activeSide.value })
  }

  /**
   * 12.6 / 12.8：**手动**触发全场追溯补给判定（裁判覆盖，绕过幂等闸门）
   *
   * 与自动入口同一实现；现有补给/突围用例依赖它在任意时刻重判。
   *
   * @returns 本次判定为断补的单位数
   */
  function evaluateTraceSupplyNow(): number {
    return settleTraceSupplyNow('手动重判', { side: null, force: true })
  }

  /* ────────── C8b：D 段**补给阶段总计划**（12.1–12.2 / 12.6 / 12.8 / 12.10e / 12.11a） ────────── */

  /**
   * C8b：载入**补给阶段总计划**（12.1–12.2 的 D 段骨架）
   *
   * 引擎一次给出全段结论（顺序由 12.10e-A 定死：**恢复优先于以 SP 代 trace**）：
   * 恢复 → 逐单位评估（12.6）→ 吃图上补给分配（12.6c）→ 断补标记置/除（12.6d）→ 损耗义务（12.8a/b）。
   * 本动作只**算**不落盘；落盘各自走 `applySupplyPhaseRecoveryNow` / 既有的断补处置路径。
   */
  function planSupplyPhaseNow(): boolean {
    return supplyPhaseDomain.planSupplyPhaseNow()
  }

  /** C8b：供养落盘前可清空草稿；落盘后的计划保留为损耗账本。 */
  function clearSupplyPhasePlan(): void {
    supplyPhaseDomain.clearSupplyPhasePlan()
  }

  /**
   * C8b：落盘 **12.10e 部队储备强制恢复**（本段的第一步，且是**强制**项）
   *
   * 「在拥有部队储备低下或耗尽单位的玩家的补给阶段中，如果有了可用的 SP（可通过直接拖取或从指挥部
   *   投递），则要将标记为低下或耗尽的单位的部队储备进行恢复」——故这不是选项：计划里
   *   `canDraw` 为真者必须恢复；`spentT` 与 12.10e-C 的**浪费**一并从己方补给站扣。
   */
  function applySupplyPhaseRecoveryNow(): boolean {
    return supplyPhaseDomain.applySupplyPhaseRecoveryNow()
  }

  /**
   * C8b：从**己方补给站**按序扣 T（12.3a/12.3b 是仅有的取补途径；不存在凭空池子）
   *
   * 逐站 `planSpPayment` 试扣，凑不齐即**整笔拒绝**（先试算再落盘，避免半截状态）。
   * 返回付款站清单（供日志）；失败返回 null。
   *
   * ★ 第五批批 B 切片 3：`allowed` 把可扣的站限死在**付款对象的可达站并集**内
   *   （12.10e-C 的池级浪费情形用；逐单位付款走 `payFromUnitReachableDumps`）。
   */
  function payFromSideDumps(wantT: number, allowed?: readonly SpDump[]): string | null {
    if (wantT <= 0) return '（无需付款）'
    let remaining = wantT
    const plans: { id: string; after: SpHoldings }[] = []
    for (const dump of allowed ?? spDumpsOfSide.value) {
      if (remaining <= 0) break
      const payment = planSpPayment({
        holdings: { sp: dump.sp, t: dump.t },
        wantT: Math.min(remaining, holdingsToT({ sp: dump.sp, t: dump.t })),
      })
      if (!payment.ok) continue
      plans.push({ id: dump.id, after: payment.data.holdingsAfter })
      remaining -= holdingsToT({ sp: dump.sp, t: dump.t }) - holdingsToT(payment.data.holdingsAfter)
    }
    if (remaining > 0) {
      pushLog(
        'danger',
        `补给不足以支付 ${wantT} T（缺 ${remaining} T）：12.3a/12.3b 只能从己方补给站取 ⇒ 本次不改动任何账本`,
        '12.4',
      )
      return null
    }
    for (const item of plans) setSpDumpHoldings(item.id, item.after)
    return [...new Set(plans.map((item) => spDumpLabelOf(item.id)))].join('、')
  }

  /**
   * 第五批批 B 切片 3（12.10e/12.6c × 12.3a·b）：从**该单位自己的可达站**按序扣 T
   *
   * 「如果有了可用的 SP（可通过**直接拖取或从指挥部投递**）」（12.10e）⇒ 付款来源必须对
   * **受益单位本人**可达（`deliverableDumpsFor(side, [unit])`＝12.3a 直拖 ∪ 12.3b 投递）。
   * 凑不齐即**整笔拒绝**（先试算再落盘，与 `payFromSideDumps` 同规）并返回 null；
   * 成功返回付款站清单（供日志）。
   */
  function payFromUnitReachableDumps(unit: ConsoleUnit, wantT: number): string | null {
    if (wantT <= 0) return '（无需付款）'
    let remaining = wantT
    const plans: { id: string; after: SpHoldings }[] = []
    for (const dump of deliverableDumpsFor(unit.side, [unit])) {
      if (remaining <= 0) break
      const payment = planSpPayment({
        holdings: { sp: dump.sp, t: dump.t },
        wantT: Math.min(remaining, holdingsToT({ sp: dump.sp, t: dump.t })),
      })
      if (!payment.ok) continue
      plans.push({ id: dump.id, after: payment.data.holdingsAfter })
      remaining -= holdingsToT({ sp: dump.sp, t: dump.t }) - holdingsToT(payment.data.holdingsAfter)
    }
    if (remaining > 0) return null
    for (const item of plans) setSpDumpHoldings(item.id, item.after)
    return [...new Set(plans.map((item) => spDumpLabelOf(item.id)))].join('、')
  }

  /**
   * C8b：**12.11a 销毁补给站**
   *
   * 「玩家可尝试销毁补给站中的全部 SP，或只尝试销毁其中部分的 SP……这只能在该玩家的
   *   移动、反应和进击阶段中的**移动环节**进行。玩家在每个阶段中，只能每个补给站只能尝试销毁一次。」
   * 掷 1 骰查销毁表得百分比；损失按 T 取整到最近；**运输点数不能以此方式摧毁**。
   *
   * ★ B28（用户口径 2026-09-16 #9「所有的随机数抽取一律自动结算」）：两个参数都改为**可选** ——
   *   骰面缺省即**当场掷**（走 `rng`，可复算），请求量缺省即**全部 SP**。
   *   于是正式界面里这条动作**不需要玩家填任何数字**；"只销毁一部分"仍是规则允许的，
   *   由界面的"全部 / 可改的数字"承担 —— 改数字是**选择**，不是掷骰。
   */
  function destructDumpNow(dumpId: string, requestedT?: number, die?: number): boolean {
    // 12.11a：只在己方移动/反应/进击阶段的**移动环节**
    if (!requireAction('move.dumpBlow', '销毁补给站')) return false
    const dump = spDumps.value.find((item) => item.id === dumpId)
    if (dump === undefined) {
      pushLog('warning', `找不到补给站 ${dumpId}（12.11a）`, '12.11a')
      return false
    }
    // 7.0a：反应段由非阶段玩家行动 ⇒「己方」取 `actingSide`
    if (dump.side !== actingSide.value) {
      pushLog('warning', '只能销毁**己方**的补给站（12.11a）', '12.11a')
      return false
    }
    const verdict = canAttemptDumpDestruction({
      /*
       * ★ 必须传**真实段**：`movementPhaseOf` 会把非移动段也映成 `'movement'`（那只是给引擎一个
       *   合法枚举值），若照抄它，12.11a 的"只在移动环节"闸门将**永远通过**。
       */
      segment: phase.value as MovementSegmentPhase,
      attemptsThisPhase: dumpDestructionAttempts.value[dumpId] ?? 0,
    })
    if (!verdict.ok) {
      pushLog('warning', `销毁补给站被拒：${verdict.detail}（${verdict.rule}）`, verdict.rule)
      return false
    }
    // 12.11a：只销毁 SP（运输点数不受此影响）；请求量以 SP 折算的 T 为准
    const spT = holdingsToT({ sp: dump.sp, t: 0 })
    // B28：骰面缺省＝现掷；请求量缺省＝全部 SP
    const rolled = die ?? drawDumpDestructionDie()
    const wantT = Math.min(Math.max(0, requestedT ?? spT), spT)
    if (wantT <= 0) {
      pushLog('warning', '该补给站没有可销毁的 SP（12.11a：运输点数不能以此方式摧毁）', '12.11a')
      return false
    }
    const result = planDumpDestruction({
      requestedT: wantT,
      percent: dumpDestructionPercent(rolled),
    })
    if (!result.ok) {
      pushLog('warning', `销毁补给站被拒：${result.detail}（${result.rule}）`, result.rule)
      return false
    }
    const after = planSpPayment({ holdings: { sp: dump.sp, t: dump.t }, wantT: result.destroyedT })
    if (!after.ok) {
      pushLog('danger', `销毁量 ${result.destroyedT} T 超过该站持有（12.11a）`, '12.11a')
      return false
    }
    setSpDumpHoldings(dumpId, after.data.holdingsAfter)
    dumpDestructionAttempts.value = {
      ...dumpDestructionAttempts.value,
      [dumpId]: (dumpDestructionAttempts.value[dumpId] ?? 0) + 1,
    }
    pushLog(
      'success',
      `12.11a 销毁补给站 ${hexLabel(dump.hex)}：掷 ${String(rolled)} → ${result.detail}；` +
        `余 ${after.data.holdingsAfter.sp} SP + ${after.data.holdingsAfter.t} T`,
      '12.11a',
    )
    // 12.8a：补给站持仓变化不重判断补标记（取补/投递资格在付款时点实时判）
    return true
  }

  /**
   * C8b：**一键落盘 ③ 喂食（12.6c）与 ④ 断补标记（12.6d）**
   *
   * 计划里的 `feeding` 只含玩家**自愿**勾选吃图上补给的单位（12.6c 游戏说明：**永不强迫**），
   * `affordable` 为真者才真被喂饱；喂饱的 T 从己方补给站按序扣（12.3a/12.3b 是仅有取补途径）。
   * 标记的落盘一律走**唯一写点** `markTraceSupply`（与逐单位交互路径同源，不另开一条）。
   *
   * ★ 落盘后**不**再 `refreshTraceSupply`：本计划就是这一段的判定结论，立刻重判会把它覆盖掉
   *   （下一段或手动重判时自然会按新事实重算）。
   */
  function applySupplyPhaseFeedingNow(): boolean {
    return supplyPhaseDomain.applySupplyPhaseFeedingNow()
  }

  /* ────────── C8c：12.8b 损耗（断补堆叠逐格掷骰与分摊） ────────── */

  /** 某格的损耗输入（缺省：骰面 7＝2d6 期望值居中；分摊为空） */

  function setAttritionDie(hexKey: string, die: number): void {
    supplyPhaseDomain.setAttritionDie(hexKey, die)
  }

  function setAttritionAllocation(hexKey: string, unitId: string, steps: number): void {
    supplyPhaseDomain.setAttritionAllocation(hexKey, unitId, steps)
  }

  /**
   * C8c：**12.8b 掷损耗骰**（逐格）
   *
   * 「掷两枚骰子，使用标为断补的单位中**行动值最高**单位的行动值，找到对应的一列，并计算格中的
   *   断补单位的**军力数量**」；修正照 12.8b 的表注（断补军力 ≥5 时 +3）。取列用的 AR 由计划里的
   * `attritionDuty.bestAr` 给出（12.8c：DG 不修正 AR，战略模式按 0）——**不由本处复述**。
   *
   * 骰面**自动**（B28：用户口径 2026-09-16 #9「所有的随机数抽取一律自动结算」）——
   * 走种子化 `rng`，结果落在 `attritionResults[hexKey].die` 与结算日志里，可复算。
   * 需要钉某个骰值的场合（验证页 / 既有用例）**显式传第三个参数** `die`。
   */
  function rollAttritionNow(hexKey: string, die?: number): boolean {
    return supplyPhaseDomain.rollAttritionNow(hexKey, die)
  }

  /**
   * C8c：**12.8b 分摊落盘**（把该格必须损失的军力点数分给具体单位）
   *
   * 「堆叠的拥有者玩家可以选择如何让该堆叠中的断补单位承受这些损失。**没有**让 AR 最高的单位
   *   必须承受损失的要求。」故只校验「分摊合法且恰好满足义务」（引擎 `validateAttritionAllocation`），
   * 然后逐单位扣军力；军力归零者经**唯一漏斗** `eliminateEntry` 进死亡堆（9.11）。
   */
  function applyAttritionNow(hexKey: string): boolean {
    return supplyPhaseDomain.applyAttritionNow(hexKey)
  }

  /* ────────── C8d：13.2c 运输点数的合并 / 拆分（含 12.7 的双向转换） ────────── */

  /*
   * B3-2b12（2026-11-21）：13.2c 运输点数合并/拆分（7 个声明）搬进 `workbench-transport-points.ts`。
   * `transportKindOf` 留在此处原位：`transportPointActorOf`（13.2f 装载量快照）在**建域点之前**
   * 就读它 ⇒ 只能反向当端口（`function` 声明 ⇒ 提升，按值传）。
   */
  const transportPointsDomain = createTransportPointsDomain({
    activeSide,
    phase,
    units,
    pushLog,
    requireAction,
    transportKindOf,
  })
  const {
    transportPointsOfSide,
    transportPointInputs,
    transportPointGroupsOfSide,
    toggleTransportMerge,
    transportRecordFor,
    mergeTransportPointsNow,
    splitTransportPointNow,
  } = transportPointsDomain

  /** 该单位的运输点数型号（数据层 `noncombatDetails.transportKind`） */
  function transportKindOf(unit: ConsoleUnit): string {
    return unit.noncombatTransportKind ?? 'truck'
  }

  /* ────────── C8e：12.7 延补队 ⇄ 运输点数的双向转换 ────────── */

  /*
   * B3-2b13（2026-11-21）：12.7 延补队 ⇄ 运输点数（7 个声明）搬进 `workbench-extenders.ts`。
   * 端口 9 项：`transportRecordFor` 来自 b12 的解构（本域装配在它之后）；
   * `specialPending` 是晚声明 `ref` 且本块**整体写入**待办对象 ⇒ 写穿回调（同 b11）。
   */
  const extendersDomain = createExtendersDomain({
    actingSide,
    phase,
    supplyFacts,
    units,
    pushLog,
    requireAction,
    PHASE_LABELS,
    transportRecordFor,
    setSpecialPending: (value) => {
      specialPending.value = value
    },
  })
  const {
    convertTransportToExtenderNow,
    flipExtenderToTransport,
    flipExtenderRecordInPlace,
    collapseExtenderNow,
    extenderLabelOf,
  } = extendersDomain

  /* ────────── C8f：16.0b/c 环形工事的修建与缩减（＋专规 1.3a 印刷工事） ────────── */

  /*
   * B3-2b14（2026-11-21）：本域 21 个声明搬进 `workbench-hedgehogs.ts`。
   * ★ 装配段**前移到「各动作的待点格入口」段之前**：`hedgehogInputs` 被 B27a 的
   *   `beginHedgehogHexPickNow` 写、`hedgehogLevelOf` 与 `hedgehogHexState` 被 C5 的建域参数
   *   按值传——三处都早于本段声明区，故域必须在那之前建好（见该处注释）。
   */

  /* ────────── C8g：15.3/15.4 空军基地 / 15.2A 简易机场（＋13.8d 施工前提） ────────── */

  /*
   * B3-2b17（2026-11-21）：15.3/15.4 空军基地与 15.2A 简易机场的 15 个声明搬进
   * `workbench-air-facility.ts`（装配在 supplyPhase 域之后、air 域之前）。
   * ★ 仅 `canEngineerInPhase` 留在这里：它读 `moveContext`（晚于装配点）且是 store 公开键。
   * ★ `engineerChoices` 也已搬走，用 deps 里的 `canEngineerInPhase`（`function` ⇒ 提升）。
   */

  /** 13.8a / 5.5b / 5.10e：该单位此刻是否具备工程能力（印值能力 × 模式） */
  function canEngineerInPhase(unit: ConsoleUnit): boolean {
    if (!engineerCapableNow(unit)) return false
    return isLegal(
      checkLegality(
        buildLegalityRequest({
          action: 'engineer',
          unit,
          context: moveContext.value,
          units: units.value,
          date: date.value,
          phase: phase.value,
        }),
      ),
    )
  }
  /*
   * 15.2E：简易机场**永不能被缩减**（伤害或玩家自愿都不行）
   *
   * ★ 判据只有一处：引擎的 `planAirBaseReduction` 在自家 `canReduceAirstrip()` 的分支里就把简易机场
   *   拒掉（`rule: '15.2E'`），操作台经 `airError` 原样显示。操作台**不另建**一份拒绝，免得两处漂移。
   */

  /* ──────────────── C9 空军交互：14.2f 任务 → 15.1 整备 / 14.11 转移 / 15.4 缩减 ──────────────── */

  /** C9：切任务类型（14.2e；换类型即作废进行中的流程） */
  function setAirMissionKind(kind: AirMissionKind): void {
    if (!airMissionDomain.canReplace()) return
    airMissionKind.value = kind
    airState.value = null
    airError.value = null
  }

  /** C9：选定任务格（14.2f-B 的目标；输入 `列.行` 文本） */
  function setAirTargetFromText(text: string): boolean {
    if (!airMissionDomain.canReplace()) return false
    const hex = parseHexPath(text)[0] ?? null
    if (hex === null) {
      pushLog('warning', `任务格格号应为「列.行」（如 36.13），收到「${text}」`, '14.2f-B')
      return false
    }
    airTargetHex.value = hex
    airInputs.value = { ...airInputs.value, targetHexText: hexTextOf(hex) }
    airState.value = null
    airError.value = null
    return true
  }

  /**
   * C9：勾选/取消一架参战飞机（14.2a 的合计上限与 14.2f 的加机窗口都由引擎裁定）
   *
   * ★ 四道闸都取引擎的**唯一实现**，不在界面里自算：
   *   · **14.1a** 非激活飞机不能执行任务（`canFlyMission`；用户 2026-09-18 报告第 8 条：
   *     「可执行空军任务的环节时点击机场，**未激活的飞机应该不可选中**」）；
   *   · **14.2f**「步骤 C 之后不能再向任务中添加飞机」（`canAddAircraftAtStep`）；
   *   · **14.2a** 一次任务合计上限 4 个空军单位（`canJoinMission`）；
   *   · **14.2e** 同一机一阶段只执行一次任务（`canPerformMissionThisPhase`）。
   *   已宣布任务中的减机须执行合法的主动返航，不能擦除任务状态。
   */
  function toggleAirMissionUnit(instanceId: string): void {
    const current = airState.value
    if (current !== null && !current.finished && airMissionAirIds.value.includes(instanceId)) {
      voluntaryReturnNow([instanceId])
      return
    }
    if (airMissionAirIds.value.includes(instanceId)) {
      airMissionAirIds.value = airMissionAirIds.value.filter((id) => id !== instanceId)
      airState.value = null
      airError.value = null
      return
    }
    const plane = airUnits.value.find((item) => item.instanceId === instanceId)
    if (current !== null && !current.finished && current.assignment.cargo.length > 0) {
      airError.value = { rule: '14.9a', reason: 'airCargoAlreadyLoaded' }
      pushLog('warning', '本次货物已装载，请完成任务后重新编组；不能通过改选飞机重复装载', '14.9a')
      return
    }
    /*
     * 14.1a：**非激活飞机不能执行任务** —— 这道闸放在最前：它是"这架飞机此刻的状态"，
     * 与"任务进行到哪一步"（14.2f）和"编成还剩几个名额"（14.2a）无关。非激活要靠 14.1d 的
     * 整备（15.1，A 段）转激活，故这里照 14.1d 指路。
     */
    if (plane !== undefined && !canFlyMission(plane.airStatus)) {
      airError.value = { rule: '14.1a', reason: `aircraftNotActive:${instanceId}` }
      pushLog(
        'warning',
        `14.1a：${plane.name} 处于**非激活**状态 ⇒ 不能执行任务；` +
          `需在**整备阶段**（15.1，A 段）整备后转激活（14.1d）`,
        '14.1a',
      )
      return
    }
    const step = airState.value?.step
    // 14.2f：「步骤 C 之后不能再添加飞机」；已结束（done）当然也不能
    const canAdd = step === undefined ? true : step === 'done' ? false : canAddAircraftAtStep(step)
    if (!canAdd) {
      airError.value = { rule: '14.2f', reason: `cannotAddAircraftAtStep:${String(step)}` }
      pushLog(
        'warning',
        `14.2f：任务已过**移动**步（当前 ${String(step)}）⇒ 不能再添加飞机；如需改变编成请先放弃本次任务并重新宣布`,
        '14.2f',
      )
      return
    }
    /*
     * 14.7d-B（第五批批 C 切片 3）：「低空扫射必须由**单独一个飞机**完成」
     * ⇒ 任务类型为低空扫射时，编成上限 1 架（放在 14.2a 的 4 架上限之前——更具体的限制优先）。
     */
    if (airMissionKind.value === 'hip_shoot' && airMissionAirIds.value.length >= 1) {
      airError.value = { rule: '14.7d-B', reason: 'hipShootMustBeSingleAircraft' }
      pushLog(
        'warning',
        '14.7d-B：低空扫射必须由**单独一个**飞机完成 ⇒ 不能再加机（如需换机请先取消已选）',
        '14.7d-B',
      )
      return
    }
    const join = canJoinMission(airMissionAirIds.value.length, 1)
    if (!join.ok) {
      airError.value = { rule: join.rule, reason: join.reason }
      pushLog(
        'warning',
        `14.2a：一次任务合计上限 4 个空军单位 ⇒ 不能再加（已选 ${airMissionAirIds.value.length} 架）`,
        '14.2a',
      )
      return
    }
    if (plane !== undefined && !canPerformMissionThisPhase(plane.missionsFlownThisPhase)) {
      airError.value = {
        rule: '14.2e',
        reason: `aircraftAlreadyFlewMissionThisPhase:${instanceId}`,
      }
      pushLog('warning', `${plane.name} 本阶段已执行过一次任务（14.2e：一阶段一次）`, '14.2e')
      return
    }
    airMissionAirIds.value = [...airMissionAirIds.value, instanceId]
    if (current !== null && !current.finished) {
      airMissionDomain.reset(true)
      if (!beginAirMissionNow()) {
        airMissionDomain.start(current)
        airMissionAirIds.value = [...current.assignment.aircraftIds]
      }
      return
    }
    airState.value = null
    airError.value = null
  }

  /**
   * C9：14.3d 的**主动返航**（空战前 / 空战后两个窗口，空战中一律不许）
   *
   * 判据只有引擎一处（`canVoluntarilyReturn`）；本处只把「窗口」与「返航后仍留几架激活」
   * 这两项盘面事实填进去。★ 14.3d-A：空战前允许部分返航，但**至少留 1 架**保持激活并战斗。
   */
  function voluntaryReturnNow(aircraftIds: readonly string[]): boolean {
    const state = airState.value
    if (state === null) {
      airError.value = { rule: '14.3d', reason: 'noMissionInProgress' }
      pushLog('warning', '先宣布任务，再谈主动返航（14.3d）', '14.3d')
      return false
    }
    if (
      state.finished ||
      state.step === 'returnToBase' ||
      state.cargo !== null ||
      (state.interception?.declared && state.interception.combat === null)
    ) {
      airError.value = { rule: '14.2f', reason: 'completePendingAirStepBeforeReturn' }
      return false
    }
    // 14.3d 的窗口由空战步是否已结算推出：未宣告空战 ⇒ 空战前；已结算 ⇒ 空战后；正在打 ⇒ 空战中
    const window: AirCombatWindow =
      state.combat === null
        ? 'beforeAirCombat'
        : state.airCombat === null && state.combat.occurs
          ? 'duringAirCombat'
          : 'afterAirCombat'
    const flying = airMissionAirUnits.value.filter((air) => air.airStatus === 'active')
    const leaving = flying.filter((air) => aircraftIds.includes(air.instanceId))
    if (leaving.length === 0 || state.finished || airCargoLossPending.value !== null) {
      airError.value = { rule: '14.3d', reason: 'noEligibleVoluntaryReturn' }
      return false
    }
    const returnedCargoIds = new Set<string>()
    if (state.assignment.cargo.length > 0 && leaving.length < flying.length) {
      /*
       * 14.9a/14.9e（T15）：只有能按逐机货单归属时，才允许载货任务部分返航；
       * 返航机把**自载**货物带回自己的基地。
       *
       * 14.9（T16）+ 专规 1.4a：离图盒起飞的机体同样可以途中部分返航——机体回盒、
       * 自载 SP 加回盒库存；其余机体**留场**继续任务（14.9e：各机按自身归宿分别处理）。
       * 离图盒不载地面单位（14.9a 装载单元只认图上同格来源），故这里只需处理 SP。
       */
      if (!hasCargoOwnership(state)) {
        airError.value = { rule: '14.9a', reason: 'partialCargoReturnUnsupported' }
        pushLog('warning', '载货任务请整组返航，或先完成卸载；当前货单无法归属部分返航', '14.9a')
        return false
      }
      const leavingOrigins = state.assignment.origins.filter((origin) =>
        leaving.some((air) => air.instanceId === origin.aircraftId),
      )
      for (const origin of leavingOrigins) {
        const ids =
          state.assignment.cargoByAircraft.find((entry) => entry.aircraftId === origin.aircraftId)
            ?.cargoIds ?? []
        const unitIds = ids.filter((id) => id.startsWith('unit:'))
        const spIds = ids.filter((id) => id.startsWith('sp:'))
        if (unitIds.length > 0) {
          if (!airUnitTransit.land(unitIds, origin.baseHex, 'returned')) return false
        }
        if (spIds.length > 0) {
          // 离图盒机：回任务来源盒（undefined ⇒ 用 manifest 的 originOffMapBox）；
          // 图上机场机：强制落地图格（null），避免混合来源时被误送进盒里。
          airSupply.returnRemaining(
            origin.baseHex,
            spIds,
            origin.fromOffMapBox === true ? undefined : null,
          )
        }
        ids.forEach((id) => returnedCargoIds.add(id))
      }
    }
    const verdict = canVoluntarilyReturn({
      window,
      friendlyActiveRemainingAfterReturn: flying.length - leaving.length,
    })
    if (!verdict.ok) {
      airError.value = { rule: verdict.rule, reason: verdict.reason }
      pushLog('warning', `主动返航被拒：${verdict.reason}（${verdict.rule}）`, verdict.rule)
      return false
    }
    if (state.assignment.cargo.length > 0 && leaving.length === flying.length) {
      if ((airMissionRosterNow.value?.lostCarriers ?? 0) > 0 && state.flak?.hit !== true) {
        airError.value = { rule: '14.9a', reason: 'cargoCarrierAllocationRequired' }
        return false
      }
      // 载货整组中止仍通过F/G提交，不能直接退款并擦除任务。
      for (const air of leaving) setAirStatus(air.instanceId, 'inactive')
      airState.value = { ...state, step: 'resolveMission' }
      if (!resolveAirCargoNow() || !confirmAirMissionNow()) return false
      return completeAirReturnNow()
    }
    const leavingIds = new Set(leaving.map((air) => air.instanceId))
    for (const air of leaving) {
      setAirStatus(air.instanceId, 'inactive')
      markAirMissionFlown(air.instanceId)
    }
    const remainingIds = state.assignment.aircraftIds.filter((id) => !leavingIds.has(id))
    if (remainingIds.length === 0) airSupply.returnRemaining()
    if (remainingIds.length === 0) recordAbortedAirBarrage(state)
    airState.value = {
      ...state,
      assignment: {
        ...state.assignment,
        aircraftIds: remainingIds,
        origins: state.assignment.origins.filter((origin) => !leavingIds.has(origin.aircraftId)),
        cargo: state.assignment.cargo.filter((item) => !returnedCargoIds.has(item.id)),
        cargoByAircraft: state.assignment.cargoByAircraft
          .filter((entry) => !leavingIds.has(entry.aircraftId))
          .map((entry) => ({
            ...entry,
            cargoIds: entry.cargoIds.filter((id) => !returnedCargoIds.has(id)),
          })),
      },
      ...(remainingIds.length === 0 ? { step: 'done', finished: true } : {}),
    }
    airMissionAirIds.value = airMissionAirIds.value.filter((id) => !leavingIds.has(id))
    airError.value = null
    pushLog(
      'success',
      `14.3d（${verdict.rule}）：${leaving.map((air) => air.name).join('、')} 主动返航 ⇒ 转非激活；` +
        `任务内仍留 ${flying.length - leaving.length} 架激活`,
      verdict.rule,
    )
    return true
  }

  /** C9 14.2e：当前任务类型所属的**环节**（移动 / 轰炸 / 拦截步），供界面标注与路由 */
  const airMissionSegment = computed<AirMissionSegment>(() =>
    missionSegmentOf(airMissionKind.value),
  )

  /** C9：本阶段还能加几架（14.2a 的余量；供界面禁用按钮与提示） */
  const airJoinRemaining = computed<number>(() => {
    const limit = canJoinMission(0, 0)
    const max = limit.ok ? limit.data.limit : 0
    return Math.max(0, max - airMissionAirIds.value.length)
  })

  /**
   * B14（用户口径⑪）：**参战机**的算子图阵列数据（逐机给出可选性与原因）
   *
   * 面板原先是一排文字按钮（名字 + ✓），既看不出是哪一枚算子，也看不出**为什么点不动**。
   * 四道闸都用引擎的唯一实现，本处只把结论逐机摊开：
   *   · **14.1a** 激活状态（`canFlyMission`；非激活飞机不能执行任务，需先按 14.1d 整备 15.1）；
   *   · **14.2f** 加机窗口（`canAddAircraftAtStep`；任务过移动步后不能再加）；
   *   · **14.2a** 一次任务合计上限（`canJoinMission`）；
   *   · **14.2e** 同一机一阶段只执行一次任务（`canPerformMissionThisPhase`）。
   * 已选中飞机的减机由 `toggleAirMissionUnit` 检查主动返航窗口。
   *
   * ★ 14.1a 的「起飞机必须停在本方空军基地格」**不在本闸内**：那条在**宣布任务**时
   *   由 `beginAirMissionNow` 经引擎裁定（此处标不了，也不该由界面去猜）。
   */
  const airMissionJoinChoices = computed<readonly AirMissionJoinChoice[]>(() => {
    /*
     * 专规 2.2d：苏军不得在本方反应 / 进击阶段出击（通规 14.1g 允许三段，专规覆盖苏联）。
     * 不可用的机不就该列进「参战机」阵列 —— 修前它照列，点进窗口后才在宣布时被 2.2d 拒。
     * 引擎侧判据仍在 `beginAirMissionNow`（旁路直接写状态仍会被拒）。
     */
    if (!airMissionAllowedInPhase.value) return []
    const step = airState.value?.step
    const canAdd = step === undefined ? true : step === 'done' ? false : canAddAircraftAtStep(step)
    const limit = canJoinMission(0, 0)
    const max = limit.ok ? limit.data.limit : 0
    const selectedCount = airMissionAirIds.value.length
    return ownAirUnits.value.map((air) => {
      const selected = airMissionAirIds.value.includes(air.instanceId)
      const disabledReason = selected
        ? null
        : !canFlyMission(air.airStatus)
          ? '14.1a：非激活飞机不能执行任务（14.1d：需在整备阶段 15.1 整备后才转激活）'
          : !canAdd
            ? `14.2f：任务已过移动步（当前 ${String(step)}）⇒ 不能再加机`
            : airMissionKind.value === 'hip_shoot' && selectedCount >= 1
              ? '14.7d-B：低空扫射必须由**单独一个**飞机完成 ⇒ 已选 1 架'
              : selectedCount >= max
                ? `14.2a：一次任务合计上限 ${max} 架 ⇒ 已满`
                : canPerformMissionThisPhase(air.missionsFlownThisPhase)
                  ? // 条 19（A1）：**按航程列机** —— 已定任务格时，够不到目标格的机在阵列里灰显（14.1）
                    airTargetHex.value !== null &&
                    airDistanceFromRealBase(air, airTargetHex.value) > air.rangeHexes
                    ? '14.1：该机航程够不到任务格'
                    : null
                  : '14.2e：本机本阶段已执行过一次任务'
      return { air, selected, disabledReason }
    })
  })

  /**
   * 用户 2026-11-09 追加批：**空军任务窗口按基地分栏**（只在轰炸 / 低空扫射时展开）
   *
   * 目的：玩家要判断 14.7c 的短程修正（全体参战机都在起飞基地 10 格内）时，得先把
   * 「哪架机在哪座基地、离任务格几格」摆在一屏。这里只做**分组与事实**，不判规则：
   *   · 基地＝本方空军基地（`ownAirBases`，15.0/15.2 的等级与简易机场照旧）；
   *   · 驻机＝该基地格上的本方飞机（`airUnitsAt`，只列停在这里的，不跨格凑数）；
   *   · 可选性 / 不可选原因直接取 `airMissionJoinChoices`（14.1a/14.2a/14.2e/14.1），
   *     本处不另写一份判据；
   *   · 距离＝到当前任务格的格距（14.2d），任务格未定就留空，不拿默认格去猜；
   *   · `withinShortRange` 只报「≤10 格」这一条**原文事实**（14.7c），且只在轰炸任务上
   *     有意义（低空扫射没有这条修正）；加成结论仍由引擎在宣布任务时给。
   */
  interface AirMissionBaseRosterItem {
    air: ConsoleAirUnit
    selected: boolean
    disabledReason: string | null
    distanceToTarget: number | null
    inRange: boolean | null
    withinShortRange: boolean
  }
  interface AirMissionBaseRoster {
    baseId: string
    hex: HexRef
    level: number
    isAirstrip: boolean
    aircraft: AirMissionBaseRosterItem[]
  }

  /** 最近一次点开的基地（面板上高亮这一栏；地图高亮走 `hoverHex`） */
  const airMissionBaseFocus = ref<string | null>(null)

  const airMissionBaseGroups = computed<AirMissionBaseRoster[]>(() => {
    // 用户 2026-11-12：所有主动任务都按基地分组列参战机（不再只限轰炸/低空扫射）
    if (airMissionKind.value === null) return []
    const side = airActingSide.value
    const target = airTargetHex.value
    const choices = new Map(
      airMissionJoinChoices.value.map((choice) => [choice.air.instanceId, choice] as const),
    )
    return ownAirBases.value
      .map((base) => {
        const aircraft = airUnitsAt(base.hex, side)
          // 用户 2026-11-12：只列能执行该任务的飞机（不能执行的整架不出现，不摆灰项）
          .filter((air) => airTypeCanPerformKind(air, airMissionKind.value as AirMissionKind))
          .map((air) => {
            const choice = choices.get(air.instanceId)
            const distance = target === null ? null : airDistanceFromRealBase(air, target)
            return {
              air,
              selected: choice?.selected ?? false,
              disabledReason:
                choice?.disabledReason ??
                (choice === undefined ? '14.2：本机不能执行该任务类型' : null),
              distanceToTarget: distance,
              inRange: distance === null ? null : distance <= air.rangeHexes,
              withinShortRange:
                airMissionKind.value === 'barrage' &&
                distance !== null &&
                distance <= SHORT_RANGE_BARRAGE_HEXES,
            }
          })
        return {
          baseId: base.id,
          hex: base.hex,
          level: base.level,
          isAirstrip: base.isAirstrip === true,
          aircraft,
        }
      })
      .filter((group) => group.aircraft.length > 0)
  })

  /**
   * 规格 §4（2026-11-10 裁定③）：**图外空军盒＝独立基地分组**
   *
   * 2.1C 只禁「地图外储存区域内不允许进行战斗」，未禁从盒里出击 ⇒ 盒内驻机
   * 与图上基地同构地参与第 1 步候选（取机范围、可选性、距离都与图上基地同一套）。
   * 盒没有真实格号 ⇒ `hex` 只取「盒连接列 × 目标行」作显示锚点（与 `airDistanceFromRealBase` 同源）。
   */
  const AIR_BOX_GROUP_ID = '__offmap_air_box__'

  const airBoxMissionGroup = computed<AirMissionBaseRoster | null>(() => {
    if (airMissionKind.value === null) return null
    const planes = ownAirUnits.value
      .filter((air) => isAirInOffMapBox(air))
      // 用户 2026-11-12：与图上基地同口径，只列能执行该任务的机型
      .filter((air) => airTypeCanPerformKind(air, airMissionKind.value as AirMissionKind))
    if (planes.length === 0) return null
    const choices = new Map(
      airMissionJoinChoices.value.map((choice) => [choice.air.instanceId, choice] as const),
    )
    const target = airTargetHex.value
    const aircraft = planes.map((air) => {
      const choice = choices.get(air.instanceId)
      const distance = target === null ? null : airDistanceFromRealBase(air, target)
      return {
        air,
        selected: choice?.selected ?? false,
        disabledReason: choice?.disabledReason ?? null,
        distanceToTarget: distance,
        inRange: distance === null ? null : distance <= air.rangeHexes,
        withinShortRange:
          airMissionKind.value === 'barrage' &&
          distance !== null &&
          distance <= SHORT_RANGE_BARRAGE_HEXES,
      }
    })
    return {
      baseId: AIR_BOX_GROUP_ID,
      hex: { col: airBoxEdgeColumn(airActingSide.value), row: target?.row ?? 0 },
      level: 0,
      isAirstrip: false,
      aircraft,
    }
  })

  /** 第 1 步候选分组：图上各基地（既有）＋ 图外盒（独立一组，同构） */
  const airMissionBaseGroupsWithBox = computed<AirMissionBaseRoster[]>(() => {
    const box = airBoxMissionGroup.value
    return box === null ? airMissionBaseGroups.value : [...airMissionBaseGroups.value, box]
  })

  /** 点某座基地 ⇒ 面板聚焦该栏 + 地图高亮该格（高亮通道就是已有的 `setHoverHex`） */
  function focusAirMissionBase(baseId: string): boolean {
    const base = ownAirBases.value.find((item) => item.id === baseId)
    if (base === undefined) return false
    airMissionBaseFocus.value = baseId
    setHoverHex(base.hex)
    return true
  }

  /**
   * 条 19（A1）：**按航程**判断——本方是否有**可出击**的飞机够得到目标格
   *
   * 用于「点地面格出空军对话框」的入口闸门（点一格才决定要不要开空军会话）。
   * 判据与 `barrageAirFacts` 的 `inRange` 同源：`airRangeFromBase(air, hex) <= air.rangeHexes`，
   * 另要求 14.1a 的 `canFlyMission`（非激活不出击）。真正航程校验仍在 `beginAirMissionNow`，
   * 此处只判"这一格值不值得开空军入口"。
   */
  function anyOwnAircraftReaches(hex: HexRef): boolean {
    return ownAirUnits.value.some(
      (air) => canFlyMission(air.airStatus) && airDistanceFromRealBase(air, hex) <= air.rangeHexes,
    )
  }

  /* ──────────── 三操作统一流程（2026-11-10 规格）：入口判据 + 候选集合（两处同源） ──────────── */

  /**
   * 10.1a：**能打到这一格**的炮兵（射程内、可轰炸、非预备/战略）
   *
   * 规格 §3 的硬要求：右键入口「该项是否出现」与窗内候选必须来自**同一个**筛选函数。
   * 13.4a 的预备/战略模式不参炸 ⇒ 直接从候选里剔除（不摆灰项）。
   */
  function barrageCandidatesAt(hex: HexRef): ConsoleUnit[] {
    const side = segmentGateQuery.value.side ?? activeSide.value
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
    if (!barrageKindsInSegment.value.includes('artillery')) return false
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
    const side = segmentGateQuery.value.side ?? activeSide.value
    /*
     * 剧本级炮击折扣（10.1b；Intro: Vitebsk 德军 −2T）必须与 `beginBarrage` 同口径：
     * 只在这里用原价判“付得起”会把折后 0T 的炮击误判成付不起，连右键「炮击」入口都不出现。
     */
    const cost = barrageTableWithScenarioRule(barrageTableMeta({ target, valueRange: total }), {
      scenarioId: scenarioId.value,
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
    const side = segmentGateQuery.value.side ?? activeSide.value
    const hasEnemyCombat = units.value.some(
      (unit) =>
        unit.side !== side && unit.isCombat && unit.hex.col === hex.col && unit.hex.row === hex.row,
    )
    if (!hasEnemyCombat) return null
    if (barrageEntryEligible(hex)) return null
    if (!barrageKindsInSegment.value.includes('artillery')) {
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
    actionRefusal.value = { key: 'barrage.declare', rule: reason.rule, reason: reason.reason }
  }

  /**
   * 专规 2.2d / 14.1g：**本阶段本方能否出击**（空军任务全链共用一条判据）
   *
   * 修前只有 `airMissionJoinChoices` 判这一条，`bombingEntryEligible` 只看环节闸 ⇒
   * 苏军进击段右键敌方格仍出「轰炸」，点进去参战机阵列是空的、宣布时才被 2.2d 拒。
   */
  const airMissionAllowedInPhase = computed<boolean>(() => {
    const airPhase =
      phase.value === 'reaction'
        ? 'reaction'
        : phase.value === 'exploitation'
          ? 'exploitation'
          : 'movement'
    return canMissionInPhase(airActingSide.value, airPhase)
  })

  /** 10.2c + 10.0e：**轰炸**这一项该不该出现（空军轰炸免补给 ⇒ 不判 10.1b） */
  function bombingEntryEligible(hex: HexRef): boolean {
    if (!actionAllowedNow('air.mission')) return false
    if (!airMissionAllowedInPhase.value) return false
    if (!airMissionKindChoices.value.some((item) => item.key === 'barrage')) return false
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
    const side = segmentGateQuery.value.side ?? activeSide.value
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
    if (airMissionSegmentKind.value !== 'movementSegment') return false
    if (!actionAllowedNow('air.mission')) return false
    if (airState.value !== null && !airState.value.finished) return false
    if (!canHipShoot(airActingSide.value, airInputs.value.weatherNormal)) return false
    if (!barrageFacts.value.hasSpotter(hex)) return false
    return hipShootCandidatesAt(hex).length > 0
  }

  /* ──────────── 9.14 特殊战斗：进入敌方设施格（落点由玩家选择） ──────────── */

  /**
   * 9.14e + 专规 1.3a：地图印刷工事的**当前归属**账本
   *
   * 地图印刷工事在数据层是**地形**（`map-layers.printedHedgehogs`：永久、不可降低），没有算子可翻面；
   * 但 9.14e 要求「可攻击单位进入 ⇒ 工事被夺取」，故须给它一个可变的归属。
   *  - 开局归属由剧本 `setup.printedHedgehogOwners.axisOwned` 给出（缺省＝苏联；剧本 1 全属苏联，
   *    其余剧本按德军推进线推导，见剧本数据里的 `rule` 原文）；
   *  - 本账本只存**与初设不同**的格（键＝`列.行`），9.14e 翻面时写入，避免与剧本数据重复。
   */
  const printedHedgehogOwners = ref<Record<string, Side>>({})

  /** 剧本给出的印刷工事**开局属德军**的格集合（按数值解析 `列.行`，兼容数据里的补零写法如 `07.08`） */
  const printedHedgehogAxisOwnedAtStart = computed<Set<string>>(() => {
    const keys = new Set<string>()
    for (const text of scenarioSetup.value?.printedHedgehogOwners?.axisOwned ?? []) {
      const hex = parseHexPath(text)[0]
      if (hex === undefined) continue
      keys.add(hexLabel(hex))
    }
    return keys
  })

  /** 9.14e：某格印刷工事的**当前归属**（翻转账本优先 → 剧本初设 → 缺省苏联） */
  function printedHedgehogOwnerAt(hex: HexRef): Side {
    const flipped = printedHedgehogOwners.value[hexLabel(hex)]
    if (flipped !== undefined) return flipped
    return printedHedgehogAxisOwnedAtStart.value.has(hexLabel(hex)) ? 'axis' : 'soviet'
  }

  /**
   * 9.14：把某格的**设施与后勤目标**整理成引擎的对象视图
   *
   * 数据来源（不臆造）：
   *   - 9.14b 补给站 ← SP 账本（12.1b：任何含 SP 的位置都是补给站；T 总量 = SP×4 + T）
   *   - 9.14c 运输点 ← 摆上的 `transport_point` / `organic_truck` 算子（点数取 `noncombatDetails.transport`，
   *     MA 取当前面）；9.14d 延补队 ← `supply_extender` 算子（拖取距离取当前面 MA）
   *   - 9.14e 环形工事 ← `hedgehog` 算子 **与地图印刷工事**（专规 1.3a；归属取剧本账本/9.14e 翻转结果）
   *   - 9.14f 空军基地 ← 空军基地算子（归属见 `airBases`）
   *
   * 舰船/港口本作不存在（专规 1.1c：双方皆无海运额度，港口仅装饰性）。
   */
  function specialObjectsAt(hex: HexRef): SpecialObjectView[] {
    const objects: SpecialObjectView[] = []
    // 9.14b：SP 账本（一方一条）
    for (const dump of spDumps.value) {
      if (!sameHex(dump.hex, hex)) continue
      objects.push({
        id: dump.id,
        kind: 'dump',
        hex: { col: hex.col, row: hex.row },
        owner: dump.side,
        // 12.1a：1 SP = 4 T
        spT: dump.sp * 4 + dump.t,
      })
    }
    // 9.14c/d：运输点与延补队（算子级）
    for (const unit of units.value) {
      if (!sameHex(unit.hex, hex)) continue
      if (unit.noncombatKind === 'transport_point' || unit.noncombatKind === 'organic_truck') {
        objects.push({
          id: unit.instanceId,
          kind: 'transport',
          hex: { col: hex.col, row: hex.row },
          owner: unit.side,
          transportPoints: Math.max(1, unit.noncombatTransport),
          transportMa: unit.raw.ma,
          organic: unit.noncombatKind === 'organic_truck',
          loadedSpT: unit.loadedSpT,
        })
        continue
      }
      if (unit.noncombatKind === 'supply_extender') {
        objects.push({
          id: unit.instanceId,
          kind: 'extender',
          hex: { col: hex.col, row: hex.row },
          owner: unit.side,
          /*
           * 12.7b：延补队的距离＝其**印值 MA**（印在**战斗面**，`faces.combat.ma`）。
           * ★ 此前写的是 `unit.raw.ma`（**当前面**）——延补队若以移动面摆放，`move.ma = 0`
           *   （实测：ax-extender-truck combat.ma=20 / move.ma=0）⇒ 9.14d 的位移半径会被算成 **0**。
           *   与 `toExtenderView`（12.7a-B 的回连判定用它）统一到同一口径。
           */
          rangeMp: unit.faces.combat.ma,
        })
        continue
      }
      if (unit.noncombatKind === 'hedgehog') {
        objects.push({
          id: unit.instanceId,
          kind: 'hedgehog',
          hex: { col: hex.col, row: hex.row },
          owner: unit.side,
          hedgehogLevel: Math.max(1, unit.noncombatLevel),
        })
      }
    }
    // 9.14e：地图印刷工事（专规 1.3a：永久、不可降低；归属取账本）
    const printed = getPrintedHedgehog(hex.col, hex.row)
    if (printed !== null) {
      objects.push({
        id: `printed-hog:${hexLabel(hex)}`,
        kind: 'hedgehog',
        hex: { col: hex.col, row: hex.row },
        owner: printedHedgehogOwnerAt(hex),
        hedgehogLevel: printed.level,
        permanent: true,
      })
    }
    // 9.14f：空军基地
    for (const base of airBases.value) {
      if (!sameHex(base.hex, hex)) continue
      /*
       * 专规 3.5：建造标记的简易机场**只**在苏方战斗单位进入其格时被摧毁（`noteUnitEnteredHex`），
       * 不按 9.14f 夺取 ⇒ 不进入特殊战斗的物件清单。
       */
      if (isConstructionMarkerAirBaseId(base.id)) continue
      objects.push({
        id: base.id,
        kind: 'airBase',
        hex: { col: hex.col, row: hex.row },
        owner: base.side,
        level: base.isAirstrip === true ? 0 : base.level,
        ...(base.isAirstrip === true ? { isAirstrip: true } : {}),
      })
    }
    return objects
  }

  /** 9.14：待玩家选择的位移/分配（null＝无待决） */
  const specialPending = ref<SpecialCombatPending | null>(null)

  /**
   * 9.14：跑一次「进入敌方设施格」的处置
   *
   * 触发前提（规则原文）：格内有**进入方的可攻击单位**。流程：
   *   ① 整理对象 → ② 掷夺取表骰（种子化 RNG，可复算）→ ③ 引擎给出结论 →
   *   ④ **能立即定的当场落盘**（dump 夺取+摧毁、基地夺取、工事夺取、运输点中**确定被夺取**者翻面）→
   *   ⑤ **需要玩家定的挂起**：运输点组分配（9.14c 混合类型时由原主挑）与**位移落点**（9.14c/d 由原主选）。
   *
   * @param byAdvance 是否由**战后推进**进入（9.14f 的 +2 DRM 来自此）
   * @param passingUnitIds 9.12f（撤退穿越）：给**途经**该格的单位 id。
   *   撤退结算时单位已落在终点格，中间格上没有它 ⇒ 默认「本格须有进入方可攻击单位」的判据会落空。
   *   9.12f 原文「撤退穿越非战斗单位、飞机和舰船时，同移动时穿越它们那样进行处理（根据 9.14）」
   *   ⇒ 穿越格也要按 9.14 处置，故这里允许以「途经名单」替代「此刻站在该格」。
   *   不给时维持原判据（移动 / 推进）。
   */
  function resolveSpecialCombatAt(
    hex: HexRef,
    enteringSide: Side,
    byAdvance = false,
    passingUnitIds?: readonly string[],
  ): boolean {
    const entered =
      passingUnitIds === undefined
        ? units.value.some(
            (unit) => unit.side === enteringSide && unit.attackCapable && sameHex(unit.hex, hex),
          )
        : passingUnitIds.some((id) => {
            const unit = units.value.find((item) => item.instanceId === id)
            return unit !== undefined && unit.side === enteringSide && unit.attackCapable
          })
    if (!entered) return false
    const objects = specialObjectsAt(hex)
    // 只处理**敌方**物件（友军进入自家设施无效果，引擎也会返回 unchanged）
    const enemyObjects = objects.filter((item) => item.owner !== enteringSide)
    if (enemyObjects.length === 0) return false
    groundMovement.markIrreversible('特殊战斗/缴获（9.14）')

    // ② 掷骰：只给本格实际出现的组掷（掷骰次数可复算）
    // ⑭ 接线：drawD6 只回报数字（不改它）⇒ 先记下掷骰前的骰源，按同一颗 PRNG 复算骰面
    const rngBefore = rng.value
    const dice: { dump?: number; trucks?: number; wagons?: number } = {}
    if (enemyObjects.some((item) => item.kind === 'dump')) {
      dice.dump = drawD6()
    }
    for (const group of ['trucks', 'wagons'] as const) {
      const present = enemyObjects.some(
        (item) => item.kind === 'transport' && transportGroupOf(item.transportMa ?? 0) === group,
      )
      if (!present) continue
      if (group === 'trucks') dice.trucks = drawD6()
      else dice.wagons = drawD6()
    }
    const rolls: DiceRoll[] = []
    let diceCursor = rngBefore
    for (const value of [dice.dump, dice.trucks, dice.wagons]) {
      if (value === undefined) continue
      const derived = roll1d6(diceCursor)
      diceCursor = derived.rng
      rolls.push(derived.value)
    }

    const mapHexes = mapLayers.hexes.map((item) => ({ col: item.col, row: item.row }))
    /*
     * 9.14d：追溯补给的**覆盖集**按方各算一次（`createTraceSupplyAt` 内按 side 缓存），
     * 整个 9.14 结算只付一次洪泛成本；之后每个候选格都是 O(1) 查表。
     */
    const traceSupplyAt = createTraceSupplyAt(supplyFacts.value)
    const outcome = acceptCombat(
      resolveSpecialCombat({
        hex,
        enteringSide,
        attackCapableUnitEnters: true,
        phase: phase.value,
        objects,
        dice,
        ...(enemyObjects.some((item) => item.kind === 'extender')
          ? {
              extenderCollapse: {
                // 候选池＝图内全部格；引擎再按**各延补队自身**的特殊拖取距离筛（9.14d）
                candidates: mapHexes,
                /*
                 * 9.14d：落点须「**该格此时拥有追溯补给**」。
                 *
                 * 接的是与补给面板**同一份**追溯事实（12.6a①② / 12.3b / 12.6c），机动类型缺省轮式
                 * （12.3a：计数默认按轮式 MP）。
                 *
                 * ★ 为什么这样接不会慢：`createTraceSupplyAt` 内部走 `traceCoverageHexes`——
                 *   **按方各算一次覆盖集**（从全部源反向洪泛一次），之后每格是 O(1) 查表。
                 *   早先直接逐格调 `hasTraceSupply` 会把上千个候选各洪泛一遍全图（5 秒以上、测试超时），
                 *   那是"查询方向"的问题，不是规则的问题；覆盖集与逐格结论的等价性由
                 *   `tests/engine/trace-supply.test.ts` 逐格断言把关。
                 */
                hasTraceSupplyAt: (factHex, factSide) => traceSupplyAt(factHex, factSide),
              },
            }
          : {}),
      }),
      '9.14 特殊战斗',
    )
    if (outcome === null) return false

    // 12.8a（用户 2026-11-13 口径）：延补队崩溃只改变「此刻源的连通性」，
    // 不重判其他单位的断补标记（标记保留到下一个友方补给阶段）。

    // ⑭ 接线：9.14 特殊战斗（夺取表 / 工事 / 空军基地 / 运输点 / 延补队）入会话日志。
    // 本笔只含夺取表骰（dump / trucks / wagons）；空军基地的逐机骰由 `captureAirBaseNow` 另记，
    // 故本笔在处置循环之**前**入账，以保证「夺取表骰 → 基地骰」的骰序与日志顺序一致。
    recordSettlement({
      action: 'specialCombat',
      rule: '9.14',
      rolls,
      data: {
        hex: { col: hex.col, row: hex.row },
        enteringSide,
        byAdvance,
        objects: outcome.objects.map((item) => ({
          id: item.id,
          kind: item.kind,
          result: item.result,
        })),
      },
    })

    const pending: SpecialCombatPending = {
      hex: { col: hex.col, row: hex.row },
      enteringSide,
      splits: [],
      items: [],
      notes: [],
      dice,
    }

    for (const result of outcome.objects) {
      if (result.result === 'unchanged') continue
      if (result.kind === 'dump') {
        if (result.result !== 'captured') continue
        // 9.14b：夺取部分并入进入方的账本（本格新建/合并），其余（原文）**被摧毁**
        const dump = spDumps.value.find((item) => item.id === result.id)
        if (dump === undefined) continue
        const capturedT = result.capturedT ?? 0
        if (capturedT > 0) grantSpDumpT(dump.hex, enteringSide, capturedT)
        spDumps.value = spDumps.value.filter((item) => item.id !== dump.id)
        pushLog('warning', `${hexLabel(dump.hex)}：${result.detail}`, '9.14b')
        pending.notes.push(result.detail)
        continue
      }
      if (result.kind === 'transport') {
        const unit = units.value.find((item) => item.instanceId === result.id)
        if (unit === undefined) continue
        const group = outcome.transportGroups.find(
          (item) => item.group === transportGroupOf(unit.raw.ma),
        )
        if (group === undefined) continue
        // 同一组只处理一次（`objects` 里**每个算子各有一条**结果）
        if (pending.splits.some((item) => item.group.group === group.group)) continue
        const ownerSide: Side = enteringSide === 'axis' ? 'soviet' : 'axis'
        const counters = units.value
          .filter(
            (item) =>
              sameHex(item.hex, hex) &&
              item.side === ownerSide &&
              (item.noncombatKind === 'transport_point' ||
                item.noncombatKind === 'organic_truck') &&
              transportGroupOf(item.raw.ma) === group.group,
          )
          .map((item) => ({
            id: item.instanceId,
            label: item.name,
            points: Math.max(1, item.noncombatTransport),
            loadedT: 0,
          }))
        const plan = planTransportSplit({ group, counters })
        const split: SpecialTransportSplit = {
          group,
          ownerSide,
          counters,
          capturedIds: [...plan.capturedUnitIds],
          exact: plan.exact,
          detail: plan.detail,
        }
        // 确定被夺取者**当场翻面**（归属改进入方）；位移者挂起等玩家点落点
        const captured = new Set(split.capturedIds)
        for (const counter of counters) {
          if (captured.has(counter.id)) continue
          pending.items.push({
            unitId: counter.id,
            label: counter.label,
            kind: 'transport',
            detail: `9.14c：本组掷 ${group.die} → ${group.percent}%；被夺取 ${group.capturedPoints}/${group.totalPoints} 点，其余位移`,
            candidates: transportDisplacementCandidates(hex, mapHexes),
            chosen: null,
          })
        }
        pending.splits.push(split)
        applyTransportSplitSides(pending, split)
        pushLog(
          'warning',
          `${hexLabel(hex)} 运输点夺取（9.14c）：掷 ${group.die} → ${group.percent}%；${plan.detail}`,
          '9.14c',
        )
        if (outcome.capturedTransportMayMoveNow) {
          // 9.14c：移动阶段被夺取的运输点**可以立即移动**（其余阶段不行）——同时入日志，
          //   免得「全部被夺取、无位移待决」时这条规则信息随待决一起消失
          const note = '9.14c：移动阶段被夺取的运输点可以立即移动（其余阶段不行）'
          pending.notes.push(note)
          pushLog('info', note, '9.14c')
        }
        continue
      }
      if (result.kind === 'extender') {
        const unit = units.value.find((item) => item.instanceId === result.id)
        if (unit === undefined) continue
        if (result.hex === null) {
          pushLog('warning', `${unit.name}：${result.detail}`, '9.14d')
          pending.notes.push(result.detail)
          continue
        }
        pending.items.push({
          unitId: unit.instanceId,
          label: unit.name,
          kind: 'extender',
          detail: result.detail,
          candidates: result.legalHexes.map((item) => ({ col: item.col, row: item.row })),
          chosen: result.hex === null ? null : { col: result.hex.col, row: result.hex.row },
        })
        continue
      }
      if (result.kind === 'hedgehog') {
        // 9.14e：工事被夺取（算子型按 21.11c 降 1 级；印刷永久工事按专规 1.3a 只翻归属）
        if (result.id.startsWith('printed-hog:')) {
          printedHedgehogOwners.value = {
            ...printedHedgehogOwners.value,
            [hexLabel(hex)]: enteringSide,
          }
        } else {
          const hog = units.value.find((item) => item.instanceId === result.id)
          if (hog !== undefined) {
            hog.side = enteringSide
            hog.noncombatLevel = result.hedgehogLevelAfter ?? Math.max(0, hog.noncombatLevel - 1)
            if (hog.noncombatLevel <= 0) {
              units.value = units.value.filter((item) => item.instanceId !== hog.instanceId)
            }
          }
        }
        pushLog('warning', `${hexLabel(hex)} 环形工事被夺取（9.14e）：${result.detail}`, '9.14e')
        pending.notes.push(result.detail)
        continue
      }
      if (result.kind === 'airBase') {
        captureAirBaseNow(result.id, byAdvance)
        pending.notes.push(result.detail)
      }
    }

    // 有位移/分配待决 ⇒ 挂起等玩家；否则本次 9.14 已结清
    if (pending.items.length > 0 || pending.splits.some((item) => !item.exact)) {
      specialPending.value = pending
    } else {
      specialPending.value = null
    }
    return true
  }

  /** 9.14c：把当前勾选落到算子归属上（被夺取 ⇒ 归进入方；其余 ⇒ 归原主） */
  function applyTransportSplitSides(
    pending: SpecialCombatPending,
    split: SpecialTransportSplit,
  ): void {
    const captured = new Set(split.capturedIds)
    for (const counter of split.counters) {
      const target = units.value.find((item) => item.instanceId === counter.id)
      if (target === undefined) continue
      target.side = captured.has(counter.id) ? pending.enteringSide : split.ownerSide
    }
  }

  /** 9.14c：改「哪些运输点算子被夺取」（原主的选择；点数须与表值相符，允许最接近） */
  function toggleSpecialCaptured(unitId: string): void {
    const pending = specialPending.value
    if (pending === null) return
    pending.splits = pending.splits.map((split) => {
      if (!split.counters.some((item) => item.id === unitId)) return split
      const capturedIds = split.capturedIds.includes(unitId)
        ? split.capturedIds.filter((id) => id !== unitId)
        : [...split.capturedIds, unitId]
      const chosen = new Set(capturedIds)
      const points = split.counters
        .filter((item) => chosen.has(item.id))
        .reduce((sum, item) => sum + item.points, 0)
      const plan = planTransportSplit({ group: split.group, counters: split.counters })
      const next: SpecialTransportSplit = {
        ...split,
        capturedIds,
        exact: points === split.group.capturedPoints,
        detail: `当前勾选：夺取 ${points} 点（表值 ${split.group.capturedPoints} 点）；引擎建议：${plan.detail}`,
      }
      // 归属随勾选即时翻面（9.14c 由拥有者决定哪些被夺取）
      applyTransportSplitSides(pending, next)
      return next
    })
  }

  /** 9.14c/d：为一项位移选定落点（由地图点格传入） */
  function setSpecialDisplacement(unitId: string, hex: HexRef): boolean {
    const pending = specialPending.value
    if (pending === null) return false
    const item = pending.items.find((entry) => entry.unitId === unitId)
    if (item === undefined) return false
    if (!item.candidates.some((candidate) => sameHex(candidate, hex))) {
      pushLog(
        'warning',
        `${hexLabel(hex)} 不是 ${item.label} 的合法位移落点（9.14c：格距上限内任意格；9.14d：拖取距离内且该格有追溯补给）`,
        item.kind === 'extender' ? '9.14d' : '9.14c',
      )
      return false
    }
    item.chosen = { col: hex.col, row: hex.row }
    pushLog(
      'info',
      `${item.label} 位移落点 → ${hexLabel(hex)}（${item.kind === 'extender' ? '9.14d' : '9.14c'}，由拥有者选择）`,
      item.kind === 'extender' ? '9.14d' : '9.14c',
    )
    return true
  }

  /** 9.14：结束本次特殊战斗（把位移落盘；未选落点者留在原格并记录） */
  function confirmSpecialCombatNow(): boolean {
    const pending = specialPending.value
    if (pending === null) return false
    // 9.14c：原主的勾选若拼不出表值（算子规格所限），如实提示差额，由裁判据情处理
    for (const split of pending.splits) {
      if (split.exact) continue
      pushLog(
        'warning',
        `${hexLabel(pending.hex)} ${split.group.group === 'trucks' ? '卡车' : '马车'}组：` +
          `夺取表 ${split.group.capturedPoints} 点，当前勾选 ${split.capturedIds.length} 个算子` +
          `（受算子规格所限取最接近，9.14c）`,
        '9.14c',
      )
    }
    for (const item of pending.items) {
      const unit = units.value.find((entry) => entry.instanceId === item.unitId)
      if (unit === undefined) continue
      if (item.chosen === null) {
        pushLog(
          'warning',
          `${item.label} 未选落点 ⇒ 留在原格（9.14c/d 的位移由拥有者选择；裁判可稍后手工处理）`,
          item.kind === 'extender' ? '9.14d' : '9.14c',
        )
        continue
      }
      if (item.kind === 'extender') {
        /*
         * 9.14d：「在新的格内，要将延补队**翻面到其常规运输点数的一面**。」
         * 数据层两面是两条记录（`ax-extender-truck` ↔ 5 点卡车运输点数）⇒ 翻面＝**换记录**。
         * 此前只写日志、把翻面留给裁判手工标注；现在落盘（12.7a 末句：崩溃的延补队可作为运输点数用）。
         */
        const flipped = flipExtenderRecordInPlace(unit, {
          col: item.chosen.col,
          row: item.chosen.row,
        })
        pushLog(
          flipped ? 'success' : 'warning',
          `${item.label} 崩溃位移至 ${hexLabel(item.chosen)}（9.14d）` +
            (flipped
              ? '，已翻面到运输点数面'
              : `；算子库缺少 ${extenderLabelOf(unit)} 的运输点数面 ⇒ 翻面未落盘`),
          '9.14d',
        )
        continue
      }
      unit.hex = { col: item.chosen.col, row: item.chosen.row }
      pushLog('success', `${item.label} 转移至 ${hexLabel(item.chosen)}（9.14c）`, '9.14c')
    }
    // ⑭ 接线：9.14 待决收束（位移落盘）入会话日志（本笔不掷骰；夺取表骰已在 specialCombat 记账）
    recordSettlement({
      action: 'specialCombat',
      rule: '9.14',
      data: {
        stage: 'confirm',
        hex: { ...pending.hex },
        enteringSide: pending.enteringSide,
        splits: pending.splits.map((split) => ({
          group: split.group.group,
          capturedIds: [...split.capturedIds],
          exact: split.exact,
        })),
        displacements: pending.items.map((item) => ({
          unitId: item.unitId,
          kind: item.kind,
          chosen: item.chosen === null ? null : { ...item.chosen },
        })),
      },
    })
    specialPending.value = null
    /*
     * 8.0 / 9.12g-D：位移待决解除后，若停在推进步的是一场**突袭**，则在此续上自动收束。
     * 时序说明：`confirmCombatRetreats` 遇到 `specialPending` 会先停在推进步（落点要玩家在地图上选），
     *   待决清空后没有第二次调用点 ⇒ 不在这里续上的话，突袭会永久卡在推进步。
     */
    fireResolution.resumeRetreatCrossings()
    settleOverrunAdvanceIfRequired()
    return true
  }

  /**
   * 8.0 / 9.12g-D：突袭的战后推进是**规则强制项**，不是玩家可选项。
   *
   *   8.0：「……如果该防御方撤退或被摧毁，**所有攻击单位都必须进入该格**（无需额外的移动消耗）。」
   *   9.12g-D：「**成功的突袭后必须战后推进**。但常规战斗后并非必须如此，由拥有者玩家选择
   *     哪些攻击单位进行推进（如果有的话）。」
   *
   * ⇒ 引擎 `resolveAdvanceAfterCombat` 对突袭一律返回「全部合格单位 + mandatory=true」，玩家的
   *   勾选对其无效；界面还让玩家再点一次"确认推进"，等于把强制项摆成可选项。故由 store 自动收束。
   *   常规战斗（9.12g-D 末句）**不**自动收束，仍停在推进步由玩家选择。
   *
   * 「是否成功」（防御格是否清空）由引擎依 `defendingHexCleared` 判，本处不另设口径。
   *
   * @returns 是否已收束推进步（false ⇒ 本场不是"待收束的突袭推进"，调用方按原路继续）
   */
  function settleOverrunAdvanceIfRequired(): boolean {
    const state = combatState.value
    if (state === null || state.finished) return false
    if (state.step !== 'advance' || state.attackType !== 'overrun') return false
    pushLog(
      'info',
      '8.0 / 9.12g-D：成功的突袭后**必须**战后推进（所有攻击单位进入该格，无额外 MP）⇒ 自动收束推进步',
      '9.12g-D',
    )
    return confirmCombatAdvance()
  }

  /** 9.14：放弃本次待决（位移不落盘；已即时落盘者不回滚） */
  function cancelSpecialCombatNow(): void {
    if (specialPending.value === null) return
    if (combatSupplyCommitted.value) {
      pushLog('warning', '战斗撤退或推进产生的位移必须完成，不能丢弃', '9.12f / 9.14')
      return
    }
    specialPending.value = null
    pushLog('info', '9.14 待决已关闭（位移未落盘；已定案的夺取不回滚）', '9.14')
    settleOverrunAdvanceIfRequired()
  }

  /** C9 第 3 步（14.2f-D / 14.5）：拦截应答（由对手决定，拦与不拦都不违法） */
  function declareInterceptionNow(): boolean {
    const state = airState.value
    if (state === null) return false
    const response = airInterceptionResponse.value
    if (response === null) {
      pushLog('warning', '请先定任务格（14.2f-B）', '14.2f-B')
      return false
    }
    const inputs = airInputs.value
    const declared = inputs.interceptDeclared && airMissionFlyingUnits.value.length > 0
    const data = acceptAir(
      declareInterceptionStep(state, {
        response,
        declared,
        ...(inputs.interceptorId === null ? {} : { interceptorId: inputs.interceptorId }),
      }),
      '拦截应答',
    )
    if (data === null) return false
    airState.value = data.state
    pushLog(
      'info',
      declared
        ? `拦截方宣布拦截（14.5）：1 架战斗机（不强制）`
        : '拦截方放弃拦截（14.5：不强制拦截）',
      '14.5',
    )
    // ⑭ 接线：拦截应答（14.5）入会话日志（本笔不掷骰；空战骰在 resolveInterceptionCombatNow）
    recordSettlement({
      action: 'airIntercept',
      rule: '14.5',
      data: {
        declared,
        interceptorId: inputs.interceptorId,
      },
    })
    return true
  }

  /** C9：结算 14.5 的拦截空战（14.3e 修正骰 + 损失骰），并把战果落到拦截机 */
  function resolveInterceptionCombatNow(): boolean {
    const state = airState.value
    if (state === null || state.interception === null) return false
    if (state.step !== 'flak' || state.interception.combat !== null) {
      airError.value = { rule: '14.5', reason: 'interceptionAlreadyResolvedOrClosed' }
      return false
    }
    const interceptorId = state.interception.interceptorId
    if (interceptorId === null) {
      pushLog('warning', '拦截方没有宣布拦截（14.5）', '14.5')
      return false
    }
    const interceptor = airUnits.value.find((air) => air.instanceId === interceptorId)
    if (interceptor === undefined) return false
    // 14.3e-B：防守方（任务方）从参战机中指定一架迎战；操作台取名单第一架
    /*
     * 14.3e-B：防守方（任务方）从参战机中**指定一架**迎战。
     * ★ B29 修：修前这里写死"名单第一架" —— 与条文不符（那是玩家的选择），现按点名取；
     *   未点名才回落"名单第一架"（引擎对 null 另有"取 ACV 最高"的缺省，此处与之一致）。
     */
    // 14.3e-B / 14.5：迎战机取"点名的那一架，未点名则 ACV 最高"（与引擎缺省同口径）
    const defender = airInterceptionDefender.value ?? undefined
    if (defender === undefined) {
      // 14.3e-B：迎战机由任务方从参战机中指定；名单为空时 E 步会被 `interceptionCombatPending`
      // 永远拒住 ⇒ 必须把原因写进 `airError`，否则界面只剩「结算防空(被拒)」而没有可点出口。
      airError.value = { rule: '14.3e-B', reason: 'noDefenderToEngage' }
      pushLog('warning', '任务机名单为空（14.3e-B）：没有可迎战的飞机', '14.3e-B')
      return false
    }
    // ⑭ 接线：drawAir2d6 / drawAir1d6 只回报数字（不改它们）⇒ 记下掷骰前的骰源，按同法复算骰面
    let diceCursor = rng.value
    const die = airInputs.value.interceptDie ?? drawAir2d6()
    const rolls: DiceRoll[] = []
    if (airInputs.value.interceptDie === null) {
      const derived = roll2d6(diceCursor)
      diceCursor = derived.rng
      rolls.push(derived.value)
    }
    const lossDie = airInputs.value.interceptLossDie ?? drawAir1d6()
    if (airInputs.value.interceptLossDie === null) {
      const derived = roll1d6(diceCursor)
      diceCursor = derived.rng
      rolls.push(derived.value)
    }
    const data = acceptAir(
      resolveInterception({
        // 14.1b/14.3e：两侧的 ACV 都取**当前面**（减损机用减损面值）
        interceptor: {
          id: interceptor.instanceId,
          airCombatRating: airCombatRatingOf(interceptor),
        },
        defender: { id: defender.instanceId, airCombatRating: airCombatRatingOf(defender) },
        die,
        lossDie,
      }),
      '拦截空战',
    )
    if (data === null) return false
    airState.value = { ...state, interception: { ...state.interception, combat: data } }
    // 14.5：胜 ⇒ 回起飞基地并保持激活；败（含双方返航）⇒ 非激活
    setAirStatus(interceptor.instanceId, data.interceptorAirStatus)
    if (data.combat.abortSide === 'defender' || data.combat.abortSide === 'both')
      setAirStatus(defender.instanceId, 'inactive')
    // 14.3e-C：损失骰 5–6 ⇒ **返航的单位或单位们**各损 1 点军力（双方返航 ⇒ 两机都掉；
    // 修前用三元式只给一边，与引擎 `stepLossIds` 的口径不符）
    if (data.combat.winnerLossRoll === 'step_loss') {
      for (const id of data.stepLossIds) applyAirStepLoss(id)
    }
    pushLog(data.interceptorWon ? 'success' : 'warning', data.detail, '14.5')
    // ⑭ 接线：拦截空战（14.5 / 14.3e）入会话日志；rolls＝2 骰 + 1 损失骰
    recordSettlement({
      action: 'airInterceptCombat',
      rule: '14.5',
      rolls,
      data: {
        interceptorId,
        defenderId: defender.instanceId,
        die,
        lossDie,
        interceptorWon: data.interceptorWon,
        interceptorAirStatus: data.interceptorAirStatus,
        winnerLossRoll: data.combat.winnerLossRoll,
        abortSide: data.combat.abortSide,
        detail: data.detail,
      },
    })
    return true
  }

  /* ────────── W6 B18：到达、补员与编制调整（13.5 / 13.6 / 13.9 / 20.0 / 专规 1.6 / 2.1 / 2.3b / 2.3c / 2.4） ────────── */

  /**
   * 当前剧本
   *
   * ★ 联调（**单一权威**）：剧本号的唯一权威是**会话 store**（`session.scenarioId`，未开局也存在）；
   * 本处只做投影 ⇒ 换剧本 / 读档后，操作台、容器抽取盒、初设面板**同时**跟随，不可能各存一份。
   * 写入请走 `setScenarioId`（它会在剧本被会话锁定时整段拒绝，不做半更新）。
   */
  const scenarioId = computed<string>(() => session.scenarioId)
  /*
   * 13.3f / 专规 1.2：初始换轨账本由**下方 `refreshScenarioBoundLedgers` 的 watch**（`immediate: true`）
   * 统一落账——本处**不再**各写一遍，避免"多入口各自刷新"再次漏掉某一条路径（读档就是漏网的那条）。
   */
  /*
   * 13.5 / §5-D（用户 2026-10-25 裁定「规则字面，一次掷骰给 5 点就摆 5 枚」）：
   * **Pax / Eq 补员是盘面算子**（每 1 点一枚 `Pax Repl` / `EQ Repl`），
   * 与普通算子同链移动、堆叠、被攻击、被轰炸摧毁；Ftr / Tac 按专规 1.6（只补 1 step 且
   * **不可保存**）继续走账本，不做盘面算子。
   *
   * 于是这里只剩两份状态：
   *   · `replPending`：掷出后**尚未放置**的 Pax / Eq（SOP：「掷可变增援表，并将相应的结果放置在
   *     地图上」——落点由裁判选格，放置前不在盘面、也不能用于重建）；
   *   · `replFtrTac`：Ftr / Tac 账本（增援阶段末清零，见 `clearNonSavableReplNow`）。
   * 盘面上的枚数一律**从 `units` 现算**（`replBoardCounts`）——不另存一份，避免双源漂移。
   */
  const replPending = ref<{ pax: number; eq: number }>({ pax: 0, eq: 0 })
  const replFtrTac = ref<{ ftr: number; tac: number }>({ ftr: 0, tac: 0 })

  /** 13.5：可保存补员的两族——放置策略与落点都按族分开（Pax / Eq 是独立算子） */
  type SavableReplKind = 'pax' | 'eq'

  /** 盘面上（当前方）的补员算子枚数（§5-D：唯一事实，按格可再筛） */
  const replBoardUnits = computed<ConsoleUnit[]>(() =>
    units.value.filter((unit) => unit.side === activeSide.value && isReplUnit(unit)),
  )

  /** 全盘（不分格）的 Pax / Eq 合计——面板显示与"够不够重建"的总量口径 */
  const replBoardCounts = computed<{ pax: number; eq: number }>(() => {
    let pax = 0
    let eq = 0
    for (const unit of replBoardUnits.value) {
      if (unit.replKind === 'pax') pax += 1
      else if (unit.replKind === 'eq') eq += 1
    }
    return { pax, eq }
  })

  /**
   * 补员总账（**投影**：盘面 Pax/Eq + 账本 Ftr/Tac）
   *
   * 只读——写路径是"摆/移除补员算子"与 `replFtrTac`；保留这个 computed 是为了让面板
   * 与引擎请求继续用同一个 `ReplHoldings` 形状，不必各处各拼一份。
   */
  const replHoldings = computed<ReplHoldings>(() => ({
    pax: replBoardCounts.value.pax,
    eq: replBoardCounts.value.eq,
    ftr: replFtrTac.value.ftr,
    tac: replFtrTac.value.tac,
  }))

  /** 13.5a：某一格里的 Pax / Eq 补员枚数（"所需补员必须都在一个格中"由结构保证） */
  function replCountsAtHex(hex: HexRef): { pax: number; eq: number } {
    let pax = 0
    let eq = 0
    for (const unit of replBoardUnits.value) {
      if (unit.hex.col !== hex.col || unit.hex.row !== hex.row) continue
      if (unit.replKind === 'pax') pax += 1
      else if (unit.replKind === 'eq') eq += 1
    }
    return { pax, eq }
  }

  /**
   * §5-D：在指定格摆 `count` 枚补员算子（每点一枚；库里没有该族记录 ⇒ 拒绝并说明）
   *
   * 实例 id 走 `arr-repl` 前缀，与到达投放区分（便于日志与存档核对）。
   */
  function placeReplCounters(hex: HexRef, kind: ReplKind, count: number): boolean {
    const total = Math.max(0, Math.trunc(count))
    if (total === 0) return true
    const record = replRecordOf(activeSide.value, kind)
    if (record === null) {
      pushLog('danger', `单位库里没有 ${kind === 'pax' ? 'Pax' : 'EQ'} 补员算子（13.5）`, '13.5')
      return false
    }
    const created: ConsoleUnit[] = []
    for (let index = 0; index < total; index += 1) {
      created.push(
        toConsoleUnit({
          record,
          instanceId: createId('arr-repl'),
          hex: { ...hex },
          side: activeSide.value,
        }),
      )
    }
    units.value = [...units.value, ...created]
    return true
  }

  /** §5-D：从盘面移除 `count` 枚某一族的补员（重建成功路径调用；按实例 id 逐枚摘） */
  function removeReplCounters(hex: HexRef, kind: ReplKind, count: number): void {
    const total = Math.max(0, Math.trunc(count))
    if (total === 0) return
    const victims = replBoardUnits.value.filter(
      (unit) => unit.replKind === kind && unit.hex.col === hex.col && unit.hex.row === hex.row,
    )
    const doomed = new Set(victims.slice(0, total).map((unit) => unit.instanceId))
    if (doomed.size === 0) return
    units.value = units.value.filter((unit) => !doomed.has(unit.instanceId))
    if (selectedId.value !== null && doomed.has(selectedId.value)) selectedId.value = null
  }
  /**
   * 死亡堆（13.5a 重建来源；**地面与空军共用**——用户裁定，依据 14.1b 飞机亦可重建）
   *
   * ★ 注意与 1.6a 的**移除**区分：被到达卡 Removal 的算子**离开游戏**（不在这里），
   *   见 `removeFromPlayEverywhere`；两者原先被混为一谈（移除也进死亡堆）。
   */
  const deadPile = ref<DeadPileEntry[]>([])
  /** 永久移除（13.5c：AR 后有黄点者被摧毁即永久移出） */
  const removedForever = ref<ConsoleUnit[]>([])
  /**
   * 拆分单位算子池（20.0g：同国籍共用）
   *
   * 初值 = 专规 1.8a 的**印量上限**（轴 28×AR4 + 2×AR5、苏 6×AR2 + 2×AR3，取自工程库
   * `counter_limits`）；键用单位库 id 的国籍前缀（`ax` / `su`，与 `createBreakdownNow` 的取键同规），
   * 裁判可按实物算子增删。
   */
  const breakdownPool = ref<Record<string, number>>({
    ax: breakdownPoolTotal('axis'),
    su: breakdownPoolTotal('soviet'),
  })
  /**
   * 可变增援的骰面（由裁判填入或点「掷」自动取种子化 RNG）
   *
   * 1.6c 不在这一批：原文「also get to roll a die on their Special Repl Table」是独立一掷，
   * 由 `drawSpecialRepl` 在执行时自掷（见 `variableReplSpecialDie`）。
   */
  const variableReplInputs = ref({
    supplyDice: 7,
    replDice: 7,
    variableExitDie: 1,
    randomEventDice: 7,
    autoRoll: true,
  })

  /**
   * 3.3c：可变撤离是否**已了结**
   *
   * 「轴方在 19 August 之后的每个增援阶段掷 1 骰：1 ? 移除 SS Reich（全部）、6 ? 移除 14 Mtr（全部）、
   *  2–5 ? 下回合再掷」⇒ 一旦掷出 1 或 6，该判定**结束**（不再逐回合掷）。
   * 修前这个 `variableExitResolved` 从未被传入 ⇒ 撤离骰可以无限重复掷。
   */
  const variableExitResolved = ref<boolean>(false)

  /**
   * 3.3c：本局是否已在**开局**掷过可变撤离（剧本 7 专规 `Roll for Variable Exit (3.3c).`）
   *
   * 只认本局结算日志里的 `mode: 'setupRoll'` 条目 ⇒ 存档/读档后同一局不会重复掷；
   * 掷出 2–5 时它仍为 true（已掷过），但 `variableExitResolved` 为 false，下个轴方增援阶段续掷。
   */
  const variableExitStartRolled = computed<boolean>(() =>
    session.log.some((entry) => {
      if (entry.action !== 'variableExit' || !entry.outcome.ok) return false
      return (entry.outcome.data as { mode?: unknown }).mode === 'setupRoll'
    }),
  )

  /**
   * 3.3c：待玩家选择的替补（**从 `session.log` 反推**，不新增存档字段）
   *
   * 撤离目标编队"盘面与死亡堆都没有算子"时（1.6a 的 "or else a unit with identical factors"），
   * 掷骰那次会落一条 `mode: 'select'` 的结算；确认移除落 `mode: 'confirm'`。
   * ⇒ 从日志末尾往前找**第一条** `variableExit` 条目即可判定"是否仍在等玩家选"，
   *   存档 → 读档后日志还在，选择态自然恢复（无需为它动 save schema）。
   */
  const variableExitPendingSelection = computed<{ removedUnit: string; formation: string } | null>(
    () => {
      const entry = [...session.log].reverse().find((item) => item.action === 'variableExit')
      if (entry === undefined || !entry.outcome.ok) return null
      const data = entry.outcome.data as unknown as {
        mode?: unknown
        removedUnit?: unknown
        formation?: unknown
      }
      if (data.mode !== 'select') return null
      if (typeof data.removedUnit !== 'string' || typeof data.formation !== 'string') return null
      return { removedUnit: data.removedUnit, formation: data.formation }
    },
  )

  /** 3.3c：当前是否处于可变撤离的窗口内（19 Aug 起；供界面提示与按钮可用性） */
  const variableExitOpen = computed<boolean>(() => isVariableExitActive(date.value))
  /**
   * ② 按方不渲染：3.3c 可变撤离是**轴方专规**内容
   *
   * 界面只在轴方回合画这一段（含"已了结/未了结"状态行与替补选择）；
   * 苏方回合根本不渲染 —— 不是变灰、不是不可点。判据只取 `activeSide` 与日期事实。
   */
  const variableExitForActiveSide = computed<boolean>(
    () =>
      activeSide.value === 'axis' && (variableExitOpen.value || variableExitSelectionOpen.value),
  )
  /** 最近一次可变增援结论（1.6b / 1.6c / 3.3c / 3.6） */
  const lastVariableRepl = ref<VariableReinforcementPlan | null>(null)
  /**
   * 1.6c：本回合**实际掷出**的特殊补员骰（由 `drawSpecialRepl` 在 1.6c 执行时自掷）
   *
   * 1.6b 的骰只归 1.6b；1.6c 原文「also get to roll a die」是独立一掷，不复用 1.6b 的骰面。
   * 这里只做留痕（存读档 / 台账），不参与 1.6b 的结算。
   */
  const variableReplSpecialDie = ref<number | null>(null)
  /** 裁定 2：1.6b 补给表 SP 已入图外盒的记账（换掷先撤回上一笔，避免重掷叠加） */
  const offMapRollDeposit = ref<{ turn: number; side: Side; sp: number; t: number } | null>(null)

  /** 裁定 2：图外空军盒 SP 的账本键（与 14.9 空运退运保持同一套 `side:box`） */
  function offMapBoxSupplyKey(side: Side): string {
    return `${side}:${side}`
  }

  function addOffMapSupplyT(side: Side, deltaT: number): void {
    const key = offMapBoxSupplyKey(side)
    const current = offMapSupplyStocks.value[key] ?? { sp: 0, t: 0 }
    offMapSupplyStocks.value = {
      ...offMapSupplyStocks.value,
      [key]: tToHoldings(Math.max(0, holdingsToT(current) + deltaT)),
    }
  }

  /**
   * 裁定 2：把 N T 补给放进**图外空军盒**（1.6b Notes：extra SP 只能空运进图）
   *
   * 复用 `offMapSupplyStocks`，不新造第二套账；盒内 SP 不能直接给地图单位供给，
   * 只能在合法阶段由 14.9 空运任务运进地图。
   */
  function depositOffMapSupplyNow(side: Side, t: number): boolean {
    const amount = Math.max(0, Math.trunc(t))
    if (amount <= 0) return false
    addOffMapSupplyT(side, amount)
    pushLog(
      'info',
      `有补给进入图外盒（${String(amount / SP_TO_T)} SP）：只能用空军任务运进地图（1.6b / 14.9）`,
      '1.6b',
    )
    recordSettlement({
      action: 'offMapSupplyDeposit',
      rule: '1.6b',
      data: { side, t: amount },
      // 这笔是随掷表自动发生的附带结算，不得吃掉 1.6b 那批骰（否则重放游标错位）
      consumePendingRolls: false,
    })
    return true
  }

  /** 裁定 2：盒内 SP 的界面投影（供空军盒卡片显示） */
  function airBoxSupply(side: Side): { sp: number; t: number } {
    return offMapSupplyStocks.value[offMapBoxSupplyKey(side)] ?? { sp: 0, t: 0 }
  }

  /** 最近一次重建结论（13.5） */
  const lastRebuild = ref<RebuildPlan | null>(null)
  /** 最近一次合并结论（13.9） */
  const lastConsolidation = ref<ConsolidationPlan | null>(null)
  /** 最近一次拆分结论（20.0） */
  const lastBreakdown = ref<{ detail: string; rule: string } | null>(null)
  /** B18 的错误（统一形状：rule + reason） */
  const reinforcementError = ref<{ rule: string; reason: string } | null>(null)
  /** 裁判手改的到达落点（键 = 到达需求下标；缺省用引擎解算的格） */
  const arrivalHexOverrides = ref<Record<number, HexRef>>({})

  /**
   * 专规 1.1b：双方**安全边缘格**（作为补给源的地图边格）
   *
   * 「敌方地面单位不得进入；这些格可以被常规战斗攻击，但不可被突袭（因为可能需要推进）。」
   * 数据即地图库的**字母入场段**（专规 2.1/3.1；用户 2026-11-11 追加裁定），按方取表。
   *
   * ★ 2.1a：**已关闭的源不再享受 1.1b 保护**——Entry L（19 Jul 起）与 Entry E 及以西南缘源
   *   （19 Aug 起）关闭后若仍计入，会让轴军进不去本应可进的格（过度限制）。
   */
  const safeEdgeHexesBySide = computed(() => {
    const openSources = (side: Side): HexRef[] => {
      const hexes = ENTRY_EDGE[side].hexes
      const statuses = supplySourceStatuses({
        side,
        date: date.value,
        sources: hexes,
        facts: SHUTDOWN_FACTS,
      })
      const open = new Set(statuses.filter((item) => item.open).map((item) => hexLabel(item.hex)))
      return hexes.filter((hex) => open.has(hexLabel(hex))).map((hex) => ({ ...hex }))
    }
    return {
      axis: openSources('axis'),
      soviet: openSources('soviet'),
    }
  })

  /** 当前方的图边补给源格（2.1 / 3.1：地图库字母入场段，按方取表） */
  const scenarioSupplySourceHexes = computed<HexRef[]>(() =>
    ENTRY_EDGE[activeSide.value].hexes.map((hex) => ({ ...hex })),
  )

  /**
   * 专规 2.1a：**当日仍开放**的图边补给源格
   *
   * 原文（2.1a）：「These supply sources cease to exist on fixed dates: **Entry L on 19 July**.
   *   **Entry E (and all South edge sources west of there) on 19 August**.」
   *
   * ★ 修（2026-11-01）：`scenarioSupplySourceHexes` 取 **字母入场段、不看日期**，
   *   而 2.1/3.1 的落点规则是「其余 SP 放**图边补给源格**」「补员/突围返场同理」——
   *   关停之后那些格**不再是补给源**，却仍能接货。修前 `arrivalFacts.edgeSupplySourceHexes()`
   *   与免费铁运的余额落点都直接用原始清单 ⇒ 19 Jul 之后还能往 20.35 塞 SP。
   *   现在两处都改用本投影（与 1.1b 的 `safeEdgeHexesBySide` 同一份判据、同一份事实）。
   */
  const openSupplySourceHexes = computed<HexRef[]>(() => {
    const statuses = supplySourceStatuses({
      side: activeSide.value,
      date: date.value,
      sources: scenarioSupplySourceHexes.value,
      facts: SHUTDOWN_FACTS,
    })
    const open = new Set(statuses.filter((item) => item.open).map((item) => hexLabel(item.hex)))
    return scenarioSupplySourceHexes.value.filter((hex) => open.has(hexLabel(hex)))
  })

  /**
   * 专规 2.1 / 3.1 ＋ 12.6a①（用户 2026-11-13 裁定）：**补给源 = 允许增援入场的图边铁路格 ∪ 点名的其它源**
   *
   *   2.1（苏）：「Map-edge hexes **east of 12.xx** where **any type of road or railroad
   *     enters the map** are Soviet supply sources.」
   *   3.1（轴）：「Map-edge hexes **west of 10.xx** where **any type of road or railroad
   *     enters the map** are Axis supply sources.」
   *   12.6a①（用户）：「允许增援入场的地图边缘铁路格，加上游戏专属规则中提到的其他补给源。」
   *
   * 合并口径由 `railEntrySupplySources` 唯一实现：
   *   剧本 `supplySources`（`42.35` / `4.00` 这类无字母的源）∪ `ENTRY_EDGE[side] ∩ 铁路格`；
   *   2.1a 的关闭（Entry L 19 Jul；Entry E 及以西的南缘源 19 Aug）仍按日期过滤。
   */
  const openSourceHexesBySide = computed<Record<Side, HexRef[]>>(() => {
    const current = scenarios.scenarios.find((item) => item.id === scenarioId.value)
    const read = (list: readonly string[] | undefined): HexRef[] =>
      (list ?? [])
        .map((text) => parseHexPath(text)[0])
        .filter((hex): hex is HexRef => hex !== undefined)
    const pick = (side: Side, list: readonly string[] | undefined): HexRef[] =>
      railEntrySupplySources({
        side,
        date: date.value,
        entryHexes: mapConfig.entryHexes ?? {},
        extraSources: read(list),
        isRailHex: isRailHexAt,
        facts: SHUTDOWN_FACTS,
      })
    return {
      axis: pick('axis', current?.supplySources?.axisLive),
      soviet: pick('soviet', current?.supplySources?.sovietLive),
    }
  })

  /**
   * 专规 2.1 / 3.1（用户 2026-11-12 裁定）：**两张进场铁路网的种子**
   *
   * 原文没有「转换规矩」的铁路 ⇒ 不存在交叉可用，也没有共用段：整段铁路自然归其中一方。
   * 两网各自从本方**进场铁路**出发做连通性 BFS，种子判据：
   *   本侧图边补给源（2.1/3.1 的地理判据，见 `openSourceHexesBySide`）∩ 铁路格 ∩ 当日仍开放（2.1a）。
   * ★ 不再是「字母入场段」：`42.35`（苏）与 `4.00`（轴）是源但不是字母入口，同样作种子。
   * 多轨与单轨的差别只是 13.3c 的运量费用，**不参与归属判定**。
   */
  const entryRailSeedsBySide = computed<{ axis: HexRef[]; soviet: HexRef[] }>(() => {
    const pick = (side: Side): HexRef[] =>
      openSourceHexesBySide.value[side].filter((hex) => isRailHexAt(hex))
    return {
      axis: pick('axis'),
      soviet: pick('soviet'),
    }
  })

  /**
   * 13.5a：可作重建圆心的**友方指挥部**格
   *
   * 原文：「所需的补员必须都在一个格中，且要在一个友方指挥部的 2 格内（含 2 格）。
   *   **该指挥部必须处于战斗模式，或处于 DG 模式但朝向战斗模式面（根据 5.10e）**。
   *   该格不可在敌方 ZOC 内（4.5a）。」
   *
   * ★ 修（2026-10-30）：修前重建与"2.1 注的到达落点"共用 `arrivalFacts.directDrawHqHexes()`，
   *   而那一条只要求「能直接拖取追溯补给的 HQ」、**不要求战斗模式** ⇒ 移动模式的 HQ 也被当成重建圆心
   *   （与 13.5a 原文相反）。现在两者分开：到达落点照旧，重建圆心另用本投影。
   */
  const rebuildHqHexes = computed<HexRef[]>(() =>
    units.value
      .filter(
        (unit) =>
          unit.side === activeSide.value &&
          (unit.specialized.includes('hq') || unit.throwRange !== null),
      )
      .filter(
        (unit) =>
          // 战斗模式（DG 时 `applyDgToUnit` 会把 mode 折成朝向，故朝战斗面的 DG 也落在第一支）
          unit.mode.mode === 'combat' ||
          (unit.mode.dg === true && unit.mode.orientation === 'combat'),
      )
      .map((unit) => ({ ...unit.hex })),
  )

  /**
   * 专规 2.1 / 3.1 的「by direct draw」判据事实（只服务 `directDrawHqHexes`）
   *
   * 源取三样，缺一不可：
   *   ① 剧本图边补给源（2.1/3.1 的权威清单，已按 2.1a 过滤关停）——**不能漏**：
   *      `supplyFacts` 只收玩家声明的源，若拿它来判，未声明源时所有 HQ 都会判成"断补"；
   *   ② 玩家声明的 12.6a① 源；③ 13.3c 派生的卸货格（12.6a②）。
   * 延补队由 `createSupplyFacts` 按在场单位自动收（12.6a③）。
   */
  const arrivalDirectDrawFacts = computed(() =>
    createSupplyFacts({
      units: units.value,
      turn: turn.value,
      dumps: allSpDumps.value.map((dump) => ({ hex: dump.hex, side: dump.side })),
      sources: [
        ...supplySourceDecls.value
          .filter((decl) => decl.kind !== 'detrainable')
          .map((decl) => ({ hex: decl.hex, side: decl.side, kind: decl.kind })),
        ...openSupplySourceHexes.value.map((hex) => ({
          hex,
          side: activeSide.value,
          kind: 'supplySourceHex' as const,
        })),
        ...railSupplyBySide.value[activeSide.value].detrainableHexes.map((hex) => ({
          hex,
          side: activeSide.value,
          kind: 'detrainable' as const,
        })),
      ],
    }),
  )

  /** 13.6 / 13.6b 的落点事实（引擎不持地图，故由操作台注入） */
  const arrivalFacts = computed<ArrivalPlacementFacts>(() => ({
    entryHexes: (letter) => (mapConfig.entryHexes?.[letter] ?? []).map((hex) => ({ ...hex })),
    isBlocked: (hex) =>
      units.value.some(
        (unit) => unit.side !== activeSide.value && sameHex(unit.hex, hex) && unit.steps > 0,
      ),
    nearestOpenEdgeHex: (from) => {
      const open = openSupplySourceHexes.value.filter(
        (hex) =>
          !units.value.some(
            (unit) => unit.side !== activeSide.value && sameHex(unit.hex, hex) && unit.steps > 0,
          ),
      )
      if (open.length === 0) return null
      return [...open].sort((a, b) => hexDistance(from, a) - hexDistance(from, b))[0]!
    },
    friendlyAirBaseHexes: () =>
      airBases.value
        .filter((base) => base.side === activeSide.value)
        .map((base) => ({ ...base.hex })),
    /*
     * 专规 1.4a / 13.6（U25）：图外空军盒按空军基地计
     * ⇒「任意友方空军基地」包含盒；盒无格号，作为独立落点类型给出。
     */
    friendlyAirBox: () => {
      const box = markers.containers.airBoxes.find((item) => item.side === activeSide.value)
      if (box === undefined) return null
      return {
        id: box.id,
        label:
          box.side === 'axis'
            ? 'Luftwaffe Box（轴方图外空军盒）'
            : 'Red Air Force Box（苏方图外空军盒）',
      }
    },
    /*
     * 专规 2.1 / 3.1（原文同句）：
     *   「Pax, Eq, special repls, and breakout returns arrive at any HQs able to get trace supply
     *     (OCS 12.6a) by direct draw, or else in any map-edge supply source hexes.」
     * ⇒ 只收**能直接拖取**追溯补给的 HQ；不能拖取（断补）的 HQ 不作落点。
     */
    directDrawHqHexes: () =>
      units.value
        .filter(
          (unit) =>
            unit.side === activeSide.value &&
            (unit.specialized.includes('hq') || unit.throwRange !== null),
        )
        .filter((unit) =>
          hasDirectDrawTraceSupply(arrivalDirectDrawFacts.value, {
            hex: unit.hex,
            side: activeSide.value,
            mobility: effectiveMobilityOf(unit),
          }),
        )
        .map((unit) => ({ ...unit.hex })),
    // 2.1a：关停的源不再是补给源，故不能作落点
    edgeSupplySourceHexes: () => openSupplySourceHexes.value.map((hex) => ({ ...hex })),
    /*
     * 专规 2.1a：Entry L（19 July 起）与 Entry E 及以西南缘源（19 August 起）关闭。
     * 关闭的是**入口**本身 ⇒ `entryHex` 落点与候选都要跳过它（修前这两个分支不读 shutdowns）。
     * ★ 用户 2026-11-12 裁定（5-D4）：「苏联补给源关闭后谁也不是」——轴方的 `Entry K or L`
     *   在 L 关闭后也不得改用 L（不转归轴心）。故判关闭按**双方合并**的清单，不随行动方变。
     * 关停清单由 `shutdownsFor` 唯一给出；名字形如 `Entry L` / `Entry E 及以西所有南缘源`。
     */
    entryShutDown: (letter) => entryClosedForAllSides(letter, date.value),
    // 「Any west edge hexes」= 轴方字母入场段 K–F（用户 2026-11-11 裁定），不是全部西缘格
    westEdgeHexes: () => ENTRY_EDGE.axis.hexes.map((hex) => ({ ...hex })),
    // 北缘＝没有图内北邻（曾用「行号 ≥ 上界 − 1」的近似：多算 52 格、漏 10 格削角北缘）
    isNorthEdge: (hex) => isNorthEdge(hex),
  }))

  /* ────────────────── 批 F 切片 3：到货 SP 的落点（专规 2.1 / 3.1 免费铁运 + 3.6） ────────────────── */

  /**
   * 可卸载**城市**格的**静态**清单（专规 2.1/3.1 的免费铁运只适用城市格）
   *
   * 判据取两样静态事实（都与 13.3c 的第一条同源）：
   *   ① `map-layers.json` 的 `city.level` ∈ {Minor City, Major City}（**村庄不在内** —— 原文写的是
   *      "每个**可卸载城市格**"，村庄虽也是 13.3c 可卸货格，但不吃免费铁运）；
   *   ② 该格**格内有铁路**（13.3c 首句就是 "A **railroad hex** is detrainable…"）——
   *      斯摩棱斯克 34.17 是城市但格内无铁路，故按原文不是可卸货格。
   * 与工程库 `detrainable_hexes.json → free_rail_cap_city=true` 的 9 格逐格一致（用例钉住）。
   *
   * ★ 这只是**静态**筛选；真正能不能放，还要过运行期的 13.3c（受控 / 免 EZOC 铁路路径回补给源）
   *   —— 见下面的 `freeRailCityCandidates`，判据只有 `rail-supply` 那一处，不另立。
   */
  const freeRailCityHexes = computed<FreeRailCandidate[]>(() => {
    const railKeys = new Set<string>()
    for (const edge of mapLayers.edges) {
      if (edge.rail !== true) continue
      railKeys.add(`${edge.a.col}.${edge.a.row}`)
      railKeys.add(`${edge.b.col}.${edge.b.row}`)
    }
    return mapLayers.hexes
      .filter(
        (hex) =>
          hex.city !== undefined &&
          /City/.test(hex.city.level ?? '') &&
          railKeys.has(`${hex.col}.${hex.row}`),
      )
      .map((hex) => ({ hex: { col: hex.col, row: hex.row }, name: hex.city?.name ?? '' }))
  })

  /** 运行期的免费铁运候选＝静态城市格 ∩ 13.3c 可卸货格（U17：不接延补队，用 cargo 版） */
  const freeRailCityCandidates = computed<FreeRailCandidate[]>(() => {
    const detrainable = new Set(cargoDetrainableHexes.value.map((hex) => hexLabel(hex)))
    return freeRailCityHexes.value.filter((item) => detrainable.has(hexLabel(item.hex)))
  })

  /** 玩家勾选的免费铁运格（每格 1 SP；换段/落账后清空） */
  const freeRailPicked = ref<HexRef[]>([])
  /** 余额的落点：图边补给源格（缺省取本剧本本方源清单的第一格） */
  const freeRailEdgeHex = ref<HexRef | null>(null)
  /** 落账用的到货 SP 总数（补给表掷出后自动填；裁判也可手改） */
  const supplyArrivalSp = ref<number>(0)
  /** 3.6 补给列车的落点（任一可卸货格；有额外 SP 时必填） */
  const supplyTrainHex = ref<HexRef | null>(null)
  /** 最近一次落账结论（供界面回显） */
  const lastFreeRailPlan = ref<FreeRailPlan | null>(null)
  /** 落账的拒绝原因（rule + reason，与补给/重建同形状） */
  const freeRailError = ref<{ rule: string; reason: string } | null>(null)

  /** 3.6：本回合补给列车给的额外 SP（未掷或非该结果即 0） */
  const supplyTrainSp = computed<number>(() =>
    lastVariableRepl.value?.randomEvent?.kind === 'supplyTrain'
      ? (lastVariableRepl.value.randomEvent.sp ?? 0)
      : 0,
  )

  /** 免费铁运的落点计划（引擎判据；非法即 null，原因在 `freeRailError`） */
  const freeRailPlan = computed<FreeRailPlan | null>(() => {
    const outcome = planFreeRailArrivals({
      sp: Math.max(0, Math.trunc(supplyArrivalSp.value)),
      candidates: freeRailCityCandidates.value,
      detrainableHexes: cargoDetrainableHexes.value,
      picked: freeRailPicked.value,
      // 余额的落点缺省取本剧本**本方的图边补给源格第一处**（原文只说"放图边补给源格"，不指定哪一处）
      // 2.1a：余额只能落**当日仍开放**的图边补给源格
      edgeHex: freeRailEdgeHex.value ?? openSupplySourceHexes.value[0] ?? null,
      edgeSourceHexes: openSupplySourceHexes.value,
      // 3.6 补给列车已拆成独立环节（点铁路格直接落 2 SP），不再并入免费铁运落账
    })
    if (!outcome.ok) {
      freeRailError.value = { rule: outcome.rule, reason: outcome.reason }
      return null
    }
    freeRailError.value = null
    return outcome.data
  })

  /** 专规 2.1/3.1：勾选/取消一个免费铁运城市格（每格 1 SP） */
  function toggleFreeRailPick(hex: HexRef): void {
    const text = hexLabel(hex)
    const found = freeRailPicked.value.some((item) => hexLabel(item) === text)
    freeRailPicked.value = found
      ? freeRailPicked.value.filter((item) => hexLabel(item) !== text)
      : [...freeRailPicked.value, { ...hex }]
  }

  /** 专规 2.1/3.1：指定余额的落点（图边补给源格） */
  function pickFreeRailEdgeHex(hex: HexRef | null): void {
    freeRailEdgeHex.value = hex === null ? null : { ...hex }
  }

  /** 专规 2.1/3.1：点地图选图边补给源格（候选＝当日本方仍开放的源格） */
  function beginFreeRailEdgeHexPickNow(): void {
    beginHexPick({
      label: '余额落点（图边补给源格）',
      rule: '专规 2.1 / 3.1',
      candidates: openSupplySourceHexes.value,
      apply: (hex) => {
        pickFreeRailEdgeHex(hex)
        return true
      },
    })
  }

  /** 3.6：指定补给列车的落点（任一可卸货格） */
  function pickSupplyTrainHex(hex: HexRef | null): void {
    supplyTrainHex.value = hex === null ? null : { ...hex }
  }

  /* ── 专规 3.6：补给列车 —— 不做列车算子，高亮全部可卸货铁路格，点一格即落 2 SP ── */

  /** 3.6：本回合本段本方是否已落（幂等键；重复点格不再叠加） */
  const supplyTrainPlacedKey = ref<string | null>(null)
  /** 3.6：3.4b 生效时的归属（未选不落） */
  const supplyTrainGroup = ref<PanzerGroup | null>(null)

  function supplyTrainTurnKey(): string {
    return `${turn.value}|${date.value}|${phase.value}|${activeSide.value}`
  }

  /** 3.6：本回合还有待落的补给列车 SP 吗 */
  const supplyTrainPending = computed<boolean>(
    () => supplyTrainSp.value > 0 && supplyTrainPlacedKey.value !== supplyTrainTurnKey(),
  )

  /**
   * 3.6：补给列车可放置的卸货铁路格
   *
   * 用户 2026-11-11 裁定：**补给列车事件只取德军那张网**（不得用苏军铁路或共用段冒充），
   * 与当前视角无关；判据仍只有 13.3c 的 `detrainableHexes` 一处，只是固定取 `axis`。
   */
  const supplyTrainPlacementHexes = computed<HexRef[]>(() =>
    railSupplyBySide.value.axis.detrainableHexes.map((hex) => ({ ...hex })),
  )

  /**
   * 3.6：在点中的可卸货铁路格落 2 SP（不用 Rail Cap）
   *
   * 判据与高亮同源（`supplyTrainPlacementHexes`），3.4b 生效时须先在本窗选归属；
   * 幂等：同一回合/段/方只落一次，重复点格返回 false 并记日志。
   */
  function placeSupplyTrainSpNow(hex: HexRef): boolean {
    if (!requireAction('rein.supplyTrain', '补给列车落点')) return false
    // 3.6 是德军事件 ⇒ 只能落在德军自己的那张铁路网上
    if (activeSide.value !== 'axis') {
      pushLog('warning', '3.6：补给列车是德军事件，当前不是德军方视角', '专规 3.6')
      return false
    }
    if (!supplyTrainPending.value) {
      pushLog('warning', '3.6：本次没有待落的补给列车', '专规 3.6')
      return false
    }
    const text = hexLabel(hex)
    if (!supplyTrainPlacementHexes.value.some((item) => hexLabel(item) === text)) {
      pushLog('warning', `3.6：${text} 不是可卸货铁路格（13.3c）`, '13.3c')
      return false
    }
    if (
      panzerGroupRulesOn.value &&
      activeSide.value === 'axis' &&
      supplyTrainGroup.value === null
    ) {
      pushLog('warning', '3.4b：德军补给列车 SP 须先选归属（Guderian / Hoth）再落', '3.4b')
      return false
    }
    const sp = supplyTrainSp.value
    addSpAtHex({
      hex,
      side: activeSide.value,
      sp,
      t: 0,
      source: '3.6 补给列车（不用 Rail Cap）',
      panzerGroup: supplyTrainGroup.value ?? undefined,
    })
    supplyTrainPlacedKey.value = supplyTrainTurnKey()
    const groupText =
      supplyTrainGroup.value === null
        ? ''
        : `，归属 ${supplyTrainGroup.value === 'guderian' ? 'Guderian' : 'Hoth'}`
    pushLog(
      'success',
      `3.6 补给列车：${text} +${String(sp)} SP（不用 Rail Cap）${groupText}`,
      '专规 3.6',
    )
    recordSettlement({
      action: 'supplyTrain',
      rule: '专规 3.6',
      data: { hex: text, sp, side: activeSide.value, panzerGroup: supplyTrainGroup.value },
    })
    return true
  }

  /** 3.6：进入「点地图高亮铁路格」的选格态（候选＝全部可卸货格） */
  function beginSupplyTrainHexPickNow(): boolean {
    if (!rollPlacementOpen.value) {
      pushLog(
        'warning',
        `暂不能落位：${rollPlacementBlockedReason.value ?? '判定阶段未完成'}`,
        '专规 3.6',
      )
      return false
    }
    if (!supplyTrainPending.value) {
      pushLog('warning', '3.6：本次没有待落的补给列车', '专规 3.6')
      return false
    }
    // 13.3c①：铁路格必须有村庄/城市/港口/工程 HQ；铁路入场格本身不满足，不能拿来兜底
    if (supplyTrainPlacementHexes.value.length === 0) {
      pushLog(
        'warning',
        '3.6：盘面没有可卸车格（13.3c：铁路格须带村庄/城市/港口/工程 HQ，且免敌方占据与未抵消 EZOC；铁路入场格本身不是卸车格）',
        '13.3c',
      )
      return false
    }
    beginHexPick({
      label: '补给列车落点（3.6 可卸货铁路格）',
      rule: '专规 3.6',
      candidates: supplyTrainPlacementHexes.value,
      apply: (hex) => placeSupplyTrainSpNow(hex),
    })
    return true
  }

  /** 3.6：3.4b 归属选择（null ⇒ 清除） */
  function setSupplyTrainGroup(group: PanzerGroup | null): void {
    supplyTrainGroup.value = group
  }

  /** 3.6：清空本回合补给列车的落点记录（换回合 / 重掷时调用） */
  function resetSupplyTrainPlacement(): void {
    supplyTrainPlacedKey.value = null
    supplyTrainGroup.value = null
  }

  /**
   * 3.4b：到货 SP 的逐格归属选择（**环节内瞬态，不写入存档**）
   *
   * 键为 `hexLabel(hex)`；落账成功、换回合、清空勾选时一并清掉。
   */
  const arrivalSpGroups = ref<Record<string, PanzerGroup>>({})

  interface ArrivalSpGroupTarget {
    hex: HexRef
    hexText: string
    sp: number
    /** 既有补给站已声明的归属优先；没有则取玩家的本次选择 */
    group: PanzerGroup | null
    /** true ⇒ 该格已有归属，本次跟随既有，界面不给改 */
    fixed: boolean
  }

  /** 3.4b：到货计划按格去重后的归属目标（供面板逐格选择） */
  const arrivalSpGroupTargets = computed<ArrivalSpGroupTarget[]>(() => {
    const plan = freeRailPlan.value
    if (plan === null) return []
    const byHex = new Map<string, ArrivalSpGroupTarget>()
    for (const item of plan.placements) {
      const text = hexLabel(item.hex)
      const target = byHex.get(text)
      if (target === undefined) {
        byHex.set(text, {
          hex: { ...item.hex },
          hexText: text,
          sp: item.sp,
          group: null,
          fixed: false,
        })
      } else {
        target.sp += item.sp
      }
    }
    return [...byHex.values()].map((target) => {
      const dump = spDumps.value.find(
        (item) => item.side === activeSide.value && sameHex(item.hex, target.hex),
      )
      const existingGroup = dump === undefined ? null : panzerGroupOfDump(dump.id)
      return {
        ...target,
        group: existingGroup ?? arrivalSpGroups.value[target.hexText] ?? null,
        fixed: existingGroup !== null,
      }
    })
  })

  /** 3.4b：为到货的某一落点选归属（null ⇒ 清除选择） */
  function setArrivalSpGroup(hexText: string, group: PanzerGroup | null): void {
    const next = { ...arrivalSpGroups.value }
    if (group === null) delete next[hexText]
    else next[hexText] = group
    arrivalSpGroups.value = next
  }

  /** 3.4b：清空到货归属选择（换回合 / 落账成功 / 清空落点时调用） */
  function clearArrivalSpGroups(): void {
    arrivalSpGroups.value = {}
  }

  /**
   * 专规 2.1 / 3.1 + 3.6：把当日到货 SP **落账**（12.1b 的账本条目）
   *
   * 落盘形态与手工新增、空运卸载完全同一处（`addSpAtHex`），只是多说明来源；
   * 同一格若既有免费铁运又有补给列车，**合并成一条**账本条目（避免同格两条相互矛盾）。
   * 落账后清空勾选与 SP 数，防止重复落账。
   */
  function applySupplyArrivalsNow(): boolean {
    if (!requireAction('rein.supplyArrival', '到货 SP 落位')) return false
    const plan = freeRailPlan.value
    if (plan === null) {
      const error = freeRailError.value
      pushLog(
        'warning',
        `到货 SP 落位被拒绝：${error?.reason ?? '计划不可用'}（${error?.rule ?? '专规 2.1 / 3.1'}）`,
        error?.rule ?? '专规 2.1 / 3.1',
      )
      return false
    }
    if (plan.placements.length === 0) {
      pushLog('warning', '本笔没有可落的 SP（到货 0）', '专规 2.1 / 3.1')
      return false
    }
    // 同格合并（免费铁运 1 SP 与补给列车的 2 SP 可以落在同一格）
    const byHex = new Map<string, { hex: HexRef; sp: number; reasons: string[] }>()
    for (const item of plan.placements) {
      const text = hexLabel(item.hex)
      const existing = byHex.get(text)
      if (existing === undefined) {
        byHex.set(text, { hex: { ...item.hex }, sp: item.sp, reasons: [item.reason] })
      } else {
        existing.sp += item.sp
        existing.reasons.push(item.reason)
      }
    }
    const labelOfReason = (reason: string): string =>
      reason === 'freeRail'
        ? '免费铁运（专规 2.1/3.1）'
        : reason === 'supplyTrain'
          ? '3.6 补给列车'
          : '图边补给源格'
    /*
     * 3.4b：德军到货 SP「未选归属不得落账」。
     * 以 `arrivalSpGroupTargets` 的有效归属为准（既有补给站已声明的优先）。
     */
    const groupByText = new Map(
      arrivalSpGroupTargets.value.map((target) => [target.hexText, target.group] as const),
    )
    if (panzerGroupRulesOn.value && activeSide.value === 'axis') {
      for (const text of byHex.keys()) {
        if ((groupByText.get(text) ?? null) === null) {
          pushLog(
            'warning',
            `德军 SP 到货（${text}）未选择归属（Guderian / Hoth），3.4b 要求先归属再落账`,
            '3.4b',
          )
          return false
        }
      }
      /*
       * 3.4b 均分：Supply Table 到货须在两集群间均分，**奇数点归 Guderian**
       *
       * 原文：「The Axis must evenly divide Supply Table arrivals between Guderian and Hoth,
       * with the odd point going to Guderian. … Example: If 7 SP are obtained, Hoth must be
       * given 3 and Guderian 4.」
       *
       * 判对象只有 **Supply Table 到货**（`plan.freeSp + plan.edgeSp`）；3.6 补给列车是另一个
       * 事件，不在均分对象里，但同属 "All new Axis SP must immediately be assigned"（上面的
       * 逐格点名已保证）。**初设不套这条**：Setup Note F 明说
       * "player can freely decide ownership of dumps"。
       */
      const tableSpByText = new Map<string, number>()
      for (const item of plan.placements) {
        if (item.reason === 'supplyTrain') continue
        const text = hexLabel(item.hex)
        tableSpByText.set(text, (tableSpByText.get(text) ?? 0) + item.sp)
      }
      const tableSp = [...tableSpByText.values()].reduce((sum, sp) => sum + sp, 0)
      const expected = splitSupplyTableSp(tableSp)
      const actual: Record<PanzerGroup, number> = { guderian: 0, hoth: 0 }
      for (const [text, sp] of tableSpByText) {
        const group = groupByText.get(text) ?? null
        if (group !== null) actual[group] += sp
      }
      if (actual.guderian !== expected.guderian || actual.hoth !== expected.hoth) {
        pushLog(
          'warning',
          `3.4b：Supply Table 到货 ${tableSp} SP 须均分（Guderian ${expected.guderian} / Hoth ${expected.hoth}，奇数点归 Guderian）；当前 Guderian ${actual.guderian} / Hoth ${actual.hoth} ⇒ 不落账`,
          '3.4b',
        )
        return false
      }
    }
    for (const [text, entry] of byHex) {
      addSpAtHex({
        hex: entry.hex,
        side: activeSide.value,
        sp: entry.sp,
        t: 0,
        source: `到货 SP 落位：${[...new Set(entry.reasons)].map(labelOfReason).join(' + ')}`,
        panzerGroup: groupByText.get(text) ?? undefined,
      })
    }
    lastFreeRailPlan.value = plan
    const totalSp = [...byHex.values()].reduce((sum, entry) => sum + entry.sp, 0)
    pushLog(
      'success',
      `${plan.detail}（本次落了 ${String(byHex.size)} 处 / ${String(totalSp)} SP）`,
      plan.rule,
    )
    // ⑭ 接线：到货 SP 落位（免费铁运）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'supplyArrival',
      rule: plan.rule,
      data: {
        sp: supplyArrivalSp.value,
        freeSp: plan.freeSp,
        edgeSp: plan.edgeSp,
        supplyTrainSp: plan.supplyTrainSp,
        railCapUsed: plan.railCapUsed,
        placements: plan.placements.map((item) => ({
          hex: hexLabel(item.hex),
          sp: item.sp,
          reason: item.reason,
        })),
        detail: plan.detail,
      },
    })
    freeRailPicked.value = []
    supplyArrivalSp.value = 0
    clearArrivalSpGroups()
    return true
  }

  /** 13.6 / 1.6a：当日到达计划（含投放需求与强制移除） */
  const arrivalPlan = computed<ArrivalPlan | null>(() => {
    const outcome = planArrivals({ side: activeSide.value, date: date.value })
    return outcome.ok ? outcome.data : null
  })

  /**
   * 专规 4.1c（可选）：两个轴心 RR 单位的入场区改为「01.xx 列任意格」
   *
   * 原文：RR Repair 单位「改为在 Any hexes in 01.xx row 入场」（入场卡写 West edge 是另一套机制）。
   * 只对到达卡里那两个 RR Eng Bn 生效（按卡面原文识别）；未启用 ⇒ null（走原解算）。
   */
  function rrRepairEntryOverride(unit: ArrivalUnitDemand): readonly HexRef[] | null {
    if (!session.rule4On('rrRepairRestriction')) return null
    if (unit.side !== 'axis' || unit.placement.kind !== 'anyWestEdge') return null
    if (!/RR (Eng|Repair)/i.test(unit.raw)) return null
    return columnOneHexes().filter((hex) => !arrivalFacts.value.isBlocked(hex))
  }

  /**
   * 13.6：**每条到达需求的落点候选**（下标与 `arrivalPlan.units` 一致）
   *
   * ★ 用户 2026-10-25 实测 BUG①：修前"点地图选落点"给的是任意格，入场卡写 `Entry K` 的条目
   *   能被摆到地图另一头 ⇒ 现在候选一律由引擎按**卡面口径**给（`arrivalPlacementCandidates`），
   *   界面与"手改落点"都只能在这个范围里选。候选为空＝该条目此刻无处可放（进死亡堆 / 无基地 /
   *   入口全关）⇒ 如实报出，不退回"任意格"。
   */
  const arrivalCandidates = computed<readonly (readonly HexRef[])[]>(() => {
    const plan = arrivalPlan.value
    if (plan === null) return []
    return plan.units.map((unit) => {
      const override = rrRepairEntryOverride(unit)
      if (override !== null) return override.map((hex) => ({ ...hex }))
      return arrivalPlacementCandidates(unit.placement, arrivalFacts.value).map((hex) => ({
        ...hex,
      }))
    })
  })

  /**
   * 2.1 注：**Pax / Eq / 特殊补员 / 回归（breakout returns）**的落点
   *
   * 原文：「Pax, Eq, special repls, and breakout returns arrive at **any HQs able to get trace
   * supply (OCS 12.6a) by direct draw**, or else in **any map-edge supply source hexes**。」
   *
   * ⇒ 有"能直接拖取追溯补给的友方 HQ"就只落在那些 HQ；没有才退到**地图边缘补给源格**；
   * 两者都没有 ⇒ `hex === null`（调用方必须**整笔拒绝**，不许自行挑一格——规则没给这种落点）。
   * 判据与到达卡共用 `resolveArrivalPlacement` 的 `hqOrEdgeSource` 分支（同源，不另写一套）。
   */
  function replArrivalPlacement(): { hex: HexRef | null; rule: string; detail: string } {
    const resolved = resolveArrivalPlacement(
      { kind: 'hqOrEdgeSource', label: 'Pax / Eq / 特殊补员 / 回归（2.1 注）' },
      arrivalFacts.value,
    )
    return { hex: resolved.hex, rule: resolved.rule, detail: resolved.detail }
  }

  /** 到达需求的落点解算（下标与 `arrivalPlan.units` 一致；落点只能在 `arrivalCandidates` 之内） */
  const arrivalPlacements = computed<readonly ArrivalPlacementResult[]>(() => {
    const plan = arrivalPlan.value
    if (plan === null) return []
    return plan.units.map((unit, index) => {
      const override = arrivalOverrides.value[index]
      if (override !== undefined)
        return {
          status: 'placed' as const,
          hex: override,
          rule: '13.6',
          detail: `裁判手改落点为 ${hexLabel(override)}`,
        }
      const entryOverride = rrRepairEntryOverride(unit)
      if (entryOverride !== null) {
        const hex = entryOverride[0] ?? null
        return hex === null
          ? {
              status: 'noHex' as const,
              hex: null,
              rule: '4.1c',
              detail: '专规 4.1c：01.xx 列没有可入场的格',
            }
          : {
              status: 'placed' as const,
              hex,
              rule: '4.1c',
              detail: `专规 4.1c：RR Repair 改由 01.xx 列入场（${hexLabel(hex)}）`,
            }
      }
      return resolveArrivalPlacement(unit.placement, arrivalFacts.value)
    })
  })

  /*
   * 13.6：**到达条目"已投放"账本**（R1 缺口补全）
   *
   * 修前只有"落点解算"（`arrivalPlacements`），**没有"这条是否已投放"的记录** ⇒
   *   ① 同一到达条目可以反复投放，凭空多出算子；
   *   ② 判不了"当日到达是否已放完"，会话也就无法据实提示/推进。
   * 计划键＝日期 + 方 + 条目原文序列：换日/换方/换计划即**惰性作废**（不另写重置点，避免漏清）。
   */
  const arrivalPlanKey = computed(() => {
    const plan = arrivalPlan.value
    if (plan === null) return ''
    return `${date.value}|${activeSide.value}|${plan.units.map((unit) => unit.raw).join('|')}`
  })
  const arrivalPlacedKey = ref('')
  const arrivalPlacedRaw = ref<Record<number, boolean>>({})
  /**
   * 已投放条目 → 本次投放**新建的算子 id**（2026-11-09：手牌式增援的可撤销账本）
   *
   * 只记"这一条目投放时新增了哪些 instanceId"，撤回时按 id 精确移除；不改任何规则判据。
   */
  const arrivalPlacedUnitsRaw = ref<Record<number, string[]>>({})
  /**
   * 13.6：逐枚点名的多枚条目已投了哪几枚（`2x Corps HQ (9, 12)` ⇒ `['9']` / `['9','12']`）
   *
   * `arrivalPlaced` 只在**全部**点名枚落位后才为 true；本账本按卡面点名记录进度，
   * 换日/换方/换计划随同一计划键整本作废。
   */
  const arrivalPlacedSlotsRaw = ref<Record<number, string[]>>({})
  const arrivalPlaced = computed<Record<number, boolean>>(() =>
    arrivalPlacedKey.value === arrivalPlanKey.value ? arrivalPlacedRaw.value : {},
  )
  const arrivalPlacedUnits = computed<Record<number, string[]>>(() =>
    arrivalPlacedKey.value === arrivalPlanKey.value ? arrivalPlacedUnitsRaw.value : {},
  )
  const arrivalPlacedSlots = computed<Record<number, string[]>>(() =>
    arrivalPlacedKey.value === arrivalPlanKey.value ? arrivalPlacedSlotsRaw.value : {},
  )

  /** 13.6：该条目还剩几枚待投放（普通条目 0/1；逐枚点名条目按点名枚数倒数） */
  function arrivalRemainingOf(index: number): number {
    const demand = arrivalPlan.value?.units[index]
    if (demand === undefined) return 0
    const named = arrivalNamedCopiesOf(demand)
    if (named.length === 0) return arrivalPlaced.value[index] === true ? 0 : 1
    const placed = arrivalPlacedSlots.value[index] ?? []
    return named.filter((name) => !placed.includes(name)).length
  }

  /**
   * 专规 1.4a / 13.6（U25）：该**飞机**到达条目可选**图外空军盒**作落点
   *
   * 「任意友方空军基地」按基地算 ⇒ 盒在内；盒无格号，故与地图格候选并列成第二个投放入口。
   */
  function arrivalAirBoxOf(index: number): { id: string; label: string } | null {
    const demand = arrivalPlan.value?.units[index]
    if (demand === undefined || demand.kind !== 'aircraft') return null
    return arrivalPlacementAirBox(demand.placement, arrivalFacts.value)
  }
  function arrivalAirBoxAvailable(index: number): boolean {
    return arrivalPlaced.value[index] !== true && arrivalAirBoxOf(index) !== null
  }

  /*
   * 1.6a：**强制移除执行账本**（2026-11-11，第一段整改）
   *
   * 原文次序是"先 Remove、再放到达算子"；修前移除清单与放置同屏、无先后记录，
   * 同一清单可被反复执行。这里按到达计划键记"本计划已执行过移除"，据此：
   *   · 放置入口在移除未执行时拒绝（`arrivalRemovalsFirst`）；
   *   · 移除块执行后显示"已执行"，不再重复触发。
   */
  const arrivalRemovalsKey = ref('')
  const arrivalRemovalsPending = computed<boolean>(() => {
    const plan = arrivalPlan.value
    if (plan === null) return false
    return plan.removals.length > 0 && arrivalRemovalsKey.value !== arrivalPlanKey.value
  })
  /**
   * 13.6：**裁判手改落点**只在同一个计划键下有效（换日/换方/换计划即作废）
   *
   * ★ 修（2026-10-30）：`arrivalHexOverrides` 原先只按键=下标存、只在换剧本时清 ⇒
   *   换日后"昨天给第 3 条手改的落点"会套到今天第 3 条上：轻则该条目每次都被
   *   `arrivalHexOutsideCandidates` 拒投（永久卡死），重则落到当天另一条目的入场格。
   *   与 `arrivalPlaced` 共用同一个计划键，两本账同生共死。
   */
  const arrivalOverrides = computed<Record<number, HexRef>>(() =>
    arrivalPlacedKey.value === arrivalPlanKey.value ? arrivalHexOverrides.value : {},
  )
  /**
   * 把两本到达账本切到**当前**计划键（不同则整本作废）
   *
   * 只在**写**路径调用（`markArrivalPlaced` / 手改落点）：读路径靠上面的 computed 惰性判键，
   * 不在 computed 里做副作用（`arrivalPlanKey` 是 computed，写入会形成读写环）。
   */
  function syncArrivalLedger(): void {
    const key = arrivalPlanKey.value
    if (arrivalPlacedKey.value === key) return
    arrivalPlacedKey.value = key
    arrivalPlacedRaw.value = {}
    arrivalPlacedUnitsRaw.value = {}
    arrivalPlacedSlotsRaw.value = {}
    arrivalHexOverrides.value = {}
    // M2：换了到达计划键 ⇒ 上一笔"铁路抵达撤回"不再对应任何条目
    arrivalRailUndo.value = null
  }
  /** 当日到达是否**已全部投放**（sp / unclassified 走卡面手工记账，不要求投放） */
  const arrivalAllPlaced = computed(() => {
    const plan = arrivalPlan.value
    if (plan === null) return false
    // 没有"可投放算子条目"时不算"已放完"（否则只有 SP 的当天会误报完成）
    const placeable = plan.units.filter(
      (unit) => unit.kind !== 'sp' && unit.kind !== 'unclassified',
    )
    if (placeable.length === 0) return false
    return plan.units.every((unit, index) => {
      if (unit.kind === 'sp' || unit.kind === 'unclassified') return true
      return arrivalPlaced.value[index] === true
    })
  })

  /** 记账：把第 index 条到达的**一次投放**记上；逐枚点名条目要全部落位后才算投放完毕 */
  function markArrivalPlaced(
    index: number,
    createdUnitIds: string[] = [],
    namedCopy: string | null = null,
  ): void {
    // 换日/换方/换计划 ⇒ 先整本作废（修前把上一天的 {0..N:true} 一并带进新键，
    // 新一天除第 0 条以外全部显示"已投放"且永久投不出去）
    syncArrivalLedger()
    const demand = arrivalPlan.value?.units[index]
    const named = demand === undefined ? [] : arrivalNamedCopiesOf(demand)
    const previousSlots = arrivalPlacedSlotsRaw.value[index] ?? []
    const nextSlots =
      namedCopy === null
        ? previousSlots
        : [...previousSlots, namedCopy].filter((name, at, list) => list.indexOf(name) === at)
    arrivalPlacedSlotsRaw.value = { ...arrivalPlacedSlotsRaw.value, [index]: nextSlots }
    const done = named.length === 0 || nextSlots.length >= named.length
    arrivalPlacedRaw.value = { ...arrivalPlacedRaw.value, [index]: done }
    arrivalPlacedUnitsRaw.value = {
      ...arrivalPlacedUnitsRaw.value,
      [index]: [...(arrivalPlacedUnitsRaw.value[index] ?? []), ...createdUnitIds],
    }
  }

  /**
   * 手牌式增援的「全部放完」判据
   *
   * 当回合**至少有 1 枚可投放算子**、且这些算子都已投放时才算放完
   * （SP / 非算子条目不占手牌；空手牌回合不算放完）。
   * 不放宽任何校验——投放合法性仍由 `placeArrivalNow` 判。
   *
   * ★ 2026-11-11（v7.1 第一段）：本判据**不再驱动自动关窗**——
   *   到达块改用「结束本段」按钮收束（见 `endArrivalSegmentNow`）。
   */
  const arrivalUnitsDone = computed<boolean>(() => {
    const plan = arrivalPlan.value
    if (plan === null) return false
    /*
     * 当回合**没有任何可投放算子**时不算「放完」——
     * 否则空手牌回合会把整个增援会话框关掉，连带吞掉同环节的强制移除/供给提示。
     */
    const placeable = plan.units.filter(
      (unit) => unit.kind !== 'sp' && unit.kind !== 'unclassified',
    )
    if (placeable.length === 0) return false
    return plan.units.every((unit, index) => {
      if (unit.kind === 'sp' || unit.kind === 'unclassified') return true
      return arrivalPlaced.value[index] === true
    })
  })

  /**
   * 手牌是否**仍有未投放的算子**（结束本段前"放弃上场"的确认判据）
   *
   * 与 `arrivalUnitsDone` 的区别：空手牌（只有 SP / 非算子条目）时为 false，
   * 用于「结束本段前手牌非空要问一次」——空手牌不弹确认。
   */
  const arrivalHandPending = computed<boolean>(() => {
    const plan = arrivalPlan.value
    if (plan === null) return false
    return plan.units.some(
      (unit, index) =>
        unit.kind !== 'sp' && unit.kind !== 'unclassified' && arrivalPlaced.value[index] !== true,
    )
  })

  /**
   * 增援错误里**不属于 13.6 到达**的那一部分（2026-11-09）
   *
   * 13.6 的拒绝由手牌区用一句话显示；底部通用错误块只显示别的规则的错误，
   * 免得同一条 13.6 原始码在窗里出现两遍。判定留在 store，组件只做显示。
   */
  const genericReinforcementError = computed<{ rule: string; reason: string } | null>(() => {
    const error = reinforcementError.value
    if (error === null || error.rule === '13.6') return null
    return error
  })

  /**
   * §5-A：**库中型号按词集键建索引**（`词集键 → 记录 id 列表`）
   *
   * 只依赖 `choices`（随方切换重算），供 `matchArrivalRecord` 的第二步/第三步查表，
   * 避免每行到货都把 231 条记录重新分词。
   */
  const arrivalKeyIndex = computed<Map<string, UnitRecordView[]>>(() => {
    const index = new Map<string, UnitRecordView[]>()
    for (const item of choices.value) {
      const key = unitNameKey(recordNameOf(item))
      const bucket = index.get(key)
      if (bucket === undefined) index.set(key, [item])
      else bucket.push(item)
    }
    return index
  })

  /**
   * 13.6 / §5-A：**编成条目逐枚解析**（`19 Pz Div (I-27 Pz, …)` / `1 Cav Div (… , 1 BC)`）
   *
   * 为什么可以比"条目→单枚"更敢解析：编成条目相关部件全都在**同一个编队的记录池**里
   * （库内命名即「Ge <编队号>.<兵种> <部件名>」，如 `19 Pz Div` → `Ge 19.Pz *`），
   * 故判据是「池内按 **番号 + 兵种别名** 唯一命中」——两条同时满足才不会认错。
   *
   * 到达卡里编成有**两种写法**，都走这一套：
   * ① **整条一个条目**（`19 Pz Div (I-27 Pz, II-27 Pz, …)`，rosterKind='formation'）⇒ 逐枚全到场；
   * ② **每部件一条**（`1 Cav Div (…)` 被拆成 5 条，各带 `name` 指明自己是哪一枚）⇒ 只投本条那一枚。
   *
   * 兵种别名只收**德/苏军缩写在卡面与库内的对应**（都在同一编队池内验证过，非全库猜测）：
   * `Krd`→`MC`（Kradschützen＝摩托车）、`Aufk`→`Arm Rec`（Aufklärungs＝侦察）、`BC`→`Bikes`、
   * `'F' Truck`→`Truck`（编队属卡车）。
   *
   * ★ 有任何一枚命中不了唯一记录 ⇒ `missing` 非空，调用方**整条不投**（不猜）。
   */
  function resolveArrivalFormation(index: number): {
    components: string[]
    records: UnitRecordView[]
    missing: string[]
  } | null {
    const plan = arrivalPlan.value
    if (plan === null) return null
    const demand = plan.units[index]
    if (demand === undefined) return null
    /*
     * 本条要点名的部件：整条编成 ⇒ 全部部件；每部件一条 ⇒ 由 `name` 认出自己是哪一枚
     * （`name` 形如 `I-1 Cav Cav Div`，卡面部件名 `I-1 Cav` 正是它的前缀）。
     * ★ 用前缀而不是正则剥尾：部件名本身带空格与连字符（`I-1 Cav`、`II-27 Pz`），
     *   剥尾正则一贪就会把部件名切短（`I-1 Cav Cav Div` → `I-1`），匹配不到任何一枚。
     */
    const roster = arrivalComponentNames(demand.raw)
    let wanted: string[] = [...demand.formationComponents]
    if (wanted.length === 0 && roster.length > 0 && demand.name !== null) {
      const name = demand.name.trim()
      const self = roster.filter((component) => name.startsWith(component))
      if (self.length === 1) wanted = [self[0]!]
    }
    if (wanted.length === 0) return null
    // 编队号前缀：`19 Pz Div (…)` → `Ge 19.Pz `（取括号前的编队名，去掉尾部 Div，空格在库内写成点）
    // ★ 先 trim 再剥 Div：括号前那段以空格结尾（"18 Mtr Div "），直接 `/Div$/` 匹配不上
    const base = (demand.raw.split('(')[0] ?? '')
      .trim()
      .replace(/\s+Div$/i, '')
      .trim()
    if (base === '') return null
    const prefix = `Ge ${base.replace(/\s+/g, '.')} `
    const pool = choices.value.filter((item) => (item.vassalName ?? '').startsWith(prefix))
    if (pool.length === 0) return null

    /** 番号（`I-27` / `73` / `19`；`'F' Truck` 没有）与兵种别名 */
    const parse = (text: string): { number: string | null; kind: string | null } => {
      const cleaned = text.replace(/^['‘’"\s]+|['‘’"\s]+$/g, '')
      const number = /^([A-Z]{0,2}-?\d+[A-Z]?|\d+[A-Z]?)/i.exec(cleaned)?.[1] ?? null
      const kind =
        /\bKrd\b/i.test(cleaned) || /\bMC\b/i.test(cleaned)
          ? 'mc'
          : /\bAufk\b|\bRec\b/i.test(cleaned)
            ? 'rec'
            : /\bBC\b|\bBike/i.test(cleaned)
              ? 'bike'
              : /\bTruck\b/i.test(cleaned)
                ? 'truck'
                : /\bArty\b/i.test(cleaned)
                  ? 'arty'
                  : /\bPz\b/i.test(cleaned)
                    ? 'pz'
                    : /\bCav\b/i.test(cleaned)
                      ? 'cav'
                      : /\bInf\b/i.test(cleaned)
                        ? 'inf'
                        : null
      return { number: number === null ? null : number.toLowerCase(), kind }
    }

    const records: UnitRecordView[] = []
    const missing: string[] = []
    for (const component of wanted) {
      const target = parse(component)
      const hits = pool.filter((item) => {
        const own = parse((item.vassalName ?? '').slice(prefix.length))
        if (target.number !== null && own.number !== target.number) return false
        if (target.number === null && own.number !== null) return false
        return target.kind !== null && own.kind === target.kind
      })
      if (hits.length === 1) records.push(hits[0]!)
      else missing.push(component)
    }
    return { components: wanted, records, missing }
  }

  /**
   * 13.6 / §5-A：按**卡面名**匹配库中型号
   *
   * 三档判据，逐档**只接受唯一命中**（歧义一律 null，绝不猜；玩家可用「库中型号」下拉覆盖）：
   * 1. **精确**：`recordNameOf(item) === 卡面名`；
   * 2. **词集键相等**：去方前缀/丢强度/丢词序/同义词归一后完全相同（覆盖 `5th Corps HQ` ↔ `Ge HQ 5th Corps`）；
   * 3. **词集子集**（双向择一）：卡面与库名一个是另一个的子集（覆盖 `1 NKVD Inf Rgt` ↔ `Ru 1 NKVD Mot Inf Rgt`、
   *    `Alarm AT Rgt` ↔ `Ru AT Alarm (2)-2-2`、`3 Truck Points (loaded with SP)` ↔ `Ge Truck 3`）。
   *    子集档额外要求**至少两个词相交**且**子集侧至少两个词**——单个词（如只有一个番号或只有 "div"）相交
   *    说明不了是哪一枚，不认。
   *
   * 实测（离线对全量到货条目核过 207 条）：档 1+2 命中 169，档 3 命中 28（28 条逐条人工核对全部取对），
   * 剩 9 条轴心条目是**多算子编成**（`19 Pz Div`、`18 Mtr Div`、`I-1 Cav Cav Div` 等由数枚算子共同到场），
   * 本就没有"单枚记录"可配，正确结果就是不匹配；唯一一条歧义 `2x Corps HQ (9, 12)` 也如实返回 null。
   */
  function matchArrivalRecord(demandName: string | null | undefined): UnitRecordView | null {
    const target = demandName ?? ''
    if (target === '') return null
    const exact = choices.value.find((item) => recordNameOf(item) === target)
    if (exact !== undefined) return exact
    const key = unitNameKey(target)
    if (key === '') return null
    const wanted = unitNameTokenSet(target)
    // 卡面名至少要有一个**带字母的词**（兵种/编成）才能认；纯番号的卡面（"3"）不猜是哪个"3"
    if (![...wanted].some((token) => /[a-z]/.test(token))) return null
    const sameKey = arrivalKeyIndex.value.get(key)
    if (sameKey !== undefined) return sameKey.length === 1 ? sameKey[0]! : null
    if (wanted.size < 2) return null
    const candidates: UnitRecordView[] = []
    for (const [otherKey, bucket] of arrivalKeyIndex.value) {
      const other = new Set(otherKey === '' ? [] : otherKey.split(' '))
      if (other.size < 2) continue
      let shared = 0
      let wantedInside = true
      let otherInside = true
      for (const token of wanted) {
        if (other.has(token)) shared += 1
        else otherInside = false
      }
      for (const token of other) {
        if (!wanted.has(token)) wantedInside = false
      }
      if (shared < 2) continue
      if (wantedInside || otherInside) candidates.push(...bucket)
      if (candidates.length > 1) return null
    }
    return candidates.length === 1 ? candidates[0]! : null
  }

  /**
   * 13.6：逐枚点名条目里**某一枚**在库中的记录（`2x Corps HQ (9, 12)` 的 `9` ⇒ `Ge HQ 9th Corps`）
   *
   * 卡面只给番号（`9`），库里印的是 `9th Corps HQ`（或 `Ge HQ 9th Corps`）⇒ 按母类补序数后
   * 走与普通条目同一套 `matchArrivalRecord`（唯一命中才认，不猜）。
   */
  function arrivalRecordForNamedCopy(demand: { raw: string }, name: string): UnitRecordView | null {
    const base = (demand.raw.replace(/^\d+\s*x\s+/i, '').split('(')[0] ?? '').trim()
    if (base === '') return null
    const ordinal = /^\d+$/.test(name)
      ? (() => {
          const value = Number(name)
          const mod100 = value % 100
          const suffix =
            mod100 >= 11 && mod100 <= 13
              ? 'th'
              : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[value % 10] ?? 'th')
          return `${name}${suffix}`
        })()
      : name
    return matchArrivalRecord(`${ordinal} ${base}`)
  }

  /**
   * 13.6：该到达条目自动匹配的库中型号（与 `placeArrivalNow` 同一判据；无唯一匹配 ⇒ null）
   *
   * 逐枚点名的多枚条目给**剩余的第一枚**（还没落位的那一枚），故 AI 与界面每次投放各取一枚。
   * 供界面"到货行出图"用（§5-A 的安全版：不臆造映射，只在匹配成功时给出那一枚的图）。
   */
  function arrivalRecordOf(index: number): UnitRecordView | null {
    const plan = arrivalPlan.value
    if (plan === null) return null
    const demand = plan.units[index]
    if (demand === undefined) return null
    const named = arrivalNamedCopiesOf(demand)
    if (named.length > 0) {
      const placed = arrivalPlacedSlots.value[index] ?? []
      const next = named.find((name) => !placed.includes(name))
      return next === undefined ? null : arrivalRecordForNamedCopy(demand, next)
    }
    return matchArrivalRecord(demand.name ?? demand.raw)
  }

  /**
   * B34：**图上本方单位**（给"拆分母单位 / 慢动员锁定 / 合并保留·移除"四处阵列当候选）
   *
   * 这只是"盘面上有哪些本方单位"这一份**数据**，不含任何合法性判断 ——
   * 20.0a 的创建时机、13.9 的"两面完全相同、非 DG…"等条件仍由引擎在提交时判，
   * 被拒时照旧给带规则号的一行提示。列**全部**本方单位（含飞行队与运输点数）：
   * 13.9 合并的对象不限于战斗单位，界面不替规则先筛一遍。
   */
  const ownUnitsOnMap = computed<ConsoleUnit[]>(() =>
    units.value.filter((unit) => unit.side === activeSide.value),
  )

  /**
   * 13.5：可重建候选（死亡堆 + 图上有军力损失的己方单位）
   *
   * 死亡堆条目含空军（与地面共用），故类型为 `DeadPileEntry`；
   * 地面重建动作内部会对空军显式拒绝（13.5 地面口径不适用于飞机）。
   */
  const rebuildCandidates = computed<DeadPileEntry[]>(() => {
    /*
     * 1.6c 已登记的返场单位仍在死亡堆里（放置阶段才取出），但不能再进 13.5 的重建候选：
     * 否则同一枚会被两处消费——玩家先花 Pax/Eq 把它重建出来，1.6c 手牌再点上去时
     * `returnFromDeadPileNow` 已找不到单位，手牌照旧挂着（实测 C 段）。
     * 落位之后的 −1 军力单位走第二条（图上受损），仍可按原文「usual cost」再重建。
     */
    const pendingSpecial = new Set(specialReplPending.value.map((item) => item.instanceId))
    return [
      /*
       * 13.5 / 13.5b / 13.5c：地面重建池只收**确实该在死亡堆的可重建地面单位**。
       * 修前把死亡堆原样搬来 ⇒ 空军基地/SP/工事/拆分单位/飞机都出现在重建候选里
       * （飞机虽在动作里被拒，但仍占着候选位 = 不可用项没消失）。
       */
      ...deadPile.value.filter(
        (unit) =>
          !isAirDeadPileEntry(unit) &&
          deadPileDispositionOf(unit) === 'deadPile' &&
          unit.side === activeSide.value &&
          !pendingSpecial.has(unit.instanceId),
      ),
      ...units.value.filter(
        (unit) => unit.side === activeSide.value && unit.steps < unit.printedSteps,
      ),
    ]
  })

  /**
   * 13.5：重建面板的**待重建算子**与**重建表行键**（唯一状态，面板与右键共用）
   *
   * 行键是重建表的**行**（决定费用），工程库没有「算子→行」映射；选中算子时按类型自动映射
   * （`rebuildSuggestionFor`）。映射不出唯一行才留空由玩家点——见 2026-11-11 用户口径。
   */
  const rebuildPickUnitId = ref('')
  const rebuildPickRow = ref('')

  /**
   * 13.5：**按算子类型自动映射**的重建表行键（推不出唯一行 ⇒ `null`）
   *
   * 判据只在引擎 `suggestRebuildRow`（逐条对回重建表原文）；store 这一处把「记录视图 → 判据输入」
   * 搬好，选中算子时即写入 `rebuildPickRow`（2026-11-11 用户口径：别再让玩家手点建议行）。
   * 推不出唯一行时保持未选行，交人工选——默认值不能代替规则判定。
   */
  function rebuildSuggestionFor(instanceId: string): string | null {
    const unit = rebuildCandidates.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return null
    // 空军：重建表恒为 `Aircraft`（专规 1.6 Notes：飞机只经 Repl Table）
    if ('aircraftId' in unit) return suggestRebuildRow({ side: activeSide.value, isAircraft: true })
    const record = unitChoices(activeSide.value).find((item) => item.id === unit.unitId)
    if (record === undefined) return null
    return suggestRebuildRow({
      side: activeSide.value,
      branch: record.branch ?? null,
      echelon: record.echelon ?? null,
      specialized: record.specialized ?? [],
      name: recordNameOf(record),
      isTransportPoint: unit.noncombatKind === 'transport_point',
      // 13.5c：数据层的 rebuildable 可信（用户 2026-10-24 裁定）⇒ 苏军步兵师据此分 step / (Red)
      rebuildable: unit.rebuildable !== false,
    })
  }

  /** 当前选中算子的自动映射行（面板显示用；唯一出处同 `rebuildSuggestionFor`） */
  const rebuildSuggestedRow = computed<string | null>(() =>
    rebuildPickUnitId.value === '' ? null : rebuildSuggestionFor(rebuildPickUnitId.value),
  )

  /** 选中待重建算子，并**自动填行**（自动映射不出唯一行时留空，交人工选） */
  function selectRebuildUnitNow(instanceId: string): void {
    rebuildPickUnitId.value = instanceId
    rebuildPickRow.value = rebuildSuggestionFor(instanceId) ?? ''
  }

  /** 专规 2.3b：守方本场战斗中的 NKVD 边防团（必须担任行动值单位） */
  const combatNkvdDefenders = computed<ConsoleUnit[]>(() =>
    battleDefenders.value.filter((unit) => isNkvdBorderRegiment(toNkvdDefenseView(unit))),
  )

  /** 专规 2.3b：守方本场是否需要把**全部**选项吃成损失（并禁用 9.10c 忽略） */
  const combatNkvdForcedLosses = computed<boolean>(() => {
    const state = combatState.value
    if (state === null || state.dice === undefined) return false
    return (
      nkvdDefenderOptionOverride({
        defenderArUnitId: state.ar?.defenderUnitId ?? '',
        defenders: combatDefenderViews.value.map(toNkvdDefenseView),
        optionPoints: optionsOf(state.dice.result, 'defender'),
      }) !== null
    )
  })

  /** 统一收 B18 引擎结论（失败即记错误与日志并返回 null） */
  function acceptReinforcement<T>(outcome: RuleOutcome<T>, action: string): T | null {
    if (outcome.ok) {
      reinforcementError.value = null
      return outcome.data
    }
    reinforcementError.value = { rule: outcome.rule, reason: outcome.reason }
    pushLog('danger', `${action}被拒绝：${outcome.reason}（${outcome.rule}）`, outcome.rule)
    return null
  }

  /* ────────────────────────────── B8：环节状态与统一闸门 ────────────────────────────── */

  /**
   * 本段内**当前环节**的序号（0 起）
   *
   * 这是 B6 的环节链第一次成为**状态**：用户口径「玩家每个环节只能执行该环节能进行的操作」，
   * 而"当前在哪一环"必须被记住——否则闸门无从判、流程条也无从显示。
   * 换段 / 换方 / 换回合即归零（见下面的 watch），故它只是**段内**的进度。
   */
  const segmentStepIndex = ref(0)
  const initialSetupInProgress = ref(false)
  const automaticPhaseKeys = ref<string[]>([])

  // 1.6c：沿用已随盘面保存的阶段结算键，按回合和阵营记录一次掷表。
  function hasSpecialReplDraw(side: Side, round: number): boolean {
    return automaticPhaseKeys.value.includes(`specialRepl:${round}:${side}`)
  }

  function markSpecialReplDraw(side: Side, round: number): void {
    automaticPhaseKeys.value = [...automaticPhaseKeys.value, `specialRepl:${round}:${side}`]
    // 用户 2026-11-18：1.6c 特殊补员是掷骰判定 ⇒ 本段撤回入口直接不可用
    sealUndo('1.6c 特殊补员已掷骰，本段不能撤回')
  }

  /**
   * 1.6c：本回合本方的特殊补员**还欠着**（19 Aug 前每回合必掷）
   *
   * 进 B 段时引擎只在到达环自动掷 1.6b；1.6c 受时机闸限制，要到「补员表」这一环的
   * 「掷骰检定」才掷。此判定给补员表那一环当 ack 前提——否则玩家可以先 ack 掉这一环，
   * 之后手牌永久卡在"判定阶段还没走完：1.6c 特殊补员还没掷"（补给列车 2 SP 落不下去）。
   */
  const specialReplDue = computed<boolean>(
    () => isSpecialReplAvailable(date.value) && !hasSpecialReplDraw(activeSide.value, turn.value),
  )

  /** 1.6b：本回合本方的可变增援是否已经掷过（含补员表与补给表） */
  const variableReplRolled = computed<boolean>(() =>
    automaticPhaseKeys.value.includes(`${turn.value}|${activeSide.value}|reinforcement`),
  )

  /** 「补员表」这一环能否完成：1.6b 已掷 **且** 1.6c 不欠（19 Aug 起不再欠） */
  const replTableAckReady = computed<boolean>(
    () => variableReplRolled.value && !specialReplDue.value,
  )

  /**
   * 增援段单窗推进：玩家在「本步完成 / 跳过」时记一笔
   *
   * 键带回合与阵营，换方 / 换回合 / 换段即失效；只影响窗口顺序，不落盘、不改账本。
   */
  const reinforcementAcks = ref<string[]>([])

  /** 到达计划在本段被"放弃上场"收束（2.3 例外：本回合不上增援时可不做慢动员） */
  const arrivalAbandoned = ref(false)

  /** 到达段是否已由「结束本段」收束（驱动 `arrivalPending`，替代旧的自动关窗） */
  const arrivalSegmentClosed = computed<boolean>(() =>
    reinforcementAcks.value.includes(`${turn.value}|${activeSide.value}|reinforce:arrival`),
  )

  /** 记一笔"本环节已办"，键带回合与阵营，换方/换回合即失效 */
  function ackReinforcementItem(itemId: string): void {
    const key = `${turn.value}|${activeSide.value}|${itemId}`
    if (!reinforcementAcks.value.includes(key)) {
      reinforcementAcks.value = [...reinforcementAcks.value, key]
    }
  }

  /**
   * 第一段·到达：**结束本段**（唯一出口）
   *
   * v7.1 §2.2：到达块不再在"放完手牌"时自动关窗；改由本函数收束整段。
   * - 1.6a 强制移除未执行 ⇒ 拒绝（先移除后放置）；
   * - 手牌非空且未确认放弃 ⇒ 拒绝（由界面问一次"是否放弃上场"）；
   * - 确认放弃 ⇒ 未放上场的增援作废（不结转），并允许本回合不做慢动员；
   * - 苏方若还有按表 2-2 未解锁的师 ⇒ 留在本段等慢动员提交，否则推进到下一环节。
   */
  function endArrivalSegmentNow(abandonHand = false): boolean {
    if (segmentStep.value?.id !== 'reinforcement.arrival') return false
    if (arrivalRemovalsPending.value) {
      reinforcementError.value = { rule: '1.6a', reason: 'arrivalRemovalsFirst' }
      return false
    }
    if (!abandonHand && arrivalHandPending.value) {
      reinforcementError.value = { rule: '13.6', reason: 'arrivalHandNotEmpty' }
      return false
    }
    if (abandonHand) arrivalAbandoned.value = true
    ackReinforcementItem('reinforce:arrival')
    if (activeSide.value === 'soviet' && slowMobilizationOutstanding() && !arrivalAbandoned.value) {
      return true
    }
    stepToNextSegmentStep()
    return true
  }

  /**
   * 第一段·慢动员：结束本段
   *
   * 2.4 + 表 2-2：当日仍有"配额 > 0 且仍有锁定师"的集团军 ⇒ 必须先提交
   * （未用满不得提交）；2.3 的例外（本回合不上增援、到达已整段放弃）可跳过。
   */
  function endSlowMobilizationSegmentNow(): boolean {
    if (segmentStep.value?.id !== 'reinforcement.arrival') return false
    if (slowMobilizationOutstanding() && !arrivalAbandoned.value) return false
    ackReinforcementItem('reinforce:slow')
    stepToNextSegmentStep()
    return true
  }

  /* ────────── v7.1 第二段：判定阶段 → 放置阶段（用户 2026-11-11 口径） ────────── */

  /**
   * 判定阶段是否已经全部走完（＝放置阶段的**唯一闸门**）
   *
   * 第二段是**两段式**：
   *   ① 判定阶段：按序走完 1.6c 特殊补员 → 3.6 随机事件 → 3.6 补给列车 → 3.3c 可变撤离 →
   *      1.6b 补员表 → 1.6b 补给表 → 2.3c 方面军预备队。这一阶段**不落子、不出地图落点**，
   *      只出判定结果与回执；
   *   ② 放置阶段：本轮拿到的全部单位与物资汇成**同一张手牌**，逐个点格落位。
   *
   * 故所有落点入口都先问这一处：判定没走完就不许放（修前"判完一项就能立刻放置"）。
   */
  const rollPlacementBlockedReason = computed<string | null>(() => {
    if (segmentStep.value?.id !== 'reinforcement.replRoll') return '不在第二段（掷骰与统一放置）'
    if (!variableReplRolled.value) return '先掷 1.6b 可变增援（判定阶段未完成）'
    if (isSpecialReplAvailable(date.value) && !hasSpecialReplDraw(activeSide.value, turn.value)) {
      return '1.6c 特殊补员还没掷（每回合必掷，判定阶段未完成）'
    }
    if (activeSide.value === 'axis' && variableExitSelectionOpen.value)
      return '3.3c 撤离还有待选算子，先选定'
    if (
      activeSide.value === 'soviet' &&
      frontalReservesToday.value !== null &&
      !frontalReservesClaimed.value.includes(frontalReservesToday.value.date)
    ) {
      return '2.3c 方面军预备队必须当即领取（判定阶段未完成）'
    }
    return null
  })
  const rollPlacementOpen = computed<boolean>(() => rollPlacementBlockedReason.value === null)

  /** 1.6c 特殊补员的**返场登记**：判定阶段只登记，放置阶段才从死亡堆取出 */
  interface SpecialReplReturn {
    instanceId: string
    name: string
    /** 返场后的军力（1.6c：−1 军力）；null ⇒ 保持原值 */
    steps: number | null
    /** 登记时的原军力（本段内收回时复原） */
    priorSteps: number
  }
  const specialReplPending = ref<SpecialReplReturn[]>([])
  const specialReplPlacedThisSegment = ref<SpecialReplReturn[]>([])

  /** 2.3c 编制转化的**新单位登记**：判定阶段领取，放置阶段落位 */
  interface FrontalUnitEntry {
    recordId: string
    name: string
    /** 卡面图（领取时从单位库记录取；取不到 ⇒ null，卡面回落名字） */
    images: { readonly front?: string | null; readonly back?: string | null } | null
  }
  const frontalUnitPending = ref<FrontalUnitEntry | null>(null)
  const frontalUnitPlacedThisSegment = ref<{ instanceId: string; entry: FrontalUnitEntry } | null>(
    null,
  )
  /** 2.3c 并进到货 SP 池的那 2 SP（只用于手牌照面显示"来自哪一项"） */
  const frontalReservesSpPending = ref<number>(0)

  /** 2.1 的到货落点候选（补员 / 特殊补员返场 / 2.3c 新单位共用这一处判据） */
  function handArrivalCandidates(): HexRef[] {
    return replInitialPlacementCandidatesFor('pax')
  }

  /**
   * 1.6c：登记本次特殊补员的返场单位（**只登记，不落子**）
   *
   * 修前 `containers.drawSpecialRepl` 掷完就 `returnFromDeadPileNow` 直接返场，
   * 无合法格则整笔拒绝——那是"判完一项就立刻放置"。现在改由放置阶段统一手牌落位。
   */
  function registerSpecialReplReturns(
    entries: readonly { instanceId: string; steps?: number }[],
  ): boolean {
    if (entries.length === 0) return true
    const next: SpecialReplReturn[] = []
    for (const entry of entries) {
      const unit = deadPile.value.find((item) => item.instanceId === entry.instanceId)
      if (unit === undefined) {
        pushLog('warning', `死亡堆中没有 ${entry.instanceId}（1.6c 返场登记失败）`, '1.6c')
        return false
      }
      next.push({
        instanceId: entry.instanceId,
        name: unit.name,
        steps: entry.steps === undefined ? null : entry.steps,
        priorSteps: unit.steps,
      })
    }
    specialReplPending.value = [...specialReplPending.value, ...next]
    pushLog(
      'info',
      `1.6c 特殊补员：${String(next.length)} 枚返场单位已进手牌（判定阶段不落子）`,
      '1.6c',
    )
    return true
  }

  /** 1.6c：点地图给某一条返场登记选落点（2.1 判据） */
  function beginSpecialReplPlaceHexPickNow(index: number): boolean {
    if (!rollPlacementOpen.value) {
      pushLog(
        'warning',
        `暂不能落位：${rollPlacementBlockedReason.value ?? '判定阶段未完成'}`,
        '1.6c',
      )
      return false
    }
    const entry = specialReplPending.value[index]
    if (entry === undefined) return false
    const candidates = handArrivalCandidates()
    if (candidates.length === 0) {
      pushLog('warning', '没有可返场的格（2.1：能直接拖取追溯补给的 HQ，否则图边补给源格）', '2.1')
      return false
    }
    beginHexPick({
      label: `1.6c 特殊补员返场 · ${entry.name}`,
      rule: '2.1',
      candidates,
      apply: (hex) => placeSpecialReplReturnNow(index, hex),
    })
    return true
  }

  function placeSpecialReplReturnNow(index: number, hex: HexRef): boolean {
    const entry = specialReplPending.value[index]
    if (entry === undefined) return false
    const legal = handArrivalCandidates().some(
      (item) => item.col === hex.col && item.row === hex.row,
    )
    if (!legal) {
      pushLog('warning', `${hexLabel(hex)} 不能返场（2.1：HQ 或图边补给源格）`, '2.1')
      return false
    }
    const ok = returnFromDeadPileNow({
      instanceId: entry.instanceId,
      hexText: hexLabel(hex),
      ...(entry.steps === null ? {} : { steps: entry.steps }),
    })
    if (!ok) return false
    specialReplPending.value = specialReplPending.value.filter((_, at) => at !== index)
    specialReplPlacedThisSegment.value = [...specialReplPlacedThisSegment.value, entry]
    return true
  }

  /** 1.6c：收回本段已返场的一枚（退回死亡堆与手牌） */
  function withdrawSpecialReplReturnNow(instanceId: string): boolean {
    if (refuseWithdrawWhenSealed()) return false
    if (segmentStep.value?.id !== 'reinforcement.replRoll') return false
    const entry = specialReplPlacedThisSegment.value.find((item) => item.instanceId === instanceId)
    if (entry === undefined) return false
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return false
    units.value = units.value.filter((item) => item.instanceId !== instanceId)
    unit.steps = entry.priorSteps
    unit.hex = { col: 0, row: 0 }
    unit.movementEnded = false
    deadPile.value = [...deadPile.value, unit]
    specialReplPlacedThisSegment.value = specialReplPlacedThisSegment.value.filter(
      (item) => item.instanceId !== instanceId,
    )
    specialReplPending.value = [...specialReplPending.value, entry]
    if (selectedId.value === instanceId) selectedId.value = null
    pushLog('info', `收回 1.6c 返场：${entry.name} 退回死亡堆与手牌`, '1.6c')
    return true
  }

  /** 2.3c：点地图给编制转化的新单位选落点（与补员同一条 2.1 判据） */
  function beginFrontalUnitPlaceHexPickNow(): boolean {
    if (!rollPlacementOpen.value) {
      pushLog(
        'warning',
        `暂不能落位：${rollPlacementBlockedReason.value ?? '判定阶段未完成'}`,
        '2.3c',
      )
      return false
    }
    const entry = frontalUnitPending.value
    if (entry === null) return false
    const candidates = handArrivalCandidates()
    if (candidates.length === 0) {
      pushLog('warning', '没有可落位的格（2.1：HQ 或图边补给源格）', '2.1')
      return false
    }
    beginHexPick({
      label: `2.3c 编制转化 · ${entry.name}`,
      rule: '2.1',
      candidates,
      apply: (hex) => placeFrontalUnitNow(hex),
    })
    return true
  }

  function placeFrontalUnitNow(hex: HexRef): boolean {
    const entry = frontalUnitPending.value
    if (entry === null) return false
    const legal = handArrivalCandidates().some(
      (item) => item.col === hex.col && item.row === hex.row,
    )
    if (!legal) {
      pushLog('warning', `${hexLabel(hex)} 不能放方面军预备队新单位（2.1）`, '2.1')
      return false
    }
    const record = unitChoices('soviet').find((item) => item.id === entry.recordId)
    if (record === undefined) {
      pushLog('danger', `${entry.name} 在单位库里找不到，无法落位（2.3c）`, '2.3c')
      return false
    }
    const created = toConsoleUnit({
      record,
      instanceId: createId('fr'),
      hex: { ...hex },
      side: 'soviet',
    })
    units.value = [...units.value, created]
    frontalUnitPending.value = null
    frontalUnitPlacedThisSegment.value = { instanceId: created.instanceId, entry }
    pushLog('success', `${entry.name} 按落点 ${hexLabel(hex)} 到场（2.3c）`, '2.3c')
    return true
  }

  /** 2.3c：收回本段已落位的新单位（退回手牌） */
  function withdrawFrontalUnitNow(): boolean {
    if (refuseWithdrawWhenSealed()) return false
    if (segmentStep.value?.id !== 'reinforcement.replRoll') return false
    const placed = frontalUnitPlacedThisSegment.value
    if (placed === null) return false
    const before = units.value.length
    units.value = units.value.filter((item) => item.instanceId !== placed.instanceId)
    if (units.value.length === before) return false
    if (selectedId.value === placed.instanceId) selectedId.value = null
    frontalUnitPending.value = placed.entry
    frontalUnitPlacedThisSegment.value = null
    pushLog('info', `收回 2.3c 新单位：${placed.entry.name} 退回手牌`, '2.3c')
    return true
  }

  /**
   * 到货 SP 里**还没指定落点**的点数
   *
   * 指定了图边余额格 ⇒ 其余全部按 2.1 落到那一格，视为已指定；
   * 否则＝到货数 − 已勾选的城市格（每格 1 SP）。
   */
  const supplyTableUnplaced = computed<number>(() => {
    const sp = Math.max(0, Math.trunc(supplyArrivalSp.value))
    if (sp === 0) return 0
    if (freeRailEdgeHex.value !== null) return 0
    return Math.max(0, sp - freeRailPicked.value.length)
  })

  /** 到货 SP：点地图落 1 SP（城市格每格 1 SP；图边源格＝余额全落那里） */
  function beginSupplyArrivalSpHexPickNow(): boolean {
    if (!rollPlacementOpen.value) {
      pushLog(
        'warning',
        `暂不能落位：${rollPlacementBlockedReason.value ?? '判定阶段未完成'}`,
        '专规 2.1 / 3.1',
      )
      return false
    }
    if (supplyTableUnplaced.value <= 0) return false
    const picked = new Set(freeRailPicked.value.map((item) => hexLabel(item)))
    const candidates: HexRef[] = [
      ...freeRailCityCandidates.value
        .filter((item) => !picked.has(hexLabel(item.hex)))
        .map((item) => ({ ...item.hex })),
      ...openSupplySourceHexes.value.map((item) => ({ ...item })),
    ]
    if (candidates.length === 0) {
      pushLog('warning', '没有可落 SP 的格（13.3c 城市格与图边补给源格都不可用）', '专规 2.1')
      return false
    }
    beginHexPick({
      label: '到货 SP 落点（城市格 1 SP；图边源格＝其余全部）',
      rule: '专规 2.1 / 3.1',
      candidates,
      apply: (hex) => placeSupplyArrivalSpOneNow(hex),
    })
    return true
  }

  function placeSupplyArrivalSpOneNow(hex: HexRef): boolean {
    if (supplyTableUnplaced.value <= 0) return false
    const city = freeRailCityCandidates.value.find(
      (item) => item.hex.col === hex.col && item.hex.row === hex.row,
    )
    if (city !== undefined) {
      const picked = freeRailPicked.value.some((item) => hexLabel(item) === hexLabel(hex))
      if (picked) return false
      toggleFreeRailPick(hex)
      return true
    }
    if (openSupplySourceHexes.value.some((item) => item.col === hex.col && item.row === hex.row)) {
      pickFreeRailEdgeHex(hex)
      return true
    }
    pushLog('warning', `${hexLabel(hex)} 不能落到货 SP（2.1/3.1）`, '专规 2.1 / 3.1')
    return false
  }

  /** 统一手牌的一条（判据与角标都由 store 给，面板只画） */
  interface RollHandEntry {
    id: string
    /** 来源标签（合并的是**放置动作**，不是来源语义） */
    label: string
    rule: string
    detail: string
    /** 角标：待放的枚数 / SP */
    count: number
    blocked: string | null
    /**
     * 挡因分类（面板按它决定是否渲染）：
     * `panzerGroup`＝3.4b 尚未选德军归属（玩家在补给列车步骤选完即消失）；
     * `placement`＝没有可落位格等真实落位障碍（保留灰卡 + 标题原因）；
     * `null`＝可落位。计数语义不随本字段变化。
     */
    blockedKind: 'panzerGroup' | 'placement' | null
    /** 卡面短标（没有算子图时回落到它） */
    short: string
    /** 算子图两面（补员＝补员算子记录；返场／编制转化＝原算子）；取不到 ⇒ null */
    images: { readonly front?: string | null; readonly back?: string | null } | null
  }

  /**
   * 第二段放置阶段 = **同一张手牌**（全部来源汇到一处）
   *
   * 来源：1.6b 补员表（Pax / Eq）／1.6c 特殊补员返场／1.6b 补给表 SP（含 2.3c 并进来的 2 SP）／
   * 3.6 补给列车 2 SP／2.3c 编制转化新单位。每条仍带来源标签，拒付判据各按原文。
   */
  const rollHandEntries = computed<RollHandEntry[]>(() => {
    const entries: RollHandEntry[] = []
    const arrivalBlocked = handArrivalCandidates().length === 0
    for (const item of ['pax', 'eq'] as const) {
      const count = replPending.value[item]
      if (count <= 0) continue
      const blocked = replPlacementBlockedReasonFor(item)
      entries.push({
        id: `repl:${item}`,
        label: `1.6b 补员表 · ${item === 'pax' ? 'Pax' : 'Eq'}`,
        rule: '13.5 / 2.1',
        detail: '点一下 → 地图只高亮合法格 → 点格落一枚',
        count,
        blocked,
        blockedKind: blocked === null ? null : 'placement',
        short: item === 'pax' ? 'Pax' : 'Eq',
        images: replRecordOf(activeSide.value, item)?.images ?? null,
      })
    }
    specialReplPending.value.forEach((entry, index) => {
      const unit = deadPile.value.find((item) => item.instanceId === entry.instanceId)
      entries.push({
        id: `unit:special:${String(index)}`,
        label: `1.6c 特殊补员 · ${entry.name}`,
        rule: '1.6c / 2.1',
        detail: '死亡堆返场：点一下 → 点高亮格（HQ 或图边补给源格）',
        count: 1,
        blocked: arrivalBlocked ? '没有可返场的格（2.1：HQ 或图边补给源格）' : null,
        blockedKind: arrivalBlocked ? 'placement' : null,
        short: entry.name,
        images: unit?.images ?? null,
      })
    })
    if (frontalUnitPending.value !== null) {
      entries.push({
        id: 'unit:frontal',
        label: `2.3c 编制转化 · ${frontalUnitPending.value.name}`,
        rule: '2.3c / 2.1',
        detail: '新单位随其它到达的 SP 与补员一起摆放',
        count: 1,
        blocked: arrivalBlocked ? '没有可落位的格（2.1：HQ 或图边补给源格）' : null,
        blockedKind: arrivalBlocked ? 'placement' : null,
        short: frontalUnitPending.value.name,
        images: frontalUnitPending.value.images,
      })
    }
    if (supplyTableUnplaced.value > 0) {
      const cityCount = freeRailCityCandidates.value.length
      entries.push({
        id: 'sp:arrival',
        label:
          frontalReservesSpPending.value > 0
            ? '到货 SP（1.6b 补给表 + 2.3c 方面军 2 SP）'
            : '到货 SP（1.6b 补给表）',
        rule: '专规 2.1 / 3.1',
        detail: '点一下 → 城市格每格 1 SP；点图边补给源格＝其余全部落那里',
        count: supplyTableUnplaced.value,
        blocked:
          cityCount === 0 && openSupplySourceHexes.value.length === 0
            ? '没有可落 SP 的格（13.3c 城市格与图边补给源格都不可用）'
            : null,
        blockedKind:
          cityCount === 0 && openSupplySourceHexes.value.length === 0 ? 'placement' : null,
        short: 'SP',
        images: null,
      })
    }
    if (supplyTrainPending.value) {
      // 13.3c① 先挡：没有可卸车格时，铁路入场格不能拿来兜底（原文无此例外）
      const noDetrainable = supplyTrainPlacementHexes.value.length === 0
      const groupBlocked = panzerGroupRulesOn.value && supplyTrainGroup.value === null
      entries.push({
        id: 'sp:train',
        label: '3.6 补给列车',
        rule: '专规 3.6',
        detail: '点一下 → 点任一可卸货铁路格，落 2 SP（不用 Rail Cap）',
        count: supplyTrainSp.value,
        blocked: noDetrainable
          ? '盘面没有可卸车格（13.3c：铁路格须带村庄/城市/港口/工程 HQ，且免敌方占据与未抵消 EZOC；铁路入场格本身不是卸车格）'
          : groupBlocked
            ? '3.4b：德军补给列车 SP 须先选归属（Guderian / Hoth）'
            : null,
        blockedKind: noDetrainable ? 'placement' : groupBlocked ? 'panzerGroup' : null,
        short: 'SP',
        images: null,
      })
    }
    return entries
  })

  /** 手牌点击分派（面板只调这一处，不各自判断来源） */
  function beginRollHandEntryNow(id: string): boolean {
    if (!rollPlacementOpen.value) {
      pushLog(
        'warning',
        `暂不能落位：${rollPlacementBlockedReason.value ?? '判定阶段未完成'}`,
        '1.6b',
      )
      return false
    }
    if (id === 'repl:pax') return beginReplPlaceHexPickNow('pax')
    if (id === 'repl:eq') return beginReplPlaceHexPickNow('eq')
    if (id === 'sp:arrival') return beginSupplyArrivalSpHexPickNow()
    if (id === 'sp:train') return beginSupplyTrainHexPickNow()
    if (id === 'unit:frontal') return beginFrontalUnitPlaceHexPickNow()
    if (id.startsWith('unit:special:')) {
      return beginSpecialReplPlaceHexPickNow(Number(id.slice('unit:special:'.length)))
    }
    return false
  }

  /**
   * 第二段（掷骰与统一放置）的**待放手牌**
   *
   * v7.1 §3.3：所有骰子判完才出手牌，产出汇进同一张手牌再统一落位。
   * 手牌＝未落位的补员算子（Pax / Eq，每点一枚）＋1.6c 返场登记＋2.3c 新单位
   * ＋到货 SP（补给表 / 方面军预备队）＋未落位的补给列车 2 SP。
   * Ftr/Tac 不在手牌（13.5 不可保存，段末清零）。
   */
  const rollHandPending = computed<boolean>(() => rollHandEntries.value.length > 0)

  /** 第二段手牌还剩多少"点"（角标总数；面板与测试共用一处口径） */
  const rollHandPoints = computed<number>(() =>
    rollHandEntries.value.reduce((sum, entry) => sum + entry.count, 0),
  )

  /**
   * 第二段·结束本段（v7.1 §1.5 / §3.3：段内唯一出口）
   *
   * 前置（都是"该掷的没掷/该办的没办"，不替玩家跳过）：
   *   · 1.6b 可变增援未掷 ⇒ 拒绝；
   *   · 1.6c 特殊补员可掷而未掷 ⇒ 拒绝（原文「Each turn before 19 August … roll a die」）；
   *   · 3.3c 撤离待选算子 ⇒ 拒绝；
   *   · 2.3c 方面军预备队到批而未领 ⇒ 拒绝（原文「must be taken right away」）；
   *   · 手牌非空且未确认放弃 ⇒ 拒绝（由界面问一次"是否放弃上场"）。
   *
   * 确认放弃 ⇒ 未落位的补员 / SP / 补给列车作废（不结转），随后进第三段。
   */
  function endRollSegmentNow(abandonHand = false): boolean {
    if (segmentStep.value?.id !== 'reinforcement.replRoll') return false
    if (!variableReplRolled.value) {
      reinforcementError.value = { rule: '1.6b', reason: 'rollNotMade' }
      return false
    }
    if (isSpecialReplAvailable(date.value) && !hasSpecialReplDraw(activeSide.value, turn.value)) {
      reinforcementError.value = { rule: '1.6c', reason: 'specialReplNotRolled' }
      return false
    }
    if (activeSide.value === 'axis' && variableExitSelectionOpen.value) {
      reinforcementError.value = { rule: '3.3c', reason: 'variableExitSelectionPending' }
      return false
    }
    if (
      activeSide.value === 'soviet' &&
      frontalReservesToday.value !== null &&
      !frontalReservesClaimed.value.includes(frontalReservesToday.value.date)
    ) {
      reinforcementError.value = { rule: '2.3c', reason: 'frontalReservesPending' }
      return false
    }
    if (!abandonHand && rollHandPending.value) {
      reinforcementError.value = { rule: '1.6b', reason: 'rollHandNotEmpty' }
      return false
    }
    /*
     * 放置阶段的收尾：手牌空了 ⇒ 把（1.6b 补给表 + 2.3c 方面军）的到货 SP 一次性落账。
     * 3.4b 的归属/均分仍由 `applySupplyArrivalsNow` 校验，拒绝原因原样回给界面。
     */
    if (!abandonHand && supplyArrivalSp.value > 0) {
      if (!applySupplyArrivalsNow()) {
        reinforcementError.value = {
          rule: freeRailError.value?.rule ?? '专规 2.1 / 3.1',
          reason: freeRailError.value?.reason ?? 'supplyArrivalRejected',
        }
        return false
      }
      frontalReservesSpPending.value = 0
    }
    if (abandonHand) {
      const lostRepl = replPending.value.pax + replPending.value.eq
      const lostSp = supplyArrivalSp.value
      const lostTrain = supplyTrainPending.value ? supplyTrainSp.value : 0
      const lostSpecial = specialReplPending.value.length
      const lostFrontal = frontalUnitPending.value === null ? 0 : 1
      replPending.value = { pax: 0, eq: 0 }
      supplyArrivalSp.value = 0
      frontalReservesSpPending.value = 0
      freeRailPicked.value = []
      freeRailEdgeHex.value = null
      clearArrivalSpGroups()
      specialReplPending.value = []
      frontalUnitPending.value = null
      if (supplyTrainPending.value) supplyTrainPlacedKey.value = supplyTrainTurnKey()
      if (lostRepl + lostSp + lostTrain + lostSpecial + lostFrontal > 0) {
        pushLog(
          'warning',
          `放弃上场：${lostRepl} 点补员 / ${lostSp} SP / 补给列车 ${lostTrain} SP / ` +
            `1.6c 返场 ${lostSpecial} 枚 / 2.3c 新单位 ${lostFrontal} 枚作废（未落位，不结转）`,
          '13.5',
        )
      }
    }
    ackReinforcementItem('reinforce:endRoll')
    stepToNextSegmentStep()
    return true
  }

  /**
   * 第三段·结束本段（v7.1 §4.6：本段没有待放项，唯一出口）
   *
   * ★ 补员点数（Pax / Eq）是**盘面资源**：没用完的留在图上，跨段、跨回合继续可用，
   * 这里**不清空、不提示作废**（§1.6）。只有从未放上场的增援与点名式免费重建会作废。
   */
  function endRebuildSegmentNow(): boolean {
    if (segmentStep.value?.id !== 'reinforcement.rebuild') return false
    ackReinforcementItem('reinforce:endRebuild')
    if (stepToNextSegmentStep()) return true
    /*
     * 第三段是 B 段的**最后一环**：本段 ack 已完成，顺手推进会话步（结束增援阶段）；
     * 若被补给/战斗等闸门挡下，`advanceSegmentNow` 会把原因写进流程条，**不算本段失败**
     * （本段的「结束本段」只负责收束本段，阶段推进仍由统一流程条承担）。
     */
    advanceSegmentNow()
    return true
  }

  /**
   * 第三段：Pax / Eq 两栏旁的「免费重建 N」提示标记（v7.1 §4.6）
   *
   * **只是提示、不参与扣点**：1.6c（苏 2 / 轴 1，19 Aug 前且本回合已掷）与 2.3c（当日已领 +2）
   * 都是「按单位点名、不扣 Pax/Eq」的免费重建；当期不用即作废、不结转。
   */
  const rebuildFreeHint = computed<number>(() => {
    if (phase.value !== 'reinforcement') return 0
    let count = 0
    if (isSpecialReplAvailable(date.value) && hasSpecialReplDraw(activeSide.value, turn.value)) {
      count += activeSide.value === 'soviet' ? 2 : 1
    }
    const batch = frontalReservesToday.value
    if (batch !== null && frontalReservesClaimed.value.includes(batch.date)) count += 2
    return count
  })

  /** 第三段收尾条：盘面现有 Pax / Eq 补员算子数（补员点=盘面资源，跨段跨回合保留） */
  const boardReplTotals = computed<{ pax: number; eq: number }>(() => {
    let pax = 0
    let eq = 0
    for (const unit of replBoardUnits.value) {
      if (unit.replKind === 'pax') pax += 1
      else if (unit.replKind === 'eq') eq += 1
    }
    return { pax, eq }
  })

  function acknowledgeReinforcementStepNow(itemId: string): boolean {
    if (itemId === 'reinforce:arrival' && arrivalPlan.value !== null && !arrivalAllPlaced.value)
      return false
    if (itemId === 'reinforce:variableExit' && variableExitSelectionOpen.value) return false
    /*
     * 第二段改用"先掷完、再统一放"的批量手牌 ⇒ 掷骰块不再以"已放置"为 ack 前提
     * （放置统一由 `reinforce:hand` 与 `endRollSegmentNow` 把关）；
     * 但 1.6c 是**必须掷的表**，未掷不得 ack。
     *
     * ★ 1.6c 的唯一入口已并入补员表的「掷骰检定」（`reinforce:specialRepl` 不再单列），
     *   所以闸门必须同时认 `reinforce:replTable`：否则玩家可以先 ack 掉补员表这一环，
     *   之后 1.6c 入口随之消失，手牌永久卡在"判定阶段还没走完"（实测 turn 4 补给列车）。
     */
    if (
      (itemId === 'reinforce:specialRepl' || itemId === 'reinforce:replTable') &&
      specialReplDue.value
    )
      return false
    const key = `${turn.value}|${activeSide.value}|${itemId}`
    if (!reinforcementAcks.value.includes(key)) {
      reinforcementAcks.value = [...reinforcementAcks.value, key]
    }
    return true
  }

  /** 本段本方的**全部**环节（唯一出处：`engine/rules/sop-segments`；B 段的链按方不同） */
  const segmentSteps = computed(() => sopStepsOf(phase.value as GamePhase, activeSide.value))

  /**
   * 本段本方**需要玩家过**的环节（滤掉自动的 / 无事可做的）
   *
   * 用户口径：「点击进入下一个阶段后，**自动进行的阶段不需要玩家介入**」——自动环节
   * （B 段的补员表掷骰 / 随机事件 / 可变撤离等）由引擎在推进段时结算并留痕，
   * **不该占一格让玩家点**。故"当前环节"只在**玩家环节**里走。
   * 例：B 段的链是 `掷骰(自动) → 到货 → 重建 → …`，玩家一进 B 段就停在「到货」。
   *
   * ★ **无事可做就跳过**（用户 2026-09-16 裁定②：「如果玩家在自己的突围环节无事可做，那么可以自动跳过」）：
   *   标了 `skipWhenIdle` 的环节（现在只有突围 12.8e —— B47 已给出入口）若**本方无人参与**则自动跳过——
   *   判据就是下面 `stepHasWork`（与闸门**同一条** `participatesIn`）：一个断补单位都没有，
   *   突围环节本就没有可做之事，不该让玩家点一次空环节。
   *
   * 全自动的段（H 清理 / Turn End / Pre-Turn 的部分）滤完为空 ⇒ `segmentStep` 为 null
   * ⇒ 闸门对一切动作返回"当前段没有环节表"，**正是"这些段没有玩家动作"应有的效果**。
   */
  const playerSegmentSteps = computed(() => {
    /*
     * 2.2：回合准备（天气 / 先手判定）**不属于 A–H 任何一段** ⇒ 没有任何"环节"可走。
     * 2.3 的先手选择由待答问题面板作答（作答即推进，见 `answerQuestionNow`），
     * 不能把它当成一个可点选的段内环节——否则 `segmentStep` 会挂着
     * `preTurn.firstPlayerDetermination`，地图点击仍按"有环节"分派。
     */
    if (phase.value === 'preTurn') return []
    const visible = segmentSteps.value.filter(
      (step) =>
        step.driver !== 'automatic' &&
        step.implemented !== false &&
        !(step.skipWhenIdle === true && !stepHasWork(step)),
    )
    /*
     * ★ 2026-11-11（v7.1 第二段，用户 Q2）：B 段**按「段」分组**（段 → 节集合）。
     *
     * 段内只有**宿主步**占流程条的一格：到达段＝`reinforcement.arrival`、掷骰段＝
     * `reinforcement.replRoll`、重建段＝`reinforcement.rebuild`。段内其余环节（特殊补员 /
     * 随机事件 / 补给列车 / 可变撤离 / 方面军预备队）不在流程条上各占一格，而是作为
     * 「块」按 §3 的次序在宿主窗里逐张出现（`session-steps.ts#reinforceItems`）。
     *
     * 计数口径随之变成：段 轴 3 / 苏 3、环 轴 3 / 苏 3（原 4 / 4）；**节仍是 7 / 5 不变**
     * （`sopStepsOf` 与本函数无关，链路一条未删）。见文档 §0.2 的更新记录。
     */
    if (phase.value !== 'reinforcement') return visible
    return reinforcementSegmentsOf()
      .map((segment) => visible.find((step) => step.id === segment.host) ?? null)
      .filter((step): step is SopSegmentStep => step !== null)
  })

  /**
   * 本环节**是否有活可做**（只对 `skipWhenIdle` 的环节求值）
   *
   * 判据＝**本环节有谁参与**（B7 的 `participatesIn`，与闸门同源）：有人参与就有活，
   * 没人参与就无事可做。本函数不另立规则——12.8e 的"断补 + 战斗单位 + 移动 MA ≥ 1"就在那条谓词里。
   *
   * ★ **不能**用 `segmentGateQuery`：它含 `segmentStep` 与 `segmentStepPosition`，而本函数正是
   *   `playerSegmentSteps` 的过滤条件 ⇒ 会成环（B47 把突围的 `implemented: false` 翻掉之后，
   *   本函数第一次真的被跑到，环就暴露了：读到的 `playerSegmentSteps` 还是 undefined）。
   *   本函数只问"本环节有谁参与"，故只取 `{phase, segment, side}` 三样，别的一概不碰。
   */
  function stepHasWork(step: SopSegmentStep): boolean {
    const reaction = phase.value === 'reaction'
    const side = reaction ? opponentOf(activeSide.value) : activeSide.value
    /*
     * ★ 条 6（R3）：突围环节（`movement.breakout`）的"有活"判据要比通用的 `participatesIn` 更严。
     * `participatesIn` 只判"断补 + 战斗单位 + 移动 MA≥1"，但**真能突围**还要过 12.8e 的
     * A 路径 / B 15 格 / 首回合 / MA 那一整套 `canBreakout` 判据——否则会出现"本环节出现了，
     * 但点任何一个断补单位都被 `breakoutNow` 拒"的死环节（玩家进得去、出不去）。
     * 故这里改用 `breakoutCandidates`（已含 `canBreakout` 结论）是否有 `ok` 的；
     * 另：有待返场单位（`breakoutReturns`）时也算有活（要把它们按 13.6b 放回）。
     */
    if (step.id === 'movement.breakout') {
      return (
        breakoutCandidates.value.some((candidate) => candidate.ok) ||
        breakoutReturns.value.length > 0
      )
    }
    return units.value.some(
      (unit) =>
        participatesIn({
          unit,
          phase: phase.value as GamePhase,
          segment: step.id,
          activeSide: side,
        }).ok,
    )
  }

  /** 当前环节（序号越界时**夹到最后一环**：换方后链变短也不会读到 undefined） */
  const segmentStep = computed<SopSegmentStep | null>(() => {
    const steps = playerSegmentSteps.value
    if (steps.length === 0) return null
    const index = Math.min(segmentStepIndex.value, steps.length - 1)
    return steps[index] ?? null
  })

  /** 撤销封印的作用域键：初设单独一段；其余按「回合|方|段|环节」 */
  function undoScopeKeyOf(): string {
    if (initialSetupInProgress.value) return 'setup'
    // 增援段按**整段**封：1.6b/1.6c 掷完骰后，本段后续（重建/整编）也不得再撤回
    if (phase.value === 'reinforcement') return `${turn.value}|${activeSide.value}|reinforcement`
    return `${turn.value}|${activeSide.value}|${phase.value}|${segmentStep.value?.id ?? 'none'}`
  }

  /** 本段是否有掷骰封印（非 null ⇒ 撤销入口直接不可用，并作为原因） */
  const undoSealedReason = computed<string | null>(() => {
    const seal = undoSeal.value
    if (seal === null) return null
    return seal.key === undoScopeKeyOf() ? seal.reason : null
  })
  function undoSealedReasonNow(): string | null {
    return undoSealedReason.value
  }
  /** 用户 2026-11-18：本段掷过骰 ⇒ 一切「撤回刚落的子」入口统一拒绝并给原因 */
  function refuseWithdrawWhenSealed(): boolean {
    const sealed = undoSealedReasonNow()
    if (sealed === null) return false
    pushLog('warning', sealed, '6.1')
    return true
  }

  /*
   * B2（用户 2026-11-17）：铁路抵达撤回条**跟着段和方走**
   *
   * 换日 / 换阶段 / 换环节 / 换方 ⇒ 这一笔不再对应任何可撤的增援抵达，
   * 立即收起；切回原段原方也不复活（一次性失效）。
   */
  watch(
    () =>
      `${date.value}|${phase.value}|${activeSide.value}|${segmentStep.value?.id ?? ''}|${arrivalPlanKey.value}`,
    () => {
      arrivalRailUndo.value = null
    },
    { flush: 'sync' },
  )

  /** 当前环节进度（界面显示「第 n / m 环」） */
  const segmentStepPosition = computed(() => {
    const steps = playerSegmentSteps.value
    return {
      index: steps.length === 0 ? 0 : Math.min(segmentStepIndex.value, steps.length - 1),
      total: steps.length,
    }
  })

  /**
   * 增援段：当前宿主环属于哪一段（其它阶段为 null；界面显示「第几段」用）
   *
   * 三段的分组元数据唯一出处是 `engine/rules/sop-segments.ts#REINFORCEMENT_SEGMENTS`。
   */
  const reinforcementSegment = computed<ReinforcementSegment | null>(() =>
    phase.value === 'reinforcement' && segmentStep.value !== null
      ? reinforcementSegmentOf(segmentStep.value.id)
      : null,
  )

  /**
   * 闸门查询（B7 `allowedActionsOf` 的入参）
   *
   * E 反应段由**非**行动方行动（6.3a / 7.0a）⇒ 该段的 `role` 是 `nonActive`、`side` 是对手方；
   * 其余段都是行动方在动。这一句是"谁是这一环的行动者"的**唯一实现**。
   */
  const segmentGateQuery = computed<ActionGateQuery>(() => {
    const reaction = phase.value === 'reaction'
    const position = segmentStepPosition.value
    return {
      phase: phase.value as GamePhase,
      segment: segmentStep.value?.id ?? '',
      role: reaction ? 'nonActive' : 'active',
      side: actingSideFor({ phase: phase.value, activeSide: activeSide.value }) ?? activeSide.value,
      /*
       * B37：**段末**声明（`at: 'end'` 那一类时机只在这里放行）
       *
       * 判据＝"现在是本段的**最后一个玩家环节**"。与 20.0d 的段末强制收束（`timing: 'segmentEnd'`）
       * 同一层意思：那些事**不是在某个环节里做的**，而是在段的收尾处结算。
       */
      atSegmentEnd: position.total > 0 && position.index === position.total - 1,
    }
  })

  /**
   * 批 A 切片 2：当前环节是不是**某段的轰炸环节**（SOP：C 段 air & ship only / F 段 artillery only）
   *
   * 判据＝环节 id 以 `.barrage` 结尾（`movement.barrage` / `reaction.barrage` / `combat.barrage` /
   * `exploitation.barrage`）——环节清单本身来自 SOP 数据，故此处不写死段名。
   */
  const isBarrageSegment = computed<boolean>(() =>
    (segmentStep.value?.id ?? '').endsWith('.barrage'),
  )

  /** 批 A 切片 2：当前环节是不是**战斗环节**（`combat.combat` / `exploitation.combat`） */
  const isCombatPickSegment = computed<boolean>(() =>
    (segmentStep.value?.id ?? '').endsWith('.combat'),
  )

  /**
   * 批 A 切片 2：**本环节允许的轰炸来源**（10.0e-F 的段内限制 ＋ 10.0 第二段）
   *
   * 判据取自引擎的唯一表 `BARRAGE_SOURCES_BY_PHASE`（SOP：C 段轰炸环节 air only、
   * F 段 artillery only）；**移动环节**按 10.0 第二段只给低空扫射的空军；其余环节不给来源。
   */
  const barrageKindsInSegment = computed<readonly BarrageKind[]>(() => {
    /** 全量来源（本作无海军，专规 1.1c ⇒ 只保留火炮 / 空军） */
    const ALL_KINDS: readonly BarrageKind[] = ['artillery', 'air']
    const stepId = segmentStep.value?.id ?? ''
    if (!isBarrageSegment.value) {
      /* 10.0 第二段：「如果允许某方的空军单位执行低空扫射任务……则这些轰炸还能在上述阶段的
       * 移动环节中进行」⇒ 移动环节只开空军（低空扫射）这一个来源；火炮不得借这个入口。 */
      const inMovementStep = stepId.endsWith('.modeAndMovement') || stepId.endsWith('.movement')
      return inMovementStep ? ['air'] : []
    }
    const allowed = BARRAGE_SOURCES_BY_PHASE[phase.value as GamePhase]
    if (allowed === undefined) return ALL_KINDS
    return ALL_KINDS.filter((kind) => allowed.includes(kind))
  })

  /**
   * 14.2e：**当前环节**对应的任务归属环节（非空军任务环节 ⇒ null）
   *
   * 与 `barrageKindsInSegment` 同一套环节 id 判据：`.barrage` 为轰炸环节，
   * `.modeAndMovement` / `.movement` 为移动环节（C / E / G）。
   */
  const airMissionSegmentKind = computed<AirMissionSegment | null>(() => {
    const stepId = segmentStep.value?.id ?? ''
    if (stepId.endsWith('.barrage')) return 'barrageSegment'
    if (stepId.endsWith('.modeAndMovement') || stepId.endsWith('.movement'))
      return 'movementSegment'
    return null
  })

  /**
   * D1（用户 2026-11-17 实走）：**此刻这一环是不是移动环节**（C / E / G）
   *
   * 点单位在移动环节＝取子开拔；在其余环节（A/B/D/F/H）＝只读查看。
   * 修前地图单击一律走 `selectForMove`，D 段于是把"看一眼"当成移动意图，
   * 回一条「D 补给段没有移动环节，不能移动（2.2）」的红字却没有详情可看。
   * 判据与 `airMissionSegmentKind` 同源（`.modeAndMovement` / `.movement`）。
   */
  const movementStepNow = computed<boolean>(() => moveRangeDisplayLive.value)

  /**
   * 14.2e / 10.0 第二段：**「任务分配」入口只列属于当前环节的任务类型**
   *
   * 移动环节 ⇒ 低空扫射 / 空运 / 空投 / 战机扫荡（普通轰炸不可选——10.0 第二段只给低空扫射开口子）；
   * 轰炸环节 ⇒ 空军轰炸 / 运输破坏；基地转移与拦截仍走专用入口，不在本清单。
   */
  const airMissionKindChoices = computed<readonly { key: AirMissionKind; label: string }[]>(() => {
    const segment = airMissionSegmentKind.value
    if (segment === null) return []
    return AIR_MISSION_KIND_CHOICES.filter((choice) => missionSegmentOf(choice.key) === segment)
  })

  /*
   * 换环节后若已选任务类型不属于新环节，落位到本环节第一个合法项。
   * 只做「把下拉从空值救回来」，不另判规则；非法宣布仍由 `beginAirMissionNow` 的 14.2e 守卫拒。
   */
  watch(
    airMissionKindChoices,
    (choices) => {
      if (choices.length === 0) return
      if (choices.some((choice) => choice.key === airMissionKind.value)) return
      setAirMissionKind(choices[0]!.key)
    },
    { flush: 'sync' },
  )

  /**
   * 批 A 切片 2：在轰炸环节里**点地图选目标格**（10.0d）
   *
   * 只落"目标格"这一件事：参炸单位的选择仍归会话框/面板（`toggleBarrageUnit`），
   * 宣布是否合法仍归引擎（`beginBarrageNow`）。
   */
  function pickBarrageTargetAt(hex: HexRef): void {
    if (!canReplaceBarrage()) return
    fireResolution.resetBarrage()
    barragePickHex.value = { ...hex }
    pushLog('info', `轰炸目标格 → ${hexLabel(hex)}（10.0d）`, '10.0d')
  }

  /**
   * 批 A 切片 2：**进入轰炸环节即开好轰炸工具**
   *
   * 用户口径是"由环节驱动" ⇒ 玩家不该先去找开关；离开该环节不动它（可继续在验证页用工具）。
   *
   * ★ 换段时的**瞬时错位**：`segmentStepIndex` 归零与本条 watch 同在换段这一拍（都是 sync），
   *   本条先注册 ⇒ 会先按**上一段留下的越界下标**读到"本段最后一环＝轰炸"，
   *   把工具误开进新段（实测：B 段第三环 → C 段第一环「模式与移动」时轰炸工具被残留开启，
   *   之后每一次点算子都会走"选炮击参战"，移动准备面板再也不出现）。
   *   故只在**下标落在本段实际环节数内**时才开工具；越界那一拍交给归零后的下一次求值。
   */
  watch(
    isBarrageSegment,
    (on) => {
      if (on && segmentStepIndex.value < playerSegmentSteps.value.length) {
        setBarrageActive(true)
        // 记账：这一笔是自动开的，换段/换方/换回合时要收回
        barrageAutoOpened = true
      }
    },
    // ★ flush: 'sync' —— 环节一变就得把工具开好：
    //   否则同一拍里的点击（以及用例）会读到"环节到了、工具还没开"的中间态。
    { flush: 'sync' },
  )

  /**
   * B35（用户口径 2026-09-16 #10）：**此刻"点地图选战斗"是不是本环节允许做的事**
   *
   * 用户口径：「各阶段什么单位能干什么事是按规则定好的，**地图窗口上方的移动和战斗按钮
   * 在对局界面是不需要的**。测试界面才需要。」⇒ 正式界面不再让玩家切"工具"，
   * 改为**从闸门推**：本环节允许 `combat.declare`（9.1 宣布战斗的入口）⇒ 点地图就是选攻方 / 定防御格；
   * 不允许 ⇒ 点地图照常走移动与选中那一路。
   *
   * ★ 判据与 `requireAction` **同一条**（`allowedActionsOf(segmentGateQuery)`），不另写一遍规则；
   *   `tool` 本体保留（引擎验证页与 20+ 流程用例仍靠它显式切换）。
   */
  const combatPickActive = computed<boolean>(() =>
    allowedActionsOf(segmentGateQuery.value).has('combat.declare'),
  )

  /** 最近一次被闸门拒绝的动作（界面就地显示一行；通过时清空） */
  const actionRefusal = ref<{ key: ActionKey; rule: string; reason: string } | null>(null)

  /**
   * 本环节**可参与的算子**（B9：界面"灰色不可点"与"本环节可参与 N 枚"的唯一判据）
   *
   * 判据就是 B7 的 `participatesIn`——**同一条谓词**，界面不再自己判"这枚能不能点"，
   * 否则"能点"与"能选"会各有一套口径。列表按盘面顺序，供渲染层做灰显与拾取过滤。
   */
  const participatingUnitIds = computed<readonly string[]>(() => {
    /*
     * 2.2：回合准备（天气 / 先手判定）没有行动段 ⇒ 谁都不"参与本环节"。
     * 修前这里读的是本地段的环节（默认 movement），于是界面会报"本环节可参与 N 枚"、
     * 地图也会把上一段的参与名单当成本环节的点击资格。
     */
    if (segmentLocked.value) return []
    const query = segmentGateQuery.value
    if (query.segment === '') return []
    return units.value
      .filter(
        (unit) =>
          participatesIn({
            unit,
            phase: query.phase,
            segment: query.segment,
            activeSide: query.side ?? activeSide.value,
            // 9.1c：本战斗环节已攻击过的单位不再可点（用户口径 9.17⑤「只列没攻击过的可攻击单位」）
            attackedUnitIds: attackedUnitIdsThisPhase.value,
          }).ok,
      )
      .map((unit) => unit.instanceId)
  })

  /**
   * 本环节可参与的算子数（流程条的「本环节可参与 N 枚」）
   *
   * ★ 口径说明：这是**可参与的算子数**，不是"必须做的事数"——后者要逐环节定义
   *   （如"B 增援：18 个待部署"），属后续批次；先给一个**同一谓词**算出来的数，
   *   比拍脑袋写一句更贴边，也不会因为两边口径不同而互相打架。
   */
  const participatingUnitCount = computed<number>(() => participatingUnitIds.value.length)

  /**
   * 地图内就地一行的**提示文本**（无提示时 null）
   *
   * 优先级：闸门拒绝（`actionRefusal`，说明"这一步此刻在哪一段哪一环节才能做"）
   * → 移动被拒（`moveBlocked`，说明这一格为什么走不到）。
   * 两者都是"点了没反应"时玩家最需要的一句话，且都自带规则号。
   */
  const mapHint = computed<MapHint | null>(() =>
    mapHintOf({ refusal: actionRefusal.value, moveBlocked: moveBlocked.value }),
  )

  /**
   * 换段 / 换方 / 换回合 ⇒ 环节归零
   *
   * 与"清段内中间态"同一时点（`resetSegmentTransient` 也在这些时点被调用），但这里用 watch
   * 而不是靠调用方记得——**换方时 B 段的链长度会变**，忘记归零会停在越界的环节上。
   */
  watch(
    () => `${turn.value}|${phase.value}|${activeSide.value}`,
    () => {
      segmentStepIndex.value = 0
      /*
       * ★ 换段这一拍：开工具的那条 watch 可能已按**旧下标**读到本段的轰炸环（C 段只有
       *   「模式与移动 / 轰炸」两环，旧下标 1 恰好命中后者）⇒ 自动开的工具在归零后已不属于
       *   轰炸环节时必须收回，否则 C 段第一环点算子会走"选炮击参战"，移动准备面板再也不出现。
       *   **玩家手动开的工具不收回**（验证页仍要能继续用）；归零后第一环本身就是轰炸环的
       *   （如 F 段 `combat.barrage`）也保留。
       */
      if (barrageAutoOpened && !isBarrageSegment.value) setBarrageActive(false)
      actionRefusal.value = null
      reinforcementAcks.value = []
      arrivalAbandoned.value = false
      /*
       * 9.1c：换回合 / 换段 / 换方 ⇒ 环节归零，账本也必须跟着清 —— 这条 watch 是"环节变了"
       * 的又一条路径（"交给对手"的切方不走 `resetSegmentTransient`），漏了它就会出现
       * "上一方在本环节的攻击记录压着这一方的战斗环节"。
       */
      clearAttackPhaseLedger()
    },
    { flush: 'sync' },
  )

  /** 推进到本段的**下一环节**；已是最后一环则返回 false（由调用方接着推进会话步） */
  function stepToNextSegmentStep(): boolean {
    const position = segmentStepPosition.value
    if (position.total === 0) return false
    if (position.index >= position.total - 1) return false
    /*
     * 6.1 / 2.2：「移动」只属于本阶段的移动环节 ⇒ 离开该环节（含段内换环节）＝本次移动收束。
     * 保留已走位置（不是撤销）；若突袭战斗未收束，finishMove() 会拒绝并写 moveBlocked，
     * 此时不推进，逼玩家先把 8.1a 的 3 MP / 进格收掉。
     */
    const moving = moveInteraction.value
    if (moving !== null && !moving.finished) {
      finishMove()
      // 8.1a 的突袭未收束等情况 ⇒ finishMove 拒绝（已写 moveBlocked）⇒ 本环节不推进
      if (moveInteraction.value?.finished !== true) return false
      // "已结束"状态下会话框仍挂着 → 换环节时一并收起（炮击/战斗环节不该再出现移动面板）
      clearMoveInteraction()
    }
    segmentStepIndex.value = position.index + 1
    const next = segmentStep.value
    if (next !== null) pushLog('info', `环节 → ${next.label}（${next.rule}）`, '2.2')
    /*
     * 9.1c：账本按**战斗环节**计 ⇒ 环节一换（例如 F 段「炮击 → 战斗」）就是新的一个战斗环节，
     * 上一环的攻击记录不再约束这一环。
     */
    clearAttackPhaseLedger()
    // H1：环节一换＝上一条拒绝描述的动作已经不在本环节（与换段同口径）
    moveBlocked.value = null
    return true
  }

  /** 直接跳到某一环（引擎验证页/测试用；越界即拒绝，不夹取——夹取会掩盖调用方的错） */
  function setSegmentStepIndex(index: number): boolean {
    if (!airMissionDomain.canReplace()) return false
    if (!canReplaceCombat() || !canReplaceBarrage() || specialPending.value !== null) return false
    if (!Number.isInteger(index) || index < 0 || index >= playerSegmentSteps.value.length)
      return false
    segmentStepIndex.value = index
    // 9.1c：直跳也是"换环节" ⇒ 账本必须清（否则往回跳一步就能让同一单位再攻击一次）
    clearAttackPhaseLedger()
    // 11 号：直跳环节同样退掉上一个环节遗留的待点格
    pendingHexPick.value = null
    // H1：直跳环节同样不能带着上一环的拒绝文案
    moveBlocked.value = null
    return true
  }

  /**
   * **统一闸门**（B8）：这个动作此刻允许做吗
   *
   * 判据链：① Pre-Turn 锁定（2.2）→ ② 本段本方的**当前环节**是否允许该动作族（B7 的 `allowedActionsOf`）。
   * 通过即清空上次的拒绝记录；被拒则**记一句人话 + 规则号**（界面就地冒一行，不弹窗、不换页）。
   *
   * ★ 判据全部来自 `engine/rules/sop-segments` 与 `stores/workbench-model` 的两张纯表，
   *   本函数不自己比较规则号、也不写第二份"哪个动作归哪一段"。
   */
  /**
   * **本环节允许的动作族**（用户 2026-10-25：「每个阶段/环节只能出现该环节可用的 UI」）
   *
   * 与 `actionAllowedNow` 同源（都是 `segmentActionKeys`，即「阶段 × 环节 × 动作族」权威表），
   * 区别只是这里是**整集合**：界面按"面板服务哪些动作族"与它求交，空集即本环节用不到该面板。
   */
  const segmentActionKeys = computed<ReadonlySet<ActionKey>>(() => {
    const query = segmentGateQuery.value
    if (query.segment === '') return new Set<ActionKey>()
    // 唯一投影：从「阶段 × 环节 × 动作族」权威表取值（不再直接扫 ACTION_GATES）
    return new Set(
      actionFamilyRowsAt({
        phase: query.phase,
        segment: query.segment,
        role: query.role,
        side: query.side,
        atSegmentEnd: query.atSegmentEnd,
      }).map((row) => row.key),
    )
  })

  /**
   * 本环节的**驱动方式**（用户 2026-10-25：分清哪些是人工操作、哪些是自动结算）
   *
   * 判据来自 `sop-segments` 的 `driver`（规则书 2.2 的流程表）：
   *   · `player`    ⇒ 玩家在此做决定（出 UI）；
   *   · `automatic` ⇒ 自动结算（只给一行回执，不铺动作面板）；
   *   · `question`  ⇒ 系统发问、玩家回答一次（如 2.3 先后手）。
   */
  const segmentDriver = computed<'player' | 'automatic' | 'question' | null>(
    () => segmentStep.value?.driver ?? null,
  )

  /**
   * 本环节是否是 `ids` 之一（界面**分区**用；不比较规则号，也不自己拼阶段名）
   *
   * 用户 2026-10-25：「每个阶段/环节只能出现该环节可用的 UI，不要什么都糅杂在一起」
   * ⇒ 面板里的区块用它决定显隐（例：B 段「重建」区块只在 `reinforcement.rebuild` 环节出现）。
   */
  function segmentIn(ids: readonly string[]): boolean {
    const current = segmentStep.value?.id
    return current !== undefined && ids.includes(current)
  }

  /*
   * ── B0 装配（解构第二批）────────────────────────────────────────────
   * `actionAllowedNow` / `requireAction` 的实现搬到 workbench-gates.ts，facade 只留同名转发。
   * 依赖全传 getter：`segmentGateQuery` / `segmentActionKeys` / `initialSetupInProgress`
   * 都在本文件后段声明，装配期取不到值。
   * ───────────────────────────────────────────────────────────────────
   */
  const gates = createWorkbenchGates({
    initialSetupInProgress: () => initialSetupInProgress.value,
    terminated: () => session.terminated,
    segmentLocked: () => segmentLocked.value,
    segmentGateQuery: () => segmentGateQuery.value,
    segmentActionKeys: () => segmentActionKeys.value,
    actionRefusal,
    refuseWhileLocked,
    phaseLabel: (phase) => PHASE_LABELS[phase],
    settlementLock: () => settlementInProgress.value,
    moveBlocked,
    log: core.pushLog,
  })

  /**
   * 闸门**预测**（供界面判断"这个动作此刻能不能点"；无副作用、不写日志、不改拒绝状态）
   *
   * ★ 用户 2026-10-25 实测 BUG②「增援的时候点格子可能出现空军轰炸的 UI」——
   *   修前地图小窗里"炮击 / 空军轰炸"按钮只看"这枚算子有没有印刷轰炸值"，
   *   **没问环节闸门** ⇒ B 增援段点己方火炮照样给出轰炸入口。
   *   界面一律用本函数判可点，不要自己拿规则号/阶段名再拼一套口径。
   */
  function actionAllowedNow(key: ActionKey): boolean {
    return gates.actionAllowedNow(key)
  }

  function requireAction(key: ActionKey, action: string): boolean {
    return gates.requireAction(key, action)
  }

  /**
   * B18：切当前剧本（到达落点、补给源、换轨、胜利格等盘面账本随剧本重取）
   *
   * ★ 联调：剧本号本身写在**会话 store**（唯一权威）；本函数只负责「随剧本重取的盘面账本」。
   * 已被会话锁定（已开局）时**整段拒绝**——否则会出现「剧本号没变、账本却按新剧本重置」的半更新。
   */
  function setScenarioId(next: string): void {
    if (!session.setScenarioId(next)) {
      pushLog(
        'warning',
        `换剧本被拒（${session.error?.reason ?? 'scenarioLockedWhilePlaying'}）：已开局的会话不允许中途换剧本（2.2）`,
        '2.2',
      )
      return
    }
    /*
     * ★ 账本重取**不在这里**：剧本号的唯一权威是会话，凡是写会话的路径都可能换剧本
     *   （本函数、容器盒 `containers.setScenario`、**读档 `session.loadNow`**），
     *   若由各入口自己记得刷新，漏一条就是「剧本号变了、盘面账本还是旧剧本」的半更新
     *   （实测：剧本 3 存档 → 读回后建造标记仍是剧本 1 的 3 枚、换轨账本仍是剧本 1 的 2 格）。
     *   故改由下方 **对 `scenarioId` 的 watch** 统一重取 —— 权威一变即重取，与入口无关。
     */
    pushLog(
      'info',
      `剧本 → ${next}（盘面账本随剧本重取：到达落点、补给源、1.7 补给缓存、3.5 建造标记、` +
        `5.0c 胜利格控制、9.14e 印刷工事归属、专规 1.2 换轨）`,
      '2.1',
    )
  }

  /** B18：手改某条到达需求的落点（13.6：入场格由裁判按卡面判定） */
  function setArrivalHexOverride(index: number, hexText: string): void {
    const hex = parseHexPath(hexText)[0]
    if (hex === undefined) {
      pushLog('warning', `落点格式应为「列.行」，收到「${hexText}」`, '13.6')
      return
    }
    /*
     * ★ 13.6（用户 2026-10-25 实测 BUG①「放增援可以任意放」）：落点**按卡面限定**
     *   —— 13.6 的原文是「放置在它们的**入场格**中」，不是"玩家任选一格"。
     *   候选由引擎 `arrivalPlacementCandidates` 给（与落点解算同源）；候选为空＝该条目
     *   此刻无处可放（进死亡堆 / 没有友方基地 / 入口全关）⇒ 如实报出，不退回"任意格"（不猜）。
     */
    const allowed = arrivalCandidates.value[index] ?? []
    if (allowed.length === 0) {
      const detail = arrivalPlacements.value[index]?.detail ?? '该条目没有可放的格'
      pushLog('warning', `落点未改：${detail}（13.6）`, '13.6')
      return
    }
    if (!allowed.some((item) => item.col === hex.col && item.row === hex.row)) {
      pushLog(
        'warning',
        `${hexTextOf(hex)} 不在该到达条目的落点范围内（13.6：共 ${String(allowed.length)} 处候选：${allowed
          .slice(0, 8)
          .map(hexTextOf)
          .join('、')}${allowed.length > 8 ? '…' : ''}）`,
        '13.6',
      )
      return
    }
    // 换日/换方/换计划 ⇒ 手改落点与"已投放"账本一起作废（两本账共用同一个计划键）
    syncArrivalLedger()
    arrivalHexOverrides.value = { ...arrivalHexOverrides.value, [index]: hex }
  }

  /**
   * §5-D：**摆补员算子**（测试夹具 / 裁判订正；`hex` 为落点，缺省取当前"补员所在格"）
   *
   * 语义：把当前方的补员算子**重置**成给定数量（Pax / Eq 各 `holdings` 点 ⇒ 各那么多枚），
   * Ftr / Tac 仍是账本（专规 1.6：只补 1 step 且不可保存，不做盘面算子）。
   * ★ 与修前的区别：修前只改四个数字；现在 Pax / Eq 必须**落在某一格**（13.5a：补员是盘面算子）。
   */
  function setReplHoldingsNow(holdings: ReplHoldings, hex?: HexRef): void {
    const target = hex ?? parseHexPath(rebuildReplHexText.value)[0] ?? null
    if (target === null) {
      pushLog('warning', '摆补员需要落点格（13.5a：补员是盘面算子）', '13.5')
      return
    }
    // 先清掉当前方已有补员，再按给定数量重摆（"设置为"语义，不是叠加）
    for (const unit of replBoardUnits.value) {
      units.value = units.value.filter((item) => item.instanceId !== unit.instanceId)
    }
    placeReplCounters(target, 'pax', holdings.pax)
    placeReplCounters(target, 'eq', holdings.eq)
    replFtrTac.value = { ftr: holdings.ftr, tac: holdings.tac }
  }

  /**
   * 13.5 / 1.6b：补员入账
   *
   * §5-D 后分两种去向：**Pax / Eq 进"待放置"**（SOP：「掷可变增援表，并将相应的结果放置在地图上」
   * ——落点由裁判选格，放置前不在盘面、也不能用于重建）；**Ftr / Tac 直接进账本**（专规 1.6）。
   */
  function addReplHoldingsNow(delta: Partial<ReplHoldings>): void {
    const pax = Math.max(0, Math.trunc(delta.pax ?? 0))
    const eq = Math.max(0, Math.trunc(delta.eq ?? 0))
    if (pax > 0 || eq > 0) {
      replPending.value = { pax: replPending.value.pax + pax, eq: replPending.value.eq + eq }
    }
    if ((delta.ftr ?? 0) > 0 || (delta.tac ?? 0) > 0) {
      replFtrTac.value = {
        ftr: replFtrTac.value.ftr + Math.max(0, Math.trunc(delta.ftr ?? 0)),
        tac: replFtrTac.value.tac + Math.max(0, Math.trunc(delta.tac ?? 0)),
      }
    }
    const kept = (['pax', 'eq'] as const).filter((key) => isSavableRepl(key))
    pushLog(
      'info',
      `补员 +${describeCost(delta)}（1.6b；可保存的仅有 ${kept.join(' / ')}，13.5）` +
        (pax > 0 || eq > 0 ? '；Pax/Eq 待放置到地图上（13.5a）' : ''),
      '13.5',
    )
  }

  /**
   * 13.5 / 2.1：补员**初次摆放**的落点策略（**Pax / Eq 分开**）
   *
   * 原文（专规 2.1 注 / 3.1 注）对两族只给了同一条：
   * 「Pax, Eq, special repls, and breakout returns arrive at any HQs able to get trace supply
   * (12.6a) by direct draw, or else in any map-edge supply source hexes.」
   * ⇒ 判据目前相同；但 Pax 与 Eq 是**两枚独立算子**，可以落在不同格，故策略按族建
   *   （2026-11-11 用户口径：「Eq / Pax 分开策略」）。任一族将来改判据不会牵连另一族。
   *
   * 修前这里是「全图 − 敌方占据」，于是可变增援高亮一整张地图；现改为与到达落点同一条引擎判据
   * `arrivalPlacementCandidates({kind:'hqOrEdgeSource'})`：
   *   · 有能**直接拖取追溯补给**的友方 HQ ⇒ 只落这些 HQ；
   *   · 没有 HQ 才退到**本日仍开放的图边补给源格**（2.1a）。
   * 高亮与 `placePendingReplNow` 的校验共用本投影，不许两处各算。
   *
   * ★ 这条取代 2026-11-10「初次摆放不套 13.5a」的旧口径的**范围部分**：仍不套 13.5a 的
   *   「战斗面 HQ 2 格内 / 非敌 ZOC」；但不再给整张地图（见待裁定：13.5 原文只写
   *   "place on the map"，与 2.1 的到货落点是否强绑未明说）。
   */
  function replPlacementPolicyFor(kind: SavableReplKind): {
    kind: 'hqOrEdgeSource'
    label: string
  } {
    return {
      kind: 'hqOrEdgeSource',
      label: `补员初次摆放（2.1：${kind === 'pax' ? 'Pax' : 'Eq'}）`,
    }
  }

  /** 某族初次摆放的候选（地图高亮与落点校验共用这一处） */
  function replInitialPlacementCandidatesFor(kind: SavableReplKind): HexRef[] {
    return arrivalPlacementCandidates(replPlacementPolicyFor(kind), arrivalFacts.value).map(
      (hex) => ({ ...hex }),
    )
  }

  const replInitialPlacementHexesFor = computed<Record<SavableReplKind, HexRef[]>>(() => ({
    pax: replInitialPlacementCandidatesFor('pax'),
    eq: replInitialPlacementCandidatesFor('eq'),
  }))

  /**
   * 两族候选的并集（判据相同时即同一份）
   *
   * 保留这个投影给「地图高亮 / 旧调用方」用；落点校验必须走**按族**的
   * `replInitialPlacementHexesFor`（否则一族改宽后会顺手放宽另一族）。
   */
  const replInitialPlacementHexes = computed<HexRef[]>(() => replInitialPlacementHexesFor.value.pax)

  /**
   * 13.5a：**重建**时补员可所在的格（战斗面友方 HQ 2 格内、且不在敌方 ZOC）
   *
   * ★ 与上面的「初次摆放」**分开两条策略**：重建的落点判据来自 13.5a，初次摆放来自 13.5，
   *   两者不共用一套，避免下次收紧初次摆放时误伤重建。
   */
  const rebuildReplPlacementHexes = computed<HexRef[]>(() => {
    const hqHexes = rebuildHqHexes.value
    if (hqHexes.length === 0) return []
    const range = rulesConstants.repl.rebuildHqRangeHexes
    return allMapHexes().filter(
      (hex) =>
        hqHexes.some((hq) => hexDistance(hq, hex) <= range) &&
        !zocOnlySupplyFacts.value.inEnemyZoc(hex, activeSide.value),
    )
  })

  /** 某一族待放置补员**放不下去**时的可见原因（该族没有待放置项时为 `null`） */
  function replPlacementBlockedReasonFor(kind: SavableReplKind): string | null {
    if (replPending.value[kind] <= 0) return null
    if (replInitialPlacementHexesFor.value[kind].length === 0) {
      return `没有可放置 ${kind === 'pax' ? 'Pax' : 'Eq'} 的格（2.1：能直接拖取追溯补给的友方 HQ，否则图边补给源格）`
    }
    return null
  }

  /** 待放置补员**放不下去**时的可见原因（两族都无事可做时为 `null`） */
  const replPlacementBlockedReason = computed<string | null>(() => {
    if (replPending.value.pax + replPending.value.eq === 0) return null
    return replPlacementBlockedReasonFor('pax') ?? replPlacementBlockedReasonFor('eq')
  })

  /**
   * 13.5：让玩家在地图上点**某一族**补员的落点
   *
   * Pax / Eq 分开走：候选与落点都取该族自己的投影（`replInitialPlacementHexesFor`），
   * 一族摆完不会把另一族一起落盘。
   */
  function beginReplPlaceHexPickNow(kind: SavableReplKind): boolean {
    if (!rollPlacementOpen.value) {
      pushLog(
        'warning',
        `暂不能落位：${rollPlacementBlockedReason.value ?? '判定阶段未完成'}`,
        '13.5',
      )
      return false
    }
    if (replPending.value[kind] === 0) {
      pushLog('warning', `没有待放置的 ${kind === 'pax' ? 'Pax' : 'Eq'} 补员（13.5）`, '13.5')
      return false
    }
    const blocked = replPlacementBlockedReasonFor(kind)
    if (blocked !== null || replInitialPlacementHexesFor.value[kind].length === 0) {
      pushLog('warning', `补员无法放置：${blocked ?? '地图上没有可放置的格'}`, '13.5')
      return false
    }
    beginHexPick({
      label: `补员落点 · ${kind === 'pax' ? 'Pax' : 'Eq'}（2.1：友方 HQ 或图边补给源格）`,
      rule: '13.5',
      candidates: replInitialPlacementHexesFor.value[kind],
      apply: (hex) => placePendingReplOneNow(hex, kind),
    })
    return true
  }

  /**
   * 第二段已放置的补员算子（用于"再点一下收回"）
   *
   * v7.1 §1.1：撤回**只在本段内有效**——离开第二段（或换方/换回合）即清空，
   * 防止把上一段的落位再撤回。
   */
  const replPlacedThisSegment = ref<{ instanceId: string; kind: SavableReplKind }[]>([])

  /**
   * 共用放置方法（第二段入口）：把某一族待放补员放**一枚**到指定格
   *
   * 与 `placePendingReplNow` 同一套合法性（2.1 到货条）；区别只是每次只落一枚，
   * 便于"点单位 → 点格 → 再点已放单位收回"的逐枚操作。
   */
  function placePendingReplOneNow(hex: HexRef, kind: SavableReplKind): boolean {
    if (replPending.value[kind] <= 0) return false
    if (replRecordOf(activeSide.value, kind) === null) return false
    const legal = replInitialPlacementHexesFor.value[kind].some(
      (item) => item.col === hex.col && item.row === hex.row,
    )
    if (!legal) {
      const reason =
        replPlacementBlockedReasonFor(kind) ??
        `${hexLabel(hex)} 不能放补员（2.1：须是能直接拖取追溯补给的 HQ 或图边补给源格）`
      pushLog('warning', `补员不能放在 ${hexLabel(hex)}：${reason}`, '13.5')
      return false
    }
    if (!placeReplCounters(hex, kind, 1)) return false
    const created = units.value[units.value.length - 1]
    if (created !== undefined) {
      replPlacedThisSegment.value = [
        ...replPlacedThisSegment.value,
        { instanceId: created.instanceId, kind },
      ]
    }
    replPending.value = { ...replPending.value, [kind]: replPending.value[kind] - 1 }
    pushLog(
      'info',
      `补员落位 ${hexLabel(hex)}：1 ${kind === 'pax' ? 'Pax' : 'Eq'}（13.5a：每点一枚；本段内再点可收回）`,
      '13.5',
    )
    return true
  }

  /**
   * 第二段：收回本段已放置的一枚补员（点数退回待放手牌）
   *
   * 仅限第二段；第三段（重建/整编）已落位的算子不得用这条撤回。
   */
  function withdrawReplPlacementNow(instanceId: string): boolean {
    if (refuseWithdrawWhenSealed()) return false
    if (segmentStep.value?.id !== 'reinforcement.replRoll') return false
    const entry = replPlacedThisSegment.value.find((item) => item.instanceId === instanceId)
    if (entry === undefined) return false
    const before = units.value.length
    units.value = units.value.filter((unit) => unit.instanceId !== instanceId)
    if (units.value.length === before) return false
    replPlacedThisSegment.value = replPlacedThisSegment.value.filter(
      (item) => item.instanceId !== instanceId,
    )
    replPending.value = {
      ...replPending.value,
      [entry.kind]: replPending.value[entry.kind] + 1,
    }
    if (selectedId.value === instanceId) selectedId.value = null
    pushLog('info', '收回本段落位：点数退回待放手牌（13.5a）', '13.5')
    return true
  }

  watch(
    () => `${turn.value}|${activeSide.value}|${segmentStep.value?.id ?? ''}`,
    () => {
      /*
       * 撤回只在本段内有效：离开第二段或换方/换回合即清空。
       * ★ 1.6c 返场（`specialReplPlacedThisSegment`）与 2.3c 编制转化（`frontalUnitPlacedThisSegment`）
       *   同样只在第二段内可收回——两条 `withdraw` 都只按 `segmentStep.id` 把关、不看回合，
       *   修前这两个登记从不清零 ⇒ 下一回合的第二段还列着上一回合已落位的算子，能把已经
       *   上场（甚至已移动/参战）的算子"收回"死亡堆与手牌。与补员撤回同一时点清空。
       */
      if (segmentStep.value?.id !== 'reinforcement.replRoll') {
        replPlacedThisSegment.value = []
        specialReplPlacedThisSegment.value = []
        frontalUnitPlacedThisSegment.value = null
      }
    },
  )

  /**
   * 第三段：本段已重建的算子（用于「再点一下收回」并退回补员）
   *
   * v7.1 §1.1 / §4.5：撤回**只在本段内有效**——离开重建段（或换方/换回合）即清空，
   * 防止把上一段的成果再撤回。记录只存“重建前的形状”，不存整份盘面。
   */
  interface RebuildPlacementRecord {
    instanceId: string
    /** 重建来源：死亡堆 / 图上打残 / 空军基地 / 地图外空军盒 */
    mode: 'deadPile' | 'onMap' | 'airBase' | 'airBox'
    priorSteps: number
    priorHex: HexRef | null
    priorAirStatus: 'active' | 'inactive' | null
    /** 地面重建时被扣补员的格（退回时按同一格补回） */
    replHex: HexRef | null
    cost: { pax: number; eq: number; ftr: number; tac: number }
  }
  const rebuildPlacedThisSegment = ref<RebuildPlacementRecord[]>([])

  watch(
    () => `${turn.value}|${activeSide.value}|${segmentStep.value?.id ?? ''}`,
    () => {
      // 撤回只在本段内有效：离开重建段或换方/换回合即清空
      if (segmentStep.value?.id !== 'reinforcement.rebuild') rebuildPlacedThisSegment.value = []
    },
  )

  /**
   * §5-D：把**某一族**待放置补员摆到指定格（每点一枚）
   *
   * 落点按 2.1 到货条：能直接拖取追溯补给的友方 HQ，否则图边补给源格；不合法就**给出原因**
   * 并保留待放置态，而不是静默失败。另一族的待放置数不受影响。
   */
  function placePendingReplNow(hex: HexRef, kind: SavableReplKind): boolean {
    const count = replPending.value[kind]
    if (count === 0) {
      pushLog('warning', `没有待放置的 ${kind === 'pax' ? 'Pax' : 'Eq'} 补员（13.5）`, '13.5')
      return false
    }
    const legal = replInitialPlacementHexesFor.value[kind].some(
      (item) => item.col === hex.col && item.row === hex.row,
    )
    if (!legal) {
      const reason =
        replPlacementBlockedReasonFor(kind) ??
        `${hexLabel(hex)} 不能放补员（2.1：须是能直接拖取追溯补给的 HQ 或图边补给源格）`
      pushLog('warning', `补员不能放在 ${hexLabel(hex)}：${reason}`, '13.5')
      return false
    }
    if (replRecordOf(activeSide.value, kind) === null) {
      pushLog(
        'danger',
        `单位库里没有 ${kind === 'pax' ? 'Pax' : 'EQ'} 补员算子，本次不放置（13.5）`,
        '13.5',
      )
      return false
    }
    if (!placeReplCounters(hex, kind, count)) return false
    replPending.value = { ...replPending.value, [kind]: 0 }
    const pendingOther = replPending.value.pax + replPending.value.eq
    pushLog(
      'success',
      `补员已放置于 ${hexLabel(hex)}：${count} ${kind === 'pax' ? 'Pax' : 'Eq'}（13.5a：每点一枚，可随后移动）${
        pendingOther > 0 ? '；另一族仍在待放置' : ''
      }`,
      '13.5',
    )
    return true
  }

  /** 13.5 + 专规 1.6 Notes：清零不可保存的 Ftr / Tac 补员（增援阶段结束时） */
  function clearNonSavableReplNow(): void {
    /*
     * 13.5：**哪些补员可跨回合保存**由引擎的 `isSavableRepl` 判（Pax / Eq 可存、Ftr / Tac 不可），
     * 本处只按它的结论清零；Pax / Eq 是盘面算子（§5-D），本来就不会被这条清零。
     */
    const doomed: Partial<ReplHoldings> = {}
    for (const key of ['ftr', 'tac', 'pax', 'eq'] as const) {
      if (!isSavableRepl(key)) doomed[key] = 0
    }
    const lost = replFtrTac.value.ftr + replFtrTac.value.tac
    replFtrTac.value = { ftr: 0, tac: 0 }
    pushLog(
      'info',
      lost === 0
        ? `${Object.keys(doomed).join(' / ')} 补员无剩余（13.5：不可保存）`
        : `${Object.keys(doomed).join(' / ')} 补员清零 ${lost} 点（13.5：只补 1 step 且**不可保存**）`,
      '13.5',
    )
  }

  /**
   * B18：掷可变增援（1.6b 补给表与补员表 / 1.6c 特殊补员 / 3.3c 可变撤离 / 3.6 随机事件）
   *
   * 骰面由 `variableReplInputs` 给出（`autoRoll` 时用种子化 RNG 现掷）；结论落 `lastVariableRepl`，
   * 补员立即入账（Ftr/Tac 仍需在阶段末清零）；SP 与免费重建按 2.1 的落点由裁判投放。
   */
  function rollVariableReplNow(): boolean {
    const key = `${turn.value}|${activeSide.value}|reinforcement`
    if (session.session !== null && automaticPhaseKeys.value.includes(key)) return true
    // 3.6：重掷后重新给一次落点机会（上一掷若已落过，仍按新结果重置）
    resetSupplyTrainPlacement()
    // 放置阶段的暂存（勾选 / 余额格 / 3.4b 归属）逐轮重置，避免把上一轮的落点带进这一轮
    freeRailPicked.value = []
    freeRailEdgeHex.value = null
    clearArrivalSpGroups()
    frontalReservesSpPending.value = 0
    variableReplSpecialDie.value = null
    const inputs = variableReplInputs.value
    // ⑭ 接线：下面两个闭包只回报数字（不改它们）⇒ 先记下掷骰前的骰源，末尾按实际掷骰顺序复算骰面
    const rngBefore = rng.value
    const draw2d6 = (): number => {
      const draw = roll2d6(rng.value)
      rng.value = draw.rng
      drawCount.value += 1
      return draw.value.total
    }
    const draw1d6 = (): number => {
      const draw = roll1d6(rng.value)
      rng.value = draw.rng
      drawCount.value += 1
      return draw.value.total
    }
    /*
     * 教学局免掷骰（用户 2026-11-19）：剧本卡 Reinforcements: None + Variable Repls: None
     * ⇒ 增援段本无部队、无可变补员。教学不消耗 RNG，直接给固定结果：
     *   补给表 2d6=7 → 7 SP（"6-8" 行）；补员表 2d6=5 → "7 or less" 行 = 零；
     *   可变撤离 1（8 Jul 未到 19 Aug，不结算）；随机事件 7（19 Jul 前不在窗口）。
     * 判定仍走 planVariableReinforcement 原路，只是骰面固定。
     */
    const drill = tutorialFixedReinforcement.value
    const supplyDice = drill ? 7 : inputs.autoRoll ? draw2d6() : inputs.supplyDice
    const replDice = drill ? 5 : inputs.autoRoll ? draw2d6() : inputs.replDice
    // 1.6c 不在这一批：它在 `drawSpecialRepl` 执行时自己掷（原文「also get to roll a die」）
    const variableExitDie = drill ? 1 : inputs.autoRoll ? draw1d6() : inputs.variableExitDie
    const randomEventDice = drill ? 7 : inputs.autoRoll ? draw2d6() : inputs.randomEventDice
    // ⑭ 接线：按实际掷骰顺序复算骰面（补给 2d6 → 补员 2d6 → 可变撤离 1d6 → 随机事件 2d6）
    const rolls: DiceRoll[] = []
    if (inputs.autoRoll) {
      let cursor = rngBefore
      for (const count of [2, 2, 1, 2]) {
        const derived = count === 2 ? roll2d6(cursor) : roll1d6(cursor)
        cursor = derived.rng
        rolls.push(derived.value)
      }
    }

    const data = acceptReinforcement(
      planVariableReinforcement({
        side: activeSide.value,
        date: date.value,
        supplyDice,
        replDice,
        variableExitDie,
        randomEventDice,
        // 3.3c：已了结则不再掷（「1 或 6 ⇒ 该单位移除，撤离判定结束」）
        variableExitResolved: variableExitResolved.value,
        // 3.6 / 4.1b：4.0 逐条勾选里「4.1b 更多轴心补给」启用时，8 / 12 / 15 Jul 自动 Supply Train
        option4_1b: session.rule4On('moreAxisSupply'),
      }),
      '可变增援',
    )
    if (data === null) return false
    /*
     * 教学局（用户 2026-11-19 改口径）：**不给免费补员/免费重建** ——
     * 补员单位改从 1.6b 补员表发放（Pax ×1、Eq ×1），玩家在重建阶段花补员
     * 从死人堆拉回单位（13.5a：补员同格、战斗模式 HQ 两格内）。
     * 剧本卡 Variable Repls: None 的"零补员"对教学是障碍，故这里按教学局口径固定发放。
     */
    if (tutorialFixedReinforcement.value) {
      data.repl = { ...data.repl, ftr: 0, tac: 0, pax: 1, eq: 1, rowLabel: '教学发放' }
      // 1.6c 在教学中整个跳过：随补员表发放一并标记「已掷」，闸门才不会卡段落收束
      markSpecialReplDraw(activeSide.value, turn.value)
    }
    lastVariableRepl.value = data
    /*
     * 1.6b 补给表所得 SP：按原文进**到货落账池**（专规 1.6b「place new units per 2.1 and 3.1」
     * + 专规 2.1 / 3.1 的免费铁运）——每个可卸车城市格 1 SP（需标准/宽轨铁路连通），
     * 其余落地图边缘补给源格；玩家在统一手牌里逐格点，收束时由 `applySupplyArrivalsNow` 落账。
     *
     * 旧口径（用户 2026-11-13 裁定②）是把 SP 直接塞进图外空军盒；2026-11-15 按原文改回。
     * 换掷时若本回合还留着旧口径的盒内存款，先撤回，避免同一笔重复。
     */
    const previousDeposit = offMapRollDeposit.value
    if (
      previousDeposit !== null &&
      `${previousDeposit.turn}|${previousDeposit.side}` === `${turn.value}|${activeSide.value}`
    ) {
      addOffMapSupplyT(previousDeposit.side, -previousDeposit.t)
    }
    offMapRollDeposit.value = null
    supplyArrivalSp.value = Math.max(0, Math.trunc(data.sp))
    // 3.6：补给列车的落点须玩家选（任一可卸货格）；换掷即作废上一次的选择
    supplyTrainHex.value = null
    /*
     * 3.3c：「until a division … is Removed」⇒ **只有真正移除时才了结**。
     * 修前这里对 2–5（`reroll`）也置真 ⇒ 掷出"下回合再掷"后再也不会掷，与原文相反。
     */
    if (data.variableExit !== null && data.variableExit !== undefined) {
      if (data.variableExit.kind === 'remove') {
        variableExitResolved.value = true
        resolveVariableExitNow(data.variableExit)
        pushLog('warning', `3.3c 可变撤离已了结：${data.variableExit.description}`, '3.3c')
      } else {
        pushLog('info', `3.3c 可变撤离：${data.variableExit.description}`, '3.3c')
      }
    }
    // 补员入账（13.5：Pax/Eq 可保存；Ftr/Tac 不可保存，阶段末由调用方清零）
    addReplHoldingsNow({
      ftr: data.repl.ftr,
      tac: data.repl.tac,
      pax: data.repl.pax,
      eq: data.repl.eq,
    })
    // 3.6：机型结果 ⇒ 该型飞机立即全部转非激活
    if (data.randomEvent?.kind === 'aircraft' && data.randomEvent.aircraftType !== undefined) {
      const type = data.randomEvent.aircraftType
      // 3.6：表里是机型名（Bf.110），算子上是机型代号（F/T/…）⇒ 按机型名命中
      const hit = airUnits.value.filter(
        (air) => air.side === activeSide.value && matchesEventAircraftModel(type, air.name),
      )
      for (const air of hit) air.airStatus = 'inactive'
      pushLog(
        'warning',
        `${type} ×${hit.length} 立即转非激活（3.6 随机事件：被派往地图外任务）`,
        '3.6',
      )
    }
    pushLog('success', data.detail, data.rule)
    // ⑭ 接线：可变增援（1.6b 补给/补员表 / 1.6c 特殊补员 / 3.3c 可变撤离 / 3.6 随机事件）
    // 入会话日志；rolls＝本笔真实掷出的五颗骰（autoRoll 关闭时为空，由裁判手填）
    recordSettlement({
      action: 'variableRepl',
      rule: data.rule,
      rolls,
      data: {
        autoRoll: inputs.autoRoll,
        supplyDice,
        replDice,
        variableExitDie,
        randomEventDice,
        repl: {
          ftr: data.repl.ftr,
          tac: data.repl.tac,
          pax: data.repl.pax,
          eq: data.repl.eq,
        },
        randomEventKind: data.randomEvent?.kind ?? null,
        detail: data.detail,
      },
    })
    // 1.6b 已掷：判定阶段以此为"补员/补给两表已过"的凭据（手牌闸门认这一条）
    const rolledKey = `${String(turn.value)}|${activeSide.value}|reinforcement`
    if (!automaticPhaseKeys.value.includes(rolledKey)) {
      automaticPhaseKeys.value = [...automaticPhaseKeys.value, rolledKey]
    }
    return true
  }

  /**
   * 3.3c：把撤离结果**真正落到盘面**（1.6a）
   *
   * - 目标编队在场（盘面 / 死亡堆）⇒ 逐个 `removeFromPlayEverywhere`（1.6a：「regardless of its
   *   current situation, **even if in the dead pile**」）——撤离是"移出游戏"，**不是**进死亡堆；
   * - 盘面与死亡堆都没有该编队算子 ⇒ 落一条 `mode: 'select'` 的结算，由玩家按 1.6a
   *   「**it, or else a unit with identical factors**」挑一枚同印值算子顶替。
   *
   * ★ 修前这里只置 `variableExitResolved = true` 并写日志，**一个算子都没移**（3.3c 从未落地）。
   */
  function resolveVariableExitNow(result: VariableExitResult): void {
    const removedUnit = result.removedUnit
    if (removedUnit === undefined) return
    const formation = variableExitFormationOf(removedUnit)
    if (formation === null) {
      pushLog(
        'warning',
        `3.3c：撤离表称谓「${removedUnit}」没有对应的编队代号 ⇒ 请裁判手工处理`,
        '3.3c',
      )
      return
    }
    const targets: ConsoleUnit[] = [
      ...units.value,
      ...deadPile.value.filter((entry): entry is ConsoleUnit => !isAirDeadPileEntry(entry)),
    ].filter((unit) => unit.side === 'axis' && unit.formation === formation)
    if (targets.length === 0) {
      recordSettlement({
        action: 'variableExit',
        rule: '3.3c',
        data: { mode: 'select', removedUnit, formation },
        consumePendingRolls: false,
      })
      pushLog(
        'warning',
        `3.3c：${removedUnit} 已无算子在场 ⇒ 由玩家选择同印值算子移出游戏（1.6a）`,
        '3.3c',
      )
      return
    }
    for (const unit of targets) {
      removeFromPlayEverywhere(unit)
      pushLog('info', `${unit.name} 按 3.3c 撤离移出游戏（1.6a：不论处境）`, '3.3c')
    }
    recordSettlement({
      action: 'variableExit',
      rule: '3.3c',
      data: {
        mode: 'direct',
        removedUnit,
        formation,
        unitIds: targets.map((unit) => unit.instanceId),
      },
      consumePendingRolls: false,
    })
  }

  /**
   * 3.3c：剧本 7「开局即掷可变撤离」
   *
   * 原文：剧本 7 专规 `Roll for Variable Exit (3.3c).`；3.3c `On 19 August, start rolling during
   * every Axis Reinforcement Phase until a division, either SS Reich or 14th Motorized, is
   * Removed (using the 1.6a procedure).` 本局首回合 26 Aug 已在 19 Aug 之后 ⇒ **建会话时先掷一次**：
   *   · 1 → 移除 SS Reich 全部（1.6a：不论盘面/死亡堆；都不在场则改由玩家挑同印值算子）；
   *   · 6 → 移除 14 Mtr 全部；
   *   · 2–5 → 本次不了结，留到下个轴方增援阶段按 3.3c 续掷。
   *
   * 记账：先落 `variableExit` 结算（`data.mode = 'setupRoll'`，带骰面），再执行移除 ⇒
   * 移除产生的 `direct`/`select` 结算仍是日志末条，替补选择态与增援窗同源；
   * 展示沿用增援窗「可变撤离」段与 `variableExitResolved` 状态。
   */
  function rollVariableExitAtStartNow(fixedDie?: number): boolean {
    if (session.session === null) return false
    if (variableExitStartRolled.value) return false
    if (variableExitResolved.value) return false
    if (date.value < VARIABLE_EXIT_START) return false
    const die =
      fixedDie ??
      (variableReplInputs.value.autoRoll
        ? (() => {
            const draw = roll1d6(rng.value)
            rng.value = draw.rng
            drawCount.value += 1
            return draw.value.total
          })()
        : variableReplInputs.value.variableExitDie)
    const result = rollVariableExit(die, date.value)
    if (!result.active) return false
    recordSettlement({
      action: 'variableExit',
      rule: '3.3c',
      side: 'axis',
      data: { mode: 'setupRoll', die, kind: result.kind, removedUnit: result.removedUnit ?? null },
      // 开局这颗骰由本条结算入账，不能被后面的可变增援结算再吃一遍
      consumePendingRolls: true,
    })
    if (result.kind === 'remove') {
      variableExitResolved.value = true
      resolveVariableExitNow(result)
      pushLog('warning', `3.3c 开局可变撤离已了结：${result.description}`, '3.3c')
    } else {
      pushLog('info', `3.3c 开局可变撤离：${result.description}（下个轴方增援阶段再掷）`, '3.3c')
    }
    return true
  }

  /** 3.3c：是否有待玩家选择的替补（= 日志里最后一条撤离结算是 `select`） */
  const variableExitSelectionOpen = computed<boolean>(
    () => variableExitPendingSelection.value !== null,
  )

  /**
   * 3.3c 待选清单：**1.6a 的「identical factors」**＝战斗面印值 `attack/ar/ma` 三元组相等
   *
   * 参考印值取自单位库中该编队的记录（目标编队此刻已无实例 ⇒ 不能从盘面取）；
   * 候选只从**盘面**算子中挑（界面按格高亮＋点选，死亡堆没有格可点）。
   * 本机制**只列可选**：不可选者根本不进候选集（不是灰显）。
   */
  const variableExitSelectionSet = computed<UnitSelectionSet>(() => {
    const pending = variableExitPendingSelection.value
    if (pending === null) return { eligibleIds: [], hexes: [], byHex: [] }
    const factors = new Set<string>()
    for (const record of unitsAxis.units) {
      if (record.formation !== pending.formation) continue
      // 用与盘面实例**同一套投影**取印值（避免"库里写 6-5、实例投影成别的"这种错位）
      const view = toConsoleUnit({
        record,
        instanceId: `ref:${record.id}`,
        hex: { col: 0, row: 0 },
        side: 'axis',
      })
      factors.add(`${view.faces.combat.attack}|${view.faces.combat.ar}|${view.faces.combat.ma}`)
    }
    const candidates: {
      id: string
      col: number
      row: number
      eligible: boolean
    }[] = []
    for (const unit of units.value) {
      if (unit.side !== 'axis') continue
      if (unit.formation === pending.formation) continue
      if (!unit.isCombat) continue
      const key = `${unit.faces.combat.attack}|${unit.faces.combat.ar}|${unit.faces.combat.ma}`
      if (!factors.has(key)) continue
      candidates.push({ id: unit.instanceId, col: unit.hex.col, row: unit.hex.row, eligible: true })
    }
    return buildUnitSelectionSet(candidates)
  })

  /** 3.3c 待选的算子图阵列（只含可选者；`CounterPicker` 的纯投影数据） */
  const variableExitPickItems = computed(() => {
    const items: {
      id: string
      imageUrl: string | null
      name: string
      selected: boolean
      hex: HexRef
      groupKey: string
    }[] = []
    for (const id of variableExitSelectionSet.value.eligibleIds) {
      const unit = units.value.find((item) => item.instanceId === id)
      if (unit === undefined) continue
      items.push({
        id,
        imageUrl: counterImageUrlOf(unit),
        name: unit.name,
        selected: false,
        hex: { col: unit.hex.col, row: unit.hex.row },
        groupKey: `${unit.hex.col}.${unit.hex.row}`,
      })
    }
    return items
  })

  /**
   * 3.3c 待选时**有可选单位的格**（地图多格高亮的数据源）
   *
   * ★ 只在"当前是轴方增援阶段"时才给高亮：切换集团军 / 进入其它阶段 / 确认移除后
   *   （`pendingSelection` 归 null）一律清空，避免"格还亮着但已经不可点"的状态错位。
   */
  const variableExitPickHexes = computed<HexRef[]>(() =>
    activeSide.value === 'axis' && phase.value === 'reinforcement'
      ? [...variableExitSelectionSet.value.hexes]
      : [],
  )

  /**
   * 3.3c：玩家点选一枚同印值算子顶替撤离（1.6a）
   *
   * 只接受 `variableExitSelectionSet.eligibleIds` 里的 id（不在清单内＝规则上不可选，直接拒绝）。
   */
  function confirmVariableExitSubstitute(instanceId: string): boolean {
    const pending = variableExitPendingSelection.value
    if (pending === null) return false
    if (!variableExitSelectionSet.value.eligibleIds.includes(instanceId)) {
      pushLog('warning', `3.3c：该算子不在可选清单内（1.6a 只允许同印值算子）`, '1.6a')
      return false
    }
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return false
    removeFromPlayEverywhere(unit)
    pushLog(
      'info',
      `${unit.name} 作为 ${pending.removedUnit} 的替补移出游戏（1.6a：同印值）`,
      '1.6a',
    )
    recordSettlement({
      action: 'variableExit',
      rule: '1.6a',
      data: {
        mode: 'confirm',
        removedUnit: pending.removedUnit,
        formation: pending.formation,
        unitId: instanceId,
      },
    })
    hoverHex.value = null
    return true
  }

  /** 3.3c：悬停待选清单里的一枚 ⇒ 同步地图高亮（`CounterPicker` 的 `hover` 事件） */
  function setVariableExitHover(instanceId: string | null): void {
    if (instanceId === null) {
      hoverHex.value = null
      return
    }
    const unit = units.value.find((item) => item.instanceId === instanceId)
    hoverHex.value = unit === undefined ? null : { col: unit.hex.col, row: unit.hex.row }
  }

  /** 13.6：到达卡机型 → 机型库记录（精确名 → 归一唯一命中）；找不到即报错并返回 null */
  function resolveArrivalAircraft(demand: ArrivalUnitDemand): AircraftRecordView | null {
    const name = demand.name ?? demand.raw
    const pool = aircraftChoices(activeSide.value)
    const exact = pool.find((item) => item.name === name)
    const key = unitNameKey(name)
    const sameKey = exact === undefined ? pool.filter((item) => unitNameKey(item.name) === key) : []
    const aircraft = exact ?? (sameKey.length === 1 ? sameKey[0] : undefined)
    if (aircraft === undefined) {
      reinforcementError.value = { rule: '13.6', reason: `arrivalUnitNotResolved:${demand.raw}` }
      pushLog(
        'danger',
        `机型库里找不到「${name}」对应机型 ⇒ 请在"库中型号"里挑一架再投放（13.6）`,
        '13.6',
      )
      return null
    }
    return aircraft
  }

  /**
   * 专规 1.4a / 13.6（U25）：把**飞机**到达条目直接投放到**图外空军盒**
   *
   * 「任意友方空军基地」按基地算 ⇒ 盒在内；盒无地图格号，故落点记在盒成员账本。
   * 盒容量无限、整备免费（1.4a），故不执行 14.2a 的图上基地堆叠上限。
   */
  function placeArrivalInAirBoxNow(index: number): boolean {
    if (!requireAction('rein.arrival', '到达投放')) return false
    if (arrivalRemovalsPending.value) {
      reinforcementError.value = { rule: '1.6a', reason: 'arrivalRemovalsFirst' }
      return false
    }
    const demand = arrivalPlan.value?.units[index]
    if (demand === undefined) return false
    if (arrivalPlaced.value[index] === true) {
      pushLog('warning', `${demand.raw}：该到达条目已投放，勿重复（13.6）`, '13.6')
      return false
    }
    const box = arrivalAirBoxOf(index)
    if (box === null) {
      reinforcementError.value = { rule: '13.6', reason: 'noAirbase' }
      pushLog(
        'warning',
        '无法投放到图外空军盒：该条目的落点不是「任意友方空军基地」（13.6）',
        '13.6',
      )
      return false
    }
    const aircraft = resolveArrivalAircraft(demand)
    if (aircraft === null) return false
    const copies = arrivalCopiesOf(demand)
    const anchor = { col: airBoxEdgeColumn(activeSide.value), row: 1 }
    const arrived = Array.from({ length: copies }, () =>
      toConsoleAirUnit({
        aircraft,
        instanceId: createId('arr-air'),
        hex: anchor,
        side: activeSide.value,
        airStatus: 'active',
      }),
    )
    airUnits.value = [...airUnits.value, ...arrived]
    for (const unit of arrived) setAirInBoxMembership(unit.instanceId, true)
    pushLog(
      'success',
      `${demand.raw} 投放于 ${box.label}（13.6 / 1.4a：飞机在友方空军基地以激活状态到达${
        copies > 1 ? `，共 ${String(copies)} 架` : ''
      }）`,
      '13.6',
    )
    recordSettlement({
      action: 'arrival',
      rule: '13.6',
      data: {
        index,
        kind: demand.kind,
        raw: demand.raw,
        airBox: box.id,
        aircraftId: arrived[0]!.instanceId,
      },
    })
    markArrivalPlaced(
      index,
      arrived.map((unit) => unit.instanceId),
    )
    // 若这条刚刚点出了「选格」，盒投放已是终点 ⇒ 收掉选格态，免得状态栏还要求点格
    if (pendingHexPick.value?.arrivalIndex !== undefined) pendingHexPick.value = null
    reinforcementError.value = null
    return true
  }

  /**
   * B18：按到达卡投放一个条目（13.6 / 13.6b / 1.6a）
   *
   * ★ **不做「到达卡条目 → 算子记录」的映射**：本作工程库未落该映射，故由裁判从单位库选算子
   *   （`recordId` 缺省时按 `unitChoices` 的显示名与到达卡 `name` 精确匹配，匹配不到即拒绝并提示）。
   */
  function placeArrivalNow(index: number, recordId?: string, hexText?: string): boolean {
    if (!requireAction('rein.arrival', '到达投放')) return false
    // 1.6a：强制移除未执行前不得放置（与图外盒投放、结束本段同一道闸）
    if (arrivalRemovalsPending.value) {
      reinforcementError.value = { rule: '1.6a', reason: 'arrivalRemovalsFirst' }
      return false
    }
    const plan = arrivalPlan.value
    if (plan === null) return false
    const demand = plan.units[index]
    if (demand === undefined) return false
    // 13.6：同一到达条目只能投放一次（修前无账本，可反复投放凭空多出算子）
    if (arrivalPlaced.value[index] === true) {
      pushLog('warning', `${demand.raw}：该到达条目已投放，勿重复（13.6）`, '13.6')
      return false
    }
    if (demand.kind === 'sp' || demand.kind === 'unclassified') {
      pushLog(
        'warning',
        `${demand.raw}：该条目不是算子（${demand.kind}），请按卡面在落点手工记账（13.6）`,
        '13.6',
      )
      return false
    }
    const placed = arrivalPlacements.value[index]
    if (placed === undefined) {
      reinforcementError.value = { rule: '13.6', reason: 'noPlacementHex' }
      pushLog('danger', '无法投放：落点未定', '13.6')
      return false
    }
    // 显式手输的落点优先（仍要过下面的「敌占 / 候选」两道闸）；两者都没有才报落点未定
    const typedHex = hexText === undefined ? undefined : parseHexPath(hexText)[0]
    if (typedHex === undefined && placed.hex === null) {
      reinforcementError.value = { rule: placed.rule, reason: 'noPlacementHex' }
      pushLog('danger', `无法投放：${placed.detail}`, placed.rule)
      return false
    }
    const hex = typedHex ?? placed.hex!
    /*
     * 4.8c / 13.6b：**不得落在敌单位格**
     *
     * 13.6b 只允许增援「放在有敌方 ZOC 的格中」，并未允许与敌方单位同格；4.8c 亦禁止敌对单位同格。
     * 候选已按此过滤（敌占格不在候选内），但手改/手输落点可能绕开，故在投放处再挡一次并给可见原因。
     */
    if (arrivalFacts.value.isBlocked(hex)) {
      reinforcementError.value = { rule: '13.6b', reason: 'arrivalHexEnemyOccupied' }
      pushLog(
        'warning',
        `无法投放：${hexTextOf(hex)} 内有敌方单位。增援可进入敌方 ZOC，但不得与敌方单位同格（13.6b / 4.8c）`,
        '13.6b',
      )
      return false
    }
    /*
     * 13.6（用户 2026-10-25 实测 BUG①）：**投放时**也按卡面候选校验一遍
     * （不只"选格"那一步——验证页还能手输落点，绕过选格就能任意放）。
     *
     * ★ 候选为空 ⇒ **必须拒绝**（修前 `allowed.length > 0 && …` 在候选为空时放行任意显式格，
     *   等于给了一条"只要在地图上就允许"的宽松路径）。
     */
    const allowed = arrivalCandidates.value[index] ?? []
    if (!allowed.some((item) => item.col === hex.col && item.row === hex.row)) {
      if (allowed.length === 0) {
        reinforcementError.value = { rule: '13.6', reason: 'arrivalNoCandidateHex' }
        pushLog(
          'warning',
          `无法投放：该到达条目当前没有合法落点（13.6：候选为空——入场格/基地/补给源均不可用，或全被敌方单位占据）`,
          '13.6',
        )
        return false
      }
      reinforcementError.value = { rule: '13.6', reason: 'arrivalHexOutsideCandidates' }
      pushLog(
        'warning',
        `无法投放：${hexTextOf(hex)} 不在该到达条目的落点范围内（13.6：共 ${String(allowed.length)} 处候选）`,
        '13.6',
      )
      return false
    }

    /*
     * 13.6：**飞机到达**单独一条分支
     *
     * 修前这里与地面共用同一条记录解析（`choices` = 陆战单位库），而飞机根本不在那张表里
     * ⇒ 每条飞机到达都必然 `arrivalUnitNotResolved`（实测 `2x He.111` 在基地就位时仍拒绝），
     * 于是增援卡上的飞机条目只能靠初设面板手工摆。现在按 `aircraftChoices` 解析，
     * 同一套「精确 → 归一唯一命中」判据（`He.111` ↔ `Ge He.111`），并遵守卡面的 `2x` 枚数。
     */
    if (demand.kind === 'aircraft') {
      const aircraft = resolveArrivalAircraft(demand)
      if (aircraft === null) return false
      const copies = arrivalCopiesOf(demand)
      /*
       * 14.2a：**该基地格的激活飞机堆叠上限 = 4 + 基地等级**（简易机场恒为 4）
       *
       * 4.8 只约束**战斗单位**（飞机不是战斗单位，`RE` 计 0），因此飞机到场的堆叠检查落在 14.2a；
       * 超限即拒绝（带可见原因），不把基地挤爆。
       */
      const base = airBases.value.find(
        (item) => item.side === activeSide.value && sameHex(item.hex, hex),
      )
      if (base !== undefined) {
        const activeNow = activeAircraftInBase(allAirViews.value, hex)
        const limit = activeStackingLimitOf(base)
        if (activeNow + copies > limit) {
          reinforcementError.value = { rule: '14.2a', reason: 'arrivalAirBaseOverstack' }
          pushLog(
            'warning',
            `无法投放：${hexLabel(hex)} 的激活飞机已 ${String(activeNow)} 架，再落 ${String(copies)} 架将超过上限 ${String(limit)}（14.2a：4 + 基地等级）`,
            '14.2a',
          )
          return false
        }
      }
      const arrived = Array.from({ length: copies }, () =>
        toConsoleAirUnit({
          aircraft,
          instanceId: createId('arr-air'),
          hex,
          side: activeSide.value,
          airStatus: 'active',
        }),
      )
      airUnits.value = [...airUnits.value, ...arrived]
      pushLog(
        'success',
        `${demand.raw} 投放于 ${hexLabel(hex)}（13.6：飞机在友方空军基地以激活状态到达${
          copies > 1 ? `，共 ${String(copies)} 架` : ''
        }）`,
        '13.6',
      )
      // ⑭ 接线：到达投放（13.6，飞机）入会话日志（本笔不掷骰）
      recordSettlement({
        action: 'arrival',
        rule: '13.6',
        data: {
          index,
          kind: demand.kind,
          raw: demand.raw,
          hex: { ...hex },
          aircraftId: arrived[0]!.instanceId,
        },
      })
      markArrivalPlaced(
        index,
        arrived.map((unit) => unit.instanceId),
      )
      // 与地面分支同口径：成功投放即收掉上一次被拒的红字（否则面板会挂着旧原因到下一段）
      reinforcementError.value = null
      return true
    }

    /*
     * 13.6c / 12.5f：一枚到达算子的**到场修正**（带损 / 满载 SP / 未加油）
     *
     * 单枚、`Nx` 同型复制、编成条目逐枚投放**共用**这一份，避免三处各写一遍后漂移。
     * `quiet` 供复制/编成的后续枚用：逐枚都刷一遍日志只会把日志刷爆。
     */
    const buildArrivalUnit = (record: UnitRecordView, quiet = false): ConsoleUnit => {
      const created = toConsoleUnit({
        record,
        instanceId: createId('arr'),
        hex,
        side: activeSide.value,
      })
      /*
       * 专规 2.4：30/28/24 集团军的师**到场即锁定**——解锁前不能移动、不能拆 breakdown。
       * 归属只取自到达卡分组里的 `Nth Army HQ (see 2.4)`，不按番号前缀猜。
       */
      if (demand.slowMobilizationArmy !== null) {
        created.slowMobilizationArmy = demand.slowMobilizationArmy
        created.locked = true
        if (!quiet) {
          pushLog(
            'info',
            `${created.name} 到场为第 ${demand.slowMobilizationArmy} 集团军的锁定师（2.4：解锁按表 2-2）`,
            '专规 2.4',
          )
        }
      }
      // 到达卡 `-N step`：到场即带损
      if (demand.stepsLost > 0) {
        created.steps = Math.max(0, created.steps - demand.stepsLost)
      }
      /*
       * 13.6c：**运输点数满载 SP 入场**（用户 2026-09-15 裁定）
       *
       * 「通用的运输点数**有几点运力就是几**（例如该回合有 3 点马车点数增援，就视为装着 3 SP 进场）；
       *   **编内卡车全部只有 1 点运力**（印值 1F-45），故编内卡车恒为 1 SP。」
       * 即：装载量 = 该算子的**运力点数**（`noncombatTransport`）——编内卡车的数据里运力就是 1 ✓。
       * 修前只落一句「请在 SP 账本登记」的提示，把数字留给玩家手填。
       */
      if (demand.loadedWithSp && created.noncombatTransport > 0) {
        const cargoSp = created.noncombatTransport
        created.loadedSpT = cargoSp * SP_TO_T
        if (!quiet) {
          pushLog(
            'info',
            `${created.name} 满载进场：${cargoSp} 点运力 ⇒ 载 ${cargoSp} SP（13.6c）`,
            '13.6c',
          )
        }
      }
      /*
       * 12.5f：「增援单位的**部署不需要燃料补给**，但是**移动离开入场格时**，则需要支付燃料补给。
       *   增援单位在抵达的回合，不会获得『免费的燃料补给』。」
       *
       * ★ 落点即置**未加油**：部署本身不花 MP（故不需燃料），而一旦要消耗 MP 就必须先付——
       *   这正是 12.5f 的两半。此前依赖 `toConsoleUnit` 的便利缺省 `fuelled: true`，
       *   于是刚到的增援可以直接开走、**一分燃料都不付**。
       */
      if (needsFuelToMove(toMoveUnitView(created))) {
        created.fuelled = false
        created.fuelMethod = null
        if (!quiet) {
          pushLog(
            'info',
            `${created.name} 以**未加油**到场：部署不需燃料，但移动离开入场格须先付燃料（12.5f）`,
            '12.5f',
          )
        }
      }
      return created
    }

    /*
     * 13.6 / §5-A：**编成条目逐枚投放**（`19 Pz Div (I-27 Pz, II-27 Pz, …)`）
     *
     * 卡面把"数枚算子共同到场"写成一个条目；修前这类条目连 kind 都落到 `unclassified`
     * ⇒ 直接被"不是算子"挡掉，整条永远进不了场。
     * 判据：编队号前缀内按「番号 + 兵种别名」**唯一**命中才投；有任何一枚命中不了就不猜，
     * 整条交裁判手工逐枚摆入（`resolveArrivalFormation` 给出缺哪几枚）。
     */
    /*
     * 3.4b（用户 2026-11-11）：**随运输队入场的 SP**
     *   · 编队单位随编队自然已有集群（算子自带 `panzerGroup`）⇒ 不再要求指定；
     *   · 非编队单位带来的 SP ⇒ 入场前必须选 Guderian / Hoth，未选就拒绝投放（不落未归属载货账）。
     */
    const gatedAxisCargo =
      demand.loadedWithSp && panzerGroupRulesOn.value && activeSide.value === 'axis'
    const ensureCargoGroup = (hasGroup: boolean, label: string): boolean => {
      if (!gatedAxisCargo || hasGroup || transportSpGroupDraft.value !== null) return true
      reinforcementError.value = { rule: '3.4b', reason: 'arrivalSpGroupRequired' }
      pushLog(
        'warning',
        `${label}：运输点带来的 SP 必须先选装甲集群（Guderian / Hoth）再投放（3.4b）`,
        '3.4b',
      )
      return false
    }
    const assignArrivalCargoGroups = (list: readonly ConsoleUnit[]): void => {
      if (!gatedAxisCargo) return
      for (const item of list) {
        if (item.loadedSpT <= 0) continue
        const group = item.panzerGroup ?? transportSpGroupDraft.value
        if (group !== null) setDumpPanzerGroupNow(`unit:${item.instanceId}`, group)
      }
      transportSpGroupDraft.value = null
    }

    /*
     * 13.6a：**地面单位允许到场时超堆叠**——到场阶段不做 4.8a 的 10 RE 拦截，
     * 到场结束后再由 `stackingObligations` 按 4.8a 处理（4.8a 对增援阶段本来就豁免）。
     */

    const formation = resolveArrivalFormation(index)
    if (formation !== null) {
      if (
        !ensureCargoGroup(
          formation.records.every((record) => (record.panzerGroup ?? null) !== null),
          demand.raw,
        )
      )
        return false
      if (formation.missing.length > 0) {
        reinforcementError.value = {
          rule: '13.6',
          reason: `arrivalFormationUnresolved:${demand.raw}`,
        }
        pushLog(
          'danger',
          `${demand.raw}：编成里 ${String(formation.missing.length)} 枚在单位库里命中不了唯一算子` +
            `（${formation.missing.join('、')}）⇒ 请按卡面手工逐枚摆入（13.6：引擎不臆造条目→算子的映射）`,
          '13.6',
        )
        return false
      }
      const arrived = formation.records.map((record) => buildArrivalUnit(record))
      units.value = [...units.value, ...arrived]
      assignArrivalCargoGroups(arrived)
      pushLog(
        'success',
        `${demand.raw} 投放于 ${hexLabel(hex)}：编成共 ${String(arrived.length)} 枚（13.6）`,
        '13.6',
      )
      recordSettlement({
        action: 'arrival',
        rule: '13.6',
        data: {
          index,
          kind: demand.kind,
          raw: demand.raw,
          hex: { ...hex },
          unitId: arrived[0]!.instanceId,
          formationCount: arrived.length,
          formationComponents: formation.components,
        },
      })
      markArrivalPlaced(
        index,
        arrived.map((unit) => unit.instanceId),
      )
      return true
    }

    /*
     * 13.6：**逐枚点名的多枚条目**（`2x Corps HQ (9, 12)`）
     *
     * 每次投放只落其中一枚，并按卡面点名记账；两枚（或 N 枚）都落位后条目才算投放完毕。
     * 未指定型号时自动取**剩余的第一枚**；显式指定的型号必须正是剩下的某一枚（否则不猜）。
     */
    const namedCopies = arrivalNamedCopiesOf(demand)
    let namedCopy: string | null = null
    let record: UnitRecordView | null
    if (namedCopies.length > 0) {
      const placedNames = arrivalPlacedSlots.value[index] ?? []
      const remaining = namedCopies.filter((name) => !placedNames.includes(name))
      namedCopy =
        recordId === undefined
          ? (remaining[0] ?? null)
          : (remaining.find((name) => arrivalRecordForNamedCopy(demand, name)?.id === recordId) ??
            null)
      record = namedCopy === null ? null : arrivalRecordForNamedCopy(demand, namedCopy)
      if (record === null) {
        reinforcementError.value = {
          rule: '13.6',
          reason: `arrivalNamedCopyUnresolved:${demand.raw}`,
        }
        pushLog(
          'danger',
          `${demand.raw}：还差 ${String(remaining.length)} 枚（${remaining.join('、')}），` +
            `但所选型号不在其中或库里匹配不到唯一算子 ⇒ 请在"库中型号"里挑剩余的那一枚（13.6）`,
          '13.6',
        )
        return false
      }
    } else {
      record =
        recordId === undefined
          ? matchArrivalRecord(demand.name ?? demand.raw)
          : (choices.value.find((item) => item.id === recordId) ?? null)
      if (record === null) {
        reinforcementError.value = { rule: '13.6', reason: `arrivalUnitNotResolved:${demand.raw}` }
        pushLog(
          'danger',
          `单位库里找不到「${demand.name ?? demand.raw}」对应算子 ⇒ 请在**这一条到达需求的"库中型号"里挑一枚**再点投放（13.6：引擎不臆造条目→算子的映射）`,
          '13.6',
        )
        return false
      }
    }

    if (!ensureCargoGroup((record.panzerGroup ?? null) !== null, demand.raw)) return false

    /*
     * 13.6：**同型复制**（卡面 `2x 26-2-2 Arty Grp` 之类 ⇒ 两枚一模一样的算子都应到场）
     *
     * 修前 `count` 只进了文案、投放只落一枚，且随后被「已投放」账本挡住 ⇒ 另一半永远进不了场。
     * 枚数判据在引擎 `arrivalCopiesOf`（逐枚点名的括号、运输点数的运力数字都不算枚数）。
     */
    const copies = arrivalCopiesOf(demand)
    const arrivedUnits: ConsoleUnit[] = [buildArrivalUnit(record)]
    for (let copy = 1; copy < copies; copy += 1) {
      arrivedUnits.push(buildArrivalUnit(record, true))
    }
    units.value = [...units.value, ...arrivedUnits]
    const createdIds = arrivedUnits.map((item) => item.instanceId)
    if (copies > 1) {
      pushLog(
        'info',
        `${demand.raw}：卡面为 ${String(copies)} 枚同型算子 ⇒ 一并投放（13.6）`,
        '13.6',
      )
    }
    assignArrivalCargoGroups(arrivedUnits)
    const unit = arrivedUnits[0]!

    pushLog(
      'success',
      `${demand.raw} 投放于 ${hexLabel(hex)}` +
        (demand.stepsLost > 0 ? `（到场即带损 ${demand.stepsLost} step）` : '') +
        (demand.loadedWithSp
          ? '（13.6c：运输点满载 SP 入场，已自动归属到该单位/编组，无需再到 SP 账本登记）'
          : ''),
      '13.6',
    )
    // ⑭ 接线：到达投放（13.6）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'arrival',
      rule: '13.6',
      data: {
        index,
        kind: demand.kind,
        raw: demand.raw,
        hex: { ...hex },
        unitId: unit.instanceId,
        stepsLost: demand.stepsLost,
        loadedWithSp: demand.loadedWithSp,
      },
    })
    markArrivalPlaced(index, createdIds, namedCopy)
    if (namedCopy !== null) {
      const remaining = arrivalRemainingOf(index)
      if (remaining > 0) {
        pushLog(
          'info',
          `${demand.raw}：${namedCopy} 号已落位，本条还差 ${String(remaining)} 枚（13.6）`,
          '13.6',
        )
      }
    }
    reinforcementError.value = null
    return true
  }

  /**
   * 13.6b：该到达条目能否走**铁路运输**（裁定 3 的增援侧入口）
   *
   * 条件：增援阶段、尚未投放、单枚地面单位、解算入场格是「入场格且含铁路」（裁定 1）。
   * 只决定按钮出不出；落点合法性另由 `beginArrivalRailPickNow` 的候选给。
   */
  function railArrivalPlan(
    index: number,
    from?: HexRef,
  ): { entry: HexRef; cargo: RailCargoView; side: Side; recordId: string } | null {
    const base = railArrivalBaseOf(index)
    if (!('plans' in base)) return null
    if (from === undefined) return base.plans[0] ?? null
    return base.plans.find((plan) => sameHex(plan.entry, from)) ?? null
  }

  /**
   * 13.6b：增援铁路运输的**结构前提**（不查可达卸货格与运力）
   *
   * 拆成「结构前提 / 可达路线」两步，是为了让按钮的可用判据与执行侧同源：
   * 前者只说明"这一条是不是铁路运输的对象"，后者说明"现在真的运得走"。
   * 被拒时按具体缺项返回原因码，不再把几种原因 OR 成一句。
   *
   * ★ 多入口（`Entry I or J` / `B or C`）：起点返回**每个开放入口**，不能只取
   *   `resolveArrivalPlacement` 自动解出的第一个（修前 Entry I or J 只算 I ⇒
   *   J 有铁路也一直显示"入场格不含铁路"）。
   */
  function railArrivalBaseOf(
    index: number,
  ):
    | { plans: { entry: HexRef; cargo: RailCargoView; side: Side; recordId: string }[] }
    | { reason: string } {
    if (phase.value !== 'reinforcement') return { reason: 'arrivalRailNotPhase' }
    const plan = arrivalPlan.value
    if (plan === null) return { reason: 'arrivalRailNotPhase' }
    const demand = plan.units[index]
    if (demand === undefined) return { reason: 'arrivalRailNotPhase' }
    if (demand.kind !== 'unit') return { reason: 'arrivalRailNotGroundUnit' }
    if (arrivalPlaced.value[index] === true) return { reason: 'arrivalRailAlreadyPlaced' }
    // 裁定 3 第一版只做单枚条目：编成/多枚（含逐枚点名的 HQ）走普通投放
    if (arrivalCopiesOf(demand) !== 1 || arrivalNamedCopiesOf(demand).length > 0) {
      return { reason: 'arrivalRailMultiCopy' }
    }
    const placement = arrivalPlacements.value[index]
    if (placement === undefined) return { reason: 'arrivalRailNoPlacement' }
    const origins: HexRef[] = []
    const arrivalForRail = arrivalFacts.value
    if (demand.placement.kind === 'entryHex') {
      for (const letter of demand.placement.letters) {
        if (arrivalForRail.entryShutDown?.(letter) === true) continue
        for (const hex of arrivalForRail.entryHexes(letter)) {
          if (arrivalForRail.isBlocked(hex)) continue
          if (!origins.some((item) => sameHex(item, hex))) origins.push(hex)
        }
      }
    } else if ('hex' in placement && placement.hex !== null) {
      origins.push(placement.hex)
    }
    if (origins.length === 0) return { reason: 'arrivalRailNoPlacement' }
    const side = activeSide.value
    const facts = railMoveFacts.value
    const usable = origins.filter((hex) => facts.hasRail(hex) && facts.isEntryHex(hex, side))
    if (usable.length === 0) {
      return {
        reason: origins.some((hex) => facts.hasRail(hex))
          ? 'arrivalRailEntryNotEntryHex'
          : 'arrivalRailEntryNoRail',
      }
    }
    const record = arrivalRecordOf(index)
    if (record === null) return { reason: 'arrivalRailNoRecord' }
    const ma = record.factors?.move?.ma ?? 0
    const cargo: RailCargoView = {
      kind: 'unit',
      id: `arrival:${String(index)}`,
      side,
      re: record.reSize ?? 1,
      mobility: mobilityOf(record, 'move'),
      moveMa: ma,
      // 13.6b：增援可以任意主动模式入场；13.3e-1 要求铁路移动时处于移动模式
      mode: 'move',
      dg: false,
      currentMa: ma,
      preLoadMp: 0,
    }
    return { plans: usable.map((entry) => ({ entry, side, recordId: record.id, cargo })) }
  }

  /** 13.6b：该条目的铁路起点（多入口时逐个开放入口；供按钮/测试核对，不猜） */
  function arrivalRailOriginsOf(index: number): HexRef[] {
    const base = railArrivalBaseOf(index)
    return 'plans' in base ? base.plans.map((plan) => ({ ...plan.entry })) : []
  }

  /**
   * 13.6b / 裁定 3：该条目**此刻**的可铁路抵达路线
   *
   * `reachable`＝13.3c 可卸货格 ∩ 13.3e-2 路径可达（不筛运力）；
   * `candidates`＝其中成本 ≤ 本回合剩余运力的那些（按钮只在这些格上放行）。
   * 多入口时同一卸货格可能从 I / J 都可达 ⇒ 取成本更低的那个入口作为本次起点。
   */
  function arrivalRailRoutesOf(
    plans: readonly { entry: HexRef; cargo: RailCargoView; side: Side }[],
  ): {
    reachable: number
    minCost: number | null
    candidates: HexRef[]
    costs: Map<string, { cost: number; from: HexRef }>
  } {
    const costs = new Map<string, { cost: number; from: HexRef }>()
    const candidates: HexRef[] = []
    let reachable = 0
    let minCost: number | null = null
    for (const plan of plans) {
      for (const hex of detrainableHexes.value) {
        if (sameHex(hex, plan.entry)) continue
        const path = railPathBetween(plan.entry, hex, plan.side)
        if (path === null) continue
        const outcome = validateRailMovement({
          phase: phase.value as GamePhase,
          cargo: plan.cargo,
          from: plan.entry,
          to: hex,
          path,
          facts: railMoveFacts.value,
          arrivalRail: true,
          // 13.6b：「地图外登车」只属增援/新 SP 的抵达格；这条路径显式豁免 13.3e-1 的登车格检查
          entrainOffMap: true,
        })
        if (!outcome.ok) continue
        reachable += 1
        if (minCost === null || outcome.data.cost < minCost) minCost = outcome.data.cost
        if (outcome.data.cost > railCapRemaining.value[plan.side]) continue
        const key = hexLabel(hex)
        const previous = costs.get(key)
        if (previous !== undefined && previous.cost <= outcome.data.cost) continue
        if (previous === undefined) candidates.push(hex)
        costs.set(key, { cost: outcome.data.cost, from: plan.entry })
      }
    }
    return { reachable, minCost, candidates, costs }
  }

  /** 13.6b / 裁定 3：增援铁路运输按钮是否可用（不可用项不出现；与执行侧同源） */
  function arrivalRailEligible(index: number): boolean {
    const base = railArrivalBaseOf(index)
    if (!('plans' in base)) return false
    return arrivalRailRoutesOf(base.plans).candidates.length > 0
  }

  /** 13.6b：铁路运输被拒的具体原因（按钮不可用时也供日志 / 面板复用） */
  function arrivalRailRefusalOf(index: number): { rule: string; reason: string } | null {
    const base = railArrivalBaseOf(index)
    if (!('plans' in base)) return { rule: '13.6b', reason: base.reason }
    const routes = arrivalRailRoutesOf(base.plans)
    if (routes.candidates.length > 0) return null
    if (routes.reachable === 0) return { rule: '13.3c', reason: 'arrivalRailNoDetrainable' }
    return {
      rule: '13.3b',
      reason: `arrivalRailCapacity:${String(routes.minCost ?? 0)}:${String(
        railCapRemaining.value[base.plans[0]!.side],
      )}`,
    }
  }

  /**
   * 13.6b / 裁定 3：进入增援铁路运输的落点选择
   *
   * 候选＝13.3c 可卸货格 ∩ 13.3e-2 路径可达 ∩ 成本 ≤ 本回合剩余运力；
   * 多入口时每个候选格记下成本最低的入口，落子时从那个入口起运。
   * M2：点格**直接落子**（不再弹确认），只留一条「撤回」。
   */
  function beginArrivalRailPickNow(index: number): boolean {
    arrivalRailUndo.value = null
    const refusal = arrivalRailRefusalOf(index)
    const base = railArrivalBaseOf(index)
    if (!('plans' in base)) {
      reinforcementError.value = refusal
      pushLog('warning', `该增援不能走铁路运输：${railRefusalText(refusal)}（13.6b）`, '13.6b')
      return false
    }
    const { candidates, costs, reachable, minCost } = arrivalRailRoutesOf(base.plans)
    if (candidates.length === 0) {
      reinforcementError.value = refusal
      pushLog(
        'warning',
        reachable === 0
          ? '该增援没有可铁路抵达的卸货格（13.3c / 13.3e-2：入场格与任何可卸货格之间没有铁路通路）'
          : `本回合铁路运力不足：最近的卸货格需 ${String(minCost ?? 0)} 点、余 ${String(
              railCapRemaining.value[base.plans[0]!.side],
            )} 点（13.3b）`,
        '13.6b',
      )
      return false
    }
    beginHexPick({
      label: '增援铁路运输的卸货格（13.3c 可卸货格）',
      rule: '13.6b',
      candidates,
      apply: (hex) => {
        const route = costs.get(hexLabel(hex))
        if (route === undefined) return false
        const label = `${hexLabel(route.from)} → ${hexLabel(hex)}`
        if (!confirmArrivalRailNow({ to: hex, arrivalIndex: index, from: route.from })) {
          return false
        }
        arrivalRailUndo.value = {
          index,
          label,
          cost: route.cost,
          side: base.plans[0]!.side,
        }
        // 用户 2026-11-20：增援铁路抵达也进统一撤销账
        noteUndoable('arrival', `增援铁路抵达 ${label}`)
        return true
      },
    })
    return true
  }

  /** 13.6b：把铁路拒绝码翻成一句具体缺项（面板与日志共用） */
  function railRefusalText(refusal: { rule: string; reason: string } | null): string {
    const code = (refusal?.reason ?? '').split(':')[0] ?? ''
    switch (code) {
      case 'arrivalRailEntryNoRail':
        return '这一条的入场格不含铁路'
      case 'arrivalRailEntryNotEntryHex':
        return '这一条的落点不是入场格'
      case 'arrivalRailNotGroundUnit':
        return '这一条不是地面单位'
      case 'arrivalRailMultiCopy':
        return '这一条是多枚/编成条目，按逐枚普通投放'
      case 'arrivalRailNoPlacement':
        return '这一条的落点还没定'
      case 'arrivalRailNoRecord':
        return '单位库里找不到对应算子'
      case 'arrivalRailAlreadyPlaced':
        return '这一条已经投放完毕'
      case 'arrivalRailNoDetrainable':
        return '没有可铁路抵达的卸货格（13.3c）'
      case 'arrivalRailCapacity': {
        const [, need = '0', left = '0'] = refusal?.reason.split(':') ?? []
        return `铁路运力不足：需 ${need} 点、余 ${left} 点（13.3b）`
      }
      default:
        return '当前不在增援到达环节'
    }
  }

  /**
   * 13.6b：确认增援铁路运输（此刻才落子、扣运力；M2 起由点格直接调用）
   *
   * `from` 省略时取第一个开放入口；多入口（Entry I or J）由候选格带上成本最低的入口。
   */
  function confirmArrivalRailNow(input: {
    to: HexRef
    arrivalIndex: number
    from?: HexRef
  }): boolean {
    const index = input.arrivalIndex
    const plan = railArrivalPlan(index, input.from)
    if (plan === null) {
      pushLog('warning', '铁路运输被拒：所选起点不是这一条的开放入场格（13.6b）', '13.6b')
      return false
    }
    const path = railPathBetween(plan.entry, input.to, plan.side)
    if (path === null) return false
    const outcome = validateRailMovement({
      phase: phase.value as GamePhase,
      cargo: plan.cargo,
      from: plan.entry,
      to: input.to,
      path,
      facts: railMoveFacts.value,
      arrivalRail: true,
      // 13.6b：增援铁路抵达 ⇒ 显式豁免 13.3e-1 的登车格检查（普通单位不传）
      entrainOffMap: true,
    })
    if (!outcome.ok) {
      pushLog('warning', `增援铁路运输被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const remaining = railCapRemaining.value[plan.side]
    if (outcome.data.cost > remaining) {
      pushLog(
        'warning',
        `铁路容量不足：本次需 ${String(outcome.data.cost)} 点、本回合余 ${String(remaining)} 点（13.3b）`,
        '13.3b',
      )
      return false
    }
    const before = new Set(units.value.map((unit) => unit.instanceId))
    if (!placeArrivalNow(index, plan.recordId, hexTextOf(plan.entry))) return false
    const created = units.value.filter((unit) => !before.has(unit.instanceId))
    const unit = created[0]
    if (unit === undefined) return false
    unit.hex = { ...input.to }
    // 13.3e-3 / 4.7d：卸货后不得再移动；13.3e-1 要求铁路移动时处于移动模式
    unit.mode = { mode: 'move', orientation: 'move', dg: false, exploit: false }
    unit.movementEnded = true
    noteUnitLeftOwnBridgeHex(unit)
    spendRailCapacity(plan.side, outcome.data.cost)
    arrivalRailSpent.value[index] = outcome.data.cost
    lastRailMove.value = {
      rule: outcome.data.rule,
      detail: outcome.data.detail,
      cost: outcome.data.cost,
      path: path.map((hex) => ({ ...hex })),
    }
    pushLog(
      'success',
      `${unit.name} 经铁路抵达：${hexLabel(plan.entry)} → ${hexLabel(input.to)}｜` +
        `本回合已用容量 ${String(railCapUsedBy(plan.side))}/${String(railCapToday.value[plan.side])}`,
      '13.6b',
    )
    recordSettlement({
      action: 'arrivalRail',
      rule: '13.6b',
      data: {
        index,
        unitId: unit.instanceId,
        from: { ...plan.entry },
        to: { ...input.to },
        cost: outcome.data.cost,
      },
    })
    return true
  }

  /** 裁定 3：确认待定的铁路运输（移动阶段；增援抵达已改为点格即落子，见 M2） */
  function confirmRailTransportNow(): boolean {
    const pending = pendingRailTransport.value
    if (pending === null) return false
    railMoveInputs.value = { ...railMoveInputs.value, toHexText: hexTextOf(pending.to) }
    const ok = railMoveNow(pending.kind)
    if (ok) {
      pendingRailTransport.value = null
      railMovePreview.value = null
    }
    return ok
  }

  /** 裁定 3：撤回待定的铁路运输（不落子、不扣运力） */
  function cancelRailTransportNow(): boolean {
    if (pendingRailTransport.value === null) return false
    pendingRailTransport.value = null
    railMovePreview.value = null
    pushLog('info', '已撤回铁路运输：单位与运力都未变动（裁定 3）', '13.3e')
    return true
  }

  /**
   * M2：撤回**刚完成的增援铁路抵达**（一步撤回）
   *
   * 走既有的 `withdrawArrivalNow`：算子回手牌、本笔运力退回、到达账本还原。
   * 本函数只负责"这条撤回入口还挂着哪一笔"，不另立规则。
   */
  function undoArrivalRailNow(): boolean {
    const undo = arrivalRailUndo.value
    if (undo === null) return false
    // B2：段 / 方已变（或闸门已关）⇒ 这一笔已失效；收起并说明原因，不静默
    if (undo.side !== activeSide.value || !actionAllowedNow('rein.arrival')) {
      arrivalRailUndo.value = null
      pushLog(
        'warning',
        `撤回铁路抵达已失效：只能在「增援 · 抵达」环节由当时那一方撤回（13.6b）`,
        '13.6b',
      )
      return false
    }
    if (!withdrawArrivalNow(undo.index, undo.side)) {
      // withdrawArrivalNow 已写拒绝原因；记录已不可兑现 ⇒ 收起撤回条
      arrivalRailUndo.value = null
      return false
    }
    arrivalRailUndo.value = null
    pushLog('info', `已撤回铁路抵达：${undo.label}（运力已退回）`, '13.6b')
    dropUndoOf('arrival')
    return true
  }

  /**
   * 13.6：把已投放的到达算子**收回手牌**（可撤销重放，2026-11-09）
   *
   * 口径（按最宽松可撤销理解）：只要本笔仍在同一个到达计划键下，就按投放时登记的
   * instanceId 精确移除（含 `Nx` 同型复制、编成条目、飞机），并清掉本条的"已投放"账。
   * 这只是界面层的撤回，不是规则动作；不改任何校验，也不回滚已写的会话结算行。
   */
  function withdrawArrivalNow(index: number, side: Side = activeSide.value): boolean {
    if (refuseWithdrawWhenSealed()) return false
    if (!requireAction('rein.arrival', '撤回到达投放')) return false
    if (arrivalPlaced.value[index] !== true) {
      // B2：条还挂着但账本已不认这条 ⇒ 必须给原因，不能静默返回
      reinforcementError.value = { rule: '13.6', reason: `arrivalWithdrawNotPlaced:${index}` }
      pushLog(
        'warning',
        '这一条当前没有已投放记录，无法撤回（可能已撤过，或已换段 / 换方）',
        '13.6',
      )
      return false
    }
    const ids = arrivalPlacedUnits.value[index] ?? []
    if (ids.length === 0) {
      reinforcementError.value = { rule: '13.6', reason: `arrivalWithdrawNoLedger:${index}` }
      pushLog('warning', '这一条没有可撤回的投放记录（可能在读档后缺少账本）', '13.6')
      return false
    }
    const idSet = new Set(ids)
    units.value = units.value.filter((item) => !idSet.has(item.instanceId))
    airUnits.value = airUnits.value.filter((item) => !idSet.has(item.instanceId))
    // 3.4b：随运输队入场时写下的载货 SP 归属随算子一起撤回，避免留下幽灵归属
    const staleGroupIds = ids.map((id) => `unit:${id}`)
    if (staleGroupIds.some((id) => spDumpPanzerGroups.value[id] !== undefined)) {
      const nextGroups = { ...spDumpPanzerGroups.value }
      for (const id of staleGroupIds) delete nextGroups[id]
      spDumpPanzerGroups.value = nextGroups
    }
    pendingSpGroupAssignment.value = pendingSpGroupAssignment.value.filter(
      (id) => !staleGroupIds.includes(id),
    )
    syncArrivalLedger()
    const nextPlaced = { ...arrivalPlacedRaw.value }
    delete nextPlaced[index]
    arrivalPlacedRaw.value = nextPlaced
    const nextIds = { ...arrivalPlacedUnitsRaw.value }
    delete nextIds[index]
    arrivalPlacedUnitsRaw.value = nextIds
    const nextSlots = { ...arrivalPlacedSlotsRaw.value }
    delete nextSlots[index]
    arrivalPlacedSlotsRaw.value = nextSlots
    const nextOverrides = { ...arrivalHexOverrides.value }
    delete nextOverrides[index]
    arrivalHexOverrides.value = nextOverrides
    pendingHexPick.value = null
    reinforcementError.value = null
    // 裁定 3：经铁路抵达的条目被撤回 ⇒ 退回本笔运力
    const railSpent = arrivalRailSpent.value[index]
    if (railSpent !== undefined) {
      // B2：退给记录下来的那一方，不看当前 activeSide
      refundRailCapacity(side, railSpent)
      const nextSpent = { ...arrivalRailSpent.value }
      delete nextSpent[index]
      arrivalRailSpent.value = nextSpent
    }
    // M2：这条撤回已把刚落下的那笔退回 ⇒ 撤回条一并收起（不指向已消失的记录）
    if (arrivalRailUndo.value?.index === index) arrivalRailUndo.value = null
    pushLog('info', `已把 ${String(ids.length)} 枚到达算子收回手牌（可重放）`, '13.6')
    return true
  }

  /**
   * 1.6a：到达卡条目 → 该找哪些算子（**卡面写法**的三种形态，全部真实出现在到达卡里）
   *
   * - ① `12-2-2 Inf Div (186)` / `11-1-1 Inf Div (126, 214)` ⇒ 括号里是**番号**，
   *   与前面的兵种拼成算子名（`186 Rifle Div`）；多个番号＝多枚不同算子，各收 1 枚。
   * - ② `22nd Army HQ` / `26-1-1 Arty Bde` / `Ju.87b` ⇒ 没有括号，整串就是名字
   *   （印值 `26-1-1` 由 `unitNameKey` 当强度数码丢掉）。
   * - ③ `19 Pz Div (19 Aufk, III-27 Pz)`（只在 `deadPile` 列）⇒ 括号里是**部件名**，不是番号。
   * - 另有运输点数（`1 Wagon Point` / `10 Truck Points`）与整编队移除（`…; all units`）。
   *
   * ★ 修前判据是 `removal.raw.includes(unit.name)`：卡面写 `12-2-2 Inf Div (186)`、盘面叫
   *   `Ru 186 Rifle Div`，两者互不包含 ⇒ 19 Jul 苏方的 6 条强制移除**一条都没执行**，
   *   却在日志里写"请手工处理"，兵不血刃地放过了 22nd Army HQ 等 6 枚算子。
   */
  interface RemovalTargets {
    /** 名字键（`unitNameKey` 口径）——每个键最多收 `perKey` 枚 */
    keys: string[]
    /** 每个名字键收几枚（括号点名恒 1；`Nx` 同型复制为 N） */
    perKey: number
    /** `…; all units` ⇒ 命中这些编队番号的全部算子 */
    formations: string[]
    /** 运输点数（`N Truck Points` / `N Wagon Points`） */
    pointKind: 'truck' | 'wagon' | null
    pointCount: number
  }

  function removalTargetsOf(removal: { raw: string; kind: 'remove' | 'deadPile' }): RemovalTargets {
    const empty: RemovalTargets = {
      keys: [],
      perKey: 1,
      formations: [],
      pointKind: null,
      pointCount: 0,
    }
    const text = removal.raw.trim()
    const points = /^(\d+)\s+(Truck|Wagon)\s+Points?$/i.exec(text)
    if (points !== null) {
      return {
        ...empty,
        pointKind: points[2]!.toLowerCase() === 'truck' ? 'truck' : 'wagon',
        pointCount: Number(points[1]),
      }
    }
    const counted = /^(\d+)\s*x\s+/i.exec(text)
    const count = counted === null ? 1 : Number(counted[1])
    const body = (counted === null ? text : text.slice(counted[0].length)).trim()
    const paren = /\(([^)]*)\)/.exec(body)
    const inside = paren === null ? '' : paren[1]!
    const [cardList = '', annotation = ''] = inside.split(';')
    const typeText = body
      .replace(/\([^)]*\)/g, ' ')
      // 印值：`12-2-2`、`(2)-3-3`、`20-1-3` 都是 attack-ar-ma，不影响"哪一枚"
      .replace(/^(?:\(\d+\)|\d+)?-\d+-\d+\s+/, '')
      .replace(/\s+/g, ' ')
      .trim()
    const parts = cardList
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
    // 整编队（`7x Pz Div (3, 4, …; all units)` / `1 Cav Div (all 9 units)`）
    if (/all\s+(\d+\s+)?units/i.test(annotation) || /^all\s+(\d+\s+)?units$/i.test(cardList)) {
      const numbers = parts.filter((part) => /^\d+$/.test(part))
      const lead = /^(\d+)\s/.exec(body)
      const list = numbers.length > 0 ? numbers : lead === null ? [] : [lead[1]!]
      const suffix = /Pz\b/i.test(typeText)
        ? 'PZ'
        : /Mtr\b/i.test(typeText)
          ? 'MTR'
          : /Cav\b/i.test(typeText)
            ? 'CAV'
            : null
      return { ...empty, formations: suffix === null ? [] : list.map((n) => `${n}${suffix}`) }
    }
    // ③ deadPile 列：括号里是部件名
    if (removal.kind === 'deadPile') {
      const names = parts.length > 0 ? parts : [typeText]
      return { ...empty, keys: names.map((name) => unitNameKey(name)).filter((key) => key !== '') }
    }
    // ① 括号里是番号；② 无括号（整串就是名字）
    const keys =
      parts.length === 0
        ? [unitNameKey(body)]
        : parts.map((designation) => unitNameKey(`${designation} ${typeText}`))
    return {
      ...empty,
      keys: keys.filter((key) => key !== ''),
      perKey: parts.length > 0 ? 1 : count,
    }
  }

  /**
   * 1.6a / §5-A：两个名字键是否指向同一枚算子
   *
   * 与 `matchArrivalRecord` 的第三档同口径：**全等**，或**双向子集**且至少两词相交
   * （覆盖 `IRGD Inf Rgt` ↔ `IRGD Mot Inf Rgt`、`24 Mtr Corps HQ` ↔ `HQ 24th Corps`）。
   * 单词相交通不过（"只有一个番号"说明不了是哪一枚）。
   */
  function sameRemovalKey(wanted: string, candidate: string): boolean {
    if (wanted === candidate) return true
    const a = new Set(wanted.split(' ').filter((token) => token !== ''))
    const b = new Set(candidate.split(' ').filter((token) => token !== ''))
    if (a.size < 2 || b.size < 2) return false
    let shared = 0
    for (const token of a) if (b.has(token)) shared += 1
    if (shared < 2) return false
    let inside = true
    for (const token of a) {
      if (!b.has(token)) {
        inside = false
        break
      }
    }
    if (inside) return true
    for (const token of b) if (!a.has(token)) return false
    return true
  }

  /**
   * B18：按到达卡执行强制移除（1.6a：立即移出**游戏**，不论处境）
   *
   * ★ 1.6a 原文：「When a unit is called on to be 'Removed' by the arrival charts or else a unit with
   *   identical factors, is **immediately removed from play**, regardless of its current situation
   *   (even if in **the dead pile** or surrounded). Some of these units will return again, but most
   *   are gone for good.」
   *   ⇒ 被移除者**离开游戏**（盘面、空军、**死亡堆**都要清），而不是"进死亡堆"。
   *   修前这里把移除的算子 `push` 进 `deadPile` —— 于是「gone for good」的算子仍留在死亡堆里
   *   可被 13.5 重建 / 1.6c 免费重建返场，与条文相反（且死亡堆计数、重建候选集都被污染）。
   *   ★ 也正因为如此，专规 2.3c 的编制转化「The old unit is a Removal (1.6a)」不走死亡堆。
   *   ★ 到达卡另有「To Dead Pile」列（`ArrivalRemoval.kind === 'deadPile'`）：那一列**进死亡堆**，
   *     与上面"移出游戏"方向相反，不能混为一谈。
   */
  function applyArrivalRemovalsNow(): void {
    // 1.6a「When a unit is called on to be "Removed" by the arrival charts … is **immediately**
    // removed from play」⇒ 这是**到达卡**的一部分（B 增援·到货落位）
    if (!requireAction('rein.arrival', '按到达卡移除')) return
    const plan = arrivalPlan.value
    if (plan === null) return
    for (const removal of plan.removals) {
      const targets = removalTargetsOf(removal)
      const side = activeSide.value
      /*
       * 1.6a：不论处境 ⇒ 盘面（含空军）与**死亡堆**都要找一遍。
       * 名字键取自算子显示名（`unitNameKey` 与 13.6 的卡面名同口径）。
       */
      const groundPool: ConsoleUnit[] = [
        ...units.value.filter((unit) => unit.side === side),
        ...deadPile.value.filter(
          (entry): entry is ConsoleUnit => !isAirDeadPileEntry(entry) && entry.side === side,
        ),
      ]
      const airPool: ConsoleAirUnit[] = [
        ...airUnits.value.filter((air) => air.side === side),
        ...deadPile.value.filter(
          (entry): entry is ConsoleAirUnit => isAirDeadPileEntry(entry) && entry.side === side,
        ),
      ]
      const picked = new Map<string, ConsoleUnit | ConsoleAirUnit>()
      if (targets.formations.length > 0) {
        for (const unit of groundPool)
          if (unit.formation !== null && targets.formations.includes(unit.formation))
            picked.set(unit.instanceId, unit)
      } else if (targets.pointKind !== null) {
        const pool = groundPool.filter(
          (unit) =>
            unit.noncombatKind === 'transport_point' &&
            unit.noncombatTransportKind === targets.pointKind,
        )
        for (const unit of pool.slice(0, targets.pointCount)) picked.set(unit.instanceId, unit)
      } else {
        for (const key of targets.keys) {
          const pool: (ConsoleUnit | ConsoleAirUnit)[] = [...groundPool, ...airPool].filter(
            (unit) => sameRemovalKey(key, unitNameKey(unit.name)),
          )
          for (const unit of pool.slice(0, targets.perKey)) picked.set(unit.instanceId, unit)
        }
      }
      if (picked.size === 0) {
        pushLog(
          'warning',
          `${removal.raw}：盘面与死亡堆里都没有可移除的对应算子 ⇒ 请手工处理（1.6a 允许用 factors 相同的单位顶替）`,
          '1.6a',
        )
        continue
      }
      for (const unit of picked.values()) {
        if (removal.kind === 'deadPile') {
          // 1.6a「To Dead Pile」：进死亡堆（13.5 可重建），**不是**移出游戏
          units.value = units.value.filter((item) => item.instanceId !== unit.instanceId)
          airUnits.value = airUnits.value.filter((item) => item.instanceId !== unit.instanceId)
          if (selectedId.value === unit.instanceId) selectedId.value = null
          if (!deadPile.value.some((entry) => entry.instanceId === unit.instanceId)) {
            deadPile.value = [...deadPile.value, unit]
          }
          pushLog('info', `${unit.name} 按到达卡进入死亡堆（1.6a；13.5 可重建）`, '1.6a')
        } else {
          removeFromPlayEverywhere(unit)
          pushLog('info', `${unit.name} 按到达卡移出游戏（1.6a：立即生效，不论处境）`, '1.6a')
        }
      }
    }
    // 记"本到达计划已执行过 1.6a"：未匹配的条目已在上面的警告里转手工，不再反复重跑
    arrivalRemovalsKey.value = arrivalPlanKey.value
    reinforcementError.value = null
  }

  /**
   * 1.6a：把某算子**移出游戏**（盘面 / 空军 / **死亡堆**都清掉）
   *
   * 与 13.5 的「淘汰进死亡堆」（`eliminateEntry`）相反：被 Removal 的算子**不留在死亡堆**，
   * 故它不会出现在重建候选或 1.6c 的免费重建池里。
   */
  function removeFromPlayEverywhere(unit: { instanceId: string }): void {
    units.value = units.value.filter((item) => item.instanceId !== unit.instanceId)
    airUnits.value = airUnits.value.filter((item) => item.instanceId !== unit.instanceId)
    airMissionAirIds.value = airMissionAirIds.value.filter((id) => id !== unit.instanceId)
    deadPile.value = deadPile.value.filter((item) => item.instanceId !== unit.instanceId)
    if (selectedId.value === unit.instanceId) selectedId.value = null
  }

  /** B18：把算子送进死亡堆（13.5a 重建来源） */
  function sendToDeadPileNow(instanceId: string): void {
    const index = units.value.findIndex((unit) => unit.instanceId === instanceId)
    if (index < 0) return
    const [unit] = units.value.splice(index, 1)
    if (unit === undefined) return
    if (selectedId.value === unit.instanceId) selectedId.value = null
    /*
     * 13.5：与 `eliminateEntry` 共用同一判据 —— 手工「移入死亡堆」也不能把
     * 设施/标记、补员、拆分单位塞进池子（否则旧口子会从这里再开一次）。
     */
    admitGroundDeadPile(
      unit,
      '13.5a',
      `${unit.name} 移入死亡堆（13.5a：死亡堆中的单位可重建）`,
      'info',
    )
  }

  /**
   * W7 C12：把死亡堆中的单位**放回图上**（1.6c 免费重建返场 / 编队抽签 B 组互换）
   *
   * 与 13.5 的常规重建（`rebuildUnitNow`：须付补员、且校验 HQ 2 格内）区分开：
   * 本动作只做「从死亡堆取出 → 落到指定格（可顺带改军力）」这一件事；
   * **费用与合法性由调用方先用引擎计划判好**（1.6c 免费重建 −1 军力、S3 B 组互换等）。
   */
  function returnFromDeadPileNow(input: {
    instanceId: string
    /** 落点格（列.行；1.6c 允许落在能直接拖取追溯补给的 HQ 或边缘补给源格） */
    hexText: string
    /** 返场后的军力（1.6c：−1 军力返场） */
    steps?: number
  }): boolean {
    const unit = deadPile.value.find((item) => item.instanceId === input.instanceId)
    if (unit === undefined) {
      pushLog('warning', `死亡堆中没有 ${input.instanceId}（13.5）`, '13.5')
      return false
    }
    // 空军返场（专规 1.6）：与 13.5f 已接的空军重建同口径——落**本方空军基地**、
    // 以激活状态出现；不按地面单位那样落到 HQ／补给源格。
    let airBaseHex: HexRef | null = null
    if (isAirDeadPileEntry(unit)) {
      const airHex = parseHexPath(input.hexText)[0] ?? null
      const base = airHex === null ? null : airBaseAt(airBases.value, airHex)
      if (base === null || base.side !== unit.side) {
        pushLog(
          'warning',
          `${unit.name} 是空军算子：返场须落在**本方空军基地**（专规 1.6：at any airbase, Active）`,
          '专规 1.6',
        )
        return false
      }
      airBaseHex = { ...base.hex }
    }
    const hex = airBaseHex ?? parseHexPath(input.hexText)[0] ?? null
    if (hex === null) {
      pushLog('warning', `返场须给出落点格（13.5a：须与补员同格并在 HQ 2 格内）`, '13.5')
      return false
    }
    deadPile.value = deadPile.value.filter((item) => item.instanceId !== input.instanceId)
    unit.hex = { ...hex }
    if (input.steps !== undefined) unit.steps = input.steps
    if (isAirDeadPileEntry(unit)) {
      // 专规 1.6 / 13.5f：新到之机 ⇒ 激活、本阶段任务计数归零
      unit.airStatus = 'active'
      unit.missionsFlownThisPhase = 0
      airUnits.value = [...airUnits.value, unit]
      pushLog(
        'success',
        `${unit.name} 从死亡堆返场 → ${hex.col}.${hex.row}（空军基地，激活、未飞）` +
          `（1.6c 免费重建 / 编队抽签互换）`,
        '1.6c',
      )
      return true
    }
    unit.airTransportThisPhase = null
    // 专规 3.5：死亡堆返场同样是"进入某格"
    noteUnitEnteredHex(unit, hex)
    unit.movementEnded = true
    units.value = [...units.value, unit]
    pushLog(
      'success',
      `${unit.name} 从死亡堆返场 → ${hex.col}.${hex.row}` +
        `${input.steps === undefined ? '' : `（军力 ${input.steps}）`}（1.6c 免费重建 / 编队抽签互换）`,
      '1.6c',
    )
    return true
  }

  /** B18：永久移除（13.5c：AR 后有黄点者被摧毁即永久移出） */
  function removeForeverNow(instanceId: string): void {
    /*
     * 13.5c「永久移出」有两个入口：
     *   · 到达卡侧（1.6a「is immediately removed from play」）—— 与 `applyArrivalRemovalsNow` 同闸；
     *   · **B 段 13.5 重建环节**的死亡堆右键菜单「永久移除（13.5c）」。
     * ★ 修前只认 `rein.arrival`：而 13.5 的菜单项**一直列着**（`deadPileActionsOf` 无条件 push），
     *   点下去必然被拒「只能在 B 增援·到货落位进行（13.6）」——列出来却永远点不动。
     */
    if (!actionAllowedNow('rein.arrival') && !actionAllowedNow('rein.rebuild')) {
      requireAction('rein.rebuild', '永久移出游戏')
      return
    }
    actionRefusal.value = null
    const index = units.value.findIndex((unit) => unit.instanceId === instanceId)
    const entry =
      index >= 0
        ? units.value.splice(index, 1)[0]
        : deadPile.value.find((item) => item.instanceId === instanceId)
    if (entry === undefined) {
      pushLog('warning', `没有找到要永久移出的算子：${instanceId}（13.5c）`, '13.5c')
      return
    }
    if (isAirDeadPileEntry(entry)) {
      pushLog('warning', `${entry.name}：13.5c 只处理地面算子（飞机走 13.5f / 专规 1.4a）`, '13.5c')
      return
    }
    // ★ 修前只对**盘面**算子写进 removedForever；死亡堆条目被下面这行静默删掉 ⇒ 账本少一枚
    removedForever.value = [...removedForever.value, entry]
    deadPile.value = deadPile.value.filter((unit) => unit.instanceId !== instanceId)
    if (selectedId.value === instanceId) selectedId.value = null
    pushLog('info', `${entry.name} 永久移出游戏（13.5c：AR 后有黄点，不可重建）`, '13.5c')
  }

  /**
   * 13.5：把「待重建算子 + 行键 + 补员格」搬成引擎请求（**唯一出处**）
   *
   * `rebuildUnitNow` 与「合法落点预演」共用这一份：候选判据、HQ/ZOC 事实、补员按格取，
   * 都不许各写一套（否则地图高亮的格与真落位的判据会走散）。
   */
  function rebuildRequestOf(input: {
    unitId: string
    rebuildType: string
    replHexText?: string
    stepsToRestore?: number
    pairSize?: number
    unitsRequested?: number
    airBox?: boolean
  }): {
    request: RebuildRequest
    candidateUnit: DeadPileEntry
    isAir: boolean
    inDeadPile: boolean
    priorHex: HexRef | null
    priorSteps: number
    priorAirStatus: 'active' | 'inactive' | null
  } | null {
    const candidateUnit =
      deadPile.value.find((unit) => unit.instanceId === input.unitId) ??
      units.value.find((unit) => unit.instanceId === input.unitId)
    if (candidateUnit === undefined) return null
    const isAir = isAirDeadPileEntry(candidateUnit)
    const inDeadPile = deadPile.value.some((unit) => unit.instanceId === input.unitId)
    const priorHex =
      'hex' in candidateUnit && candidateUnit.hex !== null ? { ...candidateUnit.hex } : null
    const priorSteps = candidateUnit.steps
    const priorAirStatus = isAir ? candidateUnit.airStatus : null
    const traceCovered = traceCoverageHexes(supplyFacts.value, {
      side: activeSide.value,
      mobility: 'truck',
    })
    const traceSuppliedFriendlyBases = () =>
      airBases.value.filter(
        (base) => base.side === activeSide.value && traceCoverageHas(traceCovered, base.hex),
      )
    const traceSuppliedFriendlyBase = () => traceSuppliedFriendlyBases()[0] ?? null
    const replHex =
      input.replHexText === undefined
        ? isAir && input.airBox === true
          ? priorHex
          : null
        : (parseHexPath(input.replHexText)[0] ?? null)
    const hqHexes = rebuildHqHexes.value
    const request: RebuildRequest = {
      side: activeSide.value,
      candidate: {
        id: candidateUnit.instanceId,
        side: candidateUnit.side,
        rebuildType: input.rebuildType,
        rebuildable: isAir ? true : candidateUnit.rebuildable !== false,
        isAircraft: isAir,
        ...(isAir ? { aircraftType: candidateUnit.aircraftType } : {}),
        inDeadPile,
        hex: candidateUnit.hex,
        steps: candidateUnit.steps,
        printedSteps: isAir ? airPrintedStepsOf(candidateUnit) : candidateUnit.printedSteps,
        isBreakdown: isAir ? false : candidateUnit.specialized.includes('breakdown'),
        isTruckTransportPoint: isAir ? false : candidateUnit.noncombatKind === 'transport_point',
        ...(!isAir && candidateUnit.destroyedByEnemy === true ? { destroyedByEnemy: true } : {}),
      },
      ...(replHex === null ? {} : { replHex }),
      ...(input.stepsToRestore === undefined ? {} : { stepsToRestore: input.stepsToRestore }),
      ...(input.pairSize === undefined ? {} : { pairSize: input.pairSize }),
      ...(input.unitsRequested === undefined ? {} : { unitsRequested: input.unitsRequested }),
      holdings: isAir
        ? { pax: 0, eq: 0, ftr: replFtrTac.value.ftr, tac: replFtrTac.value.tac }
        : {
            ...replCountsAtHex(replHex ?? candidateUnit.hex ?? { col: 0, row: 0 }),
            ftr: 0,
            tac: 0,
          },
      facts: {
        withinHqThrowOfFriendlyHq: (hex) =>
          hqHexes.some((hq) => hexDistance(hq, hex) <= rulesConstants.repl.rebuildHqRangeHexes),
        inUnnegatedEnemyZoc: (hex) =>
          inEnemyZocForAction(moveContext.value, hex, activeSide.value, 'rebuild'),
        hasFriendlyAirBase: () =>
          input.airBox === true ? priorHex !== null : traceSuppliedFriendlyBase() !== null,
        friendlyAirBaseHex: () => {
          // 子项 2：地图外空军盒**本身就是基地**（1.4a：盒内容量无限、免费整备），不另造格
          if (input.airBox === true) return priorHex
          const base = traceSuppliedFriendlyBase()
          return base === null ? null : { ...base.hex }
        },
        // v7.1 §4.1：玩家点哪个基地就落哪个（不再由引擎取第一个）；盒落点不参与基地清单
        friendlyAirBaseHexes: () =>
          input.airBox === true
            ? []
            : traceSuppliedFriendlyBases().map((base) => ({ ...base.hex })),
      },
    }
    return { request, candidateUnit, isAir, inDeadPile, priorHex, priorSteps, priorAirStatus }
  }

  /**
   * B18：重建一个单位（13.5 / 专规 1.6）
   *
   * `rebuildType` 是重建表行键（如 `Infantry Div step`）——本作工程库未落「算子 → 行」映射，
   * 由裁判按重建表选定（引擎只用行键取费用，不猜）。
   */
  function rebuildUnitNow(input: {
    unitId: string
    rebuildType: string
    replHexText?: string
    stepsToRestore?: number
    pairSize?: number
    unitsRequested?: number
    /** v7.1 §4.1：飞机重建的两个子项之「放入地图外空军基地」 */
    airBox?: boolean
  }): boolean {
    if (!requireAction('rein.rebuild', '重建')) return false
    // 1.6c 的返场手牌已占用这枚死亡堆单位 ⇒ 13.5 不得再消费一次（同一枚只归一处）
    if (specialReplPending.value.some((item) => item.instanceId === input.unitId)) {
      pushLog(
        'warning',
        `${input.unitId} 已在 1.6c 返场手牌里：先点它落位，或在本段确认放弃（13.5 不重复重建）`,
        '1.6c',
      )
      return false
    }
    const built = rebuildRequestOf(input)
    if (built === null) {
      pushLog('warning', `找不到待重建单位 ${input.unitId}（13.5b）`, '13.5b')
      return false
    }
    const { isAir, inDeadPile, priorHex, priorSteps, priorAirStatus } = built
    const data = acceptReinforcement(planRebuild(built.request), '重建')
    if (data === null) return false
    /*
     * 落盘：** Pax / Eq 从盘面摘掉被消耗的补员算子**（§5-D：每点一枚，13.5a"将所需的补员移除"），
     * Ftr / Tac 仍走账本（专规 1.6：只补 1 step 且不可保存，不做盘面算子）。
     * 飞机重建只吃 Ftr / Tac 账本（13.5f + 专规 1.6：Eq 不重建飞机）。
     */
    const replHexForCost =
      input.replHexText === undefined ? null : (parseHexPath(input.replHexText)[0] ?? null)
    if (!isAir && replHexForCost !== null) {
      removeReplCounters(replHexForCost, 'pax', data.cost.pax ?? 0)
      removeReplCounters(replHexForCost, 'eq', data.cost.eq ?? 0)
    }
    if (isAir) {
      replFtrTac.value = {
        ftr: Math.max(0, replFtrTac.value.ftr - (data.cost.ftr ?? 0)),
        tac: Math.max(0, replFtrTac.value.tac - (data.cost.tac ?? 0)),
      }
    }
    lastRebuild.value = data
    const placement = data.placements[0]
    if (placement !== undefined) {
      const onMap = units.value.find((unit) => unit.instanceId === input.unitId)
      if (onMap === undefined) {
        const revived = deadPile.value.find((unit) => unit.instanceId === input.unitId)
        deadPile.value = deadPile.value.filter((unit) => unit.instanceId !== input.unitId)
        if (revived !== undefined && isAirDeadPileEntry(revived)) {
          // 13.5f：以**激活**状态从死亡堆抵达（新到之机 ⇒ 本阶段任务计数归零）
          revived.hex = { ...placement.hex }
          revived.steps = placement.stepsAfter
          revived.airStatus = 'active'
          revived.missionsFlownThisPhase = 0
          airUnits.value = [...airUnits.value, revived]
          if (input.airBox === true) {
            // v7.1 §4.1 子项 2：直接移入**本方地图外空军盒**（盒内容量无限、免费整备，1.4a）
            setAirInBoxMembership(input.unitId, true)
          }
        } else if (revived !== undefined) {
          revived.hex = { ...placement.hex }
          revived.airTransportThisPhase = null
          revived.steps = placement.stepsAfter
          revived.movementEnded = true
          units.value = [...units.value, revived]
        }
      } else {
        onMap.steps = placement.stepsAfter
      }
    }
    // v7.1 §4.5：记下本段刚重建出的这一枚（再点它即撤回并退点；离开本段即失效）
    rebuildPlacedThisSegment.value = [
      ...rebuildPlacedThisSegment.value,
      {
        instanceId: input.unitId,
        mode: isAir
          ? input.airBox === true
            ? 'airBox'
            : 'airBase'
          : inDeadPile
            ? 'deadPile'
            : 'onMap',
        priorSteps,
        priorHex,
        priorAirStatus,
        replHex: isAir ? null : replHexForCost,
        cost: {
          pax: data.cost.pax ?? 0,
          eq: data.cost.eq ?? 0,
          ftr: data.cost.ftr ?? 0,
          tac: data.cost.tac ?? 0,
        },
      },
    ]
    pushLog('success', data.detail, data.rule)
    // ⑭ 接线：重建（13.5 / 专规 1.6）入会话日志（本笔不掷骰；费用与落点已由引擎判定）
    recordSettlement({
      action: 'rebuild',
      rule: data.rule,
      data: {
        unitId: input.unitId,
        rebuildType: input.rebuildType,
        detail: data.detail,
        placements: data.placements.map((placement) => ({
          hex: { ...placement.hex },
          stepsAfter: placement.stepsAfter,
        })),
      },
    })
    return true
  }

  /**
   * 第三段：**撤回**本段刚重建出的算子，并把补员点数退回
   *
   * v7.1 §1.1 / §4.5：只在本段内有效（`rebuildPlacedThisSegment` 随段清空）；
   * 地面：把算子的军力改回重建前，并在原补员格补回被扣的 Pax / Eq 算子；
   * 空军：把飞机放回死亡堆（盒内的先从盒里摘掉），并退回 Ftr / Tac 账本。
   */
  function withdrawRebuildNow(instanceId: string): boolean {
    if (refuseWithdrawWhenSealed()) return false
    if (segmentStep.value?.id !== 'reinforcement.rebuild') return false
    const entry = rebuildPlacedThisSegment.value.find((item) => item.instanceId === instanceId)
    if (entry === undefined) return false
    const isAirMode = entry.mode === 'airBase' || entry.mode === 'airBox'
    if (entry.mode === 'onMap') {
      const unit = units.value.find((item) => item.instanceId === instanceId)
      if (unit === undefined) return false
      unit.steps = entry.priorSteps
    } else if (isAirMode) {
      const air = airUnits.value.find((item) => item.instanceId === instanceId)
      if (air === undefined) return false
      airUnits.value = airUnits.value.filter((item) => item.instanceId !== instanceId)
      air.steps = entry.priorSteps
      if (entry.priorHex !== null) air.hex = { ...entry.priorHex }
      if (entry.priorAirStatus !== null) air.airStatus = entry.priorAirStatus
      if (entry.mode === 'airBox') setAirInBoxMembership(instanceId, false)
      deadPile.value = [...deadPile.value, air]
    } else {
      const unit = units.value.find((item) => item.instanceId === instanceId)
      if (unit === undefined) return false
      units.value = units.value.filter((item) => item.instanceId !== instanceId)
      unit.steps = entry.priorSteps
      if (entry.priorHex !== null) unit.hex = { ...entry.priorHex }
      deadPile.value = [...deadPile.value, unit]
    }
    // 退回被扣的补员：Pax / Eq 摆在原补员格；Ftr / Tac 回账本
    if (entry.replHex !== null) {
      if (entry.cost.pax > 0) placeReplCounters(entry.replHex, 'pax', entry.cost.pax)
      if (entry.cost.eq > 0) placeReplCounters(entry.replHex, 'eq', entry.cost.eq)
    }
    replFtrTac.value = {
      ftr: replFtrTac.value.ftr + entry.cost.ftr,
      tac: replFtrTac.value.tac + entry.cost.tac,
    }
    rebuildPlacedThisSegment.value = rebuildPlacedThisSegment.value.filter(
      (item) => item.instanceId !== instanceId,
    )
    if (selectedId.value === instanceId) selectedId.value = null
    pushLog(
      'info',
      `撤回重建：${instanceId} 回到重建前状态，` +
        `${entry.cost.pax} Pax / ${entry.cost.eq} Eq / ${entry.cost.ftr} Ftr / ${entry.cost.tac} Tac 已退回（13.5a）`,
      '13.5',
    )
    return true
  }

  /**
   * 第三段：点地图上本段刚重建出的算子 ⇒ 撤回（§1.1「再点已放置单位即收回」）
   *
   * @returns 是否消费了这次点击（false ⇒ 交回常规地图点击）
   */
  function withdrawRebuildAtHexNow(hex: HexRef): boolean {
    const hit = rebuildPlacedThisSegment.value.filter((entry) => {
      if (entry.mode === 'airBox') return false
      const unit =
        units.value.find((item) => item.instanceId === entry.instanceId) ??
        airUnits.value.find((item) => item.instanceId === entry.instanceId)
      return unit !== undefined && sameHex(unit.hex, hex)
    })
    if (hit.length !== 1) return false
    return withdrawRebuildNow(hit[0]!.instanceId)
  }

  /**
   * 专规 3.3d：**轴心国多单位编队不得整编**（13.9-1 / 13.9-4）
   *
   * 原文（`Smolensk_Rules_v1.1.txt:396-398`）：「**Axis multi-unit formations** cannot make use of
   * Consolidation (OCS 13.9).」——限定语是**多单位编队**，不是"一切轴方单位"。
   *
   * 判据：动作方或被合并算子属轴方，**且**至少一枚带编队番号（`formation` 非空）才拒。
   * 飞机不属多单位编队 ⇒ 传空数组，永不过闸。
   * 本作数据中带 `formation` 的轴方地面单位全为多军力编队（13.9-1 本来就用不上），
   * 因此收窄后的实际影响是：不再误拒 29 个无编队的独立 Inf Div。
   */
  function axisConsolidationRefused(
    sides: readonly Side[],
    formations: readonly (string | null | undefined)[],
    action: string,
  ): boolean {
    const banned = axisConsolidationBanned(sides, formations)
    if (!banned) return false
    pushLog(
      'warning',
      `专规 3.3d：**轴心国多单位编队不得整编**（${action}只对无编队单位/苏方开放）—— 本动作被拒，未改动任何账本`,
      '专规 3.3d',
    )
    return true
  }

  /** 专规 3.3d 的纯判据（写日志的那版在 `axisConsolidationRefused`；菜单预演不能落日志） */
  function axisConsolidationBanned(
    sides: readonly Side[],
    formations: readonly (string | null | undefined)[],
  ): boolean {
    if (!sides.includes('axis')) return false
    return !formations.every((formation) => formation == null || formation === '')
  }

  /** B18：合并两个多军力单位（13.9-1） */
  function consolidateUnitsNow(keepId: string, removeId: string): boolean {
    if (!requireAction('rein.rebuild', '合并整编')) return false
    const keep = units.value.find((unit) => unit.instanceId === keepId)
    const remove = units.value.find((unit) => unit.instanceId === removeId)
    if (keep === undefined || remove === undefined) return false
    if (
      axisConsolidationRefused(
        [activeSide.value, keep.side, remove.side],
        [keep.formation, remove.formation],
        '合并多军力单位',
      )
    )
      return false
    const data = acceptReinforcement(
      planConsolidation({
        kind: 'multiStepUnits',
        /*
         * 13.9-1/2/3 的时机＝**本方增援阶段**（引擎判据 `consolidation.ts` 的
         * `if (!input.phaseIsReinforcement) fail('13.9', …)`）。
         *
         * ★ 修（2026-10-30）：这里原先**写死 `true`** ⇒ 引擎那道闸永远进不去，
         *   玩家可在移动/战斗/进击段的「拆分与合并」块里把两枚半步单位并成满血
         *   （免费补步，还能免费用合并代替搬运）。改为如实上报当前阶段；
         *   13.9-4 的**飞机合并**另走 `consolidateAircraftNow`，它不传这个字段（允许任何阶段）。
         */
        phaseIsReinforcement: phase.value === 'reinforcement',
        keep: toConsolidationGroundView(keep),
        remove: toConsolidationGroundView(remove),
      }),
      '合并',
    )
    if (data === null) return false
    keep.steps = data.keepStepsAfter
    units.value = units.value.filter((unit) => unit.instanceId !== removeId)
    lastConsolidation.value = data
    pushLog('success', data.detail, data.rule)
    // ⑭ 接线：合并多军力单位（13.9-1）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'consolidate',
      rule: data.rule,
      data: {
        kind: 'multiStepUnits',
        keepId,
        removeId,
        keepStepsAfter: data.keepStepsAfter,
        detail: data.detail,
      },
    })
    return true
  }

  /**
   * 13.9-1：同格**全部**可合并的伙伴（右键合并的判据；也供整编会话列候选）
   *
   * 只做引擎预演（`planConsolidation`，与落账同一处判据），不落账。
   * 整编只可能发生在同一堆叠内 ⇒ 候选严格限定同格，不跨格展开成全局清单。
   */
  function mergePartnerIds(keepId: string): string[] {
    if (!actionAllowedNow('rein.rebuild')) return []
    const keep = units.value.find((unit) => unit.instanceId === keepId)
    if (keep === undefined || keep.side !== activeSide.value) return []
    if ((keep.noncombatKind ?? null) !== null) return []
    const candidates = units.value.filter(
      (unit) =>
        unit.instanceId !== keepId &&
        unit.side === keep.side &&
        sameHex(unit.hex, keep.hex) &&
        (unit.noncombatKind ?? null) === null,
    )
    return candidates
      .filter(
        (unit) =>
          !axisConsolidationBanned([unit.side], [keep.formation, unit.formation]) &&
          planConsolidation({
            kind: 'multiStepUnits',
            phaseIsReinforcement: phase.value === 'reinforcement',
            keep: toConsolidationGroundView(keep),
            remove: toConsolidationGroundView(unit),
          }).ok === true,
      )
      .map((unit) => unit.instanceId)
  }

  /**
   * 13.9：当前是否有可整编的同堆叠对象（会话窗只在有对象时出现）
   *
   * 判据复用 `mergePartnerIds`（同格、预演通过、轴方多单位编队已在其中排除）。
   */
  const consolidationAvailable = computed<boolean>(() =>
    units.value.some(
      (unit) =>
        unit.side === activeSide.value &&
        (unit.noncombatKind ?? null) === null &&
        mergePartnerIds(unit.instanceId).length > 0,
    ),
  )

  /**
   * 13.9-1：同格**唯一**可合并的另一枚（右键「合并单位」的判据）
   *
   * 候选多于一枚或预演不通过 ⇒ `null`（不替玩家挑并哪一枚，菜单改走整编会话）。
   */
  function mergePartnerAt(keepId: string): string | null {
    const ids = mergePartnerIds(keepId)
    return ids.length === 1 ? ids[0]! : null
  }

  /** 13.9-4：飞机合并的落点键（盒内驻机共用同一个盒，不按原位格比） */
  function airConsolidationLocationKey(air: ConsoleAirUnit): string {
    return airBoxMembers.value.includes(air.instanceId) ? `box:${air.side}` : hexLabel(air.hex)
  }

  /**
   * 13.9：盘面**多选**里能合并的一对（地面 / 飞机各一套判据）
   *
   * 用户裁定（v7.1 §4.3）：整编的唯一入口是「盘面左键多选 ≥2 枚 → 右键 → 整编」；
   * 条件不满足 ⇒ 菜单项**不出现**。本函数只回答"这组选择里有没有合法的一对"。
   */
  function consolidationPairInSelection(
    ids: readonly string[],
  ): { kind: 'ground' | 'air'; keepId: string; removeId: string } | null {
    if (ids.length < 2) return null
    // 飞机：13.9-4 任何阶段都可（两架都须军力减损、同型同值同状态、同格或同一图外盒）
    const airs = ids.flatMap((id) => {
      const air = airUnits.value.find((item) => item.instanceId === id)
      return air === undefined ? [] : [air]
    })
    for (let i = 0; i < airs.length; i += 1) {
      for (let j = i + 1; j < airs.length; j += 1) {
        const keep = airs[i]!
        const remove = airs[j]!
        const view = (air: ConsoleAirUnit, other: ConsoleAirUnit) => ({
          id: air.instanceId,
          sameTypeAndValues:
            air.aircraftType === other.aircraftType &&
            airBarrageStrengthOf(air) === airBarrageStrengthOf(other),
          sameStatus: air.airStatus === other.airStatus,
          reduced: air.steps < airPrintedStepsOf(air),
          locationKey: airConsolidationLocationKey(air),
          steps: air.steps,
          printedSteps: airPrintedStepsOf(air),
        })
        if (
          planConsolidation({
            kind: 'aircraft',
            keep: view(keep, remove),
            remove: view(remove, keep),
          }).ok
        ) {
          return { kind: 'air', keepId: keep.instanceId, removeId: remove.instanceId }
        }
      }
    }
    // 地面：13.9-1 只在增援阶段
    if (!actionAllowedNow('rein.rebuild')) return null
    const ground = ids.flatMap((id) => {
      const unit = units.value.find((item) => item.instanceId === id)
      return unit === undefined || (unit.noncombatKind ?? null) !== null ? [] : [unit]
    })
    for (let i = 0; i < ground.length; i += 1) {
      for (let j = i + 1; j < ground.length; j += 1) {
        const keep = ground[i]!
        const remove = ground[j]!
        if (axisConsolidationBanned([keep.side], [keep.formation, remove.formation])) continue
        if (
          planConsolidation({
            kind: 'multiStepUnits',
            phaseIsReinforcement: phase.value === 'reinforcement',
            keep: toConsolidationGroundView(keep),
            remove: toConsolidationGroundView(remove),
          }).ok
        ) {
          return { kind: 'ground', keepId: keep.instanceId, removeId: remove.instanceId }
        }
      }
    }
    return null
  }

  /** 13.9：这组多选此刻是否可以出「整编」菜单项 */
  function canConsolidateSelectionNow(ids: readonly string[]): boolean {
    return consolidationPairInSelection(ids) !== null
  }

  /** 13.9：盘面多选 → 右键「整编」→ 自动合并（不弹大窗、不再让玩家挑保留枚） */
  function consolidateSelectionNow(ids: readonly string[]): boolean {
    let merged = false
    // 多选可能不止一对：逐对合并，直到没有合法的一对（上限防死循环）
    for (let guard = 0; guard < 16; guard += 1) {
      const pair = consolidationPairInSelection(ids)
      if (pair === null) break
      const ok =
        pair.kind === 'air'
          ? consolidateAircraftNow(pair.keepId, pair.removeId)
          : consolidateUnitsNow(pair.keepId, pair.removeId)
      if (!ok) break
      merged = true
    }
    return merged
  }

  /**
   * 13.9-1：**整编会话的作用域**（用户 2026-11-09）
   *
   * 右键在某一堆叠上选择「合并单位（打开整编会话）」时记下该格与保留枚；
   * 会话的两个阵列据此只列**这一个堆叠**的单位，不作为全局可合并清单展开。
   */
  const consolidationPick = ref<{ hex: HexRef; keepId: string } | null>(null)

  function openConsolidationPickNow(keepId: string): boolean {
    const keep = units.value.find((unit) => unit.instanceId === keepId)
    if (keep === undefined || mergePartnerIds(keepId).length < 2) return false
    consolidationPick.value = { hex: { col: keep.hex.col, row: keep.hex.row }, keepId }
    return true
  }

  function clearConsolidationPick(): void {
    consolidationPick.value = null
  }

  /** 整编会话「保留哪一枚」的候选：有作用域时只列该堆叠，否则沿用图上本方单位 */
  const consolidationKeepUnits = computed<ConsoleUnit[]>(() => {
    const pick = consolidationPick.value
    if (pick === null) return ownUnitsOnMap.value
    return ownUnitsOnMap.value.filter((unit) => sameHex(unit.hex, pick.hex))
  })

  /** 整编会话「移除哪一枚」的候选：只列该保留枚同格、预演通过的伙伴 */
  function mergeRemoveUnits(keepId: string): ConsoleUnit[] {
    const ids = mergePartnerIds(keepId)
    return ids.flatMap((id) => {
      const unit = units.value.find((item) => item.instanceId === id)
      return unit === undefined ? [] : [unit]
    })
  }

  /** 12.5：这一枚此刻要不要加油（右键「加油」入口的判据，与 `fuelCandidates` 同源） */
  function needsFuelNow(instanceId: string): boolean {
    const unit = units.value.find((item) => item.instanceId === instanceId)
    // 7.0a：反应段由非阶段玩家行动 ⇒ 阵营判据取 `actingSide`
    return (
      unit !== undefined && unit.side === actingSide.value && needsFuelOf(unit) && !unit.fuelled
    )
  }

  /** B18：合并两架同类减损飞机（13.9-4：可在任何阶段进行） */
  function consolidateAircraftNow(keepId: string, removeId: string): boolean {
    // 专规 3.3d：只禁**轴心国多单位编队**；飞机不属编队（13.9-4 不受此限）
    const keep = airUnits.value.find((air) => air.instanceId === keepId)
    const remove = airUnits.value.find((air) => air.instanceId === removeId)
    if (keep === undefined || remove === undefined) return false
    if (axisConsolidationRefused([activeSide.value, keep.side, remove.side], [], '合并减损飞机'))
      return false
    const view = (air: ConsoleAirUnit, other: ConsoleAirUnit) => ({
      id: air.instanceId,
      // 13.9-4：同型判据看**当前面**的轰炸值（两枚减损机 ⇒ 都取减损面值）
      sameTypeAndValues:
        air.aircraftType === other.aircraftType &&
        airBarrageStrengthOf(air) === airBarrageStrengthOf(other),
      sameStatus: air.airStatus === other.airStatus,
      // 14.1b（第五批批 C 切片 1）：减损判据按**印值军力**（修前硬编码 2 ⇒ 单军力机 IL.2
      // 的 steps=1 被误判为"已减损"、两枚未损 IL.2 竟能合并出 2 点军力）
      reduced: air.steps < airPrintedStepsOf(air),
      locationKey: airConsolidationLocationKey(air),
      steps: air.steps,
      printedSteps: airPrintedStepsOf(air),
    })
    const data = acceptReinforcement(
      planConsolidation({
        kind: 'aircraft',
        keep: view(keep, remove),
        remove: view(remove, keep),
      }),
      '飞机合并',
    )
    if (data === null) return false
    keep.steps = data.keepStepsAfter
    airUnits.value = airUnits.value.filter((air) => air.instanceId !== removeId)
    lastConsolidation.value = data
    pushLog('success', data.detail, data.rule)
    // ⑭ 接线：合并同类减损飞机（13.9-4）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'consolidate',
      rule: data.rule,
      data: {
        kind: 'aircraft',
        keepId,
        removeId,
        keepStepsAfter: data.keepStepsAfter,
        detail: data.detail,
      },
    })
    return true
  }

  /** B18：设置某国籍的拆分单位算子池存量（20.0g） */
  function setBreakdownPoolNow(nationality: string, count: number): void {
    breakdownPool.value = { ...breakdownPool.value, [nationality]: Math.max(0, Math.trunc(count)) }
  }

  /** B18：创建拆分单位（20.0a：开始移动 / 战后推进 / 战后撤退） */
  /** 条 22（批 T）：20.0a 三个时机的中文名（日志与界面如实报"是哪一件事"） */
  const BREAKDOWN_TIMING_LABEL: Record<BreakdownCreateTiming, string> = {
    startMove: '开始移动',
    advanceAfterCombat: '战后推进',
    retreatAfterCombat: '战后撤退',
    setupWiggle: '初设拆团（专规 4.3）',
  }

  function createBreakdownNow(parentId: string, breakdownRecordId: string): boolean {
    // 20.0a：创建拆分单位只在「开始移动」「战后推进」「战后撤退」这三个**时机**
    if (!requireAction('move.breakdown', '创建拆分单位')) return false
    /*
     * 条 22（批 T）：时机改由**事件来源**判定（`breakdownWindows`），不再按"当前在哪个阶段"猜。
     * 修前：C 段一律 'startMove'（未开拔也能建）、非 C 段一律 'advanceAfterCombat'（战后**撤退**
     *   被错记成推进）。现在母单位必须真的处在那个事件里，否则拒绝并给规则号。
     */
    const timing = breakdownTimingOf(parentId)
    if (timing === null) {
      pushLog(
        'warning',
        '20.0a：只有在**开始移动 / 战后推进 / 战后撤退**这三个时机才能创建拆分单位（该单位当前不处在其中任何一个）',
        '20.0a',
      )
      return false
    }
    const parent = units.value.find((unit) => unit.instanceId === parentId)
    if (parent === undefined) return false
    const nationality = nationalityOfUnit(parent)
    /*
     * 20.0b：只能创建 **AR ≤ 自己** 的拆分单位。修前拆分子视图从母单位伪造且 `ar = parent.raw.ar`，
     * 高 AR 拆分子永远放行；现按**所选拆分记录**的印值判。20.0c 的标记/储备/模式仍取母单位当前值。
     */
    const record = choices.value.find((item) => item.id === breakdownRecordId)
    if (record === undefined) {
      pushLog('warning', `拆分子清单里没有 ${breakdownRecordId}（20.0g：同国籍池）`, '20.0g')
      return false
    }
    const parentView = toBreakdownSideView(parent, nationality)
    const recordAr = record.factors?.combat?.ar
    if (typeof recordAr !== 'number') {
      pushLog('warning', `拆分子 ${breakdownRecordId} 缺印值 AR，无法按 20.0b 判定`, '20.0b')
      return false
    }
    const recordSteps = record.steps?.total ?? 1
    const data = acceptReinforcement(
      planBreakdownCreate({
        parent: parentView,
        breakdown: {
          ...parentView,
          id: `breakdown:${breakdownRecordId}`,
          classKind: record.classes?.combatClass ?? parentView.classKind,
          ar: recordAr,
          steps: recordSteps,
          printedSteps: recordSteps,
        },
        timing,
        poolCount: breakdownPool.value[nationality] ?? 0,
        locked: parent.locked,
        count: 1,
      }),
      '创建拆分单位',
    )
    if (data === null) return false
    parent.steps = data.parentStepsAfter
    units.value = [
      ...units.value,
      toConsoleUnit({
        record,
        instanceId: createId('brk'),
        hex: { ...parent.hex },
        side: parent.side,
      }),
    ]
    breakdownPool.value = {
      ...breakdownPool.value,
      [nationality]: Math.max(0, (breakdownPool.value[nationality] ?? 0) - 1),
    }
    lastBreakdown.value = data
    // 条 22（批 T）：如实报"是哪一件事"开的窗（修前战后撤退会被记成战后推进）
    pushLog('success', `${data.detail}（20.0a 时机：${BREAKDOWN_TIMING_LABEL[timing]}）`, data.rule)
    // ⑭ 接线：创建拆分单位（20.0a）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'breakdown',
      rule: data.rule,
      data: {
        kind: 'create',
        parentId,
        breakdownRecordId,
        nationality,
        // 条 22（批 T）：20.0a 的时机如实入账（开始移动 / 战后推进 / 战后撤退）
        timing,
        parentStepsAfter: data.parentStepsAfter,
        detail: data.detail,
      },
    })
    return true
  }

  /**
   * B18：吸收拆分单位（20.0d：任何阶段结束时；母单位减损即强制）
   *
   * ★ 两个参数都是**实例 id**（图上算子），不是单位库的记录 id：
   *   母单位用 `units` 里的实例 id；拆分单位必须从**图上已有的拆分单位**里选。
   *   原先界面把「拆分子」下拉绑在单位库记录 id 上（那是 `createBreakdownNow` 需要的口径），
   *   于是这里永远查不到、静默返回 false，玩家点了没有任何反应。
   */
  function absorbBreakdownNow(parentId: string, breakdownId: string): boolean {
    /*
     * 20.0d：「**只有在这种时机才能吸收拆分单位**」——阶段末（本模型＝H 清理段）。
     * 用户 2026-11-14 裁定 2：移动阶段不放早入口，入口与落盘一起按同一判据拒绝。
     */
    if (phase.value !== 'cleanUp') {
      reinforcementError.value = { rule: '20.0d', reason: `absorbOnlyAtSegmentEnd:${phase.value}` }
      pushLog(
        'warning',
        `吸收被拒：20.0d 只在**阶段末（H 清理）**发生，当前是 ${phase.value}`,
        '20.0d',
      )
      return false
    }
    const parent = units.value.find((unit) => unit.instanceId === parentId)
    if (parent === undefined) {
      reinforcementError.value = { rule: '20.0d', reason: `parentNotOnMap:${parentId}` }
      pushLog('warning', `吸收被拒：母单位 ${parentId} 不在图上（20.0d）`, '20.0d')
      return false
    }
    const breakdown = units.value.find((unit) => unit.instanceId === breakdownId)
    if (breakdown === undefined) {
      reinforcementError.value = { rule: '20.0d', reason: `breakdownNotOnMap:${breakdownId}` }
      pushLog(
        'warning',
        `吸收被拒：拆分单位 ${breakdownId} 不在图上（20.0d 须选**图上**的拆分单位实例）`,
        '20.0d',
      )
      return false
    }
    const nationality = nationalityOfUnit(parent)
    const data = acceptReinforcement(
      planBreakdownAbsorb({
        parent: toBreakdownSideView(parent, nationality),
        breakdown: toBreakdownSideView(breakdown, nationality),
        timing: 'segmentEnd',
        stacked: sameHex(parent.hex, breakdown.hex),
        parentReduced: parent.steps < parent.printedSteps,
      }),
      '吸收拆分单位',
    )
    if (data === null) return false
    parent.steps = data.parentStepsAfter
    units.value = units.value.filter((unit) => unit.instanceId !== breakdownId)
    breakdownPool.value = {
      ...breakdownPool.value,
      [nationality]: (breakdownPool.value[nationality] ?? 0) + 1,
    }
    lastBreakdown.value = data
    pushLog('success', data.detail, data.rule)
    // ⑭ 接线：吸收拆分单位（20.0d）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'breakdown',
      rule: data.rule,
      data: {
        kind: 'absorb',
        parentId,
        breakdownId,
        nationality,
        parentStepsAfter: data.parentStepsAfter,
        detail: data.detail,
      },
    })
    return true
  }

  /** B18：设置 / 解除 Slow Mobilization 的锁定（专规 2.4） */
  function setUnitLockedNow(instanceId: string, locked: boolean): void {
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return
    if (unit.slowMobilizationArmy !== null) {
      // 2.4：已按到达卡记录的师只能走配额解锁，不能靠手工翻面越过配额
      if (!locked) {
        unlockSlowMobilizationNow(instanceId)
        return
      }
      pushLog(
        'info',
        `${unit.name} 已按到达卡记录为慢动员锁定师；解锁请用“按表解锁”（专规 2.4）`,
        '专规 2.4',
      )
      return
    }
    unit.locked = locked
    pushLog(
      'info',
      `${unit.name} → ${locked ? '锁定（不能移动、不能拆 breakdown）' : '解锁'}（专规 2.4）`,
      '专规 2.4',
    )
  }

  /**
   * 2.4：慢动员是**苏联专规**（只对到达卡标注 `30/28/24 Army HQ (see 2.4)` 的苏军集团军生效）
   *
   * 用户 2026-11-07 ②：**轴方增援阶段不该出现慢动员 UI**，更不该把德军算子列进「锁定哪一枚」。
   * 故面板可见性只看「苏方 + 增援阶段」；候选列表另有"侧 + 编制（30/28/24 归属）"双重过滤。
   */
  const slowMobilizationVisible = computed<boolean>(
    () => activeSide.value === 'soviet' && phase.value === 'reinforcement',
  )

  /**
   * 2.4：某集团军仍被锁、且按"与指挥部同一到达卡分组进场"纳入本专规的师
   *
   * 归属只认到达计划落到算子上的 `slowMobilizationArmy`（数据不按番号前缀猜）：
   * 同一到达卡分组里出现「Nth Army HQ (see 2.4)」时，该组师才进入 30/28/24 的专规集合。
   * ★ 双重过滤：**只认苏方**（2.4 是苏联专规）**且**有 30/28/24 归属 —— 修前只按集团军字段，
   *   轴方增援阶段只要有一枚算子带错归属就会被列进来（用户 2026-11-07 ② 的现象）。
   */
  function slowMobilizationLockedOf(army: SlowMobilizationArmy): ConsoleUnit[] {
    return units.value.filter(
      (unit) => unit.side === 'soviet' && unit.slowMobilizationArmy === army && unit.locked,
    )
  }

  /**
   * 2.4：该集团军**本回合**已解锁的师数
   *
   * 现行口径（v7.1，2026-11-11）：慢动员按**累计解锁**——已解锁的师由算子自身 `locked`
   * 旗标承载、跨回合保留，不另记累计账本。本函数只回答"今天已经用掉多少额度"
   * （从会话日志数**本回合**的成功解锁条目，防同回合重复取配额；未开局无日志 ⇒ 0）。
   *
   * ★ 2026-11-05 旧裁定①⑨「不要管配额、按回合能动就行、不维护累计账本」**已作废**；
   *   作废原因与依据见 `engine/rules/arrival.ts → slowMobilizationQuotaRemaining`。
   */
  function slowMobilizationUnlockedThisTurn(army: SlowMobilizationArmy): number {
    const armyOf = new Map<string, SlowMobilizationArmy | null>()
    for (const item of [...units.value, ...deadPile.value]) {
      if ('slowMobilizationArmy' in item) armyOf.set(item.instanceId, item.slowMobilizationArmy)
    }
    let count = 0
    for (const entry of session.log) {
      if (entry.action !== 'slowMobilizationUnlock') continue
      if (!entry.outcome.ok) continue
      if (entry.turn !== turn.value) continue
      const data = entry.outcome.data as unknown as { selectedIds?: unknown }
      if (!Array.isArray(data.selectedIds)) continue
      for (const id of data.selectedIds) {
        if (typeof id === 'string' && armyOf.get(id) === army) count += 1
      }
    }
    return count
  }

  /**
   * 2.4：本回合剩余可挑选数
   *
   * 算式在引擎 `slowMobilizationQuotaRemaining`（表 2-2 **当日**配额 − 本回合已解锁）；
   * 累计态由算子的 `locked` 旗标承载，跨回合保留。
   * 面板用它置灰与算"今日应解锁数"，提交时引擎仍会复核并给出规则号 2.4。
   */
  function slowMobilizationQuotaOf(army: SlowMobilizationArmy): number {
    return slowMobilizationQuotaRemaining({
      date: date.value,
      army,
      alreadyUnlockedThisTurn: slowMobilizationUnlockedThisTurn(army),
    })
  }

  /**
   * 2.4：今日**应解锁数** = min(当日剩余配额, 仍锁定师数)
   *
   * 「配额大于剩余则全部解锁」的界面口径：提交按钮只在选中数等于本值时可点。
   */
  function slowMobilizationRequiredOf(army: SlowMobilizationArmy): number {
    return Math.min(slowMobilizationQuotaOf(army), slowMobilizationLockedOf(army).length)
  }

  /**
   * 2.4：本段是否还有"按表 2-2 该解锁而没解锁"的师
   *
   * 用于第一段的收束：仍有剩余 ⇒ 必须先提交慢动员（2.3 例外见 `endSlowMobilizationSegmentNow`）。
   */
  function slowMobilizationOutstanding(): boolean {
    if (activeSide.value !== 'soviet') return false
    return (['30th', '28th', '24th'] as const).some((army) => slowMobilizationRequiredOf(army) > 0)
  }

  /**
   * B18：按表 2-2 解锁**玩家在本回合勾选**的若干师（专规 2.4）
   *
   * 现行口径（v7.1，2026-11-11）：累计解锁（`locked` 旗标承载），当日应解锁
   * `min(当日剩余配额, 仍锁定师数)`；整批提交要求选中数正好用满（`enforceFill`），
   * 「配额大于剩余则全部解锁」。表 2-2 数字照原文。
   *
   * 修前这里取**全局**锁定算子、按数组前缀解锁（可跨集团军、玩家无法指定），
   * 且同日重复点击会重复拿到配额。现在：
   * - 归属只认到达卡分组落到算子上的 `slowMobilizationArmy`；
   * - 本回合已解锁数从会话日志取（不新增存档字段）；
   * - 只解锁玩家选中的那几枚，一次提交。
   *
   * ★ 2026-11-05 旧裁定①⑨「不要管配额、按回合能动就行、不维护累计账本」已作废
   *   （作废原因与依据见 `engine/rules/arrival.ts → slowMobilizationQuotaRemaining`）。
   */
  function unlockSlowMobilizationBatch(
    selectedIds: readonly string[],
    options?: { enforceFill?: boolean },
  ): boolean {
    const ids = [...new Set(selectedIds)]
    if (ids.length === 0) return false
    const picked = ids.map((id) => units.value.find((item) => item.instanceId === id))
    if (picked.some((unit) => unit === undefined)) return false
    const list = picked as ConsoleUnit[]
    if (list.some((unit) => unit.side !== 'soviet')) {
      pushLog('warning', '2.4 是苏联专规：非苏方单位不属于慢动员集合，不能按表解锁', '专规 2.4')
      return false
    }
    const army = list[0]!.slowMobilizationArmy
    if (army === null) {
      pushLog(
        'warning',
        `${list[0]!.name} 没有到达卡集团军归属，2.4 不能按表解锁（不在 30/28/24 集团军到达卡分组内）`,
        '专规 2.4',
      )
      return false
    }
    if (list.some((unit) => unit.slowMobilizationArmy !== army)) {
      pushLog('warning', '2.4：一次提交只能解锁同一集团军的师（跨集团军被拒）', '专规 2.4')
      return false
    }
    /*
     * 累计解锁：已解锁的师由 locked 旗标承载；alreadyUnlockedThisTurn 只防同回合重复取配额。
     * 整批提交默认用满（enforceFill）——配额大于剩余时，required 就是剩余数（全部解锁）。
     */
    const alreadyUnlockedThisTurn = slowMobilizationUnlockedThisTurn(army)
    const lockedDivisions = slowMobilizationLockedOf(army).length
    const data = acceptReinforcement(
      planSlowMobilization({
        date: date.value,
        army,
        lockedDivisions,
        alreadyUnlockedThisTurn,
        enforceFill: options?.enforceFill ?? true,
        selected: list.map((unit) => ({
          instanceId: unit.instanceId,
          locked: unit.locked,
          isDivision: true,
          army,
        })),
      }),
      '慢动员解锁',
    )
    if (data === null) return false
    for (const unit of list) unit.locked = false
    pushLog('success', data.detail, data.rule)
    // "何时解锁"用**已存档的会话日志**回答（不新增存档字段）：turn＋当时的日期
    recordSettlement({
      action: 'slowMobilizationUnlock',
      rule: '2.4',
      data: { army, date: date.value, selectedIds: ids },
    })
    return true
  }

  /** 2.4：单枚解锁（裁判修正入口；不要求用满当日配额，其余校验与整批一致） */
  function unlockSlowMobilizationNow(instanceId: string): boolean {
    return unlockSlowMobilizationBatch([instanceId], { enforceFill: false })
  }

  /**
   * 2.4：某师"何时解锁"（turn＋日期）
   *
   * 依据＝会话日志里 `slowMobilizationUnlock` 条目的 `turn` 与 `data.date`；
   * 未开局演练（没有会话）时无履历 ⇒ null。**不新增存档字段**。
   */
  const slowMobilizationUnlockedAt = computed<
    (instanceId: string) => { turn: number; date: string } | null
  >(() => {
    const map = new Map<string, { turn: number; date: string }>()
    for (const entry of session.log) {
      if (entry.action !== 'slowMobilizationUnlock') continue
      if (!entry.outcome.ok) continue
      const data = entry.outcome.data as unknown as { date?: unknown; selectedIds?: unknown }
      if (!Array.isArray(data.selectedIds)) continue
      for (const id of data.selectedIds) {
        if (typeof id === 'string')
          map.set(id, { turn: entry.turn, date: typeof data.date === 'string' ? data.date : '' })
      }
    }
    return (instanceId: string) => map.get(instanceId) ?? null
  })

  /* ────────── 专规 2.3c：方面军预备队（＋1.6c 特殊补员的可用期） ────────── */

  /**
   * 专规 2.3c：本回合到期的方面军预备队批次（无 ⇒ null）
   *
   * 归位口径是引擎的 `frontalReservesBatch`（**轨上第一个 ≥ 卡面日期的回合**）——
   * 三批的卡面日期（22 Jul / 1 Aug / 1 Sep）在修正后的轨上都是真实回合（t5 / t8 / t17）。
   */
  const frontalReservesToday = computed<FrontalReservesBatch | null>(() =>
    frontalReservesBatch(date.value),
  )

  /** 2.3c：已领取的批次（键＝批次的**卡面日期**；「必须当即领取、不能保存」⇒ 每批一次） */
  const frontalReservesClaimed = ref<string[]>([])

  /** 2.3c 的错误（统一形状） */
  const frontalReservesError = ref<{ rule: string; reason: string } | null>(null)

  /** 2.3c 最近一次领取的结论（供面板回执） */
  const lastFrontalReserves = ref<{
    /** 已在盘面上执行的编制转化（旧单位已移出游戏 / 新单位已摆放） */
    applied: string[]
    /** **无法在盘面上执行**的义务（产物单位库缺该算子 ⇒ 交裁判手工处理） */
    obligations: string[]
    /** 两次免费重建的候选（从死亡堆里挑） */
    freeRebuildCandidates: { label: string; candidates: string[] }[]
    detail: string
  } | null>(null)

  /**
   * 2.3c：把卡面的编制转化单位在**产物单位库**里对上号
   *
   * 卡面写法是「印值 + 类型 + (番号)」，如 `12-1-4 Mtr Div (69)` / `8-1-5 Tk Rgt (114)`；
   * 产物里叫 `Ru 69 Mot Div` / `Ru 114 Tk Rgt`（`Mtr`→`Mot`、`Inf Div`→`Rifle Div`）。
   * 找不到即 `null`——**不臆造算子**，由调用方把卡面原文登记成义务。
   */
  function conversionRecordFor(cardText: string): UnitRecordView | null {
    const match = /^(.*)\(([^)]*)\)$/.exec(cardText.trim())
    if (match === null) return null
    const designation = match[2]!.trim()
    const typeText = match[1]!
      .replace(/^\d+-\d+-\d+\s*/, '')
      .replace(/\bMtr\b/g, 'Mot')
      .replace(/\bInf Div\b/g, 'Rifle Div')
      .trim()
    /*
     * 匹配对象是**算子名**：卡面写的是算子上的名字（`Ru 103 Mot Div`），不是主键
     * （`su-motorized-ru-103-mot-div`）。故同时比 `vassalName`（这正是卡面/算子上的名字来源）
     * 与 `recordNameOf`（显示名；产物里只有少数记录带 nameZh/nameEn，其余回落到主键）。
     */
    const wanted = new RegExp(`(^|\\s)${designation}\\s+${typeText}$`, 'i')
    return (
      unitChoices('soviet').find(
        (record) => wanted.test(record.vassalName ?? '') || wanted.test(recordNameOf(record)),
      ) ?? null
    )
  }

  /**
   * 专规 2.3c：**领取**本回合的方面军预备队
   *
   * 条文：「到货**必须立刻使用，不能保存**。每批方面军预备队包含：**2 SP** 与**一次编制转化**
   * （旧单位按 1.6a Removal 处理，新单位随其它到达的 SP/补员一起摆放）＋**两次免费重建**
   * （一架 IL.2 ＋ 一个 HQ 或火炮单位，玩家择一）。」
   *
   * 本动作：判日（引擎 `claimFrontalReserves`）→ 落 2 SP → 能执行的编制转化就执行
   * （旧单位**移出游戏**、新单位按落点摆放）→ 其余登记为义务（含卡面原文）→ 记会话日志。
   * ★ 免费重建的**选择权在玩家**（从死亡堆里挑），故本动作只给出候选，不代选。
   */
  function claimFrontalReservesNow(): boolean {
    if (!requireAction('rein.frontalReserves', '领取方面军预备队')) return false
    // 判日的**唯一权威**是引擎（`claimFrontalReserves` 内含 2.3c 的日程序列）
    const batch = acceptReinforcement(claimFrontalReserves(date.value), '方面军预备队')
    if (batch === null) {
      frontalReservesError.value = { rule: '2.3c', reason: `noFrontalReservesAtDate:${date.value}` }
      pushLog('warning', `${date.value} 不是方面军预备队的到货日（专规 2.3c）`, '2.3c')
      return false
    }
    if (frontalReservesClaimed.value.includes(batch.date)) {
      frontalReservesError.value = {
        rule: '2.3c',
        reason: `frontalReservesAlreadyClaimed:${batch.date}`,
      }
      pushLog('warning', `${batch.date} 这一批方面军预备队**已经领过**（不能重复，2.3c）`, '2.3c')
      return false
    }
    /*
     * 判定阶段**不落子**（用户 2026-11-11 口径：第二段是"先把判定走完，再统一手牌放置"）：
     * 本批次只登记两样产出——2 SP 并入「到货 SP」池、编制转化的新单位进手牌，
     * 落点统一在放置阶段按 2.1 选（「new units are placed with other arriving SP and repls」）。
     */
    supplyArrivalSp.value += batch.sp
    frontalReservesSpPending.value += batch.sp

    // ② 编制转化：旧单位＝1.6a Removal（**移出游戏**，不进死亡堆）；新单位随到达摆放
    const applied: string[] = []
    const obligations: string[] = []
    const oldRecord = conversionRecordFor(batch.convertFrom)
    if (oldRecord === null) {
      obligations.push(
        `${batch.convertFrom} 须按 1.6a **移出游戏**（产物单位库没有这个算子 ⇒ 请手工处理）`,
      )
    } else {
      /*
       * 1.6a：「不论处境（**即使在死亡堆里**）」⇒ 盘面与死亡堆都要找一遍：
       * 同一个算子不可能同时在场与在堆里，但**可能只在堆里**——修前只扫盘面，于是那一种情形完全漏掉。
       */
      const onMap = units.value.filter(
        (unit) => unit.side === 'soviet' && unit.unitId === oldRecord.id,
      )
      const inPile = deadPile.value.filter(
        (entry): entry is ConsoleUnit =>
          !isAirDeadPileEntry(entry) && entry.unitId === oldRecord.id,
      )
      for (const entry of [...onMap, ...inPile]) removeFromPlayEverywhere(entry)
      const removed = onMap.length + inPile.length
      if (removed === 0) {
        /*
         * ★ 旧单位**本就不在场**（也已在死亡堆清过）⇒ 这是**已了结**的事实，不是「交裁判手工处理」。
         *   修前它被塞进 `obligations`（该字段的语义是「产物单位库缺算子 ⇒ 请手工处理」），
         *   于是面板的「须手工处理」清单里混着一条「无须处理」，与字段注释矛盾。
         */
        applied.push(`${batch.convertFrom} 已不在场（盘面与死亡堆都没有）⇒ 无须移除（1.6a）`)
      } else {
        applied.push(
          `${removed}× ${batch.convertFrom} 按 1.6a 移出游戏` +
            `（盘面 ${onMap.length} / 死亡堆 ${inPile.length}）`,
        )
      }
    }
    const newRecord = conversionRecordFor(batch.convertTo)
    if (newRecord === null) {
      obligations.push(
        `${batch.convertTo} 须随到达摆放（产物单位库没有这个算子 ⇒ 请按卡面印值手工摆放）`,
      )
    } else {
      frontalUnitPending.value = {
        recordId: newRecord.id,
        name: recordNameOf(newRecord),
        images: newRecord.images ?? null,
      }
      applied.push(`${recordNameOf(newRecord)} 已进手牌（放置阶段按 2.1 落位）`)
    }

    // ③ 两次免费重建：候选只列死亡堆里的，选择权留给玩家
    const freeRebuildCandidates = batch.freeRebuilds.map((label) => ({
      label,
      candidates: deadPile.value
        .filter((entry) => matchesFreeRebuildLabel(entry, label))
        .map((entry) => entry.name),
    }))

    frontalReservesClaimed.value = [...frontalReservesClaimed.value, batch.date]
    frontalReservesError.value = null
    lastFrontalReserves.value = {
      applied,
      obligations,
      freeRebuildCandidates,
      detail:
        `方面军预备队 ${batch.date} 已领：+${batch.sp} SP 并入到货 SP 手牌；` +
        `编制转化 ${batch.convertFrom} → ${batch.convertTo}（新单位进手牌，放置阶段按 2.1 落位）` +
        (obligations.length === 0 ? '' : `；待手工处理 ${obligations.length} 项`),
    }
    pushLog('success', lastFrontalReserves.value.detail, '2.3c')
    recordSettlement({
      action: 'frontalReserves',
      rule: '2.3c',
      data: {
        batchDate: batch.date,
        sp: batch.sp,
        convertFrom: batch.convertFrom,
        convertTo: batch.convertTo,
        applied: [...applied],
        obligations: [...obligations],
      },
    })
    return true
  }

  /** 2.3c 的免费重建标签（`IL.2` / `HQ or artillery`）该不该收这个死亡堆算子 */
  function matchesFreeRebuildLabel(entry: DeadPileEntry, label: string): boolean {
    const name = entry.name
    if (/^IL\.2$/i.test(label)) return /IL\.2/i.test(name)
    // 「一个 HQ 或火炮单位」⇒ HQ 或带印刷轰炸值的火炮（飞机不在其列）
    if (isAirDeadPileEntry(entry)) return false
    return entry.specialized.includes('hq') || entry.raw.barrage !== undefined
  }

  /* ────────── W6 B19：Smolensk 专规机制（1.2 / 1.7 / 2.1a / 2.2 / 3.3b / 3.4 / 3.5） ────────── */

  /** 当前剧本的初设栏（`scenarios.setup`：3.5 建造标记 / 1.7 补给缓存等剧本级数值的唯一来源） */
  const scenarioSetup = computed(
    () => scenarios.scenarios.find((item) => item.id === scenarioId.value)?.setup,
  )

  /** 3.4：装甲集群分界线（产品数据 `map-config.panzerGroupBoundary` 第一段：19.19 → 62.23） */
  const panzerGroupBoundary = computed<PanzerGroupBoundary | null>(() => {
    const pair = mapConfig.panzerGroupBoundary?.[0]
    if (pair === undefined) return null
    const [west, east] = pair
    if (west === undefined || east === undefined) return null
    return { west: { ...west }, east: { ...east } }
  })

  /**
   * 批 F 切片 1（专规 3.4 原文「分界线为 **19.19 → 62.23** 的**多轨铁路线**」）：
   * **沿线走的 45 格路径**（从 `map-layers` 的多轨铁路格边推出；不连通即 null）
   *
   * 与判据、渲染**共用同一条路径**（`boundaryLine` / `panzerGroupBoundaryWithPath`）——
   * 修前渲染画的是两端格心之间的一条**直线**、判据按**列线性插值**，而铁路线在 ±1 行内摆动 ⇒ 两处都错。
   */
  const panzerBoundaryPath = computed<readonly HexRef[] | null>(() =>
    panzerGroupBoundary.value === null
      ? null
      : panzerGroupBoundaryPath({
          from: panzerGroupBoundary.value.west,
          to: panzerGroupBoundary.value.east,
          facts: createMultiTrackRailFacts(),
        }),
  )

  /** 3.4：**带路径**的分界线（判据与渲染都读这一份；路径缺失时退回直线口径） */
  const panzerGroupBoundaryWithPath = computed<PanzerGroupBoundary | null>(() => {
    const boundary = panzerGroupBoundary.value
    if (boundary === null) return null
    const path = panzerBoundaryPath.value
    return path === null ? boundary : { ...boundary, path }
  })

  /** 3.4a：Orsha 格（取地图城市名数据，不写死坐标） */
  const orshaHex = computed<HexRef | null>(() => {
    const found = mapLayers.hexes.find((hex) => hex.city?.name === 'Orsha')
    return found === undefined ? null : { col: found.col, row: found.row }
  })

  /**
   * 3.4：算子的装甲集群归属
   *
   * ★ 用户口径：「霍特或古德里安的编队不用玩家设置」——归属已由素材库的**编队目录**定死，
   * 由 `scripts/sync-units.mjs` 落到算子数据（`record.panzerGroup`）。
   * 故此处取「玩家显式声明 ?? 数据默认」：裁判仍可覆盖（罕见情形），但默认无需任何操作。
   */
  const panzerGroupAssignments = ref<Record<string, PanzerGroup>>({})

  /** 3.4：算式子 → 装甲集群（玩家声明优先，否则用算子数据里的默认） */
  function groupOfUnit(unit: ConsoleUnit): PanzerGroup | null {
    return panzerGroupAssignments.value[unit.instanceId] ?? unit.panzerGroup ?? null
  }

  /** 3.4：已归属装甲集群的算子数（默认取自素材编队目录 + 手工声明） */
  const panzerGroupAssignedCount = computed(
    () => units.value.filter((unit) => groupOfUnit(unit) !== null).length,
  )

  /**
   * 3.4：裁判声明的「属多单位编队」实例 id（3.4 只约束多单位编队，步兵师与独立单位不受限）
   *
   * 默认口径与编队数据一致：**凡属某装甲集群的算子即属多单位编队**（编队单位目录里的算子），
   * 故同样不必玩家逐个登记；此数组只用于显式补充。
   */
  const multiUnitFormationIds = ref<string[]>([])

  /** 3.4a：分界线判据所需的单位视图 */
  const panzerGroupUnitViews = computed<PanzerGroupUnitView[]>(() =>
    units.value.map((unit) => ({
      id: unit.instanceId,
      group: groupOfUnit(unit),
      inMultiUnitFormation:
        multiUnitFormationIds.value.includes(unit.instanceId) || unit.panzerGroup != null,
      hex: unit.hex,
    })),
  )

  /**
   * 3.4a：相位末的分界线义务
   *
   * 逐编队给出「须投 DG」的结果（① 与另一集群同堆叠/相邻；② 错误一侧且 Orsha 以东）；
   * 19 August 起（`panzerGroupConstraintEnd`）自动失效。
   */
  const panzerGroupObligations = computed<readonly DividingLineObligation[]>(() => {
    // ★ 批 F 切片 1：判据用**带路径**的那一份（分界线是多轨铁路折线，不是直线）
    const boundary = panzerGroupBoundaryWithPath.value
    const orsha = orshaHex.value
    if (boundary === null || orsha === null) return []
    return dividingLineObligations({
      units: panzerGroupUnitViews.value,
      scope: { boundary, orshaHex: orsha },
      date: date.value,
      adjacent: areAdjacent,
      sameHex,
      // 专规 4.1a（可选）：忽略 3.4 ⇒ 分界线义务整条不生效
      ignorePanzerGroupConstraints: session.rule4On('ignorePanzerGroupConstraints'),
    })
  })

  /**
   * 3.4a：**必须由玩家选一枚**的 DG 义务
   *
   * 原文「place a DG on **a unit** from a multi-unit formation **if it is** …」——
   * 命中单枚时没有可选空间（引擎可直接判定，见 `settlePanzerGroupDgAtPhaseEnd`）；
   * 只有命中多枚才要玩家从中选一枚。已 DG 的单位视为该义务已结清，不重复要玩家选。
   */
  const panzerDgChoiceObligations = computed<readonly DividingLineObligation[]>(() =>
    panzerGroupObligations.value.filter((item) => {
      const open = item.unitIds.filter(
        (unitId) => units.value.find((unit) => unit.instanceId === unitId)?.mode.dg !== true,
      )
      return open.length > 1
    }),
  )

  /**
   * B37 / 3.4a：**此刻是不是结算分界线义务的时候**（相位末）
   *
   * 用户 2026-11-09 裁定**读法 A**：原文「at the end of any phase」按字面执行 ——
   * 判据完全走闸门（`exclusive.panzerObligation`），闸门覆盖**所有玩家相位的最后一个环节**
   * （含苏军相位，E 反应段按 `nonActive`），不再收窄成轴方 C/G 段末。
   * 义务本身仍由引擎 `dividingLineObligations` 给结论（本投影只说"现在该看它了"）。
   */
  const panzerObligationActive = computed<boolean>(() =>
    allowedActionsOf(segmentGateQuery.value).has('exclusive.panzerObligation'),
  )

  /**
   * B37 / 3.4a：**错误一侧的格**（提示用）
   *
   * 结论取自引擎的 `panzerGroupObligations`（它已经把"19 August 前才生效"与
   * `boundarySideOf` 的判断都做完了）——本处只把**触发条件是"错误一侧"**的那些单位
   * 归到一起、去重成格。等价于"这些格里有站错一侧的编队单位"。
   */
  const panzerWrongSideHexes = computed<readonly HexRef[]>(() => {
    const seen = new Map<string, HexRef>()
    for (const obligation of panzerGroupObligations.value) {
      if (obligation.reason !== 'wrongSideOfLineEastOfOrsha') continue
      for (const unitId of obligation.unitIds) {
        const unit = units.value.find((item) => item.instanceId === unitId)
        if (unit === undefined) continue
        seen.set(`${unit.hex.col}.${unit.hex.row}`, { ...unit.hex })
      }
    }
    return [...seen.values()]
  })

  /**
   * B37 / 3.4：分界线的**渲染投影**（线 + 提示格）
   *
   * ★ 批 F 切片 1：带上 `path`（多轨铁路折线，45 格）——渲染层画的就是它，与判据**同一条路径**。
   */
  const boundaryView = computed<BoundaryLine | null>(() => {
    const boundary = panzerGroupBoundary.value
    if (boundary === null) return null
    return {
      from: { ...boundary.west },
      to: { ...boundary.east },
      ...(panzerBoundaryPath.value === null ? {} : { path: panzerBoundaryPath.value }),
      wrongSideHexes: panzerWrongSideHexes.value,
    }
  })

  /**
   * B37（方案 §3 步骤 2）：**本环节可做的专规动作**（界面据此置顶/自动开窗）
   *
   * 键的取值范围只列**专规面板自己拥有**的动作族（不与别处共用）——
   * 例如 16.0b 的工事、13.8d 的建造虽然也是"专规机制"，但它们的入口在别处面板里，
   * 列进来会让专规窗在本环节无端弹出。
   * 判据＝闸门表（`allowedActionsOf`），每条都带规则号，界面直接显示。
   */
  const EXCLUSIVE_PANEL_KEYS: readonly ActionKey[] = ['exclusive.panzerObligation']

  const exclusiveActionsInStep = computed<readonly ActionGate[]>(() => {
    const allowed = allowedActionsOf(segmentGateQuery.value)
    return EXCLUSIVE_PANEL_KEYS.filter((key) => allowed.has(key)).map((key) => actionGateOf(key))
  })

  /**
   * B37 余项：**专规面板的分节置顶判据**（哪一节"本环节该做"）
   *
   * 每节的判据都写在这里（一处），面板只读结果：
   *   · `panzer`（3.4）：段末的分界线义务可结算，**或**还有没登记集群归属的新到 SP（3.4b 要求立即归属）；
   *   · `security`（3.3b）：有城要放标记，或（清理段）有标记要移除；
   *   · `hedgehog`（16.0b/c）、`constructionMarker`（专规 3.5）：本环节的闸门放行（后者还须有枚数）；
   *   · `supplyCache`（1.7）：补给段的缓存台账提醒（Forage 入口已在补给阶段面板）；
   *   · `airRestriction`（1.2 苏军空军限制）：**纯只读提示** ⇒ 不置顶。
   */
  const exclusiveSectionPins = computed<Record<ExclusiveSection, boolean>>(() => {
    const allowed = allowedActionsOf(segmentGateQuery.value)
    const needs = securityNeeds.value
    return {
      /*
       * 3.4a / 3.4b：只有**真有选择**时才置顶（＝会话才弹窗）。
       * ★ 段末闸门（`exclusive.panzerObligation`）只说明"此刻是判定时机"，
       *   没有义务时它也放行 ⇒ 不能拿它当开关，否则每个相位末都弹一个空面板。
       */
      panzer:
        panzerDgChoiceObligations.value.length > 0 ||
        (panzerGroupRulesOn.value && pendingSpGroupAssignment.value.length > 0),
      security:
        (needs?.placeAt.length ?? 0) > 0 ||
        (removalAllowedNow(phase.value) && (needs?.removeAt.length ?? 0) > 0),
      hedgehog: allowed.has('move.hedgehog'),
      constructionMarker: allowed.has('move.construction') && constructionMarkers.value > 0,
      // 1.7：补给段提醒看一眼缓存持仓（入口已迁到补给阶段面板，这里只保留台账）
      supplyCache: allowed.has('exclusive.forage'),
      airRestriction: false,
    }
  })

  /**
   * 本环节**该出窗的专规分节**（顺序即会话步骤顺序）
   *
   * 用户 2026-11-09：「一个框不能装多件事」——会话按节逐件推进，每次只出第一节可做的。
   * 判据全部复用 `exclusiveSectionPins`（在上一处），不在这里另写规则；
   * `airRestriction`（1.2 只读）不置顶 ⇒ 不进会话（仍留在右栏只读信息里）。
   */
  const exclusiveSectionsNow = computed<readonly ExclusiveSection[]>(() => {
    const pins = exclusiveSectionPins.value
    const order: readonly ExclusiveSection[] = [
      'panzer',
      'security',
      'hedgehog',
      'constructionMarker',
      'supplyCache',
    ]
    return order.filter((section) => pins[section])
  })

  /**
   * 专规会话**是否该自动出现**
   *
   * 只有"真有选择"的两件事会开窗：3.4a 命中多枚（选哪枚投 DG）、3.4b 新到 SP 未归属（选集群）。
   * 3.3b 治安 / 16.0b 工事 / 3.5 建造标记仍是**本环节可做**的动作（由各自的环节闸门与面板承载），
   * 不在这里抢地图；纯告知（单候选的 DG）由引擎段末自动判定 + 一行日志。
   */
  const exclusiveAutoOpen = computed<boolean>(() => exclusiveSectionPins.value.panzer)

  /** 3.4b：Supply Table 到货点数（界面输入，用于展示均分结果） */
  const supplyTableSpInput = ref(7)

  /** 3.4b：均分结果（平均分给 Guderian 与 Hoth，奇数点归 Guderian） */
  const panzerGroupSpSplit = computed(() => splitSupplyTableSp(supplyTableSpInput.value))

  /** 1.7 / 21.10：补给缓存持有量（初值取剧本初设 `setup.supplyCache`，缺省回落专规 1.7 的规则值） */
  const supplyCacheHoldings = ref<SupplyCacheHoldings>(
    initialSupplyCacheHoldings(scenarioSetup.value?.supplyCache),
  )

  /** 21.10b：Forage 可选 HQ（与 12.6c 同面板两选项；本回合不可用则整项不出现） */
  const forageOptions = computed<
    { hqId: string; hex: HexRef; throwRangeMp: number; coveredUnitIds: string[] }[]
  >(() => {
    if (phase.value !== 'supply') return []
    const side = activeSide.value
    if (supplyCacheHoldings.value[side] <= 0) return []
    const options: { hqId: string; hex: HexRef; throwRangeMp: number; coveredUnitIds: string[] }[] =
      []
    for (const hq of units.value) {
      if (hq.side !== side || !isHqUnit(hq) || hq.destroyedByEnemy) continue
      if (hq.cutSinceTurn !== turn.value) continue
      if ((hq.foragedTurn ?? null) === turn.value) continue
      const throwRangeMp = throwRangeMpOf(hq)
      if (throwRangeMp <= 0) continue
      const mobility = throwMobilityOf(hq)
      const coveredUnitIds = [hq.instanceId]
      for (const unit of units.value) {
        if (unit.instanceId === hq.instanceId) continue
        if (unit.side !== side || !unit.isCombat || unit.destroyedByEnemy) continue
        const reach = countSupplyDistanceToUnitViaTable(supplyFacts.value, {
          from: hq.hex,
          unitHex: unit.hex,
          side,
          mobility,
          maxMp: throwRangeMp,
        })
        if (reach.ok) coveredUnitIds.push(unit.instanceId)
      }
      options.push({ hqId: hq.instanceId, hex: hq.hex, throwRangeMp, coveredUnitIds })
    }
    return options
  })

  /** 21.10b：本阶段内可撤销的 Forage 凭据（跨阶段作废；含受益单位的逐项快照） */
  const lastForageGrant = ref<{
    side: Side
    hqId: string
    turn: number
    unitIds: string[]
    previous: Record<
      string,
      { sustained: number | null; cut: number | null; foraged: number | null }
    >
  } | null>(null)

  /**
   * 21.10b：花 1 枚补给缓存执行 Forage（用户 2026-11-13 定稿）
   *
   * - 覆盖 HQ 自身 + 投递距离内的己方战斗单位，全部写续命标（本回合不算断补）；
   * - **HQ 的 `cutSinceTurn` 保留**：它是「本次连续断补」的锚点，清掉会让下一回合仍断补的
   *   HQ 被重记成"第一回合"而反复 Forage；
   * - 用完一枚即消失；补给阶段内、计划未落盘前可 `undoSupplyCacheUse()` 撤销。
   */
  function useForageNow(hqId: string): boolean {
    if (phase.value !== 'supply') {
      exclusiveError.value = { rule: '21.10', reason: 'forageOnlyInSupplyPhase' }
      return false
    }
    const option = forageOptions.value.find((item) => item.hqId === hqId)
    if (option === undefined) {
      exclusiveError.value = { rule: '21.10', reason: 'forageNotAvailable' }
      return false
    }
    const hq = units.value.find((unit) => unit.instanceId === hqId)
    if (hq === undefined) return false
    // 撤销快照：逐单位记下使用前的续命标、断补锚点与 Forage 标记
    const previous: Record<
      string,
      { sustained: number | null; cut: number | null; foraged: number | null }
    > = {}
    for (const unitId of option.coveredUnitIds) {
      const unit = units.value.find((item) => item.instanceId === unitId)
      if (unit === undefined) continue
      previous[unitId] = {
        sustained: unit.sustainedBySpecialSupplyTurn ?? null,
        cut: unit.cutSinceTurn ?? null,
        foraged: unit.foragedTurn ?? null,
      }
    }
    supplyCacheHoldings.value = {
      ...supplyCacheHoldings.value,
      [activeSide.value]: supplyCacheHoldings.value[activeSide.value] - 1,
    }
    /*
     * HQ 自身：**只写续命标、不动 `cutSinceTurn`**（见函数注释）⇒ 不能走
     * `markSustainedBySpecialSupply`（它会把 `cutSinceTurn === turn` 清成 null）。
     * Forage 标记写到**全部受益单位**上：12.6c 的喂食计划据此排除（F6）。
     */
    for (const unitId of option.coveredUnitIds) {
      const unit = units.value.find((item) => item.instanceId === unitId)
      if (unit !== undefined) unit.foragedTurn = turn.value
    }
    hq.sustainedBySpecialSupplyTurn = turn.value
    markSustainedBySpecialSupply(option.coveredUnitIds.filter((id) => id !== hqId))
    lastForageGrant.value = {
      side: activeSide.value,
      hqId,
      turn: turn.value,
      unitIds: [...option.coveredUnitIds],
      previous,
    }
    // F6：重算补给阶段计划——受益单位已有续命标，12.6c 喂食候选会排除它们
    if (supplyPhasePlan.value !== null) planSupplyPhaseNow()
    pushLog(
      'success',
      `21.10b：${hexLabel(hq.hex)} 的 HQ 使用 Forage（1 枚补给缓存）⇒ 覆盖 ${option.coveredUnitIds.length} 个单位` +
        `（含 HQ 自身；投递距离 ${option.throwRangeMp}；本回合视为已吃图内补给）`,
      '21.10',
    )
    lastSupplyCacheUse.value = 'Forage'
    noteUndoable('cache', '补给缓存：Forage')
    return true
  }

  function undoSupplyCacheUse(): boolean {
    const grant = lastForageGrant.value
    if (grant === null || grant.side !== activeSide.value) return false
    if (phase.value !== 'supply' || turn.value !== grant.turn) return false
    // 「补给阶段内、尚未推进」：供养一旦结算就不可再回退（12.10/21.10 的 spend 已生效）
    if (supplyFeedingSettled.value) return false
    const hq = units.value.find((unit) => unit.instanceId === grant.hqId)
    if (hq === undefined) return false
    supplyCacheHoldings.value = {
      ...supplyCacheHoldings.value,
      [activeSide.value]: supplyCacheHoldings.value[activeSide.value] + 1,
    }
    for (const unitId of grant.unitIds) {
      const unit = units.value.find((item) => item.instanceId === unitId)
      const snapshot = grant.previous[unitId]
      if (unit === undefined || snapshot === undefined) continue
      unit.sustainedBySpecialSupplyTurn = snapshot.sustained
      unit.cutSinceTurn = snapshot.cut
      unit.foragedTurn = snapshot.foraged
    }
    lastForageGrant.value = null
    lastSupplyCacheUse.value = null
    if (supplyPhasePlan.value !== null) planSupplyPhaseNow()
    dropUndoOf('cache')
    pushLog('info', '21.10b：撤销本阶段内的 Forage，补给缓存退回 1 枚', '21.10')
    return true
  }

  /** 1.7：最近一次补给缓存用法结论（Forage 入口已迁到补给阶段面板） */
  const lastSupplyCacheUse = ref<string | null>(null)

  /** 3.5：建造标记剩余枚数（初值取剧本初设 `setup.constructionMarkers`；剧本 1/2 = 3，其余 = 0） */
  const constructionMarkers = ref<number>(scenarioSetup.value?.constructionMarkers ?? 0)

  /** 3.3b：裁判声明的「轴心国控制城市」格键集合（键 = `col.row`；控制状态由裁判维护） */
  const axisControlledCityKeys = ref<string[]>([])

  /** 3.3b：已放置的苏军 Trainbusting 标记（游击队活动） */
  const trainbustingMarks = ref<TrainbustingMarkerView[]>([])

  /** 3.3b：地图上的城市格（产品数据 map-layers 的 `city` 字段） */
  const mapCityHexes = computed<HexRef[]>(() =>
    mapLayers.hexes
      .filter((hex) => hex.city !== undefined)
      .map((hex) => ({ col: hex.col, row: hex.row })),
  )

  /** 3.3b：治安检查的逐城事实（控制＝裁判声明；占据与 ZOC 由盘面推得） */
  const securityCityViews = computed<SecurityCheckCityView[]>(() =>
    mapCityHexes.value.map((hex) => {
      const name = mapLayers.hexes.find((item) => item.col === hex.col && item.row === hex.row)
        ?.city?.name
      return {
        hex,
        ...(name === undefined ? {} : { name }),
        controlledByAxis: axisControlledCityKeys.value.includes(`${hex.col}.${hex.row}`),
        occupiedByAttackCapable: units.value.some(
          (unit) => unit.side === 'axis' && unit.attackCapable && sameHex(unit.hex, hex),
        ),
        coveredByAxisZoc: zocOnlySupplyFacts.value.inEnemyZoc(hex, 'axis'),
        hasTrainbusting: trainbustingMarks.value.some((mark) => sameHex(mark.hex, hex)),
      }
    }),
  )

  /** 3.3b：治安需求结论（需求未满足且无标记 ⇒ 应放置；满足或转苏控 ⇒ 应移除） */
  const securityNeeds = computed<SecurityNeedsResult | null>(() => {
    const outcome = checkSecurityNeeds(securityCityViews.value)
    return outcome.ok ? outcome.data : null
  })

  /** 3.3b 逐城明细的一行（界面用；结论全部来自引擎） */
  interface SecurityCityDetail {
    label: string
    controlledByAxis: boolean
    occupied: boolean
    zoc: boolean
    marked: boolean
    /** 引擎（`checkSecurityNeeds`）给出的动作；`none` ＝ 本回合该城无事可做 */
    action: 'place' | 'remove' | 'none'
    /** 3.3b：该城标记**为何**该移除（`removalReasonOf`；不该移除为 null） */
    removalReason: TrainbustingRemovalReason | null
    /** 3.3b：当前阶段是否允许移除（只在 H 清理段） */
    removalAllowedNow: boolean
  }

  /**
   * 3.3b：**逐城明细**（哪座城需要放标记、哪座该移除、为什么）
   *
   * ★ 动作（place/remove）**不在这里重算**：唯一权威是引擎的 `checkSecurityNeeds`
   *   （本项只把它的 `placeAt`/`removeAt` 映射回逐城行）；「为什么移除」取 `removalReasonOf`，
   *   它的存在就是为了给界面/日志一个与 `checkSecurityNeeds` 同源的**理由**。
   *   修前 `securityCityViews` 导出而界面零引用，玩家只能看到三个计数，看不到是哪座城、
   *   也看不到 H 段才允许移除。
   */
  const securityCityDetails = computed<SecurityCityDetail[]>(() => {
    const needs = securityNeeds.value
    const place = new Set((needs?.placeAt ?? []).map((hex) => hexLabel(hex)))
    const remove = new Set((needs?.removeAt ?? []).map((hex) => hexLabel(hex)))
    const canRemove = removalAllowedNow(phase.value)
    const rows = securityCityViews.value.map((city): SecurityCityDetail => {
      const key = hexLabel(city.hex)
      return {
        label: city.name === undefined ? key : `${key} ${city.name}`,
        controlledByAxis: city.controlledByAxis,
        occupied: city.occupiedByAttackCapable,
        zoc: city.coveredByAxisZoc,
        marked: city.hasTrainbusting,
        action: place.has(key) ? 'place' : remove.has(key) ? 'remove' : 'none',
        removalReason: removalReasonOf(city),
        removalAllowedNow: canRemove,
      }
    })
    // 有事可做的城排前面（同序内保持地图顺序）
    const rank = { place: 0, remove: 1, none: 2 } as const
    return rows.sort((a, b) => rank[a.action] - rank[b.action])
  })

  /** 2.1a：补给源关闭判据的地图事实（模块级常量；南缘＝没有图内南邻） */
  const supplyShutdownFacts = computed<SupplyShutdownFacts>(() => SHUTDOWN_FACTS)

  /** 2.1a：己方补给源当日状态（Entry L 于 19 Jul、Entry E 及以西南缘于 19 Aug 永久关闭） */
  const activeSupplySourceStatuses = computed<readonly SupplySourceStatus[]>(() =>
    supplySourceStatuses({
      side: activeSide.value,
      date: date.value,
      sources: scenarioSupplySourceHexes.value,
      facts: supplyShutdownFacts.value,
    }),
  )

  /** 1.2：当日铁路容量（轴/苏；19 July 提升） */
  const railCapToday = computed(() => railCapacitiesOn(date.value))

  /** 专规时点日历（1.2 / 1.6c / 2.1a / 2.3c / 2.3e / 2.4 / 3.3c / 3.4 / 3.6 / 5.0b） */
  const exclusiveTimings = computed<readonly ExclusiveTimingEntry[]>(() =>
    exclusiveTimingCalendar(),
  )

  /** 当日生效的专规时点（界面提示「今天该做什么」） */
  const todaysTimings = computed<readonly ExclusiveTimingEntry[]>(() => timingsOn(date.value))

  /**
   * 2.2（苏）/ 3.2a（轴）：当前空军任务的**阵营层限制预检**
   *
   * ★ 这里只做**界面预检**（把 `red-air-force.ts` 的统一口径显示给玩家）；
   *   **权威否决**在引擎 `assignAirMission`（`beginAirInteraction`）内，两者共用 `air.ts` 的同一批判据，
   *   故不会出现「两处各判一遍」的口径漂移。
   */
  const redAirForceAdvisory = computed<RuleOutcome<RedAirForceCheckResult> | null>(() => {
    const airPhase = airMissionPhaseOf(phase.value)
    if (airPhase === null) return null
    return checkRedAirForceMission({
      side: activeSide.value,
      phase: airPhase,
      weatherNormal: airInputs.value.weatherNormal,
      missionKind: airMissionKind.value,
      // 2.2b：空投战斗单位属「需计划的任务」（14.10b）；补给空投从不需计划
      requiresPlan: airMissionKind.value === 'air_drop' && airInputs.value.cargoUnitIds.length > 0,
    })
  })

  /** B19 的错误（统一形状：rule + reason） */
  const exclusiveError = ref<{ rule: string; reason: string } | null>(null)

  /** 统一收 B19 引擎结论（失败即记错误与日志并返回 null） */
  function acceptExclusive<T>(outcome: RuleOutcome<T>, action: string): T | null {
    if (outcome.ok) {
      exclusiveError.value = null
      return outcome.data
    }
    exclusiveError.value = { rule: outcome.rule, reason: outcome.reason }
    pushLog('danger', `${action}被拒绝：${outcome.reason}（${outcome.rule}）`, outcome.rule)
    return null
  }

  /** 3.4：声明某算子的装甲集群归属（null ＝ 撤销声明，不受 3.4 约束） */
  function setPanzerGroupNow(instanceId: string, group: PanzerGroup | null): void {
    const next = { ...panzerGroupAssignments.value }
    if (group === null) delete next[instanceId]
    else next[instanceId] = group
    panzerGroupAssignments.value = next
  }

  /** 3.4：声明某算子是否属多单位编队（只有多单位编队受分界线约束） */
  function setMultiUnitFormationNow(instanceId: string, inFormation: boolean): void {
    multiUnitFormationIds.value = inFormation
      ? [...new Set([...multiUnitFormationIds.value, instanceId])]
      : multiUnitFormationIds.value.filter((id) => id !== instanceId)
  }

  /* ────────── 3.4b：装甲集群的 **SP 归属**与付费限制 ────────── */

  /**
   * 3.4b：各补给站的装甲集群归属（键＝补给站 id）
   *
   * 「**所有新到的轴心国 SP 必须立即归属某一装甲集群**」——故这是**补给站**的属性，
   * 与算子的编队归属（`panzerGroupAssignments`，判 3.4a 分界线用）是两码事：
   * 一处讲「这支部队属于谁」，一处讲「这堆弹药属于谁」。
   */
  const spDumpPanzerGroups = ref<Record<string, PanzerGroup>>({})

  /** 3.4b：该补给站归属的集群（未登记 ⇒ null，即"尚未归属"） */
  function panzerGroupOfDump(dumpId: string | null): PanzerGroup | null {
    if (dumpId === null) return null
    return spDumpPanzerGroups.value[dumpId] ?? null
  }

  /**
   * 3.4b：**在局中新到、尚未归属**装甲集群的轴方补给站 id
   *
   * ★ 这一串的用途是把「新到的 SP」与「初设/裁判已久的 SP」区分开：
   *   `checkPanzerGroupSpPayment` 的 `unassigned` 分支是**绝对拦阻**（在"是否多单位编队"之前就判），
   *   若把它套到**每一座**没登记归属的补给站上，步兵师的普通攻击也会被 3.4b 拦掉——
   *   那条约束只管「新到的轴方 SP 必须立即归属」。故只有经 `addSpDump` 新落的轴方补给站才进这一串。
   */
  /**
   * B50（用户 2026-09-17 口径）：**3.4b 在本局是否生效** —— 日期窗口 × 开局共识（4.1a 可选）
   *
   * 未采纳 ⇒ 不登记待办、不列未归属站、不因"未归属"拒付、专规面板也不出现归属界面
   * （规则不生效时给玩家一套用不上的按钮，比没有更糟）。
   * 判据本身只有一处：引擎 `panzerGroupRulesActive`。
   */
  const panzerGroupRulesOn = computed(() =>
    panzerGroupRulesActive({
      constraintApplies: date.value < PANZER_GROUP_CONSTRAINT_END,
      // 专规 4.1a（可选）：「忽略 3.4」时 3.4b 一并失效（整条 3.4 被忽略，其分项不再单独生效）
      agreedByConsensus:
        session.agreedOptionAdoptedOf(PANZER_GROUP_OPTION_ITEM) &&
        !session.rule4On('ignorePanzerGroupConstraints'),
    }),
  )

  const pendingSpGroupAssignment = ref<string[]>([])

  /**
   * 3.4b：**随运输队入场的 SP**（13.6c）的集群选择
   *
   * 编队单位随编队自然已有集群（取算子自身的 `panzerGroup`）；非编队单位带来的 SP
   * 入场前必须在这里选定 Guderian / Hoth——未选则拒绝投放，不落「未归属」的载货账。
   */
  const transportSpGroupDraft = ref<PanzerGroup | null>(null)

  function setTransportSpGroupDraftNow(group: PanzerGroup | null): void {
    transportSpGroupDraft.value = group
  }

  /** 3.4b：当前到达表里是否有「非编队运输点满载 SP」尚未投放（决定是否显示二选一） */
  const arrivalTransportSpNeedsGroup = computed(() => {
    if (!panzerGroupRulesOn.value || activeSide.value !== 'axis') return false
    const plan = arrivalPlan.value
    if (plan === null) return false
    return plan.units.some(
      (demand, index) =>
        demand.loadedWithSp &&
        demand.kind !== 'aircraft' &&
        arrivalPlaced.value[index] !== true &&
        (matchArrivalRecord(demand.name ?? demand.raw)?.formation ?? '') === '',
    )
  })

  /** 3.4b：声明/撤销某补给站的装甲集群归属（null ⇒ 撤销声明） */
  function setDumpPanzerGroupNow(dumpId: string, group: PanzerGroup | null): void {
    const next = { ...spDumpPanzerGroups.value }
    if (group === null) delete next[dumpId]
    else next[dumpId] = group
    spDumpPanzerGroups.value = next
    // 声明过即不再"待归属"（撤销声明会把它放回待归属串）
    pendingSpGroupAssignment.value =
      group === null
        ? [...new Set([...pendingSpGroupAssignment.value, dumpId])]
        : pendingSpGroupAssignment.value.filter((id) => id !== dumpId)
    const dump = spDumps.value.find((item) => item.id === dumpId)
    pushLog(
      'info',
      dump === undefined
        ? `补给站 ${dumpId} 的装甲集群归属 → ${group ?? '（撤销）'}（3.4b）`
        : `${hexLabel(dump.hex)} 的 SP 归属 → ${group === null ? '（撤销声明）' : group === 'guderian' ? 'Guderian（2nd PG）' : 'Hoth（3rd PG）'}（3.4b）`,
      '3.4b',
    )
  }

  /** 3.4b：**尚未归属**装甲集群的轴方补给站（3.4b：新到的轴方 SP 必须立即归属） */
  const panzerGroupUnassignedDumps = computed<SpDump[]>(() =>
    // B50：3.4b 未启用 ⇒ 这张表整体为空（面板据此也隐藏该块）
    !panzerGroupRulesOn.value
      ? []
      : spDumps.value.filter((dump) => dump.side === 'axis' && panzerGroupOfDump(dump.id) === null),
  )

  /**
   * 3.4b：这笔费用能否由该补给站的 SP 支付
   *
   * 「『错误』装甲集群的 SP **不能**用于支付多单位编队的**燃油、战斗或轰炸**成本；除此之外 SP 使用不限。」
   *
   * 唯一判据是引擎的 `checkPanzerGroupSpPayment`；本处只把盘面事实填进去：
   *   · 付费方＝**该补给站登记的**集群（未登记即"尚未归属"）；
   *   · 受益单位逐个核对；独立单位不受限，但不能因此豁免同笔付款中的多单位编队。
   */
  function panzerGroupSpGate(input: {
    /** 付款的补给站（null ＝ 无来源归属可查 ⇒ 不在此处判） */
    dumpId: string | null
    purpose: PanzerGroupSpPurpose
    /** 这笔费用服务的单位（3.4b 的"多单位编队"按**受益方**判） */
    beneficiaryUnitIds: readonly string[]
  }): RuleFailure | null {
    const dump = spDumps.value.find((item) => item.id === input.dumpId) ?? null
    // 3.4 / 3.4b 只约束**轴心国**的 SP 与编队（苏军无装甲集群）
    if (dump === null || dump.side !== 'axis') return null

    const beneficiaries = input.beneficiaryUnitIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
    const outcome = checkPanzerGroupSpBeneficiaries({
      spGroup: panzerGroupOfDump(dump.id),
      purpose: input.purpose,
      date: date.value,
      agreedByConsensus: panzerGroupRulesOn.value,
      unassigned:
        panzerGroupOfDump(dump.id) === null && pendingSpGroupAssignment.value.includes(dump.id),
      beneficiaries: beneficiaries.map((unit) => {
        /*
         * 用户 2026-11-13 口径：多单位编队的编组归属**始终存在**（来自素材编队目录，
         * 见 `groupOfUnit`）。因此这里"是否多单位编队"直接由归属非空判定；不存在
         * "多单位编队但 formationGroup === null" 的合法分支，也不为它留拒绝逻辑。
         */
        const group = groupOfUnit(unit)
        return { group, inMultiUnitFormation: group !== null }
      }),
    })
    return outcome.ok ? null : fail(outcome.rule, outcome.reason)
  }

  /** 3.4b 的拒付消息（把「去哪个界面声明」一并说清，免得只报一个错误码） */
  function panzerGroupSpRefusal(
    failure: RuleFailure,
    purpose: string,
    dumpId: string | null,
  ): string {
    const dump = spDumps.value.find((item) => item.id === dumpId)
    const where = dump === undefined ? '该补给站' : hexLabel(dump.hex)
    const detail =
      failure.reason === 'newSpMustBeAssignedToAPanzerGroup'
        ? `${where} 的 SP **尚未归属**任何装甲集群（3.4b）⇒ 先在专规面板为它声明归属`
        : `${where} 的 SP 归属与受益编队不符（3.4b：错误集群的 SP 不能支付${purpose}成本）`
    return `${detail}`
  }

  /**
   * 3.4a：把分界线义务落到盘面 —— 给义务编队内的单位投 **DG**
   *
   * 原文 3.4a：「At the end of any phase, place a DG on **a unit from a multi-unit formation
   * **if it is** …」——"it" 指**命中条件的那枚单位**（不是"编队内任选一枚"）；义务本身由
   * `dividingLineObligations`（`panzerGroupObligations`）给出；本函数只做**落盘**：
   * 校验该单位确实在义务名单里，投 DG 走既有的 `applyDgToUnit`（5.10 的唯一落盘点），
   * 记 3.4a 日志与结算事实。**不清空义务清单**：义务由盘面位置实时给出，
   * 触发窗口已由 `panzerObligationActive`（`exclusive.panzerObligation`）收在
   * 「任一相位末」——原文 3.4a「at the end of any phase」。
   */
  function applyPanzerGroupDgNow(unitId: string): boolean {
    const obligation = panzerGroupObligations.value.find((item) => item.unitIds.includes(unitId))
    if (obligation === undefined) {
      exclusiveError.value = { rule: '3.4a', reason: `unitNotInPanzerObligation:${unitId}` }
      pushLog(
        'warning',
        '该单位不在 3.4a 的分界线义务名单内（未声明归属 / 非多单位编队 / 已过 19 August）⇒ 不能按 3.4a 投 DG',
        '3.4a',
      )
      return false
    }
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined) {
      exclusiveError.value = { rule: '3.4a', reason: `unitNotFound:${unitId}` }
      pushLog('warning', `找不到算子 ${unitId}（3.4a）`, '3.4a')
      return false
    }
    if (unit.mode.dg === true) {
      pushLog('info', `${unit.name} 已处于 DG（3.4a 重复点击不重复落盘）`, '3.4a')
      return true
    }
    applyDgToUnit(unit)
    pushLog(
      'success',
      `${unit.name} 因 ${obligation.group === 'guderian' ? 'Guderian' : 'Hoth'} 的分界线义务投 DG（3.4a：${obligation.reason}）`,
      '3.4a',
    )
    recordSettlement({
      action: 'panzerObligationDg',
      rule: '3.4a',
      data: { unitId, group: obligation.group, reason: obligation.reason },
    })
    return true
  }

  /**
   * 3.4a：段末**自动**结清「命中单枚」的义务
   *
   * 原文「place a DG on a unit … if it is …」——命中哪枚就投哪枚，没有可选空间；
   * 命中多枚才是玩家选择（`panzerDgChoiceObligations`）。已 DG 的义务视为已结清。
   * 只在 `panzerObligationActive`（本段最后一个玩家环节）执行，不提前到段中；
   * 每枚落一行日志，不另开弹窗。
   */
  function settlePanzerGroupDgAtPhaseEnd(): number {
    if (!panzerObligationActive.value) return 0
    let applied = 0
    for (const obligation of panzerGroupObligations.value) {
      const candidates = obligation.unitIds
        .map((unitId) => units.value.find((unit) => unit.instanceId === unitId))
        .filter((unit) => unit !== undefined && unit.mode.dg !== true)
      if (candidates.length !== 1) continue
      const unit = candidates[0]!
      applyDgToUnit(unit)
      pushLog(
        'warning',
        `3.4a：${unit.name} 命中分界线义务（${obligation.group === 'guderian' ? 'Guderian' : 'Hoth'}）⇒ 自动投 DG`,
        '3.4a',
      )
      recordSettlement({
        action: 'panzerObligationDg',
        rule: '3.4a',
        data: { unitId: unit.instanceId, group: obligation.group, reason: obligation.reason },
      })
      applied += 1
    }
    return applied
  }

  /** 1.7：补给缓存 +1（专规 1.6c 特殊补员的结果之一） */
  function addSupplyCacheNow(side: 'axis' | 'soviet'): void {
    supplyCacheHoldings.value = addSupplyCache(supplyCacheHoldings.value, side)
    pushLog('info', `${side === 'axis' ? '轴心' : '苏军'}补给缓存 +1（专规 1.6c / 1.7）`, '1.7')
    // ⑭ 接线：补给缓存 +1（专规 1.6c / 1.7）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'supplyCache',
      rule: '1.7',
      side,
      data: { gain: 1, holdings: { ...supplyCacheHoldings.value } },
    })
  }

  /** 专规 3.5：简易机场面在空军侧使用的**虚拟基地 id**（不与任何单位实例 id 冲突） */
  function constructionMarkerAirBaseId(pieceId: string): string {
    return `cm-airbase:${pieceId}`
  }

  /** 该 id 是否来自建造标记的简易机场面（3.5：只可被摧毁，不参与 9.14f 夺取） */
  function isConstructionMarkerAirBaseId(id: string): boolean {
    return id.startsWith('cm-airbase:')
  }

  /**
   * 专规 3.5：**已放置**的建造标记（桥 / 简易机场）
   *
   * 修前只有枚数在动、标记本身没有落盘 ⇒ 既看不见、也不可能被苏方战斗单位摧毁。
   * 一条 `piece` = 盘面上的一枚；"不能移动""不可重建"由本数组体现（移除即移除，不回补枚数）。
   */
  const constructionMarkerPieces = ref<{ id: string; kind: 'bridge' | 'airStrip'; hex: HexRef }[]>(
    [],
  )

  /** 专规 3.5：放置格（原先是组件局部 ref；点地图要写回，故搬进 store） */
  const constructionMarkerHexText = ref('')

  /**
   * 专规 3.5：**苏方战斗单位进入**建造标记格 ⇒ 该标记被摧毁（**不可重建**：枚数不退）
   *
   * 「entered the hex」不限定进入方式 ⇒ 所有"把单位放到某格"的写点都调它：
   * 地面移动落盘 `applyMovePatches`、战斗后推进/撤退 `applyCombatPatches`、空投落地、死亡堆返场。
   * 判定本身在引擎（`isConstructionMarkerDestroyed`），此处只做筛选与落账。
   */
  function noteUnitEnteredHex(unit: ConsoleUnit, hex: HexRef): void {
    if (unit.side !== 'soviet' || !unit.isCombat) return
    const doomed = constructionMarkerPieces.value.filter(
      (piece) =>
        sameHex(piece.hex, hex) &&
        isConstructionMarkerDestroyed({ enteredBySovietCombatUnit: true }),
    )
    if (doomed.length === 0) return
    groundMovement.markIrreversible('建造标记摧毁（专规3.5）')
    const doomedIds = new Set(doomed.map((piece) => piece.id))
    constructionMarkerPieces.value = constructionMarkerPieces.value.filter(
      (piece) => !doomedIds.has(piece.id),
    )
    for (const piece of doomed) {
      pushLog(
        'info',
        `${piece.kind === 'bridge' ? '桥' : '简易机场'}（建造标记）在 ${hexLabel(hex)} 被摧毁：苏方战斗单位 ${unit.name} 进入（专规 3.5；不可重建）`,
        '专规 3.5',
      )
    }
  }

  /** 专规 3.5：放置格的待点入口（候选＝**有轴方战斗单位**的格 —— 与引擎的前提同一条） */
  function beginConstructionMarkerHexPickNow(): void {
    beginHexPick({
      label: '放置建造标记的格',
      rule: '专规 3.5',
      candidates: units.value
        .filter((unit) => unit.side === 'axis' && unit.isCombat)
        .map((unit) => unit.hex),
      apply: (hex) => {
        constructionMarkerHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /**
   * 专规 3.5：建造标记的**二选一**（桥 / 简易机场）
   *
   * ★ 批 D 切片 2（**房规①**：值要被 store 动作读、又被界面写 ⇒ 必须是 **store 字段**）——
   *   修前这个选择是 `ExclusiveRulesPanel` 的**组件局部 ref**，而落盘动作 `useConstructionMarkerNow`
   *   在 store 里 ⇒ 界面之外的路径（脚本 / 盒内会话框）拿不到它，等于"两份状态"。
   */
  const constructionMarkerKind = ref<'bridge' | 'airStrip'>('bridge')

  /** 该标记是否**已从盒里拾起**（界面据此高亮；落位成功后清掉） */
  const constructionMarkerPicked = ref(false)

  /**
   * 专规 3.5：**从盒里拾起一枚建造标记并进入落位**（二选一 → 点地图落位）
   *
   * 「盒里拾起（高亮）→ 点地图落位 → 二选一会话框」里的那一次点击：设好 kind、置"已拾起"，
   * 并**当场开好待点格**（候选＝有轴方战斗单位的格，12.3 的同一套 B27 机制）。
   */
  function armConstructionMarkerNow(kind: 'bridge' | 'airStrip'): void {
    constructionMarkerKind.value = kind
    constructionMarkerPicked.value = true
    beginConstructionMarkerHexPickNow()
  }

  /** 3.5：设置建造标记剩余枚数 */
  function setConstructionMarkersNow(count: number): void {
    constructionMarkers.value = Math.max(0, Math.trunc(count))
  }

  /**
   * 3.5：使用一枚建造标记（在**任一轴方移动阶段**、**单位移动之前**，放进有轴方战斗单位的格）
   *
   * 「免费（不耗补给）」；桥按 13.8b 的 HQ 架桥、简易机场按 15.2 的标准简易机场处理。
   * ★ 本动作只做**规则闸门 + 记账**：桥/机场的盘面效果由其所属章节的机制落值。
   */
  function useConstructionMarkerNow(kind: 'bridge' | 'airStrip', hexText: string): boolean {
    if (!requireAction('move.construction', '使用建造标记')) return false
    const hex = parseHexPath(hexText)[0]
    if (hex === undefined) {
      exclusiveError.value = { rule: '专规 3.5', reason: `hexFormatInvalid:${hexText}` }
      pushLog('warning', `建造格格式应为「列.行」，收到「${hexText}」（专规 3.5）`, '专规 3.5')
      return false
    }
    const data = acceptExclusive(
      planConstructionMarkerUse({
        kind,
        side: activeSide.value,
        phase: phase.value,
        // 3.5：空运不是地面MP，但仍属单位位移；在途货物也不能被漏掉。
        beforeMovement:
          units.value.every(
            (unit) => !hasUnitMovementThisPhase(unit.mpSpent, unit.airTransportThisPhase),
          ) && !airUnitCargoManifest.value.some((item) => item.fate === 'aboard'),
        hexHasAxisCombatUnit: units.value.some(
          (unit) => unit.side === 'axis' && unit.isCombat && sameHex(unit.hex, hex),
        ),
        markerAvailable: constructionMarkers.value > 0,
      }),
      '放置建造标记',
    )
    if (data === null) return false
    captureUndoSnapshot(`放置建造标记（${kind === 'bridge' ? '桥' : '简易机场'}）${hexLabel(hex)}`)
    constructionMarkers.value -= 1
    // 专规 3.5：标记**落盘**（原来只减枚数、标记本身没记住 ⇒ 看不见也毁不掉）
    constructionMarkerPieces.value = [
      ...constructionMarkerPieces.value,
      { id: createId('cm'), kind, hex: { ...hex } },
    ]
    // 批 D 切片 2：落位成功 ⇒ 收起"已拾起"的高亮
    constructionMarkerPicked.value = false
    pushLog(
      'success',
      `${data.detail}（置于 ${hexLabel(hex)}；剩余 ${constructionMarkers.value} 枚）`,
      data.rule,
    )
    return true
  }

  /** 3.3b：切换某城的「轴心国控制」声明（键 = `col.row`） */
  function toggleAxisCityControlNow(hexText: string): void {
    const hex = parseHexPath(hexText)[0]
    if (hex === undefined) {
      pushLog('warning', `城市格格式应为「列.行」，收到「${hexText}」（3.3b）`, '3.3b')
      return
    }
    const key = `${hex.col}.${hex.row}`
    axisControlledCityKeys.value = axisControlledCityKeys.value.includes(key)
      ? axisControlledCityKeys.value.filter((item) => item !== key)
      : [...axisControlledCityKeys.value, key]
  }

  /**
   * 3.3b：执行治安检查
   *
   * 口径（用户 2026-11-12 确认）：**轴心占领即轴心控制**；轴控城市既没有被可攻击的轴心单位占据、
   * **也没有**被轴心 ZOC 覆盖时才放游击队标记（两条都缺，不是「或」）。
   * 放置可在任意阶段手动执行，**不**随阶段开始自动触发；移除只在 Clean Up Phase（H 段），
   * 其它阶段即使调用本函数也不会移除。
   */
  function applySecurityNeedsNow(): boolean {
    const data = acceptExclusive(checkSecurityNeeds(securityCityViews.value), '治安需求检查')
    if (data === null) return false

    for (const hex of data.placeAt) {
      trainbustingMarks.value = [
        ...trainbustingMarks.value,
        { id: createId('tb'), hex: { ...hex }, side: 'soviet', cause: 'securityNeeds' },
      ]
    }

    const canRemove = removalAllowedNow(phase.value)
    let removedCount = 0
    if (canRemove && data.removeAt.length > 0) {
      const keys = new Set(data.removeAt.map((hex) => `${hex.col}.${hex.row}`))
      trainbustingMarks.value = trainbustingMarks.value.filter((mark) => {
        if (mark.cause !== 'securityNeeds') return true
        if (!keys.has(`${mark.hex.col}.${mark.hex.row}`)) return true
        removedCount += 1
        return false
      })
    }

    pushLog(
      'success',
      `治安需求（3.3b）：放置 ${data.placeAt.length} 枚 Trainbusting、` +
        (canRemove
          ? `移除 ${removedCount} 枚`
          : `待移除 ${data.removeAt.length} 枚（须等到 H 清理段）`),
      data.rule,
    )
    // ⑭ 接线：治安需求检查（3.3b）入会话日志（本笔不掷骰；移除须待 H 清理段者如实记录）
    recordSettlement({
      action: 'securityNeeds',
      rule: data.rule,
      data: {
        placeAt: data.placeAt.map((hex) => ({ ...hex })),
        removeAt: data.removeAt.map((hex) => ({ ...hex })),
        removedCount,
        removalAllowed: canRemove,
      },
    })
    return true
  }

  /** 3.3b：某城当前是否已有 Trainbusting 标记 */
  function hasTrainbustingAt(hex: HexRef): boolean {
    return trainbustingMarks.value.some((mark) => sameHex(mark.hex, hex))
  }

  /* ────────── 2.2 末段：H 清理阶段的**通用自动清理** ────────── */

  /**
   * 2.2 / 5.9 / 5.10 / 12.5d / 10.0c-C：执行本人的 H 段通用清理
   *
   * 「当前阶段玩家为他的单位移除所有进击和混乱(DG)标记，并移除(或翻面)他所有的燃料标记；
   *   移除由非阶段玩家生成的运输破坏标记。」
   *
   * 全部判据在引擎 `planCleanUp`（含段闸：非 H 段直接拒绝）；本函数只落盘 + 记账。
   */
  function runCleanUpNow(): boolean {
    /*
     * 20.0d：**阶段末的强制吸收**先结清——「减损的多军力单位在任何阶段结束时，都必须吸收与之堆叠、
     * 且符合吸收规则的拆分单位」。放在 H 段收束之前，是因为 H 段本身也要按 4.8a 判堆叠。
     */
    const absorbed = settleAbsorbObligationsNow()
    if (absorbed > 0)
      pushLog(
        'warning',
        `20.0d：阶段末强制吸收 ${absorbed} 对（减损母单位 × 堆叠的拆分单位）`,
        '20.0d',
      )
    const plan = planCleanUp({
      phase: phase.value,
      side: activeSide.value,
      units: units.value.map((unit) => ({
        id: unit.instanceId,
        side: unit.side,
        dg: unit.mode.dg,
        exploit: unit.mode.exploit,
        fuelled: unit.fuelled,
      })),
      trainbustingMarks: trainbustingMarks.value.map((mark) => ({
        id: mark.id,
        hex: mark.hex,
        side: mark.side,
        ...(mark.cause === undefined ? {} : { cause: mark.cause }),
      })),
      securityCities: securityCityViews.value,
    })
    if (!plan.ok) {
      pushLog('warning', `不能执行清理：${plan.reason}（${plan.rule}）`, plan.rule)
      return false
    }
    const data = plan.data
    // 摘标记：只动补丁点到的单位（朝向按 5.9/5.10 保持不变）
    const byId = cleanupPatchById(data)
    for (const unit of units.value) {
      const patch = byId.get(unit.instanceId)
      if (patch === undefined) continue
      if (patch.clearDg) unit.mode.dg = false
      if (patch.clearExploit) unit.mode.exploit = false
      if (patch.clearFuel) {
        // 12.5d：标记摘掉后连同它的记账一并清空，避免残留方法留下误导
        unit.fuelled = false
        unit.fuelMethod = null
      }
    }
    // 10.0c-C / 14.8c：移除**对手**放置的运输破坏标记
    if (data.removeMarkerIds.length > 0) {
      const doomed = new Set(data.removeMarkerIds)
      trainbustingMarks.value = trainbustingMarks.value.filter((mark) => !doomed.has(mark.id))
    }
    /*
     * ★ 12.5d（用户 2026-09-20 裁定）：**燃料窗口的清理就在这一处** —— 与上面 `clearFuel` 同一时点、同一方。
     *   「当前阶段玩家必须在**自己的清理阶段**移除他指挥部的燃料已补给标记，并将他的编队标记翻面至
     *   燃料未补给的一面」⇒ 只有**本方**的清理才作废本方的两个台账；对手的清理阶段一概不动
     *   （反应阶段付的油要活到己方回合的移动阶段，见 `setPhase`/`setTurn` 两处的说明）。
     */
    const cleaningSide = activeSide.value
    const dropSide = <T extends { side: Side }>(ledger: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(ledger).filter(([, entry]) => entry.side !== cleaningSide))
    hqFuelThrows.value = dropSide(hqFuelThrows.value)
    formationFuelThrows.value = dropSide(formationFuelThrows.value)
    pushLog(isCleanUpNoop(data) ? 'info' : 'success', data.detail, data.rule)
    // ⑭ 接线：H 清理段通用清理（2.2 / 5.9 / 5.10 / 12.5d / 10.0c-C）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'cleanUp',
      rule: data.rule,
      data: {
        detail: data.detail,
        patches: data.patches.map((patch) => ({
          unitId: patch.unitId,
          clearDg: patch.clearDg === true,
          clearExploit: patch.clearExploit === true,
          clearFuel: patch.clearFuel === true,
        })),
        removeMarkerIds: [...data.removeMarkerIds],
      },
    })
    /*
     * 5.0a：**末回合的 H 清理段收束**即「最终回合结束」的时点 ⇒ 在此做终局判定
     * （非末回合时 `checkTurnEndVictory` 返回 `ongoing`，随后由 5.0b 的提前决胜兜住）。
     */
    if (atFinalTurn.value) {
      const assessment = assessTurnEndVictoryNow()
      if (assessment.outcome !== 'ongoing')
        pushLog('success', `剧本终局：${assessment.detail}`, assessment.rule)
    }
    return true
  }

  /**
   * 20.0a：该算子是否为**拆分单位**（数据层的 `breakdown` 标签）
   *
   * 唯一判据是 `specialized` 里的标签——不按番号或印值规模推定。
   */
  function isBreakdownRecord(unit: ConsoleUnit): boolean {
    return unit.specialized.includes('breakdown')
  }

  /**
   * 该算子的**国籍**（引擎视图用；取自主键前缀，如 `su-` / `ax-`）
   *
   * 20.0 的拆分/吸收与 S3 的互换都按国籍配对，故这一句只写一处。
   */
  function nationalityOfUnit(unit: ConsoleUnit): string {
    return unit.unitId.split('-')[0] ?? 'unknown'
  }

  /**
   * 20.0d：**阶段末的强制吸收**（在 H 清理段收束之前结清）
   *
   * 「减损的多军力单位在任何阶段结束时，都必须吸收与之堆叠、且符合吸收规则的拆分单位」
   * ⇒ 先按引擎 `breakdownAbsorbObligations` 列出义务，再**逐条强制吸收**
   *   （吸收路径仍是 `absorbBreakdownNow`，与手动的 13.9 吸收同一实现）。
   * 返回吸收成功对数（0 ＝ 无义务）。
   */
  function settleAbsorbObligationsNow(): number {
    const obligations = breakdownAbsorbObligations({
      units: units.value
        .filter((unit) => unit.specialized.includes('breakdown') !== true)
        .map((unit) => toBreakdownSideView(unit, nationalityOfUnit(unit))),
      breakdownsStackedWith: (parentId: string) => {
        const parent = units.value.find((unit) => unit.instanceId === parentId)
        if (parent === undefined) return []
        return units.value
          .filter(
            (unit) =>
              unit.instanceId !== parentId &&
              isBreakdownRecord(unit) &&
              sameHex(unit.hex, parent.hex),
          )
          .map((unit) => toBreakdownSideView(unit, nationalityOfUnit(unit)))
      },
    })
    let settled = 0
    for (const obligation of obligations) {
      pushLog('warning', obligation.detail, obligation.rule)
      for (const breakdownId of obligation.breakdownIds) {
        if (!units.value.some((unit) => unit.instanceId === breakdownId)) continue
        if (absorbBreakdownNow(obligation.parentId, breakdownId)) settled += 1
      }
    }
    return settled
  }

  /* ────────── W6 B20：胜利判定（专规 5.0 / 5.0a / 5.0b / 5.0c） ────────── */

  /**
   * 5.0c：**最后控制者**账本（键 = `col.row`）
   *
   * 5.0c 的「空格由最后一个曾在该格的单位所属方控制」需要历史，操作台只摆当前算子，
   * 故由裁判在每次移动/战斗后点「按盘面刷新」（有可攻击单位者自动归该方），
   * 或直接指定某格归属；引擎侧只接收这一结论（`VictoryControlLookup`）。
   */
  const victoryLastControl = ref<Record<string, Side>>({})

  /** B20 的错误（统一形状：rule + reason） */
  const victoryError = ref<{ rule: string; reason: string } | null>(null)

  /**
   * 联调（**单一权威**）：剧本号一变 ⇒ **随剧本重取的盘面账本**统一重取
   *
   * 为什么是 `watch` 而不是"各入口自己记得刷新"：剧本号的唯一权威是会话
   * （`session.scenarioId`），而写会话的路径有三条以上——`workbench.setScenarioId`、
   * `containers.setScenario`、**`session.loadNow`（读档）**。任何一条漏了刷新，就是
   * "剧本号变了、盘面账本还是旧剧本"的半更新。
   *
   * 实测（修前）：剧本 3 存档 → 新实例读档 ⇒ 四处剧本号都变成 3 ✓，但
   * `constructionMarkers` 仍是剧本 1 的 **3**（剧本 3 应为 0）、`convertedRailHexes`
   * 仍是剧本 1 的 **2 格**（剧本 3 应为 10 格）⇒ 苏军能多建 3 个工事、轴方铁路只放行
   * 剧本 1 的两格（12.6a②/13.3c 的铁路补给判定全错）。
   *
   * `immediate: true` 同时充当**初值**来源（故各账本不再在声明处各写一遍）。
   * 注册点必须在所有被重取的 ref 声明之后 ⇒ 放在本段（最后一个账本 `victoryError` 之后）。
   *
   * ★ `flush: 'sync'`：账本必须与剧本号**同时**更新。默认的 `'pre'` 会把回调排到微任务队列，
   *   于是"剧本号已变成 7、账本还是剧本 1"这个窗口里，任何读账本的 computed（如 `railSupply`
   *   的卸货格）都会算在旧剧本上——而这正是本项要消灭的半更新。刻意用同步 flush 换掉那个窗口。
   */
  function refreshScenarioBoundLedgers(id: string): void {
    const setup = scenarios.scenarios.find((item) => item.id === id)?.setup
    // 13.6：裁判手改的到达落点（剧本换了，落点覆盖作废）
    arrivalHexOverrides.value = {}
    // 1.7 补给缓存 / 3.5 建造标记（专规初设）
    supplyCacheHoldings.value = initialSupplyCacheHoldings(setup?.supplyCache)
    // 1.6b（裁定 2）：图外空军盒 SP 初设；剧本未给数 ⇒ 0
    offMapSupplyStocks.value = {}
    const offMapSetupSp = setup?.offMapAirBoxSp
    if (offMapSetupSp !== undefined) {
      if (offMapSetupSp.axis > 0) addOffMapSupplyT('axis', offMapSetupSp.axis * SP_TO_T)
      if (offMapSetupSp.soviet > 0) addOffMapSupplyT('soviet', offMapSetupSp.soviet * SP_TO_T)
    }
    constructionMarkers.value = setup?.constructionMarkers ?? 0
    /*
     * 专规 4.3 / 1.8a：拆分单位池初值按剧本派生 = 印量 − 本剧本**已在场**的苏军 AR2 拆团。
     *
     * 原文「two AR2 breakdowns are already deployed, which leaves 4x AR2 and 2x AR3
     * available」⇒ 池只算**还能抽**的存量，已在场的那两枚不再计入。
     * 剧本 5/6 原文提到两枚已部署拆团，但工程数据里没有坐标（缺口登记），
     * 按在场 0 枚计（6×AR2 + 2×AR3），不拿 4.3 示例坐标顶。
     */
    const onMapSovietAr2 = setupEntryViews(id, 'soviet')
      .filter((view) => view.unitId === 'su-breakdown-russian-3-2-2-breakdown')
      .reduce(
        (sum, view) =>
          sum + view.count * (view.placement === 'multiHex' ? Math.max(view.anchors.length, 1) : 1),
        0,
      )
    breakdownPool.value = {
      ax: breakdownPoolTotal('axis'),
      su: breakdownPoolTotal('soviet') - onMapSovietAr2,
    }
    // 5.0c 胜利格控制账本：由**后面**那个 immediate watch 按剧本与战线播种（此处不能调：
    // `victoryHexes` 尚未声明 ⇒ 会踩 TDZ）
    victoryError.value = null
    // 9.14e 印刷工事归属（剧本 1 全属苏联，其余按德军推进线）
    printedHedgehogOwners.value = {}
    // 13.3f / 专规 1.2 初设换轨（剧本页 `Converted Axis Rails` 的逐格推导）
    seedConvertedRailsNow()
    // 13.3d 端头标记不播种：由上面的换轨账本 + 铁路连通推导（`railheadMarkers` computed）
    // 9.14 特殊战斗待决（落点按剧本 4 的拖取距离判，换剧本即作废）
    specialPending.value = null
  }

  watch(scenarioId, (next) => refreshScenarioBoundLedgers(next), {
    immediate: true,
    flush: 'sync',
  })

  /** 5.0c：本剧本胜利条件涉及的格（所列格按剧本号取 + 五城格 + 两城格；剧本 2/4 含 27.05、32.25） */
  const victoryHexes = computed<readonly HexRef[]>(() => allVictoryConditionHexes(scenarioId.value))

  /*
   * B17-1（5.0c）：胜利格控制的**播种**必须排在 `victoryHexes` **之后**——它要用这份清单。
   * ★ 教训：原先我把它塞进上面那个 `immediate: true` 的 watch 里，而那时 `victoryHexes`
   *   还在暂时性死区（TDZ）⇒ 建 store 这一步就抛错，全套用例一起红（660 条）。
   *   计算属性的依赖顺序只能靠"声明顺序"保证，故这里单开一个 watch（同样 immediate + sync）。
   */
  watch(scenarioId, () => seedVictoryControlFromScenario(), { immediate: true, flush: 'sync' })

  /**
   * 5.0c：当前控制查询（格内有**可攻击**单位 ⇒ 该方；空格 ⇒ 最后控制者账本；否则无人控制）
   *
   * ★ 判据只有一处：引擎的 `controlOfHex`（本处只把盘面事实与账本拼成 `VictoryHexFacts`）。
   *   修前这里把「`attackCapableSide ?? lastControllingSide`」又写了一遍。
   */
  const victoryControlOf = computed<VictoryControlLookup>(() => (hex) => {
    const occupant = units.value.find((unit) => unit.attackCapable && sameHex(unit.hex, hex))
    return controlOfHex({
      hex,
      attackCapableSide: occupant?.side ?? null,
      lastControllingSide: victoryLastControl.value[`${hex.col}.${hex.row}`] ?? null,
    })
  })

  /** 5.0c：控制汇总（所列格计数 + 五城/两城是否全部格控制） */
  const victorySummary = computed<VictoryControlSummary>(() =>
    summarizeVictoryControl({ scenarioId: scenarioId.value, controlOf: victoryControlOf.value }),
  )

  /** 本剧本的回合区间（末回合号 + 产品数据自检注记） */
  const victoryTurnRange = computed<ScenarioTurnRange>(() => scenarioTurnRange(scenarioId.value))

  /**
   * 5.0b：**回合开始**检查（任一回合开始、19 August 起；剧本 2/4 无此档）
   *
   * 取引擎的 `checkTurnStartVictory`（5.0b 的入口；修前直接调内部的 `evaluateDecisiveVictory`）。
   */
  const decisiveVictory = computed<VictoryAssessment>(() =>
    checkTurnStartVictory({
      scenarioId: scenarioId.value,
      date: date.value,
      controlOf: victoryControlOf.value,
    }),
  )

  /** 5.0a：最终评估（按当前态势，若此刻即为末回合的结果） */
  const finalVictory = computed<VictoryAssessment>(() =>
    evaluateFinalVictory({
      scenarioId: scenarioId.value,
      controlOf: victoryControlOf.value,
      // Intro 的 Minor 判据：与补给网同一份 12.x 追溯事实（不另造规则）
      canTraceSupplyAt: traceSupplyAtForMove.value,
    }),
  )

  /**
   * 5.0a：**回合结束**检查（只在末回合结束时给出终局判定，否则 `ongoing`）
   *
   * 取引擎的 `checkTurnEndVictory`；本项在 H 清理段收束时求值（见 `assessTurnEndVictoryNow`）。
   */
  const turnEndVictory = computed<VictoryAssessment>(() =>
    checkTurnEndVictory({
      scenarioId: scenarioId.value,
      turn: turn.value,
      controlOf: victoryControlOf.value,
      canTraceSupplyAt: traceSupplyAtForMove.value,
    }),
  )

  /**
   * 5.0a / 5.0b 的**流程入口**：回合结束时的判定（在 H 清理段收束时调用）
   *
   * - 末回合 ⇒ `checkTurnEndVictory` 给出终局判定（5.0a）；
   * - 非末回合 ⇒ 该函数返回 `ongoing`，此时再看 5.0b 的提前决胜是否达成（`checkTurnStartVictory`）。
   * 判定结论入会话（`pushVictoryToSessionNow`）与会话日志，供 D2 按规则号检索。
   */
  function assessTurnEndVictoryNow(): VictoryAssessment {
    const end = turnEndVictory.value
    const assessment = end.outcome === 'ongoing' ? decisiveVictory.value : end
    pushVictoryToSessionNow()
    pushLog(
      assessment.outcome === 'ongoing' ? 'info' : 'success',
      `回合结束判定：${assessment.detail}`,
      assessment.rule,
    )
    recordSettlement({
      action: end.outcome === 'ongoing' ? 'decisiveVictory' : 'finalVictory',
      rule: assessment.rule,
      data: {
        level: assessment.level,
        outcome: assessment.outcome,
        winner: assessment.winner,
        listedAxis: assessment.summary.listedBySide.axis,
        listedSoviet: assessment.summary.listedBySide.soviet,
        detail: assessment.detail,
      },
    })
    return assessment
  }

  /** 当前回合计是否为该剧本的最终回合（5.0a 的检查时点） */
  const atFinalTurn = computed<boolean>(() => isScenarioFinalTurn(scenarioId.value, turn.value))

  /**
   * ⑬ 接线：把 **5.0c 的控制事实**与 **5.0a / 5.0b 的判定结论**推给会话
   *
   * 控制事实属于盘面（只有操作台摆着算子），判定由引擎 `victory.ts` 求值；会话层只接收结论。
   * 推过去之后：
   *   - `Records.victoryLocations` 不再是空档 ⇒ 引擎侧的 5.0 判定可直接消费它；
   *   - 5.0b 的提前决胜由判定结论驱动（不再依赖手填开关）；
   *   - 5.0a 的收束条目带上胜方 / Draw 与控制计数。
   *
   * 只登记**当前有主**的胜利格（5.0c 的「最后控制者」账本口径）；无人控制的格不入账，
   * 消费方按「查不到 ⇒ 无人控制」处理（`VictoryLocationState.controlledBy` 不含 null）。
   */
  function pushVictoryToSessionNow(): void {
    const listed = new Set(
      listedVictoryHexes(scenarioId.value).map((hex) => `${hex.col}.${hex.row}`),
    )
    const locations: VictoryLocationState[] = []
    for (const hex of victoryHexes.value) {
      const key = `${hex.col}.${hex.row}`
      const controlledBy = victoryControlOf.value(hex)
      if (controlledBy === null) continue
      locations.push({ hex: { col: hex.col, row: hex.row }, controlledBy, listed: listed.has(key) })
    }
    session.pushVictory({
      locations,
      decisive: decisiveVictory.value,
      final: finalVictory.value,
    })
  }

  /**
   * 5.0c：把盘面上由可攻击单位占据的胜利相关格写入「最后控制者」账本
   *
   * 返回本次真的改了归属的格数（0 = 账本已是当前盘面的样子）。
   * 判据仍是 5.0c 原文：**格内有可攻击单位 ⇒ 该方控制**；空格**不动**（保留最后控制者）。
   */
  function syncVictoryControlFromBoard(): number {
    const next = { ...victoryLastControl.value }
    const flipped: string[] = []
    for (const hex of victoryHexes.value) {
      const occupant = units.value.find((unit) => unit.attackCapable && sameHex(unit.hex, hex))
      if (occupant === undefined) continue
      const key = `${hex.col}.${hex.row}`
      if (next[key] !== occupant.side) {
        next[key] = occupant.side
        flipped.push(
          `${key} → ${occupant.side === 'axis' ? '轴心国' : '苏联'}（${occupant.name} 进入该格）`,
        )
      }
    }
    if (flipped.length === 0) return 0
    victoryLastControl.value = next
    victoryError.value = null
    pushVictoryToSessionNow()
    /*
     * 5.0c：**进入即记账**（用户 2026-09-16 口径）——「单位只要移动进入过该格就视为转换控制方」。
     * 为什么要在**进入的那一刻**记而不是回合末扫一遍：5.0c 的空格判据是「**最后一个**曾在该格的
     * 单位所属方」⇒ 若等到回合末才记，"进过又走了"的格就丢了那次进入（正是最容易出错的一类）。
     */
    pushLog('success', `胜利格控制易手（5.0c）：${flipped.join('；')}`, '5.0c')
    return flipped.length
  }

  /** 5.0c：裁判手动刷新（验证页用；对局台上由下面的**触发**自动做） */
  function refreshVictoryControlNow(): void {
    const changed = syncVictoryControlFromBoard()
    pushLog(
      'info',
      `胜利格控制账本已按盘面刷新（5.0c：格内有可攻击单位者归该方，空格保留最后控制者）｜本次更新 ${changed} 格`,
      '5.0c',
    )
  }

  /**
   * 5.0c **触发**：盘面上任何一枚可攻击单位的**落格变化**都立刻核对胜利格
   *
   * 键里带 `列.行`、`阵营` 与 `是否可攻击` 三项：任一变化（移动/撤退/推进/铁路运货/位移/
   * 初设落子/被消灭后的移除）都会让这个字符串变一次 ⇒ 触发一次核对。
   * 用"整表拼键"而不是逐个动作插入，是为了**不可能漏**：位置改动的地方在 store 里有十几处，
   * 漏一处就会出现"某条路径进格不记控制"这种最难查的错。
   * 非玩家阶段（回放/自动化）同样安全：它只读盘面、只写账本，不掷骰。
   */
  const victoryOccupancyKey = computed<string>(() =>
    units.value
      .map(
        (unit) =>
          `${String(unit.hex.col)}.${String(unit.hex.row)}:${unit.side}:${unit.attackCapable ? 'A' : '-'}`,
      )
      .join('|'),
  )
  watch(
    victoryOccupancyKey,
    () => {
      syncVictoryControlFromBoard()
    },
    // ★ `sync`：控制归属必须在**同一拍**就落账——否则同一 tick 里紧跟其后的判定/结算读到的
    //   还是旧账本（而 5.0c 的"最后控制者"正是靠"进入的那一刻"记账的）。
    //   代价是每次位置变更都要重算一次key（O(单位数)）与扫一遍胜利格（十几格），可忽略。
    { flush: 'sync' },
  )

  /**
   * 5.0c：**初设时胜利点在谁手里**（用户 2026-09-16：「由剧本和战线决定」）
   *
   * 数据来源（不臆造）：
   *   · **战线**：剧本 `setup.printedHedgehogOwners` 的 `axisOwned` 逐格清单——它是剧本页给德军
   *     推进线的逐格落值（与 9.14e 的印刷工事归属**同一条线**，本处复用同一份数据）；
   *   · **其余格**：归苏军（剧本 1/3/5/7 的开局都是苏军守、德军推；数据里的 `rule` 原文即
   *     「其余属苏军」）；
   *   · **已在盘面上的单位**优先：初设落子后若某胜利格上有可攻击单位，就按它那一方（下面的触发会做）。
   */
  function seedVictoryControlFromScenario(): void {
    const seed: Record<string, Side> = {}
    const declared = scenarioSetup.value?.initialVictoryControl?.axisOwned
    const axisOwned =
      declared === undefined
        ? printedHedgehogAxisOwnedAtStart.value
        : new Set(
            declared.map((text) => {
              const hex = parseHexPath(text)[0]
              return hex === undefined ? '' : hexLabel(hex)
            }),
          )
    for (const hex of victoryHexes.value) {
      const key = `${hex.col}.${hex.row}`
      seed[key] = axisOwned.has(hexLabel(hex)) ? 'axis' : 'soviet'
    }
    victoryLastControl.value = seed
    victoryError.value = null
  }

  /** 5.0c：裁判指定 / 清除某格的控制方（空格与历史格用；`side=null` 清除） */
  function setVictoryControlNow(hexText: string, side: Side | null): void {
    const hex = parseHexPath(hexText)[0]
    if (hex === undefined) {
      victoryError.value = { rule: '5.0c', reason: `hexFormatInvalid:${hexText}` }
      pushLog('warning', `胜利格格式应为「列.行」，收到「${hexText}」（5.0c）`, '5.0c')
      return
    }
    const key = `${hex.col}.${hex.row}`
    const next = { ...victoryLastControl.value }
    if (side === null) delete next[key]
    else next[key] = side
    victoryLastControl.value = next
    victoryError.value = null
    pushVictoryToSessionNow()
    pushLog(
      'info',
      `${hexLabel(hex)} 的控制方 → ${side === null ? '（清除，视为无人控制）' : side === 'axis' ? '轴心国' : '苏联'}（5.0c）`,
      '5.0c',
    )
  }

  /**
   * 5.0a / 5.0b：执行一次胜利检查并记日志
   *
   * `at: 'turnStart'` ⇒ 5.0b（任一回合开始、19 Aug 起）；`at: 'turnEnd'` ⇒ 5.0a（仅最终回合）。
   * 两条规则都不写盘面状态，仅给出结论（引擎不写状态）；此处只负责取结论与提示。
   */
  function checkVictoryNow(at: 'turnStart' | 'turnEnd'): boolean {
    const assessment = at === 'turnStart' ? decisiveVictory.value : finalVictory.value
    const label = at === 'turnStart' ? '回合开始检查（5.0b）' : '回合末检查（5.0a）'
    if (at === 'turnEnd' && !atFinalTurn.value) {
      victoryError.value = { rule: '5.0a', reason: `notFinalTurn:${turn.value}` }
      pushLog(
        'warning',
        `${label}：第 ${turn.value} 回合不是剧本 ${scenarioId.value} 的最终回合（末回合 ${victoryTurnRange.value.lastTurn}）⇒ 5.0a 只在最终回合结束时判定`,
        '5.0a',
      )
      return false
    }
    victoryError.value = null
    // ⑬ 接线：判定结论推给会话（5.0b 的提前决胜 / 5.0a 的收束条目都取它）
    pushVictoryToSessionNow()
    const level =
      assessment.outcome === 'axis'
        ? '轴心国达成'
        : assessment.outcome === 'soviet'
          ? '苏联达成'
          : assessment.outcome === 'draw'
            ? '判定为 Draw'
            : '暂无结论'
    pushLog(
      assessment.outcome === 'ongoing' ? 'info' : 'success',
      `${label}：${level}｜${assessment.detail}`,
      assessment.rule,
    )
    // ⑭ 接线：结论入会话日志（含「暂无结论」，可被 D2 按规则号 5.0a / 5.0b 检索）
    recordSettlement({
      action: at === 'turnStart' ? 'decisiveVictory' : 'finalVictory',
      rule: assessment.rule,
      data: {
        level: assessment.level,
        outcome: assessment.outcome,
        winner: assessment.winner,
        listedAxis: assessment.summary.listedBySide.axis,
        listedSoviet: assessment.summary.listedBySide.soviet,
        listedTotal: assessment.summary.listedTotal,
        detail: assessment.detail,
      },
    })
    return assessment.outcome !== 'ongoing'
  }

  /** 该格可选防御地形（9.3b） */
  function terrainChoicesAt(hex: HexRef): string[] {
    return defenseTerrainChoices(hex)
  }
  function rollDice(): void {
    const draw = roll2d6(rng.value)
    rng.value = draw.rng
    drawCount.value += 1
    pushLog('info', `掷 2d6 = ${draw.value.faces.join('+')} = ${draw.value.total}`, '9.8')
    // ⑭ 接线：通用掷骰不是规则结算，但它同样消耗骰子；不记的话 D2 重放会与序列错位
    recordSettlement({
      action: 'manualRoll',
      rule: '9.8',
      rolls: [draw.value],
      data: { faces: draw.value.faces, total: draw.value.total, manual: true },
    })
  }

  /** 重置局（含重设种子）——局况一并回到初始（第 1 回合 / 轴心国先手 / C 移动段） */
  function resetAll(nextSeed = createGameSeed()): void {
    automaticPhaseKeys.value = []
    airMissionDomain.reset(true)
    airUnitTransit.reset()
    fireResolution.resetCombat()
    fireResolution.resetBarrage()
    units.value = []
    moveLinger.value = false
    edgeBoxHoldings.value = { northeast: [], southeast: [] }
    edgeBoxEnteredOn.value = {}
    selectedId.value = null
    pendingRecord.value = null
    tool.value = 'move'
    battleTarget.value = null
    battleTerrain.value = ''
    battleDefenderArId.value = null
    lastStep.value = null
    lastBattle.value = null
    log.value = []
    // C5：本次移动的记账、悬停与待确认一并清空
    moveInteraction.value = null
    hoverHex.value = null
    moveBlocked.value = null
    // C6：本场战斗的交互状态一并清空（含战斗工具模式复位）
    battleMode.value = 'full'
    clearCombat()
    // C7：本次轰炸的交互状态一并清空（含轰炸工具关闭），已摆放的飞机也一并卸下
    barrageActive.value = false
    airUnits.value = []
    airPlacement.value = { aircraftId: null, hexText: '' }
    clearBarrage()
    // 10.0e-A/B：轰炸账本属**阶段级**事实，`clearBarrage` 不动它 ⇒ 复位时显式清
    clearBarragePhaseLedger()
    // C8：补给交互与 SP 账本、来源声明一并回到初始（工具按「必要模块默认开启」保持开启）
    supplyActive.value = true
    spDumps.value = []
    supplySourceDecls.value = []
    spDumpDraft.value = { hexText: '', sp: 1, t: 0 }
    supplySourceDraft.value = { hexText: '', kind: 'supplySourceHex' }
    clearSupply()
    // C9：空军交互、基地声明与阶段标记一并回到初始（工具按「必要模块默认开启」保持开启）
    airActive.value = true
    airMissionKind.value = 'barrage'
    airstripBaseIds.value = []
    refitDoneBaseIds.value = []
    reducedBaseIds.value = []
    refitTargetBaseId.value = null
    clearAir()
    // 16.0b/c / 15.3 / 13.8d：按格、按回合、按阶段的施工额度一并回到初始
    hedgehogTurnLedger.value = {}
    airBaseTurnLedger.value = {}
    constructionLedgers.value = {}
    hedgehogInputs.value = { hexText: '', workerIds: [], payDumpId: null }
    hedgehogExecutorMode.value = 'inPlace'
    hedgehogEngineerId.value = null
    constructionInputs.value = { hexText: '', engineerId: null, payDumpId: null }
    // 13.3 铁路运货：容量账本、阶段账本与输入回到初始
    railCapSpentThisTurn.value = []
    railMovedUnitIdsThisPhase.value = []
    railMovedNewTrackThisPhase.value = []
    // 13.8c 例外：工程 HQ 卸车生成的卸货格属于盘面基建，只在新局/换剧本时清零
    engineerHqDetrainableHexes.value = []
    railMoveInputs.value = { toHexText: '', spAmount: 1, fromDumpId: null }
    railMoveError.value = null
    lastRailMove.value = null
    arrivalRailUndo.value = null
    // W6 B19：专规机制的账本一并回到初设（剧本初设值随 `scenarioId` 重取）
    supplyCacheHoldings.value = initialSupplyCacheHoldings(scenarioSetup.value?.supplyCache)
    constructionMarkers.value = scenarioSetup.value?.constructionMarkers ?? 0
    constructionMarkerPieces.value = []
    constructionMarkerHexText.value = ''
    axisControlledCityKeys.value = []
    trainbustingMarks.value = []
    panzerGroupAssignments.value = {}
    // 3.4b：补给站的装甲集群归属一并清空（新到 SP 的归属不可跨局残留）
    spDumpPanzerGroups.value = {}
    pendingSpGroupAssignment.value = []
    multiUnitFormationIds.value = []
    supplyTableSpInput.value = 7
    lastSupplyCacheUse.value = null
    exclusiveError.value = null
    // W6 B20：胜利格控制账本与错误一并回到初始
    victoryLastControl.value = {}
    victoryError.value = null
    // 9.14：印刷工事归属账本与特殊战斗待决一并回到初始
    printedHedgehogOwners.value = {}
    specialPending.value = null
    // 13.3f / 专规 1.2：换轨账本回到该剧本的初设（重置后账本不得残留上一局的换轨）
    seedConvertedRailsNow()
    // 13.3d 端头标记不播种：随换轨账本推导，上面一行落账即生效
    gaugeConversionsThisPhase.value = []
    convertedHexesThisPhase.value = []
    railMovedNewTrackThisPhase.value = []
    lastGroundEntryByUnit.value = {}
    activeSide.value = 'axis'
    phase.value = 'movement'
    const firstTurn = TURN_TRACK[0]?.turn ?? 1
    turn.value = firstTurn
    // E4：重置局是**显式开新局**，允许换种子（日常改种子由 `setSeed` 在对局中拒绝）
    applySeed(nextSeed)
    drawCount.value = 0
    recordLogHeader()
  }

  /* ── B27b：剩下 6 处「格子编号」的待点入口（值搬进 store，组件只绑字段） ── */

  /**
   * B27b（用户口径 2026-09-16 #9）：这 6 处的**值**原来都躺在组件局部 `ref` 里，
   * 待点格要写回就得有个 store 侧的家 ⇒ 统一搬进来（与 B32 把 `fuelMethod` 搬进 store 同一套做法）。
   * 组件里的文本框留着只作**显示**（点完能看见点的是哪一格），主路径是"点地图选格"。
   *
   * ★ 候选口径：**store 有明确投影的**就铺候选（12.7a 的运输点数格、13.3f-B 的单位所在格、
   *   3.3b 的地图城市格、13.7 的本方单位格）；**条件在引擎侧的**（13.5 补员格、1.6c 返场落点）
   *   用 `'any'`——只把"打格号"换成"点一下"，合法与否仍由引擎在提交时给规则号。
   */
  const rebuildReplHexText = ref('')
  const convertTargetHexText = ref('')
  const railGaugeTargetHexText = ref('')
  const cityControlHexText = ref('')
  const formationMarkerHexText = ref('')
  const deadPileReturnHexText = ref('')

  /**
   * 13.5：重建候选落点（**结构投影**：还没按该格补员是否够付来筛）
   *
   * 复用 `planRebuild` 的 ④ 落点判据，按"待重建单位"分类给出落点：
   *   · 空军（死亡堆）：处于**追溯补给**的友方空军基地（`friendlyAirBaseHexes`，**全部**列出）；
   *   · 地面**图上带损**单位（不在死亡堆）：重建须与补员**同格** ⇒ 唯一候选＝该单位所在格
   *     （且该格须满足 HQ 2 格内 ∧ 不在未抵消敌 ZOC）；
   *   · 地面**死亡堆**单位：全图扫描——HQ 2 格内 ∧ 不在未抵消敌方 ZOC 内。
   * 「所需补员全在该格」由 `rebuildLegalHexes` 用同一份引擎请求逐格预演。
   */
  function rebuildCandidateHexes(unitId: string): HexRef[] {
    const candidate =
      deadPile.value.find((unit) => unit.instanceId === unitId) ??
      units.value.find((unit) => unit.instanceId === unitId)
    if (candidate === undefined) return []
    const isAir = isAirDeadPileEntry(candidate)
    const inDeadPile = deadPile.value.some((unit) => unit.instanceId === unitId)

    // 空军：全部处于追溯补给的友方空军基地（v7.1 §4.1 子项 1：玩家自己点基地）
    if (isAir) {
      const traceCovered = traceCoverageHexes(supplyFacts.value, {
        side: activeSide.value,
        mobility: 'truck',
      })
      return airBases.value
        .filter(
          (item) => item.side === activeSide.value && traceCoverageHas(traceCovered, item.hex),
        )
        .map((item) => ({ ...item.hex }))
    }

    // 13.5a：与 `rebuildUnitNow` 同一份投影（界面高亮与判据不许两套）
    const hqHexes = rebuildHqHexes.value
    const range = rulesConstants.repl.rebuildHqRangeHexes
    const withinHq = (hex: HexRef): boolean => hqHexes.some((hq) => hexDistance(hq, hex) <= range)

    // 地面图上带损：须与补员同格 ⇒ 唯一候选＝单位所在格，且须满足 HQ/ZOC
    if (!inDeadPile && 'hex' in candidate && candidate.hex !== null) {
      const hex = candidate.hex
      const inZoc = zocOnlySupplyFacts.value.inEnemyZoc(hex, activeSide.value)
      return withinHq(hex) && !inZoc ? [{ ...hex }] : []
    }

    // 13.5a：**重建**的落点策略（与 13.5 的初次摆放分开两条）
    return rebuildReplPlacementHexes.value
  }

  /** 13.5：本枚重建要用的行键（已选则用玩家的；否则按算子类型自动映射） */
  function rebuildRowFor(unitId: string): string {
    if (rebuildPickUnitId.value === unitId && rebuildPickRow.value !== '') {
      return rebuildPickRow.value
    }
    return rebuildSuggestionFor(unitId) ?? ''
  }

  /**
   * 13.5a 第 1) 项：**该单位此刻真正的合法重建格**
   *
   * 逐格拿同一份引擎请求预演（`planRebuild`），因此「所需补员全在该格 + HQ 2 格内 + 无未抵消敌 ZOC」
   * 一次判完；地图高亮的格与点下去的结果必然一致。
   */
  function rebuildLegalHexes(unitId: string): HexRef[] {
    const row = rebuildRowFor(unitId)
    if (row === '') return []
    return rebuildCandidateHexes(unitId).filter((hex) => {
      const built = rebuildRequestOf({
        unitId,
        rebuildType: row,
        replHexText: hexTextOf(hex),
      })
      return built !== null && planRebuild(built.request).ok
    })
  }

  /**
   * 13.5a：此刻能在**该格**重建的本方死亡堆单位（盘面右键的目标侧投影）
   *
   * 死亡堆单位不在图上，右键"某个合法落点格 / 空军基地"是它在盘面的唯一入口：
   * 落点由玩家右键的格给定，菜单只列此刻真能在此重建的单位（不可用 ⇒ 整项不出现）。
   * 与 `beginDeadPileRebuildNow` 共用同一份引擎预演（`rebuildLegalHexes`），不另写判据。
   */
  function deadPileRebuildUnitsAt(hex: HexRef): { id: string; name: string }[] {
    if (!actionAllowedNow('rein.rebuild')) return []
    const out: { id: string; name: string }[] = []
    for (const entry of deadPile.value) {
      if (entry.side !== activeSide.value) continue
      if ('rebuildable' in entry && entry.rebuildable === false) continue
      if (!rebuildCandidateHexes(entry.instanceId).some((item) => sameHex(item, hex))) continue
      if (!rebuildLegalHexes(entry.instanceId).some((item) => sameHex(item, hex))) continue
      out.push({ id: entry.instanceId, name: entry.name })
    }
    return out
  }

  /** 13.5a：右键合法落点格 → 点「重建 <名>」即在该格回场（落点已由右键的格给定） */
  function rebuildDeadPileAtHexNow(unitId: string, hex: HexRef): boolean {
    const row = rebuildRowFor(unitId)
    if (row === '') return false
    if (!rebuildLegalHexes(unitId).some((item) => sameHex(item, hex))) return false
    return rebuildUnitNow({ unitId, rebuildType: row, replHexText: hexTextOf(hex) })
  }

  /** 13.5：死亡堆右键「重建」→ 高亮该单位全部合法重建格 → 点格即扣点落位（§4.1） */
  function beginDeadPileRebuildNow(unitId: string): boolean {
    const row = rebuildRowFor(unitId)
    if (row === '') {
      pushLog('warning', `无法确定 ${unitId} 的重建表行键（13.5）`, '13.5')
      return false
    }
    rebuildPickUnitId.value = unitId
    rebuildPickRow.value = row
    const candidates = rebuildLegalHexes(unitId)
    if (candidates.length === 0) {
      pushLog(
        'warning',
        '没有可重建的合法落点（13.5a：所需补员须全在该格、在战斗模式友方 HQ 2 格内、且不在未抵消的敌方 ZOC 内）',
        '13.5a',
      )
      return false
    }
    beginHexPick({
      label: '重建落点（13.5a 合法格）',
      rule: '13.5a',
      candidates,
      apply: (hex) => {
        rebuildReplHexText.value = hexTextOf(hex)
        return rebuildUnitNow({ unitId, rebuildType: row, replHexText: hexTextOf(hex) })
      },
    })
    return true
  }

  /** 13.5a 第 2) 项：图上打残单位能否在本格重建（补员须同格） */
  function canRebuildOnMapNow(unitId: string): boolean {
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined || unit.side !== activeSide.value) return false
    if (unit.steps >= unit.printedSteps) return false
    if (!actionAllowedNow('rein.rebuild')) return false
    const row = rebuildRowFor(unitId)
    if (row === '') return false
    const built = rebuildRequestOf({
      unitId,
      rebuildType: row,
      replHexText: hexTextOf(unit.hex),
    })
    return built !== null && planRebuild(built.request).ok
  }

  /** 13.5a 第 2) 项：盘面打残右键 → 落点固定本格，**不出高亮** → 点即扣点 */
  function rebuildOnMapUnitNow(unitId: string): boolean {
    const unit = units.value.find((item) => item.instanceId === unitId)
    if (unit === undefined || !canRebuildOnMapNow(unitId)) return false
    return rebuildUnitNow({
      unitId,
      rebuildType: rebuildRowFor(unitId),
      replHexText: hexTextOf(unit.hex),
    })
  }

  /** 13.5f 子项 1：可放飞机的本方空军基地（追溯补给 + 14.2a 激活堆叠未满） */
  function airRebuildBaseHexes(unitId: string): HexRef[] {
    const row = rebuildRowFor(unitId) || (rebuildSuggestionFor(unitId) ?? 'Aircraft')
    return rebuildCandidateHexes(unitId).filter((hex) => {
      const base = airBases.value.find((item) => sameHex(item.hex, hex))
      if (base === undefined) return false
      if (activeAircraftInBase(allAirViews.value, hex) >= activeStackingLimitOf(base)) {
        return false
      }
      const built = rebuildRequestOf({
        unitId,
        rebuildType: row,
        replHexText: hexTextOf(hex),
      })
      return built !== null && planRebuild(built.request).ok
    })
  }

  /** 13.5f 子项 1：死亡堆右键飞机 →「放入地图空军基地」→ 高亮基地 → 点格即放置 */
  function beginAirRebuildBasePickNow(unitId: string): boolean {
    const row = rebuildRowFor(unitId) || (rebuildSuggestionFor(unitId) ?? 'Aircraft')
    const candidates = airRebuildBaseHexes(unitId)
    if (candidates.length === 0) {
      pushLog(
        'warning',
        '没有可放飞机的本方空军基地（13.5f：须处于追溯补给；14.2a：激活堆叠未满）',
        '13.5f',
      )
      return false
    }
    beginHexPick({
      label: '飞机重建落点（本方空军基地）',
      rule: '13.5f',
      candidates,
      apply: (hex) => rebuildUnitNow({ unitId, rebuildType: row, replHexText: hexTextOf(hex) }),
    })
    return true
  }

  /** 13.5f 子项 2：能否直接放入本方地图外空军盒（盒按方一个、容量无限；只判补员够不够） */
  function canRebuildAircraftIntoBoxNow(unitId: string): boolean {
    const unit = deadPile.value.find((item) => item.instanceId === unitId)
    if (unit === undefined || !isAirDeadPileEntry(unit)) return false
    if (!actionAllowedNow('rein.rebuild')) return false
    const row = rebuildRowFor(unitId) || (rebuildSuggestionFor(unitId) ?? 'Aircraft')
    const built = rebuildRequestOf({ unitId, rebuildType: row, airBox: true })
    return built !== null && planRebuild(built.request).ok
  }

  /** 13.5f 子项 2：点即移入地图外空军盒（不弹二次确认；§4.1） */
  function rebuildAircraftIntoBoxNow(unitId: string): boolean {
    if (!canRebuildAircraftIntoBoxNow(unitId)) return false
    const row = rebuildRowFor(unitId) || (rebuildSuggestionFor(unitId) ?? 'Aircraft')
    return rebuildUnitNow({ unitId, rebuildType: row, airBox: true })
  }

  /** 13.5：兼容旧入口（面板的「点地图选补员格」） */
  function beginRebuildReplHexPickNow(unitId: string): void {
    beginDeadPileRebuildNow(unitId)
  }

  /**
   * 13.5：死亡堆窗口里"点选 / 右键"的那一枚（用户 2026-11-10 报的实机 bug）
   *
   * 只做**选中与预选**：把该持项带进唯一的重建对象状态（`rebuildPickUnitId`），
   * 并按算子类型**自动映射**行键（`selectRebuildUnitNow`）；推不出唯一行才留空。
   */
  const deadPilePickId = ref('')
  function pickDeadPileUnitNow(instanceId: string): void {
    if (!deadPile.value.some((unit) => unit.instanceId === instanceId)) {
      pushLog('warning', `死亡堆中没有 ${instanceId}（13.5）`, '13.5')
      return
    }
    deadPilePickId.value = instanceId
    // 13.5：选中即按算子类型自动映射行键（唯一行才写，推不出唯一行留空）
    selectRebuildUnitNow(instanceId)
    /*
     * 用户 2026-11-18：死亡堆里**选中一枚**就直接进入重建选格——
     * 地图立刻高亮该单位的全部合法落点（`rebuildLegalHexes`，13.5a 既有判据），
     * 点其中一格即落盘（`rebuildUnitNow`），不再经会话框确认或二次点选。
     * 不在重建环节/无合法落点时不强行开选格：仍保留 `deadPileRebuildBlockedReason` 的可见原因。
     */
    if (
      rebuildPickUnitId.value === instanceId &&
      actionAllowedNow('rein.rebuild') &&
      rebuildCandidateHexes(instanceId).length > 0
    ) {
      beginDeadPileRebuildNow(instanceId)
    }
  }

  /**
   * 13.5：死亡堆持项**为什么不能回场**（不可回场时必须可见，用户 2026-11-10）
   *
   * 逐条按原文给原因，顺序由"永久性 → 时机 → 落点"决定（永久挡的先说，免得玩家白找落点）：
   *   · 13.5c：AR 后有黄点（`rebuildable: false`）⇒ 永久移出，永远不可重建；
   *   · 13.5：重建只在增援阶段的「重建」环节（动作闸门 `rein.rebuild`）；
   *   · 13.5a：没有合法落点（战斗面友方 HQ 2 格内 ∧ 非未抵消敌 ZOC；空军须追溯补给基地）。
   */
  function deadPileRebuildBlockedReason(unitId: string): string | null {
    const unit = deadPile.value.find((item) => item.instanceId === unitId)
    if (unit === undefined) return '13.5：死亡堆里没有这枚单位'
    if (unit.side !== activeSide.value) return '13.5：只能重建当前行动方的单位'
    if ('rebuildable' in unit && unit.rebuildable === false)
      return '13.5c：AR 后有黄点（rebuildable: false）⇒ 永久不可重建，被摧毁即移出游戏'
    if (!actionAllowedNow('rein.rebuild'))
      return '13.5：重建只在增援阶段的「重建」环节（当前环节不放行）'
    if (rebuildCandidateHexes(unitId).length === 0)
      return '13.5a：没有合法落点（须在战斗面友方 HQ 2 格内、且不在未抵消敌 ZOC 内；空军须处于追溯补给的友方基地）'
    return null
  }

  /**
   * 13.5：死亡堆持项的右键菜单（**不满足的子项不出现**，用户裁定 6；不做灰项）
   *
   * v7.1 §4.1：飞机分两个子项——「放入地图空军基地」与「放入地图外空军基地」，
   * 各自只在本方条件满足时出现；地面只有一项「重建（13.5）」。
   */
  function deadPileActionsOf(unitId: string): {
    key:
      | 'deadPile.rebuild'
      | 'deadPile.rebuildAirBase'
      | 'deadPile.rebuildAirBox'
      | 'deadPile.removeForever'
    label: string
    rule: string
    disabledReason: string | null
  }[] {
    const unit = deadPile.value.find((item) => item.instanceId === unitId)
    const actions: {
      key:
        | 'deadPile.rebuild'
        | 'deadPile.rebuildAirBase'
        | 'deadPile.rebuildAirBox'
        | 'deadPile.removeForever'
      label: string
      rule: string
      disabledReason: string | null
    }[] = []
    if (unit !== undefined && unit.side === activeSide.value) {
      if (isAirDeadPileEntry(unit)) {
        if (airRebuildBaseHexes(unitId).length > 0) {
          actions.push({
            key: 'deadPile.rebuildAirBase',
            label: '放入地图空军基地（13.5f）',
            rule: '13.5f',
            disabledReason: null,
          })
        }
        if (canRebuildAircraftIntoBoxNow(unitId)) {
          actions.push({
            key: 'deadPile.rebuildAirBox',
            label: '放入地图外空军基地（1.4a）',
            rule: '专规 1.4a',
            disabledReason: null,
          })
        }
      } else if (deadPileRebuildBlockedReason(unitId) === null) {
        actions.push({
          key: 'deadPile.rebuild',
          label: '重建（13.5，付 Pax/Eq）',
          rule: '13.5',
          disabledReason: null,
        })
      }
    }
    actions.push({
      key: 'deadPile.removeForever',
      label: '永久移除（13.5c）',
      rule: '13.5c',
      disabledReason: null,
    })
    return actions
  }

  /** 13.5：死亡堆菜单项的执行入口（界面只按 key 转发） */
  function runDeadPileActionNow(
    unitId: string,
    key:
      | 'deadPile.rebuild'
      | 'deadPile.rebuildAirBase'
      | 'deadPile.rebuildAirBox'
      | 'deadPile.removeForever',
  ): boolean {
    if (key === 'deadPile.rebuild') return beginDeadPileRebuildNow(unitId)
    if (key === 'deadPile.rebuildAirBase') return beginAirRebuildBasePickNow(unitId)
    if (key === 'deadPile.rebuildAirBox') return rebuildAircraftIntoBoxNow(unitId)
    removeForeverNow(unitId)
    return true
  }

  /** 12.7a：把运输点数转成延补队的格（候选＝图上本方运输点数所在的格） */
  function beginConvertTargetHexPickNow(): void {
    beginHexPick({
      label: '转换格（运输点数 → 延补队）',
      rule: '12.7a',
      candidates: transportPointsOfSide.value.map((unit) => unit.hex),
      apply: (hex) => {
        convertTargetHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /**
   * 13.3f-B：换轨的铁路格
   *
   * 原文：「一个铁路修理单位只需**移动进入**一个铁路格，就可转换**该铁路格**的轨距。
   * 轨距转换不消耗 SP，也不消耗额外的移动点数」⇒ 候选只给**该单位现在所在的那一格**
   * （13.3g-D 的"每阶段最多 4 格 / 须战斗模式"由引擎在提交时判）。
   */
  function beginRailGaugeTargetHexPickNow(instanceId: string): void {
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) {
      pushLog('warning', `换轨：找不到单位实例 ${instanceId}（13.3f）`, '13.3f')
      return
    }
    beginHexPick({
      label: '换轨的铁路格',
      rule: '13.3f',
      candidates: [unit.hex],
      apply: (hex) => {
        railGaugeTargetHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /** 3.3b：城市控制声明（候选＝地图上标着城市的格；轴控与否由引擎的动作切换） */
  function beginCityControlHexPickNow(): void {
    beginHexPick({
      label: '城市格',
      rule: '3.3b',
      candidates: mapCityHexes.value,
      apply: (hex) => {
        cityControlHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /** 13.7：编队收纳盒的标记格（原文：「至少一个所属单位须与标记同格」⇒ 候选＝图上本方单位格） */
  function beginFormationMarkerHexPickNow(): void {
    beginHexPick({
      label: '编队标记格',
      rule: '13.7',
      candidates: ownUnitsOnMap.value.map((unit) => unit.hex),
      apply: (hex) => {
        formationMarkerHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /** 1.6c：死亡堆返场落点（"能直接拖取追溯补给的 HQ 或边缘补给源格"⇒ 引擎在提交时判） */
  function beginDeadPileReturnHexPickNow(): void {
    beginHexPick({
      label: '死亡堆返场落点',
      rule: '1.6c',
      candidates: 'any',
      apply: (hex) => {
        deadPileReturnHexText.value = hexTextOf(hex)
        return true
      },
    })
  }

  /* ────────────── P0 修复（B48）：盘面快照 —— 存/读档必须带上盘面 ────────────── */

  /**
   * **盘面快照的字段表**（唯一真源：`snapshotBoard` / `boardSnapshotFits` / `restoreBoard` 都照它走）
   *
   * 为什么要这张表：修前存档只装"会话"（记录轨 / 日志 / 种子 / 形态），而**盘面**（算子、补给站、
   * 飞机、各类账本）全在本 store 里，谁都没存过 ⇒ 读档后"时钟走了、盘面还停在原处"，两者互相矛盾，
   * 而界面还写着"任意环节都可存档"。本表就是"哪些东西属于盘面"的可审查清单。
   *
   * ## 收录判据（三条，缺一不可）
   *   ① 是**盘面上的实体或账本**（不是"手正在做的事"）；
   *   ② 读档后必须与存档那一刻**一致**；
   *   ③ **不是**从会话派生的（派生项随会话本体一起回来）。
   *
   * ## 刻意不收（边界，写在这里以免被当成漏收）
   *   · **会话派生的**：`activeSide` / `phase` / `turn` / `date` / `seed` / `rng` / `drawCount` /
   *     `scenarioId`（含无会话时的 `localActiveSide` / `localPhase` / `localRng` 兜底）——它们读的是
   *     `session.state`，读档时随会话本体回来；重复收反而会打架；
   *   · **交互进行态**（"手正在做的事"）：`selectedId` / `tool` / `hoverHex` / `moveInteraction` /
   *     `movePick` / `pendingRecord` / `pendingHexPick` / 各面板的下拉与草稿
   *     （`*Inputs` / `*Draft` / `supplyUnitId` / `fuelDumpId` / `airPlacement` …）/ 引擎交互状态机
   *     （`combatState` / `barrageState` / `supplyState` / `airState`）/ 中途战斗的选人（`combatTagalongIds`
   *     / `combatSupplyDumpIds` / `combatStartSnapshot` / `overrun*`）——**读档后这些一律回到初始**，
   *     即"读到一半的交互不会跨存档续上"，但盘面本身仍然自洽（这是刻意的边界）；
   *   · **显示用回执**：`last*`（`lastStep` / `lastBattle` / `lastRailMove` / `lastRefit` …）与
   *     界面日志 `log`——日志的**整局审计**是 `session.log`，随会话本体回来。
   *
   * ## 顺序
   * 表里的次序即还原次序：**盘面实体在前、账本在中、"由盘面推导"的账本（`victoryLastControl`）在后**。
   * `restoreBoard` 末尾还会按新盘面重播一次 5.0c 的控制账（幂等；见那里的注释）。
   */
  const boardSnapshotFields = (): readonly (readonly [string, Ref<unknown>])[] => [
    ['segmentStepIndex', segmentStepIndex],
    ['hqFuelThrows', hqFuelThrows],
    ['formationFuelThrows', formationFuelThrows],
    ['supplyRecoverySettled', supplyRecoverySettled],
    ['supplyFeedingSettled', supplyFeedingSettled],
    ['attritionAppliedHexes', attritionAppliedHexes],
    ['automaticPhaseKeys', automaticPhaseKeys],
    ['lastVariableRepl', lastVariableRepl],
    ['variableReplSpecialDie', variableReplSpecialDie],
    ['supplyArrivalSp', supplyArrivalSp],
    ['supplyTrainHex', supplyTrainHex],
    ['freeRailPicked', freeRailPicked],
    ['freeRailEdgeHex', freeRailEdgeHex],
    // ① 盘面实体
    ['units', units],
    ['edgeBoxHoldings', edgeBoxHoldings],
    ['edgeBoxEnteredOn', edgeBoxEnteredOn],
    ['spDumps', spDumps],
    // 14.9（T16）：图外空军盒补给库存账本（`${side}:${box}` → {sp,t}）
    ['offMapSupplyStocks', offMapSupplyStocks],
    ['airUnits', airUnits],
    // 专规 1.4a：谁驻在图外空军盒（不存则读档后"盒里的飞机回到图上"，1.4a 的事实被丢掉）
    ['airBoxMembers', airBoxMembers],
    ['deadPile', deadPile],
    ['removedForever', removedForever],
    // ② 账本（补员 / 拆解 / 补给缓存 / 装甲集群与编队归属）
    // §5-D：补员的**盘面外**状态（Pax/Eq 的枚数在 `units` 里，随算子一并存档）
    ['replPending', replPending],
    ['replFtrTac', replFtrTac],
    ['breakdownPool', breakdownPool],
    ['supplyCacheHoldings', supplyCacheHoldings],
    ['supplySourceDecls', supplySourceDecls],
    ['panzerGroupAssignments', panzerGroupAssignments],
    ['spDumpPanzerGroups', spDumpPanzerGroups],
    ['pendingSpGroupAssignment', pendingSpGroupAssignment],
    ['multiUnitFormationIds', multiUnitFormationIds],
    // ②′ 账本（铁路 / 换轨 / 施工 / 机场 / 胜利格 / 印刷工事）
    ['convertedRailHexes', convertedRailHexes],
    // 13.3d 端头标记**不存档**：由 `convertedRailHexes` + 铁路连通推导，读档后自动重算
    ['gaugeConversionsThisPhase', gaugeConversionsThisPhase],
    ['convertedHexesThisPhase', convertedHexesThisPhase],
    ['railMovedNewTrackThisPhase', railMovedNewTrackThisPhase],
    ['railCapSpentThisTurn', railCapSpentThisTurn],
    ['railMovedUnitIdsThisPhase', railMovedUnitIdsThisPhase],
    ['engineerHqDetrainableHexes', engineerHqDetrainableHexes],
    ['constructionMarkers', constructionMarkers],
    ['constructionMarkerPieces', constructionMarkerPieces],
    ['constructionLedgers', constructionLedgers],
    ['hedgehogTurnLedger', hedgehogTurnLedger],
    ['airBaseTurnLedger', airBaseTurnLedger],
    ['airUnloadLedger', airUnloadLedger],
    ['airstripBaseIds', airstripBaseIds],
    ['refitDoneBaseIds', refitDoneBaseIds],
    ['reducedBaseIds', reducedBaseIds],
    ['axisControlledCityKeys', axisControlledCityKeys],
    ['trainbustingMarks', trainbustingMarks],
    ['printedHedgehogOwners', printedHedgehogOwners],
    ['victoryLastControl', victoryLastControl],
    // ②″ 账本（阶段级：轰炸 / 补给阶段 / 损耗 / 喂饱 / 销毁尝试）
    ['barragedHexesThisPhase', barragedHexesThisPhase],
    ['barragedUnitIdsThisPhase', barragedUnitIdsThisPhase],
    // ②‴ 账本（环节级：9.1c 的攻击账本——不进档的话，读档后当回合的战斗环节会被"重打一次"）
    ['attackedUnitIdsThisPhase', attackedUnitIdsThisPhase],
    ['attackedHexesThisPhase', attackedHexesThisPhase],
    ['supplyPhasePlan', supplyPhasePlan],
    ['supplyPhaseInputs', supplyPhaseInputs],
    ['dumpDestructionAttempts', dumpDestructionAttempts],
    ['attritionInputs', attritionInputs],
    ['attritionResults', attritionResults],
    ['oosFedReByDump', oosFedReByDump],
    // ②‴ 账本（回合级 / 专规）
    ['variableExitResolved', variableExitResolved],
    ['frontalReservesClaimed', frontalReservesClaimed],
    ['fuelPool', fuelPool],
    // ③ 待决与预约
    ['specialPending', specialPending],
    ['breakoutReturns', breakoutReturns],
    ['arrivalHexOverrides', arrivalHexOverrides],
    // 13.6：到达"已投放"账本（不存则读档后同一条目可再放一次 ⇒ 凭空多出算子）
    ['arrivalPlacedKey', arrivalPlacedKey],
    ['arrivalPlacedRaw', arrivalPlacedRaw],
    // 2026-11-09：手牌式增援的可撤销账本（投放时新建的 instanceId）
    ['arrivalPlacedUnitsRaw', arrivalPlacedUnitsRaw],
    // 13.6：逐枚点名条目的投放进度（`2x Corps HQ (9, 12)` ⇒ 已投哪几枚）
    ['arrivalPlacedSlotsRaw', arrivalPlacedSlotsRaw],
  ]

  /**
   * 快照载荷的版本号（字段表变了就递增；`boardSnapshotFits` 靠它把"别的构建写的档"挡在外面）
   *
   * ★ 2（2026-09-18，批 A 切片 3）：字段表新增 9.1c 的两个攻击账本 ⇒ 按本行的纪律递增。
   *   递增的代价是**旧存档一律拒读**（"先验后改"，不会把盘面读成半截）；不递增则更糟：
   *   旧构建读到含新字段的档会**静默丢掉**这两个账本（它的字段表里没有这两项，逐项在场检查放行）。
   *
   * ★ 3（2026-10-24，第六批条 5）：字段表新增到达"已投放"账本（`arrivalPlacedKey`/`arrivalPlacedRaw`）
   *   —— 不存则在**增援段中途存档→读档**后，同一条目可再投放一次（凭空多出算子）⇒ 必须进档。
   *
   * ★ 4（2026-10-25，§5-D 补员盘面化）：字段表用 `replPending`/`replFtrTac` 取代 `replHoldings`
   *   —— Pax/Eq 从"账本数字"变成**盘面算子**（每 1 点一枚，随 `units` 存档），
   *   账本只剩"待放置"与 Ftr/Tac 两小块。旧档（≤3）由 `migrateBoardV3ToV4` 迁移：
   *   把 `replHoldings` 的 Pax/Eq 按点摆成补员算子（盘面为唯一事实，用户裁定⑨）。
   */
  /*
   * ★ 5（2026-10-30）：字段表新增 `airBoxMembers`（专规 1.4a 图外空军盒的驻机名单）。
   *   不存则"存档→读档"后驻在盒里的飞机被当成在图上的机场格（`hex` 未变）——
   *   等于白送回图上，而且任务航程也不再按"从对应行入场"扣 20/30 格。
   *   旧档（4）由 `boardSnapshotFits` 的"上一版"通道接受，缺该键 ⇒ 读成空盒（与原状一致，不会更糟）。
   *
   * ★ 6（2026-11-07，T16）：字段表新增 `offMapSupplyStocks`（图外空军盒补给库存账本）。
   *   不存则"离图盒装货→存档→读档"后已扣的库存复活（同时在途 SP 也还在）⇒ 凭空多出补给。
   *   旧档（6）缺该键 ⇒ 读成 `{}`；绝不回填 `spDumps`，不吞既有地图库存。
   */
  // v8（1.4b）：盒内地面单位和入盒回合随盘面保存。
  // v9（2026-11-09）：手牌式增援的撤回账本 `arrivalPlacedUnitsRaw`（投放时新建的算子 id）。
  // v10（2026-11-14）：1.6c 已掷骰面 `variableReplSpecialDie`（读档后「掷骰检定」复用同一颗）。
  // v11（2026-11-17）：逐枚点名多枚条目的投放进度 `arrivalPlacedSlotsRaw`（不存则读档后同一枚可再放一次）。
  const V11_FIELDS = ['arrivalPlacedSlotsRaw']
  const V10_FIELDS = ['variableReplSpecialDie', ...V11_FIELDS]
  const V9_FIELDS = ['arrivalPlacedUnitsRaw', ...V10_FIELDS]
  const BOARD_SNAPSHOT_VERSION = 11
  const V8_FIELDS = ['edgeBoxHoldings', 'edgeBoxEnteredOn']
  const V6_FIELDS = [
    'segmentStepIndex',
    'hqFuelThrows',
    'formationFuelThrows',
    'supplyRecoverySettled',
    'supplyFeedingSettled',
    'attritionAppliedHexes',
    'automaticPhaseKeys',
    'lastVariableRepl',
    'supplyArrivalSp',
    'supplyTrainHex',
    'freeRailPicked',
    'freeRailEdgeHex',
  ]

  /**
   * §5-D：把 v3 及更早的补员账本迁成 v4 的盘面算子
   *
   * 旧档只有四个数字（`replHoldings`）与一个"补员所在格"文本，没有补员算子；
   * 迁移按**确定性规则**摆：Pax/Eq 各按点数摆那么多枚，落点取该档记的补员格，
   * 没有则放到当前方第一座己方指挥部（SOP 游戏提示的"训练分队"），再不行就退回待放置。
   */
  function migrateBoardV3ToV4(fields: Record<string, unknown>): void {
    const holdings = fields['replHoldings'] as Partial<ReplHoldings> | undefined
    if (holdings === undefined) return
    const pax = Math.max(0, Math.trunc(holdings.pax ?? 0))
    const eq = Math.max(0, Math.trunc(holdings.eq ?? 0))
    const ftr = Math.max(0, Math.trunc(holdings.ftr ?? 0))
    const tac = Math.max(0, Math.trunc(holdings.tac ?? 0))
    replFtrTac.value = { ftr, tac }
    const declared = parseHexPath(rebuildReplHexText.value)[0] ?? null
    const hqHex =
      units.value.find((unit) => unit.side === activeSide.value && unit.specialized.includes('hq'))
        ?.hex ?? null
    const hex = declared ?? hqHex
    if (hex === null) {
      replPending.value = { pax, eq }
      return
    }
    placeReplCounters(hex, 'pax', pax)
    placeReplCounters(hex, 'eq', eq)
    pushLog(
      'info',
      `读档迁移（v3→v4，§5-D）：补员账本 ${pax} Pax + ${eq} Eq 已按点摆成盘面算子于 ${hexLabel(hex)}`,
      '13.5',
    )
  }

  /**
   * 抓取盘面快照
   *
   * 逐字段 `JSON.parse(JSON.stringify(…))` 深拷贝：**与落盘同一套语义**（存档本就是 JSON 文本），
   * 于是"内存里往返一次"与"写文件再读回来"完全同构；也保证快照不会随盘面后续改动而变。
   */
  function settlementBlockedReason(): string | null {
    if (
      airUnitCargoManifest.value.some((item) => item.fate === 'aboard') ||
      combatSupplyCommitted.value ||
      (combatState.value !== null && !combatState.value.finished) ||
      (barrageState.value !== null && !barrageState.value.finished) ||
      (airState.value !== null && !airState.value.finished) ||
      (supplyState.value !== null && !supplyState.value.finished) ||
      (moveInteraction.value !== null && !moveInteraction.value.finished) ||
      refitBase.value !== null
    ) {
      return '请先完成当前战斗、移动、付款或其他结算，再保存或读取对局'
    }
    return null
  }

  /** 存档可用态的唯一只读投影：界面据此禁用按钮，不另算一份判据 */
  const saveBlockedReason = computed(() => settlementBlockedReason())

  function assertCompleteSettlement(): void {
    const reason = settlementBlockedReason()
    if (reason !== null) throw new Error(reason)
  }

  const LEGACY_MISSING_KEYS: Readonly<Record<number, readonly string[]>> = {
    // v3：补员还是"账本数字"（无 replPending/replFtrTac），也没有图外空军盒驻机名单
    3: [
      'replPending',
      'replFtrTac',
      'airBoxMembers',
      ...V6_FIELDS,
      'offMapSupplyStocks',
      ...V8_FIELDS,
      ...V9_FIELDS,
    ],
    // v4：§5-D 补员盘面化之后，但还没有 airBoxMembers
    4: ['airBoxMembers', ...V6_FIELDS, 'offMapSupplyStocks', ...V8_FIELDS, ...V9_FIELDS],
    5: [...V6_FIELDS, 'offMapSupplyStocks', ...V8_FIELDS, ...V9_FIELDS],
    // v6（T16）：字段表新增图外补给库存；缺键按 {} 读，spDumps 原样保留。
    6: ['offMapSupplyStocks', ...V8_FIELDS, ...V9_FIELDS],
    7: [...V8_FIELDS, ...V9_FIELDS],
    // v8（1.4b）：缺撤回账本 ⇒ 读成 {}（仅不能"回手"，不影响既有投放与规则）
    8: V9_FIELDS,
    // v9：缺 1.6c 骰面 ⇒ 读成 null（按钮会现掷一颗，与升级前行为一致）
    9: V10_FIELDS,
    // v10：缺逐枚点名条目的投放进度 ⇒ 读成 {}（升级前也放不出第二枚，不会更糟）
    10: V11_FIELDS,
  }
  const boardRegistry = createSnapshotRegistry({
    version: BOARD_SNAPSHOT_VERSION,
    fields: boardSnapshotFields,
    legacyMissingKeys: LEGACY_MISSING_KEYS,
    validate: validBoardEntities,
    beforeCapture: assertCompleteSettlement,
    afterRestore(prepared, silent) {
      if (prepared.sourceVersion === 3) migrateBoardV3ToV4(prepared.fields)
      const merged = normalizeSpDumpsOnLoad()
      clearCombat(true)
      fireResolution.resetBarrage()
      moveInteraction.value = null
      movePick.value = null
      clearBarrage()
      airMissionDomain.reset(true)
      airUnitTransit.reset()
      clearAir()
      clearSupply()
      refitTargetBaseId.value = null
      initialSetupInProgress.value = false
      // 用户 2026-11-20：读档/重开是换了一局，上一局的撤销账不再可撤
      if (!silent) clearUndoTrail()
      // 5.4a：额度由 `units` 的当前模式派生（`reservedHexes`）⇒ 随单位一起还原，无需重放日志
      if (silent) return
      syncVictoryControlFromBoard()
      pushLog(
        'info',
        `读档：盘面已还原 ${String(boardSnapshotFields().length)} 项（算子 ${String(units.value.length)} 枚 / 补给站 ${String(spDumps.value.length)} 处 / 飞机 ${String(airUnits.value.length)} 架）`,
      )
      if (merged > 0) {
        pushLog(
          'info',
          `读档：同格同方同归属的补给站账本按 12.1b 归并了 ${String(merged)} 条（旧档/改档兼容）`,
          '12.1b',
        )
      }
    },
  })
  function snapshotBoard(): unknown {
    if (airUnitCargoManifest.value.some((item) => item.fate === 'aboard'))
      throw new Error('载货空军任务仍在结算中，地面单位在途，请完成卸载或退运后保存')
    if (airSupplyManifest.value !== null && airState.value !== null && !airState.value.finished)
      throw new Error('空运SP仍在结算中，请完成任务及返航后保存')
    if (
      airState.value !== null &&
      !airState.value.finished &&
      (airState.value.kind === 'air_transport' || airState.value.kind === 'air_drop')
    )
      throw new Error('载货空军任务仍在结算中，请完成任务及返航后保存')
    return boardRegistry.capture()
  }
  function boardSnapshotFits(board: unknown): boolean {
    return boardRegistry.accepts(board)
  }
  function restoreBoard(board: unknown, silent = false): void {
    boardRegistry.restore(board, silent)
  }

  /**
   * 12.1b / §5-C：**读档后把同格同方同归属的补给站账本并成一条**
   *
   * 为什么要在读档做一次：本次修复前 `addSpAtHex` 会无条件新建条目，故**旧档**里可能已在同一格同一方
   * 留下多条账本；手工改过的档同理。而付款路径是 `find(side + sameHex)` 只取第一条 ⇒ 其余 SP
   * 变成"看得见、付不出"的死额（13.2f 装载 / 15.1B 整备 / 轰炸会误报"SP 不足"）。
   *
   * 归并规则：按**首次出现顺序**保留第一条的 id（使 `spDumpPanzerGroups` 等按 id 的引用仍有效），
   * 金额相加后按 12.1a 折算成「尽可能并为 SP」的规范形。对本来就一致的盘面**幂等**（返回 0）。
   */
  function normalizeSpDumpsOnLoad(): number {
    const normalized = normalizeSupplyDumps(
      spDumps.value,
      spDumpPanzerGroups.value,
      pendingSpGroupAssignment.value,
    )
    spDumps.value = normalized.dumps
    spDumpPanzerGroups.value = normalized.groups
    pendingSpGroupAssignment.value = normalized.pending
    oosFedReByDump.value = remapSupplyDumpAmounts(oosFedReByDump.value, normalized.aliases)
    dumpDestructionAttempts.value = remapSupplyDumpAmounts(
      dumpDestructionAttempts.value,
      normalized.aliases,
    )
    /*
     * U8（2026-11-13）：**旧档里没有编组归属的轴方 SP** 必须显式标出来。
     *
     * 修前：它们只是 `panzerGroupOfDump === null`，`panzerGroupUnassignedDumps` 能列出，
     * 但不在 `pendingSpGroupAssignment` 里 ⇒ 不出 3.4b 置顶、付费被拒时还报「归属与受益编队
     * 不符」（真实原因是"尚未归属"）。这里**只标未归属，不猜归属**：
     *   · 3.4b 生效（日期窗口 × 开局共识）才标——失效期内的未归属是合法状态；
     *   · `setDumpPanzerGroupNow` 声明后照旧从待办移除，随档往返；
     *   · 不碰 `panzerGroupOfDump` 的 null 语义，也不猜测任何一方。
     */
    if (panzerGroupRulesOn.value) {
      const unassigned = spDumps.value
        .filter((dump) => dump.side === 'axis' && panzerGroupOfDump(dump.id) === null)
        .map((dump) => dump.id)
      const added = unassigned.filter((id) => !pendingSpGroupAssignment.value.includes(id))
      if (added.length > 0) {
        pendingSpGroupAssignment.value = [...pendingSpGroupAssignment.value, ...added]
        pushLog(
          'info',
          `读档：旧档有 ${String(added.length)} 处轴方 SP 未登记装甲集群 ⇒ 已显式标为「未归属（3.4b）」；` +
            '在专规面板声明归属后，才可用于多单位编队的燃油/战斗/轰炸付费',
          '3.4b',
        )
      }
    }
    return normalized.merged
  }

  /*
   * P0 修复（B48）：把编解码器**注册给会话层**（存/读档时由会话层回调本对函数）。
   * 注册在 setup 末尾：此刻所有被快照的 ref 都已声明（快照的执行发生在存/读档时）。
   * 若本店从未建立（只建会话层的单测），会话层就没有编解码器 ⇒ 存档退回"只有会话"的旧行为。
   */
  session.setBoardCodec({
    capture: snapshotBoard,
    accepts: boardSnapshotFits,
    restore: restoreBoard,
  })

  function resetBoardNow(nextSeed = createGameSeed()): void {
    clearCombat(true)
    fireResolution.resetBarrage()
    restoreBoard(boardRegistry.initial(), true)
    localPhase.value = 'movement'
    localTurn.value = scenarioTurnRange(scenarioId.value).firstTurn
    localRng.value = createRngState(nextSeed)
    localDrawCount.value = 0
    pendingRolls.splice(0)
    initialSetupInProgress.value = false
    // 专规 4.3：换局/重置后初设拆团账本复位（名额重新从 6 个起算）
    setupWiggleParents.value = []
    // 换局/重置后上一局的段内登记一律作废（撤回只在原段内有效，不能跨局）
    replPlacedThisSegment.value = []
    specialReplPlacedThisSegment.value = []
    frontalUnitPlacedThisSegment.value = null
    rebuildPlacedThisSegment.value = []
    seedVictoryControlFromScenario()
    refreshScenarioBoundLedgers(scenarioId.value)
  }

  /** 4.8a：勾/去勾一格内的一枚可摧毁单位（只认该格清单里的本方战斗单位） */
  function toggleOverstackPick(hexKey: string, instanceId: string): boolean {
    const duty = overstackDuties.value.find((item) => item.key === hexKey)
    if (duty === undefined) return false
    if (!duty.units.some((unit) => unit.instanceId === instanceId)) return false
    const current = overstackPicks.value[hexKey] ?? []
    const next = current.includes(instanceId)
      ? current.filter((id) => id !== instanceId)
      : [...current, instanceId]
    overstackPicks.value = { ...overstackPicks.value, [hexKey]: next }
    return true
  }

  /**
   * 4.8a 落盘：把勾选的单位移入死亡堆（走 `eliminateEntry` 唯一入口）
   *
   * ★ 不给「忽略 / 稍后」旁路：**每一格**勾完都必须回到 ≤10 RE 才允许提交；
   *   任一格仍超限就整批拒绝并留 warning，界面上的推进也继续被 `segmentAdvanceBlock` 拦住。
   */
  function destroyOverstackPicksNow(): boolean {
    const duties = overstackDuties.value
    if (duties.length === 0) return false
    const toDestroy: ConsoleUnit[] = []
    for (const duty of duties) {
      const picked = overstackPicks.value[duty.key] ?? []
      const chosen = duty.units.filter((unit) => picked.includes(unit.instanceId))
      const remaining = duty.combatRe - chosen.reduce((sum, unit) => sum + unit.re, 0)
      if (remaining > STACKING_LIMIT_RE) {
        pushLog(
          'warning',
          `${duty.key} 仍超堆叠（${remaining} RE > ${STACKING_LIMIT_RE} RE）：4.8a 须由拥有者继续选择摧毁，不能跳过`,
          '4.8a',
        )
        return false
      }
      for (const unit of chosen) {
        const found = units.value.find((item) => item.instanceId === unit.instanceId)
        if (found !== undefined) toDestroy.push(found)
      }
    }
    if (toDestroy.length === 0) return false
    for (const unit of toDestroy) {
      eliminateEntry(unit, '4.8a', `${hexLabel(unit.hex)} 超堆叠：摧毁 ${unit.name}（4.8a）`)
    }
    overstackPicks.value = {}
    return true
  }

  /** 只自动执行规则义务；战损如何分配等玩家选择必须留在正式面板。 */
  function settleSegmentObligations(wholePhase = false): boolean {
    const block = segmentAdvanceBlock(wholePhase)
    if (block !== null) {
      // 5.7g 的既有回执保留在这里（换段由协调器调用时也要留痕）
      if (block.rule === '5.7g') pushLog('warning', block.reason, block.rule)
      return false
    }
    /*
     * 3.4a：段末先自动结清「命中单枚」的义务（只有多枚才要玩家选，已由上面的 block 拦住）。
     * 放在这里而不是每个单位上单独问：原文的时机是相位末，且单枚没有可选空间。
     */
    settlePanzerGroupDgAtPhaseEnd()
    return phase.value !== 'supply' || supplyPhaseDomain.settleForExit(wholePhase)
  }

  /**
   * 推进按钮的**阻断原因记录**（死操作①）
   *
   * 语义：**最近一次点击**为什么没推进（null＝上一次推进正常）。流程条把它显示在按钮旁；
   * **不用它置灰按钮**——补给面板里办完事后，这里若还残留旧原因，按钮会被永久锁死。
   * 每次点击开头清空，成功推进则保持空。
   */
  const advanceBlocked = ref<{ rule: string; reason: string } | null>(null)

  /**
   * 「进入下一环节」此刻的**可预判阻断**（只读；与 `settleSegmentObligations` 的前四条守卫同源）
   *
   * 只报「必须先去别的面板/会话收尾」的状态；补给段的义务链**不在此列**——
   * 那些义务是「点一次就自动结算」的，只有结算失败时才知道要不要玩家介入
   * （失败原因由 `supplyPhaseDomain.exitBlock` 记录）。
   */
  function segmentAdvanceBlock(wholePhase = false): { rule: string; reason: string } | null {
    if (airState.value !== null && !airState.value.finished) {
      return {
        rule: '2.2',
        reason: '空军任务尚未结算：先完成空军流程或按 Esc 放弃，再进入下一环节',
      }
    }
    if (specialPending.value !== null) {
      return { rule: '专规', reason: '专规待办未完成：先在面板处理该待办，再进入下一环节' }
    }
    if (combatState.value !== null && !combatState.value.finished) {
      return { rule: '9.2', reason: '战斗结算进行中：先走完 9.2 流程或按 Esc 放弃，再进入下一环节' }
    }
    if (barrageState.value !== null && !barrageState.value.finished) {
      return {
        rule: '10.0',
        reason: '轰炸结算进行中：先走完 10.0 流程或按 Esc 放弃，再进入下一环节',
      }
    }
    /*
     * 4.8a：**任何环节或阶段结束时**，任一格战斗单位 >10 RE 的，拥有者必须摧毁单位回到上限，
     * 才能进入下一环节（13.6 增援阶段例外已由引擎 `stackingObligations()` 判掉）。
     * ★ 没有「忽略」旁路：只能走超堆叠面板逐格勾选摧毁；未回到 ≤10 RE 时连环节都不许换。
     */
    const overstack = overstackDuties.value[0]
    if (overstack !== undefined) {
      return {
        rule: overstack.rule,
        reason: `${overstack.detail}：先在超堆叠面板勾选并摧毁单位，再进入下一环节`,
      }
    }
    /*
     * 3.4a：段末命中**多枚**时，玩家要从中选一枚投 DG（单枚由段末自动判定，不拦）。
     * 只在段末（`panzerObligationActive`）拦：段中还没到判定时机。
     */
    const panzerChoice = panzerObligationActive.value
      ? panzerDgChoiceObligations.value[0]
      : undefined
    if (panzerChoice !== undefined) {
      return {
        rule: panzerChoice.rule,
        reason: `${panzerChoice.group === 'guderian' ? 'Guderian' : 'Hoth'} 编队命中分界线义务：先选一枚单位投 DG 再进入下一环节`,
      }
    }
    if (
      ['movement', 'reaction', 'exploitation'].includes(phase.value) &&
      (wholePhase || segmentStep.value?.id !== 'movement.breakout')
    ) {
      const movingSide =
        phase.value === 'reaction'
          ? activeSide.value === 'axis'
            ? 'soviet'
            : 'axis'
          : activeSide.value
      if (
        units.value.some(
          (unit) =>
            unit.side === movingSide &&
            unit.mode.mode === 'reserve' &&
            hedgehogLevelOf(unit.hex) > 0,
        )
      ) {
        return { rule: '5.7g', reason: '预备单位仍位于工事格，请先移出或依法切换模式后结束环节' }
      }
    }
    /*
     * 1.6b：第二段的待放项（Pax/Eq/SP/Ftr/Tac…）必须在本方「结束本段」时结清。
     *
     * 没有这道闸，流程条可以直接绕过 `endRollSegmentNow` 离开第二段：
     * 上一方的待放补员会被带进**下一方**的手牌（`replPending` 只按当前方读），
     * 面板于是把对手的补员算到自己头上。规则上补员是各方的盘面资源，不许跨方串账。
     */
    if (
      phase.value === 'reinforcement' &&
      segmentStep.value?.id === 'reinforcement.replRoll' &&
      rollHandPending.value
    ) {
      /*
       * 1.6c 未掷时「结束本段」整块**不出现**（`rollPlacementOpen === false`），
       * 此时若照旧写「或在结束本段确认放弃上场」，就是让玩家去点一个不存在的按钮。
       * 判定阶段没走完 ⇒ 只报缺的那次掷骰（与面板里的 `rollPlacementBlockedReason` 同源）。
       */
      if (!rollPlacementOpen.value) {
        return {
          rule: '1.6c',
          reason: rollPlacementBlockedReason.value ?? '判定阶段未完成：先掷完本段各项判定',
        }
      }
      return {
        rule: '1.6b',
        reason: '第二段还有待放项没落位：先放完，或在「结束本段」确认放弃上场',
      }
    }
    return null
  }

  session.setPhaseHooks(
    createPhaseCoordinator({
      current: () => session.records,
      isInitialSetup: () => initialSetupInProgress.value,
      isPlayerPhase: () => session.guidance?.step.driver === 'player',
      start() {
        initialSetupInProgress.value = false
        pendingRolls.splice(0)
        automaticPhaseKeys.value = []
      },
      settleObligations: () => settleSegmentObligations(true),
      // 4.8a：自动段（含 H 清理 → 回合收束）也要先结清超堆叠，不能带过回合。
      // ★ 剧本首回合的 Pre-Turn / A 段例外：初设合法性由 IV-F 与剧本固定格把关，
      //   自动初设的贪心落点可能把带 † 的编队堆在固定格（如剧本 3 首回合的 34.17）；
      //   4.8a 从第一个可玩环节（B 增援）末开始生效，避免"还没开局就先炸单位"。
      settleOverstack: () => {
        const records = session.records
        if (
          records !== null &&
          records.turn === scenarioFirstTurn.value &&
          (records.phase === 'preTurn' || records.phase === 'aircraftRefit')
        ) {
          return true
        }
        return overstackDuties.value.length === 0
      },
      cleanUp: runCleanUpNow,
      publishVictory: pushVictoryToSessionNow,
      resetPhase() {
        resetSegmentTransient()
        resetSupplyPhaseLedger()
        segmentStepIndex.value = 0
      },
      resetTurn() {
        hedgehogTurnLedger.value = {}
        airBaseTurnLedger.value = {}
        railCapSpentThisTurn.value = []
        freeRailPicked.value = []
        supplyArrivalSp.value = 0
        supplyTrainHex.value = null
        clearArrivalSpGroups()
      },
      refreshTrace: () => {
        refreshTraceSupply('阶段开始')
      },
      ensureReinforcement(key) {
        if (automaticPhaseKeys.value.includes(key)) return
        variableReplInputs.value.autoRoll = true
        if (rollVariableReplNow()) automaticPhaseKeys.value = [...automaticPhaseKeys.value, key]
      },
    }),
  )

  /*
   * 用户 2026-11-20：统一撤销入口的分派表。
   * `setup` 由 setup store 初始化时注册（它与本 store 互相引用，避免循环依赖）。
   */
  registerUndoFamily('move.step', () => undoLastStep())
  registerUndoFamily('transport', () => undoTransportHandlingNow())
  registerUndoFamily('draft', () => undoOptionDraftLast())
  registerUndoFamily('arrival', () => undoArrivalRailNow())
  registerUndoFamily('cache', () => undoSupplyCacheUse())

  /*
   * ── B1 装配（解构第二批：C7 轰炸）────────────────────────────────────
   * 39 个动作与 18 个账本/派生的实现在 `workbench-barrage.ts`；此处只组装依赖。
   *
   * ① 装配点必须在 setup **末尾**：本切片有 13 个依赖声明在 24k–29k 行
   *    （`segmentStep` / `segmentGateQuery` / `supplyCacheHoldings` …），早装配会踩 TDZ；
   * ② 动作走**提升的同名转发**（见 14639 分节），所以把 `acceptBarrage` 裸传给
   *    `createFireResolutionDomain` 的老写法不用动；
   * ③ 账本/派生（const）在这里解构绑定，`return` 里照旧按名取用。
   * ───────────────────────────────────────────────────────────────────
   */
  const barrage = createBarrageDomain({
    canReplaceBarrage,
    barrageActive,
    pushLog,
    barrageUnitIds,
    barrageScopeHex,
    barrageAirIds,
    fireResolution,
    barrageKind,
    barrageTargetKind,
    units,
    applyDgToUnit,
    eliminateEntry,
    airBoxMembers,
    airUnitChoices,
    activeSide,
    airUnits,
    barrageKindsInSegment,
    barrageUnitChoices,
    requireAction,
    barrageTargetHex,
    barrageTargetKindIssue,
    barrageUnits,
    barrageAirUnits,
    segmentGateQuery,
    phase,
    segmentStep,
    scenarioId,
    airDistanceFromRealBase,
    barragedHexesThisPhase,
    barragedUnitIdsThisPhase,
    barrageTargetFacts,
    recordSettlement,
    supplyFacts,
    allSpDumps,
    combatAttackers,
    battleTarget,
    spDumps,
    supplyCacheHoldings,
    dumpById,
    panzerGroupSpGate,
    panzerGroupSpRefusal,
    setSpDumpHoldings,
    barrageTerrainLineOptions,
    pickBarrageTargetAt,
    airBases,
    rng,
    drawCount,
    trainbustingMarks,
    onMapAirUnits,
    airMissionDomain,
    autoOpened: {
      get value(): boolean {
        return barrageAutoOpened
      },
      set value(next: boolean) {
        barrageAutoOpened = next
      },
    },
  })
  const {
    barrageSupplyDumpId,
    barragePaidSupply,
    barrageSupplyDumpChoices,
    barrageSupplyHqChoices,
    barrageShellMarkers,
    barragePayNeedT,
    barrageShellBudgetT,
    barrageShellPreview,
    barrageSupplyDump,
    barrageLossRequired,
    barrageLossAllocated,
    barrageLossReady,
    barrageSupplyMapDumps,
    barrageErrorLine,
    combatErrorLine,
    airErrorLine,
    barrageLossTargets,
    barrageAircraftRollTargets,
  } = barrage

  return {
    activeSide,
    engagementDecisionRole: fireResolution.decisionRole,
    initialSetupInProgress,
    resetBoardNow,
    // 盘面快照编解码器（会话层也使用；T16 旧档兼容测试需要直接调用）
    snapshotBoard,
    boardSnapshotFits,
    restoreBoard,
    saveBlockedReason,
    supplyRecoverySettled,
    supplyFeedingSettled,
    supplyRecoveryOutcome,
    supplyFeedingOutcome,
    attritionAppliedHexes,
    phase,
    segmentLocked,
    turn,
    date,
    seed,
    setSeed,
    recordLogHeader,
    rng,
    drawCount,
    units,
    edgeBoxHoldings,
    edgeBoxEnteredOn,
    sealEdgeBoxTransferNow,
    selectedId,
    pendingRecord,
    tool,
    lastStep,
    lastBattle,
    log,
    battleTarget,
    battleTerrain,
    battleDefenderArId,
    battleDefenders,
    // C5 移动交互
    moveInteraction,
    moveLinger,
    dismissMoveLinger,
    moveUnits,
    activeMoveUnits,
    moveBudgetRows,
    selectedAvailableMa,
    groupReachable,
    // G1：零高亮时的原因（面板与地图提示同源，避免两处各写一句话）
    movePickBlockNote,
    stepPreview,
    hoverNode,
    hoverPreviewAt,
    hoverHex,
    stackSelect,
    // C5 堆叠取子（6.1f / 8.1g / 8.1h）
    movePick,
    // 5.4a：预备额度按格派生（同格已有预备单位 ⇒ 不额外占；界面/测试读它核对占用）
    reservedHexes,
    // 5.4a：预备标记存量（显示与转入闸门同源，避免各存一份计数）
    reserveMarkerStatusOf,
    // 专规 1.5 / 剧本 1–2：首回合苏军地面单位 ×1/2（界面额度显示与引擎同一口径）
    sovietFirstTurnMaFactor,
    movePickHex,
    movePickChoices,
    toggleMovePick,
    setMovePickIds,
    setMovePickOnly,
    beginMovePick,
    setMovePickAll,
    defaultMovePickIdsAt,
    cancelMovePick,
    confirmMovePick,
    moveBlocked,
    fuelPool,
    moveRuntime,
    selectedUnit,
    choices,
    moveContext,
    selectedLegality,
    switchSide,
    setActiveSide,
    setPhase,
    setTurn,
    // B9：本环节可参与的算子（灰显/待办计数）与地图内就地提示
    participatingUnitIds,
    participatingUnitCount,
    mapHint,
    // B8：环节进度与统一闸门（界面查表；不参与环节的动作一律拒绝）
    segmentStep,
    // D1：移动环节判定（地图单击据此决定「取子开拔」还是「只读查看」）
    movementStepNow,
    // 用户 2026-11-18：可走格唯一闸门（初设 / A 整备不投；只投移动环节）
    moveRangeDisplayLive,
    segmentSteps,
    playerSegmentSteps,
    segmentStepPosition,
    segmentStepIndex,
    setSegmentStepIndex,
    stepToNextSegmentStep,
    requireAction,
    actionAllowedNow,
    segmentActionKeys,
    segmentGateQuery,
    segmentDriver,
    segmentIn,
    actionRefusal,
    // B5：唯一「进入下一环节」（自动段连跑完，停到需要玩家的地方）
    advanceSegmentNow,
    answerQuestionNow,
    // 只读闸门解释：**最近一次点击**为何没推进（流程条就地显示；不用于置灰）
    advanceBlock: advanceBlocked,
    currentAdvanceBlock: computed(() => segmentAdvanceBlock()),
    // 4.8a：环节/阶段末超堆叠义务与摧毁入口（唯一入口；无「忽略」旁路）
    overstackDuties,
    overstackPicks,
    overstackRemainingRe,
    overstackSettled,
    toggleOverstackPick,
    destroyOverstackPicksNow,
    hasSpecialReplDraw,
    markSpecialReplDraw,
    pickRecord,
    setTool,
    /**
     * 2.2 流程表**段**的中文名（只读常量表）
     *
     * 暴露给流程条（E5）：未开局时 `gameSession.records?.phase` 不存在，
     * 界面要与「环节」行同源 ⇒ 需要把 `phase`（ConsolePhase）翻成段名。
     * 只**读**，不含任何回退口径（回退仍是 `phase` 自己的事）。
     */
    PHASE_LABELS,
    combatPickActive,
    placeAt,
    removeAt,
    clickHex,
    // 2026-11-18：拖拽落子（沿玩家实际路径逐步判通行；与点击同一套判据）
    moveAlongDraggedPath,
    // 用户 2026-11-18：拖动中的路径预览（只读；画布据此决定终点画不画）
    previewDraggedPath,
    // 用户 2026-11-10：地图上点**某一枚** ⇒ 只选这一枚（`only`），整格全选走"点格内空白"
    selectForMove,
    // C5 动作
    setHoverHex,
    setStackSelect,
    undoLastStep,
    undoTransportHandlingNow,
    cancelWholeMove,
    // 用户 2026-11-20：全局共用撤销（同一 action / 最近一笔可撤操作；掷骰按笔封账）
    undoLastOperationNow,
    canUndoOperation,
    undoOperationLabel,
    /** 供各族登记 / 销账 / 注册撤销实现（setup 等兄弟 store 使用） */
    noteUndoable,
    dropUndoOf,
    registerUndoFamily,
    // K5：撤销一步的可用性（判据在 ground-movement，与 refuseRollback 同源）
    canUndoStep: groundMovement.canUndoStep,
    undoBlockedReason: groundMovement.undoBlockedReason,
    // 用户 2026-11-18：本段掷骰封印（非 null ⇒ 一切撤销入口都不出现）
    undoSealedReason,
    sealUndoNow: sealUndo,
    // 用户 2026-11-13 批：「放弃本次移动」不可用时按钮不出现（Esc 仍走 finishMove 收束退出）
    canAbortMove: groundMovement.canAbortMove,
    // B15a：放弃本次移动**并退出移动态**（会话框的取消 / Esc）
    abortMoveNow,
    finishMove,
    // 用户 2026-11-18：结束后关窗只收会话，不动盘面
    dismissFinishedMoveNow,
    pauseTransportMove,
    // 6.1f：把某枚从正在移动的堆叠里放下（就地停住，其余继续）
    dropUnitFromMove,
    switchUnitMode,
    // 5.4a：右键「模式改变」子菜单只列此刻真正能切过去的模式（与 switchUnitMode 同判据、不写日志）
    switchableModesOf,
    // IV-B：初设阶段为单位/堆叠设定模式（combat / move / reserve / strat）
    setUnitModeAtSetup,
    // IV-B：初设右键「初设模式」只列此刻真正能设的模式（与 setUnitModeAtSetup 同判据）
    setupSwitchableModesOf,
    // IV-B：一个模式都出不来时就地给原因（不摆空菜单）
    setupModeBlockNote,
    noteSetupModeBlocked,
    setupReserveSummary,
    eliminateEntry,
    beginMoveFor,
    flipUnitOrientation,
    // 5.7b：E/G 段释放预备（把预备标记摘掉，回朝向面）
    releaseReserveNow,
    // 5.7b：释放预备的只读投影（右键「转出预备模式」只在它为真时出现）
    canReleaseReserveOf,
    // 用户 2026-11-18：移动环节内的预备换面 / 取消预备（不是 5.7b 转出）
    switchReserveFaceNow,
    cancelReserveModeNow,
    canEditReserveModeOf,
    payFuel,
    setFuelPool,
    fuelDumpId,
    fuelSourcePartition,
    fuelMethod,
    // 12.5c（用户 2026-09-17）：点谁就决定能点哪一法（可用性 + 原因）
    fuelMethodChoices,
    // 12.5e：HQ 法的投递基点台账（本阶段每指挥部最多一个位置；清理阶段/换回合清空）
    hqFuelThrows,
    formationFuelThrows,
    formationFuelThrowOf,
    fuelFormationCoverage,
    hqFuelThrowOriginOf,
    fuelMethodEffective,
    fuelDumpChoices,
    fuelPayNeedT,
    fuelTargets,
    // 用户 2026-11-10：加油唯一入口＝右键该单位/堆叠（只列真正可用的 12.5c 方法）
    fuelSubjectId,
    fuelMethodsForUnitNow,
    openFuelNow,
    closeFuelNow,
    fuelMethodLabel,
    // B18b：12.5a「耗油且未加注」的单位与"此刻该付油了吗"（地图据此展开燃料段）
    fuelPendingUnits,
    fuelPaymentDue,
    // B18c（12.0）：受补给单位的候选（只有战斗单位需要追溯补给）
    supplyCheckCandidates,
    fuelDump,
    pickFuelDump,
    barrageSupplyDumpId,
    barrageSupplyDumpChoices,
    // G②（10.1b-A）：这批来源里哪些是经 HQ 投递达成的（付款时据此声明"来自同一指挥部"）
    barrageSupplyHqChoices,
    barrageSupplyDump,
    // 21.10：本次实扣的 Shells/浪费（撤销时据此原数退回）
    barragePaidSupply,
    // 21.10：Shells 计划枚数 / 额度 / 预览（抵付、浪费、缺口、降档列）
    barrageShellMarkers,
    barragePayNeedT,
    barrageShellBudgetT,
    barrageShellPreview,
    pickBarrageSupplyDump,
    // B14b：阵列里「点同一座站即取消」（旧下拉的"未声明"空档的替代）
    toggleBarrageSupplyDump,
    setUnitFuelled,
    lockZocNegation,
    canLockZocNegationNow,
    openBattle,
    resolveBattleNow,
    terrainChoicesAt,
    // C6 战斗交互
    battleMode,
    combatAttackerIds,
    combatState,
    combatError,
    combatErrorLine,
    combatInputs,
    combatAwaitingShiftDie,
    combatSurpriseDie,
    combatAttackers,
    combatDefenderSide,
    combatAttackerViews,
    combatDefenderViews,
    combatFacts,
    combatChecklist,
    combatResolver,
    combatRequirement,
    combatOptionLossTargets,
    optionDraftPoints,
    optionDraftUsed,
    optionDraftRemaining,
    optionDraftEntries,
    optionRetreatUnits,
    combatOptionRetreatWarning,
    attackerWipedNow,
    optionIgnoreAvailableNow,
    confirmCombatIgnoreOptions,
    applyOptionDraftLoss,
    canTakeOptionLossPoint,
    applyOptionDraftRetreat,
    applyOptionDraftRetreatFor,
    undoOptionDraftLast,
    resetOptionDraft,
    combatCanonicalLosses,
    // 批 F 切片 2（9.11a）：拥有者可以把"多受的那一点"改派给谁（候选与提交分配的唯一出处）
    combatLossSwapChoices,
    combatLossAllocationNow,
    combatSummary,
    combatReview,
    combatAttackerArOptions,
    combatDefenderArOptions,
    combatDefenderArChoices,
    nkvdArRequiredNow,
    overrunParticipantIds,
    toggleOverrunParticipant,
    overrunLeftBehindNotice,
    overrunSplitNow,
    combatDefenderTerrainOptions,
    combatStackTerrainOptions,
    defaultArUnitIdOf,
    autoResolveCombatToOutcome,
    combatLiveStep,
    // C8：补给已提交 ⇒ 存档/读档被 settlementBlockedReason 拒绝，面板据此全程提示
    combatSupplyCommitted,
    combatAdvanceMandatory,
    combatRetreatRequirement,
    combatDefendingHexCleared,
    combatAdvanceCandidates,
    // B14c：战后推进的算子图阵列（9.12g-A / 9.12b 两条否决转成人话）
    combatAdvanceChoices,
    // W7 C16：战斗收尾的地图优先交互（9.12 撤退落点 / 9.12g 推进格 / 12.4 补给站）
    combatAdvanceHex,
    combatRetreatPlans,
    // 9.12e：撤退堆叠额外损失的承受者候选（与确认共用一份引擎预演）
    combatExtraLossPreview,
    chooseExtraLossTaker,
    // 9.12：点名要撤退、但该方已无存活参战单位（计划的空行反例）
    combatRetreatSkippedSides,
    // W7 C16 + 9.12d：跟随撤退（未参战战斗单位 / 编内卡车）
    combatTagalongIds,
    combatTagalongCandidates,
    toggleCombatTagalong,
    combatSupplyDumps,
    combatSupplyNeedT,
    combatSupplyDumpIds,
    combatSupplyDumpPicks,
    setRetreatDestinationNow,
    advanceNow,
    clearAdvanceNow,
    toggleAdvanceUnit,
    pickCombatSupplyDump,
    setBattleMode,
    clearCombat,
    toggleCombatAttacker,
    // B15b：地图摊开的选择集 → 战斗的参与集合（§4.2 的"选择集＝参与集合"）
    syncCombatParticipants,
    toggleCombatSupplyAttacker,
    selectCombatDefenderHex,
    beginCombatNow,
    confirmCombatSupply,
    confirmCombatSupplySide,
    combatAttackerStocksApplicable,
    combatDefenderStocksApplicable,
    declareCombatArStep,
    declareCombatTerrainStep,
    rollCombatSurprise,
    rollCombatShiftDie,
    rollCombatDice,
    confirmCombatLosses,
    confirmCombatOptions,
    confirmCombatRetreats,
    confirmCombatAdvance,
    cancelCombat,
    // P3 / UI3：会话「域拒绝」的唯一只读判据（与 cancelCombat 同源）
    combatCancelBlocker,
    // W7 C16：移动中的突袭（8.0/8.1）
    overrunContext,
    moveStackHex,
    // 4.5a-A（第六批条 14）：停车 ≠ 丧失突袭资格 ⇒ 这两个是突袭候选的唯一来源
    overrunCandidateUnits,
    overrunStackHex,
    moveMinRemainingMp,
    overrunTargets,
    overrunTargetHexes,
    // 9.2 / 10.0：结算进行中 ⇒ 任何单位都不得移动（第六批 BUG ②）
    settlementInProgress,
    combatAttackableHexes,
    overrunNow,
    overrunZocHeld,
    overrunZocHeldUnitIds,
    settleOverrunMove,
    // C7 轰炸交互
    barrageActive,
    barrageKind,
    barrageTargetKind,
    barrageLossTargets,
    barrageAircraftRollTargets,
    barrageUnitIds,
    barrageState,
    hexPickView,
    // 批 E 切片 2：B27 的通用待点格入口**开放给别的 store**（`containers` 的"西移落点"要用它）
    beginHexPick,
    hexPickHint,
    cancelHexPick,
    pickHexFor,
    beginArrivalHexPickNow,
    beginArrivalPlacePickNow,
    withdrawArrivalNow,
    beginHedgehogHexPickNow,
    beginSpDumpHexPickNow,
    beginSupplySourceHexPickNow,
    beginRailMoveHexPickNow,
    beginAirPlacementHexPickNow,
    beginAirTransferHexPickNow,
    beginAirTargetHexPickNow,
    autoResolveAirMissionNow,
    // 批 C 切片 1：选任务类型即"宣布 + 自动结算到停返航"（一次动作，不再两次确认）
    runAirMissionNow,
    beginAirReturnBasePickNow,
    chooseAirReturnDepartureNow,
    chooseAirReturnOffMapBoxNow,
    airReturnSelectionLabel,
    airReturnChosen,
    beginAirBaseHexPickNow,
    // B27b：最后 6 处"格子编号" → 点地图（值在 store，组件只绑字段）
    rebuildReplHexText,
    convertTargetHexText,
    railGaugeTargetHexText,
    cityControlHexText,
    formationMarkerHexText,
    deadPileReturnHexText,
    beginRebuildReplHexPickNow,
    deadPilePickId,
    pickDeadPileUnitNow,
    deadPileRebuildBlockedReason,
    deadPileActionsOf,
    beginConvertTargetHexPickNow,
    beginRailGaugeTargetHexPickNow,
    beginCityControlHexPickNow,
    beginFormationMarkerHexPickNow,
    beginDeadPileReturnHexPickNow,
    barrageError,
    // 用户 2026-11-12：错误提示中文化（面板不再显示引擎 reason 代码）
    barrageErrorLine,
    barrageInputs,
    // A 组接线：10.0e-A/B 的按阶段轰炸账本（界面显示"本阶段已轰炸 N 格 / M 单位"）
    barragePhaseLedger,
    // 批 A 切片 3：9.1c 的按**环节**攻击账本（界面显示"本环节已攻击 N 单位 / M 格"）
    attackPhaseLedger,
    barrageAwaitingHalfDie,
    barrageUnits,
    // B14b：参炸单位 / 参炸飞机的算子图阵列（含逐枚灰显原因）
    barrageUnitChoices,
    // 条 13：炮击阵列按本次作用域收窄后的视图（判据仍是 `barrageUnitChoices`）
    barrageVisibleChoices,
    barrageAirChoices,
    barrageTargetHex,
    barrageTargetFacts,
    barrageTargetKindIssue,
    // 10.0d / 10.0c：该格可宣布的整体目标（炮击第 1 步的选项）
    barrageTargetKindChoicesAt,
    barrageChecklist,
    barrageTerrainLineOptions,
    barrageSummary,
    barrageRequiresDefenderInput,
    // C7 空军（10.2b 短程加成的数据源）
    airUnits,
    airBoxMembers,
    onMapAirUnits,
    setAirInBoxMembership,
    clearAirBoxMembers,
    barrageAirIds,
    airPlacement,
    airUnitChoices,
    barrageAirCandidates,
    barrageAirUnits,
    barrageAirFacts,
    setBarrageActive,
    // 批 A 切片 2：环节驱动的分派事实（界面只读）
    barrageKindsInSegment,
    barrageSelectionAllowedNow,
    isBarrageSegment,
    setBarrageKind,
    setBarrageTargetKind,
    toggleBarrageUnit,
    // B15c：地图摊开的选择集 → 参炸名单 / 退掉尚未宣布的选子（§4.2 + §4.3）
    syncBarrageParticipants,
    clearBarrageSelectionNow,
    addAirUnit,
    removeAirUnit,
    // 14.1b：空军军力损失（归零即与地面单位**共用同一个死亡堆**）
    applyAirStepLoss,
    toggleBarrageAirUnit,
    beginBarrageNow,
    confirmBarrageSupplyStep,
    confirmBarrageShiftsStep,
    rollBarrageDiceStep,
    confirmBarrageOutcomeStep,
    cancelBarrage,
    // 用户 2026-11-12：炮击链路重做（一步式入口 / 自动结算 / 退款 / 受损选择 / 设施炮击）
    prepareOpsBarrage,
    defaultBarrageTargetKindAt,
    runBarrageResolution,
    refundBarrageSupply,
    cancelOpsBarrage,
    barrageSupplyMapDumps,
    barrageLossRequired,
    barrageLossAllocated,
    barrageLossPointsOf,
    addBarrageLossPoint,
    removeBarrageLossPoint,
    barrageLossReady,
    confirmBarrageLossNow,
    // P3 / UI3：会话「域拒绝」的唯一只读判据（与 canReplaceBarrage 同源）
    barrageCancelBlocker,
    clearBarrage,
    targetKindLabel,
    // C8 补给交互与 SP 管理
    supplyActive,
    carriedSpDumps,
    allSpDumps,
    spDumps,
    spDumpsOfSide,
    offMapSupplyStocks,
    supplySourceDecls,
    supplyUnitId,
    supplyUnit,
    supplyState,
    supplyError,
    supplyInputs,
    supplyPreviewIndex,
    supplyChecklist,
    supplySources,
    supplyFocusSource,
    supplyCoverageHexes,
    supplyPayDumpCandidates, // B14d：阵列里「点同一座付款站即回到自动」
    toggleSupplyPayDump,
    supplyOosPayDump,
    supplySummary,
    // 批 B 切片 2（12.3 用途落地 / 裁定⑤「获取即付款」）：本次应付多少 T 及其费率出处
    supplyPickupRequirement,
    supplyFacts,
    spDumpDraft,
    supplySourceDraft,
    setSupplyActive,
    clearSupply,
    addSpDump,
    setSpDumpDraftGroup,
    removeSpDump,
    landSetupSpDumps,
    clearSpDumps,
    setSpDumpHoldings,
    mergeSpDumpHoldings,
    splitSpDumpHoldings,
    addSupplySource,
    removeSupplySource,
    setSupplyPreview,
    beginSupplyCheckNow,
    chooseSupplySourceNow,
    supplyPickSourceHints,
    supplySourceGroups,
    pickSupplySourceAtHexNow,
    confirmSupplyPickupNow,
    confirmOosResolutionNow,
    cancelSupply,
    // 12.6 / 12.8：全场追溯补给判定（让断补的减半/无 ZOC/突围资格/图标真正全场生效）
    evaluateTraceSupplyNow,
    /** 12.6：本回合唯一判定入口落盘的快照（界面计数与逐单位检查共读，不再读计划表长度） */
    traceSettlement,
    /** 12.6：实时补给线（只读；界面提示与 12.8e 突围资格共用） */
    liveTraceLineOf,
    /** 12.6：实时线与标记不一致时的一行文字提示（不写标记、不染地图色） */
    supplyLineHintOf,
    // C8b：D 段**补给阶段总计划**（12.1–12.2 / 12.6 / 12.8 / 12.10e / 12.11a）
    supplyPhasePlan,
    supplyPhaseInputs,
    supplyPhaseError,
    supplyPhaseAvailableCap,
    supplyFeedingCandidates,
    planSupplyPhaseNow,
    clearSupplyPhasePlan,
    applySupplyPhaseRecoveryNow,
    applySupplyPhaseFeedingNow,
    dumpDestructionAttempts,
    destructDumpNow,
    // 12.8b：断补堆叠的损耗掷骰与分摊
    attritionInputs,
    attritionResults,
    attritionNeedsAllocation,
    setAttritionDie,
    setAttritionAllocation,
    rollAttritionNow,
    applyAttritionNow,
    unitNameOf,
    // 13.2c：运输点数的合并 / 拆分（含编内卡车不得与常规点数合并的限制）
    transportPointsOfSide,
    transportPointGroupsOfSide,
    transportPointInputs,
    toggleTransportMerge,
    mergeTransportPointsNow,
    splitTransportPointNow,
    // 12.7：延补队 ⇄ 运输点数的双向转换
    convertTransportToExtenderNow,
    flipExtenderToTransport,
    // 9.14d：移动阶段的**主动**崩溃（替代常规移动）
    collapseExtenderNow,
    // 16.0b/c：环形工事的修建与缩减（＋专规 1.3a 印刷工事查询）
    hedgehogInputs,
    hedgehogExecutorMode,
    hedgehogEngineerId,
    hedgehogUsesEngineerRoute,
    hedgehogTargetHex,
    hedgehogEngineer,
    hedgehogEngineerLegRange,
    pickedHedgehogEngineer,
    hedgehogError,
    hedgehogTurnLedger,
    hedgehogLevelOf,
    isPrintedHedgehogAt,
    printedHedgehogPositions,
    buildHedgehogNow,
    reduceHedgehogNow,
    hedgehogPayDumps,
    hedgehogPayPick,
    toggleHedgehogPayPick,
    pickHedgehogPayDumpNow,
    // 15.3 / 15.2A：空军基地与简易机场的修建、升格（13.8d 施工前提一并接上）
    constructionInputs,
    constructionError,
    constructionPayDumps,
    constructionPayPick,
    toggleConstructionPayPick,
    pickConstructionPayDumpNow,
    constructionLedgerOf,
    airBaseTurnLedger,
    // 14.9f / 15.0b-C：本环节各格已空运卸载的 T（界面据此显示还剩多少额度）
    airUnloadLedger,
    airUnloadedTAt,
    engineerChoices,
    canEngineerInPhase,
    airBaseLevelAt,
    airBaseUnitAt,
    airBaseBuildCostSpPerLevel,
    isAirstripAt,
    hexHasAirFacility,
    constructionLegRangeTo,
    constructionGateNow,
    buildAirBaseNow,
    buildAirstripNow,
    upgradeAirstripNow,
    supplySourceKindLabel,
    supplySourceLabel,
    supplyStatusLabel,
    // C9 空军交互
    airActive,
    beginAirBarrageNow,
    airMissionKind,
    airCargoUnitChoices,
    // B44（14.9e）：逐机档位与"是否有 A 档"（14.9f 的例外据此自动成立）
    airTransportProfiles,
    airOverLimitAircraftInactive,
    // B47（12.8e）：突围候选 / 宣布突围 / 返场落位
    breakoutCandidates,
    // B47（12.8e）：突围骰值输入（裁判订正 / 复算用）
    breakoutInputs,
    breakoutNow,
    breakoutReturns,
    deployBreakoutReturnNow,
    toggleAirCargoUnit,
    airCombatAttackerPlanes,
    airCombatDefenderPlanes,
    airCombatRoundBudget,
    airInterceptionDefender,
    airTargetHex,
    airMissionAirIds,
    airState,
    airError,
    airErrorLine,
    airInputs,
    airBases,
    ownAirBases,
    allAirViews,
    ownAirUnits,
    airMissionAirUnits,
    airMissionHasFighter,
    airMissionReturnOrigins,
    airMissionReturnChoices,
    airChecklist,
    airTargetInEnemyPatrolZone,
    airTargetBaseLevel,
    airEnemyAtTarget,
    capturableEnemyAirBases,
    airInterceptionResponse,
    airInterceptorCandidates,
    airPatrolZoneHexes,
    airEnemyPatrolZoneHexes,
    airInactiveAtBase,
    airRefitPayDumps,
    // 15.1 整备交互（点基地 → 勾飞机 → 点地图上的补给付款）
    refitBase,
    refitCandidates,
    refitStartBases,
    refitAirbaseHexes,
    refitBlockReasonAt,
    refitSelectedIds,
    refitSelectLimit,
    refitPayDumps,
    refitPayNeedT,
    refitStage,
    // 14.11 转场
    transferBase,
    transferMode,
    transferFromBox,
    transferCandidates,
    transferSelectedIds,
    transferBoxReady,
    transferBaseCandidates,
    transferHasBoxOption,
    transferHasBaseOption,
    canTransferAirToBaseNow,
    beginTransferNow,
    toggleTransferAircraft,
    cancelTransferNow,
    completeTransferToBaseNow,
    airReductionCandidates,
    railSupply,
    railSupplyBySide,
    railSupplyFacts,
    entryRailSeedsBySide,
    detrainableHexes,
    // 批 F 切片 3：到货 SP 的落点（专规 2.1 / 3.1 免费铁运 + 3.6 补给列车）
    freeRailCityHexes,
    freeRailCityCandidates,
    freeRailPicked,
    toggleFreeRailPick,
    freeRailEdgeHex,
    pickFreeRailEdgeHex,
    beginFreeRailEdgeHexPickNow,
    // 图边补给源格（2.1 / 3.1）：到货余额的落点候选，也是 1.1b 安全边缘格的来源
    scenarioSupplySourceHexes,
    openSupplySourceHexes,
    supplyArrivalSp,
    supplyTrainSp,
    supplyTrainHex,
    pickSupplyTrainHex,
    freeRailPlan,
    freeRailError,
    lastFreeRailPlan,
    applySupplyArrivalsNow,
    arrivalSpGroups,
    arrivalSpGroupTargets,
    setArrivalSpGroup,
    clearArrivalSpGroups,
    // 专规 3.6：补给列车高亮落点 + 点格落 2 SP（不做列车算子）
    supplyTrainPending,
    supplyTrainPlacementHexes,
    supplyTrainGroup,
    setSupplyTrainGroup,
    beginSupplyTrainHexPickNow,
    placeSupplyTrainSpNow,
    resetSupplyTrainPlacement,
    // C9b：轨距账本（13.3f / 专规 1.2）——「谁能用这条铁路」，与 13.3a 多轨的运量费用无关
    convertedRailHexes,
    printedRailGauge,
    convertedRailGauge,
    railGaugeAt,
    isRailGaugeUsableAt,
    seedConvertedRailsNow,
    clearConvertedRailsNow,
    // 13.3d：铁路端头标记（`mk-38`；地图事实层）
    railheadMarkers,
    railMoveError,
    railMoveInputs,
    railCapSpentThisTurn,
    railCapRemaining,
    spendRailCapacity,
    railCapUsedBy,
    railMoveFacts,
    railPathBetween,
    railMoveNow,
    lastRailMove,
    // 裁定 3：铁路运输通用流程（点目的地 → 待确认 → 确认/撤回）
    pendingRailTransport,
    confirmRailTransportNow,
    cancelRailTransportNow,
    arrivalRailUndo,
    undoArrivalRailNow,
    // 13.6b：增援铁路运输
    arrivalRailEligible,
    arrivalRailOriginsOf,
    beginArrivalRailPickNow,
    // 裁定 2：图外空军盒 SP（1.6b 补给只能空运）
    depositOffMapSupplyNow,
    airBoxSupply,
    railMovedUnitIdsThisPhase,
    // 13.2f：运输点数的装载 / 卸载
    transportLoadInputs,
    transportLoadError,
    transportPointActorOf,
    loadTransportPointNow,
    unloadTransportPointNow,
    transportLoadReadyAt,
    transportUnloadReadyAt,
    transportHandlingReadyAt,
    transportHandlingUndo,
    transportLoadableSpOf,
    transportUnloadableSpOf,
    transportDumpsOf,
    selectTransportLoadPointNow,
    convertRailGaugeNow,
    gaugeConversionsThisPhase,
    // 13.3g-A：本阶段"刚换过轨的格"与"走过这些格的铁路修理单位"（"不能接力"的判据来源）
    convertedHexesThisPhase,
    railMovedNewTrackThisPhase,
    isRailRepairUnit,
    railRepairUnits,
    minimalFuelingOn,
    isBarrageCapableUnit,
    segmentLabelsOfAction,
    refitDoneBases,
    reducedBases,
    airstripBaseIds,
    lastRefit,
    lastTransfer,
    lastReduction,
    setAirActive,
    clearAir,
    setAirMissionKind,
    setAirTargetFromText,
    toggleAirMissionUnit,
    voluntaryReturnNow,
    airMissionSegment,
    airJoinRemaining,
    // B14：参战机的算子图阵列（逐机可选性 + 原因）
    airMissionJoinChoices,
    airMissionTargetCandidates,
    canAirMissionTarget,
    // 用户 2026-11-09：轰炸/低空扫射按基地分栏的驻机名册与距离（点基地高亮）
    airMissionBaseGroups,
    airMissionBaseFocus,
    focusAirMissionBase,
    anyOwnAircraftReaches,
    hipShootEntryEligible,
    // 三操作统一流程（2026-11-10）：入口判据与窗内候选同源
    barrageEntryEligible,
    barrageEntryBlockReason,
    noteBarrageBlocked,
    barrageTargetsNow,
    bombingEntryEligible,
    barrageCandidatesAt,
    bombingCandidatesAt,
    hipShootCandidatesAt,
    airMissionBaseGroupsWithBox,
    pickBarrageTargetAt,
    toggleAirReductionUnit,
    missionSegmentOf,
    airTargetBaseIsAirstrip,
    toggleAirUnitStatus,
    beginAirMissionNow,
    confirmAirCombatNow,
    airUnitsAt,
    declareInterceptionNow,
    resolveInterceptionCombatNow,
    resolveFlakNow,
    resolveAirCargoNow,
    airCargoUnloadReceipt,
    airCargoUnloadChoices,
    airSupplyManifest,
    airUnitCargoManifest,
    // 14.4g：防空致容量变化后的货物损失（重算容量 / 勾选摧毁 / 落盘）
    airMissionCargoCapacityNow,
    airCargoLossPending,
    airCargoLossPicked,
    toggleAirCargoLossPick,
    confirmAirCargoLossNow,
    captureAirBaseNow,
    // 9.14：特殊战斗（夺取表 9.14b/c、延补队 9.14d、工事 9.14e、基地 9.14f）
    specialPending,
    specialObjectsAt,
    printedHedgehogOwnerAt,
    resolveSpecialCombatAt,
    toggleSpecialCaptured,
    setSpecialDisplacement,
    confirmSpecialCombatNow,
    cancelSpecialCombatNow,
    confirmAirMissionNow,
    settleAirMissionNow,
    completeAirReturnNow,
    cancelAir,
    toggleAirstripBase,
    refitBaseNow,
    beginRefitNow,
    confirmRefitSelectionNow,
    confirmRefitPaymentNow,
    toggleRefitAircraft,
    cancelRefitNow,
    pickRefitPayDump,
    transferAircraftNow,
    reduceBaseNow,
    airMissionKindLabel,
    airMissionKindChoices,
    airStatusLabel,
    // W6 B18：到达、补员与编制调整
    scenarioId,
    replHoldings,
    deadPile,
    removedForever,
    breakdownPool,
    returnFromDeadPileNow,
    variableReplInputs,
    variableExitResolved,
    variableExitStartRolled,
    rollVariableExitAtStartNow,
    variableExitOpen,
    variableExitForActiveSide,
    variableReplRolled,
    specialReplDue,
    replTableAckReady,
    reinforcementAcks,
    acknowledgeReinforcementStepNow,
    endArrivalSegmentNow,
    endSlowMobilizationSegmentNow,
    endRollSegmentNow,
    rollHandPending,
    rollHandPoints,
    // v7.1 第二段：判定阶段闸门 + 统一手牌（用户 2026-11-11 口径）
    rollPlacementOpen,
    rollPlacementBlockedReason,
    rollHandEntries,
    beginRollHandEntryNow,
    registerSpecialReplReturns,
    specialReplPending,
    specialReplPlacedThisSegment,
    beginSpecialReplPlaceHexPickNow,
    withdrawSpecialReplReturnNow,
    frontalUnitPending,
    frontalUnitPlacedThisSegment,
    beginFrontalUnitPlaceHexPickNow,
    withdrawFrontalUnitNow,
    frontalReservesSpPending,
    supplyTableUnplaced,
    beginSupplyArrivalSpHexPickNow,
    reinforcementSegment,
    arrivalAbandoned,
    arrivalSegmentClosed,
    // ⑦ 3.3c：撤离落盘与"可选单位清单"（待选状态从 session.log 反推，无存档字段）
    variableExitPendingSelection,
    variableExitSelectionOpen,
    variableExitSelectionSet,
    variableExitPickItems,
    variableExitPickHexes,
    confirmVariableExitSubstitute,
    setVariableExitHover,
    isSavableRepl,
    breakdownAbsorbObligations,
    /*
     * 20.0a：该单位此刻处在哪个创建时机（null＝不在 20.0a 的三个时机里）
     *
     * 只读投影：给「拆分单位盒取用」（`containers.takeBreakdown`）与面板的可用性判断用。
     * **不导出写入口**（`openBreakdownWindow`）——时机只能由真实事件开窗
     * （开始移动 / 战后推进 / 战后撤退），调用方不许自称"现在可以拆"。
     */
    breakdownTimingOf,
    /*
     * 20.0 / 20.0a–d：入口与候选的只读投影（右键菜单与拆分面板共用同一批判据）
     *
     * `canCreateBreakdownNow` 是「创建拆分单位」是否出现的唯一判据；
     * `breakdownRecordChoicesFor` / `breakdownAbsorbChoicesFor` 是面板下拉的唯一数据源。
     */
    canCreateBreakdownNow,
    breakdownRecordChoicesFor,
    breakdownAbsorbChoicesFor,
    canAbsorbBreakdownNow,
    // 专规 4.3（可选）Setup Wiggle
    setupWiggleOn,
    setupWiggleParents,
    setupWiggleRemaining,
    setupBreakdownCandidates,
    assessTurnEndVictoryNow,
    turnEndVictory,
    controlOfHex,
    isBreakdownRecord,
    nationalityOfUnit,
    settleAbsorbObligationsNow,
    lastVariableRepl,
    variableReplSpecialDie,
    offMapRollDeposit,
    lastRebuild,
    lastConsolidation,
    lastBreakdown,
    reinforcementError,
    genericReinforcementError,
    arrivalPlan,
    arrivalPlacements,
    replArrivalPlacement,
    arrivalCandidates,
    arrivalPlaced,
    arrivalPlacedUnits,
    arrivalRemainingOf,
    arrivalAirBoxAvailable,
    arrivalAllPlaced,
    arrivalUnitsDone,
    arrivalHandPending,
    arrivalRemovalsPending,
    arrivalRecordOf,
    matchArrivalRecord,
    resolveArrivalFormation,
    ownUnitsOnMap,
    rebuildCandidates,
    rebuildCandidateHexes,
    combatNkvdDefenders,
    combatNkvdForcedLosses,
    setScenarioId,
    setArrivalHexOverride,
    setReplHoldingsNow,
    placePendingReplNow,
    placePendingReplOneNow,
    replPlacedThisSegment,
    withdrawReplPlacementNow,
    beginReplPlaceHexPickNow,
    replInitialPlacementHexes,
    replInitialPlacementHexesFor,
    rebuildReplPlacementHexes,
    replPlacementBlockedReason,
    replPlacementBlockedReasonFor,
    replCountsAtHex,
    replPending,
    clearNonSavableReplNow,
    rollVariableReplNow,
    placeArrivalNow,
    placeArrivalInAirBoxNow,
    applyArrivalRemovalsNow,
    sendToDeadPileNow,
    removeForeverNow,
    rebuildUnitNow,
    endRebuildSegmentNow,
    withdrawRebuildNow,
    withdrawRebuildAtHexNow,
    rebuildPlacedThisSegment,
    beginDeadPileRebuildNow,
    deadPileRebuildUnitsAt,
    rebuildDeadPileAtHexNow,
    beginAirRebuildBasePickNow,
    rebuildAircraftIntoBoxNow,
    canRebuildAircraftIntoBoxNow,
    canRebuildOnMapNow,
    rebuildOnMapUnitNow,
    airRebuildBaseHexes,
    rebuildLegalHexes,
    rebuildFreeHint,
    boardReplTotals,
    runDeadPileActionNow,
    canConsolidateSelectionNow,
    consolidateSelectionNow,
    consolidateUnitsNow,
    rebuildPickUnitId,
    rebuildPickRow,
    rebuildSuggestedRow,
    selectRebuildUnitNow,
    mergePartnerAt,
    mergePartnerIds,
    consolidationAvailable,
    consolidationPick,
    openConsolidationPickNow,
    clearConsolidationPick,
    consolidationKeepUnits,
    mergeRemoveUnits,
    needsFuelNow,
    consolidateAircraftNow,
    setBreakdownPoolNow,
    createBreakdownNow,
    absorbBreakdownNow,
    setUnitLockedNow,
    unlockSlowMobilizationNow,
    unlockSlowMobilizationBatch,
    slowMobilizationLockedOf,
    slowMobilizationVisible,
    slowMobilizationQuotaOf,
    slowMobilizationRequiredOf,
    slowMobilizationOutstanding,
    slowMobilizationUnlockedAt,
    // 专规 2.3c：方面军预备队（＋1.6c 特殊补员的可用期提示）
    frontalReservesToday,
    frontalReservesClaimed,
    frontalReservesError,
    lastFrontalReserves,
    claimFrontalReservesNow,
    conversionRecordFor,
    // W6 B19：Smolensk 专规机制
    panzerGroupBoundary,
    // 批 F 切片 1：带多轨铁路折线的分界线（判据与渲染共用；初设的默认归属也读它）
    panzerGroupBoundaryWithPath,
    panzerBoundaryPath,
    orshaHex,
    panzerGroupUnitViews,
    panzerGroupObligations,
    panzerObligationActive,
    panzerDgChoiceObligations,
    settlePanzerGroupDgAtPhaseEnd,
    exclusiveAutoOpen,
    applyPanzerGroupDgNow,
    panzerWrongSideHexes,
    boundaryView,
    exclusiveActionsInStep,
    exclusiveSectionPins,
    exclusiveSectionsNow,
    panzerGroupAssignments,
    groupOfUnit,
    spDumpPanzerGroups,
    panzerGroupOfDump,
    setDumpPanzerGroupNow,
    panzerGroupUnassignedDumps,
    // 3.4b：随运输队入场的 SP（非编队）入场前必须选集群
    transportSpGroupDraft,
    setTransportSpGroupDraftNow,
    arrivalTransportSpNeedsGroup,
    pendingSpGroupAssignment,
    panzerGroupRulesOn,
    panzerGroupSpGate,
    panzerGroupSpRefusal,
    panzerGroupAssignedCount,
    multiUnitFormationIds,
    supplyTableSpInput,
    panzerGroupSpSplit,
    supplyCacheHoldings,
    lastSupplyCacheUse,
    constructionMarkers,
    constructionMarkerPieces,
    constructionMarkerHexText,
    // 批 D 切片 2（专规 3.5）：二选一与"已拾起"是 **store 字段**（盒内会话框与面板共用同一份）
    constructionMarkerKind,
    constructionMarkerPicked,
    armConstructionMarkerNow,
    beginConstructionMarkerHexPickNow,
    axisControlledCityKeys,
    trainbustingMarks,
    mapCityHexes,
    securityCityViews,
    securityCityDetails,
    securityNeeds,
    activeSupplySourceStatuses,
    railCapToday,
    exclusiveTimings,
    todaysTimings,
    redAirForceAdvisory,
    exclusiveError,
    setPanzerGroupNow,
    setMultiUnitFormationNow,
    addSupplyCacheNow,
    // 21.10b：Forage 入口（与 12.6c 同面板）、执行与阶段内撤销
    forageOptions,
    useForageNow,
    undoSupplyCacheUse,
    setConstructionMarkersNow,
    useConstructionMarkerNow,
    toggleAxisCityControlNow,
    applySecurityNeedsNow,
    // 2.2 末段：H 清理阶段的通用自动清理
    runCleanUpNow,
    hasTrainbustingAt,
    // W6 B20：胜利判定
    victoryHexes,
    victoryLastControl,
    victoryControlOf,
    victorySummary,
    victoryTurnRange,
    decisiveVictory,
    finalVictory,
    atFinalTurn,
    victoryError,
    refreshVictoryControlNow,
    setVictoryControlNow,
    checkVictoryNow,
    rollDice,
    resetAll,
    pushLog,
    // ⑧：结算提交入口（域内共用；暴露给记录链路与测试核对"关键提交入账"）
    recordSettlement,
    isLegal,
  }
})
