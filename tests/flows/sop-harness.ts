import { createPinia, setActivePinia } from 'pinia'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, hexDistance, isOnMap, neighbor } from '@/engine/hex-geometry'
import type { AirStatus } from '@/engine/state-types'
import {
  aircraftChoices,
  toConsoleAirUnit,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ConsoleAirUnit,
  type ConsoleUnit,
} from '@/stores'

/**
 * **SOP 分环节测试台**（共享夹具，非测试文件）
 *
 * 目的：让 2.2 流程表里的**每一个环节**都能被独立拉起、独立验证——不必重放前序环节。
 * 用法：每个环节一个 `tests/flows/NN-phase-*.test.ts`，各自 `import` 本文件的夹具，
 * 于是 `npx vitest run tests/flows/30-phase-c-movement.test.ts` 即可单跑该环节。
 *
 * 纪律（CODE_SPEC §7）：
 *   - 夹具只**摆放真实数据**（真实地图格 + 真实单位库/飞机库记录），不造数；
 *   - 一切结论由引擎给出，测试只断言「流程走通 + 状态写对 + 规则编号对得上」；
 *   - 测试名带规则编号（如 `15.1A`、`2.2`），便于反向检索规则书。
 */

/** 六邻皆图内的格：断言不受地图削角影响（放基地/飞机/堆叠都用它） */
export const CORE_HEX: HexRef = (() => {
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

/** CORE_HEX 的一个图内邻格（格距 1；转移/拦截/相邻攻击用） */
export const NEAR_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(CORE_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)
    ) {
      return candidate
    }
  }
  throw new Error('CORE_HEX 没有图内邻格')
})()

/**
 * 三面环沼泽的 Woods 口袋（7.21）：**地形断补**的对照夹具
 *
 * 这里只用于"地形把补给路径整段切掉"这一类用例（用户要求：地形断补与 ZOC 断补两类并存）。
 * 「断补」本身应优先用 {@link sealTraceSupplyByZoc}（敌方 ZOC 卡断）构造——
 * 那才是在验 12.6 / 12.3d 的阻断判据，而不是拿地形死角绕开判据。
 */
export const SWAMP_POCKET_HEX: HexRef = { col: 7, row: 21 }

/**
 * 可被**纯 ZOC** 卡断的内部格（3.2，Woods）：第一圈六邻都能在第二圈摆敌子覆盖。
 *
 * 与 CORE_HEX（2.1）的区别：2.1 在地图角，第一圈有两格没有第二圈（只能"敌占"补齐）；
 * 而敌占会让被围格**自身**落入敌方 ZOC —— HQ/空军基地这类**非战斗单位**不抵消 ZOC（4.5b），
 * 于是"同格声明补给源"会被 12.6b 判为源不可用。需要"卡断 + 同格源仍可用"的用例（如 21.10 Forage）
 * 必须用本格：纯 ZOC 卡断不动第一圈，被围格自己不在 EZOC 里。
 */
export const ZOC_SEAL_HEX: HexRef = { col: 3, row: 2 }

/**
 * 12.3d：把一格从补给网上卡断（构造"断补"前提的推荐夹具）
 *
 * 原文（12.3d）：「绝不能穿越包含敌方战斗单位的格；用卡车 MP 时，一个未被抵消的敌方 ZOC 格会
 *   阻挡**进入或离开该格**的补给路径」。
 *
 * 做法：在**第二圈**（距 `hex` 两步）摆敌方可攻击战斗单位，让它们的 ZOC 覆盖第一圈——
 * 敌子**不占**第一圈，不影响堆叠、相邻攻击、突围落点等夹具语义。这就是"纯 ZOC 卡断"。
 *
 * ★ 地图边缘的格（如 2.1）第一圈有邻格**没有**第二圈可摆（圈外不在图内），此时按 `allowOccupation`
 *   在该邻格直接放敌子——同属 12.3d 的「不得穿越敌方战斗单位」，**不是**地形断补。
 *   默认 `allowOccupation = false`：要求纯 ZOC，摆不出来就抛错（避免静默换成别的判据）。
 *
 * @returns 摆下的敌子；`pureZoc` 为真表示全部由 ZOC 封住（应当有 ≥2-3 个用例显式断言它）
 */
export function sealTraceSupplyByZoc(
  store: Workbench,
  hex: HexRef,
  side: Side = 'axis',
  allowOccupation = false,
): { placed: ConsoleUnit[]; pureZoc: boolean } {
  const enemy: Side = side === 'axis' ? 'soviet' : 'axis'
  const record = groundRecord(
    enemy,
    (item) => item.isCombat === true && item.attackCapable === true,
  )
  const onMapHexes = mapLayers.hexes.map((item) => ({ col: item.col, row: item.row }))
  const ringOne = HEX_DIRECTIONS.map((direction) => neighbor(hex, direction)).filter((item) =>
    isOnMap(item),
  )
  // 4.5b：第一圈若已有己方战斗单位，该格的敌方 ZOC 被抵消 ⇒ 封不住（夹具错误，直接炸）
  const friendlyInRing = ringOne.find((item) =>
    store.units.some(
      (unit) => unit.side === side && unit.hex.col === item.col && unit.hex.row === item.row,
    ),
  )
  if (friendlyInRing !== undefined) {
    throw new Error(`第一圈 ${label(friendlyInRing)} 有己方单位（4.5b 抵消 ZOC）⇒ 无法卡断`)
  }
  const occupied = new Set<string>()
  const placed: ConsoleUnit[] = []
  const occupiedAt = (item: HexRef): boolean =>
    store.units.some((unit) => unit.hex.col === item.col && unit.hex.row === item.row)
  /** 该第一圈格此刻是否已被封住：敌占，或被已摆敌子的 ZOC 覆盖 */
  const blockedAt = (item: HexRef): boolean =>
    occupied.has(label(item)) || placed.some((enemyUnit) => hexDistance(enemyUnit.hex, item) === 1)

  // ① 第二圈覆盖不到的第一圈格：只能按 12.3d 的"敌占"封（仅 allowOccupation 时允许）
  for (const item of ringOne) {
    const hasRingTwo = onMapHexes.some(
      (candidate) =>
        hexDistance(candidate, hex) === 2 &&
        hexDistance(candidate, item) === 1 &&
        !occupiedAt(candidate),
    )
    if (hasRingTwo) continue
    if (!allowOccupation) {
      throw new Error(`无法用纯 ZOC 卡断 ${label(hex)}：${label(item)} 第二圈不在图内`)
    }
    if (occupiedAt(item)) {
      occupied.add(label(item))
      continue
    }
    placed.push(placeGround(store, record, item, enemy, `zoc-seal-${item.col}-${item.row}`))
    occupied.add(label(item))
  }

  // ② 其余第一圈格：贪婪地挑第二圈格，让敌子的 ZOC 覆盖它们
  while (ringOne.some((item) => !blockedAt(item))) {
    let best: HexRef | null = null
    let bestGain = 0
    for (const candidate of onMapHexes) {
      if (hexDistance(candidate, hex) !== 2) continue
      if (occupiedAt(candidate)) continue
      const gain = ringOne.filter(
        (item) => !blockedAt(item) && hexDistance(item, candidate) === 1,
      ).length
      if (gain > bestGain) {
        bestGain = gain
        best = candidate
      }
    }
    if (best === null) break
    placed.push(placeGround(store, record, best, enemy, `zoc-seal-${best.col}-${best.row}`))
  }
  if (ringOne.some((item) => !blockedAt(item))) {
    throw new Error(`无法卡断 ${label(hex)}（第二圈已被占用或不在图内）`)
  }
  return { placed, pureZoc: occupied.size === 0 }
}

/** 格号文本（操作台输入用，如 `36.13`） */
export const label = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 全新操作台（每个用例独立 Pinia，互不串状态） */
export function newConsole() {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

export type Workbench = ReturnType<typeof newConsole>

/** 摆一个地面算子（真实单位库记录 → 操作台算子） */
export function placeGround(
  store: Workbench,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: Side,
  instanceId: string,
  face: 'combat' | 'move' = 'combat',
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face })
  store.units.push(unit)
  return unit
}

/** 摆一架飞机（真实飞机库记录；默认激活，停在给定基地格） */
export function placeAir(
  store: Workbench,
  record: ReturnType<typeof aircraftChoices>[number],
  hex: HexRef,
  side: Side,
  instanceId: string,
  airStatus: AirStatus = 'active',
): ConsoleAirUnit {
  const air = toConsoleAirUnit({ aircraft: record, instanceId, hex, side, airStatus })
  store.airUnits.push(air)
  return air
}

/** 单位库取记录（找不到即失败，避免静默用错夹具） */
export function groundRecord(
  side: Side,
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

/** 飞机库取记录（找不到即失败） */
export function aircraftRecord(
  side: Side,
  predicate: (record: ReturnType<typeof aircraftChoices>[number]) => boolean,
): ReturnType<typeof aircraftChoices>[number] {
  const found = aircraftChoices(side).find(predicate)
  if (found === undefined) throw new Error(`飞机库中没有满足条件的 ${side} 记录`)
  return found
}

/** 空军基地算子（15.0；单位库里是中立算子，摆放时按 side 决定归属） */
export function airBaseRecord(level?: number): ReturnType<typeof unitChoices>[number] {
  return groundRecord('axis', (record) =>
    level === undefined
      ? record.noncombatKind === 'air_base'
      : record.noncombatKind === 'air_base' && (record.noncombatDetails?.level ?? 0) === level,
  )
}

/** 战斗机（14.1：唯一能拦截、能在空战中作为攻击者的机种） */
export function fighterRecord(side: Side): ReturnType<typeof aircraftChoices>[number] {
  return aircraftRecord(side, (record) => record.aircraftType === 'F')
}

/** 轰炸机（14.7b：战术/战略轰炸机，有印刷轰炸值） */
export function bomberRecord(side: Side): ReturnType<typeof aircraftChoices>[number] {
  return aircraftRecord(
    side,
    (record) => record.aircraftType === 'T' && (record.barrageStrength ?? 0) > 0,
  )
}

/** 带轰炸值的火炮（10.0e-B / 10.1b） */
export function artilleryRecord(side: Side): ReturnType<typeof unitChoices>[number] {
  return groundRecord(
    side,
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )
}

/** 地面战斗单位（9.0：有战斗值、可攻击） */
export function combatRecord(side: Side): ReturnType<typeof unitChoices>[number] {
  return groundRecord(
    side,
    (record) =>
      record.isCombat === true && record.attackCapable === true && (record.reSize ?? 0) > 0,
  )
}
