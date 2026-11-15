<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseButton, BasePanel, RuleTip } from '@/components/base'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
import { SessionStep } from '@/components/session'
import { counterImageUrlOf, hexLabel, useWorkbenchStore } from '@/stores'

/**
 * 条 6（R3）：**突围**会话面板（12.8e）
 *
 * 把 `MovePanel` 原先挂在右栏 `v-else` 里、**正常突围段不可达**的突围块，移进**这个会话框**。
 * 判据全在 store/引擎（`workbench.breakoutCandidates` / `breakoutNow` / `breakoutReturns`），
 * 本组件只画图、只收点击（分层纪律 CODE_SPEC）。
 *
 * 配合：① 地图上可突围堆叠的**琥珀金高亮**；② 点可突围单位**即自动结算**（`map-view.onHexClick`
 * 在突围环节把点击直接转成 `breakoutNow`）——本面板作为"看清单 + 手动逐枚突围 + 待返场放回"的入口。
 */
const workbench = useWorkbenchStore()

/** 12.8e：可尝试突围的单位（ok 的点一下即 `breakoutNow`；灰显的是引擎给的原因） */
const breakoutItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.breakoutCandidates.map((entry) => ({
    id: entry.unit.instanceId,
    imageUrl: counterImageUrlOf(entry.unit),
    name: `${entry.unit.name}@ ${hexLabel(entry.unit.hex)}`,
    selected: false,
    disabledReason: entry.ok ? null : entry.reason,
    hex: entry.unit.hex,
  })),
)

/** 12.8e：待返场清单（成功离图者，按回合放回；点一枚即选中、再填格号放回） */
const returnItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.breakoutReturns.map((entry) => ({
    id: entry.unit.instanceId,
    imageUrl: counterImageUrlOf(entry.unit),
    name: `${entry.unit.name}（回合 ${entry.returnsOnTurn} 返场）`,
    selected: entry.unit.instanceId === returnSelectedId.value,
    disabledReason:
      workbench.turn < entry.returnsOnTurn
        ? `12.8e：要到回合 ${entry.returnsOnTurn} 才能返场`
        : null,
    hex: entry.unit.hex,
  })),
)

const returnSelectedId = ref<string | null>(null)

/**
 * 12.8e：返场落点**点地图选格**（不再手打格号）
 *
 * 候选给 `'any'`：12.8e 按 13.6b「作为增援返回」——合法落点由引擎在提交时校验
 * （本方边缘入场格、且未被敌方阻挡），点错就地给红字并保留待点态，玩家可继续点。
 */
function beginReturnHexPick(): void {
  const id = returnSelectedId.value
  if (id === null) return
  workbench.beginHexPick({
    label: '返场落点',
    rule: '12.8e',
    candidates: 'any',
    apply: (hex) => {
      const ok = workbench.deployBreakoutReturnNow(id, `${hex.col}.${hex.row}`)
      if (ok) returnSelectedId.value = null
      return ok
    },
  })
}
</script>

<template>
  <BasePanel title="突围">
    <RuleTip rule="12.8e" />

    <!-- U1-b：返场是已突围单位的收尾，先做；做完才轮到「尝试突围」 -->
    <SessionStep item="breakout:return">
      <template v-if="workbench.breakoutReturns.length > 0">
        <hr />
        <CounterPicker
          title="待返场"
          :items="returnItems"
          :size="32"
          @pick="returnSelectedId = $event"
        />
        <div v-if="returnSelectedId !== null" class="row">
          <BaseButton variant="primary" size="sm" @click="beginReturnHexPick">
            点地图选返场落点
          </BaseButton>
        </div>
      </template>
    </SessionStep>

    <SessionStep item="breakout:act">
      <CounterPicker
        title="可尝试突围"
        :items="breakoutItems"
        :size="40"
        @pick="workbench.breakoutNow($event)"
      />
      <p v-if="workbench.breakoutCandidates.length === 0" class="muted">—</p>
    </SessionStep>
  </BasePanel>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) 0;
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}
</style>
