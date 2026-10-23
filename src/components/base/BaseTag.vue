<script setup lang="ts">
import { computed } from 'vue'

/** 语义类别 */
type TagKind = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const props = withDefaults(
  defineProps<{
    /** 语义类别 */
    kind?: TagKind
    /** 是否可关闭（右上角 ×） */
    closable?: boolean
  }>(),
  { kind: 'neutral', closable: false },
)

const emit = defineEmits<{
  close: []
}>()

const rootClasses = computed(() => [`tag`, `tag--${props.kind}`])
</script>

<template>
  <span :class="rootClasses">
    <span class="tag__dot" aria-hidden="true" />
    <span class="tag__label"><slot /></span>
    <button
      v-if="props.closable"
      class="tag__close"
      type="button"
      aria-label="关闭"
      @click.stop="emit('close')"
    >
      ×
    </button>
  </span>
</template>

<style scoped>
.tag {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 2px var(--space-3);
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  letter-spacing: 0.04em;
  white-space: nowrap;
  line-height: 1.6;
  border: 1px solid transparent;
}

.tag__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.tag__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 2px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  border-radius: var(--radius-sm);
}

.tag__close:hover {
  background: rgb(0 0 0 / 0.1);
}

/* ── 语义 ── */
.tag--neutral {
  color: var(--color-muted);
  background: var(--color-bg-2);
  border-color: var(--color-rule);
}
.tag--info {
  color: var(--color-info);
  background: var(--color-info-bg);
}
.tag--success {
  color: var(--color-success);
  background: var(--color-success-bg);
}
.tag--warning {
  color: var(--color-warning);
  background: var(--color-warning-bg);
}
.tag--danger {
  color: var(--color-danger);
  background: var(--color-danger-bg);
}
</style>
