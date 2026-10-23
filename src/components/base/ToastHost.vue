<script setup lang="ts">
import { storeToRefs } from 'pinia'

import { useUiStore } from '@/stores'

import ToastItem from './ToastItem.vue'

/** 全局通知宿主：随 ui store 的 toasts 渲染，挂载于 body */
const ui = useUiStore()
const { toasts } = storeToRefs(ui)

function onDismiss(id: string): void {
  ui.dismissToast(id)
}
</script>

<template>
  <Teleport to="body">
    <ul class="toast-host" aria-live="polite">
      <TransitionGroup name="toast">
        <ToastItem v-for="item in toasts" :key="item.id" :toast="item" @dismiss="onDismiss" />
      </TransitionGroup>
    </ul>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: var(--space-5);
  right: var(--space-5);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0;
  margin: 0;
  list-style: none;
  pointer-events: none;
}

.toast-host > * {
  pointer-events: auto;
}

/* ── 过渡 ── */
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
</style>
