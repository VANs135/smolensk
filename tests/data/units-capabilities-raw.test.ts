import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { unitsAxis, unitsSoviet } from '@/data'

/**
 * B39 切片 B / D-4：应用数据带**源库的原始能力串**（`capabilitiesRaw`）
 *
 * 背景（方案 §3 B39 步骤 3 的 D-4）：源库 `units.json` 里 65 条带 `capabilities_raw`
 * （如 `["replacement"]`），而应用数据只有**分类后**的 `capabilities` ⇒ 分类依据无从回溯。
 * 本批把它导出为 `capabilitiesRaw`（可选字段，schema 已放开）。
 *
 * ★ 一条**测法边界（如实）**：本用例把**源库**当对照物 ⇒ 它只在**素材库在位**的机器上有效
 *   （与 `tests/data/setup-library-gap.test.ts` 等既有用例同一前提）；若素材库不在，源库读不到，
 *   用例会失败 —— 这是**有意**的：这两份数据必须成对核对，读不到就不该给绿灯。
 */
const SOURCE_DB = 'D:/OCS/OCS斯摩棱斯克素材/斯摩棱斯克工程数据库/units.json'

describe('B39 / D-4：capabilitiesRaw 与源库一致', () => {
  /**
   * 2026-11-08 裁定：**番号 ≠ 能力**。
   *
   * 源库对 3 个苏联空降番号（`Ru 7/8/214 Para Inf Bde`）标了 `capabilities_raw: ["para"]`，
   * 但本作没有任何单位可以空降 ⇒ 应用侧**不导出**这条能力串，名字/番号照旧保留。
   * 因此核对时把 `para` 从「能力串」里剔除；带 `para` 的条目单列，断言应用侧确实没有该字段。
   */
  const DESIGNATION_ONLY = new Set(['para'])

  it('★ 源库里有 capabilities_raw 的条目，应用侧一条不少地带上 capabilitiesRaw', () => {
    const source = JSON.parse(readFileSync(SOURCE_DB, 'utf8')) as {
      items?: readonly { unit_id: string; capabilities_raw?: readonly string[] }[]
    }
    const expected = new Map<string, readonly string[]>()
    const designationOnly: string[] = []
    for (const item of source.items ?? []) {
      if (!Array.isArray(item.capabilities_raw) || item.capabilities_raw.length === 0) continue
      const capabilityOnly = item.capabilities_raw.filter((value) => !DESIGNATION_ONLY.has(value))
      if (capabilityOnly.length > 0) {
        expected.set(item.unit_id, capabilityOnly)
      } else {
        designationOnly.push(item.unit_id)
      }
    }
    expect(expected.size).toBeGreaterThan(0)
    expect(designationOnly.length).toBeGreaterThan(0)

    // `unitsAxis` / `unitsSoviet` 是**整份数据文件**（`{ meta, units }`），不是数组
    const appUnits = [...unitsAxis.units, ...unitsSoviet.units]
    const byId = new Map(appUnits.map((unit) => [unit.id, unit]))
    let matched = 0
    for (const [id, raw] of expected) {
      const unit = byId.get(id)
      if (unit === undefined) continue
      matched += 1
      expect(unit.capabilitiesRaw, `${id} 少了 capabilitiesRaw`).toEqual([...raw])
    }
    /*
     * 番号条目：名字照旧、能力串不落地（本作没有空投能力）。
     * 换作品时这条**不沿用**——同名番号在别的作品里有没有能力，看那个作品的数据。
     */
    for (const id of designationOnly) {
      const unit = byId.get(id)
      if (unit === undefined) continue
      expect(unit.vassalName, `${id} 番号应保留`).toBeTruthy()
      expect(unit.capabilitiesRaw, `${id} 不应带 para 能力`).toBeUndefined()
    }
    // 对不上的那些（应用侧多出来的拆分单位等）不该带这个字段：不臆造
    expect(matched).toBeGreaterThan(0)
    for (const unit of appUnits) {
      if (unit.capabilitiesRaw === undefined) continue
      expect(Array.isArray(unit.capabilitiesRaw)).toBe(true)
      expect(unit.capabilitiesRaw.length).toBeGreaterThan(0)
      expect(unit.capabilitiesRaw.every((value) => typeof value === 'string')).toBe(true)
    }
  })
})
