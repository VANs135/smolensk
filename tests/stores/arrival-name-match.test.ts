import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { arrivalsAxis, arrivalsSoviet } from '@/data'
import { useWorkbenchStore } from '@/stores'
import { unitNameKey, unitNameTokenSet } from '@/stores/workbench-model'

/**
 * 13.6 / §5-A：**到达卡面名 → 库中型号**的匹配（规则化归一 + 唯一命中守卫）
 *
 * 背景：卡面名不带方前缀、库内印刷名带（"5 Inf Div" vs "Ge 5 Inf Div"），精确匹配实测 0/90、0/117。
 * 这里的断言分两层：①纯函数的词集键口径（能对上/不能对上，各自指名道姓）；
 * ②store 级 `matchArrivalRecord` 的**唯一命中守卫**：该拒的必须拒（歧义、多算子编成不猜）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

describe('§5-A：词集键的口径（丢前缀/丢强度/丢词序/同义词）', () => {
  it('方前缀、强度数码、词序都不影响键', () => {
    expect(unitNameKey('5 Inf Div')).toBe(unitNameKey('Ge 5 Inf Div'))
    // 卡面 "5th Corps HQ" ↔ 库内 "Ge HQ 5th Corps"（词序不同）
    expect(unitNameKey('5th Corps HQ')).toBe(unitNameKey('Ge HQ 5th Corps'))
    // 括号里的强度/注释整段丢弃
    expect(unitNameKey('Ru AT Alarm (2)-2-2')).toBe(unitNameKey('AT Alarm'))
  })

  it('同义词表把卡面用词归到库内用词（Inf↔Rifle、Mtr↔Mot、Mil↔Militia…）', () => {
    expect(unitNameKey('119 Inf Div')).toBe(unitNameKey('Ru 119 Rifle Div'))
    expect(unitNameKey('69 Mtr Div')).toBe(unitNameKey('Ru 69 Mot Div'))
    expect(unitNameKey('4M Mil Div')).toBe(unitNameKey('Ru 4 Militia Div'))
    // 卡面"Abn Bde"与库内"Para Inf Bde"只差一个 Inf：词集是子集关系（由 store 的子集档接手）
    expect(unitNameKey('214 Abn Bde')).not.toBe(unitNameKey('Ru 214 Para Inf Bde'))
    const wanted = unitNameTokenSet('214 Abn Bde')
    const library = unitNameTokenSet('Ru 214 Para Inf Bde')
    expect([...wanted].every((token) => library.has(token))).toBe(true)
  })

  it('民兵的 "M" 只在含 militia 时才归（不误伤别的番号）', () => {
    expect(unitNameKey('7M Mil Div')).toBe('7 division militia')
    // 没有 militia 的 "7M" 原样保留
    expect(unitNameKey('7M Bn')).toBe('7m battalion')
  })

  it('词集键与 token set 同源（set 是键的拆分）', () => {
    expect([...unitNameTokenSet('Ge HQ 57th Corps')].sort()).toEqual(
      unitNameKey('Ge HQ 57th Corps').split(' '),
    )
  })
})

describe('§5-A：store 级匹配（唯一命中才认，歧义不猜）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('轴心：卡面名能自动落到库中那一枚（不再要求手选型号）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    expect(store.matchArrivalRecord('5 Inf Div')?.id).toBe('ax-infantry-ge-5-inf-div')
    // 词序不同（卡面 5th Corps HQ / 库内 Ge HQ 5th Corps）
    expect(store.matchArrivalRecord('5th Corps HQ')?.id).toBe('ax-hq-ge-hq-5th-corps')
    // 运输点（卡面写成 "3 Truck Points (loaded with SP)"）
    expect(store.matchArrivalRecord('3 Truck Points (loaded with SP)')?.id).toBe(
      'ax-transport-truck-3',
    )
    // 罗马数字 ↔ 阿拉伯数字（1-8 / I-8）
    expect(store.matchArrivalRecord('1-8 PJ Co')?.id).toBe('ax-anti_tank-ge-i-8-pj-co')
  })

  it('苏军：Inf↔Rifle、Alarm 编成、NKVD 补词都能对上', () => {
    const store = newStore()
    store.setActiveSide('soviet')
    expect(store.matchArrivalRecord('119 Inf Div')?.id).toBe('su-infantry-ru-119-rifle-div')
    expect(store.matchArrivalRecord('Alarm AT Rgt')?.id).toBe('su-anti_tank-ru-at-alarm-2-2-2')
    expect(store.matchArrivalRecord('1 NKVD Inf Rgt')?.id).toBe(
      'su-motorized-ru-1-nkvd-mot-inf-rgt',
    )
    expect(store.matchArrivalRecord('194 Mtn Inf Div')?.id).toBe('su-mountain-ru-194-mtn-div')
  })

  it('歧义条目不猜（2x Corps HQ 对应多个军部）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    expect(store.matchArrivalRecord('2x Corps HQ (9, 12)')).toBeNull()
  })

  it('多算子编成没有"单枚记录"⇒ 返回 null（19 Pz Div 由数枚团级算子共同到场）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    expect(store.matchArrivalRecord('19 Pz Div')).toBeNull()
  })

  it('空名/纯数字不匹配（不把"3"当成某个番号）', () => {
    const store = newStore()
    store.setActiveSide('axis')
    expect(store.matchArrivalRecord('')).toBeNull()
    expect(store.matchArrivalRecord(null)).toBeNull()
    expect(store.matchArrivalRecord('3')).toBeNull()
  })
})

describe('§5-A：全量到货条的自动匹配覆盖率（真实数据口径不变差）', () => {
  /** 把某方到达表的每一条（按 `name ?? raw`）过一遍匹配，统计命中/未命中 */
  function coverageOf(side: 'axis' | 'soviet') {
    const store = newStore()
    store.setActiveSide(side)
    const data = side === 'axis' ? arrivalsAxis : arrivalsSoviet
    const names: string[] = []
    for (const block of data.blocks) {
      for (const group of block.groups ?? []) {
        for (const unit of group.units ?? []) {
          names.push(unit.name ?? unit.raw)
        }
      }
    }
    const matched = names.filter((name) => store.matchArrivalRecord(name) !== null)
    return { total: names.length, matched: matched.length, names }
  }

  it('轴心：90 条里至少 80 条能自动落到库中型号（规则化归一后实测 81）', () => {
    const { total, matched } = coverageOf('axis')
    expect(total).toBe(90)
    expect(matched).toBeGreaterThanOrEqual(80)
  })

  it('苏联：117 条里至少 114 条能自动落到库中型号（实测 116，唯一落空的是"3x Reserve Markers"）', () => {
    const { total, matched, names } = coverageOf('soviet')
    expect(total).toBe(117)
    expect(matched).toBeGreaterThanOrEqual(114)
    const store = newStore()
    store.setActiveSide('soviet')
    // 落空的必须是"非算子"条目（预备标记），不能是某个真实算子没对上
    const missed = names.filter((name) => store.matchArrivalRecord(name) === null)
    expect(missed).toEqual(['3x Reserve Markers'])
  })
})
