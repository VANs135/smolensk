<script setup lang="ts">
import { BasePanel } from '@/components/base'
import { HOTKEY_DOCS, useHotkeyStore } from '@/stores'

/**
 * 快捷键说明（W7 C16）
 *
 * 说明表直接取自 `stores/hotkeys.ts` 的 `HOTKEY_DOCS` —— 「按了什么键」与「这里写的什么」
 * 是同一份数据，改一处即同步，不会出现文档与实现不符。
 * 由 `?` 键或标题上的按钮折叠/展开（`hotkeys.helpOpen`）。
 */
const hotkeys = useHotkeyStore()
</script>

<template>
  <BasePanel title="快捷键（? 显示 / 隐藏）">
    <p class="muted">
      <span v-if="hotkeys.lastAction === null">在输入框里打字不会触发快捷键。</span>
      <span v-else>最近一次：{{ hotkeys.lastAction.detail }}</span>
    </p>
    <ul v-if="hotkeys.helpOpen" class="keys">
      <li v-for="doc in HOTKEY_DOCS" :key="doc.keys" class="keys__row">
        <kbd class="keys__kbd">{{ doc.keys }}</kbd>
        <span class="keys__label">{{ doc.label }}</span>
        <span v-if="doc.rule !== '—'" class="keys__rule num">{{ doc.rule }}</span>
      </li>
    </ul>
    <p v-else class="muted">按 <kbd class="keys__kbd">?</kbd> 展开全部快捷键。</p>
  </BasePanel>
</template>

<style scoped>
.keys {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.keys__row {
  display: grid;
  grid-template-columns: 96px 1fr auto;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-muted);
}

.keys__kbd {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  padding: 1px 6px;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-ink);
}

.keys__label {
  color: var(--color-ink);
}

.keys__rule {
  color: var(--color-gold);
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}
</style>
