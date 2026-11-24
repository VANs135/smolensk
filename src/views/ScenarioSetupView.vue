<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { ConsensusChecklist } from '@/components/hotseat'
import { ScenarioBriefingDialog } from '@/components/setup'
import { provideUiMode } from '@/components/ui-mode'
import { scenarios } from '@/data'
import {
  useGameSessionStore,
  useHotseatStore,
  useSetupStore,
  useTutorialStore,
  useUiStore,
} from '@/stores'
import {
  setTutorialAirAllInactive,
  setTutorialFixedReinforcement,
} from '@/stores/tutorial-settings'

provideUiMode('formal')

const setup = useSetupStore()
const gameSession = useGameSessionStore()
const hotseat = useHotseatStore()
const tutorial = useTutorialStore()
const ui = useUiStore()

const modeOptions = computed(() => hotseat.MODE_LABELS)
const choices = computed(() => setup.scenarioChoices)

/**
 * 剧本记录的完整字段
 *
 * `setup.scenarioChoices` 只给选择器要用的投影（B10），教学标记/天气/先设不在其中；
 * 这里直接读数据，避免为了展示去改初设 store 的口径。
 */
const fullScenarios = computed(() => new Map(scenarios.scenarios.map((item) => [item.id, item])))

/** 剧本页明示 `1 player turn` 的教学剧本 */
function isTeachingScenario(id: string): boolean {
  return fullScenarios.value.get(id)?.singlePlayerTurn === true
}

/**
 * 默认落在**上次选的剧本**上（用户 2026-11-23 第 7 批更正）
 *
 * 教学与常规是**两种开局方式**，剧本本身两边都能选：
 * 修前把 Intro 从常规组剔掉、默认改动成"第一个非教学剧本"，等于玩家再也不能在正常 PvE 下打维捷布斯克。
 * 现在剧本列表保持原样（含 Intro），教学只是上面那一栏的另一个入口。
 */
const selectedId = ref(setup.scenarioId)
const selected = computed(() => choices.value.find((item) => item.id === selectedId.value) ?? null)

/** 首回合天气的中文名（`scenarios.json` 的 firstWeather） */
function weatherLabelOf(id: string): string {
  const weather = fullScenarios.value.get(id)?.firstWeather
  if (weather === undefined) return '—'
  return weather === 'restricted' ? '受限飞行（Limited Flight）' : '正常飞行'
}

/** 当前对局模式 / AI 方的静态名（初设开始后只显示这一行，不再摆一组不可用的单选） */
const modeLabel = computed(
  () => modeOptions.value.find((item) => item.key === hotseat.mode)?.label ?? '—',
)
const aiSideLabel = computed(() => (hotseat.aiSide === 'axis' ? '轴心国' : '苏联'))

const aiSideChoices = [
  { side: 'axis', label: '轴心国' },
  { side: 'soviet', label: '苏联' },
] as const

/** 目标窗对应的剧本（挂起时按挂起的剧本取；未挂起时按当前选中的剧本给标题） */
const briefingTarget = computed(
  () => fullScenarios.value.get(setup.briefingPendingId ?? selectedId.value) ?? null,
)

/** 目标窗开合＝store 的挂起状态（关闭即取消，不落盘） */
const briefingOpen = computed({
  get: () => setup.briefingPendingId !== null,
  set: (open: boolean) => {
    if (!open) setup.dismissBriefing()
  },
})

/* ── 用户 2026-11-18 第 2 条：Vitebsk 教学模式的独立开局方式 ── */

/**
 * 剧本卡片分成两组（用户 2026-11-23：教学入口单列，但**不把教学剧本从常规组拿走**）
 *
 * · 「教学模式」＝另一种开局方式（PvE 外壳 + 逐步引导 + 脚本代演苏军），只列能教学的剧本；
 * · 「常规剧本」＝全部剧本原样保留 —— Intro 维捷布斯克同样能在正常 PvE 下打
 *   （第 7 批更正：上一批把 Intro 从这一组剔掉是错的）。
 * 同一剧本在两组各有一张卡，靠 `tutorialMode` 区分"现在选中的是哪一种开局"。
 */
const teachingChoices = computed(() => choices.value.filter((item) => isTeachingScenario(item.id)))
const normalChoices = computed(() => choices.value)

/** 教学开关（选中教学剧本即开；换回常规剧本即关） */
const tutorialMode = ref(false)

/**
 * 纯 PVE 剧本（剧本页 `1 player turn`，当前仅 Intro: Vitebsk）
 *
 * 用户 2026-11-23：「维捷布斯克就仅限玩家扮演德军 PVE……苏军没有玩家回合，
 * 只能和在德军玩家交互时有选择」。⇒ 这一剧本的**对局组织方式不再可选**：
 * 玩家执先手方（轴心）、另一方由 AI 代演；苏军的"行动"只发生在玩家攻击时的应答里
 * （战斗选项/撤退落点，9.10 / 9.12）。教学模式只是同一外壳再加逐步引导。
 */
const soloPlayerScenario = computed(() => {
  const info = fullScenarios.value.get(selectedId.value)
  if (info?.singlePlayerTurn !== true) return null
  return info.firstPlayer === 'soviet'
    ? { playerLabel: '苏联', aiLabel: '轴心国', aiSide: 'axis' as const }
    : { playerLabel: '轴心国', aiLabel: '苏联', aiSide: 'soviet' as const }
})

/** 把纯 PVE 剧本的外壳落定（玩家执先手方，另一方 AI）；初设已锁定就不再改模式 */
function applySoloPveShell(): void {
  const shell = soloPlayerScenario.value
  if (shell === null || hotseat.setupLocked) return
  if (hotseat.mode !== 'pve') hotseat.setMode('pve')
  if (hotseat.aiSide !== shell.aiSide) hotseat.setAiSide(shell.aiSide)
}
applySoloPveShell()
/** 目标窗关掉前先记住这一局是不是教学，防止中途换剧本把标记带错 */
const pendingTutorial = ref(false)

function onTutorialChange(on: boolean): void {
  tutorialMode.value = on
  setTutorialAirAllInactive(on)
  setTutorialFixedReinforcement(on)
  if (!on) {
    tutorial.stop()
    return
  }
  // 教学固定正常天气 + **人机**（用户 2026-11-19：苏军由 AI 指挥，玩家只打轴心）
  gameSession.setFirstWeatherChoice('normal', selectedId.value)
  if (!hotseat.setupLocked) {
    hotseat.setMode('pve')
    hotseat.setAiSide('soviet')
  }
  tutorial.startFor()
}

/**
 * 点一张剧本卡
 *
 * 同一剧本可能有两张卡：`teaching=true` 的那张（教学模式）与常规那张。
 * 选哪张就决定开局方式，剧本 id 相同也不混淆；换到非教学剧本自然收起教学。
 */
function chooseScenarioCard(id: string, teaching = false): void {
  selectedId.value = id
  if (teaching && !tutorialMode.value) onTutorialChange(true)
  if (!teaching && tutorialMode.value) onTutorialChange(false)
  // 纯 PVE 剧本（Intro）：点它就把外壳落成「玩家执轴心、苏军 AI」
  applySoloPveShell()
}

/** 换到非教学剧本就收起教学开局，避免把未激活空军/引导带到别的剧本 */
watch(selectedId, (id) => {
  if (!isTeachingScenario(id) && tutorialMode.value) onTutorialChange(false)
})
/**
 * 进入初设（用户 2026-11-18 第 1 条）
 *
 * 先过「任务目标 / 胜利条件」窗：确认后才进初设；同一剧本本局已确认过则直接进。
 */
function onEnterSetup(): void {
  const target = selected.value
  if (target === null) return
  const teaching = tutorialMode.value && isTeachingScenario(target.id)
  pendingTutorial.value = teaching
  setTutorialAirAllInactive(teaching)
  setTutorialFixedReinforcement(teaching)
  // 纯 PVE 剧本（Intro）在进初设前再把外壳落定一次（换剧本后可能被上一局组织方式带偏）
  applySoloPveShell()
  if (teaching) {
    gameSession.setFirstWeatherChoice('normal', target.id)
    // 用户 2026-11-19：教学里的苏军是**人机对手**（AI 初设、AI 反应），玩家执轴心
    if (!hotseat.setupLocked) {
      hotseat.setMode('pve')
      hotseat.setAiSide('soviet')
    }
    tutorial.startFor()
  } else {
    tutorial.stop()
  }
  const result = setup.requestEnterSetup(target.id)
  if (result === 'blocked') {
    const failure = setup.lastAction
    pendingTutorial.value = false
    ui.pushToast('warning', `无法进入初设：${failure?.detail ?? '请重新选择剧本'}`)
    return
  }
  if (result === 'setup') ui.navigate('game')
}

/** 目标窗「确定」：确认后进入初设（窗口唯一出口） */
function onConfirmBriefing(): void {
  if (!setup.confirmBriefing()) {
    const failure = setup.lastAction
    ui.pushToast('warning', `无法进入初设：${failure?.detail ?? '请重新选择剧本'}`)
    return
  }
  if (pendingTutorial.value) tutorial.startFor()
  pendingTutorial.value = false
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
          v-if="selected !== null"
          class="scenario__enter"
          type="button"
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
          <!-- 教学模式**单列**：教学是一种开局方式，不是给剧本加的复选框（用户 2026-11-23） -->
          <section v-if="teachingChoices.length > 0" class="scenario__group">
            <header class="scenario__group-head">
              <h4>教学模式</h4>
              <span class="muted"
                >逐步引导 · 苏军由脚本代演（下面常规组的同一剧本可正常 PvE 打）</span
              >
            </header>
            <ul class="scenario__list">
              <li v-for="item in teachingChoices" :key="`teach-${item.id}`">
                <button
                  type="button"
                  class="scenario__card scenario__card--teach"
                  :class="{ 'scenario__card--on': item.id === selectedId && tutorialMode }"
                  :aria-pressed="item.id === selectedId && tutorialMode"
                  @click="chooseScenarioCard(item.id, true)"
                >
                  <span class="scenario__id num">{{ item.id.padStart(2, '0') }}</span>
                  <span class="scenario__entry">
                    <strong class="scenario__name">{{ item.name }}</strong>
                    <span class="scenario__date num"
                      >{{ item.firstTurn }} – {{ item.lastTurn }}</span
                    >
                    <span class="scenario__teach-tag num"> 教学 · 单回合 · 逐步引导 </span>
                  </span>
                  <span class="scenario__meta num">{{ item.turns }} 回合</span>
                  <span class="scenario__mark" aria-hidden="true">
                    {{ item.id === selectedId && tutorialMode ? '✓' : '' }}
                  </span>
                </button>
              </li>
            </ul>
          </section>

          <section class="scenario__group">
            <header class="scenario__group-head">
              <h4>常规剧本</h4>
              <span class="muted">{{ normalChoices.length }} 个 · 全部可正常 PvE 打</span>
            </header>
            <ul class="scenario__list">
              <li v-for="item in normalChoices" :key="item.id">
                <button
                  type="button"
                  class="scenario__card"
                  :class="{ 'scenario__card--on': item.id === selectedId && !tutorialMode }"
                  :aria-pressed="item.id === selectedId && !tutorialMode"
                  @click="chooseScenarioCard(item.id)"
                >
                  <span class="scenario__id num">{{ item.id.padStart(2, '0') }}</span>
                  <span class="scenario__entry">
                    <strong class="scenario__name">{{ item.name }}</strong>
                    <span class="scenario__date num"
                      >{{ item.firstTurn }} – {{ item.lastTurn }}</span
                    >
                  </span>
                  <span class="scenario__meta num">{{ item.turns }} 回合</span>
                  <span class="scenario__mark" aria-hidden="true">
                    {{ item.id === selectedId && !tutorialMode ? '✓' : '' }}
                  </span>
                </button>
              </li>
            </ul>
          </section>
        </section>

        <div class="scenario__side">
          <!-- 用户 2026-11-19：选择剧本界面不放地图（预览块已撤） -->
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
              <div>
                <dt>回合</dt>
                <dd class="num">{{ selected.turns }} 回合</dd>
              </div>
              <div>
                <dt>天气</dt>
                <!-- 教学剧本固定正常飞行（入口在「教学模式」那一栏，不再有勾选框） -->
                <dd v-if="tutorialMode" class="scenario__weather">
                  <span>正常飞行（教学固定）</span>
                </dd>
                <dd v-else-if="isTeachingScenario(selected.id)" class="scenario__weather">
                  <label>
                    <input
                      type="radio"
                      name="first-weather"
                      value="scenario"
                      :checked="gameSession.firstWeatherChoice === 'scenario'"
                      @change="gameSession.setFirstWeatherChoice('scenario', selected.id)"
                    />
                    <span>剧本原值</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="first-weather"
                      value="normal"
                      :checked="gameSession.firstWeatherChoice === 'normal'"
                      @change="gameSession.setFirstWeatherChoice('normal', selected.id)"
                    />
                    <span>正常飞行</span>
                  </label>
                </dd>
                <dd v-else>{{ weatherLabelOf(selected.id) }}</dd>
              </div>
              <div v-if="tutorialMode">
                <dt>教学</dt>
                <dd class="scenario__weather">
                  <span>玩家执轴心 · 苏军由脚本代演 · 逐步引导</span>
                </dd>
              </div>
              <div v-else-if="soloPlayerScenario">
                <dt>对局</dt>
                <dd class="scenario__weather">
                  <span>
                    纯 PVE：玩家执{{ soloPlayerScenario.playerLabel }}，{{
                      soloPlayerScenario.aiLabel
                    }}没有玩家回合（只在战斗时由 AI 作答 / 选撤退落点）
                  </span>
                </dd>
              </div>
            </dl>
            <fieldset class="scenario__modes">
              <legend>对局模式</legend>
              <p v-if="tutorialMode" class="modes__locked">人机（苏军 AI · 教学固定）</p>
              <p v-else-if="soloPlayerScenario" class="modes__locked">
                人机（玩家执{{ soloPlayerScenario.playerLabel }} ·
                {{ soloPlayerScenario.aiLabel }}由 AI 代演 · 剧本固定）
              </p>
              <ul v-else-if="!hotseat.setupLocked" class="modes">
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
                    <span class="modes__label">{{ item.label }}</span>
                  </label>
                </li>
              </ul>
              <p v-else class="modes__locked">{{ modeLabel }}</p>
            </fieldset>
            <fieldset
              v-if="hotseat.mode === 'pve' && !tutorialMode && !soloPlayerScenario"
              class="scenario__modes"
            >
              <legend>AI 控制方</legend>
              <ul v-if="!hotseat.setupLocked" class="modes">
                <li v-for="item in aiSideChoices" :key="item.side">
                  <label
                    class="modes__item"
                    :class="{ 'modes__item--on': hotseat.aiSide === item.side }"
                  >
                    <input
                      type="radio"
                      name="ai-side"
                      :value="item.side"
                      :checked="hotseat.aiSide === item.side"
                      @change="hotseat.setAiSide(item.side)"
                    />
                    <span class="modes__label">AI 打{{ item.label }}</span>
                  </label>
                </li>
              </ul>
              <p v-else class="modes__locked">AI 打{{ aiSideLabel }}</p>
            </fieldset>
          </section>

          <!-- 4.0：只在**选剧本之前**可勾定；开局后冻结，整块不再出现（不允许局内改） -->
          <details v-if="!gameSession.agreedLocked" class="scenario__sheet scenario__consensus">
            <summary class="scenario__heading" title="4.0">
              <span>开局共识</span>
              <span class="num">{{ gameSession.agreedCheckedCount }} 项</span>
            </summary>
            <ConsensusChecklist />
          </details>
        </div>
      </div>
    </div>

    <!-- 用户 2026-11-18 第 1 条：开局后、进初设前的任务目标 / 胜利条件窗（唯一入口） -->
    <ScenarioBriefingDialog
      v-model:open="briefingOpen"
      :title="`任务目标 / 胜利条件 · ${briefingTarget?.name ?? ''}`"
      :briefing="briefingTarget?.briefing ?? null"
      @confirm="onConfirmBriefing"
    />
  </div>
</template>

<style scoped>
.scenario {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
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
.scenario__facts dt {
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

/* 剧本分两栏（教学模式 / 常规剧本）：只用一条细线隔开，不再各套一张卡 */
.scenario__group {
  padding: var(--space-1) 0 var(--space-2);
}

.scenario__group + .scenario__group {
  border-top: 1px solid var(--color-command-line);
}

.scenario__group-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) 0;
}

.scenario__group-head h4 {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-command-ink);
}

.scenario__group-head .muted {
  font-size: var(--text-xs);
  color: var(--color-command-muted);
}

.scenario__card {
  display: grid;
  /* 2026-11-25 P2-1：id 列 40px 装不下教学剧本的「Intro」（5 字符），
     会和日期挤成「Intro5 Jul 41」⇒ 统一放到 48px，各行星号对齐。 */
  grid-template-columns: var(--space-12) minmax(0, 1fr) auto var(--space-4);
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

/* 教学卡与常规卡同一形状，只靠左侧一道金边区分（不额外加字、不换版式） */
.scenario__card--teach {
  border-left: 2px solid var(--color-gold);
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
  /* id 一律不折行（列宽 48px 已够「Intro」；本视图禁止 overflow:hidden，不设裁切） */
  white-space: nowrap;
}

.scenario__meta {
  white-space: nowrap;
}

.scenario__teach-tag {
  justify-self: start;
  padding: 0 var(--space-1);
  border: 1px solid var(--color-command-teal);
  border-radius: var(--radius-sm, 4px);
  color: var(--color-command-teal);
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

.scenario__weather {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.scenario__weather label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-weight: 700;
  cursor: pointer;
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

.modes__locked {
  margin: var(--space-2) 0 0;
  color: var(--color-command-muted);
  font-size: var(--text-sm);
  font-weight: var(--weight-ui);
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

/* ── 安卓壳：参考图式剧本选择（左列选剧本 + 右侧大地图预览 + 开始）──
 * 桌面端隐藏预览块，沿用上面的列表 + 设置双栏；只在安卓启用沉浸式布局。
 */

html[data-platform='android'] .scenario {
  padding: var(--safe-top) 12px calc(12px + var(--safe-bottom));
}

html[data-platform='android'] .scenario__frame {
  width: 100%;
  max-width: none;
  height: 100%;
  display: flex;
  flex-direction: column;
}

html[data-platform='android'] .scenario__bar {
  align-items: center;
  flex: none;
  margin-bottom: 10px;
}

html[data-platform='android'] .scenario__title {
  font-size: 20px;
}

html[data-platform='android'] .scenario__cols {
  flex: 1;
  min-height: 0;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  gap: 10px;
  align-items: stretch;
}

/* 用户 2026-11-19：剧本页不放地图，预览样式已撤 */

html[data-platform='android'] .scenario__side {
  min-height: 0;
  overflow-y: auto;
}

/* 竖屏窄屏：预览放上面（横向地图），列表与设置收下面，保持地图可见 */
@media (max-width: 720px) and (orientation: portrait) {
  html[data-platform='android'] .scenario__cols {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  html[data-platform='android'] .scenario__side {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
