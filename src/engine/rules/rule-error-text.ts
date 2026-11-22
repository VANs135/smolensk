/**
 * 规则拒绝原因的中文化（炮击 / 战斗 / 空军共用）
 *
 * 引擎与操作台都按 `{ rule, reason }` 传拒绝：`reason` 是内部代码（可带 `:参数`）。
 * 界面只显示这里译出的人话，**不原样打印内部代码**；操作台自己写的中文原因原样返回。
 * 三张表放在同一处，避免各界面对同一代码各抄一份、改一处漏两处。
 *
 * 条文索引（本文件与本仓库实现的对应）
 *   通规：10.0 / 9.1 / 13.4a / 14.7d
 *   专规：文案层专规引用：2.3b、1.4b——只影响提示语，不改判定
 */

export interface RuleErrorLike {
  rule: string
  reason: string
}

/** 10.0 炮击链路 */
const BARRAGE_ERROR_TEXT: Readonly<Record<string, string>> = {
  noBarrageUnit: '没有选择参炸单位',
  airTransportForbidsBarrage: '该单位本阶段被空运限制，不能炮击',
  groundBarrageNeedsReleasedReserve: '反应／进击环节的炮击只允许已释放的预备火炮',
  sovietArtilleryMustStackTogether: '苏军炮兵合并齐射须全部同堆叠',
  artilleryOutOfRange: '有参炸火炮射程够不到目标格',
  belowMinBarrageValue: '至少需要 1 点轰炸值才能炮击',
  mixedBarrageKinds: '一次炮击只能用同一类型单位',
  unitAlreadyBarraged: '有参炸单位本阶段已经炮击过',
  artilleryInReserveOrStratCannotBarrage: '预备／战略模式的炮兵不能炮击（13.4a）',
  noArtilleryUnit: '没有可参炸的火炮',
  targetKindNotInHex: '整体目标与该格不符（该格没有这类目标）',
  barrageOutcomePending: '本次炮击结果尚未确认，不能开新的一场',
  hipShootCannotTrainbusting: '低空扫射不能做运输破坏（14.7d-D）',
  trainbustingNeedsAirMission: '运输破坏是作为空军任务执行的，火炮不能宣布（10.0c）',
  cannotSplitBarrageValue: '轰炸值不能拆分到多次炮击',
  belowPrintedBarrageValue: '不能以低于印刷值的轰炸值参战',
  hexAlreadyBarraged: '该格本阶段已经被轰炸过',
  internalStocksForbidden: '炮击永远不能使用部队储备',
  cannotAfford: '所选补给站付不出这次炮击的补给',
  mixedSupplySources: '多门火炮齐射的补给必须来自同一指挥部或同一补给站',
  barrageSupplyNeedsADump: '请先在地图上点选一座可付款的补给站',
  barrageSupplyDumpOutOfRange: '所选补给站不在本次参炸火炮的可达范围内',
  terrainLineNotInTargetHex: '所选地形不在目标格内',
  invalidBarrageDice: '骰值与炮击类型不符',
  barrageOutcomeNotResolved: '还没有掷骰，无法结算结果',
  unitNotInTargetHex: '受损单位不在目标格内',
  invalidSteps: '损失点数必须是非负整数',
  duplicateLossUnit: '同一单位不能重复分配损失',
  lossExceedsSteps: '分配的点数超过该单位当前军力',
  lossAllocationMismatch: '损失点数合计与结果要求不符',
  noLossExpected: '本次结果不应造成军力损失',
  invalidAircraftLossRoll: '飞机的损失骰值应为 1–6',
  notAtSupplyStep: '当前不在补给步骤',
  notAtShiftsStep: '当前不在横移步骤',
  notAtDiceStep: '当前不在掷骰步骤',
  notAtOutcomeStep: '当前不在结果步骤',
  noBarrageResult: '还没有结果可结算',
  invalidLossAllocation: '损失分配不合法',
  movementSegmentOnlyHipShoot: '移动环节只允许低空扫射',
  tooManyAircraft: '一次轰炸的飞机超过上限（≤4）',
  hipShootNeedsCorrectSpotter: '低空扫射必须有正确的观察员',
}

/** 9.x 战斗链路 */
const COMBAT_ERROR_TEXT: Readonly<Record<string, string>> = {
  noAttacker: '没有选择攻击单位',
  noDefender: '防御格内没有敌方战斗单位',
  defendersInMultipleHexes: '守方单位不在同一格',
  duplicateAttacker: '同一单位被重复加入攻方',
  friendlyFire: '攻方里混入了守方单位',
  airTransportForbidsAttack: '该单位本阶段被空运限制，不能进攻',
  stratCannotAttack: '战略模式的单位不能进攻（9.1e）',
  unreleasedReserveCannotAttack: '未释放的预备单位不能进攻（9.1e）',
  defenseOnlyUnit: '只能防御的单位不能进攻（9.1e）',
  cannotEnterDefendingHex: '该单位不能进入被攻击的格（9.1f）',
  unitAlreadyAttackedThisSegment: '该单位本环节已经进攻过',
  hexAlreadyAttackedThisSegment: '该格本环节已经被攻击过',
  noAttackerAfterReduction: '攻方减员后已没有参战单位',
  attackerNotInComposition: '名单里有不在本场战斗中的攻方单位',
  attackSupplyNotFull: '战斗补给不足：先在地图上点补给站付足攻方所需的 T',
  attackerArAlreadyDeclared: '攻方已经宣布过行动值',
  attackerArUnitNotParticipating: '所选单位不在本场战斗中',
  attackerArUnitNotInBattle: '所选单位不在本场战斗中',
  defenderArUnitNotInBattle: '所选单位不在本场战斗中',
  attackerArMustBeDeclaredFirst: '先宣布攻方行动值，再宣布守方',
  supplyOrArMissingBeforeTerrain: '补给或行动值还没有确认',
  defenderTerrainNotHexTerrain: '守方地形必须是防御格内地形',
  noCombatLine: '该地形没有对应的战斗表横行（9.3c）',
  stackTerrainNotCandidate: '该地形不是这个堆叠的可选地形（9.4b）',
  defenderMayNotIgnoreOptions: '本场守方不能忽略选项（9.10c）',
  nkvdArUnitForbidsIgnoringOptions: 'NKVD 边防团担任行动值单位时，守方不得忽略选项（专规 2.3b）',
  badRetreatHexes: '选项点数不合法',
  badLossPoints: '选项点数不合法',
  optionNotFullySatisfied: '选项点数还没有完全分配',
  optionLossExceedsAvailableSteps: '选项损失超过了该方还能承受的军力',
  retreatEndHexUnavailable:
    '撤退落点不合法：须正好在撤退距离上，不能进入敌方 ZOC（除非该格有己方单位），且不能超堆叠',
  retreatPathShorterThanOptions: '撤退路径短于撤退距离：每个单位都要走满这一步要求的格数',
  retreatMustEndAtFullDistance:
    '撤退落点离起始格不是正好在撤退距离上：请选直线距离正好等于撤退格数的落点',
  unknownUnit: '损失名单里有不在本场战斗中的单位',
  badSteps: '给该单位分配的点数不合法',
  arUnitMustTakeFirstLoss: '第一点损失必须先由行动值单位承受（9.11c）',
  lossAllocationViolatesSpreadRule: '损失分配不符合“先 AR、再均匀展开”（9.11c）',
  retreatPathMissing: '还有单位没有选定撤退落点',
  retreatPathRepeatsHex: '撤退路径重复经过同一格',
  retreatPathReturnsToStart: '撤退路径不能回到起始格',
  retreatOffMapForbidden: '本作撤退不能离图（专规 1.4b）',
  tagalongUnknownUnit: '跟随名单里有未知单位',
  tagalongHostEliminated: '跟随的宿主已被消灭',
  neitherCombatUnitNorOrganicTruck: '跟随者必须是战斗单位或编内卡车（9.12d）',
  attackerRetreatedNoAdvance: '攻方曾经撤退，不能推进（9.12g-B）',
  immobileUnitCannotAdvance: '不能移动的单位不能推进',
  noUnitPaidCombatSupply: '没有付过战斗补给的攻方单位可以推进',
  chosenUnitDidNotPayCombatSupply: '所选的推进单位没有付战斗补给',
  notStackedAtPhaseStart: '突袭要求参战单位在阶段开始时同堆叠（8.1）',
  arOrOddsMissingBeforeSurprise: '上一步结算还没有完成',
  arOrOddsMissingBeforeDice: '上一步结算还没有完成',
  diceOrArMissingBeforeLosses: '上一步结算还没有完成',
  diceMissingBeforeOptions: '上一步结算还没有完成',
  arOrDiceMissingBeforeAdvance: '上一步结算还没有完成',
  notAtLossStage: '当前不是该方的结算步骤',
  notAtOptionStage: '当前不是该方的结算步骤',
}

/** 14.x / 15.x 空中任务链路 */
const AIR_ERROR_TEXT: Readonly<Record<string, string>> = {
  aircraftNotInAirBaseHex: '该机不在其空军基地格（14.1a）',
  aircraftBaseNotFriendly: '该机所在基地不是友方（14.1a）',
  aircraftNotActive: '该机当前不是可用状态（14.1a）',
  aircraftEliminated: '该机已被消灭（14.1b）',
  aircraftNotOwnedByMissionSide: '任务名单里有不属于该方的飞机',
  aircraftAlreadyFlewMissionThisPhase: '该机本阶段已经执行过任务（14.2e）',
  noAircraftInMission: '任务里没有飞机（14.2f-A）',
  weatherProhibitsFlying: '天气禁止飞行（14.1f）',
  missionsNotAllowedInPhase: '当前阶段不允许这类空中任务（14.1g）',
  limitedFlightBlocksPhase: '有限飞行规则禁止本阶段起飞（专规 1.5）',
  sovietNoReactionOrExploitationMission: '苏军不得在反应／进击段执行空中任务（专规 2.2d）',
  baseTransferUsesDedicatedPlan: '转场要用专门的转场计划（14.11）',
  interceptionIsNotADeclaredMission: '拦截不是可宣布的任务类型（14.5）',
  noBarrageCapableAircraft: '任务里没有具备轰炸能力的飞机（14.7b）',
  noHipShootCapableAircraft: '任务里没有具备低空扫射能力的飞机（14.7d）',
  hipShootMustBeSingleAircraft: '低空扫射只能派 1 架飞机（14.7d-B）',
  noTransportCapableAircraft: '任务里没有具备运输能力的飞机（14.9a）',
  noAirCombatCapableAircraft: '任务里没有具备空战能力的飞机（14.6）',
  unsupportedMissionKind: '不支持的任务类型（14.2e）',
  cargoExceedsCapacity: '货物超过运力（14.9a）',
  cargoExceedsAircraftCapacity: '货物超过该机容量（14.9a）',
  cargoCannotFitAircraft: '货物装不进这架飞机（14.9a）',
  cargoNotInManifest: '货物不在清单里（14.9a）',
  cargoUnassigned: '还有货物没有分配（14.9a）',
  cargoAssignedToUnknownAircraft: '货物分给了不存在的飞机（14.9a）',
  duplicateCargoAircraft: '同一架飞机重复分配货物（14.9a）',
  duplicateCargoAssignment: '同一件货物重复分配（14.9a）',
  cargoUnitAssignedToOtherOrigin: '货物被分到了别的出发地（14.9a）',
  invalidCargoSize: '货物尺寸不合法（14.9a）',
  cargoUnitNotInMoveMode: '装运的单位必须处于移动模式（14.9c）',
  cargoUnitMaAboveTen: '装运单位的 MA 超过 10（14.9c）',
  airDropPersonnelNotAllowed: '该单位不能空投（2.2b）',
  noMissionInProgress: '当前没有进行中的空中任务（14.3d）',
  completePendingAirStepBeforeReturn: '先完成当前空中步骤再返航（14.2f）',
  completePendingSettlementBeforeAirMission: '先完成待结算再开新任务（14.2f）',
  noEligibleVoluntaryReturn: '没有可自愿返航的飞机（14.3d）',
  partialCargoReturnUnsupported: '暂不支持只返航部分货物（14.9a）',
  cargoCarrierAllocationRequired: '需要先指定货物由哪架飞机运回（14.9a）',
  cargoUnitMissing: '货物单位不存在（14.9a）',
  cargoOutcomePending: '任务结果尚未确认（14.2f-F）',
  retainedCargoUnitMissing: '留存的货物单位不存在（14.9）',
  unsettledAirUnitCargo: '还有货物未结算（14.9）',
  retainedCargoSpUnassigned: '留存补给点数未分配（14.9）',
  airCargoLossUnitMissing: '货物损失单位不存在（14.2f-F）',
  airFlakStepNotReady: '高炮步骤还没准备好（14.2f-E）',
  airUnitLoadPlanChanged: '装载计划已变化，请重新确认（14.9a）',
  interceptionAlreadyResolvedOrClosed: '拦截已经结算或关闭（14.5）',
  noActiveMissionAircraft: '任务里没有在执行中的飞机（14.7）',
  noDefendingAircraftInAirCombat: '空战里没有守方飞机（14.3e-B）',
  interceptorNotChosen: '还没有选择拦截机（14.5）',
  interceptorNotEligible: '所选飞机不具备拦截资格（14.5）',
  defenderAircraftNotFound: '找不到守方飞机（14.3e-B）',
  notEligibleToIntercept: '不具备拦截资格（14.5）',
  reduceEnemyAirBase: '不能削减敌方空军基地（15.4）',
  airstripCannotBeReduced: '简易跑道不能被削减（15.2E）',
  airstripMustUseAirstripUpgrade: '请使用简易跑道升级流程（15.2E）',
  refitAtEnemyAirBase: '不能在敌方空军基地整备（15.1）',
  noInactiveAircraftAtBase: '该基地没有可整备的飞机（15.1B）',
  nothingRequestedToRefit: '没有指定要整备的飞机（15.1B）',
  notEnoughInactiveAircraft: '可整备的飞机不足（15.1B）',
  activeStackingLimitExceeded: '空军基地的现役堆叠超限（14.2a）',
  transferFromEnemyAirBase: '不能从敌方空军基地转场（14.11）',
  transferToEnemyAirBase: '不能转场到敌方空军基地（14.11）',
  twoWayAircraftMustStayAtDestination: '双向任务的飞机必须留在目的地（14.9e-A）',
  returnHexMissing: '返航格未指定（14.1c）',
  returnHexNotAirBase: '返航格不是空军基地（14.1c）',
  returnToEnemyAirBase: '不能返航到敌方空军基地（14.1c）',
  unknownMissionAircraft: '任务名单里有未知飞机（14.2f-G）',
  missionHasNoCargo: '该任务没有货物（14.10d）',
  missingCargoDice: '缺少货物骰（14.10d）',
  badCapacityAfter: '运输能力结算不合法（14.4g）',
  unknownCargoItem: '货物清单里有未知条目（14.4g）',
  duplicateCargoItem: '货物重复（14.4g）',
  cargoLossTooSmall: '货物损失不足（14.4g）',
}

/**
 * 把 `{ rule, reason }` 译成一句人话
 *
 * - 操作台自己写的中文原因（含汉字）原样返回；
 * - 三张表按「炮击 → 战斗 → 空军」顺序查；
 * - `wrongPhaseFor*` / `notAt*` 这类前缀统一兜底；
 * - 其余只给「本次操作被规则拒绝（规则号）」，**不打印内部代码，也不打印 `:` 后的参数**
 *   （参数多是算子 id 等内部标识；真正给人看的说明应在操作台写成中文原因）。
 */
export function ruleErrorTextOf(error: RuleErrorLike): string {
  if (/[\u4e00-\u9fa5]/.test(error.reason)) return error.reason
  const [head] = error.reason.split(':')
  const code = head ?? ''
  const text = BARRAGE_ERROR_TEXT[code] ?? COMBAT_ERROR_TEXT[code] ?? AIR_ERROR_TEXT[code]
  if (text !== undefined) return text
  if (code.startsWith('wrongPhaseFor')) return '当前阶段不允许这项操作'
  if (code.startsWith('notAt')) return '当前不在这一步'
  return `本次操作被规则拒绝（${error.rule}）`
}
