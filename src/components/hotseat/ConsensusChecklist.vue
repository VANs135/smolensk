<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag } from '@/components/base'
import { useGameSessionStore, useHotseatStore } from '@/stores'

/**
 * 开局共识（W7 C13）
 *
 * ## 规则依据
 *   `scenarios.agreedOptions`（专规 4.0 引出的条目：地图外盒是否隐藏 1.4 / 秘密掷骰 4.9e /
 *   同步操作回合 2.4 / 可选规则与房规 4.1a–4.3）原文要求「需双方一致同意才生效，必须写入存档」。
 *
 * ## 交互（★ 用户口径：只留一个勾选框）
 *   **勾 = 用这条，不勾 = 不用；默认全部不勾**。勾选结果由会话层写成人人对局结论（进日志＝存档的一部份）；
 *   推进第一回合时会**自动补写**（默认＝一条都不用），故不勾任何一项也能直接开局，不会卡住流程。
 *
 * 分层纪律：勾选只是**界面准备**，结论由内核（`applyAgreedChecklist`）写成日志；
 * 本组件不自行写任何状态，也不解释规则。
 */

const gameSession = useGameSessionStore()
const hotseat = useHotseatStore()

/** 勾选行（条目 + 题号 + 是否采用 + 已写入日志的结论） */
const rows = computed(() => gameSession.agreedChecklistRows)

/** 采用了几条 */
const checkedCount = computed(() => gameSession.agreedCheckedCount)

/** 是否已把结论写进日志（＝存档已有共识） */
const recorded = computed(() => gameSession.agreedRecorded)

/** 由共识结论推导的信息纪律（1.4 / 4.9e / 2.4 / 4.1–4.3 的**实际效果**） */
const policy = computed(() => hotseat.policy)

/** 已记录的结论标签 */
function decidedLabel(decided: boolean | null): {
  kind: 'success' | 'neutral' | 'warning'
  text: string
} {
  if (decided === true) return { kind: 'success', text: '已采用' }
  if (decided === false) return { kind: 'neutral', text: '不用' }
  return { kind: 'warning', text: '未写入日志' }
}
</script>

<template>
  <BasePanel title="开局共识（W7 C13：可选开关 · 专规 4.0）">
    <p class="muted">
      **勾 = 用这条，不勾 = 不用；默认全部不勾**。勾选结果会写成人人对局结论（存档的一部份）；
      不勾任何一项也能直接开局，推进第一回合时自动补写，不会卡流程。
    </p>

    <p class="num">
      <BaseTag :kind="checkedCount > 0 ? 'info' : 'neutral'">已采用 {{ checkedCount }} 条</BaseTag>
      <BaseTag :kind="recorded ? 'success' : 'neutral'">
        {{ recorded ? '结论已写入日志' : '结论尚未写入日志' }}
      </BaseTag>
      <BaseTag kind="neutral">{{ policy.rule }}</BaseTag>
    </p>

    <ul class="checks">
      <li v-for="row in rows" :key="row.index" class="checks__row">
        <label class="checks__label">
          <input
            type="checkbox"
            :checked="row.checked"
            @change="
              gameSession.setAgreedCheck(row.index, ($event.target as HTMLInputElement).checked)
            "
          />
          <span class="checks__text">{{ row.index + 1 }}. {{ row.item }}</span>
        </label>
        <BaseTag :kind="decidedLabel(row.decided).kind">{{
          decidedLabel(row.decided).text
        }}</BaseTag>
        <span class="checks__rule num">{{ row.rule }}</span>
      </li>
    </ul>

    <div class="row">
      <BaseButton variant="ghost" size="sm" @click="gameSession.setAllAgreedChecks(false)">
        全部不用
      </BaseButton>
      <BaseButton
        variant="secondary"
        size="sm"
        :disabled="gameSession.session === null"
        @click="gameSession.confirmAgreedChecklist()"
      >
        写入日志
      </BaseButton>
      <span v-if="gameSession.session === null" class="muted">先选剧本并点「开始游戏」。</span>
    </div>

    <p v-if="gameSession.error !== null" class="bad num">
      内核拒绝（{{ gameSession.error.rule }}）：{{ gameSession.error.reason }}
    </p>

    <p class="num muted">生效的信息纪律：{{ policy.detail }}</p>
  </BasePanel>
</template>

<style scoped>
.checks {
  margin: var(--space-1) 0;
  padding: 0;
  list-style: none;
}

.checks__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: 3px 0;
  font-size: var(--text-sm);
}

.checks__label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.checks__text {
  color: var(--color-ink);
}

.checks__rule {
  margin-left: auto;
  color: var(--color-muted);
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) 0;
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
}

.bad {
  color: var(--color-danger);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}
</style>
