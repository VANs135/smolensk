/**
 * 交互收口 11 号：选格态的统一退出口径
 *
 * 口径：点地图空白处或 Esc 都能取消；取消后回到上一步可用状态；
 * 换段 / 换方 / 换回合 / 直跳环节必须收掉残留的待点格（历史坑：残留选格分派吃掉后续点击）。
 */

import { describe, expect, it } from 'vitest'

import { useMapViewStore } from '@/stores'
import { newConsole } from './sop-harness'

function armPick(store: ReturnType<typeof newConsole>): void {
  store.beginHexPick({
    label: '测试选格',
    rule: '—',
    candidates: 'any',
    apply: () => true,
  })
}

describe('11 号：选格态退出', () => {
  it('点地图空白处 = cancelHexPick，取消后下一次点图不再被吞', () => {
    const store = newConsole()
    const mapView = useMapViewStore()
    armPick(store)
    expect(store.hexPickView).not.toBeNull()

    expect(mapView.cancelBlankPick()).toBe(true)
    expect(store.hexPickView).toBeNull()
    // 取消后再点图 ⇒ 交回常规分派（不再返回 true 吞掉）
    expect(store.pickHexFor({ col: 1, row: 1 })).toBe(false)
  })

  it('没有待点态时空白点击返回 false（当作普通点击）', () => {
    newConsole()
    const mapView = useMapViewStore()
    expect(mapView.cancelBlankPick()).toBe(false)
  })

  it('换段 / 换方 / 换回合 / 直跳环节都会收掉待点格', () => {
    {
      const store = newConsole()
      armPick(store)
      store.setPhase('combat')
      expect(store.hexPickView).toBeNull()
    }
    {
      const store = newConsole()
      armPick(store)
      store.switchSide()
      expect(store.hexPickView).toBeNull()
    }
    {
      const store = newConsole()
      armPick(store)
      store.setTurn(store.turn + 1)
      expect(store.hexPickView).toBeNull()
    }
    {
      const store = newConsole()
      armPick(store)
      store.setSegmentStepIndex(0)
      expect(store.hexPickView).toBeNull()
    }
  })
})
