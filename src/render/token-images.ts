/**
 * 算子图档与标记贴图的加载与缓存（渲染层）
 *
 * ## 职责边界（CODE_SPEC §3.1）
 *   本模块只做「按文件名取一张已就绪的图」——**不判断规则、不写任何状态**；
 *   画不画、画多大由 `token-layer` / `map-render` 决定，图存在与否只影响「用图还是用矢量回退」。
 *
 * ## 图从哪来
 *   `public/counters/{axis,soviet,markers}/` —— 由 `scripts/sync-counters.mjs` 从素材库拷贝：
 *     · `axis` / `soviet`：两方地面算子与飞机；
 *     · `markers`：中立算子（SP / 空军基地 / 环形工事）+ **各种贴图**（模式标记 / 工事等级）。
 *   文件名沿用素材库原名（CODE_SPEC：图档沿用现有文件名，一律不改），故 URL 需 `encodeURIComponent`
 *   （贴图名里带空格）。
 *
 * ## 为什么要缓存 + 回退
 *   图片是异步加载的：未就绪时 `get()` 返回 `null`，调用方**回退到原有矢量画法**
 *   （方块 + 文字）。这既保证「图没加载完也能看盘」，也让 Node 环境的渲染单测
 *   （无 DOM、无 Image）照旧跑在矢量路径上——与 `map-render` 对地图扫描图的处理同一思路。
 */

/** 图档根（Vite `public/` 直出） */
export const COUNTERS_BASE = '/counters'

/** 三个图档子目录（`markers` 同时承载中立法与各种贴图） */
export type CounterDir = 'axis' | 'soviet' | 'markers'

/** 阵营 → 图档子目录（中立算子 `both` 走 markers） */
export function counterDirOfSide(side: string): CounterDir {
  if (side === 'axis') return 'axis'
  if (side === 'soviet') return 'soviet'
  return 'markers'
}

/** 算子图 URL（文件名可能含空格，须编码） */
export function counterImageUrl(dir: CounterDir, file: string): string {
  return `${COUNTERS_BASE}/${dir}/${encodeURIComponent(file)}`
}

/** 贴图一律在 markers 目录 */
export function markerTextureUrl(file: string): string {
  return counterImageUrl('markers', file)
}

/**
 * 各种贴图的文件名（素材库 `图片浏览库/各种贴图/`，同步脚本原样拷入 markers）
 *
 * - `exploit`：进击标记的 2/3/4 号变体（同一个标记有多个编号变体，便于同场区分归属）；
 * - `strat`：战略模式标记；
 * - `outOfSupply`：断补标记；
 * - `hedgehog`：环形工事 1–4 级。
 */
export const MARKER_TEXTURES = {
  exploit: ['misc_Explt-2 small.png', 'misc_Explt-3 small.png', 'misc_Explt-4 small.png'],
  strat: 'misc_Strat small.png',
  outOfSupply: 'misc_OoS small.png',
  hedgehog: [
    'misc_hog-1 small.png',
    'misc_hog-2 small.png',
    'misc_hog-3 small.png',
    'misc_hog-4 small.png',
  ],
} as const

/** 由单位实例 id 稳定地挑一个进击标记变体（同一单位每次重绘拿到同一张，不闪） */
export function exploitTextureUrl(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  }
  const variants = MARKER_TEXTURES.exploit
  return markerTextureUrl(variants[hash % variants.length]!)
}

/** 环形工事等级 → 贴图 URL（1–4 级；超出范围返回 null，调用方回退矢量画法） */
export function hedgehogTextureUrl(level: number): string | null {
  if (!Number.isInteger(level) || level < 1 || level > MARKER_TEXTURES.hedgehog.length) return null
  return markerTextureUrl(MARKER_TEXTURES.hedgehog[level - 1]!)
}

/** 图片缓存（就绪的图 / 是否在加载 / 加载失败） */
export interface ImageCache {
  /** 已就绪的图；未加载、加载中或失败 ⇒ null（调用方走矢量回退） */
  get(url: string): CanvasImageSource | null
  /** 预载一批 URL；无论成功失败都会 resolve（失败者永久回退） */
  preload(urls: readonly string[]): Promise<void>
  /** 已就绪张数（诊断/测试用） */
  readyCount(): number
}

/** 建一个图片缓存（每张 URL 只请求一次；失败的不再重试） */
export function createImageCache(): ImageCache {
  const images = new Map<string, HTMLImageElement>()
  const failed = new Set<string>()
  const pending = new Map<string, Promise<void>>()

  const isReady = (image: HTMLImageElement): boolean => image.complete && image.naturalWidth > 0

  return {
    get(url) {
      const image = images.get(url)
      return image !== undefined && isReady(image) ? image : null
    },
    preload(urls) {
      const jobs: Promise<void>[] = []
      for (const url of urls) {
        const known = images.get(url)
        if (known !== undefined && isReady(known)) continue
        if (failed.has(url)) continue
        const running = pending.get(url)
        if (running !== undefined) {
          jobs.push(running)
          continue
        }
        // Node（渲染单测）没有 Image：直接放弃，调用方永久走矢量回退
        if (typeof Image === 'undefined') return Promise.resolve()
        const job = new Promise<void>((resolve) => {
          const image = new Image()
          image.decoding = 'async'
          image.onload = () => {
            images.set(url, image)
            pending.delete(url)
            resolve()
          }
          image.onerror = () => {
            failed.add(url)
            pending.delete(url)
            resolve()
          }
          image.src = url
        })
        pending.set(url, job)
        jobs.push(job)
      }
      return Promise.all(jobs).then(() => undefined)
    },
    readyCount() {
      let count = 0
      for (const image of images.values()) if (isReady(image)) count += 1
      return count
    },
  }
}

/** 全局算子图缓存（`MapCanvas` 预载，`token-layer` / `map-render` 消费） */
export const counterImages = createImageCache()

/**
 * 全部模式/状态贴图的 URL（`MapCanvas` 启动时一次预载：共 9 张，量小）
 *
 * 这些贴图与盘面无关（模式标记 / 工事等级），故不随覆盖层变化反复预载。
 */
export function allMarkerTextureUrls(): string[] {
  return [
    ...MARKER_TEXTURES.exploit.map((file) => markerTextureUrl(file)),
    markerTextureUrl(MARKER_TEXTURES.strat),
    markerTextureUrl(MARKER_TEXTURES.outOfSupply),
    ...MARKER_TEXTURES.hedgehog.map((file) => markerTextureUrl(file)),
  ]
}

/**
 * 由单位记录的两面图名挑出「该朝向那一面」的图 URL
 *
 * @param dir  该单位所在图档目录
 * @param face 当前朝向（5.4a：一切数值以朝向那一面为基准，图同理）
 * @param images 记录的两面图名（`back` 可为空 = 单面算子）
 */
export function counterImageUrlForFace(
  dir: CounterDir,
  face: 'combat' | 'move',
  images: { front?: string | null; back?: string | null } | null | undefined,
): string | null {
  if (images === null || images === undefined) return null
  const file = face === 'move' ? (images.back ?? images.front) : (images.front ?? images.back)
  return typeof file === 'string' && file !== '' ? counterImageUrl(dir, file) : null
}

/* ────────────────────────────── 计数类非战斗算子：图随**当前数值**走 ────────────────────────────── */

/**
 * 条 27 / §4-7：素材只有 1/2/3/4/5/10/15 七种面额 ⇒ 任意总额取**最近面额**的图，
 * 实数（真实总额）由角标补上（见 `spDenominationDiffers`）。
 *
 * 距离相同时取**小面额**（整数区间内只有 5↔10 的 7.5 是中点，整数不会撞平局；
 * 此处仍显式定序，避免将来加面额时行为漂移）。
 */
export const SP_DENOMINATIONS: readonly number[] = [1, 2, 3, 4, 5, 10, 15]

/** 任意总额 → 最近的可取面额（≤0 / 非整数 ⇒ null） */
export function nearestSpDenomination(points: number): number | null {
  if (!Number.isInteger(points) || points <= 0) return null
  let best = SP_DENOMINATIONS[0]! // 非空常量表，取首项一定存在
  for (const denom of SP_DENOMINATIONS) {
    const d = Math.abs(denom - points)
    const b = Math.abs(best - points)
    if (d < b || (d === b && denom < best)) best = denom
  }
  return best
}

/**
 * 12.1a：SP 算子的图 —— **由当前点数决定**（不是记录里那枚静态图）
 *
 * 素材库按面额各有一张（`Neutral_SP_1..5/10/15`）；其中 1/2/3 是**双面**算子的两面：
 * `_F` = 补给点数面（SP n）、`_B` = 运输点数面（SP nT，1 SP = 4T）。
 * 4/5/10/15 只有单面图。
 *
 * 「由当前点数决定」的意义：拆并补给台（12.1a）后点数会变，图必须跟着变。
 * 非标总额（如 9）取最近面额（10）的图，实数 9 由角标显示。
 */
export function spCounterImageUrl(points: number, face: 'combat' | 'move'): string | null {
  const denom = nearestSpDenomination(points)
  if (denom === null) return null
  const base = `Neutral_SP_${denom}`
  if (denom <= 3) return markerTextureUrl(`${base}_${face === 'move' ? 'B' : 'F'}.png`)
  return markerTextureUrl(`${base}.png`)
}

/** 该总额的贴图面额是否与实数不一致（不一致 ⇒ 需要画实数角标） */
export function spDenominationDiffers(points: number): boolean {
  const denom = nearestSpDenomination(points)
  return denom !== null && denom !== points
}

/**
 * 13.8d / 15.4：空军基地的图 —— **由当前等级决定**（1/2/3 级各一张）
 *
 * 等级会因 15.4 缩减而下降，故不能只认记录里那枚静态图。
 */
export function airbaseImageUrl(level: number): string | null {
  if (!Number.isInteger(level) || level < 1 || level > 3) return null
  return markerTextureUrl(`Neutral_Airbase_${level}.png`)
}

/**
 * 16.0 / 21.11c：环形工事**算子**的图 —— 由当前等级决定（1–4 级各一张）
 *
 * 与地图印刷工事的贴图（`misc_hog-N`）分开：算子有自己的一套正式算子图。
 */
export function hedgehogCounterImageUrl(level: number): string | null {
  if (!Number.isInteger(level) || level < 1 || level > 4) return null
  return markerTextureUrl(`Neutral_Hedgehog_${level}.png`)
}

/**
 * 5.0c：**胜利格控制标记**的图（用户 2026-09-16 指定用官方标记）
 *
 * 「F 是苏联控制，B 是轴心控制，根据控制方显示对应面」——素材库 `官方标记/` 里的
 * `Neutral_Control_Marker_{F,B}.png`（由 `scripts/sync-counters.mjs` 拷进 `markers/`）。
 *
 * ★ 与算子不同：它**不是算子**（没有实例、不可选中），渲染层只按"该格归谁"取一面画上去；
 *   控制方一变（5.0c 的"进入即记账"）⇒ 下一次重绘自然翻面。
 */
export function controlMarkerImageUrl(side: 'axis' | 'soviet'): string {
  return markerTextureUrl(
    side === 'soviet' ? 'Neutral_Control_Marker_F.png' : 'Neutral_Control_Marker_B.png',
  )
}

/** 控制标记的两张图（预载用；与 `controlMarkerImageUrl` 同源，免得两处各写一遍文件名） */
export function allControlMarkerImageUrls(): string[] {
  return [controlMarkerImageUrl('soviet'), controlMarkerImageUrl('axis')]
}

/**
 * 13.2h + 用户 2026-09-15 裁定：**编内卡车**的图由**装载状态**决定
 *
 * 「编内卡车全部只有 1 点运力，该单位两面：一面是**空载 1-45**、一面是**满载 1F-45**
 *   （1 运力数字右上角多了个 F）-45」；又「**运输单位只有移动模式，没有战斗模式**（13.0）」
 *   ⇒ 运输单位的「两面」**不表示战斗/移动**，故不能按朝向选图。
 * 素材侧：`*_F.png` = 满载面（印 `1F`）、`*_B.png` = 空载面（印 `1`）。
 */
export function organicTruckImageUrl(
  dir: CounterDir,
  loaded: boolean,
  images: { front?: string | null; back?: string | null } | null | undefined,
): string | null {
  if (images === null || images === undefined) return null
  const file = loaded ? (images.front ?? images.back) : (images.back ?? images.front)
  return typeof file === 'string' && file !== '' ? counterImageUrl(dir, file) : null
}

/**
 * 覆盖层令牌要用的算子图 URL（**计数类非战斗算子按当前数值取图**，其余按记录的两面图）
 *
 * 这是渲染层选图的**唯一入口**：`token-layer` 只调它，不自行拼文件名。
 */
export function tokenImageUrl(token: {
  side: string
  face?: 'combat' | 'move'
  images?: { front?: string | null; back?: string | null } | null
  noncombatKind?: string | null
  spPoints?: number | null
  noncombatLevel?: number | null
  /** 13.2f/h：已装 SP（内部以 T 计）——**只编内卡车**用它选「满载面 / 空载面」 */
  loadedSpT?: number | null
}): string | null {
  const face = token.face ?? 'combat'
  const kind = token.noncombatKind ?? null
  if (kind === 'sp' && token.spPoints != null) {
    const byPoints = spCounterImageUrl(token.spPoints, face)
    if (byPoints !== null) return byPoints
  }
  if (kind === 'air_base' && token.noncombatLevel != null) {
    const byLevel = airbaseImageUrl(token.noncombatLevel)
    if (byLevel !== null) return byLevel
  }
  if (kind === 'hedgehog' && token.noncombatLevel != null) {
    const byLevel = hedgehogCounterImageUrl(token.noncombatLevel)
    if (byLevel !== null) return byLevel
  }
  // 编内卡车：面＝装载（满载 1F / 空载 1），与朝向无关（13.0：运输单位只有移动模式）
  if (kind === 'organic_truck') {
    return organicTruckImageUrl(
      counterDirOfSide(token.side),
      (token.loadedSpT ?? 0) > 0,
      token.images,
    )
  }
  // 其余（战斗单位 / 运输点数 / 延补队 / 中立标记）：按记录里该朝向那一面
  return counterImageUrlForFace(counterDirOfSide(token.side), face, token.images)
}
