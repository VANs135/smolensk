import type { HexRef, Side } from '@/data'

/**
 * 3.1 / 2.1（用户 2026-11-11 追加裁定）：图边 = 地图库已配置的**字母入场段**
 *
 * - 德（轴）：K/J/I/H/G/F（西缘）
 * - 苏：A/B/C/D/E/L（东/北/南缘）
 *
 * 不是「所有西缘格」或「所有边缘格」；不写死格号，只读 `map-config.entryHexes`。
 * 缺字母 ⇒ 返回 `missing` 交上层报缺口，**不**退化成全边缘兜底。
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
