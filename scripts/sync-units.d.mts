/**
 * sync-units.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 */

export const UNITS_VERSION: string

/** 装甲集群归属（Smolensk 专规 3.4）：Hoth = 3rd Panzer Group；其余编队 ⇒ Guderian */
export const HOTH_FORMATIONS: readonly string[]
export const GUDERIAN_FORMATIONS: readonly string[]

export interface UnitRaw {
  unit_id: string
  vassal_name?: string
  side: 'axis' | 'soviet' | 'both'
  arm?: string
  echelon?: string | null
  echelon_status?: string | null
  unit_kind?: 'combat' | 'non_combat'
  unit_class?: string
  non_combat_type?: string | null
  specialized?: readonly string[]
  combat_category?: string | null
  mobility_type?: string
  A_parenthesized?: boolean
  attack_capable?: boolean
  combat_value_printed?: boolean
  rebuildable?: boolean
  RE?: number | null
  steps_total?: number | null
  fill_stage?: string
  special_rule?: string
  special_abilities?: readonly string[]
  splittable?: boolean
  transport_kind?: string
  /** 算子图档（文件名即素材库原名；装甲集群归属由文件名前缀派生） */
  images?: { front?: string | null; back?: string | null }
  faces?: readonly { face: string; kind: string; value?: number | null }[]
  printed_values?: {
    front?: Record<string, number | boolean | string | null> | null
    back?: Record<string, number | boolean | string | null>
  }
  artillery_values?: {
    front?: Record<string, number | null>
    back?: Record<string, number | null>
  }
}

export interface AircraftRaw {
  unit_id: string
  vassal_name?: string
  aircraft_model?: string
  side: 'axis' | 'soviet'
  type_badge?: string
  fill_stage?: string
  special_abilities?: readonly string[]
  printed_values?: { front?: Record<string, number | boolean | null> }
  air_abilities?: {
    steps?: number
    can_hip_shoot?: boolean
    mission_in_reaction_phase?: boolean
    mission_in_exploitation_phase?: boolean
    can_initiate_air_combat?: boolean
    can_barrage?: boolean
    can_escort?: boolean
    can_patrol_zone?: boolean
    can_air_drop?: boolean
  }
}

/** 仅需要 non_combat_type 字段即可调用的归一化函数输入 */
export interface NoncombatNormalizeInput {
  non_combat_type?: string | null
}

export function normalizeNoncombatType(item: NoncombatNormalizeInput): string | null
/** @deprecated 保留兼容测试，内部已委托 normalizeNoncombatType */
export function inferNoncombatKind(item: NoncombatNormalizeInput): string | null
export function coerceNumber(value: unknown): number | undefined
export function toFactorSet(
  face: Record<string, number | boolean | string | null> | null | undefined,
  artillery?: boolean,
): Record<string, number> | null
export function isArtillery(item: UnitRaw): boolean
export function panzerGroupOf(item: UnitRaw): 'guderian' | 'hoth' | null
export function toUnitRecord(item: UnitRaw): Record<string, unknown>
export function toAircraftRecord(item: AircraftRaw): Record<string, unknown>
export function buildSideFile(
  side: 'axis' | 'soviet',
  items: readonly unknown[],
): { meta: Record<string, unknown>; units: readonly unknown[] }
