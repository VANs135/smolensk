<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { BaseButton } from '@/components/base'
import { ONLINE_SIDE_LABEL, type OnlineSide } from '@/net/online-types'
import { useGameSessionStore, useOnlineStore } from '@/stores'

const props = withDefaults(defineProps<{ variant?: 'game' | 'home' }>(), {
  variant: 'game',
})

const emit = defineEmits<{ joined: [] }>()

const online = useOnlineStore()
const session = useGameSessionStore()

const hostSide = ref<OnlineSide>('axis')
const joinCode = ref('')
const joinKey = ref('')
const busy = ref(false)
const copied = ref(false)

const canCreate = computed<boolean>(() => session.session !== null && !online.active)

const sideChoices: readonly { side: OnlineSide; label: string }[] = [
  { side: 'axis', label: ONLINE_SIDE_LABEL.axis },
  { side: 'soviet', label: ONLINE_SIDE_LABEL.soviet },
]

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
    await online.createRoom(hostSide.value)
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
    <template v-if="props.variant === 'game'">
      <p v-if="!canCreate && !online.active" class="online__hint">
        先开始一局，再在棋桌里创建联机房间；初设与模式会随当前局面一起复制。
      </p>

      <template v-else-if="!online.active">
        <p class="online__hint">
          从当前局面创建房间。双方各自只看到自己阵营；初设请先在主机完成，联机从当前局面开始。
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
          {{ busy ? '创建中…' : '创建联机房间' }}
        </BaseButton>
      </template>

      <template v-else>
        <p class="online__room">
          房间 <strong class="num">{{ online.roomCode }}</strong>
          <span class="online__dot">·</span>
          你执 <strong>{{ online.mySideLabel }}</strong>
          <span class="online__dot">·</span>
          {{ online.transportKind }}
        </p>
        <p class="online__status" role="status">{{ online.statusLabel }}</p>
        <p class="online__hint">
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
          <BaseButton variant="secondary" size="sm" @click="online.refreshNow()"
            >立即同步</BaseButton
          >
          <BaseButton variant="ghost" size="sm" @click="online.leaveRoom()">离开联机</BaseButton>
        </div>
        <p v-if="online.notice" class="online__note">{{ online.notice }}</p>
        <p v-if="online.errorLabel" class="online__error">{{ online.errorLabel }}</p>
      </template>
    </template>

    <template v-else>
      <template v-if="online.active">
        <p class="online__room">
          已加入 <strong class="num">{{ online.roomCode }}</strong>
          <span class="online__dot">·</span>
          你执 <strong>{{ online.mySideLabel }}</strong>
        </p>
        <p class="online__status" role="status">{{ online.statusLabel }}</p>
        <div class="online__actions">
          <BaseButton variant="primary" size="sm" @click="emit('joined')">进入棋桌</BaseButton>
          <BaseButton variant="ghost" size="sm" @click="online.leaveRoom()">离开</BaseButton>
        </div>
      </template>

      <template v-else>
        <p class="online__hint">
          粘贴房主发来的邀请链接；也可以分别填房间码与房钥。加入后你的视角固定为另一阵营。
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
    </template>
  </div>
</template>

<style scoped>
.online {
  display: grid;
  gap: var(--space-2);
  max-width: 420px;
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
