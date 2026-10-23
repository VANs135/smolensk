import { z } from 'zod'

import { DataFileMetaSchema, SideSchema } from './common.schema'

/**
 * 编队契约（formations.json，A8）
 *
 * 编队＝多单位编队（13.7），含抽取片与 fueled 面。每条登记：
 *   - formationId：剧本口径名（如 '1 Mtr Div'，以剧本数据库为准）
 *   - formationCode：算子库口径代号（如 '1.Mot'；units.json 的 formation 字段用此代号）
 *   - subordinates：组成单位代号清单
 *   - byLocation：各剧本初设中的格号分布（印刷格号 → 该格组成单位清单）
 *   - sources：该编队出现的剧本（如 'S1·axis'）
 */

export const FormationSchema = z
  .object({
    /** 剧本口径名（如 '1 Mtr Div'） */
    formationId: z.string().min(1),
    side: SideSchema,
    /** 算子库口径代号（如 '1.Mot' / '3PZ'） */
    formationCode: z.string().min(1),
    /** 代号说明 */
    formationCodeNote: z.string().optional(),
    /** 组成单位代号清单 */
    subordinates: z.array(z.string()),
    /** 各剧本初设分布：印刷格号 → 组成单位清单 */
    byLocation: z.record(z.string(), z.array(z.string())),
    /** 出现该编队的剧本（如 'S1·axis'） */
    sources: z.array(z.string()),
    /** 名称改判留痕（如 1 Mtr Div 原误标 axis） */
    sidePrevByNameRule: z.string().nullish(),
  })
  .strict()

export type Formation = z.infer<typeof FormationSchema>

/** formations.json 文件整体 */
export const FormationsDataSchema = z
  .object({
    meta: DataFileMetaSchema,
    formations: z.array(FormationSchema),
  })
  .strict()

export type FormationsData = z.infer<typeof FormationsDataSchema>
