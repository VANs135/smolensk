import { expect } from 'vitest'
import type { useSetupStore } from '@/stores'

/** 正向开局夹具走正式卡车点图和双方确认；普通未摆单位仍由测试玩家主动放弃。 */
export function confirmSetupForStart(
  setup: ReturnType<typeof useSetupStore>,
  // 负向用例（要观察抽取执行失败/待办）用 `{ draws: false }` 只确认、把自动抽取留给用例自己触发
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
  /*
   * † 整堆默认落原文格（可超 10 RE）⇒ 开局前测试玩家在盘面把超限格散开。
   * 与真人操作同源：`beginStackDisperse` + `moveStackUnit`（IV-A / 10 RE）。
   */
  for (let n = 0; n < 500 && setup.overStackedHexes.length > 0; n += 1) {
    const over = setup.overStackedHexes[0]!
    const id = over.movableIds[0]
    if (id === undefined) break
    if (!setup.beginStackDisperse(id)) break
    let moved = false
    for (const hex of setup.stackDisperse?.candidates ?? []) {
      if (setup.moveStackUnit(id, hex)) {
        moved = true
        break
      }
    }
    if (!moved) break
  }
  for (let guard = 0; setup.setupSideCursor !== null && guard < 2; guard++)
    expect(setup.confirmSideSetup()).toBe(true)
  expect(setup.setupSideCursor).toBeNull()
  // 初设收束：有 `setup.effects` 的剧本在**同一次点击**里自动抽签 + 处置 + 开局
  if (!setup.finished) {
    expect(setup.startGameNow({ autoDraw: draws }), setup.lastAction?.detail).toBe(true)
  } else if (draws && setup.setupDrawEntryVisible) {
    // 已确认但未抽签（旧档/前述用例留下的状态）⇒ 仍可程序化补做
    expect(setup.drawSetupEffectsNow(), setup.lastAction?.detail).toBe(true)
  }
}
