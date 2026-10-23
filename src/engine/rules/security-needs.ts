import type { HexRef } from '@/data'

import { succeed, type RuleOutcome } from '../result-types'

/**
 * 治安需求（Smolensk 专规 3.3b，轴方）
 *
 * ## 条文原文（ch03 引录）
 *   「**Security Needs 框架（3.3b）**：轴心国控制的城市格（按 5.0c 定义）应由一个 **Attack-Capable**
 *     单位占据或被 **ZOC** 覆盖；否则在该格放一个苏军 **Trainbusting** 标记（代表游击队活动）。
 *     标记可在**任意相位**放置；在**任意 Clean Up Phase**，若安全需求满足或该城转为苏军控制则移除。」
 *
 * ## 实现口径
 *   - 本模块只判「该格现在是否需要标记 / 该标记现在是否该移除」，不写状态；
 *   - 「城市格」由调用方按产品数据给出（map-layers 的 `city` 字段 + 5.0c 的控制判定）；
 *   - Trainbusting 标记的**效果**（移动/铁路惩罚）不在本模块——它属 10.0 / 13.x 的取表；
 *     本作已有的标记表见 `markers.json`（`trainbusting`）。
 */

/** 3.3b：一枚 Trainbusting 标记的状态视图（由调用方持有） */
export interface TrainbustingMarkerView {
  id: string
  hex: HexRef
  /** 放置方恒为苏军（3.3b） */
  side: 'soviet'
}

/** 3.3b：一座轴方控制城市的治安检查输入 */
export interface SecurityCheckCityView {
  hex: HexRef
  /** 城市名（日志用；产品数据 map-layers 的 `city.name`） */
  name?: string
  /** 5.0c：该城当前由**轴心国**控制 */
  controlledByAxis: boolean
  /** 该城是否由**可攻击单位**占据（3.3b 条件①） */
  occupiedByAttackCapable: boolean
  /** 该城是否被轴心国 **ZOC** 覆盖（3.3b 条件②；4.5 的投射 ZOC） */
  coveredByAxisZoc: boolean
  /** 该城是否已有一枚 Trainbusting 标记 */
  hasTrainbusting: boolean
}

/** 3.3b：治安检查结论 */
export interface SecurityNeedsResult {
  /** 需要**新放**标记的城（需求未满足且尚无标记） */
  placeAt: readonly HexRef[]
  /** 需要**移除**标记的城（需求已满足 ⇒ 清理阶段移除） */
  removeAt: readonly HexRef[]
  rule: string
  detail: string
}

/**
 * 3.3b：治安需求检查（可在任意相位调用做放置判定）
 *
 * - 需求未满足（既无可攻击单位占据、也无 ZOC 覆盖）且尚无标记 ⇒ 需在该格**放置**一枚；
 * - 需求已满足（或有标记但城已转苏控）⇒ 需在该格**移除**标记。
 *
 * 「标记可在**任意相位**放置」⇒ `placeAt` 不判相位；
 * 「在**任意 Clean Up Phase**」⇒ 移除由调用方只在清理阶段执行（见 `removalAllowedNow`）。
 */
export function checkSecurityNeeds(
  cities: readonly SecurityCheckCityView[],
): RuleOutcome<SecurityNeedsResult> {
  const placeAt: HexRef[] = []
  const removeAt: HexRef[] = []

  for (const city of cities) {
    // 非轴控城市不属于 3.3b 的「占城税」范围（含已转苏控者 ⇒ 其标记应移除）
    if (!city.controlledByAxis) {
      if (city.hasTrainbusting) removeAt.push(city.hex)
      continue
    }
    const needsMet = city.occupiedByAttackCapable || city.coveredByAxisZoc
    if (!needsMet) {
      if (!city.hasTrainbusting) placeAt.push(city.hex)
    } else if (city.hasTrainbusting) {
      removeAt.push(city.hex)
    }
  }

  return succeed('3.3b', {
    placeAt,
    removeAt,
    rule: '3.3b',
    detail:
      `治安需求（3.3b）：${cities.length} 座轴控城市中，需放标记 ${placeAt.length} 处、需移除 ${removeAt.length} 处` +
      `（城市须由可攻击单位占据或被 ZOC 覆盖，否则放苏军 Trainbusting 标记；满足或转苏控即移除）`,
  })
}

/**
 * 3.3b：标记的**移除**只在 Clean Up Phase 进行
 *
 * 「在**任意 Clean Up Phase**，若安全需求满足或该城转为苏军控制则移除」⇒ 其它阶段不移除。
 */
export function removalAllowedNow(phase: string): boolean {
  return phase === 'cleanUp'
}

/**
 * 3.3b：标记被移除的两个理由（与 `checkSecurityNeeds` 一致，供日志/界面用）
 */
export type TrainbustingRemovalReason = 'securityNeedsMet' | 'citySovietControlled'

/** 3.3b：为何移除这枚标记（返回 null 表示不该移除） */
export function removalReasonOf(city: SecurityCheckCityView): TrainbustingRemovalReason | null {
  if (!city.controlledByAxis) return 'citySovietControlled'
  if (city.occupiedByAttackCapable || city.coveredByAxisZoc) return 'securityNeedsMet'
  return null
}
