/**
 * 基础组件统一出口
 */

export { default as BaseButton } from './BaseButton.vue'
export { default as BasePanel } from './BasePanel.vue'
export { default as BaseTag } from './BaseTag.vue'
export { default as BaseDialog } from './BaseDialog.vue'
// 批 C 切片 2：规则说明条（标题一行 + 折叠的原文；用户口径 #18「有标题即可」）
export { default as RuleNote } from './RuleNote.vue'
// U0：`?` 规则点（条款号只进这里，不进正文）
export { default as RuleTip } from './RuleTip.vue'
export { UI_COPY } from './copy'
export { default as ToastHost } from './ToastHost.vue'
