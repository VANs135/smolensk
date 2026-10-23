import { z } from 'zod'

import { DataFileMetaSchema, DataStatusSchema, UnitSideSchema } from './common.schema'

/**
 * units-*.json 契约（战斗单位，A5 转录算子数值后生效）
 *
 * 字段按 unit_db_schema v4 与 CODE_SPEC 术语定名（标识符小驼峰）；
 * 数值按面存放（factors.combat / factors.move 对应战斗面与移动面）。
 *
 * ★权威数据源：D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json
 *   （只读，禁止改动；sync-units.mjs 做字段映射）
 */

/** 单面数值集（炮兵：轰炸值–行动值–移动力–射程；其他战斗单位：战斗值–行动值–移动力） */
export const FactorSetSchema = z
  .object({
    attack: z.number().int().nonnegative().nullish(),
    ar: z.number().int().nonnegative().nullish(),
    ma: z.number().int().nonnegative().nullish(),
    /** 炮兵轰炸值（仅火炮单位出现） */
    barrage: z.number().nonnegative().nullish(),
    /** 炮兵射程（格；仅火炮单位出现，印刷于行动值下方） */
    range: z.number().int().positive().nullish(),
    defense: z.number().int().nonnegative().nullish(),
  })
  .strict()

export type FactorSet = z.infer<typeof FactorSetSchema>

/** HQ 投递距离（通规 13.1b：战斗面与移动面不同） */
const ThrowRangeSchema = z
  .object({
    combatFace: z.number().int().nonnegative().nullish(),
    moveFace: z.number().int().nonnegative().nullish(),
  })
  .strict()

/** 非战斗单位详情（按 noncombatKind 路由） */
const NoncombatDetailsSchema = z
  .object({
    /** supply_point: sp 值与面结构 */
    spValue: z.number().int().nonnegative().nullish(),
    splittable: z.boolean().optional(),
    faces: z
      .array(
        z.object({
          face: z.enum(['front', 'back']),
          kind: z.string(),
          value: z.number().int().nonnegative().nullish(),
        }),
      )
      .optional(),
    /** transport_point/organic_truck/supply_extender: 运力点数 */
    transport: z.number().int().positive().nullish(),
    transportKind: z.enum(['truck', 'wagon']).optional(),
    /** air_base/hedgehog: 等级 */
    level: z.number().int().positive().nullish(),
  })
  .strict()

/** 单个单位的完整记录 */
export const UnitSchema = z
  .object({
    /** 稳定主键：<国籍>-<兵种>-<番号>[-<部件>]，创建后不变 */
    id: z.string().min(1),

    nameZh: z.string().optional(),
    nameEn: z.string().optional(),
    /** 源模块原名（Vassal），用于回溯 */
    vassalName: z.string().optional(),

    /**
     * 算子图档（文件名，落在 `public/counters/{axis,soviet,markers}/`）
     *
     * 来自权威库 `units.json` 的 `images`：`front` = 战斗面、`back` = 移动面（单面算子为 null）。
     * 文件名即素材库原名（`scripts/sync-counters.mjs` 原样拷贝）。
     */
    images: z
      .object({
        front: z.string().nullish(),
        back: z.string().nullish(),
      })
      .nullish(),

    side: UnitSideSchema,
    nationality: z.string().optional(),

    /** 规则 3.1–3.2 分类树 */
    unitFamily: z.enum(['ground_combat', 'ground_noncombat', 'air']).optional(),
    unitKind: z.enum(['combat', 'non_combat']).optional(),
    isCombat: z.boolean().optional(),
    /** 非战斗单位七类（3.3；本作无港口；organic_truck/supply_extender 为运输点细分） */
    noncombatKind: z
      .enum([
        'sp',
        'supply_point',
        'transport_point',
        'organic_truck',
        'supply_extender',
        'air_base',
        'hedgehog',
        'port',
      ])
      .nullish(),
    /** specialized 规则化分类（replacement/artillery/hq/breakdown/rail_repair 等） */
    specialized: z.array(z.string()).optional(),

    branch: z.string().optional(),
    /**
     * 3.1c：所属**多单位编队**的番号（如 `1.Mot`、`10.Pz`）
     *
     * 「多单位编队 (13.7) 是指具有**相同上级番号**（如"第1装甲师"或"第6坦克军"）的一组地面单位。」
     * 3.2f 的**独立单位**＝「既不属于多单位编队 (3.1c) 也**不属于多军力单位** (3.2d)」⇒ 本字段是判"是否独立单位"
     * 的一半（另一半是 `steps.total > 1`）。**由数据定死**、不由玩家声明（用户 2026-09-17 裁定）。
     * 源库 `units.json` 的 `formation` 导出；缺键 ＝ 该单位不属于任何多单位编队。
     */
    formation: z.string().min(1).optional(),
    echelon: z
      .enum([
        'div',
        'bde',
        'rgt',
        'bn',
        'coy',
        'step',
        'formation_marker',
        'point',
        'level',
        'none',
      ])
      .nullish(),
    /** echelon 为 null 的原因解释（HQ/补员/炮兵群/运输单位四类不需要规模） */
    echelonStatus: z.enum(['not_applicable']).optional(),

    /** 表列资格（3.2a / 3.1a），不得按兵种推定 */
    classes: z
      .object({
        combatClass: z.enum(['armor', 'mech', 'other']).optional(),
        movementClass: z.enum(['leg', 'truck', 'tracked']).optional(),
      })
      .strict()
      .optional(),
    /**
     * 3.1a：**逐面**机动类型（战斗面／移动面各一）
     *
     * 「颜色表示地面单位的移动类型……**算子一面和另一面的颜色可能不同**」⇒ 机动类型是**逐面**属性
     * （决定 6.2 的 TEC 列、4.5a-A 轮式在 EZOC 必停、12.5a 是否须燃料、4.7b 铁路当量）。
     * 源库逐面取自算子正/背面 MA 的**像素取色**；缺一面时回退记录级 `classes.movementClass`（`mobilityOf`）。
     */
    mobilityByFace: z
      .object({
        combat: z.enum(['leg', 'truck', 'tracked']).optional(),
        move: z.enum(['leg', 'truck', 'tracked']).optional(),
      })
      .strict()
      .optional(),

    /** 按面数值（5.0 两个自愿模式面） */
    factors: z
      .object({
        combat: FactorSetSchema.optional(),
        move: FactorSetSchema.optional(),
      })
      .strict()
      .optional(),

    /** 军力与团当量（3.2d / 4.6） */
    steps: z
      .object({
        total: z.number().nonnegative().nullish(),
      })
      .strict()
      .optional(),
    reSize: z.number().nonnegative().optional(),

    /** 攻击资格（4.4：括注战斗值只能防御） */
    attackCapable: z.boolean().optional(),
    attackValueBracketed: z.boolean().optional(),
    /*
     * 批 F 切片 6（B49 收尾）：原 `combatValuePrinted` 字段**已删**——它零消费（全仓只有本 schema
     * 一处声明），且与 `factors.combat.attack` 的**有无**完全冗余（实测 449 条记录逐条满足
     * `combatValuePrinted === (attack !== null)`）。按"没有冗余内容"删。
     * 若日后某条规则真需要"印刷值 vs 有效值"的区别，请连同**消费方**一起加回来。
     */
    /** 规则能力标签数组（barrage/replacement/alarm/sov_artillery_stack_to_combine/...） */
    specialAbilities: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(),
    /**
     * 源库的**原始能力串**（`units.json` 的 `capabilities_raw`；B39 / D-4 导出）
     *
     * 与 `capabilities` 的分工：`capabilities` 是**分类后**的规则能力标签，
     * 这一份是分类前的原串 —— 保留它才能回溯这条标签是从哪个原始能力判出来的。
     */
    capabilitiesRaw: z.array(z.string()).optional(),
    /** OCS 规则章节号（如 13.5=补员、13.4=炮兵、13.1b/13.5a/13.8a=HQ） */
    specialRule: z.string().optional(),
    /** 反坦克效果（9.4e：须按算子符号判定） */
    atEffects: z.enum(['heavy', 'light', 'none']).optional(),
    /** 行动值下方有黄点者不可重建（3.1d / 13.5c） */
    rebuildable: z.boolean().optional(),
    /**
     * 专规 2.3a：警戒（Alarm）单位的**混编上限**（按算子类型计）
     *
     * 规则原文：「The mix of Alarm units is strictly limited: three 2-1-3 tank battalions,
     * five 3-1-1 militia regiments, and seven (2)-2-2 anti-tank regiments.」
     * ⇒ 只有这三种算子带该字段（3 / 5 / 7）；同型可同时在场多枚，超上限不可再返场。
     */
    alarmLimit: z.number().int().positive().optional(),

    /** HQ 投递距离（通规 13.1b：底部左；战斗面与移动面不同） */
    throwRange: ThrowRangeSchema.optional(),
    /** 非战斗单位专用详情（按 noncombatKind 路由到引擎判定） */
    noncombatDetails: NoncombatDetailsSchema.optional(),

    /**
     * 装甲集群归属（Smolensk 专规 3.4：Guderian = 2nd Panzer Group / Hoth = 3rd Panzer Group）
     *
     * 取自素材库的**编队目录**（`轴心单位\编队单位\3rd_Panzer_Group` ⇒ hoth，其余 ⇒ guderian），
     * 由 `scripts/sync-units.mjs` 落到数据 ⇒ **玩家不必逐个声明编队归属**；
     * 非装甲集群单位（步兵师 / 独立单位 / 中立单位）无此字段。
     */
    panzerGroup: z.enum(['guderian', 'hoth']).nullish(),

    /** 数据状态：引擎只接受 valued 以上（unit_db_schema v2） */
    status: DataStatusSchema,
  })
  .strict()

export type UnitRecord = z.infer<typeof UnitSchema>

/** units-axis.json / units-soviet.json 文件结构 */
export const UnitsDataSchema = z
  .object({
    meta: DataFileMetaSchema,
    units: z.array(UnitSchema),
  })
  .strict()

export type UnitsData = z.infer<typeof UnitsDataSchema>
