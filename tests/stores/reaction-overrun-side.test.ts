import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { isExtenderUnit, needsFuelOf, toConsoleUnit, unitChoices } from '@/stores'

import { groundRecord, label, newConsole, placeGround } from '../flows/sop-harness'

/**
 * 7.0a / 8.0：**反应阶段**的突袭，敌我按「非阶段玩家 vs 阶段玩家」分
 *
 * 反应段的行动者是非阶段玩家（6.3a / 7.0a），`activeSide` 仍是阶段玩家。
 * 修前 `overrunTargets` / `pickOverrunParticipants` / `overrunNow` / `overrunSplitNow`
 * 都用 `activeSide` 当"我方"：
 *   · 紫环把**阶段玩家**的守军滤掉 ⇒ 反应段一个突袭目标都列不出来；
 *   · `overrunNow` 的 `defenders` 取 `side !== activeSide` ⇒ 把攻方自己的单位当守方（或守方为空）。
 * 结果是 7.0b「轰炸和突袭的结算照常」在反应段完全走不通。
 */

const START: HexRef = (() => {
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
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

const onMapNeighbors = (): HexRef[] =>
  HEX_DIRECTIONS.map((direction) => neighbor(START, direction)).filter(
    (candidate) =>
      isOnMap(candidate) &&
      mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row),
  )

const sovietMover = () =>
  groundRecord(
    'soviet',
    (record) => record.attackCapable === true && (record.factors?.combat?.ma ?? 0) >= 6,
  )

const axisDefender = () => groundRecord('axis', (record) => record.isCombat === true)

describe('7.0a / 8.0：反应阶段突袭的敌我归属', () => {
  it('已释放预备（3 MP）可突袭相邻的阶段玩家单位；守方名单是该轴心单位', () => {
    const store = newConsole()
    // 专规 1.5：剧本首回合苏军地面单位半 MA ⇒ 换到第 2 回合，单看 5.7b-B 的 1/2
    store.setTurn(2)
    store.setPhase('reaction') // activeSide 缺省 axis ⇒ 反应段行动方是苏军
    const unit = placeGround(store, sovietMover(), START, 'soviet', 'su-ov')
    unit.mode = { mode: 'reserve', orientation: 'combat', dg: false, exploit: false }
    // 12.5a：轮式/履带单位耗 MP 前须已加注（本用例只看突袭资格）
    unit.fuelled = true

    // 条 10（批 M）：点格建取子清单，释放后自动开拔
    store.clickHex(START)
    expect(store.releaseReserveNow()).toBe(true)
    expect(store.moveInteraction).not.toBeNull()

    // 六邻都摆阶段玩家的守军；地形/进格费不合格的格由引擎（8.1b）自行剔除
    const record = axisDefender()
    const defenders = new Map<string, string>()
    for (const hex of onMapNeighbors()) {
      const placed = placeGround(store, record, hex, 'axis', `ax-d-${hex.col}-${hex.row}`)
      defenders.set(`${hex.col}.${hex.row}`, placed.instanceId)
    }

    // 修前：targets 恒为空（守军被 `side !== activeSide` 滤掉）
    expect(store.overrunTargets.length).toBeGreaterThan(0)
    const target = store.overrunTargets[0]!.hex
    const defenderId = defenders.get(`${target.col}.${target.row}`)
    expect(defenderId).toBeDefined()

    expect(store.overrunNow(target)).toBe(true)
    expect(store.combatState?.attackType).toBe('overrun')
    expect(store.combatState?.composition.defenderIds).toEqual([defenderId])
  })
})

/**
 * 7.0a / 12.5a / 12.11a / 12.7：反应段的「行动方」同样适用于**加油与补给站/延补队**
 *
 * 反应段由**非阶段玩家**行动（`activeSide` 仍是阶段玩家）。修前 `fuelMethodsForUnitNow` /
 * `fuelPendingUnits` / `destructDumpNow` / `convertibleTransportPointsAt` / 延补队转换落盘
 * 都把 `activeSide` 当"我方" ⇒ 反应玩家：
 *   · 右键没有「加油」入口（12.5a 又要求耗 MP 前必须已付）⇒ 轮式/履带单位在 E 段**动弹不得**；
 *   · 销毁自己的补给站被 12.11a 判成"只能销毁己方"；
 *   · 自己一方的运输点数凑不出 5 点、生成的延补队还被记到**对手**名下。
 * 与 `overrunNow`（7.0b 的突袭）同一类错，判据统一取 `actingSide`。
 */
describe('7.0a：反应段的加油与补给站/延补队按行动方（非阶段玩家）判', () => {
  /** 苏军里需要燃料的单位（12.5a：战斗单位 ∧ 轮式/履带） */
  const sovietFuelUser = () => {
    const record = unitChoices('soviet').find((item) =>
      needsFuelOf(
        toConsoleUnit({
          record: item,
          instanceId: 'fuel-probe',
          hex: START,
          side: 'soviet',
          face: 'combat',
        }),
      ),
    )
    if (record === undefined) throw new Error('苏军单位库没有轮式/履带战斗单位')
    return record
  }

  /** 苏军 5 点卡车运输点数（12.7a 的凑数门槛） */
  const sovietTransport5 = () => {
    const record = unitChoices('soviet').find(
      (item) =>
        item.noncombatDetails?.transport === 5 &&
        (item.noncombatDetails?.transportKind ?? null) === 'truck',
    )
    if (record === undefined) throw new Error('苏军单位库没有 5 点卡车运输点数')
    return record
  }

  it('12.5a：非阶段玩家的轮式单位在 E 段能点出「加油」（否则耗 MP 前无款可付）', () => {
    const store = newConsole()
    store.setTurn(2)
    store.setPhase('reaction') // activeSide 缺省 axis ⇒ 反应段行动方是苏军
    const unit = placeGround(store, sovietFuelUser(), START, 'soviet', 'su-fuel')

    expect(store.fuelMethodsForUnitNow(unit.instanceId).map((choice) => choice.method)).toContain(
      'singleUnit',
    )
    // 界面的「支付燃料」提示同源（修前只认 activeSide ⇒ 反应段永远不提示）
    store.selectedId = unit.instanceId
    expect(store.fuelPaymentDue).toBe(true)
  })

  it('12.11a：反应玩家能销毁**自己的**补给站（不是阶段玩家的）', () => {
    const store = newConsole()
    store.setPhase('reaction')
    store.spDumps.push({ id: 'su-dump', side: 'soviet', hex: START, sp: 2, t: 0 })

    // die=6 ⇒ 100% 销毁；请求 2T 全部
    expect(store.destructDumpNow('su-dump', 2, 6)).toBe(true)
  })

  it('12.7a：反应玩家的 5 点运输点数能转成**苏军**延补队', () => {
    const store = newConsole()
    store.setPhase('reaction')
    store.supplySourceDecls.push({
      id: 'su-src',
      hex: START,
      side: 'soviet',
      kind: 'supplySourceHex',
    })
    placeGround(store, sovietTransport5(), START, 'soviet', 'su-tp5')

    expect(store.convertTransportToExtenderNow(label(START), 'truck')).toBe(true)
    const extenders = store.units.filter(isExtenderUnit)
    expect(extenders).toHaveLength(1)
    expect(extenders[0]!.side).toBe('soviet')
  })

  it('12.4：反应段突袭的战斗补给来源按行动方（苏军）找站，不列阶段玩家的站', () => {
    const store = newConsole()
    store.setTurn(2)
    store.setPhase('reaction') // activeSide 缺省 axis ⇒ 反应段行动方是苏军
    const unit = placeGround(store, sovietMover(), START, 'soviet', 'su-ov-supply')
    unit.mode = { mode: 'reserve', orientation: 'combat', dg: false, exploit: false }
    unit.fuelled = true
    store.clickHex(START)
    expect(store.releaseReserveNow()).toBe(true)

    const record = axisDefender()
    const defenderPlaced = onMapNeighbors().map((hex, index) =>
      placeGround(store, record, hex, 'axis', `ax-sup-${index}`),
    )
    const target = store.overrunTargets.find((item) =>
      defenderPlaced.some((defender) => {
        const hex = item.hex
        return hex.col === defender.hex.col && hex.row === defender.hex.row
      }),
    )
    expect(target).toBeDefined()
    expect(store.overrunNow(target!.hex)).toBe(true)

    // 攻方苏军在敌 ZOC 内 ⇒ 12.3c 只能从本格拖取：站放在 START
    store.spDumps.push({ id: 'su-ov-dump', side: 'soviet', hex: START, sp: 2, t: 0 })
    store.spDumps.push({ id: 'ax-ov-dump', side: 'axis', hex: START, sp: 2, t: 0 })

    const attackerEntry = store.combatSupplyDumps.find((item) => item.side === 'attacker')!
    // 修前 attackerSide 取 activeSide（axis）⇒ 列出来的是轴心国的站
    expect(attackerEntry.dumps.map((dump) => dump.id)).toContain('su-ov-dump')
    expect(attackerEntry.dumps.map((dump) => dump.id)).not.toContain('ax-ov-dump')
    expect(store.pickCombatSupplyDump('attacker', 'su-ov-dump')).toBe(true)
  })

  it('12.7d：延补队翻回运输点数时也落在行动方名下', () => {
    const store = newConsole()
    store.setPhase('reaction')
    store.supplySourceDecls.push({
      id: 'su-src',
      hex: START,
      side: 'soviet',
      kind: 'supplySourceHex',
    })
    placeGround(store, sovietTransport5(), START, 'soviet', 'su-tp5')
    expect(store.convertTransportToExtenderNow(label(START), 'truck')).toBe(true)
    const extender = store.units.find(isExtenderUnit)!

    expect(store.flipExtenderToTransport(extender.instanceId)).toBe(true)
    const points = store.units.filter(
      (unit) => !isExtenderUnit(unit) && unit.noncombatTransport === 5,
    )
    expect(points).toHaveLength(1)
    expect(points[0]!.side).toBe('soviet')
  })
})
