import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 缺陷 A（2026-11-14 实点）：对局台 D 段没有「逐单位补给检查」入口
 *
 * 现场：D 补给段只有生成计划 / 恢复 / 供养三个按钮；「战况」抽屉只有操作反馈、
 * 胜利分与容器，找不到「受补给单位」——12.6 判定 → 12.3 选来源（抽象追溯与具象来源同屏）
 * → 拖取/投递 → 付款扣点这条链在对局台不可达。
 *
 * 既有设计（B15e）：账本段挂侧栏 `SupplyPanel only="ledger"`（「受补给单位」入口在账本段内），
 * 逐单位检查链挂地图会话 `only="check"`——本用例钉住这条设计而不是另造第二套窗口。
 */
describe('缺陷 A：对局台补给段挂账本段入口', () => {
  const game = readFileSync('src/views/GameTableView.vue', 'utf8')

  it('战况抽屉在补给阶段挂 SupplyPanel（only="ledger"）', () => {
    const start = game.indexOf("openedDrawers.has('status')")
    const end = game.indexOf('</aside>', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    const statusBlock = game.slice(start, end)
    expect(statusBlock).toContain('SupplyPanel')
    expect(statusBlock).toContain('only="ledger"')
    expect(statusBlock).toMatch(/phase === 'supply'/)
  })

  it('逐单位检查链仍只挂地图会话（only="check"），不新造第二套窗口', () => {
    const checkSites = game.match(/<SupplyPanel[^>]*only="check"/g) ?? []
    const ledgerSites = game.match(/<SupplyPanel[^>]*only="ledger"/g) ?? []
    expect(checkSites).toHaveLength(1)
    expect(ledgerSites).toHaveLength(1)
  })
})
