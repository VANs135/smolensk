import { scenarioSetup, scenarios } from '@/data'

/** 该剧本的初设源（1–2 / 3–4 / 5–6 共用初设） */
export interface SetupSource {
  scenarioId: string
  source: string
  via: 'own' | 'inherits' | 'shared'
  detail: string
}

/** 条目里出现过的剧本号（源库只有 1/3/5/7 有初设条目） */
function entryScenarioIds(): readonly string[] {
  const ids = new Set<string>()
  for (const entry of scenarioSetup.entries) ids.add(entry.scenarioId)
  return [...ids]
}

/** 有初设条目的剧本号集合（模块内复用） */
const ENTRY_SCENARIOS = new Set(entryScenarioIds())

/**
 * 解出该剧本的**初设源**
 *
 * 顺序：本体有条目 → 本体；否则 `inherits` 指向的剧本有条目 → 该剧本；
 * 否则「与本剧本共用初设」的剧本（`sharedSetupWith` 反查）→ 该剧本；都没有 ⇒ 记缺口。
 */
export function setupSourceOf(scenarioId: string): SetupSource {
  const scenario = scenarios.scenarios.find((item) => item.id === scenarioId)
  if (scenario === undefined) {
    return { scenarioId, source: scenarioId, via: 'own', detail: `剧本库中没有剧本 ${scenarioId}` }
  }
  if (ENTRY_SCENARIOS.has(scenarioId)) {
    return {
      scenarioId,
      source: scenarioId,
      via: 'own',
      detail: `剧本 ${scenarioId} 本体含初设条目（剧本页逐格清单）`,
    }
  }
  const inherited = scenario.inherits
  if (inherited !== undefined && ENTRY_SCENARIOS.has(inherited)) {
    return {
      scenarioId,
      source: inherited,
      via: 'inherits',
      detail: `剧本 ${scenarioId} 初设同剧本 ${inherited}（契约字段 inherits；剧本页原文「Setup and Special Scenario Rules are the same as in Scenario ${inherited}」）`,
    }
  }
  const shared = scenarios.scenarios.find(
    (item) => item.sharedSetupWith?.includes(scenarioId) === true && ENTRY_SCENARIOS.has(item.id),
  )
  if (shared !== undefined) {
    return {
      scenarioId,
      source: shared.id,
      via: 'shared',
      detail: `剧本 ${scenarioId} 与剧本 ${shared.id} 共用初设（契约字段 sharedSetupWith）`,
    }
  }
  return {
    scenarioId,
    source: scenarioId,
    via: 'own',
    detail: `剧本 ${scenarioId} 在初设索引（scenario-setup.json）中没有条目 ⇒ 初设清单缺失（数据缺口）`,
  }
}
