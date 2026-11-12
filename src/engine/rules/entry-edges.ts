import type { HexRef, Side } from '@/data'

/**
 * 字母入场段（入场/增援用；**不是** 2.1 / 3.1 的补给源判据）
 *
 * - 德（轴）：K/J/I/H/G/F（西缘）
 * - 苏：A/B/C/D/E/L（东/北/南缘）
 *
 * 本表只回答「本方有哪些**字母入场段**」（3.4a「无任何铁路进入」等入场判定，
 * 以及 13.6b 入场格登车的格清单），不写死格号，只读 `map-config.entryHexes`。
 * 缺字母 ⇒ 返回 `missing` 交上层报缺口，**不**退化成全边缘兜底。
 *
 * ★ 专规 2.1 / 3.1 的**补给源**是地理判据，不是字母段（用户 2026-11-12 按原文裁定）：
 *   东缘 col > 12 / 西缘 col < 10 且**有任意道路或铁路入图**的图边格即为该方补给源，
 *   与字母无关（例：42.35 是苏方源但无字母；4.00 是轴方源但无字母）。该清单的权威落在
 *   `scenarios.json → supplySources`，**不要**用本表当作补给源清单。
 */
export const ENTRY_EDGE_LETTERS: Record<Side, readonly string[]> = {
  axis: ['K', 'J', 'I', 'H', 'G', 'F'],
  soviet: ['A', 'B', 'C', 'D', 'E', 'L'],
}

export interface EntryEdgeHexes {
  hexes: HexRef[]
  /** 数据表里缺失或为空的字母（按字母表顺序） */
  missing: string[]
}

/** 按方取字母入场格（去重；缺字母记入 `missing`） */
export function entryEdgeHexes(
  side: Side,
  table: Readonly<Record<string, readonly HexRef[] | undefined>>,
): EntryEdgeHexes {
  const hexes: HexRef[] = []
  const seen = new Set<string>()
  const missing: string[] = []
  for (const letter of ENTRY_EDGE_LETTERS[side]) {
    const list = table[letter]
    if (list === undefined || list.length === 0) {
      missing.push(letter)
      continue
    }
    for (const hex of list) {
      const key = `${hex.col}.${hex.row}`
      if (seen.has(key)) continue
      seen.add(key)
      hexes.push({ col: hex.col, row: hex.row })
    }
  }
  return { hexes, missing }
}
