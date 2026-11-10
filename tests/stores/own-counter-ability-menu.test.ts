import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * ⑤ 右键己方算子 ⇒ 能力菜单（用户 2026-11-09）
 *
 * 口径：「按能力分类，先接运输队/卡车的装载与卸载、普通单位的装船/上车（若原文明文允许）、
 * 以及既有已实现的工程、模式切换等项。只列当前真正可用的项，判据复用 store 谓词；
 * 没有对应入口的能力先报告缺什么，不硬做。」
 *
 * 本组钉**装卸 SP（13.2f）只在真能装或真能卸时出现**；工程 / 模式等既有项继续在（另见
 * `context-menu-capabilities.test.ts`）。装船/上车：本作规则里没有海运 / 登陆艇 / 卡车运单位条款，
 * 不进菜单（在交付说明里报告缺口）。
 */

const HEX: HexRef = { col: 15, row: 10 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 运输点数（13.2：`noncombatKind === 'transport_point'`）；编内卡车只有轴方有 */
function placeTransportPoint(
  workbench: Workbench,
  options: { organic?: boolean; side?: 'axis' | 'soviet'; id?: string } = {},
) {
  const side = options.side ?? 'soviet'
  const organic = options.organic === true
  const record = groundRecord(side, (item) =>
    organic
      ? item.noncombatKind === 'organic_truck'
      : item.noncombatKind === 'transport_point' && (item.noncombatDetails?.transport ?? 0) >= 2,
  )
  return placeGround(workbench, record, HEX, side, options.id ?? 'tp-1')
}

function dumpHere(workbench: Workbench, side: 'axis' | 'soviet' = 'soviet', sp = 4) {
  workbench.spDumps.push({ id: 'd1', hex: { ...HEX }, side, sp, t: 0 })
}

/** 把操作台切到移动环节（13.2f 的装卸属 `move.loadUnload`） */
function enterMovement(workbench: Workbench): void {
  workbench.setPhase('movement')
  const index = workbench.playerSegmentSteps.findIndex(
    (step) => step.id === 'movement.modeAndMovement',
  )
  expect(index, '本阶段没有 movement.modeAndMovement 环节').toBeGreaterThanOrEqual(0)
  expect(workbench.setSegmentStepIndex(index)).toBe(true)
}

function menuKeys(s: ReturnType<typeof stores>, instanceId: string): string[] {
  s.workbench.selectedId = instanceId
  s.mapView.onHexContext(HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
  return (s.mapView.contextOptions.find((item) => item.id === instanceId)?.actions ?? []).map(
    (item) => item.key,
  )
}

describe('⑤ 右键己方算子：运输点数 / 卡车的装卸', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    s.workbench.setActiveSide('soviet')
    enterMovement(s.workbench)
  })

  it('★ 同格有补给站（有货）且空载 ⇒ 出「装卸 SP（13.2f）」', () => {
    const point = placeTransportPoint(s.workbench)
    dumpHere(s.workbench)
    expect(menuKeys(s, point.instanceId)).toContain('move.loadUnload')
  })

  it('★ 同格没有补给站、车也空 ⇒ 不出（点进去什么也干不了）', () => {
    const point = placeTransportPoint(s.workbench)
    expect(menuKeys(s, point.instanceId)).not.toContain('move.loadUnload')
  })

  it('★ 空站（SP 已被取走）⇒ 不出', () => {
    const point = placeTransportPoint(s.workbench)
    dumpHere(s.workbench, 'soviet', 0)
    expect(menuKeys(s, point.instanceId)).not.toContain('move.loadUnload')
  })

  it('★ 车上已载 SP 且在含友方战斗单位的格 ⇒ 出（可卸）', () => {
    const point = placeTransportPoint(s.workbench)
    point.loadedSpT = 4
    placeGround(
      s.workbench,
      groundRecord('soviet', (item) => item.isCombat === true),
      HEX,
      'soviet',
      'inf-1',
    )
    expect(menuKeys(s, point.instanceId)).toContain('move.loadUnload')
  })

  it('★ 13.2g-A：编内卡车已载、格内不许卸载 ⇒ 不出；同格有站可装 ⇒ 出', () => {
    const truck = placeTransportPoint(s.workbench, { organic: true, side: 'axis', id: 'truck-1' })
    s.workbench.setActiveSide('axis')
    enterMovement(s.workbench)
    truck.loadedSpT = 4
    // 编内卡车永远不能在地图上卸载（13.2g-A），格内又无站 ⇒ 无可用项
    expect(menuKeys(s, truck.instanceId)).not.toContain('move.loadUnload')
    // 同格给一座有货的站且车已卸空 ⇒ 可装 ⇒ 出现
    truck.loadedSpT = 0
    dumpHere(s.workbench, 'axis')
    expect(menuKeys(s, truck.instanceId)).toContain('move.loadUnload')
  })

  it('★ 点「装卸 SP」⇒ 进既有 SupplyPanel 的 loadUnload 段（不另开新入口）', () => {
    const point = placeTransportPoint(s.workbench)
    dumpHere(s.workbench)
    menuKeys(s, point.instanceId)
    expect(s.mapView.openContextAction(point.instanceId, 'move.loadUnload')).toBe(true)
    expect(s.mapView.unitActionFamily).toBe('supply')
    expect(s.mapView.unitActionIntent?.only).toBe('loadUnload')
  })

  it('★ 没装卸可做时不列该项，但同枚算子的既有合并/拆分项照常（左键入口不因本条消失）', () => {
    const point = placeTransportPoint(s.workbench)
    const onlys = s.mapView.unitActionOptions(point.instanceId).map((item) => item.only)
    expect(onlys).not.toContain('loadUnload')
    expect(onlys).toContain('transport')
  })
})

/**
 * #9（用户 2026-11-10）：**移动环节点己方炮兵不得出「宣布轰炸」**
 *
 * 10.0e-D：火炮轰炸只在战斗 / 反应 / 进击段的**轰炸环节**；10.0 第二段在移动环节
 * 只给「低空扫射的空军」开口子。判断不能只看 `actionAllowedNow('barrage.declare')`
 * ——该闸在移动环节会为低空扫射放行，必须再按 `barrageKindsInSegment` 收口。
 */
describe('阶段闸门：移动环节己方炮兵进不了炮击名单（#9）', () => {
  it('★ 轰炸工具开着 + 点己方炮兵 ⇒ 参炸名单仍为空、不弹「宣布轰炸」', () => {
    const { workbench, mapView } = stores()
    workbench.setActiveSide('axis')
    enterMovement(workbench)
    const artillery = placeGround(
      workbench,
      groundRecord(
        'axis',
        (item) =>
          (item.factors?.combat?.barrage ?? 0) > 0 && (item.factors?.combat?.range ?? 0) >= 1,
      ),
      HEX,
      'axis',
      'art-1',
    )
    // 模拟轰炸工具仍开着（从轰炸环节退回移动环节的情形）
    workbench.setBarrageActive(true)
    workbench.syncBarrageParticipants(HEX, [artillery.instanceId])
    expect(workbench.barrageUnitIds).toEqual([])
    expect(mapView.session?.kind ?? null).not.toBe('barrage')
    // 右键菜单同样不列炮击（判据与 `barrageEntryEligible` 共用）
    expect(menuKeys({ workbench, mapView }, artillery.instanceId)).not.toContain('barrage.declare')
  })
})
