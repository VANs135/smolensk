<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseButton, BasePanel, BaseTag, RuleNote } from '@/components/base'
import { hexLabel } from '@/stores'
import { useWorkbenchStore } from '@/stores'

/**
 * 专规机制面板（W6 B19：Smolensk 专规 1.2 / 1.7 / 2.1a / 2.2 / 3.3b / 3.4 / 3.5）
 *
 * 覆盖用户要求的八件事（**全部走引擎判定**；本组件只画表、收输入、把输入写回 store）：
 *   · 动员分批解锁（2.4）：时点日历列出解锁日；
 *   · 装甲集群分界线与 SP 平分（3.4 / 3.4a / 3.4b）：声明编队归属 ⇒ 相位末分界线义务；Supply Table 均分；
 *   · 容量提升与补给关闭时点（1.2 / 2.1a）：铁路容量与补给源开放状态；
 *   · 治安需求（3.3b）：轴控城市未驻防、未盖 ZOC ⇒ 放苏军 Trainbusting；满足或转苏军 ⇒ H 清理段移除；
 *   · 可变撤离（3.3c）与随机事件（3.6，本作为 Supply Train / 地图外任务）：日历给时点，掷骰在 B18 面板；
 *   · 建设标记（3.5）：剧本 1/2 各 3 枚，免费建桥（13.8b）或简易机场（15.2），一次性、不可重建；
 *   · 苏军空军限制（1.2 / 轴方 3.2a）：阵营层预检（权威否决在引擎 assignAirMission 内）。
 *
 * 分层纪律（CODE_SPEC）：结论一律来自 store 对引擎的调用，这里不做任何规则计算。 */

const workbench = useWorkbenchStore()

/** 3.4：装甲集群声明表 */
const panzerUnitId = ref('')
const panzerGroupChoice = ref<'guderian' | 'hoth'>('guderian')
const panzerMultiUnit = ref(true)

/** 3.4b：Supply Table 到货点数（绑定 store，均分结果由引擎给出） */
const spSplit = computed(() => workbench.panzerGroupSpSplit)

/** 3.3b / 3.5 / 1.7：格输入与城市输入 */

/** 3.3b：治安检查结果 */
/** 16.0b/c：勾选/取消施工小队（只有这批单位作业后本阶段不能再移动） */
function toggleHedgehogWorker(unitId: string): void {
  const current = workbench.hedgehogInputs.workerIds
  workbench.hedgehogInputs = {
    ...workbench.hedgehogInputs,
    workerIds: current.includes(unitId)
      ? current.filter((id) => id !== unitId)
      : [...current, unitId],
  }
}

const security = computed(() => workbench.securityNeeds)

/** 2.1a：已关闭的补给源（当日） */
const closedSources = computed(() =>
  workbench.activeSupplySourceStatuses.filter((item) => !item.open),
)

/** 2.2：空军限制预检 */
const airAdvisory = computed(() => workbench.redAirForceAdvisory)

/** 3.4a：义务对应的编队中文名 */
function groupLabel(group: 'guderian' | 'hoth'): string {
  return group === 'guderian' ? 'Guderian 2nd Panzer Group' : 'Hoth 3rd Panzer Group'
}

/** 3.3b：标记该移除的**理由**（与引擎 `removalReasonOf` 的两个取值一一对应） */
function removalReasonLabel(reason: 'securityNeedsMet' | 'citySovietControlled' | null): string {
  if (reason === 'securityNeedsMet') return '治安需求已满足'
  if (reason === 'citySovietControlled') return '该城已转苏控'
  return '（无理由 ⇒ 不该移除）'
}

/** 3.4a：分界线的显示文本（地图数据缺失时给出提示，不臆造坐标） */
const boundaryLabel = computed(() => {
  const boundary = workbench.panzerGroupBoundary
  return boundary === null
    ? '（地图数据缺失）'
    : `${hexLabel(boundary.west)} → ${hexLabel(boundary.east)}`
})

/** 3.4a：Orsha 的显示文案 */
const orshaLabel = computed(() => {
  const hex = workbench.orshaHex
  return hex === null ? '（未找到）' : hexLabel(hex)
})

/** 1.2：铁路容量提升日（从专规时点日历里按类别取，不写死日期） */
const railCapBoostDate = computed(
  () => workbench.exclusiveTimings.find((item) => item.kind === 'railCapBoost')?.date ?? '—',
)

/** 3.4：一次性写入「是否多单位编队」与「所属集群」两个声明 */
function declarePanzerGroup(): void {
  workbench.setMultiUnitFormationNow(panzerUnitId.value, panzerMultiUnit.value)
  workbench.setPanzerGroupNow(panzerUnitId.value, panzerGroupChoice.value)
}

/**
 * B17a-3：**只渲染哪一段**（默认全渲染，引擎验证页照旧）
 *
 * 与前两批（增援 / 盒内）同一套做法，理由也一样（方案 §10①「右侧栏只读」）：
 *   · **只读信息**（`info`）：容量提升与补给关闭的时点、当日专规时点、分界线与已归属计数、
 *     分界线义务提示、治安需求的逐城明细、工事当前等级/上限与相位台账、建设标记余量、
 *     补给缓存持仓、苏军空军限制、错误条 —— 这些是"随时想看一眼"的；
 *   · **动作**（`actions`）：装甲集群的手工覆盖与 SP 归属声明、治安检查与轴控声明、
 *     工事修建/缩减与工程兵选择、建设标记的放置与枚数订正、补给缓存的使用 ——
 *     按方案 §4.3 进**会话框**（本面板的动作跨多个段，故由顶栏的「专规动作」按钮显式打开，
 *     不像增援那样由环节自动触发）。
 */
const props = withDefaults(defineProps<{ only?: 'info' | 'actions' | null }>(), { only: null })

/** 本实例是否要画"只读信息"那一段 */
const showsInfo = computed(() => props.only === null || props.only === 'info')
/** 本实例是否要画"动作"那一段 */
const showsActions = computed(() => props.only === null || props.only === 'actions')

/**
 * B37：**分节置顶判据**（哪一节"本环节该做"）
 *
 * 只读 store 的投影（`exclusiveSectionPins`）——组件不比较规则号、也不自己判时机。
 */
const pins = computed(() => workbench.exclusiveSectionPins)
</script>

<template>
  <BasePanel title="专规机制（W6 B19：1.2 / 1.7 / 2.1a / 2.2 / 3.3b / 3.4 / 3.5）">
    <!-- ══ 只读信息段（B17a-3：留右栏；会话里只保留必要的动作上下文） ══ -->
    <template v-if="showsInfo">
      <!-- ── · 容量提升与补给关闭时点（1.2 / 2.1a） ── -->
      <p class="muted">
        时点与容量（1.2 / 2.1a）：铁路容量于 {{ railCapBoostDate }} 提升（Entry L 至 Entry E
        及以西南缘补给源按 2.1a 永久关闭（关闭后不再产出补给源）。
      </p>
      <div class="row">
        <BaseTag kind="info">{{ workbench.date }}（第 {{ workbench.turn }} 回合）</BaseTag>
        <span class="num">
          铁路容量：轴 {{ workbench.railCapToday.axis }} / 苏
          {{ workbench.railCapToday.soviet }}（1.2）
        </span>
        <span class="num">
          当日补给源：开放
          {{ workbench.activeSupplySourceStatuses.length - closedSources.length }} / 共
          {{ workbench.activeSupplySourceStatuses.length }}（{{ workbench.activeSide }}）
        </span>
      </div>
      <p v-if="closedSources.length > 0" class="warn">
        <BaseTag kind="danger">2.1a</BaseTag>
        {{ workbench.activeSide }} 已关闭的补给源：{{
          closedSources.map((item) => `${hexLabel(item.hex)}（${item.closedBy}）`).join('、')
        }}
      </p>

      <p class="muted">
        当日专规时点（{{ workbench.todaysTimings.length }} 条）：
        <template v-if="workbench.todaysTimings.length === 0">—</template>
        <template v-else>
          {{ workbench.todaysTimings.map((item) => `${item.rule} ${item.detail}`).join('；') }}
        </template>
      </p>
    </template>
    <!-- ══ 动作段（会话框）：3.4 / 3.3b / 16.0b·c / 3.5 / 1.7 ══ -->

    <details class="excl" :open="pins.panzer" :style="{ order: pins.panzer ? 0 : 100 }">
      <summary class="excl__title">3.4 装甲集群（分界线 / SP 归属 / 供给均分）</summary>
      <!-- ── · 装甲集群分界线与 SP 平分（3.4 / 3.4a / 3.4b） ── -->
      <hr />
      <RuleNote
        title="装甲集群：分界线义务与到货 SP 均分（奇数点归 Guderian）"
        rule="3.4 / 3.4a / 3.4b"
      >
        <p class="muted">
          装甲集群（3.4）：**至 19 August 止**、**只约束多单位编队**（步兵师与独立单位不受限）。
          Guderian 编队须在分界线**上方**、Hoth 须在上或**下方**；与另一集群**同堆叠或相邻**，
          或处于**错误一侧且在 Orsha 以东**（19.xx 以西不受约束）⇒ 相位末对该编队**一个单位投**
          DG**（3.4a）。Supply Table 到货在**均分**给两集群后**奇数点归 Guderian**（3.4b）。
          **编队归属不用玩家设置**：已按素材库的编队目录（3rd Panzer Group → Hoth，其余 → Guderian）
          落进算子数据；下表只在需要**手工覆盖**时才用。
        </p>
      </RuleNote>
      <div class="row">
        <BaseTag kind="info">分界线 {{ boundaryLabel }}</BaseTag>
        <BaseTag kind="neutral">Orsha {{ orshaLabel }}</BaseTag>
        <span class="num">
          已归属 {{ workbench.panzerGroupAssignedCount }} 枚（默认取自素材编队目录）· 手工覆盖
          {{ Object.keys(workbench.panzerGroupAssignments).length }} 枚
        </span>
      </div>
      <div v-if="showsActions" class="row">
        <label class="field">
          算子
          <select v-model="panzerUnitId" class="select">
            <option :value="''">（选择）</option>
            <option v-for="unit in workbench.units" :key="unit.instanceId" :value="unit.instanceId">
              {{ unit.name }} @ {{ hexLabel(unit.hex) }}
            </option>
          </select>
        </label>
        <label class="field">
          集群
          <select v-model="panzerGroupChoice" class="select">
            <option value="guderian">Guderian</option>
            <option value="hoth">Hoth</option>
          </select>
        </label>
        <label class="field">
          <input v-model="panzerMultiUnit" type="checkbox" />
          属多单位编队（3.4）
        </label>
        <BaseButton variant="primary" size="sm" @click="declarePanzerGroup()">
          手工覆盖归属（3.4）
        </BaseButton>
        <BaseButton
          variant="ghost"
          size="sm"
          @click="workbench.setPanzerGroupNow(panzerUnitId, null)"
        >
          撤销覆盖
        </BaseButton>
      </div>
      <p v-for="(item, index) in workbench.panzerGroupObligations" :key="index" class="warn">
        <BaseTag kind="danger">{{ item.rule }}</BaseTag>
        {{ groupLabel(item.group) }}：{{ item.detail }}
      </p>
      <p v-if="workbench.panzerGroupObligations.length === 0" class="muted">
        当前没有分界线义务（未声明归属 / 非多单位编队 / 已过 19 August / 无越线或同堆叠相邻）。
      </p>
      <div v-if="showsActions && workbench.panzerGroupRulesOn" class="row">
        <label class="field">
          Supply Table 到货 SP
          <input
            v-model.number="workbench.supplyTableSpInput"
            class="input num"
            type="number"
            min="0"
          />
        </label>
        <span class="num">
          均分（3.4b）：Hoth {{ spSplit.hoth }} / Guderian {{ spSplit.guderian }}（奇数点归
          Guderian）
        </span>
      </div>
      <!--
        3.4b：SP 的**归属**（每座补给站挂在哪个集群）

        ★ B50（用户 2026-09-17 口径）：3.4b 是 4.1a 的**可选项**，进开场共识；
          **未采纳 ⇒ 本块整块不出现**（约束也不生效），只在下面留一句说明。
      -->
      <p v-if="!workbench.panzerGroupRulesOn" class="muted">
        本局**未启用** 3.4b（装甲集群 SP 归属约束）—— 开场共识里那条可选项未采纳 （专规 4.1a「ignore
        2.3e and/or 3.4」）⇒ SP 归属不受约束，也不出现归属界面。
      </p>
      <template v-else>
        <RuleNote
          title="SP 归属：新到的轴方 SP 必须归属某一装甲集群，「错误」集群不得用于多单位编队"
          rule="3.4b"
        >
          <p class="muted">
            SP 归属（3.4b）：**所有新到的轴心国 SP 必须立即归属某一装甲集群**；「错误」集群的 SP
            **不能**
            支付多单位编队的**燃油、战斗或轰炸**成本（其它用途不限）。未归属的轴方补给站会让上述三类付费被拒；
            在此逐个声明即可。
          </p>
        </RuleNote>
        <p v-if="workbench.panzerGroupUnassignedDumps.length === 0" class="muted">
          所有轴方补给站都已声明归属（或已过 19 August）。
        </p>
        <template v-if="showsActions">
          <div
            v-for="dump in workbench.panzerGroupUnassignedDumps"
            :key="`pg-${dump.id}`"
            class="row"
          >
            <BaseTag kind="warning">{{ hexLabel(dump.hex) }} 未归属</BaseTag>
            <span class="num">{{ dump.sp }} SP + {{ dump.t }} T</span>
            <BaseButton
              variant="primary"
              size="sm"
              @click="workbench.setDumpPanzerGroupNow(dump.id, 'guderian')"
            >
              归属 Guderian（2nd PG）
            </BaseButton>
            <BaseButton
              variant="secondary"
              size="sm"
              @click="workbench.setDumpPanzerGroupNow(dump.id, 'hoth')"
            >
              归属 Hoth（3rd PG）
            </BaseButton>
          </div>
        </template>
        <p class="num">
          已登记归属的补给站：{{ Object.keys(workbench.spDumpPanzerGroups).length }} 座
        </p>
      </template>
    </details>

    <!-- ── · 装甲集群（B37：按本环节可做与否置顶/折叠） ── -->

    <details class="excl" :open="pins.security" :style="{ order: pins.security ? 1 : 101 }">
      <summary class="excl__title">3.3b 治安需求（Trainbusting 标记）</summary>
      <!-- ── · 治安需求（3.3b） ── -->
      <hr />
      <RuleNote
        title="治安需求：轴控城市须由可攻击单位占据或被轴方 ZOC 覆盖，否则放苏军 Trainbusting 标记"
        rule="3.3b"
      >
        <p class="muted">
          治安需求（3.3b）：轴心国控制的**城市格**应由一个**可攻击**单位占据或被**轴方 ZOC** 覆盖；
          否则在该格放一枚苏军 **Trainbusting** 标记（可在**任意相位**放置）； 在**任意 H
          清理段**，若需求满足或该城转苏控则移除。城市控制状态由裁判维护（下方勾选/输入）。
        </p>
      </RuleNote>
      <div class="row">
        <template v-if="showsActions">
          <label class="field">
            城市格（列.行）
            <input v-model="workbench.cityControlHexText" class="input" placeholder="18.18" />
            <BaseButton
              variant="secondary"
              size="sm"
              @click="workbench.beginCityControlHexPickNow()"
            >
              点地图选格
            </BaseButton>
          </label>
          <BaseButton
            variant="secondary"
            size="sm"
            @click="workbench.toggleAxisCityControlNow(workbench.cityControlHexText)"
          >
            切换轴控声明（3.3b）
          </BaseButton>
        </template>
        <span class="num">
          轴控城市 {{ workbench.axisControlledCityKeys.length }} 座｜地图城市
          {{ workbench.mapCityHexes.length }} 座｜Trainbusting 标记
          {{ workbench.trainbustingMarks.length }} 枚
        </span>
        <BaseButton
          v-if="showsActions"
          variant="primary"
          size="sm"
          @click="workbench.applySecurityNeedsNow()"
        >
          执行治安检查（3.3b）
        </BaseButton>
      </div>
      <p v-if="security !== null" class="num">
        需放置 {{ security.placeAt.length }} 处：{{
          security.placeAt.length === 0
            ? '✓'
            : security.placeAt.map((hex) => hexLabel(hex)).join('、')
        }}｜需移除 {{ security.removeAt.length }} 处：{{
          security.removeAt.length === 0
            ? '✓'
            : security.removeAt.map((hex) => hexLabel(hex)).join('、')
        }}（{{
          workbench.phase === 'cleanUp' ? '当前 H 清理段 ⇒ 立即移除' : '须等到 H 清理段才移除'
        }}）
      </p>
      <!-- 逐城明细：哪座城要放标记、哪座该移除、为什么（动作取自 `checkSecurityNeeds`，理由取自 `removalReasonOf`） -->
      <RuleNote title="逐城明细：哪一城不满足治安需求（缺占据、缺 ZOC）" rule="3.3b">
        <p class="muted">
          逐城明细（3.3b）：轴控城市须由**可攻击**单位占据或被**轴方 ZOC**
          覆盖；两者都不满足即在**任意相位**放置一枚苏军 Trainbusting 标记；满足或该城**转苏控** ⇒
          在**任意 H 清理段**移除。「移除理由」与「执行时机」两列即 3.3b 的两条闸门。
        </p>
      </RuleNote>
      <div v-for="row in workbench.securityCityDetails" :key="row.label" class="row">
        <BaseTag
          :kind="
            row.action === 'place' ? 'danger' : row.action === 'remove' ? 'warning' : 'neutral'
          "
        >
          {{ row.label }}
        </BaseTag>
        <span class="num">
          {{ row.controlledByAxis ? '轴控' : '非轴控' }}｜占据 {{ row.occupied ? '✓' : '✗' }}｜ZOC
          {{ row.zoc ? '✓' : '✗' }}｜标记 {{ row.marked ? '✓' : '✗' }}｜{{
            row.action === 'place'
              ? '需放标记'
              : row.action === 'remove'
                ? `需移除（${removalReasonLabel(row.removalReason)}${row.removalAllowedNow ? '，当前可执行' : '，须到 H 清理段'}）`
                : '无事'
          }}
        </span>
      </div>
    </details>

    <!-- ── · 治安需求（B37：按本环节可做与否置顶/折叠） ── -->

    <details class="excl" :open="pins.hedgehog" :style="{ order: pins.hedgehog ? 2 : 102 }">
      <summary class="excl__title">16.0b/c 环形工事（修建 / 缩减）</summary>
      <!-- ── 16.0b/c 环形工事的修建与缩减（＋专规 1.3a 印刷工事、1.3b 上限、2.3e 苏军禁建期） ── -->
      <RuleNote
        title="环形工事：移动阶段由格内指定小队修建（+1 级 2 SP）或缩减（−1 级免费）"
        rule="16.0b/c"
      >
        <p class="muted">
          16.0b/c 环形工事：在**移动阶段**由「目标格内**指定的一小队单位**」（RE 合计 ≥
          1、逐员战斗模式、本阶段未移动）修建（+1 级，2 SP/级）或缩减（−1
          级，**免费**）。每格每回合最多 ±1 级； **专规 1.3b 上限 1 级**（**苏军 1941 年 8 月 1
          日回合之前不得修建**（专规 2.3e）； **专规 1.3a：地图印刷工事永久且不可降低**（共
          {{ workbench.printedHedgehogPositions.length }} 处）。
        </p>
      </RuleNote>
      <RuleNote
        title="两条执行途径：原地小队（须在目标格内）/ 工程兵（2 格步行 MP 半径内）"
        rule="16.0b / 13.8d"
      >
        <p class="muted">
          两条执行途径（16.0b 原文「一个**具有工程能力**的单位也可以完成这项工作（**13.8d**）」）：
          **① 原地小队**＝目标格内指定的一小队单位（须在**目标格内**）； **②
          工程兵（13.8d）**＝具工程能力的单位在 **2 格步行 MP** 半径内施工（**不必在目标格内**），
          并额外受 13.8d 的公共前提约束（**一格一任务**、本阶段未移动、半径按地形算）。
        </p>
      </RuleNote>
      <div v-if="showsActions" class="row">
        <label class="field">
          执行途径
          <select v-model="workbench.hedgehogExecutorMode" class="select">
            <option value="inPlace">① 目标格内指定的小队（16.0b）</option>
            <option value="engineer">② 工程兵（2 格半径内，13.8d）</option>
          </select>
        </label>
        <label v-if="workbench.hedgehogUsesEngineerRoute" class="field">
          施工工程兵（13.8d）
          <select v-model="workbench.hedgehogEngineerId" class="select">
            <option :value="null">（请选择）</option>
            <option
              v-for="unit in workbench.engineerChoices"
              :key="unit.instanceId"
              :value="unit.instanceId"
            >
              {{ unit.name }} @ {{ hexLabel(unit.hex) }}
            </option>
          </select>
        </label>
        <label class="field">
          目标格
          <input v-model="workbench.hedgehogInputs.hexText" class="input" placeholder="36.13" />
          <BaseButton
            variant="secondary"
            size="sm"
            @click="workbench.beginHedgehogHexPickNow('build')"
          >
            点地图选格（修建）
          </BaseButton>
        </label>
        <label class="field">
          付款补给站（修建用；缩减免费）
          <select v-model="workbench.hedgehogInputs.payDumpId" class="select">
            <option :value="null">（不指定）</option>
            <option v-for="dump in workbench.spDumpsOfSide" :key="dump.id" :value="dump.id">
              {{ hexLabel(dump.hex) }}（{{ dump.sp }} SP + {{ dump.t }} T）
            </option>
          </select>
        </label>
        <BaseButton variant="primary" size="sm" @click="workbench.buildHedgehogNow()">
          修建/改进 +1 级（16.0b）
        </BaseButton>
        <BaseButton variant="secondary" size="sm" @click="workbench.reduceHedgehogNow()">
          缩减 −1 级（16.0c：免费）
        </BaseButton>
      </div>
      <p v-if="workbench.hedgehogUsesEngineerRoute" class="num">
        13.8d 施工者：{{ workbench.hedgehogEngineer?.name ?? '（未选工程兵）' }} → 目标格
        {{
          workbench.hedgehogTargetHex === null
            ? '（未填/格式错）'
            : hexLabel(workbench.hedgehogTargetHex)
        }}
        ｜步行 MP 距离
        {{
          workbench.hedgehogEngineerLegRange === null ? '—' : workbench.hedgehogEngineerLegRange
        }}（上限 2；超出即拒，13.8d）｜本阶段已施工：{{
          workbench.constructionPhaseLedger.hexes.join('、') || '—'
        }}（任务 {{ workbench.constructionPhaseLedger.task ?? '—' }}）
      </p>
      <p
        v-if="workbench.hedgehogUsesEngineerRoute && workbench.engineerChoices.length === 0"
        class="muted"
      >
        当前方没有可施工的工程单位（13.8a/5.5b：须有工程能力且处于战斗模式，或 DG 朝战斗面）。
      </p>
      <div v-if="showsActions && !workbench.hedgehogUsesEngineerRoute" class="row">
        <span class="muted">
          施工小队（在目标格内勾选；只有这批单位作业后本阶段不能再移动，其余照常行动）：
        </span>
        <BaseButton
          v-for="unit in workbench.units.filter((item) => item.side === workbench.activeSide)"
          :key="unit.instanceId"
          variant="ghost"
          size="sm"
          @click="toggleHedgehogWorker(unit.instanceId)"
        >
          {{ unit.name }}（{{ unit.re }}RE @ {{ hexLabel(unit.hex) }}）{{
            workbench.hedgehogInputs.workerIds.includes(unit.instanceId) ? ' ✓' : ''
          }}
        </BaseButton>
      </div>
      <p v-if="workbench.hedgehogError !== null" class="bad">
        <BaseTag kind="danger">{{ workbench.hedgehogError.rule }}</BaseTag>
        {{ workbench.hedgehogError.reason }}
      </p>
      <p class="num">
        本回合已提升/已降低的格：{{ Object.keys(workbench.hedgehogTurnLedger).length }} 格
      </p>
    </details>

    <!-- ── · 环形工事（B37：按本环节可做与否置顶/折叠） ── -->

    <details
      class="excl"
      :open="pins.constructionMarker"
      :style="{ order: pins.constructionMarker ? 3 : 103 }"
    >
      <summary class="excl__title">专规 3.5 建造标记（桥 / 简易机场）</summary>
      <!-- ── · 建设标记（3.5） ── -->
      <hr />
      <RuleNote title="建造标记：剧本 1/2 各 3 枚，轴方移动前放在有轴方战斗单位的格" rule="3.5">
        <p class="muted">
          建造标记（3.5）：剧本 1/2 初设各 3 枚（其余剧本 0 枚）。可在**任一轴方移动阶段**、
          在**单位移动之前**，把某一枚放进一个有**轴方战斗单位**的格——**免费**：桥按 13.8b 由 HQ
          架桥、简易机场按 15.2
          的标准简易机场处理；**每枚只能用一次**、且**不可重建**；只有苏军战斗单位进入其格才会被毁。
        </p>
      </RuleNote>
      <div class="row">
        <BaseTag :kind="workbench.constructionMarkers > 0 ? 'info' : 'neutral'">
          剩余 {{ workbench.constructionMarkers }} 枚
        </BaseTag>
        <template v-if="showsActions">
          <label class="field">
            <input
              class="input num"
              type="number"
              min="0"
              :value="workbench.constructionMarkers"
              @change="
                workbench.setConstructionMarkersNow(
                  Number(($event.target as HTMLInputElement).value),
                )
              "
            />
            手改枚数
          </label>
          <label class="field">
            →
            <!--
              ★ 批 D 切片 2（房规①：值要被 store 动作读、又被界面写 ⇒ 必须是 **store 字段**）：
                这里原来是一个**组件局部 ref**（`markerKind`），而落盘动作在 store 里
                ⇒ 界面之外的路径（标记盒会话框）拿不到它。现在两处**共用** `workbench.constructionMarkerKind`。
            -->
            <select v-model="workbench.constructionMarkerKind" class="select">
              <option value="bridge">桥（13.8b）</option>
              <option value="airStrip">简易机场（15.2）</option>
            </select>
          </label>
          <label class="field">
            放置格
            <input
              v-model="workbench.constructionMarkerHexText"
              class="input"
              placeholder="36.13"
            />
            <BaseButton
              variant="secondary"
              size="sm"
              @click="workbench.beginConstructionMarkerHexPickNow()"
            >
              点地图选格
            </BaseButton>
          </label>
          <BaseButton
            variant="primary"
            size="sm"
            @click="
              workbench.useConstructionMarkerNow(
                workbench.constructionMarkerKind,
                workbench.constructionMarkerHexText,
              )
            "
          >
            放置建设标记（3.5）
          </BaseButton>
        </template>
      </div>
      <!-- 专规 3.5：已放置的标记（不可移动 / 不可重建；只有苏军战斗单位进入其格才会被毁） -->
      <p v-if="workbench.constructionMarkerPieces.length > 0" class="muted">
        已放置：
        <span v-for="piece in workbench.constructionMarkerPieces" :key="piece.id" class="num">
          {{ piece.kind === 'bridge' ? '桥' : '简易机场' }} @ {{ hexLabel(piece.hex) }}｜
        </span>
      </p>
    </details>

    <!-- ── · 建设标记（B37：按本环节可做与否置顶/折叠） ── -->

    <details class="excl" :open="pins.supplyCache" :style="{ order: pins.supplyCache ? 4 : 104 }">
      <summary class="excl__title">1.7 / 21.10 补给缓存（Shells / Forage）</summary>
      <!-- ── · 补给缓存（1.7 / 21.10） ── -->
      <hr />
      <RuleNote
        title="补给缓存：Shells（抵付 2T 炮击成本）/ Forage（D 段断补首回合）"
        rule="1.7 / 21.10"
      >
        <p class="muted">
          补给缓存（1.7，来自通规 21.10，本作为**标准规则**）：每方每剧本开局各 2 枚，可经 1.6c
          特殊补员追加。 **Shells**：在任意友方 HQ 处花 1 枚抵付该次投递的**火炮轰炸成本
          2T**（成本降到 0 以下不找零， 且**即使该 HQ
          不在追溯补给中也可用**）；**Forage**：只在**补给阶段（D 段）**、 只在有 HQ
          **断补的第一个回合**、且**不可用于矛头部队**，为其投递距离内所有战斗单位提供追溯补给。
        </p>
      </RuleNote>
      <div class="row">
        <BaseTag kind="info">轴 {{ workbench.supplyCacheHoldings.axis }} 枚</BaseTag>
        <BaseTag kind="info">苏 {{ workbench.supplyCacheHoldings.soviet }} 枚</BaseTag>
        <BaseButton
          v-if="showsActions"
          variant="ghost"
          size="sm"
          @click="workbench.addSupplyCacheNow(workbench.activeSide)"
        >
          追加 1 枚（1.6c）
        </BaseButton>
      </div>
      <div v-if="showsActions" class="row">
        <label class="field">
          用法
          <select v-model="workbench.supplyCacheInputs.use" class="select">
            <option value="shells">Shells（弹药）</option>
            <option value="forage">Forage（应急征粮）</option>
          </select>
        </label>
        <label class="field">
          友方 HQ 格
          <input v-model="workbench.supplyCacheInputs.hexText" class="input" placeholder="36.13" />
          <BaseButton variant="secondary" size="sm" @click="workbench.beginSupplyCacheHexPickNow()">
            点地图选格
          </BaseButton>
        </label>
        <template v-if="workbench.supplyCacheInputs.use === 'shells'">
          <label class="field">
            本次投递成本 T
            <input
              v-model.number="workbench.supplyCacheInputs.barrageCostT"
              class="input num"
              type="number"
              min="1"
            />
          </label>
          <label class="field">
            <input v-model="workbench.supplyCacheInputs.hqDrawsTraceSupply" type="checkbox" />
            该 HQ 在追溯补给中（不影响合法性）
          </label>
        </template>
        <template v-else>
          <label class="field">
            HQ 投递距离（格）
            <input
              v-model.number="workbench.supplyCacheInputs.hqThrowRangeHexes"
              class="input num"
              type="number"
              min="0"
            />
          </label>
          <!--
            21.10 的「断补的第一个回合」不再由玩家/裁判勾选（批 F 切片 5）：判据按盘面事实算
            （`cutSinceTurn`，与 12.8e 同源）—— 这一行原来是个复选框，等于"自己说自己是首回合"。
          -->
        </template>
        <BaseButton variant="primary" size="sm" @click="workbench.spendSupplyCacheNow()">
          花掉 1 枚（1.7）
        </BaseButton>
      </div>
      <p v-if="workbench.lastSupplyCacheUse !== null" class="ok">
        {{ workbench.lastSupplyCacheUse }}
      </p>
    </details>

    <!-- ── · 补给缓存（B37：按本环节可做与否置顶/折叠） ── -->

    <details
      class="excl"
      :open="pins.airRestriction"
      :style="{ order: pins.airRestriction ? 5 : 105 }"
    >
      <summary class="excl__title">1.2 苏军空军限制（只读提示）</summary>
      <!-- ── · 苏军空军限制（1.2 / 轴方 3.2a） ── -->
      <hr />
      <RuleNote
        title="赤色空军限制：不得低空扫射 / 不得需计划的空降 / IL.2 一步 / 反应与进击阶段不出击"
        rule="1.2 / 3.2a"
      >
        <p class="muted">
          赤色空军限制（1.2）：**2.2a** 苏军不得低空扫射（轴方 3.2a：天气允许时可用）； **2.2b**
          允许补给空投、不得需计划的空降（14.10b）；**2.2c** IL.2（Early Sturmovik）只有一步；
          **2.2d** 苏军不得在本方**反应 / 进击阶段**出击。下列为**当前任务选择的预检**；
          权威否决在引擎宣布任务时给出。
        </p>
      </RuleNote>
      <p v-if="airAdvisory === null" class="muted">
        当前阶段（{{ workbench.phase }}）不会宣布空军任务（14.1g：只有 C/E/G 三个环节可飞）。
      </p>
      <p v-else-if="airAdvisory.ok" class="num">
        <BaseTag kind="success">{{ airAdvisory.rule }}</BaseTag>
        {{ airAdvisory.data.detail }}
      </p>
      <p v-else class="warn">
        <BaseTag kind="danger">{{ airAdvisory.rule }}</BaseTag>
        当前选择被限制：{{ airAdvisory.reason }}
      </p>

      <p v-if="workbench.exclusiveError !== null" class="warn">
        <BaseTag kind="danger">{{ workbench.exclusiveError.rule }}</BaseTag>
        {{ workbench.exclusiveError.reason }}
      </p>
    </details>
  </BasePanel>
</template>

<style scoped>
/*
 * B37：分节容器（`<details>`）
 *   · `open` 与 `order` 都由 `pins` 给 ⇒ 可做的排前面且展开，其余排后面且收起；
 *   · 收起时仍可点开查看（不删信息，只是不碍事）。
 */
.excl {
  margin-bottom: var(--space-2);
}

.excl__title {
  cursor: pointer;
  font-weight: 600;
  font-size: var(--text-sm);
  margin-bottom: var(--space-1);
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.input {
  width: 88px;
}

.select {
  max-width: 260px;
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

.warn {
  color: var(--color-accent);
  font-size: var(--text-sm);
  margin: var(--space-1) 0;
}

hr {
  border: none;
  border-top: 1px solid var(--color-rule);
  margin: var(--space-3) 0;
}
</style>
