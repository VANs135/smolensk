<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import { BaseButton, BaseIcon } from '@/components/base'
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
import { BOARD_SIZE_PX, hexCanvasPoint, hexLineBetween, hitTestHex } from '@/render/map-layout'
// 军事沙盘：安卓壳把画布"桌面"填深色，与地图纸分层；桌面端不传、观感不变
import { isAndroidPlatform } from '@/shared/platform'
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
  type MapMarkerPiece,
} from '@/render/map-render'
import {
  allControlMarkerImageUrls,
  allMarkerTextureUrls,
  counterImages,
  tokenImageUrl,
} from '@/render/token-images'
import {
  overlayImageUrls,
  hitHexToken,
  TOKEN_SIZE_PX,
  type MovementOverlay,
} from '@/render/token-layer'
import {
  FIT_PADDING_PX,
  ZOOM_STEP,
  clampViewport,
  fitViewport,
  panBy,
  pinchViewport,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Size,
  type ViewportTransform,
} from '@/render/viewport'
// 触摸屏：长按＝右键、双指＝缩放（用户 2026-11-18 要求）；判定逻辑与其余面板共用一份
import {
  LONG_PRESS_MS,
  isTouchPointer,
  longPressMoved,
  suppressNextClick,
} from '@/shared/long-press'

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
    fill?: boolean
    /**
     * 画布底板色（没有规则含义，只决定地图纸外围那一圈是什么颜色）
     *
     * 缺省走 `MAP_PALETTE.board`（米白纸）；浅色主题与桌面端不传 ⇒ 观感不变。
     * 深色主题由对局台传深桌面色，免得地图四周留一圈白框（UI-5）。
     */
    boardColor?: string
    /** 图层开关（由上层持有，组件只读） */
    layers?: MapLayerVisibility
    /** 高亮格（如上层选中的格） */
    highlightHex?: HexRef | null
    /**
     * 多格高亮（用户裁定⑦：选单位时"高亮提示有可选单位的格子"；由上层算好传入）
     *
     * 与 `highlightHex` 同色；单格（悬停）叠在多格之上，互不替代。
     */
    highlightHexes?: readonly HexRef[]
    /**
     * 格上短标注（用户 2026-11-12：炮击付款时补给站格上要显示"该格有多少 SP"）
     *
     * 与 `highlightHex` 同族：由上层算好文本传入，画布只画，不读 store。
     */
    hexLabels?: readonly { hex: HexRef; text: string }[]
    /** 移动交互覆盖层（算子 / 可到达范围 / 预览路径；C5） */
    overlay?: MovementOverlay | null
    /**
     * 用户 2026-11-18：拖动中的**路径预览**回调（上层算好；画布只问"这一手落不落得下去"）
     *
     * 没给回调 / 返回 null ⇒ 不画路径线；`ok=false` ⇒ 只画路径线，**不画落位终点**。
     * 判据由状态层给（workbench 的纯预演），画布不读 store。
     */
    dragPathPreview?: ((path: readonly HexRef[]) => { ok: boolean } | null) | null
    boxDragSource?:
      | ((
          hex: HexRef,
          world: { x: number; y: number },
          scale: number,
        ) => { id: string; label: string; ids?: readonly string[] } | null)
      | null
    /**
     * H1：**地图内拖动源**（本次移动中的算子）
     *
     * 与 `boxDragSource` 分开：那个只回答"能不能拖进图外盒"，这里回答"能不能拖到另一格"。
     * 画布只按返回值起拖，不做任何规则判断。
     */
    counterDragSource?:
      | ((
          hex: HexRef,
          world: { x: number; y: number },
          scale: number,
        ) => { id: string; label: string; ids?: readonly string[] } | null)
      | null
    /**
     * H2：悬停预览的一行文本（上层算好；null = 无预览）
     *
     * 只读：画布把它拼进悬停提示，不据此改任何状态。
     */
    hoverPreview?: string | null
    /**
     * 地图内**就地一行提示**（B9；null = 无提示）
     *
     * 由上层从 `workbench.mapHint`（纯函数 `mapHintOf`）算出后传入——画布**不读 store**，
     * 保持"渲染层只画被给的东西"这条分层纪律（CODE_SPEC §2）。
     */
    hint?: MapHint | null
    /**
     * 专规 5.0c：**胜利格控制标记**（用户 2026-09-16 要求；由上层把"哪一格归谁"算好传进来）
     *
     * 与 `overlay` 分开：它是**地图事实**（不随会话开关变化），而且**不是算子**
     * ——不进命中测试、不可选中、不参与堆叠展开。
     */
    controlMarkers?: readonly ControlMarker[] | null
    /** B37 / 专规 3.4：装甲集群分界线（地图事实层；由上层算好传入） */
    boundary?: BoundaryLine | null
    /**
     * 专规 3.5：**建造标记**（桥 / 简易机场）——玩家放在格里的那几枚（地图事实层）
     *
     * 与 `controlMarkers` 同族：不是算子 ⇒ 不进命中测试、不可选中；由上层把
     * `workbench.constructionMarkerPieces` 传进来（画布不读 store）。
     */
    constructionMarkers?: readonly ConstructionMarkerPiece[] | null
    /**
     * 13.3d：**通用地图标记**（铁路端头 `mk-38` 等地图事实标记）
     *
     * 与 `controlMarkers` 同族：不是算子 ⇒ 不进命中测试、不可选中；由上层把
     * `mapView.railheadMarkers` 传进来（画布不读 store）。
     */
    markers?: readonly MapMarkerPiece[] | null
  }>(),
  {
    fill: false,
    boardColor: undefined,
    layers: () => ({ ...DEFAULT_MAP_LAYERS }),
    highlightHex: null,
    highlightHexes: () => [],
    hexLabels: () => [],
    overlay: null,
    dragPathPreview: null,
    boxDragSource: null,
    counterDragSource: null,
    hoverPreview: null,
    hint: null,
    controlMarkers: null,
    boundary: null,
    constructionMarkers: null,
    markers: null,
  },
)

const emit = defineEmits<{
  /**
   * 左键单击选中某格
   *
   * `world` 是这一击在**世界坐标**里的位置（与绘制同一份变换）。堆叠就地展开要靠它判"点到了哪一枚"
   * （B3），故由画布直接给出——视图那边只有窗口坐标，换算会多一份可能不同步的真相。
   */
  hexClick: [hex: HexRef, world: { x: number; y: number }, scale: number]
  /** 左键点在**图外空白**（没命中任何格）：与 Esc 一起作为待点格/选站态的退出 */
  blankClick: []
  hexContext: [
    hex: HexRef | null,
    world: { x: number; y: number },
    anchor: { x: number; y: number },
    scale: number,
  ]
  counterDrag: [id: string | null]
  /** 拖动被取消（系统接管 / 按钮位已松）：上层据此清掉这一手的选中环 */
  counterDragCancel: []
  /** 拖放算子：落点窗口坐标 + 落点格（图外为 null，供上层区分"盒"与"地图内落子"） */
  counterDrop: [
    id: string,
    point: { x: number; y: number },
    hex: HexRef | null,
    path: readonly HexRef[],
  ]
  /** H3：双击算子（格 / 世界坐标 / 比例；只报位置，动作由上层决定） */
  hexDblClick: [hex: HexRef, world: { x: number; y: number }, scale: number]
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

const hoverPoint = ref<{
  x: number
  y: number
  world: { x: number; y: number }
} | null>(null)

/**
 * 悬停提示：格号/令牌全称 + H2 的只读预览（两层用 `｜` 分行显示）
 *
 * 画布只读 `props.hoverPreview`，不读 store、不写任何状态。
 */
const hoverTip = computed<{ text: string; x: number; y: number } | null>(() => {
  const point = hoverPoint.value
  const hex = hoverHex.value
  if (point === null || hex === null) return null
  const base = tokenTipAt(hex, point.world) ?? `${hex.col}.${hex.row}`
  const preview = props.hoverPreview
  return {
    text: preview === null || preview === undefined ? base : `${base}｜${preview}`,
    x: point.x,
    y: point.y,
  }
})

/** 高清屏后备存储系数 */
const pixelRatio = computed(() =>
  typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
)

/** 是否已完成首次「适应窗口」 */
let fitted = false
/**
 * 用户是否手动缩放过 / 平移过
 *
 * 未手动前，容器尺寸变化（手机首屏地址栏收起、流程条换行、底部导航落位）必须**重新适配**；
 * 否则地图会停在按“挂载瞬间那个更小的视口”算出的位置，表现为上/下留一大块空白。
 * 用户一旦自己缩放过，就尊重其视口，不再自动拉回整图。
 */
let userAdjusted = false
let resizeObserver: ResizeObserver | null = null

/**
 * 拖拽状态
 *
 * ★ 判定全在纯模块 `render/drag-gesture.ts`（可单测）：本组件只持有状态并按返回值行事。
 *   「`pointerup` 丢失 ⇒ 由 `pointercancel` / 按钮位已松两条路复位」这条纪律在那边实现。
 */
let drag: DragGesture = IDLE_DRAG
let counterPress: {
  id: string
  label: string
  ids: readonly string[]
  x: number
  y: number
} | null = null

/* ── 触摸屏手势状态（鼠标路径完全不读这些） ── */

/** 当前按在画布上的触摸点（`pointerId → 客户端坐标`）；≥2 即转入双指 */
const touchPoints = new Map<number, { x: number; y: number }>()

/**
 * 双指捏合中的一段手势
 *
 * `viewport` 是**手势开始时**的视口：每帧都从它重算（而不是在上一帧结果上继续乘），
 * 否则缩放会按手指采样次数累积误差，捏一下就从 1 倍跳到 3 倍。
 */
let pinch: {
  ids: [number, number]
  startDistance: number
  anchor: { x: number; y: number }
  viewport: ViewportTransform
} | null = null

/** 长按计时器与其起点（触摸专用；判成后等同右键） */
let longPressTimer: number | null = null
let longPressStart: { x: number; y: number } | null = null
/** 本次手势已判成长按 ⇒ 抬起时不再算点击 */
let longPressFired = false
/** 上一次长按的时刻：WebView 有时会跟着补发 `contextmenu`，用它去重 */
let lastLongPressAt = 0

/** 双指距离小到无法判方向（两指几乎重合）时不起捏合 */
const PINCH_MIN_DISTANCE_PX = 12
/** 长按与 `contextmenu` 的去重窗口 */
const CONTEXT_DEDUPE_MS = 800

function midpoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 起长按计时（触摸）：位移超容差、抬手、系统取消都会作废它 */
function startLongPress(event: PointerEvent): void {
  cancelLongPress()
  longPressStart = { x: event.clientX, y: event.clientY }
  longPressTimer = window.setTimeout(() => {
    longPressTimer = null
    const start = longPressStart
    longPressStart = null
    if (start === null) return
    longPressFired = true
    lastLongPressAt = Date.now()
    /*
     * 长按的是「这一格要干嘛」，不是「拖这枚算子」⇒ 先把拖动的意图撤掉。
     *
     * ★ 这里**故意不复位 `drag`**：`drag` 一复位，抬起时 `dragEnd` 会走「未在拖动中」
     *   的早退分支，`longPressFired` 就没人消费、留到下一次点击上（表现为"长按过之后
     *   第一次点击没反应"）。让它保持 dragging，抬起时由 `longPressFired` 分支收尾。
     */
    if (counterPress !== null) abortCounterDrag()
    hoverPoint.value = null
    // 松手后浏览器仍可能补发 click；画布自己的点击在 pointerup 里由 longPressFired 拦
    suppressNextClick()
    emitContextAt(start)
  }, LONG_PRESS_MS)
}

function cancelLongPress(): void {
  if (longPressTimer !== null) {
    window.clearTimeout(longPressTimer)
    longPressTimer = null
  }
  longPressStart = null
}

/** 第二根手指落下 ⇒ 转入捏合，单指那一段手势（平移 / 拖子 / 长按）整体作废 */
function beginPinch(): void {
  const entries = [...touchPoints.values()]
  const ids = [...touchPoints.keys()]
  const a = entries[0]
  const b = entries[1]
  const firstId = ids[0]
  const secondId = ids[1]
  if (a === undefined || b === undefined || firstId === undefined || secondId === undefined) return
  cancelLongPress()
  if (counterPress !== null) abortCounterDrag()
  drag = IDLE_DRAG
  hoverPoint.value = null
  const anchor = toLocalOf(midpoint(a, b))
  if (anchor === null) return
  pinch = {
    ids: [firstId, secondId],
    startDistance: distanceBetween(a, b),
    anchor,
    viewport: { ...viewport.value },
  }
}

/** 捏合的一步：缩放比＝当前两指距离 ÷ 起始距离，同时把起始中点搬到当前中点（捏着走） */
function updatePinch(event: PointerEvent): void {
  if (pinch === null) return
  touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY })
  const a = touchPoints.get(pinch.ids[0])
  const b = touchPoints.get(pinch.ids[1])
  if (a === undefined || b === undefined) return
  if (pinch.startDistance < PINCH_MIN_DISTANCE_PX) return
  const target = toLocalOf(midpoint(a, b))
  if (target === null) return
  const factor = distanceBetween(a, b) / pinch.startDistance
  userAdjusted = true
  applyViewport(pinchViewport(pinch.viewport, pinch.anchor, target, factor))
}

/** 少于两指 ⇒ 捏合结束（此后仍按着的那根手指不承接成平移） */
function endPinchIfNeeded(): void {
  if (pinch === null) return
  if (touchPoints.size >= 2) return
  pinch = null
}
const counterGhost = ref<{
  id: string
  label: string
  ids: readonly string[]
  x: number
  y: number
} | null>(null)

/**
 * 用户 2026-11-18：拖动时**算子本体跟手**
 *
 * 画布只画被给的东西：从覆盖层的令牌表里按 id 找到这一枚，用与盘面相同的选图入口
 * （`tokenImageUrl`）给出图片；找不到图（未载入/设施无图）时退回原来的文字签。
 * 多选一次带走时在右下角标枚数，让玩家知道拖的是整组。
 */
const counterGhostToken = computed(() => {
  const ghost = counterGhost.value
  if (ghost === null || props.overlay === null || props.overlay === undefined) return null
  return props.overlay.tokens.find((token) => token.id === ghost.id) ?? null
})
const counterGhostUrl = computed(() => {
  const token = counterGhostToken.value
  return token === null ? null : tokenImageUrl(token)
})
const counterGhostSize = computed(() => TOKEN_SIZE_PX * viewport.value.scale)
/**
 * 拖动经过的格序列（含起点）
 *
 * 指针采样可能跳过中间格（快速拖动），故每次换格用 `hexLineBetween` 补全成相邻格序列，
 * 上层据此**逐步**判通行（用户 2026-11-18：不是直线飞到终点）。
 */
let counterDragPath: HexRef[] = []

/**
 * 拖动路径预览（用户 2026-11-18）
 *
 * `null` = 不画（还没拖动 / 只经过起点）；`ok=false` = 路径走不通（只画红线，不画终点）。
 * 画布只存上层给的结果，不自己判规则。
 */
let counterDragPreview: { path: readonly HexRef[]; ok: boolean } | null = null

/** 路径变化后向上层要一次预览（只读；上层用与落位同一套判据预演） */
function syncCounterDragPreview(): void {
  const preview = props.dragPathPreview
  if (preview == null || counterDragPath.length < 2) {
    if (counterDragPreview === null) return
    counterDragPreview = null
    scheduleRender()
    return
  }
  counterDragPreview = {
    path: counterDragPath.map((hex) => ({ ...hex })),
    ok: preview(counterDragPath)?.ok === true,
  }
  scheduleRender()
}

function clearCounterDrag(): void {
  counterPress = null
  counterDragPath = []
  if (counterDragPreview !== null) {
    counterDragPreview = null
    scheduleRender()
  }
  if (counterGhost.value !== null) emit('counterDrag', null)
  counterGhost.value = null
}

/** 拖动被取消（不是落子）：与 `clearCounterDrag` 分开，避免把成功落子也当成取消 */
function abortCounterDrag(): void {
  if (counterPress !== null) emit('counterDragCancel')
  clearCounterDrag()
}

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
    // 安卓军事沙盘：画布底板 = 沙盘桌面深色（地图扫描图仍是浅色纸张，浮于其上）
    // 2026-11-25（UI-5）：深色主题与安卓沙盘同一底色 ⇒ 地图外围不再出现一圈白板
    boardColor: isAndroidPlatform() ? '#141712' : props.boardColor,
    pixelRatio: ratio,
    layers: props.layers,
    image: image.value,
    highlightHex: props.highlightHex,
    highlightHexes: props.highlightHexes,
    hexLabels: props.hexLabels,
    overlay: props.overlay,
    dragPath: counterDragPreview,
    controlMarkers: props.controlMarkers,
    boundary: props.boundary,
    constructionMarkers: props.constructionMarkers,
    markers: props.markers,
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
  userAdjusted = false
  viewport.value = fitViewport(BOARD_SIZE_PX, viewSize.value, FIT_PADDING_PX)
  render()
}

/** 以视口中心为锚点放大/缩小一档 */
function zoomByStep(direction: 1 | -1): void {
  if (!canDraw(viewSize.value)) return
  userAdjusted = true
  const anchor = { x: viewSize.value.width / 2, y: viewSize.value.height / 2 }
  applyViewport(zoomAt(viewport.value, anchor, direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
}

/* ── 尺寸变化 ── */

/**
 * **绘制面**（canvas 自身）的 CSS 像素矩形
 *
 * ★ 修（2026-10-30）：原先两处都用**容器**（`.mapcanvas__viewport`）的 `getBoundingClientRect()`，
 *   而容器是 `border-box` 且带 `1px` 边框 ⇒ 它比画布的内容盒**宽高各多 2px**：
 *   ① 后备存储按 `viewSize × dpr` 分配、CSS 尺寸却是 `viewSize − 2` ⇒ 实际 DPR 比例偏差，
 *      离原点越远偏差越大，点击位置系统性右移/下移 1–3px（1:1 倍率下格高 109px，贴着格边点会点错格）；
 *   ② 点击换算用容器 `left/top`，同样多吃 1px 边框。
 *   统一到画布自身的矩形，两处变换共用同一块矩形就不再漂移。
 */
function surfaceRect(): DOMRect | null {
  const element = canvas.value
  return element === null ? null : element.getBoundingClientRect()
}

function syncSize(): void {
  const rect = surfaceRect()
  if (rect === null) return
  const width = Math.max(rect.width, 0)
  const height = Math.max(rect.height, 0)
  /*
   * 尺寸没变就**不重排、不重画**。
   *
   * 挂载期 `onMounted` 会同步调一次，`ResizeObserver` 随后还会补一次初始回调，两次报的是
   * 同一个尺寸；若每次都走 `fitToWindow()` / `applyViewport()`，整幅地图（两万多条格边）
   * 会被完整画两遍——首屏最贵的一笔。尺寸不变时 `clampViewport` 的结果也不变，故跳过等价。
   */
  if (fitted && viewSize.value.width === width && viewSize.value.height === height) return
  const sizeChanged = viewSize.value.width !== width || viewSize.value.height !== height
  viewSize.value = { width, height }
  if (!fitted && canDraw(viewSize.value)) {
    fitted = true
    fitToWindow()
    return
  }
  // 手机首屏布局会二次撑开（地址栏 / 流程条 / 底部导航）⇒ 未手动操作过就重新适配
  if (sizeChanged && !userAdjusted) {
    fitToWindow()
    return
  }
  applyViewport(viewport.value)
}

/* ── 输入 ── */

/** 事件坐标 → 视口内 CSS 像素坐标 */
function toLocal(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
  const rect = surfaceRect()
  if (rect === null) return null
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

/**
 * 同 `toLocal`，但吃的是**已经算好的 `{x,y}`**
 *
 * 触摸的捏合中点、长按起点都是自己算出来的点（不是事件对象），交给 `toLocal` 会被
 * 类型挡住——而换算规则必须只有一份（矩形取画布内容盒），故在此薄薄转一层。
 */
function toLocalOf(point: { x: number; y: number }): { x: number; y: number } | null {
  return toLocal({ clientX: point.x, clientY: point.y })
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

/**
 * 该格该点上那一枚令牌的**全称提示**（无 tip 或没命中 ⇒ null）
 *
 * 命中与绘制同源：格内常态摊开（≥2 枚走扇面布局 `stackFanLayout` / `hitStackFan`），
 * 单枚走折叠堆叠（`hitCollapsedToken`）——与右键菜单的命中（store 的 `counterForBoxAt`）一致。
 */
function tokenTipAt(hex: HexRef, world: { x: number; y: number }): string | null {
  const overlay = props.overlay
  if (overlay === null || overlay === undefined) return null
  const tokens = overlay.tokens.filter((token) => sameHex(token.hex, hex))
  if (tokens.length === 0) return null
  const expanded = overlay.expandedStack ?? null
  // 批 E：设施在左下角常显 ⇒ 命中统一走 `hitHexToken`（与 store 右键命中同源）
  const token = hitHexToken({
    hex,
    group: tokens,
    page: expanded !== null && sameHex(expanded.hex, hex) ? expanded.page : 0,
    point: world,
    scale: viewport.value.scale,
  })
  return token?.tip ?? null
}

function onWheel(event: WheelEvent): void {
  // B18a：浮层里滚轮（会话框内容区滚动）不归地图管——否则面板滚不动，地图反而缩放
  if (!isMapGesture(event)) return
  event.preventDefault()
  const local = toLocal(event)
  if (local === null) return
  userAdjusted = true
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
  /*
   * 触摸：先把这根手指登记下来。
   * 第二根落下 ⇒ 立刻转入双指捏合（这一段必须赶在 `drag.dragging` 的早退之前，
   * 否则第一根手指正在平移时第二根永远不会被认出来）。
   */
  if (isTouchPointer(event.pointerType)) {
    touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY })
    // 新手势开始 ⇒ 上一段遗留的"已长按"标记先清掉（否则这一次点击会被当成余波吞掉）
    if (touchPoints.size === 1) longPressFired = false
    if (touchPoints.size === 2) {
      if (!isMapGesture(event)) return
      beginPinch()
      return
    }
    if (touchPoints.size > 2) return
  }
  if (event.button !== 0) return
  // 多指：已在拖动中就直接忽略后续指针（否则第二根手指会替换整段手势，见 DragGesture.pointerId）
  if (drag.dragging) return
  if (!isMapGesture(event)) return
  hoverPoint.value = null
  const local = toLocal(event)
  const hit = local === null ? null : hitAtLocal(local)
  // 盒源优先（拖到图外盒）；没有盒入口时再看是不是"地图内可拖的算子"（H1）
  const source =
    hit === null
      ? null
      : (props.boxDragSource?.(hit.hex, hit.world, viewport.value.scale) ??
        props.counterDragSource?.(hit.hex, hit.world, viewport.value.scale) ??
        null)
  counterPress =
    source == null
      ? null
      : {
          id: source.id,
          label: source.label,
          ids: source.ids ?? [source.id],
          x: event.clientX,
          y: event.clientY,
        }
  counterDragPath = source == null || hit === null ? [] : [{ ...hit.hex }]
  drag = beginDrag({ x: event.clientX, y: event.clientY }, event.pointerId)
  // 触摸：起长按计时（判成＝右键；拖动 / 抬手都会作废它）
  if (isTouchPointer(event.pointerType)) startLongPress(event)
  // 指针捕获让「拖出画布」也能继续收到 pointermove。
  // 该 API 在指针已非活动时会抛错（快速点击 / 合成事件），故容错——否则拖动会卡住。
  try {
    captureTarget()?.setPointerCapture(event.pointerId)
  } catch {
    /* 捕获失败不影响拖动：指针移出画布时由 pointerleave 收尾 */
  }
}

function onPointerMove(event: PointerEvent): void {
  // 双指：捏合优先于一切单指逻辑（缩放 + 跟手平移）
  if (pinch !== null) {
    updatePinch(event)
    return
  }
  // 触摸：位移超出容差 ⇒ 这一手是拖动，不是长按
  if (
    longPressStart !== null &&
    longPressMoved(longPressStart, { x: event.clientX, y: event.clientY })
  )
    cancelLongPress()
  // 多指：只认发起这次手势的那一根指针（另一根的手指移动不得参与平移）
  if (drag.dragging && drag.pointerId !== null && event.pointerId !== drag.pointerId) return

  // 长按已经开出菜单：手指还没抬起，剩下的移动不再平移地图（菜单正开着，底下的图乱动只会让人点错）
  if (longPressFired) return
  // B18a：悬停在浮层上不该高亮下面的格；B24：拖动中（捕获会把 target 换成捕获元素）照旧算
  if (!isMapGesture(event, drag.dragging)) {
    hoverPoint.value = null
    return
  }
  const local = toLocal(event)
  if (local === null) return
  if (counterPress !== null) {
    hoverPoint.value = null
    if ((event.buttons & 1) === 0) {
      drag = IDLE_DRAG
      abortCounterDrag()
      releaseCapture(event)
    } else {
      // 记录拖动经过的格（换格时按六角直线补全，指针采样跳过中间格也不丢段）
      const overHex = hitAtLocal(local)?.hex ?? null
      let pathChanged = false
      if (overHex !== null) {
        const last = counterDragPath.at(-1)
        if (last === undefined) {
          counterDragPath = [{ ...overHex }]
          pathChanged = true
        } else if (last.col !== overHex.col || last.row !== overHex.row) {
          counterDragPath.push(...hexLineBetween(last, overHex).slice(1))
          pathChanged = true
        }
      }
      // 用户 2026-11-18：换格就刷新路径预览（走不通 ⇒ 终点不画）
      if (pathChanged) syncCounterDragPreview()
      if (
        counterGhost.value !== null ||
        Math.hypot(event.clientX - counterPress.x, event.clientY - counterPress.y) >= 5
      ) {
        if (counterGhost.value === null) emit('counterDrag', counterPress.id)
        drag = { ...drag, moved: true }
        counterGhost.value = {
          id: counterPress.id,
          label: counterPress.label,
          ids: counterPress.ids,
          ...local,
        }
      }
    }
    return
  }

  // ★ 拖动判定交纯模块：它负责「按钮位已松 ⇒ 就地复位」这条异常路径（`pointerup` 可能收不到）
  const step = dragMove(drag, { x: event.clientX, y: event.clientY }, event.buttons)
  if (step.kind === 'aborted') drag = step.gesture
  else if (step.kind === 'pan') {
    drag = step.gesture
    userAdjusted = true
    applyViewport(panBy(viewport.value, step.dx, step.dy))
  }

  const hit = drag.dragging ? null : hitAtLocal(local)
  const hex = hit?.hex ?? null
  if (!sameHex(hoverHex.value, hex)) {
    hoverHex.value = hex
    emit('hexHover', hex)
  }
  // 拖动中不出提示（否则提示会跟着平移乱飞）
  // 条 25（D2）：悬停投影 —— 有令牌给令牌全称；空格回落成格号 `col.row`（点格不再弹只读浮签）
  // H2：文本现算（`hoverTip`），这里只记指针位置 ⇒ 上层预览变化时能原地刷新。
  // 触摸屏没有"悬停"：手指按着时不出浮签（否则松手后浮签会停在原地，看着像卡住了）
  hoverPoint.value =
    hit === null || isTouchPointer(event.pointerType)
      ? null
      : { x: local.x, y: local.y, world: hit.world }
}

function onPointerUp(event: PointerEvent): void {
  if (isTouchPointer(event.pointerType)) {
    touchPoints.delete(event.pointerId)
    // 捏合中抬手 ⇒ 只收起捏合，绝不当成"点了一下"
    if (pinch !== null) {
      endPinchIfNeeded()
      return
    }
  }
  cancelLongPress()
  // 多指：别的指针抬起不算"本次手势结束"（否则会判一次单击、并把还在屏上的手势作废）
  if (drag.dragging && drag.pointerId !== null && event.pointerId !== drag.pointerId) return
  // B24：抬起这一击属于"已在画布上按下"的那段手势 ⇒ 即便 target 被捕获改成别的元素也照收
  if (!isMapGesture(event, drag.dragging)) return
  const ended = dragEnd(drag)
  if (ended.gesture === drag) return // 未在拖动中
  drag = ended.gesture
  const counter = counterPress
  releaseCapture(event)
  hoverPoint.value = null
  /*
   * 触摸长按已经开过菜单 ⇒ 这一次抬起不再算点击。
   * 不清 `counterPress` 会留下幽灵手势（下次按下就被它抢走），故照常收尾再返回。
   */
  if (longPressFired) {
    longPressFired = false
    clearCounterDrag()
    return
  }
  if (counter !== null && !ended.clicked) {
    // H1：落点格随拖放一起给出（图外为 null）——上层据此区分"进盒"与"地图内落子"
    const dropLocal = toLocal(event)
    const dropHex = dropLocal === null ? null : (hitAtLocal(dropLocal)?.hex ?? null)
    // 拖动路径以落点格收尾（指针最后一次采样可能还没走到落点）
    if (dropHex !== null) {
      const last = counterDragPath.at(-1)
      if (last === undefined) counterDragPath = [{ ...dropHex }]
      else if (last.col !== dropHex.col || last.row !== dropHex.row)
        counterDragPath.push(...hexLineBetween(last, dropHex).slice(1))
    }
    emit('counterDrop', counter.id, { x: event.clientX, y: event.clientY }, dropHex, [
      ...counterDragPath,
    ])
  }
  clearCounterDrag()
  if (!ended.clicked) return
  const local = toLocal(event)
  if (local === null) return
  const hit = hitAtLocal(local)
  if (hit !== null) emit('hexClick', hit.hex, hit.world, viewport.value.scale)
  else emit('blankClick')
}

/** 在某个客户端坐标上喊出「右键这里」（鼠标右键与触摸长按共用同一条出口） */
function emitContextAt(point: { x: number; y: number }): void {
  const local = toLocalOf(point)
  if (local === null) return
  const world = screenToWorld(local, viewport.value)
  emit(
    'hexContext',
    hitTestHex(world.x, world.y)?.hex ?? null,
    world,
    { x: point.x, y: point.y },
    viewport.value.scale,
  )
}

function onContextMenu(event: MouseEvent): void {
  if (!props.fill || !isMapGestureTarget(event.target, canvas.value)) return
  event.preventDefault()
  /*
   * 触摸长按刚开过菜单：部分 WebView 会在长按后再补发一次 `contextmenu`，
   * 不去重就会把同一个菜单连开两次（第二次看着像"点不动"）。
   */
  if (Date.now() - lastLongPressAt < CONTEXT_DEDUPE_MS) return
  emitContextAt({ x: event.clientX, y: event.clientY })
}

/**
 * 指针被取消（系统手势 / 浏览器接管 / 指针设备失联）
 *
 * 与 `onPointerUp` 的区别：只复位，**不**判为单击。缺了这一路，`pointerup` 一旦收不到，
 * 拖动状态就会永久卡住（此后所有点选都被当成平移）。
 */
function onPointerCancel(event: PointerEvent): void {
  // 触摸：这根手指没了 ⇒ 退出登记（否则下一次按下会被当成"第二根手指"直接进捏合）
  if (isTouchPointer(event.pointerType)) {
    touchPoints.delete(event.pointerId)
    endPinchIfNeeded()
  }
  cancelLongPress()
  // 多指：别的指针被取消不该把这一段手势一起作废（否则仍在屏上的那根手指拖不动）
  if (drag.dragging && drag.pointerId !== null && event.pointerId !== drag.pointerId) return
  // 取消只复位：即使指针已经不在画布上（`target` 变了）也必须复位，故**不**过归属闸门
  const ended = dragCancel(drag)
  if (ended.gesture === drag) return
  drag = ended.gesture
  hoverPoint.value = null
  abortCounterDrag()
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
  hoverPoint.value = null
  if (sameHex(hoverHex.value, null)) return
  hoverHex.value = null
  emit('hexHover', null)
}

/**
 * H3：双击算子 —— 只把"双击落在哪"报给上层（画布不做动作判断）
 *
 * 单击已由 `onHexClick` 处理；这里不重复触发单击动作，只补充 dblclick 这一层。
 */
function onDoubleClick(event: MouseEvent): void {
  const local = toLocal(event)
  if (local === null) return
  const hit = hitAtLocal(local)
  if (hit === null) return
  emit('hexDblClick', hit.hex, hit.world, viewport.value.scale)
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
  // 与 `toLocal` 同一块矩形（画布内容盒）；画布未挂载时才退回容器
  const rect = surfaceRect() ?? container.value?.getBoundingClientRect() ?? null
  if (rect === null) return local
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

  // 模式/状态贴图、工事等级贴图与 专规 5.0c 控制标记：量小且与盘面无关，启动时一次预载
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
watch(() => props.boardColor, scheduleRender)
watch(() => props.highlightHex, scheduleRender)
watch(() => props.highlightHexes, scheduleRender)
watch(() => props.hexLabels, scheduleRender)
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
  <div class="mapcanvas" :class="{ 'mapcanvas--fill': props.fill }">
    <div
      ref="container"
      class="mapcanvas__viewport"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @pointerleave="onPointerLeave"
      @dblclick="onDoubleClick"
      @contextmenu="onContextMenu"
    >
      <canvas ref="canvas" class="mapcanvas__canvas" />

      <!-- 悬停全称与关键信息（`UnitToken.tip`；多条用「｜」分隔，逐行浮现） -->
      <div
        v-if="hoverTip !== null"
        class="mapcanvas__tip"
        role="tooltip"
        :style="{ left: hoverTip.x + 'px', top: hoverTip.y + 'px' }"
      >
        <span
          v-for="(line, index) in hoverTip.text.split('｜')"
          :key="index"
          class="mapcanvas__tip-line"
          :class="{ 'mapcanvas__tip-line--head': index === 0 }"
          >{{ line }}</span
        >
      </div>

      <div v-if="!props.fill" class="mapcanvas__hud num">
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
      <span
        v-if="counterGhost !== null"
        class="mapcanvas__counter-ghost"
        :class="{ 'mapcanvas__counter-ghost--image': counterGhostUrl !== null }"
        :style="{ left: counterGhost.x + 'px', top: counterGhost.y + 'px' }"
        aria-hidden="true"
      >
        <img
          v-if="counterGhostUrl !== null"
          class="mapcanvas__counter-ghost-img"
          :src="counterGhostUrl"
          :style="{ width: counterGhostSize + 'px', height: counterGhostSize + 'px' }"
          alt=""
          draggable="false"
        />
        <template v-else>{{ counterGhost.label }}</template>
        <span v-if="counterGhost.ids.length > 1" class="mapcanvas__counter-ghost-count num"
          >×{{ counterGhost.ids.length }}</span
        >
      </span>
    </div>

    <div class="mapcanvas__tools" aria-label="地图视口">
      <span v-if="props.fill" class="mapcanvas__coord num">
        {{ hoverHex === null ? '格 —' : '格 ' + hoverHex.col + '.' + hoverHex.row }}
      </span>
      <BaseButton
        variant="secondary"
        size="sm"
        aria-label="缩小"
        title="缩小 −"
        @click="zoomByStep(-1)"
      >
        <BaseIcon name="minus" />
        <span v-if="!props.fill">缩小</span>
      </BaseButton>
      <BaseButton
        variant="secondary"
        size="sm"
        aria-label="放大"
        title="放大 +"
        @click="zoomByStep(1)"
      >
        <BaseIcon name="plus" />
        <span v-if="!props.fill">放大</span>
      </BaseButton>
      <BaseButton variant="secondary" size="sm" title="适应窗口 0" @click="fitToWindow">
        {{ props.fill ? '全图' : '适应窗口' }}
      </BaseButton>
      <span class="num mapcanvas__percent">{{ scalePercent }}%</span>
      <span v-if="!props.fill" class="mapcanvas__legend">滚轮缩放 · 拖动平移 · 单击选格</span>
    </div>
  </div>
</template>

<style scoped>
.mapcanvas__counter-ghost {
  position: absolute;
  z-index: var(--layer-map-popup);
  transform: translate(var(--space-2), var(--space-2));
  pointer-events: none;
  border: 1px solid var(--color-command-teal);
  border-radius: var(--radius-sm);
  background: var(--color-command-bg);
  color: var(--color-command-ink);
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-xs);
}

/* 用户 2026-11-18：拖动时算子本体跟手（图压在光标中心，去掉文字签的外框） */
.mapcanvas__counter-ghost--image {
  transform: translate(-50%, -50%);
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0;
  line-height: 0;
}
.mapcanvas__counter-ghost-img {
  display: block;
  object-fit: contain;
  opacity: 0.92;
  filter: drop-shadow(0 2px 6px rgb(0 0 0 / 45%));
}
.mapcanvas__counter-ghost-count {
  position: absolute;
  right: -6px;
  bottom: -6px;
  min-width: 18px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--color-command-teal);
  color: var(--color-command-bg);
  font-size: var(--text-xs);
  line-height: 18px;
  text-align: center;
}

/* 悬停全称：贴着光标上方，不吃指针事件（否则会打断地图拖动） */
.mapcanvas__tip {
  position: absolute;
  z-index: var(--layer-map-popup);
  transform: translate(-50%, calc(-100% - 8px));
  pointer-events: none;
  max-width: 240px;
  padding: 2px 8px;
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-sm);
  background: var(--color-command-bg);
  color: var(--color-command-ink);
  font-size: var(--text-xs);
  line-height: 1.35;
  white-space: normal;
}
.mapcanvas__tip-line {
  display: block;
}
.mapcanvas__tip-line--head {
  font-weight: 600;
}
.mapcanvas {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.mapcanvas--fill {
  height: 100%;
  gap: 0;
}

.mapcanvas--fill .mapcanvas__viewport {
  flex: 1 1 auto;
  height: auto;
  min-height: 0;
  border: 0;
  border-radius: 0;
}

.mapcanvas--fill .mapcanvas__tools {
  flex: none;
  min-height: var(--space-10);
  padding: var(--space-1) var(--space-3);
  border-top: 1px solid var(--color-rule);
  background: var(--color-panel);
}

.mapcanvas__coord {
  margin-right: auto;
  color: var(--color-muted);
  font-size: var(--text-sm);
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
  /* 手势全归本组件：双击缩放 / 双指缩放 / 长按选择都不得由浏览器接管 */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
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
  color: var(--color-command-ink);
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
  color: var(--color-command-ink);
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

.mapcanvas__percent {
  min-width: 48px;
  color: var(--color-muted);
  font-size: var(--text-xs);
}

.mapcanvas__legend {
  color: var(--color-muted);
  font-size: var(--text-xs);
}
</style>
