import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { buildFlowGuide } from '@/engine/flow-model'
import { SOP_STEPS } from '@/engine/session-flow'
import {
  useGameSessionStore,
  useHotseatStore,
  useMapViewStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * Pre-Turn（回合准备，2.2 / 1.5 / 2.3）阶段的界面收敛
 *
 * 2.2 流程表里 Pre-Turn（天气判定 → 先手判定）**不属于 A–H 任何一段**，此刻盘面上
 * 没有任何可执行动作（`workbench.segmentLocked === true`）。但 `workbench.phase` 的
 * 投影在 Pre-Turn 会回退到本地演练段（默认 `movement`），于是「移动段」的界面会漏出来：
 *   · 左键点算子建出「待开拔」取子清单（点了「开始移动」才被 2.2 拒）；
 *   · 右键本方算子弹出只剩灰项的菜单；
 *   · 地图上方提示教玩家「点己方算子＝显示可移动范围」；
 *   · 流程条把上一段的突围入口与「本环节可参与 N 枚」照搬过来。
 *
 * 本文件钉住这四件事：**没有行动段就一个动作入口都不留**（不可用项根本不出现）。
 */

const HEX = CORE_HEX

function preTurn() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  const workbench = useWorkbenchStore()
  workbench.setActiveSide('axis')
  // 2026-11-11：观察方手动选（不随行动方自动切），测试里与行动方对齐
  useHotseatStore().setViewerSide('axis')
  const record = groundRecord(
    'axis',
    (item) => item.isCombat === true && item.classes?.movementClass === 'leg',
  )
  const unit = placeGround(workbench, record, HEX, 'axis', 'u1')
  const session = useGameSessionStore()
  expect(session.startGame()).toBe(true)
  expect(workbench.segmentLocked).toBe(true)
  return { workbench, mapView: useMapViewStore(), session, unit }
}

describe('Pre-Turn：本环节没有行动段 ⇒ 不留任何动作入口（2.2）', () => {
  let s: ReturnType<typeof preTurn>

  beforeEach(() => {
    s = preTurn()
  })

  it('左键点算子：只做只读选中，不建「待开拔」取子清单，并给出 2.2', () => {
    s.workbench.selectForMove(HEX)
    expect(s.workbench.movePick).toBeNull()
    expect(s.workbench.selectedId).toBe(s.unit.instanceId)
    expect(s.workbench.moveBlocked?.rule).toBe('2.2')
  })

  it('右键本方算子：不弹动作菜单（不出现任何灰项）', () => {
    s.workbench.selectedId = s.unit.instanceId
    s.mapView.onHexContext(HEX, { x: 0, y: 0 }, { x: 0, y: 0 })
    expect(s.mapView.popup).toBeNull()
    expect(s.mapView.contextOptions).toEqual([])
  })

  it('地图上方提示：说明「回合准备没有行动段」，不教玩家点算子显示可移动范围', () => {
    expect(s.mapView.actionHint).toContain('回合准备')
    expect(s.mapView.actionHint).not.toContain('可移动范围')
  })

  it('流程条：不再报「本环节可参与 N 枚」（回合级判定没有参与算子）', () => {
    const guide = buildFlowGuide({
      sessionExists: true,
      form: 'advancing',
      terminated: false,
      awaiting: false,
      questionRule: null,
      currentStep: SOP_STEPS[0] ?? null,
      currentIndex: 0,
      sopLength: SOP_STEPS.length,
      firstPlayer: null,
      phaseLabel: '回合准备',
      segmentStep: { label: '天气判定', rule: '1.5' },
      segmentPosition: null,
      segmentStepsCount: 0,
      participatingUnitCount: 3,
      refusal: null,
      actionHint: '',
      advanceOutcome: null,
      setupApplied: true,
      setupFinished: true,
      agreedRecorded: true,
      saveError: null,
    })
    expect(guide.todoLabel).toBe('—')
  })

  it('对局台的「突围」临时入口带行动段闸（没有行动段时不出现）', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    const at = game.indexOf("workbench.segmentStep?.id === 'movement.breakout'")
    expect(at).toBeGreaterThan(0)
    // `v-if` 可能折行 ⇒ 取它后面一小段看闸门是否与环节判据连在一起
    expect(game.slice(at, at + 200)).toContain('!workbench.segmentLocked')
  })
})

describe('Pre-Turn：显示口径与界面其余处一致（中文段名 / 天气）', () => {
  it('结算记录的阶段名用「回合准备」，不混英文 Pre-Turn', () => {
    const panel = readFileSync('src/components/session/SettlementLogPanel.vue', 'utf8')
    expect(panel).toContain("preTurn: '回合准备'")
    expect(panel).not.toContain("preTurn: 'Pre-Turn'")
  })

  it('流程条上的天气显示中文（正常飞行 / 受限飞行），不裸露枚举值', () => {
    const strip = readFileSync('src/components/session/FlowStrip.vue', 'utf8')
    expect(strip).toContain('weatherLabel')
    expect(strip).not.toContain("records?.weather.air ?? '—'")
  })
})
