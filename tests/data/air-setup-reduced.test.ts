import { describe, expect, it } from 'vitest'

import {
  airSetupPolicyOf,
  findAircraftRecord,
  normalizeAircraftKey,
  planAirSetup,
  setupEntryViews,
} from '@/engine/rules'

/**
 * 初设减损飞机：逐剧本对照剧本页原文锁定 `"*" = one unit begins reduced`
 *
 * 原文（`Smolensk_Rules_v1.1.txt` 各剧本 At any air bases 栏）：
 *   · 剧本 1 苏军：`1x Pe.2 *`（德军 `All planes must begin Inactive.`，无 `*`）；
 *   · 剧本 3 / 4（同源）：德军 `2x Do.17z *`、`3x He.111 *`；
 *     苏军 `1x Pe.2 *`、`2x Su.2 *`、`3x Yak.4 *`；
 *   · 剧本 5 / 6（同源）：德军 `1x Bf-109e *`、`5x Bf.109f *`、`2x He.111 *`、`2x Ju.87b *`；
 *     苏军 `1x I.153 *`、`3x I.16 *`、`3x MiG.3 *`、`2x Pe.2 *`、`2x Su.2 *`；
 *   · 剧本 7：德军 `1x Bf-109e *`、`2x He.111 *`；
 *     苏军 `1x I.153 *`、`1x LaGG.3 *`、`1x Yak.1 *`、`2x Pe.2 *`、`2x SB.2 *`；
 *   · Intro / Vitebsk：无 `*`、无 reduced。
 *
 * 原文没有 `Damaged` 这一档：减损机是同一枚算子翻到背面（军力 −1），空战 / 轰炸取背面印值；
 * 修回走 1.6b / 13.5f（Ftr/Tac Repls / Eq），不另造状态。
 */

/** 原文 `*` 机型（按剧本与阵营） */
const ORIGINAL_REDUCED: Record<string, { axis: readonly string[]; soviet: readonly string[] }> = {
  '1': { axis: [], soviet: ['Pe.2'] },
  '2': { axis: [], soviet: ['Pe.2'] },
  '3': {
    axis: ['Do.17z', 'He.111'],
    soviet: ['Pe.2', 'Su.2', 'Yak.4'],
  },
  '4': {
    axis: ['Do.17z', 'He.111'],
    soviet: ['Pe.2', 'Su.2', 'Yak.4'],
  },
  '5': {
    axis: ['Bf-109e', 'Bf.109f', 'He.111', 'Ju.87b'],
    soviet: ['I.153', 'I.16', 'MiG.3', 'Pe.2', 'Su.2'],
  },
  '6': {
    axis: ['Bf-109e', 'Bf.109f', 'He.111', 'Ju.87b'],
    soviet: ['I.153', 'I.16', 'MiG.3', 'Pe.2', 'Su.2'],
  },
  '7': {
    axis: ['Bf-109e', 'He.111'],
    soviet: ['I.153', 'LaGG.3', 'Yak.1', 'Pe.2', 'SB.2'],
  },
  Intro: { axis: [], soviet: [] },
}

const SCENARIOS = Object.keys(ORIGINAL_REDUCED)

/** 该机型是否命中原文的 `*` 键（与引擎同一条归一名后缀匹配，避免 Bf.109e 误配 Bf.109e-7） */
function matchesKey(aircraftId: string, name: string, key: string): boolean {
  const target = normalizeAircraftKey(key)
  return [normalizeAircraftKey(aircraftId), normalizeAircraftKey(name)].some(
    (value) => target !== '' && value.endsWith(target),
  )
}

describe('初设减损飞机：原文 `*` 机型逐剧本锁死', () => {
  it.each(SCENARIOS)('剧本 %s：policy.reducedTypes 与剧本页 `*` 完全一致', (scenarioId) => {
    const expected = ORIGINAL_REDUCED[scenarioId]!
    expect(airSetupPolicyOf(scenarioId, 'axis').reducedTypes).toEqual(expected.axis)
    expect(airSetupPolicyOf(scenarioId, 'soviet').reducedTypes).toEqual(expected.soviet)
  })

  it.each(SCENARIOS)('剧本 %s：每型恰好 1 枚减损，军力 = 印值 − 1', (scenarioId) => {
    const expected = ORIGINAL_REDUCED[scenarioId]!
    for (const side of ['axis', 'soviet'] as const) {
      const plan = planAirSetup({
        scenarioId,
        side,
        facts: { airBaseHexes: [{ col: 2, row: 2 }] },
      })
      if (!plan.ok) throw new Error(`${scenarioId}/${side}: ${plan.reason}`)

      const keys = expected[side]
      for (const row of plan.data.placements) {
        const key = keys.find((item) => matchesKey(row.aircraftId, row.name, item))
        const printed = findAircraftRecord(row.aircraftId)?.steps ?? 2
        if (key === undefined) {
          expect(row.reduced.every((flag) => flag === false)).toBe(true)
          expect(row.steps.every((steps) => steps === printed)).toBe(true)
          continue
        }
        // `"*" = one unit begins reduced`：该型只减损 1 枚，其余满员
        expect(row.reduced.filter(Boolean)).toHaveLength(1)
        expect(row.steps[row.reduced.indexOf(true)]).toBe(printed - 1)
      }

      // 原文点名的机型必须在初设里找得到（否则 `*` 落空）
      for (const key of keys) {
        expect(
          plan.data.placements.some((row) => matchesKey(row.aircraftId, row.name, key)),
          `${scenarioId}/${side} 找不到 ${key}`,
        ).toBe(true)
      }
    }
  })

  it.each(SCENARIOS)('剧本 %s：飞机总枚数与初设条目一致（不因减损增减枚数）', (scenarioId) => {
    for (const side of ['axis', 'soviet'] as const) {
      const entries = setupEntryViews(scenarioId, side).filter(
        (entry) => entry.kind === 'aircraft' && entry.placement !== 'deadPile',
      )
      const expectedCount = entries.reduce((sum, entry) => sum + entry.count, 0)
      const plan = planAirSetup({
        scenarioId,
        side,
        facts: { airBaseHexes: [{ col: 2, row: 2 }] },
      })
      if (!plan.ok) throw new Error(`${scenarioId}/${side}: ${plan.reason}`)
      expect(plan.data.placements.reduce((sum, row) => sum + row.count, 0)).toBe(expectedCount)
    }
  })
})
