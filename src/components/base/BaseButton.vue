<script setup lang="ts">
import { computed, useSlots } from 'vue'

/** 外观变体：primary 主操作（橄榄绿）/ secondary 常规 / ghost 次级 / danger 危险 */
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
/** 尺寸 */
type ButtonSize = 'sm' | 'md'

const props = withDefaults(
  defineProps<{
    /** 外观变体 */
    variant?: ButtonVariant
    /** 尺寸 */
    size?: ButtonSize
    /** 禁用 */
    disabled?: boolean
    /** 加载中（禁用并显示转圈） */
    loading?: boolean
    /** 原生 button type */
    type?: 'button' | 'submit' | 'reset'
  }>(),
  {
    variant: 'secondary',
    size: 'md',
    disabled: false,
    loading: false,
    type: 'button',
  },
)

const emit = defineEmits<{
  click: []
}>()

const slots = useSlots()

const rootClasses = computed(() => [
  'btn',
  `btn--${props.variant}`,
  `btn--${props.size}`,
  {
    'is-disabled': props.disabled || props.loading,
    'is-loading': props.loading,
  },
])

/** 仅图标（无默认插槽内容）时折叠内边距，供纯图标按钮使用 */
const isIconOnly = computed(() => !slots.default)
</script>

<template>
  <button
    :class="rootClasses"
    :type="props.type"
    :disabled="props.disabled || props.loading"
    :aria-busy="props.loading"
    @click="emit('click')"
  >
    <span v-if="props.loading" class="btn__spinner" aria-hidden="true" />
    <span v-if="!isIconOnly" class="btn__label"><slot /></span>
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border-radius: var(--radius-md);
  font-family: var(--font-head);
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  user-select: none;
  border: 1px solid transparent;
  transition:
    background-color var(--dur-base) var(--ease-out),
    border-color var(--dur-base) var(--ease-out),
    color var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.btn:active:not(.is-disabled) {
  transform: translateY(1px);
}

.btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.btn.is-disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/* ── 尺寸 ── */
.btn--md {
  height: var(--control-height);
  padding: 0 var(--space-4);
  font-size: 0.92rem;
}
.btn--sm {
  height: var(--control-height-sm);
  padding: 0 var(--space-3);
  font-size: 0.82rem;
}
.btn--sm.btn--ghost {
  padding: 0 var(--space-2);
}

/* ── 变体 ── */
.btn--primary {
  background: var(--color-accent-2);
  color: #f6f4ee;
}
.btn--primary:hover:not(.is-disabled) {
  background: #3a5240;
}

.btn--secondary {
  background: var(--color-panel);
  color: var(--color-ink);
  border-color: var(--color-rule);
}
.btn--secondary:hover:not(.is-disabled) {
  border-color: var(--color-muted);
}

.btn--ghost {
  background: transparent;
  color: var(--color-ink);
}
.btn--ghost:hover:not(.is-disabled) {
  background: var(--color-bg-2);
}

.btn--danger {
  background: var(--color-danger);
  color: #f6f4ee;
}
.btn--danger:hover:not(.is-disabled) {
  background: #75271d;
}

/* ── 加载 ── */
.btn__spinner {
  width: 1em;
  height: 1em;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: btn-spin 0.6s linear infinite;
}
@keyframes btn-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
