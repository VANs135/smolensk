import { describe, expect, it } from 'vitest'

import { aircraft, scenarioSetup, unitsAxis, unitsSoviet } from '@/data'

/**
 * M10③：**初设引用 ↔ 运行时单位库**的缺口台账（冻结）
 *
 * ## 背景
 *   引擎只加载 `valued` 以上的记录（数据契约）。而 `scenario-setup.json` 的 1155 条初设/到货条目
 *   里有 952 条带 `unitId`（飞机也写在 `unitId` 里，键是 `aircraftId`）⇒ 只要某条引用的记录还在
 *   `classified`，那一笔初设就**放不下**（剧本 3/5/7 受影响最大）。
 *
 * ## 现值（2026-09-15 第二次实测）：`kind=unit` 缺口 **0**
 *   原 41 条**全部**在源库里、只是 `fill_stage='classified'`（「待填值」而非「库里没有」）。
 *   2026-09-15 按技能 `ocs-smolensk-counter-db-fill` 的准入四关审计后推进到 `valued`：
 *   ① 两面三值齐全；② 战斗面 A > 移动面 A；③ 移动面 MA > 战斗面 MA；
 *   ④ 群体一致性（同目录 + 兵种 + 规模取众数）与**外部锚点**（初设原文的 `A-AR-MA`）。
 *   审计细节见 `docs/待改清单与修改方案.md` §15.88；这 41 条**全部落在**推进的 87 条里。
 *
 * ## 剩下的非缺口
 *   · **17** 个 `kind=formation`：**编队标记**（如 `1 Pz Div`），本就不指向算子 ⇒ 不算缺口；
 *   · 飞机引用**零缺口**（曾因把 `aircraftId` 当 `id` 取而误报 26 个，此处钉住）。
 *
 * ## 纪律
 *   本表是**冻结台账**：新增缺口会让这条用例变红 ⇒ **不允许新增**（新增意味着又有初设引用了
 *   库里没有的算子，要么补值、要么查引用是否写错）。
 */
const KNOWN_GAP: readonly string[] = []

/** 初设/到货条目里引用了但运行时库里没有的 id（按 kind 归组） */
function missingRefs(): Map<string, Set<string>> {
  const ground = new Set([...unitsAxis.units, ...unitsSoviet.units].map((unit) => unit.id))
  const air = new Set(aircraft.aircraft.map((item) => item.aircraftId))
  const out = new Map<string, Set<string>>()
  for (const entry of scenarioSetup.entries as unknown as Record<string, unknown>[]) {
    const id = typeof entry['unitId'] === 'string' ? entry['unitId'] : null
    if (id === null || ground.has(id) || air.has(id)) continue
    const kind = String(entry['kind'] ?? '?')
    const bucket = out.get(kind) ?? new Set<string>()
    bucket.add(id)
    out.set(kind, bucket)
  }
  return out
}

describe('M10③：初设引用的单位缺口台账', () => {
  it('飞机引用**零缺口**（曾因取错键而误报 26 个，此处钉住）', () => {
    const air = new Set(aircraft.aircraft.map((item) => item.aircraftId))
    expect(air.size).toBeGreaterThan(20)
    for (const entry of scenarioSetup.entries as unknown as Record<string, unknown>[]) {
      const id = typeof entry['unitId'] === 'string' ? entry['unitId'] : null
      if (id === null || (!id.startsWith('ax-aircraft') && !id.startsWith('su-aircraft'))) continue
      expect(air.has(id), `飞机引用 ${id} 不在飞机库`).toBe(true)
    }
  })

  it('kind=unit 的缺口恰为台账里的 41 个（多一个即红）', () => {
    const missing = missingRefs()
    const units = [...(missing.get('unit') ?? [])].sort()
    expect(units).toEqual([...KNOWN_GAP].sort())
  })

  it('kind=formation 的 17 个是**编队标记**，不计入单位缺口', () => {
    const missing = missingRefs()
    const formations = [...(missing.get('formation') ?? [])]
    expect(formations).toHaveLength(17)
    // 它们都是「XX Div」这类编制名，不是算子 id（算子 id 一律带 `ax-`/`su-` 前缀）
    for (const label of formations)
      expect(label.startsWith('ax-') || label.startsWith('su-')).toBe(false)
  })

  it('台账口径说明：其余 kind 无缺口', () => {
    const missing = missingRefs()
    const others = [...missing.keys()].filter((kind) => kind !== 'unit' && kind !== 'formation')
    expect(others).toEqual([])
  })
})
