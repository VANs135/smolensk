<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { BaseButton, BaseIcon } from '@/components/base'
import type { HexRef } from '@/data'
import { hexLabel, useWorkbenchStore } from '@/stores'

const workbench = useWorkbenchStore()
const recovery = computed(() => workbench.segmentIn(['supply.recovery']))
const plan = computed(() => workbench.supplyPhasePlan)
const feedback = ref('')
/** 12 号：默认展开，玩家可收起成右上角一枚小条，不挡地图 */
const collapsed = ref(false)

watch(
  () => workbench.segmentStep?.id,
  () => (feedback.value = ''),
)

const unitsById = computed(() => new Map(workbench.units.map((unit) => [unit.instanceId, unit])))

/** 21.10b：Forage 与 12.6c 图上供养在 D 段并列二选一（入口只此一处） */
const forageOptions = computed(() => workbench.forageOptions)
const canUndoForage = computed(
  () => workbench.lastSupplyCacheUse === 'Forage' && !workbench.supplyFeedingSettled,
)

function hqName(instanceId: string): string {
  return unitsById.value.get(instanceId)?.name ?? instanceId
}

function keyOf(hex: HexRef): string {
  return `${hex.col}.${hex.row}`
}

function unitsOf(ids: readonly string[]) {
  return ids.flatMap((id) => {
    const unit = unitsById.value.get(id)
    return unit === undefined ? [] : [unit]
  })
}

function onAction(action: () => boolean): void {
  const previous = workbench.log[0]?.id
  if (action()) {
    feedback.value = ''
    return
  }
  const latest = workbench.log[0]
  feedback.value =
    latest !== undefined && latest.id !== previous ? latest.text : '操作未完成，查看行动日志'
}

function onFeeding(): void {
  onAction(() => workbench.planSupplyPhaseNow() && workbench.applySupplyPhaseFeedingNow())
}

function onSetLoss(hex: HexRef, id: string, max: number, event: Event): void {
  const field = event.target as HTMLInputElement
  const value = Number.isFinite(field.valueAsNumber) ? Math.trunc(field.valueAsNumber) : 0
  const bounded = Math.max(0, Math.min(max, value))
  field.value = String(bounded)
  workbench.setAttritionAllocation(keyOf(hex), id, bounded)
  feedback.value = ''
}

/**
 * 本环节是否**还有待决**（无待决就不渲染，而不是留一块「已完成」的常驻面板）
 *
 * 判据全部来自 store 的既有结算事实：计划未生成 / 恢复未结算 / 供养未结算 /
 * 还有断补堆叠没掷或没分配。玩家做完最后一件事，面板自行消失，流程条继续推进。
 */
const pending = computed<boolean>(() => {
  const current = plan.value
  if (current === null) return true
  if (recovery.value) return !workbench.supplyRecoverySettled
  if (!workbench.supplyFeedingSettled) return true
  return current.attritionDuty.some(
    (duty) => !workbench.attritionAppliedHexes.includes(keyOf(duty.hex)),
  )
})
</script>

<template>
  <section
    v-if="pending"
    class="phase-panel"
    :class="{ 'phase-panel--collapsed': collapsed }"
    aria-label="补给结算"
    @pointerdown.stop
    @click.stop
    @wheel.stop
  >
    <header class="phase-panel__head">
      <span class="phase-panel__step num">D</span>
      <h3>{{ recovery ? '部队储备恢复' : '补给结算' }}</h3>
      <span class="phase-panel__rule num">{{ recovery ? '§12.10e' : '§12.6 / §12.8' }}</span>
      <button
        type="button"
        class="phase-panel__toggle"
        :aria-expanded="!collapsed"
        :aria-label="collapsed ? '展开补给结算' : '收起补给结算'"
        :title="collapsed ? '展开' : '收起'"
        @click.stop="collapsed = !collapsed"
      >
        <BaseIcon :name="collapsed ? 'chevron-down' : 'chevron-right'" />
      </button>
    </header>

    <div v-if="!collapsed" class="phase-panel__body">
      <div class="phase-panel__row">
        <BaseButton
          v-if="!workbench.supplyFeedingSettled"
          :variant="plan === null ? 'primary' : 'secondary'"
          size="sm"
          @click="onAction(workbench.planSupplyPhaseNow)"
        >
          {{ plan === null ? '生成补给计划' : '刷新计划' }}
        </BaseButton>
      </div>

      <template v-if="plan !== null">
        <template v-if="recovery">
          <div class="phase-panel__row">
            <span class="phase-panel__data num">
              {{ plan.internalStocks.recoveries.length }} 单位 · {{ plan.internalStocks.spentT }} T
            </span>
            <span v-if="workbench.supplyRecoverySettled" class="phase-panel__done">已恢复</span>
            <BaseButton
              v-else
              variant="primary"
              size="sm"
              @click="onAction(workbench.applySupplyPhaseRecoveryNow)"
            >
              执行强制恢复
            </BaseButton>
          </div>
        </template>

        <template v-else>
          <div class="phase-panel__row">
            <details v-if="!workbench.supplyFeedingSettled" class="phase-panel__feeding">
              <summary>
                图上供养（12.6c）· {{ workbench.supplyFeedingCandidates.length }} 单位
              </summary>
              <label
                v-for="unit in workbench.supplyFeedingCandidates"
                :key="unit.instanceId"
                class="phase-panel__choice"
              >
                <input
                  v-model="workbench.supplyPhaseInputs.eatOffTheMap[unit.instanceId]"
                  type="checkbox"
                />
                <span>{{ unit.name }}</span>
                <span class="phase-panel__data num">{{ hexLabel(unit.hex) }}</span>
              </label>
            </details>
            <details
              v-if="!workbench.supplyFeedingSettled && forageOptions.length > 0"
              class="phase-panel__feeding"
            >
              <summary>Forage（21.10b，二选一）· {{ forageOptions.length }} 个可用 HQ</summary>
              <div v-for="option in forageOptions" :key="option.hqId" class="phase-panel__choice">
                <span>{{ hqName(option.hqId) }}</span>
                <span class="phase-panel__data num"
                  >投递 {{ option.throwRangeMp }} MP · 覆盖
                  {{ option.coveredUnitIds.length }} 单位</span
                >
                <BaseButton
                  variant="secondary"
                  size="sm"
                  @click="onAction(() => workbench.useForageNow(option.hqId))"
                >
                  花 1 枚
                </BaseButton>
              </div>
            </details>
            <BaseButton
              v-if="canUndoForage"
              variant="ghost"
              size="sm"
              @click="onAction(workbench.undoSupplyCacheUse)"
            >
              撤销 Forage
            </BaseButton>
            <BaseButton
              v-if="!workbench.supplyFeedingSettled"
              variant="primary"
              size="sm"
              @click="onFeeding"
            >
              确认供养与断补
            </BaseButton>
            <span v-else class="phase-panel__done">供养已结算</span>
          </div>

          <div v-for="duty in plan.attritionDuty" :key="keyOf(duty.hex)" class="phase-panel__duty">
            <div class="phase-panel__row">
              <strong class="num">{{ hexLabel(duty.hex) }}</strong>
              <span class="phase-panel__data num"
                >{{ duty.oosSteps }} 军力 · AR {{ duty.bestAr }}</span
              >
              <span
                v-if="workbench.attritionAppliedHexes.includes(keyOf(duty.hex))"
                class="phase-panel__done"
              >
                损耗已结算
              </span>
              <BaseButton
                v-else-if="
                  workbench.supplyFeedingSettled && !workbench.attritionResults[keyOf(duty.hex)]
                "
                size="sm"
                @click="onAction(() => workbench.rollAttritionNow(keyOf(duty.hex)))"
              >
                掷损耗骰
              </BaseButton>
              <strong v-else class="phase-panel__result num">
                {{ workbench.attritionResults[keyOf(duty.hex)]?.raw }}
              </strong>
            </div>
            <div
              v-if="
                !workbench.attritionAppliedHexes.includes(keyOf(duty.hex)) &&
                workbench.attritionResults[keyOf(duty.hex)]
              "
              class="phase-panel__allocation"
            >
              <template v-if="workbench.attritionNeedsAllocation(keyOf(duty.hex))">
                <label
                  v-for="unit in unitsOf(duty.unitIds)"
                  :key="unit.instanceId"
                  class="phase-panel__choice"
                >
                  <span>{{ unit.name }}</span>
                  <span class="phase-panel__data num">{{ unit.steps }} 军力</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    :max="unit.steps"
                    :value="
                      workbench.attritionInputs[keyOf(duty.hex)]?.allocation[unit.instanceId] ?? 0
                    "
                    @change="onSetLoss(duty.hex, unit.instanceId, unit.steps, $event)"
                  />
                </label>
              </template>
              <BaseButton
                variant="primary"
                size="sm"
                @click="onAction(() => workbench.applyAttritionNow(keyOf(duty.hex)))"
              >
                {{
                  workbench.attritionNeedsAllocation(keyOf(duty.hex))
                    ? '确认损失分配'
                    : '确认无损耗'
                }}
              </BaseButton>
            </div>
          </div>
        </template>
      </template>

      <p v-if="feedback" class="phase-panel__feedback" role="status">{{ feedback }}</p>
    </div>
  </section>
</template>

<style scoped>
.phase-panel {
  position: absolute;
  inset: var(--space-3) var(--space-3) auto auto;
  width: min(364px, calc(100% - 2 * var(--space-3)));
  max-height: calc(100% - 2 * var(--space-3));
  overflow: auto;
  overscroll-behavior: contain;
  z-index: var(--layer-map-popup);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-lg);
  background: var(--color-panel);
  color: var(--color-ink);
  box-shadow: var(--shadow-lg);
  font-size: var(--text-sm);
  line-height: 1.35;
  color-scheme: dark;
}

.phase-panel__head,
.phase-panel__row,
.phase-panel__choice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.phase-panel__head {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-rule);
}

.phase-panel__head h3 {
  margin: 0;
  font-size: var(--text-lg);
}

.phase-panel__step {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-command-teal-bg);
  color: var(--color-command-teal);
  font-weight: 700;
}

.phase-panel__rule,
.phase-panel__data {
  color: var(--color-muted);
  font-size: var(--text-xs);
}

.phase-panel__rule {
  margin-left: auto;
}

/* 12 号：收起后只剩右上角一枚小条，不再压住地图 */
.phase-panel--collapsed {
  width: auto;
  max-height: none;
}

.phase-panel--collapsed .phase-panel__head {
  border-bottom: 0;
}

.phase-panel__toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
  font: inherit;
}

.phase-panel__toggle:hover {
  color: var(--color-ink);
}

.phase-panel__body,
.phase-panel__allocation {
  display: grid;
  gap: var(--space-2);
}

.phase-panel__body {
  padding: var(--space-2) var(--space-3);
}

.phase-panel__done {
  color: var(--color-command-teal);
  font-weight: 700;
}

.phase-panel__feeding {
  flex: 1 0 100%;
}

.phase-panel__feeding summary {
  padding: var(--space-1) 0;
  font-weight: 700;
  cursor: pointer;
}

.phase-panel__choice {
  min-height: var(--control-height-sm);
  padding: var(--space-1) 0;
  border-bottom: 1px solid var(--color-rule);
}

.phase-panel__choice .phase-panel__data {
  margin-left: auto;
}

.phase-panel__choice input[type='checkbox'] {
  accent-color: var(--color-command-teal);
}

.phase-panel__choice input[type='number'] {
  width: 4em;
  min-height: var(--control-height-sm);
  padding: 0 var(--space-1);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-ink);
  font: inherit;
}

.phase-panel__duty {
  display: grid;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-rule);
}

.phase-panel__result {
  color: var(--color-command-amber);
}

.phase-panel__feedback {
  margin: 0;
  color: var(--color-command-danger);
  font-size: var(--text-xs);
}
</style>
