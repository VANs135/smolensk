<script setup lang="ts">
import { computed } from 'vue'

import { BaseButton, BasePanel, BaseTag, RuleNote } from '@/components/base'
import { useUiMode } from '@/components/ui-mode'
import { scenarios } from '@/data'
import type { Side } from '@/data'
import { setupHexLabel } from '@/engine/rules'
import {
  useContainersStore,
  useSetupStore,
  useWorkbenchStore,
  type SetupPlacing,
  type SetupPlacingCategory,
} from '@/stores'

/**
 * 初设与开局流程（W7 C14）
 *
 * ## 用户口径（本面板的形态）
 *   ① 选剧本即**自动初设**固定格号 / 死亡堆 / 多点位那些「无需玩家定夺」的单位；
 *   ② 共识开关列表默认**全部勾选**（去会话层处理），本面板不再逐条铺开；
 *   ③ 需要玩家定夺的条目收进**初设单位 box**（按「飞机 / SP 与运输点 / 地面与基地」三类）：
 *      点一项 ⇒ 地图高亮其合法落点 ⇒ 点格落位；
 *   ④ 全部设置完 ⇒「**完成初设**」（地图左上角的决策队列）进入第一阶段；**box 里没落位的即视为本局移除**；
 *   ⑤ 目的是**精简右侧菜单栏** —— 明细（编制抽取 / 卡车满载 / SP 归属 / 自动初设 / 飞机 /
 *      自定义初设）折进 `<details>`，默认不占版面。
 *
 * ## 分层纪律
 *   一切判据来自 `engine/rules/setup.ts`（通规 IV Set Up Notes / 专规 Setup Notes / 12.1d /
 *   3.4b / 13.2h / 14.1a），组件**不做任何规则计算**；落盘由 `stores/setup.ts` 做。
 */

const setup = useSetupStore()
const containers = useContainersStore()
const workbench = useWorkbenchStore()

/** 条 24 / §5-F：正式界面把「手输」收敛为只读（验证页仍可手输） */
const uiMode = useUiMode()

/**
 * 条 26 / S4：西移落点**点地图选**（补 §5-E「补缺的 4 处」之一）
 *
 * 原处只能手输「列.行」（原文：位置印在剧本卡上、数据里没有）；这里接上统一的格选择——
 * 选中后由 `containers.setDrawShiftHexNow` 校验并写回，正式界面因此可以只读展示。
 */
function pickShiftWestHex(formationId: string): void {
  workbench.beginHexPick({
    label: `西移落点（${formationId}）`,
    rule: 'ch10',
    candidates: 'any',
    apply: (hex) => containers.setDrawShiftHexNow(formationId, setupHexLabel(hex)),
  })
}

/** 剧本下拉 */
const scenarioChoices = computed(() =>
  scenarios.scenarios.map((item) => ({ id: item.id, name: item.name })),
)

/** 开局流程步骤 + 完成度 */
const steps = computed(() =>
  setup.flow.map((step) => ({ ...step, done: setup.stepDone[step.id] === true })),
)

/** 自动初设计划的规模 */
const planCounts = computed(() => setup.plan?.counts ?? { pieces: 0, ledger: 0, choices: 0 })

/** 初设源说明 */
const sourceDetail = computed(() => setup.plan?.source.detail ?? '—')

/** 该剧本的编队抽签组（取自初设源） */
const drawGroups = computed(() => {
  const sourceId = setup.plan?.source.source ?? setup.scenarioId
  return scenarios.scenarios.find((item) => item.id === sourceId)?.setup.formationDraw?.groups ?? []
})

/** 某组已抽中的名单（账本在 C12 的剧本抽取盒里） */
function drawnOf(kind: string): string[] {
  const rows = [
    ...(containers.drawResults[setup.scenarioId] ?? []),
    ...(containers.drawResults[setup.plan?.source.source ?? setup.scenarioId] ?? []),
  ]
  return rows.find((row) => row.kind === kind)?.formationIds ?? []
}

/*
 * B38（方案 §3 步骤 4）：**本处那份应满载辆数已删** —— 判据只有一处：
 * store 的 `setup.requiredFullTrucks`（与引擎 `planTruckFullLoad` 同口径）。
 * 组件里再算一遍的代价是两处会走散（B11 已把这份口径搬进 store，此处是遗漏的重复）。
 *
 * ★ 批 B 切片 1：**剧本原文那一份也删了** —— 装载模式（含原文与"要不要玩家决定"）统一由
 *   store 的 `setup.truckLoadSummary` 给（同一理由：口径只有一处）。
 */

/** 是否适用 3.4b（轴方 SP 须点名装甲集群） */
const requiresGroup = computed(
  () => setup.spDumpsOf('axis').length > 0 && setup.stepDone['spOwnership'] !== true,
)

/** 各方的自由项（须玩家定夺） */
function choicesOf(side: Side) {
  return setup.choicesOf(side)
}

/** 各方飞机计划 */
function airRows(side: Side) {
  return setup.airPlanOf(side)?.placements ?? []
}

/** 飞机政策的原文与结论 */
function airPolicy(side: Side) {
  return setup.airPlanOf(side)?.policy ?? null
}

/** 某型飞机已选的基地格 */
function airChoiceOf(entryIndex: number): string {
  return setup.airChoices[entryIndex] ?? ''
}

/** 某条自由项已选的格 */
function selfChoiceOf(entryIndex: number): string {
  return setup.selfChoices[entryIndex] ?? ''
}

/** 候选格数量为 0 时说清原因 */
function candidateHint(candidates: readonly { col: number; row: number }[]): string {
  return candidates.length === 0
    ? '候选为空：缺盘面事实（HQ 格 / 空军基地格）或半径解析不出 ⇒ 引擎已记缺口'
    : `${candidates.length} 个候选格（IV-A 含边界、IV-I 已过滤）`
}

/** SP 装甲集群下拉（空串 = 未点名；只在轴方出现） */
function setGroup(dumpId: string, value: string): void {
  setup.setSpAssignment(dumpId, value === 'guderian' || value === 'hoth' ? value : null)
}

/** 某条自由项的候选格（来自 store：按该条目的所属方注入盘面事实后由引擎算） */
function candidatesOf(entryIndex: number): readonly { col: number; row: number }[] {
  return setup.candidatesOf(entryIndex)
}

/* ── 初设单位 box ── */

/** 分类清单（用户口径：飞机一类、SP 与运输点一类、地面与基地一类） */
const CATEGORIES: readonly { key: SetupPlacingCategory; label: string; hint: string }[] = [
  { key: 'ground', label: '地面单位与基地', hint: '`w/i N` / 任一指挥部等自选格项' },
  { key: 'supply', label: 'SP 与运输点', hint: '须玩家指定落格的后勤点数' },
  { key: 'air', label: '飞机', hint: '14.1a：落在本方空军基地格' },
]

/** 某分类下**尚未落位**的项 */
function boxItems(category: SetupPlacingCategory): readonly SetupPlacing[] {
  return setup.pendingPlacement.filter((item) => item.category === category)
}

/** 点一项 ⇒ 地图高亮其合法落点 */
function begin(item: SetupPlacing): void {
  if (item.kind === 'air') setup.beginAirPlacement(item.side, item.entryIndex)
  else setup.beginSelfPlacement(item.entryIndex)
}

/** 当前正在放置的项是否就是这一条 */
function isPlacing(item: SetupPlacing): boolean {
  return (
    setup.placing !== null &&
    setup.placing.kind === item.kind &&
    setup.placing.entryIndex === item.entryIndex &&
    setup.placing.side === item.side
  )
}

function sideLabel(side: Side): string {
  return side === 'axis' ? '轴心' : '苏联'
}
</script>

<template>
  <BasePanel title="初设与开局（W7 C14：通规 IV Set Up Notes · 专规 Setup Notes）">
    <!-- ── ① 剧本选择 + 开始游戏（选剧本即自动初设固定项） ── -->
    <div class="row">
      <label class="field">
        剧本（唯一入口）
        <select
          class="select"
          :disabled="setup.finished"
          :value="setup.scenarioId"
          @change="setup.selectScenario(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="item in scenarioChoices" :key="item.id" :value="item.id">
            {{ item.id }} · {{ item.name }}
          </option>
        </select>
      </label>
      <!--
        ★ 批 E 切片 1（用户口径 9.17③b「两个开局按钮 + 一个开始游戏，应统一」）：
          **这里的「开始游戏」已删** —— 建会话（开局）**唯一入口＝初设收束点**：
          地图左上角「待你决定」队列落满后的「完成初设」（`DecisionQueue` → store 的 `startGameNow`）。
          本面板只留只读回执：初设是否收束、还剩几项待落位。
      -->
      <BaseTag :kind="setup.finished ? 'success' : 'warning'">
        {{ setup.finished ? '初设已收束' : `待落位 ${setup.pendingPlacement.length} 项` }}
      </BaseTag>
    </div>
    <RuleNote
      v-if="!setup.finished"
      title="开局在初设收束点：地图左上角「待你决定」队列落满后按「完成初设」"
      rule="IV / 2.2"
    >
      <p class="muted">
        未落位的条目**视为本局移除**（用户口径）；收束即建会话、写共识结论并进入回合准备（2.2）。
        本面板不再提供第二个「开始游戏」按钮 —— 修前这里有三个入口（本面板 / 流程条「开局」/
        决策队列 「完成初设」），点哪个都能开局，行为却各不一致。
      </p>
    </RuleNote>
    <p class="muted">
      选剧本即**自动初设**固定格号 / 死亡堆 / 多点位的单位（棋子按算子链接配子、SP
      与运输点与空军基地 按面额拆算子、剧本明示的**军力减损已自动扣除**）。其余项进下面的「初设单位
      box」。初设源：{{ sourceDetail }}
    </p>

    <!-- ── ② 放置中的提示条 ── -->
    <div v-if="setup.placing !== null" class="placing">
      <BaseTag kind="info">正在放置</BaseTag>
      <span class="num">
        {{ sideLabel(setup.placing.side) }}「{{ setup.placing.label }}」×{{ setup.placing.count }} ·
        候选 {{ setup.placing.candidates.length }} 格
      </span>
      <BaseButton variant="ghost" size="sm" @click="setup.cancelPlacement()">取消</BaseButton>
      <p class="muted">
        在地图上点**青柠色高亮格**落位（候选格由引擎按 IV-A / IV-I / 14.1a 给出）。
      </p>
    </div>

    <!-- ── ③ 初设单位 box（三分类） ── -->
    <section v-for="category in CATEGORIES" :key="category.key" class="box">
      <header class="box__head">
        <span class="box__title">{{ category.label }}</span>
        <BaseTag :kind="boxItems(category.key).length === 0 ? 'success' : 'neutral'">
          {{
            boxItems(category.key).length === 0
              ? '已清空'
              : `${boxItems(category.key).length} 项待落位`
          }}
        </BaseTag>
        <span class="box__hint muted">{{ category.hint }}</span>
      </header>
      <p v-if="boxItems(category.key).length === 0" class="muted">
        本类已全部落位（含「未设置 ⇒ 本局移除」）。
      </p>
      <ul v-else class="box__list">
        <li
          v-for="item in boxItems(category.key)"
          :key="`${item.kind}-${item.side}-${item.entryIndex}`"
        >
          <BaseTag :kind="item.side === 'axis' ? 'danger' : 'info'">{{
            sideLabel(item.side)
          }}</BaseTag>
          <span class="box__label">{{ item.label }} ×{{ item.count }}</span>
          <span class="muted num">{{ item.candidates.length }} 格可选</span>
          <BaseButton
            v-if="!isPlacing(item)"
            variant="secondary"
            size="sm"
            :disabled="item.candidates.length === 0"
            @click="begin(item)"
          >
            放置
          </BaseButton>
          <BaseButton v-else variant="ghost" size="sm" @click="setup.cancelPlacement()">
            取消
          </BaseButton>
        </li>
      </ul>
    </section>

    <p class="muted">
      「完成初设」（地图左上角的决策队列）会把 box
      里**尚未落位**的项记为「本局移除，不存在」，随后建会话并进入第一阶段（2.2）。
      共识开关列表已默认全部勾选（专规 4.0），无需逐条点选。
    </p>

    <!-- ── ④ 结论与数据缺口 ── -->
    <p v-if="setup.lastAction !== null" class="num">
      <BaseTag :kind="setup.lastAction.ok ? 'success' : 'danger'">
        {{ setup.lastAction.rule }}
      </BaseTag>
      {{ setup.lastAction.detail }}
    </p>
    <details v-if="setup.dataGaps.length > 0 || setup.notes.length > 0" class="gaps">
      <summary class="muted">
        数据缺口与提示（{{ setup.dataGaps.length + setup.notes.length }} 条，如实列出，不猜）
      </summary>
      <p v-for="(gap, index) in [...setup.dataGaps, ...setup.notes]" :key="index" class="muted num">
        · {{ gap }}
      </p>
    </details>

    <!-- ── ⑤ 开局流程明细（默认折叠，避免占满右侧菜单栏） ── -->
    <details class="detail">
      <summary>
        开局流程明细（编制抽取 / 卡车满载 / SP 归属 / 自动初设 / 飞机 / 自定义初设）
      </summary>

      <ul class="steps">
        <li v-for="step in steps" :key="step.id" class="steps__row">
          <BaseTag :kind="step.applicable ? (step.done ? 'success' : 'warning') : 'neutral'">
            {{ step.applicable ? (step.done ? '已完成' : '待办') : '本剧本不适用' }}
          </BaseTag>
          <span class="steps__label">{{ step.label }}</span>
          <span class="steps__rule num">{{ step.rule }}</span>
          <span class="steps__detail muted">{{ step.detail }}</span>
        </li>
      </ul>

      <!-- 编制抽取（抽签入口；池与 rng 在 C12 的剧本抽取盒） -->
      <p class="muted">
        编制抽取（ch10 /
        ch11）：入杯池与抽签在「记录轨与容器」面板的**剧本抽取盒**里做（那里才有池成员 与种子化
        rng）；抽中后的三项处置（沿道路西移 / 以 Move Mode 初设 / 与死亡堆互换）也在该盒里落盘。
      </p>
      <p v-if="drawGroups.length === 0" class="muted">
        本剧本的剧本页没有编队抽签条目 ⇒ 该步不适用。
      </p>
      <div v-for="group in drawGroups" :key="group.kind" class="row">
        <BaseTag kind="info">{{ group.label }} ×{{ group.count }}</BaseTag>
        <span class="num">{{ group.effect }}</span>
        <BaseButton variant="secondary" size="sm" @click="containers.drawFormations(group)">
          抽签（{{ group.count }} 个）
        </BaseButton>
        <span class="num">抽中：{{ drawnOf(group.kind).join('、') || '尚未抽签' }}</span>
      </div>
      <!--
        ★ I② 切片 2（用户 2026-09-18 报告第 5 条后半）：
          「应该调整位置的编队应该**放入初设**里让玩家设置位置」——
          ch10 的西移组抽中后就在**这里**（初设）逐条给落点，给完点「照此摆位」把该师的图上单位摆过去。
          修前只能在 B 段的抽取盒里点地图、且与初设没关系（"抽取的变化落不到初设"）。
      -->
      <RuleNote
        v-if="containers.pendingShiftWestPlacements.length > 0"
        title="ch10 西移：抽中的师在此设定落点（初设摆位）"
        rule="ch10"
        :open="true"
      >
        <div
          v-for="item in containers.pendingShiftWestPlacements"
          :key="item.formationId"
          class="row"
        >
          <span class="num">
            {{ item.formationId }}（原 {{ item.fromHexText ?? '—' }}，西移
            {{ item.shiftHexes }} 格）
          </span>
          <input
            v-if="uiMode === 'verify'"
            class="input num"
            :value="item.hexText ?? ''"
            placeholder="列.行"
            @change="
              containers.setDrawShiftHexNow(
                item.formationId,
                ($event.target as HTMLInputElement).value,
              )
            "
          />
          <span v-else class="ui-field-readonly">{{ item.hexText || '—' }}</span>
          <BaseButton variant="secondary" size="sm" @click="pickShiftWestHex(item.formationId)">
            点地图选落点
          </BaseButton>
        </div>
        <BaseButton variant="primary" size="sm" @click="containers.applyShiftWestPlacementsNow()">
          照此摆位（ch10）
        </BaseButton>
        <p class="muted num">
          位置印在剧本卡上、数据里没有 ⇒ 只能由你给；缺任一条即整笔拒绝（不猜）。
        </p>
      </RuleNote>
      <!--
        ★ 批 E 切片 2（用户 9.17③a）：**抽签结果回写初设** —— 落盘之后的"变化"在这里如实列出
          （抽中谁、本组处置、西移落点）。修前落盘只改盘面，初设这边看不见发生了什么，
          玩家得自己记住"Mtr 进了死亡堆 / Aufk 返场 / 哪几个师换了模式"。
      -->
      <RuleNote
        v-for="note in setup.formationDrawNotes"
        :key="note.groupKind"
        :title="`已回写初设：${note.groupLabel}（${note.formations.length} 个编队）`"
        rule="ch10 / ch11"
        :open="true"
      >
        <p class="muted num">{{ note.detail }}</p>
        <p v-if="note.destinations.length > 0" class="muted num">
          西移落点：{{ note.destinations.join('、') }}
        </p>
      </RuleNote>

      <hr />

      <!-- 卡车满载指定（通规 IV-C/D + 13.2h） -->
      <!--
        ★ 批 B 切片 1（用户报告 #8 / 9.16 #1-b）：**按剧本的装载模式分流** ——
          剧本页明示"全部满载 / 全部空载"时**不由玩家决定**（IV-D + 专规 Setup Note C），
          初设已自动落账 ⇒ 这里只给一行只读回执；只有"玩家自选 N 辆"才给勾选框与核验按钮。
          修前无论哪种模式都渲染 12 个复选框 + 登记按钮（整份文件不读 `truckLoadMode`），
          于是玩家被白问一遍，而**真正该看的那条**（剧本明示的模式）反而没写出来。
      -->
      <p class="muted">
        卡车满载（通规 IV-C/D + 13.2h）：剧本页原文「{{ setup.truckLoadSummary.raw }}」⇒ 本剧本
        <template v-if="setup.truckLoadSummary.mode === 'choose_loaded'">
          **由玩家自选**
          {{ setup.truckLoadSummary.fullCount }} 辆满载（其余空载）：勾选后按「核验并登记」落账。
        </template>
        <template v-else>
          <b>不由玩家决定</b>：初设已按剧本自动落账 满载 {{ setup.truckLoadSummary.fullCount }} /
          {{ setup.truckLoadSummary.total }} 辆（满载面按 13.2h 记作「运力 + F」），无需在此操作。
        </template>
      </p>
      <template v-if="setup.truckLoadSummary.mode === 'choose_loaded'">
        <div class="grid">
          <label v-for="truck in setup.setupTrucks" :key="truck.instanceId" class="check">
            <input
              type="checkbox"
              :checked="setup.truckFullIds.includes(truck.instanceId)"
              @change="
                setup.toggleTruckFull(truck.instanceId, ($event.target as HTMLInputElement).checked)
              "
            />
            <span class="num">{{ truck.unitId }}</span>
          </label>
        </div>
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="setup.designateTrucks()">
            核验并登记满载名单（{{ setup.truckFullIds.length }}/{{ setup.requiredFullTrucks }}）
          </BaseButton>
        </div>
      </template>
      <p
        v-else-if="setup.truckLoadSummary.mode !== null"
        class="num"
        :class="setup.truckLoadSummary.done ? 'ok' : 'bad'"
      >
        {{ setup.truckLoadSummary.done ? '已落账' : '未落账（请核对剧本数据）' }}： `loadedSpT` =
        满载 {{ setup.truckLoadSummary.fullCount }} 辆 × 1 SP
      </p>

      <hr />

      <!-- SP 归属划分（12.1d + Setup Note F + 3.4b） -->
      <p class="muted">
        SP 归属划分（12.1d）：通用 SP 算子双方共用，**谁带上图即谁拥有**；轴方地图内 SP 还要在初设期
        逐个点名装甲集群（Setup Note F / 3.4b）。本剧本**{{ requiresGroup ? '适用' : '不适用' }}**
        3.4b ——
        适用时已**按分界线自动填好默认归属**（分界线仅作参考，玩家仍可在此改），故不必逐个点名。
      </p>
      <table v-if="setup.spDumps.length > 0" class="table">
        <thead>
          <tr>
            <th>格</th>
            <th>点数</th>
            <th>归属（12.1d）</th>
            <th>装甲集群（3.4b）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="dump in setup.spDumps" :key="dump.id">
            <td class="num">{{ setupHexLabel(dump.hex) }}</td>
            <td class="num">{{ dump.points }}</td>
            <td>{{ dump.side === 'axis' ? '轴心国' : '苏联' }}</td>
            <td>
              <template v-if="dump.side === 'axis'">
                <select
                  :value="setup.spAssignments[dump.id] ?? ''"
                  @change="setGroup(dump.id, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">（未点名）</option>
                  <option value="guderian">Guderian</option>
                  <option value="hoth">Hoth</option>
                </select>
              </template>
              <span v-else class="muted">苏方不适用 3.4b</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">尚无 SP 台账 —— 自动初设已在选剧本时执行。</p>
      <div class="row">
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="setup.spDumps.length === 0"
          @click="setup.confirmSpOwnership()"
        >
          核验 SP 归属（12.1d / 3.4b）
        </BaseButton>
      </div>

      <hr />

      <!-- 自动初设 -->
      <p class="muted">
        自动初设（专规 Setup Notes + 通规 IV）：本剧本可直接落位 {{ planCounts.pieces }} 枚棋子、
        {{ planCounts.ledger }} 条计数账本，另有 {{ planCounts.choices }} 条自由项进初设 box。
        选剧本时已自动执行一次，此处可重跑。
      </p>
      <div class="row">
        <BaseButton variant="secondary" size="sm" @click="setup.runAutoSetup()"
          >重跑自动初设</BaseButton
        >
        <BaseTag :kind="setup.applied ? 'success' : 'neutral'">
          {{ setup.applied ? '已落盘' : '尚未落盘' }}
        </BaseTag>
      </div>

      <hr />

      <!-- 飞机初设（IV-E + 14.1a + 剧本页明文） -->
      <template v-for="side in ['axis', 'soviet'] as const" :key="`air-${side}`">
        <p class="muted">
          飞机初设 · {{ sideLabel(side) }}（14.1a）：剧本页原文「{{
            airPolicy(side)?.raw ?? '—'
          }}」⇒
          {{ airPolicy(side)?.statedInRules === true ? '规则书明文' : '按 IV-E 默认（全 Active）' }}
          <template
            v-if="airPolicy(side)?.reducedTypes && airPolicy(side)!.reducedTypes.length > 0"
          >
            ；`*` 减损机型：{{ airPolicy(side)!.reducedTypes.join('、') }}
          </template>
          已落位 {{ setup.airPlacedCount(side) }} 架。
        </p>
        <table v-if="airRows(side).length > 0" class="table">
          <thead>
            <tr>
              <th>机型</th>
              <th>枚数</th>
              <th>初始激活态</th>
              <th>减损</th>
              <th>基地格</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in airRows(side)" :key="row.entryIndex">
              <td>{{ row.name }}</td>
              <td class="num">{{ row.count }}</td>
              <td class="num">
                {{ row.statuses.filter((s) => s === 'active').length }} 激活 /
                {{ row.statuses.filter((s) => s === 'inactive').length }} 非激活
              </td>
              <td class="num">{{ row.reduced.filter(Boolean).length }}</td>
              <td>
                <select
                  v-if="row.candidates.length > 0"
                  :value="airChoiceOf(row.entryIndex)"
                  @change="
                    setup.setAirChoice(row.entryIndex, ($event.target as HTMLSelectElement).value)
                  "
                >
                  <option value="">（请选空军基地格）</option>
                  <option
                    v-for="candidate in row.candidates"
                    :key="`${candidate.col}.${candidate.row}`"
                    :value="`${candidate.col}.${candidate.row}`"
                  >
                    {{ setupHexLabel(candidate) }}
                  </option>
                </select>
                <span v-else class="muted">缺本方空军基地格 ⇒ 先落盘空军基地（自动初设）</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">本方初设条目里没有飞机条目。</p>
        <div class="row">
          <BaseButton variant="secondary" size="sm" @click="setup.runAirSetup(side)">
            落位本方飞机（{{ sideLabel(side) }}）
          </BaseButton>
        </div>
      </template>

      <hr />

      <!-- 玩家自定义初设（自由项） -->
      <template v-for="side in ['axis', 'soviet'] as const" :key="`self-${side}`">
        <p class="muted">
          玩家自定义初设 · {{ sideLabel(side) }}：{{ choicesOf(side).length }} 条自由项。
        </p>
        <table v-if="choicesOf(side).length > 0" class="table">
          <thead>
            <tr>
              <th>条目</th>
              <th>数量</th>
              <th>规则</th>
              <th>为何须自选</th>
              <th>落位格</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in choicesOf(side)" :key="entry.index">
              <td>{{ entry.raw }}</td>
              <td class="num">{{ entry.count }}</td>
              <td class="num">{{ entry.rule }}</td>
              <td class="muted">{{ candidateHint(candidatesOf(entry.index)) }}</td>
              <td>
                <select
                  v-if="candidatesOf(entry.index).length > 0"
                  :value="selfChoiceOf(entry.index)"
                  @change="
                    setup.setSelfChoice(entry.index, ($event.target as HTMLSelectElement).value)
                  "
                >
                  <option value="">（请选落位格）</option>
                  <option
                    v-for="candidate in candidatesOf(entry.index)"
                    :key="`${candidate.col}.${candidate.row}`"
                    :value="`${candidate.col}.${candidate.row}`"
                  >
                    {{ setupHexLabel(candidate) }}
                  </option>
                </select>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <BaseButton variant="ghost" size="sm" @click="setup.placeSelfEntry(entry.index)">
                  落位
                </BaseButton>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">本方初设没有自由项。</p>
      </template>

      <div class="row">
        <BaseButton variant="ghost" size="sm" @click="setup.resetAll()">
          重置初设（清空盘面与账本）
        </BaseButton>
      </div>
    </details>
  </BasePanel>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) 0;
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
}

.placing {
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm, 4px);
  padding: var(--space-2);
  margin: var(--space-2) 0;
  background: rgba(122, 168, 42, 0.08);
}

.box {
  margin: var(--space-3) 0;
}

.box__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
}

.box__title {
  font-weight: 600;
  font-size: var(--text-sm);
}

.box__hint {
  flex: 1 1 200px;
}

.box__list {
  margin: var(--space-1) 0;
  padding: 0;
  list-style: none;
}

.box__list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: 3px 0;
  font-size: var(--text-sm);
}

.box__label {
  flex: 1 1 160px;
}

.steps {
  margin: var(--space-1) 0;
  padding: 0;
  list-style: none;
}

.steps__row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  padding: 3px 0;
  font-size: var(--text-sm);
}

.steps__label {
  font-weight: 600;
}

.steps__rule {
  color: var(--color-muted);
}

.steps__detail {
  flex: 1 1 320px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--space-1);
  margin: var(--space-1) 0;
}

.check {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-sm);
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

.table th,
.table td {
  border-bottom: 1px solid var(--color-rule);
  padding: 2px var(--space-1);
  text-align: left;
  vertical-align: top;
}

.detail {
  margin: var(--space-3) 0;
}

.detail > summary {
  cursor: pointer;
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.gaps {
  margin: var(--space-2) 0;
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
}

.num {
  font-size: var(--text-sm);
}

hr {
  border: none;
  border-top: 1px solid var(--color-rule);
  margin: var(--space-3) 0;
}
</style>
