import { defineStore } from 'pinia'
import { computed } from 'vue'

import { buildLegalActionsView, type LegalActionsView } from './legal-actions'
import { useGameSessionStore } from './session'
import { useSetupStore } from './setup'
import { useWorkbenchStore } from './workbench'

/**
 * B1：合法动作视图的 **store 适配层（只读）**
 *
 * 全部数据来自 workbench / session / setup 的既有投影；本 store **不调用任何写盘函数**，
 * 也不新增规则判据。没有单位/格级候选投影的动作族不写入 `candidates` 键
 * （纯函数会把它们标成 `unsupported` 并写 `note`）。
 */
export const useLegalActionsStore = defineStore('legal-actions', () => {
  const workbench = useWorkbenchStore()
  const session = useGameSessionStore()
  const setup = useSetupStore()

  const view = computed<LegalActionsView>(() => {
    const actingSide = workbench.segmentGateQuery.side ?? workbench.activeSide
    const candidates: LoadedCandidates = {}

    /* ── A 整备 / B 增援 ── */
    candidates['air.refit'] = workbench.refitCandidates.map((air) => ({
      ref: air.instanceId,
      label: air.name,
    }))
    candidates['rein.rebuild'] = workbench.rebuildCandidates.map((entry) => ({
      ref: entry.instanceId,
      label: entry.name,
    }))
    candidates['rein.supplyArrival'] = workbench.freeRailCityCandidates.map((item) => {
      const ref = `${item.hex.col}.${item.hex.row}`
      return { ref, label: item.name === '' ? ref : item.name }
    })

    /* ── C 移动 ── */
    candidates['move.breakout'] = workbench.breakoutCandidates.map((item) => ({
      ref: item.unit.instanceId,
      label: item.unit.name,
      ...(item.ok || item.reason === null ? {} : { disabledReason: item.reason }),
    }))
    candidates['move.order'] = workbench.movePickChoices.map((unit) => ({
      ref: unit.instanceId,
      label: unit.name,
    }))
    candidates['move.overrun'] = workbench.overrunCandidateUnits.map((unit) => ({
      ref: unit.instanceId,
      label: unit.name,
    }))
    candidates['move.railConversion'] = workbench.railRepairUnits.map((unit) => ({
      ref: unit.instanceId,
      label: unit.name,
    }))
    candidates['move.construction'] = workbench.engineerChoices.map((unit) => ({
      ref: unit.instanceId,
      label: unit.name,
    }))
    candidates['move.dumpBlow'] = workbench.spDumpsOfSide.map((dump) => ({
      ref: dump.id,
      label: `${String(dump.hex.col)}.${String(dump.hex.row)} · ${String(dump.sp)}SP/${String(dump.t)}T`,
    }))

    /* ── 轰炸 / 战斗 ── */
    candidates['barrage.declare'] = workbench.barrageUnitChoices.map((choice) => ({
      ref: choice.unit.instanceId,
      label: choice.unit.name,
      ...(choice.disabledReason === null ? {} : { disabledReason: choice.disabledReason }),
    }))
    // combat.declare 的提交入口是 openBattle(defenderHex)，现存投影 combatAttackers 是
    // 已开战后的参战单位，不是可选防守格；没有防守格级投影，故不写入 candidates（标 unsupported）。

    /* ── D 补给 ── */
    const plan = workbench.supplyPhasePlan
    candidates['supply.recovery'] = (plan?.internalStocks.unmet ?? []).map((unitId) => ({
      ref: unitId,
      label: workbench.units.find((unit) => unit.instanceId === unitId)?.name ?? unitId,
    }))
    // supply.draw 需要「抽取/投递候选」，现存 supplyFeedingCandidates 是 12.6c/12.8e 的
    // 吃图上补给候选，语义不同；没有抽取候选投影，故不写入 candidates（标 unsupported）。
    candidates['supply.fuel'] = workbench.fuelTargets.map((unit) => ({
      ref: unit.instanceId,
      label: unit.name,
    }))
    candidates['supply.attrition'] = (plan?.attritionDuty ?? []).map((duty) => ({
      ref: `${String(duty.hex.col)}.${String(duty.hex.row)}`,
      label: `断补堆叠 ${String(duty.hex.col)}.${String(duty.hex.row)}（${String(duty.unitIds.length)} 枚）`,
    }))

    /* ── E/G 预备、空中任务、专规 ── */
    candidates['reserve.release'] = workbench.units
      .filter((unit) => unit.side === actingSide && unit.mode.mode === 'reserve')
      .map((unit) => ({ ref: unit.instanceId, label: unit.name }))
    candidates['air.mission'] = workbench.airMissionJoinChoices.map((choice) => ({
      ref: choice.air.instanceId,
      label: choice.air.name,
      ...(choice.disabledReason === null ? {} : { disabledReason: choice.disabledReason }),
    }))
    candidates['exclusive.forage'] = workbench.forageHints.map((hint) => ({
      ref: hint.hqId,
      label:
        workbench.units.find((unit) => unit.instanceId === hint.hqId)?.name ??
        `${String(hint.hex.col)}.${String(hint.hex.row)}`,
    }))
    candidates['exclusive.panzerObligation'] = workbench.panzerWrongSideHexes.map((hex) => {
      const ref = `${hex.col}.${hex.row}`
      return { ref, label: `错误一侧 ${ref}` }
    })

    // 初设按 `setupSideCursor` 轮换落位方；不能用行动方 activeSide（剧本 1 初设是苏方）。
    const setupSide = setup.setupSideCursor ?? actingSide
    const setupChoices = setup.choicesOf(setupSide).map((entry) => ({
      entryIndex: entry.index,
      label: entry.name ?? entry.raw,
      hexes: setup.candidatesOf(entry.index).map((hex) => ({
        ref: `${hex.col}.${hex.row}`,
        label: `${hex.col}.${hex.row}`,
      })),
    }))

    // 只搬运既有状态；「现在推进会不会被拒」由 advanceSegmentNow 自己判定并记日志。
    const advanceAvailable = !workbench.initialSetupInProgress && !workbench.segmentLocked

    return buildLegalActionsView({
      phase: workbench.phase,
      segment: workbench.segmentStep?.id ?? '',
      role: workbench.segmentGateQuery.role,
      side: actingSide,
      gatedKeys: workbench.segmentActionKeys,
      terminated: session.terminated,
      locked: workbench.segmentLocked,
      advance: { available: advanceAvailable, submit: 'advanceSegmentNow' },
      answer: {
        awaiting: session.awaiting,
        options: (session.question?.options ?? []).map((option) => ({
          id: option.id,
          label: option.label,
        })),
      },
      setup: {
        active: !setup.finished && workbench.initialSetupInProgress,
        choices: setupChoices,
      },
      candidates,
    })
  })

  return { view }
})

/** 局部类型：只搬运既有投影的候选表 */
type LoadedCandidates = Parameters<typeof buildLegalActionsView>[0]['candidates']
