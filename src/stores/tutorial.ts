import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import type { HexRef } from '@/data'
import { findAircraftRecord } from '@/engine/rules/setup'
import { hexDistance, sameHex } from '@/engine/hex-geometry'
import { BATTLE_SEQUENCE } from '@/engine/rules/battle'

import { useGameSessionStore } from './session'
import { useSetupStore } from './setup'
import { setTutorialSovietFirstTurnFullMa } from './tutorial-settings'
import { useWorkbenchStore } from './workbench'
import { toConsoleAirUnit } from './workbench-model'

/**
 * Vitebsk 教学模式（用户 2026-11-18 第 2 条；2026-11-19 扩充）
 *
 * ## 它是什么
 *   把剧本里**已经能做的事**按一条固定顺序串起来，逐步指到该点的算子 / 格子 / 盒 / 按钮；
 *   做完一步才放开下一步。**不新增任何规则判定**：每一步的“做完”只读既有 store 的状态，
 *   真正的落位、加油、扫射、突袭、补给、AR 仍由原 action 走引擎。
 *
 * ## 教学脚本的边界（2026-11-19）
 *   只做三件“开局数据 / 固定骰面”的事，不改任何判定：
 *   · 在 19.28 放一架苏军 I.153（剧本本身没有苏机，轰炸任务要有一架拦截机）；
 *   · 把苏军 18 Tk Div 置为预备并补足油（反应段才有合法反击对象）；
 *   · 两次低空扫射前把 `barrageInputs.die` 固定为 2 / 9（这是既有的裁判骰面入口）。
 *   反应段的反击由脚本按既有 `releaseReserveNow → move → overrun → 9.2` 走完，骰子照掷；
 *   结果落在 CRT 攻方损失列（苏军失败），不靠玩家操作运气。
 *
 * ## 为什么用「第一件没做完的事」而不是存 stepIndex
 *   读档、撤销、重开都不会把引导走岔：当前步＝按顺序扫到的第一个未完成项。
 */

export interface TutorialTarget {
  /** 地图格（算子/格子的指向） */
  hex?: HexRef
  /** 界面文字（按钮 / 盒 / 面板标题）；按顺序找第一个可见的 */
  texts?: readonly string[]
  /** 只在这些控件里找文字（按钮 / 标签），优先于 `texts`：用于“直接框住按钮” */
  buttonTexts?: readonly string[]
}

export interface TutorialStepView {
  id: string
  title: string
  /** 一行短提示；不铺规则解释 */
  hint: string
  /** 一行单位介绍（是什么、能干什么）；没有就不显示 */
  intro?: string
  target: TutorialTarget
  done: boolean
}

/** 轰炸任务的两种机型：Ju.88 投弹、Bf.110 护航 */
const BOMBING_AIRCRAFT = [
  ['ax-aircraft-ge-ju-88', 'Ju.88'],
  ['ax-aircraft-ge-bf-110', 'Bf.110'],
] as const

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
/** 轰炸任务的目标：19.27 的苏军步兵堆叠（I.153 从 19.28 起飞拦截） */
const BOMB_HEX: HexRef = { col: 19, row: 27 }
/** 反应段苏军 18 Tk Div 的出发格 */
const REACTION_START: HexRef = { col: 19, row: 26 }
/** 反应段的中转格（18.26 与 17.27 / 18.27 都相邻） */
const REACTION_STAGE: HexRef = { col: 18, row: 26 }

/** 9.2 段序：只用来判断“当前还在不在该步所需的段之前” */
const DICE_STEPS = new Set(['surprise', 'battleDice'])
const PHASE_ORDER = [
  'preTurn',
  'aircraftRefit',
  'reinforcement',
  'movement',
  'supply',
  'reaction',
  'combat',
  'exploitation',
  'cleanUp',
] as const
type ConsolePhaseName = (typeof PHASE_ORDER)[number]

function phaseAtLeast(phase: string, target: ConsolePhaseName): boolean {
  const index = PHASE_ORDER.indexOf(phase as ConsolePhaseName)
  return index >= PHASE_ORDER.indexOf(target)
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

  /** 反应段脚本的三态；`done` 后引导卡显示战果 */
  const reaction = ref<'idle' | 'running' | 'done' | 'skipped'>('idle')
  const reactionOutcome = ref<string | null>(null)
  /** 开局脚本只落一次（读档 / 撤销不重放） */
  const scriptApplied = ref(false)

  function startFor(): void {
    active.value = true
    cursor.value = 0
    reaction.value = 'idle'
    reactionOutcome.value = null
    scriptApplied.value = false
    setTutorialSovietFirstTurnFullMa(true)
  }

  function stop(): void {
    active.value = false
    setTutorialSovietFirstTurnFullMa(false)
  }

  const stackUnits = computed(() =>
    workbench.units.filter((unit) => STACK_UNIT_IDS.has(unit.unitId)),
  )

  const stackHex = computed<HexRef>(() => stackUnits.value[0]?.hex ?? STACK_START)

  /**
   * 已飞过任务的斯图卡枚数（14.2e：每机每阶段一次）
   *
   * 两次扫射各用一架；用“本阶段已执行任务”的既有标记判定，读档/撤销后仍然成立。
   */
  const strafeCount = computed(
    () =>
      workbench.airUnits.filter(
        (air) =>
          air.side === 'axis' &&
          air.aircraftId === 'ax-aircraft-ge-ju-87b' &&
          air.missionsFlownThisPhase > 0,
      ).length,
  )

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

  /** 已完成 n 次针对目标的空中任务（轰炸/扫射共用的 `airReturn` 回执） */
  function airMissionReturned(kind: string): boolean {
    return (gameSession.session?.log ?? []).some((entry) => {
      if (entry.action !== 'airReturn') return false
      const data = (entry.outcome as { data?: { kind?: unknown } } | undefined)?.data
      return data?.kind === kind
    })
  }

  function bombingDone(): boolean {
    return airMissionReturned('barrage')
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

  function combatFinished(): boolean {
    return workbench.combatState?.finished === true
  }

  /** 反应段的防守格：突袭推进后可能在 18.27，未推进时仍在 17.27 */
  const reactionDefenseHex = computed<HexRef>(() => stackHex.value)

  /** 低空扫射：菜单 / 选机 / 发起 / 结算 按当前会话步给按钮 */
  function strikeTarget(): TutorialTarget {
    const state = workbench.airState
    if (state === null) {
      if (workbench.airTargetHex === null) {
        return { hex: TARGET_HEX, texts: ['低空扫射'], buttonTexts: ['低空扫射'] }
      }
      if (workbench.airMissionAirIds.length === 0) {
        return { hex: TARGET_HEX, buttonTexts: ['Ju.87b'] }
      }
      return { hex: TARGET_HEX, buttonTexts: ['发起任务'] }
    }
    if (state.step === 'resolveMission') return { buttonTexts: ['结算任务'] }
    if (state.step === 'returnToBase') return { buttonTexts: ['⑥ 返航（14.2f-G）'] }
    return { buttonTexts: ['发起任务', '结算任务'] }
  }

  /** 轰炸任务：Ju.88 + Bf.110 都要选中；拦截应答要点复选框并选 I.153 */
  function bombingTarget(): TutorialTarget {
    const state = workbench.airState
    if (state === null) {
      if (workbench.airTargetHex === null) {
        return { hex: BOMB_HEX, texts: ['轰炸'], buttonTexts: ['轰炸'] }
      }
      for (const [aircraftId, name] of BOMBING_AIRCRAFT) {
        const unit = workbench.airUnits.find((air) => air.aircraftId === aircraftId)
        if (unit !== undefined && !workbench.airMissionAirIds.includes(unit.instanceId)) {
          return { hex: BOMB_HEX, buttonTexts: [name] }
        }
      }
      return { hex: BOMB_HEX, buttonTexts: ['发起任务'] }
    }
    if (state.step === 'interception') {
      if (!workbench.airInputs.interceptDeclared) {
        return { texts: ['拦截方宣布拦截（14.5：不强制）'] }
      }
      if (workbench.airInputs.interceptorId === null) {
        return { buttonTexts: ['Ru I.153'] }
      }
      return { buttonTexts: ['③ 记录拦截应答并继续'] }
    }
    if (state.step === 'flak' && workbench.airInputs.interceptDeclared) {
      return { buttonTexts: ['结算拦截空战（14.5）'] }
    }
    if (state.step === 'airCombat') return { buttonTexts: ['② 结算空战并继续（14.3）'] }
    if (state.step === 'resolveMission') {
      if (workbench.barrageLossRequired > 0) {
        return { hex: BOMB_HEX, buttonTexts: ['确认受损单位'] }
      }
      return { buttonTexts: ['结算任务'], texts: ['Ru I.153', 'Ju.88', 'Bf.110'] }
    }
    if (state.step === 'returnToBase') return { buttonTexts: ['⑥ 返航（14.2f-G）'] }
    return { hex: BOMB_HEX, texts: ['轰炸'] }
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
        // 用户 2026-11-19 第 1 条：框住空军盒里的「整备」按钮本身
        return { buttonTexts: ['整备盒内飞机', '整备'], texts: ['Luftwaffe', '盒表'] }
      case 'reinforce-sp': {
        if (!phaseAtLeast(workbench.phase, 'reinforcement'))
          return { buttonTexts: ['进入下一环节'] }
        const hex = workbench.freeRailPlan?.placements[0]?.hex
        return {
          hex,
          buttonTexts: ['进入下一环节'],
          texts: ['到货 SP（1.6b 补给表）'],
        }
      }
      case 'fuel': {
        if (!phaseAtLeast(workbench.phase, 'movement')) return { buttonTexts: ['进入下一环节'] }
        return { hex: stackHex.value, texts: ['加油'] }
      }
      case 'move':
        return { hex: MOVE_HEX, texts: ['移动模式'] }
      case 'strafe-1':
      case 'strafe-2':
        return strikeTarget()
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
          ? { texts: ['攻方 AR 单位', '宣布攻方 AR'] }
          : { texts: ['攻方宣布'] }
      case 'combat-finish': {
        const step = workbench.combatState?.step
        if (step === 'declareTerrain' || DICE_STEPS.has(step ?? '')) {
          return { texts: ['确认地形 ⇒ 自动结算到战果'] }
        }
        if (step === 'losses') return { texts: ['确认强制损失'] }
        if (step === 'options') return { texts: ['提交选项', '忽略选项'] }
        if (step === 'retreat') return { texts: ['确认撤退'] }
        if (step === 'advance') return { texts: ['推进并结束', '结束战斗（不推进）'] }
        return { buttonTexts: ['进入下一环节'] }
      }
      case 'bombing': {
        if (workbench.segmentStep?.id !== 'movement.barrage') {
          return { buttonTexts: ['进入下一环节'] }
        }
        return bombingTarget()
      }
      case 'supply-phase': {
        if (phaseAtLeast(workbench.phase, 'reaction')) return {}
        if (workbench.phase !== 'supply') return { buttonTexts: ['进入下一环节'] }
        if (!workbench.supplyFeedingSettled) {
          return {
            buttonTexts: ['生成补给计划', '刷新计划', '确认供养与断补'],
          }
        }
        const duty = workbench.supplyPhasePlan?.attritionDuty.find(
          (item) => !workbench.attritionAppliedHexes.includes(`${item.hex.col}.${item.hex.row}`),
        )
        if (duty !== undefined) {
          return {
            hex: duty.hex,
            buttonTexts: ['掷损耗骰', '确认无损耗', '确认损失分配'],
          }
        }
        return { buttonTexts: ['进入下一环节'] }
      }
      case 'reaction-attack':
        return { hex: reactionDefenseHex.value, texts: ['苏军', '确认强制作战损失', '确认撤退'] }
      default:
        return {}
    }
  }

  /** 教学线的固定顺序；`done` 只读既有状态，不做规则判断 */
  const steps = computed<TutorialStepView[]>(() => {
    const source: {
      id: string
      title: string
      hint: string
      intro?: string
      done: () => boolean
    }[] = [
      {
        id: 'setup-soviet',
        title: '苏军初设',
        hint: '霍特：先看清苏军把破铜烂铁摆在哪。',
        done: () => setup.finished || setup.setupSideCursor !== 'soviet',
      },
      {
        id: 'setup-air',
        title: '初设飞机',
        hint: '霍特：飞机先入盒，听我号令再起飞。',
        intro: '空军由集群掌握，你负责呼叫。',
        done: () =>
          !setup.pendingPlacement.some((item) => item.category === 'air' && item.side === 'axis'),
      },
      {
        id: 'setup-start',
        title: '开始游戏',
        hint: '霍特：确认无误，开始进攻。',
        done: () => setup.finished,
      },
      {
        id: 'air-refit',
        title: '整备飞机',
        hint: '霍特：点「整备」，让全队挂弹待命。',
        intro: '斯图卡俯冲轰炸机专炸地面，Bf.110 负责护航。',
        done: () => boxedInactiveCount.value === 0,
      },
      {
        id: 'reinforce-sp',
        title: '增援 SP',
        hint: '霍特：把补给表上的 SP 落到高亮格。',
        intro: 'SP 是油和弹药，装甲没有它就动不了。',
        done: () => hasSupplyArrival() || phaseAtLeast(workbench.phase, 'movement'),
      },
      {
        id: 'fuel',
        title: '单位加油',
        hint: '霍特：右键这堆加油，没油坦克就是废铁。',
        intro: '20 摩托化师：两个步兵团、装甲侦察营、炮兵团。',
        done: () => stackUnits.value.some((unit) => unit.fuelled),
      },
      {
        id: 'move',
        title: '移动到苏军旁',
        hint: '霍特：推到苏军门前，别急着开火。',
        intro: '30 装甲侦察营跑得最快，探路靠它。',
        done: () => stackUnits.value.some((unit) => hexDistance(unit.hex, TARGET_HEX) === 1),
      },
      {
        id: 'strafe-1',
        title: '空中扫射（第一次）',
        hint: '霍特：你呼叫，集群派斯图卡扫一轮。',
        intro: '斯图卡低空扫射，专打暴露的坦克。',
        done: () => strafeCount.value >= 1,
      },
      {
        id: 'strafe-2',
        title: '空中扫射（第二次）',
        hint: '霍特：再呼一次，这轮我保证命中。',
        intro: '换第二架斯图卡，同一目标再压一遍。',
        done: () => strafeCount.value >= 2,
      },
      {
        id: 'overrun',
        title: '堆叠突袭',
        hint: '霍特：压上去，堆叠突袭碾碎他们。',
        intro: '20 炮兵团贴身支援，工兵 43 营保障通路。',
        done: () => overrunStarted(),
      },
      {
        id: 'combat-supply',
        title: '战斗补给',
        hint: '霍特：确认补给，别让进攻断顿。',
        done: () => supplyStepDone(),
      },
      {
        id: 'combat-ar',
        title: '选择 AR 单位',
        hint: '霍特：点一枚提供 AR 的单位，宣布攻击。',
        done: () => arStepDone(),
      },
      {
        id: 'combat-finish',
        title: '结算战斗',
        hint: '霍特：按流程结算，别留尾巴。',
        done: () => combatFinished(),
      },
      {
        id: 'bombing',
        title: '呼叫轰炸',
        hint: '霍特：向集群申请 Ju.88 与护航，去炸 19.27。',
        intro: 'Ju.88 是水平轰炸机，Bf.110 战斗机护航。',
        done: () => bombingDone(),
      },
      {
        id: 'supply-phase',
        title: '补给阶段',
        hint: '霍特：把后勤理顺，再放苏军进来。',
        done: () => phaseAtLeast(workbench.phase, 'reaction'),
      },
      {
        id: 'reaction-attack',
        title: '苏军反击',
        hint: '霍特：残部竟敢反扑——看他们撞碎在防线上。',
        intro: '苏军 18 坦克师从预备队扑向 17.27。',
        done: () => reaction.value === 'done' || reaction.value === 'skipped',
      },
    ]
    return source.map((step) => ({
      id: step.id,
      title: step.title,
      hint: step.hint,
      intro: step.intro,
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

  /* ────────────────────── 开局脚本（只改开局数据，不改判定） ────────────────────── */

  /** 教学局需要一架苏军 I.153（剧本无苏机）与一个合法的反击预备 */
  function applyBoardScript(): void {
    if (!active.value || scriptApplied.value) return
    if (!setup.finished) return
    scriptApplied.value = true

    if (!workbench.airUnits.some((air) => air.aircraftId === 'su-aircraft-ru-i-153')) {
      const record = findAircraftRecord('su-aircraft-ru-i-153')
      if (record !== undefined) {
        workbench.airUnits.push(
          toConsoleAirUnit({
            aircraft: record,
            instanceId: 'tutorial-su-i153',
            hex: { col: 19, row: 28 },
            side: 'soviet',
            // 扫射阶段先不让它起飞（否则两次斯图卡都会被它拦下）；进轰炸环节再激活
            airStatus: 'inactive',
          }),
        )
      }
    }

    const tk = workbench.units.find(
      (unit) => unit.side === 'soviet' && unit.unitId === 'su-armor_tk-ru-18-tk-div',
    )
    if (tk !== undefined) {
      tk.mode = { mode: 'reserve', orientation: 'move', dg: false, exploit: false }
      // 与玩家切换模式同口径：预备标记盖在移动面上，raw 也要翻到移动面（否则只有战斗面的 3 MA）
      tk.raw = tk.faces.move
      tk.fuelled = true
    }

    // 反应段的反击要付战斗补给：在 19.26 给苏军一处可用补给站（12.3a 相邻拖取）
    if (!workbench.spDumps.some((dump) => dump.id === 'tutorial-su-supply')) {
      workbench.spDumps.push({
        id: 'tutorial-su-supply',
        side: 'soviet',
        hex: { ...REACTION_START },
        sp: 6,
        t: 0,
      })
    }
  }

  watch(() => `${String(active.value)}|${String(setup.finished)}`, applyBoardScript, {
    immediate: true,
    flush: 'sync',
  })

  // 进入移动段的轰炸环节时，苏军 I.153 才升空待命（拦截走 14.5 既有判定）
  watch(
    () => `${String(active.value)}|${workbench.segmentStep?.id ?? ''}`,
    () => {
      if (!active.value || workbench.segmentStep?.id !== 'movement.barrage') return
      const i153 = workbench.airUnits.find((air) => air.aircraftId === 'su-aircraft-ru-i-153')
      if (i153 !== undefined && i153.airStatus === 'inactive') i153.airStatus = 'active'
    },
    { flush: 'sync' },
  )

  /* ────────────────────── 教学脚本的固定骰面（既有裁判入口） ────────────────────── */

  watch(
    () => workbench.barrageState,
    (state) => {
      if (!active.value || state === null || state.finished) return
      if (state.kind !== 'air' || state.targetHex === null) return
      if (!sameHex(state.targetHex, TARGET_HEX)) return
      // 第一次固定为 2（Ju.87 的 12-16 列 ⇒ 未命中）；第二次固定为 9（同列 ⇒ DG + 1 点损失）
      workbench.barrageInputs.die = strafeCount.value === 0 ? 2 : 9
    },
    { flush: 'sync' },
  )

  /* ────────────────────── 反应段：苏军反击（脚本按既有动作跑） ────────────────────── */

  function driveReactionCombat(attackerId: string): boolean {
    for (let n = 0; n < 40; n++) {
      const state = workbench.combatState
      if (state === null) return false
      if (state.finished) return true
      if (state.step === 'combatSupply') {
        const attacker = workbench.combatSupplyDumps.find((item) => item.side === 'attacker')
          ?.dumps[0]
        if (attacker !== undefined) workbench.pickCombatSupplyDump('attacker', attacker.id)
        if (!workbench.confirmCombatSupplySide('attacker')) return false
        const defender = workbench.combatSupplyDumps.find((item) => item.side === 'defender')
          ?.dumps[0]
        if (defender !== undefined) workbench.pickCombatSupplyDump('defender', defender.id)
        if (!workbench.confirmCombatSupplySide('defender')) return false
        if (!workbench.confirmCombatSupply()) return false
        continue
      }
      if (state.step === 'declareAr') {
        if (workbench.combatInputs.attackerArUnitId === null) {
          workbench.combatInputs.attackerArUnitId = attackerId
        }
        if (!workbench.declareCombatArStep('attacker')) return false
        if (state.step !== 'declareAr') continue
        if (workbench.combatInputs.defenderArUnitId === null) {
          const defender = [...workbench.battleDefenders].sort((a, b) => b.raw.ar - a.raw.ar)[0]
          if (defender !== undefined) workbench.combatInputs.defenderArUnitId = defender.instanceId
        }
        if (!workbench.declareCombatArStep('defender')) return false
        continue
      }
      if (state.step === 'declareTerrain') {
        if (!workbench.declareCombatTerrainStep()) return false
        continue
      }
      if (state.step === 'surprise') {
        if (!workbench.rollCombatSurprise()) return false
        if (workbench.combatAwaitingShiftDie && !workbench.rollCombatShiftDie()) return false
        continue
      }
      if (state.step === 'battleDice') {
        if (!workbench.rollCombatDice()) return false
        continue
      }
      if (state.step === 'losses') {
        if (!workbench.confirmCombatLosses()) return false
        continue
      }
      if (state.step === 'options') {
        const requirement = workbench.combatRequirement
        if (requirement === null) return false
        // 宁可吃损失也不撤退：保持 17.27 的防御位置
        workbench.combatInputs.optionRetreatHexes = 0
        workbench.combatInputs.optionLossPoints = requirement.options
        if (!workbench.confirmCombatOptions()) return false
        continue
      }
      if (state.step === 'retreat') {
        if (!workbench.confirmCombatRetreats()) return false
        continue
      }
      if (state.step === 'advance') {
        if (!workbench.confirmCombatAdvance()) return false
        continue
      }
      return false
    }
    return workbench.combatState?.finished === true
  }

  /** 反应段：释放 18 Tk Div → 走到 18.26 → 突袭 Axis 堆叠（既有 8.0 / 9.2） */
  function runReactionAttack(): boolean {
    const tk = workbench.units.find(
      (unit) => unit.side === 'soviet' && unit.unitId === 'su-armor_tk-ru-18-tk-div',
    )
    if (tk === undefined || tk.steps <= 0) return false
    const defense = reactionDefenseHex.value
    if (hexDistance(defense, REACTION_STAGE) !== 1) return false

    if (tk.mode.mode !== 'reserve') {
      tk.mode = { mode: 'reserve', orientation: 'move', dg: false, exploit: false }
      tk.raw = tk.faces.move
    }
    workbench.selectedId = tk.instanceId
    if (!workbench.releaseReserveNow()) return false

    workbench.beginMovePick(tk.hex, [tk.instanceId])
    if (!workbench.confirmMovePick()) return false
    const node = (workbench.groupReachable?.hexes ?? []).find((item) =>
      sameHex(item.hex, REACTION_STAGE),
    )
    if (node === undefined) return false
    if (!workbench.moveAlongDraggedPath(node.path)) return false
    if (!workbench.overrunNow(defense)) return false
    if (!driveReactionCombat(tk.instanceId)) return false
    const raw = workbench.combatState?.dice?.result.raw ?? null
    reactionOutcome.value = raw
    return raw !== null && raw.startsWith('A')
  }

  watch(
    () => `${String(active.value)}|${workbench.phase}|${reaction.value}`,
    () => {
      if (!active.value || reaction.value !== 'idle') return
      if (workbench.phase !== 'reaction') return
      reaction.value = 'running'
      reaction.value = runReactionAttack() ? 'done' : 'skipped'
    },
    { flush: 'post' },
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
    reaction,
    reactionOutcome,
  }
})
