import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { drawMovementOverlay, type MovementOverlay, type UnitToken } from '@/render/token-layer'
import {
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
  unitChoices,
} from '@/stores'

import { placeGround } from '../flows/sop-harness'

/**
 * ★ 用户 2026-11-15（实机试玩第 2 项）：**运输点数运载补给时，点数上方要挂一个「运载 SP」标记**。
 *
 * 口径：极简、不可用项不出现 —— 只有真的载着 SP 的运输点才出现标记，空载不画；
 * 标记读的是引擎的 `loadedSpT`（13.2f/h：1 SP = 4 T），本层不另算规则。
 */
const HEX: HexRef = { col: 15, row: 10 }

function stores() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('soviet')
  useHotseatStore().setViewerSide('soviet')
  return { workbench, mapView: useMapViewStore() }
}

/** 苏军单位库里的通用运输点数（13.2a：`noncombatKind === 'transport_point'`） */
function transportPointRecord() {
  const found = unitChoices('soviet').find((record) => record.noncombatKind === 'transport_point')
  if (found === undefined) throw new Error('苏军单位库中没有运输点数算子')
  return found
}

describe('运输点数：载着 SP 才在令牌投影里带运载量', () => {
  it('载 8T（2 SP）⇒ carriedSp = 2', () => {
    const { workbench, mapView } = stores()
    placeGround(workbench, transportPointRecord(), HEX, 'soviet', 'tp-1')
    const unit = workbench.units.find((item) => item.instanceId === 'tp-1')
    if (unit === undefined) throw new Error('运输点未落位')
    unit.loadedSpT = 8

    const token = mapView.overlay.tokens.find((item) => item.id === 'tp-1')
    expect(token?.carriedSp).toBe(2)
  })

  it('空载 ⇒ 不带运载量（不可用项不出现）', () => {
    const { workbench, mapView } = stores()
    placeGround(workbench, transportPointRecord(), HEX, 'soviet', 'tp-1')
    const unit = workbench.units.find((item) => item.instanceId === 'tp-1')
    if (unit === undefined) throw new Error('运输点未落位')
    unit.loadedSpT = 0

    const token = mapView.overlay.tokens.find((item) => item.id === 'tp-1')
    expect(token?.carriedSp ?? null).toBeNull()
  })
})

interface Recorder {
  texts: string[]
}

/** 记录型假 CanvasRenderingContext2D（只实现本用例用到的成员） */
function makeCtx(): { ctx: CanvasRenderingContext2D; rec: Recorder } {
  const rec: Recorder = { texts: [] }
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
    beginPath: (): void => undefined,
    moveTo: (): void => undefined,
    lineTo: (): void => undefined,
    closePath: (): void => undefined,
    arc: (): void => undefined,
    fill: (): void => undefined,
    stroke: (): void => undefined,
    fillRect: (): void => undefined,
    strokeRect: (): void => undefined,
    fillText: (text: string): void => {
      rec.texts.push(String(text))
    },
    setLineDash: (): void => undefined,
    drawImage: (): void => undefined,
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rec }
}

function tokenWith(carriedSp: number | null): UnitToken {
  return {
    id: 'tp-1',
    hex: HEX,
    side: 'soviet',
    label: '1-0-6',
    selected: false,
    ended: false,
    modeLetter: 'M',
    dg: false,
    awaitingFuel: false,
    fuelled: false,
    noncombatKind: 'transport_point',
    carriedSp,
  }
}

function overlay(tokens: UnitToken[]): MovementOverlay {
  return { tokens, reachable: [], path: [], startHex: null, selectedIds: [] }
}

describe('运输点数：载着 SP 时在点数上方画运载标记', () => {
  it('载 2 SP ⇒ 令牌上沿出现「载 2 SP」', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, overlay([tokenWith(2)]), 1)
    expect(rec.texts).toContain('载 2 SP')
  })

  it('空载 ⇒ 不画运载标记', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, overlay([tokenWith(null)]), 1)
    expect(rec.texts.some((text) => text.includes('载'))).toBe(false)
  })
})
