import { describe, expect, it } from 'vitest'

import {
  BASE_MODE_EFFECT,
  INVOLUNTARY_MODES,
  MODE_MARKER_EFFECTS,
  SOVIET_STRAT_MODE_FROM,
  VOLUNTARY_MODES,
  activeMarker,
  baseOrientation,
  canConvertGauge,
  canEngineer,
  canFlipOrientation,
  canMoveInPhase,
  canStackWithHedgehog,
  canSwitchMode,
  canUseTransport,
  canonicalMode,
  effectiveMode,
  exertsZoc,
  flipOrientation,
  isInCombatMode,
  isInMoveMode,
  isInvoluntaryMode,
  isMobileUnit,
  isVoluntaryMode,
  maMultiplier,
  markersAfterDg,
  modeEffect,
  modeEffectsFor,
  modeSwitchCost,
  modeUnitClass,
  mustEndMoveInSupply,
  resolveModeStats,
  validateModeState,
} from '@/engine/rules'
import type { ModeState, ModeUnitClass } from '@/engine/rules'

/**
 * 模式（OCS 5.0）测试
 *
 * 断言全部照**中文规则书**条款（CODE_SPEC §5 术语表以中文规则书为唯一来源）：
 *   5.3 主动/被动｜5.4 模式切换｜5.4a 模式标记与朝向｜5.5/5.6 战斗/移动模式｜5.7 预备
 *   5.8 战略｜5.9 进击｜5.10 混乱｜6.1b 无 MA 单位｜6.0/6.3a/7.0a/11.0a 阶段可动性｜专规 2.3e
 */

const COMBAT: ModeState = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }
const RAW = { attack: 10, ar: 5, ma: 8, barrage: 6 }

describe('模式词表（5.3）', () => {
  it('主动模式＝战斗/移动/战略/预备；被动模式＝DG/进击', () => {
    expect([...VOLUNTARY_MODES]).toEqual(['combat', 'move', 'strat', 'reserve'])
    expect([...INVOLUNTARY_MODES]).toEqual(['dg', 'exploit'])
    for (const mode of VOLUNTARY_MODES) expect(isVoluntaryMode(mode)).toBe(true)
    for (const mode of INVOLUNTARY_MODES) {
      expect(isInvoluntaryMode(mode)).toBe(true)
      expect(isVoluntaryMode(mode)).toBe(false)
    }
  })
})

describe('生效模式（5.4a：被动模式替代当前模式）', () => {
  it('无被动标记时即 mode 本身', () => {
    expect(effectiveMode(COMBAT)).toBe('combat')
    expect(effectiveMode({ ...COMBAT, mode: 'move', orientation: 'move' })).toBe('move')
    expect(effectiveMode({ ...COMBAT, mode: 'strat', orientation: 'move' })).toBe('strat')
  })

  it('带被动标记时被动模式替代之（DG 优先于进击，规则上二者互斥）', () => {
    expect(effectiveMode({ ...COMBAT, exploit: true })).toBe('exploit')
    expect(effectiveMode({ ...COMBAT, dg: true })).toBe('dg')
  })
})

describe('模式状态不变量（5.7b / 5.8 / 5.9 / 5.10）', () => {
  it('合法组合无问题', () => {
    expect(validateModeState(COMBAT)).toEqual([])
    expect(validateModeState({ ...COMBAT, dg: true })).toEqual([])
    expect(validateModeState({ ...COMBAT, exploit: true })).toEqual([])
  })

  it('DG 与进击互斥（5.10b-C：DG 无法获得进击模式）', () => {
    expect(validateModeState({ ...COMBAT, dg: true, exploit: true })).toContain('dgWithExploit')
  })

  it('DG 会移除其他所有模式标记（5.10）→ 与预备/战略不并存', () => {
    expect(validateModeState({ ...COMBAT, mode: 'reserve', dg: true })).toContain(
      'dgWithModeMarker',
    )
    expect(
      validateModeState({ ...COMBAT, mode: 'strat', orientation: 'move', dg: true }),
    ).toContain('dgWithModeMarker')
  })

  it('进击保持当前朝向且预备释放会移除预备标记（5.9 / 5.7b）→ 与预备/战略不并存', () => {
    expect(validateModeState({ ...COMBAT, mode: 'reserve', exploit: true })).toContain(
      'exploitWithModeMarker',
    )
    expect(
      validateModeState({ ...COMBAT, mode: 'strat', orientation: 'move', exploit: true }),
    ).toContain('exploitWithModeMarker')
  })

  it('战略模式朝向必须是移动面（5.8）；战斗/移动模式与朝向必须一致（5.5/5.6）', () => {
    expect(validateModeState({ ...COMBAT, mode: 'strat', orientation: 'combat' })).toContain(
      'stratMustFaceMove',
    )
    expect(validateModeState({ ...COMBAT, orientation: 'move' })).toContain('baseModeFaceMismatch')
    expect(
      validateModeState({ mode: 'move', orientation: 'combat', dg: false, exploit: false }),
    ).toContain('baseModeFaceMismatch')
  })
})

describe('MA 倍率（5.7 / 5.8 / 5.9 / 5.10b-A；6.1h 永不取整）', () => {
  it('战斗/移动模式无倍率', () => {
    expect(maMultiplier(COMBAT, 'movement')).toBe(1)
  })

  it('战略 ×2；混乱 ×1/2；进击 ×1/2', () => {
    expect(maMultiplier({ ...COMBAT, mode: 'strat', orientation: 'move' }, 'movement')).toBe(2)
    expect(maMultiplier({ ...COMBAT, dg: true }, 'movement')).toBe(0.5)
    expect(maMultiplier({ ...COMBAT, exploit: true }, 'exploitation')).toBe(0.5)
  })

  it('预备：未释放只能在本方移动阶段动 1/4，反应/进击阶段为 0（须先释放）', () => {
    const reserve: ModeState = { ...COMBAT, mode: 'reserve' }
    expect(maMultiplier(reserve, 'movement')).toBe(0.25)
    expect(maMultiplier(reserve, 'reaction')).toBe(0)
    expect(maMultiplier(reserve, 'exploitation')).toBe(0)
  })

  it('预备释放后：反应阶段 ×1/2、进击阶段 ×1（5.7b）', () => {
    const released: ModeState = { ...COMBAT, mode: 'reserve', releasedFromReserve: true }
    expect(maMultiplier(released, 'reaction')).toBe(0.5)
    expect(maMultiplier(released, 'exploitation')).toBe(1)
  })

  it('优先级：进击（×1/2）高于「刚释放的预备」的阶段加成（5.9 明确用一半 MA 移动）', () => {
    const exploitReleased: ModeState = {
      ...COMBAT,
      exploit: true,
      releasedFromReserve: true,
    }
    expect(maMultiplier(exploitReleased, 'exploitation')).toBe(0.5)
    // 无进击标记时才吃到 5.7b 的进击阶段满额
    expect(maMultiplier({ ...COMBAT, releasedFromReserve: true }, 'exploitation')).toBe(1)
  })
})

describe('规范模式（5.7b：释放即回朝向那一面）', () => {
  it('预备已释放 → 折回朝向；未释放/基础模式/进击均原样', () => {
    expect(
      canonicalMode({
        mode: 'reserve',
        orientation: 'combat',
        dg: false,
        exploit: false,
        releasedFromReserve: true,
      }),
    ).toBe('combat')
    expect(
      canonicalMode({
        mode: 'reserve',
        orientation: 'move',
        dg: false,
        exploit: false,
        releasedFromReserve: true,
      }),
    ).toBe('move')
    expect(
      canonicalMode({ mode: 'reserve', orientation: 'combat', dg: false, exploit: false }),
    ).toBe('reserve')
    expect(canonicalMode(COMBAT)).toBe('combat')
    expect(canonicalMode({ ...COMBAT, exploit: true })).toBe('combat')
  })
})

describe('模式效果（5.7 / 5.8 / 5.10b）', () => {
  it('DG：减半不取整、行动值 −1、不能突袭、不投射 ZOC', () => {
    const r = resolveModeStats(
      { attack: 9, ar: 3, ma: 5, barrage: 7 },
      { ...COMBAT, dg: true },
      'movement',
    )
    expect(r.attack).toBe(4.5)
    expect(r.defense).toBe(4.5)
    expect(r.ar).toBe(2)
    expect(r.ma).toBe(2.5)
    expect(r.barrage).toBe(3.5)
    expect(r.canOverrun).toBe(false)
    expect(r.exertsZoc).toBe(false)
  })

  it('战略：战斗值与行动值归零、不可攻击/轰炸/突袭、MA ×2', () => {
    const r = resolveModeStats(RAW, { ...COMBAT, mode: 'strat', orientation: 'move' }, 'movement')
    expect(r).toMatchObject({
      attack: 0,
      defense: 0,
      ar: 0,
      ma: 16,
      canAttack: false,
      canBarrage: false,
      canOverrun: false,
      exertsZoc: false,
    })
  })

  it('预备被释放前：不可攻击/轰炸/突袭，防御减半（攻击值本身不改写）', () => {
    const r = resolveModeStats(RAW, { ...COMBAT, mode: 'reserve' }, 'movement')
    expect(r.attack).toBe(10)
    expect(r.defense).toBe(5)
    expect(r).toMatchObject({ canAttack: false, canBarrage: false, canOverrun: false })
  })

  it('DG 与预备/战略/进击不可叠加（5.10）：一旦同时出现即状态非法，矩阵只按生效模式取一行', () => {
    const mixed: ModeState = { ...COMBAT, mode: 'reserve', dg: true }
    expect(validateModeState(mixed)).toContain('dgWithModeMarker')
    // 5.4a：被动模式替代当前模式 → 生效模式是 DG，取 DG 行（防御 ×1/2），不与预备倍率相乘
    const r = resolveModeStats(RAW, mixed, 'movement')
    expect(r.effectiveMode).toBe('dg')
    expect(r.defense).toBe(5)
  })
})

describe('影响矩阵（5.5–5.10；基础模式 + 层叠标记）', () => {
  const state = (over: Partial<ModeState>): ModeState => ({ ...COMBAT, ...over })

  it('矩阵行齐备且每行都标了条文出处', () => {
    expect(Object.keys(MODE_MARKER_EFFECTS).sort()).toEqual(
      ['dg', 'exploit', 'reserve', 'strat'].sort(),
    )
    expect(BASE_MODE_EFFECT.zoc).toBe('fromBase')
    for (const effect of [BASE_MODE_EFFECT, ...Object.values(MODE_MARKER_EFFECTS)]) {
      expect(effect.rule.length).toBeGreaterThan(0)
    }
    // 战斗/移动模式共用基础行
    expect(modeEffectsFor('combat')).toBe(BASE_MODE_EFFECT)
    expect(modeEffectsFor('move')).toBe(BASE_MODE_EFFECT)
  })

  it('baseOrientation：战斗/移动模式的模式本身即朝向；预备/战略另看 orientation（5.4a）', () => {
    expect(baseOrientation(state({ mode: 'combat' }))).toBe('combat')
    expect(baseOrientation(state({ mode: 'move', orientation: 'move' }))).toBe('move')
    expect(baseOrientation(state({ mode: 'reserve', orientation: 'combat' }))).toBe('combat')
    expect(baseOrientation(state({ mode: 'strat', orientation: 'move' }))).toBe('move')
  })

  it('★ ZOC（用户裁定）：战斗模式有；移动模式无；进击保留基础模式；预备/战略/DG 无', () => {
    expect(exertsZoc(state({ mode: 'combat' }))).toBe(true)
    expect(exertsZoc(state({ mode: 'move', orientation: 'move' }))).toBe(false)
    // 进击是例外：战斗面 + 进击 → 有控制区（5.9c）
    expect(exertsZoc(state({ mode: 'combat', exploit: true }))).toBe(true)
    // 移动面 + 进击 → 原本就没有，故也没有
    expect(exertsZoc(state({ mode: 'move', orientation: 'move', exploit: true }))).toBe(false)
    // 预备（无论朝向）、战略、DG 一律无
    expect(exertsZoc(state({ mode: 'reserve', orientation: 'combat' }))).toBe(false)
    expect(exertsZoc(state({ mode: 'strat', orientation: 'move' }))).toBe(false)
    expect(exertsZoc(state({ mode: 'combat', dg: true }))).toBe(false)
  })

  it('铁路/空运/海运：只有移动模式可用（5.5a / 5.6a / 5.7e / 5.8d / 5.10d）', () => {
    expect(canUseTransport(state({ mode: 'move', orientation: 'move' }))).toBe(true)
    expect(canUseTransport(state({ mode: 'combat' }))).toBe(false)
    expect(canUseTransport(state({ mode: 'reserve' }))).toBe(false)
    expect(canUseTransport(state({ mode: 'strat', orientation: 'move' }))).toBe(false)
    expect(canUseTransport(state({ mode: 'combat', dg: true }))).toBe(false)
    // 进击单位只处于进击模式，不满足 5.6a「采用移动模式」→ 不可（推导）
    expect(canUseTransport(state({ mode: 'move', orientation: 'move', exploit: true }))).toBe(false)
  })

  it('工程/轨距转换：需战斗模式；DG 单位朝向战斗面仍可（5.5b / 5.10e）', () => {
    expect(canEngineer(state({ mode: 'combat' }))).toBe(true)
    expect(canConvertGauge(state({ mode: 'combat' }))).toBe(true)
    expect(canEngineer(state({ mode: 'move', orientation: 'move' }))).toBe(false)
    expect(canEngineer(state({ mode: 'reserve', orientation: 'combat' }))).toBe(false)
    // 5.10e：DG 时铁路修理/工程单位仍能执行特殊功能，前提是朝向战斗面
    expect(canEngineer(state({ mode: 'combat', dg: true }))).toBe(true)
    expect(canEngineer(state({ mode: 'move', orientation: 'move', dg: true }))).toBe(false)
  })

  it('5.7g：预备模式单位不可与环形工事堆叠', () => {
    expect(canStackWithHedgehog(state({ mode: 'reserve' }))).toBe(false)
    expect(canStackWithHedgehog(state({ mode: 'combat' }))).toBe(true)
    expect(canStackWithHedgehog(state({ mode: 'strat', orientation: 'move' }))).toBe(true)
    expect(canStackWithHedgehog(state({ mode: 'combat', dg: true }))).toBe(true)
  })

  it('5.8b：只有战略模式必须在拥有追溯补给的格结束移动', () => {
    expect(mustEndMoveInSupply(state({ mode: 'strat', orientation: 'move' }))).toBe(true)
    expect(mustEndMoveInSupply(state({ mode: 'combat' }))).toBe(false)
    expect(mustEndMoveInSupply(state({ mode: 'reserve' }))).toBe(false)
  })

  it('modeEffect：预备释放后回到基础模式行（5.7b 标记已移除）', () => {
    expect(modeEffect(state({ mode: 'reserve' }))).toBe(MODE_MARKER_EFFECTS.reserve)
    expect(modeEffect(state({ mode: 'reserve', releasedFromReserve: true }))).toBe(BASE_MODE_EFFECT)
  })

  it('5.7b：预备释放后视同无标记——朝向移动面则可铁路运输、朝向战斗面则可工程且有 ZOC', () => {
    const releasedMove: ModeState = {
      mode: 'reserve',
      orientation: 'move',
      dg: false,
      exploit: false,
      releasedFromReserve: true,
    }
    const releasedCombat: ModeState = { ...releasedMove, orientation: 'combat' }

    expect(activeMarker(releasedMove)).toBeNull()
    expect(isInMoveMode(releasedMove)).toBe(true)
    expect(isInCombatMode(releasedCombat)).toBe(true)
    expect(canUseTransport(releasedMove)).toBe(true)
    expect(canUseTransport(releasedCombat)).toBe(false)
    expect(canEngineer(releasedCombat)).toBe(true)
    expect(canEngineer(releasedMove)).toBe(false)
    expect(exertsZoc(releasedCombat)).toBe(true)

    // 未释放时两者都不行
    const unreleased: ModeState = { ...releasedMove, releasedFromReserve: false }
    expect(activeMarker(unreleased)).toBe('reserve')
    expect(canUseTransport(unreleased)).toBe(false)
    expect(canEngineer(unreleased)).toBe(false)
  })

  it('5.10 / 5.10c：承受 DG 结果后只留 DG；运输点数只是失去预备标记', () => {
    expect(markersAfterDg({ unitClass: 'combat', state: state({ mode: 'reserve' }) })).toBe(
      'dgOnly',
    )
    expect(markersAfterDg({ unitClass: 'transportPoint', state: state({ mode: 'reserve' }) })).toBe(
      'loseReserveMarkerOnly',
    )
  })
})

describe('DG 的移动/战斗模式朝向（5.4 / 5.4a / 5.10 / 5.10d）', () => {
  const dgMove: ModeState = { mode: 'move', orientation: 'move', dg: true, exploit: false }
  const dgCombat: ModeState = { mode: 'combat', orientation: 'combat', dg: true, exploit: false }

  it('5.10：DG 保留原朝向，两种朝向都是合法状态', () => {
    expect(validateModeState(dgMove)).toEqual([])
    expect(validateModeState(dgCombat)).toEqual([])
    expect(baseOrientation(dgMove)).toBe('move')
    expect(baseOrientation(dgCombat)).toBe('combat')
  })

  it('★ 5.4a 反面例子：DG + 朝移动面 ≠ 移动模式 → 不能铁路（5.10d）', () => {
    expect(isInMoveMode(dgMove)).toBe(false)
    expect(canUseTransport(dgMove)).toBe(false)
    // 对照：真正的移动模式可以铁路
    expect(canUseTransport({ ...dgMove, dg: false })).toBe(true)
  })

  it('数值以「朝向那一面的印值」为基准再按 DG 减半（战斗面 10-5-4 / 移动面 5-3-8）', () => {
    const combatFace = resolveModeStats({ attack: 10, ar: 5, ma: 4 }, dgCombat, 'movement')
    const moveFace = resolveModeStats({ attack: 5, ar: 3, ma: 8 }, dgMove, 'movement')
    expect(combatFace).toMatchObject({ attack: 5, ar: 4, ma: 2 })
    expect(moveFace).toMatchObject({ attack: 2.5, ar: 2, ma: 4 })
    // 两种朝向都：无 ZOC、不能突袭（★ 用户裁定 + 5.10b-C）
    expect(exertsZoc(dgCombat)).toBe(false)
    expect(exertsZoc(dgMove)).toBe(false)
    expect(combatFace.canOverrun).toBe(false)
    expect(moveFace.canOverrun).toBe(false)
  })

  it('5.10c：运输点数不受 DG 影响，永远不会处于该模式', () => {
    expect(validateModeState({ ...COMBAT, dg: true }, 'transportPoint')).toContain(
      'transportPointInDg',
    )
    expect(validateModeState({ ...COMBAT, dg: true }, 'combat')).not.toContain('transportPointInDg')
    expect(validateModeState({ ...COMBAT, dg: true })).not.toContain('transportPointInDg')
  })
})

describe('只改朝向（5.4 末句 / 5.7a）', () => {
  it('5.4 末句：DG 单位在移动阶段可以改朝向，且仍是 DG 模式', () => {
    const dg: ModeState = { mode: 'combat', orientation: 'combat', dg: true, exploit: false }
    expect(canFlipOrientation({ state: dg, phase: 'movement' })).toEqual({ ok: true, rule: '5.4' })
    const flipped = flipOrientation(dg)
    expect(flipped).toMatchObject({ mode: 'move', orientation: 'move', dg: true })
    // 翻完仍是 DG：无 ZOC、不能铁路
    expect(effectiveMode(flipped)).toBe('dg')
    expect(exertsZoc(flipped)).toBe(false)
    expect(canUseTransport(flipped)).toBe(false)
  })

  it('5.7a：预备可以改朝向，但本回合刚进入预备则不行', () => {
    const reserve: ModeState = { mode: 'reserve', orientation: 'combat', dg: false, exploit: false }
    expect(canFlipOrientation({ state: reserve, phase: 'movement' })).toEqual({
      ok: true,
      rule: '5.7a',
    })
    expect(
      canFlipOrientation({ state: reserve, phase: 'movement', enteredReserveThisTurn: true }),
    ).toMatchObject({ ok: false, rule: '5.7a' })
    expect(flipOrientation(reserve)).toMatchObject({ mode: 'reserve', orientation: 'move' })
  })

  it('5.8：战略模式朝向必须是移动面，不可更改', () => {
    const strat: ModeState = { mode: 'strat', orientation: 'move', dg: false, exploit: false }
    expect(canFlipOrientation({ state: strat, phase: 'movement' })).toMatchObject({
      ok: false,
      rule: '5.8',
    })
  })

  it('战斗/移动模式下「朝向即模式」，改朝向应走模式切换', () => {
    expect(canFlipOrientation({ state: COMBAT, phase: 'movement' })).toMatchObject({
      ok: false,
      rule: '5.5/5.6',
    })
  })

  it('移动阶段之外不得改朝向', () => {
    const dg: ModeState = { mode: 'combat', orientation: 'combat', dg: true, exploit: false }
    expect(canFlipOrientation({ state: dg, phase: 'reaction' })).toMatchObject({
      ok: false,
      rule: '5.4',
    })
    expect(canFlipOrientation({ state: dg, phase: 'exploitation' })).toMatchObject({
      ok: false,
      rule: '5.4',
    })
  })
})

describe('阶段可动性（6.0 / 6.3a / 7.0a / 11.0a）', () => {
  it('移动阶段：只有阶段玩家的单位可动', () => {
    expect(canMoveInPhase({ state: COMBAT, side: 'axis', activeSide: 'axis' }, 'movement').ok).toBe(
      true,
    )
    expect(
      canMoveInPhase({ state: COMBAT, side: 'soviet', activeSide: 'axis' }, 'movement'),
    ).toMatchObject({
      ok: false,
      rule: '6.0',
    })
  })

  it('反应阶段：只有非阶段玩家的**已释放预备**可动', () => {
    const released: ModeState = { ...COMBAT, mode: 'reserve', releasedFromReserve: true }
    expect(
      canMoveInPhase({ state: released, side: 'soviet', activeSide: 'axis' }, 'reaction').ok,
    ).toBe(true)
    // 阶段玩家自己的单位不能动（6.3a）
    expect(
      canMoveInPhase({ state: released, side: 'axis', activeSide: 'axis' }, 'reaction'),
    ).toMatchObject({
      ok: false,
      rule: '6.3a',
    })
    // 未释放的预备不能动（7.0a）
    expect(
      canMoveInPhase({ state: COMBAT, side: 'soviet', activeSide: 'axis' }, 'reaction'),
    ).toMatchObject({
      ok: false,
      rule: '7.0a',
    })
  })

  it('进击阶段：只有阶段玩家的进击模式单位或已释放预备可动', () => {
    expect(
      canMoveInPhase(
        { state: { ...COMBAT, exploit: true }, side: 'axis', activeSide: 'axis' },
        'exploitation',
      ).ok,
    ).toBe(true)
    expect(
      canMoveInPhase(
        { state: { ...COMBAT, releasedFromReserve: true }, side: 'axis', activeSide: 'axis' },
        'exploitation',
      ).ok,
    ).toBe(true)
    expect(
      canMoveInPhase({ state: COMBAT, side: 'axis', activeSide: 'axis' }, 'exploitation'),
    ).toMatchObject({
      ok: false,
      rule: '11.0a',
    })
  })
})

describe('不可移动状态（6.1b / 5.5c / 5.6b）', () => {
  it('SP / 空军基地 / 环形工事 / 港口归为 facility，不可移动', () => {
    for (const kind of ['sp', 'air_base', 'hedgehog', 'port']) {
      const profile = { noncombatKind: kind, ma: 0 }
      expect(modeUnitClass(profile)).toBe('facility')
      expect(isMobileUnit(profile)).toBe(false)
    }
  })

  it('MA 为 0 的单位不可移动；MA > 0 才可', () => {
    expect(isMobileUnit({ ma: 0 })).toBe(false)
    expect(isMobileUnit({ ma: 3 })).toBe(true)
  })

  it('补员 → repl；运输点数 → transportPoint；编内卡车 → organicTruck', () => {
    expect(modeUnitClass({ specialized: ['replacement'] })).toBe('repl')
    expect(modeUnitClass({ noncombatKind: 'transport_point' })).toBe('transportPoint')
    expect(modeUnitClass({ noncombatKind: 'organic_truck' })).toBe('organicTruck')
    expect(modeUnitClass({})).toBe('combat')
  })
})

describe('模式切换合法性（5.4 + 4.5a-I/J + 5.5c + 5.7c/f + 5.8a/c + 专规 2.3e）', () => {
  const base = {
    to: 'reserve' as const,
    orientation: 'combat' as const,
    inEnemyZoc: false,
    unitClass: 'combat' as ModeUnitClass,
    side: 'axis' as const,
    phase: 'movement' as const,
  }

  it('移动阶段内可正常切换；切换不消耗 MP（5.4）', () => {
    expect(canSwitchMode(base)).toEqual({ ok: true })
    expect(canSwitchMode({ ...base, to: 'combat', orientation: 'combat' })).toEqual({ ok: true })
    expect(canSwitchMode({ ...base, to: 'move', orientation: 'move' })).toEqual({ ok: true })
    expect(modeSwitchCost()).toBe(0)
  })

  it('移动阶段之外不允许切换（5.4）', () => {
    expect(canSwitchMode({ ...base, phase: 'reaction' })).toMatchObject({ ok: false, rule: '5.4' })
    expect(canSwitchMode({ ...base, phase: 'exploitation' })).toMatchObject({
      ok: false,
      rule: '5.4',
    })
  })

  it('敌方 ZOC 内不可进入预备（5.7c / 4.5a-I）或战略（5.8a / 4.5a-J）', () => {
    expect(canSwitchMode({ ...base, inEnemyZoc: true })).toMatchObject({ ok: false, rule: '5.7c' })
    expect(
      canSwitchMode({ ...base, to: 'strat', orientation: 'move', inEnemyZoc: true }),
    ).toMatchObject({ ok: false, rule: '5.8a' })
  })

  it('战略模式必须朝向移动面（5.8）', () => {
    expect(canSwitchMode({ ...base, to: 'strat', orientation: 'combat' })).toMatchObject({
      ok: false,
      rule: '5.8',
    })
    expect(canSwitchMode({ ...base, to: 'strat', orientation: 'move' })).toEqual({ ok: true })
  })

  it('补员/运输点数不能进入战斗模式（5.5c）；运输点数不能进预备（5.7f）与战略（5.8c）', () => {
    expect(
      canSwitchMode({ ...base, to: 'combat', orientation: 'combat', unitClass: 'repl' }),
    ).toMatchObject({ ok: false, rule: '5.5c' })
    expect(canSwitchMode({ ...base, unitClass: 'transportPoint' })).toMatchObject({
      ok: false,
      rule: '5.7f',
    })
    expect(
      canSwitchMode({ ...base, to: 'strat', orientation: 'move', unitClass: 'transportPoint' }),
    ).toMatchObject({ ok: false, rule: '5.8c' })
    // 编内卡车是 5.7f 的例外
    expect(canSwitchMode({ ...base, unitClass: 'organicTruck' })).toEqual({ ok: true })
  })

  it('无 MA 设施不参与模式切换（6.1b）', () => {
    expect(canSwitchMode({ ...base, unitClass: 'facility' })).toMatchObject({
      ok: false,
      rule: '6.1b',
    })
  })

  it('专规 2.3e：8 月 1 日回合之前苏军不得进入战略模式（轴方不受限）', () => {
    const strat = { ...base, to: 'strat' as const, orientation: 'move' as const }
    expect(canSwitchMode({ ...strat, side: 'soviet', date: '1941-07-31' })).toMatchObject({
      ok: false,
      rule: '专规 2.3e',
    })
    expect(canSwitchMode({ ...strat, side: 'soviet', date: SOVIET_STRAT_MODE_FROM })).toEqual({
      ok: true,
    })
    expect(canSwitchMode({ ...strat, side: 'axis', date: '1941-07-08' })).toEqual({ ok: true })
  })
})

/**
 * 模式矩阵的入参收窄契约（B1 铺垫）
 *
 * 战斗与轰炸路径只有「模式 + DG + 是否本阶段释放的预备」（`BattleUnitView`），
 * 没有 `orientation` / `exploit`，故矩阵查询的入参收窄为结构子集。
 * 本组用例把这个收窄**钉住**：两条调用形式在战斗/轰炸所消费的三个倍率上必须逐一相同。
 */
describe('模式矩阵入参收窄（ModeMatrixInput）', () => {
  const MODES = ['combat', 'move', 'reserve', 'strat'] as const
  const ORIENTATIONS = ['combat', 'move'] as const

  /** 战斗/轰炸路径实际消费的三个倍率 */
  const numbersOf = (effect: ReturnType<typeof modeEffect>) => ({
    combat: effect.combatMult,
    defense: effect.defenseMult,
    barrage: effect.barrageMult,
  })

  it('全组合下：结构子集入参与完整 ModeState 的三个倍率逐一相同', () => {
    for (const mode of MODES) {
      for (const orientation of ORIENTATIONS) {
        for (const dg of [false, true]) {
          for (const released of [false, true]) {
            const full: ModeState = {
              mode,
              orientation,
              dg,
              exploit: false,
              releasedFromReserve: released,
            }
            // 战斗路径能给出的最小入参
            const narrow = { mode, dg, releasedFromReserve: released }
            expect(
              numbersOf(modeEffect(narrow)),
              `${mode}/${orientation}/dg=${dg}/rel=${released}`,
            ).toEqual(numbersOf(modeEffect(full)))
          }
        }
      }
    }
  })

  it('进击标记的省略是可证明的：其三个倍率均为 1，与基础行等价', () => {
    const exploit = MODE_MARKER_EFFECTS.exploit
    expect(numbersOf(exploit)).toEqual({ combat: 1, defense: 1, barrage: 1 })
    expect(numbersOf(BASE_MODE_EFFECT)).toEqual({ combat: 1, defense: 1, barrage: 1 })
  })

  it('DG 与「已释放的预备」是两条路径都必须传对的两个字段', () => {
    // DG：三个倍率都减半
    expect(numbersOf(modeEffect({ mode: 'combat', dg: true }))).toEqual({
      combat: 0.5,
      defense: 0.5,
      barrage: 0.5,
    })
    // 预备未释放：只有防御减半（5.7），攻击不减半
    expect(numbersOf(modeEffect({ mode: 'reserve' }))).toEqual({
      combat: 1,
      defense: 0.5,
      barrage: 1,
    })
    // 预备已释放：回到基础行（5.7b）——证明 releasedFromReserve 必须传入
    expect(numbersOf(modeEffect({ mode: 'reserve', releasedFromReserve: true }))).toEqual({
      combat: 1,
      defense: 1,
      barrage: 1,
    })
    // 战略：战斗值归零
    expect(numbersOf(modeEffect({ mode: 'strat' }))).toEqual({ combat: 0, defense: 0, barrage: 0 })
  })
})
