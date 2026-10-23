/**
 * 取表通用原语（A7.1）
 *
 * 所有判定表共享的行/列解析与单元格读取；规则：
 * - 数值行标（'2'、'3-4'、'117+'、'15 or more'、'1 or less'）按范围匹配；
 * - 数值列标（轰炸表值段）同样按范围匹配，越界时夹取到最近边界列；
 * - 类别列标（夺取表 'Dump (on ground)' 等）按标签精确匹配；
 * - 取不到即抛 TableLookupError，附带表标识与解析上下文，便于定位。
 *
 * 取表只依赖最小结构 TableLike（只读），兼容数据层的 zod 推导类型与其 DeepReadonly 冻结形态。
 */

/** 取表所需的表最小结构（GridTable 的只读视图） */
export interface TableLike {
  id: string
  rows: readonly (string | number)[]
  columns?: readonly string[]
  grid: readonly (readonly string[])[]
  cost?: readonly number[]
}

/** 取表失败：表标识 + 上下文 + 原因 */
export class TableLookupError extends Error {
  readonly table: string
  readonly context: string

  constructor(table: string, context: string) {
    super(`[${table}] ${context}`)
    this.name = 'TableLookupError'
    this.table = table
    this.context = context
  }
}

/** 解析出的数值区间（闭区间；Infinity 表示无界） */
interface NumericRange {
  min: number
  max: number
}

const NUMBER_RE = /^(\d+)$/
const RANGE_RE = /^(\d+)-(\d+)$/
const MORE_RE = /^(\d+)(?:\+\s*|\s+or\s+more)$/
const LESS_RE = /^(\d+)\s+or\s+less$/

/** 把行/列标签解析为数值区间；非数值标签（'1:2'、类别名）返回 null */
export function toNumericRange(label: string | number): NumericRange | null {
  if (typeof label === 'number') return { min: label, max: label }

  const numberMatch = label.match(NUMBER_RE)
  if (numberMatch) {
    const value = Number(numberMatch[1])
    return { min: value, max: value }
  }

  const rangeMatch = label.match(RANGE_RE)
  if (rangeMatch) {
    return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) }
  }

  const moreMatch = label.match(MORE_RE)
  if (moreMatch) {
    return { min: Number(moreMatch[1]), max: Number.POSITIVE_INFINITY }
  }

  const lessMatch = label.match(LESS_RE)
  if (lessMatch) {
    return { min: Number.NEGATIVE_INFINITY, max: Number(lessMatch[1]) }
  }

  return null
}

/** 按数值匹配行标，返回行索引；无匹配抛 TableLookupError */
export function matchRowIndex(
  rows: readonly (string | number)[],
  value: number,
  table = 'table',
): number {
  for (let index = 0; index < rows.length; index += 1) {
    const range = toNumericRange(rows[index] ?? '')
    if (range && value >= range.min && value <= range.max) return index
  }
  throw new TableLookupError(table, `未找到匹配行（值 ${value}，行标 ${rows.join(' | ')}）`)
}

/**
 * 按数值匹配列标（值段列）；越界时返回最近边界列。
 * 无任何数值列标可用时抛 TableLookupError。
 */
export function resolveNumericColumnIndex(
  columns: readonly string[] | undefined,
  value: number,
  table = 'table',
): number {
  if (!columns || columns.length === 0) {
    throw new TableLookupError(table, '数值列解析需要列标，但列标为空')
  }

  let firstRange: NumericRange | null = null
  let lastRange: NumericRange | null = null
  for (let index = 0; index < columns.length; index += 1) {
    const range = toNumericRange(columns[index] ?? '')
    if (!range) continue
    if (firstRange === null) firstRange = range
    lastRange = range
    if (value >= range.min && value <= range.max) return index
  }

  // 越界：夹取到最近边界列
  if (firstRange !== null && value < (firstRange.min as number)) return 0
  if (lastRange !== null && value > (lastRange.max as number)) return columns.length - 1

  throw new TableLookupError(table, `列标不含任何数值段（${columns.join(' | ')}）`)
}

/** 按标签精确匹配列（类别列标）；无匹配抛 TableLookupError */
export function resolveLabelColumnIndex(
  columns: readonly (string | number)[] | undefined,
  label: string,
  table = 'table',
): number {
  if (!columns) throw new TableLookupError(table, '列标为空')
  const index = columns.indexOf(label)
  if (index === -1)
    throw new TableLookupError(table, `列标中无「${label}」（${columns.join(' | ')}）`)
  return index
}

/** 取表：按行标与列标返回单元格（行主序网格） */
export function lookupCell<T>(
  grid: readonly (readonly T[])[],
  rowIndex: number,
  columnIndex: number,
  table = 'table',
): T {
  const row = grid[rowIndex]
  if (!row)
    throw new TableLookupError(table, `行越界（rowIndex ${rowIndex}，共 ${grid.length} 行）`)
  const cell = row[columnIndex]
  if (cell === undefined) throw new TableLookupError(table, `列越界（columnIndex ${columnIndex}）`)
  return cell
}

/** 从表集中按 id 取表；缺失抛 TableLookupError */
export function findTable(tables: readonly TableLike[], id: string): TableLike {
  const table = tables.find((t) => t.id === id)
  if (!table) throw new TableLookupError(id, '表中不存在该 id')
  return table
}
