<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'

import type { UiToastMessage } from '@/stores'

const props = defineProps<{
  toast: UiToastMessage
}>()

const emit = defineEmits<{
  dismiss: [id: string]
}>()

let timer: ReturnType<typeof setTimeout> | null = null

onMounted(() => {
  if (props.toast.duration > 0) {
    timer = setTimeout(() => emit('dismiss', props.toast.id), props.toast.duration)
  }
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <li class="toast theme-command" :class="`toast--${toast.kind}`" role="status">
    <span class="toast__dot" aria-hidden="true" />
    <span class="toast__text">{{ toast.text }}</span>
    <button class="toast__close" type="button" aria-label="关闭" @click="emit('dismiss', toast.id)">
      ×
    </button>
  </li>
</template>

<style scoped>
.toast {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  box-shadow: var(--shadow-md);
  border-left: 3px solid var(--color-muted);
  min-width: 240px;
  max-width: 360px;
  color: var(--color-ink);
  font-size: var(--text-sm);
}

.toast__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.toast__text {
  flex: 1;
}

.toast__close {
  flex: none;
  border: none;
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 2px;
}

.toast--info {
  border-left-color: var(--color-info);
}
.toast--info .toast__dot {
  color: var(--color-info);
}
.toast--success {
  border-left-color: var(--color-success);
}
.toast--success .toast__dot {
  color: var(--color-success);
}
.toast--warning {
  border-left-color: var(--color-warning);
}
.toast--warning .toast__dot {
  color: var(--color-warning);
}
.toast--danger {
  border-left-color: var(--color-danger);
}
.toast--danger .toast__dot {
  color: var(--color-danger);
}
</style>
