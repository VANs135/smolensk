<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag } from '@/components/base'
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

/**
 * 去掉标签里的**括号注记**（用户口径 #6：「（仅限空军）这种括号里的字不用加」）
 *
 * 只作用于**显示文本**：结构化信息仍在数据侧（段的 `sides` / `BARRAGE_SOURCES_BY_PHASE` 等），
 * 故"去掉括号"不丢信息 —— 地图上方那一条要的是关键字。
 */
function bareLabel(text: string): string {
  return text.replace(/（[^）]*）/gu, '').trim()
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

/** 会话形态的中文名 */
const formLabel = computed<string>(() => {
  switch (gameSession.form) {
    case 'created':
      return '未开局'
    case 'advancing':
      return '进行中'
    case 'awaiting':
      return '待答（须作答）'
    case 'terminated':
      return '已终止'
    default:
      return '未建会话'
  }
})

/** 最近一次连跑的去向（B5；自动段跑了几步、停在哪） */
const advanceLabel = computed<string>(() => {
  const outcome = gameSession.lastAdvanceOutcome
  if (outcome === null) return '—'
  if (outcome.steps === 0) {
    return outcome.stoppedBy === 'question' ? '停下待答（等作答）' : '未推进'
  }
  const where =
    outcome.stoppedBy === 'question'
      ? '待答'
      : outcome.stoppedBy === 'terminated'
        ? '本局终止'
        : outcome.stoppedBy === 'refused'
          ? '被内核拒绝'
          : outcome.stoppedBy === 'limit'
            ? '连跑上限'
            : (gameSession.guidance?.step.label ?? '玩家环节')
  return `自动段 ${outcome.steps} 步 → ${where}`
})

/**
 * 当前**环节**（B8 起是状态；B9 显示在这里）
 *
 * 用户口径：「玩家每个环节只能执行该环节能进行的操作」——界面上玩家得先看得见"现在在哪一环"，
 * 才知道下一步能做什么。故流程条给出：第几环 / 共几环 + 环节名 + 规则号 + **本环节可参与 N 枚**。
 */
const segmentLabel = computed<string>(() => {
  /*
   * E5（批 F·F2）：Pre-Turn 时 `workbench.phase` **表达不了**「回合准备」——
   * `ConsolePhase` 里没有 `preTurn`，`fromRecords` 取不到 ⇒ 回退到 `localPhase='movement'`，
   * 于是「阶段」行报「回合准备」、本行却报**移动**环节（错配）。
   * 现在：会话已建且处在 Pre-Turn ⇒ 改报**会话自己的子步**（天气判定 / 先手判定，见
   * `gameSession.guidance?.step`），不问 `workbench`。未开局（无会话）仍走原路（验证页依赖它）。
   */
  const phase = gameSession.records?.phase
  if (phase === 'preTurn' && gameSession.guidance !== null) {
    const step = gameSession.guidance.step
    return `${step.label}（${step.rule}）`
  }
  const step = workbench.segmentStep
  if (step === null)
    return workbench.segmentSteps.length === 0 ? '（本段无环节）' : '（本段无玩家环节）'
  const position = workbench.segmentStepPosition
  return `${step.label}（${step.rule}）· 第 ${position.index + 1}/${position.total} 环`
})

/** 本环节可参与的算子数（同一条 `participatesIn` 谓词算出来的，不是另写一句口径） */
const segmentTodoLabel = computed<string>(() => {
  if (workbench.segmentStep === null) return '—'
  return `本环节可参与 ${workbench.participatingUnitCount} 枚`
})

/** 当前被闸门拒绝的这一步（B8 记、B9 显示；与"操作反馈"区同一来源） */
const refusal = computed(() => workbench.actionRefusal)

/**
 * 按钮是否可用
 *
 * 未开局 ⇒ 可用（点它＝开局）；待答 ⇒ 不可用（先去待答面板作答，见 QuestionPrompt）；
 * 已终止 ⇒ 不可用（幂等：再点也不会继续）。
 */
const canAdvance = computed(
  () =>
    !gameSession.terminated &&
    !gameSession.awaiting &&
    (gameSession.session === null ||
      gameSession.form === 'created' ||
      gameSession.form === 'advancing'),
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
  if (gameSession.session === null) {
    ui.navigate(setup.applied && !setup.finished ? 'game' : 'scenario')
    return
  }
  workbench.advanceSegmentNow()
}

/** 未开局时这颗按钮的文案：说清"该去哪儿把初设收束"（不是"点我就开局"） */
const startHint = computed(() =>
  setup.applied && !setup.finished ? '去初设队列（完成初设即开局）' : '去选剧本 / 共识',
)

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
    <BaseTag kind="neutral">阶段 {{ bareLabel(phaseLabel) }}</BaseTag>
    <BaseTag :kind="workbench.segmentStep === null ? 'neutral' : 'info'">
      环节 {{ bareLabel(segmentLabel) }}
    </BaseTag>
    <BaseButton variant="primary" size="sm" :disabled="!canAdvance" @click="onAdvance">
      {{ gameSession.session === null ? startHint : '进入下一环节' }}
    </BaseButton>
    <span class="bar__hint num">{{ mapView.actionHint }}</span>
    <span v-if="refusal !== null" class="warn">
      <BaseTag kind="warning">{{ refusal.rule }}</BaseTag>
      {{ refusal.reason }}
    </span>
  </div>

  <BasePanel v-else title="流程条（2.2 流程表）">
    <div class="row">
      <BaseTag :kind="gameSession.terminated ? 'danger' : 'info'">{{ formLabel }}</BaseTag>
      <span class="num">
        回合 {{ gameSession.records?.turn ?? '—' }}({{ workbench.date }})｜先手方
        {{ gameSession.records?.firstPlayer ?? '未判定' }}｜天气
        {{ gameSession.records?.weather.air ?? '—' }}
      </span>
      <span class="num">剧本 {{ setup.scenarioId }}</span>
    </div>

    <!-- 三级：回合 → 阶段 → **环节**（B9：环节由 B8 的状态给出，与"段"分开显示） -->
    <div class="row">
      <BaseTag kind="neutral">阶段 {{ phaseLabel }}</BaseTag>
      <BaseTag :kind="workbench.segmentStep === null ? 'neutral' : 'info'">
        环节 {{ segmentLabel }}
      </BaseTag>
      <span class="num">{{ segmentTodoLabel }}</span>
      <span class="num">
        阶段 {{ currentIndex === null ? '—' : currentIndex + 1 }} / {{ SOP_STEPS.length }}
      </span>
    </div>

    <!-- 被闸门拒绝的这一步：就地在流程条上给一行（含规则号），不弹窗 -->
    <p v-if="refusal !== null" class="warn">
      <BaseTag kind="warning">{{ refusal.rule }}</BaseTag>
      这一步本环节不能做：{{ refusal.reason }}
    </p>

    <!--
      **动作提示带**（方案 §4.5；用户 2026-09-16：「地图窗口上方不应该有消息栏」）
      ⇒ 一行"现在该做什么"，紧跟在"环节"那行下面（原先挂在地图上方）。
      内容取自 `mapView.actionHint`（唯一实现：它手上同时有 workbench 与该店的三个待决提示）。
    -->
    <p class="hint num">
      <BaseTag kind="info">该做什么</BaseTag>
      {{ mapView.actionHint }}
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
      <BaseButton variant="primary" size="sm" :disabled="!canAdvance" @click="onAdvance">
        {{ gameSession.session === null ? startHint : '进入下一环节' }}
      </BaseButton>
      <span class="num">{{ advanceLabel }}</span>
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

    <p v-if="gameSession.awaiting" class="warn">
      停下待答（{{ gameSession.question?.rule }}）：在待答面板作答后，再点「进入下一环节」。
    </p>
    <p v-if="!gameSession.agreedRecorded && gameSession.session !== null" class="warn">
      开局共识结论尚未写入日志（4.0）：点「进入下一环节」会按当前勾选（默认一条都不用）写入。
    </p>

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

    <p v-if="gameSession.saveError !== null" class="warn">
      <BaseTag kind="danger">{{ gameSession.saveError.rule }}</BaseTag>
      存档被拒：{{ gameSession.saveError.reason }}（详见顶栏「存档 / 读档」对话框）
    </p>
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
