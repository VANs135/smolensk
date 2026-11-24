import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { createAiMemory, runAiStep } from '@/ai/driver'
import { canonicalMode } from '@/engine/rules'
import { actionGateOf, useTutorialStore } from '@/stores'

import { fresh } from './flow-harness'

/**
 * 通规 5.7b / 5.7b-B / 8.1 / 8.1a：**反应阶段苏军坦克师释放预备 → 突袭轴方摩步 → 失败**
 *
 * 口径来源（用户 2026-11-23 裁定 + 2026-11-24 分层）：
 *   · **教学模式是单独的初设**：坦克师的「预备 + 移动面」与苏方 2 枚预备额度由
 *     `src/stores/tutorial.ts` 的初设脚本（`applyTeachingSetup`，走 IV-B 同一判定 + 会话覆盖）
 *     在本局给出；
 *   · **非教学模式的 Vitebsk 按规则书放置**：`18 Tk Div` 留在印面的战斗面，苏方卡面无 Reserve
 *     行 ⇒ `setup.reserveMarkers.soviet = 0`（数据里就是这两个值）；
 *   · 苏联没有飞机：剧本数据只有轴方 7 架（`aircraft` 行全在 `side: axis`）。
 *
 * 本文件的反应链用例按「教学局的初设状态」摆盘（`beginIntroSetup` 用与脚本相同的两个公开入口：
 * `setSetupOverride` + `setUnitModeAtSetup`）；真实的脚本路径由
 * `tests/stores/tutorial-mode.test.ts` 与下面「教学模式：初设脚本」一条覆盖。
 *
 * 两条规则硬约束决定「坦克师必须**以移动面**进预备」：
 *   ① 5.7b-B：反应段释放的预备只按**半个 MA**移动，但突袭中拥有完整战斗值；
 *   ② 8.1a：每次突袭固定 3 MP，剩余 MP 不足 3 的单位不能突袭；
 *   ⇒ 战斗面 `20-1-3`（MA 3）在反应段只有 1.5 MP，规则上**无法突袭**；
 *     移动面 `10-0-8`（MA 8）在反应段有 4 MP，够一次突袭（打完剩 1 MP，不能再突）。
 *   5.7a 允许进预备时翻任意面，所以「移动面进预备」本身合法。
 *
 * 只预设备 18 Tk Div（19.26）：它是教学反扑脚本用的那一辆，邻格 18.26 正是轴方摩步位。
 * 14 Tk Div（18.27）留在印面的战斗面 —— 它是轴方开局突袭的目标，若也挂预备，
 * 5.7 会把它防御减半，教学首战与整条掷骰链都会变。
 *
 * 本次突袭的结果（本剧本种子 20261115）：攻击 10 对守方 76/90 两个摩托化步兵团（各 8-4，
 * 守方合计 16、AR 4）⇒ 1:2 列、修正骰 3（AR 0−4）⇒ CRT `AL2`：攻方 2 步全灭、守方零损失
 * 且留在格内 —— 正是「突袭然后失败」。
 */

type Ctx = ReturnType<typeof fresh>
type W = Ctx['w']

/** 教学局的初设状态：先按规则书进初设，再由教学的两个公开入口补上苏方额度与坦克师模式 */
function beginIntroSetup(seed = 20261115): Ctx {
  const ctx = fresh()
  ctx.w.seed = seed
  expect(ctx.setup.enterSetup('Intro')).toBe(true)
  // 与 `tutorial.applyTeachingSetup` 同一入口：额度先立（5.4a 闸门读 `session.setupData`）
  ctx.g.setSetupOverride({ reserveMarkers: { soviet: 2 } })
  const tank = unitNamed(ctx.w, 'Ru 18 Tk Div')
  expect(ctx.w.setUnitModeAtSetup('reserve', 'move', [tank.instanceId])).toBe(true)
  expect(ctx.setup.presetSelfSetupNow().failures).toEqual([])
  expect(ctx.w.initialSetupInProgress).toBe(true)
  return ctx
}

/** 初设收束（抽签 + 开局） */
function startIntro(ctx: Ctx): void {
  expect(ctx.setup.startGameNow()).toBe(true)
  if (ctx.setup.setupDrawEntryVisible) expect(ctx.setup.drawSetupEffectsNow()).toBe(true)
  expect(ctx.setup.startGameNow()).toBe(true)
}

function unitNamed(w: W, name: string) {
  const unit = w.units.find((item) => item.name === name)
  if (unit === undefined) throw new Error(`盘面上没有 ${name}`)
  return unit
}

/** 初设右键改模式（IV-B）：把坦克师改成指定朝向的预备，用来钉住「另一种摆法」的分支 */
function setTankReserve(w: W, name: string, orientation: 'move' | 'combat'): void {
  const tank = unitNamed(w, name)
  // 5.7a：进预备时可任选朝向 ⇒ 一次设定即可（不必先退回战斗模式再进）
  expect(w.setUnitModeAtSetup('reserve', orientation, [tank.instanceId])).toBe(true)
  expect(tank.mode.mode).toBe('reserve')
  expect(tank.mode.orientation).toBe(orientation)
  expect(tank.mode.releasedFromReserve).not.toBe(true)
}

/** 反应段的苏联运动环节（7.0a：非阶段玩家的反应阶段） */
async function toSovietReactionMovement(w: W): Promise<void> {
  w.setPhase('reaction')
  w.setSegmentStepIndex(w.playerSegmentSteps.findIndex((step) => step.id === 'reaction.movement'))
  await nextTick()
}

/** 12.5c-C：从苏方补给站按单独单位法付 1T（12.5a：履带战斗单位未加油不能消耗 MP） */
function fuelTank(w: W, tankId: string): void {
  const dump = w.fuelDumpChoices.find((item) => item.side === 'soviet')
  expect(dump, '苏方没有可付款的补给站').toBeDefined()
  expect(w.pickFuelDump(dump!.id)).toBe(true)
  w.payFuel('singleUnit')
  expect(w.units.find((unit) => unit.instanceId === tankId)?.fuelled).toBe(true)
}

/**
 * 位置夹具：把 20 Mtr Div 的两个摩托化步兵团摆到坦克师邻格（18.26）。
 *
 * 只固定**位置**（轴方把它们推到坦克师跟前是本教学剧本的既定走法），不代替 6.x 的走格判据，
 * 也不改任何规则状态；本组用例的主题是 5.7b-B 的释放与 8.1a 的突袭门槛。
 */
function moveAxisMotInfTo(w: W, hex: { col: number; row: number }): void {
  const targets = w.units.filter(
    (unit) => unit.side === 'axis' && unit.name.includes('20.Mtr') && unit.name.includes('Mot Inf'),
  )
  expect(targets).toHaveLength(2)
  for (const unit of targets) unit.hex = { ...hex }
}

/** 走完 9.2 的补给 → AR → 地形 → 奇袭 → 掷骰 */
function driveCombatSteps(w: W): void {
  let guard = 0
  let declared = false
  while (guard < 24) {
    guard += 1
    const state = w.combatState
    if (state === null || state.finished) break
    if (state.step === 'combatSupply') {
      if (!declared) {
        for (const entry of w.combatSupplyDumps) {
          if (w.combatSupplyDumpIds[entry.side] !== null) continue
          const dump = entry.dumps[0]
          if (dump !== undefined) w.pickCombatSupplyDump(entry.side, dump.id)
        }
        declared = true
      }
      if (!w.confirmCombatSupply()) break
      continue
    }
    if (state.step === 'declareAr') {
      if (w.combatInputs.attackerArUnitId === null)
        w.combatInputs.attackerArUnitId = w.combatAttackers[0]?.instanceId ?? null
      if (!w.declareCombatArStep('attacker')) break
      if (w.combatInputs.defenderArUnitId === null)
        w.combatInputs.defenderArUnitId = w.battleDefenders[0]?.instanceId ?? null
      if (!w.declareCombatArStep('defender')) break
      continue
    }
    if (state.step === 'declareTerrain') {
      if (!w.declareCombatTerrainStep()) break
      continue
    }
    if (state.step === 'surprise') {
      if (!w.rollCombatSurprise()) break
      if (w.combatAwaitingShiftDie) w.rollCombatShiftDie()
      continue
    }
    if (state.step === 'battleDice') {
      if (!w.rollCombatDice()) break
      continue
    }
    break
  }
}

/** 结算第 8 步：损失优先（军力不够时才用撤退），并把撤退/推进步走完 */
function driveResolution(w: W): void {
  let guard = 0
  while (guard < 20) {
    guard += 1
    const state = w.combatState
    if (state === null || state.finished) break
    if (state.step === 'losses') {
      if (!w.confirmCombatLosses()) break
      continue
    }
    if (state.step === 'options') {
      const requirement = w.combatRequirement!
      const units =
        state.resolution.stage === 'attackerOptions' ? w.combatAttackers : w.battleDefenders
      const capacity = units.reduce((sum, unit) => sum + unit.steps, 0)
      if (requirement.options <= capacity) {
        w.combatInputs.optionRetreatHexes = 0
        w.combatInputs.optionLossPoints = requirement.options
      } else {
        w.combatInputs.optionRetreatHexes = requirement.options
        w.combatInputs.optionLossPoints = 0
      }
      if (!w.confirmCombatOptions()) break
      continue
    }
    if (state.step === 'retreat') {
      for (const plan of w.combatRetreatPlans) {
        for (const row of plan.units) {
          const dest = row.destinations[0]
          if (dest !== undefined) w.setRetreatDestinationNow(row.unitId, dest.hex)
        }
      }
      if (!w.confirmCombatRetreats()) break
      continue
    }
    break
  }
}

describe('Intro：反应阶段的苏军坦克师', () => {
  it('非教学模式的 Vitebsk 按规则书放置：18 Tk Div 印面战斗面、苏方没有预备额度、苏方没有飞机', () => {
    const ctx = fresh()
    ctx.w.seed = 20261115
    expect(ctx.setup.enterSetup('Intro')).toBe(true)
    expect(ctx.setup.presetSelfSetupNow().failures).toEqual([])
    expect(ctx.setup.startGameNow(), ctx.setup.lastAction?.detail).toBe(true)
    const w = ctx.w

    // 用户 2026-11-24：非教学模式的 Vitebsk 剧本要按照规则书放置 —— 坦克师模式不要改
    const tank = unitNamed(w, 'Ru 18 Tk Div')
    expect(tank.mode.mode).toBe('combat')
    expect(tank.mode.orientation).toBe('combat')
    expect(tank.raw).toMatchObject({ attack: 20, ar: 1, ma: 3 })
    const tank14 = unitNamed(w, 'Ru 14 Tk Div')
    expect(tank14.mode.mode).toBe('combat')
    expect(tank14.raw).toMatchObject({ attack: 20, ar: 1, ma: 3 })
    // 也不要放预备：卡面苏方栏没有 Reserve 行 ⇒ 额度 0，盘上一枚预备都没有
    expect(w.reserveMarkerStatusOf('soviet')).toMatchObject({ cap: 0, used: 0 })
    expect(w.reservedHexes('soviet')).toEqual([])
    // 苏联没有飞机：剧本数据只有轴方 7 架
    expect(w.airUnits).toHaveLength(7)
    expect(w.airUnits.every((air) => air.side === 'axis')).toBe(true)
  })

  it('教学模式：初设脚本单独把 18 Tk Div 落成「预备 + 移动面」，苏方额度 2 只在本局（不写进剧本数据）', async () => {
    const ctx = fresh()
    const tutorial = useTutorialStore()
    tutorial.stop()
    tutorial.startFor()
    expect(ctx.setup.enterSetup('Intro')).toBe(true)
    // 初设脚本是 watcher（flush: post）⇒ 等它真的落下（坦克师进盘 + 模式转预备），不赌固定 tick 数
    const tankOf = () => ctx.w.units.find((unit) => unit.name === 'Ru 18 Tk Div')
    for (let guard = 0; guard < 10 && tankOf()?.mode.mode !== 'reserve'; guard += 1)
      await nextTick()
    expect(tankOf()?.mode.mode).toBe('reserve')
    const w = ctx.w

    // 剧本数据仍按规则书（0 枚），教学那 2 枚是会话覆盖
    expect(ctx.g.scenarioInfo?.setup.reserveMarkers.soviet).toBe(0)
    expect(ctx.g.setupData?.reserveMarkers.soviet).toBe(2)

    const tank = unitNamed(w, 'Ru 18 Tk Div')
    expect(tank.mode.mode).toBe('reserve')
    expect(tank.mode.orientation).toBe('move')
    expect(tank.mode.releasedFromReserve).not.toBe(true)
    // 5.4a：印值随朝向取（移动面 10-0-8，战斗面 20-1-3）
    expect(tank.raw).toMatchObject({ attack: 10, ar: 0, ma: 8 })
    expect(tank.faces.combat).toMatchObject({ attack: 20, ar: 1, ma: 3 })
    // 5.4a：按格计 —— 只占 19.26 一格；额度是教学的 2 枚
    expect(w.reservedHexes('soviet')).toEqual(['19.26'])
    expect(w.reserveMarkerStatusOf('soviet')).toMatchObject({ cap: 2, used: 1 })
    // 14 Tk Div 是轴方开局突袭的目标，留在印面的战斗面（挂预备会被 5.7 减半防御）
    const tank14 = unitNamed(w, 'Ru 14 Tk Div')
    expect(tank14.mode.mode).toBe('combat')
    expect(tank14.raw).toMatchObject({ attack: 20, ar: 1, ma: 3 })
    // IV-B：初设右键仍可改（脚本只是给了一个合法初态，不是锁死）
    expect(w.setupSwitchableModesOf(tank.instanceId)).toContain('combat')
    tutorial.stop()
  })

  it('战斗面进预备：反应段只有 1.5 MP ⇒ 8.1a 拒突袭（不是 6.1g「没有单位在移动」）', async () => {
    const ctx = beginIntroSetup()
    const w = ctx.w
    // 本组按教学局的摆法（坦克师已在 18.27 邻格）；这里按玩家的另一种摆法改成战斗面进预备，
    // 钉住「战斗面在反应段不能突袭」
    setTankReserve(w, 'Ru 14 Tk Div', 'combat')
    expect(unitNamed(w, 'Ru 14 Tk Div').raw).toMatchObject({ attack: 20, ma: 3 })
    startIntro(ctx)

    await toSovietReactionMovement(w)
    const tank = unitNamed(w, 'Ru 14 Tk Div')
    w.selectedId = tank.instanceId
    expect(w.releaseReserveNow()).toBe(true)
    expect(w.beginMoveFor([tank.instanceId])).toBe(false) // 12.5a：未加油
    fuelTank(w, tank.instanceId)
    expect(w.beginMoveFor([tank.instanceId])).toBe(true)
    // 5.7b-B：半 MA ⇒ 3 × 0.5
    expect(w.moveMinRemainingMp).toBe(1.5)

    moveAxisMotInfTo(w, { col: 18, row: 26 })
    await nextTick()
    expect(w.overrunNow({ col: 18, row: 26 })).toBe(false)
    // 8.1a 的门槛：剩余不足 3 MP；单位其实还在移动，不能报成 6.1g
    expect(w.log[0]?.rule).toBe('8.1a')
    expect(w.log[0]?.text).toContain('1.5')
  })

  it('PVE：苏方归 AI 时，AI 在反应段自己按 5.7b 释放 18 Tk Div（否则 5.7g 永远拦住段末推进）', async () => {
    const ctx = beginIntroSetup()
    const w = ctx.w
    startIntro(ctx)
    await toSovietReactionMovement(w)

    // 修前：段末 5.7g 拦住推进（19.26 是印刷工事格，坦克师仍挂预备）⇒ AI 只会反复 `advance` 被拒，
    // 自对打/人机都「连续 3 次无进展」卡死
    expect(w.currentAdvanceBlock?.rule).toBe('5.7g')

    const step = runAiStep(
      { workbench: w, session: ctx.g, setup: ctx.setup },
      { control: 'soviet' },
    )
    const tank = unitNamed(w, 'Ru 18 Tk Div')
    expect(step.intent).toBe(`reserveRelease:${tank.instanceId}`)
    expect(step.ok).toBe(true)
    // 7.0a：反应段「本环节可参与」只列**已释放的预备**。修前这里整段为空
    // （`participant` 把行动方当阶段玩家喂给引擎 ⇒ 6.3a 一律拒）⇒ 非阶段玩家连点都点不中
    expect(w.participatingUnitIds).toContain(tank.instanceId)
    // 5.7b：标记已摘 ⇒ 规范模式回到朝向那一面（引擎的表示是保留 `mode:'reserve'` +
    // `releasedFromReserve`，由 `canonicalMode` 折回）；本阶段 MA ×0.5 由引擎照常算
    expect(canonicalMode(tank.mode)).toBe('move')
    expect(tank.mode.releasedFromReserve).toBe(true)
    expect(tank.raw).toMatchObject({ attack: 10, ma: 8 })
    expect(w.log.some((line) => line.text.includes('已释放预备（5.7b）'))).toBe(true)
    // 阻断源已消失 ⇒ 下一步就能正常推进（不再是「3 次无进展」）
    expect(w.currentAdvanceBlock).toBeNull()
  })

  it('PVE：释放后 AI 自己付 1T 燃料再开拔（12.5a / 12.5c-C），5.7b-B 的半 MA 才用得上', async () => {
    const ctx = beginIntroSetup()
    const w = ctx.w
    startIntro(ctx)
    await toSovietReactionMovement(w)
    const aiCtx = { workbench: w, session: ctx.g, setup: ctx.setup }
    const memory = createAiMemory()

    // 修前：AI 没有付油入口 ⇒ 释放完的坦克师一枚也开拔不了（`12.5a 未加油`），教学反扑链断在这里
    const first = runAiStep(aiCtx, { memory, control: 'soviet' })
    const tankId = unitNamed(w, 'Ru 18 Tk Div').instanceId
    expect(first.intent).toBe(`reserveRelease:${tankId}`)

    const second = runAiStep(aiCtx, { memory, control: 'soviet' })
    expect(second.intent).toBe(`fuelPay:${tankId}`)
    expect(second.ok).toBe(true)
    expect(unitNamed(w, 'Ru 18 Tk Div').fuelled).toBe(true)
    expect(w.log.some((line) => line.text.includes('燃料已付') && line.rule === '12.5c-C')).toBe(
      true,
    )

    const third = runAiStep(aiCtx, { memory, control: 'soviet' })
    expect(third.intent).toBe(`moveBegin:${tankId}`)
    expect(third.ok).toBe(true)
    // 5.7b-B：反应段释放的预备只按半个 MA 移动（移动面 8 × 0.5 = 4），够 8.1a 的一次突袭
    expect(w.moveMinRemainingMp).toBe(4)
  })

  it('全程：释放 → 加油 1T → 突袭轴方摩步 → 攻方 AL2 被打光、守方留格（「突袭然后失败」）', async () => {
    const ctx = beginIntroSetup()
    const w = ctx.w
    // 不做任何初设右键：教学局的坦克师由初设脚本带成「预备 + 移动面」，玩家一路走到反应段即可
    startIntro(ctx)

    await toSovietReactionMovement(w)
    const tank = unitNamed(w, 'Ru 18 Tk Div')
    w.selectedId = tank.instanceId

    // 5.7b：非阶段玩家在反应段释放自己的预备 ⇒ 回到朝向面，本阶段 MA ×0.5
    expect(w.releaseReserveNow()).toBe(true)
    expect(w.log.some((line) => line.text.includes('已释放预备（5.7b）'))).toBe(true)

    fuelTank(w, tank.instanceId)
    expect(w.beginMoveFor([tank.instanceId])).toBe(true)
    // 移动面 8 × 0.5 = 4 MP：够 8.1a 的一次突袭
    expect(w.moveMinRemainingMp).toBe(4)

    moveAxisMotInfTo(w, { col: 18, row: 26 })
    await nextTick()

    // 8.0：从相邻格发起；8.1a：每次突袭固定 3 MP
    expect(w.overrunNow({ col: 18, row: 26 })).toBe(true)
    expect(w.combatState?.attackType).toBe('overrun')
    expect(
      w.log.some(
        (line) => line.text.includes('每次 3 MP（8.1a）') && line.text.includes('守方 2 个'),
      ),
    ).toBe(true)

    driveCombatSteps(w)
    driveResolution(w)

    // 结果：CRT AL2 ⇒ 2 步的坦克师被打光；守方两枚摩托化步兵团零损失、仍占 18.26
    expect(w.log.some((line) => line.text.includes('AL2'))).toBe(true)
    expect(w.units.some((unit) => unit.name === 'Ru 18 Tk Div')).toBe(false)
    const defenders = w.units.filter(
      (unit) =>
        unit.side === 'axis' && unit.name.includes('20.Mtr') && unit.name.includes('Mot Inf'),
    )
    expect(defenders.map((unit) => `${unit.steps}@${unit.hex.col}.${unit.hex.row}`)).toEqual([
      '1@18.26',
      '1@18.26',
    ])
    // 8.0/8.1f：参突者已不在盘面 ⇒ 就地收束，不留"还在移动"的幽灵
    expect(w.overrunContext).toBeNull()
    expect(w.activeMoveUnits).toHaveLength(0)

    // 7.0a：反应段只给移动 / 突袭 / 轰炸，常规战斗宣布不在本段
    expect(actionGateOf('combat.declare').where.every((where) => where.phase !== 'reaction')).toBe(
      true,
    )
  })
})
