import { expect } from 'vitest'
import type { useSetupStore } from '@/stores'

/** 正向开局夹具走正式卡车点图和双方确认；普通未摆单位仍由测试玩家主动放弃。 */
export function confirmSetupForStart(setup: ReturnType<typeof useSetupStore>): void {
  if (setup.finished) return
  if (setup.requiredSetupIssues.some((issue) => issue.id === 'spOwnership'))
    expect(setup.confirmSpOwnership()).toBe(true)
  if (setup.truckLoadSummary.mode === 'choose_loaded' && !setup.truckLoadSummary.done) {
    expect(setup.beginTruckPick()).toBe(true)
    const seen = new Set<string>()
    for (const row of setup.truckPickRows) {
      const key = `${row.hex.col}.${row.hex.row}`
      if (seen.has(key) || row.full) continue
      seen.add(key)
      expect(setup.pickTruckAtHex(row.hex)).toBe(true)
      if (setup.truckLoadSummary.done) break
    }
    expect(setup.truckLoadSummary.done).toBe(true)
    setup.cancelTruckPick()
  }
  for (let guard = 0; setup.setupSideCursor !== null && guard < 2; guard++)
    expect(setup.confirmSideSetup()).toBe(true)
  expect(setup.setupSideCursor).toBeNull()
}
