<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { storeToRefs } from 'pinia'

import { BaseButton, ToastHost } from '@/components/base'
import { SaveLoadDialog } from '@/components/save'
import { useAppStore, useUiStore } from '@/stores'
import { getView } from '@/views/registry'

const app = useAppStore()
const ui = useUiStore()
const { currentView } = storeToRefs(ui)

const activeRoute = computed(() => getView(currentView.value))

/**
 * 用户 2026-11-10：拦掉 WebView 原生右键菜单
 *
 * 模型图、算子图、面板图都是 `<img>`；WebView 的原生菜单（含「将图像另存为」）
 * 会盖住我们自己的单位菜单。故窗口级一律 `preventDefault`，只给文本输入
 * （input / textarea / contenteditable）放行，保留系统复制/粘贴。
 */
function blockNativeContextMenu(event: MouseEvent): void {
  const target = event.target
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) {
    return
  }
  event.preventDefault()
}

onMounted(() => window.addEventListener('contextmenu', blockNativeContextMenu))
onBeforeUnmount(() => window.removeEventListener('contextmenu', blockNativeContextMenu))
</script>

<template>
  <div class="shell" :class="{ 'shell--board': currentView === 'game' }" :data-view="currentView">
    <header class="shell__bar">
      <div class="shell__identity">
        <span class="shell__mark" aria-hidden="true">17</span>
        <h1 class="shell__title" :title="app.appTitle">斯摩棱斯克</h1>
        <span class="shell__route">{{ activeRoute.meta.title }}</span>
      </div>
      <div class="shell__right">
        <!--
          2026-11-19（用户「不必要的字去掉」）：安卓壳把按钮缩成双字徽章
          （存读），文字由 android.css 的 ::after 提供、原文字 0 号字隐藏；桌面端保持完整文字。

          2026-11-26（用户「顶栏收成一行」）：对局台右上「☰ 主菜单」已搬进 FlowStrip 单行顶栏，
          应用头在对局台整条隐藏（`.shell--board .shell__bar`）⇒ 这里只剩非对局页的「存档」。
        -->
        <BaseButton
          v-if="currentView !== 'game'"
          variant="ghost"
          size="sm"
          class="shell__save shell__save--disk"
          @click="ui.openSaveDialog()"
        >
          存档
        </BaseButton>
      </div>
    </header>

    <main
      class="shell__body"
      :class="{
        'shell__body--wide':
          currentView === 'game' ||
          currentView === 'workbench' ||
          currentView === 'map' ||
          currentView === 'lobby',
        'shell__body--full':
          currentView === 'game' ||
          currentView === 'home' ||
          currentView === 'scenario' ||
          currentView === 'lobby',
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

.shell--board {
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

/*
 * 2026-11-26（用户「顶栏收成一行」）：对局台的应用头整条隐藏 ——
 * 品牌（17 / 斯摩棱斯克 / 对局台）与「☰ 主菜单」搬进 `FlowStrip` 的 44px 单行顶栏（见 `.bar`），
 * 地图因此多出约 90px（旧形态＝应用头 49 + 流程条 84）。开始台 / 剧本页仍用应用头。
 */
.shell--board .shell__bar {
  display: none;
}

.shell__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  /*
   * 顶栏贴着屏幕最上沿 ⇒ 必须自己让开刘海/状态栏（`--safe-*` 在桌面恒为 0，
   * 所以这一行对鼠标端没有任何影响）。
   */
  padding: calc(var(--space-2) + var(--safe-top)) calc(var(--space-4) + var(--safe-right))
    var(--space-2) calc(var(--space-4) + var(--safe-left));
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

/* 顶栏上的「存档 / 读档」按钮：顶栏用命令令牌，按钮跟着走
   （选择器带上 .shell__bar 提高优先级，确保盖过 BaseButton 自己的作用域样式） */
.shell__bar .shell__save {
  color: var(--color-command-ink);
  border-color: var(--color-command-line);
}

.shell__bar .shell__save:hover {
  background: var(--color-command-raised);
  color: var(--color-command-ink);
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
  display: flex;
  flex-direction: column;
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
