import type { ZodType } from 'zod'

import { DataError, formatIssues } from './errors'
import { deepFreeze } from './freeze'
import type { DeepReadonly } from './freeze'
import { DATA_VERSION } from './version'

/**
 * 数据加载管线：读取 → 校验 → 深度冻结 → 版本号
 *
 * 单文件处理三步：
 *   1. 读取：调用方以 `import raw from './x.json'` 或 fetch 得到 unknown；
 *   2. 校验：版本号比对（/meta/version）→ Zod schema 校验（失败抛 DataError，字段路径可定位）；
 *   3. 冻结：deepFreeze 递归只读，保证引擎侧数据不可篡改。
 * 经 bootstrapData 导出的结果类型恒为 DeepReadonly<T>。
 */

/** 数据文件普遍携带的头部结构（供版本检查读取） */
type RawDataFile = { meta?: { version?: unknown } }

/** 校验 meta.version 与期望版本一致；不一致抛 DataError（指向 /meta/version） */
function assertVersionMatches(raw: unknown, source: string, expectedVersion: string): void {
  const meta = (raw as RawDataFile | null)?.meta
  const actual = typeof meta?.version === 'string' ? meta.version : undefined
  if (actual !== expectedVersion) {
    throw new DataError(
      source,
      `版本不匹配：期望 ${expectedVersion}，实际 ${actual ?? '缺失'}（/meta/version）`,
    )
  }
}

/**
 * 校验并返回数据（不冻结）。
 * 失败即抛 DataError，message 内含逐条「字段路径: 原因」，可精确定位到字段。
 */
export function validateData<T>(
  raw: unknown,
  schema: ZodType<T>,
  source: string,
  expectedVersion = DATA_VERSION,
): T {
  assertVersionMatches(raw, source, expectedVersion)

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new DataError(source, formatIssues(parsed.error.issues), parsed.error.issues)
  }
  return parsed.data
}

/** 完整管线：校验 → 深度冻结，返回只读数据 */
export function bootstrapData<T>(
  raw: unknown,
  schema: ZodType<T>,
  source: string,
  expectedVersion = DATA_VERSION,
): DeepReadonly<T> {
  return deepFreeze(validateData(raw, schema, source, expectedVersion))
}
