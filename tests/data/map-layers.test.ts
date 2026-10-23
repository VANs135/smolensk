import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import {
  markOffMapStubs,
  parseHexRef,
  toEdgeLayer,
  toHexLayer,
  toHedgehogLayer,
} from '../../scripts/sync-map-layers.mjs'
import type { EdgeRaw, FacilityRaw, HexRaw } from '../../scripts/sync-map-layers.mjs'

/** A4 地图图层加载冒烟 + 同步脚本转换函数（数据源 2026-09-12 标定/判读封版） */
describe('map-layers.json 地图图层', () => {
  it('逐格地形覆盖（含半格）且格号无字母前缀', () => {
    const hexes = mapLayers.hexes
    expect(hexes.length).toBeGreaterThan(2000)
    for (const hex of hexes) {
      expect(hex.terrain.length).toBeGreaterThan(0)
      expect(hex.terrainsPresent.length).toBeGreaterThan(0)
      expect(Number.isInteger(hex.col)).toBe(true)
      expect(Number.isInteger(hex.row)).toBe(true)
    }
  })

  it('城市与战略角色并入逐格记录（Bobruysk 为主要城市役）', () => {
    const bobruysk = mapLayers.hexes.find((h) => h.city?.name === 'Bobruysk')
    expect(bobruysk).toBeDefined()
    expect(bobruysk!.city!.level).toBe('Minor City')
    expect(bobruysk!.city!.role).toBe('major_city_victory_condition')
    expect(bobruysk!.city!.name).toBe('Bobruysk')
  })

  it('格边：河流有小/大之分，道路有 Secondary/Track 之分，铁路带轨距', () => {
    const edges = mapLayers.edges
    expect(edges.length).toBeGreaterThan(1000)
    expect(edges.some((e) => e.river === 'minor')).toBe(true)
    expect(edges.some((e) => e.river === 'major')).toBe(true)
    expect(edges.some((e) => e.road === 'secondary')).toBe(true)
    expect(edges.some((e) => e.road === 'track')).toBe(true)
    expect(edges.some((e) => e.rail === true)).toBe(true)

    // 轨距：全局值（专规 1.2）。DB 已删逐格 rail_gauge 列（Y4 去冗余合并），改由产物顶层 railGauge 承载
    expect(['broad', 'standard']).toContain(mapLayers.railGauge)
    expect(mapLayers.railGauge).toBe('broad') // 本作地图铁路即苏方路网，开局全为宽轨
  })

  it('格边两端按格号字符串字典序归一（契约：a < b，与工程库 edge_key 同规）', () => {
    const bad: string[] = []
    for (const edge of mapLayers.edges) {
      const a = `${edge.a.col}.${edge.a.row}`
      const b = `${edge.b.col}.${edge.b.row}`
      if (!(a < b)) bad.push(`${a}|${b}`)
    }
    expect(bad).toEqual([])
  })

  it('图边终止 ⇔ 至少一端不在图内（与引擎 isOnMap 同源，蕴含双向成立）', () => {
    const onMap = new Set(mapLayers.hexes.map((h) => `${h.col}.${h.row}`))
    const flagged = mapLayers.edges.filter((edge) => edge.offMapStub === true)
    const offMapEnded = mapLayers.edges.filter(
      (edge) =>
        !onMap.has(`${edge.a.col}.${edge.a.row}`) || !onMap.has(`${edge.b.col}.${edge.b.row}`),
    )
    expect(flagged.length).toBeGreaterThan(0)
    // 双向：标了的一定有图外端；有图外端的一定标了
    for (const edge of flagged) {
      const anyOff =
        !onMap.has(`${edge.a.col}.${edge.a.row}`) || !onMap.has(`${edge.b.col}.${edge.b.row}`)
      expect(anyOff).toBe(true)
    }
    expect(flagged.length).toBe(offMapEnded.length)
  })

  it('印刷永久工事 57 个、等级全 1 且不可降低（专规 1.3 / 1.3a）', () => {
    // 59（源库）− 36.18（2026-09-14 目检改判）− 7.8（2026-09-15 像素复核改判）= 57
    expect(mapLayers.printedHedgehogs).toHaveLength(57)
    for (const h of mapLayers.printedHedgehogs) {
      expect(h.level).toBe(1)
      expect(h.permanent).toBe(true)
      expect(h.cannotReduce).toBe(true)
    }
    // 两处改判格都不得出现在产物里（曾各是一次「数据库修订遗漏」）
    for (const gone of [
      { col: 36, row: 18 },
      { col: 7, row: 8 },
    ]) {
      expect(
        mapLayers.printedHedgehogs.some((h) => h.col === gone.col && h.row === gone.row),
        `${gone.col}.${gone.row} 不应有印刷工事`,
      ).toBe(false)
    }
  })

  it('13.3a：单/多轨按**格边**携带（125/360 条铁路格边为多轨，其余缺省即单轨）', () => {
    const rail = mapLayers.edges.filter((e) => e.rail === true)
    const multi = rail.filter((e) => e.multiTrack === true)
    expect(rail).toHaveLength(360)
    expect(multi).toHaveLength(125)
    // 多轨标记只出现在铁路格边上（数据自洽）
    expect(mapLayers.edges.filter((e) => e.multiTrack === true && e.rail !== true)).toEqual([])
  })

  it('13.3a：多轨是**格边**属性 —— 同一格可以一侧多轨、一侧单轨', () => {
    const key = (h: { col: number; row: number }): string => `${h.col}.${h.row}`
    const edgeKey = (a: { col: number; row: number }, b: { col: number; row: number }): string =>
      [key(a), key(b)].sort().join('|')
    const multiKeys = new Set(
      mapLayers.edges.filter((e) => e.multiTrack === true).map((e) => edgeKey(e.a, e.b)),
    )
    // Mogilev 15.10：东/北向是多轨干线（15.11、14.10），西北向支线（14.9）与东南向（16.9）是单轨
    const incident = mapLayers.edges.filter(
      (e) => e.rail === true && (key(e.a) === '15.10' || key(e.b) === '15.10'),
    )
    const state = incident.map((e) => {
      const other = key(e.a) === '15.10' ? key(e.b) : key(e.a)
      return `${other}:${multiKeys.has(edgeKey(e.a, e.b)) ? '多轨' : '单轨'}`
    })
    expect(state.sort()).toEqual(['14.10:多轨', '14.9:单轨', '15.11:多轨', '16.9:单轨'].sort())
  })

  it('13.3a：用户口述的多轨走线连成三个分量（一条多分支干线、一条支线、一条孤立线）', () => {
    const key = (h: { col: number; row: number }): string => `${h.col}.${h.row}`
    const adj = new Map<string, string[]>()
    for (const e of mapLayers.edges) {
      if (e.multiTrack !== true) continue
      const a = key(e.a)
      const b = key(e.b)
      ;(adj.get(a) ?? adj.set(a, []).get(a)!).push(b)
      ;(adj.get(b) ?? adj.set(b, []).get(b)!).push(a)
    }
    const seen = new Set<string>()
    const sizes: number[] = []
    for (const start of adj.keys()) {
      if (seen.has(start)) continue
      const stack = [start]
      seen.add(start)
      let count = 0
      while (stack.length > 0) {
        const cur = stack.pop()!
        count += 1
        for (const next of adj.get(cur) ?? []) {
          if (!seen.has(next)) {
            seen.add(next)
            stack.push(next)
          }
        }
      }
      sizes.push(count)
    }
    // 干线（含 Y 字路口 19.19 / 19.28 / 18.18）114 格 + 入场 D 支线 9 格 + 入场 G 孤立线 5 格
    expect(sizes.sort((a, b) => b - a)).toEqual([114, 9, 5])
  })

  it('13.3a：用户口述的 9 段多轨走线**只经多轨格边**即可走通（含各入场格）', () => {
    const key = (h: { col: number; row: number }): string => `${h.col}.${h.row}`
    const multiAdj = new Map<string, string[]>()
    for (const e of mapLayers.edges) {
      if (e.multiTrack !== true) continue
      const a = key(e.a)
      const b = key(e.b)
      if (!multiAdj.has(a)) multiAdj.set(a, [])
      if (!multiAdj.has(b)) multiAdj.set(b, [])
      multiAdj.get(a)!.push(b)
      multiAdj.get(b)!.push(a)
    }
    /** 只用多轨格边的 BFS：返回跳数（不可达 = null） */
    const multiOnlyHops = (from: string, to: string): number | null => {
      if (from === to) return 0
      const seen = new Set([from])
      const queue: [string, number][] = [[from, 0]]
      while (queue.length > 0) {
        const [cur, hops] = queue.shift()!
        for (const next of multiAdj.get(cur) ?? []) {
          if (seen.has(next)) continue
          if (next === to) return hops + 1
          seen.add(next)
          queue.push([next, hops + 1])
        }
      }
      return null
    }
    // 用户 2026-09-12/15 口述的 9 段（入场格：D=62.4、G=1.3、H=1.7、J=1.19、L=20.35，见 map-config.entryHexes）
    const segments: [string, string, string][] = [
      ['①入场 B（62.23）西南 → 18.18', '62.23', '18.18'],
      ['②19.19 → 19.28（19.19 为 Y 字路口）', '19.19', '19.28'],
      ['③19.28 北 → 入场 L（20.35）', '19.28', '20.35'],
      ['④19.28 西北 → 11.33', '19.28', '11.33'],
      ['⑤18.18 西北 → 入场 J（1.19）', '18.18', '1.19'],
      ['⑥18.18 → 15.10', '18.18', '15.10'],
      ['⑦15.10 西北 → 入场 H（1.7）', '15.10', '1.7'],
      ['⑧入场 G（1.3）→ 3.1 / 4.0（孤立短多轨）', '1.3', '4.0'],
      ['⑨入场 D（62.4）→ 56.0（支线）', '62.4', '56.0'],
    ]
    for (const [name, from, to] of segments) {
      const hops = multiOnlyHops(from, to)
      expect({ name, hops: hops !== null }).toEqual({ name, hops: true })
    }
  })

  it('深度冻结（嵌套不可写）', () => {
    expect(Object.isFrozen(mapLayers)).toBe(true)
    expect(Object.isFrozen(mapLayers.hexes)).toBe(true)
    expect(Object.isFrozen(mapLayers.edges)).toBe(true)
    expect(Object.isFrozen(mapLayers.printedHedgehogs)).toBe(true)
    expect(Object.isFrozen(mapLayers.hexes[0])).toBe(true)
    expect(Object.isFrozen(mapLayers.edges[0])).toBe(true)
  })
})

describe('sync-map-layers 转换函数（脚本级）', () => {
  it('toHexLayer：地形/城市/入口/补给源并入', () => {
    const raw: HexRaw = {
      col: 36,
      row: 13,
      terrain: 'Open',
      terrains_present: ['Open'],
      movement_terrain: 'Open',
      city_hex: true,
      city_name: 'Pochinok',
      city_level: 'Village',
      city_role: 'victory_objective',
      entry_letter: 'F',
      supply_source: true,
    }
    expect(toHexLayer(raw)).toEqual({
      col: 36,
      row: 13,
      terrain: 'Open',
      terrainsPresent: ['Open'],
      movementTerrain: 'Open',
      city: { name: 'Pochinok', level: 'Village', role: 'victory_objective' },
      entryLetter: 'F',
      supplySource: true,
    })
  })

  it('toEdgeLayer：河/路/铁/桥/轨距/图边终止映射', () => {
    const riverMinor: EdgeRaw = {
      hex_a: '1.1',
      hex_b: '2.1',
      edge_terrain: 'river',
      river_class: 'minor',
    }
    expect(toEdgeLayer(riverMinor)).toEqual({
      a: { col: 1, row: 1 },
      b: { col: 2, row: 1 },
      river: 'minor',
    })

    const roadRail: EdgeRaw = {
      hex_a: '1.3',
      hex_b: '2.2',
      road_present: true,
      road_subclass: 'Secondary Road',
      rail_present: true,
    }
    expect(toEdgeLayer(roadRail)).toEqual({
      a: { col: 1, row: 3 },
      b: { col: 2, row: 2 },
      road: 'secondary',
      rail: true,
    })

    // 13.3a：单/多轨按格边导出（源库 rail_track="multi" 才写标记；single / 缺省都不写）
    const multiRail: EdgeRaw = {
      hex_a: '19.19',
      hex_b: '19.20',
      rail_present: true,
      rail_track: 'multi',
    }
    expect(toEdgeLayer(multiRail)).toMatchObject({ rail: true, multiTrack: true })
    const singleRail: EdgeRaw = {
      hex_a: '19.19',
      hex_b: '19.20',
      rail_present: true,
      rail_track: 'single',
    }
    expect(toEdgeLayer(singleRail).multiTrack).toBeUndefined()
    // 没有铁路的格边不携带多轨标记（多轨只存在于铁路格边上）
    const multiNoRail: EdgeRaw = { hex_a: '19.19', hex_b: '19.20', rail_track: 'multi' }
    expect(toEdgeLayer(multiNoRail).multiTrack).toBeUndefined()

    const lake: EdgeRaw = { hex_a: '5.5', hex_b: '6.5', edge_terrain: 'lake' }
    expect(toEdgeLayer(lake)).toEqual({
      a: { col: 5, row: 5 },
      b: { col: 6, row: 5 },
      river: 'lake',
    })
  })

  it('toEdgeLayer：两端按格号字符串字典序归一（与工程库 edge_key 同规）', () => {
    // 源库同一条边可能把较大格号写成 hex_a（317/6662 条如此），产物必须归一为 a < b
    const reversed: EdgeRaw = {
      hex_a: '1.1',
      hex_b: '1.0',
      edge_terrain: 'river',
      river_class: 'minor',
    }
    expect(toEdgeLayer(reversed)).toEqual({
      a: { col: 1, row: 0 },
      b: { col: 1, row: 1 },
      river: 'minor',
    })

    // 字符串序（非数值序）：「1.10」排在「1.9」之前，与 edge_key 的写法一致
    const stringOrder: EdgeRaw = { hex_a: '1.10', hex_b: '1.9', road_present: true }
    expect(toEdgeLayer(stringOrder).a).toEqual({ col: 1, row: 10 })
    expect(toEdgeLayer(stringOrder).b).toEqual({ col: 1, row: 9 })
  })

  it('markOffMapStubs：至少一端不在图内才标 offMapStub（与引擎 isOnMap 同源）', () => {
    const onMap = new Set(['1.3', '2.2', '36.13'])
    const mapped = [
      { a: { col: 1, row: 3 }, b: { col: 2, row: 2 }, road: 'secondary' }, // 两端都在图内
      { a: { col: 1, row: 3 }, b: { col: 0, row: 2 }, road: 'track' }, // 西缘入口边
      { a: { col: 13, row: 0 }, b: { col: 13, row: 1 }, river: 'minor' }, // 矩形内削角格（图外）
    ]
    const marked = markOffMapStubs(mapped, onMap) as { offMapStub?: boolean }[]
    expect(marked[0]!.offMapStub).toBeUndefined()
    expect(marked[1]!.offMapStub).toBe(true)
    expect(marked[2]!.offMapStub).toBe(true)
    // 不改动原有字段
    expect(marked[0]).toMatchObject({ road: 'secondary' })
    expect(marked[2]).toMatchObject({ river: 'minor' })
  })

  it('toHedgehogLayer：印刷工事（等级/永久/不可降低）', () => {
    const raw: FacilityRaw = {
      kind: 'printed_hedgehog',
      hex_id: '58.35',
      level: 1,
      permanent: true,
      cannot_reduce: true,
    }
    expect(toHedgehogLayer(raw)).toEqual({
      col: 58,
      row: 35,
      level: 1,
      permanent: true,
      cannotReduce: true,
    })
  })

  it('parseHexRef（无字母前缀）', () => {
    expect(parseHexRef('62.33')).toEqual({ col: 62, row: 33 })
    expect(() => parseHexRef('x.y')).toThrow(/无法解析格号/)
  })
})
