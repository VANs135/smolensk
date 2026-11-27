<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BaseTag } from '@/components/base'
import { useGameSessionStore, useOnlineStore, useWorkbenchStore } from '@/stores'

/**
 * 待答面板（W6 C10：由**会话驱动**的强制选择呈现）
 *
 * ## 三条硬规矩（对应用户要求）
 *   ① **由会话驱动**：面板是否出现、题面是什么、有哪些选项，全部取自当前会话的 `awaiting.question`，
 *      组件自身不持任何问题状态；
 *   ② **强制选择呈现**：题面带选项时逐项列出，只能从中选一个；无选项（确认题）时给出「确认作答」；
 *      **不提供关闭 / 取消 / 遮罩点击关闭**，也没有 Esc 关闭 —— 玩家无法绕开问题继续推进；
 *   ③ **面板关闭只听内核裁决**：只有 `answerNow` 经会话框架校验通过（题号一致、应答方一致、选项在列）
 *      并落地后，会话形态才回到 `advancing`，面板随之消失；校验失败则把内核给出的原因显示出来、
 *      面板保持打开。
 *
 * 分层纪律：组件只收点击，合法性判定与形态迁移都在 `@/engine/session`（B4）里。
 */

const gameSession = useGameSessionStore()
const workbench = useWorkbenchStore()
const online = useOnlineStore()

/** 当前待答问题（null = 未待答，面板整体不渲染） */
const question = computed(() => gameSession.question)

/** 联机时只有应答方本机能作答；另一方看题面但收起全部选项。 */
const canAnswer = computed<boolean>(
  () => question.value !== null && (!online.active || online.mySide === question.value.responder),
)

/** 选项列表（无选项 ⇒ 空数组，按确认题处理） */
const options = computed(() => question.value?.options ?? [])

/**
 * 2.3 先手判定的骰点确认窗
 *
 * 题面只写“某方胜出”不够：双方需要看到各自 2d6 与重掷次数，才能按规则确认胜者。
 * 骰点由引擎在 `initiativeQuestion` 的 payload 里带来，组件不自行掷骰或推断胜者。
 */
const initiativeRolls = computed<{
  axis: number
  soviet: number
  axisFaces: readonly number[]
  sovietFaces: readonly number[]
  rerolls: number
} | null>(() => {
  const current = question.value
  if (current?.id !== 'initiative') return null
  const axis = current.payload?.['axisRoll']
  const soviet = current.payload?.['sovietRoll']
  if (typeof axis !== 'number' || typeof soviet !== 'number') return null
  const rerolls = current.payload?.['rerolls']
  const axisFaces = current.payload?.['axisFaces']
  const sovietFaces = current.payload?.['sovietFaces']
  return {
    axis,
    soviet,
    axisFaces: Array.isArray(axisFaces) ? axisFaces.filter((n) => typeof n === 'number') : [],
    sovietFaces: Array.isArray(sovietFaces) ? sovietFaces.filter((n) => typeof n === 'number') : [],
    rerolls: typeof rerolls === 'number' ? rerolls : 0,
  }
})

/** 当前回合号（只作标题，不参与判定） */
const turnNumber = computed<number | null>(() => gameSession.records?.turn ?? null)

/** 作答（选项 id；确认题传 undefined）
 *
 * 2.3 先手判定（用户 2026-11-14 裁定）：**作答即自动推进到 A 段**，不再要求多点心一次
 * 「进入下一环节」。其余问题保持原语义（答完停住，由玩家自己决定何时推进）。
 */
function answer(optionId?: string): void {
  workbench.answerQuestionNow(optionId)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="question !== null" class="prompt" role="dialog" aria-modal="true" aria-label="待答">
      <!-- 无遮罩点击关闭：遮罩只是视觉隔离，点它不会关面板 -->
      <div class="prompt__mask" />
      <div class="prompt__panel theme-command">
        <header class="prompt__header">
          <h3 class="prompt__title">{{ question.responder === 'axis' ? '轴心国' : '苏联' }}应答</h3>
          <BaseTag kind="warning">{{ question.rule }}</BaseTag>
        </header>

        <div class="prompt__body">
          <div v-if="initiativeRolls !== null" class="prompt__rolls" aria-label="先手判定骰点">
            <p class="prompt__rolls-title">第 {{ turnNumber ?? '—' }} 回合 · 先手判定（2.3）</p>
            <div class="prompt__roll-row" data-side="axis">
              <span class="prompt__roll-side">轴心</span>
              <span class="prompt__roll-dice num">
                {{
                  initiativeRolls.axisFaces.length > 0
                    ? initiativeRolls.axisFaces.join(' + ')
                    : '2d6'
                }}
              </span>
              <span class="prompt__roll-value num">{{ initiativeRolls.axis }}</span>
            </div>
            <div class="prompt__roll-row" data-side="soviet">
              <span class="prompt__roll-side">苏联</span>
              <span class="prompt__roll-dice num">
                {{
                  initiativeRolls.sovietFaces.length > 0
                    ? initiativeRolls.sovietFaces.join(' + ')
                    : '2d6'
                }}
              </span>
              <span class="prompt__roll-value num">{{ initiativeRolls.soviet }}</span>
            </div>
            <p class="prompt__rolls-note">
              {{
                question.responder === 'axis' ? '轴心' : '苏联'
              }}方点数高，胜出后选择本回合先手或后手。
              <span v-if="initiativeRolls.rerolls > 0" class="num">
                平局重掷 {{ initiativeRolls.rerolls }} 次。
              </span>
            </p>
          </div>

          <p class="prompt__prompt">{{ question.prompt }}</p>

          <div v-if="canAnswer" class="prompt__options">
            <template v-if="options.length > 0">
              <BaseButton
                v-for="option in options"
                :key="option.id"
                variant="primary"
                size="sm"
                @click="answer(option.id)"
              >
                {{ option.label }}
              </BaseButton>
            </template>
            <BaseButton v-else variant="primary" size="sm" @click="answer()">确认作答</BaseButton>
          </div>
          <p v-else class="prompt__wait" role="status">等待对方应答…</p>

          <p v-if="gameSession.error !== null" class="prompt__error">
            <BaseTag kind="danger">{{ gameSession.error.rule }}</BaseTag>
            {{ gameSession.error.reason }}
          </p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.prompt {
  position: fixed;
  inset: 0;
  z-index: var(--z-panel);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-8);
}

.prompt__mask {
  position: absolute;
  inset: 0;
  background: rgb(32 30 26 / 0.45);
}

.prompt__panel {
  position: relative;
  width: 520px;
  max-width: 100%;
  background: var(--color-panel);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
}

.prompt__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid var(--color-rule);
}

.prompt__title {
  margin: 0;
  font-size: var(--text-lg);
}

.prompt__body {
  padding: var(--space-6);
}

.prompt__prompt {
  margin: 0 0 var(--space-2);
  font-size: var(--text-base-size);
  color: var(--color-ink);
}

/* 2.3 先手判定：双方 2d6 同屏，胜者行加同色边；骰点是引擎给的，不是界面重掷 */
.prompt__rolls {
  display: grid;
  gap: 4px;
  margin-bottom: var(--space-4);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md);
  background: var(--color-bg-2);
}

.prompt__rolls-title {
  margin: 0 0 2px;
  color: var(--color-muted);
  font-size: var(--text-xs);
}

.prompt__roll-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 2px var(--space-2);
  border-left: 3px solid var(--color-rule);
  border-radius: var(--radius-sm);
}

.prompt__roll-row[data-side='axis'] {
  border-left-color: var(--color-command-axis);
}

.prompt__roll-row[data-side='soviet'] {
  border-left-color: var(--color-command-soviet);
}

.prompt__roll-side {
  flex: 1;
  font-weight: 700;
}

.prompt__roll-dice {
  color: var(--color-muted);
  font-size: var(--text-xs);
}

.prompt__roll-value {
  min-width: 2ch;
  font-size: var(--text-lg);
  font-weight: 700;
  text-align: right;
}

.prompt__rolls-note {
  margin: var(--space-1) 0 0;
  color: var(--color-command-muted);
  font-size: var(--text-xs);
}

.prompt__options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.prompt__wait {
  margin: 0;
  color: var(--color-command-muted);
  font-size: var(--text-sm);
}

.prompt__error {
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  color: var(--color-danger);
}

.prompt__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
</style>
