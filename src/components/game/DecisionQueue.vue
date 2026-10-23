<script setup lang="ts">
import { computed, ref } from 'vue'

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

/** 这一方还有几项没定（分方游标那一栏用；全量口径，不受当前过滤影响） */
function pendingOf(side: 'axis' | 'soviet'): number {
  return setup.sidePendingCount(side)
}

/** 还没落位的**总枚数**（标题上的角标） */
const pendingTotal = computed(() => stacks.value.reduce((total, stack) => total + stack.count, 0))

/** 当前正在地图上选落点的那一项（null = 没在放） */
const placing = computed(() => setup.placing)

/** 是否**全部落位完毕**（落满 ⇒ 队列收起列表、就地给「完成初设」） */
const allPlaced = computed(() => pendingTotal.value === 0)

function toggleStack(key: DecisionStack['key']): void {
  openKey.value = openKey.value === key ? null : key
}

/* ── B38：拖动（与唯一会话框同一套几何；松手夹回容器内，至少留 8px 可见，拖不丢） ── */

const rootRef = ref<HTMLElement | null>(null)
const offset = ref<{ dx: number; dy: number }>({ dx: 0, dy: 0 })
const drag = ref<{ startX: number; startY: number; dx: number; dy: number } | null>(null)

function onPointerDown(event: PointerEvent): void {
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
    current.side === item.side
  )
}

/** 点卡片：开始在地图上落位（飞机走空军基地格；卡车直接在卡上选满载） */
function pick(item: SetupPlacing): void {
  if (item.kind === 'truck') return
  if (item.blockedReason !== null) {
    // 不能落位的原因已在卡上写着，点了只把它顶到眼前（不弹窗、不换页）
    setup.cancelPlacement()
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
    aria-label="待你决定的队列"
  >
    <!-- B38：标题栏可拖（松手夹回地图窗口内；口径 #5「初设框不能拖」） -->
    <header
      class="queue__head"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <span class="queue__title">待你决定</span>
      <BaseTag v-if="cursorSide !== null" kind="info">
        {{ sideName(cursorSide) }}布设（先布设方 {{ sideName(setup.setupFirstSide ?? 'axis') }}）
      </BaseTag>
      <BaseTag :kind="pendingTotal > 0 ? 'warning' : 'success'">{{ pendingTotal }} 枚未定</BaseTag>
    </header>

    <!--
      第六批条 1（S1）：**分方游标** —— 先布设方（剧本页 `setupFirst`，与"先行动方"是两回事）
      布设完按一下即换手；两方都确认 ⇒ 游标归位、队列恢复全量（未落位者仍按既有口径处理）。
    -->
    <div v-if="cursorSide !== null" class="queue__side-cursor">
      <p class="queue__hint">
        <BaseTag kind="neutral">分方</BaseTag>
        本方待定 {{ pendingOf(cursorSide) }} 项
        <BaseButton variant="primary" size="sm" @click="setup.confirmSideSetup()">
          {{ sideName(cursorSide) }}布设完毕
        </BaseButton>
      </p>
    </div>

    <!--
      B38（口径 #5「结束后不自动关」）：**全部落位完毕** ⇒ 队列收起列表、就地给「完成初设」，
      按下即开局（`startGameNow`）；初设收束后本框随 `!setup.finished` 的条件自动消失。
    -->
    <div v-if="allPlaced" class="queue__done">
      <p class="queue__hint">
        <BaseTag kind="success">已全部落位</BaseTag>
        点「完成初设」进入第一阶段（未落位者视为本局移除）。
      </p>
      <BaseButton variant="primary" size="sm" @click="setup.startGameNow()">完成初设</BaseButton>
    </div>

    <div v-for="stack in stacks" v-show="!allPlaced" :key="stack.key" class="queue__stack">
      <button type="button" class="queue__stack-btn" @click="toggleStack(stack.key)">
        <span class="queue__stack-name">{{ stack.label }}</span>
        <span class="queue__stack-count num">{{ stack.count }}</span>
        <span class="queue__caret">{{ openKey === stack.key ? '▾' : '▸' }}</span>
      </button>

      <ul v-if="openKey === stack.key && stack.items.length > 0" class="queue__cards">
        <li
          v-for="item in stack.items"
          :key="`${item.kind}:${item.side}:${item.entryIndex}:${item.instanceId ?? ''}`"
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
              item.blockedReason ?? `${item.raw}（${item.side === 'axis' ? '轴心国' : '苏联'}）`
            "
            @click="pick(item)"
          >
            <!--
              第六批条 1（S1）：**算子图阵列** —— 有图档就画算子（与地图同一份图档来源），
              没有才退回文字（数据里缺图的项目如实退回，不画占位方块冒充算子）。
            -->
            <span v-if="item.imageUrl !== null" class="queue__counter">
              <img :src="item.imageUrl" :alt="item.label" class="queue__counter-img" />
            </span>
            <span class="queue__side num">{{ sideMark(item.side) }}</span>
            <span class="queue__label">{{ item.label }}</span>
            <span v-if="item.kind !== 'truck'" class="queue__badge num">
              {{ item.placed }}/{{ item.total }}
            </span>
          </button>

          <!--
            第六批条 2（S2）：卡车**不在卡片上勾** —— 同名同图的几十辆卡车在列表里认不出来，
            玩家要问的是"图上这一辆装不装" ⇒ 改由**地图高亮 + 点卡车即装载**（13.2h）。
            卡片上只回显它当前是否满载（`placed`），判定与落账都在 store。
          -->
          <span v-if="item.kind === 'truck'" class="queue__truck">
            <BaseTag :kind="item.placed > 0 ? 'success' : 'neutral'">
              {{ item.placed > 0 ? '已满载 1 SP' : '空载' }}
            </BaseTag>
          </span>

          <span v-if="item.blockedReason !== null" class="queue__blocked">
            {{ item.blockedReason }}
          </span>
        </li>
      </ul>
      <p v-else-if="openKey === stack.key" class="queue__empty">这一堆没有待决定的项。</p>
    </div>

    <!-- 正在落位的一行：说清"点地图上的哪儿"，并给一个退出（不改已落盘的） -->
    <p v-if="placing !== null" class="queue__hint">
      <BaseTag kind="info">{{ placing.label }}</BaseTag>
      <!-- 第六批条 26（S4）：SP / 运输点可分多格 —— 先选"这一下放多少"，再点地图高亮格 -->
      <template v-if="placing.category === 'supply'">
        本次落
        <button
          v-for="c in setup.placingChunkChoices"
          :key="c"
          type="button"
          class="queue__chunk"
          :class="{ 'queue__chunk--on': placing.chunk === c }"
          @click="setup.setPlacingChunk(c)"
        >
          {{ c }}
        </button>
        （剩 {{ placing.remaining }}）
      </template>
      <template v-else>还剩 {{ placing.remaining }} 枚：点地图高亮格落位</template>
      <BaseButton variant="ghost" size="sm" @click="setup.cancelPlacement()">收起</BaseButton>
    </p>

    <!--
      卡车装载（13.2h：满载辆数须与剧本页一致）
      ★ 批 B 切片 1：**只在"玩家自选"时给这个入口** —— 剧本页明示全满载/全空载时初设已自动落账
        （`setup.truckLoadSummary.automatic`），这类剧本的卡车堆叠本身也是空的（`decisionQueue` 的 filter）。
      ★ 第六批条 2（S2）：**去掉"核验"按钮** —— 改为"地图高亮可装载卡车，点一辆即装载"；
        选够剧本页要求的辆数时 store 自动落账（`pickTruckAtHex` → `designateTrucks`）。
    -->
    <p v-if="setup.truckLoadSummary.mode === 'choose_loaded'" class="queue__hint">
      <BaseTag kind="neutral">13.2h</BaseTag>
      本剧本须满载 {{ setup.requiredFullTrucks }} 辆（已选
      {{ setup.truckLoadSummary.fullCount }} 辆）
      <BaseButton
        variant="secondary"
        size="sm"
        @click="setup.truckPickActive ? setup.cancelTruckPick() : setup.beginTruckPick()"
      >
        {{ setup.truckPickActive ? '收起高亮' : '点图指定满载' }}
      </BaseButton>
    </p>

    <p v-if="setup.lastAction !== null" class="queue__hint num">
      <BaseTag :kind="setup.lastAction.ok ? 'neutral' : 'danger'">
        {{ setup.lastAction.rule }}
      </BaseTag>
      {{ setup.lastAction.detail }}
    </p>
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
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-bottom: var(--space-1);
}

.queue {
  /* 地图窗口左上角（用户口径⑨）；宽度收窄以免盖住盘面 */
  position: absolute;
  left: var(--space-3);
  top: var(--space-3);
  z-index: var(--layer-map-popup);
  width: min(240px, 42%);
  max-height: 62vh;
  overflow: auto;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md);
  background: rgb(255 255 255 / 0.94);
  box-shadow: var(--shadow-sm);
  font-size: var(--text-sm);
}

.queue__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}

.queue__title {
  font-family: var(--font-head);
  font-weight: 700;
  letter-spacing: 0.02em;
}

.queue__stack {
  border-top: 1px solid var(--color-rule);
}

.queue__stack-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 2px 0;
  border: none;
  background: transparent;
  color: var(--color-ink);
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
  padding: 2px var(--space-1);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-ink);
  cursor: pointer;
  text-align: left;
}

.queue__card:hover {
  border-color: var(--color-accent);
}

.queue__card--on {
  border-color: var(--color-accent);
  background: var(--color-panel);
  box-shadow: var(--shadow-sm);
}

.queue__card--blocked {
  opacity: 0.6;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue__badge {
  flex: none;
  color: var(--color-muted);
}

.queue__truck {
  padding-left: calc(var(--space-1) + 1.2em);
}

.queue__check {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-muted);
}

.queue__blocked {
  padding-left: calc(var(--space-1) + 1.2em);
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
  margin: var(--space-1) 0 0;
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
  background: var(--color-bg-2);
  color: var(--color-accent);
  font-weight: 600;
}
</style>
