import { describe, expect, it } from 'vitest'
import { ZOC_ACTION_POLICIES, zocAffectsAction, type ZocAction } from '@/engine/rules/zoc-effects'
import {
  evaluateStep,
  inEnemyZocAt,
  inEnemyZocForAction,
  canSwitchModeNow,
  type MoveContext,
  type MoveUnitView,
} from '@/engine/rules'
import { neighbor } from '@/engine/hex-geometry'

function view(id: string, extra: Partial<MoveUnitView> = {}): MoveUnitView {
  return {
    id,
    side: 'axis',
    isCombat: true,
    attackCapable: true,
    hasTraceSupply: true,
    hex: { col: 20, row: 20 },
    mobility: 'leg',
    ma: 6,
    re: 1,
    mode: 'combat',
    orientation: 'combat',
    dg: false,
    exploit: false,
    releasedFromReserve: false,
    fuelled: true,
    mpLockedThisPhase: false,
    ...extra,
  }
}
function fixture() {
  const hex = { col: 20, row: 20 },
    next = neighbor(hex, 'N')
  const mover = view('moving', { hex: next, mode: 'strat', orientation: 'move' })
  const pad = view('pad', { hex, mpLockedThisPhase: true })
  const enemy = view('enemy', { side: 'soviet', hex: neighbor(hex, 'S') })
  const context: MoveContext = {
    phase: 'movement',
    activeSide: 'axis',
    map: { onMap: () => true, terrainsAt: () => ['Open'], crossingBetween: () => null },
    units: [mover, pad, enemy],
  }
  return { hex, next, mover, pad, enemy, context }
}
describe('4.5a：不同操作的ZOC语义', () => {
  for (const action of Object.keys(ZOC_ACTION_POLICIES) as ZocAction[]) {
    it(`${action}：抵消是否有效由动作本身决定`, () => {
      expect(zocAffectsAction(action, false, false)).toBe(false)
      expect(zocAffectsAction(action, false, true)).toBe(false)
      expect(zocAffectsAction(action, true, false)).toBe(true)
      expect(zocAffectsAction(action, true, true)).toBe(!ZOC_ACTION_POLICIES[action].negatable)
    })
  }
  it('5.8a：友军垫人能放行普通轮式，却不能放行战略模式进入', () => {
    const { context, hex, next } = fixture()
    expect(inEnemyZocAt(context, hex, 'axis')).toBe(false)
    expect(inEnemyZocForAction(context, hex, 'axis', 'stratMovement')).toBe(true)
    expect(evaluateStep(context, 'moving', hex)).toMatchObject({
      ok: false,
      reason: 'stratIntoEzoc',
    })
    expect(context.units[0]!.hex).toEqual(next)
  })
  it('5.7c/5.8a：抵消后的原格仍不能转入预备或战略模式', () => {
    const { context, hex, mover } = fixture()
    const units = context.units.map((unit) =>
      unit.id === 'moving' ? { ...mover, hex, mode: 'move' as const } : unit,
    )
    for (const to of ['reserve', 'strat'] as const) {
      expect(
        canSwitchModeNow({
          context: { ...context, units },
          unitId: 'moving',
          runtime: [{ unitId: 'moving', hex, spentMp: 0, ended: false }],
          to,
          orientation: 'move',
          unitClass: 'combat',
        }).ok,
      ).toBe(false)
    }
  })
})
