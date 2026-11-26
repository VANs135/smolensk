<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'

import type { MapSessionClosePolicy } from '@/stores/map-view'
import { useMapViewStore } from '@/stores'

import { BaseIcon, BaseTag, PANEL_FLAT } from '@/components/base'
import { SESSION_STEP_GATE, SESSION_STEP_HOSTED, SESSION_STEP_PROGRESS } from '@/components/session'

import { clampDockOffset, createDockMemory } from './dock-position'

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
  /**
   * 关闭语义（P3 / UI3，方案 §5 `closePolicy`）
   *
   * 由 `mapView.session` 只读投影传入；本组件只决定文案与可用态，不自己判"能不能取消"。
   */
  closePolicy?: MapSessionClosePolicy
  /** `refused` 时的原因（与领域拒绝文案同源） */
  closeBlockedReason?: string
}>()

/**
 * 位置记忆（模块作用域 ⇒ 会话框卸载重挂后仍记得）
 *
 * 只记在内存里：刷新页面即回默认位置。规格要的是"同一会话类型记住上次位置"，没要求跨刷新持久化；
 * 真要持久化得走 `shared/storage`，那是另一批的事（不做，免得多一处状态源）。
 */
const dockMemory = createDockMemory()

/**
 * U1-b：把**当前唯一待决事项**注入给会话面板
 *
 * 面板里的 `<SessionStep :item="…">` 只在 id 命中时渲染 ⇒ 同一会话一次只显示一件事。
 * 这里只做转发（`mapView.sessionStep` 是 store 投影），不判规则。
 */
const mapView = useMapViewStore()
provide(
  SESSION_STEP_GATE,
  computed(() => mapView.sessionStep),
)
/** 批二：标记「有宿主」，让 SessionStep 区分「无待决」与「没有宿主」 */
provide(SESSION_STEP_HOSTED, true)

/**
 * 批 4：步进位置（当前第几件 / 共几件）
 *
 * 宿主手里有整张步骤清单（`mapView.sessionSteps`），内层 `SessionStep` 只有当前一件；
 * 位置在这里算好注入，步进头显示「2/6」。
 */
provide(
  SESSION_STEP_PROGRESS,
  computed(() => {
    const current = mapView.sessionStep
    if (current === null) return null
    const at = mapView.sessionSteps.findIndex((item) => item.id === current.id)
    return at < 0 ? null : { index: at + 1, total: mapView.sessionSteps.length }
  }),
)

/**
 * 批 4：会话框内层面板改用扁平紧凑变体
 *
 * 会话框自己已经有边框、标题与外层内边距；内层 `BasePanel` 再画一遍就是双框 + 双层内边距
 * （380px 宽下尤其挤）。这里注入后，内层面板只留内容。
 */
provide(PANEL_FLAT, true)

/** 最小可见量（模板里给出可读提示；判定在 `clampDockOffset`） */

defineEmits<{ (e: 'close'): void }>()

/**
 * 收起（`⌄`）：只把窗体折成标题栏一行，**会话状态一概保留**
 *
 * 与 `×` 的区别：`×` 走 `cancelSession`（引擎真的放弃这一手）；这里只是"先让开地图"，
 * 再点一次原样展开。会话本身仍挂着，步进 / 待决事项都不动。
 */
const bodyCollapsed = ref(false)

function toggleBody(): void {
  bodyCollapsed.value = !bodyCollapsed.value
}

/** 关闭按钮的文案（三种语义各说各的，不再一律「取消本次操作」） */
const closeLabel = computed<string>(() => {
  if (props.closePolicy === 'collapse') return '收起本次会话'
  if (props.closePolicy === 'refused') {
    return props.closeBlockedReason === undefined
      ? '暂不可关闭'
      : `暂不可关闭：${props.closeBlockedReason}`
  }
  return '取消本次操作'
})

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
      width: props.width ?? 'min(430px, 92%)',
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
      title="拖动面板 · 双击复位"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="resetPosition"
    >
      <span class="dock__title">{{ title }}</span>
      <BaseTag v-if="props.rule !== undefined" kind="info">{{ props.rule }}</BaseTag>
      <!-- 收起（状态保留）：只折体，不碰会话 -->
      <button
        class="dock__ico"
        type="button"
        :title="bodyCollapsed ? '展开' : '收起（状态保留）'"
        :aria-expanded="!bodyCollapsed"
        aria-label="收起或展开窗体"
        @pointerdown.stop
        @click="toggleBody()"
      >
        <BaseIcon :name="bodyCollapsed ? 'chevron-right' : 'chevron-down'" />
      </button>
      <button
        v-if="props.closePolicy !== 'refused'"
        class="dock__close"
        type="button"
        :title="closeLabel"
        :aria-label="closeLabel"
        @pointerdown.stop
        @click="$emit('close')"
      >
        <BaseIcon name="close" />
      </button>
      <!-- refused：不给 ×（那会是个点了没反应的按钮），改一枚「▣ 不可关」 -->
      <span v-else class="dock__ico dock__ico--locked" :title="closeLabel" aria-label="不可关">
        ▣
      </span>
    </header>
    <div v-show="!bodyCollapsed" class="dock__body">
      <!--
        用户 2026-11-12：自动步（9.8 / 9.9）期间没有待决事项，`sessionStep` 为 null——
        此时**不要**回落成任何"流程结束"文案。会话真要收束时会自行卸载。
      -->
      <slot />
    </div>
  </div>
</template>

<style scoped>
.dock {
  /* 默认停在地图窗口右上角（用户口径：以免挡视线）；拖动只改 transform 的平移量 */
  position: absolute;
  top: var(--space-3);
  /*
   * 2026-11-26：右上角的缩放簇（30×30 按钮 + 4px 内边距 + 1px 边框 = 40px 宽，
   * 贴 right 8px）先占住最右 48px；会话框默认位再右贴 12px 会被它压住标题栏与 ×。
   * 故默认位向右让开 40px，保留 4px 间隙。
   */
  right: calc(var(--space-3) + 40px);
  z-index: var(--layer-map-popup);
  max-height: min(68vh, calc(100% - 2 * var(--space-3)));
  max-width: calc(100% - 2 * var(--space-3) - 40px);
  display: flex;
  flex-direction: column;
  background: var(--color-panel);
  border: 1px solid var(--color-rule);
  border-top: 3px solid var(--color-accent);
  border-radius: var(--radius-lg);
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
  min-width: 0;
  line-height: 1.35;
  font-family: var(--font-head);
  font-weight: 700;
  letter-spacing: 0.02em;
}

.dock__close,
.dock__ico {
  flex: none;
  display: grid;
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  place-items: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-muted);
  font-size: var(--text-sm);
  cursor: pointer;
}

.dock__ico--locked {
  cursor: default;
  opacity: 0.7;
}

.dock__close:hover {
  background: var(--color-panel);
  color: var(--color-ink);
}

.dock__close:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.dock__body {
  overflow: auto;
  padding: var(--space-3);
  min-height: 0;
  overscroll-behavior: contain;
}
</style>
