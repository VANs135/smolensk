import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import {
  useGameSessionStore,
  useHotseatStore,
  useOnlineStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

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

function freshStores() {
  setActivePinia(createPinia())
  return {
    session: useGameSessionStore(),
    workbench: useWorkbenchStore(),
    setup: useSetupStore(),
    hotseat: useHotseatStore(),
    online: useOnlineStore(),
  }
}

describe('online store local transport', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    })
  })

  it('opens a room before scenario selection and only replaces the guest when the host starts', async () => {
    const host = freshStores()
    expect(await host.online.createRoom('axis')).toBe(true)
    expect(host.online.active).toBe(true)
    expect(host.online.stage).toBe('lobby')
    expect(host.online.mySide).toBe('axis')
    expect(host.online.room?.scenarioId).toBeNull()
    expect(host.online.canWrite).toBe(true)
    // 开始台建房本身不碰盘面；lobby 初设由房主独自布两方，先不锁视角。
    host.online.reassertShell()
    expect(host.hotseat.viewerSide).toBe('axis')
    expect(host.hotseat.viewerLockedTo).toBeNull()
    // 初设游标换到苏联，房主视角跟着走，否则执轴心时会被“等苏联布设”卡死。
    host.setup.$patch({ setupSideCursor: 'soviet' })
    expect(host.hotseat.viewerSide).toBe('soviet')
    const code = host.online.roomCode
    const token = host.online.roomToken
    expect(code).not.toBeNull()
    expect(token).not.toBeNull()

    const guest = freshStores()
    expect(await guest.online.joinRoom(code!, token!)).toBe(true)
    expect(guest.online.active).toBe(true)
    expect(guest.online.stage).toBe('lobby')
    expect(guest.online.mySide).toBe('soviet')
    expect(guest.online.canWrite).toBe(false)
    // lobby 阶段只占座等待，不替换客人本机盘面。
    expect(guest.session.session).toBeNull()
    expect(guest.hotseat.viewerLockedTo).toBeNull()

    // 房主选完剧本、完成初设并开局后，同一房间转为完整 PVP 状态。
    expect(host.session.startGame(host.workbench.seed)).toBe(true)
    host.setup.$patch({ finished: true })
    host.workbench.activeSide = 'axis'
    await host.online.publishNow()
    expect(host.online.stage).toBe('game')
    expect(host.hotseat.viewerLockedTo).toBe('axis')
    const hostState = host.online.room?.state
    if (hostState?.stage !== 'game') throw new Error('expected game state')
    expect(hostState.hotseat.mode).toBe('pvp')

    await guest.online.refreshNow()
    expect(guest.online.stage).toBe('game')
    expect(guest.session.session).not.toBeNull()
    expect(guest.hotseat.mode).toBe('pvp')
    expect(guest.hotseat.fogDisabled).toBe(false)
    expect(guest.hotseat.viewerSide).toBe('soviet')
    expect(guest.hotseat.viewerLockedTo).toBe('soviet')
    expect(guest.online.canWrite).toBe(false)
    expect(guest.session.session?.state.scenarioId).toBe(host.session.session?.state.scenarioId)
    expect(guest.hotseat.setViewerSide('axis')).toBe(false)

    host.online.leaveRoom()
    guest.online.leaveRoom()
    expect(guest.hotseat.viewerLockedTo).toBeNull()
  })
})
