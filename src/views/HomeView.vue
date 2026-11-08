<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseButton, BaseDialog } from '@/components/base'
import { useGameSessionStore, useSetupStore, useUiStore } from '@/stores'

const game = useGameSessionStore()
const setup = useSetupStore()
const ui = useUiStore()
const confirmNew = ref(false)
const hasCurrent = computed(() => game.session !== null || (setup.applied && !setup.finished))

function onNewGame(): void {
  if (hasCurrent.value) {
    confirmNew.value = true
    return
  }
  ui.navigate('scenario')
}

function onRestart(): void {
  if (setup.restartGameNow()) {
    confirmNew.value = false
    ui.navigate('scenario')
  }
}
</script>

<template>
  <div class="home">
    <section class="home__hero" aria-labelledby="campaign-title">
      <div class="home__art" aria-hidden="true" />

      <div class="home__content">
        <span class="home__kicker num">OCS / 17</span>
        <h2 id="campaign-title" class="home__title">斯摩棱斯克</h2>
        <p class="home__subtitle">Smolensk: Barbarossa Derailed</p>

        <div class="actions">
          <button
            v-if="hasCurrent"
            class="home__action home__action--primary"
            type="button"
            @click="ui.navigate('game')"
          >
            继续当前对局 <span aria-hidden="true">→</span>
          </button>
          <button
            class="home__action"
            :class="{ 'home__action--primary': !hasCurrent }"
            type="button"
            @click="onNewGame"
          >
            新建对局 <span aria-hidden="true">→</span>
          </button>
          <button class="home__action" type="button" @click="ui.openSaveDialog()">
            读取存档 <span aria-hidden="true">↗</span>
          </button>
        </div>
      </div>
    </section>

    <BaseDialog v-model:open="confirmNew" title="新建对局">
      <p v-if="game.session !== null">新建会替换当前对局。需要保留进度时请先保存。</p>
      <p v-else>新建会替换当前初设。返回后可继续初设。</p>
      <template #footer>
        <BaseButton variant="secondary" @click="confirmNew = false">返回</BaseButton>
        <BaseButton variant="primary" @click="onRestart">确认新建</BaseButton>
      </template>
    </BaseDialog>
  </div>
</template>

<style scoped>
.home {
  display: grid;
  flex: 1;
  align-content: stretch;
  background: var(--color-command-bg);
  color: var(--color-command-ink);
}

.home__hero {
  position: relative;
  isolation: isolate;
  display: grid;
  align-items: center;
  min-height: min(680px, 83svh);
  overflow: hidden;
}

.home__art {
  position: absolute;
  z-index: -1;
  inset: 0 0 0 32%;
  background:
    linear-gradient(
      90deg,
      var(--color-command-bg),
      color-mix(in srgb, var(--color-command-bg) 42%, transparent) 30%,
      transparent 76%
    ),
    linear-gradient(0deg, var(--color-command-bg), transparent 27%),
    url('/map/Smolensk-map-011717.png') center 46% / cover;
}

.home__content {
  width: min(100%, 1440px);
  margin-inline: auto;
  padding: var(--space-16) clamp(var(--space-6), 7vw, 112px);
}

.home__kicker {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--color-command-teal);
  font-size: var(--text-sm);
  letter-spacing: 0.18em;
}

.home__kicker::before {
  width: var(--space-6);
  height: 2px;
  background: currentColor;
  content: '';
}

.home__title {
  margin: var(--space-3) 0 0;
  font-size: clamp(2.5rem, 6.1vw, 6.2rem);
  letter-spacing: 0;
}

.home__subtitle {
  margin: var(--space-1) 0 var(--space-8);
  color: var(--color-command-muted);
  font-size: clamp(var(--text-sm), 2.2vw, var(--text-xl));
}

.actions {
  display: grid;
  gap: var(--space-2);
  width: min(100%, 288px);
}

.home__action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  min-height: var(--space-12);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-md);
  background: var(--color-command-panel);
  color: var(--color-command-ink);
  font: inherit;
  font-weight: 700;
  text-align: left;
  cursor: pointer;
}

.home__action:hover {
  background: var(--color-command-raised);
  border-color: var(--color-command-muted);
}

.home__action--primary,
.home__action--primary:hover {
  border-color: var(--color-command-teal);
  background: var(--color-command-teal);
  color: var(--color-command-bg);
}

.home__action--primary:hover {
  background: color-mix(in srgb, var(--color-command-teal) 85%, var(--color-command-ink));
}

.home__action:focus-visible {
  outline-color: var(--color-command-amber);
}

@media (max-width: 720px) {
  .home__art {
    inset-inline-start: 0;
    background:
      linear-gradient(
        90deg,
        var(--color-command-bg) 4%,
        color-mix(in srgb, var(--color-command-bg) 75%, transparent) 66%,
        color-mix(in srgb, var(--color-command-bg) 47%, transparent)
      ),
      linear-gradient(0deg, var(--color-command-bg), transparent 45%),
      url('/map/Smolensk-map-011717.png') center / cover;
  }
}
</style>
