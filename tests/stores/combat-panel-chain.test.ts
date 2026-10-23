import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/**
 * B15b：**战斗操作链**（方案 §4.2「选择集就是后续动作的参与集合」+ §4.3「唯一会话框」）
 *
 * 两个缺口一并补上：
 *   ① **选择集没有镜像到战斗的参战集**：`map-view#handleStackClick` 只把摊开的选择集同步回
 *      **移动的取子清单**（`setMovePickIds`）⇒ 战斗那边仍要在小窗里逐枚点"加入攻方"，
 *      与「不存在『面板里再选一次』」不符。本批新增 `syncCombatParticipants(hex, ids)`（逐格镜像，
 *      仍走既有的 `toggleCombatAttacker` / `toggleCombatSupplyAttacker`，不绕过 9.1a/9.1e/9.0/9.1b 的判定）。
 *   ② **宣布之前没有任何会话**：会话只在 `combatState !== null` 时挂载，而「开始战斗（9.1）」的按钮
 *      原先只在小窗里 ⇒ 现在**点目标格即生成会话**（§4.2 的流程图），取消＝清掉这次的选子（`clearCombat`）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

const DEFENDER_HEX: HexRef = { col: 1, row: 1 }
const ATTACKER_HEX: HexRef = { col: 1, row: 2 }

/** B8：把 store 放到本段里允许做该动作的那个环节 */
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

const attackerRecord = () => {
  const found = unitChoices('axis').find(
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      record.classes?.movementClass === 'leg' &&
      (record.factors?.combat?.attack ?? 0) >= 3,
  )
  if (found === undefined) throw new Error('轴心国单位库中没有徒步战斗单位')
  return found
}

const defenderRecord = () => {
  const found = unitChoices('soviet').find(
    (record) => record.isCombat === true && record.attackCapable === true,
  )
  if (found === undefined) throw new Error('苏联单位库中没有战斗单位')
  return found
}

function place(
  store: ReturnType<typeof newStores>['workbench'],
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
) {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** 摆好两枚攻方 + 一枚守方，切到战斗工具并选定防御格 */
function setupBattlePrep(extraAttackers = 1) {
  const stores = newStores()
  const { workbench } = stores
  workbench.setPhase('combat')
  goToActionStep(workbench, 'combat.declare')
  workbench.setTool('battle')
  workbench.setFuelPool(0, 20)
  const a1 = place(workbench, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
  const extras = Array.from({ length: extraAttackers }, (_unused, index) =>
    place(workbench, attackerRecord(), ATTACKER_HEX, 'axis', `a${String(index + 2)}`),
  )
  const defender = place(workbench, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')
  workbench.selectCombatDefenderHex(DEFENDER_HEX)
  return { ...stores, a1, extras, defender }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B15b：选择集 → 战斗参战集（§4.2）', () => {
  it('★ 逐格镜像：该格选两枚 ⇒ 两枚都进参战集；只选一枚 ⇒ 另一枚退出（其余格不受影响）', () => {
    const { workbench, extras, a1 } = setupBattlePrep()
    const second = extras[0]!

    workbench.syncCombatParticipants(ATTACKER_HEX, [a1.instanceId, second.instanceId])
    expect(workbench.combatAttackerIds.sort()).toEqual([a1.instanceId, second.instanceId].sort())

    workbench.syncCombatParticipants(ATTACKER_HEX, [a1.instanceId])
    expect(workbench.combatAttackerIds).toEqual([a1.instanceId])
  })

  it('镜像**不绕过** 9.1 的既有判定：守方格内选枚不会把敌方算进攻方（9.1a 归属）', () => {
    const { workbench, defender } = setupBattlePrep()
    // 先清空（`selectCombatDefenderHex` 会按 9.1b 把相邻己方**自动**收作攻方）
    workbench.clearCombat()
    expect(workbench.combatAttackerIds).toEqual([])

    const enemy = defender.instanceId
    workbench.syncCombatParticipants(DEFENDER_HEX, [enemy])
    expect(workbench.combatAttackerIds).not.toContain(enemy)
    expect(workbench.combatAttackerIds).toEqual([])
  })

  it('★ 9.5b 减员步：镜像改的是**本步的输入名单**，且仍守 9.1b「至少留一枚」', () => {
    const { workbench, a1, extras } = setupBattlePrep()
    const second = extras[0]!
    workbench.syncCombatParticipants(ATTACKER_HEX, [a1.instanceId, second.instanceId])
    expect(workbench.beginCombatNow()).toBe(true)
    expect(workbench.combatState?.step).toBe('combatSupply')
    expect(workbench.combatAttackerIds).toEqual([a1.instanceId, second.instanceId])

    // 补给步里把第二枚取消 ⇒ 输入名单只剩一枚
    workbench.syncCombatParticipants(ATTACKER_HEX, [a1.instanceId])
    expect(workbench.combatAttackerIds).toEqual([a1.instanceId])

    // 9.1b：不能一枚都不留（镜像同样走那一条规则 ⇒ 名单不会被清空）
    workbench.syncCombatParticipants(ATTACKER_HEX, [])
    expect(workbench.combatAttackerIds).toEqual([a1.instanceId])
  })
})

describe('B15b：宣布之前的战斗会话（§4.2 的流程图）', () => {
  it('★ 点目标格即生成「发起战斗（9.1）」会话；未凑齐则不生成', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('combat')
    goToActionStep(workbench, 'combat.declare')
    workbench.setTool('battle')
    const a1 = place(workbench, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
    place(workbench, defenderRecord(), DEFENDER_HEX, 'soviet', 'd1')

    // 只选了攻方、还没定防御格 ⇒ 不生成
    workbench.clickHex(ATTACKER_HEX)
    expect(workbench.combatAttackerIds).toEqual([a1.instanceId])
    expect(mapView.session).toBeNull()

    workbench.clickHex(DEFENDER_HEX)
    expect(workbench.battleTarget?.hex).toEqual(DEFENDER_HEX)
    expect(mapView.session).toMatchObject({ kind: 'combat', rule: '9.1' })
    expect(mapView.session?.title).toContain('发起战斗')
  })

  it('★ 会话取消 ⇒ 清掉这次的选子与防御格（宣布之前没有引擎状态可取消）', () => {
    const { workbench, mapView } = setupBattlePrep()
    workbench.clickHex(ATTACKER_HEX)
    workbench.clickHex(DEFENDER_HEX)
    expect(mapView.session?.rule).toBe('9.1')

    expect(mapView.cancelSession()).toBe(true)
    expect(workbench.combatAttackerIds).toEqual([])
    expect(workbench.battleTarget).toBeNull()
    expect(mapView.session).toBeNull()
  })

  it('发起之后会话换成 9.2 的结算（同一条会话、不同规则号）', () => {
    const { workbench, mapView, a1 } = setupBattlePrep()
    workbench.syncCombatParticipants(ATTACKER_HEX, [a1.instanceId])
    expect(workbench.beginCombatNow()).toBe(true)
    expect(mapView.session).toMatchObject({ kind: 'combat', rule: '9.2' })
  })
})

describe('B15b：接线（源码守卫）', () => {
  it('地图摊开时的点选会镜像到战斗参战集（且只在本环节允许宣布战斗时）', () => {
    const store = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(store).toContain('workbench.syncCombatParticipants(hex, stackSelection.value)')
    expect(store).toContain('combatSelectionLive')
    // B35（口径 #10）：判据由"战斗工具开着"换成**本环节允不允许宣布战斗**（与闸门同源）
    expect(store).toContain('if (!workbench.combatPickActive) return false')
    expect(store).not.toContain("workbench.tool === 'battle'")
  })

  it('「加入攻方 / 移出攻方」的重复按钮已从小窗删掉（选择统一在地图上做）', () => {
    const popover = readFileSync('src/components/game/MapActionPopover.vue', 'utf8')
    expect(popover).not.toContain('toggleAttacker')
    expect(popover).not.toContain('加入攻方')
  })

  it('镜像只走既有两个动作（不另立一套参战判定）', () => {
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    const section = store.slice(
      store.indexOf('function syncCombatParticipants'),
      store.indexOf('function syncCombatParticipants') + 1400,
    )
    expect(section).toContain('toggleCombatAttacker(unit.instanceId)')
    expect(section).toContain('toggleCombatSupplyAttacker(unit.instanceId)')
  })

  it('前提自检：这一对格确实相邻且能常规战斗（夹具硬写格号的前提自证）', () => {
    expect(isOnMap(DEFENDER_HEX)).toBe(true)
    expect(
      mapLayers.hexes.some((h) => h.col === ATTACKER_HEX.col && h.row === ATTACKER_HEX.row),
    ).toBe(true)
    expect(
      HEX_DIRECTIONS.some(
        (direction) => neighbor(DEFENDER_HEX, direction).col === ATTACKER_HEX.col,
      ),
    ).toBe(true)
  })
})
