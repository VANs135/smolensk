<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import { BaseButton } from '@/components/base'
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
import SupplyPhasePanel from '@/components/supply/SupplyPhasePanel.vue'
import { provideUiMode } from '@/components/ui-mode'
import { VictoryPanel } from '@/components/victory'
import type { HexRef } from '@/data'
import { DEFAULT_MAP_LAYERS } from '@/render/map-render'
import {
  useGameSessionStore,
  useHotkeyStore,
  useHotseatStore,
  useMapViewStore,
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

provideUiMode('formal')

const aiControlMode = ref<AiControlMode>('off')
const aiWaiting = ref('')
let aiMemory = createAiMemory()
let aiTimer: ReturnType<typeof setTimeout> | null = null

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

function onAiControlChange(): void {
  stopAiPlay()
  aiWaiting.value = ''
  aiMemory = createAiMemory()
  if (aiControlMode.value !== 'off') scheduleAiStep()
}

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

function onHexClick(hex: HexRef, world: { x: number; y: number }, scale: number): void {
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
          :control-markers="mapView.controlMarkers"
          :boundary="mapView.boundary"
          :construction-markers="workbench.constructionMarkerPieces"
          :hint="workbench.mapHint"
          @hex-click="onHexClick"
          @hex-hover="onHexHover"
          @hex-context="mapView.onHexContext"
        >
          <template #overlay>
            <DecisionQueue v-if="setup.applied && !setup.finished" id="setup-queue" tabindex="-1" />
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
              <BarragePanel v-else-if="session.kind === 'barrage'" />
              <AirPanel v-else-if="session.kind === 'air'" only="mission" />
              <SupplyPanel v-else-if="session.kind === 'supply'" only="check" />
              <ReinforcementPanel v-else-if="session.kind === 'reinforce'" />
              <BreakoutPanel v-else-if="session.kind === 'breakout'" />
              <ContainersPanel v-else-if="session.kind === 'containers'" only="actions" />
              <ExclusiveRulesPanel v-else-if="session.kind === 'exclusive'" only="actions" />
              <UnitPanel v-else-if="session.kind === 'unit'" />
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
          <SetupPanel />
          <ReinforcementPanel only="info" />
          <ExclusiveRulesPanel only="info" />
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
            <label class="gt__check">
              AI 控制方
              <select v-model="aiControlMode" @change="onAiControlChange">
                <option value="off">关闭</option>
                <option value="axis">轴心</option>
                <option value="soviet">苏联</option>
                <option value="both">双方</option>
              </select>
            </label>
            <BaseButton variant="secondary" size="sm" @click="hotseat.beginHandoff()">
              交给{{ hotseat.opponentSide === 'axis' ? '轴心国' : '苏联' }}
            </BaseButton>
            <BaseButton
              variant="ghost"
              size="sm"
              :aria-expanded="hotkeys.helpOpen"
              @click="showKeys"
            >
              快捷键
            </BaseButton>
          </section>
          <HotkeyHelpPanel v-if="hotkeys.helpOpen" />
        </div>
      </aside>
    </div>

    <TerminationNotice v-if="gameSession.terminated" class="gt__termination" />
    <QuestionPrompt v-if="!hotseat.handoffPending" />
    <HandoffOverlay />
  </div>
</template>

<style scoped>
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
