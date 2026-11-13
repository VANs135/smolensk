import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useWorkbenchStore } from '@/stores'

/**
 * B6：12.4 战斗补给来源只保留地图入口
 *
 * 旧动作 `clearCombatSupplyDump` 已并入「再点同一座补给站」的取消路径；
 * store 不再暴露第二个清除入口，组件侧由 `combat-supply-multi-source.test.ts` 的源码守卫钉住。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B6：12.4 战斗补给来源只有一个入口', () => {
  it('store 不再暴露 clearCombatSupplyDump', () => {
    const store = newStore()
    expect('clearCombatSupplyDump' in store).toBe(false)
  })
})
