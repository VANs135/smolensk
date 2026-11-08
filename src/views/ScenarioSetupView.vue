<script setup lang="ts">
import { computed, ref } from 'vue'

import { ConsensusChecklist } from '@/components/hotseat'
import { provideUiMode } from '@/components/ui-mode'
import { useGameSessionStore, useHotseatStore, useSetupStore, useUiStore } from '@/stores'

provideUiMode('formal')

const setup = useSetupStore()
const gameSession = useGameSessionStore()
const hotseat = useHotseatStore()
const ui = useUiStore()

const modeOptions = computed(() => hotseat.MODE_LABELS)
const choices = computed(() => setup.scenarioChoices)
const selectedId = ref(setup.scenarioId)
const selected = computed(() => choices.value.find((item) => item.id === selectedId.value) ?? null)

const modeCopy = {
  solo: { label: '单人推演', note: '双方盘面可见' },
  pvp: { label: '双人热坐', note: '交接遮屏 · §4.9a' },
  pve: { label: '人机对局', note: '在棋桌选择 AI 方' },
} as const

function onEnterSetup(): void {
  const target = selected.value
  if (target === null) return
  if (!setup.enterSetup(target.id)) {
    const failure = setup.lastAction
    const message = failure?.detail ?? '请重新选择剧本'
    ui.pushToast('warning', `无法进入初设（§${failure?.rule ?? '2.2'}）${message}`)
    return
  }
  ui.navigate('game')
}
</script>

<template>
  <div class="scenario">
    <div class="scenario__frame">
      <header class="scenario__bar">
        <div>
          <button class="scenario__back" type="button" @click="ui.navigate('home')">
            <span aria-hidden="true">←</span> 开始台
          </button>
          <h2 class="scenario__title">战役部署</h2>
        </div>
        <button
          class="scenario__enter"
          type="button"
          :disabled="selected === null"
          @click="onEnterSetup"
        >
          进入初设 <span aria-hidden="true">→</span>
        </button>
      </header>

      <div class="scenario__cols">
        <section class="scenario__sheet" aria-labelledby="scenario-choice-title">
          <header class="scenario__heading">
            <h3 id="scenario-choice-title">选择剧本</h3>
            <span class="num">{{ choices.length }} 个剧本</span>
          </header>
          <ul class="scenario__list">
            <li v-for="item in choices" :key="item.id">
              <button
                type="button"
                class="scenario__card"
                :class="{ 'scenario__card--on': item.id === selectedId }"
                :aria-pressed="item.id === selectedId"
                @click="selectedId = item.id"
              >
                <span class="scenario__id num">{{ item.id.padStart(2, '0') }}</span>
                <span class="scenario__entry">
                  <strong class="scenario__name">{{ item.name }}</strong>
                  <span class="scenario__date num">{{ item.firstTurn }} – {{ item.lastTurn }}</span>
                </span>
                <span class="scenario__meta num">{{ item.turns }} 回合</span>
                <span class="scenario__mark" aria-hidden="true">
                  {{ item.id === selectedId ? '✓' : '' }}
                </span>
              </button>
            </li>
          </ul>
        </section>

        <div class="scenario__side">
          <section v-if="selected !== null" class="scenario__sheet" aria-labelledby="mode-title">
            <header class="scenario__heading">
              <h3 id="mode-title">对局设置</h3>
              <span class="num">剧本 {{ selected.id }}</span>
            </header>
            <dl class="scenario__facts">
              <div>
                <dt>先手</dt>
                <dd>{{ selected.firstPlayer === 'axis' ? '轴心国' : '苏联' }}</dd>
              </div>
              <div>
                <dt>初设</dt>
                <dd v-if="selected.hasSetup">独立</dd>
                <dd v-else-if="selected.sharedSetupWith.length > 0">
                  共用 {{ selected.sharedSetupWith.join(' / ') }}
                </dd>
                <dd v-else>—</dd>
              </div>
            </dl>
            <fieldset class="scenario__modes">
              <legend>对局模式</legend>
              <ul class="modes">
                <li v-for="item in modeOptions" :key="item.key">
                  <label
                    class="modes__item"
                    :class="{ 'modes__item--on': hotseat.mode === item.key }"
                  >
                    <input
                      type="radio"
                      name="hotseat-mode"
                      :value="item.key"
                      :checked="hotseat.mode === item.key"
                      @change="hotseat.setMode(item.key)"
                    />
                    <span class="modes__label">{{ modeCopy[item.key].label }}</span>
                    <span class="modes__note">{{ modeCopy[item.key].note }}</span>
                  </label>
                </li>
              </ul>
            </fieldset>
          </section>

          <details class="scenario__sheet scenario__consensus">
            <summary class="scenario__heading">
              <span>开局共识</span>
              <span class="num">{{ gameSession.agreedCheckedCount }} 项 · §4.0</span>
            </summary>
            <ConsensusChecklist />
          </details>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scenario {
  flex: 1;
  padding: var(--space-8) clamp(var(--space-4), 5vw, var(--space-16));
  background: var(--color-command-bg);
  color: var(--color-command-ink);
  color-scheme: dark;
}

.scenario__frame {
  width: min(100%, 1180px);
  margin-inline: auto;
}

.scenario__bar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}

.scenario__back {
  margin: 0 0 var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-command-muted);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
}

.scenario__back:hover {
  border-color: var(--color-command-line);
  color: var(--color-command-ink);
}

.scenario__title {
  margin: 0;
  font-size: clamp(1.8rem, 4vw, 3.2rem);
}

.scenario__enter {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  min-height: var(--space-12);
  padding: var(--space-2) var(--space-5);
  border: 1px solid var(--color-command-teal);
  border-radius: var(--radius-md);
  background: var(--color-command-teal);
  color: var(--color-command-bg);
  font: inherit;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
}

.scenario__enter:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-command-teal) 85%, var(--color-command-ink));
}

.scenario__enter:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.scenario :focus-visible {
  outline-color: var(--color-command-amber);
}

.scenario__cols {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(300px, 1fr);
  gap: var(--space-4);
  align-items: start;
}

.scenario__side {
  display: grid;
  gap: var(--space-4);
}

.scenario__sheet {
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-lg);
  background: var(--color-command-panel);
}

.scenario__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-command-line);
  font-weight: 700;
}

.scenario__heading h3 {
  margin: 0;
  font-size: 1rem;
}

.scenario__heading .num,
.scenario__date,
.scenario__meta,
.scenario__facts dt,
.modes__note {
  color: var(--color-command-muted);
  font-size: var(--text-xs);
}

.scenario__list,
.modes {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-2);
  list-style: none;
}

.scenario__card {
  display: grid;
  grid-template-columns: var(--space-10) minmax(0, 1fr) auto var(--space-4);
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--space-12);
  padding: var(--space-1) var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-command-ink);
  font: inherit;
  line-height: 1.35;
  text-align: left;
  cursor: pointer;
}

.scenario__card:hover {
  background: var(--color-command-raised);
}

.scenario__card--on,
.scenario__card--on:hover {
  border-color: var(--color-command-teal);
  background: var(--color-command-teal-bg);
}

.scenario__entry {
  display: grid;
  gap: var(--space-1);
}

.scenario__id,
.scenario__mark {
  color: var(--color-command-teal);
  text-align: center;
}

.scenario__id {
  font-weight: 700;
}

.scenario__meta {
  white-space: nowrap;
}

.scenario__facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0;
  padding: var(--space-3) var(--space-4);
}

.scenario__facts dd {
  margin: 0;
  font-weight: 700;
}

.scenario__modes {
  min-width: 0;
  margin: 0;
  padding: 0 var(--space-2) var(--space-2);
  border: 0;
}

.scenario__modes legend {
  margin-inline: var(--space-2);
  color: var(--color-command-muted);
  font-size: var(--text-xs);
}

.modes {
  padding: var(--space-2) 0 0;
}

.modes__item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-height);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-md);
  background: var(--color-command-bg);
  font-size: var(--text-sm);
  cursor: pointer;
}

.modes__item:hover {
  border-color: var(--color-command-muted);
}

.modes__item--on,
.modes__item--on:hover {
  border-color: var(--color-command-teal);
  background: var(--color-command-teal-bg);
}

.modes__item input {
  accent-color: var(--color-command-teal);
}

.modes__label {
  font-weight: 700;
}

.modes__note {
  margin-left: auto;
}

.scenario__consensus summary {
  justify-content: flex-start;
  border-bottom: 0;
  cursor: pointer;
  list-style: none;
}

.scenario__consensus summary::-webkit-details-marker {
  display: none;
}

.scenario__consensus summary::before {
  color: var(--color-command-teal);
  content: '+';
}

.scenario__consensus[open] summary {
  border-bottom: 1px solid var(--color-command-line);
}

.scenario__consensus[open] summary::before {
  content: '−';
}

.scenario__consensus summary .num {
  margin-left: auto;
}

@media (max-width: 840px) {
  .scenario__cols {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 480px) {
  .scenario__card {
    grid-template-columns: var(--space-6) minmax(0, 1fr) auto var(--space-3);
  }
}
</style>
