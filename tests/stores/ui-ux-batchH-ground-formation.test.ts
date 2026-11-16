import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useHotseatStore, useSetupStore } from '@/stores'

/**
 * 批 H（用户 2026-11-16）：**初设地面单位补番号**
 *
 * 地面单位卡右边原来是空的；补**单位番号**（编队 / 师属标识，取单位库 `formation`），
 * 不写任何描述文字。飞机 / SP / 运输点没有这一项 ⇒ 不显示。
 */

function stores() {
  setActivePinia(createPinia())
  useHotseatStore().setMode('solo')
  const setup = useSetupStore()
  setup.selectScenario('1')
  return setup
}

describe('批 H：地面单位番号投影', () => {
  it('★ 地面卡有番号（剧本页印号优先，缺则退单位库编队标识）', () => {
    const setup = stores()
    const ground = setup.decisionQueue.find((stack) => stack.key === 'ground')
    expect(ground, '剧本 1 应有地面单位堆').toBeDefined()
    const withFormation = ground!.items.filter(
      (item) => item.kind === 'self' && (item.formation ?? null) !== null,
    )
    expect(withFormation.length).toBeGreaterThan(0)
    for (const item of withFormation) {
      // 番号是一个**标识**（短），不是句描述
      expect(typeof item.formation).toBe('string')
      expect((item.formation ?? '').length).toBeGreaterThan(0)
      expect((item.formation ?? '').length).toBeLessThanOrEqual(12)
    }
  })

  it('★ 飞机条目没有番号这一项（不拿别的字段顶替）', () => {
    const setup = stores()
    const air = setup.decisionQueue.find((stack) => stack.key === 'air')
    expect(air).toBeDefined()
    for (const item of air!.items) expect(item.formation ?? null).toBeNull()
  })

  it('★ 源码守卫：卡右侧只补番号，不加描述文字', () => {
    const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')
    expect(queue).toContain('v-if="item.formation"')
    expect(queue).toContain('queue__formation')
    expect(queue).not.toContain('item.description')
    const setup = readFileSync('src/stores/setup.ts', 'utf8')
    expect(setup).toContain('function formationOfEntry')
    expect(setup).toContain('return hit?.formation ?? null')
  })
})
