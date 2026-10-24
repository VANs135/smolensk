<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { BaseButton, BaseDialog, BasePanel, BaseTag } from '@/components/base'
import { AirPanel } from '@/components/air'
import { BarragePanel } from '@/components/barrage'
import { CombatPanel } from '@/components/combat'
import { ContainersPanel } from '@/components/containers'
import { ExclusiveRulesPanel } from '@/components/exclusive'
import { ConsensusChecklist, HandoffOverlay } from '@/components/hotseat'
import { MapCanvas } from '@/components/map'
import { ReinforcementPanel } from '@/components/reinforcement'
import {
  DerivationSteps,
  FlowStrip,
  QuestionPrompt,
  SettlementLogPanel,
  TerminationNotice,
} from '@/components/session'
import { SupplyPanel } from '@/components/supply'
import { VictoryPanel } from '@/components/victory'
import { SetupPanel } from '@/components/setup'
import { provideUiMode } from '@/components/ui-mode'
import { ChartsTable } from '@/components/game'
import type { HexRef } from '@/data'
import { DEFAULT_MAP_LAYERS } from '@/render/map-render'
import { OVERRUN_COST_MP } from '@/engine/rules/overrun'
import {
  arrivalNotesOf,
  arrivalTableView,
  crtResultCodes,
  crtViews,
  gridTableViews,
  rebuildTableViews,
  replTableViews,
  specialReplTableViews,
  supplyTableViews,
  tecLegend,
  tecTableView,
  turnWeatherTableView,
} from '@/render/charts-view'
import {
  useUiStore,
  useWorkbenchStore,
  useHotseatStore,
  useSetupStore,
  useMapViewStore,
  TURN_TRACK,
  availableMaOf,
  effectiveMobilityOf,
  hexLabel,
  movementPhaseOf,
  needsFuelOf,
  turnDateOf,
} from '@/stores'

/**
 * 操作台（U0 骨架 + C5 移动交互）—— **★ 已降级为「引擎验证页」**（用户决定 ③，B17 生效）
 *
 * ## 它的定位（写给后来者）
 *   **正式玩法在「对局台」（`GameTableView`）**：一切行动都在地图页展开**唯一会话框**、
 *   右栏只读、底部是盒与表格托盘。本页**不跟随新交互**，只作**数据/规则回归对照**：
 *   面板平铺、表单直填、每步都能单独点，便于把某个引擎判据拉出来单看。
 *   ⇒ **新加交互请去对局台**；在这里加功能等于维护第二条路径（双入口腐化，方案 §9 的风险表）。
 *   少数**只有验证页保留**的用途（对局台已不再提供）：`referee` 模式的裁判工具
 *   （胜利判定页的账本订正 / 手动检查）、`stepwise` 的流程条「推进一步」、阶段与回合的手动拨动。
 *
 * 分层纪律：
 *   - 本视图**不做任何规则计算**，只「画图 + 收点击 + 显示 store 里的结论」；
 *   - 一切结论来自引擎：移动范围 `reachableForMove`（底层 6.1/6.2/BFS）、单步 `previewStep`/`planStep`、
 *     模式 `canSwitchModeNow`（5.4）、燃料 `planFuelPayment`（12.5）、战斗 `resolveCombat`（9.9）；
 *   - 地图渲染交给 C2 的 `MapCanvas`（缩放/平移/视口裁剪），算子与移动提示走覆盖层。
 *
 * C5 交互流（用户需求）：选单位或堆叠 → 显示可移动范围 → 点格逐格移动（每格重算范围）
 *   → 不想走了点「结束移动」；期间可看路径与消耗预览、切模式、付燃料、撤销。
 */

const workbench = useWorkbenchStore()
const hotseat = useHotseatStore()
const ui = useUiStore()
const setup = useSetupStore()
const mapView = useMapViewStore()

/*
 * ★ 条 24 / §5-F：**模式声明**（引擎验证页＝验证）。
 *   这一页的全部手输**一个都不能删**：逐步复核、复现、裁判补记都靠它；
 *   对局台那份声明 formal 才会收起手输。
 */
provideUiMode('verify')

/** 地图图层开关（C2 的 MapCanvas 消费） */
const mapLayerToggles = reactive({ ...DEFAULT_MAP_LAYERS })

/**
 * B35：**引擎投影表**（从对局台的托盘搬来；对局台只留印卡原卡）
 *
 * 十张：CRT 四页 + 六个同伴表（`gridTableViews`）、补给/补员/特殊补员/重建（`supply|repl|specialRepl|rebuildTableViews`）、
 * TEC（`tecTableView` + `tecLegend` 图例）、回合与天气（`turnWeatherTableView`）、到货（`arrivalTableView`，当日无卡则为空）。
 * 这里只把投影函数的结果摊开，**不做任何规则判断**（单元格文本照录数据文件）。
 */
const chartTables = computed(() => {
  const arrival = arrivalTableView(workbench.arrivalPlan)
  return [
    ...crtViews(),
    ...gridTableViews(),
    ...supplyTableViews(),
    ...replTableViews(),
    ...specialReplTableViews(),
    ...rebuildTableViews(),
    tecTableView(),
    turnWeatherTableView(),
    ...(arrival === null ? [] : [arrival]),
  ]
})

/** CRT 结果代码释义（照录数据；挂到 CRT 第一页表下）——统一成 `{key,text}` 形状，渲染件只认这一种 */
const crtFootnotes = computed(() =>
  crtResultCodes().map((item) => ({ key: item.code, text: item.text })),
)
/** **CRT 第一页**的表 id（用来挂释义；不写死标题，按 `crtViews()` 的首张取） */
const crtTableId = computed<string>(() => crtViews()[0]?.id ?? '')
/** TEC 图例（照录数据文件的 `legend`）——同样统一成 `{key,text}` */
const tecFootnotes = computed(() => tecLegend().map((item) => ({ key: item.key, text: item.text })))
/** TEC 那张表（用来把图例挂到它下面 —— 用 id 比对，不写死标题） */
const tecTable = computed(() => tecTableView())

/**
 * 到货表的**脚注**（1.6a 强制移除 / 2.1a 关闭 / 其它提示）
 *
 * 这些正是 `arrivalNotesOf` 给的（原来挂在托盘的"到货"屏上；B35 把该屏归到增援窗后，
 * 脚注跟着投影表一起落到本页 —— 它仍是"照录数据"的只读说明，不是规则判断）。
 */
const arrivalFootnotes = computed(() => {
  const notes = arrivalNotesOf(workbench.arrivalPlan)
  const rows: { key: string; text: string }[] = []
  for (const [index, note] of notes.entries()) {
    for (const text of note.removals) rows.push({ key: `1.6a·${String(index + 1)}`, text })
    for (const text of note.shutdowns) rows.push({ key: `2.1a·${String(index + 1)}`, text })
    for (const text of note.notes) rows.push({ key: `13.6·${String(index + 1)}`, text })
  }
  return rows
})
/** 到货那张表的 id（有当日到达卡时才有；空则脚注也无处可挂） */
const arrivalTableId = computed<string>(
  () => chartTables.value.find((table) => table.id.startsWith('arrival'))?.id ?? '',
)

/** 阶段按钮（2.2 SOP 八段：A 整备 / B 增援 / C 移动 / D 补给 / E 反应 / F 战斗 / G 进击 / H 清理） */
const PHASE_OPTIONS = [
  { key: 'aircraftRefit', label: 'A 整备' },
  { key: 'reinforcement', label: 'B 增援' },
  { key: 'movement', label: 'C 移动' },
  { key: 'supply', label: 'D 补给' },
  { key: 'reaction', label: 'E 反应' },
  { key: 'combat', label: 'F 战斗' },
  { key: 'exploitation', label: 'G 进击' },
  { key: 'cleanUp', label: 'H 清理' },
] as const

/** 回合计：1..轨末（2.2 回合轨，取自工程数据 markers.turnTrack） */
const turnMax = TURN_TRACK[TURN_TRACK.length - 1]?.turn ?? 1

/** 主动模式按钮（5.3：被动模式不可选择） */
const MODE_OPTIONS = [
  { key: 'combat', label: '战斗' },
  { key: 'move', label: '移动' },
  { key: 'reserve', label: '预备' },
  { key: 'strat', label: '战略' },
] as const

/** 加油方法（12.5c 三种） */
const FUEL_OPTIONS = [
  { key: 'singleUnit', label: '单单位法（每单位 1T）' },
  { key: 'formation', label: '编队法（1SP，整编队）' },
  { key: 'hq', label: 'HQ 法（1SP，投递距离内独立单位）' },
] as const

/** 单位列选择器用的当前方单位库（下拉里带印值，便于快速认） */
const choiceOptions = computed(() =>
  workbench.choices.map((record) => {
    const combat = record.factors?.combat
    const label = `${record.nameZh ?? record.nameEn ?? record.id} · A${combat?.attack ?? '—'}/AR${combat?.ar ?? '—'}/MA${combat?.ma ?? '—'}`
    return { id: record.id, label, record }
  }),
)

/* ── C5：地图覆盖层 ──
   覆盖层（算子令牌 / 可到达范围 / 预览路径 / 突袭目标 / 撤退落点 / 补给）**统一由
   `stores/map-view.ts` 产出**：对局台与本操作台共用同一份，不再各写一套。
   从前这里有一份内联副本，缺了突袭目标 / 撤退落点 / 推进格 / 战斗补给付款源 / 9.14 位移落点，
   导致「同一份盘面、两个视图点同一格却做不同的事」——联调即把这份副本删掉，只留单一来源。 */

/* ── C5：预览与状态展示 ── */

/** 悬停格的预览文案（路径与消耗预览；6.1 逐格 / 6.1a 消耗 / 6.1c / 4.5a-A） */
const previewText = computed(() => {
  const node = workbench.hoverNode
  if (node === null) return null
  const parts: string[] = [
    `目标 ${node.hex.col}.${node.hex.row}：${node.path.map((hex) => `${hex.col}.${hex.row}`).join(' → ')}（合计 ${node.mpSpent} MP）`,
  ]
  const step = workbench.stepPreview
  if (step !== null && step.ok) {
    parts.push(
      step.moving
        .map(
          (item) =>
            `${nameOfUnit(item.unitId)} 本步 ${item.cost} MP（格 ${item.hexCost} + 格边 ${item.hexsideCost}）` +
            `${item.roadOverride ? ' 沿路' : ''}${item.crossedOnBridge ? ' 过桥' : ''}` +
            `${item.minimumMove ? ' 最小移动（6.1c）' : ''}`,
        )
        .join('；'),
    )
  } else if (node.path.length > 2) {
    parts.push(`将沿路径逐格走 ${node.path.length - 1} 格（6.1：每格重新判定）`)
  }
  if (node.inEnemyZoc) parts.push('该格处于未抵消的敌方 ZOC（4.5a-A / 5.8a）')
  if (node.forcedStop) parts.push('到达后被迫停止（4.5a-A）')
  if (node.minimumMove) parts.push('只能靠 6.1c 最小移动到达')
  if (step !== null && step.zocStoppingIds.length > 0)
    parts.push(`进入后必须就地停止：${step.zocStoppingIds.map(nameOfUnit).join('、')}（4.5a-A）`)
  if (step !== null && step.stratBlockedIds.length > 0)
    parts.push(`战略模式不可进入：${step.stratBlockedIds.map(nameOfUnit).join('、')}（5.8a）`)
  return parts.join('；')
})

function nameOfUnit(unitId: string): string {
  return workbench.units.find((unit) => unit.instanceId === unitId)?.name ?? unitId
}

/** 参移单位的额度明细（A 整备段与 F 战斗段没有移动环节 ⇒ 用 `movementPhaseOf` 落到移动环节） */
const budgetRows = computed(() =>
  workbench.moveUnits.map((unit) => ({
    id: unit.instanceId,
    name: unit.name,
    ma: availableMaOf(unit, movementPhaseOf(workbench.phase)),
    spent: unit.mpSpent,
    remaining: availableMaOf(unit, movementPhaseOf(workbench.phase)) - unit.mpSpent,
    ended: unit.movementEnded,
  })),
)

/** 选中算子的本阶段可用 MA（6.1h 不取整；供界面显示额度） */
const selectedAvailableMa = computed(() => {
  const unit = workbench.selectedUnit
  if (unit === null) return 0
  return availableMaOf(unit, movementPhaseOf(workbench.phase))
})

/** 选中算子是否需要燃料且尚未加注（12.5a） */
const selectedNeedsFuel = computed(() => {
  const unit = workbench.selectedUnit
  return unit === null ? false : needsFuelOf(unit) && !unit.fuelled
})

/**
 * 12.5c：选中单位那枚燃料的**持续期**文案
 *
 * 三种加油法的持续期不同，是玩家最需要看见的一条：单单位法只在本阶段有效，
 * 换阶段即失效；编队法 / HQ 法持续到本方清理阶段（12.5d 才摘标记）。
 */
const selectedFuelDuration = computed(() => {
  const unit = workbench.selectedUnit
  if (unit === null || !unit.fuelled) return null
  if (unit.fuelMethod === 'singleUnit') return '单单位法（12.5c-C）：只在当前阶段有效——换阶段即失效'
  if (unit.fuelMethod === 'hq') return 'HQ 法（12.5c-B）：持续到本方清理阶段（12.5d）'
  if (unit.fuelMethod === 'formation') return '编队法（12.5c-A）：持续到本方清理阶段（12.5d）'
  return '未按规则记账：按持续到本方清理阶段处理'
})

/** 该单位是否需要燃料（12.5a；模板里直接用） */
function needsFuelOfUnit(unit: (typeof workbench.units)[number]): boolean {
  return needsFuelOf(unit)
}

/* ── 交互 ── */

function onPickRecord(event: Event): void {
  const id = (event.target as HTMLSelectElement).value
  const found = choiceOptions.value.find((option) => option.id === id)
  if (found !== undefined) workbench.pickRecord(found.record)
}

function onHexHover(hex: HexRef | null): void {
  workbench.setHoverHex(hex)
}

/**
 * 点地图：交给 `mapView` 的唯一入口
 *
 * 与对局台同一条分派链（突袭 / 撤退落点 / 推进格 / 战斗补给站 / 空军任务格 / 9.14 位移落点
 * → 最后才落到操作台的 `clickHex`）。此前本视图自己写了一份「只做初设落位 + clickHex」的
 * 简版分派，与对局台不一致；联调后统一走 `mapView`，两个视图点同一格做同一件事。
 */
function onHexClick(hex: HexRef, world: { x: number; y: number }): void {
  mapView.onHexClick(hex, undefined, world)
}

/** 燃料方法（本地单选状态） */
const fuelMethod = ref<'singleUnit' | 'formation' | 'hq'>('singleUnit')
/** 是否声明「共用同一来源」（12.5c-A 编队法 / 12.5e HQ 法） */
const fuelCommonSource = ref(true)

/** 12.3a：把下拉框的选择写进 store（燃料的付款来源） */
function pickFuelDumpFromView(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  workbench.pickFuelDump(value === '' ? null : value)
}

/* ── 视图挂载 ── */

/**
 * 与对局台对齐：进入操作台即按当前剧本做一次自动初设（幂等，见 `setup.ensureSetupLoaded`）。
 *
 * 全模块联调前，本视图没有任何挂载钩子 ⇒ 从开始台直接进操作台时盘面是空的
 * （只有先去过对局台才有算子），两视图行为不一致。这里补齐，保证「剧本 → 盘面」
 * 这条数据流在两个视图上是同一条。
 */
onMounted(() => {
  setup.ensureSetupLoaded()
})
</script>

<template>
  <div class="wb">
    <div class="wb__map">
      <div class="wb__mapbar">
        <BaseTag kind="info">操作台 U0 + 移动交互 C5</BaseTag>
        <label class="wb__check">
          <input
            :checked="workbench.stackSelect"
            type="checkbox"
            @change="workbench.setStackSelect(($event.target as HTMLInputElement).checked)"
          />
          整堆叠移动（6.1）
        </label>
        <label
          v-for="option in [
            { key: 'image', label: '扫描图' },
            { key: 'grid', label: '网格' },
            { key: 'labels', label: '格号' },
            { key: 'edges', label: '河/路/铁' },
          ] as const"
          :key="option.key"
          class="wb__check"
        >
          <input v-model="mapLayerToggles[option.key]" type="checkbox" />
          {{ option.label }}
        </label>
        <span class="muted num">共 {{ workbench.units.length }} 个算子</span>
        <BaseButton variant="ghost" size="sm" @click="ui.navigate('map')"
          >地图视图（C2）</BaseButton
        >
        <BaseButton variant="ghost" size="sm" @click="ui.navigate('home')">返回开始台</BaseButton>
      </div>

      <MapCanvas
        :layers="mapLayerToggles"
        :highlight-hex="workbench.hoverHex"
        :overlay="mapView.overlay"
        :hint="workbench.mapHint"
        @hex-click="onHexClick"
        @hex-hover="onHexHover"
      />

      <p class="muted">
        左键点己方算子＝选中并显示可移动范围 · 点范围内的格＝逐格移动（每格重算范围）·
        「结束移动」收工 · 右下面板可撤销/取消 · 圈内数字＝累计 MP（6.1a）
      </p>

      <!-- W7 D2：结算日志（结构化 / 可检索 / 可展开 / 重放复算）——放在地图下方取整幅宽度 -->
      <SettlementLogPanel />
    </div>

    <div class="wb__side">
      <!-- W6 C10：完整流程条（会话驱动）。★ 本页是**引擎验证页**：保留「推进一步」逐步核对 -->
      <FlowStrip stepwise />

      <!-- W7 C13：开局共识勾选列表（专规 4.0；选剧本后第一回合开始前须全部勾选） -->
      <ConsensusChecklist />

      <!-- W7 C14：初设与开局流程（剧本选择 → 编制抽取 → 卡车满载 → SP 归属 → 自动初设 →
           飞机初设 → 玩家自定义初设） -->
      <SetupPanel />

      <TerminationNotice />

      <BasePanel title="局况与切方（2.2 / 2.3 / 4.9a）">
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="hotseat.beginHandoff()">
            交接给{{ hotseat.opponentSide === 'axis' ? '轴心国' : '苏联' }}（热坐切屏）
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="workbench.switchSide()">
            直接切方（不遮屏）
          </BaseButton>
        </div>
        <div class="row">
          <label class="wb__field">
            <input
              type="checkbox"
              :checked="hotseat.hotseatEnabled"
              @change="hotseat.setHotseatEnabled(($event.target as HTMLInputElement).checked)"
            />
            启用热坐交接（交接时遮屏）
          </label>
          <span class="muted num">
            当前观察方：{{
              hotseat.viewerSide === 'axis' ? '轴心国' : '苏联'
            }}；对手堆叠只显示最上方单位（{{ hotseat.FOG_RULE }}）
          </span>
        </div>
        <p v-if="hotseat.stackOrderIssues.length > 0" class="warn num">
          堆叠顺序提示（{{ hotseat.STACK_ORDER_RULE }}）：
          <span v-for="(item, index) in hotseat.stackOrderIssues" :key="index">
            {{ item.hex.col }}.{{ item.hex.row }} —— {{ item.issue.detail }}；
          </span>
        </p>
        <p class="num muted">信息纪律：{{ hotseat.policy.detail }}</p>
        <div class="row">
          <BaseButton
            v-for="phaseOption in PHASE_OPTIONS"
            :key="phaseOption.key"
            variant="secondary"
            size="sm"
            @click="workbench.setPhase(phaseOption.key)"
          >
            {{ phaseOption.label }}{{ workbench.phase === phaseOption.key ? ' ✓' : '' }}
          </BaseButton>
        </div>
        <!-- 2.2 末段：H 清理阶段的通用自动清理（摘 DG/进击/燃料标记 + 移除对手的运输破坏标记） -->
        <div class="row">
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="workbench.phase !== 'cleanUp'"
            @click="workbench.runCleanUpNow()"
          >
            执行 H 段清理（2.2）
          </BaseButton>
          <span class="muted num">
            摘本人单位的 DG / 进击 / 燃料已补给标记（5.9 / 5.10 /
            12.5d），并移除对手的运输破坏标记（10.0c-C）
          </span>
        </div>
        <div class="row">
          <label class="wb__field">
            回合
            <input
              class="num"
              type="number"
              min="1"
              :max="turnMax"
              :value="workbench.turn"
              @change="workbench.setTurn(Number(($event.target as HTMLInputElement).value))"
            />
          </label>
          <span class="muted num">{{ workbench.date }}</span>
          <span class="muted num">（{{ turnDateOf(workbench.turn) }}）</span>
        </div>
        <div class="row">
          <label class="wb__field">
            种子
            <input
              class="num"
              type="number"
              :value="workbench.seed"
              @change="workbench.resetAll(Number(($event.target as HTMLInputElement).value))"
            />
          </label>
          <BaseTag kind="neutral">已掷 {{ workbench.drawCount }} 次</BaseTag>
          <BaseButton variant="ghost" size="sm" @click="workbench.rollDice()">掷 2d6</BaseButton>
        </div>
      </BasePanel>

      <BasePanel title="工具与摆算子">
        <div class="row">
          <BaseButton
            v-for="toolOption in [
              { key: 'move', label: '移动' },
              { key: 'place', label: '摆算子' },
              { key: 'battle', label: '打一仗' },
            ] as const"
            :key="toolOption.key"
            variant="secondary"
            size="sm"
            @click="workbench.setTool(toolOption.key)"
          >
            {{ toolOption.label }}{{ workbench.tool === toolOption.key ? ' ✓' : '' }}
          </BaseButton>
        </div>
        <div class="row">
          <select class="wb__select" @change="onPickRecord">
            <option value="">
              （选一个 {{ workbench.activeSide === 'axis' ? '轴心' : '苏联' }} 算子）
            </option>
            <option v-for="option in choiceOptions" :key="option.id" :value="option.id">
              {{ option.label }}
            </option>
          </select>
        </div>
        <p class="muted">
          待摆放：{{
            workbench.pendingRecord === null
              ? '—'
              : (workbench.pendingRecord.nameZh ?? workbench.pendingRecord.id)
          }}
        </p>
      </BasePanel>

      <BasePanel title="移动（C5：6.1 移动 / 6.1b 额度 / 6.1f 掉队）">
        <p v-if="workbench.moveInteraction === null" class="muted">
          选中一个己方算子（或勾选「整堆叠」后选中一堆叠）即开始移动，地图上会标出可到达范围。
        </p>
        <template v-else>
          <p class="num">
            参移：{{ workbench.moveUnits.map((unit) => unit.name).join(' + ') }}
            <BaseTag v-if="workbench.moveInteraction.finished" kind="warning">已结束</BaseTag>
            <BaseTag v-else kind="success">移动中</BaseTag>
          </p>
          <ul class="budget">
            <li v-for="row in budgetRows" :key="row.id" class="num">
              {{ row.name }}：MA {{ row.ma }} · 已耗 {{ row.spent }} · 剩 {{ row.remaining }}
              <span v-if="row.ended">· 本轮移动已结束</span>
            </li>
          </ul>
          <div class="row">
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="workbench.moveInteraction.steps.length === 0"
              @click="workbench.undoLastStep()"
            >
              撤销一步
            </BaseButton>
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="workbench.moveInteraction.steps.length === 0"
              @click="workbench.cancelWholeMove()"
            >
              取消本次移动
            </BaseButton>
            <BaseButton
              variant="primary"
              size="sm"
              :disabled="workbench.activeMoveUnits.length === 0"
              @click="workbench.finishMove()"
            >
              结束移动（6.1）
            </BaseButton>
          </div>
          <p class="muted num">可到达格：{{ workbench.groupReachable.hexes.length }} 个</p>
        </template>

        <p v-if="workbench.moveBlocked !== null" class="bad">
          <BaseTag kind="danger">{{ workbench.moveBlocked.rule }}</BaseTag>
          {{ workbench.moveBlocked.reason }}
        </p>

        <p v-if="previewText !== null" class="ok">
          <BaseTag kind="success">预览</BaseTag>
          {{ previewText }}
        </p>
        <p v-if="workbench.lastStep !== null" class="num ok">
          <BaseTag kind="success">上一步</BaseTag>
          <template v-if="workbench.lastStep.kind === 'end'">结束移动（6.1）</template>
          <template v-else>
            {{ workbench.lastStep.movedNames.join(' + ') }}：{{ workbench.lastStep.costText }}
          </template>
          <span v-if="workbench.lastStep.droppedNames.length > 0">
            · 掉队：{{ workbench.lastStep.droppedNames.join('、') }}（6.1f）
          </span>
          <span v-if="workbench.lastStep.zocStoppedNames.length > 0">
            · ZOC 停止：{{ workbench.lastStep.zocStoppedNames.join('、') }}（4.5a-A）
          </span>
        </p>
      </BasePanel>

      <BasePanel title="模式切换（5.4：开始移动时切换，不消耗 MP）">
        <p v-if="workbench.selectedUnit === null" class="muted">未选中</p>
        <template v-else>
          <p class="num">
            当前：{{ workbench.selectedUnit.mode.mode }}
            <span v-if="workbench.selectedUnit.mode.dg">+DG</span>
            <span v-if="workbench.selectedUnit.mode.exploit">+进击</span>
            · 朝向 {{ workbench.selectedUnit.mode.orientation === 'combat' ? '战斗面' : '移动面' }}
          </p>
          <div class="row">
            <BaseButton
              v-for="modeOption in MODE_OPTIONS"
              :key="modeOption.key"
              variant="secondary"
              size="sm"
              @click="workbench.switchUnitMode(modeOption.key)"
            >
              {{ modeOption.label
              }}{{ workbench.selectedUnit.mode.mode === modeOption.key ? ' ✓' : '' }}
            </BaseButton>
          </div>
          <div class="row">
            <BaseButton variant="ghost" size="sm" @click="workbench.flipUnitOrientation()">
              只改朝向（5.4 末句 DG / 5.7a 预备）
            </BaseButton>
          </div>
          <!-- 5.7b：释放预备＝摘掉预备标记、回朝向那一面；只在反应/进击阶段可行 -->
          <div class="row">
            <BaseButton variant="primary" size="sm" @click="workbench.releaseReserveNow()">
              释放预备（5.7b）
            </BaseButton>
            <span class="muted num">
              只在本方反应阶段（非阶段玩家，MA ×1/2）或进击阶段（阶段玩家，MA ×1）可行
            </span>
          </div>
        </template>
      </BasePanel>

      <BasePanel title="燃料支付（12.5：12.5a 需付 / 12.5c 三法）">
        <p v-if="workbench.moveUnits.length > 0" class="num">
          加油对象：{{
            workbench.moveUnits.map((unit) => unit.name).join('、')
          }}（本次移动的参移单位）
        </p>
        <p v-else-if="workbench.selectedUnit !== null" class="num">
          加油对象：{{ workbench.selectedUnit.name }}
          <span v-if="selectedNeedsFuel">· 需要燃料且未加注（12.5a）</span>
          <span v-else>· 不需要燃料或已加注</span>
        </p>
        <p v-else class="muted">先选中一个算子</p>

        <!-- 12.5c：这枚燃料能撑多久——单单位法只本阶段，编队/HQ 法到本方清理阶段 -->
        <p v-if="selectedFuelDuration !== null" class="muted num">
          燃料持续期：{{ selectedFuelDuration }}
        </p>

        <div class="row">
          <label v-for="option in FUEL_OPTIONS" :key="option.key" class="wb__radio">
            <input v-model="fuelMethod" type="radio" :value="option.key" />
            {{ option.label }}
          </label>
        </div>
        <div class="row">
          <label class="wb__check">
            <input v-model="fuelCommonSource" type="checkbox" />
            声明共用同一来源（12.5c-A 编队 / 12.5e HQ 投递距离内）
          </label>
        </div>
        <div class="row">
          <label class="wb__field">
            付款补给站（12.3a）
            <select
              class="num"
              :value="workbench.fuelDumpId ?? ''"
              @change="pickFuelDumpFromView($event)"
            >
              <option value="">（未声明 ⇒ 付不出）</option>
              <option v-for="dump in workbench.fuelDumpChoices" :key="dump.id" :value="dump.id">
                {{ hexLabel(dump.hex) }}（{{ dump.sp }} SP / {{ dump.t }} T）
              </option>
            </select>
          </label>
          <span class="muted num">
            获批来源：{{
              workbench.fuelDump === null ? '无' : `${hexLabel(workbench.fuelDump.hex)}`
            }}
          </span>
        </div>
        <div class="row">
          <BaseButton
            variant="primary"
            size="sm"
            @click="workbench.payFuel(fuelMethod, fuelCommonSource)"
          >
            支付燃料
          </BaseButton>
        </div>
        <p class="muted">
          12.3a/12.3b 是仅有的取补途径（用户裁定：补给只能从**己方补给站**扣）⇒
          燃料必须落到一座声明的补给站上，费用从该站真扣；原先那座「补给池」已不再作任何付款来源。
        </p>
      </BasePanel>

      <BasePanel title="选中算子">
        <p v-if="workbench.selectedUnit === null" class="muted">未选中（在地图上点一个算子）</p>
        <template v-else>
          <p class="num">
            {{ workbench.selectedUnit.name }} @ {{ workbench.selectedUnit.hex.col }}.{{
              workbench.selectedUnit.hex.row
            }}
          </p>
          <p class="muted num">
            A{{ workbench.selectedUnit.raw.attack }} AR{{ workbench.selectedUnit.raw.ar }} MA{{
              workbench.selectedUnit.raw.ma
            }}
            · {{ effectiveMobilityOf(workbench.selectedUnit) }} · {{ workbench.selectedUnit.re }}RE
            ·
            {{
              needsFuelOfUnit(workbench.selectedUnit)
                ? workbench.selectedUnit.fuelled
                  ? '已加注燃料'
                  : '未加注燃料'
                : '不需燃料'
            }}
          </p>
          <p class="muted num">
            本阶段已耗 MP {{ workbench.selectedUnit.mpSpent }} / 可用 MA {{ selectedAvailableMa }}
            <span v-if="workbench.selectedUnit.movementEnded"
              >· 本轮移动已结束（4.5a-A/6.1c/6.2b）</span
            >
            <span v-if="workbench.selectedUnit.mpLockedThisPhase"
              >· 已承诺本阶段不再消耗 MP（4.5b 垫人）</span
            >
          </p>
          <div class="row">
            <BaseButton
              variant="ghost"
              size="sm"
              @click="
                workbench.setUnitFuelled(
                  workbench.selectedUnit.instanceId,
                  !workbench.selectedUnit.fuelled,
                )
              "
            >
              {{ workbench.selectedUnit.fuelled ? '改为未加注' : '改为已加注' }}（12.5a）
            </BaseButton>
            <BaseButton
              variant="ghost"
              size="sm"
              @click="workbench.lockZocNegation(workbench.selectedUnit.instanceId)"
            >
              许诺抵消本格 ZOC（4.5b）
            </BaseButton>
            <BaseButton
              variant="danger"
              size="sm"
              @click="workbench.removeAt(workbench.selectedUnit.hex)"
            >
              移除
            </BaseButton>
          </div>
          <p v-if="workbench.selectedLegality !== null" class="muted num">
            前置校验（B21，仅本单位所在格）：{{
              workbench.selectedLegality.ok
                ? '通过（' + workbench.selectedLegality.checked.join('/') + '）'
                : workbench.selectedLegality.violations
                    .map((v) => `${v.family}:${v.reason}(${v.rule})`)
                    .join('；')
            }}
          </p>
        </template>
      </BasePanel>

      <!--
        批 C 切片 1：验证页保留**逐步复核**的手动入口（正式对局台不传 `stepwise` ⇒ 不渲染那些按钮）。
        口径：骰子与查表在正式界面自动连跑；这里仍可一步一步来，便于核对与复现。
      -->
      <CombatPanel stepwise />

      <BarragePanel />

      <AirPanel stepwise />

      <ReinforcementPanel />

      <ExclusiveRulesPanel />

      <!-- B16c：对局台的右栏已改为**只读**，故把 5.0c 的裁判工具（刷新账本 / 指定格控制 / 手动检查）
           保留在**引擎验证页**这一份上——不删裁判的退路（`referee` 属性） -->
      <VictoryPanel referee />

      <SupplyPanel />

      <!-- W7 C12：记录轨与容器管理（回合/天气/铁路容量轨 + 死亡堆与各类盒） -->
      <ContainersPanel />

      <!--
        B35：**引擎投影表**（从对局台的托盘搬到这里）
        用户口径 2026-09-16 #11：「辅助卡**只放卡图**（不要数据表那一面）」⇒ 托盘的"数据表"那一面撤掉，
        这一面（行 × 列 + 单元格文本）改在**验证页**保留：可核对、且这 10 个投影仍有调用点。
      -->
      <BasePanel
        title="引擎投影表（B16 十张：CRT / 补给 / 补员 / 特殊补员 / 重建 / TEC / 回合与天气 / 到货）"
      >
        <p class="muted">
          只读投影：单元格一律**照录数据文件**的结果代码与文本，便于逐格核对（对局台看的是印卡原卡）。
        </p>
        <template v-for="table in chartTables" :key="table.id">
          <ChartsTable
            :table="table"
            :footnotes="
              table.id === crtTableId
                ? crtFootnotes
                : table.id === tecTable?.id
                  ? tecFootnotes
                  : table.id === arrivalTableId
                    ? arrivalFootnotes
                    : undefined
            "
          />
        </template>
        <p v-if="chartTables.length === 0" class="muted">当前没有可显示的投影表。</p>
      </BasePanel>

      <BasePanel title="日志">
        <ul class="log">
          <li
            v-for="entry in workbench.log"
            :key="entry.id"
            class="log__item"
            :class="`log__item--${entry.kind}`"
          >
            <span v-if="entry.rule !== undefined" class="num log__rule">{{ entry.rule }}</span>
            {{ entry.text }}
            <!-- W7 C11：可展开的结算复核（骰点 / 计算过程 / 规则编号 / 修正来源） -->
            <details v-if="entry.derivation !== undefined" class="log__review">
              <summary class="num log__review-head">
                展开复核（{{ entry.derivation.rule }}）
              </summary>
              <DerivationSteps :derivation="entry.derivation" />
            </details>
          </li>
        </ul>
      </BasePanel>
    </div>

    <!-- 4.5a-A：进入敌方 ZOC 前必须让玩家确认（轮式单位进入后只能就地停止或突袭） -->
    <BaseDialog
      :open="workbench.pendingZocConfirm !== null"
      title="进入敌方控制区（4.5a-A）"
      width="440px"
      @update:open="
        (open) => {
          if (!open) workbench.dismissZocConfirm()
        }
      "
    >
      <p v-if="workbench.pendingZocConfirm !== null" class="num">
        目标格
        <strong>
          {{ workbench.pendingZocConfirm.to.col }}.{{ workbench.pendingZocConfirm.to.row }}
        </strong>
        处于未被抵消的敌方 ZOC。
      </p>
      <p>
        拥有轮式 MP 的单位进入敌方 ZOC
        后，<strong>必须在此处结束移动，或者进行突袭</strong>（4.5a-A）。 使用步行 MP 或履带 MP
        的移动不受任何影响（4.5a-A 括注）。
      </p>
      <p v-if="workbench.pendingZocConfirm !== null" class="muted num">
        进入后必须停止：{{
          workbench.pendingZocConfirm.preview.zocStoppingIds.map(nameOfUnit).join('、') || '—'
        }}
      </p>
      <!-- 4.5a-A 的后一支：**进入并立即突袭**（8.0；资格由引擎 8.1 系列给出） -->
      <div v-if="workbench.zocOverrunChoices.length > 0" class="zoc__branch">
        <p class="muted num">
          或选「突袭」这一支：进入后**立即**对相邻的敌方格发起突袭（8.1a：每次
          {{ OVERRUN_COST_MP }} MP；8.1b：进格消耗 ≤ {{ OVERRUN_COST_MP }} MP）。
        </p>
        <div class="row">
          <BaseButton
            v-for="choice in workbench.zocOverrunChoices"
            :key="`${choice.hex.col}.${choice.hex.row}`"
            variant="primary"
            @click="workbench.confirmZocEntryAndOverrun(choice.hex)"
          >
            进入并突袭 {{ choice.hex.col }}.{{ choice.hex.row }}（进格 {{ choice.entryCost }} MP +
            突袭 {{ choice.mpCost }} MP）
          </BaseButton>
        </div>
      </div>
      <p v-else class="muted num">
        进入后**没有**可突袭的目标（8.1a 的剩余 MP ≥ {{ OVERRUN_COST_MP }}、8.1b 的进格 ≤
        {{ OVERRUN_COST_MP }} MP、8.1 的可攻击与同格，缺一即不可）⇒ 只能就地停止。
      </p>
      <template #footer>
        <BaseButton variant="secondary" @click="workbench.dismissZocConfirm()">留在原格</BaseButton>
        <BaseButton variant="primary" @click="workbench.confirmZocEntry()"
          >确认进入并停止</BaseButton
        >
      </template>
    </BaseDialog>

    <!-- W6 C10：待答面板（由会话驱动；无关闭入口，只在内核裁决通过后消失） -->
    <QuestionPrompt />

    <!-- W7 C13：热坐交接屏（交接时遮罩盘面；未确认前不显示，依据 4.9a 的信息纪律） -->
    <HandoffOverlay />
  </div>
</template>

<style scoped>
.wb {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  gap: var(--space-4);
  align-items: start;
}

.wb__map {
  min-width: 0;
}

.wb__mapbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
}

.wb__check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.wb__radio {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.wb__side {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

/* 4.5a-A 的后一支：进入敌方 ZOC 后立即突袭（8.0/8.1） */
.zoc__branch {
  margin-top: var(--space-2);
}

.wb__field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.wb__field input {
  width: 74px;
}

.wb__select {
  width: 100%;
  max-width: 100%;
  padding: 4px var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.budget {
  list-style: none;
  margin: 0 0 var(--space-2);
  padding: 0;
  font-size: var(--text-xs);
  color: var(--color-muted);
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.ok {
  color: var(--color-accent-2);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.bad {
  color: var(--color-accent);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.log {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 260px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.log__item {
  font-size: var(--text-xs);
  padding: 3px var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
}

.log__item--warning {
  background: var(--color-warning-bg);
}

.log__item--danger {
  background: var(--color-danger-bg);
}

.log__item--success {
  background: var(--color-success-bg);
}

.log__rule {
  display: inline-block;
  min-width: 58px;
  color: var(--color-gold);
}

/* W7 C11：日志条目里的结算复核（默认收起，点开逐项核对） */
.log__review {
  margin-top: 2px;
}

.log__review-head {
  color: var(--color-accent);
  cursor: pointer;
}
</style>
