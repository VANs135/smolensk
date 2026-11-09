<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseButton, BaseTag } from '@/components/base'
import CounterPicker from '@/components/game/CounterPicker.vue'
import type { Side } from '@/data'
import {
  counterImageUrlOf,
  useContainersStore,
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
const selectedId = ref<string | null>(null)
const selected = computed(() => props.aircraft.find((air) => air.instanceId === selectedId.value))
const refit = computed(() => props.baseId !== undefined && workbench.refitBase?.id === props.baseId)
const refitOpen = computed(
  () => props.baseId !== undefined && workbench.actionAllowedNow('air.refit'),
)
const refitDone = computed(() => workbench.refitDoneBases.some((base) => base.id === props.baseId))
const boxRefitAllowed = computed(
  () => props.boxSide !== undefined && workbench.actionAllowedNow('air.refit'),
)
const transferId = ref<string | null>(null)
const refitSources = computed(() => workbench.refitPayDumps.length)

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

function startRefit(): void {
  if (props.baseId === undefined || !workbench.beginRefitNow(props.baseId)) return
  if (
    selected.value !== undefined &&
    workbench.refitCandidates.some((air) => air.instanceId === selectedId.value)
  ) {
    workbench.toggleRefitAircraft(selected.value.instanceId)
  }
}

function prepareTransfer(): void {
  if (selected.value === undefined) return
  transferId.value = selected.value.instanceId
  workbench.airInputs.transferToHexText = ''
  workbench.beginAirTransferHexPickNow()
}

function finishTransfer(): void {
  if (transferId.value !== null && workbench.transferAircraftNow(transferId.value)) {
    transferId.value = null
    selectedId.value = null
  }
}

function cancelTransfer(): void {
  workbench.cancelHexPick()
  transferId.value = null
}
</script>

<template>
  <div class="roster">
    <template v-if="transferId !== null">
      <p class="roster__hint">点地图选目的基地 <BaseTag kind="neutral">14.11</BaseTag></p>
      <div class="roster__row">
        <BaseButton size="sm" variant="secondary" @click="workbench.beginAirTransferHexPickNow()"
          >选基地</BaseButton
        >
        <BaseButton
          size="sm"
          :disabled="workbench.airInputs.transferToHexText === ''"
          @click="finishTransfer"
        >
          转移 {{ workbench.airInputs.transferToHexText }}
        </BaseButton>
        <BaseButton size="sm" variant="ghost" @click="cancelTransfer">返回</BaseButton>
      </div>
    </template>
    <template v-else>
      <CounterPicker
        v-if="aircraftItems.length > 0"
        :items="aircraftItems"
        :size="44"
        @pick="pick"
      />
      <p v-else class="roster__hint">无飞机</p>
      <div v-if="refit" class="roster__row">
        <span class="roster__hint"
          >已选 {{ workbench.refitSelectedIds.length }} · 点补给站付款</span
        >
        <BaseTag kind="neutral">15.1</BaseTag>
        <span v-if="refitSources === 0" class="roster__hint">无付款来源</span>
        <BaseButton size="sm" variant="ghost" @click="workbench.cancelRefitNow()">返回</BaseButton>
      </div>
      <template v-else>
        <div class="roster__row">
          <BaseButton
            v-if="refitOpen"
            size="sm"
            variant="secondary"
            :disabled="refitDone || !aircraft.some((air) => air.airStatus === 'inactive')"
            @click="startRefit"
            >{{ refitDone ? '已整备' : '整备' }} · 15.1</BaseButton
          >
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
          <BaseButton
            v-if="baseId !== undefined"
            size="sm"
            variant="secondary"
            @click="prepareTransfer"
            >转移 · 14.11</BaseButton
          >
          <BaseButton
            size="sm"
            variant="ghost"
            @click="containers.setAirInBox(selected.instanceId, boxSide === undefined)"
            >{{ boxSide === undefined ? '飞入盒' : '飞出盒' }} · 1.4a</BaseButton
          >
        </div>
      </template>
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
</style>
