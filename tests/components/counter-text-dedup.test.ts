import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

/**
 * 用户 2026-11-11：有算子图就只排图与必要按钮
 *
 * 名字 / A·AR·MA 等印值不再平铺成一行文字；图上没有的状态（DG / 已动完）只作角标或悬停。
 */
describe('算子图与文字去重', () => {
  it('左键堆叠窗：chip 不再有文字行，信息走 title 与角标', () => {
    const src = read('src/components/game/MapActionPopover.vue')
    expect(src).not.toContain('chip__label')
    expect(src).toContain(':title="chipTitle(unit, unit.id)"')
    expect(src).toContain('chip__flag')
    // 飞机 chip 也不写字，机名只在 title
    expect(src).toContain(':title="air.name"')
  })

  it('选炮击 / 轰炸单位：只留图与图上没有的瞄距角标', () => {
    const src = read('src/components/ops/OpsFlowPanel.vue')
    expect(src).not.toContain('<span>{{ unit.name }}</span>')
    expect(src).not.toContain('<span>{{ item.air.name }}</span>')
    expect(src).not.toContain('>炸 {{ unit.raw.barrage')
    // 距离 / 航程是图上没有的计算值 ⇒ 允许保留角标
    expect(src).toContain('item.air.rangeHexes')
  })

  it('空军面板：本方飞机清单不再平铺印值，整行进 title', () => {
    const src = read('src/components/air/AirPanel.vue')
    expect(src).not.toContain('{{ air.name }}（{{ air.aircraftType }}）@')
    expect(src).toContain('air-row__thumb')
    expect(src).toContain('ACV ${air.airCombatRating}')
  })

  it('决策队列：有图就不再用文字重复名称，无图才退回文字', () => {
    const src = read('src/components/game/DecisionQueue.vue')
    expect(src).toContain('v-if="item.imageUrl === null" class="queue__label"')
    expect(src).toContain('v-if="placement.imageUrl === null" class="queue__label"')
  })
})
