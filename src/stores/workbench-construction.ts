/**
 * workbench-construction.ts —— 13.8d 施工前提与付款（15.3 / 15.2A / 16.0b 共用）
 *
 * B3-2b16（2026-11-21）：搬出 13 个声明 / 176 行声明区（两段不连续，中间隔着
 * 「空中设施事实」族）：`constructionLedgers` / `constructionLedgerOf` / `constructionError` /
 * `constructionPayDumps` / `constructionPayPick` / `toggleConstructionPayPick` /
 * `pickConstructionPayDumpNow` / `constructionLegRangeTo` / `engineerExecutorFor` /
 * `constructionGateNow` / `noteConstruction` / `constructionFeeT` / `payConstructionFee`。
 * 函数体**零改写**。
 *
 * ## `constructionInputs` 为什么留在 facade
 *   它是本段的玩家输入 ref，但 B27a 的 `beginAirBaseHexPickNow`（点地图写 `hexText`）在声明区
 *   **之前**就引用它。按 b12 的"早读者"结论，const 不能留原位（原位在后 ⇒ 早读点落在 TDZ），
 *   所以把声明**前移**到 facade 的 C8f 装配段之后，再作为端口按值传进本域。
 *
 * ## 端口（21 项 = 8 依赖 + 13 返回）
 *   `pickedEngineer` 与 `setSpDumpHoldings` 分别来自「空中设施事实」段与 b11 的 supply-dumps 解构；
 *   `pushLog` / `dumpById` / `deliverableDumpsFor` 是 `function` 声明（提升），可按值传。
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'

import {
  SP_TO_T,
  constructionTaskCostsSp,
  planSpPayment,
  validateConstructionBase,
  type ConstructionExecutor,
  type ConstructionTask,
} from '@/engine/rules'
import { hasUnitMovementThisPhase } from '@/engine/rules/air-unit-movement'
import type { GamePhase } from '@/engine/state-types'
import type { Derivation } from '@/engine/derivation'
import type { RuleFailure } from '@/engine/result-types'
import { type HexRef, type Side } from '@/data'
import { constructionLegMpDistance, engineerCapableNow, hexLabel } from './workbench-model'
import type { ConsoleUnit, WorkbenchLogEntry } from './workbench-model'
import type { SpDump } from './supply-types'

/** 13.8d 施工域的端口（21 项 = 8 依赖 + 13 返回，2026-11-21 实测）。 */
export interface ConstructionDeps {
  /** 前移到 facade 的玩家输入（B27a 段在声明区之前写它） */
  constructionInputs: Ref<{ hexText: string; engineerId: string | null; payDumpId: string | null }>
  /** 13.8d 途径下被派去施工的工程兵（空中设施段的 `function` 声明 ⇒ 提升） */
  pickedEngineer: () => ConsoleUnit | null
  activeSide: ComputedRef<Side>
  phase: ComputedRef<string>
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  dumpById: (dumpId: string) => SpDump | undefined
  deliverableDumpsFor: (side: Side, beneficiaries: readonly ConsoleUnit[]) => SpDump[]
  /** 12.1a：扣款落盘（b11 的 supply-dumps 解构提供） */
  setSpDumpHoldings: (dumpId: string, holdings: { sp: number; t: number }) => void
}

export function createConstructionDomain(deps: ConstructionDeps) {
  const {
    constructionInputs,
    pickedEngineer,
    activeSide,
    phase,
    pushLog,
    dumpById,
    deliverableDumpsFor,
    setSpDumpHoldings,
  } = deps

  /**
   * 13.8d：**每名**具工程能力的单位在本移动阶段已施工过的格与已用过的任务类型
   *
   * 原文：「An Engineer-Capable unit can only perform construction in a single hex, and can only
   * perform one type of construction.」——主语是**一个工程能力单位**，故额度按 `instanceId` 分账：
   * 甲单位施工不影响乙单位；同一单位换格或换类型才被拒。
   * 换阶段 / 换回合 / 换方 / 重置都清零（新的移动环节＝新的额度）。
   */
  const constructionLedgers = ref<
    Record<string, { hexes: string[]; task: ConstructionTask | null }>
  >({})

  /** 13.8d：取某名施工者本阶段的额度（无记录＝尚未施工） */
  function constructionLedgerOf(engineerId: string | null): {
    hexes: string[]
    task: ConstructionTask | null
  } {
    if (engineerId === null) return { hexes: [], task: null }
    return constructionLedgers.value[engineerId] ?? { hexes: [], task: null }
  }

  /** 15.3 / 15.2A 的错误（统一形状：rule + reason） */
  const constructionError = ref<{ rule: string; reason: string } | null>(null)

  /**
   * 15.3 / 15.2A / 16.0b：建造付款站候选（12.3a 直拖 / 12.3b HQ 投递）
   *
   * 用户 2026-11-12：与炮击一致——**只把施工者真正拖得到的站铺到地图上**。
   * 受益单位取施工者本身（16.0b 的 `inPlace` 途径取目标格内的施工小队）。
   */
  const constructionPayDumps = computed<SpDump[]>(() => {
    const engineer = pickedEngineer()
    if (engineer === null) return []
    return deliverableDumpsFor(activeSide.value, [engineer])
  })

  /** 建造付款的「点地图选站」模式（面板按钮开启；选中一站后自动退出） */
  const constructionPayPick = ref(false)

  /** 开启/取消建造付款的地图选站模式（无施工者或无候选 ⇒ 拒并给话术） */
  function toggleConstructionPayPick(): boolean {
    if (constructionPayPick.value) {
      constructionPayPick.value = false
      return true
    }
    const engineer = pickedEngineer()
    if (engineer === null) {
      pushLog('warning', '先指定施工的工程单位，再选付款补给站（13.8d）', '13.8d')
      return false
    }
    if (constructionPayDumps.value.length === 0) {
      pushLog('warning', '该施工者此刻没有可达的己方补给站（12.3a/12.3b）', '12.3a')
      return false
    }
    constructionPayPick.value = true
    return true
  }

  /** 地图点到某一座候选站 ⇒ 写入付款站并退出选站模式 */
  function pickConstructionPayDumpNow(dumpId: string): boolean {
    const dump = constructionPayDumps.value.find((item) => item.id === dumpId)
    if (dump === undefined) return false
    constructionInputs.value = { ...constructionInputs.value, payDumpId: dump.id }
    constructionPayPick.value = false
    pushLog(
      'info',
      `修建付款站：${hexLabel(dump.hex)}（${dump.sp} SP + ${dump.t} T，12.1b）`,
      '12.1b',
    )
    return true
  }
  /**
   * 13.8d：施工者在**步行 MP** 口径下到目标格的距离（无视敌方 ZOC）
   *
   * ★ 步行价目是**固定口径**（用户 2026-09-15 裁定），与施工者自身机动类型无关，故不传机动类型。
   * `null` = 半径内不可达 ⇒ 交给引擎当作超距（`Number.POSITIVE_INFINITY`）。
   */
  function constructionLegRangeTo(engineer: ConsoleUnit, hex: HexRef): number {
    return constructionLegMpDistance(engineer.hex, hex) ?? Number.POSITIVE_INFINITY
  }

  /**
   * 13.8d：把一名工程兵组装成引擎的 `engineer` 执行者（**唯一组装点**）
   *
   * 15.3/15.2A（空军基地与简易机场）与 16.0b/c 的工程兵途径共用它——四条施工路径若各写一份
   * 「工程能力 / 本阶段是否已移动 / 到目标格的步行 MP 距离」，迟早会有一条忘记更新。
   */
  function engineerExecutorFor(
    engineer: ConsoleUnit | null,
    target: HexRef,
  ): Extract<ConstructionExecutor, { kind: 'engineer' }> {
    return {
      kind: 'engineer',
      engineerCapable: engineer !== null && engineerCapableNow(engineer),
      unitId: engineer?.instanceId ?? '',
      movedThisPhase:
        engineer === null ||
        hasUnitMovementThisPhase(engineer.mpSpent, engineer.airTransportThisPhase),
      legMpDistanceToTarget: engineer === null ? 0 : constructionLegRangeTo(engineer, target),
    }
  }

  /**
   * 13.8d 的公共前提（阶段 / 工程能力 / 未移动 / **一格一任务**）
   *
   * 唯一实现是引擎的 `validateConstructionBase`；本处只把盘面事实填进去。
   */
  function constructionGateNow(
    task: ConstructionTask,
    engineer: ConsoleUnit | null,
  ): RuleFailure | null {
    const ledger = constructionLedgerOf(engineer?.instanceId ?? null)
    return validateConstructionBase({
      phase: phase.value as GamePhase,
      engineerCapable: engineer !== null && engineerCapableNow(engineer),
      movedThisPhase:
        engineer === null ||
        hasUnitMovementThisPhase(engineer.mpSpent, engineer.airTransportThisPhase),
      hexesThisPhase: ledger.hexes.length,
      task,
      previousTaskThisPhase: ledger.task,
    })
  }

  /** 记一次本阶段施工（13.8d：按**单位**记一格一任务） */
  function noteConstruction(task: ConstructionTask, hex: HexRef, engineerId: string | null): void {
    if (engineerId === null) return
    const key = hexLabel(hex)
    const ledger = constructionLedgers.value[engineerId] ?? { hexes: [], task: null }
    constructionLedgers.value = {
      ...constructionLedgers.value,
      [engineerId]: {
        hexes: ledger.hexes.includes(key) ? [...ledger.hexes] : [...ledger.hexes, key],
        task,
      },
    }
  }

  /**
   * 13.8d：本次施工任务应付的**吨位**
   *
   * 「所有修建/改进/修理任务都需要消耗 SP。而缩减/伤害任务是**免费**的」——判据只有一处
   * （引擎的 `constructionTaskCostsSp`）：免费任务一律收 0，收费任务按调用方给的计价单位折算
   * （SP 任务 ×4 转 T，15.2A 的简易机场任务本就以 T 计）。
   */
  function constructionFeeT(task: ConstructionTask, costSp: number, costT: number): number {
    if (!constructionTaskCostsSp(task)) return 0
    return costSp > 0 ? costSp * SP_TO_T : costT
  }

  /**
   * 12.3a/12.3b：当前输入的付款站是否真的能向这名施工者投送
   *
   * 窗口内换施工者时，`payDumpId` 不会自动清空；若这里只按 id 取站，会把旧站的 SP
   * 付给新施工者（例如旧工程兵旁边的站、新工程兵隔了 8 格）。预检与落盘都必须先过这一关。
   */
  function constructionPayDumpFor(engineer: ConsoleUnit | null): SpDump | null {
    const id = constructionInputs.value.payDumpId
    if (id === null || engineer === null) return null
    const dump = dumpById(id)
    if (dump === undefined) return null
    return deliverableDumpsFor(activeSide.value, [engineer]).find((item) => item.id === id) ?? null
  }

  /**
   * 15.3 / 15.2A 的**唯一**扣款入口
   *
   * 取「指定的己方补给站」付款（12.1b/12.3a：只能从己方补给站扣），必要时找零（12.1a）。
   */
  function payConstructionFee(dumpId: string | null, wantT: number, rule: string): boolean {
    if (wantT <= 0) return true
    // 12.1b（用户 2026-11-13）：装载中的 SP 也是补给站，可作为付款站
    const dump = dumpId === null ? null : (dumpById(dumpId) ?? null)
    if (dump === null) {
      pushLog('warning', '建造费用须由**己方补给站**支付（12.1b/12.3a）⇒ 请先指定付款站', rule)
      return false
    }
    const payment = planSpPayment({ holdings: { sp: dump.sp, t: dump.t }, wantT })
    if (!payment.ok) {
      pushLog(
        'danger',
        `建造付款失败：${payment.reason}（${payment.rule}）——本次不改动任何账本`,
        payment.rule,
      )
      return false
    }
    setSpDumpHoldings(dump.id, payment.data.holdingsAfter)
    return true
  }

  /**
   * 公开面清单（P2）：原 facade `workbench.ts` return 区属于本域的键，搬回域内。
   *
   * 为什么搬：这批键是对外承诺的接口，以前登记在 facade 的 1,005 键 return 表里，
   * 于是任何本域改动都要去共享文件登记一次 —— 两人并行改 store 必在 return 区冲突。
   * 搬到域内后，本域的改动人只改本文件；facade 只留一行 `...xxx.publicSurface`。
   *
   * 纪律：增删对外键时**同步改这里的清单**，否则公开面快照（1,013 键）会红。
   */
  const publicSurface = {
    constructionError,
    constructionPayDumps,
    constructionPayPick,
    toggleConstructionPayPick,
    pickConstructionPayDumpNow,
    constructionLedgerOf,
    constructionLegRangeTo,
    constructionGateNow,
  }
  return {
    publicSurface,
    constructionLedgers,
    constructionLedgerOf,
    constructionError,
    constructionPayDumps,
    constructionPayPick,
    toggleConstructionPayPick,
    pickConstructionPayDumpNow,
    constructionLegRangeTo,
    engineerExecutorFor,
    constructionGateNow,
    noteConstruction,
    constructionFeeT,
    constructionPayDumpFor,
    payConstructionFee,
  }
}
