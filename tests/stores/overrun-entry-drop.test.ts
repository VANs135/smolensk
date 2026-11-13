import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * 8.1b 混合堆叠「落下」的记账（用户 2026-11-13 裁定）
 *
 * 逐单位算进格费后，进格费不够（>3 MP / 禁入 / All / 违反 6.1d 对等）的成员：
 *   · 留在原格、不参突；
 *   · 视同本次移动已经动完（`movementEnded = true`），剩余 MP 不可再用；
 *   · 不扣 3 MP（它没有突袭）；
 *   · 撤销上一步后由 `before` 快照把 `ended` 恢复，玩家可撤回后单独移动它。
 *
 * 夹具用 Swamp：履带在无路 Swamp 为禁入（P），步行 3 MP ⇒ 同一格一个能进、一个不能。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}
type Store = ReturnType<typeof newStore>
type UnitRecord = ReturnType<typeof unitChoices>[number]

const terrainAt = (hex: HexRef): string | undefined =>
  mapLayers.hexes.find((item) => item.col === hex.col && item.row === hex.row)?.movementTerrain
const onMap = (hex: HexRef): boolean =>
  mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row)

/** 找 Swamp 目标 Y，及其两个相邻且互相相邻的非沼泽格 X（起点）→ W（走一步后的格） */
function swampTriangle(): { start: HexRef; step: HexRef; target: HexRef } {
  for (const entry of mapLayers.hexes) {
    if (entry.movementTerrain !== 'Swamp') continue
    const target: HexRef = { col: entry.col, row: entry.row }
    const around = HEX_DIRECTIONS.map((direction) => neighbor(target, direction))
      .filter((hex) => isOnMap(hex) && onMap(hex))
      .filter((hex) => terrainAt(hex) === 'Open')
    for (const start of around)
      for (const step of around) {
        if (hexDistance(start, step) !== 1) continue
        return { start, step, target }
      }
  }
  throw new Error('地图上没有可用的 Swamp 三角形')
}

function place(
  store: Store,
  record: UnitRecord,
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
) {
  const unit = toConsoleUnit({ record, instanceId, hex: { ...hex }, side })
  store.units.push(unit)
  return unit
}

function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: UnitRecord) => boolean,
): UnitRecord {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

describe('8.1b 落下：留原格 + 本次移动结束', () => {
  let store: Store
  const { start, step, target } = swampTriangle()

  beforeEach(() => {
    store = newStore()
    store.resetAll(23)
  })

  function setup() {
    const leg = place(
      store,
      pickRecord(
        'axis',
        (record) =>
          record.id === 'ax-infantry-ge-78-inf-div' &&
          record.attackCapable === true &&
          record.classes?.movementClass === 'leg',
      ),
      start,
      'axis',
      'drop-leg',
    )
    const tank = place(
      store,
      pickRecord(
        'axis',
        (record) =>
          record.attackCapable === true &&
          record.isCombat === true &&
          record.classes?.movementClass === 'tracked' &&
          (record.factors?.combat?.ma ?? 0) >= 6,
      ),
      start,
      'axis',
      'drop-tank',
    )
    tank.fuelled = true
    const defender = place(
      store,
      pickRecord(
        'soviet',
        (record) => record.isCombat === true && (record.factors?.combat?.attack ?? 0) <= 2,
      ),
      target,
      'soviet',
      'drop-def',
    )
    expect(defender.side).toBe('soviet')

    store.setPhase('movement')
    const index = store.playerSegmentSteps.findIndex(
      (item) => item.id === 'movement.modeAndMovement',
    )
    if (index >= 0) store.setSegmentStepIndex(index)
    store.setTool('move')
    store.setFuelPool(0, 60)
    store.beginMovePick(start, [leg.instanceId, tank.instanceId])
    expect(store.confirmMovePick()).toBe(true)
    // 先走一步到 W（仍有 1 步可撤）；W 与 Swamp 目标相邻，履带在此后进格时被落下
    store.clickHex(step)
    expect(store.moveInteraction?.steps).toHaveLength(1)
    return { leg, tank }
  }

  it('落下者不参突、movementEnded=true、MP 未扣，且剩余 MP 不可再用（6.1g）', () => {
    const { leg, tank } = setup()
    const tankMpAfterStep = tank.mpSpent
    expect(tankMpAfterStep).toBeGreaterThan(0)

    expect(store.overrunNow(target)).toBe(true)
    expect(store.combatState).not.toBeNull()
    // 参突名单只有 leg；履带被 8.1b 落下
    expect(store.combatAttackerIds).toEqual([leg.instanceId])
    expect(tank.movementEnded).toBe(true)
    expect(tank.hex).toEqual(step)
    expect(tank.mpSpent).toBe(tankMpAfterStep)
    const dropLog = store.log.find((entry) => entry.text.includes('8.1b'))
    expect(dropLog?.text).toContain('本次移动结束')

    // 放弃本场战斗（尚未提交补给，9.2 允许）后，落下者的剩余 MP 仍不可用
    store.cancelCombat()
    expect(store.combatState).toBeNull()
    store.finishMove()
    const index = store.playerSegmentSteps.findIndex(
      (item) => item.id === 'movement.modeAndMovement',
    )
    if (index >= 0) store.setSegmentStepIndex(index)
    // 已结束的单位不进「可开拔池」：取子直接为空，确认必然失败（UI 层就是不可再选；
    // 若绕过池把 ended 单位塞进开拔集，引擎按 6.1g 拒，见 move-interaction.ts L143）
    store.beginMovePick(step, [tank.instanceId])
    expect(store.movePick).toBeNull()
    expect(store.confirmMovePick()).toBe(false)
  })

  it('撤回到移动前：履带 ended 回 false、回起点，随后可单独走一格', () => {
    const { leg, tank } = setup()
    expect(store.overrunNow(target)).toBe(true)
    expect(tank.movementEnded).toBe(true)
    store.cancelCombat()

    store.undoLastStep()
    expect(tank.movementEnded).toBe(false)
    expect(leg.movementEnded).toBe(false)
    expect(tank.hex).toEqual(start)
    expect(leg.hex).toEqual(start)
    expect(tank.mpSpent).toBe(0)
    expect(store.moveInteraction?.steps).toHaveLength(0)

    // 撤回后可单独移动履带
    store.beginMovePick(start, [tank.instanceId])
    expect(store.confirmMovePick()).toBe(true)
    const destination = store.groupReachable.hexes[0]
    expect(destination).toBeDefined()
    store.clickHex(destination!.hex)
    expect(tank.hex).toEqual(destination!.hex)
    expect(tank.movementEnded).toBe(false)
  })
})
