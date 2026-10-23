<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import { BaseButton } from '@/components/base'
import type { HexRef } from '@/data'
import type { MapHint } from '@/stores/workbench-model'
import {
  IDLE_DRAG,
  beginDrag,
  dragCancel,
  dragEnd,
  dragMove,
  type DragGesture,
} from '@/render/drag-gesture'
import { BOARD_SIZE_PX, hexCanvasPoint, hitTestHex } from '@/render/map-layout'
// B18a：手势归属（浮层是容器的子节点 ⇒ 必须按事件源判断，否则点面板会同时点到地图）
import { isMapGestureTarget } from '@/render/map-input'
import {
  type BoundaryLine,
  DEFAULT_MAP_LAYERS,
  canDraw,
  drawMap,
  loadMapImage,
  type ConstructionMarkerPiece,
  type ControlMarker,
  type MapLayerVisibility,
} from '@/render/map-render'
import {
  allControlMarkerImageUrls,
  allMarkerTextureUrls,
  counterImages,
} from '@/render/token-images'
import { overlayImageUrls, type MovementOverlay } from '@/render/token-layer'
import {
  FIT_PADDING_PX,
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEP,
  clampViewport,
  fitViewport,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt,
  zoomToScale,
  type Size,
  type ViewportTransform,
} from '@/render/viewport'

/**
 * 地图画布（C2 地图渲染与视口）
 *
 * 职责边界（CODE_SPEC §2）：
 *   - 本组件只做「Canvas 绘制 + 收输入 + 视口控制」：几何全来自 `render/`，要素全来自 `@/data`；
 *   - **不做规则计算、不写引擎状态**——它连引擎都不引，规则由上层面板负责；
 *   - 视口（缩放/平移）是**视图局部状态**，留在本组件，与 U0 操作台的 scale 同规。
 *
 * 交互约定：
 *   滚轮 = 以光标为锚点缩放（光标下的格保持不动）· 左键拖拽 = 平移 ·
 *   左键单击（未拖动）= 选出该格并 emit · 悬停 = 显示格号
 */

const props = withDefaults(
  defineProps<{
    /** 图层开关（由上层持有，组件只读） */
    layers?: MapLayerVisibility
    /** 高亮格（如上层选中的格） */
    highlightHex?: HexRef | null
    /** 移动交互覆盖层（算子 / 可到达范围 / 预览路径；C5） */
    overlay?: MovementOverlay | null
    /**
     * 地图内**就地一行提示**（B9；null = 无提示）
     *
     * 由上层从 `workbench.mapHint`（纯函数 `mapHintOf`）算出后传入——画布**不读 store**，
     * 保持"渲染层只画被给的东西"这条分层纪律（CODE_SPEC §2）。
     */
    hint?: MapHint | null
    /**
     * 5.0c：**胜利格控制标记**（用户 2026-09-16 要求；由上层把"哪一格归谁"算好传进来）
     *
     * 与 `overlay` 分开：它是**地图事实**（不随会话开关变化），而且**不是算子**
     * ——不进命中测试、不可选中、不参与堆叠展开。
     */
    controlMarkers?: readonly ControlMarker[] | null
    /** B37 / 3.4：装甲集群分界线（地图事实层；由上层算好传入） */
    boundary?: BoundaryLine | null
    /**
     * 专规 3.5：**建造标记**（桥 / 简易机场）——玩家放在格里的那几枚（地图事实层）
     *
     * 与 `controlMarkers` 同族：不是算子 ⇒ 不进命中测试、不可选中；由上层把
     * `workbench.constructionMarkerPieces` 传进来（画布不读 store）。
     */
    constructionMarkers?: readonly ConstructionMarkerPiece[] | null
  }>(),
  {
    layers: () => ({ ...DEFAULT_MAP_LAYERS }),
    highlightHex: null,
    overlay: null,
    hint: null,
    controlMarkers: null,
    boundary: null,
    constructionMarkers: null,
  },
)

const emit = defineEmits<{
  /**
   * 左键单击选中某格
   *
   * `world` 是这一击在**世界坐标**里的位置（与绘制同一份变换）。堆叠就地展开要靠它判"点到了哪一枚"
   * （B3），故由画布直接给出——视图那边只有窗口坐标，换算会多一份可能不同步的真相。
   */
  hexClick: [hex: HexRef, world: { x: number; y: number }]
  /** 悬停格变化（离开画布为 null） */
  hexHover: [hex: HexRef | null]
}>()

const container = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

/** 视口变换（scale + offset） */
const viewport = ref<ViewportTransform>({ scale: 1, offsetX: 0, offsetY: 0 })
/** 视口尺寸（CSS 像素），由 ResizeObserver 维护 */
const viewSize = ref<Size>({ width: 0, height: 0 })

/** 地图扫描图（DOM 对象交给 shallowRef，避免 Vue 深代理大对象） */
const image = shallowRef<HTMLImageElement | null>(null)
/** 图片加载失败提示（不阻断矢量图层） */
const imageError = ref<string | null>(null)
/** 图片是否仍在加载 */
const imageLoading = ref(true)

const hoverHex = ref<HexRef | null>(null)

/** 高清屏后备存储系数 */
const pixelRatio = computed(() =>
  typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
)

/** 是否已完成首次「适应窗口」 */
let fitted = false
let resizeObserver: ResizeObserver | null = null

/**
 * 拖拽状态
 *
 * ★ 判定全在纯模块 `render/drag-gesture.ts`（可单测）：本组件只持有状态并按返回值行事。
 *   「`pointerup` 丢失 ⇒ 由 `pointercancel` / 按钮位已松两条路复位」这条纪律在那边实现。
 */
let drag: DragGesture = IDLE_DRAG

/* ── 绘制 ── */

/**
 * 重绘节流（W7 C16：`重绘的性能底线`）
 *
 * 拖动平移与滚轮缩放会在一次交互里连发多个 pointermove/wheel；直接同步重绘等于一帧画多次。
 * 这里合并到 **requestAnimationFrame**：同一帧内的多次请求只画一次，且始终画最新状态。
 * 命令式需要立即出图的地方（图片加载完成、初次适配窗口）仍直接调 `render()`。
 */
let pendingFrame = 0

function scheduleRender(): void {
  if (pendingFrame !== 0) return
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0
    render()
  })
}

/**
 * 预载该覆盖层要用到的算子图（未就绪的当帧走矢量回退，到位后再补一帧）
 *
 * 图片是异步的：本函数只「请求 + 等」，不参与绘制决策——画什么始终由 `overlay` 决定（渲染只读）。
 */
function preloadOverlayImages(overlay: MovementOverlay): Promise<void> {
  return counterImages.preload(overlayImageUrls(overlay))
}

function render(): void {
  const element = canvas.value
  const size = viewSize.value
  if (element === null || !canDraw(size)) return
  const context = element.getContext('2d')
  if (context === null) return

  // 后备存储按 DPR 放大，绘制内的坐标仍是 CSS 像素（见 map-render 的变换约定）
  const ratio = pixelRatio.value
  const backingWidth = Math.round(size.width * ratio)
  const backingHeight = Math.round(size.height * ratio)
  if (element.width !== backingWidth) element.width = backingWidth
  if (element.height !== backingHeight) element.height = backingHeight

  drawMap(context, {
    viewport: viewport.value,
    viewSize: size,
    pixelRatio: ratio,
    layers: props.layers,
    image: image.value,
    highlightHex: props.highlightHex,
    overlay: props.overlay,
    controlMarkers: props.controlMarkers,
    boundary: props.boundary,
    constructionMarkers: props.constructionMarkers,
  })
}

/* ── 视口变更（统一出口：变更 → 约束 → 重绘） ── */

function applyViewport(next: ViewportTransform): void {
  viewport.value = clampViewport(next, BOARD_SIZE_PX, viewSize.value)
  scheduleRender()
}

/** 适应窗口：整幅地图进视口并居中 */
function fitToWindow(): void {
  if (!canDraw(viewSize.value)) return
  viewport.value = fitViewport(BOARD_SIZE_PX, viewSize.value, FIT_PADDING_PX)
  render()
}

/** 以视口中心为锚点放大/缩小一档 */
function zoomByStep(direction: 1 | -1): void {
  if (!canDraw(viewSize.value)) return
  const anchor = { x: viewSize.value.width / 2, y: viewSize.value.height / 2 }
  applyViewport(zoomAt(viewport.value, anchor, direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
}

function onScaleInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value) || !canDraw(viewSize.value)) return
  applyViewport(zoomToScale(viewport.value, value, viewSize.value))
}

/* ── 尺寸变化 ── */

function syncSize(): void {
  const element = container.value
  if (element === null) return
  const rect = element.getBoundingClientRect()
  viewSize.value = { width: Math.max(rect.width, 0), height: Math.max(rect.height, 0) }
  if (!fitted && canDraw(viewSize.value)) {
    fitted = true
    fitToWindow()
    return
  }
  applyViewport(viewport.value)
}

/* ── 输入 ── */

/** 事件坐标 → 视口内 CSS 像素坐标 */
function toLocal(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
  const element = container.value
  if (element === null) return null
  const rect = element.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

/** 视口内坐标 → 世界坐标 + 命中格（两处输入共用的唯一变换） */
function hitAtLocal(point: { x: number; y: number }): {
  hex: HexRef
  world: { x: number; y: number }
} | null {
  const world = screenToWorld(point, viewport.value)
  const hex = hitTestHex(world.x, world.y)?.hex
  return hex === undefined ? null : { hex, world }
}

/** 视口内坐标 → 格号（经世界坐标，与绘制共用同一份变换） */
function hexAtLocal(point: { x: number; y: number }): HexRef | null {
  return hitAtLocal(point)?.hex ?? null
}

function onWheel(event: WheelEvent): void {
  // B18a：浮层里滚轮（会话框内容区滚动）不归地图管——否则面板滚不动，地图反而缩放
  if (!isMapGesture(event)) return
  event.preventDefault()
  const local = toLocal(event)
  if (local === null) return
  applyViewport(zoomAt(viewport.value, local, event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
}

/**
 * B18a：这一击/这一滚是否**发源于画布本身**
 *
 * 浮层（会话框 / 待你决定队列 / 就地小窗）是**视口容器的子节点** ⇒ 它们的事件会冒泡到
 * 容器的监听器，不设这道闸就会出现"点面板同时点到下面的格"（用户报告的那条）。
 * 详述与理由见 `render/map-input.ts`。
 *
 * ★ B24：`gestureLive` ＝"这段手势已经在画布上按下、还没结束"。**必须传**——
 *   指针捕获期间浏览器把 `target` 换成捕获元素（MDN 原文：subsequent events will be targeted
 *   at the capture element），只按 `target === canvas` 判会让拖动与点击一起失效
 *   （用户报告：「无法拖动地图」「点初设高亮格无反应」）。
 */
function isMapGesture(event: PointerEvent | WheelEvent, gestureLive = false): boolean {
  return isMapGestureTarget(event.target, canvas.value, gestureLive)
}

/**
 * 指针捕获的宿主元素（B24）
 *
 * 捕在**画布**上：捕获期间 `target` 始终是画布 ⇒ 归属判据天然成立。
 * 画布未挂载时退回容器（此时也没得拖）。
 */
function captureTarget(): Element | null {
  return canvas.value ?? container.value
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  if (!isMapGesture(event)) return
  drag = beginDrag({ x: event.clientX, y: event.clientY })
  // 指针捕获让「拖出画布」也能继续收到 pointermove。
  // 该 API 在指针已非活动时会抛错（快速点击 / 合成事件），故容错——否则拖动会卡住。
  try {
    captureTarget()?.setPointerCapture(event.pointerId)
  } catch {
    /* 捕获失败不影响拖动：指针移出画布时由 pointerleave 收尾 */
  }
}

function onPointerMove(event: PointerEvent): void {
  // B18a：悬停在浮层上不该高亮下面的格；B24：拖动中（捕获会把 target 换成捕获元素）照旧算
  if (!isMapGesture(event, drag.dragging)) return
  const local = toLocal(event)
  if (local === null) return

  // ★ 拖动判定交纯模块：它负责「按钮位已松 ⇒ 就地复位」这条异常路径（`pointerup` 可能收不到）
  const step = dragMove(drag, { x: event.clientX, y: event.clientY }, event.buttons)
  if (step.kind === 'aborted') drag = step.gesture
  else if (step.kind === 'pan') {
    drag = step.gesture
    applyViewport(panBy(viewport.value, step.dx, step.dy))
  }

  const hex = hexAtLocal(local)
  if (!sameHex(hoverHex.value, hex)) {
    hoverHex.value = hex
    emit('hexHover', hex)
  }
}

function onPointerUp(event: PointerEvent): void {
  // B24：抬起这一击属于"已在画布上按下"的那段手势 ⇒ 即便 target 被捕获改成别的元素也照收
  if (!isMapGesture(event, drag.dragging)) return
  const ended = dragEnd(drag)
  if (ended.gesture === drag) return // 未在拖动中
  drag = ended.gesture
  releaseCapture(event)
  if (!ended.clicked) return
  const local = toLocal(event)
  if (local === null) return
  const hit = hitAtLocal(local)
  if (hit !== null) emit('hexClick', hit.hex, hit.world)
}

/**
 * 指针被取消（系统手势 / 浏览器接管 / 指针设备失联）
 *
 * 与 `onPointerUp` 的区别：只复位，**不**判为单击。缺了这一路，`pointerup` 一旦收不到，
 * 拖动状态就会永久卡住（此后所有点选都被当成平移）。
 */
function onPointerCancel(event: PointerEvent): void {
  // 取消只复位：即使指针已经不在画布上（`target` 变了）也必须复位，故**不**过归属闸门
  const ended = dragCancel(drag)
  if (ended.gesture === drag) return
  drag = ended.gesture
  releaseCapture(event)
}

/** 释放指针捕获（捕获失败或已被系统释放时静默跳过） */
function releaseCapture(event: PointerEvent): void {
  const target = captureTarget()
  if (target === null) return
  try {
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  } catch {
    /* 未捕获成功时无需释放 */
  }
}

function onPointerLeave(): void {
  if (sameHex(hoverHex.value, null)) return
  hoverHex.value = null
  emit('hexHover', null)
}

/** 格号比较（对象坐标不便用 === 比） */
function sameHex(a: HexRef | null, b: HexRef | null): boolean {
  if (a === null || b === null) return a === b
  return a.col === b.col && a.row === b.row
}

/**
 * 格 → 视口内像素坐标（W7 C16：供地图小窗就近锚定、以及快捷键把光标处的格算出来）
 *
 * 与绘制共用同一份 `viewport`，故小窗不会与地图错位。
 */
function hexToLocal(hex: HexRef): { x: number; y: number } {
  return worldToScreen(hexCanvasPoint(hex), viewport.value)
}

/**
 * 格 → **窗口**像素坐标（`position: fixed` 的浮层用）
 *
 * 小窗（`MapPopover`）是 `position: fixed`，它的 `left/top` 是**相对窗口**的；
 * 而画布往往不在窗口原点（顶栏、侧栏、工具条都会挤开它）⇒ 直接拿视口内坐标当 fixed 坐标
 * 会让小窗整体偏掉一个容器偏移量。故这里加上容器的 `getBoundingClientRect()`。
 */
function hexToWindow(hex: HexRef): { x: number; y: number } {
  const local = hexToLocal(hex)
  const element = container.value
  if (element === null) return local
  const rect = element.getBoundingClientRect()
  return { x: local.x + rect.left, y: local.y + rect.top }
}

/** 供外部（对局台）调用的地图能力：缩放入口 + 格→像素换算（快捷键与地图小窗都用它） */
defineExpose({
  zoomIn: (): void => zoomByStep(1),
  zoomOut: (): void => zoomByStep(-1),
  fitToWindow,
  hexToLocal,
  hexToWindow,
  /** 视口尺寸（CSS 像素）——供覆盖层做上下避让，避免贴边被 `overflow: hidden` 裁掉 */
  viewportSize: (): Size => ({ ...viewSize.value }),
})

/* ── 生命周期 ── */

onMounted(() => {
  const element = container.value
  if (element !== null) {
    resizeObserver = new ResizeObserver(syncSize)
    resizeObserver.observe(element)
  }
  syncSize()

  // 模式/状态贴图、工事等级贴图与 5.0c 控制标记：量小且与盘面无关，启动时一次预载
  void counterImages
    .preload([...allMarkerTextureUrls(), ...allControlMarkerImageUrls()])
    .then(scheduleRender)

  void loadMapImage()
    .then((loaded) => {
      image.value = loaded
      imageLoading.value = false
      render()
    })
    .catch((error: unknown) => {
      imageLoading.value = false
      imageError.value = error instanceof Error ? error.message : '地图图片加载失败'
      render()
    })
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (pendingFrame !== 0) {
    cancelAnimationFrame(pendingFrame)
    pendingFrame = 0
  }
})

// 图层开关、高亮格、覆盖层变化 → 合并到下一帧重绘（deep watch 仍保留：覆盖层内部就地变更也不漏）
watch(() => props.layers, scheduleRender, { deep: true })
watch(() => props.highlightHex, scheduleRender)
watch(
  () => props.overlay,
  (overlay) => {
    // 算子图按需预载：先画（未就绪的走矢量回退），图到位后再补一帧换成真图
    if (overlay !== undefined && overlay !== null) {
      void preloadOverlayImages(overlay).then(scheduleRender)
    }
    scheduleRender()
  },
  { deep: true },
)

/** 缩放百分比（供工具条显示） */
const scalePercent = computed(() => Math.round(viewport.value.scale * 100))
</script>

<template>
  <div class="mapcanvas">
    <div
      ref="container"
      class="mapcanvas__viewport"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @pointerleave="onPointerLeave"
    >
      <canvas ref="canvas" class="mapcanvas__canvas" />

      <div class="mapcanvas__hud num">
        <span v-if="hoverHex !== null">{{ hoverHex.col }}.{{ hoverHex.row }}</span>
        <span v-else class="mapcanvas__muted">移入地图显示格号</span>
      </div>

      <p v-if="imageError !== null" class="mapcanvas__warn">
        地图图片未加载（{{ imageError }}）；矢量图层仍可正常查看。
      </p>
      <p v-else-if="imageLoading" class="mapcanvas__warn mapcanvas__warn--info">地图图片加载中…</p>

      <!--
        ★ B9：**就地一行提示**（用户口径「任何被拒的操作都在原地给一行规则号提示，不弹窗、不离开地图」）。
        文案与规则号由上层从 `workbench.mapHint`（`mapHintOf` 纯函数）传进来，画布不读 store。
      -->
      <p
        v-if="props.hint !== null"
        class="mapcanvas__hint"
        :class="`mapcanvas__hint--${props.hint.tone}`"
      >
        <span v-if="props.hint.rule !== null" class="mapcanvas__hint-rule num">
          {{ props.hint.rule }}
        </span>
        {{ props.hint.text }}
      </p>

      <!--
        覆盖层插槽（W7 C16：就地结算）
        插槽内容的定位**以本视口为参照**（`.mapcanvas__viewport` 是 position: relative），
        故调用方直接把 `hexToLocal(格)` 的结果当 left/top 用即可，不需要再做任何偏移换算。
      -->
      <slot name="overlay" />
    </div>

    <div class="mapcanvas__tools">
      <BaseButton variant="secondary" size="sm" @click="zoomByStep(-1)">缩小</BaseButton>
      <BaseButton variant="secondary" size="sm" @click="zoomByStep(1)">放大</BaseButton>
      <BaseButton variant="primary" size="sm" @click="fitToWindow">适应窗口</BaseButton>
      <input
        class="mapcanvas__slider"
        type="range"
        :min="MIN_SCALE"
        :max="MAX_SCALE"
        step="0.01"
        :value="viewport.scale"
        @input="onScaleInput"
      />
      <span class="num mapcanvas__percent">{{ scalePercent }}%</span>
      <span class="mapcanvas__hint"> 滚轮以光标为锚点缩放 · 左键拖拽平移 · 左键单击选格 </span>
    </div>
  </div>
</template>

<style scoped>
.mapcanvas {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.mapcanvas__viewport {
  position: relative;
  width: 100%;
  height: 72vh;
  min-height: 360px;
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  cursor: grab;
  touch-action: none;
}

.mapcanvas__viewport:active {
  cursor: grabbing;
}

.mapcanvas__canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.mapcanvas__hud {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  background: rgb(32 30 26 / 0.72);
  color: var(--color-bg);
  font-size: var(--text-xs);
  pointer-events: none;
}

.mapcanvas__muted {
  opacity: 0.7;
}

.mapcanvas__hint {
  /* 地图内就地一行提示（B9）：压在左下角（右下角留给 HUD），不拦指针 */
  position: absolute;
  left: var(--space-3);
  bottom: var(--space-3);
  margin: 0;
  max-width: min(520px, 90%);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: rgb(32 30 26 / 0.82);
  color: var(--color-bg);
  font-size: var(--text-xs);
  pointer-events: none;
}

.mapcanvas__hint--warning {
  border-color: var(--color-accent);
}

.mapcanvas__hint--danger {
  border-color: var(--color-danger);
}

.mapcanvas__hint-rule {
  margin-right: var(--space-2);
  opacity: 0.85;
}

.mapcanvas__warn {
  position: absolute;
  left: var(--space-3);
  top: var(--space-3);
  margin: 0;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-warning-bg);
  color: var(--color-warning);
  font-size: var(--text-xs);
}

.mapcanvas__warn--info {
  background: var(--color-info-bg);
  color: var(--color-info);
}

.mapcanvas__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.mapcanvas__slider {
  width: 180px;
}

.mapcanvas__percent {
  min-width: 48px;
  color: var(--color-muted);
  font-size: var(--text-xs);
}

.mapcanvas__hint {
  color: var(--color-muted);
  font-size: var(--text-xs);
}
</style>
