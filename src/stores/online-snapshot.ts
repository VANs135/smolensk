import { DATA_VERSION } from '@/data'

import type { useGameSessionStore } from './session'
import type { useHotseatStore } from './hotseat'
import type { useSetupStore } from './setup'
import type { useWorkbenchStore } from './workbench'
import {
  OnlineError,
  ONLINE_PROTOCOL_VERSION,
  type OnlineGameState,
  type OnlineLobbyState,
  type OnlineState,
  type OnlineSide,
} from '@/net/online-types'

export interface OnlineStoreBundle {
  session: ReturnType<typeof useGameSessionStore>
  workbench: ReturnType<typeof useWorkbenchStore>
  setup: ReturnType<typeof useSetupStore>
  hotseat: ReturnType<typeof useHotseatStore>
}

/**
 * 工作台里只属于当前设备/当前玩家的界面字段
 *
 * 这些不是对局事实：把对方的 `selectedId`、`tool`、`hoverHex` 搬过来会替对方选单位、
 * 关掉对方正在看的浮窗。战斗输入（`combatInputs` / `barrageInputs`）**不在**排除表里，
 * 因为守方的损失/撤退/地形选择必须让攻方看到。
 */
const WORKBENCH_LOCAL_KEYS = new Set([
  'selectedId',
  'tool',
  'lastStep',
  'lastBattle',
  'battleTarget',
  'battleTerrain',
  'battleDefenderArId',
  'moveLinger',
  'hoverHex',
  'stackSelect',
  'movePick',
  'moveBlocked',
  'actionRefusal',
  'advanceBlock',
  'overrunContext',
  'airMissionBaseFocus',
  'supplyPreviewIndex',
  'spDumpDraft',
  'supplySourceDraft',
  'hedgehogExecutorMode',
  'hedgehogEngineerId',
  'hedgehogPayPick',
  'constructionPayPick',
  'constructionInputs',
  'constructionMarkerHexText',
  'constructionMarkerPicked',
  'fuelDumpId',
  'fuelMethod',
  'fuelSubjectId',
  'hqFuelThrows',
  'formationFuelThrows',
  'refitStage',
  'transferMode',
  'transferFromBox',
  'transferSelectedIds',
  'rebuildReplHexText',
  'convertTargetHexText',
  'railGaugeTargetHexText',
  'cityControlHexText',
  'formationMarkerHexText',
  'deadPileReturnHexText',
  'deadPilePickId',
  'airPlacement',
  'airMissionBaseFocus',
])

/** 会话层只属于本地存储/界面的字段；`session` 本体与日志仍随房间走。 */
const SESSION_LOCAL_KEYS = new Set(['storage', 'logQuery', 'slot', 'saveError'])

/** 初设里的对话框/草稿字段；初设开始后的对局状态不依赖它们。 */
const SETUP_LOCAL_KEYS = new Set([
  'briefingPendingId',
  'placing',
  'lastAction',
  'lastPlacement',
  'truckPickActive',
  'truckPickPending',
])

function cloneWire(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function withoutKeys(
  source: Record<string, unknown>,
  denied: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!denied.has(key)) out[key] = value
  }
  return out
}

/**
 * 捕获一份可跨设备复制的房间状态
 *
 * 选剧本前只有 `lobby`：不复制本机旧盘面，只带协议/数据版本与已选剧本。
 * 房主完成初设并开局后转为 `game`，才做完整状态复制。
 *
 * 这是**全量状态复制**，不是存档协议：它故意包含战斗现场和各类交互进行态，否则守方
 * 无法在自己的设备上选择地形/AR/损失/撤退。代价是双方必须使用同一构建与同一
 * `DATA_VERSION`；不承诺跨版本回放。
 */
export function captureOnlineState(stores: OnlineStoreBundle): OnlineState {
  if (stores.session.session === null) {
    const lobby: OnlineLobbyState = {
      stage: 'lobby',
      protocol: ONLINE_PROTOCOL_VERSION,
      dataVersion: DATA_VERSION,
      // 只有真正进入初设后才把剧本写进房间；开始台的默认剧本号不算“已选”
      scenarioId: stores.setup.applied ? stores.session.scenarioId : null,
    }
    return lobby
  }
  const sessionState = withoutKeys(cloneWire(stores.session.$state), SESSION_LOCAL_KEYS)
  const workbenchState = withoutKeys(cloneWire(stores.workbench.$state), WORKBENCH_LOCAL_KEYS)
  const setupState = withoutKeys(cloneWire(stores.setup.$state), SETUP_LOCAL_KEYS)
  return {
    stage: 'game',
    protocol: ONLINE_PROTOCOL_VERSION,
    dataVersion: DATA_VERSION,
    scenarioId: stores.session.scenarioId,
    session: sessionState,
    workbench: workbenchState,
    setup: setupState,
    // 联机房间恒为 PVP：主机哪怕从 solo/PVE 局面开房，也不能把“双面可见”或 AI 外壳复制给对方。
    // 视角本身不随房间走，由每个客户端自己的 `mySide` 在 `applyOnlineState` 里写死。
    hotseat: {
      mode: 'pvp',
      aiSide: null,
      setupLocked: true,
      scriptedSide: null,
    },
  }
}

/** 协议/数据版本/剧本对不上时拒收；错误文案直接给界面。 */
export function assertOnlineState(state: OnlineGameState, expectedScenarioId?: string): void {
  if (state.protocol !== ONLINE_PROTOCOL_VERSION) {
    throw new OnlineError('protocolMismatch', '联机协议版本不一致，请双方使用同一构建')
  }
  if (state.dataVersion !== DATA_VERSION) {
    throw new OnlineError('dataVersionMismatch', '双方构建的数据版本不一致，无法继续联机')
  }
  if (
    typeof state.session !== 'object' ||
    state.session === null ||
    state.session['scenarioId'] !== state.scenarioId
  ) {
    throw new OnlineError('scenarioMismatch', '房间里的会话剧本与房间头不一致')
  }
  if (expectedScenarioId !== undefined && state.scenarioId !== expectedScenarioId) {
    throw new OnlineError('scenarioMismatch', '房间剧本与当前对局不一致')
  }
}

/**
 * 把房间状态落到本机四个 store
 *
 * 观察方**不取房间里的值**：每个客户端只认自己的 `mySide`，由 `hotseat.lockViewer`
 * 固定；这正是“双方 UI/视角隔离”的落点。写入顺序不依赖 Vue 的异步 watcher 顺序：
 * 四个 `$patch` 都在同一同步栈内完成，界面在下一帧看到的是完整的新状态。
 */
export function applyOnlineState(
  stores: OnlineStoreBundle,
  state: OnlineGameState,
  mySide: OnlineSide,
): void {
  assertOnlineState(state, state.scenarioId)
  stores.session.$patch({
    ...state.session,
    scenarioId: state.scenarioId,
  })
  stores.workbench.$patch(state.workbench)
  stores.setup.$patch(state.setup)
  stores.hotseat.$patch({
    ...state.hotseat,
    viewerSide: mySide,
    viewerLockedTo: mySide,
  })
}
