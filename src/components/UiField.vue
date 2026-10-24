<script setup lang="ts">
import { computed } from 'vue'

import { useUiMode } from './ui-mode'

defineOptions({ inheritAttrs: false })

/**
 * 条 24 / §5-F：把"手输"文本/数字输入框收敛成**单一入口**。
 *
 * - 验证页（`uiMode === 'verify'`）：渲染可编辑 `<input>`，保留裁判/复核的全部手输退路；
 * - 正式界面（`uiMode === 'formal'`）：
 *   · **数字型默认渲染 `－ 值 ＋` 步进**——不手输但仍可操作（数量、结果、裁判补记都能点）；
 *   · **文本型默认只读**（格号改点图、备注/名称这类不在这里改）；
 *   · 传 `readonly` 可强制只读（"空 = 全部/自动"这类步进表达不了的语义，如销毁量）。
 *
 * 用法替代原 `<input v-model="x" ... />`：`<UiField v-model="x" type="number" />`。
 * 其余属性（class、min/max、@change 等）经 `$attrs` 透传到 `<input>` 分支。
 */
const props = withDefaults(
  defineProps<{
    modelValue?: string | number | null
    type?: string
    placeholder?: string
    /** 正式界面用步进代替只读（**数字型默认就是步进**，此开关保留作显式声明） */
    stepper?: boolean
    /** 强制只读（即便数字型）——用于"空 = 全部/自动"这类步进表达不了的语义（如销毁量） */
    readonly?: boolean
    /** 步进下限（默认 0；接受 number|string，兼容模板里的静态 `min="0"`） */
    min?: number | string
  }>(),
  { type: 'text', modelValue: '', placeholder: '', stepper: false, readonly: false, min: 0 },
)

const emit = defineEmits<{ (e: 'update:modelValue', v: string | number): void }>()

const uiMode = useUiMode()

/** 当前数值（字符串/空 都归一到数字，供步进用） */
const numeric = computed<number>(() => {
  const value = props.modelValue
  return typeof value === 'number' ? value : Number(value ?? 0)
})

/** 步进下限（`min` 可能是模板里的静态字符串） */
const floor = computed<number>(() =>
  typeof props.min === 'number' ? props.min : Number(props.min),
)

/**
 * 正式界面是否用步进：
 *   · **数字型默认步进**（不手输但仍可操作；格号那种文本型仍是只读 + 点图）；
 *   · `readonly` 强制只读（"空 = 全部/自动"这类步进表达不了的语义）。
 */
const useStepper = computed<boolean>(() => props.type === 'number' && props.readonly !== true)

function onInput(event: Event): void {
  const el = event.target as HTMLInputElement
  if (props.type === 'number') {
    emit('update:modelValue', el.value === '' ? '' : Number(el.value))
  } else {
    emit('update:modelValue', el.value)
  }
}

function step(delta: number): void {
  const next = Math.max(floor.value, Math.trunc(numeric.value) + delta)
  emit('update:modelValue', next)
}
</script>

<template>
  <input
    v-if="uiMode === 'verify'"
    :type="type"
    :value="modelValue ?? ''"
    :placeholder="placeholder"
    v-bind="$attrs"
    @input="onInput"
  />
  <!-- 条 24：正式界面"可操作但不手输"的步进（数字型默认走这里；readonly 除外） -->
  <span v-else-if="useStepper" class="ui-field-stepper">
    <button
      type="button"
      class="ui-field-stepper__btn"
      :disabled="numeric <= floor"
      @click="step(-1)"
    >
      －
    </button>
    <span class="ui-field-readonly">{{ numeric }}</span>
    <button type="button" class="ui-field-stepper__btn" @click="step(1)">＋</button>
  </span>
  <span v-else class="ui-field-readonly">{{
    modelValue === '' || modelValue == null ? '—' : modelValue
  }}</span>
</template>
