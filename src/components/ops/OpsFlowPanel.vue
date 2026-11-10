<script setup lang="ts">
import { computed } from 'vue'

import { AirPanel } from '@/components/air'
import { BarragePanel } from '@/components/barrage'
import { BaseButton, BasePanel, BaseTag, RuleTip } from '@/components/base'
import { counterImageUrlOf, hexLabel, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * 三操作统一流程（2026-11-10 规格）
 *
 * 骨架固定为三段，三个操作共用同一个窗：
 *   ① 选参战单位（炮击＝射程覆盖目标格的炮兵；空军＝按基地分组、含地图外盒、只列出动得了的）
 *   ② 分叉步（炮击＝补给 10.1b；空军＝空战 / 拦截 / 防空 14.2f）
 *   ③ 结算（10.0a 损失 / DG，或空军任务收束）
 *
 * 第 2/3 步直接复用 `BarragePanel` / `AirPanel`：规则计算全在引擎/store，本组件**不写规则**，
 * 只负责第 1 步的候选呈现与「下一步」把球交给既有状态机（`advanceOpsFlow`）。
 */
const map = useMapViewStore()
const workbench = useWorkbenchStore()

const flow = computed(() => map.opsFlow)

const TITLES = {
  barrage: '炮击（10.1）',
  bombing: '轰炸（10.2）',
  hipShoot: '低空扫射（14.7d）',
} as const

/** 炮击第 1 步：能打到这一格的炮兵（与右键入口同一函数；已炸过的本阶段剔除） */
const barrageItems = computed(() => {
  const current = flow.value
  if (current === null || current.kind !== 'barrage') return []
  return workbench
    .barrageCandidatesAt(current.targetHex)
    .filter((unit) => !workbench.barragePhaseLedger.unitIds.includes(unit.instanceId))
})

/** 空军第 1 步：按基地分组（含地图外盒），只留**候选函数给出的**那批（与右键同源） */
const airGroups = computed(() => {
  const current = flow.value
  if (current === null || current.kind === 'barrage') return []
  const allowed = new Set(
    (current.kind === 'bombing'
      ? workbench.bombingCandidatesAt(current.targetHex)
      : workbench.hipShootCandidatesAt(current.targetHex)
    ).map((air) => air.instanceId),
  )
  return workbench.airMissionBaseGroupsWithBox
    .map((group) => ({
      ...group,
      aircraft: group.aircraft.filter((item) => allowed.has(item.air.instanceId)),
    }))
    .filter((group) => group.aircraft.length > 0)
})

const step2Title = computed(() =>
  flow.value?.kind === 'barrage' ? '补给（10.1b）' : '空战 / 防空（14.2f）',
)

/** 第 1 步是否已选到参战单位 */
const picked = computed(() => {
  const current = flow.value
  if (current === null) return false
  return current.kind === 'barrage'
    ? workbench.barrageUnitIds.length > 0
    : workbench.airMissionAirIds.length > 0
})

const errorLine = computed(() => {
  const current = flow.value
  if (current === null) return null
  return current.kind === 'barrage' ? workbench.barrageError : workbench.airError
})

function isPickedBarrage(id: string): boolean {
  return workbench.barrageUnitIds.includes(id)
}

function isPickedAir(id: string): boolean {
  return workbench.airMissionAirIds.includes(id)
}
</script>

<template>
  <BasePanel v-if="flow !== null" :title="TITLES[flow.kind]">
    <p class="ops__steps num">
      <BaseTag :kind="flow.step === 1 ? 'info' : 'success'">① 选单位</BaseTag>
      <span class="ops__arrow">→</span>
      <BaseTag :kind="flow.step === 2 ? 'info' : 'neutral'">② {{ step2Title }}</BaseTag>
      <span class="ops__arrow">→</span>
      <BaseTag kind="neutral">③ 结算</BaseTag>
      <span class="muted">｜目标 {{ hexLabel(flow.targetHex) }}</span>
    </p>

    <!-- ───────── 第 1 步：选参战单位 ───────── -->
    <template v-if="flow.step === 1">
      <template v-if="flow.kind === 'barrage'">
        <p class="muted num">
          炮击（10.1a）
          <RuleTip rule="10.1b">
            只列**射程覆盖目标格**且本阶段还没炸过的炮兵（10.1a）；付不出 10.1b
            的补给时这一项不会出现。
          </RuleTip>
        </p>
        <div class="ops__grid">
          <button
            v-for="unit in barrageItems"
            :key="unit.instanceId"
            type="button"
            class="ops__unit num"
            :class="{ 'ops__unit--on': isPickedBarrage(unit.instanceId) }"
            :title="`${unit.name}｜轰炸值 ${unit.raw.barrage ?? 0}`"
            @click="workbench.toggleBarrageUnit(unit.instanceId)"
          >
            <img :src="counterImageUrlOf(unit) ?? ''" class="ops__img" alt="" />
            <span>{{ unit.name }}</span>
            <BaseTag kind="neutral">炸 {{ unit.raw.barrage ?? 0 }}</BaseTag>
          </button>
        </div>
        <p v-if="barrageItems.length === 0" class="muted">本环节没有能打到该格的炮兵。</p>
      </template>

      <template v-else>
        <p class="muted num">
          {{ flow.kind === 'bombing' ? '轰炸（10.2b）' : '低空扫射（14.7d）' }}
          <RuleTip :rule="flow.kind === 'bombing' ? '10.2' : '14.7d'">
            {{
              flow.kind === 'bombing'
                ? '只列能执行轰炸的飞机（10.2b）；空军轰炸不消耗补给（10.2c）。'
                : '只列具备低空扫射能力、航程够得到的飞机（14.7d / 14.1a）。'
            }}
          </RuleTip>
        </p>
        <div v-for="group in airGroups" :key="group.baseId" class="ops__group">
          <p class="ops__group-head num">
            <span>{{
              group.baseId === '__offmap_air_box__' ? '地图外空军盒' : hexLabel(group.hex)
            }}</span>
            <BaseTag :kind="group.isAirstrip ? 'warning' : 'info'">
              {{
                group.baseId === '__offmap_air_box__'
                  ? '盒内出击'
                  : group.isAirstrip
                    ? '简易机场'
                    : `${group.level} 级`
              }}
            </BaseTag>
          </p>
          <div class="ops__grid">
            <button
              v-for="item in group.aircraft"
              :key="item.air.instanceId"
              type="button"
              class="ops__unit num"
              :class="{ 'ops__unit--on': isPickedAir(item.air.instanceId) }"
              :title="`${item.air.name}｜到任务格 ${
                item.distanceToTarget === null ? '—' : item.distanceToTarget
              } 格 / 航程 ${item.air.rangeHexes}`"
              @click="workbench.toggleAirMissionUnit(item.air.instanceId)"
            >
              <img :src="counterImageUrlOf(item.air) ?? ''" class="ops__img" alt="" />
              <span>{{ item.air.name }}</span>
              <BaseTag kind="neutral">
                {{ item.distanceToTarget === null ? '—' : item.distanceToTarget }} /
                {{ item.air.rangeHexes }}
              </BaseTag>
            </button>
          </div>
        </div>
        <p v-if="airGroups.length === 0" class="muted">没有能执行该任务的飞机。</p>
      </template>

      <p v-if="errorLine !== null" class="warn num">
        <BaseTag kind="danger">{{ errorLine.rule }}</BaseTag>
        {{ errorLine.reason }}
      </p>

      <div class="ops__actions">
        <BaseButton :disabled="!picked" @click="map.advanceOpsFlow()">下一步</BaseButton>
        <BaseButton variant="secondary" @click="map.cancelOpsFlow()">取消</BaseButton>
      </div>
    </template>

    <!-- ───────── 第 2/3 步：分叉与结算（复用既有面板） ───────── -->
    <template v-else>
      <BarragePanel v-if="flow.kind === 'barrage'" />
      <AirPanel v-else only="mission" />
      <div class="ops__actions">
        <BaseButton variant="secondary" @click="map.cancelOpsFlow()">取消本次</BaseButton>
      </div>
    </template>
  </BasePanel>
</template>

<style scoped>
.ops__steps {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0 0 8px;
}

.ops__arrow {
  opacity: 0.6;
}

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

.ops__group {
  margin: 8px 0;
}

.ops__group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 4px;
  font-weight: 600;
}

.ops__actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
</style>
