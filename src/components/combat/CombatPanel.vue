<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag, RuleNote } from '@/components/base'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
import { DerivationSteps } from '@/components/session'
import UiField from '@/components/UiField.vue'
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
 * 两种模式（同一份盘面状态，二选一）：
 *   · **九步完整流程**（9.2）：走 `engine/rules/combat-interaction.ts` 的状态机 ——
 *     战斗补给（9.5/12.4）→ 行动值（9.6）→ 逐堆叠地形（9.4b/9.4c）→ 奇袭（9.8）→ 战斗骰（9.9）→
 *     强制损失（9.11）→ 选项（9.10）→ 撤退（9.12）→ 战后推进与进击（9.12g/9.13）；
 *   · **一键查表**（9.9 便捷入口）：只想快速看战果时用。
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
/** 第 8 步「结算结果」的两个子环节由 resolution.stage 区分（9.10b：攻方先、守方后） */
const stage = computed(() => state.value?.resolution.stage ?? null)
const isLossStage = computed(
  () => stage.value === 'attackerLosses' || stage.value === 'defenderLosses',
)
const isOptionStage = computed(
  () => stage.value === 'attackerOptions' || stage.value === 'defenderOptions',
)

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
 * 声明由地图点击（`pickCombatSupplyDump`）写入；这里只把它**显示出来**并给一个「清除」按钮
 * （修前 store 里的 `clearCombatSupplyDump` 没人调用 ⇒ 声明后无法改回手填 T）。
 */
function declaredDumpOf(side: 'attacker' | 'defender'): string | null {
  const id = workbench.combatSupplyDumpIds[side]
  if (id === null) return null
  const entry = workbench.combatSupplyDumps.find((item) => item.side === side)
  const dump = entry?.dumps.find((item) => item.id === id)
  return dump === undefined ? id : `${hexLabel(dump.hex)}（${dump.sp} SP / ${dump.t} T）`
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

/* ── 快捷模式（9.9 一键查表）用 ── */

const quickTerrainOptions = computed(() =>
  workbench.battleTarget === null ? [] : workbench.terrainChoicesAt(workbench.battleTarget.hex),
)
const quickDefenderArOptions = computed(() =>
  workbench.battleDefenders.map((unit) => ({
    id: unit.instanceId,
    label: `${unit.name}（AR${unit.raw.ar}）`,
  })),
)
const quickAttacker = computed(() => workbench.selectedUnit)
const quickBattleText = computed(() => {
  const report = workbench.lastBattle
  if (report === null) return null
  return (
    `2d6 ${report.dice.faces.join('+')}=${report.dice.total}｜修正骰 ${report.rule.modifiedDice}` +
    `（AR ${report.attackerAR}−${report.defenderAR}，工事 ${report.hedgehogLevel}）｜` +
    `地形 ${report.terrain}（${report.terrainLine}）｜军力 ${report.attackerStrength}:${report.defenderStrength}=${report.rule.ratio}｜` +
    `CRT「${report.rule.raw}」｜攻方 L${report.rule.attacker.losses}${report.rule.attacker.optionPoints > 0 ? `+o${report.rule.attacker.optionPoints}` : ''}` +
    `${report.rule.attacker.exploitationAR === undefined ? '' : ` e${report.rule.attacker.exploitationAR}`}` +
    `｜守方 L${report.rule.defender.losses}${report.rule.defender.optionPoints > 0 ? `+o${report.rule.defender.optionPoints}` : ''}${report.rule.defender.disorganized ? '+DG' : ''}`
  )
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

/** 快捷模式（9.9）的守方行动值阵列 */
const quickDefenderArItems = computed(() =>
  arItems(quickDefenderArOptions.value, workbench.battleDefenderArId),
)
</script>

<template>
  <BasePanel title="战斗（C6：OCS 9.0）">
    <!-- 模式切换：九步完整流程 / 一键查表 -->
    <div class="row">
      <BaseButton
        v-for="mode in [
          { key: 'full', label: '九步完整流程' },
          { key: 'quick', label: '一键查表' },
        ] as const"
        :key="mode.key"
        variant="secondary"
        size="sm"
        @click="workbench.setBattleMode(mode.key)"
      >
        {{ mode.label }}{{ workbench.battleMode === mode.key ? ' ✓' : '' }}
      </BaseButton>
    </div>

    <!-- ──────────────── 快捷模式：9.9 一键查表 ──────────────── -->
    <template v-if="workbench.battleMode === 'quick'">
      <p v-if="workbench.battleTarget === null" class="muted">
        切到「打一仗」工具：先点己方算子设为攻方，再点**相邻**的敌方算子所在格选定交战
      </p>
      <template v-else>
        <p class="num">
          交战格 {{ hexLabel(workbench.battleTarget.hex) }}（守方
          {{ workbench.battleDefenders.length }} 个）· 攻方 {{ quickAttacker?.name ?? '—' }} AR{{
            quickAttacker?.raw.ar ?? '—'
          }}
        </p>
        <div class="row">
          <label class="field">
            守方地形（9.3b）
            <select v-model="workbench.battleTerrain" class="select">
              <option v-for="name in quickTerrainOptions" :key="name" :value="name">
                {{ name }}
              </option>
            </select>
          </label>
        </div>
        <!-- B14c：守方行动值＝**算子图阵列**（原来是纯文字下拉） -->
        <CounterPicker
          title="守方行动值（9.6，留空自动取最高）"
          hint="9.6：每方只能选一个参战单位担任行动值；DG 单位 −1"
          :items="quickDefenderArItems"
          :size="32"
          @pick="workbench.battleDefenderArId = $event"
          @hover="hoverUnit"
        />
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="workbench.resolveBattleNow()">
            结算战斗（9.9）
          </BaseButton>
        </div>
      </template>
      <p v-if="quickBattleText !== null" class="ok">
        <BaseTag kind="success">9.9</BaseTag>
        {{ quickBattleText }}
      </p>
      <p class="muted">
        一键查表只出 CRT 结果，不结算损失/撤退/推进；要按规则走完 9.2 请切「九步完整流程」。
      </p>
    </template>

    <!-- ──────────────── 九步完整流程（9.2） ──────────────── -->
    <template v-else>
      <!-- 未开始：选择攻方与防御格 -->
      <template v-if="state === null">
        <p class="muted">
          在「打一仗」工具下：点己方算子＝加入攻方（可跨多个相邻格，9.1b/9.1c）；点敌方算子所在格＝选定防御格。
        </p>
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
          <BaseButton variant="primary" size="sm" @click="workbench.beginCombatNow()">
            开始战斗（9.1）
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="workbench.clearCombat()">
            清除选择
          </BaseButton>
        </div>
      </template>

      <!-- 流程中 -->
      <template v-else>
        <!-- 9.2 九步清单（顺序即规则要求的结算顺序） -->
        <ol class="steps">
          <li
            v-for="item in workbench.combatChecklist"
            :key="item.step"
            :class="{
              steps__item: true,
              'steps__item--done': item.done,
              'steps__item--current': item.current,
            }"
          >
            <span class="steps__rule num">{{ item.rule }}</span>
            <span>{{ item.note }}</span>
          </li>
        </ol>

        <p v-if="workbench.combatError !== null" class="bad">
          <BaseTag kind="danger">{{ workbench.combatError.rule }}</BaseTag>
          {{ workbench.combatError.reason }}
        </p>

        <!-- 第 2 步：战斗补给（9.5 / 12.4） -->
        <section v-if="state.step === 'combatSupply'" class="block">
          <h4 class="block__title">② 战斗补给（9.5 / 12.4）</h4>
          <p class="muted">
            攻方须付足全部所需 T（不足则**取消攻击**）；守方可不付（以一半战斗值防御，9.5-B）。
          </p>
          <div class="row">
            <label class="field">
              攻方可用 T
              <UiField
                v-model="workbench.combatInputs.attackerAvailableT"
                class="num-input"
                type="number"
                min="0"
              />
            </label>
            <label class="field">
              守方可用 T
              <UiField
                v-model="workbench.combatInputs.defenderAvailableT"
                class="num-input"
                type="number"
                min="0"
              />
            </label>
          </div>
          <!-- 12.4：地图上点补给站即声明来源；这里显示它并允许清除（改回手填 T） -->
          <div class="row">
            <BaseTag kind="info">
              攻方来源：{{ declaredDumpOf('attacker') ?? '未声明（手填）' }}
            </BaseTag>
            <BaseTag kind="info">
              守方来源：{{ declaredDumpOf('defender') ?? '未声明（手填）' }}
            </BaseTag>
            <BaseButton
              variant="ghost"
              size="sm"
              @click="workbench.clearCombatSupplyDump('attacker')"
            >
              清除攻方来源
            </BaseButton>
            <BaseButton
              variant="ghost"
              size="sm"
              @click="workbench.clearCombatSupplyDump('defender')"
            >
              清除守方来源
            </BaseButton>
          </div>
          <label class="check">
            <input v-model="workbench.combatInputs.defenderProvides" type="checkbox" />
            守方支付战斗补给（不勾＝拒付 ⇒ ½ 战斗值，9.5-B）
          </label>
          <!--
            12.10a：部队储备**只能**在拿不到所需图上 SP 时使用（例外：唯一来源是编内卡车上的 SP）。
            勾上后由引擎逐单位定"图上付 / 储备付"：图上能全额付清的单位仍走图上（不得动储备），
            付不清的改用储备并按 12.10b 降一级；已耗尽者无法再用 ⇒ 整笔拒绝（12.10c）。
          -->
          <label class="check">
            <input v-model="workbench.combatInputs.attackerUsesInternalStocks" type="checkbox" />
            攻方动用部队储备补齐缺口（12.10a；用一次降一级，12.10b）
          </label>
          <label class="check">
            <input v-model="workbench.combatInputs.defenderUsesInternalStocks" type="checkbox" />
            守方动用部队储备补齐缺口（12.10a；须同时勾"守方支付战斗补给"）
          </label>
          <p class="muted">
            9.5b：付不出全额时可取消部分攻方单位参战（点阵列里那一枚即取消 / 再点回来）。
          </p>
          <!-- B14c：参战攻方＝**算子图阵列**（原来是逐单位的文字复选框） -->
          <CounterPicker
            title="参战攻方（9.5b）"
            hint="9.5b：付不出全额时点一枚即取消它的参战（再点回来）；9.11c 的损失也按这份名单分配"
            :items="supplyAttackerItems"
            :size="40"
            @pick="workbench.toggleCombatSupplyAttacker($event)"
            @hover="hoverUnit"
          />
          <div class="row">
            <BaseButton variant="primary" size="sm" @click="workbench.confirmCombatSupply()">
              确认战斗补给（9.5）
            </BaseButton>
          </div>
        </section>

        <!-- 第 3 步：宣布行动值（9.6） -->
        <section v-if="state.step === 'declareAr'" class="block">
          <h4 class="block__title">③ 宣布行动值（9.6：攻方先、守方后）</h4>
          <!-- B14c：AR 单位＝**算子图阵列**（原来是两个纯文字下拉） -->
          <CounterPicker
            title="攻方 AR 单位（9.6）"
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
          <CounterPicker
            title="守方 AR 单位（9.6）"
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
            <span v-if="workbench.nkvdArRequiredNow" class="warn">
              <BaseTag kind="danger">专规 2.3b</BaseTag>
              守方堆叠内有 NKVD 边防团 ⇒ **行动值单位只能从它们中选**（候选表已收窄）
            </span>
            <BaseButton
              variant="primary"
              size="sm"
              :disabled="workbench.combatInputs.defenderArUnitId === null"
              @click="workbench.declareCombatArStep('defender')"
            >
              守方宣布并继续（9.6）
            </BaseButton>
          </div>
        </section>

        <!-- 第 4 步：宣布地形与初始攻防比（9.4 / 9.7） -->
        <section v-if="state.step === 'declareTerrain'" class="block">
          <h4 class="block__title">④ 宣布地形与攻防比（9.4b 逐堆叠 / 9.4c 守方 / 9.7）</h4>
          <p class="muted">
            9.4b 攻方**每一个攻击堆叠**可选「防御格内地形」或「所穿越的格边地形」（不累计）； 9.4c
            守方**只能**选防御格内地形，并决定战斗表横行。
          </p>
          <div v-for="stack in workbench.combatStackTerrainOptions" :key="stack.key" class="row">
            <label class="field">
              攻方堆叠 {{ stack.label }}
              <select
                class="select"
                :value="stackChoiceValue(stack.key)"
                @change="
                  onStackTerrainChange(stack.key, ($event.target as HTMLSelectElement).value)
                "
              >
                <option value="">沿用守方格地形</option>
                <option
                  v-for="option in stack.options"
                  :key="`${option.kind}|${option.terrain}`"
                  :value="`${option.kind}|${option.terrain}`"
                >
                  {{ option.kind === 'hex' ? '格内' : '格边' }}：{{ option.terrain }}
                </option>
              </select>
            </label>
          </div>
          <div class="row">
            <label class="field">
              守方防御地形（9.4c）
              <select v-model="workbench.combatInputs.defenderTerrain" class="select">
                <option
                  v-for="name in workbench.combatDefenderTerrainOptions"
                  :key="name"
                  :value="name"
                >
                  {{ name }}
                </option>
              </select>
            </label>
          </div>
          <div class="row">
            <!--
              B30（用户口径 #19）：地形是**玩家选的**，选完这一下之后「攻防比 / 奇袭 / 战斗骰」
              三步是骰子与查表 ⇒ **自动连跑**到战果（骰面走种子化 RNG，结算日志可复算）。
              要逐步复核时，下面 ⑥⑦ 两节的手动按钮仍在（验证路径）。
            -->
            <BaseButton variant="primary" size="sm" @click="workbench.autoResolveCombatToOutcome()">
              确认地形 ⇒ 自动结算到战果（9.7 / 9.8 / 9.9）
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
        </section>

        <!-- 第 6 步：奇袭（9.8）——B30 起通常已被"确认地形 ⇒ 自动结算"连跑过；本节是逐步复核路径 -->
        <section v-if="state.step === 'surprise'" class="block">
          <h4 class="block__title">⑥ 奇袭判定（9.8）：骰子自动</h4>
          <p class="muted">
            掷 2 骰 + DRM（9.6）；守方在环形工事内则 −1。发生奇袭须再掷 1 骰做横移（9.1g 取端列）。
            **正常流程不必点这里的按钮**（确认地形时已自动掷完）。
          </p>
          <div v-if="props.stepwise" class="row">
            <BaseButton variant="secondary" size="sm" @click="workbench.rollCombatSurprise()">
              {{
                workbench.combatAwaitingShiftDie ? '补掷横移骰（1d6）' : '掷奇袭骰（2d6，逐步复核）'
              }}
            </BaseButton>
          </div>
          <p v-if="workbench.combatAwaitingShiftDie" class="bad">
            已发生奇袭：按 9.8 须**再掷一枚骰子**决定横移列数。
          </p>
        </section>

        <!-- 第 7 步：战斗掷骰（9.9）——同上，通常已自动跑过 -->
        <section v-if="state.step === 'battleDice'" class="block">
          <h4 class="block__title">⑦ 战斗掷骰（9.9）：骰子自动</h4>
          <p class="muted">
            修正骰 ＝ 2d6 + 攻方 AR − 守方 AR − 环形工事**完整等级**（奇袭只 −1，见 9.8/9.9）。
            **正常流程不必点这里的按钮**（确认地形时已自动掷完）。
          </p>
          <p class="num">
            列位：{{ state.surprise?.finalColumnLabel ?? state.odds?.oddsLabel ?? '—' }}；DRM
            {{ state.ar?.drm ?? 0 }}；工事等级 {{ state.hedgehogLevel }}
          </p>
          <div v-if="props.stepwise" class="row">
            <BaseButton variant="secondary" size="sm" @click="workbench.rollCombatDice()">
              掷战斗骰（2d6，逐步复核）
            </BaseButton>
          </div>
        </section>

        <!-- 第 8 步（a）：强制军力损失（9.11） -->
        <section v-if="state.step === 'losses' && isLossStage" class="block">
          <h4 class="block__title">
            ⑧ 强制军力损失（9.11c）—— 当前结算：
            {{ roleName(state.resolution.stage.startsWith('attacker') ? 'attacker' : 'defender') }}
          </h4>
          <p class="num">
            需承受 {{ workbench.combatRequirement?.losses ?? 0 }} 点；AR
            单位先受第一点，之后每人各受一点 （9.11c）；超出承受范围的损失忽略（9.11b）。
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
            <span class="muted">9.11a：多受的那一点改派给</span>
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
            <BaseButton variant="primary" size="sm" @click="workbench.confirmCombatLosses()">
              确认强制损失（9.11c）
            </BaseButton>
          </div>
        </section>

        <!-- 第 8 步（b）：选项（9.10） -->
        <section v-if="state.step === 'options' && isOptionStage" class="block">
          <h4 class="block__title">
            ⑧ 选项（9.10）—— 当前结算：
            {{ roleName(state.resolution.stage.startsWith('attacker') ? 'attacker' : 'defender') }}
          </h4>
          <p class="num">
            选项点数 {{ workbench.combatRequirement?.options ?? 0 }}：可把「撤退格数 +
            损失军力」任意组合， 但总数必须**完全满足**（9.10a）。
          </p>
          <p v-if="workbench.combatInputs.optionLossPoints > 0" class="muted">
            9.11c：第一点必须由 AR 单位承受；各单位各受一点后才能有单位受第二点。 全部留 0 ＝
            按规范分配（同样合法）。
          </p>
          <label
            v-if="
              state.resolution.stage === 'defenderOptions' &&
              state.resolution.defender.optionIgnorable === true
            "
            class="check"
          >
            <input v-model="workbench.combatInputs.ignoreOptions" type="checkbox" />
            行使 9.10c：忽略守方自己的选项
          </label>
          <!--
            ★ 条 15/16（批 F·F1）：选项点数的消耗改成「受损 / 撤退（1 格）」双按钮逐次点选。
            点"受损"⇒ 点本堆叠单位图即受损；点"撤退"⇒ 地图高亮可撤退格、点格即撤退。
            每次应用只进**草稿账本**（不落盘）；最后按「提交」才一次性交给引擎（planOptions）。
          -->
          <p class="num">
            可用选项点数 <b>{{ workbench.optionDraftPoints }}</b
            >｜草稿已用 <b>{{ workbench.optionDraftUsed }}</b
            >｜剩余 <b>{{ workbench.optionDraftRemaining }}</b
            >（9.10a：提交时须完全满足）
          </p>
          <div class="row">
            <BaseButton
              :variant="workbench.optionDraftMode === 'loss' ? 'primary' : 'secondary'"
              size="sm"
              :disabled="workbench.optionDraftRemaining <= 0"
              @click="workbench.setOptionDraftMode('loss')"
            >
              受损（点单位图）
            </BaseButton>
            <BaseButton
              :variant="workbench.optionDraftMode === 'retreat' ? 'primary' : 'secondary'"
              size="sm"
              :disabled="workbench.optionDraftRemaining <= 0"
              @click="workbench.setOptionDraftMode('retreat')"
            >
              撤退（1 格）
            </BaseButton>
            <BaseButton
              variant="ghost"
              size="sm"
              :disabled="workbench.optionDraftEntries.length === 0"
              @click="workbench.undoOptionDraftLast()"
            >
              撤销上一次
            </BaseButton>
          </div>
          <p v-if="workbench.optionDraftMode === 'loss'" class="muted num">
            点**地图上本堆叠的单位图**记 1 点军力损失；也可直接点下面各单位。
          </p>
          <p v-else-if="workbench.optionDraftMode === 'retreat'" class="muted num">
            地图上已按三色铺出**本堆叠可撤退格**（青绿＝安全 / 橙红＝敌方 ZOC / 暗红＝必被消灭
            9.12b）；点格即按该格距离记撤退草稿。
          </p>
          <!-- 「受损」模式：面板内也给出各单位（不看地图也能点） -->
          <div v-if="workbench.optionDraftMode === 'loss'" class="row">
            <BaseButton
              v-for="unit in workbench.combatOptionLossTargets"
              :key="unit.id"
              variant="secondary"
              size="sm"
              :disabled="
                workbench.optionDraftRemaining <= 0 ||
                (workbench.combatInputs.optionLossAllocation[unit.id] ?? 0) >= unit.steps
              "
              @click="workbench.applyOptionDraftLoss(unit.id)"
            >
              {{ unit.name }}（{{ unit.steps }} 步，已损
              {{ workbench.combatInputs.optionLossAllocation[unit.id] ?? 0 }}）
            </BaseButton>
          </div>
          <!-- 草稿账本（流水；最新在末尾） -->
          <div v-if="workbench.optionDraftEntries.length > 0" class="row">
            <span class="muted num">草稿账本：</span>
            <BaseTag
              v-for="entry in workbench.optionDraftEntries"
              :key="entry.index"
              kind="neutral"
            >
              {{ entry.label }}
            </BaseTag>
          </div>
          <!-- 条 16（批 F·F1）：攻方全灭 ⇒ 守方「不选 / 结束战斗」一键 -->
          <div v-if="workbench.attackerWipedNow" class="row">
            <span class="warn num">攻方已全灭：</span>
            <BaseButton variant="primary" size="sm" @click="workbench.concludeCombatAfterWipe()">
              结束战斗（9.10c 例 B）
            </BaseButton>
          </div>
          <p v-else-if="workbench.combatInputs.optionLossPoints > 0" class="muted">
            9.11c：第一点必须由 AR 单位承受；各单位各受一点后才能有单位受第二点。 全部留 0 ＝
            按规范分配（同样合法）。
          </p>
          <div class="row">
            <BaseButton
              variant="primary"
              size="sm"
              :disabled="
                workbench.optionDraftRemaining > 0 && !workbench.combatInputs.ignoreOptions
              "
              @click="workbench.confirmCombatOptions()"
            >
              提交选项（9.10）
            </BaseButton>
          </div>
        </section>

        <!-- 第 9 步：撤退（9.12） -->
        <section v-if="state.step === 'retreat'" class="block">
          <h4 class="block__title">⑨ 撤退（9.12）</h4>
          <RuleNote
            title="撤退：落点与起始格的直线距离必须等于完整撤退距离（青绿=安全 / 橙红=ZOC / 暗红=必死）"
            rule="9.12"
          >
            <p class="muted">
              撤退格数 ＝ 该方剩余选项数；落点与起始格的**直线距离**必须等于该格数（完整撤退距离），
              路径可之字形避开禁入地形。**落点在地图上点**：
              <BaseTag kind="success">青绿＝可撤退</BaseTag>
              <BaseTag kind="warning">橙红＝落点在敌方 ZOC（9.12e）</BaseTag>
              <BaseTag kind="danger">暗红＝必被消灭（9.12b）</BaseTag>
            </p>
          </RuleNote>
          <div class="row">
            <BaseTag kind="info">
              攻方需撤 {{ workbench.combatRetreatRequirement.attacker }} 格
            </BaseTag>
            <BaseTag kind="info">
              守方需撤 {{ workbench.combatRetreatRequirement.defender }} 格
            </BaseTag>
          </div>
          <p v-if="retreatPlan === null" class="muted">
            本场战斗无人需要撤退（双方选项都未含撤退格数）。
          </p>
          <template v-else>
            <p class="num">
              现在给**{{ retreatPlan.side === 'attacker' ? '攻方' : '守方' }}**选落点（{{
                retreatPlan.distance
              }}
              格）：{{ retreatPlan.complete ? '已选齐' : '点地图上的高亮格' }}
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
              <BaseButton
                v-if="row.chosen !== null"
                variant="ghost"
                size="sm"
                @click="workbench.clearRetreatDestinationNow(row.unitId)"
              >
                清除落点
              </BaseButton>
            </div>
            <!-- 9.12d：跟随者（路径自动沿用宿主，界面只展示） -->
            <p v-for="item in retreatPlan.tagalongs" :key="item.unitId" class="num">
              <BaseTag kind="neutral">9.12d</BaseTag>
              {{ item.label }} 随 {{ item.hostLabel }} 同格撤退
            </p>
          </template>
          <div class="row">
            <BaseButton
              variant="primary"
              size="sm"
              :disabled="retreatPlan !== null && !retreatPlan.complete"
              @click="workbench.confirmCombatRetreats()"
            >
              确认撤退（9.12）
            </BaseButton>
          </div>
        </section>

        <!-- 第 9 步：战后推进与进击（9.12g / 9.13） -->
        <section v-if="state.step === 'advance'" class="block">
          <h4 class="block__title">⑨ 战后推进与进击（9.12g / 9.13）</h4>
          <!-- B33：突袭的推进是**强制**的（9.12g-D）⇒ 说明与按钮按这个口径给 -->
          <p v-if="workbench.combatAdvanceMandatory" class="warn num">
            <BaseTag kind="danger">9.12g-D</BaseTag>
            本次是**突袭**：成功的突袭**必须**战后推进（8.0：防御方撤退或被摧毁 ⇒ 所有攻击单位都必须
            进入该格，无需额外 MP）⇒ 撤退收束后**自动收束**，不给"不推进"。若因 9.14 位移待决而停在
            本步，位移落点选定后即自动收束。
          </p>
          <p class="num">
            防御格 {{ workbench.combatDefendingHexCleared ? '已空' : '未空' }}；
            {{
              workbench.combatDefendingHexCleared
                ? '攻方可选择推进（9.12g-D：突袭后必须推进）'
                : '防御格未空 ⇒ 不推进'
            }}
          </p>
          <p class="muted">
            9.12g-A：只有**付了战斗补给**的单位（含战斗值为零的）才能推进；9.13：取得进击标记须满足
            攻击阶段、非 DG、非突袭、攻方把全部选项选为军力损失等条件。
          </p>
          <!--
            批 F·E4：**推进入口唯一** ⇒ 本面板的推进块改为**只读**，勾选与确认都在
            **地图上的推进格小窗**（`MapActionPopover`）里做（规则书里推进的对象就是那个格）。
            9.12g-D 的逐单位勾选因此没有丢失，只是换到了地图上。
          -->
          <p class="muted">
            勾选「哪些单位推进」与确认收束 ⇒ 请点地图上高亮的推进格（就近小窗）。突袭（9.12g-D）
            由系统自动收束，无需操作。
          </p>
          <ul class="list">
            <li
              v-for="choice in workbench.combatAdvanceChoices"
              :key="choice.unit.instanceId"
              class="num"
            >
              {{ choice.unit.name }}（军力 {{ choice.unit.steps }}）——
              {{ choice.disabledReason ?? (choice.selected ? '已选推进' : '可推进') }}
            </li>
          </ul>
          <p v-if="state.finished" class="ok">
            <BaseTag kind="success">战斗结束</BaseTag>
            9.2 九步流程已走完。
          </p>
        </section>

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
        <details v-if="workbench.combatReview !== null" class="review" open>
          <summary class="review__head num">
            结算复核（{{ workbench.combatReview.rule }}）：骰点 · 计算过程 · 修正来源
          </summary>
          <DerivationSteps :derivation="workbench.combatReview" />
        </details>

        <div class="row">
          <BaseButton variant="ghost" size="sm" @click="workbench.cancelCombat()"
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

.num-input {
  width: 64px;
}

/* B20：撤退坐标文本框的样式随文本框一起删除 —— 撤退改成点地图高亮格 */
.check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.block {
  border-top: 1px dashed var(--color-rule);
  padding-top: var(--space-2);
  margin-bottom: var(--space-2);
}

.block__title {
  margin: var(--space-1) 0;
  font-size: var(--text-sm);
  color: var(--color-ink);
}

.steps {
  list-style: none;
  margin: 0 0 var(--space-2);
  padding: 0;
  font-size: var(--text-xs);
  color: var(--color-muted);
}

.steps__item {
  display: flex;
  gap: var(--space-2);
  padding: 1px 0;
}

.steps__item--done {
  color: var(--color-success);
}

.steps__item--current {
  color: var(--color-ink);
  font-weight: 700;
}

.steps__rule {
  min-width: 46px;
  color: var(--color-gold);
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
