<script setup lang="ts">
import { computed } from 'vue'

/**
 * 线性图标（批 6：全站只此一套，不再散装 `▸ × + − ↗`）
 *
 * 画法统一：16×16 视框、`stroke="currentColor"`、专规 1.5 线宽、圆头圆角、不填充。
 * 组件只负责画，不携带语义/文案（`aria-hidden`，标签由按钮自己给）。
 */
const props = withDefaults(
  defineProps<{
    name: 'chevron-right' | 'chevron-down' | 'close' | 'plus' | 'minus' | 'external'
    /** 边长（CSS 值；缺省随字号 1em） */
    size?: string
  }>(),
  { size: '1em' },
)

const PATHS: Readonly<Record<string, readonly string[]>> = {
  'chevron-right': ['M6 3l5 5-5 5'],
  'chevron-down': ['M3 6l5 5 5-5'],
  close: ['M4 4l8 8', 'M12 4l-8 8'],
  plus: ['M8 3v10', 'M3 8h10'],
  minus: ['M3 8h10'],
  external: ['M9 3h4v4', 'M13 3L4 12', 'M11 13H3V5'],
}

const paths = computed<readonly string[]>(() => PATHS[props.name] ?? [])
</script>

<template>
  <svg
    class="icon"
    :width="props.size"
    :height="props.size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="path in paths" :key="path" :d="path" />
  </svg>
</template>

<style scoped>
.icon {
  display: inline-block;
  flex: none;
  vertical-align: -0.125em;
}
</style>
