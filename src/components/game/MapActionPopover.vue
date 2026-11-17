<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { BaseButton, BaseIcon } from '@/components/base'
import { MapPopover } from '@/components/map'
import {
  counterImageUrlOf,
  hexLabel,
  useMapViewStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * 地图动作小窗（W7 C16：**地图优先**交互的载体）
 *
 * ## 它按什么分派
 *   一块内容对应「当前盘面上正在进行的那件事」，而不是一堆常驻控件：
 *   ① **战斗流程中**（9.2 九步）：在**战斗发生的那一格**展开战果承受 / 选项 / 推进，
 *      与地图上这次画出的高亮（推进格、补给站）配对使用；撤退的落点与确认在战斗结算面板；
 *   ② **无战斗时**：展示该格堆叠（4.9a 裁剪后的可见内容）+ 本方飞机。
 *      炮击、空军任务等动作一律从**右键菜单**进入它们各自的面板，本小窗不重复摆按钮。
 *
 * ## 分层纪律（CODE_SPEC）
 *   本组件**不做任何规则计算**：损失分配、推进候选等全部来自 store 对引擎的调用结果；
 *   这里只画图、收点击，把输入写进既有的 `combatInputs`。
 *
 * ★ 为什么在地图上做：规则书里这些动作的对象就是「战斗发生的那一格」「那个堆叠」「那架飞机」，
 *   所以能把选择放在地图上的就不搬到侧栏（用户需求）。
 */

const mapView = useMapViewStore()
const workbench = useWorkbenchStore()

const open = computed(() => mapView.popup !== null)
const anchor = computed(() => mapView.popup ?? { x: 0, y: 0 })

/**
 * 地图可视区（用户 2026-11-18）
 *
 * 小窗层级低于左侧指令栏/底部托盘；贴边开窗会落到它们下面，真实鼠标事件被吃掉
 * （右键呼不出菜单）。开窗/换格时量一次地图矩形，交给 `MapPopover` 夹取。
 */
const mapArea = ref<{ left: number; right: number; top: number; bottom: number } | null>(null)
watch(
  () => [mapView.popup?.x, mapView.popup?.y],
  () => {
    const rect = document.querySelector('.mapcanvas')?.getBoundingClientRect()
    mapArea.value =
      rect === undefined
        ? null
        : { left: rect.left + 6, right: rect.right - 6, top: rect.top + 6, bottom: rect.bottom - 6 }
  },
  { immediate: true, flush: 'post' },
)
const content = computed(() => mapView.popupContent)
const title = computed(() => (mapView.popup === null ? '' : `格 ${hexLabel(mapView.popup.hex)}`))

/**
 * 条 25（D2 修订）：**小窗只剩两种**——`content` 常规小窗、`context` 右键菜单
 *
 * 点空格的只读格号浮签已删：格号改由地图悬停提示（`MapCanvas` 的 `hoverTip`）随指针浮现，
 * 离格即消失，不再留一张需要再点一下才收的小签。
 */
const variant = computed(() => mapView.popup?.variant ?? 'content')
/**
 * 批 5：分组子菜单改为**点击展开并保持**
 *
 * 用户口径：悬停展开、移出即收太难用（手一抖就没了）；改成点一下展开、再点一下收起，
 * 同一时刻只展开一组。键带目标 id，同名的组在不同目标下互不影响。
 */
const openGroup = ref<string>('')

function groupKey(targetId: string, group: string): string {
  return `${targetId}:${group}`
}

function toggleGroup(key: string): void {
  openGroup.value = openGroup.value === key ? '' : key
}

/** 菜单关掉时把展开态一并收掉，下次右键从收起开始 */
watch(open, (value) => {
  if (!value) openGroup.value = ''
})

const actionGroups = [
  '射击',
  '空军任务',
  '模式改变',
  '移动',
  '运输',
  '工程',
  '编组',
  '补给',
  '空军',
] as const

/**
 * 战斗进行到哪一步（null＝盘面上没有**进行中**的战斗）
 *
 * ★ 2026-09-18 修：原先取 `combatState?.step`，**不看 `finished`** ⇒ 战斗已收束后
 *   推进块与「确认推进并收束」仍挂在地图上（再点只是幂等地重跑一遍，界面无变化）。
 *   判据已上移到 store（`combatLiveStep`），本组件只读它，不自己判"算不算进行中"。
 */
const step = computed(() => workbench.combatLiveStep)

/** 该令牌对应的盘面算子（用来读「有无印刷轰炸值」等，界面只读不算规则） */
function consoleUnitOf(id: string): ConsoleUnit | null {
  return workbench.units.find((unit) => unit.instanceId === id) ?? null
}

/** 该令牌的算子图 URL（栏内「图阵列」用；无图则回退 null，界面只显示文字） */
function counterImageOf(id: string): string | null {
  const unit = consoleUnitOf(id)
  const aircraft = workbench.onMapAirUnits.find((item) => item.instanceId === id)
  return unit === null
    ? aircraft === undefined
      ? null
      : counterImageUrlOf(aircraft)
    : counterImageUrlOf(unit)
}

/**
 * 左键堆叠窗**列全**（用户 2026-11-10）：该格可见的地面令牌全部摆出来
 *
 * 4.9a 已把敌方内容裁到「可见」；这里不再按「本环节参与」或「战斗单位」二次过滤
 * —— 否则玩家会看见一个缺了几枚的堆叠。能不能点，由 `chipPickable` 单独判。
 */
const stackUnits = computed(() => content.value?.units ?? [])

/**
 * 13.2g：**编内卡车**与所属编队的关系（窗口里要看得出它跟着谁）
 *
 * 原文：「多单位编队有时拥有特殊的附属运输点数。编内卡车**与其他运输点数基本一样**，
 * 但有几点例外……」⇒ 它就是运输点数（可单独选中/移动），只是在窗口里额外标出**随行**的归属，
 * 免得玩家以为它是一支独立编队。没有 `formation` 时给「编队」占位。
 */
function truckFormationOf(id: string): string | null {
  const unit = consoleUnitOf(id)
  if (unit === null || unit.noncombatKind !== 'organic_truck') return null
  return unit.formation === null || unit.formation === '' ? '编队' : unit.formation
}

/**
 * 用户 2026-11-11：堆叠窗**只留算子图**，名字与印值不再平铺成一行（与算子图重复）
 *
 * 图上没有的信息（DG / 已动完 / 编内卡车随行）只进悬停提示与角标，不占一行文字。
 */
function chipTitle(
  unit: { label: string; modeLetter: string; dg: boolean; ended: boolean },
  id: string,
): string {
  const parts = [unit.label, unit.modeLetter === '' ? null : `模式 ${unit.modeLetter}`]
  if (unit.dg) parts.push('DG')
  if (unit.ended) parts.push('本回合已动完')
  const formation = truckFormationOf(id)
  if (formation !== null) parts.push(`随 ${formation}`)
  return parts.filter((part): part is string => part !== null).join(' · ')
}

/** 同格本方飞机（只读；操作走空军面板） */
const stackAircraft = computed(() => content.value?.airUnits ?? [])

/**
 * 用户 2026-11-18：**飞机堆叠窗**
 *
 * 点空军基地 / 整备段点格 / 该格只有飞机时，窗口只摆飞机（地面栏不重复列）；
 * 地面堆叠窗（点空白 >4 枚）照旧只摆地面 + 飞机 chip 作为附带入口。
 */
const airFocus = computed(() => mapView.popup?.airFocus === true)
const groundChips = computed(() => (airFocus.value ? [] : stackUnits.value))

/** 飞机 chip 可选中（整备段走 15.1 的复选框，避免两套勾选） */
function airPickable(): boolean {
  return workbench.phase !== 'aircraftRefit'
}

/** 飞机 chip 选中态＝14.2 的任务飞机名单（与地图上的金环同源） */
function airSelected(id: string): boolean {
  return workbench.airMissionAirIds.includes(id)
}

function toggleAirChip(id: string): void {
  if (!airPickable()) return
  mapView.selectStackChip(id)
}

/** 6.1 取子池：只有这些 chip 能点选（敌方 / 非战斗 / 补员算子照列不可点） */
const movableIds = computed(() => new Set(workbench.movePickChoices.map((unit) => unit.instanceId)))

/**
 * 批 F（用户 2026-11-16）：堆叠栏里**直接点选单位**
 *
 * 取子格上仍以 6.1 的可开拔池为准；其他时候按 store 的 `selectableIds`（本方）——
 * 敌方令牌是 4.9a 的目标，照列但不可选。
 */
function chipPickable(id: string): boolean {
  if (isMovePickHex.value) return movableIds.value.has(id)
  return (content.value?.selectableIds ?? []).includes(id)
}

/** 6.1：堆叠取子清单的已勾选 id（界面用；`movePick` 为空时给空数组，避免模板里做空值断言） */
const movePickIds = computed<string[]>(() => workbench.movePick?.ids ?? [])

/** 6.1f：仍在走的单位（"放下堆叠单位"的唯一入口在移动面板的移动编组里） */
const activeMovingUnits = computed(() => workbench.activeMoveUnits)

/** 6.1：小窗这一格是否正是待取子的堆叠格 ⇒ chip 直接驱动 `movePick` */
const isMovePickHex = computed(() => {
  const hex = mapView.popup?.hex
  const pickHex = workbench.movePickHex
  if (hex === undefined || pickHex === null) return false
  return hex.col === pickHex.col && hex.row === pickHex.row
})

/** chip 选中态：待取子格读 `movePick.ids`，其它窗读地图共用的 `stackSelection` */
function chipSelected(id: string): boolean {
  if (!chipPickable(id)) return false
  return isMovePickHex.value ? movePickIds.value.includes(id) : mapView.stackSelection.includes(id)
}

/**
 * 用户 2026-11-09 原在此给「开始移动」；2026-11-11 收口为**单入口**：
 * 开拔（取子 → 开始移动）只在移动会话框（`MovePanel` 的 `move:pick` 门）里落地，
 * 本堆叠窗只负责勾选，不再摆第二个「开始移动」。
 */

/**
 * 用户 2026-11-09：堆叠窗内右键**这一枚** ⇒ 该单位自己的菜单（只影响这一枚）
 *
 * 与地图右键分工：那边按选中集出一份共用菜单，这里只认这一枚。
 */
function onChipContext(event: MouseEvent, unitId: string): void {
  const hex = mapView.popup?.hex
  if (hex === undefined) return
  // 批 F：右键落在多选集合里 ⇒ 共用菜单（交集）；否则这一枚自己的菜单
  mapView.openStackChipContext(hex, unitId, { x: event.clientX, y: event.clientY })
}

/** 点 chip＝切换该枚选中（取子格同步 6.1；其它格同步地图选中集） */
function toggleChip(id: string): void {
  if (!chipPickable(id)) return
  if (isMovePickHex.value) {
    workbench.toggleMovePick(id)
    return
  }
  mapView.selectStackChip(id)
}

/* ── 15.1 整备（用户口径：点机场的整备按钮 → 勾选飞机 → 点地图上高亮的补给付款） ── */

/** 该格上的**本方**空军基地（null = 不是本方基地格） */
const baseAtHex = computed(() => {
  const hex = mapView.popup?.hex
  if (hex === undefined) return null
  return (
    workbench.ownAirBases.find((base) => base.hex.col === hex.col && base.hex.row === hex.row) ??
    null
  )
})

/** 这一格是否正是「正在整备」的那个基地（是 ⇒ 显示勾选清单） */
const refitHere = computed(
  () => baseAtHex.value !== null && workbench.refitBase?.id === baseAtHex.value.id,
)

/** 该基地本阶段是否已整备过（15.1A：每基地每整备阶段一次） */
const refitDoneHere = computed(
  () =>
    baseAtHex.value !== null &&
    workbench.refitDoneBases.some((base) => base.id === baseAtHex.value?.id),
)

/**
 * 这一格的基地**此刻真能整备**（15.1B 容量 / 15.1C ZOC / 14.2a 堆叠 / 12.3a 付款来源）
 *
 * 判据只有一处：`workbench.refitStartBases`。修前只要在 A 段就摆「整备」按钮，
 * 点了才被 `beginRefitNow` 拒（回执只在日志里）——等于给了一个走不通的入口。
 */
const refitAllowedHere = computed(
  () =>
    baseAtHex.value !== null &&
    workbench.refitStartBases.some((base) => base.id === baseAtHex.value?.id),
)

/** 这一格是否正是「正在转场」的出发基地（14.11） */
const transferHere = computed(
  () => baseAtHex.value !== null && workbench.transferBase?.id === baseAtHex.value.id,
)

/** 整备块是否出现（点基地格且本环节允许 15.1） */
const refitBlockVisible = computed(
  () => baseAtHex.value !== null && workbench.actionAllowedNow('air.refit'),
)

/* ── 9.14 特殊战斗：待决的位移与运输点分配 ── */
/** 9.14 待决（null＝没有待决） */
const special = computed(() => workbench.specialPending)
/** 正在选落点的那一项（9.14c 运输点 / 9.14d 延补队） */
const specialItem = computed(() => mapView.specialItem)

/** 9.14 待夺取的运输点算子（各分组摊平，只为排图；`exact` 决定绿/红描边） */
const specialCounters = computed(() =>
  (special.value?.splits ?? []).flatMap((split) =>
    split.counters.map((counter) => ({
      ...counter,
      captured: split.capturedIds.includes(counter.id),
      exact: split.exact,
    })),
  ),
)

/**
 * `?` 的悬停补充（用户 2026-11-18 第 2 条）
 *
 * 9.14c 掷了多少、按表该夺几点 ⇒ 只放这里，窗内不出文字；即时结清结果走行动日志。
 */
const ruleDetail = computed<string>(() => {
  const splits = special.value?.splits ?? []
  return splits
    .map(
      (split) =>
        `掷 ${split.group.die} → ${split.group.percent}% · 按表夺取 ` +
        `${split.group.capturedPoints}/${split.group.totalPoints} 点`,
    )
    .join('；')
})

/**
 * 用户 2026-11-18：窗内**不再摆条款文字**，条款号一律收进标题右侧的 `?`
 *
 * 按当前窗里真正出现的块拼，避免把用不上的条款号也列出来。
 */
const ruleTags = computed<string>(() => {
  if (special.value !== null) return '9.14'
  const rules: string[] = []
  if (activeMovingUnits.value.length > 0) rules.push('8.1g / 8.1h')
  if (refitBlockVisible.value) rules.push('15.1')
  if (transferHere.value) rules.push('14.11 / 1.4a')
  return rules.length === 0 ? '4.9a' : rules.join(' · ')
})

/* ── 动作（全部转发给既有 store 动作，不新增业务规则） ── */
</script>

<template>
  <!-- 条 25（D2 修订）：只读格号浮签已删除（格号改由地图悬停提示给） -->
  <MapPopover
    v-if="variant === 'context'"
    :open="open"
    :x="anchor.x"
    :y="anchor.y"
    :title="`${title} · 操作`"
    :bounds="mapArea"
    width="292px"
    class="popover--menu"
    @close="mapView.closePopup()"
  >
    <section v-for="target in mapView.contextOptions" :key="target.id" class="context-target">
      <h4 class="block__title">{{ target.label }}</h4>
      <!--
        用户 2026-11-09：右键菜单改为**多级**——一级只摆分组入口，展开后在右侧列该组叶子，
        免得一个堆叠把所有能力平铺成一条长列表。组内没有动作时整组不渲染（沿用原来 v-if 的语义）。
        批 5：展开方式由 hover 改为**点击并保持**（再点收起；同屏只展开一组）。
      -->
      <template v-for="group in actionGroups" :key="group">
        <div
          v-if="target.actions.some((item) => item.group === group && item.disabledReason === null)"
          class="context-group"
        >
          <button
            type="button"
            class="context-group__trigger"
            :class="{ 'context-group__trigger--open': openGroup === groupKey(target.id, group) }"
            :aria-expanded="openGroup === groupKey(target.id, group)"
            @click="toggleGroup(groupKey(target.id, group))"
          >
            <span>{{ group }}</span>
            <BaseIcon
              :name="openGroup === groupKey(target.id, group) ? 'chevron-down' : 'chevron-right'"
            />
          </button>
          <div v-if="openGroup === groupKey(target.id, group)" class="context-group__submenu">
            <BaseButton
              v-for="item in target.actions.filter(
                (action) => action.group === group && action.disabledReason === null,
              )"
              :key="item.key"
              variant="ghost"
              size="sm"
              class="context-action"
              :title="item.rule"
              @click="mapView.openContextAction(target.id, item.key)"
            >
              <span>{{ item.label }}</span>
            </BaseButton>
          </div>
        </div>
      </template>
    </section>
  </MapPopover>
  <MapPopover
    v-else
    :open="open"
    :x="anchor.x"
    :y="anchor.y"
    :title="title"
    :rule="ruleTags"
    :rule-note="ruleDetail"
    :bounds="mapArea"
    width="330px"
    @close="mapView.closePopup()"
  >
    <!-- ⓪ 9.14 特殊战斗：进入敌方设施格后的夺取与**位移落点选择**（优先级最高——必须收束的待决） -->
    <section v-if="special !== null" class="block block--special">
      <!-- 9.14c：运输点组「哪些被夺取」由拥有者决定（混合类型时）；点算子＝切换夺取 -->
      <div v-if="specialCounters.length > 0" class="chips">
        <div
          v-for="counter in specialCounters"
          :key="counter.id"
          class="chip chip--pickable"
          :class="{
            'chip--on': counter.captured,
            'chip--ok': counter.exact,
            'chip--bad': !counter.exact,
          }"
          role="button"
          tabindex="0"
          :aria-pressed="counter.captured"
          :title="`${counter.label} · ${counter.points} 点`"
          @click="workbench.toggleSpecialCaptured(counter.id)"
          @keydown.enter.prevent="workbench.toggleSpecialCaptured(counter.id)"
          @keydown.space.prevent="workbench.toggleSpecialCaptured(counter.id)"
        >
          <img
            v-if="counterImageOf(counter.id) !== null"
            :src="counterImageOf(counter.id) ?? ''"
            class="chip__img"
            alt=""
          />
          <span class="chip__badge num">{{ counter.points }}</span>
        </div>
      </div>

      <!-- 9.14c/d：位移落点在地图上点选；点算子＝选它，角标＝已选落点 -->
      <div v-if="special.items.length > 0" class="chips">
        <div
          v-for="item in special.items"
          :key="item.unitId"
          class="chip chip--pickable"
          :class="{ 'chip--on': item.unitId === specialItem?.unitId }"
          role="button"
          tabindex="0"
          :aria-pressed="item.unitId === specialItem?.unitId"
          :title="`${item.label} · ${item.kind === 'extender' ? '崩溃' : '转移'}`"
          @click="mapView.setSpecialUnit(item.unitId)"
          @keydown.enter.prevent="mapView.setSpecialUnit(item.unitId)"
          @keydown.space.prevent="mapView.setSpecialUnit(item.unitId)"
        >
          <img
            v-if="counterImageOf(item.unitId) !== null"
            :src="counterImageOf(item.unitId) ?? ''"
            class="chip__img"
            alt=""
          />
          <span class="chip__badge num">{{
            item.chosen === null ? '—' : hexLabel(item.chosen)
          }}</span>
        </div>
      </div>

      <div class="row">
        <BaseButton
          variant="primary"
          size="sm"
          title="9.14"
          @click="workbench.confirmSpecialCombatNow()"
        >
          确认位移与分配
        </BaseButton>
        <BaseButton variant="ghost" size="sm" @click="workbench.cancelSpecialCombatNow()">
          取消待决
        </BaseButton>
      </div>
    </section>

    <!-- ② 9.12g 推进已收回 `CombatPanel`（用户 2026-11-12 第二批）：本窗不再承担推进的勾选与确认 -->

    <!-- 无战斗流程：只摆战斗单位 + 操作按钮（不写说明文字） -->
    <template v-if="step === null">
      <!--
        6.1f 放下堆叠单位：唯一入口在 `MovePanel` 的「移动编组」里（用户 2026-11-14 裁定）：
        本窗不再列同名按钮，同一件事只留一处。
      -->

      <!-- 8.1g/h：突袭的参突/留驻拆分（点算子＝切换；不点＝仍在移动的全部单位都参突） -->
      <section v-if="activeMovingUnits.length > 0" class="block block--pick">
        <div class="chips">
          <div
            v-for="unit in activeMovingUnits"
            :key="unit.instanceId"
            class="chip chip--pickable"
            :class="{ 'chip--off': !workbench.overrunParticipantIds.includes(unit.instanceId) }"
            role="button"
            tabindex="0"
            :aria-pressed="workbench.overrunParticipantIds.includes(unit.instanceId)"
            :title="`${unit.name} @ ${hexLabel(unit.hex)} · ${unit.re} RE`"
            @click="workbench.toggleOverrunParticipant(unit.instanceId)"
            @keydown.enter.prevent="workbench.toggleOverrunParticipant(unit.instanceId)"
            @keydown.space.prevent="workbench.toggleOverrunParticipant(unit.instanceId)"
          >
            <img
              v-if="counterImageOf(unit.instanceId) !== null"
              :src="counterImageOf(unit.instanceId) ?? ''"
              class="chip__img"
              alt=""
            />
          </div>
        </div>
      </section>

      <!--
        左键堆叠窗（用户 2026-11-10）：**列全 + 默认全选 + 地图同格展开 + 删说明文字**。
        窗内只摆该格可见算子（地面全部 + 本方飞机）与操作按钮，不写规则解释；
        选中集只有一份＝`workbench.movePick`，可点者仅限 6.1 可开拔池里的本方算子。
      -->
      <section v-if="groundChips.length > 0 || stackAircraft.length > 0" class="block">
        <div class="chips">
          <div
            v-for="unit in groundChips"
            :key="unit.id"
            class="chip"
            :class="{
              'chip--pickable': chipPickable(unit.id),
              'chip--off': chipPickable(unit.id) && !chipSelected(unit.id),
            }"
            :role="chipPickable(unit.id) ? 'button' : undefined"
            :tabindex="chipPickable(unit.id) ? 0 : undefined"
            :aria-pressed="chipPickable(unit.id) ? chipSelected(unit.id) : undefined"
            :title="chipTitle(unit, unit.id)"
            @click="toggleChip(unit.id)"
            @contextmenu.prevent.stop="onChipContext($event, unit.id)"
            @keydown.enter.prevent="toggleChip(unit.id)"
            @keydown.space.prevent="toggleChip(unit.id)"
          >
            <img
              v-if="counterImageOf(unit.id) !== null"
              :src="counterImageOf(unit.id) ?? ''"
              class="chip__img"
              alt=""
            />
            <!-- 用户 2026-11-11：图上没有的状态只作角标，不再平铺成一行文字 -->
            <span v-if="unit.dg" class="chip__flag chip__flag--dg">DG</span>
            <span v-if="unit.ended" class="chip__flag">停</span>
          </div>
          <div
            v-for="air in stackAircraft"
            :key="air.instanceId"
            class="chip"
            :class="{
              'chip--pickable': airPickable(),
              'chip--off': airPickable() && !airSelected(air.instanceId),
            }"
            :role="airPickable() ? 'button' : undefined"
            :tabindex="airPickable() ? 0 : undefined"
            :aria-pressed="airPickable() ? airSelected(air.instanceId) : undefined"
            :title="air.name"
            @click="toggleAirChip(air.instanceId)"
            @contextmenu.prevent.stop="onChipContext($event, air.instanceId)"
            @keydown.enter.prevent="toggleAirChip(air.instanceId)"
            @keydown.space.prevent="toggleAirChip(air.instanceId)"
          >
            <img
              v-if="counterImageOf(air.instanceId) !== null"
              :src="counterImageOf(air.instanceId) ?? ''"
              class="chip__img"
              alt=""
            />
          </div>
        </div>
      </section>

      <!-- 15.1 整备：点机场的「整备」按钮 → 勾选飞机 → 点地图上高亮的补给付款 -->
      <section
        v-if="baseAtHex !== null && refitBlockVisible && !refitDoneHere && refitAllowedHere"
        class="block block--pick"
      >
        <template v-if="!refitHere">
          <BaseButton
            variant="primary"
            size="sm"
            title="15.1"
            @click="workbench.beginRefitNow(baseAtHex.id)"
          >
            整备
          </BaseButton>
        </template>

        <!-- 用户 2026-11-12：勾机 →「确认整备」→ 高亮补给站 → 点站 →「确认支付」 -->
        <template v-else>
          <template v-if="workbench.refitStage === 'select'">
            <div v-if="workbench.refitCandidates.length > 0" class="chips">
              <div
                v-for="air in workbench.refitCandidates"
                :key="air.instanceId"
                class="chip chip--pickable"
                :class="{ 'chip--off': !workbench.refitSelectedIds.includes(air.instanceId) }"
                role="button"
                tabindex="0"
                :aria-pressed="workbench.refitSelectedIds.includes(air.instanceId)"
                :title="air.name"
                @click="workbench.toggleRefitAircraft(air.instanceId)"
                @keydown.enter.prevent="workbench.toggleRefitAircraft(air.instanceId)"
                @keydown.space.prevent="workbench.toggleRefitAircraft(air.instanceId)"
              >
                <img
                  v-if="counterImageOf(air.instanceId) !== null"
                  :src="counterImageOf(air.instanceId) ?? ''"
                  class="chip__img"
                  alt=""
                />
              </div>
            </div>
            <BaseButton
              v-if="workbench.refitSelectedIds.length > 0"
              variant="primary"
              size="sm"
              @click="workbench.confirmRefitSelectionNow()"
            >
              确认整备
            </BaseButton>
          </template>
          <template v-else>
            <BaseButton
              v-if="workbench.refitStage === 'pay' && workbench.airInputs.refitDumpId !== null"
              variant="primary"
              size="sm"
              @click="workbench.confirmRefitPaymentNow()"
            >
              确认支付
            </BaseButton>
          </template>
          <BaseButton variant="ghost" size="sm" @click="workbench.cancelRefitNow()">
            取消整备
          </BaseButton>
        </template>
      </section>

      <!-- 用户 2026-11-12：14.11 转场——勾机 → 进入图外盒 / 选目的基地（点格放置） -->
      <section
        v-if="transferHere && workbench.transferCandidates.length > 0"
        class="block block--pick"
      >
        <div class="chips">
          <div
            v-for="air in workbench.transferCandidates"
            :key="air.instanceId"
            class="chip chip--pickable"
            :class="{ 'chip--off': !workbench.transferSelectedIds.includes(air.instanceId) }"
            role="button"
            tabindex="0"
            :aria-pressed="workbench.transferSelectedIds.includes(air.instanceId)"
            :title="air.name"
            @click="workbench.toggleTransferAircraft(air.instanceId)"
            @keydown.enter.prevent="workbench.toggleTransferAircraft(air.instanceId)"
            @keydown.space.prevent="workbench.toggleTransferAircraft(air.instanceId)"
          >
            <img
              v-if="counterImageOf(air.instanceId) !== null"
              :src="counterImageOf(air.instanceId) ?? ''"
              class="chip__img"
              alt=""
            />
            <span class="chip__badge num">{{ air.rangeHexes }}</span>
          </div>
        </div>
        <template v-if="workbench.transferMode === 'box'">
          <BaseButton
            v-if="workbench.transferBoxReady"
            variant="primary"
            size="sm"
            title="1.4a"
            @click="mapView.confirmTransferToBoxNow()"
          >
            确认移入图外盒
          </BaseButton>
        </template>
        <template v-else>
          <BaseButton
            v-if="workbench.transferSelectedIds.length > 0"
            variant="primary"
            size="sm"
            title="14.11"
            @click="mapView.beginTransferBasePickNow()"
          >
            选择目的基地
          </BaseButton>
        </template>
        <BaseButton variant="ghost" size="sm" @click="workbench.cancelTransferNow()">
          取消转场
        </BaseButton>
      </section>
    </template>
  </MapPopover>
</template>

<style scoped>
.context-target + .context-target {
  margin-top: var(--space-2);
  border-top: 1px solid var(--color-rule);
  padding-top: var(--space-2);
}

.block__row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-1);
}

/*
 * 多级右键菜单：一级＝分组入口，右侧子菜单默认收起，悬停/聚焦才展开。
 * 子菜单是绝对定位的浮层 ⇒ 需要 MapPopover 的 `popover--menu` 放行溢出（见那边注释）。
 */
.context-group {
  position: relative;
}

.context-group__trigger {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-muted);
  font-size: var(--text-xs);
  text-align: left;
  user-select: none;
  cursor: pointer;
}

.context-group__trigger:hover,
.context-group__trigger--open {
  color: var(--color-ink);
  background: var(--color-bg-2);
}

.context-group__submenu {
  position: absolute;
  left: 100%;
  top: 0;
  min-width: 220px;
  padding: var(--space-1);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-panel);
  box-shadow: var(--shadow-lg);
  z-index: 1;
}

.context-action {
  display: grid;
  width: 100%;
  grid-template-columns: 1fr auto;
  text-align: left;
}

.context-reason {
  grid-column: 1 / -1;
  color: var(--color-muted);
}

.block {
  margin: var(--space-2) 0;
}

/* 9.14 特殊战斗：待决须醒目（它是必须收束的选择） */
.block--special {
  padding: var(--space-2);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
}

/* 6.1 堆叠取子：必须醒目（不定完就不能开拔） */
.block--pick {
  padding: var(--space-2);
  border: 1px solid var(--color-accent-2);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
}

.sub {
  margin: var(--space-2) 0;
}

.sub__title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-muted);
}

.block__title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-xs);
  letter-spacing: 0.04em;
  color: var(--color-gold);
}

.list {
  list-style: none;
  margin: 0 0 var(--space-2);
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-muted);
}

/* 条 7（R3）：堆叠分战斗 / 非战斗两栏（栏内图阵列） */
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
  margin: var(--space-1) 0;
}

.col {
  min-width: 0;
}

.col__title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-xs);
  letter-spacing: 0.04em;
  color: var(--color-gold);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  border: 1px solid var(--color-border, #3a342b);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
}

.chip__img {
  width: 34px;
  height: 34px;
  object-fit: contain;
  flex: 0 0 auto;
}

/* 图上没有的状态：只作角标（DG / 停），不占一行文字 */
.chip__flag {
  position: absolute;
  right: 0;
  bottom: 0;
  padding: 0 2px;
  border-radius: var(--radius-sm);
  background: var(--color-ink);
  color: var(--color-panel);
  font-size: var(--text-xs);
  line-height: 12px;
  pointer-events: none;
}

.chip__flag--dg {
  top: 0;
  bottom: auto;
  color: var(--color-warning);
}

/* 左键堆叠窗：点枚切换选中（默认全选）；未选者压暗，不做额外说明 */
.chip--pickable {
  cursor: pointer;
  user-select: none;
}

.chip--off {
  opacity: 0.45;
}

/* 选中态（9.14 夺取 / 位移落点 / 参突 / 整备 / 转场）：只描边，不加文字 */
.chip--on {
  outline: 1px solid var(--color-command-teal);
  outline-offset: -1px;
}

/*
 * 9.14c 是否精确夺取（用户 2026-11-18 第 3 条）：只给描边，不写字
 *   绿＝按表精确成立；红＝不成立（多夺/少夺由日志说明，窗内不重复）
 */
.chip--ok {
  box-shadow: 0 0 0 2px var(--color-accent-2) inset;
}

.chip--bad {
  box-shadow: 0 0 0 2px var(--color-accent) inset;
}

/* 图上没有的计算值（点数 / 航程数 / 落点坐标）＝角标，不占文字行 */
.chip__badge {
  position: absolute;
  right: 0;
  bottom: 0;
  padding: 0 3px;
  border-radius: var(--radius-sm);
  background: var(--color-ink);
  color: var(--color-panel);
  font-size: var(--text-xs);
  line-height: 12px;
  pointer-events: none;
}

.chip--pickable:focus-visible {
  outline: 1px solid var(--color-command-teal);
  outline-offset: 1px;
}

.list__row--active {
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.field {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-muted);
}

.num-input {
  width: 52px;
}

.select {
  max-width: 168px;
}

.check {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-muted);
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-xs);
  margin: var(--space-1) 0;
}

.ok {
  color: var(--color-accent-2);
  font-size: var(--text-xs);
  margin: var(--space-1) 0;
}

.bad {
  color: var(--color-accent);
  font-size: var(--text-xs);
}
</style>
