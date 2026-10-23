import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { isMapGestureTarget } from '@/render/map-input'

/**
 * B18a：**地图手势的归属**（用户报告「点击增援窗口还是点到地图」）
 *
 * 机理：地图的指针/滚轮监听挂在**视口容器**上，而地图上的 DOM 浮层（唯一会话框 `MapDock`、
 * 初设的「待你决定」队列 `DecisionQueue`、就地小窗）是**该容器的子节点** ⇒ 在浮层里点一下，
 * 事件冒泡到容器的监听器，于是同一个点击既是"按了面板上的按钮"、又被当成"点了地图的某一格"。
 * 给浮层加 `pointer-events` 治不了它——浮层本来就该收到事件，缺的是**容器侧的归属判断**。
 *
 * 本文件钉两件事：① 归属判据本身（纯函数）；② `MapCanvas` 的每一个手势入口都过了这道闸
 * （源码守卫：漏掉任意一处，那一种输入就会穿透）。
 */

describe('B18a：手势归属判据（纯函数）', () => {
  const canvas = {} as EventTarget
  const overlayButton = {} as EventTarget

  it('发源于画布 ⇒ 算地图手势', () => {
    expect(isMapGestureTarget(canvas, canvas)).toBe(true)
  })

  it('★ 发源于浮层（会话框 / 决策队列）⇒ **不算**地图手势（点窗口不再点到地图）', () => {
    expect(isMapGestureTarget(overlayButton, canvas)).toBe(false)
  })

  it('拿不到目标或画布（未挂载 / 合成事件）⇒ 保守地不认（宁可漏一次悬停，也不误点）', () => {
    expect(isMapGestureTarget(null, canvas)).toBe(false)
    expect(isMapGestureTarget(canvas, null)).toBe(false)
    expect(isMapGestureTarget(null, null)).toBe(false)
  })
})

/**
 * B24：**指针捕获会把 `target` 换成捕获元素**（用户报告「无法拖动地图」+「点初设高亮格无反应」）
 *
 * MDN（`Element.setPointerCapture`）：「Subsequent events for the pointer will be targeted at
 * the capture element until capture is released」——即捕获期间连 `pointerup` 的 `target` 都
 * 不是光标下的画布。修前捕获取在视口容器上、判据只认 `target === canvas` ⇒ 按下之后的
 * 每一次移动与那一次抬起都被判成"不是地图手势" ⇒ 拖动不平移、抬起不点格（两条现象同源）。
 *
 * 本组钉：
 *   ① 纯函数接受「手势已在画布上开始」这一路（`continued`）；
 *   ② 接线：捕获取在**画布**上（而不是容器）、移动与抬起把拖动状态传进闸门。
 */
describe('B24：捕获重定向下的手势归属（拖动与点击不再被吞）', () => {
  const canvas = {} as EventTarget
  const container = {} as EventTarget

  it('★ 拖动中（continued）⇒ 即便 target 是捕获元素（容器）也认作地图手势', () => {
    expect(isMapGestureTarget(container, canvas, true)).toBe(true)
    // 拖到浮层上、甚至 target 为 null，都不该中断这段手势
    expect(isMapGestureTarget({} as EventTarget, canvas, true)).toBe(true)
    expect(isMapGestureTarget(null, canvas, true)).toBe(true)
  })

  it('★ 没在拖动时仍然只认画布（浮层点击不许穿透）', () => {
    expect(isMapGestureTarget(container, canvas, false)).toBe(false)
    expect(isMapGestureTarget({} as EventTarget, canvas, false)).toBe(false)
  })

  it('源码守卫：捕获取在画布上（捕获元素＝判据认的那个元素）', () => {
    const source = readFileSync('src/components/map/MapCanvas.vue', 'utf8')
    expect(source).toContain('captureTarget()?.setPointerCapture(event.pointerId)')
    expect(source).toContain('canvas.value ?? container.value')
    // 不再用 currentTarget（那是监听器所在的容器，捕获它会改掉 target）
    expect(source).not.toContain('event.currentTarget as HTMLElement')
  })

  it('源码守卫：移动与抬起把手势状态传进闸门（否则捕获期间仍会被吞）', () => {
    const source = readFileSync('src/components/map/MapCanvas.vue', 'utf8')
    for (const name of ['onPointerMove', 'onPointerUp']) {
      const start = source.indexOf(`function ${name}(`)
      const next = source.indexOf('function ', start + 10)
      const body = source.slice(start, next > 0 ? next : source.length)
      expect(body, `${name} 必须把拖动状态交给闸门`).toContain('isMapGesture(event, drag.dragging)')
    }
    // 按下这一击仍只认画布（手势的起点必须是画布）
    const down = source.indexOf('function onPointerDown(')
    const downBody = source.slice(down, source.indexOf('function ', down + 10))
    expect(downBody).toContain('isMapGesture(event)')
    expect(downBody).not.toContain('drag.dragging')
  })
})

describe('B18a：MapCanvas 的接线（源码守卫）', () => {
  const source = readFileSync('src/components/map/MapCanvas.vue', 'utf8')

  it('★ 四个指针入口与滚轮**都**过了归属闸门', () => {
    // 逐个函数体检查（按函数名切片，避免"只看整个文件里出现过一次"这种假绿）
    const bodies: Record<string, string> = {}
    for (const name of ['onWheel', 'onPointerDown', 'onPointerMove', 'onPointerUp']) {
      const start = source.indexOf(`function ${name}(`)
      expect(start, `${name} 应存在`).toBeGreaterThan(0)
      const next = source.indexOf('function ', start + 10)
      bodies[name] = source.slice(start, next > 0 ? next : source.length)
    }
    for (const [name, body] of Object.entries(bodies)) {
      // B24：移动/抬起还会把手势状态一并传进去（`isMapGesture(event, drag.dragging)`），故只认前缀
      expect(body, `${name} 必须过归属闸门`).toContain('isMapGesture(event')
    }
  })

  it('★ 滚轮的 preventDefault 挪进守卫内（否则会话框内容区滚不动、地图反而缩放）', () => {
    // 模板上不再有 .prevent 修饰符
    expect(source).not.toContain('@wheel.prevent')
    const start = source.indexOf('function onWheel(')
    const body = source.slice(start, start + 400)
    expect(body).toContain('event.preventDefault()')
  })

  it('指针取消**不**过闸门（它只做复位，必须无条件执行，否则拖动会永久卡住）', () => {
    const start = source.indexOf('function onPointerCancel(')
    const body = source.slice(start, start + 400)
    expect(body).not.toContain('isMapGesture(event)')
    expect(body).toContain('dragCancel(drag)')
  })

  it('归属判据只有一处实现（组件不自己写 target === canvas）', () => {
    expect(source).toContain("from '@/render/map-input'")
    expect(source).not.toContain('event.target === canvas')
  })
})
