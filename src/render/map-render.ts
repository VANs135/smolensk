import { mapLayers } from '@/data'
import type { HexRef } from '@/data'

import {
  CALIBRATION_CANVAS_OFFSET,
  CALIBRATION_ORIGIN,
  HEX_COL_SPACING_PX,
  HEX_RADIUS_PX,
  HEX_ROW_SPACING_PX,
  hexCanvasCorners,
  hexCanvasPoint,
  hexsideCanvasSegment,
  isBoardHex,
} from './map-layout'
import { counterImages, controlMarkerImageUrl, hedgehogTextureUrl } from './token-images'
import {
  expandRect,
  visibleWorldRect,
  type Rect,
  type Size,
  type ViewportTransform,
} from './viewport'
import { drawMovementOverlay, overlayHexKey, type MovementOverlay } from './token-layer'

/**
 * 地图绘制（C2 地图渲染与视口）——Canvas 2D，纯绘制 + 只读数据
 *
 * 分层（自下而上，与 OCS 地图的印刷层次一致）：
 *   ① 底板底色 → ② 地图扫描图 → ③ 六角网格 → ④ 格边要素（河/湖、道路、铁路）
 *   → ⑤ 印刷永久工事 → ⑥ 格号标注 → ⑦ 高亮格
 *
 * 两条硬约束：
 *   · **不改状态、不做规则判断**（CODE_SPEC §3.1）：坐标全部来自 `map-layout` 的标定公式，
 *     要素全部来自 `map-layers.json`，本模块不新增任何几何尺寸或规则数值；
 *   · **视口裁剪**：只画落在视口内的格 / 格边 / 工事（`visibleHexes` 等），
 *     2156 格整幅重绘在拖动时会掉帧（见 tests/render/map-render.test.ts 的收敛性断言）。
 *
 * 高清屏：画布后备存储按 `pixelRatio` 放大，绘制变换最外层乘同一个系数，
 * 故本模块内一切坐标仍是 CSS 像素，线宽/字号只需再除以 `scale` 即为「屏幕恒定粗细」。
 */

/** 地图扫描图（沿用素材库原文件名，CODE_SPEC §4） */
export const MAP_IMAGE_SRC = '/map/Smolensk-map-011717.png'

/**
 * 地图图片在**世界坐标**中的左上角
 *
 * 扫描图像素坐标 = 标定坐标（`map-config.geometry` 由该图的格心反求），
 * 故整幅图直接以「标定原点 → 画布坐标」的偏移铺放，无需逐格贴片。
 */
export const MAP_IMAGE_ORIGIN = CALIBRATION_CANVAS_OFFSET

/**
 * 格号标注的最小缩放倍率
 *
 * 「36.13」这类格号在屏幕上约 30px 宽，故需要格宽（世界 94.905px）至少放到 ~35px 才排得下；
 * 0.45 对应格宽约 43px，留出余量。更低倍率下扫描图本身已印有格号，且悬停时右下角会显示格号，
 * 故直接不画——否则 2156 个格号会把整幅图糊成一片。
 */
export const LABEL_MIN_SCALE = 0.45

/** 格号在**屏幕上**的字号（像素）；绘制时除以 scale 换算回世界单位 */
export const LABEL_FONT_SCREEN_PX = 10

/** 网格线在屏幕上的线宽（像素） */
export const GRID_LINE_SCREEN_PX = 1

/**
 * 工事贴图的**显示比例**（相对外接圆半径 R）
 *
 * 用户 2026-09-16 #2：工事压在最上层 ⇒ 不能把堆叠盖死（盖住就点不到）。0.7 是「一眼看见」
 * 与「不挡印值」之间的取值（原 0.86 且居中，改后缩到 0.7 并移到右上角内沿）。
 */
export const HEDGEHOG_TEXTURE_RATIO = 0.7

/** 工事贴图/角标相对格心偏移（沿右上 45° 方向，单位＝R 的倍数） */
export const HEDGEHOG_CORNER_OFFSET = 0.42

/** 工事贴图不透明度（半透明，让下面的算子轮廓仍可辨） */
export const HEDGEHOG_TEXTURE_ALPHA = 0.92

/**
 * 专规 3.5：**建造标记**（桥 / 简易机场）角标的显示比例（相对外接圆半径 R）
 *
 * 角标位置沿用同一套"四角内沿"纪律：工事在**右上**、控制标记在**左上**、建造标记在**左下**
 * ⇒ 三者可在同一格共存而不打架，也不盖住堆叠的印值（盖住就点不到）。
 */
export const CONSTRUCTION_MARKER_RATIO = 0.42

/** 建造标记角标相对格心的偏移方向（左下 45°；单位＝R 的倍数，与工事/控制标记同量级） */
export const CONSTRUCTION_MARKER_CORNER = { x: -0.42, y: 0.42 } as const

/** 专规 3.5：地图上要画的**建造标记**（桥 / 简易机场；已放置的那几枚） */
export interface ConstructionMarkerPiece {
  kind: 'bridge' | 'airStrip'
  hex: HexRef
}

/** 建造标记的屏幕角标（纯数据，供绘制与测试共用） */
export interface ConstructionMarkerBadge {
  kind: 'bridge' | 'airStrip'
  hex: HexRef
  /** 角标中心（世界＝画布坐标，与其它图层同口径） */
  center: { x: number; y: number }
  /** 角标边长（世界单位） */
  side: number
}

/**
 * 5.0c：**控制标记**的显示比例（相对外接圆半径 R）
 *
 * 与工事同一套纪律（不盖住堆叠印值），但**位置相反**（工事在右上、它把在左上）⇒
 * 两枚标记可以同格共存而不打架。取值比工事略小：它是"归属"的提示，不必抢印值的位置。
 */
export const CONTROL_MARKER_RATIO = 0.6

/**
 * 地图绘制的**图层顺序**（自下而上）—— 唯一出处
 *
 * 用户 2026-09-16 #2 的两条要求落在这里：
 *   · 「工事贴图要显示在**堆叠最上层**」⇒ `printedHedgehogs` 排在 `tokens` 之后；
 *   · 「给单位标状态的贴图要显示在**该单位图片上层**」⇒ `statusTextures` 是算子之后的一层
 *     （实现见 `token-layer.drawTokenStatusTextures`）。
 * 测试按本常量断言，避免"层次被人改回去而没人发现"。
 */
export const MAP_LAYER_ORDER = [
  'base',
  'image',
  'grid',
  'edges',
  'labels',
  'highlight',
  'tokens',
  'printedHedgehogs',
  'statusTextures',
  'controlMarkers',
  'constructionMarkers',
] as const

/** 格边要素在屏幕上的线宽（像素） */
/** B37 / 3.4：分界线的屏幕线宽与虚线节律（呈现用，无规则含义） */
export const BOUNDARY_LINE_SCREEN_PX = 3
export const BOUNDARY_DASH_SCREEN_PX = [8, 5] as const

export const RIVER_LINE_SCREEN_PX = 2.4
export const ROAD_LINE_SCREEN_PX = 1.6
export const RAIL_LINE_SCREEN_PX = 1.6

/** 铁路虚线的「实/空」长度（屏幕像素） */
export const RAIL_DASH_SCREEN_PX = [5, 4] as const

/**
 * 画布配色（呈现用，无规则含义）
 *
 * Canvas 读不到 CSS 变量，故这组值在渲染层集中一处，与 `styles/tokens.css` 同名色保持一致；
 * 业务上不得据此判读任何规则状态。
 */
export const MAP_PALETTE = {
  board: '#f6f4ee',
  grid: '#c9c3b4',
  label: '#201e1a',
  labelHalo: 'rgba(255, 255, 255, 0.85)',
  river: '#3d6b8a',
  road: '#8a6420',
  rail: '#4a4a4a',
  /** B37：装甲集群分界线（专规 3.4；取与"警示"同族的暖色，别与河/路/铁混淆） */
  boundary: '#a2451f',
  hedgehog: '#46604c',
  highlight: '#8c2f22',
  /** 5.0c 控制标记的**回退色**（贴图未就绪时用）：苏 = 深红、轴 = 深蓝（与官方标记的观感一致） */
  controlSoviet: '#8c2f22',
  controlAxis: '#2f4a6b',
  /** 专规 3.5 建造标记的回退色：桥 = 木色、简易机场 = 草绿（与河/路/工事都不同族） */
  constructionBridge: '#7a4a1d',
  constructionAirStrip: '#3f6b3a',
} as const

/** 图层开关 */
export interface MapLayerVisibility {
  /** 地图扫描图 */
  image: boolean
  /** 六角网格线 */
  grid: boolean
  /** 格号标注 */
  labels: boolean
  /** 格边要素：河流/湖泊、道路、铁路 */
  edges: boolean
  /** 地图印刷永久工事（专规 1.3a） */
  hedgehogs: boolean
  /** 胜利格**控制标记**（5.0c；B18+ 用户要求用官方标记） */
  control: boolean
  /** 专规 3.5：**建造标记**（桥 / 简易机场）——玩家放下的那几枚 */
  constructionMarkers: boolean
}

/** 默认图层：扫描图本身已印有网格，故网格默认关闭、格号默认开启（缩放时按屏幕字号重画） */
export const DEFAULT_MAP_LAYERS: MapLayerVisibility = {
  image: true,
  grid: false,
  labels: true,
  edges: true,
  hedgehogs: true,
  // 控制标记是"谁的"这一条规则事实 ⇒ 默认开着（与工事同理）
  control: true,
  // 专规 3.5 的建造标记是玩家自己放的、会改变地形取费的事实 ⇒ 默认开着
  constructionMarkers: true,
}

/**
 * 载入地图扫描图
 *
 * 失败即 reject（调用方转成界面提示）。不设 crossOrigin：同源静态资源，走浏览器缓存。
 */
export function loadMapImage(): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`地图图片加载失败：${MAP_IMAGE_SRC}`))
    image.src = MAP_IMAGE_SRC
  })
}

/** 视口可见的世界矩形，外扩一格半径（保证压边的格也画出来，不留缺口） */
export function visibleWorldRectWithMargin(viewport: ViewportTransform, viewSize: Size): Rect {
  return expandRect(visibleWorldRect(viewport, viewSize), HEX_RADIUS_PX)
}

/**
 * 视口裁剪：只返回可能出现在视口内的**图内格**
 *
 * 不遍历 2156 格：先由标定公式把可见世界矩形反算成列/行窗口，再在窗口内逐格做精确判定。
 * 列窗口是闭式的（列只与 x 有关）；行窗口按奇偶列各留一格余量（even-q 的半格错位）。
 */
export function visibleHexes(viewport: ViewportTransform, viewSize: Size): HexRef[] {
  const rect = visibleWorldRectWithMargin(viewport, viewSize)
  const { x: offsetX, y: offsetY } = CALIBRATION_CANVAS_OFFSET

  // 世界 → 标定坐标
  const calibrationMinX = rect.x - offsetX
  const calibrationMaxX = rect.x + rect.width - offsetX
  const calibrationMinY = rect.y - offsetY
  const calibrationMaxY = rect.y + rect.height - offsetY

  const columnFrom = Math.floor((calibrationMinX - CALIBRATION_ORIGIN.x) / HEX_COL_SPACING_PX) + 1
  const columnTo = Math.ceil((calibrationMaxX - CALIBRATION_ORIGIN.x) / HEX_COL_SPACING_PX) + 1

  // 行号随标定 y 减小而增大；偶列整体下移半格，故行窗口按最坏情况放宽 2 行
  const rowFrom = Math.floor((CALIBRATION_ORIGIN.y - calibrationMaxY) / HEX_ROW_SPACING_PX) - 2
  const rowTo = Math.ceil((CALIBRATION_ORIGIN.y - calibrationMinY) / HEX_ROW_SPACING_PX) + 2

  const result: HexRef[] = []
  for (let col = columnFrom; col <= columnTo; col += 1) {
    for (let row = rowFrom; row <= rowTo; row += 1) {
      const hex = { col, row }
      if (!isBoardHex(hex)) continue
      const center = hexCanvasPoint(hex)
      if (center.x < rect.x || center.x > rect.x + rect.width) continue
      if (center.y < rect.y || center.y > rect.y + rect.height) continue
      result.push(hex)
    }
  }
  return result
}

/** 视口裁剪：只返回与视口相交的格边要素（端点格心或边中点落在可见范围内即可） */
export function visibleEdges(viewport: ViewportTransform, viewSize: Size): typeof mapLayers.edges {
  const rect = visibleWorldRectWithMargin(viewport, viewSize)
  const inside = (point: { x: number; y: number }): boolean =>
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height

  return mapLayers.edges.filter((edge) => {
    const centerA = hexCanvasPoint(edge.a)
    const centerB = hexCanvasPoint(edge.b)
    if (inside(centerA) || inside(centerB)) return true
    return inside({ x: (centerA.x + centerB.x) / 2, y: (centerA.y + centerB.y) / 2 })
  })
}

/** 视口裁剪：只返回与视口相交的印刷永久工事 */
export function visiblePrintedHedgehogs(
  viewport: ViewportTransform,
  viewSize: Size,
): typeof mapLayers.printedHedgehogs {
  const rect = visibleWorldRectWithMargin(viewport, viewSize)
  return mapLayers.printedHedgehogs.filter((item) => {
    const center = hexCanvasPoint({ col: item.col, row: item.row })
    return (
      center.x >= rect.x &&
      center.x <= rect.x + rect.width &&
      center.y >= rect.y &&
      center.y <= rect.y + rect.height
    )
  })
}

/** 绘制选项 */
export interface MapRenderOptions {
  /** 视口变换（`render/viewport.ts`） */
  viewport: ViewportTransform
  /** 视口尺寸（CSS 像素） */
  viewSize: Size
  /** 设备像素比（默认 1；高清屏由组件传 window.devicePixelRatio） */
  pixelRatio?: number
  /** 图层开关（缺省项按 DEFAULT_MAP_LAYERS 补齐） */
  layers?: Partial<MapLayerVisibility>
  /** 已载入的地图扫描图；为 null 则跳过图片图层 */
  image?: HTMLImageElement | null
  /** 高亮格（悬停/选中）；null 表示无 */
  highlightHex?: HexRef | null
  /** 移动交互覆盖层（算子、可到达范围、预览路径；C5）；null 表示只画地图 */
  overlay?: MovementOverlay | null
  /**
   * 5.0c：**胜利格控制标记**（B18+ 用户要求）——每格一枚官方控制标记，按控制方翻面
   *
   * 数据由状态层给（`mapView.controlMarkers`，来源是"胜利格 + 该格此刻的控制方"）。
   * 本层**只画**：它钉死在胜利格上（不是算子 ⇒ 不可选中、不参与命中测试与堆叠展开）。
   */
  controlMarkers?: readonly ControlMarker[] | null
  /**
   * B37 / 3.4：**装甲集群分界线**（用户口径 #14「画装甲集群分界线」）
   *
   * 与 `controlMarkers` 同族：**地图事实**（不随会话开关变化、不是算子、不进命中测试）。
   * 数据由状态层给（`mapView.boundary`），本层只画线，并给"站错一侧"的格加一圈提示。
   */
  boundary?: BoundaryLine | null
  /**
   * 专规 3.5：**建造标记**（桥 / 简易机场）——玩家放在格里的那几枚
   *
   * 与 `controlMarkers`/`boundary` 同族：**地图事实**（不是算子 ⇒ 不可选中、不进命中测试）。
   * 修前它只列在专规面板里（`ExclusiveRulesPanel` 的几行文字），**地图上看不见** ⇒
   * 玩家放完标记就失去了唯一的空间参照（"这枚桥到底在哪一格"）。
   */
  constructionMarkers?: readonly ConstructionMarkerPiece[] | null
}

/**
 * 装甲集群分界线（专规 3.4）
 *
 * `from`/`to` ＝ 分界线两端（产品数据给定的两格）；
 * `path` ＝ **沿多轨铁路的折线**（`west → … → east` 的格序列）——**线画的就是它**。
 *   修前画的是两端格心之间的一条**直线**，而原文写的是「分界线为 19.19 → 62.23 的**多轨铁路线**」。
 * `wrongSideHexes` ＝ 落在**错误一侧**的单位所在格（提示用；结论由引擎 `panzerGroupObligations` 给）。
 */
export interface BoundaryLine {
  from: HexRef
  to: HexRef
  /** 沿多轨铁路的折线（缺省时退回两端点直线 —— 只服务旧夹具 / 纯函数调用点） */
  path?: readonly HexRef[]
  wrongSideHexes?: readonly HexRef[]
}

/**
 * 分界线的**画布折点**（纯函数：渲染与测试共用同一份换算，不各写一遍）
 *
 * ★ 批 F 切片 1：有 `path` 时给**折线**（每个路径格心一个点）；没有路径时退回两端点连线。
 * 两条支路都走 `hexCanvasPoint`，故"格心 → 画布"这一处换算仍然只有一个实现。
 */
export function boundaryLinePoints(line: BoundaryLine): readonly { x: number; y: number }[] {
  const hexes = line.path !== undefined && line.path.length >= 2 ? line.path : [line.from, line.to]
  return hexes.map((hex) => hexCanvasPoint(hex))
}

/** 胜利格上的一枚控制标记（画哪一面由 `side` 决定） */
export interface ControlMarker {
  hex: HexRef
  side: 'axis' | 'soviet'
}

/** 沿六角格 6 个顶点描一条闭合路径（世界坐标） */
function traceHexPath(ctx: CanvasRenderingContext2D, hex: HexRef): void {
  const corners = hexCanvasCorners(hex)
  ctx.beginPath()
  corners.forEach((corner, index) => {
    if (index === 0) ctx.moveTo(corner.x, corner.y)
    else ctx.lineTo(corner.x, corner.y)
  })
  ctx.closePath()
}

/** 描一条格边（世界坐标） */
function drawHexside(
  ctx: CanvasRenderingContext2D,
  a: HexRef,
  b: HexRef,
  color: string,
  screenWidth: number,
  scale: number,
  dashScreenPx: readonly number[] = [],
): void {
  const segment = hexsideCanvasSegment(a, b)
  if (segment === null) return
  ctx.strokeStyle = color
  ctx.lineWidth = screenWidth / scale
  ctx.setLineDash(dashScreenPx.map((value) => value / scale))
  ctx.beginPath()
  ctx.moveTo(segment.from.x, segment.from.y)
  ctx.lineTo(segment.to.x, segment.to.y)
  ctx.stroke()
  ctx.setLineDash([])
}

/**
 * 绘制整幅地图（含视口裁剪）
 *
 * 调用方负责：把 canvas 后备存储尺寸设为 `viewSize × pixelRatio`。
 * 本函数只设变换与绘制，不改任何状态。
 */
export function drawMap(ctx: CanvasRenderingContext2D, options: MapRenderOptions): void {
  const { viewport, viewSize } = options
  const pixelRatio = options.pixelRatio ?? 1
  const layers: MapLayerVisibility = { ...DEFAULT_MAP_LAYERS, ...options.layers }
  const scale = viewport.scale

  // ① 底板：清空 + 铺底色（在 CSS 像素坐标系里做，避免受 world 变换影响）
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  ctx.clearRect(0, 0, viewSize.width, viewSize.height)
  ctx.fillStyle = MAP_PALETTE.board
  ctx.fillRect(0, 0, viewSize.width, viewSize.height)

  // 进入世界坐标：screen = world × scale + offset
  ctx.setTransform(
    pixelRatio * scale,
    0,
    0,
    pixelRatio * scale,
    pixelRatio * viewport.offsetX,
    pixelRatio * viewport.offsetY,
  )

  // ② 地图扫描图
  const image = options.image ?? null
  if (layers.image && image !== null) {
    ctx.drawImage(
      image,
      MAP_IMAGE_ORIGIN.x,
      MAP_IMAGE_ORIGIN.y,
      image.naturalWidth,
      image.naturalHeight,
    )
  }

  // 视口裁剪结果（后续图层共用同一份，避免重复计算）
  const hexes = visibleHexes(viewport, viewSize)

  // ③ 六角网格
  if (layers.grid) {
    ctx.strokeStyle = MAP_PALETTE.grid
    ctx.lineWidth = GRID_LINE_SCREEN_PX / scale
    for (const hex of hexes) {
      traceHexPath(ctx, hex)
      ctx.stroke()
    }
  }

  // ④ 格边要素：河/湖、道路、铁路（各自独立线型，可叠加）
  if (layers.edges) {
    for (const edge of visibleEdges(viewport, viewSize)) {
      if (edge.river !== undefined) {
        drawHexside(ctx, edge.a, edge.b, MAP_PALETTE.river, RIVER_LINE_SCREEN_PX, scale)
      }
      if (edge.road !== undefined) {
        drawHexside(ctx, edge.a, edge.b, MAP_PALETTE.road, ROAD_LINE_SCREEN_PX, scale)
      }
      if (edge.rail === true) {
        drawHexside(
          ctx,
          edge.a,
          edge.b,
          MAP_PALETTE.rail,
          RAIL_LINE_SCREEN_PX,
          scale,
          RAIL_DASH_SCREEN_PX,
        )
      }
    }
  }

  // ④-b 装甲集群分界线（专规 3.4）：**地图事实层**，画在格边要素之上、算子之下
  if (options.boundary !== undefined && options.boundary !== null) {
    /*
     * ★ 批 F 切片 1：画的是**沿多轨铁路的折线**（`path` 每个格心一个折点；
     * 没有路径时 `boundaryLinePoints` 退回两端点直线）。
     */
    const points = boundaryLinePoints(options.boundary)
    ctx.strokeStyle = MAP_PALETTE.boundary
    ctx.lineWidth = BOUNDARY_LINE_SCREEN_PX / scale
    ctx.setLineDash(BOUNDARY_DASH_SCREEN_PX.map((value) => value / scale))
    ctx.beginPath()
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    })
    ctx.stroke()
    // 站错一侧的格：一圈同样的虚线（提示"这几格在段末要投 DG"，3.4a）
    for (const hex of options.boundary.wrongSideHexes ?? []) {
      traceHexPath(ctx, hex)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  // ⑤ 印刷永久工事：**已下移到 ⑨**（用户 2026-09-16 #2：工事必须压在最上层，见 MAP_LAYER_ORDER）

  // ⑥ 格号标注（缩放足够大才画；字号按屏幕恒定，故除以 scale）
  if (layers.labels && scale >= LABEL_MIN_SCALE) {
    const fontPx = LABEL_FONT_SCREEN_PX / scale
    ctx.font = `${fontPx.toFixed(1)}px ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 3 / scale
    ctx.strokeStyle = MAP_PALETTE.labelHalo
    ctx.fillStyle = MAP_PALETTE.label
    for (const hex of hexes) {
      const center = hexCanvasPoint(hex)
      const text = `${hex.col}.${hex.row}`
      // 先描白边再填字，压在扫描图上任何底色都读得清
      ctx.strokeText(text, center.x, center.y)
      ctx.fillText(text, center.x, center.y)
    }
  }

  // ⑦ 高亮格
  const highlight = options.highlightHex ?? null
  if (highlight !== null && isBoardHex(highlight)) {
    ctx.strokeStyle = MAP_PALETTE.highlight
    ctx.lineWidth = 3 / scale
    traceHexPath(ctx, highlight)
    ctx.stroke()
  }

  // ⑧ 移动交互覆盖层（C5：算子 + 可到达范围 + 预览路径）；画在格号之上，免得被字压住
  //    W7 C16 性能底线：把③算出的可见格清单做成键集合交给覆盖层 ⇒ 算子与提示只画视口内的
  const overlay = options.overlay ?? null
  if (overlay !== null) {
    const visibleKeys = new Set(hexes.map((hex) => overlayHexKey(hex)))
    drawMovementOverlay(ctx, overlay, scale, visibleKeys)
  }

  /*
   * ⑨ 印刷永久工事（专规 1.3a：不可降低）—— **压在最上层**
   *
   * 用户 2026-09-16 #2：「地图上工事贴图要显示在堆叠最上层」。
   *   · 缩到 0.7R 并放在格的**右上角内沿**：既一眼看出该格有工事，又不把堆叠的印值盖住
   *     （盖住会导致点不到堆叠，违反"简洁可靠"）；
   *   · 半透明（0.92）：其下若有算子，仍能看出轮廓；
   *   · 贴图未就绪时退回「圆点 + 等级数字」——同样在右上角内沿，位置口径与贴图一致。
   */
  if (layers.hedgehogs) {
    const hedgehogs = visiblePrintedHedgehogs(viewport, viewSize)
    const badgeRadius = HEX_RADIUS_PX * 0.24
    const fontPx = badgeRadius / scale
    ctx.font = `${fontPx.toFixed(1)}px ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.save()
    ctx.globalAlpha = HEDGEHOG_TEXTURE_ALPHA
    for (const item of hedgehogs) {
      const hexCenter = hexCanvasPoint({ col: item.col, row: item.row })
      const center = {
        x: hexCenter.x + HEX_RADIUS_PX * HEDGEHOG_CORNER_OFFSET,
        y: hexCenter.y - HEX_RADIUS_PX * HEDGEHOG_CORNER_OFFSET,
      }
      const textureUrl = hedgehogTextureUrl(item.level)
      const texture = textureUrl === null ? null : counterImages.get(textureUrl)
      if (texture !== null) {
        const side = HEX_RADIUS_PX * HEDGEHOG_TEXTURE_RATIO
        ctx.drawImage(texture, center.x - side / 2, center.y - side / 2, side, side)
        continue
      }
      ctx.fillStyle = MAP_PALETTE.hedgehog
      ctx.beginPath()
      ctx.arc(center.x, center.y, badgeRadius, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.fillText(String(item.level), center.x, center.y)
    }
    ctx.restore()
  }

  /*
   * ⑩ 5.0c：**胜利格控制标记**（B18+ 用户要求）—— 同样压在最上层，但**不盖住印值**
   *
   * 用户口径：「把这两个标记做到剧本用到的胜利格上，F 是苏联控制、B 是轴心控制，根据控制方
   * 显示对应面，且该标记**钉死**在胜利点**无法选中**，标记更换为根据胜利点归属权变更**自动**进行」。
   *   · 画在格的**左上角内沿**（工事在右上角 ⇒ 两者同时出现也不打架）；
   *   · 大小 0.6R、不透明（它是"这块地归谁"的规则事实，不该像工事那样半透明看不清）；
   *   · **不是算子**：它不进 `tokens`，故不参与命中测试、不参与堆叠展开、也永远不会被选中；
   *   · 贴图未就绪时退回「方块 + 攻/守首字」（苏/轴），颜色的语义与正式标记一致。
   */
  if (layers.control) {
    const markers = options.controlMarkers ?? []
    const badgeSide = HEX_RADIUS_PX * 0.42
    const badgeFontPx = (badgeSide * 0.62) / scale
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const marker of markers) {
      if (!isBoardHex(marker.hex)) continue
      const hexCenter = hexCanvasPoint(marker.hex)
      const center = {
        x: hexCenter.x - HEX_RADIUS_PX * HEDGEHOG_CORNER_OFFSET,
        y: hexCenter.y - HEX_RADIUS_PX * HEDGEHOG_CORNER_OFFSET,
      }
      const url = controlMarkerImageUrl(marker.side)
      const texture = counterImages.get(url)
      if (texture !== null) {
        const side = HEX_RADIUS_PX * CONTROL_MARKER_RATIO
        ctx.drawImage(texture, center.x - side / 2, center.y - side / 2, side, side)
        continue
      }
      ctx.fillStyle = marker.side === 'soviet' ? MAP_PALETTE.controlSoviet : MAP_PALETTE.controlAxis
      ctx.fillRect(center.x - badgeSide / 2, center.y - badgeSide / 2, badgeSide, badgeSide)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1 / scale
      ctx.strokeRect(center.x - badgeSide / 2, center.y - badgeSide / 2, badgeSide, badgeSide)
      ctx.font = `${badgeFontPx.toFixed(1)}px ui-monospace, monospace`
      ctx.fillStyle = '#ffffff'
      ctx.fillText(marker.side === 'soviet' ? '苏' : '轴', center.x, center.y)
    }
  }

  /*
   * ⑪ 专规 3.5：**建造标记**（桥 / 简易机场）—— 同样压在最上层
   *
   * 用户口径（B34 余项③b）：「标记要在**地图上看得见**」。修前它只在专规面板里列文字。
   *   · 画在格的**左下角内沿**（工事右上、控制标记左上 ⇒ 三者同格也不打架，且都不压印值）；
   *   · 不透明（它是"这一格有桥/有机场"的规则事实，14.9f 的卸载上限、13.8b 的过河取费都依赖它）；
   *   · **不是算子**：不进 `tokens`，故不参与命中测试、不参与堆叠展开、也不会被选中；
   *   · 贴图未就绪时退回「方块 + 桥/机」，颜色语义由 `MAP_PALETTE` 给。
   */
  if (layers.constructionMarkers) {
    const badges = constructionMarkerBadges(options.constructionMarkers ?? [])
    const fontPx = (HEX_RADIUS_PX * CONSTRUCTION_MARKER_RATIO * 0.66) / scale
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `${fontPx.toFixed(1)}px ui-monospace, monospace`
    for (const badge of badges) {
      ctx.fillStyle =
        badge.kind === 'bridge' ? MAP_PALETTE.constructionBridge : MAP_PALETTE.constructionAirStrip
      ctx.fillRect(
        badge.center.x - badge.side / 2,
        badge.center.y - badge.side / 2,
        badge.side,
        badge.side,
      )
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1 / scale
      ctx.strokeRect(
        badge.center.x - badge.side / 2,
        badge.center.y - badge.side / 2,
        badge.side,
        badge.side,
      )
      ctx.fillStyle = '#ffffff'
      ctx.fillText(badge.kind === 'bridge' ? '桥' : '机', badge.center.x, badge.center.y)
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

/** 视口尺寸为 0 时（容器尚未布局）的兜底：不画，避免除零 */
export function canDraw(viewSize: Size): boolean {
  return viewSize.width > 0 && viewSize.height > 0
}

/**
 * 专规 3.5：建造标记 → 屏幕角标（**纯函数**，绘制与测试共用同一处口径）
 *
 * 只有落在**图内格**的标记才画（与工事/控制标记同一纪律）；角标尺寸＝`CONSTRUCTION_MARKER_RATIO × R`，
 * 位置＝格心沿左下 45° 偏移 `CONSTRUCTION_MARKER_CORNER × R`。
 */
export function constructionMarkerBadges(
  markers: readonly ConstructionMarkerPiece[],
): ConstructionMarkerBadge[] {
  const side = HEX_RADIUS_PX * CONSTRUCTION_MARKER_RATIO
  const badges: ConstructionMarkerBadge[] = []
  for (const marker of markers) {
    if (!isBoardHex(marker.hex)) continue
    const hexCenter = hexCanvasPoint(marker.hex)
    badges.push({
      kind: marker.kind,
      hex: marker.hex,
      center: {
        x: hexCenter.x + HEX_RADIUS_PX * CONSTRUCTION_MARKER_CORNER.x,
        y: hexCenter.y + HEX_RADIUS_PX * CONSTRUCTION_MARKER_CORNER.y,
      },
      side,
    })
  }
  return badges
}
