import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { confirmSetupForStart } from '../flows/setup-harness'
import {
  useContainersStore,
  useGameSessionStore,
  useHotseatStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 用户 2026-11-14 裁定 1：ch10 抽签**算不出西移落点不算失败**
 *
 * 修前：`runSetupDrawsNow` 把"落点算出来了但摆不出去（如该师不在图上）"的师记进
 * `pendingShift` 并返回 ok；`drawSetupEffectsNow` 紧接着 `startGameNow` → 被西移义务拒绝
 * → 整笔回滚、台账清空。玩家既没有落点入口、又反复被回滚 ⇒ 卡死。
 *
 * 修后：抽签成功即保留盘面与台账，初设栏露出西移项；落齐后由「开始游戏」开局。
 */
describe('ch10 抽签待给落点：不整笔回滚，落齐后再开局', () => {
  it('摆不出去的西移师留在待办里；给完落点后可开局', () => {
    setActivePinia(createPinia())
    useHotseatStore().setMode('solo')
    const setup = useSetupStore()
    const containers = useContainersStore()
    const game = useGameSessionStore()
    const board = useWorkbenchStore()

    expect(setup.selectScenario('1'), setup.lastAction?.detail).toBe(true)
    // 先完成第一段确认（不抽签，把抽签留给本用例）
    confirmSetupForStart(setup, { draws: false })
    expect(setup.setupDrawEntryVisible).toBe(true)

    // 挑真实抽签池成员：A 组要求 4 个不同编队（取 4 个已落图者），把其一暂时移出地图
    // ⇒ 自动落点摆不出去，其余三个照常落盘
    const withUnits = containers.scenarioDrawBox!.pool.filter((item) =>
      board.units.some((unit) => unit.formation === item.formationCode),
    )
    expect(withUnits.length, '抽签池里应有至少 4 个已落图的编队').toBeGreaterThanOrEqual(4)
    const picked = withUnits.slice(0, 4)
    const formationId = picked[0]!.formationId
    const formationCode = picked[0]!.formationCode
    const removed = board.units.filter((unit) => unit.formation === formationCode)
    board.units.splice(
      0,
      board.units.length,
      ...board.units.filter((unit) => unit.formation !== formationCode),
    )
    // 让本剧本的西移组恰好抽中这 4 个师
    containers.drawResults = {
      '1': [
        {
          kind: 'shiftWest',
          formationIds: picked.map((item) => item.formationId),
          detail: '测试：指定抽中这 4 个师',
        },
      ],
    }

    // 修前：false（startGameNow 被西移义务拒绝 ⇒ 整笔回滚）
    expect(setup.drawSetupEffectsNow(), setup.lastAction?.detail).toBe(true)
    expect(game.session).toBeNull()
    expect(setup.setupEffectsExecuted).toBe(true)
    expect(setup.setupDrawEntryVisible).toBe(false)
    expect(setup.setupStartEntryVisible).toBe(false)

    // 初设栏露出西移项（该项还在待办里；候选要等该师回到图上才推得出）
    const item = setup.pendingPlacement.find(
      (placing) => placing.kind === 'shift' && placing.formationId === formationId,
    )
    expect(item, '西移项应出现在初设栏').toBeDefined()

    // 该师回到图上 ⇒ 初设项推出候选范围 ⇒ 给落点 ⇒ 落齐后「开始游戏」
    board.units.push(...removed)
    expect(setup.beginShiftPlacement(formationId)).toBe(true)
    const target = setup.placing!.candidates[0]
    expect(target, '回到图上后应能推出西移候选').toBeDefined()
    expect(setup.placeAtHex(target!), setup.lastAction?.detail).toBe(true)
    expect(setup.pendingPlacement).toHaveLength(0)
    expect(setup.setupStartEntryVisible).toBe(true)
    expect(setup.startGameNow(), setup.lastAction?.detail).toBe(true)
    expect(game.session).not.toBeNull()
  })
})
