/**
 * `ExclusiveRulesPanel` 的**分段可见性**判据（纯函数，便于单测）
 *
 * 为什么单独拎出来：组件本身没有挂载测试（仓库没有 `@vue/test-utils`），而"哪一段该出现、
 * 哪一段的动作该可写"是**规则性**判断，不该只能靠源码字符串守卫去猜。
 *
 * ## 三种"全显"与它们的区别（★ 这里踩过一次坑）
 *
 * | `only` | 节本体（`<details>` + 只读信息） | 节内动作（按钮/下拉） |
 * |---|---|---|
 * | `null`（验证页） | 全显 | 全显 |
 * | `actions`（会话全动作） | 全显 | 全显 |
 * | `info`（右栏只读） | **全显** | **全不显** |
 * | `panzer` / `security` / `hedgehog` / `marker` / `cache` | **只显自己那一节** | 只显自己那一节 |
 *
 * 坑：`info` 曾经被写成"只有 info 段"，结果右栏里五节整块消失 ——
 * 而「逐城治安明细 / 工事等级与上限、本回合台账 / 建造标记余量 / 缓存持仓」本来**都是只读信息**，
 * 藏掉节就等于把右栏的信息也删了。`info` 的正确语义是"**节在、动作不写**"。
 */

/** 本面板的分段名（单节模式用） */
export type ExclusiveSectionScope = 'panzer' | 'security' | 'hedgehog' | 'marker' | 'cache'

/** 本面板接受的 `only` 值 */
export type ExclusiveOnly = 'info' | 'actions' | ExclusiveSectionScope | null

/** 该节**本体**是否出现 */
export function sectionShown(only: ExclusiveOnly, section: ExclusiveSectionScope): boolean {
  if (only === null || only === 'actions' || only === 'info') return true
  return only === section
}

/** 该节**动作**是否可写（`info` 只读 ⇒ 一律 false） */
export function actsShown(only: ExclusiveOnly, section: ExclusiveSectionScope): boolean {
  if (only === null || only === 'actions') return true
  return only === section
}

/** 只读信息段（`info` 段的那些时点/明细）是否出现 */
export function infoShown(only: ExclusiveOnly): boolean {
  return only === null || only === 'info'
}
