import type { SaveHotseatMode } from '@/engine/save-file'
import type { Side } from '@/data'

/**
 * 双人联机协议（页面侧）
 *
 * 第一版不把规则引擎搬到服务端：房间只保存一份**完整对局状态**，双方各自在本机拥有
 * 同一份 store 状态。写房间用 `seq` 做 CAS，读房间用轮询；谁的操作在自己的回合内，
 * 谁才提交。玩家可信、无服务端反作弊（用户 2026-11-27 口径）。
 */
export const ONLINE_PROTOCOL_VERSION = 3

/** 联机里的阵营与引擎 `Side` 同义；单独取别名方便协议层阅读。 */
export type OnlineSide = Side

/**
 * 房间阶段
 *
 * `lobby`：已在开始台建房，但还没进入初设。此时没有会话，只同步“选了哪个剧本”；
 * `setup`：房主已进入初设，房间带完整初设状态。双方各自布设本方，按
 *   `setup.setupSideCursor` 的先后手交棒；此时 `session.session` 仍为 null；
 * `game`：双方完成初设并开局，房间带完整对局状态，双方进入棋桌。
 */
export type OnlineStage = 'lobby' | 'setup' | 'game'

/**
 * 选剧本前建立的空房间
 *
 * 用户 2026-11-27 口径：PVP 房间改在选剧本前创建，方便先把邀请发给对方。
 * 房间此时只同步房间头与已选剧本，不复制任何本机盘面。
 */
export interface OnlineLobbyState {
  stage: 'lobby'
  protocol: number
  dataVersion: string
  /** 已选剧本；未进入初设前为 null */
  scenarioId: string | null
}

/**
 * 初设 / 对局的公共状态
 *
 * 为什么不是只发 `SaveFile`：战斗现场（`combatState` / `combatInputs` / 守方地形与损失选择）
 * 明确不在存档内，而守方必须在自己的设备上完成这些步骤。故这里连同工作台/初设/模式一起
 * 复制。它只要求双方使用同一构建与同一 `DATA_VERSION`；不承诺跨版本回放。
 *
 * `setup` 阶段同样带完整状态：对方要能在自己的设备上完成本方初设，而不是看房主单机布完。
 */
export interface OnlineLiveStateBase {
  /** 协议版本；双方不一致直接拒收 */
  protocol: number
  /** 数据契约版本；不同构建的算子/剧本表不能互读 */
  dataVersion: string
  /** 剧本 id（冗余校验，防止把别的局塞进当前房间） */
  scenarioId: string
  /** `useGameSessionStore().$state` 的可序列化副本（不含本地存储适配器） */
  session: Record<string, unknown>
  /** `useWorkbenchStore().$state` 的可序列化副本（已剔除纯本地界面字段） */
  workbench: Record<string, unknown>
  /** `useSetupStore().$state` 的可序列化副本 */
  setup: Record<string, unknown>
  /** 对局组织方式；观察方由各客户端自己的 `mySide` 固定，不发 `viewerSide` */
  hotseat: {
    mode: SaveHotseatMode | null
    aiSide: Side | null
    setupLocked: boolean
    scriptedSide: Side | null
  }
}

/** 初设进行中：`session.session` 必须为 null，双方按初设游标各自布设本方。 */
export interface OnlineSetupState extends OnlineLiveStateBase {
  stage: 'setup'
}

/** 开局后：`session.session` 必须是活动会话。 */
export interface OnlineGameState extends OnlineLiveStateBase {
  stage: 'game'
}

/** 已经带完整对局内容的状态（`setup` / `game`）；`lobby` 不在此列。 */
export type OnlineLiveState = OnlineSetupState | OnlineGameState

export type OnlineState = OnlineLobbyState | OnlineLiveState

/**
 * 大厅里可见的房间摘要
 *
 * 只放公开信息：房间名、房主 ID、已加入的客人 ID、阶段与人数。**房间密码与写房令牌
 * 不在此列**；密码只在加入时提交并由服务端校验。
 */
export interface OnlineRoomSummary {
  code: string
  /** 玩家自设的房间名 */
  name: string
  /** 房主自设的显示 ID */
  hostId: string
  /** 已加入的客人 ID；未加入为 null */
  guestId: string | null
  hostSide: OnlineSide
  guestSide: OnlineSide
  scenarioId: string | null
  stage: OnlineStage
  playerCount: number
  /** 当前是否还能加入（未满且未过期） */
  joinable: boolean
  updatedAt: string
}

/** 房间行；服务端无需理解对局内容。令牌只发给已通过密码校验的客户端。 */
export interface OnlineRoomRecord extends OnlineRoomSummary {
  /** 写房令牌；只在创建或加入成功后下发 */
  token: string
  /** 单调递增；每次成功写房间 +1 */
  seq: number
  /** 最后一次成功写入的阵营（只作诊断/界面显示） */
  writerSide: OnlineSide
  /** 对 `state` 的稳定哈希，用于跳过无变化的整包 */
  stateHash: string
  state: OnlineState
}

export interface CreateRoomInput {
  /** 玩家自设的房间名 */
  name: string
  /** 玩家自设的房间密码；服务端只存哈希 */
  password: string
  /** 房主显示 ID */
  hostId: string
  scenarioId: string | null
  hostSide: OnlineSide
  state: OnlineState
  stateHash: string
}

export interface JoinRoomInput {
  code: string
  /** 房主私下分享的房间密码 */
  password: string
  /** 加入者显示 ID */
  playerId: string
}

export interface WriteRoomInput {
  code: string
  token: string
  expectedSeq: number
  state: OnlineState
  stateHash: string
  writerSide: OnlineSide
}

/** 房间阶段类型守卫；界面与 store 共用，不靠 `stage` 字符串散落判断。 */
export function isOnlineSetupState(state: OnlineState): state is OnlineSetupState {
  return state.stage === 'setup'
}

export function isOnlineGameState(state: OnlineState): state is OnlineGameState {
  return state.stage === 'game'
}

/** 已经带完整对局内容（初设或开局后）；`lobby` 不在此列。 */
export function isOnlineLiveState(state: OnlineState): state is OnlineLiveState {
  return state.stage === 'setup' || state.stage === 'game'
}

/** 房间读写抽象；本机双标签与 HTTP 中继共用同一套 store 逻辑。 */
export interface LeaveRoomInput {
  code: string
  password: string
  playerId: string
}

export interface RoomTransport {
  readonly kind: 'local' | 'remote'
  listRooms(): Promise<OnlineRoomSummary[]>
  createRoom(input: CreateRoomInput): Promise<OnlineRoomRecord>
  joinRoom(input: JoinRoomInput): Promise<OnlineRoomRecord>
  readRoom(code: string, token: string): Promise<OnlineRoomRecord>
  writeRoom(input: WriteRoomInput): Promise<OnlineRoomRecord>
  leaveRoom(input: LeaveRoomInput): Promise<void>
}

/** 写冲突：`latest` 是服务端当前行，调用方据此决定重放还是接受。 */
export class RoomConflictError extends Error {
  readonly latest: OnlineRoomRecord

  constructor(latest: OnlineRoomRecord) {
    super('roomSeqConflict:房间已被对方先写入')
    this.name = 'RoomConflictError'
    this.latest = latest
  }
}

/** 协议/传输错误，`code` 供界面给可理解文案（不透传原始网络错误）。 */
export class OnlineError extends Error {
  readonly code:
    | 'roomNotFound'
    | 'badToken'
    | 'badPassword'
    | 'roomFull'
    | 'roomNameTaken'
    | 'transportUnavailable'
    | 'protocolMismatch'
    | 'dataVersionMismatch'
    | 'scenarioMismatch'
    | 'emptyState'
    | 'invalidInput'

  constructor(code: OnlineError['code'], message: string) {
    super(message)
    this.name = 'OnlineError'
    this.code = code
  }
}

export const ONLINE_SIDE_LABEL: Readonly<Record<OnlineSide, string>> = {
  axis: '轴心国',
  soviet: '苏联',
}

export function otherOnlineSide(side: OnlineSide): OnlineSide {
  return side === 'axis' ? 'soviet' : 'axis'
}
