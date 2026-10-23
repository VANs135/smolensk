import { z } from 'zod'

import { DataFileMetaSchema } from './common.schema'

/**
 * charts-supply-repl.json 契约（A7.3）
 *
 * 补给表（1.6b）/ 补员表（1.6b）/ 特殊补员表（1.6c）/ 重建费用表（13.5c）。
 * 免费特殊补员资格（1.6c）仅限 12-2-2 / 11-1-1 / 10-0-1 型步兵/民兵师；
 * 13-3-3 型"never rebuilt this way"（规则原文），走通规 13.5 正常费用重建。
 */

/** 补员表一侧：掷 2d6（19 Aug 起 -1）→ Ftr/Tac/Pax/Eq */
export const ReplSideSchema = z
  .object({
    rows: z.array(z.string()).min(1),
    columns: z.tuple([z.literal('Ftr'), z.literal('Tac'), z.literal('Pax'), z.literal('Eq')]),
    /** 行主序网格 [rows][4]；'-' 已数值化为 0 */
    grid: z.array(z.array(z.number().int().nonnegative())).nonempty(),
    /** 19 Aug 起掷骰修正（1.6b） */
    drmFrom19Aug: z.number().int(),
  })
  .strict()

export type ReplSideData = z.infer<typeof ReplSideSchema>

/** 补给表一侧：掷 2d6 → SP；19 Aug 起取晚档 */
export const SupplySideSchema = z
  .object({
    rows: z.array(z.string()).min(1),
    spBefore19Aug: z.array(z.number().int().nonnegative()),
    spFrom19Aug: z.array(z.number().int().nonnegative()),
  })
  .strict()

export type SupplySideData = z.infer<typeof SupplySideSchema>

/** 特殊补员事件种类（1.6c） */
export const SpecialReplKindSchema = z.enum([
  'division_caches', // 苏：随机步兵/民兵师 + 补给缓存
  'division_alarm', // 苏：随机步兵/民兵师 + 任一警报单位
  'supply_cache', // 轴：补给缓存
  'aufk_krd', // 轴：任一 Aufk/Krd 营
])
export type SpecialReplKind = z.infer<typeof SpecialReplKindSchema>

export const SpecialReplRowSchema = z
  .object({
    dieFrom: z.number().int().min(1).max(6),
    dieTo: z.number().int().min(1).max(6),
    resultKind: SpecialReplKindSchema,
    /** 卡面原文（如 "Division & Supply Cache"） */
    label: z.string(),
  })
  .strict()

export type SpecialReplRow = z.infer<typeof SpecialReplRowSchema>

/** 重建费用条目 */
export const RebuildItemSchema = z.object({
  resource: z.enum(['pax', 'eq']),
  amount: z.number().int().positive(),
})
export type RebuildItem = z.infer<typeof RebuildItemSchema>

/** 重建途径：normal 正常费用 / none 不可重建 / special 仅 1.6c / pool 返回编制池 / replOnly 仅补员表 / regulation 按条文 */
export const RebuildEntrySchema = z.union([
  z.object({ kind: z.literal('normal'), cost: z.array(RebuildItemSchema).min(1) }),
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('special') }),
  z.object({ kind: z.literal('pool') }),
  z.object({ kind: z.literal('replOnly') }),
  z.object({ kind: z.literal('regulation'), label: z.string() }),
])
export type RebuildEntry = z.infer<typeof RebuildEntrySchema>

export const RebuildRowSchema = z
  .object({
    unitType: z.string().min(1),
    rebuild: RebuildEntrySchema,
    /** 卡面原文（用于对账） */
    sourceLabel: z.string(),
  })
  .strict()

export type RebuildRow = z.infer<typeof RebuildRowSchema>

/** 1.6c 免费重建资格因素（攻击–行动值–移动力，如 12-2-2） */
export const UnitFactorsRefSchema = z
  .object({
    attack: z.number().int().nonnegative(),
    ar: z.number().int().nonnegative(),
    ma: z.number().int().nonnegative(),
  })
  .strict()

export type UnitFactorsRef = z.infer<typeof UnitFactorsRefSchema>

/** 文件整体 */
export const ChartsSupplyReplSchema = z
  .object({
    meta: DataFileMetaSchema,
    supply: z
      .object({
        axis: SupplySideSchema,
        soviet: SupplySideSchema,
      })
      .strict(),
    repl: z
      .object({
        axis: ReplSideSchema,
        soviet: ReplSideSchema,
      })
      .strict(),
    specialRepl: z
      .object({
        axis: z.array(SpecialReplRowSchema),
        soviet: z.array(SpecialReplRowSchema),
      })
      .strict(),
    rebuild: z
      .object({
        axis: z.array(RebuildRowSchema),
        soviet: z.array(RebuildRowSchema),
      })
      .strict(),
    /** 1.6c 免费重建资格因素表（仅此三型） */
    freeSpecialReplFactors: z.array(UnitFactorsRefSchema).length(3),
  })
  .strict()

export type ChartsSupplyReplData = z.infer<typeof ChartsSupplyReplSchema>
