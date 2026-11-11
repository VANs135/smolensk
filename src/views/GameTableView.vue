<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import { BaseButton } from '@/components/base'
import { AirPanel } from '@/components/air'
import { BarragePanel } from '@/components/barrage'
import { OpsFlowPanel } from '@/components/ops'
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
import { provideUiMode } from '@/components/ui-mode'
import { VictoryPanel } from '@/components/victory'
import type { HexRef, Side } from '@/data'
import { COUNTER_BOX_LABELS, type CounterBoxTarget } from '@/stores/map-view'
import { DEFAULT_MAP_LAYERS } from '@/render/map-render'
import {
  useAppStore,
  useGameSessionStore,
  useHotkeyStore,
  useHotseatStore,
  useMapViewStore,
  useRecorderStore,
  useSetupStore,
  useUiStore,
  useWorkbenchStore,
} from '@/stores'

import { createAiMemory, runAiStep } from '@/ai/driver'
import type { AiControlMode } from '@/ai/policy'

const workbench = useWorkbenchStore()
const mapView = useMapViewStore()
const hotkeys = useHotkeyStore()
const setup = useSetupStore()
const gameSession = useGameSessionStore()
const hotseat = useHotseatStore()
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
const modeGate = computed<boolean>(() => gameSession.session !== null && hotseat.modeIssue !== null)
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

type TableDrawer = 'status' | 'cards' | 'log' | 'settings'

const drawers = [
  { id: 'status', label: '战况', icon: 'M3 12h4l3-7 4 14 3-7h4' },
  { id: 'cards', label: '盒表', icon: 'M5 5h14v14H5z M5 10h14 M12 10v9' },
  { id: 'log', label: '战报', icon: 'M6 3h9l3 3v15H6z M9 10h6 M9 14h6 M9 17h4' },
  { id: 'settings', label: '设置', icon: 'M4 7h16 M4 17h16 M9 4v6 M15 14v6' },
] as const

const layers = [
  { key: 'image', label: '扫描图' },
  { key: 'grid', label: '网格' },
  { key: 'labels', label: '格号' },
  { key: 'edges', label: '河 / 路 / 铁' },
  { key: 'control', label: '控制标记' },
] as const

const mapRef = ref<MapBridge | null>(null)
const mapLayerToggles = reactive({ ...DEFAULT_MAP_LAYERS })
const drawer = ref<TableDrawer>('status')
const openedDrawers = reactive(new Set<TableDrawer>())
const session = computed(() => mapView.session)
const panelCollapsedOnEnter = hotkeys.panelCollapsed

function openDrawer(next: TableDrawer): void {
  drawer.value = next
  openedDrawers.add(next)
  hotkeys.panelCollapsed = false
}

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

const queuedAirDrag = ref<{ side: Side; entryIndex: number } | null>(null)
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
  queuedAirDrag.value = null
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

function onCounterDrop(id: string, point: { x: number; y: number }): void {
  const target = document
    .elementFromPoint(point.x, point.y)
    ?.closest<HTMLElement>('[data-counter-box]')
  const box = boxDropTargets.value.find((item) => item === target?.dataset.counterBox)
  if (box !== undefined) mapView.dropCounterInBox(id, box)
}

function onQueuedAirDrop(event: DragEvent, box: CounterBoxTarget): void {
  const source = queuedAirDrag.value
  if (box !== 'air' || source === null || source.side !== setupBoxSide.value) return
  event.preventDefault()
  queuedAirDrag.value = null
  setup.placeAirInOffMapBoxNow(source.side, source.entryIndex)
}

function allowQueuedAirDrop(event: DragEvent, box: CounterBoxTarget): void {
  if (
    box !== 'air' ||
    queuedAirDrag.value === null ||
    queuedAirDrag.value.side !== setupBoxSide.value
  )
    return
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
}

function pickAirBox(): void {
  const item = setup.placing
  if (item?.kind === 'air' && setup.canPlaceAirInOffMapBox(item.side, item.entryIndex)) {
    setup.placeAirInOffMapBoxNow(item.side, item.entryIndex)
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
    <FlowStrip variant="bar">
      <template #trail>
        <BaseButton
          v-if="workbench.segmentStep?.id === 'movement.breakout' && session === null"
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
        <button
          v-for="item in drawers"
          :key="item.id"
          type="button"
          class="gt__rail-button"
          :aria-label="item.id === 'settings' ? '视图与面板' : item.label"
          :aria-expanded="!hotkeys.panelCollapsed && drawer === item.id"
          :aria-controls="'table-drawer-' + item.id"
          @click="toggleDrawer(item.id)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path :d="item.icon" />
          </svg>
          {{ item.label }}
        </button>

        <div class="gt__rail-end">
          <button
            type="button"
            class="gt__rail-button"
            aria-label="存档 / 读档"
            @click="ui.openSaveDialog()"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 4h13l3 3v13H4z M8 4v6h8V4 M8 20v-6h8v6" />
            </svg>
            存读档
          </button>
        </div>
      </nav>

      <div class="gt__main" role="region" aria-label="对局地图">
        <MapCanvas
          ref="mapRef"
          fill
          :layers="mapLayerToggles"
          :highlight-hex="workbench.hoverHex"
          :highlight-hexes="workbench.variableExitPickHexes"
          :overlay="mapView.overlay"
          :box-drag-source="mapView.counterForBoxAt"
          :control-markers="mapView.controlMarkers"
          :boundary="mapView.boundary"
          :construction-markers="workbench.constructionMarkerPieces"
          :hint="workbench.mapHint"
          @hex-click="onHexClick"
          @hex-hover="onHexHover"
          @hex-context="onMapContext"
          @counter-drag="mapCounterDrag = $event"
          @counter-drop="onCounterDrop"
        >
          <template #overlay>
            <DecisionQueue
              v-if="setup.applied && !setup.finished"
              id="setup-queue"
              tabindex="-1"
              @air-drag="queuedAirDrag = $event"
            />
            <div
              v-if="boxDropTargets.length > 0"
              class="gt__box-targets"
              :class="{
                'gt__box-targets--drag': queuedAirDrag !== null || mapCounterDrag !== null,
              }"
            >
              <BaseButton
                v-for="box in boxDropTargets"
                :key="box"
                :data-counter-box="box"
                variant="secondary"
                size="sm"
                @dragenter="allowQueuedAirDrop($event, box)"
                @dragover="allowQueuedAirDrop($event, box)"
                @drop="onQueuedAirDrop($event, box)"
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
            <SupplyPhasePanel
              v-if="setup.finished && workbench.phase === 'supply' && session === null"
            />
            <MapDock
              v-if="session !== null"
              :key="session.sessionId"
              :session-key="session.kind"
              :title="session.title"
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
      </div>

      <aside
        v-show="!hotkeys.panelCollapsed"
        class="gt__drawer"
        :class="{ 'gt__drawer--wide': drawer === 'log' || drawer === 'cards' }"
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
            #6（用户 2026-11-10）：**只在本阶段挂本阶段的仪表**。
            修前这条常驻，突围等环节的状态抽屉里也挂着「增援与编制」面板，
            玩家在突围环节读到重建/整编的说明与入口——环节与 UI 对不上。
          -->
          <template v-if="workbench.phase === 'reinforcement'">
            <ReinforcementPanel only="info" />
          </template>
          <!--
            用户 2026-11-11：**战况里删两块挂载** —— 初设面板（一键预设初设与开局选剧本重复；
            其入口已挪进地图左上角「初设」栏，全程序只保留那一处可点）与专规机制
            （各机制都已做到对应环节，不必在战况再挂一块）。组件与数据不动，裁判视图另有挂载。
          -->
          <VictoryPanel />
          <ContainersPanel only="info" />
        </div>

        <div
          v-if="openedDrawers.has('cards')"
          v-show="drawer === 'cards'"
          id="table-drawer-cards"
          class="gt__drawer-body"
        >
          <BottomTray />
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
          <section class="gt__settings" aria-label="视图与面板">
            <h2>视图与面板</h2>
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
            </div>
          </section>

          <section class="gt__settings" aria-label="对局控制">
            <h2>对局控制</h2>
            <!-- 2026-11-09：模式在选剧本页定下、初设后锁定 ⇒ 这里只读展示，不再给 AI 开关 -->
            <p class="gt__mode" data-testid="match-mode">
              对局模式 <strong>{{ modeLabel }}</strong>
            </p>
            <!-- 用户 2026-11-11：换手不自动切视角，看哪一方由玩家自己点 -->
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
            <BaseButton
              variant="ghost"
              size="sm"
              :aria-expanded="hotkeys.helpOpen"
              @click="showKeys"
            >
              快捷键
            </BaseButton>
            <!-- ⑧：开始/停止记录（导出 JSONL 交回定位；不影响对局） -->
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="!canRecord"
              :data-testid="recorder.active ? 'recorder-stop' : 'recorder-start'"
              @click="toggleRecording"
            >
              {{ recorder.active ? '停止并保存' : '开始记录' }}
            </BaseButton>
            <!-- 导出落点写清楚：不弹目录选择，走浏览器/WebView 的下载目录 -->
            <span class="gt__recorder-hint" data-testid="recorder-hint">
              日志存到下载目录（Windows 默认「下载」，即
              <code>%USERPROFILE%\Downloads</code>），文件名
              <code>smolensk-log-*.jsonl</code>
            </span>
          </section>
          <HotkeyHelpPanel v-if="hotkeys.helpOpen" />
        </div>
      </aside>
    </div>

    <TerminationNotice v-if="gameSession.terminated" class="gt__termination" />
    <QuestionPrompt />

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
              variant="primary"
              size="sm"
              :disabled="!hotseat.modeReady"
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
/* ⑧：记录导出的落点说明（面板可见，避免"文件去哪了"） */
.gt__recorder-hint {
  flex-basis: 100%;
  color: var(--color-muted);
  font-size: var(--text-xs);
  line-height: 1.4;
}

.gt {
  --color-bg: var(--color-command-bg);
  --color-bg-2: var(--color-command-raised);
  --color-panel: var(--color-command-panel);
  --color-rule: var(--color-command-line);
  --color-ink: var(--color-command-ink);
  --color-muted: var(--color-command-muted);
  --color-accent: var(--color-command-teal);
  --color-accent-2: var(--color-command-teal-bg);
  --color-gold: var(--color-command-amber);
  --color-warning: var(--color-command-amber);
  --color-warning-bg: var(--color-command-raised);
  --color-danger: var(--color-command-danger);
  --color-danger-bg: var(--color-command-raised);
  --focus-ring: 0 0 0 2px var(--color-command-teal);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  min-width: 0;
  color: var(--color-ink);
  background: var(--color-bg);
  color-scheme: dark;
}

.gt__workspace {
  display: flex;
  position: relative;
  min-width: 0;
  min-height: 0;
}

.gt__rail {
  z-index: var(--layer-shell);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 0 0 var(--command-rail);
  padding: var(--space-2) var(--space-1);
  border-right: 1px solid var(--color-rule);
  background: var(--color-panel);
  overflow: auto;
}

.gt__rail-end {
  margin-top: auto;
}

.gt__rail-button {
  display: flex;
  width: 100%;
  min-height: var(--command-rail-button);
  align-items: center;
  justify-content: center;
  flex-direction: column;
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
  width: var(--space-5);
  height: var(--space-5);
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

.gt__main {
  flex: 1 1 auto;
  min-width: 0;
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
</style>
