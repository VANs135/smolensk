import { z } from 'zod'

import { DataFileMetaSchema, HexRefSchema } from './common.schema'

/**
 * map-config.json 契约（A3 网格标定产出）
 *
 * 本作单幅地图、编号无字母前缀，印刷编号即列与行，故不含 zone 与显示前缀；
 * 入口字母（A–L）是入口格属性，与坐标分开存于 entryHexes。
 */
export const MapConfigSchema = z
  .object({
    meta: DataFileMetaSchema,

    /** 六角格朝向：本作 flat-top（水平六角） */
    orientation: z.enum(['flat', 'pointy']),
    /** 偏移方式：奇数行/列下移半格（标定时确定） */
    offset: z.enum(['odd-r', 'even-r', 'odd-q', 'even-q']),

    /** 格号范围（含端点） */
    bounds: z
      .object({
        colStart: z.number().int(),
        colEnd: z.number().int(),
        rowStart: z.number().int(),
        rowEnd: z.number().int(),
      })
      .strict(),

    /** 网格几何参数（像素） */
    geometry: z
      .object({
        hexWidthPx: z.number().positive(),
        hexHeightPx: z.number().positive(),
        originX: z.number(),
        originY: z.number(),
      })
      .strict(),

    /** 印刷行号 → 程序行号换算表（业务代码不做二次转换） */
    rowDecode: z.record(z.string(), z.number()).optional(),

    /** 入口字母 A–L → 坐标列表（一字母可对应多个入场格；到达表落格的唯一依赖，A3 落定） */
    entryHexes: z.record(z.string(), z.array(HexRefSchema)).optional(),

    /** 胜利格坐标（5.0b / 剧本专属） */
    victoryLocations: z.array(HexRefSchema).optional(),

    /** 装甲集群分界线端点对（专规 3.4a） */
    panzerGroupBoundary: z.array(z.tuple([HexRefSchema, HexRefSchema])).optional(),
  })
  .strict()

export type MapConfigData = z.infer<typeof MapConfigSchema>
