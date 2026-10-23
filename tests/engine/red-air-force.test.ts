import { describe, expect, it } from 'vitest'

import { rulesConstants } from '@/data'
import {
  EARLY_STURMOVIK_STEPS,
  RED_AIR_FORCE_LIMITS,
  applyEarlySturmovikCap,
  checkRedAirForceMission,
  sovietAirdropAllowed,
  type AircraftAirProfile,
} from '@/engine/rules'

/**
 * 赤色空军限制（Smolensk 专规 2.2 苏方 / 3.2a 轴方）
 *
 * 条文（ch02 表 2-4）：
 *   - **2.2a** 不能 hip shoot（低空扫射）；
 *   - **2.2b** 允许补给空投，但不允许需计划的空降任务（OCS 14.10b）；
 *   - **2.2c** Early Sturmoviks：IL.2 只有一步；
 *   - **2.2d** Lack of Responsiveness：不能在本方 Reaction 或 Exploitation Phase 出击。
 * 轴方对应条款 **3.2a**：「天气允许时，轴方空军**可以**执行低空扫射」。
 */

/** 工程库 IL.2 的能力位（aircraft.json：special_abilities 含 early_sturmovik_one_step） */
const IL2: AircraftAirProfile = {
  airAbilities: { canHipShoot: false, missionInReactionPhase: false, canAirDrop: false },
  specialAbilities: ['no_hip_shoots', 'early_sturmovik_one_step'],
}
/** 普通机型（无 2.2c 标记） */
const ORDINARY: AircraftAirProfile = { specialAbilities: [] }

describe('2.2：限制清单', () => {
  it('2.2：四条限制齐备（表 2-4）', () => {
    expect([...RED_AIR_FORCE_LIMITS]).toEqual(['2.2a', '2.2b', '2.2c', '2.2d'])
    expect(EARLY_STURMOVIK_STEPS).toBe(1)
  })
})

describe('2.2a（苏）/ 3.2a（轴）：低空扫射', () => {
  it('2.2a：苏军一律不得低空扫射（即使天气正常）', () => {
    for (const weatherNormal of [true, false]) {
      const outcome = checkRedAirForceMission({
        side: 'soviet',
        phase: 'movement',
        weatherNormal,
        missionKind: 'hip_shoot',
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.rule).toBe('2.2a')
        expect(outcome.reason).toBe('sovietNoHipShoot')
      }
    }
  })

  it('3.2a：轴方天气允许时可低空扫射；天气不允许则不得', () => {
    const ok = checkRedAirForceMission({
      side: 'axis',
      phase: 'movement',
      weatherNormal: true,
      missionKind: 'hip_shoot',
    })
    expect(ok.ok).toBe(true)

    const blocked = checkRedAirForceMission({
      side: 'axis',
      phase: 'movement',
      weatherNormal: false,
      missionKind: 'hip_shoot',
    })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.rule).toBe('3.2a')
      expect(blocked.reason).toBe('axisHipShootRequiresPermittingWeather')
    }
  })
})

describe('2.2b：允许补给空投、不得需计划的空降', () => {
  it('2.2b：苏军需计划的空降 ⇒ 拒', () => {
    const outcome = checkRedAirForceMission({
      side: 'soviet',
      phase: 'movement',
      weatherNormal: true,
      missionKind: 'air_drop',
      requiresPlan: true,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.rule).toBe('2.2b')
      expect(outcome.reason).toBe('sovietNoPlannedAirdrop')
    }
  })

  it('2.2b：苏军不需计划的补给空投 ⇒ 允许', () => {
    const outcome = checkRedAirForceMission({
      side: 'soviet',
      phase: 'movement',
      weatherNormal: true,
      missionKind: 'air_drop',
      requiresPlan: false,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.data.appliedLimits).toEqual([])
  })

  it('2.2b：速查函数与条文一致（需计划 ⇒ 否）', () => {
    expect(sovietAirdropAllowed(false)).toBe(true)
    expect(sovietAirdropAllowed(true)).toBe(false)
  })
})

describe('2.2d：苏军不得在反应 / 进击阶段出击', () => {
  it('2.2d：苏军在 reaction / exploitation 阶段 ⇒ 拒；movement 阶段 ⇒ 允许', () => {
    for (const phase of ['reaction', 'exploitation'] as const) {
      const outcome = checkRedAirForceMission({
        side: 'soviet',
        phase,
        weatherNormal: true,
        missionKind: 'barrage',
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.rule).toBe('2.2d')
    }
    const ok = checkRedAirForceMission({
      side: 'soviet',
      phase: 'movement',
      weatherNormal: true,
      missionKind: 'barrage',
    })
    expect(ok.ok).toBe(true)
  })

  it('2.2d：轴方在反应 / 进击阶段不受此限', () => {
    for (const phase of ['reaction', 'exploitation'] as const) {
      const outcome = checkRedAirForceMission({
        side: 'axis',
        phase,
        weatherNormal: true,
        missionKind: 'barrage',
      })
      expect(outcome.ok).toBe(true)
    }
  })
})

describe('2.2c：Early Sturmovik 只有一步', () => {
  it('2.2c：IL.2 的军力按上限 1 折算（不否决，只封顶）', () => {
    const outcome = checkRedAirForceMission({
      side: 'soviet',
      phase: 'movement',
      weatherNormal: true,
      missionKind: 'barrage',
      profile: IL2,
      steps: 2,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.data.appliedLimits).toEqual(['2.2c'])
      expect(outcome.data.effectiveSteps).toBe(1)
    }
  })

  it('2.2c：非 Early Sturmovik 机型不设上限（原样返回）', () => {
    const outcome = checkRedAirForceMission({
      side: 'soviet',
      phase: 'movement',
      weatherNormal: true,
      missionKind: 'barrage',
      profile: ORDINARY,
      steps: 2,
    })
    if (outcome.ok) {
      expect(outcome.data.effectiveSteps).toBeNull()
      expect(outcome.data.appliedLimits).toEqual([])
    }
    expect(applyEarlySturmovikCap(ORDINARY, 2)).toBe(2)
  })

  it('2.2c：折算函数（IL.2 ⇒ 最多 1；已为 1 或 0 不受影响）', () => {
    expect(applyEarlySturmovikCap(IL2, 2)).toBe(1)
    expect(applyEarlySturmovikCap(IL2, 1)).toBe(1)
    expect(applyEarlySturmovikCap(IL2, 0)).toBe(0)
    expect(applyEarlySturmovikCap(IL2, -3)).toBe(0)
  })
})

/* ────── B41（2.2c/2.2d 的「单军力」上限）判据来自**专规数据**，不是引擎里的裸数字 ────── */

/**
 * 第三批方案 §2.1 A-3 的病灶：这条上限原本是引擎里的**裸字面量 `1`**，而专规数据里
 * `soviet_special.air.IL2_single_step`（本作 `rulesConstants.smolensk.air.soviet.il2SingleStep`）
 * 那条开关**没有任何人读** ⇒ 改数据而引擎行为不变（"同一规则两个来源"）。
 *
 * 本组把它钉成**单一来源**：上限由数据开关派生。
 * ★ 第一条断言**故意写死 1** —— 它就是"本作数据把该限制打开"的可判定证据：
 *   若有人把 `il2SingleStep` 改成 `false`，这条会立刻红（数据真的在驱动行为，而不是摆设）。
 * 测法边界：本组只钉**派生关系与两种取值下的上限**；"上限如何折算到具体机型"由上一组覆盖。
 */
describe('B41：2.2c/2.2d 的单军力上限由**专规数据**派生（不再是裸数字）', () => {
  it('★ 本作数据为「单军力」⇒ 上限 1（改数据即会红：数据真的在驱动行为）', () => {
    expect(rulesConstants.smolensk.air.soviet.il2SingleStep).toBe(true)
    expect(EARLY_STURMOVIK_STEPS).toBe(1)
  })

  it('★ 派生口径与实现一致：数据关掉该限制 ⇒ 上限为**无穷**（不设上限）', () => {
    const derived = rulesConstants.smolensk.air.soviet.il2SingleStep ? 1 : Number.POSITIVE_INFINITY
    expect(EARLY_STURMOVIK_STEPS).toBe(derived)
    if (!rulesConstants.smolensk.air.soviet.il2SingleStep) {
      expect(applyEarlySturmovikCap(IL2, 3)).toBe(3)
    }
  })
})
