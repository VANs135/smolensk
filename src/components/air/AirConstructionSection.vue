<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'

import { BaseButton, BaseTag, RuleNote } from '@/components/base'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
import UiField from '@/components/UiField.vue'
import { counterImageUrlOf, hexLabel, useWorkbenchStore } from '@/stores'

/**
 * 15.3 / 15.2A：空军基地与简易机场的修建段（从 `AirPanel` 拆出）
 *
 * 2026-11-26 用户口径「右键菜单一个操作一个窗口」：
 *   15.3 基地 / 15.2A 修简易机场 / 15.2A 升格是三个菜单项，共进一扇窗；
 *   本段按 store 的 `airConstructionTask` **只画选中的那一条**（验证页 `page` 才全铺）。
 * 拆成独立组件的另一半原因：`AirPanel` 已顶到 `max-lines` 上限（见 `defender-display.ts` 的同款处理）。
 */
const props = withDefaults(defineProps<{ page?: boolean }>(), { page: false })

const workbench = useWorkbenchStore()

const task = computed(() => workbench.airConstructionTask)
const showBaseBuild = computed(() => props.page || task.value === 'baseBuild')
const showAirstripBuild = computed(() => props.page || task.value === 'airstripBuild')
const showUpgrade = computed(() => props.page || task.value === 'airstripUpgrade')

/** 施工工程兵（13.8d）：候选由引擎的工程能力判定给（`engineerChoices`） */
const engineerItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.engineerChoices.map((unit) => ({
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name: `${unit.name}（RE ${unit.re}）@ ${hexLabel(unit.hex)}`,
    selected: workbench.constructionInputs.engineerId === unit.instanceId,
    hex: unit.hex,
  })),
)

/** 本窗的施工者（右键开窗时已由菜单定死；验证页仍可换） */
const selectedEngineer = computed(() => {
  const id = workbench.constructionInputs.engineerId
  return id === null ? null : (workbench.units.find((unit) => unit.instanceId === id) ?? null)
})

/** 验证页 / 侧栏才铺全量工程兵阵列；右键会话窗只显示已选的那一名 */
const showsEngineerPicker = computed(() => props.page)

/** 13.8d 的一格一任务额度：按**当前选中的施工者**分别记账 */
const constructionLedger = computed(() =>
  workbench.constructionLedgerOf(workbench.constructionInputs.engineerId),
)

/** 换施工工程兵：旧付款站可能已不可达 ⇒ 一并清空，避免窗内显示旧站 */
function pickEngineer(id: string | null): void {
  workbench.constructionInputs = {
    ...workbench.constructionInputs,
    engineerId: id,
    payDumpId: null,
  }
}

/** 12.1b：已选的建造付款站（地图点选写入；不在当前施工者可达范围时照实标出） */
const selectedPayLabel = computed(() => {
  const id = workbench.constructionInputs.payDumpId
  if (id === null) return '（未选：还差付款补给站）'
  const dump = workbench.constructionPayDumps.find((item) => item.id === id)
  if (dump === undefined) return '（当前施工者不可达）'
  return `${hexLabel(dump.hex)}（${dump.sp} SP + ${dump.t} T）`
})

/** 15.3 主按钮出现前还差什么（null ＝ 可以出现）；预检与落盘共用引擎判据 */
const baseBuildMissing = computed(() => workbench.airConstructionMissing('baseBuild'))
/** 15.2A 修建主按钮出现前还差什么 */
const airstripBuildMissing = computed(() => workbench.airConstructionMissing('airstripBuild'))
/** 15.2A 升格：逐基地问同一份预检（范围 / 一格一任务 / 付款 / 目标格都对） */
function upgradeMissing(baseId: string): string | null {
  return workbench.airConstructionMissing('airstripUpgrade', baseId)
}
/** 15.2A 升格：窗里只列指定工程兵 2 格步行 MP 内的本方简易机场；验证页列全部 */
const upgradeCandidates = computed(() => {
  if (props.page) return workbench.ownAirBases.filter((base) => base.isAirstrip === true)
  const list = workbench.upgradableAirstripsFor(workbench.constructionInputs.engineerId)
  const hex = workbench.constructionTargetHex
  // 右键窗：地图上先点高亮格；点定后只留这一座，避免又把候选基地平铺一遍。
  return hex === null
    ? []
    : list.filter((base) => base.hex.col === hex.col && base.hex.row === hex.row)
})

/** 悬停某一枚地面算子 ⇒ 同步地图高亮 */
function hoverUnit(id: string | null): void {
  const unit = id === null ? null : (workbench.units.find((item) => item.instanceId === id) ?? null)
  workbench.setHoverHex(unit?.hex ?? null)
}

/** 面板关掉就退出地图选站模式，避免高亮残留、误吞地图点击 */
onBeforeUnmount(() => {
  workbench.constructionPayPick = false
})
</script>

<template>
  <hr />
  <RuleNote
    title="修建空军基地 / 简易机场：选目标格 + 工程兵 + 付款站，一格一任务"
    rule="15.3 / 13.8d"
  >
    <p class="muted">
      修建（15.3）：**只能在移动阶段**，且**只能由具工程能力的单位**执行（13.8d：战斗模式或 DG
      朝战斗面、本阶段未移动、半径 2 格**步行 MP**内、**一格一任务**）。空军基地 **1 SP/级**、
      每回合 +1 级、上限 3 级。简易机场按 15.2A：**修建 1 T**、**升格为一级基地 3 T**；
      每格至多一个空中设施（4.8）。简易机场**永不缩减降级**（15.2E）。
    </p>
  </RuleNote>
  <div v-if="props.page && (showBaseBuild || showAirstripBuild)" class="row">
    <label class="field">
      目标格
      <UiField v-model="workbench.constructionInputs.hexText" class="input" placeholder="36.13" />
      <BaseButton variant="secondary" size="sm" @click="workbench.beginAirBaseHexPickNow()">
        点地图选格
      </BaseButton>
    </label>
  </div>
  <div v-else-if="showBaseBuild || showAirstripBuild" class="row">
    <span class="num">
      目标格：
      {{
        workbench.constructionTargetHex === null
          ? '点地图上高亮的施工格（13.8d）'
          : hexLabel(workbench.constructionTargetHex)
      }}
      <template v-if="workbench.constructionTargetHex === null">
        ｜已按右键选中的施工者铺出 2 格步行 MP 内的候选格
      </template>
    </span>
  </div>
  <!-- 用户 2026-11-12：付款站改为**地图点选**（与炮击同一套：高亮 → 格上见 SP → 点选） -->
  <div class="row">
    <BaseButton variant="secondary" size="sm" @click="workbench.toggleConstructionPayPick()">
      {{ workbench.constructionPayPick ? '取消地图选站' : '在地图上选付款补给站' }}
    </BaseButton>
    <span class="num">
      付款站：{{ selectedPayLabel }}
      <template v-if="workbench.constructionPayPick">
        （点地图上高亮的补给站；12.3a/12.3b）
      </template>
    </span>
  </div>
  <!-- B14：施工工程兵＝算子图阵列（原来是纯文字下拉）；右键窗已选好施工者，不再平铺全量 -->
  <CounterPicker
    v-if="showsEngineerPicker"
    title="施工工程兵（13.8d）"
    hint="13.8d：须具工程能力、处于战斗模式（或 DG 朝战斗面）、本阶段未移动、在目标格 2 格步行 MP 内"
    :items="engineerItems"
    :size="40"
    @pick="pickEngineer($event)"
    @hover="hoverUnit"
  />
  <p v-else class="num">
    施工者：{{ selectedEngineer?.name ?? '（未选）' }} @
    {{ selectedEngineer === null ? '—' : hexLabel(selectedEngineer.hex) }}（右键已选定，13.8d）
  </p>
  <!-- 15.3：一个操作一个按钮（与 15.2A 两段不共窗） -->
  <div v-if="showBaseBuild" class="row">
    <BaseButton
      v-if="baseBuildMissing === null"
      variant="primary"
      size="sm"
      @click="workbench.buildAirBaseNow()"
    >
      修建 / 改进空军基地 +1 级（15.3：{{ workbench.airBaseBuildCostSpPerLevel }} SP/级）
    </BaseButton>
    <span v-else class="num">{{ baseBuildMissing }}</span>
  </div>
  <!-- 15.2A：修建简易机场（1 T） -->
  <div v-if="showAirstripBuild" class="row">
    <BaseButton
      v-if="airstripBuildMissing === null"
      variant="primary"
      size="sm"
      @click="workbench.buildAirstripNow()"
    >
      修建简易机场（15.2A：1 T）
    </BaseButton>
    <span v-else class="num">{{ airstripBuildMissing }}</span>
  </div>
  <!-- 15.2A：升格为一级空军基地（3 T）——候选按指定工程兵的 2 格步行 MP 收窄 -->
  <template v-if="showUpgrade">
    <p v-if="upgradeCandidates.length === 0" class="muted">
      {{
        props.page
          ? '当前没有可升格的简易机场（15.2A）。'
          : workbench.constructionTargetHex === null
            ? '点地图上高亮的本方简易机场格（15.2A：3 T 升为一级基地）。'
            : '该格不是当前工程兵可升格的本方简易机场（15.2A）。'
      }}
    </p>
    <div v-for="base in upgradeCandidates" :key="`upgrade-${base.id}`" class="row">
      <BaseTag kind="warning">{{ hexLabel(base.hex) }} 简易机场</BaseTag>
      <BaseButton
        v-if="upgradeMissing(base.id) === null"
        variant="primary"
        size="sm"
        @click="workbench.upgradeAirstripNow(base.id)"
      >
        升格为一级空军基地（15.2A：3 T）
      </BaseButton>
      <span v-else class="num">{{ upgradeMissing(base.id) }}</span>
    </div>
  </template>
  <div class="row">
    <span class="num">
      本阶段已施工：{{ constructionLedger.hexes.join('、') || '无' }}｜任务
      {{ constructionLedger.task ?? '无' }}（13.8d：一格一任务）
    </span>
  </div>
  <p v-if="workbench.engineerChoices.length === 0" class="muted">—</p>
  <p v-if="workbench.constructionErrorLine !== null" class="bad">
    <BaseTag kind="danger">{{ workbench.constructionError?.rule }}</BaseTag>
    {{ workbench.constructionErrorLine }}
  </p>
</template>
