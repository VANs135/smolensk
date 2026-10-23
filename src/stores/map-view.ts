import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import type { HexRef } from '@/data'
import { useHotseatStore } from './hotseat'
import {
  useWorkbenchStore,
  type CombatRetreatSidePlan,
  type CombatRetreatUnitPlan,
} from './workbench'
import { needsFuelOf, hexLabel, type ConsoleAirUnit, type ConsoleUnit } from './workbench-model'
import { useSetupStore } from './setup'
import { useContainersStore } from './containers'
import type { MovementOverlay, SupplyPickHint, UnitToken, ZocOverlay } from '@/render/token-layer'
import {
  combatNoncombatColumns,
  hitStackFan,
  stackFanLayout,
  toggleSelection,
} from '@/render/stack-fan'
import { OVERRUN_MP_COST, exertsZoc, zocHexes, type ZocSource } from '@/engine/rules'
import type { GamePhase } from '@/engine/state-types'
import { participatesIn } from './workbench-model'

/**
 * 地图视图编排（W7 C16：对局台的地图优先交互）
 *
 * ## 它解决什么
 *   「地图上画什么」与「点了地图做什么」原本散在两个视图里（`WorkbenchView` / `MapView`），
 *   现在收在一处，让**新对局台**与旧操作台共用同一份覆盖层与同一套点选规则：
 *   · **画什么**：算子令牌（地面按 4.9a 战雾裁剪；飞机只画本方）、可到达格、预览路径、
 *     可突袭目标（8.0/8.1）、撤退落点（9.12）、推进格（9.12g）、可付款补给站（12.1b）、
 *     补给覆盖（C8）、巡逻区（C9）；
 *   · **点什么**：`onHexClick` 按当前流程分派——已摊开的堆叠优先（就地展开，B3）、
 *     移动中点可突袭目标＝发起突袭（8.0）、
 *     撤退步点落点＝给当前单位定落点（9.12）、推进步点防御格＝推进（9.12g）、
 *     补给步点补给站＝声明付款来源（12.4）、已选飞机后点目标格＝宣布任务格（14.2f-B），
 *     其余一律交给操作台的既有 `clickHex`。
 *
 * ## 分层纪律
 *   本 store 只**编排**：一切规则结论来自 `engine/rules`（经 `workbench` 的派生），本层不重算；
 *   render 层只读它产出的 `MovementOverlay`（CODE_SPEC §2）。
 */

/** 令牌上的模式字母（与操作台旧画法一致；纯呈现） */
const MODE_LETTER: Record<string, string> = {
  combat: 'C',
  move: 'M',
  reserve: 'R',
  strat: 'S',
}

/** 地图小窗的状态（点某格后打开；内容由视图按格推出） */
export interface MapPopupState {
  hex: HexRef
  /** 锚点（视口内 CSS 像素） */
  x: number
  y: number
}

/** 小窗里「这一格有什么」的清单（地面 + 本方飞机；按战雾纪律裁剪） */
export interface MapPopupContent {
  hex: HexRef
  /** 可见的地面算子（己方全给；敌方只给 4.9a 允许的那一两枚） */
  units: UnitToken[]
  /** 该格的本方飞机（飞机只画/只列本方，避免泄露对手空军布置） */
  airUnits: ConsoleAirUnit[]
  /** 该格是否还有未显示的内容（4.9a：不透露枚数） */
  hidden: boolean
  /**
   * 批 A 切片 3②：该格**本环节可行动**的己方算子 id（用户口径 9.17⑤：
   * 「框内只列**该环节能行动**的单位（例：战斗环节只列"没攻击过的可攻击战斗单位"）」）
   *
   * 判据＝操作台的 `participatingUnitIds`（由 B7 的 `participatesIn` + 9.1c 的攻击账本推出），
   * 本处不做第二份规则判断。敌方算子**不在此列**——它们是 4.9a 的"目标"，照旧列出。
   */
  actionableOwnIds: readonly string[]
  /** 被过滤掉的己方算子（如实交代"还有几枚现在动不了、为什么"，不给玩家"我的兵去哪了"的错觉） */
  blockedOwn: readonly { id: string; label: string; rule: string; reason: string }[]
}

/** **唯一会话框**的会话种类（B4；后续批次会加空军 / 补给 / 初设决策 / 盒内动作） */
export type MapSessionKind =
  | 'move'
  | 'combat'
  | 'barrage'
  | 'air'
  | 'supply'
  | 'reinforce'
  | 'breakout'
  | 'containers'
  | 'exclusive'
  | 'unit'

/**
 * 当前该在地图上挂载的那**一个**会话框（B4，方案 §4.3）
 *
 * 视图只认这一个对象：标题、规则号、宽度全在这里定，视图不再各自 `v-if` 一堆面板
 * ——「同一时刻只挂载一个」因此是**结构保证**，而不是靠各处自觉。
 */
export interface MapSession {
  kind: MapSessionKind
  /** 标题（含格号，便于玩家确认打的是哪一格） */
  title: string
  /** 规则出处（标题栏上的标签） */
  rule: string
  /** 面板宽度（CSS 值；不给就用组件默认） */
  width?: string
}

export const useMapViewStore = defineStore('mapView', () => {
  const workbench = useWorkbenchStore()
  const hotseat = useHotseatStore()
  const setup = useSetupStore()
  /** B17a-2：盒卡展开与否决定"盒内动作"会话是否出现（方案 §4.7） */
  const containers = useContainersStore()

  /** 4.5：是否铺出 ZOC 覆盖层（默认关：它面积大，会让地图变吵） */
  const zocLayerVisible = ref(false)

  /**
   * 4.5：ZOC 覆盖层（由**已过战雾裁剪的令牌**反查算子的规则事实）
   *
   * 逐方各调一次引擎的 `zocHexes`（唯一实现）：它内部按 `projectsZoc` 只收
   * **可攻击 + 战斗模式 + 有追溯补给**的单位（4.5），且只收图内的六邻格。
   *
   * `inCombatMode` 取引擎的 `exertsZoc`（模式矩阵的唯一裁定处），**不由本处复述**模式优先级。
   */
  function zocLayerFromTokens(tokens: readonly UnitToken[]): ZocOverlay {
    const visibleIds = new Set(tokens.map((token) => token.id))
    const sources: ZocSource[] = workbench.units
      // 数据源＝地图实际画出的那一份 ⇒ ZOC 图层不可能泄露战雾之外的信息
      .filter((unit) => visibleIds.has(unit.instanceId))
      .map((unit) => ({
        hex: unit.hex,
        side: unit.side,
        attackCapable: unit.attackCapable,
        inCombatMode: exertsZoc(unit.mode),
        hasTraceSupply: unit.hasTraceSupply,
      }))
    return {
      friendly: zocHexes(sources, hotseat.viewerSide),
      enemy: zocHexes(sources, hotseat.opponentSide),
    }
  }

  /* ────────────────────────────── 画什么 ────────────────────────────── */

  /**
   * W7 C13（4.9a）：把算子令牌按战雾纪律裁剪
   *
   * 己方格全留；敌方格只留引擎允许的那一两枚（最上方战斗单位 / 最上方激活飞机），
   * 并打上 `hiddenStack` 标记（画提示环、**不显示枚数**——枚数属「看穿堆叠」，4.9a 不允许）。
   */
  function fogVisibleTokens(tokens: readonly UnitToken[]): UnitToken[] {
    const visible: UnitToken[] = []
    for (const token of tokens) {
      if (token.side === hotseat.viewerSide) {
        visible.push(token)
        continue
      }
      const allowed = hotseat.visibleUnitIdsInHex(token.hex)
      if (!allowed.includes(token.id)) continue
      visible.push(hotseat.hasHiddenContent(token.hex) ? { ...token, hiddenStack: true } : token)
    }
    return visible
  }

  /** 地面算子 → 令牌 */
  /** 本环节可参与的算子 id 集合（O(1) 查询；唯一来源是 workbench 的 participatingUnitIds） */
  const participatingIds = computed(() => new Set(workbench.participatingUnitIds))

  function groundTokens(): UnitToken[] {
    const movingIds = workbench.moveInteraction?.unitIds ?? []
    return workbench.units.map((unit: ConsoleUnit) => ({
      id: unit.instanceId,
      hex: unit.hex,
      side: unit.side,
      // 算子图：按 unitId + 当前朝向取正面/背面（5.4a 图随朝向那一面）
      unitId: unit.unitId,
      face: unit.mode.orientation,
      images: unit.images,
      // 计数类非战斗算子的图**随当前数值走**（SP 点数 / 机场等级 / 工事等级）
      noncombatKind: unit.noncombatKind ?? null,
      spPoints: unit.noncombatSp,
      noncombatLevel: unit.noncombatLevel,
      // 13.2f/h：编内卡车的面＝**装载**（满载 1F / 空载 1），与朝向无关（13.0：运输单位只有移动模式）
      loadedSpT: unit.loadedSpT,
      label: `${unit.raw.attack}-${unit.raw.ar}-${unit.raw.ma}`,
      // 选中环：移动交互中的那些 + **就地展开里被选中的那些**（用户 2026-09-16 #1：点某一枚即切换）
      selected:
        movingIds.includes(unit.instanceId) || stackSelection.value.includes(unit.instanceId),
      /*
       * B9：**本环节不参与的本方算子灰显**（用户口径「不参与环节的算子无法点击」的可视半边）。
       * 判据是 store 里那条唯一谓词（participatingIds ← workbench.participatingUnitIds ← participatesIn），
       * 本处只做"取集合 + 按敌我过滤"；敌方算子不标灰（4.9a 已把它限制成只读，再灰一层看不出敌我）。
       */
      disabled: unit.side === hotseat.viewerSide && !participatingIds.value.has(unit.instanceId),
      ended: unit.movementEnded,
      modeLetter: MODE_LETTER[unit.mode.mode] ?? '?',
      dg: unit.mode.dg,
      awaitingFuel: needsFuelOf(unit) && !unit.fuelled,
      fuelled: unit.fuelled,
      // 模式/状态贴图（5.8 战略 / 5.9 进击 / 12.8 断补）
      exploit: unit.mode.exploit === true,
      strat: unit.mode.mode === 'strat',
      outOfSupply: !unit.hasTraceSupply,
    }))
  }

  /**
   * 本方飞机 → 令牌（W7 C16）
   *
   * 14.1a：飞机停在其空军基地格，故画在该格上；**只画本方**（对手空军布置属己方不可见信息，
   * 4.9a 的可见顶牌名单只覆盖地面堆叠，故飞机不参与该名单，直接不画更稳妥）。
   * 画法与地面算子相同（正方形 + 真算子图）；激活态仍用角标 `A`/`I` 区分。
   */
  function airTokens(): UnitToken[] {
    const picked = workbench.airMissionAirIds
    return workbench.ownAirUnits.map((air: ConsoleAirUnit) => ({
      id: air.instanceId,
      hex: air.hex,
      side: air.side,
      // 飞机图同样按机型取（空军专表 images；正面即主面）
      unitId: air.aircraftId,
      face: 'combat' as const,
      images: air.images,
      label: air.aircraftType,
      air: true,
      selected: picked.includes(air.instanceId),
      ended: air.airStatus !== 'active',
      modeLetter: air.airStatus === 'active' ? 'A' : 'I',
      dg: false,
      awaitingFuel: false,
      fuelled: false,
    }))
  }

  /**
   * 15.1 整备付款候选（金黄方框）
   *
   * 只在「正在整备某个基地」时铺出：数据来自 `workbench.refitPayDumps`（引擎已按 12.3 判过
   * 「该基地能拖取到哪些补给站」）。用户口径：吃补给与其它方式一致 —— 点地图上高亮的补给。
   */
  const refitPayHints = computed<readonly SupplyPickHint[]>(() => {
    if (workbench.refitBase === null) return []
    return workbench.refitPayDumps.map((dump) => ({
      hex: { ...dump.hex },
      label: `${dump.sp} SP + ${dump.t} T`,
      selected: false,
    }))
  })

  /** 当前覆盖层（地图要画的一切；视图直接把它交给 `MapCanvas`） */
  const overlay = computed<MovementOverlay>(() => {
    const movingIds = workbench.moveInteraction?.unitIds ?? []
    const visibleTokens = [...fogVisibleTokens(groundTokens()), ...airTokens()]
    return {
      tokens: visibleTokens,
      /*
       * 4.5：**控制区覆盖格集合**（`zocHexes` 此前零调用 ⇒ 玩家看不到 ZOC 范围，只能逐格试）
       *
       * 数据源＝**地图实际画出的算子**（已过 4.9a 战雾裁剪的那一份）——这样 ZOC 图层不可能
       * 泄露地图本身没画出来的信息。投射判据（可攻击 + 战斗模式 + 有追溯补给）由引擎的
       * `zocHexes` 内部按 `projectsZoc` 裁定，本处不另行判定。
       */
      zoc: zocLayerVisible.value ? zocLayerFromTokens(visibleTokens) : null,
      reachable: workbench.groupReachable.hexes.map((node) => ({
        hex: node.hex,
        mpSpent: node.mpSpent,
        forcedStop: node.forcedStop,
        minimumMove: node.minimumMove,
        inEnemyZoc: node.inEnemyZoc,
      })),
      path: workbench.stepPreview?.path ?? [],
      startHex: workbench.moveInteraction?.start ?? null,
      selectedIds: movingIds,
      // B3：就地展开的格与页码（渲染层据此逐枚摊开；null = 未展开）
      expandedStack: expandedStack.value,
      // W7 C16：可突袭目标（8.0/8.1）——移动中随位置实时重算，点它即发起突袭
      overrunTargets: workbench.overrunTargets,
      // W7 C16：9.12 撤退落点（只画「当前该轮到的这一方」，实现「攻方先、守方后」的渲染次序；
      // 只在 9.2 的撤退步铺出，避免在其他步误导玩家）
      // 条 15/16（批 F·F1）：选项页「撤退」草稿模式下，同三色铺「本堆叠可撤退格」预览
      // （点格即按该格距离记撤退草稿；正式撤退仍走 9.2 撤退步）
      retreat:
        workbench.combatState?.step === 'retreat'
          ? retreatSidePlan.value === null
            ? null
            : {
                safe: retreatSidePlan.value.safe,
                zoc: retreatSidePlan.value.zoc,
                doomed: retreatSidePlan.value.doomed,
              }
          : workbench.optionDraftMode === 'retreat' && workbench.optionDraftRetreatPreview !== null
            ? {
                safe: workbench.optionDraftRetreatPreview.safe,
                zoc: workbench.optionDraftRetreatPreview.zoc,
                doomed: workbench.optionDraftRetreatPreview.doomed,
              }
            : null,
      // W7 C16：9.12g 战后推进格（只在推进步铺出）
      advance:
        workbench.combatState?.step === 'advance' && workbench.combatAdvanceHex !== null
          ? [workbench.combatAdvanceHex]
          : [],
      // W7 C16：12.4 战斗补给的付款来源候选（只在战斗补给步铺出）
      payDumps: combatSourceDumps.value,
      // C8：补给覆盖层（12.3a 拖取 / 12.3b 投递的可视化）
      supply:
        workbench.supplyActive && workbench.supplySummary !== null
          ? {
              coverage: workbench.supplyCoverageHexes,
              path: workbench.supplyFocusSource?.path ?? [],
              sourceHex: workbench.supplyFocusSource?.hex ?? null,
              targetHex: workbench.supplySummary.unitHex,
              viaAdjacency: workbench.supplyFocusSource?.viaAdjacency ?? false,
            }
          : null,
      // C9：巡逻区覆盖层（14.4c）
      patrolZone: workbench.airActive
        ? {
            friendly: workbench.airPatrolZoneHexes,
            enemy: workbench.airEnemyPatrolZoneHexes,
          }
        : null,
      // 9.14c/d：设施/后勤目标被夺取后，由原主选择的**位移落点**（有待决时才铺）
      specialDisplace: specialDisplaceOverlay.value,
      /*
       * B27：通用「待点格」的候选高亮（初设之外的格号选择都走它）
       *
       * 候选由 store 的动作给出（`beginXxxHexPickNow` 一族）；候选为 `'any'` 时不铺高亮
       * （那类动作的合法性由引擎在提交时判，地图只负责"点哪儿"）。
       */
      pickCandidates: pickCandidateHexes.value,
      // 条 6（R3）：可突围堆叠高亮（仅突围环节铺出）
      breakoutHexes: breakoutHexes.value,
      // W7 C14：初设落点候选（玩家在「初设单位 box」点了某一项时高亮其合法落点）
      // 第六批条 2：卡车点选模式下高亮的**是卡车所在格**（不是"落点"）
      setupCandidates:
        setup.placing?.candidates ?? (setup.truckPickActive ? setup.truckPickHexes : null),
      // 15.1：整备付款的补给站候选（用户口径：与其它补给消耗一样，点地图上高亮的补给）
      refitPay: refitPayHints.value,
    }
  })

  /**
   * **当前该做的那一件事**（一行提示；方案 §4.5 的「动作提示带」）
   *
   * 用户 2026-09-16：「**地图窗口上方不应该有消息栏**」⇒ 这一行从地图上方搬进**流程条**
   * （紧跟在"环节"那行下面）。放这里而不是视图里：`map-view` 手上既有 `workbench` 又有本店的
   * `specialHint / retreatHint / overrunHint`，是唯一能同时看到这三类待决的地方；
   * 视图与流程条都只读它，不会再各写一份"现在该干什么"。
   */
  /**
   * B27：待点格的高亮候选（`'any'` 或没有待点态 ⇒ null，即不铺高亮）
   *
   * 与初设落点候选同一种画法；两者的区别只在触发源：初设走 `setup.placing`，
   * 其余全部走 store 的待点格（`workbench.hexPickView`）。
   */
  const pickCandidateHexes = computed<readonly HexRef[] | null>(() => {
    const view = workbench.hexPickView
    if (view === null || view.candidates === 'any') return null
    return view.candidates
  })

  /**
   * 条 6（R3）：是否正处于**突围环节**（12.8e）
   *
   * 判据＝当前环节 id 是 `movement.breakout`；本店据此在地图上高亮可突围堆叠、并把突围会话框挂出来。
   */
  const isBreakoutSegment = computed<boolean>(
    () => workbench.segmentStep?.id === 'movement.breakout',
  )

  /**
   * 条 6（R3）：**可突围堆叠**所在的格（覆盖层用）
   *
   * 只收 `breakoutCandidates` 里 `ok` 的那些（＝过 `canBreakout` 判据、点它真的能突围的单位）。
   * 不在突围环节时恒为空（不铺高亮）。
   */
  const breakoutHexes = computed<readonly HexRef[]>(() =>
    isBreakoutSegment.value
      ? workbench.breakoutCandidates
          .filter((candidate) => candidate.ok)
          .map((candidate) => ({ ...candidate.unit.hex }))
      : [],
  )

  /** 条 6（R3）：突围环节里点该格能突围出的那一枚单位 id（无则 null） */
  function breakoutUnitIdAt(hex: HexRef): string | null {
    if (!isBreakoutSegment.value) return null
    const match = workbench.breakoutCandidates.find(
      (candidate) =>
        candidate.ok && candidate.unit.hex.col === hex.col && candidate.unit.hex.row === hex.row,
    )
    return match === undefined ? null : match.unit.instanceId
  }

  const actionHint = computed<string>(() => {
    // B27：正在选格（通用待点格）最优先——玩家已经明确表达"我在选一个格"
    if (workbench.hexPickHint !== '') return workbench.hexPickHint
    // 9.14：待决的位移落点次优先（它必须收束，其余动作都被它挡住）
    if (specialHint.value !== '') return specialHint.value
    if (retreatHint.value !== '') return retreatHint.value
    if (overrunHint.value !== '') return overrunHint.value
    if (workbench.airActive && workbench.airMissionAirIds.length > 0)
      return '已选飞机：点地图上任意一格即定任务格（14.2f-B），再在会话框里选任务并宣布'
    if (workbench.moveInteraction !== null)
      return '移动中：点可到达格逐格走（6.1）；点紫环敌方格＝突袭（8.1a）；Enter 结束移动'
    // B35：不再看"工具"，看**本环节允不允许宣布战斗**（判据与闸门同源）
    if (workbench.combatPickActive)
      return '点己方算子加入攻方（9.1b），点敌方格选定防御格，会话框里走 9.2 九步'
    if (workbench.tool === 'place') return '摆算子工具：先从单位列表选算子，再点地图放置（IV）'
    return '点己方算子＝选中并显示可移动范围（6.1）；点堆叠＝展开该格小窗'
  })

  /**
   * 5.0c：**胜利格控制标记**（用户 2026-09-16 要求）
   *
   * 「把这两个标记做到剧本用到的胜利格上……根据控制方显示对应面，且该标记**钉死**在胜利点
   * **无法选中**，标记更换为根据胜利点归属权变更**自动**进行」。
   *
   * ★ 数据源是**引擎/状态层的控制事实**（`victoryHexes` 的每一格 + `victoryControlOf` 的结论）；
   *   `victoryControlOf` 内部已把「格内可攻击单位」与「最后控制者账本」拼给引擎的 `controlOfHex`
   *   ⇒ 本处**不重算**控制，只把"哪一格归谁"摊成渲染层要的两列。
   * ★ 它是**地图事实**（不是交互覆盖层）：既不进 `tokens`（所以不可选中、不参与命中测试与
   *   堆叠展开），也不随会话开关而变——故放在 `MapRenderOptions.controlMarkers` 而非 `overlay` 里。
   */
  /**
   * B37 / 3.4：**装甲集群分界线**（用户口径 #14；地图事实层，与 `controlMarkers` 同族）
   *
   * 只做转交：线两端与"站错一侧的格"都由 `workbench.boundaryView` 算好（引擎给的结论）。
   */
  const boundary = computed(() => workbench.boundaryView)

  const controlMarkers = computed<readonly { hex: HexRef; side: 'axis' | 'soviet' }[]>(() => {
    const out: { hex: HexRef; side: 'axis' | 'soviet' }[] = []
    for (const hex of workbench.victoryHexes) {
      const side = workbench.victoryControlOf(hex)
      if (side === null) continue
      out.push({ hex: { col: hex.col, row: hex.row }, side })
    }
    return out
  })

  /* ────────────── 9.14c/d 特殊战斗：位移落点由玩家在地图上选 ────────────── */

  /** 9.14 待决里正在选落点的那一项（默认第一个还没选的） */
  const specialUnitId = ref<string | null>(null)

  const specialItem = computed(() => {
    const pending = workbench.specialPending
    if (pending === null || pending.items.length === 0) return null
    const picked = pending.items.find((item) => item.unitId === specialUnitId.value)
    if (picked !== undefined) return picked
    return pending.items.find((item) => item.chosen === null) ?? pending.items[0] ?? null
  })

  /** 手动指定「现在给哪一项选落点」 */
  function setSpecialUnit(unitId: string | null): void {
    specialUnitId.value = unitId
  }

  /** 9.14c/d 的位移落点覆盖层（候选＝各项合法落点的并集；已选＝各项已定落点） */
  const specialDisplaceOverlay = computed<{
    candidates: HexRef[]
    chosen: HexRef[]
  } | null>(() => {
    const pending = workbench.specialPending
    if (pending === null || pending.items.length === 0) return null
    const candidates: HexRef[] = []
    const chosen: HexRef[] = []
    const seen = new Set<string>()
    for (const item of pending.items) {
      for (const hex of item.candidates) {
        const key = `${hex.col}.${hex.row}`
        if (seen.has(key)) continue
        seen.add(key)
        candidates.push({ col: hex.col, row: hex.row })
      }
      if (item.chosen !== null) chosen.push({ col: item.chosen.col, row: item.chosen.row })
    }
    return { candidates, chosen }
  })

  /** 9.14 待决的一行提示（规则依据与前提都写在提示里，避免玩家凭猜） */
  const specialHint = computed(() => {
    const pending = workbench.specialPending
    if (pending === null) return ''
    const item = specialItem.value
    const notes = pending.notes.length > 0 ? ` · ${pending.notes.join(' · ')}` : ''
    if (item === null)
      return `9.14 特殊战斗（${hexLabel(pending.hex)}）已结清，仅剩运输点归属分配${notes}`
    return `9.14 位移：正在选 ${item.label}（${
      item.kind === 'extender' ? '9.14d 崩溃，须有追溯补给' : '9.14c 转移'
    }）· 青色虚线＝合法落点，点地图即选定${notes}`
  })

  /** 该格是否是当前这一项的合法位移落点（点它＝选定） */
  function specialDestinationAt(hex: HexRef): boolean {
    const item = specialItem.value
    if (item === null) return false
    return item.candidates.some(
      (candidate) => candidate.col === hex.col && candidate.row === hex.row,
    )
  }

  /** 图上是否有可突袭目标（界面给一行提示用） */
  const hasOverrunTargets = computed(() => workbench.overrunTargets.length > 0)

  /** 突袭代价文案（8.1a：每次 3 MP） */
  const overrunHint = computed(() =>
    hasOverrunTargets.value
      ? `可突袭 ${workbench.overrunTargets.length} 处（每次 ${OVERRUN_MP_COST} MP，8.1a）`
      : '',
  )

  /* ────────────────────── 9.12 撤退：谁在选、选哪一格 ────────────────────── */

  /**
   * 当前该选撤退落点的一方
   *
   * 9.12c/9.12e：双方各自撤退自己的单位；本作按 9.10b 的「攻方先、守方后」次序渲染 ——
   * 攻方没选齐就只画攻方的落点，攻方选齐后才轮到守方（`plans` 的顺序即攻方在前）。
   */
  const retreatSidePlan = computed<CombatRetreatSidePlan | null>(() => {
    const plans = workbench.combatRetreatPlans
    if (plans.length === 0) return null
    return plans.find((plan) => !plan.complete) ?? plans[plans.length - 1]!
  })

  /** 该方当前正在选落点的那一名单位（默认第一个还没选的；由界面切换时手动指定） */
  const retreatUnitId = ref<string | null>(null)

  const retreatUnit = computed<CombatRetreatUnitPlan | null>(() => {
    const plan = retreatSidePlan.value
    if (plan === null) return null
    const chosen = plan.units.find((unit) => unit.unitId === retreatUnitId.value)
    if (chosen !== undefined) return chosen
    return plan.units.find((unit) => unit.chosen === null) ?? plan.units[0] ?? null
  })

  /** 手动指定「现在给谁选落点」 */
  function setRetreatUnit(unitId: string | null): void {
    retreatUnitId.value = unitId
  }

  /** 撤退阶段的一行提示（9.12/9.12b/9.12d/9.12e） */
  const retreatHint = computed(() => {
    const plan = retreatSidePlan.value
    if (plan === null) return ''
    const side = plan.side === 'attacker' ? '攻方' : '守方'
    const unit = retreatUnit.value
    const doomed =
      plan.doomed.length > 0 ? ` · 暗红点线＝选了会被消灭（${plan.doomed.length} 格）` : ''
    const tagalongs =
      plan.tagalongs.length > 0
        ? ` · 跟随：${plan.tagalongs.map((item) => item.label).join('、')}（9.12d）`
        : ''
    return `9.12 撤退：${side}撤 ${plan.distance} 格 · 正在选 ${
      unit === null ? '—' : unit.label
    } · 青绿＝安全格，橙红＝敌方 ZOC 格（进入即 DG，9.12e）${doomed}${tagalongs}`
  })

  /* ────────────────────── 12.4 战斗补给的付款来源 ────────────────────── */

  /** 战斗补给步可点的补给站（供地图画金黄方框 + 小窗列表） */
  const combatSourceDumps = computed(() => {
    if (workbench.combatState?.step !== 'combatSupply') return []
    const picked = workbench.combatSupplyDumpIds
    return workbench.combatSupplyDumps.flatMap((entry) =>
      entry.dumps.map((dump) => ({
        hex: dump.hex,
        label: `${dump.t}T`,
        selected: picked[entry.side] === dump.id,
        id: dump.id,
        side: entry.side,
      })),
    )
  })

  /* ────────────────────────────── 点什么 ────────────────────────────── */

  /** 地图小窗（null = 未打开） */
  /*
   * ── 就地展开堆叠（B3，用户 2026-09-16 #1）─────────────────────────────
   *
   * 用户口径：点格**不是把单位捡起来**，而是**在该格里摊开**；**默认全选**、点某一枚即取消、
   * 不必去别的页面取消。故这里只有两个状态：
   *   · `expandedStack`：哪一格摊开了、第几页（>4 枚分页）；
   *   · `stackSelection`：摊开后被选中的算子实例 id（**这就是后续动作的参与集合**）。
   * 规则判定不在本处：谁"可参与"由引擎给（B7/B9 接资格），本批先选该格全部可见算子。
   */
  const expandedStack = ref<{ hex: HexRef; page: number } | null>(null)
  const stackSelection = ref<string[]>([])

  /**
   * 条 12（M2）：**点非战斗单位 ⇒ 开对应动作会话**（`MapSessionKind:'unit'`）
   *
   * 记下"当前正在对其做动作"的非战斗单位所在格；点别处 / 收会话即清空。
   * 右栏原可写面板（`AirPanel only="admin"` / `SupplyPanel only="ledger"`）随之收进本会话，
   * 落实「右栏只读」——SP 拖取 / 运输点装卸 / 延补队 / 基地整备 / 工事都从这里进。
   */
  const unitActionHex = ref<HexRef | null>(null)

  /**
   * 条 19（A1）：**点地面格 ⇒ 空军任务入口**（target-first）的引导态
   *
   * 移动/轰炸环节点到「无己方地面算子、且有飞机按航程够得到」的地面格时置位，
   * 并把该格预填为 `airTargetHex`、打开空军工具 ⇒ `air` 会话弹出（AirPanel mission 段按航程列机）。
   * 一旦玩家勾选了参战机（`airMissionAirIds>0`）即由 watcher 清空（会话改由选机续跑）；
   * 取消会话 / 点别处也清。它只是**一次性引导触发**，不长期存活（区别于会存活的 `airTargetHex`）。
   */
  const airEntryTarget = ref<HexRef | null>(null)
  // 勾到第一架参战机 ⇒ 引导态使命完成，交棒给 airMissionAirIds（sync：本击内即交棒，测试可同步断言）
  watch(
    () => workbench.airMissionAirIds.length,
    (count) => {
      if (count > 0) airEntryTarget.value = null
    },
    { flush: 'sync' },
  )

  /**
   * 该格**画出来的**全部令牌（地面＋飞机）——B26：渲染与命中必须同源
   *
   * ★ 修前这里（与摊开的命中判定）只取 `groundTokens()`，而**渲染**用的是
   *   `overlay.tokens`＝地面＋飞机（见下方 `tokens` 那一行）⇒ 含飞机的格（空军基地最常见）
   *   会出现「**点到的槽位不是画在那儿的算子**」：扇形的第 n 个槽位按"地面＋飞机"画，
   *   命中却按"只有地面"回查。用户口径也要求「点机场后展开里面飞机」，故这里统一成一份。
   */
  function stackTokensAt(hex: HexRef): UnitToken[] {
    return [...fogVisibleTokens(groundTokens()), ...airTokens()].filter(
      (token) => token.hex.col === hex.col && token.hex.row === hex.row,
    )
  }

  /** 该格的可见算子实例 id（展开默认全选与命中都用它） */
  function stackTokenIdsAt(hex: HexRef): string[] {
    return stackTokensAt(hex).map((token) => token.id)
  }

  /**
   * 该 id 所对应的算子**是否参与本环节**（B9 的核心接线）
   *
   * 用户口径：「**不参与环节的算子无法点击**」——判据是 B7 的 `participatesIn`（唯一谓词），
   * 本处只做"从令牌 id 找回算子"这一步搬运，不自己判规则。
   * 找不到算子（例如该令牌不是地面算子）⇒ 视为不参与，避免"点了个不存在的东西还放行"。
   */
  function participatesNow(unitId: string): boolean {
    const unit = workbench.units.find((item) => item.instanceId === unitId)
    if (unit === undefined) return false
    return workbench.participatingUnitIds.includes(unitId)
  }

  /** 该格的可见算子实例 id（展开默认全选与命中都用它） */

  /** 该格是否有「取子清单」（6.1f：引擎侧那份真正的参与集合） */
  function movePickHere(hex: HexRef): boolean {
    const pick = workbench.movePickHex
    return pick !== null && pick.col === hex.col && pick.row === hex.row
  }

  /**
   * 摊开某格（**不默认选中**——条 8 裁定①已作废）
   *
   * ★ 条 8 裁定：堆叠展开层**不再默认全选**；选中只发生在玩家的显式点选上。
   * 这是**规则裁定变更**（deliberate ruling change），不是把断言放宽——验收要求
   * "堆叠两栏 + 无默认选"。故 `stackSelection` 在摊开时为空，玩家点哪一枚才把它加进选择集。
   * 取子清单（`movePick`）仍由 `beginMovePick` 建立为该格的**可参与集合**，作为"可开拔候选"，
   * 但**可见的选中态（金边）只在玩家点选后出现**（见 `handleStackClick`）。
   */
  function expandStackAt(hex: HexRef): void {
    /*
     * 取参与本环节的那些作为"可开拔候选"（取子清单来源）；不参与本环节的算子不进候选
     * —— 例：F 段炮击环节摊开"炮兵 + 步兵"堆叠，步兵不进候选，也就不会被误当成参炸单位。
     */
    const participating = stackTokenIdsAt(hex).filter((id) => participatesNow(id))
    const ids = participating.length > 0 ? participating : stackTokenIdsAt(hex)
    /*
     * ★ B26：摊开这一击现在**先于** `clickHex`（"看这一格"优先于"开始移动"），
     *   故取子清单要在这里建立/同步——它是"开始移动"与小窗勾选列表的唯一依据，
     *   也是燃料付款的受益集（`fuelTargets` 走 `movePick.ids`）。
     *   同步的永远是**参与集合**：修前 `setMovePickAll()` 按"该格全部己方算子"覆盖，
     *   把不参与本环节的也圈进来 ⇒ 玩家想只留炮兵却被步兵占着名额（#22）。
     */
    workbench.beginMovePick(hex, ids)
    /*
     * 条 8 裁定①（作废旧"默认全选"）：展开时**不预填选择集**——`stackSelection` 置空，
     * 玩家点哪一枚才把哪一枚加进选择集。候选集 `ids` 仍传给 `beginMovePick` 作为"可开拔范围"，
     * 但可见的选中态只在显式点选后出现。
     */
    stackSelection.value = []
    expandedStack.value = { hex: { col: hex.col, row: hex.row }, page: 0 }
    /*
     * ★ B26：**不再 `closePopup()`**。小窗里那一块「选择要一起开拔的单位（6.1）」
     *   （含「开始移动」按钮）正是这一格的确认入口；摊开时把它关掉，玩家就只能靠
     *   再点一次格子去碰运气（修前就是这样，也是"只动第一枚"的观感来源之一）。
     */
  }

  /** 收起展开（**不清选择集**：用户口径下 Esc 只收展开） */
  function collapseStack(): boolean {
    if (expandedStack.value === null) return false
    expandedStack.value = null
    return true
  }

  /**
   * 清空选择集（会话结束 / 切方 / 换环节时调用，避免残留导致下一步误操作）
   *
   * ★ 现在是**自动**的：见下面的 `watch`（用户口径 §4.2③「会话结束、切方、换环节时**自动**清空选择集」）。
   * 之所以要自动而不能靠人记得清：摊开的选择集**就是下一步动作的参与集合**，跨段残留会让
   * 「上一段挑好的那几枚」被当成这一段的参与者——这是最容易发生、也最难察觉的一类误操作。
   */
  function clearStackSelection(): void {
    stackSelection.value = []
  }

  /**
   * 换回合 / 换段 / 换方 ⇒ 把地图上的**界面态**一并收束
   *
   * 清三样：摊开的选择集、摊开的格子、就地小窗。它们都是"上一步的现场"，
   * 留着只会误导（尤其是选择集，见上）。
   *
   * 判据用 `workbench` 的三个投影（回合号 / 阶段 / 行动方）——它们本身就来自会话记录，
   * 故这条 watch 同时覆盖"点进入下一环节"与"手动切方/切段（引擎验证页）"两条路径。
   * 段内的**环节链**（B6：如 F 战斗段内的炮击→战斗）粒度更细，届时把环节号并入键即可。
   */
  watch(
    () => `${workbench.turn}|${workbench.phase}|${workbench.activeSide}`,
    () => {
      clearStackSelection()
      collapseStack()
      closePopup()
      // 9.12：换回合/换段/换方 ⇒ 把"现在给谁选落点"的**人工指认**清掉，回到兜底
      // （第一个未选落点者）。不清的话，同一段里连打第二场时，上一场点过的那个单位 id
      // 只要恰好也在新名单里就会"复活"成当前焦点，而玩家并没指认它。
      retreatUnitId.value = null
    },
  )

  /** 该格是否正处于展开态 */
  function isStackExpanded(hex: HexRef): boolean {
    const state = expandedStack.value
    return state !== null && state.hex.col === hex.col && state.hex.row === hex.row
  }

  /**
   * 展开态下的点击分派（世界坐标）——返回 true 表示"这一击已由展开态消化"
   *
   * · 点到某一枚 ⇒ **切换**它的选择（本人口径：再点即取消）；
   * · 点到分页角标 ⇒ 翻页；
   * · 点到空白 ⇒ 收起（选择集保留）。
   */
  function handleStackClick(hex: HexRef, world: { x: number; y: number }): boolean {
    const state = expandedStack.value
    if (state === null || state.hex.col !== hex.col || state.hex.row !== hex.row) return false
    // B26：与渲染同一份令牌（含飞机）⇒ 命中的槽位就是画在那儿的算子
    const tokens = stackTokensAt(hex)
    const layout = stackFanLayout({
      hex,
      total: tokens.length,
      page: state.page,
      columns: combatNoncombatColumns(tokens),
    })
    const hit = hitStackFan({ layout, point: world })
    if (hit === null) {
      collapseStack()
      return true
    }
    if (hit.kind === 'page') {
      expandedStack.value = { hex: state.hex, page: hit.nextPage }
      return true
    }
    const token = tokens[hit.index]
    if (token === undefined) return true
    /*
     * B9：**不参与本环节的算子点不动**（用户口径「不参与环节的算子无法点击」）。
     * 不是静默忽略——那样玩家只会觉得"点了没反应"；而是**就地给一行规则号提示**
     * （走操作台日志 ⇒ 侧栏反馈区与地图内提示都能取到）。
     *
     * ★ B26 补一条出口：**已经选中的可以点掉**。否则 F 段炮击环节摊开"炮兵＋步兵"的堆叠时，
     *   默认全选把步兵也圈进来（参加不了炮击），而步兵又"点不动"⇒
     *   玩家既不能只留炮兵、也剔不掉步兵（用户报告 #22「炮兵单位和其它单位堆叠时无法选中」）。
     *   即：**不能加入，但可以剔除** —— 这与"不参与就不能参战"的规则口径不冲突。
     */
    const isSelected = stackSelection.value.includes(token.id)
    if (!participatesNow(token.id) && !isSelected) {
      workbench.pushLog(
        'warning',
        `${token.label} 不参与本环节（${workbench.segmentStep?.label ?? '—'}）：${participationReasonOf(token.id)}`,
        workbench.segmentStep?.rule ?? '2.2',
      )
      return true
    }
    stackSelection.value = toggleSelection(stackSelection.value, token.id)
    // 有取子清单时**同步回引擎**：这样"取消勾选的那一枚"是真的不会被带走（6.1f）
    if (movePickHere(hex)) workbench.setMovePickIds(stackSelection.value)
    // B15b（§4.2「选择集就是后续动作的参与集合」）：战斗的参战集同样跟着这一圈金色边框走
    //（9.1 选攻方 / 9.5b 减员两个阶段；合法性仍由 store 的那两个动作各自把关）
    else if (combatSelectionLive.value) {
      workbench.syncCombatParticipants(hex, stackSelection.value)
    }
    // B15c：参炸名单同理（只在轰炸工具开着、且尚未宣布时）
    else if (workbench.barrageActive && workbench.barrageState === null) {
      workbench.syncBarrageParticipants(hex, stackSelection.value)
    }
    return true
  }

  /**
   * B15b：此刻**战斗的参战集是否跟着地图的选择集走**
   *
   * 两个阶段：① 还没宣布（9.1 选攻方）；② 已在 9.5b 的减员步（补给步里改参战名单）。
   * 战斗一宣布（进入 9.2 的后续步骤），构成就锁定了 ⇒ 地图上的选择集不再改它
   * （那时改名单要走 `toggleCombatSupplyAttacker` 的面板入口，而它**只在补给步**存在）。
   */
  const combatSelectionLive = computed<boolean>(() => {
    if (!workbench.combatPickActive) return false
    const combat = workbench.combatState
    if (combat === null) return true
    return !combat.finished && combat.step === 'combatSupply'
  })

  /**
   * 该算子此刻不参与的**原因**（"规则号 + 一句人话"）
   *
   * 直接问 B7 的 `participatesIn` 取它给的理由——**界面与提示共用同一条谓词的输出**，
   * 而不是各写一句（那样提示迟早与判据对不上）。
   */
  function participationReasonOf(unitId: string): string {
    const step = workbench.segmentStep
    if (step === null) return '本段没有需要玩家过的环节（2.2）'
    const verdict = participationVerdictOf(unitId)
    if (verdict === null) return '找不到该算子'
    return verdict.ok ? '（判据不一致，请报告）' : `${verdict.reason}（${verdict.rule}）`
  }

  /**
   * 该算子此刻的**参与判定结论**（与 `workbench.participatingUnitIds` **同一组输入**）
   *
   * ★ 批 A 切片 3：把"输入怎么拼"收成一处。修前 `participatingUnitIds`（store）与本文件各拼一次，
   *   而 9.1c 的账本只加在了 store 那一边 ⇒ 战斗环节里"已攻击过"的算子会被判成 `ok`
   *   （提示于是打出「判据不一致，请报告」）。两处输入从此只有一个出处。
   */
  function participationVerdictOf(
    unitId: string,
  ): { ok: true; rule: string } | { ok: false; rule: string; reason: string } | null {
    const unit = workbench.units.find((item) => item.instanceId === unitId)
    if (unit === undefined) return null
    const step = workbench.segmentStep
    if (step === null) return null
    return participatesIn({
      unit,
      phase: workbench.phase as GamePhase,
      segment: step.id,
      activeSide: workbench.activeSide,
      // 9.1c：本战斗环节已攻击过的单位不再可拾起（与 `participatingUnitIds` 同一条账本）
      attackedUnitIds: workbench.attackPhaseLedger.unitIds,
    })
  }

  /**
   * 当前是否**没有进行中的交互**（就地展开只在这时抢点击）
   *
   * 有交互时（移动、战斗、突袭、轰炸、空中任务已选机、整备付款、9.14 位移待决、初设落位）
   * 点击另有既定含义，展开不该打断它们——同一击只做一件事，交互才「简洁可靠」。
   *
   * ★ 这里**不能**看 `supplyActive` / `airActive`：那两个是"工具开关"，正式界面里**默认就开着**
   *   （见 workbench 的注释），拿它们当"进行中"会让展开永远不触发（本批探针当场抓到）。
   *   真正表示"下一步等着你点地图"的是下面这些**具体待决**。
   */
  function isIdleForStack(): boolean {
    return (
      workbench.moveInteraction === null &&
      workbench.combatState === null &&
      workbench.overrunContext === null &&
      !workbench.barrageActive &&
      workbench.airMissionAirIds.length === 0 &&
      workbench.supplyUnitId === null &&
      workbench.specialPending === null &&
      workbench.refitBase === null &&
      setup.placing === null
    )
  }

  /** 展开阈值：格内可见算子 ≥2 才摊开（单枚没有可分辨的东西，也不必多一次点击） */
  const STACK_FAN_MIN_TOKENS = 2

  /*
   * ── 唯一会话框的**路由与取消**（B4，方案 §4.3）─────────────────────────
   *
   * 「同一时刻只挂载一个」在这里成为结构保证：视图只读 `session` 这一个对象。
   * 下面的优先级次序眼下不会同时命中两项（引擎同一时刻只跑一个交互状态机），
   * 但仍必须写明——将来多一个状态机时，次序是唯一能防"两个会话框同时出现"的东西。
   */
  /**
   * 条 12（M2）：`unitActionHex` 处那个非战斗单位归属的**动作族**
   *   · supply：sp / supply_point / transport_point / organic_truck / supply_extender
   *     ⇒ 补给账本（SP 拖取 / 运输点装卸 / 延补队）
   *   · air：air_base ⇒ 空军整备面板
   *   · fort：hedgehog ⇒ 工事（专规 16.0b）
   * 无（空格 / 战斗单位 / 单位已不在盘面）⇒ null。
   */
  const unitActionFamily = computed<'supply' | 'air' | 'fort' | null>(() => {
    const hex = unitActionHex.value
    if (hex === null) return null
    const unit = workbench.units.find(
      (item) =>
        item.hex.col === hex.col &&
        item.hex.row === hex.row &&
        (item.noncombatKind ?? null) !== null,
    )
    if (unit === undefined) return null
    switch (unit.noncombatKind) {
      case 'sp':
      case 'supply_point':
      case 'transport_point':
      case 'organic_truck':
      case 'supply_extender':
        return 'supply'
      case 'air_base':
        return 'air'
      case 'hedgehog':
        return 'fort'
      default:
        return null
    }
  })

  const session = computed<MapSession | null>(() => {
    const combat = workbench.combatState
    if (combat !== null && !combat.finished) {
      const overrun = combat.attackType === 'overrun'
      const where = combat.composition.defendingHex
      // 防御格可能还没选（9.1b 选防御格之前就有 combatState）⇒ 那时标题不带格号
      const suffix = where === undefined ? '' : ` · 格 ${where.col}.${where.row}`
      return {
        kind: 'combat',
        title: `${overrun ? '突袭结算（8.1）' : '战斗结算（9.2）'}${suffix}`,
        rule: overrun ? '8.1' : '9.2',
      }
    }
    /*
     * B15b：**宣布之前**也开一个战斗会话（方案 §4.2 的流程：「点目标格 ⇒ 生成唯一会话框 → 逐步骤确认」）。
     * 判据＝战斗工具开着 + 已选攻方 + 已定防御格；内容就是 `CombatPanel` 的"未开始"那一段
     * （攻方名单 / 防御格 / 发起 / 清除）——原先这些只在小窗里，会话框里反而没有入口。
     */
    if (
      combat === null &&
      workbench.combatPickActive &&
      workbench.combatAttackerIds.length > 0 &&
      workbench.battleTarget !== null
    ) {
      return {
        kind: 'combat',
        title: `发起战斗（9.1）· 格 ${workbench.battleTarget.hex.col}.${workbench.battleTarget.hex.row}`,
        rule: '9.1',
      }
    }
    const barrage = workbench.barrageState
    if (barrage !== null && !barrage.finished) {
      return { kind: 'barrage', title: '轰炸结算（10.0）', rule: '10.0', width: 'min(430px, 94%)' }
    }
    /*
     * B15c：**宣布之前**也开一个轰炸会话（判据＝轰炸工具开着 + 已选参炸单位 + 尚未宣布）。
     * 内容就是 `BarragePanel` 的"未宣布"那一段（类别 / 整体目标 / 参炸单位阵列 / 宣布）。
     */
    if (
      barrage === null &&
      workbench.barrageActive &&
      workbench.barrageUnitIds.length + workbench.barrageAirIds.length > 0
    ) {
      return {
        kind: 'barrage',
        title: '宣布轰炸（10.0d）',
        rule: '10.0d',
        width: 'min(430px, 94%)',
      }
    }
    /*
     * B15a：**移动 / 突袭的操作链**也进会话框。
     *
     * 判据是「正在移动」本身（`moveInteraction !== null`）：6.1 的撤销一步 / 结束移动 / 放弃整次移动
     * 原先只挂在 `WorkbenchView`（引擎验证页）——对局台上**根本没有入口**（可玩通判据的缺口）。
     * 这里把它挂成一个会话：地图点堆叠 → 就地摊开选枚 → 移动 → 需要收束时这里给按钮。
     * 排在战斗 / 轰炸之后：突袭进格会立刻开战斗会话，那时先收束战斗（8.1a 的 3 MP 在推进步记账）。
     * **`finished` 即自动消失**（方案 §4.3「流程一结束即自动消失」）：结束移动后交互对象仍在 store 里
     * （6.1 的撤销仍可在验证页用），但不该继续占着地图上的会话框。
     */
    /*
     * B15d：**空军任务链**也进会话框（方案 §4.3：动作类才进会话框）。
     * 判据＝空军工具开着 + （任务已在跑 或 已选机待宣布）。会话里只挂"任务链"那一段
     * （`AirPanel only="mission"`）；摆放/整备/修建/缩减/夺取这些**事务性**动作仍在侧栏面板里。
     */
    if (
      workbench.airActive &&
      (workbench.airState !== null ||
        workbench.airMissionAirIds.length > 0 ||
        airEntryTarget.value !== null)
    ) {
      return {
        kind: 'air',
        title: `空军任务（14.2f）· ${workbench.airMissionKindLabel(workbench.airMissionKind)}`,
        rule: workbench.airState === null ? '14.2f-A' : '14.2f',
        width: 'min(430px, 94%)',
      }
    }
    /*
     * B15e：**补给检查链**进会话框（逐单位：判定 → 选来源 → 拖取/投递 → 断补处置）。
     * 判据＝`supplyState !== null`（已在检查中）；入口（受补给单位阵列）留在侧栏的账本段里，
     * 点一枚即开这条会话（见 `SupplyPanel only="ledger"` 与 `only="check"` 的分工）。
     */
    if (workbench.supplyState !== null) {
      return {
        kind: 'supply',
        title: '补给检查（12.6 → 12.3 → 12.6c/d）',
        rule: '12.0',
        width: 'min(430px, 94%)',
      }
    }
    /*
     * 条 12（M2）：**点非战斗单位 ⇒ 按类型路由到既有动作的会话**。
     * 排在战斗 / 轰炸 / 空军任务 / 补给检查之后（那些是"正在跑"的流程，优先收束），
     * 但在移动之前：点一枚 SP / 运输点 / 延补队 / 空军基地 / 工事，即开这一个会话，
     * 内容按 `unitActionFamily` 分派到右栏原可写面板（现收进会话，右栏只读）。
     */
    if (unitActionFamily.value !== null) {
      const family = unitActionFamily.value
      const title =
        family === 'supply'
          ? '补给点 / 运输（12.1 / 13.2 / 9.14）'
          : family === 'air'
            ? '空军基地整备（15.1）'
            : '工事（16.0b）'
      const rule = family === 'supply' ? '12.1' : family === 'air' ? '15.1' : '16.0b'
      return { kind: 'unit', title, rule, width: 'min(430px, 94%)' }
    }
    const moving = workbench.moveInteraction
    if (moving !== null && !moving.finished) {
      const names = workbench.moveUnits.map((unit) => unit.name).join(' + ')
      const overrun = workbench.overrunContext !== null
      return {
        kind: 'move',
        title: `移动结算（6.1）· ${names === '' ? '未选单位' : names}${overrun ? '（突袭进行中，8.1a）' : ''}`,
        rule: overrun ? '8.1a' : '6.1',
        width: 'min(430px, 94%)',
      }
    }
    /*
     * 条 10（M1）：移动准备——移动段内已选单位待开拔（尚未真正开始移动），含已选但缺燃料需先付。
     * 旧口径「点格即开始移动」已作废，这里让取子清单活跃时即弹出移动会话，
     * 玩家在会话里勾选 / 改模式 / 付燃料后点「开始移动」才开拔。
     * 仅在**移动段**出现：其它段（战斗 / 轰炸 / 补给 …）也经 `expandStackAt` 建了 `movePick`，
     * 但那是各自的参战 / 参炸选择集，不应触发移动会话（各自的会话 / 小窗负责）。
     */
    if (
      workbench.phase === 'movement' &&
      workbench.movePick !== null &&
      (moving === null || moving.finished)
    ) {
      const count = workbench.movePick.ids.length
      const rule = workbench.fuelPaymentDue ? '12.5c' : '6.1'
      return {
        kind: 'move',
        title: `移动准备（6.1）：已选 ${count} 枚待开拔 · 改模式 · 付燃料 · 开始移动`,
        rule,
        width: 'min(430px, 94%)',
      }
    }
    /*
     * B18b（用户 2026-09-16 指正）：**缺燃料也要能开这个会话**。
     *
     * 12.5a 要求"耗 MP 前必须已付燃料"，而付燃料的入口此前只挂在 `WorkbenchView`（引擎验证页）——
     * 对局台上选中一辆没油的坦克、点地图什么都不会发生（`beginMove` 被 12.5a 拒），
     * 于是**根本没有地方付油**：这是"能不能打完整一局"的死结。
     * 判据用 store 的事实 `fuelPaymentDue`（耗油且未加注的**本方**单位已被选中 / 在取子清单里），
     * 不在这里比规则字面量。
     */
    if (workbench.fuelPaymentDue) {
      return {
        kind: 'move',
        title: '移动 / 燃料（6.1 / 12.5）',
        rule: '12.5c',
        width: 'min(430px, 94%)',
      }
    }
    /*
     * B17a（方案 §10①「右侧栏只读」）：**增援段的动作面板**进会话框。
     *
     * 判据＝**当前环节属于增援段**（`segmentStep.id` 以 `reinforcement.` 开头）——
     * 环节名本身就说明"此刻允许做到货/重建/合并"，故不需要玩家先点开某个入口；
     * 而右栏那一份只读信息（当日到达清单、补员账本、结果摘要…）始终在。
     * 玩家可以把它收走（`collapsedSessionKey`），换环节/换回合自然重现。
     */
    const stepId = workbench.segmentStep?.id ?? ''
    if (stepId.startsWith('reinforcement.') && collapsedSessionKey.value !== currentStepKey.value) {
      /*
       * ★ 条 5（R1）：增援段**全程只有一个会话框**，内容按子环节渐变
       *   （① 当回合到达：图阵列、点图落位、新增"到达已放"账本 →
       *    ② 放完自动掷可变增援/补员表，自动步并入本会话 →
       *    ③ 按表所得单位回列会话、照放 →
       *    ④ 自动进重建：会话变死亡堆图阵列、点可重建单位、地图高亮合法落点、点格落位）。
       *   B34 的「到货 / 重建两个窗口」已作废——这里只渲染**一个** `reinforce` 会话，
       *   其标题随 `segmentStep` 的子环节变化，面板（ReinforcementPanel）自身按环节渐变内容。
       */
      const label = workbench.segmentStep?.label ?? 'B 段'
      const title =
        stepId === 'reinforcement.arrival'
          ? `增援与编制 · 到货落位（${label}）`
          : stepId === 'reinforcement.rebuild'
            ? `增援与编制 · 重建与整编（${label}）`
            : `增援与编制（${label}）`
      return {
        kind: 'reinforce',
        title,
        rule: workbench.segmentStep?.rule ?? '13.5 / 13.6',
        width: 'min(430px, 94%)',
      }
    }
    /*
     * 条 6（R3）：**突围环节**也挂一个会话框（把 `MovePanel` 里的突围块移进**会话**而非不可达的右栏）。
     *
     * 判据＝当前环节正是 `movement.breakout`（`stepHasWork` 已按 `canBreakout` 收紧 ⇒
     * 只有"真有单位能突围 / 有待返场"时才会出现这个环节）。内容由 `BreakoutPanel` 负责
     * （点图阵列里某一枚即 `breakoutNow`；另列待返场清单）。本框同样受 `collapsedSessionKey` 纪律约束。
     */
    if (
      workbench.segmentStep?.id === 'movement.breakout' &&
      collapsedSessionKey.value !== currentStepKey.value
    ) {
      return {
        kind: 'breakout',
        title: '突围（12.8e）',
        rule: '12.8e',
        width: 'min(430px, 94%)',
      }
    }
    /*
     * B17a-2（方案 §4.7）：**盒内动作也进会话框**——「在盒卡里点到需要规则判定的动作 ⇒
     * 不弹第二个面板，而是在地图页展开那一个会话框；盒卡只负责『选谁』」。
     * 触发判据＝托盘里**展开着一张盒卡**（`containers.cardOpenId`）：展开本身就是在说
     * "我要对这个盒做点什么"，会话随之给出该盒相关的动作（抽签 / 收纳 / 移出 / 返场 / 离箱…）。
     */
    if (containers.cardOpenId !== null && collapsedSessionKey.value !== currentStepKey.value) {
      return {
        kind: 'containers',
        // C-1：标题点明**是哪一张卡**（动作已按该卡覆盖的盒过滤，见 ContainersPanel）
        title:
          containers.openCardName === null
            ? '盒内动作（1.4 / 1.6c / 13.7）'
            : `盒内动作：${containers.openCardName}（1.4 / 1.6c / 13.7）`,
        rule: '13.7',
        width: 'min(430px, 94%)',
      }
    }
    /*
     * B17a-3：**专规动作**的会话——由顶栏的「专规动作」按钮**显式**打开。
     *
     * 为什么不按环节触发：专规动作**跨多个段**（3.3b 治安检查在任意 H 清理段、16.0b 工事在移动段、
     * 1.7 补给缓存在 D 段、3.4 装甲集群是随时可声明的归属）——没有哪一个环节名能代表它们，
     * 硬挑一个环节只会让玩家在别处找不到入口。故用显式的工具按钮（与用户"能达成目的"的口径一致）。
     */
    /*
     * B37（方案 §3 步骤 2）：**专规会话改为"有本环节可做的专规动作时自动出现"** ——
     * 修前它靠顶栏一个常驻按钮（玩家得先知道"这条专规现在能做"才会去点它）。
     * 判据走闸门（`workbench.exclusiveActionsInStep`）：本环节一条可做的都没有 ⇒ 不弹。
     * 收起后在本环节内不再重现（与增援/盒内动作同一套 `collapsedSessionKey` 纪律）。
     */
    if (
      (workbench.exclusiveActionsInStep.length > 0 || exclusiveOpen.value) &&
      collapsedSessionKey.value !== currentStepKey.value
    ) {
      return {
        kind: 'exclusive',
        title:
          workbench.exclusiveActionsInStep.length > 0
            ? `专规动作：${workbench.exclusiveActionsInStep.map((item) => item.label).join(' / ')}`
            : '专规动作（1.7 / 3.3b / 3.4 / 3.5 / 16.0）',
        rule: workbench.exclusiveActionsInStep[0]?.rule ?? '专规',
        width: 'min(430px, 94%)',
      }
    }
    return null
  })

  /**
   * B17a-3：专规动作会话的开关（顶栏按钮打开 ⇒ 地图上展开那一个会话框）
   *
   * 与 `collapsedSessionKey` 无关：它是"想用时打开"，不是"环节到了自动出现"。
   */
  const exclusiveOpen = ref(false)

  /**
   * 打开/关闭专规动作会话（验证页与测试用的**显式**开关；对局台已改为按闸门自动出现）
   *
   * B37：显式打开要能**压过"本环节已收起"** —— 否则玩家收起一次之后就再也打不开了；
   * 关掉时只复位开关（收起态由 `cancelSession` 记）。
   */
  function setExclusiveOpen(open: boolean): void {
    exclusiveOpen.value = open
    if (open) collapsedSessionKey.value = null
  }

  /**
   * B17a：**被玩家收起的会话**（只认"可收起"的那几种）
   *
   * 与 `combat`/`barrage`/`move` 那几种不同：**增援段的动作面板**不是一台状态机，
   * 它的存在只是"此刻这个环节允许做这些事"；玩家看完就可以把它收走（不必等环节结束）。
   * 收起记在**环节键**上（`回合|阶段|环节`）——换环节/换回合自然失效，不必手清。
   */
  const collapsedSessionKey = ref<string | null>(null)

  /** 当前环节键（收起态就是按它记的） */
  const currentStepKey = computed<string>(
    () =>
      `${String(workbench.turn)}|${workbench.phase}|${workbench.segmentStep?.id ?? workbench.segmentStepIndex}`,
  )

  /**
   * 取消当前会话 —— **标题栏「×」与 `Esc` 共用的唯一一条路**
   *
   * 一律落到引擎/操作台的 `cancelXxx`（方案 §4.3「Esc = 取消当前会话（等价于「取消」按钮）」）：
   * 视图侧不自己拼"关掉面板"的语义，否则同一件事会有两种收场（一种回滚、一种不回滚）。
   * 返回是否真的取消了（快捷键层据此决定要不要吃掉这次按键）。
   */
  function cancelSession(): boolean {
    // B27：正在待点格 ⇒ Esc / × 先退它（它是"最后发生的事"，也是一次显式的模态选择）
    if (workbench.cancelHexPick()) return true
    const current = session.value
    if (current === null) return false
    // 10.0 的「放弃本次轰炸」是 `cancelBarrage`（写 10.0 的日志）；此前视图用的是
    // `setBarrageActive(false)`——那会把「轰炸工具」一并关掉，且日志说成"工具已关闭"，
    // 与面板里的「取消」按钮不是同一件事。
    if (current.kind === 'combat') {
      // B15b：**宣布之前**的会话没有引擎状态可取消 ⇒ 取消＝清掉这次的选子与防御格（9.1）
      if (workbench.combatState === null) workbench.clearCombat()
      else workbench.cancelCombat()
    } else if (current.kind === 'move') {
      /*
       * ★ B26：`kind:'move'` 有**两个来源**——真在移动的（`moveInteraction` 非空）
       *   与"选了耗油单位但还没加油"的待付态（`fuelPaymentDue` 为真时 `moveInteraction` 是 null）。
       *   修前一律调 `abortMoveNow()`，而它在没有移动交互时第一行就返回 ⇒
       *   **缺油那一路点 × 毫无反应**（用户报告 #4「堆叠会话框点 × 有时候关不掉」）。
       */
      if (workbench.moveInteraction !== null) workbench.abortMoveNow()
      else {
        // 没在移动 ⇒ 退掉这次选中与待付（`movePick` 也要清，否则付款受益集还挂着）
        workbench.cancelMovePick()
        workbench.selectedId = null
      }
    }
    // B15d/B15e：空军的"放弃本次任务"与补给的"放弃本次检查"各自已有 cancelXxx（会清掉选子/中间态）
    else if (current.kind === 'air') {
      workbench.cancelAir()
      airEntryTarget.value = null
    } else if (current.kind === 'supply') workbench.cancelSupply()
    // B17a：增援段的动作面板没有状态机可回滚 ⇒ 收起它（记在环节键上，换环节自然重现）
    else if (current.kind === 'reinforce') collapsedSessionKey.value = currentStepKey.value
    // B17a-2：盒内动作同理——收起 = 把那张盒卡也合上（它正是这个会话的触发源）
    else if (current.kind === 'containers') {
      containers.cardOpenId = null
      collapsedSessionKey.value = currentStepKey.value
    }
    //
    // B17a-3 + B37：专规动作既是"想用时打开"的会话，也会**按闸门自动出现** ⇒
    // 取消要**两样都做**：关掉显式开关 ＋ 记下"本环节已收起"（否则自动出现会立刻把它弹回来）。
    else if (current.kind === 'exclusive') {
      exclusiveOpen.value = false
      collapsedSessionKey.value = currentStepKey.value
    }
    // 条 12（M2）：单位动作会话没有引擎状态机 ⇒ 收起即清掉"正在对其做动作"的那枚
    else if (current.kind === 'unit') unitActionHex.value = null
    // B15c：同理——宣布之前退掉参炸选子，宣布之后才是 `cancelBarrage`
    else if (workbench.barrageState === null) workbench.clearBarrageSelectionNow()
    else workbench.cancelBarrage()
    return true
  }

  const popup = ref<MapPopupState | null>(null)

  /** 打开小窗（锚点由视图用 `MapCanvas.hexToLocal` 换算后传入） */
  function openPopup(hex: HexRef, x: number, y: number): void {
    popup.value = { hex: { col: hex.col, row: hex.row }, x, y }
  }

  /** 关闭小窗 */
  function closePopup(): void {
    popup.value = null
  }

  /**
   * 批 A 切片 3①：**会话非空 ⇒ 不开小窗**（"同一时刻只有一个对话框"的结构保证）
   *
   * 用户口径（9.16 #3 后半 / #17）：「点一格同时出现『格子内容』小窗与『移动结算』会话框」不该发生。
   * 修前摊开堆叠那一支在闸门**之前**就 `return`，并**无条件** `openPopup`（`map-view.ts:1213-1218`）——
   * 而摊开会同时建立取子清单（`beginMovePick`），缺油单位的堆叠于是当场长出"移动/燃料"会话，
   * 与小窗同屏。现在两个开窗点都过这道闸：**这一击已经产生会话，就不再另开小窗**。
   *
   * ★ 与"会话**在跑**时点地图"的差别：那种情况（例如战斗中给撤退落点定格子、点补给站付款）
   *   本函数不会被调用（那条路径由 `onHexClick` 末尾按"会话种类没变才开窗"处理）——即
   *   **小窗仍是会话的"地图点选辅助"**，只是不再与"刚起来的会话"抢同一屏。
   */
  function openPopupIfIdle(hex: HexRef, anchor?: { x: number; y: number }): void {
    if (anchor === undefined) return
    if (session.value !== null) return
    openPopup(hex, anchor.x, anchor.y)
  }

  /**
   * 批 A 切片 3①：**会话一出现就把已开的小窗收掉**（修前没有任何 watcher 管这件事）
   *
   * 与 `openPopupIfIdle` 同一目标的两半：那一半防"同一击开两个框"，这一半防"小窗开着、
   * 会话从别的路径起来了"（面板按钮 / 快捷键 / 自动连跑推进入下一环节时自动开会话）。
   * 判据用**会话种类**（`session` 是 computed，每次求值都是新对象，直接 watch 会因无关重算而误关）。
   */
  watch(
    () => session.value?.kind ?? '',
    (kind) => {
      if (kind !== '') closePopup()
    },
    // flush: 'sync' —— 本击之内就要收干净：否则同一拍里"会话已起、小窗还开着"，
    // 视图会画出一帧两个框（也与用例的即时断言口径一致）。
    { flush: 'sync' },
  )

  /** 小窗内容：这一格有什么（地面按 4.9a 裁剪；飞机只列本方） */
  const popupContent = computed<MapPopupContent | null>(() => {
    const state = popup.value
    if (state === null) return null
    const all = fogVisibleTokens(groundTokens()).filter(
      (token) => token.hex.col === state.hex.col && token.hex.row === state.hex.row,
    )
    /*
     * 批 A 切片 3②：**候选按环节过滤**（用户口径 9.17⑤）。
     *   己方算子只有"本环节能行动"的那些进候选（判据＝操作台的参与集合，与地图上的可点性**同一条**）；
     *   敌方算子照列（4.9a 的目标，不是候选）；被滤掉的己方算子给一行如实交代（含规则号）。
     */
    const actionableOwnIds = all
      .filter(
        (token) =>
          token.side === workbench.activeSide && workbench.participatingUnitIds.includes(token.id),
      )
      .map((token) => token.id)
    const blockedOwn = all
      .filter(
        (token) => token.side === workbench.activeSide && !actionableOwnIds.includes(token.id),
      )
      .map((token) => {
        const verdict = participationVerdictOf(token.id)
        const step = workbench.segmentStep
        return {
          id: token.id,
          label: token.label,
          rule: verdict !== null && !verdict.ok ? verdict.rule : (step?.rule ?? '2.2'),
          reason:
            verdict !== null && !verdict.ok ? verdict.reason : '本环节不参与（不在可行动集合里）',
        }
      })
    return {
      hex: state.hex,
      units: all,
      airUnits: workbench.airUnitsAt(state.hex, workbench.activeSide),
      hidden: hotseat.hasHiddenContent(state.hex),
      actionableOwnIds,
      blockedOwn,
    }
  })

  /** 该格是否在「当前该方的撤退落点」里（点它＝给当前单位定落点） */
  function retreatDestinationAt(hex: HexRef): boolean {
    const plan = retreatSidePlan.value
    if (plan === null) return false
    const unit = retreatUnit.value
    if (unit === null) return false
    return unit.destinations.some((item) => item.hex.col === hex.col && item.hex.row === hex.row)
  }

  /** 该格是否是当前可付款的补给站 */
  function supplyDumpAt(hex: HexRef): { id: string; side: 'attacker' | 'defender' } | null {
    const found = combatSourceDumps.value.find(
      (dump) => dump.hex.col === hex.col && dump.hex.row === hex.row,
    )
    return found === undefined ? null : { id: found.id, side: found.side }
  }

  /** 条 12（M2）：该格是否有**非战斗单位**（sp / 运输点 / 延补队 / 空军基地 / 工事…） */
  function hasNonCombatUnitAt(hex: HexRef): boolean {
    return workbench.units.some(
      (unit) =>
        unit.hex.col === hex.col &&
        unit.hex.row === hex.row &&
        (unit.noncombatKind ?? null) !== null,
    )
  }

  /**
   * 条 19（A1）：这一点是否值得开**空军任务入口**（target-first）
   *
   * 三条件（都满足才开，避免打扰常规的点选 / 移动 / 小窗）：
   *   ① 当前环节允许空军来源（`barrageKindsInSegment` 含 air：C/E/G 段）；
   *   ② 该格**没有己方地面算子**（有 ⇒ 这是选子 / 移动，不是空军入口；非战斗单位格已由 M2 先拦）；
   *   ③ 有飞机**按航程**够得到该格（`anyOwnAircraftReaches`）。
   */
  function airEntryEligible(hex: HexRef): boolean {
    if (!workbench.barrageKindsInSegment.includes('air')) return false
    const friendlyHere = workbench.units.some(
      (unit) =>
        unit.hex.col === hex.col && unit.hex.row === hex.row && unit.side === workbench.activeSide,
    )
    if (friendlyHere) return false
    return workbench.anyOwnAircraftReaches(hex)
  }

  /**
   * 点地图（地图优先交互的**唯一入口**）
   *
   * ★ B26 重排（用户报告「一次点击出现两个框」「点堆叠总是默认移动第一枚」「炮击选不中炮兵」）：
   *   修前的次序是「**先**交给操作台 `clickHex`（棋子语义：选中/取子/开拔）**再**决定摊开与小窗」，
   *   于是操作台的副作用总是先发生 —— 选中被写成"堆叠顶上一枚"、取子集被覆盖成整格、
   *   同一次点击既起了移动（会话框）又开了小窗。现在的次序：
   *
   *   ⓪ 已摊开 ⇒ 全交给展开态（点枚切换 / 翻页 / 点空白收起），**不再往下走**；
   *   ① 初设落位（IV）：点地图即落位；
   *   ② **模态待决**：位移 / 突袭 / 撤退 / 推进 / 战斗补给站 / 空军任务格 —— 玩家已明确表达"在选什么"；
   *   ③ 闲置态点到有堆叠的格 ⇒ **就地摊开**（"看这一格"优先于"开始移动"）；
   *   ④ 其余才交给 `clickHex`（选单位 / 开拔 / 走一步 / 打一仗）。
   *
   *   末尾的小窗再叠一道闸：**本击已经产生/切换了会话框，就不再开小窗**（一次点击只出一个 UI）。
   */
  function onHexClick(
    hex: HexRef,
    anchor?: { x: number; y: number },
    world?: { x: number; y: number },
  ): void {
    /*
     * 条 6（R3）：突围环节**点可突围的单位即自动结算**（12.8e）。
     * 排在 `handleStackClick` 之前：本环节不进"展开/选枚"那一套，点格直接当作"对这枚突围"——
     * 骰子缺省自动（`breakoutNow` 在 `breakoutInputs.die` 为空时自掷），故点一下即尝试一次突围。
     */
    if (isBreakoutSegment.value) {
      const target = breakoutUnitIdAt(hex)
      if (target !== null) {
        workbench.breakoutNow(target)
        return
      }
    }
    // ⓪ 已摊开 ⇒ 展开态优先，且**不落到下面的既有分派**
    if (world !== undefined && handleStackClick(hex, world)) return
    // W7 C14：初设放置中 ⇒ 点地图即落位（最高优先级；非候选格由 store 记拒绝，不开常规小窗）
    if (setup.placing !== null && setup.placeAtHex(hex)) {
      closePopup()
      return
    }
    /*
     * 第六批条 2（S2）：**卡车装载的地图点选** —— 点高亮的卡车即装载/卸载（13.2h）。
     * 与"落位"是两件事（不移动算子，只改 `loadedSpT`），故单列在初设落位之后。
     */
    if (setup.truckPickActive && setup.pickTruckAtHex(hex)) {
      closePopup()
      return
    }
    /*
     * B27：**通用待点格**——初设之外的一切"要一个格号"的动作都走这里
     * （增援落点 / 工事格 / 补给站 / 铁路卸货格 / 空军基地格 …）。
     * 它排在所有待决分派之前：玩家已经明确表达"我在选一个格"，这一击就该归它。
     */
    if (workbench.pickHexFor(hex)) {
      closePopup()
      return
    }
    /*
     * 条 15/16（批 F·F1）：选项页草稿的**地图点选**（模态式，优先于常规分派）。
     *   · 「受损」模式：点本结算方参战单位 ⇒ 该单位记 1 点军力损失（草稿）
     *   · 「撤退」模式：点高亮的可撤退格 ⇒ 按该格距离记撤退（草稿）
     * 两种模式下点不到合法目标都只当「取消选择」——不让这一击落到别的分派上。
     */
    if (workbench.optionDraftMode !== 'idle') {
      if (workbench.optionDraftMode === 'loss') {
        const target = workbench.combatOptionLossTargets.find(
          (item) => item.hex.col === hex.col && item.hex.row === hex.row,
        )
        if (target !== undefined) workbench.applyOptionDraftLoss(target.id)
      } else {
        workbench.applyOptionDraftRetreatAt(hex)
      }
      closePopup()
      return
    }
    // 会话框在这一击前后的"种类"（用来判"本击是不是刚开/换了会话"）
    const sessionKindBefore = session.value?.kind ?? ''
    // 展开只在「点之前就没有进行中的交互」时发生（此时 clickHex 还没跑，判据是干净的）
    const idleBefore = isIdleForStack()
    const isOverrunTarget = workbench.overrunTargets.some(
      (hint) => hint.hex.col === hex.col && hint.hex.row === hex.row,
    )
    const advanceHex = workbench.combatAdvanceHex
    const dump = supplyDumpAt(hex)
    const specialItemNow = specialItem.value
    // 15.1：整备付款优先——正点着高亮的补给站即「用这个补给站付 1T」
    const refitDump = refitPayHints.value.find(
      (hint) => hint.hex.col === hex.col && hint.hex.row === hex.row,
    )
    let consumed = false
    if (workbench.refitBase !== null && refitDump !== undefined) {
      const payDump = workbench.refitPayDumps.find(
        (item) => item.hex.col === hex.col && item.hex.row === hex.row,
      )
      if (payDump !== undefined) {
        workbench.pickRefitPayDump(payDump.id)
        consumed = true
      }
    }
    if (
      !consumed &&
      workbench.specialPending !== null &&
      specialDestinationAt(hex) &&
      specialItemNow !== null
    ) {
      // 9.14c/d：位移落点由原主在地图上点选（优先级最高——这是必须收束的待决）
      workbench.setSpecialDisplacement(specialItemNow.unitId, hex)
      specialUnitId.value = null
      consumed = true
    }
    if (!consumed && isOverrunTarget) {
      workbench.overrunNow(hex)
      consumed = true
    }
    if (!consumed && retreatDestinationAt(hex) && retreatUnit.value !== null) {
      workbench.setRetreatDestinationNow(retreatUnit.value.unitId, hex)
      retreatUnitId.value = null
      consumed = true
    }
    if (
      !consumed &&
      advanceHex !== null &&
      advanceHex.col === hex.col &&
      advanceHex.row === hex.row
    ) {
      workbench.advanceNow(hex)
      consumed = true
    }
    if (!consumed && dump !== null) {
      workbench.pickCombatSupplyDump(dump.side, dump.id)
      consumed = true
    }
    if (!consumed && workbench.airActive && workbench.airMissionAirIds.length > 0) {
      // 14.2f-B：已点选飞机 / 一组飞机后，点目标格即定任务格
      workbench.setAirTargetFromText(`${hex.col}.${hex.row}`)
      consumed = true
    }
    if (!consumed) {
      /*
       * 条 12（M2）：**点非战斗单位 ⇒ 开对应动作会话**（SP 拖取 / 运输点装卸 / 延补队 / 基地整备 / 工事）。
       * 排在摊开 / 既有分派之前：这一击明确表达"对这枚非战斗单位做动作"，就开那一个会话
       * （右栏原可写面板已收进会话，右栏只读）。点别处则收掉（见下一行的清理）。
       */
      if (isIdleForStack() && hasNonCombatUnitAt(hex)) {
        unitActionHex.value = { col: hex.col, row: hex.row }
        closePopup()
        return
      }
      /*
       * 条 19（A1）：**点地面格 ⇒ 空军任务对话框**（target-first：按航程列机）。
       * 三条件见 `airEntryEligible`；命中即把该格预填为任务格、打开空军工具、置引导态 ⇒
       * `air` 会话弹出（AirPanel mission 段列出够得到该格的机，选机/编队＋任务类型 → `runAirMissionNow`）。
       * 单框纪律：开会话即不再另开小窗。
       */
      if (isIdleForStack() && airEntryEligible(hex)) {
        // ★ 顺序：先确保空军工具开（`setAirActive` 内部 `clearAir` 会清 airTargetHex），**再**填任务格
        if (!workbench.airActive) workbench.setAirActive(true)
        workbench.setAirTargetFromText(`${hex.col}.${hex.row}`)
        airEntryTarget.value = { col: hex.col, row: hex.row }
        closePopup()
        return
      }
      // 点别处（战斗单位 / 空格 / 走一步）⇒ 收掉可能开着的单位会话 + 空军引导态
      if (unitActionHex.value !== null) unitActionHex.value = null
      if (airEntryTarget.value !== null) airEntryTarget.value = null
      // ③ 闲置态点到有堆叠的格 ⇒ **就地摊开**（用户口径：默认全选、点枚即取消）
      if (idleBefore && isIdleForStack() && stackTokenIdsAt(hex).length >= STACK_FAN_MIN_TOKENS) {
        expandStackAt(hex)
        /*
         * 批 A 切片 3①：摊开后**只有没产生会话时**才开小窗。
         * 摊开会建立取子清单 ⇒ 缺油单位当场长出「移动 / 燃料（12.5）」会话；那时再开小窗
         * 就是用户报的"点一格出现两个框"。有会话时玩家要的东西在会话里（付油按钮 + 地图上的
         * 摊开选择集），小窗反而挡路。
         */
        openPopupIfIdle(hex, anchor)
        return
      }
      // ④ 其余交给操作台的既有分派（选单位 / 走一步 / 打一仗）
      workbench.clickHex(hex)
    }
    /*
     * 小窗闸（B26）：本击**刚产生或刚换了会话框**（例如点一枚己方单枚 ⇒ 起了移动结算）时不再开小窗，
     * 否则同一次点击会出现"移动结算 + 格子内容"两个框（用户报告 #17）。
     * 判据用"会话种类"而不是对象身份：`session` 是 computed，每次求值都是新对象。
     *
     * ★ 批 A 切片 3① 再补一道（同一口径的更严版本）：**会话在跑时**，只有"被**该会话自己的地图点选**
     *   消费掉的那一击"（`consumed`，例如点高亮的撤退落点 / 补给站 / 推进格 / 空军任务格）才开小窗
     *   —— 那是会话的辅助窗（就地点选的回执）；其余的点击（例如移动中踩一步、战斗中点别处）
     *   不再弹出"格子内容"窗，动作控件都在会话面板里（CombatPanel / MovePanel 各自齐全）。
     */
    const sessionKindAfter = session.value?.kind ?? ''
    if (sessionKindAfter !== sessionKindBefore) return
    if (sessionKindAfter !== '' && !consumed) return
    if (anchor !== undefined) openPopup(hex, anchor.x, anchor.y)
  }
  return {
    // 画什么
    overlay,
    // 5.0c：胜利格控制标记（地图事实层；不是交互覆盖层，也不可选中）
    boundary,
    controlMarkers,
    // 用户口径：地图上方不放消息栏 ⇒ 这一行搬进流程条（方案 §4.5 的动作提示带）
    actionHint,
    // B17a-3：专规动作会话的开关（顶栏按钮打开）
    exclusiveOpen,
    setExclusiveOpen,
    hasOverrunTargets,
    overrunHint,
    fogVisibleTokens,
    // 4.5：ZOC 覆盖层（默认关；开启后铺出双方的 ZOC 覆盖格）
    zocLayerVisible,
    zocLayerFromTokens,
    // 战斗收尾（9.12 / 9.12g / 12.4）
    retreatSidePlan,
    retreatUnit,
    retreatUnitId,
    retreatHint,
    setRetreatUnit,
    combatSourceDumps,
    // 9.14c/d 特殊战斗：位移落点（在地图上选）
    specialItem,
    specialUnitId,
    specialHint,
    setSpecialUnit,
    // B3：就地展开堆叠（点格摊开 / 点枚切换 / 收起）
    expandedStack,
    stackSelection,
    expandStackAt,
    collapseStack,
    clearStackSelection,
    isStackExpanded,
    handleStackClick,
    // B4：唯一会话框（路由 + 唯一取消路径）
    session,
    cancelSession,
    // 条 12（M2）：点非战斗单位开的动作会话（按类型分派到补给账本 / 空军整备 / 工事）
    unitActionHex,
    unitActionFamily,
    airEntryTarget,
    // 点什么
    popup,
    popupContent,
    openPopup,
    closePopup,
    onHexClick,
  }
})
