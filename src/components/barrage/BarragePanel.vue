<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag } from '@/components/base'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
import {
  aircraftRecordImageUrlOf,
  counterImageUrlOf,
  hexLabel,
  isStrategicBomberAircraft,
  spDumpImageUrlOf,
  useWorkbenchStore,
} from '@/stores'

/**
 * 轰炸面板（C7：OCS 10.0 章）
 *
 * 走 `engine/rules/barrage-interaction.ts` 的 **10.0 通用流程**状态机：
 *   ① 宣布整体目标与轰炸值分配（10.0d / 10.0e）→ ② 按**初始列**付火炮战斗补给（10.1b，空军免费 10.2c）
 *   → ③ 列横移确认（10.0a 目标玩家选地形 / 10.0b 观察员 / 10.2b 短程）→ ④ 掷骰（战斗单位 2 骰、
 *   对设施 1 骰；`1/2` 需再掷取整骰）→ ⑤ 结果确认（10.0a DG 与损失分配 / 10.0c A 基地 B 港口 C 运输破坏）。
 *
 * 分层纪律（CODE_SPEC）：本组件**不做任何规则计算** —— 步骤清单、横移、成本、结果、损失分配合法性
 * 全部来自 store 对引擎的调用结果；这里只画图、收点击、把输入写进 `barrageInputs`。
 */

const workbench = useWorkbenchStore()

/** 步骤清单（10.0 通用流程） */
const checklist = computed(() => workbench.barrageChecklist)
/** 结果摘要（格值 / 最终列 / 成本 / 损失） */
const summary = computed(() => workbench.barrageSummary)

/** 10.0a 的 `1/2` 取整骰是否仍待掷 */
const awaitingHalfDie = computed(() => workbench.barrageAwaitingHalfDie)

/** 10.0a：目标格内的敌方战斗单位（由目标玩家选择哪些单位承受损失；候选与引擎校验同源） */
const lossTargets = computed(() => workbench.barrageLossTargets)

/** 10.0c-A：目标格内所有敌方飞机（逐机掷骰 ≥# 者损 1 军力；修前错取 battleDefenders＝地面单位） */
const aircraftRollTargets = computed(() => workbench.barrageAircraftRollTargets)

/** 10.0a：目标玩家可选的地形线（只列**目标格内**存在的地形所产生的战斗线；由引擎筛出） */
const terrainLines = computed(() => workbench.barrageTerrainLineOptions)

/* ─────────────────── 算子图阵列（B14b；用户口径⑪） ───────────────────
 *
 * 「把当前可选的**算子图片**紧凑排出来；算子上信息已经够了，除了环节提示这种外不需要显示额外的文字」。
 * 故本面板四处「选算子」的位置改用 `CounterPicker`：数字与名称只进 `title`（悬停可见），
 * 屏幕上只有算子图 + 金框（选中）。**本组件不做任何规则判断**：可选性与原因都由 store 给。
 */

/** 悬停某一枚地面算子 ⇒ 同步地图高亮它所在的格 */
function hoverUnit(id: string | null): void {
  const unit = id === null ? null : (workbench.units.find((item) => item.instanceId === id) ?? null)
  workbench.setHoverHex(unit?.hex ?? null)
}

/** 悬停某一架飞机 ⇒ 同步地图高亮它所在的格（14.1a：该格即其空军基地格） */
function hoverAir(id: string | null): void {
  const air =
    id === null ? null : (workbench.airUnits.find((item) => item.instanceId === id) ?? null)
  workbench.setHoverHex(air?.hex ?? null)
}

/** 悬停某一座补给站 ⇒ 同步地图高亮它的格 */
function hoverDump(id: string | null): void {
  const dump = id === null ? null : (workbench.spDumpsOfSide.find((item) => item.id === id) ?? null)
  workbench.setHoverHex(dump?.hex ?? null)
}

/** 参炸单位（10.0e-B / 13.4a）：可选性与灰显原因由 store 逐枚算好（`barrageUnitChoices`） */
const barrageUnitItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.barrageUnitChoices.map((choice) => ({
    id: choice.unit.instanceId,
    imageUrl: counterImageUrlOf(choice.unit),
    name:
      `${choice.unit.name}（印刷轰炸 ${choice.unit.raw.barrage ?? 0}` +
      `${choice.unit.mode.dg ? '，DG 折半' : ''}）@ ${hexLabel(choice.unit.hex)}`,
    selected: choice.selected,
    disabledReason: choice.disabledReason,
    hex: choice.unit.hex,
  })),
)

/** 摆放飞机（14.1a）：机型库记录 → 算子图阵列 */
const aircraftItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.airUnitChoices.map((item) => ({
    id: item.aircraftId,
    imageUrl: aircraftRecordImageUrlOf(item, workbench.activeSide),
    name:
      `${item.name ?? item.aircraftId}（${item.aircraftType ?? '?'}` +
      `${isStrategicBomberAircraft(item.aircraftType ?? '') ? '｜战略轰炸机 14.1e' : ''}` +
      `｜轰炸 ${item.barrageStrength ?? 0}｜航程 ${item.rangeHexes ?? 0}）`,
    selected: workbench.airPlacement.aircraftId === item.aircraftId,
  })),
)

/** 参炸飞机（10.2b / 14.1）：逐机给出"距其基地几格"与航程是否够 */
const barrageAirItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.barrageAirChoices.flatMap((choice) => {
    const air = workbench.airUnits.find((item) => item.instanceId === choice.id)
    if (air === undefined) return []
    return [
      {
        id: choice.id,
        imageUrl: counterImageUrlOf(air),
        name:
          `${choice.name}（机型 ${choice.aircraftType}` +
          `${choice.strategic ? '｜战略轰炸机：10.2b 永不享短程 +1（14.1e）' : ''}` +
          `｜距其基地 ${choice.rangeFromBase ?? '—'} 格` +
          `${choice.rangeFromBase !== null && choice.rangeFromBase <= 10 ? '（≤10 ⇒ 10.2b 短程 +1 候选）' : ''}）`,
        selected: choice.selected,
        disabledReason: choice.disabledReason,
        hex: air.hex,
      },
    ]
  }),
)

/** 付款补给站（10.1b / 12.3a）：图用**当前点数的 SP 算子图** */
const dumpItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.barrageSupplyDumpChoices.map((dump) => ({
    id: dump.id,
    imageUrl: spDumpImageUrlOf(dump),
    name: `${hexLabel(dump.hex)}（${dump.sp} SP / ${dump.t} T）`,
    selected: workbench.barrageSupplyDumpId === dump.id,
    hex: dump.hex,
  })),
)

/** 损失分配输入（unitId → 点数）；`setLoss` 只写玩家输入，不改盘面 */
const TARGET_KINDS = [
  { key: 'combatUnits', label: '战斗单位（10.0a）' },
  { key: 'airBase', label: '空军基地（10.0c-A）' },
  { key: 'port', label: '港口（10.0c-B）' },
  { key: 'trainbusting', label: '运输破坏（10.0c-C）' },
] as const

/** 10.0e-F：参炸单位类别（**全部**；实际显示哪些由本环节允许的来源决定） */
const KINDS = [
  { key: 'artillery', label: '火炮（F 段）' },
  { key: 'air', label: '空军（C 段）' },
  { key: 'ship', label: '海军（本作无）' },
] as const

/**
 * 批 A 切片 2：**本环节允许的类别**（SOP：C 段 air & ship only、F 段 artillery only）
 *
 * 判据在 store（`barrageKindsInSegment`，取自引擎的 `BARRAGE_SOURCES_BY_PHASE`）——
 * 面板不再让玩家自由挑，避免"先选了炮兵、再被引擎按段拒绝"的来回。
 */
const kindsHere = computed(() =>
  KINDS.filter((kind) => workbench.barrageKindsInSegment.includes(kind.key)),
)

/** 损失分配输入（unitId → 点数）；`setLoss` 只写玩家输入，不改盘面 */
function lossValue(unitId: string): number {
  return workbench.barrageInputs.losses[unitId] ?? 0
}
function setLoss(unitId: string, value: number): void {
  workbench.barrageInputs.losses = {
    ...workbench.barrageInputs.losses,
    [unitId]: Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0,
  }
}

/** 10.0c-A：格内每架飞机的掷骰输入 */
function aircraftValue(unitId: string): number {
  return workbench.barrageInputs.aircraftRolls[unitId] ?? 1
}
function setAircraftRoll(unitId: string, value: number): void {
  workbench.barrageInputs.aircraftRolls = {
    ...workbench.barrageInputs.aircraftRolls,
    [unitId]: Number.isFinite(value) ? Math.min(6, Math.max(1, Math.trunc(value))) : 1,
  }
}
</script>

<template>
  <BasePanel title="轰炸（C7：OCS 10.0）">
    <div class="row">
      <BaseButton
        variant="secondary"
        size="sm"
        @click="workbench.setBarrageActive(!workbench.barrageActive)"
      >
        {{ workbench.barrageActive ? '关闭轰炸工具' : '开启轰炸工具' }}
      </BaseButton>
    </div>

    <p v-if="!workbench.barrageActive" class="muted">
      开启后按 OCS 10.0 的通用流程逐步结算：加总轰炸值 → 定初始列 → 按该列付补给 → 列横移 → 掷骰 →
      结果。
    </p>

    <template v-else>
      <!-- ── 目标格（10.0d）── -->
      <p class="num">
        目标格：
        <template v-if="workbench.barrageTargetHex !== null">
          {{ hexLabel(workbench.barrageTargetHex) }}｜格内敌战斗单位 RE
          {{ workbench.barrageTargetFacts.enemyREInHex }}｜工事
          {{ workbench.barrageTargetFacts.hedgehogLevel }} 级｜战略模式
          {{ workbench.barrageTargetFacts.stratModeInHex ? '有' : '无' }}｜观察员（10.0b）
          {{ workbench.barrageTargetFacts.hasSpotter ? '有' : '无' }}
        </template>
        <template v-else
          >未选定 —— 在本**轰炸环节**点地图上的目标格（10.0d；目标可以是任意格：敌单位 / 空军基地 /
          铁路格）</template
        >
      </p>

      <!-- ── ① 宣布整体目标与轰炸值分配（10.0d / 10.0e）── -->
      <div class="row">
        <label class="field">
          单位类别（10.0e-F）
          <select
            class="select"
            :value="workbench.barrageKind"
            @change="
              workbench.setBarrageKind(
                ($event.target as HTMLSelectElement).value as 'artillery' | 'air' | 'ship',
              )
            "
          >
            <option v-for="kind in kindsHere" :key="kind.key" :value="kind.key">
              {{ kind.label }}
            </option>
          </select>
        </label>
        <label class="field">
          整体目标（10.0d）
          <select
            class="select"
            :value="workbench.barrageTargetKind"
            @change="
              workbench.setBarrageTargetKind(
                ($event.target as HTMLSelectElement).value as
                  'combatUnits' | 'airBase' | 'port' | 'trainbusting',
              )
            "
          >
            <option v-for="kind in TARGET_KINDS" :key="kind.key" :value="kind.key">
              {{ kind.label }}
            </option>
          </select>
        </label>
      </div>

      <!-- B14b：参炸单位＝**算子图阵列**（原来是一排"名字(值) + ✓"的文字按钮 + 一行名字） -->
      <!-- H②：这一块**只服务炮兵**（10.0e-F：一次轰炸只能用同一类型）——空军那一套见下面的「参炸飞机」 -->
      <template v-if="workbench.barrageKind === 'artillery'">
        <CounterPicker
          title="参炸单位（点一枚加入 / 再点一枚退出）"
          hint="10.0e-B：不拆分轰炸值、不低于印刷值；13.4a：预备/战略模式的火炮不得轰炸"
          :items="barrageUnitItems"
          :size="40"
          @pick="workbench.toggleBarrageUnit($event)"
          @hover="hoverUnit"
        />
      </template>

      <div class="row">
        <label class="field">
          <input v-model="workbench.barrageInputs.hexAlreadyBarragedThisPhase" type="checkbox" />
          该格本阶段已被轰炸过（10.0e-A；裁判补记用）
        </label>
      </div>

      <!--
        A 组接线：**本阶段的轰炸账本**（10.0e-A/B「每格/每单位每阶段一次」）
        它是自动的（宣布 → 付完补给即记账），上面那个勾选框只留给裁判补记漏掉的场面。
        把账本显示出来，玩家才知道"这一格/这一门炮为什么现在炸不了"。
      -->
      <p class="muted num">
        本阶段已轰炸（10.0e-A/B，自动记账）：{{ workbench.barragePhaseLedger.hexes.length }} 格 ·
        {{ workbench.barragePhaseLedger.unitIds.length }} 个单位
        <template v-if="workbench.barragePhaseLedger.hexes.length > 0">
          ｜格号：{{ workbench.barragePhaseLedger.hexes.join('、') }}
        </template>
      </p>

      <!--
        ── 参炸飞机（10.2：空军轰炸；H② 起**整块只在类别＝空军时出现**）──
        用户 2026-09-18：「空军和炮兵的轰炸结算页面一定要分开，目前炮兵轰炸时结算页面上还有空军」。
        10.2b 短程 +1 列的数据源：14.1a 飞机停在空军基地格，该格即「它们基地」。
      -->
      <template v-if="workbench.barrageKind === 'air'">
        <p class="muted num">
          参炸飞机（A5 空军专表）：摆在**空军基地格**（14.1a），该格即 10.2b 所说的「它们基地」；
          10.2c 空军轰炸**没有补给消耗**（本段不出现付款补给站）。
        </p>
        <div class="row">
          <!-- B14b：机型＝**算子图阵列**（原来是一个纯文字下拉） -->
          <CounterPicker
            title="机型（A5 空军专表）"
            hint="14.1a 摆放：飞机停在空军基地格，该格即 10.2b 所说的「它们基地」"
            :items="aircraftItems"
            :size="32"
            @pick="workbench.airPlacement.aircraftId = $event"
            @hover="workbench.setHoverHex(null)"
          />
          <label class="field">
            基地格（列.行）
            <input v-model="workbench.airPlacement.hexText" class="input" placeholder="36.13" />
          </label>
          <BaseButton
            variant="secondary"
            size="sm"
            @click="
              workbench.addAirUnit(
                workbench.airPlacement.aircraftId,
                workbench.airPlacement.hexText,
              )
            "
          >
            摆放飞机（14.1a）
          </BaseButton>
        </div>
        <div class="row">
          <label class="field">
            <input v-model="workbench.barrageInputs.hipShoot" type="checkbox" />
            低空扫射（14.7d：须有正确观察员 10.0b）
          </label>
        </div>
        <!-- B14b：参炸飞机＝**算子图阵列**；航程够不到的飞机灰显（14.1） -->
        <CounterPicker
          title="参炸飞机（点一枚加入 / 再点一枚退出）"
          hint="10.2b：距基地 ≤10 格才有短程 +1；战略轰炸机永不享（14.1e）；航程够不到目标格的不能出击（14.1）"
          :items="barrageAirItems"
          :size="40"
          @pick="workbench.toggleBarrageAirUnit($event)"
          @hover="hoverAir"
        />
        <p v-if="workbench.barrageAirCandidates.length === 0" class="muted">
          未摆放飞机：填机型与基地格后点「摆放飞机」。
        </p>
        <!-- 卸下是**动作**（选中一枚再动作），属 B15 的操作链；此处保留最省的一行，免得没退路 -->
        <p v-if="workbench.barrageAirCandidates.length > 0" class="num">
          卸下：<BaseButton
            v-for="air in workbench.barrageAirCandidates"
            :key="`drop-${air.instanceId}`"
            variant="ghost"
            size="sm"
            @click="workbench.removeAirUnit(air.instanceId)"
          >
            {{ air.name }}
          </BaseButton>
        </p>
      </template>

      <div class="row">
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="workbench.barrageState !== null"
          @click="workbench.beginBarrageNow()"
        >
          ① 宣布轰炸（10.0d）
        </BaseButton>
      </div>

      <!-- ── 步骤清单（10.0 通用流程）── -->
      <p class="num">
        <BaseTag
          v-for="item in checklist"
          :key="item.step"
          :kind="item.done ? 'success' : 'neutral'"
        >
          {{ item.label }}{{ item.done ? ' ✓' : '' }}
        </BaseTag>
      </p>

      <!-- ── ② 补给（10.1b / 10.2c）── -->
      <template v-if="workbench.barrageState?.step === 'supply'">
        <!-- H②：付款那一整套**只服务炮兵**（10.1b）；10.2c 明写空军轰炸没有补给消耗 -->
        <template v-if="workbench.barrageKind === 'artillery'">
          <!-- B14b：付款补给站＝**算子图阵列**（原来是纯文字下拉；点同一座站即取消声明） -->
          <CounterPicker
            title="付款补给站（12.3a：火炮的这笔 T 必须落到一座站上）"
            hint="10.1b：各参炸单位须共用同一来源（同一指挥部或同一补给站）"
            :items="dumpItems"
            :size="32"
            @pick="workbench.toggleBarrageSupplyDump($event)"
            @hover="hoverDump"
          />
          <div class="row">
            <span class="num">
              可动用 T：{{ workbench.barrageInputs.availableT }}（按所选站持仓，含 1 SP = 4 T）｜
              获批来源：{{
                workbench.barrageSupplyDump === null
                  ? '无'
                  : hexLabel(workbench.barrageSupplyDump.hex)
              }}
            </span>
          </div>
          <div class="row">
            <label class="field">
              <input v-model="workbench.barrageInputs.fromSameHq" type="checkbox" />
              来自同一指挥部（10.1b-A）
            </label>
            <label class="field">
              <input v-model="workbench.barrageInputs.fromSameDump" type="checkbox" />
              来自同一补给站（10.1b-A）
            </label>
            <label class="field">
              <input v-model="workbench.barrageInputs.usedInternalStocks" type="checkbox" />
              动用部队储备（10.1b-C 禁止）
            </label>
          </div>
          <p class="muted">
            12.3a/12.3b 是仅有的取补途径（用户裁定：补给只能从**己方补给站**扣）⇒ 火炮的这笔 T
            会从所选站**真扣**；原先手填一个数字就算"已付"，等于免费轰炸。
          </p>
        </template>
        <p v-else class="muted">
          10.2c：**空军轰炸没有补给消耗** ⇒ 本步不需要付款来源，直接确认即可。
        </p>
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="workbench.confirmBarrageSupplyStep()">
            ② 按初始列付补给（10.1b）
          </BaseButton>
        </div>
      </template>

      <!-- ── ③ 列横移（10.0a / 10.0b / 10.2b）── -->
      <template v-if="workbench.barrageState?.step === 'shifts'">
        <div class="row">
          <label class="field">
            目标玩家所选地形（10.0a，仅列目标格内存在者）
            <select v-model="workbench.barrageInputs.terrainLine" class="select">
              <option value="">（不选）</option>
              <option v-for="line in terrainLines" :key="line" :value="line">{{ line }}</option>
            </select>
          </label>
        </div>
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="workbench.confirmBarrageShiftsStep()">
            ③ 确认横移（10.0a）
          </BaseButton>
        </div>
      </template>

      <!-- ── ④ 掷骰（10.0a / 10.0c）── -->
      <template v-if="workbench.barrageState?.step === 'dice'">
        <!--
          B28（用户口径 #9「所有的随机数抽取一律自动结算」）：骰面不再让玩家填。
          `1/2` 结果的取整骰也自动补掷（再点一次「掷骰」即可），骰面走种子化 RNG、结算日志可复算。
        -->
        <p class="muted">掷骰自动结算：战斗单位 2 骰 / 设施 1 骰。</p>
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="workbench.rollBarrageDiceStep()">
            ④ 掷骰（10.0）
          </BaseButton>
        </div>
        <p v-if="awaitingHalfDie" class="muted">已出 `1/2`：再点一次「掷骰」即自动补掷取整骰。</p>
      </template>

      <!-- ── ⑤ 结果确认（10.0a / 10.0c）── -->
      <template v-if="workbench.barrageState?.step === 'outcome'">
        <template v-if="summary?.facility !== true">
          <p class="num">10.0a：由**目标玩家**选择哪些战斗单位承受损失（合计须等于结果点数）</p>
          <div class="row">
            <label v-for="unit in lossTargets" :key="unit.instanceId" class="field">
              {{ unit.name }}
              <input
                class="input"
                type="number"
                min="0"
                :value="lossValue(unit.instanceId)"
                @input="setLoss(unit.instanceId, Number(($event.target as HTMLInputElement).value))"
              />
            </label>
          </div>
        </template>
        <template v-else>
          <div class="row">
            <label class="field">
              设施
              <select v-model="workbench.barrageTargetKind" class="select" disabled>
                <option :value="workbench.barrageTargetKind">
                  {{ workbench.targetKindLabel(workbench.barrageTargetKind) }}
                </option>
              </select>
            </label>
            <label class="field">
              空军基地当前等级（10.0c-A）
              <input
                v-model.number="workbench.barrageInputs.baseLevel"
                class="input"
                type="number"
                min="1"
                max="3"
              />
            </label>
            <label class="field">
              <input v-model="workbench.barrageInputs.isAirstrip" type="checkbox" />
              简易机场（永不降级，15.2E）
            </label>
            <label class="field">
              港口既有伤害（10.0c-B）
              <input
                v-model.number="workbench.barrageInputs.portDamageBefore"
                class="input"
                type="number"
                min="0"
                max="4"
              />
            </label>
          </div>
          <p class="num">10.0c-A：格内每架飞机的掷骰（≥# 者损 1 军力）</p>
          <div class="row">
            <label v-for="unit in aircraftRollTargets" :key="unit.instanceId" class="field">
              {{ unit.name }}
              <input
                class="input"
                type="number"
                min="1"
                max="6"
                :value="aircraftValue(unit.instanceId)"
                @input="
                  setAircraftRoll(
                    unit.instanceId,
                    Number(($event.target as HTMLInputElement).value),
                  )
                "
              />
            </label>
          </div>
        </template>
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="workbench.confirmBarrageOutcomeStep()">
            ⑤ 确认结果（10.0a / 10.0c）
          </BaseButton>
        </div>
      </template>

      <!-- ── 结果摘要 ── -->
      <p v-if="summary !== null" class="ok">
        <BaseTag kind="success">{{ summary.facility ? '10.0c' : '10.0a' }}</BaseTag>
        轰炸值 {{ summary.totalValue }} ⇒ 初始列 {{ summary.initialColumnLabel }}（成本
        {{ summary.costT }} T）
        <template v-if="!summary.facility">
          ｜横移 {{ summary.shifts?.total ?? 0 }} ⇒ 列 {{ summary.finalColumn }}｜骰
          {{ summary.die }}
          <template v-if="summary.halfDie !== null"> +取整 {{ summary.halfDie }}</template>
          ｜格值 {{ summary.code }}
          <template v-if="summary.unitOutcome !== null"
            >｜{{ summary.unitOutcome.detail }}</template
          >
        </template>
        <template v-else>｜骰 {{ summary.die }}｜格值 {{ summary.code }}</template>
      </p>

      <p v-if="workbench.barrageError !== null" class="warn">
        <BaseTag kind="danger">{{ workbench.barrageError.rule }}</BaseTag>
        {{ workbench.barrageError.reason }}
      </p>

      <div class="row">
        <BaseButton variant="secondary" size="sm" @click="workbench.cancelBarrage()">
          放弃本次轰炸
        </BaseButton>
      </div>
    </template>
  </BasePanel>
</template>
