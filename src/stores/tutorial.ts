import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import type { HexRef } from '@/data'
import { hexDistance, sameHex } from '@/engine/hex-geometry'
import { BATTLE_SEQUENCE } from '@/engine/rules/battle'

import { useGameSessionStore } from './session'
import { useSetupStore } from './setup'
import { useWorkbenchStore } from './workbench'

/**
 * Vitebsk 教学模式（用户 2026-11-18 第 2 条）
 *
 * ## 它是什么
 *   把剧本里**已经能做的事**按一条固定顺序串起来，逐步指到该点的算子 / 格子 / 盒 / 按钮；
 *   做完一步才放开下一步。**不新增任何规则判定**：每一步的“做完”只读既有 store 的状态，
 *   真正的落位、加油、扫射、突袭、补给、AR 仍由原 action 走引擎。
 *
 * ## 为什么用「第一件没做完的事」而不是存 stepIndex
 *   读档、撤销、重开都不会把引导走岔：当前步＝按顺序扫到的第一个未完成项。
 *   前一步没做完，后面的状态再满足也不会被放行。
 *
 * ## 教学局的固定口径
 *   · 天气固定正常（`scenario setup` 页在开教学局时写 normal，开局冻结）；
 *   · 空军盒里的飞机以未激活开始（`tutorial-settings` + `planAirSetup` 的 policyOverride）；
 *   · 只教轴心方这一条线（先设苏军确认 → 轴心飞机 → 整备 → 增援 SP → 移动 → 扫射 → 突袭 → 补给 → AR）。
 */

export interface TutorialTarget {
  /** 地图格（算子/格子的指向） */
  hex?: HexRef
  /** 界面文字（按钮 / 盒 / 面板标题）；按顺序找第一个可见的 */
  texts?: readonly string[]
}

export interface TutorialStepView {
  id: string
  title: string
  /** 一行短提示；不铺规则解释 */
  hint: string
  target: TutorialTarget
  done: boolean
}

/** 教学线用的 20.Mtr 堆叠（初始 14.27；编制内 5 枚） */
const STACK_UNIT_IDS = new Set([
  'ax-motorized-ge-20-mtr-76-mot-inf',
  'ax-motorized-ge-20-mtr-90-mot-inf',
  'ax-motorized-ge-20-mtr-30-mc',
  'ax-motorized-ge-20-mtr-20-arty',
  'ax-motorized-ge-20-mtr-truck',
])

/** 这一堆的起始格 */
const STACK_START: HexRef = { col: 14, row: 27 }
/** 走到这里就贴着苏军（18.27 的 14 Tk Div） */
const MOVE_HEX: HexRef = { col: 17, row: 27 }
/** 扫射 / 突袭的目标：维捷布斯克西侧的苏军 14 Tk Div */
const TARGET_HEX: HexRef = { col: 18, row: 27 }

/** 段序：只用来判断“当前还在不在该步所需的段之前” */
function phaseRank(phase: string): number {
  if (phase === 'aircraftRefit') return 1
  if (phase === 'reinforcement') return 2
  if (phase === 'movement') return 3
  return 4
}

const BATTLE_STEP_INDEX = new Map(BATTLE_SEQUENCE.map((item, index) => [item.step, index]))
const SUPPLY_STEP = BATTLE_STEP_INDEX.get('combatSupply') ?? 1
const AR_STEP = BATTLE_STEP_INDEX.get('declareAr') ?? 2

function battleStepIndex(step: string | undefined): number {
  if (step === undefined) return -1
  return BATTLE_STEP_INDEX.get(step) ?? -1
}

export const useTutorialStore = defineStore('tutorial', () => {
  const workbench = useWorkbenchStore()
  const setup = useSetupStore()
  const gameSession = useGameSessionStore()

  const active = ref(false)
  /** 已放行到第几步；只向前，不因后续动作（如再起飞一架又变未激活）回退 */
  const cursor = ref(0)

  function startFor(): void {
    active.value = true
    cursor.value = 0
  }

  function stop(): void {
    active.value = false
  }

  const stackUnits = computed(() =>
    workbench.units.filter((unit) => STACK_UNIT_IDS.has(unit.unitId)),
  )

  const stackHex = computed<HexRef>(() => stackUnits.value[0]?.hex ?? STACK_START)

  const boxedInactiveCount = computed(
    () =>
      workbench.airUnits.filter(
        (air) =>
          air.side === 'axis' &&
          workbench.airBoxMembers.includes(air.instanceId) &&
          air.airStatus === 'inactive',
      ).length,
  )

  function hasSupplyArrival(): boolean {
    return (gameSession.session?.log ?? []).some((entry) => entry.action === 'supplyArrival')
  }

  /** 已完成一次针对目标的低空扫射（骰子是否 DG 由规则决定，不拿骰子卡教学） */
  function strikeResolved(): boolean {
    const barrage = workbench.barrageState
    if (
      barrage?.finished === true &&
      barrage.targetHex !== null &&
      sameHex(barrage.targetHex, TARGET_HEX)
    ) {
      return true
    }
    return workbench.units.some(
      (unit) => unit.side !== 'axis' && unit.mode.dg && sameHex(unit.hex, TARGET_HEX),
    )
  }

  function overrunStarted(): boolean {
    return workbench.combatState?.attackType === 'overrun'
  }

  function supplyStepDone(): boolean {
    const state = workbench.combatState
    if (state === null) return false
    return state.finished === true || battleStepIndex(state.step) > SUPPLY_STEP
  }

  function arStepDone(): boolean {
    const state = workbench.combatState
    if (state === null) return false
    return (
      (state.declaredAttackerArUnitId !== null && state.declaredAttackerArUnitId !== undefined) ||
      battleStepIndex(state.step) > AR_STEP
    )
  }

  function targetOf(id: string): TutorialTarget {
    switch (id) {
      case 'setup-soviet': {
        const pending = setup.pendingPlacement.find((item) => item.side === 'soviet')
        return pending === undefined
          ? { texts: ['确认本方布设', '开始游戏'] }
          : { texts: [pending.label] }
      }
      case 'setup-air': {
        const pending = setup.pendingPlacement.find(
          (item) => item.category === 'air' && item.side === 'axis',
        )
        return pending === undefined
          ? { texts: ['确认本方布设', '开始游戏'] }
          : { texts: [pending.label] }
      }
      case 'setup-start':
        return { texts: ['开始游戏', '完成初设'] }
      case 'air-refit':
        // 盒没打开时指「盒表」；打开后指空军盒本身 / 盒内整备按钮
        return { texts: ['整备盒内飞机', 'Luftwaffe', '盒表'] }
      case 'reinforce-sp': {
        if (phaseRank(workbench.phase) < 2) return { texts: ['进入下一环节'] }
        const hex = workbench.freeRailPlan?.placements[0]?.hex
        return {
          hex,
          texts: ['到货 SP（1.6b 补给表）', '进入下一环节'],
        }
      }
      case 'fuel': {
        if (phaseRank(workbench.phase) < 3) return { texts: ['进入下一环节'] }
        return { hex: stackHex.value, texts: ['加油'] }
      }
      case 'move':
        return { hex: MOVE_HEX, texts: ['移动模式'] }
      case 'airstrike':
        return { hex: TARGET_HEX, texts: ['低空扫射'] }
      case 'overrun':
        return { hex: TARGET_HEX, texts: ['突袭'] }
      case 'combat-supply': {
        const state = workbench.combatState
        if (state !== null && state.step === 'combatSupply') {
          if (!workbench.combatInputs.supplyConfirmed.attacker) {
            return {
              hex: workbench.combatSupplyDumps.find((item) => item.side === 'attacker')?.dumps[0]
                ?.hex,
              texts: ['确认攻方补给'],
            }
          }
          if (!workbench.combatInputs.supplyConfirmed.defender) {
            return { texts: ['确认守方补给'] }
          }
          return { texts: ['进入行动值'] }
        }
        return { texts: ['确认攻方补给'] }
      }
      case 'combat-ar':
        return workbench.combatInputs.attackerArUnitId === null
          ? { texts: ['攻方 AR 单位'] }
          : { texts: ['攻方宣布'] }
      default:
        return {}
    }
  }

  /** 教学线的固定顺序；`done` 只读既有状态，不做规则判断 */
  const steps = computed<TutorialStepView[]>(() => {
    const source: { id: string; title: string; hint: string; done: () => boolean }[] = [
      {
        id: 'setup-soviet',
        title: '苏军初设',
        hint: '落完苏军项，点「确认本方布设」',
        done: () => setup.finished || setup.setupSideCursor !== 'soviet',
      },
      {
        id: 'setup-air',
        title: '初设飞机',
        hint: '点飞机卡，再点「放入地图外盒」',
        done: () =>
          !setup.pendingPlacement.some((item) => item.category === 'air' && item.side === 'axis'),
      },
      {
        id: 'setup-start',
        title: '开始游戏',
        hint: '两方都确认后点「开始游戏」',
        done: () => setup.finished,
      },
      {
        id: 'air-refit',
        title: '整备飞机',
        hint: '盒表 › 空军盒 › 整备盒内飞机',
        done: () => boxedInactiveCount.value === 0,
      },
      {
        id: 'reinforce-sp',
        title: '增援 SP',
        hint: '把补给表 SP 落到高亮格，再结束本段',
        done: () => hasSupplyArrival() || phaseRank(workbench.phase) > 2,
      },
      {
        id: 'fuel',
        title: '单位加油',
        hint: '右键这堆 › 加油 › 编队 › 支付燃料',
        done: () => stackUnits.value.some((unit) => unit.fuelled),
      },
      {
        id: 'move',
        title: '移动到苏军旁',
        hint: '右键切「移动模式」，把整堆拖到 17.27',
        done: () => stackUnits.value.some((unit) => hexDistance(unit.hex, TARGET_HEX) === 1),
      },
      {
        id: 'airstrike',
        title: '空中扫射',
        hint: '右键 18.27 › 低空扫射（Ju 87）',
        done: () => strikeResolved(),
      },
      {
        id: 'overrun',
        title: '堆叠突袭',
        hint: '右键 18.27 › 突袭',
        done: () => overrunStarted(),
      },
      {
        id: 'combat-supply',
        title: '战斗补给',
        hint: '确认攻守补给，再点「进入行动值」',
        done: () => supplyStepDone(),
      },
      {
        id: 'combat-ar',
        title: '选择 AR 单位',
        hint: '点一枚提供 AR 的单位，再点「攻方宣布」',
        done: () => arStepDone(),
      },
    ]
    return source.map((step) => ({
      id: step.id,
      title: step.title,
      hint: step.hint,
      target: targetOf(step.id),
      done: step.done(),
    }))
  })

  // 当前步只向前推：达成即放行；不会因为后续把飞机再飞成未激活而退回「整备」
  watch(
    () => `${String(active.value)}|${steps.value.map((step) => String(step.done)).join('')}`,
    () => {
      if (!active.value) return
      while (cursor.value < steps.value.length && steps.value[cursor.value]?.done === true) {
        cursor.value += 1
      }
    },
    { immediate: true, flush: 'sync' },
  )

  const currentIndex = computed(() => cursor.value)

  const currentStep = computed<TutorialStepView | null>(() => {
    if (!active.value) return null
    return steps.value[cursor.value] ?? null
  })

  const completed = computed(() => active.value && cursor.value >= steps.value.length)

  const progressLabel = computed(() => {
    const total = steps.value.length
    return `${String(Math.min(cursor.value, total))}/${String(total)}`
  })

  return {
    active,
    startFor,
    stop,
    steps,
    currentIndex,
    currentStep,
    completed,
    progressLabel,
    stackHex,
  }
})
