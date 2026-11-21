/**
 * workbench-transport-points.ts —— C8d：13.2c 运输点数的合并 / 拆分（含 12.7e 的合并显示）
 *
 * B3-2b12（2026-11-21）：从 facade 搬出 7 个声明（声明区 250 行，留下 `transportKindOf` 的注释与函数共
 * 4 行 ⇒ 实搬 246 行；C8d 的 banner 与前后两个空行不计入）：
 * `transportPointsOfSide` / `transportPointInputs` / `transportPointGroupsOfSide` /
 * `toggleTransportMerge` / `transportRecordFor` / `mergeTransportPointsNow` /
 * `splitTransportPointNow`。**函数体零改写**（装配点就在原块位置，所有端口按值传）。
 *
 * ## 为什么 `transportKindOf` 留在 facade
 *   `transportKindOf`（C8d 段末尾那个 `function`）被 **`transportPointActorOf`（13.2f 装载量快照，
 *   `function transportPointActorOf`）在建域点之前读取** ⇒ 它与 b10 的 `retreatResolutionInput`
 *   同属"被早读者"，搬走即 TDZ。故留在 facade、反向当端口传进来（`function` 声明 ⇒ 提升，按值传安全）。
 */
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'

import {
  distributeTransportCargo,
  mergeTransportPoints,
  splitTransportPoint,
  SP_TO_T,
} from '@/engine/rules'
import type { Side } from '@/engine/rules'
import type { Derivation } from '@/engine/derivation'
import { createId } from '@/shared'
import { isExtenderUnit, modeUnitClassOf, toConsoleUnit, unitChoices } from './workbench-model'
import type { ActionKey, ConsolePhase, ConsoleUnit, WorkbenchLogEntry } from './workbench-model'

/** C8d 运输点数域的端口（6 项，2026-11-21 实测）。 */
export interface TransportPointsDeps {
  activeSide: ComputedRef<Side>
  phase: ComputedRef<ConsolePhase>
  units: Ref<ConsoleUnit[]>
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  /** 行动闸门（facade 的 `function requireAction` ⇒ 提升，按值传安全） */
  requireAction: (key: ActionKey, action: string) => boolean
  /** C8d 段末尾那个 `function`，被 `transportPointActorOf` 的早读占住 ⇒ 反向端口（提升，按值传安全） */
  transportKindOf: (unit: ConsoleUnit) => string
}

export function createTransportPointsDomain(deps: TransportPointsDeps) {
  const { activeSide, phase, units, pushLog, requireAction, transportKindOf } = deps

  /**
   * 13.2c：本方的运输点数算子（当前方；供合并 / 拆分挑选）
   *
   * 分类用引擎的 `modeUnitClass`（唯一实现）：`transportPoint`＝常规运输点数，
   * `organicTruck`＝**编内卡车**——后者按 13.2c 末句**永远不能与常规卡车合并/拆分**。
   *
   * ★ 再排掉**延补队**：12.7 里延补队与其 5 点运输点数是**同一枚算子的两面**，引擎的
   *   `modeUnitClass` 因此把延补队也归入 `transportPoint`；但「合并/拆分」只作用于运输点数那一面
   *   （延补队的转换走 12.7a/12.7d 的两个动作），故此处显式排除。
   */
  const transportPointsOfSide = computed<ConsoleUnit[]>(() =>
    units.value.filter(
      (unit) =>
        unit.side === activeSide.value &&
        modeUnitClassOf(unit) === 'transportPoint' &&
        !isExtenderUnit(unit),
    ),
  )

  /** 13.2c / 12.7 的玩家输入（合并选中的 id、拆分目标与各份规模、转换目标） */
  const transportPointInputs = ref<{
    mergeIds: string[]
    splitId: string | null
    splitSizesText: string
    convertId: string | null
  }>({ mergeIds: [], splitId: null, splitSizesText: '', convertId: null })

  /** 12.7e（用户 2026-11-13 裁定）：同格同型同规模、**已耗 MP 也相同**的运输点数可合并显示为一条 */
  const transportPointGroupsOfSide = computed<
    readonly {
      key: string
      ids: string[]
      unit: ConsoleUnit
      count: number
      points: number
    }[]
  >(() => {
    const groups: {
      key: string
      ids: string[]
      unit: ConsoleUnit
      count: number
      points: number
    }[] = []
    for (const unit of transportPointsOfSide.value) {
      // MP 不同 ⇒ 各自能走的步数不同 ⇒ 不能合并显示（各点独立移动/拆分/翻回）
      const key = [
        `${unit.hex.col}.${unit.hex.row}`,
        transportKindOf(unit),
        unit.noncombatTransport,
        unit.mpSpent,
        unit.loadedSpT,
      ].join('|')
      const existing = groups.find((group) => group.key === key)
      if (existing === undefined) {
        groups.push({
          key,
          ids: [unit.instanceId],
          unit,
          count: 1,
          points: unit.noncombatTransport,
        })
      } else {
        existing.ids.push(unit.instanceId)
        existing.count += 1
        existing.points += unit.noncombatTransport
      }
    }
    return groups
  })

  function toggleTransportMerge(id: string): void {
    const current = transportPointInputs.value.mergeIds
    transportPointInputs.value = {
      ...transportPointInputs.value,
      mergeIds: current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    }
  }

  /** 按型号与规模找算子库里的运输点数记录（13.2c 的「游戏提供算子的数量限制内」） */
  function transportRecordFor(
    kind: string,
    size: number,
    side: Side,
  ): ReturnType<typeof unitChoices>[number] | null {
    return (
      unitChoices(side).find(
        (record) =>
          record.noncombatDetails?.transport === size &&
          (record.noncombatDetails?.transportKind ?? null) === kind,
      ) ?? null
    )
  }

  /**
   * 13.2c：**合并运输点数**
   *
   * 「合并与拆分**不消耗 MP**，但只能在**友方移动阶段**中进行，且所有涉及的运输点数必须在**同一格**内。
   *   ……不同类型的运输点数永远不能合并为同一个算子，这一限制也包括编内卡车。」
   * 引擎给判据（`mergeTransportPoints`），本处负责**换算子**：把选中的若干枚移出盘面、
   * 换成该规模的那一枚记录——**算子库里没有该规模就拒绝**（这是规则的原文限制，不是我们的取舍）。
   */
  function mergeTransportPointsNow(): boolean {
    if (!requireAction('move.transportMerge', '合并运输点数')) return false
    const picked = transportPointInputs.value.mergeIds
      .map((id) => units.value.find((unit) => unit.instanceId === id))
      .filter((unit): unit is ConsoleUnit => unit !== undefined)
    const outcome = mergeTransportPoints({
      phase: phase.value,
      side: activeSide.value,
      activeSide: activeSide.value,
      points: picked.map((unit) => ({
        id: unit.instanceId,
        type: transportKindOf(unit),
        size: unit.noncombatTransport,
        hex: unit.hex,
      })),
    })
    if (!outcome.ok) {
      pushLog('warning', `运输点数合并被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const record = transportRecordFor(outcome.data.type, outcome.data.size, activeSide.value)
    if (record === null) {
      pushLog(
        'warning',
        `算子库里没有「${outcome.data.type} ${outcome.data.size}」的运输点数算子（13.2c：合并只能在游戏提供算子的数量限制内进行）`,
        '13.2c',
      )
      return false
    }
    const hex = picked[0]!.hex
    // 13.2c + 用户 2026-09-15 裁定：合并**保货**——新算子的装载量 = 各份之和（修前直接丢货）
    const mergedCargoT = picked.reduce((sum, item) => sum + item.loadedSpT, 0)
    units.value = units.value.filter(
      (unit) => !picked.some((item) => item.instanceId === unit.instanceId),
    )
    const merged = toConsoleUnit({
      record,
      instanceId: createId('tp'),
      hex,
      side: activeSide.value,
    })
    merged.loadedSpT = mergedCargoT
    // 12.7e（用户 2026-11-13 裁定）：各点各自持有自己的 MP ⇒ 合并取**最保守**的已耗 MP，
    // 不能靠合并不花 MP 白赚机动力
    merged.mpSpent = Math.max(...picked.map((item) => item.mpSpent))
    units.value = [...units.value, merged]
    transportPointInputs.value = { ...transportPointInputs.value, mergeIds: [] }
    pushLog(
      'success',
      `${outcome.data.detail}；换成「${record.vassalName ?? record.id}」` +
        (mergedCargoT > 0 ? `，已装 SP 随并入（${mergedCargoT / SP_TO_T} SP）` : ''),
      outcome.rule,
    )
    return true
  }

  /**
   * 13.2c：**拆分运输点数**
   *
   * 约束与合并相同，并额外要求各份规模为正且**合计等于原规模**。同样换算子：原枚移出、
   * 按各份规模各放一枚（缺任一规模的算子即整笔拒绝，且**原算子不动**——先全部校验再落盘）。
   */
  function splitTransportPointNow(): boolean {
    if (!requireAction('move.transportMerge', '拆分运输点数')) return false
    const id = transportPointInputs.value.splitId
    const unit = units.value.find((item) => item.instanceId === id) ?? null
    if (unit === null) {
      pushLog('warning', '先选择要拆分的运输点数（13.2c）', '13.2c')
      return false
    }
    const sizes = transportPointInputs.value.splitSizesText
      .split(/[\s,，+]+/)
      .filter((text) => text !== '')
      .map((text) => Number(text))
    const outcome = splitTransportPoint({
      phase: phase.value,
      side: activeSide.value,
      activeSide: activeSide.value,
      point: {
        id: unit.instanceId,
        type: transportKindOf(unit),
        size: unit.noncombatTransport,
      },
      sizes,
    })
    if (!outcome.ok) {
      pushLog('warning', `运输点数拆分被拒：${outcome.reason}（${outcome.rule}）`, outcome.rule)
      return false
    }
    const records = outcome.data.sizes.map((size) =>
      transportRecordFor(outcome.data.type, size, activeSide.value),
    )
    const missing = outcome.data.sizes.filter((_, index) => records[index] === null)
    if (missing.length > 0) {
      pushLog(
        'warning',
        `算子库里没有「${outcome.data.type} ${missing.join(' / ')}」的运输点数算子 ⇒ 整笔拒绝，原算子不动（13.2c）`,
        '13.2c',
      )
      return false
    }
    units.value = units.value.filter((item) => item.instanceId !== unit.instanceId)
    /*
     * 13.2c + 用户 2026-09-15 裁定：拆分**保货**（修前直接丢货）
     *
     * 「运输点数可以自由拆分……先按实体来几点给几点」⇒ 已装 SP 按「1 点运力装 1 SP」逐份装填，
     * **总数不变**（末份兜底；13.2f 对装载量没有上限）。分配口径在引擎 `distributeTransportCargo`。
     */
    const cargoSp = distributeTransportCargo({
      cargoSp: unit.loadedSpT / SP_TO_T,
      sizes: outcome.data.sizes,
    })
    units.value = [
      ...units.value,
      ...records.map((record, index) => {
        const piece = toConsoleUnit({
          record: record!,
          instanceId: createId('tp'),
          hex: unit.hex,
          side: activeSide.value,
        })
        piece.loadedSpT = (cargoSp[index] ?? 0) * SP_TO_T
        // 12.7e（用户 2026-11-13 裁定）：运输点数各自持有自己的 MP —— 拆分**不刷新 MP**，
        // 各份继承原点的已耗 MP（拆一下就白得满 MP 是把规则当提款机）
        piece.mpSpent = unit.mpSpent
        return piece
      }),
    ]
    transportPointInputs.value = {
      ...transportPointInputs.value,
      splitId: null,
      splitSizesText: '',
    }
    pushLog(
      'success',
      `${outcome.data.detail}；换成 ${records.length} 枚` +
        (unit.loadedSpT > 0
          ? `，已装 ${unit.loadedSpT / SP_TO_T} SP 按 ${cargoSp.join(' + ')} 分到各份（13.2c）`
          : ''),
      outcome.rule,
    )
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
    transportPointsOfSide,
    transportPointGroupsOfSide,
    transportPointInputs,
    toggleTransportMerge,
    mergeTransportPointsNow,
    splitTransportPointNow,
  }
  return {
    publicSurface,
    transportPointsOfSide,
    transportPointInputs,
    transportPointGroupsOfSide,
    toggleTransportMerge,
    transportRecordFor,
    mergeTransportPointsNow,
    splitTransportPointNow,
  }
}
