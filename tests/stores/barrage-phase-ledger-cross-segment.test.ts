import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * 第六批批 P0 切片 1（条 23）：**10.0e-A/B 轰炸账本的换段清零**
 *
 * 修前的病灶（三处同源，见 `docs/第六批修改方案.md` 条 23）：
 *   ① 账本只在 `setPhase()` / `setTurn()` / `resetAll()` 里清，而**正式推进换段走的是
 *      `advanceSegmentNow()` → `session.advanceToNextStop()` → `resetSegmentTransient()`**，
 *      那条路径独不清 ⇒ C 段空军炸过的格，到 F 段仍在账本里，10.0e-A 把炮兵的合法轰炸一并拒掉；
 *   ② `clearBarrage()` 不清 `barrageKind` / `barrageTargetKind` ⇒ 上一场的类型残留到下一场；
 *   ③ 记账不看 `hipShoot` ⇒ 低空扫射也占掉"每格每阶段一次"的额度（14.7d-A 明写不计入）。
 *
 * 条文（`_ocs_v43_clean.txt:1622-1638`）：
 *   10.0e-A「无论一个格内有多少不同类型的目标，**每个格在每个阶段中只允许被轰炸一次**。
 *           （例外：反舰船轰炸和低空扫射。）」
 *   10.0e-B「一个单位在一个阶段只能进行一次轰炸……」（**没有**给低空扫射开口子）
 *   14.7d-A「低空扫射**不计入**每个阶段内对一个格最多一次轰炸的限制。」
 *
 * ## 测法边界（如实交代）
 *   · 用真实地图、真实单位库、真实会话（`session.startGame()`）；
 *   · 换段走**真实入口** `workbench.advanceSegmentNow()`，不直接调 `setPhase`（那正是修前唯一没漏的路径）；
 *   · **不覆盖** 反舰船轰炸（18.3）的例外：本作无海军单位，代码如实登记未接线。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return {
    session: useGameSessionStore(),
    workbench: useWorkbenchStore(),
  }
}

/** 目标格：六邻皆图内（与既有轰炸夹具同口径） */
const TARGET_HEX: HexRef = (() => {
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

/** 参炸格：目标格的图内邻格（10.1a 射程按格计） */
const FIRING_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(TARGET_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)) continue
    return candidate
  }
  throw new Error('目标格没有图内邻格')
})()

/** 第二个目标格（同一门炮换个目标，用于"格账本"与"单位账本"分开断言） */
const TARGET2_HEX: HexRef = (() => {
  const found = HEX_DIRECTIONS.map((direction) => neighbor(FIRING_HEX, direction)).find(
    (candidate) =>
      isOnMap(candidate) &&
      !(candidate.col === TARGET_HEX.col && candidate.row === TARGET_HEX.row) &&
      mapLayers.hexes.some((hex) => hex.col === candidate.col && hex.row === candidate.row),
  )
  if (found === undefined) throw new Error('参炸格找不到第二个图内邻格')
  return found
})()

function artilleryRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find(
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )
  if (found === undefined) throw new Error('轴心国单位库中没有带轰炸值的火炮')
  return found
}

function rifleRecord(): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices('axis').find(
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) === 0,
  )
  if (found === undefined) throw new Error('轴心国单位库中没有不带轰炸值的战斗单位')
  return found
}

function place(
  store: ReturnType<typeof newStores>['workbench'],
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** B8：把 store 放到本段里允许做该动作的那个环节 */
function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

/** 备好一场可宣布的炮兵轰炸：目标格 + 参炸炮 + 足量补给来源 */
function setupBarrage(store: ReturnType<typeof newStores>['workbench'], gunId: string): void {
  if (!store.spDumps.some((dump) => dump.id === 'sd-b'))
    store.spDumps.push({ id: 'sd-b', hex: { ...FIRING_HEX }, side: 'axis', sp: 30, t: 0 })
  // 专规 3.4b：站与参炸单位同属一个装甲集群，免得本组用例被 3.4b 拦在门口
  store.setDumpPanzerGroupNow('sd-b', 'guderian')
  store.pickBarrageSupplyDump('sd-b')
  store.battleTarget = { hex: TARGET_HEX, defenderIds: ['def-1'] }
  store.setBarrageActive(true)
  store.toggleBarrageUnit(gunId)
}

/** 走完"宣布 → 付款"，把这一格与这一单位写进账本 */
function runBarrageToLedger(
  stores: ReturnType<typeof newStores>,
  gun: ConsoleUnit,
  target: HexRef = TARGET_HEX,
): void {
  const { workbench } = stores
  workbench.battleTarget = { hex: target, defenderIds: [`def-${target.col}-${target.row}`] }
  workbench.setBarrageActive(true)
  workbench.toggleBarrageUnit(gun.instanceId)
  expect(workbench.beginBarrageNow()).toBe(true)
  expect(workbench.confirmBarrageSupplyStep()).toBe(true)
}

/** 把会话推进到指定阶段（走真实入口 `advanceSegmentNow`） */
function advanceUntilPhase(stores: ReturnType<typeof newStores>, wanted: ConsolePhase): void {
  const { session, workbench } = stores
  session.startGame()
  for (let guard = 0; guard < 200; guard += 1) {
    if (workbench.phase === wanted) return
    if (session.awaiting) session.answerNow('first')
    workbench.advanceSegmentNow()
  }
  throw new Error(`推进不到 ${wanted} 段（当前：${workbench.phase}）`)
}

describe('第六批 P0-1：10.0e-A/B 账本的换段清零（条 23）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('★ ① 走真实入口 `advanceSegmentNow` 换段 ⇒ 账本清零（修前独漏这一条路径）', () => {
    const { workbench } = stores
    advanceUntilPhase(stores, 'reaction')
    const gun = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    place(workbench, rifleRecord(), TARGET_HEX, 'soviet', 'def-1')
    setupBarrage(workbench, gun.instanceId)
    runBarrageToLedger(stores, gun)
    expect(workbench.barragePhaseLedger.hexes).toEqual([`${TARGET_HEX.col}.${TARGET_HEX.row}`])
    workbench.cancelBarrage()

    // 换段（真实入口）⇒ 账本归零；再换一门炮打同一格不该再被 10.0e-A 拒
    const before = workbench.phase
    for (let guard = 0; guard < 40; guard += 1) {
      if (stores.session.awaiting) stores.session.answerNow('first')
      workbench.advanceSegmentNow()
      if (workbench.phase !== before) break
    }
    expect(workbench.phase).not.toBe(before)
    expect(workbench.barragePhaseLedger).toEqual({ hexes: [], unitIds: [] })

    // 新的阶段允许炮兵轰炸（10.0e-D 战斗段 / 10.0e-E 反应与进击段）
    const gun2 = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-2')
    goToActionStep(workbench, 'barrage.declare')
    workbench.battleTarget = { hex: TARGET_HEX, defenderIds: ['def-1'] }
    workbench.setBarrageActive(true)
    workbench.toggleBarrageUnit(gun2.instanceId)
    const accepted = workbench.beginBarrageNow()
    // 若被拒，只能是被别的规则拒，**绝不能**是"这一格本阶段已炸过"
    if (!accepted) expect(workbench.barrageError?.reason).not.toBe('hexAlreadyBarraged')
  })

  it('★ ② `clearBarrage()` 归位参炸类别与整体目标（10.0e-F / 10.0d 都是"一次轰炸内"的声明）', () => {
    const { workbench } = stores
    workbench.setPhase('combat')
    goToActionStep(workbench, 'barrage.declare')
    const gun = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    place(workbench, rifleRecord(), TARGET_HEX, 'soviet', 'def-1')
    setupBarrage(workbench, gun.instanceId)

    // 手动切到"空军 + 港口"（模拟上一场低空扫射/炸港留下的选择）
    workbench.setBarrageKind('air')
    workbench.setBarrageTargetKind('port')
    expect(workbench.barrageKind).toBe('air')
    expect(workbench.barrageTargetKind).toBe('port')

    workbench.cancelBarrage()
    expect(workbench.barrageKind).toBe('artillery')
    expect(workbench.barrageTargetKind).toBe('combatUnits')
  })

  it('★ ③ 14.7d-A：低空扫射不写格账本（不占"每格每阶段一次"的额度）', () => {
    const { workbench } = stores
    /*
     * 用**火炮夹具**驱动 `hipShoot` 标记：引擎没把 `hipShoot` 绑死在 `kind === 'air'` 上，
     * 而 10.0e-C/D 只允许火炮在战斗/反应/进击段轰炸（低空扫射实际发生在移动环节 ⇒ 需空军夹具）。
     * 本用例只钉**账本分支**（格不记 / 单位照记）；低空扫射的机型与环节限制由
     * `tests/engine/barrage.test.ts` 与空军任务用例覆盖。
     */
    workbench.setPhase('combat')
    goToActionStep(workbench, 'barrage.declare')
    const gun = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    place(workbench, rifleRecord(), TARGET_HEX, 'soviet', 'def-1')
    setupBarrage(workbench, gun.instanceId)
    // 14.7d-A/B：低空扫射单机 + 须有正确观察员（观察员由 `barrageTargetFacts` 推出）
    workbench.barrageInputs.hipShoot = true
    workbench.barrageInputs.hasSpotter = true

    expect(workbench.beginBarrageNow()).toBe(true)
    expect(workbench.confirmBarrageSupplyStep()).toBe(true)
    // 格账本为空（14.7d-A），单位账本照记（10.0e-B 没给低空扫射开口子）
    expect(workbench.barragePhaseLedger.hexes).toEqual([])
    expect(workbench.barragePhaseLedger.unitIds).toEqual([gun.instanceId])
  })

  it('④ 段内换环节**不清**账本（10.0e-A 按阶段计，不是按环节计）', () => {
    const { workbench } = stores
    workbench.setPhase('combat')
    goToActionStep(workbench, 'barrage.declare')
    const gun = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    place(workbench, rifleRecord(), TARGET_HEX, 'soviet', 'def-1')
    place(workbench, rifleRecord(), TARGET2_HEX, 'soviet', 'def-2')
    setupBarrage(workbench, gun.instanceId)
    runBarrageToLedger(stores, gun)
    workbench.cancelBarrage()

    expect(workbench.setSegmentStepIndex(0)).toBe(true)
    expect(workbench.barragePhaseLedger.hexes).toEqual([`${TARGET_HEX.col}.${TARGET_HEX.row}`])
  })

  it('⑤ 源码守卫：清零点合一（`resetSegmentTransient` 是唯一清零点，换段/换阶段/换回合/换方/复位都走它）', () => {
    const source = readFileSync('src/stores/workbench.ts', 'utf8')
    // ① `resetSegmentTransient` 里必须清
    const start = source.indexOf('function resetSegmentTransient(): void {')
    const body = source.slice(start, source.indexOf('\n  }', start))
    expect(body).toContain('clearBarragePhaseLedger()')
    // ② `setPhase` 里不再重复清（避免两条路径各清一半）
    const phaseStart = source.indexOf('function setPhase(next: ConsolePhase): void {')
    const phaseBody = source.slice(phaseStart, source.indexOf('\n  }', phaseStart))
    expect(phaseBody).not.toContain('clearBarragePhaseLedger()')
    // ③ 记账处看 `hipShoot`（14.7d-A）
    const recStart = source.indexOf('const barragedHex = barrageTargetHex.value')
    const recBody = source.slice(recStart, recStart + 900)
    expect(recBody).toContain('inputs.hipShoot !== true')
    // ④ `clearBarrage` 归位两个选择器，但**仍不动**账本
    const clearStart = source.indexOf('function clearBarrage(): void {')
    const clearBody = source.slice(clearStart, source.indexOf('\n  }', clearStart))
    expect(clearBody).toContain("barrageKind.value = 'artillery'")
    expect(clearBody).toContain("barrageTargetKind.value = 'combatUnits'")
    expect(clearBody).not.toContain('barragedHexesThisPhase')
  })
})
