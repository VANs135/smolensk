import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import {
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  unitChoices,
} from '@/stores'

import { placeGround } from '../flows/sop-harness'

/**
 * ★ 用户 2026-11-10：**同格 SP 重复**（未勾 3.4b 时一亮一灰）。
 *
 * 盘面上的 SP 计数算子与补给账本（`spDumps`）是同一件事；两边各画一枚 ⇒ 同格两枚，
 * 其中"本环节不参与"的那枚被灰显。修法：账本覆盖的「方:格」不再画盘面 SP 算子
 * （同格多枚本来就由 `spDumpTokens` 合并成一枚）；没有账本的 SP 算子照旧显示。
 * 3.4b 开启时账本按集群拆出的两三枚保持原样（本测试不依赖集群归属，只保证不叠加第四枚）。
 */
const HEX: HexRef = { col: 15, row: 10 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('soviet')
  // 2026-11-11：观察方手动选（不再随行动方自动切），测试里与行动方对齐
  useHotseatStore().setViewerSide('soviet')
  return { workbench, mapView: useMapViewStore() }
}

/** 苏军单位库里的 SP 点数算子（非战斗、`noncombatDetails.spValue > 0`） */
function spRecord() {
  const found = unitChoices('soviet').find(
    (record) => record.isCombat !== true && (record.noncombatDetails?.spValue ?? 0) > 0,
  )
  if (found === undefined) throw new Error('苏军单位库中没有 SP 点数算子')
  return found
}

describe('同格 SP：账本与盘面算子不各画一枚', () => {
  it('有账本 ⇒ 同格只出一枚（以账本为准，标签是账本总量）', () => {
    const { workbench, mapView } = stores()
    placeGround(workbench, spRecord(), HEX, 'soviet', 'sp-unit-1')
    workbench.spDumps.push({ id: 'sp:15,10', hex: { ...HEX }, side: 'soviet', sp: 4, t: 0 })

    const tokens = mapView.overlay.tokens.filter((token) => token.noncombatKind === 'sp')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.id).toBe('sp:15,10')
    expect(tokens[0]!.label).toBe('4 SP')
  })

  it('没有账本 ⇒ SP 算子照旧显示（去重不吞算子）', () => {
    const { workbench, mapView } = stores()
    placeGround(workbench, spRecord(), HEX, 'soviet', 'sp-unit-1')

    const tokens = mapView.overlay.tokens.filter((token) => token.noncombatKind === 'sp')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.id).toBe('sp-unit-1')
  })

  it('账本在别格 ⇒ 本格 SP 算子不受影响', () => {
    const { workbench, mapView } = stores()
    placeGround(workbench, spRecord(), HEX, 'soviet', 'sp-unit-1')
    workbench.spDumps.push({
      id: 'sp:16,10',
      hex: { col: 16, row: 10 },
      side: 'soviet',
      sp: 2,
      t: 0,
    })

    const tokens = mapView.overlay.tokens.filter((token) => token.noncombatKind === 'sp')
    expect(tokens.map((token) => token.id).sort()).toEqual(['sp-unit-1', 'sp:16,10'])
  })
})
