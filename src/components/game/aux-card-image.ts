/**
 * 辅助卡**卡面图**的 URL（B12）
 *
 * 图档由 `scripts/sync-aux-card-images.mjs` 从素材库拷进 `public/aux-cards/`（**保留原文件名**，
 * 含空格与大写 ⇒ 运行时必须编码）。与 `render/token-images.ts#COUNTERS_BASE` 同一套做法，
 * 本处只把"卡面名 → URL"这一步单写一处，免得两个组件各编码一次。
 */

/** 辅助卡卡面图所在目录（Vite 的 public ⇒ 运行期按此路径取） */
export const AUX_CARDS_BASE = '/aux-cards'

/** 卡面图档名 → URL（名字里的空格/大写交给 `encodeURIComponent`） */
export function auxCardImageUrl(image: string): string {
  return `${AUX_CARDS_BASE}/${encodeURIComponent(image)}`
}

/**
 * 印卡扫描图（表格屏的官方图表 / 记录轨）→ URL
 *
 * B22：与盒卡面**同一个目录、同一套命名口径**（`scripts/sync-aux-card-images.mjs` 一起拷进
 * `public/aux-cards/`，保留原文件名）⇒ 复用同一个编码规则，不另立一套。
 */
export function panelScanImageUrl(image: string): string {
  return auxCardImageUrl(image)
}
