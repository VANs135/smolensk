<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseButton } from '@/components/base'
import { useOnlineStore } from '@/stores'

const props = withDefaults(defineProps<{ variant?: 'game' | 'scenario' }>(), {
  variant: 'game',
})

const online = useOnlineStore()
const copied = ref(false)

const waitingForHost = computed<boolean>(() => online.stage === 'lobby')

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
</script>

<template>
  <div class="online" :class="`online--${props.variant}`">
    <!-- 房主/客人：房间信息与邀请 -->
    <template v-if="online.active">
      <p class="online__room">
        <strong>{{ online.roomName }}</strong>
        <span class="online__dot">·</span>
        <span class="num">{{ online.roomCode }}</span>
        <span class="online__dot">·</span>
        你执 <strong>{{ online.mySideLabel }}</strong>
        <span class="online__dot">·</span>
        {{ online.transportKind }}
      </p>
      <p class="online__status" role="status">{{ online.statusLabel }}</p>
      <p v-if="waitingForHost && online.host" class="online__hint">
        <template v-if="online.lobbyScenarioId">
          剧本已选定，进入初设后双方各自布设本方；对方会自动进入棋桌。
        </template>
        <template v-else>
          房间已建立。去选剧本并进入初设；双方各自布设本方，不需要你替对方落子。
        </template>
      </p>
      <p v-else-if="waitingForHost" class="online__hint">
        等待房主选择剧本并进入初设；开始时你会自动进入棋桌布设本方。
      </p>
      <p v-else-if="online.stage === 'setup'" class="online__hint">
        双方各自布设本方，按先后手自动交棒；只有当前布设方能操作。两方确认后由房主完成初设并开局。
      </p>
      <p v-else class="online__hint">
        视角已锁定为你执的一方；对方先提交时，本地未提交的步骤会提示重做。
      </p>
      <label class="online__label" for="online-invite">邀请链接（不含密码）</label>
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
      <p class="online__note">房间密码不在邀请链接里，请单独发给对手；大厅列表也不会显示密码。</p>
      <p v-if="online.notice" class="online__note">{{ online.notice }}</p>
      <p v-if="online.errorLabel" class="online__error">{{ online.errorLabel }}</p>
    </template>

    <template v-else>
      <p class="online__hint">本局未联机。返回开始台进入联机大厅，设 ID 后建房或加入。</p>
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
