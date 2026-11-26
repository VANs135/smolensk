import type { SaveHotseatMode } from '@/engine/save-file'
import type { Side } from '@/data'

/**
 * 双人联机协议（页面侧）
 *
 * 第一版不把规则引擎搬到服务端：房间只保存一份**完整对局状态**，双方各自在本机拥有
 * 同一份 store 状态。写房间用 `seq` 做 CAS，读房间用轮询；谁的操作在自己的回合内，
 * 谁才提交。玩家可信、无服务端反作弊（用户 2026-11-27 口径）。
 */
export const ONLINE_PROTOCOL_VERSION = 1

/** 联机里的阵营与引擎 `Side` 同义；单独取别名方便协议层阅读。 */
export type OnlineSide = Side

/**
 * 一份可复制的对局状态
 *
 * 为什么不是只发 `SaveFile`：战斗现场（`combatState` / `combatInputs` / 守方地形与损失选择）
 * 明确不在存档内，而守方必须在自己的设备上完成这些步骤。故这里连同工作台/初设/模式一起
 * 复制。它只要求双方使用同一构建与同一 `DATA_VERSION`；不承诺跨版本回放。
 */
export interface OnlineGameState {
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

/** 房间行；服务端无需理解对局内容。 */
export interface OnlineRoomRecord {
  code: string
  /** 房间密钥；邀请链接里携带，服务端只做匹配，不做账号体系 */
  token: string
  scenarioId: string
  hostSide: OnlineSide
  guestSide: OnlineSide
  /** 单调递增；每次成功写房间 +1 */
  seq: number
  /** 最后一次成功写入的阵营（只作诊断/界面显示） */
  writerSide: OnlineSide
  updatedAt: string
  /** 对 `state` 的稳定哈希，用于跳过无变化的整包 */
  stateHash: string
  state: OnlineGameState
}

export interface CreateRoomInput {
  scenarioId: string
  hostSide: OnlineSide
  state: OnlineGameState
  stateHash: string
  /** 客户端生成；缺省由 transport 生成 */
  token?: string
}

export interface WriteRoomInput {
  code: string
  token: string
  expectedSeq: number
  state: OnlineGameState
  stateHash: string
  writerSide: OnlineSide
}

/** 房间读写抽象；本机双标签与 HTTP 中继共用同一套 store 逻辑。 */
export interface RoomTransport {
  readonly kind: 'local' | 'remote'
  createRoom(input: CreateRoomInput): Promise<OnlineRoomRecord>
  readRoom(code: string, token: string): Promise<OnlineRoomRecord>
  writeRoom(input: WriteRoomInput): Promise<OnlineRoomRecord>
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
    | 'transportUnavailable'
    | 'protocolMismatch'
    | 'dataVersionMismatch'
    | 'scenarioMismatch'
    | 'emptyState'

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
