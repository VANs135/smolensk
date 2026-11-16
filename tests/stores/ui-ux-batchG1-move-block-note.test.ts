import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import { areAdjacent, neighbor } from '@/engine/hex-geometry'
import { useMapViewStore, useSetupStore } from '@/stores'

import {
  CORE_HEX,
  NEAR_HEX,
  groundRecord,
  newConsole,
  placeGround,
  type Workbench,
} from '../flows/sop-harness'

/**
 * G1（用户 2026-11-17 实走）：**选中却零高亮，必须就地说明原因**
 *
 * 实走现场：G 进击段选中无燃料的履带单位 ⇒ 地图 0 高亮，面板仍写
 * 「已选 1 枚 · 点地图高亮格开拔」，顶部提示仍教「点己方算子＝显示可移动范围」——
 * 点了没反应，也没有一句解释。
 *
 * 口径（双向）：
 *   · 引擎已给的 `blocked`（12.5a 未加油 / 4.5b 已承诺 / 6.1b 无 MA）就近显示；
 *   · 单位能动但四周一个可进入的格都没有 ⇒ 说「四周没有可进入的格」；
 *   · 点超范围格的原因要分开（未加油 / 地形不可进 / MA 不足），不再一律「不在可到达范围内」。
 */

const TRACK = () =>
  groundRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      record.classes?.movementClass === 'tracked' &&
      (record.factors?.combat?.ma ?? 0) >= 2,
  )

const LEG = () =>
  groundRecord(
    'axis',
    (record) => record.isCombat === true && record.classes?.movementClass === 'leg',
  )

function enterMovement(): Workbench {
  const wb = newConsole()
  useSetupStore().finished = true
  wb.setActiveSide('axis')
  wb.setPhase('movement')
  return wb
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('G1：零高亮的双向原因', () => {
  it('未加油的履带单位：blocked(12.5a) 就近显示，提示不再教「点高亮格」', () => {
    const wb = enterMovement()
    const mapView = useMapViewStore()
    const unit = placeGround(wb, TRACK(), CORE_HEX, 'axis', 'g1-track')
    unit.fuelled = false

    wb.clickHex(CORE_HEX)

    expect(wb.movePick?.ids).toEqual(['g1-track'])
    expect(wb.groupReachable.hexes).toHaveLength(0)
    expect(wb.movePickBlockNote?.rule).toBe('12.5a')
    expect(wb.movePickBlockNote?.text).toContain('未加注燃料')
    expect(mapView.actionHint).toContain('进不了格')
    expect(mapView.actionHint).toContain('12.5a')
    expect(mapView.actionHint).not.toContain('点己方算子＝显示可移动范围')
  })

  it('能动但四周全被敌军占据：给「四周没有可进入的格」', () => {
    const wb = enterMovement()
    const unit = placeGround(wb, LEG(), CORE_HEX, 'axis', 'g1-leg')
    expect(unit.fuelled).toBe(false)
    for (const direction of ['N', 'NE', 'SE', 'S', 'SW', 'NW'] as const) {
      placeGround(wb, LEG(), neighbor(CORE_HEX, direction), 'soviet', `g1-enemy-${direction}`)
    }

    wb.clickHex(CORE_HEX)

    expect(wb.groupReachable.hexes).toHaveLength(0)
    expect(wb.movePickBlockNote?.text).toContain('四周没有可进入的格')
  })

  it('点相邻却进不去的格：拒绝原因落到真实判据（未加油），不是笼统「不在范围」', () => {
    const wb = enterMovement()
    const unit = placeGround(wb, TRACK(), CORE_HEX, 'axis', 'g1-click')
    unit.fuelled = false
    wb.clickHex(CORE_HEX)
    expect(areAdjacent(CORE_HEX, NEAR_HEX)).toBe(true)

    wb.clickHex(NEAR_HEX)

    expect(wb.moveBlocked).not.toBeNull()
    expect(wb.moveBlocked!.reason).toContain('未加注燃料')
    expect(wb.moveBlocked!.reason).not.toBe(
      '该格不在所选单位的可到达范围内（6.1）：点地图高亮格开拔',
    )
  })

  it('点范围外的空格：原因落到「MA 不足 / 地形不可进」，不再是旧那句笼统话', () => {
    const wb = enterMovement()
    placeGround(wb, LEG(), CORE_HEX, 'axis', 'g1-far')
    wb.clickHex(CORE_HEX)
    const target = wb.groupReachable.hexes
      .flatMap((node) =>
        (['N', 'NE', 'SE', 'S', 'SW', 'NW'] as const).map((d) => neighbor(node.hex, d)),
      )
      .find(
        (hex) =>
          // 必须图内、且不是本单位所在格（点自己＝换选，不是「走不进」）
          mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row) &&
          !(hex.col === CORE_HEX.col && hex.row === CORE_HEX.row) &&
          !wb.groupReachable.hexes.some(
            (node) => node.hex.col === hex.col && node.hex.row === hex.row,
          ),
      )
    expect(target).toBeDefined()

    wb.clickHex(target!)

    expect(wb.moveBlocked).not.toBeNull()
    expect(wb.moveBlocked!.reason).toMatch(/MA 不足|地形不可进/)
  })
})
