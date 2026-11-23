import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { actionGateOf } from '@/stores'

import { fresh } from './flow-harness'

/**
 * 通规 5.7b / 5.7b-B / 8.1 / 8.1a：**反应阶段苏军坦克师释放预备 → 突袭轴方摩步 → 失败**
 *
 * 口径来源（用户 2026-11-23 裁定）：教学剧本 `Intro: Vitebsk` 的苏联反应阶段应当这样走通。
 * 卡面本身没有这一行（`Smolensk_Vitebsk_Scenario.pdf` 的苏方栏无 Reserve，轴方栏才是
 * `Reserve Markers Available: 5`）⇒ `setup.reserveMarkers.soviet = 2` 是教学用途增设，
 * 数值出处写在 `scenarios.json` 该剧本 `setup.source` 的第 2 条里。
 *
 * 两条规则硬约束决定「坦克师必须**以移动面**进预备」：
 *   ① 5.7b-B：反应段释放的预备只按**半个 MA**移动，但突袭中拥有完整战斗值；
 *   ② 8.1a：每次突袭固定 3 MP，剩余 MP 不足 3 的单位不能突袭；
 *   ⇒ 战斗面 `20-1-3`（MA 3）在反应段只有 1.5 MP，规则上**无法突袭**；
 *     移动面 `10-0-8`（MA 8）在反应段有 4 MP，够一次突袭（打完剩 1 MP，不能再突）。
 *   5.7a 允许进预备时翻任意面，所以「移动面进预备」本身合法。
 *
 * 本次突袭的结果（本剧本种子 20261115）：攻击 10 对守方 76/90 两个摩托化步兵团（各 8-4，
 * 守方合计 16、AR 4）⇒ 1:2 列、修正骰 3（AR 0−4）⇒ CRT `AL2`：攻方 2 步全灭、守方零损失
 * 且留在格内 —— 正是「突袭然后失败」。
 */

type Ctx = ReturnType<typeof fresh>
type W = Ctx['w']

/** 走到「初设已摆完、尚未开始游戏」——初设右键「初设模式」（IV-B）只在这段时间可用 */
function beginIntroSetup(seed = 20261115): Ctx {
  const ctx = fresh()
  ctx.w.seed = seed
  expect(ctx.setup.enterSetup('Intro')).toBe(true)
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

/** 初设：先设移动面（5.7a 进预备可翻任意面，这里为 8.1a 的 3 MP 门槛取 MA 8）再进预备 */
function setTankReserve(w: W, name: string, orientation: 'move' | 'combat' = 'move'): void {
  const tank = unitNamed(w, name)
  if (orientation === 'move') {
    expect(w.setUnitModeAtSetup('move', 'move', [tank.instanceId])).toBe(true)
  }
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
  it('苏方 reserve 2（教学裁定）：初设可把两辆坦克师设为「移动面 → 预备」，两格正好用满 2 枚', () => {
    const ctx = beginIntroSetup()
    const w = ctx.w

    // IV-B：4 种主动模式都可设；苏方此刻能选到 move / reserve
    const tank14 = unitNamed(w, 'Ru 14 Tk Div')
    expect(w.setupSwitchableModesOf(tank14.instanceId)).toContain('move')
    expect(w.setupSwitchableModesOf(tank14.instanceId)).toContain('reserve')

    setTankReserve(w, 'Ru 14 Tk Div')
    setTankReserve(w, 'Ru 18 Tk Div')

    // 5.7a：朝向＝移动面；5.4a：印值随朝向取
    for (const name of ['Ru 14 Tk Div', 'Ru 18 Tk Div']) {
      const tank = unitNamed(w, name)
      expect(tank.raw).toMatchObject({ attack: 10, ar: 0, ma: 8 })
      expect(tank.faces.combat).toMatchObject({ attack: 20, ar: 1, ma: 3 })
    }
    // 5.4a：按格计 —— 两辆在两格，正好用满 2 枚
    expect(w.reservedHexes('soviet')).toEqual(['18.27', '19.26'])
  })

  it('战斗面进预备：反应段只有 1.5 MP ⇒ 8.1a 拒突袭（不是 6.1g「没有单位在移动」）', async () => {
    const ctx = beginIntroSetup()
    const w = ctx.w
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

  it('全程：释放 → 加油 1T → 突袭轴方摩步 → 攻方 AL2 被打光、守方留格（「突袭然后失败」）', async () => {
    const ctx = beginIntroSetup()
    const w = ctx.w
    setTankReserve(w, 'Ru 14 Tk Div')
    startIntro(ctx)

    await toSovietReactionMovement(w)
    const tank = unitNamed(w, 'Ru 14 Tk Div')
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
    expect(w.units.some((unit) => unit.name === 'Ru 14 Tk Div')).toBe(false)
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
