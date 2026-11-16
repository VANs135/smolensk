import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import { useSetupStore } from '@/stores'

import { CORE_HEX, groundRecord, newConsole, placeGround } from '../flows/sop-harness'

/**
 * H1（用户 2026-11-17 实走）：**拒绝文案不得跨段存活**
 *
 * 实走现场：D 补给段点单位（只想查看）被当成移动拒绝，红字
 * 「2.2 这一步被拒：D 补给段没有移动环节，不能移动」；
 * 一路推进到 H「回合结束」，这行红字仍挂在状态条上。
 *
 * G2 只清了「换选成功」；本批补上换阶段 / 换环节 / 换方 / 换回合四个入口，
 * 与既有 `resetSegmentTransient`（lastStep / pendingHexPick 等）同口径。
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

/** 摆一个敌方占据格并点它：得到一条真实的拒绝（moveBlocked） */
function rejected(
  wb: ReturnType<typeof newConsole>,
  occupied: { col: number; row: number }[] = [],
): void {
  const hex = mapLayers.hexes.find(
    (item) =>
      item.col !== CORE_HEX.col &&
      item.row !== CORE_HEX.row &&
      !occupied.some((o) => o.col === item.col && o.row === item.row),
  )
  if (hex === undefined) throw new Error('找不到可点格')
  const target = { col: hex.col, row: hex.row }
  placeGround(wb, LEG(), target, 'soviet', `h1-enemy-${target.col}-${target.row}`)
  wb.clickHex(CORE_HEX)
  wb.clickHex(target)
  expect(wb.moveBlocked).not.toBeNull()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('H1：换段/换环节/换方/换回合都清拒绝', () => {
  it('换阶段清掉 moveBlocked', () => {
    const wb = enterMovement()
    placeGround(wb, LEG(), CORE_HEX, 'axis', 'h1-a')
    rejected(wb, [CORE_HEX])

    wb.setPhase('supply')

    expect(wb.moveBlocked).toBeNull()
  })

  it('段内换环节清掉 moveBlocked', () => {
    const wb = enterMovement()
    placeGround(wb, LEG(), CORE_HEX, 'axis', 'h1-b')
    rejected(wb, [CORE_HEX])
    expect(wb.playerSegmentSteps.length).toBeGreaterThan(1)

    expect(wb.setSegmentStepIndex(wb.playerSegmentSteps.length - 1)).toBe(true)

    expect(wb.moveBlocked).toBeNull()
  })

  it('换方清掉 moveBlocked', () => {
    const wb = enterMovement()
    placeGround(wb, LEG(), CORE_HEX, 'axis', 'h1-c')
    rejected(wb, [CORE_HEX])

    wb.setActiveSide('soviet')

    expect(wb.moveBlocked).toBeNull()
  })

  it('换回合清掉 moveBlocked', () => {
    const wb = enterMovement()
    placeGround(wb, LEG(), CORE_HEX, 'axis', 'h1-d')
    rejected(wb, [CORE_HEX])
    const turn = wb.turn

    wb.setTurn(turn + 1)

    expect(wb.moveBlocked).toBeNull()
  })
})
