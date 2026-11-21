import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/*
 * 2026-11-21：教学模式后三步（苏军反扑 / 弹幕轰城 / 夺城）的完成判据回归
 *
 * 背景：原实现用 `phaseAtLeast(workbench.phase, 'combat' | 'exploitation')` 兜底，
 * 阶段一进战斗段就把「反扑」「弹幕」同时判完、一进挺进段就判完「夺城」——玩家什么都没做
 * 引导也显示完成，而 `cityBarraged()` / `cityTaken()` 的真实检查被 `||` 短路成永不生效。
 *
 * 口径（用户 2026-11-21）：教学每一步都不能跳过。三步一律只认真实事件：
 * 苏军行动由脚本 / AI 完成（反扑必输是脚本保证的），玩家行动按引导自己操作；
 * 既不接受阶段推进代替，也不提供「跳过这一步」入口。
 */
describe('教学模式后三步：只认真实事件，无跳过通道', () => {
  const source = readFileSync('src/stores/tutorial.ts', 'utf8')
  const guide = readFileSync('src/components/tutorial/TutorialGuide.vue', 'utf8')

  it('三步的 done 都不再用阶段兜底', () => {
    expect(source).not.toContain("phaseAtLeast(workbench.phase, 'combat')")
    expect(source).not.toContain("phaseAtLeast(workbench.phase, 'exploitation')")
  })

  it('反扑：只认「反应段真的打过」，且没有 skipped 旁路', () => {
    expect(source).toContain("done: () => reaction.value === 'done' || reactionFought.value,")
    // 2026-11-21：教学不能跳过这一步 ⇒ 'skipped' 通道逐条清掉
    expect(source).not.toContain("reaction.value === 'skipped'")
    expect(source).not.toContain("'done' | 'skipped'")
  })

  it('弹幕与夺城：只认真实事件，不带任何旁路', () => {
    expect(source).toContain('done: () => cityBarraged(),')
    expect(source).toContain('done: () => cityTaken(),')
  })

  it('不存在「跳过」通道（store 与界面都不能有）', () => {
    expect(source).not.toContain('skipCurrent')
    expect(source).not.toContain('skippedSteps')
    expect(guide).not.toContain('skipCurrent')
    expect(guide).not.toContain('跳过')
  })

  it('教学引导卡片只保留退出按钮，不提供逐步骤逃逸', () => {
    expect(guide).toContain('tutorial.stop()')
    expect(guide).not.toContain('tut__skip')
  })
})
