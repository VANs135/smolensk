import { defineStore } from 'pinia'
import { computed } from 'vue'

import { ACTION_GATES, buildLegalActionsView, type LegalActionsView } from './legal-actions'
import { hexLabel } from './workbench-model'
import { useContainersStore } from './containers'
import { useGameSessionStore } from './session'
import { useSetupStore } from './setup'
import { useWorkbenchStore } from './workbench'

/**
 * B1：合法动作视图的 **store 适配层（只读）**
 *
 * 全部数据来自 workbench / session / setup 的既有投影；本 store **不调用任何写盘函数**，
 * 也不新增规则判据。候选只有两种合法形状：
 * 1) 从既有投影搬运（基地/单位/格清单）；
 * 2) 提交入口不接对象参数（作用于"当前选中 / 当前计划"）时，投一条计划式候选。
 */
export const useLegalActionsStore = defineStore('legal-actions', () => {
  const workbench = useWorkbenchStore()
  const session = useGameSessionStore()
  const setup = useSetupStore()
  const containers = useContainersStore()

  const actingSide = computed(() => workbench.segmentGateQuery.side ?? workbench.activeSide)

  /** 候选表：每个 action key 的候选都从既有投影搬运或按计划式声明 */
  const candidates = computed<LoadedCandidates>(() => {
    const side = actingSide.value
    const table: LoadedCandidates = {}

    /* ── A 整备 / B 增援 ── */
    // 15.1：提交入口 `beginRefitNow` 收**基地 id**；候选随之为可开整备的本方基地（不是飞机）。
    table['air.refit'] = workbench.refitStartBases.map((base) => ({
      ref: base.id,
      label: `${hexLabel(base.hex)} 基地（L${String(base.level)}）`,
    }))
    table['rein.rebuild'] = workbench.rebuildCandidates.map((entry) => ({
      ref: entry.instanceId,
      label: entry.name,
    }))
    // 到货 SP 的提交入口 `applySupplyArrivalsNow` 不接受格参数 —— 它落账的是**当前计划**
    // （已勾选的免费铁运城市格 + 图边源余额 + 3.6 补给列车）。故候选只投一条「计划」，
    // 城市清单留在面板的选择态里，不冒充可提交候选（P0-02c）。
    const arrivalPlan = workbench.freeRailPlan
    table['rein.supplyArrival'] =
      arrivalPlan === null
        ? [
            {
              ref: 'plan',
              label: '到货 SP 落位',
              disabledReason:
                workbench.freeRailError?.reason ??
                '还没有生成落账计划：请先勾选免费铁运城市格或图边源，再确认落位',
            },
          ]
        : [
            {
              ref: 'plan',
              label: `到货 SP 落位（${String(arrivalPlan.placements.length)} 格）`,
              ...(arrivalPlan.placements.length === 0
                ? { disabledReason: '本笔没有可落的 SP' }
                : {}),
            },
          ]
    const specialReplRefusal = containers.specialReplRefusal(side)
    table['rein.specialRepl'] = [
      {
        ref: side,
        label: '掷特殊补员表',
        ...(specialReplRefusal === null ? {} : { disabledReason: specialReplRefusal }),
      },
    ]

    /* ── C 移动 ── */
    // 12.8e：突围候选要逐单位跑断补/路径判据（`hasLiveTraceSupply` 会触发首次追溯覆盖集）。
    // 动作未放行时视图不会采用候选，故只在该动作真可用时求值，避免普通移动每换一格都为它付一次全盘代价。
    table['move.breakout'] = workbench.segmentActionKeys.has('move.breakout')
      ? workbench.breakoutCandidates.map((item) => ({
          ref: item.unit.instanceId,
          label: item.unit.name,
          ...(item.ok || item.reason === null ? {} : { disabledReason: item.reason }),
        }))
      : []
    table['move.order'] = workbench.movePickChoices.map((unit) => ({
      ref: unit.instanceId,
      label: unit.name,
    }))
    table['move.overrun'] = workbench.overrunCandidateUnits.map((unit) => ({
      ref: unit.instanceId,
      label: unit.name,
    }))
    /*
     * 2026-11-22（用户口径）：换轨改为**走过即自动**（13.3f-B「只需移动进入」），
     * 故 `move.railConversion` 不再列玩家候选；裁判补录仍可调 `workbench.convertRailGaugeNow`。
     */
    table['move.railConversion'] = []
    table['move.construction'] = workbench.engineerChoices.map((unit) => ({
      ref: unit.instanceId,
      label: unit.name,
    }))
    // 12.11a：销毁按提交入口的 `actingSide` 取站；反应段不能列阶段玩家的站
    table['move.dumpBlow'] = workbench.actingSpDumps.map((dump) => ({
      ref: dump.id,
      label: `${String(dump.hex.col)}.${String(dump.hex.row)} · ${String(dump.sp)}SP/${String(dump.t)}T`,
    }))

    /* ── 轰炸 / 战斗 ── */
    table['barrage.declare'] = workbench.barrageUnitChoices.map((choice) => ({
      ref: choice.unit.instanceId,
      label: choice.unit.name,
      ...(choice.disabledReason === null ? {} : { disabledReason: choice.disabledReason }),
    }))
    // 9.2：战斗须在地图上点防守格发起（`openBattle` 收格参数），视图不代选。
    table['combat.declare'] = [
      {
        ref: 'hex',
        label: '在地图上点防守格发起战斗',
        disabledReason: '需先在地图上选定防守格',
      },
    ]

    /* ── D 补给 ── */
    const plan = workbench.supplyPhasePlan
    table['supply.recovery'] = (plan?.internalStocks.unmet ?? []).map((unitId) => ({
      ref: unitId,
      label: workbench.units.find((unit) => unit.instanceId === unitId)?.name ?? unitId,
    }))
    // 12.3：抽取按"当前补给检查计划"落账（`confirmSupplyPickupNow` 不接格参数）。
    // 注：`supplyFeedingCandidates` 是 12.6c/12.8e 的吃图上补给候选，语义不同，勿混用。
    table['supply.draw'] = [{ ref: 'plan', label: '当前补给检查的抽取计划' }]
    table['supply.fuel'] = workbench.fuelTargets.map((unit) => ({
      ref: unit.instanceId,
      label: unit.name,
    }))
    table['supply.attrition'] = (plan?.attritionDuty ?? []).map((duty) => ({
      ref: `${String(duty.hex.col)}.${String(duty.hex.row)}`,
      label: `断补堆叠 ${String(duty.hex.col)}.${String(duty.hex.row)}（${String(duty.unitIds.length)} 枚）`,
    }))

    /* ── E/G 预备、空中任务、专规 ── */
    table['reserve.release'] = workbench.units
      .filter((unit) => unit.side === side && unit.mode.mode === 'reserve')
      .map((unit) => ({ ref: unit.instanceId, label: unit.name }))
    table['air.mission'] = workbench.airMissionJoinChoices.map((choice) => ({
      ref: choice.air.instanceId,
      label: choice.air.name,
      ...(choice.disabledReason === null ? {} : { disabledReason: choice.disabledReason }),
    }))
    // 专规 3.4a：义务清单只在段末闸门放行时才是可点候选；闸门未开时 `panzerWrongSideHexes`
    // 每换一格都会重跑 `dividingLineObligations`，但视图根本不会采用它，故同样按闸门懒求值。
    table['exclusive.panzerObligation'] = workbench.segmentActionKeys.has(
      'exclusive.panzerObligation',
    )
      ? workbench.panzerWrongSideHexes.map((hex) => {
          const ref = `${hex.col}.${hex.row}`
          return { ref, label: `错误一侧 ${ref}` }
        })
      : []

    /* ── 其余族：一律搬运既有投影（本文件不新造判据） ── */
    // 15.4：缩减按基地提交（`reduceBaseNow` 取基地 id），候选即本方基地
    table['air.baseReduce'] = workbench.ownAirBases.map((base) => ({
      ref: base.id,
      label: `${hexLabel(base.hex)} 基地（L${String(base.level)}）`,
    }))
    // 14.11：候选是"可勾选的机"；目的地由 `transferBaseCandidates` 另给（视图只放一维）
    table['air.transfer'] = workbench.transferCandidates.map((air) => ({
      ref: air.instanceId,
      label: air.name,
    }))

    // 13.6：到达投放按 `index:hex` 组合，与初设落位同形
    table['rein.arrival'] = workbench.arrivalCandidates.flatMap((hexes, index) =>
      hexes.length === 0
        ? [
            {
              ref: `${String(index)}:none`,
              label: `#${String(index + 1)} 无处可放`,
              disabledReason: '该条目此刻没有合法落点',
            },
          ]
        : hexes.map((hex) => ({
            ref: `${String(index)}:${hexLabel(hex)}`,
            label: `#${String(index + 1)} ⇒ ${hexLabel(hex)}`,
          })),
    )
    // 专规 3.6：补给列车落点＝德军可卸货铁路格（与地图高亮同源）
    table['rein.supplyTrain'] = workbench.supplyTrainPlacementHexes.map((hex) => ({
      ref: hexLabel(hex),
      label: hexLabel(hex),
    }))
    table['rein.frontalReserves'] = [
      {
        ref: 'today',
        label: '领取本日方面军预备队',
        ...(workbench.frontalReservesToday === null
          ? { disabledReason: '今日没有方面军预备队' }
          : {}),
      },
    ]

    // 5.4a：候选是"本环节可移动的单位"；模式是否可切仍由 `switchUnitMode` 判
    table['move.modeChange'] = workbench.moveUnits.map((unit) => ({
      ref: unit.instanceId,
      label: unit.name,
    }))
    // 以下各族入口都作用在"当前选中 / 当前计划"上（入口本身不接对象参数）
    table['move.railTransport'] = [
      { ref: 'current', label: '当前选中的铁路运输对象（单位 / SP / 运输点）' },
    ]
    table['move.loadUnload'] = [{ ref: 'current', label: '当前选中的装载上下文' }]
    table['move.transportMerge'] = [{ ref: 'current', label: '当前选中的运输点' }]
    table['move.hedgehog'] = [{ ref: 'current', label: '当前点选的工事格与工程兵' }]
    table['move.breakdown'] = [{ ref: 'current', label: '当前选中的多军力单位与拆分档' }]
    table['move.extenderConvert'] = [{ ref: 'current', label: '当前选中的运输点与转换档' }]

    // 21.10b：Forage 按 HQ 逐个使用（`useForageNow(hqId)`）
    table['exclusive.forage'] = workbench.forageOptions.map((option) => ({
      ref: option.hqId,
      label: `${hexLabel(option.hex)} HQ（覆盖 ${String(option.coveredUnitIds.length)} 个单位）`,
    }))

    return table
  })

  /** 已有候选投影的 key 集合（不含任何规则判据） */
  const candidateKeys = computed(() => new Set(Object.keys(candidates.value)))

  /** 闸门表里还没有候选投影的 key（正常应为空） */
  const missingCandidateKeys = computed(() =>
    ACTION_GATES.map((gate) => gate.key).filter((key) => !candidateKeys.value.has(key)),
  )

  const view = computed<LegalActionsView>(() => {
    // 初设按 `setupSideCursor` 轮换落位方；不能用行动方 activeSide（剧本 1 初设是苏方）。
    const setupSide = setup.setupSideCursor ?? actingSide.value
    const setupChoices = setup.choicesOf(setupSide).map((entry) => ({
      entryIndex: entry.index,
      label: entry.name ?? entry.raw,
      hexes: setup.candidatesOf(entry.index).map((hex) => ({
        ref: `${hex.col}.${hex.row}`,
        label: `${hex.col}.${hex.row}`,
      })),
    }))

    const advanceAvailable =
      !workbench.initialSetupInProgress &&
      !workbench.segmentLocked &&
      !session.awaiting &&
      workbench.currentAdvanceBlock === null

    return buildLegalActionsView({
      phase: workbench.phase,
      segment: workbench.segmentStep?.id ?? '',
      role: workbench.segmentGateQuery.role,
      side: actingSide.value,
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
      candidates: candidates.value,
    })
  })

  return { view, candidates, candidateKeys, missingCandidateKeys }
})

/** 局部类型：只搬运既有投影的候选表 */
type LoadedCandidates = Parameters<typeof buildLegalActionsView>[0]['candidates']
