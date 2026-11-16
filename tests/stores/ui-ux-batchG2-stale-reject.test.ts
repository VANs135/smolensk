import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import { neighbor } from '@/engine/hex-geometry'
import { useSetupStore } from '@/stores'

import { CORE_HEX, NEAR_HEX, groundRecord, newConsole, placeGround } from '../flows/sop-harness'

/**
 * G2（用户 2026-11-17 实走）：**换选成功即清掉旧拒绝**
 *
 * 实走现场：先点一个走不进的空格 ⇒ 顶部红字「这一步被拒：该格不在所选单位的可到达范围内」；
 * 随后点另一支己方堆叠（合法、已铺开 8 个高亮），红字仍挂在状态条上，指向**已经不存在的意图**。
 * 口径：红字只描述「当前这一步」；选中/换选成功就必须清掉。
 */

const LEG = () =>
  groundRecord(
    'axis',
    (record) => record.isCombat === true && record.classes?.movementClass === 'leg',
  )

function enterMovement() {
  const wb = newConsole()
  useSetupStore().finished = true
  wb.setActiveSide('axis')
  wb.setPhase('movement')
  return wb
}

/** 一个图内、远离起点、无己方算子的格（放敌方单位 ⇒ 点它必被拒） */
function rejectHex(occupied: { col: number; row: number }[]): { col: number; row: number } {
  for (const hex of mapLayers.hexes) {
    const ref = { col: hex.col, row: hex.row }
    if (occupied.some((item) => item.col === ref.col && item.row === ref.row)) continue
    // 至少 3 格远：避开「相邻可达格」
    if (Math.abs(ref.col - CORE_HEX.col) + Math.abs(ref.row - CORE_HEX.row) < 3) continue
    return ref
  }
  throw new Error('地图上找不到空白远格')
}

/** 摆一个敌方算子并返回其格：点敌方占据格必被 6.3b 拒 */
function enemyHex(
  wb: ReturnType<typeof newConsole>,
  id: string,
  occupied: { col: number; row: number }[],
): { col: number; row: number } {
  const hex = rejectHex(occupied)
  placeGround(wb, LEG(), hex, 'soviet', id)
  return hex
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('G2：换选后旧拒绝不残留', () => {
  it('先被拒、再点另一支己方堆叠：选中换过去，红字必须清空', () => {
    const wb = enterMovement()
    placeGround(wb, LEG(), CORE_HEX, 'axis', 'g2-a')
    placeGround(wb, LEG(), NEAR_HEX, 'axis', 'g2-b')

    wb.clickHex(CORE_HEX)
    expect(wb.movePick?.ids).toEqual(['g2-a'])

    wb.clickHex(enemyHex(wb, 'g2-enemy-a', [CORE_HEX, NEAR_HEX]))
    expect(wb.moveBlocked).not.toBeNull()

    wb.clickHex(NEAR_HEX)

    expect(wb.movePick?.ids).toEqual(['g2-b'])
    expect(wb.moveBlocked).toBeNull()
  })

  it('地图点单枚换选同样清掉旧拒绝', () => {
    const wb = enterMovement()
    placeGround(wb, LEG(), CORE_HEX, 'axis', 'g2-c')
    const other = neighbor(CORE_HEX, 'NE')
    // 换选目标必须图内；不满足就换 SE
    const target = mapLayers.hexes.some((h) => h.col === other.col && h.row === other.row)
      ? other
      : neighbor(CORE_HEX, 'SE')
    placeGround(wb, LEG(), target, 'axis', 'g2-d')

    wb.clickHex(CORE_HEX)
    wb.clickHex(enemyHex(wb, 'g2-enemy-b', [CORE_HEX, target]))
    expect(wb.moveBlocked).not.toBeNull()

    wb.clickHex(target)

    expect(wb.movePick?.ids).toEqual(['g2-d'])
    expect(wb.moveBlocked).toBeNull()
  })
})
