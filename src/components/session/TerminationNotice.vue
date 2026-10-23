<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag } from '@/components/base'
import { useGameSessionStore } from '@/stores'

/**
 * 终止提示（W6 C10 的 P3）
 *
 * 会话终止即整局不再推进（`session.ts` 的 terminated 形态是**幂等**的：再步进也不会继续）。
 * 终止原因只有两种，各有明确规则出处：
 *   · `turnsExhausted` —— **回合用尽**：剧本回合数走完，按 **5.0a** 做最终评估；
 *   · `earlyDecision`  —— **提前决胜**：19 August 起任一回合开始达成条件，按 **5.0b** 立即结束。
 *
 * 注意：谁胜谁负由 **5.0a / 5.0b 的胜负条件**判定，不在本组件里重算——
 * 本组件只报「为什么结束」，胜负见「胜利判定」面板（B20）。
 */

const gameSession = useGameSessionStore()

/** 终止原因的中文说明（null = 未终止） */
const reasonText = computed<string | null>(() => {
  switch (gameSession.termination) {
    case 'turnsExhausted':
      return '回合用尽（5.0a）：本剧本的回合数已走完，整局按最终评估收束。'
    case 'earlyDecision':
      return '提前决胜（5.0b）：19 August 起任一回合开始达成 Decisive Win 条件 ⇒ 游戏立即结束。'
    default:
      return null
  }
})

/** 终止时所在回合（取日志里最后一条 terminate 的回合号） */
const terminatedAtTurn = computed<number | null>(() => {
  const entry = [...gameSession.log].reverse().find((item) => item.action === 'terminate')
  return entry?.turn ?? null
})
</script>

<template>
  <BasePanel v-if="gameSession.terminated" title="终止提示（W6 C10：P3）">
    <p class="stop">
      <BaseTag kind="danger">已终止</BaseTag>
      <BaseTag kind="neutral">{{ gameSession.termination }}</BaseTag>
      <template v-if="terminatedAtTurn !== null">第 {{ terminatedAtTurn }} 回合</template>
    </p>
    <p class="stop">{{ reasonText }}</p>
    <p class="muted">
      终止后会话形态为 terminated，再点「推进一步」也不会继续（幂等）。 胜负判定见「胜利判定（5.0a /
      5.0b）」面板 —— 那里用 5.0c 的控制事实给出胜方或 Draw。
    </p>
    <div class="row">
      <BaseButton variant="secondary" size="sm" @click="gameSession.resetGame()"
        >重置流程条</BaseButton
      >
      <BaseButton variant="primary" size="sm" @click="gameSession.startGame()">重开一局</BaseButton>
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

.stop {
  color: var(--color-accent);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}
</style>
