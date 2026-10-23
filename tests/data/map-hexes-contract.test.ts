import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'

import { combatTerrainCandidates, isHexsideTerrain, selectTerrainLabel } from '@/engine/rules'
import { isOnMap, onMapNeighbors } from '@/engine/hex-geometry'

/**
 * map_hexes.json ↔ 引擎 交叉校验
 *
 * 提取库（斯摩棱斯克工程数据库）不在本仓库内，缺文件时整组跳过，
 * 使本用例可随仓库分发而不破坏他人环境。要跑本组：
 *   SMOLENSK_MAP_HEXES="D:\\OCS\\...\\map_hexes.json" npx vitest run
 *
 * 校验意图：不是复述 meta 的自述，而是让**引擎**用 TEC 独立重算一遍，
 * 确认库里缓存的 movement_terrain 与引擎 6.2d 的取最贵结果逐格一致。
 */
const DB_PATH =
  process.env['SMOLENSK_MAP_HEXES'] ??
  'D:\\OCS\\OCS斯摩棱斯克素材\\斯摩棱斯克工程数据库\\map_hexes.json'

interface HexRecord {
  hex_id: string
  terrains_present?: string[]
  terrain?: string
  movement_terrain?: string
  terrain_status?: string
  city_hex?: boolean
  city_level?: string | null
}

interface HexDoc {
  meta: { count: number; terrain_model?: Record<string, unknown> }
  items: HexRecord[]
}

const loaded = existsSync(DB_PATH)
const doc: HexDoc | null = loaded ? (JSON.parse(readFileSync(DB_PATH, 'utf8')) as HexDoc) : null

describe.skipIf(!loaded)('map_hexes.json 与引擎 6.2d 交叉校验', () => {
  it('契约块存在', () => {
    expect(doc!.meta.terrain_model).toBeDefined()
    expect(doc!.meta.terrain_model).toHaveProperty('rule_6_2d')
    expect(doc!.meta.terrain_model).toHaveProperty('rule_9_3b')
  })

  it('terrains_present 不含格边地形', () => {
    const bad: string[] = []
    for (const r of doc!.items) {
      for (const t of r.terrains_present ?? []) {
        if (isHexsideTerrain(t)) bad.push(`${r.hex_id}:${t}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('movement_terrain 与引擎按 TEC 取最贵的结果逐格一致', () => {
    const bad: string[] = []
    for (const r of doc!.items) {
      const want = selectTerrainLabel(r.terrains_present ?? [])
      if (want !== r.movement_terrain)
        bad.push(`${r.hex_id}: 库=${r.movement_terrain} 引擎=${want}`)
    }
    expect(bad).toEqual([])
  })

  it('terrain 必在 terrains_present 内', () => {
    const bad: string[] = []
    for (const r of doc!.items) {
      if (!(r.terrains_present ?? []).includes(r.terrain ?? '')) bad.push(r.hex_id)
    }
    expect(bad).toEqual([])
  })

  it('9.3b 候选集非空，且城市格才把城市/村庄符号计入', () => {
    const bad: string[] = []
    for (const r of doc!.items) {
      const cands = combatTerrainCandidates({
        terrainsPresent: r.terrains_present ?? [],
        cityHex: Boolean(r.city_hex),
      })
      if (cands.length === 0) bad.push(`${r.hex_id}: 无候选`)
      const nonCity = combatTerrainCandidates({
        terrainsPresent: r.terrains_present ?? [],
        cityHex: false,
      })
      if (nonCity.some((c) => ['Village', 'Minor City', 'Major City'].includes(c)))
        bad.push(`${r.hex_id}: 溢出未过滤`)
    }
    expect(bad).toEqual([])
  })

  it('全量记录带 terrain_status（标明取值是否已定案）', () => {
    const missing = doc!.items.filter((r) => !r.terrain_status).map((r) => r.hex_id)
    expect(missing).toEqual([])
  })

  it('记录数与 meta.count 一致', () => {
    expect(doc!.items).toHaveLength(doc!.meta.count)
  })
})

/* ────────────────────────── 半格契约（★ 用户裁定 2026-09-13） ────────────────────────── */

interface HalfHexRecord {
  hex_id: string
  col: number
  row: number
  on_map?: boolean
  on_map_ratio?: number
  state?: string
}

/** 半格表（与 map_hexes 同目录；裸列表与 {meta, items} 两形兼容） */
const HALF_DB_PATH = join(dirname(DB_PATH), 'half_hexes.json')
const halfLoaded = loaded && existsSync(HALF_DB_PATH)
const halfHexes: HalfHexRecord[] = halfLoaded
  ? (() => {
      const raw = JSON.parse(readFileSync(HALF_DB_PATH, 'utf8')) as
        HalfHexRecord[] | { items: HalfHexRecord[] }
      return Array.isArray(raw) ? raw : raw.items
    })()
  : []

/**
 * 半格 = 只印了半个六角形的边缘格（上/下边缘与西南角）。
 * ★ 用户裁定（2026-09-13）：**半个格子也视为正常格子**——不得因「只印了半个」判为图外。
 * 本组用例保证：凡源库标 on_map 的半格，都进了产物格清单、都被引擎 isOnMap 判为图内、都有图内邻格。
 */
describe.skipIf(!halfLoaded)('half_hexes.json 半格视为正常图内格（★ 用户裁定）', () => {
  it('半格表非空且全部标 on_map', () => {
    expect(halfHexes.length).toBeGreaterThan(0)
    expect(halfHexes.filter((hex) => hex.on_map !== true)).toEqual([])
  })

  it('半格数与 map_hexes.meta.half_count 一致', () => {
    const meta = JSON.parse(readFileSync(DB_PATH, 'utf8')) as { meta: { half_count?: number } }
    expect(halfHexes).toHaveLength(meta.meta.half_count ?? halfHexes.length)
  })

  it('每个半格都进了产物格清单，且被判为图内并有图内邻格', () => {
    const productIds = new Set(mapLayers.hexes.map((hex) => `${hex.col}.${hex.row}`))
    const bad: string[] = []
    for (const hex of halfHexes) {
      const ref = { col: hex.col, row: hex.row }
      if (!productIds.has(hex.hex_id)) bad.push(`${hex.hex_id}:未进产物`)
      else if (!isOnMap(ref)) bad.push(`${hex.hex_id}:被判图外`)
      else if (onMapNeighbors(ref).length === 0) bad.push(`${hex.hex_id}:无图内邻格`)
    }
    expect(bad).toEqual([])
  })

  it('半格只出现在边缘行（0 / 31 / 35），不落在图内深处', () => {
    const rows = new Set(halfHexes.map((hex) => hex.row))
    expect([...rows].sort((a, b) => a - b)).toEqual([0, 31, 35])
  })
})
