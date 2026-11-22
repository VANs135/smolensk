<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { BaseButton, BaseDialog, BaseTag, RuleTip } from '@/components/base'
import { useGameSessionStore, useWorkbenchStore } from '@/stores'

import { terminationAssessment, victoryDialogView } from './victory-dialog'

/**
 * **判定胜利窗**（用户 2026-11-15 实机试玩第 1 项）
 *
 * 对局终止（回合用尽 专规 5.0a / 提前决胜 专规 5.0b）后弹一次，显示胜负与判定依据事实；
 * 只读：结论全部来自 store 的引擎派生（`turnEndVictory` / `finalVictory` / `decisiveVictory`），
 * 本组件不重算规则。口径：一窗一事、窗内不放描述性文字、条款号只进 `?`。
 */
const gameSession = useGameSessionStore()
const workbench = useWorkbenchStore()

/** 终止后该显示的那一份判定结论（未终止 ⇒ null） */
const assessment = computed(() =>
  terminationAssessment({
    termination: gameSession.termination,
    turnEnd: workbench.turnEndVictory,
    final: workbench.finalVictory,
    decisive: workbench.decisiveVictory,
  }),
)

const view = computed(() =>
  assessment.value === null ? null : victoryDialogView(assessment.value, workbench.scenarioId),
)

/** 只在**终止发生的那一刻**打开；玩家关掉后不因同一局重开 */
const open = ref(false)
watch(
  () => gameSession.terminated,
  (terminated) => {
    open.value = terminated
  },
  { immediate: true },
)
</script>

<template>
  <BaseDialog v-if="view !== null" v-model:open="open" title="判定胜利" width="420px">
    <p class="vd__verdict">
      <BaseTag :kind="view.tone">{{ view.verdict }}</BaseTag>
      <RuleTip :rule="view.rule">{{ assessment?.detail ?? view.rule }}</RuleTip>
    </p>

    <ul class="vd__rows">
      <li v-for="row in view.rows" :key="row.label" class="vd__row">
        <span class="vd__label">{{ row.label }}</span>
        <BaseTag :kind="row.ok === null ? 'neutral' : row.ok ? 'success' : 'danger'">
          {{ row.value }}
        </BaseTag>
      </li>
    </ul>

    <template #footer>
      <BaseButton variant="secondary" size="sm" @click="open = false">关闭</BaseButton>
    </template>
  </BaseDialog>
</template>

<style scoped>
.vd__verdict {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
}

.vd__rows {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.vd__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.vd__label {
  color: var(--color-muted);
}
</style>
