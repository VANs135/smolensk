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
  /*
   * UI-2（2026-11-25）：原来贴 `top: space-5`（20px）⇒ 正好压在顶栏右侧的存档按钮上，
   * 而条目是 `pointer-events: auto`、层级 300，把按钮点击整片吃掉。
   * 顶栏高 ≈ space-2*2 + space-8(=32) + 1px 线 ⇒ 落到 72px 才让开；右缘仍贴 20px。
   */
  top: 72px;
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
