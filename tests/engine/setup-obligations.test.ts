import { describe, expect, it } from 'vitest'
import { assessSetupTruckLoad, pendingSetupObligations, SP_TO_T } from '@/engine/rules'

const trucks = ['a', 'b', 'c', 'd', 'e'].map((instanceId) => ({ instanceId, unitId: instanceId }))
const request = { scenarioId: '3', trucks, fullInstanceIds: ['a', 'b', 'c', 'd'] }
const loads = trucks.map((truck) => ({
  instanceId: truck.instanceId,
  loadedSpT: truck.instanceId === 'e' ? 0 : SP_TO_T,
}))

describe('IV-D/13.2h：初设满载选择与载货核对', () => {
  it('剧本3的四辆满载及其余空载均已实际落账，才算完成', () => {
    expect(assessSetupTruckLoad(request, loads).complete).toBe(true)
  })
  it('同样选四辆但选中对象改变，原载货不能充当新名单的完成证据', () => {
    expect(
      assessSetupTruckLoad({ ...request, fullInstanceIds: ['a', 'b', 'c', 'e'] }, loads).complete,
    ).toBe(false)
  })
  it('少一辆、多一辆或重复选择都不能用放弃普通单位的口径消除', () => {
    for (const fullInstanceIds of [
      ['a', 'b', 'c'],
      ['a', 'b', 'c', 'd', 'e'],
      ['a', 'a', 'b', 'c'],
    ])
      expect(assessSetupTruckLoad({ ...request, fullInstanceIds }, loads).complete).toBe(false)
  })
  it('任一未选车辆有载货或缺少载货事实，也不能确认', () => {
    expect(
      assessSetupTruckLoad(
        request,
        loads.map((row) => (row.instanceId === 'e' ? { ...row, loadedSpT: 1 } : row)),
      ).complete,
    ).toBe(false)
    expect(
      assessSetupTruckLoad(
        request,
        loads.map((row) => (row.instanceId === 'a' ? { ...row, loadedSpT: null } : row)),
      ).complete,
    ).toBe(false)
  })
})

describe('ch10/ch11/初设流程：必做事项投影', () => {
  it('已有西移待办时不重复报整组缺回执，保留满载及当前方确认义务', () => {
    const issues = pendingSetupObligations({
      shifts: [{ formationId: '3 Pz Div' }],
      draws: [{ kind: 'shiftWest', applied: false, reason: '尚未完成处置' }],
      truck: assessSetupTruckLoad({ ...request, fullInstanceIds: [] }, loads),
      cursor: 'axis',
    })
    expect(issues.map((issue) => issue.id)).toEqual([
      'shift:3 Pz Div',
      'truckLoad',
      'sideConfirmation',
    ])
    expect(issues.every((issue) => issue.side === 'axis')).toBe(true)
  })
  it('抽签处置、真实载货及双方确认均完成后，必做清单为空', () => {
    expect(
      pendingSetupObligations({
        shifts: [],
        draws: [{ kind: 'mtrAufkSwap', applied: true, reason: null }],
        truck: assessSetupTruckLoad(request, loads),
        cursor: null,
      }),
    ).toEqual([])
  })
})
