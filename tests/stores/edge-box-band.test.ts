import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'

import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useContainersStore,
  useWorkbenchStore,
} from '@/stores'
import type { ConsoleUnit } from '@/stores'

/**
 * 专规 1.4b：**边缘盒「入盒带」**（2026-11-26 用户第 2 条）
 *
 * 口径：带只长在合法格上（`edgeBoxConnectsHex ∩ 开放补给源`），一格一段；
 * 段方向＝东北接北缘、东南接南缘、两者都接东缘（东缘优先）；
 * 点带 ⇒ 把**站在该格的那一枚**送进盒，费用二选一（1 MP / 1 铁路运力）。
 *
 * 用真实地图/单位库（不造数）；规则判据本身在 `tests/engine/containers.test.ts`。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), containers: useContainersStore() }
}

/** 苏方的 12-2-2 步兵师（边缘盒唯一允许的「苏军地面单位」） */
function sovietDivision(): ReturnType<typeof unitChoices>[number] {
  const record = unitChoices('soviet').find(
    (item) =>
      item.factors?.combat?.attack === 12 &&
      item.factors?.combat?.ar === 2 &&
      item.factors?.combat?.ma === 2,
  )
  if (record === undefined) throw new Error('单位库里找不到 12-2-2 的苏方师')
  return record
}

function place(
  workbench: ReturnType<typeof useWorkbenchStore>,
  hex: HexRef,
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({
    record: sovietDivision(),
    instanceId,
    hex,
    side: 'soviet',
  })
  workbench.units.push(unit)
  return unit
}

/** 进入允许 `move.order` 的环节（1.4b 只在 Movement Phase 的移动段内成立） */
function openMovementStep(workbench: ReturnType<typeof useWorkbenchStore>): void {
  const allowed = actionGateOf('move.order')
    .where.filter((item) => item.phase === workbench.phase)
    .map((item) => item.segment)
  const index = workbench.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error('该段没有允许 move.order 的环节')
  if (!workbench.setSegmentStepIndex(index)) throw new Error('进入环节失败（move.order）')
}

describe('1.4b 入盒带', () => {
  let workbench: ReturnType<typeof useWorkbenchStore>
  let containers: ReturnType<typeof useContainersStore>

  beforeEach(() => {
    const stores = newStores()
    workbench = stores.workbench
    containers = stores.containers
    workbench.setScenarioId('1')
    workbench.setActiveSide('soviet')
    workbench.setPhase('movement')
  })

  it('东缘源格：两个盒都长带，方向＝east（东缘优先）', () => {
    const unit = place(workbench, { col: 62, row: 35 }, 'ru-band')
    openMovementStep(workbench)

    const seats = containers.edgeBoxBandSeats
    const mine = seats.filter((seat) => seat.hex.col === 62 && seat.hex.row === 35)
    expect(mine.map((seat) => seat.box)).toEqual(['northeast', 'southeast'])
    expect(mine.every((seat) => seat.side === 'east')).toBe(true)
    expect(mine.every((seat) => seat.units.includes(unit.instanceId))).toBe(true)
  })

  it('北缘源格：只有东北盒接，方向＝north', () => {
    const unit = place(workbench, { col: 20, row: 35 }, 'ru-north')
    openMovementStep(workbench)

    const seats = containers.edgeBoxBandSeats.filter(
      (seat) => seat.hex.col === 20 && seat.hex.row === 35,
    )
    expect(seats.map((seat) => seat.box)).toEqual(['northeast'])
    expect(seats[0]?.side).toBe('north')
    expect(seats[0]?.units).toEqual([unit.instanceId])
  })

  it('非开放源格 / 非苏方 / 非移动阶段：带不为其长（其余合法格仍是灰虚线）', () => {
    place(workbench, { col: 34, row: 17 }, 'ru-inland')
    openMovementStep(workbench)
    // 内陆格不接任何边缘盒 ⇒ 该格没有带
    expect(
      containers.edgeBoxBandSeats.filter((seat) => seat.hex.col === 34 && seat.hex.row === 17),
    ).toEqual([])

    workbench.setActiveSide('axis')
    expect(containers.edgeBoxBandSeats).toEqual([])

    workbench.setActiveSide('soviet')
    workbench.setPhase('exploitation')
    expect(containers.edgeBoxBandSeats).toEqual([])
  })

  it('点带入盒（1 MP）：扣 1 MP、进入即停、从图上移除', () => {
    const unit = place(workbench, { col: 62, row: 35 }, 'ru-enter')
    openMovementStep(workbench)

    expect(
      containers.enterEdgeBoxAtHex({
        box: 'southeast',
        hex: { col: 62, row: 35 },
        useRailCap: false,
      }),
    ).toBe(true)
    expect(workbench.units).toHaveLength(0)
    expect(containers.edgeBoxHeld.southeast[0]).toMatchObject({ mpSpent: 1, movementEnded: true })
    // 带随之消失（该格没人站着了 ⇒ 该盒这一段不再有 units）
    const seats = containers.edgeBoxBandSeats.filter(
      (seat) => seat.hex.col === 62 && seat.hex.row === 35 && seat.box === 'southeast',
    )
    expect(seats[0]?.units).toEqual([])
    expect(unit.instanceId).toBe('ru-enter')
  })

  it('没有单位站着的带：点击被拒（不静默入盒）', () => {
    expect(
      containers.enterEdgeBoxAtHex({
        box: 'southeast',
        hex: { col: 62, row: 35 },
        useRailCap: false,
      }),
    ).toBe(false)
    expect(containers.lastAction?.ok).toBe(false)
  })
})
