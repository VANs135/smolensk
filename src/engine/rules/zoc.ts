import type { HexRef, Side } from '@/data'

import { areAdjacent, HEX_DIRECTIONS, isOnMap, neighbor, sameHex } from '../hex-geometry'
import type { MobilityType } from './terrain'

/**
 * 控制区 ZOC（4.4b / 4.5）
 *
 * 条文出处：源库 `series_rules_v43.movement.zoc`（通规 4.4b/4.5）——
 *   - **投射条件**：`attack-capable units in Combat Mode with trace supply`
 *     （可攻击单位 + 战斗模式 + 有追溯补给，三者齐备才投射 ZOC）
 *     规则书原文为「Attack-Capable units in Combat Mode have a ZOC **unless currently
 *     marked Out of Supply**；Units in other modes do not have a ZOC」——「未断补」即
 *     `hasTraceSupply`（本引擎以追溯补给判定补给状态，见 12.6 / 12.8）。
 *   - **5.9c 进击模式**：原文「Units retain any ZOC they had before gaining the Exploit marker」
 *     （进击标记只**保持**既有 ZOC，不新给也不剥夺）。故 `exploit` 标志不影响本判定，
 *     只由 `mode`（进击单位保留原战斗/移动朝向，5.9）决定——本模块**无须**读 exploit。
 *   - **投射范围**：`A unit's ZOC limits enemy actions in the six hexes adjacent to the unit.
 *     This is true regardless of the terrain in those hexes or the hexsides between them.`
 *     （4.5：六邻格无地形/格边豁免）
 *   - **移动后果**：`wheel_mp: must stop or overrun`；`leg_track_mp: unaffected`
 *     （轮式进入敌方 ZOC 必须停止或突袭；徒步与履带不受此限）
 *   - **抵消**：`friendly combat unit in hex cancels, that unit forfeits further MP`
 *     （格内己方战斗单位可抵消该格敌方 ZOC，代价是该单位丧失后续 MP）
 *
 * 相关引用（同一 ZOC 概念在别章的用法，本模块只提供判定原语）：
 *   - 4.5a：敌方 ZOC 内禁止的动作清单（A 轮式移动 / B 补给线 / C 铁路运输 /
 *     D 铁路追溯补给 / E 轨道转换 / F 港口追溯 / G 港口海运 / H 飞机整备 / I 预备模式）；
 *     其中标记 <Negation> 者可按 4.5b 抵消，其余**不可**抵消——各动作的合法性由所属章节实现
 *   - 12.6b：补给源格内有敌方 ZOC 则取不到追溯补给（可按 4.5b 抵消）
 *   - 13.3e：装车点（entrain）不得在敌方 ZOC
 *   - 3.3b：治安需求以「占领或 ZOC 覆盖」判定
 *   - 4.5b：单位在敌方 ZOC 中**开始**该阶段时，离开该格无需抵消
 *
 * 源库未列的 ZOC 例外（如城市/工事内单位是否投射）**不予臆造**：条文没写就不加。
 */

/**
 * ZOC 投射单位（引擎侧最小视图）
 *
 * 注意 `inCombatMode` 是**已裁定的结论**，不是原始模式字段：
 * 模式判定（进击保留基础模式 5.9c、预备释放后回基础模式 5.7b、DG 不是战斗模式 5.4a、
 * 预备/战略一律非战斗模式 4.5）统一由 modes.ts 的 `exertsZoc` 给出，
 * 本模块不再自行从模式字段推导——避免两处判据漂移（该错法会让「进击的战斗面单位」漏掉 ZOC）。
 */
export interface ZocSource {
  /** 所在格 */
  hex: HexRef
  /** 归属方 */
  side: Side
  /** 是否可攻击（有攻击值；3.1 / 9.4） */
  attackCapable: boolean
  /** 是否**处于战斗模式**（4.5）：由 modes.exertsZoc 裁定后传入 */
  inCombatMode: boolean
  /** 是否有追溯补给（12.6；断补单位不投射 ZOC，4.5） */
  hasTraceSupply: boolean
}

/**
 * 是否为 ZOC 投射单位（4.5）
 *
 * 4.5：「**战斗模式下的**可攻击单位拥有 ZOC，除非单位当前被标记为断补。其他模式下的单位没有 ZOC
 *      （例外：进击模式 5.9c）。」故三个条件缺一不可：可攻击 ∧ 处于战斗模式 ∧ 非断补。
 * 「是否处于战斗模式」含 **进击保留基础模式**（5.9c）与 **DG 不是战斗模式**（★ 用户裁定）。
 */
export function projectsZoc(source: ZocSource): boolean {
  return source.attackCapable && source.inCombatMode && source.hasTraceSupply
}

/**
 * 某格是否处于 `enemySide` 的敌方 ZOC 内（4.5）
 *
 * ZOC 覆盖投射单位**相邻的六格**（不含其自身所在格），且**不论那些格的地形与格边为何**
 * （4.5 原文：regardless of the terrain in those hexes or the hexsides between them）。
 *
 * @param options.friendlyCombatUnitInHex 4.5b 抵消：该格当下有己方战斗单位（任何模式皆可，
 *        且该单位自身不必投射 ZOC），且**该抵消者本阶段不再消耗 MP**（可用战后推进/突围等不耗 MP
 *        的方式离格）。「不再消耗 MP」由移动规则施加，本判定只取「格内有己方战斗单位」这一事实。
 */
export function isInEnemyZoc(
  hex: HexRef,
  enemySide: Side,
  sources: readonly ZocSource[],
  options: { friendlyCombatUnitInHex?: boolean } = {},
): boolean {
  if (options.friendlyCombatUnitInHex === true) return false

  return sources.some(
    (source) => source.side === enemySide && projectsZoc(source) && areAdjacent(source.hex, hex),
  )
}

/**
 * 某方 ZOC 覆盖的格集合（4.5；供界面高亮与批量判定）
 *
 * 只收**图内**格（图外盒/边缘盒不在图内，ZOC 无意义）；同一格被多单位覆盖只出现一次。
 */
export function zocHexes(sources: readonly ZocSource[], side: Side): HexRef[] {
  const covered: HexRef[] = []
  for (const source of sources) {
    if (source.side !== side || !projectsZoc(source)) continue
    for (const direction of HEX_DIRECTIONS) {
      const hex = neighbor(source.hex, direction)
      if (!isOnMap(hex)) continue
      if (!covered.some((existing) => sameHex(existing, hex))) covered.push(hex)
    }
  }
  return covered
}

/**
 * 进入敌方 ZOC 后的移动后果（4.4b）
 *
 * - `mustStopOrOverrun` 轮式：必须停止或突袭
 * - `unaffected`        徒步 / 履带：不受此限
 *
 * 铁路移动另受 13.3e（装车点不得在敌方 ZOC）约束，故不在此函数取值域内。
 */
export type ZocEntryEffect = 'mustStopOrOverrun' | 'unaffected'

/** 按移动类型给出进入敌方 ZOC 的后果（4.4b） */
export function zocEntryEffect(mobility: MobilityType): ZocEntryEffect {
  return mobility === 'truck' ? 'mustStopOrOverrun' : 'unaffected'
}
