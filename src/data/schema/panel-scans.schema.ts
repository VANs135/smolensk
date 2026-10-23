import { z } from 'zod'

import { DataFileMetaSchema } from './common.schema'

/**
 * panel-scans.json 契约：**印卡扫描图**清单（表格屏的"看原卡"那一半）
 *
 * 依据：用户 2026-09-16 口径「**盒还有表格可以直接用素材库里辅助卡图片**」——
 * 表格屏不必手画表格，官方印卡就是权威版式（比例、图例、脚注都照原样）。
 *
 * 与 `aux-cards.schema.ts` 的分工：
 *   · `aux-cards.json` 是**分区标定**（矩形坐标 ⇒ 能往盒里摆算子），只覆盖 6 张盒卡；
 *   · 本文件是**整页查阅图**（只给屏归属与尺寸），覆盖表格屏的 12 张图表 / 记录轨。
 *
 * 图档路径：素材库 `图片素材库\地图及辅助卡` ⇒ 产物 `public/aux-cards/`（由
 * `scripts/sync-aux-card-images.mjs` 一并拷贝，命名**保留原文件名**、URL 侧用 `encodeURIComponent`）。
 */

/**
 * 表格屏标识（与 `BottomTray.vue` 的屏 key 同口径；组件不得自造第二套名字）
 *
 * - `crt`：战斗结果表（CRT 与其同伴表）
 * - `supply`：补给 / 补员 / 特殊补员 / 重建
 * - `tec`：地形效果表与地形图例
 * - `vars`：变量撤离（3.3c）与随机事件（3.6）
 *
 * ★ B35（用户口径 #11「辅助卡**只放卡图**」）：原 `turn` 屏已删 ——
 *   回合/天气那一张（`weather-turns`）是**引擎投影表**能给的，铁路海运容量卡（`Rail-Sea-Cap`）归盒；
 *   两张都不再当"整页查阅图"发布（表的那一面在引擎验证页上核对）。
 * - `ooa`：**到达卡**（Order of Arrival；13.6 / 专规 1.6a）—— 每方一张，按 `side` 取
 *
 * ★ `arrivals`（到货）屏**没有**扫描图：那是逐回合现算的到达计划，纸上没有对应卡面。
 */
export const PanelScanScreenSchema = z.enum(['crt', 'supply', 'tec', 'vars', 'ooa'])

export type PanelScanScreen = z.infer<typeof PanelScanScreenSchema>

/** 一张印卡扫描图 */
export const PanelScanSchema = z
  .object({
    id: z.string().min(1),
    screen: PanelScanScreenSchema,
    /** 屏上显示的小标题（照卡面内容写，便于玩家对上"这是哪张表"） */
    title: z.string().min(1),
    /** 可选的补充说明（规则号 / 怎么用） */
    note: z.string().min(1).optional(),
    /**
     * 哪一方的卡（只对**按方成对**的图有意义；B34② 的到达卡两方各一张）
     *
     * 单方共用的表（CRT / TEC / 回合轨）不给这个字段 —— 界面按 `undefined` 走"两边都能看"。
     */
    side: z.enum(['axis', 'soviet']).optional(),
    /** 图档名（位于素材库 `图片素材库\地图及辅助卡`） */
    image: z.string().min(1),
    imageSize: z
      .object({ w: z.number().int().positive(), h: z.number().int().positive() })
      .strict(),
  })
  .strict()

export type PanelScan = z.infer<typeof PanelScanSchema>

/** panel-scans.json 文件结构 */
export const PanelScansDataSchema = z
  .object({
    meta: DataFileMetaSchema,
    scans: z.array(PanelScanSchema),
  })
  .strict()

export type PanelScansData = z.infer<typeof PanelScansDataSchema>
