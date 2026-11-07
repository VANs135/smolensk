import { describe, expect, it } from 'vitest'

import { unitsAxis, unitsSoviet } from '@/data'
import { toConsoleUnit } from '@/stores'

/**
 * 2026-11-08 裁定：**本作没有单位可以空降**——「能力」与「番号」必须分开。
 *
 * - `Ru 7 / 8 / 214 Para Inf Bde` 的名字里的 Para/Abn 是**番号**（历史部队名），不代表本作具备伞降能力；
 * - 本作数据里不得有任何**空投能力**标签（`capabilities` / `capabilitiesRaw` / `specialAbilities` / `specialized`）；
 * - 能力判定只读上述**能力/分类字段**，不读单位名称、番号或 id 的字符串。
 *
 * ★ 换作品时的口径：同名的空降番号在别的作品里是否具备空投能力，**由那个作品的数据决定**，
 *   不由本作按名字推断。接新作品时只核对能力字段，不沿用本作的番号结论。
 */
const AIRDROP_TOKENS = [
  'para',
  'abn',
  'airborne',
  'air_drop',
  'airdrop',
  'air-drop',
  '空降',
  '伞降',
] as const

const appUnits = [...unitsAxis.units, ...unitsSoviet.units]

const capabilityFieldsOf = (unit: (typeof appUnits)[number]): readonly string[] => [
  ...(unit.capabilities ?? []),
  ...(unit.capabilitiesRaw ?? []),
  ...(unit.specialAbilities ?? []),
  ...(unit.specialized ?? []),
]

describe('番号 / 能力分离：本作没有任何空投能力', () => {
  it('★ 全单位库：能力与分类字段里不出现任何空投标签', () => {
    const hits: string[] = []
    for (const unit of appUnits) {
      const fields = capabilityFieldsOf(unit)
      for (const token of AIRDROP_TOKENS) {
        if (fields.includes(token)) hits.push(`${unit.id}: ${token}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('3 个空降番号保留原名与 id，但不再带 para 能力', () => {
    const expected = [
      ['su-infantry-ru-7-para-inf-bde', 'Ru 7 Para Inf Bde'],
      ['su-infantry-ru-8-para-inf-bde', 'Ru 8 Para Inf Bde'],
      ['su-infantry-ru-214-para-inf-bde', 'Ru 214 Para Inf Bde'],
    ] as const
    const byId = new Map(appUnits.map((unit) => [unit.id, unit]))
    for (const [id, name] of expected) {
      const unit = byId.get(id)
      expect(unit, `${id} 不应被删除（番号保留）`).toBeDefined()
      expect(unit?.vassalName).toBe(name)
      expect(unit?.capabilitiesRaw).toBeUndefined()
      expect(capabilityFieldsOf(unit!)).not.toContain('para')
    }
  })

  it('★ 能力判定不读名称/番号：同一记录改名后，能力投影逐项不变', () => {
    const record = new Map(appUnits.map((unit) => [unit.id, unit])).get(
      'su-infantry-ru-214-para-inf-bde',
    )
    expect(record).toBeDefined()
    const hex = { col: 1, row: 1 }
    const original = toConsoleUnit({
      record: record!,
      instanceId: 'guard-original',
      hex,
      side: 'soviet',
    })
    const renamed = toConsoleUnit({
      record: { ...record!, vassalName: 'Ru 999 Rifle Div' },
      instanceId: 'guard-renamed',
      hex,
      side: 'soviet',
    })
    expect(renamed.specialized).toEqual(original.specialized)
    expect(renamed.specialAbilities).toEqual(original.specialAbilities)
    expect(renamed.isCombat).toBe(original.isCombat)
    expect(renamed.attackCapable).toBe(original.attackCapable)
    expect(renamed.engineerCapable).toBe(original.engineerCapable)
  })

  it('能力只来自数据字段，不改写本作不存在的空投能力', () => {
    // 数据里没有任何空投标签 ⇒ 引擎不可能凭空给出空投能力；
    // 这条与第一条互为冗余，用于防止有人把「按名字推断」重新加回来。
    expect(appUnits.every((unit) => !capabilityFieldsOf(unit).includes('airborne'))).toBe(true)
  })
})
