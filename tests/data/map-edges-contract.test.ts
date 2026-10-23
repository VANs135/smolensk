import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { isBridgeCrossing } from '@/engine/rules'

/**
 * map_edges.json ↔ 引擎 桥梁交叉校验
 *
 * 用户裁定（2026-09-12）：地图上的桥梁不是独立符号，就是「联通河格边的路」。
 * 故 bridge 必须恒等于「该格边是河/湖 ∧ 该格边有路或铁路」——本组用例让引擎
 * 独立重算全 6662 条格边，确认库里缓存的 bridge 与引擎判定逐条一致。
 *
 * 提取库不在本仓库内，缺文件时整组跳过。
 *   SMOLENSK_MAP_EDGES="D:\\OCS\\...\\map_edges.json" npx vitest run
 */
const DB_PATH =
  process.env['SMOLENSK_MAP_EDGES'] ??
  'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库\\map_edges.json'

interface EdgeRecord {
  edge_key: string
  /** 两端格号（源库每条边都带；用于图内/图外判定） */
  hex_a: string
  hex_b: string
  edge_terrain?: string
  river_class?: string | null
  lake_edge?: unknown
  road_present?: boolean
  road_subclass?: string | null
  rail_present?: boolean
  bridge?: boolean
  edge_routes?: string[]
  edge_route?: string | null
  bridge_route?: string | null
  /** 源库图面外框终止旗标（只覆盖矩形之外的一端，见下方蕴含用例） */
  off_map_stub?: boolean
  /** 源库图面外框边旗标（实测：全部满足「至少一端不在图内」，可由图内格清单派生） */
  map_edge?: boolean
}

interface EdgeDoc {
  meta: {
    bridge_count?: number
    bridge_rule?: string
    bridge_review?: unknown[]
    fields?: string[]
  }
  items: EdgeRecord[]
}

const loaded = existsSync(DB_PATH)
const doc: EdgeDoc | null = loaded ? (JSON.parse(readFileSync(DB_PATH, 'utf8')) as EdgeDoc) : null

/** 图内格清单（map_hexes.json，与 map_edges 同目录）；用于格边端点的图内/图外判定 */
const HEX_DB_PATH = join(dirname(DB_PATH), 'map_hexes.json')
const hexLoaded = loaded && existsSync(HEX_DB_PATH)
const onMapHexIds: ReadonlySet<string> | null = hexLoaded
  ? new Set(
      (
        JSON.parse(readFileSync(HEX_DB_PATH, 'utf8')) as {
          items: { hex_id: string; on_map?: boolean }[]
        }
      ).items
        .filter((hex) => hex.on_map === true)
        .map((hex) => hex.hex_id),
    )
  : null

/** 把一条格边记录翻译成引擎的 crossing 形状（与引擎注释里写的对应关系一致） */
function toCrossing(e: EdgeRecord) {
  const riverish = e.edge_terrain === 'river' || e.edge_terrain === 'lake' || Boolean(e.lake_edge)
  return {
    river: riverish ? (e.river_class === 'major' ? 'Major River' : 'Minor River') : null,
    routes: [
      ...(e.road_present && e.road_subclass ? [e.road_subclass] : []),
      ...(e.rail_present ? ['Railroad'] : []),
    ],
  }
}

describe.skipIf(!loaded)('map_edges.json 桥梁与引擎判定交叉校验', () => {
  it('桥规则文本已按用户裁定写入 meta', () => {
    expect(doc!.meta.bridge_rule).toBeDefined()
    expect(doc!.meta.bridge_rule).toContain('联通河格边的路')
  })

  it('bridge 恒等于「河/湖格边 ∧ 有路/铁」，逐条与引擎一致', () => {
    const bad: string[] = []
    for (const e of doc!.items) {
      const want = isBridgeCrossing(toCrossing(e))
      if (want !== Boolean(e.bridge)) {
        bad.push(`${e.edge_key}: 库=${e.bridge} 引擎=${want}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('edge_routes 与 road_subclass / rail_present 一致（该边承载的路，含非桥边）', () => {
    const bad: string[] = []
    for (const e of doc!.items) {
      const want = [
        ...(e.road_present && e.road_subclass ? [e.road_subclass] : []),
        ...(e.rail_present ? ['Railroad'] : []),
      ]
      const got = e.edge_routes ?? []
      if (JSON.stringify(got) !== JSON.stringify(want))
        bad.push(`${e.edge_key}: 库=${got} 应为=${want}`)
    }
    expect(bad).toEqual([])
  })

  it('bridge_route 只在该边真是桥时才有值（2026-09-12 改名后的语义）', () => {
    const bad: string[] = []
    for (const e of doc!.items) {
      const isBridge = isBridgeCrossing(toCrossing(e))
      if (!isBridge && e.bridge_route)
        bad.push(`${e.edge_key}: 非桥却有 bridge_route=${e.bridge_route}`)
      if (isBridge && !e.bridge_route) bad.push(`${e.edge_key}: 是桥但 bridge_route 为空`)
    }
    expect(bad).toEqual([])
  })

  it('真正的桥数（river/lake ∧ route）落在 meta.bridge_count 上', () => {
    const n = doc!.items.filter((e) => isBridgeCrossing(toCrossing(e))).length
    expect(n).toBe(doc!.meta.bridge_count)
  })

  it('河流分级与格边地形取值合法', () => {
    const bad: string[] = []
    for (const e of doc!.items) {
      if (!['none', 'river', 'lake', 'map_edge'].includes(e.edge_terrain ?? '')) {
        bad.push(`${e.edge_key}: edge_terrain=${e.edge_terrain}`)
      }
      const rc = e.river_class ?? null
      if (rc !== null && !['major', 'minor'].includes(rc))
        bad.push(`${e.edge_key}: river_class=${rc}`)
      if (e.edge_terrain === 'river' && rc === null)
        bad.push(`${e.edge_key}: 河格边却无 river_class`)
    }
    expect(bad).toEqual([])
  })

  it('出现判定与实测分歧时，meta.bridge_review 必须有记录', () => {
    // 本用例只作存在性把关：分歧清单是交给用户目检的入口，不能被静默清空
    const hasReview = Array.isArray(doc!.meta.bridge_review)
    expect(hasReview).toBe(true)
  })
})

describe.skipIf(!hexLoaded)('map_edges.json 图边终止与图内格清单的蕴含关系', () => {
  it('每条边都带非空的两端格号（否则下列蕴含用例会静默失效）', () => {
    const bad = doc!.items
      .filter(
        (e) => typeof e.hex_a !== 'string' || typeof e.hex_b !== 'string' || !e.hex_a || !e.hex_b,
      )
      .map((e) => e.edge_key)
    expect(bad).toEqual([])
  })

  it('源库 off_map_stub ⇒ 至少一端不在图内（故产物按图内格清单派生不会漏掉这些边）', () => {
    const bad: string[] = []
    for (const e of doc!.items) {
      if (e.off_map_stub !== true) continue
      if (onMapHexIds!.has(e.hex_a) && onMapHexIds!.has(e.hex_b)) bad.push(e.edge_key)
    }
    expect(bad).toEqual([])
  })

  it('源库 map_edge（图面外框边）也满足「至少一端不在图内」', () => {
    const bad: string[] = []
    for (const e of doc!.items) {
      if (e.map_edge !== true) continue
      if (onMapHexIds!.has(e.hex_a) && onMapHexIds!.has(e.hex_b)) bad.push(e.edge_key)
    }
    expect(bad).toEqual([])
  })

  it('反向不成立：存在端点在图外却未标 off_map_stub 的边（源库旗标比地理事实窄）', () => {
    // 该用例把「源库旗标 ≠ 地理事实」这一实测事实固定下来：
    // 产物 offMapStub 由图内格清单派生，而非搬源库旗标；若哪天源库补齐了旗标，本用例会失败并提示复核。
    const unflagged = doc!.items.filter(
      (e) => e.off_map_stub !== true && (!onMapHexIds!.has(e.hex_a) || !onMapHexIds!.has(e.hex_b)),
    )
    expect(unflagged.length).toBeGreaterThan(0)
  })
})
