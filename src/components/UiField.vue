<script setup lang="ts">
import { useUiMode } from './ui-mode'

defineOptions({ inheritAttrs: false })

/**
 * 条 24 / §5-F：把"手输"文本/数字输入框收敛成**单一入口**。
 *
 * - 验证页（`uiMode === 'verify'`）：渲染可编辑 `<input>`，保留裁判/复核的全部手输退路；
 * - 正式界面（`uiMode === 'formal'`）：渲染**只读** `<span>`，用户不能在正式对局里手输文本/数值
 *   （格号改点图、数值由引擎/骰子自动带出，见第六批 §5-E）。
 *
 * 用法替代原 `<input v-model="x" ... />`：`<UiField v-model="x" type="number" placeholder="..." />`。
 * 其余属性（class、min/max、@change 等）经 `$attrs` 透传到 `<input>` 分支。
 */
const props = withDefaults(
  defineProps<{
    modelValue?: string | number | null
    type?: string
    placeholder?: string
  }>(),
  { type: 'text', modelValue: '', placeholder: '' },
)

const emit = defineEmits<{ (e: 'update:modelValue', v: string | number): void }>()

const uiMode = useUiMode()

function onInput(event: Event): void {
  const el = event.target as HTMLInputElement
  if (props.type === 'number') {
    emit('update:modelValue', el.value === '' ? '' : Number(el.value))
  } else {
    emit('update:modelValue', el.value)
  }
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
  <span v-else class="ui-field-readonly">{{
    modelValue === '' || modelValue == null ? '—' : modelValue
  }}</span>
</template>
