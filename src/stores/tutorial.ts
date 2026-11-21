import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import type { HexRef } from '@/data'
import { findAircraftRecord, findUnitRecord } from '@/engine/rules/setup'
import { hexDistance, sameHex } from '@/engine/hex-geometry'
import { BATTLE_SEQUENCE } from '@/engine/rules/battle'

import { useGameSessionStore } from './session'
import { useHotseatStore } from './hotseat'
import { useSetupStore } from './setup'
import { setTutorialSovietFirstTurnFullMa } from './tutorial-settings'
import { useWorkbenchStore } from './workbench'
import { toConsoleAirUnit, toConsoleUnit } from './workbench-model'

/**
 * Vitebsk 教学模式（用户 2026-11-18 第 2 条；2026-11-19 扩充）
 *
 * ## 它是什么
 *   把剧本里**已经能做的事**按一条固定顺序串起来，逐步指到该点的算子 / 格子 / 盒 / 按钮；
 *   做完一步才放开下一步。**不新增任何规则判定**：每一步的“做完”只读既有 store 的状态，
 *   真正的落位、加油、扫射、突袭、补给、AR 仍由原 action 走引擎。
 *
 * ## 教学脚本的边界（2026-11-20）
 *   只做开局数据 / 固定骰面这类“摆盘 + 裁判骰”的事，不改任何判定：
 *   · 在 19.28 苏军空军基地放一队 I.153 与一队 LaGG.3（Intro 无苏机），
 *     LaGG.3 在战机扫荡课激活、I.153 在轰炸课激活；
 *   · 额外摆一队 Ju.88 进图外盒（教学轰炸要求两队 Ju.88 + 一队 Do.17z + 一队 Bf110）；
 *   · 把苏军 18 Tk Div 置为预备并补足油（反应段才有合法反击对象）；
 *   · 扫射 / 扫荡 / 轰炸只钉既有裁判骰入口，空战与轰炸判定仍走 14.x / 10.0。
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
  /** 任务选机面板里**这一枚**飞机（逐枚高亮，避免同名机误指到已选/已飞的那枚） */
  airInstanceId?: string
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

/** 轰炸任务的机型：两队 Ju.88 + 一队 Do.17z 投弹、一队 Bf.110 护航（14.2a 最多 4 机） */
const BOMBING_AIRCRAFT = [
  ['ax-aircraft-ge-ju-88', 'Ge Ju.88'],
  ['ax-aircraft-ge-do-17z', 'Ge Do.17z'],
  ['ax-aircraft-ge-bf-110', 'Ge Bf.110'],
] as const

/** 低空扫射（两次）与战机扫荡（一次）的机型；扫荡用**另一架** Bf110 */
const STRAFE_AIRCRAFT_ID = 'ax-aircraft-ge-ju-87b'
const SWEEP_AIRCRAFT_ID = 'ax-aircraft-ge-bf-110'

/** 教学脚本新增的实例：Intro 只有 1 队 Ju.88 / 没有苏机 */
const TUTORIAL_EXTRA_JU88_ID = 'tutorial-axis-ju88-2'
const TUTORIAL_SU_I153_ID = 'tutorial-su-i153'
const TUTORIAL_SU_LAGG_ID = 'tutorial-su-lagg3'

/** 教学线用的 20.Mtr 堆叠（初始 14.27；编制内 5 枚） */
const STACK_UNIT_IDS = new Set([
  'ax-motorized-ge-20-mtr-76-mot-inf',
  'ax-motorized-ge-20-mtr-90-mot-inf',
  'ax-motorized-ge-20-mtr-30-mc',
  'ax-motorized-ge-20-mtr-20-arty',
  'ax-motorized-ge-20-mtr-truck',
])

/**
 * 突袭主力的两个摩步团（8.1「可攻击单位」）
 *
 * 炮兵团 `attackCapable=false`（括号攻击值 = 只能弹幕），**不能参突**；
 * 所以教学的两连突袭只靠这两枚：战斗面 8-4-3（MA 3），移动面 4-4-14。
 */
const MOT_INF_IDS = ['ax-motorized-ge-20-mtr-76-mot-inf', 'ax-motorized-ge-20-mtr-90-mot-inf']

/** 这一堆的起始格 */
const STACK_START: HexRef = { col: 14, row: 27 }
/** 走到这里就贴着苏军（18.27 的 14 Tk Div） */
const MOVE_HEX: HexRef = { col: 17, row: 27 }
/** 第一次突袭的目标：维捷布斯克西侧的苏军 14 Tk Div（20-1-3，−1 step） */
const TARGET_HEX: HexRef = { col: 18, row: 27 }
/** 第二次突袭的目标：城格 19.27（Minor City；162 Inf Div 移动面 5 + Alarm Mil 3） */
const CITY_HEX: HexRef = { col: 19, row: 27 }
/** 空军任务目标：**大城 / 苏军 1 级空军基地** 19.28；基地里摆一队 I.153 与一队 LaGG.3 */
const BOMB_HEX: HexRef = { col: 19, row: 28 }
/** 13.5 重建教学：补员就落在 39 军 HQ 这一格（5.27）⇒ 重建也在同格（13.5a 补员同格） */
const REBUILD_HEX: HexRef = { col: 5, row: 27 }
/** 教学用的侦察营：Intro 剧本没有它 ⇒ 重建前后可用“盘面是否出现该型”判定 */
const AX_RECON_ID = 'ax-arm_rec-ge-14-mtr-14-arm-rec'
const TUTORIAL_RECON_ID = 'tutorial-axis-recon'
/** 侦察营（30 Krd，履带）绕进的侧后格：沼泽里，补给线过不去 */
const SCOUT_HEX: HexRef = { col: 18, row: 26 }
const SCOUT_UNIT_ID = 'ax-motorized-ge-20-mtr-30-mc'
const ARTILLERY_UNIT_ID = 'ax-motorized-ge-20-mtr-20-arty'
/** 反应段苏军 18 Tk Div 的出发格 */
const REACTION_START: HexRef = { col: 19, row: 26 }

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
  const hotseat = useHotseatStore()

  /** 教学局是 PVE（苏军 AI）⇒ 反应阶段由 AI 自己打，脚本不再代打 */
  const aiSoviet = computed(() => hotseat.mode === 'pve' && hotseat.aiSide === 'soviet')

  const active = ref(false)
  /** 已放行到第几步；只向前，不因后续动作（如再起飞一架又变未激活）回退 */
  const cursor = ref(0)

  /** 反应段脚本的三态；`done` 后引导卡显示战果 */
  /*
   * 反扑的进行态：**没有 skipped** —— 教学不能跳过这一步（用户两次强调）。
   * 脚本失败时退回 idle 并报警，绝不把「没打完」记成「过」。
   */
  const reaction = ref<'idle' | 'running' | 'done'>('idle')

  /*
   * 2026-11-21：后三步（苏军反扑 / 弹幕轰城 / 夺城）的真实完成判据
   *
   * 原实现用 `phaseAtLeast(phase, 'combat' | 'exploitation')` 兜底，结果阶段一进战斗段
   * 就同时判完「反扑」与「弹幕」、一进挺进段就判完「夺城」——玩家什么都没做，引导也显示
   * 全部完成（而 `cityBarraged()` / `cityTaken()` 的真实检查被 `||` 短路成永不生效）。
   *
   * 教学不能跳步：三步一律只认真实事件，既不由阶段推进代替，也不提供跳过入口。
   * 苏军行动由脚本/AI 完成（反扑必输是脚本保证的），玩家行动按引导自己操作。
   */
  const reactionFought = ref(false)

  /** 反应段是否真的打过一仗（PvE 下苏军由 AI 执行，这里只观察战斗是否发生） */
  watch(
    () =>
      `${String(active.value)}|${String(workbench.phase)}|${String(workbench.combatState === null)}`,
    () => {
      if (!active.value || reactionFought.value) return
      if (workbench.phase !== 'reaction') return
      if (workbench.combatState === null) return
      reactionFought.value = true
    },
    { flush: 'post' },
  )

  const reactionOutcome = ref<string | null>(null)
  /** 开局脚本只落一次（读档 / 撤销不重放） */
  const scriptApplied = ref(false)

  function startFor(): void {
    active.value = true
    cursor.value = 0
    overrunLaunches.value = 0
    overrunOpen = false
    reaction.value = 'idle'
    reactionOutcome.value = null
    scriptApplied.value = false
    setTutorialSovietFirstTurnFullMa(true)
    /*
     * 2026-11-21（用户口径）：教学模式**入口是单独的**，玩家不必另选 PVE/PVP。
     * 教学自带 PvE 外壳（玩家执轴心、苏军是 AI、视角与隐藏信息照常隔离），
     * 苏军的行动由本文件的脚本固定代替 AI 决策 ⇒ 这里直接落定外壳并登记脚本接管。
     */
    hotseat.adoptTutorialShell()
    hotseat.setScriptedSide('soviet')
  }

  function stop(): void {
    active.value = false
    setTutorialSovietFirstTurnFullMa(false)
    hotseat.setScriptedSide(null)
  }

  const stackUnits = computed(() =>
    workbench.units.filter((unit) => STACK_UNIT_IDS.has(unit.unitId)),
  )

  const stackHex = computed<HexRef>(() => stackUnits.value[0]?.hex ?? STACK_START)

  /** 两个摩步团（突袭主力）；炮兵不在其中——8.1 只认可攻击单位 */
  const motInfUnits = computed(() =>
    workbench.units.filter((unit) => MOT_INF_IDS.includes(unit.unitId)),
  )

  /** 摩步是否（两枚都在）翻到移动面：战斗面 MA 3 只够走 3 格，突袭一次还要 3 MP */
  const motInfInMoveMode = computed(
    () =>
      motInfUnits.value.length === MOT_INF_IDS.length &&
      motInfUnits.value.every((unit) => unit.mode.mode === 'move'),
  )

  /** 突袭堆叠所在格（炮兵/卡车不参突、可能留在原地 ⇒ 不能拿 stackHex 当突袭位置） */
  const assaultHex = computed<HexRef>(() => motInfUnits.value[0]?.hex ?? STACK_START)

  function motInfAt(hex: HexRef): boolean {
    return motInfUnits.value.some((unit) => sameHex(unit.hex, hex))
  }

  /** 已发起的突袭次数（一场战斗只记一次）；两连突靠它分步，撤销/失败都不回退 */
  const overrunLaunches = ref(0)
  let overrunOpen = false

  /**
   * 8.1a：突袭是移动环节里的一场独立战斗 ⇒ 用「战斗开始 / 结束」的沿变计数。
   * 战斗状态每走一步都会被替换，所以只能看 attackType + finished 的翻转，不能看对象身份。
   */
  watch(
    () => workbench.combatState,
    (state) => {
      if (!active.value) return
      const running = state !== null && state.attackType === 'overrun' && !state.finished
      // 只数**本方**的突袭：反应段苏军也会突袭，不能算进教学两连突
      const ours =
        running &&
        workbench.combatAttackerViews.some((view) =>
          motInfUnits.value.some((unit) => unit.instanceId === view.id),
        )
      if (ours && !overrunOpen) overrunLaunches.value += 1
      overrunOpen = ours
    },
    { flush: 'sync' },
  )

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

  /** 下一次低空扫射该点的那一枚斯图卡（已飞过任务的自然排除） */
  const nextStrafePlaneId = computed(
    () =>
      workbench.airUnits.find(
        (air) =>
          air.side === 'axis' &&
          air.aircraftId === STRAFE_AIRCRAFT_ID &&
          air.airStatus === 'active' &&
          air.missionsFlownThisPhase === 0,
      )?.instanceId ?? null,
  )

  /**
   * 战机扫荡用的 Bf110：扫荡课选机阶段取第一枚可出击（未飞过）的。
   * 扫荡完成后本步即 `done()`、目标不再被查询，故无需「认已飞过那枚」的分支。
   */
  const sweepPlaneId = computed(
    () =>
      workbench.airUnits.find(
        (air) =>
          air.side === 'axis' &&
          air.aircraftId === SWEEP_AIRCRAFT_ID &&
          air.airStatus === 'active' &&
          air.missionsFlownThisPhase === 0,
      )?.instanceId ?? null,
  )

  /** 轰炸编成：两队 Ju.88 + 一队 Do.17z + 一队未飞过任务的 Bf110（扫荡那架不参轰炸） */
  const bombingPlaneIds = computed(() => {
    // 全部机型都按「激活且未飞过」筛：让玩家此前误用 Ju.88 / Do.17z 另飞任务时，
    // 引导仍指向可点的那一枚，不会卡在已飞过、不可再选的飞机上（review 2026-11-20）。
    const available = (aircraftId: string) =>
      workbench.airUnits.filter(
        (air) =>
          air.side === 'axis' &&
          air.aircraftId === aircraftId &&
          air.airStatus === 'active' &&
          air.missionsFlownThisPhase === 0,
      )
    const ju88 = available(BOMBING_AIRCRAFT[0][0]).slice(0, 2)
    const do17z = available(BOMBING_AIRCRAFT[1][0]).slice(0, 1)
    const bf110 = available(BOMBING_AIRCRAFT[2][0]).slice(0, 1)
    return [...ju88, ...do17z, ...bf110].map((air) => air.instanceId)
  })

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

  /** 战机扫荡完成（14.6 的 `airReturn` 回执） */
  function fighterSweepDone(): boolean {
    return airMissionReturned('fighter_sweep')
  }

  /** 打过第 n 次突袭（或已经站到该格）——骰子输了也不该把引导卡死 */
  function overrunDoneAt(count: number, hex: HexRef): boolean {
    return overrunLaunches.value >= count || motInfAt(hex)
  }

  /**
   * MC 营（30 侦察营）是否已经动过
   *
   * 用户 2026-11-20：「MC 停止移动就到下一步」——只要它离开起始格、或已经花过 MP，
   * 就算这一步做到。花 MP 这一条是兜底：万一棋盘上的 hex 回写有延迟，也不至于把引导卡死。
   */
  function scoutMoved(): boolean {
    const scout = workbench.units.find((unit) => unit.unitId === SCOUT_UNIT_ID)
    if (scout === undefined) return false
    return !sameHex(scout.hex, STACK_START) || scout.mpSpent > 0
  }

  /** 堆里**每个战斗单位**都加过油（12.5a：没燃料不能花 MP；卡车属非战斗，不吃燃料） */
  function stackCombatFuelled(): boolean {
    const combat = stackUnits.value.filter((unit) => unit.isCombat)
    return combat.length > 0 && combat.every((unit) => unit.fuelled)
  }

  /** 炮兵团是否已进入弹幕射程（3 格）——不要求贴到城边 */
  function artilleryInRange(): boolean {
    const artillery = workbench.units.find((unit) => unit.unitId === ARTILLERY_UNIT_ID)
    if (artillery === undefined) return false
    return hexDistance(artillery.hex, CITY_HEX) <= 3
  }

  /** 炮兵弹幕是否已对 19.27 结算完（10.0a） */
  function cityBarraged(): boolean {
    const state = workbench.barrageState
    return (
      state !== null &&
      state.kind === 'artillery' &&
      state.targetHex !== null &&
      sameHex(state.targetHex, CITY_HEX) &&
      state.finished
    )
  }

  /** 城格 19.27 是否已由轴心占领（战斗推进后进城） */
  function cityTaken(): boolean {
    return workbench.units.some(
      (unit) => unit.side === 'axis' && sameHex(unit.hex, CITY_HEX) && unit.isCombat,
    )
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

  /**
   * 反应段的防守格：两连突之后摩步已经进城（19.27），未推进时留在 17.27 / 18.27。
   * 取**摩步**的位置——炮兵/卡车不参突，会留在原格，不能拿来当被反击的格。
   */
  const reactionDefenseHex = computed<HexRef>(() => assaultHex.value)

  /** 低空扫射：菜单 / 选机 / 发起 / 结算 按当前会话步给按钮 */
  function strikeTarget(): TutorialTarget {
    const state = workbench.airState
    if (state === null) {
      if (workbench.airTargetHex === null) {
        return { hex: TARGET_HEX, texts: ['低空扫射'], buttonTexts: ['低空扫射'] }
      }
      if (workbench.airMissionAirIds.length === 0) {
        // 逐枚指到**未飞过任务**的斯图卡，不再靠同名文字猜（同名机有两枚）
        return {
          hex: TARGET_HEX,
          ...(nextStrafePlaneId.value === null ? {} : { airInstanceId: nextStrafePlaneId.value }),
          buttonTexts: ['Ge Ju.87b', 'Ju.87b'],
        }
      }
      return { hex: TARGET_HEX, buttonTexts: ['发起任务'] }
    }
    if (state.step === 'resolveMission') return { buttonTexts: ['结算任务'] }
    if (state.step === 'returnToBase') return { buttonTexts: ['⑥ 返航（14.2f-G）'] }
    return { buttonTexts: ['发起任务', '结算任务'] }
  }

  /** 战机扫荡：右键 19.28 苏军基地 → 选**另一架** Bf110 → 结算 14.3e 空战 → 返航 */
  function fighterSweepTarget(): TutorialTarget {
    const state = workbench.airState
    if (state === null) {
      if (workbench.airTargetHex === null) {
        return { hex: BOMB_HEX, texts: ['战机扫荡'], buttonTexts: ['战机扫荡'] }
      }
      if (workbench.airMissionAirIds.length === 0) {
        return {
          hex: BOMB_HEX,
          ...(sweepPlaneId.value === null ? {} : { airInstanceId: sweepPlaneId.value }),
          buttonTexts: ['Ge Bf.110', 'Bf.110'],
        }
      }
      return { hex: BOMB_HEX, buttonTexts: ['发起任务'] }
    }
    if (state.step === 'airCombat') return { buttonTexts: ['② 结算空战并继续（14.3）'] }
    if (state.step === 'resolveMission') return { buttonTexts: ['结算任务'] }
    if (state.step === 'returnToBase') return { buttonTexts: ['⑥ 返航（14.2f-G）'] }
    return { buttonTexts: ['发起任务', '结算任务'] }
  }

  /** 轰炸任务：两队 Ju.88 + 一队 Do.17z + 一队 Bf110 逐枚点；拦截应答由苏军 AI 给 */
  function bombingTarget(): TutorialTarget {
    const state = workbench.airState
    if (state === null) {
      if (workbench.airTargetHex === null) {
        return { hex: BOMB_HEX, texts: ['轰炸'], buttonTexts: ['轰炸'] }
      }
      // 14.2a：一次任务最多 4 机，逐枚高亮（同名机两枚 ⇒ 只认实例 id）
      const pendingId = bombingPlaneIds.value.find((id) => !workbench.airMissionAirIds.includes(id))
      if (pendingId !== undefined) {
        const plane = workbench.airUnits.find((air) => air.instanceId === pendingId)
        return { hex: BOMB_HEX, airInstanceId: pendingId, buttonTexts: [plane?.name ?? 'Ju.88'] }
      }
      return { hex: BOMB_HEX, buttonTexts: ['发起任务'] }
    }
    if (state.step === 'interception') {
      /*
       * 2026-11-20（用户「以 PVE 为基础」）：拦截应答归**守方** —— 教学局里苏军是 AI，
       * 由 AI 派自己的 I.153（tutorial 的固定骰保证它被打回），玩家不替对手点拦截 UI。
       * 2026-11-21（用户「教学模式独立，不要和普通 PVE 混」）：教学一律由脚本接管苏军，
       * 所以这里除 `aiSoviet` 外还要认 `scriptedSide === 'soviet'`，两种驱动者都不给玩家 UI。
       */
      if (aiSoviet.value || hotseat.scriptedSide === 'soviet') return {}
      if (!workbench.airInputs.interceptDeclared) {
        return { texts: ['拦截方宣布拦截（14.5：不强制）'] }
      }
      if (workbench.airInputs.interceptorId === null) {
        return { buttonTexts: ['Ru I.153'] }
      }
      return { buttonTexts: ['③ 记录拦截应答并继续'] }
    }
    if (state.step === 'flak' && workbench.airInputs.interceptDeclared && !aiSoviet.value) {
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
        /*
         * 2026-11-20（用户）：「高亮一个放一个」——增援段逐项指路：
         *   ① 未掷表 → 「掷骰检定」
         *   ② 补给表 SP 还没落 → 框住手牌里的「到货 SP」卡，并亮出它的落点格
         *   ③ 补员 Pax 还没落 → 框「1.6b 补员表 · Pax」卡 + 落点格
         *   ④ 补员 Eq 还没落 → 框「1.6b 补员表 · Eq」卡 + 落点格
         *   ⑤ 都放完 → 「结束本段」
         * 手牌卡是 `<button title="到货 SP（1.6b 补给表）：…">`，按 title 里的短串框住整张卡。
         */
        if (workbench.lastVariableRepl === null) {
          return { buttonTexts: ['掷骰检定'], texts: ['掷骰检定'] }
        }
        if (workbench.supplyTableUnplaced > 0) {
          const hex = workbench.freeRailPlan?.placements[0]?.hex
          return {
            ...(hex === undefined ? {} : { hex }),
            buttonTexts: ['到货 SP'],
            texts: ['到货 SP'],
          }
        }
        const paxHex = workbench.replInitialPlacementHexesFor.pax[0]
        if (workbench.replPending.pax > 0 && paxHex !== undefined) {
          return { hex: paxHex, buttonTexts: ['补员表 · Pax'], texts: ['补员表 · Pax'] }
        }
        const eqHex = workbench.replInitialPlacementHexesFor.eq[0]
        if (workbench.replPending.eq > 0 && eqHex !== undefined) {
          return { hex: eqHex, buttonTexts: ['补员表 · Eq'], texts: ['补员表 · Eq'] }
        }
        return { buttonTexts: ['结束本段'], texts: ['结束本段'] }
      }
      case 'advance-rebuild':
        return { buttonTexts: ['进入下一环节'], texts: ['重建'] }
      case 'rebuild-open':
        return { texts: ['Arm Rec', '死亡堆'] }
      case 'rebuild-place':
        return { hex: REBUILD_HEX, texts: ['重建'] }
      case 'fuel': {
        if (!phaseAtLeast(workbench.phase, 'movement')) return { buttonTexts: ['进入下一环节'] }
        // 12.5c-A：右键菜单里点的是「加油 · 编队法」这一项，不是单独单位法
        return { hex: stackHex.value, texts: ['加油 · 编队法'], buttonTexts: ['加油 · 编队法'] }
      }
      case 'move-mode':
        // 模式切换在右键菜单里（map-view 的动作表「模式改变 · 5.4」）
        return { texts: ['改变朝向 → 移动模式'] }
      case 'scout':
        return { hex: SCOUT_HEX, texts: ['开拔'] }
      case 'scout-supply':
        // 断补是既成事实；这一步真正的"下一步动作"是叫斯图卡 ⇒ 环指向 18.27 的坦克师
        return { hex: TARGET_HEX, texts: ['低空扫射', 'Ju.87b'] }
      case 'strafe-1':
      case 'strafe-2':
        return strikeTarget()
      case 'fighter-sweep':
        return fighterSweepTarget()
      case 'move':
        return { hex: MOVE_HEX, texts: ['开拔'] }
      case 'overrun-1':
        return { hex: TARGET_HEX, texts: ['突袭'] }
      case 'artillery-move':
        return { hex: MOVE_HEX, texts: ['开拔'] }
      case 'barrage-city':
        return { hex: CITY_HEX, texts: ['弹幕'] }
      case 'capture-city':
        return { hex: CITY_HEX, texts: ['进攻'] }
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
        /*
         * 2026-11-21：反扑**全程由脚本代打**（加油 → 19.27 → 突袭 18.27 → 补给 / AR /
         * 骰面 / 损失 / 撤退），玩家一个按钮都不用点。所以这里只框战斗格并说明
         * 「等苏军打完」，不再指向「确认强制作战损失 / 确认撤退」——那些按钮会被脚本
         * 瞬间点掉，指过去反而让玩家找不到。脚本若失败会退回 idle 并 pushLog warning，
         * 此时玩家可在同一格按既有按钮手动接手。
         */
        return { hex: reactionDefenseHex.value, texts: ['苏军反扑（脚本自动）', '等结果'] }
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
        title: '苏军初设（AI）',
        hint: '霍特：苏军由 AI 布置，你看清他们把破铜烂铁摆在哪。',
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
        hint: '霍特：掷骰检定 → 一张一张点手牌 → 点高亮格落位。',
        intro: '补给表给 SP、补员表给 Pax/Eq：一张放完再放下一张，别的先别点。',
        // 手牌放完（SP 已落 + Pax/Eq 归零）才过；「结束本段」会作废未放项 ⇒ 也归零
        done: () =>
          (hasSupplyArrival() && workbench.replPending.pax + workbench.replPending.eq === 0) ||
          phaseAtLeast(workbench.phase, 'movement'),
      },
      {
        id: 'advance-rebuild',
        title: '进入重建段',
        hint: '霍特：手牌放完点「结束本段」，再点「进入下一环节」。',
        intro: '增援补员表发 Pax ×1、Eq ×1；重建侦察车花 1 Eq（13.5a）。',
        done: () =>
          workbench.segmentStep?.id === 'reinforcement.rebuild' ||
          phaseAtLeast(workbench.phase, 'movement'),
      },
      {
        id: 'rebuild-open',
        title: '选中死亡堆的侦察车',
        hint: '霍特：盒表 → 死亡堆，点这辆侦察营；点中即自动进入选格。',
        intro: '死人堆不是终点：补员同格、战斗模式 HQ 两格内就能重建，花 1 Eq。',
        done: () => workbench.deadPilePickId === TUTORIAL_RECON_ID,
      },
      {
        id: 'rebuild-place',
        title: '落地并付补员',
        hint: '霍特：点高亮的 5.27（HQ 格），花 1 Eq 把它拉回来。',
        done: () => workbench.units.some((unit) => unit.unitId === AX_RECON_ID),
      },
      {
        id: 'move-mode',
        title: '两个摩步翻移动面',
        hint: '霍特：右键这堆 →「改变朝向 → 移动模式」，两个摩步都要翻。',
        intro: '摩步战斗面 8-4-3：MA 3 连行军都紧；移动面 4-4-14 才有余量突袭（一次 3 MP，8.1a）。',
        done: () => motInfInMoveMode.value,
      },
      {
        id: 'fuel',
        title: '编队法加油',
        hint: '霍特：右键这堆 →「加油 · 编队法」，整堆都要加。',
        intro: '整堆一次付清，燃料点从该格补给堆（SP）里扣；漏加一枚它就一步也走不了（12.5a）。',
        // 12.5a：没燃料就不能花 MP ⇒ 堆里**每个战斗单位**都得加过油，否则后面 MC 会开不动
        done: () => stackCombatFuelled(),
      },
      {
        id: 'scout',
        title: '侦察营绕进 18.26',
        hint: '霍特：只选 30 侦察营，开到 18.26，停下就过。',
        intro: '履带与徒步单位可以无视敌方控制区（ZOC）穿行；侦察营正好绕到坦克师侧后。',
        done: () => scoutMoved(),
      },
      {
        id: 'scout-supply',
        title: '补给接不上',
        // 信息步也要写清"下一步做什么"，否则玩家以为卡住了（用户 2026-11-20）
        hint: '霍特：它断补了——别管它，去叫斯图卡扫 18.27。',
        intro: '18.26 在沼泽里、与后方不连通 ⇒ 这枚侦察营本回合吃不到补给（12.x）。',
        // 信息步：玩家叫第一轮斯图卡即视为看过、继续推进
        done: () => strafeCount.value >= 1,
      },
      {
        id: 'strafe-1',
        title: '空中扫射（第一次）',
        hint: '霍特：你呼叫，集群派斯图卡扫 18.27。',
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
        id: 'move',
        title: '两个摩步贴上去',
        hint: '霍特：两个摩步开到 17.27，贴住坦克师。',
        intro: '沿次干道 3 格只花 1.5 MP；移动面 14 MP，突袭的 3 MP 留得下。',
        done: () => motInfUnits.value.every((unit) => hexDistance(unit.hex, TARGET_HEX) === 1),
      },
      {
        id: 'overrun-1',
        title: '两个摩步突袭 18.27',
        hint: '霍特：两个摩步一起压上去，突袭坦克师。',
        intro:
          '炮兵团是括号攻击值 ⇒ 没有进攻能力、不参与突袭（8.1 只认可攻击单位）；两个摩步 4+4 打，突袭扣 3 MP（8.1a）。',
        done: () => overrunDoneAt(1, TARGET_HEX),
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
        id: 'artillery-move',
        title: '炮兵跟上来',
        hint: '霍特：单独选炮兵团，开拔 → 推到 17.27。',
        intro: '炮兵不需要贴脸：弹幕射程 3 格，站在 17.27 就能轰到城格 19.27。',
        done: () => artilleryInRange(),
      },
      {
        id: 'fighter-sweep',
        title: '扫荡苏军基地',
        hint: '霍特：用另一架 Bf110 扫荡 19.28 的拉格3。',
        intro:
          '14.6：战斗机飞进有激活敌机的敌方基地打空战；这一轮两败俱伤，各掉 1 军力后都返航。敌方空军基地 10 格内都是拦截范围（14.4c）。',
        done: () => fighterSweepDone(),
      },
      {
        id: 'bombing',
        title: '空军轰大城',
        hint: '霍特：两队 Ju.88、一队 Do.17z、一队 Bf110 轰 19.28。',
        intro:
          '苏军基地 10 格内都是巡逻区（14.4c），I.153 必然拦截；Ju.88 与 Do.17z 投弹、没扫荡过的 Bf110 护航，把它打回去。',
        done: () => bombingDone(),
      },
      {
        id: 'reaction-attack',
        title: '苏军坦克师反扑',
        hint: '霍特：他们另一支坦克师扑上来了，顶住。',
        intro: '反应段苏军释放预备、照 9.2 打一轮——按他们的兵力，这一下必输（苏军失败）。',
        // 教学不能跳步：苏军反扑必须真打完（脚本失败不放过，见 runReactionAttack）
        done: () => reaction.value === 'done' || reactionFought.value,
      },
      {
        id: 'barrage-city',
        title: '弹幕轰小城',
        hint: '霍特：炮兵弹幕打 19.27 的守军。',
        intro:
          '炮兵弹幕在 F 段结算（SOP：C 段只给空军、F 段只给炮兵）；先扣补给点，再按 10.0a 炸出 DG。',
        // 教学不能跳步：弹幕必须真的落在 19.27 并结算，阶段推进不兜底
        done: () => cityBarraged(),
      },
      {
        id: 'capture-city',
        title: '打下小城 19.27',
        hint: '霍特：轮到我们了——先选中要进攻的部队，再点 19.27，把城格拿下来。',
        intro: '战斗阶段由你宣布进攻：确认补给 → AR → 地形 → 奇袭 → 骰面，走完就是你的城。',
        // 教学不能跳步：必须真的把 19.27 打下来，阶段推进不兜底
        done: () => cityTaken(),
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

  /** 教学脚本：苏军基地两架敌机 + 第二队 Ju.88 + 一个合法的反击预备 */
  function applyBoardScript(): void {
    if (!active.value || scriptApplied.value) return
    if (!setup.finished) return
    scriptApplied.value = true

    /*
     * 苏军空军基地 19.28 正好有一队 I.153 和一队 LaGG.3（用户口径）。
     * 两者先不激活：扫射目标 18.27 虽在 10 格巡逻区内，也不能让它们提前参战；
     * LaGG.3 在战机扫荡课激活，I.153 到轰炸课才升空拦截。
     */
    if (!workbench.airUnits.some((air) => air.instanceId === TUTORIAL_SU_I153_ID)) {
      const record = findAircraftRecord('su-aircraft-ru-i-153')
      if (record !== undefined) {
        workbench.airUnits.push(
          toConsoleAirUnit({
            aircraft: record,
            instanceId: TUTORIAL_SU_I153_ID,
            hex: { ...BOMB_HEX },
            side: 'soviet',
            airStatus: 'inactive',
          }),
        )
      }
    }
    if (!workbench.airUnits.some((air) => air.instanceId === TUTORIAL_SU_LAGG_ID)) {
      const record = findAircraftRecord('su-aircraft-ru-lagg-3')
      if (record !== undefined) {
        workbench.airUnits.push(
          toConsoleAirUnit({
            aircraft: record,
            instanceId: TUTORIAL_SU_LAGG_ID,
            hex: { ...BOMB_HEX },
            side: 'soviet',
            airStatus: 'inactive',
          }),
        )
      }
    }

    // Intro 只有一队 Ju.88；教学轰炸要求两队 ⇒ 第二队随开局脚本进图外盒、同受整备
    if (!workbench.airUnits.some((air) => air.instanceId === TUTORIAL_EXTRA_JU88_ID)) {
      const record = findAircraftRecord(BOMBING_AIRCRAFT[0][0])
      if (record !== undefined) {
        const origin = workbench.airUnits.find(
          (air) => air.side === 'axis' && air.aircraftId === BOMBING_AIRCRAFT[0][0],
        )?.hex ?? { col: 2, row: 2 }
        workbench.airUnits.push(
          toConsoleAirUnit({
            aircraft: record,
            instanceId: TUTORIAL_EXTRA_JU88_ID,
            hex: { ...origin },
            side: 'axis',
            airStatus: 'inactive',
          }),
        )
        workbench.setAirInBoxMembership(TUTORIAL_EXTRA_JU88_ID, true)
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

    /*
     * 13.5a 重建教学：**不动 HQ**（用户 2026-11-19）——39 军 HQ 就留在剧本初设的 5.27。
     * 重建演示点就是它脚下的 5.27（REBUILD_HEX，13.5a 允许 0 格）；补员单位由增援补员表发放后，
     * 玩家把 Pax/Eq 落在 5.27（39 军 HQ 格，2.1 的可溯源格），再花 1 Eq 从死人堆拉回侦察营。
     * 重建后的单位**不需要马上移动**：教学后续步骤不再要求它开拔。
     */

    // 死亡堆放一辆侦察营（Intro 没有该型 ⇒ 重建后 `units` 里才会出现）
    if (!workbench.deadPile.some((entry) => entry.instanceId === TUTORIAL_RECON_ID)) {
      const record = findUnitRecord(AX_RECON_ID)
      if (record !== undefined) {
        workbench.deadPile.push(
          toConsoleUnit({
            record,
            instanceId: TUTORIAL_RECON_ID,
            hex: { ...REBUILD_HEX },
            side: 'axis',
          }),
        )
        workbench.pushLog(
          'info',
          '教学：死亡堆有一辆侦察营可重建（13.5a：补员同格、战斗模式 HQ 两格内）',
          '13.5',
        )
      }
    }
  }

  watch(() => `${String(active.value)}|${String(setup.finished)}`, applyBoardScript, {
    immediate: true,
    flush: 'sync',
  })

  // 战机扫荡课：LaGG.3 升空当靶子；扫荡后它两败俱伤返航，I.153 仍留在基地等轰炸课
  watch(
    () => steps.value[cursor.value]?.id ?? '',
    (id) => {
      if (!active.value || id !== 'fighter-sweep') return
      const lagg = workbench.airUnits.find((air) => air.instanceId === TUTORIAL_SU_LAGG_ID)
      if (lagg !== undefined && lagg.airStatus === 'inactive') lagg.airStatus = 'active'
    },
    { flush: 'sync' },
  )

  // 进入移动段的轰炸环节时，苏军 I.153 才升空待命（拦截走 14.5 既有判定）
  watch(
    () => `${String(active.value)}|${workbench.segmentStep?.id ?? ''}`,
    () => {
      if (!active.value || workbench.segmentStep?.id !== 'movement.barrage') return
      const i153 = workbench.airUnits.find((air) => air.instanceId === TUTORIAL_SU_I153_ID)
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
      // 第一次固定为 2（Ju.87 的 12-16 列 ⇒ 未命中）；第二次固定为 9（同列 ⇒ [1/2]，飞机轰炸按 10.0a 直接判 DG）
      workbench.barrageInputs.die = strafeCount.value === 0 ? 2 : 9
    },
    { flush: 'sync' },
  )

  /*
   * 2026-11-19：轰炸教学要**轴心稳赢且炸出防御方受损**，不能靠运气。
   *
   * · 拦截空战（14.3e）：I.153 ACV 1 vs 迎战 Bf.110 ACV 3 ⇒ 修正骰 = 6 + 1 − 3 = 4 ≤ 6，
   *   拦截机返航（轴心胜）；损失骰固定 1（无损失）。
   * · 防空（14.4e）：固定 12 + 损失骰 1 ⇒ 不命中，任务机完整进入轰炸。
   * · 轰炸（10.0a）：四机轰炸值 12+12+8+5 = 37 ⇒ 初始列 25-40；骰面 11 ⇒ 「1/2」
   *   （DG + 1 点军力损失），随后由玩家在「确认受损单位」里落盘。
   */
  watch(
    () => workbench.airState,
    (state) => {
      if (!active.value || state === null || state.finished) return
      // 教学的两类空袭：轰炸是 barrage，低空扫射是 hip_shoot——拦截骰都要固定
      if (state.kind !== 'barrage' && state.kind !== 'hip_shoot') return
      if (state.targetHex === null) return
      /*
       * 教学局的两类空袭（扫射 18.27 / 轰炸 19.28）都可能被 I.153 拦截
       * （2026-11-20：拦截应答归苏军 AI）。拦截空战骰一并固定 ⇒ 苏机必被
       * 打回（2d6=6 + ACV 1 − 3 = 4 ≤ 6），损失骰固定 1 ⇒ 我机无损失。
       */
      const isTutorialTarget =
        sameHex(state.targetHex, BOMB_HEX) || sameHex(state.targetHex, TARGET_HEX)
      if (!isTutorialTarget) return
      if (state.step === 'interception') {
        workbench.airInputs.interceptDie = 6
        workbench.airInputs.interceptLossDie = 1
        /*
         * 2026-11-21：**脚本演苏军**。教学流程定死，苏军的拦截由脚本宣布并选机，
         * 玩家是被拦截方（不再替对手勾「宣布拦截」、选机）。I.153 是教学里唯一的
         * 苏军战斗机，找不到就退回引擎给的第一架候选（资格由 14.4c 判定）。
         */
        if (workbench.airState?.interception?.declared !== true) {
          const candidates = workbench.airInterceptorCandidates
          const fixed =
            candidates.find((air) => air.instanceId === TUTORIAL_SU_I153_ID) ?? candidates[0]
          if (fixed !== undefined) {
            workbench.airInputs = {
              ...workbench.airInputs,
              interceptDeclared: true,
              interceptorId: fixed.instanceId,
            }
            workbench.declareInterceptionNow()
          }
        }
      }
      if (state.step === 'flak' && sameHex(state.targetHex, BOMB_HEX)) {
        workbench.airInputs.flakDie = 12
        workbench.airInputs.lossDie = 1
      }
    },
    { flush: 'sync' },
  )

  /*
   * 14.6 战机扫荡的 14.3e 空战：Bf110 ACV 3 vs LaGG.3 ACV 2。
   * 固定 2 骰 = 6 ⇒ 修正骰 6+3−2 = 7（双方返航）；损失骰 5 ⇒ 两架各损 1 军力
   * （14.3e-C：双方返航也掷损失骰）——正是用户要的「两败俱伤，两个都回去」。
   * 走既有 `airInputs.airCombatDice` 裁判骰入口，不改空战表 / 损失判定。
   */
  watch(
    () => workbench.airState,
    (state) => {
      if (!active.value) return
      if (
        state === null ||
        state.finished ||
        state.kind !== 'fighter_sweep' ||
        state.step !== 'airCombat'
      ) {
        workbench.airInputs.airCombatDice = null
        return
      }
      workbench.airInputs.airCombatDice = [{ die: 6, lossDie: 5 }]
    },
    { flush: 'sync' },
  )

  watch(
    () => workbench.barrageState,
    (state) => {
      if (!active.value || state === null || state.finished) return
      if (state.targetHex === null || !sameHex(state.targetHex, BOMB_HEX)) return
      /*
       * 30 点轰炸值、骰面 11：城格（Minor City）把列下压一档 ⇒ 落在「1/2」格。
       * 10.0a 的「1/2」要再掷取整骰（4-6 才损 1 点军力）——教学要**稳出损伤**，
       * 所以连取整骰一起固定为 5（≥4 ⇒ DG + 1 军力损失）。
       */
      workbench.barrageInputs.die = 11
      workbench.barrageInputs.halfDie = 5
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
        // 苏军反扑要打到底：宁可吃损失也不撤退（不改变盘面位置）
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

  /**
   * 2026-11-21（用户口径）：苏军反扑的目标格
   *
   * 脚本把 18 Tk Div 开到 19.27，战斗对象取「19.27 上的轴心单位」，
   * 没有就取与 19.27 相邻的轴心战斗单位（8.1a 突袭只打相邻格）。
   */
  function reactionTargetHex(): HexRef | null {
    const axisFighters = workbench.units.filter(
      (unit) => unit.side === 'axis' && unit.isCombat && unit.steps >= 0,
    )
    const onCity = axisFighters.find((unit) => sameHex(unit.hex, CITY_HEX))
    if (onCity !== undefined) return onCity.hex
    const adjacent = axisFighters.find((unit) => hexDistance(unit.hex, CITY_HEX) === 1)
    return adjacent?.hex ?? null
  }

  /**
   * 反应段：18 Tk Div 按脚本**加油 → 移动到 19.27 → 战斗**（用户 2026-11-21 口径）
   *
   * 全过程走既有规则入口（12.5c 加油、8.x 移动、8.1a 突袭、9.2 战斗），
   * 脚本只负责「替苏军选动作」，不另写判定。
   */
  function runReactionAttack(): boolean {
    const tk = workbench.units.find(
      (unit) => unit.side === 'soviet' && unit.unitId === 'su-armor_tk-ru-18-tk-div',
    )
    if (tk === undefined || tk.steps <= 0) return false

    /*
     * ① 加油：18 Tk Div 是**独立单位**（3.2f）⇒ 只能走 12.5c-B 的 HQ 法或 12.5c-C 的
     * 单独单位法；编队法（12.5c-A）要求"一整个多单位编队"，对它不成立。教学里 19.26
     * 没有苏军指挥部在场，故用**单独单位法**：各 1 T，从脚下补给堆扣 1 SP。
     */
    if (!tk.fuelled) {
      const dump = workbench.spDumps.find((item) => item.id === 'tutorial-su-supply')
      if (dump === undefined || dump.sp < 1) return false
      dump.sp -= 1
      tk.fuelled = true
      workbench.pushLog(
        'info',
        '教学：苏军 18 Tk Div（独立单位）单独单位法加油（12.5c-C，扣补给堆 1 SP）',
        '12.5',
      )
    }

    /*
     * 8.1a：突袭只能由**移动模式**的战斗单位在移动中执行 —— 所以先把面切到移动面。
     * **无条件切**（不是"仅当不是预备态"）：中途若被翻回战斗面，MA 只剩战斗面的几格，
     * 从 19.26 走到 19.27 再突袭会因 MP 不足失败（反应段既不能常规战斗，也只能靠这一手）。
     */
    tk.mode = { mode: 'reserve', orientation: 'move', dg: false, exploit: false }
    tk.raw = tk.faces.move
    workbench.selectedId = tk.instanceId
    if (!workbench.releaseReserveNow()) return false

    workbench.beginMovePick(tk.hex, [tk.instanceId])
    if (!workbench.confirmMovePick()) return false
    // ② 移动到 19.27（小城格）：只认这一格，到不了就报失败、不换目标
    const node = (workbench.groupReachable?.hexes ?? []).find((item) => sameHex(item.hex, CITY_HEX))
    if (node === undefined) return false
    if (!workbench.moveAlongDraggedPath(node.path)) return false

    // ③ 战斗：对 19.27 上／相邻的轴心单位发起突袭，并走完 9.2 战斗序列
    const target = reactionTargetHex()
    if (target === null) return false
    if (!workbench.overrunNow(target)) return false
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
      /*
       * 2026-11-21（用户口径）：教学是 PvE 外壳，但**苏军由脚本固定行动** ——
       * 所以只有「脚本没接管」时才把反应段交给 AI（普通 PvE）；教学里脚本自己打。
       */
      if (hotseat.scriptedSide !== 'soviet') return
      reaction.value = 'running'
      if (runReactionAttack()) {
        reaction.value = 'done'
        return
      }
      // 不能跳过这一步（用户两次强调）：失败就退回 idle 并报警，让问题暴露而不是静默放行
      reaction.value = 'idle'
      workbench.pushLog(
        'warning',
        '教学：苏军反扑脚本未完成（不跳过此步）——检查 18 Tk Div 的补给、19.27 路径与轴心目标格',
        '9.2',
      )
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
    /*
     * 1 基显示（用户 2026-11-20）：原来直接用 `cursor`，第一步显示「0/24」，
     * 于是站在第 12 步时显示「11/24」，被误读成"卡在第 11 步没往下走"。
     */
    return `${String(Math.min(cursor.value + 1, Math.max(total, 1)))}/${String(total)}`
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
    reactionFought,
  }
})
