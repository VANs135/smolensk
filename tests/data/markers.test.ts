import { describe, expect, it } from 'vitest'

import { arrivalsAxis, arrivalsSoviet, markers } from '@/data'
import { arrivalDateIso } from '@/engine/rules'

/** A6 标记与记录轨加载冒烟（数据源 markers.json，源自 2026-09-11 重构后的工程库） */
describe('markers 标记库', () => {
  it('标记数量与规则分类覆盖（47 件保留）', () => {
    expect(markers.markers).toHaveLength(47)
    const classes = new Set(markers.markers.map((m) => m.ruleClass))
    for (const expected of [
      '3.6a',
      '3.6b',
      '3.6f',
      '3.6e',
      '5.0c',
      '13.3b',
      '13.3d',
      '16.0',
      'spec_1.7',
      'spec_3.5',
    ]) {
      expect(classes.has(expected), `缺少规则分类 ${expected}`).toBe(true)
    }
  })

  it('关键标记存在（DG / 燃料 / 补给缓存 / 铁路容量）', () => {
    const names = markers.markers.map((m) => m.name)
    expect(names).toContain('DG')
    expect(names.some((n) => n.includes('Fueled'))).toBe(true)
    expect(names.some((n) => n.includes('Supply Cache'))).toBe(true)
    expect(names.some((n) => n.includes('Rail Cap'))).toBe(true)
  })

  it('阵营分布仅 axis/soviet/neutral/both', () => {
    for (const m of markers.markers) {
      expect(['axis', 'soviet', 'neutral', 'both']).toContain(m.side)
    }
  })
})

describe('回合轨（半周日号，19 回合）', () => {
  it('首末与关键日期正确（8 Jul → 8 Sep；8 月与 9 月首回合为 **1 日**）', () => {
    expect(markers.turnTrack).toHaveLength(19)
    expect(markers.turnTrack[0]).toEqual({ turn: 1, date: '1941-07-08' })
    expect(markers.turnTrack.at(-1)).toEqual({ turn: 19, date: '1941-09-08' })
    expect(markers.turnTrack[7]).toEqual({ turn: 8, date: '1941-08-01' })
    expect(markers.turnTrack[16]).toEqual({ turn: 17, date: '1941-09-01' })
  })

  it('月内日号取轮盘 sectors [1,5,8,12,15,19,22,26,29]（每月重复）', () => {
    const days = markers.turnTrack.map((item) => Number(item.date.slice(8)))
    // 7 月自 8 日起（游戏从 8 Jul 开始，故 1/5 不在内）
    expect(days.slice(0, 7)).toEqual([8, 12, 15, 19, 22, 26, 29])
    expect(days.slice(7, 16)).toEqual([1, 5, 8, 12, 15, 19, 22, 26, 29])
    // 9 月至 8 日止
    expect(days.slice(16)).toEqual([1, 5, 8])
  })

  it('到货卡的每个日期都精确命中回合轨（剧本/增援与回合日期一致）', () => {
    const track = new Set(markers.turnTrack.map((item) => item.date))
    for (const side of ['axis', 'soviet'] as const) {
      const blocks = side === 'axis' ? arrivalsAxis.blocks : arrivalsSoviet.blocks
      for (const block of blocks) {
        const scheduled = arrivalDateIso(block.date)
        expect(scheduled, `${side} 的 ${block.date} 无法解析`).not.toBeNull()
        expect(track.has(scheduled!), `${side} 的 ${block.date} 不在回合轨上`).toBe(true)
      }
    }
  })

  it('日期严格递增且 turn 连续', () => {
    for (let i = 0; i < markers.turnTrack.length; i += 1) {
      const item = markers.turnTrack[i]!
      if (i > 0) {
        const prev = markers.turnTrack[i - 1]!
        expect(prev.date < item.date).toBe(true)
        expect(item.turn).toBe(prev.turn + 1)
      }
    }
  })
})

describe('铁路容量轨（13.3b / 专规 1.2）', () => {
  it('档位与提升数值正确', () => {
    expect(markers.railCap.maxMain).toBe(10)
    expect(markers.railCap.maxSub).toBe(3)
    expect(markers.railCap.initial).toEqual({ axis: 0, soviet: 2 })
    expect(markers.railCap.boostDate).toBe('1941-07-19')
    expect(markers.railCap.boostTo).toEqual({ axis: 1, soviet: 3 })
  })
})

describe('容器（死亡堆 / 边缘盒 / 空军盒）', () => {
  it('死亡堆初始为空', () => {
    expect(markers.containers.deadPile.axis).toEqual([])
    expect(markers.containers.deadPile.soviet).toEqual([])
  })

  it('边缘盒两枚且盒内可追溯补给（1.4b）', () => {
    expect(markers.containers.edgeBoxes).toHaveLength(2)
    for (const box of markers.containers.edgeBoxes) {
      expect(box.traceSupply).toBe(true)
      expect(box.id.startsWith('edge-')).toBe(true)
    }
  })

  it('空军盒射程与边缘行（1.4a：轴 30 格 / 苏 20 格）', () => {
    const axis = markers.containers.airBoxes.find((b) => b.side === 'axis')
    const soviet = markers.containers.airBoxes.find((b) => b.side === 'soviet')
    expect(axis?.rangeHexes).toBe(30)
    expect(axis?.edgeRow).toBe(1)
    expect(soviet?.rangeHexes).toBe(20)
    expect(soviet?.edgeRow).toBe(62)
  })
})

describe('深度冻结', () => {
  it('轨迹与容器嵌套不可写', () => {
    expect(Object.isFrozen(markers)).toBe(true)
    expect(Object.isFrozen(markers.turnTrack)).toBe(true)
    expect(Object.isFrozen(markers.turnTrack[0])).toBe(true)
    expect(Object.isFrozen(markers.containers)).toBe(true)
  })
})
