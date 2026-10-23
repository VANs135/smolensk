<script setup lang="ts">
import { useMapViewStore } from '@/stores'
import { AirPanel } from '@/components/air'
import { ExclusiveRulesPanel } from '@/components/exclusive'
import { SupplyPanel } from '@/components/supply'

/**
 * 条 12（M2）+ 条 13/19（批 A）：**点非战斗单位开的动作会话**（`MapSessionKind:'unit'`）
 *
 * 按所点单位的类型（`mapView.unitActionFamily`）分派到**既有**面板：
 *   · supply（sp / supply_point / 运输点 / 有机卡车 / 延补队）⇒ `SupplyPanel only="ledger"`
 *     （SP 拖取 / 运输点装卸 / 延补队，9.14 / 13.2）
 *   · air（空军基地）⇒ **完整 `AirPanel`**（admin＋mission 两段）
 *   · fort（工事 hedgehog）⇒ `ExclusiveRulesPanel only="actions"`（16.0b 工事）
 *
 * 这些原是右栏的**可写**面板；本条把它们收进会话，落实「右栏只读」。
 * 分层纪律（CODE_SPEC）：本组件**只做分派、不算规则** —— 各面板自身仍是唯一的事实来源。
 *
 * ★ 批 A：空军基地渲染**完整** AirPanel（不传 `only`）——既保留 admin 事务段（摆放/整备/修建/缩减/夺取），
 *   又给出 mission 选机入口（`missionJoinItems`）：玩家在此勾选参战机 ⇒ `airMissionAirIds>0` ⇒
 *   路由器随即切到 `air`(mission) 会话续跑（点地面格定任务格 → 选任务类型 → `runAirMissionNow`）。
 *   这同时补上了批 M 把空军基地点击从「小窗展开选机」改路由到本会话后，任务选机入口一度被遮的缺口。
 */
const mapView = useMapViewStore()
</script>

<template>
  <SupplyPanel v-if="mapView.unitActionFamily === 'supply'" only="ledger" />
  <AirPanel v-else-if="mapView.unitActionFamily === 'air'" />
  <ExclusiveRulesPanel v-else-if="mapView.unitActionFamily === 'fort'" only="actions" />
</template>
