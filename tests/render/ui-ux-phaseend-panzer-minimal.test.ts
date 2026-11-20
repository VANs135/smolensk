import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { readStoreSource } from '../shared/store-source'

/**
 * 阶段末「装甲集群」窗口减负（源码守卫）
 *
 * 口径：一窗一事；纯告知不开窗（自动判定 + 一行日志）；确实要玩家选的，
 *   窗里只留选择件，说明文字删干净、条款号收进 `?`。
 */

const panel = (): string => readFileSync('src/components/exclusive/ExclusiveRulesPanel.vue', 'utf8')
const mapView = (): string => readFileSync('src/stores/map-view.ts', 'utf8')
const sessionSteps = (): string => readFileSync('src/stores/session-steps.ts', 'utf8')
const workbench = (): string => readStoreSource()

describe('阶段末装甲集群：无选择不弹窗', () => {
  it('会话自动出现只认「真有选择」，不再由段末闸门单独触发', () => {
    expect(mapView()).toContain('workbench.exclusiveAutoOpen')
    expect(mapView()).not.toContain('workbench.exclusiveActionsInStep.length > 0')
    expect(workbench()).toContain('const exclusiveAutoOpen')
    expect(workbench()).toContain('panzerDgChoiceObligations')
  })

  it('单候选义务在段末自动判定，并落一行日志（3.4a）', () => {
    expect(workbench()).toContain('settlePanzerGroupDgAtPhaseEnd')
    expect(workbench()).toContain('自动投 DG')
  })
})

describe('阶段末装甲集群：窗口只留选择件', () => {
  it('会话分支不铺 RuleNote 长文，条款号走 `?`', () => {
    const src = panel()
    expect(src).toContain('const compactPanzer')
    expect(src).toContain('data-testid="panzer-minimal"')
    expect(src).toContain('<RuleTip rule="3.4a"')

    const minimalAt = src.indexOf('data-testid="panzer-minimal"')
    const longProseAt = src.indexOf('至 19 August 止')
    expect(minimalAt).toBeGreaterThan(0)
    // 长文只在 compact 之后的 verbose 分支
    expect(longProseAt).toBeGreaterThan(minimalAt)
  })

  it('会话步骤不再带长说明（标题只留「装甲集群」）', () => {
    expect(sessionSteps()).not.toContain('选定要结算的编队（或补给点的归属），然后执行。')
    expect(sessionSteps()).toMatch(/panzer: \{[\s\S]*?decision: '',/)
  })
})
