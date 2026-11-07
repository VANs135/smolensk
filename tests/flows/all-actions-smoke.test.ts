import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import type { Side } from '@/data'
import {
  ACTION_GATES,
  actionGateOf,
  actionKeysOfSegment,
  allowedActionsOf,
  isActionAllowed,
  phaseOfSegment,
  toConsoleUnit,
  unitChoices,
  useContainersStore,
  type ActionGateQuery,
  type ActionKey,
} from '@/stores'
import { useLegalActionsStore } from '@/stores/legal-actions-store'

import { fillSetup, fresh } from './flow-harness'

/**
 * 「全操作体检」：用 store 直调把玩家可发起的操作各跑一次
 *
 * 本文件只做**观察**：不修 src、不修既有测试。三类口径：
 *   ① 闸门矩阵 —— 每个 ActionKey 在它自己声明的 (phase, segment, side, role) 放行；
 *   ② 提交入口 —— 闸门关闭时必须拒绝，并给条款号（表驱动，逐入口报数）；
 *   ③ 正常路径 —— 真实场景下入口能跑通，并覆盖跨阶段 / 跨方 / 交接 / 补给站。
 *
 * 纪律：每个断言都带 `store.log` 原文，失败时能直接定位是哪一条被拒的理由没落地。
 */

type Ctx = ReturnType<typeof fresh>
type Containers = ReturnType<typeof useContainersStore>

/** 失败信息统一带操作台日志（最新的在最上面） */
function logText(ctx: Ctx): string {
  return ctx.w.log
    .map((line) => `${line.text}${line.rule === undefined ? '' : `（${line.rule}）`}`)
    .join(' | ')
}

function describeQuery(query: ActionGateQuery): string {
  return `${query.phase}/${query.segment} role=${query.role} side=${query.side ?? '-'} end=${String(
    query.atSegmentEnd === true,
  )}`
}

describe('全操作体检：store 直调', () => {
  /* ══════════════════════════════════════════════════════════════════════
   * 1. 闸门矩阵：每个 ActionKey 的可用性
   * ══════════════════════════════════════════════════════════════════════ */
  describe('闸门矩阵：每个 ActionKey 的可用性', () => {
    const gateKeys = [...new Set(ACTION_GATES.map((gate) => gate.key))]

    for (const key of gateKeys) {
      it(`${key}：闸门声明的每个去处都放行，且段 id 与阶段一致`, () => {
        const gate = actionGateOf(key)
        expect(gate.where.length, `${key} 在闸门表里没有任何去处`).toBeGreaterThan(0)
        for (const where of gate.where) {
          const side: Side = where.sides?.[0] ?? 'axis'
          const role = where.role ?? 'active'
          const atSegmentEnd = where.at === 'end'
          const query: ActionGateQuery = {
            phase: where.phase,
            segment: where.segment,
            role,
            side,
            atSegmentEnd,
          }
          expect(
            phaseOfSegment(where.segment),
            `闸门 ${key} 的段 ${where.segment} 与声明阶段 ${where.phase} 不一致`,
          ).toBe(where.phase)
          expect(allowedActionsOf(query).has(key), `${key} 未在 ${describeQuery(query)} 放行`).toBe(
            true,
          )
          expect(
            isActionAllowed(query, key),
            `${key} isActionAllowed 与 allowedActionsOf 不一致`,
          ).toBe(true)
          expect(
            actionKeysOfSegment(where.segment, side, role, atSegmentEnd).has(key),
            `${key} 在 actionKeysOfSegment(${where.segment}) 缺席`,
          ).toBe(true)
        }
      })
    }

    it('combat.declare 在 A 整备段被拒，且闸门给出条款 9.2', () => {
      const query: ActionGateQuery = {
        phase: 'aircraftRefit',
        segment: 'aircraftRefit.refit',
        role: 'active',
        side: 'axis',
      }
      expect(
        isActionAllowed(query, 'combat.declare'),
        `combat.declare 不该在 ${describeQuery(query)} 可用`,
      ).toBe(false)
      expect(actionGateOf('combat.declare').rule.length, '闸门 rule 不该为空').toBeGreaterThan(0)
      expect(actionGateOf('combat.declare').rule).toBe('9.2')
    })

    const sideLimited: readonly { key: ActionKey; allowed: Side; denied: Side }[] = [
      { key: 'rein.formationDraw', allowed: 'axis', denied: 'soviet' },
      { key: 'rein.frontalReserves', allowed: 'soviet', denied: 'axis' },
      { key: 'exclusive.panzerObligation', allowed: 'axis', denied: 'soviet' },
    ]

    for (const row of sideLimited) {
      it(`${row.key}：只对 ${row.allowed} 放行，错侧被拒`, () => {
        const where = actionGateOf(row.key).where.find((item) => item.sides !== undefined)
        expect(where, `${row.key} 的闸门里没有按方限定的去处`).toBeDefined()
        const base = {
          phase: where!.phase,
          segment: where!.segment,
          role: where!.role ?? 'active',
          atSegmentEnd: where!.at === 'end',
        }
        expect(
          isActionAllowed({ ...base, side: row.allowed }, row.key),
          `${row.key} 在 ${row.allowed} 侧应放行`,
        ).toBe(true)
        expect(
          isActionAllowed({ ...base, side: row.denied }, row.key),
          `${row.key} 不该在 ${row.denied} 侧放行（${base.phase}/${base.segment}）`,
        ).toBe(false)
      })
    }

    it('exclusive.panzerObligation：段中（未到段末）被拒', () => {
      const where = actionGateOf('exclusive.panzerObligation').where[0]!
      const query: ActionGateQuery = {
        phase: where.phase,
        segment: where.segment,
        role: where.role ?? 'active',
        side: 'axis',
        atSegmentEnd: false,
      }
      expect(
        isActionAllowed(query, 'exclusive.panzerObligation'),
        `段末义务不该在段中放行（${describeQuery(query)}）`,
      ).toBe(false)
    })
  })

  /* ══════════════════════════════════════════════════════════════════════
   * 2. 提交入口：关闭闸门时必须拒绝并给条款
   * ══════════════════════════════════════════════════════════════════════ */
  describe('提交入口：关闭闸门时必须拒绝并给条款', () => {
    interface RefusalRow {
      /** 用例名 */
      name: string
      /** 可接受的条款号（取「最新一条日志」的 rule 子串） */
      rules: readonly string[]
      /** 调用前的盘面准备 */
      setup?: (ctx: Ctx) => void
      /** 触发入口；只关心 false / undefined / null */
      run: (ctx: Ctx, containers: Containers) => unknown
    }

    /**
     * 表驱动：入口名 → 期望条款号
     *
     * 全部在 `fresh()`（未开局、空盘）下调用；`payFuel` 等返回 void 的入口按 undefined 记。
     */
    const rows: readonly RefusalRow[] = [
      {
        name: 'beginMoveFor（空选）',
        rules: ['6.1'],
        run: (ctx) => ctx.w.beginMoveFor([]),
      },
      {
        name: 'overrunNow（无移动交互）',
        rules: ['8.0'],
        run: (ctx) => ctx.w.overrunNow({ col: 99, row: 99 }),
      },
      {
        name: 'payFuel（无选中目标）',
        rules: ['12.5'],
        run: (ctx) => ctx.w.payFuel(),
      },
      {
        name: 'beginSupplyCheckNow（非补给段 / 未知单位）',
        rules: ['12.3a·b'],
        run: (ctx) => ctx.w.beginSupplyCheckNow('nope'),
      },
      {
        name: 'applyAttritionNow（非补给段）',
        rules: ['12.8b'],
        run: (ctx) => ctx.w.applyAttritionNow('1.1'),
      },
      {
        name: 'railMoveNow（无卸货格）',
        rules: ['13.3e'],
        run: (ctx) => ctx.w.railMoveNow('unit'),
      },
      {
        name: 'addSpDump（非法格号）',
        rules: ['12.1b'],
        setup: (ctx) => {
          ctx.w.spDumpDraft = { hexText: 'bad', sp: 1, t: 0 }
        },
        run: (ctx) => ctx.w.addSpDump(),
      },
      {
        name: 'drawAndApplyStepNow（非增援段）',
        rules: ['专规 13.7'],
        run: (_ctx, containers) => containers.drawAndApplyStepNow(containers.setupDrawGroups[0]!),
      },
    ]

    for (const row of rows) {
      it(`${row.name}（仅拒绝口径）`, () => {
        const ctx = fresh()
        row.setup?.(ctx)
        const containers = useContainersStore()
        const before = ctx.w.log.length
        const result = row.run(ctx, containers)
        const rejected = result === false || result === undefined || result === null
        expect(
          rejected,
          `应被拒（false/undefined/null），实际 ${String(result)}；日志：${logText(ctx)}`,
        ).toBe(true)
        expect(
          ctx.w.log.length,
          `入口被拒但**未追写操作台日志**（期望条款 ${row.rules.join(' 或 ')}）；日志：${logText(ctx)}`,
        ).toBeGreaterThan(before)
        const appended = ctx.w.log.slice(0, ctx.w.log.length - before)
        const rule = appended[0]?.rule ?? ''
        expect(
          row.rules.some((expected) => rule.includes(expected)),
          `期望条款 ${row.rules.join(' 或 ')}，实际「${rule}」；追加日志：${appended
            .map((line) => line.text)
            .join(' | ')}`,
        ).toBe(true)
      })
    }

    /*
     * 守护分支：这些拒绝只发生在「UI 根本构造不出」的入参上（未知 id、无会话、无待答问题），
     * 因此**不要求**追加操作台日志；玩家可达的拒绝路径在上表。
     */
    it('守护分支：未知 id / 无会话 / 无待答一律拒绝（不要求操作台日志）', () => {
      const ctx = fresh()
      const containers = useContainersStore()
      expect(ctx.g.answerNow(), '无待答问题时 answerNow 应拒绝').toBe(false)
      expect(ctx.g.error?.rule, 'answerNow 的拒绝原因应由会话错误面承载（2.2）').toBe('2.2')
      expect(ctx.w.confirmSupplyPickupNow(), '无补给会话时 confirm 应拒绝').toBe(false)
      expect(ctx.w.unlockSlowMobilizationBatch(['nope']), '未知 id 时应拒绝').toBe(false)
      expect(ctx.w.mergeSpDumpHoldings('nope'), '未知账本时应拒绝').toBe(false)
      expect(ctx.w.splitSpDumpHoldings('nope', 1), '未知账本时应拒绝').toBe(false)
      expect(
        containers.takeBreakdown({ parentInstanceId: 'nope', breakdownAr: 1 }),
        '未知母单位时应拒绝',
      ).toBe(false)
    })

    it('advanceSegmentNow（战斗结算中）被拒且给 9.2', () => {
      const ctx = fresh()
      const { w } = ctx
      w.setPhase('combat')
      // 走到本段允许 combat.declare 的环节（战斗环节）
      const allowed = actionGateOf('combat.declare')
        .where.filter((item) => item.phase === w.phase)
        .map((item) => item.segment)
      const index = w.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
      expect(index, `战斗段没有允许 combat.declare 的环节：${logText(ctx)}`).toBeGreaterThanOrEqual(
        0,
      )
      expect(w.setSegmentStepIndex(index), `进入战斗环节失败：${logText(ctx)}`).toBe(true)
      w.setTool('battle')
      w.setFuelPool(0, 20)
      const attacker = unitChoices('axis').find(
        (item) =>
          item.isCombat === true &&
          item.attackCapable === true &&
          item.classes?.movementClass === 'leg',
      )!
      const defender = unitChoices('soviet').find((item) => item.isCombat === true)!
      w.units.push(
        toConsoleUnit({
          record: attacker,
          instanceId: 'a1',
          hex: { col: 1, row: 2 },
          side: 'axis',
        }),
        toConsoleUnit({
          record: defender,
          instanceId: 'd1',
          hex: { col: 1, row: 1 },
          side: 'soviet',
        }),
      )
      w.clickHex({ col: 1, row: 2 })
      w.clickHex({ col: 1, row: 1 })
      expect(w.beginCombatNow(), `开战失败：${logText(ctx)}`).toBe(true)
      ctx.g.startGame()

      expect(w.advanceSegmentNow(), `战斗未收束时推进应被拒：${logText(ctx)}`).toBeNull()
      expect(ctx.w.log[0]?.rule, `期望 9.2；日志：${logText(ctx)}`).toBe('9.2')
    })
  })

  /* ══════════════════════════════════════════════════════════════════════
   * 3. 正常路径与跨阶段跨方
   * ══════════════════════════════════════════════════════════════════════ */
  describe('正常路径与跨阶段跨方', () => {
    it('剧本 1：从 A 整备段连续推进到 C 移动段，环节前进且合法动作视图有可用项', async () => {
      const ctx = fresh()
      expect(ctx.setup.enterSetup('1')).toBe(true)
      fillSetup(ctx)
      expect(ctx.setup.startGameNow(), `开局失败：${logText(ctx)}`).toBe(true)

      expect(ctx.w.phase, `开局后应停在 A 整备段；日志：${logText(ctx)}`).toBe('aircraftRefit')
      const firstStep = ctx.w.segmentStep?.id ?? ''
      const phasesSeen = new Set<string>([ctx.w.phase])
      const stepsSeen: string[] = [firstStep]

      for (let guard = 0; guard < 200 && ctx.w.phase !== 'movement'; guard += 1) {
        if (ctx.g.awaiting) {
          expect(ctx.g.answerNow('first'), `作答失败：${logText(ctx)}`).toBe(true)
        } else {
          const outcome = ctx.w.advanceSegmentNow()
          expect(
            outcome,
            `推进被拒（phase=${ctx.w.phase} step=${ctx.w.segmentStep?.id}）：${logText(ctx)}`,
          ).not.toBeNull()
        }
        await nextTick()
        phasesSeen.add(ctx.w.phase)
        const id = ctx.w.segmentStep?.id ?? ''
        if (stepsSeen.at(-1) !== id) stepsSeen.push(id)
      }

      expect(
        ctx.w.phase,
        `应推进到 C 移动段，实际 ${ctx.w.phase}；经过：${[...phasesSeen].join(' → ')}；日志：${logText(ctx)}`,
      ).toBe('movement')
      expect(
        phasesSeen.has('reinforcement'),
        `应经过 B 增援段；经过：${[...phasesSeen].join(' → ')}`,
      ).toBe(true)
      expect(firstStep, `A 段起始环节应在整备：${logText(ctx)}`).toMatch(/^aircraftRefit\./)
      // 环节 id 确实前进（至少经过两个不同环节）
      expect(
        stepsSeen.length,
        `环节 id 未前进：${stepsSeen.join(' → ')}；日志：${logText(ctx)}`,
      ).toBeGreaterThan(1)
      expect(
        ctx.w.segmentStep?.id,
        `移动段应停在某个 movement.* 环节（真实盘面有断补单位时首环可能是突围）：${logText(ctx)}`,
      ).toMatch(/^movement\./)

      const view = useLegalActionsStore().view
      const available = view.entries.filter((entry) => entry.status === 'available')
      expect(
        available.length,
        `合法动作视图应至少有一条可用项；实际 ${String(available.length)}；entries=${JSON.stringify(
          view.entries.map((entry) => `${entry.key}:${entry.status}`),
        )}`,
      ).toBeGreaterThan(0)
    }, 60000)

    it('beginMovePick：真实轴方算子注入后可建档', () => {
      const ctx = fresh()
      const record = unitChoices('axis')[0]!
      const hex = { col: 36, row: 13 }
      const unit = toConsoleUnit({ record, instanceId: 'smoke-a1', hex, side: 'axis' })
      ctx.w.units.push(unit)

      ctx.w.beginMovePick(hex, [unit.instanceId])

      expect(
        ctx.w.movePick?.ids,
        `beginMovePick 应建档；phase=${ctx.w.phase} segment=${ctx.w.segmentStep?.id}；日志：${logText(ctx)}`,
      ).toEqual([unit.instanceId])
    })

    it('payFuel：无可付款补给站时被拒并给条款', () => {
      const ctx = fresh()
      const record = unitChoices('axis')[0]!
      const unit = toConsoleUnit({
        record,
        instanceId: 'smoke-a1',
        hex: { col: 36, row: 13 },
        side: 'axis',
      })
      ctx.w.units.push(unit)
      ctx.w.beginMovePick(unit.hex, [unit.instanceId])

      ctx.w.payFuel()

      const rule = ctx.w.log[0]?.rule ?? ''
      expect(
        ['12.3a', '12.5a'].some((expected) => rule.includes(expected)),
        `期望 12.3a（无付款站）或 12.5a（无需燃料），实际「${rule}」；日志：${logText(ctx)}`,
      ).toBe(true)
    })

    it('跨方：切到苏方后，同一入口对轴方算子被拒（6.0）', () => {
      const ctx = fresh()
      const record = unitChoices('axis')[0]!
      const unit = toConsoleUnit({
        record,
        instanceId: 'smoke-a1',
        hex: { col: 36, row: 13 },
        side: 'axis',
      })
      ctx.w.units.push(unit)

      ctx.w.setActiveSide('soviet')
      expect(ctx.w.activeSide).toBe('soviet')

      expect(
        ctx.w.beginMoveFor([unit.instanceId]),
        `苏方行动时不该能移动轴方算子；日志：${logText(ctx)}`,
      ).toBe(false)
      expect(ctx.w.log[0]?.rule, `期望 6.0（阶段/方不符）；日志：${logText(ctx)}`).toBe('6.0')
    })

    it('hotseat：beginHandoff 翻观察方、confirmHandoff 收屏（体检记录：不翻行动方）', () => {
      const ctx = fresh()
      ctx.hot.setMode('pvp')
      const sideBefore = ctx.w.activeSide
      const viewerBefore = ctx.hot.viewerSide

      ctx.hot.beginHandoff()
      expect(ctx.hot.handoffPending, '交接屏应亮起').toBe(true)
      expect(
        ctx.hot.viewerSide,
        `交接屏期间观察方应翻到对手：before=${viewerBefore} actual=${ctx.hot.viewerSide}`,
      ).not.toBe(viewerBefore)
      const opponent = ctx.hot.viewerSide

      ctx.hot.confirmHandoff()
      expect(ctx.hot.handoffPending, '确认后交接屏应收起').toBe(false)
      // 体检记录：confirmHandoff 只收屏，viewerOverride 仍指向对手；行动方并不在本入口翻转
      expect(ctx.hot.viewerSide, `确认后观察方应保持为对手 ${opponent}`).toBe(opponent)
      expect(ctx.w.activeSide, `confirmHandoff 未翻行动方（${sideBefore}）`).toBe(sideBefore)
    })

    it('hotseat：beginHandoff 后 cancelHandoff 不翻转', () => {
      const ctx = fresh()
      ctx.hot.setMode('pvp')
      const sideBefore = ctx.w.activeSide
      const viewerBefore = ctx.hot.viewerSide

      ctx.hot.beginHandoff()
      ctx.hot.cancelHandoff()

      expect(ctx.hot.handoffPending, '取消后交接屏应收起').toBe(false)
      expect(ctx.hot.viewerSide, `取消后观察方应回到原方 ${viewerBefore}`).toBe(viewerBefore)
      expect(ctx.w.activeSide, `取消后行动方不应翻转`).toBe(sideBefore)
    })

    it('补给站：addSpDump 合法 + 同格并入 + mergeSpDumpHoldings 成功', () => {
      const ctx = fresh()

      ctx.w.spDumpDraft = { hexText: '36.13', sp: 1, t: 2 }
      expect(ctx.w.addSpDump(), `合法补给站被拒：${logText(ctx)}`).toBe(true)
      const dump = ctx.w.spDumps.at(-1)!
      expect(dump.sp, `1 SP + 2 T 应按 12.1a 规范为 1 SP + 2 T；日志：${logText(ctx)}`).toBe(1)

      // 同格再落 2 T ⇒ 并入既有账本：1 SP + 4 T 规范为 2 SP + 0 T
      ctx.w.spDumpDraft = { hexText: '36.13', sp: 0, t: 2 }
      expect(ctx.w.addSpDump(), `同格并入被拒：${logText(ctx)}`).toBe(true)
      const merged = ctx.w.spDumps.find((item) => item.id === dump.id)!
      expect(merged.sp, `并入后应规范为整 SP（1SP+4T → 2SP）；日志：${logText(ctx)}`).toBe(2)
      expect(merged.t, `并入后应无零钱；日志：${logText(ctx)}`).toBe(0)

      expect(ctx.w.mergeSpDumpHoldings(dump.id), `加总被拒：${logText(ctx)}`).toBe(true)
      expect(ctx.w.log[0]?.rule, `加总应给 12.1a；日志：${logText(ctx)}`).toBe('12.1a')
    })

    it('补给站：addSpDump 非法格号被拒并给 12.1b', () => {
      const ctx = fresh()
      ctx.w.spDumpDraft = { hexText: 'abc', sp: 1, t: 0 }

      expect(ctx.w.addSpDump(), `非法格号应被拒：${logText(ctx)}`).toBe(false)
      expect(ctx.w.log[0]?.rule, `期望 12.1b；日志：${logText(ctx)}`).toBe('12.1b')
    })

    it('补给站：splitSpDumpHoldings 超量被拒并给 12.1a', () => {
      const ctx = fresh()
      ctx.w.spDumpDraft = { hexText: '36.13', sp: 1, t: 0 }
      expect(ctx.w.addSpDump(), `合法补给站被拒：${logText(ctx)}`).toBe(true)
      const dump = ctx.w.spDumps.at(-1)!

      expect(
        ctx.w.splitSpDumpHoldings(dump.id, 5),
        `拆 5 SP 超过持有的 1 SP，应被拒；日志：${logText(ctx)}`,
      ).toBe(false)
      expect(ctx.w.log[0]?.rule, `期望 12.1a；日志：${logText(ctx)}`).toBe('12.1a')
    })
  })
})
