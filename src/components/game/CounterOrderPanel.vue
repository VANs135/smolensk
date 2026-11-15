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
/** 20.0b：只列同方、AR ≤ 母单位 AR 的拆分单位记录（修前整张表都进下拉） */
const breakdownRecords = computed(() =>
  subjectId.value === null ? [] : workbench.breakdownRecordChoicesFor(subjectId.value),
)
/** 20.0b–d：只列与母单位同格堆叠、同方、AR ≥ 母单位、标记模式一致的拆分单位 */
const breakdownUnitsOnMap = computed(() =>
  subjectId.value === null ? [] : workbench.breakdownAbsorbChoicesFor(subjectId.value),
)
/*
 * 用户 2026-11-14 裁定 2：创建与吸收各有各的时机，面板按 store 判据分块显示——
 *   · 创建 20.0a：开始移动 / 战后推进 / 战后撤退；
 *   · 吸收 20.0d：**只在阶段末（H 清理）**，移动 / 战斗段不摆。
 */
const canCreate = computed(
  () => subjectId.value !== null && workbench.canCreateBreakdownNow(subjectId.value),
)
const canAbsorb = computed(
  () => subjectId.value !== null && workbench.canAbsorbBreakdownNow(subjectId.value),
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

/** 13.3e：点地图选卸货格（点中即运；SP 货须先在补给面板指定起运站） */
function pickRailMoveHex(): void {
  if (cargo.value !== 'sp' && subject.value !== undefined)
    workbench.selectedId = subject.value.instanceId
  workbench.beginRailMoveHexPickNow(cargo.value)
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
      <BaseButton size="sm" variant="secondary" @click="pickRailMoveHex"
        >点图选卸货格（点中即运）</BaseButton
      >
      <BaseButton size="sm" @click="railMove">
        运输至 {{ workbench.railMoveInputs.toHexText || '—' }} · 13.3
      </BaseButton>
    </template>
    <template v-else>
      <template v-if="canCreate">
        <label class="order__subject">
          拆分单位
          <select v-model="recordId">
            <option value="">选择型号</option>
            <option v-for="record in breakdownRecords" :key="record.id" :value="record.id">
              {{ record.nameZh ?? record.nameEn ?? record.id }} · AR
              {{ record.factors?.combat?.ar }}
            </option>
          </select>
        </label>
        <BaseButton v-if="recordId !== ''" size="sm" @click="breakdown">创建 · 20.0a</BaseButton>
      </template>
      <template v-if="canAbsorb">
        <label class="order__subject">
          吸收拆分单位
          <select v-model="absorbId">
            <option value="">
              {{ breakdownUnitsOnMap.length === 0 ? '（同格暂无可吸收的拆分单位）' : '选择算子' }}
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
        <BaseButton v-if="absorbId !== ''" size="sm" variant="secondary" @click="absorb"
          >吸收 · 20.0d</BaseButton
        >
      </template>
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
