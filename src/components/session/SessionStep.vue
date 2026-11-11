<script setup lang="ts">
import { computed, inject } from 'vue'

import { sessionStepVisible } from '@/stores/session-steps'

import { SESSION_STEP_GATE, SESSION_STEP_HOSTED } from './gate'

/**
 * U1-b：**会话步骤门**（一次只显示一件事）
 *
 * 用户口径：
 *   · 一个会话只办一件事，完成一件才出下一件，不并列堆在一屏；
 *   · 每步只显示：当前这一件事、需要你做的唯一决定、以及为什么会出现（一句，不写条款号）；
 *   · 旧组件内的步骤判定同步清理，顺序与判据来自 store 投影（`mapView.sessionStep`）。
 *
 * 本组件**不做任何规则判断**：只在 `item` 命中当前步骤 id 时渲染插槽。
 * 宿主（`MapDock`）provide 后生效；验证页 / 右栏没有宿主 ⇒ 放行（全量渲染）。
 */
const props = defineProps<{
  item: string
  /** 增援段单窗推进：是否显示「本步完成 / 跳过」 */
  ackable?: boolean
  ackDisabled?: boolean
  ackLabel?: string
}>()

const emit = defineEmits<{ (event: 'ack'): void }>()

const gate = inject(SESSION_STEP_GATE, null)
const hosted = inject(SESSION_STEP_HOSTED, false)
const step = computed(() => gate?.value ?? null)
/**
 * 没有宿主（验证页 / 右栏）⇒ 全量渲染；
 * 有宿主且无待决 ⇒ 一节都不渲染（批二：无待决 ≠ 全量渲染）；
 * 有宿主 ⇒ 只认当前那一个事项。
 */
const active = computed(() => sessionStepVisible(hosted, step.value?.id ?? null, props.item))
</script>

<template>
  <section v-if="active" class="step" data-session-item :data-session-item-id="props.item">
    <p v-if="step !== null" class="step__title" :title="step.why">
      <b>{{ step.title }}</b>
    </p>
    <p v-if="step !== null" class="step__decision">{{ step.decision }}</p>
    <slot />
    <button
      v-if="props.ackable"
      class="step__ack"
      type="button"
      :disabled="props.ackDisabled === true"
      @click="emit('ack')"
    >
      {{ props.ackLabel ?? '本步完成 / 跳过' }}
    </button>
  </section>
</template>

<style scoped>
.step {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.step__title {
  margin: 0;
  font-family: var(--font-head);
}

.step__decision {
  margin: 0;
  color: var(--color-ink);
}

.step__ack {
  align-self: flex-start;
  margin-top: var(--space-1);
  padding: 2px var(--space-2);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-panel);
  color: var(--color-ink);
  font-size: 0.85em;
  cursor: pointer;
}

.step__ack:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
