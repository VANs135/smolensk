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

  it('教学收束：完成态是居中弹窗「教程结束」，不再只是角标小卡', () => {
    // 用户 2026-11-22：走完 25 步要弹窗告诉玩家教程结束，角标小卡玩家根本注意不到
    expect(guide).toContain('tut__modal')
    expect(guide).toContain('role="dialog"')
    expect(guide).toContain('教程结束')
    expect(guide).toContain('tut__done-close')
    // 旧的小卡形态必须收掉，否则弹窗与小卡会同时出现
    expect(guide).not.toContain('tut__card--done')
  })

  it('引导指向的按钮文字必须是界面上真有的控件', () => {
    const mapView = readFileSync('src/stores/map-view.ts', 'utf8')
    // 10.1：火炮入口是右键菜单项「炮击」——面板里没有叫「弹幕」的按钮
    expect(mapView).toContain("label: '炮击'")
    expect(source).toContain("texts: ['炮击', '弹幕']")
    // 5.4a：改模式项在**折叠**子菜单里 ⇒ 必须同时给格子，否则一个环都画不出来
    expect(source).toContain("hex: stackHex.value, texts: ['改变朝向 → 移动模式']")
    expect(mapView).toContain("pushMode('move.orientation.toggle', '改变朝向 → 移动模式'")
    // 12.5c：右键加油项的真实文案拼自 fuelMethodLabel（「编队法（12.5c-A）」），教学只用前缀
    expect(mapView).toContain('加油 · ${workbench.fuelMethodLabel')
    expect(source).toContain("texts: ['加油 · 编队法']")
  })

  it('改模式这步的指引必须交代「右键 + 展开折叠分组」', () => {
    // 用户 2026-11-22：「指引细一点，包括告诉玩家要右键点击」
    // 「改变朝向 → 移动模式」挂在右键菜单的「模式改变」分组里且默认收起，
    // 只说菜单项名字，玩家会当场找不到入口。
    expect(source).toContain('右键点在堆上')
    expect(source).toContain('「模式改变」')
    expect(source).toContain('展开')
  })
})
