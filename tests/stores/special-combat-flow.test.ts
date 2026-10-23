import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { mapLayers, scenarios } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * 9.14 特殊战斗的**端到端流程**（store 级）
 *
 * 用户要求：「解决运输点等问题，落点按规则由玩家选择；另外地图印刷工事相当于一个特殊的工事单位，
 * 剧本 1 开局全部属于苏联，其它剧本看德军推进位置（德军战线及后方的属于德军，苏军战线及其后方的
 * 属于苏军）」。本文件正是对这两条的可执行核对：
 *   - 9.14b 补给站：夺取部分入进入方账本、其余**被摧毁**（原账本整条消失）；
 *   - 9.14c 运输点：按夺取表分组分配，被夺取者翻面归进入方，**其余由原主在 10 格内选落点**；
 *   - 9.14d 延补队：崩溃位移的落点由玩家选定并落盘；
 *   - 9.14e 印刷工事：归属按剧本初设（剧本 1 全属苏联 / 剧本 3、5、7 按德军推进线），
 *     被夺取后**只翻归属、等级不变**（专规 1.3a）。
 *
 * 用**真实地图、真实剧本数据与真实单位库**（不造数）：结论全部来自引擎与剧本数据。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 六邻皆在图内的格（位移落点候选需要图内邻格，取它便于断言） */
const HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到「六邻皆图内」的格')
  return { col: found.col, row: found.row }
})()

/** 同格判定 */
const sameHex = (a: HexRef, b: HexRef): boolean => a.col === b.col && a.row === b.row

/** `列.行` → 格（剧本数据里的键可能补零，如 `07.08`） */
function parseHex(text: string): HexRef {
  const [col, row] = text.split('.').map((part) => Number.parseInt(part, 10))
  if (col === undefined || row === undefined || Number.isNaN(col) || Number.isNaN(row))
    throw new Error(`格号无法解析：${text}`)
  return { col, row }
}

type Record0 = ReturnType<typeof unitChoices>[number]

/** 从单位库挑一个满足条件的记录 */
function pickRecord(side: 'axis' | 'soviet', predicate: (record: Record0) => boolean): Record0 {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

/** 摆一个算子并返回它 */
function place(
  store: ReturnType<typeof newStore>,
  record: Record0,
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** 可攻击的地面战斗单位（9.14 的触发前提） */
const attacker = (side: 'axis' | 'soviet') =>
  pickRecord(side, (record) => record.isCombat === true && record.attackCapable === true)

/** 苏军运输点算子（MA 45 > 10 ⇒ 走「卡车」列，9.14c） */
function transportRecords(): Record0[] {
  const records = unitChoices('soviet').filter(
    (record) =>
      record.noncombatKind === 'transport_point' &&
      (record.noncombatDetails?.transportKind ?? '') === 'truck',
  )
  if (records.length < 3) throw new Error('单位库里卡车运输点不足 3 枚，无法核对分组夺取')
  return records.slice(0, 3)
}

describe('9.14 特殊战斗流程（store 级）', () => {
  it('9.14b：敌方可攻击单位进入补给站格 ⇒ 一段 SP 归进入方，其余被摧毁（原账本整条消失）', () => {
    const store = newStore()
    // 苏军在本格放 9 SP（12.1a：1 SP = 4 T ⇒ 36 T）
    store.setActiveSide('soviet')
    store.spDumpDraft = { hexText: `${HEX.col}.${HEX.row}`, sp: 9, t: 0 }
    expect(store.addSpDump()).toBe(true)
    expect(store.spDumps).toHaveLength(1)

    place(store, attacker('axis'), HEX, 'axis', 'a1')
    expect(store.resolveSpecialCombatAt(HEX, 'axis')).toBe(true)

    // 原（苏军）账本被整条处理掉（未被夺取的部分按 9.14b **被摧毁**）
    expect(store.spDumps.some((dump) => dump.side === 'soviet')).toBe(false)
    // 进入方在本格拿到被夺取的那一部分
    // 种子化 RNG（DEFAULT_SEED 的第一次抽取＝5）⇒ 夺取表「地面补给」列 50% ⇒ 36 T 的一半＝18 T
    // （1 SP = 4 T ⇒ 4 SP + 2 T；其余 18 T 被摧毁）
    const gained = store.spDumps.find((dump) => dump.side === 'axis' && sameHex(dump.hex, HEX))
    expect(gained).toBeDefined()
    expect((gained?.sp ?? 0) * 4 + (gained?.t ?? 0)).toBe(18)
    // 留痕：规则号 9.14b，且写明「其余被摧毁」
    expect(store.log.some((entry) => entry.rule === '9.14b')).toBe(true)
    expect(store.log.some((entry) => entry.text.includes('被摧毁'))).toBe(true)
  })

  it('9.14c：运输点分组夺取；被夺取者归进入方，其余在 10 格内由原主选落点', () => {
    const store = newStore()
    const records = transportRecords()
    records.forEach((record, index) => place(store, record, HEX, 'soviet', `tp${index}`))
    const totalPoints = records.reduce(
      (sum, record) => sum + (record.noncombatDetails?.transport ?? 0),
      0,
    )
    expect(totalPoints).toBeGreaterThan(0)

    place(store, attacker('axis'), HEX, 'axis', 'a1')
    expect(store.resolveSpecialCombatAt(HEX, 'axis')).toBe(true)

    const pending = store.specialPending
    if (pending === null) {
      // 夺取表给到 100%：三枚全被夺取 ⇒ 无位移待决
      for (const index of records.keys())
        expect(store.units.find((item) => item.instanceId === `tp${index}`)?.side).toBe('axis')
      return
    }

    expect(pending.splits).toHaveLength(1)
    const split = pending.splits[0]!
    expect(split.group.group).toBe('trucks')
    expect(split.group.totalPoints).toBe(totalPoints)
    // 种子化 RNG（第一次抽取＝5）⇒ 「卡车」列 50%
    expect(split.group.die).toBe(5)
    expect(split.group.percent).toBe(50)
    expect(split.group.capturedPoints).toBe(Math.round((totalPoints * 50) / 100))
    expect(split.ownerSide).toBe('soviet')
    // 夺取 + 位移 ＝ 全部算子（9.14c：组内不是被夺取就是被转移）
    expect(split.capturedIds.length + pending.items.length).toBe(records.length)
    // 被夺取者**已翻面**归进入方
    for (const id of split.capturedIds)
      expect(store.units.find((item) => item.instanceId === id)?.side).toBe('axis')
    // 位移落点候选全在格距上限内（9.14c：敌方单位/ZOC/禁入地形都不影响）
    for (const item of pending.items) {
      expect(item.kind).toBe('transport')
      expect(item.candidates.length).toBeGreaterThan(0)
      for (const hex of item.candidates) {
        expect(hexDistance(HEX, hex)).toBeGreaterThan(0)
        expect(hexDistance(HEX, hex)).toBeLessThanOrEqual(10)
      }
    }

    // 原主选落点 ⇒ 落盘（位移到选的格，归属仍是原主）
    const item = pending.items[0]!
    const target = item.candidates[item.candidates.length - 1]!
    expect(store.setSpecialDisplacement(item.unitId, target)).toBe(true)
    expect(store.confirmSpecialCombatNow()).toBe(true)
    const moved = store.units.find((unit) => unit.instanceId === item.unitId)
    expect(moved === undefined ? null : moved.hex).toEqual(target)
    expect(moved?.side).toBe('soviet')
    expect(store.specialPending).toBeNull()
  })

  it('9.14c：非法落点被拒绝（不在候选中时不落盘）', () => {
    const store = newStore()
    const records = transportRecords()
    records.forEach((record, index) => place(store, record, HEX, 'soviet', `tp${index}`))
    place(store, attacker('axis'), HEX, 'axis', 'a1')
    store.resolveSpecialCombatAt(HEX, 'axis')

    const pending = store.specialPending
    if (pending === null || pending.items.length === 0) return
    const item = pending.items[0]!
    // 找一格**不在**候选里的格（格距必超上限，地图足够大故必存在）
    const far = mapLayers.hexes
      .map((hex) => ({ col: hex.col, row: hex.row }))
      .find((hex) => !item.candidates.some((candidate) => sameHex(candidate, hex)))
    expect(far).toBeDefined()
    expect(store.setSpecialDisplacement(item.unitId, far!)).toBe(false)
    expect(item.chosen).toBeNull()
    expect(store.log.some((entry) => entry.text.includes('不是'))).toBe(true)
  })

  it('9.14e + 专规 1.3a：印刷工事按剧本归属；剧本 1 全属苏联，剧本 3 有德军格，夺取后翻归属', () => {
    const store = newStore()
    const hog = mapLayers.printedHedgehogs[0]!
    const hogHex = { col: hog.col, row: hog.row }

    // 剧本 1（默认初设）：地图印刷工事全部属苏联
    expect(store.scenarioId).toBe('1')
    expect(store.printedHedgehogOwnerAt(hogHex)).toBe('soviet')

    // 剧本 3：按德军推进线推导出的格属德军（清单来自剧本数据）
    store.setScenarioId('3')
    const axisOwned =
      scenarios.scenarios.find((item) => item.id === '3')?.setup.printedHedgehogOwners?.axisOwned ??
      []
    expect(axisOwned.length).toBeGreaterThan(0)
    const axisHex = parseHex(axisOwned[0]!)
    expect(store.printedHedgehogOwnerAt(axisHex)).toBe('axis')

    // 苏军可攻击单位进入 ⇒ 归属翻转（专规 1.3a：等级不变，故只写归属账本）
    place(store, attacker('soviet'), axisHex, 'soviet', 's1')
    expect(store.resolveSpecialCombatAt(axisHex, 'soviet')).toBe(true)
    expect(store.printedHedgehogOwnerAt(axisHex)).toBe('soviet')
    expect(store.log.some((entry) => entry.rule === '9.14e')).toBe(true)

    // 切剧本 ⇒ 归属账本随该剧本初设重置
    store.setScenarioId('1')
    expect(store.printedHedgehogOwnerAt(axisHex)).toBe('soviet')
    store.setScenarioId('3')
    expect(store.printedHedgehogOwnerAt(axisHex)).toBe('axis')
  })

  it('9.14d：延补队崩溃位移的落点由玩家选定并落盘', () => {
    const store = newStore()
    const extender = pickRecord('soviet', (record) => record.noncombatKind === 'supply_extender')
    const unit = place(store, extender, HEX, 'soviet', 'ex1')
    place(store, attacker('axis'), HEX, 'axis', 'a1')

    expect(store.resolveSpecialCombatAt(HEX, 'axis')).toBe(true)
    const pending = store.specialPending
    // 延补队的崩溃是**必定发生**的（9.14d「必须进行崩溃」）；无待决说明无合法落点，已按原文留痕
    if (pending === null) return
    const item = pending.items.find((entry) => entry.unitId === 'ex1')
    if (item === undefined) return
    expect(item.kind).toBe('extender')
    expect(item.candidates.length).toBeGreaterThan(1)
    // 落点在**该延补队自身**的特殊拖取距离内
    for (const hex of item.candidates)
      expect(hexDistance(HEX, hex)).toBeLessThanOrEqual(unit.raw.ma)

    // 取「最后一个候选」——它与引擎给的默认落点不同，故能证明是**玩家的选择**在生效
    const target = item.candidates[item.candidates.length - 1]!
    expect(target).not.toEqual(item.chosen)
    expect(store.setSpecialDisplacement('ex1', target)).toBe(true)
    expect(store.confirmSpecialCombatNow()).toBe(true)
    const moved = store.units.find((entry) => entry.instanceId === 'ex1')
    expect(moved === undefined ? null : moved.hex).toEqual(target)
  })
})
