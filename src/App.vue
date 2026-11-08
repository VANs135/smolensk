<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'

import { BaseButton, ToastHost } from '@/components/base'
import { SaveLoadDialog } from '@/components/save'
import { useAppStore, useGameSessionStore, useHotseatStore, useUiStore } from '@/stores'
import { getView } from '@/views/registry'

const app = useAppStore()
const ui = useUiStore()
const gameSession = useGameSessionStore()
const hotseat = useHotseatStore()
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
  <div class="shell" :class="{ 'shell--board': currentView === 'game' }">
    <header class="shell__bar">
      <div class="shell__identity">
        <span class="shell__mark" aria-hidden="true">17</span>
        <h1 class="shell__title" :title="app.appTitle">斯摩棱斯克</h1>
        <span class="shell__route">{{ activeRoute.meta.title }}</span>
      </div>
      <div class="shell__right">
        <span v-if="hotseat.handoffPending" class="shell__handoff">须先确认交接</span>
        <BaseButton
          v-if="currentView === 'game'"
          variant="ghost"
          size="sm"
          class="shell__save"
          :disabled="hotseat.handoffPending"
          @click="ui.navigate('home')"
          >开始台</BaseButton
        >
        <BaseButton
          v-if="currentView !== 'game'"
          variant="ghost"
          size="sm"
          class="shell__save"
          :disabled="hotseat.handoffPending"
          :title="hotseat.handoffPending ? '须先确认交接，才能存档 / 读档' : undefined"
          @click="ui.openSaveDialog()"
        >
          存档 / 读档（{{ saveBadge }}）
        </BaseButton>
      </div>
    </header>

    <main
      class="shell__body"
      :class="{
        'shell__body--wide':
          currentView === 'game' || currentView === 'workbench' || currentView === 'map',
        'shell__body--full':
          currentView === 'game' || currentView === 'home' || currentView === 'scenario',
      }"
      :inert="hotseat.handoffPending && currentView === 'game'"
    >
      <component :is="activeRoute.component" />
    </main>

    <!-- 存档 / 读档对话框：状态在 ui store（顶栏与待答面板共用同一个入口） -->
    <SaveLoadDialog
      :open="ui.saveDialogOpen && !hotseat.handoffPending"
      @update:open="ui.saveDialogOpen = $event"
    />
    <ToastHost v-if="!hotseat.handoffPending" />
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.shell--board {
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.shell__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-4);
  background: var(--color-command-panel);
  color: var(--color-command-ink);
  border-bottom: 1px solid var(--color-command-line);
  position: relative;
  z-index: var(--layer-shell);
}

.shell__identity {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.shell__mark {
  display: grid;
  flex: none;
  width: var(--space-8);
  height: var(--space-8);
  place-items: center;
  border: 1px solid var(--color-command-teal);
  color: var(--color-command-teal);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  border-radius: var(--radius-sm);
}

.shell__handoff {
  padding: 2px var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--color-gold);
  color: var(--color-ink);
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
  padding-left: var(--space-3);
  border-left: 1px solid var(--color-command-line);
  color: var(--color-command-muted);
  font-size: var(--text-xs);
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

.shell__body--full {
  max-width: none;
  min-height: 0;
  padding: 0;
}

@media (max-width: 620px) {
  .shell__route {
    display: none;
  }
}
</style>
