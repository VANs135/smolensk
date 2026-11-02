import type { HexRef } from '@/data'
import type { MoveStepRecord } from '@/engine/rules'

export interface MoveStepSnapshot {
  kind: MoveStepRecord['kind']
  from: HexRef
  to: HexRef
  /** 随行单位名 */
  movedNames: string[]
  /** 掉队单位名（6.1f：留在经过的格中） */
  droppedNames: string[]
  /** 进入未抵消敌方 ZOC 被迫停止的单位名（4.5a-A） */
  zocStoppedNames: string[]
  /** 各随行单位本步消耗的 MP 文本 */
  costText: string
  rules: string[]
}
