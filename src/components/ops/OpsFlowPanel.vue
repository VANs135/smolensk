<script setup lang="ts">
import { computed } from 'vue'

import { AirPanel } from '@/components/air'
import { BaseButton, BasePanel, BaseTag, RuleTip } from '@/components/base'
import { SessionStep } from '@/components/session'
import OpsLossPicker from '@/components/ops/OpsLossPicker.vue'
import { counterImageUrlOf, hexLabel, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * 2026-11-13：空军不再有独立的「选参战机」步。
 *   右键定好任务类型与目标格后，第 1 张卡就是 `AirPanel` 的「选飞机发起任务」
 *   （选机 + 任务格 + 任务输入 + 发起，全在一张卡里）。
 *   本组件只剩炮击的三步，以及空军任务链（`air:*`）的容器。
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

/** 第 1 步是否已选到参战单位（炮击） */
const picked = computed(() => {
  const current = flow.value
  if (current === null) return false
  return workbench.barrageUnitIds.length > 0
})

/** 炮击错误：中文行（不显示引擎 reason 代码） */
const barrageErrorLine = computed(() => workbench.barrageErrorLine)

/**
 * 空军第 2 步的容器：任务链的门 id 都是 `air:*`（与 `AirPanel` 同一份 store 投影）
 *
 * 面板不自己判 `flow.step`，只问"当前暴露的事项属不属于任务链"。
 */
const airMissionActive = computed(() => map.sessionStep?.id.startsWith('air:') === true)

/** 用户 2026-11-13：空军按三面板推进（① 选飞机发起 → ② 结算任务 → ③ 返航） */
const airStage = computed<1 | 2 | 3>(() => {
  const step = workbench.airState?.step
  if (step === 'returnToBase') return 3
  if (step === 'resolveMission') return 2
  return 1
})

/** 炮击第 2 步的付款来源（地图上高亮的那几座站） */
const supplyDumps = computed(() => workbench.barrageSupplyMapDumps)

/** 炮击第 2 步：本次成本与初始列 */
const supplyCostT = computed(() => workbench.barrageSummary?.costT ?? 0)

function isPickedBarrage(id: string): boolean {
  return workbench.barrageUnitIds.includes(id)
}

function setTargetKind(kind: string): void {
  if (kind === 'combatUnits' || kind === 'airBase') workbench.setBarrageTargetKind(kind)
}
</script>

<template>
  <BasePanel v-if="flow !== null" :title="TITLES[flow.kind]">
    <p class="ops__steps num">
      <template v-if="flow.kind !== 'barrage'">
        <BaseTag :kind="airStage === 1 ? 'info' : 'success'">① 选飞机发起任务</BaseTag>
        <span class="ops__arrow">→</span>
        <BaseTag :kind="airStage === 2 ? 'info' : airStage > 2 ? 'success' : 'neutral'">
          ② 结算任务
        </BaseTag>
        <span class="ops__arrow">→</span>
        <BaseTag :kind="airStage === 3 ? 'info' : 'neutral'">③ 返航</BaseTag>
      </template>
      <template v-else>
        <BaseTag :kind="flow.step === 1 ? 'info' : 'success'">① 选单位</BaseTag>
        <span class="ops__arrow">→</span>
        <BaseTag :kind="flow.step === 2 ? 'info' : 'neutral'">② 支付补给（10.1b）</BaseTag>
        <template v-if="workbench.barrageTargetKind !== 'airBase'">
          <span class="ops__arrow">→</span>
          <BaseTag :kind="flow.step === 3 ? 'info' : 'neutral'">③ 受损单位</BaseTag>
        </template>
      </template>
      <span class="muted">｜目标 {{ hexLabel(flow.targetHex) }}</span>
    </p>

    <!-- ───────── 炮击：第 1 步 选炮兵 ───────── -->
    <SessionStep item="ops:barrage:units">
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
    </SessionStep>

    <!-- ───────── 炮击：第 2 步 支付补给 ───────── -->
    <SessionStep item="ops:barrage:supply">
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
    </SessionStep>

    <!-- ───────── 炮击：第 3 步 选受损单位（与空军轰炸共用同一块） ───────── -->
    <SessionStep item="ops:barrage:loss">
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
    </SessionStep>

    <!-- ───────── 空军：任务链（选机发起 / 拦截 / 空战 / 结算 / 返航，全部在 AirPanel 内） ───────── -->
    <AirPanel v-if="airMissionActive" only="mission" />
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
  font-size: var(--text-xs);
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
  font-size: var(--text-xs);
}

.ops__actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
</style>
