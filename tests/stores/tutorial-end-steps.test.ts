import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/*
 * 2026-11-21：教学模式最后三步（苏军反扑 / 弹幕轰城 / 夺城）的完成判据回归
 *
 * 背景：原实现用 `phaseAtLeast(workbench.phase, 'combat' | 'exploitation')` 兜底，
 * 阶段一进战斗段就把「反扑」「弹幕」同时判完、一进挺进段就判完「夺城」——玩家什么都没做
 * 引导也显示完成，而 `cityBarraged()` / `cityTaken()` 的真实检查被 `||` 短路成永不生效。
 * 现改为「只认真实事件 + 玩家显式跳过」，本用例锁住这个判据不再退回阶段兜底。
 */
describe('教学模式后三步：只认真实事件，不由阶段推进放行', () => {
  const source = readFileSync('src/stores/tutorial.ts', 'utf8')

  it('三步的 done 都不再用阶段兜底', () => {
    expect(source).not.toContain("phaseAtLeast(workbench.phase, 'combat')")
    expect(source).not.toContain("phaseAtLeast(workbench.phase, 'exploitation')")
  })

  it('反扑：改由「反应段真的打过」判定（PvE 下苏军归 AI）', () => {
    expect(source).toContain('reactionFought.value')
    expect(source).toContain("reaction.value === 'done'")
    expect(source).toContain("reaction.value === 'skipped'")
  })

  it('弹幕与夺城：真实事件仍在判据里，并与显式跳过并列', () => {
    expect(source).toContain('cityBarraged() ||')
    expect(source).toContain("skippedSteps.value.has('barrage-city')")
    expect(source).toContain('cityTaken() ||')
    expect(source).toContain("skippedSteps.value.has('capture-city')")
  })

  it('跳过入口暴露给 store 与界面（否则玩家不做就卡死）', () => {
    expect(source).toContain('skipCurrent,')
    expect(source).toContain('function skipCurrent()')
    const guide = readFileSync('src/components/tutorial/TutorialGuide.vue', 'utf8')
    expect(guide).toContain('tutorial.skipCurrent()')
  })

  it('跳过写进 skippedSteps，且以新 Set 赋值以触发响应式重算', () => {
    expect(source).toContain('const skippedSteps = ref<Set<string>>(new Set())')
    expect(source).toContain('next.add(step.id)')
    expect(source).toContain('skippedSteps.value = next')
  })
})
