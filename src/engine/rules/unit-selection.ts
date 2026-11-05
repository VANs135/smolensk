import type { HexRef } from '@/data'

/**
 * 通用「可选单位清单」（2026-11-05 用户裁定⑦）
 *
 * 规则要求**玩家选择单位**时（3.3c 撤离是第一个接入点，之后另有清单逐批接入），
 * 引擎侧统一给出"当前情境下可选单位清单（含每格可选子集）"，界面侧统一走高亮＋点选＋只列可选。
 *
 * ★ 本文件**只做集合运算**：可选与否由调用方按规则算好（`eligible`），这里不判断任何规则。
 * ★ 只列可选者：`hexes` / `byHex` 不包含"整格都不可选"的格（界面不为它们高亮）。
 */
export interface UnitSelectionCandidate {
  /** 实例 id */
  id: string
  col: number
  row: number
  /** 是否可选 */
  eligible: boolean
  /** 不可选原因（`eligible === true` 时忽略） */
  reason?: string | null
}

/** 每格的**可选**子集 */
export interface UnitSelectionHex {
  col: number
  row: number
  ids: readonly string[]
}

export interface UnitSelectionSet {
  /** 全部可选 id（按输入顺序、去重） */
  eligibleIds: readonly string[]
  /** 有可选单位的格（按 row、col 升序；只含有可选子集的格） */
  hexes: readonly HexRef[]
  /** 每格可选子集（顺序与 `hexes` 一致） */
  byHex: readonly UnitSelectionHex[]
}

/**
 * 把候选事实折成可选集合
 *
 * 排序固定为 `row` 升序、同 `row` 按 `col` 升序（界面与测试都吃这一份顺序，避免两次渲染不一致）。
 */
export function buildUnitSelectionSet(
  candidates: readonly UnitSelectionCandidate[],
): UnitSelectionSet {
  const seen = new Set<string>()
  const eligibleIds: string[] = []
  const groups = new Map<string, { col: number; row: number; ids: string[] }>()

  for (const candidate of candidates) {
    if (!candidate.eligible) continue
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    eligibleIds.push(candidate.id)
    const key = `${candidate.col}.${candidate.row}`
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, { col: candidate.col, row: candidate.row, ids: [candidate.id] })
    } else {
      group.ids.push(candidate.id)
    }
  }

  const byHex = [...groups.values()]
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .map((group) => ({ col: group.col, row: group.row, ids: group.ids }))

  return {
    eligibleIds,
    hexes: byHex.map((group) => ({ col: group.col, row: group.row })),
    byHex,
  }
}
