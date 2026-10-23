import { chartsTables } from '@/data'
import { flakKillCheck } from '@/engine/rules/air'

import { findTable, lookupCell, matchRowIndex, resolveLabelColumnIndex } from './lookup'

/**
 * 防空（OCS 14.4e / 14.4f）
 *
 * - 击落判定：修正后 2d6 ≥ 11 击落一架任务机（阈值来自规则常量 air.flakKillMinDice）。
 * - 损失归属：击落后掷 1 骰查任务损失表，决定 2/3/4 机任务中哪架受击
 *   （'#N' 位置序 / 'W' 最弱 / 'S' 最强，按轰炸值）。
 *
 * ★ 口径唯一（M2⑥）：击落判定的**实现**在 `rules/air.ts#flakKillCheck`（那里读
 *   `FLAK_KILL_MIN_DICE`），本模块只**转发**，不再自持一份比较 —— 此前两份同名定义并存，
 *   而产品路径（`air-interaction.ts#resolveFlakResponse`）里还出现过第三份"硬编码 11"。
 */

export { flakKillCheck }

/** 14.4f：防空任务损失表的表 id（**唯一来源** charts-tables.json） */
export const FLAK_MISSION_LOSS_TABLE = 'flak-mission-loss'

/** 防空任务损失归属：掷 1 骰 → 受击机（'#1'…'#4' / 'W' / 'S'） */
export function flakMissionLoss(aircraftCount: 2 | 3 | 4, roll: number): string {
  const table = findTable(chartsTables.tables, FLAK_MISSION_LOSS_TABLE)
  const rowIndex = resolveLabelColumnIndex(table.rows, `${aircraftCount} aircraft`, table.id)
  const columnIndex = matchRowIndex(table.columns ?? [], roll, table.id)
  return lookupCell(table.grid, rowIndex, columnIndex, table.id)
}
