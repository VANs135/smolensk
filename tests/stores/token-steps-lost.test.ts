import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { toConsoleUnit, unitChoices, useMapViewStore, useWorkbenchStore } from '@/stores'

/**
 * 条 24：**多军力单位的军力损失角标 `(-N)`**（3.6e / 4.6）与 **4.9a 的字段级裁剪**
 *
 * 规则原文（通规 v4.3）：
 *   3.6e「**军力损失标记**。用于显示**多军力单位**的军力损失。」
 *   4.6「一个多军力单位每损失 1 点军力，其 RE 规模便减一（9.11）。所有其他战斗单位在承受
 *        军力损失时，都视为只有 1 点军力，与其 RE 规模无关。」
 *   4.9a「……虽然敌方玩家会得知最上方单位是否处于战略模式、DG，或是否断补，但**无权获取
 *        部队储备或损失军力**的情况。」
 *
 * 本文件钉三件事：
 *   ① **只有多军力**才标（按**印值**判 3.2d，不是按当前军力判 ⇒ 打残到 1 的师照样标）；
 *   ② N ＝ 印值军力 − 当前军力；
 *   ③ **敌方那一枚恒为 0**（4.9a：损失军力不可见）——裁剪在令牌投影里做，渲染层只画传进来的数。
 */

const HEX: HexRef = { col: 36, row: 13 }

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

const legCombat = () =>
  unitChoices('axis').find(
    (record) =>
      record.classes?.movementClass === 'leg' &&
      record.attackCapable === true &&
      (record.factors?.combat?.ma ?? 0) >= 4,
  )!

/** 摆一枚算子并直接指定「印值军力 / 当前军力」（减损这一步由战斗引擎落，这里只造投影输入） */
function put(
  workbench: ReturnType<typeof useWorkbenchStore>,
  id: string,
  side: 'axis' | 'soviet',
  printedSteps: number,
  steps: number,
): void {
  const unit = toConsoleUnit({ record: legCombat(), instanceId: id, hex: HEX, side })
  unit.printedSteps = printedSteps
  unit.steps = steps
  workbench.units.push(unit)
}

describe('条 24：(-N) 军力损失角标的令牌投影（3.6e / 4.6 / 4.9a）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('① 己方**多军力**受损 ⇒ stepsLost ＝ 印值 − 当前（N 就是掉了几点）', () => {
    const { workbench, mapView } = stores
    put(workbench, 'a1', 'axis', 3, 2)
    const token = mapView.overlay.tokens.find((item) => item.id === 'a1')
    expect(token).toBeDefined()
    expect(token!.stepsLost).toBe(1)
  })

  it('② 未受损 ⇒ 不标（stepsLost 0）', () => {
    const { workbench, mapView } = stores
    put(workbench, 'a1', 'axis', 3, 3)
    expect(mapView.overlay.tokens.find((item) => item.id === 'a1')!.stepsLost).toBe(0)
  })

  it('③ **单军力**单位不标（3.6e 的标记只给多军力单位用）', () => {
    const { workbench, mapView } = stores
    put(workbench, 'a1', 'axis', 1, 1)
    expect(mapView.overlay.tokens.find((item) => item.id === 'a1')!.stepsLost).toBe(0)
  })

  it('④ 打残到 1 的师**仍是多军力** ⇒ 照标（按印值判，不按当前军力判）', () => {
    const { workbench, mapView } = stores
    put(workbench, 'a1', 'axis', 3, 1)
    expect(mapView.overlay.tokens.find((item) => item.id === 'a1')!.stepsLost).toBe(2)
  })

  it('⑤ 4.9a：**敌方**那一枚恒为 0（不可获取损失军力）', () => {
    const { workbench, mapView } = stores
    // 敌方（非当前方）受损的多军力单位：即便它是 4.9a 允许露出的"最上方战斗单位"，
    // 也只透露模式 / DG / 断补，**不透露**掉了几点
    put(workbench, 'e1', 'soviet', 3, 1)
    const token = mapView.overlay.tokens.find((item) => item.id === 'e1')
    expect(token).toBeDefined()
    expect(token!.stepsLost).toBe(0)
  })
})
