<script setup lang="ts">
import { computed } from 'vue'

import { RuleNote } from '@/components/base'
import { useGameSessionStore } from '@/stores'

/**
 * 单回合引导（Intro: Vitebsk）
 *
 * 剧本页明示 `1 player turn`：先手方（轴心）走完 A–H 即终局。本组件把那一个回合里
 * **玩家实际要做的事**按原文顺序列出来，作为教学提示；不参与任何规则计算与推进。
 */
const gameSession = useGameSessionStore()

/** 只在该教学剧本出现；其余剧本不占版面 */
const visible = computed(() => gameSession.scenarioId === 'Intro')

/** 原文顺序：补给/SP → 移动 → 突袭/战斗 → 占两格 → 统计 SP */
const STEPS: readonly { title: string; rule: string; detail: string }[] = [
  {
    title: '补给与 SP',
    rule: '12.1a / 12.3',
    detail: '轴方 5 SP（3 Wagon 运力）已按初设落位；先确认补给源与移动段的补给线。',
  },
  {
    title: '推进',
    rule: 'C / E 段',
    detail: '7 Pz、20 Mtr 沿可用道路向维捷布斯克（19.27 / 19.28）方向推进。',
  },
  {
    title: '突袭与战斗',
    rule: 'A 段突袭 / F 段战斗',
    detail: '对两格守军组织突袭或普通战斗；注意 3.4 的分集群归属在本剧本不适用。',
  },
  {
    title: '占两格',
    rule: '剧本页 Major / Minor',
    detail:
      '19.27 与 19.28 都由轴方控制 ⇒ Major Victory；未全控但苏方无法向两格及格内单位追溯抽象补给（12.x）⇒ Minor Victory。',
  },
  {
    title: '统计 SP',
    rule: '战后结算',
    detail: '记录本回合用掉的 SP；两格既未全控、苏方也仍能追溯补给 ⇒ 轴方失败。',
  },
]
</script>

<template>
  <RuleNote
    v-if="visible"
    title="单回合引导（Intro: Vitebsk）：走完先手方 A–H 即终局"
    rule="剧本页 / 1 player turn"
    :open="true"
  >
    <p class="intro-guide__lead">
      单人教学：你兼控双方；本剧本只有 <b>1 个玩家回合</b>，轴方（先手）H 段结束即判胜负。
    </p>
    <ol class="intro-guide__steps">
      <li v-for="(step, index) in STEPS" :key="step.title">
        <span class="intro-guide__title num">{{ index + 1 }}. {{ step.title }}</span>
        <span class="intro-guide__rule num">{{ step.rule }}</span>
        <span class="intro-guide__detail">{{ step.detail }}</span>
      </li>
    </ol>
  </RuleNote>
</template>

<style scoped>
.intro-guide__lead {
  margin: 0 0 var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.intro-guide__steps {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding-left: var(--space-4);
  font-size: var(--text-sm);
}

.intro-guide__steps li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
}

.intro-guide__title {
  font-weight: 600;
}

.intro-guide__rule {
  color: var(--color-muted);
}

.intro-guide__detail {
  flex: 1 1 320px;
  color: var(--color-muted);
}
</style>
