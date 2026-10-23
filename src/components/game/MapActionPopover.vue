<script setup lang="ts">
import { computed, ref } from 'vue'

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
 *   ① **战斗流程中**（9.2 九步）：在**战斗发生的那一格**展开战果承受 / 选项 / 撤退 / 推进，
 *      与地图上这次画出的高亮（撤退落点、推进格、补给站）配对使用；
 *   ② **无战斗时**：展示该格堆叠（4.9a 裁剪后的可见内容）+ 本方飞机，
 *      并在已选飞机时给出「任务类型 → 宣布任务」（14.2f-A/B）。
 *
 * ## 分层纪律（CODE_SPEC）
 *   本组件**不做任何规则计算**：损失分配、撤退落点、推进候选、任务合法性全部来自 store 对引擎的
 *   调用结果；这里只画图、收点击，把输入写进既有的 `combatInputs` / `airInputs` / 撤退路径。
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

/** 9.2 当前步（null＝盘面上没有进行中的战斗） */
/**
 * 9.2 当前步（null＝盘面上没有**进行中**的战斗）
 *
 * ★ 2026-09-18 修：原先取 `combatState?.step`，**不看 `finished`** ⇒ 战斗已收束后
 *   推进块与「确认推进并收束」仍挂在地图上（再点只是幂等地重跑一遍，界面无变化）。
 *   判据已上移到 store（`combatLiveStep`），本组件只读它，不自己判"算不算进行中"。
 */
const step = computed(() => workbench.combatLiveStep)

/** 是否已有进行中的战斗 / 突袭（战斗栏已在地图上展开 ⇒ 不再给「发起」入口） */
const combatRunning = computed(
  () => workbench.combatState !== null && !workbench.combatState.finished,
)

/** 该令牌对应的盘面算子（用来读「有无印刷轰炸值」等，界面只读不算规则） */
function consoleUnitOf(id: string): ConsoleUnit | null {
  return workbench.units.find((unit) => unit.instanceId === id) ?? null
}

/** 该令牌的算子图 URL（栏内「图阵列」用；无图则回退 null，界面只显示文字） */
function counterImageOf(id: string): string | null {
  const unit = consoleUnitOf(id)
  return unit === null ? null : counterImageUrlOf(unit)
}

/**
 * 条 7（R3）：堆叠展示分**战斗 / 非战斗两栏**（栏内图阵列）
 *
 * 判据用 `UnitToken.noncombatKind`：有值＝非战斗单位（运输点 / 空军基地 / 工事…），无值＝战斗单位。
 * 本组件不另判规则——与地图上画算子是同一份数据。
 */
const combatUnits = computed(() =>
  visibleGroundUnits.value.filter((unit) => (unit.noncombatKind ?? null) === null),
)
const nonCombatUnits = computed(() =>
  visibleGroundUnits.value.filter((unit) => (unit.noncombatKind ?? null) !== null),
)

/** 非战斗栏：点「展开机场飞机」才列出该基地的本方飞机（14.1a） */
const showAirbasePlanes = ref(false)

/** 该算子是否可作为参炸单位（10.0e：有印刷轰炸值；归属与阶段合法性仍由引擎判） */
function canBarrage(id: string): boolean {
  const unit = consoleUnitOf(id)
  return unit !== null && unit.side === workbench.activeSide && (unit.raw.barrage ?? 0) > 0
}

/**
 * 9.12 撤退：当前该选落点的一方与其单位
 *
 * ★ 2026-09-16 修：原先读 `workbench.combatRetreatSide`（＝`combatRetreatPlans[0]`，**永远先攻方**），
 *   而地图高亮、`retreatHint`、`currentDestination` 读的是 `mapView.retreatSidePlan`
 *   （＝**第一个未选齐的一方**）。攻方选齐后地图已切到守方，小窗却还在列攻方 ⇒
 *   名单与"点哪一格生效"对不上。这里改成与地图**同一份**计划。
 */
const retreatPlan = computed(() => mapView.retreatSidePlan)
const retreatUnit = computed(() => mapView.retreatUnit)

/** 9.12g 推进格（防御格已清空时给出） */
const advanceHex = computed(() => workbench.combatAdvanceHex)
const advanceChosen = computed(() => workbench.combatInputs.advanceUnitIds)

/** 9.2 的**战斗发生在哪一格**（小窗的指路文字里报出，便于对上是哪一场） */
const battleHex = computed(
  () => workbench.combatState?.composition.defendingHex ?? workbench.battleTarget?.hex ?? null,
)

/** 6.1：堆叠取子清单的已勾选 id（界面用；`movePick` 为空时给空数组，避免模板里做空值断言） */
const movePickIds = computed<string[]>(() => workbench.movePick?.ids ?? [])

/** 6.1f：本次一起移动的单位（含已被放下的），与仍在走的那些 */
const movingUnits = computed(() => workbench.moveUnits)
const activeMovingUnits = computed(() => workbench.activeMoveUnits)

/** 6.1：小窗这一格是否正是待取子的堆叠格 ⇒ 在堆叠处给出勾选清单 */
const isMovePickHex = computed(() => {
  const hex = mapView.popup?.hex
  const pickHex = workbench.movePickHex
  if (hex === undefined || pickHex === null) return false
  return hex.col === pickHex.col && hex.row === pickHex.row
})

/** 14.2e：可在「任务分配」里宣布的任务类型（拦截与基地转移不在其中，与 AirPanel 同口径） */
const MISSION_KINDS = [
  { key: 'barrage', label: '空军轰炸（14.7b）' },
  { key: 'hip_shoot', label: '低空扫射（14.7d）' },
  { key: 'trainbusting', label: '运输破坏（14.8）' },
  { key: 'air_transport', label: '空运（14.9）' },
  { key: 'air_drop', label: '空投（14.10）' },
  { key: 'fighter_sweep', label: '战机扫荡（14.6）' },
] as const

/** 已勾选的参战飞机（14.2a） */
const pickedAir = computed(() => workbench.airMissionAirUnits)

/** 该格是否已被定为任务格（14.2f-B） */
const isMissionTarget = computed(() => {
  const hex = mapView.popup?.hex
  const target = workbench.airTargetHex
  if (hex === undefined || target === null) return false
  return hex.col === target.col && hex.row === target.row
})

/**
 * 批 A 切片 3②：框内**只列本环节能行动的己方算子**（用户口径 9.17⑤）
 *
 * 敌方算子照列（它们是 4.9a 的**目标**，不是候选）；判据全部来自 store 的
 * `popupContent.actionableOwnIds`（＝参与集合 + 9.1c 的攻击账本），本组件不自己判规则。
 */
const visibleGroundUnits = computed(() =>
  (content.value?.units ?? []).filter(
    (unit) =>
      unit.side !== workbench.activeSide ||
      (content.value?.actionableOwnIds ?? []).includes(unit.id),
  ),
)

/** 被滤掉的己方算子（如实交代一行，含规则号；判据同样来自 store） */
const blockedOwn = computed(() => content.value?.blockedOwn ?? [])

/** 该格是否是可付款的补给站（12.4；地图上画金黄方框） */
const dumpAtHex = computed(() =>
  mapView.combatSourceDumps.find(
    (dump) =>
      mapView.popup !== null &&
      dump.hex.col === mapView.popup.hex.col &&
      dump.hex.row === mapView.popup.hex.row,
  ),
)

/** 该格是否是当前这名的合法撤退落点（9.12；地图上按「安全 / ZOC / 必死」三色画） */
const currentDestination = computed(() => {
  const hex = mapView.popup?.hex
  const unit = retreatUnit.value
  if (hex === undefined || unit === null) return null
  return (
    unit.destinations.find((item) => item.hex.col === hex.col && item.hex.row === hex.row) ?? null
  )
})

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

/**
 * 发起轰炸（10.0）：点某枚有轰炸值的己方算子即开启轰炸流程
 *
 * 用户口径：**轰炸页面只在单位执行轰炸操作时才在地图上展开** ⇒ 这里点一下就开工具并选入该枚，
 * 于是 `barrageState` 建立、`MapDock` 上的「轰炸结算（10.0）」面板随之在地图右上角出现。
 */
function startBarrage(unitId: string): void {
  workbench.setBarrageActive(true)
  workbench.toggleBarrageUnit(unitId)
}

function toggleMissionAircraft(aircraftId: string): void {
  // 点飞机即「加入/移出本次任务」；顺带打开空军工具，使随后点目标格能定任务格（14.2f-B）
  workbench.setAirActive(true)
  workbench.toggleAirMissionUnit(aircraftId)
}

/**
 * H⑤（14.1a）：这一枚飞机此刻**为什么不能选入任务**（可选的返回 null）
 *
 * 判据不在本组件里（组件不比较规则号）：直接读 store 的候选阵列——它与面板阵列、选择闸
 * （`toggleAirMissionUnit`）**同一处**结论。于是"点机场选一枚非激活飞机"在这里就被挡住，
 * 并给出一行原因（14.1a：非激活 ⇒ 需先按 14.1d 整备 15.1）。
 */
function missionJoinReasonOf(aircraftId: string): string | null {
  return (
    workbench.airMissionJoinChoices.find((choice) => choice.air.instanceId === aircraftId)
      ?.disabledReason ?? null
  )
}

function beginMission(): void {
  workbench.beginAirMissionNow()
}

function pickDump(): void {
  const dump = dumpAtHex.value
  if (dump !== undefined) workbench.pickCombatSupplyDump(dump.side, dump.id)
}
</script>

<template>
  <MapPopover
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
        <p class="muted">
          青色虚线＝合法落点。9.14c：位移「有点像撤退」，敌方单位、ZOC 和禁入地形都<b>不影响</b>，
          只需把运输点放到新位置（格距上限见 rules-constants 的
          specialCombat.transportDisplaceMaxHexes）；
          9.14d：延补队必须崩溃，落点须在该延补队<b>特殊拖取距离内且此格有追溯补给</b>。
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

    <!-- ① 战斗流程中：小窗只做**地图上的点选**（撤退落点 / 补给站付款），结算控件在战斗栏里 -->
    <template v-if="step !== null">
      <p class="muted num">
        9.2 当前步：<BaseTag kind="info">{{ step }}</BaseTag>
        <span v-if="battleHex !== null">· 战斗格 {{ hexLabel(battleHex) }}</span>
      </p>
      <p class="muted">
        九步结算的输入在**战斗格上的「战斗结算（9.2）」面板**里（地图上就地展开，战斗结束即消失）；
        这里只负责「在地图上点」的那部分。
      </p>

      <!-- 9.12 撤退：地图上点落点（含 9.12d 跟随者、9.12b 必死落点） -->
      <section v-if="step === 'retreat'" class="block">
        <h4 class="block__title">撤退（9.12：在地图上点落点）</h4>
        <p class="num">{{ mapView.retreatHint }}</p>
        <ul class="list">
          <li
            v-for="unit in retreatPlan?.units ?? []"
            :key="unit.unitId"
            class="num"
            :class="{ 'list__row--active': unit.unitId === retreatUnit?.unitId }"
          >
            <BaseButton variant="ghost" size="sm" @click="mapView.setRetreatUnit(unit.unitId)">
              {{ unit.label }}
            </BaseButton>
            自 {{ hexLabel(unit.from) }} →
            {{ unit.chosen === null ? '（未选）' : hexLabel(unit.chosen) }}
          </li>
          <!-- 9.12d：跟随者（路径自动沿用同格宿主） -->
          <li v-for="item in retreatPlan?.tagalongs ?? []" :key="item.unitId" class="num">
            <BaseTag kind="success">跟随</BaseTag>
            {{ item.label }}（随 {{ item.hostLabel }}，9.12d）
          </li>
        </ul>

        <!-- 9.12d：可加入撤退的单位（未参战战斗单位 / 编内卡车） -->
        <div v-if="(workbench.combatTagalongCandidates.length ?? 0) > 0" class="row">
          <BaseButton
            v-for="item in workbench.combatTagalongCandidates"
            :key="item.unit.instanceId"
            variant="secondary"
            size="sm"
            @click="workbench.toggleCombatTagalong(item.unit.instanceId)"
          >
            {{ workbench.combatTagalongIds.includes(item.unit.instanceId) ? '✓ ' : ''
            }}{{ item.unit.name }}（随 {{ item.hostLabel }}）
          </BaseButton>
        </div>

        <p v-if="currentDestination !== null" class="ok">
          这一格正是 {{ retreatUnit?.label }} 的合法落点 ⇒
          点地图即可选定（9.12：完整撤退距离已满足）。
          <span v-if="currentDestination.forcedDestruction" class="bad">
            ⚠ 该路线必然穿过敌方战斗单位或禁入地形 ⇒ **该单位会被消灭**（9.12；不可移动者见
            9.12b）。
          </span>
          <span v-else-if="currentDestination.inEnemyZoc">
            该格在敌方 ZOC 内 ⇒ 进入即 DG（9.12e）。
          </span>
        </p>
        <p class="muted">
          青绿＝安全格；橙红＝敌方 ZOC 格（9.12e）；暗红点线＝选了会被消灭（9.12/9.12b）。
          攻方选完才轮到守方（9.10b 次序）。
        </p>
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="retreatPlan === null || !retreatPlan.complete"
          @click="workbench.confirmCombatRetreats()"
        >
          确认撤退（9.12）
        </BaseButton>
      </section>

      <!-- 9.12g 推进：地图上点绿格 -->
      <section v-else-if="step === 'advance'" class="block">
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

      <!-- 12.4 战斗补给：该格是补给站时可就地声明付款来源 -->
      <section v-if="step === 'combatSupply' && dumpAtHex !== undefined" class="block">
        <h4 class="block__title">战斗补给来源（12.4）</h4>
        <p class="num">
          {{ hexLabel(dumpAtHex.hex) }} · {{ dumpAtHex.side === 'attacker' ? '攻方' : '守方' }} ·
          {{ dumpAtHex.label }}
        </p>
        <BaseButton variant="primary" size="sm" @click="pickDump()">
          用这个补给站付款（12.4）
        </BaseButton>
      </section>
    </template>

    <!-- ② 无战斗流程：展示堆叠 + 飞机任务 -->
    <template v-else>
      <p class="muted num">
        该格算子 {{ content?.units.length ?? 0 }} 枚
        <span v-if="content?.hidden === true">（还有未显示的内容，4.9a 不透露枚数）</span>
      </p>

      <!-- 6.1f：**移动中**可把堆叠里的某一枚就地放下（停在当前格，其余继续走） -->
      <section v-if="movingUnits.length > 1" class="block block--pick">
        <h4 class="block__title">移动中：放下堆叠里的单位（6.1f）</h4>
        <p class="muted num">
          本次一起移动 {{ movingUnits.length }} 枚 · 仍在走
          {{ activeMovingUnits.length }} 枚（放下者停在它当前所在格）
        </p>
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
        <p class="muted">
          6.1f：放下即「离开堆叠」——该单位本次移动结束，剩下的单位继续走；下次要点它得等下个阶段。
        </p>
      </section>

      <!-- 8.1g/h：突袭的参突/留驻拆分（不勾选＝仍在移动的全部单位都参突） -->
      <section v-if="activeMovingUnits.length > 0" class="block block--pick">
        <h4 class="block__title">突袭时谁参战（8.1g / 8.1h）</h4>
        <p class="muted num">
          不勾选＝仍在走的 {{ activeMovingUnits.length }} 枚**全部参突**；勾选即只让这几枚参突，
          其余**留在原格**（8.1h：仍计入原格 4.8a 的战斗 RE，但不参突、也不受结果影响）。
        </p>
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

      <!-- 6.1：堆叠取子（点堆叠格后先选哪几枚开拔；8.1h 允许其余单位留驻） -->
      <section v-if="isMovePickHex" class="block block--pick">
        <h4 class="block__title">选择要一起开拔的单位（6.1）</h4>
        <p class="muted num">
          本格己方 {{ workbench.movePickChoices.length }} 枚 · 已勾选 {{ movePickIds.length }} 枚
        </p>
        <ul class="list">
          <li
            v-for="unit in workbench.movePickChoices"
            :key="unit.instanceId"
            class="num"
            :class="{ 'list__row--active': movePickIds.includes(unit.instanceId) }"
          >
            <label class="check">
              <input
                type="checkbox"
                :checked="movePickIds.includes(unit.instanceId)"
                @change="workbench.toggleMovePick(unit.instanceId)"
              />
              {{ unit.name }}（A{{ unit.raw.attack }} AR{{ unit.raw.ar }} MA{{ unit.raw.ma }}，{{
                unit.re
              }}RE）
            </label>
            <BaseButton
              variant="ghost"
              size="sm"
              @click="workbench.setMovePickOnly(unit.instanceId)"
            >
              只动这一枚
            </BaseButton>
          </li>
        </ul>
        <div class="row">
          <BaseButton variant="secondary" size="sm" @click="workbench.setMovePickAll()">
            整堆叠（全选）
          </BaseButton>
          <BaseButton variant="primary" size="sm" @click="workbench.confirmMovePick()">
            开始移动（6.1）
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="workbench.cancelMovePick()">
            取消
          </BaseButton>
        </div>
        <p class="muted">
          未勾选者留在格内：按 6.1f 它们不随本次移动；按 8.1h 它们也不参与突袭、不受突袭结果影响。
          突袭时只有**勾选的这一组**会被当作参突单位（8.1g）⇒
          堆叠里混有不可攻击的单位时，只勾合格者即可照常突袭。
        </p>
      </section>

      <!-- 地面算子（4.9a：敌方格只列允许的那一两枚；**己方只列本环节能行动的**） -->
      <section class="block">
        <h4 class="block__title">堆叠（4.9a 可见内容）</h4>
        <p v-if="visibleGroundUnits.length === 0" class="muted">（无可见地面算子）</p>
        <!--
          条 7（R3）：堆叠分**战斗 / 非战斗两栏**（栏内图阵列）。
          战斗栏含发起轰炸入口（10.0）；非战斗栏含机场飞机的「展开」入口（14.1a）。
        -->
        <div v-else class="cols">
          <div class="col">
            <h5 class="col__title">战斗</h5>
            <div v-if="combatUnits.length === 0" class="muted">—</div>
            <div v-for="unit in combatUnits" :key="unit.id" class="chip">
              <img
                v-if="counterImageOf(unit.id) !== null"
                :src="counterImageOf(unit.id) ?? ''"
                class="chip__img"
                alt=""
              />
              <span class="chip__label num"
                >{{ unit.label }} · {{ unit.modeLetter }}<template v-if="unit.dg">· DG</template
                ><template v-if="unit.ended">· 停</template></span
              >
              <BaseButton
                v-if="!workbench.combatPickActive && canBarrage(unit.id)"
                variant="ghost"
                size="sm"
                @click="startBarrage(unit.id)"
              >
                {{ workbench.barrageUnitIds.includes(unit.id) ? '移出炮击' : '炮击' }}
              </BaseButton>
            </div>
          </div>
          <div class="col">
            <h5 class="col__title">非战斗</h5>
            <div v-if="nonCombatUnits.length === 0" class="muted">—</div>
            <div v-for="unit in nonCombatUnits" :key="unit.id" class="chip">
              <img
                v-if="counterImageOf(unit.id) !== null"
                :src="counterImageOf(unit.id) ?? ''"
                class="chip__img"
                alt=""
              />
              <span class="chip__label num">{{ unit.label }}</span>
            </div>
            <!-- 14.1a：点「展开机场飞机」才在这一栏列出本基地的本方飞机（图阵列） -->
            <template v-if="(content?.airUnits.length ?? 0) > 0">
              <BaseButton variant="ghost" size="sm" @click="showAirbasePlanes = !showAirbasePlanes">
                {{ showAirbasePlanes ? '收起机场飞机' : '展开机场飞机' }}
              </BaseButton>
              <div v-if="showAirbasePlanes" class="chips">
                <div v-for="air in content?.airUnits ?? []" :key="air.instanceId" class="chip">
                  <img
                    v-if="counterImageOf(air.instanceId) !== null"
                    :src="counterImageOf(air.instanceId) ?? ''"
                    class="chip__img"
                    alt=""
                  />
                  <span class="chip__label num">
                    {{ air.name }}（{{ air.airStatus === 'active' ? '激活' : '非激活' }}）
                  </span>
                  <BaseButton
                    variant="ghost"
                    size="sm"
                    :disabled="missionJoinReasonOf(air.instanceId) !== null"
                    :title="missionJoinReasonOf(air.instanceId) ?? undefined"
                    @click="toggleMissionAircraft(air.instanceId)"
                  >
                    {{
                      workbench.airMissionAirIds.includes(air.instanceId) ? '移出任务' : '选入任务'
                    }}
                  </BaseButton>
                </div>
              </div>
            </template>
          </div>
        </div>
        <!--
          批 A 切片 3②（用户口径 9.17⑤「框内只列**该环节能行动**的单位」）：
          被滤掉的己方算子**如实交代一行**（含规则号），否则玩家会以为"我的兵不见了"。
          文字纪律：这属"环节提示"一类（§16.09），不是常驻说明。
        -->
        <p v-if="blockedOwn.length > 0" class="muted">
          另有 {{ blockedOwn.length }} 枚本环节不能行动：
          {{ blockedOwn.map((item) => `${item.label}（${item.rule} ${item.reason}）`).join('、') }}
        </p>
      </section>

      <!-- 本方飞机（14.1a：停在其空军基地格） -->
      <!-- 15.1 整备：点机场的「整备」按钮 → 勾选飞机 → 点地图上高亮的补给付款 -->
      <section v-if="baseAtHex !== null" class="block block--pick">
        <h4 class="block__title">整备（15.1）· {{ hexLabel(baseAtHex.hex) }}</h4>
        <p class="muted num">
          非激活 {{ workbench.airInactiveAtBase(baseAtHex.id).length }} 架｜整备容量
          {{ baseAtHex.isAirstrip === true ? 1 : baseAtHex.level * 2 }}｜费用 1T
        </p>

        <template v-if="refitDoneHere">
          <p class="ok">本阶段已整备（15.1A：每基地每整备阶段一次）。</p>
        </template>

        <template v-else-if="!refitHere">
          <BaseButton variant="primary" size="sm" @click="workbench.beginRefitNow(baseAtHex.id)">
            整备（15.1）
          </BaseButton>
          <p class="muted">
            点整备后，在此勾选要整备的飞机，再点地图上<b>金黄高亮的补给站</b>付
            1T（与其它补给消耗同一方式）。
          </p>
        </template>

        <template v-else>
          <p class="muted num">
            勾选要整备的飞机（已选 {{ workbench.refitSelectedIds.length }} 架）：
          </p>
          <p v-if="workbench.refitCandidates.length === 0" class="muted">
            本格没有非激活飞机（15.1B）。
          </p>
          <ul v-else class="list">
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
          <p class="ok">
            已勾选 {{ workbench.refitSelectedIds.length }} 架 ⇒
            点地图上金黄高亮的补给站付款（1T）即结算（15.1B）。
          </p>
          <p class="muted num">
            可付款补给站：{{ workbench.refitPayDumps.length }} 处（12.3a 该基地可拖取者）
          </p>
          <BaseButton variant="ghost" size="sm" @click="workbench.cancelRefitNow()">
            取消整备
          </BaseButton>
        </template>
      </section>

      <!-- 9.1：战斗的发起入口已移到**会话框**（B15b：宣布之前也开一个「发起战斗（9.1）」会话）。
           这里只提示怎么在图上凑齐攻方与防御格。 -->
      <section v-if="workbench.combatPickActive && !combatRunning" class="block block--pick">
        <h4 class="block__title">发起战斗（9.1）</h4>
        <p class="num">
          攻方已选 {{ workbench.combatAttackerIds.length }} 枚｜防御格
          {{ workbench.battleTarget === null ? '（未选）' : hexLabel(workbench.battleTarget.hex) }}
        </p>
        <p class="muted">
          在**地图上**摊开己方堆叠点枚即选出攻方（多格可分别选，9.1b/9.1c），再点敌方格定防御格 ⇒
          右上角的「发起战斗（9.1）」会话框里按「开始战斗」即可（9.2 的九步随后在同一会话里走）。
        </p>
      </section>

      <!-- 14.2f-A/B：已选飞机 ⇒ 在此（目标格）选任务并宣布 -->
      <section v-if="workbench.airActive && pickedAir.length > 0" class="block">
        <h4 class="block__title">空军任务（14.2f-A/B）</h4>
        <p class="num">
          已选 {{ pickedAir.length }} 架：{{ pickedAir.map((air) => air.name).join('、') }}
        </p>
        <p class="num">
          任务格：{{
            workbench.airTargetHex === null ? '（未选）' : hexLabel(workbench.airTargetHex)
          }}
          <span v-if="isMissionTarget">（就是这一格）</span>
        </p>
        <div class="row">
          <BaseButton
            v-for="kind in MISSION_KINDS"
            :key="kind.key"
            variant="secondary"
            size="sm"
            @click="workbench.setAirMissionKind(kind.key)"
          >
            {{ workbench.airMissionKind === kind.key ? '✓ ' : '' }}{{ kind.label }}
          </BaseButton>
        </div>
        <p class="muted">
          当前类型：{{ workbench.airMissionKindLabel(workbench.airMissionKind) }}；
          点地图上任意一格即把它定为任务格（14.2f-B），然后在此宣布。
        </p>
        <BaseButton variant="primary" size="sm" @click="beginMission()">
          宣布任务（14.2f-A/B）
        </BaseButton>
      </section>

      <p v-else class="muted">
        点本方算子＝选中并显示可移动范围（6.1）；点空军基地格上的飞机＝选入任务（14.2f-A）。
      </p>
    </template>
  </MapPopover>
</template>

<style scoped>
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
