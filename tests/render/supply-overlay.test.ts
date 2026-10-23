import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { drawMovementOverlay, type MovementOverlay } from '@/render/token-layer'

/**
 * 补给覆盖层的绘制（C8：拖取/投递可视化）
 *
 * Canvas 需要浏览器，故用**记录型假 ctx** 断言「画了什么」：
 *   · 覆盖范围内的每格都要落一个补给消耗数字（12.3d 的距离）；
 *   · 最省路径要有折点（与移动预览的虚线区分）；
 *   · 来源格与受补给格要各自高亮。
 * 本测试只验证「把给定数据画出来」，规则结论由 `tests/engine/supply-interaction.test.ts` 负责。
 */

interface Recorder {
  strokes: number
  arcs: number
  texts: string[]
  rects: [number, number, number, number][]
  dashes: number
}

/** 记录型假 CanvasRenderingContext2D（只实现覆盖层用到的成员） */
function makeCtx(): { ctx: CanvasRenderingContext2D; rec: Recorder } {
  const rec: Recorder = { strokes: 0, arcs: 0, texts: [], rects: [], dashes: 0 }
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
    arc: (): void => {
      rec.arcs += 1
    },
    fill: (): void => undefined,
    stroke: (): void => {
      rec.strokes += 1
    },
    fillRect: (x: number, y: number, width: number, height: number): void => {
      rec.rects.push([x, y, width, height])
    },
    strokeRect: (): void => undefined,
    fillText: (text: string): void => {
      rec.texts.push(String(text))
    },
    setLineDash: (): void => {
      rec.dashes += 1
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rec }
}

const EMPTY_OVERLAY: MovementOverlay = {
  tokens: [],
  reachable: [],
  path: [],
  startHex: null,
  selectedIds: [],
}

const hex = (row: number): HexRef => ({ col: 36, row })

describe('C8 补给覆盖层绘制', () => {
  it('铺出覆盖范围（每格一个消耗数字）+ 最省路径折点 + 来源/目标高亮', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(
      ctx,
      {
        ...EMPTY_OVERLAY,
        supply: {
          coverage: [
            { hex: hex(13), mp: 0 },
            { hex: hex(14), mp: 1 },
            { hex: hex(15), mp: 1.5 },
          ],
          path: [hex(13), hex(14)],
          sourceHex: hex(13),
          targetHex: hex(16),
          viaAdjacency: true,
        },
      },
      1,
    )

    // 12.3d：覆盖范围内的补给消耗（整数不带小数点，半格保留一位 —— 与移动覆盖层同一 formatMp）
    expect(rec.texts).toEqual(['0', '1', '1.5'])
    // 路径两个折点
    expect(rec.arcs).toBe(2)
    // 来源格的实心方框
    expect(rec.rects).toHaveLength(1)
    // 覆盖 3 格 + 路径 + 目标格外框各有描边
    expect(rec.strokes).toBe(5)
    expect(rec.dashes).toBe(0)
  })

  it('没有补给覆盖层时不画任何补给元素（C5 移动覆盖层不受影响）', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, { ...EMPTY_OVERLAY, supply: null }, 1)
    expect(rec.texts).toHaveLength(0)
    expect(rec.arcs).toBe(0)
    expect(rec.rects).toHaveLength(0)
  })

  it('只有来源格（无可达范围、无路径）时也只画该高亮', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(
      ctx,
      {
        ...EMPTY_OVERLAY,
        supply: {
          coverage: [],
          path: [],
          sourceHex: hex(20),
          targetHex: null,
          viaAdjacency: false,
        },
      },
      1,
    )
    expect(rec.rects).toHaveLength(1)
    expect(rec.texts).toHaveLength(0)
    expect(rec.arcs).toBe(0)
  })
})

describe('C9 巡逻区覆盖层绘制（14.4c）', () => {
  it('本方与对手巡逻区各描边一次/格，且不填充、不写字', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(
      ctx,
      {
        ...EMPTY_OVERLAY,
        patrolZone: {
          friendly: [hex(13), hex(14)],
          enemy: [hex(30)],
        },
      },
      1,
    )
    // 3 格各一次 stroke；虚线开关各一次（开始 + 复位）
    expect(rec.strokes).toBe(3)
    expect(rec.dashes).toBe(2)
    expect(rec.texts).toHaveLength(0)
    expect(rec.rects).toHaveLength(0)
    expect(rec.arcs).toBe(0)
  })

  it('没有巡逻区覆盖层时什么都不画（C5 移动覆盖层不受影响）', () => {
    const { ctx, rec } = makeCtx()
    drawMovementOverlay(ctx, { ...EMPTY_OVERLAY, patrolZone: null }, 1)
    expect(rec.strokes).toBe(0)
    expect(rec.dashes).toBe(0)
  })
})
