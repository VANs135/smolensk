import { chartsTec } from '@/data'
import type { DeepReadonly, TecAttackMod, TecFeature, TecMpValue } from '@/data'

/**
 * 地形选取引擎（6.2d / 9.3b / 9.4b–9.4d）
 *
 * 本模块是「格内地形集合」的唯一消费者，数值全部取自 charts-tec.json（冻结）。
 * 三条规则在此分开实现，互不代用：
 *
 *   6.2d（移动）  格内多地形 → **引擎自动**取对该机动类型最贵的一种；
 *                 原文「The amount of symbol in the hex does not matter」＝判据是
 *                 **符号有无**，不是覆盖率高低（even a little nub makes it that terrain）；
 *                 例外一：忽略城市/村庄 nub（其 TEC 成本列为 ot，不产生独立数值，回查主地形）；
 *                 例外二：沿路行进时改用道路成本（6.2a road override）。
 *
 *   9.3b（战斗）  格内多地形符号 → **防御方手动选**一种生效；
 *                 同样「符号多少无关」，但城市/村庄的溢出（spillover）忽略；
 *                 格边地形（河/湖/路/铁）永不进入候选集。
 *
 *   9.4d（倍率）  原文带方括号的 [x#] 只作用于**攻击方**；防御方一律按 x1 读。
 *
 * 桥梁（★ 用户裁定 2026-09-12）：
 *   地图上的桥梁**不是独立符号**，它就是「联通河格边的路」。故不设桥梁字段，
 *   由两个既有事实推出：该格边是河/湖 **且** 该格边有路或铁路（见 isBridgeCrossing）。
 *   依据＝通规 6.2a In-Hex Links（路/铁穿过相邻两格必跨其共用格边）；铁路桥同样是桥——
 *   通规 12.x 供给示例原文即「Fortunately, there is that railroad bridge to use」。
 *
 *   桥的移动力语义（★ 用户裁定 2026-09-12）：
 *     **桥在移动中把河的移动力效果整个取消掉** → 有桥即**不可能是 P**，也没有跨河追加。
 *     理由＝过河的移动力消耗是加法模型：**过河消耗 + 目标格消耗**；
 *     桥把「过河消耗」这一项清掉，总量自然有限，谈不上禁入。
 *     **有桥格边过河「必经那条路」**——桥就是那条路，不存在「有桥却不沿路」的情形，
 *     故 bridge 本身即蕴含沿路，费用按所走道路计，不待调用方声明。
 *     故本模块返回 mp（目标格／沿路时的道路成本）与 hexsideDelta（过河消耗）两笔，
 *     并给出 totalMp = mp + hexsideDelta 以便调用方直接取用。
 *   过桥费＝**所走的那条路**的成本；一格边有多种路时默认取最省的（见 chooseRoute）。
 *
 *   通规 8.1c 的 overrun 例外：**只**保留「不得借道路把该格 MP 压低」这一条
 *   （overrun 时不给道路折扣，按目标格地形成本算），**不**把桥当作否定禁入地形的手段——
 *   因为按上面的加法模型，桥并非「否定 P」，而是那条格边的河效果本就不存在。
 *   另见 8.1a：MP 为 All 的格边不可 overrun。
 *
 * ★ 尚未接入：工程桥接（13.8b）与专规 3.5 桥面标记
 *   二者都是**运行时**机制（不入地图数据），且语义与印刷桥**不同**，不可混为一个 bool：
 *
 *   |          | 印刷桥（本模块已实现）      | 工程桥接（13.8b / 3.5 桥面） |
 *   | 大河     | 河效果取消 → 付所走道路费率 | **降为小河成本**（+3/+5/+1） |
 *   | 小河     | 河效果取消 → 付所走道路费率 | **无额外成本**（+0），目标格成本照付 |
 *   | overrun  | 可（8.1c 只是不给道路折扣） | **明文禁止借此跨河 overrun** |
 *   | 费用     | 印刷在地图上，无需支付      | 无 SP，但占用工程单位（当相位不得移动、一格一种作业） |
 *
 *   接入时需先定清三件事：桥接覆盖该格的哪几条格边、是否只惠及友军、
 *   3.5 桥面标记的覆盖范围。在此之前不进本模块。
 */

/** 机动类型（3.1a） */
export type MobilityType = 'track' | 'truck' | 'leg'
/** 攻击方部队类型（9.4b） */
export type AttackerType = 'armor' | 'mech' | 'other'
/** 读表角色（9.4d：括号倍率仅攻方） */
export type UnitRole = 'attacker' | 'defender'
/** 战斗线（TEC 第 2 列） */
export type CombatLine = 'Open' | 'Close' | 'Very Close' | 'Extr Close'
/** 地形所在位置：格内 / 格边 */
export type TerrainKind = 'hex' | 'hexside'

/** 可提供 6.2a 道路优先（road override）的格边地形 */
export const ROAD_FEATURES: readonly string[] = ['Secondary Road', 'Track', 'Railroad']

/** 跨河追加成本的格边地形 */
export const RIVER_FEATURES: readonly string[] = ['Minor River', 'Major River']

/** 城市/村庄类地形（9.3b 中受 spillover 例外约束的符号） */
export const CITY_TERRAINS: ReadonlySet<string> = new Set(['Village', 'Minor City', 'Major City'])

const FEATURES: ReadonlyMap<string, DeepReadonly<TecFeature>> = new Map(
  chartsTec.tec.features.map((feature) => [feature.feature, feature]),
)

/** TEC 行查询；未登记的地形名返回 null（调用方须按 unknownTerrain 处理，不得静默当 1 MP） */
export function tecFeature(name: string): DeepReadonly<TecFeature> | null {
  return FEATURES.get(name) ?? null
}

/** 全部 TEC 地形名（按原表顺序） */
export function tecFeatureNames(): string[] {
  return chartsTec.tec.features.map((feature) => feature.feature)
}

/** 格内 / 格边；未登记返回 null */
export function terrainKind(name: string): TerrainKind | null {
  return tecFeature(name)?.kind ?? null
}

/** 是否为格内地形（只有格内地形可进 9.3b 候选集） */
export function isHexTerrain(name: string): boolean {
  return terrainKind(name) === 'hex'
}

/** 是否为格边地形（河/湖/路/铁） */
export function isHexsideTerrain(name: string): boolean {
  return terrainKind(name) === 'hexside'
}

/** 战斗线；该行不产生独立战斗线（原文 ot）时返回 null，调用方须回查格内主地形 */
export function combatLineOf(name: string): CombatLine | null {
  const line = tecFeature(name)?.combatLine
  if (line === undefined || line === 'ot') return null
  return line
}

/** 该地形在某机动类型下的 MP 单元格 */
export function movementMpValue(
  name: string,
  mobility: MobilityType,
): DeepReadonly<TecMpValue> | null {
  return tecFeature(name)?.mp[mobility] ?? null
}

/** 该地形对某攻击方类型的倍率单元格（未解析 ot 与括号） */
export function attackMod(
  name: string,
  attackerType: AttackerType,
): DeepReadonly<TecAttackMod> | null {
  return tecFeature(name)?.attack[attackerType] ?? null
}

/**
 * 解析倍率单元格（9.4d）
 *
 * DeepReadonly 会把元组 [num, den] 降级为 readonly 数组，故此处做一次越界保护。
 * ot 行不产生倍率，返回 null 并由调用方回查格内主地形。
 */
function multiplierOf(
  mod: DeepReadonly<TecAttackMod> | null,
): { value: number; attackerOnly: boolean } | null {
  if (mod === null || mod.kind !== 'multiplier') return null
  const [num, den] = mod.mult
  if (num === undefined || den === undefined || den === 0) return null
  return { value: num / den, attackerOnly: mod.attackerOnly }
}

/**
 * 地形倍率解析（9.4d）
 *
 * 原文带方括号 [x#] 者只作用于攻击方：守方读作 x1。
 * ot 行不产生倍率，返回 1 并由调用方回查格内主地形。
 */
export function attackMultiplier(name: string, attackerType: AttackerType, role: UnitRole): number {
  const resolved = multiplierOf(attackMod(name, attackerType))
  if (resolved === null) return 1
  if (role === 'defender' && resolved.attackerOnly) return 1
  return resolved.value
}

/**
 * 图例 * 的判定（9.1f）
 *
 * 该地形为格子属性且在该机动类型下禁止通行时，该类机动必须**沿路**才能进入并攻击该格。
 * 这不是「减半」，而是**合法性门槛**：无路则进入/进攻不成立。
 */
export function requiresRoadToEnter(name: string, mobility: MobilityType): boolean {
  const feature = tecFeature(name)
  if (feature?.hexProperty !== true) return false
  return feature.mp[mobility].kind === 'prohibited'
}

/**
 * 6.2d 用：地形的「最贵度」排序权重
 *
 * 取三种机动成本的最大值（P 记为 Infinity）。该排序在 track/truck/leg 下一致
 * （Swamp ≻ Forest ≻ Woods ≻ Open），故可用于不区分机动类型的缓存标签；
 * 真正的 MP 必须按具体机动类型另行计算。
 */
export function movementTerrainRank(name: string): number {
  const feature = tecFeature(name)
  if (feature === null) return -1
  let worst = 0
  for (const mobility of chartsTec.tec.mobilityModes) {
    const cell = feature.mp[mobility]
    if (cell.kind === 'prohibited') return Number.POSITIVE_INFINITY
    if (cell.kind === 'fixed') worst = Math.max(worst, cell.value)
  }
  return worst
}

/**
 * 6.2d 用：格内成本最高的地形名（不区分机动类型的缓存标签）
 *
 * 仅供 map_hexes.json 的 movement_terrain 缓存字段与回归校验使用；
 * 引擎运行时一律走 selectMovementTerrain，因为它还要处理机动类型、道路优先与跨河追加。
 * 城市/村庄是 ot，不参与取 max（6.2d 例外：忽略其 nub）。
 */
export function selectTerrainLabel(terrainsPresent: readonly string[]): string | null {
  let best: string | null = null
  let bestRank = -1
  for (const name of terrainsPresent) {
    const feature = tecFeature(name)
    if (feature === null || feature.kind !== 'hex') continue
    if (feature.mp.track.kind === 'otherTerrain') continue
    const rank = movementTerrainRank(name)
    if (rank > bestRank) {
      bestRank = rank
      best = name
    }
  }
  return best
}

/** 进入一格（或跨越一格边）的移动判定输入 */
export interface MovementTerrainInput {
  /** 格内地形集合。契约：**只含格内地形**；混入格边地形会被忽略 */
  terrainsPresent: readonly string[]
  mobility: MobilityType
  /** 本步跨越的格边（河/湖 + 承载路铁）；不跨格边则省略 */
  crossing?: HexsideCrossing | null
  /** 6.2a：本步是否沿道路/铁路/小路移动。**有桥时无需声明**——桥就是那条路，过桥必经之 */
  followingRoad?: boolean
  /**
   * 本步实际所走的那条路（须出现在 crossing.routes 内）
   *
   * 过桥费按**所走的路**计；一格边有多种路（如大路＋小路）时，
   * 省略本参数即按最省的那条算（用户裁定 2026-09-12）。
   */
  viaRoute?: string | null
  /**
   * 通规 8.1c：用于 overrun 判定时置 true
   *
   * overrun 不得借道路把该格 MP 压低（8.1c）、MP 为 All 的格边不可 overrun（8.1a）。
   * 注意：**桥不在受限之列**——按「过河消耗 + 目标格消耗」的加法模型，
   * 桥是把「过河消耗」这一项清掉，河效果在该格边本就不存在，并非「借桥否定 P」。
   */
  forOverrun?: boolean
}

/**
 * 一步跨越的格边
 *
 * 对应 map_edges.json 的同一条格边记录：
 *   river   ← edge_terrain ∈ {river, lake} 时按 river_class 取 'Minor River' / 'Major River' / 'Lake/Blocked'
 *   routes  ← road_subclass（'Secondary Road' / 'Track'）与 rail_present（'Railroad'）
 */
export interface HexsideCrossing {
  /** 该格边的河/湖地形名；无则 null/省略 */
  river?: string | null
  /** 该格边承载的路/铁地形名（可多者并存） */
  routes?: readonly string[]
}

/**
 * 桥梁判定（★ 用户裁定 2026-09-12：地图上的桥梁**不是独立符号**，就是「联通河格边的路」）
 *
 * 因此不设桥梁字段，由两个已裁定事实推出：该格边是河/湖 **且** 该格边有路/铁。
 * 依据＝通规 6.2a In-Hex Links：路/铁穿过相邻两格必跨其共用格边，
 * 故「路画在这条格边上」即等于「路在此过河」，那处就是桥/渡口。
 */
export function isBridgeCrossing(crossing: HexsideCrossing | null | undefined): boolean {
  if (crossing == null) return false
  if ((crossing.river ?? null) === null) return false
  return (crossing.routes ?? []).length > 0
}

/**
 * 选出一条用于计费的路
 *
 * 用户裁定 2026-09-12：过桥消耗看**走的是什么路**；一格边有多种路时，
 * 默认用消耗少的那条。故：优先取调用方点名的 viaRoute，否则按 MP 升序取最省者
 * （Secondary Road 0.5 优于 Track/Railroad 1）。
 */
function chooseRoute(
  routes: readonly string[],
  mobility: MobilityType,
  viaRoute: string | null,
): string | null {
  const usable = routes.filter((name) => {
    const feature = tecFeature(name)
    return feature !== null && feature.kind === 'hexside' && ROAD_FEATURES.includes(name)
  })
  if (viaRoute !== null && usable.includes(viaRoute)) {
    const cell = tecFeature(viaRoute)!.mp[mobility]
    if (cell.kind === 'fixed') return viaRoute
  }
  let best: string | null = null
  let bestMp = Number.POSITIVE_INFINITY
  for (const name of usable) {
    const cell = tecFeature(name)!.mp[mobility]
    if (cell.kind !== 'fixed') continue
    if (cell.value < bestMp) {
      bestMp = cell.value
      best = name
    }
  }
  return best
}

/** 9.1f / 8.1c 的进入判定结果（`via` 区分「不借道路」与「只能沿路」） */
export type EnterForCombatVerdict =
  | { ok: true; via: 'normal' | 'roadOnly'; terrain: string; cost: number; detail: string }
  | { ok: false; reason: string; detail: string }

/**
 * 9.1f / 8.1c：能否「进入并攻击」该格——含「只能沿路进入」的区分
 *
 * 专规地形表的特殊声明（TEC 图例 `*`）与 9.1f 原文：
 *   「一个单位永远不能攻击移动规则（尤其见 6.1d 和 6.2c）中的禁止它进入的格……还要注意的是，
 *     如果单位可以在移动中进入某格，但**只能通过使用道路进入**的话，则**只允许单位进行常规战斗，
 *     不允许进行突袭**（8.1c）。」
 *   TEC 图例：「`*` 格子属性：移动为 P 的单位必须**沿路**才能进入并攻击该格」。
 * 故本函数给出三种结论：
 *   - `normal`  ：不借道路即可进入 ⇒ **普通攻击与突袭都可以**；
 *   - `roadOnly`：只有沿路才能进入 ⇒ **普通攻击可以，突袭不可以**（8.1c：不得用道路降费/否定 P）；
 *   - 失败      ：连沿路也进不去（或地形数据非法）⇒ **两种攻击都不可以**（9.1f 前段）。
 *
 * @param input 与 `selectMovementTerrain` 同形；`followingRoad` 取「该步是否走 6.2a 道路优先」
 */
export function canEnterForCombat(input: MovementTerrainInput): EnterForCombatVerdict {
  // ① 允许沿路：普通攻击的门槛（9.1f 前段 + 6.2a）
  const viaRoad = selectMovementTerrain({ ...input, forOverrun: false })
  if (!viaRoad.ok)
    return {
      ok: false,
      reason: viaRoad.reason,
      detail:
        viaRoad.reason === 'prohibited'
          ? `禁止进入（${viaRoad.terrain}${viaRoad.requiresRoad ? '，且该边无路可走' : ''}）：不能进入的格也不得攻击（9.1f）`
          : `地形数据不支持进入判定（${viaRoad.reason}）`,
    }

  // ② 不给道路折扣：突袭的门槛（8.1c）
  const noRoad = selectMovementTerrain({ ...input, forOverrun: true })
  if (!noRoad.ok)
    return {
      ok: true,
      via: 'roadOnly',
      terrain: viaRoad.terrain,
      cost: viaRoad.totalMp,
      detail: `只能沿路进入（${viaRoad.terrain}，${viaRoad.totalMp} MP）：可普通攻击，不可突袭（9.1f / 8.1c）`,
    }

  return {
    ok: true,
    via: 'normal',
    terrain: noRoad.terrain,
    cost: noRoad.totalMp,
    detail: `${noRoad.totalMp} MP，不借道路即可进入：普通攻击与突袭均可`,
  }
}

/** 6.2d 结果：可行则给出地形、MP 与跨河追加；不可行给出原因 */
export type MovementTerrainResult =
  | {
      ok: true
      /** 据以收费的地形名（沿路时为道路名） */
      terrain: string
      /** 目标格成本（沿路时为所走道路的成本） */
      mp: number
      /** 过河消耗（跨格边追加值；桥把河效果取消故为 0） */
      hexsideDelta: number
      /** 该步合计消耗 = mp + hexsideDelta（★ 用户裁定的加法模型：过河消耗 + 目标格消耗） */
      totalMp: number
      /** 原文 MP 列写 All（大河/步兵）：本步须耗尽单位全部剩余 MA，由调用方结算；且不可 overrun（8.1a） */
      spendsAllMp: boolean
      /** 是否走了 6.2a 道路优先 */
      roadOverride: boolean
      /** 该格边上是否有桥（客观事实＝河/湖 + 路/铁） */
      bridge: boolean
      /** 本步是否按桥通行（沿路且该边有桥） */
      crossedOnBridge: boolean
      /** 6.2d 在格内选出的最贵地形（沿路时仍如实给出，便于界面显示） */
      hexTerrain: string | null
    }
  | { ok: false; reason: 'prohibited'; terrain: string; requiresRoad: boolean }
  | { ok: false; reason: 'unknownTerrain'; terrain: string }
  | { ok: false; reason: 'noTerrain' }

/**
 * 6.2d 移动地形选取 + 跨格边成本
 *
 * 顺序：① 先判格内地形（沿路则以**所走道路**的成本取代）→ ② 再叠加跨格边河流追加值。
 * 禁止通行（P）返回 ok:false 而非高 MP：这是合法性判定，不是数值。
 * 桥由 crossing 自动推出，调用方**不得**另传桥梁标志。
 */
export function selectMovementTerrain(input: MovementTerrainInput): MovementTerrainResult {
  const {
    terrainsPresent,
    mobility,
    crossing = null,
    followingRoad = false,
    viaRoute = null,
    forOverrun = false,
  } = input

  // 未知地形名必须显式失败：静默当 1 MP 会悄悄放过错数据
  for (const name of terrainsPresent) {
    if (tecFeature(name) === null) return { ok: false, reason: 'unknownTerrain', terrain: name }
  }

  const hexTerrain = selectTerrainLabel(terrainsPresent)
  const river = crossing?.river ?? null
  const routes = crossing?.routes ?? []
  if (river !== null && tecFeature(river) === null) {
    return { ok: false, reason: 'unknownTerrain', terrain: river }
  }
  for (const name of routes) {
    if (tecFeature(name) === null) return { ok: false, reason: 'unknownTerrain', terrain: name }
  }

  // 该格边上是否有桥（客观事实）
  const bridge = isBridgeCrossing(crossing)
  // ★ 用户裁定 2026-09-12：有桥格边过河**必经那条路**（桥就是那条路），
  //   故 bridge 本身即蕴含「沿路」，不待调用方声明；不存在「有桥却不沿路」的情形。
  const onRoute = followingRoad || bridge
  // 8.1c：overrun 时不给道路折扣。桥不受此限——桥取消的是河效果，不是「借桥否定 P」
  const route = forOverrun || !onRoute ? null : chooseRoute(routes, mobility, viaRoute)

  // ① 格内成本（沿路时由承载道路取代）
  let terrain: string
  let mp: number
  if (route !== null) {
    const cell = tecFeature(route)!.mp[mobility]
    if (cell.kind !== 'fixed') return { ok: false, reason: 'noTerrain' }
    terrain = route
    mp = cell.value
  } else {
    if (hexTerrain === null) return { ok: false, reason: 'noTerrain' }
    const cell = tecFeature(hexTerrain)!.mp[mobility]
    if (cell.kind === 'prohibited') {
      return {
        ok: false,
        reason: 'prohibited',
        terrain: hexTerrain,
        requiresRoad: requiresRoadToEnter(hexTerrain, mobility),
      }
    }
    if (cell.kind !== 'fixed') return { ok: false, reason: 'noTerrain' }
    terrain = hexTerrain
    mp = cell.value
  }

  // ② 过河消耗（★ 用户裁定 2026-09-12：桥把河的移动力效果整个取消 → 有桥即无追加、且不可能是 P）
  let hexsideDelta = 0
  let spendsAllMp = false
  if (river !== null && !bridge) {
    const cell = tecFeature(river)!.mp[mobility]
    if (cell.kind === 'delta') {
      hexsideDelta = cell.value
    } else if (cell.kind === 'prohibited') {
      return {
        ok: false,
        reason: 'prohibited',
        terrain: river,
        requiresRoad: requiresRoadToEnter(river, mobility),
      }
    } else if (cell.kind === 'all') {
      // 原文 All：可通行但须耗尽全部剩余 MA；8.1a 规定 All 不可 overrun
      if (forOverrun)
        return { ok: false, reason: 'prohibited', terrain: river, requiresRoad: false }
      spendsAllMp = true
    }
  }

  return {
    ok: true,
    terrain,
    mp,
    hexsideDelta,
    totalMp: mp + hexsideDelta,
    spendsAllMp,
    roadOverride: route !== null,
    bridge,
    crossedOnBridge: route !== null && bridge,
    hexTerrain,
  }
}

/** 9.3b 候选输入 */
export interface CombatTerrainInput {
  /** 格内地形集合（契约：只含格内地形） */
  terrainsPresent: readonly string[]
  /** 该格是否为城市/村庄格；false 时城市/村庄符号视为溢出（spillover）而忽略 */
  cityHex?: boolean
}

/**
 * 9.4b：该地形是否**会在战斗中产生修正**（本模块的「战斗地形」判据）
 *
 * 只有 TEC 的 attack 行给出**真实倍率**（非 `ot`）才算战斗地形。本作符合者两类：
 *   - 格内地形：Open / Woods / Forest / Swamp / Village / Minor City / Major City；
 *   - 格边地形：**河 / 湖**（Minor River 1/2、Major River 1/4、Lake/Blocked 1/4；均只作用攻方）。
 *
 * ★ **铁路 / 小路（Track）/ 大路（Secondary Road）的 attack 行全为 `ot`，一律不是战斗地形**
 *   （用户 2026-09-13 裁定，与 TEC 一致）：它们只与
 *     ① 移动消耗（6.2a 道路优先）、② 9.1f「轮式/履带单位对禁入地形只能沿路进入并攻击」、
 *     ③ 补给路径（12.3d 按正常地形成本，含道路优先）有关，**不得**作为 9.3b/9.4b 的地形选项。
 */
export function hasCombatMultiplier(name: string): boolean {
  const feature = tecFeature(name)
  if (feature === null) return false
  return (
    feature.attack.armor.kind === 'multiplier' ||
    feature.attack.mech.kind === 'multiplier' ||
    feature.attack.other.kind === 'multiplier'
  )
}

/**
 * 9.4b：从一组地形名中筛出**可作攻击方格边修正**者（河/湖）
 *
 * 供 `battle.declareBattleTerrain` 的格边候选与界面选项共用：两处都调用本函数 ⇒ 不会漂移。
 */
export function combatHexsideTerrains(names: readonly string[]): string[] {
  return names.filter(hasCombatMultiplier)
}

/**
 * 9.3b 候选集：防御方可选的地形符号
 *
 * 过滤两步：① 只保留格内地形（河/湖/路/铁是格边地形，永不进候选）；
 * ② 非城市/村庄格忽略城市/村庄符号（9.3b 的 spillover 例外）。
 */
export function combatTerrainCandidates(input: CombatTerrainInput): string[] {
  const { terrainsPresent, cityHex = false } = input
  const out: string[] = []
  for (const name of terrainsPresent) {
    const feature = tecFeature(name)
    if (feature === null || feature.kind !== 'hex') continue
    if (!cityHex && CITY_TERRAINS.has(name)) continue
    out.push(name)
  }
  return out
}

/** 某地形对三类攻击方部队的倍率（已按 9.4d 解析；attackerOnly 供界面标注方括号） */
export interface AttackMultipliers {
  armor: number
  mech: number
  other: number
}

/** 9.3b 结果 */
export type CombatTerrainResult =
  | {
      ok: true
      /** 防御方选定的地形 */
      terrain: string
      /** 由该地形决定的 Combat Table 行键 */
      combatLine: CombatLine
      /** 攻击方三类部队对选定地形的倍率 */
      attackerMultipliers: AttackMultipliers
      /** 各类倍率是否来自原文方括号（仅攻方生效） */
      attackerOnly: Record<AttackerType, boolean>
    }
  | { ok: false; reason: 'notACandidate'; terrain: string }
  | { ok: false; reason: 'noCandidate' }

/**
 * 9.3b 战斗地形结算
 *
 * 防御方从候选集中选一种 → 由该地形定 Combat Line 与攻方倍率。
 * 攻击方所在格的地形不参与本判定（9.3b 原文：The terrain in the attacking hexes does not matter）。
 */
export function resolveCombatTerrain(
  input: CombatTerrainInput & { chosen: string },
): CombatTerrainResult {
  const candidates = combatTerrainCandidates(input)
  if (candidates.length === 0) return { ok: false, reason: 'noCandidate' }
  if (!candidates.includes(input.chosen))
    return { ok: false, reason: 'notACandidate', terrain: input.chosen }
  const line = combatLineOf(input.chosen)
  if (line === null) return { ok: false, reason: 'notACandidate', terrain: input.chosen }
  return {
    ok: true,
    terrain: input.chosen,
    combatLine: line,
    attackerMultipliers: {
      armor: attackMultiplier(input.chosen, 'armor', 'attacker'),
      mech: attackMultiplier(input.chosen, 'mech', 'attacker'),
      other: attackMultiplier(input.chosen, 'other', 'attacker'),
    },
    attackerOnly: {
      armor: multiplierOf(attackMod(input.chosen, 'armor'))?.attackerOnly ?? false,
      mech: multiplierOf(attackMod(input.chosen, 'mech'))?.attackerOnly ?? false,
      other: multiplierOf(attackMod(input.chosen, 'other'))?.attackerOnly ?? false,
    },
  }
}

/** 防御方在候选集中按最有利者自动选择（界面未介入时的默认策略；正式对局应由防御方手选） */
export function bestCombatTerrainForDefender(input: CombatTerrainInput): string | null {
  const candidates = combatTerrainCandidates(input)
  if (candidates.length === 0) return null
  const order: CombatLine[] = ['Open', 'Close', 'Very Close', 'Extr Close']
  let best: string | null = null
  let bestRank = -1
  for (const name of candidates) {
    const line = combatLineOf(name)
    if (line === null) continue
    const rank = order.indexOf(line)
    if (rank > bestRank) {
      bestRank = rank
      best = name
    }
  }
  return best
}
