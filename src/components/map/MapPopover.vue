<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { BaseTag } from '@/components/base'

/**
 * 地图小窗（W7 C16）
 *
 * ## 为什么要有它
 *   规则书里的操作对象是**地图上的格与堆叠**（点堆叠看堆叠、点目标格选任务、在战斗发生处结算），
 *   所以「能在地图上做的选择就不要搬到侧栏」。本组件是那类就近小窗的**公共外壳**：
 *   锚在一个屏幕坐标上（由调用方用 `MapCanvas` 暴露的 `hexToLocal` 把格换算成像素），
 *   内容由调用方给；**不遮屏**（不像 `BaseDialog` 那样拦截整屏），故玩家仍能看着地图继续点。
 *
 * ## 交互纪律
 *   · 点小窗之外的地方**不自动关闭**：由调用方决定何时关（避免误触丢掉正在进行的九步流程）；
 *   · 提供显式关闭（×）；Esc 由快捷键层统一处理（它优先关小窗，见 `stores/hotkeys.ts`）；
 *   · **可拖动**：按住标题栏可把小窗挪开（拖走它才能点到被它压住的那几格——「窗口不定死」）。
 *     换到另一格（锚点变）时拖动位移自动归零，小窗回到新格的锚点上。
 */

const props = withDefaults(
  defineProps<{
    /** 是否显示 */
    open: boolean
    /** 锚点（视口内 CSS 像素；通常取被点格的中心） */
    x?: number
    y?: number
    title?: string
    /** 标题右侧的规则号标签 */
    rule?: string
    /** 小窗宽度 */
    width?: string
  }>(),
  { x: 0, y: 0, title: '', rule: '', width: '300px' },
)

const emit = defineEmits<{ close: [] }>()

/* ── 拖动（标题栏按住拖） ── */

/** 当前拖动位移（相对锚点） */
const offset = ref({ dx: 0, dy: 0 })

/** 一次拖动的起点（指针按下时的屏幕坐标与当时的位移） */
const drag = ref<{ x: number; y: number; dx: number; dy: number } | null>(null)

function onHeaderPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  drag.value = { x: event.clientX, y: event.clientY, dx: offset.value.dx, dy: offset.value.dy }
}

function onHeaderPointerMove(event: PointerEvent): void {
  const state = drag.value
  if (state === null) return
  offset.value = {
    dx: state.dx + (event.clientX - state.x),
    dy: state.dy + (event.clientY - state.y),
  }
}

function onHeaderPointerUp(event: PointerEvent): void {
  const handle = event.currentTarget as HTMLElement
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
  drag.value = null
}

// 换格（锚点变）⇒ 位移归零：小窗回到新格的锚点上，不把上一格的拖动残留带过来
watch(
  () => [props.x, props.y],
  () => {
    offset.value = { dx: 0, dy: 0 }
  },
)

/** 视口边界内夹取（保证小窗始终看得见，且拖得到） */
const position = computed(() => {
  const clampX = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), Math.max(max, min))
  if (typeof window === 'undefined') {
    return { left: `${props.x + offset.value.dx}px`, top: `${props.y + offset.value.dy}px` }
  }
  return {
    left: `${clampX(props.x + offset.value.dx, 60, window.innerWidth - 60)}px`,
    top: `${clampX(props.y + offset.value.dy, 10, window.innerHeight - 40)}px`,
  }
})

/** 是否正在拖动（给标题栏换个光标） */
const dragging = computed(() => drag.value !== null)
</script>

<template>
  <div v-if="props.open" class="popover" :style="{ ...position, width: props.width }">
    <header
      class="popover__header"
      :class="{ 'popover__header--dragging': dragging }"
      title="按住拖动小窗"
      @pointerdown="onHeaderPointerDown"
      @pointermove="onHeaderPointerMove"
      @pointerup="onHeaderPointerUp"
      @pointercancel="onHeaderPointerUp"
    >
      <span class="popover__title">{{ props.title }}</span>
      <BaseTag v-if="props.rule !== ''" kind="neutral">{{ props.rule }}</BaseTag>
      <button
        class="popover__close"
        type="button"
        aria-label="关闭小窗"
        @pointerdown.stop
        @click="emit('close')"
      >
        ×
      </button>
    </header>
    <div class="popover__body">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="popover__footer">
      <slot name="footer" />
    </footer>
  </div>
</template>

<style scoped>
.popover {
  position: fixed;
  z-index: var(--z-dialog-top);
  transform: translate(-50%, 0);
  background: var(--color-panel);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  font-size: var(--text-sm);
}

.popover__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-rule);
  background: var(--color-bg-2);
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  cursor: grab;
  /* 拖动时不要顺带选中标题文字 */
  user-select: none;
  touch-action: none;
}

.popover__header--dragging {
  cursor: grabbing;
}

.popover__title {
  flex: 1;
  font-family: var(--font-head);
  font-weight: 700;
  letter-spacing: 0.02em;
}

.popover__close {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.popover__close:hover {
  background: var(--color-bg);
  color: var(--color-ink);
}

.popover__body {
  padding: var(--space-2) var(--space-3);
  max-height: 46vh;
  overflow: auto;
}

.popover__footer {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-rule);
  background: var(--color-bg-2);
  border-radius: 0 0 var(--radius-md) var(--radius-md);
}
</style>
