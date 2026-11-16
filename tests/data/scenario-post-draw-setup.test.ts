import { describe, expect, it } from 'vitest'

import { scenarios } from '@/data'
import { airSetupPolicyOf, setupFlowFor } from '@/engine/rules'
import { setupEffectOf } from '@/engine/rules/setup-effects'

/**
 * 专规「德军抽取编队」前后的必做项：逐剧本对照原文锁定数据口径
 *
 * 原文出处：
 *   · 剧本 1（p.6）/ 剧本 2（p.8）：12 个多单位编队抽 4 个西移 3 格、另 4 个以 Mtr 团换
 *     Dead Pile 里的 Aufk 营；`All Axis organic trucks setup Full`、`All planes must begin
 *     Inactive`、`Construction Markers: 3`、`Supply Cache: 2`、`Reserve 14`。
 *   · 剧本 3（p.9）/ 剧本 4（p.11，同 3）：14 个师抽 5 个全部以 Move Mode 初设、另 5 个换 Aufk；
 *     `Four Axis organic trucks (player's choice) are Full`；飞机每型半数 Inactive 向上取整；
 *     `No units can setup in Reserve Mode`；Construction 0、Supply Cache 2、Reserve 14。
 *   · 剧本 5（p.13）/ 剧本 6（p.15，同 5）：抽 5 个 Krd 入死亡堆、7 个 Aufk 入死亡堆；
 *     `Two Axis organic trucks (player's choice) are Full`；Reserve 7、Supply Cache 2。
 *   · 剧本 7（p.17）：`All Axis organic trucks setup Empty`；`Roll for Variable Exit (3.3c)`；
 *     Reserve 7、Supply Cache 2；无编队抽取。
 *   · Intro / Vitebsk（教学）：无编队抽取、无 SP 装甲集群归属（3.4b 不适用）、德军无机库内初设。
 */

function scenarioOf(id: string) {
  const scenario = scenarios.scenarios.find((item) => item.id === id)
  if (scenario === undefined) throw new Error(`剧本库中没有 ${id}`)
  return scenario
}

function groupCounts(id: string): Record<string, number> {
  const effect = setupEffectOf(id, 'formationDraw')
  if (effect === null) return {}
  return Object.fromEntries(effect.groups.map((group) => [group.kind, group.count]))
}

describe('抽取编队：各组数量按剧本页锁死', () => {
  it('剧本 1/2：A 西移 4、B 换侦察营 4', () => {
    expect(groupCounts('1')).toEqual({ shiftWest: 4, mtrAufkSwap: 4 })
    expect(groupCounts('2')).toEqual(groupCounts('1'))
  })

  it('剧本 3/4：A Move Mode 5、B 换侦察营 5', () => {
    expect(groupCounts('3')).toEqual({ moveMode: 5, mtrAufkSwap: 5 })
    expect(groupCounts('4')).toEqual(groupCounts('3'))
  })

  it('剧本 5/6：A Krd 入死亡堆 5、B Aufk 入死亡堆 7', () => {
    expect(groupCounts('5')).toEqual({ deadPileKrd: 5, deadPileAufk: 7 })
    expect(groupCounts('6')).toEqual(groupCounts('5'))
  })

  it('剧本 7 与 Intro 无抽取环节', () => {
    expect(setupEffectOf('7', 'formationDraw')).toBeNull()
    expect(setupEffectOf('Intro', 'formationDraw')).toBeNull()
  })
})

describe('抽取之后的编内卡车载荷：原文全载/全空自动，player’s choice 留给玩家', () => {
  it('剧本 1/2 全部满载；7 全部空载（可全自动）', () => {
    expect(scenarioOf('1').setup.organicTrucks.mode).toBe('all_loaded')
    expect(scenarioOf('2').setup.organicTrucks.mode).toBe('all_loaded')
    expect(scenarioOf('7').setup.organicTrucks.mode).toBe('all_unloaded')
  })

  it('剧本 3/4 任选 4 辆、5/6 任选 2 辆（原文 player’s choice ⇒ 不可自动）', () => {
    expect(scenarioOf('3').setup.organicTrucks).toMatchObject({ mode: 'choose_loaded', count: 4 })
    expect(scenarioOf('4').setup.organicTrucks).toMatchObject({ mode: 'choose_loaded', count: 4 })
    expect(scenarioOf('5').setup.organicTrucks).toMatchObject({ mode: 'choose_loaded', count: 2 })
    expect(scenarioOf('6').setup.organicTrucks).toMatchObject({ mode: 'choose_loaded', count: 2 })
  })

  it('Intro 的载荷：原文专规未写，OOB 用 ‘F’ Truck 记号；维持用户裁定的全满载（存疑项）', () => {
    // OCS 1.0 Setup Note D：`Organic Trucks start "full" only if a scenario explicitly states that they do.`
    // Intro 的专规段落没有这句；此处数据来自用户裁定，属原文留存歧义，已在核对报告中单列。
    expect(scenarioOf('Intro').setup.organicTrucks.mode).toBe('all_loaded')
  })
})

describe('抽取之后的飞机激活态：按原文/通规 IV-E 默认', () => {
  it('剧本 1/2 德军全 Inactive；苏军每型半数 Inactive 向上取整', () => {
    expect(airSetupPolicyOf('1', 'axis').policy).toBe('all_inactive')
    expect(airSetupPolicyOf('2', 'axis').policy).toBe('all_inactive')
    expect(airSetupPolicyOf('1', 'soviet').policy).toBe('half_inactive_round_up')
    expect(airSetupPolicyOf('2', 'soviet').policy).toBe('half_inactive_round_up')
  })

  it('剧本 3/4/5/6/7 德军每型半数 Inactive；苏军未述 ⇒ 全 Active', () => {
    for (const id of ['3', '4', '5', '6', '7']) {
      expect(airSetupPolicyOf(id, 'axis').policy).toBe('half_inactive_round_up')
      expect(airSetupPolicyOf(id, 'soviet').policy).toBe('all_active')
    }
  })

  it('Intro 德军未述激活态 ⇒ 全 Active（IV-E 默认）', () => {
    expect(airSetupPolicyOf('Intro', 'axis').policy).toBe('all_active')
    expect(airSetupPolicyOf('Intro', 'soviet').policy).toBe('all_active')
  })
})

describe('抽取前后的标记/工事账本与流程顺序', () => {
  it('剧本 1/2 施工标记 3；其余剧本 0', () => {
    expect(scenarioOf('1').setup.constructionMarkers).toBe(3)
    expect(scenarioOf('2').setup.constructionMarkers).toBe(3)
    for (const id of ['3', '4', '5', '6', '7']) {
      expect(scenarioOf(id).setup.constructionMarkers).toBe(0)
    }
  })

  it('补给缓存：正剧本每方 2；储备标记剧本 1–7 与原文一致', () => {
    for (const id of ['1', '2', '3', '4', '5', '6', '7']) {
      expect(scenarioOf(id).setup.supplyCache).toBe(2)
    }
    expect(scenarioOf('1').setup.reserveMarkers).toMatchObject({ axis: 14 })
    expect(scenarioOf('3').setup.reserveMarkers).toMatchObject({ axis: 14 })
    expect(scenarioOf('5').setup.reserveMarkers).toMatchObject({ axis: 7 })
    expect(scenarioOf('7').setup.reserveMarkers).toMatchObject({ axis: 7, soviet: 6 })
  })

  it('抽取声明为「确认初设后执行」：不是先抽后摆，而是一笔事务抽完即开局', () => {
    for (const id of ['1', '3', '5']) {
      expect(setupEffectOf(id, 'formationDraw')?.timing).toBe('afterSetupConfirm')
      const steps = setupFlowFor(id).map((step) => step.id)
      // 流程清单里抽取列在剧本选择之后，但卡车/SP/自动初设/飞机/自由项都在确认前完成
      for (const step of ['truckLoad', 'spOwnership', 'autoSetup', 'airSetup']) {
        expect(steps).toContain(step)
      }
    }
  })
})
