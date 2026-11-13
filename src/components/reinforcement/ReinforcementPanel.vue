<script setup lang="ts">
import { computed, ref, watch, watchEffect } from 'vue'

import { BaseButton, BasePanel, BaseTag, RuleNote, RuleTip } from '@/components/base'
import { SessionStep } from '@/components/session'
import { type CounterPickerItem } from '@/components/game'
import { auxCardImageUrl } from '@/components/game/aux-card-image'
import { arrivalCopiesOf } from '@/engine/rules'
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
 * 专规 2.4：慢动员选择面板的**界面暂存**
 *
 * v7.1（2026-11-11）现行口径：累计解锁（`locked` 旗标跨回合保留）；玩家在"仍锁定"的
 * 师中自选，当日应解锁数 = min(当日剩余配额, 仍锁定数)，**未用满不得提交**。
 * 勾选/取消只在本地，点"提交"才写入账本（提交后清空，可再开下一批）。
 *
 * ★ 2026-11-05 旧裁定①⑨「不要管配额、按回合能动就行」已作废
 *   （作废原因与依据见 `engine/rules/arrival.ts → slowMobilizationQuotaRemaining`）。
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

/** 今日应解锁数 = min(当日剩余配额, 仍锁定师数)；配额大于剩余即"剩余全部解锁" */
const slowMobilizationRequired = computed(() =>
  workbench.slowMobilizationRequiredOf(slowMobilizationArmy.value),
)

/** 本段收束被拒时的一句话（2.4 未用满） */
const slowFinishError = ref('')

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
  slowFinishError.value = ''
  // 2.4：未用满不得提交（当日应解锁数由引擎给出）
  if (slowMobilizationPick.value.length !== slowMobilizationRequired.value) return
  if (!workbench.unlockSlowMobilizationBatch(slowMobilizationPick.value)) return
  slowMobilizationPick.value = []
  // 2.3 口径：当日已无未用满配额 ⇒ 提交即收束第一段
  if (!workbench.slowMobilizationOutstanding()) workbench.endSlowMobilizationSegmentNow()
}

/** 第一段·慢动员结束（当日仍有未用满配额时拒绝） */
function finishSlowSegment(): void {
  slowFinishError.value = ''
  if (!workbench.endSlowMobilizationSegmentNow()) {
    slowFinishError.value = '按表 2-2 还有未用满的当日配额：请先提交本回合解锁'
  }
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

/** 合并 / 锁定 / 补员的表单输入 */
const breakdownParentId = ref('')

/**
 * 1.6c + 1.6b 的**一次掷骰检定**（用户 2026-11-13：判定只留一个入口）
 *
 * 次序照原文：先 1.6c 特殊补员表，再 1.6b 可变增援/补给表。
 * 按钮只在「还没掷过」时出现：1.6b 已自动掷过且 1.6c 不可掷（19 Aug 起 / 本回合已掷）⇒ 不出现。
 */
const replCheckVisible = computed(
  () => !workbench.variableReplRolled || specialReplRefusal.value === null,
)

function runReplCheck(): void {
  if (specialReplRefusal.value === null) containers.drawSpecialRepl(workbench.activeSide)
  if (!workbench.variableReplRolled) workbench.rollVariableReplNow()
}

/** 1.6c 骰面只在**本回合本方已掷**时展示（`specialReplLast` 跨回合不残留） */
const specialReplLastThisTurn = computed(
  () =>
    containers.specialReplLast !== null &&
    containers.specialReplLast.side === workbench.activeSide &&
    workbench.hasSpecialReplDraw(workbench.activeSide, workbench.turn),
)

/** 1.6b 补给表进图外盒的 SP 数（T 记账 ÷ 4；只在本次检定后显示） */
const offMapDepositSp = computed(() => Math.trunc(workbench.offMapRollDeposit?.sp ?? 0))

/**
 * 批 F 切片 3：**到货 SP 落位**（专规 2.1 / 3.1 免费铁运 + 3.6 补给列车）
 *
 * 判据全在引擎与 store；本组件只把"哪些格能点、点了哪些、余额放哪"画出来并把选择写回。
 * v7.1 第二段起，落点统一在「待放上手牌」里点格给出（不再有块内表单）。
 */

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

/**
 * 第二段统一手牌的卡面图（照到达段范式：有图档就画算子，取不到回落短标）
 *
 * SP 在单位库里是按**当前点数**取图（与地图同一套补给算子图），其余来源的图由 store
 * 随条目给出（补员＝补员算子记录；返场／编制转化＝原算子的两面图）。
 */
function rollHandImage(entry: {
  id: string
  count: number
  images: { readonly front?: string | null; readonly back?: string | null } | null
}): string | null {
  if (entry.id === 'sp:arrival' || entry.id === 'sp:train') {
    return tokenImageUrl({
      side: workbench.activeSide,
      face: 'combat',
      noncombatKind: 'sp',
      spPoints: entry.count,
    })
  }
  return tokenImageUrl({ side: workbench.activeSide, face: 'combat', images: entry.images })
}

/** 本段已落位的**算子**（右键收回；SP 落点是账本，仍走下方那一行） */
interface PlacedRollCard {
  key: string
  raw: string
  short: string
  image: string | null
  withdraw: () => void
}

function placedRollImage(instanceId: string): string | null {
  const unit = workbench.units.find((item) => item.instanceId === instanceId)
  return unit === undefined ? null : counterImageUrlOf(unit)
}

const placedRollCards = computed<PlacedRollCard[]>(() => {
  const cards: PlacedRollCard[] = []
  for (const placed of workbench.replPlacedThisSegment) {
    const label = placed.kind === 'pax' ? 'Pax' : 'Eq'
    cards.push({
      key: `repl:${placed.instanceId}`,
      raw: label,
      short: label,
      image: placedRollImage(placed.instanceId),
      withdraw: () => {
        workbench.withdrawReplPlacementNow(placed.instanceId)
      },
    })
  }
  for (const placed of workbench.specialReplPlacedThisSegment) {
    cards.push({
      key: `special:${placed.instanceId}`,
      raw: placed.name,
      short: placed.name,
      image: placedRollImage(placed.instanceId),
      withdraw: () => {
        workbench.withdrawSpecialReplReturnNow(placed.instanceId)
      },
    })
  }
  const frontal = workbench.frontalUnitPlacedThisSegment
  if (frontal !== null) {
    cards.push({
      key: `frontal:${frontal.instanceId}`,
      raw: frontal.entry.name,
      short: frontal.entry.name,
      image: tokenImageUrl({
        side: workbench.activeSide,
        face: 'combat',
        images: frontal.entry.images,
      }),
      withdraw: () => {
        workbench.withdrawFrontalUnitNow()
      },
    })
  }
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
  if (code === 'arrivalRemovalsFirst') return '先执行 1.6a 强制移除，再放置到达算子'
  if (code === 'arrivalHandNotEmpty') return '手牌还没放完：要结束本段请先确认放弃上场'
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

/**
 * 13.6b / 裁定 3：增援铁路运输
 *
 * 只在该条目的解算入场格「含铁路」时出现（不可用项不出现）；点它 → 高亮 13.3c 可达卸货格 →
 * 点目的地进确认窗（确认才扣运力、落子；撤回不动运力）。
 */
function beginArrivalRail(index: number): void {
  handError.value = ''
  if (!workbench.beginArrivalRailPickNow(index)) {
    handError.value = '该增援不能走铁路运输：入场格不含铁路、没有可抵达的卸货格，或运力不足'
  }
}

/**
 * 第一段·结束本段（v7.1 §2.2）
 *
 * 到达块不再"放完自动关窗"；由本按钮收束整段。
 * 手牌非空 ⇒ 先问一次是否放弃上场（放弃＝未放上场的增援作废、不结转）。
 */
const arrivalFinishConfirm = ref(false)
const arrivalFinishError = ref('')

function finishArrivalSegment(): void {
  handError.value = ''
  arrivalFinishError.value = ''
  if (workbench.arrivalHandPending) {
    arrivalFinishConfirm.value = true
    return
  }
  if (!workbench.endArrivalSegmentNow(false)) {
    arrivalFinishError.value = workbench.arrivalRemovalsPending
      ? '先执行 1.6a 强制移除，再结束本段'
      : '当前不在到达段，无法结束本段'
  }
}

function confirmAbandonArrival(): void {
  handError.value = ''
  arrivalFinishError.value = ''
  if (workbench.endArrivalSegmentNow(true)) {
    arrivalFinishConfirm.value = false
    return
  }
  arrivalFinishError.value = workbench.arrivalRemovalsPending
    ? '先执行 1.6a 强制移除，再结束本段'
    : '当前不在到达段，无法结束本段'
}

/**
 * 第二段·结束本段（v7.1 §1.5 / §3.3）
 *
 * 与第一段同一口径：段内唯一出口；手牌非空先问一次是否放弃上场。
 * 拒绝原因来自 store（未掷骰 / 1.6c 未掷 / 撤离待选 / 方面军预备队未领）。
 */
const rollFinishConfirm = ref(false)
const rollFinishError = ref('')

function rollErrorText(): string {
  const reason = workbench.reinforcementError?.reason ?? ''
  if (reason === 'rollNotMade') return '先掷可变增援（1.6b），再结束第二段'
  if (reason === 'specialReplNotRolled') return '1.6c 特殊补员还没掷：这是每回合必掷的表'
  if (reason === 'variableExitSelectionPending') return '3.3c 撤离还有待选算子，先选定再结束'
  if (reason === 'frontalReservesPending') return '2.3c 方面军预备队必须当即领取'
  if (reason === 'rollHandNotEmpty') return '手牌还没放完：要结束本段请先确认放弃上场'
  return '当前不能结束第二段'
}

function finishRollSegment(): void {
  rollFinishError.value = ''
  if (workbench.rollHandPending) {
    rollFinishConfirm.value = true
    return
  }
  if (!workbench.endRollSegmentNow(false)) rollFinishError.value = rollErrorText()
}

function confirmAbandonRoll(): void {
  rollFinishError.value = ''
  if (workbench.endRollSegmentNow(true)) {
    rollFinishConfirm.value = false
    return
  }
  rollFinishError.value = rollErrorText()
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

/**
 * 统一手牌的**可见条目**
 *
 * 3.4b 尚未选德军归属的补给列车卡：不渲染、不置灰、不放原因文字；
 * 玩家在补给列车步骤选完 Guderian / Hoth 后自动出现。
 * 其余挡因（没有可落位格等）保持灰卡 + 标题原因。计数仍用 `rollHandEntries`，口径不变。
 */
const visibleRollHandEntries = computed(() =>
  workbench.rollHandEntries.filter((entry) => entry.blockedKind !== 'panzerGroup'),
)

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

    <SessionStep v-if="showsActions" item="reinforce:arrival">
      <!-- ── 1.6a：强制移除先于放置（原文次序）────────────────────────── -->
      <div v-if="(plan?.removals.length ?? 0) > 0" class="row" data-testid="arrival-removals">
        <span class="num">强制移除（1.6a，先执行）</span>
        <ul class="arrival-removals__list">
          <li v-for="(removal, at) in plan?.removals ?? []" :key="`rm-${at}`" class="num">
            {{ removal.raw }}
          </li>
        </ul>
        <BaseButton
          variant="secondary"
          size="sm"
          :disabled="!workbench.arrivalRemovalsPending"
          data-testid="arrival-removals-apply"
          @click="workbench.applyArrivalRemovalsNow()"
        >
          {{ workbench.arrivalRemovalsPending ? '执行移除' : '已执行' }}
        </BaseButton>
      </div>
      <p v-if="workbench.arrivalRemovalsPending" class="muted" data-testid="arrival-removals-first">
        先执行 1.6a 强制移除，再放置到达算子。
      </p>

      <!-- ── 手牌式到达投放（13.6）：只列本回合算子图标；点算子 → 点图落位；已放可点回手 ── -->
      <div class="arrival-hand" data-testid="arrival-hand">
        <button
          v-for="card in arrivalHandCards"
          :key="`hand-${card.index}`"
          type="button"
          class="arrival-hand__card"
          :class="{ 'arrival-hand__card--active': activeArrivalIndex === card.index }"
          :disabled="card.noCandidates || workbench.arrivalRemovalsPending"
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
      <!-- 13.6b / 裁定 3：入场格含铁路时才出现；点目的地后进确认窗 -->
      <div
        v-if="activeArrivalIndex !== null && workbench.arrivalRailEligible(activeArrivalIndex)"
        class="row"
        data-testid="arrival-rail-entry"
      >
        <BaseButton variant="secondary" size="sm" @click="beginArrivalRail(activeArrivalIndex)">
          铁路运输 · 13.6b
        </BaseButton>
        <span class="muted">从含铁路的入场格出发，消耗本回合运力</span>
      </div>
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

      <!-- ── 第一段唯一出口：结束本段（收束整段，不再自动关窗）────────── -->
      <div class="row" data-testid="arrival-finish-row">
        <BaseButton
          v-if="!arrivalFinishConfirm"
          variant="primary"
          size="sm"
          :disabled="workbench.arrivalRemovalsPending"
          data-testid="arrival-finish"
          @click="finishArrivalSegment()"
        >
          结束本段
        </BaseButton>
        <template v-else>
          <span class="warn" data-testid="arrival-finish-abandon-hint">
            手牌还有 {{ arrivalHandCards.length }} 枚未上场：结束即视为放弃上场（作废、不结转）。
          </span>
          <BaseButton
            variant="primary"
            size="sm"
            data-testid="arrival-finish-abandon"
            @click="confirmAbandonArrival()"
          >
            放弃并结束
          </BaseButton>
          <BaseButton
            variant="secondary"
            size="sm"
            data-testid="arrival-finish-cancel"
            @click="arrivalFinishConfirm = false"
          >
            继续放置
          </BaseButton>
        </template>
      </div>
      <p v-if="arrivalFinishError !== ''" class="warn" data-testid="arrival-finish-error">
        {{ arrivalFinishError }}
      </p>

      <p v-if="plan !== null && plan.shutdowns.length > 0" class="warn">
        <BaseTag kind="danger">2.1a</BaseTag>
        当日生效的补给源关闭：{{ plan.shutdowns.join('、') }}
      </p>

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
      :ack-disabled="!workbench.variableReplRolled"
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
      <div v-if="replCheckVisible || workbench.variableReplRolled" class="row">
        <!--
        B28：骰面与"是否自动掷"的勾选都撤掉 —— 一律走种子化 RNG，骰面在结果行与结算日志里可复算。
        4.0（用户 2026-11-13 口径）：4.1b 是否启用由**选剧本前的共识**决定，段内不再有第二个开关。
      -->
        <BaseButton v-if="replCheckVisible" variant="primary" size="sm" @click="runReplCheck">
          掷骰检定
        </BaseButton>
        <BaseButton
          v-if="workbench.variableReplRolled"
          variant="ghost"
          size="sm"
          @click="workbench.clearNonSavableReplNow()"
        >
          清零不可保存的补员
        </BaseButton>
      </div>
      <!-- Q4：骰面与查表结果（骰面来自真实 1d6；结果来自两张表） -->
      <p v-if="specialReplLastThisTurn" class="num" data-testid="special-repl-last">
        <BaseTag :kind="containers.specialReplLast?.ok === true ? 'info' : 'warning'">
          1.6c 骰面 {{ containers.specialReplLast?.die ?? '—' }}
        </BaseTag>
        {{ containers.specialReplLast?.detail }}
      </p>
      <!-- 1.6b 补给表所得 SP 已入图外盒：给一个明确数字，别让玩家以为丢了 -->
      <p v-if="offMapDepositSp > 0" class="num" data-testid="supply-offmap-deposit">
        <BaseTag kind="info">1.6b</BaseTag>
        补给表 {{ offMapDepositSp }} SP 已放入图外空军盒（可用空军任务运进地图）
      </p>
      <!-- 只列「拿到什么」：骰面 / 表名 / 条款号不上屏 -->
      <ul v-if="variableReplResult.length > 0" class="num repl-result">
        <li v-for="line in variableReplResult" :key="line">{{ line }}</li>
      </ul>
      <p v-if="replPendingTotal > 0" class="muted num">
        补员已进待放手牌（Pax {{ workbench.replPending.pax }} / Eq
        {{ workbench.replPending.eq }}），统一在「待放上手牌」里落位。
      </p>
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
          <span class="muted">判定阶段不落子：2 SP 已进「待放上手牌」，到放置阶段点格落位</span>
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
      </template>
    </SessionStep>
    <!--
      v7.1 第二段：**统一手牌**（用户 2026-11-11 口径：判定全部走完才进放置阶段）

      合并的是**放置动作**，不是来源语义：
        · 全部来源（1.6b 补员表 / 1.6c 特殊补员 / 1.6b 补给表 SP / 3.6 补给列车 / 2.3c 新单位）
          汇成同一张手牌，每条仍带来源标签；
        · 卡面＝算子图（照到达段范式），角标＝该条待放的枚数 / SP；
        · 点算子 → 引擎只高亮该来源的合法格 → 点格落一枚；已落位同样按阵列显示，右键收回。
    -->
    <SessionStep v-if="showsActions" item="reinforce:hand" data-testid="roll-hand">
      <p v-if="!workbench.rollPlacementOpen" class="warn" data-testid="roll-hand-gate">
        判定阶段还没走完：{{ workbench.rollPlacementBlockedReason }}
      </p>
      <div class="arrival-hand" data-testid="roll-hand-cards">
        <button
          v-for="entry in visibleRollHandEntries"
          :key="entry.id"
          type="button"
          class="arrival-hand__card"
          :disabled="!workbench.rollPlacementOpen || entry.blocked !== null"
          :title="entry.blocked ?? `${entry.label}：${entry.detail}`"
          data-testid="roll-hand-card"
          @click="workbench.beginRollHandEntryNow(entry.id)"
        >
          <img
            v-if="rollHandImage(entry) !== null"
            :src="rollHandImage(entry) ?? undefined"
            alt=""
            class="arrival-hand__img"
          />
          <span v-else class="arrival-hand__fallback" :title="entry.label">{{ entry.short }}</span>
          <span
            v-if="entry.count > 1"
            class="arrival-hand__badge num"
            data-testid="roll-hand-badge"
          >
            {{ entry.count }}
          </span>
        </button>
      </div>
      <p
        v-for="entry in visibleRollHandEntries.filter((item) => item.blocked !== null)"
        :key="`hand-blocked:${entry.id}`"
        class="warn num"
      >
        {{ entry.label }}：{{ entry.blocked }}
      </p>
      <!-- 3.4b：德军到货 SP 的逐格归属（未选不落账；归属在选择落点后给出） -->
      <div
        v-if="
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
      <!-- 已落位的算子：右键收回（只在本段有效）；SP 落点是账本，仍在下一行点收回 -->
      <div v-if="placedRollCards.length > 0" class="row">
        <span class="muted num">本段已落位（右键收回）</span>
        <div class="arrival-hand" data-testid="roll-hand-placed-cards">
          <button
            v-for="card in placedRollCards"
            :key="card.key"
            type="button"
            class="arrival-hand__card arrival-hand__card--placed"
            :title="`${card.raw}：右键收回（只在本段有效）`"
            data-testid="roll-hand-placed"
            @contextmenu.prevent.stop="card.withdraw()"
          >
            <img v-if="card.image !== null" :src="card.image" alt="" class="arrival-hand__img" />
            <span v-else class="arrival-hand__fallback">{{ card.short }}</span>
            <span class="arrival-hand__undo">↩</span>
          </button>
        </div>
      </div>
      <div
        v-if="workbench.freeRailPicked.length > 0 || workbench.freeRailEdgeHex !== null"
        class="row"
        data-testid="roll-hand-sp-placed"
      >
        <span class="muted num">本段已指定的 SP 落点（点一下收回）</span>
        <BaseButton
          v-for="hex in workbench.freeRailPicked"
          :key="`sp-picked:${hexLabel(hex)}`"
          variant="ghost"
          size="sm"
          @click="workbench.toggleFreeRailPick(hex)"
        >
          城市 {{ hexLabel(hex) }} 1 SP ↺
        </BaseButton>
        <BaseButton
          v-if="workbench.freeRailEdgeHex !== null"
          variant="ghost"
          size="sm"
          @click="workbench.pickFreeRailEdgeHex(null)"
        >
          图边 {{ hexLabel(workbench.freeRailEdgeHex) }}（余额）↺
        </BaseButton>
      </div>
    </SessionStep>

    <!-- 第二段唯一出口：所有骰子判完、手牌清空（或确认放弃） -->
    <SessionStep v-if="showsActions" item="reinforce:endRoll" data-testid="roll-end-step">
      <div class="row">
        <BaseButton variant="primary" size="sm" @click="finishRollSegment()"> 结束本段 </BaseButton>
        <span class="muted num">手牌 {{ workbench.rollHandPoints }} 点待放</span>
      </div>
      <div v-if="rollFinishConfirm" class="row" data-testid="roll-end-abandon">
        <span class="num">手牌还没放完：结束本段将把未落位的增援作废（不结转）。</span>
        <BaseButton variant="primary" size="sm" @click="confirmAbandonRoll()">放弃上场</BaseButton>
        <BaseButton variant="ghost" size="sm" @click="rollFinishConfirm = false">返回</BaseButton>
      </div>
      <p v-if="rollFinishError !== ''" class="warn" role="status">{{ rollFinishError }}</p>
    </SessionStep>

    <!--
      第三段（重建 · 合并 · 整编）：**不再开大窗**（v7.1 §4.3）。
      重建＝死亡堆右键 / 盘面打残右键；整编＝盘面多选右键；本段只问「是否结束本段」。
      补员点是盘面资源：Pax / Eq 两栏各带一个「免费重建 N」**提示**（1.6c / 2.3c，不参与扣点）。
    -->
    <SessionStep v-if="showsRebuild" item="reinforce:endRebuild" data-testid="rebuild-end-step">
      <hr />
      <p class="muted">
        第三段（重建 · 合并 · 整编）：重建与整编都在**盘面右键**办理，本段没有待放项。
        补员点数用不完留在图上，跨段跨回合继续可用（不清空、不作废）。
      </p>
      <div class="row">
        <span class="field">
          Pax <span class="num">{{ workbench.boardReplTotals.pax }}</span>
          <BaseTag kind="info" data-testid="rebuild-free-pax">
            免费重建 {{ workbench.rebuildFreeHint }}
          </BaseTag>
        </span>
        <span class="field">
          Eq <span class="num">{{ workbench.boardReplTotals.eq }}</span>
          <BaseTag kind="info" data-testid="rebuild-free-eq">
            免费重建 {{ workbench.rebuildFreeHint }}
          </BaseTag>
        </span>
      </div>
      <div class="row">
        <BaseButton
          variant="primary"
          size="sm"
          data-testid="rebuild-end"
          @click="workbench.endRebuildSegmentNow()"
        >
          结束本段
        </BaseButton>
      </div>
      <p v-if="workbench.lastRebuild !== null" class="ok">
        <BaseTag kind="success">{{ workbench.lastRebuild.rule }}</BaseTag>
        {{ workbench.lastRebuild.detail }}
      </p>
      <p v-if="workbench.lastConsolidation !== null" class="ok">
        <BaseTag kind="success">{{ workbench.lastConsolidation.rule }}</BaseTag>
        {{ workbench.lastConsolidation.detail }}
      </p>
      <p class="num">
        死亡堆 {{ workbench.deadPile.length }} 个｜永久移除 {{ workbench.removedForever.length }} 个
      </p>
    </SessionStep>
    <!-- ── · 慢动员（专规 2.4） ── -->
    <!-- 2.4 是苏联专规：仅**苏方增援阶段**渲染（轴方增援阶段不出现该 UI，用户 2026-11-07 ②） -->
    <SessionStep
      v-if="showsActions && workbench.slowMobilizationVisible"
      item="reinforce:slow"
      ackable
      ack-label="结束本段"
      @ack="finishSlowSegment()"
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
          title="裁判修正入口：正常解锁请走下方按表 2-2 的提交流程"
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
        <BaseTag>当日配额 {{ slowMobilizationQuota }}</BaseTag>
        <BaseTag>今日应解锁 {{ slowMobilizationRequired }}</BaseTag>
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
          :disabled="
            slowMobilizationRequired === 0 ||
            slowMobilizationPick.length !== slowMobilizationRequired
          "
          @click="submitSlowMobilizationPick"
        >
          提交本回合解锁（2.4）
        </BaseButton>
      </div>
      <p v-if="slowFinishError !== ''" class="warn" data-testid="slow-finish-error">
        {{ slowFinishError }}
      </p>
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
          <span class="muted">
            领取只登记：2 SP 并入到货 SP、新单位进「待放上手牌」；落点在放置阶段按 2.1 点格给出
          </span>
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
