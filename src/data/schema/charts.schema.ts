import { z } from 'zod'

import { DataFileMetaSchema } from './common.schema'

/**
 * 图表数值契约（charts-crt.json / charts-tables.json）
 *
 * 全部查表以「骰行 × 列位」矩阵落地；网格表的结果元素为原文结果代码（CRT 代码、
 * "DG"、"[1/2]"、百分比等），语义保留在数据或调用侧解析。
 */

/** 通用网格表：rows（行标注） × columns（列标注） → grid（行主序矩阵） */
export const GridTableSchema = z
  .object({
    /** 表标识（如 'barrage'、'capture'、'flak-mission-loss'） */
    id: z.string().min(1),
    name: z.string().optional(),
    /** 行标注（掷骰值/区间/类别） */
    rows: z.array(z.union([z.string(), z.number()])),
    /** 列标注（值段/类别/odds） */
    columns: z.array(z.string()).optional(),
    /** 矩阵本体：行数 × 列数 = rows.length × columns.length */
    grid: z.array(z.array(z.string())),
    /** 成本行（弹药/SP 成本，可选；如轰炸表每次炮击成本） */
    cost: z.array(z.number().nonnegative()).optional(),
    /**
     * 表标识的补充说明（可选；如「掷骰值 1 与 7 同列」这类与原表排印有关的注记）
     *
     * ★ M10② 收窄时按**数据实况**补声明：`charts-tables.json` 的 3 张表带该字段，
     *   而 schema 原先没写 ⇒ `.passthrough()` 静默放过（写错字段名也不会报）。
     */
    idNote: z.string().optional(),
  })
  .strict()

export type GridTable = z.infer<typeof GridTableSchema>

/** CRT（9.9）：掷骰行 + 地形列位映射表 + 195 格矩阵 */
export const CrtDataSchema = z
  .object({
    id: z.literal('crt'),
    /** 15 个掷骰行标注（"1 or less" … "15 or more"） */
    diceRows: z.array(z.string()).length(15),
    /** 4 个地形类的 13 个 odds 列位（Extr Close/Very Close/Close/Open） */
    terrainColumns: z.record(z.string(), z.array(z.string()).length(13)),
    /** 15 × 13 结果代码矩阵（行主序；地形只改列标签不换矩阵） */
    matrix: z.array(z.array(z.string())),
    /** 结果代码语义表（可选项） */
    resultCodes: z.record(z.string(), z.string()).optional(),
  })
  .strict()

export type CrtData = z.infer<typeof CrtDataSchema>

/** charts-crt.json */
export const ChartsCrtSchema = z
  .object({
    meta: DataFileMetaSchema,
    crt: CrtDataSchema,
  })
  .strict()

export type ChartsCrtData = z.infer<typeof ChartsCrtSchema>

/** charts-tables.json：其余网格表集合 */
export const ChartsTablesSchema = z
  .object({
    meta: DataFileMetaSchema,
    tables: z.array(GridTableSchema),
  })
  .strict()

export type ChartsTablesData = z.infer<typeof ChartsTablesSchema>
