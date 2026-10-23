import { describe, expect, it } from 'vitest'

import type { Side } from '@/data'
import {
  ACTIONS_BY_PHASE,
  SOP_SEGMENT_CHAINS,
  TIMING_DEFERRED_ACTIONS,
  operationTimingOf,
  segmentsNeedingFuel,
  sopStepById,
} from '@/engine/rules'
import {
  ACTION_GATES,
  ACTION_KEY_KIND,
  ACTION_KEYS_WITHOUT_KIND,
  actionGateOf,
  allowedActionsOf,
  canReleaseReserveNow,
  isActionAllowed,
  participatesIn,
  toConsoleUnit,
  unitChoices,
  type ActionKey,
  type ConsoleUnit,
} from '@/stores'

/**
 * B7：阶段闸门（动作族 × 环节 ＋ 算子参与判定）
 *
 * 用户口径（2026-09-16 ⑤ / 方案 §4.1）：「**做好阶段隔离**，弄清楚每个环节能动什么、不能动什么，
 * **不参与环节的算子无法点击**。」
 *
 * 本文件钉四件事：
 *   ① **表本身自洽**：每个动作族的去处都落在 `sop-segments.ts` 真实存在的环节 id 上；
 *      「给玩家点的」键至少有一个去处；「永不交给玩家」的键必须在注释里说清（空去处白名单）；
 *   ② **与引擎时机表对得上**：每个界面键都能说出它在 `ActionKind` 里对应哪些 kind；
 *      说"没有对应"的必须逐个登记理由（`ACTION_KEYS_WITHOUT_KIND`）；
 *   ③ **逐环节两例**（§4.1.4 第 4 条）：每个环节至少一条"允许"与一条"禁止"，断言名带规则号；
 *   ④ **全表覆盖**：每个键至少在一个环节被允许（否则表里有死键）。
 */

/* ────────────────────────────── 夹具 ────────────────────────────── */

const recordOf = (
  side: Side,
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
) => {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

/** 一枚可移动的轴方战斗单位（徒步、有 MA） */
const moverRecord = () =>
  recordOf(
    'axis',
    (record) =>
      record.isCombat === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.ma ?? record.factors?.move?.ma ?? 0) > 0,
  )

/** 一枚有印刷轰炸值的轴方火炮 */
const artilleryRecord = () =>
  recordOf(
    'axis',
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )

/** 一枚轴方空军基地（非战斗设施） */
const airBaseRecord = () => recordOf('axis', (record) => record.noncombatKind === 'air_base')

const unitOf = (
  record: ReturnType<typeof unitChoices>[number],
  side: Side,
  overrides: Partial<ConsoleUnit> = {},
): ConsoleUnit => ({
  ...toConsoleUnit({ record, instanceId: 'u1', hex: { col: 36, row: 13 }, side }),
  ...overrides,
})

const queryOf = (
  phase: Parameters<typeof allowedActionsOf>[0]['phase'],
  segment: string,
  side: Side = 'axis',
) => ({ phase, segment, role: 'active' as const, side })

/* ────────────────────────────── 表自洽 ────────────────────────────── */

describe('B7：闸门表自洽', () => {
  it('每个动作族的去处都落在**真实存在的环节**上（防手写错 id）', () => {
    const bad: string[] = []
    for (const gate of ACTION_GATES) {
      for (const where of gate.where) {
        const step = sopStepById(where.segment)
        if (step === null) bad.push(`${gate.key} → 环节 ${where.segment} 不存在`)
        else if (!where.segment.startsWith(`${where.phase}.`) && where.phase !== 'preTurn') {
          bad.push(`${gate.key} → 环节 ${where.segment} 与段 ${where.phase} 不符`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('"给玩家点"的键至少有一个去处（表里不留死键）', () => {
    // 永不交给玩家的动作族：目前没有（B 段的掷骰与事件没有键，故不在本表里）
    for (const gate of ACTION_GATES) {
      expect(gate.where.length, `${gate.key} 没有任何去处`).toBeGreaterThan(0)
    }
  })

  it('键唯一、规则号非空、标签非空', () => {
    const keys: string[] = []
    for (const gate of ACTION_GATES) {
      expect(keys, `${gate.key} 重复`).not.toContain(gate.key)
      keys.push(gate.key)
      expect(gate.rule.length, `${gate.key} 缺规则号`).toBeGreaterThan(0)
      expect(gate.label.length, `${gate.key} 缺标签`).toBeGreaterThan(0)
    }
  })

  it('每个动作族至少在一个环节被允许（否则是死键）', () => {
    for (const gate of ACTION_GATES) {
      const anywhere = gate.where.some((where) => {
        // 按方限定的键（B 段抽取类）要在**那一方**检查，否则会被误判成死键
        const sides: readonly Side[] = where.sides ?? ['axis', 'soviet']
        /*
         * B37：新时机类别 `at: 'end'`（段末）只在查询方声明"此刻是段末"时放行 ——
         * 故可达性检查要**两种都试**（段中 / 段末），否则段末类动作会被误判成死键。
         */
        return sides.some((side) =>
          [false, true].some((atSegmentEnd) =>
            allowedActionsOf({
              phase: where.phase,
              segment: where.segment,
              role: where.role ?? 'active',
              side,
              atSegmentEnd,
            }).has(gate.key),
          ),
        )
      })
      expect(anywhere, `${gate.key} 在任何环节都不可达`).toBe(true)
    }
  })

  it('与引擎时机表对得上：有对应 kind 的键，其 kind 必须在该段**或**属"时机延后"之列', () => {
    /*
     * `airMission` 这类动作**不在** `ACTIONS_BY_PHASE` 里，而列在 `TIMING_DEFERRED_ACTIONS`
     * ——原文即「属铁路与港口子系统 / 空中任务的时机散在 14.x，本层不臆造」。
     * 故判据是「在该段**或**属延后之列」，两者都算对得上；真正的段限定由
     * `air-mission.ts#AIR_MISSION_SEGMENT`（14.2e）给出，本表只是把它摆到环节上。
     *
     * ★ H④：原先 `supply.fuel` 需要一条**逐键豁免**（它既在补给段的时机表里、又挂在 C/E/G 的移动环节上）。
     *   用户 2026-09-19 口径删掉 D 段的加油环节后，`fuel` 已按 12.5c 归入 `TIMING_DEFERRED_ACTIONS`
     *   ⇒ **豁免机制不再需要**（清单已空，改为下面两条正向断言，免得它变成藏污纳垢的地方）。
     */
    const problems: string[] = []
    const deferred = new Set<string>(TIMING_DEFERRED_ACTIONS)
    for (const gate of ACTION_GATES) {
      for (const kind of ACTION_KEY_KIND[gate.key]) {
        for (const where of gate.where) {
          if (ACTIONS_BY_PHASE[where.phase].includes(kind)) continue
          if (deferred.has(kind)) continue
          problems.push(
            `${gate.key}（kind ${kind}）被放在 ${where.phase}，但时机表里该段没有 ${kind}`,
          )
        }
      }
    }
    expect(problems).toEqual([])

    // ★ 反空转：`fuel` 确实**全靠**延后表放行（它在任何段的许可集合里都不出现，否则这条就是空话）
    expect(TIMING_DEFERRED_ACTIONS).toContain('fuel')
    expect(
      actionGateOf('supply.fuel').where.every(
        (where) => !ACTIONS_BY_PHASE[where.phase].includes('fuel'),
      ),
      'fuel 已能被某段时机表收纳 ⇒ 应从延后表删掉，免得两处口径并存',
    ).toBe(true)
  })

  it('说"引擎里没有对应 kind"的键必须逐个登记理由', () => {
    for (const gate of ACTION_GATES) {
      const kinds = ACTION_KEY_KIND[gate.key]
      if (kinds.length === 0) {
        expect(ACTION_KEYS_WITHOUT_KIND, `${gate.key} 的空 kind 未登记`).toContain(gate.key)
      } else {
        expect(ACTION_KEYS_WITHOUT_KIND, `${gate.key} 有 kind 却被登记为"无对应"`).not.toContain(
          gate.key,
        )
      }
    }
  })

  it('ACTION_KEY_KIND 覆盖全部动作族（不多不少）', () => {
    expect(Object.keys(ACTION_KEY_KIND).sort()).toEqual(ACTION_GATES.map((gate) => gate.key).sort())
  })
})

/* ────────────────────────────── 逐环节：允许 + 禁止 ────────────────────────────── */

describe('B7：逐环节的允许与禁止（每例带规则号）', () => {
  it('A 整备（15.1）：允许 air.refit，禁止 move.order', () => {
    const allowed = allowedActionsOf(queryOf('aircraftRefit', 'aircraftRefit.refit'))
    expect(allowed.has('air.refit')).toBe(true)
    expect(allowed.has('move.order')).toBe(false)
    expect(allowed.has('combat.declare')).toBe(false)
  })

  it('A 整备：15.4 基地缩减**不在**本段（归 C 段）', () => {
    const allowed = allowedActionsOf(queryOf('aircraftRefit', 'aircraftRefit.refit'))
    expect(allowed.has('air.baseReduce')).toBe(false)
    expect(isActionAllowed(queryOf('movement', 'movement.modeAndMovement'), 'air.baseReduce')).toBe(
      true,
    )
  })

  it('B 增援（13.6 / 13.5）：允许到货与重建，禁止移动与战斗', () => {
    const allowed = allowedActionsOf(queryOf('reinforcement', 'reinforcement.arrival'))
    expect(allowed.has('rein.arrival')).toBe(true)
    expect(allowed.has('move.order')).toBe(false)
    expect(allowed.has('combat.declare')).toBe(false)
    expect(isActionAllowed(queryOf('reinforcement', 'reinforcement.rebuild'), 'rein.rebuild')).toBe(
      true,
    )
  })

  it('B 增援：轴方抽取（专规 13.7）与苏方特补（专规 1.6c）各归其方', () => {
    const axisDraw = allowedActionsOf(
      queryOf('reinforcement', 'reinforcement.formationDraw', 'axis'),
    )
    const sovietDraw = allowedActionsOf(
      queryOf('reinforcement', 'reinforcement.formationDraw', 'soviet'),
    )
    expect(axisDraw.has('rein.formationDraw')).toBe(true)
    expect(sovietDraw.has('rein.formationDraw')).toBe(false)
    expect(
      isActionAllowed(
        queryOf('reinforcement', 'reinforcement.specialRepl', 'soviet'),
        'rein.specialRepl',
      ),
    ).toBe(true)
    expect(
      isActionAllowed(
        queryOf('reinforcement', 'reinforcement.specialRepl', 'axis'),
        'rein.specialRepl',
      ),
    ).toBe(false)
  })

  it('C 移动 · 突围（12.8e）：只允许突围；移动与轰炸不在本环节', () => {
    const allowed = allowedActionsOf(queryOf('movement', 'movement.breakout'))
    expect(allowed.has('move.breakout')).toBe(true)
    expect(allowed.has('move.order')).toBe(false)
    expect(allowed.has('barrage.declare')).toBe(false)
  })

  it('C 移动 · 模式与移动：允许移动/改模式/建造等，**不允许**宣告战斗', () => {
    const allowed = allowedActionsOf(queryOf('movement', 'movement.modeAndMovement'))
    for (const key of [
      'move.modeChange',
      'move.order',
      'move.overrun',
      'move.construction',
    ] as ActionKey[]) {
      expect(allowed.has(key), `${key} 应在本环节允许`).toBe(true)
    }
    expect(allowed.has('combat.declare')).toBe(false)
    expect(allowed.has('rein.arrival')).toBe(false)
  })

  it('C 移动 · 轰炸（SOP：air & ship only）：只有轰炸与空中任务', () => {
    const allowed = allowedActionsOf(queryOf('movement', 'movement.barrage'))
    expect(allowed.has('barrage.declare')).toBe(true)
    expect(allowed.has('air.mission')).toBe(true)
    expect(allowed.has('move.order')).toBe(false)
    expect(allowed.has('combat.declare')).toBe(false)
  })

  it('D 段两环（H④）：①恢复部队储备 ②补给检定/损耗；**加油不在本段**，移动一律禁止', () => {
    // ① 恢复部队储备（12.10e）：恢复本体 + 12.10e-B 的拖取/投递（12.3a·b）
    const recovery = allowedActionsOf(queryOf('supply', 'supply.recovery'))
    expect(recovery.has('supply.recovery')).toBe(true)
    expect(recovery.has('supply.draw')).toBe(true)
    // 12.8a 的损耗属第二环（先判追溯，才有断补堆叠）
    expect(recovery.has('supply.attrition')).toBe(false)

    // ② 补给检定（12.6 判定 → 12.6c 吃图上 / 12.6d 标断补 → 12.8 损耗）
    const check = allowedActionsOf(queryOf('supply', 'supply.check'))
    expect(check.has('supply.draw')).toBe(true)
    expect(check.has('supply.attrition')).toBe(true)
    expect(check.has('supply.recovery')).toBe(false)
    expect(check.has('move.order')).toBe(false)

    // ★ 12.5c（用户 2026-09-19 口径）：两环都不放行"付燃料"（燃料在消耗时刻、即 C/E/G 的移动环节付）
    for (const step of ['supply.recovery', 'supply.check']) {
      expect(allowedActionsOf(queryOf('supply', step)).has('supply.fuel')).toBe(false)
    }
  })

  it('E 反应（7.0a）：行动者是**非行动方**，故 role=active 一律不允许', () => {
    const asNonActive = allowedActionsOf({
      phase: 'reaction',
      segment: 'reaction.movement',
      role: 'nonActive',
      side: 'soviet',
    })
    expect(asNonActive.has('move.order')).toBe(true)
    expect(asNonActive.has('reserve.release')).toBe(true)

    const asActive = allowedActionsOf({
      phase: 'reaction',
      segment: 'reaction.movement',
      role: 'active',
      side: 'axis',
    })
    expect(asActive.has('move.order')).toBe(false)
    expect(asActive.size).toBe(0)
  })

  it('F 战斗 · 炮击环节（10.0，仅炮兵）：允许轰炸与空中任务，禁止宣告战斗', () => {
    const allowed = allowedActionsOf(queryOf('combat', 'combat.barrage'))
    expect(allowed.has('barrage.declare')).toBe(true)
    expect(allowed.has('combat.declare')).toBe(false)
    expect(allowed.has('move.order')).toBe(false)
  })

  it('F 战斗 · 战斗环节（9.2）：允许宣告战斗与拆分，**不允许**再轰炸', () => {
    const allowed = allowedActionsOf(queryOf('combat', 'combat.combat'))
    expect(allowed.has('combat.declare')).toBe(true)
    expect(allowed.has('move.breakdown')).toBe(true)
    expect(allowed.has('barrage.declare')).toBe(false)
  })

  it('G 进击（11.0）：移动 / 轰炸 / 战斗三环各管各的', () => {
    expect(
      allowedActionsOf(queryOf('exploitation', 'exploitation.movement')).has('move.order'),
    ).toBe(true)
    expect(
      allowedActionsOf(queryOf('exploitation', 'exploitation.movement')).has('combat.declare'),
    ).toBe(false)
    expect(
      allowedActionsOf(queryOf('exploitation', 'exploitation.barrage')).has('barrage.declare'),
    ).toBe(true)
    expect(
      allowedActionsOf(queryOf('exploitation', 'exploitation.combat')).has('combat.declare'),
    ).toBe(true)
    expect(allowedActionsOf(queryOf('exploitation', 'exploitation.combat')).has('move.order')).toBe(
      false,
    )
  })

  it('Pre-Turn / H 清理 / Turn End：一个动作族都不放行（全自动段）', () => {
    for (const [phase, segment] of [
      ['preTurn', 'preTurn.weatherDetermination'],
      ['preTurn', 'preTurn.firstPlayerDetermination'],
      ['cleanUp', 'cleanUp.auto'],
      ['turnEnd', 'turnEnd.advance'],
    ] as const) {
      expect(allowedActionsOf(queryOf(phase, segment)).size, `${segment} 不该放行任何动作`).toBe(0)
    }
  })

  it('全表覆盖：`ACTION_GATES` 的每个键都在至少一个环节里被允许（防漏配）', () => {
    const reachable = new Set<ActionKey>()
    for (const chain of SOP_SEGMENT_CHAINS) {
      for (const step of chain.steps) {
        for (const role of ['active', 'nonActive'] as const) {
          for (const side of ['axis', 'soviet'] as const) {
            for (const atSegmentEnd of [false, true]) {
              for (const key of allowedActionsOf({
                phase: chain.phase,
                segment: step.id,
                role,
                side,
                atSegmentEnd,
              })) {
                reachable.add(key)
              }
            }
          }
        }
      }
    }
    const missing = ACTION_GATES.map((gate) => gate.key).filter((key) => !reachable.has(key))
    expect(missing).toEqual([])
  })

  it('取闸门条目：非法键抛错（不静默给一个空条目）', () => {
    expect(actionGateOf('move.order').rule).toBe('6.x')
    expect(() => actionGateOf('nope' as never)).toThrow(RangeError)
  })
})

/* ────────────────────────────── 算子参与判定 ────────────────────────────── */

describe('B7：算子参与判定（不参与环节的算子无法点击）', () => {
  it('回合准备 / 清理 / 回合结束：一切算子都不参与（2.2）', () => {
    const unit = unitOf(moverRecord(), 'axis')
    for (const [phase, segment] of [
      ['preTurn', 'preTurn.weatherDetermination'],
      ['cleanUp', 'cleanUp.auto'],
      ['turnEnd', 'turnEnd.advance'],
    ] as const) {
      const verdict = participatesIn({ unit, phase, segment, activeSide: 'axis' })
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.rule).toBe('2.2')
    }
  })

  it('A 整备（15.1）：地面单位不可点（备忘 #4 的原话），空军基地可点', () => {
    const ground = unitOf(moverRecord(), 'axis')
    const base = unitOf(airBaseRecord(), 'axis')
    const groundVerdict = participatesIn({
      unit: ground,
      phase: 'aircraftRefit',
      segment: 'aircraftRefit.refit',
      activeSide: 'axis',
    })
    expect(groundVerdict.ok).toBe(false)
    if (!groundVerdict.ok) expect(groundVerdict.rule).toBe('15.1')

    const baseVerdict = participatesIn({
      unit: base,
      phase: 'aircraftRefit',
      segment: 'aircraftRefit.refit',
      activeSide: 'axis',
    })
    expect(baseVerdict.ok).toBe(true)
  })

  it('C 移动 · 模式与移动（6.0）：本方未动单位可点；敌方不可点；已动完不可再点', () => {
    const unit = unitOf(moverRecord(), 'axis')
    expect(
      participatesIn({
        unit,
        phase: 'movement',
        segment: 'movement.modeAndMovement',
        activeSide: 'axis',
      }).ok,
    ).toBe(true)

    const enemy = unitOf(moverRecord(), 'soviet')
    const enemyVerdict = participatesIn({
      unit: enemy,
      phase: 'movement',
      segment: 'movement.modeAndMovement',
      activeSide: 'axis',
    })
    expect(enemyVerdict.ok).toBe(false)
    if (!enemyVerdict.ok) expect(enemyVerdict.rule).toBe('6.0')

    const ended = unitOf(moverRecord(), 'axis', { movementEnded: true })
    const endedVerdict = participatesIn({
      unit: ended,
      phase: 'movement',
      segment: 'movement.modeAndMovement',
      activeSide: 'axis',
    })
    expect(endedVerdict.ok).toBe(false)
    if (!endedVerdict.ok) expect(endedVerdict.rule).toBe('6.1')
  })

  it('C 移动 · 突围（12.8e）：只有**断补**的战斗单位可尝试', () => {
    const supplied = unitOf(moverRecord(), 'axis')
    const suppliedVerdict = participatesIn({
      unit: supplied,
      phase: 'movement',
      segment: 'movement.breakout',
      activeSide: 'axis',
    })
    expect(suppliedVerdict.ok).toBe(false)
    if (!suppliedVerdict.ok) expect(suppliedVerdict.rule).toBe('12.8e')

    const cutOff = unitOf(moverRecord(), 'axis', { hasTraceSupply: false })
    expect(
      participatesIn({
        unit: cutOff,
        phase: 'movement',
        segment: 'movement.breakout',
        activeSide: 'axis',
      }).ok,
    ).toBe(true)
  })

  it('C 移动 · 轰炸（SOP：air & ship only）：地面算子不参与本环节', () => {
    const gun = unitOf(artilleryRecord(), 'axis')
    const verdict = participatesIn({
      unit: gun,
      phase: 'movement',
      segment: 'movement.barrage',
      activeSide: 'axis',
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.rule).toBe('10.0')
  })

  it('D 段两环的参与判定（H④）：本方单位两环都可参与；敌方一律不可', () => {
    /*
     * ★ 契约变更（H④，**不是放宽**）：修前这里钉的是「加油环节里谁可点」——要燃料的单位才可点（12.5a）。
     *   H④ 按用户口径删掉了 D 段的加油环节 ⇒ 那条参与判据**没有主场了**；燃料的"谁需要付"改由
     *   付款动作自己判（`fuelPendingUnits` 用 `needsFuelOf` 过滤，见 `supply-phase-two-steps.test.ts`）。
     *   本用例改为钉两环各自的参与判据：本方单位可参与（12.10e / 12.6 都是对本方做的），敌方不可。
     */
    const own = unitOf(moverRecord(), 'axis')
    for (const segment of ['supply.recovery', 'supply.check']) {
      expect(
        participatesIn({ unit: own, phase: 'supply', segment, activeSide: 'axis' }).ok,
        `${segment}：本方单位应可参与`,
      ).toBe(true)
    }
    const enemy = unitOf(moverRecord(), 'soviet')
    for (const segment of ['supply.recovery', 'supply.check']) {
      const verdict = participatesIn({ unit: enemy, phase: 'supply', segment, activeSide: 'axis' })
      expect(verdict.ok, `${segment}：敌方单位不该可参与`).toBe(false)
      if (!verdict.ok) expect(['12.10e', '12.6']).toContain(verdict.rule)
    }
  })

  it('D 段第二环（12.6）：有补给与断补的单位**都**参与（12.6 要检每一个战斗单位）', () => {
    /*
     * ★ 契约变更（H④）：修前这里钉的是「断补损耗环节只让断补单位可点」（12.8a）。损耗分配仍在
     *   `applyAttritionNow` / `validateAttritionAllocation` 与计划的 `attritionDuty` 里按断补堆叠收窄
     *   （见 `attrition-flow.test.ts` 的四条），而**参与集合**属 12.6 的检定：每个战斗单位都要检。
     */
    const supplied = unitOf(moverRecord(), 'axis')
    const cutOff = unitOf(moverRecord(), 'axis', { hasTraceSupply: false })
    for (const unit of [supplied, cutOff]) {
      expect(
        participatesIn({ unit, phase: 'supply', segment: 'supply.check', activeSide: 'axis' }).ok,
      ).toBe(true)
    }
  })

  it('E 反应（6.3a / 7.0a）：行动方的单位不可点，非行动方的预备才可点', () => {
    const activeUnit = unitOf(moverRecord(), 'axis')
    const activeVerdict = participatesIn({
      unit: activeUnit,
      phase: 'reaction',
      segment: 'reaction.movement',
      activeSide: 'axis',
    })
    expect(activeVerdict.ok).toBe(false)
    if (!activeVerdict.ok) expect(activeVerdict.rule).toBe('6.3a')

    // 非行动方的**未释放**预备：7.0a 不允许
    const reserve = unitOf(moverRecord(), 'soviet', {
      mode: { ...activeUnit.mode, mode: 'reserve' },
    })
    const reserveVerdict = participatesIn({
      unit: reserve,
      phase: 'reaction',
      segment: 'reaction.movement',
      activeSide: 'axis',
    })
    expect(reserveVerdict.ok).toBe(false)
    if (!reserveVerdict.ok) expect(reserveVerdict.rule).toBe('7.0a')

    // 已释放的预备：可动
    const released = unitOf(moverRecord(), 'soviet', {
      mode: { ...activeUnit.mode, mode: 'reserve', releasedFromReserve: true },
    })
    expect(
      participatesIn({
        unit: released,
        phase: 'reaction',
        segment: 'reaction.movement',
        activeSide: 'axis',
      }).ok,
    ).toBe(true)
  })

  it('F 战斗 · 炮击环节（10.0，仅炮兵）：炮兵可点、步兵不可点', () => {
    const gun = unitOf(artilleryRecord(), 'axis')
    expect(
      participatesIn({ unit: gun, phase: 'combat', segment: 'combat.barrage', activeSide: 'axis' })
        .ok,
    ).toBe(true)

    const infantry = unitOf(moverRecord(), 'axis')
    const verdict = participatesIn({
      unit: infantry,
      phase: 'combat',
      segment: 'combat.barrage',
      activeSide: 'axis',
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.rule).toBe('10.0')
  })

  it('F 战斗 · 战斗环节（9.1b）：可攻击且未动的可点；敌方只读', () => {
    const attacker = unitOf(
      recordOf(
        'axis',
        (record) =>
          record.isCombat === true &&
          record.attackCapable === true &&
          (record.factors?.combat?.attack ?? 0) > 0,
      ),
      'axis',
    )
    expect(
      participatesIn({
        unit: attacker,
        phase: 'combat',
        segment: 'combat.combat',
        activeSide: 'axis',
      }).ok,
    ).toBe(true)

    const enemy = unitOf(
      recordOf('soviet', (record) => record.isCombat === true),
      'soviet',
    )
    const enemyVerdict = participatesIn({
      unit: enemy,
      phase: 'combat',
      segment: 'combat.combat',
      activeSide: 'axis',
    })
    expect(enemyVerdict.ok).toBe(false)
    if (!enemyVerdict.ok) expect(enemyVerdict.rule).toBe('9.1b')

    const moved = unitOf(
      recordOf('axis', (record) => record.isCombat === true && record.attackCapable === true),
      'axis',
      { movementEnded: true },
    )
    const movedVerdict = participatesIn({
      unit: moved,
      phase: 'combat',
      segment: 'combat.combat',
      activeSide: 'axis',
    })
    expect(movedVerdict.ok).toBe(false)
    if (!movedVerdict.ok) expect(movedVerdict.rule).toBe('9.1b')
  })

  it('G 进击 · 进击移动（11.0a）：无进击标记的不可动，带标记的可动', () => {
    const plain = unitOf(moverRecord(), 'axis')
    const plainVerdict = participatesIn({
      unit: plain,
      phase: 'exploitation',
      segment: 'exploitation.movement',
      activeSide: 'axis',
    })
    expect(plainVerdict.ok).toBe(false)
    if (!plainVerdict.ok) expect(plainVerdict.rule).toBe('11.0a')

    const exploit = unitOf(moverRecord(), 'axis', {
      mode: { ...plain.mode, exploit: true },
    })
    expect(
      participatesIn({
        unit: exploit,
        phase: 'exploitation',
        segment: 'exploitation.movement',
        activeSide: 'axis',
      }).ok,
    ).toBe(true)
  })

  it('专规 2.4：被锁定的师在任何环节都不参与', () => {
    const locked = unitOf(moverRecord(), 'axis', { locked: true })
    const verdict = participatesIn({
      unit: locked,
      phase: 'movement',
      segment: 'movement.modeAndMovement',
      activeSide: 'axis',
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.rule).toBe('专规 2.4')
  })

  it('未登记的环节：**明确拒绝**并指向环节表（不静默放行）', () => {
    const unit = unitOf(moverRecord(), 'axis')
    const verdict = participatesIn({
      unit,
      phase: 'movement',
      segment: 'movement.nonexistent',
      activeSide: 'axis',
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.rule).toBe('B7')
  })

  it('释放预备（5.7b）：只在反应 / 进击阶段可用，且须处于预备模式', () => {
    const base = unitOf(moverRecord(), 'soviet')
    // 移动阶段不能释放（5.7b）
    const inMovement = canReleaseReserveNow(base, 'movement', 'axis')
    expect(inMovement.ok).toBe(false)
    if (!inMovement.ok) expect(inMovement.rule).toBe('5.7b')

    // 反应阶段：非行动方的预备可释放
    const reserve = unitOf(moverRecord(), 'soviet', { mode: { ...base.mode, mode: 'reserve' } })
    expect(canReleaseReserveNow(reserve, 'reaction', 'axis').ok).toBe(true)

    // 非预备模式无从释放
    const notReserve = canReleaseReserveNow(base, 'reaction', 'axis')
    expect(notReserve.ok).toBe(false)
    if (!notReserve.ok) expect(notReserve.rule).toBe('5.7b')
  })
})

/**
 * 闸门表 × **各操作的时机表**（12.5a/12.5b：燃料要求"并不限于某个环节"）
 *
 * 用户 2026-09-16 指出燃料这类要求跨环节：**移动与突袭要燃料、攻击/防御/轰炸/撤退/推进不要**，
 * 而它们散在 C/E/F/G 的多个环节里。本组把"闸门表说这个环节允许这个动作"与
 * "时机表说这个动作发生在这个环节"对起来，防两张表各走各的。
 */
describe('B7 × 时机表：要燃料的动作，其环节里闸门确实放行', () => {
  it('移动 / 突袭：闸门环节与时机表逐项一致', () => {
    for (const [key, operation] of [
      ['move.order', 'move'],
      ['move.overrun', 'overrun'],
    ] as const) {
      const gateSegments = actionGateOf(key)
        .where.map((item) => item.segment)
        .sort()
      const timingSegments = [...operationTimingOf(operation)!.segments].sort()
      expect(gateSegments, `${key} 的闸门环节与时机表不一致`).toEqual(timingSegments)
    }
  })

  it('★ 12.5c（H④ 起）：付燃料的闸门**只**覆盖 C/E/G 的移动环节；D 段两环都不放行', () => {
    expect(
      allowedActionsOf(queryOf('movement', 'movement.modeAndMovement')).has('supply.fuel'),
      '移动环节必须能付燃料（12.5a/12.5f）',
    ).toBe(true)
    // ★ 契约变更（H④，用户 2026-09-19 口径，**不是放宽**）：原先 D 段还有一个专门的加油环节；
    //   12.5c 把付款绑在消耗时刻，补给段不发生消耗 ⇒ 该环节已删，两环都不放行付燃料。
    for (const segment of ['supply.recovery', 'supply.check']) {
      expect(allowedActionsOf(queryOf('supply', segment)).has('supply.fuel')).toBe(false)
    }
    expect([...new Set(actionGateOf('supply.fuel').where.map((item) => item.segment))]).toEqual([
      'movement.modeAndMovement',
      'reaction.movement',
      'exploitation.movement',
    ])

    for (const segment of segmentsNeedingFuel()) {
      const phase = segment.split('.')[0]!
      expect(
        allowedActionsOf({ ...queryOf(phase as never, segment), role: 'active' }).has(
          'supply.fuel',
        ) ||
          allowedActionsOf({ ...queryOf(phase as never, segment), role: 'nonActive' }).has(
            'supply.fuel',
          ),
        `环节 ${segment} 需要燃料，但闸门不放行"付燃料"`,
      ).toBe(true)
    }
  })

  it('不需要燃料的动作（攻击/轰炸/撤退/推进）在各自环节照旧放行（不被燃料卡住）', () => {
    // 12.5b：这些行动**无需**燃料 ⇒ 闸门只按环节判，不含任何燃料条件
    const attack = actionGateOf('combat.declare')
    for (const item of attack.where) {
      expect(item.segment.endsWith('.combat')).toBe(true)
    }
    const barrage = actionGateOf('barrage.declare')
    // 比**集合**（闸门表按段序写、时机表按同一段序写；这里只关心"是不是这四个环节"）
    expect([...barrage.where.map((item) => item.segment)].sort()).toEqual(
      [...operationTimingOf('barrage')!.segments].sort(),
    )
  })
})
