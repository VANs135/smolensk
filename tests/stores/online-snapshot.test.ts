import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { hashOnlineState } from '@/net/hash'
import { useGameSessionStore, useHotseatStore, useSetupStore, useWorkbenchStore } from '@/stores'
import { applyOnlineState, captureOnlineState } from '@/stores/online-snapshot'

function hostStores() {
  setActivePinia(createPinia())
  return {
    session: useGameSessionStore(),
    workbench: useWorkbenchStore(),
    setup: useSetupStore(),
    hotseat: useHotseatStore(),
  }
}

describe('online state replication', () => {
  it('captures a lobby before a scenario is entered, without touching any local board', () => {
    const stores = hostStores()
    const state = captureOnlineState(stores)
    expect(state.stage).toBe('lobby')
    expect(state.protocol).toBe(2)
    expect(state.scenarioId).toBeNull()
  })

  it('captures a complete state and applies it to a second store set', () => {
    const host = hostStores()
    expect(host.session.startGame(host.workbench.seed)).toBe(true)
    // 即使主机是从 solo 局面开房，房间也必须收成 PVP；否则对方会收到“双面可见”外壳。
    host.hotseat.setMode('solo')

    const state = captureOnlineState(host)
    if (state.stage !== 'game') throw new Error('expected a game state')
    expect(state.protocol).toBe(2)
    expect(state.hotseat.mode).toBe('pvp')
    expect(state.hotseat.aiSide).toBeNull()
    expect(state.scenarioId).toBe(host.session.scenarioId)
    expect(state.session['scenarioId']).toBe(state.scenarioId)
    // 纯本地界面字段不随房间走，战斗输入则必须保留
    expect(state.workbench['selectedId']).toBeUndefined()
    expect(state.workbench['tool']).toBeUndefined()
    expect(state.workbench['combatInputs']).toBeDefined()
    expect(state.workbench['units']).toBeDefined()

    const guest = hostStores()
    applyOnlineState(guest, state, 'soviet')

    expect(guest.session.session?.state.scenarioId).toBe(host.session.session?.state.scenarioId)
    expect(guest.session.session?.state.records.turn).toBe(host.session.session?.state.records.turn)
    expect(guest.workbench.phase).toBe(host.workbench.phase)
    expect(guest.workbench.activeSide).toBe(host.workbench.activeSide)
    expect(guest.setup.finished).toBe(host.setup.finished)
    expect(guest.hotseat.viewerSide).toBe('soviet')
    expect(guest.hotseat.viewerLockedTo).toBe('soviet')
  })

  it('locks the observer side and ignores attempts to switch to the opponent', () => {
    const stores = hostStores()
    expect(stores.session.startGame(stores.workbench.seed)).toBe(true)
    stores.hotseat.adoptOnlineShell('axis')

    expect(stores.hotseat.viewerSide).toBe('axis')
    expect(stores.hotseat.setViewerSide('soviet')).toBe(false)
    expect(stores.hotseat.viewerSide).toBe('axis')
    expect(stores.hotseat.setViewerSide('axis')).toBe(true)

    stores.hotseat.unlockViewer()
    expect(stores.hotseat.setViewerSide('soviet')).toBe(true)
    expect(stores.hotseat.viewerSide).toBe('soviet')
  })

  it('hashes the same content deterministically and notices a state change', async () => {
    const stores = hostStores()
    expect(stores.session.startGame(stores.workbench.seed)).toBe(true)
    const state = captureOnlineState(stores)
    const first = await hashOnlineState(state)
    const second = await hashOnlineState(JSON.parse(JSON.stringify(state)))
    expect(second).toBe(first)

    const changed = captureOnlineState(stores)
    if (changed.stage !== 'game') throw new Error('expected a game state')
    changed.workbench.activeSide = 'soviet'
    expect(await hashOnlineState(changed)).not.toBe(first)
  })
})
