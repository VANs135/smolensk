<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import { BaseButton, RuleTip } from '@/components/base'
import { AirPanel } from '@/components/air'
import { BarragePanel } from '@/components/barrage'
import { OpsFlowPanel } from '@/components/ops'
import { CombatPanel } from '@/components/combat'
import { ContainersPanel } from '@/components/containers'
import { ExclusiveRulesPanel } from '@/components/exclusive'
import {
  ActionFeedbackStrip,
  BoxCard,
  ChartTableDrawer,
  DecisionQueue,
  HotkeyHelpPanel,
  MapActionPopover,
  OverstackPanel,
  UnitPanel,
} from '@/components/game'
import type { AuxCardView } from '@/stores/containers'
import { MapCanvas, MapDock } from '@/components/map'
import { MovePanel } from '@/components/move'
import { FuelPanel } from '@/components/fuel'
import { BreakoutPanel } from '@/components/breakout'
import { ReinforcementPanel } from '@/components/reinforcement'
import {
  FlowStrip,
  QuestionPrompt,
  SettlementLogPanel,
  TerminationNotice,
} from '@/components/session'
import { SupplyPanel } from '@/components/supply'
import SupplyPhasePanel from '@/components/supply/SupplyPhasePanel.vue'
import { TutorialGuide } from '@/components/tutorial'
import { provideUiMode } from '@/components/ui-mode'
import { useBoxRail } from '@/components/game/box-rail'
import { VictoryDialog, VictoryPanel } from '@/components/victory'
import type { HexRef } from '@/data'
import { COUNTER_BOX_LABELS, type CounterBoxTarget } from '@/stores/map-view'
import { DEFAULT_MAP_LAYERS } from '@/render/map-render'
import {
  useAppStore,
  useContainersStore,
  useGameSessionStore,
  useHotkeyStore,
  useHotseatStore,
  useMapViewStore,
  useRecorderStore,
  useSetupStore,
  useThemeStore,
  useUiStore,
  useWorkbenchStore,
} from '@/stores'

import { createAiMemory, runAiStep } from '@/ai/driver'
import type { AiControlMode } from '@/ai/policy'
import { isAndroidPlatform } from '@/shared/platform'

/** 安卓壳专用布局开关：教学卡内联顶栏（桌面保持悬浮独立卡） */
const androidUi = isAndroidPlatform()

/**
 * 2026-11-19（用户口径）：安卓顶栏右侧不再用一排抽象图标 ——
 * 三个文字标记（死人堆 / 空军盒 / 苏军盒）一步直达对应盒卡弹窗；⚙ 点开全部抽屉菜单。
 * 苏军图外盒只有苏联视角才有（苏军援军从图外进场）。
 */
const quickMenu = ref(false)

type QuickBoxKind = 'dead_pile' | 'air_box' | 'offboard'

const quickBoxes = computed<{ label: string; kind: QuickBoxKind }[]>(() => {
  const list: { label: string; kind: QuickBoxKind }[] = [
    { label: '死人堆', kind: 'dead_pile' },
    { label: '空军盒', kind: 'air_box' },
  ]
  if (hotseat.viewerSide === 'soviet') list.push({ label: '苏军盒', kind: 'offboard' })
  return list
})

/** 一步直达：不开盒表抽屉，直接弹独立的盒面浮窗（用户 2026-11-19「不要出现盒列表」） */
const quickBoxCard = ref<AuxCardView | null>(null)

function focusBox(kind: QuickBoxKind): void {
  const side = hotseat.viewerSide
  const card =
    containers.cardViewsOf(side).find((item) => item.boxKind === kind) ??
    containers.sharedCardViews.find((item) => item.boxKind === kind)
  if (card === undefined) return
  quickBoxCard.value = card
  containers.setPopupCard(card.id)
}

function closeQuickBox(): void {
  containers.setPopupCard(null)
  quickBoxCard.value = null
}

function openQuickDrawer(next: TableDrawer): void {
  openDrawer(next)
  quickMenu.value = false
}

function openSaveFromMenu(): void {
  ui.openSaveDialog()
  quickMenu.value = false
}

const workbench = useWorkbenchStore()
const mapView = useMapViewStore()
const containers = useContainersStore()
const hotkeys = useHotkeyStore()
const setup = useSetupStore()
const gameSession = useGameSessionStore()
const hotseat = useHotseatStore()
const theme = useThemeStore()

const ui = useUiStore()
const app = useAppStore()
const recorder = useRecorderStore()

provideUiMode('formal')

/**
 * AI 控制方（2026-11-09：由选剧本时定下的对局模式推出，顶栏不再给开关）
 *
 *   · PVE + AI 方已定 ⇒ AI 打该方；
 *   · PVP / solo / 未定 ⇒ `off`（双方都由人操作）。
 * 规则边界：这只是"谁操作哪一方"的组织方式；AI 仍只走既有具名入口，判据全在引擎。
 */
const aiControlMode = computed<AiControlMode>(() =>
  hotseat.mode === 'pve' && hotseat.aiSide !== null ? hotseat.aiSide : 'off',
)
const aiWaiting = ref('')
let aiMemory = createAiMemory()
let aiTimer: ReturnType<typeof setTimeout> | null = null

const modeLabel = computed<string>(() => {
  if (hotseat.mode === null) return '未设置'
  if (hotseat.mode === 'pvp') return 'PVP · 双人热坐'
  if (hotseat.mode === 'solo') return 'SOLO · 单人'
  const aiSide = hotseat.aiSide === 'axis' ? '轴心国' : '苏联'
  return `PVE · AI 打${aiSide}`
})

/**
 * 继续闸门：读档后模式未设置（或 PVE 缺 AI 方）⇒ 必须先重选才能继续
 *
 * 选择前：`aiControlMode` 为 `off`（AI 不接管）、`hotseatEnabled` 为 false（不按 PVP 遮屏）。
 * 只是对局组织方式，不参与规则判定。
 */
const modeGate = computed<boolean>(() => gameSession.session !== null && hotseat.modeGateNeeded)
const gateSides = [
  { side: 'axis', label: '轴心国' },
  { side: 'soviet', label: '苏联' },
] as const

function stopAiPlay(): void {
  if (aiTimer !== null) {
    clearTimeout(aiTimer)
    aiTimer = null
  }
}

function scheduleAiStep(delayMs = 0): void {
  aiTimer = setTimeout(() => {
    aiTimer = null
    if (aiControlMode.value === 'off') return
    const result = runAiStep(
      { workbench, session: gameSession, setup },
      { memory: aiMemory, control: aiControlMode.value },
    )
    aiWaiting.value = result.waiting ?? ''
    if (gameSession.terminated || result.intent === 'none') {
      stopAiPlay()
      return
    }
    // 玩家侧待办 ⇒ 保持开启、稍后再试；一旦玩家做完决定就自动续跑
    scheduleAiStep(result.intent === 'wait' ? 600 : 0)
  }, delayMs)
}

// 模式在选剧本页定下、进初设即锁定 ⇒ 进棋桌时按当前模式启动（PVE 才有 AI）
watch(
  aiControlMode,
  () => {
    stopAiPlay()
    aiWaiting.value = ''
    aiMemory = createAiMemory()
    if (aiControlMode.value !== 'off') scheduleAiStep()
  },
  { immediate: true },
)

interface MapBridge {
  zoomIn: () => void
  zoomOut: () => void
  fitToWindow: () => void
  hexToWindow: (hex: HexRef) => { x: number; y: number }
}

type TableDrawer = 'status' | 'charts' | 'log' | 'settings'

const drawers = [
  { id: 'status', label: '战况', icon: 'M3 12h4l3-7 4 14 3-7h4' },
  { id: 'charts', label: '表', icon: 'M4 4h16v16 M4 10h16 M10 4v16' },
  { id: 'log', label: '战报', icon: 'M6 3h9l3 3v15H6z M9 10h6 M9 14h6 M9 17h4' },
  { id: 'settings', label: '设置', icon: 'M4 7h16 M4 17h16 M9 4v6 M15 14v6' },
] as const

/** 左栏主列（抽屉开关）：2026-11-26（用户）「设置」不在此列，与存档、撤销一起收在栏底三枚相邻 */
const railDrawers = drawers.filter((item) => item.id !== 'settings')

/** 左栏盒组（2026-11-26）：分组逻辑与图标在 `components/game/box-rail.ts`（隔离口径单独守），这里只拿成品 */
const { groups: boxRailGroups, anchorCards: boxAnchorCards, iconPath: boxIconPath } = useBoxRail()

const layers = [
  { key: 'image', label: '扫描图' },
  { key: 'grid', label: '网格' },
  { key: 'labels', label: '格号' },
  { key: 'edges', label: '河 / 路 / 铁' },
  { key: 'control', label: '控制标记' },
] as const

const mapRef = ref<MapBridge | null>(null)

/** 教学模式指格子时用的地图桥（窗口坐标；没挂地图就退回不画环） */
function tutorialHexToWindow(hex: HexRef): { x: number; y: number } | null {
  return mapRef.value?.hexToWindow(hex) ?? null
}

const mapLayerToggles = reactive({ ...DEFAULT_MAP_LAYERS })
const drawer = ref<TableDrawer>('status')
const openedDrawers = reactive(new Set<TableDrawer>())
const session = computed(() => mapView.session)
/**
 * 用户 2026-11-13：空军任务窗按三面板给标题（① 选飞机发起 → ② 结算任务 → ③ 返航），
 * 不再用引擎七步的措辞（空战 / 拦截 / 防空是窗内的即时裁定，不单独当一步）。
 */
const airStageTitle = computed(() => {
  const step = workbench.airState?.step
  if (step === 'returnToBase') return '返航'
  if (step === 'resolveMission') return '结算任务'
  return '选飞机发起任务'
})
const sessionTitle = computed(() => {
  const current = session.value
  if (current === null) return ''
  /*
   * C2（用户 2026-11-17 实走）：空军三面板副题只属于 `kind === 'air'`。
   * 修前 `kind === 'ops'` 也拼了 `airStageTitle` ⇒ 地面炮击窗写成
   * 「炮击（10.1） · 格 10.28 · 选飞机发起任务」。ops 自带「格 X · 任务」标题，不再加副题。
   */
  return current.kind === 'air' ? `${current.title} · ${airStageTitle.value}` : current.title
})
const panelCollapsedOnEnter = hotkeys.panelCollapsed

function openDrawer(next: TableDrawer): void {
  drawer.value = next
  openedDrawers.add(next)
  hotkeys.panelCollapsed = false
}

/*
/*
 * 2026-11-25：盒面常驻地图下方（托盘只剩盒段），重建教学的「开盒 / 关盒」不再需要代劳——
 * 引导只指卡头，玩家不必在抽屉与地图之间来回切。原 `openDrawer('cards')` 的自动开合已删。
 */

function toggleDrawer(next: TableDrawer): void {
  if (!hotkeys.panelCollapsed && drawer.value === next) {
    hotkeys.panelCollapsed = true
    return
  }
  openDrawer(next)
}

watch(
  () => hotkeys.panelCollapsed,
  (collapsed) => {
    if (!collapsed) openedDrawers.add(drawer.value)
  },
)
watch(
  () => hotkeys.helpOpen,
  (open) => {
    if (open) openDrawer('settings')
  },
)

function showKeys(): void {
  hotkeys.helpOpen = !hotkeys.helpOpen
}

/**
 * ⑧ 对局记录（用户回报 BUG 用）
 *
 * 只把**既有事实**投给记录器（日志/结算/回合阶段环节/行动方）；不写规则判断、
 * 不发网络请求、不写存档。导出走浏览器下载（桌面 WebView 同样落到下载目录）。
 */
const canRecord = computed<boolean>(() => gameSession.session !== null)

function startRecording(): void {
  const state = gameSession.session?.state
  if (state === undefined) return
  recorder.start({
    appVersion: app.appVersion,
    appCommit: app.appCommit,
    scenarioId: gameSession.scenarioId,
    scenarioName: gameSession.scenarioInfo?.name ?? '',
    mode: hotseat.mode,
    aiSide: hotseat.aiSide,
    seed: state.rng.seed ?? null,
    turn: workbench.turn,
    phase: workbench.phase,
  })
}

function saveRecording(): void {
  const file = recorder.stop()
  if (file === null) return
  try {
    const blob = new Blob([file.text], { type: 'application/jsonl;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file.filename
    anchor.rel = 'noopener'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch {
    // 导出失败不得影响对局
  }
}

function toggleRecording(): void {
  if (recorder.active) saveRecording()
  else startRecording()
}

const mapCounterDrag = ref<string | null>(null)
const airBoxMenu = ref<{ id: string; x: number; y: number } | null>(null)
const setupBoxOpen = ref(false)
const setupBoxSide = computed(() => (setup.finished ? null : setup.setupSideCursor))
const setupBoxAircraft = computed(() =>
  workbench.airUnits.filter(
    (air) => air.side === setupBoxSide.value && workbench.airBoxMembers.includes(air.instanceId),
  ),
)
const boxDropTargets = computed<readonly CounterBoxTarget[]>(() => {
  if (mapCounterDrag.value !== null) return mapView.counterBoxTargets(mapCounterDrag.value)
  return setupBoxSide.value === null ? [] : ['air']
})
watch([setupBoxSide, () => setup.scenarioId], () => {
  airBoxMenu.value = null
  mapCounterDrag.value = null
  setupBoxOpen.value = false
})

function onMapContext(
  hex: HexRef | null,
  world: { x: number; y: number },
  anchor: { x: number; y: number },
  scale: number,
): void {
  airBoxMenu.value = null
  if (!setup.finished && hex !== null) {
    const counter = mapView.counterForBoxAt(hex, world, scale)
    if (counter?.targets.includes('air')) {
      airBoxMenu.value = {
        id: counter.id,
        x: Math.max(8, Math.min(anchor.x, window.innerWidth - 220)),
        y: Math.max(8, Math.min(anchor.y, window.innerHeight - 42)),
      }
      return
    }
  }
  mapView.onHexContext(hex, world, anchor, scale)
}

function onCounterDrop(
  id: string,
  point: { x: number; y: number },
  hex: HexRef | null,
  path: readonly HexRef[] = [],
): void {
  const target = document
    .elementFromPoint(point.x, point.y)
    ?.closest<HTMLElement>('[data-counter-box]')
  const box = boxDropTargets.value.find((item) => item === target?.dataset.counterBox)
  if (box !== undefined) {
    mapView.dropCounterInBox(id, box)
    return
  }
  // H1：拖到图外（hex === null）不落子；地图内则等同点该格（拒绝原因也同源）
  if (hex === null) return
  const anchor = mapRef.value?.hexToWindow(hex) ?? point
  mapView.dropMovingCounterAt(id, hex, anchor, path)
}

function pickAirBox(): void {
  const item = setup.placing
  if (item?.kind === 'air' && setup.canPlaceAirInOffMapBox(item.side, item.entryIndex)) {
    // 2026-11-19：放进盒的必须是玩家点中的那一枚（激活/未激活、完好/减损不能串）
    setup.placeAirInOffMapBoxNow(item.side, item.entryIndex, item.faceIndex)
    return
  }
  setupBoxOpen.value = !setupBoxOpen.value
}

function submitAirBoxMenu(): void {
  const menu = airBoxMenu.value
  airBoxMenu.value = null
  if (menu !== null) mapView.dropCounterInBox(menu.id, 'air')
}

function onHexClick(hex: HexRef, world: { x: number; y: number }, scale: number): void {
  airBoxMenu.value = null
  const anchor = mapRef.value?.hexToWindow(hex) ?? { x: 0, y: 0 }
  mapView.onHexClick(hex, anchor, world, scale)
}

function onHexHover(hex: HexRef | null): void {
  workbench.setHoverHex(hex)
}

/** H2：悬停预览文本（store 只读计算；画布不读 store） */
const hoverPreviewText = computed(() => workbench.hoverPreviewAt(workbench.hoverHex))

/** H3：双击算子 —— 常用动作全在 map-view 里判（本视图只转一手） */
function onHexDoubleClick(hex: HexRef, world: { x: number; y: number }, scale: number): void {
  mapView.onHexDoubleClick(hex, world, scale)
}

onMounted(() => {
  hotkeys.panelCollapsed = true
  setup.ensureSetupLoaded()
  hotkeys.bind()
  hotkeys.setViewBridge({
    zoomIn: () => mapRef.value?.zoomIn(),
    zoomOut: () => mapRef.value?.zoomOut(),
    fit: () => mapRef.value?.fitToWindow(),
    closePopup: () => {
      if (airBoxMenu.value !== null) {
        airBoxMenu.value = null
        return true
      }
      if (mapView.popup === null) return false
      mapView.closePopup()
      return true
    },
    collapseStack: () => mapView.collapseStack(),
    cancelSession: () => mapView.cancelSession(),
  })
})

onBeforeUnmount(() => {
  stopAiPlay()
  hotkeys.panelCollapsed = panelCollapsedOnEnter
  hotkeys.unbind()
  hotkeys.setViewBridge(null)
})
</script>

<template>
  <div class="gt">
    <!--
      2026-11-19（用户「不要分层」）：安卓壳顶栏 = 一条真实容器（主页徽章 + 流程条 + 快捷标记 + ⚙）。
      2026-11-26（用户「顶栏收成一行」）：桌面同样是**一条** —— 游戏页应用头整条隐藏，品牌与「☰ 主菜单」
      并进这条 44px 流程条（`board-head`），地图因此多出约 90px。
    -->
    <header v-if="androidUi" class="gt__topbar">
      <BaseButton variant="ghost" size="sm" class="gt__home" @click="ui.navigate('home')">
        主页
      </BaseButton>
      <FlowStrip variant="bar">
        <template #trail>
          <!-- 教学卡内联进流程条（桌面是独立悬浮卡，见模板尾部 v-if="!androidUi" 实例） -->
          <TutorialGuide :hex-to-window="tutorialHexToWindow" />
          <BaseButton
            v-if="
              workbench.segmentStep?.id === 'movement.breakout' &&
              !workbench.segmentLocked &&
              session === null
            "
            variant="secondary"
            size="sm"
            @click="mapView.openBreakoutNow()"
          >
            突围
          </BaseButton>
        </template>
        <template v-if="aiWaiting" #status>{{ aiWaiting }}</template>
      </FlowStrip>
      <div class="gt__quick">
        <button
          v-for="chip in quickBoxes"
          :key="chip.kind"
          type="button"
          class="gt__quick-chip"
          @click="focusBox(chip.kind)"
        >
          {{ chip.label }}
        </button>
        <button
          type="button"
          class="gt__quick-chip gt__gear"
          aria-label="设置与抽屉菜单"
          :aria-expanded="quickMenu"
          @click="quickMenu = !quickMenu"
        >
          ⚙
        </button>
      </div>
      <!--
        盒面直弹窗（安卓）：点盒标记 → 只弹 setPopupCard 的盒内浮层（Teleport 到 body，
        贴图自带标题，含 × 关闭与「整备」等贴面按钮），不出盒表抽屉；
        BoxCard 仅作隐藏挂载（android.css 折叠其头行与卡面），点空白处关闭。
      -->
      <div
        v-if="androidUi && quickBoxCard !== null"
        class="gt__boxface"
        @click.self="closeQuickBox()"
      >
        <BoxCard :card="quickBoxCard" />
      </div>
      <div v-if="quickMenu" class="gt__quick-menu">
        <button type="button" @click="openQuickDrawer('status')">战况</button>
        <button type="button" @click="openQuickDrawer('charts')">表</button>
        <button type="button" @click="openQuickDrawer('log')">战报</button>
        <button type="button" @click="openQuickDrawer('settings')">设置</button>
        <button type="button" @click="openSaveFromMenu()">存读档</button>
        <button type="button" @click="ui.navigate('home')">退出对局</button>
      </div>
    </header>
    <FlowStrip v-else variant="bar" board-head @menu="ui.navigate('home')">
      <template #trail>
        <BaseButton
          v-if="
            workbench.segmentStep?.id === 'movement.breakout' &&
            !workbench.segmentLocked &&
            session === null
          "
          variant="secondary"
          size="sm"
          @click="mapView.openBreakoutNow()"
        >
          突围
        </BaseButton>
      </template>
      <template v-if="aiWaiting" #status>{{ aiWaiting }}</template>
    </FlowStrip>

    <div class="gt__workspace">
      <nav class="gt__rail" aria-label="棋桌面板">
        <!-- 盒组（2026-11-26 用户）：一盒一枚压在左栏最上，点开就是该盒的贴图窗；分组字单字（轴/苏/共），不再挂「盒」标题 -->
        <template v-for="group in boxRailGroups" :key="group.key">
          <p class="gt__rail-group">{{ group.label }}</p>
          <button
            v-for="card in group.cards"
            :key="card.id"
            type="button"
            class="gt__rail-button gt__rail-box"
            :title="card.name"
            :aria-label="card.name"
            @click="containers.setPopupCard(card.id)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path :d="boxIconPath(card.boxKind)" />
            </svg>
          </button>
        </template>

        <!-- 抽屉入口：战况 / 表 / 战报，纯图标（2026-11-26 起不再写字） -->
        <div class="gt__rail-main">
          <button
            v-for="item in railDrawers"
            :key="item.id"
            type="button"
            class="gt__rail-button"
            :aria-label="item.label"
            :aria-expanded="!hotkeys.panelCollapsed && drawer === item.id"
            :aria-controls="'table-drawer-' + item.id"
            @click="toggleDrawer(item.id)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path :d="item.icon" />
            </svg>
          </button>
        </div>

        <!-- 栏底三枚（2026-11-26 用户）：存档（磁盘）/ 设置（齿轮）/ 撤销（回转），一律纯图标；撤销常显，无可撤时压暗待命（批 3 纪律：不摆 disabled 灰按钮） -->
        <div class="gt__rail-end">
          <button
            type="button"
            class="gt__rail-button"
            aria-label="存档 / 读档"
            title="存档 / 读档"
            @click="ui.openSaveDialog()"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 4h13l3 3v13H4z M8 4v6h8V4 M8 20v-6h8v6" />
            </svg>
          </button>

          <button
            type="button"
            class="gt__rail-button"
            aria-label="设置"
            title="设置"
            :aria-expanded="!hotkeys.panelCollapsed && drawer === 'settings'"
            aria-controls="table-drawer-settings"
            @click="toggleDrawer('settings')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="6.2" />
              <circle cx="12" cy="12" r="2.6" />
              <path
                d="M9.6 2.6h4.8v3.2h-4.8z M9.6 18.2h4.8v3.2h-4.8z M2.6 9.6h3.2v4.8h-3.2z M18.2 9.6h3.2v4.8h-3.2z"
              />
            </svg>
          </button>

          <button
            type="button"
            class="gt__rail-button gt__rail-undo"
            :class="{ 'gt__rail-undo--idle': !workbench.canUndoOperation }"
            :aria-disabled="!workbench.canUndoOperation"
            :title="
              workbench.canUndoOperation
                ? `撤回上一步：${workbench.undoOperationLabel ?? ''}`
                : (workbench.undoSealedReason ?? '没有可撤销的操作')
            "
            aria-label="撤回上一步"
            @click="workbench.undoLastOperationNow()"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 14 4 9l5-5 M4 9h9a6 6 0 0 1 0 12h-3" />
            </svg>
          </button>
        </div>
      </nav>

      <!--
        盒卡挂载点（2026-11-26：托盘删掉后改挂这里）。BoxCard 自己 Teleport 出浮窗，
        所以这里整块隐藏：左栏点盒图标 ⇒ setPopupCard ⇒ 对应那张卡的浮窗出来。
      -->
      <div class="gt__box-anchors" aria-hidden="true">
        <BoxCard v-for="card in boxAnchorCards" :key="card.id" :card="card" />
      </div>

      <div class="gt__main" role="region" aria-label="对局地图">
        <MapCanvas
          ref="mapRef"
          fill
          :board-color="theme.mode === 'dark' ? '#141712' : undefined"
          :layers="mapLayerToggles"
          :highlight-hex="workbench.hoverHex"
          :highlight-hexes="mapView.mapHighlightHexes"
          :hex-labels="mapView.mapHexLabels"
          :overlay="mapView.overlay"
          :box-drag-source="mapView.counterForBoxAt"
          :counter-drag-source="mapView.counterForMoveDragAt"
          :drag-path-preview="mapView.previewMoveDragPath"
          :hover-preview="hoverPreviewText"
          :control-markers="mapView.controlMarkers"
          :markers="mapView.railheadMarkers"
          :boundary="mapView.boundary"
          :construction-markers="workbench.constructionMarkerPieces"
          :hint="workbench.mapHint"
          @hex-click="onHexClick"
          @hex-dbl-click="onHexDoubleClick"
          @blank-click="mapView.cancelBlankPick()"
          @hex-hover="onHexHover"
          @hex-context="onMapContext"
          @counter-drag="mapCounterDrag = $event"
          @counter-drag-cancel="mapView.cancelCounterDragNow()"
          @counter-drop="onCounterDrop"
        >
          <template #overlay>
            <DecisionQueue
              v-if="setup.applied && (!setup.finished || setup.setupStartEntryVisible)"
              id="setup-queue"
              tabindex="-1"
            />
            <div
              v-if="boxDropTargets.length > 0"
              class="gt__box-targets"
              :class="{
                'gt__box-targets--drag': mapCounterDrag !== null,
              }"
            >
              <BaseButton
                v-for="box in boxDropTargets"
                :key="box"
                :data-counter-box="box"
                variant="secondary"
                size="sm"
                @click="box === 'air' && pickAirBox()"
              >
                {{ COUNTER_BOX_LABELS[box] }}
                <span v-if="box === 'air'" class="num">{{ setupBoxAircraft.length }}</span>
              </BaseButton>
              <ul v-if="setupBoxOpen && boxDropTargets.includes('air')" class="gt__box-roster">
                <li v-if="setupBoxAircraft.length === 0">空盒</li>
                <li v-for="air in setupBoxAircraft" :key="air.instanceId">
                  {{ air.name }} · {{ air.airStatus === 'active' ? '激活' : '非激活' }}
                </li>
              </ul>
            </div>
            <div
              v-if="airBoxMenu !== null"
              class="gt__air-box-menu"
              :style="{ left: airBoxMenu.x + 'px', top: airBoxMenu.y + 'px' }"
            >
              <BaseButton variant="primary" size="sm" @click="submitAirBoxMenu()">
                放入地图外空军盒 · 1.4a
              </BaseButton>
            </div>
            <div
              v-if="workbench.pendingRailTransport !== null"
              class="gt__rail-confirm"
              role="dialog"
              aria-label="铁路运输确认"
            >
              <strong>铁路运输确认</strong>
              <p class="gt__rail-confirm-route">
                {{ workbench.pendingRailTransport.label }}
              </p>
              <p class="gt__rail-confirm-cost num">
                本次耗 {{ workbench.pendingRailTransport.cost }} 点 · 本回合余
                {{ workbench.railCapRemaining[workbench.pendingRailTransport.side] }} 点
              </p>
              <div class="gt__rail-confirm-actions">
                <BaseButton
                  variant="primary"
                  size="sm"
                  @click="workbench.confirmRailTransportNow()"
                >
                  确认
                </BaseButton>
                <BaseButton
                  variant="secondary"
                  size="sm"
                  @click="workbench.cancelRailTransportNow()"
                >
                  撤回
                </BaseButton>
              </div>
            </div>
            <!-- M2：增援铁路抵达点格即落子，原位只留一步撤回 -->
            <div
              v-if="workbench.arrivalRailUndo !== null"
              class="gt__rail-confirm"
              role="status"
              aria-label="铁路抵达撤回"
            >
              <p class="gt__rail-confirm-route">{{ workbench.arrivalRailUndo.label }}</p>
              <p class="gt__rail-confirm-cost num">
                耗 {{ workbench.arrivalRailUndo.cost }} 点 · 本回合余
                {{ workbench.railCapRemaining[workbench.arrivalRailUndo.side] }} 点
              </p>
              <div class="gt__rail-confirm-actions">
                <BaseButton variant="secondary" size="sm" @click="workbench.undoArrivalRailNow()">
                  撤回
                </BaseButton>
              </div>
            </div>
            <!-- 4.8a：环节/阶段末超堆叠（有义务才挂载；没有「忽略」旁路） -->
            <OverstackPanel v-if="setup.finished" />
            <SupplyPhasePanel
              v-if="setup.finished && workbench.phase === 'supply' && session === null"
            />
            <MapDock
              v-if="session !== null"
              :key="session.sessionId"
              :session-key="session.kind"
              :title="sessionTitle"
              :rule="session.rule"
              :width="session.width"
              :close-policy="session.closePolicy"
              :close-blocked-reason="session.closeBlockedReason"
              @close="mapView.cancelSession()"
            >
              <CombatPanel v-if="session.kind === 'combat'" />
              <OpsFlowPanel v-else-if="session.kind === 'ops'" />
              <BarragePanel v-else-if="session.kind === 'barrage'" />
              <AirPanel v-else-if="session.kind === 'air'" only="mission" />
              <SupplyPanel v-else-if="session.kind === 'supply'" only="check" />
              <ReinforcementPanel v-else-if="session.kind === 'reinforce'" />
              <BreakoutPanel v-else-if="session.kind === 'breakout'" />
              <ContainersPanel v-else-if="session.kind === 'containers'" only="actions" />
              <ExclusiveRulesPanel
                v-else-if="session.kind === 'exclusive'"
                :only="mapView.sessionExclusiveSection ?? 'actions'"
              />
              <UnitPanel v-else-if="session.kind === 'unit'" />
              <FuelPanel v-else-if="session.kind === 'fuel'" />
              <MovePanel v-else />
            </MapDock>
          </template>
        </MapCanvas>
        <MapActionPopover />
        <!-- 2026-11-26：底部托盘整条删除（盒入口改到左栏盒组，卡挂载在 .gt__box-anchors） -->
      </div>

      <aside
        v-show="!hotkeys.panelCollapsed"
        class="gt__drawer"
        :class="{ 'gt__drawer--wide': drawer === 'log' }"
        :aria-label="drawers.find((item) => item.id === drawer)?.label"
      >
        <header class="gt__drawer-head">
          <strong>{{ drawers.find((item) => item.id === drawer)?.label }}</strong>
          <BaseButton
            size="sm"
            variant="ghost"
            aria-label="收起面板"
            @click="hotkeys.panelCollapsed = true"
          >
            ×
          </BaseButton>
        </header>

        <div
          v-if="openedDrawers.has('status')"
          v-show="drawer === 'status'"
          id="table-drawer-status"
          class="gt__drawer-body"
        >
          <ActionFeedbackStrip />
          <!--
            #6 + R1 + R3（用户 2026-11-16）：**状态抽屉按段只留一段**。
            增援 / 补给 / 容器三块不再同时挂：只显示当前段那一块（另两块让位，不是删除）；
            增援会话开着时抽屉的 `only="info"` 也让位给地图会话，会话关掉后抽屉仍完整。
          -->
          <template v-if="workbench.phase === 'reinforcement' && session?.kind !== 'reinforce'">
            <ReinforcementPanel only="info" />
          </template>
          <template v-else-if="workbench.phase === 'supply'">
            <SupplyPanel only="ledger" />
          </template>
          <ContainersPanel v-else only="info" />
          <!--
            用户 2026-11-11：战况里删两块挂载 —— 初设面板与专规机制；
            组件与数据不动，裁判视图另有挂载。
          -->
          <VictoryPanel />
        </div>

        <!--
          2026-11-25：表从托盘搬到左栏「表」抽屉（chip 选表 → 只画印卡）。
          抽屉本身无默认选中，空态只有头 + chip 一行。
        -->
        <div
          v-if="openedDrawers.has('charts')"
          v-show="drawer === 'charts'"
          id="table-drawer-charts"
          class="gt__drawer-body"
        >
          <ChartTableDrawer />
        </div>

        <div
          v-if="openedDrawers.has('log')"
          v-show="drawer === 'log'"
          id="table-drawer-log"
          class="gt__drawer-body"
        >
          <SettlementLogPanel />
        </div>

        <div
          v-if="openedDrawers.has('settings')"
          v-show="drawer === 'settings'"
          id="table-drawer-settings"
          class="gt__drawer-body"
        >
          <section class="gt__settings" aria-label="视图">
            <h2>视图</h2>
            <div class="gt__layers">
              <label v-for="option in layers" :key="option.key" class="gt__check">
                <input v-model="mapLayerToggles[option.key]" type="checkbox" />
                {{ option.label }}
              </label>
              <label class="gt__check">
                <input v-model="mapView.zocLayerVisible" type="checkbox" />
                ZOC
              </label>
              <label class="gt__check">
                <input
                  :checked="workbench.stackSelect"
                  type="checkbox"
                  @change="workbench.setStackSelect(($event.target as HTMLInputElement).checked)"
                />
                整堆叠
              </label>
              <label class="gt__check">
                <input
                  :checked="theme.mode === 'dark'"
                  type="checkbox"
                  @change="
                    theme.setMode(($event.target as HTMLInputElement).checked ? 'dark' : 'light')
                  "
                />
                深色界面
              </label>
            </div>
          </section>

          <section class="gt__settings" aria-label="对局控制">
            <h2>对局控制</h2>
            <!-- 2026-11-09：模式在选剧本页定下、初设后锁定 ⇒ 这里只读展示，不再给 AI 开关 -->
            <p class="gt__mode" data-testid="match-mode">
              对局模式 <strong>{{ modeLabel }}</strong>
            </p>
            <!--
              用户 2026-11-11：换手不自动切视角，看哪一方由玩家自己点。
              2026-11-20：PVE 下不能再看苏方（AI）⇒ 视角开关只留给人人对战。
            -->
            <template v-if="hotseat.mode !== 'pve'">
              <BaseButton
                :variant="hotseat.viewerSide === 'axis' ? 'primary' : 'secondary'"
                size="sm"
                @click="hotseat.setViewerSide('axis')"
              >
                看轴心国
              </BaseButton>
              <BaseButton
                :variant="hotseat.viewerSide === 'soviet' ? 'primary' : 'secondary'"
                size="sm"
                @click="hotseat.setViewerSide('soviet')"
              >
                看苏联
              </BaseButton>
            </template>
            <BaseButton
              variant="ghost"
              size="sm"
              :aria-expanded="hotkeys.helpOpen"
              @click="showKeys"
            >
              快捷键
            </BaseButton>
          </section>

          <!-- 记录器：按钮 + `?`（说明收进折叠体，正文不铺字） -->
          <section class="gt__settings" aria-label="记录器">
            <h2>记录器</h2>
            <div class="gt__settings-row">
              <BaseButton
                v-if="canRecord"
                variant="secondary"
                size="sm"
                :data-testid="recorder.active ? 'recorder-stop' : 'recorder-start'"
                @click="toggleRecording"
              >
                {{ recorder.active ? '停止并保存' : '开始记录' }}
              </BaseButton>
              <RuleTip rule="记录器">
                日志存到下载目录（Windows 默认「下载」，即
                <code>%USERPROFILE%\Downloads</code>），文件名 <code>smolensk-log-*.jsonl</code>。
              </RuleTip>
            </div>
          </section>
          <HotkeyHelpPanel v-if="hotkeys.helpOpen" />
        </div>
      </aside>
    </div>

    <TerminationNotice v-if="gameSession.terminated" class="gt__termination" />
    <!-- 用户 2026-11-15：对局终止即弹「判定胜利」窗（胜负 + 判定依据；条款号进 `?`） -->
    <VictoryDialog />
    <QuestionPrompt />
    <!-- 用户 2026-11-18 第 2 条：Vitebsk 教学模式（逐步指到格子/算子/盒/按钮） -->
    <!-- 安卓壳已把教学卡内联进顶部流程条（见 #trail），桌面保留独立悬浮卡 -->
    <TutorialGuide v-if="!androidUi" :hex-to-window="tutorialHexToWindow" />

    <!-- 读档后模式未设置：选齐前挡在盘面前，AI 不接管、热坐不按 PVP 遮屏 -->
    <Teleport to="body">
      <div
        v-if="modeGate"
        class="mode-gate"
        role="dialog"
        aria-modal="true"
        aria-label="选择对局模式"
        data-testid="mode-gate"
      >
        <div class="mode-gate__mask" />
        <div class="mode-gate__panel">
          <header class="mode-gate__head">
            <span>对局模式</span>
            <span class="num">必选</span>
          </header>
          <h2 class="mode-gate__title">这一档没有记录对局模式</h2>
          <p class="mode-gate__hint">
            请先选择本局的组织方式；选定前不推进、不交给 AI，也不按热坐遮屏。
          </p>
          <ul class="mode-gate__list">
            <li v-for="item in hotseat.MODE_LABELS" :key="item.key">
              <label
                class="mode-gate__item"
                :class="{ 'mode-gate__item--on': hotseat.mode === item.key }"
              >
                <input
                  type="radio"
                  name="gate-mode"
                  :value="item.key"
                  :checked="hotseat.mode === item.key"
                  @change="hotseat.setMode(item.key)"
                />
                <span class="mode-gate__label">{{ item.label }}</span>
                <span class="mode-gate__note">{{ item.note }}</span>
              </label>
            </li>
          </ul>
          <fieldset v-if="hotseat.mode === 'pve'" class="mode-gate__sides">
            <legend>AI 控制方</legend>
            <ul class="mode-gate__list">
              <li v-for="item in gateSides" :key="item.side">
                <label
                  class="mode-gate__item"
                  :class="{ 'mode-gate__item--on': hotseat.aiSide === item.side }"
                >
                  <input
                    type="radio"
                    name="gate-ai-side"
                    :value="item.side"
                    :checked="hotseat.aiSide === item.side"
                    @change="hotseat.setAiSide(item.side)"
                  />
                  <span class="mode-gate__label">AI 打{{ item.label }}</span>
                  <span class="mode-gate__note">你操作另一方</span>
                </label>
              </li>
            </ul>
          </fieldset>
          <div class="mode-gate__actions">
            <BaseButton
              v-if="hotseat.modeReady"
              variant="primary"
              size="sm"
              @click="hotseat.lockMode()"
            >
              确认并继续
            </BaseButton>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.gt__box-targets {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-3);
  z-index: var(--layer-map-popup);
  display: flex;
  gap: var(--space-2);
}

.gt__box-targets--drag {
  outline: 2px solid var(--color-command-teal);
  outline-offset: var(--space-1);
  border-radius: var(--radius-sm);
}

.gt__air-box-menu {
  position: fixed;
  z-index: var(--layer-map-popup);
}

/* 裁定 3：铁路运输的确认／撤回小窗（点目的地后出现，不遮挡地图中心） */
.gt__rail-confirm {
  position: fixed;
  left: 50%;
  bottom: var(--space-6);
  z-index: var(--layer-map-popup);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 16rem;
  max-width: 26rem;
  padding: var(--space-3);
  transform: translateX(-50%);
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-md);
  background: var(--color-command-panel);
  color: var(--color-command-ink);
  box-shadow: var(--shadow-lg);
}

.gt__rail-confirm-route {
  margin: 0;
  font-size: var(--text-sm);
}

.gt__rail-confirm-cost {
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-xs);
}

.gt__rail-confirm-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}

.gt__box-roster {
  position: absolute;
  right: 0;
  bottom: calc(100% + var(--space-2));
  max-height: 40vh;
  min-width: 10rem;
  overflow: auto;
  margin: 0;
  padding: var(--space-2);
  list-style: none;
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-sm);
  background: var(--color-command-panel);
  color: var(--color-command-ink);
  font-size: var(--text-xs);
}
/* 批 6：设置分组内一行（控件 + `?`），说明文字不铺在正排 */
.gt__settings-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.gt {
  --color-bg: var(--color-command-bg);
  --color-bg-2: var(--color-command-raised);
  --color-panel: var(--color-command-panel);
  --color-rule: var(--color-command-line);
  --color-ink: var(--color-command-ink);
  --color-muted: var(--color-command-muted);
  --color-accent: var(--color-command-teal);
  --color-accent-2: var(--color-command-accent-solid);
  --color-on-accent: var(--color-command-on-accent);
  --color-accent-2-hover: var(--color-command-accent-solid-hover);
  --color-danger-hover: var(--color-command-danger-hover);
  --color-gold: var(--color-command-amber);
  --color-info: var(--color-command-axis);
  --color-success: var(--color-command-teal);
  --color-warning: var(--color-command-amber);
  --color-danger: var(--color-command-danger);
  --color-info-bg: var(--color-command-info-bg);
  --color-success-bg: var(--color-command-success-bg);
  --color-warning-bg: var(--color-command-warning-bg);
  --color-danger-bg: var(--color-command-danger-bg);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  min-width: 0;
  color: var(--color-ink);
  background: var(--color-bg);
}

.gt__workspace {
  display: flex;
  position: relative;
  min-width: 0;
  min-height: 0;
}

.gt__rail {
  /* 2026-11-25：左栏的存档是常用入口 ⇒ 待答遮罩（`.prompt`，200）不得盖住它：抬到 210，
     仍低于模式闸门 250 与 toast 300；浮窗/会话框（20）不受影响 */
  position: relative;
  z-index: calc(var(--z-panel) + 10);
  display: flex;
  flex-direction: column;
  /* 2026-11-26（用户「各宽度减小」）：栏宽 62 → 46、按钮 44 → 34（回到 v5 小样 46/34/图标 22），
     13 枚因此 767 与 768 高都一屏放下，不用再靠行距压缩 */
  gap: var(--space-1);
  flex: 0 0 var(--command-rail);
  padding: 6px var(--space-1);
  border-right: 1px solid var(--color-rule);
  background: var(--color-panel);
  overflow: auto;
}

/* 栏底三枚贴底：1366×768 等窄屏整条仍略溢出，三枚必须常驻可见、不跟滚动跑掉 */
.gt__rail-end {
  position: sticky;
  bottom: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: auto;
  padding-top: var(--space-1);
  background: var(--color-panel);
}

/* 盒组的分组字（轴 / 苏 / 共）：单字小标 10px（v5 小样同口径），不占按钮位 */
.gt__rail-group {
  margin: 2px 0 0;
  color: var(--color-muted);
  font-size: 10px;
  line-height: 1.2;
  text-align: center;
}

/* 抽屉入口一段（战况 / 表 / 战报），与盒组之间用一条细规隔开 */
.gt__rail-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-rule);
}

/* 盒卡挂载点：整块隐藏，BoxCard 自己 Teleport 出浮窗 */
.gt__box-anchors {
  display: none;
}

.gt__rail-button {
  display: flex;
  width: 100%;
  /* 2026-11-26（用户「各宽度减小」）：44 → 34，与 v5 小样一致；桌面鼠标点，34 仍够 */
  min-height: 34px;
  /* 2026-11-26（用户）：左栏一律纯图标 ⇒ 居中，不再带字 */
  align-items: center;
  justify-content: center;
  flex-direction: row;
  gap: var(--space-1);
  padding: var(--space-1);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-muted);
  font: inherit;
  font-size: var(--text-xs);
  line-height: 1;
  cursor: pointer;
}

.gt__rail-button svg {
  flex: none;
  /* 图标 22px（v5 小样）；34 的按钮里上下各留 6px，点起来仍不挤 */
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.gt__rail-button:hover,
.gt__rail-button[aria-expanded='true'] {
  background: var(--color-bg-2);
  color: var(--color-accent);
  border-color: var(--color-rule);
}

/* 撤回图标：无文字，尺寸与其它栏钮一致；无可撤操作时压暗待命（整枚常显，位置不跳） */
.gt__rail-undo--idle {
  opacity: 0.4;
  cursor: default;
}

.gt__rail-undo--idle:hover {
  background: transparent;
  color: var(--color-muted);
  border-color: transparent;
}

.gt__main {
  /* 2026-11-26：底部托盘删除后，这里只剩地图（地图自己 flex 撑满，不再让位给托盘） */
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.gt__main > .mapcanvas {
  flex: 1 1 auto;
  min-height: 0;
}

.gt__drawer {
  z-index: var(--layer-shell);
  flex: 0 0 var(--command-drawer);
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border-left: 1px solid var(--color-rule);
  background: var(--color-panel);
}

.gt__drawer--wide {
  flex-basis: var(--command-drawer-wide);
}

.gt__drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-rule);
}

.gt__drawer-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  overflow: auto;
  padding: var(--space-3);
  overscroll-behavior: contain;
}

/*
 * 用户 2026-11-18：状态/提示栏内容一多就看不全且没法滚。
 * 根因：这里是一列 flex，直接子项（BasePanel / 表抽屉 / 战报面板）默认 `flex-shrink:1`，
 * 而它们自身 `overflow:hidden`（自动最小尺寸按 0 算）⇒ 内容一超就**被压扁到 0 高**，
 * 外层看起来「有滚动条但后面的内容永远滚不到」。子项一律不参与收缩，整列交给
 * 外层 `overflow:auto` 滚。
 */
.gt__drawer-body > * {
  flex-shrink: 0;
}

.gt__settings {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}

.gt__settings h2 {
  width: 100%;
  margin: 0;
  font-size: var(--text-sm);
}

.gt__layers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-1) var(--space-3);
}

.gt__check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-muted);
  font-size: var(--text-sm);
}

.gt__mode {
  margin: 0 0 var(--space-2);
  color: var(--color-muted);
  font-size: var(--text-sm);
}

.gt__mode strong {
  color: var(--color-ink);
}

.gt__check input {
  accent-color: var(--color-accent);
}

.gt__check select {
  padding: var(--space-1);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-panel);
  color: var(--color-ink);
  font: inherit;
}

.gt__termination {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-16);
  z-index: var(--layer-shell);
  max-width: min(var(--command-drawer-wide), calc(100% - var(--space-16)));
  max-height: 45vh;
  overflow: auto;
}

/* 读档后「模式未设置」的继续闸门（只是组织方式，不参与规则判定） */
.mode-gate {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog-top);
  display: flex;
  align-items: center;
  justify-content: center;
}

.mode-gate__mask {
  position: absolute;
  inset: 0;
  background: var(--color-command-bg);
}

.mode-gate__panel {
  position: relative;
  width: min(620px, 92vw);
  max-height: 86vh;
  overflow: auto;
  --color-bg-2: var(--color-command-raised);
  --color-ink: var(--color-command-ink);
  --color-accent-2: var(--color-command-teal-bg);
  padding: var(--space-6);
  background: var(--color-command-panel);
  border: 1px solid var(--color-command-line);
  border-top: 3px solid var(--color-command-teal);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.mode-gate__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-4);
  color: var(--color-command-teal);
  font-size: var(--text-sm);
}

.mode-gate__title {
  margin: var(--space-2) 0;
  color: var(--color-ink);
  font-size: var(--text-lg);
}

.mode-gate__hint {
  margin: 0 0 var(--space-4);
  color: var(--color-command-muted);
  font-size: var(--text-sm);
}

.mode-gate__list {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-2) 0;
  list-style: none;
}

.mode-gate__sides {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.mode-gate__sides legend {
  color: var(--color-command-muted);
  font-size: var(--text-xs);
}

.mode-gate__item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-height);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-md);
  background: var(--color-command-bg);
  color: var(--color-ink);
  font-size: var(--text-sm);
  cursor: pointer;
}

.mode-gate__item--on,
.mode-gate__item--on:hover {
  border-color: var(--color-command-teal);
  background: var(--color-command-teal-bg);
}

.mode-gate__item input {
  accent-color: var(--color-command-teal);
}

.mode-gate__label {
  font-weight: 700;
}

.mode-gate__note {
  margin-left: auto;
  color: var(--color-command-muted);
  font-size: var(--text-xs);
}

.mode-gate__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-4);
}

@media (max-width: 1080px) {
  .gt__drawer {
    position: absolute;
    inset: 0 auto 0 var(--command-rail);
    width: min(var(--command-drawer), calc(100% - var(--command-rail)));
    box-shadow: var(--shadow-lg);
  }

  .gt__drawer--wide {
    width: min(var(--command-drawer-wide), calc(100% - var(--command-rail)));
  }
}

/*
 * ═══════════════════════════════════════════════════════════
 * 触摸屏 / 窄屏（用户 2026-11-18：打包安卓安装包）
 *
 * 桌面版是「左侧竖栏 + 右侧抽屉」的写法，放到手机上会两头都不够用：
 *   · 竖栏 62px 在 800px 宽的横屏里吃掉 8%，而它只放了 4 个按钮；
 *   · 抽屉 316px 盖上去后地图只剩一条缝，等于"开面板就看不见盘面"。
 * 故窄屏改成：**竖栏转到底部横排**、**抽屉变成底部上浮的浮层**（覆盖地图、不挤压它）。
 * 宽屏（平板横屏 ≥900px）保持原构图，只是命中尺寸由令牌放大。
 * ═══════════════════════════════════════════════════════════ */
@media (max-width: 900px) {
  .gt__workspace {
    flex-direction: column;
  }

  .gt__main {
    order: 1;
  }

  .gt__rail {
    order: 2;
    flex: 0 0 auto;
    flex-direction: row;
    align-items: stretch;
    gap: var(--space-1);
    /* 横握时手势条 / 刘海在左右两侧：内边距要跟着安全区走，否则最右那颗按钮压在手势条底下 */
    padding: var(--space-1) calc(var(--space-2) + var(--safe-right))
      calc(var(--space-1) + var(--safe-bottom)) calc(var(--space-2) + var(--safe-left));
    border-right: none;
    border-top: 1px solid var(--color-rule);
    overflow-x: auto;
    overflow-y: hidden;
  }

  .gt__rail-button {
    width: auto;
    min-width: 68px;
    flex: 0 0 auto;
  }

  .gt__rail-end {
    position: static;
    display: flex;
    flex-direction: row;
    margin-top: 0;
    margin-left: auto;
    padding-top: 0;
    background: transparent;
  }

  /* 底部浮层：从下往上盖住地图一部分，地图仍然完整可平移/缩放 */
  .gt__drawer,
  .gt__drawer--wide {
    position: absolute;
    top: auto;
    right: var(--space-2);
    /* 让开底部那条横排栏（2026-11-26 起按钮 34：34 + 上下 4×2 + 1px 边 ≈ 43） */
    bottom: calc(34px + 2 * var(--space-1) + var(--safe-bottom));
    left: var(--space-2);
    width: auto;
    max-height: 56%;
    border-left: 1px solid var(--color-rule);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
  }
}

/* 横屏手机：竖向空间比宽度还紧，进一步压薄顶栏与流程条占位 */
@media (max-width: 900px) and (max-height: 480px) {
  .gt__rail-button {
    min-width: 56px;
    min-height: 40px;
  }
}
</style>
