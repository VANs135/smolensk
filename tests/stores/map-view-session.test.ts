import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { createMapFacts, selectMovementTerrain } from '@/engine/rules'
import {
  defenseTerrainChoices,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useWorkbenchStore,
  actionGateOf,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/**
 * B4：**唯一会话框**的路由与取消（方案 §4.3）
 *
 * 用户口径：「一切行动都在地图页展开**单一**会话框」；`Esc` 等价于面板里的「取消」按钮，
 * 落到引擎的 `cancelXxx`（不自己造第二套收场）。
 *
 * 本文件钉四件事：
 *   ① 无会话 ⇒ `session === null`（视图据此**不挂载**任何会话框）；
 *   ② 战斗（9.2/8.1）与轰炸（10.0）各自被路由出来，标题带格号与规则号；
 *   ③ 取消落到引擎：战斗清 `combatState`、轰炸清 `barrageState`，且**不越权**动别的工具开关；
 *   ④ 一次只给一个会话（结构上不可能同时挂两个）。
 *
 * ★ 用的是**真实地图 + 真实单位库**（不造数）：会话是有没有，全看引擎状态机有没有在跑。
 */

const facts = createMapFacts()

/**
 * 一对可用于常规战斗的相邻格
 *
 * 前置在文件末尾的 `前提自检` 里逐条验（防御格有地形、攻方徒步可进入、两者相邻）——
 * 硬写格号是为了让用例短，但**前提必须自证**，否则地图数据一变就会以奇怪的方式失败。
 */
const DEFENDER_HEX: HexRef = { col: 1, row: 1 }
const ATTACKER_HEX: HexRef = { col: 1, row: 2 }

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 轴心国徒步战斗单位（9.1 攻方） */
const attackerRecord = () =>
  unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.attack ?? 0) >= 3,
  )!

/** 苏联战斗单位（9.1 守方） */
const defenderRecord = () =>
  unitChoices('soviet').find(
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 0) >= 1,
  )!

/** 轴心国带印刷轰炸值的火炮（10.0e-B） */
const artilleryRecord = () =>
  unitChoices('axis').find(
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )!

const place = (
  store: ReturnType<typeof newStores>['workbench'],
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
) => {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** 起一次常规战斗（9.2），停在战斗补给步 ⇒ `combatState` 已存在 */
function openCombatSession(stores: ReturnType<typeof newStores>): boolean {
  const { workbench } = stores
  workbench.setPhase('combat')
  // B8：F 段首环是炮击 ⇒ 宣告战斗前先进战斗环节
  goToActionStep(workbench, 'combat.declare')
  workbench.setTool('battle')
  workbench.setFuelPool(0, 20)
  place(workbench, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  place(workbench, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
  workbench.clickHex(ATTACKER_HEX)
  workbench.clickHex(DEFENDER_HEX)
  return workbench.beginCombatNow()
}

/** 起一次轰炸（10.0），停在补给步 ⇒ `barrageState` 已存在 */
function openBarrageSession(stores: ReturnType<typeof newStores>): boolean {
  const { workbench } = stores
  workbench.setPhase('combat')
  const artillery = place(workbench, artilleryRecord(), ATTACKER_HEX, 'axis', 'art-1')
  const defender = place(workbench, defenderRecord(), DEFENDER_HEX, 'soviet', 'def-1')
  workbench.battleTarget = { hex: DEFENDER_HEX, defenderIds: [defender.instanceId] }
  workbench.setBarrageActive(true)
  workbench.toggleBarrageUnit(artillery.instanceId)
  return workbench.beginBarrageNow()
}

/**
 * B8：把 store 放到**本段里允许做该动作的那个环节**
 *
 * 段内动作只在对应环节放行（用户口径：「每个环节只能执行该环节能进行的操作」）。
 * 用 B7 的闸门表反查环节，而不是写死序号或环节名。
 */
function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

describe('B4：唯一会话框（路由 / 取消）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('前提自检：这一对格真能打常规战斗（防御格有地形、攻方徒步可进入、两者相邻）', () => {
    expect(defenseTerrainChoices(DEFENDER_HEX).length).toBeGreaterThan(0)
    const entered = selectMovementTerrain({
      terrainsPresent: facts.terrainsAt(DEFENDER_HEX),
      mobility: 'leg',
      crossing: facts.crossingBetween(ATTACKER_HEX, DEFENDER_HEX),
      followingRoad: true,
      forOverrun: false,
    })
    expect(entered.ok).toBe(true)
  })

  it('没有进行中的会话 ⇒ session 为 null，且"取消"如实说没做事', () => {
    expect(stores.mapView.session).toBeNull()
    // 反空转：返回 false 才是对的，否则快捷键层会白吃掉一次 Esc
    expect(stores.mapView.cancelSession()).toBe(false)
  })

  it('9.2 战斗一开始 ⇒ 路由出战斗会话（标题带格号、规则号 9.2）', () => {
    expect(openCombatSession(stores)).toBe(true)
    const session = stores.mapView.session
    expect(session).not.toBeNull()
    expect(session!.kind).toBe('combat')
    expect(session!.rule).toBe('9.2')
    expect(session!.title).toBe(`战斗结算（9.2） · 格 ${DEFENDER_HEX.col}.${DEFENDER_HEX.row}`)
  })

  it('取消战斗会话 ⇒ 引擎的战斗状态清空，且没有别的工具被顺带关掉', () => {
    const { workbench, mapView } = stores
    expect(openCombatSession(stores)).toBe(true)
    expect(workbench.combatState).not.toBeNull()

    const barrageToolBefore = workbench.barrageActive
    expect(mapView.cancelSession()).toBe(true)
    expect(workbench.combatState).toBeNull()
    // 会话随引擎状态一起消失（视图不需要自己判 `finished`）
    expect(mapView.session).toBeNull()
    // 取消一场战斗不该动「轰炸工具」这个开关（各管各的）
    expect(workbench.barrageActive).toBe(barrageToolBefore)
  })

  it('10.0 轰炸一开始 ⇒ 路由出轰炸会话（规则号 10.0、宽度更宽——表更大）', () => {
    expect(openBarrageSession(stores)).toBe(true)
    const session = stores.mapView.session
    expect(session).not.toBeNull()
    expect(session!.kind).toBe('barrage')
    expect(session!.rule).toBe('10.0')
    expect(session!.title).toBe('轰炸结算（10.0）')
    expect(session!.width).toBe('min(430px, 94%)')
  })

  it('取消轰炸会话 ⇒ 走 10.0 的「放弃本次轰炸」（清 barrageState），不是关工具开关', () => {
    const { workbench, mapView } = stores
    expect(openBarrageSession(stores)).toBe(true)

    expect(mapView.cancelSession()).toBe(true)
    expect(workbench.barrageState).toBeNull()
    expect(mapView.session).toBeNull()
    // 「轰炸工具」是另一个开关：放弃一次轰炸**不等于**把工具关掉（面板里的「取消」也不关它）
    expect(workbench.barrageActive).toBe(true)
  })

  it('一次只给一个会话（战斗与轰炸都在进行时也只路由一个，且是战斗）', () => {
    const { workbench, mapView } = stores
    expect(openCombatSession(stores)).toBe(true)
    workbench.setBarrageActive(true)
    const session = mapView.session
    expect(session).not.toBeNull()
    // 返回的是**一个对象**（不是数组）⇒ 视图结构上不可能挂两个面板
    expect(Array.isArray(session)).toBe(false)
    expect(session!.kind).toBe('combat')
  })
})
