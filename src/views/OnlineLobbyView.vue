<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { BaseButton, BaseDialog } from '@/components/base'
import { scenarios } from '@/data'
import { ONLINE_SIDE_LABEL, type OnlineRoomSummary, type OnlineSide } from '@/net/online-types'
import { useGameSessionStore, useOnlineStore, useSetupStore, useUiStore } from '@/stores'

const game = useGameSessionStore()
const setup = useSetupStore()
const online = useOnlineStore()
const ui = useUiStore()

const playerDraft = ref(online.playerId)
const roomNameDraft = ref('')
const passwordDraft = ref('')
const hostSide = ref<OnlineSide>('axis')
const createBusy = ref(false)
const createConfirmOpen = ref(false)
const joinOpen = ref(false)
const joinTarget = ref<OnlineRoomSummary | null>(null)
const joinPassword = ref('')
const joinBusy = ref(false)
const query = ref('')
const copied = ref(false)

let directoryTimer: ReturnType<typeof setInterval> | null = null

const sideChoices: readonly { side: OnlineSide; label: string }[] = [
  { side: 'axis', label: ONLINE_SIDE_LABEL.axis },
  { side: 'soviet', label: ONLINE_SIDE_LABEL.soviet },
]

const hasCurrent = computed(() => game.session !== null || (setup.applied && !setup.finished))

const canCreate = computed<boolean>(() => {
  const name = roomNameDraft.value.trim()
  const password = passwordDraft.value.trim()
  const id = playerDraft.value.trim()
  return (
    !createBusy.value &&
    name.length >= 1 &&
    name.length <= 24 &&
    password.length >= 4 &&
    password.length <= 64 &&
    id.length >= 1 &&
    id.length <= 16
  )
})

const canJoin = computed<boolean>(() => {
  return (
    !joinBusy.value &&
    joinPassword.value.trim() !== '' &&
    playerDraft.value.trim().length >= 1 &&
    playerDraft.value.trim().length <= 16
  )
})

const filteredRooms = computed<OnlineRoomSummary[]>(() => {
  const needle = query.value.trim().toLowerCase()
  if (needle === '') return online.rooms
  return online.rooms.filter((room) => {
    return (
      room.name.toLowerCase().includes(needle) ||
      room.hostId.toLowerCase().includes(needle) ||
      room.guestId?.toLowerCase().includes(needle) === true ||
      room.code.toLowerCase().includes(needle)
    )
  })
})

const peerId = computed<string | null>(() => {
  const room = online.room
  if (room === null) return null
  return online.host ? room.guestId : room.hostId
})

const activeScenarioLabel = computed<string>(() => scenarioLabel(online.lobbyScenarioId))

const resumeLabel = computed<string>(() => {
  if (online.stage === 'game') return '进入对局'
  if (online.stage === 'setup') return '进入初设'
  return online.host ? '去选剧本' : '等待房主'
})

const activeHint = computed<string>(() => {
  if (online.stage === 'game') return '视角已锁定为你执的一方；对方操作时你只读等待。'
  if (online.stage === 'setup') {
    return '双方各自布设本方，按先后手交棒；两方确认后由房主完成初设。'
  }
  return online.host
    ? '房间已建好，密码只私下发给对手。去选剧本并在初设后开局。'
    : '已在大厅落座；房主选剧本并进入初设后，你会自动进入棋桌。'
})

function scenarioLabel(id: string | null): string {
  if (id === null) return '未选剧本'
  const found = scenarios.scenarios.find((item) => item.id === id)
  return found === undefined ? `剧本 ${id}` : `剧本 ${id} · ${found.name}`
}

function stageLabel(room: OnlineRoomSummary): string {
  if (room.stage === 'game') return '对局中'
  if (room.stage === 'setup') return '初设中'
  return '等待开局'
}

function isOwnSeat(room: OnlineRoomSummary): boolean {
  const id = playerDraft.value.trim()
  return room.hostId === id || room.guestId === id
}

function canJoinRoom(room: OnlineRoomSummary): boolean {
  return room.joinable || isOwnSeat(room)
}

function joinLabel(room: OnlineRoomSummary): string {
  if (room.joinable) return '加入'
  return isOwnSeat(room) ? '重连' : '已满'
}

function savePlayerId(): void {
  const next = playerDraft.value.trim()
  if (next === '') {
    playerDraft.value = online.playerId
    return
  }
  online.setPlayerId(next)
  playerDraft.value = online.playerId
}

async function refreshRooms(): Promise<void> {
  await online.refreshDirectory()
}

function onCreate(): void {
  if (hasCurrent.value) {
    createConfirmOpen.value = true
    return
  }
  void doCreate()
}

async function doCreate(): Promise<void> {
  if (!canCreate.value) return
  savePlayerId()
  createConfirmOpen.value = false
  createBusy.value = true
  try {
    const created = await online.createRoom({
      name: roomNameDraft.value,
      password: passwordDraft.value,
      side: hostSide.value,
      playerId: playerDraft.value,
    })
    if (!created) return
    // 创建的是新的一局：旧对局/初设必须先清掉，否则剧本锁定会让选剧本页无法换剧本。
    if (hasCurrent.value && !setup.restartGameNow()) {
      online.leaveRoom()
      ui.pushToast('warning', '无法开始新的联机对局；请先保存或结束当前对局')
      return
    }
    online.reassertShell()
    ui.navigate('scenario')
  } finally {
    createBusy.value = false
  }
}

function openJoin(room: OnlineRoomSummary): void {
  if (!canJoinRoom(room)) return
  savePlayerId()
  joinTarget.value = room
  joinPassword.value = ''
  joinOpen.value = true
}

async function onJoin(): Promise<void> {
  const target = joinTarget.value
  if (
    target === null ||
    joinPassword.value.trim() === '' ||
    playerDraft.value.trim() === '' ||
    joinBusy.value
  ) {
    return
  }
  savePlayerId()
  joinBusy.value = true
  try {
    const joined = await online.joinRoom({
      code: target.code,
      password: joinPassword.value,
      playerId: playerDraft.value,
    })
    if (!joined) return
    joinOpen.value = false
    if (online.stage === 'game' || online.stage === 'setup') {
      ui.navigate('game')
      return
    }
    ui.pushToast('info', '已加入房间，等待房主选剧本。')
    await refreshRooms()
  } finally {
    joinBusy.value = false
  }
}

function onResume(): void {
  if (!online.active) return
  if (online.stage === 'game' || online.stage === 'setup') {
    ui.navigate('game')
    return
  }
  if (online.host) ui.navigate('scenario')
}

function onLeave(): void {
  online.leaveRoom()
  setTimeout(() => void refreshRooms(), 200)
}

async function copyInvite(): Promise<void> {
  if (online.inviteUrl === '') return
  try {
    await navigator.clipboard.writeText(online.inviteUrl)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1800)
  } catch {
    // 无剪贴板权限时保留只读链接，玩家可手动选中。
  }
}

watch(
  () => online.stage,
  (stage) => {
    if ((stage === 'setup' || stage === 'game') && online.active && !online.host) {
      joinOpen.value = false
      ui.navigate('game')
    }
  },
)

onMounted(async () => {
  playerDraft.value = online.playerId
  directoryTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void refreshRooms()
  }, 3000)

  await refreshRooms()
  const params = new URLSearchParams(window.location.hash.replace(/^#/u, ''))
  const code = params.get('online')
  if (code !== null && code.trim() !== '') {
    const normalized = code.trim().toUpperCase()
    query.value = normalized
    const match = online.rooms.find((room) => room.code === normalized)
    if (match !== undefined && !online.active) openJoin(match)
    else if (!online.active) {
      ui.pushToast('warning', '大厅里没有这个房间号，可能已关闭或已满。')
    }
    // 房间号只用于本次定位；去掉 hash，刷新页面不再重复弹加入框。
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  }
})

onBeforeUnmount(() => {
  if (directoryTimer !== null) clearInterval(directoryTimer)
  directoryTimer = null
})
</script>

<template>
  <div class="lobby">
    <header class="lobby__head">
      <div class="lobby__heading">
        <span class="lobby__kicker num">ONLINE / PVP</span>
        <h2>联机大厅</h2>
        <p>
          先设自己的 ID，再建房或选一张桌子。房间名和房主 ID 对大厅公开，密码只由房主私下发给对手。
        </p>
      </div>
      <BaseButton variant="ghost" size="sm" @click="ui.back()">返回开始台</BaseButton>
    </header>

    <section class="lobby__identity" aria-label="我的玩家 ID">
      <label for="lobby-player-id">我的 ID</label>
      <input
        id="lobby-player-id"
        v-model="playerDraft"
        class="lobby__input lobby__input--id"
        maxlength="16"
        autocomplete="off"
        :disabled="online.active"
        @blur="savePlayerId"
      />
      <span class="lobby__identity-note">
        {{ online.active ? '本局内 ID 已锁定；离开房间后可改。' : '大厅列表与棋桌都用这个名字。' }}
      </span>
    </section>

    <section v-if="online.active" class="lobby__active" aria-label="当前联机房间">
      <header class="lobby__active-head">
        <div>
          <span class="lobby__kicker num">CURRENT ROOM</span>
          <h3>{{ online.roomName }}</h3>
          <p class="num">{{ online.roomCode }} · {{ activeScenarioLabel }}</p>
        </div>
        <span class="lobby__badge" :class="`lobby__badge--${online.stage}`">
          {{
            online.stage === 'lobby' ? '等待开局' : online.stage === 'setup' ? '初设中' : '对局中'
          }}
        </span>
      </header>

      <p class="lobby__status" role="status">{{ online.statusLabel }}</p>
      <p class="lobby__hint">{{ activeHint }}</p>

      <dl class="lobby__facts">
        <div>
          <dt>你</dt>
          <dd>{{ online.playerId }} · {{ online.mySideLabel }}</dd>
        </div>
        <div>
          <dt>{{ online.host ? '客人' : '房主' }}</dt>
          <dd>{{ peerId ?? '等待加入' }}</dd>
        </div>
        <div>
          <dt>人数</dt>
          <dd>{{ online.roomPlayerCount }} / 2</dd>
        </div>
      </dl>

      <label class="lobby__label" for="lobby-invite">邀请链接（不含密码）</label>
      <input
        id="lobby-invite"
        class="lobby__input"
        readonly
        :value="online.inviteUrl"
        @focus="($event.target as HTMLInputElement).select()"
      />

      <div class="lobby__actions">
        <BaseButton
          v-if="online.stage !== 'lobby' || online.host"
          variant="primary"
          size="sm"
          @click="onResume"
        >
          {{ resumeLabel }}
        </BaseButton>
        <BaseButton variant="secondary" size="sm" @click="copyInvite">
          {{ copied ? '已复制' : '复制邀请' }}
        </BaseButton>
        <BaseButton variant="secondary" size="sm" @click="online.refreshNow()">立即同步</BaseButton>
        <BaseButton variant="ghost" size="sm" @click="onLeave">离开房间</BaseButton>
      </div>

      <p class="lobby__hint">
        把邀请链接和房间密码分开发给对手；链接里只有房间号，打开后仍要输密码。
      </p>
      <p v-if="online.notice" class="lobby__note">{{ online.notice }}</p>
      <p v-if="online.errorLabel" class="lobby__error">{{ online.errorLabel }}</p>
    </section>

    <div v-else class="lobby__grid">
      <section class="lobby__rooms" aria-labelledby="lobby-rooms-title">
        <header class="lobby__section-head">
          <div>
            <h3 id="lobby-rooms-title">大厅房间</h3>
            <span class="num">{{ filteredRooms.length }} 间</span>
          </div>
          <BaseButton
            variant="ghost"
            size="sm"
            :loading="online.directoryLoading"
            @click="refreshRooms"
          >
            刷新
          </BaseButton>
        </header>

        <input
          v-model="query"
          class="lobby__input"
          type="search"
          autocomplete="off"
          placeholder="搜索房名、房主 ID 或房间号"
        />

        <p v-if="online.directoryError" class="lobby__error">{{ online.directoryError }}</p>

        <ul v-if="filteredRooms.length > 0" class="lobby__room-list">
          <li v-for="room in filteredRooms" :key="room.code">
            <button
              class="lobby__room"
              :class="{ 'lobby__room--full': !room.joinable }"
              type="button"
              :disabled="!canJoinRoom(room)"
              @click="openJoin(room)"
            >
              <span class="lobby__room-main">
                <strong>{{ room.name }}</strong>
                <span class="lobby__room-sub">
                  房主 {{ room.hostId
                  }}<template v-if="room.guestId !== null"> · 客人 {{ room.guestId }}</template>
                </span>
                <span class="lobby__room-sub num">
                  {{ room.code }} · {{ scenarioLabel(room.scenarioId) }}
                </span>
              </span>
              <span class="lobby__room-meta">
                <span class="lobby__badge" :class="`lobby__badge--${room.stage}`">
                  {{ stageLabel(room) }}
                </span>
                <span class="num">{{ room.playerCount }} / 2</span>
                <strong>{{ joinLabel(room) }}</strong>
              </span>
            </button>
          </li>
        </ul>
        <p v-else-if="!online.directoryLoading" class="lobby__empty">
          大厅里还没有房间。右侧建一间，把房名和密码告诉对手。
        </p>
        <p v-else class="lobby__empty">正在读取房间…</p>
      </section>

      <aside class="lobby__create" aria-labelledby="lobby-create-title">
        <h3 id="lobby-create-title">创建房间</h3>
        <label class="lobby__label" for="lobby-room-name">房间名</label>
        <input
          id="lobby-room-name"
          v-model="roomNameDraft"
          class="lobby__input"
          maxlength="24"
          autocomplete="off"
          placeholder="例如：斯摩棱斯克夜战"
        />

        <label class="lobby__label" for="lobby-room-password">房间密码</label>
        <input
          id="lobby-room-password"
          v-model="passwordDraft"
          class="lobby__input"
          type="password"
          maxlength="64"
          autocomplete="new-password"
          placeholder="4–64 个字符，私下发给对手"
        />

        <label class="lobby__label">你执哪一方</label>
        <div class="lobby__segmented">
          <BaseButton
            v-for="item in sideChoices"
            :key="item.side"
            :variant="hostSide === item.side ? 'primary' : 'secondary'"
            size="sm"
            @click="hostSide = item.side"
          >
            {{ item.label }}
          </BaseButton>
        </div>

        <p v-if="hasCurrent" class="lobby__warn">创建会替换当前对局/初设；需要保留进度请先存档。</p>

        <BaseButton
          :disabled="!canCreate"
          :loading="createBusy"
          variant="primary"
          size="sm"
          @click="onCreate"
        >
          {{ createBusy ? '创建中…' : '创建房间并选剧本' }}
        </BaseButton>

        <p class="lobby__hint">
          创建后进入选剧本页。大厅只显示房名、房主 ID 和人数，不会显示密码。
        </p>
        <p v-if="online.errorLabel && !joinOpen && !createConfirmOpen" class="lobby__error">
          {{ online.errorLabel }}
        </p>
      </aside>
    </div>

    <BaseDialog v-model:open="joinOpen" title="加入联机房间" width="440px">
      <template v-if="joinTarget !== null">
        <p class="lobby__room-title">
          <strong>{{ joinTarget.name }}</strong>
          <span class="num">{{ joinTarget.code }}</span>
        </p>
        <p class="lobby__hint">
          房主 {{ joinTarget.hostId }} · 你将以 {{ ONLINE_SIDE_LABEL[joinTarget.guestSide] }} 加入。
        </p>
        <p v-if="hasCurrent" class="lobby__warn">
          加入会替换当前本机对局/初设；需要保留进度请先存档。
        </p>
        <label class="lobby__label" for="lobby-join-id">我的 ID</label>
        <input
          id="lobby-join-id"
          v-model="playerDraft"
          class="lobby__input"
          maxlength="16"
          autocomplete="off"
          placeholder="1–16 个字符"
          @blur="savePlayerId"
        />
        <label class="lobby__label" for="lobby-join-password">房间密码</label>
        <input
          id="lobby-join-password"
          v-model="joinPassword"
          class="lobby__input"
          type="password"
          maxlength="64"
          autocomplete="off"
          placeholder="向房主私下索取"
          @keyup.enter="onJoin"
        />
        <p class="lobby__hint">密码不显示在大厅列表里；请让房主单独发给你。</p>
        <p v-if="online.errorLabel" class="lobby__error">{{ online.errorLabel }}</p>
      </template>
      <template #footer>
        <BaseButton variant="secondary" size="sm" @click="joinOpen = false">取消</BaseButton>
        <BaseButton
          :disabled="!canJoin"
          :loading="joinBusy"
          variant="primary"
          size="sm"
          @click="onJoin"
        >
          {{ joinBusy ? '加入中…' : '加入房间' }}
        </BaseButton>
      </template>
    </BaseDialog>

    <BaseDialog v-model:open="createConfirmOpen" title="创建联机房间" width="440px">
      <p>创建新房间会替换当前对局/初设。需要保留进度时请先保存。</p>
      <template #footer>
        <BaseButton variant="secondary" size="sm" @click="createConfirmOpen = false"
          >返回</BaseButton
        >
        <BaseButton variant="primary" size="sm" @click="doCreate">确认创建</BaseButton>
      </template>
    </BaseDialog>
  </div>
</template>

<style scoped>
.lobby {
  width: min(100%, 1240px);
  margin-inline: auto;
  padding: var(--space-8) clamp(var(--space-4), 3vw, var(--space-8));
  color: var(--color-command-ink);
}

.lobby__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-6);
  padding-bottom: var(--space-5);
  border-bottom: 1px solid var(--color-command-line);
}

.lobby__heading h2 {
  margin: var(--space-1) 0 var(--space-2);
  font-size: clamp(1.8rem, 3.4vw, 2.8rem);
}

.lobby__heading p {
  max-width: 680px;
  margin: 0;
  color: var(--color-command-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.lobby__kicker {
  color: var(--color-command-teal);
  font-size: var(--text-xs);
  letter-spacing: 0.16em;
}

.lobby__identity {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-4) 0;
}

.lobby__identity label,
.lobby__identity-note {
  color: var(--color-command-muted);
  font-size: var(--text-sm);
}

.lobby__identity-note {
  flex: 1 1 260px;
}

.lobby__input {
  box-sizing: border-box;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-sm);
  background: var(--color-command-panel);
  color: var(--color-command-ink);
  font: inherit;
  font-size: var(--text-sm);
}

.lobby__input:focus-visible {
  outline: 2px solid var(--color-command-teal);
  outline-offset: 1px;
}

.lobby__input--id {
  width: min(100%, 220px);
}

.lobby__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
  gap: var(--space-8);
  align-items: start;
  padding-top: var(--space-4);
}

.lobby__rooms,
.lobby__create,
.lobby__active {
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-lg);
  background: var(--color-command-panel);
}

.lobby__rooms {
  min-height: 360px;
  padding: var(--space-5);
}

.lobby__create {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-5);
}

.lobby__section-head,
.lobby__active-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.lobby__section-head h3,
.lobby__create h3,
.lobby__active-head h3 {
  margin: 0;
  font-size: var(--text-lg);
}

.lobby__section-head .num {
  color: var(--color-command-muted);
  font-size: var(--text-xs);
}

.lobby__room-list {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
}

.lobby__room {
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: var(--space-4);
  width: 100%;
  padding: var(--space-3);
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-md);
  background: var(--color-command-bg);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.lobby__room:hover:not(:disabled) {
  border-color: var(--color-command-teal);
  background: var(--color-command-raised);
}

.lobby__room:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.lobby__room--full:not(:disabled) {
  border-color: var(--color-command-amber);
}

.lobby__room-main {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.lobby__room-main strong {
  overflow: hidden;
  font-size: var(--text-base);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lobby__room-sub {
  overflow: hidden;
  color: var(--color-command-muted);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lobby__room-meta {
  display: grid;
  align-content: center;
  justify-items: end;
  gap: var(--space-1);
  flex: none;
  font-size: var(--text-xs);
}

.lobby__room-meta strong {
  color: var(--color-command-teal);
}

.lobby__room-meta strong:empty {
  display: none;
}

.lobby__badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-pill);
  color: var(--color-command-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.lobby__badge--setup {
  border-color: var(--color-command-amber);
  color: var(--color-command-amber);
}

.lobby__badge--game {
  border-color: var(--color-command-teal);
  color: var(--color-command-teal);
}

.lobby__empty {
  margin: var(--space-6) 0 0;
  color: var(--color-command-muted);
  font-size: var(--text-sm);
  text-align: center;
}

.lobby__label {
  color: var(--color-command-muted);
  font-size: var(--text-xs);
}

.lobby__segmented,
.lobby__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.lobby__hint,
.lobby__warn,
.lobby__note,
.lobby__error,
.lobby__status {
  margin: 0;
  font-size: var(--text-sm);
  line-height: 1.55;
}

.lobby__hint {
  color: var(--color-command-muted);
}

.lobby__note {
  color: var(--color-command-muted);
}

.lobby__warn {
  padding: var(--space-2) var(--space-3);
  border-left: 2px solid var(--color-command-amber);
  background: var(--color-command-warning-bg);
  color: var(--color-command-amber);
}

.lobby__error {
  color: var(--color-danger);
}

.lobby__status {
  color: var(--color-command-teal);
}

.lobby__active {
  display: grid;
  gap: var(--space-4);
  max-width: 760px;
  margin-top: var(--space-4);
  padding: var(--space-6);
}

.lobby__active-head p {
  margin: var(--space-1) 0 0;
  color: var(--color-command-muted);
  font-size: var(--text-sm);
}

.lobby__facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0;
}

.lobby__facts div {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-sm);
}

.lobby__facts dt {
  color: var(--color-command-muted);
  font-size: var(--text-xs);
}

.lobby__facts dd {
  margin: 0;
  font-size: var(--text-sm);
}

.lobby__room-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  margin: 0 0 var(--space-2);
}

.lobby__room-title .num {
  color: var(--color-command-muted);
  font-size: var(--text-xs);
}

@media (max-width: 880px) {
  .lobby__grid {
    grid-template-columns: 1fr;
  }

  .lobby__create {
    order: -1;
  }
}

@media (max-width: 560px) {
  .lobby {
    padding-inline: var(--space-4);
  }

  .lobby__head {
    flex-direction: column;
  }

  .lobby__facts {
    grid-template-columns: 1fr;
  }

  .lobby__room {
    flex-direction: column;
  }

  .lobby__room-meta {
    flex-direction: row;
    flex-wrap: wrap;
    justify-items: start;
  }
}
</style>
