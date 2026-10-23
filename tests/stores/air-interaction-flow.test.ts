import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
} from '@/stores'

/**
 * C9 空军交互的**端到端流程**（store 级）
 *
 * 覆盖用户要求的四条交互链：任务分配（14.2f-A/B）→ 整备额度（15.1）→ 拦截与防空应答（14.5/14.4）→
 * 基地转移与缩减（14.11/15.4）；并逐条核对**基地归属权**（14.1a/14.1c/15.1/15.4）。
 *
 * 用**真实地图与真实飞机库/单位库**（不造数）：结论全部来自引擎，故断言的是「流程走通 + 状态写对」。
 * 规则细节（14.2a/d/e、14.3a/c、14.4a/e/f、14.5、14.11、15.1/15.2/15.4 的判据）在
 * `tests/engine/air-interaction.test.ts`。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 六邻皆图内的格：放基地与飞机都在这里，避免邻格/航程断言受地图形状影响 */
const CORE_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

/** CORE_HEX 的图内邻格（转移/接近用；格距为 1） */
const NEAR_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(CORE_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)
    ) {
      return candidate
    }
  }
  throw new Error('CORE_HEX 没有图内邻格')
})()

/** 轴心国的空军基地算子（15.0：单位库里是中立算子，摆放时按己方决定归属） */
function airBaseRecord(level?: number): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find(
    (record) =>
      record.noncombatKind === 'air_base' &&
      (level === undefined || (record.noncombatDetails?.level ?? 0) === level),
  )
  if (found === undefined)
    throw new Error(`单位库中没有${level === undefined ? '' : ` ${level} 级`}空军基地算子`)
  return found
}

/** 战斗机（14.1：唯一能拦截与在空战中攻击者） */
function fighterRecord(side: Side): ReturnType<typeof aircraftChoices>[number] {
  const found = aircraftChoices(side).find((record) => record.aircraftType === 'F')
  if (found === undefined) throw new Error(`${side} 飞机库中没有战斗机`)
  return found
}

/** 可轰炸的机（14.7b：战术/战略轰炸机） */
function bomberRecord(side: Side): ReturnType<typeof aircraftChoices>[number] {
  const found = aircraftChoices(side).find(
    (record) => record.aircraftType === 'T' && (record.barrageStrength ?? 0) > 0,
  )
  if (found === undefined) throw new Error(`${side} 飞机库中没有轰炸机`)
  return found
}

/** 地面战斗单位（15.4 缩减的执行者候选：RE 合计须 ≥ 1，故取 RE ≥1 者） */
function combatRecord(side: Side): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(
    (record) => record.isCombat === true && (record.reSize ?? 0) >= 1,
  )
  if (found === undefined) throw new Error(`${side} 单位库中没有 RE ≥ 1 的战斗单位`)
  return found
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/**
 * B47（12.8e）：走到移动阶段的**「模式与移动」环节**
 *
 * 突围环节是该段的**首环节**（"before any other movement"）—— 场上有断补单位时它会占住当前环节，
 * 故这些用例在 `setPhase('movement')
  goToMovementStep(store)` 之后要先按流程走一环，再调各自的动作。
 */
function goToMovementStep(store: {
  playerSegmentSteps: readonly { id: string }[]
  setSegmentStepIndex(index: number): boolean
}): void {
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement')
  if (index >= 0) store.setSegmentStepIndex(index)
}
describe('C9 空军交互：任务分配与 14.2f 全流程', () => {
  /** 摆一个本方基地 + 一架激活战机（14.1a：飞机停在基地格） */
  function setupBaseAndPlane(store: ReturnType<typeof newStore>) {
    const base = toConsoleUnit({
      record: airBaseRecord(),
      instanceId: 'base-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(base)
    const plane = toConsoleAirUnit({
      aircraft: fighterRecord('axis'),
      instanceId: 'air-1',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    store.airUnits.push(plane)
    return { base, plane }
  }

  it('★ 归属权：飞机停在**敌方**基地格内不得起飞（14.1a）', () => {
    const store = newStore()
    store.setAirActive(true)
    // 基地属于苏方，飞机是轴方的 ⇒ 该格不是「友方空军基地」
    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-enemy',
        hex: CORE_HEX,
        side: 'soviet',
      }),
    )
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: fighterRecord('axis'),
        instanceId: 'air-1',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    expect(store.setAirTargetFromText(label(CORE_HEX))).toBe(true)
    store.toggleAirMissionUnit('air-1')
    expect(store.beginAirMissionNow()).toBe(false)
    expect(store.airError).toMatchObject({ rule: '14.1a', reason: 'aircraftBaseNotFriendly:air-1' })
  })

  it('起飞格没有空军基地 ⇒ 拒绝（14.1a）', () => {
    const store = newStore()
    store.setAirActive(true)
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: bomberRecord('axis'),
        instanceId: 'air-1',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    store.setAirTargetFromText(label(CORE_HEX))
    store.toggleAirMissionUnit('air-1')
    expect(store.beginAirMissionNow()).toBe(false)
    expect(store.airError?.reason).toBe('aircraftNotInAirBaseHex:air-1')
  })

  it('非激活飞机不得执行任务（14.1a）；新到飞机默认非激活', () => {
    const store = newStore()
    store.setAirActive(true)
    const { plane } = setupBaseAndPlane(store)
    plane.airStatus = 'inactive'
    store.setAirTargetFromText(label(CORE_HEX))
    store.toggleAirMissionUnit(plane.instanceId)
    expect(store.beginAirMissionNow()).toBe(false)
    expect(store.airError).toMatchObject({ rule: '14.1a', reason: 'aircraftNotActive:air-1' })
  })

  it('14.2f A–G 走通：宣布 → 空战（无敌基地⇒不打）→ 拦截（放弃）→ 防空（未命中）→ 结算 → 返航', () => {
    const store = newStore()
    store.setAirActive(true)
    const { plane } = setupBaseAndPlane(store)

    expect(store.setAirTargetFromText(label(CORE_HEX))).toBe(true)
    store.toggleAirMissionUnit(plane.instanceId)
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.airState?.step).toBe('airCombat')

    // C 空战：任务格内没有敌方空军基地 ⇒ 不发生（14.3）
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.airState?.combat).toMatchObject({ occurs: false, enemyAirBaseInHex: false })
    expect(store.airState?.step).toBe('interception')

    // D 拦截：没有敌方战斗机 ⇒ 对手放弃（14.5 不强制）
    expect(store.airInterceptionResponse?.eligible).toBe(false)
    expect(store.declareInterceptionNow()).toBe(true)
    expect(store.airState?.interception).toMatchObject({ declared: false, interceptorId: null })
    expect(store.airState?.step).toBe('flak')

    // E 防空：2 骰固定 2 ⇒ 不命中（14.4e：修正后 ≥11 才命中）
    store.airInputs.flakDie = 2
    expect(store.resolveFlakNow()).toBe(true)
    expect(store.airState?.flak).toMatchObject({ applies: true, hit: false })
    expect(store.airState?.step).toBe('resolveMission')

    // F 结算（结果由玩家记入）
    store.airInputs.missionNote = '轰炸：格值 DG'
    expect(store.confirmAirMissionNow()).toBe(true)
    expect(store.airState?.missionNote).toBe('轰炸：格值 DG')
    expect(store.airState?.step).toBe('returnToBase')

    // G 返航：回本方基地 ⇒ 转非激活（14.1c）；本阶段该机已用掉任务（14.2e）
    expect(store.completeAirReturnNow()).toBe(true)
    expect(store.airState?.step).toBe('done')
    expect(store.airState?.finished).toBe(true)
    expect(plane.airStatus).toBe('inactive')
    expect(plane.missionsFlownThisPhase).toBe(1)

    // 14.2e：同一阶段不能再执行任务（清场后单独看这一条）
    store.cancelAir()
    store.toggleAirUnitStatus(plane.instanceId)
    store.setAirTargetFromText(label(CORE_HEX))
    store.toggleAirMissionUnit(plane.instanceId)
    expect(store.beginAirMissionNow()).toBe(false)
    expect(store.airError?.reason).toBe('aircraftAlreadyFlewMissionThisPhase:air-1')
  })

  /**
   * B29b-1：**air→barrage 桥**（14.7b / 10.2）
   *
   * 规则：10.2a「空军单位需要放置在目标上来结算它们的轰炸」；10.2b 短程 +1 列；
   * **10.2c「空军轰炸没有补给消耗」**；14.7「最多四个飞机参与同一次轰炸」。
   *
   * ★ 一条**测法边界（如实）**：本用例钉到"**进了同一条轰炸链**"（kind=air / 靶标=任务格 /
   *   参炸机=任务编成 / 付款步按 10.2c waived 0 T）。链子后半段（横移 → 掷骰 → 战果 → 落 CRT）
   *   是**炮兵已在用、已有 14 条用例覆盖**的同一段代码（`barrage-interaction-flow`），
   *   故此处不重跑一遍（重跑只是同一路径的第二次验证）。
   */
  it('★ 14.7b / 10.2c：空军轰炸任务在 14.2f-F 步入轰炸链（kind＝air、0 T）', () => {
    const store = newStore()
    store.setAirActive(true)
    const { plane } = setupBaseAndPlane(store)
    /*
     * 先把 SOP 走在**轰炸环节**上：`setPhase` 会重置本阶段状态（含空军会话），
     * 故这两步必须在**宣布任务之前**做完 —— 否则任务一宣布就被换阶段的清理抹掉。
     */
    store.setPhase('movement')
    goToMovementStep(store)
    const stepIndex = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.barrage')
    if (stepIndex < 0) throw new Error('C 段没有轰炸环节？')
    expect(store.setSegmentStepIndex(stepIndex)).toBe(true)
    store.airMissionKind = 'barrage'
    expect(store.setAirTargetFromText(label(CORE_HEX))).toBe(true)
    store.toggleAirMissionUnit(plane.instanceId)
    expect(store.beginAirMissionNow()).toBe(true)
    // C 空战（无敌基地 ⇒ 不发生）→ D 拦截（放弃）→ E 防空（不命中）→ 到 F 结算
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    store.airInputs.flakDie = 2
    expect(store.resolveFlakNow()).toBe(true)
    expect(store.airState?.step).toBe('resolveMission')

    expect(store.beginAirBarrageNow()).toBe(true)
    expect(store.barrageState?.kind).toBe('air')
    expect(store.barrageState?.targetHex).toEqual(CORE_HEX)
    expect(store.barrageState?.units.map((unit) => unit.unitId)).toEqual([plane.instanceId])
    // 10.2c：空军轰炸没有补给消耗 ⇒ 付款步 waived、0 T
    expect(store.confirmBarrageSupplyStep()).toBe(true)
    expect(store.barrageState?.supply).toMatchObject({ requiredT: 0, waived: true, rule: '10.2c' })
    // 10.0e-A 的账本照旧记账（同一套链）
    expect(store.barrageState?.step).toBe('shifts')
  })

  it('14.2d：任务格超出航程即拒（距离自起飞基地起算）', () => {
    const store = newStore()
    store.setAirActive(true)
    const { plane } = setupBaseAndPlane(store)
    plane.rangeHexes = 0
    // 任务格取基地的邻格（距离 1 > 航程 0）
    store.setAirTargetFromText(label(NEAR_HEX))
    store.toggleAirMissionUnit(plane.instanceId)
    expect(store.beginAirMissionNow()).toBe(false)
    expect(store.airError).toMatchObject({ rule: '14.2d', reason: 'aircraftOutOfRange:air-1:1>0' })
  })

  it('14.1f：天气禁飞即不可宣布任务', () => {
    const store = newStore()
    store.setAirActive(true)
    const { plane } = setupBaseAndPlane(store)
    store.airInputs.flyingAllowed = false
    store.setAirTargetFromText(label(CORE_HEX))
    store.toggleAirMissionUnit(plane.instanceId)
    expect(store.beginAirMissionNow()).toBe(false)
    expect(store.airError).toMatchObject({ rule: '14.1f', reason: 'weatherProhibitsFlying' })
  })
})

describe('C9 空军交互：14.5 拦截应答与 14.4 防空', () => {
  it('对手在巡逻区内有激活战斗机 ⇒ 可拦截；宣布后按空战结算，胜则保持激活（14.5）', () => {
    const store = newStore()
    store.setAirActive(true)
    // 轴方：基地 + 轰炸机（任务方）
    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-ax',
        hex: CORE_HEX,
        side: 'axis',
      }),
    )
    const bomber = toConsoleAirUnit({
      aircraft: bomberRecord('axis'),
      instanceId: 'bomber-1',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    store.airUnits.push(bomber)
    // 苏方：基地 + 激活战斗机（14.4c：巡逻区由本方基地 + 激活战斗机产生）
    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-su',
        hex: NEAR_HEX,
        side: 'soviet',
      }),
    )
    const interceptor = toConsoleAirUnit({
      aircraft: fighterRecord('soviet'),
      instanceId: 'fighter-su',
      hex: NEAR_HEX,
      side: 'soviet',
      airStatus: 'active',
    })
    store.airUnits.push(interceptor)

    store.setAirTargetFromText(label(CORE_HEX))
    store.toggleAirMissionUnit(bomber.instanceId)
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.confirmAirCombatNow()).toBe(true)

    // 14.5：任务格在本方（苏）巡逻区内 ⇒ 可拦；本任务受防空影响（轰炸 always）
    expect(store.airTargetInEnemyPatrolZone).toBe(true)
    expect(store.airInterceptionResponse).toMatchObject({ eligible: true })
    expect(store.airInterceptorCandidates.map((air) => air.instanceId)).toEqual(['fighter-su'])

    store.airInputs.interceptDeclared = true
    store.airInputs.interceptorId = 'fighter-su'
    expect(store.declareInterceptionNow()).toBe(true)
    expect(store.airState?.interception).toMatchObject({
      declared: true,
      interceptorId: 'fighter-su',
    })

    // 14.5：按空战结算；2 骰 12 + 拦截机 ACV − 迎战机 ACV ≥ 8 ⇒ 任务机返航 ⇒ 拦截成功保持激活
    store.airInputs.interceptDie = 12
    store.airInputs.interceptLossDie = 1
    expect(store.resolveInterceptionCombatNow()).toBe(true)
    const combat = store.airState?.interception?.combat
    expect(combat?.interceptorWon).toBe(true)
    expect(interceptor.airStatus).toBe('active')
    // 14.5：获胜的拦截机不算执行过任务 ⇒ 本阶段未用掉任务
    expect(store.airState?.interception?.combat?.interceptorCountsAsMission).toBe(false)
  })

  it('14.4f：防空命中时按任务损失表把损失落到任务机（军力 −1）', () => {
    const store = newStore()
    store.setAirActive(true)
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
    )
    const bomber = toConsoleAirUnit({
      aircraft: bomberRecord('axis'),
      instanceId: 'bomber-1',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    store.airUnits.push(bomber)

    store.setAirTargetFromText(label(CORE_HEX))
    store.toggleAirMissionUnit(bomber.instanceId)
    store.beginAirMissionNow()
    store.confirmAirCombatNow()
    store.declareInterceptionNow()
    // 14.4e：2 骰 12 ⇒ 修正后必 ≥11 ⇒ 命中；单机任务 ⇒ 损失必落该机（14.4f）
    store.airInputs.flakDie = 12
    store.airInputs.lossDie = 1
    expect(store.resolveFlakNow()).toBe(true)
    expect(store.airState?.flak).toMatchObject({ hit: true, lossAircraftId: 'bomber-1' })
    expect(bomber.steps).toBe(1)
  })
})

describe('C9 空军交互：15.1 整备额度', () => {
  function setupRefit(store: ReturnType<typeof newStore>) {
    const base = toConsoleUnit({
      record: airBaseRecord(),
      instanceId: 'base-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(base)
    const plane = toConsoleAirUnit({
      aircraft: fighterRecord('axis'),
      instanceId: 'air-1',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'inactive',
    })
    store.airUnits.push(plane)
    // 12.1b：补给站放在基地格 ⇒ 12.3a 直接拖取距离 0（15.1B 的 1T 由此支付）
    store.setSupplyActive(true)
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    store.addSpDump()
    return { base, plane }
  }

  it('15.1A：只在飞机整备阶段整备（C 移动段被拒）', () => {
    const store = newStore()
    store.setAirActive(true)
    setupRefit(store)
    expect(store.refitBaseNow('base-1')).toBe(false)
    // ★ B8：段/环节不对的拒绝由**统一闸门**给出（一次拦截，不再走引擎的 phase 判断）
    expect(store.actionRefusal).toMatchObject({ key: 'air.refit', rule: '15.1' })
  })

  it('15.1：A 段整备 1 架 ⇒ 转激活、扣 1T、本阶段该基地不可再整备', () => {
    const store = newStore()
    store.setAirActive(true)
    const { plane } = setupRefit(store)
    store.setPhase('aircraftRefit')

    expect(store.refitBaseNow('base-1')).toBe(true)
    expect(plane.airStatus).toBe('active')
    expect(store.lastRefit).toMatchObject({ costT: 1, activateAircraftIds: ['air-1'] })
    // 15.1B：1T 从补给站扣（1 SP = 4T ⇒ 找零后余 3T）
    expect(store.spDumps[0]).toMatchObject({ sp: 0, t: 3 })
    // 15.1A：每基地每整备阶段一次
    expect(store.refitDoneBases.map((base) => base.id)).toEqual(['base-1'])

    plane.airStatus = 'inactive'
    expect(store.refitBaseNow('base-1')).toBe(false)
    expect(store.airError?.reason).toBe('baseAlreadyRefitThisPhase')
  })

  it('15.1B：没有可支付的补给站 ⇒ T 不足被拒', () => {
    const store = newStore()
    store.setAirActive(true)
    const base = toConsoleUnit({
      record: airBaseRecord(),
      instanceId: 'base-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(base)
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: fighterRecord('axis'),
        instanceId: 'air-1',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'inactive',
      }),
    )
    store.setPhase('aircraftRefit')
    expect(store.refitBaseNow('base-1')).toBe(false)
    expect(store.airError).toMatchObject({ rule: '15.1B', reason: 'insufficientRefitT' })
  })

  it('14.2a：整备后激活堆叠不得超限（4 + 等级）', () => {
    const store = newStore()
    store.setAirActive(true)
    setupRefit(store)
    store.setPhase('aircraftRefit')
    // 停在基地格的激活飞机塞满上限（1 级基地上限 5），再整备即超限
    const fighter = fighterRecord('axis')
    for (let index = 0; index < 5; index += 1) {
      store.airUnits.push(
        toConsoleAirUnit({
          aircraft: fighter,
          instanceId: `filler-${index}`,
          hex: CORE_HEX,
          side: 'axis',
          airStatus: 'active',
        }),
      )
    }
    expect(store.refitBaseNow('base-1')).toBe(false)
    expect(store.airError).toMatchObject({
      rule: '14.2a',
      reason: 'activeStackingLimitExceeded:6>5',
    })
  })
})

describe('C9 空军交互：14.11 基地转移与 15.4 基地缩减', () => {
  it('14.11：转移后落到目标**本方**基地；战斗机在正常距离内保持激活', () => {
    const store = newStore()
    store.setAirActive(true)
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-a', hex: CORE_HEX, side: 'axis' }),
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-b', hex: NEAR_HEX, side: 'axis' }),
    )
    const plane = toConsoleAirUnit({
      aircraft: fighterRecord('axis'),
      instanceId: 'air-1',
      hex: CORE_HEX,
      side: 'axis',
      airStatus: 'active',
    })
    store.airUnits.push(plane)
    expect(plane.rangeHexes).toBeGreaterThanOrEqual(1)

    store.airInputs.transferToHexText = label(NEAR_HEX)
    expect(store.transferAircraftNow('air-1')).toBe(true)
    expect(plane.hex).toEqual(NEAR_HEX)
    // 14.11：战斗机在正常距离（1 ≤ 航程）内 ⇒ 保持激活
    expect(plane.airStatus).toBe('active')
    expect(store.lastTransfer).toMatchObject({ airStatus: 'active', distanceHexes: 1 })
  })

  it('14.11：目标是**敌方**基地即拒（★ 归属权）', () => {
    const store = newStore()
    store.setAirActive(true)
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-a', hex: CORE_HEX, side: 'axis' }),
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-b',
        hex: NEAR_HEX,
        side: 'soviet',
      }),
    )
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: fighterRecord('axis'),
        instanceId: 'air-1',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    store.airInputs.transferToHexText = label(NEAR_HEX)
    expect(store.transferAircraftNow('air-1')).toBe(false)
    expect(store.airError).toMatchObject({ rule: '14.11', reason: 'transferToEnemyAirBase:base-b' })
  })

  it('15.4：移动阶段由被指定单位降级；非移动阶段被拒（15.4）', () => {
    const store = newStore()
    store.setAirActive(true)
    // 2 级基地才能降级（15.0c：永不降到 1 级以下）
    const base = toConsoleUnit({
      record: airBaseRecord(2),
      instanceId: 'base-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(base)
    const worker = toConsoleUnit({
      record: combatRecord('axis'),
      instanceId: 'worker-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(worker)

    // C 移动段：降一级
    store.setPhase('movement')
    goToMovementStep(store)
    store.airInputs.reductionUnitIds = ['worker-1']
    const levelBefore = base.noncombatLevel
    expect(store.reduceBaseNow('base-1')).toBe(true)
    expect(base.noncombatLevel).toBe(levelBefore - 1)
    expect(worker.movementEnded).toBe(true)
    expect(store.reducedBases.map((item) => item.id)).toEqual(['base-1'])

    // 15.4：同一基地本阶段只能缩减一次
    expect(store.reduceBaseNow('base-1')).toBe(false)
    expect(store.airError?.reason).toBe('baseAlreadyReducedThisPhase')

    // 换到 F 战斗段 ⇒ 15.4 只在移动阶段（换阶段会清空阶段标记，但阶段本身仍不允许）
    store.setPhase('combat')
    store.airInputs.reductionUnitIds = ['worker-1']
    expect(store.reduceBaseNow('base-1')).toBe(false)
    // ★ B8：同上——15.4 只在移动阶段，由统一闸门给（原因是"环节不对"而不是域内细则）
    expect(store.actionRefusal).toMatchObject({ key: 'air.baseReduce', rule: '15.4' })
  })

  it('15.2E：简易机场永不缩减（声明后即被拒）', () => {
    const store = newStore()
    store.setAirActive(true)
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
    )
    store.units.push(
      toConsoleUnit({
        record: combatRecord('axis'),
        instanceId: 'worker-1',
        hex: CORE_HEX,
        side: 'axis',
      }),
    )
    store.toggleAirstripBase('base-1')
    expect(store.airBases[0]).toMatchObject({ isAirstrip: true, level: 0 })
    store.setPhase('movement')
    goToMovementStep(store)
    store.airInputs.reductionUnitIds = ['worker-1']
    expect(store.reduceBaseNow('base-1')).toBe(false)
    expect(store.airError).toMatchObject({ rule: '15.2E', reason: 'airstripCannotBeReduced' })
  })
})

describe('C9 空军交互：9.14f 基地夺取', () => {
  it('9.14f：敌方可攻击单位进入基地格 ⇒ 基地翻面归夺取方，格内飞机按表 17-6 转移并转非激活', () => {
    const store = newStore()
    store.setAirActive(true)
    // 苏方基地（被夺取方）+ 1 架激活战斗机停在基地格
    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-su',
        hex: CORE_HEX,
        side: 'soviet',
      }),
    )
    const plane = toConsoleAirUnit({
      aircraft: fighterRecord('soviet'),
      instanceId: 'air-su',
      hex: CORE_HEX,
      side: 'soviet',
      airStatus: 'active',
    })
    store.airUnits.push(plane)
    // 苏方另一个基地（供幸存飞机按「2 倍距离内」转移）
    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-su-2',
        hex: NEAR_HEX,
        side: 'soviet',
      }),
    )

    // 表 17-6：每架飞机掷 2 骰，≥7 无损失（此处给 12 ⇒ 无损失）
    store.airInputs.baseCaptureDice = 12
    expect(store.captureAirBaseNow('base-su')).toBe(true)

    // ★ 归属权：基地算子翻面 ⇒ 归夺取方（此后只有轴方能用它）
    expect(store.units.find((unit) => unit.instanceId === 'base-su')?.side).toBe('axis')
    // 飞机转移到 2 倍距离内的友方基地，并转非激活
    expect(plane.hex).toEqual(NEAR_HEX)
    expect(plane.airStatus).toBe('inactive')
    expect(plane.steps).toBe(2)
  })

  it('9.14f：2 倍距离内没有友方基地 ⇒ 幸存飞机被摧毁', () => {
    const store = newStore()
    store.setAirActive(true)
    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-su',
        hex: CORE_HEX,
        side: 'soviet',
      }),
    )
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: fighterRecord('soviet'),
        instanceId: 'air-su',
        hex: CORE_HEX,
        side: 'soviet',
        airStatus: 'active',
      }),
    )
    // 没有第二个苏方基地 ⇒ 无处可转
    store.airInputs.baseCaptureDice = 12
    expect(store.captureAirBaseNow('base-su')).toBe(true)
    expect(store.airUnits.map((air) => air.instanceId)).not.toContain('air-su')
  })
})

describe('C9 空军交互：14.3e 逐轮空战与 14.10d 空投检定（端到端）', () => {
  /**
   * 运输机（14.9a：算子印有运输容量）
   *
   * ⚠ **数据缺口**：`aircraft.json` 的 `transportCapacity` 全部为 `null`（22 型皆未落值），
   * 故此处按 14.9a 的口径在**操作台视图**上给定容量，专测 14.9/14.10 的交互逻辑；
   * 待数据补齐后应改为直接取印值，无需手工赋容量。
   */
  const transportRecord = (side: Side): ReturnType<typeof aircraftChoices>[number] => {
    const found = aircraftChoices(side).find((record) => record.aircraftType === 'Tpt')
    if (found === undefined) throw new Error(`${side} 飞机库中没有运输机（Tpt）`)
    return found
  }
  const withCapacity = (unit: ReturnType<typeof toConsoleAirUnit>, capacity: number) => {
    unit.transportCapacity = capacity
    return unit
  }

  it('14.3e：任务格内有敌方基地且双方都有激活机 ⇒ 发生空战并逐轮推进到一方清空', () => {
    const store = newStore()
    store.setAirActive(true)
    // 双方基地都在任务格（14.3：有敌方基地才打空战）
    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-ax',
        hex: CORE_HEX,
        side: 'axis',
      }),
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-su',
        hex: CORE_HEX,
        side: 'soviet',
      }),
    )
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: fighterRecord('axis'),
        instanceId: 'air-ax',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
      toConsoleAirUnit({
        aircraft: fighterRecord('soviet'),
        instanceId: 'air-su',
        hex: CORE_HEX,
        side: 'soviet',
        airStatus: 'active',
      }),
    )
    store.setAirTargetFromText(label(CORE_HEX))
    store.toggleAirMissionUnit('air-ax')
    expect(store.beginAirMissionNow()).toBe(true)

    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.airState?.combat?.occurs).toBe(true)
    // 14.3e：逐轮空战结论落盘（轮次记录 + 存亡名单）
    expect(store.airState?.airCombat).not.toBeNull()
    expect(store.airState!.airCombat!.rounds.length).toBeGreaterThanOrEqual(0)
    expect(['oneSideOnly', 'noCombatCapability', 'diceExhausted']).toContain(
      store.airState!.airCombat!.stopReason,
    )
  })

  /**
   * B29b-2：14.3e-B 的**逐轮点名**（store 侧接线）
   *
   * 引擎侧的点名规则（采纳 / 缺省取 ACV 最高 / 括号机不得作攻方）由
   * `tests/engine/air-interaction.test.ts` 的"14.3e-B：逐轮点名（picks）"覆盖；
   * 此处只钉 **store 把玩家的点名真的传下去了**（且未点名时行为与修前一样全自动）。
   */
  const twoFighters = () => {
    const fighters = aircraftChoices('axis')
      .filter(
        (record) =>
          record.aircraftType === 'F' && record.airAbilities?.canInitiateAirCombat !== false,
      )
      .sort((a, b) => (b.airCombatRating ?? 0) - (a.airCombatRating ?? 0))
    const high = fighters[0]
    const low = fighters.find(
      (record) => (record.airCombatRating ?? 0) < (high?.airCombatRating ?? 0),
    )
    if (high === undefined || low === undefined)
      throw new Error('轴方飞机库缺少 ACV 不同的两型战斗机')
    return { high, low }
  }

  /** 空战场面：同格双方基地 + 两架轴方战斗机（ACV 不同）+ 一架苏方战斗机，并已宣布任务 */
  function setupAirCombat(store: ReturnType<typeof newStore>): void {
    const { high, low } = twoFighters()
    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-ax',
        hex: CORE_HEX,
        side: 'axis',
      }),
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-su',
        hex: CORE_HEX,
        side: 'soviet',
      }),
    )
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: high,
        instanceId: 'air-high',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
      toConsoleAirUnit({
        aircraft: low,
        instanceId: 'air-low',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
      toConsoleAirUnit({
        aircraft: fighterRecord('soviet'),
        instanceId: 'air-su',
        hex: CORE_HEX,
        side: 'soviet',
        airStatus: 'active',
      }),
    )
    expect(store.setAirTargetFromText(label(CORE_HEX))).toBe(true)
    store.toggleAirMissionUnit('air-high')
    expect(store.beginAirMissionNow()).toBe(true)
  }

  it('★ 14.3e-B：未点名 ⇒ 第 1 轮由引擎取 **ACV 最高**的那一架', () => {
    const store = newStore()
    store.setAirActive(true)
    setupAirCombat(store)
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.airState?.airCombat?.rounds[0]?.attackerAircraftId).toBe('air-high')
  })

  it('★ 14.3e-B：攻方逐轮点名 ⇒ 点名的那一架就是第 1 轮参战的那一架', () => {
    const store = newStore()
    store.setAirActive(true)
    setupAirCombat(store)
    // 点 ACV 较低的那一架（若点名没被传下去，引擎会取 air-high）
    store.airInputs.airCombatPicks = [{ attackerAircraftId: 'air-low', defenderAircraftId: null }]
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.airState?.airCombat?.rounds[0]?.attackerAircraftId).toBe('air-low')
  })

  it('★ 14.3e-B / 14.5：未点名的迎战机取 **ACV 最高**（与引擎缺省同口径）', () => {
    const store = newStore()
    store.setAirActive(true)
    const { high, low } = twoFighters()

    store.units.push(
      toConsoleUnit({
        record: airBaseRecord(),
        instanceId: 'base-ax',
        hex: CORE_HEX,
        side: 'axis',
      }),
    )
    store.airUnits.push(
      toConsoleAirUnit({
        aircraft: high,
        instanceId: 'air-high',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
      toConsoleAirUnit({
        aircraft: low,
        instanceId: 'air-low',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
    )
    expect(store.setAirTargetFromText(label(NEAR_HEX))).toBe(true)
    store.toggleAirMissionUnit('air-high')
    store.toggleAirMissionUnit('air-low')
    expect(store.beginAirMissionNow()).toBe(true)

    // 缺省＝ACV 最高（修前是"名单第一架"，两处口径不一致）
    expect(store.airInterceptionDefender?.instanceId).toBe('air-high')
    // 点名即按点名取
    store.airInputs.namedDefenderId = 'air-low'
    expect(store.airInterceptionDefender?.instanceId).toBe('air-low')
  })

  /**
   * B29b-2：**载货入口**（14.9 / 14.10）—— 候选投影 + 面板直连的勾选动作
   *
   * 修前这些输入只在 store 与用例里，面板没有入口 ⇒ 玩家无法宣布一次带货的任务。
   * 此处钉"候选怎么来、勾选怎么落、宣布后真的进货物清单"三件事；
   * 14.10a 的资格声明与 14.10b 的计划回合由既有用例（下一条）覆盖。
   */
  it('★ 14.10a：单位货物候选＝图上本方地面战斗单位（且**移动模式**）；勾选后宣布任务即进货物清单', () => {
    const store = newStore()
    store.setAirActive(true)
    store.setAirMissionKind('air_drop')
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
      toConsoleUnit({
        record: combatRecord('axis'),
        instanceId: 'para-1',
        hex: NEAR_HEX,
        side: 'axis',
      }),
      toConsoleUnit({
        record: combatRecord('soviet'),
        instanceId: 'enemy-1',
        hex: NEAR_HEX,
        side: 'soviet',
      }),
    )
    /*
     * ★ 契约变更（第五批批 C 切片 2，**收紧不是放宽**）：14.9c「处于**移动模式**的战斗单位
     *   也可以空运」——空投沿袭 14.9 全部规则 ⇒ 候选与宣布都只认移动模式的单位。
     *   夹具把被装载单位切到移动模式（在**代理上**改，裸对象不触发 computed 失效）。
     */
    const cargoUnit = store.units.find((unit) => unit.instanceId === 'para-1')
    if (cargoUnit === undefined) throw new Error('夹具里找不到 para-1')
    cargoUnit.mode.mode = 'move'
    // 候选只列本方（engine 侧再过滤资格/运力）
    expect(store.airCargoUnitChoices.map((unit) => unit.instanceId)).toEqual(['para-1'])

    // 勾选 → 再点一次移出 → 再点一次加入（面板的"点一枚加入/移出"）
    store.toggleAirCargoUnit('para-1')
    expect(store.airInputs.cargoUnitIds).toEqual(['para-1'])
    store.toggleAirCargoUnit('para-1')
    expect(store.airInputs.cargoUnitIds).toEqual([])
    store.toggleAirCargoUnit('para-1')

    const transport = withCapacity(
      toConsoleAirUnit({
        aircraft: transportRecord('axis'),
        instanceId: 'tpt-1',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
      2,
    )
    store.airUnits.push(transport)
    expect(store.setAirTargetFromText(label(NEAR_HEX))).toBe(true)
    store.toggleAirMissionUnit('tpt-1')
    /*
     * 14.10b：「空投**战斗单位**属需计划的任务」——计划回合须比执行回合早 ≥2。
     * 三行按顺序各钉一次：计划不对 ⇒ 拒（规则号 14.10b）；改对 ⇒ 宣布成功。
     */
    store.setTurn(3)
    store.airInputs.airdropPlannedTurn = 1
    store.airInputs.airdropScheduledTurn = 5 // ≠ 当前回合 ⇒ 计划与执行回合不符（14.10b）
    expect(store.beginAirMissionNow()).toBe(false)
    expect(store.airError).toMatchObject({ rule: '14.10b' })
    // 计划先于执行 ≥2 回合（1 → 3）且执行回合＝当前回合 ⇒ 宣布成功
    store.airInputs.airdropPlannedTurn = 1
    store.airInputs.airdropScheduledTurn = 3
    expect(store.beginAirMissionNow()).toBe(true)
    // 14.10a：货物清单里出现的是"单位货物"（id 带 unit: 前缀）
    expect(store.airError).toEqual(null) // 调试：先用它把拒绝原因打出来
    expect(store.airState?.assignment.cargo.map((item) => item.id)).toEqual(['unit:para-1'])
  })

  it('14.10d：空投 SP 货物（14.10b：补给空投不需预先计划）按表 17-4 检定后置入', () => {
    const store = newStore()
    store.setAirActive(true)
    store.setAirMissionKind('air_drop')
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
    )
    const transport = withCapacity(
      toConsoleAirUnit({
        aircraft: transportRecord('axis'),
        instanceId: 'tpt-1',
        hex: CORE_HEX,
        side: 'axis',
        airStatus: 'active',
      }),
      2,
    )
    store.airUnits.push(transport)

    store.setAirTargetFromText(label(NEAR_HEX))
    store.toggleAirMissionUnit('tpt-1')
    store.airInputs.cargoSpT = 2
    expect(store.beginAirMissionNow()).toBe(true)
    // 14.2f 逐步：C 空战（无敌方基地 ⇒ 不发生）→ D 拦截（放弃）→ E 防空（不命中）
    expect(store.confirmAirCombatNow()).toBe(true)
    expect(store.declareInterceptionNow()).toBe(true)
    store.airInputs.flakDie = 2
    expect(store.resolveFlakNow()).toBe(true)
    expect(store.airState?.step).toBe('resolveMission')

    // 表 17-4：2 骰 12 必成功
    store.airInputs.cargoDice = 12
    expect(store.resolveAirCargoNow()).toBe(true)
    expect(store.airState?.cargo?.items[0]).toMatchObject({ kind: 'sp', fate: 'placed' })
  })

  it('14.10a：空投**战斗单位**须该单位标有 Para 资格（否则拒绝）', () => {
    const store = newStore()
    store.setAirActive(true)
    store.setAirMissionKind('air_drop')
    store.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
    )
    store.airUnits.push(
      withCapacity(
        toConsoleAirUnit({
          aircraft: transportRecord('axis'),
          instanceId: 'tpt-1',
          hex: CORE_HEX,
          side: 'axis',
          airStatus: 'active',
        }),
        2,
      ),
    )
    const para = toConsoleUnit({
      record: combatRecord('axis'),
      instanceId: 'para-1',
      hex: CORE_HEX,
      side: 'axis',
    })
    store.units.push(para)
    /*
     * ★ 契约变更（第五批批 C 切片 2，**收紧不是放宽**）：14.9c 的「须处于移动模式」先行判定
     *   ⇒ 本用例要测的 14.10a「没 Para 资格被拒」须先把模式夹具摆对（否则先吃 14.9c）。
     */
    const paraOn = store.units.find((unit) => unit.instanceId === 'para-1')
    if (paraOn === undefined) throw new Error('夹具里找不到 para-1')
    paraOn.mode.mode = 'move'
    store.setAirTargetFromText(label(NEAR_HEX))
    store.toggleAirMissionUnit('tpt-1')
    store.airInputs.cargoUnitIds = ['para-1']
    store.airInputs.cargoUnitsParaCapable = false
    expect(store.beginAirMissionNow()).toBe(false)
    expect(store.airError).toMatchObject({ rule: '14.10a' })
  })
})
