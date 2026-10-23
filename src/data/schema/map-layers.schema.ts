import { z } from 'zod'

import { DataFileMetaSchema, HexRefSchema, RailGaugeSchema } from './common.schema'

/**
 * map-layers.json 契约（A4 地图图层）
 *
 * 逐格地形与城市 / 格边（河流·道路·铁路·桥梁）/ 地图印刷永久工事；
 * 轨距是全局值（专规 1.2），见顶层 railGauge，不逐边存放。
 * 坐标一律 { col, row }（本作无字母前缀）。胜利格/入口字母/分界线见 map-config.json。
 */

/** 单个格：地形与属性（城市 / 入口 / 补给源并入） */
export const HexLayerSchema = z
  .object({
    col: z.number().int(),
    row: z.number().int(),
    /** 判读主地形（TEC 地形名，如 Forest / Swamp） */
    terrain: z.string().min(1),
    /** 格内全部地形符号（6.2d 取最贵 / 9.3b 防御方候选） */
    terrainsPresent: z.array(z.string()),
    /** 6.2d 缓存标签：格内成本最高地形名 */
    movementTerrain: z.string().min(1),
    /** 城市格：名称 / TEC 等级 / 战略角色（city_role 与 city_level 互不推导） */
    city: z
      .object({
        name: z.string().optional(),
        level: z.string().nullish(),
        role: z.string().nullish(),
      })
      .strict()
      .optional(),
    /** 入口字母（A–L）；到达表落格约束 */
    entryLetter: z.string().optional(),
    /** 是否为苏军补给源格（专规 2.1a） */
    supplySource: z.boolean().optional(),
  })
  .strict()

export type HexLayer = z.infer<typeof HexLayerSchema>

/** 格边（仅存有要素的边：河/路/铁/桥任一） */
export const EdgeLayerSchema = z
  .object({
    /**
     * 端点格（**无序**的一对相邻格）。归一规则：a 的格号在**字符串字典序**上小于 b，
     * 与工程库 map_edges.json 的 `edge_key`（"格号|格号"）同规；故 `a` 未必是源库的 `hex_a`。
     */
    a: HexRefSchema,
    b: HexRefSchema,
    /** 河/湖：minor 小河 / major 大河 / lake 湖泊（湖=禁入） */
    river: z.enum(['minor', 'major', 'lake']).optional(),
    /** 道路等级：Secondary Road（1/2 MP）/ Track（1 MP） */
    road: z.enum(['secondary', 'track']).optional(),
    /** 是否有铁路（轨距是全局值，见顶层 railGauge／专规 1.2） */
    rail: z.boolean().optional(),
    /**
     * 13.3a：该格边是否为**多轨**铁路（源库 map_edges.json 的 `rail_track === "multi"`；
     * 定稿依据＝用户 2026-09-12/15 逐段口述的 9 条多轨走线，其余一律单轨）。
     * 只写「是」的一侧：字段缺省＝单轨。仅 `rail: true` 的格边可带此标记。
     */
    multiTrack: z.boolean().optional(),
    /** 桥梁 = 河/湖格边 + 路或铁路（用户裁定 6.2a） */
    bridge: z.boolean().optional(),
    /**
     * 图边终止：该格边**至少有一端不在图内**（四边削角处与图面外框一侧，
     * 其中西缘边即 A–L 入口所对应的边）→ 引擎不得作为可进入格。
     * 判据与引擎 isOnMap 同源（图内格清单 map-layers.hexes），由 sync-map-layers 的
     * markOffMapStubs 生成；不采用源库 off_map_stub 旗标（它漏掉矩形内削角处的边）。
     */
    offMapStub: z.boolean().optional(),
  })
  .strict()

export type EdgeLayer = z.infer<typeof EdgeLayerSchema>

/** 地图印刷永久工事（专规 1.3 / 1.3a：不可由任何一方降低） */
export const PrintedHedgehogSchema = z
  .object({
    col: z.number().int(),
    row: z.number().int(),
    /** 等级（本作全为 1，已目检确认） */
    level: z.number().int().positive(),
    permanent: z.boolean(),
    /** 1.3a：印刷工事不可降低 */
    cannotReduce: z.boolean(),
  })
  .strict()

export type PrintedHedgehog = z.infer<typeof PrintedHedgehogSchema>

/** map-layers.json 文件整体 */
export const MapLayersDataSchema = z
  .object({
    meta: DataFileMetaSchema,
    /**
     * 印刷轨距（全局值，专规 1.2：本作地图铁路**开局全为宽轨**，除剧本初设另有注明者外）；
     * 逐格换轨见通规 13.3f，本文件不逐边存放。
     */
    railGauge: RailGaugeSchema.optional(),
    hexes: z.array(HexLayerSchema),
    edges: z.array(EdgeLayerSchema),
    printedHedgehogs: z.array(PrintedHedgehogSchema),
  })
  .strict()

export type MapLayersData = z.infer<typeof MapLayersDataSchema>
