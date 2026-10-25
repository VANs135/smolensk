import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { GamePhase } from '@/engine/state-types'
import { sopStepsOf } from '@/engine/rules'
import {
  ACTION_KEYS_WITHOUT_STORE_ENTRY,
  actionKeysOfSegment,
  phaseOfSegment,
} from '@/stores/workbench-model'
import { ACTION_GATES } from '@/stores/workbench-model'

/**
 * 用户 2026-10-25：**「按规则书分清楚每个阶段\环节有哪些操作，哪些是人工操作，
 * 哪些是自动结算」** —— 本文件把这条要求钉成不变量。
 *
 * 唯一依据链：`sop-segments`（规则书 2.2 的流程表：driver / actions）＋
 * `ACTION_GATES.where`（每条动作族的规则原文位置）⇒ `actionKeysOfSegment`（派生）。
 * 界面与文档都只读这条链，不各自拼一套。
 */

const PHASES: readonly GamePhase[] = [
  'preTurn',
  'aircraftRefit',
  'reinforcement',
  'movement',
  'supply',
  'reaction',
  'combat',
  'exploitation',
  'cleanUp',
  'turnEnd',
]

/** 该阶段里玩家要动手时的行动者角色（E 反应段是**非行动方**，7.0） */
function roleOf(phase: GamePhase): 'active' | 'nonActive' {
  return phase === 'reaction' ? 'nonActive' : 'active'
}

/**
 * 该环节**归谁动手**（`sides` 缺省＝双方通用；轴方专属/苏方专属的环节只有那一方有动作）
 *
 * 例：`reinforcement.specialRepl` / `reinforcement.frontalReserves` 带 `sides: ['soviet']`
 * ⇒ 用 `axis` 去问会得到空集（不是缺陷，是"轮不到轴方"）。
 */
function sideOf(step: { sides?: readonly string[] }): 'axis' | 'soviet' {
  return step.sides?.[0] === 'soviet' ? 'soviet' : 'axis'
}

function stepsOf(phase: GamePhase) {
  return sopStepsOf(phase).map((step) => ({
    id: step.id,
    driver: step.driver,
    keys: [...actionKeysOfSegment(step.id, sideOf(step), roleOf(phase))].sort(),
  }))
}

describe('阶段/环节 × 操作矩阵（规则书口径）', () => {
  it('★ 自动结算的环节**不允许任何玩家动作**（只给回执，不铺动作 UI）', () => {
    const offenders: string[] = []
    for (const phase of PHASES) {
      for (const step of sopStepsOf(phase)) {
        if (step.driver === 'player' || step.driver === 'question') continue
        const keys = actionKeysOfSegment(step.id, sideOf(step), roleOf(phase))
        if (keys.size > 0) offenders.push(`${step.id} → ${[...keys].join(',')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('★ 人工环节**至少有一条动作**（否则玩家走到那儿点不动任何东西）', () => {
    const empty: string[] = []
    for (const phase of PHASES) {
      for (const step of sopStepsOf(phase)) {
        if (step.driver !== 'player') continue
        const keys = actionKeysOfSegment(step.id, sideOf(step), roleOf(phase))
        if (keys.size === 0) empty.push(step.id)
      }
    }
    expect(empty).toEqual([])
    /*
     * 唯一"有动作族但点不动"的环节：`reinforcement.specialRepl`（专规 1.6c）。
     * 它**不是**闸门问题，而是**功能未实现**（store 里没有入口）⇒ 由既有守卫表登记，
     * 一旦补上入口，`ACTION_KEYS_WITHOUT_STORE_ENTRY` 会逼着把它删掉。
     */
    expect(ACTION_KEYS_WITHOUT_STORE_ENTRY).toContain('rein.specialRepl')
  })

  it('★ 每个动作族都有**至少一个**环节放行（没有死闸门）', () => {
    const reachable = new Set<string>()
    for (const phase of PHASES) {
      for (const step of sopStepsOf(phase)) {
        for (const side of ['axis', 'soviet'] as const) {
          for (const key of actionKeysOfSegment(step.id, side, roleOf(phase))) reachable.add(key)
        }
      }
    }
    const dead = ACTION_GATES.map((gate) => gate.key).filter((key) => !reachable.has(key))
    /*
     * `move.breakout` 的环节标了 skipWhenIdle（本局无人可突围 ⇒ 环节被跳过），`sopStepsOf` 仍列它
     * ⇒ 其实可达；`exclusive.panzerObligation` 是**段末义务**（`at: 'end'`），只在段末声明时放行，
     * 本测试未声明段末故不在集合里（不是死闸门）。
     */
    expect(dead).toEqual(['exclusive.panzerObligation'])
  })

  it('★ 具体环节的关键动作（抽样，防漂移）', () => {
    const expectKeys = (
      stepId: string,
      keys: string[],
      role: 'active' | 'nonActive' = 'active',
    ) => {
      const got = [...actionKeysOfSegment(stepId, 'axis', role)].sort()
      for (const key of keys) expect(got, `${stepId} 缺 ${key}`).toContain(key)
    }
    // A 段：只有整备（15.1）
    expect([...actionKeysOfSegment('aircraftRefit.refit', 'axis', 'active')]).toEqual(['air.refit'])
    // B 段：到货落位 13.6 + 免费铁运 专规 2.1；重建 13.5/13.9；编队抽取（轴方）
    expectKeys('reinforcement.arrival', ['rein.arrival', 'rein.supplyArrival'])
    expectKeys('reinforcement.rebuild', ['rein.rebuild'])
    expectKeys('reinforcement.formationDraw', ['rein.formationDraw'])
    // C 段：模式/移动/突袭/铁路/装卸/工事/拆分 + 燃料 + 空中任务
    expectKeys('movement.modeAndMovement', [
      'move.order',
      'move.overrun',
      'move.modeChange',
      'move.railTransport',
      'move.railConversion',
      'move.loadUnload',
      'move.construction',
      'move.hedgehog',
      'move.breakdown',
      'supply.fuel',
      'air.mission',
    ])
    // C 段轰炸环节：10.0 原文「仅空中与舰炮」⇒ 没有 combat.declare、没有 move.*
    const barrage = [...actionKeysOfSegment('movement.barrage', 'axis', 'active')].sort()
    expect(barrage).toContain('barrage.declare')
    expect(barrage).not.toContain('combat.declare')
    expect(barrage).not.toContain('move.order')
    // F 段战斗：只有战斗与拆分（8.1 / 9.2）
    const combat = [...actionKeysOfSegment('combat.combat', 'axis', 'active')].sort()
    expect(combat).toContain('combat.declare')
    expect(combat).not.toContain('barrage.declare')
    // E 段（非行动方）：预备释放 5.7b + 移动/突袭 + 空中任务，且**没有**战斗宣告
    expectKeys('reaction.movement', ['reserve.release', 'move.order', 'move.overrun'], 'nonActive')
    expect([...actionKeysOfSegment('reaction.movement', 'soviet', 'nonActive')]).not.toContain(
      'combat.declare',
    )
    // D 段：补给恢复 / 拖取 / 损耗 + 觅食（exclusive.forage）
    expectKeys('supply.check', ['supply.draw', 'supply.attrition', 'exclusive.forage'])
  })

  it('★ 环节 id 的阶段解析（前缀即阶段；认不出就返回 null，不猜）', () => {
    expect(phaseOfSegment('movement.modeAndMovement')).toBe('movement')
    expect(phaseOfSegment('reinforcement.arrival')).toBe('reinforcement')
    expect(phaseOfSegment('reaction.barrage')).toBe('reaction')
    expect(phaseOfSegment('nonsense.step')).toBeNull()
    expect(phaseOfSegment('')).toBeNull()
  })

  it('★ 界面按环节收敛（样板：增援面板的区块全由 `segmentIn` 控显隐）', () => {
    const panel = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')
    // 每个 B 段子环节都要有对应区块（人工环节出动作区、自动环节只留回执）
    for (const step of [
      'reinforcement.arrival',
      'reinforcement.replRoll',
      'reinforcement.rebuild',
      'reinforcement.frontalReserves',
    ]) {
      expect(panel, `增援面板缺 ${step} 的区块收敛`).toContain(`'${step}'`)
    }
    // 7 个区块：到达表 / 可变增援 / SP 落位 / 补员 / 重建 / 拆分合并 / 方面军预备队
    expect((panel.match(/workbench\.segmentIn\(/g) ?? []).length).toBeGreaterThanOrEqual(7)
    // "人工 / 自动"的界面分界（自动环节只给回执）
    expect(panel).toContain("workbench.segmentDriver === 'automatic'")
  })

  it('★ 矩阵快照：25 个环节各自的动作族（改动 ACTION_GATES 必须同步改这里）', () => {
    const matrix = PHASES.flatMap((phase) =>
      stepsOf(phase).map((step) => `${step.driver.padEnd(9)} ${step.id} → ${step.keys.join(',')}`),
    )
    expect(matrix).toEqual([
      'automatic preTurn.weatherDetermination → ',
      'question  preTurn.firstPlayerDetermination → ',
      'player    aircraftRefit.refit → air.refit',
      'automatic reinforcement.replRoll → ',
      'player    reinforcement.arrival → rein.arrival,rein.supplyArrival',
      'automatic reinforcement.randomEvent → ',
      'automatic reinforcement.variableExit → ',
      'player    reinforcement.rebuild → rein.rebuild',
      'player    reinforcement.formationDraw → rein.formationDraw',
      'player    reinforcement.specialRepl → rein.specialRepl',
      'player    reinforcement.frontalReserves → rein.frontalReserves',
      'player    movement.breakout → move.breakout',
      'player    movement.modeAndMovement → air.baseReduce,air.mission,barrage.declare,move.breakdown,move.construction,move.dumpBlow,move.extenderConvert,move.hedgehog,move.loadUnload,move.modeChange,move.order,move.overrun,move.railConversion,move.railTransport,supply.fuel',
      'player    movement.barrage → air.mission,barrage.declare',
      'player    supply.recovery → exclusive.forage,supply.draw,supply.recovery',
      'player    supply.check → exclusive.forage,supply.attrition,supply.draw',
      'player    reaction.movement → air.mission,move.dumpBlow,move.extenderConvert,move.order,move.overrun,reserve.release,supply.fuel',
      'player    reaction.barrage → air.mission,barrage.declare',
      'player    combat.barrage → barrage.declare',
      'player    combat.combat → combat.declare,move.breakdown',
      'player    exploitation.movement → air.mission,move.dumpBlow,move.extenderConvert,move.order,move.overrun,reserve.release,supply.fuel',
      'player    exploitation.barrage → air.mission,barrage.declare',
      'player    exploitation.combat → combat.declare,move.breakdown',
      'automatic cleanUp.auto → ',
      'automatic turnEnd.advance → ',
    ])
  })
})
