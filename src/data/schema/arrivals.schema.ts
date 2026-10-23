import { z } from 'zod'

import { DataFileMetaSchema, SideSchema } from './common.schema'

/**
 * 到达表契约（arrivals-axis.json / arrivals-soviet.json，A8）
 *
 * 对应专规 2.1（苏：New units enter play per 2.1）/ 3.1（德：per 3.1）的**到达卡**：
 * 日期块 → 各入口 → 单位清单（原文串，**不做 id 映射**，因为卡片只印单位名与番号）。
 * 另携带该方的可变撤离表（3.3c）、随机事件表（3.6，轴方）、特殊补员表（1.6c，苏方）。
 *
 * 入场按 2.1/3.1：所有运输点满载（带额外 SP）入场；放置规则见剧本数据 supplySources。
 */

/**
 * 到达单位（结构化视图，源自 roster 展开：同一来源的单位名单逐条结构化）
 *
 * 与原文串视图并存：entries 保留卡片原文（保真），units 提供可消费的结构化字段。
 */
export const RosterUnitSchema = z
  .object({
    /** 卡片原文串 */
    raw: z.string(),
    /** 印值（如 '20-4-3'） */
    factors: z.string().optional(),
    count: z.number().optional(),
    /** 类别（unit / hq / unclassified …） */
    kind: z.string().optional(),
    /** 展开后的单位名（如 '17 Inf Div'） */
    name: z.string().optional(),
    /** 番号 */
    designation: z.string().optional(),
    /** 母类（如 'Inf Div'） */
    parentType: z.string().optional(),
    /** 到达时已损失军力（steps_lost） */
    stepsLost: z.number().optional(),
    locationKind: z.string().optional(),
    location: z.string().optional(),
  })
  .strict()

/** 到达分组（入口 / 任意基地等标签下的结构化单位清单） */
export const RosterGroupSchema = z
  .object({
    label: z.string(),
    units: z.array(RosterUnitSchema),
  })
  .strict()

/** 跨栏续排的归属裁定（到达卡多栏排版的读栏留痕） */
export const ResolvedAssignmentSchema = z
  .object({
    items: z.array(z.string()),
    /** 裁定归属（日期 / 入口） */
    resolved: z.string(),
    /** 被取代的旧读法 */
    supersededReadings: z.array(z.string()),
    /** 裁定依据 */
    basis: z.string(),
  })
  .strict()

/** 单个日期块（到达卡上的一栏日期） */
export const ArrivalBlockSchema = z
  .object({
    /** 日期原文（如 "12 Jul 41"），不转回合号（到达卡只印日期） */
    date: z.string().min(1),
    /** 该日期的规则提示原文 */
    notes: z.array(z.string()).optional(),
    /**
     * 入口 → 单位清单（键为入口字母或联合入口，如 "Entry K" / "Entry I or J"；
     * 值为该入口到达的单位原文串，如 "20-4-3 Inf Div (5, 35; one is -1 step)"）
     */
    entries: z.record(z.string(), z.array(z.string())),
    /** 同一日期的结构化单位视图（roster 展开，含印值/番号/已损失军力） */
    groups: z.array(RosterGroupSchema).optional(),
    /** 部署到任意空军基地的单位（到达卡不标具体格） */
    anyAirbase: z.array(z.string()).optional(),
    /** 当日移除（死亡堆） */
    remove: z.array(z.string()).optional(),
    /** 当日进入死亡堆 */
    deadPile: z.array(z.string()).optional(),
    /** 当日从西缘任意处入场 */
    anyWestEdge: z.array(z.string()).optional(),
  })
  .strict()

export type ArrivalBlock = z.infer<typeof ArrivalBlockSchema>

/** 可变撤离表（专规 3.3c） */
export const VariableExitSchema = z
  .object({
    starts: z.string(),
    rollIn: z.string().optional(),
    /** 骰面值段 → 结果原文 */
    table: z.record(z.string(), z.string()),
  })
  .strict()

/** 随机事件表（专规 3.6，轴方增援阶段） */
export const RandomEventsSchema = z
  .object({
    period: z.string(),
    /** 2d6 值段 → 事件原文 */
    table: z.record(z.string(), z.string()),
    airResult: z.string().optional(),
    supplyTrain: z.string().optional(),
    option4_1b: z.string().optional(),
  })
  .strict()

/** 特殊补员表（专规 1.6c，苏方；19 Aug 前每回合掷） */
export const SpecialReplSchema = z
  .object({
    period: z.string(),
    /** 骰面值段 → 补员结果原文 */
    table: z.record(z.string(), z.string()),
  })
  .strict()

/** arrivals-*.json 文件整体 */
export const ArrivalsDataSchema = z
  .object({
    meta: DataFileMetaSchema,
    side: SideSchema,
    /** 到达卡页眉提示原文 */
    header: z.string(),
    /** 日期块（按日期原文顺序） */
    blocks: z.array(ArrivalBlockSchema),
    /** 该方到达规则备注 */
    notes: z.array(z.string()).optional(),
    /** 已应用的勘误（影响到达数据的 SmolenskErrata 条目） */
    errataApplied: z.array(z.string()).optional(),
    /** 到达卡数据质量备注（多栏排版 / 分辨率等读栏风险） */
    dataQualityNotes: z.array(z.string()).optional(),
    /** 该方的跨栏续排归属裁定（读栏留痕） */
    resolvedAssignments: z.array(ResolvedAssignmentSchema).optional(),
    /** 可变撤离表（轴方） */
    variableExit: VariableExitSchema.optional(),
    /** 随机事件表（轴方） */
    randomEvents: RandomEventsSchema.optional(),
    /** 特殊补员表（苏方） */
    specialRepl: SpecialReplSchema.optional(),
  })
  .strict()

export type ArrivalsData = z.infer<typeof ArrivalsDataSchema>
