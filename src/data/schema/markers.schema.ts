import { z } from 'zod'

import { DataFileMetaSchema, IsoDateSchema, MarkerSideSchema, SideSchema } from './common.schema'

/**
 * markers.json 契约（A6 标记与记录轨）
 *
 * 标记按规则分类（rule_class：3.6 / 5.0c / 13.3 / 15.0 / 16.0 / 专规 1.7）；
 * 记录轨与容器给出数据结构与初始内容，引擎只做状态驱动，不做手工摆放。
 */

/** 单个标记 */
export const MarkerSchema = z
  .object({
    /** 稳定主键：<识别>-<名称>（沿用工程库 marker_id，如 mk-10） */
    id: z.string().min(1),
    name: z.string().min(1),
    /** 归属阵营 / 中立（通用磁贴）/ both（双方通用，如铁路端点与建设标记） */
    side: MarkerSideSchema.optional(),
    /** 规则分类（3.6a/3.6b/3.6c/3.6d/3.6e/3.6f/5.0c/10.0c/13.3d/13.3b/15.0/16.0/spec_1.7/spec_3.5） */
    ruleClass: z.string().optional(),
    classLabel: z.string().optional(),
    /** 正面图档（可为空：部分标记无图） */
    front: z.string().nullish(),
    /** 翻面状态（true 表示拥有背面） */
    hasBack: z.boolean().optional(),
  })
  .strict()

export type MarkerRecord = z.infer<typeof MarkerSchema>

/** 回合轨：半周日号（1–19）；date 为 ISO 日期（引擎比较用） */
export const TrackTurnSchema = z
  .object({
    turn: z.number().int().positive(),
    date: IsoDateSchema,
  })
  .strict()

export type TrackTurn = z.infer<typeof TrackTurnSchema>

/** 铁路容量轨（13.3b / 专规 1.2）：主轨 1–10 档 + 副轨 0–3T */
export const RailCapTrackSchema = z
  .object({
    maxMain: z.number().int().positive(),
    maxSub: z.number().int().nonnegative(),
    initial: z
      .object({
        axis: z.number().int().nonnegative(),
        soviet: z.number().int().nonnegative(),
      })
      .strict(),
    /** 容量提升日（轴 0→1、苏 2→3，专规 1.2） */
    boostDate: IsoDateSchema,
    boostTo: z
      .object({
        axis: z.number().int().nonnegative(),
        soviet: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()

export type RailCapTrackData = z.infer<typeof RailCapTrackSchema>

/** 边缘盒（专规 1.4b：东北 / 东南） */
export const EdgeBoxSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    /** 盒内可追溯补给 */
    traceSupply: z.boolean(),
  })
  .strict()

export type EdgeBox = z.infer<typeof EdgeBoxSchema>

/** 空军盒（专规 1.4a：轴 Luftwaffe / 苏 Red Air Force） */
export const AirBoxSchema = z
  .object({
    id: z.string().min(1),
    side: SideSchema,
    /** 任务射程（格）：轴 30 / 苏 20 */
    rangeHexes: z.number().positive(),
    /** 对应地图边缘行（轴 01.xx / 苏 62.xx） */
    edgeRow: z.number().int(),
  })
  .strict()

export type AirBox = z.infer<typeof AirBoxSchema>

/**
 * 盒子美工接口（W7 C12）
 *
 * 「留接口让以后可以让每个盒都有图片美工」：每个盒可选一张图，本作数据尚未提供，
 * 故整体可选；`containers.artwork` 以**盒 id** 为键（如 `dead-pile-axis` / `edge-northeast` /
 * `axis-air-box` / `breakdown-soviet` / `special-repl-soviet` / `formation-10 Mtr Div`）。
 * 缺省即 null ⇒ 界面渲染纯文字盒，不影响任何规则判定。
 */
export const BoxArtworkSchema = z
  .object({
    /** 图档键（null = 该盒有登记但暂无图） */
    imageKey: z.string().nullable(),
    /** 建议渲染尺寸（像素；缺省由界面决定） */
    widthPx: z.number().positive().optional(),
    heightPx: z.number().positive().optional(),
    /** 盒面分栏数（如空军盒的 Active / Inactive 两栏） */
    columns: z.number().int().positive().optional(),
    note: z.string().optional(),
  })
  .strict()

export type BoxArtwork = z.infer<typeof BoxArtworkSchema>

/** 容器初始结构与内容（引擎 Location 抽象的 BoxId 侧） */
export const ContainersSchema = z
  .object({
    deadPile: z
      .object({
        axis: z.array(z.string()),
        soviet: z.array(z.string()),
      })
      .strict(),
    edgeBoxes: z.array(EdgeBoxSchema),
    airBoxes: z.array(AirBoxSchema),
    /** 盒子美工表（键 = 盒 id；缺省 = 全部纯文字盒，W7 C12） */
    artwork: z.record(z.string(), BoxArtworkSchema).optional(),
  })
  .strict()

export type ContainersData = z.infer<typeof ContainersSchema>

/** markers.json 文件整体 */
export const MarkersDataSchema = z
  .object({
    meta: DataFileMetaSchema,
    markers: z.array(MarkerSchema),
    turnTrack: z.array(TrackTurnSchema),
    railCap: RailCapTrackSchema,
    containers: ContainersSchema,
  })
  .strict()

export type MarkersData = z.infer<typeof MarkersDataSchema>
