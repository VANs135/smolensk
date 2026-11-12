import { describe, expect, it } from 'vitest'
import { ruleErrorTextOf } from '@/engine/rules/rule-error-text'

describe('ruleErrorTextOf（炮击 / 战斗 / 空军共用一张表）', () => {
  it('操作台自己写的中文原因原样返回', () => {
    expect(ruleErrorTextOf({ rule: '10.0e', reason: '先完成当前炮击步骤' })).toBe(
      '先完成当前炮击步骤',
    )
  })

  it('炮击代码译成中文，且不把内部代码露出来', () => {
    const text = ruleErrorTextOf({ rule: '10.1a', reason: 'unitAlreadyBarraged' })
    expect(text).toContain('本阶段已经炮击过')
    expect(text).not.toContain('unitAlreadyBarraged')
  })

  it('战斗代码复用同一张表', () => {
    expect(ruleErrorTextOf({ rule: '9.1e', reason: 'stratCannotAttack' })).toContain('不能进攻')
    expect(ruleErrorTextOf({ rule: '9.11c', reason: 'arUnitMustTakeFirstLoss' })).toContain('9.11c')
  })

  it('空军代码复用同一张表', () => {
    expect(ruleErrorTextOf({ rule: '14.9a', reason: 'cargoUnassigned' })).toContain('货物没有分配')
    expect(ruleErrorTextOf({ rule: '14.1f', reason: 'weatherProhibitsFlying' })).toContain(
      '天气禁止飞行',
    )
  })

  it('未知代码只给「中文兜底＋规则号」，不带内部代码与参数', () => {
    expect(ruleErrorTextOf({ rule: '14.2f', reason: 'someInternalCode' })).toBe(
      '本次操作被规则拒绝（14.2f）',
    )
    expect(ruleErrorTextOf({ rule: '9.9', reason: 'someInternalCode:unit-42' })).toBe(
      '本次操作被规则拒绝（9.9）',
    )
  })

  it('wrongPhaseFor / notAt 前缀统一兜底', () => {
    expect(ruleErrorTextOf({ rule: '14.1g', reason: 'wrongPhaseForAirMission' })).toBe(
      '当前阶段不允许这项操作',
    )
    expect(ruleErrorTextOf({ rule: '10.0e', reason: 'notAtXyzStep' })).toBe('当前不在这一步')
  })
})
