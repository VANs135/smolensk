import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { actionGateOf, useContainersStore, useWorkbenchStore, type ActionKey } from '@/stores'

import { CORE_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 20.0a / 20.0b / 20.0c / 20.0d：步兵拆分（用户 2026-11-10 口径）
 *
 * 三条要求：
 *   ① **不依赖「开始移动」**：本方移动环节里，本阶段**尚未动过**（`mpSpent === 0`）的单位
 *      可以直接拆 —— 拆分本身就是它"开始移动"的那一刻，不该先逼玩家点一次「开始移动」；
 *      已经动过的单位才必须靠 20.0a 的另两个事件（战后推进 / 战后撤退）开窗。
 *   ② **AR 匹配 + 选数量两步**：第一步按母单位 AR 过滤可用的档（20.0b），第二步选数量，
 *      一次可取多枚（20.0「创建一个或多个」），数量受「最后一点军力不能拆」限制。
 *   ③ **母子模式 / DG / MA 按原文继承**：20.0c 要求标记与模式相同 ⇒ 子算子的 mode / DG /
 *      部队储备直接取自母单位（MA 是子算子自己的印值）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), containers: useContainersStore() }
}

function enterStep(workbench: ReturnType<typeof useWorkbenchStore>, key: ActionKey): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === workbench.phase)
    .map((item) => item.segment)
  const index = workbench.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${workbench.phase} 段没有允许 ${key} 的环节`)
  if (!workbench.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

const infDivRecord = (side: 'axis' | 'soviet') =>
  groundRecord(side, (record) => /Inf Div|Rifle Div/i.test(record.vassalName ?? ''))

/** 进入「本方移动环节」并摆一枚未动过的步兵师（不点开始移动） */
function readyParent(
  instanceId = 'p1',
  record: ReturnType<typeof groundRecord> = infDivRecord('soviet'),
) {
  const { workbench, containers } = newStores()
  workbench.setPhase('movement')
  workbench.setActiveSide('soviet')
  enterStep(workbench, 'move.breakdown')
  const parent = placeGround(workbench, record, CORE_HEX, 'soviet', instanceId)
  return { workbench, containers, parent }
}

const kidsOf = (workbench: ReturnType<typeof useWorkbenchStore>) =>
  workbench.units.filter((unit) => unit.specialized.includes('breakdown'))

describe('20.0a：拆分不依赖「开始移动」', () => {
  it('未动过的步兵在本方移动环节可直接拆分（没有移动会话也允许）', () => {
    const { workbench, containers, parent } = readyParent()
    expect(workbench.moveInteraction).toBeNull()
    expect(workbench.breakdownTimingOf(parent.instanceId)).toBe('startMove')
    expect(containers.takeBreakdown({ parentInstanceId: parent.instanceId, breakdownAr: 2 })).toBe(
      true,
    )
    expect(containers.lastAction).toMatchObject({ ok: true, rule: '20.0' })
  })

  it('已经动过（mpSpent > 0）且没有事件窗口 ⇒ 不在 20.0a 时机，拒绝并报条文', () => {
    const { workbench, containers, parent } = readyParent()
    parent.mpSpent = 1
    expect(workbench.breakdownTimingOf(parent.instanceId)).toBeNull()
    expect(containers.takeBreakdown({ parentInstanceId: parent.instanceId, breakdownAr: 2 })).toBe(
      false,
    )
    expect(containers.lastAction).toMatchObject({ ok: false, rule: '20.0a' })
  })

  it('非本方移动阶段（如战斗阶段）不钻空子：时机判据只看本人移动环节', () => {
    const { workbench, parent } = readyParent()
    expect(workbench.breakdownTimingOf(parent.instanceId)).toBe('startMove')
    workbench.setActiveSide('axis')
    expect(workbench.breakdownTimingOf(parent.instanceId)).toBeNull()
  })
})

describe('20.0b / 20.0：AR 匹配 + 选数量', () => {
  it('AR 高于母单位 ⇒ 20.0b 拒绝（先 AR 匹配再选数量）', () => {
    const { containers, parent } = readyParent()
    const parentAr = parent.faces.combat.ar
    expect(
      containers.takeBreakdown({ parentInstanceId: parent.instanceId, breakdownAr: parentAr + 1 }),
    ).toBe(false)
    expect(containers.lastAction).toMatchObject({ ok: false, rule: '20.0b' })
  })

  it('一次取多枚：母单位 −N、盘面多 N 枚拆分单位（20.0“一个或多个”）', () => {
    // 3 军力师（20.0：最后一点军力不能拆 ⇒ 一次最多 2 枚）
    const { workbench, containers, parent } = readyParent(
      'p1',
      groundRecord('soviet', (record) => /Ru 100 Rifle Div/i.test(record.vassalName ?? '')),
    )
    const before = parent.steps
    expect(
      containers.takeBreakdown({ parentInstanceId: parent.instanceId, breakdownAr: 2, count: 2 }),
    ).toBe(true)
    expect(parent.steps).toBe(before - 2)
    const kids = kidsOf(workbench)
    expect(kids).toHaveLength(2)
    for (const kid of kids) {
      expect(kid.steps).toBe(1)
      expect(kid.hex).toEqual({ col: CORE_HEX.col, row: CORE_HEX.row })
    }
  })

  it('最后一点军力不能拆：count 取到母单位军力上限即 20.0 拒绝', () => {
    const { containers, parent } = readyParent()
    expect(
      containers.takeBreakdown({
        parentInstanceId: parent.instanceId,
        breakdownAr: 2,
        count: parent.steps,
      }),
    ).toBe(false)
    expect(containers.lastAction).toMatchObject({ ok: false, rule: '20.0' })
  })
})

describe('20.0c：母子模式 / DG / 部队储备按原文继承', () => {
  it('母单位移动模式 + DG ⇒ 拆出的子算子同模式、同 DG、同部队储备', () => {
    const { workbench, containers, parent } = readyParent()
    parent.mode = { ...parent.mode, mode: 'move', dg: true }
    parent.internalStocks = 'low'
    expect(containers.takeBreakdown({ parentInstanceId: parent.instanceId, breakdownAr: 2 })).toBe(
      true,
    )
    const kid = kidsOf(workbench)[0]!
    expect(kid.mode.mode).toBe('move')
    expect(kid.mode.dg).toBe(true)
    expect(kid.internalStocks).toBe('low')
  })
})

describe('面板守卫：两步（AR 匹配 → 选数量）与去「开始移动」依赖', () => {
  const source = readFileSync(
    new URL('../../src/components/containers/ContainersPanel.vue', import.meta.url),
    'utf8',
  )

  it('AR 档按母单位 AR 过滤，数量在提交时一并交给 takeBreakdown', () => {
    expect(source).toContain('breakdownArChoices')
    expect(source).toContain('breakdownCountNow')
    expect(source).toMatch(/containers\.takeBreakdown\(\{[\s\S]{0,200}count:/)
  })

  it('不再要求"先让母单位开始移动"', () => {
    expect(source).not.toContain('先让母单位开始移动')
  })

  it('HexRef 类型仍可用于落点断言（避免未使用告警）', () => {
    const hex: HexRef = CORE_HEX
    expect(hex.col).toBeGreaterThan(0)
  })
})
