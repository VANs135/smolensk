<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { useRefereeTools } from '@/components/ui-mode'
import { BaseButton, BasePanel, BaseTag } from '@/components/base'
import AircraftRoster from '@/components/air/AircraftRoster.vue'
import UiField from '@/components/UiField.vue'
import { useUiMode } from '@/components/ui-mode'
import { formations } from '@/data'
import type { Side } from '@/data'
import type { BoxView, EdgeBoxId, ScenarioDrawBoxView } from '@/engine/rules'
import { rebuildChartRows } from '@/engine/rules'
import {
  useContainersStore,
  useHotseatStore,
  useSetupStore,
  useWorkbenchStore,
  counterImageUrlOf,
} from '@/stores'

/**
 * 记录轨与容器面板（W7 C12）
 *
 * 三件事：
 *   ① **记录轨**：回合轨（2.2 Turn End 推进标记）、天气标记（专规 1.5）、铁路容量轨（13.3b / 专规 1.2）；
 *   ② **盒的查看与操作**：死亡堆（13.5）、拆分单位盒（1.8a / 20.0g）、1.6c 特殊补员抽取盒、
 *      剧本抽取盒（ch10/ch11 编队抽签）、地图外空军盒（1.4a，Active/Inactive 两栏 + 免费整备）、
 *      边缘盒（1.4b）、编队收纳盒（13.7 / 3.6f，收纳下属作迷雾）；
 *   ③ **盒的美工接口**：`box.artwork` 有图即渲染，无图渲染纯文字盒（接口已留，数据后续可补）。
 *
 * 分层纪律：本组件不做规则计算 —— 名册与判定全部来自 `@/engine/rules/containers`（经 store 调用），
 * 这里只画表、收点击、把输入交给 store。
 */

const containers = useContainersStore()
/** ch10：抽签入口的可见条件与执行入口都在初设 store（唯一口径） */
const setup = useSetupStore()

/** 条 24 / §5-F：正式界面把「手输」收敛为只读（验证页仍可手输） */
const uiMode = useUiMode()
const workbench = useWorkbenchStore()
const hotseat = useHotseatStore()
const actingSide = computed(() => workbench.segmentGateQuery.side ?? workbench.activeSide)

/** 返场落点（死亡堆 → 图；13.5a / 1.6c 的落点规则见 2.1 / 3.1） */
/** 拆分单位取用：母单位与档位 */
const breakdownParentId = ref('')
const breakdownAr = ref(4)
/** 条 24：AR 档改用**点选**（0–5），正式界面无需手输；具体合法性仍由引擎在提交时判 */
const BREAKDOWN_AR_LEVELS = [0, 1, 2, 3, 4, 5]
/** 20.0a：拆分数量（"一个或多个"；上限由母单位军力与盒内存量共同决定） */
const breakdownCount = ref(1)
/** 20.0b / 第一步：AR 匹配 —— 只列 ≤ 母单位 AR 且盒内仍有存量的档 */
const breakdownParent = computed(
  () => workbench.units.find((unit) => unit.instanceId === breakdownParentId.value) ?? null,
)
const breakdownSlots = computed<readonly { ar: number; inBox: number }[]>(() => {
  const parent = breakdownParent.value
  if (parent === null) return []
  const box = boxes.value.find((item) => item.kind === 'breakdownBox' && item.side === parent.side)
  return (box as { slots?: readonly { ar: number; inBox: number }[] } | undefined)?.slots ?? []
})

/** 2.3a：混编上限只有**超编**时才上屏（用户 2026-11-10：余量充足是背景信息） */
const alarmMixOver = computed(() => containers.alarmMix.filter((row) => row.over))
const breakdownArChoices = computed<number[]>(() => {
  const parent = breakdownParent.value
  if (parent === null) return BREAKDOWN_AR_LEVELS
  const parentAr = parent.faces.combat.ar
  const usable = breakdownSlots.value
    .filter((slot) => slot.ar <= parentAr && slot.inBox > 0)
    .map((slot) => slot.ar)
  return usable.length > 0
    ? usable
    : breakdownSlots.value.filter((slot) => slot.ar <= parentAr).map((slot) => slot.ar)
})
/** 第二步：数量上限 = min(该档盒内存量, 母单位军力 − 1)（20.0：最后一点军力不能拆） */
const breakdownCountMax = computed<number>(() => {
  const parent = breakdownParent.value
  if (parent === null) return 1
  const inBox = breakdownSlots.value.find((slot) => slot.ar === breakdownAr.value)?.inBox ?? 1
  return Math.max(0, Math.min(inBox, parent.steps - 1))
})
const breakdownCountNow = computed<number>(() =>
  breakdownCountMax.value === 0
    ? 0
    : Math.min(Math.max(1, breakdownCount.value), breakdownCountMax.value),
)
/** 编队抽签落盘的组成事实（编队 id → Mtr/Aufk/Krd 单位 id） */
// ★ I②：组成由 store 自动推（containers.drawCompositionNoteOf），不再有玩家手输 unit id 的文本框
/** 边缘盒进出：从可用单位中选，并决定用 MP 或铁路容量。 */
const edgeUnitId = ref('')
const edgeUseRailCap = ref(false)
function edgeBoxOf(box: BoxView): EdgeBoxId {
  return box.id === 'edge-northeast' ? 'northeast' : 'southeast'
}
/** 编队收纳盒：编队、成员、图上成员、标记格、本次收纳 */
const formationId = ref('')
const formationMembersText = ref('')
const formationOnMapText = ref('')
const formationHideText = ref('')
/** 空军盒：要移入盒的飞机 */
const airUnitId = ref('')

/** 盒的总览（顺序即引擎给出：死亡堆 → 拆分盒 → 特殊补员盒 → 空军盒（双方）→ 边缘盒 → 剧本盒 → 编队盒） */
const boxes = computed<readonly BoxView[]>(() => {
  if (uiMode === 'verify') return containers.boxes
  const visible = containers.boxes.filter(
    (box) =>
      hotseat.fogDisabled ||
      !hotseat.policy.hideOffMapBoxes ||
      box.side === hotseat.viewerSide ||
      !['airBox', 'edgeBox', 'formationBox'].includes(box.kind),
  )
  if (props.subjectId != null) {
    return visible.filter(
      (box) => box.kind === 'formationBox' && formationIdOf(box) === formationId.value,
    )
  }
  const kinds = containers.openCardBoxKinds
  if (props.only !== 'actions' || kinds === null) return visible
  return visible.filter(
    (box) => kinds.includes(box.kind) && (box.side === null || box.side === actingSide.value),
  )
})

/** 剧本抽取盒（`BoxView` 是平铺接口，富字段用窄化取回；见引擎的 ScenarioDrawBoxView） */
const scenarioBox = computed<ScenarioDrawBoxView | null>(() => {
  const view = boxes.value.find((box) => box.kind === 'scenarioDrawBox')
  return (view as ScenarioDrawBoxView | undefined) ?? null
})

/** 当前抽取组（越界即第一组） */

/** 侧名 */
function sideName(side: Side | null): string {
  if (side === 'axis') return '轴心国'
  if (side === 'soviet') return '苏联'
  return '通用'
}

/* ── 盒的富字段读取（只在脚本里做窄化，模板不写类型断言） ── */

/** 空军盒：任务航程（格） */
function rangeHexesOf(box: BoxView): number | null {
  const view = box as { rangeHexes?: number }
  return view.rangeHexes ?? null
}

/** 空军盒：盒内是否可激活（1.4a：免费整备） */
function activatableOf(box: BoxView): boolean {
  const view = box as { activation?: { activatable: boolean } }
  return view.activation?.activatable === true
}

/** 空军盒：盒内 Active / Inactive 计数 */
function airCountOf(box: BoxView, kind: 'active' | 'inactive'): number {
  const view = box as { activeCount?: number; inactiveCount?: number }
  return (kind === 'active' ? view.activeCount : view.inactiveCount) ?? 0
}

/** 特殊补员盒：抽取项说明（表 1-3 原文） */
function itemsOf(box: BoxView): string[] {
  const view = box as { items?: readonly string[] }
  return [...(view.items ?? [])]
}

/**
 * 20.0a：当前母单位处在哪个创建时机（`null` ＝不在三个时机里）
 *
 * ★ 修（2026-10-30）：修前这个按钮把 `timing: 'startMove'` **写死**传给 store，
 *   等于替规则宣称"此刻正是开始移动" ⇒ 拆分的引擎闸永远通过、任何环节都能取用。
 *   现在时机只认 store 的事件账本（开始移动 / 战后推进 / 战后撤退各自开窗），
 *   不在账本里就把按钮灰掉并**明说**该先做什么（不静默）。
 */
const breakdownTimingNow = computed(() =>
  breakdownParentId.value === '' ? null : workbench.breakdownTimingOf(breakdownParentId.value),
)

const breakdownTimingLabel = computed<string>(() => {
  switch (breakdownTimingNow.value) {
    case 'startMove':
      return '开始移动'
    case 'advanceAfterCombat':
      return '战后推进'
    case 'retreatAfterCombat':
      return '战后撤退'
    default:
      return '—'
  }
})

/** 编队盒：图上的编队标记名 */
function markerNameOf(box: BoxView): string | null {
  const view = box as { marker?: { markerName: string } | null }
  return view.marker?.markerName ?? null
}

/** 编队盒：盒内（被收纳的）单位 id */
function hiddenIdsOf(box: BoxView): string[] {
  const view = box as { hiddenIds?: readonly string[] }
  return [...(view.hiddenIds ?? [])]
}

/** 编队盒：编队 id */
function formationIdOf(box: BoxView): string {
  const view = box as { formationId?: string }
  return view.formationId ?? ''
}

/** 可选飞机（未在盒里的） */
const airCandidates = computed(() =>
  workbench.airUnits
    .filter(
      (air) =>
        !containers.airBoxMembers.includes(air.instanceId) &&
        (uiMode === 'verify' || air.side === actingSide.value),
    )
    .map((air) => ({ id: air.instanceId, label: `${air.name}（${sideName(air.side)}）` })),
)

/** 可选母单位（图上、且非拆分单位本身） */
const parentCandidates = computed(() =>
  workbench.units
    .filter(
      (unit) =>
        !unit.specialized.includes('breakdown') &&
        (uiMode === 'verify' || unit.side === actingSide.value),
    )
    .map((unit) => ({
      id: unit.instanceId,
      label: `${unit.name}（${sideName(unit.side)}｜AR${unit.faces.combat.ar}｜${unit.steps}/${unit.printedSteps}）`,
    })),
)

/** 可选编队（多单位编队库，13.7） */
const formationChoices = computed(() =>
  formations.formations
    .filter((item) => uiMode === 'verify' || item.side === actingSide.value)
    .map((item) => ({
      id: item.formationId,
      label: `${item.formationId}（${sideName(item.side)}）`,
    })),
)

/** 编队归属方（按编队库） */
function formationSide(id: string): Side {
  return formations.formations.find((item) => item.formationId === id)?.side ?? 'axis'
}

/** 逗号分隔文本 → id 列表 */
function splitIds(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** 编队收纳：按文本输入执行（验证页） */
function hideNow(): boolean {
  const members = splitIds(formationMembersText.value)
  const onMap = splitIds(formationOnMapText.value)
  const hide = splitIds(formationHideText.value)
  return containers.hideInFormationBox({
    formationId: formationId.value,
    side: formationSide(formationId.value),
    memberIds: members,
    onMapIds: onMap,
    markerHexText: workbench.formationMarkerHexText,
    hideUnitIds: hide,
  })
}

/**
 * 条 24 / §5-E「改盒选」：正式界面**按图上该编队单位点选**要收纳的，不再手输 id。
 *
 * 成员＝「图上该编队单位」∪「**既有盒成员**」（`containers.formationBoxes[..].memberIds`）——
 * 后者必须有：先前已收纳的单位已不在图上，若只按图上推成员，盒的成员清单会越收越少。
 */
const formationCode = computed(
  () =>
    formations.formations.find((item) => item.formationId === formationId.value)?.formationCode ??
    null,
)
const formationUnitsOnMap = computed(() =>
  formationCode.value === null
    ? []
    : workbench.units.filter(
        (unit) =>
          unit.formation === formationCode.value && unit.side === formationSide(formationId.value),
      ),
)
const formationHideSelection = ref<string[]>([])
function toggleFormationHide(id: string): void {
  formationHideSelection.value = formationHideSelection.value.includes(id)
    ? formationHideSelection.value.filter((item) => item !== id)
    : [...formationHideSelection.value, id]
}
function hideNowFromBox(): boolean {
  const onMap = formationUnitsOnMap.value.map((unit) => unit.instanceId)
  const existing = containers.formationBoxes[formationId.value]?.memberIds ?? []
  const members = [...new Set([...existing, ...onMap])]
  return containers.hideInFormationBox({
    formationId: formationId.value,
    side: formationSide(formationId.value),
    memberIds: members,
    onMapIds: onMap,
    markerHexText: workbench.formationMarkerHexText,
    hideUnitIds: formationHideSelection.value,
  })
}

/**
 * B17a-2：**只渲染哪一段**（默认全渲染，引擎验证页照旧）
 *
 * 与 B15d/B15e、B17a-1 同一套做法（方案 §10①「右侧栏只读」）。本面板里混着两类东西——
 *   · **只读信息**（`info`）：记录轨的三个标签与轨位、各盒的分栏与持有项清单、数据缺口提示、
 *     最近一次结论 —— 这些是"随时想看一眼"的；
 *   · **动作**（`actions`）：记录轨的裁判订正（推进回合标记 / 设天气标记 / 设铁路容量 / 按日期重算）、
 *     逐项的返场与永久移除、边缘盒离开、空军盒移出、四类盒的操作区、剧本抽取盒（编队抽签）、
 *     编队收纳盒的建立、容器重置 —— 按方案 §4.7「**盒卡只负责『选谁』，动作进会话框**」，
 *     它们由"在托盘里展开一张盒卡"触发（`containers.cardOpenId`）。
 */
const props = withDefaults(
  defineProps<{ only?: 'info' | 'actions' | null; subjectId?: string | null }>(),
  { only: null, subjectId: null },
)

watch(
  () => props.subjectId,
  (id) => {
    const unit = workbench.units.find((item) => item.instanceId === id)
    if (unit === undefined) return
    formationId.value =
      formations.formations.find(
        (item) => item.side === unit.side && item.formationCode === unit.formation,
      )?.formationId ?? ''
    formationHideSelection.value = []
  },
  { immediate: true },
)

/**
 * C-1：**某个盒的动作段是否该显示**（判据＝当前展开卡覆盖的 `boxKind`）
 *
 *   · 本实例不画动作段（`only="info"`）⇒ false；
 *   · 没有展开卡（`openCardBoxKinds === null`，验证页/右栏）⇒ true（不过滤，照旧全给，供核对）；
 *   · 展开了卡 ⇒ **只**给该卡覆盖的盒类型（展开空军盒不再列出死亡堆的动作）。
 */
function showsBoxActions(kind: string): boolean {
  if (!showsActions.value) return false
  if (kind === 'edgeBox' && !containers.canUseEdgeBoxes) return false
  if (uiMode !== 'verify' && (hotseat.handoffPending || hotseat.viewerSide !== actingSide.value))
    return false
  if (props.subjectId != null) return kind === 'formationBox'
  const kinds = containers.openCardBoxKinds
  return kinds === null || kinds.includes(kind)
}

/** 本实例是否要画"只读信息"那一段 */
const showsInfo = computed(() => props.only === null || props.only === 'info')
/** 本实例是否要画"动作"那一段 */
const showsActions = computed(() => props.only === null || props.only === 'actions')

/**
 * 死亡堆（13.5 / 13.5a / 13.5c）：右键菜单
 *
 * 用户 2026-11-10 报的实机 bug —— 死亡堆以前是只读 `<li>`：点不动、右键无菜单、
 * 也不知道"为什么不能回场"。现在：
 *   · 左键 → `pickDeadPileUnitNow` 选中并预选为重建对象（行键清空，仍由玩家点）；
 *   · 右键 → 同时打开该持项的菜单（重建 / 永久移除 + 不可回场原因）；
 *   · 菜单里的「重建（13.5）付补员」直接调唯一的 `rebuildUnitNow`，不另做一套付费。
 */
const deadPileMenuId = ref('')
const rebuildRows = computed(() => rebuildChartRows(workbench.activeSide))

function isDeadPileActionable(box: BoxView): boolean {
  return box.kind === 'deadPile' && box.side === actingSide.value && showsBoxActions('deadPile')
}

function pickDeadPileEntry(box: BoxView, unitId: string): void {
  if (!isDeadPileActionable(box)) return
  workbench.pickDeadPileUnitNow(unitId)
}

function openDeadPileMenu(box: BoxView, unitId: string): void {
  if (!isDeadPileActionable(box)) return
  workbench.pickDeadPileUnitNow(unitId)
  deadPileMenuId.value = unitId
}

function rebuildDeadPileEntry(unitId: string): void {
  const ok = workbench.rebuildUnitNow({
    unitId,
    rebuildType: workbench.rebuildPickRow,
    replHexText: workbench.rebuildReplHexText,
  })
  if (ok) deadPileMenuId.value = ''
}

/**
 * ★ 记录轨上那三个"手动改表"的按钮是**裁判工具**，不是流程动作
 *
 * 2.2 的回合推进、1.5 的天气判定、专规 1.2 的铁路容量**都由系统按日期自动结算**
 * （见 `docs/阶段-环节-操作矩阵.md` 的"只有这 6 个环节是自动结算"）。它们的"改值"入口
 * 只该出现在**引擎验证页** —— 对局台的盒会话（`only="actions"`）不铺，
 * 免得"展开一张盒卡"就顺带看到改回合标记 / 改天气 / 改运力这些不属于本环节的东西。
 *
 * ★ 用户 2026-10-25「每个阶段/环节只能出现该环节可用 UI」：这三项在**任何**玩家环节都不该有。
 * ★ 用户 2026-10-25（本轮）：「referee 类里对局台不该出现的按钮在 UI 层**统一**按 `showsReferee`
 *   收掉」⇒ 判据从 `props.only === null` 换成 **ui-mode**（`useRefereeTools()`）。
 *   为什么必须换：`only === null` 只在"宿主没传 only"时为真，而本仓库两处宿主的差别
 *   **本就该由 `formal / verify` 表达**——一旦有面板在正式宿主里不带 `only` 挂载
 *   （`ReinforcementPanel` / `BarragePanel` / `VictoryPanel` 都这样），
 *   `only === null` 就会把裁判工具放进对局台。
 */
const showsReferee = useRefereeTools()

function boxAircraft(side: Side) {
  return workbench.ownAirUnits.filter(
    (air) => air.side === side && containers.airBoxMembers.includes(air.instanceId),
  )
}
</script>

<template>
  <BasePanel :title="showsInfo ? '记录轨与容器' : ''">
    <p v-if="showsInfo && showsReferee" class="muted">
      轨与盒的**名册与判定**全部来自引擎（`engine/rules/containers.ts`），本面板只画表与收点击。
      每个盒都带 **美工接口**（`artwork`）：有图即渲染图，无图渲染纯文字盒；数据缺口（如 2.3a 的
      Alarm 单位未在单位库标注、剧本原文未列出被抽中的编队）在盒上**如实标出**，不猜。
    </p>

    <!-- ── ① 记录轨 ── -->
    <template v-if="showsInfo">
      <hr />
      <h4 class="block-title">记录轨</h4>
      <div class="row">
        <BaseTag kind="info">回合 T{{ containers.turn }}｜{{ containers.date }}</BaseTag>
        <BaseTag kind="neutral">{{ containers.turnTrack.rule }}</BaseTag>
        <BaseButton
          v-if="showsReferee"
          variant="secondary"
          size="sm"
          @click="containers.advanceTurnMarker()"
        >
          推进回合标记（2.2）
        </BaseButton>
        <span class="num">
          轨格 {{ containers.turnTrack.slots.length }} 格（markers.json）｜当前标记
          {{ containers.turnTrack.markers[0]?.detail ?? '（不在轨上）' }}
        </span>
      </div>
      <div class="row">
        <BaseTag kind="neutral"
          >天气 {{ containers.weather.air === 'normal' ? '正常飞行' : '受限飞行' }}</BaseTag
        >
        <BaseButton
          v-if="showsReferee"
          variant="secondary"
          size="sm"
          @click="containers.setWeatherMarker('normal')"
        >
          置天气标记：正常
        </BaseButton>
        <BaseButton
          v-if="showsReferee"
          variant="secondary"
          size="sm"
          @click="containers.setWeatherMarker('limited')"
        >
          置天气标记：受限
        </BaseButton>
        <span class="muted">{{ containers.weatherTrack.note }}</span>
      </div>
      <div class="row">
        <BaseTag kind="neutral">铁路容量轨 {{ containers.railCapTrack.rule }}</BaseTag>
        <template v-for="entry in containers.railCapTrack.sides" :key="entry.side">
          <span class="num">
            {{ sideName(entry.side) }}：{{ entry.current }}（按日期应为 {{ entry.onDate }}｜升级日
            {{ containers.railCapTrack.boostDate }} → {{ entry.boostTo }}）
          </span>
          <BaseButton
            v-if="showsReferee"
            variant="ghost"
            size="sm"
            @click="containers.setRailCapacity(entry.side, entry.onDate)"
          >
            设为 {{ entry.onDate }}
          </BaseButton>
        </template>
        <BaseButton
          v-if="showsReferee"
          variant="secondary"
          size="sm"
          @click="containers.applyRailCapacityForDate()"
        >
          按日期重算（专规 1.2）
        </BaseButton>
      </div>
    </template>
    <!-- ── ② 盒 ── -->

    <template v-for="box in boxes" :key="box.id">
      <!-- ★ 条 14：地图外空军盒独立成窗（自带标题与边框，不与编队/死亡堆等盒共用 <details> 容器） -->
      <section v-if="box.kind === 'airBox'" class="box box--air">
        <header class="box__head box__head--title">
          <span class="box__name">地图外空军盒 · {{ box.name }}</span>
          <!-- 2026-11-10：对局台只摆飞机算子图，盒头不再铺规则号 / 阵营 / 枚数 / 缺口那堆读数 -->
          <template v-if="showsReferee">
            <BaseTag kind="neutral">{{ box.rule }}</BaseTag>
            <BaseTag kind="info">{{ sideName(box.side) }}</BaseTag>
            <span class="num">
              内 {{ box.holdings.length }} 枚<template v-if="box.capacity !== null">
                ／容量 {{ box.capacity }}</template
              >
            </span>
            <span v-if="box.dataGaps.length > 0" class="num box__gap"
              >数据缺口 ×{{ box.dataGaps.length }}</span
            >
          </template>
        </header>

        <AircraftRoster
          v-if="
            !showsReferee &&
            box.side !== null &&
            box.side === actingSide &&
            showsBoxActions('airBox')
          "
          :box-side="box.side"
          :aircraft="boxAircraft(box.side)"
        />

        <!-- 验证页：盒图与裁判入口照旧（对局台不铺） -->
        <template v-if="showsReferee">
          <div class="box__art">
            <img
              v-if="box.artwork?.imageKey"
              class="box__img"
              :src="box.artwork.imageKey"
              alt="盒图"
            />
            <span v-else class="muted"
              >（无盒图：美工接口已留，数据补 `containers.artwork[{{ box.id }}]` 即显示）</span
            >
          </div>
          <div v-if="showsBoxActions('airBox')" class="row">
            <label class="field">
              移入盒
              <select v-model="airUnitId" class="select">
                <option value="">（选择飞机）</option>
                <option v-for="item in airCandidates" :key="item.id" :value="item.id">
                  {{ item.label }}
                </option>
              </select>
            </label>
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="airUnitId === ''"
              @click="containers.setAirInBox(airUnitId, true)"
            >
              移入盒（1.4a）
            </BaseButton>
            <BaseButton
              variant="primary"
              size="sm"
              @click="containers.activateAirBox(box.side === 'soviet' ? 'soviet' : 'axis')"
            >
              盒内免费整备（1.4a：Inactive → Active）
            </BaseButton>
            <span class="num">
              航程 {{ rangeHexesOf(box) ?? '—' }} 格｜Active {{ airCountOf(box, 'active') }} /
              Inactive {{ airCountOf(box, 'inactive') }}｜可激活：{{
                activatableOf(box) ? '是（免费整备）' : '否'
              }}
            </span>
          </div>
          <p v-for="(note, index) in box.notes" :key="`n${index}`" class="muted">· {{ note }}</p>
          <p v-for="(gap, index) in box.dataGaps" :key="`g${index}`" class="warn">
            ⚠ 数据缺口：{{ gap }}
          </p>
        </template>
      </section>

      <details v-else class="box" :open="props.only === 'actions' || showsReferee">
        <summary class="box__head">
          <span class="box__name">{{ box.name }}</span>
          <BaseTag kind="neutral">{{ box.rule }}</BaseTag>
          <BaseTag kind="info">{{ sideName(box.side) }}</BaseTag>
          <span class="num">
            内 {{ box.holdings.length }} 枚<template v-if="box.capacity !== null">
              ／容量 {{ box.capacity }}</template
            >
          </span>
          <span v-if="box.dataGaps.length > 0" class="num box__gap"
            >数据缺口 ×{{ box.dataGaps.length }}</span
          >
        </summary>

        <!-- 盒的美工接口：有图即渲染，无图退化 -->
        <div v-if="showsReferee" class="box__art">
          <img
            v-if="box.artwork?.imageKey"
            class="box__img"
            :src="box.artwork.imageKey"
            alt="盒图"
          />
          <span v-else class="muted"
            >（无盒图：美工接口已留，数据补 `containers.artwork[{{ box.id }}]` 即显示）</span
          >
        </div>

        <!-- 分栏与持有项 -->
        <div v-for="section in box.sections" :key="section.id" class="box__section">
          <p class="num box__section-title">
            {{ section.label }}（{{ section.rule }}）：
            {{ box.holdings.filter((holding) => holding.sectionId === section.id).length }} 枚
          </p>
          <ul class="picks">
            <li
              v-for="holding in box.holdings.filter((item) => item.sectionId === section.id)"
              :key="holding.unitId"
              class="num"
              :class="{
                'pile-item--picked':
                  box.kind === 'deadPile' && workbench.deadPilePickId === holding.unitId,
              }"
              @click="pickDeadPileEntry(box, holding.unitId)"
              @contextmenu.prevent="openDeadPileMenu(box, holding.unitId)"
            >
              {{ holding.name ?? holding.unitId }}
              <span v-if="holding.note !== undefined" class="muted">（{{ holding.note }}）</span>
              <!--
                死亡堆（13.5 / 13.5a / 13.5c）：用户 2026-11-10 报的实机 bug ——
                这里以前是只读 `<li>`：点不动、右键无菜单、也不知道为什么不能回场。
                现在：左键选中（预选重建对象）→ 右键出菜单；菜单里给两条动作，
                重建项按 `deadPileRebuildBlockedReason` 逐条写明哪个条款挡的。
              -->
              <template
                v-if="
                  box.kind === 'deadPile' && box.side === actingSide && showsBoxActions('deadPile')
                "
              >
                <div v-if="deadPileMenuId === holding.unitId" class="pile-menu" @click.stop>
                  <p class="muted">
                    13.5：行键决定费用（工程库没有「算子→行」映射，须按重建表选）；补员格用「点地图选格」
                  </p>
                  <div class="row">
                    <BaseButton
                      v-for="row in rebuildRows"
                      :key="row.unitType"
                      :variant="workbench.rebuildPickRow === row.unitType ? 'primary' : 'secondary'"
                      size="sm"
                      @click="workbench.rebuildPickRow = row.unitType"
                    >
                      {{ row.unitType }}（{{ row.sourceLabel }}）
                    </BaseButton>
                    <BaseButton
                      variant="secondary"
                      size="sm"
                      @click="workbench.beginRebuildReplHexPickNow(holding.unitId)"
                    >
                      点地图选补员格（高亮 13.5a 合法落点）
                    </BaseButton>
                    <span class="muted">
                      补员格：{{
                        workbench.rebuildReplHexText === ''
                          ? '（未选）'
                          : workbench.rebuildReplHexText
                      }}
                    </span>
                  </div>
                  <div class="row">
                    <BaseButton
                      v-for="action in workbench.deadPileActionsOf(holding.unitId)"
                      :key="action.key"
                      :variant="action.key === 'deadPile.rebuild' ? 'primary' : 'ghost'"
                      size="sm"
                      :title="action.disabledReason ?? action.rule"
                      @click="
                        action.key === 'deadPile.rebuild'
                          ? rebuildDeadPileEntry(holding.unitId)
                          : workbench.removeForeverNow(holding.unitId)
                      "
                    >
                      {{ action.label }}
                    </BaseButton>
                  </div>
                  <p
                    v-if="workbench.deadPileRebuildBlockedReason(holding.unitId) !== null"
                    class="warn"
                  >
                    {{ workbench.deadPileRebuildBlockedReason(holding.unitId) }}
                  </p>
                  <p v-else class="muted">可回场：13.5a 落点已满足，选好行键与补员格即可付补员。</p>
                </div>
                <span v-else class="muted">（左键选中 / 右键出菜单）</span>
                <!--
                ★ 修（2026-10-30）：「返场到 X」**只留给裁判**。
                它直接调 `returnFromDeadPileNow`（只做"从死亡堆取出 → 落到指定格"），
                而 13.5 的重建要**付补员**且必须"补员同格 + 友方指挥部 2 格内 + 不在敌方 ZOC"，
                1.6c 的免费返场要**先抽到特殊补员**（−1 军力）、13.7 的互换要先抽签——
                这三条合法路径各有自己的引擎计划与入口。玩家面上直接给一个"免费返场"按钮，
                等于把 13.5a 的费用与位置约束全绕过去（盒子动作修好后这个按钮才真正露出来）。
              -->
                <BaseButton
                  v-if="showsReferee"
                  variant="ghost"
                  size="sm"
                  title="裁判订正用：规则内重建请走「重建（13.5）」付补员，特殊补员请走 1.6c 抽取"
                  @click="
                    workbench.returnFromDeadPileNow({
                      instanceId: holding.unitId,
                      hexText: workbench.deadPileReturnHexText,
                    })
                  "
                >
                  返场到 {{ workbench.deadPileReturnHexText || '（点地图选格）' }}
                </BaseButton>
              </template>
              <!-- 边缘盒：离开（1.4b） -->
              <template v-if="box.kind === 'edgeBox' && showsBoxActions('edgeBox')">
                <BaseButton
                  variant="ghost"
                  size="sm"
                  :disabled="
                    containers.edgeBoxExitCandidates(edgeBoxOf(box), holding.unitId, edgeUseRailCap)
                      .length === 0
                  "
                  @click="
                    containers.beginEdgeBoxExitHexPickNow(
                      edgeBoxOf(box),
                      holding.unitId,
                      edgeUseRailCap,
                    )
                  "
                >
                  点地图选出盒格
                </BaseButton>
              </template>
            </li>
          </ul>
        </div>

        <!-- 要点与缺口 -->
        <template v-if="showsReferee">
          <p v-for="(note, index) in box.notes" :key="`n${index}`" class="muted">· {{ note }}</p>
          <p v-for="(gap, index) in box.dataGaps" :key="`g${index}`" class="warn">
            ⚠ 数据缺口：{{ gap }}
          </p>
        </template>

        <!-- ── 各类盒的操作（B17a-2：动作段 ⇒ 只在会话框里画） ── -->
        <!-- 拆分单位盒（1.8a / 20.0a–g） -->
        <div v-if="box.kind === 'breakdownBox' && showsBoxActions('breakdownBox')" class="row">
          <label class="field">
            母单位
            <select v-model="breakdownParentId" class="select">
              <option value="">（选择）</option>
              <option v-for="item in parentCandidates" :key="item.id" :value="item.id">
                {{ item.label }}
              </option>
            </select>
          </label>
          <label class="field">
            ① AR 匹配（≤ 母单位 AR）
            <span class="row">
              <BaseButton
                v-for="ar in breakdownArChoices"
                :key="ar"
                :variant="breakdownAr === ar ? 'primary' : 'secondary'"
                size="sm"
                @click="breakdownAr = ar"
              >
                AR{{ ar }}
              </BaseButton>
            </span>
          </label>
          <label class="field">
            ② 数量（≤ {{ breakdownCountMax }}）
            <input
              v-model.number="breakdownCount"
              class="input"
              type="number"
              min="1"
              :max="Math.max(1, breakdownCountMax)"
            />
          </label>
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="
              breakdownParentId === '' || breakdownTimingNow === null || breakdownCountNow === 0
            "
            :title="
              breakdownTimingNow === null
                ? '20.0a：只有「开始移动 / 战后推进 / 战后撤退」三个时机能创建拆分单位（未动过的单位在本方移动环节直接可拆）'
                : `20.0a 当前时机：${breakdownTimingLabel}；20.0b 子 AR ≤ 母 AR`
            "
            @click="
              containers.takeBreakdown({
                parentInstanceId: breakdownParentId,
                breakdownAr,
                count: breakdownCountNow,
              })
            "
          >
            取用 {{ breakdownCountNow }} 枚（20.0：不耗 MP）
          </BaseButton>
        </div>

        <!-- 1.6c 特殊补员抽取盒（两道闸：环节 + 日期；不放行时明说原因） -->
        <div
          v-if="
            box.kind === 'specialReplBox' && box.side !== null && showsBoxActions('specialReplBox')
          "
          class="row"
        >
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="containers.specialReplRefusal(box.side) !== null"
            :title="containers.specialReplRefusal(box.side) ?? undefined"
            @click="containers.drawSpecialRepl(box.side)"
          >
            掷骰抽取（1.6c，1 骰）
          </BaseButton>
          <span class="muted">抽取项：{{ itemsOf(box).join(' ／ ') }}</span>
          <span v-if="containers.specialReplRefusal(box.side) !== null" class="muted num">
            {{ containers.specialReplRefusal(box.side) }}
          </span>
        </div>

        <!-- 边缘盒（1.4b） -->
        <div v-if="box.kind === 'edgeBox' && showsBoxActions('edgeBox')" class="row">
          <label class="field">
            入盒单位
            <select v-model="edgeUnitId" class="select">
              <option value="">选择单位</option>
              <option
                v-for="item in containers.edgeBoxEnterCandidates(edgeBoxOf(box), edgeUseRailCap)"
                :key="item.id"
                :value="item.id"
              >
                {{ item.label }}
              </option>
            </select>
          </label>
          <label class="field">
            <input v-model="edgeUseRailCap" type="checkbox" />
            进出改用铁路运力
          </label>
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="
              !containers
                .edgeBoxEnterCandidates(edgeBoxOf(box), edgeUseRailCap)
                .some((item) => item.id === edgeUnitId)
            "
            @click="
              containers.moveEdgeBox({
                box: edgeBoxOf(box),
                instanceId: edgeUnitId,
                direction: 'enter',
                useRailCap: edgeUseRailCap,
              })
            "
          >
            入盒（1.4b：进入即停）
          </BaseButton>
        </div>

        <!-- 编队收纳盒（13.7 / 3.6f） -->
        <div v-if="box.kind === 'formationBox' && showsBoxActions('formationBox')" class="row">
          <span class="num">标记：{{ markerNameOf(box) ?? '（未找到 3.6f 标记）' }}</span>
          <BaseButton
            variant="secondary"
            size="sm"
            @click="containers.revealFromFormationBox(formationIdOf(box), hiddenIdsOf(box))"
          >
            全部放回图上（13.7）
          </BaseButton>
        </div>
      </details>
    </template>

    <!-- ── ③ 剧本抽取盒（编队抽签；池成员由 formations.json 推导） ──
         ch10（用户 2026-11-10 裁定）：抽取**只在初设单位放置完成后执行一次**，
         之后任何阶段都不再出现抽取窗口/按钮 ⇒ 可见条件收紧为 `setup.setupDrawEntryVisible`。 -->
    <template v-if="setup.setupDrawEntryVisible">
      <hr />
      <h4 class="block-title">剧本抽取盒（ch10 Formation Chit Draw / ch11 随机化）</h4>
      <div class="row">
        <!-- ★ 联调：剧本号唯一权威在会话 store，选择入口只留「初设与开局」一处（用户口径） -->
        <BaseTag kind="info">剧本 {{ containers.scenarioId }}</BaseTag>
        <template v-if="scenarioBox !== null">
          <BaseTag kind="info"
            >池 {{ scenarioBox.pool.length }} / 规则给定 {{ scenarioBox.poolSize }}</BaseTag
          >
          <BaseTag kind="neutral">{{ scenarioBox.rule }}</BaseTag>
          <span class="muted">原文：{{ scenarioBox.raw || '（无抽取）' }}</span>
        </template>
      </div>
      <template v-if="scenarioBox !== null && scenarioBox.groups.length > 0">
        <p class="num">入杯池：{{ scenarioBox.pool.map((item) => item.formationId).join('、') }}</p>
        <div class="row">
          <BaseButton
            v-if="showsActions"
            variant="primary"
            size="sm"
            title="ch10 Formation Chit Draw / ch11 剧本随机化：初设完成后只执行一次"
            @click="setup.executeSetupDraws()"
          >
            抽取编队
          </BaseButton>
        </div>
        <p class="muted">初设完成后只执行一次；抽完即永久收起，后续增援段与阶段切换不再抽取。</p>
      </template>
      <p v-else class="muted">本剧本无编队抽取（ch11：剧本 7 无随机化）。</p>
      <p v-for="(gap, index) in scenarioBox?.dataGaps ?? []" :key="`sg${index}`" class="warn">
        ⚠ 数据缺口：{{ gap }}
      </p>
    </template>

    <!--
      ── ④ 编队收纳盒的建立（13.7） ── B17a-2：建立是**动作** ⇒ 只在会话框那一段里画

      ★ 修（2026-10-30）：这一块原先套在上面那段「剧本抽取盒（裁判重抽）」的
        `v-if="showsReferee && showsBoxActions('scenarioDrawBox')"` 里 ⇒ 两层门互相排斥：
        ① 正式对局台 `showsReferee === false` ⇒ 整块不铺；
        ② 验证页展开别的卡时该卡覆盖的盒不含 `scenarioDrawBox` ⇒ `showsBoxActions` 为 false。
        结果 13.7「收纳进盒 / 全部放回图上」在正式界面**完全不可达**。
        现在它按"该卡覆盖的盒"独立判据出现（`formation_draw` 分区归 `scenarioDrawBox`；
        `formationBox` 一并收，将来数据侧真给这张卡也不用再改）。
    -->
    <template v-if="showsBoxActions('scenarioDrawBox') || showsBoxActions('formationBox')">
      <hr />
      <h4 v-if="showsInfo" class="block-title">编队收纳盒（13.7 / 3.6f：收纳下属以制造迷雾）</h4>
      <p v-if="showsInfo" class="muted">
        建立收纳盒是**动作**（在托盘里展开一张盒卡后，会话框里给出表单）：本面板的只读段只说明
        它的来由——13.7 要求「至少一个所属单位须与标记同格」，盒内单位在图上仍计入 4.8a 的战斗 RE。
      </p>
      <div class="row">
        <label class="field">
          编队
          <select v-model="formationId" class="select">
            <option value="">（选择编队）</option>
            <option v-for="item in formationChoices" :key="item.id" :value="item.id">
              {{ item.label }}
            </option>
          </select>
        </label>
        <template v-if="uiMode === 'verify'">
          <label class="field">
            全部成员 id
            <input v-model="formationMembersText" class="input path-input" placeholder="逗号分隔" />
          </label>
          <label class="field">
            图上成员 id
            <input v-model="formationOnMapText" class="input path-input" placeholder="逗号分隔" />
          </label>
        </template>
        <label class="field">
          标记格
          <UiField
            v-model="workbench.formationMarkerHexText"
            class="input num"
            placeholder="列.行"
          />
          <BaseButton
            variant="secondary"
            size="sm"
            @click="workbench.beginFormationMarkerHexPickNow()"
          >
            点地图选格
          </BaseButton>
        </label>
        <template v-if="uiMode === 'verify'">
          <label class="field">
            本次收纳 id
            <input v-model="formationHideText" class="input path-input" placeholder="逗号分隔" />
          </label>
          <BaseButton variant="primary" size="sm" :disabled="formationId === ''" @click="hideNow()">
            收纳进盒（13.7：至少一个所属单位须与标记同格）
          </BaseButton>
        </template>
        <!-- 条 24 / §5-E「改盒选」：正式界面没有 id 文本框，改为点选图上该编队的单位 -->
        <template v-else>
          <p class="muted">点选要收纳的图上单位（13.7：至少一个须与标记同格）：</p>
          <div class="row formation-pick">
            <button
              v-for="unit in formationUnitsOnMap"
              :key="unit.instanceId"
              type="button"
              class="formation-chip"
              :class="{ 'formation-chip--on': formationHideSelection.includes(unit.instanceId) }"
              @click="toggleFormationHide(unit.instanceId)"
            >
              <img
                v-if="counterImageUrlOf(unit) !== null"
                :src="counterImageUrlOf(unit) ?? undefined"
                alt=""
              />
              <span class="num">{{ unit.name }}</span>
            </button>
          </div>
          <p v-if="formationUnitsOnMap.length === 0" class="muted">该编队当前在图上没有单位。</p>
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="formationId === '' || formationHideSelection.length === 0"
            @click="hideNowFromBox()"
          >
            收纳进盒（13.7）
          </BaseButton>
        </template>
      </div>
    </template>

    <!--
        ── ④b 建造标记（专规 3.5）── 批 D 切片 2（用户 9.16 #15）

        「盒里拾起（高亮）→ 点地图落位 → **二选一**」：修前只有专规面板里那套「文本框 + 下拉 + 按钮」，
        而标记盒是**空的**（投影对 `sectionId === null` 一律给空数组）。现在：
          · 标记盒里能看见**未放置的建造标记**（枚数＝`workbench.constructionMarkers`）；
          · 展开标记盒卡即在本会话框里给出**二选一**与「拾起并落位」（走同一份 store 状态）；
          · 落位用既有的 B27 待点格（候选＝有轴方战斗单位的格，与引擎前提同一条）。
      -->
    <template v-if="showsBoxActions('markers')">
      <hr />
      <h4 class="block-title">建造标记（专规 3.5）</h4>
      <p class="muted">
        剧本 1/2 初设各 3
        枚；可在**任一轴方移动阶段**、**单位移动之前**放进一个有**轴方战斗单位**的格——
        **免费**：桥按 13.8b 由 HQ 架桥、简易机场按 15.2
        的标准简易机场处理；**每枚只能用一次、不可重建**； 只有苏军战斗单位进入其格才会被毁。
      </p>
      <div class="row">
        <BaseTag :kind="workbench.constructionMarkers > 0 ? 'info' : 'neutral'">
          剩余 {{ workbench.constructionMarkers }} 枚（标记盒内）
        </BaseTag>
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="workbench.constructionMarkers === 0"
          @click="workbench.armConstructionMarkerNow('bridge')"
        >
          拾起一枚 → 桥（13.8b）
        </BaseButton>
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="workbench.constructionMarkers === 0"
          @click="workbench.armConstructionMarkerNow('airStrip')"
        >
          拾起一枚 → 简易机场（15.2）
        </BaseButton>
        <BaseTag v-if="workbench.constructionMarkerPicked" kind="success">
          已拾起（点地图上有轴方战斗单位的格落位）
        </BaseTag>
      </div>
    </template>

    <!--
      ── ⑤ 最近一次结论（只在整页/验证页保留）──
      ★ 用户 2026-11-10：盒内动作窗（`only="actions"`）删掉这条回执 —— 动作成败由窗内按钮态与日志说，不再单占一行。
    -->
    <template v-if="props.only === null">
      <hr />
      <p v-if="containers.lastAction === null" class="muted">尚无操作。</p>
      <p v-else class="num">
        <BaseTag :kind="containers.lastAction.ok ? 'success' : 'danger'">
          {{ containers.lastAction.scope }}｜{{ containers.lastAction.rule }}
        </BaseTag>
        {{ containers.lastAction.detail }}
      </p>
    </template>
    <div v-if="showsActions" class="row">
      <label class="field">
        返场落点（死亡堆 → 图）
        <UiField v-model="workbench.deadPileReturnHexText" class="input num" placeholder="列.行" />
        <BaseButton
          variant="secondary"
          size="sm"
          @click="workbench.beginDeadPileReturnHexPickNow()"
        >
          点地图选格
        </BaseButton>
      </label>
      <!-- ★ 用户 2026-11-10：删掉 `alarmLimit` 只读行（整页 / 验证页仍可改） -->
      <label v-if="props.only === null" class="field">
        2.3a Alarm 单位（单位库 `alarmLimit` 自动取；手输即临时覆盖，清空即回到数据）
        <input
          v-if="uiMode === 'verify'"
          class="input path-input"
          placeholder="逗号分隔（留空 = 用数据里的三种）"
          :value="(containers.alarmUnitIds ?? []).join(',')"
          @change="
            containers.alarmUnitIds = ($event.target as HTMLInputElement).value
              .split(/[,，\s]+/)
              .filter((item) => item !== '')
          "
        />
      </label>
      <!-- 重置全部盒子＝裁判工具（会清掉名册），对局台不铺 -->
      <BaseButton
        v-if="showsReferee"
        variant="ghost"
        size="sm"
        @click="containers.resetContainers()"
      >
        重置盒账本
      </BaseButton>
    </div>
    <!--
      2.3a 混编上限（3 / 5 / 7，按算子类型计）
      ★ 用户 2026-11-10：**只有超编时才出现**（余量充足是背景信息，不占屏）。
    -->
    <ul v-if="alarmMixOver.length > 0" class="mix">
      <li class="mix__head">{{ containers.alarmMixRule }} 混编上限（按算子类型计）</li>
      <li v-for="row in alarmMixOver" :key="row.unitId">
        {{ row.unitId }}：在场 {{ row.inPlay }} / 上限 {{ row.limit }} ⇒ 余量 {{ row.remaining
        }}<span class="over">★ 超编</span>
      </li>
    </ul>
  </BasePanel>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.mix {
  margin: 0 0 var(--space-2);
  padding-left: var(--space-4);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  list-style: none;
}

.mix .over {
  margin-left: var(--space-2);
  color: var(--color-danger, #b3261e);
}

.block-title {
  margin: var(--space-1) 0;
  font-size: var(--text-sm);
  color: var(--color-ink);
}

.field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.select {
  max-width: 300px;
}

.input {
  width: 90px;
}

.path-input {
  width: 220px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.box {
  border-top: 1px solid var(--color-rule);
  padding: var(--space-1) 0;
}

/* 条 14：地图外空军盒独立成窗（与编队等盒的 <details> 区分边框与标题） */
.box--air {
  margin: var(--space-2) 0;
  border: 1px solid var(--color-rule);
  border-left: 3px solid var(--color-info);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  background: var(--color-bg-2);
}

.box__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  cursor: pointer;
}

.box__head--title {
  cursor: default;
}

.box__name {
  color: var(--color-ink);
}

.box__gap {
  color: var(--color-accent);
}

.box__art {
  margin: var(--space-1) 0;
}

.box__img {
  max-height: 96px;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
}

.box__section {
  margin: var(--space-1) 0 var(--space-1) var(--space-2);
}

.box__section-title {
  margin: 0;
  color: var(--color-muted);
}

.picks {
  margin: 0;
  padding-left: var(--space-3);
  list-style: none;
}

/* 13.5：死亡堆持项（用户 2026-11-10）—— 可点选 / 可右键 / 菜单在此展开 */
.picks li {
  cursor: default;
}

.pile-item--picked {
  color: var(--color-accent);
  font-weight: 600;
}

.pile-menu {
  margin: var(--space-2) 0;
  padding: var(--space-2);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.warn {
  color: var(--color-accent);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

hr {
  border: none;
  border-top: 1px solid var(--color-rule);
  margin: var(--space-3) 0;
}

/* 条 24：编队收纳盒的「点选单位」芯片（正式界面替代 id 文本框） */
.formation-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.formation-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--color-rule);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}

.formation-chip img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

.formation-chip--on {
  outline: 2px solid var(--color-accent-2);
  background: rgba(128, 128, 128, 0.12);
}
</style>
