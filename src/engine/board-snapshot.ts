import { z } from 'zod'

const envelope = z.object({ version: z.number().int().positive(), fields: z.record(z.unknown()) })
export interface BoardSnapshot {
  version: number
  fields: Record<string, unknown>
}
export interface SnapshotContract {
  version: number
  defaults: Readonly<Record<string, unknown>>
  legacyMissingKeys: Readonly<Record<number, readonly string[]>>
  validate(fields: Record<string, unknown>): boolean
}
export interface PreparedBoardSnapshot extends BoardSnapshot {
  sourceVersion: number
}
export function cloneSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 先解析、迁移、校验整个值，再交给状态层提交；不读取当前运行中的盘面。 */
export function prepareBoardSnapshot(
  input: unknown,
  contract: SnapshotContract,
): PreparedBoardSnapshot {
  const parsed = envelope.parse(input)
  const missing =
    parsed.version === contract.version ? [] : contract.legacyMissingKeys[parsed.version]
  if (missing === undefined) throw new Error(`不支持盘面版本 ${parsed.version}`)
  for (const [key, initial] of Object.entries(contract.defaults)) {
    if (!(key in parsed.fields)) {
      if (missing.includes(key)) continue
      throw new Error(`盘面缺少字段 ${key}`)
    }
    const value = parsed.fields[key]
    if (initial === null) continue
    const matches = Array.isArray(initial)
      ? Array.isArray(value)
      : typeof initial === 'object'
        ? typeof value === 'object' && value !== null && !Array.isArray(value)
        : typeof initial === typeof value
    if (!matches) throw new Error(`盘面字段类型错误 ${key}`)
  }
  const fields = cloneSnapshot({ ...contract.defaults, ...parsed.fields })
  const index = fields['segmentStepIndex']
  if (index !== undefined && (typeof index !== 'number' || !Number.isInteger(index) || index < 0)) {
    throw new Error('盘面环节进度无效')
  }
  if (!contract.validate(fields)) throw new Error('盘面实体无效')
  return { version: contract.version, sourceVersion: parsed.version, fields }
}
