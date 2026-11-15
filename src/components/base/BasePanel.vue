<script setup lang="ts">
import { computed, inject } from 'vue'

import { PANEL_FLAT } from './panel-flat'

const props = withDefaults(
  defineProps<{
    /** 面板标题（可选） */
    title?: string
    /** 扁平紧凑变体（Dock / 抽屉内层用；也可由宿主注入，见 `PANEL_FLAT`） */
    flat?: boolean
  }>(),
  { title: '', flat: false },
)

const injectedFlat = inject(PANEL_FLAT, false)

/** 宿主（会话框）已画过框与内边距 ⇒ 内层面板不再重复画一遍 */
const flat = computed<boolean>(() => props.flat || injectedFlat)
</script>

<template>
  <section class="panel" :class="{ 'panel--flat': flat }">
    <header v-if="title || $slots.header" class="panel__header">
      <slot name="header">
        <h3 class="panel__title">{{ title }}</h3>
      </slot>
    </header>

    <div class="panel__body">
      <slot />
    </div>

    <footer v-if="$slots.footer" class="panel__footer">
      <slot name="footer" />
    </footer>
  </section>
</template>

<style scoped>
.panel {
  background: var(--color-panel);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.panel--flat {
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  overflow: visible;
}

.panel__header {
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--color-rule);
}

.panel--flat .panel__header {
  padding: 0 0 var(--space-1);
  border-bottom: 0;
}

.panel__title {
  margin: 0;
  font-size: var(--text-lg);
  letter-spacing: 0.01em;
}

.panel__body {
  padding: var(--space-5);
  font-size: var(--text-sm);
}

.panel--flat .panel__body {
  padding: 0;
}

.panel__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--color-rule);
  background: var(--color-bg-2);
}

.panel--flat .panel__footer {
  padding: var(--space-2) 0 0;
  border-top: 0;
  background: transparent;
}
</style>
