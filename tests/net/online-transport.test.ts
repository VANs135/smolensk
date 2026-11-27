import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hashOnlineState } from '@/net/hash'
import { LocalRoomTransport, MemoryRoomTransport } from '@/net/local'
import {
  ONLINE_PROTOCOL_VERSION,
  RoomConflictError,
  type OnlineGameState,
  type OnlineLobbyState,
  type OnlineSetupState,
} from '@/net/online-types'

function sampleState(scenarioId = '1'): OnlineGameState {
  return {
    stage: 'game',
    protocol: ONLINE_PROTOCOL_VERSION,
    dataVersion: 'test',
    scenarioId,
    session: { scenarioId, session: { scenarioId } },
    workbench: {},
    setup: {},
    hotseat: { mode: 'pvp', aiSide: null, setupLocked: true, scriptedSide: null },
  }
}

function sampleSetupState(scenarioId = '3'): OnlineSetupState {
  return {
    stage: 'setup',
    protocol: ONLINE_PROTOCOL_VERSION,
    dataVersion: 'test',
    scenarioId,
    session: { scenarioId, session: null },
    workbench: {},
    setup: { applied: true, setupSideCursor: 'soviet' },
    hotseat: { mode: 'pvp', aiSide: null, setupLocked: true, scriptedSide: null },
  }
}

describe('room transport CAS', () => {
  it('creates, reads, and rejects a stale seq without overwriting the room', async () => {
    const transport = new MemoryRoomTransport()
    const first = sampleState()
    const room = await transport.createRoom({
      name: '测试房',
      password: 'pass1234',
      hostId: 'host',
      scenarioId: '1',
      hostSide: 'axis',
      state: first,
      stateHash: await hashOnlineState(first),
    })
    expect(room.seq).toBe(1)
    expect(room.guestSide).toBe('soviet')
    expect(room.name).toBe('测试房')
    expect(room.hostSecret).toBeTruthy()
    expect(room.guestSecret).toBeUndefined()

    const token = room.token
    const read = await transport.readRoom(room.code, token)
    expect(read.stateHash).toBe(room.stateHash)

    const second = sampleState()
    second.workbench = { lastStep: 'movement' }
    const secondHash = await hashOnlineState(second)
    const written = await transport.writeRoom({
      code: room.code,
      token,
      expectedSeq: 1,
      state: second,
      stateHash: secondHash,
      writerSide: 'soviet',
    })
    expect(written.seq).toBe(2)
    expect(written.writerSide).toBe('soviet')
    expect(written.stateHash).toBe(secondHash)

    await expect(
      transport.writeRoom({
        code: room.code,
        token,
        expectedSeq: 1,
        state: first,
        stateHash: await hashOnlineState(first),
        writerSide: 'axis',
      }),
    ).rejects.toBeInstanceOf(RoomConflictError)

    const latest = await transport.readRoom(room.code, token)
    expect(latest.seq).toBe(2)
    expect(latest.stateHash).toBe(secondHash)
  })

  it('accepts a lobby room created before a scenario and later replaces it with the game', async () => {
    const transport = new MemoryRoomTransport()
    const lobby: OnlineLobbyState = {
      stage: 'lobby',
      protocol: ONLINE_PROTOCOL_VERSION,
      dataVersion: 'test',
      scenarioId: null,
    }
    const room = await transport.createRoom({
      name: '大厅房',
      password: 'pass1234',
      hostId: 'host',
      scenarioId: null,
      hostSide: 'axis',
      state: lobby,
      stateHash: await hashOnlineState(lobby),
    })
    expect(room.state.stage).toBe('lobby')
    expect(room.scenarioId).toBeNull()
    const token = room.token

    const namedLobby: OnlineLobbyState = { ...lobby, scenarioId: '3' }
    const named = await transport.writeRoom({
      code: room.code,
      token,
      expectedSeq: room.seq,
      state: namedLobby,
      stateHash: await hashOnlineState(namedLobby),
      writerSide: 'axis',
    })
    expect(named.scenarioId).toBe('3')
    expect(named.state.stage).toBe('lobby')

    const setup = sampleSetupState('3')
    const inSetup = await transport.writeRoom({
      code: room.code,
      token,
      expectedSeq: named.seq,
      state: setup,
      stateHash: await hashOnlineState(setup),
      writerSide: 'axis',
    })
    expect(inSetup.scenarioId).toBe('3')
    expect(inSetup.state.stage).toBe('setup')

    const game = sampleState('3')
    const started = await transport.writeRoom({
      code: room.code,
      token,
      expectedSeq: inSetup.seq,
      state: game,
      stateHash: await hashOnlineState(game),
      writerSide: 'axis',
    })
    expect(started.scenarioId).toBe('3')
    expect(started.state.stage).toBe('game')
  })

  it('rejects a wrong room key', async () => {
    const transport = new MemoryRoomTransport()
    const state = sampleState()
    const room = await transport.createRoom({
      name: '钥匙房',
      password: 'pass1234',
      hostId: 'host',
      scenarioId: '1',
      hostSide: 'axis',
      state,
      stateHash: await hashOnlineState(state),
    })
    await expect(transport.readRoom(room.code, 'wrong')).rejects.toThrow('房间令牌不匹配')
  })

  it('lists public rooms without passwords, then admits the guest by password', async () => {
    const transport = new MemoryRoomTransport()
    const lobby: OnlineLobbyState = {
      stage: 'lobby',
      protocol: ONLINE_PROTOCOL_VERSION,
      dataVersion: 'test',
      scenarioId: null,
    }
    const room = await transport.createRoom({
      name: '私密房',
      password: 'secret-123',
      hostId: '房主A',
      scenarioId: null,
      hostSide: 'axis',
      state: lobby,
      stateHash: await hashOnlineState(lobby),
    })
    const listed = await transport.listRooms()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.name).toBe('私密房')
    expect(listed[0]?.hostId).toBe('房主A')
    expect(listed[0]?.joinable).toBe(true)
    expect(JSON.stringify(listed)).not.toContain('secret-123')
    expect(JSON.stringify(listed)).not.toContain(room.token)
    expect(JSON.stringify(listed)).not.toContain(room.hostSecret ?? '')
    expect(JSON.stringify(listed)).not.toContain('hostSecret')
    expect(JSON.stringify(listed)).not.toContain('guestSecret')

    await expect(
      transport.joinRoom({ code: room.code, password: 'wrong', playerId: '客人B' }),
    ).rejects.toThrow('房间密码不正确')

    await expect(
      transport.joinRoom({ code: room.code, password: 'secret-123', playerId: '房主A' }),
    ).rejects.toThrow('房主座位凭证不匹配')

    const joined = await transport.joinRoom({
      code: room.code,
      password: 'secret-123',
      playerId: '客人B',
    })
    expect(joined.guestId).toBe('客人B')
    expect(joined.playerCount).toBe(2)
    expect(joined.joinable).toBe(false)
    expect(joined.token).toBe(room.token)
    expect(joined.guestSecret).toBeTruthy()
    expect(joined.hostSecret).toBeUndefined()

    await expect(
      transport.joinRoom({ code: room.code, password: 'secret-123', playerId: '第三人C' }),
    ).rejects.toThrow('房间已经坐满')

    await expect(
      transport.joinRoom({ code: room.code, password: 'secret-123', playerId: '客人B' }),
    ).rejects.toThrow('客人座位凭证不匹配')

    const rejoined = await transport.joinRoom({
      code: room.code,
      password: 'secret-123',
      playerId: '客人B',
      guestSecret: joined.guestSecret ?? undefined,
    })
    expect(rejoined.guestId).toBe('客人B')

    const hostRejoined = await transport.joinRoom({
      code: room.code,
      password: 'secret-123',
      playerId: '房主A',
      hostSecret: room.hostSecret ?? undefined,
    })
    expect(hostRejoined.hostSecret).toBe(room.hostSecret)
    expect(hostRejoined.guestSecret).toBeUndefined()
  })

  it('rejects duplicate room names', async () => {
    const transport = new MemoryRoomTransport()
    const lobby: OnlineLobbyState = {
      stage: 'lobby',
      protocol: ONLINE_PROTOCOL_VERSION,
      dataVersion: 'test',
      scenarioId: null,
    }
    const input = {
      name: '同名房',
      password: 'pass1234',
      hostId: 'host',
      scenarioId: null,
      hostSide: 'axis' as const,
      state: lobby,
      stateHash: await hashOnlineState(lobby),
    }
    await transport.createRoom(input)
    await expect(transport.createRoom({ ...input, hostId: 'host2' })).rejects.toThrow('已被占用')
  })

  it('frees a guest seat on leave and closes the room when the host leaves', async () => {
    const transport = new MemoryRoomTransport()
    const lobby: OnlineLobbyState = {
      stage: 'lobby',
      protocol: ONLINE_PROTOCOL_VERSION,
      dataVersion: 'test',
      scenarioId: null,
    }
    const room = await transport.createRoom({
      name: '离房测试',
      password: 'pass1234',
      hostId: '房主',
      scenarioId: null,
      hostSide: 'axis',
      state: lobby,
      stateHash: await hashOnlineState(lobby),
    })
    const guest = await transport.joinRoom({
      code: room.code,
      password: 'pass1234',
      playerId: '客人',
    })
    await expect(
      transport.leaveRoom({ code: room.code, password: 'pass1234', playerId: '客人' }),
    ).rejects.toThrow('客人座位凭证不匹配')
    await transport.leaveRoom({
      code: room.code,
      password: 'pass1234',
      playerId: '客人',
      guestSecret: guest.guestSecret ?? undefined,
    })
    const afterGuest = (await transport.listRooms())[0]
    expect(afterGuest?.guestId).toBeNull()
    expect(afterGuest?.joinable).toBe(true)

    await expect(
      transport.leaveRoom({ code: room.code, password: 'pass1234', playerId: '房主' }),
    ).rejects.toThrow('房主座位凭证不匹配')
    await transport.leaveRoom({
      code: room.code,
      password: 'pass1234',
      playerId: '房主',
      hostSecret: room.hostSecret,
    })
    expect(await transport.listRooms()).toEqual([])
  })
})

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('local room TTL', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-27T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(globalThis, 'localStorage')
  })

  it('drops a local room after 24h without any update', async () => {
    const transport = new LocalRoomTransport()
    const lobby: OnlineLobbyState = {
      stage: 'lobby',
      protocol: ONLINE_PROTOCOL_VERSION,
      dataVersion: 'test',
      scenarioId: null,
    }
    const room = await transport.createRoom({
      name: 'TTL 房',
      password: 'pass1234',
      hostId: '房主',
      scenarioId: null,
      hostSide: 'axis',
      state: lobby,
      stateHash: await hashOnlineState(lobby),
    })
    expect(await transport.listRooms()).toHaveLength(1)

    vi.advanceTimersByTime(24 * 3_600_000 + 60_000)

    expect(await transport.listRooms()).toEqual([])
    await expect(transport.readRoom(room.code, room.token)).rejects.toThrow('房间')
  })
})
