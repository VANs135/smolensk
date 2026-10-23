import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { holdingsToT } from '@/engine/rules'
import { toConsoleUnit, unitChoices, useWorkbenchStore, type ConsoleUnit } from '@/stores'

/**
 * C8 补给交互与 SP 管理的**端到端流程**（store 级）
 *
 * 覆盖用户要求的交互链：追溯与投递可视化 → SP 拆分合并 → 拖取与投递选择 → 断补处置；
 * 并核对 12.0 章的顺序（12.6 判定 → 12.3 选源/拖取 → 12.6c/d 断补处置）。
 *
 * 用**真实地图与真实单位库**（不造数）：结论全部来自引擎，故断言的是「流程走通 + 状态写对」。
 * 规则细节（5 MP 与相邻即可、投递三禁令、吃图上补给的取整、分支判据）在
 * `tests/engine/supply-interaction.test.ts`。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 六邻皆图内的格：把单位与补给站放在同格 ⇒ 距离 0，判据不受地形影响（断言可确定） */
const CORE_HEX: HexRef = (() => {
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

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 有战斗值、且有规模（12.6c 的 RE 计价需要它） */
function combatRecord(side: Side): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(
    (record) => record.isCombat === true && (record.reSize ?? 0) > 0,
  )
  if (found === undefined) throw new Error(`${side} 单位库中没有带规模的战斗单位`)
  return found
}

/** 非战斗单位（12.0） */
function nonCombatRecord(side: Side): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find((record) => record.isCombat === false)
  if (found === undefined) throw new Error(`${side} 单位库中没有非战斗单位`)
  return found
}

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: Side,
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/* ────────────────────────────── 12.1a SP 拆分 / 加总 ────────────────────────────── */

describe('C8 12.1a：SP 账本的拆分与加总', () => {
  it('加总把满 4 的 T 并为 SP；拆分把整 SP 找零为 T（总额不变）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 6 }
    expect(store.addSpDump()).toBe(true)
    const id = store.spDumps[0]!.id

    // 12.1a：尽可能将 T 并为 SP ⇒ 1 SP + 6 T = 10 T = 2 SP + 2 T
    expect(store.mergeSpDumpHoldings(id)).toBe(true)
    expect(store.spDumps[0]).toMatchObject({ sp: 2, t: 2 })

    // 12.1a：拆分不改变总额 ⇒ 2 SP + 2 T 拆 1 SP = 1 SP + 6 T
    expect(store.splitSpDumpHoldings(id, 1)).toBe(true)
    expect(store.spDumps[0]).toMatchObject({ sp: 1, t: 6 })
  })

  it('拆分超过持有量被引擎拒绝（12.1a：notEnoughSp）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    store.addSpDump()
    const id = store.spDumps[0]!.id
    expect(store.splitSpDumpHoldings(id, 5)).toBe(false)
    expect(store.supplyError?.rule).toBe('12.1a')
    expect(store.supplyError?.reason).toContain('notEnoughSp')
    // 失败不改账本
    expect(store.spDumps[0]).toMatchObject({ sp: 1, t: 0 })
  })

  it('格号非法、SP 与 T 同时为 0 时都不建账（12.1b / 12.1a）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    store.spDumpDraft = { hexText: '不是格号', sp: 1, t: 0 }
    expect(store.addSpDump()).toBe(false)
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 0, t: 0 }
    expect(store.addSpDump()).toBe(false)
    expect(store.spDumps).toHaveLength(0)
  })
})

/* ────────────────────────────── 12.6 → 12.3 全流程 ────────────────────────────── */

describe('C8 补给交互：12.6 判定 → 12.3 选源 → 拖取结算', () => {
  it('有追溯补给 ⇒ trace 分支；选补给站拖取 1T 后账本正确扣减（12.1a 找零）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    const unit = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    // 12.1b：含 SP 的位置即补给站（放在单位同格 ⇒ 距离 0）
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    expect(store.addSpDump()).toBe(true)
    // 12.6a①：同格声明一个补给源 ⇒ 有追溯补给
    store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
    expect(store.addSupplySource()).toBe(true)

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    expect(store.beginSupplyCheckNow(unit.instanceId)).toBe(true)
    expect(store.supplySummary?.status).toBe('inSupply')
    expect(store.supplyState?.step).toBe('selectSource')
    // 12.6c：有追溯补给时不能吃图上补给
    expect(store.supplySources.find((s) => s.kind === 'eatOffTheMap')?.ok).toBe(false)

    const dumpIndex = store.supplySources.findIndex((source) => source.kind === 'dump')
    expect(dumpIndex).toBeGreaterThanOrEqual(0)
    expect(store.supplySources[dumpIndex]?.ok).toBe(true)
    // 12.3c/12.3d：同格 ⇒ 距离 0、路径即起点格
    expect(store.supplySources[dumpIndex]?.distanceMp).toBe(0)
    expect(store.supplySources[dumpIndex]?.path).toEqual([CORE_HEX])

    expect(store.chooseSupplySourceNow(dumpIndex)).toBe(true)
    expect(store.supplyState?.step).toBe('pickup')

    /*
     * ★ 契约变更（批 B 切片 2，**不是放宽**）：用途改 `combat` → `fuel`。
     *   原因：裁定⑥「战斗补给只在战斗会话内付」⇒ 本链选 `combat` 会被按 12.4 拒（那是新用例钉住的）。
     *   本条考的是"拖取成功 ⇒ 扣款 + 找零"，与用途无关；另加一条**新行为**的断言（用途落到状态）。
     */
    store.supplyInputs.purpose = 'fuel'
    expect(store.confirmSupplyPickupNow()).toBe(true)
    expect(store.supplyState?.step).toBe('done')
    expect(store.supplyState?.finished).toBe(true)
    // 1 SP = 4 T；付 1 T ⇒ 需找零，余额 3 T（12.1a）
    expect(store.spDumps[0]).toMatchObject({ sp: 0, t: 3 })
    // ★ 批 B 切片 2（裁定⑤「获取即付款」）：燃料用途**落到状态**（修前扣完款就结束 ⇒ 单位还是不能走）
    expect(unit.fuelled).toBe(true)
    expect(unit.fuelMethod).toBe('singleUnit')
  })

  it('12.6a 的追溯源不含 SP：选它会被拒（12.1b）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    const unit = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    store.addSpDump()
    store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'edgeRail' }
    store.addSupplySource()

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    store.beginSupplyCheckNow(unit.instanceId)

    const baseIndex = store.supplySources.findIndex((source) => source.kind === 'baseSource')
    expect(baseIndex).toBeGreaterThanOrEqual(0)
    expect(store.chooseSupplySourceNow(baseIndex)).toBe(false)
    expect(store.supplyError?.reason).toBe('sourceHasNoSp:baseSource')
    // 仍停在选源步
    expect(store.supplyState?.step).toBe('selectSource')
  })

  it('12.6：只能对当前方的单位做补给检查', () => {
    const store = newStore()
    store.setSupplyActive(true)
    const enemy = place(store, combatRecord('soviet'), CORE_HEX, 'soviet', 'e1')

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    expect(store.beginSupplyCheckNow(enemy.instanceId)).toBe(false)
    expect(store.supplyState).toBeNull()
  })

  it('12.0：非战斗单位不需要追溯补给，直接判完', () => {
    const store = newStore()
    store.setSupplyActive(true)
    const unit = place(store, nonCombatRecord('axis'), CORE_HEX, 'axis', 'n1')

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    expect(store.beginSupplyCheckNow(unit.instanceId)).toBe(true)
    expect(store.supplySummary?.status).toBe('notRequired')
    expect(store.supplyState?.step).toBe('done')
    expect(store.supplyState?.assessment.required).toBe(false)
  })

  it('未开始时不能选来源（顺序纪律）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    expect(store.chooseSupplySourceNow(0)).toBe(false)
    expect(store.confirmSupplyPickupNow()).toBe(false)
    expect(store.confirmOosResolutionNow()).toBe(false)
  })
})

/* ────────────────────────────── 12.6c / 12.6d 断补处置 ────────────────────────────── */

describe('C8 断补处置：12.6c 吃图上补给 / 12.6d 接受断补', () => {
  it('无追溯补给但能拖到补给站 ⇒ oos 分支；吃图上补给按 RE 扣 T（12.6c）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    const unit = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 4, t: 0 }
    store.addSpDump()

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    expect(store.beginSupplyCheckNow(unit.instanceId)).toBe(true)
    // 12.6c：没有追溯补给（未声明任何 12.6a 源），但单位在补给站的拖取距离内 ⇒ 可吃图上补给
    expect(store.supplySummary?.status).toBe('canEatOffTheMap')
    expect(store.supplyState?.branch).toBe('oos')
    expect(store.supplyState?.step).toBe('resolveOos')

    const costT = store.supplySummary!.eatingCostT
    // 12.6c：每 1T 覆盖最多 2RE，小数向上取整
    expect(costT).toBe(Math.ceil(unit.re / 2))
    // 12.6c 的付款来源由引擎裁定（该单位能拖到的最近补给站）
    expect(store.supplyOosPayDump?.id).toBe(store.spDumps[0]!.id)

    store.supplyInputs.oosAction = 'eatOffTheMap'
    expect(store.confirmOosResolutionNow()).toBe(true)
    expect(store.supplyState?.step).toBe('done')
    expect(store.supplySummary?.oos?.markedOutOfSupply).toBe(false)
    // 12.6c：吃图上补给 ⇒ 被喂饱、**未标记断补** ⇒ 单位仍视为有补给。
    // （12.8e 的「断补首回合」豁免另算：那种「续命」方式不构成追溯补给，但也不给豁免，
    //   所以它不能靠这个字段表达，而是 `canBreakout` 的 `firstTurnOutOfSupply` 入参。）
    expect(unit.hasTraceSupply).toBe(true)
    // 4 SP = 16 T；扣 costT 后余额按 12.1a 规范化
    const remaining = 16 - costT
    expect(store.spDumps[0]).toMatchObject({
      sp: Math.floor(remaining / 4),
      t: remaining % 4,
    })
  })

  it('12.6c：批量费率——同环节同站喂两个 1RE 单位共扣 1 T（取整作用在**批次总量**上）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 2, t: 0 }
    expect(store.addSpDump()).toBe(true)
    const first = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    const second = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u2')
    // 两个都是 1RE（夹具只要求"有规模"，这里显式压成 1RE 好核对批量口径）
    first.re = 1
    second.re = 1

    const totalT = (): number => holdingsToT({ sp: store.spDumps[0]!.sp, t: store.spDumps[0]!.t })
    const before = totalT()

    /*
     * B8：D 段的动作只在 D 段放行 ⇒ 先声明段。★ 必须在**循环之外**只声明一次：
     *   `setPhase` 会清空"本环节已喂 RE"账本（12.6c 的批量费率按**段**累计），
     *   若放在循环里，就把"同环节同站喂两个单位"拆成了两批，正好毁掉本用例要考的口径。
     */
    store.setPhase('supply')

    for (const unit of [first, second]) {
      expect(store.beginSupplyCheckNow(unit.instanceId)).toBe(true)
      expect(store.supplySummary?.status).toBe('canEatOffTheMap')
      store.supplyInputs.oosAction = 'eatOffTheMap'
      expect(store.confirmOosResolutionNow()).toBe(true)
    }

    /*
     * 两个 1RE 同站、同环节 ⇒ 批次合计 2RE ⇒ **1 T**。
     * 修前是"逐单位 ceil(re/2) 再相加" ⇒ 1+1 = 2 T（多收一倍）；
     * 条文例「6.5 的 RE 需消耗 4T」说明取整必须作用在批次总量上。
     */
    expect(totalT()).toBe(before - 1)
  })

  it('无源无补给站 ⇒ 断补；接受断补即标记且不动 SP 账本（12.6d）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    const unit = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    expect(store.beginSupplyCheckNow(unit.instanceId)).toBe(true)
    expect(store.supplySummary?.status).toBe('outOfSupply')
    expect(store.supplyState?.step).toBe('resolveOos')
    expect(store.supplySummary?.canEatOffTheMap).toBe(false)
    expect(store.supplyOosPayDump).toBeNull()

    store.supplyInputs.oosAction = 'acceptOutOfSupply'
    expect(store.confirmOosResolutionNow()).toBe(true)
    expect(store.supplyState?.step).toBe('done')
    expect(store.supplySummary?.oos?.markedOutOfSupply).toBe(true)
    expect(store.supplySummary?.oos?.costT).toBe(0)
    // 12.8d：断补标记必须**落到单位上**（原先只进日志、单位状态里看不出断补）。
    // 现在真正读到它的地方：9.5a/12.8d 战斗值减半（`battle.unitBattleStrength`）、
    // 4.5 断补不投射 ZOC（`zoc`）、12.8e 突围资格（`breakout.canBreakout`）、界面断补图标。
    // （12.8b 的逐回合损耗骰仍需补给阶段总计划接线，见接线计划 P1-2，此处不算它已生效。）
    expect(unit.hasTraceSupply).toBe(false)
  })

  it('12.3a：拖取成功后清除断补标记（补给恢复须能回到在补给状态）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    const unit = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')

    // ① 先制造断补：此刻无 12.6a 源、无补给站 ⇒ 只能接受断补

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    expect(store.beginSupplyCheckNow(unit.instanceId)).toBe(true)
    store.supplyInputs.oosAction = 'acceptOutOfSupply'
    expect(store.confirmOosResolutionNow()).toBe(true)
    expect(unit.hasTraceSupply).toBe(false)

    // ② 声明补给站（12.1b）与补给源（12.6a①）后重新检查：应有追溯补给
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    expect(store.addSpDump()).toBe(true)
    store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
    expect(store.addSupplySource()).toBe(true)

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    expect(store.beginSupplyCheckNow(unit.instanceId)).toBe(true)
    expect(store.supplySummary?.status).toBe('inSupply')
    // 12.3：先选源再拖取
    const dumpIndex = store.supplySources.findIndex((source) => source.kind === 'dump')
    expect(store.chooseSupplySourceNow(dumpIndex)).toBe(true)
    // 契约变更（批 B 切片 2）：用途 combat → fuel（战斗补给不在本链付，见同文件的新用例）
    store.supplyInputs.purpose = 'fuel'
    expect(store.confirmSupplyPickupNow()).toBe(true)
    // 12.3a 拖取成功 ⇒ 清除断补标记
    expect(unit.hasTraceSupply).toBe(true)
  })

  it('账本闭合（B0④）：12.1a 的拆分与合并只改面额、不改总量（SP/T 换算守恒）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 2, t: 1 }
    expect(store.addSpDump()).toBe(true)

    // 12.1a：1 SP = 4 T ⇒ 总量以 T 计价（用引擎的换算，不在测试里写死 4）
    const totalT = (): number =>
      store.spDumps.reduce((sum, dump) => sum + holdingsToT({ sp: dump.sp, t: dump.t }), 0)
    const before = totalT()
    expect(before).toBe(holdingsToT({ sp: 2, t: 1 }))

    // 找零：拆一个整 SP 为 T
    expect(store.splitSpDumpHoldings(store.spDumps[0]!.id, 1)).toBe(true)
    expect(store.spDumps[0]!.sp).toBe(1)
    expect(totalT()).toBe(before)

    // 再合回去（T 满 4 并为等额 SP）
    expect(store.mergeSpDumpHoldings(store.spDumps[0]!.id)).toBe(true)
    expect(totalT()).toBe(before)
    expect(store.spDumps[0]).toMatchObject({ sp: 2, t: 1 })
  })

  it('12.6 / 12.8：全场判定把被合围的单位判为断补（12.3d 敌方 ZOC 阻断卡车路径）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    // 补给源声明在**图另一侧**：被合围的单位因此连不过去（12.6 虽无距离上限，但路径被阻断）
    const far = mapLayers.hexes[mapLayers.hexes.length - 1]!
    store.supplySourceDraft = { hexText: `${far.col}.${far.row}`, kind: 'supplySourceHex' }
    expect(store.addSupplySource()).toBe(true)

    const surrounded = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    const free = place(
      store,
      combatRecord('axis'),
      { col: CORE_HEX.col + 3, row: CORE_HEX.row },
      'axis',
      'u2',
    )
    // 合围：六个图内邻格各放一个敌方可攻击单位 ⇒ 12.3d 阻断一切路径进出
    for (const direction of HEX_DIRECTIONS) {
      const blocker = neighbor(CORE_HEX, direction)
      if (!isOnMap(blocker)) continue
      place(store, combatRecord('soviet'), blocker, 'soviet', `e-${blocker.col}-${blocker.row}`)
    }

    const outOfSupply = store.evaluateTraceSupplyNow()
    expect(outOfSupply).toBeGreaterThanOrEqual(1)
    expect(surrounded.hasTraceSupply).toBe(false)
    // 对照：未被合围的友军仍在补给网内（证明判定不是"全场一律断补"）
    expect(free.hasTraceSupply).toBe(true)
  })

  it('12.6 自动触发：进入补给阶段与移动阶段（突围环节）各自重判一次，不必玩家手动点', () => {
    const store = newStore()
    // 合围 + 远源：与上一条同构，但**不手动调用**判定
    const far = mapLayers.hexes[mapLayers.hexes.length - 1]!
    store.supplySourceDraft = { hexText: `${far.col}.${far.row}`, kind: 'supplySourceHex' }
    expect(store.addSupplySource()).toBe(true)
    const surrounded = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    for (const direction of HEX_DIRECTIONS) {
      const blocker = neighbor(CORE_HEX, direction)
      if (!isOnMap(blocker)) continue
      place(store, combatRecord('soviet'), blocker, 'soviet', `e-${blocker.col}-${blocker.row}`)
    }
    // 初值仍是创建时的 true（尚未判过）
    expect(surrounded.hasTraceSupply).toBe(true)

    // 12.6 的评估时点：进入补给阶段即自动重判
    store.setPhase('supply')
    expect(surrounded.hasTraceSupply).toBe(false)
    // 日志能看出"是谁推动的"
    expect(store.log.some((entry) => entry.text.includes('进入补给阶段'))).toBe(true)

    // 12.8e 括注「在此环节中检查追溯补给」：进入移动阶段（＝突围环节）再次自动重判
    store.setPhase('movement')
    expect(surrounded.hasTraceSupply).toBe(false)
    expect(store.log.some((entry) => entry.text.includes('突围环节复查'))).toBe(true)
  })
})

/* ────────────────────────────── 12.3b 指挥部投递 ────────────────────────────── */

describe('C8 12.3b：指挥部投递（付款补给站由引擎裁定）', () => {
  it('HQ 自身能拖到补给站时把 SP 投递给相邻单位，账本从付款站扣减', () => {
    const store = newStore()
    store.setSupplyActive(true)
    // HQ 与目标单位同格（投递距离内、且 HQ 自身能拖到同格的补给站）
    const hqRecord = unitChoices('axis').find((record) => (record.specialized ?? []).includes('hq'))
    if (hqRecord === undefined) throw new Error('轴心国单位库中没有指挥部')
    const hq = place(store, hqRecord, CORE_HEX, 'axis', 'hq-1')
    const target = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    store.addSpDump()
    // 12.6a：同格声明补给源，保证 HQ 与目标都有追溯补给
    store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
    store.addSupplySource()

    // B8：D 段的动作只在 D 段放行 ⇒ 先声明段（本段第 1 环＝追溯/拖取）

    store.setPhase('supply')

    expect(store.beginSupplyCheckNow(target.instanceId)).toBe(true)
    expect(store.supplySummary?.status).toBe('inSupply')

    const throwIndex = store.supplySources.findIndex((source) => source.kind === 'hqThrow')
    expect(throwIndex).toBeGreaterThanOrEqual(0)
    expect(store.supplySources[throwIndex]?.ok).toBe(true)
    expect(store.chooseSupplySourceNow(throwIndex)).toBe(true)

    // 12.3b：HQ 先按 12.3a 从补给站拖取 SP，再前送 ⇒ 付款站必须是它够得着的补给站
    expect(store.supplyPayDumpCandidates.map((dump) => dump.id)).toEqual([store.spDumps[0]!.id])
    /*
     * ★ 契约变更（批 B 切片 2，**不是放宽**）：裁定⑤「获取即付款」⇒ 燃料的 T 数**由 12.5c-C 的
     *   费率算**（每单位 1 T），玩家填的 2 不再生效。修前这里付 2T ⇒ 只扣玩家声明的数字。
     */
    store.supplyInputs.amountT = 2
    store.supplyInputs.purpose = 'fuel'
    expect(store.supplyPickupRequirement).toMatchObject({ t: 1, rule: '12.5c-C', manual: false })
    expect(store.confirmSupplyPickupNow()).toBe(true)
    // 1 SP = 4 T：付 1 T ⇒ 找零 3 T
    expect(store.spDumps[0]).toMatchObject({ sp: 0, t: 3 })
    // HQ 本身不持有 SP（12.1b：SP 在补给站上），故只扣付款站
    expect(hq.instanceId).toBe('hq-1')
  })

  it('★ 批 B 切片 2：**12.4 战斗补给不在本链付**（裁定⑥：只在战斗会话内付）', () => {
    const store = newStore()
    store.setSupplyActive(true)
    const unit = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    expect(store.addSpDump()).toBe(true)
    store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
    expect(store.addSupplySource()).toBe(true)
    store.setPhase('supply')
    expect(store.beginSupplyCheckNow(unit.instanceId)).toBe(true)
    const dumpIndex = store.supplySources.findIndex((source) => source.kind === 'dump')
    expect(store.chooseSupplySourceNow(dumpIndex)).toBe(true)

    store.supplyInputs.purpose = 'combat'
    // 费率投影**没有**这一项（null ⇒ 本链不付）
    expect(store.supplyPickupRequirement).toBeNull()
    const before = { ...store.spDumps[0]! }
    expect(store.confirmSupplyPickupNow()).toBe(false)
    expect(store.log.some((entry) => entry.rule === '12.4')).toBe(true)
    // 账本分毫未动（不是"付了一半"）
    expect(store.spDumps[0]).toMatchObject({ sp: before.sp, t: before.t })
    // 也没有把燃料状态写上去（用途拒绝＝整笔没发生）
    expect(unit.fuelled).toBe(false)
  })

  it('★ 批 B 切片 2（裁定②）：投递恒为「立即使用」—— 12.3b-A 的必答项不再是可取消的勾选', () => {
    const store = newStore()
    store.setSupplyActive(true)
    const hqRecord = unitChoices('axis').find((record) => (record.specialized ?? []).includes('hq'))
    if (hqRecord === undefined) throw new Error('轴心国单位库中没有指挥部')
    place(store, hqRecord, CORE_HEX, 'axis', 'hq-1')
    const target = place(store, combatRecord('axis'), CORE_HEX, 'axis', 'u1')
    store.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    store.addSpDump()
    store.supplySourceDraft = { hexText: label(CORE_HEX), kind: 'supplySourceHex' }
    store.addSupplySource()
    store.setPhase('supply')
    store.beginSupplyCheckNow(target.instanceId)

    const throwIndex = store.supplySources.findIndex((source) => source.kind === 'hqThrow')
    expect(store.chooseSupplySourceNow(throwIndex)).toBe(true)
    store.supplyInputs.purpose = 'fuel'
    // 玩家**没有任何**"是否立即使用"的输入了（字段已删）⇒ 投递照常成立
    expect(store.supplyInputs).not.toHaveProperty('forImmediateUse')
    expect(store.confirmSupplyPickupNow()).toBe(true)

    /*
     * 留痕与结构：会话日志里这一笔记的是 `forImmediateUse: true`，
     * 而**玩家侧已经没有这个输入**（`SupplyInputs` 无该字段、面板无勾选框）—— 这是"结构性恒真"的
     * 可观测证据。本仓库不挂组件渲染测试 ⇒ "面板上真的没有那个勾选框"用源码守卫钉住。
     * 引擎侧的 12.3b-A 判据另有 `tests/engine/supply-interaction.test.ts` 覆盖。
     */
    const storeSource = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(storeSource).toContain('forImmediateUse: true,')
    expect(storeSource).not.toContain('supplyInputs.value.forImmediateUse')
    const panelSource = readFileSync('src/components/supply/SupplyPanel.vue', 'utf8')
    expect(panelSource).not.toContain('forImmediateUse')
  })
})
