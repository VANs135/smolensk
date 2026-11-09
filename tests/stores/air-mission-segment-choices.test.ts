import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { useWorkbenchStore } from '@/stores'

/**
 * 14.2e / 10.0 第二段：**「任务分配」入口只列本环节的任务类型**
 *
 * 口径：
 *   · 移动环节（C `movement.modeAndMovement`、E `reaction.movement`、G `exploitation.movement`）
 *     ⇒ 低空扫射 / 空运 / 空投 / 战机扫荡；**普通轰炸不可选**（10.0 第二段只给低空扫射开口子）；
 *   · 轰炸环节（`*.barrage`）⇒ 空军轰炸 / 运输破坏；低空扫射不可选；
 *   · 基地转移 / 拦截仍走专用入口，不进入本清单；
 *   · 旁路：绕过界面直接写 `airMissionKind` ⇒ `beginAirMissionNow` 必须按 14.2e 拒。
 */

const MOVEMENT_KEYS = ['hip_shoot', 'air_transport', 'air_drop', 'fighter_sweep'] as const
const BARRAGE_KEYS = ['barrage', 'trainbusting'] as const

function storeAt(
  phase: 'movement' | 'reaction' | 'exploitation',
  segmentId: string,
): ReturnType<typeof useWorkbenchStore> {
  setActivePinia(createPinia())
  const w = useWorkbenchStore()
  w.setActiveSide('axis')
  w.setPhase(phase)
  // 6.3a / 7.0a：反应段由**非**行动方行动
  if (phase === 'reaction') w.activeSide = 'soviet'
  const index = w.playerSegmentSteps.findIndex((step) => step.id === segmentId)
  expect(index, `找不到环节 ${segmentId}`).toBeGreaterThanOrEqual(0)
  expect(w.setSegmentStepIndex(index)).toBe(true)
  return w
}

const keysOf = (w: ReturnType<typeof useWorkbenchStore>): string[] =>
  w.airMissionKindChoices.map((choice) => choice.key)

describe('14.2e：任务分配入口按环节给任务类型', () => {
  it('★ C 移动环节只给移动环节任务，普通轰炸不可选', () => {
    const w = storeAt('movement', 'movement.modeAndMovement')
    expect(keysOf(w)).toEqual([...MOVEMENT_KEYS])
    expect(keysOf(w)).not.toContain('barrage')
    // 基地转移 / 拦截仍走专用入口
    expect(keysOf(w)).not.toContain('base_transfer')
    expect(keysOf(w)).not.toContain('interception')
  })

  it('★ E 反应移动环节同口径', () => {
    const w = storeAt('reaction', 'reaction.movement')
    expect(keysOf(w)).toEqual([...MOVEMENT_KEYS])
    expect(keysOf(w)).not.toContain('barrage')
  })

  it('★ G 进击移动环节同口径', () => {
    const w = storeAt('exploitation', 'exploitation.movement')
    expect(keysOf(w)).toEqual([...MOVEMENT_KEYS])
    expect(keysOf(w)).not.toContain('barrage')
  })

  it('★ 轰炸环节只给轰炸环节任务，低空扫射不可选', () => {
    const w = storeAt('movement', 'movement.barrage')
    expect(keysOf(w)).toEqual([...BARRAGE_KEYS])
    expect(keysOf(w)).not.toContain('hip_shoot')
  })

  it('★ 旁路：移动环节直接写普通轰炸 ⇒ 宣布被 14.2e 拒', () => {
    const w = storeAt('movement', 'movement.modeAndMovement')
    w.airMissionKind = 'barrage'
    expect(w.beginAirMissionNow()).toBe(false)
    expect(w.airError?.rule).toBe('14.2e')
    expect(w.airError?.reason).toBe('missionKindOutsideSegment:barrage')
  })

  it('★ 换环节后非法任务类型自动落位到本环节首项', () => {
    const w = storeAt('movement', 'movement.barrage')
    expect(w.airMissionKind).toBe('barrage')
    const index = w.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement')
    expect(w.setSegmentStepIndex(index)).toBe(true)
    expect(w.airMissionKind).toBe('hip_shoot')
  })
})
