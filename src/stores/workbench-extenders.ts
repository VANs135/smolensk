/**
 * workbench-extenders.ts —— C8e：12.7 延补队 ⇄ 运输点数的双向转换（含 9.14d 的主动崩溃）
 *
 * B3-2b13（2026-11-21）：搬出 7 个声明 / 318 行声明区：
 * `convertibleTransportPointsAt` / `extenderRecordFor` / `convertTransportToExtenderNow` /
 * `flipExtenderToTransport` / `flipExtenderRecordInPlace` / `collapseExtenderNow` / `extenderLabelOf`。
 * 函数体只改写 **1 个语句**（见下）。
 *
 * ## 唯一的改写：`specialPending` 是写穿用法
 *   9.14d 主动崩溃要把整个待办对象写进去（`specialPending.value = {...}`，facade 里是个晚于本域装配点的
 *   `ref`）。ref 只读时给 getter，但这里是**赋值** ⇒ 按 b11 的招法给回调：deps 的
 *   `setSpecialPending(next)`，切片内 `specialPending.value = {...}` → `setSpecialPending({...})`。
 *   回调在调用时才求值，故晚声明不构成 TDZ。
 *
 * ## 端口为什么这么窄（9 项）
 *   `transportRecordFor` 由 b12 的 `transportPointsDomain` 解构提供（本域装配在其之后），直接按值传；
 *   `requireAction` / `pushLog` 是 `function` 声明（提升）；`actingSide` / `phase` / `supplyFacts` 是
 *   早于本域的 computed。没有任何一项需要 getter 包装。
 */
import type { ComputedRef, Ref } from 'vue'

import {
  canConvertTransportToExtender,
  canCreateExtenderAt,
  createTraceSupplyAt,
  extenderDisplacementCandidates,
  extenderRangeMpOf,
  EXTENDER_FLIP_MA_FRACTION,
  EXTENDER_REQUIRED_POINTS,
  isConvertibleTransportPoint,
  planConvertTransportToExtender,
  planFlipExtenderToTransport,
} from '@/engine/rules'
import type { MovementSegmentPhase, Side, TransportKind } from '@/engine/rules'
import { sameHex } from '@/engine/hex-geometry'
import { mapLayers, type HexRef } from '@/data'
import type { Derivation } from '@/engine/derivation'
import { createId } from '@/shared'
import { isExtenderUnit, parseHexPath, toConsoleUnit, unitChoices } from './workbench-model'
import type {
  ActionKey,
  ConsolePhase,
  ConsoleUnit,
  SpecialCombatPending,
  UnitRecordView,
  WorkbenchLogEntry,
} from './workbench-model'

/** C8e 延补队域的端口（9 项，2026-11-21 实测）。 */
export interface ExtendersDeps {
  /** 7.0a：反应段的「本方」是行动方，不是阶段玩家 */
  actingSide: ComputedRef<Side>
  phase: ComputedRef<ConsolePhase>
  /** 12.7d 的连通判据输入（与 `createTraceSupplyAt` 同一份事实） */
  supplyFacts: ComputedRef<Parameters<typeof createTraceSupplyAt>[0]>
  units: Ref<ConsoleUnit[]>
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  requireAction: (key: ActionKey, action: string) => boolean
  /** 9.14d 的重要提示话术用（`ConsolePhase` ⇒ 中文名） */
  PHASE_LABELS: Record<ConsolePhase, string>
  /** b12 的 `transportPointsDomain` 解构提供 */
  transportRecordFor: (kind: string, size: number, side: Side) => UnitRecordView | null
  /** 晚声明 `ref`，本块只整体写入 ⇒ 写穿回调 */
  setSpecialPending: (value: SpecialCombatPending | null) => void
}

export function createExtendersDomain(deps: ExtendersDeps) {
  const {
    actingSide,
    phase,
    supplyFacts,
    units,
    pushLog,
    requireAction,
    PHASE_LABELS,
    transportRecordFor,
    setSpecialPending,
  } = deps

  /** 12.7a：某格**当前方**的通用运输点数（编内卡车不算，5.7f/13.2c） */
  function convertibleTransportPointsAt(hex: HexRef): ConsoleUnit[] {
    return units.value.filter(
      (unit) =>
        // 7.0a：反应段的「本方」是 `actingSide`（非阶段玩家），不是 `activeSide`
        unit.side === actingSide.value &&
        sameHex(unit.hex, hex) &&
        isConvertibleTransportPoint({
          noncombatKind: unit.noncombatKind ?? null,
          transportKind: unit.noncombatTransportKind ?? null,
        }),
    )
  }

  /** 12.7：某方某型号的延补队算子 record（引擎不写死 id，由状态层按记录搜索） */
  function extenderRecordFor(kind: TransportKind, side: Side): UnitRecordView | null {
    return (
      unitChoices(side).find(
        (record) =>
          record.noncombatKind === 'supply_extender' &&
          (record.noncombatDetails?.transportKind ?? 'truck') === kind,
      ) ?? null
    )
  }

  /**
   * 12.7a：**运输点数 → 延补队**
   *
   * 「将合计至少 5 点运输点数移动到**同一格**中后，即可将这些运输点数转换为延补队。
   *   此操作消耗 **1/2 的 MA**。」点数可任意拆分，故引擎会取「和最小且 ≥ 消耗量」的那组算子移走，
   * 余数留在原格（`leftoverPlacement` 给出面额拆分）。
   */
  function convertTransportToExtenderNow(hexText: string, kind: TransportKind, count = 1): boolean {
    // 12.7a：转换只在**移动阶段**（C/E/G 三个移动环节）——与引擎 `EXTENDER_SEGMENTS` 同口径的 UI 闸
    if (!requireAction('move.extenderConvert', '运输点数转延补队')) return false
    const hex = parseHexPath(hexText)[0]
    if (hex === undefined) {
      pushLog('warning', `转换格号应为「列.行」，收到「${hexText}」（12.7a）`, '12.7a')
      return false
    }
    /*
     * 12.7d：**载有 SP 的运输点不能转延补队**（必须先卸载）——判据在引擎：它会把装载者**滤出凑数**，
     * 并在"因此不够、而算上装载者就够"时报 `12.7d / loadedMustUnloadFirst`。
     * 这里不再自作主张地整笔拒绝（同格另有空车时，转换本就合法）。
     */
    const entries = convertibleTransportPointsAt(hex)
    const record = extenderRecordFor(kind, actingSide.value)
    if (record === null) {
      pushLog('warning', `算子库里没有「${kind}」延补队算子（12.7a）`, '12.7a')
      return false
    }
    const entryInputs = entries.map((unit) => ({
      id: unit.instanceId,
      kind: (unit.noncombatTransportKind ?? 'truck') as TransportKind,
      points: unit.noncombatTransport,
      // 12.7e（用户 2026-11-13 裁定）：每个运输点数各自持有自己的 MP，转换代价花在**该点自身 MP** 上
      ma: unit.faces.combat.ma || unit.faces.move.ma,
      mpSpent: unit.mpSpent,
      // 12.7d：载有 SP 的运输点**不能**转延补队（必须先卸载）——判据在引擎
      loaded: unit.loadedSpT > 0,
    }))
    /*
     * 12.7a（第五批批 B 切片 2）：**环节闸由引擎再判一次**（`EXTENDER_SEGMENTS`）——
     * "引擎判 + UI 闸"双层同源；`wrongSegment` 的失败话术由此给出（引擎是判据唯一出处）。
     */
    const gate = canConvertTransportToExtender({
      phase: phase.value as MovementSegmentPhase,
      entries: entryInputs,
    })
    if (!gate.ok) {
      pushLog('warning', `运输点数转延补队被拒：${gate.reason}（${gate.rule}）`, gate.rule)
      return false
    }
    /*
     * 12.7d（第五批批 B 切片 2）：「延补队在**生成时**，如果此时它所在格无法与一个追溯补给的
     * 补给来源格相连，则不能在该格内生成延补队」⇒ 用**即将生成的那一面**的机动类型判连通
     * （卡车延补队＝轮式、马车延补队＝徒步——与数据层印值一致）。
     */
    const connectivity = canCreateExtenderAt(supplyFacts.value, {
      hex,
      // 7.0a：反应段生成延补队的是非阶段玩家 ⇒ 连通性按它的补给网判
      side: actingSide.value,
      mobility: kind === 'truck' ? 'truck' : 'leg',
      // 12.7b/12.7d：生成连通用**即将生成那一面的印值 MA**（卡车 20 / 马车 10），
      // 不是 12.3a 的 5 轮式 MP——后者只约束「单位→源」的接收段（U23/G7）
      rangeMp: extenderRangeMpOf({
        // `UnitRecordView` 是 Partial，缺字段时才按运输点数类型回退（真实算子库两值都有）
        ma: record.factors?.combat?.ma ?? (kind === 'truck' ? 20 : 10),
      }),
    })
    if (!connectivity.ok) {
      pushLog(
        'warning',
        `运输点数转延补队被拒：${connectivity.reason}（${connectivity.rule}：生成格与补给来源不相连）`,
        connectivity.rule,
      )
      return false
    }
    const outcome = planConvertTransportToExtender({
      kind,
      count,
      entries: entryInputs,
      newRecordId: record.id,
    })
    if (!outcome.ok) {
      pushLog('warning', `运输点数转延补队被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const plan = outcome.data
    // 移走被消耗的算子，余量按引擎给的面额重建
    const removed = new Set(plan.swaps.map((swap) => swap.transportUnitId))
    units.value = units.value.filter((unit) => !removed.has(unit.instanceId))
    for (const size of plan.leftoverPlacement) {
      const leftoverRecord = transportRecordFor(kind, size, actingSide.value)
      if (leftoverRecord === null) {
        pushLog(
          'warning',
          `算子库里没有「${kind} ${size}」的运输点数算子 ⇒ 余量 ${size} 点无法落盘（12.7a）`,
          '12.7a',
        )
        return false
      }
      const leftover = toConsoleUnit({
        record: leftoverRecord,
        instanceId: createId('tp'),
        hex,
        side: actingSide.value,
      })
      // 12.7e（用户 2026-11-13 裁定）：余量来自**已付过转换代价**的点 ⇒ 不是满 MP 的新算子
      leftover.mpSpent = leftover.faces.combat.ma * EXTENDER_FLIP_MA_FRACTION
      units.value = [...units.value, leftover]
    }
    // 新延补队：12.7d 的 1/2 MA 代价 = **该延补队自身** MA 的一半（逐队、各自持有自己的 MP）
    // ★ 12.7b：延补队的距离就是它的**印值 MA**，印在**战斗面** ⇒ 以战斗面摆放。
    // ★ 第五批批 B 切片 2：修前无论 `count` 是多少都只落 **1 枚**（却按 count 扣点）⇒ 现在逐队落盘。
    const created: ConsoleUnit[] = []
    for (let i = 0; i < plan.extenderCount; i += 1) {
      const extender = toConsoleUnit({
        record,
        instanceId: createId('ext'),
        hex,
        side: actingSide.value,
        face: 'combat',
      })
      extender.mpSpent = extender.faces.combat.ma * EXTENDER_FLIP_MA_FRACTION
      created.push(extender)
    }
    units.value = [...units.value, ...created]
    pushLog('success', `${plan.detail}；换成「${record.vassalName ?? record.id}」`, plan.rule)
    // 12.8a：新延补队作为源的连通性在 `traceCoverageHexes` 里实时算；不重判标记
    return true
  }

  /**
   * 12.7d：**延补队 → 5 点运输点数**（玩家主动翻面）
   *
   * 「移动环节内」+「消耗一半 MA」（引擎给 `costMa`）；9.14d 的**被动**崩溃走
   * `resolveSpecialCombatAt` 的位移流程（那里 `playerInitiated: false`、代价 0）。
   */
  function flipExtenderToTransport(extenderId: string): boolean {
    // 12.7d「延补队……翻回运输点数面，翻面要消耗一半的 MA」⇒ 属移动环节（与转换同一道闸）
    if (!requireAction('move.extenderConvert', '翻回运输点数')) return false
    const extender = units.value.find((unit) => unit.instanceId === extenderId)
    if (extender === undefined || !isExtenderUnit(extender)) {
      pushLog('warning', '请选择一个延补队算子（12.7d）', '12.7d')
      return false
    }
    const kind = (extender.noncombatTransportKind ?? 'truck') as TransportKind
    // 7.0a：反应段的翻面同样落在行动方名下（非阶段玩家）
    const record = transportRecordFor(kind, EXTENDER_REQUIRED_POINTS, actingSide.value)
    if (record === null) {
      pushLog('warning', `算子库里没有「${kind} 5」的运输点数算子（12.7d）`, '12.7d')
      return false
    }
    const outcome = planFlipExtenderToTransport({
      phase: phase.value as MovementSegmentPhase,
      kind,
      // 12.7d：翻面代价取延补队**自身印值 MA**（12.7b：印在**战斗面**）
      extenderMa: extender.faces.combat.ma,
      transportRecordId: record.id,
      playerInitiated: true,
    })
    if (!outcome.ok) {
      pushLog('warning', `延补队翻面被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    units.value = units.value.filter((unit) => unit.instanceId !== extender.instanceId)
    const flippedPoint = toConsoleUnit({
      record,
      instanceId: createId('tp'),
      hex: extender.hex,
      side: actingSide.value,
    })
    // 12.7e（用户 2026-11-13 裁定）：运输点数各自持有自己的 MP ⇒ 翻面代价要**记在这枚点自己的账上**
    // （修前新算子 mpSpent = 0，等于翻个面就白得满 MP）
    flippedPoint.mpSpent = outcome.data.costMa
    units.value = [...units.value, flippedPoint]
    pushLog(
      'success',
      `${outcome.data.detail}；消耗 ${outcome.data.costMa} MA（12.7d：自身 MA ×½）`,
      outcome.data.rule,
    )
    // 12.8a：翻面不重判标记；延补队是否成源由追溯覆盖集实时判
    return true
  }

  /**
   * 9.14d：把延补队**翻面到「常规运输点数的一面」**
   *
   * 「在新的格内，要将延补队翻面到其常规运输点数的一面。」
   * 数据层里这两面是**两条独立的记录**（`ax-extender-truck` ↔ 5 点卡车运输点数），
   * 故"翻面"＝把该算子换成 5 点运输点数的那一枚。12.7a 末句：崩溃的延补队可作为运输点数使用。
   *
   * @returns 是否成功（算子库缺该面额时失败，由调用方决定报错口径）
   */
  function flipExtenderRecordInPlace(unit: ConsoleUnit, hex: HexRef): boolean {
    const kind = (unit.noncombatTransportKind ?? 'truck') as TransportKind
    // 9.14d：翻面的是**这枚延补队自己** ⇒ 面额取它自己一方（反应段可能是非阶段玩家）
    const record = transportRecordFor(kind, EXTENDER_REQUIRED_POINTS, unit.side)
    if (record === null) return false
    units.value = [
      ...units.value.filter((item) => item.instanceId !== unit.instanceId),
      toConsoleUnit({
        record,
        instanceId: createId('tp'),
        hex: { col: hex.col, row: hex.row },
        side: unit.side,
      }),
    ]
    return true
  }

  /**
   * 9.14d：**移动阶段的主动崩溃**（用户裁定：延补队不能移动，崩溃流程替代常规移动）
   *
   * 条文：「**在延补队的常规移动时，玩家也可以选择使用与崩溃相同的流程，替代常规移动**
   *   （这在延补队没有追溯补给时很有用）。将已崩溃的延补队位移到该延补队**特殊拖取距离内**的任意格中，
   *   前提是**该格此时拥有追溯补给**。敌方单位、ZOC 和禁入地形对位移均无影响，且不会产生损失或被夺取。
   *   在新的格内，要将延补队翻面到其常规运输点数的一面。」
   * 「重要提示：如果不存在"合法"格，则**无法进行崩溃**。此时应在原格内不动，将延补队翻面，
   *   让它根据 9.14c 的规则进行夺取的判定。」
   *
   * 判据与被动路径**同源**：候选＝`extenderDisplacementCandidates`（12.7b 距离，无视敌方/ZOC/禁入地形）
   * ∩ 该格有追溯补给；落点由玩家在地图上点选（走既有的 `setSpecialDisplacement` 与 `confirmSpecialCombatNow`）。
   */
  function collapseExtenderNow(extenderId: string): boolean {
    // 9.14d「延补队……可在**移动环节**用它替代常规移动」⇒ 与转换同一道闸
    if (!requireAction('move.extenderConvert', '延补队主动崩溃')) return false
    const unit = units.value.find((item) => item.instanceId === extenderId)
    if (unit === undefined || !isExtenderUnit(unit)) {
      pushLog('warning', '请选择一个延补队算子（9.14d）', '9.14d')
      return false
    }
    // 9.14d：主动崩溃发生在「延补队的**常规移动**时」⇒ 三个移动环节内
    if (!['movement', 'reaction', 'exploitation'].includes(phase.value)) {
      pushLog(
        'warning',
        `主动崩溃只在移动环节进行（当前 ${PHASE_LABELS[phase.value]}，9.14d）`,
        '9.14d',
      )
      return false
    }
    const traceSupplyAt = createTraceSupplyAt(supplyFacts.value)
    const withinRange = extenderDisplacementCandidates(
      { hex: unit.hex, rangeMp: unit.faces.combat.ma },
      mapLayers.hexes.map((item) => ({ col: item.col, row: item.row })),
    )
    const legalHexes = withinRange.filter((hex) => traceSupplyAt(hex, unit.side))
    if (legalHexes.length === 0) {
      /*
       * 9.14d 的重要提示：不存在合法格 ⇒ **无法崩溃**，原地不动 + 翻面 + 按 9.14c 判夺取。
       * 夺取判定需要掷骰与勾选（属 9.14c 的交互），故此处翻面并**在日志里明确挂出**该义务。
       */
      if (!flipExtenderRecordInPlace(unit, unit.hex)) {
        pushLog(
          'warning',
          `算子库缺少 ${extenderLabelOf(unit)} 的运输点数面 ⇒ 翻面未落盘（9.14d）`,
          '9.14d',
        )
        return false
      }
      pushLog(
        'warning',
        `${unit.name} 没有合法崩溃落点 ⇒ 留在原格并翻面到运输点数面；**须按 9.14c 进行夺取判定**（9.14d 重要提示）`,
        '9.14d',
      )
      // 12.8a：崩溃不重判其他单位的断补标记
      return true
    }
    setSpecialPending({
      hex: { col: unit.hex.col, row: unit.hex.row },
      enteringSide: unit.side,
      splits: [],
      items: [
        {
          unitId: unit.instanceId,
          label: unit.name,
          kind: 'extender',
          detail: `9.14d 主动崩溃：位移到特殊拖取距离（${unit.faces.combat.ma} MP）内、且该格有追溯补给的任意格`,
          candidates: legalHexes.map((hex) => ({ col: hex.col, row: hex.row })),
          chosen: null,
        },
      ],
      notes: ['9.14d：主动崩溃替代常规移动；落点由拥有者在地图上点选'],
      dice: {},
    })
    pushLog(
      'info',
      `${unit.name} 主动崩溃（9.14d）：${legalHexes.length} 个合法落点，请在地图上点选落点后确认`,
      '9.14d',
    )
    return true
  }

  /** 供日志用的延补队面额名（`ax-extender-truck` → `truck 延补队`） */
  function extenderLabelOf(unit: ConsoleUnit): string {
    return `${unit.noncombatTransportKind ?? 'truck'} 延补队`
  }

  return {
    convertTransportToExtenderNow,
    flipExtenderToTransport,
    flipExtenderRecordInPlace,
    collapseExtenderNow,
    extenderLabelOf,
  }
}
