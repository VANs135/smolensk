import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { aircraftChoices, useWorkbenchStore } from '@/stores'

import { airBaseRecord, placeAir, placeGround, type Workbench } from '../flows/sop-harness'

/**
 * 裁定 2 的规格用例（用户 2026-11-13，**待实现／先红**）：
 * 增援掷骰出特殊补给时直接入图外空军盒 SP 容器 + 提示「有补给进入图外盒」；
 * 盒内可见；后续用空军任务运进地图。复用 `offMapSupplyStocks`，不新造第二套账。
 *
 * ★ 新方法名是**提案 API**；落地改名时同步本文件。
 */
interface OffMapSpSpec {
  depositOffMapSupplyNow(side: 'axis' | 'soviet', t: number): boolean
  airBoxSupply(side: 'axis' | 'soviet'): { sp: number; t: number } | null
}

const spec = (store: Workbench): OffMapSpSpec => store as unknown as OffMapSpSpec

function airBaseStore(): Workbench {
  const w = useWorkbenchStore()
  w.setPhase('movement')
  w.setSegmentStepIndex(
    w.playerSegmentSteps.findIndex((step) => step.id === 'movement.modeAndMovement'),
  )
  placeGround(w, airBaseRecord(1), { col: 15, row: 10 }, 'axis', 'base')
  placeGround(w, airBaseRecord(1), { col: 15, row: 11 }, 'axis', 'destination')
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('裁定 2：特殊补给入图外空军盒', () => {
  it('入盒后有库存、有提示、盒内可见', () => {
    const w = airBaseStore()
    const before = w.offMapSupplyStocks['axis:axis']?.t ?? 0

    expect(spec(w).depositOffMapSupplyNow('axis', 1)).toBe(true)

    expect(w.offMapSupplyStocks['axis:axis']?.t ?? 0).toBe(before + 1)
    expect(w.log.some((entry) => entry.text.includes('图外'))).toBe(true)
    // 界面投影：盒里能看见 SP
    expect(spec(w).airBoxSupply('axis')).toMatchObject({ t: before + 1 })
  })

  it('入盒后可用空运任务运进地图，并从盒内账本扣账', () => {
    const w = airBaseStore()
    expect(spec(w).depositOffMapSupplyNow('axis', 1)).toBe(true)
    const before = w.offMapSupplyStocks['axis:axis']?.t ?? 0

    const aircraft = aircraftChoices('axis').find((record) => (record.transportCapacity ?? 0) > 0)!
    placeAir(w, aircraft, { col: 15, row: 10 }, 'axis', 'transport')
    w.airUnits[0]!.transportCapacity = 1
    w.airUnits[0]!.transportCapacityBack = 0.5
    w.setAirInBoxMembership('transport', true)
    w.setAirActive(true)
    w.setAirMissionKind('air_transport')
    w.setAirTargetFromText('15.11')
    w.toggleAirMissionUnit('transport')
    w.airInputs.cargoSpT = 1

    expect(w.beginAirMissionNow()).toBe(true)
    expect(w.offMapSupplyStocks['axis:axis']?.t ?? 0).toBe(before - 1)
  })
})
