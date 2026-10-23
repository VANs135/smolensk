import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * B47（12.8e）：**突围**接进盘面的验收
 *
 * 病灶（§17.81）：引擎 `breakout.ts` 判据齐备、动作闸 `move.breakout` 也挂在 `movement.breakout` 环节，
 * 但 store 与界面**没有任何入口** ⇒ 断补单位永远无法突围（违反"可达"）。
 *
 * 四条判据各自钉一条：
 *   · **可达**：`breakoutCandidates` 列出断补单位，且界面阵列的灰显原因取自引擎；
 *   · **强制**：不在突围环节 / 有追溯补给 / 非战斗单位 / 无路径 —— 一律拒绝并给条文号；
 *   · **留痕**：掷骰进会话日志（`recordSettlement` 的 `breakoutAttempt`）；
 *   · **可玩通**：成功 ⇒ 离图待返场（**不进死亡堆**）；失败 ⇒ 进死亡堆；回合到后可放回。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 拉开距离的两格（远离边缘，避免边角地形把路径判死） */
const [FAR_HEX, NEAR_HEX] = (() => {
  for (const hex of mapLayers.hexes) {
    if (hex.col < 12 || hex.row < 12 || hex.col > 40 || hex.row > 24) continue
    const a: HexRef = { col: hex.col, row: hex.row }
    const b = neighbor(a, HEX_DIRECTIONS[0])
    if (!mapLayers.hexes.some((item) => item.col === b.col && item.row === b.row)) continue
    return [a, b] as const
  }
  throw new Error('地图上找不到合适的两格')
})()

/** 一枚**战斗单位**（12.8e：只有战斗单位可突围，首回合豁免时运输点数亦可） */
const COMBAT_RECORD = unitChoices('axis').find(
  (record) => record.isCombat === true && (record.steps?.total ?? 1) <= 1,
)!

beforeEach(() => {
  setActivePinia(createPinia())
})

/**
 * 摆一个**断补**的战斗单位 + 一个**有追溯补给**的友军，并把 store 放到**突围环节**
 *
 * ★ 时序要点：`setPhase` 会触发一次**全场重判**（`refreshTraceSupply`），它会按补给网重算每个单位的
 *   `hasTraceSupply` ⇒ 手工钉的状态必须在**重判之后**再设，否则会被覆盖（第一版夹具就栽在这里：
 *   "有补给的友军"被重判成本图无补给，于是 A 路径摸不到人、判定理由全错）。
 */
function enterBreakoutWith(store: ReturnType<typeof newStore>) {
  store.setPhase('movement')
  const trapped = toConsoleUnit({
    record: COMBAT_RECORD,
    instanceId: 'bl-1',
    hex: FAR_HEX,
    side: 'axis',
  })
  const friend = toConsoleUnit({
    record: COMBAT_RECORD,
    instanceId: 'fr-1',
    hex: NEAR_HEX,
    side: 'axis',
  })
  store.units.push(trapped, friend)
  //
  // 重判之后再钉状态（判据读的就是此刻的值），且**必须经 store 的代理**改：
  // 直接改 `trapped.hasTraceSupply` 改的是**原始对象**，不会触发响应式 ⇒
  // `playerSegmentSteps` 若已在这次赋值之前求过值，就会缓存"突围无人可动"（2026-09-18 被 slice 2 的
  // sync watch 暴露：它在建店时就读了该 computed）。夹具按正确写法改，判据与断言一字未动。
  //
  const liveTrapped = store.units.find((unit) => unit.instanceId === 'bl-1')!
  const liveFriend = store.units.find((unit) => unit.instanceId === 'fr-1')!
  liveTrapped.hasTraceSupply = false
  liveFriend.hasTraceSupply = true
  trapped.hasTraceSupply = false
  friend.hasTraceSupply = true
  const index = store.playerSegmentSteps.findIndex((step) => step.id === 'movement.breakout')
  if (index < 0) throw new Error('移动阶段没有突围环节（断补单位在场时它应出现）')
  if (!store.setSegmentStepIndex(index)) throw new Error('进入突围环节失败')
  return { trapped, friend }
}

describe('B47（12.8e）：突围的四条判据', () => {
  it('★ 可达：断补单位出现在突围候选里，且灰显原因取自引擎（无补给者列为可尝试）', () => {
    const store = newStore()
    const { trapped, friend } = enterBreakoutWith(store)

    const ids = store.breakoutCandidates.map((entry) => entry.unit.instanceId)
    expect(ids).toContain(trapped.instanceId)
    // 有追溯补给的友军**不在**候选里（12.8e：「任何当前**没有追溯补给**的……」）
    expect(ids).not.toContain(friend.instanceId)
  })

  it('★ 强制：不在突围环节 ⇒ 拒绝（动作闸 move.breakout 只挂在突围环节）', () => {
    const store = newStore()
    store.setPhase('movement')
    const { trapped } = enterBreakoutWith(store)
    // 停在移动环节（非突围环节）
    const moveIndex = store.playerSegmentSteps.findIndex(
      (step) => step.id === 'movement.modeAndMovement',
    )
    expect(store.setSegmentStepIndex(moveIndex)).toBe(true)

    expect(store.breakoutNow(trapped.instanceId)).toBe(false)
    expect(store.log.some((line) => line.text.includes('12.8e'))).toBe(true)
  })

  it('★ 强制：有追溯补给的单位不须（也无从）突围 ⇒ 引擎给 hasTraceSupply 理由', () => {
    const store = newStore()
    const { friend } = enterBreakoutWith(store)

    expect(store.breakoutNow(friend.instanceId)).toBe(false)
    expect(store.log.some((line) => line.text.includes('hasTraceSupply'))).toBe(true)
  })

  it('★ 留痕 + 可玩通：突围成功 ⇒ 离图待返场（**不进死亡堆**）', () => {
    const store = newStore()
    const { trapped } = enterBreakoutWith(store)

    // 给定骰值：6 ⇒ 必成功（12.8e：修正后 5–6 成功）
    store.breakoutInputs = { die: 6, returnDie: 3 }
    expect(store.breakoutNow(trapped.instanceId)).toBe(true)
    expect(store.breakoutReturns.map((entry) => entry.unit.instanceId)).toContain(
      trapped.instanceId,
    )
    expect(store.deadPile.some((unit) => unit.instanceId === trapped.instanceId)).toBe(false)
    expect(store.units.some((unit) => unit.instanceId === trapped.instanceId)).toBe(false)

    // 留痕：会话日志里有这次突围（骰值可复算）
    expect(store.log.some((line) => line.text.includes('突围成功'))).toBe(true)
  })

  it('★ 可玩通：返场受回合限制，到回合后按增援入场规则放回', () => {
    const store = newStore()
    const { trapped } = enterBreakoutWith(store)

    store.breakoutInputs = { die: 6, returnDie: 2 }
    expect(store.breakoutNow(trapped.instanceId)).toBe(true)
    const entry = store.breakoutReturns.find((item) => item.unit.instanceId === trapped.instanceId)!
    expect(entry.returnsOnTurn).toBe(store.turn + 2)

    // 回合未到 ⇒ 拒绝返场
    expect(store.deployBreakoutReturnNow(trapped.instanceId, '1.1')).toBe(false)

    // 回合到 + 落点不是本方入场格 ⇒ 仍拒绝（按增援入场规则，12.8e / 13.6b）
    store.setTurn(entry.returnsOnTurn)
    expect(store.deployBreakoutReturnNow(trapped.instanceId, '1.1')).toBe(false)
    // 被拒 ⇒ 盘面不动：仍在待返场清单里、仍未上盘（不做半截操作）
    expect(store.breakoutReturns.map((item) => item.unit.instanceId)).toContain(trapped.instanceId)
    expect(store.units.some((unit) => unit.instanceId === trapped.instanceId)).toBe(false)
  })
})
