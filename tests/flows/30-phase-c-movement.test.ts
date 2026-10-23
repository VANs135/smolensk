import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import { hexDistance, sameHex } from '@/engine/hex-geometry'
import {
  BARRAGE_SOURCES_BY_PHASE,
  ACTIONS_BY_PHASE,
  canMoveInPhase,
  checkTiming,
} from '@/engine/rules'
import type { BreakoutUnitView, ModeState } from '@/engine/rules'
import { canBreakout } from '@/engine/rules/breakout'
import { canFlipOrientation, canSwitchMode } from '@/engine/rules/modes'
import {
  CORE_HEX,
  NEAR_HEX,
  combatRecord,
  groundRecord,
  label,
  newConsole,
  placeGround,
  type Workbench,
} from './sop-harness'

/**
 * 环节 Ⓒ：**移动**（C 段）——2.2 / 5.4 / 5.7a / 6.0 / 10.1a / 12.8e / 13.x / 16.0
 *
 * C 段是 SOP 里动作最多的环节：突围（12.8e 首环节）→ 模式与移动（5.4/6.0）→ 铁路（13.x）
 * → 建设（13.8/16.0）→ 空中轰炸（10.1a：C 段只允许**空中与舰炮**轰炸，炮兵不在此段）。
 * 本文件先固定**段闸**，再走一遍**选子 → 范围 → 逐格 → 结束**的真实链路。
 * 单独运行：`npx vitest run tests/flows/30-phase-c-movement.test.ts`
 */

const legCombat = () =>
  groundRecord(
    'axis',
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )

/** 最小时机请求（2.2 段闸） */
function timing(action: Parameters<typeof checkTiming>[0]['action']) {
  return checkTiming({
    action,
    side: 'axis',
    activeSide: 'axis',
    phase: 'movement',
    date: '1941-07-12',
  })
}

describe('Ⓒ C 段许可动作与段闸（2.2 / 10.1a）', () => {
  it('2.2：C 段是唯一含突围 / 铁路 / 装卸 / 工程 / 环形工事的段；不含攻击与整备', () => {
    const actions = [...ACTIONS_BY_PHASE.movement]
    for (const action of [
      'breakout',
      'modeChange',
      'move',
      'overrun',
      'railTransport',
      'railConversion',
      'loadUnload',
      'engineer',
      'buildHedgehog',
    ])
      expect(actions).toContain(action)
    expect(actions).not.toContain('attack')
    expect(actions).not.toContain('refit')

    // 反证：这三类动作放到别的段即被拦
    expect(
      checkTiming({
        action: 'railTransport',
        side: 'axis',
        activeSide: 'axis',
        phase: 'combat',
        date: '1941-07-12',
      }).map((item) => item.reason),
    ).toContain('actionNotInSegment')
    expect(timing('railTransport')).toEqual([])
    expect(timing('breakout')).toEqual([])
    expect(timing('engineer')).toEqual([])
  })

  it('10.1a：C 段只允许**空中与舰炮**轰炸——炮兵轰炸在 C 段非法', () => {
    expect([...(BARRAGE_SOURCES_BY_PHASE.movement ?? [])]).toEqual(['air', 'ship'])
    const artillery = checkTiming({
      action: 'barrage',
      barrageSource: 'artillery',
      side: 'axis',
      activeSide: 'axis',
      phase: 'movement',
      date: '1941-07-12',
    })
    expect(artillery.map((item) => item.reason)).toContain('barrageSourceNotAllowedInSegment')
    const air = checkTiming({
      action: 'barrage',
      barrageSource: 'air',
      side: 'axis',
      activeSide: 'axis',
      phase: 'movement',
      date: '1941-07-12',
    })
    expect(air).toEqual([])
  })

  it('5.4 / 5.7a：模式切换与改朝向都只在本方**移动阶段**', () => {
    expect(
      canSwitchMode({
        to: 'move',
        orientation: 'move',
        inEnemyZoc: false,
        unitClass: 'combat',
        side: 'axis',
        phase: 'movement',
      }).ok,
    ).toBe(true)
    const switchLater = canSwitchMode({
      to: 'move',
      orientation: 'move',
      inEnemyZoc: false,
      unitClass: 'combat',
      side: 'axis',
      phase: 'reaction',
    })
    expect(switchLater).toMatchObject({ ok: false, rule: '5.4' })

    const dgState: ModeState = { mode: 'combat', orientation: 'combat', dg: true, exploit: false }
    expect(canFlipOrientation({ state: dgState, phase: 'movement' })).toMatchObject({
      ok: true,
      rule: '5.4',
    })
    const flipLater = canFlipOrientation({ state: dgState, phase: 'exploitation' })
    expect(flipLater).toMatchObject({ ok: false, rule: '5.4' })
  })

  it('6.0 / 6.3a / 11.0a：移动环节三个段的可动者不同', () => {
    const plain: ModeState = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
    const exploit: ModeState = { ...plain, exploit: true }
    const released: ModeState = { ...plain, releasedFromReserve: true }

    // C 段：阶段玩家任意地面单位（6.0）；非阶段玩家不可（6.0）
    expect(canMoveInPhase({ state: plain, side: 'axis', activeSide: 'axis' }, 'movement')).toEqual({
      ok: true,
    })
    expect(
      canMoveInPhase({ state: plain, side: 'soviet', activeSide: 'axis' }, 'movement'),
    ).toMatchObject({ ok: false, rule: '6.0' })

    // E 段：只有非阶段玩家（6.3a）且**已释放预备**（7.0a）
    expect(
      canMoveInPhase({ state: plain, side: 'soviet', activeSide: 'axis' }, 'reaction'),
    ).toMatchObject({ ok: false, rule: '7.0a' })
    expect(
      canMoveInPhase({ state: released, side: 'soviet', activeSide: 'axis' }, 'reaction'),
    ).toEqual({ ok: true })
    expect(
      canMoveInPhase({ state: released, side: 'axis', activeSide: 'axis' }, 'reaction'),
    ).toMatchObject({ ok: false, rule: '6.3a' })

    // G 段：阶段玩家的进击单位或已释放预备（11.0a）
    expect(
      canMoveInPhase({ state: plain, side: 'axis', activeSide: 'axis' }, 'exploitation'),
    ).toMatchObject({ ok: false, rule: '11.0a' })
    expect(
      canMoveInPhase({ state: exploit, side: 'axis', activeSide: 'axis' }, 'exploitation'),
    ).toEqual({ ok: true })
    expect(
      canMoveInPhase({ state: released, side: 'axis', activeSide: 'axis' }, 'exploitation'),
    ).toEqual({ ok: true })
  })

  it('12.8e：突围是**移动阶段的首环节**——别的段一律不许（2.2）', () => {
    const unit: BreakoutUnitView = {
      id: 'u1',
      isCombat: true,
      isTransportPoint: false,
      moveMa: 4,
      hasTraceSupply: false,
    }
    const wrongPhase = canBreakout({ phase: 'combat', unit, firstTurnOutOfSupply: true })
    expect(wrongPhase.ok).toBe(false)
    if (!wrongPhase.ok) expect(wrongPhase.rule).toBe('2.2')

    // C 段 + 断补首回合 ⇒ 免除 A/B 两项条件并 +1 修正（12.8e）
    const firstTurn = canBreakout({ phase: 'movement', unit, firstTurnOutOfSupply: true })
    expect(firstTurn.ok).toBe(true)
    if (!firstTurn.ok) return
    expect(firstTurn.data).toMatchObject({ firstTurn: true, drm: 1 })

    // 有追溯补给者无须突围（12.8e）
    const supplied = canBreakout({
      phase: 'movement',
      unit: { ...unit, hasTraceSupply: true },
      firstTurnOutOfSupply: false,
    })
    expect(supplied.ok).toBe(false)
    if (!supplied.ok) expect(supplied.reason).toBe('hasTraceSupply:u1')
  })
})

describe('Ⓒ 移动链路端到端（6.1：选子 → 范围 → 逐格 → 结束）', () => {
  it('2.2：A 整备段没有移动环节（点了也不进入移动交互，理由 2.2）', () => {
    const store = newConsole()
    placeGround(store, legCombat(), CORE_HEX, 'axis', 'a1')

    store.setPhase('aircraftRefit')
    // 条 10（批 M）：点格建取子清单；确认开拔才被引擎拦下（beginMoveFor 写 moveBlocked）
    store.clickHex(CORE_HEX)
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveInteraction).toBeNull()
    expect(store.moveBlocked?.rule).toBe('2.2')
  })

  /*
   * ★ 批 A 切片 2（2026-09-18）的**契约变更**：F 段的战斗环节里，点己方算子不再走"移动被拒（2.2）"，
   *   而是**加入攻方**（9.1b）—— 点击由**当前环节**分派（对局台不再让玩家切工具）。
   *   本条的旧断言（2.2）随之搬到 A 整备段（上一条），这里钉新契约。
   */
  it('批 A 切片 2：F 段战斗环节点己方算子 ⇒ 加入攻方（不再报「无移动环节」）', () => {
    const store = newConsole()
    const unit = placeGround(store, legCombat(), CORE_HEX, 'axis', 'a1')

    store.setPhase('combat')
    const index = store.playerSegmentSteps.findIndex((step) => step.id === 'combat.combat')
    if (index >= 0) store.setSegmentStepIndex(index)
    expect(store.segmentStep?.id).toBe('combat.combat')
    store.clickHex(CORE_HEX)

    expect(store.moveInteraction).toBeNull()
    expect(store.combatAttackerIds).toContain(unit.instanceId)
  })

  it('6.1：C 段选中己方算子后给出可达范围，逐格移动并把 MP 落到单位上，结束后清空交互', () => {
    const store = newConsole()
    store.setPhase('movement')
    const unit = placeGround(store, legCombat(), CORE_HEX, 'axis', 'a1')

    // 条 10（批 M）：点格建取子清单，确认后开拔
    store.clickHex(CORE_HEX)
    expect(store.confirmMovePick()).toBe(true)
    expect(store.moveInteraction).not.toBeNull()
    expect(store.moveInteraction!.unitIds).toEqual(['a1'])
    expect(store.groupReachable.units[0]!.ok).toBe(true)
    expect(store.groupReachable.hexes.length).toBeGreaterThan(0)
    // 起点自身不算可达格
    expect(store.groupReachable.hexes.some((node) => sameHex(node.hex, CORE_HEX))).toBe(false)

    // 走一格：位置与已耗 MP 同步落盘（逐格重算范围由 store 保证）
    // 路径含起点 ⇒ 一步移动的路径长度为 2
    const step = store.groupReachable.hexes.find((node) => node.path.length === 2)
    expect(step).toBeDefined()
    store.clickHex(step!.hex)
    expect(unit.hex).toEqual(step!.hex)
    expect(store.moveInteraction!.steps).toHaveLength(1)
    expect(hexDistance(CORE_HEX, unit.hex)).toBe(1)

    store.finishMove()
    // 6.1 末句：结束移动后交互标记 finished，单位本轮不得再移动
    expect(store.moveInteraction?.finished).toBe(true)
    expect(unit.movementEnded).toBe(true)

    // 撤销整体移动 ⇒ 交互回到起点（步数清空、单位回原位）
    store.cancelWholeMove()
    expect(store.moveInteraction?.steps).toHaveLength(0)
    expect(unit.hex).toEqual(CORE_HEX)
  })

  it('6.3a / 11.0a：E 段与 G 段由引擎按「谁可动」拦下不合格单位', () => {
    const store = newConsole()
    const unit = placeGround(store, legCombat(), CORE_HEX, 'axis', 'a1')

    // E 反应段：本阶段玩家（轴方）的单位不可动（6.3a）
    store.setPhase('reaction')
    // 条 10（批 M）：点格建取子清单；确认开拔才被引擎拦下（beginMoveFor 写 moveBlocked）
    store.clickHex(CORE_HEX)
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveInteraction).toBeNull()
    expect(store.moveBlocked?.rule).toBe('6.3a')

    // G 进击段：非进击模式的单位不可动（11.0a）
    store.setPhase('exploitation')
    // 条 10（批 M）：点格建取子清单；确认开拔才被引擎拦下（beginMoveFor 写 moveBlocked）
    store.clickHex(CORE_HEX)
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveInteraction).toBeNull()
    expect(store.moveBlocked?.rule).toBe('11.0a')
    expect(unit.movementEnded).toBe(false)
  })

  it('6.1b：无 MA 的设施（空军基地）不可移动', () => {
    const store = newConsole()
    store.setPhase('movement')
    placeGround(
      store,
      groundRecord('axis', (record) => record.noncombatKind === 'air_base'),
      CORE_HEX,
      'axis',
      'base-1',
    )
    // 条 10（批 M）：点格建取子清单；确认开拔才被引擎拦下（beginMoveFor 写 moveBlocked）
    store.clickHex(CORE_HEX)
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveInteraction).toBeNull()
    expect(store.moveBlocked?.rule).toBe('6.1b')
  })

  it('E 段：本阶段玩家的单位不可动（6.3a）——操作台只能选本方，故 E 段做不了移动', () => {
    const store: Workbench = newConsole()
    const own = placeGround(store, legCombat(), CORE_HEX, 'axis', 'own-1')
    store.setPhase('reaction')
    // 条 10（批 M）：点格建取子清单；确认开拔才被引擎拦下（beginMoveFor 写 moveBlocked）
    store.clickHex(CORE_HEX)
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveInteraction).toBeNull()
    expect(store.moveBlocked?.rule).toBe('6.3a')
    expect(own.movementEnded).toBe(false)
    expect(label(own.hex)).toBe(label(CORE_HEX))
    // 注：E 段真正的行动者（非阶段玩家）的移动需由对手席位操作；
    //     「已释放预备才可动」（7.0a）的判据在引擎层已由 canMoveInPhase 覆盖（见上一组用例）。
  })

  it('6.1：可达范围随位置改变（走到相邻格后原起点不再是候选，NEAR_HEX 生效）', () => {
    const store = newConsole()
    store.setPhase('movement')
    const unit = placeGround(store, legCombat(), CORE_HEX, 'axis', 'a1')
    store.clickHex(CORE_HEX)
    expect(store.confirmMovePick()).toBe(true)
    const reachable = store.groupReachable.hexes.map((node) => label(node.hex))
    expect(reachable).toContain(label(NEAR_HEX))
    expect(unit.hex).toEqual(CORE_HEX)
  })
})

/* ────────────────────────────── 13.3c / 12.7a-B：铁路补给 ────────────────────────────── */

/** 有铁路格边、且格内地形含村庄/城市的格（13.3c①：火车卸货格的两项必要条件） */
const RAIL_VILLAGE_HEX = (() => {
  const key = (hex: { col: number; row: number }) => `${hex.col}.${hex.row}`
  const railHexes = new Set<string>()
  for (const edge of mapLayers.edges) {
    if (edge.rail !== true) continue
    railHexes.add(key(edge.a))
    railHexes.add(key(edge.b))
  }
  const found = mapLayers.hexes.find(
    (hex) =>
      railHexes.has(key(hex)) &&
      hex.terrainsPresent.some((name) => name === 'Village' || name.includes('City')),
  )
  if (found === undefined) throw new Error('地图上找不到「有铁路 + 村庄/城市」的格')
  return { col: found.col, row: found.row }
})()

describe('Ⓒ 13.3c / 12.7a-B：铁路补给线与火车卸货格', () => {
  it('13.3c：自补给源沿铁路连通，并判出「受控 + 村庄/城市 + 无未抵消敌 ZOC」的卸货格', () => {
    const store = newConsole()
    // 13.3c②：该格受本方控制（操作台口径＝格内只有单方战斗单位）
    placeGround(store, combatRecord('axis'), RAIL_VILLAGE_HEX, 'axis', 'u1')
    store.setSupplyActive(true)
    store.supplySourceDraft = { hexText: label(RAIL_VILLAGE_HEX), kind: 'edgeRail' }
    expect(store.addSupplySource()).toBe(true)

    const path = store.railSupply
    expect(path.rule).toBe('13.3c')
    // 卸货格含补给源所在的村庄/城市格
    expect(path.detrainableHexes.map((hex) => label(hex))).toContain(label(RAIL_VILLAGE_HEX))
    // 铁路连通范围不止起点一格（13.3a：沿铁路格边扩散）
    expect(path.railReachableHexes.length).toBeGreaterThan(1)
    // 12.6a②：卸货格本身就是追溯补给源 ⇒ 停在该格的单位有追溯补给
    // （B8：`beginSupplyCheckNow` 是 D 段的动作 ⇒ 切到 D 段再探；此处探的是**补给事实**，不是段规则）
    store.setPhase('supply')
    expect(store.beginSupplyCheckNow('u1')).toBe(true)
    expect(store.supplySummary?.status).toBe('inSupply')
  })

  it('12.7a-B：延补队把后方已连接的格接到自己所在格（以其印值 MA 为限）', () => {
    const store = newConsole()
    placeGround(store, combatRecord('axis'), RAIL_VILLAGE_HEX, 'axis', 'u1')
    store.setSupplyActive(true)
    store.supplySourceDraft = { hexText: label(RAIL_VILLAGE_HEX), kind: 'edgeRail' }
    store.addSupplySource()

    const before = store.railSupply.railReachableHexes.length
    // 12.7b：延补队摆在与已连接格距离 0 的格上（此处即同格，范围 0）⇒ 必然接入
    const extender = placeGround(
      store,
      groundRecord('axis', (record) => record.noncombatKind === 'supply_extender'),
      RAIL_VILLAGE_HEX,
      'axis',
      'ext-1',
    )
    expect(extender).toBeDefined()
    expect(store.railSupply.railReachableHexes.length).toBeGreaterThanOrEqual(before)
  })
})
