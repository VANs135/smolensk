import {
  OnlineError,
  RoomConflictError,
  type CreateRoomInput,
  type OnlineRoomRecord,
  type RoomTransport,
  type WriteRoomInput,
} from './online-types'

const ROOM_PREFIX = 'smolensk-online-room:'
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function roomKey(code: string): string {
  return `${ROOM_PREFIX}${code.toUpperCase()}`
}

function storage(): Storage {
  try {
    const value = globalThis.localStorage
    if (value !== undefined) return value
  } catch {
    // 无存储（隐私模式/测试环境）时走统一错误，不静默丢对局
  }
  throw new OnlineError('transportUnavailable', '本机存储不可用，无法建立联机房间')
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length)
  if (globalThis.crypto?.getRandomValues === undefined) {
    throw new OnlineError('transportUnavailable', '浏览器缺少安全随机源，无法分配房间码')
  }
  globalThis.crypto.getRandomValues(bytes)
  let text = ''
  for (let index = 0; index < length; index += 1) {
    text += CODE_ALPHABET[bytes[index]! % CODE_ALPHABET.length]
  }
  return text
}

function parseRecord(raw: string): OnlineRoomRecord {
  const parsed = JSON.parse(raw) as Partial<OnlineRoomRecord>
  if (
    typeof parsed.code !== 'string' ||
    typeof parsed.token !== 'string' ||
    typeof parsed.seq !== 'number' ||
    typeof parsed.stateHash !== 'string' ||
    typeof parsed.state !== 'object' ||
    parsed.state === null ||
    (parsed.scenarioId !== null && typeof parsed.scenarioId !== 'string')
  ) {
    throw new OnlineError('transportUnavailable', '本机房间记录损坏')
  }
  const stage = (parsed.state as { stage?: unknown }).stage
  if (stage !== 'lobby' && stage !== 'setup' && stage !== 'game') {
    throw new OnlineError('transportUnavailable', '本机房间协议版本过旧，请重新建房')
  }
  return parsed as OnlineRoomRecord
}

/**
 * 同浏览器双标签的联机通道
 *
 * 不经过任何服务端；`localStorage` 充当共享房间行，`seq` 仍是 CAS。它用于在正式后端
 * 配置前验证“双方各看各的阵营、各点各的战斗步骤”，也方便本地联调；跨设备必须改用
 * `HttpRoomTransport`。
 */
export class LocalRoomTransport implements RoomTransport {
  readonly kind = 'local' as const

  async createRoom(input: CreateRoomInput): Promise<OnlineRoomRecord> {
    const store = storage()
    let code = ''
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = randomString(6)
      if (store.getItem(roomKey(candidate)) === null) {
        code = candidate
        break
      }
    }
    if (code === '') throw new OnlineError('transportUnavailable', '未能分配房间码')
    const token = input.token ?? randomString(24)
    const record: OnlineRoomRecord = {
      code,
      token,
      scenarioId: input.scenarioId,
      hostSide: input.hostSide,
      guestSide: input.hostSide === 'axis' ? 'soviet' : 'axis',
      seq: 1,
      writerSide: input.hostSide,
      updatedAt: new Date().toISOString(),
      stateHash: input.stateHash,
      state: input.state,
    }
    store.setItem(roomKey(code), JSON.stringify(record))
    return record
  }

  async readRoom(code: string, token: string): Promise<OnlineRoomRecord> {
    const raw = storage().getItem(roomKey(code))
    if (raw === null) throw new OnlineError('roomNotFound', `房间 ${code} 不存在`)
    const record = parseRecord(raw)
    if (record.token !== token) throw new OnlineError('badToken', '房间密钥不匹配')
    return record
  }

  async writeRoom(input: WriteRoomInput): Promise<OnlineRoomRecord> {
    const current = await this.readRoom(input.code, input.token)
    if (current.seq !== input.expectedSeq) throw new RoomConflictError(current)
    const next: OnlineRoomRecord = {
      ...current,
      scenarioId: input.state.scenarioId,
      seq: current.seq + 1,
      writerSide: input.writerSide,
      updatedAt: new Date().toISOString(),
      stateHash: input.stateHash,
      state: input.state,
    }
    storage().setItem(roomKey(input.code), JSON.stringify(next))
    return next
  }
}

/** 测试/嵌入式用：同一进程内共享一张房间表，不写 localStorage。 */
export class MemoryRoomTransport implements RoomTransport {
  readonly kind: 'local' | 'remote'
  private readonly rooms = new Map<string, OnlineRoomRecord>()

  constructor(kind: 'local' | 'remote' = 'local') {
    this.kind = kind
  }

  async createRoom(input: CreateRoomInput): Promise<OnlineRoomRecord> {
    const code = randomString(6)
    const record: OnlineRoomRecord = {
      code,
      token: input.token ?? randomString(24),
      scenarioId: input.scenarioId,
      hostSide: input.hostSide,
      guestSide: input.hostSide === 'axis' ? 'soviet' : 'axis',
      seq: 1,
      writerSide: input.hostSide,
      updatedAt: new Date().toISOString(),
      stateHash: input.stateHash,
      state: input.state,
    }
    this.rooms.set(code, record)
    return record
  }

  async readRoom(code: string, token: string): Promise<OnlineRoomRecord> {
    const record = this.rooms.get(code.toUpperCase())
    if (record === undefined) throw new OnlineError('roomNotFound', `房间 ${code} 不存在`)
    if (record.token !== token) throw new OnlineError('badToken', '房间密钥不匹配')
    return record
  }

  async writeRoom(input: WriteRoomInput): Promise<OnlineRoomRecord> {
    const current = await this.readRoom(input.code, input.token)
    if (current.seq !== input.expectedSeq) throw new RoomConflictError(current)
    const next: OnlineRoomRecord = {
      ...current,
      scenarioId: input.state.scenarioId,
      seq: current.seq + 1,
      writerSide: input.writerSide,
      updatedAt: new Date().toISOString(),
      stateHash: input.stateHash,
      state: input.state,
    }
    this.rooms.set(current.code, next)
    return next
  }
}
