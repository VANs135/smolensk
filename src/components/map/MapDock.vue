<script setup lang="ts">
import { ref, watch } from 'vue'

import { BaseTag } from '@/components/base'

import { clampDockOffset, createDockMemory, DOCK_MIN_VISIBLE_PX } from './dock-position'

/**
 * **唯一会话框**（B4，方案 §4.3；原 W7 C16 的可拖动结算面板）
 *
 * ## 用户口径
 *   「所有战斗、轰炸页面也是单位在战斗、轰炸阶段执行操作时才会在地图上展开一张**可以拖动**的页面，
 *    页面**默认在地图窗口右上角**以免挡视线，突袭也一样」——且**同一时刻只挂载一个**会话框。
 *
 * ## 本组件负责的四件事（方案 §4.3）
 *   ① **隔离**：滚轮不冒泡到地图（否则在面板里滚一下就缩放地图），指针事件也不落到画布
 *      （否则在面板里点一下＝在地图上点一下格子）；
 *   ② **回弹**：拖动只走标题栏；松手把标题栏夹回容器内 ≥ `DOCK_MIN_VISIBLE_PX`；
 *   ③ **位置记忆**：同一会话类型（`sessionKey`）记住上次位置，换类型回到默认右上角；
 *   ④ **取消**：`Esc`（由快捷键层调 `mapView.cancelSession`）与右上角「×」走**同一条路**，
 *      都落到引擎的 `cancelXxx`（不自己造第二套取消语义）。
 *
 * ## 分工纪律（CODE_SPEC §3.1）
 *   拖动只改本组件的局部 `offset`，**不写任何状态、不碰引擎**；显示/隐藏由调用方按引擎状态决定
 *   （战斗 / 轰炸 `finished` 即自动消失）。`DOCK_MIN_VISIBLE_PX` 只用于样式说明，判定在纯函数里。
 */

const props = defineProps<{
  /** 面板标题（如「战斗结算（9.2）」） */
  title: string
  /** 规则出处（可选；只作标签显示） */
  rule?: string
  /** 宽度（CSS 值；缺省 380px 上限） */
  width?: string
  /**
   * 会话类型（位置记忆的键）
   *
   * 同一类型记住上次位置；**换类型回到默认右上角**（新类型在记忆表里没有记录，自然回默认）。
   */
  sessionKey: string
}>()

/**
 * 位置记忆（模块作用域 ⇒ 会话框卸载重挂后仍记得）
 *
 * 只记在内存里：刷新页面即回默认位置。规格要的是"同一会话类型记住上次位置"，没要求跨刷新持久化；
 * 真要持久化得走 `shared/storage`，那是另一批的事（不做，免得多一处状态源）。
 */
const dockMemory = createDockMemory()

/** 最小可见量（模板里给出可读提示；判定在 `clampDockOffset`） */
const minVisiblePx = DOCK_MIN_VISIBLE_PX

defineEmits<{ (e: 'close'): void }>()

const root = ref<HTMLElement | null>(null)
const head = ref<HTMLElement | null>(null)

/** 拖动产生的平移量（相对「右上角」这个默认锚点） */
const offset = ref<{ dx: number; dy: number }>({ dx: 0, dy: 0 })

/** 拖动会话（按下时的指针位置 + 当时的平移量） */
const drag = ref<{ x: number; y: number; dx: number; dy: number } | null>(null)

/** 装载 / 换类型时取回该类型上次的位置（没有记录＝默认右上角） */
function loadPosition(key: string): void {
  const remembered = dockMemory.recall(key)
  offset.value = remembered ?? { dx: 0, dy: 0 }
}

watch(() => props.sessionKey, loadPosition, { immediate: true })

/** 面板在"偏移为零"时的基准矩形（`getBoundingClientRect` 已含 transform，故要减回去） */
function baseRectOf(element: HTMLElement): {
  left: number
  top: number
  right: number
  bottom: number
} {
  const rect = element.getBoundingClientRect()
  const { dx, dy } = offset.value
  return {
    left: rect.left - dx,
    top: rect.top - dy,
    right: rect.right - dx,
    bottom: rect.bottom - dy,
  }
}

function onPointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement
  target.setPointerCapture(event.pointerId)
  drag.value = {
    x: event.clientX,
    y: event.clientY,
    dx: offset.value.dx,
    dy: offset.value.dy,
  }
  event.preventDefault()
}

function onPointerMove(event: PointerEvent): void {
  const current = drag.value
  if (current === null) return
  offset.value = {
    dx: current.dx + (event.clientX - current.x),
    dy: current.dy + (event.clientY - current.y),
  }
}

/**
 * 松手：**先把位置夹回容器内**，再记进位置记忆
 *
 * 不夹的话，拖出地图窗口就再也点不到标题栏了（容器 `overflow: hidden` 会让它在视觉上直接消失）。
 */
function onPointerUp(event: PointerEvent): void {
  const target = event.target as HTMLElement
  if (target.hasPointerCapture?.(event.pointerId) === true) {
    target.releasePointerCapture(event.pointerId)
  }
  const wasDragging = drag.value !== null
  drag.value = null
  if (!wasDragging) return
  const element = root.value
  const container = element?.parentElement ?? null
  if (element === null || container === null) return
  offset.value = clampDockOffset({
    container: container.getBoundingClientRect(),
    base: baseRectOf(element),
    offset: offset.value,
    headerHeight: head.value?.getBoundingClientRect().height ?? 0,
  })
  dockMemory.remember(props.sessionKey, offset.value)
}

/** 回到默认位置（双击标题栏） */
function resetPosition(): void {
  offset.value = { dx: 0, dy: 0 }
  dockMemory.remember(props.sessionKey, offset.value)
}
</script>

<template>
  <!--
    ★ 隔离（方案 §4.3）：面板里的一切输入都**到此为止**，不再冒泡给地图画布。
      滚轮只 `.stop` 不 `.prevent`（面板内容自己要能滚）；指针与点击全停（否则一次面板内的点击
      会在下面的画布上再点一次格子——那正是「点会话框穿透到地图」这个事故）。
  -->
  <div
    ref="root"
    class="dock"
    :style="{
      width: props.width ?? 'min(380px, 92%)',
      transform: `translate(${offset.dx}px, ${offset.dy}px)`,
    }"
    @wheel.stop
    @pointerdown.stop
    @pointermove.stop
    @pointerup.stop
    @pointercancel.stop
    @click.stop
    @dblclick.stop
  >
    <header
      ref="head"
      class="dock__head"
      :title="`按住此条可拖动面板（双击回默认位置；拖出地图窗口会自动夹回至少 ${minVisiblePx}px）`"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="resetPosition"
    >
      <span class="dock__title">{{ title }}</span>
      <BaseTag v-if="props.rule !== undefined" kind="info">{{ props.rule }}</BaseTag>
      <button
        class="dock__close"
        type="button"
        title="取消本次操作"
        aria-label="取消本次操作"
        @pointerdown.stop
        @click="$emit('close')"
      >
        ×
      </button>
    </header>
    <div class="dock__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.dock {
  /* 默认停在地图窗口右上角（用户口径：以免挡视线）；拖动只改 transform 的平移量 */
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
  z-index: var(--layer-map-popup);
  max-height: 62vh;
  display: flex;
  flex-direction: column;
  background: var(--color-panel);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  font-size: var(--text-sm);
  resize: both;
  overflow: hidden;
}

.dock__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-rule);
  background: var(--color-bg-2);
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.dock__head:active {
  cursor: grabbing;
}

.dock__title {
  flex: 1;
  font-family: var(--font-head);
  font-weight: 700;
  letter-spacing: 0.02em;
}

.dock__close {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-muted);
  font-size: var(--text-sm);
  cursor: pointer;
}

.dock__close:hover {
  background: var(--color-bg-2);
  color: var(--color-ink);
}

.dock__body {
  overflow: auto;
  padding: var(--space-2) var(--space-3);
  min-height: 0;
}
</style>
