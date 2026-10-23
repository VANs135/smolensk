<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseButton, BasePanel, BaseTag } from '@/components/base'
import { hexLabel, useWorkbenchStore } from '@/stores'

/**
 * **胜利判定（只读栏）**（W6 B20 判定链 + B16 改成只读）
 *
 * 覆盖专规 5.0 / 5.0a / 5.0b / 5.0c：双方胜利条件、胜利格控制、回合末检查、提前决胜。
 *
 * ## B16：右栏只读（用户 2026-09-16 决定 ①，方案 §5 验收「右栏**无任何可写控件**」）
 * 本面板默认**只画不写**：分项计分、城市明细、当前结论、账本规模与口径说明，全部来自 store 的
 * **只读派生**（`victorySummary` / `finalVictory` / `decisiveVictory` / `turnEndVictory`）。
 * 三个**写入账本**的动作（按盘面刷新 / 指定格控制 / 回合检查）只在对局台的右侧栏里不再出现；
 * 它们是**裁判工具**，故用 `referee` 属性把它们保留在**引擎验证页**（`WorkbenchView`）上——
 * 不能一边说"右栏只读"、一边把裁判的退路删掉。
 *
 * ## 5.0c 的账本何时写
 * 「空格由**最后一个**曾在该格的单位所属方控制」⇒ 账本在**每个玩家回合的 H 清理段收束时自动刷新**
 * （`workbench` 的清理落盘里调 `refreshVictoryControlNow`），不需要玩家操心；
 * 裁判如需订正，用验证页上的那两个工具。
 *
 * 分层纪律（CODE_SPEC）：阈值、清单、控制汇总与判定结论一律来自 store 对引擎的调用；
 * 本组件不做任何规则计算。
 */

const props = withDefaults(defineProps<{ referee?: boolean }>(), { referee: false })

const workbench = useWorkbenchStore()

/** 5.0c：控制账本的裁判输入（仅 `referee` 模式） */
const controlHexText = ref('')
const controlSide = ref<'axis' | 'soviet'>('axis')

/** 5.0c 控制汇总 */
const summary = computed(() => workbench.victorySummary)
/** 回合区间（末回合 + 数据自检注记） */
const turnRange = computed(() => workbench.victoryTurnRange)
/** 5.0a / 5.0b 的当前结论 */
const final = computed(() => workbench.finalVictory)
const decisive = computed(() => workbench.decisiveVictory)
/** 5.0a 的回合末结论（末回合收束时才有终局） */
const atEnd = computed(() => workbench.turnEndVictory)

/** 结论 → 标签类别与文案 */
function verdictTag(
  kind: 'axis' | 'soviet' | 'draw' | 'ongoing',
): 'success' | 'danger' | 'warning' | 'neutral' {
  if (kind === 'axis' || kind === 'soviet') return 'success'
  if (kind === 'draw') return 'warning'
  return 'neutral'
}

function verdictLabel(kind: 'axis' | 'soviet' | 'draw' | 'ongoing'): string {
  if (kind === 'axis') return '轴心国达成'
  if (kind === 'soviet') return '苏军达成'
  if (kind === 'draw') return 'Draw'
  return '未达成（游戏继续）'
}

/** 5.0a / 5.0b 的条件文字（数字来自引擎给的阈值，不在界面重述） */
function thresholdText(
  tier: { sovietListedHexes: number; axisListedHexes: number } | null,
): string {
  return tier === null
    ? '本剧本不适用（5.0a 明文例外）'
    : `苏：Vyazma + Rzhev + 所列格 ≥${tier.sovietListedHexes}；轴：五城全部格 + 所列格 ≥${tier.axisListedHexes}`
}

/**
 * **分项计分**：两方各一行（目标条件 / 当前成绩 / 是否达成）
 *
 * 「当前成绩」只用 store 给的汇总（`listedBySide` 与城市 `held`），界面不自己数格子。
 */
const scoreRows = computed(() => {
  const cities = {
    axis: summary.value.axisCities,
    soviet: summary.value.sovietCities,
  }
  const sides = [
    {
      side: 'soviet' as const,
      label: '苏联',
      cities: cities.soviet,
      cityNames: 'Vyazma + Rzhev',
      listed: summary.value.listedBySide.soviet,
      threshold: final.value.thresholds?.sovietListedHexes ?? null,
      outcome: final.value.outcome === 'soviet',
    },
    {
      side: 'axis' as const,
      label: '轴心国',
      cities: cities.axis,
      cityNames: 'Smolensk / Vitebsk / Orsha / Mogilev / Bobruysk（全部格）',
      listed: summary.value.listedBySide.axis,
      threshold: final.value.thresholds?.axisListedHexes ?? null,
      outcome: final.value.outcome === 'axis',
    },
  ]
  return sides.map((row) => ({
    ...row,
    citiesHeld: row.cities.filter((city) => city.held).length,
    citiesTotal: row.cities.length,
  }))
})

/** 5.0c 的控制口径（只读说明；判据在引擎 `controlOfHex`） */
const CONTROL_RULE_TEXT =
  '5.0c：格内有**可攻击**单位 ⇒ 该方控制；空格 ⇒ 由**最后一个**曾在该格的单位所属方控制。'
</script>

<template>
  <BasePanel title="胜利判定（只读：5.0 / 5.0a / 5.0b / 5.0c）">
    <p class="num">
      <BaseTag kind="info">{{ workbench.scenarioId }} 号剧本</BaseTag>
      <BaseTag kind="neutral">
        {{ workbench.turn }} 回合（{{ workbench.date }}）｜第 {{ turnRange.firstTurn }}–{{
          turnRange.lastTurn
        }}
        回合
      </BaseTag>
      <BaseTag :kind="workbench.atFinalTurn ? 'warning' : 'neutral'">
        {{ workbench.atFinalTurn ? '已是最终回合（5.0a 的判定时点）' : '未到最终回合' }}
      </BaseTag>
    </p>

    <p v-if="turnRange.dataNote !== null" class="warn">
      <BaseTag kind="warning">数据自检</BaseTag>
      {{ turnRange.dataNote }}
    </p>

    <!-- ── 分项计分（两方各一行） ── -->
    <table class="vp">
      <thead>
        <tr>
          <th>方</th>
          <th>目标城市</th>
          <th>所列格</th>
          <th>5.0a</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in scoreRows" :key="row.side">
          <th>{{ row.label }}</th>
          <td>
            {{ row.cityNames }}
            <span class="num">
              （{{ row.citiesHeld }}/{{ row.citiesTotal }} 处{{
                row.citiesTotal > 0 ? '全控' : ''
              }}）
            </span>
          </td>
          <td class="num">
            {{ row.listed }}<span v-if="row.threshold !== null"> / ≥{{ row.threshold }}</span>
          </td>
          <td>
            <BaseTag :kind="row.outcome ? 'success' : 'neutral'">
              {{ row.outcome ? '达成' : '未达成' }}
            </BaseTag>
          </td>
        </tr>
      </tbody>
    </table>

    <p class="muted num">5.0a 最终：{{ thresholdText(final.thresholds) }}</p>
    <p class="num">
      <BaseTag :kind="verdictTag(final.outcome)">{{ verdictLabel(final.outcome) }}</BaseTag>
      {{ final.detail }}
    </p>
    <p class="muted num">5.0b 提前决胜：{{ thresholdText(decisive.thresholds) }}</p>
    <p class="num">
      <BaseTag :kind="verdictTag(decisive.outcome)">{{ verdictLabel(decisive.outcome) }}</BaseTag>
      {{ decisive.detail }}
    </p>
    <p class="num">
      <BaseTag :kind="verdictTag(atEnd.outcome)">回合末</BaseTag>
      {{ atEnd.detail }}（5.0a 在**最终回合结束**时才给终局；其余回合由 5.0b 兜住）
    </p>

    <!-- ── 胜利格明细（5.0c） ── -->
    <hr />
    <p class="muted">
      胜利格（5.0c）：所列格 **{{ summary.listedTotal }}** 处（剧本 2/4 用专属清单）—— 当前苏控
      {{ summary.listedBySide.soviet }} 处、轴方 {{ summary.listedBySide.axis }} 处。{{
        CONTROL_RULE_TEXT
      }}
    </p>
    <div class="row">
      <span class="num">轴方五城（须**全部格**控制）：</span>
      <BaseTag
        v-for="city in summary.axisCities"
        :key="city.name"
        :kind="city.held ? 'success' : 'neutral'"
      >
        {{ city.name }}（{{ city.hexes.map((hex) => hexLabel(hex)).join('、') }}）{{
          city.held ? '✓' : ''
        }}
      </BaseTag>
    </div>
    <div class="row">
      <span class="num">苏方两城：</span>
      <BaseTag
        v-for="city in summary.sovietCities"
        :key="city.name"
        :kind="city.held ? 'success' : 'neutral'"
      >
        {{ city.name }}（{{ city.hexes.map((hex) => hexLabel(hex)).join('、') }}）{{
          city.held ? '✓' : ''
        }}
      </BaseTag>
    </div>
    <p class="muted num">
      控制账本：{{ Object.keys(workbench.victoryLastControl).length }} 格已登记（键 = 列.行）｜
      胜利条件涉及 {{ workbench.victoryHexes.length }} 格 —— 账本在**每个玩家回合的 H 清理段收束时
      自动按盘面刷新**（5.0c 的"最后一个控制者"需要它）。
    </p>

    <p v-if="workbench.victoryError !== null" class="warn">
      <BaseTag kind="danger">{{ workbench.victoryError.rule }}</BaseTag>
      {{ workbench.victoryError.reason }}
    </p>

    <!-- ── 裁判工具（**只在引擎验证页**出现；对局台的右栏保持无控件） ── -->
    <template v-if="props.referee">
      <hr />
      <p class="muted">
        裁判工具（不属对局台右栏：那边只读）：按盘面刷新控制账本、指定/清除某格控制、 手动触发
        5.0a/5.0b 的检查。
      </p>
      <div class="row">
        <BaseButton variant="primary" size="sm" @click="workbench.refreshVictoryControlNow()">
          按盘面刷新账本（5.0c）
        </BaseButton>
        <BaseButton variant="secondary" size="sm" @click="workbench.checkVictoryNow('turnStart')">
          回合开始检查（5.0b）
        </BaseButton>
        <BaseButton variant="secondary" size="sm" @click="workbench.checkVictoryNow('turnEnd')">
          回合末检查（5.0a）
        </BaseButton>
      </div>
      <div class="row">
        <label class="field">
          指定格（列.行）
          <input v-model="controlHexText" class="input" placeholder="36.13" />
        </label>
        <label class="field">
          控制方
          <select v-model="controlSide" class="select">
            <option value="axis">轴心国</option>
            <option value="soviet">苏联</option>
          </select>
        </label>
        <BaseButton
          variant="secondary"
          size="sm"
          @click="workbench.setVictoryControlNow(controlHexText, controlSide)"
        >
          指定控制方（5.0c）
        </BaseButton>
        <BaseButton
          variant="ghost"
          size="sm"
          @click="workbench.setVictoryControlNow(controlHexText, null)"
        >
          清除该格控制
        </BaseButton>
      </div>
    </template>
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

/* 分项计分表（右栏只读：只有表，没有输入件） */
.vp {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-xs);
}

.vp th,
.vp td {
  padding: 2px var(--space-2);
  border: 1px solid var(--color-rule);
  text-align: left;
}

.vp thead th {
  background: var(--color-bg-2);
  color: var(--color-muted);
  font-weight: 400;
}

.field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.input {
  width: 88px;
}

.select {
  max-width: 200px;
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

hr {
  border: none;
  border-top: 1px solid var(--color-rule);
  margin: var(--space-3) 0;
}
</style>
