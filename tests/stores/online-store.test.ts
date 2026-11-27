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

  it('hands setup to each side in cursor order, then lets the host start the game', async () => {
    const host = freshStores()
    expect(await host.online.createRoom('axis')).toBe(true)
    expect(host.online.active).toBe(true)
    expect(host.online.stage).toBe('lobby')
    expect(host.online.mySide).toBe('axis')
    expect(host.online.room?.scenarioId).toBeNull()
    expect(host.online.canWrite).toBe(true)
    // 联机外壳从建房起就锁本人阵营：初设也不能切到对方视角替其落子。
    host.online.reassertShell()
    expect(host.hotseat.viewerSide).toBe('axis')
    expect(host.hotseat.viewerLockedTo).toBe('axis')

    // 房主进入初设：先布设方是苏联（客人），房主此刻只读等待。
    host.session.$patch({ scenarioId: '1' })
    host.setup.$patch({
      applied: true,
      setupSideCursor: 'soviet',
      setupSideConfirmed: {},
      finished: false,
    })
    await host.online.publishNow()
    expect(host.online.stage).toBe('setup')
    expect(host.online.canWrite).toBe(false)
    const setupState = host.online.room?.state
    if (setupState?.stage !== 'setup') throw new Error('expected setup state')

    const code = host.online.roomCode
    const token = host.online.roomToken
    expect(code).not.toBeNull()
    expect(token).not.toBeNull()

    // 客人加入就能拿到完整初设现场，并可直接操作本方苏联。
    const guest = freshStores()
    expect(await guest.online.joinRoom(code!, token!)).toBe(true)
    expect(guest.online.active).toBe(true)
    expect(guest.online.stage).toBe('setup')
    expect(guest.online.mySide).toBe('soviet')
    expect(guest.online.canWrite).toBe(true)
    expect(guest.session.session).toBeNull()
    expect(guest.setup.applied).toBe(true)
    expect(guest.setup.setupSideCursor).toBe('soviet')
    expect(guest.hotseat.viewerSide).toBe('soviet')
    expect(guest.hotseat.viewerLockedTo).toBe('soviet')
    expect(guest.hotseat.setViewerSide('axis')).toBe(false)

    // 客人确认苏联布设 → 交棒给轴心房主；最后一包“苏联已完成”必须写进房间。
    guest.setup.$patch({
      setupSideConfirmed: { soviet: true },
      setupSideCursor: 'axis',
    })
    await guest.online.publishNow()
    await host.online.refreshNow()
    expect(host.setup.setupSideCursor).toBe('axis')
    expect(host.setup.setupSideConfirmed['soviet']).toBe(true)
    expect(host.online.canWrite).toBe(true)

    // 房主确认轴心 → 两方归位；房主收束初设并开局。
    host.setup.$patch({
      setupSideConfirmed: { soviet: true, axis: true },
      setupSideCursor: null,
    })
    await host.online.publishNow()
    await guest.online.refreshNow()
    expect(guest.setup.setupSideCursor).toBeNull()
    expect(guest.setup.setupSideConfirmed['axis']).toBe(true)
    expect(guest.online.canWrite).toBe(false)

    expect(host.session.startGame(host.workbench.seed)).toBe(true)
    host.setup.$patch({ finished: true })
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
