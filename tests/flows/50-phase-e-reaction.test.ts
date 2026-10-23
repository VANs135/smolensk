import { describe, expect, it } from 'vitest'

import {
  ACTIONS_BY_PHASE,
  BARRAGE_SOURCES_BY_PHASE,
  canMissionInPhase,
  canMoveInPhase,
  checkTiming,
  isAirMissionAllowedInPhase,
  maMultiplier,
  resolveWeather,
} from '@/engine/rules'
import type { ModeState } from '@/engine/rules'
import { availableMaOf } from '@/stores'
import {
  CORE_HEX,
  NEAR_HEX,
  airBaseRecord,
  bomberRecord,
  fighterRecord,
  groundRecord,
  label,
  newConsole,
  placeAir,
  placeGround,
  type Workbench,
} from './sop-harness'

/**
 * 环节 Ⓔ：**反应**（E 段）——2.2 / 5.7b / 6.3a / 7.0a / 专规 1.5 / 专规 2.2c
 *
 * E 段是**非阶段玩家**的回合：只有他**已释放的预备**地面单位能移动（6.3a + 7.0a），MA 减半（5.7b）；
 * 没有战斗环节，只能轰炸（炮兵/空中/舰炮三种来源皆可）；空军另受天气（专规 1.5 受限飞行禁飞）
 * 与「苏军不得在反应/进击阶段出击」（专规 2.2c）双重限制。
 * 单独运行：`npx vitest run tests/flows/50-phase-e-reaction.test.ts`
 */

describe('Ⓔ E 段许可动作与段闸（2.2 / 10.x）', () => {
  it('2.2：E 段只有预备释放 / 移动 / 轰炸——**没有战斗环节**（不含攻击）', () => {
    expect([...ACTIONS_BY_PHASE.reaction]).toEqual(['reserveRelease', 'move', 'barrage'])
    expect([...ACTIONS_BY_PHASE.reaction]).not.toContain('attack')
    const attack = checkTiming({
      action: 'attack',
      side: 'soviet',
      activeSide: 'axis',
      phase: 'reaction',
      date: '1941-07-12',
    })
    expect(attack.map((item) => item.reason)).toContain('actionNotInSegment')
  })

  it('2.2：E 段允许三种来源的轰炸（炮兵 / 空中 / 舰炮）', () => {
    expect([...(BARRAGE_SOURCES_BY_PHASE.reaction ?? [])]).toEqual(['artillery', 'air', 'ship'])
    for (const source of ['artillery', 'air', 'ship'] as const) {
      expect(
        checkTiming({
          action: 'barrage',
          barrageSource: source,
          side: 'soviet',
          activeSide: 'axis',
          phase: 'reaction',
          date: '1941-07-12',
        }),
      ).toEqual([])
    }
  })

  it('6.3a / 7.0a：行动者是**非阶段玩家**，且必须是**已释放的预备**', () => {
    const released: ModeState = {
      mode: 'combat',
      orientation: 'combat',
      dg: false,
      exploit: false,
      releasedFromReserve: true,
    }
    const notReleased: ModeState = {
      mode: 'combat',
      orientation: 'combat',
      dg: false,
      exploit: false,
    }

    // 阶段玩家的单位不可动（6.3a）
    expect(
      canMoveInPhase({ state: notReleased, side: 'axis', activeSide: 'axis' }, 'reaction'),
    ).toMatchObject({ ok: false, rule: '6.3a' })
    // 非阶段玩家但未释放 ⇒ 7.0a
    expect(
      canMoveInPhase({ state: notReleased, side: 'soviet', activeSide: 'axis' }, 'reaction'),
    ).toMatchObject({ ok: false, rule: '7.0a' })
    // 非阶段玩家 + 已释放 ⇒ 可动
    expect(
      canMoveInPhase({ state: released, side: 'soviet', activeSide: 'axis' }, 'reaction'),
    ).toEqual({ ok: true })
  })

  it('5.7b：刚释放的预备在 E 段 MA ×1/2（G 段 ×1）；未释放的预备在 E 段不可动（×0）', () => {
    const released: ModeState = {
      mode: 'combat',
      orientation: 'combat',
      dg: false,
      exploit: false,
      releasedFromReserve: true,
    }
    const reserve: ModeState = { mode: 'reserve', orientation: 'combat', dg: false, exploit: false }
    const exploit: ModeState = { mode: 'combat', orientation: 'combat', dg: false, exploit: true }

    expect(maMultiplier(released, 'reaction')).toBe(0.5)
    expect(maMultiplier(released, 'exploitation')).toBe(1)
    expect(maMultiplier(reserve, 'reaction')).toBe(0)
    expect(maMultiplier(reserve, 'movement')).toBe(0.25)
    expect(maMultiplier(exploit, 'exploitation')).toBe(0.5)
  })
})

describe('Ⓔ 空军在 E 段的双重限制（专规 1.5 / 专规 2.2c）', () => {
  it('专规 2.2c：苏军不得在反应/进击阶段出击；轴军可（通规 14.1g 允许三段）', () => {
    expect(canMissionInPhase('axis', 'movement')).toBe(true)
    expect(canMissionInPhase('axis', 'reaction')).toBe(true)
    expect(canMissionInPhase('axis', 'exploitation')).toBe(true)
    expect(canMissionInPhase('soviet', 'movement')).toBe(true)
    expect(canMissionInPhase('soviet', 'reaction')).toBe(false)
    expect(canMissionInPhase('soviet', 'exploitation')).toBe(false)
  })

  it('专规 1.5：受限飞行（天气表掷 1）下反应/进击阶段一律禁飞，移动阶段仍可', () => {
    const limited = resolveWeather(1)
    const normal = resolveWeather(6)
    expect(limited.isLimited).toBe(true)
    expect(isAirMissionAllowedInPhase(limited, 'movement')).toBe(true)
    expect(isAirMissionAllowedInPhase(limited, 'reaction')).toBe(false)
    expect(isAirMissionAllowedInPhase(limited, 'exploitation')).toBe(false)
    expect(isAirMissionAllowedInPhase(normal, 'reaction')).toBe(true)
  })

  it('端到端：E 段轴军可宣布任务；同一操作下苏军被专规 2.2c 拦下（rule 2.2c）', () => {
    const store = newConsole()
    store.setPhase('reaction')
    store.setAirActive(true)

    // 轴军：基地 + 激活轰炸机
    placeGround(store, airBaseRecord(), CORE_HEX, 'axis', 'base-ax')
    placeAir(store, fighterRecord('axis'), CORE_HEX, 'axis', 'air-ax')
    store.setAirTargetFromText(label(NEAR_HEX))
    store.toggleAirMissionUnit('air-ax')
    // 反应段不是空投等受限任务，普通轰炸在 E 段合法（14.1g + 专规 2.2c 对轴军无限制）
    expect(store.beginAirMissionNow()).toBe(true)
    expect(store.airState?.step).toBe('airCombat')
    store.cancelAir()

    // 苏军：换方后同样宣布 ⇒ 专规 2.2c 拦下
    const soviet: Workbench = newConsole()
    soviet.setPhase('reaction')
    soviet.switchSide()
    soviet.setAirActive(true)
    placeGround(soviet, airBaseRecord(), CORE_HEX, 'soviet', 'base-su')
    placeAir(soviet, fighterRecord('soviet'), CORE_HEX, 'soviet', 'air-su')
    soviet.setAirTargetFromText(label(NEAR_HEX))
    soviet.toggleAirMissionUnit('air-su')
    expect(soviet.beginAirMissionNow()).toBe(false)
    expect(soviet.airError).toMatchObject({
      rule: '2.2c',
      reason: 'sovietNoReactionOrExploitationMission',
    })
  })

  it('14.1f：天气禁飞时 E 段也不可宣布任务（与专规 1.5 的天气层一致）', () => {
    const store = newConsole()
    store.setPhase('reaction')
    store.setAirActive(true)
    placeGround(store, airBaseRecord(), CORE_HEX, 'axis', 'base-ax')
    placeAir(store, bomberRecord('axis'), CORE_HEX, 'axis', 'air-ax')
    store.airInputs.flyingAllowed = false
    store.setAirTargetFromText(label(NEAR_HEX))
    store.toggleAirMissionUnit('air-ax')
    expect(store.beginAirMissionNow()).toBe(false)
    expect(store.airError).toMatchObject({ rule: '14.1f', reason: 'weatherProhibitsFlying' })
  })
})

describe('Ⓔ E 段的移动者身份（6.3a）在操作台上的表现', () => {
  it('E 段当前方（阶段玩家）的单位点了不能进入移动交互（6.3a）', () => {
    const store = newConsole()
    store.setPhase('reaction')
    placeGround(
      store,
      groundRecord(
        'axis',
        (record) => record.attackCapable === true && (record.factors?.combat?.ma ?? 0) >= 4,
      ),
      CORE_HEX,
      'axis',
      'own-1',
    )
    // 条 10（批 M）：点格建取子清单；确认开拔才被 6.3a 拦下
    store.clickHex(CORE_HEX)
    expect(store.confirmMovePick()).toBe(false)
    expect(store.moveInteraction).toBeNull()
    expect(store.moveBlocked?.rule).toBe('6.3a')
  })
})

describe('Ⓔ 释放预备的入口（5.7b）', () => {
  /** 可动的苏军战斗记录（MA ≥ 4，够看出 1/2 的差别） */
  const movableRecord = () =>
    groundRecord(
      'soviet',
      (record) => record.attackCapable === true && (record.factors?.combat?.ma ?? 0) >= 4,
    )

  it('端到端：E 段可选中非阶段玩家的预备并释放 → MA ×1/2（5.7b-B）', () => {
    const store = newConsole()
    store.setPhase('reaction') // activeSide 缺省 axis ⇒ 苏军为非阶段玩家
    const unit = placeGround(store, movableRecord(), CORE_HEX, 'soviet', 'su-res')
    unit.mode = { mode: 'reserve', orientation: 'combat', dg: false, exploit: false }

    // 点格可选中该非阶段玩家单位（反应段当前方是轴军，故它按「查看」被选中）
    store.clickHex(CORE_HEX)
    expect(store.selectedUnit?.instanceId).toBe(unit.instanceId)

    // 释放前：未释放 ⇒ 7.0a 不可动，可用 MA 为 0
    expect(
      canMoveInPhase({ state: unit.mode, side: 'soviet', activeSide: 'axis' }, 'reaction'),
    ).toMatchObject({ ok: false, rule: '7.0a' })
    expect(availableMaOf(unit, 'reaction')).toBe(0)

    // 释放：摘掉预备标记（回朝向那一面）
    expect(store.releaseReserveNow()).toBe(true)
    expect(unit.mode.releasedFromReserve).toBe(true)
    expect(unit.mode.mode).toBe('reserve') // 表示法仍是 reserve + 旗标，由 canonicalMode 折回朝向
    expect(unit.mode.orientation).toBe('combat')

    // 释放后：7.0a 消解，且 MA 减半（5.7b-B）；store 顺手重试开拔（与模式切换同款）
    expect(
      canMoveInPhase({ state: unit.mode, side: 'soviet', activeSide: 'axis' }, 'reaction'),
    ).toEqual({ ok: true })
    expect(availableMaOf(unit, 'reaction')).toBe(unit.raw.ma * 0.5)
    expect(store.moveInteraction).not.toBeNull()
    expect(store.groupReachable.units[0]!.ok).toBe(true)
  })

  it('6.3a：E 段的阶段玩家不能释放自己的预备', () => {
    const store = newConsole()
    store.setPhase('reaction') // 阶段玩家 = axis
    const unit = placeGround(store, movableRecord(), CORE_HEX, 'axis', 'ax-res')
    unit.mode = { mode: 'reserve', orientation: 'combat', dg: false, exploit: false }
    store.selectedId = unit.instanceId

    expect(store.releaseReserveNow()).toBe(false)
    expect(unit.mode.releasedFromReserve).toBeUndefined()
    expect(store.log[0]!.text).toContain('6.3a')
  })

  it('5.7b：`releasedFromReserve` 只在本阶段有效——换阶段即被清除', () => {
    const store = newConsole()
    store.setPhase('reaction')
    const unit = placeGround(store, movableRecord(), CORE_HEX, 'soviet', 'su-res')
    unit.mode = { mode: 'reserve', orientation: 'combat', dg: false, exploit: false }
    store.selectedId = unit.instanceId
    expect(store.releaseReserveNow()).toBe(true)
    expect(unit.mode.releasedFromReserve).toBe(true)

    store.setPhase('combat')
    expect(unit.mode.releasedFromReserve).toBe(false)
    // 下个进击段不再凭陈旧旗标获得移动资格（11.0a 只认进击标记）
    expect(availableMaOf(unit, 'exploitation')).toBe(0)
  })

  it('非预备模式的单位无需释放（5.7b：只有预备模式单位才谈得上「释放」）', () => {
    const store = newConsole()
    store.setPhase('reaction')
    const unit = placeGround(store, movableRecord(), CORE_HEX, 'soviet', 'su-plain')
    store.selectedId = unit.instanceId
    expect(store.releaseReserveNow()).toBe(false)
    expect(store.log[0]!.text).toContain('不处于预备模式')
  })
})
