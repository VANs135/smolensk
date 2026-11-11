<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'

import { BaseButton, BasePanel, BaseTag, RuleNote, RuleTip } from '@/components/base'
import { SessionStep } from '@/components/session'
import UiField from '@/components/UiField.vue'
import { useRefereeTools } from '@/components/ui-mode'
import { CounterPicker, type CounterPickerItem } from '@/components/game'
import { auxCardImageUrl } from '@/components/game/aux-card-image'
import { arrivalCopiesOf, rebuildChartRows } from '@/engine/rules'
import { counterImages, tokenImageUrl } from '@/render/token-images'
import { ooaScanOf } from '@/render/charts-view'
import { counterImageUrlOf, hexLabel } from '@/stores'
import { useContainersStore, useWorkbenchStore } from '@/stores'

/**
 * 增援面板（W6 B18：OCS 13.5 / 13.6 / 13.9 / 20.0 + Smolensk 专规 1.6 / 2.1 / 2.3b / 2.4）
 *
 * 覆盖用户要求的五件事，全部走引擎判定（本组件**不做任何规则计算**）：
 *   · **到达表执行**（13.6 / 13.6b / 1.6a）：按当日到达卡列出投放需求与落点，逐条投放/强制执行移除；
 *   · **可变增援**（13.6b 补给表与补员表 / 1.6c 特殊补员 / 3.3c 可变撤离 / 3.6 随机事件）；
 *   · **特殊补员**（1.6c）：免费重建内容由引擎给出；
 *   · **重建与整编合并**（13.5 / 13.9）：补员账本、死亡堆重建、合并（拆分/吸收 20.0 走右键单位面板）；
 *   · **NKVD 强制担任行动值单位**（专规 2.3b）：战斗面板侧的裁定在本面板只做提示。
 *
 * 分层纪律（CODE_SPEC）：落点、费用、可用性、合法性全部来自 store 对引擎的调用；
 * 这里只画表、收点击、把输入写回 store。 */

const workbench = useWorkbenchStore()
const containers = useContainersStore()
const specialReplRefusal = computed(() => containers.specialReplRefusal(workbench.activeSide))

/**
 * 条 24 / §5-F：正式界面把「手输」收敛为只读（验证页仍可手输）
 * ★ 2026-10-25：与 §21 的"裁判工具"合并成**同一道门** `showsReferee`
 *   （原来这里单独判 `uiMode === 'verify'`，同一个面板里两套判据容易漂）。
 */
const showsReferee = useRefereeTools()

/**
 * 专规 2.4：慢动员选择面板的**界面暂存**
 *
 * 用户 2026-11-05 裁定的交互＝每回合由玩家在"仍锁定"的师中自选，
 * 可挑数＝当回合配额；勾选/取消都只在本地，点"提交"才写入账本（提交后清空，可再开新一批）。
 */
const slowMobilizationArmy = ref<'30th' | '28th' | '24th'>('30th')
const slowMobilizationPick = ref<string[]>([])

/** 该集团军仍锁定、且按"与指挥部同一到达卡分组"纳入本专规的师 */
const slowMobilizationCandidates = computed(() =>
  workbench.slowMobilizationLockedOf(slowMobilizationArmy.value),
)

/**
 * 2.4：手动「锁定哪一枚」阵列 —— **侧 + 编制双重过滤**
 *
 * 慢动员是苏联专规，只对到达卡标注 `30/28/24 Army HQ (see 2.4)` 的苏军集团军生效。
 * 修前这里直接用 `rebuildUnitItems`（＝图上**本方全部**算子），于是轴方增援阶段会列出德军
 * （用户 2026-11-07 ②）。这里只留**苏方且带 30/28/24 归属**的算子。
 */
const slowMobilizationUnitItems = computed(
  () =>
    (selectedId: string): readonly CounterPickerItem[] =>
      workbench.ownUnitsOnMap
        .filter((unit) => unit.side === 'soviet' && unit.slowMobilizationArmy !== null)
        .map((unit) => ({
          id: unit.instanceId,
          imageUrl: counterImageUrlOf(unit),
          name: `${unit.name} @ ${hexLabel(unit.hex)}（${String(unit.slowMobilizationArmy)} 集团军）`,
          selected: selectedId === unit.instanceId,
          hex: unit.hex,
        })),
)

/** 当日可挑选数（引擎按表 2-2 算；界面只显示与置灰） */
const slowMobilizationQuota = computed(() =>
  workbench.slowMobilizationQuotaOf(slowMobilizationArmy.value),
)

const slowMobilizationLimitReached = computed(
  () => slowMobilizationPick.value.length >= slowMobilizationQuota.value,
)

function toggleSlowMobilizationPick(instanceId: string): void {
  const index = slowMobilizationPick.value.indexOf(instanceId)
  if (index >= 0) {
    slowMobilizationPick.value.splice(index, 1)
    return
  }
  if (slowMobilizationPick.value.length >= slowMobilizationQuota.value) return
  slowMobilizationPick.value.push(instanceId)
}

function submitSlowMobilizationPick(): void {
  if (slowMobilizationPick.value.length === 0) return
  if (workbench.unlockSlowMobilizationBatch(slowMobilizationPick.value))
    slowMobilizationPick.value = []
}

/** 换集团军即清空未提交的勾选（避免把 A 军的勾选提交到 B 军） */
watch(slowMobilizationArmy, () => {
  slowMobilizationPick.value = []
})

/** 该集团军已解锁的师＋解锁履历（履历来自已存档会话日志；未开局演练为空） */
const slowMobilizationUnlocked = computed(() =>
  workbench.units
    .filter((unit) => unit.slowMobilizationArmy === slowMobilizationArmy.value && !unit.locked)
    .map((unit) => ({
      instanceId: unit.instanceId,
      name: unit.name,
      at: workbench.slowMobilizationUnlockedAt(unit.instanceId),
    })),
)

/**
 * §5-B：重建表行键**从数据取**（`charts-supply-repl.json` 按当前方）——不再自由手输，
 * 保证只能选到合法行键。「算子 → 行」由 store 按类型自动映射（`rebuildSuggestedRow`）。
 */
const rebuildRowChoices = computed(() => rebuildChartRows(workbench.activeSide))

/**
 * 13.5：**自动映射行键**（按该算子自身类型推出；推不出唯一行时为 null）
 *
 * 判据与搬运都在 store（`rebuildSuggestedRow` ← 引擎 `suggestRebuildRow`）；选中算子即写行，
 * 面板只显示结果。2026-11-11 用户口径：不再让玩家手点「采用建议」。
 */
const rebuildSuggestion = computed<string | null>(() => workbench.rebuildSuggestedRow)

/**
 * 建议行的费用摘要（取自同一份重建表，界面不自算）
 *
 * ★ 2026-10-30：表里 `…Div **step** — 2x Pax` 这类行键的价是**每点军力**的价，
 * 多军力单位重建 N 个军力就付 N 份（13.5a「费用因单位类型和**规模**而异」＋13.5b）。
 * 界面若只写 "2x Pax" 会让玩家以为总共 2 Pax ⇒ 这里把计价单位一并说清。
 */
const rebuildSuggestionLabel = computed<string | null>(() => {
  const suggestion = rebuildSuggestion.value
  if (suggestion === null) return null
  const row = rebuildRowChoices.value.find((item) => item.unitType === suggestion)
  if (row === undefined) return null
  const perStep = /step/i.test(row.unitType)
  return perStep ? `${row.sourceLabel}／每点军力` : row.sourceLabel
})

/** 13.5c：该候选**不可重建**（数据层 `rebuildable === false`：AR 后有黄点，永久移除） */
const rebuildCandidateBlocked = computed<boolean>(() => {
  const unit = workbench.rebuildCandidates.find((item) => item.instanceId === rebuildUnitId.value)
  if (unit === undefined) return false
  // 空军条目没有该字段（飞机只经 Ftr/Tac 补员重建，13.5f）⇒ 不算被 13.5c 挡
  return 'rebuildable' in unit && unit.rebuildable === false
})

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

/**
 * 重建表行键（裁判按重建表选定；工程库未落「算子 → 行」映射）
 *
 * ★ 空串＝**未选行**，且「重建」按钮在未选行时禁用。修前默认 `'Infantry Div step'`：
 *   重建一辆坦克营却不动下拉，就会按那一行的「2x Pax」扣款 —— **静默扣错费用**。
 *   宁可让按钮禁用，也不替裁判猜行（13.5：重建费用完全由行决定）。
 */
const rebuildType = computed<string>({
  get: () => workbench.rebuildPickRow,
  set: (value) => {
    workbench.rebuildPickRow = value
  },
})
const rebuildUnitId = computed<string>({
  get: () => workbench.rebuildPickUnitId,
  set: (value) => {
    // 选中即按算子类型自动映射行键；唯一行才写，推不出唯一行留空交人工选
    workbench.selectRebuildUnitNow(value)
  },
})

/** 合并 / 锁定 / 补员的表单输入 */
const keepId = ref('')
const removeId = ref('')
const breakdownParentId = ref('')

/**
 * 13.9 整编会话：**保留哪一枚**的候选
 *
 * 右键从某一堆叠打开时，store 已把作用域收在该格（`consolidationPick`）⇒ 这里只列该堆叠；
 * 未经右键（会话自己开着）时沿用图上本方单位。判据与过滤都在 store，本组件只搬运。
 */
const mergeKeepItems = computed(
  () =>
    (selectedId: string): readonly CounterPickerItem[] =>
      workbench.consolidationKeepUnits.map((unit) => ({
        id: unit.instanceId,
        imageUrl: counterImageUrlOf(unit),
        name:
          `${unit.name} @ ${hexLabel(unit.hex)}（A ${unit.raw.attack}｜AR ${unit.raw.ar}` +
          `｜MA ${unit.raw.ma}｜${unit.re}RE）`,
        selected: selectedId === unit.instanceId,
        hex: unit.hex,
      })),
)

/** 13.9 整编会话：**移除哪一枚**的候选＝该保留枚同格、预演通过的伙伴（不跨格） */
function mergeRemoveItems(selectedId: string): readonly CounterPickerItem[] {
  return workbench.mergeRemoveUnits(keepId.value).map((unit) => ({
    id: unit.instanceId,
    imageUrl: counterImageUrlOf(unit),
    name:
      `${unit.name} @ ${hexLabel(unit.hex)}（A ${unit.raw.attack}｜AR ${unit.raw.ar}` +
      `｜MA ${unit.raw.ma}｜${unit.re}RE）`,
    selected: selectedId === unit.instanceId,
    hex: unit.hex,
  }))
}

/** 右键带入整编会话 ⇒ 预选保留枚、清掉上一轮的移除选择（不替玩家挑移除对象） */
watch(
  () => workbench.consolidationPick,
  (pick) => {
    if (pick === null) return
    keepId.value = pick.keepId
    removeId.value = ''
  },
  // 会话被右键"打开"时可能整块重挂载（此前被收起）⇒ 挂载即读一次作用域
  { immediate: true },
)

/** 会话收起 ⇒ 作用域作废（下次重新右键再带入，不拿旧堆叠预选） */
onBeforeUnmount(() => workbench.clearConsolidationPick())

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

/** 3.4b：到货 SP 的逐格归属（空值 ⇒ 未选） */
function onArrivalSpGroupChange(text: string, value: string): void {
  workbench.setArrivalSpGroup(text, value === 'guderian' || value === 'hoth' ? value : null)
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

/**
 * 13.6 / §5-A：到货行**出图**——只有「按显示名自动匹配」成功时才给那一枚的图（不臆造映射）。
 * 自动匹配的判据与 `placeArrivalNow` 同源（`workbench.arrivalRecordOf`）。
 */
function arrivalImageUrl(index: number): string | null {
  const record = workbench.arrivalRecordOf(index)
  if (record !== null) {
    return tokenImageUrl({
      side: workbench.activeSide,
      face: 'combat',
      images: record.images ?? null,
    })
  }
  // §5-A：编成条目没有"单枚记录"可配 ⇒ 取**第一枚部件**的图作行首缩略图（不臆造整条映射）
  const first = workbench.resolveArrivalFormation(index)?.records[0]
  if (first === undefined) return null
  return tokenImageUrl({ side: workbench.activeSide, face: 'combat', images: first.images ?? null })
}

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

/* ── 2026-11-09：手牌式到达投放（只列本回合算子图标；点算子 → 点图落位；再点已放可回手） ── */

/** 手牌里被选中的那一枚（地图高亮期间保持描边） */
const activeArrivalIndex = ref<number | null>(null)
/** 投放/撤回被拒时的一句话原因（不弹长文） */
const handError = ref('')

interface ArrivalHandCard {
  index: number
  raw: string
  image: string | null
  copies: number
  aircraft: boolean
  noCandidates: boolean
  detail: string
  formationMissing: number
}

function arrivalCardOf(index: number): ArrivalHandCard | null {
  const unit = plan.value?.units[index]
  if (unit === undefined) return null
  const candidates = workbench.arrivalCandidates[index]?.length ?? 0
  const formation = workbench.resolveArrivalFormation(index)
  return {
    index,
    raw: unit.raw,
    image: arrivalImageUrl(index),
    copies:
      unit.formationComponents.length > 0 ? unit.formationComponents.length : arrivalCopiesOf(unit),
    aircraft: unit.kind === 'aircraft',
    noCandidates: candidates === 0,
    detail: workbench.arrivalPlacements[index]?.detail ?? '本条目没有可用的入场格',
    formationMissing: formation?.missing.length ?? 0,
  }
}

/** 手牌＝本回合到场、尚未投放的**算子**（SP / 非算子条目走卡面记账，不在手牌里） */
const arrivalHandCards = computed<ArrivalHandCard[]>(() => {
  const units = plan.value?.units ?? []
  const cards: ArrivalHandCard[] = []
  units.forEach((unit, index) => {
    if (unit.kind === 'sp' || unit.kind === 'unclassified') return
    if (workbench.arrivalPlaced[index] === true) return
    const card = arrivalCardOf(index)
    if (card !== null) cards.push(card)
  })
  return cards
})

/** 已投放的算子（仍显示图标，点一下即撤回手牌） */
const arrivalPlacedCards = computed<ArrivalHandCard[]>(() => {
  const units = plan.value?.units ?? []
  const cards: ArrivalHandCard[] = []
  units.forEach((unit, index) => {
    if (unit.kind === 'sp' || unit.kind === 'unclassified') return
    if (workbench.arrivalPlaced[index] !== true) return
    const card = arrivalCardOf(index)
    if (card !== null) cards.push(card)
  })
  return cards
})

/** 卡面记账条目（不占手牌，但必须能看到/能处理） */
const arrivalManualEntries = computed(() =>
  (plan.value?.units ?? [])
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => unit.kind === 'sp' || unit.kind === 'unclassified'),
)

/** 到达（13.6）的拒绝统一在 `handError` 里用一句话显示，底部不再重复原始码 */
const genericReinforcementError = computed(() => workbench.genericReinforcementError)

/** 把 store 的拒绝码翻成一句人能看懂的话 */
function arrivalErrorText(reason: string): string {
  const code = reason.split(':')[0] ?? reason
  if (code === 'arrivalUnitNotResolved') return '单位库里找不到对应算子，请在「?」里指定型号后再点'
  if (code === 'arrivalHexOutsideCandidates') return '这一格不在该条目的入场格内'
  if (code === 'arrivalHexEnemyOccupied')
    return '这一格有敌方单位：增援可以进敌方 ZOC，但不能与敌方单位同格（13.6b）'
  if (code === 'arrivalAirBaseOverstack') return '该基地的激活飞机已达上限（4 + 基地等级，14.2a）'
  if (code === 'arrivalNoCandidateHex')
    return '这一条现在没有合法落点（候选为空），请先检查入场格/基地'
  if (code.startsWith('arrivalHex')) return '这一格现在不能落：换一处高亮格试试'
  if (code === 'arrivalWithdrawNoLedger') return '这一枚缺少投放记录，暂时不能回手'
  return '这一枚现在放不下，换一条或换一处入场格试试'
}

function pickArrival(index: number): void {
  handError.value = ''
  const card = arrivalCardOf(index)
  if (card === null) return
  if (card.noCandidates) {
    handError.value = card.detail
    return
  }
  activeArrivalIndex.value = index
  const picked = arrivalRecordIdOf(index)
  if (!workbench.beginArrivalPlacePickNow(index, picked === '' ? undefined : picked)) {
    activeArrivalIndex.value = null
    handError.value = card.detail
  }
}

function withdrawArrival(index: number): void {
  handError.value = ''
  if (!workbench.withdrawArrivalNow(index)) handError.value = '这一枚当前不能回手'
}

// 地图落点选择结束（投放成功或取消）⇒ 收掉手牌描边
watch(
  () => workbench.hexPickView,
  (view) => {
    if (view === null) activeArrivalIndex.value = null
  },
)
// 投放被拒 ⇒ 用一句话说明；成功投放则清掉上一条错误
watch(
  () => workbench.reinforcementError,
  (error) => {
    if (error !== null) handError.value = arrivalErrorText(error.reason)
  },
)
watch(
  () => workbench.arrivalPlaced,
  () => {
    handError.value = ''
  },
  { deep: true },
)
/** §5-D：待放置的补员点数（掷出后还没放到地图上） */
const replPendingTotal = computed(() => workbench.replPending.pax + workbench.replPending.eq)

/** 13.5：Pax / Eq 分开放置——候选与落点按族各走一条（一族摆完不影响另一族） */
const savableReplKinds = [
  { key: 'pax', label: 'Pax' },
  { key: 'eq', label: 'Eq' },
] as const

/**
 * 可变增援的**结果**（只写"拿到什么"）
 *
 * 骰面、公式、表名与条款号只在结算日志里（用户口径：过程不上屏），面板只列结果摘要。
 */
const variableReplResult = computed<readonly string[]>(() => {
  const plan = workbench.lastVariableRepl
  if (plan === null) return []
  const lines = [`补给 +${String(plan.sp)} SP`]
  const repl = [
    plan.repl.pax > 0 ? `Pax ${String(plan.repl.pax)}` : '',
    plan.repl.eq > 0 ? `Eq ${String(plan.repl.eq)}` : '',
    plan.repl.ftr > 0 ? `Ftr ${String(plan.repl.ftr)}` : '',
    plan.repl.tac > 0 ? `Tac ${String(plan.repl.tac)}` : '',
  ].filter((item) => item !== '')
  lines.push(repl.length === 0 ? '补员：无' : `补员：${repl.join(' / ')}`)
  const special = plan.special
  if (special !== null) {
    const grants: string[] = []
    if (special.supplyCache) grants.push('Supply Cache ×1')
    if (special.freeDivisionRebuild) grants.push('免费重建 1 个步兵/民兵师（−1 step）')
    if (special.freeAlarmOrRecon) grants.push('免费重建 1 个 Alarm / Aufk / Krd 单位')
    if (grants.length > 0) lines.push(`特殊补员：${grants.join(' + ')}`)
  }
  const event = plan.randomEvent
  if (event !== null) {
    lines.push(
      event.kind === 'supplyTrain'
        ? `随机事件：Supply Train ⇒ +${String(event.sp ?? 0)} SP（任一可卸货格，不用 Rail Cap）`
        : `随机事件：${event.aircraftType ?? '飞机'}全部变非激活`,
    )
  }
  return lines
})

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
     *
     * 13.5c：AR 后有黄点（数据层 `rebuildable === false`）者**永久不可重建**——
     * 用户 2026-10-24 裁定该字段可信（只有少数单位如此）。这里按惯例只**转述**一句人话：
     * 置灰 + 悬停/点击给原因，而不是让裁判点进去再吃一次引擎拒绝。
     */
    const reason =
      'rebuildable' in unit && unit.rebuildable === false
        ? '13.5c：AR 后有黄点（rebuildable: false）⇒ 永久不可重建'
        : null
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
  <BasePanel title="增援与编制（13.5 / 13.6 / 13.9 / 20.0）">
    <p v-if="showsInfo && workbench.phase !== 'reinforcement'" class="muted">
      到达投放、重建与合并都在 **B 增援**（13.5a / 13.9）；请先把阶段切到「B 增援」。
      拆分单位的创建在 C/E/G 段或战后结算（20.0a）。
    </p>

    <!--
      用户 2026-10-25：「每个阶段/环节只能出现该环节可用的 UI，不要什么都糅杂在一起」
      ⇒ 面板顶部先说清**现在这个环节该做什么**（人工/自动），下面只铺该环节的区块。
    -->
    <p v-if="workbench.phase === 'reinforcement'" class="num">
      <BaseTag :kind="workbench.segmentDriver === 'automatic' ? 'neutral' : 'info'">
        {{ workbench.segmentDriver === 'automatic' ? '自动结算' : '人工操作' }}
      </BaseTag>
      本环节：{{ workbench.segmentStep?.label ?? '—' }}（{{ workbench.segmentStep?.rule ?? '—' }}）
      <template v-if="workbench.segmentDriver === 'automatic'">
        —— 本环节由系统自动结算，结果见下方回执与日志；这里不铺动作按钮。
      </template>
      <template v-else>
        —— 只铺本环节要做的区块；其余子环节的区块已隐去（切到对应环节再出现）。
      </template>
    </p>

    <SessionStep
      v-if="showsActions"
      item="reinforce:randomEvent"
      ackable
      @ack="workbench.acknowledgeReinforcementStepNow('reinforce:randomEvent')"
    >
      <RuleNote title="3.6 随机事件：19 Jul–15 Aug，每个轴方增援阶段掷一次" rule="3.6">
        <p class="muted">
          通常为补给列车（2 SP，任一可卸货格、不用 Rail Cap）；偶尔整型飞机被调离图外。
          结果随可变增援一并落日志。
        </p>
      </RuleNote>
      <p v-if="workbench.lastVariableRepl?.randomEvent" class="num">
        <BaseTag kind="info">3.6</BaseTag>
        {{ workbench.lastVariableRepl.randomEvent.detail }}
      </p>
      <p v-else class="muted">本回合尚未掷出随机事件结果。</p>
    </SessionStep>

    <SessionStep
      v-if="showsActions"
      item="reinforce:specialRepl"
      ackable
      @ack="workbench.acknowledgeReinforcementStepNow('reinforce:specialRepl')"
    >
      <BaseButton
        variant="primary"
        size="sm"
        :disabled="specialReplRefusal !== null"
        @click="containers.drawSpecialRepl(workbench.activeSide)"
      >
        掷特殊补员表 · 1.6c
      </BaseButton>
      <p v-if="specialReplRefusal !== null" class="muted" role="status">{{ specialReplRefusal }}</p>
    </SessionStep>

    <SessionStep v-if="showsActions" item="reinforce:arrival">
      <!-- ── 手牌式到达投放（13.6）：只列本回合算子图标；点算子 → 点图落位；已放可点回手 ── -->
      <div class="arrival-hand" data-testid="arrival-hand">
        <button
          v-for="card in arrivalHandCards"
          :key="`hand-${card.index}`"
          type="button"
          class="arrival-hand__card"
          :class="{ 'arrival-hand__card--active': activeArrivalIndex === card.index }"
          :disabled="card.noCandidates"
          :title="
            card.noCandidates
              ? `${card.raw}：${card.detail}`
              : `${card.raw}：点一下 → 地图高亮入场格 → 点格落位`
          "
          data-testid="arrival-hand-card"
          @click="pickArrival(card.index)"
        >
          <img v-if="card.image !== null" :src="card.image" alt="" class="arrival-hand__img" />
          <span v-else class="arrival-hand__fallback" :title="card.raw">?</span>
          <span v-if="card.copies > 1" class="arrival-hand__badge">{{ card.copies }}</span>
          <span v-if="card.aircraft" class="arrival-hand__badge arrival-hand__badge--air">✈</span>
        </button>
        <button
          v-for="card in arrivalPlacedCards"
          :key="`placed-${card.index}`"
          type="button"
          class="arrival-hand__card arrival-hand__card--placed"
          :title="`${card.raw}：点一下回手（可撤销重放）`"
          data-testid="arrival-hand-placed"
          @click="withdrawArrival(card.index)"
        >
          <img v-if="card.image !== null" :src="card.image" alt="" class="arrival-hand__img" />
          <span v-else class="arrival-hand__fallback" :title="card.raw">?</span>
          <span class="arrival-hand__undo">↩</span>
        </button>
      </div>
      <p class="arrival-hand__meta num" data-testid="arrival-hand-meta">
        剩余 <strong>{{ arrivalHandCards.length }}</strong> 枚<template
          v-if="arrivalPlacedCards.length > 0"
        >
          · 已放 {{ arrivalPlacedCards.length }}</template
        >
      </p>
      <!-- 3.4b：非编队运输点带来的 SP 入场前必须选定集群 -->
      <div v-if="workbench.arrivalTransportSpNeedsGroup" class="row" data-testid="arrival-sp-group">
        <span class="num">运输点带来的 SP 归属（3.4b）：</span>
        <BaseButton
          :variant="workbench.transportSpGroupDraft === 'guderian' ? 'primary' : 'secondary'"
          size="sm"
          @click="workbench.setTransportSpGroupDraftNow('guderian')"
        >
          Guderian
        </BaseButton>
        <BaseButton
          :variant="workbench.transportSpGroupDraft === 'hoth' ? 'primary' : 'secondary'"
          size="sm"
          @click="workbench.setTransportSpGroupDraftNow('hoth')"
        >
          Hoth
        </BaseButton>
      </div>
      <p v-if="handError !== ''" class="warn" role="status" data-testid="arrival-hand-error">
        {{ handError }}
      </p>

      <p v-if="plan !== null && plan.shutdowns.length > 0" class="warn">
        <BaseTag kind="danger">2.1a</BaseTag>
        当日生效的补给源关闭：{{ plan.shutdowns.join('、') }}
      </p>
      <div v-if="(plan?.removals.length ?? 0) > 0" class="row">
        <span class="num">强制移除 {{ plan?.removals.length }} 条</span>
        <BaseButton variant="secondary" size="sm" @click="workbench.applyArrivalRemovalsNow()">
          执行
        </BaseButton>
      </div>

      <!-- 说明、条款、原卡面、库中型号、卡面记账：一律收进 ? -->
      <details class="arrival-hand__more" data-testid="arrival-hand-more">
        <summary title="到达卡原图、库中型号、卡面记账">?</summary>
        <figure v-if="ooaCard !== null" class="ooa">
          <a v-if="ooaReady" :href="ooaImageUrl ?? undefined" target="_blank" rel="noreferrer">
            <img class="ooa__img" :src="ooaImageUrl ?? ''" :alt="ooaCard.title" />
          </a>
          <span v-else class="ooa__img ooa__img--pending">正在读图…</span>
          <figcaption class="muted">
            {{ ooaCard.title
            }}<template v-if="ooaCard.note !== undefined">｜{{ ooaCard.note }}</template>
          </figcaption>
        </figure>
        <p v-for="item in arrivalManualEntries" :key="`manual-${item.index}`" class="num">
          <img
            v-if="arrivalImageUrl(item.index) !== null"
            :src="arrivalImageUrl(item.index) ?? undefined"
            alt=""
            class="arrival-thumb"
          />
          <BaseTag kind="neutral">{{ item.unit.kind }}</BaseTag>
          {{ item.unit.raw
          }}<template v-if="arrivalCopiesOf(item.unit) > 1"
            >｜{{ arrivalCopiesOf(item.unit) }} 枚</template
          >
          ｜按卡面记账
        </p>
        <p
          v-for="card in arrivalHandCards"
          v-show="card.formationMissing > 0"
          :key="`miss-${card.index}`"
          class="warn"
        >
          {{ card.raw }}：{{ card.formationMissing }} 枚未映射，请按卡面逐枚摆入
        </p>
        <div v-for="card in arrivalHandCards" :key="`pick-${card.index}`" class="row">
          <span class="num">{{ card.raw }}</span>
          <select
            class="select"
            :value="arrivalRecordIdOf(card.index)"
            @change="onArrivalRecordPick(card.index, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">（库中型号：按显示名自动匹配）</option>
            <option v-for="item in workbench.choices" :key="item.id" :value="item.id">
              {{ item.nameZh ?? item.nameEn ?? item.id }}
            </option>
          </select>
        </div>
      </details>
    </SessionStep>
    <SessionStep
      v-if="showsActions"
      item="reinforce:variableExit"
      ackable
      :ack-disabled="workbench.variableExitSelectionOpen"
      @ack="workbench.acknowledgeReinforcementStepNow('reinforce:variableExit')"
    >
      <RuleNote title="3.3c 可变撤离：19 Aug 起，每个轴方增援阶段掷一次" rule="3.3c">
        <p class="muted">
          1 / 6 分别撤走 SS Reich 或 14 Mtr，撤走即了结；2–5 本回合不撤，下回合再掷。 撤离走 1.6a
          程序：优先移除目标编队算子，否则用同印值算子顶替。
        </p>
      </RuleNote>
      <template v-if="workbench.variableExitForActiveSide">
        <p class="num">
          3.3c 可变撤离：窗口
          <BaseTag :kind="workbench.variableExitOpen ? 'danger' : 'neutral'">
            {{ workbench.variableExitOpen ? '已开（19 Aug 起）' : '未开' }}
          </BaseTag>
          ｜判定
          <BaseTag :kind="workbench.variableExitResolved ? 'success' : 'info'">
            {{
              workbench.variableExitResolved ? '已了结（不再掷）' : '未了结（2–5，须下回合再掷）'
            }}
          </BaseTag>
        </p>
        <!-- ⑦ 3.3c：目标编队盘面与死亡堆都无算子 ⇒ 玩家从同印值算子中挑一枚移出游戏（1.6a） -->
        <div v-if="workbench.variableExitSelectionOpen" class="row">
          <p class="num">
            3.3c 撤离：该编队已无算子在场 ⇒
            请在地图高亮格（蓝框）里选一枚同印值算子移出游戏（1.6a）。
            列表只列可选单位；堆叠中不可选者不出现。
          </p>
        </div>
        <div v-if="workbench.variableExitSelectionOpen" class="row">
          <CounterPicker
            title="3.3c 撤离替补（只列可选）"
            hint="1.6a：战斗面印值 attack/AR/MA 相同的算子才能顶替"
            :items="workbench.variableExitPickItems"
            :size="32"
            @pick="workbench.confirmVariableExitSubstitute"
            @hover="workbench.setVariableExitHover"
          />
        </div>
      </template>
    </SessionStep>
    <SessionStep
      v-if="showsActions"
      item="reinforce:replTable"
      ackable
      :ack-disabled="
        !workbench.variableReplRolled || workbench.replPending.pax + workbench.replPending.eq > 0
      "
      @ack="workbench.acknowledgeReinforcementStepNow('reinforce:replTable')"
    >
      <!-- ── · 可变增援（13.6b / 1.6c / 3.3c / 3.6） ── -->
      <hr />
      <RuleNote title="可变增援：每个己方增援阶段掷一次（19 Aug 起两次）" rule="13.6b">
        <p class="muted">
          可变增援（13.6b）：每个己方增援阶段掷补给表（得 SP）与补员表（得 Ftr/Tac/Pax/Eq）； 19 Aug
          起补员表 −1 且取 Late 档；1.6c 特殊补员 19 Aug 前每回合掷； 轴方另掷 3.3c 可变撤离（19 Aug
          起）、3.6 随机事件（19 Jul、25 Aug）。骰面与表名只在结算日志里，便于复算。
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
          启用可选 4.1b（8 / 12 / 15 Jul 三个回合自动 Supply Train）
        </label>
        <BaseButton variant="primary" size="sm" @click="workbench.rollVariableReplNow()">
          掷可变增援
        </BaseButton>
        <BaseButton variant="ghost" size="sm" @click="workbench.clearNonSavableReplNow()">
          清零不可保存的补员
        </BaseButton>
      </div>
      <!-- 只列「拿到什么」：骰面 / 表名 / 条款号不上屏 -->
      <ul v-if="variableReplResult.length > 0" class="num repl-result">
        <li v-for="line in variableReplResult" :key="line">{{ line }}</li>
      </ul>
      <template v-if="replPendingTotal > 0">
        <p class="num">
          <BaseTag kind="warning">待放置</BaseTag>
          Pax {{ workbench.replPending.pax }} / Eq {{ workbench.replPending.eq }}
        </p>
        <div v-if="showsActions" class="row">
          <BaseButton
            v-for="item in savableReplKinds"
            :key="item.key"
            variant="primary"
            size="sm"
            :disabled="
              workbench.replPending[item.key] === 0 ||
              workbench.replPlacementBlockedReasonFor(item.key) !== null
            "
            @click="workbench.beginReplPlaceHexPickNow(item.key)"
          >
            在地图上点格放置 {{ item.label }}（{{ workbench.replPending[item.key] }}）
          </BaseButton>
        </div>
        <template v-for="item in savableReplKinds" :key="`blocked:${item.key}`">
          <p v-if="workbench.replPlacementBlockedReasonFor(item.key) !== null" class="muted num">
            {{ workbench.replPlacementBlockedReasonFor(item.key) }}
          </p>
        </template>
      </template>
    </SessionStep>
    <!-- 3.6：补给列车 —— 不做列车算子；窗口一出现地图高亮全部可卸货铁路格，点一格落 2 SP -->
    <SessionStep
      v-if="showsActions"
      item="reinforce:supplyTrain"
      ackable
      @ack="workbench.acknowledgeReinforcementStepNow('reinforce:supplyTrain')"
    >
      <RuleNote title="补给列车：任一可卸货铁路格得 2 SP（不用 Rail Cap）" rule="专规 3.6">
        <p class="muted">
          随机事件掷出 Supply Train 时，在任一**可卸货（detrainable）铁路格**落 2 SP；地图已高亮
          全部可卸货格，**点其中一格即放置**。未掷出则本窗空过。
        </p>
      </RuleNote>
      <p v-if="!workbench.supplyTrainPending" class="muted">
        本回合没有待落的补给列车，点「本步完成」继续。
      </p>
      <template v-else>
        <p class="num">
          <BaseTag kind="info">补给列车 {{ workbench.supplyTrainSp }} SP</BaseTag>
        </p>
        <div v-if="workbench.panzerGroupRulesOn && workbench.activeSide === 'axis'" class="row">
          <span class="muted">3.4b 归属（未选不落）</span>
          <BaseButton
            :variant="workbench.supplyTrainGroup === 'guderian' ? 'primary' : 'secondary'"
            size="sm"
            @click="workbench.setSupplyTrainGroup('guderian')"
          >
            Guderian
          </BaseButton>
          <BaseButton
            :variant="workbench.supplyTrainGroup === 'hoth' ? 'primary' : 'secondary'"
            size="sm"
            @click="workbench.setSupplyTrainGroup('hoth')"
          >
            Hoth
          </BaseButton>
        </div>
        <div class="row">
          <BaseButton variant="primary" size="sm" @click="workbench.beginSupplyTrainHexPickNow()">
            点地图高亮铁路格放置 2 SP
          </BaseButton>
        </div>
      </template>
    </SessionStep>
    <SessionStep
      v-if="showsActions"
      item="reinforce:supplyTable"
      ackable
      :ack-disabled="workbench.supplyArrivalSp > 0"
      @ack="workbench.acknowledgeReinforcementStepNow('reinforce:supplyTable')"
    >
      <!-- ── · 到货 SP 落位（专规 2.1 / 3.1 免费铁运 + 3.6 补给列车） ── -->
      <hr />
      <RuleNote
        title="到货 SP 落位：可卸载城市格每格 1 SP（免费铁运），其余放图边补给源格"
        rule="专规 2.1 / 3.1"
      >
        <p class="muted">
          补给表到货（1.6b）的 SP 可用**免费铁运**落到每个**可卸载城市格**（13.3c：城格有铁路 +
          受本方控制 + 免敌方 ZOC 的铁路路径回补给源），**每格 1 SP**、**不扣铁路运量**（13.3b
          的运量只在移动阶段用）； 其余 SP 放本方的**图边补给源格**。3.6 的补给列车已有独立窗口。
        </p>
      </RuleNote>
      <div v-if="showsActions" class="row">
        <label class="field">
          到货 SP（掷补给表后自动填，可手改）
          <UiField v-model="workbench.supplyArrivalSp" type="number" min="0" step="1" />
        </label>
        <BaseTag kind="neutral">铁路运量消耗 0（免费）</BaseTag>
      </div>
      <p class="muted num">
        可卸载城市格（静态）{{ workbench.freeRailCityHexes.length }} 处｜此刻候选（13.3c
        运行期：受控 + 铁路路径通回补给源）{{ workbench.freeRailCityCandidates.length }} 处
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
        <span class="field">
          其余 SP 的落点：{{ freeRailEdgeValue }}（图边补给源格）
          <BaseButton
            variant="secondary"
            size="sm"
            @click="workbench.beginFreeRailEdgeHexPickNow()"
          >
            点地图选格
          </BaseButton>
        </span>
        <BaseButton
          v-if="workbench.supplyArrivalSp > 0"
          variant="primary"
          size="sm"
          @click="workbench.applySupplyArrivalsNow()"
        >
          落账（专规 2.1）
        </BaseButton>
      </div>
      <p v-if="workbench.freeRailPlan !== null" class="num">
        <BaseTag kind="info">{{ workbench.freeRailPlan.rule }}</BaseTag>
        {{ workbench.freeRailPlan.detail }}
      </p>
      <div
        v-if="
          showsActions &&
          workbench.panzerGroupRulesOn &&
          workbench.activeSide === 'axis' &&
          workbench.arrivalSpGroupTargets.length > 0
        "
        class="row"
      >
        <span class="muted num">3.4b 德军 SP 归属（未选不落账）</span>
        <label
          v-for="target in workbench.arrivalSpGroupTargets"
          :key="target.hexText"
          class="field"
        >
          {{ target.hexText }} {{ target.sp }} SP
          <span v-if="target.fixed" class="muted">
            跟随既有：{{ target.group === 'guderian' ? 'Guderian' : 'Hoth' }}
          </span>
          <BaseButton
            v-else
            :variant="target.group === 'guderian' ? 'primary' : 'secondary'"
            size="sm"
            @click="onArrivalSpGroupChange(target.hexText, 'guderian')"
          >
            Guderian
          </BaseButton>
          <BaseButton
            v-if="!target.fixed"
            :variant="target.group === 'hoth' ? 'primary' : 'secondary'"
            size="sm"
            @click="onArrivalSpGroupChange(target.hexText, 'hoth')"
          >
            Hoth
          </BaseButton>
        </label>
      </div>
      <p v-if="workbench.freeRailError !== null" class="warn">
        落点被拒：{{ workbench.freeRailError.reason }}（{{ workbench.freeRailError.rule }}）
      </p>
      <p v-if="workbench.lastFreeRailPlan !== null" class="ok">
        <BaseTag kind="success">已落账</BaseTag> {{ workbench.lastFreeRailPlan.detail }}
      </p>
    </SessionStep>
    <SessionStep
      v-if="showsRebuild"
      item="reinforce:rebuild"
      ackable
      @ack="workbench.acknowledgeReinforcementStepNow('reinforce:rebuild')"
    >
      <!-- ── · 重建（13.5） ── -->
      <hr />
      <p v-if="showsRebuild" class="muted">
        重建（13.5）：补员须都在**一个格**、且该格 2 格内有**战斗模式友方 HQ**（不得在敌 ZOC
        内）；重建有损单位还须与补员**同格**。行键取自重建表（库未落映射，由裁判选）。
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
        <span class="field">
          重建表行键（13.5：费用由行决定）
          <span class="row">
            <BaseButton
              v-for="row in rebuildRowChoices"
              :key="row.unitType"
              :variant="rebuildType === row.unitType ? 'primary' : 'secondary'"
              size="sm"
              @click="rebuildType = row.unitType"
            >
              {{ row.unitType }}（{{ row.sourceLabel }}）
            </BaseButton>
          </span>
        </span>
        <!--
        13.5：**行键已自动映射**——按该算子自身类型推出（store `rebuildSuggestedRow`，引擎唯一出处）。
        推不出唯一行时才留空由人工选；不再需要点「采用建议」。
      -->
        <span v-if="rebuildSuggestion !== null" class="muted">
          已按算子类型映射行：{{ rebuildSuggestion }}（{{ rebuildSuggestionLabel }}）
        </span>
        <span v-else-if="rebuildUnitId !== '' && !rebuildCandidateBlocked" class="muted">
          该算子的行键无法从类型唯一确定（重建表把同兵种拆成了多行）⇒ 请人工选行（13.5）。
        </span>
        <!-- 13.5c：AR 后有黄点（数据层 rebuildable=false）⇒ 永久不可重建，不必让裁判点一次被拒 -->
        <span v-if="rebuildCandidateBlocked" class="warn">
          <BaseTag kind="danger">13.5c</BaseTag>
          该单位 AR 后有黄点（`rebuildable: false`）⇒ **永久不可重建**，被摧毁即移除。
        </span>
        <span class="field">
          补员所在格：{{
            workbench.rebuildReplHexText === '' ? '（未选）' : workbench.rebuildReplHexText
          }}
          <BaseButton
            variant="secondary"
            size="sm"
            @click="workbench.beginRebuildReplHexPickNow(rebuildUnitId)"
          >
            点地图选格（高亮 13.5a 合法落点）
          </BaseButton>
        </span>
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
    </SessionStep>
    <!-- U1-b：拆分/合并（20.0 / 13.9）＝本环节的**选做事项**，排在强制义务之后 -->
    <SessionStep
      v-if="showsRebuild"
      item="reinforce:consolidation"
      ackable
      @ack="workbench.acknowledgeReinforcementStepNow('reinforce:consolidation')"
    >
      <!-- ── · 拆分与合并（20.0 / 13.9） ── -->
      <hr />
      <RuleNote title="合并（13.9）：只在增援阶段；拆分（20.0）走右键单位面板" rule="20.0">
        <p v-if="showsRebuild" class="muted">
          合并（13.9）：只在增援阶段；两面完全相同、非 DG、非部队储备低下。
          拆分/吸收（20.0）只在**右键单位 →「工程 → 拆分」**面板里做（20.0a/20.0d），
          本窗不再摆第二套。
        </p>
      </RuleNote>
      <div v-if="showsRebuild" class="row">
        <!--
          裁判工具：池存量来自数据（`breakdownPoolTotal`，20.0e 的国籍池），手改是订正。
          ★ 必须显式收：`UiField` 在正式界面把数字型渲染成 `－值＋` **步进**（仍可点），
            不像文本型那样自动只读。
        -->
        <label v-if="showsReferee" class="field">
          国籍池存量（裁判）
          <UiField
            class="input num"
            type="number"
            min="0"
            :model-value="workbench.breakdownPool['ax'] ?? 0"
            @update:model-value="workbench.setBreakdownPoolNow('ax', Number($event))"
          />
        </label>
      </div>
      <div v-if="showsRebuild" class="row">
        <CounterPicker
          title="合并：保留哪一枚"
          hint="13.9：两面完全相同、非 DG、非部队储备低下 —— 由引擎判"
          :items="mergeKeepItems(keepId)"
          :size="32"
          @pick="keepId = $event"
          @hover="hoverUnit"
        />
        <CounterPicker
          title="合并：移除哪一枚"
          hint="13.9-1 地面：只列同堆叠、两面相同的伙伴（引擎复核）"
          :items="mergeRemoveItems(removeId)"
          :size="32"
          @pick="removeId = $event"
          @hover="hoverUnit"
        />
        <BaseButton
          v-if="workbench.phase === 'reinforcement'"
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
    </SessionStep>
    <!-- ── · 慢动员（专规 2.4） ── -->
    <!-- 2.4 是苏联专规：仅**苏方增援阶段**渲染（轴方增援阶段不出现该 UI，用户 2026-11-07 ②） -->
    <SessionStep
      v-if="showsActions && workbench.slowMobilizationVisible"
      item="reinforce:slow"
      ackable
      @ack="workbench.acknowledgeReinforcementStepNow('reinforce:slow')"
    >
      <hr />
      <div class="muted">
        慢动员：
        <RuleTip rule="专规 2.4">
          被锁的师**不能移动、不能拆 breakdown**；按表 2-2 逐日解锁（玩家在锁定师中自选）。
        </RuleTip>
      </div>
      <div v-if="showsActions" class="row">
        <CounterPicker
          title="锁定哪一枚"
          hint="点一枚选择要解锁的师"
          :items="slowMobilizationUnitItems(breakdownParentId)"
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
      </div>
      <!-- 2.4 选择面板：每回合玩家在仍锁定的师中自选，勾选数 ≤ 当回合配额 -->
      <div class="row">
        <label class="muted">
          集团军
          <select v-model="slowMobilizationArmy">
            <option value="30th">30th</option>
            <option value="28th">28th</option>
            <option value="24th">24th</option>
          </select>
        </label>
        <BaseTag>当日可挑 {{ slowMobilizationQuota }}</BaseTag>
        <BaseTag>已勾 {{ slowMobilizationPick.length }}</BaseTag>
      </div>
      <div class="row">
        <label
          v-for="unit in slowMobilizationCandidates"
          :key="unit.instanceId"
          class="muted"
          :title="`${unit.name}（${slowMobilizationArmy} 集团军，仍锁定）`"
        >
          <input
            type="checkbox"
            :checked="slowMobilizationPick.includes(unit.instanceId)"
            :disabled="
              !slowMobilizationPick.includes(unit.instanceId) && slowMobilizationLimitReached
            "
            @change="toggleSlowMobilizationPick(unit.instanceId)"
          />
          {{ unit.name }}
        </label>
      </div>
      <p v-if="slowMobilizationCandidates.length === 0" class="muted">
        本回合没有可解锁的师（配额 0 或该集团军已全部解锁）。
      </p>
      <div class="row">
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="slowMobilizationPick.length === 0"
          @click="submitSlowMobilizationPick"
        >
          提交本回合解锁（2.4）
        </BaseButton>
      </div>
      <p v-if="slowMobilizationUnlocked.length > 0" class="muted">
        已解锁：<span v-for="item in slowMobilizationUnlocked" :key="item.instanceId">
          {{ item.name }}（{{
            item.at === null ? '履历未开局' : `${item.at.date} / 第 ${item.at.turn} 回合`
          }}）
        </span>
      </p>
    </SessionStep>

    <SessionStep
      v-if="showsActions && workbench.activeSide === 'soviet'"
      item="reinforce:frontalReserves"
    >
      <!-- ── ⑥b 方面军预备队（专规 2.3c） ── -->
      <hr />
      <RuleNote
        title="方面军预备队：三个时点各一批（2 SP + 编制转化 + 两次免费重建），必须当即领取"
        rule="专规 2.3c"
      >
        <p class="muted">
          方面军预备队（专规 2.3c）：**三个时点**（22 Jul / 1 Aug / 1 Sep ——
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
            <UiField
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
            :disabled="
              workbench.frontalReservesClaimed.includes(workbench.frontalReservesToday.date)
            "
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
    </SessionStep>
    <!-- ── · NKVD 提示（专规 2.3b） ── -->
    <p v-if="workbench.combatNkvdDefenders.length > 0" class="warn">
      <BaseTag kind="danger">专规 2.3b</BaseTag>
      守方堆叠内有 NKVD 边防团（{{
        workbench.combatNkvdDefenders.map((u) => u.name).join('、')
      }}）： 该堆叠的**行动值单位必须**由 NKVD
      担任，且守方**全部选项都须吃成军力损失**（含本可因攻方撤退而抵消的选项）； 9.10c
      的「忽略选项」权利不适用。
    </p>

    <p v-if="genericReinforcementError !== null" class="warn">
      <BaseTag kind="danger">{{ genericReinforcementError.rule }}</BaseTag>
      {{ genericReinforcementError.reason }}
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

/* 13.6 / §5-A：到货行出图（自动匹配成功才有） */
.arrival-thumb {
  width: 24px;
  height: 24px;
  object-fit: contain;
  vertical-align: middle;
  margin-right: 4px;
}

/* 2026-11-09：手牌式到达投放（只放算子图标，说明收进 ?） */
.arrival-hand {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: var(--space-1) 0;
}

.arrival-hand__card {
  position: relative;
  display: grid;
  place-items: center;
  width: 64px;
  height: 80px;
  padding: 2px;
  background: var(--color-panel);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.arrival-hand__card:hover:not(:disabled) {
  border-color: var(--color-accent);
}

.arrival-hand__card--active {
  border-color: var(--color-accent);
  background: var(--color-accent-2);
  box-shadow: 0 0 0 1px var(--color-accent) inset;
}

.arrival-hand__card--placed {
  opacity: 0.72;
}

.arrival-hand__card:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.arrival-hand__img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.arrival-hand__fallback {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  color: var(--color-muted);
  font-size: var(--text-lg);
}

.arrival-hand__badge {
  position: absolute;
  right: 2px;
  bottom: 2px;
  padding: 0 3px;
  background: var(--color-panel);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
  color: var(--color-muted);
  font-size: var(--text-xs);
  line-height: 1.2;
}

.arrival-hand__badge--air {
  top: 2px;
  bottom: auto;
}

.arrival-hand__undo {
  position: absolute;
  left: 2px;
  top: 2px;
  color: var(--color-accent);
  font-size: var(--text-sm);
}

.arrival-hand__meta {
  margin: var(--space-1) 0;
  color: var(--color-muted);
}

.arrival-hand__more {
  margin-top: var(--space-1);
}

.arrival-hand__more > summary {
  width: fit-content;
  cursor: pointer;
  color: var(--color-muted);
}
</style>
