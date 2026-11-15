<script setup lang="ts">
import { computed } from 'vue'

import { counterImageUrlOf, useWorkbenchStore } from '@/stores'

/**
 * 共用「受损单位选择」块（炮击 / 空军轰炸共用）
 *
 * 10.0a 的战果一旦产生军力损失，由**目标方**把损失点分配到具体单位；炮击与空军轰炸
 * 走的是同一条 `barrageState` 战果链，所以选择界面也只应有一份实现。
 * 本组件不做任何规则计算：候选、必需点数、已分配点数全部来自 store。
 */
const workbench = useWorkbenchStore()

const targets = computed(() => workbench.barrageLossTargets)
const required = computed(() => workbench.barrageLossRequired)
const allocated = computed(() => workbench.barrageLossAllocated)
</script>

<template>
  <p class="num">本次结果：{{ workbench.barrageSummary?.unitOutcome?.detail ?? '—' }}</p>
  <p class="num">
    请选择承受损失的单位：还需
    <b>{{ Math.max(0, required - allocated) }}</b> 点（共 {{ required }} 点）
  </p>
  <div class="ops__grid">
    <div v-for="unit in targets" :key="unit.instanceId" class="ops__loss num">
      <button
        type="button"
        class="ops__unit"
        :class="{ 'ops__unit--on': workbench.barrageLossPointsOf(unit.instanceId) > 0 }"
        :title="`${unit.name}｜当前军力 ${unit.steps}`"
        @click="workbench.addBarrageLossPoint(unit.instanceId)"
      >
        <img :src="counterImageUrlOf(unit) ?? ''" class="ops__img" alt="" />
      </button>
      <span class="ops__loss-count">
        {{ workbench.barrageLossPointsOf(unit.instanceId) }} / {{ unit.steps }}
      </span>
      <button
        v-if="workbench.barrageLossPointsOf(unit.instanceId) > 0"
        type="button"
        class="ops__minus"
        @click="workbench.removeBarrageLossPoint(unit.instanceId)"
      >
        −
      </button>
    </div>
  </div>
  <p v-if="targets.length === 0" class="muted">目标格内没有可承受损失的单位。</p>
</template>

<style scoped>
.ops__grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0;
}

.ops__unit {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 78px;
  padding: 4px;
  border: 1px solid var(--color-rule);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 11px;
  line-height: 1.2;
  text-align: center;
}

.ops__unit--on {
  outline: 2px solid var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
}

.ops__img {
  width: 44px;
  height: 44px;
  object-fit: contain;
}

.ops__loss {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.ops__loss-count {
  font-size: 11px;
}

.ops__minus {
  width: 22px;
  height: 20px;
  border: 1px solid var(--color-rule);
  border-radius: 3px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.ops__minus:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
