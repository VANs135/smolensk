import { describe, expect, it } from 'vitest'

import { scenarioSetup, unitsSoviet } from '@/data'

/**
 * 专规 2.3a：**警戒（Alarm）单位的混编上限**
 *
 * 规则原文：「Alarm Units. These will start on the map, in the Dead Pile, or appear via the Arrival
 * Schedule. Special Repls (1.6c) are needed to rebuild them. **The mix of Alarm units is strictly
 * limited: three 2-1-3 tank battalions, five 3-1-1 militia regiments, and seven (2)-2-2 anti-tank
 * regiments.**」
 *
 * 数据口径（用户 2026-09-16 裁定）：警戒单位**只有三种算子**，但游戏里可按剧本要求**同时出现多枚**
 * ⇒ 上限按**算子类型**计（3 / 5 / 7），落在单位库的 `alarmLimit` 字段上；本用例把两条都钉住：
 *   ① 三条警戒算子的上限就是 3 / 5 / 7；
 *   ② 每个剧本的初设里，各型 Alarm 的枚数不得超过对应上限（剧本数据不许超编）。
 */
describe('专规 2.3a：警戒单位的混编上限（alarmLimit）', () => {
  const EXPECTED: Record<string, number> = {
    'su-armor_tk-ru-tk-alarm-2-1-3': 3, // 2-1-3 坦克营
    'su-militia-ru-mil-alarm-3-1-1': 5, // 3-1-1 民兵团
    'su-anti_tank-ru-at-alarm-2-2-2': 7, // (2)-2-2 反坦克团
  }

  it('单位库三条警戒算子带 alarmLimit = 3 / 5 / 7（且只有这三条带）', () => {
    const withLimit = unitsSoviet.units.filter((unit) => unit.alarmLimit !== undefined)
    expect(withLimit.map((unit) => unit.id).sort()).toEqual(Object.keys(EXPECTED).sort())
    for (const unit of withLimit) expect(unit.alarmLimit).toBe(EXPECTED[unit.id])
  })

  it('库里的警戒算子恰好三种（按 id 兜底：不再有「有 alarm 名字却没上限」的记录）', () => {
    /*
     * 说明：源库另有 `capabilities_raw: ["alarm"]` 这一层标注，但它**不在本批导出范围**
     * （产品的 `capabilities` 只映射 `special_abilities`；`capabilities_raw` 的 ur/nkvd/para/engineer
     * 等值的导入会牵连别处判定，另立一项卫生任务）。此处按 id 兜底即可覆盖「新加警戒算子忘了标上限」。
     */
    const alarmish = unitsSoviet.units.filter((unit) => /alarm/i.test(unit.id))
    expect(alarmish.map((unit) => unit.id).sort()).toEqual(Object.keys(EXPECTED).sort())
    for (const unit of alarmish) expect(unit.alarmLimit).toBe(EXPECTED[unit.id])
  })

  it('每个剧本的初设 Alarm 混编都不超上限（按算子类型计）', () => {
    const alarmIds = new Set(Object.keys(EXPECTED))
    const entries = scenarioSetup.entries.filter(
      (entry): entry is typeof entry & { unitId: string; scenarioId: string } =>
        typeof entry.unitId === 'string' &&
        typeof entry.scenarioId === 'string' &&
        alarmIds.has(entry.unitId),
    )
    expect(entries.length).toBeGreaterThan(0) // 剧本确实用到了它们

    const perScenario = new Map<string, Map<string, number>>()
    for (const entry of entries) {
      const byType = perScenario.get(entry.scenarioId) ?? new Map<string, number>()
      byType.set(entry.unitId, (byType.get(entry.unitId) ?? 0) + entry.count)
      perScenario.set(entry.scenarioId, byType)
    }
    expect(perScenario.size).toBeGreaterThanOrEqual(4) // 剧本 1 / 3 / 5 / 7

    const violations: string[] = []
    for (const [scenarioId, byType] of perScenario) {
      for (const [unitId, count] of byType) {
        if (count > EXPECTED[unitId]!) violations.push(`剧本 ${scenarioId}：${unitId} ×${count}`)
      }
    }
    expect(violations).toEqual([])
  })
})
