import { describe, expect, it } from 'vitest'

import { chartsTables, rulesConstants } from '@/data'
import { flakMissionLoss } from '@/engine/tables/flak'

/**
 * 通规 v4.3 图表页 1 = **印表逐格核对**（2026-11-01）
 *
 * 判据来源：`v4.3 Charts (final)-1 1000.png`（OCS v4.3 Charts and Tables 第 1 页）。
 * 该页五张表：**Air Combat (14.3e)** / **Air Transport Success (14.10d)** /
 * **Air Base Capture (9.14f)** / **Flak (14.4d)** / **Mission Loss (14.4f)**。
 *
 * 印表原文（照抄）：
 *   · Air Combat：`6 or less → Attackers Aborts`、`7 → Both Abort`、`8 or more → Defender Aborts`；
 *     Loss Die：`1-4 No Loss`、`5-6 Step Loss`；DRM：+攻方 AR、−守方 AR。
 *   · Air Transport Success：Friendly/Clear `Fail 4 or less / Success 5 or more`；
 *     Friendly/Closed `5 / 6`；Enemy/Clear `5 / 6`；Enemy/Closed `6 / 7`。
 *   · Air Base Capture：`6 or less → Step Loss`、`7 or more → No Loss`；DRM `+2 飞机 Active`、`+2 战后推进夺取`。
 *   · Flak：`modified roll 11 or more ⇒ kill one mission aircraft`；`+1 三架及以上`、`+1 有 HQ`、
 *     `+基地等级`、`+1/+2 敌巡逻区(无/有战斗机)`、`+1 Trainbusting`。
 *   · Mission Loss：`2 aircraft → #1 #1 #1 #2 #2 #2`；`3 → #1 #1 #2 #2 #3 #3`；`4 → #1 #2 #3 #4 W S`。
 */

const AIR = rulesConstants.air

describe('Air Combat Table（14.3e）', () => {
  it('6 or less 攻方返航 / 7 双方返航 / 8 or more 守方返航', () => {
    expect(AIR.airCombatAttackerAbortMaxDice).toBe(6)
    expect(AIR.airCombatBothAbortDice).toBe(7)
    expect(AIR.airCombatDefenderAbortMinDice).toBe(8)
  })

  it('损失骰：1-4 无损失 / 5-6 损失 1 军力', () => {
    expect(AIR.airCombatLossNoLossMaxDice).toBe(4)
    expect(AIR.airCombatLossStepLossMinDice).toBe(5)
  })
})

describe('Air Transport Success Table（14.10d）', () => {
  it('四格成功门槛：友/晴 5+、友/闭 6+、敌/晴 6+、敌/闭 7+', () => {
    expect(AIR.airTransportSuccess.friendlyClearMin).toBe(5)
    expect(AIR.airTransportSuccess.friendlyClosedMin).toBe(6)
    expect(AIR.airTransportSuccess.enemyClearMin).toBe(6)
    expect(AIR.airTransportSuccess.enemyClosedMin).toBe(7)
  })

  it('DRM：苏方空投 −1、滑翔机 +1、可选 21.12E 近距 −1 / 极近 −2', () => {
    expect(AIR.airTransportSuccess.sovietAirdropDrm).toBe(-1)
    expect(AIR.airTransportSuccess.gliderDrm).toBe(1)
    expect(AIR.airTransportSuccess.optional21_12eVeryCloseDrm).toBe(-1)
    expect(AIR.airTransportSuccess.optional21_12eExtrCloseDrm).toBe(-2)
  })
})

describe('Air Base Capture Table（9.14f）', () => {
  it('6 or less 损失 1 军力 / 7 or more 无损失；DRM +2 Active、+2 战后推进夺取', () => {
    expect(rulesConstants.combat.airBaseCaptureNoLossMinDice).toBe(7)
    expect(rulesConstants.combat.airBaseCaptureDrm.active).toBe(2)
    expect(rulesConstants.combat.airBaseCaptureDrm.byAdvanceAfterCombat).toBe(2)
  })
})

describe('Flak（14.4d）', () => {
  it('修正后 11+ 击落 1 架；修正项照印表', () => {
    expect(AIR.flakKillMinDice).toBe(11)
    expect(AIR.flakModifiers.missionThreePlusAircraft).toBe(1)
    expect(AIR.flakModifiers.targetHasHQ).toBe(1)
    expect(AIR.flakModifiers.airBaseLevelPerLevel).toBe(1)
    expect(AIR.flakModifiers.inEnemyPatrolZoneWithFighter).toBe(1)
    expect(AIR.flakModifiers.inEnemyPatrolZoneNoFighter).toBe(2)
    expect(AIR.flakModifiers.trainbustingInPatrolZone).toBe(1)
  })

  it('何时掷高炮：三类永远掷 / 三类仅敌巡逻区内 / 两类从不掷', () => {
    expect(AIR.flakApplies.always).toEqual(['barrage', 'hip_shoot', 'trainbusting'])
    expect(AIR.flakApplies.onlyInPatrolZone).toEqual(['air_transport', 'air_drop', 'base_transfer'])
    expect(AIR.flakApplies.never).toEqual(['fighter_sweep', 'interception'])
  })
})

describe('Mission Loss Table（14.4f）', () => {
  it('★ 三行六列逐格照印表（#1..#4 / W 最弱 / S 最强）', () => {
    const table = chartsTables.tables.find((item) => item.id === 'flak-mission-loss')
    expect(table).toBeDefined()
    expect(table!.columns).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(table!.rows).toEqual(['2 aircraft', '3 aircraft', '4 aircraft'])
    expect(table!.grid).toEqual([
      ['#1', '#1', '#1', '#2', '#2', '#2'],
      ['#1', '#1', '#2', '#2', '#3', '#3'],
      ['#1', '#2', '#3', '#4', 'W', 'S'],
    ])
  })

  it('取表入口与数据一致（2 架掷 6 ⇒ #2；4 架掷 5 ⇒ W）', () => {
    expect(flakMissionLoss(2, 6)).toBe('#2')
    expect(flakMissionLoss(3, 3)).toBe('#2')
    expect(flakMissionLoss(4, 5)).toBe('W')
    expect(flakMissionLoss(4, 6)).toBe('S')
  })
})
