import type { HexRef, Side } from '@/data'

import {
  HEX_COL_SPACING_PX,
  HEX_RADIUS_PX,
  HEX_ROW_SPACING_PX,
  hexCanvasCorners,
  hexCanvasPoint,
} from './map-layout'
import { combatNoncombatColumns, stackFanLayout } from './stack-fan'
import {
  MARKER_TEXTURES,
  counterImages,
  exploitTextureUrl,
  markerTextureUrl,
  tokenImageUrl,
} from './token-images'

/**
 * 移动交互的地图覆盖层（C5）——算子与移动提示的 Canvas 绘制
 *
 * 本模块只画**给定数据**：可到达范围、预览路径、算子令牌。规则结论一律由
 * `engine/rules/move-interaction.ts` 给出，本模块不重算任何规则数值（CODE_SPEC §3.1）。
 *
 * 绘制前提：调用方（`map-render.drawMap`）已把变换设为世界坐标，
 * 故此处一切坐标都是世界坐标，线宽/字号只需除以 `scale` 即为「屏幕恒定粗细」。
 */

/** 算子令牌（呈现用视图，由状态层投影） */
export interface UnitToken {
  id: string
  hex: HexRef
  side: Side
  /**
   * 单位库主键（选**算子图**用；缺省 ⇒ 无图，回退矢量画法）
   *
   * 本字段是「印值以外的信息」的载体：改数值只改 `label`，换图要按 unitId + 朝向查 `images`。
   */
  unitId?: string
  /** 当前朝向（5.4a：一切数值以朝向那一面为基准，图同理）；缺省按战斗面 */
  face?: 'combat' | 'move'
  /** 该记录的算子图文件名（`units-*.json` 的 `images`）；缺省 = 无图 */
  images?: { front?: string | null; back?: string | null } | null
  /**
   * 非战斗单位类别（`noncombatKind`）
   *
   * **计数类**非战斗算子的图**随当前数值走**（SP 看点数、机场看等级、工事看等级），
   * 故要把类别与数值一并交给渲染层选图（选图逻辑在 `token-images.tokenImageUrl`）。
   */
  noncombatKind?: string | null
  /** 12.1a：SP 当前点数（决定用哪张 SP 图） */
  spPoints?: number | null
  /** 13.8d / 16.0：非战斗单位当前等级（空军基地 1–3 / 环形工事 1–4） */
  noncombatLevel?: number | null
  /**
   * 13.2f/h：已装 SP（内部以 T 计）
   *
   * **编内卡车**的两面就是「满载 1F-45 / 空载 1-45」（用户 2026-09-15 裁定），而运输单位
   * 只有移动模式（13.0）⇒ 它的面由**装载**决定，故这里把装载量交给选图入口。
   */
  loadedSpT?: number | null
  /** 令牌上显示的印值文本（如 `5-4-6`） */
  label: string
  /** 是否被选中 */
  selected: boolean
  /** 本轮移动是否已结束（4.5a-A / 6.1c / 6.2b / 掉队） */
  ended: boolean
  /**
   * B9：**本环节不参与**（B7 的 participatesIn 说不参与）⇒ 灰显且点不动
   *
   * 只标**本方**算子：敌方算子本就只读（4.9a 的雾显已在管它），再灰一层反而看不出敌我。
   */
  disabled?: boolean
  /** 生效模式字母：C 战斗 / M 移动 / R 预备 / S 战略 */
  modeLetter: string
  /** 是否混乱（5.10） */
  dg: boolean
  /** 是否需要燃料且尚未加注（12.5a） */
  awaitingFuel: boolean
  /** 是否已加注燃料（12.5） */
  fuelled: boolean
  /** 5.9：带**进击**标记（贴进击贴图标出；原先只能靠模式字母猜基础模式） */
  exploit?: boolean
  /** 5.8：处于**战略模式**（贴战略贴图） */
  strat?: boolean
  /** 12.8：**断补**（贴断补贴图） */
  outOfSupply?: boolean
  /**
   * W7 C13（4.9a）：该枚是**敌方堆叠的可见顶牌**，其下还有不可见的单位
   *
   * 只画一个提示环；**不得**据此显示枚数（枚数属于「看穿堆叠」，4.9a 不允许）。
   */
  hiddenStack?: boolean
  /**
   * 3.6e / 4.6：**已损失军力点数**（多军力单位专用 ⇒ 左上角标 `(-N)`）
   *
   * 规则原文（通规 v4.3）：
   *   3.6e「**军力损失标记**。用于显示**多军力单位**的军力损失。」
   *   4.6「一个多军力单位每损失 1 点军力，其 RE 规模便减一（9.11）。所有其他战斗单位在承受
   *        军力损失时，都视为只有 1 点军力，与其 RE 规模无关。」
   *   ⇒ 只有**多军力**单位（印值军力 > 1）才用得上这个标记，N ＝ 印值军力 − 当前军力。
   *
   * ★ **战雾纪律（4.9a）**：「虽然敌方玩家会得知最上方单位是否处于战略模式、DG，或是否断补，
   *   但**无权获取部队储备或损失军力**的情况」⇒ 敌方那一枚**不画**这个角标。
   *   裁剪在 store 的令牌投影里做（只给己方算 `stepsLost`），本模块**只画传进来的数**，
   *   不自己判敌我——判据只有一处，免得两处口径打架。
   */
  stepsLost?: number
  /**
   * W7 C16：该枚是**飞机**（14.1a：停在其空军基地格）
   *
   * 飞机与地面算子画法不同（菱形 + 机型字母），以免玩家把停在同一基地格的飞机当地面单位。
   */
  air?: boolean
}

/** 可到达格提示 */
export interface ReachableHint {
  hex: HexRef
  /** 走到该格的累计 MP（圈内数字） */
  mpSpent: number
  /** 到达后被迫停止（4.5a-A） */
  forcedStop: boolean
  /** 只能靠 6.1c 最小移动到达 */
  minimumMove: boolean
  /** 该格处于未抵消的敌方 ZOC（4.5a-A：进入须确认） */
  inEnemyZoc: boolean
}

/** 移动覆盖层 */
export interface MovementOverlay {
  tokens: readonly UnitToken[]
  /** 可到达范围（本次移动中的活跃单位） */
  reachable: readonly ReachableHint[]
  /** 预览路径（起点…目标；空数组表示无预览） */
  path: readonly HexRef[]
  /** 本次移动的起点格（高亮起脚点） */
  startHex: HexRef | null
  /** 已选中的单位实例 id（高亮用） */
  selectedIds: readonly string[]
  /**
   * **就地展开的堆叠**（B2，用户 2026-09-16 #1）
   *
   * 点格即在该格内把每一枚摊开（不再只画顶牌）：`page` 为当前页（>4 枚时分页，点角标翻页）。
   * 未展开（undefined/null）时维持原状：一格只画顶牌 + 枚数角标。
   */
  expandedStack?: { hex: HexRef; page: number } | null
  /**
   * 可突袭目标（W7 C16：8.0/8.1 的**行进间强攻**）
   *
   * 移动中，相邻且满足 8.1a（剩余 MP ≥ 3）/8.1b（进格 ≤ 3 MP）/8.1c 的敌方格即候选；
   * 判定由 `engine/rules/move.ts#canOverrun` 与 `overrun.ts#overrunEligibility` 给出，
   * 本模块只画一个与前两者**不同色**的环 + 代价文字（3 MP），让玩家一眼看出「这里能突袭」。
   */
  overrunTargets?: readonly OverrunTargetHint[]
  /**
   * 条 21（批 F·F2）：战斗段「可攻击位置」高亮（9.0/9.1）
   *
   * 战斗工具已开、且尚未选定防御格时，把「当前攻方选择集能合法攻击的敌方战斗单位所在格」
   * 实时算出来画一个与前两者**不同色**的环，让玩家一眼看出「这里能打」。判定一律来自
   * 状态层的 `combatAttackableHexes`（引擎 `checkLegality` 裁决），本模块只画环。
   */
  combatAttackableHexes?: readonly HexRef[]
  /**
   * 9.12 撤退落点（W7 C16：战斗收尾的「就在地图上选撤退格」）
   *
   * 分两组画：`safe`＝不在敌方未抵消 ZOC 内的落点，`zoc`＝在 ZOC 内（9.12e：进入即 DG）。
   * 数据来自 `engine/rules/battle.ts#planRetreatDestinations`。
   */
  retreat?: RetreatOverlay | null
  /**
   * 9.12g 战后推进格（W7 C16）
   *
   * 防御格已清空时，攻方可以推进到该格；数据来自状态层（`combatDefendingHexCleared` + 防御格坐标）。
   */
  advance?: readonly HexRef[]
  /**
   * 可消耗的补给站（W7 C16：发起战斗/轰炸时「高亮该方可选择的补给站」）
   *
   * 数据来自状态层的 SP 账本（12.1b 任何含 SP 的位置都是补给站）。
   */
  payDumps?: readonly SupplyPickHint[]
  /** 补给覆盖层（C8：拖取/投递可视化；无则 null） */
  supply?: SupplyOverlay | null
  /** 巡逻区覆盖层（C9：14.4c；无则 null） */
  patrolZone?: PatrolZoneOverlay | null
  /**
   * 9.14c/d：设施/后勤目标被夺取后，**由原主选择的位移落点**（无待决则 null）
   *
   * 规则原文（9.14c）：「其余的则会被转移（有点像撤退）」＋「敌方单位、ZOC 和禁入地形都**不会影响**
   * 运输点数的转移，只需拿起运输点数并将其放置在新的位置上即可」；9.14d 同理（另加「该格此时拥有
   * 追溯补给」）。故候选格按**格距上限**（9.14c＝rules-constants 的 transportDisplaceMaxHexes；
   * 9.14d＝该延补队的特殊拖取距离）铺出，由玩家在地图上点选。
   */
  specialDisplace?: SpecialDisplaceOverlay | null
  /**
   * 初设落点候选（W7 C14：地图点选放置）
   *
   * 玩家在「初设单位 box」里点了一项 ⇒ 该项的合法落点在此高亮。数据一律来自引擎
   * （自选格项＝`setupCandidates`；飞机＝`planAirSetup` 的 `candidates`），故高亮的一定合法。
   * 点其中一格即落位（`setup.placeAtHex`）；与其它覆盖层互斥使用。
   */
  setupCandidates?: readonly HexRef[] | null
  /**
   * B27：**通用「待点格」的候选**（增援落点 / 工事格 / 补给站 / 铁路卸货格 / 空军基地格 …）
   *
   * 与 `setupCandidates` 同一种画法（青柠虚线环），区别只在触发源：初设走 `setup.placing`，
   * 其余"要一个格号"的动作全走 store 的待点态。候选为 `'any'` 时不铺高亮（map-view 给 null），
   * 此时那一行提示会说"点地图上任意一格"。
   */
  pickCandidates?: readonly HexRef[] | null
  /**
   * 15.1：整备的付款补给站候选（W7 C16）
   *
   * 用户口径：「勾选要整备的飞机后，吃补给的方式与其它方式一致 —— 点地图上高亮的可用补给进行消耗」。
   * 与 12.4 的战斗付款（`payDumps`）同一种画法（金黄方框），点它即付 1T 并结算整备。
   */
  refitPay?: readonly SupplyPickHint[] | null
  /**
   * 条 6（R3）：**可突围堆叠**高亮（12.8e）
   *
   * 突围环节里，能真正突围（过 `canBreakout` 判据）的单位所在格在此高亮——琥珀金实心环，
   * 与"待点格候选"同色系但更实，提示玩家"点这枚即自动结算突围"。无则 undefined（不铺）。
   */
  breakoutHexes?: readonly HexRef[] | null
  /**
   * 4.5：**控制区（ZOC）覆盖格集合**（无则 null）
   *
   * 数据来自 `engine/rules/zoc.ts#zocHexes`（唯一实现）：只收**投射 ZOC** 的单位
   * （可攻击 + 战斗模式 + 有追溯补给，4.5）的六邻格，图外格不计。
   * 分两组画：`friendly`＝本方 ZOC（浅色描边），`enemy`＝敌方 ZOC（警示色虚线）。
   */
  zoc?: ZocOverlay | null
}

/** 4.5：ZOC 覆盖层（按方分两组） */
export interface ZocOverlay {
  friendly: readonly HexRef[]
  enemy: readonly HexRef[]
}

/** 9.14c/d 位移落点的两组候选（`chosen` ＝玩家已选定的落点，用实心强调） */
export interface SpecialDisplaceOverlay {
  /** 全部合法落点（格距上限内；不过滤地形与敌情——规则明说无影响） */
  candidates: readonly HexRef[]
  /** 玩家已选定的落点 */
  chosen: readonly HexRef[]
}

/** 9.12 撤退落点的三组候选（安全格 / 有 ZOC 影响格 / 选了会被消灭的落点） */
export interface RetreatOverlay {
  /** 不在敌方未抵消 ZOC 内的落点 */
  safe: readonly HexRef[]
  /** 9.12e：在敌方未抵消 ZOC 内的落点（进入即 DG） */
  zoc: readonly HexRef[]
  /**
   * 9.12 / 9.12b：选它会被消灭的落点
   *
   * 「必须穿过敌方占据的格或禁入地形 ⇒ 消灭这些单位」与「任何模式下都不可移动者被迫撤退时
   * 被直接摧毁」——规则允许的结局，故同样画出来，但用危险色与虚线区分。
   */
  doomed?: readonly HexRef[]
}

/** 可消耗的补给站提示（12.1b；`selected` 为已选中的那一个） */
export interface SupplyPickHint {
  hex: HexRef
  /** 显示的持仓文本（如 `3 SP / 2 T`） */
  label: string
  /** 是否已被选中 */
  selected: boolean
}

/** 可突袭目标提示（W7 C16：8.1a 每次 3 MP） */
export interface OverrunTargetHint {
  hex: HexRef
  /** 每次突袭的固定 MP 代价（8.1a：本作 3） */
  mpCost: number
  /** 该格是否为当前**预览路径的下一步**（点它＝沿路径走到相邻格后立即突袭） */
  adjacentToPath: boolean
}

/**
 * 巡逻区覆盖层（C9：14.4c 的可视化）
 *
 * 「巡逻区是由任何拥有一个或多个激活战斗机的空军基地创建的防御区域，从空军基地向所有方向延伸 10 格」
 * ⇒ `friendly` 为本方巡逻区（拦截与防空都由此产生），`enemy` 为对手巡逻区（进入即受更猛烈防空）。
 * 数据来自 `engine/rules/air-interaction.ts#patrolZoneHexes`，本模块只画给定数据。
 */
export interface PatrolZoneOverlay {
  /** 本方巡逻区覆盖的格 */
  friendly: readonly HexRef[]
  /** 对手巡逻区覆盖的格 */
  enemy: readonly HexRef[]
}

/**
 * 补给覆盖层（C8：12.3a 拖取 / 12.3b 投递的**可视化**）
 *
 * 数据全部来自 `engine/rules/supply-interaction.ts`：
 *   - `coverage` = `supplyCoverage`（12.3d：沿补给路径逐格移动能到达的范围）；
 *   - `path`     = 来源到单位的**最省路径**（12.3d，含起终点）；
 *   - `viaAdjacency` = 12.3c「相邻即可」（路径终点是单位的相邻格而非其自身）。
 * 本模块只画给定数据，不做任何规则计算（CODE_SPEC §3.1）。
 */
export interface SupplyOverlay {
  /** 12.3a/12.3b：该来源的覆盖范围（含到每格的补给消耗 MP） */
  coverage: readonly { hex: HexRef; mp: number }[]
  /** 12.3d：来源到受补给单位的最省路径（含起终点） */
  path: readonly HexRef[]
  /** 补给来源格（高亮） */
  sourceHex: HexRef | null
  /** 受补给单位所在格（高亮） */
  targetHex: HexRef | null
  /** 12.3c：是否靠「相邻即可」成立 */
  viaAdjacency: boolean
}

/** 覆盖层配色（呈现用；与 tokens.css 的语义色一致） */
export const OVERLAY_PALETTE = {
  axis: '#7a2b2b',
  soviet: '#2f4a6b',
  axisEdge: '#4a1a1a',
  sovietEdge: '#1b2c41',
  ended: 'rgba(32, 30, 26, 0.45)',
  /** B9：本环节不参与的算子（比 ended 浅一档，免得与"本轮已动过"混淆；描边换中性灰） */
  disabled: 'rgba(32, 30, 26, 0.28)',
  disabledEdge: '#8a8377',
  reachable: 'rgba(70, 96, 76, 0.16)',
  reachableEdge: 'rgba(70, 96, 76, 0.75)',
  forcedStopEdge: 'rgba(160, 106, 31, 0.95)',
  zocEdge: 'rgba(140, 47, 34, 0.9)',
  path: '#8a6420',
  select: '#e0b64a',
  start: '#3a5a78',
  tokenText: '#ffffff',
  badge: '#201e1a',
  fuel: '#a06a1f',
  /** 3.6e：多军力单位的**军力损失**角标 `(-N)`（醒目但不压过 DG / 断补这些状态色） */
  lossBadge: '#8c2f22',
  /** W7 C13（4.9a）：敌方格「其下还有不可见单位」的提示环（只用虚线描边，不透露枚数） */
  hiddenStackEdge: 'rgba(232, 226, 210, 0.9)',
  // C8 补给覆盖层（与移动范围的绿色区分：用青色系）
  supplyCoverage: 'rgba(58, 122, 138, 0.16)',
  supplyCoverageEdge: 'rgba(58, 122, 138, 0.7)',
  supplyMpText: '#20505c',
  supplyPath: '#1f7f8f',
  supplySource: '#14606e',
  supplyTarget: '#e0b64a',
  // C9 巡逻区（14.4c）：本方蓝、对手红，虚线只描边
  patrolZoneFriendly: 'rgba(47, 74, 107, 0.55)',
  patrolZoneEnemy: 'rgba(140, 47, 34, 0.55)',
  /** 4.5：本方 ZOC（极轻填充 + 细描边，避免盖住地图） */
  zocFriendly: 'rgba(47, 74, 107, 0.10)',
  zocFriendlyEdge: 'rgba(47, 74, 107, 0.45)',
  /** 4.5：敌方 ZOC（警示色填充 + 虚线描边） */
  zocEnemy: 'rgba(140, 47, 34, 0.12)',
  zocEnemyEdge: 'rgba(140, 47, 34, 0.6)',
  /** W7 C16：可突袭目标（8.0/8.1）——用紫色系与「可到达（绿）/强制停止（琥珀）/ZOC（红）」区分 */
  overrunTarget: 'rgba(96, 62, 122, 0.22)',
  overrunTargetEdge: 'rgba(96, 62, 122, 0.95)',
  overrunText: '#4a2f60',
  /** W7 C16：9.12 撤退落点——安全格（青绿）/ 有 ZOC 影响格（橙红，进入即 DG）/ 会被消灭的落点（暗红） */
  retreatSafe: 'rgba(38, 122, 108, 0.18)',
  retreatSafeEdge: 'rgba(38, 122, 108, 0.95)',
  retreatZoc: 'rgba(186, 96, 34, 0.18)',
  retreatZocEdge: 'rgba(186, 96, 34, 0.95)',
  retreatDoomed: 'rgba(140, 47, 34, 0.16)',
  retreatDoomedEdge: 'rgba(140, 47, 34, 0.95)',
  retreatText: '#1f5f54',
  /** W7 C16：9.12g 战后推进格（橄榄绿） */
  advance: 'rgba(104, 122, 32, 0.20)',
  advanceEdge: 'rgba(104, 122, 32, 0.95)',
  /** W7 C16：可消耗的补给站（12.1b）——金黄方框；选中者实心 */
  payDump: 'rgba(224, 182, 74, 0.85)',
  payDumpSelected: 'rgba(138, 100, 32, 0.95)',
  payDumpEdge: '#5a4415',
  /** 9.14c/d：位移落点候选（青色系，与撤退的青绿区分：更偏蓝） */
  displace: 'rgba(42, 96, 138, 0.16)',
  displaceEdge: 'rgba(42, 96, 138, 0.9)',
  displaceChosen: 'rgba(42, 96, 138, 0.42)',
  displaceChosenEdge: '#1d4a6b',
  displaceText: '#1d4a6b',
  /** 同格枚数角标（4.8：一格只画一枚，其余以枚数标出） */
  stackBadge: '#1d2330',
  stackBadgeEdge: '#f2e6c8',
  stackBadgeText: '#f2e6c8',
  /** 初设落点候选（W7 C14）——青柠色，与移动/撤退/位移各色区分 */
  setupCandidate: 'rgba(122, 168, 42, 0.24)',
  setupCandidateEdge: 'rgba(96, 138, 32, 0.95)',
  setupCandidateText: '#4a6b1d',
  /** 条 6（R3）：可突围堆叠高亮（12.8e）——琥珀金与通用待点格区分，醒目提示"点这枚即突围" */
  breakout: 'rgba(214, 138, 30, 0.24)',
  breakoutEdge: 'rgba(214, 138, 30, 0.96)',
  breakoutText: '#8a5a14',
  /** 条 21（批 F·F2）：战斗段「可攻击位置」高亮——暖红环（攻击=红，与突袭紫、到达绿区分） */
  combatAttackable: 'rgba(176, 42, 38, 0.20)',
  combatAttackableEdge: 'rgba(176, 42, 38, 0.95)',
  combatAttackableText: '#8a1f1c',
} as const

/**
 * 令牌边长（世界像素）
 *
 * ## 口径：正方形算子「四个角比相接六角格的四个边略小一点」
 *   平顶六角格（`orientation = flat`）的六个顶点到格心都是 `HEX_RADIUS_PX`，上下两条是**斜边**：
 *   过 `(R,0)` 与 `(R/2, √3R/2)` 的斜边方程 y = √3(R − x)。把边长为 `s` 的正方形（四角在 `(s/2, s/2)`）
 *   塞进格内，角点不越界要求 `s/2 ≤ √3(R − s/2)` ⇒ `s ≤ 2R/(1 + √3)·√3 = HEX_ROW_SPACING/(1+√3)`
 *   （`HEX_ROW_SPACING = √3R`）。即**最大内接正方形边长 = 格高 ÷ (1+√3) ≈ 0.732 格高**。
 *   再乘一个略小于 1 的内缩系数，使四角与格边留一丝缝（`TOKEN_INSET_RATIO`）。
 */
const TOKEN_MAX_SQUARE_RATIO = 2 / (1 + Math.sqrt(3))
/** 内缩系数（「略小一点」的那一点；改这一个数即可整体缩放算子） */
export const TOKEN_INSET_RATIO = 0.94
/** 令牌边长（世界像素） */
export const TOKEN_SIZE_PX = HEX_ROW_SPACING_PX * TOKEN_MAX_SQUARE_RATIO * TOKEN_INSET_RATIO

/** 可到达圈的半径（世界像素） */
const REACHABLE_RADIUS_PX = HEX_COL_SPACING_PX * 0.3

/** 模式/状态贴图相对令牌边长的占比（贴在算子上，故略小于算子） */
const MARKER_TEXTURE_RATIO = 0.62

/**
 * 该覆盖层要用到的**算子图** URL（供 `MapCanvas` 预载；已去重）
 *
 * 与「贴图」分开：算子图随盘面走（每个单位一张），贴图固定 9 张。
 * 与 `drawToken` 用**同一个**选图入口（`tokenImageUrl`），否则预载的与实际画的不一致。
 */
export function overlayImageUrls(overlay: MovementOverlay): string[] {
  const urls = new Set<string>()
  for (const token of overlay.tokens) {
    const url = tokenImageUrl(token)
    if (url !== null) urls.add(url)
  }
  return [...urls]
}

/** 格键（`列.行`；与 `map-layout.BOARD_HEX_KEYS` 同一写法，供视口裁剪做 O(1) 判定） */
export function overlayHexKey(hex: HexRef): string {
  return `${hex.col}.${hex.row}`
}

/**
 * 视口裁剪（W7 C16：`视口内算子与重绘的性能底线`）
 *
 * 只保留落在 `visibleKeys` 里的元素：算子、可到达格、可突袭目标、补给覆盖格、巡逻区格。
 * **路径（`path`）与起点格不过滤** —— 它们是「玩家此刻正在操作的这一条线」，通常几十格以内，
 * 且一旦被裁掉会让玩家看不到自己刚点的路线（正确性优先于这点开销）。
 *
 * 这是纯函数：给定 overlay 与可见格集合，返回**新的** overlay（不改原对象），故可单测。
 */
export function cullOverlay(
  overlay: MovementOverlay,
  visibleKeys: ReadonlySet<string>,
): MovementOverlay {
  const visible = (hex: HexRef): boolean => visibleKeys.has(overlayHexKey(hex))
  return {
    tokens: overlay.tokens.filter((token) => visible(token.hex)),
    reachable: overlay.reachable.filter((hint) => visible(hint.hex)),
    path: overlay.path,
    startHex: overlay.startHex,
    selectedIds: overlay.selectedIds,
    ...(overlay.overrunTargets === undefined
      ? {}
      : { overrunTargets: overlay.overrunTargets.filter((hint) => visible(hint.hex)) }),
    ...(overlay.combatAttackableHexes === undefined
      ? {}
      : {
          combatAttackableHexes: overlay.combatAttackableHexes.filter((hint) => visible(hint)),
        }),
    ...(overlay.retreat === undefined || overlay.retreat === null
      ? { retreat: overlay.retreat }
      : {
          retreat: {
            safe: overlay.retreat.safe.filter((hex) => visible(hex)),
            zoc: overlay.retreat.zoc.filter((hex) => visible(hex)),
            ...(overlay.retreat.doomed === undefined
              ? {}
              : { doomed: overlay.retreat.doomed.filter((hex) => visible(hex)) }),
          },
        }),
    ...(overlay.advance === undefined
      ? {}
      : { advance: overlay.advance.filter((hex) => visible(hex)) }),
    ...(overlay.payDumps === undefined
      ? {}
      : { payDumps: overlay.payDumps.filter((hint) => visible(hint.hex)) }),
    ...(overlay.refitPay === undefined || overlay.refitPay === null
      ? { refitPay: overlay.refitPay }
      : { refitPay: overlay.refitPay.filter((hint) => visible(hint.hex)) }),
    ...(overlay.supply === undefined || overlay.supply === null
      ? { supply: overlay.supply }
      : {
          supply: {
            ...overlay.supply,
            coverage: overlay.supply.coverage.filter((row) => visible(row.hex)),
          },
        }),
    ...(overlay.patrolZone === undefined || overlay.patrolZone === null
      ? { patrolZone: overlay.patrolZone }
      : {
          patrolZone: {
            ...overlay.patrolZone,
            friendly: overlay.patrolZone.friendly.filter((hex) => visible(hex)),
            enemy: overlay.patrolZone.enemy.filter((hex) => visible(hex)),
          },
        }),
    ...(overlay.specialDisplace === undefined || overlay.specialDisplace === null
      ? { specialDisplace: overlay.specialDisplace }
      : {
          specialDisplace: {
            candidates: overlay.specialDisplace.candidates.filter((hex) => visible(hex)),
            chosen: overlay.specialDisplace.chosen,
          },
        }),
    ...(overlay.setupCandidates === undefined || overlay.setupCandidates === null
      ? { setupCandidates: overlay.setupCandidates }
      : { setupCandidates: overlay.setupCandidates.filter((hex) => visible(hex)) }),
    // B27：通用待点格的候选同法裁剪（视角外不画）
    ...(overlay.pickCandidates === undefined || overlay.pickCandidates === null
      ? { pickCandidates: overlay.pickCandidates }
      : { pickCandidates: overlay.pickCandidates.filter((hex) => visible(hex)) }),
    // 条 6（R3）：可突围堆叠高亮同理裁剪（视角外不画）
    ...(overlay.breakoutHexes === undefined || overlay.breakoutHexes === null
      ? { breakoutHexes: overlay.breakoutHexes }
      : { breakoutHexes: overlay.breakoutHexes.filter((hex) => visible(hex)) }),
  }
}

/** 绘制给定格的六角外框 */
function traceHex(ctx: CanvasRenderingContext2D, hex: HexRef): void {
  const corners = hexCanvasCorners(hex)
  ctx.beginPath()
  corners.forEach((corner, index) => {
    if (index === 0) ctx.moveTo(corner.x, corner.y)
    else ctx.lineTo(corner.x, corner.y)
  })
  ctx.closePath()
}

/**
 * 绘制移动覆盖层
 *
 * @param scale 当前视口倍率（用于把线宽/字号换算回世界单位）
 * @param visibleKeys 视口内格键集合（W7 C16：给了就**只画视口内的元素**；缺省全画，兼容旧调用）
 */
export function drawMovementOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: MovementOverlay,
  scale: number,
  visibleKeys?: ReadonlySet<string>,
): void {
  // W7 C16 性能底线：视口裁剪放在**唯一入口**里，绘制代码不再关心可见性
  const visible = visibleKeys === undefined ? overlay : cullOverlay(overlay, visibleKeys)

  // ① 可突袭目标（8.0/8.1）：紫色环 + 代价，画在可到达范围**之下**以免盖住 MP 数字
  if (visible.overrunTargets !== undefined && visible.overrunTargets.length > 0) {
    ctx.lineWidth = 3 / scale
    for (const hint of visible.overrunTargets) {
      traceHex(ctx, hint.hex)
      ctx.fillStyle = OVERLAY_PALETTE.overrunTarget
      ctx.fill()
      ctx.strokeStyle = OVERLAY_PALETTE.overrunTargetEdge
      ctx.setLineDash(hint.adjacentToPath ? [] : [5 / scale, 3 / scale])
      ctx.stroke()
      ctx.setLineDash([])
      const center = hexCanvasPoint(hint.hex)
      ctx.font = `${(11 / scale).toFixed(1)}px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = OVERLAY_PALETTE.overrunText
      ctx.fillText(
        `突袭 ${formatMp(hint.mpCost)} MP`,
        center.x,
        center.y + REACHABLE_RADIUS_PX * 1.1,
      )
    }
  }

  // ①-a 条 21（批 F·F2）：战斗段「可攻击位置」高亮（9.0/9.1）——暖红环，画在可突袭环之上、撤退格之下
  if (visible.combatAttackableHexes !== undefined && visible.combatAttackableHexes.length > 0) {
    ctx.lineWidth = 3 / scale
    for (const hex of visible.combatAttackableHexes) {
      traceHex(ctx, hex)
      ctx.fillStyle = OVERLAY_PALETTE.combatAttackable
      ctx.fill()
      ctx.strokeStyle = OVERLAY_PALETTE.combatAttackableEdge
      ctx.setLineDash([4 / scale, 3 / scale])
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  // ①-b 9.12 撤退落点：安全格（青绿实线）/ 有 ZOC 影响格（橙红虚线，9.12e 进入即 DG）
  //     / 选它会被消灭的落点（暗红点线，9.12 必胜穿敌 ⇒ 消灭；9.12b 不可移动者 ⇒ 摧毁）
  if (visible.retreat !== undefined && visible.retreat !== null) {
    const doomed = visible.retreat.doomed ?? []
    const groups: readonly (readonly [readonly HexRef[], string, string, number[]])[] = [
      [visible.retreat.safe, OVERLAY_PALETTE.retreatSafe, OVERLAY_PALETTE.retreatSafeEdge, []],
      [visible.retreat.zoc, OVERLAY_PALETTE.retreatZoc, OVERLAY_PALETTE.retreatZocEdge, [5, 3]],
      [doomed, OVERLAY_PALETTE.retreatDoomed, OVERLAY_PALETTE.retreatDoomedEdge, [2, 3]],
    ]
    ctx.lineWidth = 3 / scale
    for (const [hexes, fill, edge, dash] of groups) {
      for (const hex of hexes) {
        traceHex(ctx, hex)
        ctx.fillStyle = fill
        ctx.fill()
        ctx.strokeStyle = edge
        ctx.setLineDash(dash.map((value) => value / scale))
        ctx.stroke()
        ctx.setLineDash([])
      }
    }
    // 图例文字只写一次，避免每格都写字把地图糊住
    const first = visible.retreat.safe[0] ?? visible.retreat.zoc[0] ?? doomed[0]
    if (first !== undefined) {
      const center = hexCanvasPoint(first)
      ctx.font = `${(11 / scale).toFixed(1)}px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = OVERLAY_PALETTE.retreatText
      ctx.fillText('可撤退', center.x, center.y + REACHABLE_RADIUS_PX * 1.1)
    }
  }

  // ①-c 9.12g 战后推进格：橄榄绿实线环
  if (visible.advance !== undefined && visible.advance.length > 0) {
    ctx.lineWidth = 3 / scale
    for (const hex of visible.advance) {
      traceHex(ctx, hex)
      ctx.fillStyle = OVERLAY_PALETTE.advance
      ctx.fill()
      ctx.strokeStyle = OVERLAY_PALETTE.advanceEdge
      ctx.stroke()
    }
  }

  // ①-d 9.14c/d 位移落点：候选（细虚线）/ 已选（实心 + 实线），由玩家在地图上点选
  if (visible.specialDisplace !== undefined && visible.specialDisplace !== null) {
    const { candidates, chosen } = visible.specialDisplace
    ctx.lineWidth = 2 / scale
    for (const hex of candidates) {
      traceHex(ctx, hex)
      ctx.fillStyle = OVERLAY_PALETTE.displace
      ctx.fill()
      ctx.strokeStyle = OVERLAY_PALETTE.displaceEdge
      ctx.setLineDash([4 / scale, 3 / scale])
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.lineWidth = 3 / scale
    for (const hex of chosen) {
      traceHex(ctx, hex)
      ctx.fillStyle = OVERLAY_PALETTE.displaceChosen
      ctx.fill()
      ctx.strokeStyle = OVERLAY_PALETTE.displaceChosenEdge
      ctx.stroke()
    }
    const first = chosen[0] ?? candidates[0]
    if (first !== undefined) {
      const center = hexCanvasPoint(first)
      ctx.font = `${(11 / scale).toFixed(1)}px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = OVERLAY_PALETTE.displaceText
      ctx.fillText('位移落点', center.x, center.y + REACHABLE_RADIUS_PX * 1.1)
    }
  }

  // ①-e 初设落点候选（W7 C14）：青柠色实线环 + 图例，点其中一格即落位
  if (visible.setupCandidates !== undefined && visible.setupCandidates !== null) {
    const candidates = visible.setupCandidates
    ctx.lineWidth = 3 / scale
    for (const hex of candidates) {
      traceHex(ctx, hex)
      ctx.fillStyle = OVERLAY_PALETTE.setupCandidate
      ctx.fill()
      ctx.strokeStyle = OVERLAY_PALETTE.setupCandidateEdge
      ctx.setLineDash([6 / scale, 4 / scale])
      ctx.stroke()
      ctx.setLineDash([])
    }
    const first = candidates[0]
    if (first !== undefined) {
      const center = hexCanvasPoint(first)
      ctx.font = `${(11 / scale).toFixed(1)}px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = OVERLAY_PALETTE.setupCandidateText
      ctx.fillText('初设可放置', center.x, center.y + REACHABLE_RADIUS_PX * 1.1)
    }
  }

  // ①-f B27：通用待点格的候选（同一种青柠虚线环；提示文字由界面的"正在选格…"一行承担）
  if (visible.pickCandidates !== undefined && visible.pickCandidates !== null) {
    ctx.lineWidth = 3 / scale
    for (const hex of visible.pickCandidates) {
      traceHex(ctx, hex)
      ctx.fillStyle = OVERLAY_PALETTE.setupCandidate
      ctx.fill()
      ctx.strokeStyle = OVERLAY_PALETTE.setupCandidateEdge
      ctx.setLineDash([6 / scale, 4 / scale])
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  // ①-g 条 6（R3）：可突围堆叠高亮（12.8e）——琥珀金实心环，"点这枚即突围"
  if (visible.breakoutHexes !== undefined && visible.breakoutHexes !== null) {
    const hexes = visible.breakoutHexes
    ctx.lineWidth = 3 / scale
    for (const hex of hexes) {
      traceHex(ctx, hex)
      ctx.fillStyle = OVERLAY_PALETTE.breakout
      ctx.fill()
      ctx.strokeStyle = OVERLAY_PALETTE.breakoutEdge
      ctx.setLineDash([])
      ctx.stroke()
    }
    const first = hexes[0]
    if (first !== undefined) {
      const center = hexCanvasPoint(first)
      ctx.font = `${(11 / scale).toFixed(1)}px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = OVERLAY_PALETTE.breakoutText
      ctx.fillText('可突围', center.x, center.y + REACHABLE_RADIUS_PX * 1.1)
    }
  }

  // ② 可到达格：淡填充 + 圈内累计 MP（4.5a-A 的强制停止格用琥珀色描边）
  if (visible.reachable.length > 0) {
    const fontPx = 10 / scale
    ctx.font = `${fontPx.toFixed(1)}px ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 1.5 / scale
    for (const hint of visible.reachable) {
      traceHex(ctx, hint.hex)
      ctx.fillStyle = OVERLAY_PALETTE.reachable
      ctx.fill()
      ctx.strokeStyle = hint.inEnemyZoc
        ? OVERLAY_PALETTE.zocEdge
        : hint.forcedStop
          ? OVERLAY_PALETTE.forcedStopEdge
          : OVERLAY_PALETTE.reachableEdge
      ctx.stroke()

      const center = hexCanvasPoint(hint.hex)
      ctx.fillStyle = '#201e1a'
      ctx.fillText(
        `${formatMp(hint.mpSpent)}${hint.minimumMove ? '·' : ''}`,
        center.x,
        center.y - REACHABLE_RADIUS_PX * 1.1,
      )
    }
  }

  // ③ 预览路径：折线 + 折点
  if (visible.path.length >= 2) {
    ctx.strokeStyle = OVERLAY_PALETTE.path
    ctx.lineWidth = 3 / scale
    ctx.setLineDash([6 / scale, 4 / scale])
    ctx.beginPath()
    visible.path.forEach((hex, index) => {
      const point = hexCanvasPoint(hex)
      if (index === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    })
    ctx.stroke()
    ctx.setLineDash([])
    for (const hex of visible.path) {
      const point = hexCanvasPoint(hex)
      ctx.fillStyle = OVERLAY_PALETTE.path
      ctx.beginPath()
      ctx.arc(point.x, point.y, 3 / scale, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // ④ 起点格外框（提示本次移动从哪一格起脚）
  if (visible.startHex !== null) {
    ctx.strokeStyle = OVERLAY_PALETTE.start
    ctx.lineWidth = 2 / scale
    traceHex(ctx, visible.startHex)
    ctx.stroke()
  }

  // ⑤ 算子令牌（**按格只画一枚**：算子已按六角格内接正方形定尺，横向摊开会越过格边压到相邻格；
  //    同格多枚时在角上标出枚数，点该格即在小窗里展开逐枚查看/选取）
  const byHex = new Map<string, UnitToken[]>()
  for (const token of visible.tokens) {
    const key = `${token.hex.col}.${token.hex.row}`
    const list = byHex.get(key)
    if (list === undefined) byHex.set(key, [token])
    else list.push(token)
  }

  /*
   * ⑤ 算子层：一格只画一枚；**该格处于"就地展开"状态时**改成逐枚摊开（B2，用户 2026-09-16 #1）
   *
   * 展开态：按 `stackFanLayout` 的槽位画本页的每一枚（>4 枚时分页，右下角标翻页）；
   * 非展开：只画顶牌 + 枚数角标（原行为）。
   * 画出的每一枚都收进 `drawn`，供状态贴图层按"本单位图之上"逐枚贴（用户 2026-09-16 #2）。
   */
  const expanded = visible.expandedStack ?? null
  const expandedKey = expanded === null ? null : hexKeyOf(expanded.hex)
  const drawn: TokenDrawView[] = []

  for (const [key, group] of byHex) {
    const top = topTokenOf(group)
    if (expandedKey !== null && key === expandedKey) {
      const layout = stackFanLayout({
        hex: top.hex,
        total: group.length,
        page: expanded!.page,
        columns: combatNoncombatColumns(group),
      })
      for (const slot of layout.slots) {
        const token = group[slot.index]
        if (token === undefined) continue
        const centerX = slot.x + slot.size / 2
        const centerY = slot.y + slot.size / 2
        drawToken(ctx, token, centerX, centerY, scale, slot.size)
        drawn.push({ token, centerX, centerY, size: slot.size })
      }
      if (layout.pageBadge !== null) {
        drawStackPageBadge(ctx, layout.page, layout.pageCount, layout.pageBadge, scale)
      }
      continue
    }
    const center = hexCanvasPoint(top.hex)
    drawToken(ctx, top, center.x, center.y, scale)
    drawn.push({ token: top, centerX: center.x, centerY: center.y, size: TOKEN_SIZE_PX })
    if (group.length > 1) drawStackBadge(ctx, group.length, center, scale)
  }

  /*
   * B31b（用户口径 2026-09-16 #7）：**设施类算子单独一层**
   *
   * 「非战斗单位可以和战斗单位不同层，但是要注意**机场是容纳飞机的**，点击机场后展开里面飞机」。
   * 顶牌策略只为堆叠里"最该看的那一枚"服务，而设施是**格的属性**（这格有机场 / 有 SP / 有工事），
   * 被顶掉就等于"没画出来"。故在算子层之后按格补画被顶掉的设施：0.6 尺寸、挪到格内下侧，
   * 与顶牌不重叠；摊开态下扇面已经把所有令牌摊开了，跳过以免重复。
   */
  for (const [key, group] of byHex) {
    if (expandedKey !== null && key === expandedKey) continue
    const top = topTokenOf(group)
    const facilities = group.filter((token) => isFacilityToken(token) && token !== top)
    if (facilities.length === 0) continue
    const base = hexCanvasPoint(top.hex)
    facilities.slice(0, 3).forEach((token, index) => {
      const size = TOKEN_SIZE_PX * FACILITY_TOKEN_RATIO
      const step = size + 2 / scale
      const x = base.x - (size + step * (facilities.length - 1)) / 2 + index * step
      const y = base.y + TOKEN_SIZE_PX * 0.34
      drawToken(ctx, token, x, y, scale, size)
    })
  }

  drawTokenStatusTextures(ctx, drawn)

  // ⑥ 补给覆盖层（C8：拖取/投递的可视化）——画在算子之上，路径与来源格最清楚
  if (visible.supply !== undefined && visible.supply !== null) {
    drawSupplyOverlay(ctx, visible.supply, scale)
  }

  // ⑥-b 可消耗的补给站（W7 C16：发起战斗/轰炸时的「选哪个补给站付款」；15.1 整备付款同画法）
  const payHints = [...(visible.payDumps ?? []), ...(visible.refitPay ?? [])]
  if (payHints.length > 0) {
    ctx.lineWidth = 2 / scale
    for (const hint of payHints) {
      const center = hexCanvasPoint(hint.hex)
      const half = TOKEN_SIZE_PX * 0.42
      ctx.fillStyle = hint.selected ? OVERLAY_PALETTE.payDumpSelected : OVERLAY_PALETTE.payDump
      ctx.fillRect(center.x - half, center.y - half, half * 2, half * 2)
      ctx.strokeStyle = OVERLAY_PALETTE.payDumpEdge
      ctx.strokeRect(center.x - half, center.y - half, half * 2, half * 2)
      if (hint.label !== '') {
        ctx.fillStyle = OVERLAY_PALETTE.badge
        ctx.font = `${(10 / scale).toFixed(1)}px ui-monospace, monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(hint.label, center.x, center.y + half + 8 / scale)
      }
    }
  }

  // ⑦ 巡逻区覆盖层（C9：14.4c）——只描边不填充，避免盖住地图
  if (visible.patrolZone !== undefined && visible.patrolZone !== null) {
    drawPatrolZoneOverlay(ctx, visible.patrolZone, scale)
  }

  // ⑦-b 4.5 控制区（ZOC）：用**极轻填充 + 细描边**，算子（上方已画）依旧一眼可读；
  //     敌方 ZOC 用虚线以示警示。
  if (visible.zoc !== undefined && visible.zoc !== null) {
    ctx.lineWidth = 1.5 / scale
    for (const [hexes, fill, edge, dash] of [
      [visible.zoc.friendly, OVERLAY_PALETTE.zocFriendly, OVERLAY_PALETTE.zocFriendlyEdge, []],
      [visible.zoc.enemy, OVERLAY_PALETTE.zocEnemy, OVERLAY_PALETTE.zocEnemyEdge, [5, 3]],
    ] as const) {
      ctx.setLineDash(dash.map((value) => value / scale))
      for (const hex of hexes) {
        traceHex(ctx, hex)
        ctx.fillStyle = fill
        ctx.fill()
        ctx.strokeStyle = edge
        ctx.stroke()
      }
      ctx.setLineDash([])
    }
  }
}

/** 绘制巡逻区覆盖层（C9：14.4c 的 10 格防御区域） */
function drawPatrolZoneOverlay(
  ctx: CanvasRenderingContext2D,
  zone: PatrolZoneOverlay,
  scale: number,
): void {
  ctx.lineWidth = 1.5 / scale
  ctx.setLineDash([5 / scale, 4 / scale])
  for (const [hexes, color] of [
    [zone.friendly, OVERLAY_PALETTE.patrolZoneFriendly],
    [zone.enemy, OVERLAY_PALETTE.patrolZoneEnemy],
  ] as const) {
    ctx.strokeStyle = color
    for (const hex of hexes) {
      traceHex(ctx, hex)
      ctx.stroke()
    }
  }
  ctx.setLineDash([])
}

/** 绘制补给覆盖层（C8：12.3a 拖取范围 / 12.3b 投递范围 + 最省路径） */
function drawSupplyOverlay(
  ctx: CanvasRenderingContext2D,
  supply: SupplyOverlay,
  scale: number,
): void {
  // 覆盖范围：淡填充 + 描边 + 圈内补给消耗（与移动范围同一画法，颜色区分）
  if (supply.coverage.length > 0) {
    const fontPx = 10 / scale
    ctx.font = `${fontPx.toFixed(1)}px ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 1.5 / scale
    for (const hint of supply.coverage) {
      traceHex(ctx, hint.hex)
      ctx.fillStyle = OVERLAY_PALETTE.supplyCoverage
      ctx.fill()
      ctx.strokeStyle = OVERLAY_PALETTE.supplyCoverageEdge
      ctx.stroke()

      const center = hexCanvasPoint(hint.hex)
      ctx.fillStyle = OVERLAY_PALETTE.supplyMpText
      ctx.fillText(formatMp(hint.mp), center.x, center.y + REACHABLE_RADIUS_PX * 1.6)
    }
  }

  // 最省路径：实线 + 折点（与移动预览的虚线区分）
  if (supply.path.length >= 2) {
    ctx.strokeStyle = OVERLAY_PALETTE.supplyPath
    ctx.lineWidth = 3 / scale
    ctx.beginPath()
    supply.path.forEach((hex, index) => {
      const point = hexCanvasPoint(hex)
      if (index === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    })
    ctx.stroke()
    for (const hex of supply.path) {
      const point = hexCanvasPoint(hex)
      ctx.fillStyle = OVERLAY_PALETTE.supplyPath
      ctx.beginPath()
      ctx.arc(point.x, point.y, 3 / scale, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // 来源格（实心方框角标）与受补给格（外框）
  if (supply.sourceHex !== null) {
    const center = hexCanvasPoint(supply.sourceHex)
    const half = TOKEN_SIZE_PX * 0.3
    ctx.fillStyle = OVERLAY_PALETTE.supplySource
    ctx.fillRect(center.x - half, center.y - half, half * 2, half * 2)
  }
  if (supply.targetHex !== null) {
    ctx.strokeStyle = OVERLAY_PALETTE.supplyTarget
    ctx.lineWidth = 2.5 / scale
    traceHex(ctx, supply.targetHex)
    ctx.stroke()
  }
}

/** MP 文本：整数不带小数点，半格消耗保留一位小数（6.1h 不取整） */
function formatMp(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * 取该令牌**该朝向那一面**的算子图；未就绪 / 无图 ⇒ null（调用方回退矢量画法）
 *
 * 5.4a：一切数值以朝向那一面为基准——图同理（正面/背面是两枚不同的印刷面）。
 */
function counterImageOf(token: UnitToken): CanvasImageSource | null {
  const url = tokenImageUrl(token)
  return url === null ? null : counterImages.get(url)
}

/**
 * 已经**画出的**一枚算子（令牌层产出，状态贴图层消费）
 *
 * 就地展开时同一格会画出多枚、且边长更小 ⇒ 状态贴图必须按「这一枚自己的中心与边长」贴，
 * 故这里带上 centerX/centerY/size，而不是只给 token。
 */
interface TokenDrawView {
  token: UnitToken
  centerX: number
  centerY: number
  size: number
}

/** 画一张贴图（居中、按边长比例）；未就绪则跳过（不占位、不报错） */
function drawMarkerTexture(
  ctx: CanvasRenderingContext2D,
  url: string,
  centerX: number,
  centerY: number,
  size: number,
): boolean {
  const image = counterImages.get(url)
  if (image === null) return false
  const side = size * MARKER_TEXTURE_RATIO
  ctx.drawImage(image, centerX - side / 2, centerY - side / 2, side, side)
  return true
}

/**
 * 模式/状态贴图（5.8 战略 / 5.9 进击 / 12.8 断补）
 *
 * 贴图**叠在该算子自己的图之上**（真实桌面玩法就是把标记压在算子上的）：进击与断补语义上不并存，
 * 但战略与断补可以同时出现，故三者各画各、不互相 `else`。图未就绪时跳过（不占位、不报错）。
 *
 * ★ 用户 2026-09-16 #2：「给单位标状态的贴图要显示在**该单位图片上层**」⇒ 本函数不再由 `drawToken`
 *   内部调用，改由 `drawTokenStatusTextures` 在**算子层画完之后**统一跑一遍（见 `MAP_LAYER_ORDER`
 *   的 `statusTextures` 层）。这样就地展开的多枚算子也各自贴自己的状态，且层次顺序固定可断言。
 */
function drawModeTextures(
  ctx: CanvasRenderingContext2D,
  token: UnitToken,
  centerX: number,
  centerY: number,
  size: number,
): void {
  if (token.exploit === true) {
    drawMarkerTexture(ctx, exploitTextureUrl(token.id), centerX, centerY, size)
  }
  if (token.strat === true) {
    drawMarkerTexture(ctx, markerTextureUrl(MARKER_TEXTURES.strat), centerX, centerY, size)
  }
  if (token.outOfSupply === true) {
    drawMarkerTexture(ctx, markerTextureUrl(MARKER_TEXTURES.outOfSupply), centerX, centerY, size)
  }
}

/**
 * **状态贴图层**（进击 / 战略 / 断补）—— 在算子层之后调用一次
 *
 * 传入「实际画出的那些算子」（同格只画顶牌 ⇒ 传顶牌集合，与算子层一致），逐枚把状态贴图
 * 压在该算子图之上。层次顺序见 `MAP_LAYER_ORDER`（用户 2026-09-16 #2）。
 */
export function drawTokenStatusTextures(
  ctx: CanvasRenderingContext2D,
  views: readonly TokenDrawView[],
): void {
  for (const view of views) {
    drawModeTextures(ctx, view.token, view.centerX, view.centerY, view.size)
  }
}

/**
 * 同格多枚时画哪一枚（4.8 堆叠：一格只画最上面那一枚）
 *
 * 取序（可预期优先）：**正在操作的那一枚** > **飞机**（它停在空军基地上，最该看见）> 最后一枚。
 * 其余枚数不丢信息：角上标出总数，点该格即在小窗里展开逐枚查看（4.9a 的可见内容）。
 */
/**
 * B31b：**设施类算子**（不参与"一格一枚"的顶牌竞争，单独一层画）
 *
 * 判据只看"是不是设施/计数算子"：机场（14.1a）、SP（12.1b）、工事（16.0）。
 * 这三类被别的算子顶掉时，玩家会以为"这张图没画出来"（用户 #20 的苏联机场）。
 */
export function isFacilityToken(token: UnitToken): boolean {
  const kind = token.noncombatKind ?? null
  return kind === 'air_base' || kind === 'sp' || kind === 'hedgehog'
}

/** 设施层的小图比例（相对算子格 44px） */
export const FACILITY_TOKEN_RATIO = 0.6

export function topTokenOf(group: readonly UnitToken[]): UnitToken {
  const first = group[0]
  if (first === undefined) throw new Error('topTokenOf：堆叠不能为空')
  if (group.length === 1) return first
  return (
    group.find((token) => token.selected) ??
    group.find((token) => token.air === true) ??
    group[group.length - 1]!
  )
}

/**
 * 展开态的分页角标（B2：>4 枚时的「第几页/共几页」）
 *
 * 画在格右下角内沿（与 2×2 的枚区错开），点它翻页（命中判定在 `stack-fan.hitStackFan`）。
 * 文案只写 `页/总页`，不再加别的字（用户口径：算子上信息已够，不要多余文字）。
 */
function drawStackPageBadge(
  ctx: CanvasRenderingContext2D,
  page: number,
  pageCount: number,
  badge: { x: number; y: number; radius: number },
  scale: number,
): void {
  ctx.fillStyle = OVERLAY_PALETTE.badge
  ctx.beginPath()
  ctx.arc(badge.x, badge.y, badge.radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = `${(10 / scale).toFixed(1)}px ui-monospace, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${page + 1}/${pageCount}`, badge.x, badge.y)
}

/** 同格枚数角标（画在算子右上角外沿，不遮印值） */
function drawStackBadge(
  ctx: CanvasRenderingContext2D,
  count: number,
  center: { x: number; y: number },
  scale: number,
): void {
  const radius = 9 / scale
  const x = center.x + TOKEN_SIZE_PX / 2 - radius * 0.6
  const y = center.y - TOKEN_SIZE_PX / 2 + radius * 0.6
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fillStyle = OVERLAY_PALETTE.stackBadge
  ctx.fill()
  ctx.lineWidth = 1.5 / scale
  ctx.strokeStyle = OVERLAY_PALETTE.stackBadgeEdge
  ctx.stroke()
  ctx.fillStyle = OVERLAY_PALETTE.stackBadgeText
  ctx.font = `bold ${(10 / scale).toFixed(1)}px ui-monospace, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(count), x, y)
}

/** 格的键（`col.row`）——与 `overlayHexKey` 同式，文件内复用 */
function hexKeyOf(hex: HexRef): string {
  return `${hex.col}.${hex.row}`
}

/** 画一个算子令牌 */
function drawToken(
  ctx: CanvasRenderingContext2D,
  token: UnitToken,
  centerX: number,
  centerY: number,
  scale: number,
  size: number = TOKEN_SIZE_PX,
): void {
  const half = size / 2
  const left = centerX - half
  const top = centerY - half

  // ① 底：优先贴**真实算子图**（按朝向那一面）；无图/未就绪则回退原来的色块画法
  //   飞机与地面算子同画法（正方形）——只要它停在空军基地格，图本身就是飞机算子
  const image = counterImageOf(token)
  if (image !== null) {
    ctx.drawImage(image, left, top, size, size)
  } else {
    ctx.fillStyle = token.side === 'axis' ? OVERLAY_PALETTE.axis : OVERLAY_PALETTE.soviet
    ctx.fillRect(left, top, size, size)
  }
  // 本轮移动已结束（4.5a-A / 6.1c / 6.2b / 掉队）→ 压一层半透明灰，一眼可辨
  if (token.ended) {
    ctx.fillStyle = OVERLAY_PALETTE.ended
    ctx.fillRect(left, top, size, size)
  }

  // B9：本环节不参与 ⇒ 再压一层更浅的灰，且描边换中性灰（与"已动过"的深灰区分开）
  if (token.disabled === true) {
    ctx.fillStyle = OVERLAY_PALETTE.disabled
    ctx.fillRect(left, top, size, size)
  }

  ctx.lineWidth = 2 / scale
  ctx.strokeStyle =
    token.disabled === true
      ? OVERLAY_PALETTE.disabledEdge
      : token.side === 'axis'
        ? OVERLAY_PALETTE.axisEdge
        : OVERLAY_PALETTE.sovietEdge
  ctx.strokeRect(left, top, size, size)

  // 选中环
  if (token.selected) {
    ctx.strokeStyle = OVERLAY_PALETTE.select
    ctx.lineWidth = 3 / scale
    ctx.strokeRect(left - 2 / scale, top - 2 / scale, size + 4 / scale, size + 4 / scale)
  }

  // W7 C13（4.9a）：敌方格顶牌的提示环 —— 虚线表示「其下还有不可见单位」，**不显示枚数**
  if (token.hiddenStack === true) {
    ctx.save()
    ctx.setLineDash([4 / scale, 3 / scale])
    ctx.strokeStyle = OVERLAY_PALETTE.hiddenStackEdge
    ctx.lineWidth = 2 / scale
    ctx.strokeRect(left - 3 / scale, top - 3 / scale, size + 6 / scale, size + 6 / scale)
    ctx.restore()
  }

  // ② 印值：**只有回退画法**才需要印（真算子图上本来就有）
  if (image === null) {
    ctx.fillStyle = OVERLAY_PALETTE.tokenText
    ctx.font = `bold ${(11 / scale).toFixed(1)}px ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(token.label, centerX, centerY)
  }

  // ③ 模式字母（右上角）
  ctx.fillStyle = OVERLAY_PALETTE.badge
  ctx.font = `${(9 / scale).toFixed(1)}px ui-monospace, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(token.modeLetter, left + size - 5 / scale, top + 5 / scale)

  /*
   * 状态角标（左上角）：
   *   3.6e 的 `(-N)` **优先**——它是"这一枚已经掉到几成"的长期事实，比 DG 这种瞬时状态更该占位；
   *   DG 同时成立时顺延到下一行（两者不互斥，都不能丢）。
   */
  const stepsLost = token.stepsLost ?? 0
  if (stepsLost > 0) {
    ctx.fillStyle = OVERLAY_PALETTE.lossBadge
    ctx.fillText(`(-${stepsLost})`, left + 13 / scale, top + 5 / scale)
    if (token.dg) {
      ctx.fillStyle = OVERLAY_PALETTE.zocEdge
      ctx.fillText('DG', left + 7 / scale, top + 17 / scale)
    }
  } else if (token.dg) {
    ctx.fillStyle = OVERLAY_PALETTE.zocEdge
    ctx.fillText('DG', left + 7 / scale, top + 5 / scale)
  } else if (token.awaitingFuel) {
    ctx.fillStyle = OVERLAY_PALETTE.fuel
    ctx.fillText('F', left + 5 / scale, top + 5 / scale)
  } else if (token.fuelled) {
    ctx.fillStyle = OVERLAY_PALETTE.fuel
    ctx.fillText('f', left + 5 / scale, top + 5 / scale)
  }

  // ④ 模式/状态贴图已上移为独立层（见 drawTokenStatusTextures 与 MAP_LAYER_ORDER）
}

/** 六角格外接圆半径（供上层布局参考） */
export const OVERLAY_HEX_RADIUS_PX = HEX_RADIUS_PX
