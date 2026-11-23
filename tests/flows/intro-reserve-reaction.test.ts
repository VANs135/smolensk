import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { actionGateOf } from '@/stores'

import { fresh } from './flow-harness'

/**
 * 通规 5.7b / 7.0a：**反应阶段的非阶段玩家释放预备去打**
 *
 * 教学剧本 Intro 的真实数据是 `reserveMarkers: { axis: 5, soviet: 0 }`
 * （原文只在 `Axis Set-Up Information` 里写 `Reserve Markers Available: 5`，苏方栏无此行），
 * 所以苏军 16 枚算子全部是基础（战斗）模式 —— 本剧本里**没有可释放的预备**。
 *
 * 本用例钉两件事：
 * 1) 现状：苏军坦克师是 combat 模式，反应段点「释放预备」会被 5.7b 以「不处于预备模式」拒绝；
 * 2) 链路：一旦苏方有预备标记（这里把坦克师挂成 reserve 模拟），反应段可释放（MA ×0.5）、
 *    未加油开拔被 12.5a 拒、从己方补给站付 1T 后可开拔，且突袭候选出现
 *    （7.0a 反应段只给移动 / 突袭 / 轰炸，`combat.declare` 不在本段）。
 */

function openIntro() {
  const ctx = fresh()
  ctx.w.seed = 20261115
  expect(ctx.setup.enterSetup('Intro')).toBe(true)
  expect(ctx.setup.presetSelfSetupNow().failures).toEqual([])
  expect(ctx.setup.startGameNow()).toBe(true)
  if (ctx.setup.setupDrawEntryVisible) expect(ctx.setup.drawSetupEffectsNow()).toBe(true)
  expect(ctx.setup.startGameNow()).toBe(true)
  return ctx
}

describe('Intro：反应阶段的苏军坦克师', () => {
  it('本剧本苏方 reserve 0：坦克师是战斗模式，释放预备被 5.7b 拒绝', async () => {
    const ctx = openIntro()
    const w = ctx.w
    const tank = w.units.find((unit) => unit.name === 'Ru 14 Tk Div')!
    expect(tank.mode.mode).toBe('combat')
    w.setPhase('reaction')
    w.setSegmentStepIndex(w.playerSegmentSteps.findIndex((step) => step.id === 'reaction.movement'))
    await nextTick()
    w.selectedId = tank.instanceId
    expect(w.releaseReserveNow()).toBe(false)
    expect(w.log[0]?.text).toContain('不处于预备模式')
  })

  it('挂了预备标记后：释放（MA ×0.5）→ 加油 → 开拔 → 可突袭；但反应段不开放战斗', async () => {
    const ctx = openIntro()
    const w = ctx.w
    const tank = w.units.find((unit) => unit.name === 'Ru 14 Tk Div')!
    // 模拟「苏方有 reserve 标记」：本剧本数据里苏方 0 枚，原文未给
    tank.mode = { ...tank.mode, mode: 'reserve', orientation: 'combat', releasedFromReserve: false }
    w.setPhase('reaction')
    w.setSegmentStepIndex(w.playerSegmentSteps.findIndex((step) => step.id === 'reaction.movement'))
    await nextTick()
    w.selectedId = tank.instanceId

    // 5.7b：非阶段玩家在反应段释放自己的预备
    expect(w.releaseReserveNow()).toBe(true)
    expect(
      w.log.some(
        (entry) => entry.text.includes('已释放预备（5.7b）') && entry.text.includes('×0.5'),
      ),
    ).toBe(true)

    // 12.5a：履带战斗单位未加油不能消耗 MP
    expect(w.beginMoveFor([tank.instanceId])).toBe(false)

    // 12.5c-C：从己方补给站按单独单位法付 1T
    const dump = w.fuelDumpChoices.find((item) => item.side === 'soviet')
    expect(dump, '苏方没有可付款的补给站').toBeDefined()
    expect(w.pickFuelDump(dump!.id)).toBe(true)
    w.payFuel('singleUnit')
    expect(w.units.find((unit) => unit.instanceId === tank.instanceId)?.fuelled).toBe(true)

    expect(w.beginMoveFor([tank.instanceId])).toBe(true)
    expect(w.activeMoveUnits.map((unit) => unit.instanceId)).toContain(tank.instanceId)
    // 8.0：反应段可突袭（轴方单位相邻即进入候选）
    expect(w.overrunCandidateUnits.map((unit) => unit.instanceId)).toContain(tank.instanceId)

    // 7.0a：反应段只给移动 / 突袭 / 轰炸，战斗宣布不在本段
    expect(actionGateOf('combat.declare').where.every((where) => where.phase !== 'reaction')).toBe(
      true,
    )
  })
})
