import { DIE_FACES } from '../rng'
import { fail, succeed, type RuleOutcome } from '../result-types'
import type { GamePhase } from '../state-types'
import {
  BREAKOUT_FIRST_TURN_DRM,
  BREAKOUT_MIN_PRINTED_MA,
  BREAKOUT_RANGE_HEXES,
  BREAKOUT_SUCCESS_MIN_DICE,
} from './supply'
import type { MobilityType } from './terrain'

/**
 * 突围（B9，OCS 12.8e）
 *
 * ## 12.8e 原文要点（逐句落实现）
 * 「**任何当前没有追溯补给的**（在此环节中检查追溯补给）、**印刷的 MA 至少为 1 的战斗单位**
 *   （**非战斗单位除外**），在它们的**突围环节**中，如果满足以下条件，则可尝试突围：
 *   A) 尝试突围的单位与一个**拥有追溯补给的友方单位**之间，必须有一条**长度任意**的路径。这条路径上必须
 *      **没有敌方战斗单位**，也**没有移动禁入的地形**（以该突围单位**移动模式**的 MA 类型判断）。
 *      如果是**轮式 MP 单位**，这条路径上还必须有……没有**未被抵消的 EZOC**。
 *   B) 该单位必须在一个拥有追溯补给的**友方战斗单位**的 **15 格内**（含 15 格）（计算**直线距离**，
 *      忽略敌方单位或敌方 ZOC）。
 *   在一个单位发现自己没有追溯补给的**第一个回合**（不是在「吃图上补给」之后，也不是在使用部队储备或
 *   树皮汤等特殊的追溯补给方式之后），上述条件将被**免除**，且成功概率会提高，即获得 **+1 的掷骰修正**，
 *   并且**运输点数也允许进行突围**（为每个点数分别掷骰）。
 *   突围永远是**自愿**进行的。为每个尝试突围的单位**掷骰**：
 *   · 如果掷骰结果是 **1–4**，则该单位**失败**。它将被放入**死亡堆**中（可正常重建）。
 *   · 如果掷骰结果是 **5–6**，则单位**成功**。将它从地图上移除，但会**作为增援返回**游戏。为每个成功的单位
 *     **再掷一次骰子**：从当前回合向后数掷骰结果的回合数，它会在未来的这个回合返回。返回时，单位**保留所有
 *     军力损失标记**，但会**失去所有其他标记**（弹药不足、DG 等）。」
 *
 * ## 时机（2.2 流程表）
 * 突围是**移动阶段的首环节**：`C. 移动阶段 → 突围环节 → 移动环节 → 轰炸环节（仅飞机/舰船）`。
 * 故本模块只接受 `phase === 'movement'`；「处于突围环节」这一更细的时点由命令层掌握（SOP 槽位见 legality.ts）。
 *
 * ## 明确不由本模块负责（避免过度声称）
 *   - **追溯补给的检查**（12.8e 括注「在此环节中检查追溯补给」）：由补给层算出结论后作为 `hasTraceSupply` 传入；
 *   - **条件 A 的路径搜索**：禁入地形/敌方战斗单位/EZOC 的逐格判定属移动与 ZOC 层，本模块只按 `BreakoutPathFacts`
 *     的结论裁定（其中「轮式才受未被抵消 EZOC 限制」这一条由本模块按 12.8e-A 末句判定）；
 *   - **条件 B 的距离计算**：调用方只需给出「最近的、拥有追溯补给的友方**战斗**单位」的**直线距离**（12.8e-B 规定
 *     忽略敌方单位与 ZOC），15 格上限由本模块按全局常量判定；
 *   - **返回时的到场放置**：12.8e 只说「作为增援返回」，落点规则属 13.6 / 13.6b，由增援模块负责。
 */

/* ────────────────────────────── 常量 ────────────────────────────── */
// 四个 12.8e 常量按「引擎常量镜像 rules-constants.json 的节」惯例留在 `supply.ts`
// （该节 `supply` 即本作补给章常量所在），此处仅引入使用，避免同值两处定义：
//   BREAKOUT_MIN_PRINTED_MA  印刷的 MA 至少为 1
//   BREAKOUT_RANGE_HEXES     15 格（含）内有拥有追溯补给的友方战斗单位
//   BREAKOUT_FIRST_TURN_DRM  断补首回合 +1
//   BREAKOUT_SUCCESS_MIN_DICE 掷骰 5–6 成功

/* ────────────────────────────── 资格判定（12.8e） ────────────────────────────── */

/**
 * 12.8e-A：到「拥有追溯补给的友方单位」的路径事实（由调用方按地图逐格算出）
 *
 * 路径**长度任意**，但沿途：无敌方战斗单位、无移动禁入地形（以**移动模式**的 MA 类型判断）、
 * 且**轮式** MP 单位另需沿途无**未被抵消**的 EZOC（★ 徒步/履带不受 EZOC 限制）。
 */
export interface BreakoutPathFacts {
  /** 12.8e-A：「以该突围单位**移动模式**的 MA 类型判断」禁入地形 */
  mobility: MobilityType
  /** 路径上是否有敌方**战斗**单位（任何机动类型都禁止） */
  hasEnemyCombatUnit: boolean
  /** 路径上是否有移动禁入地形（按 `mobility` 判定） */
  hasProhibitedTerrain: boolean
  /** 路径上是否有**未被抵消**的 EZOC（★ 仅**轮式 MP** 单位受此限，见 12.8e-A 末句） */
  hasUnnegatedEzoc: boolean
}

/** 12.8e：突围单位的资格视图 */
export interface BreakoutUnitView {
  id: string
  /** 3.2：是否战斗单位（12.8e：「印刷的 MA 至少为 1 的**战斗单位**（**非战斗单位除外**）」） */
  isCombat: boolean
  /**
   * 13.2：是否为运输点数
   *
   * 仅「断补首回合」豁免时才允许突围，且条文要求「**为每个点数分别掷骰**」——
   * 故调用方须**逐个运输点数算子**调用本模块（每次一个算子、各掷各的骰），不得整堆叠掷一次。
   */
  isTransportPoint: boolean
  /**
   * 3.1a：**移动模式下**的印刷 MA（12.8e：至少为 1）
   *
   * 条文作「印刷的 MA 至少为 1」，未点明面；此处取**移动模式面**——与 12.8e-A「以该突围单位
   * **移动模式**的 MA 类型判断」同源，且该条要排除的本就是 MA 为 0 的不可移动单位。
   */
  moveMa: number
  /** 12.8e：此刻（**在突围环节中检查**）是否有追溯补给 */
  hasTraceSupply: boolean
}

/** 12.8e 条件 A / B 的事实 */
export interface BreakoutConditions {
  /** 12.8e-A：到「拥有追溯补给的友方单位」的路径 */
  path: BreakoutPathFacts
  /**
   * 12.8e-B：最近的「拥有追溯补给的友方**战斗**单位」的**直线距离**（格）；无则 null
   *
   * 「计算**直线距离**，忽略敌方单位或敌方 ZOC」⇒ 调用方在所有满足条件的友方战斗单位中取最小直线距离即可。
   */
  nearestTracedCombatFriendDistance: number | null
}

/** 突围资格结论 */
export interface BreakoutEligibility {
  /** 是否命中 12.8e 的「断补首回合」豁免（免除 A/B 条件） */
  firstTurn: boolean
  /** 突围掷骰修正（首回合 = BREAKOUT_FIRST_TURN_DRM，否则 0） */
  drm: number
  rule: string
  detail: string
}

/**
 * 12.8e：能否尝试突围
 *
 * 判定次序照条文：① 时机（2.2：移动阶段的首环节）→ ② 无追溯补给 → ③ 战斗单位（首回合豁免时运输点数亦可）
 * → ④ 印刷 MA ≥ 1 → ⑤ 首回合豁免（免除 A/B）否则查 A 与 B。
 */
export function canBreakout(input: {
  /** 2.2：突围是**移动阶段的首环节** */
  phase: GamePhase
  unit: BreakoutUnitView
  /**
   * 12.8e：是否为「单位发现自己没有追溯补给的**第一个回合**」
   *
   * ★ 括注限定：**不是在「吃图上补给」（12.6c）之后，也不是在使用部队储备（12.10）或树皮汤等特殊
   *   追溯补给方式之后**——那些「续命」方式不构成追溯补给，但也不给本豁免。故本标志只能对
   *   「连续处于无追溯补给状态的第一回合」置真。
   */
  firstTurnOutOfSupply: boolean
  /** 12.8e-A/B 的事实；命中首回合豁免时 A/B 被免除，可省略 */
  conditions?: BreakoutConditions
}): RuleOutcome<BreakoutEligibility> {
  const { unit } = input

  // 2.2：突围是移动阶段的首环节
  if (input.phase !== 'movement') return fail('2.2', 'breakoutOnlyInMovementPhaseBreakoutSegment')
  // 12.8e：「任何当前**没有追溯补给**的……」——有追溯补给者无须（也无从）突围
  if (unit.hasTraceSupply) return fail('12.8e', `hasTraceSupply:${unit.id}`)

  const firstTurn = input.firstTurnOutOfSupply
  // 12.8e：「……战斗单位（**非战斗单位除外**）」；首回合豁免时「运输点数**也**允许进行突围」
  if (!unit.isCombat && !(firstTurn && unit.isTransportPoint))
    return fail('12.8e', `nonCombatUnitCannotBreakout:${unit.id}`)
  // 12.8e：「印刷的 MA 至少为 1」
  if (unit.moveMa < BREAKOUT_MIN_PRINTED_MA)
    return fail('12.8e', `printedMaBelowMinimum:${unit.id}:${unit.moveMa}`)

  const drm = firstTurn ? BREAKOUT_FIRST_TURN_DRM : 0

  // 12.8e：「上述条件将被免除，且成功概率会提高，即获得 +1 的掷骰修正」
  if (firstTurn) {
    return succeed('12.8e', {
      firstTurn: true,
      drm,
      rule: '12.8e',
      detail: `断补首回合：免除 12.8e-A/B 两项条件，突围掷骰 +${drm}`,
    })
  }

  if (input.conditions === undefined) return fail('12.8e', `conditionsNotEvaluated:${unit.id}`)

  // 条件 A：到有追溯补给的友方单位的可用路径
  const path = input.conditions.path
  if (path.hasEnemyCombatUnit) return fail('12.8e', `pathHasEnemyCombatUnit:${unit.id}`)
  if (path.hasProhibitedTerrain) return fail('12.8e', `pathHasProhibitedTerrain:${unit.id}`)
  // ★ 12.8e-A 末句：「**如果是轮式 MP 单位**，这条路径上还必须没有未被抵消的 EZOC」
  if (path.mobility === 'truck' && path.hasUnnegatedEzoc)
    return fail('12.8e', `pathHasUnnegatedEzocForWheeled:${unit.id}`)

  // 条件 B：15 格（含）内有拥有追溯补给的友方**战斗**单位
  const distance = input.conditions.nearestTracedCombatFriendDistance
  if (distance === null || distance > BREAKOUT_RANGE_HEXES)
    return fail(
      '12.8e',
      `noTracedCombatFriendWithinRange:${unit.id}:${distance === null ? 'none' : distance}`,
    )

  return succeed('12.8e', {
    firstTurn: false,
    drm,
    rule: '12.8e',
    detail:
      `12.8e-A/B 均满足：路径可用（无敌方战斗单位、无禁入地形` +
      `${path.mobility === 'truck' ? '、无未被抵消的 EZOC' : ''}）；` +
      `最近有追溯补给的友方战斗单位 ${distance} 格 ≤ ${BREAKOUT_RANGE_HEXES} 格`,
  })
}

/* ────────────────────────────── 突围掷骰（12.8e） ────────────────────────────── */

/** 突围掷骰结果 */
export interface BreakoutAttemptResult {
  rule: string
  /** 掷骰修正（断补首回合 +1，否则 0） */
  drm: number
  /** 原始骰值（1d6） */
  die: number
  /** 修正后的骰值（原始 + DRM） */
  modifiedDie: number
  /** 12.8e：修正后 5–6 为成功 */
  success: boolean
  /** 失败 ⇒ 进入死亡堆（可正常重建）；成功 ⇒ 离图、日后作为增援返回 */
  disposition: 'deadPile' | 'returnAsReinforcement'
  /** 12.8e 末段：返回时**保留**所有军力损失标记 */
  keepsStepLosses: boolean
  /** 12.8e 末段：返回时**失去**所有其他标记（弹药不足、DG 等） */
  clearsOtherMarkers: boolean
  detail: string
}

/**
 * 12.8e：一次突围掷骰（1d6 + 首回合 DRM）
 *
 * 骰值由调用方从 `engine/rng.ts` 掷出后传入（本模块不含随机，CODE_SPEC §3.3）。
 * 1–4 失败（进死亡堆）；5–6 成功（离图、作为增援返回）——成功者**须再掷一次**决定返场回合
 * （见 `resolveBreakoutReturn`）。
 *
 * @throws RangeError 骰值不是 1–6 的整数（与 battle.ts 的骰值校验同口径）
 */
export function resolveBreakoutAttempt(input: {
  /** 1d6 */
  die: number
  /** 12.8e：是否为断补首回合（+1 DRM） */
  firstTurnOutOfSupply: boolean
}): BreakoutAttemptResult {
  if (!Number.isInteger(input.die) || input.die < 1 || input.die > DIE_FACES)
    throw new RangeError(`[breakout] 突围骰应为 1–${DIE_FACES} 的单骰，收到 ${input.die}`)

  const drm = input.firstTurnOutOfSupply ? BREAKOUT_FIRST_TURN_DRM : 0
  const modifiedDie = input.die + drm
  const success = modifiedDie >= BREAKOUT_SUCCESS_MIN_DICE
  const rollText = `1d6 ${input.die}${drm === 0 ? '' : ` +${drm}`} = ${modifiedDie}`
  return {
    rule: '12.8e',
    drm,
    die: input.die,
    modifiedDie,
    success,
    disposition: success ? 'returnAsReinforcement' : 'deadPile',
    keepsStepLosses: success,
    clearsOtherMarkers: success,
    detail: success
      ? `突围成功（${rollText} ≥ ${BREAKOUT_SUCCESS_MIN_DICE}）：离图并作为增援返回；须再掷 1 骰决定返场回合`
      : `突围失败（${rollText} < ${BREAKOUT_SUCCESS_MIN_DICE}）：单位进入死亡堆（可正常重建）`,
  }
}

/* ────────────────────────────── 返场回合（12.8e） ────────────────────────────── */

/** 返场回合结论 */
export interface BreakoutReturnResult {
  rule: string
  /** 12.8e：返场回合号 ＝ 当前回合 + 返回骰 */
  returnsOnTurn: number
  /** 给出回合轨末回合时报告是否越出轨外（轨外即本剧本内不再返场；本模块**不擅自夹取**） */
  beyondLastTurn: boolean | null
  detail: string
}

/**
 * 12.8e：成功突围者的返场回合
 *
 * 「为每个成功的单位**再掷一次骰子**：从当前回合向后数掷骰结果的回合数，它会在未来的这个回合返回。」
 *
 * ★ 不夹取：若「当前回合 + 返回骰」超出回合轨（越出剧本），则本剧本内不会返场；
 *   给出 `lastTurn` 时另报 `beyondLastTurn` 供调用方提示，但返回号仍按原式给出。
 *
 * @throws RangeError 骰值不是 1–6 的整数，或当前回合号不是 ≥1 的整数
 */
export function resolveBreakoutReturn(input: {
  /** 2.2 回合轨：当前回合号 */
  currentTurn: number
  /** 12.8e：为每个成功单位再掷的骰（1d6） */
  returnDie: number
  /** 可选：回合轨末回合（仅用于报告是否越出轨外） */
  lastTurn?: number
}): BreakoutReturnResult {
  if (!Number.isInteger(input.returnDie) || input.returnDie < 1 || input.returnDie > DIE_FACES)
    throw new RangeError(`[breakout] 返场骰应为 1–${DIE_FACES} 的单骰，收到 ${input.returnDie}`)
  if (!Number.isInteger(input.currentTurn) || input.currentTurn < 1)
    throw new RangeError(`[breakout] 当前回合号应为 ≥1 的整数，收到 ${input.currentTurn}`)

  const returnsOnTurn = input.currentTurn + input.returnDie
  const beyondLastTurn = input.lastTurn === undefined ? null : returnsOnTurn > input.lastTurn
  return {
    rule: '12.8e',
    returnsOnTurn,
    beyondLastTurn,
    detail:
      `返场回合 = 当前回合 ${input.currentTurn} + 返回骰 ${input.returnDie} = ${returnsOnTurn}` +
      (beyondLastTurn === true
        ? `（超出回合轨末 ${input.lastTurn} ⇒ 本剧本内不再返场）`
        : '；返回时保留军力损失标记，清除其他标记（12.8e）'),
  }
}

/* ────────────────────────────── 一次完整结算（12.8e 两掷） ────────────────────────────── */

/** 一次完整突围结算的结果 */
export interface BreakoutResolution {
  /** 突围掷骰（1–4 失败进死亡堆 / 5–6 成功离图） */
  attempt: BreakoutAttemptResult
  /** 成功且已掷返场骰时的返场结论；失败时为 null */
  returnInfo: BreakoutReturnResult | null
  /** 成功但尚未给返场骰 ⇒ 须**再掷一次**（12.8e：为每个成功的单位再掷一次骰子） */
  pendingReturnDie: boolean
}

/**
 * 12.8e：一次完整的突围结算（突围掷骰 → 成功者再掷返场骰）
 *
 * 把条文里的两掷合成一次调用，避免调用方在成功时**漏掷返场骰**（规则是必掷）。
 * 若已成功却未给 `returnDie`，则返回 `pendingReturnDie: true` 并要求重入
 * （与 C6 奇袭须再掷横移骰同规：不前进、不抛错）。
 *
 * @throws RangeError 骰值越界时（口径同 `resolveBreakoutAttempt` / `resolveBreakoutReturn`）
 */
export function resolveBreakout(input: {
  /** 突围骰（1d6） */
  die: number
  /** 12.8e：是否为断补首回合（+1 DRM） */
  firstTurnOutOfSupply: boolean
  /** 2.2 回合轨：当前回合号（成功返场时用） */
  currentTurn: number
  /** 12.8e：成功者须再掷的返场骰（1d6）；未给则回 `pendingReturnDie` */
  returnDie?: number
  /** 可选：回合轨末回合（仅用于报告是否越出轨外） */
  lastTurn?: number
}): BreakoutResolution {
  const attempt = resolveBreakoutAttempt({
    die: input.die,
    firstTurnOutOfSupply: input.firstTurnOutOfSupply,
  })
  // 失败：进死亡堆，无返场掷骰（12.8e 第一条）
  if (!attempt.success) return { attempt, returnInfo: null, pendingReturnDie: false }
  // 成功但未给返场骰：停在「须再掷一次」（12.8e 第二条）
  if (input.returnDie === undefined) return { attempt, returnInfo: null, pendingReturnDie: true }
  return {
    attempt,
    returnInfo: resolveBreakoutReturn({
      currentTurn: input.currentTurn,
      returnDie: input.returnDie,
      ...(input.lastTurn === undefined ? {} : { lastTurn: input.lastTurn }),
    }),
    pendingReturnDie: false,
  }
}
