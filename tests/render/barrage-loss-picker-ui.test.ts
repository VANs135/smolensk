import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 10.0a：受损单位**只能点算子图**选，不再有数字输入 / 加减数值控件
 *
 * 用户 2026-11-22 第 1 条：被轰炸的单位选受损必须点单位图片；「绝不能是 +/− 数值」。
 * 炮击与空军轰炸共用同一条 `barrageState` 战果链，所以两个入口只应有一份选择实现
 * （`OpsLossPicker`），`BarragePanel` 的 ⑤ 段不得再摆 `type="number"` 的损失格。
 */

const read = (path: string): string => readFileSync(path, 'utf8')

describe('受损单位选择：点算子图，不用数值输入', () => {
  it('BarragePanel 的损失分配改由 OpsLossPicker 承担，不再有 per-unit 数字输入', () => {
    const panel = read('src/components/barrage/BarragePanel.vue')
    // 修前的实现痕迹：lossValue / setLoss + type="number" 的损失格
    expect(panel, 'BarragePanel 仍有 lossValue 数值读取').not.toContain('lossValue')
    expect(panel, 'BarragePanel 仍有 setLoss 数值写入').not.toContain('setLoss')
    expect(panel, 'BarragePanel 仍引用 lossTargets 直接铺输入格').not.toContain('lossTargets')
    // ⑤ 段改为共用组件
    expect(panel).toContain('OpsLossPicker')
  })

  it('OpsLossPicker 以算子图为选择入口，撤销不是 +/− 符号按钮', () => {
    const picker = read('src/components/ops/OpsLossPicker.vue')
    expect(picker, '损失选择不再点算子').toContain('addBarrageLossPoint')
    expect(picker, '损失选择没有算子图').toContain('counterImageUrlOf')
    expect(picker).toContain('撤销')
    expect(picker, '仍有「−」符号按钮').not.toContain('>−<')
    expect(picker, '仍有「+」符号按钮').not.toContain('>+<')
  })

  it('同一份选择块只出现一次实现（炮击 / 空军轰炸共用）', () => {
    expect(read('src/components/ops/OpsFlowPanel.vue')).toContain('<OpsLossPicker />')
    expect(read('src/components/barrage/BarragePanel.vue')).toContain('<OpsLossPicker />')
  })
})
