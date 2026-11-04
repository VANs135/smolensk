import { computed, ref } from 'vue'
import type { Side } from '@/data'
import {
  holdingsToT,
  planSupplyPhase,
  planInternalStocksRecovery,
  resolveAttrition,
  validateAttritionAllocation,
  type FeedingSourceFacts,
  type SupplyPhasePlan,
  type TraceSupplyFacts,
} from '@/engine/rules'
import {
  attritionDutiesFor,
  automaticAttritionAllocation,
  supplyPhaseFeedingCostT,
} from '@/engine/rules/supply-phase'
import { nextSupplyPhaseObligation } from '@/engine/rules/supply-phase-progress'
import type { AttritionResult } from '@/engine/tables/attrition'
import type { ActionKey, ConsoleUnit } from './workbench-model'
import type { SpDump } from './supply-types'

export interface SupplyPhasePorts {
  units(): ConsoleUnit[]
  activeSide(): Side
  facts(): TraceSupplyFacts
  step(): string | undefined
  enterCheck(): boolean
  requireAction(key: ActionKey, label: string): boolean
  actionAllowedNow(key: ActionKey): boolean
  deliverableDumpsFor(side: Side, units: readonly ConsoleUnit[]): SpDump[]
  /**
   * 12.6c / 12.3a·b：逐单位的付款来源事实（按 unit id），由工作台按真实可达补给站构建。
   * 缺省＝不分组，保持「全阶段一批」的既有口径（独立域用例与旧存档不受影响）。
   */
  feedingSources?(): Readonly<Record<string, FeedingSourceFacts>>
  payFromSideDumps(amount: number, allowed?: readonly SpDump[]): string | null
  payFromUnitReachableDumps(unit: ConsoleUnit, amount: number): string | null
  markTraceSupply(id: string, ready: boolean): void
  markSustainedBySpecialSupply(ids: readonly string[]): void
  refreshTraceSupply(reason: string): number
  eliminateEntry(unit: ConsoleUnit, rule: string, detail: string, refresh?: boolean): void
  pushLog(kind: 'info' | 'success' | 'warning' | 'danger', text: string, rule?: string): void
  recordSettlement(entry: { action: string; rule: string; data: Record<string, unknown> }): boolean
  rollDice(): number
}

/** D段的状态与操作单独持有；地图、骰源、付款及淘汰只经显式端口访问。 */
export function createSupplyPhaseDomain(ports: SupplyPhasePorts) {
  const units = computed(ports.units),
    activeSide = computed(ports.activeSide),
    supplyFacts = computed(ports.facts)
  const {
    requireAction,
    actionAllowedNow,
    deliverableDumpsFor,
    payFromSideDumps,
    payFromUnitReachableDumps,
    markTraceSupply,
    markSustainedBySpecialSupply,
    refreshTraceSupply,
    eliminateEntry,
    pushLog,
    recordSettlement,
  } = ports
  const supplyPhasePlan = ref<SupplyPhasePlan | null>(null)
  const supplyRecoverySettled = ref(false)
  const supplyFeedingSettled = ref(false)
  const attritionAppliedHexes = ref<string[]>([])
  /** 载入计划时的错误（统一形状：rule + reason） */
  const supplyPhaseError = ref<{ rule: string; reason: string } | null>(null)
  /**
   * D 段输入：本阶段可用于「恢复 + 吃图上补给」的 T 与逐单位的"自愿吃图上补给"选择
   *
   * 可用 T 由玩家声明，但**上限是己方补给站的实有量**（12.3a/12.3b 是仅有的两条取补途径，
   * 不存在凭空可用的池子）；落盘时逐站扣减，扣不动即整笔拒绝。
   */
  const supplyPhaseInputs = ref<{ availableT: number; eatOffTheMap: Record<string, boolean> }>({
    availableT: 0,
    eatOffTheMap: {},
  })
  /** 12.8b：逐格保存骰面与玩家损失分配，等待选择时不得重掷。 */
  const attritionInputs = ref<Record<string, { die: number; allocation: Record<string, number> }>>(
    {},
  )
  /** 12.8b：逐格已掷出的损耗结果（供界面显示与分摊校验） */
  const attritionResults = ref<
    Record<
      string,
      { die: number; modifiedDice: number; drm: number; raw: string; losses: AttritionResult }
    >
  >({})

  /** 12.10e-B / 12.0：付款对象为待恢复储备或自愿吃图上补给的战斗单位。 */
  const supplyPhaseParticipants = computed<ConsoleUnit[]>(() =>
    units.value.filter(
      (unit) =>
        unit.side === activeSide.value &&
        unit.isCombat &&
        (unit.internalStocks !== null ||
          supplyPhaseInputs.value.eatOffTheMap[unit.instanceId] === true),
    ),
  )

  /**
   * 当前方在本阶段**可用于恢复与喂食的补给站**（＝各参与者**可达站**的**并集**）
   *
   * 可达＝12.3a 直接拖取（5 MP 内或相邻）∪ 12.3b 指挥部投递（`deliverableDumpsFor` 的唯一实现）。
   *
   * ★ 第五批批 B 切片 3：修前这里是"己方**全部**补给站"（全边池）⇒ 池里含千里之外的站、
   *   `payFromSideDumps` 又按站序从全边扣 ⇒ SP 隔空转移；现在池只含"够得着参与者"的站，
   *   且落盘改为**逐单位**从其各自的可达站付款（见 `payFromUnitReachableDumps`）。
   */
  const supplyPhasePayableDumps = computed<SpDump[]>(() => {
    const seen = new Map<string, SpDump>()
    for (const unit of supplyPhaseParticipants.value) {
      for (const dump of deliverableDumpsFor(unit.side, [unit])) seen.set(dump.id, dump)
    }
    return [...seen.values()]
  })

  /** 当前方在本阶段**可用于恢复与喂食的 T 上限**（＝付款对象可达站并集的 T 折算合计） */
  const supplyPhaseAvailableCap = computed<number>(() =>
    supplyPhasePayableDumps.value.reduce(
      (sum, dump) => sum + holdingsToT({ sp: dump.sp, t: dump.t }),
      0,
    ),
  )

  function planSupplyPhaseNow(): boolean {
    if (!actionAllowedNow('supply.draw') && !requireAction('supply.recovery', '补给阶段总计划'))
      return false
    // 已执行供养的计划也是待决损耗账本，不能被草稿重算覆盖。
    if (supplyFeedingSettled.value && supplyPhasePlan.value !== null) return true
    const side = activeSide.value
    const mine = units.value.filter((unit) => unit.side === side)
    const outcome = planSupplyPhase(supplyFacts.value, {
      activeSide: side,
      recoverySettled: supplyRecoverySettled.value,
      // 12.6c：来源事实由工作台按真实可达站给出；引擎只按它分组算费，不自行猜来源。
      ...(ports.feedingSources === undefined ? {} : { feedingSources: ports.feedingSources() }),
      units: mine.map((unit) => ({
        id: unit.instanceId,
        side: unit.side,
        hex: unit.hex,
        isCombat: unit.isCombat,
        steps: unit.steps,
        re: unit.re,
        ar: unit.raw.ar,
        mode: unit.mode.mode,
        internalStocks: unit.internalStocks,
        outOfSupply: !unit.hasTraceSupply,
        multiStep: unit.steps > 1,
      })),
      mobility: 'truck',
      /*
       * 12.10e-A：恢复**强制**且优先级最高（「各单位必须尽可能地恢复部队储备，与将 SP 用于追溯
       * 补给的替代相比，将 SP 用于恢复部队储备的优先级更高」）⇒ 未声明（0）时按**己方补给站
       * 的全部实有量**给额；声明正数则取它与实有量的较小值（模拟"某些站本阶段不可得"）。
       */
      availableT:
        supplyPhaseInputs.value.availableT > 0
          ? Math.min(supplyPhaseInputs.value.availableT, supplyPhaseAvailableCap.value)
          : supplyPhaseAvailableCap.value,
      // 12.6c 游戏说明：吃图上补给**永不强迫** ⇒ 逐单位的自愿选择
      eatOffTheMap: (unitId) => supplyPhaseInputs.value.eatOffTheMap[unitId] === true,
      // 12.10e-B：「只要是低下或耗尽单位**可拖取，或可投递 SP 至这些单位**的补给站，均需要按规则去恢复」
      // ⇒ 两半都算（第五批批 B 切片 3 起；修前只判直拖）。编内卡车上的 SP 例外由
      // `deliverableDumpsFor` 的 13.2g-B 资格校验承担。
      canDraw: (unitId) => {
        const unit = mine.find((item) => item.instanceId === unitId)
        if (unit === undefined) return false
        return deliverableDumpsFor(side, [unit]).length > 0
      },
    })
    supplyPhasePlan.value = outcome
    supplyPhaseError.value = null
    pushLog('info', `D 段补给阶段总计划（12.1–12.2）：${outcome.detail}`, '12.10e/12.6/12.8')
    return true
  }

  function clearSupplyPhasePlan(): void {
    if (supplyFeedingSettled.value) {
      pushLog('warning', '本阶段供养已结算，损耗义务结清前保留原计划', '12.8b')
      return
    }
    supplyPhasePlan.value = null
    supplyPhaseError.value = null
  }

  function applySupplyPhaseRecoveryNow(): boolean {
    // 12.10e：恢复部队储备是 D 段**第一环**（H④ 起）——12.10e-A 的优先次序由此强制：
    // 「将 SP 用于恢复部队储备的优先级更高」⇒ 这一手在第二环（补给检定）里做不出来
    if (!requireAction('supply.recovery', '恢复部队储备')) return false
    if (supplyRecoverySettled.value) return true
    const plan = supplyPhasePlan.value
    if (plan === null) {
      pushLog('warning', '先载入 D 段补给阶段总计划（12.1–12.2）', '12.10e')
      return false
    }
    const recovery = plan.internalStocks
    /*
     * 12.10e-C：「如果现有一些 SP，但**不足以完全恢复**内部储备，则需要**消耗现有的全部补给**。
     *   只有一个 T，则将直接被浪费掉」——故**不能**因为"没恢复成任何单位"就跳过付款：
     *   `spentT > 0` 时那点补给照样要扣（它就是被浪费掉的那部分）。
     *
     * ★ 第五批批 B 切片 3（12.10e/12.3a·b）：付款只走**可达站** ——「可通过直接拖取或从指挥部投递」
     *   ⇒ 池＝参与者可达站的并集（`supplyPhasePayableDumps`）；充足时**逐单位**从其**各自**的可达站
     *   付款（`payFromUnitReachableDumps`）。修前从**全边**站序扣 ⇒ SP 隔空转移。
     */
    if (recovery.recoveries.length === 0 && recovery.spentT <= 0) {
      supplyRecoverySettled.value = true
      pushLog('info', '12.10e：本阶段没有需要恢复的部队储备（也没有可消耗的补给）', '12.10e')
      return true
    }
    // 逐单位从**各自的可达站**付款（同站被多单位共享时按序花，付不出者降级并如实登记）
    supplyRecoverySettled.value = true
    const appliedIds: string[] = []
    const degradedIds: string[] = []
    const stations: string[] = []
    let actualSpentT = 0
    for (const item of recovery.recoveries) {
      const unit = units.value.find((entry) => entry.instanceId === item.unitId)
      if (unit === undefined) {
        degradedIds.push(item.unitId)
        continue
      }
      const paid = payFromUnitReachableDumps(unit, item.costT)
      if (paid === null) {
        // 12.10e-C：付不出完全恢复 ⇒ 花光该单位可达站的余额（现值），然后如实降级
        const ownT = deliverableDumpsFor(unit.side, [unit]).reduce(
          (sum, dump) => sum + holdingsToT({ sp: dump.sp, t: dump.t }),
          0,
        )
        const partial = planInternalStocksRecovery({
          units: [
            {
              id: unit.instanceId,
              level: item.from,
              reSize: unit.re,
              multiStep: unit.steps > 1,
              canDraw: true,
            },
          ],
          availableT: Math.min(ownT, item.costT),
        })
        const partialPaid = payFromUnitReachableDumps(unit, partial.spentT)
        if (partialPaid !== null) {
          actualSpentT += partial.spentT
          if (partialPaid !== '（无需付款）') stations.push(partialPaid)
          const restored = partial.recoveries[0]
          if (restored !== undefined) {
            unit.internalStocks = restored.to === 'ready' ? null : 'low'
            appliedIds.push(item.unitId)
          }
        }
        degradedIds.push(item.unitId)
        continue
      }
      unit.internalStocks = item.to === 'ready' ? null : 'low'
      appliedIds.push(item.unitId)
      actualSpentT += item.costT
      if (paid !== '（无需付款）') stations.push(paid)
    }
    // 12.10e-C：先落实付得起的恢复，再消耗计划中应浪费的余额。
    // 各自可达站的不足分支可能已用完余额，不能据旧计划再次扣款。
    if (recovery.wastedT > 0) {
      const available = supplyPhasePayableDumps.value.reduce(
        (sum, dump) => sum + holdingsToT(dump),
        0,
      )
      const waste = Math.min(recovery.wastedT, available)
      if (waste > 0 && payFromSideDumps(waste, supplyPhasePayableDumps.value) !== null)
        actualSpentT += waste
    }
    // 12.8e 括注：12.10e 部队储备恢复也是"特殊续命" ⇒ 本回合不算被切断的第一回合
    markSustainedBySpecialSupply(appliedIds)
    pushLog(
      'success',
      `12.10e 部队储备恢复：${appliedIds.length} 个单位（${recovery.recoveries
        .filter((item) => appliedIds.includes(item.unitId))
        .map(
          (item) =>
            `${item.unitId} ${item.from}→${units.value.find((unit) => unit.instanceId === item.unitId)?.internalStocks ?? 'ready'}`,
        )
        .join('、')}）；实际消耗 ${actualSpentT} T` +
        (recovery.unmet.length > 0 ? `；仍未恢复 ${recovery.unmet.length} 个` : '') +
        (degradedIds.length > 0
          ? `；另有 ${degradedIds.length} 个因**各自的可达站**不足重新核算（恢复或浪费按实际付款落实）`
          : '') +
        `；付款站 ${stations.join('、') || '（无）'}`,
      '12.10e',
    )
    return true
  }

  function applySupplyPhaseFeedingNow(): boolean {
    if (!requireAction('supply.draw', '吃图上补给')) return false
    if (supplyFeedingSettled.value) return true
    const plan = supplyPhasePlan.value
    if (plan === null) {
      pushLog('warning', '先载入 D 段补给阶段总计划（12.1–12.2）', '12.6c')
      return false
    }
    supplyFeedingSettled.value = true
    const fed = plan.feeding.filter((item) => item.affordable)
    const skipped = plan.feeding.length - fed.length
    // ★ 第五批批 B 切片 3（12.6c × 12.3a·b）：**逐单位**从其**各自的可达站**付款
    //   （喂食的 T「直接拖取和指挥部投递均可用于追溯补给的接收与分配」）；修前从全边站序扣。
    //   同一站被多单位共享、先行单位花光后付不出者 ⇒ 落盘降级（不喂、仍置断补标），如实登记。
    const appliedIds: string[] = []
    const degradedIds: string[] = []
    const stations: string[] = []
    let totalT = 0
    // 12.6c：额度属于「付过款的那一组补给站」。计划带来源组时按组累计已成功供养的 RE，
    // 不同来源不互相借用零头；旧计划（无 sourceKey，如旧存档）沿用全阶段一批的既有口径。
    const fedReBySource = new Map<string, number>()
    let globalFedRe = 0
    for (const item of fed) {
      const unit = units.value.find((entry) => entry.instanceId === item.unitId)
      if (unit === undefined) {
        degradedIds.push(item.unitId)
        continue
      }
      const grouped = item.sourceKey !== undefined
      const groupKey = item.sourceKey ?? ''
      // 12.6c：失败单位不占已付费额度，不能沿用原计划中依赖它的零追加费用。
      const costT = supplyPhaseFeedingCostT(
        grouped ? (fedReBySource.get(groupKey) ?? 0) : globalFedRe,
        unit.re,
      )
      const paid = payFromUnitReachableDumps(unit, costT)
      if (paid === null) {
        degradedIds.push(item.unitId)
        continue
      }
      if (grouped) fedReBySource.set(groupKey, (fedReBySource.get(groupKey) ?? 0) + unit.re)
      else globalFedRe += unit.re
      totalT += costT
      appliedIds.push(item.unitId)
      if (paid !== '（无需付款）') stations.push(paid)
    }

    // 12.6d：恢复者摘标、新断补者置标（单一写入点）
    for (const unitId of plan.outOfSupply.clear) markTraceSupply(unitId, true)
    for (const unitId of plan.outOfSupply.mark) markTraceSupply(unitId, false)
    // 落盘降级者（计划说付得起、自己的可达站却付不出）⇒ 仍置断补标（如实登记）
    for (const unitId of degradedIds) markTraceSupply(unitId, false)
    // 12.8e 括注：被喂饱者属"靠吃图上补给续命" ⇒ 本回合不算被切断的第一回合
    markSustainedBySpecialSupply(appliedIds)

    // 付款可能因各单位可达站不足而降级；损耗必须消费实际落盘结果。
    plan.attritionDuty = attritionDutiesFor(
      units.value
        .filter((unit) => unit.side === activeSide.value)
        .map((unit) => ({
          id: unit.instanceId,
          hex: unit.hex,
          isCombat: unit.isCombat,
          steps: unit.steps,
          ar: unit.raw.ar,
          mode: unit.mode.mode,
          outOfSupply: !unit.hasTraceSupply,
        })),
    )

    pushLog(
      'success',
      `12.6c/12.6d 补给阶段落盘：喂食 ${appliedIds.length} 个单位（共 ${totalT} T，付款站 ${
        stations.join('、') || '（无）'
      }）` +
        (skipped > 0 ? `；另有 ${skipped} 个单位因 T 不足未喂` : '') +
        (degradedIds.length > 0
          ? `；另有 ${degradedIds.length} 个因各自的可达站不足未喂（降级置断补）`
          : '') +
        `；断补 置 ${plan.outOfSupply.mark.length + degradedIds.length} / 除 ${plan.outOfSupply.clear.length}`,
      '12.6c',
    )
    return true
  }

  function attritionInputOf(key: string): { die: number; allocation: Record<string, number> } {
    return attritionInputs.value[key] ?? { die: 7, allocation: {} }
  }

  function setAttritionDie(hexKey: string, die: number): void {
    attritionInputs.value = {
      ...attritionInputs.value,
      [hexKey]: { ...attritionInputOf(hexKey), die: Math.min(12, Math.max(2, Math.trunc(die))) },
    }
  }

  function setAttritionAllocation(hexKey: string, unitId: string, steps: number): void {
    const current = attritionInputOf(hexKey)
    attritionInputs.value = {
      ...attritionInputs.value,
      [hexKey]: {
        ...current,
        allocation: { ...current.allocation, [unitId]: Math.max(0, Math.trunc(steps)) },
      },
    }
  }

  function rollAttritionNow(hexKey: string, die?: number): boolean {
    // 12.8 的损耗属 **D 补给段**（12.10e-A 的顺序把损耗放在补给阶段里）
    if (!requireAction('supply.attrition', '掷损耗')) return false
    if (attritionResults.value[hexKey] !== undefined) return true
    const duty = supplyPhasePlan.value?.attritionDuty.find(
      (item) => `${item.hex.col}.${item.hex.row}` === hexKey,
    )
    if (duty === undefined) {
      pushLog('warning', `${hexKey} 不在本阶段需掷损耗的格之列（12.8a/b）`, '12.8b')
      return false
    }
    // B28：缺省即现掷 2d6（与其它掷骰同一套：走 rng 并按掷骰计数）
    let rolledDie = die ?? 0
    if (die === undefined) {
      rolledDie = ports.rollDice()
    }
    const outcome = resolveAttrition({
      die: rolledDie,
      bestAr: duty.bestAr,
      oosSteps: duty.oosSteps,
    })
    attritionResults.value = { ...attritionResults.value, [hexKey]: { die: rolledDie, ...outcome } }
    recordSettlement({
      action: 'attritionRoll',
      rule: '12.8b',
      data: {
        hexKey,
        die: rolledDie,
        bestAr: duty.bestAr,
        oosSteps: duty.oosSteps,
        result: outcome.raw,
      },
    })
    pushLog(
      'info',
      `12.8b 损耗判定 ${hexKey}：2 骰 ${rolledDie}${outcome.drm > 0 ? ` + ${outcome.drm}（断补军力 ≥5）` : ''}` +
        ` = ${outcome.modifiedDice} ⇒ ${outcome.raw}（取列 AR ${duty.bestAr}，断补 ${duty.oosSteps} 军力）`,
      '12.8b',
    )
    return true
  }

  function applyAttritionNow(hexKey: string): boolean {
    if (!requireAction('supply.attrition', '损耗分配')) return false
    if (attritionAppliedHexes.value.includes(hexKey)) return true
    const duty = supplyPhasePlan.value?.attritionDuty.find(
      (item) => `${item.hex.col}.${item.hex.row}` === hexKey,
    )
    if (duty === undefined) {
      pushLog('warning', `${hexKey} 不在本阶段需掷损耗的格之列（12.8a/b）`, '12.8b')
      return false
    }
    const rolled = attritionResults.value[hexKey]
    if (rolled === undefined) {
      pushLog('warning', `先掷 ${hexKey} 的损耗骰（12.8b）`, '12.8b')
      return false
    }
    // 12.8b：可分摊的只有**该格的断补单位**，且以**现有军力**为上限
    const present = duty.unitIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
    const required = rolled.losses.kind === 'allSteps' ? ('all' as const) : rolled.losses.steps
    const allocation = attritionInputOf(hexKey).allocation
    const verdict = validateAttritionAllocation({
      required,
      units: present.map((unit) => ({ id: unit.instanceId, steps: unit.steps })),
      allocation,
    })
    if (!verdict.ok) {
      pushLog('warning', `12.8b 分摊被拒：${verdict.detail}（${verdict.rule}）`, verdict.rule)
      return false
    }
    attritionAppliedHexes.value = [...attritionAppliedHexes.value, hexKey]
    for (const unit of present) {
      const loss = allocation[unit.instanceId] ?? 0
      if (loss > 0) unit.steps -= loss
    }
    for (const unit of present)
      if (unit.steps <= 0)
        eliminateEntry(unit, '12.8b', `${unit.name} 损耗归零，移入死亡堆（12.8b）`, false)
    pushLog('success', `12.8b 损耗落盘 ${hexKey}：${verdict.detail}`, '12.8b')
    // 战损即变动盘面：补给网可能因此变化（HQ/延补队被消灭）
    if (
      supplyPhasePlan.value?.attritionDuty.every((item) =>
        attritionAppliedHexes.value.includes(`${item.hex.col}.${item.hex.row}`),
      )
    ) {
      refreshTraceSupply('12.8b 本阶段损耗全部结清')
    }
    return true
  }

  function reset(): void {
    supplyPhasePlan.value = null
    supplyPhaseError.value = null
    supplyRecoverySettled.value = false
    supplyFeedingSettled.value = false
    attritionInputs.value = {}
    attritionResults.value = {}
    attritionAppliedHexes.value = []
  }
  function settleForExit(wholePhase = false): boolean {
    for (;;) {
      const pending =
        supplyPhasePlan.value?.attritionDuty.filter(
          (duty) => !attritionAppliedHexes.value.includes(`${duty.hex.col}.${duty.hex.row}`),
        ) ?? []
      const obligation = nextSupplyPhaseObligation({
        step: ports.step(),
        wholePhase,
        recoverySettled: supplyRecoverySettled.value,
        feedingSettled: supplyFeedingSettled.value,
        pendingAttrition: pending.map((duty) => `${duty.hex.col}.${duty.hex.row}`),
      })
      if (obligation.kind === 'complete') return true
      if (obligation.kind === 'recovery') {
        if (!planSupplyPhaseNow() || !applySupplyPhaseRecoveryNow()) return false
      } else if (obligation.kind === 'enterCheck') {
        if (!ports.enterCheck() || ports.step() !== 'supply.check') return false
      } else if (obligation.kind === 'feeding') {
        if (!planSupplyPhaseNow() || !applySupplyPhaseFeedingNow()) return false
      } else {
        const key = obligation.hexKey,
          duty = pending[0]!
        if (!rollAttritionNow(key)) return false
        const losses = attritionResults.value[key]!.losses
        const present = duty.unitIds.flatMap((id) => {
          const unit = units.value.find((item) => item.instanceId === id)
          return unit ? [{ id, steps: unit.steps }] : []
        })
        const automatic = automaticAttritionAllocation(
          losses.kind === 'allSteps' ? 'all' : losses.steps,
          present,
        )
        if (automatic === null) {
          pushLog('warning', `${key} 的损耗尚未分配，请在补给面板确认损失`, '12.8b')
          return false
        }
        for (const [id, steps] of Object.entries(automatic)) setAttritionAllocation(key, id, steps)
        if (!applyAttritionNow(key)) return false
      }
    }
  }
  return {
    supplyPhasePlan,
    supplyRecoverySettled,
    supplyFeedingSettled,
    attritionAppliedHexes,
    supplyPhaseError,
    supplyPhaseInputs,
    attritionInputs,
    attritionResults,
    supplyPhaseAvailableCap,
    reset,
    settleForExit,
    planSupplyPhaseNow,
    clearSupplyPhasePlan,
    applySupplyPhaseRecoveryNow,
    applySupplyPhaseFeedingNow,
    setAttritionDie,
    setAttritionAllocation,
    rollAttritionNow,
    applyAttritionNow,
  }
}
