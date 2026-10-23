import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { HOTKEY_ACTIONS, HOTKEY_DOCS, resolveHotkey, useHotkeyStore } from '@/stores'
import { useHotseatStore, useUiStore, useWorkbenchStore } from '@/stores'

/**
 * 快捷键（W7 C16）
 *
 * 分两层验证：
 *   ① **纯函数**：按键 → 动作的映射（含输入框放行、修饰键规则）；
 *   ② **接线**：动作派发是否真的调到了既有 store 动作（工具切换 / 结束移动 / 整堆叠 / 切方 / 存档）。
 * 快捷键不改变任何规则结论，故这里不涉及规则条款号。
 */

describe('W7 C16：按键 → 动作（纯函数）', () => {
  it('C16：工具切换（1/M 移动、2/B 战斗）；B21：`3 / P` 摆算子已删（正式界面不摆算子）', () => {
    expect(resolveHotkey({ key: '1' })?.action).toBe('tool.move')
    expect(resolveHotkey({ key: 'm' })?.action).toBe('tool.move')
    expect(resolveHotkey({ key: '2' })?.action).toBe('tool.battle')
    expect(resolveHotkey({ key: 'b' })?.action).toBe('tool.battle')
    // 用户口径：正式游戏界面不摆算子（一律由流程驱动）⇒ 这个键没有去处，也不该被吞
    expect(resolveHotkey({ key: '3' })).toBeNull()
    expect(resolveHotkey({ key: 'P' })).toBeNull()
    expect(HOTKEY_ACTIONS).not.toContain('tool.place')
  })

  it('C16：操作类（S 整堆叠 / Enter 结束 / U 撤销 / Esc 取消 / T 切方 / H 侧栏 / ? 说明）', () => {
    expect(resolveHotkey({ key: 's' })?.action).toBe('stack.toggle')
    expect(resolveHotkey({ key: 'Enter' })?.action).toBe('move.end')
    expect(resolveHotkey({ key: 'Backspace' })?.action).toBe('move.undo')
    expect(resolveHotkey({ key: 'u' })?.action).toBe('move.undo')
    expect(resolveHotkey({ key: 'Escape' })?.action).toBe('cancel')
    expect(resolveHotkey({ key: 't' })?.action).toBe('side.next')
    expect(resolveHotkey({ key: 'h' })?.action).toBe('panel.toggle')
    expect(resolveHotkey({ key: '?' })?.action).toBe('help.toggle')
  })

  it('M9③：不占浏览器的通用键——Tab 不再绑动作（焦点跳转交还浏览器）', () => {
    expect(resolveHotkey({ key: 'Tab' })).toBeNull()
    expect(resolveHotkey({ key: 'Tab', shiftKey: true })).toBeNull()
  })

  it('C16：视图类（+/-/0）与 Ctrl+S 存档（带修饰键）', () => {
    expect(resolveHotkey({ key: '+' })?.action).toBe('view.zoomIn')
    expect(resolveHotkey({ key: '=' })?.action).toBe('view.zoomIn')
    expect(resolveHotkey({ key: '-' })?.action).toBe('view.zoomOut')
    expect(resolveHotkey({ key: '0' })?.action).toBe('view.fit')
    const save = resolveHotkey({ key: 's', ctrlKey: true })
    expect(save).toMatchObject({ action: 'save.open', withModifier: true })
  })

  it('C16：输入框里打字不触发；未声明的修饰键组合一律放行', () => {
    expect(resolveHotkey({ key: 'm', typing: true })).toBeNull()
    expect(resolveHotkey({ key: 'Enter', typing: true })).toBeNull()
    expect(resolveHotkey({ key: 'Escape', typing: true })).toBeNull()
    // Ctrl+M / Alt+M / Ctrl+C 都不是我们的键
    expect(resolveHotkey({ key: 'm', ctrlKey: true })).toBeNull()
    expect(resolveHotkey({ key: 'm', altKey: true })).toBeNull()
    expect(resolveHotkey({ key: 'c', ctrlKey: true })).toBeNull()
    // 不认识的键
    expect(resolveHotkey({ key: 'F5' })).toBeNull()
    expect(resolveHotkey({ key: 'z' })).toBeNull()
  })

  it('C16：说明表覆盖全部动作（每条都说清按什么、做什么、依据哪个条款）', () => {
    // 每个动作都能由某个按键解析出来（存档要带 Ctrl）
    for (const action of HOTKEY_ACTIONS) {
      const hit = resolveHotkey({
        key: hotkeyKeyOf(action),
        ...(action === 'save.open' ? { ctrlKey: true } : {}),
      })
      expect(hit?.action).toBe(action)
    }
    expect(HOTKEY_DOCS.length).toBeGreaterThan(0)
    for (const doc of HOTKEY_DOCS) {
      expect(doc.keys.length).toBeGreaterThan(0)
      expect(doc.label.length).toBeGreaterThan(0)
      expect(doc.rule.length).toBeGreaterThan(0)
    }
  })
})

/** 取一个能触发该动作的按键（仅测试用；与 `resolveHotkey` 的表一一对应） */
function hotkeyKeyOf(action: (typeof HOTKEY_ACTIONS)[number]): string {
  const table: Record<(typeof HOTKEY_ACTIONS)[number], string> = {
    'tool.move': '1',
    'tool.battle': '2',
    'stack.toggle': 's',
    'move.end': 'Enter',
    'move.undo': 'u',
    cancel: 'Escape',
    'side.next': 't',
    'view.zoomIn': '+',
    'view.zoomOut': '-',
    'view.fit': '0',
    'panel.toggle': 'h',
    'help.toggle': '?',
    'save.open': 's',
  }
  return table[action]
}

describe('W7 C16：动作派发到既有 store（不做规则判断）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('C16：工具切换 / 整堆叠 / 切方 / 侧栏与说明开关都落到既有动作', () => {
    const workbench = useWorkbenchStore()
    const ui = useUiStore()
    const hotkeys = useHotkeyStore()

    expect(workbench.tool).toBe('move')
    hotkeys.dispatch('tool.battle')
    expect(workbench.tool).toBe('battle')
    hotkeys.dispatch('tool.move')
    expect(workbench.tool).toBe('move')

    expect(workbench.stackSelect).toBe(false)
    hotkeys.dispatch('stack.toggle')
    expect(workbench.stackSelect).toBe(true)

    const beforeSide = workbench.activeSide
    hotkeys.dispatch('side.next')
    expect(workbench.activeSide).not.toBe(beforeSide)

    expect(hotkeys.panelCollapsed).toBe(false)
    hotkeys.dispatch('panel.toggle')
    expect(hotkeys.panelCollapsed).toBe(true)

    expect(hotkeys.helpOpen).toBe(false)
    hotkeys.dispatch('help.toggle')
    expect(hotkeys.helpOpen).toBe(true)

    expect(ui.saveDialogOpen).toBe(false)
    hotkeys.dispatch('save.open')
    expect(ui.saveDialogOpen).toBe(true)
  })

  it('C16：没有在移动中时，Enter / U 不消费按键（不误吞）', () => {
    const hotkeys = useHotkeyStore()
    const consumed = hotkeys.handleKeydown({
      key: 'Enter',
      target: null,
      preventDefault: () => undefined,
    })
    expect(consumed).toBe(false)
  })

  it('C16：Esc 优先关小窗（地图小窗打开时不再取消整次移动）', () => {
    const workbench = useWorkbenchStore()
    const hotkeys = useHotkeyStore()
    let closed = false
    hotkeys.setViewBridge({
      zoomIn: () => undefined,
      zoomOut: () => undefined,
      fit: () => undefined,
      closePopup: () => {
        closed = true
        return true
      },
      collapseStack: () => false,
      cancelSession: () => false,
    })
    const consumed = hotkeys.handleKeydown({
      key: 'Escape',
      target: null,
      preventDefault: () => undefined,
    })
    expect(consumed).toBe(true)
    expect(closed).toBe(true)
    expect(workbench.moveInteraction).toBeNull()
  })

  it('B4：Esc 层层退回——会话框最重，只做一件，不顺手把小窗也关掉', () => {
    const hotkeys = useHotkeyStore()
    const order: string[] = []
    hotkeys.setViewBridge({
      zoomIn: () => undefined,
      zoomOut: () => undefined,
      fit: () => undefined,
      closePopup: () => {
        order.push('popup')
        return true
      },
      collapseStack: () => {
        order.push('stack')
        return true
      },
      cancelSession: () => {
        order.push('session')
        return true
      },
    })
    expect(
      hotkeys.handleKeydown({ key: 'Escape', target: null, preventDefault: () => undefined }),
    ).toBe(true)
    // 一次 Esc 只退一层：先取消会话框（最重的那个），其余三层不动（否则一击退回四级）
    expect(order).toEqual(['session'])
  })

  it('B3：没有会话框时 Esc 收就地摊开的堆叠', () => {
    const hotkeys = useHotkeyStore()
    const order: string[] = []
    hotkeys.setViewBridge({
      zoomIn: () => undefined,
      zoomOut: () => undefined,
      fit: () => undefined,
      closePopup: () => {
        order.push('popup')
        return true
      },
      collapseStack: () => {
        order.push('stack')
        return true
      },
      cancelSession: () => false,
    })
    expect(
      hotkeys.handleKeydown({ key: 'Escape', target: null, preventDefault: () => undefined }),
    ).toBe(true)
    expect(order).toEqual(['stack'])
  })

  it('B3：没有摊开时 Esc 仍照旧关小窗（新增的层不吞掉旧行为）', () => {
    const hotkeys = useHotkeyStore()
    let closed = false
    hotkeys.setViewBridge({
      zoomIn: () => undefined,
      zoomOut: () => undefined,
      fit: () => undefined,
      closePopup: () => {
        closed = true
        return true
      },
      collapseStack: () => false,
      cancelSession: () => false,
    })
    expect(
      hotkeys.handleKeydown({ key: 'Escape', target: null, preventDefault: () => undefined }),
    ).toBe(true)
    expect(closed).toBe(true)
  })

  it('C16：视图能力未登记时缩放不消费按键（不装作用户按了有用）', () => {
    const hotkeys = useHotkeyStore()
    expect(hotkeys.handleKeydown({ key: '+', target: null, preventDefault: () => undefined })).toBe(
      false,
    )
    hotkeys.setViewBridge({
      zoomIn: () => undefined,
      zoomOut: () => undefined,
      fit: () => undefined,
      closePopup: () => false,
      collapseStack: () => false,
      cancelSession: () => false,
    })
    expect(hotkeys.handleKeydown({ key: '+', target: null, preventDefault: () => undefined })).toBe(
      true,
    )
  })

  it('C16：输入框里按键一律不消费（`typing` 判定在绑定层）', () => {
    const hotkeys = useHotkeyStore()
    const element = { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget
    expect(
      hotkeys.handleKeydown({ key: 'm', target: element, preventDefault: () => undefined }),
    ).toBe(false)
  })

  it('M9③：切方走**交接流程**（4.9a）——热坐启用时亮交接屏，而不是静默换人', () => {
    const workbench = useWorkbenchStore()
    const hotseat = useHotseatStore()
    const hotkeys = useHotkeyStore()
    hotseat.setHotseatEnabled(true)

    const before = workbench.activeSide
    expect(hotkeys.handleKeydown({ key: 't', target: null, preventDefault: () => undefined })).toBe(
      true,
    )
    expect(workbench.activeSide).not.toBe(before)
    expect(hotseat.handoffPending).toBe(true)

    // 接手方确认后遮屏撤下；未启用热坐时不应留下交接屏
    hotseat.confirmHandoff()
    expect(hotseat.handoffPending).toBe(false)
    hotseat.setHotseatEnabled(false)
    hotkeys.handleKeydown({ key: 't', target: null, preventDefault: () => undefined })
    expect(hotseat.handoffPending).toBe(false)
    hotseat.setHotseatEnabled(true)
  })

  it('M9③：焦点在控件上时回车/空格归控件——热键既不派发也不 preventDefault', () => {
    const workbench = useWorkbenchStore()
    const hotkeys = useHotkeyStore()
    // 让「回车＝结束移动」本就可用：起一次移动
    expect(workbench.moveInteraction).toBeNull()

    const button = { tagName: 'BUTTON', isContentEditable: false } as unknown as EventTarget
    let prevented = 0
    const consumed = hotkeys.handleKeydown({
      key: 'Enter',
      target: button,
      preventDefault: () => {
        prevented += 1
      },
    })
    expect(consumed).toBe(false)
    expect(prevented).toBe(0) // 不抢按钮的默认行为（否则按钮按不动）
    expect(hotkeys.lastAction).toBeNull()

    // 空格同理（未绑定任何热键，但也不得被 preventDefault）
    const space = hotkeys.handleKeydown({
      key: ' ',
      target: button,
      preventDefault: () => {
        prevented += 1
      },
    })
    expect(space).toBe(false)
    expect(prevented).toBe(0)

    // 焦点不在控件上时，回车照旧（无移动交互 ⇒ 不消费，但不因此改变行为）
    expect(
      hotkeys.handleKeydown({ key: 'Enter', target: null, preventDefault: () => undefined }),
    ).toBe(false)
    // 非「控件自己的键」在控件上仍然生效（如 Esc 关小窗）
    let closed = false
    hotkeys.setViewBridge({
      zoomIn: () => undefined,
      zoomOut: () => undefined,
      fit: () => undefined,
      closePopup: () => {
        closed = true
        return true
      },
      collapseStack: () => false,
      cancelSession: () => false,
    })
    expect(
      hotkeys.handleKeydown({
        key: 'Escape',
        target: button,
        preventDefault: () => undefined,
      }),
    ).toBe(true)
    expect(closed).toBe(true)
  })
})
