import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useGameSessionStore, useSetupStore } from '@/stores'

/**
 * 批 E 切片 1（用户口径 9.17③b）：**开局入口收敛为唯一一处（初设收束点）**
 *
 * 用户原话：「**两个开局按钮 + 一个开始游戏，应统一**」。修前的三个入口：
 *   ① `FlowStrip` 流程条的「开局」（`gameSession.startGame()`）；
 *   ② `SetupPanel` 初设面板的「开始游戏」（`setup.startGameNow()`）；
 *   ③ `DecisionQueue` 决策队列的「完成初设」（`setup.startGameNow()`）。
 * 点哪个都能开局，行为却各不一致（①不写共识结论、②③写）。
 *
 * **口径（本切片）**：建会话只允许从**初设收束点**发生 —— 地图左上角「待你决定」队列落满后的
 * 「完成初设」（`DecisionQueue` → `setup.startGameNow()`）。
 *   · `FlowStrip` 未开局时**不再建会话**，改为**视图引导**（去初设队列 / 去选剧本与共识）；
 *   · `SetupPanel` 那颗按钮**删除**，只留只读回执 + 一行指向收束点的说明。
 *
 * ## 测法边界（如实交代）
 *   · 本仓库不挂组件渲染测试 ⇒ "按钮点了会导航"由**源码守卫**（`ui.navigate(...)` 出现、
 *     `startGame()` 不再出现）与文案断言承担，真实点击路径靠人眼；
 *   · **一个如实登记的例外**：`TerminationNotice` 的「重开一局」仍直接 `gameSession.startGame()`
 *     —— 那是 5.0a/5.0b **终止之后的恢复路径**（此时会话已存在且已终止，换剧本会被 2.2 拒、
 *     初设也已收束），不属于"初设期的第二个开局入口"。它由 `gameSession.terminated` 把关（见守卫 ③）。
 */

const read = (file: string): string => readFileSync(file, 'utf8')

/** 某文件里 `pattern` 的出现次数 */
const count = (file: string, pattern: RegExp): number => (read(file).match(pattern) ?? []).length

describe('批 E 切片 1：开局入口收敛（唯一入口＝初设收束点）', () => {
  it('① 唯一入口：`startGameNow()` 的 UI 调用点**只有**决策队列的「完成初设」', () => {
    // stores/setup.ts 里是定义（1 处 function + 返回表导出），UI 侧只许 DecisionQueue 调
    expect(count('src/components/game/DecisionQueue.vue', /startGameNow\(\)/g)).toBe(1)
    expect(count('src/components/setup/SetupPanel.vue', /startGameNow\(\)/g)).toBe(0)
    expect(count('src/components/session/FlowStrip.vue', /startGameNow\(\)/g)).toBe(0)

    // 全仓扫一遍（.vue 侧）：除了决策队列，没有别的组件在调它
    const callers = [
      'src/components/game/DecisionQueue.vue',
      'src/components/setup/SetupPanel.vue',
      'src/components/session/FlowStrip.vue',
      'src/components/session/TerminationNotice.vue',
      'src/views/ScenarioSetupView.vue',
      'src/views/GameTableView.vue',
    ].filter((file) => count(file, /startGameNow\(\)/g) > 0)
    expect(callers).toEqual(['src/components/game/DecisionQueue.vue'])
  })

  it('② 流程条未开局时**只做视图引导**（不再直接建会话）', () => {
    const flow = read('src/components/session/FlowStrip.vue')
    expect(flow).not.toContain('gameSession.startGame()')
    expect(flow).toContain("ui.navigate(setup.applied && !setup.finished ? 'game' : 'scenario')")
    // 按钮文案说清"该去哪儿收束初设"，而不是"点我就开局"
    expect(flow).toContain('去初设队列（完成初设即开局）')
    expect(flow).toContain('去选剧本 / 共识')
    expect(flow).toContain('useUiStore')
  })

  it('③ 初设面板只读回执：没有第二个「开始游戏」，且指向收束点', () => {
    const panel = read('src/components/setup/SetupPanel.vue')
    expect(panel).not.toContain('setup.startGameNow()')
    expect(panel).toContain('地图左上角「待你决定」队列落满后按「完成初设」')
    // 终止后的恢复路径保留（如实登记：它不是初设期的第二个入口）
    const notice = read('src/components/session/TerminationNotice.vue')
    expect(notice).toContain('gameSession.startGame()')
    expect(notice).toContain('gameSession.terminated')
  })

  it('④ 正向：收束点真的能开局（`startGameNow` ⇒ 建会话 + 初设收束）', () => {
    setActivePinia(createPinia())
    const setup = useSetupStore()
    const session = useGameSessionStore()
    expect(session.session).toBeNull()

    expect(setup.startGameNow()).toBe(true)
    expect(session.session).not.toBeNull()
    expect(setup.finished).toBe(true)
    // 收束点不是"只建会话"：共识结论也一并写进日志（专规 4.0）
    expect(session.log.length).toBeGreaterThan(0)
  })
})
