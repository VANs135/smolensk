import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'

import {
  ACTIONS_BY_PHASE,
  BARRAGE_SOURCES_BY_PHASE,
  LEGALITY_FAMILIES,
  TIMING_DEFERRED_ACTIONS,
  ZOC_FORBIDDEN,
  checkAllowance,
  checkFormation,
  checkFuel,
  checkLegality,
  checkMode,
  checkStacking,
  checkTiming,
  checkZoc,
  isLegal,
  legalityFailure,
  resolveAllowanceLimit,
  stackingObligations,
} from '@/engine/rules'
import type { GamePhase } from '@/engine/state-types'
import type { LegalityRequest, LegalityUnit, ModeState } from '@/engine/rules'

/**
 * 合法性校验层（B21）测试
 *
 * 断言全部照**中文规则书**与 2.2 流程表；每族单独测 + 聚合测，
 * 测试名带规则编号（CODE_SPEC §7）。
 */

/* ────────────────────────────── 夹具 ────────────────────────────── */

const HEX: HexRef = { col: 36, row: 13 }

/** 模式状态夹具（5.x）：默认战斗模式、未混乱、无进击标记 */
function modeState(over: Partial<ModeState> = {}): ModeState {
  return { mode: 'combat', orientation: 'combat', dg: false, exploit: false, ...over }
}

/** 基准单位：轴方步行战斗单位、战斗模式、MA 6 */
function unit(over: Partial<LegalityUnit> = {}): LegalityUnit {
  return {
    id: 'u1',
    isCombat: true,
    attackCapable: true,
    mobility: 'leg',
    mode: modeState(),
    re: 2,
    raw: { attack: 10, ar: 5, ma: 6, barrage: 6 },
    ...over,
  }
}

/** 基准请求：轴方在其移动阶段移动（合法态） */
function request(over: Partial<LegalityRequest> = {}): LegalityRequest {
  return {
    action: 'move',
    side: 'axis',
    phase: 'movement',
    activeSide: 'axis',
    date: '1941-07-08',
    units: [unit()],
    ...over,
  }
}

/* ────────────────────────────── 时机族（2.2） ────────────────────────────── */

describe('时机族（2.2 流程表 + 6.3a / 7.0a / 11.0a）', () => {
  it('2.2：动作必须出现在当前 SOP 段的许可集合里', () => {
    expect(checkTiming(request({ action: 'move', phase: 'movement' }))).toEqual([])
    // 移动不能发生在战斗段
    expect(checkTiming(request({ action: 'move', phase: 'combat' }))).toMatchObject([
      { family: 'timing', rule: '2.2', reason: 'actionNotInSegment' },
    ])
    // 常规战斗不能发生在移动段
    expect(checkTiming(request({ action: 'attack', phase: 'movement' }))).toMatchObject([
      { rule: '2.2' },
    ])
    // H 清理段无玩家动作
    expect(checkTiming(request({ action: 'move', phase: 'cleanUp' })).length).toBe(1)
  })

  it('2.2：轰炸来源随段不同——C 段仅空中与舰炮、F 段仅炮兵（SOP 原文）', () => {
    // F / Combat 段：Barrage (artillery only)
    expect(
      checkTiming(request({ action: 'barrage', phase: 'combat', barrageSource: 'artillery' })),
    ).toEqual([])
    expect(
      checkTiming(request({ action: 'barrage', phase: 'combat', barrageSource: 'air' })),
    ).toMatchObject([{ rule: '10.1a', reason: 'barrageSourceNotAllowedInSegment' }])
    // C / Movement 段：Barrage (air & ship only)
    expect(
      checkTiming(request({ action: 'barrage', phase: 'movement', barrageSource: 'air' })),
    ).toEqual([])
    expect(
      checkTiming(request({ action: 'barrage', phase: 'movement', barrageSource: 'artillery' })),
    ).toMatchObject([{ rule: '2.2' }])
    expect(BARRAGE_SOURCES_BY_PHASE.combat).toEqual(['artillery'])
  })

  it('6.3a / 7.0a：反应阶段只能动非阶段玩家**已释放**的预备', () => {
    const released = {
      mode: modeState({ mode: 'reserve', releasedFromReserve: true }),
    }
    // 阶段玩家自己的单位不能动（6.3a）
    expect(
      checkTiming(
        request({ phase: 'reaction', side: 'axis', activeSide: 'axis', units: [unit(released)] }),
      ),
    ).toMatchObject([{ rule: '6.3a' }])
    // 未释放的预备不能动（7.0a）
    expect(
      checkTiming(request({ phase: 'reaction', side: 'soviet', activeSide: 'axis' })),
    ).toMatchObject([{ rule: '7.0a' }])
    // 非阶段玩家的已释放预备可以动
    expect(
      checkTiming(
        request({ phase: 'reaction', side: 'soviet', activeSide: 'axis', units: [unit(released)] }),
      ),
    ).toEqual([])
  })

  it('11.0a：进击阶段只有进击模式单位或已释放预备可动', () => {
    expect(
      checkTiming(request({ phase: 'exploitation', side: 'axis', activeSide: 'axis' })),
    ).toMatchObject([{ rule: '11.0a', reason: 'notExploitOrReleased' }])
    const exploit = { mode: modeState({ exploit: true }) }
    expect(
      checkTiming(
        request({
          phase: 'exploitation',
          side: 'axis',
          activeSide: 'axis',
          units: [unit(exploit)],
        }),
      ),
    ).toEqual([])
  })

  it('时机待定动作（airMission 等）在时机族里跳过，不臆造时机', () => {
    for (const action of TIMING_DEFERRED_ACTIONS) {
      expect(checkTiming(request({ action, phase: 'combat' }))).toEqual([])
    }
  })

  it('H④：燃料的时机由 12.5c 定义（列在延后表）⇒ 任何段的许可集合里都没有它', () => {
    /*
     * 用户 2026-09-19 口径：「补给阶段有燃料环节……燃料环节不应该存在，未加油单位是在移动前加油」。
     * 规则的支撑：12.5c 把付款绑在**消耗时刻**（「在发生燃料消耗的**任何阶段**，单位都应在燃料消耗时支付」）
     * ⇒ 2.2 的段名里没有燃料这一动作族，D 段（12.6 检定 / 12.10e 恢复）也不发生消耗。
     * 它的实际闸门在 store 的 `ACTION_GATES`（`supply.fuel` → C/E/G 的移动环节），本文件只钉"时机表不进它"。
     */
    expect(TIMING_DEFERRED_ACTIONS).toContain('fuel')
    expect(checkTiming(request({ action: 'fuel', phase: 'supply' }))).toEqual([])
    for (const list of Object.values(ACTIONS_BY_PHASE)) expect([...list]).not.toContain('fuel')
  })

  it('时机表逐段与 SOP 段内容一致（C 含突围/模式与移动、D 含补给、F 含战斗）', () => {
    expect(ACTIONS_BY_PHASE.movement).toContain('breakout')
    expect(ACTIONS_BY_PHASE.movement).toContain('modeChange')
    expect(ACTIONS_BY_PHASE.supply).toContain('supplyTrace')
    expect(ACTIONS_BY_PHASE.combat).toContain('attack')
    // H 段只有「清理」这一个动作（2.2 末段：「为他的单位移除所有进击和混乱(DG)标记…」）
    expect(ACTIONS_BY_PHASE.cleanUp).toEqual(['cleanUp'])
    // 13.6/2.1/3.1 到达投放、13.5a 重建、13.9 合并都在 B 增援段
    expect(ACTIONS_BY_PHASE.reinforcement).toEqual(['arrival', 'rebuild', 'consolidate'])
    // 反应阶段没有战斗（SOP：E. Reaction Phase: Movement / Barrage）
    expect(ACTIONS_BY_PHASE.reaction).not.toContain('attack')
  })
})

/* ────────────────────────────── 模式族（5.x） ────────────────────────────── */

describe('模式族（5.5a / 5.7 / 5.8 / 5.10b / 5.10e）', () => {
  it('5.8：战略模式不能攻击', () => {
    const strat = { mode: modeState({ mode: 'strat', orientation: 'move' }) }
    expect(
      checkMode(request({ action: 'attack', phase: 'combat', units: [unit(strat)] })),
    ).toMatchObject([{ family: 'mode', rule: '5.7/5.8', reason: 'modeForbidsAttack' }])
  })

  it('5.7：预备未释放不能攻击、轰炸、突袭', () => {
    const reserve = { mode: modeState({ mode: 'reserve' }) }
    expect(
      checkMode(request({ action: 'attack', phase: 'combat', units: [unit(reserve)] })),
    ).toMatchObject([{ reason: 'modeForbidsAttack' }])
    expect(
      checkMode(request({ action: 'barrage', phase: 'combat', units: [unit(reserve)] })),
    ).toMatchObject([{ reason: 'modeForbidsBarrage' }])
    expect(checkMode(request({ action: 'overrun', units: [unit(reserve)] }))).toMatchObject([
      { reason: 'modeForbidsOverrun' },
    ])
  })

  it('5.10b：DG 单位不能突袭（但可以攻击）', () => {
    const dg = { mode: modeState({ dg: true }) }
    expect(checkMode(request({ action: 'overrun', units: [unit(dg)] }))).toMatchObject([
      { rule: '5.10b', reason: 'dgCannotOverrun' },
    ])
    expect(checkMode(request({ action: 'attack', phase: 'combat', units: [unit(dg)] }))).toEqual([])
  })

  it('5.6a / 5.8d / 5.10d：铁路运输需要移动模式', () => {
    expect(checkMode(request({ action: 'railTransport' }))).toMatchObject([
      { rule: '5.6a/5.8d', reason: 'modeForbidsRail' },
    ])
    const moveMode = { mode: modeState({ mode: 'move', orientation: 'move' }) }
    expect(checkMode(request({ action: 'railTransport', units: [unit(moveMode)] }))).toEqual([])
  })

  it('5.10d：DG 单位不能使用铁路运输（无例外）', () => {
    const dg = { mode: modeState({ dg: true }) }
    expect(checkMode(request({ action: 'railTransport', units: [unit(dg)] }))).toMatchObject([
      { rule: '5.10d', reason: 'dgCannotRail' },
    ])
    // DG 的铁路修理单位亦不可（5.10d 无例外）
    expect(
      checkMode(request({ action: 'railTransport', units: [unit({ ...dg, railRepair: true })] })),
    ).toMatchObject([{ rule: '5.10d', reason: 'dgCannotRail' }])
  })

  it('13.3g-B：铁路修理单位可在**战斗模式**下使用铁路移动（5.6a 例外）', () => {
    expect(
      checkMode(request({ action: 'railTransport', units: [unit({ railRepair: true })] })),
    ).toEqual([])
    // 非铁路修理单位的战斗模式单位仍不可（5.6a）
    expect(checkMode(request({ action: 'railTransport' }))).toMatchObject([
      { reason: 'modeForbidsRail' },
    ])
  })

  it('13.3g：只有铁路修理单位能转换轨距（且须战斗模式/朝向战斗面）', () => {
    // 普通单位（即使具工程能力）不得转换轨距
    expect(
      checkMode(request({ action: 'railConversion', units: [unit({ engineerCapable: true })] })),
    ).toMatchObject([{ rule: '13.3g', reason: 'notRailRepairUnit' }])
    // 铁路修理单位在战斗模式 ⇒ 允许
    expect(
      checkMode(request({ action: 'railConversion', units: [unit({ railRepair: true })] })),
    ).toEqual([])
    // 铁路修理单位在移动模式 ⇒ 不允许（5.5b）
    const moveMode = { mode: modeState({ mode: 'move', orientation: 'move' }) }
    expect(
      checkMode(
        request({ action: 'railConversion', units: [unit({ ...moveMode, railRepair: true })] }),
      ),
    ).toMatchObject([{ rule: '5.5b', reason: 'modeForbidsEngineering' }])
  })

  it('5.5b：工程与轨距转换需要战斗模式', () => {
    expect(checkMode(request({ action: 'engineer' }))).toEqual([])
    const moveMode = { mode: modeState({ mode: 'move', orientation: 'move' }) }
    expect(checkMode(request({ action: 'engineer', units: [unit(moveMode)] }))).toMatchObject([
      { rule: '5.5b', reason: 'modeForbidsEngineering' },
    ])
  })

  it('5.10e：DG 时非工程兵不能修建环形工事，工程兵（朝战斗面）可以', () => {
    const dg = { mode: modeState({ dg: true }) }
    expect(checkMode(request({ action: 'buildHedgehog', units: [unit(dg)] }))).toMatchObject([
      { rule: '5.10e', reason: 'dgNonEngineerCannotBuildHedgehog' },
    ])
    expect(
      checkMode(
        request({ action: 'buildHedgehog', units: [unit({ ...dg, engineerCapable: true })] }),
      ),
    ).toEqual([])
  })

  it('4.5a-I/J + 5.7c/5.8a：敌方 ZOC 内不可进入预备或战略；5.8 战略须朝移动面', () => {
    expect(
      checkMode(request({ action: 'modeChange', modeTarget: 'reserve', inEnemyZoc: true })),
    ).toMatchObject([{ rule: '5.7c', reason: 'enterReserveInEnemyZoc' }])
    expect(
      checkMode(request({ action: 'modeChange', modeTarget: 'strat', inEnemyZoc: true })),
    ).toMatchObject([{ rule: '5.8a', reason: 'enterStratInEnemyZoc' }])
    // 朝战斗面进战略 → 5.8
    expect(checkMode(request({ action: 'modeChange', modeTarget: 'strat' }))).toMatchObject([
      { rule: '5.8', reason: 'stratMustFaceMove' },
    ])
    // 朝移动面且不在 ZOC → 放行
    const moveFace = { mode: modeState({ mode: 'move', orientation: 'move' }) }
    expect(
      checkMode(request({ action: 'modeChange', modeTarget: 'strat', units: [unit(moveFace)] })),
    ).toEqual([])
    // 缺 modeTarget 直接报错
    expect(checkMode(request({ action: 'modeChange' }))).toMatchObject([
      { reason: 'modeTargetMissing' },
    ])
  })
})

/* ────────────────────────────── 控制区族（4.5 / 4.5a / 4.5b / 4.8c） ────────────────────────────── */

describe('控制区族（4.5a A–K / 4.5b / 4.8c）', () => {
  it('4.5a 清单完整性：A–K 各一条，可抵消项恰为 A/B/D/F/H（原文 <Negation>）', () => {
    const items = ZOC_FORBIDDEN.map((entry) => entry.item)
    expect(items).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'])
    const negatable = ZOC_FORBIDDEN.filter((entry) => entry.negatable).map((entry) => entry.item)
    expect(negatable).toEqual(['A', 'B', 'D', 'F', 'H'])
    // I/J 由模式族执行（避免与 5.7c/5.8a 重复报错）
    expect(
      ZOC_FORBIDDEN.filter((entry) => entry.family === 'mode').map((entry) => entry.item),
    ).toEqual(['I', 'J'])
  })

  it('4.5a-H：敌方 ZOC 内不可整备，抵消后放行', () => {
    expect(
      checkZoc(request({ action: 'refit', phase: 'aircraftRefit', inEnemyZoc: true })).violations,
    ).toMatchObject([{ rule: '4.5a-H', reason: 'zocForbiddenUnlessNegated' }])
    expect(
      checkZoc(request({ action: 'refit', phase: 'aircraftRefit', inEnemyZoc: false })).violations,
    ).toEqual([])
  })

  it('4.5a-E：轨距转换在敌方 ZOC 内一律不可（抵消也不行）', () => {
    const result = checkZoc(request({ action: 'railConversion', inEnemyZoc: true }))
    expect(result.violations).toMatchObject([{ rule: '4.5a-E', reason: 'zocForbidden' }])
    expect(result.violations[0]?.detail).toContain('抵消也不可行')
  })

  it('4.5a-A：轮式进入敌方 ZOC 是**提示**（必须停止或突袭），徒步不受影响', () => {
    const truck = checkZoc(
      request({ action: 'move', units: [unit({ mobility: 'truck' })], inEnemyZoc: true }),
    )
    expect(truck.violations).toEqual([])
    expect(truck.warnings).toMatchObject([
      { family: 'zoc', rule: '4.5a-A', reason: 'truckMustStopOrOverrun' },
    ])
    // 徒步：既无违规也无提示
    expect(
      checkZoc(request({ action: 'move', units: [unit({ mobility: 'leg' })], inEnemyZoc: true })),
    ).toEqual({
      violations: [],
      warnings: [],
    })
  })

  it('4.8c：目标格有敌方战斗单位即不可直接进入', () => {
    const target = { hex: HEX, friendlyCombatRe: 0, enemyCombatUnits: 1 }
    expect(checkZoc(request({ action: 'move', target })).violations).toMatchObject([
      { rule: '4.8c', reason: 'enemyCombatUnitInHex' },
    ])
  })
})

/* ────────────────────────────── 燃料族（12.5a / 12.5b） ────────────────────────────── */

describe('燃料族（12.5a / 12.5b）', () => {
  it('12.5a：轮式/履带战斗单位未付燃料则不能消耗 MP；付清后放行', () => {
    const truck = unit({ mobility: 'truck' })
    expect(checkFuel(request({ action: 'move', units: [truck], fuelPaid: false }))).toMatchObject([
      { family: 'fuel', rule: '12.5a', reason: 'fuelNotPaid' },
    ])
    expect(checkFuel(request({ action: 'move', units: [truck], fuelPaid: true }))).toEqual([])
  })

  it('12.5a：步行单位与卡车等非战斗单位永不需要燃料', () => {
    expect(
      checkFuel(request({ action: 'move', units: [unit({ mobility: 'leg' })], fuelPaid: false })),
    ).toEqual([])
    expect(
      checkFuel(
        request({
          action: 'move',
          units: [unit({ mobility: 'truck', isCombat: false })],
          fuelPaid: false,
        }),
      ),
    ).toEqual([])
  })

  it('12.5b：攻击/防御/轰炸/撤退/推进都不需要燃料，只有移动与突袭需要', () => {
    expect(
      checkFuel(
        request({
          action: 'attack',
          phase: 'combat',
          units: [unit({ mobility: 'truck' })],
          fuelPaid: false,
        }),
      ),
    ).toEqual([])
    expect(
      checkFuel(
        request({ action: 'overrun', units: [unit({ mobility: 'truck' })], fuelPaid: false }),
      ),
    ).toMatchObject([{ rule: '12.5b' }])
  })
})

/* ────────────────────────────── 堆叠族（4.8 / 4.8a） ────────────────────────────── */

describe('堆叠族（4.8 / 4.8a：不是逐步禁令，而是阶段末义务）', () => {
  it('4.8：一格至多 1 港口 + 1 空军基地 + 1 环形工事', () => {
    const target = {
      hex: HEX,
      friendlyCombatRe: 0,
      enemyCombatUnits: 0,
      ports: 1,
      airBases: 1,
      hedgehogs: 1,
    }
    expect(
      checkStacking(request({ action: 'move', units: [unit({ noncombatKind: 'port' })], target })),
    ).toMatchObject([{ rule: '4.8', reason: 'portPerHexLimit' }])
    expect(
      checkStacking(
        request({ action: 'move', units: [unit({ noncombatKind: 'air_base' })], target }),
      ),
    ).toMatchObject([{ rule: '4.8', reason: 'airBasePerHexLimit' }])
    expect(
      checkStacking(
        request({ action: 'move', units: [unit({ noncombatKind: 'hedgehog' })], target }),
      ),
    ).toMatchObject([{ rule: '4.8', reason: 'hedgehogPerHexLimit' }])
  })

  it('4.8a：10 RE 上限不计非战斗单位、只计同方战斗单位', () => {
    // 格内友军 9 RE + 本次 2 RE = 11 > 10 → 义务
    const target = { hex: HEX, friendlyCombatRe: 9, enemyCombatUnits: 0 }
    const verdict = checkLegality(request({ action: 'move', target }))
    expect(isLegal(verdict)).toBe(true)
    expect(verdict.obligations).toMatchObject([
      { family: 'stacking', rule: '4.8a', reason: 'overstackAtSegmentEnd' },
    ])
    // 非战斗单位不计入 → 不产生义务
    const nonCombat = checkLegality(
      request({ action: 'move', target, units: [unit({ isCombat: false })] }),
    )
    expect(nonCombat.obligations).toEqual([])
  })

  it('4.8a：超堆叠义务在**环节/阶段结束时**才结算，增援阶段例外（13.6）', () => {
    expect(stackingObligations(HEX, 11, 'movement')).toMatchObject([{ rule: '4.8a' }])
    expect(stackingObligations(HEX, 10, 'movement')).toEqual([])
    // 13.6：增援阶段没有超堆叠限制
    expect(stackingObligations(HEX, 30, 'reinforcement')).toEqual([])
  })
})

/* ────────────────────────────── 额度族与编队同源族 ────────────────────────────── */

describe('额度族（专规 1.2 / 13.3 / 13.3g）', () => {
  it('专规 1.2：铁路容量按日期取上限（19 July 前轴方 0、之后 1）', () => {
    const early = request({ action: 'railTransport', date: '1941-07-08', side: 'axis' })
    expect(
      checkAllowance({ ...early, allowance: { kind: 'railCap', used: 0, required: 1 } }),
    ).toMatchObject([{ rule: '专规 1.2', reason: 'allowanceExceeded' }])
    const late = request({ action: 'railTransport', date: '1941-07-19', side: 'axis' })
    expect(
      checkAllowance({ ...late, allowance: { kind: 'railCap', used: 0, required: 1 } }),
    ).toEqual([])
    // 苏方提升前即为 2
    expect(
      resolveAllowanceLimit(
        { kind: 'railCap', used: 0, required: 0 },
        { date: '1941-07-08', side: 'soviet' },
      ),
    ).toBe(2)
  })

  it('13.3g：每阶段轨距转换上限', () => {
    expect(
      checkAllowance(
        request({
          action: 'railConversion',
          allowance: { kind: 'railConversion', used: 3, required: 2 },
        }),
      ),
    ).toMatchObject([{ rule: '13.3g' }])
    expect(
      checkAllowance(
        request({
          action: 'railConversion',
          allowance: { kind: 'railConversion', used: 2, required: 2 },
        }),
      ),
    ).toEqual([])
  })

  it('custom 额度未给上限时报错，不静默放行', () => {
    expect(
      checkAllowance(request({ allowance: { kind: 'custom', used: 0, required: 1 } })),
    ).toMatchObject([{ reason: 'allowanceLimitUnknown' }])
    expect(
      checkAllowance(request({ allowance: { kind: 'custom', used: 1, required: 1, limit: 2 } })),
    ).toEqual([])
  })
})

describe('编队同源族（12.5c-A）', () => {
  it('未共用同一 HQ/补给站来源时不能走编队法（提示改用单单位法）', () => {
    const req = request({ action: 'fuel', phase: 'supply', fuelMethod: 'formation' })
    expect(checkFormation(req)).toMatchObject([
      { rule: '12.5c-A', reason: 'formationFactsMissing' },
    ])
    expect(
      checkFormation({ ...req, formation: { sameSource: false, unitCount: 3 } }),
    ).toMatchObject([{ family: 'formation', rule: '12.5c-A', reason: 'formationSourceNotShared' }])
    expect(checkFormation({ ...req, formation: { sameSource: true, unitCount: 3 } })).toEqual([])
  })

  it('HQ 法与单单位法不受同源约束', () => {
    expect(checkFormation(request({ action: 'fuel', phase: 'supply', fuelMethod: 'hq' }))).toEqual(
      [],
    )
    expect(
      checkFormation(request({ action: 'fuel', phase: 'supply', fuelMethod: 'singleUnit' })),
    ).toEqual([])
  })
})

/* ────────────────────────────── 聚合入口 ────────────────────────────── */

describe('统一前置校验（checkLegality）', () => {
  it('合法动作：ok=true、checked 恒为七族、无违规', () => {
    const verdict = checkLegality(request())
    expect(isLegal(verdict)).toBe(true)
    expect(verdict.checked).toEqual(LEGALITY_FAMILIES)
    expect(verdict.warnings).toEqual([])
    if (verdict.ok) expect(legalityFailure(verdict)).toBeNull()
  })

  it('多族同时违规时**全量收集**（不短路），便于界面一次讲清', () => {
    // 战斗段做移动（时机）+ 轮式未付燃料（燃料）+ 目标格有敌战斗单位（控制区）
    const verdict = checkLegality(
      request({
        action: 'move',
        phase: 'combat',
        units: [unit({ mobility: 'truck' })],
        fuelPaid: false,
        target: { hex: HEX, friendlyCombatRe: 0, enemyCombatUnits: 1 },
      }),
    )
    expect(isLegal(verdict)).toBe(false)
    if (verdict.ok) return
    // 违规族按 LEGALITY_FAMILIES 顺序汇总（timing → mode → zoc → fuel → …）
    const families = verdict.violations.map((violation) => violation.family)
    expect(families).toEqual(['timing', 'zoc', 'fuel'])
    expect(verdict.checked).toEqual(LEGALITY_FAMILIES)
  })

  it('legalityFailure：投影到 B3 统一失败形状（rule + reason）', () => {
    const verdict = checkLegality(request({ action: 'move', phase: 'combat' }))
    const failure = legalityFailure(verdict)
    expect(failure).toEqual({ ok: false, rule: '2.2', reason: 'actionNotInSegment' })
  })

  it('提示与义务随通过结论一并返回（轮式 ZOC 提示 + 超堆叠义务）', () => {
    const verdict = checkLegality(
      request({
        units: [unit({ mobility: 'truck' })],
        fuelPaid: true,
        inEnemyZoc: true,
        target: { hex: HEX, friendlyCombatRe: 9, enemyCombatUnits: 0 },
      }),
    )
    expect(isLegal(verdict)).toBe(true)
    expect(verdict.warnings).toMatchObject([{ rule: '4.5a-A' }])
    expect(verdict.obligations).toMatchObject([{ rule: '4.8a' }])
  })

  it('七族之外不产生额外约束：无单位请求也能通过时机判定', () => {
    const phase: GamePhase = 'aircraftRefit'
    expect(
      isLegal(
        checkLegality({
          action: 'refit',
          side: 'axis',
          phase,
          activeSide: 'axis',
          date: '1941-07-08',
        }),
      ),
    ).toBe(true)
  })
})
