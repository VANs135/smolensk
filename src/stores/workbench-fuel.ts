/**
 * workbench-fuel.ts —— 12.5 燃料域（付款三法 + 来源分账 + 面板派生）
 *
 * B3-2b5（2026-11-21）：按**扇入**整块搬出，而不是把 `payFuel` 单切一半——
 * `payFuel` 引用的燃料族（`hqFuelThrows` / `fuelTargets` / `fuelSourcePartition` / `fuelDumpChoices` …）
 * 全部声明在它之后，按值切成端口会在建店时 TDZ。整块搬走后切片内部互相引用，端口只剩 3 束。
 *
 * 区块是**两段不连续**的：7731–8610（payFuel + 燃料来源/覆盖集）与 9210–9412（燃料面板派生 + 落盘入口），
 * 中间 8612–9200 是「突围」域，仍在 facade 内，与本域无交叉引用。
 *
 * 端口 3 项（束）：core（日志/结算/闸门/快照）、board（会话与板面状态 + 补给查询）、helpers（命名/标签/付款来源辅助）。
 * 切片顶部按原名解构，函数体零改动。
 */
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'

import {
  SP_TO_T,
  canThrowViaHQ,
  countSupplyDistanceToUnitViaTable,
  drawableDumpsFor,
  formationFuelCovers,
  fuelMethodAvailability,
  holdingsToT,
  hqFuelCovers,
  isIndependentUnit,
  planFuelPayment,
  planSpPayment,
  requiresTraceSupply,
  type DrawableDump,
  type FuelMethod,
  type FuelMethodAvailability,
  type PanzerGroupSpPurpose,
  type SpHoldings,
  type SupplyMobility,
} from '@/engine/rules'
import { sameHex } from '@/engine/hex-geometry'
import type { Derivation } from '@/engine/derivation'
import type { RuleFailure } from '@/engine/result-types'
import type { Side } from '@/data'
import type { HexRef } from '@/data'
import type { useGameSessionStore } from './session'
import type { SpDump } from './supply-types'
import type { SettlementRecordInput } from './workbench-core'
import type { ActionKey, ConsoleUnit, WorkbenchLogEntry } from './workbench-model'
import {
  fuelMethodLabelOf,
  hexLabel,
  isHqUnit,
  needsFuelOf,
  toThrowHqView,
} from './workbench-model'
import type * as Model from './workbench-model'

/** 端口束 1：日志 / 结算 / 闸门 —— 每个交互域都要用的同一批能力 */
export interface FuelCore {
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  recordSettlement: (input: SettlementRecordInput) => boolean
  actionAllowedNow: (key: ActionKey) => boolean
  requireAction: (key: ActionKey, action: string) => boolean
  captureUndoSnapshot: (label: string) => number | null
}

/** 端口束 2：会话与板面状态（含补给查询） */
export interface FuelBoard {
  session: ReturnType<typeof useGameSessionStore>
  activeSide: ComputedRef<Side>
  units: Ref<ConsoleUnit[]>
  movePick: Ref<{ hex: HexRef; ids: string[] } | null>
  selectedUnit: ComputedRef<ConsoleUnit | null>
  moveContext: ComputedRef<ReturnType<typeof Model.buildMoveContext>>
  actingSide: ComputedRef<Side>
  supplyFacts: ComputedRef<ReturnType<typeof Model.createSupplyFacts>>
  moveUnits: ComputedRef<ConsoleUnit[]>
  drawableDumpsAt: (hex: HexRef, side: Side, mobility?: SupplyMobility) => DrawableDump[]
  drawableSpDumpsAt: (
    hex: HexRef,
    side: Side,
    mobility?: SupplyMobility,
    drawer?: ConsoleUnit | null,
  ) => SpDump[]
  /** 12.5：本方的燃料池（sp / t 两账） */
  fuelPool: Ref<{ sp: number; t: number }>
  /** 12.1b：站内 SP + 装载在运输点数上的 SP */
  allSpDumps: ComputedRef<SpDump[]>
}

/** 端口束 3：命名 / 标签 / 付款来源辅助 */
export interface FuelHelpers {
  nameOf: (unitId: string) => string
  FUEL_METHOD_LABELS: Record<FuelMethod, string>
  retryBeginMove: () => void
  setSpDumpHoldings: (id: string, holdings: SpHoldings) => void
  deliverableDumpsFor: (side: Side, beneficiaries: readonly ConsoleUnit[]) => SpDump[]
  panzerGroupSpGate: (input: {
    dumpId: string | null
    purpose: PanzerGroupSpPurpose
    beneficiaryUnitIds: readonly string[]
  }) => RuleFailure | null
  panzerGroupSpRefusal: (failure: RuleFailure, purpose: string, dumpId: string | null) => string
}

/** 12.5 燃料域的端口：3 个共享束（2026-11-21 实测）。 */
export interface FuelDomainPorts {
  core: FuelCore
  board: FuelBoard
  helpers: FuelHelpers
}

export function createFuelDomain(ports: FuelDomainPorts) {
  const { pushLog, recordSettlement, actionAllowedNow, requireAction, captureUndoSnapshot } =
    ports.core

  const {
    session,
    activeSide,
    units,
    movePick,
    selectedUnit,
    moveContext,
    actingSide,
    supplyFacts,
    moveUnits,
    drawableDumpsAt,
    drawableSpDumpsAt,
    fuelPool,
    allSpDumps,
  } = ports.board

  const {
    nameOf,
    FUEL_METHOD_LABELS,
    retryBeginMove,
    setSpDumpHoldings,
    deliverableDumpsFor,
    panzerGroupSpGate,
    panzerGroupSpRefusal,
  } = ports.helpers

  /**
   * C5：付燃料（12.5c 三法）——费用由引擎算，本 store 只**从声明的补给站**扣款并打标记
   *
   * ★ 12.3a/12.3b 是仅有的两条取补途径（用户裁定：「补给只能从**己方补给站**扣」）——
   *   与 12.4 的战斗补给同一条纪律：**没有来源就付不出**，不存在"手填一个数字就算付了"的池子。
   *   原先这里从 `fuelPool` 扣：账本不变、同一份数字可反复"支付"，3.4b 也无从校验。
   */
  function payFuel(
    method: FuelMethod = fuelMethodEffective.value,
    commonSource: boolean = fuelSourcePartition.value.shared,
    minimal = false,
  ): void {
    // 专规 4.2c（可选）：未启用时「最省供油」这条路径在引擎侧也不成立
    if (minimal && !session.rule4On('minimalFueling')) {
      pushLog('danger', '专规 4.2c 未在选剧本前勾定 ⇒ 不能使用「最省供油」', '4.2c')
      return
    }
    // 12.5a/12.5f：加油在 C/E/G 三段的**移动环节**当场付（H④ 起 D 段那个「加油」环节已删，
    // 12.5c：付款绑在消耗时刻，而补给段不发生燃料消耗）
    if (!requireAction('supply.fuel', '付燃料')) return
    const targets = fuelTargets.value
    if (targets.length === 0) {
      pushLog('warning', '先选中要加油的单位（或开始移动一个堆叠）', '12.5')
      return
    }
    /*
     * 12.5a / 12.5c：只有**轮式/履带 MP 的战斗单位**需要燃料。玩家的选子常常是一整个堆叠
     * （剧本 1 的 15.25 同时有装甲、炮兵与徒步面的摩步），把不需要燃料的成员也塞进
     * `planFuelPayment` 会被它按 12.5a **整单拒绝** ⇒ 整堆叠都加不了油（用户 2026-11-07 的
     * 「不能给该单位加油」在选整编队时也会撞上这一条）。付款与扣账只按耗油成员计价；
     * 编队法/HQ 法的**覆盖集**仍按盘面事实算（见下方 `formationFuelCoverageSet` /
     * `hqFuelCoverageSet`，它们从 `targets` 取，不因此缩小）。
     */
    const beneficiaries = targets.filter((unit) => needsFuelOf(unit))
    if (beneficiaries.length === 0) {
      pushLog(
        'warning',
        '选中的单位都不需要燃料（12.5a：只有轮式/履带 MP 的战斗单位耗油）',
        '12.5a',
      )
      return
    }
    /*
     * 12.5c（用户 2026-09-17 的界面口径）：**点谁决定能点哪一法** ——
     *   单独单位法对任何单位都成立；编队法要"一整个多单位编队"；HQ 法要选中里有指挥部、
     *   且其余受益单位都是独立单位（3.2f）。判据在引擎 `fuelMethodAvailability`（唯一实现），
     *   这里**当场拦**（界面之外的路径也一致），并把不可用的原因原文照给。
     */
    const availability = fuelMethodChoices.value.find((item) => item.method === method)
    if (availability !== undefined && !availability.available) {
      pushLog('danger', availability.reason ?? `12.5c：${method} 法对当前受益单位不成立`, '12.5c')
      return
    }
    /*
     * ★ B32 步骤 4（12.5c-A / **13.7a**）：编队法与 HQ 法都要求"**全体受益单位共用同一来源**"
     *   （同一指挥部投递 或 同一站直接拖取）。修前这由玩家**勾一个复选框**声明 —— 那就等于
     *   "自己说同源就算同源"。现在按**盘面事实**算（`fuelSourcePartition`）；
     *   不满足时照 13.7a 的第二句给话术：能共用的那部分走编队法，**其余必须改用单独单位法**。
     */
    if (method !== 'singleUnit') {
      const partition = fuelSourcePartition.value
      if (!partition.shared) {
        const namesOf = (ids: readonly string[]): string =>
          ids.map((id) => units.value.find((unit) => unit.instanceId === id)?.name ?? id).join('、')
        pushLog(
          'danger',
          `13.7a：这些受益单位**不是同一个来源**（须同一指挥部投递或同一站直接拖取）⇒ ` +
            `${namesOf(partition.commonUnitIds)} 可走${method === 'hq' ? 'HQ' : '编队'}法，` +
            `${namesOf(partition.singleUnitIds)} 必须改用**单独单位法**（各 1 T）`,
          '13.7a',
        )
        return
      }
    }
    /*
     * 12.5c-B / 12.5e：**HQ 法只覆盖独立单位**（3.2f）——指挥部自己也算独立单位（无编队、单军力）。
     * 编队单位（3.1c）与多军力单位（3.2d）走不了 HQ 法：要么编队法（12.5c-A），要么单独单位法（12.5c-C）。
     * 这里必须**当场拦住**（不能只在候选里藏起来）：界面之外的路径（脚本/宏/读档后重算）也要一致。
     */
    if (method === 'hq') {
      const ineligible = targets.filter((target) => !isIndependentUnitOf(target))
      if (ineligible.length > 0) {
        pushLog(
          'danger',
          `12.5c-B/12.5e：HQ 法只覆盖**独立单位**（3.2f：不属多单位编队、也非多军力单位）⇒ ` +
            `${ineligible.map((unit) => `${unit.name}${unit.formation === null ? '' : `（编队 ${unit.formation}）`}`).join('、')}` +
            ` 不能用 HQ 法；请改用编队法（12.5c-A）或单独单位法（12.5c-C，每单位 1 T）`,
          '12.5c-B',
        )
        return
      }
      /*
       * 12.5e + 12.5d（用户 2026-09-20 裁定）：**燃料窗口持续到本方清理阶段结束** ——
       *   · 窗口内**换位置**投递 ⇒ 按 12.5e 拒（「每个阶段中只能在单独一个位置投递」）；
       *   · 窗口内**同位置**再投 ⇒ 按 12.5c-B 拒：该指挥部已补给（再付只是白花 1SP），
       *     未被覆盖的独立单位走 12.5c-C（每枚 1T）。
       */
      const paidHq = targets.find((target) => isHqUnit(target))
      if (paidHq !== undefined) {
        const previous = hqFuelThrows.value[paidHq.instanceId]
        const originKey = hexLabel(paidHq.hex)
        if (previous !== undefined) {
          pushLog(
            'danger',
            previous.originKey !== originKey
              ? `12.5e：${paidHq.name} 的**燃料窗口**内已在 ${previous.originKey} 投递过 —— ` +
                  `燃料已补给的指挥部**每个阶段只能在单独一个位置**投递（本次不改动任何账本）；` +
                  `若要换位置，请在它移动**开始前**选定投递基点（起始格或结束格）`
              : `12.5c-B：${paidHq.name} 的**燃料窗口**还没结束（${previous.originKey} 投递，覆盖 ` +
                  `${String(previous.coveredIds.length)} 枚）—— 12.5d 明写指挥部燃料标记要到**本方清理阶段**才移除 ⇒ ` +
                  `窗口内**无需重复付款**（本次不改动任何账本）；未被它覆盖的独立单位请用 **12.5c-C 单独单位法**（每枚 1T）`,
            previous.originKey !== originKey ? '12.5e' : '12.5c-B',
          )
          return
        }
      }
    }
    const dump = fuelDump.value
    if (dump === null) {
      pushLog(
        'danger',
        '12.3a：燃料必须从**己方补给站**取 ⇒ 先在「燃料付款来源」里点选一座补给站（不存在凭空可用的池子）',
        '12.3a',
      )
      return
    }
    /*
     * 12.5c-A（I①）：**整编队每阶段只付一次编队法**。
     * 原文把"来源不同的那些单位"明确路由到**单独单位法**（每单位 1T），而不是再买一次编队油；
     * 编队标记（13.7 的燃料已补给面）也只翻一次 ⇒ 已付过的编队再点编队法即拒（账本一字未动）。
     */
    const fuelFormation = method === 'formation' ? (targets[0]?.formation ?? null) : null
    if (method === 'formation' && fuelFormation !== null) {
      const previous = formationFuelThrows.value[fuelFormation]
      if (previous !== undefined) {
        pushLog(
          'danger',
          `12.5c-A：编队 ${fuelFormation} 的**编队油窗口**还没结束（上次来源 ${previous.sourceLabel}，` +
            `覆盖 ${String(previous.coveredIds.length)} 枚）—— 12.5d 明写编队标记要到**本方清理阶段**才翻回，` +
            `期间**一整个编队只付 1SP** ⇒ 本次不改动任何账本；该编队其余成员请按 ` +
            `**12.5c-C 单独单位法**（每枚 1T）付`,
          '12.5c-A',
        )
        return
      }
    }
    /*
     * 12.3a：加油的 SP 只能来自**受益单位自己方**的补给站，且必须是这些单位**拖得到**的那一座
     * （5 MP 直拖或相邻，12.3c）。
     * ★ 判据不取 `activeSide`——反应段（7.0a）里为**已释放的预备**加油时，行动方是对手，
     *   而油钱仍由该预备单位自己一方出（本例：轴方回合的反应段给苏军预备队加油）。
     */
    const beneficiarySides = new Set(targets.map((unit) => unit.side))
    if (beneficiarySides.size !== 1 || !beneficiarySides.has(dump.side)) {
      pushLog(
        'danger',
        `12.3a：${hexLabel(dump.hex)} 的补给属于${dump.side === 'axis' ? '轴心国' : '苏联'}，` +
          `不能用来给${[...beneficiarySides].map((side) => (side === 'axis' ? '轴心国' : '苏联')).join('、')}的单位加油`,
        '12.3a',
      )
      return
    }
    const reachable = new Set(fuelDumpChoices.value.map((item) => item.id))
    if (!reachable.has(dump.id)) {
      /*
       * B32 步骤 3：**按方法给话术** —— 三种方法的可达性口径不同，一句"5 MP 直拖"会误导：
       *   · 单单位法（12.5c-C）：受益单位自己 5 MP 直拖或相邻（12.3a/12.3c）；
       *   · HQ 法（12.5c-B/12.5e）：该站须由**某座 HQ**拖得到，且该 HQ 的**印刷投递距离**
       *     覆盖**全部**受益单位；投递距离还要在"所有独立单位移动开始前"一次算定；
       *   · 编队法（12.5c-A/13.7a）：**全体受益单位共用同一来源**（同一 HQ 投递或同一站直拖）；
       *     做不到时按 13.7a —— **同源的那部分**走编队法、**其余**改单独单位法。
       */
      const methodReason =
        method === 'hq'
          ? '12.5c-B/12.5e：HQ 法要求这座站是**某座指挥部拖得到**的，且该指挥部的**投递距离覆盖全部受益单位**（投递距离须在所有独立单位移动开始前一次算定）'
          : method === 'formation'
            ? '12.5c-A/13.7a：编队法要求**全体受益单位共用同一来源**（同一指挥部投递或同一站直接拖取）；做不到时，只让**同源的那部分**用编队法，其余按 13.7a 改用单独单位法'
            : '12.5c-C：单独单位法要求每个受益单位**自己**在 5 MP 直拖距离内或相邻（12.3a/12.3c）'
      pushLog('danger', `燃料付款来源不可达：${hexLabel(dump.hex)} —— ${methodReason}`, '12.5c')
      pushLog(
        'info',
        `可达的候选：${fuelDumpChoices.value.map((item) => hexLabel(item.hex)).join('、') || '（无）'}`,
        '12.3a',
      )
      return
    }
    const plan = planFuelPayment({
      context: moveContext.value,
      unitIds: beneficiaries.map((unit) => unit.instanceId),
      method,
      commonSource,
      /*
       * 12.1a：计价单位是 **T**（1 SP = 4 T），而 `planFuelPayment` 按 `{sp, t}` **分项**比较。
       * `computeFuelCost` 的三种方法只会给出**其中一项**（单单位法给 T、编队/HQ 法给 SP），
       * 故这里把两种面额各按最宽口径给足，且不会重复计价：
       *   · `availableSp` = 整 SP 数（编队/HQ 法要的就是整 SP）；
       *   · `availableT` = 该站**总吨位**（单单位法可按 12.1a 拆分一个整 SP 找零）。
       */
      availableSp: dump.sp,
      availableT: holdingsToT({ sp: dump.sp, t: dump.t }),
      ...(minimal ? { minimal: true } : {}),
    })
    if (!plan.ok) {
      pushLog('danger', `燃料支付失败：${plan.reason}（${plan.rule}）`, plan.rule)
      return
    }
    // 3.4b：错误集群的 SP 不得支付**多单位编队**的燃油成本
    const restricted = panzerGroupSpGate({
      dumpId: dump.id,
      purpose: 'fuel',
      beneficiaryUnitIds: plan.data.unitIds,
    })
    if (restricted !== null) {
      pushLog(
        'danger',
        `燃料付款被拒（3.4b）：${panzerGroupSpRefusal(restricted, '燃油', dump.id)}——本次不改动任何账本`,
        '3.4b',
      )
      return
    }
    // 12.1a：走统一扣款入口（必要时找零）
    const payment = planSpPayment({
      holdings: { sp: dump.sp, t: dump.t },
      wantT: plan.data.costSp * SP_TO_T + plan.data.costT,
    })
    if (!payment.ok) {
      pushLog(
        'danger',
        `燃料付款失败：${payment.reason}（${payment.rule}）——本次不改动任何账本`,
        payment.rule,
      )
      return
    }
    /*
     * 12.5c-B / 12.5e：**HQ 法的覆盖集在付款这一刻算定** ——
     *   原文：「支付 1SP，为**指挥部自己**，及它投递距离内的**所有独立单位**提供燃料补给」；
     *         「**投递距离在所有的独立单位移动开始前计算**」。
     *   ⇒ 覆盖的是"此刻在投递距离内的**所有**独立单位"（**不只是玩家点选的那几枚**），
     *     且距离**此后不再重算**（单位走开也仍已加注、走来的也不算 —— 这正是 12.5e 的算定口径）。
     */
    const paidHq = method === 'hq' ? (targets.find((unit) => isHqUnit(unit)) ?? null) : null
    /*
     * 12.5c-A（I①，用户 2026-09-18 第 7 条）：编队法的覆盖集在付款这一刻按**盘面事实**算定 ——
     *   同编队、且能从本次付款的这座站取到的**全部**单位（含未被点选的、含徒步面的摩托化单位）；
     *   范围之外的成员不覆盖（它们日后开拔按 12.5c-C 单独单位法付）。
     */
    const formationCoverage =
      method === 'formation' ? formationFuelCoverageSet(targets, dump) : null
    const coveredIds =
      paidHq !== null
        ? hqFuelCoverageSet(paidHq).map((unit) => unit.instanceId)
        : formationCoverage !== null
          ? formationCoverage.covered.map((unit) => unit.instanceId)
          : [...plan.data.unitIds]
    /*
     * ★ 实测（回合 04 · C 移动 · 20PZ 编队法）：扣款必须排在**覆盖集算定之后**。
     *   来源若是「装载在运输点数上的 SP」（12.1b），扣到 0 后该格就不再是"含 SP 的位置"，
     *   `fuelSourceKeysOfUnit` 随即看不见这座站 ⇒ 先扣款再算覆盖会得到空集：
     *   钱扣了、编队一枚没加注（编队油窗口还记成"来源：（未定）"）。
     *
     * ★ 同理，窗口里**来源那一句人话**也必须在扣款之前取下来（`sourceLabel` 不是账本，
     *   只是显示；扣款后该站若已归零就查不到标签，窗口会显示成「（未定）」）。
     */
    const formationSourceLabel =
      formationCoverage === null || formationCoverage.sourceKey === null || targets[0] === undefined
        ? '（未定）'
        : (fuelSourceKeysOfUnit(targets[0]).get(formationCoverage.sourceKey) ?? '（未定）')
    captureUndoSnapshot(
      `加油支付（${method === 'singleUnit' ? '单独单位法' : method === 'formation' ? '编队法' : 'HQ 法'}）`,
    )
    setSpDumpHoldings(dump.id, payment.data.holdingsAfter)
    for (const unitId of coveredIds) {
      const unit = units.value.find((item) => item.instanceId === unitId)
      if (unit !== undefined) {
        unit.fuelled = true
        // 12.5c：记下加油方法——持续期由它决定（单单位法=只本阶段；编队/HQ 法=到本方清理阶段）
        unit.fuelMethod = method
        // 专规 4.2c：最省供油 ⇒ MA ×1/4，且标记在相位末摘除（见 resetMovementTracking）
        unit.minimalFuel = minimal
      }
    }
    if (paidHq !== null && !minimal) {
      // 12.5e/12.5d：记下**投递基点**与覆盖集 —— 窗口持续到**本方清理阶段**（`runCleanUpNow` 才清）
      hqFuelThrows.value = {
        ...hqFuelThrows.value,
        [paidHq.instanceId]: { side: paidHq.side, originKey: hexLabel(paidHq.hex), coveredIds },
      }
    }
    if (formationCoverage !== null && fuelFormation !== null && !minimal) {
      // 12.5c-A（I①）：记下该编队的编队油（来源 + 覆盖集）—— 窗口内再点编队法即拒
      formationFuelThrows.value = {
        ...formationFuelThrows.value,
        [fuelFormation]: {
          side: targets[0]!.side,
          sourceKey: formationCoverage.sourceKey ?? '（未定）',
          sourceLabel: formationSourceLabel,
          coveredIds,
          // #13：付款格（编队油窗口的同格判据）
          originHex: { ...targets[0]!.hex },
        },
      }
      const leftOut = formationCoverage.leftOut.filter(
        (unit) => !coveredIds.includes(unit.instanceId),
      )
      if (leftOut.length > 0) {
        pushLog(
          'info',
          `12.5c-A：编队 ${fuelFormation} 中另有 ${String(leftOut.length)} 枚**不在本次来源范围内**` +
            `（${leftOut.map((unit) => `${unit.name}@${hexLabel(unit.hex)}`).join('、')}）—— ` +
            `按 12.5c-A 它们**不参与**本次编队加油，日后开拔须用 **12.5c-C 单独单位法**（每枚 1T）`,
          '12.5c-A',
        )
      }
    }
    pushLog(
      'success',
      `燃料已付（${FUEL_METHOD_LABELS[method]}：${plan.data.costSp} SP / ${plan.data.costT} T，${plan.data.rule}）；` +
        `付款站 ${hexLabel(dump.hex)} → ${coveredIds.map(nameOf).join('、')}` +
        (paidHq === null
          ? ''
          : `（12.5e：投递基点 ${hexLabel(paidHq.hex)}，本阶段覆盖 ${String(coveredIds.length)} 枚，` +
            `含投递距离内**未被点选**的独立单位）`),
      plan.data.rule,
    )
    // ⑭ 接线：燃料支付（12.5c 三法）入会话日志（本笔不掷骰；费用按规则复核）
    recordSettlement({
      action: 'fuel',
      rule: plan.data.rule,
      data: {
        method,
        commonSource,
        costSp: plan.data.costSp,
        costT: plan.data.costT,
        unitIds: [...plan.data.unitIds],
        // 12.5e：HQ 法的"付费覆盖集"（含未被点选的独立单位）与投递基点一并留痕
        ...(paidHq === null
          ? {}
          : { coveredUnitIds: coveredIds, throwOriginHex: { ...paidHq.hex } }),
        dumpHex: { ...dump.hex },
      },
    })
    // 右键入口的独立加油（有受注单位）不重放"开始移动"：那一步属于移动准备会话，不归加油窗
    if (fuelSubjectId.value === null) retryBeginMove()
  }

  /**
   * 12.5：燃料的**付款来源**（点选一座己方补给站 ⇒ 沿用 12.4 的同一套「声明来源」纪律）
   */
  const fuelDumpId = ref<string | null>(null)

  /**
   * 12.5e：**已投递过燃料的指挥部** ⇒ `{ 投递基点, 付费覆盖集 }`
   *
   * 原文：「燃料已补给的指挥部在**每个阶段**中，只能在**单独一个位置**上投递燃料补给。这会影响
   *   移动中的指挥部，它必须选择从移动**起始格**或者移动**结束格**处投递燃料补给。」
   * ⇒ 记下基点，同窗口内换位置再投递即按 12.5e 拒（**不扣款**）。
   *
   * ★ **持续期（用户 2026-09-20 裁定）**：与 `fuelled` 标记**同寿** ——
   *   12.5c-B 的指挥部燃料标记「持续到**下一个友方清理阶段**」（12.5d 才移除），
   *   用户原话：「**HQ 加油也是到己方清理阶段结束后**」。
   *   ⇒ 本台账**只在"本方清理阶段"随标记一起清**（在 `runCleanUpNow` 里），既不在换阶段清、也不在换回合清：
   *     反应阶段投递的油可以活着跨过半场（甚至回合边界）。窗口内同一指挥部**不再重复付款**
   *     （已补给 ⇒ 再付只是白花 1SP；未被覆盖的独立单位走 12.5c-C，每枚 1T）。
   */
  const hqFuelThrows = ref<
    Record<string, { side: Side; originKey: string; coveredIds: readonly string[] }>
  >({})

  /**
   * 12.5c-A（I①）：**已用编队法付过的编队** ⇒ `{ 来源键, 投递/拖取话术, 覆盖集 }`
   *
   * 「为一整个多单位编队支付 1SP，便可为**整个**多单位编队提供燃料补给」＋「这些使用**不同来源**的单位
   *   只能按**单独单位燃料补给法**来获得燃料补给」⇒ **一次编队加油只买一次**：
   *   已付过的编队再点编队法即拒（本次不改动任何账本），它的其余成员走 12.5c-C（每枚 1T）。
   *
   * ★ **持续期（用户 2026-09-20 裁定）**：不是"一个阶段"，而是与 `fuelled` 标记**同寿** ——
   *   12.5c-A 的编队标记「持续到**下一个友方清理阶段**」（12.5d 才翻回）。用户举的例子：
   *   「同一个回合里在**敌方回合的己方反应阶段**移动环节编队加油，那么到**己方回合移动环节**，
   *   当时按编队加油的单位**仍是加油**，未加油的该编队单位**只能单独加油**，一直到燃料状态重置的
   *   **己方清理阶段**结束后，下次该编队单位要移动时再重新算编队加油」。
   *   ⇒ 本台账**只在"本方清理阶段"随标记一起清**（在 `runCleanUpNow` 里，与 `fuelled` 同一处落盘），
   *     既不在换阶段清、也不在换回合清。
   */
  const formationFuelThrows = ref<
    Record<
      string,
      {
        side: Side
        sourceKey: string
        sourceLabel: string
        coveredIds: readonly string[]
        /** 付款时受益单位所在格（#13：同格同编队后来者按窗口覆盖） */
        originHex: HexRef
      }
    >
  >({})

  /**
   * #13（用户 2026-11-10）：编队油的**同格同编队**补记
   *
   * 12.5c-A：「为**一整个多单位编队**支付 1SP，便可为整个多单位编队提供燃料补给」，覆盖期到
   * 12.5d 的**本方清理阶段**才结束。付款那一刻已在覆盖集里的单位由 `payFuel` 直接置位；这里补的是
   * **付款后才进入同一格**的同编队单位（增援落位、拆分、回合内调上来、读档重排等）——
   * 它们与付款单位同格 ⇒ 用的就是同一座来源（12.5c-A 后半句的来源判据自动成立），
   * 不该在移动环节被再要一次钱（界面表现为"编队法只作用一枚"）。
   */
  function applyFormationFuelCoverage(unit: ConsoleUnit): void {
    if (unit.fuelled) return
    const formation = unit.formation
    if (formation === null || formation === undefined) return
    const record = formationFuelThrows.value[formation]
    if (record === undefined || record.side !== unit.side) return
    if (hexLabel(record.originHex) !== hexLabel(unit.hex)) return
    unit.fuelled = true
    unit.fuelMethod = 'formation'
  }

  /** 对一串实例 id 逐个补记（选中/勾选/开拔时共用） */
  function applyFormationFuelCoverageToIds(ids: readonly string[]): void {
    for (const id of ids) {
      const unit = units.value.find((item) => item.instanceId === id)
      if (unit !== undefined) applyFormationFuelCoverage(unit)
    }
  }

  /**
   * 12.5e：该指挥部此刻的**付费覆盖集**（HQ 自己 + 投递距离内的**所有独立单位**）
   *
   * 判据全部复用既有唯一实现：`isIndependentUnitOf`（3.2f）、`toThrowHqView`（13.1b 的投递距离与移动类型）、
   * `countSupplyDistanceToAny`（12.3b 的投递路径计数，按投递机动类型）。
   * ★ 调用时点＝**付款那一刻**（"投递距离在所有的独立单位移动开始前计算"）⇒ 覆盖集一经算定便不再重算。
   */
  function hqFuelCoverageSet(hq: ConsoleUnit): ConsoleUnit[] {
    const facts = supplyFacts.value
    const hqView = toThrowHqView(hq)
    const covered: ConsoleUnit[] = [hq]
    for (const unit of units.value) {
      if (unit.side !== hq.side || unit.instanceId === hq.instanceId) continue
      if (!isIndependentUnitOf(unit)) continue
      const reach = countSupplyDistanceToUnitViaTable(facts, {
        from: hq.hex,
        unitHex: unit.hex,
        side: unit.side,
        mobility: hqView.throwMobility,
        maxMp: hqView.throwRangeMp,
      })
      if (reach.ok) covered.push(unit)
    }
    return covered
  }

  /** 12.5e：某指挥部本阶段的投递基点（未投递过则 null），供界面显示 */
  function hqFuelThrowOriginOf(hqInstanceId: string): HexRef | null {
    const entry = hqFuelThrows.value[hqInstanceId]
    if (entry === undefined) return null
    const parts = entry.originKey.split('.')
    const col = Number(parts[0])
    const row = Number(parts[1])
    return Number.isInteger(col) && Number.isInteger(row) ? { col, row } : null
  }

  /** 12.5c-A（I①）：某编队本阶段是否已用编队法付过油（供界面如实说明"其余成员要走单独单位法"） */
  function formationFuelThrowOf(
    formationId: string,
  ): { sourceKey: string; sourceLabel: string; coveredIds: readonly string[] } | null {
    return formationFuelThrows.value[formationId] ?? null
  }

  /**
   * 12.5c-A：本次编队付款的**来源键** —— 全体受益单位共有、且与付款站一致的那个（直接拖取优先）
   *
   * 原文把"同一个来源"定成两种：**同一个指挥部**（投递）或**同一个补给站**（直接拖取）。
   * 付款站是玩家点的那座站 ⇒ 直接拖取优先（键 `dump:<格号>`）；否则退回"拖得到这座站的 HQ 投递"
   * （键 `hq:<id>`，12.3b）。两者都不成立 ⇒ null（调用方按"只覆盖点选的单位"处理并如实说明）。
   */
  function formationSourceAnchorFor(targets: readonly ConsoleUnit[], dump: SpDump): string | null {
    const directKey = `dump:${hexLabel(dump.hex)}`
    const keySets = targets.map((unit) => fuelSourceKeysOfUnit(unit))
    const shared = (key: string): boolean => keySets.every((keys) => keys.has(key))
    if (shared(directKey)) return directKey
    for (const key of keySets[0]?.keys() ?? []) {
      if (!key.startsWith('hq:')) continue
      if (!shared(key)) continue
      const hq = units.value.find((unit) => `hq:${unit.instanceId}` === key)
      if (hq === undefined) continue
      const drawsThisDump = drawableDumpsAt(hq.hex, hq.side, toThrowHqView(hq).throwMobility).some(
        (candidate) => sameHex(candidate.hex, dump.hex),
      )
      if (drawsThisDump) return key
    }
    return null
  }

  /**
   * 12.5c-A（用户 2026-09-18 第 7 条）：编队法的**覆盖集**
   *
   * 「为一整个多单位编队支付 1SP，便可为整个多单位编队提供燃料补给」＋「检查每个单位使用了哪个指挥部
   *   或补给站进行补给的投递或拖取」⇒ 覆盖 = 该编队中**能从本次付款的来源取到**的全部单位：
   *   · 含**未被点选**的同编队单位（这就是用户要的"自动加油"）；
   *   · 含当前朝向为**徒步面**的摩托化单位 —— 12.5a 说的是"要消耗轮式/履带 MP 就得先付"，
   *     与它此刻哪一面朝上无关（日后转移动面开拔时油必须已经加好）；
   *   · **来源之外**的同编队单位**不覆盖**（12.5c-A 后半句 ⇒ 它们日后开拔按 12.5c-C 单独单位法付）。
   */
  function formationFuelCoverageSet(
    targets: readonly ConsoleUnit[],
    dump: SpDump,
  ): { sourceKey: string | null; covered: ConsoleUnit[]; leftOut: ConsoleUnit[] } {
    const formation = targets[0]?.formation ?? null
    if (formation === null) return { sourceKey: null, covered: [], leftOut: [] }
    const sourceKey = formationSourceAnchorFor(targets, dump)
    const members = units.value.filter(
      (unit) =>
        unit.side === targets[0]!.side &&
        formationFuelCovers({ unitFormation: unit.formation, fuelFormation: formation }),
    )
    if (sourceKey === null) return { sourceKey: null, covered: [], leftOut: members }
    const covered: ConsoleUnit[] = []
    const leftOut: ConsoleUnit[] = []
    for (const unit of members) {
      if (fuelSourceKeysOfUnit(unit).has(sourceKey)) covered.push(unit)
      else leftOut.push(unit)
    }
    return { sourceKey, covered, leftOut }
  }

  /**
   * 12.5：本次加油的**受益单位**（开拔的堆叠 > 已勾选的堆叠 > 选中的那一枚）
   *
   * 与 `payFuel` 取用同一份口径（那里用它算费用），这里用它算**可达性**——
   * 两处若各写一份「哪些单位要加油」，可达性就会与实际付款的单位集漂移。
   *
   * ★ B18b：把**取子清单**（`movePick`，6.1f）插在中间。原先只看 `moveUnits`（= 已经开始移动）
   *   与 `selectedUnit`（= 单一枚）：于是"整堆叠因缺燃料开拔失败"时，受益集只剩**一枚**，
   *   玩家得给同一堆叠付好几次油（12.5c-C 允许，但明显不是玩家想要的），
   *   A/B 两种"整编队/整指挥部"的方法更是无从谈起。
   */
  const fuelTargets = computed<ConsoleUnit[]>(() => {
    /*
     * ★ 用户 2026-11-10：加油唯一入口＝右键该单位/堆叠。
     *   右键某项时显式指定受注单位（`fuelSubjectId`），不再沿用"当前选中/取子清单"——
     *   否则堆叠窗里右键第二枚，仍会按取子清单给整组算钱。窗口关闭即清（见 `closeFuelNow`）。
     */
    const subjectId = fuelSubjectId.value
    if (subjectId !== null) {
      const subject = units.value.find((unit) => unit.instanceId === subjectId)
      if (subject !== undefined) return [subject]
    }
    const raw =
      moveUnits.value.length > 0
        ? moveUnits.value
        : (() => {
            const picked = movePick.value
            if (picked !== null && picked.ids.length > 0) {
              return picked.ids
                .map((id) => units.value.find((unit) => unit.instanceId === id))
                .filter((unit): unit is ConsoleUnit => unit !== undefined)
            }
            return selectedUnit.value === null ? [] : [selectedUnit.value]
          })()
    /*
     * #7（用户 2026-11-10）：编队聚合只做**展示**——受益单位按**单位唯一 id 去重**。
     * 同一枚算子不能因为同时出现在堆叠/编队的多行里被计价两次（12.5c-C：每单位 1T）
     * 或被打两次标记；覆盖集与扣费都只认实际枚数。
     */
    const seen = new Set<string>()
    return raw.filter((unit) => {
      if (seen.has(unit.instanceId)) return false
      seen.add(unit.instanceId)
      return true
    })
  })

  /**
   * 3.2f：该单位是不是**独立单位**（判据只有一处：引擎的 `isIndependentUnit`）
   *
   * 「任何既不属于多单位编队 (3.1c) 也不属于多军力单位 (3.2d) 的单位都是『独立单位』。
   *   这在**燃料补给 (12.5e)** 中很重要。」⇒ 编队归属（`formation`，**数据定死**）与印值军力两项都看。
   * 用户 2026-09-17 裁定：「编队单位肯定是定死的……**编队单位是无法利用 HQ 补给法的**」。
   */
  function isIndependentUnitOf(unit: ConsoleUnit): boolean {
    return isIndependentUnit({ formation: unit.formation, printedSteps: unit.printedSteps })
  }

  /**
   * B18b（12.5a）：本次要动的单位里**有人耗油且未加注** ⇒ 此刻该把「付燃料」摆到台面上
   *
   * 只算**当前方**的单位（选到敌方算子时不该弹出付油面板）；12.5a 说得很直白：
   * 轮式/履带**战斗单位**只要消耗 MP 就必须已付燃料，「即使就移动一格」——
   * 所以这条不是"补给阶段的准备工作"，而是**每一次开拔前的当场动作**（12.5c）。
   */
  const fuelPendingUnits = computed<ConsoleUnit[]>(() =>
    fuelTargets.value.filter(
      /*
       * 7.0a：反应段的行动者是**非阶段玩家**（`activeSide` 仍是阶段玩家）⇒ 这一句必须取
       * `actingSide`。修前取 `activeSide` ⇒ 反应段给己方预备队加油时永远不提示"该付燃料"，
       * 而 12.5a 又要求耗 MP 前必须已付 ⇒ 轮式/履带单位在 E 段直接动弹不得。
       */
      (unit) => unit.side === actingSide.value && needsFuelOf(unit) && !unit.fuelled,
    ),
  )

  /** 12.5c：此刻是否该显示「支付燃料」这一手（有未加注的耗油单位） */
  const fuelPaymentDue = computed<boolean>(() => fuelPendingUnits.value.length > 0)

  /**
   * 12.0：**受补给单位**的候选（只有战斗单位需要追溯补给）
   *
   * 12.0 的「重要提示」写得很明白：「只有战斗单位需要补给。非战斗单位、空军单位和海军战斗单位
   * **永远不会**消耗 SP，永远不需要追溯补给」。故这个清单**只列战斗单位**——
   * 修前面板列的是"当前方全部算子"，于是 SP、卡车、延补队、空军基地都能被选进来做补给检查，
   * 引擎只好逐个回一句「不需追溯补给」（12.0 的 `notRequired`），白费玩家一遍点击。
   * 判据用引擎的 `requiresTraceSupply`（唯一出处），不在这里写 `isCombat` 的同义判断。
   */
  const supplyCheckCandidates = computed<ConsoleUnit[]>(() =>
    units.value.filter(
      (unit) => unit.side === activeSide.value && requiresTraceSupply({ isCombat: unit.isCombat }),
    ),
  )

  /**
   * 12.5：可作燃料付款来源的补给站
   *
   * ★ 12.3a：燃料同样只能从**单位拖得到**的补给站取（5 MP 直拖或相邻；12.3c）。
   *   修前这里给的是「该方**全部**补给站」——于是可以在全图任意远处付款，
   *   与 12.4 战斗补给早已修好的同一条纪律不一致（那一侧有 `combatSupplyDumps` 筛可达性）。
   *   12.5c-A/B 要求受益单位**共用同一来源**，故取各受益单位都能拖到的**交集**。
   */
  /**
   * 12.5c：本次加油用**哪种方法**（玩家选择；界面在移动面板的燃料段）
   *
   * ★ B32：原先它是 `MovePanel.vue` 的**组件局部 ref** —— 而候选集（`fuelDumpChoices`）与
   *   校验/扣款（`payFuel`）都在 store，方法在组件里 ⇒ 候选没法按方法分派
   *   （HQ 法该用"**HQ 够得着**"的补给站，而不是"受益单位自己 5 MP 内够得着"的）。
   */
  const fuelMethod = ref<FuelMethod>('singleUnit')

  /**
   * 用户 2026-11-10：**加油唯一入口＝右键该单位/堆叠**
   *
   * 显式受注单位（null ＝ 沿用"已选/取子清单"的旧口径，仅供移动准备等内部路径）。
   * 右键菜单按 `fuelMethodsForUnitNow` 只列真正可用的方法；点选后 `openFuelNow` 落这个 id，
   * 会话框里的候选、付款、覆盖集全部走既有的 `fuelTargets → fuelDumpChoices → payFuel` 同一条链。
   */
  const fuelSubjectId = ref<string | null>(null)

  /**
   * 12.5c：三种加油法对**本次受益单位集**的可用性（用户 2026-09-17 的界面口径）
   *
   * 用户原话：「需要加油的单位点击时未加油都可以点**单独法**，**编队单位**有额外的**编队加油法**，
   *   点击 **HQ** 时才能加 **HQ 法**，因为 HQ 要移动本身也要按自身属性和规则来判断。」
   * 判据只有一处：引擎 `fuelMethodAvailability`（12.5c-A/B/C + 3.2f，本层只把盘面事实喂进去）。
   */
  const fuelMethodChoices = computed(() =>
    fuelMethodAvailability({
      targets: fuelTargets.value.map((unit) => ({
        isHq: isHqUnit(unit),
        formation: unit.formation,
        isIndependent: isIndependentUnitOf(unit),
      })),
    }),
  )

  /**
   * 专规 4.2c（可选）：本局是否启用「最省供油」
   *
   * 未启用 ⇒ 加油窗里**不出现**该选项（不是置灰）；启用后付 2T、受油单位 MA ×1/4、相位末摘标记。
   */
  const minimalFuelingOn = computed(() => session.rule4On('minimalFueling'))

  /**
   * 12.5c：**实际生效**的方法
   *
   * 选中的那一法对当前受益单位集不成立时退回**单独单位法**（12.5c-C：「**任何单位都可以使用此方法**」）
   * —— 这样"选了一法再去点别的单位"不会把玩家卡在一个点不动的按钮上。
   */
  const fuelMethodEffective = computed<FuelMethod>(() => {
    const chosen = fuelMethod.value
    const entry = fuelMethodChoices.value.find((item) => item.method === chosen)
    return entry !== undefined && entry.available ? chosen : 'singleUnit'
  })

  /**
   * 用户 2026-11-10：**右键菜单只列"这一枚此刻真正可用"的加油法**
   *
   * 判据复用与窗口同一条链，不另写一套：
   *   · 结构可用性 —— 引擎 `fuelMethodAvailability`（12.5c-A/B/C + 3.2f）；
   *   · 已付过的整编队/整指挥部 —— `formationFuelThrows` / `hqFuelThrows`（12.5c-A/B 一次付款、
   *     12.5e 每阶段一个投递位置）⇒ 不能再出现在菜单里，否则点了必被拒（#13 同源）。
   *
   * 来源可达性（12.3a）**不在这里判**：它是窗内"选哪座站/哪个 HQ"的一步；无来源时窗内如实显示
   * 「没有可达的补给来源」，付款按钮不可用，而不是把方法从菜单里抹掉。
   */
  function fuelMethodsForUnitNow(instanceId: string): FuelMethodAvailability[] {
    const unit = units.value.find((item) => item.instanceId === instanceId)
    // 7.0a：反应段由非阶段玩家行动 ⇒ 阵营判据取 `actingSide`（与 `payFuel` 同源）
    if (unit === undefined || unit.side !== actingSide.value) return []
    if (!needsFuelOf(unit) || unit.fuelled) return []
    if (!actionAllowedNow('supply.fuel')) return []
    const choices = fuelMethodAvailability({
      targets: [
        {
          isHq: isHqUnit(unit),
          formation: unit.formation,
          isIndependent: isIndependentUnitOf(unit),
        },
      ],
    })
    return choices.filter((choice) => {
      if (!choice.available) return false
      if (choice.method === 'formation') {
        return unit.formation !== null && formationFuelThrows.value[unit.formation] === undefined
      }
      if (choice.method === 'hq') return hqFuelThrows.value[unit.instanceId] === undefined
      return true
    })
  }

  /** 用户 2026-11-10：右键选中某一法 ⇒ 落受注单位与方法，打开加油会话（界面据此出 `fuel` 窗） */
  function openFuelNow(instanceId: string, method: FuelMethod): boolean {
    if (!fuelMethodsForUnitNow(instanceId).some((choice) => choice.method === method)) return false
    fuelSubjectId.value = instanceId
    fuelMethod.value = method
    fuelDumpId.value = null
    return true
  }

  /** 关闭加油会话：受注单位、来源、方法都回初始（不留一行"上次点什么"的残态） */
  function closeFuelNow(): void {
    fuelSubjectId.value = null
    fuelDumpId.value = null
    fuelMethod.value = 'singleUnit'
  }

  /** 12.5c 方法名（界面文案；与旧面板同一份表，术语不变） */
  function fuelMethodLabel(method: FuelMethod): string {
    return fuelMethodLabelOf(method)
  }

  /*
   * ★ B32 步骤 4：**已删** `fuelCommonSource`（玩家勾"来源共用"的那个复选框）——
   *   13.7a / 12.5c-A 要求按**盘面事实**算出"哪些单位共用同一来源"，而不是由玩家声明。
   *   现在这份划分由 `fuelSourcePartition` 给出（同源组 / 需单独付组）。
   */

  /**
   * 12.3a/12.3b：某单位**此刻能从哪些来源取到油**（键 → 一句人话）
   *
   * 键的两种形态：
   *   · `dump:<格号>` —— 它自己 5 MP 直拖或相邻（12.3a/12.3c，按**轮式 MP** 计）；
   *   · `hq:<实例id>` —— 某座指挥部先按 12.3a 拖到 SP（12.3b），再按印值投递距离投给它。
   *
   * ★ 唯一出处（I① 收口）：`fuelSourcePartition`（13.7a 的同源划分）与 12.5c-A 的**编队覆盖集**
   *   共用本函数 —— 修前这段判据只写在 `fuelSourcePartition` 里（且只对**已点选**的受益单位算），
   *   于是"编队的其余成员能不能从这次付款的来源取到"根本无从判断。
   */
  function fuelSourceKeysOfUnit(unit: ConsoleUnit): Map<string, string> {
    const side = unit.side
    const facts = supplyFacts.value
    const keys = new Map<string, string>()
    // 12.3a：它自己直拖得到的补给站
    for (const dump of drawableSpDumpsAt(unit.hex, side, undefined, unit)) {
      keys.set(`dump:${hexLabel(dump.hex)}`, `补给站 ${hexLabel(dump.hex)}（直接拖取，12.3a）`)
    }
    // 12.3b/12.5e：覆盖它的 HQ（先按 12.3a 拖到 SP，再按印值投递距离投给它）
    for (const hq of units.value.filter((item) => item.side === side && isHqUnit(item))) {
      const hqView = toThrowHqView(hq)
      const reach = countSupplyDistanceToUnitViaTable(facts, {
        from: hq.hex,
        unitHex: unit.hex,
        side,
        mobility: hqView.throwMobility,
        maxMp: hqView.throwRangeMp,
      })
      if (!reach.ok) continue
      if (hqView.throwRangeMp <= 0) continue
      const verdict = canThrowViaHQ({
        hqMode: hq.mode.mode,
        distanceMp: reach.mp,
        throwRangeMp: hqView.throwRangeMp,
        ...(hqView.receivedByThrow === undefined
          ? {}
          : { receivedByThrow: hqView.receivedByThrow }),
      })
      if (!verdict.ok) continue
      const drawable = drawableDumpsFor(facts, {
        hex: hq.hex,
        side,
        mobility: hqView.throwMobility,
      }).filter((dump) => dump.ok)
      if (drawable.length === 0) continue
      keys.set(
        `hq:${hq.instanceId}`,
        `指挥部投递 ${hq.name}（载 ${hexLabel(hq.hex)}，12.3b/12.5e）`,
      )
    }
    return keys
  }

  /**
   * 13.7a / 12.5c-A：本次加油的受益单位按**来源**分组（同源组 / 需单独付组）
   *
   * 「多单位编队中的战斗单位必须从**同一个指挥部或同一个直接拖取的补给来源**获得燃料补给；
   *   做不到时，编队的**一部分**用编队法，**其余**用单独单位法。」
   *
   * 每个单位的"可用来源"由引擎判（与候选集同一条实现）：
   *   · `dump:<格号>` —— 它自己 5 MP 直拖或相邻得到的补给站（12.3a/12.3c）；
   *   · `hq:<实例id>` —— 覆盖它的那座 HQ（12.3b 投递：HQ 拖得到 + 投递距离够，12.5e）。
   * 全体交集非空 ⇒ **同源**（`shared: true`，取交集里覆盖单位最多的那个来源）；
   * 交集为空 ⇒ **拆组**（`shared: false`）：能共用同一来源的最大一组走编队法，其余按 13.7a 单独付。
   */
  const fuelSourcePartition = computed<{
    shared: boolean
    /** 建议作为"编队法/ HQ 法"共用来源的那个键（无则 null） */
    commonKey: string | null
    /** 可共用该来源的单位（同源组） */
    commonUnitIds: readonly string[]
    /** 余下必须走**单独单位法**的单位（13.7a 后半句） */
    singleUnitIds: readonly string[]
    /** 每座来源的键 → 一句人话（给日志与界面用） */
    labels: Readonly<Record<string, string>>
  }>(() => {
    const targets = fuelTargets.value
    const empty = {
      shared: false,
      commonKey: null,
      commonUnitIds: [] as readonly string[],
      singleUnitIds: [] as readonly string[],
      labels: {} as Readonly<Record<string, string>>,
    }
    if (targets.length === 0) return empty
    const sides = new Set(targets.map((unit) => unit.side))
    if (sides.size !== 1) return empty

    const labels: Record<string, string> = {}
    const keysOf = new Map<string, Set<string>>()
    for (const unit of targets) {
      const keys = new Set<string>()
      for (const [key, label] of fuelSourceKeysOfUnit(unit)) {
        keys.add(key)
        labels[key] = label
      }
      keysOf.set(unit.instanceId, keys)
    }

    // 全体交集（用数组做：Set 在这个三元里会被 TS 窄化成 never）
    let common: string[] | null = null
    for (const keys of keysOf.values()) {
      const list = [...keys]
      common = common === null ? list : common.filter((key) => list.includes(key))
    }
    const shared = common !== null && common.length > 0

    // 覆盖单位数最多的来源（交集为空时用来挑"能共用的最大一组"）
    const coverage = new Map<string, string[]>()
    for (const unit of targets) {
      for (const key of keysOf.get(unit.instanceId) ?? []) {
        coverage.set(key, [...(coverage.get(key) ?? []), unit.instanceId])
      }
    }
    let bestKey: string | null = null
    for (const [key, ids] of coverage) {
      if (bestKey === null || ids.length > (coverage.get(bestKey)?.length ?? 0)) bestKey = key
    }
    const chosen = shared ? common![0]! : bestKey
    const commonUnitIds = chosen === null ? [] : (coverage.get(chosen) ?? [])
    const singleUnitIds = targets
      .map((unit) => unit.instanceId)
      .filter((id) => !commonUnitIds.includes(id))

    return {
      shared,
      commonKey: chosen,
      commonUnitIds,
      singleUnitIds,
      labels,
    }
  })

  const fuelDumpChoices = computed<SpDump[]>(() => {
    const targets = fuelTargets.value
    if (targets.length === 0) return []
    const sides = new Set(targets.map((unit) => unit.side))
    if (sides.size !== 1) return []
    const side = [...sides][0]!
    /*
     * ★ B32（12.5c-B / 12.5e）：**指挥部法**的候选是"**指挥部够得着**的补给站" ——
     *   HQ 先按 12.3a 拖取（5 MP 直拖或相邻，按其**投递移动类型**计数），再按**印刷投递距离**
     *   把补给投给受益单位；受益单位自己离补给站多远都不影响。
     *   修前一律按"受益单位自己 5 MP 直拖"取交集 ⇒ **只有 HQ 够得着的坦克群一分油也取不到**
     *   （用户报告 #1 的第一句：「移动阶段时未能正确从 HQ 获得燃油补给」）。
     *
     *   判据与 12.3b 的补给投递**同源**：`countSupplyDistanceToAny` 算 HQ 到每个受益单位的
     *   投递距离（取最远者；任一个够不到，这座 HQ 就作废），`canThrowViaHQ` 判该 HQ 此刻
     *   能不能投递（战术模式/是否由投递获得…），`drawableDumpsFor` 给 HQ 自己拖得到的补给站。
     */
    if (fuelMethod.value === 'hq') {
      const facts = supplyFacts.value
      const picked = new Map<string, SpDump>()
      /*
       * 12.5c-B / 12.5e（用户 2026-09-17 裁定）：HQ 法只覆盖「**指挥部自己** + 投递距离内的
       * **所有独立单位**（3.2f）」。**编队单位（3.1c）与多军力单位（3.2d）都不在覆盖内** ——
       * 它们要么走编队法（12.5c-A，整编队 1SP），要么走单独单位法（12.5c-C，每单位 1T；
       * 该条明写「无论它是独立单位、多军力单位，还是多单位编队中的单位」）。
       * 判据只有一处（引擎 `hqFuelCovers`）：受益单位要么**就是这台指挥部自己**，要么是独立单位；
       * 只要有一个不合格，这台 HQ 就不算覆盖（不给"半个 HQ 法"）。
       */
      for (const hq of units.value.filter((unit) => unit.side === side && isHqUnit(unit))) {
        const hqIneligible = targets.filter(
          (target) =>
            !hqFuelCovers({
              targetIsTheHq: target.instanceId === hq.instanceId,
              targetIsIndependent: isIndependentUnitOf(target),
            }),
        )
        if (hqIneligible.length > 0) continue
        const hqView = toThrowHqView(hq)
        let worstMp = 0
        let coversAll = true
        for (const target of targets) {
          const reach = countSupplyDistanceToUnitViaTable(facts, {
            from: hq.hex,
            unitHex: target.hex,
            side,
            mobility: hqView.throwMobility,
            maxMp: hqView.throwRangeMp,
          })
          if (!reach.ok) {
            coversAll = false
            break
          }
          worstMp = Math.max(worstMp, reach.mp)
        }
        if (!coversAll) continue
        const throwVerdict = canThrowViaHQ({
          hqMode: hq.mode.mode,
          distanceMp: worstMp,
          throwRangeMp: hqView.throwRangeMp,
          ...(hqView.receivedByThrow === undefined
            ? {}
            : { receivedByThrow: hqView.receivedByThrow }),
        })
        if (!throwVerdict.ok) continue
        const drawable = drawableDumpsFor(facts, {
          hex: hq.hex,
          side,
          mobility: hqView.throwMobility,
        })
        const keys = new Set(drawable.filter((dump) => dump.ok).map((dump) => hexLabel(dump.hex)))
        /*
         * 12.1b：「任何含 SP 的位置（未装载**或装在运输点数上**）都是补给站」⇒ 这里必须遍历
         * `allSpDumps`（账本条目 + 装载来源）。修前只遍历 `spDumps` ⇒ 坦克群唯一够得着的油
         * 若正装在编队卡车上，HQ 法**一分也取不到**（与单单位法那一支不一致）。
         */
        for (const dump of allSpDumps.value) {
          if (dump.side === side && keys.has(hexLabel(dump.hex))) picked.set(dump.id, dump)
        }
      }
      return [...picked.values()]
    }
    /*
     * 12.5c-A（用户 2026-11-07 报告「5.27 与 39 军 HQ 堆叠，够不到 15.25」）：
     * 编队法的来源是「每个单位使用了哪个指挥部或补给站进行补给的**投递或拖取**」——
     * 即**12.3a 直拖**与**12.3b HQ 投递**两种形态都算同源。修前这里只做直拖交集，
     * 于是"编队单位自己够不着、但同一 HQ 投递够得着"的盘面（剧本 1 的 7 Pz Div @ 15.25）
     * 候选为空：`fuelSourcePartition` 已算出同源键 `hq:<39 军>`，界面却无站可选。
     * `deliverableDumpsFor` 的 ① 直拖支（全体交集）＋② HQ 投递支（HQ 拖得到且覆盖全体）
     * 正是"同一来源"的两种形态，与付款时 `formationSourceAnchorFor` 的口径同源。
     */
    if (fuelMethod.value === 'formation') {
      return deliverableDumpsFor(side, targets)
    }
    let common: SpDump[] | null = null
    for (const unit of targets) {
      const drawable = new Set(
        drawableSpDumpsAt(unit.hex, side, undefined, unit).map((dump) => dump.id),
      )
      common =
        common === null
          ? allSpDumps.value.filter((dump) => drawable.has(dump.id))
          : common.filter((dump) => drawable.has(dump.id))
    }
    return common ?? []
  })

  /** 12.5：点选的燃料付款补给站（未选或该站已不存在 ⇒ null） */
  const fuelDump = computed<SpDump | null>(
    // 12.1b（B32 步骤 5）：来源可能是**装载在运输点数上的 SP** ⇒ 已选条目也要从 allSpDumps 里找
    () => allSpDumps.value.find((dump) => dump.id === fuelDumpId.value) ?? null,
  )

  /** 12.5c：本次加油的 T 需求（编队/指挥部法 1SP，单单位法每单位 1T）——「可选补给源」角标用 */
  const fuelPayNeedT = computed<number>(() =>
    fuelMethod.value === 'singleUnit' ? fuelTargets.value.length : SP_TO_T,
  )

  /**
   * 12.5c-A（I①）：**编队法的覆盖预览**（界面在付款前如实说明"这一付会覆盖谁"）
   *
   * 用户 2026-09-18 第 7 条要的正是"点一枚编队单位付编队法 ⇒ 同编队、在本来源范围内的其余单位
   * 也一并加注；范围外的同编队单位不参与"。故这里把同一处判据（`formationFuelCoverageSet`）
   * 的结论摊给界面：`coveredIds`（将被覆盖）/ `leftOutIds`（不参与，日后要单独付）。
   */
  const fuelFormationCoverage = computed<{
    formation: string
    sourceKey: string | null
    sourceLabel: string
    coveredIds: readonly string[]
    leftOutIds: readonly string[]
  } | null>(() => {
    if (fuelMethod.value !== 'formation') return null
    const dump = fuelDump.value
    const targets = fuelTargets.value
    if (dump === null || targets.length === 0) return null
    const formation = targets[0]?.formation ?? null
    if (formation === null) return null
    const { sourceKey, covered, leftOut } = formationFuelCoverageSet(targets, dump)
    return {
      formation,
      sourceKey,
      sourceLabel:
        sourceKey === null
          ? '（未定：本来源既不是这些单位的直接拖取站，也不是某座拖得到它的指挥部的投递范围）'
          : (fuelSourceKeysOfUnit(targets[0]!).get(sourceKey) ?? '（未定）'),
      coveredIds: covered.map((unit) => unit.instanceId),
      leftOutIds: leftOut
        .filter((unit) => !covered.some((item) => item.instanceId === unit.instanceId))
        .map((unit) => unit.instanceId),
    }
  })

  /** 12.5：声明燃料的付款来源（12.3a：只能来自**受益方自己**的补给站——见 `payFuel` 的校验） */
  function pickFuelDump(dumpId: string | null): boolean {
    if (dumpId === null) {
      fuelDumpId.value = null
      return true
    }
    // 12.1b（B32 步骤 5）：来源也可能是**装载在运输点数上的 SP**（id 前缀 "unit:"）
    const dump = allSpDumps.value.find((item) => item.id === dumpId)
    if (dump === undefined) {
      pushLog('warning', `找不到补给来源 ${dumpId}（12.1b）`, '12.1b')
      return false
    }
    fuelDumpId.value = dumpId
    pushLog(
      'info',
      `燃料付款来源：${hexLabel(dump.hex)}${dump.carriedBy === undefined ? '' : '（装载在运输点数上，12.1b）'}（${dump.side === 'axis' ? '轴' : '苏'}｜${dump.sp} SP + ${dump.t} T = ${holdingsToT({ sp: dump.sp, t: dump.t })} T）`,
      '12.5',
    )
    return true
  }

  /**
   * C5：演示用补给池（SP / T）
   *
   * ★ **12.3a 之后已无任何付款路径使用它**（战斗补给、燃料、轰炸、建造都改从声明的补给站扣）。
   *   保留它只为两件事：① 骨架界面的历史显示；② 回归用例里「共用池不得充作任何来源」的锚点。
   *   新增付款请一律走「声明补给站 → `planSpPayment`」，不要往这里写。
   */
  function setFuelPool(sp: number, t: number): void {
    fuelPool.value = { sp: Math.max(0, sp), t: Math.max(0, t) }
  }

  /** C5：直接改某单位的燃料状态（便于制造「未加注」情形，12.5a） */
  function setUnitFuelled(instanceId: string, fuelled: boolean): void {
    /*
     * 12.5c「在发生燃料消耗的**任何阶段**，单位都应在燃料消耗时支付」⇒ 加注标记与付燃料
     * 同一道闸（C/E/G 的移动环节）。修前 `payFuel` 过闸、这个开关不过 ⇒ 可以在任何环节
     * 把单位标成"已加注"从而绕开付款。
     */
    if (!requireAction('supply.fuel', '加注燃料')) return
    const unit = units.value.find((item) => item.instanceId === instanceId)
    if (unit === undefined) return
    unit.fuelled = fuelled
    // 12.5c：本开关不按规则记账（`null` ⇒ 视为持续到本方清理阶段，与既有行为一致）；
    // 要精确控制持续期（单单位法只本阶段）请用「付燃料」走 payFuel
    unit.fuelMethod = null
    pushLog('info', `${unit.name} → ${fuelled ? '已加注燃料' : '未加注燃料'}（12.5a）`, '12.5a')
    retryBeginMove()
  }

  return {
    payFuel,
    fuelDumpId,
    hqFuelThrows,
    formationFuelThrows,
    applyFormationFuelCoverage,
    applyFormationFuelCoverageToIds,
    hqFuelCoverageSet,
    hqFuelThrowOriginOf,
    formationFuelThrowOf,
    formationSourceAnchorFor,
    formationFuelCoverageSet,
    fuelTargets,
    isIndependentUnitOf,
    fuelPendingUnits,
    fuelPaymentDue,
    supplyCheckCandidates,
    fuelMethod,
    fuelSubjectId,
    fuelMethodChoices,
    minimalFuelingOn,
    fuelMethodEffective,
    fuelMethodsForUnitNow,
    openFuelNow,
    closeFuelNow,
    fuelMethodLabel,
    fuelSourceKeysOfUnit,
    fuelSourcePartition,
    fuelDumpChoices,
    fuelDump,
    fuelPayNeedT,
    fuelFormationCoverage,
    pickFuelDump,
    setFuelPool,
    setUnitFuelled,
  }
}
