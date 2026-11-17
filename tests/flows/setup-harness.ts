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
  // 第一段：确认初设（只收束，不建会话）；无 effects 的剧本这里直接开局
  if (!setup.finished) expect(setup.startGameNow(), setup.lastAction?.detail).toBe(true)
  /*
   * 两段式（规格 §4.1）：先「完成初设」只确认；本剧本未执行的 `setup.effects`
   * 由随后的唯一入口「抽取编队」（`drawSetupEffectsNow`）执行并开局。
   * ★ 负向用例用 `{ draws: false }` 把这一步留给用例自己。
   */
  if (draws && setup.setupDrawEntryVisible) {
    expect(setup.drawSetupEffectsNow(), setup.lastAction?.detail).toBe(true)
  }
}
