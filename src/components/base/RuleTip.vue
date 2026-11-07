<script setup lang="ts">
/**
 * U0：`?` 规则点（**条款号只进这里，不进正文**）
 *
 * 原生 `<details>`：默认收起、键盘可达、无需脚本与定位样式；
 * 折叠体里放规则号与原文口径，主屏只留动作词。
 */
const props = defineProps<{
  /** 规则号（如 `12.5c-A`、`专规 2.4`） */
  rule: string
}>()
</script>

<template>
  <details class="rule-tip">
    <summary
      class="rule-tip__mark"
      :title="`规则 ${props.rule}`"
      :aria-label="`规则 ${props.rule}`"
    >
      ?
    </summary>
    <div class="rule-tip__body">
      <span class="rule-tip__rule">{{ props.rule }}</span>
      <slot />
    </div>
  </details>
</template>

<style scoped>
.rule-tip {
  display: inline-block;
  vertical-align: baseline;
}

.rule-tip__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: var(--space-1);
  border: 1px solid var(--color-rule);
  border-radius: 50%;
  color: var(--color-muted);
  font-size: var(--text-xs);
  line-height: 1;
  cursor: pointer;
  list-style: none;
}

/* 去掉浏览器默认三角（内容仍是 `<details>` 的可折叠体） */
.rule-tip__mark::-webkit-details-marker {
  display: none;
}

.rule-tip__body {
  margin-top: var(--space-1);
  color: var(--color-muted);
  font-size: var(--text-sm);
  line-height: 1.5;
}

.rule-tip__rule {
  margin-right: var(--space-2);
  font-variant-numeric: tabular-nums;
}
</style>
