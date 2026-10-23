import { createPinia, setActivePinia } from 'pinia'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
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
