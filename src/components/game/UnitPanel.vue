<script setup lang="ts">
import { computed, provide } from 'vue'

import { useMapViewStore } from '@/stores'
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
 * ★ 动作入口只剩**右键菜单**（`facilityActionKeysNow` ∩ 本环节闸门）；左键只做"选中 / 看信息"：
 *   设施左键不再弹操作菜单；非设施的单一动作仍沿用 `mapView.unitActionOptions(instanceId)`
 *   的"只有一项时省掉菜单"口径（值随每项给出规则号，组件**不自己拼规则号或阶段名**）。
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

/**
 * 挑定的那一段（值是目标面板的段名）
 *
 * 左键只做"选中 / 看信息"：动作一律从**右键菜单**挑，挑中后经 `unitActionIntent` 落到这里；
 * 非设施的单一动作（13.2f 装卸等）仍沿用"只有一项时省掉菜单"的口径。
 */
const activeOnly = computed<string | null>(() => {
  if (mapView.unitActionIntent !== null) return mapView.unitActionIntent.only
  // 基地左键＝看驻机名册（信息），不自动展开动作段
  if (mapView.actionBase !== null) return null
  const list = options.value
  if (list.length !== 1) return null
  return list[0]!.only
})

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

/**
 * U1-b：本会话自己的待决事项＝收窄后的**一段**（左键不再有"能做什么"的菜单）。
 * 子面板（`AirPanel` / `SupplyPanel` / `ExclusiveRulesPanel`）各自已经只画一段，
 * 这里把门放行（`null` ⇒ `<SessionStep>` 全部通过），避免把子面板自己的步骤也按 `unit:actions` 遮住。
 */
provide(
  SESSION_STEP_GATE,
  computed(() => null),
)
</script>

<template>
  <!-- 只展开挑定的那一段：左键不再给操作菜单（动作从右键菜单挑） -->
  <AircraftRoster
    v-if="showRoster && mapView.actionBase !== null"
    :key="mapView.actionBase.id"
    :base-id="mapView.actionBase.id"
    :aircraft="mapView.actionBaseAircraft"
  />
  <template v-else-if="activeOnly !== null">
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

<style scoped></style>
