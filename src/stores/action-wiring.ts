/**
 * 「界面能点到、但 store **不按环节放行**」的动作 —— **逐条登记归类**
 *
 * 背景（`docs/环节-UI-缺口清单.md` §3）：审计时发现一批"改盘面但无环节闸门"的动作。
 * 逐条核过原文后，它们并不是同一种东西，只有**第一类**才是真缺口：
 *
 * | kind | 含义 | 处理 |
 * |---|---|---|
 * | `gated` | 原文给了**明确时机**，应当按环节放行 | store 入口里已加 `requireAction(key)`（本表只做**核对**） |
 * | `referee` | **裁判工具**：改值 / 订正 / 摆件 / 自动环节的手动退路 —— 规则里不是"玩家在某个环节的动作" | 不设环节闸；**界面对局台一律按 `showsReferee` 不铺**（`useRefereeTools()` ＝ ui-mode 为 `verify`），只在引擎验证页可用 |
 * | `playerStep` | **玩家本环节要做的事**，只是不属 `ACTION_GATES` 那套"宣布类动作"：掷表触发、落位选择、记忆标记 | 不设环节闸（环节已由 `segmentIn` 控显隐）；**对局台必须留着** —— 塞进 `showsReferee` 会把流程锁死 |
 * | `flowState` | 由**步进状态机**约束（`airState` / `combatState` / `barrageState` / `supplyState` / `moveInteraction` / `breakoutReturns` 的回合） | 不另设环节闸：没开局这些入口根本走不通（比环节闸更窄） |
 * | `noTiming` | 原文**给了这个动作、但没给时机**（或明说"任何阶段"） | **不加闸** —— 加闸就是发明规则（项目铁律：取保守值，不施加规则未明定的效果） |
 * | `pickMode` | "点地图选格"的选格态开关 | 不落盘，落盘在各自的 apply/place 入口 |
 * | `draft` | 只改待提交的输入 / 勾选集合 | 不落盘 |
 * | `pregame` | 初设 / 剧本 / 开局 | 不在 2.2 的环节体系内 |
 *
 * 为什么要有这张表：`panel-section-nesting` 那类守卫只管"哪段显示"，管不到"点了会不会
 * 绕过时机"。这里把每个**写盘面**的入口钉一个归属，`tests/stores/action-wiring.test.ts`
 * 逐条核对 —— 以后新增一个写盘面却不分类的入口，测试会红。
 */

/** 分类词表（见文件头） */
export type UngatedKind =
  | 'gated'
  | 'referee'
  /** 玩家本环节要做的事（掷表触发 / 落位选择 / 记忆标记）：对局台要留 */
  | 'playerStep'
  | 'flowState'
  | 'noTiming'
  /** 打开"点地图选格"态：只改选择模式，不落盘 */
  | 'pickMode'
  /** 只改待提交的输入 / 勾选集合 */
  | 'draft'
  /** 初设 / 剧本 / 开局（不在 2.2 的环节体系内） */
  | 'pregame'

export interface UngatedEntry {
  kind: UngatedKind
  /** 归类的理由（有原文的一律附条文号） */
  why: string
  /** `kind === 'gated'` 时：store 入口里应当出现的闸门键 */
  key?: string
}

/**
 * 按**形状成批归类**的几组（同组同名同类，逐条写 'why' 只是噪音）
 *
 * 这些组的共同点：它们**不是"某个环节里的规则动作"**，所以不该有环节闸。
 * 真正需要按环节放行的，一律走上面那条路（store 入口里 `requireAction`，此处核对）。
 */
const BULK: readonly { kind: UngatedKind; why: string; names: readonly string[] }[] = [
  {
    kind: 'pickMode',
    why: '打开"点地图选格"态：只改选择模式与提示，不落盘（落盘发生在各自的 apply/place 入口）',
    names: [
      'beginAirBaseHexPickNow',
      'beginAirPlacementHexPickNow',
      'beginAirReturnBasePickNow',
      'beginAirTargetHexPickNow',
      'beginAirTransferHexPickNow',
      'beginArrivalPlacePickNow',
      'beginCityControlHexPickNow',
      'beginConstructionMarkerHexPickNow',
      'beginConvertTargetHexPickNow',
      'beginDeadPileReturnHexPickNow',
      'beginDrawShiftHexPickNow',
      'beginFormationMarkerHexPickNow',
      'beginHedgehogHexPickNow',
      'beginHexPick',
      'beginEdgeBoxExitHexPickNow',
      'beginRailGaugeTargetHexPickNow',
      'beginRailMoveHexPickNow',
      'cancelHexPick',
      // 裁定 3：铁路运输的待确认态（点目的地只进确认窗；确认窗的落盘另有闸）
      'beginArrivalRailPickNow',
      'cancelRailTransportNow',
      'beginReplPlaceHexPickNow',
      'beginFreeRailEdgeHexPickNow',
      'beginSupplyTrainHexPickNow',
      'setSupplyTrainGroup',
      'beginRebuildReplHexPickNow',
      'beginSpDumpHexPickNow',
      'toggleConstructionPayPick',
      'toggleHedgehogPayPick',
      'beginSupplySourceHexPickNow',
      'armConstructionMarkerNow',
      // 13.5：死亡堆持项选中/预选重建对象——只改选择态（选中 + 自动映射行键），付费落盘在 rebuildUnitNow
      'pickDeadPileUnitNow',
      'selectRebuildUnitNow',
    ],
  },
  {
    kind: 'pregame',
    why: '初设 / 剧本 / 开局：不在 2.2 的环节体系内（初设期由「初设与开局」面板与决策队列管）',
    names: [
      'beginAirPlacement',
      'placeAirInOffMapBoxNow',
      'beginSelfPlacement',
      'beginShiftPlacement',
      // 3.4b：摆一个确认一个 / 已预摆 SP 的点选归属，都在初设期内完成
      'choosePendingSpGroup',
      'pickPendingOwnershipHex',
      'beginTruckPick',
      'cancelPlacement',
      'cancelTruckPick',
      'pickTruckInstance',
      'confirmSideSetup',
      'confirmSpOwnership',
      'designateTrucks',
      // 初设确认时的自动抽取（完成初设同一笔事务）；本函数是旧档/程序化补做入口
      'drawSetupEffectsNow',
      'resetAll',
      'resetSetupDraws',
      'runAirSetup',
      'runAutoSetup',
      'presetSelfSetupNow',
      'selectScenario',
      'setAirChoice',
      'setDrawShiftHexNow',
      'setPlacingChunk',
      'setSelfChoice',
      'setSpAssignment',
      'startGameNow',
      'toggleTruckFull',
      'applyShiftWestPlacementsNow',
      // H5：撤回上一步初设落位（初设期内，快照整体还原）
      'undoLastPlacementNow',
    ],
  },
  {
    kind: 'referee',
    why: '记录轨与落盘的**手动改值**：2.2 回合推进 / 专规 1.2 铁路容量 / 1.5 天气 / 到达卡落点手改；对局台按 showsReferee 不铺',
    names: [
      'advanceTurnMarker',
      'applyRailCapacityForDate',
      'setRailCapacity',
      'setWeatherMarker',
      'setArrivalHexOverride',
    ],
  },
  {
    kind: 'flowState',
    why: '由**步进状态机**约束（combatState / barrageState / airState / moveInteraction）：没开局走不通，比环节闸更窄',
    names: [
      'abortMoveNow',
      'advanceNow',
      'applyOptionDraftLoss',
      'applyOptionDraftRetreatFor',
      'beginAirBarrageNow',
      'cancelMovePick',
      'cancelRefitNow',
      'cancelSpecialCombatNow',
      'clearCombat',
      'completeAirReturnNow',
      'confirmAirCargoLossNow',
      'confirmAirCombatNow',
      'resolveAirCargoNow',
      'autoResolveAirMissionNow',
      'confirmRefitSelectionNow',
      'confirmRefitPaymentNow',
      'confirmBarrageOutcomeStep',
      'confirmBarrageShiftsStep',
      'confirmBarrageSupplyStep',
      'confirmCombatAdvance',
      'confirmCombatIgnoreOptions',
      'confirmCombatLosses',
      'confirmCombatOptions',
      'confirmCombatRetreats',
      'confirmCombatSupply',
      // 9.10c：守方忽略自己的选项（攻方撤退或无法完成全部选项时出现）
      'confirmCombatIgnoreOptions',
      'confirmMovePick',
      'confirmSpecialCombatNow',
      'declareCombatArStep',
      'declareCombatTerrainStep',
      'dropUnitFromMove',
      'finishMove',
      'lockZocNegation',
      'resolveBattleNow',
      'rollBarrageDiceStep',
      'rollCombatDice',
      'rollCombatSurprise',
      'undoLastStep',
    ],
  },
  {
    kind: 'draft',
    why: '只改"待提交的输入"或勾选集合（谁参战 / 谁加注 / 哪一格），不落盘',
    names: [
      'addBarrageLossPoint',
      'cancelTransferNow',
      // 9.12e：只写"谁来承受额外损失"的待提交意图（候选由引擎预演给出，确认时才仲裁）
      'chooseExtraLossTaker',
      'clearAdvanceNow',
      'clearNonSavableReplNow',
      'clearSupplyPhasePlan',
      // 9.5 热座：只翻"这一方已确认补给"的标记，付款仍由 confirmCombatSupply 一次落盘
      'confirmCombatSupplySide',
      'pickCombatSupplyDump',
      'pickFuelDump',
      'removeBarrageLossPoint',
      'setAirActive',
      'setAirMissionKind',
      'setAirTargetFromText',
      'setArrivalSpGroup',
      'setAttritionAllocation',
      'setBarrageActive',
      'setBarrageTargetKind',
      'setBattleMode',
      'setHoverHex',
      'setPopupCard',
      'setSpDumpDraftGroup',
      'setSupplyActive',
      'setSupplyPreview',
      'toggleAdvanceUnit',
      'toggleAirCargoLossPick',
      'toggleAirCargoUnit',
      'toggleAirMissionUnit',
      'toggleBarrageAirUnit',
      'toggleBarrageSupplyDump',
      'toggleBarrageUnit',
      'toggleCardOpen',
      'toggleCombatSupplyAttacker',
      'toggleCombatTagalong',
      'toggleFreeRailPick',
      'toggleOverrunParticipant',
      'toggleRefitAircraft',
      'toggleSupplyPayDump',
      'toggleTransportMerge',
      'toggleTransferAircraft',
      'undoOptionDraftLast',
    ],
  },
]

/** 把批量桶摊平成一格一条 */
function bulkEntries(): Record<string, UngatedEntry> {
  const out: Record<string, UngatedEntry> = {}
  for (const group of BULK) {
    for (const name of group.names) out[name] = { kind: group.kind, why: group.why }
  }
  return out
}

/**
 * 登记表（键＝store 的函数名；与 `docs/环节-UI-缺口清单.md` §3 的表同源）
 *
 * 分组只为好读，判据与分组无关。
 */
export const UNGATED_ACTIONS: Readonly<Record<string, UngatedEntry>> = {
  ...bulkEntries(),
  advanceSegmentNow: { kind: 'flowState', why: '统一阶段执行器先结清规则义务，再按会话状态推进' },
  // 4.8a：超堆叠义务的勾选是草稿；落盘只在 destroyOverstackPicksNow（时机由推进闸门把住）
  toggleOverstackPick: {
    kind: 'draft',
    why: '只改"该格拟摧毁哪几枚"的勾选集合，不落盘；落盘在 destroyOverstackPicksNow',
  },
  // 4.8a：原文的时机是"任何环节或阶段结束时"，不是某个宣布类动作的窗口 ⇒ 不设 ACTION_GATES；
  // 由 segmentAdvanceBlock 在换段/换阶段时拦截（含自动段），未回到 ≤10 RE 连推进都不许。
  destroyOverstackPicksNow: {
    kind: 'noTiming',
    why: '4.8a 时机="任何环节或阶段结束时"，闸门在同一次推进的 segmentAdvanceBlock，不属 ACTION_GATES',
  },
  // 裁定 3：确认窗的分派器——实际落盘各走 railMoveNow（move.railTransport 闸）/
  // confirmArrivalRailNow → placeArrivalNow（rein.arrival 闸），本入口只清待确认态
  confirmRailTransportNow: {
    kind: 'flowState',
    why: '铁路运输确认窗分派：按待确认态的 kind 转给已带环节闸的移动/增援路径',
  },
  restartGameNow: { kind: 'pregame', why: '终局后重建整局盘面与初设，不是阶段内行动' },

  // 13.5：死亡堆持项的"不可回场原因"——纯查询（只 `deadPile.value.find`），不改任何状态
  deadPileRebuildBlockedReason: {
    kind: 'noTiming',
    why: '纯查询：按 13.5c / 13.5 / 13.5a 说明哪条挡住这枚持项，只读不落盘',
  },

  // 13.9-1：整编会话的**堆叠作用域**（右键带入哪一格），只改草稿态，不落盘
  clearConsolidationPick: {
    kind: 'draft',
    why: '会话收起时清掉右键带入的堆叠作用域；落盘发生在 consolidateUnitsNow',
  },
  mergeRemoveUnits: {
    kind: 'draft',
    why: '只读投影：按同格预演列出"可移除伙伴"给整编会话选，`units.value` 仅用于取单位，不落盘',
  },
  // 专规 4.3（可选）A：初设拆团的落点候选（母师两格内）——纯查询，`units.value` 只用来找母师
  setupBreakdownCandidates: {
    kind: 'draft',
    why: '纯查询：列初设拆团的落点候选（母师两格内），只读不落盘；落盘在 takeBreakdown',
  },
  // #13：取子勾选本身是草稿；同一入口按 12.5c-A 给"同格同编队、该编队已付过 1SP"的单位补记
  // `fuelled`（`applyFormationFuelCoverage`）。补记**不重复扣 SP**——付款账本仍只在 payFuel。
  toggleMovePick: {
    kind: 'draft',
    why: '勾选集合是待提交输入；顺带按 12.5c-A 补记同格同编队的编队油（付款已在 payFuel 一次付清，此处不扣账）',
  },
  focusAirMissionBase: {
    kind: 'pickMode',
    why: '点基地分栏只改聚焦栏与地图高亮（复用 setHoverHex 的既有通道），不落盘',
  },
  acknowledgeReinforcementStepNow: {
    kind: 'draft',
    why: '增援段单窗推进：只记"本步已完成"的窗口标记，不落盘、不改账本',
  },
  // v7.1 第一段（2026-11-11）：到达/慢动员的「结束本段」——段内唯一出口，显隐由 segmentStep 控
  endArrivalSegmentNow: {
    kind: 'playerStep',
    why: '第一段到达的收束按钮（v7.1 §2.2）：只记本段窗口标记并推进，不落盘；手牌/移除前置校验在函数内',
  },
  endSlowMobilizationSegmentNow: {
    kind: 'playerStep',
    why: '第一段慢动员的收束按钮（2.3 提交后进第二段）：只记本段窗口标记并推进，不落盘',
  },
  // 3.4b：到达投放前的集群草稿；真正落账在 placeArrivalNow（有环节闸）
  setTransportSpGroupDraftNow: {
    kind: 'draft',
    why: '只改"这批运输点带来的 SP 归哪个集群"的待提交选择，不落盘；落账发生在 placeArrivalNow',
  },
  // 14.2f-G：返航三选一的落点选择，只改待提交输入；落盘在 completeAirReturnNow
  chooseAirReturnDepartureNow: {
    kind: 'draft',
    why: '只把 returnHexText 指回出发基地，不落盘；返航落盘在 completeAirReturnNow',
  },
  chooseAirReturnOffMapBoxNow: {
    kind: 'draft',
    why: '只把 returnToBox 标记为 true，不落盘；进盒发生在 completeAirReturnNow',
  },
  // 13.2f：装卸窗的待提交选择（点哪枚点数、数量），落账在 load / unload（有环节闸）
  selectTransportLoadPointNow: {
    kind: 'draft',
    why: '只改装卸窗的待提交输入（pointId / loadAmount / unloadAmount），不落盘；落账发生在 loadTransportPointNow / unloadTransportPointNow',
  },

  // 专规 2.4：原文只写"按此表动员"，**未给时机** ⇒ 不加环节闸（v7.1：累计解锁，见下）
  slowMobilizationLockedOf: {
    kind: 'noTiming',
    why: '2.4 只读查询：列出某集团军仍锁定的师供面板勾选（`units.value.filter` 只是读盘面，落盘在 unlockSlowMobilizationBatch）',
  },
  unlockSlowMobilizationBatch: {
    kind: 'noTiming',
    why: '专规 2.4 只写「mobilized per this table」，原文未给时机 ⇒ 不加闸；配额按表 2-2 当日值，累计态由算子 locked 旗标承载（v7.1 2026-11-11）',
  },

  // 专规 3.4a：原文「place a DG … at the end of any phase」——"相位末"的具体归属（§5 A/B）未裁定，
  // 入口只校验义务名单后落 DG（5.10），不擅自扩大相位范围，也不另设环节闸
  applyPanzerGroupDgNow: {
    kind: 'noTiming',
    why: '3.4a 的义务由 `panzerGroupObligations` 给出（19 Aug 前、多单位编队）；本入口只做「有义务即可投」，相位口径待裁定',
  },

  /* ── 已加闸（原文给了明确时机）—— 本表用于**核对**，不是"未处理" ── */

  // 1.6a：到达卡要求"移除"时立即移出（B 增援·到货落位）
  applyArrivalRemovalsNow: {
    kind: 'gated',
    key: 'rein.arrival',
    why: '1.6a「…is immediately removed from play」⇒ 到达卡的一部分',
  },
  removeForeverNow: {
    kind: 'gated',
    key: 'rein.rebuild',
    why: '13.5c 永久移出：死亡堆右键菜单就在 B 段重建环节（另放行到货落位 1.6a 入口）',
  },
  // 15.3 / 15.2A：「空军基地只能在移动阶段中修建或改进」
  buildAirstripNow: {
    kind: 'gated',
    key: 'move.construction',
    why: '15.3「只能在移动阶段中修建或改进」',
  },
  upgradeAirstripNow: {
    kind: 'gated',
    key: 'move.construction',
    why: '15.2A 按 15.3 的流程（3T 升级为一级基地）',
  },
  // 12.8b：损耗在补给阶段
  rollAttritionNow: {
    kind: 'gated',
    key: 'supply.attrition',
    why: '12.8a「在补给阶段中…并检查损耗」',
  },
  // 12.5c：加注与付燃料同一道闸
  setUnitFuelled: {
    kind: 'gated',
    key: 'supply.fuel',
    why: '12.5c「在燃料消耗时支付」；修前 payFuel 有闸、这个开关没有',
  },
  // 12.7d 翻回 / 9.14d 崩溃：移动环节
  flipExtenderToTransport: {
    kind: 'gated',
    key: 'move.extenderConvert',
    why: '12.7d「翻面要消耗一半的 MA」⇒ 属移动环节',
  },
  collapseExtenderNow: {
    kind: 'gated',
    key: 'move.extenderConvert',
    why: '9.14d「可在移动环节用它替代常规移动」',
  },
  // 13.2c 合并/拆分（只在移动阶段）
  mergeTransportPointsNow: {
    kind: 'gated',
    key: 'move.transportMerge',
    why: '13.2c「只能在友方移动阶段中进行」',
  },
  splitTransportPointNow: {
    kind: 'gated',
    key: 'move.transportMerge',
    why: '13.2c 同上',
  },
  /*
   * 专规 ch10/ch11 的抽签：**只在初设确认之后执行一次**（`setup.drawSetupEffectsNow`，
   * 入口可见条件 `setup.setupDrawEntryVisible`）。增援段 / 回合开始 / 阶段切换都不再有抽签窗口。
   * 下面两个是内部步骤，由初设抽签驱动，不单独出口。
   */
  drawFormations: {
    kind: 'referee',
    why: '抽签的内部步骤（由 setup.drawSetupEffectsNow 驱动，无独立入口）',
  },
  applyDraw: {
    kind: 'referee',
    why: '抽签落盘的内部步骤（由 setup.drawSetupEffectsNow 驱动，无独立入口）',
  },
  useConstructionMarkerNow: {
    kind: 'gated',
    key: 'move.construction',
    why: '专规 3.5「任一轴方移动阶段、在单位移动之前」',
  },

  /* ── 裁判工具（改值 / 订正 / 摆件 / 自动环节的手动退路）⇒ 对局台按 showsReferee 不铺 ── */

  setConstructionMarkersNow: { kind: 'referee', why: '专规 3.5 的枚数是剧本给定值，手改属订正' },
  setMultiUnitFormationNow: {
    kind: 'referee',
    why: '3.4 的编队归属由素材编队目录推出，手改属覆盖',
  },
  setPanzerGroupNow: { kind: 'referee', why: '3.4 集群归属的**手工覆盖**' },
  /*
   * 3.4b：「**All new Axis SP must immediately be assigned to a panzer group**」——
   * 这是**玩家的义务**（不归属就没法用那批 SP 支付多单位编队的燃油/战斗/轰炸），
   * 不是裁判订正 ⇒ `playerStep`（对局台必须留）。
   */
  setDumpPanzerGroupNow: {
    kind: 'playerStep',
    why: '3.4b「所有新到的轴心国 SP 必须立即归属某一装甲集群」：玩家声明，不是裁判代录',
  },
  toggleAxisCityControlNow: {
    kind: 'referee',
    why: '3.3b 的城市控制状态由裁判维护（原文未把它交给某个环节）',
  },
  setVictoryControlNow: { kind: 'referee', why: '5.0a 胜利判定的控制格由裁判维护' },
  checkVictoryNow: { kind: 'referee', why: '5.0a 随时可查的判定，不是某环节的动作' },
  addAirUnit: { kind: 'referee', why: '摆件（界面上只在验证页）' },
  removeAirUnit: { kind: 'referee', why: '摆件（界面上只在验证页）' },
  toggleAirstripBase: { kind: 'referee', why: '15.0/15.2 的空设施类型标注（数据维护）' },
  addSpDump: { kind: 'referee', why: '12.1a 只允许"同格内拆分/加总"，**凭空建站**是裁判代录' },
  removeSpDump: { kind: 'referee', why: '12.11a 的玩家销毁走 move.dumpBlow；此处是裁判删账' },
  addSupplySource: { kind: 'referee', why: '12.6a 的补给源来自专规/剧本，手录属代录' },
  removeSupplySource: { kind: 'referee', why: '12.6a 的补给源来自专规/剧本，删录同属裁判代录' },
  addSupplyCacheNow: {
    kind: 'referee',
    why: '1.7 每方开局 2 枚，追加只经 1.6c（`drawSpecialRepl` 内部直接调用本函数，故此处不设闸）',
  },
  seedConvertedRailsNow: {
    kind: 'referee',
    why: '13.3f 换轨的玩家动作走 move.railConversion；此处是账本代录',
  },
  clearConvertedRailsNow: {
    kind: 'referee',
    why: '13.3f 换轨账本的手工清空（同 seedConvertedRailsNow）',
  },
  setBreakdownPoolNow: { kind: 'referee', why: '20.0 拆分单位池的枚数订正' },
  /*
   * 专规 2.4：「(rotate the 'locked' units as a memory aid)」＋「The locked divisions are
   * mobilized per this table」—— 锁定面**由玩家翻转**（记忆辅助），解锁按表且
   * 「玩家在锁定师中自选」⇒ 两者都是 `playerStep`，不能塞进 `showsReferee`。
   */
  unlockSlowMobilizationNow: {
    kind: 'playerStep',
    why: '专规 2.4 表：按表解锁，且「玩家在锁定师中自选」',
  },
  setUnitLockedNow: {
    kind: 'playerStep',
    why: '专规 2.4「rotate the locked units as a memory aid」：玩家翻面标记',
  },
  resetContainers: { kind: 'referee', why: '清空全部盒子（裁判重置）' },
  captureAirBaseNow: {
    kind: 'referee',
    why: '9.14b–f 的夺取是"进入该格"的**结果**（由移动/战后推进触发，走 9.14 表）；界面这一处是裁判补录',
  },
  /*
   * 下面四条都是**玩家在本环节要做的事**，只是不属"宣布类动作"那套闸门：
   *   · 13.6b 的掷表：环节是 B 段的 `reinforcement.replRoll`（driver=`automatic` ⇒ 骰子自动，
   *     但**触发**在玩家手上；`segmentIn` 已把按钮限定在该环）；
   *   · 13.5 补员算子落位：SOP 13.5 没给入场格 ⇒ 由玩家选格（用户 2026-10-25 裁定⑩）；
   *   · 专规 2.1 免费铁运边缘格 / 3.6 补给列车格：落点由玩家指定（不印在卡上）。
   * 塞进 `showsReferee` 会让对局台**没法把这些东西放到图上**。
   */
  rollVariableReplNow: {
    kind: 'playerStep',
    why: '13.6b 掷表：环节＝B 段 replRoll（骰子自动，触发在玩家）',
  },
  placePendingReplNow: {
    kind: 'playerStep',
    why: '13.5 补员算子的落点由玩家选（SOP 13.5 无入场格规定）',
  },
  // v7.1 第二段（2026-11-11）：逐枚落位 / 收回——都只在宿主环「掷骰与统一放置」内可用
  withdrawReplPlacementNow: {
    kind: 'playerStep',
    why: '第二段的撤回（v7.1 §1.1）：只允许收回**本段**刚落的补员并把点数退回手牌；函数内以宿主环为准，离开本段即失效',
  },
  // v7.1 第二段统一手牌：1.6c 返场 / 2.3c 新单位的"落一枚 / 收一枚"同属本段放置阶段的撤回
  withdrawSpecialReplReturnNow: {
    kind: 'playerStep',
    why: '统一手牌里 1.6c 返场枚的收回：只允许收回**本段**刚返场的那一枚（退回死亡堆与手牌）；函数内以宿主环为准',
  },
  withdrawFrontalUnitNow: {
    kind: 'playerStep',
    why: '统一手牌里 2.3c 新单位的收回：只允许收回**本段**刚落的编制转化单位（退回手牌）；函数内以宿主环为准',
  },
  endRollSegmentNow: {
    kind: 'playerStep',
    why: '第二段的收束按钮（v7.1 §1.5）：只记本段窗口标记并推进；未掷骰 / 1.6c 未掷 / 撤离待选 / 预备队未领 / 手牌未清的前置校验在函数内',
  },
  // v7.1 第三段（2026-11-11）：重建 / 整编全部改成盘面右键入口
  beginDeadPileRebuildNow: {
    kind: 'pickMode',
    why: '13.5：死亡堆右键「重建」→ 只打开"点合法格"态；付费落盘在 rebuildUnitNow（有 rein.rebuild 闸）',
  },
  beginAirRebuildBasePickNow: {
    kind: 'pickMode',
    why: '13.5f 子项 1：飞机右键 → 只打开"点本方空军基地"态；付费落盘在 rebuildUnitNow',
  },
  runDeadPileActionNow: {
    kind: 'playerStep',
    why: '死亡堆菜单转发（重建/放基地/放盒/永久移除）；各分支各自判据，重建分支走 rebuildUnitNow 的 rein.rebuild 闸',
  },
  withdrawRebuildNow: {
    kind: 'playerStep',
    why: '第三段的撤回（v7.1 §1.1）：只允许收回**本段**刚重建的算子并退点；函数内以重建段为准，离开本段即失效',
  },
  withdrawRebuildAtHexNow: {
    kind: 'playerStep',
    why: '第三段"再点已重建单位即收回"的地图点击入口；只在重建段内、且该格恰好一枚本段重建对象时生效',
  },
  endRebuildSegmentNow: {
    kind: 'playerStep',
    why: '第三段收束按钮（v7.1 §4.6）：只推进到下一环节；补员点保留在盘面，不清空',
  },
  rebuildOnMapUnitNow: {
    kind: 'playerStep',
    why: '13.5a 第 2) 项：盘面打残单位右键重建，落点固定本格；费用与判据在引擎 planRebuild',
  },
  rebuildAircraftIntoBoxNow: {
    kind: 'playerStep',
    why: '13.5f 子项 2：点即移入本方地图外空军盒（1.4a 容量无限）；费用与判据在引擎 planRebuild',
  },
  consolidateSelectionNow: {
    kind: 'playerStep',
    why: '13.9：盘面多选右键整编；地面分支经 consolidateUnitsNow 的 rein.rebuild 闸，飞机分支按 13.9-4 不限阶段',
  },
  pickFreeRailEdgeHex: {
    kind: 'playerStep',
    why: '专规 2.1 免费铁运的边缘格由玩家指定（落点不印在卡上）',
  },
  pickSupplyTrainHex: { kind: 'playerStep', why: '专规 3.6 补给列车的格由玩家指定' },
  // 3.6 改为「点地图高亮铁路格即落 2 SP」，入口加 `rein.supplyTrain` 环节闸
  placeSupplyTrainSpNow: {
    kind: 'gated',
    key: 'rein.supplyTrain',
    why: '专规 3.6 只在轴方增援段随机事件掷出 Supply Train 后落 2 SP',
  },

  /* ── 由步进状态机约束（比环节闸更窄：没开局就走不通） ── */

  voluntaryReturnNow: { kind: 'flowState', why: '14.3d 主动返航只在 `airState` 的任务链里' },
  declareInterceptionNow: {
    kind: 'flowState',
    why: '14.2f-D 拦截应答是 `airState.step === interception`',
  },
  resolveFlakNow: { kind: 'flowState', why: '14.2f-E 防空是 `airState.step === flak`' },
  resolveInterceptionCombatNow: {
    kind: 'flowState',
    why: '14.5 拦截空战是 `airState.step === flak` 的子步',
  },
  runAirMissionNow: { kind: 'flowState', why: '14.2f 宣布 → 自动结算，入口在 `airState` 链上' },
  confirmAirMissionNow: { kind: 'flowState', why: '同上（`airState` 的步骤推进）' },
  settleAirMissionNow: {
    kind: 'flowState',
    why: '14.2f-F 面板 2 的唯一出口（先补跑战果/货物，再记录任务结算）',
  },
  chooseSupplySourceNow: {
    kind: 'flowState',
    why: '12.3 选来源是 `supplyState.step === selectSource`',
  },
  confirmSupplyPickupNow: {
    kind: 'flowState',
    why: '12.3 拖取/投递是 `supplyState.step === pickup`',
  },
  confirmOosResolutionNow: {
    kind: 'flowState',
    why: '12.6c/d 断补处置是 `supplyState.step === resolveOos`',
  },
  useForageNow: {
    kind: 'playerStep',
    why: '21.10b 玩家在 D 段做的事：入口自带 `phase === supply` 与 HQ 断补首回合判据；补给阶段面板只在该段渲染',
  },
  absorbBreakdownNow: {
    kind: 'flowState',
    why: '20.0d 吸收是**段末强制收束**（明确不按环节设闸）；函数体另按原文「只有在这种时机」要求 phase === cleanUp（H 清理）',
  },
  deployBreakoutReturnNow: {
    kind: 'flowState',
    why: '12.8e 返场受 `breakoutReturns[].returnsOnTurn` 的回合约束（比环节更窄）',
  },

  /* ── 只读谓词：界面只查结果，不写盘面（扫描把 `units.value` 读取当写盘而误报） ── */

  isRailRepairUnit: {
    kind: 'flowState',
    why: '只读谓词：13.3g 判定实例是否铁路修理单位（函数体内无任何写操作）',
  },
  canAbsorbBreakdownNow: {
    kind: 'flowState',
    why: '只读谓词：20.0d 判定此格此刻能否吸收拆分单位（`phase.value === cleanUp` 是读取，扫描误当写盘）',
  },

  /* ── 原文给了动作但没给时机（或明说"任何阶段"）⇒ 不加闸 ── */

  consolidateAircraftNow: {
    kind: 'noTiming',
    why: '13.9 第 4) 项「这可以**在任何阶段**进行（不仅仅是增援阶段）」⇒ 明确允许随时',
  },
  applySecurityNeedsNow: {
    kind: 'noTiming',
    why: '3.3b「可在**任意相位**放置」⇒ 明确允许随时',
  },
  splitSpDumpHoldings: { kind: 'noTiming', why: '12.1a 的拆分/加总**没有时机限制**' },
  mergeSpDumpHoldings: { kind: 'noTiming', why: '12.1a 同上' },
  setAirInBox: {
    kind: 'noTiming',
    /*
     * 专规 1.4a 原文只给**航程代价**，不给阶段：
     *   「Moving between the Soviet player's Red Air Force Box and the map's 62.xx row
     *     costs 20 hexes of range. … the Axis … 01.xx row costs 30 hexes of range.」
     * ⇒ 不加时机闸（原文没给）；但**射程必须够**，判据在 `planOffMapAirBoxFlight`（本轮接线）。
     */
    why: '1.4a 原文只给航程代价（苏 20 / 轴 30 格）、未给阶段 ⇒ 不设时机闸；射程判据见 planOffMapAirBoxFlight',
  },
  activateAirBox: {
    kind: 'noTiming',
    why: '1.4a「Any number of planes in these boxes can be refit each turn (no cost)」⇒ 盒内整备无时机限制',
  },
  hideInFormationBox: {
    kind: 'noTiming',
    why: '13.7 B「可以自由移动到标记中…这不需要额外消耗 MP」⇒ 原文明确不限时机',
  },
  revealFromFormationBox: {
    kind: 'noTiming',
    why: '13.7 B 同上（进出编队标记都不耗 MP、不限时机）',
  },
  moveEdgeBox: {
    kind: 'noTiming',
    /*
     * ★ 修（2026-10-30）：这里原写「1.4b 边缘盒：原文未给时机」——**与原文相反**。
     * 专规 1.4b：「During their **Movement Phase**, Soviet ground units (only) can move between …
     *   by spending 1 MP or by using Rail Cap. Note this is the only time that off-map movement is
     *   allowed by ground units (**no retreats and no entry/exit during the Reaction or Exploitation
     *   Phase**).」
     * ⇒ 时机有硬约束，只是判在**引擎**（`canEnterEdgeBox`：阵营 / 阶段 / 单位类型 / 边缘补给源格），
     *   不是 ACTION_GATES 的环节键，故 kind 仍记 noTiming（本表只登记"有没有环节键"），
     *   但 why 必须写清真实判据在哪，免得后人再把它当"无闸"。
     */
    why: '1.4b 时机是硬约束（仅本方 Movement Phase、禁 Reaction/Exploitation 进出）⇒ canEnterEdgeBox 判阶段，并复用 move.order 闸门排除突围环节',
  },
}
