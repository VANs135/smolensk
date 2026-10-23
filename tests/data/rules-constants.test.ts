import { describe, expect, it } from 'vitest'

import { DATA_VERSION, mapLayers, rulesConstants } from '@/data'

/** 加载入口冒烟：rules-constants.json（v2）经管线加载后的只读基线 */
describe('rules-constants.json 基线加载', () => {
  it('通用常量数值与已核实规则一致', () => {
    expect(rulesConstants.supply.spToT).toBe(4) // 1 SP = 4 T（3.3a / 12.1a）
    expect(rulesConstants.supply.directDrawRangeMp).toBe(5) // 直接拖取（12.3a）
    expect(rulesConstants.movement.stackingLimitRe).toBe(10) // 堆叠上限（4.8）
    expect(rulesConstants.movement.railConversionMaxPerPhase).toBe(4) // 轨道转换（13.3g）
    expect(rulesConstants.combat.overrunMpCost).toBe(3) // 突袭（8.1a）
    expect(rulesConstants.combat.hedgehogSurpriseDrm).toBe(-1) // 工事奇袭修正（9.8）
    expect(rulesConstants.modes.dgArMod).toBe(-1) // DG 行动值修正（5.10b）
  })

  it('轰炸密度列移步骤表尺寸与档位正确（10.0a 表）', () => {
    const steps = rulesConstants.barrage.densityShifts
    expect(steps).toHaveLength(6)
    expect(steps[0]).toEqual({ maxRe: 1, shift: -1 })
    expect(steps.at(-1)?.maxRe).toBeNull() // 无上限档
    expect(steps.at(-1)?.shift).toBe(4)
  })

  it('专规时点以 ISO 日期存储且次序正确', () => {
    const smolensk = rulesConstants.smolensk
    expect(smolensk.randomEventFrom).toBe('1941-07-19')
    expect(smolensk.randomEventTo).toBe('1941-08-15')
    expect(smolensk.randomEventFrom! < smolensk.randomEventTo!).toBe(true)
    expect(smolensk.variableExitStart).toBe('1941-08-19')
  })

  it('meta.version 与 DATA_VERSION 一致', () => {
    expect(rulesConstants.meta.version).toBe(DATA_VERSION)
  })

  it('专规 1.2 轨距：印刷宽轨、苏方只宽轨、轴方只标准轨，且与地图图层同值', () => {
    const gauge = rulesConstants.smolensk.railGauge
    // 专规 1.2：「最初除剧本初设另有注明者外，全部为宽轨」
    expect(gauge.printed).toBe('broad')
    // 「苏方只能使用宽轨铁路，轴方只能使用标准轨铁路」（就铁路运货**与获得追溯补给**而言）
    expect(gauge.usableBySide.soviet).toBe('broad')
    expect(gauge.usableBySide.axis).toBe('standard')
    // 两侧可用轨距必须**不同**，否则「谁可以用」这条规则不成立（同轨距等于没有轨距限制）
    expect(gauge.usableBySide.soviet).not.toBe(gauge.usableBySide.axis)
    // 图层副本与规则常量互为印证：不一致即数据有误（代码只读常量，故此处必须钉住）
    expect(mapLayers.railGauge).toBe(gauge.printed)
  })

  it('加载结果为深度冻结（嵌套不可写）', () => {
    expect(Object.isFrozen(rulesConstants)).toBe(true)
    expect(Object.isFrozen(rulesConstants.supply)).toBe(true)
    expect(Object.isFrozen(rulesConstants.barrage.densityShifts)).toBe(true)
    expect(Object.isFrozen(rulesConstants.barrage.densityShifts[0])).toBe(true)
  })
})
