<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { useMapViewStore } from '@/stores'
import { BaseButton } from '@/components/base'
import { AirPanel } from '@/components/air'
import { ExclusiveRulesPanel } from '@/components/exclusive'
import { SupplyPanel } from '@/components/supply'

/**
 * 条 12（M2）+ 条 13/19（批 A）：**点非战斗单位开的动作会话**（`MapSessionKind:'unit'`）
 *
 * 按所点单位的类型（`mapView.unitActionFamily`）分派到**既有**面板；面板只画**挑定的那一段**：
 *   · supply（sp / 运输点 / 编内卡车 / 延补队）⇒ `SupplyPanel`（`sp` / `dumpBlow` / `transport` /
 *     `extender` / `loadUnload` 五段里的一段）
 *   · air（空军基地）⇒ `AirPanel`（`refit` / `airstrip` / `reduce` / `capture` / `place` 里的一段）
 *   · fort（工事 hedgehog）⇒ `ExclusiveRulesPanel`（`hedgehog` 段）
 *
 * ★ 用户 2026-10-25「UI 要分类，**一个操作一个面板**」＋「**在什么环节，点什么单位才出现什么菜单**」：
 *   菜单项的**唯一来源**是 `mapView.unitActionOptions(instanceId)` ——
 *   ＝ `facilityActionKeys(该设施类)`（规则书里"对它自己"能做的动作族）∩ **本环节闸门**
 *   （`actionAllowedNow`）。所以：同一枚基地在 A 段只出「整备」、在 C 段只出「修建 / 缩减」；
 *   补给站在 C/E/G 移动环节只出「销毁」、在 A/D/F 段**一个操作都没有**（不给入口、不开会话）。
 *   规则号随每项一起给出（`item.rule`），组件**不自己拼规则号或阶段名**。
 *
 * 分层纪律（CODE_SPEC）：本组件**只做分派、不算规则** —— 各面板自身仍是唯一的事实来源。
 */

/** AirPanel 认的段（与 `AirPanel` 的 `only` 联合类型同源） */
const AIR_ONLY = ['mission', 'admin', 'place', 'refit', 'airstrip', 'reduce', 'capture'] as const
/** SupplyPanel 认的段 */
const SUPPLY_ONLY = [
  'check',
  'ledger',
  'sp',
  'dumpBlow',
  'transport',
  'extender',
  'loadUnload',
] as const
/** ExclusiveRulesPanel 认的段 */
const FORT_ONLY = ['info', 'actions', 'panzer', 'security', 'hedgehog', 'marker', 'cache'] as const

type AirOnly = (typeof AIR_ONLY)[number]
type SupplyOnly = (typeof SUPPLY_ONLY)[number]
type FortOnly = (typeof FORT_ONLY)[number]

const mapView = useMapViewStore()

/** 这一枚设施此刻能做的操作（空＝不该有本会话；判据在 store） */
const options = computed(() => mapView.unitActionOptions(mapView.unitActionUnitId ?? ''))

/** 玩家挑定的那一项（null＝还在菜单；值是目标面板的段名） */
const picked = ref<string | null>(null)

// 换成另一枚 / 收会话 ⇒ 回到菜单（不把上一枚的选择带过来）
watch(
  () => mapView.unitActionUnitId,
  () => {
    picked.value = null
  },
)

/** 只有一项时省掉菜单（点它＝对它操作）；多项时用玩家挑的 */
const activeOnly = computed<string | null>(() => {
  const list = options.value
  if (list.length === 0) return null
  if (list.length === 1) return list[0]!.only
  return picked.value
})

/** 要不要先给菜单 */
const showMenu = computed(() => options.value.length > 1 && picked.value === null)
/** 已挑定且原本多项 ⇒ 给一条"返回操作清单" */
const showBack = computed(() => options.value.length > 1 && picked.value !== null)

function narrow<T extends string>(pool: readonly T[], value: string | null): T | null {
  return value !== null && (pool as readonly string[]).includes(value) ? (value as T) : null
}

const airOnly = computed<AirOnly | null>(() => narrow(AIR_ONLY, activeOnly.value))
const supplyOnly = computed<SupplyOnly | null>(() => narrow(SUPPLY_ONLY, activeOnly.value))
const fortOnly = computed<FortOnly | null>(() => narrow(FORT_ONLY, activeOnly.value))
</script>

<template>
  <!-- ① 操作菜单：这一枚设施此刻能做的事（一项都不列时不会走到这里） -->
  <div v-if="showMenu" class="ops">
    <p class="muted">这一枚设施此刻能做的事（{{ options.length }} 项，挑一项展开）：</p>
    <div class="row">
      <BaseButton
        v-for="option in options"
        :key="option.key"
        variant="secondary"
        size="sm"
        :title="`${option.rule}`"
        @click="picked = option.only"
      >
        {{ option.label }}
      </BaseButton>
    </div>
    <p class="muted">
      只列**本环节**允许的操作（判据＝规则书里对它自己可做的动作族 ∩ 本环节闸门）。
    </p>
  </div>

  <!-- ② 只展开挑定的那一段 -->
  <template v-else>
    <div v-if="showBack" class="row">
      <BaseButton variant="ghost" size="sm" @click="picked = null">← 返回操作清单</BaseButton>
    </div>
    <AirPanel v-if="mapView.unitActionFamily === 'air'" :only="airOnly" />
    <SupplyPanel v-else-if="mapView.unitActionFamily === 'supply'" :only="supplyOnly" />
    <ExclusiveRulesPanel v-else-if="mapView.unitActionFamily === 'fort'" :only="fortOnly" />
  </template>
</template>

<style scoped>
.ops {
  padding: var(--space-2);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  margin-bottom: var(--space-2);
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: var(--space-1) 0;
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-xs);
  margin: var(--space-1) 0;
}
</style>
