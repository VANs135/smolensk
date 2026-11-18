<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag, RuleTip } from '@/components/base'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
import { DerivationSteps, SessionStep } from '@/components/session'
import {
  counterImageUrlOf,
  hexLabel,
  useMapViewStore,
  useWorkbenchStore,
  type ConsoleUnit,
} from '@/stores'

/**
 * 战斗面板（C6：OCS 9.0 章）
 *
 * 只走 9.2 九步结算（`engine/rules/combat-interaction.ts` 的状态机）：
 * 战斗补给（9.5/12.4）→ 行动值（9.6）→ 逐堆叠地形（9.4b/9.4c）→ 奇袭（9.8）→ 战斗骰（9.9）→
 * 强制损失（9.11）→ 选项（9.10）→ 撤退（9.12）→ 战后推进与进击（9.12g/9.13）。
 *
 * 分层纪律（CODE_SPEC）：本组件**不做任何规则计算** —— 步骤清单、战果、损失分配、合法性
 * 全部来自 store 对引擎的调用结果；这里只画图、收点击、把输入写进 `combatInputs`。
 */

const workbench = useWorkbenchStore()

/**
 * ★ 批 C 切片 1（方案 §3 批 C 步骤 2 的后半）：**逐步复核**的手动入口只在**验证页**渲染
 *
 * 正式对局台不传（默认 false）⇒ 「只确认地形」「掷奇袭骰」「掷战斗骰」这些**重复入口**不出现：
 * 九步里的骰子与查表由「确认地形 ⇒ 自动结算到战果」连跑（B30 已实现），摆着另一条手动路只会让人
 * 以为是两种玩法。★ 玩家步骤（宣布 AR → 宣布地形）**一个都不合并**（用户 2026-09-17 二次确认）。
 * 验证页（`WorkbenchView`）传 `stepwise` ⇒ 原样保留，供逐步核对与复现。
 */
const props = withDefaults(defineProps<{ stepwise?: boolean }>(), { stepwise: false })

/** 战斗交互状态机（null＝未开始） */
const state = computed(() => workbench.combatState)
/**
 * P5：9.2 战斗会话**不能放弃**的原因（store 唯一判据，与 `cancelCombat` 同源；界面只读）
 */
const cancelBlocker = computed(() => workbench.combatCancelBlocker())

/** 角色名 */
function roleName(role: string): string {
  return role === 'attacker' ? '攻方' : '守方'
}

/** 单位实例 id → 显示名（撤退/推进列表用） */
function nameOf(unitId: string): string {
  return workbench.units.find((unit) => unit.instanceId === unitId)?.name ?? unitId
}

/**
 * 12.4：某方已声明的战斗补给来源（没声明＝null）
 *
 * 声明由地图点击（`pickCombatSupplyDump`）写入；原文未要求同源，故可点选多座，
 * 各单位落盘时各自取自己拖得到的那一座。这里只**显示**并给「清除」按钮。
 */
function declaredDumpOf(side: 'attacker' | 'defender'): string | null {
  const single = workbench.combatSupplyDumpIds[side]
  const picks = workbench.combatSupplyDumpPicks[side]
  const ids = picks.length > 0 ? picks : single === null ? [] : [single]
  if (ids.length === 0) return null
  const entry = workbench.combatSupplyDumps.find((item) => item.side === side)
  const labels = ids.map((id) => {
    const dump = entry?.dumps.find((item) => item.id === id)
    return dump === undefined ? id : `${hexLabel(dump.hex)}（${dump.sp} SP / ${dump.t} T）`
  })
  return labels.join(' + ')
}

/* ── 9.4b 逐堆叠地形：`kind|terrain` 的字符串编解码（select 只能绑一个值） ── */

function stackChoiceValue(key: string): string {
  const choice = workbench.combatInputs.stackTerrain[key]
  return choice === undefined ? '' : `${choice.kind}|${choice.terrain}`
}

function onStackTerrainChange(key: string, value: string): void {
  if (value === '') {
    const next = { ...workbench.combatInputs.stackTerrain }
    delete next[key]
    workbench.combatInputs.stackTerrain = next
    return
  }
  const [kind, terrain] = value.split('|')
  workbench.combatInputs.stackTerrain = {
    ...workbench.combatInputs.stackTerrain,
    [key]: { kind: kind === 'hexside' ? 'hexside' : 'hex', terrain: terrain ?? '' },
  }
}

/** 9.4c：守方地形未点选时按候选第一项显示为"已选"（引擎落盘时同样取默认） */
function isDefenderTerrain(name: string): boolean {
  const chosen = workbench.combatInputs.defenderTerrain
  return chosen === '' ? workbench.combatDefenderTerrainOptions[0] === name : chosen === name
}

/** 9.12g：可推进的单位（不可推进的只报数，不摆灰按钮） */
const advanceSelectable = computed(() =>
  workbench.combatAdvanceChoices.filter((choice) => choice.disabledReason === null),
)
const advanceBlockedCount = computed(
  () => workbench.combatAdvanceChoices.filter((choice) => choice.disabledReason !== null).length,
)
/** 有选中且防御格已空 ⇒ 推进；否则就是按 9.13 结束（不推进） */
const advanceButtonLabel = computed(() =>
  workbench.combatDefendingHexCleared && workbench.combatInputs.advanceUnitIds.length > 0
    ? '推进并结束'
    : '结束战斗（不推进）',
)

/** 9.12e：撤退堆叠的额外损失由谁承受（候选＝撤退中的 DG 单位，与引擎确认同源） */
const extraLossPreview = computed(() => workbench.combatExtraLossPreview)

/** 9.12：按当前撤退格数将被消灭的单位（只报名字；解释进 `?`） */
const retreatWipeLabels = computed(() =>
  workbench.combatOptionRetreatWarning.map((item) => item.label).join('、'),
)

/**
 * 9.12g 战后推进：**唯一入口是地图上的推进格** —— 点它即按规则预选参与推进的单位
 * （`advanceNow`），本面板只负责在同一张卡里改选与确认。不在这里另做一次默认全选。
 */

/* ── 9.12 撤退：落点由**在地图上点格**选定（用户口径 2026-09-16） ──
 *
 * 修前这里是逐单位一个 `列.行,列.行` 文本框 —— 玩家得手抄坐标，而且和地图上的三色高亮
 * （`overlay.retreat` 的 safe / zoc / doomed）各说一套。现在：
 *   候选格由引擎 `planRetreatDestinations`（9.12）给出 → 地图铺出可撤退格 →
 *   **点格即选定**（`map-view.onHexClick` → `setRetreatDestinationNow`）。
 * 故本面板只负责「现在给谁选」和「确认」，不再收坐标；落盘格式仍是 `combatInputs.retreatPaths`
 * 的文本（9.12 的既有契约不变，只是改由点格写入）。
 */

const mapView = useMapViewStore()

/*
 * 2026-11-18 用户实盘返修（战斗支付串方）：面板上的「攻方补给 / 守方补给」控件只能给
 * **该方自己**。视角方归谁由 `mapView.viewerCombatRoles` 统一判（solo 双方、PVE 只玩家方、
 * PVP 只当前视角方）；验证页 `stepwise` 保留全量，供裁判逐步核对。
 */
function canActCombatRole(role: 'attacker' | 'defender'): boolean {
  return props.stepwise || mapView.canActCombatRole(role)
}
const canActAnyCombatRole = computed(() => props.stepwise || mapView.viewerCombatRoles.length > 0)
/** 当前结算方是否归视角方（9.10b 攻先守后；验证页保留全量） */
const canActResolver = computed(() => props.stepwise || mapView.canActResolver)

/** 正在选落点的一方（与地图高亮**同一份**计划；修前面板读的是"永远先攻方"的那份） */
const retreatPlan = computed(() => mapView.retreatSidePlan)
/** 正在选落点的那一枚（点行即切换；地图点格后自动跳到下一枚未选的） */
const retreatUnit = computed(() => mapView.retreatUnit)

/*
 * 9.12g 推进候选勾选：**入口是地图推进格**（点它即按规则预选），勾选动作在 store
 * （`workbench.toggleAdvanceUnit`），本面板只读 `combatAdvanceChoices` 展示并允许改选。
 */

/**
 * 当前结算方在 CRT 原文里的记号（如守方段 `Do1`）——
 * ★ 用户 2026-11-10：结算窗头部直接写 CRT 原文（`守方结算 · Do1`），不加箭头、不另造译名。
 */
const resolverNotation = computed(() => {
  const summary = workbench.combatSummary
  const current = state.value
  if (summary === null || current === null) return ''
  return current.resolution.stage.startsWith('attacker')
    ? summary.attacker.notation
    : summary.defender.notation
})

/**
 * 批 C（9.10b 攻先守后）：守方进入战果步时，攻方**已经结算**的损失与选项。
 *
 * 只在当前轮到守方、且攻方确有结算记录时给；攻方尚未结算时返回 null（这一段不出现，不置灰）。
 */
const settledAttacker = computed(() => {
  const current = state.value
  if (current === null) return null
  if (current.resolution.stage.startsWith('attacker')) return null
  const attacker = current.resolution.attacker
  if (attacker.option === undefined && attacker.forcedLosses === undefined) return null
  return {
    lostSteps:
      (attacker.forcedLosses ?? []).reduce((sum, item) => sum + item.steps, 0) +
      (attacker.option?.lossPoints ?? 0),
    retreatHexes: attacker.option?.retreatHexes ?? 0,
    ignored: attacker.optionIgnored === true,
  }
})

/** 供模板用：参战攻方（9.5b 减员时以勾选状态为准） */
const attackerList = computed<ConsoleUnit[]>(() => workbench.combatAttackers)

/* ─────────────────── 算子图阵列（B14c；用户口径⑪） ───────────────────
 *
 * 「把当前可选的**算子图片**紧凑排出来；算子上信息已经够了，除了环节提示这种外不需要显示额外的文字」。
 * 故本面板四处「选算子」的位置改用 `CounterPicker`：数字与名称只进 `title`（悬停可见），
 * 屏幕上只有算子图 + 金框（选中）。**本组件不做任何规则判断**：候选与灰显原因都由 store 给。
 */

/** 悬停某一枚 ⇒ 同步地图高亮它所在的格 */
function hoverUnit(id: string | null): void {
  const unit = id === null ? null : (workbench.units.find((item) => item.instanceId === id) ?? null)
  workbench.setHoverHex(unit?.hex ?? null)
}

/** 单位实例 id → 算子（AR 候选只有 id 与文字标签，取图与悬停要的是实例本身） */
function unitOf(id: string): ConsoleUnit | null {
  return workbench.units.find((item) => item.instanceId === id) ?? null
}

/** 9.5b：参战攻方（付不出全额时可减少参战单位 ⇒ 点一枚加入/退出） */
const supplyAttackerItems = computed<readonly CounterPickerItem[]>(() =>
  attackerList.value.map((unit) => ({
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name: `${unit.name}（军力 ${unit.steps} ⇒ 需 ${unit.steps} T）@ ${hexLabel(unit.hex)}`,
    selected: workbench.combatAttackerIds.includes(unit.instanceId),
    hex: unit.hex,
  })),
)

/** 9.5（热座）：攻方先确认、守方后确认；两方都确认后才出现共用出口 */
const bothSupplyConfirmed = computed(
  () =>
    workbench.combatInputs.supplyConfirmed.attacker &&
    workbench.combatInputs.supplyConfirmed.defender,
)

/** 9.6：某一方的行动值（AR）单位阵列。候选集由 store 给（专规 2.3b 的收窄已含在其中） */
function arItems(
  options: readonly { id: string; label: string }[],
  selectedId: string | null,
): readonly CounterPickerItem[] {
  return options.flatMap((option) => {
    const unit = unitOf(option.id)
    if (unit === null) return []
    return [
      {
        id: option.id,
        imageUrl: counterImageUrlOf(unit),
        name: `${option.label}@ ${hexLabel(unit.hex)}`,
        selected: selectedId === option.id,
        hex: unit.hex,
      },
    ]
  })
}

const attackerArItems = computed(() =>
  arItems(workbench.combatAttackerArOptions, workbench.combatInputs.attackerArUnitId),
)

/** 2.3b：NKVD 边防团在场时候选已收窄到它们，故阵列里出现的就是"唯一能选的那几个" */
const defenderArItems = computed(() =>
  arItems(workbench.combatDefenderArChoices, workbench.combatInputs.defenderArUnitId),
)

/** 9.11c：选项损失只列**当前还能记损**的单位（第一点归 AR 单位，之后只给最少者）；分完即整块消失 */
const optionLossItems = computed<readonly CounterPickerItem[]>(() => {
  if (workbench.optionDraftRemaining <= 0) return []
  return workbench.combatOptionLossTargets.flatMap((target) => {
    if (!workbench.canTakeOptionLossPoint(target.id)) return []
    const taken = workbench.combatInputs.optionLossAllocation[target.id] ?? 0
    const unit = unitOf(target.id)
    return [
      {
        id: target.id,
        imageUrl: unit === null ? null : counterImageUrlOf(unit),
        name: `${target.name}（军力 ${target.steps}，已损 ${taken}）`,
        selected: taken > 0,
        hex: target.hex,
        ...(taken > 0 ? { badge: `−${taken}` } : {}),
      },
    ]
  })
})
</script>

<template>
  <BasePanel>
    <!-- R-1：发起屏（S1）已删——点可攻击格即开打并直接进补给步；本面板只在战斗开始后出现 -->
    <template v-if="state !== null">
      <p v-if="workbench.combatError !== null" class="bad" :title="workbench.combatError.rule">
        {{ workbench.combatErrorLine }}
      </p>

      <!-- 第 2 步：战斗补给（9.5 / 12.4）——攻/守两段同窗，但只出现视角方自己那一份 -->
      <SessionStep item="combat:supply">
        <!-- B5：只列视角方能操作的那一侧来源；两侧都不归视角方时只留等待提示 -->
        <div class="row">
          <span class="num">
            <template v-if="canActCombatRole('attacker')">
              攻方来源 {{ declaredDumpOf('attacker') ?? '—' }}
            </template>
            <template v-if="canActCombatRole('attacker') && canActCombatRole('defender')">
              ｜
            </template>
            <template v-if="canActCombatRole('defender')">
              守方来源 {{ declaredDumpOf('defender') ?? '—' }}
            </template>
            <template v-if="!canActAnyCombatRole">等待对方支付战斗补给…</template>
          </span>
          <RuleTip rule="9.5 / 12.4">
            攻方须付足全部所需 T（不足则取消攻击）；守方可不付（以一半战斗值防御，9.5-B）。
            在地图上点补给站即声明付款来源（12.4）；来源为「—」时无法付款。
          </RuleTip>
        </div>
        <template v-if="canActCombatRole('attacker')">
          <label v-if="workbench.combatAttackerStocksApplicable" class="check">
            <input v-model="workbench.combatInputs.attackerUsesInternalStocks" type="checkbox" />
            攻方用储备
          </label>
          <!-- B14c：参战攻方＝**算子图阵列**；9.5b 的取消只走地图入口（B9），此阵列只读展示 -->
          <CounterPicker
            title="参战攻方"
            :items="supplyAttackerItems"
            :size="40"
            @hover="hoverUnit"
          />
          <BaseButton
            v-if="!workbench.combatInputs.supplyConfirmed.attacker"
            variant="primary"
            size="sm"
            @click="workbench.confirmCombatSupplySide('attacker')"
          >
            确认攻方补给
          </BaseButton>
          <BaseButton
            v-else
            variant="ghost"
            size="sm"
            @click="workbench.confirmCombatSupplySide('attacker')"
          >
            已确认攻方 · 改
          </BaseButton>
        </template>

        <!-- B6：来源只走地图入口；再点同一座＝取消（不再有独立的清除按钮） -->
        <!-- B7：守方支付是唯一入口，储备只作它里面的一行（「优先用储备」） -->
        <template v-if="canActCombatRole('defender')">
          <div class="check-group">
            <label class="check">
              <input v-model="workbench.combatInputs.defenderProvides" type="checkbox" />
              守方支付
            </label>
            <label v-if="workbench.combatDefenderStocksApplicable" class="check check--nested">
              <input v-model="workbench.combatInputs.defenderUsesInternalStocks" type="checkbox" />
              优先用储备
            </label>
          </div>
          <BaseButton
            v-if="
              workbench.combatInputs.supplyConfirmed.attacker &&
              !workbench.combatInputs.supplyConfirmed.defender
            "
            variant="primary"
            size="sm"
            @click="workbench.confirmCombatSupplySide('defender')"
          >
            确认守方补给
          </BaseButton>
          <BaseButton
            v-else-if="workbench.combatInputs.supplyConfirmed.defender"
            variant="ghost"
            size="sm"
            @click="workbench.confirmCombatSupplySide('defender')"
          >
            已确认守方 · 改
          </BaseButton>
        </template>

        <div v-if="bothSupplyConfirmed && canActAnyCombatRole" class="row">
          <BaseButton variant="primary" size="sm" @click="workbench.confirmCombatSupply()">
            进入行动值
          </BaseButton>
        </div>
      </SessionStep>

      <!-- 第 3 步：宣布行动值（9.6：攻方先、守方后）——只画视角方自己那一侧 -->
      <SessionStep item="combat:ar:attacker">
        <template v-if="canActCombatRole('attacker')">
          <!-- B14c：AR 单位＝**算子图阵列**（原来是两个纯文字下拉） -->
          <CounterPicker
            title="攻方 AR 单位"
            :items="attackerArItems"
            :size="40"
            @pick="workbench.combatInputs.attackerArUnitId = $event"
            @hover="hoverUnit"
          />
          <RuleTip rule="9.6 / 专规 2.3b">
            每方只能选一个参战单位担任行动值；DG 单位 −1。守方堆叠内有 NKVD
            边防团时，行动值单位只能从它们中选。
          </RuleTip>
          <div class="row">
            <BaseButton
              v-if="workbench.combatInputs.attackerArUnitId !== null"
              variant="secondary"
              size="sm"
              @click="workbench.declareCombatArStep('attacker')"
            >
              攻方宣布
            </BaseButton>
          </div>
        </template>
        <p v-else class="muted">对方正在宣布行动值…</p>
      </SessionStep>

      <SessionStep item="combat:ar:defender">
        <template v-if="canActCombatRole('defender')">
          <CounterPicker
            title="守方 AR 单位"
            :items="defenderArItems"
            :size="40"
            @pick="workbench.combatInputs.defenderArUnitId = $event"
            @hover="hoverUnit"
          />
          <RuleTip rule="9.6 / 专规 2.3b">
            每方只能选一个参战单位担任行动值；DG 单位 −1。守方堆叠内有 NKVD
            边防团时，行动值单位只能从它们中选。
          </RuleTip>
          <div class="row">
            <BaseButton
              v-if="workbench.combatInputs.defenderArUnitId !== null"
              variant="primary"
              size="sm"
              @click="workbench.declareCombatArStep('defender')"
            >
              守方宣布并继续
            </BaseButton>
          </div>
        </template>
        <p v-else class="muted">对方正在宣布行动值…</p>
      </SessionStep>

      <!-- 第 4 步：宣布地形与初始攻防比（9.4 / 9.7） -->
      <SessionStep item="combat:terrain">
        <RuleTip rule="9.4b / 9.4c">
          攻方每个攻击堆叠可选「防御格内地形」或「所穿越的格边地形」（不累计）；守方只能选防御格内地形，并决定战斗表横行。
        </RuleTip>
        <div
          v-for="stack in canActCombatRole('attacker') ? workbench.combatStackTerrainOptions : []"
          :key="stack.key"
          class="row"
        >
          <span class="num">攻方堆叠 {{ stack.label }}</span>
          <BaseButton
            size="sm"
            :variant="stackChoiceValue(stack.key) === '' ? 'secondary' : 'ghost'"
            @click="onStackTerrainChange(stack.key, '')"
          >
            沿用守方
          </BaseButton>
          <BaseButton
            v-for="option in stack.options"
            :key="`${option.kind}|${option.terrain}`"
            size="sm"
            :variant="
              stackChoiceValue(stack.key) === `${option.kind}|${option.terrain}`
                ? 'secondary'
                : 'ghost'
            "
            @click="onStackTerrainChange(stack.key, `${option.kind}|${option.terrain}`)"
          >
            {{ option.kind === 'hex' ? '格内' : '格边' }}：{{ option.terrain }}
          </BaseButton>
        </div>
        <div v-if="canActCombatRole('defender')" class="row">
          <span class="num">守方防御地形</span>
          <BaseButton
            v-for="name in workbench.combatDefenderTerrainOptions"
            :key="name"
            size="sm"
            :variant="isDefenderTerrain(name) ? 'secondary' : 'ghost'"
            @click="workbench.combatInputs.defenderTerrain = name"
          >
            {{ name }}
          </BaseButton>
        </div>
        <p v-if="!canActAnyCombatRole" class="muted">对方正在宣布地形…</p>
        <div v-if="canActAnyCombatRole" class="row">
          <!--
              B30（用户口径 #19）：地形是**玩家选的**，选完这一下之后「攻防比 / 奇袭 / 战斗骰」
              三步是骰子与查表 ⇒ **自动连跑**到战果（骰面走种子化 RNG，结算日志可复算）。
              要逐步复核时，下面 ⑥⑦ 两节的手动按钮仍在（验证路径）。
            -->
          <BaseButton variant="primary" size="sm" @click="workbench.autoResolveCombatToOutcome()">
            确认地形 ⇒ 自动结算到战果
          </BaseButton>
          <RuleTip rule="9.7 / 9.8 / 9.9">
            确认地形后按 9.7 取攻防比，再掷奇袭（9.8）与战斗骰（9.9）并查表，直接进入战果。
          </RuleTip>
          <BaseButton
            v-if="props.stepwise"
            variant="ghost"
            size="sm"
            @click="workbench.declareCombatTerrainStep()"
          >
            只确认地形（逐步复核）
          </BaseButton>
        </div>
      </SessionStep>

      <!-- 第 6 步：奇袭（9.8）——B30 起通常已被"确认地形 ⇒ 自动结算"连跑过；本节是逐步复核路径 -->
      <SessionStep item="combat:surprise">
        <div v-if="props.stepwise" class="row">
          <BaseButton variant="secondary" size="sm" @click="workbench.rollCombatSurprise()">
            {{
              workbench.combatAwaitingShiftDie ? '补掷横移骰（1d6）' : '掷奇袭骰（2d6，逐步复核）'
            }}
          </BaseButton>
        </div>
        <p v-if="workbench.combatAwaitingShiftDie" class="bad">已发生奇袭：须补掷横移骰</p>
      </SessionStep>

      <!-- 第 7 步：战斗掷骰（9.9）——同上，通常已自动跑过 -->
      <SessionStep item="combat:battleDice">
        <div v-if="props.stepwise" class="row">
          <BaseButton variant="secondary" size="sm" @click="workbench.rollCombatDice()">
            掷战斗骰（2d6，逐步复核）
          </BaseButton>
        </div>
      </SessionStep>

      <!-- 第 8 步（a）：强制军力损失（9.11） -->
      <SessionStep item="combat:losses">
        <!-- 批 C：守方段顶部只列攻方已结算的损失/选项，不放说明文字 -->
        <div v-if="settledAttacker !== null" class="row">
          <BaseTag kind="info">对方已结算</BaseTag>
          <span class="num">损失 {{ settledAttacker.lostSteps }} 点</span>
          <span v-if="settledAttacker.retreatHexes > 0" class="num">
            撤退 {{ settledAttacker.retreatHexes }} 格
          </span>
          <span v-if="settledAttacker.ignored" class="num">忽略选项</span>
        </div>
        <template v-if="canActResolver">
          <p class="num">
            {{
              roleName(state.resolution.stage.startsWith('attacker') ? 'attacker' : 'defender')
            }}结算<template v-if="resolverNotation !== ''"> · {{ resolverNotation }}</template
            >：需承受 {{ workbench.combatRequirement?.losses ?? 0 }} 点
            <RuleTip rule="9.11b / 9.11c">
              AR 单位先受第一点，之后每人各受一点；超出承受范围的损失忽略。
            </RuleTip>
          </p>
          <p class="muted num">
            规范分配：
            {{
              workbench.combatCanonicalLosses
                .map((item) => `${nameOf(item.unitId)} −${item.steps}`)
                .join('、') || '无'
            }}
          </p>
          <!--
              ★ 批 F 切片 2（9.11a 原文「在 9.11c 的限制范围内，由**拥有者玩家**决定由哪个或哪些单位
                承受军力损失」）：当规范分配里**某单位受 2 点**而**另有单位只受 1 点**时，玩家可以把
                那一点**改派**给另一枚（两枚互换点数，仍满足 9.11c 的"均匀展开"）。
              修前引擎要求提交的分配与规范分配**逐单位一致** ⇒ 这种合法选择会被误判违规。
          -->
          <div v-if="workbench.combatLossSwapChoices.length > 0" class="row">
            <span class="muted"
              >多受的那一点改派给
              <RuleTip rule="9.11a">在 9.11c 的限制内由拥有者决定由哪些单位承受。</RuleTip>
            </span>
            <BaseButton
              v-if="workbench.combatInputs.lossTakerId !== null"
              variant="ghost"
              size="sm"
              @click="workbench.combatInputs.lossTakerId = null"
            >
              规范分配
            </BaseButton>
            <BaseButton
              v-for="choice in workbench.combatLossSwapChoices"
              :key="choice.unitId"
              :variant="
                workbench.combatInputs.lossTakerId === choice.unitId ? 'primary' : 'secondary'
              "
              size="sm"
              @click="workbench.combatInputs.lossTakerId = choice.unitId"
            >
              {{ choice.label }}
            </BaseButton>
          </div>
          <div class="row">
            <BaseButton variant="primary" size="sm" @click="workbench.confirmCombatLosses()">
              确认强制损失
            </BaseButton>
          </div>
        </template>
        <p v-else class="muted">对方正在分配强制损失…</p>
      </SessionStep>

      <!-- 第 8 步（b）：选项（9.10）—— 一屏一决策：算子图记损失、地图点格记撤退、底部唯一出口 -->
      <SessionStep item="combat:options">
        <!-- 批 C：守方段顶部只列攻方已结算的损失/选项，不放说明文字 -->
        <div v-if="settledAttacker !== null" class="row">
          <BaseTag kind="info">对方已结算</BaseTag>
          <span class="num">损失 {{ settledAttacker.lostSteps }} 点</span>
          <span v-if="settledAttacker.retreatHexes > 0" class="num">
            撤退 {{ settledAttacker.retreatHexes }} 格
          </span>
          <span v-if="settledAttacker.ignored" class="num">忽略选项</span>
        </div>
        <template v-if="canActResolver">
          <p class="num">
            {{
              roleName(state.resolution.stage.startsWith('attacker') ? 'attacker' : 'defender')
            }}结算<span v-if="resolverNotation !== ''"> · {{ resolverNotation }}</span> · 还剩
            {{ workbench.optionDraftRemaining }} 点
            <RuleTip rule="9.10a / 9.11c">
              第一点必须由 AR 单位承受；各单位各受一点后才能有单位受第二点。
              <br />
              撤退格数与损失军力可任意组合，满点才能提交。
            </RuleTip>
          </p>
          <!--
            ★ 条 15/16（批 F·F1）+ 重做（§5 S6）：不再先选「受损 / 撤退」模式——
            点本结算方算子图即受损，地图上三色格即撤退，两件事同屏；每次只进草稿，提交时一发结算。
          -->
          <CounterPicker
            v-if="optionLossItems.length > 0"
            title="受损"
            :items="optionLossItems"
            :size="40"
            @pick="workbench.applyOptionDraftLoss($event)"
            @hover="hoverUnit"
          />
          <!-- 9.12（C1）：按当前撤退格数**将被消灭**的单位（一行状态；解释进 ?） -->
          <p v-if="retreatWipeLabels !== ''" class="warn num">
            将被消灭：{{ retreatWipeLabels }}
            <RuleTip rule="9.12">
              排除战斗开始时敌方格后无合法落点、或只有必被消灭的落点（9.12b / 5.8a）⇒
              确认撤退时该单位被消灭。
            </RuleTip>
          </p>
          <div class="row">
            <!-- 9.10c 唯一出口：可用且尚未分配点数时替掉「提交选项」（两者互斥） -->
            <BaseButton
              v-if="workbench.optionIgnoreAvailableNow && workbench.optionDraftUsed === 0"
              variant="primary"
              size="sm"
              title="9.10c"
              @click="workbench.confirmCombatIgnoreOptions()"
            >
              忽略选项
            </BaseButton>
            <!-- 9.10a：点数分配完才出现提交（未分完不置灰，直接不出现，剩余点数留在上方） -->
            <BaseButton
              v-else-if="workbench.optionDraftRemaining === 0"
              variant="primary"
              size="sm"
              title="9.10"
              @click="workbench.confirmCombatOptions()"
            >
              提交选项
            </BaseButton>
            <BaseButton
              v-if="workbench.optionDraftEntries.length > 0"
              variant="ghost"
              size="sm"
              @click="workbench.undoOptionDraftLast()"
            >
              撤销上一次
            </BaseButton>
          </div>
        </template>
        <p v-else class="muted">对方正在分配选项…</p>
      </SessionStep>

      <!-- 第 9 步：撤退（9.12） -->
      <SessionStep item="combat:retreat">
        <RuleTip rule="9.12">
          <p class="muted">
            撤退格数 ＝
            该方剩余选项数；落点与起始格的直线距离必须等于该格数，路径可之字形避开禁入地形。
          </p>
        </RuleTip>
        <p
          v-if="retreatPlan === null && workbench.combatRetreatSkippedSides.length === 0"
          class="muted"
        >
          无人需要撤退
        </p>
        <!-- 9.12：选项点名的撤退方已无存活参战单位 ⇒ 无撤退对象，确认即收束 -->
        <p
          v-if="retreatPlan === null && workbench.combatRetreatSkippedSides.length > 0"
          class="muted"
        >
          <BaseTag kind="warning">无存活单位</BaseTag>
          无撤退对象，确认即收束
        </p>
        <template v-if="retreatPlan !== null">
          <p class="num">
            {{ retreatPlan.side === 'attacker' ? '攻方' : '守方' }}落点：{{
              retreatPlan.complete
                ? retreatPlan.units.some((unit) => unit.noLanding === true)
                  ? '已齐（含将被消灭的单位）'
                  : '已选齐'
                : '待选'
            }}
          </p>
          <template v-if="canActCombatRole(retreatPlan.side)">
            <div v-for="row in retreatPlan.units" :key="row.unitId" class="row">
              <!-- 点这一行＝切换"现在给谁选"（与地图点击的同一个 `retreatUnit`） -->
              <BaseButton
                :variant="retreatUnit?.unitId === row.unitId ? 'primary' : 'secondary'"
                size="sm"
                @click="mapView.setRetreatUnit(row.unitId)"
              >
                {{ row.label }} @ {{ hexLabel(row.from) }}
              </BaseButton>
              <span class="num">
                落点：{{ row.chosen === null ? '（未选）' : hexLabel(row.chosen) }}
              </span>
              <!-- 9.12（C1）：不可通行格排除后无落点 ⇒ 允许确认，但必须明示消灭后果 -->
              <span v-if="row.noLanding === true" class="warn num">
                无合法落点：确认后该单位被消灭
              </span>
              <span
                v-else-if="
                  row.destinations.length > 0 &&
                  row.destinations.every((destination) => destination.forcedDestruction)
                "
                class="warn num"
              >
                只有必被消灭的落点
              </span>
            </div>
            <!-- 9.12e：撤退堆叠在进入敌方 ZOC 前已有 DG ⇒ 额外 1 点损失的承受者由拥有者选 -->
            <div v-if="extraLossPreview !== null" class="row">
              <span class="warn num">
                额外损失 {{ extraLossPreview.points }} 点：由谁承受
                <RuleTip rule="9.12e">
                  撤退堆叠在进入敌方 ZOC 前已有 DG ⇒ 额外损失 1 点军力；承受者由拥有者从撤退中的 DG
                  单位里选。
                </RuleTip>
              </span>
              <BaseButton
                v-for="choice in extraLossPreview.choices"
                :key="choice.unit.instanceId"
                :variant="choice.selected ? 'primary' : 'secondary'"
                size="sm"
                @click="workbench.chooseExtraLossTaker(choice.unit.instanceId)"
              >
                {{ choice.selected ? '✓ ' : '' }}{{ choice.unit.name }}
              </BaseButton>
            </div>
            <!-- 9.12d：跟随者并入候选按钮（已选的显示 ✓），不再另起一份只读名单 -->
            <div v-if="workbench.combatTagalongCandidates.length > 0" class="row">
              <BaseButton
                v-for="item in workbench.combatTagalongCandidates"
                :key="item.unit.instanceId"
                variant="secondary"
                size="sm"
                @click="workbench.toggleCombatTagalong(item.unit.instanceId)"
              >
                {{ workbench.combatTagalongIds.includes(item.unit.instanceId) ? '✓ ' : ''
                }}{{ item.unit.name }}（随 {{ item.hostLabel }}）
              </BaseButton>
            </div>
          </template>
          <p v-else class="muted">对方正在选择撤退落点…</p>
        </template>
        <div class="row">
          <BaseButton
            v-if="
              retreatPlan === null || (retreatPlan.complete && canActCombatRole(retreatPlan.side))
            "
            variant="primary"
            size="sm"
            @click="workbench.confirmCombatRetreats()"
          >
            确认撤退
          </BaseButton>
        </div>
      </SessionStep>

      <!-- 第 9 步：战后推进与进击（9.12g / 9.13） -->
      <SessionStep item="combat:advance">
        <template v-if="canActCombatRole('attacker')">
          <!-- B33：突袭的推进是**强制**的（9.12g-D）⇒ 说明与按钮按这个口径给 -->
          <p v-if="workbench.combatAdvanceMandatory" class="warn num">
            <BaseTag kind="danger">突袭</BaseTag>
            本次必须推进
            <RuleTip rule="9.12g-D / 8.0 / 9.14">
              成功的突袭必须战后推进：防御方撤退或被摧毁 ⇒ 所有攻击单位进入该格，无需额外 MP。 因
              9.14 位移待决时，位移落点选定后即自动收束。
            </RuleTip>
          </p>
          <p class="num">
            防御格 {{ workbench.combatDefendingHexCleared ? '已空' : '未空' }}；{{
              workbench.combatDefendingHexCleared ? '可推进' : '本场不推进'
            }}
          </p>
          <RuleTip rule="9.12g-A / 9.13">
            只有付了战斗补给的单位（含战斗值为零的）才能推进；进击标记须满足攻击阶段、非 DG、
            非突袭、攻方把全部选项选为军力损失等条件。
          </RuleTip>
          <!--
            9.12g-D：「由拥有者玩家选择哪些攻击单位进行推进（如果有的话）」
            ⇒ 入口是地图推进格（点它即预选）；这里只做同一张卡里的改选与确认。
          -->
          <div v-if="advanceSelectable.length > 0" class="row">
            <BaseButton
              v-for="choice in advanceSelectable"
              :key="choice.unit.instanceId"
              :variant="choice.selected ? 'secondary' : 'ghost'"
              size="sm"
              @click="workbench.toggleAdvanceUnit(choice.unit.instanceId)"
            >
              {{ choice.selected ? '✓ ' : '' }}{{ choice.unit.name }}
            </BaseButton>
          </div>
          <p v-if="advanceBlockedCount > 0" class="muted">
            另有 {{ advanceBlockedCount }} 枚不可推进
          </p>
          <div class="row">
            <BaseButton variant="primary" size="sm" @click="workbench.confirmCombatAdvance()">
              {{ advanceButtonLabel }}
            </BaseButton>
          </div>
        </template>
        <p v-else class="muted">对方正在处理战后推进…</p>
      </SessionStep>

      <!-- U1-b：战果与复核是回执（非待决），折叠后备查；R-4：只在验证页出现，不挂在会话框里 -->
      <details
        v-if="
          props.stepwise && (workbench.combatSummary !== null || workbench.combatReview !== null)
        "
        class="extra"
      >
        <summary class="extra__head num">战果与复核（只读）</summary>
        <!-- 战果展示（9.9） -->
        <div v-if="workbench.combatSummary !== null" class="result">
          <p class="num">
            <BaseTag kind="success">CRT {{ workbench.combatSummary.raw }}</BaseTag>
            2d6 {{ workbench.combatSummary.die }} ⇒ 修正骰
            {{ workbench.combatSummary.modifiedDice }}｜ {{ workbench.combatSummary.terrainLine }} /
            {{ workbench.combatSummary.ratio }}
            <span v-if="workbench.combatSummary.surprise !== null">
              ｜奇袭
              {{
                workbench.combatSummary.surprise.side === 'attacker'
                  ? '攻方'
                  : workbench.combatSummary.surprise.side === 'defender'
                    ? '守方'
                    : '无'
              }}
              （横移 {{ workbench.combatSummary.surprise.shift }}）
            </span>
          </p>
          <p class="num">
            攻方：L{{ workbench.combatSummary.attacker.losses }} + o{{
              workbench.combatSummary.attacker.options
            }}
            <span v-if="workbench.combatSummary.attacker.exploit !== undefined">
              · e{{ workbench.combatSummary.attacker.exploit }}
            </span>
            <span v-if="workbench.combatSummary.attacker.optionTaken !== null">
              （已结算：撤 {{ workbench.combatSummary.attacker.optionTaken.retreatHexes }} / 损
              {{ workbench.combatSummary.attacker.optionTaken.lossPoints }}）
            </span>
          </p>
          <p class="num">
            守方：L{{ workbench.combatSummary.defender.losses }} + o{{
              workbench.combatSummary.defender.options
            }}
            <span v-if="workbench.combatSummary.defender.dg">· DG</span>
            <span v-if="workbench.combatSummary.defender.ignored">· 已忽略选项</span>
            <span v-else-if="workbench.combatSummary.defender.optionTaken !== null">
              （已结算：撤 {{ workbench.combatSummary.defender.optionTaken.retreatHexes }} / 损
              {{ workbench.combatSummary.defender.optionTaken.lossPoints }}）
            </span>
          </p>
        </div>

        <!-- W7 C11：结算复核（骰点 / 计算过程 / 规则编号 / 修正来源；可展开逐项核对） -->
        <div v-if="workbench.combatReview !== null" class="review">
          <p class="review__head num">
            结算复核（{{ workbench.combatReview.rule }}）：骰点 · 计算过程 · 修正来源
          </p>
          <DerivationSteps :derivation="workbench.combatReview" />
        </div>
      </details>

      <div class="row">
        <!-- P5：已提交但未结算完 ⇒ 先明说「须完成结算」，而不是点了「放弃」才被拒 -->
        <p v-if="cancelBlocker !== null" class="warn num">
          <BaseTag kind="warning">须完成结算</BaseTag>
          {{ cancelBlocker }}
        </p>
        <!-- R15（K10）：「×」在提交后是 refused（置灰），本按钮同口径 —— 有挡因即 disabled -->
        <BaseButton
          v-if="cancelBlocker === null"
          variant="ghost"
          size="sm"
          @click="workbench.cancelCombat()"
          >放弃本场战斗</BaseButton
        >
        <BaseButton
          v-if="props.stepwise && state.finished"
          variant="secondary"
          size="sm"
          @click="workbench.clearCombat()"
        >
          清理并关闭
        </BaseButton>
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

/* W7 C11：结算复核（默认展开，可收起） */
.review {
  margin: var(--space-2) 0;
}

/* U1-b：战果与复核折叠区 */
.extra {
  margin: var(--space-2) 0;
}

.extra__head {
  margin-bottom: var(--space-1);
  color: var(--color-muted);
  font-size: var(--text-sm);
  cursor: pointer;
}

.review__head {
  margin-bottom: var(--space-1);
  color: var(--color-muted);
  font-size: var(--text-sm);
  cursor: pointer;
}

.field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.select {
  max-width: 240px;
  padding: 4px var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

/* B7：守方支付与它里面的储备行 */
.check-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.check--nested {
  margin-left: var(--space-4);
}

.picks {
  list-style: none;
  margin: 0 0 var(--space-2);
  padding: 0;
  font-size: var(--text-xs);
}

.result {
  border-top: 1px dashed var(--color-rule);
  padding-top: var(--space-2);
  margin-bottom: var(--space-2);
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.ok {
  color: var(--color-accent-2);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.bad {
  color: var(--color-accent);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}
</style>
