import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 盒贴图按钮边界（用户 2026-11-18 范围更正）
 *
 * 「贴图按钮只加给**没有其它入口、只能盒内完成**的操作。目前明确要加的只有地图外空军盒的整备按钮。
 *   其它盒不要为了统一而铺按钮；已经有右键或地图入口的操作不要复制一份到贴图上。」
 *
 * 因此这里钉三件事：
 *   ① 空军盒未激活分区贴图上有「整备」（1.4a），且只接唯一的 `activateAirBox`；
 *   ② 标记盒**不铺**建造标记按钮（专规 3.5 的入口在地图右键），只显示存量角标；
 *   ③ 其它盒仍旧没有"为了统一"新加的重复按钮。
 */

const face = () => readFileSync('src/components/game/BoxCardFace.vue', 'utf8')

describe('盒贴图按钮：只加盒内唯一入口', () => {
  it('★ 空军盒：未激活分区贴图上有整备按钮，接唯一的 activateAirBox（1.4a）', () => {
    const source = face()
    expect(source).toContain("region.kind === 'air_box_inactive'")
    expect(source).toContain('containers.activateAirBox(workbench.activeSide)')
    expect(source).toContain('整备')
    expect(source).toContain('1.4a')
  })

  it('★ 标记盒不铺按钮：建造标记仍走地图右键（专规 3.5），贴图上没有它的入口', () => {
    const source = face()
    expect(source).not.toContain('armConstructionMarkerNow')
    expect(source).not.toContain('useConstructionMarkerNow')
    // 存量角标是显示，不是按钮
    expect(source).toContain('unit.badge')
  })

  it('贴图上只有已知的两类盒内按钮（拆分取用 / 空军整备），没有为"统一"批量铺按钮', () => {
    const source = face()
    const actions = source.match(/class="face__action"/g) ?? []
    expect(actions).toHaveLength(2)
  })
})
