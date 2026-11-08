<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { BaseButton, BaseTag } from '@/components/base'
import { clampDockOffset } from '@/components/map/dock-position'
import { useSetupStore, type DecisionStack, type SetupPlacing } from '@/stores'

/**
 * **待你决定的队列**（B11；地图左上角 · 四堆叠）
 *
 * ## 用户口径⑨
 *   「地图窗口左上角的框（**地面 / 非战斗 / 飞机 / 卡车**各一堆叠，点开可多选）→ 选中单位时**高亮可放格** →
 *    点地图格**落一个**（**同型多枚时逐个落**，数量角标递减到 0 才关卡片）；
 *    飞机先高亮本方空军基地格；卡车卡片上直接选「满载 1F / 空载 1」（13.2h）」。
 *
 * ## 这一件东西修好了哪两条备忘
 *   · **#1**：放飞机后数量**真的减**（逐枚落位 + 进度来自 store），且基地未落位时提示「先落本方空军基地（14.1a）」
 *     ——不再冒出引擎那句"调用方未提供 airBaseHexes"；
 *   · **#2**：同型多枚**可落在不同格**（点一格落一枚，卡片留到落满）。
 *
 * ## 分层纪律
 *   本组件只画与收点击：四堆的分组、每堆还剩几枚、每张卡的 `remaining/total`、阻塞原因
 *   **全部来自 `setup.decisionQueue`**（store 侧投影）；本组件不解释规则、不自己数数。
 *   ★ 卡片内的算子图阵列（`CounterPicker`）属 B13，本批先用紧凑文字卡（算子上信息已够，故不加额外说明）。
 */

const setup = useSetupStore()
const emit = defineEmits<{
  airDrag: [source: { side: 'axis' | 'soviet'; entryIndex: number } | null]
}>()
const airMenu = ref<number | null>(null)

function openAirMenu(item: SetupPlacing): void {
  airMenu.value = item.offMapAllowed === true ? item.entryIndex : null
}

function startAirDrag(event: DragEvent, item: SetupPlacing): void {
  if (item.offMapAllowed !== true || event.dataTransfer === null) {
    event.preventDefault()
    return
  }
  airMenu.value = null
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', item.label)
  emit('airDrag', { side: item.side, entryIndex: item.entryIndex })
}

function placeInBox(item: SetupPlacing): void {
  airMenu.value = null
  setup.placeAirInOffMapBoxNow(item.side, item.entryIndex)
}

/** 展开的堆叠（同一时刻只展开一堆：四堆合计几十项，全展开会把地图盖住） */
const openKey = ref<DecisionStack['key'] | null>('ground')

/**
 * 四堆（含枚数与卡片）
 *
 * ★ 第六批条 1（S1）：读**按当前方过滤**的队列（先布设方在前，逐方确认后换手）。
 *   游标未起（或两方都已确认）时 `sideQueue` 就是全量 `decisionQueue` ⇒ 行为与修前一致。
 */
const stacks = computed(() => setup.sideQueue)

/** 当前轮到哪一方布设（null = 不分方 / 两方都已确认） */
const cursorSide = computed(() => setup.setupSideCursor)

function sideName(side: 'axis' | 'soviet'): string {
  return side === 'axis' ? '轴心国' : '苏联'
}

/** 还没落位的**总枚数**（标题上的角标） */
const pendingTotal = computed(() => stacks.value.reduce((total, stack) => total + stack.count, 0))

/** 当前正在地图上选落点的那一项（null = 没在放） */
const placing = computed(() => setup.placing)
const omitConfirmed = ref(false)
watch([() => setup.scenarioId, () => setup.omittablePlacements], () => {
  omitConfirmed.value = false
})
watch(cursorSide, () => {
  airMenu.value = null
})

/** 是否**全部落位完毕**（落满 ⇒ 队列收起列表、就地给「完成初设」） */
const allPlaced = computed(() => setup.initialPlacementsComplete)

function toggleStack(key: DecisionStack['key']): void {
  airMenu.value = null
  openKey.value = openKey.value === key ? null : key
}

/* ── B38：拖动（与唯一会话框同一套几何；松手夹回容器内，至少留 8px 可见，拖不丢） ── */

const rootRef = ref<HTMLElement | null>(null)
const offset = ref<{ dx: number; dy: number }>({ dx: 0, dy: 0 })
const drag = ref<{ startX: number; startY: number; dx: number; dy: number } | null>(null)

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  drag.value = {
    startX: event.clientX,
    startY: event.clientY,
    dx: offset.value.dx,
    dy: offset.value.dy,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  const current = drag.value
  if (current === null) return
  offset.value = {
    dx: current.dx + (event.clientX - current.startX),
    dy: current.dy + (event.clientY - current.startY),
  }
}

/**
 * 松手：把框夹回**地图容器**内（复用唯一会话框那套 `clampDockOffset`，不另写一份回弹）
 *
 * 容器 = 最近的定位祖先（`offsetParent`，即地图窗口）；
 * 偏移为零时的矩形 ＝ 当前矩形减去当前偏移（不必另存一份测量）。
 */
function onPointerUp(): void {
  if (drag.value === null) return
  drag.value = null
  const element = rootRef.value
  const container = (element?.offsetParent as HTMLElement | null) ?? null
  if (element === null || container === null) return
  const rect = element.getBoundingClientRect()
  const base = container.getBoundingClientRect()
  const current = offset.value
  offset.value = clampDockOffset({
    container: { left: base.left, top: base.top, right: base.right, bottom: base.bottom },
    base: {
      left: rect.left - current.dx,
      top: rect.top - current.dy,
      right: rect.right - current.dx,
      bottom: rect.bottom - current.dy,
    },
    offset: current,
    headerHeight: 28,
  })
}

/** 该卡是否是当前正在落位的那一项 */
function isActive(item: SetupPlacing): boolean {
  const current = placing.value
  if (current === null) return false
  return (
    current.kind === item.kind &&
    current.entryIndex === item.entryIndex &&
    current.side === item.side &&
    // §6-A：ch10 西移项没有 entryIndex ⇒ 按编队 id 比对
    (item.kind !== 'shift' || current.formationId === item.formationId)
  )
}

/** 点卡片：开始在地图上落位（飞机走空军基地格；卡车直接在卡上选满载） */
function pick(item: SetupPlacing): void {
  airMenu.value = null
  if (item.kind === 'truck') return
  if (item.blockedReason !== null) {
    openAirMenu(item)
    return
  }
  // §6-A：ch10 抽中西移的师（落点按原文算法（沿道路西移 3 格）得出，道路数据不全 ⇒ 由玩家点地图给）
  if (item.kind === 'shift') {
    if (item.formationId !== undefined) setup.beginShiftPlacement(item.formationId)
    return
  }
  if (item.kind === 'self') setup.beginSelfPlacement(item.entryIndex)
  else setup.beginAirPlacement(item.side, item.entryIndex)
}

/** 阵营标记（只作显示；不参与任何判定） */
function sideMark(side: 'axis' | 'soviet'): string {
  return side === 'axis' ? '轴' : '苏'
}
</script>

<template>
  <section
    ref="rootRef"
    class="queue"
    :style="{ transform: 'translate(' + offset.dx + 'px, ' + offset.dy + 'px)' }"
    aria-label="初设"
    @pointerdown.stop
    @click.stop
    @wheel.stop
    @keydown.esc="airMenu = null"
  >
    <!-- B38：标题栏可拖（松手夹回地图窗口内；口径 #5「初设框不能拖」） -->
    <header
      class="queue__head"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <span class="queue__title">初设</span>
      <span v-if="cursorSide !== null" class="queue__current" :data-side="cursorSide">
        {{ sideName(cursorSide) }}
      </span>
      <span class="queue__pending num">{{ pendingTotal }} 待处理</span>
    </header>

    <!--
      第六批条 1（S1）：**分方游标** —— 先布设方（剧本页 `setupFirst`，与"先行动方"是两回事）
      布设完按一下即换手；两方都确认 ⇒ 游标归位、队列恢复全量（未落位者仍按既有口径处理）。
    -->
    <div v-if="cursorSide !== null" class="queue__row-actions">
      <BaseButton variant="primary" size="sm" @click="setup.confirmSideSetup()">
        确认本方布设
      </BaseButton>
    </div>

    <!--
      B38（口径 #5「结束后不自动关」）：**全部落位完毕** ⇒ 队列收起列表、就地给「完成初设」，
      按下即开局（`startGameNow`）；初设收束后本框随 `!setup.finished` 的条件自动消失。
    -->
    <div v-if="allPlaced && cursorSide === null" class="queue__done">
      <BaseButton variant="primary" size="sm" @click="setup.startGameNow()">完成初设</BaseButton>
    </div>

    <div v-if="placing !== null" class="queue__active">
      <strong class="queue__label" :title="placing.label">{{ placing.label }}</strong>
      <span class="queue__pending num">剩 {{ placing.remaining }}</span>
      <BaseButton variant="ghost" size="sm" @click="setup.cancelPlacement()">取消选格</BaseButton>
      <div v-if="placing.category === 'supply'" class="queue__hint">
        本次落
        <button
          v-for="c in setup.placingChunkChoices"
          :key="c"
          type="button"
          class="queue__chunk"
          :class="{ 'queue__chunk--on': placing.chunk === c }"
          :aria-pressed="placing.chunk === c"
          @click="setup.setPlacingChunk(c)"
        >
          {{ c }}
        </button>
      </div>
      <p class="queue__instruction">点击高亮格落位</p>
    </div>

    <div v-if="setup.truckLoadSummary.mode === 'choose_loaded'" class="queue__row-actions">
      <span class="queue__hint num">
        满载 {{ setup.truckLoadSummary.fullCount }}/{{ setup.requiredFullTrucks }} · §13.2h
      </span>
      <BaseButton
        variant="secondary"
        size="sm"
        @click="setup.truckPickActive ? setup.cancelTruckPick() : setup.beginTruckPick()"
      >
        {{ setup.truckPickActive ? '收起高亮' : '点图指定满载' }}
      </BaseButton>
    </div>

    <p v-if="setup.lastAction !== null && !setup.lastAction.ok" class="queue__error" role="status">
      <span class="num">§{{ setup.lastAction.rule }}</span> {{ setup.lastAction.detail }}
    </p>

    <!--
      P4 / UI1-b：三组只读分组（必做事项 / 可自主放弃项 / 已完成项）。
      计数与条目全部来自 store 投影；四堆叠仍是下面可点图落位的操作区。
    -->
    <details v-if="setup.requiredSetupIssues.length > 0" class="queue__group">
      <summary class="queue__group-title">
        <span>必做事项</span>
        <span class="queue__group-count num">{{ setup.requiredSetupIssues.length }}</span>
      </summary>
      <p
        v-for="issue in setup.requiredSetupIssues"
        :key="issue.id"
        class="queue__hint queue__issue"
      >
        <BaseTag kind="warning">{{ issue.rule }}</BaseTag>
        {{ issue.detail }}
      </p>
    </details>

    <details
      v-if="cursorSide === null && setup.omittablePlacements.length > 0"
      class="queue__group"
    >
      <summary class="queue__group-title">
        <span>可自主放弃项</span>
        <span class="queue__group-count num">{{ setup.omittablePlacements.length }}</span>
      </summary>
      <div class="queue__done">
        <ul class="queue__cards">
          <li
            v-for="item in setup.omittablePlacements"
            :key="item.kind + ':' + item.side + ':' + item.entryIndex"
            class="queue__placed-row"
          >
            <span class="queue__side num">{{ sideMark(item.side) }}</span>
            <span class="queue__label" :title="item.label">{{ item.label }}</span>
            <span class="num">× {{ item.remaining }}</span>
          </li>
        </ul>
        <label class="queue__check">
          <input v-model="omitConfirmed" type="checkbox" /> 放弃以上未布设单位
        </label>
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="!omitConfirmed || setup.requiredSetupIssues.length > 0"
          @click="setup.startGameNow()"
        >
          确认放弃并开局
        </BaseButton>
      </div>
    </details>

    <details v-if="setup.completedPlacements.length > 0" class="queue__group">
      <summary class="queue__group-title">
        <span>已完成项</span>
        <span class="queue__group-count num">{{ setup.completedPlacements.length }}</span>
      </summary>
      <ul class="queue__placed">
        <li
          v-for="placement in setup.completedPlacements"
          :key="placement.key"
          class="queue__placed-row"
        >
          <span v-if="placement.imageUrl !== null" class="queue__counter">
            <img :src="placement.imageUrl" :alt="placement.label" class="queue__counter-img" />
          </span>
          <span class="queue__side num">{{ sideMark(placement.side) }}</span>
          <span class="queue__label">{{ placement.label }}</span>
          <span class="queue__badge num">{{ placement.placed }}/{{ placement.total }}</span>
        </li>
      </ul>
    </details>

    <div v-for="stack in stacks" v-show="!allPlaced" :key="stack.key" class="queue__stack">
      <button
        type="button"
        class="queue__stack-btn"
        :aria-expanded="openKey === stack.key"
        @click="toggleStack(stack.key)"
      >
        <span class="queue__stack-name">{{ stack.label }}</span>
        <span class="queue__stack-count num">{{ stack.count }}</span>
        <span class="queue__caret">{{ openKey === stack.key ? '▾' : '▸' }}</span>
      </button>

      <ul v-if="openKey === stack.key && stack.items.length > 0" class="queue__cards">
        <li
          v-for="item in stack.items"
          :key="`${item.kind}:${item.side}:${item.entryIndex}:${item.formationId ?? item.instanceId ?? ''}`"
          class="queue__row"
        >
          <button
            type="button"
            class="queue__card"
            :class="{
              'queue__card--on': isActive(item),
              'queue__card--blocked': item.blockedReason !== null,
            }"
            :title="
              item.offMapAllowed === true
                ? '右键或拖到空军盒'
                : (item.blockedReason ?? `${item.raw}（${sideName(item.side)}）`)
            "
            :aria-pressed="isActive(item)"
            :disabled="
              item.kind === 'truck' || (item.blockedReason !== null && item.offMapAllowed !== true)
            "
            :draggable="item.offMapAllowed === true"
            @click="pick(item)"
            @contextmenu.prevent.stop="openAirMenu(item)"
            @keydown.shift.f10.prevent.stop="openAirMenu(item)"
            @dragstart="startAirDrag($event, item)"
            @dragend="emit('airDrag', null)"
          >
            <!--
              第六批条 1（S1）：**算子图阵列** —— 有图档就画算子（与地图同一份图档来源），
              没有才退回文字（数据里缺图的项目如实退回，不画占位方块冒充算子）。
            -->
            <span v-if="item.imageUrl !== null" class="queue__counter">
              <img
                :src="item.imageUrl"
                :alt="item.label"
                class="queue__counter-img"
                draggable="false"
              />
            </span>
            <span class="queue__side num">{{ sideMark(item.side) }}</span>
            <span class="queue__label">{{ item.label }}</span>
            <span class="queue__badge num">
              {{
                item.kind === 'truck'
                  ? item.placed > 0
                    ? '满载'
                    : '空载'
                  : `${item.placed}/${item.total}`
              }}
            </span>
          </button>

          <BaseButton
            v-if="item.offMapAllowed === true && airMenu === item.entryIndex"
            variant="primary"
            size="sm"
            @click="placeInBox(item)"
          >
            放入地图外空军盒 · 1.4a
          </BaseButton>

          <span v-if="item.blockedReason !== null" class="queue__blocked">
            {{ item.blockedReason }}
          </span>
        </li>
      </ul>
      <p v-else-if="openKey === stack.key" class="queue__empty">无待布设项</p>
    </div>
  </section>
</template>

<style scoped>
/* B38：标题栏是拖动抓手 */
.queue__head {
  cursor: move;
  touch-action: none;
  user-select: none;
}

.queue__done {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}

.queue__group {
  border-top: 1px solid var(--color-rule);
}

.queue__group-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  min-height: var(--control-height-sm);
  font-size: var(--text-xs);
  font-weight: 700;
  cursor: pointer;
  list-style: none;
}

.queue__group-title::-webkit-details-marker {
  display: none;
}

.queue__group-title::before {
  color: var(--color-command-teal);
  content: '+';
}

.queue__group[open] .queue__group-title::before {
  content: '−';
}

.queue__group-count {
  margin-left: auto;
  color: var(--color-muted);
}

.queue__issue {
  margin: 0 0 var(--space-2);
}

.queue__placed {
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.queue__placed-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 1px var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
}

.queue {
  position: absolute;
  left: var(--space-3);
  top: var(--space-3);
  z-index: var(--layer-map-popup);
  width: min(300px, 65%);
  max-height: min(64vh, calc(100% - 2 * var(--space-3)));
  overflow: auto;
  overscroll-behavior: contain;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-lg);
  background: var(--color-panel);
  color: var(--color-ink);
  box-shadow: var(--shadow-lg);
  font-size: var(--text-sm);
  line-height: 1.35;
}

.queue:focus-visible {
  outline-color: var(--color-command-amber);
}

.queue__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-height-sm);
}

.queue__title {
  font-family: var(--font-head);
  font-weight: 700;
  font-size: var(--text-lg);
}

.queue__current {
  font-weight: 700;
}

.queue__current[data-side='axis'] {
  color: var(--color-command-axis);
}

.queue__current[data-side='soviet'] {
  color: var(--color-command-soviet);
}

.queue__pending {
  margin-left: auto;
  color: var(--color-command-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.queue__row-actions,
.queue__active {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}

.queue__row-actions :deep(.btn) {
  margin-left: auto;
}

.queue__active {
  margin-top: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--color-command-teal);
  border-radius: var(--radius-md);
  background: var(--color-command-teal-bg);
}

.queue__instruction,
.queue__error {
  margin: 0;
  font-size: var(--text-xs);
}

.queue__instruction {
  flex: 1 0 100%;
  color: var(--color-command-teal);
}

.queue__error {
  padding: var(--space-2) 0;
  color: var(--color-command-danger);
}

.queue__stack {
  border-top: 1px solid var(--color-rule);
}

.queue__stack-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-height-sm);
  padding: var(--space-1) 0;
  border: none;
  background: transparent;
  color: var(--color-ink);
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.queue__stack-name {
  flex: 1;
}

.queue__stack-count {
  color: var(--color-muted);
}

.queue__caret {
  color: var(--color-muted);
}

.queue__cards {
  margin: 0 0 var(--space-1);
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.queue__row {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.queue__card {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--control-height);
  padding: var(--space-1);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-ink);
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.queue__card:hover:not(:disabled) {
  border-color: var(--color-accent);
}

.queue__card:disabled {
  cursor: default;
}

.queue__card--on {
  border-color: var(--color-command-teal);
  background: var(--color-command-teal-bg);
  box-shadow: var(--shadow-sm);
}

.queue__card--blocked {
  color: var(--color-muted);
  cursor: not-allowed;
}

.queue__side {
  flex: none;
  color: var(--color-muted);
}

/* 第六批条 1（S1）：算子图（队列里的卡片按图认子，不再只靠行号） */
.queue__counter {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
}

.queue__counter-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.queue__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue__badge {
  flex: none;
  color: var(--color-muted);
}

.queue__check {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-muted);
}

.queue__check input {
  accent-color: var(--color-command-teal);
}

.queue__blocked {
  padding-inline: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-warning);
}

.queue__empty {
  margin: 0 0 var(--space-1);
  color: var(--color-muted);
  font-size: var(--text-xs);
}

.queue__hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-muted);
}

.queue__chunk {
  min-width: 1.75rem;
  padding: 0.1rem 0.35rem;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-ink);
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.queue__chunk--on {
  border-color: var(--color-accent);
  background: var(--color-command-teal-bg);
  color: var(--color-command-teal);
  font-weight: 600;
}
</style>
