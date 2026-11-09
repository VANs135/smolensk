import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { emptyReplHoldings } from '@/engine/rules'
import { useMapViewStore, useSetupStore, useWorkbenchStore } from '@/stores'

import { groundRecord, placeGround } from '../flows/sop-harness'
import type { Workbench } from '../flows/sop-harness'

/**
 * 左键堆叠窗的选中集（用户 2026-11-09）
 *
 * 口径：窗内只摆**战斗单位**，开窗默认**全部选中**；点某枚＝取消该单位选中、再点恢复；
 * 窗内不写说明文字（那部分由组件极简化，不在 store 单测里）。
 *
 * 非战斗（SP / 运输点）不进这个窗——它们的操作走右键菜单。
 */

const HEX: HexRef = { col: 15, row: 10 }
const OTHER: HexRef = { col: 16, row: 10 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('soviet')
  return { workbench, mapView: useMapViewStore() }
}

/** 战斗单位（单位库里的 `isCombat` 记录） */
function combatRecord() {
  return groundRecord('soviet', (record) => record.isCombat === true)
}

function placeInfantry(workbench: Workbench, id: string, hex: HexRef = HEX) {
  placeGround(workbench, combatRecord(), hex, 'soviet', id)
}

function addDump(workbench: Workbench): void {
  workbench.spDumps.push({ id: 'd1', hex: { ...HEX }, side: 'soviet', sp: 4, t: 0 })
}

describe('左键堆叠窗：默认全选战斗单位，点枚切换', () => {
  let s: ReturnType<typeof stores>

  beforeEach(() => {
    s = stores()
    placeInfantry(s.workbench, 'inf-a')
    placeInfantry(s.workbench, 'inf-b')
    addDump(s.workbench)
  })

  it('★ 开窗默认选中该格全部战斗单位，非战斗（SP）不算', () => {
    s.mapView.openPopup(HEX, 0, 0)
    expect([...s.mapView.stackPickIds].sort()).toEqual(['inf-a', 'inf-b'])
    expect(s.mapView.stackPickIds.some((id) => id.startsWith('sp:'))).toBe(false)
  })

  it('★ 点一枚＝取消选中；再点＝恢复', () => {
    s.mapView.openPopup(HEX, 0, 0)
    s.mapView.toggleStackPick('inf-a')
    expect([...s.mapView.stackPickIds]).toEqual(['inf-b'])
    s.mapView.toggleStackPick('inf-a')
    expect([...s.mapView.stackPickIds].sort()).toEqual(['inf-a', 'inf-b'])
  })

  it('★ 换格重开＝按新格重置全选（不沿用上一格的取消）', () => {
    s.mapView.openPopup(HEX, 0, 0)
    s.mapView.toggleStackPick('inf-a')
    expect([...s.mapView.stackPickIds]).toEqual(['inf-b'])

    placeInfantry(s.workbench, 'inf-c', OTHER)
    s.mapView.openPopup(OTHER, 0, 0)
    expect([...s.mapView.stackPickIds]).toEqual(['inf-c'])
  })

  it('★ 13.5 补员算子不算战斗单位：同格的 Pax 补员不列、也不默认选中', () => {
    // 补员记录在数据层写 `isCombat: true`，若不按 `replKind` 剔掉就会混进这个窗
    s.workbench.setReplHoldingsNow({ ...emptyReplHoldings(), pax: 1 }, HEX)
    const repls = s.workbench.units.filter((unit) => unit.replKind !== null)
    expect(repls).toHaveLength(1)

    s.mapView.openPopup(HEX, 0, 0)
    expect([...s.mapView.stackPickIds].sort()).toEqual(['inf-a', 'inf-b'])
    expect(s.mapView.popupContent?.units.some((token) => (token.replKind ?? null) !== null)).toBe(
      true,
    )
  })
})
