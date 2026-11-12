<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseButton, BaseTag } from '@/components/base'
import CounterPicker from '@/components/game/CounterPicker.vue'
import type { Side } from '@/data'
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
const selected = computed(() => props.aircraft.find((air) => air.instanceId === selectedId.value))
const refit = computed(() => props.baseId !== undefined && workbench.refitBase?.id === props.baseId)
const boxRefitAllowed = computed(
  () => props.boxSide !== undefined && workbench.actionAllowedNow('air.refit'),
)
const refitSources = computed(() => workbench.refitPayDumps.length)

/**
 * 14.11 转场（用户 2026-11-12：目标/目的地一律点图选，不再下拉）
 *
 * 图上基地：选中一架 ⇒ 两个子项「进入地图外盒」「放入别的空军基地」；
 * 图外盒：选中一架 ⇒ 只能「转场到基地」（盒到盒不提供）。
 */
function startBoxToBase(): void {
  const air = selected.value
  if (air === undefined) return
  mapView.startBoxTransfer(air.instanceId)
}

const aircraftItems = computed(() =>
  (refit.value ? workbench.refitCandidates : props.aircraft).map((air) => ({
    id: air.instanceId,
    name: air.name,
    imageUrl: counterImageUrlOf(air),
    badge: air.airStatus === 'active' ? 'A' : 'I',
    selected: refit.value
      ? workbench.refitSelectedIds.includes(air.instanceId)
      : selectedId.value === air.instanceId,
  })),
)

function pick(id: string): void {
  if (refit.value) workbench.toggleRefitAircraft(id)
  else selectedId.value = selectedId.value === id ? null : id
}
</script>

<template>
  <div class="roster">
    <CounterPicker v-if="aircraftItems.length > 0" :items="aircraftItems" :size="44" @pick="pick" />
    <p v-else class="roster__hint">无飞机</p>
    <div v-if="refit" class="roster__row">
      <span class="roster__hint">已选 {{ workbench.refitSelectedIds.length }} · 点补给站付款</span>
      <BaseTag kind="neutral">15.1</BaseTag>
      <span v-if="refitSources === 0" class="roster__hint">无付款来源</span>
      <BaseButton size="sm" variant="ghost" @click="workbench.cancelRefitNow()">返回</BaseButton>
    </div>
    <template v-else>
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
      <div v-if="selected !== undefined" class="roster__row">
        <template v-if="boxSide !== undefined">
          <!-- 用户 2026-11-12：盒内单位只能转入图上基地，目的地在地图上点选；盒到盒不提供 -->
          <BaseButton size="sm" variant="ghost" @click="startBoxToBase"
            >转场到基地（点图选）· 14.11</BaseButton
          >
        </template>
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
