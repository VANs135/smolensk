<script setup lang="ts">
import { ref } from 'vue'
import { BaseButton, BaseDialog, BasePanel } from '@/components/base'
import { useGameSessionStore, useSetupStore, useUiStore } from '@/stores'
const game = useGameSessionStore(),
  ui = useUiStore()
const confirmNew = ref(false)
function newGame(): void {
  if (game.session !== null) {
    confirmNew.value = true
    return
  }
  ui.navigate('scenario')
}
function restart(): void {
  if (useSetupStore().restartGameNow()) {
    confirmNew.value = false
    ui.navigate('scenario')
  }
}
</script>
<template>
  <div class="home">
    <BasePanel title="OCS 斯摩棱斯克">
      <p>双人同机推演。玩家决定行动，程序处理掷骰、补给与结算。</p>
      <div class="actions">
        <BaseButton @click="newGame">新建对局</BaseButton>
        <BaseButton v-if="game.session !== null" variant="secondary" @click="ui.navigate('game')"
          >继续当前对局</BaseButton
        >
        <BaseButton variant="secondary" @click="ui.openSaveDialog()">读取存档</BaseButton>
      </div>
      <p>新建时选择剧本与共识规则，再完成双方初设。每个环节的必要待办处理完毕后，进入下一环节。</p>
    </BasePanel>
    <BaseDialog v-model:open="confirmNew" title="新建对局">
      <p>新建会替换当前内存中的对局。需要保留进度时，请先保存；已有存档槽不会被删除。</p>
      <template #footer>
        <BaseButton variant="secondary" @click="confirmNew = false">返回</BaseButton>
        <BaseButton @click="restart">确认新建</BaseButton>
      </template>
    </BaseDialog>
  </div>
</template>
<style scoped>
.home {
  max-width: 960px;
  margin: var(--space-4) auto;
  padding: var(--space-4);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: var(--space-4) 0;
}
</style>
