import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 初设队列改版（用户 2026-11-19）
 *
 * 口径：
 *   ① 待落位单位排成 box 网格（左右上下排列），不再一单位一行；
 *   ② 算子放大到便于辨认，整批尽量不靠上下滚动才能看完；
 *   ③ 飞机单独一块分区，与地面 / 非战斗分开；
 *   ④ 既有信息保留：地面番号、飞机受损面、激活 / 未激活分栏。
 *
 * 本仓库不挂组件渲染测试 ⇒ 钉源码形态；像素与滚动仍由实际窗口自查。
 */
const queue = readFileSync('src/components/game/DecisionQueue.vue', 'utf8')
const store = readFileSync('src/stores/setup.ts', 'utf8')

describe('初设队列：box 网格布局', () => {
  it('★ 待落位单位排成网格（flex-wrap），不再一单位一行', () => {
    expect(queue).toContain('queue__grid')
    expect(queue).toMatch(/\.queue__grid\s*\{[^}]*flex-wrap:\s*wrap/)
    // 旧的一单位一行卡列表（`queue__cards`）只应保留给「可自主放弃项」的只读清单
    expect(queue).not.toContain('<ul v-if="openKey === stack.key && stack.items.length > 0"')
  })

  it('★ 算子放大（地面/补给 ≥ 36px、飞机 ≥ 32px），面板加宽', () => {
    expect(queue).toMatch(/--queue-counter:\s*(3[6-9]|[4-9][0-9])px/)
    expect(queue).toMatch(/--queue-air-counter:\s*(3[2-9]|[4-9][0-9])px/)
    expect(queue).toMatch(/\.queue__counter-img\s*\{[^}]*width:\s*100%/)
    expect(queue).toMatch(/\.queue__air-chip img\s*\{[^}]*width:\s*100%/)
    // 面板不再固定 300px 宽（放不下多列网格）
    expect(queue).not.toContain('width: min(300px, 65%)')
  })

  it('★ 飞机独立分区（与地面 / 非战斗分开），按四个面分栏', () => {
    expect(queue).toContain(':data-stack="stack.key"')
    expect(queue).toContain("stack.key === 'air'")
    expect(queue).toContain("'queue__stack--wide': stack.key === 'air'")
    expect(queue).toContain('queue__air')
    expect(queue).toContain('airFaceSections')
    expect(queue).toContain('queue__air-col-head')
    // 2026-11-19：激活/未激活 × 完好/减损 = 四栏
    expect(queue).toContain("label: '激活 · 完好'")
    expect(queue).toContain("label: '激活 · 减损'")
    expect(queue).toContain("label: '未激活 · 完好'")
    expect(queue).toContain("label: '未激活 · 减损'")
    // 点中的那一枚上方出「入盒」，不再用下拉选图外盒
    expect(queue).toContain('isAirChipPicked(chip)')
    expect(queue).toContain('sendAirToBox(airPickedChip)')
    expect(queue).not.toContain('queue__air-box')
  })

  it('★ 受损面：减损飞机用背面图档，并在算子上标「减」', () => {
    expect(store).toContain('imageUrlBack')
    expect(store).toContain('pendingAirFaces')
    // 逐枚面的图档由 store 按 reduced 取背面；组件只画 face.imageUrl
    expect(queue).toContain('pendingAirFaces')
    expect(queue).toContain('chip.imageUrl')
    expect(queue).toContain('queue__air-flag')
    expect(queue).toContain('减')
  })

  it('★ 地面番号保留', () => {
    expect(queue).toContain('v-if="item.formation"')
    expect(queue).toContain('queue__formation')
  })
})
