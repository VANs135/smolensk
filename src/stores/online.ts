import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { DATA_VERSION } from '@/data'
import { resolveRoomTransport } from '@/net'
import { hashOnlineState } from '@/net/hash'
import {
  ONLINE_SIDE_LABEL,
  OnlineError,
  RoomConflictError,
  otherOnlineSide,
  type OnlineGameState,
  type OnlineRoomRecord,
  type OnlineSide,
} from '@/net/online-types'

import { useGameSessionStore } from './session'
import { useHotseatStore } from './hotseat'
import { useMapViewStore } from './map-view'
import { useSetupStore } from './setup'
import { useWorkbenchStore } from './workbench'
import { applyOnlineState, captureOnlineState } from './online-snapshot'

export type OnlineStatus =
  'idle' | 'creating' | 'joining' | 'waiting' | 'synced' | 'offline' | 'error'

/**
 * 双人联机的页面驻留状态
 *
 * ## 边界
 *   · 每个客户端只认一个 `mySide`；`viewerSide` 被 `hotseat.lockViewer` 固定；
 *   · 房间只保存一份完整状态；写入用 `seq` CAS，读用轮询；
 *   · **不做服务端反作弊**（用户 2026-11-27 口径），所以状态对服务端是不透明 JSON，
 *     信任双方不手改。
 *
 * ## 为什么是全量状态而不是存档
 *   存档契约在战斗进行中会拒绝捕获（`assertCompleteSettlement`），而守方的 AR/地形/损失/
 *   撤退必须在自己的设备上完成。全量状态复制把 `combatState` / `combatInputs` 一并带走，
 *   同时保留 `session`（记录轨、日志、RNG）与 `setup`（初设进度）。
 */
export const useOnlineStore = defineStore('online', () => {
  const session = useGameSessionStore()
  const workbench = useWorkbenchStore()
  const setup = useSetupStore()
  const hotseat = useHotseatStore()
  const mapView = useMapViewStore()

  const { transport, endpoint } = resolveRoomTransport()

  const room = ref<OnlineRoomRecord | null>(null)
  const mySide = ref<OnlineSide | null>(null)
  const seq = ref(0)
  const lastHash = ref('')
  const status = ref<OnlineStatus>('idle')
  const error = ref<string | null>(null)
  const notice = ref<string | null>(null)
  const applyingRemote = ref(false)

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let publishTimer: ReturnType<typeof setTimeout> | null = null
  let publishing = false
  let pendingPublish = false
  let polling = false
  let attached = false
  let detachWatchers: (() => void)[] = []

  const active = computed<boolean>(() => room.value !== null && mySide.value !== null)
  const roomCode = computed<string | null>(() => room.value?.code ?? null)
  const roomToken = computed<string | null>(() => room.value?.token ?? null)
  const remote = computed<boolean>(() => transport.kind === 'remote')
  const transportKind = computed<string>(() =>
    transport.kind === 'remote' ? '远程房间' : '本机双标签',
  )
  const mySideLabel = computed<string>(() =>
    mySide.value === null ? '未落座' : ONLINE_SIDE_LABEL[mySide.value],
  )
  const host = computed<boolean>(() => room.value !== null && room.value.hostSide === mySide.value)

  /**
   * 当前是否轮到本人写入
   *
   * 只用现有界面闸门的同源投影：初设看游标；待答问题看 responder；战斗/轰炸看
   * `engagementDecisionRole`（与 `viewerCombatRoles` 同一对攻守角色）；常规环节看
   * `segmentGateQuery.side`。它用于避免“没轮到你却把本地变化推到房间”，不是规则判据。
   */
  const canWrite = computed<boolean>(() => {
    const side = mySide.value
    if (side === null) return false
    if (!setup.finished) return setup.setupSideCursor === side
    if (session.question !== null) return session.question.responder === side
    if (workbench.combatState !== null || workbench.barrageState !== null) {
      return mapView.viewerCombatRoles.includes(workbench.engagementDecisionRole)
    }
    return (workbench.segmentGateQuery.side ?? workbench.activeSide) === side
  })

  const turnLabel = computed<string>(() => (canWrite.value ? '轮到你操作' : '等待对方操作'))

  const statusLabel = computed<string>(() => {
    if (status.value === 'creating') return '正在创建房间…'
    if (status.value === 'joining') return '正在加入房间…'
    if (status.value === 'waiting') return '已连接，等待对方落座…'
    if (status.value === 'synced') return `已同步 · ${turnLabel.value}`
    if (status.value === 'offline') return '连接中断，正在重试…'
    if (status.value === 'error') return '联机出错'
    return '未联机'
  })

  const errorLabel = computed<string | null>(() => error.value)

  /** 邀请链接：把房间码与房钥放进 hash；服务端不参与，页面自己解析。 */
  const inviteUrl = computed<string>(() => {
    if (room.value === null || typeof window === 'undefined') return ''
    const base = `${window.location.origin}${window.location.pathname}`.replace(/\/+$/u, '/')
    return `${base}#online=${encodeURIComponent(room.value.code)}&key=${encodeURIComponent(room.value.token)}`
  })

  function fail(cause: unknown, fallback = '联机操作失败'): void {
    const message = cause instanceof Error ? cause.message : fallback
    error.value = message
    status.value = 'error'
  }

  function clearError(): void {
    error.value = null
  }

  function schedulePublish(delay = 180): void {
    if (!active.value || applyingRemote.value) return
    if (publishTimer !== null) clearTimeout(publishTimer)
    publishTimer = setTimeout(() => {
      publishTimer = null
      void publishNow()
    }, delay)
  }

  async function acceptLatest(record: OnlineRoomRecord, note?: string): Promise<void> {
    if (!active.value || record.seq <= seq.value) return
    if (mySide.value === null) return
    // 先记 hash/seq 再改 store：远程 patch 触发的订阅回调之后会看到 hash 相同而跳过回写
    const side = mySide.value
    seq.value = record.seq
    lastHash.value = record.stateHash
    room.value = record
    applyingRemote.value = true
    try {
      applyOnlineState({ session, workbench, setup, hotseat }, record.state, side)
      hotseat.lockViewer(side)
      status.value = 'synced'
      if (note !== undefined) notice.value = note
      error.value = null
    } catch (cause) {
      fail(cause, '房间状态无法应用')
      throw cause
    } finally {
      applyingRemote.value = false
    }
  }

  async function publishNow(): Promise<void> {
    const current = room.value
    const side = mySide.value
    if (current === null || side === null || !canWrite.value) return
    if (publishing) {
      pendingPublish = true
      return
    }
    let state: OnlineGameState
    let hash: string
    try {
      state = captureOnlineState({ session, workbench, setup, hotseat })
      hash = await hashOnlineState(state)
    } catch (cause) {
      fail(cause, '无法捕获对局状态')
      return
    }
    if (hash === lastHash.value) return
    publishing = true
    try {
      const record = await transport.writeRoom({
        code: current.code,
        token: current.token,
        expectedSeq: seq.value,
        state,
        stateHash: hash,
        writerSide: side,
      })
      room.value = record
      seq.value = record.seq
      lastHash.value = record.stateHash
      status.value = 'synced'
      error.value = null
    } catch (cause) {
      if (cause instanceof RoomConflictError) {
        const latest = cause.latest
        const latestHash = latest.stateHash
        if (latestHash === hash) {
          // 同一份内容被对方先提交：接受序号，不重复落值
          room.value = latest
          seq.value = latest.seq
          lastHash.value = latestHash
          status.value = 'synced'
        } else {
          try {
            await acceptLatest(latest, '对方先提交了一步，已同步到最新局面；请重新操作刚才的步骤')
          } catch {
            status.value = 'error'
          }
        }
      } else {
        fail(cause, '联机写入失败')
        status.value = 'offline'
      }
    } finally {
      publishing = false
      if (pendingPublish) {
        pendingPublish = false
        schedulePublish()
      }
    }
  }

  async function pollOnce(): Promise<void> {
    const current = room.value
    if (current === null || polling) return
    polling = true
    try {
      const latest = await transport.readRoom(current.code, current.token)
      if (latest.seq > seq.value) await acceptLatest(latest)
      else if (status.value === 'offline') {
        status.value = 'synced'
        error.value = null
      }
    } catch (cause) {
      if (status.value !== 'error') status.value = 'offline'
      if (cause instanceof OnlineError) error.value = cause.message
    } finally {
      polling = false
    }
  }

  function planPoll(delay: number): void {
    if (!active.value) return
    if (pollTimer !== null) clearTimeout(pollTimer)
    pollTimer = setTimeout(() => {
      pollTimer = null
      void pollOnce().finally(() => planPoll(status.value === 'offline' ? 3000 : 900))
    }, delay)
  }

  function attachWatchers(): void {
    if (attached) return
    attached = true
    const workbenchStop = workbench.$subscribe(() => schedulePublish(), {
      detached: true,
      deep: true,
    })
    const sessionStop = session.$subscribe(() => schedulePublish(), { detached: true, deep: true })
    const setupStop = setup.$subscribe(() => schedulePublish(), { detached: true, deep: true })
    detachWatchers = [workbenchStop, sessionStop, setupStop]
  }

  function start(): void {
    attachWatchers()
    planPoll(500)
  }

  async function createRoom(side: OnlineSide): Promise<boolean> {
    if (session.session === null) {
      error.value = '当前没有可联机的对局，请先开始一局'
      status.value = 'error'
      return false
    }
    clearError()
    notice.value = null
    status.value = 'creating'
    try {
      const state = captureOnlineState({ session, workbench, setup, hotseat })
      const hash = await hashOnlineState(state)
      const record = await transport.createRoom({
        scenarioId: state.scenarioId,
        hostSide: side,
        state,
        stateHash: hash,
      })
      room.value = record
      mySide.value = side
      seq.value = record.seq
      lastHash.value = hash
      hotseat.adoptOnlineShell(side)
      status.value = 'synced'
      notice.value = '房间已创建；把邀请链接发给对方，双方各自只看到自己的阵营。'
      start()
      return true
    } catch (cause) {
      fail(cause, '创建房间失败')
      return false
    }
  }

  async function joinRoom(code: string, token: string): Promise<boolean> {
    clearError()
    notice.value = null
    status.value = 'joining'
    try {
      const record = await transport.readRoom(code.trim().toUpperCase(), token.trim())
      const side = otherOnlineSide(record.hostSide)
      room.value = record
      mySide.value = side
      seq.value = record.seq
      lastHash.value = record.stateHash
      hotseat.adoptOnlineShell(side)
      applyingRemote.value = true
      try {
        applyOnlineState({ session, workbench, setup, hotseat }, record.state, side)
        hotseat.lockViewer(side)
      } finally {
        applyingRemote.value = false
      }
      status.value = 'synced'
      notice.value = `已加入房间 ${record.code}；你执${ONLINE_SIDE_LABEL[side]}。`
      start()
      return true
    } catch (cause) {
      fail(cause, '加入房间失败')
      return false
    }
  }

  /** 手动刷新（设置面板「立即同步」）；不改变本地方向。 */
  async function refreshNow(): Promise<void> {
    await pollOnce()
  }

  function leaveRoom(): void {
    if (pollTimer !== null) clearTimeout(pollTimer)
    if (publishTimer !== null) clearTimeout(publishTimer)
    pollTimer = null
    publishTimer = null
    for (const stop of detachWatchers) stop()
    detachWatchers = []
    attached = false
    room.value = null
    mySide.value = null
    seq.value = 0
    lastHash.value = ''
    status.value = 'idle'
    error.value = null
    notice.value = null
    hotseat.unlockViewer()
  }

  return {
    // 状态
    room,
    active,
    roomCode,
    roomToken,
    mySide,
    mySideLabel,
    host,
    seq,
    status,
    statusLabel,
    turnLabel,
    errorLabel,
    notice,
    canWrite,
    transportKind,
    endpoint,
    remote,
    dataVersion: DATA_VERSION,
    inviteUrl,
    // 动作
    createRoom,
    joinRoom,
    publishNow,
    refreshNow,
    leaveRoom,
  }
})
