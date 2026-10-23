import { z } from 'zod'

import { DataFileMetaSchema } from './common.schema'

/**
 * charts-tec.json 契约（Terrain Effects Chart）
 *
 * 本表是 6.2d（移动取最贵地形）、9.3b（防御方选战斗地形）、9.4b–9.4d（地形倍率）
 * 三条规则的唯一数值来源。表按「地形 → 三条互相独立的通道」组织：
 *   combatLine  选 Combat Table 的哪一行（Open / Close / Very Close / Extr Close，或 ot）
 *   mp          按机动类型（track / truck / leg）各自给出成本
 *   attack      按攻击方部队类型（armor / mech / other）给出倍率，括号倍率仅作用于攻方
 * 三条通道互不换算：不得拿 combatLine 当 MP，也不得把 attack 倍率当作移动成本。
 */

/** MP 单元格：定值 / 追加值（跨河 +N） / 禁止 / 取决于格内其他地形 / 标记 All（原样保留） */
export const TecMpValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), value: z.number().nonnegative() }),
  z.object({ kind: z.literal('delta'), value: z.number().positive() }),
  z.object({ kind: z.literal('prohibited') }),
  z.object({ kind: z.literal('otherTerrain') }),
  z.object({ kind: z.literal('all') }),
])

export type TecMpValue = z.infer<typeof TecMpValueSchema>

/** 攻击倍率单元格：倍率（约分形式，避免 1/3 的浮点损失） 或 取决于格内其他地形 */
export const TecAttackModSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('multiplier'),
    /** [分子, 分母]：x1 → [1,1]、x1/2 → [1,2]、x2 → [2,1] */
    mult: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    /** 原文带方括号 [x#] → 只作用于攻方（9.4d） */
    attackerOnly: z.boolean(),
  }),
  z.object({ kind: z.literal('otherTerrain') }),
])

export type TecAttackMod = z.infer<typeof TecAttackModSchema>

/** TEC 一行 */
export const TecFeatureSchema = z
  .object({
    /** 原文 Feature 名（引擎按此名索引；Hoth/Guderian 等专规记号不进本表） */
    feature: z.string().min(1),
    /** hex = 格内地形，可参与 9.3b 候选；hexside = 格边地形，永不进 9.3b 候选 */
    kind: z.enum(['hex', 'hexside']),
    /** 战斗线；'ot' 表示该行不产生独立战斗线，须回查格内主地形 */
    combatLine: z.union([z.enum(['Open', 'Close', 'Very Close', 'Extr Close']), z.literal('ot')]),
    /** 图例 * ：格子属性（移动为 P 时须沿路才能进入并攻击，9.1f） */
    hexProperty: z.boolean().optional(),
    mp: z
      .object({
        track: TecMpValueSchema,
        truck: TecMpValueSchema,
        leg: TecMpValueSchema,
      })
      .strict(),
    attack: z
      .object({
        armor: TecAttackModSchema,
        mech: TecAttackModSchema,
        other: TecAttackModSchema,
      })
      .strict(),
    note: z.string().optional(),
  })
  .strict()

export type TecFeature = z.infer<typeof TecFeatureSchema>

export const TecDataSchema = z
  .object({
    id: z.literal('tec'),
    name: z.string().min(1),
    /** 移动类型键名（与 mp 的键一致，供引擎遍历） */
    mobilityModes: z.array(z.enum(['track', 'truck', 'leg'])).length(3),
    /** 攻击方部队类型键名（与 attack 的键一致） */
    attackerTypes: z.array(z.enum(['armor', 'mech', 'other'])).length(3),
    combatLines: z.array(z.enum(['Open', 'Close', 'Very Close', 'Extr Close'])).length(4),
    /** 图例四条（原文） */
    legend: z.record(z.string(), z.string()),
    features: z.array(TecFeatureSchema).min(1),
  })
  .strict()

export type TecData = z.infer<typeof TecDataSchema>

/** charts-tec.json */
export const ChartsTecSchema = z
  .object({
    meta: DataFileMetaSchema,
    tec: TecDataSchema,
  })
  .strict()

export type ChartsTecData = z.infer<typeof ChartsTecSchema>
