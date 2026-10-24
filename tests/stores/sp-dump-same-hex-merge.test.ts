import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { createMemoryStorage } from '@/shared'
import { useGameSessionStore, useWorkbenchStore } from '@/stores'

/**
 * 12.1b / §5-C：**同格同方只有一条 SP 账本**
 *
 * 补给站是"位置"而不是"条目"（12.1b「任何含 SP 的位置都被称为补给站」）。
 * 修前 `addSpAtHex` 无条件新建条目 ⇒ 同格第二次落盘会多出**第二条**账本，
 * 而所有付款路径都是 `find(side + sameHex)` 只取第一条 ⇒ 第二条的 SP **付不出**
 * （13.2f 装载、15.1B 整备、10.x 轰炸会误报"SP 不足"），3.4b 的归属也各挂一半。
 * 本组用例钉住：并入（金额相加、**沿用原 id**）、不跨方、不跨格。
 */
const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 用面板的"新增补给站"入口落一笔（与手工/空运共用 `addSpAtHex`） */
function addSp(store: ReturnType<typeof useWorkbenchStore>, hexText: string, sp: number, t = 0) {
  store.spDumpDraft = { hexText, sp, t }
  return store.addSpDump()
}

describe('12.1b / §5-C：同格同方并入同一本账', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('同格同方两次落盘 ⇒ 只有一条账本，金额相加', () => {
    const store = newStore()
    expect(addSp(store, '10.10', 3)).toBe(true)
    expect(addSp(store, '10.10', 2, 1)).toBe(true)
    const dumps = store.spDumps.filter((dump) => dump.hex.col === 10 && dump.hex.row === 10)
    expect(dumps).toHaveLength(1)
    expect(dumps[0]).toMatchObject({ sp: 5, t: 1 })
  })

  it('并入按 12.1a 折算：T 满 4 并为 SP（2T + 2T ⇒ 1 SP + 0 T）', () => {
    const store = newStore()
    addSp(store, '5.5', 0, 2)
    addSp(store, '5.5', 0, 2)
    expect(store.spDumps).toHaveLength(1)
    expect(store.spDumps[0]).toMatchObject({ sp: 1, t: 0 })
  })

  it('并入**沿用原 id**（3.4b 归属/轰炸付款等按 id 的引用不会悬空）', () => {
    const store = newStore()
    addSp(store, '12.7', 2)
    const first = store.spDumps[0]!
    addSp(store, '12.7', 4)
    expect(store.spDumps).toHaveLength(1)
    expect(store.spDumps[0]!.id).toBe(first.id)
    expect(store.spDumps[0]!.sp).toBe(6)
    // 原先按 id 持有的引用仍指向有效条目
    expect(store.spDumps.some((dump) => dump.id === first.id)).toBe(true)
  })

  it('并入后付款路径读到的就是总额（不再有"看得见、付不出"的第二条）', () => {
    const store = newStore()
    const side = store.activeSide
    addSp(store, '20.20', 3)
    addSp(store, '20.20', 2)
    const payable = store.spDumps.find(
      (dump) => dump.side === side && dump.hex.col === 20 && dump.hex.row === 20,
    )
    expect(payable?.sp).toBe(5)
  })

  it('不同方同格不并（各记各的账）', () => {
    const store = newStore()
    const first = store.activeSide
    const other = first === 'axis' ? 'soviet' : 'axis'
    store.setActiveSide(first)
    addSp(store, '30.30', 2)
    store.setActiveSide(other)
    addSp(store, '30.30', 3)
    const here = store.spDumps.filter((dump) => dump.hex.col === 30 && dump.hex.row === 30)
    expect(here).toHaveLength(2)
    expect(here.map((dump) => dump.side).sort()).toEqual([first, other].sort())
  })

  it('同方不同格不并', () => {
    const store = newStore()
    addSp(store, '1.1', 2)
    addSp(store, '1.2', 2)
    expect(store.spDumps).toHaveLength(2)
  })
})

describe('12.1b / §5-C：读档时把旧档里的同格多条账本并成一条', () => {
  it('手改出"同格两条"的旧档 ⇒ 读档后只剩一条、金额相加（不让 SP 变成付不出的死额）', () => {
    const adapter = createMemoryStorage()
    setActivePinia(createPinia())
    const session = useGameSessionStore()
    session.setSaveStorage(adapter)
    session.startGame()
    const workbench = useWorkbenchStore()
    const side = workbench.activeSide
    // 存档里塞两条同格同方的账本（修复前的落盘形态）
    workbench.spDumps = [
      { id: 'old-1', hex: { col: 9, row: 9 }, side, sp: 2, t: 0 },
      { id: 'old-2', hex: { col: 9, row: 9 }, side, sp: 3, t: 2 },
    ]
    expect(session.saveNow()).toBe(true)

    // 清空内存盘面后读档（读档路径即 restoreBoard）
    workbench.spDumps = []
    expect(session.loadNow()).toBe(true)
    const here = useWorkbenchStore().spDumps.filter(
      (dump) => dump.hex.col === 9 && dump.hex.row === 9,
    )
    expect(here).toHaveLength(1)
    // 5 SP + 2 T 已是 12.1a 的规范形（2 T 不足 1 SP）
    expect(here[0]).toMatchObject({ id: 'old-1', sp: 5, t: 2 })
  })
})
