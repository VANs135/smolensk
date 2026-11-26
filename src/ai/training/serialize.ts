/**
 * 训练观测序列化：稳定 ID + 键序规范的纯数据
 *
 * 与 `trace.ts:serializeObservation` 的区别：
 * - 这里把已登记实体的原始 ID 按字段分流替换成训练别名（`baseId` 不会被同名地面单位覆盖）；
 * - 对象键递归排序，Set 用码点比较，保证同语义数据同字节（不依赖 locale）；
 * - 同时附实体 roster，供模型做实体/图特征。
 */

import type { AiSnapshot } from '../policy'
import { AI_TRAIN_VERSION, type TrainingEntity, type TrainingObservation } from './contract'
import type { TrainingIdentity } from './identity'

const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function mapValue(value: unknown, identity: TrainingIdentity, field: string): unknown {
  if (value instanceof Set) {
    return [...value]
      .map((item) => mapValue(item, identity, field))
      .sort((a, b) => cmpText(String(a), String(b)))
  }
  if (Array.isArray(value)) return value.map((item) => mapValue(item, identity, field))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const source = value as Record<string, unknown>
    for (const key of Object.keys(source).sort(cmpText)) {
      out[key] = mapValue(source[key], identity, key)
    }
    return out
  }
  if (typeof value === 'string') return identity.aliasFor(field, value)
  return value
}

/** 稳定投影：所有已知 ID 换成别名，对象键排序 */
export function stableStateOf(
  snapshot: AiSnapshot,
  identity: TrainingIdentity,
): Record<string, unknown> {
  identity.refresh()
  return mapValue(snapshot, identity, '') as Record<string, unknown>
}

/** 一帧训练观测（state + roster） */
export function trainingObservationOf(
  snapshot: AiSnapshot,
  identity: TrainingIdentity,
): TrainingObservation {
  const entities: TrainingEntity[] = identity.entities()
  return {
    version: AI_TRAIN_VERSION,
    scenarioId: snapshot.scenarioId,
    turn: snapshot.turn,
    phase: snapshot.phase,
    segment: snapshot.segment,
    segmentStepIndex: snapshot.segmentStepIndex,
    activeSide: snapshot.activeSide,
    defenderSide: snapshot.defenderSide,
    terminated: snapshot.terminated,
    locked: snapshot.locked,
    state: stableStateOf(snapshot, identity),
    entities,
  }
}
