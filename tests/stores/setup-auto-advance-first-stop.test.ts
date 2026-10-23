import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useGameSessionStore, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 第六批批 S 切片 3（条 3）：**「完成初设」后自动连跑到第一个玩家环节**
 *
 * 用户口径（2026-09-16 ⑩）：「点击进入下一个阶段后，**自动进行的阶段不需要玩家介入**，
 * 直到开始玩家要介入的环节」。
 *
 * 修前的病灶：`startGameNow()` 只调**一次** `game.stepNow()` ⇒ 点完「完成初设」后停在
 *   `preTurn` 的第一步之后，先手仍停在 `preTurn`；而首回合的自动段是**两步**
 *   （天气 → 先手判定；2.3 首回合由剧本指定 ⇒ 不发问）⇒ 玩家还得自己再点两次才到
 *   A 飞机整备段。文档记录为「未用 `advanceToNextStop`」（`docs/第六批修改方案.md` 条 3）。
 *
 * 修法：改用会话的连跑 `game.advanceToNextStop()`；**真的**挂在待答上（2.3 要玩家选先后手）时不硬闯。
 *
 * ## 测法边界（如实交代）
 *   · 用真实剧本（`selectScenario('1')` ⇒ 固定项自动初设），不造盘面；
 *   · 只钉"停在哪个环节"与"有没有硬闯待答"；自动段**内部**的天气/先手结算由
 *     `tests/stores/advance-segment.test.ts` 与 `tests/flows/*` 覆盖。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return {
    setup: useSetupStore(),
    session: useGameSessionStore(),
    workbench: useWorkbenchStore(),
  }
}

describe('第六批 S3：完成初设 ⇒ 自动连跑到第一个玩家环节（条 3）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('★ 点「完成初设」⇒ 一次落到**第一个玩家环节**（A 飞机整备），不再停在 Pre-Turn', () => {
    const { setup, session, workbench } = stores
    setup.selectScenario('1')
    expect(setup.startGameNow()).toBe(true)

    // 反空转：确实推进了（不是 0 步），且停在**玩家**环节
    expect(session.lastAdvanceOutcome?.stoppedBy).toBe('player')
    expect(session.lastAdvanceOutcome?.steps ?? 0).toBeGreaterThanOrEqual(2)
    // 2.2：第一个玩家环节＝先手方的 A 飞机整备段
    expect(session.guidance?.step.id).toBe('first.aircraftRefit')
    expect(session.records?.phase).toBe('aircraftRefit')
    // 界面读的是 workbench 的阶段 ⇒ 它必须同步（否则"开始游戏"看上去没反应）
    expect(workbench.phase).toBe('aircraftRefit')
  })

  it('★ 待答时不硬闯：停在 2.3 先后手 ⇒ 玩家答完才继续（不替玩家决定）', () => {
    const { setup, session } = stores
    setup.selectScenario('1')
    expect(setup.startGameNow()).toBe(true)
    // 首回合先手由剧本指定 ⇒ 通常不发问；若这一局真的挂起待答，则必须停在待答处
    if (session.awaiting) {
      expect(session.lastAdvanceOutcome?.stoppedBy).toBe('question')
      expect(session.question?.kind).toBe('initiative')
      // 未作答前再推进 ⇒ 一步都不走（内核拒绝）
      expect(session.advanceToNextStop().steps).toBe(0)
      expect(session.answerNow('first')).toBe(true)
      expect(session.advanceToNextStop().stoppedBy).toBe('player')
    } else {
      expect(session.lastAdvanceOutcome?.stoppedBy).toBe('player')
    }
  })

  it('源码守卫：`startGameNow` 走**连跑**（`advanceToNextStop`），不再是单步 `stepNow`', () => {
    const source = readFileSync('src/stores/setup.ts', 'utf8')
    const at = source.indexOf('function startGameNow')
    const end = source.indexOf('\n  function ', at + 100)
    const body = source.slice(at, end < 0 ? at + 4000 : end)
    expect(body).toContain('game.advanceToNextStop()')
    // 收束点仍保留"一步一停"的入口给验证页 ⇒ 这里只要求**不再**用单步推进开局
    expect(body).not.toContain('game.stepNow()')
  })
})
