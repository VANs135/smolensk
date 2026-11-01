import type { Ref } from 'vue'
import {
  cloneSnapshot,
  prepareBoardSnapshot,
  type BoardSnapshot,
  type PreparedBoardSnapshot,
  type SnapshotContract,
} from '@/engine/board-snapshot'

export interface SnapshotRegistryOptions {
  version: number
  fields(): readonly (readonly [string, Ref<unknown>])[]
  legacyMissingKeys: SnapshotContract['legacyMissingKeys']
  validate: SnapshotContract['validate']
  beforeCapture(): void
  afterRestore(snapshot: PreparedBoardSnapshot, silent: boolean): void
}

/** Pinia适配层只负责完整值与ref之间的映射，版本及迁移规则由纯内核处理。 */
export function createSnapshotRegistry(options: SnapshotRegistryOptions) {
  const bindings = options.fields()
  if (new Set(bindings.map(([key]) => key)).size !== bindings.length)
    throw new Error('快照字段重复')
  const defaults = Object.fromEntries(
    bindings.map(([key, value]) => [key, cloneSnapshot(value.value ?? null)]),
  )
  const contract: SnapshotContract = {
    version: options.version,
    defaults,
    legacyMissingKeys: options.legacyMissingKeys,
    validate: options.validate,
  }
  function initial(): BoardSnapshot {
    return { version: options.version, fields: cloneSnapshot(defaults) }
  }
  function capture(): BoardSnapshot {
    options.beforeCapture()
    return {
      version: options.version,
      fields: Object.fromEntries(
        bindings.map(([key, value]) => [key, cloneSnapshot(value.value ?? null)]),
      ),
    }
  }
  function accepts(input: unknown): boolean {
    try {
      prepareBoardSnapshot(input, contract)
      return true
    } catch {
      return false
    }
  }
  function restore(input: unknown, silent = false): void {
    const prepared = prepareBoardSnapshot(input, contract)
    const previous = bindings.map(([, target]) => cloneSnapshot(target.value))
    try {
      for (const [key, target] of bindings) target.value = prepared.fields[key]
      options.afterRestore(prepared, silent)
    } catch (cause) {
      bindings.forEach(([, target], index) => {
        target.value = previous[index]
      })
      throw cause
    }
  }
  return { capture, accepts, restore, initial }
}
