import { z } from 'zod'

import { DataFileMetaSchema, HexRefSchema, SideSchema } from './common.schema'

/**
 * 初设索引契约（scenario-setup.json，A8）
 *
 * 逐条记录每个剧本的初设条目（源库 setup_index.json，1155 条）：
 * **只搬初设条目，不搬运行时状态**。位置可为印刷格号或原文标签
 * （『死亡堆』『At any air bases』『w/i 3 hexes of …』『Stacked with any … HQs』）。
 *
 * 数量注记（SP 点数 / 空军基地等级 / 运输点）以独立条目记录（kind = sp / airbase /
 * transport_point），与同格单位通过 location 关联（coLocated）。
 * 减损（stepPenalty）、移动模式初设（setupMode）、† 容差（placementTolerance）、
 * 勘误（errataRef / errataMoveMode / corrected）均为源库既有字段，原样搬运。
 */

/** 编队下属条目（kind=formation 时展开到各组成单位） */
export const SubordinateSchema = z
  .object({
    /** 模块口径代号（如 '1 Aufk'） */
    component: z.string(),
    /** 全名（如 '3 Pz Div 1 Aufk'） */
    name: z.string(),
    establishment: z.string().nullish(),
    raw: z.string(),
    /** 是否为建制内卡车（organic truck） */
    isOrganicTruck: z.boolean(),
    locationKind: z.string().nullish(),
    location: z.string().nullish(),
    /** 算子库链接（Z2：分量归一 + 父前缀） */
    unitId: z.string().nullish(),
    /** 链接依据（原文，便于回溯） */
    linkBasis: z.string().nullish(),
  })
  .strict()

/** 单条初设条目 */
export const SetupEntrySchema = z
  .object({
    /** 剧本标识（'1' / '3' / '5' / '7'：1-2、3-4、5-6 共用初设） */
    scenarioId: z.string(),
    side: SideSchema,
    /** 原表分组标签（如 'hex 2.02' / 'Dead Pile' / 'Stacked with any Soviet HQs'） */
    groupLabel: z.string(),

    /** 位置类别：hex / dead_pile / any_hq / relative_hex / airbase / 空 */
    locationKind: z.string().nullish(),
    /** 位置原文（格号或原文标签） */
    location: z.string().nullish(),

    /** 条目类别 */
    kind: z.enum([
      'unit',
      'formation',
      'hq',
      'sp',
      'aircraft',
      'transport_point',
      'airbase',
      'extender',
    ]),

    /** 单位名（数量注记条目为 null） */
    name: z.string().nullish(),
    /** 数量（单位数 / SP 点数 / 基地等级 / 运输点数） */
    count: z.number(),

    /** 算子原文串（如 '20-4-3 Inf Div (5, 35; one is -1 step)'） */
    raw: z.string(),
    /** 印值（如 '10-5-4'、'(5)-1-1'） */
    factors: z.string().nullish(),
    /** 番号（如 '58' / 'IRGD'） */
    designation: z.string().nullish(),
    /** 母类（如 'UR Bde' / 'Inf Rgt'） */
    parentType: z.string().nullish(),

    /** 放置方式原文（如 '固定格号' / '固定格号（±1 格，带 †）'） */
    placementType: z.string(),
    /** 放置补充说明（条件放置时给出原文解释） */
    placementNote: z.string().nullish(),
    /** † 容差（如 'listed ±1 hex'） */
    placementTolerance: z.string().nullish(),
    placementToleranceNote: z.string().nullish(),

    /** 国别（德国 / 苏联） */
    nation: z.string(),

    /** 位置涉及的印刷格号清单（可能 0 / 1 / 2 个） */
    locationHexes: z.array(z.string()),
    /** 位置格号解析结果（无法解析的原文标签为空数组） */
    locationRefs: z.array(HexRefSchema).optional(),

    /** 同格共存的其他条目类别（数量注记与所在格单位关联） */
    coLocated: z.array(z.string()).optional(),

    /**
     * 算子库 / 空军库 / 编队库的**显式链接**（Z2，2026-09-13）
     *
     * `unitIdKind` 语义：`unit`（地面算子）/ `aircraft`（空军专表）/ `formation`（编队库）/
     * `none`（计数类条目：SP·运输点·空军基地，不指向具体棋子）。
     * 自动初设**只按此链接落子**，不按名字猜（避免改名即断）。
     */
    unitId: z.string().nullish(),
    unitIdKind: z.string().nullish(),
    /** 链接依据原文（如 'by_name+side'、'by_raw(机型 slug 匹配：1x I.153)'） */
    linkBasis: z.string().nullish(),

    /** 减损军力数（-1 step → 1；ALL step 另注） */
    stepPenalty: z.number().nullish(),
    /** 减损注记原文（如 '剧本注记：该单位以减损状态设置（-1 step）'） */
    stepPenaltyNote: z.string().nullish(),
    /** 以移动模式面初设（'move'） */
    setupMode: z.string().nullish(),

    /** 勘误：移动模式印值修正（如 '10-5-6'） */
    errataMoveMode: z.string().nullish(),
    /** 勘误出处（如 'Smolensk Errata: …'） */
    errataRef: z.string().nullish(),
    /** 勘误更正说明（原文） */
    corrected: z.string().nullish(),

    /** 编队下属展开（kind=formation 时） */
    subordinates: z.array(SubordinateSchema).optional(),
  })
  .strict()

export type SetupEntry = z.infer<typeof SetupEntrySchema>

/** 初设索引语义注记（源 meta：条目键 / 放置类别 / 标记说明 / 国别与数量注记） */
export const SetupIndexNotesSchema = z
  .object({
    /** 条目键构成（scenario_id + location + name + 序号） */
    entryKey: z.string().optional(),
    /** 放置类别清单（固定格号 / 死亡堆 / 自由放置 / 条件放置 / 未标位置） */
    placementKinds: z.array(z.string()),
    /** 数量语义（count = 单位数；setup_count = 各剧本初设总数） */
    multiplicity: z.string().optional(),
    /** 标记说明（† / -N step / in Move Mode 的含义） */
    markerNotes: z.record(z.string(), z.string()),
    /** 国别注记（德国 / 苏联 条数） */
    nationNote: z.string().optional(),
    /** 数量注记说明（SP / 空军基地等级 / 运输点以独立条目记录） */
    quantityNote: z.string().optional(),
  })
  .strict()

export type SetupIndexNotes = z.infer<typeof SetupIndexNotesSchema>

/** scenario-setup.json 文件整体 */
export const ScenarioSetupDataSchema = z
  .object({
    meta: DataFileMetaSchema,
    /** 初设索引语义注记 */
    notes: SetupIndexNotesSchema,
    entries: z.array(SetupEntrySchema),
  })
  .strict()

export type ScenarioSetupData = z.infer<typeof ScenarioSetupDataSchema>
