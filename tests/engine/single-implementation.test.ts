import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { rulesConstants } from '@/data'
import { computeCombatSupplyCost } from '@/engine/rules/supply'
import { battleCombatSupply } from '@/engine/rules/battle'
import { flakKillCheck } from '@/engine/rules/air'
import { resolveFlakResponse } from '@/engine/rules/air-interaction'
import { barrageCostT } from '@/engine/rules/barrage'
import { flakKillCheck as flakKillFromTables } from '@/engine/tables/flak'
import { barrageCostT as costFromTables } from '@/engine/tables/barrage'
import { isPanzerGroupConstraintLifted } from '@/engine/rules/timing'
import { requiresPanzerGroupSpAssignment } from '@/engine/rules/setup'
import { turnDate } from '@/engine/turn-driver'
import { TURN_TRACK, toBattleUnitView, toConsoleUnit, turnDateOf } from '@/stores'
import { unitChoices } from '@/stores'

/**
 * M2 口径收敛的**守门用例**（同一规则不得有两套实现）
 *
 * 模板取自 B5④ 修 12.7b 时的做法：把旧口径写回去，这些断言立刻变红。
 * 本文件同时是"哪些东西必须只有一处实现"的清单——新增一条就加一组断言。
 */

const readSource = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

/** 剥掉注释后再找（避免说明文字里的数字被当成硬编码） */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('M2① 回合 → 日期：唯一实现在引擎', () => {
  it('全回合轨逐条比对：操作台的 turnDateOf 与引擎 turnDate 同值', () => {
    expect(TURN_TRACK.length).toBeGreaterThan(0)
    for (const entry of TURN_TRACK)
      expect(turnDateOf(entry.turn), `回合 ${entry.turn}`).toBe(turnDate(entry.turn))
  })

  it('越界时操作台**夹取**（界面可随手拨回合），引擎**抛错**（那是编程错误）', () => {
    const first = TURN_TRACK[0]!
    const last = TURN_TRACK[TURN_TRACK.length - 1]!
    expect(turnDateOf(-5)).toBe(first.date)
    expect(turnDateOf(9999)).toBe(last.date)
    expect(() => turnDate(9999)).toThrow()
  })

  it('源码守门：`workbench-model` 不再自持一份回合轨查找', () => {
    const code = stripComments(readSource('src/stores/workbench-model.ts'))
    // 旧口径的特征写法：在本文件里直接 find 回合轨并返回 date
    expect(code).not.toMatch(/TURN_TRACK\.find\(/)
    expect(code).toContain('turnDate(')
  })
})

describe('M2③ 3.4 装甲集群约束的解除日：唯一实现在 timing', () => {
  const end = rulesConstants.smolensk.panzerGroupConstraintEnd

  it('约束判定与解除判定互补（同一判据的两面）', () => {
    for (const date of ['1941-07-08', '1941-07-19', end, '1941-08-19', '1941-09-08'])
      expect(turnDateOf(1) !== '' && isPanzerGroupConstraintLifted(date)).toBe(
        !(date < end) ? isPanzerGroupConstraintLifted(date) : false,
      )
    // 解除日当天即已解除（`>=` 口径）
    expect(isPanzerGroupConstraintLifted(end)).toBe(true)
  })

  it('剧本适用性走同一函数：首回合早于解除日 ⇒ 适用', () => {
    // 剧本 1 首回合 8 Jul 41 < 19 Aug ⇒ 适用；剧本 7 首回合 26 Aug ⇒ 不适用
    expect(requiresPanzerGroupSpAssignment('1')).toBe(dateBefore(end, '1941-07-08'))
    expect(requiresPanzerGroupSpAssignment('7')).toBe(!isPanzerGroupConstraintLifted('1941-08-26'))
  })

  it('源码守门：解除日的**比较**只出现在 timing.ts', () => {
    const files = [
      'src/engine/rules/setup.ts',
      'src/engine/rules/panzer-groups.ts',
      'src/engine/rules/exclusive-timing.ts',
    ]
    for (const file of files) {
      const code = stripComments(readSource(file))
      expect(code, `${file} 不得直接比较解除日`).not.toMatch(
        /[<>]=?\s*rulesConstants\.smolensk\.panzerGroupConstraintEnd/,
      )
      expect(code, `${file} 不得直接比较解除日`).not.toMatch(/panzerGroupConstraintEnd\s*[<>]=?/)
    }
  })

  function dateBefore(a: string, b: string): boolean {
    return b < a
  }
})

describe('M2④ 12.4 战斗补给成本：唯一实现 + 走常量', () => {
  it('battleCombatSupply 的所需 T 与 computeCombatSupplyCost 同值（逐组合）', () => {
    const cases: { attackerSteps: number; defenderRE: number }[] = [
      { attackerSteps: 1, defenderRE: 0.5 },
      { attackerSteps: 2, defenderRE: 1 },
      { attackerSteps: 3, defenderRE: 1.5 },
      { attackerSteps: 6, defenderRE: 4 },
      { attackerSteps: 0, defenderRE: 0 },
    ]
    for (const c of cases) {
      const cost = computeCombatSupplyCost(c)
      const outcome = battleCombatSupply({
        attackers: [fakeUnit(c.attackerSteps, 1)],
        defenders: [fakeUnit(1, c.defenderRE)],
        attackerAvailableT: 99,
        defenderProvides: true,
        defenderAvailableT: 99,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) continue
      expect(outcome.data.attackerRequiredT, `${c.attackerSteps} 军力`).toBe(cost.attackerT)
      expect(outcome.data.defenderRequiredT, `${c.defenderRE} RE`).toBe(cost.defenderT)
    }
  })

  it('源码守门：战斗补给成本不再内联 1 / 2 的硬编码', () => {
    const code = stripComments(readSource('src/engine/rules/battle.ts'))
    expect(code).toContain('computeCombatSupplyCost(')
    // 旧口径特征写法
    expect(code).not.toMatch(/defenderRE\s*<=\s*1\s*\?\s*1\s*:\s*2/)
  })

  function fakeUnit(steps: number, re: number) {
    /*
     * 用**产品自己的转换器**造 `BattleUnitView`（`toConsoleUnit` → `toBattleUnitView`），
     * 而不是手写一个形状近似的对象——手写的那份一旦与 `BattleUnitView` 脱节，
     * 本用例就会在"字段对不上"上失败，而不是在"成本算错"上失败（噪音）。
     */
    const unit = toConsoleUnit({
      record: unitChoices('axis')[0]!,
      instanceId: `u${steps}-${re}`,
      hex: { col: 11, row: 11 },
      side: 'axis',
      face: 'combat',
    })
    return { ...toBattleUnitView(unit), steps, re }
  }
})

describe('M2⑥ 轰炸成本与防空阈值：表模块只转发、产品路径不硬编码', () => {
  it('barrageCostT：两处入口同值，且**小数不抛错**（4.2 先合并再取整）', () => {
    for (let value = 0.5; value <= 40; value += 0.5) {
      const fromRules = barrageCostT(value)
      expect(costFromTables(value), `轰炸值 ${value}`).toBe(fromRules)
    }
    // 修前：tables 版对 1.5 / 2.5 / … 直接抛 TableLookupError
    expect(() => costFromTables(2.5)).not.toThrow()
    expect(costFromTables(2.5)).toBe(barrageCostT(2.5))
  })

  it('flakKillCheck：表模块转发同一实现（阈值 11）', () => {
    for (let die = 2; die <= 14; die += 1)
      expect(flakKillFromTables(die), `修正骰 ${die}`).toBe(flakKillCheck(die))
    expect(flakKillCheck(11)).toBe(true)
    expect(flakKillCheck(10)).toBe(false)
  })

  it('防空结算走 flakKillCheck：**同一次掷骰**下，命中结论与它一致', () => {
    for (let die = 2; die <= 12; die += 1) {
      const response = resolveFlakResponse({
        kind: 'barrage',
        inEnemyPatrolZone: false,
        missionAircraft: [{ id: 'a1', barrageStrength: 4 }],
        die2d6: die,
      })
      expect(response.hit, `2 骰 ${die}`).toBe(flakKillCheck(response.modifiedDie))
    }
  })

  it('源码守门：产品路径不再出现硬编码的击落阈值', () => {
    const code = stripComments(readSource('src/engine/rules/air-interaction.ts'))
    expect(code).toContain('flakKillCheck(')
    expect(code).not.toMatch(/modifiedDie\s*>=\s*11/)
  })
})

describe('M6② 9.13 逐单位进击 + 14.7d 低空扫射 + 专规 1.5 气象闸：口径与接线守门', () => {
  it('源码守门：操作台把**逐单位**的 AR/DG 交给引擎（否则只标记一个单位）', () => {
    const store = stripComments(readSource('src/stores/workbench.ts'))
    expect(store).toMatch(/attackerUnits:\s*combatAttackers\.value\.map/)
    expect(store).toContain('ar: unit.raw.ar')
    expect(store).toContain('dg: unit.mode.dg')
  })

  it('源码守门：低空扫射的天气闸只在 canHipShoot 一处（weather.ts 不再自持一份）', () => {
    const weather = stripComments(readSource('src/engine/rules/weather.ts'))
    expect(weather).not.toContain('isHipShootAllowed')
    const air = stripComments(readSource('src/engine/rules/air.ts'))
    expect(air).toContain('export function canHipShoot')
  })

  it('源码守门：受限飞行的阶段闸接在空任务链上（专规 1.5）', () => {
    const interaction = stripComments(readSource('src/engine/rules/air-interaction.ts'))
    expect(interaction).toContain('isAirMissionAllowedInPhase(')
    const store = stripComments(readSource('src/stores/workbench.ts'))
    expect(store).toContain(
      'weatherLimited: airInputs.value.flyingAllowed && !airInputs.value.weatherNormal',
    )
  })
})
