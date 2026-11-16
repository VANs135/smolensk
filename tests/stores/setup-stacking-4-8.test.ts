import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { formations, mapLayers } from '@/data'
import { hexsideOf } from '@/engine/hex-geometry'
import { shiftWestDestination } from '@/engine/rules'
import { axisDrawPool } from '@/engine/rules/containers'
import {
  currentReOf,
  useContainersStore,
  useGameSessionStore,
  useSetupStore,
  useWorkbenchStore,
} from '@/stores'

import { fresh } from '../flows/flow-harness'
import { confirmSetupForStart } from '../flows/setup-harness'

/**
 * IV-F / 4.8：初设不得超堆叠
 *
 * 原文：
 *   · 4.8：`The maximum number of combat units allowed to stack in a hex is 10 RE.`
 *   · 4.8a：超堆叠只在**移动/撤退过程中**临时发生，且必须在阶段末消解；
 *     唯一的例外是**增援阶段**不查堆叠（13.6）。
 *   · IV-F：`Units cannot set up over-stacked.` ⇒ 初设**没有**豁免，必须 ≤10 RE。
 *   · 9.11d：多步师按当前 RE（印刷 − 已损）计。
 *
 * 本文件扫两件事：
 *   ① 八个剧本（1–7 + Intro）按预设初设落完后的每一格 ≤10 RE；
 *   ② 剧本 1/2 的西移组在全部 C(12,4)=495 种抽取组合下，自动落点也不超 10 RE；
 *   ③ 无道路落点时玩家补写的落点若超 10 RE，必须被拒（IV-F，而不是悄悄放行）。
 */

const IDS = ['1', '2', '3', '4', '5', '6', '7', 'Intro'] as const

function overstackHexes(ctx: ReturnType<typeof fresh>) {
  const map = new Map<string, { re: number; units: string[] }>()
  for (const unit of ctx.w.units) {
    if (!unit.isCombat) continue
    const key = `${unit.hex.col}.${unit.hex.row}`
    const row = map.get(key) ?? { re: 0, units: [] }
    row.re += currentReOf(unit)
    row.units.push(`${unit.name}(RE ${currentReOf(unit)})`)
    map.set(key, row)
  }
  return [...map.entries()].filter(([, row]) => row.re > 10).map(([hex, row]) => ({ hex, ...row }))
}

describe('IV-F：逐剧本初设落位不超过 10 RE', () => {
  it.each(IDS)('剧本 %s：预设初设后无超堆叠格', (id) => {
    const ctx = fresh()
    ctx.setup.enterSetup(id)
    const preset = ctx.setup.presetSelfSetupNow()
    expect(preset.failures).toEqual([])
    expect(preset.remaining).toBe(0)
    expect(overstackHexes(ctx)).toEqual([])
  })
})

describe('ch10 西移：全部 495 种抽取组合的自动落点仍 ≤10 RE', () => {
  it.each(['1', '2'] as const)('剧本 %s', (id) => {
    const ctx = fresh()
    ctx.setup.enterSetup(id)
    ctx.setup.presetSelfSetupNow()

    const sides = new Set(
      mapLayers.edges
        .filter((edge) => edge.road !== undefined || edge.rail !== undefined)
        .map((edge) => hexsideOf(edge.a, edge.b)?.key)
        .filter((key): key is string => key !== undefined),
    )
    const hasEdge = (a: { col: number; row: number }, b: { col: number; row: number }) => {
      const side = hexsideOf(a, b)
      return side !== null && sides.has(side.key)
    }

    const pool = axisDrawPool(id).map((entry) => entry.formationId)
    const codeOf = new Map(
      formations.formations.map((formation) => [formation.formationId, formation.formationCode]),
    )
    const codeSet = new Set(pool.map((formationId) => codeOf.get(formationId)))
    const combat = ctx.w.units.filter((unit) => unit.isCombat)
    const info = new Map(
      pool.map((formationId) => {
        const own = combat.filter((unit) => unit.formation === codeOf.get(formationId))
        return [
          formationId,
          {
            re: own.reduce((sum, unit) => sum + currentReOf(unit), 0),
            anchor: own[0]?.hex,
            dest: own[0]?.hex === undefined ? null : shiftWestDestination(own[0].hex, 3, hasEdge),
          },
        ] as const
      }),
    )
    const base = new Map<string, number>()
    for (const unit of combat.filter((entry) => !codeSet.has(entry.formation ?? ''))) {
      const key = `${unit.hex.col}.${unit.hex.row}`
      base.set(key, (base.get(key) ?? 0) + currentReOf(unit))
    }
    const sumsOf = (drawn: ReadonlySet<string>) => {
      const sums = new Map(base)
      for (const formationId of pool) {
        const row = info.get(formationId)!
        // 与 runSetupDrawsNow 同口径：算不出整段落点（exact=false）就留在原格
        const target = drawn.has(formationId) && row.dest?.exact ? row.dest.hex : row.anchor
        if (target === undefined || target === null) continue
        const key = `${target.col}.${target.row}`
        sums.set(key, (sums.get(key) ?? 0) + row.re)
      }
      return sums
    }

    let max = 0
    const combo: string[] = []
    const walk = (start: number) => {
      if (combo.length === 4) {
        for (const re of sumsOf(new Set(combo)).values()) {
          if (re > max) max = re
        }
        return
      }
      for (let index = start; index < pool.length; index += 1) {
        combo.push(pool[index]!)
        walk(index + 1)
        combo.pop()
      }
    }
    walk(0)
    expect(max).toBeLessThanOrEqual(10)
  })
})

describe('IV-F：玩家补写的西移落点也要过 10 RE', () => {
  it('玩家把已抽中的西移师改点到满堆叠格必须被拒', () => {
    setActivePinia(createPinia())
    const game = useGameSessionStore()
    const workbench = useWorkbenchStore()
    const containers = useContainersStore()
    const setup = useSetupStore()
    game.setScenarioId('1')
    containers.setScenario('1')
    setup.selectScenario('1')
    confirmSetupForStart(setup, { draws: false })
    // 强制抽中西移组，自动落位后仍可由玩家改落点（UI 的“落点”输入）
    containers.drawResults = {
      '1': [
        {
          kind: 'shiftWest',
          formationIds: ['20 Pz Div', '3 Pz Div', '10 Pz Div', '4 Pz Div'],
          detail: '测试：强制抽中 20 Pz',
        },
      ],
    }
    expect(setup.drawSetupEffectsNow()).toBe(true)

    const pending = containers.pendingShiftWestPlacements.filter((item) =>
      ['20 Pz Div', '3 Pz Div', '10 Pz Div', '4 Pz Div'].includes(item.formationId),
    )
    expect(pending).toHaveLength(4)
    const moving = new Set(pending.flatMap((item) => item.unitIds))
    expect(moving.size).toBeGreaterThan(0)
    const movingRe = workbench.units
      .filter((unit) => moving.has(unit.instanceId) && unit.isCombat)
      .reduce((sum, unit) => sum + currentReOf(unit), 0)
    // 找一格堆得最高的友军格（排除这四个师的算子），把四个师一起改点过去必然超 10 RE
    const reByHex = new Map<string, number>()
    for (const unit of workbench.units) {
      if (!unit.isCombat || moving.has(unit.instanceId)) continue
      const key = `${unit.hex.col}.${unit.hex.row}`
      reByHex.set(key, (reByHex.get(key) ?? 0) + currentReOf(unit))
    }
    const full = [...reByHex.entries()].sort((a, b) => b[1] - a[1])[0]!
    expect(full[1] + movingRe).toBeGreaterThan(10)

    for (const item of pending) {
      expect(containers.setDrawShiftHexNow(item.formationId, full[0])).toBe(true)
    }
    expect(containers.applyShiftWestPlacementsNow()).toBe(false)
    expect(containers.lastAction?.rule).toBe('IV-F / 4.8')
    expect(containers.lastAction?.detail).toContain('超堆叠')
    // 整笔拒绝：四个师的算子都没有搬进超限格
    for (const instanceId of moving) {
      const unit = workbench.units.find((entry) => entry.instanceId === instanceId)
      expect(`${unit?.hex.col}.${unit?.hex.row}`).not.toBe(full[0])
    }
  })
})
