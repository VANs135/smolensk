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

  it('★ 算子 32px、面板 460（2026-11-26 合成面板口径；36/38 与 680 的旧口径已作废）', () => {
    expect(queue).toMatch(/--queue-counter:\s*32px/)
    expect(queue).toMatch(/--queue-air-counter:\s*32px/)
    expect(queue).toMatch(/\.queue__counter-img\s*\{[^}]*width:\s*100%/)
    expect(queue).toMatch(/\.queue__air-chip img\s*\{[^}]*width:\s*100%/)
    // 面板宽 460（§4.5），不再固定 300px、也不是旧的 680
    expect(queue).toMatch(/width:\s*min\(460px/)
    expect(queue).not.toContain('width: min(300px, 65%)')
    expect(queue).not.toContain('width: min(680px')
  })

  it('★ 段条四枚 chip + 只有当前段铺开手牌（合成一块，不再四堆平铺）', () => {
    expect(queue).toContain(':data-stack="stack.key"')
    expect(queue).toContain('segmentRows')
    expect(queue).toContain('activeRow.key')
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

describe('初设队列：2026-11-20 手感与正确性', () => {
  const setupPanel = readFileSync('src/components/setup/SetupPanel.vue', 'utf8')
  const table = readFileSync('src/views/GameTableView.vue', 'utf8')

  it('★ 飞机「入盒」在阵列上方的合并行：入盒 · 取消选格 · 机型 · 剩 N · 说明（2026-11-20）', () => {
    // 合并行恢复在原入盒条位置（飞机阵列上方），顶部选中行不再接飞机的活
    expect(queue).toContain('queue__air-pickbar')
    expect(queue).not.toContain('queue__air-pickbar--empty')
    expect(queue).toContain("placing !== null && placing.kind !== 'air'")
    // 两枚按钮固定在最左侧：入盒 → 取消选格 → 文案（最左边的机型名让位）
    const bar = queue.slice(queue.indexOf('queue__air-pickbar'))
    const boxIndex = bar.indexOf('sendAirToBox(airPickedChip)')
    const cancelIndex = bar.indexOf('setup.cancelPlacement()')
    const labelIndex = bar.indexOf('queue__label')
    expect(boxIndex).toBeGreaterThan(-1)
    expect(cancelIndex).toBeGreaterThan(boxIndex)
    expect(labelIndex).toBeGreaterThan(cancelIndex)
    // 未选中时两枚按钮都同款压暗待命（aria-disabled 恒真），不摆 disabled 灰按钮
    expect(queue).toContain('queue__air-pickbar-btn--idle')
    expect(queue).toContain(':aria-disabled="true"')
    expect(queue).not.toContain(':disabled=')
  })

  it('★ 未激活飞机压灰：桌面与安卓同一份（仍可点着落位/入盒）', () => {
    expect(queue).toMatch(/\.queue__air-col\[data-face='inactive-full'\] \.queue__air-chip/)
    expect(queue).toContain('grayscale(1) opacity(0.55)')
    // 右栏初设阵列也压灰，不靠“未激活”字样
    expect(setupPanel).toContain("dimmed: row.face.status === 'inactive'")
  })

  it('★ 撤回图标常显：无可撤操作只压暗待命（aria-disabled），整枚不消失', () => {
    // 初设框动作列不再放撤回
    expect(queue).not.toContain('撤回上一步')
    // 2026-11-26（用户）：设置从主列移出，栏底三枚相邻 —— 存档 → 设置 → 撤销
    const save = table.indexOf('aria-label="存档 / 读档"')
    const settings = table.indexOf('table-drawer-settings')
    const undo = table.indexOf('gt__rail-undo')
    expect(save).toBeGreaterThanOrEqual(0)
    expect(settings).toBeGreaterThan(save)
    expect(undo).toBeGreaterThan(settings)
    // 主列不再混入设置（主列＝战况 / 表 / 战报）
    expect(table).toContain("drawers.filter((item) => item.id !== 'settings')")
    expect(table).toContain('workbench.undoLastOperationNow()')
    // 常显 + 压暗待命：用共用入口自己的 canUndoOperation，不按条件整枚隐藏，也不摆 disabled
    expect(table).toContain(':aria-disabled="!workbench.canUndoOperation"')
    expect(table).toContain('gt__rail-undo--idle')
    expect(table).not.toContain('setup.undoLastPlacementNow()')
    expect(table).not.toContain(':disabled=')
  })
})
