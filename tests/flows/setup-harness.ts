import { expect } from 'vitest'
import type { useSetupStore } from '@/stores'

/** 正向开局夹具走正式卡车点图和双方确认；普通未摆单位仍由测试玩家主动放弃。 */
export function confirmSetupForStart(
  setup: ReturnType<typeof useSetupStore>,
  // 负向用例（要观察抽取入口失败）用 `{ draws: false }` 把「点抽取编队」留给用例自己
  { draws = true }: { draws?: boolean } = {},
): void {
  if (setup.finished) return
  if (setup.requiredSetupIssues.some((issue) => issue.id === 'spOwnership')) {
    // 3.4b：初设归属不再按分界线预填，夹具按玩家身份逐站选一个合法集群。
    for (const dump of setup.spDumpsOf('axis')) setup.setSpAssignment(dump.id, 'hoth')
    expect(setup.confirmSpOwnership()).toBe(true)
  }
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
  // ★ 用户 2026-11-10：抽取编队只有「抽取编队」按钮一个入口，开局不再隐式兜底 ⇒ 夹具按正向路径点一次
  if (draws && setup.setupDrawEntryVisible) {
    expect(setup.executeSetupDraws(), setup.lastAction?.detail).toBe(true)
  }
}
