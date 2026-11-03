import { describe, expect, it } from 'vitest'
import {
  canAttackAfterAirTransport,
  limitAirTransportMa,
  planAirUnitTransport,
  type AirUnitTransportState,
} from '@/engine/rules/air-unit-movement'
import type { ModeState, MovementSegmentPhase } from '@/engine/rules/modes'

const move: ModeState = { mode: 'move', orientation: 'move', dg: false, exploit: false }
const released: ModeState = { ...move, mode: 'reserve', releasedFromReserve: true }
const plan = (overrides: Partial<Parameters<typeof planAirUnitTransport>[0]> = {}) =>
  planAirUnitTransport({
    kind: 'air_transport',
    phase: 'movement',
    mode: move,
    ma: 6,
    spentMp: 0,
    ...overrides,
  })

describe('14.9d / 4.7d：单位空运后的阶段移动和攻击义务', () => {
  it.each<{
    phase: MovementSegmentPhase
    mode: ModeState
    limit: number
    attack: boolean
  }>([
    { phase: 'movement', mode: move, limit: 3, attack: true },
    { phase: 'reaction', mode: released, limit: 1.5, attack: true },
    { phase: 'exploitation', mode: released, limit: 3, attack: true },
    { phase: 'reaction', mode: move, limit: 0, attack: false },
    { phase: 'exploitation', mode: move, limit: 0, attack: false },
  ])('$phase阶段限额$limit，能否攻击$attack', ({ phase, mode, limit, attack }) => {
    const outcome = plan({ phase, mode })
    expect(outcome).toMatchObject({ ok: true, data: { maLimit: limit, remainingMp: limit } })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(canAttackAfterAirTransport(outcome.data.transport)).toBe(attack)
  })

  it('14.9d：运输前后共用半MA，恰好耗尽可运输，超过限额则装载前拒绝', () => {
    expect(plan({ spentMp: 2 })).toMatchObject({
      ok: true,
      data: { maLimit: 3, remainingMp: 1 },
    })
    expect(plan({ spentMp: 3 })).toMatchObject({
      ok: true,
      data: { maLimit: 3, remainingMp: 0 },
    })
    expect(plan({ spentMp: 3.1 })).toMatchObject({
      ok: false,
      rule: '14.9d',
      reason: 'airTransportGroundMovementExceeded',
    })
    expect(plan({ phase: 'reaction', mode: released, spentMp: 1.5 }).ok).toBe(true)
    expect(plan({ phase: 'reaction', mode: released, spentMp: 2 }).ok).toBe(false)
  })

  it.each<ModeState>([
    { ...move, dg: true },
    { ...move, exploit: true },
    { ...move, mode: 'reserve' },
    { ...move, mode: 'strat' },
    { ...move, mode: 'combat', orientation: 'combat' },
    { ...released, orientation: 'combat' },
  ])('5.6a / 14.9c：模式不允许空运时拒绝：%o', (mode) => {
    expect(plan({ mode })).toMatchObject({
      ok: false,
      reason: 'cargoUnitCannotUseAirTransport',
    })
  })

  it('6.1h / 14.9d：分数额度不取整，没有运输记录的正常额度原样返回', () => {
    expect(plan({ ma: 5, phase: 'reaction', mode: released, spentMp: 0.25 })).toMatchObject({
      ok: true,
      data: { maLimit: 1.25, remainingMp: 1 },
    })
    expect(limitAirTransportMa(2.5)).toBe(2.5)
    expect(limitAirTransportMa(2.5, null)).toBe(2.5)
    expect(canAttackAfterAirTransport()).toBe(true)
    expect(canAttackAfterAirTransport(null)).toBe(true)
    expect(plan({ ma: 0, spentMp: 0 })).toMatchObject({
      ok: true,
      data: { maLimit: 0, remainingMp: 0 },
    })
  })

  it.each([
    { ma: NaN },
    { ma: Infinity },
    { ma: -1 },
    { spentMp: NaN },
    { spentMp: Infinity },
    { spentMp: -0.5 },
  ])('14.9d：非法移动事实不能生成运输计划：%o', (overrides) => {
    expect(plan(overrides)).toMatchObject({
      ok: false,
      reason: 'invalidAirTransportMovement',
    })
  })

  it('14.9d：同阶段重复空运不会重复折半，真实地面消耗继续累计', () => {
    const first = plan({ spentMp: 1 })
    if (!first.ok) throw new Error(first.reason)
    const second = plan({ spentMp: 2, previous: first.data.transport })
    expect(second).toMatchObject({
      ok: true,
      data: { maLimit: 3, remainingMp: 1, transport: first.data.transport },
    })
    const reaction = plan({ phase: 'reaction', mode: released })
    if (!reaction.ok) throw new Error(reaction.reason)
    expect(
      plan({ phase: 'reaction', mode: released, spentMp: 1, previous: reaction.data.transport }),
    ).toMatchObject({ ok: true, data: { maLimit: 1.5, remainingMp: 0.5 } })
  })

  it('14.9d：陈旧阶段记录拒绝，同阶段后补释放事实不能放宽已经提交的限制', () => {
    const previous: AirUnitTransportState = {
      kind: 'air_transport',
      phase: 'exploitation',
      releasedFromReserve: false,
    }
    expect(plan({ previous })).toMatchObject({
      ok: false,
      reason: 'staleAirUnitTransportPhase',
    })
    const outcome = plan({ phase: 'exploitation', mode: released, previous })
    expect(outcome).toMatchObject({
      ok: true,
      data: {
        maLimit: 0,
        remainingMp: 0,
        transport: { releasedFromReserve: false },
      },
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(canAttackAfterAirTransport(outcome.data.transport)).toBe(false)
    expect(plan({ phase: 'exploitation', mode: released, previous, spentMp: 0.5 }).ok).toBe(false)
  })

  it('4.7d / 14.10：空投前后不能花地面MP，同阶段再空运不解除空投限制', () => {
    const drop = plan({ kind: 'air_drop' })
    expect(drop).toMatchObject({ ok: true, data: { maLimit: 0, remainingMp: 0 } })
    if (!drop.ok) throw new Error(drop.reason)
    expect(canAttackAfterAirTransport(drop.data.transport)).toBe(true)
    expect(plan({ kind: 'air_drop', spentMp: 0.25 })).toMatchObject({
      ok: false,
      rule: '4.7d',
      reason: 'airDropUnitAlreadyMoved',
    })
    expect(plan({ previous: drop.data.transport })).toMatchObject({
      ok: true,
      data: { maLimit: 0, transport: { kind: 'air_drop' } },
    })
    expect(plan({ previous: drop.data.transport, spentMp: 1 })).toMatchObject({
      ok: false,
      rule: '4.7d',
    })
  })
})
