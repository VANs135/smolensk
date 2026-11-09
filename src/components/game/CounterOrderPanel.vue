<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseButton, BaseTag } from '@/components/base'
import UiField from '@/components/UiField.vue'
import { hexLabel, useMapViewStore, useWorkbenchStore } from '@/stores'

const props = defineProps<{ order: 'railGauge' | 'railMove' | 'breakdown' }>()
const mapView = useMapViewStore()
const workbench = useWorkbenchStore()
const subjectId = computed(() => mapView.unitActionUnitId)
const hex = computed(() => mapView.unitActionHex)
const subject = computed(() => workbench.units.find((item) => item.instanceId === subjectId.value))
const cargo = computed(() => {
  if (
    subject.value === undefined ||
    subject.value.noncombatKind === 'sp' ||
    subject.value.noncombatKind === 'supply_point'
  )
    return 'sp'
  return subject.value.noncombatTransport > 0 ? 'transportPoint' : 'unit'
})
const recordId = ref('')
const absorbId = ref('')
const breakdownRecords = computed(() =>
  workbench.choices.filter((item) => item.branch === 'breakdown'),
)
/** 20.0d 吸收对象＝图上已有的拆分单位 */
const breakdownUnitsOnMap = computed(() =>
  workbench.units.filter((unit) => unit.specialized.includes('breakdown')),
)
const refusal = computed(() =>
  props.order === 'railMove' ? workbench.railMoveError : workbench.actionRefusal,
)

function convert(): void {
  if (
    subjectId.value !== null &&
    hex.value !== null &&
    workbench.convertRailGaugeNow(subjectId.value, hexLabel(hex.value))
  ) {
    mapView.cancelSession()
  }
}

function railMove(): void {
  if (subject.value !== undefined && cargo.value !== 'sp')
    workbench.selectedId = subject.value.instanceId
  if (workbench.railMoveNow(cargo.value)) mapView.cancelSession()
}

function breakdown(): void {
  if (subjectId.value !== null && workbench.createBreakdownNow(subjectId.value, recordId.value)) {
    mapView.cancelSession()
  }
}

function absorb(): void {
  if (subjectId.value !== null && workbench.absorbBreakdownNow(subjectId.value, absorbId.value)) {
    mapView.cancelSession()
  }
}
</script>

<template>
  <div class="order">
    <div class="order__subject">
      <strong>{{ subject?.name ?? '补给站' }}</strong>
      <BaseTag v-if="hex !== null" kind="neutral">{{ hexLabel(hex) }}</BaseTag>
    </div>
    <BaseButton v-if="order === 'railGauge'" size="sm" @click="convert"
      >转换此格 · 13.3f</BaseButton
    >
    <template v-else-if="order === 'railMove'">
      <label v-if="cargo === 'sp'" class="order__subject">
        SP <UiField v-model="workbench.railMoveInputs.spAmount" type="number" min="1" stepper />
      </label>
      <BaseButton size="sm" variant="secondary" @click="workbench.beginRailMoveHexPickNow()"
        >点图选卸货格</BaseButton
      >
      <BaseButton size="sm" :disabled="workbench.railMoveInputs.toHexText === ''" @click="railMove">
        运输至 {{ workbench.railMoveInputs.toHexText || '—' }} · 13.3
      </BaseButton>
    </template>
    <template v-else>
      <label class="order__subject">
        拆分单位
        <select v-model="recordId">
          <option value="">选择型号</option>
          <option v-for="record in breakdownRecords" :key="record.id" :value="record.id">
            {{ record.nameZh ?? record.nameEn ?? record.id }} · AR {{ record.factors?.combat?.ar }}
          </option>
        </select>
      </label>
      <BaseButton size="sm" :disabled="recordId === ''" @click="breakdown">创建 · 20.0a</BaseButton>
      <label class="order__subject">
        吸收拆分单位
        <select v-model="absorbId">
          <option value="">
            {{ breakdownUnitsOnMap.length === 0 ? '（图上暂无拆分单位）' : '选择算子' }}
          </option>
          <option
            v-for="unit in breakdownUnitsOnMap"
            :key="unit.instanceId"
            :value="unit.instanceId"
          >
            {{ unit.name }} @ {{ hexLabel(unit.hex) }}
          </option>
        </select>
      </label>
      <BaseButton size="sm" variant="secondary" :disabled="absorbId === ''" @click="absorb"
        >吸收 · 20.0d</BaseButton
      >
    </template>
    <p v-if="refusal !== null" class="order__error" role="status">
      {{ refusal.rule }} · {{ refusal.reason }}
    </p>
  </div>
</template>

<style scoped>
.order {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  align-items: center;
}
.order__subject {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
}
.order__error {
  color: var(--color-danger);
  width: 100%;
  margin: 0;
  font-size: var(--text-sm);
}
</style>
