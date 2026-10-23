<script setup lang="ts">
withDefaults(
  defineProps<{
    /** 面板标题（可选） */
    title?: string
  }>(),
  { title: '' },
)
</script>

<template>
  <section class="panel">
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

.panel__header {
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--color-rule);
}

.panel__title {
  margin: 0;
  font-size: 1rem;
  letter-spacing: 0.01em;
}

.panel__body {
  padding: var(--space-5);
}

.panel__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--color-rule);
  background: var(--color-bg-2);
}
</style>
