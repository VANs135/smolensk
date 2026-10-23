import { rulesConstants } from '@/data'

/**
 * 天气判定（Smolensk 专规 1.5 / OCS 17.0）
 *
 * 本作地面条件恒好，仅空中作战有 Limited/Normal 两档：
 * - 掷 1 骰，1 = Limited Flight，2–6 = Normal Flight
 * - Limited Flight 下：空军任务不可在 Reaction / Exploitation 阶段执行（仅 Movement）；
 *   Hip Shoot 不可执行。
 *
 * 注意：苏联空军另有专规 2.2「Red Air Force」的**常驻**限制（与天气无关），
 * 由 engine/rules/air.ts 按型别数据判定（canHipShoot / canMissionInPhase）——
 * 本模块只负责天气层，二者须同时满足。
 */

/** 天气结果：空中条件 + 地面条件 */
export interface WeatherResult {
  air: 'normal' | 'limited'
  ground: 'good'
  /** 是否受限飞行 */
  isLimited: boolean
  /** 原始骰面值（供日志/UI 展示） */
  die: number
}

/**
 * 天气表掷骰解析
 *
 * 输入 1d6 值，返回规范化天气结果。超出 1–6 范围抛 RangeError。
 */
export function resolveWeather(die: number): WeatherResult {
  if (!Number.isInteger(die) || die < 1 || die > 6) {
    throw new RangeError(`天气骰面值必须是 1–6 的整数，收到 ${die}`)
  }

  const limited = die <= rulesConstants.smolensk.weather.limitedFlightMaxDice
  return {
    air: limited ? 'limited' : 'normal',
    ground: 'good',
    isLimited: limited,
    die,
  }
}

/**
 * 阶段合法性查询（Limited Flight 下任务阶段约束）
 *
 * Limited Flight 时仅 Movement Phase 允许空军任务；Reaction / Exploitation 不可。
 * Normal Flight 时所有阶段均可（受其他规则约束除外）。
 *
 * ★ 注：本条是**天气维度**的闸门，与 `air.ts#canMissionInPhase`（**专规维度**：苏军不得在
 *   反应/进击阶段执行任务，专规 2.2c）是**两条不同的规则**，两者都必须过（不得互相替代）。
 */
export type AirPhase = 'movement' | 'reaction' | 'exploitation' | 'planning' | 'strategic'

/** Limited Flight 下不可执行任务的阶段集 */
const LIMITED_FLIGHT_BLOCKED_PHASES: readonly AirPhase[] = ['reaction', 'exploitation']

/** Limited Flight 下指定阶段是否允许空军任务（入参只取 `isLimited`，故调用方无需构造完整天气结论） */
export function isAirMissionAllowedInPhase(
  weather: { isLimited: boolean },
  phase: AirPhase,
): boolean {
  if (!weather.isLimited) return true
  return !LIMITED_FLIGHT_BLOCKED_PHASES.includes(phase)
}
