import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useGameSessionStore, useHotseatStore, useOnlineStore, useWorkbenchStore } from '@/stores'

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

function bootGame() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useGameSessionStore()
  const workbench = useWorkbenchStore()
  const hotseat = useHotseatStore()
  const online = useOnlineStore()
  expect(session.startGame(workbench.seed)).toBe(true)
  hotseat.setMode('pvp')
  return { session, workbench, hotseat, online }
}

describe('online store local transport', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    })
  })

  it('host creates a room and guest joins with the opposite fixed side', async () => {
    const host = bootGame()
    // 联机房间必须收成 PVP 外壳：即使主机从 solo 局面开房，也不能把双面可见状态复制给对方。
    host.hotseat.setMode('solo')
    expect(await host.online.createRoom('axis')).toBe(true)
    expect(host.online.active).toBe(true)
    expect(host.online.mySide).toBe('axis')
    expect(host.hotseat.viewerSide).toBe('axis')
    expect(host.hotseat.viewerLockedTo).toBe('axis')
    expect(host.online.room?.state.hotseat.mode).toBe('pvp')
    const code = host.online.roomCode
    const token = host.online.roomToken
    expect(code).not.toBeNull()
    expect(token).not.toBeNull()

    const guest = bootGame()
    guest.hotseat.setMode('solo')
    expect(await guest.online.joinRoom(code!, token!)).toBe(true)
    expect(guest.online.active).toBe(true)
    expect(guest.online.mySide).toBe('soviet')
    expect(guest.hotseat.viewerSide).toBe('soviet')
    expect(guest.hotseat.viewerLockedTo).toBe('soviet')
    expect(guest.hotseat.mode).toBe('pvp')
    expect(guest.hotseat.fogDisabled).toBe(false)
    expect(guest.online.canWrite).toBe(false)
    expect(guest.session.session?.state.scenarioId).toBe(host.session.session?.state.scenarioId)
    expect(guest.hotseat.setViewerSide('axis')).toBe(false)

    host.online.leaveRoom()
    guest.online.leaveRoom()
    expect(guest.hotseat.viewerLockedTo).toBeNull()
  })
})
