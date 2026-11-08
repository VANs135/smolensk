import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * U1-a 源码守卫（主壳与 L0 常驻条）
 *
 * 用户交互规格：顶栏常驻显示「分数、回合、环节」，且只有**一个**推进入口；
 * 低频入口（图层、切方、AI、快捷键）收进面板，不再平铺在地图上方；
 * 正式界面不出现批次 / 调试文案。
 *
 * 这里只做源码守卫（不 mount 组件）：U1 各批的验收靠这组片段断言 + 既有 store 用例。
 */

const FLOW = readFileSync('src/components/session/FlowStrip.vue', 'utf8')
const VIEW = readFileSync('src/views/GameTableView.vue', 'utf8')
const APP = readFileSync('src/App.vue', 'utf8')

describe('U1-a：L0 常驻条', () => {
  it('常驻显示方 · 阶段 · 回合、分数与环节', () => {
    expect(FLOW).toContain('bar__turn')
    expect(FLOW).toContain('turnNow')
    expect(FLOW).toContain('bar__score')
    expect(FLOW).toContain('score.listedBySide')
    expect(FLOW).toContain('currentSegment.label')
    expect(FLOW).toContain('hotseat.decisionSide')
  })

  it('推进入口唯一，阻断原因就地显示', () => {
    expect(FLOW).toContain(':disabled="!flow.canAdvance || liveBlock !== null"')
    expect(FLOW).toContain('workbench.currentAdvanceBlock')
    expect(FLOW).toContain('liveBlock.value ?? workbench.advanceBlock')
    // L0 条不再自报「流程条」这种调试抬头
    expect(FLOW).not.toContain('bar__title')
  })

  it('低频入口由棋桌导轨打开设置抽屉', () => {
    expect(VIEW).toContain('aria-controls="\'table-drawer-\' + item.id"')
    expect(VIEW).toContain('id="table-drawer-settings"')
    expect(VIEW).toContain('视图与面板')
    expect(VIEW).not.toContain('gt__stat')
    expect(VIEW).not.toContain('gt__bar')
    // 正式界面不出现交接模式 / 规则号之类的调试文案
    expect(VIEW).not.toContain('（{{ hotseat.mode }}）')
    expect(VIEW).not.toContain('ZOC（4.5）')
  })

  it('面板默认收纳（进入对局台折叠右栏，离开时恢复）', () => {
    expect(VIEW).toContain('hotkeys.panelCollapsed = true')
    expect(VIEW).toContain('panelCollapsedOnEnter')
  })

  it('外层顶栏不再显示环境徽章', () => {
    expect(APP).not.toContain('shell__env')
  })
})
