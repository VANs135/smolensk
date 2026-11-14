import { cloneSnapshot } from '@/engine/board-snapshot'
import type { GameSession } from '@/engine/state-types'
import type { BoardCodec } from './session'

/** 对局快照边界：会话、盘面与初设一同捕获、校验，单独的页面不再拼装保存内容。 */
export interface GameSnapshot {
  session: GameSession
  board?: unknown
  setup?: unknown
}
export function captureGameSnapshot(
  session: GameSession,
  board: BoardCodec | null,
  setup: BoardCodec | null,
): GameSnapshot {
  const captured = board?.capture()
  const payload =
    captured === undefined
      ? undefined
      : setup === null
        ? captured
        : {
            ...(captured as Record<string, unknown>),
            setup: setup.capture(),
          }
  return cloneSnapshot({ session, ...(payload === undefined ? {} : { board: payload }) })
}
export function prepareGameSnapshot(
  session: GameSession,
  payload: unknown,
  board: BoardCodec | null,
  setup: BoardCodec | null,
): GameSnapshot {
  /*
   * 2.2：除回合准备（preTurn）外，记录轨必须有行动方与先手方。
   *
   * 这两个字段一旦缺失，H 清理收尾会直接报「清理阶段缺少行动方或先手方（2.2）」——
   * 等于把一份坏档变成走不动的死局。**不补值猜**（用户 2026-11-14）：当场拒读，
   * 并在原因里说清缺的是哪一个。
   */
  const records = session.state.records
  const missing = [
    ...(records.activeSide === null ? ['行动方'] : []),
    ...(records.firstPlayer === null ? ['先手方'] : []),
  ]
  if (records.phase !== 'preTurn' && missing.length > 0)
    throw new Error(
      `recordsMissingSide:回合记录缺少${missing.join('与')}（2.2）——拒绝读档，避免在无行动方的记录轨上继续`,
    )
  const initial =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)['setup']
      : undefined
  if (initial !== undefined && !setup?.accepts(initial, session.state.scenarioId))
    throw new Error('setupUnrecognized:初设状态无效')
  if (board !== null) {
    if (payload === undefined)
      throw new Error('boardMissing:该档不含盘面快照（修前存档）——拒绝恢复不完整的对局')
    if (!board.accepts(payload)) throw new Error('boardUnrecognized:盘面快照的版本或字段表不认识')
  }
  return cloneSnapshot({
    session,
    ...(payload === undefined ? {} : { board: payload }),
    ...(initial === undefined ? {} : { setup: initial }),
  })
}
