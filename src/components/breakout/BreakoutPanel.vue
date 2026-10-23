<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseButton, BasePanel } from '@/components/base'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
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

const returnHexText = ref('')
const returnSelectedId = ref<string | null>(null)

function deploySelectedReturn(): void {
  const id = returnSelectedId.value
  if (id === null) return
  workbench.deployBreakoutReturnNow(id, returnHexText.value)
}
</script>

<template>
  <BasePanel title="突围（12.8e）">
    <p class="muted num">
      突围环节：地图上**琥珀金高亮的堆叠**即「可突围」的单位（已通过 12.8e 的 A 路径 / B 15 格 / MA
      判据）；**点该格即自动结算突围**（骰子缺省自动）。下方也可逐枚手动突围，或把已突围离图的单位按
      返场回合放回。
    </p>

    <CounterPicker
      title="可尝试突围的单位（点一枚＝宣布突围，12.8e）"
      hint="12.8e：仅在**突围环节**（移动阶段首环节）可用；灰显的是引擎给的原因（有无追溯补给 / A 路径 / B 15 格 / MA）"
      :items="breakoutItems"
      :size="40"
      @pick="workbench.breakoutNow($event)"
    />
    <p v-if="workbench.breakoutCandidates.length === 0" class="muted">
      本方当前没有断补单位 ⇒ 本环节无可突围者（已按 12.8e 自动跳过）。
    </p>

    <hr />

    <template v-if="workbench.breakoutReturns.length > 0">
      <CounterPicker
        title="突围成功·待返场（回合到后按增援入场规则放回）"
        hint="12.8e：成功者离图并**作为增援返回**；落点须是本方的地图边缘入场格且未被敌方单位阻挡（13.6b）"
        :items="returnItems"
        :size="32"
        @pick="returnSelectedId = $event"
      />
      <div class="row">
        <input v-model="returnHexText" class="input num" placeholder="列.行" />
        <BaseButton variant="primary" size="sm" @click="deploySelectedReturn">
          返场到该格（12.8e）
        </BaseButton>
      </div>
      <p class="muted">
        选中一枚待返场单位后，在框里填「列.行」再点按钮；落点必须是本方地图边缘入场格且未被敌方阻挡。
      </p>
    </template>
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

.num {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  margin: var(--space-1) 0;
}

.input {
  width: 80px;
}
</style>
