import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 用户 2026-11-14 裁定 3：拆分单位**型号保持下拉**。
 *
 * 理由：型号是单位库记录（不在图上），没有可点的地图落点；把它改成点地图只会
 * 制造一个"点了不知道选了什么"的入口。吸收对象是图上算子，未来才可能改点地图。
 *
 * 本用例只钉住现状，防止后人把型号下拉误改成地图选格。
 */
describe('20.0a：拆分单位型号保持下拉', () => {
  it('拆分面板用 select 绑 recordId，选项来自 breakdownRecords', () => {
    const panel = readFileSync('src/components/game/CounterOrderPanel.vue', 'utf8')
    expect(panel).toContain('<select v-model="recordId">')
    expect(panel).toContain('v-for="record in breakdownRecords"')
  })

  it('型号选择不走"点地图选格"（没有 begin*HexPick 之类的型号落点入口）', () => {
    const panel = readFileSync('src/components/game/CounterOrderPanel.vue', 'utf8')
    expect(panel).not.toMatch(/breakdown.*HexPick|HexPick.*breakdown/i)
  })
})
