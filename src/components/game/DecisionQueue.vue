<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { BaseButton, BaseIcon } from '@/components/base'
import { clampDockOffset } from '@/components/map/dock-position'
import {
  useHotseatStore,
  useSetupStore,
  type DecisionStack,
  type PresetSetupResult,
  type SetupPlacing,
} from '@/stores'

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
const hotseat = useHotseatStore()
/**
 * 一键预设初设（B2）：与初设主入口同一处，只落 AI 控制的一方，不替玩家点开始游戏。
 * 修前这个入口挂在「战况」抽屉的初设面板里（与开局选剧本重复），玩家在初设栏找不到。
 */
const presetResult = ref<PresetSetupResult | null>(null)

function runPresetSetup(): void {
  presetResult.value =
    hotseat.presetSide === null
      ? setup.presetSelfSetupNow()
      : setup.presetSelfSetupNow({ onlySide: hotseat.presetSide })
}

/** 展开的堆叠（默认全开：整批一眼看完，不必逐堆点开） */
const closedKeys = ref<Set<DecisionStack['key']>>(new Set())

/** 四堆（含枚数与卡片） */
const stacks = computed(() => setup.sideQueue)

/** 只摆有内容的堆：空格不占版面（整批一眼看完） */
const visibleStacks = computed(() => stacks.value.filter((stack) => stack.items.length > 0))

/**
 * 分区排布：有飞机且有地面/非战斗时，**左右两栏**（左＝地面/非战斗，右＝飞机），
 * 让整批在 960×571 的地图窗口内不用上下滚动；只有一类时单列铺满。
 */
const sectionsLayout = computed(() =>
  visibleStacks.value.some((stack) => stack.key === 'air') &&
  visibleStacks.value.some((stack) => stack.key === 'ground' || stack.key === 'supply')
    ? 'split'
    : 'stack',
)

/** 当前轮到哪一方布设（null = 不分方 / 两方都已确认） */
const cursorSide = computed(() => setup.setupSideCursor)

/*
 * 2026-11-18（用户第 5 条）：初设窗按游标只归**当前布设方**。
 *
 * · PVE：游标在 AI 那一侧 ⇒ 玩家只看到「等待」，不出现 AI 的布置卡与按钮；
 * · PVP 同屏轮流：游标不在视角方 ⇒ 同样只显示等待，切到本方视角才给操作；
 * · solo：一人操作双方 ⇒ 始终全给。
 */
const cursorWindowForViewer = computed(() => {
  if (cursorSide.value === null) return true
  if (hotseat.fogDisabled) return true
  const mine = hotseat.mode === 'pve' ? hotseat.playerSide : hotseat.viewerSide
  return cursorSide.value === mine
})
const waitingSideName = computed(() => (cursorSide.value === 'axis' ? '轴心国' : '苏联'))
/** 轴心专属义务（ch10 西移 / 3.4b SP 归属 / 13.2h 卡车满载）只在轴心窗口露出 */
const axisWindow = computed(() => cursorSide.value === null || cursorSide.value === 'axis')
/** 已完成项也按游标切方，避免苏联窗口里混着轴心的布置清单 */
const viewerCompleted = computed(() =>
  cursorSide.value === null
    ? setup.completedPlacements
    : setup.completedPlacements.filter((item) => item.side === cursorSide.value),
)

function sideName(side: 'axis' | 'soviet'): string {
  return side === 'axis' ? '轴心国' : '苏联'
}

/**
 * 批 G（用户 2026-11-16；2026-11-19 改版）：飞机按**激活态分两栏**
 *
 * 栏头写状态与剩余枚数，栏内是**逐枚算子**（同一状态里跨机型平铺，图上就能认出机型）。
 * 计数与逐枚面同源（`planAirSetup` 的 `statuses` / `reduced`），界面不另算规则。
 * 没有对应状态就不显示那一栏（不留空栏占位）。
 */
interface AirChip {
  key: string
  item: SetupPlacing
  status: 'active' | 'inactive'
  reduced: boolean
  imageUrl: string | null
}

interface AirStatusSection {
  status: 'active' | 'inactive'
  label: string
  count: number
  chips: readonly AirChip[]
}

const airStatusSections = computed<readonly AirStatusSection[]>(() => {
  const items = stacks.value.find((stack) => stack.key === 'air')?.items ?? []
  return (
    [
      { status: 'active' as const, label: '激活' },
      { status: 'inactive' as const, label: '未激活' },
    ] as const
  )
    .map((group) => {
      const chips = items
        .filter((item) => item.kind === 'air' && !cardBlocked(item))
        .flatMap((item) =>
          airChipFaces(item, group.status).map((face, index) => ({
            key: `${item.side}:${item.entryIndex}:${group.status}:${index}`,
            item,
            status: group.status,
            ...face,
          })),
        )
      return { ...group, chips, count: chips.length }
    })
    .filter((group) => group.count > 0)
})

/** 可放入地图外盒的飞机机型（一次一只，入口收成一行下拉，不占网格高度） */
const airBoxItems = computed(() =>
  (stacks.value.find((stack) => stack.key === 'air')?.items ?? []).filter(
    (item) => item.kind === 'air' && setup.canPlaceAirInOffMapBox(item.side, item.entryIndex),
  ),
)

/** 下拉选一型 ⇒ 放入地图外盒（1.4a；与既有的逐型入口同一 store 调用） */
function placeAirInBox(event: Event): void {
  const select = event.target as HTMLSelectElement
  const value = select.value
  select.value = ''
  if (value === '') return
  const [side, entryIndex] = value.split(':')
  setup.placeAirInOffMapBoxNow(side === 'soviet' ? 'soviet' : 'axis', Number(entryIndex))
}

/** 点某一栏的算子 ⇒ 落该状态的那一枚（store 负责把下一枚换成它） */
function pickAir(item: SetupPlacing, status: 'active' | 'inactive'): void {
  if (cardBlocked(item)) return
  setup.beginAirPlacement(item.side, item.entryIndex, status)
}

/**
 * 该型某一状态**尚未落位**的逐枚面（减损面 / 正面）
 *
 * 与 `airStatusSections` 的计数同源（同一份 `planAirSetup` 的 `statuses` / `reduced`），
 * 只作为图档与角标的投影；不参与任何规则判定。
 */
function airChipFaces(
  item: SetupPlacing,
  status: 'active' | 'inactive',
): readonly { reduced: boolean; imageUrl: string | null }[] {
  if (item.kind !== 'air') return []
  const row = setup
    .airPlanOf(item.side)
    ?.placements.find((candidate) => candidate.entryIndex === item.entryIndex)
  const faces: { reduced: boolean; imageUrl: string | null }[] = []
  for (let index = item.placed; index < item.total; index++) {
    if ((row?.statuses[index] ?? 'inactive') !== status) continue
    const reduced = row?.reduced[index] === true
    faces.push({
      reduced,
      imageUrl: reduced ? (item.imageUrlBack ?? item.imageUrl) : item.imageUrl,
    })
  }
  return faces
}

/** 还没落位的**总枚数**（标题上的角标） */
const pendingTotal = computed(() => stacks.value.reduce((total, stack) => total + stack.count, 0))

/** 当前正在地图上选落点的那一项（null = 没在放） */
const placing = computed(() => setup.placing)
const omitConfirmed = ref(false)
watch([() => setup.scenarioId, () => setup.omittablePlacements], () => {
  omitConfirmed.value = false
  presetResult.value = null
})

/** 是否**全部落位完毕**（落满 ⇒ 队列收起列表、就地给「完成初设」） */
const allPlaced = computed(() => setup.initialPlacementsComplete)

/**
 * M3（用户 2026-11-16；2026-11-18 更正）：初设收束的**唯一主入口**
 *
 * 剧本页的编队抽取是纯机械动作 ⇒ 「完成初设」这一下就自动抽签+处置+开局，
 * 不再单独给抽取按钮。剩下两枚（开始游戏 / 完成初设）本就互斥，
 * 这里按同一组既有投影压成一枚，模板只留一个 `BaseButton` —— 不新造判定。
 */
const setupPrimary = computed<{ label: string; run: () => void } | null>(() => {
  if (setup.setupStartEntryVisible) {
    return { label: '开始游戏', run: () => setup.startGameNow() }
  }
  if (allPlaced.value && cursorSide.value === null && !setup.setupConfirmed) {
    return { label: '完成初设', run: () => setup.startGameNow() }
  }
  return null
})

function toggleStack(key: DecisionStack['key']): void {
  const next = new Set(closedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  closedKeys.value = next
}

/** 该堆是否展开（默认展开） */
function isOpen(key: DecisionStack['key']): boolean {
  return !closedKeys.value.has(key)
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

/** 不可落位的卡片是「待办状态」，不是可点动作：渲染成 div，不摆 disabled 按钮 */
function cardBlocked(item: SetupPlacing): boolean {
  return item.kind === 'truck' || (item.blockedReason !== null && item.offMapAllowed !== true)
}

function onCardClick(item: SetupPlacing): void {
  if (!cardBlocked(item)) pick(item)
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
  if (item.kind === 'truck') return
  // 卡被挡时不再借右键旁路兜底：落盒由卡下的「放入地图外盒」按钮单独承担
  // ★ 裁定 1：ch10 西移项的候选只是"按初设行算出的范围"；算不出来时玩家仍可点任意图上格
  //   （`placeAtHex` 对 shift 只校验在图上）⇒ 不能因为 blockedReason 把整项锁死。
  if (item.blockedReason !== null && item.kind !== 'shift') return
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
      M3（用户 2026-11-16；2026-11-18 更正）：初设收束**单入口** —— 开始游戏 / 完成初设
      由 `setupPrimary` 按状态合成一枚按钮；抽签已在「完成初设」时自动执行，不再单独给按钮。
      B2：一键预设初设与主入口同一处（只落 AI 控制的一方）。
      H5：落位可一步撤回。四类动作收进**同一行**，避免初设框被按钮堆高。
    -->
    <div class="queue__actions">
      <BaseButton
        v-if="setupPrimary !== null"
        variant="primary"
        size="sm"
        @click="setupPrimary.run()"
      >
        {{ setupPrimary.label }}
      </BaseButton>
      <BaseButton
        v-if="hotseat.canPreset && !setup.finished"
        variant="secondary"
        size="sm"
        @click="runPresetSetup()"
      >
        一键预设初设
      </BaseButton>
      <span v-if="presetResult !== null" class="queue__hint num">
        已落 {{ presetResult.placed }} · 剩 {{ presetResult.remaining }} · 失败
        {{ presetResult.failures.length }}
      </span>
      <template v-if="cursorWindowForViewer">
        <!--
          第六批条 1（S1）：分方游标 —— 先布设方布设完按一下即换手；
          本方还有必做项（SP 归属 / 卡车满载 / 编队西移）未落实时不出现。
        -->
        <BaseButton
          v-if="cursorSide !== null && setup.currentSideSetupBlocker === null"
          variant="primary"
          size="sm"
          @click="setup.confirmSideSetup()"
        >
          确认本方布设
        </BaseButton>
        <BaseButton
          v-if="setup.canUndoPlacement"
          variant="ghost"
          size="sm"
          :title="setup.lastPlacement?.label ?? ''"
          @click="setup.undoLastPlacementNow()"
        >
          撤回上一步
        </BaseButton>
      </template>
    </div>

    <p v-if="!cursorWindowForViewer" class="queue__wait" role="status">
      {{ waitingSideName }}正在初设，等当前方完成后自动轮到你。
    </p>
    <template v-else>
      <!-- M3：原来的「完成初设」已并入上面的唯一主入口（条件同 `allPlaced && 无游标 && 未确认`） -->
      <!-- H5：撤回入口已并入上面的同一行 -->

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
      </div>

      <!--
      3.4b：摆一个确认一个 —— 刚落下的德军 SP / 地图上点中的未归属 SP，二选一常驻在初设栏。
      修前这份二选一只在「初设与开局」面板（对局台不挂载）⇒ 勾了 3.4b 的初设会卡在
      「必做事项：SP 归属」且没有任何可点入口。此处与面板同源（`pendingSpChoice`）。
    -->
      <div
        v-if="axisWindow && setup.spOwnershipEntryVisible && setup.pendingSpChoice !== null"
        class="queue__row-actions"
      >
        <span class="queue__hint num">
          {{ setup.pendingSpChoice.hexText }}（{{ setup.pendingSpChoice.points }} SP）
        </span>
        <BaseButton variant="primary" size="sm" @click="setup.choosePendingSpGroup('guderian')">
          Guderian
        </BaseButton>
        <BaseButton variant="primary" size="sm" @click="setup.choosePendingSpGroup('hoth')">
          Hoth
        </BaseButton>
      </div>

      <!--
      ★ 用户 2026-11-10：满载名单已达剧本要求 ⇒ 整行**隐藏**（不灰显）；
      `beginTruckPick()` 用同一判据拒绝，界面不会出现「点了没反应」的按钮。
    -->
      <div
        v-if="axisWindow && setup.truckLoadSummary.mode === 'choose_loaded' && !setup.truckFullDone"
        class="queue__row-actions"
      >
        <span class="queue__hint num">
          满载 {{ setup.truckLoadSummary.fullCount }}/{{ setup.requiredFullTrucks }}
        </span>
        <BaseButton
          variant="secondary"
          size="sm"
          @click="setup.truckPickActive ? setup.cancelTruckPick() : setup.beginTruckPick()"
        >
          {{ setup.truckPickActive ? '收起高亮' : '点图指定满载' }}
        </BaseButton>
      </div>

      <!--
      ★ 用户 2026-11-10：同格多辆编内卡车 ⇒ 先按实例 id 列候选，点哪一辆装哪一辆
      （同型卡车同名同图，只靠格号分不出是哪一辆）。
    -->
      <div v-if="axisWindow && setup.truckPickPending !== null" class="queue__row-actions">
        <span class="queue__hint num">{{ setup.truckPickPending.rows.length }} 辆</span>
        <BaseButton
          v-for="row in setup.truckPickPending.rows"
          :key="row.instanceId"
          variant="secondary"
          size="sm"
          @click="setup.pickTruckInstance(row.instanceId)"
        >
          {{ row.name }}（{{ row.full ? '已满载' : '空载' }}）
        </BaseButton>
        <BaseButton variant="ghost" size="sm" @click="setup.cancelTruckPick()">取消</BaseButton>
      </div>

      <p
        v-if="setup.lastAction !== null && !setup.lastAction.ok"
        class="queue__error"
        role="status"
        :title="`§${setup.lastAction.rule}`"
      >
        {{ setup.lastAction.detail }}
      </p>

      <!--
      P4 / UI1-b：三组只读分组（必做事项 / 可自主放弃项 / 已完成项）。
      计数与条目全部来自 store 投影；四堆叠仍是下面可点图落位的操作区。
    -->
      <details v-if="setup.sideSetupIssues.length > 0" class="queue__group">
        <summary class="queue__group-title">
          <span>必做事项</span>
          <span class="queue__group-count num">{{ setup.sideSetupIssues.length }}</span>
        </summary>
        <p
          v-for="issue in setup.sideSetupIssues"
          :key="issue.id"
          class="queue__hint queue__issue"
          :title="issue.rule"
        >
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
            v-if="omitConfirmed && !setup.omitDiscardBlocked"
            variant="primary"
            size="sm"
            @click="setup.startGameNow()"
          >
            确认放弃并开局
          </BaseButton>
        </div>
      </details>

      <details v-if="viewerCompleted.length > 0" class="queue__group">
        <summary class="queue__group-title">
          <span>已完成项</span>
          <span class="queue__group-count num">{{ viewerCompleted.length }}</span>
        </summary>
        <ul class="queue__placed">
          <li
            v-for="placement in viewerCompleted"
            :key="placement.key"
            class="queue__placed-row"
            :title="placement.label"
          >
            <span v-if="placement.imageUrl !== null" class="queue__counter">
              <img :src="placement.imageUrl" :alt="placement.label" class="queue__counter-img" />
            </span>
            <span class="queue__side num">{{ sideMark(placement.side) }}</span>
            <!-- 用户 2026-11-11：有算子图就不再用文字重复名称（图上已印） -->
            <span v-if="placement.imageUrl === null" class="queue__label">{{
              placement.label
            }}</span>
            <span class="queue__badge num">{{ placement.placed }}/{{ placement.total }}</span>
          </li>
        </ul>
      </details>

      <div class="queue__sections" :class="`queue__sections--${sectionsLayout}`">
        <div
          v-for="stack in visibleStacks"
          v-show="!allPlaced"
          :key="stack.key"
          class="queue__stack"
          :class="{ 'queue__stack--wide': stack.key === 'air' }"
          :data-stack="stack.key"
        >
          <button
            type="button"
            class="queue__stack-btn"
            :aria-expanded="isOpen(stack.key)"
            @click="toggleStack(stack.key)"
          >
            <span class="queue__stack-name">{{ stack.label }}</span>
            <span class="queue__stack-count num">{{ stack.count }}</span>
            <span class="queue__caret">
              <BaseIcon :name="isOpen(stack.key) ? 'chevron-down' : 'chevron-right'" />
            </span>
          </button>

          <template v-if="isOpen(stack.key)">
            <!--
              飞机：**独立一块分区**，与地面 / 非战斗分开排列。
              按激活态分两栏（栏头写状态与枚数），栏内逐枚平铺；减损那枚用背面图档并标「减」。
              可入图外盒的机型收成一行下拉，不占网格高度。
            -->
            <div v-if="stack.key === 'air'" class="queue__air">
              <div v-if="airBoxItems.length > 0" class="queue__air-boxes">
                <select class="queue__air-box" title="放入地图外盒（1.4a）" @change="placeAirInBox">
                  <option value="">放入图外盒…</option>
                  <option
                    v-for="item in airBoxItems"
                    :key="`${item.side}:${item.entryIndex}`"
                    :value="`${item.side}:${item.entryIndex}`"
                  >
                    {{ item.label }}（{{ item.placed }}/{{ item.total }}）
                  </option>
                </select>
              </div>
              <div v-for="group in airStatusSections" :key="group.status" class="queue__air-col">
                <div class="queue__air-col-head">
                  <span>{{ group.label }}</span>
                  <span class="num">{{ group.count }}</span>
                </div>
                <div class="queue__air-array">
                  <button
                    v-for="chip in group.chips"
                    :key="chip.key"
                    type="button"
                    class="queue__air-chip"
                    :class="{ 'queue__air-chip--on': isActive(chip.item) }"
                    :title="`${group.label} · ${chip.item.label}`"
                    @click="pickAir(chip.item, group.status)"
                  >
                    <img
                      v-if="chip.imageUrl !== null"
                      :src="chip.imageUrl"
                      alt=""
                      draggable="false"
                    />
                    <span v-if="chip.reduced" class="queue__air-flag num">减</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- 地面 / 非战斗 / 卡车：算子网格（左右上下排列，不再一单位一行） -->
            <div v-else class="queue__grid">
              <component
                :is="cardBlocked(item) ? 'div' : 'button'"
                v-for="item in stack.items"
                :key="`${item.kind}:${item.side}:${item.entryIndex}:${item.formationId ?? item.instanceId ?? ''}`"
                :type="cardBlocked(item) ? undefined : 'button'"
                class="queue__cell"
                :class="{
                  'queue__cell--on': isActive(item),
                  'queue__cell--blocked': item.blockedReason !== null,
                }"
                :title="
                  item.offMapAllowed === true
                    ? '点卡后点基地放入；也可用下方按钮放入图外盒'
                    : (item.blockedReason ?? `${item.raw}（${sideName(item.side)}）`)
                "
                :aria-pressed="cardBlocked(item) ? undefined : isActive(item)"
                :aria-disabled="cardBlocked(item) ? 'true' : undefined"
                @click="onCardClick(item)"
              >
                <span class="queue__counter">
                  <img
                    v-if="item.imageUrl !== null"
                    :src="item.imageUrl"
                    :alt="item.label"
                    class="queue__counter-img"
                    draggable="false"
                  />
                  <!-- 用户 2026-11-11：有算子图就不再用文字重复名称；无图才退回文字 -->
                  <span v-if="item.imageUrl === null" class="queue__label">{{ item.label }}</span>
                  <span class="queue__side num">{{ sideMark(item.side) }}</span>
                  <span class="queue__badge num">
                    {{
                      item.kind === 'truck'
                        ? item.placed > 0
                          ? '满载'
                          : '空载'
                        : `${item.placed}/${item.total}`
                    }}
                  </span>
                </span>
                <!-- 批 H（用户 2026-11-16）：地面单位卡补**番号**（编队 / 师属标识），不加描述 -->
                <span v-if="item.formation" class="queue__formation num">{{ item.formation }}</span>
              </component>
            </div>
          </template>
        </div>
      </div>
    </template>
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
  /* 算子尺寸（box 网格）：地面/补给 38px、飞机 34px；比旧的 26px 行明显大一档 */
  --queue-counter: 38px;
  --queue-air-counter: 34px;
  --queue-cell: 46px;
  position: absolute;
  left: var(--space-3);
  top: var(--space-3);
  z-index: var(--layer-map-popup);
  width: min(680px, calc(100% - 2 * var(--space-3)));
  max-height: calc(100% - 2 * var(--space-3));
  overflow: auto;
  overscroll-behavior: contain;
  padding: var(--space-1) var(--space-3);
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

/* 初设动作收成一行（主入口 / 预设 / 确认布设 / 撤回），把高度让给算子网格 */
.queue__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: 2px 0;
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

.queue__error {
  margin: 0;
  font-size: var(--text-xs);
  padding: var(--space-2) 0;
  color: var(--color-command-danger);
}

/* 分区网格：默认单列；有飞机 + 地面/非战斗时左右两栏（飞机独占右栏） */
.queue__sections {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 2px var(--space-2);
  align-items: start;
}

.queue__sections--split {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.queue__sections--split [data-stack='ground'] {
  grid-column: 1;
  grid-row: 1 / span 2;
}

.queue__sections--split [data-stack='supply'] {
  grid-column: 2;
  grid-row: 2;
}

.queue__sections--split [data-stack='air'] {
  grid-column: 2;
  grid-row: 1;
}

.queue__sections--split [data-stack='truck'] {
  grid-column: 1 / -1;
}

.queue__stack {
  border-top: 1px solid var(--color-rule);
  min-width: 0;
}

.queue__stack--wide {
  grid-column: 1 / -1;
}

.queue__stack-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 24px;
  padding: 2px 0;
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

/* 「可自主放弃项」的只读清单（不是待落位网格） */
.queue__cards {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.queue__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 待落位算子：box 网格（左右上下排列） */
.queue__grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-content: flex-start;
  padding-bottom: var(--space-1);
}

.queue__cell {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: var(--queue-cell);
  min-height: var(--queue-cell);
  padding: 2px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-ink);
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.queue__cell:hover:not(:disabled) {
  border-color: var(--color-accent);
}

.queue__cell:disabled {
  cursor: default;
}

.queue__cell--on {
  border-color: var(--color-command-teal);
  background: var(--color-command-teal-bg);
  box-shadow: var(--shadow-sm);
}

.queue__cell--blocked {
  color: var(--color-muted);
  cursor: not-allowed;
}

.queue__side {
  flex: none;
  color: var(--color-muted);
}

/* 第六批条 1（S1）：算子图（队列里的卡片按图认子，不再只靠行号） */
.queue__counter {
  position: relative;
  display: block;
  width: 100%;
  height: var(--queue-counter);
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
}

.queue__counter-img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
}

/* 无图回退：只写短名，占满算子框 */
.queue__counter .queue__label {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 1px;
  overflow: hidden;
  font-size: 10px;
  line-height: 1.1;
  text-align: center;
  text-overflow: ellipsis;
  white-space: normal;
}

/* 压在图角上的小标记（阵营 / 枚数）：不占行高，不遮印值中部 */
.queue__counter .queue__side {
  position: absolute;
  left: 1px;
  top: 0;
  padding: 0 2px;
  border-radius: var(--radius-sm);
  background: rgb(32 30 26 / 0.72);
  color: var(--color-bg);
  font-size: 10px;
  line-height: 12px;
}

.queue__counter .queue__badge {
  position: absolute;
  right: 1px;
  bottom: 1px;
  padding: 0 2px;
  border-radius: var(--radius-sm);
  background: rgb(32 30 26 / 0.72);
  color: var(--color-bg);
  font-size: 10px;
  line-height: 12px;
}

/* 批 H：地面单位的番号（编队 / 师属标识），排在算子下方一行 */
.queue__formation {
  display: block;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-size: 10px;
  line-height: 10px;
  color: var(--color-muted);
}

/* 批 G：飞机按激活态分两栏（栏头状态 + 剩余枚数；栏内逐枚平铺） */
.queue__air {
  display: grid;
  gap: 4px;
  padding-bottom: var(--space-1);
}

.queue__air-boxes {
  display: flex;
}

/* 入图外盒入口：一行下拉，避免逐型按钮把飞机分区堆高 */
.queue__air-box {
  max-width: 100%;
  height: 22px;
  font-size: var(--text-xs);
}

.queue__air-col {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.queue__air-col-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: 10px;
  font-weight: 700;
  color: var(--color-muted);
}

.queue__air-array {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.queue__air-chip {
  position: relative;
  width: var(--queue-air-counter);
  height: var(--queue-air-counter);
  padding: 0;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  cursor: pointer;
}

.queue__air-chip--on {
  border-color: var(--color-command-teal);
  background: var(--color-command-teal-bg);
  box-shadow: var(--shadow-sm);
}

.queue__air-chip:hover:not(:disabled) {
  border-color: var(--color-accent);
}

.queue__air-chip:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.queue__air-chip img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}

/* 减损面标记（`*` = one unit begins reduced）：贴角，不遮印值 */
.queue__air-flag {
  position: absolute;
  right: 0;
  bottom: 0;
  padding: 0 2px;
  border-radius: var(--radius-sm);
  background: rgb(32 30 26 / 0.72);
  color: var(--color-bg);
  font-size: 10px;
  line-height: 12px;
  pointer-events: none;
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

/* 2026-11-18：轮到对手（PVE 的 AI / PVP 的对方）布设时只留这一行 */
.queue__wait {
  margin: var(--space-2) 0;
  font-size: var(--text-sm);
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
