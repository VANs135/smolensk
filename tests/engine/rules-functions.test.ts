import { describe, expect, it } from 'vitest'

import { aircraft, chartsCrt, rulesConstants } from '@/data'
import {
  activeStackingLimit,
  airBaseBuildCostSp,
  airCombatModifiedRoll,
  airTransportTerrainIsClosed,
  baseAaValue,
  canHipShoot,
  canMissionInPhase,
  canPlannedAirdrop,
  computeCombatSupplyCost,
  computeDensityShift,
  computeDumpBlowLoss,
  computeFlakDrm,
  computeLoadingCost,
  crtTerrainLine,
  flakAppliesToMission,
  flakKillCheck,
  getAllPermanentHedgehogs,
  getPermanentHedgehogLevel,
  getPrintedHedgehog,
  getRailCap,
  hasPermanentHedgehog,
  hedgehogBuildCostSp,
  hedgehogCombatDrm,
  isAirMissionAllowedInPhase,
  isEarlySturmovikOneStep,
  isEntryLShutDown,
  isInRandomEventPeriod,
  isPrintedHedgehogPermanent,
  isRailCapBoosted,
  isSouthSourcesShutDown,
  isSpecialReplAvailable,
  isVariableExitActive,
  isWithinStackingLimit,
  optionalAirdropTerrainDrm,
  parseCrtResultCell,
  refitCapacityPerLevel,
  resolveAirBaseCapture,
  resolveAirCombat,
  resolveAirTransportSuccess,
  resolveBarrage,
  resolveBarrageVsFacility,
  resolveCombat,
  resolveModeStats,
  resolveRatioColumnIndex,
  resolveWeather,
  rollVariableExit,
} from '@/engine/rules'
import type { ModeState } from '@/engine/rules'

/**
 * engine/rules 业务函数测试
 *
 * 断言全部以已封版数据为基准（charts-crt.json / charts-tables.json / charts-tec.json /
 * map-layers.json / rules-constants.json），不引入数据层之外的臆造期望值。
 */
describe('CRT 结果记号解析（9.9 / 9.10）', () => {
  it('`AL1o1 Do1`：攻方损失 1 且有 1 点选项；守方 1 点选项、不损失', () => {
    const r = parseCrtResultCell('AL1o1 Do1')
    expect(r.attacker).toEqual({ losses: 1, hasOption: true, optionPoints: 1 })
    expect(r.defender).toEqual({ losses: 0, hasOption: true, optionPoints: 1, disorganized: false })
  })

  it('`Ao1 e4 DL1o2`：独立 e# 记号归攻方；守方的 `o2` 是 **2 点**选项（9.10a）', () => {
    const r = parseCrtResultCell('Ao1 e4 DL1o2')
    expect(r.attacker).toEqual({
      losses: 0,
      hasOption: true,
      optionPoints: 1,
      exploitationAR: 4,
    })
    expect(r.defender).toEqual({ losses: 1, hasOption: true, optionPoints: 2, disorganized: false })
  })

  it('`Ae2 DL2o3DG`：攻方进击门槛 2；守方损失 2、3 点选项且混乱', () => {
    const r = parseCrtResultCell('Ae2 DL2o3DG')
    expect(r.attacker).toEqual({ losses: 0, hasOption: false, optionPoints: 0, exploitationAR: 2 })
    expect(r.defender).toEqual({ losses: 2, hasOption: true, optionPoints: 3, disorganized: true })
  })

  it('`AL2`：无守方段时守方为零结果', () => {
    const r = parseCrtResultCell('AL2')
    expect(r.attacker).toEqual({ losses: 2, hasOption: false, optionPoints: 0 })
    expect(r.defender).toEqual({
      losses: 0,
      hasOption: false,
      optionPoints: 0,
      disorganized: false,
    })
  })

  it('源库 195 格的全部格值都能解析，且攻守分段与原文记号一致', () => {
    const cells = [...new Set(chartsCrt.crt.matrix.flat())]
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) {
      const parsed = parseCrtResultCell(cell)
      expect(parsed.raw).toBe(cell)
      // 原文无守方段（不含 D 起首记号）时，守方必须是零结果
      const tokens = cell.split(/\s+/).filter(Boolean)
      const hasDefenderSection = tokens.some((token) => token.startsWith('D'))
      if (!hasDefenderSection) {
        expect(parsed.defender).toEqual({
          losses: 0,
          hasOption: false,
          optionPoints: 0,
          disorganized: false,
        })
      } else {
        expect(parsed.defender.disorganized).toBe(cell.includes('DG'))
      }
      // 攻方段必定存在（本表每格都给出攻方结果）
      expect(parsed.attacker.losses).toBeGreaterThanOrEqual(0)
      // 选项点数必须与原文 o# 一致（9.10a 的全部自由度都在这个数字上）
      for (const side of ['attacker', 'defender'] as const) {
        const section = cell
          .split(/\s+/)
          .filter(Boolean)
          .filter((token) => (side === 'attacker' ? token.startsWith('A') : token.startsWith('D')))
          .join('')
        expect(parsed[side].optionPoints).toBe(Number(section.match(/o(\d+)/)?.[1] ?? 0))
      }
      // 进击门槛记号 e# 只可能出现在攻方
      const eToken = tokens.find((token) => /^e\d+$/.test(token))
      if (eToken) expect(parsed.attacker.exploitationAR).toBe(Number(eToken.slice(1)))
    }
  })
})

describe('CRT 地形列位（取自 TEC combatLine）', () => {
  it('格内地形映射到正确战斗线', () => {
    expect(crtTerrainLine('Open')).toBe('Open')
    expect(crtTerrainLine('Woods')).toBe('Close')
    expect(crtTerrainLine('Forest')).toBe('Close')
    expect(crtTerrainLine('Swamp')).toBe('Very Close')
    expect(crtTerrainLine('Village')).toBe('Close')
    expect(crtTerrainLine('Minor City')).toBe('Very Close')
    expect(crtTerrainLine('Major City')).toBe('Extr Close')
  })

  it('格边地形（原文 ot）返回 null', () => {
    expect(crtTerrainLine('Minor River')).toBeNull()
    expect(crtTerrainLine('Railroad')).toBeNull()
    expect(crtTerrainLine('Lake/Blocked')).toBeNull()
  })
})

describe('CRT 军力比归列（向下取整偏向守方）', () => {
  const open = [
    '1:5',
    '1:4',
    '1:3',
    '1:2',
    '1:1',
    '2:1',
    '3:1',
    '4:1',
    '5:1',
    '7:1',
    '9:1',
    '11:1',
    '13:1',
  ]

  it('恰好命中列位', () => {
    expect(open[resolveRatioColumnIndex(open, 10, 10)]).toBe('1:1')
    expect(open[resolveRatioColumnIndex(open, 3, 1)]).toBe('3:1')
  })

  it('未命中时归入不超过「取整后比值」的最大列（9.7 取整 + 9.7a 取列）', () => {
    // 5:2 = 2.5 → 4.2 向上取整为 3 → 归入 3:1（★ 4.2 是四舍五入，不是向下取整）
    expect(open[resolveRatioColumnIndex(open, 5, 2)]).toBe('3:1')
    // 3:2 = 1.5 → 取整为 2 → 2:1
    expect(open[resolveRatioColumnIndex(open, 3, 2)]).toBe('2:1')
    // 7:4 = 1.75 → 取整为 2 → 2:1
    expect(open[resolveRatioColumnIndex(open, 7, 4)]).toBe('2:1')
    // 1:10 = 0.1 → 低于最小列 1:5，归入最小列
    expect(open[resolveRatioColumnIndex(open, 1, 10)]).toBe('1:5')
  })
})

describe('CRT 查表（9.9）', () => {
  it('Open、1:1、修正骰 7 → `AL1o1 Do1`', () => {
    const r = resolveCombat({
      die: 7,
      attackerAR: 5,
      defenderAR: 5,
      terrainLine: 'Open',
      attackerA: 10,
      defenderA: 10,
    })
    expect(r.raw).toBe('AL1o1 Do1')
    expect(r.modifiedDice).toBe(7)
    expect(r.ratio).toBe('1:1')
    expect(r.attacker.losses).toBe(1)
    expect(r.defender.losses).toBe(0)
  })

  it('Open、1:1、修正骰 15（高 AR）→ `Ae4 DL1o2`', () => {
    const r = resolveCombat({
      die: 12,
      attackerAR: 5,
      defenderAR: 2,
      terrainLine: 'Open',
      attackerA: 10,
      defenderA: 10,
    })
    expect(r.modifiedDice).toBe(15)
    expect(r.raw).toBe('Ae4 DL1o2')
    expect(r.attacker.exploitationAR).toBe(4)
    expect(r.defender.losses).toBe(1)
  })

  it('工事等级按公式从修正骰中扣减', () => {
    const r = resolveCombat({
      die: 12,
      attackerAR: 5,
      defenderAR: 5,
      hedgehogLevel: 2,
      terrainLine: 'Open',
      attackerA: 10,
      defenderA: 10,
    })
    expect(r.modifiedDice).toBe(10)
    expect(r.raw).toBe('Ao1 Do1')
  })

  it('Extr Close、1:1、修正骰 7 → 仅攻方结果 `AL1o1`', () => {
    const r = resolveCombat({
      die: 7,
      attackerAR: 5,
      defenderAR: 5,
      terrainLine: 'Extr Close',
      attackerA: 10,
      defenderA: 10,
    })
    expect(r.raw).toBe('AL1o1')
    expect(r.defender).toEqual({
      losses: 0,
      hasOption: false,
      optionPoints: 0,
      disorganized: false,
    })
  })

  it('非法骰值抛错', () => {
    expect(() =>
      resolveCombat({
        die: 13,
        attackerAR: 5,
        defenderAR: 5,
        terrainLine: 'Open',
        attackerA: 10,
        defenderA: 10,
      }),
    ).toThrow(RangeError)
  })
})

describe('轰炸查表（10.0）', () => {
  it('密度列移：1 RE 及以下左移 1 列，其后按表递增（10.0a 密度表）', () => {
    expect(computeDensityShift(undefined)).toBe(0)
    expect(computeDensityShift(1)).toBe(-1)
    expect(computeDensityShift(3)).toBe(0)
    expect(computeDensityShift(4)).toBe(1)
    expect(computeDensityShift(5)).toBe(2)
    expect(computeDensityShift(6)).toBe(3)
    expect(computeDensityShift(9)).toBe(4)
  })

  it('最低值段 + 最低骰 → `-`，成本 1 T', () => {
    const r = resolveBarrage({ die: 2, valueRange: 1 })
    expect(r.code).toBe('-')
    expect(r.costT).toBe(1)
  })

  it('最高值段 + 最高骰 → `3`，成本 10 T', () => {
    const r = resolveBarrage({ die: 12, valueRange: 117 })
    expect(r.code).toBe('3')
    expect(r.costT).toBe(10)
  })

  it('无观察员左移 3 列', () => {
    const withSpotter = resolveBarrage({ die: 7, valueRange: 25 })
    const withoutSpotter = resolveBarrage({ die: 7, valueRange: 25, hasSpotter: false })
    expect(withoutSpotter.finalColumn).toBe(withSpotter.finalColumn - 3)
  })

  it('对设施轰炸：81+ 值段 + 骰 4 → `2 * (4)`，成本 8 T', () => {
    const r = resolveBarrageVsFacility(4, 90)
    expect(r.code).toBe('2 * (4)')
    expect(r.costT).toBe(8)
  })

  it('对设施轰炸：最低档 → `-`', () => {
    expect(resolveBarrageVsFacility(1, 1).code).toBe('-')
  })
})

describe('空军（14.0 / 15.0）', () => {
  it('空战退出判定：≤6 攻退、=7 双方、≥8 守退', () => {
    expect(resolveAirCombat(6).abortSide).toBe('attacker')
    expect(resolveAirCombat(7).abortSide).toBe('both')
    expect(resolveAirCombat(8).abortSide).toBe('defender')
  })

  it('分出胜负后掷损失骰：1–4 无损失、5–6 损失军力', () => {
    expect(resolveAirCombat(8, 4).winnerLossRoll).toBe('no_loss')
    expect(resolveAirCombat(8, 5).winnerLossRoll).toBe('step_loss')
    expect(resolveAirCombat(8, 5).lossAppliesTo).toBe('defender')
  })

  it('双方返航（修正骰 = 7）同样掷损失骰，且适用于双方返航者（14.3e-C）', () => {
    const both = resolveAirCombat(7, 6)
    expect(both.abortSide).toBe('both')
    expect(both.winnerLossRoll).toBe('step_loss')
    expect(both.lossAppliesTo).toBe('both')
    expect(resolveAirCombat(7, 3).winnerLossRoll).toBe('no_loss')
  })

  it('防空击落阈值 11', () => {
    expect(flakKillCheck(10)).toBe(false)
    expect(flakKillCheck(11)).toBe(true)
  })

  it('整备容量 = 每级 2 架', () => {
    expect(refitCapacityPerLevel(3)).toBe(6)
  })
})

/**
 * 通规空军基线（series_rules_v43.air 14.x/15.x）：
 * 这些是默认行为，专规（2.2 苏联 / 3.2a 轴心）在其之上覆盖。
 */
describe('通规空军基线（14.x / 15.x）', () => {
  it('空战修正骰 = 2d6 + 攻方空战值 − 守方空战值（14.3e）', () => {
    expect(airCombatModifiedRoll(7, 3, 1)).toBe(9)
    expect(airCombatModifiedRoll(7, 1, 3)).toBe(5)
  })

  it('防空适用任务（14.4e）：always 恒适用 / onlyInPatrolZone 视巡逻区 / never 不适用', () => {
    expect(flakAppliesToMission('barrage', false)).toBe(true)
    expect(flakAppliesToMission('hip_shoot', false)).toBe(true)
    expect(flakAppliesToMission('air_drop', false)).toBe(false)
    expect(flakAppliesToMission('air_drop', true)).toBe(true)
    expect(flakAppliesToMission('fighter_sweep', true)).toBe(false)
    expect(flakAppliesToMission('interception', true)).toBe(false)
  })

  it('防空修正合计（14.4e 表 17-3）', () => {
    // 三机 +1、目标有 HQ +1、基地 2 级 +2、任务编成**无战斗机** +2
    expect(
      computeFlakDrm({
        missionAircraftCount: 3,
        targetHasHQ: true,
        airBaseLevel: 2,
        inEnemyPatrolZone: true,
        missionHasFighter: false,
      }),
    ).toBe(6)
    // 印刷防空值 +value 直接相加
    expect(
      computeFlakDrm({
        missionAircraftCount: 1,
        targetHasHQ: false,
        printedFlakValue: 2,
        inEnemyPatrolZone: false,
      }),
    ).toBe(2)
  })

  it('空运/空投成功表（14.10d 表 17-4）：四档门槛 + 三项 DRM', () => {
    // 己方 Clear 需 5+（2 骰之和直接比较）
    expect(resolveAirTransportSuccess({ die2d6: 5, friendly: true, closed: false })).toMatchObject({
      success: true,
      threshold: 5,
      modified: 5,
      drm: 0,
    })
    // 敌方 Closed 需 7+；6 不足
    expect(resolveAirTransportSuccess({ die2d6: 6, friendly: false, closed: true })).toMatchObject({
      success: false,
      threshold: 7,
      modified: 6,
    })
    // 苏军空投 −1（任何时间）
    expect(
      resolveAirTransportSuccess({ die2d6: 5, friendly: true, closed: false, sovietAirdrop: true }),
    ).toMatchObject({ success: false, modified: 4, drm: -1 })
    // 滑翔机降落 +1（14.10e-E）
    expect(
      resolveAirTransportSuccess({ die2d6: 5, friendly: true, closed: true, glider: true }),
    ).toMatchObject({ success: true, threshold: 6, modified: 6, drm: 1 })
    // 可选 21.12e 的地形 DRM
    expect(optionalAirdropTerrainDrm('Very Close')).toBe(-1)
    expect(optionalAirdropTerrainDrm('Extr Close')).toBe(-2)
    expect(optionalAirdropTerrainDrm('Open')).toBe(0)
    expect(
      resolveAirTransportSuccess({
        die2d6: 5,
        friendly: true,
        closed: false,
        optionalTerrainDrm: optionalAirdropTerrainDrm('Extr Close'),
      }),
    ).toMatchObject({ success: false, modified: 3 })
  })

  it('表 17-4 的 Clear/Closed 判据（Open 或 Village，或含空军基地的格 ⇒ Clear）', () => {
    expect(airTransportTerrainIsClosed({ terrainsInHex: ['Open'], hasAirBase: false })).toBe(false)
    expect(airTransportTerrainIsClosed({ terrainsInHex: ['Village'], hasAirBase: false })).toBe(
      false,
    )
    // 含空军基地的格一律 Clear（表 17-4 原文）
    expect(airTransportTerrainIsClosed({ terrainsInHex: ['Woods'], hasAirBase: true })).toBe(false)
    expect(airTransportTerrainIsClosed({ terrainsInHex: ['Woods'], hasAirBase: false })).toBe(true)
    expect(airTransportTerrainIsClosed({ terrainsInHex: ['Major City'], hasAirBase: false })).toBe(
      true,
    )
  })

  it('空军基地夺取（9.14f）：2d6 ≥7 无损失', () => {
    expect(resolveAirBaseCapture(7)).toBe('no_loss')
    expect(resolveAirBaseCapture(6)).toBe('step_loss')
  })

  it('基地防空值与 Active 堆叠（15.0b / 14.2a）', () => {
    expect(baseAaValue(3)).toBe(3)
    expect(baseAaValue(3, true)).toBe(0) // 简易机场防空值 0
    expect(activeStackingLimit(2)).toBe(6) // 4 + 2
  })
})

/**
 * 专规 2.2「Red Air Force」+ 3.2a：在通规基线之上覆盖，
 * 且 2.2 只针对**苏联空军**（源库 exclusive_rules_smolensk.soviet_special.air）。
 */
describe('专规空军覆盖（2.2 苏联 / 3.2a 轴心）', () => {
  const axisFighter = aircraft.aircraft.find((a) => a.side === 'axis' && a.aircraftType === 'F')!

  it('2.2a 低空扫射：通规允许；专规下苏军禁、轴方天气允许时可', () => {
    expect(canHipShoot('soviet', true)).toBe(false)
    expect(canHipShoot('soviet', false)).toBe(false)
    expect(canHipShoot('axis', true)).toBe(true)
    expect(canHipShoot('axis', false)).toBe(false) // 天气层仍生效
  })

  it('2.2c 反应/进击阶段任务：苏军禁；轴方可；移动阶段皆可', () => {
    expect(canMissionInPhase('soviet', 'reaction')).toBe(false)
    expect(canMissionInPhase('soviet', 'exploitation')).toBe(false)
    expect(canMissionInPhase('soviet', 'movement')).toBe(true)
    expect(canMissionInPhase('axis', 'reaction')).toBe(true)
    expect(canMissionInPhase('axis', 'exploitation')).toBe(true)
  })

  it('2.2b 计划空降：苏军禁、轴方可；型别无空投能力时亦禁', () => {
    expect(canPlannedAirdrop('soviet')).toBe(false)
    expect(canPlannedAirdrop('axis')).toBe(true)
    expect(canPlannedAirdrop('axis', { airAbilities: { canAirDrop: false } })).toBe(false)
  })

  it('2.2d 早期 IL-2 单军力标记只出现在 IL-2 型别上', () => {
    const il2 = aircraft.aircraft.find((a) => a.aircraftId.includes('il-2'))!
    expect(isEarlySturmovikOneStep(il2)).toBe(true)
    expect(isEarlySturmovikOneStep(axisFighter)).toBe(false)
  })

  it('专规限制确为苏联专属：12 苏联型均带 no_hip_shoots，10 轴心型均无', () => {
    const soviet = aircraft.aircraft.filter((a) => a.side === 'soviet')
    const axis = aircraft.aircraft.filter((a) => a.side === 'axis')
    expect(soviet).toHaveLength(12)
    expect(axis).toHaveLength(10)
    expect(soviet.every((a) => (a.specialAbilities ?? []).includes('no_hip_shoots'))).toBe(true)
    expect(axis.every((a) => (a.specialAbilities ?? []).includes('no_hip_shoots'))).toBe(false)
  })
})

describe('补给（12.0）', () => {
  it('12.4 战斗补给：攻方按**军力点数** 1 T/step、守方 2 T/场', () => {
    expect(computeCombatSupplyCost({ attackerSteps: 5, defenderRE: 3 })).toEqual({
      attackerT: 5,
      defenderT: 2,
    })
  })

  it('12.4：守方总 RE ≤ 1 时补给降为 1 T', () => {
    expect(computeCombatSupplyCost({ attackerSteps: 2, defenderRE: 1 })).toEqual({
      attackerT: 2,
      defenderT: 1,
    })
  })

  it('12.11a 补给站爆破损失百分比', () => {
    expect(computeDumpBlowLoss(1)).toBe(25)
    expect(computeDumpBlowLoss(3)).toBe(50)
    expect(computeDumpBlowLoss(5)).toBe(75)
    expect(computeDumpBlowLoss(6)).toBe(100)
  })
})

describe('模式改写（5.0）', () => {
  const raw = { attack: 10, ar: 5, ma: 6, barrage: 8 }
  const combat: ModeState = { mode: 'combat', orientation: 'combat', dg: false, exploit: false }

  it('战斗模式（无被动标记）：数值不变，可攻击/突袭/轰炸并投射 ZOC', () => {
    expect(resolveModeStats(raw, combat, 'movement')).toMatchObject({
      attack: 10,
      defense: 10,
      ar: 5,
      ma: 6,
      barrage: 8,
      canAttack: true,
      canBarrage: true,
      canOverrun: true,
      exertsZoc: true,
      effectiveMode: 'combat',
    })
  })

  it('DG（5.10b）：战斗/轰炸/移动减半、行动值 −1；不能突袭、不投射 ZOC', () => {
    const r = resolveModeStats(raw, { ...combat, dg: true }, 'movement')
    expect(r).toMatchObject({
      attack: 5,
      defense: 5,
      ar: 4,
      ma: 3,
      barrage: 4,
      canOverrun: false,
      exertsZoc: false,
      disorganized: true,
      effectiveMode: 'dg',
    })
  })

  it('战略（5.8）：移动 ×2、战斗值与行动值归零；不可攻击/轰炸/突袭/ZOC', () => {
    const r = resolveModeStats(
      raw,
      { mode: 'strat', orientation: 'move', dg: false, exploit: false },
      'movement',
    )
    expect(r).toMatchObject({
      attack: 0,
      defense: 0,
      ar: 0,
      ma: 12,
      canAttack: false,
      canBarrage: false,
      canOverrun: false,
      exertsZoc: false,
    })
  })

  it('预备（5.7）：被释放前不可攻击/轰炸/突袭、防御减半；MA 常规 1/4、反应释放 1/2、进击释放 1', () => {
    const r = { attack: 10, ar: 5, ma: 8 }
    const reserve: ModeState = { mode: 'reserve', orientation: 'combat', dg: false, exploit: false }
    expect(resolveModeStats(r, reserve, 'movement')).toMatchObject({
      attack: 10,
      defense: 5,
      ma: 2,
      canAttack: false,
      canBarrage: false,
      canOverrun: false,
    })
    expect(resolveModeStats(r, { ...reserve, releasedFromReserve: true }, 'reaction').ma).toBe(4)
    expect(resolveModeStats(r, { ...reserve, releasedFromReserve: true }, 'exploitation').ma).toBe(
      8,
    )
  })

  it('进击（5.9）：移动 ×1/2，战斗与轰炸值正常', () => {
    const r = resolveModeStats(raw, { ...combat, exploit: true }, 'exploitation')
    expect(r).toMatchObject({
      attack: 10,
      ar: 5,
      ma: 3,
      barrage: 8,
      canAttack: true,
      effectiveMode: 'exploit',
    })
  })

  it('6.1h：减少后的 MA 永不取整（DG 下 MA 5 → 2.5）', () => {
    const r = resolveModeStats({ attack: 1, ar: 1, ma: 5 }, { ...combat, dg: true }, 'movement')
    expect(r.ma).toBe(2.5)
  })
})

describe('环形工事（16.0 / 专规 1.3a）', () => {
  it('共 57 个印刷永久工事（源库 59 − 改判 36.18 − 改判 7.8）', () => {
    expect(getAllPermanentHedgehogs()).toHaveLength(57)
    // 两处改判格都不得再生：36.18（2026-09-14 目检）、7.8（2026-09-15 像素复核）
    expect(hasPermanentHedgehog(36, 18)).toBe(false)
    expect(hasPermanentHedgehog(7, 8)).toBe(false)
  })

  it('已知工事格（20,7）等级为 1', () => {
    expect(hasPermanentHedgehog(20, 7)).toBe(true)
    expect(getPermanentHedgehogLevel(20, 7)).toBe(1)
  })

  it('非工事格等级为 0', () => {
    expect(hasPermanentHedgehog(1, 1)).toBe(false)
    expect(getPermanentHedgehogLevel(1, 1)).toBe(0)
  })

  it('16.0d：战斗 DRM = **−工事等级**（对守方有利）', () => {
    expect(hedgehogCombatDrm(2)).toBe(-2)
    expect(hedgehogCombatDrm(1)).toBe(-1)
    expect(hedgehogCombatDrm(0)).toBe(0)
  })

  it('专规 1.3a：印刷工事全部「永久且不可降低」', () => {
    expect(isPrintedHedgehogPermanent(20, 7)).toBe(true)
    expect(isPrintedHedgehogPermanent(1, 1)).toBe(false)
    expect(getPrintedHedgehog(20, 7)).toMatchObject({
      level: 1,
      permanent: true,
      cannotReduce: true,
    })
    expect(getPrintedHedgehog(1, 1)).toBeNull()
  })
})

describe('专规时点工具', () => {
  it('铁路容量提升（1.2）', () => {
    expect(isRailCapBoosted('1941-07-18')).toBe(false)
    expect(isRailCapBoosted('1941-07-19')).toBe(true)
  })

  it('可变撤离开始（3.3c）', () => {
    expect(isVariableExitActive('1941-08-18')).toBe(false)
    expect(isVariableExitActive('1941-08-19')).toBe(true)
  })

  it('随机事件期（3.6）', () => {
    expect(isInRandomEventPeriod('1941-07-18')).toBe(false)
    expect(isInRandomEventPeriod('1941-07-19')).toBe(true)
    expect(isInRandomEventPeriod('1941-08-15')).toBe(true)
    expect(isInRandomEventPeriod('1941-08-16')).toBe(false)
  })

  it('特殊补员截止（1.6c）', () => {
    expect(isSpecialReplAvailable('1941-08-18')).toBe(true)
    expect(isSpecialReplAvailable('1941-08-19')).toBe(false)
  })

  it('补给源关闭（2.1a）', () => {
    expect(isEntryLShutDown('1941-07-18')).toBe(false)
    expect(isEntryLShutDown('1941-07-19')).toBe(true)
    expect(isSouthSourcesShutDown('1941-08-19')).toBe(true)
  })
})

describe('天气（专规 1.5）', () => {
  it('掷 1 → 受限飞行；掷 2–6 → 正常飞行', () => {
    expect(resolveWeather(1)).toMatchObject({ air: 'limited', isLimited: true })
    expect(resolveWeather(2)).toMatchObject({ air: 'normal', isLimited: false })
    expect(resolveWeather(6).ground).toBe('good')
  })

  it('受限飞行下反应/进击阶段禁飞', () => {
    const limited = resolveWeather(1)
    const normal = resolveWeather(4)
    expect(isAirMissionAllowedInPhase(limited, 'movement')).toBe(true)
    expect(isAirMissionAllowedInPhase(limited, 'reaction')).toBe(false)
    expect(isAirMissionAllowedInPhase(limited, 'exploitation')).toBe(false)
    expect(isAirMissionAllowedInPhase(normal, 'reaction')).toBe(true)
  })

  it('受限飞行禁止低空扫射（口径唯一在 canHipShoot：天气 + 专规 2.2a/3.2a）', () => {
    // 受限飞行 ⇒ 双方都不行（天气那一半）
    expect(canHipShoot('axis', resolveWeather(1).air === 'normal')).toBe(false)
    expect(canHipShoot('soviet', resolveWeather(1).air === 'normal')).toBe(false)
    // 普通飞行 ⇒ 轴方可行；苏方另受专规 2.2a 禁止
    expect(canHipShoot('axis', resolveWeather(4).air === 'normal')).toBe(true)
    expect(canHipShoot('soviet', resolveWeather(4).air === 'normal')).toBe(
      !rulesConstants.smolensk.air.soviet.noHipShoot,
    )
  })
})

describe('铁路容量（专规 1.2）', () => {
  it('提升前：轴 0 / 苏 2', () => {
    expect(getRailCap('1941-07-15', 'axis')).toBe(0)
    expect(getRailCap('1941-07-15', 'soviet')).toBe(2)
  })

  it('提升日（1941-07-19）起：轴 1 / 苏 3', () => {
    expect(getRailCap('1941-07-19', 'axis')).toBe(1)
    expect(getRailCap('1941-07-20', 'soviet')).toBe(3)
  })
})

describe('可变撤离（专规 3.3c）', () => {
  it('开始日之前一律跳过', () => {
    const r = rollVariableExit(3, '1941-07-01')
    expect(r.kind).toBe('skipped')
    expect(r.active).toBe(false)
  })

  it('掷 1 → 移除 SS Reich 全部', () => {
    const r = rollVariableExit(1, '1941-08-20')
    expect(r.kind).toBe('remove')
    expect(r.removedUnit).toBe('SS Reich')
  })

  it('掷 6 → 移除 14 Mtr 全部', () => {
    const r = rollVariableExit(6, '1941-08-20')
    expect(r.kind).toBe('remove')
    expect(r.removedUnit).toBe('14 Mtr')
  })

  it('掷 2–5 → 下回合再掷', () => {
    for (const die of [2, 3, 4, 5]) {
      expect(rollVariableExit(die, '1941-08-20').kind).toBe('reroll')
    }
  })
})

describe('建造与移动消费函数', () => {
  it('环形工事建造花费：每级 2 SP，等级按**本作上限 1**封顶（专规 1.3b）', () => {
    expect(hedgehogBuildCostSp(1)).toBe(2)
    expect(hedgehogBuildCostSp(6)).toBe(2) // min(6,1) × 2：16.0a 的 4 级刻度被专规 1.3b 压到 1 级
  })

  it('空军基地建造花费：每级 1 SP，等级按上限 3 封顶', () => {
    expect(airBaseBuildCostSp(2)).toBe(2)
    expect(airBaseBuildCostSp(5)).toBe(3) // min(5,3) × 1
  })

  it('装载/卸载费用 = 印刷 MA × 10%，按 4.2 取整（13.2f）', () => {
    expect(computeLoadingCost(6)).toBe(1) // 0.6 ⇒ 1（4.2：小数 ≥ .5 进位）
    expect(computeLoadingCost(10)).toBe(1)
    expect(computeLoadingCost(45)).toBe(5) // 规则书原例：45MA 卡车付 5MP
  })

  it('堆叠上限判定（RE ≤ 10）', () => {
    expect(isWithinStackingLimit(10)).toBe(true)
    expect(isWithinStackingLimit(10.5)).toBe(false)
  })
})
