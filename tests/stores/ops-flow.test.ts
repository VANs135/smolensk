import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'

import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { hexDistance } from '@/engine/hex-geometry'
import { sopStepsOf } from '@/engine/rules'
import {
  actionGateOf,
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  type ConsolePhase,
} from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  groundRecord,
  label,
  placeAir,
  placeGround,
} from '../flows/sop-harness'

/**
 * 三操作统一流程（2026-11-10 规格 §0–§5）
 *
 * 钉四件事：
 *   ① 炮击入口判据 = 10.1a 射程覆盖 + 10.0e 账本 + **10.1b 付得起**（付不起 ⇒ 菜单项缺席）；
 *   ② 右键菜单三项与窗内候选**同源**（都走 `barrageCandidatesAt` / `bombingCandidatesAt`）；
 *   ③ 第 1 步 → 第 2 步由 `advanceOpsFlow` 把球交给既有状态机（`barrageState` / `airState`）；
 *   ④ 地图外空军盒是**独立基地分组**且可出击（2.1C 只禁盒内战斗）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 把 store 放到允许该动作的环节（与既有流程测试同一路） */
function enterStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: Parameters<typeof actionGateOf>[0],
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

const TARGET_HEX: HexRef = NEAR_HEX

/** 敌方目标格守军（10.0a 的战斗单位目标） */
function defenderRecord() {
  return groundRecord('soviet', (record) => record.isCombat === true)
}

/** 带印刷轰炸值与射程的火炮（10.0e-B / 10.1a / 10.1b） */
function artilleryRecord() {
  return groundRecord(
    'axis',
    (record) =>
      (record.factors?.combat?.barrage ?? 0) > 0 && (record.factors?.combat?.range ?? 0) > 0,
  )
}

/** 有低空扫射能力的轴方机（14.7d-B） */
function hipShootRecord() {
  const found = aircraftChoices('axis').find(
    (record) => record.airAbilities?.canHipShoot === true && (record.barrageStrength ?? 0) > 0,
  )
  if (found === undefined) throw new Error('轴方飞机库中没有可低空扫射的机')
  return found
}

function airBaseRecord() {
  return groundRecord('axis', (record) => record.noncombatKind === 'air_base')
}

/** 有印刷轰炸值的轴方轰炸机（10.2b） */
function bomberRecord() {
  const found = aircraftChoices('axis').find(
    (record) => (record.barrageStrength ?? 0) > 0 && (record.rangeHexes ?? 0) >= 1,
  )
  if (found === undefined) throw new Error('轴方飞机库中没有可轰炸的机')
  return found
}

/** 炮击现场：C 段/F 段轰炸环节 + 邻格火炮 + 目标格守军 + 一座补给站 */
function setupBarrage(withDump: boolean) {
  const { workbench, mapView } = newStores()
  workbench.setPhase('combat')
  enterStep(workbench, 'barrage.declare')
  const gun = placeGround(workbench, artilleryRecord(), CORE_HEX, 'axis', 'art-1')
  placeGround(workbench, defenderRecord(), TARGET_HEX, 'soviet', 'def-1')
  if (withDump) {
    workbench.spDumps.push({ id: 'dump-1', hex: CORE_HEX, side: 'axis', sp: 0, t: 20 })
  }
  return { workbench, mapView, gun }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('炮击入口（10.1a / 10.0e / 10.1b）', () => {
  it('★ 射程覆盖 + 有补给 ⇒ 入口出现；付不起 ⇒ **项缺席**（不灰显、不弹提示）', () => {
    const funded = setupBarrage(true)
    expect(funded.workbench.barrageEntryEligible(TARGET_HEX)).toBe(true)

    const broke = setupBarrage(false)
    expect(broke.workbench.barrageEntryEligible(TARGET_HEX)).toBe(false)
    // 判据不过 ⇒ 右键菜单根本不出现（不是灰项）
    expect(broke.mapView.openUnitContext(TARGET_HEX, 'def-1', { x: 0, y: 0 })).toBe(false)
    expect(broke.mapView.contextOptions).toEqual([])
  })

  it('★ 候选与入口同源：射程打不到的炮兵不进候选（10.1a）', () => {
    const { workbench } = setupBarrage(true)
    const far = mapLayers.hexes.find((hex) => hexDistance(hex, TARGET_HEX) > 4)
    if (far === undefined) throw new Error('地图上找不到距离 >4 的格')
    const outOfRange = placeGround(
      workbench,
      artilleryRecord(),
      { col: far.col, row: far.row },
      'axis',
      'art-far',
    )
    const ids = workbench.barrageCandidatesAt(TARGET_HEX).map((unit) => unit.instanceId)
    expect(ids).toContain('art-1')
    expect(ids).not.toContain(outOfRange.instanceId)
  })
})

describe('统一流程：第 1 步 → 第 2 步（炮击）', () => {
  it('★ 选炮 → 下一步 ⇒ 宣布成功、会话仍是 `ops`、进第 2 步补给窗', () => {
    const { workbench, mapView, gun } = setupBarrage(true)
    expect(mapView.openOpsFlow('barrage', TARGET_HEX)).toBe(true)
    expect(mapView.opsFlow?.step).toBe(1)
    expect(mapView.session?.kind).toBe('ops')
    expect(mapView.session?.title).toContain('炮击')

    workbench.toggleBarrageUnit(gun.instanceId)
    expect(mapView.advanceOpsFlow()).toBe(true)
    expect(mapView.opsFlow?.step).toBe(2)
    expect(workbench.barrageState).not.toBeNull()

    // 取消整单 ⇒ 状态机回滚（10.1b 的账本不视为已炸过）
    expect(mapView.cancelOpsFlow()).toBe(true)
    expect(workbench.barrageState).toBeNull()
    expect(mapView.opsFlow).toBeNull()
  })
})

describe('统一流程：第 1 步 → 第 2 步（空军轰炸的自动结算）', () => {
  it('★ 选机 → 无拦截 → 直接结算轰炸骰 → 走到返航（修前停在 airCombat 等选机）', () => {
    const { workbench, mapView } = newStores()
    // 14.2e / 10.0e-C：空军轰炸在移动段的轰炸环节（C 段）宣布（F 段只给炮兵）
    workbench.setPhase('movement')
    const barrageIndex = workbench.playerSegmentSteps.findIndex(
      (step) => step.id === 'movement.barrage',
    )
    expect(barrageIndex).toBeGreaterThanOrEqual(0)
    expect(workbench.setSegmentStepIndex(barrageIndex)).toBe(true)
    placeGround(workbench, airBaseRecord(), CORE_HEX, 'axis', 'base-1')
    const bomber = placeAir(workbench, bomberRecord(), CORE_HEX, 'axis', 'bomber-1')
    placeGround(workbench, defenderRecord(), TARGET_HEX, 'soviet', 'def-1')

    expect(mapView.openOpsFlow('bombing', TARGET_HEX)).toBe(true)
    workbench.toggleAirMissionUnit(bomber.instanceId)
    expect(workbench.airMissionAirIds).toContain('bomber-1')

    expect(mapView.advanceOpsFlow()).toBe(true)
    // 14.3：目标格无敌方空军基地、无敌机 ⇒ 不发生空战，也不会有拦截
    expect(workbench.airState?.combat?.occurs).toBe(false)
    expect(workbench.airState?.interception?.declared).not.toBe(true)
    /*
     * 2026-11-15 玩家口径：发起后停在**面板 2（任务结算）**，由玩家点「结算任务」才进返航；
     * 面板 2 之前不跑对地结算。
     */
    expect(workbench.airState?.step).toBe('resolveMission')
    expect(workbench.barrageState).toBeNull()
    expect(mapView.sessionStep?.id).toBe('air:resolve')

    expect(workbench.settleAirMissionNow()).toBe(true)
    expect(workbench.airState?.step).toBe('returnToBase')
    // 10.2 / 14.7b：轰炸骰已结算并落账
    expect(workbench.barrageState?.outcome).toBeDefined()
  })
})

describe('候选同源（规格 §3 集合等式）', () => {
  it('★ 空军第 1 步只取候选函数给出的那批（不列未激活 / 已出任务 / 航程不够）', () => {
    /*
     * 用户 2026-11-13：选机并入面板 1 ⇒ 参战机阵列在 `AirPanel`，ops 面板不再列机。
     * 可选性仍只取 store 的同一份投影（`airMissionBaseGroupsWithBox` → `airMissionJoinChoices`，
     * 与右键入口的 `bombingCandidatesAt` / `hipShootCandidatesAt` 同源）。
     */
    const panel = readFileSync('src/components/air/AirPanel.vue', 'utf8')
    const ops = readFileSync('src/components/ops/OpsFlowPanel.vue', 'utf8')
    expect(panel).toContain('workbench.airMissionBaseGroupsWithBox')
    expect(ops).not.toContain('bombingCandidatesAt')
    expect(ops).not.toContain('hipShootCandidatesAt')
    // 不再在组件里按机型能力二次筛选（那是第二套判据）
    expect(panel).not.toContain('barrageStrength ?? 0) > 0')
    expect(panel).not.toContain('canHipShoot === true')
    expect(ops).not.toContain('barrageStrength ?? 0) > 0')
    expect(ops).not.toContain('canHipShoot === true')
  })
})

describe('炮击界面口径（§6-A4：按钮名＝实际动作）', () => {
  const panel = readFileSync('src/components/ops/OpsFlowPanel.vue', 'utf8')

  it('第 2 步空站提示与取消按钮都指向「取消本次」，不再承诺退回选子', () => {
    expect(panel).not.toContain('退回选子')
    expect(panel).toContain('点「取消本次」结束本次炮击')
  })

  it('设施目标（10.0c）不显示③受损单位步骤', () => {
    expect(panel).toContain("workbench.barrageTargetKind !== 'airBase'")
  })
})

describe('地图外空军盒（2.1C / 规格 §4 裁定③）', () => {
  it('★ 盒内驻机作为**独立基地分组**参与候选，且可被勾选出击', () => {
    const { workbench } = newStores()
    workbench.setPhase('movement')
    enterStep(workbench, 'air.mission')
    workbench.setAirActive(true)
    workbench.units.push(
      toConsoleUnit({ record: airBaseRecord(), instanceId: 'base-1', hex: CORE_HEX, side: 'axis' }),
    )
    placeAir(workbench, hipShootRecord(), CORE_HEX, 'axis', 'air-map')
    const boxed = toConsoleAirUnit({
      aircraft: hipShootRecord(),
      instanceId: 'air-box',
      hex: { col: 0, row: 0 },
      side: 'axis',
      airStatus: 'active',
    })
    workbench.airUnits.push(boxed)
    workbench.airBoxMembers.push('air-box')

    workbench.setAirMissionKind('hip_shoot')
    expect(workbench.setAirTargetFromText(label(TARGET_HEX))).toBe(true)

    const groups = workbench.airMissionBaseGroupsWithBox
    const boxGroup = groups.find((group) => group.baseId === '__offmap_air_box__')
    expect(boxGroup, '图外盒没有作为独立基地分组出现').toBeDefined()
    expect(boxGroup?.aircraft.map((item) => item.air.instanceId)).toContain('air-box')

    // 图上分组不含盒内机（两者互不串）
    const onMapIds = workbench.airMissionBaseGroups.flatMap((group) =>
      group.aircraft.map((item) => item.air.instanceId),
    )
    expect(onMapIds).toContain('air-map')
    expect(onMapIds).not.toContain('air-box')

    // 可勾选 ⇒ 参与任务（盒内整备等入口维持既有实现，这里只验出击）
    workbench.toggleAirMissionUnit('air-box')
    expect(workbench.airMissionAirIds).toContain('air-box')
  })
})

describe('F 战斗段的窗口纪律（2.2 F：炮击 → 战斗两节）', () => {
  it('★ 2.2：F 段恰好两节（炮击 → 战斗），没有第三个环节', () => {
    expect(sopStepsOf('combat').map((step) => step.id)).toEqual(['combat.barrage', 'combat.combat'])
  })

  it('★ 炮击环节的提示说炮击，不再落回「可移动范围」那句通用提示', () => {
    const { workbench, mapView } = setupBarrage(true)
    expect(workbench.segmentStep?.id).toBe('combat.barrage')
    expect(mapView.actionHint).toContain('炮击')
    expect(mapView.actionHint).not.toContain('可移动范围')
  })

  it('★ 源码守卫：对局台不摆打不了的目标 / 来源，裁判补记只在验证页', () => {
    const panel = readFileSync('src/components/barrage/BarragePanel.vue', 'utf8')
    // 本作无港口（专规 1.1c）⇒ 对局台不列「港口」目标
    expect(panel).toContain("kind.key !== 'port' || showsReferee")
    // 「海军（本作无）」这类不可用项不再作为可选项出现
    expect(panel).not.toContain('海军（本作无）')
    // 10.0e-A 的裁判补记勾选框收进 showsReferee
    expect(panel).toContain('v-if="showsReferee" class="row"')
    // 窗内的实现史长句已收进 ?（RuleTip）
    expect(panel).not.toContain('原先手填一个数字就算')
  })

  it('★ 源码守卫：战斗窗不再有独立的「清除来源」按钮（再点同站＝取消），也没有整段规则讲解', () => {
    const combat = readFileSync('src/components/combat/CombatPanel.vue', 'utf8')
    // B6：来源只走地图入口，面板不再摆清除按钮
    expect(combat).not.toContain('clearCombatSupplyDump')
    expect(combat).not.toContain('清除攻方')
    expect(combat).not.toContain('清除守方')
    // 规则讲解收进 ?，窗内不再留「在「打一仗」工具下…」的说明段
    expect(combat).not.toContain('在「打一仗」工具下')
  })
})

describe('G 进击段的窗口纪律（2.2 G：移动 → 射击 → 战斗三节）', () => {
  it('★ 2.2：G 段恰好三节（移动 → 轰炸 → 战斗），次序照原文', () => {
    expect(sopStepsOf('exploitation').map((step) => step.id)).toEqual([
      'exploitation.movement',
      'exploitation.barrage',
      'exploitation.combat',
    ])
  })

  it('★ 11.0a：普通单位不进进击移动的取子清单，进击模式单位才进', () => {
    const { workbench } = newStores()
    workbench.setPhase('exploitation')
    workbench.setSegmentStepIndex(
      workbench.playerSegmentSteps.findIndex((step) => step.id === 'exploitation.movement'),
    )
    const unit = placeGround(
      workbench,
      groundRecord('axis', (record) => record.attackCapable === true),
      CORE_HEX,
      'axis',
      'g-plain',
    )
    workbench.clickHex(CORE_HEX)
    expect(workbench.movePick).toBeNull()
    expect(workbench.moveBlocked?.rule).toBe('11.0a')

    unit.mode.exploit = true
    workbench.clickHex(CORE_HEX)
    expect(workbench.movePick?.ids).toEqual(['g-plain'])
  })

  it('★ 2.2 进击·射击：只有已释放的预备火炮进候选，普通/进击模式炮都不进', () => {
    const { workbench } = newStores()
    workbench.setPhase('exploitation')
    enterStep(workbench, 'barrage.declare')
    placeGround(workbench, artilleryRecord(), CORE_HEX, 'axis', 'g-gun')
    placeGround(workbench, defenderRecord(), TARGET_HEX, 'soviet', 'g-def')
    workbench.battleTarget = { hex: TARGET_HEX, defenderIds: ['g-def'] }
    workbench.setBarrageActive(true)

    // placeGround 返回的是裸对象，直接改不会触发 computed ⇒ 统一经 store 里的响应式代理写
    const reactiveGun = workbench.units.find((unit) => unit.instanceId === 'g-gun')!
    expect(workbench.barrageUnitChoices.map((choice) => choice.unit.instanceId)).not.toContain(
      'g-gun',
    )

    // 进击模式炮也不在 2.2 进击·射击的名单里（名单是「释放预备模式的火炮」）
    reactiveGun.mode = { ...reactiveGun.mode, exploit: true }
    expect(workbench.barrageUnitChoices.map((choice) => choice.unit.instanceId)).not.toContain(
      'g-gun',
    )

    reactiveGun.mode = {
      ...reactiveGun.mode,
      mode: 'reserve',
      releasedFromReserve: true,
    }
    expect(workbench.barrageUnitChoices.map((choice) => choice.unit.instanceId)).toContain('g-gun')
  })

  it('★ 11.0a：普通单位不能加入进击战斗的攻方；进击模式 / 已释放预备可以', () => {
    const { workbench } = newStores()
    workbench.setPhase('exploitation')
    enterStep(workbench, 'combat.declare')
    const attacker = placeGround(
      workbench,
      groundRecord('axis', (record) => record.attackCapable === true),
      CORE_HEX,
      'axis',
      'g-a',
    )
    placeGround(workbench, defenderRecord(), NEAR_HEX, 'soviet', 'g-d')

    workbench.toggleCombatAttacker('g-a')
    expect(workbench.combatAttackerIds).not.toContain('g-a')
    expect(workbench.log[0]!.text).toContain('11.0a')

    attacker.mode.exploit = true
    workbench.toggleCombatAttacker('g-a')
    expect(workbench.combatAttackerIds).toContain('g-a')
  })

  it('★ 进击两环的提示按环节分流，不落回通用「可移动范围」', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('exploitation')
    workbench.setSegmentStepIndex(
      workbench.playerSegmentSteps.findIndex((step) => step.id === 'exploitation.movement'),
    )
    expect(mapView.actionHint).toContain('进击移动')

    workbench.setSegmentStepIndex(
      workbench.playerSegmentSteps.findIndex((step) => step.id === 'exploitation.barrage'),
    )
    expect(mapView.actionHint).toContain('进击轰炸')
  })
})

describe('C 移动段的轰炸环节提示（10.0 · air only）', () => {
  it('★ movement.barrage 不得落回「可移动范围」，要指向空中轰炸', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('movement')
    workbench.setSegmentStepIndex(
      workbench.playerSegmentSteps.findIndex((step) => step.id === 'movement.barrage'),
    )
    expect(mapView.actionHint).not.toContain('可移动范围')
    expect(mapView.actionHint).toContain('轰炸')
  })
})

describe('D 补给段的顶栏提示（12.1 / 12.6 / 12.10e）', () => {
  it('★ supply 段不得落回「可移动范围」，要指向补给面板', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('supply')
    expect(mapView.actionHint).not.toContain('可移动范围')
    expect(mapView.actionHint).toContain('补给')
  })
})

describe('H 清理段的顶栏提示（2.2）', () => {
  it('★ cleanUp 不得落回「点己方算子＝可移动范围」，要说明本段自动结算', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('cleanUp')
    expect(mapView.actionHint).not.toContain('可移动范围')
    expect(mapView.actionHint).toContain('清理')
  })
})

describe('B 增援段的顶栏提示（13.6 / 1.6b / 13.5）', () => {
  const gotoReinforcementStep = (
    workbench: ReturnType<typeof newStores>['workbench'],
    id: string,
  ): void => {
    workbench.setPhase('reinforcement')
    const index = workbench.playerSegmentSteps.findIndex((step) => step.id === id)
    expect(index, `增援段应有 ${id}`).toBeGreaterThanOrEqual(0)
    expect(workbench.setSegmentStepIndex(index)).toBe(true)
  }

  it('★ 到货落位不得落回「可移动范围」，要指向增援窗的到达条目与地图落点', () => {
    const { workbench, mapView } = newStores()
    gotoReinforcementStep(workbench, 'reinforcement.arrival')
    expect(mapView.actionHint).not.toContain('可移动范围')
    expect(mapView.actionHint).toContain('增援')
    expect(mapView.actionHint).toContain('落')
  })

  it('★ 掷骰与统一放置不得落回「可移动范围」，要指向「掷骰检定」与待放上手牌', () => {
    const { workbench, mapView } = newStores()
    gotoReinforcementStep(workbench, 'reinforcement.replRoll')
    expect(mapView.actionHint).not.toContain('可移动范围')
    expect(mapView.actionHint).toContain('掷骰检定')
    expect(mapView.actionHint).toContain('手牌')
  })

  it('★ 重建与整编不得落回「可移动范围」，要说明盘面右键重建/合并', () => {
    const { workbench, mapView } = newStores()
    gotoReinforcementStep(workbench, 'reinforcement.rebuild')
    expect(mapView.actionHint).not.toContain('可移动范围')
    expect(mapView.actionHint).toContain('重建')
  })
})

/**
 * 2026-11-14 E 段实点：反应轰炸的提示与入口判据**同源**。
 *
 * 现场：hint 写「右键敌方格选『轰炸』」，但本盘面没有已释放预备炮兵、轴方也没有
 * 航程够的轰炸机 ⇒ 右键敌方格既无菜单也无反馈。提示不能承诺一个判据不成立的入口。
 */
describe('反应轰炸提示（7.0b / 10.0d）', () => {
  function setupReaction() {
    const { workbench, mapView } = newStores()
    workbench.setActiveSide('soviet')
    workbench.setPhase('reaction')
    enterStep(workbench, 'barrage.declare')
    expect(workbench.segmentStep?.id).toBe('reaction.barrage')
    return { workbench, mapView }
  }

  it('★ 没有可宣布的轰炸时，不再教「右键敌方格选轰炸」', () => {
    const { workbench, mapView } = setupReaction()
    placeGround(workbench, defenderRecord(), TARGET_HEX, 'soviet', 'def-1')

    expect(workbench.barrageTargetsNow).toEqual([])
    expect(mapView.actionHint).not.toContain('右键敌方格')
    expect(mapView.actionHint).toContain('没有可宣布的轰炸')
  })

  it('★ 有已释放预备炮兵与补给时，提示保留右键入口（炮击 / 轰炸）', () => {
    const { workbench, mapView } = setupReaction()
    const gun = placeGround(workbench, artilleryRecord(), CORE_HEX, 'axis', 'art-1')
    gun.mode.releasedFromReserve = true
    placeGround(workbench, defenderRecord(), TARGET_HEX, 'soviet', 'def-1')
    workbench.spDumps.push({ id: 'dump-1', hex: CORE_HEX, side: 'axis', sp: 0, t: 20 })

    expect(workbench.barrageTargetsNow.length).toBeGreaterThan(0)
    expect(mapView.actionHint).toContain('右键敌方格')
    expect(mapView.actionHint).toContain('炮击 / 轰炸')
  })
})

/**
 * 2026-11-15 F 段实点：炮击环节的提示与入口判据**同源**。
 *
 * 现场：hint 写「右键敌方格选『炮击』」，但 2.2 的 F 段是 artillery only，
 * 本盘面苏军火炮射程内没有轴方目标 ⇒ `barrageTargetsNow` 为空，右键敌方格毫无反应。
 */
describe('F 炮击环节提示（10.0d / 2.2）', () => {
  function setupCombat() {
    const { workbench, mapView } = newStores()
    workbench.setPhase('combat')
    enterStep(workbench, 'barrage.declare')
    expect(workbench.segmentStep?.id).toBe('combat.barrage')
    return { workbench, mapView }
  }

  it('★ 没有可宣布的轰炸时，不再教「右键敌方格选炮击」', () => {
    const { workbench, mapView } = setupCombat()
    placeGround(workbench, defenderRecord(), TARGET_HEX, 'soviet', 'def-1')

    expect(workbench.barrageTargetsNow).toEqual([])
    expect(mapView.actionHint).not.toContain('右键敌方格')
    expect(mapView.actionHint).toContain('没有可宣布的轰炸')
  })

  it('★ 有炮兵与补给时保留右键入口', () => {
    const { workbench, mapView } = setupCombat()
    placeGround(workbench, artilleryRecord(), CORE_HEX, 'axis', 'art-1')
    placeGround(workbench, defenderRecord(), TARGET_HEX, 'soviet', 'def-1')
    workbench.spDumps.push({ id: 'dump-1', hex: CORE_HEX, side: 'axis', sp: 0, t: 20 })

    expect(workbench.barrageTargetsNow.length).toBeGreaterThan(0)
    expect(mapView.actionHint).toContain('右键敌方格')
    expect(mapView.actionHint).toContain('炮击')
  })
})

/**
 * 2026-11-15 C 段实点：结束移动（Enter）后进入「轰炸（仅空中）」，
 * 顶部提示仍停在「移动中」——`moveInteraction` 已 `finished`，却被提示分支
 * 当成"正在移动"，压过了 C 段轰炸环节自己的分支（2.2 air only）。
 */
describe('结束移动后的环节提示（2.2 air only）', () => {
  it('★ finished 的移动交互不得压过「轰炸（仅空中）」的提示', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('movement')
    const unit = placeGround(
      workbench,
      groundRecord(
        'axis',
        (record) => record.isCombat === true && record.classes?.movementClass === 'leg',
      ),
      CORE_HEX,
      'axis',
      'leg-1',
    )
    workbench.clickHex(CORE_HEX)
    expect(workbench.confirmMovePick()).toBe(true)
    workbench.finishMove()
    expect(workbench.moveInteraction?.finished).toBe(true)
    expect(unit.movementEnded).toBe(true)

    const index = workbench.playerSegmentSteps.findIndex((step) => step.id === 'movement.barrage')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(workbench.setSegmentStepIndex(index)).toBe(true)
    expect(workbench.segmentStep?.id).toBe('movement.barrage')

    expect(mapView.actionHint).not.toContain('移动中')
    expect(mapView.actionHint).toContain('轰炸（仅空中）')
  })
})
