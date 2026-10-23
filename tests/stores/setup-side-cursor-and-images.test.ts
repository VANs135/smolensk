import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 第六批批 S 切片 1（条 1）：**初设队列的算子图阵列 + 分方游标**
 *
 * 用户口径（第六批条 1）：初设队列要"**算子图阵列**"（不再是逐行文字），且要
 *   「**先设/后设游标**＋逐方『确认』＋队列按方过滤」。
 *
 * 修前的病灶（`docs/第六批修改方案.md` 条 1）：
 *   ① 初设卡是**文字** ⇒ 同名同图的一长串条目在列表里认不出谁是谁；
 *   ② 队列含**双方**，既没有先设/后设游标、也没有分方"确认" ⇒ 谁先摆、摆完没摆完全靠记；
 *   ③ `setupFirst`（先**布设**方）数据已在 `scenarios.json` 却只当说明用。
 *
 * ★ 一处**必须分清**的口径：`setupFirst`＝先**布设**方，`firstPlayer`＝先**行动**方，
 *   两者是两回事（剧本 1 正是两者不同的那一局）⇒ 游标取 `setupFirst`，绝不用 `firstPlayer` 顶替。
 *
 * ## 测法边界（如实交代）
 *   · 用真实剧本与真实单位库（图档取自数据里的 `images.front`，不臆造文件名）；
 *   · **不覆盖** 编队抽取后的西移落点接进同一队列（`pendingShiftWestPlacements`）——
 *     那要动 `containers` 的抽取落盘台账，属下一切片；本文件只钉图阵列与分方游标。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { setup: useSetupStore(), workbench: useWorkbenchStore() }
}

/** 剧本 1 的先布设方 / 先行动方（照 `scenarios.json` 直读，避免两处口径漂移） */
const SCENARIO_1 = JSON.parse(readFileSync('src/data/scenarios.json', 'utf8')) as {
  scenarios: { id: string; firstPlayer: string; setupFirst: string }[]
}

describe('第六批 S1：初设的算子图阵列与分方游标（条 1）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('★ 先**布设**方取自 `setupFirst`，**不是** `firstPlayer`（剧本 1 两者不同）', () => {
    const scenario = SCENARIO_1.scenarios.find((item) => item.id === '1')
    expect(scenario).toBeDefined()
    // 数据自检：这一局两者确实不同（否则本用例就测不出"用错字段"这个病灶）
    expect(scenario!.setupFirst).not.toBe(scenario!.firstPlayer)

    const { setup } = stores
    setup.selectScenario('1')
    expect(setup.setupFirstSide).toBe(scenario!.setupFirst)
    // 游标随剧本起在**先布设方**上
    expect(setup.setupSideCursor).toBe(scenario!.setupFirst)
  })

  it('★ 队列按当前方过滤；确认后换手，两方都确认 ⇒ 恢复全量', () => {
    const { setup } = stores
    setup.selectScenario('1')
    const first = setup.setupFirstSide!
    const second = first === 'axis' ? 'soviet' : 'axis'

    const sidesIn = (queue: readonly { items: readonly { side: string }[] }[]): Set<string> => {
      const found = new Set<string>()
      for (const stack of queue) for (const item of stack.items) found.add(item.side)
      return found
    }
    // ① 全量队列含双方（既有契约不变）
    expect(sidesIn(setup.decisionQueue).size).toBeGreaterThan(0)
    // ② 分方视图只含当前方
    const before = sidesIn(setup.sideQueue)
    expect([...before].every((side) => side === first)).toBe(true)
    expect(before.size).toBe(1)

    // ③ 确认 ⇒ 换手
    expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.setupSideCursor).toBe(second)
    const after = sidesIn(setup.sideQueue)
    expect([...after].every((side) => side === second)).toBe(true)

    // ④ 两方都确认 ⇒ 游标归位，分方视图＝全量
    expect(setup.confirmSideSetup()).toBe(true)
    expect(setup.setupSideCursor).toBeNull()
    expect(setup.sideQueue).toEqual(setup.decisionQueue)
  })

  it('★ 游标未起（或已归位）⇒ `sideQueue` 就是全量（既有夹具/验证页不受影响）', () => {
    const { setup } = stores
    setup.selectScenario('1')
    setup.armSetupSideCursor() // 起游标
    expect(setup.setupSideCursor).not.toBeNull()
    setup.setupSideCursor = null // 模拟"两方都已确认"
    expect(setup.sideQueue).toEqual(setup.decisionQueue)
  })

  it('★ 算子图阵列：队列里的项带**数据里的**算子图档（查不到即 null，不臆造）', () => {
    const { setup } = stores
    setup.selectScenario('1')
    const items = setup.decisionQueue.flatMap((stack) => stack.items)
    expect(items.length).toBeGreaterThan(0)
    // 每一项都有 `imageUrl` 字段（null 也是合法值 ⇒ 界面退回文字卡）
    for (const item of items) {
      expect(item).toHaveProperty('imageUrl')
      if (item.imageUrl !== null) {
        // 图档一律来自数据（public/counters 下的文件名），不是拼出来的路径
        expect(item.imageUrl).toMatch(/\.(png|jpg|webp)$/i)
      }
    }
    // 反空转：至少有一类项真的取到了图（否则"图阵列"是空的，等于没做）
    expect(items.some((item) => item.imageUrl !== null)).toBe(true)
  })

  it('源码守卫：游标取 `setupFirst`；队列读分方视图；卡片画算子图', () => {
    const store = readFileSync('src/stores/setup.ts', 'utf8')
    const at = store.indexOf('const setupFirstSide = computed')
    const cursor = store.slice(at, at + 600)
    expect(cursor).toContain('setupFirst')
    expect(cursor).not.toContain('firstPlayer')

    const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')
    expect(queue).toContain('setup.sideQueue')
    expect(queue).toContain('item.imageUrl')
    expect(queue).toContain('setup.confirmSideSetup()')
    // 卡片上的**勾选框**（条 2 已去掉）与旧的纯文字卡都在退场
    expect(queue).not.toContain('setup.toggleTruckFull(')
  })
})
