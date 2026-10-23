<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

import { BaseButton, BaseTag } from '@/components/base'
import { AirPanel } from '@/components/air'
import { BarragePanel } from '@/components/barrage'
import { CombatPanel } from '@/components/combat'
import { ContainersPanel } from '@/components/containers'
import { ExclusiveRulesPanel } from '@/components/exclusive'
import {
  ActionFeedbackStrip,
  BottomTray,
  DecisionQueue,
  HotkeyHelpPanel,
  MapActionPopover,
  UnitPanel,
} from '@/components/game'
import { HandoffOverlay } from '@/components/hotseat'
import { MapCanvas, MapDock } from '@/components/map'
import { MovePanel } from '@/components/move'
import { BreakoutPanel } from '@/components/breakout'
import { ReinforcementPanel } from '@/components/reinforcement'
import {
  FlowStrip,
  QuestionPrompt,
  SettlementLogPanel,
  TerminationNotice,
} from '@/components/session'
import { SetupPanel } from '@/components/setup'
import { SupplyPanel } from '@/components/supply'
import { VictoryPanel } from '@/components/victory'
import type { HexRef } from '@/data'
import { DEFAULT_MAP_LAYERS } from '@/render/map-render'
import {
  useHotkeyStore,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 对局台（W7 C16：**可以打完整一局**的主页面）
 *
 * ## 这一页要解决什么
 *   旧「操作台」（`WorkbenchView`）是**引擎验证入口**：所有面板平铺、操作对象是表单。
 *   对局台则是**按规则书的操作方式**做的正式界面：
 *   · **地图优先**：能在地图上做的选择不搬进侧栏 —— 选算子/堆叠、定目标格、点撤退落点、
 *     点推进格、点补给站、发起突袭，全部在盘面上完成（`MapActionPopover` 就地展开结论与按钮）；
 *   · **侧栏只放流程与账本**：回合流程条（FlowStrip）、共识勾选、初设、以及战斗/炮击/空军/补给/
 *     增援/容器/胜利/日志这些「需要长列表」的面板（可用 `H` 折叠）；
 *   · **全流程可玩**：初设（C14）→ 流程推进（C10）→ 移动与突袭（C5/C16）→ 战斗与轰炸（C6/C7）→
 *     空军（C9）→ 补给（C8）→ 增援（B18）→ 胜利（B20）→ 存档（C15）。
 *
 * ## 快捷键（C16）
 *   挂载时 `hotkeys.bind()`，卸载时 `unbind()`；地图的缩放/适配通过 `setViewBridge` 登记，
 *   故快捷键层不需要知道视口怎么算（职责分离，见 `stores/hotkeys.ts`）。
 *
 * ## 分层纪律（CODE_SPEC）
 *   本视图**不做任何规则计算**：一切结论来自 store（最终来自 `engine/rules`）；
 *   这里只「画图 + 收点击 + 显示结论」。
 */

const workbench = useWorkbenchStore()
const mapView = useMapViewStore()
const hotkeys = useHotkeyStore()
const setup = useSetupStore()
/** B36：交接（切方）走 hotseat 的流程 —— 与热键 T 同一条路 */
const hotseat = useHotseatStore()

/** 地图能力（`MapCanvas` 通过 defineExpose 暴露；用结构类型接，避免跨层耦合组件类型） */
interface MapBridge {
  zoomIn: () => void
  zoomOut: () => void
  fitToWindow: () => void
  hexToLocal: (hex: HexRef) => { x: number; y: number }
  /** 格 → **窗口**坐标（小窗是 `position: fixed`，必须用窗口坐标锚定） */
  hexToWindow: (hex: HexRef) => { x: number; y: number }
  viewportSize: () => { width: number; height: number }
}
const mapRef = ref<MapBridge | null>(null)

/** 地图图层开关（C2 的 MapCanvas 消费） */
const mapLayerToggles = reactive({ ...DEFAULT_MAP_LAYERS })

/*
 * ★ B35（用户口径 #10）：**"移动 / 战斗"工具按钮已从对局台删除** ——
 * 「各阶段什么单位能干什么事是按规则定好的，地图窗口上方的移动和战斗按钮在对局界面是不需要的」。
 * 现在"点地图算不算在选战斗"由**闸门推**（`workbench.combatPickActive` ＝ 本环节允许 `combat.declare`），
 * 不再让玩家先切一个工具。`workbench.tool` 本体保留（引擎验证页与流程用例仍显式切它）。
 */

/** 当前方的中文名 */
const sideLabel = computed(() => (workbench.activeSide === 'axis' ? '轴心国' : '苏联'))

/*
 * ★ 已删（2026-09-16）「摆算子」工具与它的单位清单
 *
 * 用户口径：「**正式游戏界面不应有摆算子的操作，应该完全由流程驱动**」。
 * 原先这条工具条可以把单位库里的任意算子放到地图任意格（为"玩家自定义初设"留的口子），
 * 但它绕过了所有流程与账本：不问阶段、不问到货、不问重建条件。
 * 现在算子进场一律走流程——
 *   · 初设（IV）：`SetupPanel` / `DecisionQueue` 的四堆叠与候选格；
 *   · 增援到货（13.6）：`ReinforcementPanel` 的到达表逐条投放（库中型号在**那一行**选）；
 *   · 重建（13.5）与方面军预备队（专规 2.3c）：各自面板里的动作。
 * 自由摆放只保留在**引擎验证页**（`WorkbenchView`），那里不受对局界面口径约束。
 */

/**
 * 当前一行的操作提示（按盘面上正在发生的事给，而不是常驻一堆说明）
 *
 * ★ B17：这一行**搬进流程条**了（用户口径「地图窗口上方不应该有消息栏」），
 *   计算也搬到了 `map-view.actionHint`（它手上同时有 workbench 与本店的三个 hint）。
 *   本视图不再自留一份，免得两处各说一套"现在该干什么"。
 */

/** 点地图：交给 `mapView` 的唯一入口（内含就地展开 / 突袭 / 撤退 / 推进 / 补给站 / 空军任务格的分派） */
function onHexClick(hex: HexRef, world: { x: number; y: number }): void {
  // ★ M9④：小窗是 `position: fixed` ⇒ 锚点必须是**窗口**坐标（画布不在窗口原点时，
  //   用视口内坐标会让小窗整体偏掉一个容器偏移量：顶栏/工具条越高、偏得越多）。
  const anchor = mapRef.value?.hexToWindow(hex) ?? { x: 0, y: 0 }
  // `world` 原样来自画布（B3）：堆叠就地展开要靠它判点到了哪一枚，视图不做二次换算
  mapView.onHexClick(hex, anchor, world)
}

function onHexHover(hex: HexRef | null): void {
  workbench.setHoverHex(hex)
}

/* ── 唯一会话框（B4，方案 §4.3）──
   用户口径：这些页面只在单位于相应阶段执行操作时才在地图上展开，默认停在地图窗口右上角
   （`.mapcanvas__viewport` 的右上角，由 `MapDock` 负责），可拖动以免挡视线。
   ★ 「同一时刻只挂载一个」由 `mapView.session` 保证：本视图只渲染它给的那**一个**会话，
     不再各自 `v-if` —— 否则加了第三个状态机就会出现两个面板叠在一起。 */

/** 当前会话（引擎状态驱动；判据都在 store 里，视图不做规则判断） */
const session = computed(() => mapView.session)

/* ── 快捷键接线（挂载绑、卸载解；地图能力登记给快捷键层） ── */

onMounted(() => {
  // ★ 进入对局台即按当前剧本做一次自动初设（固定格号 / 死亡堆 / 多点位 / 计数类算子）——
  //   幂等：已落盘或盘上已有算子即跳过，故视图来回切换不会叠加。
  setup.ensureSetupLoaded()
  hotkeys.bind()
  hotkeys.setViewBridge({
    zoomIn: () => mapRef.value?.zoomIn(),
    zoomOut: () => mapRef.value?.zoomOut(),
    fit: () => mapRef.value?.fitToWindow(),
    closePopup: () => {
      if (mapView.popup === null) return false
      mapView.closePopup()
      return true
    },
    // B3：就地摊开的堆叠由地图自己收（Esc 链里排在小窗之前）
    collapseStack: () => mapView.collapseStack(),
    // B4：会话框排在最前（它是最后发生的事，也最"重"——取消它是玩家按下 Esc 时最可能想要的）
    cancelSession: () => mapView.cancelSession(),
  })
})

onBeforeUnmount(() => {
  hotkeys.unbind()
  hotkeys.setViewBridge(null)
})
</script>

<template>
  <div class="gt">
    <div class="gt__main">
      <!-- 状态条：一眼看清「谁在动、走到哪一步、工具是哪个」 -->
      <div class="gt__bar">
        <BaseTag kind="info">对局台（C16）</BaseTag>
        <span class="gt__stat num">{{ sideLabel }} · 回合 {{ workbench.turn }}</span>
        <span class="gt__stat num">{{ workbench.date }}</span>
        <!--
          用户 2026-09-16：「切方移至上方位置」⇒ 从右栏的「局况与切方」搬到这里。
          为什么它该在上方：**切方是热坐换手的台面操作**（每换一次手都要点），
          放在展开的地图工具条上比塞在右栏底部顺手；右栏随之只留只读信息（决定①）。
        -->
        <!--
          B36（方案 §3 步骤 4）：**交给对手要走交接流程**（与热键 T 同一条路）。
          修前这里直接 workbench.switchSide() ⇒ 交接屏永远不出现（热坐的遮屏形同虚设）。
          solo 模式下 beginHandoff 内部不亮屏（hotseatEnabled 由 mode 推出）⇒ 一个入口两种模式都对。
        -->
        <BaseButton variant="primary" size="sm" @click="hotseat.beginHandoff()">
          交给{{ hotseat.opponentSide === 'axis' ? '轴心国' : '苏联' }}（{{ hotseat.mode }}）
        </BaseButton>
        <!--
          ★ 批 C 切片 1（用户口径 9.16 #11「测试味控件在正式界面」）：**「自由掷骰」已从对局台移走** ——
            正式流程里的骰子都由各自的动作触发（战斗 9.8/9.9、轰炸 10.0、空军 14.3/14.4、
            损耗 12.8 等，一律走种子化 RNG 并留痕）；手动掷骰只在**引擎验证页**（`WorkbenchView`）保留。
        -->
        <label class="gt__check">
          <input
            :checked="workbench.stackSelect"
            type="checkbox"
            @change="workbench.setStackSelect(($event.target as HTMLInputElement).checked)"
          />
          整堆叠（S）
        </label>
        <label
          v-for="option in [
            { key: 'image', label: '扫描图' },
            { key: 'grid', label: '网格' },
            { key: 'labels', label: '格号' },
            { key: 'edges', label: '河/路/铁' },
            { key: 'control', label: '控制标记' },
          ] as const"
          :key="option.key"
          class="gt__check"
        >
          <input v-model="mapLayerToggles[option.key]" type="checkbox" />
          {{ option.label }}
        </label>
        <!-- 4.5：ZOC 覆盖层（数据出自引擎的 `zocHexes`）——默认关，开启后铺出双方的 ZOC 覆盖格 -->
        <label class="gt__check">
          <input v-model="mapView.zocLayerVisible" type="checkbox" />
          ZOC（4.5）
        </label>
        <!--
          B37（方案 §3 步骤 2 后半）：**专规会话不再靠这个常驻按钮** —— 它改为
          "本环节有可做的专规动作时自动出现"（判据＝闸门 `exclusiveActionsInStep`）。
          按钮已删；顶栏只留图层开关与切方/掷骰（与口径 #6 / #10 同一方向）。
        -->
        <BaseButton
          variant="ghost"
          size="sm"
          @click="hotkeys.panelCollapsed = !hotkeys.panelCollapsed"
        >
          侧栏（H）{{ hotkeys.panelCollapsed ? '展开' : '折叠' }}
        </BaseButton>
        <BaseButton variant="ghost" size="sm" @click="hotkeys.helpOpen = !hotkeys.helpOpen">
          快捷键（?）
        </BaseButton>
      </div>

      <!--
        ★ 用户 2026-09-16：「**地图窗口上方不应该有消息栏**」。
          故原先这里的「一行动作提示」与「操作反馈」两块都被搬走：
            · 动作提示 ⇒ 流程条（方案 §4.5 的「动作提示带」，读 `mapView.actionHint`）；
            · 操作反馈 ⇒ 右栏流程条下方（`ActionFeedbackStrip`）。
          地图上方只剩**一条流程条**（B35：阶段名 / 环节名 / 推进按钮 / 一行该做什么）
          与图层开关、切方、掷骰；工具按钮已删（口径 #10）。
        ★ 同日再改：**摆算子工具条整块删除** —— 正式界面不摆算子，算子进场一律走流程
          （初设 / 增援到货 / 重建 / 方面军预备队）。
      -->

      <!-- B35（用户口径 #6）：**流程条画成一条线放在地图窗口上方**，只留关键字 -->
      <FlowStrip variant="bar" />

      <MapCanvas
        ref="mapRef"
        :layers="mapLayerToggles"
        :highlight-hex="workbench.hoverHex"
        :overlay="mapView.overlay"
        :control-markers="mapView.controlMarkers"
        :boundary="mapView.boundary"
        :construction-markers="workbench.constructionMarkerPieces"
        :hint="workbench.mapHint"
        @hex-click="onHexClick"
        @hex-hover="onHexHover"
      >
        <!-- **唯一会话框**：同一时刻只这一个（战斗/突袭 · 轰炸）；流程一结束即自动消失 -->
        <template #overlay>
          <!-- B11：待你决定的队列（初设四堆叠）压在地图窗口左上角；初设收束后自动消失 -->
          <DecisionQueue v-if="setup.applied && !setup.finished" />
          <MapDock
            v-if="session !== null"
            :key="session.kind"
            :session-key="session.kind"
            :title="session.title"
            :rule="session.rule"
            :width="session.width"
            @close="mapView.cancelSession()"
          >
            <CombatPanel v-if="session.kind === 'combat'" />
            <BarragePanel v-else-if="session.kind === 'barrage'" />
            <!-- B15a：移动 / 突袭的操作链（6.1 撤销一步/结束/放弃、6.1f 放下、4.5a-A ZOC 待决） -->
            <!-- B15d/B15e：空军任务链与补给检查链（各只画"动作"那一段，事务段留在侧栏） -->
            <AirPanel v-else-if="session.kind === 'air'" only="mission" />
            <SupplyPanel v-else-if="session.kind === 'supply'" only="check" />
            <!--
              ★ R1（条 5）：增援段全程**只有一个**会话框，内容按子环节渐变（到达 → 掷补员表 → 照放 → 重建）。
              故无论当前在增援段的哪一子环节，都渲染同一份 ReinforcementPanel（不传 `only`，
              让其按 segmentStep 同时呈现 info / actions / rebuild 三段并随环节渐变）。
            -->
            <ReinforcementPanel v-else-if="session.kind === 'reinforce'" />
            <BreakoutPanel v-else-if="session.kind === 'breakout'" />
            <!-- B17a-2：盒内动作（托盘里展开一张盒卡即触发；盒卡只负责"选谁"） -->
            <ContainersPanel v-else-if="session.kind === 'containers'" only="actions" />
            <!-- B17a-3：专规动作（顶栏「专规动作」按钮打开；跨多个段，故不按环节触发） -->
            <ExclusiveRulesPanel v-else-if="session.kind === 'exclusive'" only="actions" />
            <!-- 条 12（M2）：点非战斗单位（SP/运输点/延补队/基地/工事）⇒ 按类型分派到既有动作面板 -->
            <UnitPanel v-else-if="session.kind === 'unit'" />
            <MovePanel v-else />
          </MapDock>
        </template>
      </MapCanvas>

      <!-- B12：底部托盘（左「盒」右「表格」；两段默认折叠为一行、同时只展开一段） -->
      <BottomTray />

      <!-- 就近小窗：按当前盘面分派（战斗收尾 / 堆叠展示 / 空军任务 / 补给站） -->
      <MapActionPopover />

      <!-- 结算日志（结构化 / 可展开复核 / 可重放） -->
      <SettlementLogPanel />
    </div>

    <!-- 侧栏：流程与账本（H 折叠） -->
    <aside v-show="!hotkeys.panelCollapsed" class="gt__side">
      <!--
        ★ 批 D 切片 1（方案 §3 批 D 步骤 1，用户口径 #6）：**右栏那份 panel 形态流程条已删** ——
          流程条只保留**地图上方那条线**（`variant="bar"`，只留阶段 / 环节 / 推进 / 一行提示）；
          右栏从此只放**只读信息**（操作反馈 / 初设明细 / 终局提示 / 各面板的 info 段）。
          panel 形态本身仍在（引擎验证页 `WorkbenchView` 用 panel 形态那份），故未删组件分支。
      -->
      <!-- 操作反馈（M9②）：引擎带规则号的解释与「这一步被拒」的原因。
           ★ 用户 2026-09-16：地图上方不放消息栏 ⇒ 它搬到这里（流程条下方）。
           共识勾选**已删**（用户决定①「右栏只读」；共识是**开局前的约定**，
           前置视图 `ScenarioSetupView` 那一份才是入口） -->
      <ActionFeedbackStrip />
      <SetupPanel />
      <TerminationNotice />

      <!--
        ★ B35（用户口径 #18「对局窗口不要出现太多规则文字，有标题即可」）：
        原「局况与观察方」「燃料与补给来源」两块**纯文字面板**与「战斗/轰炸面板在哪」两段说明已删。
        必需的信息改由①**状态条**（观察方就在地图上方）与②各面板**自己的标题+必要一行**承担。
      -->

      <!--
        ★ 条 12（M2）：**右栏只读**——原可写面板 `AirPanel only="admin"` / `SupplyPanel only="ledger"`
          已收进**会话**（点对应的非战斗单位即开 `unit` 会话，见 `<UnitPanel>`）；
          右栏从此只剩只读信息（ ReinforcementPanel / ExclusiveRulesPanel 均只挂 info 段）。
      -->
      <ReinforcementPanel only="info" />
      <ExclusiveRulesPanel only="info" />
      <VictoryPanel />
      <ContainersPanel only="info" />
      <HotkeyHelpPanel />
    </aside>

    <!-- 待答面板（会话驱动）与热坐交接屏 -->
    <QuestionPrompt />
    <HandoffOverlay />
  </div>
</template>

<style scoped>
.gt {
  display: grid;
  /* B35：右栏只读 ⇒ 400px 收窄到 320px（口径 #18 的"少占地方、少写规则文字"） */
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: var(--space-4);
  align-items: start;
}

.gt__main {
  min-width: 0;
}

.gt__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.gt__stat {
  color: var(--color-muted);
  font-size: var(--text-xs);
}

.gt__check {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-muted);
}

/* B17：`.gt__hint`（地图上方那一行消息栏）已随提示带一起搬进流程条 ⇒ 样式删除 */

/* B21：摆算子工具条的样式（含它那个下拉框）随工具一起删除 */

.gt__side {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* B17：`.gt__row` 随「局况与切方」那块面板一起删（切方已搬到地图上方的工具条） */

.gt__muted {
  color: var(--color-muted);
  font-size: var(--text-xs);
  margin: var(--space-1) 0;
}

/* 9.2 战斗 / 10.0 轰炸的结算面板已抽到 `components/map/MapDock.vue`
   （默认停在地图窗口右上角、可拖动）——本视图不再自带定位样式。 */
</style>
