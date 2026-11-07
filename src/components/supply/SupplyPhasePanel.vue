<script setup lang="ts">
import { computed } from 'vue'
import { BaseButton, BasePanel, BaseTag } from '@/components/base'
import { hexLabel, useWorkbenchStore } from '@/stores'
import type { HexRef } from '@/data'

const workbench = useWorkbenchStore()
const recovery = computed(() => workbench.segmentIn(['supply.recovery']))
function keyOf(hex: HexRef): string {
  return `${hex.col}.${hex.row}`
}
function unitsOf(ids: readonly string[]) {
  return workbench.units.filter((unit) => ids.includes(unit.instanceId))
}
function setLoss(hex: HexRef, id: string, event: Event): void {
  workbench.setAttritionAllocation(keyOf(hex), id, Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="phase-panel" @pointerdown.stop @click.stop>
    <BasePanel title="D 补给结算">
      <p>当前环节：{{ workbench.segmentStep?.label }}</p>
      <p v-if="workbench.supplyPhasePlan === null">先查看本阶段的补给计划。</p>
      <BaseButton
        size="sm"
        :disabled="workbench.supplyFeedingSettled"
        @click="workbench.planSupplyPhaseNow()"
        >更新补给计划</BaseButton
      >
      <template v-if="workbench.supplyPhasePlan !== null">
        <p>{{ workbench.supplyPhasePlan.detail }}</p>
        <template v-if="recovery">
          <p>
            强制恢复 {{ workbench.supplyPhasePlan.internalStocks.recoveries.length }} 个单位，需要
            {{ workbench.supplyPhasePlan.internalStocks.spentT }} T。
          </p>
          <BaseTag v-if="workbench.supplyRecoverySettled" kind="success">恢复已结算</BaseTag>
          <BaseButton v-else size="sm" @click="workbench.applySupplyPhaseRecoveryNow()"
            >执行强制恢复</BaseButton
          >
          <p>点击“进入下一环节”也会先执行必须完成的恢复。</p>
        </template>
        <template v-else>
          <details v-if="!workbench.supplyFeedingSettled">
            <summary>
              自愿使用图上补给（{{ workbench.supplyFeedingCandidates.length }} 个断补单位）
            </summary>
            <label
              v-for="unit in workbench.supplyFeedingCandidates"
              :key="unit.instanceId"
              class="choice"
            >
              <input
                v-model="workbench.supplyPhaseInputs.eatOffTheMap[unit.instanceId]"
                type="checkbox"
              />
              {{ unit.name }} · {{ hexLabel(unit.hex) }}
            </label>
          </details>
          <BaseButton
            v-if="!workbench.supplyFeedingSettled"
            size="sm"
            @click="workbench.planSupplyPhaseNow() && workbench.applySupplyPhaseFeedingNow()"
            >确认供养选择与断补标记</BaseButton
          >
          <BaseTag v-else kind="success">供养已结算</BaseTag>
          <div
            v-for="duty in workbench.supplyPhasePlan.attritionDuty"
            :key="keyOf(duty.hex)"
            class="duty"
          >
            <p>
              {{ hexLabel(duty.hex) }} · 断补 {{ duty.oosSteps }} 军力，最高 AR {{ duty.bestAr }}
            </p>
            <BaseTag v-if="workbench.attritionAppliedHexes.includes(keyOf(duty.hex))" kind="success"
              >损耗已结算</BaseTag
            >
            <template v-else>
              <BaseButton
                v-if="!workbench.attritionResults[keyOf(duty.hex)]"
                size="sm"
                :disabled="!workbench.supplyFeedingSettled"
                @click="workbench.rollAttritionNow(keyOf(duty.hex))"
                >掷损耗骰</BaseButton
              >
              <template v-else>
                <p>损耗结果：{{ workbench.attritionResults[keyOf(duty.hex)]?.raw }}</p>
                <label v-for="unit in unitsOf(duty.unitIds)" :key="unit.instanceId" class="choice">
                  {{ unit.name }}（{{ unit.steps }} 军力）
                  <input
                    type="number"
                    min="0"
                    :max="unit.steps"
                    :value="
                      workbench.attritionInputs[keyOf(duty.hex)]?.allocation[unit.instanceId] ?? 0
                    "
                    @change="setLoss(duty.hex, unit.instanceId, $event)"
                  />
                </label>
                <BaseButton size="sm" @click="workbench.applyAttritionNow(keyOf(duty.hex))"
                  >确认损失分配</BaseButton
                >
              </template>
            </template>
          </div>
          <p>未处理的损耗会阻止进入下一阶段。</p>
        </template>
      </template>
    </BasePanel>
  </div>
</template>

<style scoped>
.phase-panel {
  position: absolute;
  right: var(--space-2);
  top: var(--space-2);
  width: 360px;
  max-width: calc(100% - 2 * var(--space-2));
  max-height: calc(100% - 2 * var(--space-2));
  overflow: auto;
  z-index: var(--z-dialog-top);
}
.choice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) 0;
}
.choice input[type='number'] {
  width: 5em;
}
.duty {
  border-top: 1px solid var(--color-rule);
  margin-top: var(--space-3);
}
</style>
