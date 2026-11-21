/**
 * workbench-combat-advance.ts —— C6 第 9 步：撤退（9.12）与 9.12f 撤退穿越
 *
 * B3-2b10（2026-11-21）：`triggerSpecialCombatAfterRetreat`（9.12f 撤退穿越，逐格触发 9.14）与
 * `confirmCombatRetreats`（9.12 撤退唯一落盘出口：撤退落点 / 9.12e 额外损失 / 9.12d 跟随 /
 * 9.12g 推进收束）搬出 facade，函数体只有一处接收者改写（见下）。
 *
 * **中间那段 `retreatResolutionInput`（9.12 输入唯一组装点）留在 facade**：它被 facade 3258/3268
 * 的 computed（9.12e 承受者候选预演）在建域点之前读取，若一并搬走则那两个 computed 落到 TDZ。
 * 因此本切片以 20 项端口里的一项 `retreatResolutionInput` 反向收它 —— 它是函数声明（提升），可按值传。
 *
 * 端口 20 项，只有 1 个 getter：`specialPending`（facade 14466 才声明，且是 `ref` 不是函数）⇒
 * 切片里就地 `computed(() => deps.specialPending())`，让搬入的函数体继续按 `.value` 读。
 * 其余晚声明依赖（`confirmCombatAdvance` 10573、`settleOverrunAdvanceIfRequired` 14888）都是函数声明。
 *
 * 唯一一处迁入时的改写：`triggerSpecialCombatAfterRetreat` 末尾
 * `fireResolution.scheduleRetreatCrossings(crossings)` → 端口调用 `scheduleRetreatCrossings(crossings)`；
 * 端口是装配处的闭包，仍打到同一个 `fireResolution` 实例 —— 语义与骰序不变。
 */
import { computed } from 'vue'
import type { ComputedRef, Ref } from 'vue'

import { resolveRetreats } from '@/engine/rules'
import type {
  BreakdownCreateTiming,
  CombatInteractionState,
  CombatUnitPatch,
  MoveUnitRuntime,
  RetreatFacts,
} from '@/engine/rules'
import type { HexRef } from '@/data'
import type { RuleOutcome } from '@/engine/result-types'
import type { Derivation } from '@/engine/derivation'
import type { SettlementRecordInput } from './workbench-core'
import type { CombatInputs } from './engagement-inputs'
import { effectiveMobilityOf, hexLabel, parseHexPath } from './workbench-model'
import type { ConsoleUnit, SpecialCombatPending, WorkbenchLogEntry } from './workbench-model'

/** C6 撤退（9.12 / 9.12f）的端口（20 项，2026-11-21 实测）。 */
export interface CombatAdvanceDeps {
  combatState: Ref<CombatInteractionState | null>
  combatInputs: Ref<CombatInputs>
  /** 盘上单位（撤退路径逐格判读与 9.12d 跟随者点名） */
  units: Ref<ConsoleUnit[]>
  /** 9.12f：撤退穿越判据（与 9.12 撤退同一份 facts） */
  combatRetreatFacts: ComputedRef<RetreatFacts>
  /** 9.12d：跟随撤退的堆叠成员 */
  combatTagalongIds: Ref<string[]>
  /** 9.12g：防御格是否已清空 ⇒ 推进仍待决 */
  combatDefendingHexCleared: ComputedRef<boolean>
  /** 9.12g-B：攻方把选项当撤退 ⇒ 本次不推进 */
  combatAttackerRetreated: ComputedRef<boolean>
  /** 9.12g-D：「如果有的话」—— 没有可推进单位时直接收束 */
  combatAdvanceCandidates: ComputedRef<readonly { id: string }[]>
  /** 条 22：20.0a 战后撤退时机开拆分窗（facade 7641 从移动域解构而来） */
  openBreakdownWindow: (timing: BreakdownCreateTiming, unitIds: readonly string[]) => void
  /** 9.12f：逐格登记撤退穿越（引擎侧骰序延后到 scheduleRetreatCrossings） */
  scheduleRetreatCrossings: (crossings: readonly { unitId: string; hex: HexRef }[]) => void
  /** 9.12 输入唯一组装点（留在 facade：3258 的 computed 早于建域点读它） */
  retreatResolutionInput: () => Parameters<typeof resolveRetreats>[1] | null
  nameOf: (unitId: string) => string
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  recordSettlement: (input: SettlementRecordInput) => boolean
  acceptCombat: <T>(outcome: RuleOutcome<T>, action: string) => T | null
  applyCombatPatches: (
    patches: readonly CombatUnitPatch[],
    movePatches?: readonly MoveUnitRuntime[],
  ) => void
  takeCombatLoss: (unitId: string, points: number) => void
  /** 9.12g 推进收束（facade 10573 函数声明 ⇒ 按值传） */
  confirmCombatAdvance: () => boolean
  /** 8.0 突袭战后推进强制项（facade 14888 函数声明 ⇒ 按值传） */
  settleOverrunAdvanceIfRequired: () => boolean
  /** facade 14466 才声明且是 ref ⇒ 唯一 getter */
  specialPending: () => SpecialCombatPending | null
}

export function createCombatAdvanceDomain(deps: CombatAdvanceDeps) {
  const {
    combatState,
    combatInputs,
    units,
    combatRetreatFacts,
    combatTagalongIds,
    combatDefendingHexCleared,
    combatAttackerRetreated,
    combatAdvanceCandidates,
    openBreakdownWindow,
    scheduleRetreatCrossings,
    retreatResolutionInput,
    nameOf,
    pushLog,
    recordSettlement,
    acceptCombat,
    applyCombatPatches,
    takeCombatLoss,
    confirmCombatAdvance,
    settleOverrunAdvanceIfRequired,
  } = deps

  /** 9.14 位移/分配待决（facade 14466 的 ref，晚声明 ⇒ 就地 computed 包一层保住 `.value`） */
  const specialPending = computed<SpecialCombatPending | null>(() => deps.specialPending())

  /**
   * 9.12f（批 F·E1）：撤退**穿越**敌方非战斗单位 / 设施时的处置
   *
   * 原文：「撤退不可穿越在战斗开始时包含敌方战斗单位的格（因此撤退不能穿越攻击单位承受损失或
   *   选项后空出的格）。撤退穿越**非战斗单位、飞机和舰船**时，同**移动时**穿越它们那样进行处理
   *   （根据 9.14）。」
   *
   * ⇒ 移动时是**逐格**触发 9.14（见 `triggerSpecialCombatAfterStep`：沿路径每走一格都问一次），
   *   故撤退也沿路径逐格触发；处置对象、判据、夺取表骰与移动**完全同一份**（`resolveSpecialCombatAt`），
   *   不另造一套流程。
   *
   * 边界（取保守值，不无中生有）：
   *   · 9.12「必须穿过敌方占据的格或禁入地形 ⇒ 消灭」：该格不构成 9.14 意义上的「进入」，
   *     故**该格及其之后**的路径都不判（与 `resolveRetreat` 用同一套 facts，判据一致）；
   *   · 途中被消灭的单位已不在盘上，无从确认「可攻击单位进入」，整条路径不判；
   *   · 9.14 的位移 / 分配待决（`specialPending`）时**停住**——与移动一致（落点须玩家在地图上选）。
   */
  function triggerSpecialCombatAfterRetreat(): void {
    const crossings: { unitId: string; hex: HexRef }[] = []
    for (const [unitId, text] of Object.entries(combatInputs.value.retreatPaths)) {
      const path = parseHexPath(text)
      if (path.length === 0) continue
      const unit = units.value.find((item) => item.instanceId === unitId)
      if (unit === undefined || unit.steps <= 0) continue
      const mobility = effectiveMobilityOf(unit)
      for (let index = 0; index < path.length; index += 1) {
        const hex = path[index]!
        // 9.1f：禁入判据依赖进入方向（沼泽对轮式/履带只有沿路可入）
        const previous = index === 0 ? unit.hex : path[index - 1]!
        // 9.12：本格「敌方占据 / 禁入」⇒ 单位在此被消灭，不算进入 ⇒ 到此为止
        if (combatRetreatFacts.value.enemyCombatUnitAt(hex, unit.side)) break
        if (combatRetreatFacts.value.prohibitedFor(mobility, hex, previous)) break
        crossings.push({ unitId, hex })
      }
    }
    scheduleRetreatCrossings(crossings)
  }

  function confirmCombatRetreats(): boolean {
    const state = combatState.value
    if (state === null) return false
    const input = retreatResolutionInput()
    if (input === null) return false
    const data = acceptCombat(resolveRetreats(state, input), '撤退')
    if (data === null) return false
    combatState.value = data.state
    applyCombatPatches(data.patches)
    // 9.12：点名要撤退、但该方已无存活参战单位 ⇒ 没有撤退对象，格数记 0（不放入等待集合）
    for (const item of data.skipped) {
      pushLog(
        'warning',
        `9.12：${item.side === 'attacker' ? '攻方' : '守方'}已无存活参战单位 ⇒ 无撤退对象（原需 ${item.retreatHexes} 格记 0）`,
        '9.12',
      )
    }
    // Q-A2（用户 2026-11-10 裁定）：无撤退单位 ⇒ 9.12e 的 DG / 额外损失不适用，按 0 记
    if (data.results.length === 0) {
      pushLog('info', '9.12e：无撤退对象，9.12e 不适用（按 0 记）', '9.12')
    }
    for (const result of data.results) {
      const destroyedText =
        result.reason === 'noLanding'
          ? `${nameOf(result.unitId)} 无合法撤退落点（排除战斗开始时敌方格后），按 9.12 消灭`
          : result.reason === 'impassableStartOfCombat'
            ? `${nameOf(result.unitId)} 撤退路径进入战斗开始时敌方格（不可通行），按 9.12f 消灭`
            : result.reason === 'immobile'
              ? `${nameOf(result.unitId)} 不可移动，被迫撤退 ⇒ 被摧毁（9.12b）`
              : result.reason === 'stratZoc'
                ? `${nameOf(result.unitId)} 战略模式被迫撤退进入敌方 ZOC ⇒ 被摧毁（5.8a）`
                : `${nameOf(result.unitId)} 撤退时穿过敌方单位或禁入地形，被消灭（9.12）`
      pushLog(
        result.destroyed ? 'danger' : 'info',
        result.destroyed
          ? destroyedText
          : `${nameOf(result.unitId)} 撤退至 ${result.hex === null ? '—' : hexLabel(result.hex)}` +
              `${result.gainsDg ? '，并 DG（9.12a/9.12e）' : ''}` +
              `${result.fullRetreatDistanceMet ? '' : '（完整撤退距离不满足）'}`,
        '9.12',
      )
    }
    // 9.12d：跟随者随堆叠一起落地（本函数不另记，engine 的 results 已含它们）
    if (combatTagalongIds.value.length > 0) {
      pushLog(
        'info',
        `9.12d 跟随撤退：${combatTagalongIds.value.map(nameOf).join('、')} 随其所在堆叠一起撤退`,
        '9.12d',
      )
    }
    // 9.12e：撤退堆叠在进入敌方 ZOC 前已有 DG 单位 ⇒ 该堆叠损失 1 点，由拥有者从候选 DG 单位中选
    const extra = data.extraLoss
    if (extra.points > 0) {
      const chosen = combatInputs.value.extraLossTakerId
      const taker =
        chosen !== null && extra.eligibleUnitIds.includes(chosen)
          ? chosen
          : extra.eligibleUnitIds[0]
      if (taker !== undefined) {
        takeCombatLoss(taker, extra.points)
        pushLog(
          'warning',
          `9.12e：撤退堆叠进入敌方 ZOC 前已有 DG 单位 ⇒ 该堆叠损失 ${extra.points} 点军力（由 ${nameOf(taker)} 承受）`,
          '9.12e',
        )
      }
    }
    // ⑭ 接线：撤退结算（9.12）入会话日志（本笔不掷骰）；防御格若已清空 ⇒ 9.12g 推进仍待决
    recordSettlement({
      action: 'combatRetreat',
      rule: '9.12',
      pending: combatDefendingHexCleared.value
        ? [
            {
              kind: 'advanceAfterCombat',
              // 9.12 以单位为对象：只点名仍存活的攻方（已进死亡堆者不再等待动作）
              unitIds: state.composition.attackerIds.filter((id) =>
                units.value.some((unit) => unit.instanceId === id && unit.steps > 0),
              ),
              rule: '9.12g',
            },
          ]
        : [],
      data: {
        results: data.results.map((result) => ({
          unitId: result.unitId,
          hex: result.hex === null ? null : { ...result.hex },
          destroyed: result.destroyed,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          gainsDg: result.gainsDg,
          fullRetreatDistanceMet: result.fullRetreatDistanceMet,
        })),
        tagalongIds: [...combatTagalongIds.value],
        extraLossPoints: extra.points,
      },
    })
    /*
     * 9.12f（批 F·E1）：撤退**穿越**敌方非战斗单位 / 设施 ⇒ 按 9.14 处置（同移动时穿越）。
     * 放在撤退落盘与入账**之后**（骰序与会话日志时序＝先撤退、后夺取，与物理先后一致）。
     */
    triggerSpecialCombatAfterRetreat()
    /*
     * 条 22（批 T）：20.0a 的第三个时机＝**战后撤退**。撤退方（含 9.12d 跟随者）此刻可创建拆分单位。
     * 途中被消灭者已不在盘上 ⇒ 不给窗（无从创建）。
     */
    openBreakdownWindow('retreatAfterCombat', [
      ...data.results.filter((result) => !result.destroyed).map((result) => result.unitId),
      ...combatTagalongIds.value,
    ])
    /*
     * 9.14 的位移 / 分配待决时**不**自动收束推进步——与移动一致（落点须玩家在地图上选），
     * 否则玩家还没选位移落点，战斗就先结束了。
     */
    if (specialPending.value !== null) return true
    /*
     * 9.12g-B：攻方把选项当撤退 ⇒ 本次不推进（防御格即便已空）。
     * 引擎对这条的处理是"成功但推进 0 单位"，不是拒绝；这里先记一条规则日志并直接收束，
     * 免得玩家停在一张只能空点的推进卡上。
     */
    if (combatAttackerRetreated.value) {
      pushLog('info', '9.12g-B：攻方在选项中撤退 ⇒ 本次不推进（防御格即便已空）', '9.12g-B')
      return confirmCombatAdvance()
    }
    /*
     * 9.12g-D：「常规战斗后并非必须如此，由拥有者玩家选择哪些攻击单位进行推进（**如果有的话**）。」
     * ⇒ **一个可推进的单位都没有**时，这一页没有任何可选项（只能"不推进"）⇒ 直接收束整场战斗：
     *   攻方被全灭后的收尾正走这条（用户 2026-09-18 报的第 2 条：没有继续挺进流程的意义）。
     */
    if (combatAdvanceCandidates.value.length === 0) {
      pushLog(
        'info',
        '9.12g：「如果有的话」——没有可推进的攻方单位 ⇒ 本次战斗直接结束（不再走推进步）',
        '9.12g',
      )
      return confirmCombatAdvance()
    }
    /*
     * 8.0 / 9.12g-D：突袭的战后推进是**规则强制项** ⇒ 撤退收束后自动收推进步（详见
     *   `settleOverrunAdvanceIfRequired`）。常规战斗（9.12g-D 末句）仍停在推进步由玩家选择。
     */
    if (settleOverrunAdvanceIfRequired()) return true
    return true
  }

  return {
    triggerSpecialCombatAfterRetreat,
    confirmCombatRetreats,
  }
}
