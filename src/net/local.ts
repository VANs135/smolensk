import {
  OnlineError,
  RoomConflictError,
  type CreateRoomInput,
  type JoinRoomInput,
  type LeaveRoomInput,
  type OnlineRoomRecord,
  type OnlineRoomSummary,
  type OnlineState,
  type RoomTransport,
  type WriteRoomInput,
} from './online-types'

const ROOM_PREFIX = 'smolensk-online-room:'
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** 本机房间与中继保持同一默认生命周期：24 小时无活动自动删除。 */
const ROOM_TTL_MS = 24 * 3_600_000

/** localStorage 里的房间行比公开记录多密码和两个座位凭证；读给页面前必须剥掉。 */
interface StoredRoomRecord extends OnlineRoomRecord {
  password: string
  hostSecret: string
  guestSecret: string | null
}

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

function stageOf(state: OnlineState): OnlineRoomRecord['stage'] {
  return state.stage
}

function summarize(record: OnlineRoomRecord): OnlineRoomSummary {
  return {
    code: record.code,
    name: record.name,
    hostId: record.hostId,
    guestId: record.guestId,
    hostSide: record.hostSide,
    guestSide: record.guestSide,
    scenarioId: record.scenarioId,
    stage: record.stage,
    playerCount: record.playerCount,
    joinable: record.joinable,
    updatedAt: record.updatedAt,
  }
}

function publicRecord(
  record: StoredRoomRecord,
  seat: 'host' | 'guest' | null = null,
): OnlineRoomRecord {
  const { password: passwordValue, hostSecret, guestSecret, ...rest } = record
  void passwordValue
  if (seat === 'host') return { ...rest, hostSecret }
  if (seat === 'guest' && guestSecret !== null) return { ...rest, guestSecret }
  return rest
}

function isExpired(record: StoredRoomRecord): boolean {
  const updatedAt = Date.parse(record.updatedAt)
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt > ROOM_TTL_MS
}

function parseRecord(raw: string): StoredRoomRecord {
  const parsed = JSON.parse(raw) as Partial<StoredRoomRecord>
  if (
    typeof parsed.code !== 'string' ||
    typeof parsed.token !== 'string' ||
    typeof parsed.name !== 'string' ||
    typeof parsed.hostId !== 'string' ||
    (parsed.guestId !== null && typeof parsed.guestId !== 'string') ||
    typeof parsed.password !== 'string' ||
    typeof parsed.hostSecret !== 'string' ||
    (parsed.guestSecret !== null && typeof parsed.guestSecret !== 'string') ||
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
  return parsed as StoredRoomRecord
}

function readStored(code: string): StoredRoomRecord {
  const key = roomKey(code.trim().toUpperCase())
  const raw = storage().getItem(key)
  if (raw === null) throw new OnlineError('roomNotFound', `房间 ${code} 不存在`)
  const record = parseRecord(raw)
  if (isExpired(record)) {
    storage().removeItem(key)
    throw new OnlineError('roomNotFound', `房间 ${code} 已过期`)
  }
  return record
}

function writeStored(record: StoredRoomRecord): void {
  storage().setItem(roomKey(record.code), JSON.stringify(record))
}

function listStored(): StoredRoomRecord[] {
  const store = storage()
  const records: StoredRoomRecord[] = []
  const expiredKeys: string[] = []
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index)
    if (key === null || !key.startsWith(ROOM_PREFIX)) continue
    const raw = store.getItem(key)
    if (raw === null) continue
    try {
      const record = parseRecord(raw)
      if (isExpired(record)) {
        expiredKeys.push(key)
        continue
      }
      records.push(record)
    } catch {
      // 旧版本/损坏行不阻塞大厅；列表只展示能解析的新协议房间。
    }
  }
  for (const key of expiredKeys) store.removeItem(key)
  return records
}

function assertRoomNameFree(name: string, rooms: readonly StoredRoomRecord[], except?: string) {
  const normalized = name.trim().toLocaleLowerCase()
  if (
    rooms.some(
      (room) => room.code !== except && room.name.trim().toLocaleLowerCase() === normalized,
    )
  ) {
    throw new OnlineError('roomNameTaken', `房间名「${name.trim()}」已被占用，请换一个`)
  }
}

function baseRecord(input: {
  code: string
  token: string
  name: string
  password: string
  hostId: string
  scenarioId: string | null
  hostSide: OnlineRoomRecord['hostSide']
  state: OnlineState
  stateHash: string
}): StoredRoomRecord {
  return {
    code: input.code,
    token: input.token,
    name: input.name.trim(),
    password: input.password.trim(),
    hostId: input.hostId.trim(),
    hostSecret: randomString(24),
    guestId: null,
    guestSecret: null,
    hostSide: input.hostSide,
    guestSide: input.hostSide === 'axis' ? 'soviet' : 'axis',
    scenarioId: input.scenarioId,
    stage: stageOf(input.state),
    playerCount: 1,
    joinable: true,
    seq: 1,
    writerSide: input.hostSide,
    updatedAt: new Date().toISOString(),
    stateHash: input.stateHash,
    state: input.state,
  }
}

/**
 * 同浏览器双标签的联机通道
 *
 * 不经过任何服务端；`localStorage` 充当共享房间行，`seq` 仍是 CAS。它用于在正式后端
 * 配置前验证“双方各看各的阵营、各点各的战斗步骤”，也方便本地联调；跨设备必须改用
 * `HttpRoomTransport`。本机通道同样走大厅/密码流程，但密码只存在本机存储里，不是安全边界。
 */
export class LocalRoomTransport implements RoomTransport {
  readonly kind = 'local' as const

  async listRooms(): Promise<OnlineRoomSummary[]> {
    return listStored()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(summarize)
  }

  async createRoom(input: CreateRoomInput): Promise<OnlineRoomRecord> {
    const store = storage()
    const rooms = listStored()
    assertRoomNameFree(input.name, rooms)
    let code = ''
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = randomString(6)
      if (store.getItem(roomKey(candidate)) === null) {
        code = candidate
        break
      }
    }
    if (code === '') throw new OnlineError('transportUnavailable', '未能分配房间码')
    const record = baseRecord({
      ...input,
      code,
      token: randomString(24),
    })
    writeStored(record)
    return publicRecord(record, 'host')
  }

  async joinRoom(input: JoinRoomInput): Promise<OnlineRoomRecord> {
    const current = readStored(input.code)
    if (current.password !== input.password.trim()) {
      throw new OnlineError('badPassword', '房间密码不正确')
    }
    const playerId = input.playerId.trim()
    if (playerId === '') throw new OnlineError('invalidInput', '请先填写你的 ID')
    if (playerId === current.hostId) {
      if (input.hostSecret !== current.hostSecret) {
        throw new OnlineError('badHostClaim', '房主座位凭证不匹配')
      }
      return publicRecord(current, 'host')
    }
    if (current.guestId === playerId) {
      if (input.guestSecret !== current.guestSecret) {
        throw new OnlineError('badGuestClaim', '客人座位凭证不匹配')
      }
      return publicRecord(current, 'guest')
    }
    if (current.guestId !== null) {
      throw new OnlineError('roomFull', '房间已经坐满，只有房主和已加入的玩家能重连')
    }
    const next: StoredRoomRecord = {
      ...current,
      guestId: playerId,
      guestSecret: randomString(24),
      playerCount: 2,
      joinable: false,
      updatedAt: new Date().toISOString(),
    }
    writeStored(next)
    return publicRecord(next, 'guest')
  }

  async leaveRoom(input: LeaveRoomInput): Promise<void> {
    const current = readStored(input.code)
    if (current.password !== input.password.trim()) {
      throw new OnlineError('badPassword', '房间密码不正确')
    }
    const playerId = input.playerId.trim()
    if (playerId === current.hostId) {
      if (input.hostSecret !== current.hostSecret) {
        throw new OnlineError('badHostClaim', '房主座位凭证不匹配')
      }
      storage().removeItem(roomKey(current.code))
      return
    }
    if (current.guestId !== playerId) throw new OnlineError('badToken', '你不在这个房间')
    if (input.guestSecret !== current.guestSecret) {
      throw new OnlineError('badGuestClaim', '客人座位凭证不匹配')
    }
    writeStored({
      ...current,
      guestId: null,
      guestSecret: null,
      playerCount: 1,
      joinable: true,
      updatedAt: new Date().toISOString(),
    })
  }

  async readRoom(code: string, token: string): Promise<OnlineRoomRecord> {
    const record = readStored(code)
    if (record.token !== token) throw new OnlineError('badToken', '房间令牌不匹配')
    return publicRecord(record)
  }

  async writeRoom(input: WriteRoomInput): Promise<OnlineRoomRecord> {
    const current = readStored(input.code)
    if (current.token !== input.token) throw new OnlineError('badToken', '房间令牌不匹配')
    if (current.seq !== input.expectedSeq) throw new RoomConflictError(publicRecord(current))
    const next: StoredRoomRecord = {
      ...current,
      scenarioId: input.state.scenarioId,
      stage: stageOf(input.state),
      seq: current.seq + 1,
      writerSide: input.writerSide,
      updatedAt: new Date().toISOString(),
      stateHash: input.stateHash,
      state: input.state,
    }
    writeStored(next)
    return publicRecord(next)
  }
}

/** 测试/嵌入式用：同一进程内共享一张房间表，不写 localStorage。 */
export class MemoryRoomTransport implements RoomTransport {
  readonly kind: 'local' | 'remote'
  private readonly rooms = new Map<string, StoredRoomRecord>()

  constructor(kind: 'local' | 'remote' = 'local') {
    this.kind = kind
  }

  async listRooms(): Promise<OnlineRoomSummary[]> {
    return [...this.rooms.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(summarize)
  }

  async createRoom(input: CreateRoomInput): Promise<OnlineRoomRecord> {
    assertRoomNameFree(input.name, [...this.rooms.values()])
    const record = baseRecord({
      ...input,
      code: randomString(6),
      token: randomString(24),
    })
    this.rooms.set(record.code, record)
    return publicRecord(record, 'host')
  }

  async joinRoom(input: JoinRoomInput): Promise<OnlineRoomRecord> {
    const current = this.rooms.get(input.code.trim().toUpperCase())
    if (current === undefined) throw new OnlineError('roomNotFound', `房间 ${input.code} 不存在`)
    if (current.password !== input.password.trim()) {
      throw new OnlineError('badPassword', '房间密码不正确')
    }
    const playerId = input.playerId.trim()
    if (playerId === '') throw new OnlineError('invalidInput', '请先填写你的 ID')
    if (playerId === current.hostId) {
      if (input.hostSecret !== current.hostSecret) {
        throw new OnlineError('badHostClaim', '房主座位凭证不匹配')
      }
      return publicRecord(current, 'host')
    }
    if (current.guestId === playerId) {
      if (input.guestSecret !== current.guestSecret) {
        throw new OnlineError('badGuestClaim', '客人座位凭证不匹配')
      }
      return publicRecord(current, 'guest')
    }
    if (current.guestId !== null) {
      throw new OnlineError('roomFull', '房间已经坐满，只有房主和已加入的玩家能重连')
    }
    const next: StoredRoomRecord = {
      ...current,
      guestId: playerId,
      guestSecret: randomString(24),
      playerCount: 2,
      joinable: false,
      updatedAt: new Date().toISOString(),
    }
    this.rooms.set(current.code, next)
    return publicRecord(next, 'guest')
  }

  async leaveRoom(input: LeaveRoomInput): Promise<void> {
    const current = this.rooms.get(input.code.trim().toUpperCase())
    if (current === undefined) throw new OnlineError('roomNotFound', `房间 ${input.code} 不存在`)
    if (current.password !== input.password.trim()) {
      throw new OnlineError('badPassword', '房间密码不正确')
    }
    const playerId = input.playerId.trim()
    if (playerId === current.hostId) {
      if (input.hostSecret !== current.hostSecret) {
        throw new OnlineError('badHostClaim', '房主座位凭证不匹配')
      }
      this.rooms.delete(current.code)
      return
    }
    if (current.guestId !== playerId) throw new OnlineError('badToken', '你不在这个房间')
    if (input.guestSecret !== current.guestSecret) {
      throw new OnlineError('badGuestClaim', '客人座位凭证不匹配')
    }
    this.rooms.set(current.code, {
      ...current,
      guestId: null,
      guestSecret: null,
      playerCount: 1,
      joinable: true,
      updatedAt: new Date().toISOString(),
    })
  }

  async readRoom(code: string, token: string): Promise<OnlineRoomRecord> {
    const record = this.rooms.get(code.trim().toUpperCase())
    if (record === undefined) throw new OnlineError('roomNotFound', `房间 ${code} 不存在`)
    if (record.token !== token) throw new OnlineError('badToken', '房间令牌不匹配')
    return publicRecord(record)
  }

  async writeRoom(input: WriteRoomInput): Promise<OnlineRoomRecord> {
    const current = this.rooms.get(input.code.trim().toUpperCase())
    if (current === undefined) throw new OnlineError('roomNotFound', `房间 ${input.code} 不存在`)
    if (current.token !== input.token) throw new OnlineError('badToken', '房间令牌不匹配')
    if (current.seq !== input.expectedSeq) throw new RoomConflictError(publicRecord(current))
    const next: StoredRoomRecord = {
      ...current,
      scenarioId: input.state.scenarioId,
      stage: stageOf(input.state),
      seq: current.seq + 1,
      writerSide: input.writerSide,
      updatedAt: new Date().toISOString(),
      stateHash: input.stateHash,
      state: input.state,
    }
    this.rooms.set(current.code, next)
    return publicRecord(next)
  }
}
