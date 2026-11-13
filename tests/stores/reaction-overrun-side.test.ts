import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'

import { groundRecord, newConsole, placeGround } from '../flows/sop-harness'

/**
 * 7.0a / 8.0：**反应阶段**的突袭，敌我按「非阶段玩家 vs 阶段玩家」分
 *
 * 反应段的行动者是非阶段玩家（6.3a / 7.0a），`activeSide` 仍是阶段玩家。
 * 修前 `overrunTargets` / `pickOverrunParticipants` / `overrunNow` / `overrunSplitNow`
 * 都用 `activeSide` 当"我方"：
 *   · 紫环把**阶段玩家**的守军滤掉 ⇒ 反应段一个突袭目标都列不出来；
 *   · `overrunNow` 的 `defenders` 取 `side !== activeSide` ⇒ 把攻方自己的单位当守方（或守方为空）。
 * 结果是 7.0b「轰炸和突袭的结算照常」在反应段完全走不通。
 */

const START: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

const onMapNeighbors = (): HexRef[] =>
  HEX_DIRECTIONS.map((direction) => neighbor(START, direction)).filter(
    (candidate) =>
      isOnMap(candidate) &&
      mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row),
  )

const sovietMover = () =>
  groundRecord(
    'soviet',
    (record) => record.attackCapable === true && (record.factors?.combat?.ma ?? 0) >= 6,
  )

const axisDefender = () => groundRecord('axis', (record) => record.isCombat === true)

describe('7.0a / 8.0：反应阶段突袭的敌我归属', () => {
  it('已释放预备（3 MP）可突袭相邻的阶段玩家单位；守方名单是该轴心单位', () => {
    const store = newConsole()
    // 专规 1.5：剧本首回合苏军地面单位半 MA ⇒ 换到第 2 回合，单看 5.7b-B 的 1/2
    store.setTurn(2)
    store.setPhase('reaction') // activeSide 缺省 axis ⇒ 反应段行动方是苏军
    const unit = placeGround(store, sovietMover(), START, 'soviet', 'su-ov')
    unit.mode = { mode: 'reserve', orientation: 'combat', dg: false, exploit: false }
    // 12.5a：轮式/履带单位耗 MP 前须已加注（本用例只看突袭资格）
    unit.fuelled = true

    // 条 10（批 M）：点格建取子清单，释放后自动开拔
    store.clickHex(START)
    expect(store.releaseReserveNow()).toBe(true)
    expect(store.moveInteraction).not.toBeNull()

    // 六邻都摆阶段玩家的守军；地形/进格费不合格的格由引擎（8.1b）自行剔除
    const record = axisDefender()
    const defenders = new Map<string, string>()
    for (const hex of onMapNeighbors()) {
      const placed = placeGround(store, record, hex, 'axis', `ax-d-${hex.col}-${hex.row}`)
      defenders.set(`${hex.col}.${hex.row}`, placed.instanceId)
    }

    // 修前：targets 恒为空（守军被 `side !== activeSide` 滤掉）
    expect(store.overrunTargets.length).toBeGreaterThan(0)
    const target = store.overrunTargets[0]!.hex
    const defenderId = defenders.get(`${target.col}.${target.row}`)
    expect(defenderId).toBeDefined()

    expect(store.overrunNow(target)).toBe(true)
    expect(store.combatState?.attackType).toBe('overrun')
    expect(store.combatState?.composition.defenderIds).toEqual([defenderId])
  })
})
