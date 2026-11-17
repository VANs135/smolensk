<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseButton, BaseTag } from '@/components/base'
import CounterPicker from '@/components/game/CounterPicker.vue'
import type { Side } from '@/data'
import { airDistanceToOffMapBox } from '@/engine/rules'
import {
  counterImageUrlOf,
  useContainersStore,
  useMapViewStore,
  useWorkbenchStore,
  type ConsoleAirUnit,
} from '@/stores'

const props = defineProps<{
  aircraft: readonly ConsoleAirUnit[]
  baseId?: string
  boxSide?: Side
}>()

const workbench = useWorkbenchStore()
const containers = useContainersStore()
const mapView = useMapViewStore()
const selectedId = ref<string | null>(null)
/**
 * 用户 2026-11-16：盒内右键原来完全没反应——`CounterPicker` 的格子只接了 click / hover，
 * 右键既没 emit 也没有本地菜单。现在右键与左键选中都落到 `selectedId`，动作区按同一条件显隐，
 * 只在该架真有可用项时才出现，不为"有反应"硬摆空菜单。
 */
const selected = computed(() => props.aircraft.find((air) => air.instanceId === selectedId.value))
const refit = computed(() => props.baseId !== undefined && workbench.refitBase?.id === props.baseId)
const boxRefitAllowed = computed(
  () => props.boxSide !== undefined && workbench.actionAllowedNow('air.refit'),
)
const refitSources = computed(() => workbench.refitPayDumps.length)

/**
 * 15.1 整备小窗的完整三步（2026-11-17 实走）
 *
 * 修前名册只显示「已选 N · 点补给站付款」一行，既没有开始整备的按钮，也没有
 * 「确认整备 / 确认支付」——玩家点开基地只看到驻机名册，整备走不下去。
 * 这里把既有 store 入口（`beginRefitNow` / `confirmRefitSelectionNow` / `confirmRefitPaymentNow`）
 * 接到名册上，判据与结算仍只在 store 里。
 */
const refitSelectedCount = computed(() => workbench.refitSelectedIds.length)
const refitSelectLimit = computed(() => workbench.refitSelectLimit)
const refitDumpLabel = computed(() => {
  const id = workbench.airInputs.refitDumpId
  if (id === null) return null
  const dump = workbench.refitPayDumps.find((item) => item.id === id)
  return dump === undefined ? null : `${dump.hex.col}.${dump.hex.row}`
})
const canStartRefit = computed(
  () =>
    props.baseId !== undefined &&
    workbench.refitStartBases.some((base) => base.id === props.baseId),
)
const refitReason = computed(() =>
  props.baseId === undefined || refit.value ? null : workbench.refitBlockReasonAt(props.baseId),
)

function startRefit(): void {
  if (props.baseId !== undefined) workbench.beginRefitNow(props.baseId)
}

/**
 * 14.11 转场（用户 2026-11-12：目标/目的地一律点图选，不再下拉）
 *
 * 图外盒：选中一架（左键或右键）⇒ 只能「转场到基地」（盒到盒不提供）。
 */
function startBoxToBase(): void {
  const air = selected.value
  if (air === undefined) return
  if (mapView.startBoxTransfer(air.instanceId)) selectedId.value = null
}

/**
 * 14.11：这一架是否有航程内的己方基地（盒 → 基地，距离可加倍）
 *
 * 没有就不摆「转场到基地」——按既有原则，不可用项不出现、不置灰。
 */
const canTransferToBase = computed(() => {
  const air = selected.value
  if (air === undefined || props.boxSide === undefined) return false
  if (!workbench.actionAllowedNow('air.transfer')) return false
  return workbench.ownAirBases.some(
    (base) => airDistanceToOffMapBox(air.side, base.hex) <= air.rangeHexes * 2,
  )
})

const aircraftItems = computed(() =>
  (refit.value ? workbench.refitCandidates : props.aircraft).map((air) => ({
    id: air.instanceId,
    name: air.name,
    imageUrl: counterImageUrlOf(air),
    // 1.4a：激活态**画在算子本身**（未激活压暗），不再用算子下方那行 I/A 小字
    dimmed: air.airStatus !== 'active',
    selected: refit.value
      ? workbench.refitSelectedIds.includes(air.instanceId)
      : selectedId.value === air.instanceId,
  })),
)

function pick(id: string): void {
  if (refit.value) workbench.toggleRefitAircraft(id)
  else selectedId.value = selectedId.value === id ? null : id
}

/** 右键：与左键选中落到同一状态，动作区随之出现（没有可用项就不出现） */
function onContext(id: string): void {
  if (refit.value) return
  selectedId.value = id
}
</script>

<template>
  <div class="roster">
    <CounterPicker
      v-if="aircraftItems.length > 0"
      :items="aircraftItems"
      :size="44"
      @pick="pick"
      @context="onContext"
    />
    <p v-else class="roster__hint">无飞机</p>
    <div v-if="refit" class="roster__row">
      <template v-if="workbench.refitStage === 'select'">
        <span class="roster__hint num">
          已选 {{ refitSelectedCount }} / {{ refitSelectLimit }} 架
        </span>
        <BaseButton
          v-if="refitSelectedCount > 0"
          size="sm"
          variant="primary"
          @click="workbench.confirmRefitSelectionNow()"
          >确认整备</BaseButton
        >
      </template>
      <template v-else>
        <span class="roster__hint">
          已选补给站：{{ refitDumpLabel ?? '点地图上金黄的补给站' }}
        </span>
        <BaseButton
          v-if="workbench.airInputs.refitDumpId !== null"
          size="sm"
          variant="primary"
          @click="workbench.confirmRefitPaymentNow()"
          >确认支付</BaseButton
        >
      </template>
      <BaseTag kind="neutral">15.1</BaseTag>
      <span v-if="refitSources === 0" class="roster__hint">无付款来源</span>
      <BaseButton size="sm" variant="ghost" @click="workbench.cancelRefitNow()">返回</BaseButton>
    </div>
    <template v-else>
      <div v-if="baseId !== undefined" class="roster__row">
        <BaseButton
          v-if="canStartRefit"
          size="sm"
          variant="secondary"
          title="15.1"
          @click="startRefit"
          >整备（15.1）</BaseButton
        >
        <span v-else-if="refitReason !== null" class="roster__hint">{{ refitReason }}</span>
      </div>
      <div class="roster__row">
        <BaseButton
          v-if="
            boxRefitAllowed &&
            boxSide !== undefined &&
            aircraft.some((air) => air.airStatus === 'inactive')
          "
          size="sm"
          variant="secondary"
          @click="containers.activateAirBox(boxSide)"
          >整备盒内飞机 · 1.4a</BaseButton
        >
      </div>
      <!-- 左键选中 / 右键：同一块动作区；没有可用项就整行不出现（不留空行） -->
      <div v-if="canTransferToBase" class="roster__row">
        <!-- 用户 2026-11-12：盒内单位只能转入图上基地，目的地在地图上点选；盒到盒不提供 -->
        <BaseButton size="sm" variant="ghost" @click="startBoxToBase"
          >转场到基地（点图选）· 14.11</BaseButton
        >
      </div>
    </template>
  </div>
</template>

<style scoped>
.roster {
  display: grid;
  gap: var(--space-2);
}
.roster__row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  align-items: center;
}
.roster__hint {
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-sm);
}
.roster__select {
  max-width: 220px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
</style>
