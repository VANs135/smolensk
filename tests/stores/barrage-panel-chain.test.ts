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
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * B15c：**炮击操作链**（方案 §4.2「选择集就是后续动作的参与集合」+ §4.3「唯一会话框」）
 *
 * 补的两个缺口（与 B15b 同形）：
 *   ① **选择集没有镜像到参炸名单**：地图摊开点枚只同步给移动的取子清单 ⇒ 炮击仍要在小窗里逐枚点
 *      "发起轰炸"。本批新增 `syncBarrageParticipants(hex, ids)`（逐格镜像，候选＝`barrageUnitChoices`，
 *      落点仍是既有的 `toggleBarrageUnit`）；
 *   ② **宣布之前没有会话**：会话只在 `barrageState !== null` 时挂载 ⇒ 现在**选了参炸单位即生成**
 *      「宣布轰炸（10.0d）」会话；取消＝`clearBarrageSelectionNow()`（宣布之前无账可回滚）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
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

/** 参炸格：目标格的图内邻格（10.1a 射程按格） */
const FIRING_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(TARGET_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)) continue
    return candidate
  }
  throw new Error('目标格没有图内邻格')
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

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B15c：选择集 → 参炸名单（§4.2）', () => {
  it('★ 逐格镜像：该格选中的参炸单位进名单，取消即移出', () => {
    const { workbench } = newStores()
    workbench.setPhase('movement')
    workbench.setBarrageActive(true)
    const a = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    const b = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-2')

    workbench.syncBarrageParticipants(FIRING_HEX, [a.instanceId, b.instanceId])
    expect(workbench.barrageUnitIds.sort()).toEqual([a.instanceId, b.instanceId].sort())

    workbench.syncBarrageParticipants(FIRING_HEX, [b.instanceId])
    expect(workbench.barrageUnitIds).toEqual([b.instanceId])
  })

  it('候选＝`barrageUnitChoices`（同一份判据）：**没有印刷轰炸值**的同格单位不会被镜像进去', () => {
    const { workbench } = newStores()
    workbench.setPhase('movement')
    workbench.setBarrageActive(true)
    const gun = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    const rifle = place(workbench, rifleRecord(), FIRING_HEX, 'axis', 'rifle-1')

    workbench.syncBarrageParticipants(FIRING_HEX, [gun.instanceId, rifle.instanceId])
    expect(workbench.barrageUnitIds).toEqual([gun.instanceId])
  })

  it('敌方单位不会被镜像（10.0e：只有当前方能参炸）', () => {
    const { workbench } = newStores()
    workbench.setPhase('movement')
    workbench.setBarrageActive(true)
    const enemy = place(workbench, artilleryRecord(), FIRING_HEX, 'soviet', 'art-enemy')
    workbench.syncBarrageParticipants(FIRING_HEX, [enemy.instanceId])
    expect(workbench.barrageUnitIds).toEqual([])
  })
})

describe('B15c：宣布之前的轰炸会话（§4.2 / §4.3）', () => {
  it('★ 选了参炸单位（且工具开着）⇒ 生成「宣布轰炸」会话；未选则不生成', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('movement')
    const gun = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')

    // 工具没开 ⇒ 不生成会话（轰炸不会自己冒出来）
    expect(mapView.session).toBeNull()
    workbench.setBarrageActive(true)
    expect(mapView.session).toBeNull()

    workbench.toggleBarrageUnit(gun.instanceId)
    // 会话只看「工具开着 + 有选子」——**与环节无关**：选子可以先备好，等环节到了再宣布
    expect(mapView.session).toMatchObject({ kind: 'barrage', rule: '10.0d' })
    expect(mapView.session?.title).toContain('宣布轰炸')
  })

  it('★ 会话取消 ⇒ 退掉尚未宣布的选子（无账可回滚），会话随之消失', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('movement')
    workbench.setBarrageActive(true)
    const gun = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    workbench.toggleBarrageUnit(gun.instanceId)
    expect(mapView.session?.rule).toBe('10.0d')

    expect(mapView.cancelSession()).toBe(true)
    expect(workbench.barrageUnitIds).toEqual([])
    expect(workbench.barrageState).toBeNull()
    expect(mapView.session).toBeNull()
  })

  it('宣布之后会话换成 10.0 的结算（同一条会话、不同规则号）', () => {
    const { workbench, mapView } = newStores()
    workbench.setPhase('combat')
    // B8：F 段首环是炮击 ⇒ 宣布轰炸前先进轰炸环节
    goToActionStep(workbench, 'barrage.declare')
    const gun = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    const defender = place(workbench, rifleRecord(), TARGET_HEX, 'soviet', 'def-1')
    workbench.battleTarget = { hex: TARGET_HEX, defenderIds: [defender.instanceId] }
    workbench.setBarrageActive(true)
    workbench.toggleBarrageUnit(gun.instanceId)
    expect(mapView.session?.rule).toBe('10.0d')

    expect(workbench.beginBarrageNow()).toBe(true)
    expect(workbench.barrageState?.step).toBe('supply')
    expect(mapView.session).toMatchObject({ kind: 'barrage', rule: '10.0' })
  })
})

/**
 * A 组接线（`docs/问题总清单.md` A-1/A-2）：**10.0e-A/B 的按阶段轰炸账本**
 *
 * 条文：「每格每阶段只允许被轰炸**一次**」（10.0e-A）、「一个单位每阶段只能轰炸**一次**」（10.0e-B）。
 * 修前这两条只靠面板上一个玩家勾选自报 ⇒ 本组钉住"不勾也拦得住"，以及账本的三个边界：
 *   ① 记账时点在**付完补给之后**（10.1b：付不出则全部取消且**不视为已轰炸过**）；
 *   ② 关掉轰炸工具再打开**不能**绕过（`clearBarrage` 不动账本）；
 *   ③ 换阶段即清零（每阶段一次）。
 */
describe('A 组：10.0e-A/B 的按阶段轰炸账本', () => {
  /** 第二对"目标格 / 邻格"（用于"同一单位换一格再炸"） */
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

  /** 备好一场可宣布的轰炸：目标格 + 参炸单位 + 足量补给来源 */
  function setupBarrage(store: ReturnType<typeof newStores>['workbench'], gunId: string): void {
    if (!store.spDumps.some((dump) => dump.id === 'sd-b'))
      store.spDumps.push({ id: 'sd-b', hex: { ...FIRING_HEX }, side: 'axis', sp: 30, t: 0 })
    /*
     * 专规 3.4b：轴方 SP 必须归属某一装甲集群，且"错误"集群的 SP 不能付多单位编队的轰炸成本。
     * 库里的火炮都属装甲/摩托化编队（已印 `panzerGroup`），故这里把补给站登记成同一集群，
     * 免得本组用例被 3.4b 拦在门口（那一条另有自己的用例覆盖）。
     */
    store.setDumpPanzerGroupNow('sd-b', 'guderian')
    store.pickBarrageSupplyDump('sd-b')
    store.battleTarget = { hex: TARGET_HEX, defenderIds: ['def-1'] }
    store.setBarrageActive(true)
    store.toggleBarrageUnit(gunId)
  }

  it('★ 一场打完（付了补给）⇒ 账本记下这一格与这些单位', () => {
    const { workbench } = newStores()
    workbench.setPhase('combat')
    goToActionStep(workbench, 'barrage.declare')
    const gun = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    place(workbench, rifleRecord(), TARGET_HEX, 'soviet', 'def-1')
    setupBarrage(workbench, gun.instanceId)

    expect(workbench.beginBarrageNow()).toBe(true)
    expect(workbench.barragePhaseLedger).toEqual({ hexes: [], unitIds: [] }) // 还没付 ⇒ 未记账
    expect(workbench.confirmBarrageSupplyStep()).toBe(true)
    expect(workbench.barragePhaseLedger.hexes).toEqual([`${TARGET_HEX.col}.${TARGET_HEX.row}`])
    expect(workbench.barragePhaseLedger.unitIds).toEqual([gun.instanceId])
  })

  it('★ 10.0e-B：同一个单位本阶段再炸（哪怕换一格）⇒ 拒', () => {
    const { workbench } = newStores()
    workbench.setPhase('combat')
    goToActionStep(workbench, 'barrage.declare')
    const gun = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    place(workbench, rifleRecord(), TARGET_HEX, 'soviet', 'def-1')
    place(workbench, rifleRecord(), TARGET2_HEX, 'soviet', 'def-2')
    setupBarrage(workbench, gun.instanceId)
    expect(workbench.beginBarrageNow()).toBe(true)
    expect(workbench.confirmBarrageSupplyStep()).toBe(true)
    workbench.cancelBarrage() // 中止本场（账本不动）

    // 换一格、还是这一门炮 ⇒ 10.0e-B
    workbench.setBarrageActive(true)
    workbench.battleTarget = { hex: TARGET2_HEX, defenderIds: ['def-2'] }
    workbench.toggleBarrageUnit(gun.instanceId)
    expect(workbench.beginBarrageNow()).toBe(false)
    expect(workbench.barrageError?.rule).toBe('10.0e-B')
    expect(workbench.barrageError?.reason).toBe('unitAlreadyBarraged')
  })

  it('★ 10.0e-A：换一门炮打**同一格** ⇒ 拒（每格每阶段一次）', () => {
    const { workbench } = newStores()
    workbench.setPhase('combat')
    goToActionStep(workbench, 'barrage.declare')
    const gun = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    const gun2 = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-2')
    place(workbench, rifleRecord(), TARGET_HEX, 'soviet', 'def-1')
    setupBarrage(workbench, gun.instanceId)
    expect(workbench.beginBarrageNow()).toBe(true)
    expect(workbench.confirmBarrageSupplyStep()).toBe(true)
    workbench.cancelBarrage()

    // 同样的目标格、另一门炮（它本阶段还没炸过）⇒ 只可能是 10.0e-A
    workbench.setBarrageActive(true)
    workbench.battleTarget = { hex: TARGET_HEX, defenderIds: ['def-1'] }
    workbench.toggleBarrageUnit(gun2.instanceId)
    expect(workbench.beginBarrageNow()).toBe(false)
    expect(workbench.barrageError?.rule).toBe('10.0e-A')
    expect(workbench.barrageError?.reason).toBe('hexAlreadyBarraged')
  })

  it('★ 关掉轰炸工具再打开**不能**绕过账本；换阶段才清零', () => {
    const { workbench } = newStores()
    workbench.setPhase('combat')
    goToActionStep(workbench, 'barrage.declare')
    const gun = place(workbench, artilleryRecord(), FIRING_HEX, 'axis', 'art-1')
    place(workbench, rifleRecord(), TARGET_HEX, 'soviet', 'def-1')
    setupBarrage(workbench, gun.instanceId)
    expect(workbench.beginBarrageNow()).toBe(true)
    expect(workbench.confirmBarrageSupplyStep()).toBe(true)
    workbench.cancelBarrage()

    // ① 同一个阶段里重来 ⇒ 仍被账本拦住
    workbench.setBarrageActive(true)
    workbench.battleTarget = { hex: TARGET_HEX, defenderIds: ['def-1'] }
    workbench.toggleBarrageUnit(gun.instanceId)
    expect(workbench.beginBarrageNow()).toBe(false)
    expect(workbench.barrageError?.rule).toBe('10.0e-B')

    // ② 换阶段（新的阶段 ＝ 新的一次）⇒ 账本清零，同样的宣布重新可行
    workbench.setPhase('reaction')
    expect(workbench.barragePhaseLedger).toEqual({ hexes: [], unitIds: [] })
    goToActionStep(workbench, 'barrage.declare')
    workbench.setBarrageActive(true)
    workbench.battleTarget = { hex: TARGET_HEX, defenderIds: ['def-1'] }
    workbench.toggleBarrageUnit(gun.instanceId)
    expect(workbench.beginBarrageNow()).toBe(true)
  })

  it('源码守卫：账本喂给引擎的两条事实，且清零点齐全（换阶段 / 换回合 / 复位）', () => {
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(store).toContain('barragedHexesThisPhase')
    expect(store).toContain('barragedUnitIdsThisPhase')
    expect(store).toContain('hexAlreadyBarragedThisPhase:')
    expect(store).toContain('unitAlreadyBarragedThisPhase: firingIds.some(')
    // 三处清零（`setPhase` / `setTurn` / `resetAll`）都走同一个函数
    const clears = store.match(/clearBarragePhaseLedger\(\)/g) ?? []
    expect(clears.length).toBeGreaterThanOrEqual(4) // 定义 1 次 + 调用 ≥3 次
    // `clearBarrage`（关工具/换方/复位）**不动**账本——否则关一下工具就能绕过
    const start = store.indexOf('function clearBarrage(): void {')
    const body = store.slice(start, store.indexOf('}', start))
    expect(body).not.toContain('barragedHexesThisPhase')
  })
})

describe('B15c：接线（源码守卫）', () => {
  it('地图摊开时的点选会镜像到参炸名单（只在轰炸工具开着且未宣布时）', () => {
    const store = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(store).toContain('workbench.syncBarrageParticipants(hex, stackSelection.value)')
    expect(store).toContain('workbench.barrageActive && workbench.barrageState === null')
  })

  it('镜像只走既有的 `toggleBarrageUnit`，候选只取 `barrageUnitChoices`（不另筛一遍）', () => {
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    const start = store.indexOf('function syncBarrageParticipants')
    const section = store.slice(start, start + 900)
    expect(section).toContain('barrageUnitChoices.value')
    expect(section).toContain('toggleBarrageUnit(unit.instanceId)')
  })

  it('取消路径分两档：未宣布 ⇒ `clearBarrageSelectionNow`；已宣布 ⇒ `cancelBarrage`', () => {
    const store = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(store).toContain('workbench.clearBarrageSelectionNow()')
    expect(store).toContain('workbench.cancelBarrage()')
  })
})
