import { describe, expect, it } from 'vitest'

import {
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  isTouchPointer,
  longPressMoved,
} from '@/shared/long-press'

/**
 * 触摸屏长按（＝桌面右键）的判定口径
 *
 * 这套东西**在鼠标上完全看不出问题**：桌面端永远有 `contextmenu`，长按识别写错了
 * 也只是"手机上偶尔多点一下"。故把可判定的部分（指针类型、位移容差）钉成纯函数用例。
 */

describe('触摸指针判定', () => {
  it('触摸 / 触控笔算触摸类', () => {
    expect(isTouchPointer('touch')).toBe(true)
    expect(isTouchPointer('pen')).toBe(true)
  })

  it('★ 鼠标**不**算：桌面右键必须仍走 contextmenu（否则长按会抢掉右键）', () => {
    expect(isTouchPointer('mouse')).toBe(false)
  })

  it('未知类型保守地不当触摸（宁可少一个手势，也不要误吃鼠标操作）', () => {
    expect(isTouchPointer('')).toBe(false)
    expect(isTouchPointer('unknown')).toBe(false)
  })
})

describe('长按的位移容差', () => {
  const origin = { x: 100, y: 100 }

  it('原地不动 / 微小抖动 ⇒ 仍算长按', () => {
    expect(longPressMoved(origin, { x: 100, y: 100 })).toBe(false)
    expect(longPressMoved(origin, { x: 103, y: 104 })).toBe(false)
  })

  it('★ 超过容差 ⇒ 认定玩家在拖动地图，长按作废', () => {
    expect(longPressMoved(origin, { x: 100 + LONG_PRESS_SLOP_PX + 1, y: 100 })).toBe(true)
  })

  it('容差是**直线距离**而不是单轴：斜着拖走也会作废', () => {
    // 单轴 8px（都在容差内），斜向合计 ≈11.3px ⇒ 已超 10px
    expect(longPressMoved(origin, { x: 108, y: 108 })).toBe(true)
  })

  it('容差可调（调用方按设备密度放宽时用）', () => {
    expect(longPressMoved(origin, { x: 130, y: 100 }, 40)).toBe(false)
  })

  it('长按时长是"按住"而非"点一下"的量级：≥400ms 才不至于和点击打架', () => {
    expect(LONG_PRESS_MS).toBeGreaterThanOrEqual(400)
    // 也不能长到玩家以为没反应（>800ms 手感明显发滞）
    expect(LONG_PRESS_MS).toBeLessThanOrEqual(800)
  })
})
