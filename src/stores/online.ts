import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { DATA_VERSION } from '@/data'
import { resolveRoomTransport } from '@/net'
import { hashOnlineState } from '@/net/hash'
import {
  ONLINE_PROTOCOL_VERSION,
  ONLINE_SIDE_LABEL,
  OnlineError,
  RoomConflictError,
  isOnlineLiveState,
  otherOnlineSide,
  type OnlineLobbyState,
  type OnlineRoomRecord,
  type OnlineSide,
  type OnlineStage,
  type OnlineState,
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
  /**
   * 初设交棒后的一次性写权
   *
   * 当前布设方点“确认本方布设”时，游标会**在同一动作里**交给对方；等 watcher 触发发布，
   * `setup.setupSideCursor` 已经不是自己了。若只看游标，最后一份“本方已完成”的初设状态
   * 永远写不出去。此标记只允许该方补写一次，成功后清空，避免退到等待方后仍覆盖对方。
   */
  const pendingSetupWriteSide = ref<OnlineSide | null>(null)

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
  const stage = computed<OnlineStage | null>(() => room.value?.state.stage ?? null)
  const lobbyScenarioId = computed<string | null>(() => room.value?.scenarioId ?? null)

  /**
   * 当前是否轮到本人**操作**
   *
   * 只用现有界面闸门的同源投影：初设看游标；待答问题看 responder；战斗/轰炸看
   * `engagementDecisionRole`（与 `viewerCombatRoles` 同一对攻守角色）；常规环节看
   * `segmentGateQuery.side`。它同时用于界面按钮与发布闸门，但不是规则判据。
   *
   * `lobby` 阶段没有会话，房主负责选剧本；`setup` 阶段双方各自布设本方，游标在谁身上
   * 就只有谁能动——房主不能替客人布设，客人也不能替房主布设。
   */
  const canWrite = computed<boolean>(() => {
    const side = mySide.value
    if (side === null) return false
    if (stage.value === 'lobby') return host.value
    if (stage.value === 'setup') return setup.setupSideCursor === side
    if (!setup.finished) return setup.setupSideCursor === side
    if (session.question !== null) return session.question.responder === side
    if (workbench.combatState !== null || workbench.barrageState !== null) {
      return mapView.viewerCombatRoles.includes(workbench.engagementDecisionRole)
    }
    return (workbench.segmentGateQuery.side ?? workbench.activeSide) === side
  })

  /**
   * 当前是否允许把本机状态写进房间
   *
   * 与 `canWrite` 分开的两个例外：
   *   · `lobby` 房主刚进初设时，游标可能停在客人一侧，房主仍须把第一份完整初设发出去；
   *   · 当前方确认后游标已交棒，须补写最后一份“本方完成”的状态（`pendingSetupWriteSide`）。
   * 其余时刻仍只允许当前操作方写，防止挂机方因本地鼠标/浮窗变化覆盖对方正在进行的初设。
   */
  const canPublish = computed<boolean>(() => {
    const side = mySide.value
    if (side === null) return false
    if (stage.value === 'lobby') return host.value
    if (stage.value === 'setup') {
      // 双方确认完毕、房主已在本机建立 session：这一包实际会捕获成 `game`，必须放行。
      if (session.session !== null) return host.value
      return setup.setupSideCursor === side || pendingSetupWriteSide.value === side
    }
    return canWrite.value
  })

  const turnLabel = computed<string>(() => {
    if (stage.value === 'setup') {
      if (setup.setupSideCursor === null) {
        return host.value ? '轮到你完成初设' : '等待房主开局'
      }
      return canWrite.value ? '轮到你布设' : '等待对方布设'
    }
    return canWrite.value ? '轮到你操作' : '等待对方操作'
  })

  const statusLabel = computed<string>(() => {
    if (status.value === 'creating') return '正在创建房间…'
    if (status.value === 'joining') return '正在加入房间…'
    if (stage.value === 'lobby') {
      if (mySide.value === null) return '未联机'
      return host.value ? '房间已建立 · 等待进入初设' : '已加入房间 · 等待房主选剧本'
    }
    if (stage.value === 'setup') {
      if (mySide.value === null) return '未联机'
      return `同步初设 · ${turnLabel.value}`
    }
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
    if (!isOnlineLiveState(record.state)) {
      status.value = 'synced'
      if (note !== undefined) notice.value = note
      error.value = null
      return
    }
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
    if (current === null || side === null || !canPublish.value) return
    const finishingSetup = pendingSetupWriteSide.value === side
    if (publishing) {
      pendingPublish = true
      return
    }
    let state: OnlineState
    let hash: string
    try {
      state = captureOnlineState({ session, workbench, setup, hotseat })
      hash = await hashOnlineState(state)
    } catch (cause) {
      fail(cause, '无法捕获对局状态')
      return
    }
    if (hash === lastHash.value) {
      if (finishingSetup) pendingSetupWriteSide.value = null
      return
    }
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
      if (finishingSetup) pendingSetupWriteSide.value = null
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
          if (finishingSetup) pendingSetupWriteSide.value = null
        } else {
          try {
            await acceptLatest(latest, '对方先提交了一步，已同步到最新局面；请重新操作刚才的步骤')
            if (finishingSetup) pendingSetupWriteSide.value = null
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

  /**
   * 在开始台建房（用户 2026-11-27：房间改在选剧本前创建）
   *
   * 此时**不复制本机任何盘面/会话**，房间先是 `lobby`；房主随后去选剧本、完成初设，
   * 开局时再由 watcher 把完整 `game` 状态写进同一间房。这样邀请可以先发出去，
   * 对方加入后等待房主开局，不会把房主上一局的盘面带进新房间。
   */
  async function createRoom(side: OnlineSide): Promise<boolean> {
    clearError()
    notice.value = null
    status.value = 'creating'
    try {
      const state: OnlineLobbyState = {
        stage: 'lobby',
        protocol: ONLINE_PROTOCOL_VERSION,
        dataVersion: DATA_VERSION,
        scenarioId: null,
      }
      const hash = await hashOnlineState(state)
      const record = await transport.createRoom({
        scenarioId: null,
        hostSide: side,
        state,
        stateHash: hash,
      })
      room.value = record
      mySide.value = side
      seq.value = record.seq
      lastHash.value = hash
      pendingSetupWriteSide.value = null
      status.value = 'synced'
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
      pendingSetupWriteSide.value = null
      if (!isOnlineLiveState(record.state)) {
        // lobby 阶段不碰本机盘面：对方还没进入初设/开局，加入只是占座等待。
        status.value = 'synced'
      } else {
        hotseat.adoptOnlineShell(side)
        applyingRemote.value = true
        try {
          applyOnlineState({ session, workbench, setup, hotseat }, record.state, side)
          hotseat.lockViewer(side)
        } finally {
          applyingRemote.value = false
        }
        status.value = 'synced'
      }
      start()
      return true
    } catch (cause) {
      fail(cause, '加入房间失败')
      return false
    }
  }

  /**
   * 把本机组织方式重新收成联机外壳；开始台建房/换到选剧本页后调用。
   *
   * 初设阶段也锁在本人阵营：双方各自布设本方，不能靠切换视角替对方落子。
   */
  function reassertShell(): void {
    const side = mySide.value
    if (side === null) return
    hotseat.adoptOnlineShell(side)
  }

  /** 手动刷新（设置面板「立即同步」）；不改变本地方向。 */
  async function refreshNow(): Promise<void> {
    await pollOnce()
  }

  function leaveRoom(): void {
    const beforeGame =
      (stage.value === 'lobby' || stage.value === 'setup') && session.session === null
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
    pendingSetupWriteSide.value = null
    status.value = 'idle'
    error.value = null
    notice.value = null
    hotseat.unlockViewer()
    // 还没开局就退出：把初设模式锁也解开，别让任何一方卡在不可改的 PVP 外壳里。
    if (beforeGame) hotseat.resetModeLock()
  }

  /*
   * 初设交棒：当前方确认后游标会立刻交给对方，给刚才那一方留一次补写权，
   * 让“本方已完成”的最后一份状态能写进房间；成功后由 `publishNow` 清空。
   * 远程应用时（`applyingRemote`）不设标记，避免把对方的交棒当成自己的。
   */
  watch(
    () => setup.setupSideCursor,
    (cursor, previous) => {
      const side = mySide.value
      if (!active.value || applyingRemote.value || side === null) return
      if (stage.value !== 'setup' || setup.finished) return
      if (previous !== side || cursor === side) return
      if (setup.setupSideConfirmed[side] !== true) return
      pendingSetupWriteSide.value = side
      schedulePublish(120)
    },
    { flush: 'sync' },
  )

  return {
    // 状态
    room,
    active,
    roomCode,
    roomToken,
    mySide,
    mySideLabel,
    host,
    stage,
    lobbyScenarioId,
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
    reassertShell,
    publishNow,
    refreshNow,
    leaveRoom,
  }
})
