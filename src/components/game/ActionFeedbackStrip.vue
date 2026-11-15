<script setup lang="ts">
import { computed } from 'vue'

import { BaseTag } from '@/components/base'
import { feedbackRowsOf, useWorkbenchStore } from '@/stores'

/**
 * 操作反馈区（M9②）
 *
 * ## 为什么要有
 *   引擎把每一次拒绝/落账都写成了**带规则编号**的解释（`workbench.log`，`pushLog`），
 *   移动/开拔被拒还会把原因留在 `moveBlocked` 里——但修前**没有任何界面读这两处**：
 *   玩家点了非法格，页面毫无反应，只能自己猜「为什么不行」。本组件把它们铺成一列。
 *
 * ## 分层纪律
 *   本组件**不做任何规则判断**：取哪几条、按什么排序由纯函数 `feedbackRowsOf` 决定
 *   （可单测），文本与规则号都是引擎/store 已经算好的。
 */
const workbench = useWorkbenchStore()

/** 展示条数（最近 N 条） */
const LIMIT = 6

const rows = computed(() =>
  feedbackRowsOf({ log: workbench.log, moveBlocked: workbench.moveBlocked, limit: LIMIT }),
)

/**
 * 当前被闸门拒绝的那一步（B8 记、B9 显示）
 *
 * 与下面的日志行**分开置顶**：日志会滚动、也会被后续动作顶掉，而"此刻这一步为什么不能做"
 * 要一直摆在那儿，直到玩家做了一件被允许的事（闸门放行时 `actionRefusal` 自动清空）。
 */
const refusal = computed(() => workbench.actionRefusal)

/** 类别 → 中文标签（界面不直接显示引擎枚举） */
const TONE_LABELS: Record<string, string> = {
  info: '提示',
  success: '完成',
  warning: '注意',
  danger: '拒绝',
}

/** 类别 → 标签样式（与 `WorkbenchLogEntry.kind` 一一对应） */
const TONE_KINDS: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}
</script>

<template>
  <section class="feedback" aria-label="操作反馈">
    <div class="feedback__head">
      <span class="feedback__title">操作反馈</span>
      <span class="muted num">最近 {{ LIMIT }} 条</span>
    </div>
    <p v-if="refusal !== null" class="feedback__refusal" :title="refusal.rule">
      <span class="feedback__text">{{ refusal.reason }}</span>
    </p>
    <ul v-if="rows.length > 0" class="feedback__list">
      <li
        v-for="row in rows"
        :key="row.id"
        class="feedback__row"
        :class="`feedback__row--${row.tone}`"
        :title="row.rule ?? undefined"
      >
        <BaseTag :kind="TONE_KINDS[row.tone] ?? 'neutral'">{{
          TONE_LABELS[row.tone] ?? '提示'
        }}</BaseTag>
        <span class="feedback__text">{{ row.text }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.feedback {
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  padding: var(--space-2) var(--space-3);
}

.feedback__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.feedback__title {
  font-family: var(--font-head);
  font-weight: 700;
  letter-spacing: 0.02em;
}

.feedback__refusal {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: var(--space-1) 0 0;
  padding: var(--space-1) var(--space-2);
  border-left: 3px solid var(--color-danger);
  background: var(--color-bg-2);
  font-size: var(--text-sm);
  line-height: 1.35;
}

.feedback__list {
  margin: var(--space-1) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 8.5rem;
  overflow: auto;
}

.feedback__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--text-sm);
  line-height: 1.35;
}

.feedback__row--warning {
  color: var(--color-warning);
}

.feedback__row--danger {
  color: var(--color-danger);
}

.feedback__text {
  flex: 1;
  word-break: break-word;
}
</style>
