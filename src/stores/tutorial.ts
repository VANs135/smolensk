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

/** 轰炸任务的机型：Ju.88 + Do.17z 投弹、两架 Bf.110 护航（14.2a 最多 4 机） */
const BOMBING_AIRCRAFT = [
  ['ax-aircraft-ge-ju-88', 'Ju.88'],
  ['ax-aircraft-ge-do-17z', 'Do.17z'],
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
/** 空军轰炸的目标：**大城** 19.28（Major City；I.153 就驻扎在这格，起飞拦截后被打回） */
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
/** 反应段的中转格（18.26 与 17.27 / 18.27 都相邻） */
const REACTION_STAGE: HexRef = SCOUT_HEX

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
  const reaction = ref<'idle' | 'running' | 'done' | 'skipped'>('idle')
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
  }

  function stop(): void {
    active.value = false
    setTutorialSovietFirstTurnFullMa(false)
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

  /** 打过第 n 次突袭（或已经站到该格）——骰子输了也不该把引导卡死 */
  function overrunDoneAt(count: number, hex: HexRef): boolean {
    return overrunLaunches.value >= count || motInfAt(hex)
  }

  /** 30 侦察营是否已绕到 18.26（履带无视 ZOC 的教学点） */
  function scoutInPlace(): boolean {
    return workbench.units.some(
      (unit) => unit.unitId === SCOUT_UNIT_ID && sameHex(unit.hex, SCOUT_HEX),
    )
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
      // 14.2a：一次任务最多 4 机 ⇒ Ju.88 + Do.17z + 两架 Bf.110，逐枚都要选中
      for (const [aircraftId, name] of BOMBING_AIRCRAFT) {
        const units = workbench.airUnits.filter(
          (air) =>
            air.aircraftId === aircraftId && air.side === 'axis' && air.airStatus === 'active',
        )
        for (const unit of units) {
          if (!workbench.airMissionAirIds.includes(unit.instanceId)) {
            return { hex: BOMB_HEX, buttonTexts: [name] }
          }
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
        /*
         * 2026-11-19（PC 教学审计）：原目标文本「到货 SP（1.6b 补给表）」在界面上不存在
         * （现界面写的是「补给表 +N SP → 手牌（城市格每格 1 点…）」）⇒ 环永远指不到。
         * 改成真实存在的「补给表」子串（findText 取最小面积节点 = 手牌那一行）。
         */
        return {
          hex,
          buttonTexts: ['进入下一环节'],
          // 只匹配手牌那一行「补给表 +N SP → 手牌」；顶栏操作反馈里的「补给表（1.6b）」面积更小会抢目标
          texts: ['补给表 +'],
        }
      }
      case 'advance-rebuild':
        return { buttonTexts: ['进入下一环节'], texts: ['重建'] }
      case 'rebuild-open':
        return { texts: ['Arm Rec', '死亡堆'] }
      case 'rebuild-place':
        return { hex: REBUILD_HEX, texts: ['重建'] }
      case 'fuel': {
        if (!phaseAtLeast(workbench.phase, 'movement')) return { buttonTexts: ['进入下一环节'] }
        return { hex: stackHex.value, texts: ['加油'] }
      }
      case 'move-mode':
        // 模式切换在右键菜单里（map-view 的动作表「模式改变 · 5.4」）
        return { texts: ['改变朝向 → 移动模式'] }
      case 'scout':
        return { hex: SCOUT_HEX, texts: ['开拔'] }
      case 'scout-supply':
        return { hex: SCOUT_HEX, texts: ['补给'] }
      case 'strafe-1':
      case 'strafe-2':
        return strikeTarget()
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
        hint: '霍特：把补给表上的 SP 落到高亮格。',
        intro: 'SP 是油和弹药，装甲没有它就动不了。',
        done: () => hasSupplyArrival() || phaseAtLeast(workbench.phase, 'movement'),
      },
      {
        id: 'advance-rebuild',
        title: '进入重建段',
        hint: '霍特：补给发完，点「进入下一环节」到重建段。',
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
        hint: '霍特：右键这堆 →「加油」→ 编队法，油从补给堆里扣。',
        intro: '支付流程：整堆一次付清，燃料点从该格补给堆（SP）里扣；堆里没有补给就得先补运。',
        done: () => stackUnits.value.some((unit) => unit.fuelled),
      },
      {
        id: 'scout',
        title: '侦察营绕进 18.26',
        hint: '霍特：只选 30 侦察营，开拔 → 绕到 18.26。',
        intro: '履带与徒步单位可以无视敌方控制区（ZOC）穿行；侦察营正好绕到坦克师侧后。',
        done: () => scoutInPlace(),
      },
      {
        id: 'scout-supply',
        title: '补给接不上',
        hint: '霍特：看见了？中间是沼泽，补给线过不去。',
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
        id: 'barrage-city',
        title: '弹幕轰小城',
        hint: '霍特：炮兵弹幕打 19.27 的守军。',
        intro: '弹幕先扣补给点、再按轰炸表结算（10.0a）：炸出 DG，城里就软了。',
        done: () => cityBarraged(),
      },
      {
        id: 'bombing',
        title: '空军轰大城',
        hint: '霍特：四机齐出，轰 19.28 的大城守军。',
        intro:
          'Ju.88 与 Do.17z 投弹、两架 Bf.110 护航；苏军 I.153 起飞拦截——它打不过护航（14.3e）。',
        done: () => bombingDone(),
      },
      {
        id: 'reaction-attack',
        title: '苏军坦克师反扑',
        hint: '霍特：他们另一支坦克师扑上来了，顶住。',
        intro: '反应段苏军释放预备、照 9.2 打一轮——按他们的兵力，这一下必输（苏军失败）。',
        done: () =>
          aiSoviet.value
            ? phaseAtLeast(workbench.phase, 'combat')
            : reaction.value === 'done' || reaction.value === 'skipped',
      },
      {
        id: 'capture-city',
        title: '打下小城 19.27',
        hint: '霍特：轮到我们了——进攻 19.27，把城格拿下来。',
        intro: '战斗阶段由你宣布进攻：补给 → AR → 地形 → 奇袭 → 骰面，走完就是你的城。',
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
   * · 轰炸（10.0a）：四机轰炸值 12+8+5+5 = 30 ⇒ 初始列 25-40；骰面 11 ⇒ 「1」
   *   （DG + 1 点军力损失），随后由玩家在「确认受损单位」里落盘。
   */
  watch(
    () => workbench.airState,
    (state) => {
      if (!active.value || state === null || state.finished) return
      if (state.kind !== 'barrage' || state.targetHex === null) return
      if (!sameHex(state.targetHex, BOMB_HEX)) return
      if (state.step === 'interception') {
        workbench.airInputs.interceptDie = 6
        workbench.airInputs.interceptLossDie = 1
      }
      if (state.step === 'flak') {
        workbench.airInputs.flakDie = 12
        workbench.airInputs.lossDie = 1
      }
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

    if (tk.mode.mode !== 'reserve') {
      tk.mode = { mode: 'reserve', orientation: 'move', dg: false, exploit: false }
      tk.raw = tk.faces.move
    }
    workbench.selectedId = tk.instanceId
    if (!workbench.releaseReserveNow()) return false

    workbench.beginMovePick(tk.hex, [tk.instanceId])
    if (!workbench.confirmMovePick()) return false
    /*
     * 2026-11-20：侦察营的教学绕行点就在 18.26 ⇒ 苏军不能再用它当中转格。
     * 从「与防守格相邻」的候选里挑第一个可达格（18.28 / 17.28 等），找不到就放弃脚本。
     */
    const stageCandidates: HexRef[] = [
      REACTION_STAGE,
      { col: 18, row: 28 },
      { col: 17, row: 28 },
      { col: 19, row: 28 },
    ].filter((hex) => hexDistance(defense, hex) === 1)
    const node = (workbench.groupReachable?.hexes ?? []).find((item) =>
      stageCandidates.some((hex) => sameHex(item.hex, hex)),
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
      // 2026-11-19：苏军是 AI ⇒ 反应阶段归 AI 打，脚本不再代打（否则会和 AI 抢同一批动作）
      if (aiSoviet.value) return
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
