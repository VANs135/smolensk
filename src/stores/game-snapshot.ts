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
  const initial =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)['setup']
      : undefined
  if (initial !== undefined && !setup?.accepts(initial))
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
