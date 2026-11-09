/**
 * Pinia stores 汇总出口
 */

// P8：12.1a 已并 SP 判据（唯一出处＝引擎；组件只读）
export { isNormalizedHoldings } from '@/engine/rules'

export * from './app'
export * from './ui'
export * from './workbench-model'
export * from './action-families'
export * from './workbench'
export * from './session'
// W7 C12：记录轨与容器管理（盒的账本与操作）
export * from './containers'
// W7 C13：切方与信息展示纪律（热坐交接 + 4.9a 敌方堆叠可见性）
export * from './hotseat'
// W7 C14：初设与开局流程（剧本选择 / 编制抽取 / 卡车满载 / SP 归属 / 自动初设 / 自定义初设）
export * from './setup'
// W7 C16：快捷键（纯函数解析 + 派发给既有动作；不做规则判断）
export * from './hotkeys'
// W7 C16：地图视图编排（覆盖层 + 点选分派；对局台与旧操作台共用）
export * from './map-view'
// U1-b：会话步骤投影（一次只暴露一个待决事项）
export * from './session-steps'
// ⑧：对局记录（只记事实、可导出；不写存档、不发网络请求）
export * from './recorder'
