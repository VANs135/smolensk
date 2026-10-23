<script setup lang="ts">
import { BaseTag } from '@/components/base'

/**
 * **规则说明条**（批 C 切片 2；用户口径 9.16 #18：「对局窗口不要太多规则文字，**有标题即可**」）
 *
 * ## 为什么要有它
 *   面板里那些整段的 `p.muted` 规则说明占版面，而正式对局里玩家真正需要的是**一行"这一步是什么、
 *   点哪里"**；原文口径、例外与推导只在"我要核对"时才看。故统一成：**标题一行（可含规则号）＋
 *   折叠的正文**（`<details>`，浏览器原生、无需脚本，键盘可达）。
 *
 * ## 纪律（沿用 §16.09 的文字三类）
 *   · **标题必须能独立读懂**（环节提示一类）：不要写"规则说明"这种空标题；
 *   · 折叠体里放**原文口径 / 推导 / 例外**（供核对与复现），不删内容；
 *   · 默认**收起**（`open` 只在确有必要时给，例如当场的拒绝原因）。
 */
const props = withDefaults(
  defineProps<{
    /** 标题（一行；必须能独立读懂） */
    title: string
    /** 标题右侧的规则号标签 */
    rule?: string
    /** 是否默认展开（缺省收起） */
    open?: boolean
  }>(),
  { rule: '', open: false },
)
</script>

<template>
  <details class="rule-note" :open="props.open">
    <summary class="rule-note__title">
      <span class="rule-note__text">{{ props.title }}</span>
      <BaseTag v-if="props.rule !== ''" kind="neutral">{{ props.rule }}</BaseTag>
    </summary>
    <div class="rule-note__body">
      <slot />
    </div>
  </details>
</template>

<style scoped>
.rule-note {
  margin: var(--space-2) 0;
  border-left: 2px solid var(--color-rule);
  padding-left: var(--space-3);
}

.rule-note__title {
  cursor: pointer;
  color: var(--color-muted);
  font-size: var(--text-sm);
  /* 折叠箭头由浏览器画（`list-style` 默认），这里只保证文字不换行错位 */
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.rule-note__text {
  flex: 0 1 auto;
}

.rule-note__body {
  padding: var(--space-2) 0 var(--space-2) var(--space-3);
}
</style>
