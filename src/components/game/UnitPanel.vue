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
 * 按所点单位的类型（`mapView.unitActionFamily`）分派到**既有**面板：
 *   · supply（sp / supply_point / 运输点 / 有机卡车 / 延补队）⇒ `SupplyPanel only="ledger"`
 *     （SP 拖取 / 运输点装卸 / 延补队，9.14 / 13.2）
 *   · air（空军基地）⇒ `AirPanel`，**按挑定的操作只渲染那一段**
 *   · fort（工事 hedgehog）⇒ `ExclusiveRulesPanel only="actions"`（16.0b 工事）
 *
 * ★ 用户 2026-10-25「**一个操作一个面板**、不要什么都糅杂在一起」：
 *   点开一枚设施后先给**它此刻能做的几项操作**（来源＝`mapView.unitActionOptions`，
 *   判据＝设施动作族 ∩ 本环节闸门，规则号随行；见 `facilityActionKeys` 的逐条原文），
 *   挑定一项才展开对应的那一段 —— 不再把整块面板（含本环节用不到的段）一次铺开。
 *   只有一项时省掉菜单（直接展开那一段）。
 *
 * 分层纪律（CODE_SPEC）：本组件**只做分派、不算规则** —— 各面板自身仍是唯一的事实来源。
 */

type AirOnly = 'place' | 'refit' | 'airstrip' | 'reduce' | 'capture'

const mapView = useMapViewStore()

/** 这一枚设施此刻能做的操作（空＝不该有本会话；判据在 store） */
const options = computed(() => mapView.unitActionOptions(mapView.unitActionUnitId ?? ''))

/** 空军基地的操作（`panel === 'air'`） */
const airOptions = computed(() => options.value.filter((item) => item.panel === 'air'))

/** 玩家挑定的那一项（null＝还在菜单） */
const picked = ref<string | null>(null)

// 换成另一枚 / 收会话 ⇒ 回到菜单（不把上一枚的选择带过来）
watch(
  () => mapView.unitActionUnitId,
  () => {
    picked.value = null
  },
)

/** 要渲染的空军段：只有一项时直接用那一项；多项时用玩家挑的 */
const airOnly = computed<AirOnly | null>(() => {
  const only = airOptions.value.length === 1 ? airOptions.value[0]?.only : picked.value
  if (only === 'place' || only === 'refit' || only === 'airstrip' || only === 'reduce') return only
  if (only === 'capture') return 'capture'
  return null
})

/** 已挑定且原本是多项 ⇒ 给一条"返回操作清单" */
const showBack = computed(() => airOptions.value.length > 1 && picked.value !== null)
</script>

<template>
  <SupplyPanel v-if="mapView.unitActionFamily === 'supply'" only="ledger" />

  <template v-else-if="mapView.unitActionFamily === 'air'">
    <!-- ① 操作菜单：这个基地此刻能做的事（一项都不列时不会走到这里） -->
    <div v-if="airOptions.length > 1 && picked === null" class="ops">
      <p class="muted">这个空军基地此刻能做的事（{{ airOptions.length }} 项，挑一项展开）：</p>
      <div class="row">
        <BaseButton
          v-for="option in airOptions"
          :key="option.key"
          variant="secondary"
          size="sm"
          @click="picked = option.only"
        >
          {{ option.label }}
        </BaseButton>
      </div>
      <p class="muted">
        只列**本环节**允许的操作（15.1 整备在 A 段；15.3 修建与 15.4 缩减在移动阶段）。
      </p>
    </div>

    <!-- ② 只展开挑定的那一段 -->
    <template v-else>
      <div v-if="showBack" class="row">
        <BaseButton variant="ghost" size="sm" @click="picked = null">← 返回操作清单</BaseButton>
      </div>
      <AirPanel :only="airOnly" />
    </template>
  </template>

  <ExclusiveRulesPanel v-else-if="mapView.unitActionFamily === 'fort'" only="actions" />
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
