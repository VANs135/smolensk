import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { actionGateOf, useSetupStore, useWorkbenchStore, type ConsolePhase } from '@/stores'

import { CORE_HEX, NEAR_HEX, groundRecord, placeGround } from '../flows/sop-harness'

/**
 * 剧本级炮击折扣（Intro: Vitebsk 德军 −2T）必须接进**入口判据**
 *
 * 原文依据：`Smolensk_Vitebsk_Scenario.txt:56`「Arty Markers Available: 1」，
 * 标记面印 `-2T Cost`（PDF 第 1 页；见 docs §5.3）。10.1b 的成本取初始列，
 * 折扣后为 0 的炮击**不需要补给站**也应付得出。
 *
 * 修前 `barrageEntryEligible` 只算全局表原价：8 点轰炸原价 2T ⇒ 没有 2T 的站就连
 * 右键「炮击」入口都不出现，与折扣后的实际付款（0T）矛盾。
 */

const TARGET_HEX: HexRef = NEAR_HEX

function newStore() {
  setActivePinia(createPinia())
  useSetupStore().finished = true
  return useWorkbenchStore()
}

function enterStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: Parameters<typeof actionGateOf>[0],
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

/** 炮击现场：敌方目标 + 8 点印刷轰炸值的轴方火炮（原价 2T，Intro 折后 0T） */
function setupEightPointBarrage(withDumpT: number) {
  const workbench = newStore()
  workbench.setPhase('combat')
  enterStep(workbench, 'barrage.declare')
  const gun = placeGround(
    workbench,
    groundRecord(
      'axis',
      (record) =>
        (record.factors?.combat?.barrage ?? 0) > 0 && (record.factors?.combat?.range ?? 0) > 0,
    ),
    CORE_HEX,
    'axis',
    'art-1',
  )
  gun.raw.barrage = 8
  placeGround(
    workbench,
    groundRecord('soviet', (record) => record.isCombat === true),
    TARGET_HEX,
    'soviet',
    'def-1',
  )
  if (withDumpT > 0) {
    workbench.spDumps.push({ id: 'dump-1', hex: CORE_HEX, side: 'axis', sp: 0, t: withDumpT })
  }
  return workbench
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('Intro: Vitebsk 德军 −2T 接进入口判据（10.1b）', () => {
  it('★ 8 点炮击折后 0T ⇒ 没有补给站也出现「炮击」入口', () => {
    const workbench = setupEightPointBarrage(0)
    workbench.setScenarioId('Intro')
    expect(workbench.barrageEntryEligible(TARGET_HEX)).toBe(true)
  })

  it('对照：同一门炮在剧本 1（无折扣）只有 1T ⇒ 入口缺席', () => {
    const workbench = setupEightPointBarrage(1)
    expect(workbench.barrageEntryEligible(TARGET_HEX)).toBe(false)
  })
})
