/**
 * U1-b 守卫：**会话框一次只暴露一个待决事项**
 *
 * 用户口径：对话框必须拆分，一个会话只办一件事，按流程顺序逐件推进；完成一件才出下一件，
 * 不并列堆在一屏。先强制义务，再选做事项；同一环节内按规则先后，不按字母序。
 *
 * 本用例守三层：
 *   ① `planSessionSteps` 的顺序（引擎步骤 → 单一事项）；
 *   ② 暴露数恒为 0 或 1（**多待决同时出现即红**）；
 *   ③ 源码层：`SessionStep` 只有一个渲染条件；面板里的旧 step 判定已清掉、改走 store 投影。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  exposedSessionStep,
  planSessionSteps,
  type SessionStepFacts,
  type SessionStepItem,
} from '@/stores/session-steps'

const SRC = join(__dirname, '..', '..', 'src')

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
}

/** 一份"什么都不待决"的事实底稿（各用例只改自己关心的字段） */
function baseFacts(over: Partial<SessionStepFacts> = {}): SessionStepFacts {
  return {
    kind: null,
    combat: null,
    barrage: null,
    air: null,
    supply: null,
    move: {
      fuelPending: false,
      pickPending: false,
      moving: false,
      overrunZocHeld: false,
    },
    reinforce: null,
    breakout: false,
    breakoutReturnPending: false,
    containers: false,
    exclusive: false,
    exclusiveSections: [],
    unit: false,
    ...over,
  }
}

/** 暴露数：UI 端能同时看到的待决事项数（恒 ≤ 1） */
function exposedCount(items: readonly SessionStepItem[]): number {
  return exposedSessionStep(items) === null ? 0 : 1
}

describe('U1-b 投影：按流程顺序给单一事项', () => {
  it('战斗 9.6：攻方已宣布 ⇒ 只出"守方宣布行动值"', () => {
    const items = planSessionSteps(
      baseFacts({
        kind: 'combat',
        combat: { started: true, step: 'declareAr', attackerArDeclared: true },
      }),
    )
    expect(items.map((entry) => entry.id)).toEqual(['combat:ar:defender'])
  })

  it('战斗 9.6：攻方未宣布 ⇒ 只出"攻方宣布行动值"', () => {
    const items = planSessionSteps(
      baseFacts({
        kind: 'combat',
        combat: { started: true, step: 'declareAr', attackerArDeclared: false },
      }),
    )
    expect(items.map((entry) => entry.id)).toEqual(['combat:ar:attacker'])
  })

  it('补给 12.3：取用补给 ⇒ 只出"取用补给"', () => {
    const items = planSessionSteps(baseFacts({ kind: 'supply', supply: { step: 'pickup' } }))
    expect(items.map((entry) => entry.id)).toEqual(['supply:pickup'])
  })

  it('增援：慢动员 → 补员 → 重建 → 整编（规则顺序，不是字母序）', () => {
    const items = planSessionSteps(
      baseFacts({
        kind: 'reinforce',
        reinforce: {
          stepId: 'reinforcement.rebuild',
          acked: [],
          arrivalPending: false,
          randomEventPending: false,
          supplyTrainPending: false,
          variableExitPending: false,
          replTablePending: true,
          specialReplPending: false,
          supplyPlacePending: false,
          rebuildAvailable: true,
          frontalReservesPending: false,
          slowMobilizationVisible: true,
          consolidationAvailable: true,
        },
      }),
    )
    expect(items.map((entry) => entry.id)).toEqual([
      'reinforce:slow',
      'reinforce:replTable',
      'reinforce:rebuild',
      'reinforce:consolidation',
    ])
    // 暴露的只有第一件
    expect(exposedCount(items)).toBe(1)
    expect(exposedSessionStep(items)?.id).toBe('reinforce:slow')
  })

  it('增援：到达落位在可变增援与补给之前（规则顺序，不是字典序）', () => {
    const items = planSessionSteps(
      baseFacts({
        kind: 'reinforce',
        reinforce: {
          stepId: 'reinforcement.arrival',
          acked: [],
          arrivalPending: true,
          randomEventPending: false,
          supplyTrainPending: false,
          variableExitPending: false,
          replTablePending: true,
          specialReplPending: false,
          supplyPlacePending: true,
          rebuildAvailable: false,
          frontalReservesPending: false,
          slowMobilizationVisible: false,
          consolidationAvailable: false,
        },
      }),
    )
    expect(items.map((entry) => entry.id)).toEqual([
      'reinforce:arrival',
      'reinforce:replTable',
      'reinforce:supplyTable',
    ])
  })

  it('突围：返场与突围尝试是两件事，先返场（强制）再突围（选做）', () => {
    const items = planSessionSteps(
      baseFacts({ kind: 'breakout', breakout: true, breakoutReturnPending: true }),
    )
    expect(items.map((entry) => entry.id)).toEqual(['breakout:return', 'breakout:act'])
    // 一次只暴露一个：先返场，返场做完才轮到突围
    expect(exposedCount(items)).toBe(1)
    expect(exposedSessionStep(items)?.id).toBe('breakout:return')
  })
  it('专规：按节拆成多件，一节一件（不再是"一个框装五件事"）', () => {
    const items = planSessionSteps(
      baseFacts({ kind: 'exclusive', exclusive: true, exclusiveSections: ['panzer', 'cache'] }),
    )
    expect(items.map((entry) => entry.id)).toEqual(['exclusive:panzer', 'exclusive:cache'])
    expect(exposedCount(items)).toBe(1)
    expect(exposedSessionStep(items)?.id).toBe('exclusive:panzer')
  })

  it('会话窗按节渲染：GameTableView 不再写死 only="actions"', () => {
    const src = read('views/GameTableView.vue')
    expect(src).toContain('sessionExclusiveSection')
    expect(src).not.toMatch(/ExclusiveRulesPanel[^>]*only="actions"/)
  })
})

describe('U1-b 守卫：多待决同时成立也只暴露一件', () => {
  const crowded: SessionStepFacts[] = [
    // 同一环节里三件强制义务同时成立（补员放置 / 重建 / 方面军预备队）
    baseFacts({
      kind: 'reinforce',
      reinforce: {
        stepId: 'reinforcement.rebuild',
        acked: [],
        arrivalPending: true,
        randomEventPending: true,
        supplyTrainPending: false,
        variableExitPending: false,
        replTablePending: true,
        specialReplPending: true,
        supplyPlacePending: true,
        rebuildAvailable: true,
        frontalReservesPending: true,
        slowMobilizationVisible: true,
        consolidationAvailable: true,
      },
    }),
    // 战斗损失 + 选项事实同时成立（引擎只会给一个，但投影必须也只暴露一个）
    baseFacts({
      kind: 'combat',
      combat: { started: true, step: 'losses', attackerArDeclared: true },
    }),
    // 移动：燃料待决与其它移动事实同时成立
    baseFacts({
      kind: 'move',
      move: {
        fuelPending: true,
        pickPending: true,
        moving: true,
        overrunZocHeld: true,
      },
    }),
    // 空军：货物损失与任务宣布同时成立
    baseFacts({
      kind: 'air',
      air: { step: 'declare', declared: false, cargoLossPending: true },
    }),
    // 突围：返场与突围尝试同时成立（两件事也必须只暴露一件）
    baseFacts({ kind: 'breakout', breakout: true, breakoutReturnPending: true }),
  ]

  it('任一会话一次只暴露一个待决事项（多待决同时出现即红）', () => {
    for (const facts of crowded) {
      const items = planSessionSteps(facts)
      expect(items.length).toBeGreaterThan(0)
      expect(exposedCount(items)).toBe(1)
    }
  })

  it('强制义务优先于选做事项', () => {
    for (const facts of crowded) {
      const items = planSessionSteps(facts)
      const firstOptional = items.findIndex((entry) => entry.optional)
      if (firstOptional >= 0) {
        expect(items.slice(firstOptional).every((entry) => entry.optional)).toBe(true)
      }
    }
  })
})

describe('U1-b 源码守卫：只在门里出一件，旧判定不留两份', () => {
  it('SessionStep 只有一个渲染条件，且带 data-session-item 标记', () => {
    const source = read('components/session/SessionStep.vue')
    // 只有 `v-if="active"` 一处渲染条件（不再有并列的 v-show / 第二套判据）
    expect(source).toContain('v-if="active"')
    expect(source).toContain('data-session-item')
    expect(source).not.toContain('v-show')
    // 门只认当前事项 id；「无宿主」与「宿主无待决」由 sessionStepVisible 分开
    expect(source).toContain('sessionStepVisible(hosted, step.value?.id ?? null, props.item)')
    expect(source).not.toContain('gate.value.id === props.item')
  })

  it('战斗面板：旧 state.step 判定已清掉，改由 SessionStep 对齐投影', () => {
    const source = read('components/combat/CombatPanel.vue')
    expect(source).toContain('<SessionStep')
    expect(source).not.toContain('state.step ===')
    for (const id of [
      'combat:declare',
      'combat:supply',
      'combat:ar:attacker',
      'combat:ar:defender',
      'combat:terrain',
      'combat:losses',
      'combat:options',
      'combat:retreat',
      'combat:advance',
    ]) {
      expect(source).toContain(`item="${id}"`)
    }
  })

  it('轰炸 / 补给面板：旧 step 判定已清掉', () => {
    const barrage = read('components/barrage/BarragePanel.vue')
    expect(barrage).toContain('<SessionStep')
    expect(barrage).not.toContain('barrageState?.step ===')

    const supply = read('components/supply/SupplyPanel.vue')
    expect(supply).toContain('<SessionStep')
    expect(supply).not.toContain("supplyState?.step === '")
    expect(supply).not.toContain('supplyChecklist')
  })

  it('空军 / 移动 / 增援面板：每个事项都有对应的门', () => {
    const air = read('components/air/AirPanel.vue')
    for (const id of [
      'air:declare',
      'air:cargoLoss',
      'air:airCombat',
      'air:interception',
      'air:flak',
      'air:resolve',
      'air:return',
    ]) {
      expect(air).toContain(`item="${id}"`)
    }

    const move = read('components/move/MovePanel.vue')
    for (const id of ['move:pick', 'move:continue']) {
      expect(move).toContain(`item="${id}"`)
    }
    // 用户 2026-11-10：加油入口改为右键 ⇒ 移动准备窗不再有「支付燃料」步
    expect(move).not.toContain('item="move:fuel"')
    // 4.5a-A 的停车是规则既定后果 ⇒ 「进入并突袭 / 进入停下」面板已删，会话步 `move:zoc` 一并移除
    expect(move).not.toContain('item="move:zoc"')

    const reinforce = read('components/reinforcement/ReinforcementPanel.vue')
    for (const id of [
      'reinforce:randomEvent',
      'reinforce:arrival',
      'reinforce:variableExit',
      'reinforce:frontalReserves',
      'reinforce:slow',
      'reinforce:replTable',
      'reinforce:specialRepl',
      'reinforce:supplyTable',
      'reinforce:rebuild',
      'reinforce:consolidation',
    ]) {
      expect(reinforce).toContain(`item="${id}"`)
    }
    expect(reinforce).not.toContain("segmentIn(['reinforcement.arrival'])")
    expect(reinforce).not.toContain("segmentIn(['reinforcement.rebuild'])")
  })

  it('宿主席仍是唯一会话框，且把当前事项注入给面板', () => {
    const dock = read('components/map/MapDock.vue')
    expect(dock).toContain('provide')
    expect(dock).toContain('SESSION_STEP_GATE')
    expect(dock).toContain('mapView.sessionStep')

    const table = read('views/GameTableView.vue')
    expect(table.match(/<MapDock/g)?.length ?? 0).toBe(1)
    // 突围：点击环节操作才出现会话框
    expect(table).toContain('openBreakoutNow')
  })

  it('store 侧暴露数投影恒为 0/1（不提供"多事项"接口）', () => {
    const source = read('stores/map-view.ts')
    expect(source).toContain('sessionStepCount')
    expect(source).toContain('exposedSessionStep')
    expect(source).not.toContain('sessionStepsVisible')
  })
})
