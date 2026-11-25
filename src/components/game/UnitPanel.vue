<script setup lang="ts">
import { computed, provide } from 'vue'

import { useMapViewStore, useWorkbenchStore } from '@/stores'
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
const FORT_ONLY = ['info', 'actions', 'panzer', 'security', 'hedgehog', 'marker'] as const

type AirOnly = (typeof AIR_ONLY)[number]
type SupplyOnly = (typeof SUPPLY_ONLY)[number]
type FortOnly = (typeof FORT_ONLY)[number]

const mapView = useMapViewStore()
const workbench = useWorkbenchStore()

/** 条 14：基地格窗户自己的标题（`AirBaseView` 不含 `name`，按算子 id 取回） */
const actionBaseTitle = computed(() => {
  const base = mapView.actionBase
  if (base === null) return ''
  const unit = workbench.units.find((item) => item.instanceId === base.id)
  return unit?.name ?? `${base.hex.col}.${base.hex.row}`
})

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
 * 2026-11-26：**一步没挑定**时列在窗里的可点选项（修前这种情形整窗空白）
 *
 * 多选项设施（运输点 C 段的 13.2c / 13.2f / 12.7a·d 三项）左键开关话时 `activeOnly` 为 null，
 * 旧模板一路 `v-else-if` 落空 ⇒ 会话框里一个字都没有。清单与右键菜单同源
 * （`mapView.unitActionMenuAt` → `counterActionsAt`），判据仍只在 store 一处。
 */
const menuOptions = computed(() => {
  const id = mapView.unitActionUnitId
  return id === null ? [] : mapView.unitActionMenuAt(id)
})

/** 点清单里某一项 ⇒ 落到它那一段（执行入口与右键菜单同一条 `applyContextAction`） */
function openSection(key: string): void {
  const id = mapView.unitActionUnitId
  if (id === null) return
  mapView.openUnitActionSectionNow(id, key)
}

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
  <!-- 条 14：基地格窗口自带标题容器（修前裸放名册，与其它窗混在一起） -->
  <section v-if="showRoster && mapView.actionBase !== null" class="roster-window">
    <h4 class="roster-window__title">空军基地 · {{ actionBaseTitle }}</h4>
    <AircraftRoster
      :key="mapView.actionBase.id"
      :base-id="mapView.actionBase.id"
      :aircraft="mapView.actionBaseAircraft"
    />
  </section>
  <!-- 2026-11-26：多选项设施（一步没挑定）⇒ 窗里列可点选项，修前这里整窗空白 -->
  <section v-else-if="menuOptions.length > 0" class="action-menu">
    <p class="action-menu__hint">挑一项展开（与右键菜单同源）：</p>
    <ul class="action-menu__list">
      <li v-for="item in menuOptions" :key="item.key">
        <button
          type="button"
          class="action-menu__item"
          :disabled="item.disabledReason !== null"
          @click="openSection(item.key)"
        >
          <span class="action-menu__label">{{ item.label }}</span>
          <span v-if="item.disabledReason !== null" class="action-menu__why num">
            {{ item.disabledReason }}
          </span>
        </button>
      </li>
    </ul>
  </section>
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
  <p v-else class="action-menu__empty">这个设施本环节没有可执行的操作。</p>
</template>

<style scoped>
.roster-window {
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  background: var(--color-bg-2);
}
.roster-window__title {
  margin: 0 0 var(--space-2);
  color: var(--color-ink);
  font-size: var(--text-sm);
}
/* 2026-11-26：多选项设施的选项清单（会话窗内唯一的落点，修前这里空白） */
.action-menu__hint {
  margin: 0 0 var(--space-1);
  color: var(--color-muted);
  font-size: var(--text-xs);
}
.action-menu__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: var(--space-1);
}
.action-menu__item {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-ink);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}
.action-menu__item:disabled {
  cursor: not-allowed;
  color: var(--color-muted);
}
.action-menu__why {
  color: var(--color-warning);
  font-size: var(--text-xs);
}
.action-menu__empty {
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-sm);
}
</style>
