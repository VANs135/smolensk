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

/** 13.8d 的一格一任务额度：按**当前选中的施工者**分别记账 */
const constructionLedger = computed(() =>
  workbench.constructionLedgerOf(workbench.constructionInputs.engineerId),
)

/** 12.1b：已选的建造付款站（地图点选写入；未选/失效时照实显示） */
const selectedPayLabel = computed(() => {
  const id = workbench.constructionInputs.payDumpId
  if (id === null) return '（未选：还差付款补给站）'
  const dump = workbench.spDumps.find((item) => item.id === id)
  return dump === undefined ? '（已失效）' : `${hexLabel(dump.hex)}（${dump.sp} SP + ${dump.t} T）`
})

const targetReady = computed(() => workbench.constructionTargetHex !== null)
const engineerReady = computed(() => workbench.constructionInputs.engineerId !== null)
const payReady = computed(() => workbench.constructionInputs.payDumpId !== null)

/** 15.3 主按钮出现前还差什么（null ＝ 可以出现） */
const baseBuildMissing = computed<string | null>(() => {
  if (!targetReady.value) return '还差：点地图选目标格（15.3）'
  if (!engineerReady.value) return '还差：选施工工程兵（13.8d）'
  if (!payReady.value) return '还差：付款补给站（15.3：1 SP/级）'
  return null
})
/** 15.2A 修建主按钮出现前还差什么 */
const airstripBuildMissing = computed<string | null>(() => {
  if (!targetReady.value) return '还差：点地图选目标格（15.2A）'
  if (!engineerReady.value) return '还差：选施工工程兵（13.8d）'
  if (!payReady.value) return '还差：付款补给站（15.2A：1 T）'
  return null
})
/** 15.2A 升格：窗里只列指定工程兵 2 格步行 MP 内的本方简易机场；验证页列全部 */
const upgradeCandidates = computed(() =>
  props.page
    ? workbench.ownAirBases.filter((base) => base.isAirstrip === true)
    : workbench.upgradableAirstripsFor(workbench.constructionInputs.engineerId),
)

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
  <div v-if="showBaseBuild || showAirstripBuild" class="row">
    <label class="field">
      目标格
      <UiField v-model="workbench.constructionInputs.hexText" class="input" placeholder="36.13" />
      <BaseButton variant="secondary" size="sm" @click="workbench.beginAirBaseHexPickNow()">
        点地图选格
      </BaseButton>
    </label>
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
  <!-- B14：施工工程兵＝算子图阵列（原来是纯文字下拉） -->
  <CounterPicker
    title="施工工程兵（13.8d）"
    hint="13.8d：须具工程能力、处于战斗模式（或 DG 朝战斗面）、本阶段未移动、在目标格 2 格步行 MP 内"
    :items="engineerItems"
    :size="40"
    @pick="workbench.constructionInputs.engineerId = $event"
    @hover="hoverUnit"
  />
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
      当前工程兵 2 格步行 MP 内没有可升格的简易机场（15.2A）。
    </p>
    <div v-for="base in upgradeCandidates" :key="`upgrade-${base.id}`" class="row">
      <BaseTag kind="warning">{{ hexLabel(base.hex) }} 简易机场</BaseTag>
      <BaseButton
        v-if="payReady"
        variant="primary"
        size="sm"
        @click="workbench.upgradeAirstripNow(base.id)"
      >
        升格为一级空军基地（15.2A：3 T）
      </BaseButton>
      <span v-else class="num">还差：付款补给站（15.2A：3 T）</span>
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
