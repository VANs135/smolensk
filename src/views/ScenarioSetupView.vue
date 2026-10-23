<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag } from '@/components/base'
import { ConsensusChecklist } from '@/components/hotseat'
import { useGameSessionStore, useHotseatStore, useSetupStore, useUiStore } from '@/stores'

/**
 * 前置「剧本 + 共识」视图（B10；用户口径⑨）
 *
 * ## 用户口径
 *   「可以在进入游戏界面前加一个**剧本选择界面**，选择剧本和共识后点击进入游戏，
 *    进入游戏界面**开始初设**」；「共识开关**默认全不勾**」。
 *
 * ## 它替代了哪一步
 *   此前"选剧本"藏在**对局台侧栏**的「初设与开局」面板里，玩家一进对局台就已经在一局里了。
 *   现在进入游戏的路径是：**开始台 → 本视图（选剧本 + 定共识）→ 进入游戏（开始初设）**，
 *   共识也在开局前就摆明了（默认一条都不用）。
 *
 * ## 分层纪律
 *   本视图只画与收点击：剧本列表来自 `setup.scenarioChoices`（`scenarios.json` 的投影），
 *   共识勾选走 `gameSession`（已有组件 `ConsensusChecklist`），"进入初设"走 `setup.enterSetup`
 *   ——**它不建会话、不进 Pre-Turn**（那是初设收束时「开始游戏」的事，见 `startGameNow`）。
 */

const setup = useSetupStore()
const gameSession = useGameSessionStore()
const hotseat = useHotseatStore()
const ui = useUiStore()

/**
 * B36（用户口径 #7）：**对局模式**单选
 *
 * 本处只把模式写进 store 的 setMode（它决定：交接屏要不要遮、战雾要不要裁）；
 * 模式的**说明文案**取自 store 的 MODE_LABELS，不在这里另写一遍（否则两处会走散）。
 */
const modeOptions = computed(() => hotseat.MODE_LABELS)

/** 选中项（列表里高亮它） */
const choices = computed(() => setup.scenarioChoices)

/** 当前选中剧本的说明行（用于"已选"提示，避免玩家来回确认） */
const selected = computed(() => choices.value.find((item) => item.selected) ?? null)

/** 首手方中文名 */
function sideLabel(side: 'axis' | 'soviet'): string {
  return side === 'axis' ? '轴心国' : '苏联'
}

/** 进入初设：按所选剧本落盘固定初设，然后进对局台（在那边做初设决策） */
function enterGame(): void {
  const target = selected.value
  if (target === null) return
  if (!setup.enterSetup(target.id)) {
    const failure = setup.lastAction
    ui.pushToast('warning', `进入初设被拒（${failure?.rule ?? '初设'}）：${failure?.detail ?? ''}`)
    return
  }
  ui.navigate('game')
}
</script>

<template>
  <div class="scenario">
    <header class="scenario__bar">
      <BaseTag kind="info">进入游戏前</BaseTag>
      <span class="scenario__title">剧本与共识</span>
      <BaseButton variant="ghost" size="sm" @click="ui.navigate('home')">返回开始台</BaseButton>
      <BaseButton variant="primary" size="sm" @click="enterGame">进入游戏（开始初设）</BaseButton>
    </header>

    <!-- B36（用户口径 #7）：对局模式（solo / PVP / PVE） -->
    <BasePanel title="对局模式">
      <ul class="modes">
        <li v-for="item in modeOptions" :key="item.key">
          <label class="modes__item" :class="{ 'modes__item--on': hotseat.mode === item.key }">
            <input
              type="radio"
              name="hotseat-mode"
              :value="item.key"
              :checked="hotseat.mode === item.key"
              @change="hotseat.setMode(item.key)"
            />
            <span class="modes__label">{{ item.label }}</span>
            <span class="modes__note muted num">{{ item.note }}</span>
          </label>
        </li>
      </ul>
      <p class="muted">
        模式只影响**交接屏与战雾**（solo：不遮屏、双方内容可见；PVP：热坐交接 + 4.9a 裁剪； PVE
        暂未实现）。它不改变任何规则判定。
      </p>
    </BasePanel>

    <div class="scenario__cols">
      <BasePanel title="剧本（7 个剧本页）">
        <p class="muted">
          选中即按该剧本**自动初设**无需玩家定夺的部分（固定格号 / 死亡堆 / 多点位 / 军力减损），
          其余项进游戏后在初设里决定。剧本号只此一处选择（对局台内不再重复选择）。
        </p>
        <ul class="scenario__list">
          <li v-for="item in choices" :key="item.id">
            <button
              type="button"
              class="scenario__card"
              :class="{ 'scenario__card--on': item.selected }"
              @click="setup.enterSetup(item.id)"
            >
              <span class="scenario__id num">{{ item.id }}</span>
              <span class="scenario__name">{{ item.name }}</span>
              <span class="scenario__meta num">
                {{ item.turns }} 回合 · {{ item.firstTurn }} → {{ item.lastTurn }} · 首手
                {{ sideLabel(item.firstPlayer) }}
              </span>
              <span class="scenario__flags">
                <BaseTag v-if="item.hasSetup" kind="neutral">自带初设页</BaseTag>
                <BaseTag v-else-if="item.sharedSetupWith.length > 0" kind="neutral">
                  共用剧本 {{ item.sharedSetupWith.join(' / ') }} 的初设
                </BaseTag>
                <BaseTag v-if="item.selected" kind="success">已选</BaseTag>
              </span>
            </button>
          </li>
        </ul>
        <p v-if="setup.lastAction !== null" class="num muted">
          {{ setup.lastAction.ok ? '初设' : '被拒' }}（{{ setup.lastAction.rule }}）：
          {{ setup.lastAction.detail }}
        </p>
      </BasePanel>

      <div class="scenario__side">
        <!-- 共识：默认一条都不用（用户口径⑨）；勾选结论在初设收束「开始游戏」时写入日志 -->
        <ConsensusChecklist />
        <BasePanel title="接下来会发生什么">
          <p class="muted">
            进入游戏界面后先做**初设**：飞行单位落格、自由项落位、卡车满载、SP 归属等；
            初设收束点「开始游戏」才建会话、写共识结论并进入回合准备（2.2）。
          </p>
          <p v-if="gameSession.session !== null" class="muted num">
            注意：本会话已开局（剧本 {{ gameSession.scenarioId }}）⇒ 换剧本会被拒（2.2），
            要换剧本请先在会话面板重置。
          </p>
        </BasePanel>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scenario {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.scenario__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md);
  background: var(--color-panel);
}

.scenario__title {
  font-family: var(--font-head);
  font-weight: 700;
  letter-spacing: 0.02em;
  margin-right: auto;
}

/* B36：对局模式一排（solo / PVP / PVE） */
.modes {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.modes__item {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  cursor: pointer;
  font-size: var(--text-sm);
}

.modes__item--on {
  border-color: var(--color-accent);
  background: var(--color-panel);
  box-shadow: var(--shadow-sm);
}

.modes__label {
  font-weight: 600;
}

.modes__note {
  font-size: var(--text-xs);
}

.scenario__cols {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
  gap: var(--space-2);
  align-items: start;
}

@media (max-width: 900px) {
  .scenario__cols {
    grid-template-columns: minmax(0, 1fr);
  }
}

.scenario__side {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.scenario__list {
  margin: var(--space-1) 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--space-2);
}

.scenario__card {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-ink);
  text-align: left;
  cursor: pointer;
}

.scenario__card:hover {
  border-color: var(--color-accent);
}

.scenario__card--on {
  border-color: var(--color-accent);
  background: var(--color-panel);
  box-shadow: var(--shadow-sm);
}

.scenario__id {
  font-weight: 700;
}

.scenario__name {
  font-family: var(--font-head);
}

.scenario__meta {
  color: var(--color-muted);
  font-size: var(--text-xs);
}

.scenario__flags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: 2px;
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
  margin: var(--space-1) 0 0;
}
</style>
