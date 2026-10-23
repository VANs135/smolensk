<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'

import { BaseTag } from '@/components/base'
import { clampDockOffset } from '@/components/map/dock-position'
import { counterImages } from '@/render/token-images'
import { useContainersStore, type AuxCardView } from '@/stores'

import { auxCardImageUrl } from './aux-card-image'
import BoxCardFace from './BoxCardFace.vue'

/**
 * **盒卡**（B12）：把「盒」按**真实辅助卡卡面**画出来，并把盒内算子摆进**标定好的分区**
 *
 * ## 依据
 *   卡面与分区来自用户 2026-09-16 交付的标定（`aux-cards.json`：7 张卡 / 若干分区，卡面像素矩形）；
 *   区内容物来自引擎名册（`BoxHolding`，按 `REGION_OF_BOX` 把分区对到盒的栏）。
 *   ⇒ 本组件只画被给的东西：**不算坐标、不判规则**；卡面本身由 `BoxCardFace.vue` 画
 *   （托盘里 320px、**浮窗**里更宽，两处共用同一份渲染）。
 *
 * ## 折叠（用户口径④）
 *   「**盒也是折叠打开**（**同时只展开一张**）」⇒ 卡头一行（名称 + 区内容物枚数）可点，
 *   展开后才是卡面；展开态由 `store` 管（`containers.cardOpenId`）。
 *
 * ## C-2（B35 切片 C）：**弹出为浮窗**
 *   「卡面 320px 宽，看图不方便」⇒ 卡头右侧的「弹出」把同一张卡放到 `position: fixed` 浮层里
 *   （更宽、可拖动、Esc 关、点关闭关）。拖动沿用唯一会话框那套几何（`clampDockOffset`）：
 *   松手时把**标题栏**夹回视口内，至少留 `DOCK_MIN_VISIBLE_PX` 可见 —— 拖不丢。
 */
const props = defineProps<{
  /** 一张卡的投影（卡面 + 分区 + 区内容物） */
  card: AuxCardView
}>()

const containers = useContainersStore()

/** 托盘里的显示宽度（像素；卡面按原始比例缩放。窄屏用百分比由外层控制） */
const displayWidth = ref(320)

/** 浮窗里的显示宽度（更宽 ⇒ 看图舒服；窄屏靠 max-width 兜底） */
const popupWidth = computed(() => Math.min(720, Math.max(360, Math.round(window.innerWidth * 0.6))))

/** 是否展开卡面（托盘里那张；用户口径④：同时只展开一张） */
const open = computed(() => containers.cardOpenId === props.card.id)

/** 是否正在**浮窗**里看这张卡（C-2） */
const popped = computed(() => containers.popupCardId === props.card.id)

/** 卡面图 URL（懒加载用；与 `token-images` 同一套编码） */
const imageUrl = computed(() => auxCardImageUrl(props.card.image))

/** 该卡内**算子总数**（卡头角标：一眼看出这张卡里有多少东西） */
const unitTotal = computed(() =>
  props.card.regions.reduce((total, region) => total + region.units.length, 0),
)

/** 展开时把图读进来（懒加载：不展开的卡不拉图） */
function onToggle(): void {
  containers.toggleCardOpen(props.card.id)
  if (containers.cardOpenId !== props.card.id) return
  void counterImages.preload([imageUrl.value])
}

/* ────────────────────────── C-2 浮窗：拖动 / 关闭 ────────────────────────── */

const popupRef = ref<HTMLElement | null>(null)
/** 相对默认锚点（视口正中偏上）的平移量 */
const popupOffset = ref<{ dx: number; dy: number }>({ dx: 0, dy: 0 })
const drag = ref<{ startX: number; startY: number; dx: number; dy: number } | null>(null)

/** 打开浮窗（并把位置与图重置/读进来） */
function openPopup(): void {
  containers.setPopupCard(props.card.id)
  popupOffset.value = { dx: 0, dy: 0 }
  void counterImages.preload([imageUrl.value])
}

/** 关闭浮窗（Esc / ×） */
function closePopup(): void {
  drag.value = null
  containers.setPopupCard(null)
}

function onPopupPointerDown(event: PointerEvent): void {
  drag.value = {
    startX: event.clientX,
    startY: event.clientY,
    dx: popupOffset.value.dx,
    dy: popupOffset.value.dy,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onPopupPointerMove(event: PointerEvent): void {
  const current = drag.value
  if (current === null) return
  popupOffset.value = {
    dx: current.dx + (event.clientX - current.startX),
    dy: current.dy + (event.clientY - current.startY),
  }
}

/**
 * 松手：把浮窗夹回视口内（**复用唯一会话框的同一套几何**，不另写一份回弹）
 *
 * `base` ＝ 偏移为零时浮窗所在的矩形 ⇒ 用当前矩形减去当前偏移即得（无需另存一份测量）。
 */
function onPopupPointerUp(): void {
  if (drag.value === null) return
  drag.value = null
  const element = popupRef.value
  if (element === null) return
  const rect = element.getBoundingClientRect()
  const offset = popupOffset.value
  popupOffset.value = clampDockOffset({
    container: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
    base: {
      left: rect.left - offset.dx,
      top: rect.top - offset.dy,
      right: rect.right - offset.dx,
      bottom: rect.bottom - offset.dy,
    },
    offset,
    headerHeight: 28,
  })
}

/** Esc 关浮窗（只有开着时才处理，免得抢别处的按键） */
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !popped.value) return
  closePopup()
}

window.addEventListener('keydown', onWindowKeydown)
onUnmounted(() => window.removeEventListener('keydown', onWindowKeydown))
</script>

<template>
  <section class="boxcard" :class="{ 'boxcard--open': open }">
    <div class="boxcard__headrow">
      <button type="button" class="boxcard__head" @click="onToggle">
        <span class="boxcard__caret">{{ open ? '▾' : '▸' }}</span>
        <span class="boxcard__name">{{ card.name }}</span>
        <span class="boxcard__count num">{{ unitTotal }}</span>
      </button>
      <!-- C-2：弹出为浮窗（卡面 320px 宽时看图不方便） -->
      <button
        type="button"
        class="boxcard__pop"
        title="弹出为浮窗（可拖动、Esc 关）"
        @click="popped ? closePopup() : openPopup()"
      >
        ⧉
      </button>
    </div>

    <template v-if="open">
      <BoxCardFace :card="card" :width="displayWidth" />

      <p class="boxcard__hint num">
        <BaseTag kind="neutral">只读</BaseTag>
        卡内算子是**选谁**用的：动作在展开卡后弹出的会话框里做（重建 / 整编 / 抽取 / 返场）。
      </p>
    </template>

    <!-- C-2：浮窗（Teleport 到 body，免得被托盘的 overflow 裁掉） -->
    <Teleport to="body">
      <div
        v-if="popped"
        ref="popupRef"
        class="boxpopup"
        :style="{ transform: `translate(${popupOffset.dx}px, ${popupOffset.dy}px)` }"
      >
        <div
          class="boxpopup__head"
          @pointerdown="onPopupPointerDown"
          @pointermove="onPopupPointerMove"
          @pointerup="onPopupPointerUp"
          @pointercancel="onPopupPointerUp"
        >
          <span class="boxpopup__title">{{ card.name }}</span>
          <span class="num">{{ unitTotal }} 枚</span>
          <button type="button" class="boxpopup__close" @click="closePopup">×</button>
        </div>
        <BoxCardFace :card="card" :width="popupWidth" />
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.boxcard {
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-panel);
  overflow: hidden;
}

.boxcard__headrow {
  display: flex;
  align-items: stretch;
}

.boxcard__head {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-2);
  border: none;
  background: var(--color-bg-2);
  color: var(--color-ink);
  cursor: pointer;
  text-align: left;
  font-size: var(--text-sm);
}

/* C-2：弹出按钮（与卡头同一行，不占卡面空间） */
.boxcard__pop {
  padding: 0 var(--space-2);
  border: 1px solid var(--color-rule);
  background: var(--color-bg-2);
  color: var(--color-ink);
  cursor: pointer;
}

.boxcard__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.boxcard__count {
  color: var(--color-muted);
}

.boxcard__hint {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0 var(--space-2) var(--space-1);
  color: var(--color-muted);
  font-size: var(--text-xs);
}

/* ── C-2 浮窗（position: fixed；拖动范围由 clampDockOffset 夹住） ── */
.boxpopup {
  position: fixed;
  left: 50%;
  top: 8%;
  z-index: 40;
  max-width: 94vw;
  max-height: 88vh;
  overflow: auto;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  box-shadow: var(--shadow-md);
}

.boxpopup__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--color-rule);
  background: var(--color-bg-2);
  cursor: move;
  touch-action: none;
}

.boxpopup__title {
  flex: 1;
  font-weight: 600;
}

.boxpopup__close {
  border: none;
  background: none;
  color: var(--color-ink);
  cursor: pointer;
  font-size: var(--text-lg);
}
</style>
