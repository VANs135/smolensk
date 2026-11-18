<script setup lang="ts">
import type { DeepReadonly, ScenarioBriefing } from '@/data'
import { BaseButton, BaseDialog, RuleTip } from '@/components/base'

/**
 * 剧本开局后、进入初设前的「任务目标 / 胜利条件」窗（用户 2026-11-18 第 1 条）
 *
 * 内容全部来自 `scenarios.json` 的 `briefing`（按剧本原文摘录）；
 * 口径同既有弹窗：一窗一事、窗内不放描述性长文，条款号只进 `?`。
 * 唯一出口是「确定」（确认后进初设）；不提供记忆偏好类的复选项。
 */
const props = defineProps<{
  open: boolean
  /** 标题（含剧本名） */
  title: string
  briefing: DeepReadonly<ScenarioBriefing> | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
}>()
</script>

<template>
  <BaseDialog
    :open="props.open"
    :title="props.title"
    width="440px"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="props.briefing !== null" class="brief">
      <section class="brief__block">
        <h4 class="brief__head">任务目标</h4>
        <ul class="brief__list">
          <li v-for="item in props.briefing.objectives" :key="item.text" class="brief__item">
            <span>{{ item.text }}</span>
            <RuleTip :rule="item.rule" />
          </li>
        </ul>
      </section>

      <section class="brief__block">
        <h4 class="brief__head">胜利条件</h4>
        <ul class="brief__list">
          <li v-for="item in props.briefing.victory" :key="item.text" class="brief__item">
            <span>{{ item.text }}</span>
            <RuleTip :rule="item.rule" />
          </li>
        </ul>
      </section>

      <section v-if="(props.briefing.restrictions ?? []).length > 0" class="brief__block">
        <h4 class="brief__head">限制</h4>
        <ul class="brief__list">
          <li
            v-for="item in props.briefing.restrictions ?? []"
            :key="item.text"
            class="brief__item"
          >
            <span>{{ item.text }}</span>
            <RuleTip :rule="item.rule" />
          </li>
        </ul>
      </section>
    </div>

    <template #footer>
      <BaseButton variant="primary" @click="emit('confirm')">确定</BaseButton>
    </template>
  </BaseDialog>
</template>

<style scoped>
.brief {
  display: grid;
  gap: var(--space-3);
}

.brief__block {
  display: grid;
  gap: var(--space-1);
}

.brief__head {
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-ui);
  letter-spacing: 0.04em;
}

.brief__list {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.brief__item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--text-sm);
  line-height: 1.45;
}
</style>
