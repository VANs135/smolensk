import { describe, expect, it } from 'vitest'

import { hashOnlineState } from '@/net/hash'
import { MemoryRoomTransport } from '@/net/local'
import {
  ONLINE_PROTOCOL_VERSION,
  RoomConflictError,
  type OnlineGameState,
  type OnlineLobbyState,
} from '@/net/online-types'

function sampleState(scenarioId = '1'): OnlineGameState {
  return {
    stage: 'game',
    protocol: ONLINE_PROTOCOL_VERSION,
    dataVersion: 'test',
    scenarioId,
    session: { scenarioId },
    workbench: {},
    setup: {},
    hotseat: { mode: 'pvp', aiSide: null, setupLocked: true, scriptedSide: null },
  }
}

describe('room transport CAS', () => {
  it('creates, reads, and rejects a stale seq without overwriting the room', async () => {
    const transport = new MemoryRoomTransport()
    const token = 'test-token'
    const first = sampleState()
    const room = await transport.createRoom({
      scenarioId: '1',
      hostSide: 'axis',
      state: first,
      stateHash: await hashOnlineState(first),
      token,
    })
    expect(room.seq).toBe(1)
    expect(room.guestSide).toBe('soviet')

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
      scenarioId: null,
      hostSide: 'axis',
      state: lobby,
      stateHash: await hashOnlineState(lobby),
      token: 'lobby-token',
    })
    expect(room.state.stage).toBe('lobby')
    expect(room.scenarioId).toBeNull()

    const namedLobby: OnlineLobbyState = { ...lobby, scenarioId: '3' }
    const named = await transport.writeRoom({
      code: room.code,
      token: 'lobby-token',
      expectedSeq: room.seq,
      state: namedLobby,
      stateHash: await hashOnlineState(namedLobby),
      writerSide: 'axis',
    })
    expect(named.scenarioId).toBe('3')
    expect(named.state.stage).toBe('lobby')

    const game = sampleState('3')
    const started = await transport.writeRoom({
      code: room.code,
      token: 'lobby-token',
      expectedSeq: named.seq,
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
      scenarioId: '1',
      hostSide: 'axis',
      state,
      stateHash: await hashOnlineState(state),
      token: 'right',
    })
    await expect(transport.readRoom(room.code, 'wrong')).rejects.toThrow('房间密钥不匹配')
  })
})
