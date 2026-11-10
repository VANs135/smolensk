<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag, RuleNote } from '@/components/base'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
import { SessionStep } from '@/components/session'
import { counterImageUrlOf, hexLabel, useWorkbenchStore } from '@/stores'

/**
 * **移动 / 突袭的操作链**（B15a；方案 §4.2「地图优先的操作链」）
 *
 * 为什么要有它：6.1 的「撤销一步 / 结束移动 / 放弃整次移动」原先只挂在 `WorkbenchView`
 * （引擎验证页）——对局台上**根本没有入口**，于是"能不能走完一局"这件事缺了一环
 * （用户四判据的「可玩通」）。本面板把这条链放进**唯一会话框**，与地图上的「就地摊开 + 选枚」配套。
 *
 * 分层纪律（CODE_SPEC）：本组件**不做任何规则计算** —— 移动中的单位、已耗 MP、上一步的结论、
 * ZOC 待决、放下/撤销/结束的合法性全部来自 store（store 转调引擎）；这里只画、只收点击。
 *
 * ## 操作链（与方案 §4.2 的图一致）
 *   地图点堆叠 ⇒ 就地摊开并默认全选 ⇒ **本面板就是那一步之后的动作集**：
 *   ① 走一步（地图上点高亮的邻格；本面板显示上一步结论与各单位的 MP 账）
 *   ② 突袭（8.0/8.1a：地图上点高亮的**突袭目标格**；3 MP 在 9.2 的推进步记账）
 *   ③ 放下某一枚（6.1f：走不动的留在经过的格，其余继续）
 *   ④ 撤销一步（6.1）/ 结束移动（6.1 末句）/ 放弃整次移动（全部还原）
 *   ⑤ 4.5a-A 的 ZOC 待决：进入即就地停止，或留在原格
 *
 * ★ 5.4a 改模式**不在这里**：唯一入口是右键菜单 →「模式改变」（本面板只留开拔会话）。
 */

const workbench = useWorkbenchStore()

/** 本次移动中的单位（含已被放下的，用于显示；`selected` 即"仍在动"那些） */
const movingUnits = computed(() => workbench.moveUnits)
/** 上一步的结论（costText / 掉队 / ZOC 停止 / 规则号） */
const lastStep = computed(() => workbench.lastStep)
/** P5：单步预览的本步 MP（store 已算好，本组件只合计显示） */
const previewCost = computed(() =>
  (workbench.stepPreview?.moving ?? []).reduce((sum, item) => sum + item.cost, 0),
)
/** P5：单步预览被判不可提交时的原因（引擎 `StepFailure`，组件原样展示） */
const previewBlocked = computed(() => workbench.stepPreview?.blocked ?? null)
/** 6.1a：MA 是**一阶段的总额度** ⇒ 账要按"已耗 / 可用"显示 */
const selected = computed(() => workbench.selectedUnit)
/**
 * P5：逐单位的**额度投影**（可用 / 已耗 / 剩余）——判据在 store（引擎 `availableMaOf`），
 * 本组件只查表，不自己算额度。
 */
function budgetOf(instanceId: string) {
  return workbench.moveBudgetRows.find((row) => row.instanceId === instanceId) ?? null
}
const selectedBudget = computed(() =>
  selected.value === null ? null : budgetOf(selected.value.instanceId),
)
/** 条 10（M1）：开拔前的取子勾选列表（界面用；`movePick` 为空时给空数组） */
const pickItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.movePickChoices.map((unit) => ({
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name: `${unit.name} @ ${hexLabel(unit.hex)}`,
    selected: workbench.movePick?.ids.includes(unit.instanceId) ?? false,
    hex: unit.hex,
  })),
)
/** 条 10（M1）：是否处于"开拔前"状态（有待开拔清单、且尚未真正开始移动） */
const preBegin = computed(() => workbench.movePick !== null && workbench.moveInteraction === null)

/**
 * ★ 用户 2026-10-25「**每个阶段/环节只能出现该环节可用 UI**」：本面板每一块都问闸门。
 *
 * 逐条对原文：
 *   · **5.4a 改模式**「只在本方**移动阶段**、开始移动前」⇒ 只有 `movement.modeAndMovement`
 *     （`move.modeChange` 的闸门）；
 *   · **6.1 移动**（开拔 / 走 / 结束）⇒ C/E/G 的**移动环节**（`move.order`）；
 *   · **8.0 突袭**⇒ 同三处（`move.overrun`）；
 *   · **5.7b 释放预备**「本方**反应阶段**（MA ×½）或**进击阶段**（MA ×1）」⇒ **只在 E/G**
 *     （`reserve.release`）—— 修前这一块在 C 段也常显；
 *   · **12.5c 燃料**「在发生燃料消耗的**任何阶段**…在燃料消耗时支付」⇒ 跟着移动走
 *     （`supply.fuel`：C/E/G 移动环节）。
 *
 * 界面只读这几个投影，**不在这里写死阶段名或规则号**（判据的唯一定义在 `ACTION_GATES`）。
 */
const canMove = computed(() => workbench.actionAllowedNow('move.order'))
const canOverrun = computed(() => workbench.actionAllowedNow('move.overrun'))
const canReleaseReserve = computed(() => workbench.actionAllowedNow('reserve.release'))

/**
 * 13.2a：本次移动里有**运输点数**且尚未结束时，才给「暂停移动」这一个显式入口
 *
 * 用户的实机 #15：修前「结束移动」被当成暂停，别的单位永远被拦 ⇒ 现在结束＝完成；
 * 13.2a 的「暂停并使用装载补给、然后继续」只由这个按钮触发。
 */
const canPauseTransport = computed(() => {
  const interaction = workbench.moveInteraction
  if (interaction === null || interaction.finished) return false
  return workbench.moveUnits.some(
    (unit) =>
      !unit.movementEnded &&
      !unit.isCombat &&
      unit.noncombatTransport > 0 &&
      unit.noncombatKind !== 'organic_truck',
  )
})

/** P8：移动/突袭允许的环节名（取 `ACTION_GATES` 投影，不在模板里写死） */
const moveSegmentLabels = computed(() => workbench.segmentLabelsOfAction('move.order'))
const moveSegmentLabelText = computed(() =>
  moveSegmentLabels.value.map((label) => `「${label}」`).join('、'),
)

/** 6.1f：本次移动中的单位阵列（已放下的灰显） */
const moveUnitItems = computed<readonly CounterPickerItem[]>(() =>
  movingUnits.value.map((unit) => {
    const budget = budgetOf(unit.instanceId)
    return {
      id: unit.instanceId,
      imageUrl: counterImageUrlOf(unit),
      name:
        `${unit.name}（已耗 ${unit.mpSpent} MP @ ${hexLabel(unit.hex)}` +
        `${budget === null ? '' : `｜剩余 ${budget.remaining} MP`}` +
        `${unit.movementEnded ? '｜本次移动已结束' : '｜仍在动'}）`,
      selected: !unit.movementEnded,
      disabledReason: unit.movementEnded ? '6.1f：该单位本次移动已结束（放下/走完）' : null,
      hex: unit.hex,
    }
  }),
)

/** 悬停某一枚 ⇒ 同步地图高亮它所在的格 */
function hoverUnit(id: string | null): void {
  const unit = id === null ? null : (workbench.units.find((item) => item.instanceId === id) ?? null)
  workbench.setHoverHex(unit?.hex ?? null)
}

/*
 * ─────────────────── 燃料（12.5）已移出本面板 ───────────────────
 *
 * ★ 用户 2026-11-10 口径更正：**加油不是"点选某一步"，而是右键菜单里的一项**。
 *   「点单位/点格 → 移动窗口 → 直接跳到加油操作」是入口错位 ⇒ 本面板不再承载付款区；
 *   加油唯一入口＝右键该单位/堆叠 → 菜单列出真正可用的 12.5c 方法（A/B/C）→ `fuel` 会话窗
 *   （`FuelPanel`）里选来源、付款、确认。点选单位/格子不会自动打开加油流程。
 */

/**
 * 12.8e：**突围**已移进专属会话框（`BreakoutPanel`，见 `GameTableView` 的 `session.kind === 'breakout'`）。
 * 修前这一段挂在右栏 `MovePanel` 的 `v-else` 里、**正常突围段不可达**；条 6（R3）把它挪到会话框，
 * 并配合地图"可突围堆叠高亮 + 点单位即自动结算"。此处不再保留突围块。
 */
</script>

<template>
  <BasePanel title="移动 / 突袭（6.1 / 8.0）">
    <p v-if="selected !== null" class="num">
      当前选中：{{ selected.name }}（{{
        selected.mode.orientation === 'move' ? '移动面' : '战斗面'
      }}
      ｜已耗 {{ selected.mpSpent }} MP @ {{ hexLabel(selected.hex) }}）
    </p>
    <p v-else class="muted">地图上还没选中算子：点一格即可就地摊开堆叠并逐枚选择（6.1）。</p>

    <!-- P5：该单位的额度账（可用 / 已耗 / 剩余）——读 store 的 `moveBudgetRows`，不自己算 -->
    <p v-if="selectedBudget !== null" class="num">
      额度：可用 {{ selectedBudget.availableMa }} / 已耗 {{ selectedBudget.spent }} / 剩余
      {{ selectedBudget.remaining }} MP（6.1a / 6.1h）
    </p>

    <!-- 9.2 / 10.0：结算进行中 ⇒ 任何单位都不得移动 -->
    <div v-if="workbench.settlementInProgress !== null" class="block">
      <p class="num">
        <BaseTag kind="warning">{{ workbench.settlementInProgress.rule }}</BaseTag>
        {{ workbench.settlementInProgress.label }}正在结算：**任何单位都不能移动** ——
        先走完流程（或按 Esc 放弃），之后才能开始 / 继续移动。
      </p>
    </div>

    <!--
      ★ 用户 2026-10-25「每个环节只出现该环节可用 UI」：本环节**不做移动**时明说一句，
      而不是照旧铺一屏点不动的移动按钮（点下去只会被判据拒绝）。
    -->
    <div v-if="!canMove" class="block">
      <p class="num">
        <BaseTag kind="warning">{{ workbench.segmentStep?.rule ?? '6.1' }}</BaseTag>
        本环节（{{ workbench.segmentStep?.label ?? '—' }}）**不做移动**：移动与突袭只在
        {{ moveSegmentLabelText }} {{ moveSegmentLabels.length }} 个环节进行（6.1 / 8.0）。
        下方只留与当前流程有关的信息。
      </p>
    </div>

    <!-- 条 10（M1）：开拔前的取子勾选（6.1f / 8.1h）——点地图也可勾选，这里给一个面板内入口 -->
    <!-- U1-b：开拔＝一件事（取子 + 模式 + 开始移动在同一门内，不并列堆两个决定） -->
    <SessionStep v-if="preBegin && canMove" item="move:pick">
      <p class="num">勾选要一起开拔的单位（6.1；点地图也可勾选 / 取消）：</p>
      <CounterPicker
        title="待开拔单位（点一枚＝勾选 / 取消，6.1）"
        hint="6.1：未勾选者留在格内（8.1h 允许留驻）；勾选后改模式、付燃料、点「开始移动」"
        :items="pickItems"
        :size="40"
        @pick="workbench.toggleMovePick($event)"
        @hover="hoverUnit"
      />
      <div class="row">
        <BaseButton variant="secondary" size="sm" @click="workbench.setMovePickAll()">
          全选本格
        </BaseButton>
        <BaseButton variant="ghost" size="sm" @click="workbench.cancelMovePick()">
          取消取子
        </BaseButton>
      </div>

      <!--
        ① 统一操作条（条 9 / 条 10，M1）：开始移动
        ★ 改模式（5.4a）只在**右键菜单 →「模式改变」**里给，本面板不再重复摆一组模式按钮；
          6.1 开拔在 C/E/G 的移动环节都成立 ⇒ 由 `canMove` 管。
      -->
      <div class="row">
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="workbench.movePick === null"
          @click="workbench.confirmMovePick()"
        >
          开始移动
        </BaseButton>
      </div>
      <p class="num">
        已选 {{ workbench.movePick?.ids.length ?? 0 }} 枚待开拔（地图上点枚可勾选 / 取消）。
      </p>
    </SessionStep>

    <!--
      ①b 两条原先**只在引擎验证页有入口**的动作（B18 复核顺手接线，与燃料那处同类）：
        · 5.7b 释放预备：E/G 段把预备标记摘掉（反应段 MA×½、进击段 MA×1）；
        · 4.5b 垫人：以某单位许诺"本阶段不再消耗 MP" ⇒ 抵消它所在格的敌方 ZOC。
      判据都在 store（`releaseReserveNow` 转调引擎的 `canReleaseReserve`；`lockZocNegation` 只落盘），
      本面板只提供"在哪按"。
    -->
    <div class="row">
      <!-- 5.7b：只在 E 反应 / G 进击的移动环节（修前在 C 段也常显，点了才被拒） -->
      <BaseButton
        v-if="canReleaseReserve"
        variant="secondary"
        size="sm"
        :disabled="selected === null"
        @click="workbench.releaseReserveNow()"
      >
        释放预备（5.7b：仅反应 / 进击段）
      </BaseButton>
      <!-- 4.5b 垫人：属"移动中的 ZOC 处置" ⇒ 跟着 canMove 走 -->
      <BaseButton
        v-if="canMove"
        variant="ghost"
        size="sm"
        :disabled="selected === null"
        @click="selected !== null && workbench.lockZocNegation(selected.instanceId)"
      >
        许诺不再耗 MP（垫人，4.5b：抵消该格敌方 ZOC）
      </BaseButton>
    </div>
    <RuleNote
      v-if="canReleaseReserve"
      title="释放预备：本方反应阶段（MA ×½）或进击阶段（MA ×1）"
      rule="5.7b"
    >
      <p class="muted">
        5.7b：预备单位在**本方反应阶段**（非阶段玩家，MA ×½）或**进击阶段**（阶段玩家，MA
        ×1）可被释放 ——摘掉预备标记即回到朝向面；4.5b：该格只要有一个处于「已承诺不再耗
        MP」的己方战斗单位， 敌方 ZOC 即被抵消（该单位本阶段就不能再消耗 MP）。
      </p>
    </RuleNote>

    <!-- ④ 本次移动中的单位（6.1f：点一枚即把它就地放下，其余继续走） -->
    <CounterPicker
      title="移动编组 · 6.1f"
      hint="点击算子就地放下"
      :items="moveUnitItems"
      :size="40"
      @pick="workbench.dropUnitFromMove($event)"
      @hover="hoverUnit"
    />
    <p v-if="movingUnits.length === 0" class="muted">
      本次移动里还没有单位（先在地图上选定要动的算子）。
    </p>

    <!-- ② 上一步结论（6.1：MP 消耗 / 掉队 / ZOC 停止都由引擎给） -->
    <div v-if="lastStep !== null" class="num">
      <BaseTag kind="success">{{ lastStep.rules.join(' / ') }}</BaseTag>
      {{ hexLabel(lastStep.from) }} → {{ hexLabel(lastStep.to) }}｜{{ lastStep.costText }}
      <template v-if="lastStep.droppedNames.length > 0">
        ｜掉队：{{ lastStep.droppedNames.join('、') }}（6.1f）
      </template>
      <template v-if="lastStep.zocStoppedNames.length > 0">
        ｜进入 ZOC 就地停止：{{ lastStep.zocStoppedNames.join('、') }}（4.5a-A）
      </template>
    </div>

    <!--
      P5：**悬停 / 单步预览**（C5）——对局台原先看不到 `hoverNode` / `stepPreview`，
        玩家只能靠点下去才知道代价。这一块把 store 算好的路径、累计、本步 MP、挡因与
        ZOC/掉队提示原样显示；**不在组件里重算**任何额度或判据。
    -->
    <div v-if="workbench.hoverNode !== null || workbench.stepPreview !== null" class="block">
      <p class="num">
        <BaseTag kind="info">预览不扣 MP</BaseTag>
        <template v-if="workbench.hoverNode !== null">
          路径 {{ workbench.hoverNode.path.length }} 格 · 累计 {{ workbench.hoverNode.mpSpent }} MP
        </template>
        <template v-if="workbench.stepPreview !== null">
          <template v-if="workbench.hoverNode !== null">｜</template>
          本步 {{ previewCost }} MP
        </template>
      </p>
      <p v-if="previewBlocked !== null" class="muted num">
        <BaseTag kind="warning">{{ previewBlocked.rule }}</BaseTag>
        这一步走不进：{{ previewBlocked.reason
        }}{{ previewBlocked.detail === undefined ? '' : `（${previewBlocked.detail}）` }}
      </p>
      <p v-if="(workbench.stepPreview?.zocStoppingIds.length ?? 0) > 0" class="muted num">
        {{ workbench.stepPreview?.zocStoppingIds.length }} 枚进入该格后会因敌方 ZOC
        就地停止（4.5a-A）
      </p>
      <p v-if="(workbench.stepPreview?.droppingIds.length ?? 0) > 0" class="muted num">
        {{ workbench.stepPreview?.droppingIds.length }} 枚走不动、将留在原格（6.1f）
      </p>
    </div>

    <!-- ⑦ 条 17（批 F·F2）：4.5a 约束 —— 突袭强行进入敌方 ZOC 后，该格单位"不得离开、须再突袭或停" -->
    <SessionStep v-if="workbench.overrunZocHeld !== null" item="move:continue">
      <p class="num">
        <BaseTag kind="warning">4.5a</BaseTag>
        突袭进入 {{ hexLabel(workbench.overrunZocHeld) }}（敌方 ZOC）：该格单位**不得离开**，
        须**再突袭**（点相邻敌方格）或**停**在原格。
      </p>
    </SessionStep>

    <!-- ③ 突袭（8.0/8.1a）：目标格在地图上高亮，点它即发起 -->
    <p v-if="canOverrun" class="muted num">点击地图上高亮的敌方格发起突袭 · 8.1a</p>

    <!--
      ★ 12.5 燃料：**已移出本面板**（用户 2026-11-10：加油唯一入口＝右键该单位/堆叠）。
      点选单位/格子不再自动进入加油流程；付款在 `FuelPanel`（会话 kind='fuel'）内完成。
    -->

    <!-- ⑤ 收束：撤销一步 / 结束移动 / 放弃整次移动（只对"正在进行的那次移动"有意义） -->
    <!-- U1-b：与「突袭后的处置」互斥（同一事项 id）；有 overrunZocHeld 时由上一门负责 -->
    <SessionStep
      v-if="(canMove || workbench.moveInteraction !== null) && workbench.overrunZocHeld === null"
      item="move:continue"
    >
      <div class="row">
        <BaseButton variant="secondary" size="sm" @click="workbench.undoLastStep()">
          撤销一步
        </BaseButton>
        <BaseButton variant="primary" size="sm" @click="workbench.finishMove()">
          结束移动
        </BaseButton>
        <BaseButton
          v-if="canPauseTransport"
          variant="secondary"
          size="sm"
          @click="workbench.pauseTransportMove()"
        >
          暂停移动（13.2a）
        </BaseButton>
        <BaseButton variant="ghost" size="sm" @click="workbench.abortMoveNow()">
          放弃本次移动（全部还原并退出）
        </BaseButton>
      </div>
    </SessionStep>

    <!--
      ★ #7（用户 2026-11-10）：「说明文字下屏」——屏上只留单位阵列与按钮，
        规则原文与操作解释统一沉到面板末尾，每条用 `RuleNote` 折叠（标题一行 + 展开原文）。
    -->
    <div class="notes">
      <RuleNote title="结束 / 撤销 / 放弃本次移动" rule="6.1f / 6.1h / 13.2a">
        <p class="muted">
          走完可点「结束移动」（结束＝完成）；运输点数要先用装载的补给付款再继续，用「暂停移动（13.2a）」。
          已做的动作只能靠「撤销一步」回退或「放弃本次移动」全部还原。撤销只给一步；放弃会还原整次移动，
          还原后可重新选子再走。暂停的运输点数须在别的单位开拔前完成（13.2a）。
        </p>
      </RuleNote>
    </div>
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

.block {
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
