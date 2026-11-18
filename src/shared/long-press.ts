/**
 * 触摸屏长按（= 桌面右键）
 *
 * ## 为什么不直接靠 `contextmenu`
 * 桌面右键当然能收到 `contextmenu`；但触摸屏上的「长按是否补发 `contextmenu`」取决于
 * WebView 版本与内容类型——`<canvas>`、`<img>` 上多数情况**不补发**，而是走系统那条
 * 「长按选择 / 保存图片」的路。故长按必须自己在 `pointerdown` 起计时判定，判成之后
 * **主动**调同一个处理函数；`contextmenu` 原样保留给鼠标（桌面浏览器 / 外接鼠标）。
 *
 * ## 与拖动、单击的共存
 * 长按之前这段手势仍可能演化成「拖动」或「单击」，所以：
 *   ① 位移超出 `LONG_PRESS_SLOP_PX` ⇒ 作废（玩家是在拖，不是在长按）；
 *   ② 先抬手 / 被系统取消 ⇒ 作废（那是一记普通点击）；
 *   ③ 已经判定成长按 ⇒ **吃掉随后的那一次 click**（`suppressNextClick`），否则松手会
 *      顺着再触发一次点击（地图上表现为「长按开菜单、松手又选中了那一格」）。
 *
 * 只在 `pointerType` 为 touch / pen 时生效：鼠标行为一字不改。
 */
import type { Directive } from 'vue'

/** 判定为长按所需的按住时长（毫秒） */
export const LONG_PRESS_MS = 500

/** 长按允许的最大位移（屏幕像素）——超过即认定玩家在拖动 */
export const LONG_PRESS_SLOP_PX = 10

/** 是否触摸类指针（触摸 / 触控笔）；鼠标一律走原有桌面语义 */
export function isTouchPointer(pointerType: string): boolean {
  return pointerType === 'touch' || pointerType === 'pen'
}

/** 位移是否已超出长按容差 */
export function longPressMoved(
  start: { x: number; y: number },
  current: { x: number; y: number },
  slop = LONG_PRESS_SLOP_PX,
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > slop
}

/**
 * 吃掉「紧接着的那一次点击」
 *
 * 长按成立后浏览器仍会补发 `click`；组件多半在 `@click` 上挂着「选中 / 打开」，
 * 不拦就会出现长按与点击各触发一次。监听挂在**捕获**阶段并 `stopPropagation`，
 * 使得组件上的 `@click`（冒泡阶段）收不到。
 *
 * 定时兜底：有些场景长按后元素被卸载 / 菜单盖住，`click` 根本不发生；若不设上限，
 * 这个监听会一直挂着，把之后的第一次点击也吞掉。
 */
let suppressionActive = false
let suppressionTimer: number | null = null

function swallowClick(event: Event): void {
  if (!suppressionActive) return
  event.stopPropagation()
  event.preventDefault()
  releaseSuppression()
}

function releaseSuppression(): void {
  suppressionActive = false
  if (suppressionTimer !== null) {
    window.clearTimeout(suppressionTimer)
    suppressionTimer = null
  }
  window.removeEventListener('click', swallowClick, true)
}

/** 吞掉随后的一次点击（长按成立后调用） */
export function suppressNextClick(holdMs = 700): void {
  if (typeof window === 'undefined') return
  // 上一次的拦截还没兑现就再来一次：先清掉，避免叠加多个监听
  if (suppressionActive) releaseSuppression()
  suppressionActive = true
  window.addEventListener('click', swallowClick, true)
  suppressionTimer = window.setTimeout(releaseSuppression, holdMs)
}

/** 元素上挂着的识别状态（`unmounted` 时取回以便解绑） */
interface LongPressBinding {
  detach: () => void
}

const attached = new WeakMap<HTMLElement, LongPressBinding>()
/** 处理函数的可变槽（模板内联箭头函数每次渲染都是新引用，长按回调必须读到最新的那个） */
const handlerSlots = new WeakMap<HTMLElement, { handler: (event: PointerEvent) => void }>()

/**
 * 把「长按」接到某个元素上
 *
 * 返回解绑函数。`handler` 收到的是**触发长按的那次 `pointerdown`**（带 `clientX/clientY`），
 * 于是「就地弹菜单」这类处理函数不必区分事件来源是鼠标还是手指。
 */
export function attachLongPress(
  element: HTMLElement,
  handler: (event: PointerEvent) => void,
): () => void {
  let timer: number | null = null
  let start: { x: number; y: number } | null = null
  let origin: PointerEvent | null = null

  function clearTimer(): void {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }

  function reset(): void {
    clearTimer()
    start = null
    origin = null
  }

  function onDown(event: PointerEvent): void {
    if (!isTouchPointer(event.pointerType) || event.button !== 0) return
    reset()
    start = { x: event.clientX, y: event.clientY }
    origin = event
    timer = window.setTimeout(() => {
      const fired = origin
      reset()
      if (fired === null) return
      suppressNextClick()
      handler(fired)
    }, LONG_PRESS_MS)
  }

  function onMove(event: PointerEvent): void {
    if (start === null) return
    if (longPressMoved(start, { x: event.clientX, y: event.clientY })) reset()
  }

  function onEnd(): void {
    reset()
  }

  element.addEventListener('pointerdown', onDown)
  element.addEventListener('pointermove', onMove)
  element.addEventListener('pointerup', onEnd)
  element.addEventListener('pointercancel', onEnd)
  element.addEventListener('pointerleave', onEnd)

  return () => {
    reset()
    element.removeEventListener('pointerdown', onDown)
    element.removeEventListener('pointermove', onMove)
    element.removeEventListener('pointerup', onEnd)
    element.removeEventListener('pointercancel', onEnd)
    element.removeEventListener('pointerleave', onEnd)
  }
}

/**
 * `v-long-press="处理函数"`（局部注册即可：`const vLongPress = ...`）
 *
 * 处理函数收到触发长按的那次指针事件；同时**不**影响该元素原有的 `@click` / `@contextmenu`。
 */
export const vLongPress: Directive<HTMLElement, (event: PointerEvent) => void> = {
  mounted(element, binding) {
    const slot = { handler: binding.value }
    handlerSlots.set(element, slot)
    attached.get(element)?.detach()
    attached.set(element, { detach: attachLongPress(element, (event) => slot.handler(event)) })
  },
  updated(element, binding) {
    const slot = handlerSlots.get(element)
    if (slot !== undefined) slot.handler = binding.value
  },
  unmounted(element) {
    attached.get(element)?.detach()
    attached.delete(element)
    handlerSlots.delete(element)
  },
}
