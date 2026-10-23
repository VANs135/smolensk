/**
 * sync-tec.mjs 的 TypeScript 声明（仅供类型检查与测试引用；模块本体为纯 JS）
 */

export const TEC_DATA_VERSION: string

export const HEXSIDE_FEATURES: ReadonlySet<string>
export const CITY_FEATURES: ReadonlySet<string>
export const ATTACKER_ONLY_EXTRA: ReadonlySet<string>
export const TEC_LEGEND: Readonly<Record<string, string>>

/** MP 单元格：fixed/delta 带值；prohibited/otherTerrain/all 无值 */
export type MpCell =
  | { kind: 'fixed'; value: number }
  | { kind: 'delta'; value: number }
  | { kind: 'prohibited' }
  | { kind: 'otherTerrain' }
  | { kind: 'all' }

/** 倍率单元格：multiplier（mult=[分子,分母]，attackerOnly 括号）或 otherTerrain */
export type AttackCell =
  { kind: 'multiplier'; mult: [number, number]; attackerOnly: boolean } | { kind: 'otherTerrain' }

export function parseMp(value: number | string): MpCell
export function parseAttack(raw: string, feature: string): AttackCell
export function sameKeys(a: unknown, b: unknown): boolean

/** DB tables.tec.rows 的一行 */
export interface TecRow {
  feature: string
  combat_line: string
  track: number | string
  truck: number | string
  leg: number | string
  armor: string
  mech: string
  other: string
}

/** 运行时 feature（charts-tec.json 的元素） */
export interface RuntimeFeature {
  feature: string
  kind: 'hex' | 'hexside'
  combatLine: string
  hexProperty?: boolean
  mp: { track: MpCell; truck: MpCell; leg: MpCell }
  attack: { armor: AttackCell; mech: AttackCell; other: AttackCell }
  note?: string
}

/** 运行时 charts-tec.json 完整结构 */
export interface TecDataset {
  meta: { version: string; description: string; source: readonly string[] }
  tec: {
    id: string
    name: string
    mobilityModes: readonly string[]
    attackerTypes: readonly string[]
    combatLines: readonly string[]
    legend: Readonly<Record<string, string>>
    features: readonly RuntimeFeature[]
  }
}

export function buildTecData(
  rows: readonly TecRow[],
  existingFeatures?: readonly RuntimeFeature[],
): TecDataset

/** 返回差异描述数组；空数组 = 与现有产物一致 */
export function findTecDifferences(next: TecDataset, existing: TecDataset | undefined): string[]
