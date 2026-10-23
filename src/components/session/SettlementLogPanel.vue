<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseButton, BasePanel, BaseTag } from '@/components/base'
import { GAME_PHASES } from '@/engine/state-types'
import { useGameSessionStore } from '@/stores'

import DerivationSteps from './DerivationSteps.vue'

/**
 * 结算日志面板（W7 D2）
 *
 * 把会话的结算日志铺开成可用的表：**结构化**（规则号 / 成败 / 掷骰 / 明细）、
 * **可检索**（回合 / 阶段 / 阵营 / 动作 / 规则号 / 关键词 / 只看失败）、**可展开**（点行看明细与待处理项）、
 * **与规则编号对齐**（规则号索引可直接反向检索规则书），并给出**固定种子重放复算**的结论。
 *
 * 分层纪律：本组件只画表与收筛选条件，结构化 / 检索 / 重放全部由 `@/engine/log-book` 完成。
 */

const gameSession = useGameSessionStore()

/** 已展开的日志下标（界面局部状态；不落盘） */
const expanded = ref<number[]>([])

/** 当前检索条件（取自 store，便于与其它面板共享） */
const query = computed(() => gameSession.logQuery)

/** 角色 / 阶段 / 阵营的中文名 */
const SIDE_LABELS: Record<string, string> = { axis: '轴心国', soviet: '苏联' }
const PHASE_LABELS: Record<string, string> = {
  preTurn: 'Pre-Turn',
  aircraftRefit: 'A 飞机整备',
  reinforcement: 'B 增援',
  movement: 'C 移动',
  supply: 'D 补给',
  reaction: 'E 反应',
  combat: 'F 战斗',
  exploitation: 'G 进击',
  cleanUp: 'H 清理',
  turnEnd: '回合结束',
}

function toggleExpanded(index: number): void {
  expanded.value = expanded.value.includes(index)
    ? expanded.value.filter((item) => item !== index)
    : [...expanded.value, index]
}

/** 重放报告（无会话为 null） */
const replay = computed(() => gameSession.replayReport)

/** 该条日志的重放游标（无报告或超界为 null） */
function cursorOf(index: number): { drawCountBefore: number; drawCountAfter: number } | null {
  return replay.value?.cursors[index] ?? null
}

/** 规则号筛选（点索引里的规则号即筛） */
function filterByRule(rule: string): void {
  gameSession.setLogQuery({ rule: query.value.rule === rule ? null : rule })
}
</script>

<template>
  <BasePanel title="结算日志（W7 D2：结构化 · 可检索 · 可展开 · 重放复算）">
    <p class="muted">
      日志来自会话的结算记录（每条都带**规则编号**、成败、掷骰与待处理项）。下方可逐条展开看明细；
      检索条件同时给出即「与」关系。重放复算从**种子**出发重掷日志里的每一次掷骰并逐条比对，
      出现分歧即报出**首个分歧**（条号 / 动作 / 规则 / 当时的掷骰游标）。
    </p>

    <!-- ── 概览 ── -->
    <div class="row">
      <BaseTag kind="info">共 {{ gameSession.logBook.stats.total }} 条</BaseTag>
      <BaseTag kind="success">成功 {{ gameSession.logBook.stats.ok }}</BaseTag>
      <BaseTag :kind="gameSession.logBook.stats.failed > 0 ? 'danger' : 'neutral'">
        被拒 {{ gameSession.logBook.stats.failed }}
      </BaseTag>
      <span class="num">
        掷骰 {{ gameSession.logBook.stats.diceCount }} 颗｜轴心
        {{ gameSession.logBook.stats.bySide.axis }} / 苏联
        {{ gameSession.logBook.stats.bySide.soviet }}
      </span>
    </div>

    <!-- ── 规则号索引（与规则编号对齐） ── -->
    <p class="num">
      规则号索引：
      <template v-if="gameSession.logBook.rules.length === 0">（无）</template>
      <BaseButton
        v-for="item in gameSession.logBook.rules"
        :key="item.rule"
        :variant="query.rule === item.rule ? 'primary' : 'ghost'"
        size="sm"
        @click="filterByRule(item.rule)"
      >
        {{ item.rule }} ×{{ item.count }}
      </BaseButton>
    </p>

    <!-- ── 检索 ── -->
    <div class="row">
      <label class="field">
        回合
        <input
          class="input num"
          type="number"
          min="1"
          :value="query.turn ?? ''"
          @change="
            gameSession.setLogQuery({
              turn:
                ($event.target as HTMLInputElement).value === ''
                  ? null
                  : Number(($event.target as HTMLInputElement).value),
            })
          "
        />
      </label>
      <label class="field">
        阶段
        <select
          class="select"
          :value="query.phase ?? ''"
          @change="
            gameSession.setLogQuery({
              phase: (($event.target as HTMLSelectElement).value || null) as typeof query.phase,
            })
          "
        >
          <option value="">（不限）</option>
          <option v-for="phase in GAME_PHASES" :key="phase" :value="phase">
            {{ PHASE_LABELS[phase] ?? phase }}
          </option>
        </select>
      </label>
      <label class="field">
        阵营
        <select
          class="select"
          :value="query.side ?? ''"
          @change="
            gameSession.setLogQuery({
              side: (($event.target as HTMLSelectElement).value || null) as typeof query.side,
            })
          "
        >
          <option value="">（不限）</option>
          <option value="axis">轴心国</option>
          <option value="soviet">苏联</option>
        </select>
      </label>
      <label class="field">
        动作
        <select
          class="select"
          :value="query.action ?? ''"
          @change="
            gameSession.setLogQuery({ action: ($event.target as HTMLSelectElement).value || null })
          "
        >
          <option value="">（不限）</option>
          <option v-for="action in gameSession.logBook.actions" :key="action" :value="action">
            {{ action }}
          </option>
        </select>
      </label>
      <label class="field">
        关键词
        <input
          class="input"
          :value="query.text ?? ''"
          placeholder="如 radar / limited / 36.13"
          @input="
            gameSession.setLogQuery({ text: ($event.target as HTMLInputElement).value || null })
          "
        />
      </label>
      <label class="field">
        <input
          type="checkbox"
          :checked="query.onlyFailed === true"
          @change="
            gameSession.setLogQuery({ onlyFailed: ($event.target as HTMLInputElement).checked })
          "
        />
        只看被拒
      </label>
      <BaseButton
        variant="ghost"
        size="sm"
        :disabled="!gameSession.logFiltered"
        @click="gameSession.clearLogQuery()"
      >
        清除筛选
      </BaseButton>
      <span class="num">
        命中 {{ gameSession.logEntries.length }} / {{ gameSession.logBook.stats.total }} 条
      </span>
    </div>

    <!-- ── 重放复算（固定种子） ── -->
    <hr />
    <p v-if="replay === null" class="muted">尚无会话：开局并推进后即可重放复算。</p>
    <template v-else>
      <p class="num">
        <BaseTag :kind="replay.ok ? 'success' : 'danger'">
          重放复算 {{ replay.ok ? '通过' : '未通过' }}
        </BaseTag>
        算法 {{ replay.algorithm }}｜种子 {{ replay.seed }}｜日志 {{ replay.logEntries }} 条｜掷骰
        {{ replay.diceCount }} 颗
      </p>
      <p class="num">
        种子—游标—内部状态自洽：{{ replay.rngSelfConsistent ? '是' : '否' }}｜重放终点与存档一致：{{
          replay.stateMatches ? '是' : '否'
        }}
      </p>
      <p v-if="replay.firstDivergence !== null" class="warn">
        首个分歧：第 {{ replay.firstDivergence.index + 1 }} 条（T{{ replay.firstDivergence.turn }}
        {{ replay.firstDivergence.action }}，规则 {{ replay.firstDivergence.rule }}，掷骰游标
        {{ replay.firstDivergence.drawCountBefore }}）｜日志
        {{ replay.firstDivergence.expected.faces.join('+') }} ≠ 重放
        {{ replay.firstDivergence.actual.faces.join('+') }}
      </p>
      <p class="num">{{ replay.detail }}</p>
    </template>

    <!-- ── 日志明细（可展开） ── -->
    <hr />
    <p v-if="gameSession.logEntries.length === 0" class="muted">
      没有命中任何日志（或本局尚无日志 —— 点上方「推进一步」开始）。
    </p>
    <div v-for="entry in gameSession.logEntries" :key="entry.index" class="entry">
      <button class="entry__head" type="button" @click="toggleExpanded(entry.index)">
        <span class="entry__cursor num">#{{ entry.index + 1 }}</span>
        <BaseTag kind="neutral">T{{ entry.turn }}</BaseTag>
        <BaseTag kind="neutral">{{ PHASE_LABELS[entry.phase] ?? entry.phase }}</BaseTag>
        <BaseTag kind="neutral">{{ SIDE_LABELS[entry.side] ?? entry.side }}</BaseTag>
        <BaseTag kind="info">{{ entry.rule }}</BaseTag>
        <BaseTag :kind="entry.ok ? 'success' : 'danger'">{{
          entry.ok ? '已结算' : '被拒'
        }}</BaseTag>
        <span class="entry__action num">{{ entry.action }}</span>
        <span v-if="entry.rolls.length > 0" class="entry__rolls num">
          {{ entry.rolls.map((roll) => `${roll.faces.join('+')}=${roll.total}`).join(' / ') }}
        </span>
        <span class="entry__toggle num">{{
          expanded.includes(entry.index) ? '收起 ▾' : '展开 ▸'
        }}</span>
      </button>

      <div v-if="expanded.includes(entry.index)" class="entry__body">
        <p class="entry__summary num">{{ entry.summary }}</p>
        <!-- W7 C11：结算复核过程（骰点 / 修正项与来源 / 合计 / 取列查表 / 结果） -->
        <DerivationSteps v-if="entry.derivation !== null" :derivation="entry.derivation" />
        <p v-for="(row, rowIndex) in entry.details" :key="rowIndex" class="num">
          <span class="entry__key">{{ row.label }}</span
          >：{{ row.value }}
        </p>
        <p v-if="entry.pending.length > 0" class="num">
          待处理项 {{ entry.pending.length }} 个：{{
            entry.pending.map((item) => `${item.kind}（${item.rule}）`).join('、')
          }}
        </p>
        <p v-if="cursorOf(entry.index) !== null" class="num">
          掷骰游标：{{ cursorOf(entry.index)?.drawCountBefore }} →
          {{ cursorOf(entry.index)?.drawCountAfter }}
        </p>
      </div>
    </div>
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

.input {
  width: 120px;
}

.select {
  max-width: 160px;
}

.entry {
  border-top: 1px solid var(--color-rule);
  padding: var(--space-1) 0;
}

.entry__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.entry__head:hover {
  background: var(--color-bg-2);
}

.entry__cursor {
  color: var(--color-muted);
}

.entry__action {
  color: var(--color-muted);
}

.entry__rolls {
  color: var(--color-gold);
}

.entry__toggle {
  margin-left: auto;
  color: var(--color-accent);
}

.entry__body {
  padding: var(--space-1) var(--space-4) var(--space-2);
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
}

.entry__summary {
  color: var(--color-muted);
}

.entry__key {
  color: var(--color-muted);
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
