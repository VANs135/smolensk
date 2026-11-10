<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag, RuleNote, RuleTip, UI_COPY } from '@/components/base'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
import {
  counterImageUrlOf,
  hexLabel,
  spDumpImageUrlOf,
  useMapViewStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * **加油窗**（12.5c；用户 2026-11-10 口径更正）
 *
 * 入口：右键己方单位/堆叠 → 菜单里点**某一法**（A 编队 / B HQ 投递 / C 单单位）。
 * 菜单只列此刻真正可用的方法；本窗只做这一法的事：确认受注单位、选付款来源、付款、确认。
 *
 * 分层纪律：本组件不做任何规则计算 —— 受注单位、方法、来源候选、覆盖集、能否付款全部来自 store
 * （`fuelSubjectId → fuelTargets → fuelDumpChoices → fuelFormationCoverage → payFuel`），
 * 这里只画、只收点击。规则原文与条款号收进 `?`（面板末尾 `RuleNote`），屏上只留单位与按钮。
 */

const workbench = useWorkbenchStore()
const mapView = useMapViewStore()

/** 受注单位（右键的那一枚；会话由 `fuelSubjectId` 驱动，见 map-view 的 `sessionBase`） */
const subject = computed(
  () => workbench.units.find((unit) => unit.instanceId === workbench.fuelSubjectId) ?? null,
)

/** 这一法在本窗里只能选它（不再给"改选别的方法"——方法在右键那一刻已定） */
const method = computed(() => workbench.fuelMethod)

/** 12.5c-A：编队法的覆盖预览（来源已选时才成立；判据与付款同一处） */
const formationCoverage = computed(() =>
  method.value === 'formation' ? workbench.fuelFormationCoverage : null,
)

/** 12.5e：HQ 法在本阶段的投递基点（付款后才有；付款前提示"未投递"） */
const hqOriginLabel = computed(() => {
  if (method.value !== 'hq' || subject.value === null) return null
  const origin = workbench.hqFuelThrowOriginOf(subject.value.instanceId)
  return origin === null ? '（本阶段尚未投递）' : hexLabel(origin)
})

/** 12.3a：这一法的付款来源（store 已按受注单位与方法筛过可达性） */
const dumpItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.fuelDumpChoices.map((dump) => {
    const carrier =
      dump.carriedBy === undefined
        ? undefined
        : workbench.units.find((unit) => unit.instanceId === dump.carriedBy)
    return {
      id: dump.id,
      imageUrl: carrier === undefined ? spDumpImageUrlOf(dump) : counterImageUrlOf(carrier),
      name:
        carrier === undefined
          ? `${hexLabel(dump.hex)}（${dump.sp} SP / ${dump.t} T）`
          : `${hexLabel(dump.hex)}｜装载在 ${carrier.name} 上（${dump.sp} SP / ${dump.t} T，12.1b）`,
      selected: workbench.fuelDumpId === dump.id,
      hex: dump.hex,
    }
  }),
)

function hoverDump(id: string | null): void {
  const dump =
    id === null ? null : (workbench.fuelDumpChoices.find((item) => item.id === id) ?? null)
  workbench.setHoverHex(dump?.hex ?? null)
}

/** 已付过 ⇒ 只剩"确认并关闭"（付款已经落账，窗口不再摆一次付款按钮） */
const paid = computed(() => subject.value?.fuelled ?? false)
</script>

<template>
  <BasePanel title="加油（12.5c）">
    <p v-if="subject === null" class="muted">没有受注单位：请在堆叠里右键要加油的那一枚。</p>
    <template v-else>
      <!-- 只留单位与按钮：受注单位一行，方法名一行 -->
      <p class="num">
        <BaseTag kind="info">{{ workbench.fuelMethodLabel(method) }}</BaseTag>
        {{ subject.name }} @ {{ hexLabel(subject.hex) }}
        <template v-if="paid">
          ｜已加注（{{ workbench.fuelMethodLabel(subject.fuelMethod ?? method) }}）
        </template>
      </p>

      <template v-if="paid">
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="mapView.cancelSession()">完成</BaseButton>
        </div>
        <p v-if="formationCoverage !== null" class="num">
          本次编队付款覆盖 {{ formationCoverage.coveredIds.length }} 枚 · 来源
          {{ formationCoverage.sourceLabel }}
        </p>
        <p v-else-if="hqOriginLabel !== null" class="num">本阶段投递点：{{ hqOriginLabel }}</p>
      </template>

      <template v-else>
        <!-- 12.5c-A：这一付会覆盖谁，先讲清（来源未选时为 null，不猜） -->
        <p v-if="formationCoverage !== null" class="num">
          本次付 1 SP 将覆盖 <b>{{ formationCoverage.coveredIds.length }}</b> 枚（来源
          {{ formationCoverage.sourceLabel }}｜编队 {{ formationCoverage.formation }}）
          <RuleTip rule="12.5c-A">为一整个多单位编队支付 1 SP，便可为整个编队提供燃料。</RuleTip>
        </p>

        <!-- 12.3a：付款来源 -->
        <CounterPicker
          :title="UI_COPY.paySource"
          :hint="
            method === 'hq'
              ? '指挥部法：同一指挥部投递（12.5c-B / 12.5e）'
              : '全体同一站直取（12.3a）'
          "
          :items="dumpItems"
          :size="32"
          @pick="workbench.pickFuelDump($event)"
          @hover="hoverDump"
        />
        <p v-if="dumpItems.length === 0" class="muted">
          这一枚此刻没有可达的补给来源（12.3a）——先补出一条补给线再来。
        </p>

        <div class="row">
          <BaseButton
            variant="primary"
            size="sm"
            :disabled="workbench.fuelDumpId === null"
            @click="workbench.payFuel()"
          >
            支付燃料（{{ method === 'singleUnit' ? '1 T' : '1 SP' }}）
          </BaseButton>
        </div>
      </template>

      <div class="notes">
        <RuleNote title="燃料：三种付法与时点" rule="12.5a / 12.5c">
          <p class="muted">
            12.5a「轮式/履带**战斗单位**要消耗 MP 的话，玩家必须消耗燃料补给，否则不能消耗任何
            MP——即使就移动一格」；12.5c 三法：A 编队法付 1 SP 覆盖整个多单位编队；B 指挥部法付 1
            SP，投递范围内的独立单位一并覆盖（每阶段只能在一个位置投递，12.5e）；C 单独单位法每枚 1
            T，任何单位都可用。
          </p>
        </RuleNote>
      </div>
    </template>
  </BasePanel>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.num {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  margin: var(--space-1) 0;
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.notes {
  margin-top: var(--space-3);
}
</style>
