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
      'beginAirReturnHexPickNow',
      'beginAirTargetHexPickNow',
      'beginAirTransferHexPickNow',
      'beginCityControlHexPickNow',
      'beginConstructionMarkerHexPickNow',
      'beginConvertTargetHexPickNow',
      'beginDeadPileReturnHexPickNow',
      'beginDrawShiftHexPickNow',
      'beginFormationMarkerHexPickNow',
      'beginFrontalReservesHexPickNow',
      'beginHedgehogHexPickNow',
      'beginHexPick',
      'beginRailGaugeTargetHexPickNow',
      'beginRailMoveHexPickNow',
      'beginRebuildReplHexPickNow',
      'beginSpDumpHexPickNow',
      'beginSupplyCacheHexPickNow',
      'beginSupplySourceHexPickNow',
      'armConstructionMarkerNow',
    ],
  },
  {
    kind: 'pregame',
    why: '初设 / 剧本 / 开局：不在 2.2 的环节体系内（初设期由「初设与开局」面板与决策队列管）',
    names: [
      'beginAirPlacement',
      'beginSelfPlacement',
      'beginShiftPlacement',
      'beginTruckPick',
      'cancelPlacement',
      'cancelTruckPick',
      'confirmSideSetup',
      'confirmSpOwnership',
      'designateTrucks',
      'resetAll',
      'runAirSetup',
      'runAutoSetup',
      'selectScenario',
      'setAirChoice',
      'setDrawShiftHexNow',
      'setPlacingChunk',
      'setSelfChoice',
      'setSpAssignment',
      'startGameNow',
      'toggleTruckFull',
      'applyShiftWestPlacementsNow',
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
      'beginAirBarrageNow',
      'cancelMovePick',
      'cancelRefitNow',
      'cancelSpecialCombatNow',
      'clearCombat',
      'clearCombatSupplyDump',
      'clearRetreatDestinationNow',
      'completeAirReturnNow',
      'confirmAirCargoLossNow',
      'confirmAirCombatNow',
      'confirmBarrageOutcomeStep',
      'confirmBarrageShiftsStep',
      'confirmBarrageSupplyStep',
      'confirmCombatAdvance',
      'confirmCombatLosses',
      'confirmCombatOptions',
      'confirmCombatRetreats',
      'confirmCombatSupply',
      'confirmMovePick',
      'confirmSpecialCombatNow',
      'confirmZocEntryAndOverrun',
      'declareCombatArStep',
      'declareCombatTerrainStep',
      'dismissZocConfirm',
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
      'clearAdvanceNow',
      'clearNonSavableReplNow',
      'clearSupplyPhasePlan',
      'pickCombatSupplyDump',
      'pickFuelDump',
      'setAirActive',
      'setAirMissionKind',
      'setAirTargetFromText',
      'setAttritionAllocation',
      'setBarrageActive',
      'setBarrageTargetKind',
      'setBattleMode',
      'setHoverHex',
      'setOptionDraftMode',
      'setPopupCard',
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

  /* ── 已加闸（原文给了明确时机）—— 本表用于**核对**，不是"未处理" ── */

  // 1.6a：到达卡要求"移除"时立即移出（B 增援·到货落位）
  applyArrivalRemovalsNow: {
    kind: 'gated',
    key: 'rein.arrival',
    why: '1.6a「…is immediately removed from play」⇒ 到达卡的一部分',
  },
  removeForeverNow: {
    kind: 'gated',
    key: 'rein.arrival',
    why: '13.5c 永久移出，入口在到达卡侧（同 1.6a）',
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
   * 专规 ch10/ch11 的抽签：**初设已自动抽完**（`runSetupDrawsNow`）；对局台这里的
   * 「抽签 / 落盘」两个按钮是**裁判重抽的退路**。真正带环节闸的是 `drawAndApplyStepNow`
   * （`rein.formationDraw`），它在 B 段的该环里一次做完"抽 → 落 → 回写台账"。
   * ★ 不能给 `drawFormations` / `applyDraw` 本身加闸：初设自动抽签也走这两个函数，
   *   那时不在 B 段 ⇒ 加了会把初设流程弄断。
   */
  drawFormations: {
    kind: 'referee',
    why: '抽签（仅轴方）：初设已自动执行，此处为裁判重抽退路；带闸的落盘入口是 drawAndApplyStepNow',
  },
  applyDraw: {
    kind: 'referee',
    why: '抽签结果的落盘：初设自动抽签也走它，故不能在此加闸（带闸的是 drawAndApplyStepNow）',
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
  pickFreeRailEdgeHex: {
    kind: 'playerStep',
    why: '专规 2.1 免费铁运的边缘格由玩家指定（落点不印在卡上）',
  },
  pickSupplyTrainHex: { kind: 'playerStep', why: '专规 3.6 补给列车的格由玩家指定' },

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
  absorbBreakdownNow: {
    kind: 'flowState',
    why: '20.0d 吸收是**段末强制收束**（明确不按环节设闸）',
  },
  deployBreakoutReturnNow: {
    kind: 'flowState',
    why: '12.8e 返场受 `breakoutReturns[].returnsOnTurn` 的回合约束（比环节更窄）',
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
  transferAircraftNow: {
    kind: 'noTiming',
    why: '14.11 基地转移：原文未给阶段限制（不是 14.1g 的"任务"）⇒ 取保守值，不施加未明定的限制',
  },
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
    why: '1.4b 时机是硬约束（仅本方 Movement Phase、禁 Reaction/Exploitation 进出）⇒ 由引擎 canEnterEdgeBox 判，不走 ACTION_GATES 环节键',
  },
}
