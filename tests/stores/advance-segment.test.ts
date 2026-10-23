import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'

import { SOP_STEPS } from '@/engine/session-flow'
import { sopStepById } from '@/engine/rules'
import {
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useMapViewStore,
  useWorkbenchStore,
  actionGateOf,
  participatesIn,
  type ActionKey,
  type ConsolePhase,
} from '@/stores'

/**
 * B5：唯一「进入下一环节」（自动段连跑完，停到需要玩家的地方）
 *
 * 用户口径（2026-09-16 ⑩）：「点击进入下一个阶段后，**自动进行的阶段不需要玩家介入**，
 * 直到开始玩家要介入的环节……新的必须是点击**自动进入下一环节**，不需要额外的按钮」；
 * 「自动阶段一定要自动进行……玩家要做的第一件事：若存在需要玩家决定的事件**先让玩家决定**，
 * 然后判定先后手选择」。
 *
 * 本文件钉四件事：
 *   ① 一次点击把自动段跑完，停在**玩家环节**（A–G）而不是只走一步；
 *   ② 需要玩家决定时**停下待答**（且此后再点不会硬闯）；
 *   ③ 首回合的先手判定由剧本指定 ⇒ **不算"需要玩家决定"**，不该白白停一次；
 *   ④ 换环节时盘面中间态自动收束（半截的移动/战斗/地图选择集不能带到下一段）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { session: useGameSessionStore(), workbench: useWorkbenchStore() }
}

/**
 * 该单位此刻是否**参与突围环节**（12.8e）
 *
 * 直接问 B7 那条唯一谓词（`participatesIn`），而不是另写一句判据——
 * 这样"无事可做"与"实现缺口"两件事才能分开断言。
 */
function breakoutParticipation(
  workbench: ReturnType<typeof newStores>['workbench'],
  unitId: string,
): boolean {
  const unit = workbench.units.find((item) => item.instanceId === unitId)
  if (unit === undefined) throw new Error(`找不到单位 ${unitId}`)
  return participatesIn({
    unit,
    phase: 'movement',
    segment: 'movement.breakout',
    activeSide: workbench.activeSide,
  }).ok
}

/**
 * B8：把 store 放到**本段里允许做该动作的那个环节**
 *
 * 段内动作只在对应环节放行（用户口径：「每个环节只能执行该环节能进行的操作」）。
 * 用 B7 的闸门表反查环节，而不是写死序号或环节名。
 */
function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

describe('B5：唯一「进入下一环节」（自动段连跑）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('未开局 ⇒ 一次连跑为 0 步且被拒（不静默当作"跑完了"）', () => {
    const outcome = stores.session.advanceToNextStop()
    expect(outcome.steps).toBe(0)
    expect(outcome.stoppedBy).toBe('refused')
    expect(stores.session.error).not.toBeNull()
  })

  it('开局后一次点击：自动段跑完（天气 + 先手判定）⇒ 停在**先手方 A 飞机整备段**', () => {
    const { session } = stores
    session.startGame()

    const outcome = session.advanceToNextStop()

    // 首回合先手由剧本指定 ⇒ 先手判定不发问；故连跑两步（天气 → 先手判定）即落到玩家环节
    expect(outcome.stoppedBy).toBe('player')
    expect(outcome.steps).toBe(2)
    expect(outcome.driver).toBe('player')
    expect(session.guidance?.step.id).toBe('first.aircraftRefit')
    // 反空转：确实推进到了 A 段，而不是停在 Pre-Turn
    expect(session.records?.phase).toBe('aircraftRefit')
  })

  it('再点一次 ⇒ 只推一段（玩家环节之间一次只走一步，不替玩家做决定）', () => {
    const { session } = stores
    session.startGame()
    session.advanceToNextStop()

    const outcome = session.advanceToNextStop()

    expect(outcome.steps).toBe(1)
    expect(outcome.stoppedBy).toBe('player')
    expect(session.guidance?.step.id).toBe('first.reinforcement')
  })

  it('自动段在日志里连续出现（天气与先手判定相邻两条，中间没有玩家动作）', () => {
    const { session } = stores
    session.startGame()
    session.advanceToNextStop()

    const tail = session.log.slice(-2).map((entry) => entry.action)
    expect(tail).toEqual(['weather', 'initiative'])
  })

  it('待答时停下；此时再点一步也不走（作答前不硬闯）', () => {
    const { session } = stores
    session.startGame()
    // 第 2 回合的先手判定要**玩家选择**（2.3）：一路推到那里
    for (let guard = 0; guard < SOP_STEPS.length; guard += 1) {
      session.advanceToNextStop()
      if (session.awaiting) break
      if (session.terminated) break
    }
    expect(session.awaiting).toBe(true)
    expect(session.question?.kind).toBe('initiative')

    const outcome = session.advanceToNextStop()
    expect(outcome.steps).toBe(0)
    expect(outcome.stoppedBy).toBe('question')
  })

  it('作答后继续：连跑会继续把自动段跑完再停', () => {
    const { session } = stores
    session.startGame()
    for (let guard = 0; guard < SOP_STEPS.length; guard += 1) {
      session.advanceToNextStop()
      if (session.awaiting || session.terminated) break
    }
    expect(session.awaiting).toBe(true)

    // 2.3：选项是「先手 / 后手」（不是"哪一方"）——胜者选择本方先行动还是后行动
    expect(session.answerNow('first')).toBe(true)
    expect(session.awaiting).toBe(false)

    const outcome = session.advanceToNextStop()
    expect(outcome.stoppedBy).toBe('player')
    expect(outcome.driver).toBe('player')
    expect(outcome.steps).toBeGreaterThanOrEqual(1)
  })

  it('回合末的自动收束：后手方最后一段之后自动清理 → 回合结束 → 判天气，停在下一回合先手判定（待答）', () => {
    const { session } = stores
    session.startGame()
    // 推到「后手方 G 进击段」（本回合最后一个玩家环节）
    for (let guard = 0; guard < SOP_STEPS.length * 3; guard += 1) {
      session.advanceToNextStop()
      if (session.terminated) break
      if (session.guidance?.step.id === 'second.exploitation') break
      if (session.awaiting) session.answerNow('first')
    }
    expect(session.guidance?.step.id).toBe('second.exploitation')
    const turnBefore = session.records!.turn

    const outcome = session.advanceToNextStop()

    // 一次点击跨过：G 段结束 → H 清理（自动）→ 回合结束（自动）→ 下回合天气（自动）→ 停下待答
    expect(outcome.stoppedBy).toBe('question')
    expect(outcome.steps).toBeGreaterThanOrEqual(4)
    expect(session.records?.turn).toBe(turnBefore + 1)
    expect(session.guidance?.step.id).toBe('preTurn.firstPlayerDetermination')
    // 反空转：H 清理段**从头到尾没让玩家停过**（2.2：清理是全自动）
    expect(session.log.filter((entry) => entry.action === 'turnEnd').length).toBeGreaterThanOrEqual(
      1,
    )
  })
})

describe('B5：换环节时盘面中间态自动收束', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('换段清掉半截的移动（上一段的现场不能带到下一段）', () => {
    const { session, workbench } = stores
    const record = unitChoices('axis').find(
      (item) => item.classes?.movementClass === 'leg' && item.attackCapable === true,
    )!
    workbench.units.push(
      toConsoleUnit({ record, instanceId: 'a1', hex: { col: 36, row: 13 }, side: 'axis' }),
    )
    session.startGame()
    // 走流程合法地停在**移动段**（A 整备 → B 增援 → C 移动）：不走流程而手动切段会与
    // 会话内部的步指针对不上，`advanceSession` 会以"内外不一致"拒绝（本用例当场验证到这一点）
    session.advanceToNextStop()
    session.advanceToNextStop()
    session.advanceToNextStop()
    expect(session.records?.phase).toBe('movement')

    // 玩家在移动段做了一半：选中一枚进入移动交互
    // 条 10（批 M）：点格只建取子清单，开拔交由「开始移动」按钮
    workbench.clickHex({ col: 36, row: 13 })
    expect(workbench.confirmMovePick()).toBe(true)
    expect(workbench.moveInteraction).not.toBeNull()

    /*
     * ★ B8 起「进入下一环节」先走**段内的环节链**（C 段 = 突围 → 模式与移动 → 轰炸），
     *   环节走完才换段。故这里点满本段剩余环节，直到段真的变动。
     */
    const stepsLeft = workbench.playerSegmentSteps.length
    expect(stepsLeft).toBeGreaterThan(0)
    for (let i = 0; i < stepsLeft; i += 1) {
      if (session.records?.phase !== 'movement') break
      workbench.advanceSegmentNow()
    }

    expect(session.records?.phase).toBe('supply')
    expect(workbench.moveInteraction).toBeNull()
  })

  it('B8：换段前先在段内走完环节链（C 段，且环节内不许做别环的事）', () => {
    const { session, workbench } = stores
    session.startGame()
    session.advanceToNextStop()
    session.advanceToNextStop()
    session.advanceToNextStop()
    expect(session.records?.phase).toBe('movement')

    /*
     * ★ 突围（12.8e）在 store 里**没有实现**（`ACTION_KEYS_WITHOUT_STORE_ENTRY`）⇒ 它不占"当前环节"，
     *   否则每次移动阶段都要先白点一下、期间还动不了任何单位。故 C 段一进来就停在「模式与移动」。
     */
    expect(workbench.segmentStep?.id).toBe('movement.modeAndMovement')
    expect(workbench.playerSegmentSteps.map((step) => step.id)).toEqual([
      'movement.modeAndMovement',
      'movement.barrage',
    ])
    // 本环允许移动；不允许宣告战斗（那是 F 段的事）
    expect(workbench.requireAction('move.order', '移动')).toBe(true)
    expect(workbench.requireAction('combat.declare', '宣告战斗')).toBe(false)
    expect(workbench.actionRefusal?.key).toBe('combat.declare')

    // 点一次 ⇒ 轰炸环（此时移动不再放行、轰炸放行）
    expect(workbench.stepToNextSegmentStep()).toBe(true)
    expect(workbench.segmentStep?.id).toBe('movement.barrage')
    expect(workbench.requireAction('move.order', '移动')).toBe(false)
    expect(workbench.requireAction('barrage.declare', '宣布轰炸')).toBe(true)

    // 环节走完 ⇒ 下一次点击才换段
    expect(workbench.stepToNextSegmentStep()).toBe(false)
  })

  it('突围环节（12.8e）：本方**无事可做**时自动跳过（用户裁定②）', () => {
    const { session, workbench } = stores
    session.startGame()
    session.advanceToNextStop()
    session.advanceToNextStop()
    session.advanceToNextStop()
    expect(session.records?.phase).toBe('movement')

    // 链上**确实有**突围这一环（不是把它从链条里删掉），且标了 skipWhenIdle
    const breakout = sopStepById('movement.breakout')!
    expect(workbench.segmentSteps.map((step) => step.id)).toContain('movement.breakout')
    expect(breakout.skipWhenIdle).toBe(true)

    /*
     * 此刻盘上没有算子 ⇒ 突围环节**无人可参与**（12.8e 要求"断补 + 战斗单位"）⇒ 无事可做 ⇒ 跳过，
     * 玩家一进 C 段就停在「模式与移动」，不必先点一次空环节。
     */
    expect(workbench.participatingUnitIds).toEqual([])
    expect(workbench.playerSegmentSteps.map((step) => step.id)).toEqual([
      'movement.modeAndMovement',
      'movement.barrage',
    ])
  })

  it('突围环节：有断补单位 ⇒ **占**当前环节（B47 起入口已就位）', () => {
    const { session, workbench } = stores
    const record = unitChoices('axis').find(
      (item) => item.classes?.movementClass === 'leg' && item.attackCapable === true,
    )!
    // 一枚**断补**的本方战斗单位 ⇒ 12.8e 的突围资格成立（participatesIn 对该环返回 ok）
    const cutOff = toConsoleUnit({
      record,
      instanceId: 'cut-off',
      hex: { col: 36, row: 13 },
      side: 'axis',
    })
    // `toConsoleUnit` 的初值是"开局视为有补给"（12.6 的评估在补给阶段做）⇒ 这里显式标成断补
    cutOff.hasTraceSupply = false
    workbench.units.push(cutOff)
    session.startGame()
    session.advanceToNextStop()
    session.advanceToNextStop()
    session.advanceToNextStop()
    expect(session.records?.phase).toBe('movement')

    /*
     * 12.8e 首回合豁免：把它标成"本回合才开始连续断补"（连续无补给的起点回合），
     * 否则 `canBreakout` 还要过「A 可用路径 / B 15 格内有追补友军」才能突围，
     * 而这枚孤立单位并不满足 ⇒ 突围环节会被 `stepHasWork`（条 6 / R3 已按 `canBreakout` 收紧）
     * 判为"无活"而跳过。这里要验的正是「有（首回合）断补单位 ⇒ 环节占住」，
     * 故按 12.8e 首回合豁免把它做成真能突围，而不是造一个"进得去出不去"的死环节。
     * 必须经由 workbench.units 的响应式代理改 `cutSinceTurn`，否则 `breakoutCandidates` 不会重算。
     */
    const cutOffRef = workbench.units.find((unit) => unit.instanceId === 'cut-off')!
    cutOffRef.cutSinceTurn = workbench.turn

    /*
     * ★ B47（2026-09-17）起口径变了：**突围环节有入口了**（store 的 `breakoutNow` / `breakoutCandidates`
     *   + 移动面板的「可尝试突围的单位」一节，SOP 的 `implemented: false` 已摘掉）⇒ 有断补单位在场时
     *   它就该**占住当前环节**、由玩家决定突不突（12.8e）。
     *   修前这里钉的是相反的事实（"仍被跳过，只因入口尚未实现"）——那是实现缺口的留痕，不是规则行为，
     *   所以要随接线一起改，而不是留着假装规则如此。
     */
    expect(breakoutParticipation(workbench, 'cut-off')).toBe(true)
    expect(workbench.playerSegmentSteps.map((step) => step.id)).toContain('movement.breakout')
    expect(sopStepById('movement.breakout')!.implemented).not.toBe(false)
  })

  it('B8：自动环节不占"当前环节"（自动段不需要玩家介入）', () => {
    const { session, workbench } = stores
    session.startGame()
    session.advanceToNextStop()
    session.advanceToNextStop() // ⇒ B 增援段
    expect(session.records?.phase).toBe('reinforcement')

    // B 段的链首是「补员表掷骰（自动）」⇒ 玩家一进来就该停在「到货」而不是停在自动环上
    expect(workbench.segmentStep?.id).toBe('reinforcement.arrival')
    expect(workbench.playerSegmentSteps.every((step) => step.driver !== 'automatic')).toBe(true)
    expect(workbench.requireAction('rein.arrival', '到达投放')).toBe(true)
    // 同一段里"重建"在别的环节 ⇒ 此刻被拒（每个环节只能做该环节的事）
    expect(workbench.requireAction('rein.rebuild', '重建')).toBe(false)
    expect(workbench.actionRefusal?.key).toBe('rein.rebuild')
  })

  it('换环节 ⇒ 地图上的就地展开与选择集自动清空（用户口径 §4.2③）', async () => {
    const { session, workbench } = stores
    const mapView = useMapViewStore()
    const record = unitChoices('axis').find(
      (item) => item.classes?.movementClass === 'leg' && item.attackCapable === true,
    )!
    for (const instanceId of ['s0', 's1']) {
      workbench.units.push(
        toConsoleUnit({ record, instanceId, hex: { col: 36, row: 13 }, side: 'axis' }),
      )
    }
    session.startGame()
    session.advanceToNextStop()
    // 摊开该格（B3 的就地展开）—— 条 8 裁定①：展开**不默认选中**（无默认选）
    mapView.expandStackAt({ col: 36, row: 13 })
    expect(mapView.stackSelection).toEqual([])

    workbench.advanceSegmentNow()
    // 选择集由 `map-view` 的 watch 收束（换段即触发）⇒ 等一拍让侦听器跑完
    await nextTick()

    expect(mapView.stackSelection).toEqual([])
    expect(mapView.expandedStack).toBeNull()
  })

  it('有进行中的会话框（战斗）时拒绝进入下一环节，并给出规则号', () => {
    const { workbench } = stores
    workbench.setPhase('combat')
    goToActionStep(workbench, 'combat.declare')
    workbench.setTool('battle')
    workbench.setFuelPool(0, 20)
    const attacker = unitChoices('axis').find(
      (item) =>
        item.isCombat === true &&
        item.attackCapable === true &&
        item.classes?.movementClass === 'leg',
    )!
    const defender = unitChoices('soviet').find((item) => item.isCombat === true)!
    workbench.units.push(
      toConsoleUnit({ record: attacker, instanceId: 'a1', hex: { col: 1, row: 2 }, side: 'axis' }),
      toConsoleUnit({
        record: defender,
        instanceId: 'd1',
        hex: { col: 1, row: 1 },
        side: 'soviet',
      }),
    )
    workbench.clickHex({ col: 1, row: 2 })
    workbench.clickHex({ col: 1, row: 1 })
    expect(workbench.beginCombatNow()).toBe(true)
    stores.session.startGame()

    // 战斗进行中 ⇒ 拒绝（null），且把原因记进**操作台日志**（不是会话日志）并带规则号
    expect(workbench.advanceSegmentNow()).toBeNull()
    expect(workbench.log[0]?.rule).toBe('9.2')
  })

  it('拒绝后不改变段（战斗没被顺手清掉）', () => {
    const { workbench } = stores
    workbench.setPhase('combat')
    goToActionStep(workbench, 'combat.declare')
    workbench.setTool('battle')
    workbench.setFuelPool(0, 20)
    const attacker = unitChoices('axis').find(
      (item) =>
        item.isCombat === true &&
        item.attackCapable === true &&
        item.classes?.movementClass === 'leg',
    )!
    const defender = unitChoices('soviet').find((item) => item.isCombat === true)!
    workbench.units.push(
      toConsoleUnit({ record: attacker, instanceId: 'a1', hex: { col: 1, row: 2 }, side: 'axis' }),
      toConsoleUnit({
        record: defender,
        instanceId: 'd1',
        hex: { col: 1, row: 1 },
        side: 'soviet',
      }),
    )
    workbench.clickHex({ col: 1, row: 2 })
    workbench.clickHex({ col: 1, row: 1 })
    workbench.beginCombatNow()
    stores.session.startGame()
    const phaseBefore = workbench.phase

    workbench.advanceSegmentNow()

    expect(workbench.phase).toBe(phaseBefore)
    expect(workbench.combatState).not.toBeNull()
  })
})
