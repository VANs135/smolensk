<script setup lang="ts">
import { computed, ref } from 'vue'

import { useRefereeTools } from '@/components/ui-mode'
import { BaseButton, BasePanel, BaseTag } from '@/components/base'
import UiField from '@/components/UiField.vue'
import { useUiMode } from '@/components/ui-mode'
import { formations } from '@/data'
import type { Side } from '@/data'
import type { BoxView, ScenarioDrawBoxView } from '@/engine/rules'
import { useContainersStore, useWorkbenchStore, counterImageUrlOf } from '@/stores'

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

/** 条 24 / §5-F：正式界面把「手输」收敛为只读（验证页仍可手输） */
const uiMode = useUiMode()
const workbench = useWorkbenchStore()

/** 返场落点（死亡堆 → 图；13.5a / 1.6c 的落点规则见 2.1 / 3.1） */
/** 拆分单位取用：母单位与档位 */
const breakdownParentId = ref('')
const breakdownAr = ref(4)
/** 条 24：AR 档改用**点选**（0–5），正式界面无需手输；具体合法性仍由引擎在提交时判 */
const BREAKDOWN_AR_LEVELS = [0, 1, 2, 3, 4, 5]
/** 剧本抽签：当前组下标（每组一边抽签一边落盘） */
const drawGroupIndex = ref(0)
/** 编队抽签落盘的组成事实（编队 id → Mtr/Aufk/Krd 单位 id） */
// ★ I②：组成由 store 自动推（containers.drawCompositionNoteOf），不再有玩家手输 unit id 的文本框
/** 边缘盒进出：目标单位与「在边缘补给源格」声明 */
const edgeUnitId = ref('')
const edgeFromSource = ref(true)
const edgeUseRailCap = ref(false)
/** 编队收纳盒：编队、成员、图上成员、标记格、本次收纳 */
const formationId = ref('')
const formationMembersText = ref('')
const formationOnMapText = ref('')
const formationHideText = ref('')
/** 空军盒：要移入盒的飞机 */
const airUnitId = ref('')

/** 盒的总览（顺序即引擎给出：死亡堆 → 拆分盒 → 特殊补员盒 → 空军盒（双方）→ 边缘盒 → 剧本盒 → 编队盒） */
const boxes = computed<readonly BoxView[]>(() => containers.boxes)

/** 剧本抽取盒（`BoxView` 是平铺接口，富字段用窄化取回；见引擎的 ScenarioDrawBoxView） */
const scenarioBox = computed<ScenarioDrawBoxView | null>(() => {
  const view = boxes.value.find((box) => box.kind === 'scenarioDrawBox')
  return (view as ScenarioDrawBoxView | undefined) ?? null
})

/** 当前抽取组（越界即第一组） */
const drawGroup = computed(() => scenarioBox.value?.groups[drawGroupIndex.value] ?? null)

/** 已抽中的名单（当前组） */
const drawn = computed(() => (drawGroup.value === null ? [] : containers.drawnOf(drawGroup.value)))

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

/** 特殊补员盒：当日是否仍可抽取（19 August 起停止） */
function specialActiveOf(box: BoxView): boolean {
  const view = box as { active?: boolean }
  return view.active === true
}

/**
 * ★ 专规 1.6c 的**时机**：能不能抽，要过**两道闸**（各管一件事，不互相替代）
 *
 *   ① **环节闸** `actionAllowedNow('rein.specialRepl')` —— 只在本方 **B 增援段的
 *      「特殊补员抽取」这一环**（原文「Each turn … the players also get to roll a die on their
 *      Special Repl Table」；13.6b 的掷表同样在本方增援阶段）；
 *   ② **日期闸** `specialActiveOf(box)` —— **19 August 起停止**（盒的 `active` 旗标来自
 *      `isSpecialReplAvailable`）。
 *
 * 不放行时给一句**明说**（不静默灰按钮）：玩家看得到"为什么现在不能抽、该去哪一环"。
 */
function specialReplRefusal(box: BoxView): string | null {
  if (!workbench.actionAllowedNow('rein.specialRepl')) {
    return '现在不能抽：1.6c 只发在「B 增援 → 特殊补员抽取」这一环'
  }
  if (!specialActiveOf(box)) return '19 August 起停止特殊补员（专规 1.6c）'
  return null
}

/** 特殊补员盒：抽取项说明（表 1-3 原文） */
function itemsOf(box: BoxView): string[] {
  const view = box as { items?: readonly string[] }
  return [...(view.items ?? [])]
}

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
    .filter((air) => !containers.airBoxMembers.includes(air.instanceId))
    .map((air) => ({ id: air.instanceId, label: `${air.name}（${sideName(air.side)}）` })),
)

/** 可选母单位（图上、且非拆分单位本身） */
const parentCandidates = computed(() =>
  workbench.units
    .filter((unit) => !unit.specialized.includes('breakdown'))
    .map((unit) => ({
      id: unit.instanceId,
      label: `${unit.name}（${sideName(unit.side)}｜AR${unit.faces.combat.ar}｜${unit.steps}/${unit.printedSteps}）`,
    })),
)

/** 可选编队（多单位编队库，13.7） */
const formationChoices = computed(() =>
  formations.formations.map((item) => ({
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

/**
 * I②（用户 2026-09-18 报告第 5 条）：**组成由 store 自动推**（从初设索引），面板只落盘
 *
 * 修前这里是"把玩家输入的 unit id 文本切成 mtr/aufk/krd"——玩家不可能知道那些 id，
 * 于是抽签落盘必被引擎按 `swapUnitsMissing` / `moveModeUnitIdsMissing` 拒（＝"没有实现"）。
 * 现在：`containers.applyDraw(group)` 缺 facts 时自动推（判据在引擎 `deriveDrawComposition`）。
 */
function applyDrawNow(): boolean {
  const group = drawGroup.value
  if (group === null) return false
  return containers.applyDraw(group, {})
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
const props = withDefaults(defineProps<{ only?: 'info' | 'actions' | null }>(), { only: null })

/**
 * C-1：**某个盒的动作段是否该显示**（判据＝当前展开卡覆盖的 `boxKind`）
 *
 *   · 本实例不画动作段（`only="info"`）⇒ false；
 *   · 没有展开卡（`openCardBoxKinds === null`，验证页/右栏）⇒ true（不过滤，照旧全给，供核对）；
 *   · 展开了卡 ⇒ **只**给该卡覆盖的盒类型（展开空军盒不再列出死亡堆的动作）。
 */
function showsBoxActions(kind: string): boolean {
  if (!showsActions.value) return false
  const kinds = containers.openCardBoxKinds
  return kinds === null || kinds.includes(kind)
}

/** 本实例是否要画"只读信息"那一段 */
const showsInfo = computed(() => props.only === null || props.only === 'info')
/** 本实例是否要画"动作"那一段 */
const showsActions = computed(() => props.only === null || props.only === 'actions')

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
</script>

<template>
  <BasePanel title="记录轨与容器（W7 C12：回合轨 · 天气轨 · 铁路容量轨 · 死亡堆 · 各类盒）">
    <p v-if="showsInfo" class="muted">
      轨与盒的**名册与判定**全部来自引擎（`engine/rules/containers.ts`），本面板只画表与收点击。
      每个盒都带 **美工接口**（`artwork`）：有图即渲染图，无图渲染纯文字盒；数据缺口（如 2.3a 的
      Alarm 单位未在单位库标注、剧本原文未列出被抽中的编队）在盒上**如实标出**，不猜。
    </p>

    <!-- ── ① 记录轨 ── -->
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

    <!-- ── ② 盒 ── -->
    <hr />
    <h4 class="block-title">容器（{{ boxes.length }} 个盒）</h4>

    <details v-for="box in boxes" :key="box.id" class="box" open>
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
      <div class="box__art">
        <img v-if="box.artwork?.imageKey" class="box__img" :src="box.artwork.imageKey" alt="盒图" />
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
          >
            {{ holding.name ?? holding.unitId }}
            <span v-if="holding.note !== undefined" class="muted">（{{ holding.note }}）</span>
            <!-- 死亡堆：返场 / 永久移除（13.5 / 1.6c / 13.5c）—— B17a-2：动作进会话框 -->
            <template v-if="showsBoxActions('deadPile')">
              <BaseButton
                variant="ghost"
                size="sm"
                @click="
                  workbench.returnFromDeadPileNow({
                    instanceId: holding.unitId,
                    hexText: workbench.deadPileReturnHexText,
                  })
                "
              >
                返场到 {{ workbench.deadPileReturnHexText || '（点地图选格）' }}
              </BaseButton>
              <BaseButton
                variant="ghost"
                size="sm"
                @click="workbench.removeForeverNow(holding.unitId)"
              >
                永久移除（13.5c）
              </BaseButton>
            </template>
            <!-- 边缘盒：离开（1.4b） -->
            <template v-if="showsBoxActions('edgeBox')">
              <BaseButton
                variant="ghost"
                size="sm"
                @click="
                  containers.moveEdgeBox({
                    box: box.id === 'edge-northeast' ? 'northeast' : 'southeast',
                    instanceId: holding.unitId,
                    direction: 'exit',
                    fromSupplySourceHex: edgeFromSource,
                    useRailCap: edgeUseRailCap,
                  })
                "
              >
                离箱入图（1.4b）
              </BaseButton>
            </template>
            <!-- 空军盒：移出（1.4a） -->
            <template v-if="showsBoxActions('airBox')">
              <BaseButton
                variant="ghost"
                size="sm"
                @click="containers.setAirInBox(holding.unitId, false)"
              >
                移出盒
              </BaseButton>
            </template>
          </li>
        </ul>
      </div>

      <!-- 要点与缺口 -->
      <p v-for="(note, index) in box.notes" :key="`n${index}`" class="muted">· {{ note }}</p>
      <p v-for="(gap, index) in box.dataGaps" :key="`g${index}`" class="warn">
        ⚠ 数据缺口：{{ gap }}
      </p>

      <!-- ── 各类盒的操作（B17a-2：动作段 ⇒ 只在会话框里画） ── -->
      <!-- 拆分单位盒（1.8a / 20.0a–g） -->
      <div v-if="showsBoxActions('breakdownBox')" class="row">
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
          AR 档
          <span class="row">
            <BaseButton
              v-for="ar in BREAKDOWN_AR_LEVELS"
              :key="ar"
              :variant="breakdownAr === ar ? 'primary' : 'secondary'"
              size="sm"
              @click="breakdownAr = ar"
            >
              AR{{ ar }}
            </BaseButton>
          </span>
        </label>
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="breakdownParentId === ''"
          @click="
            containers.takeBreakdown({
              parentInstanceId: breakdownParentId,
              breakdownAr,
              timing: 'startMove',
            })
          "
        >
          取用一枚（20.0a：开始移动时）
        </BaseButton>
      </div>

      <!-- 1.6c 特殊补员抽取盒（两道闸：环节 + 日期；不放行时明说原因） -->
      <div v-if="showsBoxActions('specialReplBox')" class="row">
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="specialReplRefusal(box) !== null"
          :title="specialReplRefusal(box) ?? undefined"
          @click="containers.drawSpecialRepl(box.side === 'soviet' ? 'soviet' : 'axis')"
        >
          掷骰抽取（1.6c，1 骰）
        </BaseButton>
        <span class="muted">抽取项：{{ itemsOf(box).join(' ／ ') }}</span>
        <span v-if="specialReplRefusal(box) !== null" class="muted num">
          {{ specialReplRefusal(box) }}
        </span>
      </div>

      <!-- 地图外空军盒（1.4a） -->
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
          航程 {{ rangeHexesOf(box) ?? '—' }} 格｜Active {{ airCountOf(box, 'active') }} / Inactive
          {{ airCountOf(box, 'inactive') }}｜可激活：{{
            activatableOf(box) ? '是（免费整备）' : '否'
          }}
        </span>
      </div>

      <!-- 边缘盒（1.4b） -->
      <div v-if="showsBoxActions('edgeBox')" class="row">
        <label class="field">
          入盒单位
          <select v-model="edgeUnitId" class="select">
            <option value="">（选择苏方地面单位）</option>
            <option v-for="item in parentCandidates" :key="item.id" :value="item.id">
              {{ item.label }}
            </option>
          </select>
        </label>
        <label class="field">
          <input v-model="edgeFromSource" type="checkbox" />
          在地图边缘补给源格（1.4b 必需）
        </label>
        <label class="field">
          <input v-model="edgeUseRailCap" type="checkbox" />
          改用铁路容量（1 点）
        </label>
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="edgeUnitId === ''"
          @click="
            containers.moveEdgeBox({
              box: box.id === 'edge-northeast' ? 'northeast' : 'southeast',
              instanceId: edgeUnitId,
              direction: 'enter',
              fromSupplySourceHex: edgeFromSource,
              useRailCap: edgeUseRailCap,
            })
          "
        >
          入盒（1.4b：进入即停）
        </BaseButton>
      </div>

      <!-- 编队收纳盒（13.7 / 3.6f） -->
      <div v-if="showsBoxActions('formationBox')" class="row">
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

    <!-- ── ③ 剧本抽取盒（编队抽签；池成员由 formations.json 推导） ──
         B17a-2：抽签与落盘都是**动作** ⇒ 只在会话框那一段里画
         ★ 2026-10-25：抽签已移到**初设自动执行**（`setup.runSetupDraws`）⇒ 这里的
           「抽签 / 落盘本组处置」是**裁判重抽的退路**，故再加一道 `showsReferee`（对局台不铺）。 -->
    <template v-if="showsReferee && showsBoxActions('scenarioDrawBox')">
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
          <label class="field">
            抽取组
            <select v-model.number="drawGroupIndex" class="select">
              <option v-for="(group, index) in scenarioBox.groups" :key="group.kind" :value="index">
                {{ group.label }}（抽 {{ group.count }}）
              </option>
            </select>
          </label>
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="drawGroup === null"
            @click="drawGroup !== null && containers.drawFormations(drawGroup, false)"
          >
            抽签（{{ drawGroup?.count ?? 0 }} 个）
          </BaseButton>
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="drawGroup === null"
            @click="drawGroup !== null && containers.drawFormations(drawGroup, true)"
          >
            抽签（'No Counterattack'：各 {{ scenarioBox.reducedCount ?? 2 }} 个）
          </BaseButton>
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="drawn.length === 0"
            @click="applyDrawNow()"
          >
            落盘本组处置
          </BaseButton>
        </div>
        <p class="num">
          抽中：<span v-if="drawn.length === 0">（尚未抽签）</span>
          <template v-else>{{ drawn.join('、') }}</template>
        </p>
        <div v-for="formation in drawn" :key="formation" class="row">
          <!--
            ★ I②（用户 2026-09-18 报告第 5 条）：**组成不再由玩家手输** ——
              原先这里是一个文本框（"按顺序：Mtr / Aufk / Krd"），而玩家不可能知道那些 unit id ⇒
              「编队抽取还是没有实现」。现在组成从 `scenario-setup.json` 的初设行**自动推**
              （判据在引擎 `deriveDrawComposition`），本处只把推出来的结果显示出来。
          -->
          <span class="num">
            {{ formation }} 组成（初设自动推）：{{ containers.drawCompositionNoteOf(formation) }}
          </span>
          <!--
            ★ 批 E 切片 2（用户 9.17③a）：ch10 的 A 组要求「抽中的师沿道路向**所列位置**西移三格」
              —— 那个位置原文是"沿道路从所列位置西移三格"算出来的，而道路拓扑数据未覆盖该区域 ⇒ 由玩家**点地图**给出（B27 通用待点格）。
              修前这个输入**根本不存在** ⇒ 剧本 1/2 的 A 组落盘必被引擎按
              `shiftWestDestinationMissing` 拒（即"抽取的编队变化落不到初设"的一半）。
          -->
          <BaseButton
            v-if="drawGroup?.kind === 'shiftWest'"
            variant="secondary"
            size="sm"
            @click="containers.beginDrawShiftHexPickNow(formation)"
          >
            点地图选西移落点（{{ containers.drawShiftHexOf(formation) ?? '未选' }}）
          </BaseButton>
        </div>
        <p class="muted">
          {{ scenarioBox.groups[drawGroupIndex]?.effect ?? '' }}
        </p>
        <!-- 落盘之后的台账：初设那边（`setup.formationDrawNotes`）读的就是它 -->
        <p
          v-for="outcome in containers.formationDrawOutcomes.filter(
            (row) => row.groupKind === drawGroup?.kind,
          )"
          :key="outcome.groupKind"
          class="ok num"
        >
          <BaseTag kind="success">已落盘</BaseTag>
          {{ outcome.detail
          }}<template v-if="outcome.destinations.length > 0">
            ｜西移落点：{{
              outcome.destinations.map((item) => `${item.formationId} → ${item.hexText}`).join('、')
            }}</template
          >
        </p>
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

    <!-- ── ⑤ 最近一次结论 ── -->
    <hr />
    <p v-if="containers.lastAction === null" class="muted">尚无操作。</p>
    <p v-else class="num">
      <BaseTag :kind="containers.lastAction.ok ? 'success' : 'danger'">
        {{ containers.lastAction.scope }}｜{{ containers.lastAction.rule }}
      </BaseTag>
      {{ containers.lastAction.detail }}
    </p>
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
      <label class="field">
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
        <span v-else class="ui-field-readonly">
          {{ (containers.alarmUnitIds ?? []).join(',') || '（数据默认）' }}
        </span>
      </label>
      <!-- 重置全部盒子＝裁判工具（会清掉名册），对局台不铺 -->
      <BaseButton
        v-if="showsReferee"
        variant="ghost"
        size="sm"
        @click="containers.resetContainers()"
        >重置盒账本</BaseButton
      >
    </div>
    <!-- 2.3a 混编上限（3 / 5 / 7，按算子类型计）：每型的上限 / 在场 / 余量 -->
    <ul v-if="containers.alarmMix.length > 0" class="mix">
      <li class="mix__head">{{ containers.alarmMixRule }} 混编上限（按算子类型计）</li>
      <li v-for="row in containers.alarmMix" :key="row.unitId">
        {{ row.unitId }}：在场 {{ row.inPlay }} / 上限 {{ row.limit }} ⇒ 余量 {{ row.remaining
        }}<span v-if="row.over" class="over">★ 超编</span>
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

.box__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  cursor: pointer;
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
