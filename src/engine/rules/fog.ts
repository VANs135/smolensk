import type { HexRef, Side } from '@/data'

import type { AirStatus } from '../state-types'

/**
 * 切方与信息展示纪律（W7 C13）
 *
 * ## 条文出处（通规 4.8b / 4.9；专规 1.4）
 *   - **4.9a**：「玩家**永远不能检查敌方堆叠**。然而，敌方玩家随时可以选择查看任何格内的**环形工事**、
 *     **堆叠最上方战斗模式的可攻击单位**（**若堆叠内单位均无 ZOC，则改为查看最上方的战斗单位**）
 *     以及**最上方的激活飞机**。虽然敌方玩家会得知最上方单位是否处于**战略模式、DG，或是否断补**，
 *     但**无权获取部队储备或损失军力**的情况。」
 *   - **4.9b**：「在战斗中（含突袭），双方都必须展示各自的**行动值、反坦克效果（9.4e）和战斗值总值**。
 *     双方**并不需要展示实际的单位**（4.9a 规定除外）。」
 *   - **4.9c**：轰炸中展示轰炸值总值与适用的横移 / 防空点数（轰炸本身由 C7 面板承担）。
 *   - **4.9d**：空战中展示在场飞机与每轮参战飞机（由 C9 面板承担）。
 *   - **4.9e**：「玩家通常**公开掷骰**；**如果玩家们同意**，可以对某些掷骰**秘密进行**以增加战雾。」
 *   - **4.8b 堆叠顺序**：C) 有 ZOC 的单位应是堆叠最上方的战斗单位；
 *     D) **在没有敌方地面单位相邻时，指挥部可以是该格最上方的战斗单位**（方便己方看后勤网），
 *     并且**必须告知敌方该格是否产生 ZOC**；E) 激活飞机应放在所有地面单位**上方**；
 *     F) 格内有环形工事时，工事应是堆叠最上方的地面单位。
 *   - **专规 1.4**：地图外盒「**双方同意可隐藏**以增加 fog of war」。
 *
 * ## 本模块的边界（不臆造）
 *   1. **堆叠顺序由所有者决定**（4.8b 开头：「玩家可在合理范围内自行安排堆叠顺序」）⇒
 *      本模块把「调用方给出的单位数组顺序」当作**所有者的实际摆放顺序**，只做**合规检查**
 *      （`stackOrderIssues`）与**对手可见性裁剪**（`visibleUnitIds`），**不替玩家重排**；
 *   2. 4.9b 的「参战」只要求公开**数值**（AR / 反坦克效果 / 总战斗值）⇒ 本模块的 `reveal` 只给数值，
 *      仍然**不展示对手的算子明细**（`countersRevealed: false`），与原文一致；
 *   3. 敌方堆叠的**枚数**同样属于「看穿堆叠」⇒ `stackSizeHidden: true`，界面不得显示「＋N」之类的计数。
 *
 * ## 不含规则数字
 *   本模块无任何数值常量（可见性判据全部是布尔逻辑），故不读 `rules-constants.json`。
 */

/** 4.9a：不得看穿敌方堆叠 */
export const FOG_RULE = '4.9a'
/** 4.8b：堆叠顺序（最上方单位的法定要求） */
export const STACK_ORDER_RULE = '4.8b'
/** 4.9b：战斗中的公开信息（数值） */
export const COMBAT_REVEAL_RULE = '4.9b'
/** 4.9e：掷骰默认公开，经同意可秘密 */
export const SECRET_ROLL_RULE = '4.9e'

/** 另一方（切方用） */
export function otherSide(side: Side): Side {
  return side === 'axis' ? 'soviet' : 'axis'
}

/** 方的中文名（日志与界面共用） */
export function sideLabel(side: Side): string {
  return side === 'axis' ? '轴心国' : '苏联'
}

/** 堆叠内一枚（信息展示所需的最小视图；全部字段由调用方从盘面给出） */
export interface FogUnitView {
  id: string
  side: Side
  /** 显示名（仅在己方可见时展示） */
  name?: string
  /** 单位类别（4.8b E：激活飞机在最上方） */
  kind: 'ground' | 'air'
  /** 3.2a：是否战斗单位（有战斗值）——HQ 属战斗单位 */
  isCombat: boolean
  /** 3.1：是否可攻击（有攻击值） */
  attackCapable: boolean
  /** 4.5：是否处于**战斗模式**（由 modes.exertsZoc 裁定后传入，本模块不自行推导） */
  inCombatMode: boolean
  /** 4.5：是否投射 ZOC（可攻击 ∧ 战斗模式 ∧ 非断补） */
  projectsZoc: boolean
  /** 14.1a：空军激活状态（4.8b E / 4.9a 的「最上方激活飞机」） */
  airStatus?: AirStatus | null
  /**
   * B31b：该枚是否**中立设施/计数算子**（机场 / SP / 工事）
   *
   * 战雾对它们放行：它们不是"部队"，枚数口径与堆叠无关；而"这一格有机场/有补给/有工事"
   * 是**盘面事实**（开局就印在地图上，或双方都看得见），藏起来只会让对手把机场当成空地。
   */
  isFacility?: boolean
  /** 4.8b F：该枚是否为环形工事（工事以「地面单位」的身份参与堆叠顺序） */
  isHedgehog?: boolean
  /** 5.x：主动模式（4.9a：须告知对手最上方单位是否**战略模式**） */
  mode?: 'combat' | 'move' | 'strat' | 'reserve'
  /** 5.10：混乱（4.9a：须告知对手） */
  dg?: boolean
  /** 12.8：断补（4.9a：须告知对手） */
  outOfSupply?: boolean
  /** 13.5b：当前军力与印值（4.9a：对手**无权**知道损失军力） */
  steps?: number
  printedSteps?: number
  /** 12.10：部队储备（4.9a：对手**无权**知道） */
  internalStocks?: 'low' | 'exhausted' | null
}

/** 该格的盘面事实（由调用方注入；本模块不持地图） */
export interface StackFacts {
  /**
   * 4.8b(D)：该格**相邻格**是否有**敌方地面单位**（不限模式与补给）
   *
   * 注意与 ZOC 不同：4.8b(D) 看的是「敌方地面单位相邻」，不是「处于敌方 ZOC」。
   */
  enemyGroundUnitAdjacent: boolean
}

/** 堆叠顺序的违规项（4.8b C/D/E/F；供界面对所有者提示） */
export interface StackOrderIssue {
  rule: string
  /** 涉及的算子（缺省表示与该格整体相关） */
  unitId?: string
  detail: string
}

/**
 * 4.9a：对手可见的「最上方战斗单位」
 *
 * 判据照原文：「最上方**战斗模式的可攻击单位**；**若堆叠内单位均无 ZOC，则改为查看最上方的战斗单位**」。
 * 堆叠顺序取调用方给的数组顺序（＝所有者的摆放顺序）。
 */
export function topCombatUnitOf(units: readonly FogUnitView[]): FogUnitView | null {
  const ground = units.filter((unit) => unit.kind === 'ground' && unit.isHedgehog !== true)
  if (ground.length === 0) return null
  const anyZoc = ground.some((unit) => unit.projectsZoc)
  if (anyZoc) {
    const candidate = ground.find((unit) => unit.inCombatMode && unit.attackCapable)
    if (candidate !== undefined) return candidate
    // 有 ZOC 单位但没有任何「战斗模式的可攻击单位」⇒ 退回最上方战斗单位（4.9a 括号内规则）
  }
  return ground.find((unit) => unit.isCombat) ?? null
}

/** 4.9a：最上方的激活飞机（与地面单位分开计算 —— 4.8b E 要求激活飞机置于所有地面单位之上） */
export function topActivePlaneOf(units: readonly FogUnitView[]): FogUnitView | null {
  return units.find((unit) => unit.kind === 'air' && unit.airStatus === 'active') ?? null
}

/** 4.8b C/D/E/F：堆叠顺序的合规检查（只报事实，不替玩家重排） */
export function stackOrderIssues(
  units: readonly FogUnitView[],
  facts: StackFacts,
): readonly StackOrderIssue[] {
  const issues: StackOrderIssue[] = []
  const ground = units.filter((unit) => unit.kind === 'ground')
  const topGround = ground[0]
  if (topGround === undefined) return issues

  // 4.8b E：激活飞机应在所有地面单位**上方** ⇒ 地面单位之下若有激活飞机即为违规
  const lastGroundIndex = units.map((unit) => unit.kind).lastIndexOf('ground')
  const planeBelowGround = units
    .slice(lastGroundIndex + 1)
    .some((unit) => unit.kind === 'air' && unit.airStatus === 'active')
  if (planeBelowGround) {
    issues.push({
      rule: STACK_ORDER_RULE,
      detail: '激活飞机应放在所有地面单位**上方**（4.8b E）',
    })
  }

  const zocSources = ground.filter((unit) => unit.projectsZoc)
  if (zocSources.length > 0 && !topGround.projectsZoc) {
    // 4.8b C：有 ZOC 的单位应是堆叠最上方的战斗单位（以便 ZOC 被清楚看到）
    issues.push({
      rule: STACK_ORDER_RULE,
      unitId: zocSources[0]?.id,
      detail: `有 ZOC 的单位（${zocSources.map((unit) => unit.id).join('、')}）应在堆叠最上方（4.8b C）`,
    })
  }
  // 4.8b D：无敌方地面单位相邻时，指挥部**可以**置顶；反之不得置顶
  if (zocSources.length === 0 && isHqLike(topGround) && facts.enemyGroundUnitAdjacent) {
    issues.push({
      rule: STACK_ORDER_RULE,
      unitId: topGround.id,
      detail: '相邻格有敌方地面单位时，指挥部不得作为该格堆叠最上方的战斗单位（4.8b D）',
    })
  }

  // 4.8b F：格内有环形工事时，工事应是堆叠最上方的地面单位
  const hedgehog = ground.findIndex((unit) => unit.isHedgehog === true)
  if (hedgehog > 0) {
    issues.push({
      rule: STACK_ORDER_RULE,
      unitId: ground[hedgehog]?.id,
      detail: '环形工事应是堆叠最上方的地面单位（4.8b F）',
    })
  }
  return issues
}

/**
 * 该枚是否「像指挥部」——
 *
 * 引擎侧只用调用方给的显示名判断（单位库的兵种标签在 `UnitRecordView` 里，本模块拿不到，
 * 也不该猜）。判据宽松：名字含 `HQ` / `指挥部` / `Army` / `Front` 即视为 HQ 类，
 * 用于 4.8b(D) 的「HQ 可以置顶」提醒；**判错只影响一条提示**，不影响任何可见性裁剪。
 */
function isHqLike(unit: FogUnitView): boolean {
  const name = unit.name ?? ''
  return /HQ|指挥部|Army|Front|Kessel/i.test(name)
}

/** 4.9b：战斗中须公开的**数值**（不展示对手算子明细） */
export interface CombatReveal {
  rule: string
  /** 行动值（9.6；双方各自公布的那一个） */
  actionRating: number
  /** 反坦克效果（9.4e） */
  atEffects: string
  /** 战斗值总值（9.4d） */
  totalStrength: number
  /** 4.9b：**无需**展示实际单位（4.9a 规定除外） */
  countersRevealed: false
  detail: string
}

/** 某格对某方的展示结论（判别联合：`mode` 收窄） */
export type HexDisplay =
  | {
      /** 己方堆叠：全部明细可见（4.9a 只约束敌方堆叠） */
      mode: 'full'
      rule: string
      hex: HexRef
      units: readonly FogUnitView[]
      hedgehog: boolean
    }
  | {
      /** 敌方堆叠：只见最上方单位 + 工事 + 状态旗标（4.9a） */
      mode: 'topOnly'
      rule: string
      hex: HexRef
      /** 最上方战斗单位（无战斗单位即 null） */
      top: FogUnitView | null
      /** 最上方激活飞机 */
      topActivePlane: FogUnitView | null
      hedgehog: boolean
      /** 4.8b：必须告知对手该格是否产生 ZOC */
      hasZoc: boolean
      /** 4.9a：可告知的状态（战略模式 / DG / 断补） */
      topFlags: { strat: boolean; dg: boolean; outOfSupply: boolean }
      /** 4.9a：对手**无权**知道的项目（界面照此隐藏） */
      denied: readonly string[]
      /** 4.9a：枚数同样不可见（不得显示「＋N」） */
      stackSizeHidden: true
      /** 4.9b：若该格正在结算战斗，附上须公开的数值 */
      reveal: CombatReveal | null
    }

/** 4.9a：对手无权知道的项目（固定清单，界面据此隐藏字段） */
export const HIDDEN_FROM_OPPONENT = [
  '堆叠内其余算子（永远不能检查敌方堆叠）',
  '部队储备（internal stocks）',
  '已损失的军力（steps lost）',
  '堆叠枚数',
] as const

/**
 * 某格对 `viewer` 的展示结论
 *
 * @param input.reveal 该格正在结算战斗时，由战斗机制给出的公开数值（4.9b）；缺省 null
 */
export function hexDisplay(input: {
  /**
   * 观察方；`null` ＝ **单人局（solo）没有对手可隐瞒** ⇒ 不裁剪（全可见）
   *
   * 4.9a 那条「不得看穿**敌方**堆叠」与专规 1.4 的"外盒隐藏"都是**对手之间**的约定；
   * 桌边只有一个玩家时，把它们套上去只会让玩家看不清自己的棋盘。
   */
  viewer: Side | null
  hex: HexRef
  units: readonly FogUnitView[]
  facts: StackFacts
  reveal?: CombatReveal | null
}): HexDisplay {
  const hedgehog = input.units.some((unit) => unit.isHedgehog === true)
  if (input.viewer === null) {
    return { mode: 'full', rule: FOG_RULE, hex: input.hex, units: input.units, hedgehog }
  }
  const enemy = input.units.filter((unit) => unit.side !== input.viewer)

  // 己方堆叠（含中立算子：本作 SP / 基地 / 工事标 both，视为双方可见的通用算子）
  if (enemy.length === 0) {
    return { mode: 'full', rule: FOG_RULE, hex: input.hex, units: input.units, hedgehog }
  }
  // 混堆（4.8b：敌对单位不得同格；此处如实按「有敌即有敌」处理）
  const top = topCombatUnitOf(enemy)
  return {
    mode: 'topOnly',
    rule: FOG_RULE,
    hex: input.hex,
    top,
    topActivePlane: topActivePlaneOf(enemy),
    hedgehog,
    hasZoc: enemy.some((unit) => unit.projectsZoc),
    topFlags: {
      strat: top?.mode === 'strat',
      dg: top?.dg === true,
      outOfSupply: top?.outOfSupply === true,
    },
    denied: [...HIDDEN_FROM_OPPONENT],
    stackSizeHidden: true,
    reveal: input.reveal ?? null,
  }
}

/**
 * 渲染用：该格对 `viewer` **可见的算子 id**
 *
 * - 己方格：全部（含 both 的中立算子）；
 * - 敌方格：只有 4.9a 允许的两枚 —— 最上方战斗单位 + 最上方激活飞机；
 * - 敌方格的**枚数不透露** ⇒ 调用方只画这些，且**不得**画「＋N」角标。
 */

export function visibleUnitIds(input: {
  /** 观察方；`null` ＝ 单人局（无对手可隐瞒）⇒ 全部可见（与 `hexDisplay` 同一口径） */
  viewer: Side | null
  units: readonly FogUnitView[]
}): readonly string[] {
  if (input.viewer === null) return input.units.map((unit) => unit.id)
  const own = input.units.filter((unit) => unit.side === input.viewer)
  if (own.length === input.units.length) return input.units.map((unit) => unit.id)
  const enemy = input.units.filter((unit) => unit.side !== input.viewer)
  /*
   * ★ B31b：**中立设施也放行**（机场 / SP / 工事）。
   *   它们不是"部队"，枚数口径与堆叠无关；而"这一格有机场/有补给/有工事"是**盘面事实**
   *   （开局就印在地图上或双方都能看到），藏起来只会让对手把机场当成空地。
   */
  const facilities = enemy.filter((unit) => unit.isFacility === true)
  const ids = [
    topCombatUnitOf(enemy)?.id,
    topActivePlaneOf(enemy)?.id,
    ...facilities.map((unit) => unit.id),
  ].filter((id): id is string => id !== undefined)
  return [...new Set(ids)]
}

/* ────────────────────────────── 共识开关 → 信息纪律 ────────────────────────────── */

/** 一条共识结论（与 `session-flow.consensusDecisions` 同形） */
export interface ConsensusDecision {
  item: string
  adopted: boolean | null
}

/** 由共识开关推导的**信息纪律开关**（专规 1.4 / 通规 4.9e / 通规 2.4 / 专规 4.1–4.3） */
export interface HiddenInfoPolicy {
  rule: string
  /** 专规 1.4：地图外盒内容对对手隐藏 */
  hideOffMapBoxes: boolean
  /** 4.9e：某些掷骰秘密进行（日志与界面不显示骰面） */
  secretRolls: boolean
  /** 2.4：同步操作回合（双方同时行动；切屏提示应改为「双方同桌」） */
  simulcast: boolean
  /** 4.1a–4.3：已采纳的可选规则键（未采纳为空） */
  optionalRules: readonly string[]
  /** 逐条结论（供界面列出「生效的纪律」） */
  decisions: readonly ConsensusDecision[]
  detail: string
}

/** 共识条目 → 纪律开关的**文本判据**（条目原文来自 scenarios.agreedOptions.items） */
const OFF_MAP_ITEM = /地图外盒|1\.4/
const SECRET_ROLL_ITEM = /秘密掷骰|4\.9e/
const SIMULCAST_ITEM = /同步操作回合|2\.4/
const OPTIONAL_RULES_ITEM = /可选规则|房规|4\.1|4\.2|4\.3/

/**
 * 由共识结论推导信息纪律
 *
 * 「未作答（`adopted === null`）」与「不采纳」都**不启用**该纪律 —— 规则的默认态是
 * 公开掷骰（4.9e）、盒不隐藏（专规 1.4）；只有双方明确同意才加强战雾。
 *
 * @param optionalRuleKeys `scenarios.optionalRules` 的键（4.1a…4.3）；第 4 条共识条目被采纳时一并生效
 */
export function hiddenInfoPolicy(
  decisions: readonly ConsensusDecision[],
  optionalRuleKeys: readonly string[] = [],
): HiddenInfoPolicy {
  const adopted = (matcher: RegExp): boolean =>
    decisions.some((decision) => matcher.test(decision.item) && decision.adopted === true)
  const hideOffMapBoxes = adopted(OFF_MAP_ITEM)
  const secretRolls = adopted(SECRET_ROLL_ITEM)
  const simulcast = adopted(SIMULCAST_ITEM)
  const optionalRules = adopted(OPTIONAL_RULES_ITEM) ? [...optionalRuleKeys] : []

  const on: string[] = []
  if (hideOffMapBoxes) on.push('地图外盒对对手隐藏（专规 1.4）')
  if (secretRolls) on.push('掷骰秘密进行（4.9e）')
  if (simulcast) on.push('同步操作回合（2.4）')
  if (optionalRules.length > 0) on.push(`可选规则与房规：${optionalRules.join('、')}`)

  return {
    rule: '4.0',
    hideOffMapBoxes,
    secretRolls,
    simulcast,
    optionalRules,
    decisions: [...decisions],
    detail:
      on.length === 0
        ? '未启用任何加强战雾的纪律（公开掷骰、地图外盒可见：4.9e / 专规 1.4 的默认态）'
        : `已生效的信息纪律：${on.join('；')}`,
  }
}

/**
 * 4.9e：某次掷骰的骰面是否对 `viewer` 可见
 *
 * - 未启用秘密掷骰 ⇒ 一律可见（4.9e「玩家通常公开进行掷骰」）；
 * - 启用后 ⇒ 只有**掷骰方**可见（对手只看到「已掷骰」这一事实）。
 */
export function rollVisibleTo(input: {
  viewer: Side
  rollingSide: Side
  policy: HiddenInfoPolicy
}): boolean {
  if (!input.policy.secretRolls) return true
  return input.viewer === input.rollingSide
}
