<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'

import { BaseButton, BasePanel, BaseTag, RuleNote } from '@/components/base'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
import { auxCardImageUrl } from '@/components/game/aux-card-image'
import { counterImages } from '@/render/token-images'
import { ooaScanOf } from '@/render/charts-view'
import { counterImageUrlOf, hexLabel } from '@/stores'
import { useWorkbenchStore } from '@/stores'

/**
 * 增援面板（W6 B18：OCS 13.5 / 13.6 / 13.9 / 20.0 + Smolensk 专规 1.6 / 2.1 / 2.3b / 2.4）
 *
 * 覆盖用户要求的五件事，全部走引擎判定（本组件**不做任何规则计算**）：
 *   · **到达表执行**（13.6 / 13.6b / 1.6a）：按当日到达卡列出投放需求与落点，逐条投放/强制执行移除；
 *   · **可变增援**（13.6b 补给表与补员表 / 1.6c 特殊补员 / 3.3c 可变撤离 / 3.6 随机事件）；
 *   · **特殊补员**（1.6c）：免费重建内容由引擎给出；
 *   · **重建与拆分合并**（13.5 / 20.0 / 13.9）：补员账本、死亡堆重建、拆分单位池、合并；
 *   · **NKVD 强制担任行动值单位**（专规 2.3b）：战斗面板侧的裁定在本面板只做提示。
 *
 * 分层纪律（CODE_SPEC）：落点、费用、可用性、合法性全部来自 store 对引擎的调用；
 * 这里只画表、收点击、把输入写回 store。 */

const workbench = useWorkbenchStore()

/**
 * B34 余项②：**本方的到达卡（OOA）**
 *
 * 用户口径 2026-09-16 #4：「OOA 卡的窗口都做了，把图加进去吧」——
 * 增援窗显示**对应方**的那一张（到达卡按方成对印；13.6 / 专规 1.6a）。
 * 取图走 `ooaScanOf`（唯一入口）+ `auxCardImageUrl`（唯一 URL 规则），本组件不拼路径、不挑文件名。
 */
const ooaCard = computed(() => ooaScanOf(workbench.activeSide))
const ooaImageUrl = computed(() =>
  ooaCard.value === null ? null : auxCardImageUrl(ooaCard.value.image),
)
const ooaReady = computed(
  () => ooaImageUrl.value !== null && counterImages.get(ooaImageUrl.value) !== null,
)
// 卡面按需加载：窗开着才拉图（与 BoxCard 的 preload 同一套）
watchEffect(() => {
  if (ooaImageUrl.value !== null) void counterImages.preload([ooaImageUrl.value])
})

/** 重建表行键（裁判按重建表选定；工程库未落「算子 → 行」映射） */
const rebuildType = ref('Infantry Div step')
const rebuildUnitId = ref('')
const rebuildHexText = ref('')

/** 合并 / 拆分 / 锁定的表单输入 */
const keepId = ref('')
const removeId = ref('')
const breakdownParentId = ref('')
/** 创建拆分单位（20.0a）用：单位库里的**记录 id**（引擎按它取算子数值） */
const breakdownRecordId = ref('')
/**
 * 吸收拆分单位（20.0d）用：图上那**枚拆分单位算子的实例 id**
 *
 * 两个口径不能共用：创建要的是**库里的哪一种算子**、
 * 吸收要的是**图上哪一枚算子**。原先两者绑同一个下拉 ⇒ 吸收永远查不到目标而静默失败。
 */
const breakdownAbsorbId = ref('')

/*
 * B34：四处"指认单位"的阵列（拆分母单位 / 慢动员锁定 / 合并保留 / 合并移除）
 *
 * 候选＝**图上本方单位**（`workbench.ownUnitsOnMap` 是数据投影）；
 * 传入选中的那枚即给它金框 —— 与其余面板的 `CounterPicker` 手感一致。
 * 合法条件不在本处判（20.0a 的时机、13.9 的两面一致…由引擎在提交时给规则号）。
 * 名字里带印值：13.9 要求"两面完全相同"，玩家得能一眼比对。
 */
const rebuildUnitItems = computed(
  () =>
    (selectedId: string): readonly CounterPickerItem[] =>
      workbench.ownUnitsOnMap.map((unit) => ({
        id: unit.instanceId,
        imageUrl: counterImageUrlOf(unit),
        name:
          `${unit.name} @ ${hexLabel(unit.hex)}（A ${unit.raw.attack}｜AR ${unit.raw.ar}` +
          `｜MA ${unit.raw.ma}｜${unit.re}RE）`,
        selected: selectedId === unit.instanceId,
        hex: unit.hex,
      })),
)

/** 13.5：**可保存**的补员类别（判据取引擎的 `isSavableRepl`，不在此写死） */
const savableReplKeys = ['ftr', 'tac', 'pax', 'eq'].filter((key) =>
  workbench.isSavableRepl(key as 'ftr' | 'tac' | 'pax' | 'eq'),
)

/**
 * 批 F 切片 3：**到货 SP 落位**（专规 2.1 / 3.1 免费铁运 + 3.6 补给列车）的界面态
 *
 * 判据全在引擎与 store：这里只把"哪些格能勾、勾了哪些、余额放哪"画出来并把选择写回。
 * 本组件的输入是**格号文本**（`<select>` 的 value 即 `列.行`），写回时解析成 `HexRef`。
 */
const freeRailPickedKeys = computed(
  () => new Set(workbench.freeRailPicked.map((item) => hexLabel(item))),
)
/** 余额落点（未显式指定时＝store 的缺省：本剧本本方第一处图边源） */
const freeRailEdgeValue = computed(() => {
  const chosen = workbench.freeRailEdgeHex ?? workbench.scenarioSupplySourceHexes[0] ?? null
  return chosen === null ? '' : hexLabel(chosen)
})
const supplyTrainValue = computed(() =>
  workbench.supplyTrainHex === null ? '' : hexLabel(workbench.supplyTrainHex),
)
function parseHexText(text: string): { col: number; row: number } | null {
  const match = /^(\d{1,2})\.(\d{1,2})$/.exec(text.trim())
  return match === null ? null : { col: Number(match[1]), row: Number(match[2]) }
}
function onFreeRailEdgeChange(text: string): void {
  workbench.pickFreeRailEdgeHex(parseHexText(text))
}
function onSupplyTrainChange(text: string): void {
  workbench.pickSupplyTrainHex(parseHexText(text))
}

/**
 * 到达卡条目 → **单位库里的哪一枚算子**（B21：投放这一步自带选型）
 *
 * ★ 为什么必须有它：13.6 的条目是**卡面文字**（番号 / 母体 / 印值），而本作工程库**未落**
 *   「到达卡条目 → 算子记录」的映射，故 13.6 的投放由玩家（裁判）指认用哪一枚算子。
 *   修前这个指认要去「摆算子」工具的单位清单里选 —— 而**正式界面已删掉摆算子**
 *   （用户口径：一律由流程驱动）⇒ 指认入口必须长在**投放这一行**上，否则投放永远找不到算子。
 *   缺省留空＝交给 store 按显示名精确匹配（`placeArrivalNow` 的第二参数缺省时的口径）。
 */
const arrivalRecordIds = ref<Record<number, string>>({})

function arrivalRecordIdOf(index: number): string {
  return arrivalRecordIds.value[index] ?? ''
}

function onArrivalRecordPick(index: number, id: string): void {
  arrivalRecordIds.value = { ...arrivalRecordIds.value, [index]: id }
}

/** 投放某一条到达需求（带了选型就按选型，否则按显示名自动匹配） */
function onPlaceArrival(index: number): void {
  const picked = arrivalRecordIdOf(index)
  workbench.placeArrivalNow(index, picked === '' ? undefined : picked)
}

/** 图上的拆分单位（20.0d 的吸收对象只能是**已在图上**的那些） */
const breakdownUnitsOnMap = computed(() =>
  workbench.units.filter((unit) => unit.specialized.includes('breakdown')),
)

/** 悬停某一枚待重建单位 ⇒ 同步地图高亮它所在的格（用户口径：悬停同步高亮地图格） */
function onHoverRebuild(id: string | null): void {
  const unit = id === null ? null : (workbench.units.find((item) => item.instanceId === id) ?? null)
  workbench.setHoverHex(unit?.hex ?? null)
}

/** 悬停阵列里的一枚 ⇒ 同步地图高亮它所在的格（与其余面板同一手感） */
function hoverUnit(id: string | null): void {
  const unit = id === null ? null : (workbench.units.find((item) => item.instanceId === id) ?? null)
  workbench.setHoverHex(unit?.hex ?? null)
}

/** 到达计划（当日到达卡） */
const plan = computed(() => workbench.arrivalPlan)
const placements = computed(() => workbench.arrivalPlacements)
/** 补员账本（13.5） */
const holdings = computed(() => workbench.replHoldings)

/**
 * **待重建单位**的算子图阵列（B13；用户口径⑪「把当前可选的算子图片紧凑排出来」）
 *
 * 三个字段都由 store 给：图走 `counterImageUrlOf`（与地图**同一条**选图实现）、
 * 能否重建看是否在死亡堆（13.5b）与是否空军（13.5 地面重建不适用）——**本组件不自己判**，
 * 只在 `disabledReason` 里如实转述一句人话（点它就地一行灰提示）。
 */
const rebuildItems = computed<readonly CounterPickerItem[]>(() =>
  workbench.rebuildCandidates.map((unit) => {
    const isAir = 'aircraftId' in unit
    const inDeadPile = workbench.deadPile.some((item) => item.instanceId === unit.instanceId)
    /*
     * 空军已接线（第五批批 C 切片 3）：飞机走 Ftr / Tac 补员重建（专规 1.6，13.5f），
     * 与地面同列于此；不再有"空军不走地面重建"的灰显。
     */
    const reason = null
    return {
      id: unit.instanceId,
      imageUrl: counterImageUrlOf(unit),
      name: `${unit.name}（军力 ${unit.steps}｜${inDeadPile ? '死亡堆' : '图上带损'}${isAir ? '｜空军：Ftr/Tac 补员重建' : ''}）`,
      selected: rebuildUnitId.value === unit.instanceId,
      disabledReason: reason,
      // 图上不叠文字；角标只给"军力"，因为它是重建时唯一要看的数字
      badge: String(unit.steps),
      hex: 'hex' in unit ? unit.hex : null,
    }
  }),
)

/**
 * B17a-1：**只渲染哪一段**（默认全渲染，引擎验证页照旧）
 *
 * 与 B15d/B15e 的分段同一套做法，理由也一样（方案 §10①「右侧栏只读」）：
 * 本面板里混着两类东西——
 *   · **只读信息**（`info`）：当日到达卡的条目与落点、1.6a 移除清单、2.1a 关闭、
 *     可变增援/补员/重建/合并的**结果摘要**、补员账本当前值、死亡堆计数、3.3c 窗口、
 *     方面军预备队当日批次、NKVD 提示、错误条 —— 这些是"随时想看一眼"的东西，留右栏；
 *   · **动作**（`actions`）：执行强制移除、逐条投放（含手改落点）、掷可变增援、清零不可保存、
 *     重建、创建/吸收拆分单位、合并、缓慢动员锁定、领取方面军预备队、补员账本订正 ——
 *     这些是"一次行动的收束"，按方案 §4.3 进**会话框**（由"当前环节是增援段某一步"触发）。
 */
const props = withDefaults(defineProps<{ only?: 'info' | 'actions' | 'rebuild' | null }>(), {
  only: null,
})

/** 本实例是否要画"只读信息"那一段 */
const showsInfo = computed(() => props.only === null || props.only === 'info')
/**
 * 本实例是否要画"动作"那一段
 *
 * ★ B34：**重建与拆分合并已从这一段移到 `rebuild` 段**（用户口径 #13：
 *   增援段按子环节分成「可下增援单位」与「重建与整编」两个窗口，
 *   后者是 13.5 / 20.0 / 13.9 的动作）。
 */
const showsActions = computed(() => props.only === null || props.only === 'actions')
/** 本实例是否要画"重建与整编"那一段（B34：增援段的第二个窗口） */
const showsRebuild = computed(() => props.only === null || props.only === 'rebuild')
</script>

<template>
  <BasePanel title="增援与编制（W6 B18：13.5 / 13.6 / 13.9 / 20.0）">
    <p v-if="showsInfo && workbench.phase !== 'reinforcement'" class="muted">
      到达投放、重建与合并都在 **B 增援**（13.5a / 13.9）；请先把阶段切到「B 增援」。
      拆分单位的创建在 C/E/G 段或战后结算（20.0a）。
    </p>

    <!-- ── · 到达表执行（13.6 / 13.6b / 1.6a） ── -->
    <p class="muted">
      到达表执行（13.6）：当日到达卡 → 投放需求与落点（入口被阻挡时按 13.6b
      改投最近的未被阻挡边缘格）； 条目「Removed」按 1.6a 立即移出。
    </p>
    <!-- B34②：本方到达卡（OOA）原卡面（13.6 / 专规 1.6a；点图在新标签打开原尺寸） -->
    <figure v-if="showsActions && ooaCard !== null" class="ooa">
      <a v-if="ooaReady" :href="ooaImageUrl ?? undefined" target="_blank" rel="noreferrer">
        <img class="ooa__img" :src="ooaImageUrl ?? ''" :alt="ooaCard.title" />
      </a>
      <span v-else class="ooa__img ooa__img--pending">正在读图…</span>
      <figcaption class="muted">
        {{ ooaCard.title
        }}<template v-if="ooaCard.note !== undefined">｜{{ ooaCard.note }}</template>
      </figcaption>
    </figure>
    <div class="row">
      <!-- ★ 联调：剧本号唯一权威在会话 store，选择入口只留「初设与开局」一处（用户口径） -->
      <BaseTag kind="info">剧本 {{ workbench.scenarioId }}</BaseTag>
      <BaseTag kind="info">{{ workbench.date }}（第 {{ workbench.turn }} 回合）</BaseTag>
      <span class="num">
        投放需求 {{ plan?.units.length ?? 0 }} 条｜强制移除 {{ plan?.removals.length ?? 0 }} 条
      </span>
      <BaseButton
        v-if="showsActions"
        variant="secondary"
        size="sm"
        @click="workbench.applyArrivalRemovalsNow()"
      >
        执行强制移除（1.6a）
      </BaseButton>
    </div>

    <p v-if="plan !== null && plan.shutdowns.length > 0" class="warn">
      <BaseTag kind="danger">2.1a</BaseTag>
      当日生效的补给源关闭：{{ plan.shutdowns.join('、') }}
    </p>

    <p v-for="(unit, index) in plan?.units ?? []" :key="`${index}-${unit.raw}`" class="num">
      <BaseTag :kind="unit.kind === 'aircraft' ? 'warning' : 'neutral'">{{ unit.kind }}</BaseTag>
      {{ unit.raw }}
      <template v-if="unit.designation !== null">｜番号 {{ unit.designation }}</template>
      <template v-if="unit.parentType !== null">｜母体 {{ unit.parentType }}</template>
      <template v-if="unit.factors !== null">｜印值 {{ unit.factors }}</template>
      <template v-if="unit.count > 1">｜×{{ unit.count }}</template>
      <template v-if="unit.stepsLost > 0">｜到场带损 {{ unit.stepsLost }} step</template>
      <template v-if="unit.loadedWithSp">｜满载 SP（13.6c）</template>
      ｜落点：{{ unit.label }} →
      <template v-if="placements[index]?.hex !== null && placements[index]?.hex !== undefined">
        {{ hexLabel(placements[index]!.hex!) }}（{{ placements[index]!.rule }}）
      </template>
      <template v-else>
        <BaseTag kind="danger">{{ placements[index]?.status }}</BaseTag>
        {{ placements[index]?.detail }}
      </template>
      <template v-if="showsActions">
        <input
          v-model="rebuildHexText"
          class="input"
          placeholder="手改落点 列.行"
          @change="workbench.setArrivalHexOverride(index, rebuildHexText)"
        />
        <!-- B27：落点改成**点地图**（13.6 的入场格由裁判按卡面判定；文本框留着作退路） -->
        <BaseButton variant="secondary" size="sm" @click="workbench.beginArrivalHexPickNow(index)">
          点地图选落点
        </BaseButton>
        <!-- B21：库中型号在这一行选（13.6 的条目是卡面文字，工程库未落"条目 → 算子"映射） -->
        <select
          class="select"
          :value="arrivalRecordIdOf(index)"
          @change="onArrivalRecordPick(index, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">（库中型号：按显示名自动匹配）</option>
          <option v-for="item in workbench.choices" :key="item.id" :value="item.id">
            {{ item.nameZh ?? item.nameEn ?? item.id }}
          </option>
        </select>
        <BaseButton variant="primary" size="sm" @click="onPlaceArrival(index)">
          投放（13.6）
        </BaseButton>
      </template>
    </p>
    <p v-if="(plan?.units.length ?? 0) === 0" class="muted">当日到达卡没有条目。</p>

    <!-- ── · 可变增援（13.6b / 1.6c / 3.3c / 3.6） ── -->
    <hr />
    <RuleNote
      title="可变增援：每个己方增援阶段掷补给表与补员表（19 Aug 前掷一次，之后掷两次）"
      rule="13.6b"
    >
      <p class="muted">
        可变增援（13.6b）：每个己方增援阶段掷补给表（得 SP）与补员表（得 Ftr/Tac/Pax/Eq）； 19 Aug
        起补员表 −1 且取 Late 档；1.6c 特殊补员 19 Aug 前每回合掷； 轴方另掷 3.3c 可变撤离（19 Aug
        起）、3.6 随机事件（19 Jul、25 Aug）。
      </p>
    </RuleNote>
    <div v-if="showsActions" class="row">
      <!--
        B28（用户口径 #9「所有的随机数抽取一律自动结算」）：骰面与"是否自动掷"的勾选都撤掉 ——
        一律走种子化 RNG（`rng` 默认 `autoRoll: true`），骰面在结果行与结算日志里可复算。
        留在这里的只有**选择类**的输入（如可选规则的启用）。
      -->
      <label class="field">
        <input v-model="workbench.variableReplInputs.option4_1b" type="checkbox" />
        启用可选 4.1b（8 Jul / 12 Jul 自动 Supply Train）
      </label>
      <BaseButton variant="primary" size="sm" @click="workbench.rollVariableReplNow()">
        掷可变增援（1.6b）
      </BaseButton>
      <BaseButton variant="ghost" size="sm" @click="workbench.clearNonSavableReplNow()">
        清零不可保存的补员（13.5）
      </BaseButton>
    </div>
    <p v-if="showsActions" class="muted num">
      骰面自动（补给表 2d6 / 补员表 2d6 / 特殊补员 1d6 / 可变撤离 1d6 / 随机事件 2d6），
      结果随本次结算一并落日志。
    </p>
    <!-- 3.3c：可变撤离的窗口与了结状态（轴方 19 Aug 起；掷出 1 或 6 即结束） -->
    <p class="num">
      3.3c 可变撤离：窗口
      <BaseTag :kind="workbench.variableExitOpen ? 'danger' : 'neutral'">
        {{ workbench.variableExitOpen ? '已开（19 Aug 起）' : '未开' }}
      </BaseTag>
      ｜判定
      <BaseTag :kind="workbench.variableExitResolved ? 'success' : 'info'">
        {{ workbench.variableExitResolved ? '已了结（不再掷）' : '未了结（2 选 1，须下回合再掷）' }}
      </BaseTag>
    </p>
    <p v-if="workbench.lastVariableRepl !== null" class="num">
      <BaseTag kind="success">{{ workbench.lastVariableRepl.rule }}</BaseTag>
      {{ workbench.lastVariableRepl.detail }}
    </p>
    <p class="num">13.5 可保存的补员：{{ savableReplKeys.join(' / ') }}（其余在增援阶段末清零）</p>

    <!-- ── · 到货 SP 落位（专规 2.1 / 3.1 免费铁运 + 3.6 补给列车） ── -->
    <hr />
    <RuleNote
      title="到货 SP 落位：可卸载城市格每格 1 SP（免费铁运），其余放图边补给源格"
      rule="专规 2.1 / 3.1"
    >
      <p class="muted">
        补给表到货（1.6b）的 SP 可用**免费铁运**落到每个**可卸载城市格**（13.3c：城格有铁路 +
        受本方控制 + 免敌方 ZOC 的铁路路径回补给源），**每格 1 SP**、**不扣铁路运量**（13.3b
        的运量只在移动阶段用）； 其余 SP 放本方的**图边补给源格**。3.6 随机事件掷出 Supply Train（2
        骰 5–9）时，另在**任一可卸货格** 得 2 SP，同样不用 Rail Cap。
      </p>
    </RuleNote>
    <div v-if="showsActions" class="row">
      <label class="field">
        到货 SP（掷补给表后自动填，可手改）
        <input v-model.number="workbench.supplyArrivalSp" type="number" min="0" step="1" />
      </label>
      <BaseTag kind="neutral">铁路运量消耗 0（免费）</BaseTag>
    </div>
    <p class="muted num">
      可卸载城市格（静态）{{ workbench.freeRailCityHexes.length }} 处｜此刻候选（13.3c 运行期：受控
      + 铁路路径通回补给源）{{ workbench.freeRailCityCandidates.length }} 处
    </p>
    <div v-if="workbench.freeRailCityCandidates.length > 0" class="row">
      <BaseButton
        v-for="item in workbench.freeRailCityCandidates"
        :key="`${item.hex.col}.${item.hex.row}`"
        :variant="freeRailPickedKeys.has(hexLabel(item.hex)) ? 'primary' : 'secondary'"
        size="sm"
        @click="workbench.toggleFreeRailPick(item.hex)"
      >
        {{ hexLabel(item.hex) }} {{ item.name }}
      </BaseButton>
    </div>
    <p v-else class="muted">
      此刻没有候选（城里要受本方控制、且铁路路径通回补给源）—— 按原文，SP 就全部落图边补给源格。
    </p>
    <div v-if="showsActions" class="row">
      <label class="field">
        其余 SP 的落点（图边补给源格）
        <select
          :value="freeRailEdgeValue"
          @change="onFreeRailEdgeChange(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="item in workbench.scenarioSupplySourceHexes"
            :key="`${item.col}.${item.row}`"
            :value="hexLabel(item)"
          >
            {{ hexLabel(item) }}
          </option>
        </select>
      </label>
      <label v-if="workbench.supplyTrainSp > 0" class="field">
        3.6 补给列车 {{ workbench.supplyTrainSp }} SP 落点（任一可卸货格）
        <select
          :value="supplyTrainValue"
          @change="onSupplyTrainChange(($event.target as HTMLSelectElement).value)"
        >
          <option value="">（未选）</option>
          <option
            v-for="item in workbench.detrainableHexes"
            :key="`${item.col}.${item.row}`"
            :value="hexLabel(item)"
          >
            {{ hexLabel(item) }}
          </option>
        </select>
      </label>
      <BaseButton variant="primary" size="sm" @click="workbench.applySupplyArrivalsNow()">
        落账（专规 2.1）
      </BaseButton>
    </div>
    <p v-if="workbench.freeRailPlan !== null" class="num">
      <BaseTag kind="info">{{ workbench.freeRailPlan.rule }}</BaseTag>
      {{ workbench.freeRailPlan.detail }}
    </p>
    <p v-if="workbench.freeRailError !== null" class="warn">
      落点被拒：{{ workbench.freeRailError.reason }}（{{ workbench.freeRailError.rule }}）
    </p>
    <p v-if="workbench.lastFreeRailPlan !== null" class="ok">
      <BaseTag kind="success">已落账</BaseTag> {{ workbench.lastFreeRailPlan.detail }}
    </p>

    <!-- ── · 补员账本（13.5） ── -->
    <hr />
    <p class="muted">
      补员账本（13.5）：Pax / Eq 可跨回合保存；Ftr / Tac 只补 1 step 且**不可保存**（专规 1.6
      Notes）。
    </p>
    <div class="row">
      <template v-if="showsActions">
        <label class="field">
          Pax
          <input
            v-model.number="workbench.replHoldings.pax"
            class="input num"
            type="number"
            min="0"
          />
        </label>
        <label class="field">
          Eq
          <input
            v-model.number="workbench.replHoldings.eq"
            class="input num"
            type="number"
            min="0"
          />
        </label>
        <label class="field">
          Ftr
          <input
            v-model.number="workbench.replHoldings.ftr"
            class="input num"
            type="number"
            min="0"
          />
        </label>
        <label class="field">
          Tac
          <input
            v-model.number="workbench.replHoldings.tac"
            class="input num"
            type="number"
            min="0"
          />
        </label>
      </template>
      <span class="num">
        当前：Pax {{ holdings.pax }} / Eq {{ holdings.eq }} / Ftr {{ holdings.ftr }} / Tac
        {{ holdings.tac }}
      </span>
    </div>

    <!-- ── · 重建（13.5） ── -->
    <hr />
    <p v-if="showsRebuild" class="muted">
      重建（13.5）：补员须都在**一个格**中、且在一个**战斗模式的友方 HQ 的 2 格内**（该格不得在敌方
      ZOC 内）；重建图上有损的单位还须与补员**同格**。重建行键取自重建表（本作工程库未落「算子 →
      行」映射，由裁判选定）。
    </p>
    <div v-if="showsRebuild" class="row">
      <!-- B13：待重建单位＝**算子图阵列**（原来是一个纯文字下拉） -->
      <CounterPicker
        title="待重建单位"
        hint="13.5 重建：死亡堆里的单位，或图上带损且与补员同格者"
        :items="rebuildItems"
        :size="32"
        @pick="rebuildUnitId = $event"
        @hover="onHoverRebuild"
      />
    </div>
    <div v-if="showsRebuild" class="row">
      <label class="field">
        重建表行键
        <input v-model="rebuildType" class="input" placeholder="Infantry Div step" />
      </label>
      <label class="field">
        补员所在格
        <input v-model="workbench.rebuildReplHexText" class="input" placeholder="36.13" />
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="rebuildUnitId === ''"
          @click="workbench.beginRebuildReplHexPickNow(rebuildUnitId)"
        >
          点地图选格
        </BaseButton>
      </label>
      <BaseButton
        variant="primary"
        size="sm"
        @click="
          workbench.rebuildUnitNow({
            unitId: rebuildUnitId,
            rebuildType,
            replHexText: workbench.rebuildReplHexText,
          })
        "
      >
        重建（13.5）
      </BaseButton>
    </div>
    <p v-if="workbench.lastRebuild !== null" class="ok">
      <BaseTag kind="success">{{ workbench.lastRebuild.rule }}</BaseTag>
      {{ workbench.lastRebuild.detail }}
    </p>
    <p class="num">
      死亡堆 {{ workbench.deadPile.length }} 个｜永久移除 {{ workbench.removedForever.length }} 个
    </p>

    <!-- ── · 拆分与合并（20.0 / 13.9） ── -->
    <hr />
    <RuleNote
      title="拆分：只有「其他」类型多军力单位可创建/吸收，时机＝开始移动 / 战后推进 / 战后撤退"
      rule="20.0"
    >
      <p v-if="showsRebuild" class="muted">
        拆分（20.0）：只有**「其他」类型**的多军力单位可创建/吸收；创建时机为**开始移动 / 战后推进 /
        战后撤退**（20.0a）；**创建 AR ≤ 自己、吸收 AR ≥ 自己**（20.0b，两个方向相反，勿写成同向）；
        标记与模式须与拆分单位一致（20.0c）；装甲/机械化一律不可；最后一点军力不可创建。
        合并（13.9）：只在增援阶段；两面完全相同、非 DG、非部队储备低下。
      </p>
    </RuleNote>
    <div v-if="showsRebuild" class="row">
      <label class="field">
        国籍池存量
        <input
          class="input num"
          type="number"
          min="0"
          :value="workbench.breakdownPool['ax'] ?? 0"
          @change="
            workbench.setBreakdownPoolNow('ax', Number(($event.target as HTMLInputElement).value))
          "
        />
      </label>
      <CounterPicker
        title="母单位（图上本方单位，点一枚即选中）"
        hint="20.0：只有「其他」类型的多军力单位可创建/吸收拆分单位；合法性由引擎在提交时判"
        :items="rebuildUnitItems(breakdownParentId)"
        :size="32"
        @pick="breakdownParentId = $event"
        @hover="hoverUnit"
      />
      <label class="field">
        创建用：库中型号
        <select v-model="breakdownRecordId" class="select">
          <option :value="''">（选择型号）</option>
          <option v-for="item in workbench.choices" :key="item.id" :value="item.id">
            {{ item.nameZh ?? item.nameEn ?? item.id }}
          </option>
        </select>
      </label>
      <label class="field">
        吸收用：图上算子
        <select v-model="breakdownAbsorbId" class="select">
          <option :value="''">
            {{ breakdownUnitsOnMap.length === 0 ? '（图上暂无拆分单位）' : '（选择算子）' }}
          </option>
          <option
            v-for="unit in breakdownUnitsOnMap"
            :key="unit.instanceId"
            :value="unit.instanceId"
          >
            {{ unit.name }} @ {{ hexLabel(unit.hex) }}
          </option>
        </select>
      </label>
      <BaseButton
        variant="secondary"
        size="sm"
        @click="workbench.createBreakdownNow(breakdownParentId, breakdownRecordId)"
      >
        创建拆分单位（20.0a）
      </BaseButton>
      <BaseButton
        variant="secondary"
        size="sm"
        @click="workbench.absorbBreakdownNow(breakdownParentId, breakdownAbsorbId)"
      >
        吸收拆分单位（20.0d）
      </BaseButton>
    </div>
    <div v-if="showsRebuild" class="row">
      <CounterPicker
        title="合并：保留哪一枚"
        hint="13.9：两面完全相同、非 DG、非部队储备低下 —— 由引擎判"
        :items="rebuildUnitItems(keepId)"
        :size="32"
        @pick="keepId = $event"
        @hover="hoverUnit"
      />
      <CounterPicker
        title="合并：移除哪一枚"
        hint="13.9-1 地面 / 13.9-4 飞机（用同一份阵列选，引擎按类型判）"
        :items="rebuildUnitItems(removeId)"
        :size="32"
        @pick="removeId = $event"
        @hover="hoverUnit"
      />
      <BaseButton
        variant="primary"
        size="sm"
        @click="workbench.consolidateUnitsNow(keepId, removeId)"
      >
        合并地面单位（13.9-1）
      </BaseButton>
      <BaseButton
        variant="secondary"
        size="sm"
        @click="workbench.consolidateAircraftNow(keepId, removeId)"
      >
        合并飞机（13.9-4）
      </BaseButton>
    </div>
    <p v-if="workbench.lastBreakdown !== null" class="ok">
      <BaseTag kind="success">{{ workbench.lastBreakdown.rule }}</BaseTag>
      {{ workbench.lastBreakdown.detail }}
    </p>
    <p v-if="workbench.lastConsolidation !== null" class="ok">
      <BaseTag kind="success">{{ workbench.lastConsolidation.rule }}</BaseTag>
      {{ workbench.lastConsolidation.detail }}
    </p>

    <!-- ── · 慢动员（专规 2.4） ── -->
    <hr />
    <p class="muted">
      慢动员（专规 2.4）：被锁的师**不能移动、不能拆 breakdown**；按表 12-2
      逐日解锁（玩家在锁定师中自选）。
    </p>
    <div v-if="showsActions" class="row">
      <CounterPicker
        title="锁定哪一枚（专规 2.4 慢动员）"
        hint="被锁的师不能移动、不能拆 breakdown；按表 12-2 逐日解锁"
        :items="rebuildUnitItems(breakdownParentId)"
        :size="32"
        @pick="breakdownParentId = $event"
        @hover="hoverUnit"
      />
      <BaseButton
        variant="secondary"
        size="sm"
        @click="workbench.setUnitLockedNow(breakdownParentId, true)"
      >
        锁定（2.4）
      </BaseButton>
      <BaseButton
        variant="ghost"
        size="sm"
        @click="workbench.setUnitLockedNow(breakdownParentId, false)"
      >
        解除锁定
      </BaseButton>
      <BaseButton variant="ghost" size="sm" @click="workbench.unlockSlowMobilizationNow('30th', 2)">
        按表解锁（10th 等）
      </BaseButton>
    </div>

    <!-- ── ⑥b 方面军预备队（专规 2.3c） ── -->
    <hr />
    <RuleNote
      title="方面军预备队：三个时点各一批（2 SP + 编制转化 + 两次免费重建），必须当即领取"
      rule="专规 2.3c"
    >
      <p class="muted">
        方面军预备队（专规 2.3c）：**三个时点**（12 Jul / 1 Aug / 1 Sep ——
        **印刷日程**）各到一批，每批 **2 SP、一次编制转化**（旧单位按 1.6a
        **移出游戏**、新单位随当日到达摆放）与**两次免费重建** （一支 IL.2 或一支 HQ
        或火炮单位，玩家择一，从**死亡堆**里挑）；**必须当即领取、不能保存**。
        归位口径＝「轨上第一个 ≥ 卡面日期的回合」（轨上第 8 回合＝1941-08-01、第 17
        回合＝1941-09-01，与卡面一致）。
      </p>
    </RuleNote>
    <p v-if="workbench.frontalReservesToday === null" class="muted">
      本回合（{{ workbench.date }}）没有方面军预备队到货。
    </p>
    <template v-else>
      <p class="warn">
        <BaseTag kind="danger">专规 2.3c</BaseTag>
        本回合到货：**{{ workbench.frontalReservesToday.date }}** 批次 ——
        {{ workbench.frontalReservesToday.sp }} SP 与编制转化（{{
          workbench.frontalReservesToday.convertFrom
        }}
        → {{ workbench.frontalReservesToday.convertTo }}）＋ 免费重建
        {{ workbench.frontalReservesToday.freeRebuilds.join('、') }}
        <template
          v-if="workbench.frontalReservesClaimed.includes(workbench.frontalReservesToday.date)"
        >
          ✓ **已领取**
        </template>
      </p>
      <div v-if="showsActions" class="row">
        <label class="field">
          落点格（列.行；2 SP 与新单位都落这里）
          <input
            v-model="workbench.frontalReservesInputs.hexText"
            class="input"
            placeholder="60.34"
          />
          <BaseButton
            variant="secondary"
            size="sm"
            @click="workbench.beginFrontalReservesHexPickNow()"
          >
            点地图选落点
          </BaseButton>
        </label>
        <BaseButton
          variant="primary"
          size="sm"
          :disabled="workbench.frontalReservesClaimed.includes(workbench.frontalReservesToday.date)"
          @click="workbench.claimFrontalReservesNow()"
        >
          领取方面军预备队（2.3c）
        </BaseButton>
      </div>
      <p v-if="workbench.lastFrontalReserves !== null" class="ok">
        <BaseTag kind="success">2.3c</BaseTag>
        {{ workbench.lastFrontalReserves.detail }}
      </p>
      <template v-if="workbench.lastFrontalReserves !== null">
        <p class="muted num">
          已落盘：{{ workbench.lastFrontalReserves.applied.join('、') || '（无）' }}
        </p>
        <p v-if="workbench.lastFrontalReserves.obligations.length > 0" class="warn">
          须手工处理（产物单位库缺相应算子，卡面原文如上）：
          {{ workbench.lastFrontalReserves.obligations.join('、') }}
        </p>
        <p
          v-for="item in workbench.lastFrontalReserves.freeRebuildCandidates"
          :key="item.label"
          class="num"
        >
          免费重建「{{ item.label }}」的死亡堆候选：{{
            item.candidates.join('、') || '（死亡堆内暂无）'
          }}
        </p>
      </template>
      <p v-if="workbench.frontalReservesError !== null" class="warn">
        <BaseTag kind="danger">{{ workbench.frontalReservesError.rule }}</BaseTag>
        {{ workbench.frontalReservesError.reason }}
      </p>
    </template>

    <!-- ── · NKVD 提示（专规 2.3b） ── -->
    <p v-if="workbench.combatNkvdDefenders.length > 0" class="warn">
      <BaseTag kind="danger">专规 2.3b</BaseTag>
      守方堆叠内有 NKVD 边防团（{{
        workbench.combatNkvdDefenders.map((u) => u.name).join('、')
      }}）： 该堆叠的**行动值单位必须**由 NKVD
      担任，且守方**全部选项都须吃成军力损失**（含本可因攻方撤退而抵消的选项）； 9.10c
      的「忽略选项」权利不适用。
    </p>

    <p v-if="workbench.reinforcementError !== null" class="warn">
      <BaseTag kind="danger">{{ workbench.reinforcementError.rule }}</BaseTag>
      {{ workbench.reinforcementError.reason }}
    </p>
  </BasePanel>
</template>

<style scoped>
/* B34②：到达卡（OOA）卡面 —— 窗口窄，故限高并允许在新标签看原尺寸 */
.ooa {
  margin: 0 0 var(--space-2);
}

.ooa__img {
  display: block;
  max-width: 100%;
  max-height: 46vh;
  object-fit: contain;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
}

.ooa__img--pending {
  display: grid;
  place-items: center;
  min-height: 96px;
  color: var(--color-muted);
  font-size: var(--text-xs);
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
  max-width: 220px;
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
