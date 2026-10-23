import { z } from 'zod'

/**
 * 共用契约片段
 *
 * 各数据文件 schema 复用的公共结构；字段名按 CODE_SPEC 术语（小驼峰标识符）。
 */

/** 数据文件通用头部：version 必须与 DATA_VERSION 一致（pipeline 校验），其余为可读元信息 */
export const DataFileMetaSchema = z
  .object({
    version: z.string().min(1),
    description: z.string().optional(),
    source: z.array(z.string()).optional(),
  })
  .strict()

export type DataFileMeta = z.infer<typeof DataFileMetaSchema>

/** 阵营侧（本作仅轴心/苏联，无中立战斗方） */
export const SideSchema = z.enum(['axis', 'soviet'])
export type Side = z.infer<typeof SideSchema>

/**
 * 算子归属侧（3.1）
 *
 * `both` = 中立算子（双方通用，如 SP / 空军基地 / 工事），源库 units.json 即如此标注；
 * 它不是「第三方」，故与 SideSchema 分开：只用于**单位**的静态归属与运行实例。
 */
export const UnitSideSchema = z.enum(['axis', 'soviet', 'both'])
export type UnitSide = z.infer<typeof UnitSideSchema>

/**
 * 标记归属（A6）
 *
 * - `neutral` 通用磁贴（不属于任何一方，双方都可能用到）
 * - `both`    双方通用标记（如铁路端点、建设标记）
 * 二者语义不同，不可合并（见 markers.schema 的 side 注释）。
 */
export const MarkerSideSchema = z.enum(['axis', 'soviet', 'neutral', 'both'])
export type MarkerSide = z.infer<typeof MarkerSideSchema>

/** 六角格坐标：本作编号无字母前缀，col/row 即印刷「列.行」 */
export const HexRefSchema = z
  .object({
    col: z.number().int().nonnegative(),
    row: z.number().int().nonnegative(),
  })
  .strict()

export type HexRef = z.infer<typeof HexRefSchema>

/** 单位数据状态四阶段（unit_db_schema v2）；引擎只加载 valued 以上 */
export const DataStatusSchema = z.enum(['placeholder', 'classified', 'valued', 'verified'])
export type DataStatus = z.infer<typeof DataStatusSchema>

/** ISO 日期（YYYY-MM-DD）：引擎时点是可比较的日期字符串，不保留原文记法 */
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '须为 YYYY-MM-DD 格式')
export type IsoDate = z.infer<typeof IsoDateSchema>

/**
 * 铁路轨距（专规 1.2 / 通规 13.3f）
 *
 * ★ 轨距与「多轨／单轨」是**两件不同的事**，不得混用：
 *   - **轨距**是**专规**内容，回答「**谁能用**这条铁路」（苏宽轨 / 德标准轨；13.3f 换轨改变逐格状态）；
 *   - **多轨／单轨**是**地形**内容，回答「运量费用多少」（13.3a 全程多轨减半）。
 */
export const RailGaugeSchema = z.enum(['broad', 'standard'])
export type RailGauge = z.infer<typeof RailGaugeSchema>
