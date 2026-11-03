import { describe, expect, it } from 'vitest'
import type { HexRef } from '@/data'
import { neighbor, sameHex } from '@/engine/hex-geometry'
import type { AirUnitTransportState } from '@/engine/rules/air-unit-movement'
import {
  availableMa,
  beginBarrage,
  beginMove,
  canOverrun,
  canFlipOrientation,
  canSwitchModeNow,
  checkLegality,
  checkMode,
  computeReachableHexes,
  evaluateStepFrom,
  planStep,
  undoMoveStep,
  unitBattleStrength,
  validateBattleComposition,
  type BattleFacts,
  type BattleUnitView,
  type LegalityRequest,
  type LegalityUnit,
  type MoveContext,
  type MoveUnitRuntime,
  type MoveUnitView,
} from '@/engine/rules'

const origin: HexRef = { col: 36, row: 13 }
const target = neighbor(origin, 'N')
const flight = (overrides: Partial<AirUnitTransportState> = {}): AirUnitTransportState => ({
  kind: 'air_transport',
  phase: 'movement',
  releasedFromReserve: false,
  ...overrides,
})
const movingUnit = (overrides: Partial<MoveUnitView> = {}): MoveUnitView => ({
  id: 'u',
  side: 'axis',
  isCombat: true,
  attackCapable: true,
  hasTraceSupply: true,
  hex: origin,
  mobility: 'leg',
  ma: 8,
  re: 1,
  mode: 'move',
  orientation: 'move',
  dg: false,
  exploit: false,
  releasedFromReserve: false,
  fuelled: false,
  mpLockedThisPhase: false,
  ...overrides,
})
const context = (unit: MoveUnitView, phase: MoveContext['phase'] = 'movement'): MoveContext => ({
  phase,
  activeSide: phase === 'reaction' ? 'soviet' : 'axis',
  units: [unit],
  map: {
    onMap: (hex) => sameHex(hex, origin) || sameHex(hex, target),
    terrainsAt: () => ['Open'],
    crossingBetween: () => null,
  },
})
const battleUnit = (overrides: Partial<BattleUnitView> = {}): BattleUnitView => ({
  id: 'u',
  side: 'axis',
  hex: origin,
  attackerType: 'other',
  attack: 8,
  ar: 4,
  dg: false,
  mode: 'move',
  printedSteps: 1,
  steps: 1,
  re: 1,
  internalStocks: null,
  outOfSupply: false,
  mobility: 'leg',
  attackCapable: true,
  ...overrides,
})
const facts: BattleFacts = {
  canEnterForAttack: () => true,
  hedgehogLevelAt: () => 0,
  hexsideTerrainsBetween: () => [],
  hexTerrainsAt: () => ['Open'],
  defenderAtLevelAt: () => 'none',
  attackedThisSegmentBy: () => false,
  attackedThisSegmentAt: () => false,
}
const legalityUnit = (transport: AirUnitTransportState): LegalityUnit => ({
  id: 'u',
  isCombat: true,
  attackCapable: true,
  mobility: 'leg',
  mode: { mode: 'move', orientation: 'move', dg: false, exploit: true },
  re: 1,
  raw: { ma: 8, attack: 8, ar: 4, barrage: 8 },
  airTransportThisPhase: transport,
})
const request = (overrides: Partial<LegalityRequest> = {}): LegalityRequest => ({
  action: 'attack',
  phase: 'exploitation',
  side: 'axis',
  activeSide: 'axis',
  date: '1941-07-08',
  units: [legalityUnit(flight({ phase: 'exploitation' }))],
  ...overrides,
})

describe('14.9d / 4.7d：单位空运后的行动闸门', () => {
  it.each([
    ['movement', false, 4],
    ['reaction', true, 2],
    ['exploitation', true, 4],
  ] as const)('阶段 %s、已释放预备 %s：额度为 %s，保持实际已耗MP及撤销', (phase, released, ma) => {
    const unit = movingUnit({
      releasedFromReserve: released,
      airTransportThisPhase: flight({ phase, releasedFromReserve: released }),
    })
    const ctx = context(unit, phase)
    expect(availableMa(unit, phase)).toBe(ma)
    const runtime: MoveUnitRuntime[] = [{ unitId: unit.id, hex: origin, spentMp: 1, ended: false }]
    const started = beginMove({ context: ctx, unitIds: ['u'], runtime })
    if (!started.ok) throw new Error(started.reason)
    const stepped = planStep({ context: ctx, interaction: started.data, runtime, to: target })
    if (!stepped.ok) throw new Error(stepped.reason)
    expect(stepped.data.patches[0]!.spentMp).toBe(2)
    expect(undoMoveStep(stepped.data.interaction).patches[0]!.spentMp).toBe(1)
    expect(evaluateStepFrom(ctx, unit, origin, target, { mpSpent: ma })).toMatchObject({
      ok: false,
      reason: 'notEnoughMp',
    })
  })

  it.each([flight({ phase: 'exploitation' }), flight({ kind: 'air_drop' })])(
    '额度为0时，进击标记和6.1c最小移动都不能放行：%o',
    (transport) => {
      const unit = movingUnit({ exploit: true, airTransportThisPhase: transport })
      const ctx = context(unit, transport.phase)
      expect(availableMa(unit, ctx.phase)).toBe(0)
      expect(evaluateStepFrom(ctx, unit, origin, target)).toMatchObject({
        ok: false,
        rule: '14.9d',
        reason: 'noMa',
      })
      expect(computeReachableHexes(ctx, 'u')).toMatchObject({ ok: false, rule: '14.9d' })
      expect(
        beginMove({
          context: ctx,
          unitIds: ['u'],
          runtime: [{ unitId: 'u', hex: origin, spentMp: 0, ended: false }],
        }),
      ).toMatchObject({ ok: false, rule: '14.9d' })
      expect(
        canOverrun({
          context: ctx,
          unitIds: ['u'],
          target,
          startedStackedTogether: true,
          mpRemaining: 100,
        }),
      ).toMatchObject({ ok: false, rule: '14.9d' })
    },
  )

  it('禁攻只作用于攻方，普通单位空运后仍可防守', () => {
    const transport = flight({ phase: 'exploitation' })
    const restricted = battleUnit({ airTransportThisPhase: transport })
    const enemy = battleUnit({ id: 'enemy', side: 'soviet', hex: target })
    expect(
      validateBattleComposition({ attackers: [restricted], defenders: [enemy], facts }),
    ).toMatchObject({ ok: false, rule: '14.9d' })
    expect(
      unitBattleStrength({
        unit: restricted,
        role: 'attacker',
        terrain: 'Open',
        combatSupplyPaid: true,
      }),
    ).toMatchObject({ strength: 0, rule: '14.9d', cannotAttack: true })
    expect(
      validateBattleComposition({ attackers: [enemy], defenders: [restricted], facts }).ok,
    ).toBe(true)
    expect(
      unitBattleStrength({
        unit: restricted,
        role: 'defender',
        terrain: 'Open',
        combatSupplyPaid: true,
      }).strength,
    ).toBeGreaterThan(0)
  })

  it('炮兵禁攻在轰炸宣布时拒绝；已释放预备及空军任务不被误拦', () => {
    const input = {
      kind: 'artillery' as const,
      phase: 'exploitation' as const,
      targetKind: 'combatUnits' as const,
      targetHex: target,
      units: [
        {
          unitId: 'art',
          printedValue: 8,
          airTransportThisPhase: flight({ phase: 'exploitation' }),
        },
      ],
    }
    expect(beginBarrage(input)).toMatchObject({ ok: false, rule: '14.9d' })
    expect(beginBarrage({ ...input, kind: 'air' }).ok).toBe(true)
    expect(
      beginBarrage({
        ...input,
        units: [
          {
            unitId: 'art',
            printedValue: 8,
            airTransportThisPhase: flight({ phase: 'exploitation', releasedFromReserve: true }),
          },
        ],
      }).ok,
    ).toBe(true)
  })

  it.each(['attack', 'overrun', 'barrage'] as const)(
    '统一合法性入口拦截 %s，空军轰炸保持独立',
    (action) => {
      const result = checkLegality(request({ action, barrageSource: 'artillery' }))
      if (result.ok) throw new Error('空运禁攻单位不能通过地面攻击的统一合法性检查')
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          family: 'mode',
          rule: '14.9d',
          reason: 'airTransportForbidsAttack',
        }),
      )
      expect(checkMode(request({ action: 'barrage', barrageSource: 'air' }))).toEqual([])
    },
  )

  it('实际未走地面MP也不能在空运落地后翻面洗掉预算', () => {
    const unit = movingUnit({ airTransportThisPhase: flight() })
    expect(
      canSwitchModeNow({
        context: context(unit),
        unitId: unit.id,
        runtime: [{ unitId: 'u', hex: origin, spentMp: 0, ended: false }],
        to: 'combat',
        orientation: 'combat',
        unitClass: 'combat',
      }),
    ).toMatchObject({ ok: false, rule: '5.4 / 14.9d' })
    expect(
      checkMode(request({ phase: 'movement', action: 'modeChange', modeTarget: 'combat' })),
    ).toMatchObject([{ rule: '5.4 / 14.9d' }])
  })

  it('5.4 / 14.9d：DG的主移动翻朝向例外保留，空运仍限制模式修正后的额度', () => {
    const state = { mode: 'move' as const, orientation: 'move' as const, dg: true, exploit: false }
    expect(canFlipOrientation({ state, phase: 'movement' })).toMatchObject({ ok: true })
    const unit = movingUnit({ ...state, ma: 8, airTransportThisPhase: flight() })
    expect(availableMa(unit, 'movement')).toBe(2)
    expect(availableMa({ ...unit, orientation: 'combat', ma: 4 }, 'movement')).toBe(1)
    expect(canFlipOrientation({ state, phase: 'reaction' })).toMatchObject({
      ok: false,
      rule: '5.4',
      reason: '改变朝向只能在本方移动阶段进行',
    })
  })
})
