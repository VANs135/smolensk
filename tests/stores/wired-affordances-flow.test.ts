import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useWorkbenchStore } from '@/stores'

/**
 * M10④ 伴生清理：两个「已实现却没人调用」的界面动作，接线后钉住行为
 *
 * 修前状态（符号级扫描的结论）：
 *   · `clearCombatSupplyDump(side)`——只有定义与导出，**全树无调用** ⇒ 玩家在地图上声明了
 *     12.4 的付款来源后**没有任何办法撤销**；
 *   · `clearRetreatDestinationNow(unitId)`——同样零调用 ⇒ 9.12 撤退步里落点填错只能手工改文本。
 * 本组用 store 级断言把这两条**可达性**钉住（组件侧由 5.5 的架构扫描与类型检查兜底）。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('M10④：12.4 战斗补给来源的声明与清除', () => {
  it('清除来源 ⇒ 既撤掉补给站，也把可用 T 归零（不留下"来源已撤、T 还在"的假象）', () => {
    const store = newStore()
    const dump = { id: 'src', hex: { col: 36, row: 13 }, side: 'axis' as const, sp: 4, t: 0 }
    store.spDumps.push(dump)
    // 12.4：声明该站为攻方来源（此处只验 store 的记账，不跑完整战斗流程）
    store.combatSupplyDumpIds = { ...store.combatSupplyDumpIds, attacker: 'src' }
    store.combatInputs = { ...store.combatInputs, attackerAvailableT: 16 }

    store.clearCombatSupplyDump('attacker')
    expect(store.combatSupplyDumpIds.attacker).toBeNull()
    expect(store.combatInputs.attackerAvailableT).toBe(0)
    // 守方不受影响（按方独立）
    expect(store.combatSupplyDumpIds.defender).toBeNull()
  })
})

describe('M10④：9.12 撤退落点的清除（重选）', () => {
  it('清除某单位的落点 ⇒ 只删它自己，别人的落点保留', () => {
    const store = newStore()
    store.combatInputs = {
      ...store.combatInputs,
      retreatPaths: {
        u1: '36.12,36.11',
        u2: '35.14',
      },
    }
    store.clearRetreatDestinationNow('u1')
    expect(store.combatInputs.retreatPaths['u1']).toBeUndefined()
    expect(store.combatInputs.retreatPaths['u2']).toBe('35.14')
  })
})
