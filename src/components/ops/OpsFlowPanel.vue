<script setup lang="ts">
import { computed } from 'vue'

import { AirPanel } from '@/components/air'
import { BaseButton, BasePanel, BaseTag, RuleTip } from '@/components/base'
import { counterImageUrlOf, hexLabel, useMapViewStore, useWorkbenchStore } from '@/stores'
import OpsLossPicker from './OpsLossPicker.vue'

/**
 * 三操作统一流程（2026-11-10 规格；炮击链路 2026-11-12 重做）
 *
 * 炮击（用户定的 7 步）：
 *   ① 右键敌方堆叠/设施 →「炮击」→ 只列**射程覆盖目标格**的炮兵；点选时地图同步高亮。
 *   ② 确认单位 → 支付补给（10.1b）：地图高亮可用补给站并显示 SP 数，点站支付。
 *   ③ 确认支付后**自动走完**横移 / 掷骰 / 结算（地形按对防守方最有利自动取）。
 *   ④ 若造成军力损失，列出目标格内的单位由玩家选受损者；选完本次炮击结束。
 *   ⑤ 目标为设施时按 10.0c 设施表结算（基地降级、基地内飞机受损）。
 *
 * 空军（轰炸 / 低空扫射）仍走既有空军任务链：第 1 步选机，第 2 步交给 `AirPanel`。
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

/** 10.0d / 10.0c：该格可宣布的整体目标（有敌战斗单位→单位；有敌空军基地→基地） */
const targetKindChoices = computed<readonly { key: 'combatUnits' | 'airBase'; label: string }[]>(
  () =>
    workbench.barrageTargetKindChoicesAt.map((key) => ({
      key,
      label: key === 'airBase' ? '空军基地（10.0c）' : '战斗单位（10.0a）',
    })),
)

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

/** 第 1 步是否已选到参战单位 */
const picked = computed(() => {
  const current = flow.value
  if (current === null) return false
  return current.kind === 'barrage'
    ? workbench.barrageUnitIds.length > 0
    : workbench.airMissionAirIds.length > 0
})

/** 炮击错误：中文行（不显示引擎 reason 代码） */
const barrageErrorLine = computed(() => workbench.barrageErrorLine)

/** 空军错误（既有形状） */
const airError = computed(() => workbench.airError)
const airErrorLine = computed(() => workbench.airErrorLine)

/** 炮击第 2 步的付款来源（地图上高亮的那几座站） */
const supplyDumps = computed(() => workbench.barrageSupplyMapDumps)

/** 炮击第 2 步：本次成本与初始列 */
const supplyCostT = computed(() => workbench.barrageSummary?.costT ?? 0)

/**
 * 空军轰炸的**战果待分损失**（K4）
 *
 * 空军轰炸复用炮兵的 `barrageState` 战果链；一旦需要目标方选受损单位，
 * 自动连跑会停在战果步 ⇒ 第 2 步必须把同一个共用损失分配块摆出来。
 */
const airLossPending = computed(() => {
  const current = flow.value
  const barrage = workbench.barrageState
  return (
    current !== null &&
    current.kind !== 'barrage' &&
    barrage !== null &&
    barrage.kind === 'air' &&
    !barrage.finished &&
    workbench.barrageLossRequired > 0
  )
})

function isPickedBarrage(id: string): boolean {
  return workbench.barrageUnitIds.includes(id)
}

function isPickedAir(id: string): boolean {
  return workbench.airMissionAirIds.includes(id)
}

function setTargetKind(kind: string): void {
  if (kind === 'combatUnits' || kind === 'airBase') workbench.setBarrageTargetKind(kind)
}
</script>

<template>
  <BasePanel v-if="flow !== null" :title="TITLES[flow.kind]">
    <p class="ops__steps num">
      <BaseTag :kind="flow.step === 1 ? 'info' : 'success'">① 选单位</BaseTag>
      <span class="ops__arrow">→</span>
      <BaseTag :kind="flow.step === 2 ? 'info' : 'neutral'">
        {{ flow.kind === 'barrage' ? '② 支付补给（10.1b）' : '② 空战 / 防空（14.2f）' }}
      </BaseTag>
      <template v-if="flow.kind === 'barrage' && workbench.barrageTargetKind !== 'airBase'">
        <span class="ops__arrow">→</span>
        <BaseTag :kind="flow.step === 3 ? 'info' : 'neutral'">③ 受损单位</BaseTag>
      </template>
      <span class="muted">｜目标 {{ hexLabel(flow.targetHex) }}</span>
    </p>

    <!-- ───────── 炮击：第 1 步 选炮兵 ───────── -->
    <template v-if="flow.kind === 'barrage' && flow.step === 1">
      <label v-if="targetKindChoices.length > 1" class="field num">
        整体目标（10.0d：宣布后只能用于该目标）
        <select
          class="select"
          :value="workbench.barrageTargetKind"
          @change="setTargetKind(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="item in targetKindChoices" :key="item.key" :value="item.key">
            {{ item.label }}
          </option>
        </select>
      </label>
      <p class="muted num">
        只列<b>射程覆盖该格</b>且本阶段还没炮击过的炮兵（10.1a / 10.0e-B）。
        <RuleTip rule="10.1b">付不出补给的炮击不会出现在右键菜单里。</RuleTip>
      </p>
      <div class="ops__grid">
        <button
          v-for="unit in barrageItems"
          :key="unit.instanceId"
          type="button"
          class="ops__unit num"
          :class="{ 'ops__unit--on': isPickedBarrage(unit.instanceId) }"
          :title="`${unit.name}｜轰炸值 ${unit.raw.barrage ?? 0}｜射程 ${unit.raw.range ?? '—'}`"
          @click="workbench.toggleBarrageUnit(unit.instanceId)"
        >
          <img :src="counterImageUrlOf(unit) ?? ''" class="ops__img" alt="" />
        </button>
      </div>
      <p v-if="barrageItems.length === 0" class="muted">本环节没有能打到该格的炮兵。</p>

      <p v-if="barrageErrorLine !== null" class="warn num">
        <BaseTag kind="danger">{{ workbench.barrageError?.rule }}</BaseTag>
        {{ barrageErrorLine }}
      </p>

      <div class="ops__actions">
        <BaseButton :disabled="!picked" @click="map.advanceOpsFlow()">确认单位</BaseButton>
        <BaseButton variant="secondary" @click="map.cancelOpsFlow()">取消本次</BaseButton>
      </div>
    </template>

    <!-- ───────── 炮击：第 2 步 支付补给 ───────── -->
    <template v-else-if="flow.kind === 'barrage' && flow.step === 2">
      <p class="muted num">
        在<b>地图上点一座高亮的补给站</b>支付（12.3a / 10.1b）。本场成本
        <b>{{ supplyCostT }} T</b>（取初始列；多门齐射须同一指挥部或同一补给站）。
      </p>
      <p v-if="supplyDumps.length === 0" class="warn num">
        没有能覆盖本次参战火炮的补给站（12.3a）⇒
        无法支付，点「取消本次」结束本次炮击（10.1b：无惩罚，不视为已轰炸）。
      </p>
      <p v-else class="num">
        可付款的站：{{
          supplyDumps.map((item) => `${hexLabel(item.dump.hex)}（${item.label}）`).join('、')
        }}
      </p>
      <p v-if="workbench.barrageSupplyDump !== null" class="ok num">
        已选：{{ hexLabel(workbench.barrageSupplyDump.hex) }}（
        {{ workbench.barrageSupplyDump.sp }} SP{{
          workbench.barrageSupplyDump.t > 0 ? ` + ${workbench.barrageSupplyDump.t} T` : ''
        }}）
      </p>

      <p v-if="barrageErrorLine !== null" class="warn num">
        <BaseTag kind="danger">{{ workbench.barrageError?.rule }}</BaseTag>
        {{ barrageErrorLine }}
      </p>

      <div class="ops__actions">
        <BaseButton
          :disabled="workbench.barrageSupplyDump === null"
          @click="map.confirmOpsBarrageSupply()"
        >
          确认支付
        </BaseButton>
        <BaseButton variant="secondary" @click="map.cancelOpsFlow()">取消本次</BaseButton>
      </div>
    </template>

    <!-- ───────── 炮击：第 3 步 选受损单位（与空军轰炸共用同一块） ───────── -->
    <template v-else-if="flow.kind === 'barrage' && flow.step === 3">
      <OpsLossPicker />

      <p v-if="barrageErrorLine !== null" class="warn num">
        <BaseTag kind="danger">{{ workbench.barrageError?.rule }}</BaseTag>
        {{ barrageErrorLine }}
      </p>

      <div class="ops__actions">
        <BaseButton :disabled="!workbench.barrageLossReady" @click="map.confirmOpsBarrageLoss()">
          确认受损
        </BaseButton>
        <BaseButton variant="secondary" @click="map.cancelOpsFlow()">取消（退回）</BaseButton>
      </div>
    </template>

    <!-- ───────── 空军：第 1 步 选机 ───────── -->
    <template v-else-if="flow.step === 1">
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
            <BaseTag kind="neutral">
              {{ item.distanceToTarget === null ? '—' : item.distanceToTarget }} /
              {{ item.air.rangeHexes }}
            </BaseTag>
          </button>
        </div>
      </div>
      <p v-if="airGroups.length === 0" class="muted">没有能执行该任务的飞机。</p>

      <p v-if="airErrorLine !== null" class="warn num">
        <BaseTag kind="danger">{{ airError?.rule }}</BaseTag>
        {{ airErrorLine }}
      </p>

      <div class="ops__actions">
        <BaseButton :disabled="!picked" @click="map.advanceOpsFlow()">下一步</BaseButton>
        <BaseButton variant="secondary" @click="map.cancelOpsFlow()">取消</BaseButton>
      </div>
    </template>

    <!-- ───────── 空军：第 2 步 空战 / 防空 / 战果（含受损分担） ───────── -->
    <template v-else>
      <AirPanel only="mission" />
      <!-- K4：空军轰炸需要目标方选受损单位时，用与炮击第 3 步**同一块**界面 -->
      <template v-if="airLossPending">
        <hr />
        <OpsLossPicker />
        <div class="ops__actions">
          <BaseButton :disabled="!workbench.barrageLossReady" @click="map.confirmOpsAirLoss()">
            确认受损并继续
          </BaseButton>
        </div>
      </template>
      <div class="ops__actions">
        <!-- K15：这一步只收起面板，任务并未取消（宣布后不可撤回，14.2b） -->
        <BaseButton variant="secondary" @click="map.cancelOpsFlow()">
          收起面板（任务继续）
        </BaseButton>
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
