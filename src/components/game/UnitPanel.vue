<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'

import { useMapViewStore } from '@/stores'
import { BaseButton, BaseTag } from '@/components/base'
import { AirPanel } from '@/components/air'
import AircraftRoster from '@/components/air/AircraftRoster.vue'
import { ContainersPanel } from '@/components/containers'
import { ExclusiveRulesPanel } from '@/components/exclusive'
import { SESSION_STEP_GATE } from '@/components/session'
import { SupplyPanel } from '@/components/supply'
import CounterOrderPanel from './CounterOrderPanel.vue'

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
  () => [mapView.unitActionUnitId, mapView.unitActionIntent?.key],
  () => {
    picked.value = null
  },
)

/** 只有一项时省掉菜单（点它＝对它操作）；多项时用玩家挑的 */
const activeOnly = computed<string | null>(() => {
  if (mapView.unitActionIntent !== null) return mapView.unitActionIntent.only
  if (mapView.actionBase !== null) return picked.value
  const list = options.value
  if (list.length === 0) return null
  if (list.length === 1) return list[0]!.only
  return picked.value
})

/** 要不要先给菜单 */
const showMenu = computed(
  () =>
    mapView.unitActionIntent === null &&
    (options.value.length > 1 || mapView.actionBase !== null) &&
    picked.value === null,
)
/** 已挑定且原本多项 ⇒ 给一条"返回操作清单" */
const showBack = computed(() => options.value.length > 1 && picked.value !== null)

function narrow<T extends string>(pool: readonly T[], value: string | null): T | null {
  return value !== null && (pool as readonly string[]).includes(value) ? (value as T) : null
}

const airOnly = computed<AirOnly | null>(() => narrow(AIR_ONLY, activeOnly.value))
const supplyOnly = computed<SupplyOnly | null>(() => narrow(SUPPLY_ONLY, activeOnly.value))
const fortOnly = computed<FortOnly | null>(() => narrow(FORT_ONLY, activeOnly.value))
const orderOnly = computed(() =>
  narrow(['railGauge', 'railMove', 'breakdown'] as const, activeOnly.value),
)
const showRoster = computed(
  () => mapView.actionBase !== null && (activeOnly.value === null || activeOnly.value === 'refit'),
)
const menuOptions = computed(() =>
  mapView.actionBase === null
    ? options.value
    : options.value.filter((option) => option.only !== 'refit'),
)

/**
 * U1-b：本会话自己的待决事项＝上方那张"能做什么"的菜单（或多段收窄后的**一段**）。
 * 子面板（`AirPanel` / `SupplyPanel` / `ExclusiveRulesPanel`）各自已经只画一段，
 * 这里把门放行（`null` ⇒ `<SessionStep>` 全部通过），避免把子面板自己的步骤也按 `unit:actions` 遮住。
 */
provide(
  SESSION_STEP_GATE,
  computed(() => null),
)
</script>

<template>
  <!-- ① 操作菜单：这一枚设施此刻能做的事（一项都不列时不会走到这里） -->
  <div v-if="showMenu && menuOptions.length > 0" class="ops">
    <div class="row">
      <BaseButton
        v-for="option in menuOptions"
        :key="option.key"
        variant="secondary"
        size="sm"
        :title="`${option.rule}`"
        @click="picked = option.only"
      >
        {{ option.label.split('（')[0] }} <BaseTag kind="neutral">{{ option.rule }}</BaseTag>
      </BaseButton>
    </div>
  </div>

  <!-- ② 只展开挑定的那一段 -->
  <AircraftRoster
    v-if="showRoster && mapView.actionBase !== null"
    :key="mapView.actionBase.id"
    :base-id="mapView.actionBase.id"
    :aircraft="mapView.actionBaseAircraft"
  />
  <template v-else-if="!showMenu">
    <div v-if="showBack" class="row">
      <BaseButton variant="ghost" size="sm" @click="picked = null">← 返回操作清单</BaseButton>
    </div>
    <CounterOrderPanel
      v-if="orderOnly !== null"
      :key="`${mapView.unitActionUnitId}:${orderOnly}`"
      :order="orderOnly"
    />
    <ContainersPanel
      v-else-if="activeOnly === 'formation'"
      only="actions"
      :subject-id="mapView.unitActionUnitId"
    />
    <AirPanel
      v-else-if="mapView.unitActionFamily === 'air'"
      :only="airOnly"
      :base-id="mapView.actionBase?.id"
    />
    <SupplyPanel
      v-else-if="mapView.unitActionFamily === 'supply'"
      :only="supplyOnly"
      :subject-id="mapView.unitActionUnitId"
      :subject-hex="mapView.unitActionHex"
    />
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
</style>
