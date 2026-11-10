import { describe, expect, it } from 'vitest'

import { ACTION_GATES, buildLegalActionsView, type LegalActionsInput } from '@/stores/legal-actions'
import { useLegalActionsStore } from '@/stores/legal-actions-store'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useContainersStore,
  useMapViewStore,
} from '@/stores'

import { fillSetup, fresh } from '../flows/flow-harness'
import {
  CORE_HEX,
  airBaseRecord,
  fighterRecord,
  label,
  newConsole,
  placeAir,
  placeGround,
  type Workbench,
} from '../flows/sop-harness'

/**
 * B1：**合法动作只读聚合视图**
 *
 * 只验证"搬运"：视图里的每条 entry 都必须来自 `ACTION_GATES` 与既有 store 投影，
 * 不新增任何规则判据、不造候选。纯函数一层逐条钉住状态机，store 一层只钉"真的读得到"。
 */

function input(overrides: Partial<LegalActionsInput> = {}): LegalActionsInput {
  return {
    phase: 'movement',
    segment: 'movement.modeAndMovement',
    role: 'active',
    side: 'axis',
    gatedKeys: new Set<string>(),
    terminated: false,
    locked: false,
    advance: { available: false, submit: 'advanceSegmentNow' },
    answer: { awaiting: false, options: [] },
    setup: { active: false, choices: [] },
    candidates: {},
    ...overrides,
  }
}

function entryOf(view: ReturnType<typeof buildLegalActionsView>, key: string) {
  const found = view.entries.find((entry) => entry.key === key)
  expect(found, `视图里没有 ${key}`).toBeDefined()
  return found!
}

describe('纯函数：按闸门表逐条搬运', () => {
  it('ACTION_GATES 每个 key 恰好出现一次，且顺序与闸门表一致', () => {
    const view = buildLegalActionsView(input())
    const gateEntries = view.entries.filter((entry) =>
      ACTION_GATES.some((gate) => gate.key === entry.key),
    )
    expect(gateEntries).toHaveLength(ACTION_GATES.length)
    expect(gateEntries.map((entry) => entry.key)).toEqual(ACTION_GATES.map((gate) => gate.key))
  })

  it('未 gated ⇒ blocked（即使给了候选）', () => {
    const candidates = [{ ref: 'u1', label: 'U1' }]
    const view = buildLegalActionsView(input({ candidates: { 'move.order': candidates } }))
    const entry = entryOf(view, 'move.order')
    expect(entry.gated).toBe(false)
    expect(entry.status).toBe('blocked')
    expect(entry.candidates).toEqual([])
  })

  it('gated 但无候选投影 ⇒ unsupported 且 note 非空', () => {
    const view = buildLegalActionsView(input({ gatedKeys: new Set(['move.order']) }))
    const entry = entryOf(view, 'move.order')
    expect(entry.status).toBe('unsupported')
    expect(entry.candidates).toEqual([])
    expect(entry.note ?? '').toContain('尚无单位/格级候选投影')
  })

  it('gated 且有候选 ⇒ available 且候选原样搬运', () => {
    const candidates = [
      { ref: 'u1', label: 'U1' },
      { ref: 'u2', label: 'U2', disabledReason: '测试原因' },
    ]
    const view = buildLegalActionsView(
      input({ gatedKeys: new Set(['move.order']), candidates: { 'move.order': candidates } }),
    )
    const entry = entryOf(view, 'move.order')
    expect(entry.status).toBe('available')
    expect(entry.candidates).toEqual(candidates)
  })

  it('空候选与全被拒候选均不可点', () => {
    const disabled = { ref: 'a', label: '飞机', disabledReason: '本阶段已整备' }
    const view = buildLegalActionsView(
      input({
        gatedKeys: new Set(['move.order', 'air.refit']),
        candidates: { 'move.order': [], 'air.refit': [disabled] },
      }),
    )
    expect(entryOf(view, 'move.order')).toMatchObject({ status: 'blocked', clickable: false })
    expect(entryOf(view, 'air.refit')).toMatchObject({
      status: 'blocked',
      clickable: false,
      candidates: [disabled],
    })
  })
})

describe('U0：没有提交入口的动作不得显示为可点', () => {
  it('submit === "" 的 entry 即使 available 也 clickable=false', () => {
    // ch10（2026-11-10）：`rein.formationDraw` 已从动作词表删除 ⇒ 只剩这一条空提交入口
    const keys = ['exclusive.panzerObligation']
    const candidates = Object.fromEntries(keys.map((key) => [key, [{ ref: 'x', label: 'X' }]]))
    const view = buildLegalActionsView(input({ gatedKeys: new Set(keys), candidates }))
    for (const key of keys) {
      const entry = entryOf(view, key)
      expect(entry.status).toBe('available')
      expect(entry.submit).toBe('')
      expect(entry.clickable).toBe(false)
      expect(entry.note ?? '').toContain('无既有提交入口')
    }
  })

  it('有提交入口且 available ⇒ clickable=true；blocked ⇒ false', () => {
    const view = buildLegalActionsView(
      input({
        gatedKeys: new Set(['move.order']),
        candidates: { 'move.order': [{ ref: 'u1', label: 'U1' }] },
      }),
    )
    expect(entryOf(view, 'move.order').clickable).toBe(true)
    expect(entryOf(view, 'move.overrun').clickable).toBe(false)
  })
})

describe('terminated / locked 的总闸', () => {
  for (const flag of ['terminated', 'locked'] as const) {
    it(`${flag} ⇒ 非 phase.advance / panel.answer 的 entry 一律 blocked`, () => {
      const gatedKeys = new Set<string>(ACTION_GATES.map((gate) => gate.key))
      const view = buildLegalActionsView(
        input({
          [flag]: true,
          gatedKeys,
          candidates: { 'move.order': [{ ref: 'u1', label: 'U1' }] },
          setup: {
            active: true,
            choices: [{ entryIndex: 1, label: '步兵', hexes: [{ ref: '1.2', label: '1.2' }] }],
          },
        }),
      )
      const others = view.entries.filter(
        (entry) => entry.key !== 'phase.advance' && entry.key !== 'panel.answer',
      )
      expect(others.length).toBeGreaterThan(0)
      expect(others.every((entry) => entry.status === 'blocked')).toBe(true)
    })
  }
})

describe('panel.answer', () => {
  it('awaiting 且有选项 ⇒ available，候选就是选项', () => {
    const view = buildLegalActionsView(
      input({
        answer: {
          awaiting: true,
          options: [
            { id: 'first', label: '先手' },
            { id: 'second', label: '后手' },
          ],
        },
      }),
    )
    const entry = entryOf(view, 'panel.answer')
    expect(entry.status).toBe('available')
    expect(entry.submit).toBe('answerNow')
    expect(entry.candidates).toEqual([
      { ref: 'first', label: '先手' },
      { ref: 'second', label: '后手' },
    ])
  })

  it('未 awaiting ⇒ blocked', () => {
    const view = buildLegalActionsView(input())
    expect(entryOf(view, 'panel.answer').status).toBe('blocked')
  })
})

describe('setup.place', () => {
  it('active + 2 项候选 ⇒ available，ref 按 entryIndex:格号 拼接', () => {
    const view = buildLegalActionsView(
      input({
        setup: {
          active: true,
          choices: [
            {
              entryIndex: 3,
              label: '步兵',
              hexes: [
                { ref: '1.2', label: '1.2' },
                { ref: '3.4', label: '3.4' },
              ],
            },
          ],
        },
      }),
    )
    const entry = entryOf(view, 'setup.place')
    expect(entry.status).toBe('available')
    expect(entry.submit).toBe('placeSelfEntry')
    expect(entry.candidates).toHaveLength(2)
    expect(entry.candidates.map((candidate) => candidate.ref)).toEqual(['3:1.2', '3:3.4'])
    expect(entry.candidates[0]!.label).toBe('步兵 ⇒ 1.2')
  })

  it('不 active ⇒ blocked', () => {
    const view = buildLegalActionsView(input())
    expect(entryOf(view, 'setup.place').status).toBe('blocked')
  })
})

describe('store 适配层：只读投影真的读得到', () => {
  it.each(['axis', 'soviet'] as const)('1.6c %s：增援会话可掷一次，读档后仍不可重掷', (side) => {
    const { w } = fresh()
    const legal = useLegalActionsStore()
    const containers = useContainersStore()
    const map = useMapViewStore()
    w.setActiveSide(side)
    expect(entryOf(legal.view, 'rein.specialRepl').clickable).toBe(false)
    w.setPhase('reinforcement')
    expect(
      w.setSegmentStepIndex(
        w.playerSegmentSteps.findIndex((step) => step.id === 'reinforcement.specialRepl'),
      ),
    ).toBe(true)
    expect(map.sessionSteps.map((step) => step.id)).toContain('reinforce:specialRepl')
    expect(entryOf(legal.view, 'rein.specialRepl')).toMatchObject({
      status: 'available',
      clickable: true,
      submit: 'drawSpecialRepl',
      candidates: [{ ref: side, label: '掷特殊补员表' }],
    })
    expect(containers.drawSpecialRepl(side)).toBe(true)
    const rng = w.rng
    const snapshot = w.snapshotBoard()
    w.resetBoardNow()
    w.setPhase('reinforcement')
    w.restoreBoard(snapshot, true)
    expect(entryOf(legal.view, 'rein.specialRepl')).toMatchObject({
      status: 'blocked',
      clickable: false,
      note: '本回合已掷表',
    })
    w.rng = rng
    expect(containers.drawSpecialRepl(side)).toBe(false)
    expect(w.rng).toEqual(rng)
  })
  it('剧本 1 进入初设后：side 可读、setup.place 有候选', () => {
    const ctx = fresh()
    expect(ctx.setup.enterSetup('1')).toBe(true)
    const legal = useLegalActionsStore()
    expect(['axis', 'soviet']).toContain(legal.view.side)
    const place = entryOf(legal.view, 'setup.place')
    expect(place.status).toBe('available')
    expect(place.candidates.length).toBeGreaterThan(0)
    expect(place.candidates.every((candidate) => candidate.ref.includes(':'))).toBe(true)
  })

  it(
    '摆完初设并开局后：phase=aircraftRefit、phase.advance 可用、全部闸门 key 都在',
    { timeout: 20000 },
    () => {
      const ctx = fresh()
      expect(ctx.setup.enterSetup('1')).toBe(true)
      fillSetup(ctx)
      expect(ctx.setup.startGameNow()).toBe(true)

      const legal = useLegalActionsStore()
      expect(legal.view.phase).toBe('aircraftRefit')
      expect(entryOf(legal.view, 'phase.advance').status).toBe('available')
      for (const gate of ACTION_GATES) expect(entryOf(legal.view, gate.key)).toBeDefined()
    },
  )
})

describe('P0-02c：候选 ref 必须是提交入口真正接收的参数', () => {
  it('A 整备：候选给基地 id（不是飞机 id），beginRefitNow 原样接受', () => {
    const w = newConsole()
    w.setAirActive(true)
    placeGround(w, airBaseRecord(), CORE_HEX, 'axis', 'base-1')
    placeAir(w, fighterRecord('axis'), CORE_HEX, 'axis', 'air-1', 'inactive')
    w.setSupplyActive(true)
    w.spDumpDraft = { hexText: label(CORE_HEX), sp: 1, t: 0 }
    w.addSpDump()
    w.setPhase('aircraftRefit')

    const legal = useLegalActionsStore()
    const entry = entryOf(legal.view, 'air.refit')
    expect(entry.status).toBe('available')
    expect(entry.submit).toBe('beginRefitNow')
    const refs = entry.candidates.map((candidate) => candidate.ref)
    // 15.1：提交入口收的是**基地**；把飞机 id 当候选 ⇒ 点了也开不了整备
    expect(refs).toEqual(['base-1'])
    expect(refs).not.toContain('air-1')
    expect(w.beginRefitNow(refs[0]!)).toBe(true)
    expect(w.refitBase?.id).toBe('base-1')
  })

  /** 剧本 1 的轴方图边补给源格（与 free-rail-arrival-flow.test 同一清单） */
  const AXIS_SOURCES = ['1.03', '1.04', '1.07', '1.12', '1.19', '1.26', '4.00', '8.00']

  /** 摆一套「轴方在剧本 1 的可用铁路状态」并进入 B 段到货环节 */
  function armSupplyArrival(w: Workbench): void {
    w.setScenarioId('1')
    w.seedConvertedRailsNow()
    for (const text of AXIS_SOURCES) {
      const [col, row] = text.split('.').map(Number)
      w.supplySourceDecls.push({
        id: `src-${text}`,
        hex: { col: col!, row: row! },
        side: 'axis',
        kind: 'edgeRail',
      })
    }
    const record = unitChoices('axis').find(
      (item) => item.isCombat === true && item.attackCapable === true,
    )
    if (record === undefined) throw new Error('轴方单位库里没有战斗单位')
    w.units.push(
      toConsoleUnit({ record, instanceId: 'u-0', hex: { col: 2, row: 2 }, side: 'axis' }),
    )
    w.setPhase('reinforcement')
    const allowed = actionGateOf('rein.supplyArrival')
      .where.filter((item) => item.phase === w.phase)
      .map((item) => item.segment)
    const index = w.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
    expect(index).toBeGreaterThanOrEqual(0)
    expect(w.setSegmentStepIndex(index)).toBe(true)
  }

  it('B 到货 SP：候选是当前落账计划（提交入口不接受格参数）', () => {
    const w = newConsole()
    armSupplyArrival(w)
    w.supplyArrivalSp = 7
    w.toggleFreeRailPick({ col: 2, row: 2 })
    w.pickFreeRailEdgeHex({ col: 1, row: 3 })

    const legal = useLegalActionsStore()
    const entry = entryOf(legal.view, 'rein.supplyArrival')
    expect(entry.status).toBe('available')
    expect(entry.submit).toBe('applySupplyArrivalsNow')
    // 提交的是**整张计划**；候选不得再冒充「点某一格即可提交」的城市清单
    expect(entry.candidates).toHaveLength(1)
    expect(entry.candidates[0]!.ref).toBe('plan')
    expect(entry.candidates[0]!.disabledReason).toBeUndefined()
    expect(w.applySupplyArrivalsNow()).toBe(true)
  })

  it('B 到货 SP：计划被 13.3c 拒绝时，候选带同一拒绝原因且不可点', () => {
    const w = newConsole()
    armSupplyArrival(w)
    w.supplyArrivalSp = 3
    // 60.34（Rzhev）是静态城市格，但此刻不受控 ⇒ 计划不可用
    w.toggleFreeRailPick({ col: 60, row: 34 })

    const legal = useLegalActionsStore()
    const entry = entryOf(legal.view, 'rein.supplyArrival')
    expect(entry.status).toBe('blocked')
    expect(entry.candidates).toHaveLength(1)
    expect(entry.candidates[0]!.disabledReason).toBe(w.freeRailError?.reason)
    expect(w.applySupplyArrivalsNow()).toBe(false)
  })
})
