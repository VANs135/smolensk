/**
 * workbench-combat-settle.ts —— C6 第 8 步（b）选项结算（9.10a / 9.10c / 专规 2.3b）
 *
 * B3-2b9（2026-11-21）：`combatOptionLossTargets`（面板逐单位候选）与 `confirmCombatOptions`
 * （选项结算唯一出口，含 NKVD 覆盖与逐单位分配上交）整块搬出 facade，函数体零改动。
 *
 * 端口 15 项：状态与视图全部是 Ref/ComputedRef；`acceptCombat` 带泛型需按原签名声明；
 * `settlePassiveCombatSteps` 在 facade 10653 才声明，但它是**函数声明**（提升）⇒ 可按值传，不需要 getter。
 */
import { computed } from 'vue'
import type { ComputedRef, Ref } from 'vue'

import { currentResolver, nkvdDefenderOptionOverride, optionsOf, planOptions } from '@/engine/rules'
import type {
  BattleUnitView,
  CombatInteractionState,
  CombatRole,
  CombatUnitPatch,
  MoveUnitRuntime,
  RetreatFacts,
} from '@/engine/rules'
import type { RuleOutcome } from '@/engine/result-types'
import type { Derivation } from '@/engine/derivation'
import type { SettlementRecordInput } from './workbench-core'
import type { CombatInputs } from './engagement-inputs'
import { toNkvdDefenseView } from './workbench-model'
import type { ConsoleUnit, WorkbenchLogEntry } from './workbench-model'

/** C6 选项结算的端口（15 项，2026-11-21 实测）。 */
export interface CombatSettleDeps {
  combatState: Ref<CombatInteractionState | null>
  combatInputs: Ref<CombatInputs>
  combatError: Ref<{ rule: string; reason: string } | null>
  /** 盘上单位（候选名字与日志点名都从它取） */
  units: Ref<ConsoleUnit[]>
  combatAttackerViews: ComputedRef<BattleUnitView[]>
  combatDefenderViews: ComputedRef<BattleUnitView[]>
  /** 9.12/C1：撤退事实（与撤退步同一份判据） */
  combatRetreatFacts: ComputedRef<RetreatFacts>
  /** 9.10a 剩余选项点数（草稿账本域派生） */
  optionDraftRemaining: ComputedRef<number>
  resetOptionDraft: () => void
  pushLog: (
    kind: WorkbenchLogEntry['kind'],
    text: string,
    rule?: string,
    derivation?: Derivation,
  ) => void
  recordSettlement: (input: SettlementRecordInput) => boolean
  /** 引擎结论收口（失败即写 `combatError` 并记日志） */
  acceptCombat: <T>(outcome: RuleOutcome<T>, action: string) => T | null
  applyCombatPatches: (
    patches: readonly CombatUnitPatch[],
    movePatches?: readonly MoveUnitRuntime[],
  ) => void
  roleLabel: (role: CombatRole) => string
  /** facade 10653 声明（函数提升）⇒ 可按值传 */
  settlePassiveCombatSteps: () => void
}

export function createCombatSettleDomain(deps: CombatSettleDeps) {
  const {
    combatState,
    combatInputs,
    combatError,
    units,
    combatAttackerViews,
    combatDefenderViews,
    combatRetreatFacts,
    optionDraftRemaining,
    resetOptionDraft,
    pushLog,
    recordSettlement,
    acceptCombat,
    applyCombatPatches,
    roleLabel,
    settlePassiveCombatSteps,
  } = deps

  /** C6 第 8 步（b）：选项结算（9.10a 撤退格数与损失军力任意组合；9.10c 守方可忽略） */
  /**
   * 9.10/9.11a（第五批 A3）：**当前结算方**的参战单位（选项损失的分配候选；面板逐单位输入用）。
   * 名字在这里拼好 ⇒ 面板不自己查单位（与「面板不数数」同一纪律）。
   */
  const combatOptionLossTargets = computed<(BattleUnitView & { name: string })[]>(() => {
    const state = combatState.value
    if (state === null || state.step !== 'options') return []
    const views =
      state.resolution.stage === 'defenderOptions'
        ? combatDefenderViews.value
        : combatAttackerViews.value
    return views.map((view) => ({
      ...view,
      name: units.value.find((unit) => unit.instanceId === view.id)?.name ?? view.id,
    }))
  })

  function confirmCombatOptions(): boolean {
    const state = combatState.value
    if (state === null) return false
    const side = currentResolver(state)
    const inputs = combatInputs.value
    /*
     * 9.10a：选项点数必须**完全**分配。没分完就点结算 ⇒ 如实拒绝、不动盘面，
     * 剩余点数继续显示在面板上（不再自动把余数折成损失，也不丢弃玩家已点的分配）。
     */
    if (!inputs.ignoreOptions && optionDraftRemaining.value > 0) return false
    // 专规 2.3b：NKVD 边防团担任守方行动值单位时，守方全部选项**必须**吃成军力损失
    const nkvdOverride =
      side === 'defender' && state.dice !== undefined
        ? nkvdDefenderOptionOverride({
            defenderArUnitId: state.ar?.defenderUnitId ?? '',
            defenders: combatDefenderViews.value.map(toNkvdDefenseView),
            optionPoints: optionsOf(state.dice.result, 'defender'),
          })
        : null
    if (nkvdOverride !== null && inputs.ignoreOptions) {
      combatError.value = {
        rule: '专规 2.3b',
        reason: 'nkvdArUnitForbidsIgnoringOptions',
      }
      pushLog(
        'danger',
        'NKVD 边防团担任行动值单位时，守方不得行使 9.10c 的「忽略选项」权利（专规 2.3b：包括本可因攻方撤退而抵消的选项）',
        '专规 2.3b',
      )
      return false
    }
    const data = acceptCombat(
      planOptions(state, {
        /*
         * 9.10c：判「攻方无法完成选项」需要攻方单位在册（已消灭的会从 views 消失）。
         * 引擎内部按当前结算方过滤，传双方是安全的；只传本环节该方会把攻方缺席误判成全灭。
         */
        units: [...combatAttackerViews.value, ...combatDefenderViews.value],
        retreatHexes: nkvdOverride === null ? inputs.optionRetreatHexes : nkvdOverride.retreatHexes,
        lossPoints: nkvdOverride === null ? inputs.optionLossPoints : nkvdOverride.lossPoints,
        // 9.11a/9.11c（第五批 A3）：玩家给了逐单位分配才上交 ⇒ 引擎严格校验；
        // 全 0（缺省）时不传 ⇒ 引擎按规范分配（AR 优先＋均匀展开），NKVD 覆盖路径同样适用
        ...(Object.values(inputs.optionLossAllocation).some((steps) => steps > 0)
          ? {
              lossAllocation: Object.entries(inputs.optionLossAllocation)
                .filter(([, steps]) => steps > 0)
                .map(([unitId, steps]) => ({ unitId, steps })),
            }
          : {}),
        ...(side === 'defender' && inputs.ignoreOptions ? { ignore: true } : {}),
        // 9.12/C1：选项步与撤退步用**同一套按单位落点判据**
        retreatFacts: combatRetreatFacts.value,
      }),
      '选项结算',
    )
    if (data === null) return false
    combatState.value = data.state
    applyCombatPatches(data.patches)
    if (nkvdOverride !== null) pushLog('warning', nkvdOverride.detail, '专规 2.3b')
    // 9.12（C1）：当场点名「只有必死落点 / 一个落点都没有」，不要等撤退步才灰显
    const labelOf = (unitId: string) =>
      units.value.find((unit) => unit.instanceId === unitId)?.name ?? unitId
    if (data.retreatNoLandingUnitIds.length > 0)
      pushLog(
        'warning',
        `${data.retreatNoLandingUnitIds.map(labelOf).join('、')}：排除战斗开始时敌方格后无合法落点，确认撤退时将按 9.12 消灭`,
        '9.12',
      )
    else if (data.retreatDoomedUnitIds.length > 0)
      pushLog(
        'warning',
        `${data.retreatDoomedUnitIds.map(labelOf).join('、')}：只有必被消灭的撤退落点（9.12/9.12b/5.8a）`,
        '9.12',
      )
    if (data.rule === '9.10c') {
      pushLog('info', '守方行使 9.10c：忽略自己的选项', '9.10c')
    } else {
      const taken = data.state.resolution[side].option
      pushLog(
        'success',
        `${roleLabel(side)}选项（${data.rule}）：共 ${taken?.points ?? 0} 点 = 撤退 ${taken?.retreatHexes ?? 0} 格 + 损失 ${taken?.lossPoints ?? 0} 军力`,
        data.rule,
      )
    }
    // ⑭ 接线：选项结算（9.10 / 9.10c；NKVD 强制吃损失见专规 2.3b）入会话日志（本笔不掷骰）
    recordSettlement({
      action: 'combatOptions',
      rule: data.rule,
      data: {
        side,
        ignored: data.rule === '9.10c',
        nkvdForced: nkvdOverride !== null,
        points: data.state.resolution[side].option?.points ?? 0,
        retreatHexes: data.state.resolution[side].option?.retreatHexes ?? 0,
        lossPoints: data.state.resolution[side].option?.lossPoints ?? 0,
      },
    })
    // 复位选项输入，供另一方使用
    combatInputs.value.optionRetreatHexes = 0
    combatInputs.value.optionLossPoints = 0
    combatInputs.value.optionLossAllocation = {}
    combatInputs.value.ignoreOptions = false
    resetOptionDraft()
    // 下一方若也是 0 点选项 ⇒ 不停屏；撤退也一样
    settlePassiveCombatSteps()
    return true
  }

  return {
    combatOptionLossTargets,
    confirmCombatOptions,
  }
}
