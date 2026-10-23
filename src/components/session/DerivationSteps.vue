<script setup lang="ts">
import type { Derivation, DerivationStep, DerivationStepKind } from '@/engine/derivation'

/**
 * 结算复核明细（W7 C11）
 *
 * 把一段 `Derivation`（骰点 → 修正项与来源 → 合计 → 取列/查表 → 结果）逐项铺开，
 * 供玩家**对着规则书复核**。纯展示组件：只读引擎给出的结论，不做任何规则计算。
 *
 * 用法：`<DerivationSteps v-if="d !== null" :derivation="d" />`
 */

defineProps<{ derivation: Derivation }>()

/** 步骤类别的中文名 */
const KIND_LABELS: Record<DerivationStepKind, string> = {
  dice: '骰点',
  modifier: '修正',
  subtotal: '合计',
  fact: '事实',
  lookup: '查表',
  result: '结果',
}

/** 该步骤的「值」列（骰面 / 带符号修正 / 合计 / 事实文本 / 表行列 / 结果码） */
function valueOf(step: DerivationStep): string {
  switch (step.kind) {
    case 'dice':
      return step.rolls.length === 0
        ? '（无掷骰记录）'
        : step.rolls.map((roll) => `${roll.faces.join('+')} = ${roll.total}`).join(' / ')
    case 'modifier':
      return `${step.value > 0 ? '＋' : step.value < 0 ? '−' : '±'}${Math.abs(step.value)}`
    case 'subtotal':
      return `${step.value}（${step.formula}）`
    case 'fact':
      return step.text
    case 'lookup':
      return [
        step.table,
        step.row === undefined ? null : `行 ${step.row}`,
        step.column === undefined ? null : `列 ${step.column}`,
      ]
        .filter((part): part is string => part !== null)
        .join('｜')
    case 'result':
      return step.value
  }
}

/** 该步骤的「来源」列（骰点/修正/事实才有；其余为空串） */
function sourceOf(step: DerivationStep): string {
  switch (step.kind) {
    case 'dice':
    case 'modifier':
    case 'fact':
      return step.source
    default:
      return ''
  }
}
</script>

<template>
  <div class="dv">
    <p class="dv__head num">
      {{ derivation.title }}
      <span class="dv__rule num">规则 {{ derivation.rule }}</span>
    </p>
    <ol class="dv__steps">
      <li
        v-for="(step, index) in derivation.steps"
        :key="index"
        class="dv__step"
        :class="`dv__step--${step.kind}`"
      >
        <span class="dv__kind num">{{ KIND_LABELS[step.kind] }}</span>
        <span class="dv__label">{{ step.label }}</span>
        <span class="dv__value num">{{ valueOf(step) }}</span>
        <span v-if="sourceOf(step) !== ''" class="dv__source num">{{ sourceOf(step) }}</span>
        <span class="dv__rule num">{{ step.rule }}</span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.dv {
  margin: var(--space-1) 0;
  padding: var(--space-2);
  background: var(--color-bg-2);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
}

.dv__head {
  margin: 0 0 var(--space-1);
  color: var(--color-ink);
  font-size: var(--text-sm);
}

.dv__rule {
  margin-left: var(--space-2);
  color: var(--color-muted);
}

.dv__steps {
  margin: 0;
  padding: 0;
  list-style: none;
}

.dv__step {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  padding: 2px 0;
  font-size: var(--text-sm);
  border-top: 1px dashed var(--color-rule);
}

.dv__step:first-child {
  border-top: none;
}

.dv__kind {
  flex: 0 0 32px;
  color: var(--color-muted);
}

.dv__label {
  color: var(--color-ink);
}

.dv__value {
  color: var(--color-gold);
}

.dv__source {
  color: var(--color-muted);
}

.dv__step--subtotal .dv__value,
.dv__step--result .dv__value {
  color: var(--color-accent);
}
</style>
