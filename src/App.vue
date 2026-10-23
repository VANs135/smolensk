<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'

import { BaseButton, ToastHost } from '@/components/base'
import { SaveLoadDialog } from '@/components/save'
import { useAppStore, useGameSessionStore, useUiStore } from '@/stores'
import { getView } from '@/views/registry'

const app = useAppStore()
const ui = useUiStore()
const gameSession = useGameSessionStore()
const { currentView } = storeToRefs(ui)

const activeRoute = computed(() => getView(currentView.value))

/** 顶栏按钮副标题：让玩家一眼看出槽里有没有档、当前会话什么形态 */
const saveBadge = computed(() => {
  const slot = gameSession.slot
  if (slot !== null) return `有档 · 第 ${slot.turn} 回合`
  if (gameSession.saveError !== null) return '槽不可读'
  return gameSession.session === null ? '无档' : '可存'
})
</script>

<template>
  <div class="shell">
    <header class="shell__bar">
      <h1 class="shell__title">{{ app.appTitle }}</h1>
      <div class="shell__right">
        <!-- W7 C15：存档 / 读档（独立按钮；任意视图都在 ⇒ 任意环节可存） -->
        <BaseButton variant="ghost" size="sm" class="shell__save" @click="ui.openSaveDialog()">
          存档 / 读档（{{ saveBadge }}）
        </BaseButton>
        <span class="shell__route">{{ activeRoute.meta.title }}</span>
        <span class="shell__env" :class="{ 'shell__env--dev': !app.isProduction }">
          {{ app.appEnv }}
        </span>
      </div>
    </header>

    <main
      class="shell__body"
      :class="{
        'shell__body--wide':
          currentView === 'game' || currentView === 'workbench' || currentView === 'map',
      }"
    >
      <component :is="activeRoute.component" />
    </main>

    <!-- 存档 / 读档对话框：状态在 ui store（顶栏与待答面板共用同一个入口） -->
    <SaveLoadDialog :open="ui.saveDialogOpen" @update:open="ui.saveDialogOpen = $event" />
    <ToastHost />
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.shell__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-6);
  background: var(--color-ink);
  color: var(--color-bg);
}

.shell__title {
  margin: 0;
  font-size: 1rem;
  letter-spacing: 0.04em;
  color: inherit;
}

.shell__right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.shell__route {
  color: var(--color-gold);
}

.shell__env {
  padding: 2px var(--space-3);
  border-radius: var(--radius-pill);
  background: rgb(255 255 255 / 0.12);
  color: var(--color-bg);
}

.shell__env--dev {
  background: var(--color-accent-2);
}

/* 顶栏上的「存档 / 读档」按钮：顶栏是深色，故覆写 ghost 的字色与描边
   （选择器带上 .shell__bar 提高优先级，确保盖过 BaseButton 自己的作用域样式） */
.shell__bar .shell__save {
  color: var(--color-bg);
  border-color: rgb(255 255 255 / 0.3);
}

.shell__bar .shell__save:hover {
  background: rgb(255 255 255 / 0.14);
  color: var(--color-bg);
}

.shell__body {
  flex: 1;
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  padding: var(--space-6);
}

/* 操作台要放地图，放宽版面（其余视图仍按 1080 阅读宽度） */
.shell__body--wide {
  max-width: 1680px;
}
</style>
