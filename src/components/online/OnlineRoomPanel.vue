<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { BaseButton } from '@/components/base'
import { ONLINE_SIDE_LABEL, type OnlineSide } from '@/net/online-types'
import { useOnlineStore } from '@/stores'

const props = withDefaults(defineProps<{ variant?: 'game' | 'home' | 'create' | 'scenario' }>(), {
  variant: 'game',
})

const emit = defineEmits<{ joined: []; created: [] }>()

const online = useOnlineStore()

const hostSide = ref<OnlineSide>('axis')
const joinCode = ref('')
const joinKey = ref('')
const busy = ref(false)
const copied = ref(false)

const sideChoices: readonly { side: OnlineSide; label: string }[] = [
  { side: 'axis', label: ONLINE_SIDE_LABEL.axis },
  { side: 'soviet', label: ONLINE_SIDE_LABEL.soviet },
]

const waitingForHost = computed<boolean>(() => online.stage === 'lobby')

function parseInviteText(): void {
  const raw = joinCode.value.trim()
  if (!raw.includes('#')) return
  try {
    const url = new URL(raw, window.location.href)
    const params = new URLSearchParams(url.hash.replace(/^#/u, ''))
    const code = params.get('online')
    const key = params.get('key')
    if (code !== null) joinCode.value = code
    if (key !== null) joinKey.value = key
  } catch {
    // 不是合法链接就按原样保留，交给加入时的错误提示
  }
}

async function onCreate(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    if (await online.createRoom(hostSide.value)) emit('created')
  } finally {
    busy.value = false
  }
}

async function onJoin(): Promise<void> {
  if (busy.value || joinCode.value.trim() === '' || joinKey.value.trim() === '') return
  parseInviteText()
  busy.value = true
  try {
    const joined = await online.joinRoom(joinCode.value, joinKey.value)
    if (joined) emit('joined')
  } finally {
    busy.value = false
  }
}

async function copyInvite(): Promise<void> {
  const text = online.inviteUrl
  if (text === '') return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1800)
  } catch {
    // 无剪贴板权限时保留只读链接，玩家可手动选中
  }
}

onMounted(() => {
  if (props.variant !== 'home') return
  const params = new URLSearchParams(window.location.hash.replace(/^#/u, ''))
  const code = params.get('online')
  const key = params.get('key')
  if (code !== null) joinCode.value = code
  if (key !== null) joinKey.value = key
})
</script>

<template>
  <div class="online" :class="`online--${props.variant}`">
    <!-- 加入方：房间已占座 -->
    <template v-if="online.active && props.variant === 'home'">
      <p class="online__room">
        已加入 <strong class="num">{{ online.roomCode }}</strong>
        <span class="online__dot">·</span>
        你执 <strong>{{ online.mySideLabel }}</strong>
      </p>
      <p class="online__status" role="status">{{ online.statusLabel }}</p>
      <p v-if="waitingForHost" class="online__hint">
        房主还在选剧本/完成初设；开局后会自动进入棋桌，不需要重新加入。
      </p>
      <p v-else class="online__hint">对局已开始，视角固定为你执的一方。</p>
      <div class="online__actions">
        <BaseButton v-if="!waitingForHost" variant="primary" size="sm" @click="emit('joined')">
          进入棋桌
        </BaseButton>
        <BaseButton variant="ghost" size="sm" @click="online.leaveRoom()">离开</BaseButton>
      </div>
      <p v-if="online.errorLabel" class="online__error">{{ online.errorLabel }}</p>
      <p v-if="online.notice" class="online__note">{{ online.notice }}</p>
    </template>

    <!-- 房主/已在房间：房间码与邀请 -->
    <template v-else-if="online.active">
      <p class="online__room">
        房间 <strong class="num">{{ online.roomCode }}</strong>
        <span class="online__dot">·</span>
        你执 <strong>{{ online.mySideLabel }}</strong>
        <span class="online__dot">·</span>
        {{ online.transportKind }}
      </p>
      <p class="online__status" role="status">{{ online.statusLabel }}</p>
      <p v-if="waitingForHost && online.host" class="online__hint">
        <template v-if="online.lobbyScenarioId">
          剧本已选定，正在完成初设；对方会自动进入棋桌。
        </template>
        <template v-else> 房间已建立。请选择剧本；初设由你完成后，对方会自动进入棋桌。 </template>
      </p>
      <p v-else-if="waitingForHost" class="online__hint">等待房主选择剧本并完成初设。</p>
      <p v-else class="online__hint">
        视角已锁定为你执的一方；切换视角入口已收起。对方先提交时，本地未提交的步骤会提示重做。
      </p>
      <label class="online__label" for="online-invite">邀请链接</label>
      <input
        id="online-invite"
        class="online__input"
        readonly
        :value="online.inviteUrl"
        @focus="($event.target as HTMLInputElement).select()"
      />
      <div class="online__actions">
        <BaseButton variant="secondary" size="sm" @click="copyInvite">
          {{ copied ? '已复制' : '复制邀请' }}
        </BaseButton>
        <BaseButton variant="secondary" size="sm" @click="online.refreshNow()">立即同步</BaseButton>
        <BaseButton variant="ghost" size="sm" @click="online.leaveRoom()">离开联机</BaseButton>
      </div>
      <p v-if="online.notice" class="online__note">{{ online.notice }}</p>
      <p v-if="online.errorLabel" class="online__error">{{ online.errorLabel }}</p>
    </template>

    <!-- 开始台：先建房，再去选剧本 -->
    <template v-else-if="props.variant === 'create'">
      <p class="online__hint">
        先建房间，再选剧本。房间固定 PVP；初设由房主完成，对方可先加入等待。
      </p>
      <label class="online__label">你执哪一方</label>
      <div class="online__segmented">
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
      <BaseButton :disabled="busy" variant="primary" size="sm" @click="onCreate">
        {{ busy ? '创建中…' : '创建房间并选剧本' }}
      </BaseButton>
      <p v-if="online.errorLabel" class="online__error">{{ online.errorLabel }}</p>
    </template>

    <!-- 开始台：加入 -->
    <template v-else-if="props.variant === 'home'">
      <p class="online__hint">
        粘贴房主发来的邀请链接；也可以分别填房间码与房钥。房间还没开局时会先占座等待。
      </p>
      <label class="online__label" for="online-code">房间码</label>
      <input
        id="online-code"
        v-model="joinCode"
        class="online__input"
        autocomplete="off"
        placeholder="例如 ABC234，或整条邀请链接"
        @blur="parseInviteText"
      />
      <label class="online__label" for="online-key">房钥</label>
      <input
        id="online-key"
        v-model="joinKey"
        class="online__input"
        autocomplete="off"
        placeholder="邀请链接里的 key"
      />
      <BaseButton :disabled="busy" variant="primary" size="sm" @click="onJoin">
        {{ busy ? '加入中…' : '加入房间' }}
      </BaseButton>
      <p v-if="online.errorLabel" class="online__error">{{ online.errorLabel }}</p>
      <p v-if="online.notice" class="online__note">{{ online.notice }}</p>
    </template>

    <template v-else>
      <p class="online__hint">联机房间在开始台创建：先建房，再选剧本。棋桌不再补建房。</p>
    </template>
  </div>
</template>

<style scoped>
.online {
  display: grid;
  gap: var(--space-2);
  max-width: 420px;
}

/* 选剧本页没有棋桌设置的 section 外壳，房间块自己收成一张同款纸片。 */
.online--scenario {
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-command-line);
  border-radius: var(--radius-lg);
  background: var(--color-command-panel);
}

.online__hint,
.online__room,
.online__status,
.online__note,
.online__error {
  margin: 0;
  font-size: var(--text-sm);
  line-height: 1.5;
}

.online__hint {
  color: var(--color-command-muted);
}

.online__room {
  color: var(--color-command-ink);
}

.online__dot {
  padding-inline: var(--space-1);
  color: var(--color-command-muted);
}

.online__status {
  color: var(--color-command-teal);
}

.online__note {
  color: var(--color-command-muted);
}

.online__error {
  color: var(--color-danger);
}

.online__label {
  margin-top: var(--space-1);
  color: var(--color-command-muted);
  font-size: var(--text-xs);
}

.online__segmented,
.online__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.online__input {
  box-sizing: border-box;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-panel);
  color: var(--color-command-ink);
  font: inherit;
  font-size: var(--text-sm);
}

.online__input:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
</style>
