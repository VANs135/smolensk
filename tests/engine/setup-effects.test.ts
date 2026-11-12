import { describe, expect, it, vi } from 'vitest'

import { formations } from '@/data'
import {
  runSetupEffects,
  SETUP_EFFECT_HANDLERS,
  SETUP_EFFECT_KINDS,
  setupEffectOf,
  setupEffectsOf,
  validateSetupEffects,
  type SetupEffectContext,
  type SetupEffectView,
} from '@/engine/rules/setup-effects'

/**
 * E2：`setup.effects[]` 的注册表与调用方契约
 *
 * 钉四件事：
 *   ① 注册表**只登记剧本数据里真实声明过的类型**（当前只有 `formationDraw`；不为假想类型建空实现）；
 *   ② 每条效果的时机由数据声明（`afterSetupConfirm` / `perGame`），池规模与冻结名单对账；
 *   ③ 剧本 2/4/6 经 `sharedSetupWith` 取源，不另立一份映射；
 *   ④ 执行器先整体校验再派发：校验失败一条都不执行；执行中失败即中止。
 */

const realEffect = (scenarioId = '1'): SetupEffectView => {
  const effect = setupEffectOf(scenarioId, 'formationDraw')
  if (effect === null) throw new Error(`剧本 ${scenarioId} 应声明 formationDraw`)
  return effect
}

/** 造一条同形效果（只改 id；用于测执行顺序/失败中止） */
const cloneWithId = (id: string): SetupEffectView =>
  ({ ...realEffect('1'), id }) as unknown as SetupEffectView

const contextWith = (formationDraw: SetupEffectContext['formationDraw']): SetupEffectContext => ({
  formationDraw,
})

describe('E2：初设效果注册表（只建数据里声明过的类型）', () => {
  it('注册表的键与声明的类型集合一致，且只有 formationDraw', () => {
    expect([...SETUP_EFFECT_KINDS]).toEqual(['formationDraw'])
    expect(Object.keys(SETUP_EFFECT_HANDLERS)).toEqual([...SETUP_EFFECT_KINDS])
  })

  it('数据声明的效果：时机＝初设确认后、每局一次；池规模＝名单长度', () => {
    const declared = ['1', '3', '5'].map((id) => setupEffectsOf(id))
    for (const effects of declared) {
      expect(effects.length).toBeGreaterThan(0)
      for (const effect of effects) {
        expect(effect.kind).toBe('formationDraw')
        expect(effect.timing).toBe('afterSetupConfirm')
        expect(effect.once).toBe('perGame')
        if (effect.kind === 'formationDraw') {
          expect(effect.pool, effect.id).toBe(effect.poolFormations.length)
          expect(effect.groups.length).toBeGreaterThan(0)
        }
      }
    }
    // 剧本 7 无初设强制效果
    expect(setupEffectsOf('7')).toEqual([])
  })

  it('剧本 2/4/6 经 sharedSetupWith 取到与 1/3/5 同一份声明', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ]
    for (const [sourceId, inheritorId] of pairs) {
      expect(setupEffectsOf(inheritorId), inheritorId).toEqual(setupEffectsOf(sourceId))
    }
  })
})

describe('E2：runSetupEffects 的执行契约', () => {
  it('无效果 ⇒ 不调用任何处理器', () => {
    const formationDraw = vi.fn()
    const result = runSetupEffects([], contextWith(formationDraw))
    expect(result).toEqual({ ok: true, executed: [], issues: [] })
    expect(formationDraw).not.toHaveBeenCalled()
  })

  it('声明不自洽（pool≠名单）⇒ 整体不执行', () => {
    const broken = { ...realEffect('1'), pool: 999 } as unknown as SetupEffectView
    const formationDraw = vi.fn()
    const result = runSetupEffects([broken], contextWith(formationDraw))
    expect(result.ok).toBe(false)
    expect(result.executed).toEqual([])
    expect(result.issues.length).toBeGreaterThan(0)
    expect(formationDraw).not.toHaveBeenCalled()
  })

  it('名单含 formations.json 未登记的编队 ⇒ 校验报缺口', () => {
    const broken = {
      ...realEffect('1'),
      poolFormations: [...realEffect('1').poolFormations.slice(1), '99 Pz Div'],
    } as unknown as SetupEffectView
    const issues = validateSetupEffects([broken], {
      knownFormationIds: new Set(formations.formations.map((item) => item.formationId)),
    })
    expect(issues.map((issue) => issue.reason).join('｜')).toContain('99 Pz Div')
  })

  it('按数组顺序执行，回执原样透传', () => {
    const formationDraw = vi.fn(() => ({ ok: true, detail: '抽签完成' }))
    const result = runSetupEffects([cloneWithId('a'), cloneWithId('b')], contextWith(formationDraw))
    expect(result.ok).toBe(true)
    expect(formationDraw).toHaveBeenCalledTimes(2)
    expect(result.executed.map((item) => item.effectId)).toEqual(['a', 'b'])
    expect(result.executed.every((item) => item.detail === '抽签完成')).toBe(true)
  })

  it('执行中失败即中止（后面的效果不再执行），issues 带回原因', () => {
    const formationDraw = vi
      .fn()
      .mockReturnValueOnce({ ok: true, detail: '第一条' })
      .mockReturnValueOnce({ ok: false, detail: '落盘被拒', reason: 'roadMissing' })
    const result = runSetupEffects(
      [cloneWithId('a'), cloneWithId('b'), cloneWithId('c')],
      contextWith(formationDraw),
    )
    expect(result.ok).toBe(false)
    expect(formationDraw).toHaveBeenCalledTimes(2)
    expect(result.executed.map((item) => item.effectId)).toEqual(['a', 'b'])
    expect(result.issues).toEqual([
      { effectId: 'b', rule: realEffect('1').rule, reason: 'roadMissing' },
    ])
  })
})
