<script setup lang="ts">
import { computed, inject } from 'vue'

import { SESSION_STEP_GATE } from './gate'

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
const props = defineProps<{ item: string }>()

const gate = inject(SESSION_STEP_GATE, null)
/** 没有宿主 / 宿主当前无待决 / 宿主显式放行 ⇒ 全量渲染；否则只认当前那一个事项 */
const active = computed(() => gate === null || gate.value === null || gate.value.id === props.item)
const step = computed(() => gate?.value ?? null)
</script>

<template>
  <section v-if="active" class="step" data-session-item :data-session-item-id="props.item">
    <p v-if="step !== null" class="step__title">
      <b>{{ step.title }}</b>
    </p>
    <p v-if="step !== null" class="step__why">{{ step.why }}</p>
    <p v-if="step !== null" class="step__decision">需要你决定：{{ step.decision }}</p>
    <slot />
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

.step__why {
  margin: 0;
  color: var(--color-muted);
}

.step__decision {
  margin: 0;
  color: var(--color-ink);
}
</style>
