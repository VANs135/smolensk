import type { HexRef } from '@/data'

/**
 * 条文索引（本文件与本仓库实现的对应）
 *   通规：（判定主体为专规，通规仅引原文）
 *   专规：4.3（可选）
 */

/**
 * 专规 4.3（可选）**Setup Wiggle** —— 初设微调
 *
 * 原文（Scenario 通规 5.1 / 5.2）：
 *   A. 「六个满员苏军步兵师各可派出一个拆分团（置于母师两格内）」；
 *   B. 「1.Mot Div 可在 18.17 一格内初设」。
 *
 * 本模块只放**判据常量与谓词**；交互（选母师、选落点）在 store 与初设面板。
 * ★ 未启用（`session.rule4On('setupWiggle') === false`）时调用方一律不传本模块的放宽分支，
 *   初设流程与修前逐字相同。
 */
/** A：最多 6 个满员步兵师各拆一个团 */
export const SETUP_WIGGLE_MAX_DIVISIONS = 6

/** A：拆分团必须落在母师两格内 */
export const SETUP_WIGGLE_BREAKDOWN_RADIUS = 2

/** B：1.Mot Div 的初设放宽锚格 18.17 */
export const SETUP_WIGGLE_MOT_ANCHOR: HexRef = { col: 18, row: 17 }

/** B：放宽半径（一格内） */
export const SETUP_WIGGLE_MOT_RADIUS = 1

/**
 * 该初设条目是不是 1.Mot Div
 *
 * 数据里写法是 `1 Mtr Div`（`scenario-setup.json` 的 `name` / `unitId`），
 * 专规与勘误写作 `1.Mot Div` —— 两写法都认，别的条目一概不认。
 */
export function isSetupWiggleMotEntry(entry: {
  name: string | null
  raw: string
  unitId: string | null
}): boolean {
  const text = `${entry.unitId ?? ''} ${entry.name ?? ''} ${entry.raw}`
  return /(^|[^0-9])1\s*M(tr|ot)\b/i.test(text)
}

/**
 * A 的母师判据：苏军 ∧ 步兵 ∧ **满员** ∧ 多军力（≥2 步，才拆得动）
 *
 * ★ 原文只说「six full-strength Soviet rifle divisions」，没有「4 步」这类印值门槛；
 *   本作苏军步兵师印值是 2–3 步（数据实测），所以**不能**照 专规 4.2b 的「4 步」去卡。
 */
export function isSetupWiggleParent(candidate: {
  side: string
  branch: string | null
  printedSteps: number
  steps: number
}): boolean {
  return (
    candidate.side === 'soviet' &&
    candidate.branch === 'infantry' &&
    candidate.printedSteps >= 2 &&
    candidate.steps === candidate.printedSteps
  )
}
