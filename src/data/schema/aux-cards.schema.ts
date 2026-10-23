import { z } from 'zod'

import { DataFileMetaSchema, SideSchema } from './common.schema'

/**
 * aux-cards.json 契约：辅助卡分区（地图外盒 / 死人堆 / 空军盒）
 *
 * 数据用途：把「盒」按**真实卡面**画出来，并把盒内算子摆进标定好的分区。
 * 坐标是**卡面图像素**（左上为原点，x 向右、y 向下）；渲染侧按显示尺寸等比缩放。
 *
 * 来源：用户 2026-09-16 交付的 `D:\OCS\六角格标定测试\辅助卡标定\*.boxes.json`
 * （已由 `scripts/sync-aux-cards.mjs` 自源库 `aux_cards.json` 归一搬运，矩形越界在入库时已拦）。
 */

/**
 * 分区（盒）类型 —— 引擎口径
 *
 * - `dead_pile`：死人堆（13.5；飞机与同阵营地面单位共用，用户裁定）
 * - `markers`：标记存放（3.6 六类标记的归置区）
 * - `breakdown_pool`：拆分单位存放（1.8a 上限 / 20.0g 算子池）
 * - `formation_draw`：编队标记抽取盒（13.7 抽取）
 * - `special_repl_division_pool`：可抽取步兵师存放（1.6c 表 1-3 的固定项池）
 * - `alarm_pool`：警戒单位存放（专规 2.3a；上限 3/5/7 见单位库 `alarmLimit`）
 * - `edge_box_northeast` / `edge_box_southeast`：地图外入口盒（6.1b / 13.6 的入口带）
 * - `air_box_active` / `air_box_inactive`：空军地图外盒的激活 / 未激活区（14.1b / 15.0）
 */
export const BoxRegionKindSchema = z.enum([
  'dead_pile',
  'markers',
  'breakdown_pool',
  'formation_draw',
  'special_repl_division_pool',
  'alarm_pool',
  'edge_box_northeast',
  'edge_box_southeast',
  'air_box_active',
  'air_box_inactive',
  /**
   * B31c：**运力记录轨**（专规 1.2 / 13.3b）——`Rail-Sea-Cap` 卡上的 1SP–10SP 主轨与 0T–3T 副轨
   *
   * 它不是"装算子的盒"，而是"放标记的记录轨"：界面据当前容量把标记推到对应格。
   */
  'capacity_track',
])

export type BoxRegionKind = z.infer<typeof BoxRegionKindSchema>

/** 卡面像素矩形 */
export const CardRectSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  })
  .strict()

export type CardRect = z.infer<typeof CardRectSchema>

/** 卡上的一个分区 */
export const CardRegionSchema = z
  .object({
    /** 标定时的分区 id（如 `box-1`） */
    id: z.string().min(1),
    /** 用户标定时的原文标签（中文），保留以便对照卡面 */
    label: z.string().min(1),
    boxKind: BoxRegionKindSchema,
    rect: CardRectSchema,
  })
  .strict()

export type CardRegion = z.infer<typeof CardRegionSchema>

/** 一张辅助卡 */
export const AuxCardSchema = z
  .object({
    id: z.string().min(1),
    /**
     * 归属侧；`both` ＝ **双方共用**的卡（如运力记录轨：一张卡上两组轨，按当前方推标记）
     */
    side: SideSchema.or(z.literal('both')),
    /** 卡的类别：死人堆 / 地图外盒 / 空军盒 */
    boxKind: z.enum(['dead_pile', 'offboard', 'air_box', 'capacity_track']),
    name: z.string().min(1),
    /** 卡面图文件名（位于素材库 `图片素材库\地图及辅助卡`） */
    image: z.string().min(1),
    imageSize: z
      .object({ w: z.number().int().positive(), h: z.number().int().positive() })
      .strict(),
    regions: z.array(CardRegionSchema).min(1),
  })
  .strict()

export type AuxCard = z.infer<typeof AuxCardSchema>

/** aux-cards.json 文件结构 */
export const AuxCardsDataSchema = z
  .object({
    meta: DataFileMetaSchema,
    cards: z.array(AuxCardSchema),
  })
  .strict()

export type AuxCardsData = z.infer<typeof AuxCardsDataSchema>
