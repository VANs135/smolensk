<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag } from '@/components/base'
import { buildFlowGuide, type FlowForm } from '@/engine/flow-model'
import { SOP_STEPS, type SopStep } from '@/engine/session-flow'
import {
  useGameSessionStore,
  useMapViewStore,
  useSetupStore,
  useUiStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 流程条（B5 重写；2.2 流程表三级 + **唯一**「进入下一环节」）
 *
 * ## 用户口径（2026-09-16 ⑩）
 *   「点击进入下一个阶段后，**自动进行的阶段不需要玩家介入**，直到开始玩家要介入的环节……
 *    新的必须是点击**自动进入下一环节**，**不需要额外的按钮**」；
 *   「自动阶段一定要自动进行：例如后手玩家进击段的战斗环节结束后，自动清理、自动判天气、事件，
 *    玩家要做的第一件事：若存在需要玩家决定的事件**先让玩家决定**，然后判定先后手选择」。
 *
 * 于是本组件只有一个动作按钮：**进入下一环节** ——它一次点下去就把自动段（天气 / 清理 / 换回合）
 * 一路结算完，停在①需玩家作答处（2.3 先手选择 / 开局共识）或②需要玩家的环节（A–G）。
 *
 * ## 三级显示（**三个层级各自对应流程表里的一级**，别混）
 *
 * | 层级     | 取自哪里                                                                 | 本组件怎么显示 |
 * | -------- | ------------------------------------------------------------------------ | -------------- |
 * | **回合** | 回合轨（19 回合；第 1 回合 = 1941-07-08）                                  | 第一行：回合号 + 日期 + 先手方 + 天气 |
 * | **阶段** | 2.2 流程表的**段**：天气判定 / 先手判定 / A–H（先手方与后手方各一遍）/ 推进回合标记，共 **19 项** | 第二行的「阶段」标签 + 下方 **19 格阶段灯**（已过 / 当前 / 未到） |
 * | **环节** | **段名原文里的子步**（C＝突围/模式与移动/轰炸；E＝移动/轰炸；F＝炮击/战斗；G＝移动/轰炸/战斗） | 第二行的「环节」标签（第 n/m 环 + 名称 + 规则号）+ 本环节可参与数 |
 *
 * ★ 19 格是**阶段灯**（每格一个"段"），不是环节灯——环节只在段内走，故 19 格不随环节增减。
 * ★ Pre-Turn 的原文把「天气判定 / 先手判定」列在**段**一级（`charts.json → tables.sop`），
 *   而引擎把它们建成 `preTurn` 段的两个子步 ⇒ 显示上：阶段＝「回合准备」，环节＝「天气判定 / 先手判定」。
 *
 * ## 分层纪律
 *   本组件只画与收点击；结论全部来自 store（`workbench.advanceSegmentNow()` → 会话连跑）。
 *   渐进式诊断（一步一步点）留给**引擎验证页**：传 `stepwise` 即同时给出「推进一步」。
 */

const props = withDefaults(
  defineProps<{
    /** 同时给出「推进一步」（引擎验证页用；对局台不传） */
    stepwise?: boolean
    /**
     * 形态（用户口径 #6）
     *
     * · `panel`（缺省）：完整面板 —— 阶段灯 / 会话日志 / 重置 / 5.0b 勾选 / 共识提示全在（右栏与验证页用）；
     * · `bar`：**地图窗口上方的一条线** —— 只留「阶段名 + 环节名 + 推进按钮 + 一行该做什么」。
     */
    variant?: 'panel' | 'bar'
  }>(),
  { stepwise: false, variant: 'panel' },
)

/** 是不是"地图上方那一条" */
const isBar = computed<boolean>(() => props.variant === 'bar')

const gameSession = useGameSessionStore()
const workbench = useWorkbenchStore()
const setup = useSetupStore()
// 批 E 切片 1：未开局时本按钮只做**视图引导**（开局唯一入口＝初设收束点）
const ui = useUiStore()
/** 动作提示带的来源（`mapView.actionHint`；用户口径：地图上方不放消息栏 ⇒ 搬到这里） */
const mapView = useMapViewStore()

/** 当前步序号（null = 无法确定） */
const currentIndex = computed<number | null>(() => gameSession.guidance?.index ?? null)

/**
 * 阶段的中文名（2.2 流程表的**段**：天气 / 先手 / A–H / 推进回合标记）
 *
 * E5（批 F·F2）：修前本行**只读** `gameSession.records?.phase` ⇒ 初设期（会话未建）恒报
 * '—'，而「环节」行读的是 `workbench` 的段/子步 ⇒ 两行必然错配（一行空、一行有内容）。
 * 现在：未开局时改与「环节」行**同源**（`workbench.phase` 本身就是"会话优先、否则本地演练"），
 * 只把它翻成段名；**不动 store 的回退口径**（那是验证页与既有测试依赖的）。
 */
const phaseLabel = computed<string>(() => {
  const phase = gameSession.records?.phase
  if (phase === undefined) return workbench.PHASE_LABELS[workbench.phase] ?? '—'
  // Pre-Turn 的原文把两项列在段一级，但引擎建成一个段的两个子步 ⇒ 这里只报段名，
  // 「天气判定 / 先手判定」由下面的**环节**行显示（否则同一件事在两行里各说一遍）
  if (phase === 'preTurn') return '回合准备'
  if (phase === 'turnEnd') return '回合结束'
  return phase
})

/** 步骤归属标记（先手方 / 后手方 / 回合级） */
function roleMark(step: SopStep): string {
  if (step.role === 'first') return '先'
  if (step.role === 'second') return '后'
  return '回'
}

/** 步骤短名（去掉角色前缀，便于窄格显示） */
function shortLabel(step: SopStep): string {
  return step.label.replace(/^(先手方|后手方) · /, '')
}

/** 步骤驱动方式的中文名 */
function driverLabel(step: SopStep): string {
  if (step.driver === 'automatic') return '自动'
  if (step.driver === 'question') return '待答'
  return '操作'
}

/** 该格的状态（已完成 / 当前 / 未到） */
function stepState(index: number): 'done' | 'current' | 'todo' {
  const current = currentIndex.value
  if (current === null) return 'todo'
  if (index < current) return 'done'
  return index === current ? 'current' : 'todo'
}

/** 当前被闸门拒绝的这一步（B8 记、B9 显示；与"操作反馈"区同一来源） */
const refusal = computed(() => workbench.actionRefusal)

/**
 * 段内环节展示事实（Pre-Turn 报会话子步；其余报 workbench 段内环节）
 *
 * E5（批 F·F2）：`workbench.phase` 表达不了「回合准备」，故 Pre-Turn 时改报会话自己的子步。
 * 这里只整理事实，不做规则判断。
 */
const segmentFacts = computed<{
  step: { label: string; rule: string } | null
  position: { index: number; total: number } | null
}>(() => {
  const phase = gameSession.records?.phase
  if (phase === 'preTurn' && gameSession.guidance !== null) {
    const step = gameSession.guidance.step
    return { step: { label: step.label, rule: step.rule }, position: null }
  }
  const step = workbench.segmentStep
  if (step === null) return { step: null, position: null }
  return {
    step: { label: step.label, rule: step.rule },
    position: workbench.segmentStepPosition,
  }
})

/**
 * UI2：**唯一的只读投影** —— 行动方 / 操作者 / 阻断 / 下一步
 *
 * 所有输入都是既有 store / 引擎事实；组件不再各算一份按钮可用态与文案。
 */
const flow = computed(() =>
  buildFlowGuide({
    sessionExists: gameSession.session !== null,
    form: (gameSession.form ?? 'none') as FlowForm,
    terminated: gameSession.terminated,
    awaiting: gameSession.awaiting,
    questionRule: gameSession.question?.rule ?? null,
    currentStep: currentIndex.value === null ? null : (SOP_STEPS[currentIndex.value] ?? null),
    currentIndex: currentIndex.value,
    sopLength: SOP_STEPS.length,
    firstPlayer: gameSession.records?.firstPlayer ?? null,
    phaseLabel: phaseLabel.value,
    segmentStep: segmentFacts.value.step,
    segmentPosition: segmentFacts.value.position,
    segmentStepsCount: workbench.segmentSteps.length,
    participatingUnitCount: workbench.participatingUnitCount,
    refusal: refusal.value,
    actionHint: mapView.actionHint,
    advanceOutcome: gameSession.lastAdvanceOutcome,
    setupApplied: setup.applied,
    setupFinished: setup.finished,
    agreedRecorded: gameSession.agreedRecorded,
    saveError: gameSession.saveError,
  }),
)

/**
 * 唯一点击入口：未开局则**引导去初设**，否则连跑到下一个需要玩家的地方
 *
 * ★ 批 E 切片 1（用户口径 9.17③b「两个开局按钮 + 一个开始游戏，应统一」）：
 *   **建会话（开局）只允许从初设收束点发生** —— 地图左上角「待你决定」队列落满后的
 *   「完成初设」（`DecisionQueue` → store 的 `startGameNow`）。本按钮在未开局时**不再建会话**，
 *   而是**引导到初设收束点**：对局台上就把那支队列点出来（`setup.applied` 的初设正在跑），
 *   否则先去剧本/共识前置视图（`ScenarioSetupView`）把初设开起来。
 */
function onAdvance(): void {
  if (flow.value.nextActionTarget !== 'advance') {
    ui.navigate(flow.value.nextActionTarget === 'setup' ? 'game' : 'scenario')
    return
  }
  workbench.advanceSegmentNow()
}

/** 日志尾部（最近 6 条；Smoke 第 2 项要看的就是「自动段在日志里连续出现」） */
const logTail = computed(() => gameSession.log.slice(-6).reverse())
</script>

<template>
  <!--
    bar 形态（对局台）：地图上方的一条线 —— 阶段名 + 环节名 + 唯一推进按钮 + 一行「该做什么」。
    其余（回合/天气摘要、阶段灯、日志、重置、5.0b 勾选、共识提示）只在 panel 形态出现。
  -->
  <div v-if="isBar" class="bar">
    <span class="bar__title">流程条</span>
    <BaseTag kind="neutral">阶段 {{ flow.phaseLabel }}</BaseTag>
    <BaseTag :kind="flow.segmentLabel === '（本段无环节）' ? 'neutral' : 'info'">
      环节 {{ flow.segmentLabel }}
    </BaseTag>
    <BaseTag kind="neutral">{{ flow.actingSideLabel }} · {{ flow.decisionRoleLabel }}</BaseTag>
    <BaseButton variant="primary" size="sm" :disabled="!flow.canAdvance" @click="onAdvance">
      {{ flow.nextActionLabel }}
    </BaseButton>
    <span class="bar__hint num">{{ flow.hint }}</span>
    <span v-if="flow.blockers.length > 0" class="warn">
      <BaseTag :kind="flow.blockers[0]!.kind === 'danger' ? 'danger' : 'warning'" />
      {{ flow.blockers[0]!.text }}
    </span>
  </div>

  <BasePanel v-else title="流程条（2.2 流程表）">
    <div class="row">
      <BaseTag :kind="gameSession.terminated ? 'danger' : 'info'">{{ flow.formLabel }}</BaseTag>
      <BaseTag kind="neutral">{{ flow.actingSideLabel }}</BaseTag>
      <BaseTag kind="neutral">{{ flow.decisionRoleLabel }}</BaseTag>
      <span class="num">
        回合 {{ gameSession.records?.turn ?? '—' }}({{ workbench.date }})｜先手方
        {{ gameSession.records?.firstPlayer ?? '未判定' }}｜天气
        {{ gameSession.records?.weather.air ?? '—' }}
      </span>
      <span class="num">剧本 {{ setup.scenarioId }}</span>
    </div>

    <!-- 三级：回合 → 阶段 → **环节**（B9：环节由 B8 的状态给出，与"段"分开显示） -->
    <div class="row">
      <BaseTag kind="neutral">阶段 {{ flow.phaseLabel }}</BaseTag>
      <BaseTag :kind="flow.segmentLabel === '（本段无环节）' ? 'neutral' : 'info'">
        环节 {{ flow.segmentLabel }}
      </BaseTag>
      <span class="num">{{ flow.todoLabel }}</span>
      <span class="num">
        阶段 {{ flow.stageIndex === null ? '—' : flow.stageIndex + 1 }} / {{ flow.stageTotal }}
      </span>
    </div>

    <!-- 阻断清单（UI2）：拒绝 / 待答 / 共识未落账 / 存档失败，统一由 flow-model 投影 -->
    <p v-for="(blocker, index) in flow.blockers" :key="index" class="warn">
      <BaseTag
        v-if="blocker.rule !== null"
        :kind="blocker.kind === 'danger' ? 'danger' : 'warning'"
      >
        {{ blocker.rule }}
      </BaseTag>
      {{ blocker.text }}
    </p>

    <!--
      **动作提示带**（方案 §4.5；用户 2026-09-16：「地图窗口上方不应该有消息栏」）
      ⇒ 一行"现在该做什么"，紧跟在"环节"那行下面（原先挂在地图上方）。
      内容取自 `mapView.actionHint`（唯一实现：它手上同时有 workbench 与该店的三个待决提示）。
    -->
    <p class="hint num">
      <BaseTag kind="info">该做什么</BaseTag>
      {{ flow.hint }}
    </p>

    <!-- **阶段灯**（不是环节灯）：一个回合的 19 个**段**（先/后手各 A–H + Pre-Turn 2 + 回合结束 1） -->
    <div class="strip">
      <div
        v-for="(step, index) in SOP_STEPS"
        :key="step.id"
        class="strip__cell"
        :class="`strip__cell--${stepState(index)}`"
        :title="`${index + 1}. ${step.label}（${step.rule}）· ${driverLabel(step)}`"
      >
        <span class="strip__role">{{ roleMark(step) }}</span>
        <span class="strip__label">{{ shortLabel(step) }}</span>
        <span class="strip__driver">{{ driverLabel(step) }}</span>
      </div>
    </div>

    <div class="row">
      <BaseButton variant="primary" size="sm" :disabled="!flow.canAdvance" @click="onAdvance">
        {{ flow.nextActionLabel }}
      </BaseButton>
      <span class="num">{{ flow.advanceLabel }}</span>
      <!-- 引擎验证页专用：一步一步点，便于逐段核对 -->
      <BaseButton
        v-if="props.stepwise"
        variant="secondary"
        size="sm"
        :disabled="gameSession.session === null || gameSession.awaiting || gameSession.terminated"
        @click="gameSession.stepNow()"
      >
        推进一步（验证用）
      </BaseButton>
      <BaseButton variant="ghost" size="sm" @click="gameSession.resetGame()">重置</BaseButton>
      <label class="field">
        <input v-model="gameSession.earlyDecisionMet" type="checkbox" />
        盘面已达成 5.0b 提前决胜
      </label>
    </div>

    <!-- 审计尾部：自动段与作答都在此留痕 -->
    <details class="more">
      <summary>会话日志（最近 6 条）</summary>
      <p v-for="(entry, index) in logTail" :key="index" class="num">
        <BaseTag kind="neutral">T{{ entry.turn }}</BaseTag>
        {{ entry.phase }}｜{{ entry.side }}｜{{ entry.action }}｜{{ entry.outcome.rule }}
        <template v-if="entry.rolls.length > 0">
          ｜掷骰 {{ entry.rolls.map((roll) => roll.total).join('/') }}
        </template>
      </p>
      <p v-if="logTail.length === 0" class="muted">尚无日志（先点「开局」）。</p>
    </details>

    <p v-if="gameSession.error !== null" class="warn">
      <BaseTag kind="danger">{{ gameSession.error.rule }}</BaseTag>
      内核拒绝：{{ gameSession.error.reason }}
    </p>
  </BasePanel>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin: var(--space-2) 0;
}

.strip__cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 62px;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  font-size: var(--text-xs);
  color: var(--color-muted);
}

.strip__cell--done {
  background: var(--color-success-bg);
  color: var(--color-ink);
}

.strip__cell--current {
  border-color: var(--color-accent);
  background: var(--color-panel);
  color: var(--color-ink);
  box-shadow: var(--shadow-sm);
}

.strip__role {
  font-weight: 700;
}

.strip__label {
  white-space: nowrap;
}

.strip__driver {
  font-size: var(--text-xs);
  opacity: 0.8;
}

.more {
  font-size: var(--text-sm);
  color: var(--color-muted);
}

/* B35：地图上方那一条（阶段性关键字，不占纵向空间） */
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--color-rule);
  background: var(--color-bg-2);
  font-size: var(--text-sm);
}

.bar__title {
  font-weight: 600;
  color: var(--color-muted);
}

.bar__hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 动作提示带（一行；与"环节"那一行同一处，见用户口径） */
.hint {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  margin: var(--space-1) 0;
  color: var(--color-ink);
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.warn {
  color: var(--color-accent);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}
</style>
