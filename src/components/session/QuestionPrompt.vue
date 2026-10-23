<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BaseTag } from '@/components/base'
import { useGameSessionStore, useUiStore } from '@/stores'

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
const ui = useUiStore()

/** 当前待答问题（null = 未待答，面板整体不渲染） */
const question = computed(() => gameSession.question)

/** 选项列表（无选项 ⇒ 空数组，按确认题处理） */
const options = computed(() => question.value?.options ?? [])

/** 作答（选项 id；确认题传 undefined） */
function answer(optionId?: string): void {
  gameSession.answerNow(optionId)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="question !== null" class="prompt" role="dialog" aria-modal="true" aria-label="待答">
      <!-- 无遮罩点击关闭：遮罩只是视觉隔离，点它不会关面板 -->
      <div class="prompt__mask" />
      <div class="prompt__panel">
        <header class="prompt__header">
          <h3 class="prompt__title">待答（会话裁决）</h3>
          <BaseTag kind="warning">{{ question.rule }}</BaseTag>
        </header>

        <div class="prompt__body">
          <p class="prompt__prompt">{{ question.prompt }}</p>
          <p class="prompt__meta">
            应答方：{{ question.responder === 'axis' ? '轴心国' : '苏联' }}｜题号
            {{ question.id }}｜类别
            {{ question.kind }}
          </p>

          <div v-if="options.length > 0" class="prompt__options">
            <BaseButton
              v-for="option in options"
              :key="option.id"
              variant="primary"
              size="sm"
              @click="answer(option.id)"
            >
              {{ option.label }}
            </BaseButton>
          </div>
          <div v-else class="prompt__options">
            <BaseButton variant="primary" size="sm" @click="answer()">确认作答</BaseButton>
          </div>

          <p v-if="gameSession.error !== null" class="prompt__error">
            <BaseTag kind="danger">{{ gameSession.error.rule }}</BaseTag>
            内核拒绝：{{ gameSession.error.reason }}
          </p>
        </div>

        <footer class="prompt__footer">
          <p class="prompt__note">
            本面板不提供关闭与取消：只有内核裁决通过（作答合法并落地）才会关闭。
          </p>
          <div class="prompt__actions">
            <!-- W7 C15：待答时遮罩挡住了顶栏，故由面板自己给存档入口（与顶栏同一个对话框） -->
            <BaseButton variant="ghost" size="sm" @click="ui.openSaveDialog()">
              存档 / 读档
            </BaseButton>
            <BaseTag kind="neutral">存档不改变形态：本面板仍在等作答</BaseTag>
          </div>
        </footer>
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

.prompt__meta {
  margin: 0 0 var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.prompt__options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.prompt__error {
  margin: var(--space-4) 0 0;
  font-size: var(--text-sm);
  color: var(--color-accent);
}

.prompt__footer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-6);
  border-top: 1px solid var(--color-rule);
  background: var(--color-bg-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.prompt__note {
  margin: 0;
}

.prompt__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
</style>
