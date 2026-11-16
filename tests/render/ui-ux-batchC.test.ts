/**
 * 交互收口 批 C：拒绝文案点名缺项
 *
 * 实跑复现（见提交说明）确认玩家真正会撞到的拒绝码：
 *   · 撤退落点 —— `retreatMustEndAtFullDistance` / `retreatPathShorterThanOptions`（9.12，原先落到通用兜底）；
 *   · 落账计划 —— `notDetrainableCityHex` / `edgeHexRequiredForRemainder`（13.3c / 2.1，原先显示原始码或通用句）；
 *   · 增援落点 —— `arrivalHexOutsideCandidates` / `arrivalHexEnemyOccupied`（13.6）。
 * 三类都不再只说「不可用」，至少点名缺的是距离、ZOC、堆叠、入场格还是补给站。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('批 C：拒绝文案', () => {
  it('撤退落点：距离类拒绝有专门文案，防御文案仍点名 ZOC / 堆叠', () => {
    const text = read('src/engine/rules/rule-error-text.ts')
    expect(text).not.toContain("retreatEndHexUnavailable: '这个撤退落点不可用'")

    const lines = text.split('\n')
    const unavailable = lines.find((row) => row.includes('撤退落点不合法'))
    expect(unavailable).toBeDefined()
    expect(unavailable).toContain('ZOC')
    expect(unavailable).toContain('堆叠')

    const fullDistance = lines.find((row) => row.includes('撤退落点离起始格不是正好在撤退距离上'))
    expect(fullDistance).toBeDefined()
    expect(fullDistance).toContain('撤退距离')
    expect(lines.find((row) => row.includes('撤退路径短于撤退距离'))).toBeDefined()
  })

  it('落账计划：结束本段时点名城市格 / 图边补给源格（补给站）', () => {
    const panel = read('src/components/reinforcement/ReinforcementPanel.vue')
    expect(panel).toContain("code === 'notDetrainableCityHex'")
    expect(panel).toContain('可卸货城市格')
    expect(panel).toContain(
      "code === 'notEdgeSupplySource' || code === 'edgeHexRequiredForRemainder'",
    )
    expect(panel).toContain('图边补给源格（补给站）')

    const store = read('src/stores/legal-actions-store.ts')
    expect(store).toContain('还没有生成落账计划')
  })

  it('增援落点：入场格 / 敌方单位 / 基地满分开说', () => {
    const panel = read('src/components/reinforcement/ReinforcementPanel.vue')
    expect(panel).toContain('不是入场格')
    expect(panel).toContain('有敌方单位')
    expect(panel).toContain('激活飞机已满')
    expect(panel).toContain('入场格被敌方占据')
  })
})
