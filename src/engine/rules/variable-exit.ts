import { rulesConstants } from '@/data'

import { matchRowIndex } from '../tables/lookup'
import { VARIABLE_EXIT_START } from './timing'

/**
 * 可变撤离（专规 3.3c）
 *
 * 19 August 起每回合轴方增援阶段掷 1 骰查可变撤离表：
 *   1 → 移除 SS Reich 全部单位
 *   2-5 → 下回合再掷
 *   6 → 移除 14 Mtr 全部单位
 * 19 August 之前不执行任何撤离，直接返回 skipped。
 */

/** 可变撤离结果类型 */
export type VariableExitResultKind = 'remove' | 'reroll' | 'skipped'

/** 可变撤离结果 */
export interface VariableExitResult {
  kind: VariableExitResultKind
  /** 原始骰面值（1–6） */
  die: number
  /** 结果描述（源库 variable_exit.table 的值） */
  description: string
  /** 如果 kind=remove，被撤离的单位名 */
  removedUnit?: string
  /** 是否允许执行（需 >= startDate） */
  active: boolean
}

/** 可变撤离表原始数据（骰面值段 → 结果描述） */
export const VARIABLE_EXIT_TABLE = rulesConstants.smolensk.variableExitTable

/** 骰面值段解析：返回命中的表键（精确值或区间） */
function resolveDieKey(die: number, table: Record<string, string>): string {
  const labels = Object.keys(table)
  return labels[matchRowIndex(labels, die, 'variable_exit')]!
}

/**
 * 可变撤离掷骰解析
 *
 * @param die 1–6 骰面值
 * @param date 当前日期（ISO；用于判断是否已到撤离开始日）
 */
export function rollVariableExit(die: number, date: string): VariableExitResult {
  if (!Number.isInteger(die) || die < 1 || die > 6) {
    throw new RangeError(`可变撤离骰面值必须是 1–6 的整数，收到 ${die}`)
  }

  if (date < VARIABLE_EXIT_START) {
    return {
      kind: 'skipped',
      die,
      description: `可变撤离尚未开始（${VARIABLE_EXIT_START} 起）`,
      active: false,
    }
  }

  const key = resolveDieKey(die, VARIABLE_EXIT_TABLE)
  const description = VARIABLE_EXIT_TABLE[key] ?? `未知骰面值 ${die}`

  let kind: VariableExitResultKind = 'reroll'
  let removedUnit: string | undefined

  if (description === 'roll again next turn') {
    kind = 'reroll'
  } else if (description.startsWith('remove ')) {
    kind = 'remove'
    removedUnit = description.replace(/^remove\s+/, '').replace(/\s+\(all\)$/, '')
  }

  return {
    kind,
    die,
    description,
    removedUnit,
    active: true,
  }
}
