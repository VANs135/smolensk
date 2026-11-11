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
const boxRefitAllowed = computed(
  () => props.boxSide !== undefined && workbench.actionAllowedNow('air.refit'),
)
const refitSources = computed(() => workbench.refitPayDumps.length)

/**
 * 条 14：飞出盒＝完整的 14.11 落位流程（选本方空军基地 → 落位 → 回显）
 *
 * 飞入盒只裁 1.4a 的往返航程（一键即可）；飞出盒在规则上等同 14.11 基地转移，
 * 目的地必须是本方空军基地，故必须先选基地再确认。
 */
const flyOutPick = ref(false)
const targetBaseHex = ref('')
const landed = ref<string | null>(null)
const flyOutError = ref<string | null>(null)

/** 飞出盒的目的地候选（本方空军基地；距离/激活态仍由 store 走 14.11 判） */
const flyOutTargets = computed(() =>
  workbench.ownAirBases
    .filter((base) => props.boxSide === undefined || base.side === props.boxSide)
    .map((base) => {
      const hex = `${base.hex.col}.${base.hex.row}`
      const unit = workbench.units.find((item) => item.instanceId === base.id)
      return { hex, label: `${unit?.name ?? '空军基地'}（${hex}）` }
    }),
)

function beginFlyOut(): void {
  flyOutPick.value = true
  targetBaseHex.value = ''
  landed.value = null
  flyOutError.value = null
}

function confirmFlyOut(): void {
  const air = selected.value
  if (air === undefined || targetBaseHex.value === '') return
  if (containers.flyOutOfBox(air.instanceId, targetBaseHex.value)) {
    landed.value = containers.lastAction?.detail ?? null
    flyOutError.value = null
    flyOutPick.value = false
    targetBaseHex.value = ''
    selectedId.value = null
  } else {
    flyOutError.value = containers.lastAction?.detail ?? '未能落位（14.11）'
  }
}

/**
 * 14.11 基地 → 基地转移（图上基地载体）
 *
 * 图外空军盒走上面的「飞出盒」；图上基地在这里选目的地，落位判据仍由
 * `transferAircraftNow` → `planBaseTransfer` 裁（距离 / 激活态 / 归属）。
 */
const transferPick = ref(false)
const transferHex = ref('')
const transferResult = ref<string | null>(null)
const transferError = ref<string | null>(null)

const transferTargets = computed(() =>
  workbench.ownAirBases
    .filter((base) => base.id !== props.baseId)
    .map((base) => {
      const hex = `${base.hex.col}.${base.hex.row}`
      const unit = workbench.units.find((item) => item.instanceId === base.id)
      return { hex, label: `${unit?.name ?? '空军基地'}（${hex}）` }
    }),
)

function beginTransfer(): void {
  transferPick.value = true
  transferHex.value = ''
  transferResult.value = null
  transferError.value = null
}

function confirmTransfer(): void {
  const air = selected.value
  if (air === undefined || transferHex.value === '') return
  if (workbench.transferAircraftNow(air.instanceId, transferHex.value)) {
    transferResult.value =
      workbench.lastTransfer?.detail ?? `已转移至 ${transferHex.value}（14.11）`
    transferError.value = null
    transferPick.value = false
    transferHex.value = ''
    selectedId.value = null
  } else {
    transferError.value = '未能转移（14.11：目的地须为本方空军基地，距离与激活态须合规）'
  }
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
          <BaseButton v-if="!flyOutPick" size="sm" variant="ghost" @click="beginFlyOut"
            >飞出盒 · 14.11</BaseButton
          >
          <template v-else>
            <select v-model="targetBaseHex" class="roster__select">
              <option value="">（选本方空军基地）</option>
              <option v-for="target in flyOutTargets" :key="target.hex" :value="target.hex">
                {{ target.label }}
              </option>
            </select>
            <BaseButton
              size="sm"
              variant="primary"
              :disabled="targetBaseHex === ''"
              @click="confirmFlyOut"
              >确认飞出盒 · 14.11</BaseButton
            >
          </template>
        </template>
        <template v-else>
          <!-- 14.11：图上基地 → 图上基地（图外空军盒走上面的「飞出盒」） -->
          <template v-if="workbench.actionAllowedNow('air.transfer')">
            <BaseButton v-if="!transferPick" size="sm" variant="ghost" @click="beginTransfer"
              >转移 · 14.11</BaseButton
            >
            <template v-else>
              <select v-model="transferHex" class="roster__select">
                <option value="">（选另一个本方空军基地）</option>
                <option v-for="target in transferTargets" :key="target.hex" :value="target.hex">
                  {{ target.label }}
                </option>
              </select>
              <BaseButton
                size="sm"
                variant="primary"
                :disabled="transferHex === ''"
                @click="confirmTransfer"
                >确认转移 · 14.11</BaseButton
              >
            </template>
          </template>
          <!-- 飞入盒只裁 1.4a 的往返航程 ⇒ 仍一键 -->
          <BaseButton
            size="sm"
            variant="ghost"
            @click="containers.setAirInBox(selected.instanceId, true)"
            >飞入盒 · 1.4a</BaseButton
          >
        </template>
      </div>
      <!-- 条 14：落位/被拒的可见回显（不再点完只关窗） -->
      <div v-if="landed !== null || flyOutError !== null" class="roster__row">
        <BaseTag v-if="landed !== null" kind="success">{{ landed }}</BaseTag>
        <BaseTag v-else kind="danger">{{ flyOutError }}</BaseTag>
      </div>
      <div v-if="transferResult !== null || transferError !== null" class="roster__row">
        <BaseTag v-if="transferResult !== null" kind="success">{{ transferResult }}</BaseTag>
        <BaseTag v-else kind="danger">{{ transferError }}</BaseTag>
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
