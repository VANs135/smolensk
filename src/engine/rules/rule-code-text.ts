/**
 * 其余规则模块的拒绝原因中文化（运输 / 建设 / 到达 / 编组 / 空运 / 补给等）
 *
 * 分工：`rule-error-text.ts` 的三张表管炮击、战斗、空军三条**热链路**；
 * 本表管其余模块，键为引擎 `fail(rule, reason)` 里的 `reason`（不带 `:` 后的参数）。
 *
 * 撰写判据（用户 2026-11-23 口径：文本可以改，但必须严格按规则书）
 *   1. 每条都必须能对回通规 / 专规的**原文条款**，条款号写在句尾括号里；
 *   2. 括号里的号必须是真实存在的条款（由 `npm run audit:error-text` 校验，
 *      号不存在即构建失败），且「通规 / 专规」前缀与该号的归属一致；
 *   3. 只补人话，不改判定；措辞取原文关键句（如「不在敌方 ZOC 内的可火车卸货的铁路格」），
 *      不自行发明条件。
 *
 * 未覆盖的码仍落到「本次操作被规则拒绝（规则号）」——宁可说不清，也不编规则。
 */

export const LEGALITY_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 环节与行动者（通规 2.2 / 6.0 / 6.3a / 7.0a / 11.0a）──
  actionNotInSegment: '本环节不允许这项操作（当前环节的许可动作清单里没有它，2.2）',
  barrageSourceNotAllowedInSegment:
    '本环节的轰炸来源不对：C 段只能空中、F 段只能炮兵（10.1a / 2.2）',
  notActiveSide: '当前不是本方环节，不能行动（6.0 / 11.0a）',
  activeSideInReaction: '反应阶段只能移动非阶段玩家的单位（6.3a）',
  reserveNotReleased: '该单位本阶段没有释放，反应阶段只有已释放的预备才能移动（7.0a）',
  notExploitOrReleased: '进击阶段只能移动进击模式单位或已释放的预备（11.0a）',
  // ── 空运对后续动作的限制（通规 14.9d / 5.4）──
  airTransportForbidsMovement: '本阶段空运后已没有地面移动额度（14.9d）',
  airTransportAlreadyStartedMovement: '本阶段已经空运，不能再切换主动模式（5.4 / 14.9d）',
  // ── 模式能力（通规 5.5b / 5.6a / 5.7 / 5.8 / 8.1 / 5.10b）──
  modeForbidsAttack: '当前模式不能攻击（5.7 / 5.8）',
  modeForbidsBarrage: '当前模式不能轰炸（5.7 / 5.8）',
  modeForbidsOverrun: '当前模式不能突袭（8.1）',
  modeForbidsRail: '铁路运输须处于移动模式（铁路修理单位可在战斗模式下使用，5.6a）',
  modeForbidsAirTransport: '空运须处于移动模式（5.6a）',
  modeForbidsEngineering: '工程作业与轨距转换须处于战斗模式（5.5b）',
  dgCannotOverrun: 'DG 单位不能突袭（5.10b）',
  dgCannotRail: 'DG 单位不能使用铁路运输（5.10d）',
  dgNonEngineerCannotBuildHedgehog: '处于 DG 的非工程兵不能修建环形工事（5.10e）',
  immobile: '该单位没有移动力（MA 为 0），不能移动或突袭（6.1b）',
  extenderCannotMove: '以延补队面在场的单位不能移动，也不能突袭（12.7）',
  mpLocked: '本阶段已承诺不再消耗 MP，不能再移动或突袭（4.5b）',
  modeTargetMissing: '切换模式必须指定目标模式（5.4）',
  // ── 模式进入的 ZOC 与朝向限制（通规 4.5a / 5.7c / 5.8a / 5.8）──
  enterReserveInEnemyZoc: '不能在敌方 ZOC 内进入预备模式（4.5a-I、5.7c）',
  enterStratInEnemyZoc: '不能在敌方 ZOC 内进入战略模式（4.5a-J、5.8a）',
  stratMustFaceMove: '战略模式下单位朝向必须是移动面（5.8）',
  truckMustStopOrOverrun: '轮式单位进入敌方 ZOC 后必须停止，或在该格进行一次突袭（4.5a-A）',
  enemyCombatUnitInHex: '目标格有敌方战斗单位，不能直接进入，须以突袭处理（4.8c）',
  // ── 燃料（通规 12.5a / 12.5b）──
  fuelNotPaid: '使用轮式或履带 MP 的战斗单位，移动或突袭前须先付燃料（12.5a、12.5b）',
  // ── 堆叠（通规 4.8 / 4.8a）──
  stackingLimit: '突袭发起格的战斗单位超过 10 RE，发起时就须满足限制（4.8a）',
  portPerHexLimit: '一格内至多 1 个港口（4.8）',
  airBasePerHexLimit: '一格内至多 1 个空军基地（4.8）',
  hedgehogPerHexLimit: '一格内至多 1 个环形工事（4.8）',
  overstackAtSegmentEnd:
    '本环节结束时该格战斗单位超过 10 RE，须由拥有者摧毁单位直至满足限制（4.8a）',
  // ── 额度（专规 1.2 / 通规 13.3、13.3g）──
  allowanceDateMissing: '额度上限按回合变化，判定时取不到当前日期（13.3）',
  allowanceLimitUnknown: '该种类的额度没有可用上限数据（13.3）',
  allowanceExceeded: '本阶段该额度不够用（铁路运量限额见专规 1.2，换轨上限见 13.3g）',
  // ── 编队法加油的同源要求（通规 12.5c）──
  formationFactsMissing: '编队法加油须给出同源事实：同一 HQ 投递，或同一补给站直接拖取（12.5c）',
  formationSourceNotShared: '编队内需要燃料的单位不同源，只能改用单单位法加油（12.5c）',
}

export const CONSOLIDATION_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 13.9 单位的合并（1–3 项地面，4 项飞机）──
  sameUnit: '不能把单位与它自己合并（13.9）',
  consolidationOnlyInReinforcementPhase:
    '地面单位的合并只能在本方增援阶段进行（飞机可在任何阶段合并，13.9）',
  dgCannotConsolidate: 'DG 单位不能参与合并（13.9）',
  lowStocksCannotConsolidate: '部队储备低下或耗尽的单位不能参与合并（13.9）',
  replacedNotFormationUnit: '被换下的单位不属于多单位编队（13.9 第 2 项）',
  replacementNotFormationUnit: '死亡堆中的替换单位不属于多单位编队（13.9 第 2、3 项）',
  replacementDg: '死亡堆中的替换单位是 DG，不能用于合并（13.9）',
  replacementHasLowStocks: '死亡堆中的替换单位储备低下或耗尽，不能用于合并（13.9）',
  replacementNotInDeadPile: '替换单位不在死亡堆里（13.9 第 2、3 项）',
  sameFormation:
    '替换单位与被替换单位属于同一个多单位编队（须换入其他编队的同等单位，13.9 第 2 项）',
  formationUnitCannotBecomeIndependent: '多单位编队中的单位永远不能转为独立单位（13.9 第 3 项）',
  aircraftNotSameHexOrBox: '两架飞机不在同一格或同一地图外区域（13.9 第 4 项）',
  aircraftTypeOrValuesDiffer: '两架飞机的类型或数值不同（13.9 第 4 项）',
  aircraftStatusDiffer: '两架飞机的状态不同（须同为激活或同为非激活，13.9 第 4 项）',
  aircraftNotReduced: '只有军力减损的飞机才能合并（13.9 第 4 项）',
}

export const WORKBENCH_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 13.3e 铁路运输三段（操作台侧的前置检查）──
  railMoveNeedsSelectedUnit: '铁路移动要先选好要运的单位（13.3e）',
  railMoveNeedsSelectedTransportPoint: '铁路移动要先选好运输点数（13.3e）',
  railMoveNeedsOwnTransportPoint: '只能用本方的运输点数做铁路移动（13.3e）',
  railMoveOnlyOwnUnits: '铁路移动只能运本方的货物（13.3e）',
  railMoveNeedsDestination: '还没有选择铁路移动的终点（13.3e）',
  noRailPath: '起点与终点之间没有铁路路径（13.3e-2）',
  // ── 通规 13.3a / 13.2f / 12.2a 的支付与锁定 ──
  railMoveSpNeedsOwnDump: '用 SP 做铁路移动时，SP 须出自本方补给站（13.3a）',
  railMoveSpNotPayable: '起运站的 SP 不足，付不起这次的铁路运量（13.3a）',
  loadNotPayable: '付不起这次装载所需的运输点数（13.2f）',
  loadExceedsCapacity: '装载量超过该运输点数的容量（13.2f）',
  loadAmountNotWholeT: '装载量必须是整 T 的面额（1 SP 可拆成 4 T，12.1a）',
  unloadAmountNotWholeT: '卸载量必须是整 T 的面额（1 SP 可拆成 4 T，12.1a）',
  relayLockedOtherMode: '该格本阶段已有补给由别的运输方式卸下，这批不能再换方式（12.2a）',
  railRelayLockedOtherMode: '该格本阶段由其他方式卸下的补给不能再上铁路（12.2a）',
  // ── 通规 13.6 / 13.6b 到达落位 ──
  noPlacementHex: '没有可用的落点格（13.6）',
  arrivalNoCandidateHex: '该到达条目没有任何候选落点（13.6）',
  arrivalHexOutsideCandidates: '所选落点不在候选清单里（13.6）',
  arrivalHexEnemyOccupied: '落点被敌方单位占据（13.6b）',
  arrivalAirBaseOverstack: '落点会让空军基地堆叠超过上限（13.6b）',
  arrivalRailNotGroundUnit: '铁路到达只适用于地面单位（13.6b）',
  arrivalRailNotPhase: '铁路到达只能在本方的到达或增援环节结算（13.6b）',
  arrivalRailAlreadyPlaced: '这一步的铁路落位已经做过了（13.6b）',
  arrivalRailMultiCopy: '同一到达条目出现了多个铁路落位（13.6b）',
  arrivalRailNoDetrainable: '铁路落点不是可卸货格（13.6b、13.3c）',
  arrivalRailNoPlacement: '铁路到达缺少落位数据（13.6b）',
  arrivalRailNoRecord: '找不到该到达条目的记录（13.6b）',
  // ── 专规 1.6c / 2.3c / 3.3c / 3.4b 的流程待办 ──
  frontalReservesPending: '还有方面军预备队的到货没有处理（专规 2.3c）',
  rollNotMade: '本阶段还没有掷骰，先掷骰再放（专规 1.6c）',
  specialReplNotRolled: '特殊补员还没有掷骰（专规 1.6c）',
  variableExitSelectionPending: '可变退场还有待选项没有落位（专规 3.3c）',
  arrivalSpGroupRequired: '到货 SP 要先指定装甲集群归属（专规 3.4b）',
  // ── 通规 13.9 第 2 项（编队换装的承运）──
  carrierFormationMismatch: '承运机与被换装单位不属于可互换的多单位编队（13.9 第 2 项）',
  // ── 流程状态（非规则拒绝）──
  rollHandNotEmpty: '掷骰后还有待放项没有落位',
  arrivalHandNotEmpty: '到达手牌还没有处理完',
  arrivalRemovalsFirst: '先处理完到达表里的强制移除',
  noDefenderToEngage: '该格没有可交战的防守方',
  forageNotAvailable: '当前局面不能觅食',
  noAirbase: '目标格没有空军基地',
}

export const SESSION_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 存档（本地存储，无对应规则条文）──
  emptySlot: '存档槽是空的，没有可读内容',
  noSessionToSave: '当前没有可保存的对局',
  storageUnavailable: '本地存储不可用，存档读写失败',
  // ── 通规 2.2 / 2.3 流程 ──
  turnsExhausted: '回合轨已经走到尽头，对局结束（2.2）',
  notCleanUpPhase: '只能在整理阶段做这件事（2.2）',
  noSegmentStep: '当前环节没有可执行的步骤（2.2）',
  noPendingQuestion: '当前没有待回答的问题（2.3）',
  // ── 专规 4.0 / 5.0b 开局与终止 ──
  consensusLockedAfterStart: '对局开始后不能再改共识设置（专规 4.0）',
  firstWeatherLocked: '首回合天气已经锁定，不能再改（专规 4.0）',
  scenarioLockedWhilePlaying: '对局进行中不能更换剧本（专规 4.0）',
  sessionNotStarted: '对局还没有开始（专规 4.0）',
  consensusChecklistNotRecorded: '共识清单还没有记录，无法开局（专规 4.0）',
  earlyDecision: '已满足提前决胜条件，对局提前结束（专规 5.0b）',
}

export const TERRAIN_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 6.2d / 8.1c / 9.3b ──
  noTerrain: '该格没有地形数据',
  unknownTerrain: '未识别的地形类型（6.2d）',
  prohibited: '该地形禁止通行（8.1c）',
  noCandidate: '没有可用的候选格（9.3b）',
  notACandidate: '所选格不在候选清单里（9.3b）',
}

export const BATTLE_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 9.12 撤退路径的结算结果（这些不是「被拒绝」，而是「因此被消灭」）──
  impassableStartOfCombat: '撤退进入战斗开始时的敌占格，该单位被消灭（9.12f）',
  mustCrossEnemyOrProhibited: '撤退路径必须穿过敌方单位或禁入地形，该单位被消灭（9.12）',
  outsidePlayArea: '撤退路径越出剧本活动区，该单位被消灭',
  stratZoc: '战略模式单位被迫进入敌方 ZOC，该单位被消灭（5.8a）',
  noLanding: '没有可着陆的格（9.12f）',
  // ── 通规 8.0 / 8.1a 突袭 ──
  noEnemyCombatUnit: '目标格没有敌方战斗单位，无法突袭（8.0）',
  notAMovementSegment: '突袭只能在移动或进击环节进行（8.0）',
  moveAlreadyFinished: '本次移动已经结束（8.1a）',
  noOverrunParticipant: '没有参与突袭的单位（8.1a）',
}

export const AIR_MISC_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 14.9a / 14.2e / 14.2f / 14.9e ──
  airUnitCargoAlreadyLoaded: '该飞机已经装载了货物（14.9a）',
  cargoUnitMissingOrDuplicated: '货物单位缺失或重复（14.9a）',
  duplicateAirCargoUnit: '同一货物单位被重复装载（14.9a）',
  invalidAirCargoUnitId: '货物单位编号无效（14.9a）',
  airCargoAlreadyLoaded: '该机本阶段已经装载过货物（14.2e）',
  airMissionInProgress: '已有空军任务正在进行中（14.2f）',
  invalidUnloadAmount: '卸下的数量不合法（14.9e）',
  interceptionCombatPending: '拦截空战还没有结算完（14.5）',
  // ── 通规 10.0a / 10.1b / 12.10a / 12.10c ──
  barrageLossPending: '炮击的损失还没有结算完（10.0a）',
  shellsCannotAffordAnyColumn: '额度连最低的轰炸列都付不出，这次炮击取消（21.10）',
  shellsRequireHqThrow: '补给缓存只能用于经指挥部投递补给的炮击（21.10）',
  onMapSupplyAvailable: '图上还有可用补给，无须动用部队储备（12.10a）',
  internalStocksExhausted: '部队储备已经耗尽（12.10c）',
}

export const SPECIAL_RULES_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 专规 2.2a / 2.2b 苏军空军限制 ──
  sovietNoHipShoot: '苏军不能进行 hip shoot（专规 2.2a）',
  sovietNoPlannedAirdrop: '苏军不能实施计划空降（专规 2.2b）',
  axisHipShootRequiresPermittingWeather: '轴方的 hip shoot 需要天气允许（专规 2.2a）',
  hipShootNotAllowedForSideOrWeather: '该方或该天气下不允许 hip shoot（专规 2.2a）',
  // ── 专规 3.3c / 3.6 掷骰与可变退场 ──
  replDiceOutOfRange: '补员骰值超出范围（专规 3.3c）',
  supplyDiceOutOfRange: '补给骰值超出范围（专规 3.3c）',
  variableExitDieRequired: '可变退场要先掷骰再选（专规 3.3c）',
  randomEventDieRequired: '随机事件要先掷骰（专规 3.6）',
  // ── 专规 3.3d / 通规 13.9 合并 ──
  axisFormationCannotConsolidate: '轴方多单位编队不能使用合并（专规 3.3d）',
  facesNotIdentical: '两个单位的算子两面不完全相同（13.9）',
  unitsNotSameHexOrBox: '两个单位不在同一格或同一地图外区域（13.9）',
  // ── 专规 3.4a / 4.1a 装甲集群约束 ──
  crossGroupStackedOrAdjacent: '两个装甲集群的单位堆叠或相邻（专规 3.4a）',
  wrongSideOfLineEastOfOrsha: '位于分界线错误一侧且在 Orsha 以东，阶段末须投 DG（专规 3.4a 条件②）',
  newSpMustBeAssignedToAPanzerGroup: '新增的 SP 必须指定给某个装甲集群（专规 4.1a）',
  // ── 通规 5.4a / 5.7c 预备标记与初设模式 ──
  noReserveMarkerAvailable: '没有可用的预备标记了（5.4a）',
  reserveMarkerCapReached: '预备标记已经达到上限（5.4a）',
  reserveSetupForbidden: '初设时与敌方攻击力单位相邻，不能设为预备（5.7c）',
  setupModeNotAllowed: '初设时不允许设为该模式（5.7c）',
}

/** 收尾批次：原文出处已逐条核对，条款号为索引中的真实号；剧本页/初设章节这类非规则标签不带号 */
export const FINAL_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 空军射程与空战点名 ──
  offMapOriginBeyondRange: '该机从图外机场起飞后剩下的航程够不到目标（专规 1.4a）',
  attackerMustPickNonBracketedAircraft: '攻方只能点选非括号的空军单位（14.3e-B）',
  returnOutOfRange: '返航落点超出该机的航程（14.1c）',
  // ── 慢动员解锁（专规 2.4）──
  noUnlockQuotaLeft: '今天这个集团军的慢动员配额已经用完（2.4）',
  unlockSelectionCountMismatch: '解封的单位数量与登记的配额不一致（2.4）',
  // ── 损失、突围、抽签、NKVD、装甲集群 ──
  lossExceedsUnitSteps: '分给该单位的损失超过它剩下的军力（9.11）',
  noTracedCombatFriendWithinRange: '15 格内没有带追溯补给的友方战斗单位（12.8e）',
  drawCountMismatch: '抽出的编队数量与剧本规定的数量不一致',
  nkvdMustBeArUnit: '指定的 NKVD 单位必须是行动值单位（2.3b）',
  wrongPanzerGroupSp: '这个 SP 的归属与本编队所属的装甲集群不一致（3.4b）',
  aircraftTypeNotRebuildable: '该机型不在可以重建的机型里（专规 1.6）',
  // ── 初设放置（章节标签 IV / IV-A，非条款号）──
  requiredSetupPlacementPending: '还有单位没有完成初设放置',
  setupCandidatesUnavailable: '剧本没有给出该单位可用的初设落点',
  setupHexOutOfRange: '初设格不在该单位允许的范围内',
  // ── 觅食、共识 ──
  forageTargetOutOfThrowRange: '觅食目标超出了指挥部的投掷距离（21.10）',
  consensusChecklistLengthMismatch: '共识清单的勾选数量与选项数量不一致（专规 4.0）',
}

export const SUPPLY_CACHE_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 专规 1.7 补给缓存标记 ──
  noSupplyCacheLeft: '补给缓存标记已经用尽（专规 1.7）',
  notEnoughSupplyCache: '补给缓存标记不够这次使用（专规 1.7）',
  // ── 通规 10.1b 炮击的补给消耗 ──
  negativeShellsMarkers: '炮弹标记数不能为负（10.1b）',
  shellsRequirePositiveBarrageCost: '一次炮击的补给消耗必须是正数（10.1b）',
  // ── 通规 21.10 补给缓存（专规 1.7 把这条可选规则定为标准规则）：觅食只报状态，不逐句引号 ──
  forageNotAllowedForSpearhead: '前锋单位不能觅食',
  forageOnlyInSupplyPhase: '觅食只能在补给阶段进行',
  forageOnlyOnFirstTurnOfBeingCut: '只有在断补的第一回合才能觅食',
}

export const EXTENDER_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 12.7 延补队的组建 ──
  wrongSegment: '延补队只能在本方移动环节组建（12.7a）',
  insufficientMa: '组建延补队要消耗一半 MA，当前 MA 不足（12.7a）',
  insufficientPoints: '组建延补队需要 5 点同型的运输点数（12.7a）',
  loadedMustUnloadFirst: '装载着 SP 的运输点数须先卸下补给，才能转为延补队（12.7d）',
  countMustBePositive: '组建的数量必须是正数（12.7e）',
  notEnoughPoints: '可用的运输点数不足（12.7e）',
}

export const SPECIAL_COMBAT_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 9.14c / 9.14d / 9.14f ──
  missingDumpDie: '缺少决定补给站存亡的掷骰结果（9.14c）',
  missingGroup: '缺少该补给站所属编队或集团的信息（9.14c）',
  missingGroupDie: '缺少编队归属判定的掷骰结果（9.14c）',
  chosenHexNotLegal: '所选的目标格不合法（9.14d）',
  missingCollapseContext: '缺少判定坍塌所需的上下文（9.14d）',
  missingAircraftEscapeContext: '缺少判定飞机脱逃所需的上下文（9.14f）',
}

export const SUPPLY_PHASE_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 12.8b 损耗 / 12.11a 销毁 ──
  exceedsSteps: '损耗量超过该单位可损失的军力（12.8b）',
  lossNotMet: '损耗量没有达到应损耗的军力（12.8b）',
  alreadyAttempted: '本阶段已经尝试过销毁补给站（12.11a）',
  badPercent: '销毁比例不在允许范围内（12.11a）',
  badRequest: '销毁请求不合法（12.11a）',
  // ── 补给阶段流程状态（非规则拒绝）──
  allStepsNotMet: '补给阶段还有未完成的步骤',
}

export const AIR_UNIT_MOVE_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 14.9d / 14.10 / 5.6a ──
  airDropUnitAlreadyMoved: '该空投单位本阶段已经移动过（14.10）',
  airTransportGroundMovementExceeded: '空运之后的地面移动超过剩余额度（14.9d）',
  cargoUnitCannotUseAirTransport: '该单位不能使用空运（5.6a、14.9c）',
  invalidAirTransportMovement: '空运移动不合法（14.9d）',
  staleAirUnitTransportPhase: '这条空运记录所属的阶段已经过去（14.9d）',
}

export const SETUP_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 初设落位（IV-I 可进入性、通规 4.8 堆叠）──
  setupEntryGoesToDeadPile: '该条目在初设里直接进死亡堆，不能摆到图上',
  setupPlacementUnknown: '初设表里该条的落位写法无法识别',
  setupHexOffMap: '目标格不在图上（初设 IV-I 可进入性）',
  setupHexNotEnterable: '目标格不能按常规移动进入（初设 IV-I）',
  setupOverStacked: '摆上后该格会超过 10 RE 的堆叠上限（4.8）',
  scenarioNotFound: '找不到该剧本的数据（12.1d）',
  // ── 专规 3.4b 补给站归属（Guderian / Hoth）──
  spOwnershipUnknownDump: '指定的补给站不在本剧本的补给站清单里（专规 3.4b）',
  spOwnershipMissing: '轴方补给站必须指定归属装甲集群：Guderian 或 Hoth（专规 3.4b）',
  spOwnershipNotApplicable: '本剧本不适用 3.4b，不应给补给站指定装甲集群归属（专规 3.4b）',
  spOwnershipSovietGroupForbidden: '苏方补给站不能指定装甲集群归属（专规 3.4b）',
  // ── 通规 13.2h 编内卡车的初设装载 ──
  truckLoadDuplicateInstance: '同一枚运输点数被重复列入装载清单（13.2h）',
  truckLoadUnknownInstance: '装载清单里的运输点数不在图上（13.2h）',
  notCurrentSetupSide: '现在不是本方的初设阶段（13.2h）',
  noTruckToPick: '该格没有可选的运输点数（13.2h）',
  notTolerantUnit: '该单位不能装载运输点数（13.2h）',
  setupFinished: '初设已经完成（13.2h）',
  stackSameHex: '装载方与被装载方须在同一格（13.2h）',
  truckFullAlreadyComplete: '该运输点数已满载，无需再装（13.2h）',
  unitNotFound: '找不到该单位（13.2h）',
  // ── 专规 1.4a 机场候选 ──
  noAirBaseCandidate: '没有可用的空军基地候选格（专规 1.4a）',
  // ── 初设交互状态（非规则拒绝）──
  nothingToPlace: '当前没有待摆放的初设条目',
  shiftFormationIdMissing: '西移操作没有指定编队',
  sideCursorNotArmed: '初设光标还没有进入可摆放状态',
}

export const BREAKDOWN_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 20.0 拆分单位的创建与吸收 ──
  armorOrMechCannotBreakdown: '装甲或机械化单位不能拆出拆分单位（20.0）',
  armorOrMechBreakdownCounter: '该拆分算子不是「其他类」，不能用于这种拆分（20.0）',
  lastStepCannotCreateBreakdown: '只剩最后一点军力，不能再拆（20.0）',
  breakdownCreateNotAtAllowedTiming: '拆分只能在本单位开始移动、战后推进或战后撤退时进行（20.0a）',
  breakdownArTooHigh: '拆分单位的 AR 高于母单位，不能拆出（20.0b）',
  breakdownStateMismatch: '拆分单位与母单位的标记或模式不一致（20.0c）',
  breakdownPoolExhausted: '池里没有足够的可用拆分单位（20.0g）',
  armorOrMechCannotAbsorbBreakdown: '装甲或机械化单位不能吸收拆分单位（20.0）',
  breakdownAbsorbNotAtSegmentEnd: '吸收拆分单位只能在阶段结束时进行（20.0d）',
  breakdownNotStackedWithParent: '拆分单位没有与母单位堆叠在同一格或同一图外区域（20.0d）',
  breakdownArTooLow: '母单位只能吸收 AR 不低于自己的拆分单位（20.0b）',
  // ── 专规 2.4 被锁的师 ──
  lockedDivisionCannotBreakdown: '被慢动员锁定的师不能拆解（专规 2.4）',
}

export const REBUILD_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 13.5 重建 ──
  noRebuild: '该单位 AR 标了黄点，永久不可重建（13.5c）',
  breakdownReturnsToPool: '拆分单位被摧毁后返回资源池，不走重建返场（13.5b）',
  rebuildHexInEnemyZoc: '重建格在敌方 ZOC 内（13.5a）',
  rebuildHexNotWithinHqRange: '重建格不在指挥部 2 格范围内（13.5a）',
  unitNotStackedWithRepl: '图上减损的单位须与补员单位同格（13.5a）',
  insufficientRepl: '补员点数不足，付不起这次重建（13.5d）',
  rebuildTypeNotRebuildable: '该兵种不能通过重建返场（13.5d）',
  noFriendlyAirbaseForRebuild: '重建飞机需要本方空军基地（13.5d）',
  aircraftRebuildHexNotFriendlyBase: '飞机重建只能放在本方空军基地格（13.5）',
  missingReplHex: '没有给出补员所在格（13.5f）',
}

export const BREAKOUT_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 12.8e 突围（2.2 说明它属移动阶段的首环节）──
  breakoutOnlyInMovementPhaseBreakoutSegment: '突围只能在移动阶段的突围环节进行（2.2）',
  hasTraceSupply: '该单位已有追溯补给，无须也无法突围（12.8e）',
  nonCombatUnitCannotBreakout: '非战斗单位不能突围（断补首回合的运输点数除外，12.8e）',
  printedMaBelowMinimum: '印刷 MA 不足 1，不能突围（12.8e）',
  conditionsNotEvaluated: '突围所需的两项条件还没有判定（12.8e-A、12.8e-B）',
  pathHasEnemyCombatUnit: '突围路径上有敌方战斗单位（12.8e-A）',
  pathHasProhibitedTerrain: '突围路径上有禁止通行的地形（12.8e-A）',
  pathHasUnnegatedEzocForWheeled: '轮式单位的突围路径上还有未被抵消的敌方 ZOC（12.8e-A）',
}

export const AIR_CARGO_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 6.1g / 13.2e / 14.9a / 14.9c 装载与空运 ──
  finishOtherGroundMovementBeforeAirTransport: '先结束其他地面单位的移动，再开始空运（6.1g）',
  transportPointCannotAirMove: '运输点数不能空运（13.2e）',
  duplicateAirCargo: '同一件货物被重复装载（14.9a）',
  cargoUnitNotAirTransportable: '该单位不能空运（14.9c）',
  cargoUnitNotFriendly: '货物不是本方单位（14.9c）',
  cargoUnitNotAtOrigin: '货物不在具备运力的起飞格（14.9a）',
  invalidAirCargoSize: '货物的运输当量非法（4.7、14.9a）',
  cargoExceedsOriginCapacity: '该起飞格的运力不足以运走这些货物（13.2e）',
}

export const AIR_SUPPLY_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 12.1a / 14.9 空运补给 ──
  invalidAirSupplyStock: '空运补给的存量不合法（12.1a）',
  airSupplyOriginMissing: '没有指定空运补给的来源（12.1a）',
  invalidAirSupplyQuantity: '空运补给的数量不合法（12.1a）',
  airSupplyStockInsufficient: '该来源的补给存量不足（14.9）',
  airSupplyOffMapBoxMissing: '图外空军盒不存在，无法从盒内取补给（14.9）',
  airSupplyOriginAmbiguous: '空运补给的来源不唯一（14.9）',
  airSupplyOriginHexMissing: '空运补给的来源格缺失（14.9）',
  duplicateAirSupplySource: '同一来源被重复列入（14.9）',
}

export const AIR_ROSTER_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 14.1c 空战中的返航与承运 ──
  cargoCannotBeReturned: '空战期间货物不能随同退回（14.1c）',
  cargoExceedsActiveCarrierCapacity: '货物超过当前在役承运机的运力（14.1c）',
  // ── 通规 14.9 / 14.9a 留存货物的退回 ──
  invalidRetainedCargo: '留存货物数据非法（当量为负或有重件，14.9）',
  retainedCargoHasNoCarrier: '没有可以带回留存货物的飞机（14.9）',
  retainedCargoRequiresCommonReturnBase: '各承运机的返航基地不同，无法整组退到同一处（14.9）',
  duplicateRetainedCargoAssignment: '同一件留存货物被分配了两次（14.9a）',
  retainedCargoCarrierWithoutReturnBase: '承运机没有可用的返航基地（14.9a）',
  retainedCargoUnassigned: '还有留存货物没有分配到承运机（14.9a）',
}

export const AIR_UNLOAD_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 14.9f 卸货 ──
  airUnloadSelectionRequired: '请先选择要卸下的货物（14.9f）',
  selectedCargoExceedsUnloadLimit: '所选货物超过本环节的卸货上限（14.9f）',
  duplicateUnloadCargo: '同一件货物被重复卸下（14.9f）',
  invalidUnloadCargoSize: '卸货的运输当量非法（14.9f）',
  invalidUnloadSelection: '卸货选择非法（14.9f）',
  overLimitTransportMustStayAtTarget: '超出卸货上限的运输单位必须留在目标格（14.9f）',
}

export const SUPPLY_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 12.1a 持有量与支付 ──
  invalidHoldings: '补给持有量不合法：SP 与 T 都必须是非负整数（12.1a）',
  invalidSplitCount: '拆分的份数不合法（12.1a）',
  notEnoughSp: '手上的 SP 不足以拆分出所需零钱（12.1a）',
  insufficientSpHoldings: '可用补给不够支付（1 SP = 4 T，12.1a）',
  invalidAmountT: '要支付的 T 数必须是正整数（12.1a、12.3）',
  // ── 通规 12.1b 补给来源 ──
  noSourceChosen: '还没有选择补给来源（12.1b）',
  noSuchSupplySource: '该格没有可用的补给来源（12.1b）',
  sourceHasNoSp: '该来源不含 SP，不能作为拖取或投递的起点（12.3a、12.1b）',
  // ── 通规 12.3 拖取与投递 ──
  hqThrowOnlyForImmediateUse: '指挥部投递只能用于立即使用的补给，不能靠投递搬家（12.3b-A）',
  noDump: '本方地图上没有任何补给站，无法直接拖取（12.3a）',
  directDrawOutOfRange: '所有补给站都超出直接拖取距离（12.3a、12.3c）',
  outOfThrowRange: '超出指挥部的投递距离（12.3b）',
  hqCannotReThrow: '该指挥部自身靠投递获得补给，不能再转投（12.3b-D）',
  stratHqCannotThrow: '战略模式的指挥部不能投递补给（12.3b-C）',
  unreachable: '补给路径不可达（12.3a）',
  offMap: '该格不在图上，无追溯补给（12.6）',
  // ── 通规 12.6c／12.6e 吃图上补给 ──
  outOfSupplyRange: '既拖不到也投不到：超出补给范围（12.6c）',
  cannotEatOffTheMap: '该单位此刻不能靠吃图上补给续命（12.6c）',
  onlyWhenNoTraceSupply: '只有没有追溯补给时才能吃图上补给（12.6c）',
  unitDoesNotRequireTraceSupply: '该单位不需要追溯补给（12.0）',
  alreadyTraced: '该单位已有追溯补给，无需吃图上补给（12.6c）',
  noSource: '该单位不需要追溯补给（12.0）',
  stratCannotEatOffTheMap: '战略模式的单位不能吃图上补给（12.6e）',
  // ── 通规 12.7d 延补队生成 ──
  hexInEnemyZoc: '该格在敌方 ZOC 内，不能作为补给来源（12.7d、12.7g）',
  notConnectedToSource: '该格连不回补给来源，不能在此生成延补队（12.7d）',
}

export const CONTAINERS_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 通规 2.2 回合末（回合轨）──
  turnTrackOutOfRange: '目标回合不在回合轨上（只有 1–19 回合，2.2 回合末）',
  turnMarkerMustMoveForward: '回合标记只能向前推进，不能回退或原地（2.2 回合末）',
  // ── 通规 20.0 拆分母单位 ──
  breakdownSlotNotInCounterLimits: '该 AR 档没有登记在拆分盒里，无法取用（20.0）',
  // ── 通规 13.7 编队盒（收纳／放出）──
  nothingToHide: '没有指定要收进编队盒的单位（13.7）',
  atLeastOneUnitMustStackWithMarker: '收纳后，标记格仍须有至少 1 个所属单位同格（13.7）',
  nothingToRelease: '没有指定要从编队盒放回图上的单位（13.7）',
  // ── 专规 1.6c 特殊补员抽取 ──
  specialReplStoppedFrom: '特殊补员抽取到 8 月 19 日即停止（专规 1.6c）',
  specialReplDieOutOfRange: '骰值必须是 1–6（专规 1.6c 的表 1-3）',
  specialReplDivisionNotInPool:
    '选中的师不在可返场的池里（须在死亡堆且符合免费重建资格，专规 1.6c）',
  noAufkKrdInDeadPile:
    '死亡堆里没有可用的 Aufk（装甲侦察）营或 Krd（摩托化侦察）营，该项作废（专规 1.6c）',
  // ── 初设抽签的数据缺口（非规则拒绝：剧本初设表缺项，无可引条款号）──
  formationNotInDrawPool: '该编队不在本次剧本的初设抽签池里',
  formationNotFoundInSetup: '初设表里找不到该编队，抽签无从推导编成',
  formationHasNoSubordinates: '该编队在初设表里没有能落到盘面的下属单位',
  drawCompositionFactsMissing: '缺少抽签编成所需的事实（角色或落点）',
  moveModeUnitIdsMissing: '缺少「移动模式单位」清单，无法推导抽签编成',
  shiftWestDestinationMissing: '缺少西移落点，无法推导抽签编成',
  swapUnitsMissing: '缺少互换单位，无法推导抽签编成',
  aufkBattalionMissing: '初设里找不到该编队的 Aufk 营',
  krdBattalionMissing: '初设里找不到该编队的 Krd 营',
}

export const ARRIVAL_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 专规 2.4 慢动员解锁 ──
  noUnlockQuota: '该集团军当日没有解锁配额（专规 2.4 的解锁表）',
  selectedNotLocked: '选中的师不是锁定状态，无需解锁（专规 2.4）',
  selectedNotDivision: '只能解锁整师，选中的不是师级单位（专规 2.4）',
  selectedArmyUnknown: '选中的师查不到所属集团军（专规 2.4）',
  selectedWrongArmy: '选中的师不属于本次解锁的集团军（专规 2.4）',
  unlockMustFillQuota: '本回合的解锁名额必须一次选满（专规 2.4）',
  unlockExceedsQuota: '解锁数超过本回合的剩余配额（专规 2.4）',
  unlockExceedsLocked: '解锁数超过仍处于锁定的师数（专规 2.4）',
  // ── 补充表到货：免费铁运与余额（专规 2.1 / 3.1 / 3.6、13.3c）──
  badArrivalSp: '到货 SP 必须是非负整数（专规 2.1）',
  badSupplyTrainSp: '补给列车的 SP 必须是非负整数（专规 3.6）',
  freeRailCandidateNotDetrainable: '免费铁运的候选格不是可卸货格（专规 2.1、13.3c）',
  duplicateFreeRailHex: '同一格被勾了两次：每格最多放 1 SP（专规 2.1）',
  notDetrainableCityHex: '勾选的格不是可卸货的城市格（13.3c）',
  freeRailExceedsArrivalSp: '勾选的 SP 数超过当日到货的 SP（专规 2.1）',
  edgeHexRequiredForRemainder: '还有余额，必须指定一个图边补给源格（专规 2.1）',
  notEdgeSupplySource: '指定格不是本方的图边补给源格（专规 2.1）',
  supplyTrainHexRequired: '补给列车的 SP 必须指定落点格（专规 3.6）',
  supplyTrainHexNotDetrainable: '补给列车的落点不是可卸货格（专规 3.6）',
  // ── 到达表与方面军预备队（通规 13.6、专规 2.3c）──
  invalidDate: '日期无法解析为月日，无法按到达表归位（13.6）',
  noFrontalReservesAtDate: '当日没有方面军预备队的到货批次（专规 2.3c）',
}

export const AIR_MISSION_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 14.1c / 14.2a / 14.3d 任务与空战窗口（通规）──
  mustKeepOneActiveUnitInCombat: '空战前返航，该格须至少留 1 架保持激活并参与空战（14.3d A）',
  noVoluntaryReturnDuringAirCombat: '空战进行中双方都不能主动返航（14.3d B）',
  missionAircraftLimitExceeded: '一次任务的空军单位合计超过上限（14.2a）',
  // ── 14.5 拦截资格 ──
  missionAlreadyIntercepted: '该任务已经被拦截过一次（每个任务只能被拦截一次，14.5）',
  missionHexOutsidePatrolZone: '任务格不在拦截方的巡逻区内（14.5）',
  missionNotFlakAffected: '该任务类型不受防空影响，不能拦截（14.4a）',
  noActiveFighterInPatrolZone: '巡逻区内没有可用的激活战斗机（14.5）',
  // ── 14.11 基地转移 ──
  beyondDoubleRange: '基地转移的距离超过该机射程的两倍（14.11）',
  // ── 15.1 整备（原文子项作 A)/B)/C)/D) 行，此处记作 15.1 A 等）──
  refitOnlyInAircraftRefitPhase: '整备只能在飞机整备阶段进行（15.1 A）',
  baseAlreadyRefitThisPhase: '该空军基地本整备阶段已经整备过一次（15.1 A）',
  unnegatedEnemyZoc: '该基地处在未被抵消的敌方 ZOC 内，不能整备（15.1 C）',
  refitCapacityExceeded:
    '申请的飞机数超过该基地本阶段的整备容量（基地等级×2、简易机场 1 架，15.1 B、15.2 B）',
  insufficientRefitT: '整备需要 1 T，可动用运输点数不足（15.1 B）',
  // ── 15.4 空军基地缩减 ──
  reductionOnlyInMovementPhase: '空军基地的缩减只能在移动阶段进行（15.4）',
  baseAlreadyReducedThisPhase: '该空军基地本阶段已经缩减过（15.4）',
  airBaseLevelCannotGoBelowOne: '一级空军基地不能再缩减（最低到一级，15.0c）',
  reducingUnitNotEligible: '该格没有指定执行缩减的作业单位（15.4）',
  reducingUnitAlreadyMoved: '被指定执行缩减的单位本阶段已经移动过，须不能移动（15.4）',
  reducingUnitMustBeCombatMode: '被指定执行缩减的单位须处于战斗模式（15.4）',
  reducingUnitNotInBaseHex: '被指定执行缩减的单位不在目标基地格内（15.4）',
  reducingUnitTooFarFromBase:
    '具工程能力的单位距目标基地超过 2 格步行 MP，不能执行缩减（13.8d/15.4）',
  reducingUnitsReBelowMinimum: '被指定单位的 RE 合计不足 1，其中也没有具工程能力的单位（15.4）',
  // ── 专规 1.4a 图外空军盒 ──
  offMapBoxBeyondRange: '从图外空军盒出动的距离超出该盒的任务射程（专规 1.4a）',
  // ── 专规 1.4b 边缘盒 ──
  edgeBoxSovietOnly: '边缘盒只有苏军可以使用（专规 1.4b）',
  edgeBoxGroundUnitsOnly: '边缘盒只供地面单位使用（专规 1.4b）',
  edgeBoxMovementPhaseOnly: '边缘盒只能在本方移动阶段进出（反应／进击阶段不得进出，专规 1.4b）',
  edgeBoxNeedsSupplySourceHex: '边缘盒只能与本方地图边缘的补给源格之间移动（专规 1.4b）',
}

export const CONSTRUCTION_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 建造公共前提（通规 13.8d / 13.8a）──
  constructionOnlyInMovementPhase: '建造只能在移动阶段进行（13.8d）',
  requiresEngineerCapability: '该单位不具备工程能力（须处于战斗模式，DG 时须朝向战斗面，13.8a）',
  builderMovedThisPhase: '施工单位本阶段已经移动过，不能再建造（13.8d）',
  oneHexPerPhase: '施工单位本阶段已经在一格施工过（13.8d）',
  oneTaskTypePerPhase: '施工单位本阶段已在做另一种建造作业（13.8d）',
  targetBeyondConstructionRadius: '目标格超出建造半径（2 格，按步行 MP 量取且无视敌方 ZOC，13.8d）',
  // ── 环形工事（通规 16.0b 修建 / 16.0c 缩减）──
  noOperatingUnits: '没有被指定参与施工的单位（16.0b）',
  operatingUnitAlreadyMoved: '被指定参与施工的单位本阶段已经移动过（16.0b）',
  operatingUnitMustBeCombatMode: '被指定参与施工的单位须处于战斗模式（16.0b）',
  operatingUnitsReBelowMinimum: '被指定参与施工的单位 RE 合计不足 1（16.0b）',
  hedgehogAtMaxLevel: '该格环形工事已到最高等级（16.0b）',
  hedgehogAlreadyImprovedThisTurn: '该格本回合已经提升过环形工事（每回合最多 +1 级，16.0b）',
  hedgehogAlreadyReducedThisTurn: '该格本回合已经缩减过环形工事（每回合最多 −1 级，16.0c）',
  insufficientSpForHedgehog: '修建环形工事的 SP 不足（16.0b）',
  noHedgehogInHex: '该格没有环形工事可缩减（16.0c）',
  enemyHedgehogCannotBeReduced: '不能缩减敌方环形工事，只能缩减己方工事（16.0c）',
  printedPermanentHedgehogCannotBeReduced: '印刷在地图上的永久工事不能缩减（专规 1.3a）',
  sovietCannotBuildHedgehogBefore: '苏军在 1941-08-01 回合之前不能修建环形工事（专规 2.3e）',
  // ── 空军基地 / 简易机场（通规 15.3 / 15.2A）──
  airBaseAtMaxLevel: '空军基地已到最高等级（三级，15.3）',
  airBaseAlreadyImprovedThisTurn: '该空军基地本回合已经提升过等级（每回合 +1 级，15.3）',
  insufficientSpForAirBase: '修建／改进空军基地需要 1 SP，可动用补给不足（15.3）',
  airFacilityPerHexLimit: '一格内只能有一个机场设施（4.8）',
  airBaseTargetIsEnemy: '目标格是敌方空中设施，须先按 9.14f 夺取后才能使用（15.3 / 15.2A）',
  airBaseTargetIsMarkerAirstrip: '目标格已有建造标记的简易机场（一格一设施，15.0a / 专规 3.5）',
  insufficientTForAirstrip: '修建简易机场需要 1 T，可动用运输点数不足（15.2 A）',
  insufficientTForAirstripUpgrade:
    '简易机场升级为一级空军基地需要 3 T，可动用运输点数不足（15.2 A）',
  noAirstripToUpgrade: '该格没有简易机场可升级（15.2）',
  // ── 建造标记（专规 3.5）──
  constructionMarkerIsAxisOnly: '建造标记只有轴方可以放置（专规 3.5）',
  constructionMarkerOnlyInMovementPhase: '建造标记只能在移动阶段放置（专规 3.5）',
  constructionMarkerMustBePlacedBeforeMovement: '建造标记须在该阶段单位移动之前放置（专规 3.5）',
  constructionMarkerAlreadyUsed: '该枚建造标记已经用过（每枚只能用一次，专规 3.5）',
  constructionMarkerRequiresAxisCombatUnit: '放置建造标记的格须有轴方战斗单位（专规 3.5）',
}

export const RAIL_CODE_TEXT: Readonly<Record<string, string>> = {
  // ── 铁路运输三段（通规 13.3e 登车 / 移动 / 卸货）──
  railOnlyInMovementPhase: '铁路运量只能在移动阶段使用（13.3b）',
  emptyPath: '铁路移动的路径为空（13.3e）',
  pathMustStartAtCargoHex: '铁路路径的起点不是货物所在格（13.3e）',
  pathMustEndAtDestination: '铁路路径的终点不是目的地格（13.3e）',
  entrainHexHasNoRail: '登车格不是铁路格（13.3e-1）',
  entrainHexNotDetrainable:
    '登车格不是可火车卸货格（须村庄/城市/港口/有工程能力的指挥部、已控制并连通补给源，13.3c、13.3e-1）',
  entrainHexInEnemyZoc: '登车格在敌方 ZOC 内（13.3e-1；运货时 EZOC 不可抵消，13.3c）',
  entrainHexEnemyOccupied: '登车格被敌方单位占据（13.3e-1、13.3h）',
  entrainHexWrongGauge: '登车格是错误轨距（13.3f）',
  pathNotRailConnected: '铁路路径不连续：相邻两格之间没有铁路相接（13.3e-2）',
  pathHexHasNoRail: '途经格不是铁路格（13.3e-2）',
  pathHexWrongGauge: '途经格是错误轨距（13.3f）',
  pathHexEnemyCombatUnit: '途经格有敌方战斗单位（13.3e-2）',
  pathHexEnemyOccupied: '途经格被敌方单位占据（13.3e-2、13.3h）',
  pathHexInEnemyZoc: '途经格在敌方 ZOC 内（13.3e-2）',
  detrainHexHasNoRail: '卸货格不是铁路格（13.3e-3）',
  detrainHexWrongGauge: '卸货格是错误轨距（13.3f）',
  detrainHexNotDetrainable:
    '卸货格不是可火车卸货格（须村庄/城市/港口/有工程能力的指挥部、已控制并连通补给源，13.3c、13.3e-3）',
  detrainHexEnemyCombatUnit: '卸货格有敌方战斗单位（13.3e-3）',
  detrainHexEnemyOccupied: '卸货格被敌方单位占据（13.3e-3、13.3h）',
  detrainHexInEnemyZoc: '卸货格在敌方 ZOC 内（13.3e-3）',
  // ── 单位自身资格（通规 5.6a / 5.10d / 4.7d）──
  dgUnitCannotRail: '脱序（DG）单位不能使用铁路运输（5.10d）',
  railRequiresMoveMode: '铁路运输须处于移动模式（铁路修理单位可在战斗模式，13.3g-B）',
  preLoadMpExceedsHalfMa: '登车前已消耗超过一半的 MA（13.3e-1、4.7d）',
  // ── 轨距转换（通规 13.3f / 13.3g）──
  notRailRepairUnit: '只有铁路修理单位能转换轨距（13.3g）',
  conversionOnlyInMovementPhase: '轨距转换只能在移动阶段进行（13.3g-D）',
  targetHexHasNoRail: '所选格不是铁路格（13.3f）',
  enemyZocCannotConvert: '不能在敌方 ZOC 内转换轨距（EZOC 不可抵消，13.3f-A）',
  mustBeCombatMode: '换轨单位须处于战斗模式（DG 时须朝向战斗面，5.10e、13.3g-D）',
  conversionLimitReached: '本阶段换轨格数已到上限（最多 4 格或当前 MA，13.3g-D）',
  noLeapfrogging: '本阶段已用刚换轨的格做铁路移动，不能再换轨（不得接力，13.3g-A）',
  // ── 剧本初设换轨（专规 1.2）──
  convertedRunDisconnected: '剧本初设换轨的两端之间没有铁路相通（专规 1.2）',
  convertedRunAmbiguous: '剧本初设换轨的走线不唯一，无法确定逐格清单（专规 1.2）',
  // ── 运输点数的合并 / 拆分（通规 13.2c）──
  transportPointOpsOnlyInMovementPhase: '运输点数的合并／拆分只能在移动阶段进行（13.2c）',
  transportPointOpsOnlyInFriendlyPhase: '运输点数的合并／拆分只能在本方移动阶段进行（13.2c）',
  mergeNeedsAtLeastTwoPoints: '合并至少要选两个运输点数（13.2c）',
  differentTypesCannotMerge: '不同类型的运输点数不能合并（含编内卡车，13.2c）',
  differentHexesCannotMerge: '待合并的运输点数不在同一格（13.2c）',
  splitNeedsAtLeastTwoParts: '拆分至少要给出两份（13.2c）',
  badSplitSize: '拆出的每一份都必须是正数（13.2c）',
  splitSumMismatch: '拆分后各份合计不等于原规模（13.2c）',
  // ── 运输点数装卸（通规 13.2f / 13.2g-A）──
  loadRequiresDumpInHex: '装载 SP 必须与补给站同格（13.2f）',
  unloadRequirementsNotMet:
    '该格不满足卸载条件（须友方战斗单位／港口／空军基地／已卸载的补给站，13.2f）',
  organicTruckCannotUnload: '编内卡车永远不能在地图上卸载 SP（13.2g-A）',
}

/** 各模块表合并后的唯一查询面（重名键由 `audit:error-text` 拦截，不静默覆盖） */
export const RULE_CODE_TEXT: Readonly<Record<string, string>> = {
  ...LEGALITY_CODE_TEXT,
  ...WORKBENCH_CODE_TEXT,
  ...SESSION_CODE_TEXT,
  ...TERRAIN_CODE_TEXT,
  ...BATTLE_CODE_TEXT,
  ...AIR_MISC_CODE_TEXT,
  ...SPECIAL_RULES_CODE_TEXT,
  ...FINAL_CODE_TEXT,
  ...SUPPLY_CACHE_CODE_TEXT,
  ...EXTENDER_CODE_TEXT,
  ...SPECIAL_COMBAT_CODE_TEXT,
  ...SUPPLY_PHASE_CODE_TEXT,
  ...AIR_UNIT_MOVE_CODE_TEXT,
  ...SETUP_CODE_TEXT,
  ...BREAKDOWN_CODE_TEXT,
  ...REBUILD_CODE_TEXT,
  ...BREAKOUT_CODE_TEXT,
  ...AIR_CARGO_CODE_TEXT,
  ...AIR_SUPPLY_CODE_TEXT,
  ...AIR_ROSTER_CODE_TEXT,
  ...AIR_UNLOAD_CODE_TEXT,
  ...SUPPLY_CODE_TEXT,
  ...CONTAINERS_CODE_TEXT,
  ...ARRIVAL_CODE_TEXT,
  ...AIR_MISSION_CODE_TEXT,
  ...CONSOLIDATION_CODE_TEXT,
  ...RAIL_CODE_TEXT,
  ...CONSTRUCTION_CODE_TEXT,
}
