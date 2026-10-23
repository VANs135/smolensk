import { fail, succeed, type RuleOutcome } from '../result-types'

/**
 * NKVD 边防团（Smolensk 专规 2.3b）
 *
 * ## 条文原文（专规 2.3b，ch02 引录）
 *   「**NKVD Border Regiment（2.3b）**：被攻击时**必须**担任 **行动值单位**；
 *     代价是**所有防御选项都须当作损失吃下**（包括本可因攻方撤退而抵消的选项）。」
 *
 *   ch02 的伪代码给出验收口径：
 *   ```
 *   function nkvdDefend(hex):          # 2.3b
 *       if hex.has(NKVD_Border_Regiment):
 *           assert NKVD_Border_Regiment.isARUnit()
 *           takeAllDefenderOptionsAsLosses()   # 含本可抵消的选项
 *   ```
 *
 * ## 实现口径（与数据层对接）
 *   - 判据是数据层的能力标签：工程数据库 `units.json` 里 NKVD 边防团的
 *     `special_abilities: ["nkvd_border_forced_roll"]`（3 个：38 / 86 / 105 NKVD Bdr Rgt，
 *     印值 `(2)-4-3`、`rebuildable: false`）。本模块只认该标签，**不按番号/国别推定**。
 *   - 本模块**不改 `combat-interaction.ts` 的签名**：它以「前置裁定 + 强制输入」的形式
 *     与 9.2 九步流程配合——调用方在「宣布 AR」（9.6）与「结算守方选项」（9.10）两步前调用本模块。
 */

/** NKVD 边防团的强制行动值能力标签（工程数据库 special_abilities 原文） */
export const NKVD_BORDER_CAPABILITY = 'nkvd_border_forced_roll'

/** 2.3b：参与防御的单位视图（只取判定所需字段） */
export interface NkvdDefenseUnitView {
  id: string
  /** 数据层能力标签（`special_abilities`，见 units.schema 的 specialAbilities） */
  specialAbilities?: readonly string[] | null
  /** 数据层规则化分类（部分记录把能力放在 specialized 里） */
  specialized?: readonly string[] | null
}

/** 2.3b：该单位是否 NKVD 边防团（判据 = 能力标签，不按番号） */
export function isNkvdBorderRegiment(unit: NkvdDefenseUnitView): boolean {
  const pools = [unit.specialAbilities ?? [], unit.specialized ?? []]
  return pools.some((tags) => tags.includes(NKVD_BORDER_CAPABILITY))
}

/**
 * 2.3b：该防御堆叠中**必须**担任行动值单位的单位
 *
 * 若堆叠内有多个 NKVD 边防团，只要其中之一担任即可（条文只说「必须担任」），
 * 故返回全部候选，由玩家择一。
 */
export function forcedDefenderArCandidates(
  defenders: readonly NkvdDefenseUnitView[],
): readonly NkvdDefenseUnitView[] {
  return defenders.filter(isNkvdBorderRegiment)
}

/** 2.3b：守方本场战斗是否受「强制担任行动值单位」约束 */
export function nkvdArRequired(defenders: readonly NkvdDefenseUnitView[]): boolean {
  return forcedDefenderArCandidates(defenders).length > 0
}

/**
 * 2.3b：校验守方的行动值单位选择（9.6 的守方一步）
 *
 * - 堆叠内有 NKVD 边防团时，所选单位**必须**是其中之一（否则违反 2.3b）；
 * - 堆叠内没有则放行（返回 `forced: false`）。
 */
export function checkDefenderArChoice(
  defenders: readonly NkvdDefenseUnitView[],
  chosenUnitId: string,
): RuleOutcome<{ forced: boolean }> {
  const candidates = forcedDefenderArCandidates(defenders)
  if (candidates.length === 0) return succeed('2.3b', { forced: false })
  if (!candidates.some((unit) => unit.id === chosenUnitId)) {
    return fail(
      '2.3b',
      `nkvdMustBeArUnit:${chosenUnitId}∉[${candidates.map((unit) => unit.id).join(',')}]`,
    )
  }
  return succeed('2.3b', { forced: true })
}

/** 2.3b：守方选项的强制分配（全部选项点吃成军力损失，**不许撤退**） */
export interface NkvdForcedOptionChoice {
  /** 撤退格数恒为 0（2.3b：不得用撤退抵消选项） */
  retreatHexes: 0
  /** 以军力损失满足的选项点数 = 全部选项点 */
  lossPoints: number
  rule: '2.3b'
  detail: string
}

/**
 * 2.3b：守方选项的强制分配
 *
 * 「所有防御选项都须当作损失吃下」⇒ 撤退格数 0、损失点数 = 该方全部选项点。
 * 同时意味着 9.10c 的「忽略选项」权利**不适用**（见 `defenderMayIgnoreOptionsUnderNkvd`）。
 */
export function forcedDefenderOptionChoice(points: number): NkvdForcedOptionChoice {
  const lossPoints = Math.max(0, Math.trunc(points))
  return {
    retreatHexes: 0,
    lossPoints,
    rule: '2.3b',
    detail:
      `NKVD 边防团担任行动值单位（2.3b）：守方的全部 ${lossPoints} 点选项**必须**吃成军力损失、` +
      `不得撤退，**包括本可因攻方撤退而抵消的选项**`,
  }
}

/**
 * 2.3b：NKVD 担任行动值单位时，守方**不得**行使 9.10c 的「忽略选项」权利
 *
 * 9.10c 的原意是「攻方撤退或未能完成选项时守方可忽略自己的选项」——而 2.3b 明写
 * 「包括本可因攻方撤退而抵消的选项」，故该权利在此被专规排除。
 */
export function defenderMayIgnoreOptionsUnderNkvd(): false {
  return false
}

/**
 * 2.3b：一步到位的守方选项裁定
 *
 * 若堆叠内有 NKVD 边防团（且它是守方宣布的行动值单位）⇒ 返回强制分配；
 * 否则返回 null（调用方按 9.10 的常规规则收玩家输入）。
 */
export function nkvdDefenderOptionOverride(input: {
  /** 守方本场战斗宣布的行动值单位 id */
  defenderArUnitId: string
  defenders: readonly NkvdDefenseUnitView[]
  /** 该方在 CRT 结果里的选项点数（`o#`） */
  optionPoints: number
}): NkvdForcedOptionChoice | null {
  const candidates = forcedDefenderArCandidates(input.defenders)
  if (candidates.length === 0) return null
  if (!candidates.some((unit) => unit.id === input.defenderArUnitId)) return null
  return forcedDefenderOptionChoice(input.optionPoints)
}
