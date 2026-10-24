<script setup lang="ts">
import { computed } from 'vue'

import { useUiMode } from './ui-mode'

defineOptions({ inheritAttrs: false })

/**
 * 条 24 / §5-F：把"手输"文本/数字输入框收敛成**单一入口**。
 *
 * - 验证页（`uiMode === 'verify'`）：渲染可编辑 `<input>`，保留裁判/复核的全部手输退路；
 * - 正式界面（`uiMode === 'formal'`）：
 *   · 默认渲染**只读** `<span>`（格号改点图、数值由引擎/骰子自动带出，见 §5-E）；
 *   · 传 `stepper` 时渲染 `－ 值 ＋` **步进**——用于"是玩家真实选择、又无点图替代"的数量
 *     （拆分/销毁/装载/拖取量等）：正式界面**不手输**但仍可操作，验证页仍是可输入框。
 *
 * 用法替代原 `<input v-model="x" ... />`：`<UiField v-model="x" type="number" stepper />`。
 * 其余属性（class、min/max、@change 等）经 `$attrs` 透传到 `<input>` 分支。
 */
const props = withDefaults(
  defineProps<{
    modelValue?: string | number | null
    type?: string
    placeholder?: string
    /** 正式界面用步进代替只读（用于真实选择的数量；默认只读） */
    stepper?: boolean
    /** 步进下限（默认 0；接受 number|string，兼容模板里的静态 `min="0"`） */
    min?: number | string
  }>(),
  { type: 'text', modelValue: '', placeholder: '', stepper: false, min: 0 },
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
  <!-- 条 24：正式界面"可操作但不手输"的步进（用于真实选择的数量） -->
  <span v-else-if="stepper" class="ui-field-stepper">
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
