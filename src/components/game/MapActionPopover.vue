<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BaseTag } from '@/components/base'
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
const content = computed(() => mapView.popupContent)
const title = computed(() => (mapView.popup === null ? '' : `格 ${hexLabel(mapView.popup.hex)}`))

/**
 * 条 25（D2 修订）：**小窗只剩两种**——`content` 常规小窗、`context` 右键菜单
 *
 * 点空格的只读格号浮签已删：格号改由地图悬停提示（`MapCanvas` 的 `hoverTip`）随指针浮现，
 * 离格即消失，不再留一张需要再点一下才收的小签。
 */
const variant = computed(() => mapView.popup?.variant ?? 'content')
const actionGroups = ['模式改变', '移动', '战斗', '运输', '工程', '编组', '补给', '空军'] as const

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

/** 同格本方飞机（只读；操作走空军面板） */
const stackAircraft = computed(() => content.value?.airUnits ?? [])

/** 6.1 取子池：只有这些 chip 能点选（敌方 / 非战斗 / 补员算子照列不可点） */
const movableIds = computed(() => new Set(workbench.movePickChoices.map((unit) => unit.instanceId)))

/** 这一枚此刻可点选：本窗就是取子格，且它在 6.1 的可开拔池里 */
function chipPickable(id: string): boolean {
  return isMovePickHex.value && movableIds.value.has(id)
}

/** 9.12g 推进格（防御格已清空时给出） */
const advanceHex = computed(() => workbench.combatAdvanceHex)
const advanceChosen = computed(() => workbench.combatInputs.advanceUnitIds)

/** 6.1：堆叠取子清单的已勾选 id（界面用；`movePick` 为空时给空数组，避免模板里做空值断言） */
const movePickIds = computed<string[]>(() => workbench.movePick?.ids ?? [])

/** 6.1f：本次一起移动的单位（含已被放下的），与仍在走的那些 */
const movingUnits = computed(() => workbench.moveUnits)
const activeMovingUnits = computed(() => workbench.activeMoveUnits)

/** 6.1：小窗这一格是否正是待取子的堆叠格 ⇒ chip 直接驱动 `movePick` */
const isMovePickHex = computed(() => {
  const hex = mapView.popup?.hex
  const pickHex = workbench.movePickHex
  if (hex === undefined || pickHex === null) return false
  return hex.col === pickHex.col && hex.row === pickHex.row
})

/** chip 选中态：只有可开拔的本方算子有选中态；待取子格读 `movePick.ids`，其它窗按默认全选展示 */
function chipSelected(id: string): boolean {
  if (!movableIds.value.has(id)) return false
  return !isMovePickHex.value || movePickIds.value.includes(id)
}

/**
 * 用户 2026-11-09：堆叠窗「选完点开始移动即进入移动」
 *
 * 只在这一窗就是取子格、且至少选中一枚时出现；判据与执行都走既有
 * `confirmMovePick`（6.1），组件不判规则。
 */
const canStartMove = computed(
  () =>
    workbench.actionAllowedNow('move.order') && isMovePickHex.value && movePickIds.value.length > 0,
)

/**
 * 用户 2026-11-09：堆叠窗内右键**这一枚** ⇒ 该单位自己的菜单（只影响这一枚）
 *
 * 与地图右键分工：那边按选中集出一份共用菜单，这里只认这一枚。
 */
function onChipContext(event: MouseEvent, unitId: string): void {
  const hex = mapView.popup?.hex
  if (hex === undefined) return
  mapView.openUnitContext(
    hex,
    unitId,
    { x: event.clientX, y: event.clientY },
    {
      fromStackWindow: true,
    },
  )
}

/** 点 chip＝取消/恢复该枚开拔（仅待取子格上、且是该格可开拔的本方算子才可点） */
function toggleChip(id: string): void {
  if (!chipPickable(id)) return
  workbench.toggleMovePick(id)
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

/* ── 9.14 特殊战斗：待决的位移与运输点分配 ── */
/** 9.14 待决（null＝没有待决） */
const special = computed(() => workbench.specialPending)
/** 正在选落点的那一项（9.14c 运输点 / 9.14d 延补队） */
const specialItem = computed(() => mapView.specialItem)
/** 当前小窗这一格是否是这一项的合法落点（点地图即选定） */
const isSpecialCandidate = computed(() => {
  const hex = mapView.popup?.hex
  const item = specialItem.value
  if (hex === undefined || item === null) return false
  return item.candidates.some((candidate) => candidate.col === hex.col && candidate.row === hex.row)
})

/** 9.14 待决里该由谁动手（进入方） */
function sideName(side: string): string {
  return side === 'axis' ? '轴心国' : '苏联'
}

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
    width="292px"
    class="popover--menu"
    @close="mapView.closePopup()"
  >
    <section v-for="target in mapView.contextOptions" :key="target.id" class="context-target">
      <h4 class="block__title">{{ target.label }}</h4>
      <!--
        用户 2026-11-09：右键菜单改为**多级**——一级只摆分组入口，悬停/聚焦才在右侧展开该组叶子，
        免得一个堆叠把所有能力平铺成一条长列表。组内没有动作时整组不渲染（沿用原来 v-if 的语义）。
      -->
      <template v-for="group in actionGroups" :key="group">
        <div v-if="target.actions.some((item) => item.group === group)" class="context-group">
          <div class="context-group__trigger" tabindex="0">{{ group }} ▸</div>
          <div class="context-group__submenu">
            <BaseButton
              v-for="item in target.actions.filter((action) => action.group === group)"
              :key="item.key"
              variant="ghost"
              size="sm"
              class="context-action"
              :disabled="item.disabledReason !== null"
              :title="item.disabledReason ?? item.rule"
              @click="mapView.openContextAction(target.id, item.key)"
            >
              <span>{{ item.label }}</span
              ><small>{{ item.rule }}</small>
              <small v-if="item.disabledReason !== null" class="context-reason">{{
                item.disabledReason
              }}</small>
            </BaseButton>
          </div>
        </div>
      </template>
      <p v-if="target.actions.length === 0" class="muted context-empty">
        本环节无可用动作（只读查看）
      </p>
    </section>
  </MapPopover>
  <MapPopover
    v-else
    :open="open"
    :x="anchor.x"
    :y="anchor.y"
    :title="title"
    :rule="special !== null ? '9.14' : step === null ? '4.9a' : '9.2'"
    width="330px"
    @close="mapView.closePopup()"
  >
    <!-- ⓪ 9.14 特殊战斗：进入敌方设施格后的夺取与**位移落点选择**（优先级最高——必须收束的待决） -->
    <section v-if="special !== null" class="block block--special">
      <h4 class="block__title">9.14 特殊战斗 · 格 {{ hexLabel(special.hex) }}</h4>
      <p class="muted num">
        进入方：<BaseTag :kind="special.enteringSide === 'axis' ? 'danger' : 'info'">{{
          sideName(special.enteringSide)
        }}</BaseTag>
        （9.14：可攻击单位「进入」该格触发）
      </p>

      <!-- 即时结清的部分（9.14b 补给站 / 9.14e 工事 / 9.14f 基地） -->
      <ul v-if="special.notes.length > 0" class="list">
        <li v-for="(note, index) in special.notes" :key="index" class="num">{{ note }}</li>
      </ul>

      <!-- 9.14c：运输点组「哪些被夺取」由拥有者决定（混合类型时） -->
      <div v-for="split in special.splits" :key="split.group.group" class="sub">
        <h5 class="sub__title">
          运输点 · {{ split.group.group === 'trucks' ? '卡车列（MA > 10）' : '马车列（MA ≤ 10）' }}
        </h5>
        <p class="num">
          掷 {{ split.group.die }} → {{ split.group.percent }}% · 表值夺取
          {{ split.group.capturedPoints }}/{{ split.group.totalPoints }} 点
        </p>
        <label v-for="counter in split.counters" :key="counter.id" class="check">
          <input
            type="checkbox"
            :checked="split.capturedIds.includes(counter.id)"
            @change="workbench.toggleSpecialCaptured(counter.id)"
          />
          {{ counter.label }}（{{ counter.points }} 点）
        </label>
        <p :class="split.exact ? 'ok' : 'bad'">9.14c：{{ split.detail }}</p>
      </div>

      <!-- 9.14c/d：位移落点在地图上点选 -->
      <div v-if="special.items.length > 0" class="sub">
        <h5 class="sub__title">位移落点（9.14c 转移 / 9.14d 崩溃）</h5>
        <ul class="list">
          <li
            v-for="item in special.items"
            :key="item.unitId"
            class="num"
            :class="{ 'list__row--active': item.unitId === specialItem?.unitId }"
          >
            <BaseButton variant="ghost" size="sm" @click="mapView.setSpecialUnit(item.unitId)">
              {{ item.label }}
            </BaseButton>
            {{ item.kind === 'extender' ? '崩溃' : '转移' }} →
            {{ item.chosen === null ? '（未选）' : hexLabel(item.chosen) }}
          </li>
        </ul>
        <p v-if="isSpecialCandidate" class="ok">
          这一格正是 {{ specialItem?.label }} 的合法落点 ⇒ 点地图即可选定。
        </p>
        <p class="muted">{{ mapView.specialHint }}</p>
      </div>

      <div class="row">
        <BaseButton variant="primary" size="sm" @click="workbench.confirmSpecialCombatNow()">
          确认位移与分配（9.14）
        </BaseButton>
        <BaseButton variant="ghost" size="sm" @click="workbench.cancelSpecialCombatNow()">
          先关掉待决（位移暂不落盘）
        </BaseButton>
      </div>
    </section>

    <!-- ① 9.12g 推进：小窗只做**地图上的点选**（结算控件在战斗栏里） -->
    <template v-if="step !== null">
      <!-- 9.12g 推进：地图上点绿格 -->
      <section v-if="step === 'advance'" class="block">
        <h4 class="block__title">战后推进（9.12g）</h4>
        <p class="num">
          防御格 {{ advanceHex === null ? '未被清空' : hexLabel(advanceHex) }}
          <span v-if="advanceChosen.length > 0">
            · 已选 {{ advanceChosen.length }} 个推进单位
          </span>
        </p>
        <!--
          9.12g-D：「由拥有者玩家选择**哪些**攻击单位进行推进（如果有的话）」
          ⇒ 逐单位勾选必须存在（不可只有"全推 / 全不推"）；批 F·E4 把它收口到**地图小窗**这一处。
          灰显者（9.12g-A 未付战斗补给 / 9.12b 不可移动）点不动，原因由 store 给。
        -->
        <ul class="list">
          <li v-for="choice in workbench.combatAdvanceChoices" :key="choice.unit.instanceId">
            <BaseButton
              variant="ghost"
              size="sm"
              :disabled="choice.disabledReason !== null"
              @click="workbench.toggleAdvanceUnit(choice.unit.instanceId)"
            >
              {{ choice.selected ? '☑' : '☐' }} {{ choice.unit.name }}（军力
              {{ choice.unit.steps }}）
              <span v-if="choice.disabledReason !== null"> · {{ choice.disabledReason }}</span>
            </BaseButton>
          </li>
        </ul>
        <div class="row">
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="advanceHex === null"
            @click="advanceHex !== null && workbench.advanceNow(advanceHex)"
          >
            推进到该格（点地图绿格同效）
          </BaseButton>
          <!-- B33：突袭的推进是**强制**的 ⇒ 不给「不推进」（9.12g-D） -->
          <BaseButton
            v-if="!workbench.combatAdvanceMandatory"
            variant="ghost"
            size="sm"
            @click="workbench.clearAdvanceNow()"
          >
            不推进（9.12g）
          </BaseButton>
        </div>
        <BaseButton variant="primary" size="sm" @click="workbench.confirmCombatAdvance()">
          确认推进并收束（9.12g/9.13）
        </BaseButton>
      </section>
    </template>

    <!-- ② 无战斗流程：只摆战斗单位 + 操作按钮（不写说明文字） -->
    <template v-else>
      <!-- 6.1f：**移动中**可把堆叠里的某一枚就地放下（停在当前格，其余继续走） -->
      <section v-if="movingUnits.length > 1" class="block block--pick">
        <h4 class="block__title">移动中：放下堆叠里的单位</h4>
        <ul class="list">
          <li v-for="unit in movingUnits" :key="unit.instanceId" class="num">
            {{ unit.name }} @ {{ hexLabel(unit.hex) }}
            <span v-if="unit.movementEnded">· 已放下</span>
            <BaseButton
              v-else
              variant="ghost"
              size="sm"
              @click="workbench.dropUnitFromMove(unit.instanceId)"
            >
              就地放下
            </BaseButton>
          </li>
        </ul>
      </section>

      <!-- 8.1g/h：突袭的参突/留驻拆分（不勾选＝仍在移动的全部单位都参突） -->
      <section v-if="activeMovingUnits.length > 0" class="block block--pick">
        <h4 class="block__title">突袭时谁参战</h4>
        <ul class="list">
          <li v-for="unit in activeMovingUnits" :key="unit.instanceId" class="num">
            <label class="check">
              <input
                type="checkbox"
                :checked="workbench.overrunParticipantIds.includes(unit.instanceId)"
                @change="workbench.toggleOverrunParticipant(unit.instanceId)"
              />
              {{ unit.name }} @ {{ hexLabel(unit.hex) }}（{{ unit.re }} RE）
            </label>
          </li>
        </ul>
        <p v-if="workbench.overrunSplitNow !== null" class="num">
          参突 {{ workbench.overrunSplitNow.participantIds.length }} 枚 · 留驻
          {{ workbench.overrunSplitNow.stayIds.length }} 枚 · 原格战斗 RE
          {{ workbench.overrunSplitNow.originStackRe }}
        </p>
      </section>

      <!--
        左键堆叠窗（用户 2026-11-10）：**列全 + 默认全选 + 地图同格展开 + 删说明文字**。
        窗内只摆该格可见算子（地面全部 + 本方飞机）与操作按钮，不写规则解释；
        选中集只有一份＝`workbench.movePick`，可点者仅限 6.1 可开拔池里的本方算子。
      -->
      <section v-if="stackUnits.length > 0 || stackAircraft.length > 0" class="block">
        <div class="chips">
          <div
            v-for="unit in stackUnits"
            :key="unit.id"
            class="chip"
            :class="{
              'chip--pickable': chipPickable(unit.id),
              'chip--off': chipPickable(unit.id) && !chipSelected(unit.id),
            }"
            :role="chipPickable(unit.id) ? 'button' : undefined"
            :tabindex="chipPickable(unit.id) ? 0 : undefined"
            :aria-pressed="chipPickable(unit.id) ? chipSelected(unit.id) : undefined"
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
            <span class="chip__label num"
              >{{ unit.label }} · {{ unit.modeLetter }}<template v-if="unit.dg">· DG</template
              ><template v-if="unit.ended">· 停</template
              ><template v-if="truckFormationOf(unit.id) !== null">
                · 随 {{ truckFormationOf(unit.id) }}</template
              ></span
            >
          </div>
          <div
            v-for="air in stackAircraft"
            :key="air.instanceId"
            class="chip"
            @contextmenu.prevent.stop="onChipContext($event, air.instanceId)"
          >
            <img
              v-if="counterImageOf(air.instanceId) !== null"
              :src="counterImageOf(air.instanceId) ?? ''"
              class="chip__img"
              alt=""
            />
            <span class="chip__label num">{{ air.name }}</span>
          </div>
        </div>
        <div v-if="canStartMove" class="block__row">
          <BaseButton variant="primary" size="sm" title="6.1" @click="workbench.confirmMovePick()">
            开始移动
          </BaseButton>
        </div>
      </section>

      <!-- 本方飞机（14.1a：停在其空军基地格） -->
      <!-- 15.1 整备：点机场的「整备」按钮 → 勾选飞机 → 点地图上高亮的补给付款 -->
      <section
        v-if="baseAtHex !== null && workbench.actionAllowedNow('air.refit')"
        class="block block--pick"
      >
        <h4 class="block__title">整备（15.1）· {{ hexLabel(baseAtHex.hex) }}</h4>

        <template v-if="refitDoneHere">
          <p class="ok">本阶段已整备（15.1A：每基地每整备阶段一次）。</p>
        </template>

        <template v-else-if="!refitHere">
          <BaseButton
            variant="primary"
            size="sm"
            title="15.1"
            @click="workbench.beginRefitNow(baseAtHex.id)"
          >
            整备
          </BaseButton>
        </template>

        <template v-else>
          <ul v-if="workbench.refitCandidates.length > 0" class="list">
            <li v-for="air in workbench.refitCandidates" :key="air.instanceId" class="num">
              <label class="check">
                <input
                  type="checkbox"
                  :checked="workbench.refitSelectedIds.includes(air.instanceId)"
                  @change="workbench.toggleRefitAircraft(air.instanceId)"
                />
                {{ air.name }}
              </label>
            </li>
          </ul>
          <p class="ok num">
            已选 {{ workbench.refitSelectedIds.length }} 架｜可付款
            {{ workbench.refitPayDumps.length }} 处
          </p>
          <BaseButton variant="ghost" size="sm" @click="workbench.cancelRefitNow()">
            取消整备
          </BaseButton>
        </template>
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
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--color-muted);
  font-size: var(--text-xs);
  user-select: none;
}

.context-group:hover > .context-group__trigger,
.context-group:focus-within > .context-group__trigger {
  color: var(--color-ink);
  background: var(--color-bg-2);
}

.context-group__submenu {
  position: absolute;
  left: 100%;
  top: 0;
  display: none;
  min-width: 220px;
  padding: var(--space-1);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-panel);
  box-shadow: var(--shadow-lg);
  z-index: 1;
}

.context-group:hover > .context-group__submenu,
.context-group:focus-within > .context-group__submenu {
  display: block;
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
  flex-direction: column;
  gap: 4px;
}

.chip {
  display: flex;
  flex-wrap: wrap;
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

.chip__label {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-muted);
}

/* 左键堆叠窗：点枚切换选中（默认全选）；未选者压暗，不做额外说明 */
.chip--pickable {
  cursor: pointer;
  user-select: none;
}

.chip--off {
  opacity: 0.45;
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
