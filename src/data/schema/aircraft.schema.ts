import { z } from 'zod'

import { DataFileMetaSchema, DataStatusSchema, SideSchema } from './common.schema'

/**
 * aircraft.json 契约（A5 空军专表）
 *
 * 空军与地面单位字段差异大（14.x 章）：类型 / 空战值 / 轰炸值 / 射程 / 运量 / 军力。
 * 能力（苏军禁低空扫射 2.2a、禁反应/进击出击 2.2d 等）从库中 air_abilities 直接转录。
 *
 * ★权威数据源：D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\aircraft.json
 *   （只读，禁止改动；sync-units.mjs 做字段映射）
 */

/** 机种徽记（14.1 五种类型；comb = 组合类型） */
export const AircraftTypeSchema = z.enum(['F', 'T', 'S', 'Tpt', 'comb'])
export type AircraftType = z.infer<typeof AircraftTypeSchema>

/** 空军能力布尔表（由 aircraft.json air_abilities 转录，引擎直接消费） */
const AirAbilitiesSchema = z
  .object({
    /** 可否低空扫射（hip shoot）——苏军 2.2a 禁 */
    canHipShoot: z.boolean().optional(),
    /** 可否反应阶段出击——苏军 2.2d 禁 */
    missionInReactionPhase: z.boolean().optional(),
    /** 可否进击阶段出击——苏军 2.2d 禁 */
    missionInExploitationPhase: z.boolean().optional(),
    /** 可否主动发起空战（空战值不带括号才 true） */
    canInitiateAirCombat: z.boolean().optional(),
    /** 可否执行轰炸任务 */
    canBarrage: z.boolean().optional(),
    /** 可否护航 */
    canEscort: z.boolean().optional(),
    /** 可否巡逻制空（patrol zone） */
    canPatrolZone: z.boolean().optional(),
    /** 可否执行空投 */
    canAirDrop: z.boolean().optional(),
  })
  .strict()

export const AircraftRecordSchema = z
  .object({
    aircraftId: z.string().min(1),
    name: z.string().min(1),
    /**
     * 算子图档（文件名，落在 `public/counters/{axis,soviet}/`）
     *
     * 与地面算子同口径：来自权威库 `aircraft.json` 的 `images`，文件名即素材库原名。
     */
    images: z
      .object({
        front: z.string().nullish(),
        back: z.string().nullish(),
      })
      .nullish(),
    side: SideSchema,
    aircraftType: AircraftTypeSchema,
    /** 空战值（14.3e；括号值另判，见 attackCapableAir 备查） */
    airCombatRating: z.number().int().nonnegative().nullish(),
    /** 14.1b/14.3e：**减损面**（1 step）的空战值（缺省＝与正面相同；本作多为正面−1） */
    airCombatRatingBack: z.number().int().nonnegative().nullish(),
    /** 轰炸值（10.0a；战术/战略机） */
    barrageStrength: z.number().nonnegative().nullish(),
    /** 14.1b/14.4f：**减损面**（1 step）的轰炸值（缺省＝与正面相同；本作 20 条有差） */
    barrageStrengthBack: z.number().nonnegative().nullish(),
    /** 航程（格，14.x） */
    rangeHexes: z.number().int().positive().nullish(),
    /**
     * 空运容量（运输机 / 组合类型，14.9 / 14.10；单位：吨）
     *
     * **可为小数**：印值本身是 `1T` / `1/2T` 这种带单位的吨数（Ju.52 正面 1、背面 1/2），
     * 故不限制为整数。
     */
    transportCapacity: z.number().positive().nullish(),
    /* 14.4f/14.4g：减损面（1 step）的运输容量（缺省＝与正面相同；本作 Ju.52 / TB.3 为 1/2T） */
    transportCapacityBack: z.number().positive().nullish(),
    /** 军力（14.1b：标准 2；IL.2 单军力，背面空白） */
    steps: z.number().int().positive(),
    /** 专规例外标签（no_hip_shoots / no_reaction_exploit_mission 等） */
    specialAbilities: z.array(z.string()).optional(),
    /** 完整能力布尔表（由 air_abilities 转录） */
    airAbilities: AirAbilitiesSchema.optional(),
    status: DataStatusSchema,
  })
  .strict()

export type AircraftRecord = z.infer<typeof AircraftRecordSchema>

export const AircraftDataSchema = z
  .object({
    meta: DataFileMetaSchema,
    aircraft: z.array(AircraftRecordSchema),
  })
  .strict()

export type AircraftData = z.infer<typeof AircraftDataSchema>
