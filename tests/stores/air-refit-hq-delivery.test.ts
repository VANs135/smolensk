import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { countSupplyDistance } from '@/engine/rules'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'

/**
 * 第五批 B6（docs/第五批修改方案.md 族 B6）：15.1 整备付款的候选补上 **12.3b 指挥部投递**半边
 *
 * 病灶：`airRefitPayDumps` 只收 `drawableDumpsFor`（12.3a 直拖/相邻）过滤出的站 ⇒
 * 基地 5MP 内无补给站、但在某指挥部投递距离内时，合法整备被拒（付费候选为空）。
 * 原文：12.6c/15.1——图上补给「可通过**直接拖取或从指挥部投递**获得」；
 * 对照：燃料链 `fuelSourceKeysOfUnit` 两半齐全（12.3a ∪ 12.3b）。
 *
 * ★ 测法边界（如实）：几何由**引擎判据搜索**得到（在**内圈**格上搜，两半都验证）——
 *   ① 基地→站：轮式 5MP **不可达**（12.3a 直拖不成立）；② 指挥部→基地格：轮式 ≤ 投递距离**可达**（12.3b）；
 *   ③ 站贴指挥部（HQ 自己 12.3a 拖得到它）。找不到即抛错（不静默通过）；断言落在 store 的
 *   `airRefitPayDumps` 投影上（无 HQ 一态、有 HQ 一态）。付款落盘路径不在本用例范围（由既有整备用例承担）。
 *   ★ 教训（与 §17.46 同源）：基地格必须取**内圈**——地图角落格的 Dijkstra 会返回 `unreachable`，
 *   让"投递可达"的几何搜索永远失败。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

const onMap = (hex: HexRef): boolean =>
  isOnMap(hex) && mapLayers.hexes.some((item) => item.col === hex.col && item.row === hex.row)

const grid = (a: HexRef, b: HexRef): number =>
  Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row))

/** 内圈格（列/行都离边 ≥ 8 ⇒ 轮式路径不会被图边截断；六邻皆图内） */
const INTERIOR_HEXES: HexRef[] = mapLayers.hexes
  .map((hex) => ({ col: hex.col, row: hex.row }))
  .filter(
    (ref) =>
      ref.col >= 8 &&
      ref.row >= 8 &&
      HEX_DIRECTIONS.every((direction) => onMap(neighbor(ref, direction))),
  )

/** 全部图内格（给站点搜索用；只按格距粗筛，合法性交引擎判据） */
const ALL_HEXES: HexRef[] = mapLayers.hexes.map((hex) => ({ col: hex.col, row: hex.row }))

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('第五批 B6：15.1 整备付款候选含「12.3b 指挥部投递」可达的补给站', () => {
  it('基地 5MP 内无站、但在某指挥部投递距离内 ⇒ 该站进入付款候选（12.3b）', () => {
    const store = newStore()
    const airBaseRecord = unitChoices('axis').find((record) => record.noncombatKind === 'air_base')
    const hqRecord = unitChoices('axis').find((record) => (record.specialized ?? []).includes('hq'))
    if (airBaseRecord === undefined || hqRecord === undefined) {
      throw new Error('单位库里缺空军基地或指挥部算子')
    }
    // 事实层先摆好基地（位置随搜索移动），用引擎的两条路径判据搜几何（搜到即用）
    const base = toConsoleUnit({
      record: airBaseRecord,
      instanceId: 'base-1',
      hex: INTERIOR_HEXES[0]!,
      side: 'axis',
    })
    store.units.push(base)
    let geometry: { baseC: HexRef; dumpC: HexRef; hqC: HexRef } | null = null
    for (const baseC of INTERIOR_HEXES) {
      base.hex = baseC
      for (const dumpC of ALL_HEXES) {
        if (grid(baseC, dumpC) < 6 || grid(baseC, dumpC) > 8) continue
        // ① 12.3a 不可直拖：基地 → 站 轮式 5MP 不可达
        const direct = countSupplyDistance(store.supplyFacts, {
          from: baseC,
          to: dumpC,
          side: 'axis',
          mobility: 'truck',
          maxMp: 5,
        })
        if (direct.ok) continue
        for (const direction of HEX_DIRECTIONS) {
          const hqC = neighbor(dumpC, direction)
          if (!onMap(hqC)) continue
          // ② 12.3b 投递可达：指挥部 → 基地格 轮式 ≤ 投递距离（8，军团战斗面印值）可达
          const throwReach = countSupplyDistance(store.supplyFacts, {
            from: hqC,
            to: baseC,
            side: 'axis',
            mobility: 'truck',
            maxMp: 8,
          })
          if (!throwReach.ok) continue
          geometry = { baseC, dumpC, hqC }
          break
        }
        if (geometry !== null) break
      }
      if (geometry !== null) break
    }
    if (geometry === null) {
      throw new Error('内圈找不到「12.3a 不可直拖 ∧ 12.3b 投递可达」的几何（用例前提不成立）')
    }
    base.hex = geometry.baseC
    store.spDumps.push({ id: 'd-far', hex: geometry.dumpC, side: 'axis', sp: 2, t: 0 })

    // 前提核对：没有 HQ ⇒ 该站**不**在候选（12.3a 直拖不成立）
    const withoutHq = store.airRefitPayDumps('base-1')
    expect(
      withoutHq.some((dump) => dump.id === 'd-far'),
      '12.3a 直拖不应包含它（前提）',
    ).toBe(false)

    // 摆上指挥部（贴站、投递覆盖基地格）⇒ 12.3b 半边把它带进候选
    store.units.push(
      toConsoleUnit({ record: hqRecord, instanceId: 'hq-1', hex: geometry.hqC, side: 'axis' }),
    )
    const pays = store.airRefitPayDumps('base-1')
    expect(
      pays.some((dump) => dump.id === 'd-far'),
      '12.3b：指挥部投递可达的补给站应进入 15.1B 付款候选',
    ).toBe(true)
  })
})
