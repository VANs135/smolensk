import { COUNTER_DATA } from '@/data/counter-data'

/**
 * 算子图 / 贴图 URL 的**取图口径**助手（渲染测试专用）
 *
 * 图档有两种来源，二者必须都能被断言：
 * - 已内联：`COUNTER_DATA['dir/file']` 命中 ⇒ 返回 `data:image/webp;base64,…`
 * - 未内联 / 无内联条目 ⇒ 返回静态路径 `/counters/dir/<编码文件名>`
 *
 * 断言「等于哪张图」时请用 `packedCounterUrl`（值随内联状态自动跟进，不臆造）；
 * 断言「画的是哪一张」时先过 `counterKeyOf`，把 data URI 还原成 `dir/file` 键。
 */
const TABLE: Record<string, string> = COUNTER_DATA

/** data URI → `dir/file` 的反查表（首次用到时构建） */
let reverse: Map<string, string> | null = null

/** 内联 URL → `dir/file` 键；非内联 URL（静态路径 / 任意串）原样返回 */
export function counterKeyOf(url: string): string {
  if (!url.startsWith('data:')) return url
  if (reverse === null) {
    reverse = new Map(Object.entries(TABLE).map(([key, packed]) => [packed, key]))
  }
  return reverse.get(url) ?? url
}

/** `dir/file` 当前的真实取图值：内联了就是 data URI，没内联才是静态路径 */
export function packedCounterUrl(dir: 'axis' | 'soviet' | 'markers', file: string): string {
  return TABLE[`${dir}/${file}`] ?? `/counters/${dir}/${encodeURIComponent(file)}`
}

/** 是否是一张算子图 / 贴图的 URL（内联 data URI 或静态路径都算） */
export function isCounterUrl(url: string): boolean {
  return url.startsWith('data:image/') || url.startsWith('/counters/')
}
