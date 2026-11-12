<script setup lang="ts">
import { computed, watch } from 'vue'

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
    ? '推进并结束（9.12g / 9.13）'
    : '结束战斗（不推进）',
)

/** 9.12e：撤退堆叠的额外损失由谁承受（候选＝撤退中的 DG 单位，与引擎确认同源） */
const extraLossPreview = computed(() => workbench.combatExtraLossPreview)

/**
 * 进入推进步时把"可推进者"默认全选（9.12g-D：拥有者可选哪些，本批不强迫玩家先点地图）。
 * 取消其中几枚就在面板上点一下；全部取消＝按 9.13 结束（不推进）。不写日志、不动引擎。
 */
watch(
  () => state.value?.step === 'advance' && state.value?.finished !== true,
  (inAdvance) => {
    if (!inAdvance || workbench.combatAdvanceHex === null) return
    if (workbench.combatInputs.advanceUnitIds.length > 0) return
    const ids = advanceSelectable.value.map((choice) => choice.unit.instanceId)
    if (ids.length > 0) workbench.combatInputs.advanceUnitIds = ids
  },
  { immediate: true },
)

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

/** 正在选落点的一方（与地图高亮**同一份**计划；修前面板读的是"永远先攻方"的那份） */
const retreatPlan = computed(() => mapView.retreatSidePlan)
/** 正在选落点的那一枚（点行即切换；地图点格后自动跳到下一枚未选的） */
const retreatUnit = computed(() => mapView.retreatUnit)

/*
 * 9.12g 推进候选勾选：**入口已收口到地图小窗**（批 F·E4），勾选动作上移到 store
 * （`workbench.toggleAdvanceUnit`），本面板只读 `combatAdvanceChoices` 展示。
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

/** 9.10/9.11c：选项损失的逐单位候选（角标＝草稿已损；可损尽的置灰，不另摆文字按钮） */
const optionLossItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.combatOptionLossTargets.map((target) => {
    const taken = workbench.combatInputs.optionLossAllocation[target.id] ?? 0
    const unit = unitOf(target.id)
    const reason =
      workbench.optionDraftRemaining <= 0
        ? '选项点数已分配完'
        : taken >= target.steps
          ? '已无军力可损'
          : null
    return {
      id: target.id,
      imageUrl: unit === null ? null : counterImageUrlOf(unit),
      name: `${target.name}（军力 ${target.steps}，草稿已损 ${taken}）`,
      selected: taken > 0,
      disabledReason: reason,
      hex: target.hex,
      ...(taken > 0 ? { badge: `−${taken}` } : {}),
    }
  }),
)
</script>

<template>
  <BasePanel title="战斗">
    <!-- 未开始：选择攻方与防御格 -->
    <SessionStep v-if="state === null" item="combat:declare">
      <RuleTip rule="9.1b / 9.1c">
        点己方算子＝加入攻方（可跨多个相邻格）；点敌方算子所在格＝选定防御格。
      </RuleTip>
      <p v-if="workbench.battleTarget === null" class="num">
        <BaseTag kind="danger">可攻击</BaseTag>
        地图上<span v-if="workbench.combatAttackableHexes.length > 0">高亮</span
        >{{ workbench.combatAttackableHexes.length }} 处敌方格（随选人实时算；点它即选定防御格）。
      </p>
      <p class="num">
        攻方（{{ attackerList.length }}）：
        {{ attackerList.map((unit) => unit.name).join('、') || '—' }}
      </p>
      <p class="num">
        防御格：
        <template v-if="workbench.battleTarget !== null">
          {{ hexLabel(workbench.battleTarget.hex) }}（守方
          {{ workbench.battleDefenders.length }} 个战斗单位）
        </template>
        <template v-else>—</template>
      </p>
      <div class="row">
        <BaseButton variant="primary" size="sm" title="9.1" @click="workbench.beginCombatNow()">
          开始战斗
        </BaseButton>
        <BaseButton variant="ghost" size="sm" @click="workbench.clearCombat()">
          清除选择
        </BaseButton>
      </div>
    </SessionStep>

    <!-- 流程中 -->
    <template v-else>
      <p v-if="workbench.combatError !== null" class="bad">
        <BaseTag kind="danger">{{ workbench.combatError.rule }}</BaseTag>
        {{ workbench.combatErrorLine }}
      </p>
      <!-- C8：补给一旦确认，存档/读档即被 settlementBlockedReason 拒绝；在此后全程显式说明 -->
      <p v-if="workbench.combatSupplyCommitted" class="muted">
        <BaseTag kind="warning">9.2</BaseTag>
        本场战斗须一次打完：收束前不能保存或读取对局。
      </p>

      <!-- 第 2 步：战斗补给（9.5 / 12.4） -->
      <SessionStep item="combat:supply">
        <div class="row">
          <BaseTag kind="info"> 攻方来源：{{ declaredDumpOf('attacker') ?? '未声明' }} </BaseTag>
          <BaseTag kind="info"> 守方来源：{{ declaredDumpOf('defender') ?? '未声明' }} </BaseTag>
          <RuleTip rule="9.5 / 12.4">
            攻方须付足全部所需 T（不足则取消攻击）；守方可不付（以一半战斗值防御，9.5-B）。
            在地图上点补给站即声明付款来源（12.4）；来源为「未声明」时无法付款。
          </RuleTip>
        </div>
        <div
          v-if="declaredDumpOf('attacker') !== null || declaredDumpOf('defender') !== null"
          class="row"
        >
          <BaseButton
            v-if="declaredDumpOf('attacker') !== null"
            variant="ghost"
            size="sm"
            @click="workbench.clearCombatSupplyDump('attacker')"
          >
            清除攻方来源
          </BaseButton>
          <BaseButton
            v-if="declaredDumpOf('defender') !== null"
            variant="ghost"
            size="sm"
            @click="workbench.clearCombatSupplyDump('defender')"
          >
            清除守方来源
          </BaseButton>
        </div>
        <label class="check">
          <input v-model="workbench.combatInputs.defenderProvides" type="checkbox" />
          守方支付
        </label>
        <label class="check">
          <input v-model="workbench.combatInputs.attackerUsesInternalStocks" type="checkbox" />
          攻方用储备
        </label>
        <label class="check">
          <input v-model="workbench.combatInputs.defenderUsesInternalStocks" type="checkbox" />
          守方用储备
        </label>
        <!-- B14c：参战攻方＝**算子图阵列**；9.5b 的取消/恢复与 9.11c 的损失分配都按这份名单 -->
        <CounterPicker
          title="参战攻方"
          hint="点一枚即取消它的参战（再点回来）"
          :items="supplyAttackerItems"
          :size="40"
          @pick="workbench.toggleCombatSupplyAttacker($event)"
          @hover="hoverUnit"
        />
        <div class="row">
          <BaseButton
            variant="primary"
            size="sm"
            title="9.5"
            @click="workbench.confirmCombatSupply()"
          >
            确认战斗补给
          </BaseButton>
          <!-- C8：写在确认按钮旁，确认前就能看到「本场战斗须一次打完」 -->
          <span class="muted">确认后本场战斗须一次打完：收束前不能保存或读取对局（9.2）</span>
        </div>
      </SessionStep>

      <!-- 第 3 步：宣布行动值（9.6：攻方先、守方后） -->
      <SessionStep item="combat:ar:attacker">
        <!-- B14c：AR 单位＝**算子图阵列**（原来是两个纯文字下拉） -->
        <CounterPicker
          title="攻方 AR 单位"
          hint="9.6：每方只能选一个参战单位担任行动值；DG 单位 −1"
          :items="attackerArItems"
          :size="40"
          @pick="workbench.combatInputs.attackerArUnitId = $event"
          @hover="hoverUnit"
        />
        <div class="row">
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="workbench.combatInputs.attackerArUnitId === null"
            @click="workbench.declareCombatArStep('attacker')"
          >
            攻方宣布
          </BaseButton>
        </div>
      </SessionStep>

      <SessionStep item="combat:ar:defender">
        <p class="num">攻方已宣布：{{ nameOf(state.declaredAttackerArUnitId ?? '') }}</p>
        <CounterPicker
          title="守方 AR 单位"
          :hint="
            workbench.nkvdArRequiredNow
              ? '专规 2.3b：守方堆叠内有 NKVD 边防团 ⇒ 行动值单位只能从它们中选（阵列已收窄）'
              : '9.6：每方只能选一个参战单位担任行动值；DG 单位 −1'
          "
          :items="defenderArItems"
          :size="40"
          @pick="workbench.combatInputs.defenderArUnitId = $event"
          @hover="hoverUnit"
        />
        <div class="row">
          <BaseButton
            variant="primary"
            size="sm"
            title="9.6"
            :disabled="workbench.combatInputs.defenderArUnitId === null"
            @click="workbench.declareCombatArStep('defender')"
          >
            守方宣布并继续
          </BaseButton>
        </div>
      </SessionStep>

      <!-- 第 4 步：宣布地形与初始攻防比（9.4 / 9.7） -->
      <SessionStep item="combat:terrain">
        <RuleTip rule="9.4b / 9.4c">
          攻方每个攻击堆叠可选「防御格内地形」或「所穿越的格边地形」（不累计）；守方只能选防御格内地形，并决定战斗表横行。
        </RuleTip>
        <div v-for="stack in workbench.combatStackTerrainOptions" :key="stack.key" class="row">
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
        <div class="row">
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
        <div class="row">
          <!--
              B30（用户口径 #19）：地形是**玩家选的**，选完这一下之后「攻防比 / 奇袭 / 战斗骰」
              三步是骰子与查表 ⇒ **自动连跑**到战果（骰面走种子化 RNG，结算日志可复算）。
              要逐步复核时，下面 ⑥⑦ 两节的手动按钮仍在（验证路径）。
            -->
          <BaseButton
            variant="primary"
            size="sm"
            title="9.7 / 9.8 / 9.9"
            @click="workbench.autoResolveCombatToOutcome()"
          >
            确认地形 ⇒ 自动结算到战果
          </BaseButton>
          <BaseButton
            v-if="props.stepwise"
            variant="ghost"
            size="sm"
            @click="workbench.declareCombatTerrainStep()"
          >
            只确认地形（逐步复核）
          </BaseButton>
        </div>
        <p v-if="state.odds !== undefined" class="ok num">
          初始攻防比 {{ state.odds.oddsLabel }}（守方格 {{ state.odds.terrain.defenderTerrain }} /
          {{ state.odds.terrain.combatLine }}；军力 {{ state.odds.attackerTotal }} :
          {{ state.odds.defenderTotal }}）
        </p>
      </SessionStep>

      <!-- 第 6 步：奇袭（9.8）——B30 起通常已被"确认地形 ⇒ 自动结算"连跑过；本节是逐步复核路径 -->
      <SessionStep item="combat:surprise">
        <div v-if="props.stepwise" class="row">
          <BaseButton variant="secondary" size="sm" @click="workbench.rollCombatSurprise()">
            {{
              workbench.combatAwaitingShiftDie ? '补掷横移骰（1d6）' : '掷奇袭骰（2d6，逐步复核）'
            }}
          </BaseButton>
          <span class="muted">（逐步复核用；正常流程不必点这里的按钮。）</span>
        </div>
        <p v-if="workbench.combatAwaitingShiftDie" class="bad">
          已发生奇袭：按 9.8 须**再掷一枚骰子**决定横移列数。
        </p>
      </SessionStep>

      <!-- 第 7 步：战斗掷骰（9.9）——同上，通常已自动跑过 -->
      <SessionStep item="combat:battleDice">
        <p class="num">
          列位：{{ state.surprise?.finalColumnLabel ?? state.odds?.oddsLabel ?? '—' }}；DRM
          {{ state.ar?.drm ?? 0 }}；工事等级 {{ state.hedgehogLevel }}
        </p>
        <div v-if="props.stepwise" class="row">
          <BaseButton variant="secondary" size="sm" @click="workbench.rollCombatDice()">
            掷战斗骰（2d6，逐步复核）
          </BaseButton>
        </div>
      </SessionStep>

      <!-- 第 8 步（a）：强制军力损失（9.11） -->
      <SessionStep item="combat:losses">
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
            variant="ghost"
            size="sm"
            :disabled="workbench.combatInputs.lossTakerId === null"
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
          <BaseButton
            variant="primary"
            size="sm"
            title="9.11c"
            @click="workbench.confirmCombatLosses()"
          >
            确认强制损失
          </BaseButton>
        </div>
      </SessionStep>

      <!-- 第 8 步（b）：选项（9.10）—— 一屏一决策：算子图记损失、地图点格记撤退、底部唯一出口 -->
      <SessionStep item="combat:options">
        <p class="num">
          {{
            roleName(state.resolution.stage.startsWith('attacker') ? 'attacker' : 'defender')
          }}结算<span v-if="resolverNotation !== ''"> · {{ resolverNotation }}</span> · 还剩
          {{ workbench.optionDraftRemaining }} 点
          <RuleTip rule="9.10a / 9.11c">
            撤退格数与损失军力可任意组合，组合后必须完全满足选项点数；未分配的点数按规范分配折成军力损失。
            第一点必须由 AR 单位承受；各单位各受一点后才能有单位受第二点。
          </RuleTip>
        </p>
        <!--
            ★ 条 15/16（批 F·F1）+ 重做（§5 S6）：不再先选「受损 / 撤退」模式——
            点本结算方算子图即受损，地图上三色格即撤退，两件事同屏；每次只进草稿，提交时一发结算。
          -->
        <CounterPicker
          title="受损"
          hint="点算子图＝记 1 点军力损失；地图三色格＝可撤退格，点格按该格距离记撤退"
          :items="optionLossItems"
          :size="40"
          @pick="workbench.applyOptionDraftLoss($event)"
          @hover="hoverUnit"
        />
        <!-- 9.12（C1）：选项步当场预演第 9 步落点，避免先放行、后永久灰显（长句进 ?） -->
        <RuleTip v-if="workbench.combatOptionRetreatWarning.length > 0" rule="9.12">
          <p
            v-for="item in workbench.combatOptionRetreatWarning"
            :key="`retreat-warning-${item.unitId}`"
            class="warn num"
          >
            {{ item.label }}：{{
              item.kind === 'noLanding'
                ? '排除战斗开始时敌方格后无合法落点，确认撤退时将按 9.12 消灭'
                : '只有必被消灭的撤退落点（9.12/9.12b/5.8a）'
            }}
          </p>
        </RuleTip>
        <div class="row">
          <!-- 条 16（批 F·F1）：攻方全灭 ⇒ 守方「结束战斗」一键 -->
          <BaseButton
            v-if="workbench.attackerWipedNow"
            variant="primary"
            size="sm"
            title="9.10c 例 B"
            @click="workbench.concludeCombatAfterWipe()"
          >
            结束战斗
          </BaseButton>
          <!-- 9.10c 唯一出口：可用且尚未分配点数时替掉「提交选项」（两者互斥） -->
          <BaseButton
            v-else-if="workbench.optionIgnoreAvailableNow && workbench.optionDraftUsed === 0"
            variant="primary"
            size="sm"
            title="9.10c"
            @click="workbench.confirmCombatIgnoreOptions()"
          >
            行使 9.10c：忽略选项
          </BaseButton>
          <!-- 剩余点数不要求点满：提交时按规范分配折成军力损失（9.10a / 9.11c） -->
          <BaseButton
            v-else
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
      </SessionStep>

      <!-- 第 9 步：撤退（9.12） -->
      <SessionStep item="combat:retreat">
        <RuleTip rule="9.12">
          <p class="muted">
            撤退格数 ＝
            该方剩余选项数；落点与起始格的直线距离必须等于该格数，路径可之字形避开禁入地形。
            <BaseTag kind="success">青绿＝可撤退</BaseTag>
            <BaseTag kind="warning">橙红＝落点在敌方控制区</BaseTag>
            <BaseTag kind="danger">暗红＝必被消灭</BaseTag>
          </p>
        </RuleTip>
        <div class="row">
          <BaseTag kind="info">
            攻方需撤 {{ workbench.combatRetreatRequirement.attacker }} 格
          </BaseTag>
          <BaseTag kind="info">
            守方需撤 {{ workbench.combatRetreatRequirement.defender }} 格
          </BaseTag>
        </div>
        <p
          v-if="retreatPlan === null && workbench.combatRetreatSkippedSides.length === 0"
          class="muted"
        >
          本场战斗无人需要撤退（双方选项都未含撤退格数）。
        </p>
        <!-- 9.12：选项点名的撤退方已无存活参战单位 ⇒ 无撤退对象，确认即收束 -->
        <p
          v-if="retreatPlan === null && workbench.combatRetreatSkippedSides.length > 0"
          class="muted"
        >
          <BaseTag kind="warning">9.12 / 无存活单位</BaseTag>
          点名要撤退的{{ workbench.combatRetreatSkippedSides.includes('attacker') ? '攻方' : ''
          }}{{
            workbench.combatRetreatSkippedSides.includes('defender') ? '守方' : ''
          }}已无存活参战单位 ⇒ 无撤退对象（格数记 0），确认即收束。
        </p>
        <template v-if="retreatPlan !== null">
          <p class="num">
            现在给{{ retreatPlan.side === 'attacker' ? '攻方' : '守方' }}选落点：{{
              retreatPlan.complete
                ? retreatPlan.units.some((unit) => unit.noLanding === true)
                  ? '已齐（含将被消灭的单位）'
                  : '已选齐'
                : '点地图上的高亮格'
            }}
          </p>
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
              落点：{{ row.chosen === null ? '（未选）' : hexLabel(row.chosen) }}｜候选
              {{ row.destinations.length }} 格
            </span>
            <!-- 9.12（C1）：不可通行格排除后无落点 ⇒ 允许确认，但必须明示消灭后果 -->
            <span v-if="row.noLanding === true" class="warn num">
              <BaseTag kind="danger">9.12</BaseTag>
              无合法落点：确认后该单位被消灭
            </span>
            <span
              v-else-if="
                row.destinations.length > 0 &&
                row.destinations.every((destination) => destination.forcedDestruction)
              "
              class="warn num"
            >
              <BaseTag kind="warning">9.12</BaseTag>
              只有必被消灭的落点
            </span>
            <BaseButton
              v-if="row.chosen !== null"
              variant="ghost"
              size="sm"
              @click="workbench.clearRetreatDestinationNow(row.unitId)"
            >
              清除落点
            </BaseButton>
          </div>
          <!-- 9.12e：撤退堆叠在进入敌方 ZOC 前已有 DG ⇒ 额外 1 点损失的承受者由拥有者选 -->
          <div v-if="extraLossPreview !== null" class="row">
            <span class="warn num">
              <BaseTag kind="warning">9.12e</BaseTag>
              该堆叠损失 {{ extraLossPreview.points }} 点军力，由谁承受（候选＝撤退中的 DG 单位）：
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
        <div class="row">
          <BaseButton
            variant="primary"
            size="sm"
            title="9.12"
            :disabled="retreatPlan !== null && !retreatPlan.complete"
            @click="workbench.confirmCombatRetreats()"
          >
            确认撤退
          </BaseButton>
        </div>
      </SessionStep>

      <!-- 第 9 步：战后推进与进击（9.12g / 9.13） -->
      <SessionStep item="combat:advance">
        <!-- B33：突袭的推进是**强制**的（9.12g-D）⇒ 说明与按钮按这个口径给 -->
        <p v-if="workbench.combatAdvanceMandatory" class="warn num">
          <BaseTag kind="danger">9.12g-D</BaseTag>
          本次是突袭：成功的突袭必须战后推进（8.0：防御方撤退或被摧毁 ⇒ 所有攻击单位进入该格，
          无需额外 MP）。撤退收束后自动收束，不给"不推进"；若因 9.14 位移待决停在本步，
          位移落点选定后即自动收束。
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
          ⇒ 逐单位勾选在本面板（唯一入口）；地图绿格仍是"点该格＝全选可推进者"的快捷方式。
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
          另有 {{ advanceBlockedCount }} 枚不能推进（9.12g-A 未付补给 / 不可移动）。
        </p>
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="workbench.confirmCombatAdvance()">
            {{ advanceButtonLabel }}
          </BaseButton>
        </div>
      </SessionStep>

      <!-- U1-b：战果与复核是回执（非待决），折叠后备查 -->
      <details
        v-if="workbench.combatSummary !== null || workbench.combatReview !== null"
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
            <span v-if="workbench.combatSummary.defender.ignored">· 已忽略选项（9.10c）</span>
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
          variant="ghost"
          size="sm"
          :disabled="cancelBlocker !== null"
          @click="workbench.cancelCombat()"
          >放弃本场战斗</BaseButton
        >
        <BaseButton
          v-if="state.finished"
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
