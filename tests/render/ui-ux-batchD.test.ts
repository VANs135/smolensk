/**
 * 交互收口 批 D：主路径下拉改算子图阵列 / 按钮组
 *
 * 三条主路径（补给付款用途 / 拆分与边缘盒选单位 / 编队收纳）不再用纯文字下拉：
 *   · 选**单位** → CounterPicker 算子图阵列（图上信息已够）；
 *   · 选**用途 / 编队**（没有算子图）→ 按钮组。
 * 炮兵、空军、燃料、行动等属其他线的面板不在本批范围内，本文件不触碰。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('批 D：主路径下拉改阵列 / 按钮组', () => {
  it('补给付款用途：select 改按钮组，条款号不上屏', () => {
    const panel = read('src/components/supply/SupplyPanel.vue')
    expect(panel).not.toMatch(/v-model="workbench\.supplyInputs\.purpose"/)
    expect(panel).toMatch(/v-for="item in PURPOSES"/)
    expect(panel).toContain('workbench.supplyInputs.purpose = item.key')
    expect(panel).toContain("label: '燃料'")
    expect(panel).not.toContain("label: '燃料（12.5）'")
  })

  it('拆分母单位改 CounterPicker 阵列；边缘盒入盒改走「入盒带」（2026-11-26）', () => {
    const panel = read('src/components/containers/ContainersPanel.vue')
    expect(panel).not.toContain('v-model="breakdownParentId"')
    // 2026-11-26（用户第 2 条）：ContainersPanel 的入盒段整段删掉 ⇒ 不再有按单位选的阵列与入盒按钮
    expect(panel).not.toContain('v-model="edgeUnitId"')
    expect(panel).not.toContain('edgeBoxEnterCandidates')
    expect(panel).toContain('parentPickerItems')
    expect(panel).toMatch(/import \{ CounterPicker/)
    // 阵列条目必须带算子图，不能退化成纯文字
    expect(panel).toContain('imageUrl: unit === undefined ? null : counterImageUrlOf(unit)')
    // 入盒改走地图外侧的带：画布按 `edgeBandRect` 命中，点带弹 1 MP／1 铁路的小签
    expect(read('src/components/map/MapCanvas.vue')).toContain('edgeBandRect')
    expect(read('src/components/game/EdgeBandTag.vue')).toContain('1 铁路运力')
  })

  it('编队收纳：select 改按钮组', () => {
    const panel = read('src/components/containers/ContainersPanel.vue')
    expect(panel).not.toContain('v-model="formationId"')
    expect(panel).toMatch(/v-for="item in formationChoices"/)
    expect(panel).toContain('formationId = item.id')
  })
})
