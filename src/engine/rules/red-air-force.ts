import { rulesConstants } from '@/data'
import type { Side } from '@/data'

import { fail, succeed, type RuleOutcome } from '../result-types'
import {
  canHipShoot,
  canMissionInPhase,
  canPlannedAirdrop,
  isEarlySturmovikOneStep,
  type AircraftAirProfile,
  type AirMissionKind,
  type AirMissionPhase,
} from './air'

/**
 * 赤色空军限制（Smolensk 专规 2.2，苏方）
 *
 * ## 条文原文（ch02 引录，表 2-4）
 *   「**Red Air Force 限制框架（2.2）**：四条硬约束
 *     · **2.2a** 不能 **hip shoot**（低空扫射）；
 *     · **2.2b** 允许**补给空投**，但不允许**需计划的空降任务**（OCS 14.10b）；
 *     · **2.2c** Early Sturmoviks：**IL.2 只有一步**；
 *     · **2.2d** Lack of Responsiveness：**不能在本方 Reaction 或 Exploitation Phase 出击**。」
 *   轴方的对应条款是 **3.2a**：「**天气允许时**，轴方空军**可以**执行低空扫射」——
 *   这是本作空中力量不对称的关键一条（苏方被明文禁止，德方可在天气许可时使用）。
 *
 * ## 实施口径
 *   - 本模块是**统一入口**：把 14.x 的通用判据（`canHipShoot` / `canMissionInPhase` /
 *     `canPlannedAirdrop` / `isEarlySturmovikOneStep`，唯一实现在 `air.ts`）与专规 2.2 的四条
 *     合成一次检查，避免各调用点各判一遍导致口径漂移；
 *   - 2.2c 的「只有一步」是**上限**（不是否决）：返回 `effectiveSteps` 供调用方按上限落值；
 *   - 天气层（Limited Flight 下 Reaction / Exploitation 禁飞）在 `weather.ts`，本模块只管阵营层。
 */

/** 2.2 的四条限制（机器可读清单，供界面/日志逐条展示） */
export const RED_AIR_FORCE_LIMITS = ['2.2a', '2.2b', '2.2c', '2.2d'] as const
export type RedAirForceLimit = (typeof RED_AIR_FORCE_LIMITS)[number]

/**
 * 2.2c / 2.2d：Early Sturmovik 的军力上限（「只有一步」）
 *
 * ★ 判据只有一处：**专规数据**的开关 `rulesConstants.smolensk.air.soviet.il2SingleStep`
 *   （源：`rules.json` 的 `exclusive_rules_smolensk.soviet_special.air.IL2_single_step`，条文 2.2）。
 *   修前这里是**裸字面量 `1`** ⇒ 数据里那条开关**被架空**（改数据而引擎行为不变）——
 *   正是第三批方案 §2.1 A-3 登记的那一类"同一规则两个来源"。
 *   本作数据设定为「单军力」⇒ 上限 1；若数据改为 `false`（不启用该限制）⇒ **不设上限**。
 */
export const EARLY_STURMOVIK_STEPS = rulesConstants.smolensk.air.soviet.il2SingleStep
  ? 1
  : Number.POSITIVE_INFINITY

/**
 * 空军任务类别
 *
 * 与 `air.ts` 的 `AirMissionKind` 是**同一个类型**（唯一实现在 `air.ts`）；
 * 本模块只按值分支（2.2a 看 `hip_shoot`、2.2b 看 `air_drop`），不另立枚举以免口径漂移。
 */
export type RedAirMissionKind = AirMissionKind

/** 2.2 / 3.2a：一次空军任务的阵营层检查输入 */
export interface RedAirForceMissionInput {
  side: Side
  /** 任务阶段（14.1g 的 movement / reaction / exploitation） */
  phase: AirMissionPhase
  /** 天气是否正常（3.2a：轴方 hip shoot 须天气允许） */
  weatherNormal: boolean
  missionKind: RedAirMissionKind
  /** 机型资料（判 2.2c 的 Early Sturmovik） */
  profile?: AircraftAirProfile
  /** 该任务的飞机当前军力（用于 2.2c 的封顶） */
  steps?: number
  /** 2.2b：该任务是否属于「需计划的空降」 */
  requiresPlan?: boolean
}

/** 2.2 / 3.2a 的检查结论 */
export interface RedAirForceCheckResult {
  /** 生效的限制条款（苏方适用到的那几条） */
  appliedLimits: readonly RedAirForceLimit[]
  /** 2.2c：按上限折算后的军力（无上限时原样返回） */
  effectiveSteps: number | null
  rule: string
  detail: string
}

/**
 * 2.2（苏）/ 3.2a（轴）：空军任务的阵营层限制
 *
 * 判定顺序：① 阶段（2.2d 苏方；14.1g 的通用三段限制由调用方在 `assignAirMission` 判）
 * → ② 低空扫射（2.2a 苏方禁止 / 3.2a 轴方须天气允许）→ ③ 需计划的空降（2.2b 苏方禁止）
 * → ④ Early Sturmovik 单军力（2.2c，只封顶不否决）。
 */
export function checkRedAirForceMission(
  input: RedAirForceMissionInput,
): RuleOutcome<RedAirForceCheckResult> {
  const appliedLimits: RedAirForceLimit[] = []

  if (input.side === 'soviet') {
    // 2.2d：不能在本方反应 / 进击阶段出击
    if (!canMissionInPhase('soviet', input.phase)) {
      appliedLimits.push('2.2d')
      return fail('2.2d', `sovietNoReactionOrExploitationMission:${input.phase}`)
    }
  }

  // 2.2a（苏）/ 3.2a（轴）：低空扫射
  if (input.missionKind === 'hip_shoot') {
    if (input.side === 'soviet') {
      appliedLimits.push('2.2a')
      if (!canHipShoot('soviet', input.weatherNormal)) return fail('2.2a', 'sovietNoHipShoot')
    } else if (!canHipShoot('axis', input.weatherNormal)) {
      return fail('3.2a', 'axisHipShootRequiresPermittingWeather')
    }
  }

  // 2.2b：允许补给空投，但不允许需计划的空降
  if (input.side === 'soviet' && input.missionKind === 'air_drop' && input.requiresPlan === true) {
    appliedLimits.push('2.2b')
    if (!canPlannedAirdrop('soviet', input.profile)) return fail('2.2b', 'sovietNoPlannedAirdrop')
  }

  // 2.2c：Early Sturmovik 只有一步（上限，不否决）
  let effectiveSteps: number | null = null
  if (
    input.steps !== undefined &&
    input.profile !== undefined &&
    isEarlySturmovikOneStep(input.profile)
  ) {
    appliedLimits.push('2.2c')
    effectiveSteps = Math.min(input.steps, EARLY_STURMOVIK_STEPS)
  }

  return succeed('2.2', {
    appliedLimits,
    effectiveSteps,
    rule: '2.2',
    detail:
      (input.side === 'soviet' ? '苏方 Red Air Force 限制（2.2）' : '轴方空军（3.2a）') +
      '：' +
      [
        '2.2a 不得低空扫射（轴方 3.2a 天气允许时可用）',
        '2.2b 允许补给空投、不得需计划的空降',
        `2.2c Early Sturmovik（IL.2）军力上限 ${EARLY_STURMOVIK_STEPS}`,
        '2.2d 不得在反应 / 进击阶段出击',
      ].join('；') +
      (appliedLimits.length === 0
        ? '（本次任务未触发任何限制）'
        : `｜本次触发：${appliedLimits.join('、')}`) +
      (effectiveSteps === null ? '' : `｜军力按 2.2c 折算为 ${effectiveSteps}`),
  })
}

/**
 * 2.2c：按 Early Sturmovik 上限折算军力
 *
 * 「IL.2 只有一步」⇒ 无论印值几步，落到盘面最多 1 步；
 * 非 Early Sturmovik 机型原样返回（不臆造其它上限）。
 */
export function applyEarlySturmovikCap(profile: AircraftAirProfile, steps: number): number {
  const value = Math.max(0, Math.trunc(steps))
  return isEarlySturmovikOneStep(profile) ? Math.min(value, EARLY_STURMOVIK_STEPS) : value
}

/**
 * 2.2b：苏方的空投资格速查
 *
 * 「允许**补给空投**（不需计划），但不允许**需计划的空降任务**」⇒
 * `requiresPlan === false` 时始终允许；`true` 时恒为否（专规 2.2b）。
 */
export function sovietAirdropAllowed(requiresPlan: boolean): boolean {
  return !requiresPlan
}
