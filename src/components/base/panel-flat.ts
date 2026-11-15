import type { InjectionKey } from 'vue'

/**
 * Dock / 抽屉宿主注入：内层面板改用**扁平紧凑**变体
 *
 * 会话框本身已经有边框、标题与外层内边距，内层面板再套一层 `BasePanel` 就是双框 + 双层
 * 内边距（380px 宽下尤其挤）。宿主 provide(true) 后，内层面板只留内容，不再重复画框。
 */
export const PANEL_FLAT: InjectionKey<boolean> = Symbol('ocs-panel-flat')
