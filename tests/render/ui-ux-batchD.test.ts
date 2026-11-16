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

  it('拆分母单位 / 边缘盒单位：select 改 CounterPicker 算子图阵列', () => {
    const panel = read('src/components/containers/ContainersPanel.vue')
    expect(panel).not.toContain('v-model="breakdownParentId"')
    expect(panel).not.toContain('v-model="edgeUnitId"')
    expect(panel).toContain('parentPickerItems')
    expect(panel).toContain('edgeUnitPickerItems')
    expect(panel).toMatch(/import \{ CounterPicker/)
    // 阵列条目必须带算子图，不能退化成纯文字
    expect(panel).toContain('imageUrl: unit === undefined ? null : counterImageUrlOf(unit)')
  })

  it('编队收纳：select 改按钮组', () => {
    const panel = read('src/components/containers/ContainersPanel.vue')
    expect(panel).not.toContain('v-model="formationId"')
    expect(panel).toMatch(/v-for="item in formationChoices"/)
    expect(panel).toContain('formationId = item.id')
  })
})
