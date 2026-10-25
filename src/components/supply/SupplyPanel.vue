<script setup lang="ts">
import { computed, ref } from 'vue'

import { BaseButton, BasePanel, BaseTag, RuleNote } from '@/components/base'
import UiField from '@/components/UiField.vue'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
import {
  counterImageUrlOf,
  hexLabel,
  isHqUnit,
  spDumpImageUrlOf,
  useWorkbenchStore,
} from '@/stores'

/**
 * 补给面板（C8：OCS 12.0 章）
 *
 * 走 `engine/rules/supply-interaction.ts` 的状态机，覆盖用户要求的四条交互链：
 *   ① **追溯与投递可视化**：来源清单列出距离/路径，「地图」上铺出该来源的拖取/投递覆盖与最省路径
 *      （12.3a 直接拖取 / 12.3b 指挥部投递 / 12.3c 相邻即可 / 12.3d 补给路径）；
 *   ② **SP 拆分合并**：12.1a 的加总与拆分（1 SP = 4 T，「尽可能并为 SP」）；
 *   ③ **拖取与投递选择**：选来源 → 定 T 数与用途 → 结算（12.3；投递须立即使用 12.3b-A）；
 *   ④ **断补处置**：12.6c 吃图上补给（每 1T 覆盖最多 2RE，小数向上取整）或 12.6d 接受断补。
 *
 * 分层纪律（CODE_SPEC）：本组件**不做任何规则计算** —— 步骤、来源可用性、距离、成本、
 * 判定结论全部来自 store 对引擎的调用；这里只画图、收点击、把输入写进 `supplyInputs`。
 */

const workbench = useWorkbenchStore()

/** 步骤清单（12.6 → 12.3 → 12.6c/d） */
const checklist = computed(() => workbench.supplyChecklist)
/** 结论摘要 */
const summary = computed(() => workbench.supplySummary)

/**
 * 12.3 / 12.5 / 15.1（批 B 切片 2）：本次拖取/投递**应付多少 T** 及其费率出处
 *
 * `null` ＝「战斗补给（12.4）」这类**不在本链付**的用途（裁定⑥）；`manual` ＝ 数量即内容
 * （12.10 储备 / 13.8 建造）⇒ 才显示手填框。判据全在 store（`supplyPickupRequirement`），本组件只读。
 */
const pickupRequirement = computed(() => workbench.supplyPickupRequirement)

/**
 * 可做补给检查的单位（B18c：**只有战斗单位**）
 *
 * 12.0 的「重要提示」：「只有战斗单位需要补给。非战斗单位、空军单位和海军战斗单位**永远不会**
 * 消耗 SP，永远不需要追溯补给」。故候选直接取 store 的 `supplyCheckCandidates`（它用引擎的
 * `requiresTraceSupply` 过滤），本组件不再自己筛一遍。
 */
const checkCandidates = computed(() => workbench.supplyCheckCandidates)

/** 12.3：用途选项（12.3 首段的用途清单） */
const PURPOSES = [
  { key: 'fuel', label: '燃料（12.5）' },
  { key: 'refit', label: '飞机整备（15.1）' },
  { key: 'internalStocks', label: '补充部队储备（12.10）' },
  { key: 'build', label: '建造费用（13.8）' },
] as const
/*
 * ★ 批 B 切片 2（裁定⑥）：「战斗补给（12.4）」**不在本链** —— 12.4 的战斗补给在**战斗的当口**
 *   支付（9.5 的「战斗补给」步），由战斗会话的「战斗补给来源（12.4）」付款。
 *   本链选它会被 store 按 12.4 拒，故不再列为可选项（少一个必然踩的坑）。
 */

/** 12.6a①②：基础补给源类别（专规/剧本给出，操作台只做声明） */
const SOURCE_KINDS = [
  { key: 'edgeRail', label: '地图边缘铁路格（12.6a①）' },
  { key: 'supplySourceHex', label: '专规补给源格（12.6a①）' },
  { key: 'detrainable', label: '火车卸货格（12.6a②）' },
] as const

/** 12.1a：账本条目的「已规范化」提示（T < 4 即已尽可能并为 SP） */
function isNormalized(sp: number, t: number): boolean {
  return t < 4 && sp >= 0
}

/* ── 13.3f / 专规 1.2：轨距账本 —— 「谁能用这条铁路」（与 13.3a 多轨的运量费用无关） ── */

/** 13.3f：铁路修理单位候选（数据标记 `specialized` 含 `'rail_repair'`；本作尚未入库 ⇒ 空） */
const railRepairUnits = computed(() =>
  workbench.units.filter((unit) => unit.specialized.includes('rail_repair')),
)

/** 13.3f 转换动作的输入（单位实例 + 目标格文本） */
const gaugeUnitId = ref<string>('')

/** 换轨账本前若干格（清单可能很长，面板只列前 12 个） */
const convertedPreview = computed(() => workbench.convertedRailHexes.slice(0, 12))

/* ── 12.11a 销毁补给站的输入（站 / 可选的销毁量；骰面已按 B28 改为自动） ── */
const destroyDumpId = ref<string>('')
const destroyT = ref<number | null>(null)

/* ── 12.7 转换的输入（转换格号 / 型号 / 待翻面的延补队） ── */
const convertKind = ref<'truck' | 'wagon'>('truck')
const convertExtenderId = ref<string>('')

/* ── 12.8b 损耗：格键与"是否需要分摊"的判读（分摊额由玩家填，本处只在有损失时展开输入） ── */
function dutyKey(duty: { hex: { col: number; row: number } }): string {
  return `${duty.hex.col}.${duty.hex.row}`
}

function attritionNeedsAllocation(key: string): boolean {
  const rolled = workbench.attritionResults[key]
  if (rolled === undefined) return false
  return rolled.losses.kind === 'allSteps' || rolled.losses.steps > 0
}

/* ─────────────────── 算子图阵列（B14d；用户口径⑪） ───────────────────
 *
 * 「把当前可选的**算子图片**紧凑排出来；页面太多就在合适位置**加下拉**切换；
 *  算子上信息已经够了，除了环节提示这种外不需要显示额外的文字」。
 * 故本面板所有「选算子」的位置改用 `CounterPicker`（来源清单还额外用上了**分组下拉**：
 * 拖取 / 指挥部投递 / 基础源 / 延补队 / 吃图上补给 —— 正是「页面太多」那一档）。
 * **本组件不做任何规则判断**：可用性（`ok`/`reason`）与候选集都由引擎经 store 给出。
 */

/** 悬停某一枚 ⇒ 同步地图高亮它所在的格 */
function hoverUnit(id: string | null): void {
  const unit = id === null ? null : (workbench.units.find((item) => item.instanceId === id) ?? null)
  workbench.setHoverHex(unit?.hex ?? null)
}

/** 悬停某一座补给站 ⇒ 同步地图高亮 */
function hoverDump(id: string | null): void {
  const dump = id === null ? null : (workbench.spDumpsOfSide.find((item) => item.id === id) ?? null)
  workbench.setHoverHex(dump?.hex ?? null)
}

/** 补给站阵列条目（12.1b 账本；图用**当前点数的 SP 算子图**） */
function dumpItem(dump: {
  id: string
  hex: { col: number; row: number }
  side: 'axis' | 'soviet'
  sp: number
  t: number
}): CounterPickerItem {
  return {
    id: dump.id,
    imageUrl: spDumpImageUrlOf(dump),
    name: `${hexLabel(dump.hex)}（${dump.sp} SP + ${dump.t} T）`,
    selected: false,
    hex: dump.hex,
  }
}

/** 12.11a：可销毁的补给站（**每阶段每站一次** ⇒ 已试过的灰显） */
const destroyDumpItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.spDumpsOfSide.map((dump) => {
    const tried = (workbench.dumpDestructionAttempts[dump.id] ?? 0) > 0
    return {
      ...dumpItem(dump),
      selected: destroyDumpId.value === dump.id,
      disabledReason: tried ? '12.11a：本阶段该站已尝试过销毁（每阶段每站一次）' : null,
    }
  }),
)

/** 13.2c：运输点数算子（合并多选 / 拆分对象 / 装卸对象 —— 三处各用自己的选中口径） */
function transportItem(unit: (typeof workbench.transportPointsOfSide)[number]): CounterPickerItem {
  return {
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name:
      `${unit.name}（${unit.noncombatTransport} 点 @ ${hexLabel(unit.hex)}` +
      `，已载 ${unit.loadedSpT / 4} SP）`,
    selected: false,
    hex: unit.hex,
  }
}

const transportMergeItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.transportPointsOfSide.map((unit) => ({
    ...transportItem(unit),
    selected: workbench.transportPointInputs.mergeIds.includes(unit.instanceId),
  })),
)

const transportSplitItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.transportPointsOfSide.map((unit) => ({
    ...transportItem(unit),
    selected: workbench.transportPointInputs.splitId === unit.instanceId,
  })),
)

const transportLoadItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.transportPointsOfSide.map((unit) => ({
    ...transportItem(unit),
    selected: workbench.transportLoadInputs.pointId === unit.instanceId,
  })),
)

/** 12.6：受补给单位（当前方图上算子；点一枚即对它逐个检查） */
const checkUnitItems = computed<readonly CounterPickerItem[]>(() =>
  checkCandidates.value.map((unit) => ({
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name: `${unit.name}（${unit.re} RE @ ${hexLabel(unit.hex)}）`,
    selected: workbench.supplyUnitId === unit.instanceId,
    hex: unit.hex,
  })),
)

/** 12.7d / 9.14d：延补队（翻回运输点数 / 主动崩溃） */
const extenderItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.units
    .filter((unit) => unit.noncombatKind === 'supply_extender')
    .map((unit) => ({
      id: unit.instanceId,
      imageUrl: counterImageUrlOf(unit),
      name: `${unit.name} @ ${hexLabel(unit.hex)}`,
      selected: convertExtenderId.value === unit.instanceId,
      hex: unit.hex,
    })),
)

/** 13.3f：铁路修理单位阵列（本作尚未入库 ⇒ 空；入库后自动出现） */
const railRepairItems = computed<readonly CounterPickerItem[]>(() =>
  railRepairUnits.value.map((unit) => ({
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name: `${unit.name} @ ${hexLabel(unit.hex)}`,
    selected: gaugeUnitId.value === unit.instanceId,
    hex: unit.hex,
  })),
)

/** 13.3a：铁路运货的起运站（SP 货） */
const railFromDumpItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.spDumpsOfSide.map((dump) => ({
    ...dumpItem(dump),
    selected: workbench.railMoveInputs.fromDumpId === dump.id,
  })),
)

/** 12.3b：投递的付款站（点同一座即回到「自动」＝候选第一座） */
const payDumpItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.supplyPayDumpCandidates.map((dump) => ({
    ...dumpItem(dump),
    selected: workbench.supplyInputs.payFromDumpId === dump.id,
  })),
)

/**
 * 12.3a/b/c/d：**补给来源清单** —— 唯一用上「分组下拉」的地方
 *
 * 来源有五类（拖取 / 指挥部投递 / 基础源 / 延补队 / 吃图上补给），一次判定可能同时给出多类，
 * 正是用户说的「页面太多就在**合适位置加下拉切换**」。图：补给站用 SP 算子图、HQ/延补队用其算子图，
 * **基础源与吃图上补给没有算子**（正文里就没有对应算子）⇒ 用**格号角标**代替图。
 * 悬停 ⇒ 走既有的 `setSupplyPreview`（地图上铺覆盖范围与最省路径，12.3d）。
 */
const sourceItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.supplySources.map((source, index) => {
    const hex = source.hex
    const sameHex = (item: { hex: { col: number; row: number } }): boolean =>
      hex !== null && item.hex.col === hex.col && item.hex.row === hex.row
    const ownUnits = workbench.units.filter(
      (unit) => unit.side === workbench.activeSide && sameHex(unit),
    )
    // 图要取**对的**那一枚：投递取该格 HQ、延补队取该格的延补队，别随手取同格的第一枚
    const imageUrl =
      source.kind === 'dump'
        ? (() => {
            const dump = workbench.spDumpsOfSide.find(sameHex)
            return dump === undefined ? null : spDumpImageUrlOf(dump)
          })()
        : source.kind === 'hqThrow'
          ? (() => {
              const hq = ownUnits.find((unit) => isHqUnit(unit))
              return hq === undefined ? null : counterImageUrlOf(hq)
            })()
          : source.kind === 'extender'
            ? (() => {
                const extender = ownUnits.find((unit) => unit.noncombatKind === 'supply_extender')
                return extender === undefined ? null : counterImageUrlOf(extender)
              })()
            : null
    return {
      id: String(index),
      imageUrl,
      name: workbench.supplySourceLabel(source),
      selected: false,
      disabledReason: source.ok ? null : `${source.rule}：${source.reason ?? source.detail}`,
      groupKey: source.kind,
      groupLabel: workbench.supplySourceKindLabel(source.kind),
      hex,
      // 没有算子的来源（基础源 / 吃图上补给）用格号角标，免得整片是空框而认不出是哪一格
      badge: imageUrl === null && hex !== null ? hexLabel(hex) : undefined,
    }
  }),
)

/** 悬停来源 ⇒ 既有的 `setSupplyPreview`（地图上铺该来源的覆盖与最省路径） */
function hoverSource(id: string | null): void {
  workbench.setSupplyPreview(id === null ? null : Number(id))
}

/**
 * B15e：**只渲染哪一段**（默认全渲染，引擎验证页照旧）
 *
 * 与 `AirPanel` 同一套做法（B15d）：补给面板混着两类东西——
 * ① **账本与事务**（12.1a 拆并 SP / 12.11a 销毁 / 13.2c 运输点 / 12.7 延补队 / 12.6a 补给源 /
 *    13.3f 轨距 / 13.3a 铁路 / 12.1–12.2 的 D 段总计划）——这些是**随时可做**的准备动作；
 * ② **逐单位检查链**（12.6 判定 → 12.3 选来源/拖取 → 12.6c/d 断补处置）——这是**一次行动的收束**，
 *    按方案 §4.3 该在地图会话框里做。
 * 故侧栏挂 `only="ledger"`（含"受补给单位"入口）、地图会话挂 `only="check"`。
 */
const props = withDefaults(
  defineProps<{
    only?: 'check' | 'ledger' | 'sp' | 'dumpBlow' | 'transport' | 'extender' | 'loadUnload' | null
  }>(),
  { only: null },
)

/** 本实例是否要画"逐单位检查链"那一段 */
const showsCheck = computed(() => props.only === null || props.only === 'check')

/**
 * ★ 用户 2026-10-25「**在什么环节，点什么单位才出现什么菜单**」：
 *   账本段内部再按**一个操作**细分 —— `sp` / `dumpBlow` / `transport` / `extender` / `loadUnload`
 *   由 `mapView.unitActionOptions()`（设施动作族 ∩ 本环节闸门）挑出来，会话里只画这一段；
 *   `ledger` 仍是"账本全显"（右栏 / 验证页口径不变）。
 */
function sub(part: 'sp' | 'dumpBlow' | 'transport' | 'extender' | 'loadUnload'): boolean {
  return props.only === null || props.only === 'ledger' || props.only === part
}

const showsSp = computed(() => sub('sp'))
const showsDumpBlow = computed(() => sub('dumpBlow'))
const showsTransport = computed(() => sub('transport'))
const showsExtender = computed(() => sub('extender'))
const showsLoadUnload = computed(() => sub('loadUnload'))

/** 本实例是否要画"账本与事务"那一段（＝任一分段要求） */
const showsLedger = computed(
  () =>
    showsSp.value ||
    showsDumpBlow.value ||
    showsTransport.value ||
    showsExtender.value ||
    showsLoadUnload.value,
)
</script>

<template>
  <BasePanel title="补给与 SP（C8：OCS 12.0）">
    <div class="row">
      <BaseButton
        variant="secondary"
        size="sm"
        @click="workbench.setSupplyActive(!workbench.supplyActive)"
      >
        {{ workbench.supplyActive ? '关闭补给工具' : '开启补给工具' }}
      </BaseButton>
    </div>

    <p v-if="!workbench.supplyActive && props.only === null" class="muted">
      开启后按 12.0 章逐步结算：判定补给状态（12.6）→ 选来源（12.3a 拖取 / 12.3b 投递）→ 定 T
      数与用途 → 结算；无追溯补给时走断补处置（12.6c 吃图上补给 / 12.6d 接受断补）。
    </p>

    <template v-else-if="workbench.supplyActive || props.only !== null">
      <!-- ══ 账本与事务段（12.1a/12.11a/13.2c/12.7/12.6a/13.3f/13.3a/12.1–12.2）══
           B15e：这一段留在**侧栏**（地图会话挂 `only="check"`）。"受补给单位"入口也在这里，
           因为它必须**随时可达**（会话只在检查开始后才存在）。 -->
      <template v-if="showsLedger">
        <template v-if="showsSp">
          <!-- ── ① SP 账本（12.1b：含 SP 的位置即补给站） ── -->
          <p class="muted">
            补给站账本（12.1b：任何含 SP 的位置都是补给站；1 SP = 4 T）。 本操作台以账本代替盘面上的
            SP 算子——12.1a 的拆分/找零需要多枚等额算子，引擎只看持仓数值。
          </p>
          <div class="row">
            <label class="field">
              格号（列.行）
              <UiField v-model="workbench.spDumpDraft.hexText" class="input" placeholder="36.13" />
              <BaseButton variant="secondary" size="sm" @click="workbench.beginSpDumpHexPickNow()">
                点地图选格
              </BaseButton>
            </label>
            <label class="field">
              SP
              <UiField v-model="workbench.spDumpDraft.sp" class="input num" type="number" min="0" />
            </label>
            <label class="field">
              T
              <UiField v-model="workbench.spDumpDraft.t" class="input num" type="number" min="0" />
            </label>
            <BaseButton variant="secondary" size="sm" @click="workbench.addSpDump()">
              新增补给站（12.1b）
            </BaseButton>
          </div>

          <p v-if="workbench.spDumpsOfSide.length === 0" class="muted">当前方尚无补给站。</p>
          <div v-for="dump in workbench.spDumpsOfSide" :key="dump.id" class="row">
            <BaseTag kind="info">{{ hexLabel(dump.hex) }}</BaseTag>
            <span class="num">
              {{ dump.sp }} SP + {{ dump.t }} T
              <span v-if="!isNormalized(dump.sp, dump.t)">（可加总：12.1a）</span>
            </span>
            <label class="field">
              拆
              <UiField
                v-model="workbench.supplyInputs.spToSplit"
                class="input num"
                type="number"
                min="0"
                :max="dump.sp"
                stepper
              />
              SP
            </label>
            <BaseButton
              variant="ghost"
              size="sm"
              @click="workbench.splitSpDumpHoldings(dump.id, workbench.supplyInputs.spToSplit)"
            >
              拆分（12.1a）
            </BaseButton>
            <BaseButton variant="ghost" size="sm" @click="workbench.mergeSpDumpHoldings(dump.id)">
              加总（12.1a）
            </BaseButton>
            <BaseButton variant="ghost" size="sm" @click="workbench.removeSpDump(dump.id)">
              移除
            </BaseButton>
          </div>

          <template v-if="showsDumpBlow"> </template>
          <!-- ── ①b 12.11a 销毁补给站（只在移动环节；每阶段每站一次；运输点数不能以此摧毁） ── -->
          <p class="muted">
            销毁补给站（12.11a）：担心被夺时可在**移动环节**销毁本站 SP（掷 1 骰查百分比，损失按 T
            取整）。 每个阶段每个补给站只能尝试一次；**运输点数不能以此方式摧毁**。
          </p>
          <div class="row">
            <label class="field"> 已试过的站会**灰掉**（12.11a：每阶段每站一次） </label>
          </div>
          <!-- B14d：补给站＝**算子图阵列**（原来是纯文字下拉） -->
          <CounterPicker
            title="要销毁的补给站（12.11a）"
            hint="12.11a：只在移动环节；每阶段每站一次；运输点数不能以此摧毁"
            :items="destroyDumpItems"
            :size="32"
            @pick="destroyDumpId = $event"
            @hover="hoverDump"
          />
          <div class="row">
            <label class="field">
              销毁量（T；留空＝全部 SP）
              <UiField
                v-model="destroyT"
                class="input num"
                type="number"
                min="1"
                placeholder="全部"
                readonly
              />
            </label>
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="destroyDumpId === ''"
              @click="workbench.destructDumpNow(destroyDumpId, destroyT ?? undefined)"
            >
              销毁（12.11a）
            </BaseButton>
          </div>

          <template v-if="showsTransport"> </template>
          <!-- ── ①c 运输点数（13.2c 合并/拆分、12.7 与延补队双向转换） ── -->
          <RuleNote title="合并 / 拆分运输点数：同格、同类、本方移动阶段（不耗 MP）" rule="13.2c">
            <p class="muted">
              运输点数（13.2c）：合并/拆分**不耗
              MP**，只能在本方**移动阶段**做，且所有算子须在**同一格**；
              **不同类型永不合并**（含编内卡车）。12.7a：同格合计满 **5 点**可转为一枚延补队（消耗 ½
              MA， 余数留原格）；12.7d：延补队可在移动环节主动翻回 5 点运输点数（同样消耗自身 ½
              MA）。
            </p>
          </RuleNote>
          <div class="row">
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="workbench.transportPointInputs.mergeIds.length < 2"
              @click="workbench.mergeTransportPointsNow()"
            >
              合并选中（13.2c）
            </BaseButton>
            <label class="field">
              拆分为（空格分隔各份规模）
              <!-- 13.2c：各份规模是**列表**（如 "2 3"），步进表达不了 ⇒ 保留普通输入（正式界面也可用） -->
              <input
                v-model="workbench.transportPointInputs.splitSizesText"
                class="input"
                placeholder="2 3"
              />
            </label>
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="workbench.transportPointInputs.splitId === null"
              @click="workbench.splitTransportPointNow()"
            >
              拆分（13.2c）
            </BaseButton>
          </div>
          <!-- B14d：运输点数＝**算子图阵列**（原来是逐点数的文字复选框 + 每行一个"选为拆分对象"按钮） -->
          <CounterPicker
            title="合并（13.2c，点两枚及以上）"
            hint="13.2c：合并/拆分不耗 MP，只能在本方移动阶段、且所有算子须在**同一格**；不同类型永不合并"
            :items="transportMergeItems"
            :size="32"
            @pick="workbench.toggleTransportMerge($event)"
            @hover="hoverUnit"
          />
          <CounterPicker
            title="拆分对象（点一枚）"
            hint="13.2c：拆分只作用于这一枚（份数在上面的输入框里给）"
            :items="transportSplitItems"
            :size="32"
            @pick="workbench.transportPointInputs.splitId = $event"
            @hover="hoverUnit"
          />
          <p v-if="workbench.transportPointsOfSide.length === 0" class="muted">
            （当前方图上没有运输点数算子）
          </p>

          <template v-if="showsLoadUnload"> </template>
          <!-- ── ①d 13.2f 运输点数的装载 / 卸载 SP ── -->
          <RuleNote
            title="装载 / 卸载 SP：装载须与补给站同格、卸载须在有战斗单位/设施或已卸站的格"
            rule="13.2f"
          >
            <p class="muted">
              装载/卸载
              SP（13.2f）：运输点数**在任何格**都能装载，但必须与**补给站**同格；卸载只能在含
              **友方战斗单位、港口、空军基地或已有已卸载补给站**的格内。两种情况都要支付它**印刷 MA
              的 10%** （按 6.1a 计入本阶段已耗 MP）。**编内卡车永远不能在地图上卸载**（13.2g-A）。
              载量记在点数的「已载」上——9.14 的夺取表按此计入战利品。
            </p>
          </RuleNote>
          <!-- B14d：装卸对象＝**算子图阵列**（原来是纯文字下拉；已载量在 title 里） -->
          <CounterPicker
            title="装卸对象（13.2f）"
            hint="13.2f：装载须与补给站同格、卸载须在含友方战斗单位/港口/空军基地/已卸载补给站的格；两者都付印刷 MA 的 10%"
            :items="transportLoadItems"
            :size="32"
            @pick="workbench.transportLoadInputs.pointId = $event"
            @hover="hoverUnit"
          />
          <div class="row">
            <label class="field">
              SP 数（1 SP = 4 T）
              <UiField
                v-model="workbench.transportLoadInputs.amount"
                class="input num"
                type="number"
                min="1"
                stepper
              />
            </label>
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="workbench.transportLoadInputs.pointId === null"
              @click="workbench.loadTransportPointNow()"
            >
              装载 SP（13.2f）
            </BaseButton>
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="workbench.transportLoadInputs.pointId === null"
              @click="workbench.unloadTransportPointNow()"
            >
              卸载 SP（13.2f）
            </BaseButton>
          </div>
          <p v-if="workbench.transportLoadError !== null" class="bad">
            <BaseTag kind="danger">{{ workbench.transportLoadError.rule }}</BaseTag>
            {{ workbench.transportLoadError.reason }}
          </p>
          <template v-if="showsExtender"> </template>
          <div class="row">
            <label class="field">
              转换格号
              <UiField v-model="workbench.convertTargetHexText" class="input" placeholder="36.13" />
              <BaseButton
                variant="secondary"
                size="sm"
                @click="workbench.beginConvertTargetHexPickNow()"
              >
                点地图选格
              </BaseButton>
            </label>
            <label class="field">
              型号
              <select v-model="convertKind" class="select">
                <option value="truck">truck（卡车）</option>
                <option value="wagon">wagon（马车）</option>
              </select>
            </label>
            <BaseButton
              variant="secondary"
              size="sm"
              @click="
                workbench.convertTransportToExtenderNow(workbench.convertTargetHexText, convertKind)
              "
            >
              转为延补队（12.7a）
            </BaseButton>
          </div>
          <!-- B14d：延补队＝**算子图阵列**（原来是纯文字下拉） -->
          <CounterPicker
            title="延补队（12.7d 翻回 / 9.14d 主动崩溃）"
            hint="12.7d：移动环节可主动翻回 5 点运输点数（消耗 ½ MA）；9.14d：以主动崩溃替代常规移动"
            :items="extenderItems"
            :size="32"
            @pick="convertExtenderId = $event"
            @hover="hoverUnit"
          />
          <div class="row">
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="convertExtenderId === ''"
              @click="workbench.flipExtenderToTransport(convertExtenderId)"
            >
              翻回 5 点运输点数（12.7d）
            </BaseButton>
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="convertExtenderId === ''"
              @click="workbench.collapseExtenderNow(convertExtenderId)"
            >
              主动崩溃（9.14d：替代常规移动）
            </BaseButton>
          </div>
          <RuleNote
            title="9.14d 主动崩溃：延补队在移动环节位移到「特殊拖取距离内且有追溯补给」的格"
            rule="9.14d"
          >
            <p class="muted">
              9.14d
              主动崩溃：延补队不能移动，可在**移动环节**用它替代常规移动——位移到**特殊拖取距离**
              （12.7b：战斗面印值 MA，卡车 20 / 马车
              10）内、且**该格此刻有追溯补给**的任意格；敌方单位 / ZOC /
              禁入地形概不影响。落格后翻面到运输点数面；**若无合法格则无法崩溃**：原地翻面，并按
              9.14c 判夺取。
            </p>
          </RuleNote>
        </template>
        <!-- ── ② 基础补给源声明（12.6a①②；来自专规/剧本） ── -->
        <p class="muted">
          基础补给源（12.6a①②：地图边缘铁路格 / 专规列出的补给源格 / 火车卸货格）——
          该数据来自专规与剧本，故由玩家声明（不臆造）。
        </p>
        <div class="row">
          <label class="field">
            格号
            <UiField
              v-model="workbench.supplySourceDraft.hexText"
              class="input"
              placeholder="36.13"
            />
            <BaseButton
              variant="secondary"
              size="sm"
              @click="workbench.beginSupplySourceHexPickNow()"
            >
              点地图选格
            </BaseButton>
          </label>
          <label class="field">
            类别
            <select v-model="workbench.supplySourceDraft.kind" class="select">
              <option v-for="item in SOURCE_KINDS" :key="item.key" :value="item.key">
                {{ item.label }}
              </option>
            </select>
          </label>
          <BaseButton variant="secondary" size="sm" @click="workbench.addSupplySource()">
            声明补给源（12.6a）
          </BaseButton>
        </div>
        <p v-for="decl in workbench.supplySourceDecls" :key="decl.id" class="num">
          <BaseTag kind="neutral">{{ hexLabel(decl.hex) }}</BaseTag>
          {{ workbench.supplySourceKindLabel(decl.kind) }}
          <BaseButton variant="ghost" size="sm" @click="workbench.removeSupplySource(decl.id)">
            移除
          </BaseButton>
        </p>

        <!-- ── ②b 轨距账本（13.3f / 专规 1.2：谁可以用这条铁路） ── -->
        <RuleNote
          title="轨距账本：苏方只能用宽轨、轴方只能用标准轨（只决定谁能用，与运量费用无关）"
          rule="13.3f"
        >
          <p class="muted">
            轨距账本（13.3f / 专规 1.2）：铁路线只有宽轨与标准轨两种，**印刷图开局全为宽轨**；
            就铁路运货**与获得追溯补给**而言，**苏方只能使用宽轨、轴方只能使用标准轨**。
            剧本初设的换轨（剧本页 `Converted Axis Rails`）由剧本数据逐格推导；
            轨距只决定**谁能用**，与 13.3a「多轨减半」的**运量费用**是两件事。
          </p>
        </RuleNote>
        <p class="num">
          印刷轨距 <BaseTag kind="neutral">{{ workbench.printedRailGauge }}</BaseTag> ｜换轨目标
          <BaseTag kind="neutral">{{ workbench.convertedRailGauge }}</BaseTag> ｜已换轨
          <BaseTag :kind="workbench.convertedRailHexes.length > 0 ? 'success' : 'warning'">
            {{ workbench.convertedRailHexes.length }} 格
          </BaseTag>
          <template v-if="convertedPreview.length > 0">
            ｜{{ convertedPreview.join('、') }}
            <template v-if="workbench.convertedRailHexes.length > convertedPreview.length"
              >…</template
            >
          </template>
        </p>
        <div class="row">
          <BaseButton variant="secondary" size="sm" @click="workbench.seedConvertedRailsNow()">
            按剧本初设重取换轨（专规 1.2）
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="workbench.clearConvertedRailsNow()">
            清空换轨账本（裁判订正）
          </BaseButton>
        </div>
        <!-- B14d：铁路修理单位＝**算子图阵列**（本作尚未入库 ⇒ 阵列显示"本组没有可选的算子"） -->
        <CounterPicker
          title="铁路修理单位（13.3f）"
          hint="13.3f：转换轨距不耗 SP / MP；候选＝具铁路修理能力的单位（本作尚未入库，补员后自动出现）"
          :items="railRepairItems"
          :size="32"
          @pick="gaugeUnitId = $event"
          @hover="hoverUnit"
        />
        <div class="row">
          <label class="field">
            目标铁路格
            <UiField v-model="workbench.railGaugeTargetHexText" class="input" placeholder="36.13" />
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="gaugeUnitId === ''"
              @click="workbench.beginRailGaugeTargetHexPickNow(gaugeUnitId)"
            >
              点地图选格
            </BaseButton>
          </label>
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="gaugeUnitId === ''"
            @click="workbench.convertRailGaugeNow(gaugeUnitId, workbench.railGaugeTargetHexText)"
          >
            转换轨距（13.3f：不耗 SP / MP）
          </BaseButton>
        </div>
        <p v-if="railRepairUnits.length === 0" class="muted">
          当前单位库里**没有**铁路修理单位算子（RR Bn / RR Rgt 尚未入库）⇒ 13.3f 的逐格转换暂时
          只能按剧本初设走；补员后本处会自动出现可选单位。
        </p>

        <!-- ── ②c 铁路运货（13.3a / 13.3b / 13.3e） ── -->
        <hr />
        <RuleNote
          title="铁路运货：登车 → 沿铁路移动 → 卸货（同一阶段走完，按铁路容量计费）"
          rule="13.3"
        >
          <p class="muted">
            铁路运货（13.3）：**只能在移动阶段**（13.3b）。三步＝**登车 → 沿铁路移动 →
            卸货**，须同一阶段 完成（13.3e）。费用按**铁路容量**计：**1 点容量运 1 SP 或 1
            RE，距离不限**（13.3a）；
            路径含**运输破坏区**则费用翻倍、**全程多轨**则减半（两条可累计）。当日容量（专规 1.2）：
            轴
            {{ workbench.railCapToday.axis }} / 苏
            {{ workbench.railCapToday.soviet }} 点，**每回合**清零。 单位须**移动模式**、非
            DG，且登车前移动不超过**一半 MA**（13.3e-1）；铁路格须**轨距正确**
            （13.3f）且**受本方控制**（13.3h）；沿途**不可进入**敌战斗单位或 EZOC
            之格；**卸货后不得再移动**（4.7d）。
          </p>
        </RuleNote>
        <p class="num">
          本回合已用容量：轴 {{ workbench.railCapUsedBy('axis') }}／{{
            workbench.railCapToday.axis
          }}
          ｜ 苏 {{ workbench.railCapUsedBy('soviet') }}／{{ workbench.railCapToday.soviet }}（余
          {{ workbench.railCapRemaining.axis }} /
          {{ workbench.railCapRemaining.soviet }}）｜本阶段已铁路移动
          {{ workbench.railMovedUnitIdsThisPhase.length }} 个单位（4.7d：同一阶段只用一种运输类型）
        </p>
        <div class="row">
          <label class="field">
            卸货格（列.行）
            <UiField
              v-model="workbench.railMoveInputs.toHexText"
              class="input"
              placeholder="36.13"
            />
            <BaseButton variant="secondary" size="sm" @click="workbench.beginRailMoveHexPickNow()">
              点地图选格
            </BaseButton>
          </label>
          <BaseButton variant="primary" size="sm" @click="workbench.railMoveNow('unit')">
            铁路运货：**选中的单位**（13.3e）
          </BaseButton>
        </div>
        <!-- B14d：起运补给站＝**算子图阵列**（原来是纯文字下拉） -->
        <CounterPicker
          title="起运补给站（13.3a：SP 货）"
          hint="13.3a：1 点容量运 1 SP 或 1 RE、距离不限；货须从**轨距正确且受本方控制**的站起运"
          :items="railFromDumpItems"
          :size="32"
          @pick="workbench.railMoveInputs.fromDumpId = $event"
          @hover="hoverDump"
        />
        <div class="row">
          <label class="field">
            SP 货量
            <UiField
              v-model="workbench.railMoveInputs.spAmount"
              class="input num"
              type="number"
              min="1"
              stepper
            />
          </label>
          <BaseButton variant="secondary" size="sm" @click="workbench.railMoveNow('sp')">
            铁路运货：**SP**（13.3a）
          </BaseButton>
          <!-- B39 / B-3：13.3a「每个铁路运量点数可以运输一个 SP **或 RE**」⇒ 运输点数本身也能作货物 -->
          <BaseButton
            variant="secondary"
            size="sm"
            @click="workbench.railMoveNow('transportPoint')"
          >
            铁路运货：**选中的运输点数**（13.3a / 4.7）
          </BaseButton>
        </div>
        <p v-if="workbench.lastRailMove !== null" class="ok">
          <BaseTag kind="success">{{ workbench.lastRailMove.rule }}</BaseTag>
          {{ workbench.lastRailMove.detail }}｜容量费 {{ workbench.lastRailMove.cost }} 点｜路径
          {{ workbench.lastRailMove.path.map((hex) => hexLabel(hex)).join(' → ') }}
        </p>
        <p v-if="workbench.railMoveError !== null" class="bad">
          <BaseTag kind="danger">{{ workbench.railMoveError.rule }}</BaseTag>
          {{ workbench.railMoveError.reason }}
        </p>
        <RuleNote
          title="尚未接线（如实登记）：13.3a 的运输点数货物 / 13.3g 铁路修理例外等"
          rule="13.3"
        >
          <p class="muted">
            ★ 尚未接线：**运输点数作为铁路货物**（13.3a 的第三类货物）、13.3g 的铁路修理单位例外
            （任意铁路格登车 / 战斗模式可铁路移动 / 卸货后仍有完整 MA）——后者要等 RR 算子入库；
            13.3c 末句的「运货时 EZOC 不可抵消」目前仍走 4.5b 抵消后的事实。
          </p>
        </RuleNote>

        <!-- ── ②c D 段补给阶段总计划（12.1–12.2；顺序由 12.10e-A 定死） ── -->
        <RuleNote
          title="D 段总计划：恢复储备 → 逐单位评估 → 吃图上补给 → 断补标记 → 损耗骰"
          rule="12.1–12.2"
        >
          <p class="muted">
            D 段总计划（12.1–12.2）：引擎按 12.10e-A 的顺序一次给全——
            <b>① 部队储备强制恢复</b> → ② 逐单位补给评估（12.6）→ ③ 吃图上补给分配（12.6c） → ④
            断补标记置/除（12.6d）→ ⑤ 需掷损耗的堆叠（12.8a/b）。
            恢复是**强制**项（「各单位必须尽可能地恢复部队储备」，12.10e-A），可用 T
            缺省取己方补给站的全部实有量。
          </p>
        </RuleNote>
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="workbench.planSupplyPhaseNow()">
            载入 D 段总计划（12.1–12.2）
          </BaseButton>
          <BaseButton variant="ghost" size="sm" @click="workbench.clearSupplyPhasePlan()">
            清空计划（改输入后重载）
          </BaseButton>
        </div>
        <template v-if="workbench.supplyPhasePlan !== null">
          <p class="num">
            恢复：{{ workbench.supplyPhasePlan.internalStocks.recoveries.length }} 个单位／消耗
            {{ workbench.supplyPhasePlan.internalStocks.spentT }} T
            <template v-if="workbench.supplyPhasePlan.internalStocks.wastedT > 0">
              （其中 {{ workbench.supplyPhasePlan.internalStocks.wastedT }} T 按 12.10e-C 浪费）
            </template>
            ｜剩余 {{ workbench.supplyPhasePlan.remainingT }} T｜断补 置
            {{ workbench.supplyPhasePlan.outOfSupply.mark.length }} / 除
            {{ workbench.supplyPhasePlan.outOfSupply.clear.length }}｜需掷损耗
            {{ workbench.supplyPhasePlan.attritionDuty.length }} 格
          </p>
          <div class="row">
            <BaseButton
              variant="secondary"
              size="sm"
              @click="workbench.applySupplyPhaseRecoveryNow()"
            >
              落盘：部队储备强制恢复（12.10e）
            </BaseButton>
            <BaseButton
              variant="secondary"
              size="sm"
              @click="workbench.applySupplyPhaseFeedingNow()"
            >
              落盘：喂食 + 断补标记（12.6c / 12.6d）
            </BaseButton>
          </div>
          <p class="muted">
            落盘次序照 12.10e-A：**先恢复、再喂食**；喂食只作用于勾了"自愿吃图上补给"的单位 （12.6c
            游戏说明：**永不强迫**）。
          </p>
          <p v-if="workbench.forageHints.length > 0" class="num">
            <BaseTag kind="warning">21.10 Forage 可用</BaseTag>
            {{ workbench.forageHints.map((item) => hexLabel(item.hex)).join('、') }}
            —— 这些断补 HQ 可花掉一枚补给缓存，为其投递距离内的所有战斗单位提供追溯补给。
          </p>

          <!-- ── ⑤ 12.8b 损耗：断补堆叠逐格掷骰 + 分摊 ── -->
          <template v-if="workbench.supplyPhasePlan.attritionDuty.length > 0">
            <RuleNote
              title="12.8b 损耗：2 骰 + 修正（格中断补军力 ≥5 时 +3），按格取列查表"
              rule="12.8b"
            >
              <p class="muted">
                12.8b 损耗（断补堆叠逐格）：2 骰 + 修正（格中断补军力 ≥5 时
                +3），取列用格内**最高行动值** （12.8c：DG 不修正
                AR）。结果的军力点数由拥有者决定如何分摊——**没有**"AR 最高者必须承受"的要求。
              </p>
            </RuleNote>
            <div
              v-for="duty in workbench.supplyPhasePlan.attritionDuty"
              :key="dutyKey(duty)"
              class="block"
            >
              <p class="num">
                <BaseTag kind="neutral">{{ dutyKey(duty) }}</BaseTag>
                最高 AR {{ duty.bestAr }}｜断补 {{ duty.oosSteps }} 军力｜
                <template v-if="workbench.attritionResults[dutyKey(duty)] !== undefined">
                  掷 {{ workbench.attritionResults[dutyKey(duty)]!.die }}
                  <template v-if="workbench.attritionResults[dutyKey(duty)]!.drm > 0">
                    +{{ workbench.attritionResults[dutyKey(duty)]!.drm }}
                  </template>
                  = {{ workbench.attritionResults[dutyKey(duty)]!.modifiedDice }} ⇒
                  <BaseTag kind="warning">{{
                    workbench.attritionResults[dutyKey(duty)]!.raw
                  }}</BaseTag>
                </template>
                <template v-else>（未掷骰）</template>
              </p>
              <div class="row">
                <!-- B28：骰面自动（不再让玩家填"2 骰之和"） -->
                <BaseButton
                  variant="secondary"
                  size="sm"
                  @click="workbench.rollAttritionNow(dutyKey(duty))"
                >
                  掷损耗骰（12.8b）
                </BaseButton>
              </div>
              <template v-if="attritionNeedsAllocation(dutyKey(duty))">
                <div v-for="unitId in duty.unitIds" :key="unitId" class="row">
                  <label class="field">
                    {{ workbench.unitNameOf(unitId) }} 分摊军力
                    <UiField
                      :model-value="
                        workbench.attritionInputs[dutyKey(duty)]?.allocation[unitId] ?? 0
                      "
                      class="input num"
                      type="number"
                      min="0"
                      stepper
                      @update:model-value="
                        workbench.setAttritionAllocation(dutyKey(duty), unitId, Number($event))
                      "
                    />
                  </label>
                </div>
                <BaseButton
                  variant="primary"
                  size="sm"
                  @click="workbench.applyAttritionNow(dutyKey(duty))"
                >
                  落盘分摊（12.8b）
                </BaseButton>
              </template>
            </div>
          </template>
          <p v-else class="muted">本阶段没有需要掷损耗的断补堆叠（12.8a/b）。</p>
          <p class="muted">
            注：③ 喂食与 ④ 断补标记的落盘走下方既有的 12.6c/12.6d 路径（同一批单一写入点）。
          </p>
        </template>
        <p v-if="workbench.supplyPhaseError !== null" class="bad">
          <BaseTag kind="danger">{{ workbench.supplyPhaseError.rule }}</BaseTag>
          {{ workbench.supplyPhaseError.reason }}
        </p>

        <!-- ── ③ 选定受补给单位 ── -->
        <p class="muted">受补给单位（当前方；12.6 只对战斗单位要求追溯补给，12.0）：</p>
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="workbench.evaluateTraceSupplyNow()">
            全场判定追溯补给（12.6 / 12.8）
          </BaseButton>
        </div>
        <p class="muted">
          一次判完全场：断补的单位其战斗值减半（12.8d）、不投射 ZOC（4.5）、
          突围（12.8e）在**移动面板**的「可尝试突围的单位」一节发起（只在**突围环节**可用）。本处的判据与那一节**同源**。
        </p>
        <!-- B14d：受补给单位＝**算子图阵列**（原来是一排"名字（RE，格号）✓"的文字按钮） -->
        <CounterPicker
          title="受补给单位（当前方）"
          hint="12.6：只对战斗单位要求追溯补给；点一枚即对它逐个检查（RE 与格号在悬停提示里）"
          :items="checkUnitItems"
          :size="40"
          @pick="workbench.beginSupplyCheckNow($event)"
          @hover="hoverUnit"
        />

        <!-- ── 步骤清单（12.6 → 12.3 → 12.6c/d） ── -->
      </template>
      <!-- ══ 逐单位检查链（12.6 判定 → 12.3 选来源/拖取 → 12.6c/d 断补处置）══
           B15e：这一段进**地图会话框**（点"受补给单位"里的一枚即开） -->
      <template v-if="showsCheck">
        <p v-if="checklist.length > 0" class="num">
          <BaseTag
            v-for="item in checklist"
            :key="item.step"
            :kind="item.done ? 'success' : 'neutral'"
          >
            {{ item.label }}{{ item.done ? ' ✓' : '' }}
          </BaseTag>
        </p>

        <!-- ── ④ 判定结论与来源清单（追溯与投递可视化） ── -->
        <template v-if="summary !== null">
          <p class="num">
            <BaseTag :kind="summary.status === 'inSupply' ? 'success' : 'warning'">
              {{ workbench.supplyStatusLabel(summary.status) }}
            </BaseTag>
            单位 {{ hexLabel(summary.unitHex) }}｜来源 {{ summary.sourceCount }} 条
            <template v-if="summary.canEatOffTheMap">
              ｜吃图上补给需 {{ summary.eatingCostT }} T（12.6c）
            </template>
          </p>

          <template v-if="workbench.supplyState?.step === 'selectSource'">
            <RuleNote
              title="选来源：12.3a 直接拖取（5 MP 内或相邻）/ 12.3b 指挥部投递（印值投递距离内）"
              rule="12.3a / 12.3b"
            >
              <p class="muted">
                选择来源（12.3a 直接拖取：5 MP 内或相邻；12.3b 指挥部投递：印值投递距离内）。
                鼠标移到来源上可在地图上预览它的覆盖范围与最省路径（12.3d）。
                来源按类别**分组**（标题栏右端下拉切换），不可用者灰显并给出规则号与原因。
              </p>
            </RuleNote>
            <!-- B14d：来源清单＝**算子图阵列 + 分组下拉**（原来是逐个来源的文字按钮） -->
            <CounterPicker
              title="补给来源（点一枚即选定）"
              hint="12.3a 直接拖取 / 12.3b 指挥部投递 / 12.6a 基础源 / 12.7 延补队 / 12.6c 吃图上补给"
              :items="sourceItems"
              :size="40"
              @pick="workbench.chooseSupplySourceNow(Number($event))"
              @hover="hoverSource"
            />
          </template>

          <!-- ── ⑤ 拖取 / 投递选择（12.3） ── -->
          <template v-if="workbench.supplyState?.step === 'pickup'">
            <p class="num">
              已选来源：{{
                summary.chosenSource === null
                  ? '—'
                  : workbench.supplySourceLabel(summary.chosenSource)
              }}
            </p>
            <!-- B14d：付款补给站＝**算子图阵列**（原来是"（自动）"打头的纯文字下拉；点同一座即回到自动） -->
            <CounterPicker
              v-if="workbench.supplyPayDumpCandidates.length > 0"
              title="付款补给站（12.3b：HQ 先按 12.3a 从它拖取再前送）"
              hint="12.3b-A：投递只能送即用补给；点同一座站即回到「自动」（候选第一座）"
              :items="payDumpItems"
              :size="32"
              @pick="workbench.toggleSupplyPayDump($event)"
              @hover="hoverDump"
            />
            <div class="row">
              <label class="field">
                用途
                <select v-model="workbench.supplyInputs.purpose" class="select">
                  <option v-for="item in PURPOSES" :key="item.key" :value="item.key">
                    {{ item.label }}
                  </option>
                </select>
              </label>
              <!--
                ★ 批 B 切片 2（裁定⑤「获取即付款」）：**T 数由用途的费率算**，只有"数量即内容"的
                  用途（12.10 补充部队储备 / 13.8 建造）才给手填框 —— 12.4/12.5 的费率是死的，
                  自由填 T 数等于允许少付（修前扣 1T 也能把一辆坦克"加油"）。
              -->
              <label v-if="pickupRequirement !== null && pickupRequirement.manual" class="field">
                拖取/投递 T 数
                <UiField
                  v-model="workbench.supplyInputs.amountT"
                  class="input num"
                  type="number"
                  min="1"
                  stepper
                />
              </label>
              <p v-else-if="pickupRequirement !== null" class="num">
                应付 <b>{{ pickupRequirement.t }} T</b>
                <BaseTag kind="neutral">{{ pickupRequirement.rule }}</BaseTag>
                {{ pickupRequirement.detail }}
              </p>
            </div>
            <!-- 12.3b-A（裁定②：不允许预取）：拖取/投递必须当场用于某个用途 ⇒ 立即使用是**恒真项** -->
            <p class="muted num">
              12.3b-A：投递只能送**需要立即使用**的补给（本作把"立即使用"做成结构性恒真，不再给可取消的勾选）
            </p>
            <div class="row">
              <BaseButton variant="primary" size="sm" @click="workbench.confirmSupplyPickupNow()">
                结算拖取/投递（12.3）
              </BaseButton>
            </div>
          </template>

          <!-- ── ⑥ 断补处置（12.6c 吃图上补给 / 12.6d 接受断补） ── -->
          <template v-if="workbench.supplyState?.step === 'resolveOos'">
            <p class="muted">
              无追溯补给（12.6a）：可选择吃图上补给（12.6c：每 1T 覆盖最多 2RE，小数向上取整）
              或接受断补标记（12.6d：随后按 12.8 掷损耗骰）。12.6c 明言**永不强迫**吃图上补给。
            </p>
            <div class="row">
              <label class="field">
                <input
                  v-model="workbench.supplyInputs.oosAction"
                  type="radio"
                  value="eatOffTheMap"
                />
                吃图上补给（12.6c，需 {{ summary.eatingCostT }} T）
              </label>
              <label class="field">
                <input
                  v-model="workbench.supplyInputs.oosAction"
                  type="radio"
                  value="acceptOutOfSupply"
                />
                接受断补（12.6d）
              </label>
            </div>
            <p v-if="workbench.supplyOosPayDump !== null" class="muted num">
              付款补给站：{{ hexLabel(workbench.supplyOosPayDump.hex) }}（{{
                workbench.supplyOosPayDump.sp
              }}
              SP + {{ workbench.supplyOosPayDump.t }} T）
            </p>
            <div class="row">
              <BaseButton variant="primary" size="sm" @click="workbench.confirmOosResolutionNow()">
                确认断补处置（12.6c/d）
              </BaseButton>
            </div>
          </template>

          <!-- ── 结果摘要 ── -->
          <p v-if="summary.pickup !== null" class="ok">
            <BaseTag kind="success">{{ summary.pickup.rule }}</BaseTag>
            {{ summary.pickup.detail }}
          </p>
          <p v-if="summary.oos !== null" class="num">
            <BaseTag :kind="summary.oos.markedOutOfSupply ? 'warning' : 'success'">
              {{ summary.oos.rule }}
            </BaseTag>
            {{ summary.oos.detail }}
          </p>
        </template>

        <p v-if="workbench.supplyError !== null" class="warn">
          <BaseTag kind="danger">{{ workbench.supplyError.rule }}</BaseTag>
          {{ workbench.supplyError.reason }}
        </p>

        <div class="row">
          <BaseButton variant="secondary" size="sm" @click="workbench.cancelSupply()">
            放弃本次补给检查
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

.field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-muted);
}

.input {
  width: 78px;
  padding: 3px var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.select {
  padding: 3px var(--space-2);
  font-size: var(--text-xs);
}

.num {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
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
</style>
