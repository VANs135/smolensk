<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 是否打开（v-model） */
    open: boolean
    /** 标题 */
    title?: string
    /** 面板宽度 */
    width?: string
    /** 遮罩层叠值（缺省 `--z-panel`；须盖在其它模态之上时传 `--z-dialog-top`） */
    zIndex?: string
  }>(),
  {
    title: '',
    width: '480px',
    zIndex: 'var(--z-panel)',
  },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  close: []
}>()

/** 统一关闭入口：同步 v-model 并广播 close */
function onClose(): void {
  emit('update:open', false)
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') onClose()
}

watch(
  () => props.open,
  (open) => {
    if (open) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
  },
)

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div
        v-if="props.open"
        class="dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="props.title || '对话框'"
        :style="{ zIndex: props.zIndex }"
      >
        <div class="dialog__mask" @click="onClose" />
        <div class="dialog__panel" :style="{ width: props.width }">
          <header class="dialog__header">
            <h3 class="dialog__title">{{ props.title }}</h3>
            <button class="dialog__close-btn" type="button" aria-label="关闭" @click="onClose">
              ×
            </button>
          </header>

          <div class="dialog__body">
            <slot />
          </div>

          <footer v-if="$slots.footer" class="dialog__footer">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog {
  position: fixed;
  inset: 0;
  z-index: var(--z-panel);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-8);
}

.dialog__mask {
  position: absolute;
  inset: 0;
  background: rgb(32 30 26 / 0.45);
}

.dialog__panel {
  position: relative;
  max-width: 100%;
  max-height: 100%;
  overflow: auto;
  background: var(--color-panel);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
}

.dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid var(--color-rule);
}

.dialog__title {
  margin: 0;
  font-size: 1.05rem;
}

.dialog__close-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-muted);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.dialog__close-btn:hover {
  background: var(--color-bg-2);
  color: var(--color-ink);
}

.dialog__body {
  padding: var(--space-6);
  overflow: auto;
}

.dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-6);
  border-top: 1px solid var(--color-rule);
  background: var(--color-bg-2);
}

/* ── 过渡 ── */
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity var(--dur-base) var(--ease-out);
}
.dialog-enter-active .dialog__panel,
.dialog-leave-active .dialog__panel {
  transition:
    transform var(--dur-base) var(--ease-out),
    opacity var(--dur-base) var(--ease-out);
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
.dialog-enter-from .dialog__panel,
.dialog-leave-to .dialog__panel {
  transform: translateY(12px) scale(0.98);
  opacity: 0;
}
</style>
