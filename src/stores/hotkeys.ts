import { defineStore } from 'pinia'
import { ref } from 'vue'

import { useHotseatStore } from './hotseat'
import { useUiStore } from './ui'
import { useWorkbenchStore } from './workbench'

/**
 * 快捷键（W7 C16）
 *
 * ## 设计
 *   · **纯函数 `resolveHotkey`** 负责「这个按键是什么意思」——只看按键与上下文，
 *     不碰 DOM、不碰 store ⇒ 可单测（`tests/stores/hotkeys.test.ts`）；
 *   · store 负责**接线**：绑定 `window` 的 keydown，把动作派发给操作台 / 界面 / 会话 store；
 *   · 视图（对局台）在挂载时 `bind()`、卸载时 `unbind()`，并把地图的缩放/适配回调登记进
 *     `viewBridge`（地图放大缩小属渲染层能力，快捷键不该自己去算视口）。
 *
 * ## 纪律
 *   · 输入框里打字**绝不**触发快捷键（`typing` 由调用方判定后传入）；
 *   · **控件自己的键不吃**：焦点在按钮/链接上时回车/空格归该控件（否则按钮按不动）；
 *   · **不占浏览器/系统的通用键**：`Tab`（焦点跳转）不绑；带 Ctrl/Meta/Alt 的组合键只认我们自己
 *     声明的（如 Ctrl+S 存档），其余一律放行给浏览器；
 *   · 快捷键**不做任何规则判断**：它只是把「玩家按了 X」翻译成「调用某个已存在的动作」。
 */

/** 快捷键动作（全部映射到既有 store 动作；本模块不新增业务能力） */
export const HOTKEY_ACTIONS = [
  /** 工具：移动（C5） */
  'tool.move',
  /** 工具：战斗 / 轰炸 / 空军的开火选目标（C6/C7/C9） */
  'tool.battle',
  /*
   * ★ 已删（2026-09-16）`tool.place`：用户口径「**正式游戏界面不应有摆算子的操作，
   *   应该完全由流程驱动**」⇒ 对局台不再有摆算子工具，`3 / P` 也就没有去处了
   *   （留着它只会把玩家切进一个"点了地图什么都不发生"的死状态）。
   *   算子上盘一律走流程：初设（IV）、增援到货（13.6）、重建（13.5）、方面军预备队（专规 2.3c）。
   *   自由摆放只留在**引擎验证页**（`WorkbenchView` 的可见按钮），不再占热键。
   */
  /** 整堆叠开关（6.1） */
  'stack.toggle',
  /** 结束本次移动（6.1） */
  'move.end',
  /** 撤销一步（6.1） */
  'move.undo',
  /** 取消当前交互 / 关小窗 */
  'cancel',
  /** 交给对手（热坐切方） */
  'side.next',
  /** 地图放大 / 缩小 / 适应窗口 */
  'view.zoomIn',
  'view.zoomOut',
  'view.fit',
  /** 侧栏折叠（对局台） */
  'panel.toggle',
  /** 快捷键说明 */
  'help.toggle',
  /** 存档 / 读档（D1 / C15） */
  'save.open',
] as const
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number]

/** 归一化后的按键事件（只取解析需要的字段；便于单测构造） */
export interface HotkeyEventLike {
  /** `KeyboardEvent.key`（如 '1'、'm'、'Enter'、'Escape'、'+'、'?'） */
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  /**
   * 事件是否来自输入类元素（input / textarea / select / contenteditable）
   *
   * 由调用方（绑定层）判定后传入 —— 纯函数不读 DOM。
   */
  typing?: boolean
}

/** 窄化后的按键描述（供界面显示「按了什么」） */
export interface HotkeyHit {
  action: HotkeyAction
  /** 是否要求 Ctrl/Meta（存档用） */
  withModifier: boolean
}

/**
 * 按键 → 动作（纯函数）
 *
 * 未命中、来自输入框、或带我们没声明的修饰键 ⇒ 返回 null（放行给浏览器）。
 */
export function resolveHotkey(event: HotkeyEventLike): HotkeyHit | null {
  if (event.typing === true) return null
  const key = event.key
  const lower = key.length === 1 ? key.toLowerCase() : key
  const hasModifier = event.ctrlKey === true || event.metaKey === true

  // Ctrl/Meta 组合：只认 Ctrl+S（存档）
  if (hasModifier) {
    return lower === 's' ? { action: 'save.open', withModifier: true } : null
  }
  if (event.altKey === true) return null

  switch (lower) {
    case '1':
    case 'm':
      return { action: 'tool.move', withModifier: false }
    case '2':
    case 'b':
    case 'f':
      return { action: 'tool.battle', withModifier: false }
    case 's':
      return { action: 'stack.toggle', withModifier: false }
    case 'Enter':
      return { action: 'move.end', withModifier: false }
    case 'Backspace':
    case 'u':
      return { action: 'move.undo', withModifier: false }
    case 'Escape':
      return { action: 'cancel', withModifier: false }
    // ★ 4.9a 的「交给对手」不再绑 **Tab**：Tab 是浏览器的**焦点跳转**键，占用它等于让
    //   键盘用户无法用 Tab 走到任何控件（且我们还会 preventDefault）。改绑 **T**（handoff），
    //   Tab 交还浏览器（`resolveHotkey` 对未声明的键一律返回 null ⇒ 不 preventDefault）。
    case 't':
      return { action: 'side.next', withModifier: false }
    case '+':
    case '=':
      return { action: 'view.zoomIn', withModifier: false }
    case '-':
    case '_':
      return { action: 'view.zoomOut', withModifier: false }
    case '0':
      return { action: 'view.fit', withModifier: false }
    case 'h':
      return { action: 'panel.toggle', withModifier: false }
    case '?':
      return { action: 'help.toggle', withModifier: false }
    default:
      return null
  }
}

/** 快捷键说明表（界面照它铺「按键提示」；顺序即展示顺序） */
export interface HotkeyDoc {
  keys: string
  label: string
  rule: string
}

export const HOTKEY_DOCS: readonly HotkeyDoc[] = [
  { keys: '1 / M', label: '工具：移动（点己方堆叠开始移动）', rule: '6.1' },
  { keys: '2 / B', label: '工具：战斗 / 轰炸 / 空军（点目标格）', rule: '9.0 / 10.0 / 14.2f' },
  { keys: 'S', label: '整堆叠开关（同格一起动）', rule: '6.1' },
  { keys: 'Enter', label: '结束本次移动', rule: '6.1' },
  { keys: 'U / Backspace', label: '撤销一步', rule: '6.1' },
  { keys: 'Esc', label: '取消当前交互 / 关小窗', rule: '—' },
  { keys: 'T', label: '交给对手（热坐切方，走交接流程）', rule: '4.9a' },
  { keys: '+ / -', label: '地图放大 / 缩小', rule: '—' },
  { keys: '0', label: '适应窗口', rule: '—' },
  { keys: 'H', label: '折叠 / 展开侧栏', rule: '—' },
  { keys: 'Ctrl + S', label: '存档 / 读档', rule: 'D1 / C15' },
  { keys: '?', label: '显示 / 隐藏本说明', rule: '—' },
]

/** 动作 → 一行中文说明（界面与反馈用；与 `HOTKEY_DOCS` 一一对应） */
const ACTION_LABELS: Record<HotkeyAction, string> = {
  'tool.move': '工具：移动',
  'tool.battle': '工具：战斗 / 轰炸 / 空军',
  'stack.toggle': '整堆叠',
  'move.end': '结束移动',
  'move.undo': '撤销一步',
  cancel: '取消 / 关小窗',
  'side.next': '交给对手',
  'view.zoomIn': '放大',
  'view.zoomOut': '缩小',
  'view.fit': '适应窗口',
  'panel.toggle': '折叠侧栏',
  'help.toggle': '快捷键说明',
  'save.open': '存档 / 读档',
}

/** 地图能力回调（由地图所在视图登记；快捷键不自己算视口） */
export interface HotkeyViewBridge {
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  /** 当前小窗是否打开（Esc 优先关它；由视图给） */
  closePopup: () => boolean
  /**
   * 收起地图上就地摊开的堆叠（B3）；返回是否真的收了
   *
   * 放在 Esc 链**最前**：摊开是"最后发生的事"，先收它才符合"层层退回"的直觉；
   * 它与小窗互斥（摊开会关小窗），所以不会出现"该收哪个"的歧义。
   */
  collapseStack: () => boolean
  /**
   * 取消当前的**唯一会话框**（B4，方案 §4.3）；返回是否真的取消了
   *
   * Esc 排在最前：会话框是地图上最"重"的一层，玩家按 Esc 时最可能想中止当前这次操作。
   * 视图侧的实现必须落到引擎的 `cancelXxx`（与面板里「取消」按钮同一条路）。
   */
  cancelSession: () => boolean
}

export const useHotkeyStore = defineStore('hotkeys', () => {
  const workbench = useWorkbenchStore()
  const ui = useUiStore()
  const hotseat = useHotseatStore()

  /** 是否启用（默认启用；输入框聚焦时由绑定层自动放行） */
  const enabled = ref(true)

  /** 快捷键说明是否展开 */
  const helpOpen = ref(false)

  /** 对局台的侧栏是否折叠 */
  const panelCollapsed = ref(false)

  /** 地图能力（视图登记） */
  const viewBridge = ref<HotkeyViewBridge | null>(null)

  /** 最近一次命中的动作（界面可据此给一行反馈） */
  const lastAction = ref<{ action: HotkeyAction; detail: string } | null>(null)

  /** 登记/注销地图能力 */
  function setViewBridge(bridge: HotkeyViewBridge | null): void {
    viewBridge.value = bridge
  }

  /**
   * 事件目标是否输入类元素（**只看鸭子类型**，不引用 `HTMLElement`）
   *
   * 这样纯函数在 node（无 DOM 全局）里也能跑，测试可直接传一个 `{ tagName: 'INPUT' }` 假对象。
   */
  function isTypingTarget(target: EventTarget | null): boolean {
    if (target === null || typeof target !== 'object') return false
    const element = target as { tagName?: unknown; isContentEditable?: unknown }
    const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : ''
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    return element.isContentEditable === true
  }

  /**
   * 事件目标是否**可聚焦控件**（按钮 / 链接 / 输入类）
   *
   * 用于放行「控件自己的键」：焦点在按钮上按回车＝**激活该按钮**，不是「结束移动」。
   * 修前 `Enter → move.end` 会把它吃掉（还 preventDefault），按钮按不动。
   * 同样是鸭子类型判定，纯函数可在 node 里测。
   */
  function isControlTarget(target: EventTarget | null): boolean {
    if (target === null || typeof target !== 'object') return false
    const element = target as { tagName?: unknown; isContentEditable?: unknown }
    const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : ''
    if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return true
    return isTypingTarget(target) || element.isContentEditable === true
  }

  /** 控件自己处理的键（不回给热键，也不 preventDefault） */
  const CONTROL_OWNED_KEYS = new Set(['Enter', ' '])

  /** 执行一个动作（返回是否真的做了事，便于调用方决定要不要 preventDefault） */
  function dispatch(action: HotkeyAction): boolean {
    switch (action) {
      case 'tool.move':
        workbench.setTool('move')
        return true
      case 'tool.battle':
        workbench.setTool('battle')
        return true
      case 'stack.toggle':
        workbench.setStackSelect(!workbench.stackSelect)
        return true
      case 'move.end':
        if (workbench.moveInteraction === null) return false
        workbench.finishMove()
        return true
      case 'move.undo':
        if (workbench.moveInteraction === null) return false
        workbench.undoLastStep()
        return true
      case 'cancel':
        // 层层退回：会话框（最重）→ 就地摊开的堆叠 → 小程序小窗 → 整次移动
        if (viewBridge.value?.cancelSession() === true) return true
        if (viewBridge.value?.collapseStack() === true) return true
        if (viewBridge.value?.closePopup() === true) return true
        if (workbench.moveInteraction !== null) {
          workbench.cancelWholeMove()
          return true
        }
        return false
      case 'side.next':
        // 4.9a：交给对手要走**交接流程**（启用热坐时先亮交接屏，未确认前不显示盘面）。
        // 修前直接 `workbench.switchSide()` ⇒ 交接屏永远不会出现，热坐的遮屏形同虚设。
        hotseat.beginHandoff()
        return true
      case 'view.zoomIn':
        viewBridge.value?.zoomIn()
        return viewBridge.value !== null
      case 'view.zoomOut':
        viewBridge.value?.zoomOut()
        return viewBridge.value !== null
      case 'view.fit':
        viewBridge.value?.fit()
        return viewBridge.value !== null
      case 'panel.toggle':
        panelCollapsed.value = !panelCollapsed.value
        return true
      case 'help.toggle':
        helpOpen.value = !helpOpen.value
        return true
      case 'save.open':
        ui.openSaveDialog()
        return true
      default:
        return false
    }
  }

  /** keydown 处理（绑定层调用；返回是否消费了该事件） */
  function handleKeydown(event: {
    key: string
    ctrlKey?: boolean
    metaKey?: boolean
    altKey?: boolean
    shiftKey?: boolean
    target: EventTarget | null
    preventDefault: () => void
  }): boolean {
    if (!enabled.value) return false
    // ★ 控件自己的键：焦点在按钮/链接上时回车＝激活该控件（Space 同理），热键让路
    //   （既不派发也不 preventDefault）——修前「回车＝结束移动」会把它吃掉，键盘用户按不动按钮。
    if (isControlTarget(event.target) && CONTROL_OWNED_KEYS.has(event.key)) return false
    const hit = resolveHotkey({
      key: event.key,
      ...(event.ctrlKey === undefined ? {} : { ctrlKey: event.ctrlKey }),
      ...(event.metaKey === undefined ? {} : { metaKey: event.metaKey }),
      ...(event.altKey === undefined ? {} : { altKey: event.altKey }),
      ...(event.shiftKey === undefined ? {} : { shiftKey: event.shiftKey }),
      typing: isTypingTarget(event.target),
    })
    if (hit === null) return false
    const handled = dispatch(hit.action)
    if (handled) {
      event.preventDefault()
      lastAction.value = { action: hit.action, detail: ACTION_LABELS[hit.action] }
    }
    return handled
  }

  let bound = false
  function onKeydown(event: KeyboardEvent): void {
    handleKeydown({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      target: event.target,
      preventDefault: () => event.preventDefault(),
    })
  }

  /** 绑定 window 监听（对局台挂载时调用；重复调用安全） */
  function bind(): void {
    if (bound || typeof window === 'undefined') return
    window.addEventListener('keydown', onKeydown)
    bound = true
  }

  /** 解绑（卸载时调用） */
  function unbind(): void {
    if (!bound || typeof window === 'undefined') return
    window.removeEventListener('keydown', onKeydown)
    bound = false
  }

  return {
    // 状态
    enabled,
    helpOpen,
    panelCollapsed,
    lastAction,
    // 动作
    setViewBridge,
    bind,
    unbind,
    handleKeydown,
    dispatch,
  }
})
