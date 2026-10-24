import { chartsSupplyRepl, rulesConstants } from '@/data'
import type { DeepReadonly, HexRef, RebuildRow, Side } from '@/data'

import { fail, succeed, type RuleOutcome } from '../result-types'

/**
 * 补员与重建（通规 13.5 ← 专规 1.6 覆盖）
 *
 * ## 条文索引（中文规则书 13.5 / Smolensk 专规 1.6 Notes）
 *   - 13.5  补员（Pax / Eq）在每个己方增援阶段按**可变补员表**掷得，是正常增援之外的额外补充；
 *           可以**立即使用**或保留待用（专规 1.6 Notes 明确 Pax/Eq 是本作唯一可跨回合保存的补员）；
 *           补员永不能进入战斗模式；堆叠时计 1/4 RE；具可攻击能力、可承受损失；须正常获得战斗补给与燃料。
 *   - 13.5a 重建位置：所需补员须**都在一个格中**，且该格在一个**友方指挥部的 2 格内（含 2 格）**；
 *           该 HQ 须处于**战斗模式**，或 DG 但朝向战斗模式面（5.10e）；该格**不可在敌方 ZOC 内**（4.5a）。
 *           移除补员，把重建单位放入该格。重建**图上有军力损失的单位**时，还须该单位与所用补员**堆叠在一起**。
 *   - 13.5b 一回合内可重建任意数量军力（有足够补员即可）；补给状态与模式**不影响**重建；重建不消耗 MP；
 *           重建出的单位可设为任意主动模式；只有**死亡堆中的单位**与**图上有军力损失的单位**才能重建；
 *           像**拆分单位**这样的通用单位通常不能重建（被摧毁后返回资源池）。
 *   - 13.5c AR 后有黄点的单位（数据层 `rebuildable: false`）无法重建，被摧毁即永久移除。
 *   - 13.5d 某些非常小的单位可**成对重建**（两个单位用一个补员）；死亡堆中只剩一个时仍消耗一个补员。
 *   - 13.5e 卡车（编内卡车或普通卡车）可用 **1 点装备补员**重建；只有**被敌方行动摧毁或夺取**的卡车
 *           才能这样重建（故拥有量永不超过剧本给定量）；**马车/骡子等其他运输点数不能**这样重建。
 *   - 13.5f（**本作被专规 1.6 Notes 覆盖**）：
 *           · 专规 1.6 Notes：「Eq **不**重建飞机」；飞机只能经 Repl Table 的 **Ftr / Tac** 补员重建；
 *           · 「Ftr / Tac Repl 只补 **1 step**（Ftr 限 **F 型**、Tac 限 **T / S / Tpt** 型），且**不可保存**」；
 *           · 13.5f 的落点仍适用：飞机可在**任何友方空军基地**重建（不必在 HQ 附近），
 *             以**激活**状态从死亡堆抵达；**无论飞行条件如何**都可重建。
 *
 * ## 设计口径
 *   - 重建表的**行键**（`unitType`，如 `Infantry Div step`）由调用方按重建表选定——本作的工程数据库
 *     未落「算子 → 重建表行」的映射，故引擎不臆造该映射（见返回值 `rebuildChartRows`）；
 *   - 数值只取自 `rules-constants.json` 与 `charts-supply-repl.json`，无硬编码；
 *   - 本模块**不写状态**：返回 `placements` 与扣减后的 `holdingsAfter`，由调用方落盘（CODE_SPEC §3.1）。
 */

/* ────────────────────────────── 补员账本（13.5） ────────────────────────────── */

/**
 * 补员持有量
 *
 * Pax / Eq 可跨回合保存（专规 1.6 Notes）；Ftr / Tac 只补 1 step **不可保存**——
 * 故本账本把四类都列出，但 `planRebuild` 会拒绝以 Ftr/Tac 之外的资源重建飞机。
 */
export interface ReplHoldings {
  pax: number
  eq: number
  ftr: number
  tac: number
}

/** 补员资源种类 */
export type ReplResource = keyof ReplHoldings

/** 空账本 */
export function emptyReplHoldings(): ReplHoldings {
  return { pax: 0, eq: 0, ftr: 0, tac: 0 }
}

/** 账本相加（发放补员时用） */
export function addReplHoldings(a: ReplHoldings, b: Partial<ReplHoldings>): ReplHoldings {
  return {
    pax: a.pax + (b.pax ?? 0),
    eq: a.eq + (b.eq ?? 0),
    ftr: a.ftr + (b.ftr ?? 0),
    tac: a.tac + (b.tac ?? 0),
  }
}

/** 账本是否够付 cost（逐项比较） */
export function canAffordRepl(holdings: ReplHoldings, cost: Partial<ReplHoldings>): boolean {
  return (Object.keys(cost) as ReplResource[]).every((key) => holdings[key] >= (cost[key] ?? 0))
}

/** 扣减账本（不足即抛错；调用方应先 `canAffordRepl`） */
export function subtractReplHoldings(
  holdings: ReplHoldings,
  cost: Partial<ReplHoldings>,
): ReplHoldings {
  if (!canAffordRepl(holdings, cost)) {
    throw new RangeError('[rebuild] 补员不足，不得扣减')
  }
  return {
    pax: holdings.pax - (cost.pax ?? 0),
    eq: holdings.eq - (cost.eq ?? 0),
    ftr: holdings.ftr - (cost.ftr ?? 0),
    tac: holdings.tac - (cost.tac ?? 0),
  }
}

/**
 * 可跨回合保存的补员（专规 1.6 Notes）
 *
 * 「Pax / Eq 是本作**唯一可跨回合保存**的 repl；Ftr / Tac Repl 只补 1 step 且**不可保存**」
 * ⇒ 未用掉的 Ftr/Tac 在增援阶段结束时清零。
 */
export function isSavableRepl(resource: ReplResource): boolean {
  return resource === 'pax' || resource === 'eq'
}

/** 清零不可保存的补员（增援阶段结束时调用；13.5 + 专规 1.6 Notes） */
export function clearNonSavableRepl(holdings: ReplHoldings): ReplHoldings {
  return { ...holdings, ftr: 0, tac: 0 }
}

/* ────────────────────────────── 重建表（13.5c / 13.5d） ────────────────────────────── */

/** 重建表的一行（`unitType` 即行键，照图表原文；来源 charts-supply-repl.json，已冻结只读） */
export type RebuildChartRow = DeepReadonly<RebuildRow>

/** 取该方的重建表行（唯一来源 charts-supply-repl.json；本作工程库未落「算子 → 行」映射） */
export function rebuildChartRows(side: Side): readonly RebuildChartRow[] {
  return chartsSupplyRepl.rebuild[side]
}

/** 按行键取重建途径；未登记即 null（不可经常规途径重建，13.5c 的延伸） */
export function rebuildRow(side: Side, unitType: string): RebuildChartRow | null {
  return chartsSupplyRepl.rebuild[side].find((row) => row.unitType === unitType) ?? null
}

/**
 * 13.5：**「建议行键」的输入**（由记录的分类字段填，**不含任何费用判断**）
 *
 * 「建议」只是替裁判省一次下拉搜索，**不是**规则判定：费用完全由最终选中的行决定，
 * 界面必须让裁判显式采用（不得在未选行时静默取建议行）。
 */
export interface RebuildRowHint {
  side: Side
  /** 单位库 `branch`（infantry / armor_pz / armor_tk / artillery / hq / …） */
  branch?: string | null
  /** 单位库 `echelon`（div / bde / rgt / bn / coy），`echelonStatus` 类记录为空 */
  echelon?: string | null
  /** 单位库 `specialized`（hq / artillery / breakdown / engineer / rail_repair …） */
  specialized?: readonly string[]
  /** 印刷名（只用于分辨同兵种下重建表**分了多行**的亚型，如 Flm / Aufk / Werfer / Bicycle） */
  name?: string | null
  /** 专规 1.6 Notes：飞机（走 Repl Table，行键恒 `Aircraft`） */
  isAircraft?: boolean
  /** 13.5e：普通运输点数（行 `Transport Points`） */
  isTransportPoint?: boolean
  /**
   * 13.5c：数据层的 `rebuildable`（`false`＝AR 后有黄点，**永久不可重建**）
   *
   * 用户 2026-10-24 裁定：**该字段是对的**——「只有少数单位不能重建」。
   * 故苏军步兵师的行键按它分：`false → Infantry Div (Red)`（表里那行就是 No Rebuild），其余 → `Infantry Div step`。
   * 实测与表中 No-Rebuild 行完全对齐：轴心 2 条 `Flm`、苏军 3 条 `NKVD Border`、4 条 `Mot Div`、2 条 `Rifle Div`（109/219）。
   */
  rebuildable?: boolean
}

/**
 * 13.5：由**记录自身的分类字段**推出重建表行键（推不出唯一行 ⇒ null）
 *
 * 判据逐条对回 `charts-supply-repl.json` 的 `unitType` 原文，且**只在该行确实存在于本方的表里**时才给：
 * - 兵种 × 编制层级对得上唯一一行（`hq→HQ`、`armor_pz/bn→Panzer Bn`、`armor_tk/div→Tank Div step`…）；
 * - 同兵种在表里被拆成多行时，只能用**印名里的亚型词**分辨（`Flm`→Flm Panzer Bn、`Aufk`→Aufk、
 *   `Werfer`→Werfer Bn、`Bike/Bicycle`→Bicycle Cavalry Bn、`PJ`→PJ Bn、`alarm`→Militia Alarm Rgt）；
 * - 苏军步兵师的 `step / (Red)` 两行按**数据层的 `rebuildable`** 分（用户 2026-10-24 裁定该字段可信：
 *   「只有少数单位不能重建」⇒ `false → Infantry Div (Red)`，其余 → `Infantry Div step`）；
 * - **不猜**的情形（返回 null，交裁判人工选行）：
 *   · `motorized/rgt`（究竟是 `PG (Arm Inf) Rgt`〔1Eq+1Pax〕还是 `Infantry Bde or Rgt`〔2Pax〕，费用不同）；
 *   · `armor_pz/rgt`（表里没有"装甲团"一行）、`artillery/bn` 而印名不带 Werfer；
 *   · 任何 `specialized` 含 `artillery` 的**非炮兵兵种**记录（如装甲师属炮兵团，不能按装甲行计）；
 *   · 表里没有对应行的兵种（airbase / supply / extender / hedgehog / replacement…）。
 */
export function suggestRebuildRow(hint: RebuildRowHint): string | null {
  /** 行必须**存在于本方的表**里才给（表是唯一来源，不凭空造行键） */
  const row = (unitType: string): string | null =>
    rebuildRow(hint.side, unitType) === null ? null : unitType
  if (hint.isAircraft === true) return row('Aircraft')
  const specialized = hint.specialized ?? []
  if (specialized.includes('breakdown')) return row('Breakdown Rgt')
  if (hint.isTransportPoint === true) return row('Transport Points')
  // 师属炮兵团/营混在别的兵种里：按"炮兵行"计会与表不符，按原兵种计也不对 ⇒ 不猜
  if (specialized.includes('artillery') && hint.branch !== 'artillery') return null
  const branch = hint.branch ?? ''
  const echelon = hint.echelon ?? ''
  const name = (hint.name ?? '').toLowerCase()
  switch (branch) {
    case 'hq':
      return row('HQ (any size or type)')
    case 'armor_pz':
      if (echelon !== 'bn') return null
      return /\bflm\b/.test(name) ? row('Flm Panzer Bn') : row('Panzer Bn')
    case 'armor_tk':
      if (echelon === 'div') return row('Tank Div step')
      // 苏军另有独立的 `Tank Alarm Bn` 行（Special 1.6c），不能并到常规坦克行
      if (/alarm/.test(name)) return row('Tank Alarm Bn')
      if (echelon === 'bn' || echelon === 'rgt' || echelon === 'bde') {
        return row('Tank Bn, Rgt, or Bde')
      }
      return null
    case 'anti_tank':
      if (hint.side === 'soviet') return echelon === 'rgt' ? row('AT Alarm Rgt') : null
      if (echelon !== 'bn') return null
      return /\bpj\b/.test(name) ? row('PJ Bn') : row('Anti-Tank Bn (German)')
    case 'arm_rec':
      if (echelon !== 'bn') return null
      if (hint.side === 'soviet') return row('Arm Recon Bn (Soviet)')
      return /\baufk\b/.test(name) ? row('Aufk (Arm Recon) Bn') : row('Arm Car Bn')
    case 'artillery':
      if (echelon === 'rgt' || echelon === 'bde') {
        // 表里 Werfer Rgt 与 Artillery Rgt or Bde 同价（2x Eq），但仍按印名取对应行
        return /werfer/.test(name) ? row('Werfer Rgt') : row('Artillery Rgt or Bde')
      }
      return /werfer/.test(name) ? row('Werfer Bn') : null
    case 'cavalry':
      if (hint.side === 'soviet' && echelon === 'div') return row('Cavalry Div (Soviet)')
      if (echelon !== 'bn') return null
      return /bike|bicycle/.test(name) ? row('Bicycle Cavalry Bn') : row('Cavalry Bn')
    case 'machine_gun':
      return echelon === 'bn' ? row('MG Bn') : null
    case 'motorcycle':
      return hint.side === 'soviet' ? row('Motorcycle (MC) Rgt') : row('Krd (Motorcycle) Bn')
    case 'engineer':
      if (specialized.includes('rail_repair')) {
        return hint.side === 'soviet' ? row('RR Rgt') : row('RR Bn')
      }
      return hint.side === 'axis' && echelon === 'bn' ? row('Pio Bn') : null
    case 'security':
      if (echelon === 'div') return row('Sec Div step')
      return echelon === 'rgt' ? row('Sec Rgt') : null
    case 'infantry':
      /*
       * 苏军步兵师在表里分了两行：`Infantry Div step`（2x Pax）与 `Infantry Div (Red)`（No Rebuild）。
       * 用户 2026-10-24 裁定：**按数据层的 `rebuildable` 分**（「只有少数单位不能重建」）——
       * `rebuildable === false` 的才是 (Red)（实测 109/219 Rifle Div），其余走 step 行。
       */
      if (hint.side === 'soviet' && echelon === 'div') {
        return hint.rebuildable === false ? row('Infantry Div (Red)') : row('Infantry Div step')
      }
      if (hint.side === 'axis' && echelon === 'div') return row('Infantry Div step')
      if (hint.side === 'soviet' && echelon === 'rgt') return row('Infantry Rgt')
      if (hint.side === 'soviet' && echelon === 'bde' && /para/.test(name)) {
        return row('Para Inf Bde (Soviet)')
      }
      return null
    case 'mountain':
      return echelon === 'div' ? row('Mtn Inf Div step') : null
    case 'militia':
      if (echelon === 'div') return row('Militia Div step')
      return /alarm/.test(name) ? row('Militia Alarm Rgt') : null
    case 'fortified_region':
      return echelon === 'bde' ? row('UR Bde') : null
    case 'nkvd_border':
      return row('NKVD Border Rgt')
    default:
      return null
  }
}

/** 13.5c：AR 后有黄点（`rebuildable: false`）的单位永久不可重建 */
export const NO_REBUILD_RULE = '13.5c'

/** 13.5b：拆分单位被摧毁后返回资源池，不重建 */
export const BREAKDOWN_RETURNS_TO_POOL_RULE = '13.5b'

/** 13.5e：卡车重建的每条费用（1 点装备补员） */
export const TRUCK_REBUILD_COST_EQUIPMENT = rulesConstants.repl.truckRebuildEquipment

/* ────────────────────────────── 请求与结论 ────────────────────────────── */

/** 待重建单位视图 */
export interface RebuildCandidateView {
  id: string
  side: Side
  /** 13.5：重建表行键（`unitType`；由调用方按重建表选定） */
  rebuildType: string
  /** 13.5c：AR 后有黄点 ⇒ 不可重建（数据层 `rebuildable === false`） */
  rebuildable: boolean
  /** 专规 1.6 Notes：是否飞机（飞机只能经 Ftr/Tac 补员重建，且 Eq 不可用） */
  isAircraft: boolean
  /** 专规 1.6 Notes：机型代号（F 型用 Ftr；T / S / Tpt 用 Tac） */
  aircraftType?: string
  /** 13.5b：在死亡堆 ⇒ true；图上带军力损失 ⇒ false */
  inDeadPile: boolean
  /** 13.5a：重建图上有军力损失的单位时，该单位所在格（须与补员同格） */
  hex: HexRef | null
  /** 13.5b：当前军力与印值军力（重建不得超出印值） */
  steps: number
  printedSteps: number
  /** 13.5b：拆分单位 ⇒ 返回资源池 */
  isBreakdown: boolean
  /** 13.5e：普通卡车（运输点数）重建走 1 点装备补员 */
  isTruckTransportPoint: boolean
  /**
   * 13.5e：该卡车是否**因敌方行动**被摧毁或夺取
   *
   * 「只有被敌方行动摧毁（或夺取）的卡车才能以这种方式重建，因此玩家拥有的卡车数量
   *   永远不能超过剧本提供给他的数量」——故须由调用方给出这一事实。
   */
  destroyedByEnemy?: boolean
}

/** 重建须注入的落点事实（13.5a / 4.5a / 13.5f） */
export interface RebuildPlacementFacts {
  /** 13.5a：该格是否在「战斗模式的友方 HQ（或 DG 但朝向战斗面，5.10e）」2 格内 */
  withinHqThrowOfFriendlyHq(hex: HexRef): boolean
  /** 4.5a：该格是否在**未被抵消**的敌方 ZOC 内 */
  inUnnegatedEnemyZoc(hex: HexRef): boolean
  /** 13.5f：该方是否有可用的友方空军基地（飞机重建的落点） */
  hasFriendlyAirBase(): boolean
  /** 13.5f：飞机重建的落点格（任一友方空军基地格；无基地时为 null） */
  friendlyAirBaseHex?(): HexRef | null
}

/** 重建请求 */
export interface RebuildRequest {
  side: Side
  candidate: RebuildCandidateView
  /**
   * 13.5a：补员所在的格
   *
   * 地面重建必填（须与补员同格、且在 HQ 2 格内）；**飞机重建可省略**（13.5f：可在任意友方空军基地重建）。
   */
  replHex?: HexRef
  /**
   * 13.5b：本次要补回的军力数
   *
   * 死亡堆整单位重建时省略 ⇒ 补满印值军力；图上带损单位给出要补的步数（≤ 印值 − 当前军力）。
   */
  stepsToRestore?: number
  /**
   * 13.5d：成对重建的**单次数量**（一行补员重建几个单位）
   *
   * 图表转录未标出哪些行成对（数据缺口），故由调用方给出；缺省 1。
   */
  pairSize?: number
  /** 本次要重建的单位个数（缺省 1；成对行按 `pairSize` 折算补员数） */
  unitsRequested?: number
  holdings: ReplHoldings
  facts: RebuildPlacementFacts
}

/** 重建落点（由调用方落盘；引擎不写状态） */
export interface RebuildPlacement {
  unitId: string
  /** 落点格（飞机为友方空军基地格） */
  hex: HexRef
  /** 重建后的军力 */
  stepsAfter: number
  /** 13.5f：飞机以激活状态抵达；地面单位按调用方选择的主动模式（13.5b） */
  airStatus?: 'active'
  /** 13.5b：重建不消耗 MP ⇒ 0 */
  mpSpent: 0
}

/** 重建计划 */
export interface RebuildPlan {
  rule: string
  /** 实际扣减的补员 */
  cost: Partial<ReplHoldings>
  holdingsAfter: ReplHoldings
  /** 落点（`unitsRequested` 个） */
  placements: readonly RebuildPlacement[]
  detail: string
}

/** 专规 1.6 Notes：F 型用 Ftr 补员，T / S / Tpt 型用 Tac 补员 */
export function replResourceForAircraft(aircraftType: string): 'ftr' | 'tac' | null {
  const code = aircraftType.trim().toUpperCase()
  if (code === 'F') return 'ftr'
  if (code === 'T' || code === 'S' || code === 'TPT') return 'tac'
  return null
}

/** 专规 1.6 Notes：Ftr / Tac 补员每次只补 **1 step** */
export const REPL_STEPS_PER_COUNTER = rulesConstants.repl.airReplStepsPerCounter

/**
 * 13.5 / 专规 1.6：重建一个（或成对的一组）单位
 *
 * 判定顺序（照条文）：① 不可重建（13.5c）→ ② 拆分单位返回资源池（13.5b）→ ③ 资源与费用
 * （图上有损 ⇒ 须与补员同格）→ ④ 落点（地面：HQ 2 格内且不在敌方 ZOC；飞机：任意友方空军基地、激活）。
 */
export function planRebuild(input: RebuildRequest): RuleOutcome<RebuildPlan> {
  const { candidate, facts } = input

  // ① 13.5c：AR 后有黄点者永久不可重建
  if (!candidate.rebuildable) return fail(NO_REBUILD_RULE, `noRebuild:${candidate.id}`)
  // ② 13.5b：拆分单位被摧毁后返回资源池
  if (candidate.isBreakdown)
    return fail(BREAKDOWN_RETURNS_TO_POOL_RULE, `breakdownReturnsToPool:${candidate.id}`)

  const unitsRequested = Math.max(1, Math.trunc(input.unitsRequested ?? 1))
  const pairSize = Math.max(1, Math.trunc(input.pairSize ?? 1))
  const countersNeeded = Math.ceil(unitsRequested / pairSize)

  // ③ 费用
  const aircraftCost = candidate.isAircraft ? aircraftReplCost(candidate, unitsRequested) : null
  if (candidate.isAircraft && aircraftCost === null) {
    return fail(
      '专规 1.6',
      `aircraftTypeNotRebuildable:${candidate.id}:${candidate.aircraftType ?? '?'}`,
    )
  }
  const cost: Partial<ReplHoldings> | null =
    aircraftCost ??
    (candidate.isTruckTransportPoint
      ? truckRebuildCost(candidate, countersNeeded)
      : chartRebuildCost(input.side, candidate, countersNeeded))
  if (cost === null) {
    const row = rebuildRow(input.side, candidate.rebuildType)
    return fail('13.5', `rebuildTypeNotRebuildable:${row?.unitType ?? candidate.rebuildType}`)
  }
  if (!canAffordRepl(input.holdings, cost)) {
    return fail('13.5', `insufficientRepl:${describeCost(cost)}`)
  }

  // ④ 落点
  if (candidate.isAircraft) {
    if (!facts.hasFriendlyAirBase())
      return fail('13.5f', `noFriendlyAirbaseForRebuild:${candidate.id}`)
    // 13.5f：飞机在任意友方空军基地以**激活**状态从死亡堆抵达
    const hex = firstFriendlyAirBaseHex(facts)
    if (hex === null) return fail('13.5f', `noFriendlyAirbaseForRebuild:${candidate.id}`)
    const stepsAfter = restoredSteps(candidate, input.stepsToRestore)
    return succeed('13.5f', {
      rule: '13.5f',
      cost,
      holdingsAfter: subtractReplHoldings(input.holdings, cost),
      placements: Array.from({ length: unitsRequested }, () => ({
        unitId: candidate.id,
        hex,
        stepsAfter,
        airStatus: 'active' as const,
        mpSpent: 0 as const,
      })),
      detail:
        `${candidate.id} 经 ${describeCost(cost)} 在友方空军基地重建（13.5f：以激活状态抵达，` +
        `无论飞行条件如何；专规 1.6：Eq 不重建飞机，Ftr/Tac 各补 ${REPL_STEPS_PER_COUNTER} step）`,
    })
  }

  const replHex = input.replHex ?? null
  if (replHex === null) return fail('13.5a', `missingReplHex:${candidate.id}`)
  // 13.5a：该格不可在敌方 ZOC 内
  if (facts.inUnnegatedEnemyZoc(replHex))
    return fail('4.5a', `rebuildHexInEnemyZoc:${candidate.id}`)
  // 13.5a：该格须在「战斗模式（或 DG 但朝战斗面）的友方 HQ」2 格内
  if (!facts.withinHqThrowOfFriendlyHq(replHex))
    return fail('13.5a', `rebuildHexNotWithinHqRange:${candidate.id}`)
  // 13.5a：重建**图上有军力损失**的单位时，该单位必须与补员**堆叠在一起**
  if (!candidate.inDeadPile) {
    if (candidate.hex === null || !sameHex(candidate.hex, replHex))
      return fail('13.5a', `unitNotStackedWithRepl:${candidate.id}`)
  }

  const stepsAfter = restoredSteps(candidate, input.stepsToRestore)
  return succeed('13.5', {
    rule: '13.5',
    cost,
    holdingsAfter: subtractReplHoldings(input.holdings, cost),
    placements: Array.from({ length: unitsRequested }, () => ({
      unitId: candidate.id,
      hex: replHex,
      stepsAfter,
      mpSpent: 0 as const,
    })),
    detail:
      `${candidate.id} 经 ${describeCost(cost)} 重建于 ${replHex.col}.${replHex.row}` +
      `（13.5a：HQ 2 格内、无未抵消敌 ZOC；13.5b：不耗 MP，模式由玩家任选）`,
  })
}

/* ────────────────────────────── 内部工具 ────────────────────────────── */

function sameHex(a: HexRef, b: HexRef): boolean {
  return a.col === b.col && a.row === b.row
}

/** 13.5b：重建后的军力（不得超出印值） */
function restoredSteps(candidate: RebuildCandidateView, stepsToRestore?: number): number {
  /*
   * 专规 1.6 Notes（第五批批 C 切片 3）：「Ftr 补员重建 F 型、Tac 补员重建 T / S / Tpt 型，
   * 且**只重建一个军力**」⇒ 死堆飞机从死亡堆拉起时**只出 1 个军力**（要满编须再重建一次；
   * 第二次走下面的"图上带损 ⇒ 补步"分支，同样按 1 点补员 = 1 step 计费）。
   */
  if (candidate.inDeadPile)
    return candidate.isAircraft
      ? Math.min(candidate.printedSteps, REPL_STEPS_PER_COUNTER)
      : candidate.printedSteps
  const want = Math.max(0, Math.trunc(stepsToRestore ?? candidate.printedSteps - candidate.steps))
  return Math.min(candidate.printedSteps, candidate.steps + want)
}

/** 13.5f + 专规 1.6：飞机重建费用（Ftr/Tac 补员各 1 step；**Eq 不重建飞机**） */
function aircraftReplCost(
  candidate: RebuildCandidateView,
  unitsRequested: number,
): Partial<ReplHoldings> | null {
  if (candidate.aircraftType === undefined) return null
  const resource = replResourceForAircraft(candidate.aircraftType)
  if (resource === null) return null
  // 「Ftr / Tac Repl 只补 1 step」⇒ 每个重建的 step 消耗一点该补员
  return { [resource]: unitsRequested * REPL_STEPS_PER_COUNTER }
}

/**
 * 13.5e：卡车重建费用（1 点装备补员/辆）
 *
 * 「只有被敌方行动摧毁（或夺取）的卡车才能以这种方式重建，因此玩家拥有的卡车数量永远不能超过
 *   剧本提供给他的数量」——故未被敌方摧毁的卡车须由调用方把 `destroyedByEnemy` 置真。
 */
function truckRebuildCost(
  candidate: RebuildCandidateView,
  countersNeeded: number,
): Partial<ReplHoldings> | null {
  if (candidate.destroyedByEnemy !== true) return null
  return { eq: TRUCK_REBUILD_COST_EQUIPMENT * countersNeeded }
}

/** 13.5 / 13.5c / 13.5d：按重建表行给出费用 */
function chartRebuildCost(
  side: Side,
  candidate: RebuildCandidateView,
  countersNeeded: number,
): Partial<ReplHoldings> | null {
  const row = rebuildRow(side, candidate.rebuildType)
  if (row === null) return null
  const entry = row.rebuild
  switch (entry.kind) {
    case 'normal': {
      const cost: Partial<ReplHoldings> = {}
      for (const item of entry.cost) {
        cost[item.resource] = (cost[item.resource] ?? 0) + item.amount * countersNeeded
      }
      return cost
    }
    // 13.5c 不可重建 / 13.5b 返回资源池 / 1.6c 仅特殊补员 / 仅补员表 / 条文另见
    case 'none':
    case 'pool':
    case 'special':
    case 'replOnly':
    case 'regulation':
      return null
  }
}

/** 费用描述（日志与测试断言用；顺序固定 pax → eq → ftr → tac） */
export function describeCost(cost: Partial<ReplHoldings>): string {
  const parts: string[] = []
  for (const key of ['pax', 'eq', 'ftr', 'tac'] as const) {
    const amount = cost[key]
    if (amount !== undefined && amount > 0) parts.push(`${amount}x ${labelOf(key)}`)
  }
  return parts.join(' + ')
}

function labelOf(resource: ReplResource): string {
  return resource === 'pax' ? 'Pax' : resource === 'eq' ? 'Eq' : resource === 'ftr' ? 'Ftr' : 'Tac'
}

/**
 * 13.5f 的落点：任意**友方空军基地**格
 *
 * 引擎不认识地图上的基地算子，故由 `facts` 的回调式事实决定「该方是否有可用基地」；
 * 具体取哪一格由调用方（`rebuildPlacementHex`）给出——这里仅返回一个占位以保持纯函数。
 */
function firstFriendlyAirBaseHex(facts: RebuildPlacementFacts): HexRef | null {
  return facts.friendlyAirBaseHex?.() ?? null
}
