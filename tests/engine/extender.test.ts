import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  EXTENDER_FLIP_MA_FRACTION,
  EXTENDER_REQUIRED_POINTS,
  aggregateTransportPoints,
  canConvertTransportToExtender,
  isConvertibleTransportPoint,
  pickExtenderRecordId,
  planConvertTransportToExtender,
  planFlipExtenderToTransport,
  type TransportPointEntry,
} from '../../src/engine/rules/extender'
import type { MovementSegmentPhase } from '../../src/engine/rules/modes'

describe('extender 12.7 / 9.14d', () => {
  it('常量：每 5 点运点转 1 延补队、翻半 MA', () => {
    expect(EXTENDER_REQUIRED_POINTS).toBe(5)
    expect(EXTENDER_FLIP_MA_FRACTION).toBe(0.5)
  })

  describe('12.7a / 5.7f：只有通用运输点数参与凑数（编内卡车不算）', () => {
    it('通用运输点数（transport_point + truck/wagon）可参与', () => {
      expect(
        isConvertibleTransportPoint({ noncombatKind: 'transport_point', transportKind: 'truck' }),
      ).toBe(true)
      expect(
        isConvertibleTransportPoint({ noncombatKind: 'transport_point', transportKind: 'wagon' }),
      ).toBe(true)
    })

    it('编内卡车 / 运输点数缺类型 / 其它非战斗单位一律不算', () => {
      // 5.7f 的例外只给「可进入预备模式」，不代表它能与延补队互转
      expect(
        isConvertibleTransportPoint({ noncombatKind: 'organic_truck', transportKind: null }),
      ).toBe(false)
      expect(
        isConvertibleTransportPoint({ noncombatKind: 'transport_point', transportKind: null }),
      ).toBe(false)
      expect(
        isConvertibleTransportPoint({ noncombatKind: 'supply_extender', transportKind: 'truck' }),
      ).toBe(false)
      expect(isConvertibleTransportPoint({})).toBe(false)
    })
  })

  describe('aggregateTransportPoints', () => {
    it('按类型分组聚合点数', () => {
      const entries: TransportPointEntry[] = [
        { id: 'a', kind: 'truck', points: 3 },
        { id: 'b', kind: 'truck', points: 2 },
        { id: 'c', kind: 'wagon', points: 4 },
        { id: 'd', kind: 'wagon', points: 1 },
      ]
      expect(aggregateTransportPoints(entries)).toEqual({ truck: 5, wagon: 5 })
    })
    it('空输入返回双零', () => {
      expect(aggregateTransportPoints([])).toEqual({ truck: 0, wagon: 0 })
    })
  })

  describe('canConvertTransportToExtender（12.7a 判定）', () => {
    const mk = (phase: MovementSegmentPhase, entries: TransportPointEntry[]) =>
      canConvertTransportToExtender({ phase, entries })

    it('三个移动环节内、合计≥5 点同类型 → 可转', () => {
      for (const phase of ['movement', 'reaction', 'exploitation'] as const) {
        const result = mk(phase, [
          { id: 't1', kind: 'truck', points: 3 },
          { id: 't2', kind: 'truck', points: 2 },
        ])
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.data.options).toHaveLength(1)
          expect(result.data.options[0]!.kind).toBe('truck')
          expect(result.data.options[0]!.count).toBe(1)
          expect(result.data.options[0]!.costMaPerTeam).toBe(10) // MA 20 × 0.5
        }
      }
    })
    it('同时有卡车≥5、马车≥5 → 两种类型都可转', () => {
      const result = mk('movement', [
        { id: 't1', kind: 'truck', points: 5 },
        { id: 'w1', kind: 'wagon', points: 5 },
      ])
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data.options).toHaveLength(2)
    })
    it('卡车 12 点 → 可转 2 队（10 点），余 2 点', () => {
      const result = mk('movement', [{ id: 't1', kind: 'truck', points: 12 }])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.options[0]!.count).toBe(2)
        expect(result.data.options[0]!.remainder).toBe(2)
      }
    })
    it('战斗阶段 → wrongSegment', () => {
      // 战斗阶段不是移动环节：显式越界传入，验证引擎拒绝
      const result = canConvertTransportToExtender({
        phase: 'combat' as unknown as MovementSegmentPhase,
        entries: [{ id: 't1', kind: 'truck', points: 10 }],
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('wrongSegment')
    })
    it('合计不足 5 点 → insufficientPoints', () => {
      const result = mk('movement', [
        { id: 't1', kind: 'truck', points: 4 },
        { id: 'w1', kind: 'wagon', points: 4 },
      ])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('insufficientPoints')
    })
    it('混合类型不会互相凑数（truck 3 + wagon 3 = 各自 3 < 5）', () => {
      const result = mk('movement', [
        { id: 't1', kind: 'truck', points: 3 },
        { id: 'w1', kind: 'wagon', points: 3 },
      ])
      expect(result.ok).toBe(false)
    })
  })

  describe('planConvertTransportToExtender（12.7a 替换计划）', () => {
    it('精确 5 点 → 消耗 5 点、无余量', () => {
      const entries: TransportPointEntry[] = [{ id: 'tp-5', kind: 'truck', points: 5 }]
      const result = planConvertTransportToExtender({
        kind: 'truck',
        count: 1,
        entries,
        newRecordId: 'ax-extender-truck',
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.consumedPoints).toBe(5)
        expect(result.data.swaps).toHaveLength(1)
        expect(result.data.swaps[0]!.transportUnitId).toBe('tp-5')
        expect(result.data.removedPoints).toBe(5)
        expect(result.data.leftoverPoints).toBe(0)
        expect(result.data.leftoverPlacement).toEqual([])
        expect(result.data.totalCostMa).toBe(10) // MA 20 × 0.5
      }
    })

    it('12.7a：运输点数可任意拆分 —— 3+3 点建 1 队只消耗 5 点、余 1 点留格', () => {
      const entries: TransportPointEntry[] = [
        { id: 'a', kind: 'truck', points: 3 },
        { id: 'b', kind: 'truck', points: 3 },
      ]
      const result = planConvertTransportToExtender({
        kind: 'truck',
        count: 1,
        entries,
        newRecordId: 'ax-extender-truck',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // 移走两枚（6 点）凑够阈值，但**真正消耗只有 5 点**，余 1 点仍留在该格
      expect(result.data.swaps).toHaveLength(2)
      expect(result.data.removedPoints).toBe(6)
      expect(result.data.consumedPoints).toBe(5)
      expect(result.data.leftoverPoints).toBe(1)
      expect(result.data.leftoverPlacement).toEqual([1])
      expect(result.data.detail).toContain('余 1 点留格')
    })

    it('12.7a：余量取最小 —— 5+3 点建 1 队 ⇒ 只移走那枚 5 点、留 3 点', () => {
      const entries: TransportPointEntry[] = [
        { id: 'a', kind: 'truck', points: 5 },
        { id: 'b', kind: 'truck', points: 3 },
      ]
      const result = planConvertTransportToExtender({
        kind: 'truck',
        count: 1,
        entries,
        newRecordId: 'ax-extender-truck',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.swaps.map((swap) => swap.transportUnitId)).toEqual(['a'])
      expect(result.data.leftoverPoints).toBe(0)
      expect(result.data.leftoverPlacement).toEqual([])
      // 另一枚 3 点原样留在格内（不参与本次转换）
      expect(result.data.swaps).toHaveLength(1)
    })

    it('12.7a：多队同换 —— 3+3+3 建 2 队 ⇒ 消耗 10 点、余点按面额拆回', () => {
      const entries: TransportPointEntry[] = [
        { id: 'a', kind: 'truck', points: 3 },
        { id: 'b', kind: 'truck', points: 3 },
        { id: 'c', kind: 'truck', points: 3 },
      ]
      const result = planConvertTransportToExtender({
        kind: 'truck',
        count: 2,
        entries,
        newRecordId: 'ax-extender-truck',
      })
      expect(result.ok).toBe(false) // 9 点 < 10 点
      if (!result.ok) expect(result.reason).toBe('notEnoughPoints')

      const enough: TransportPointEntry[] = [
        { id: 'a', kind: 'truck', points: 3 },
        { id: 'b', kind: 'truck', points: 3 },
        { id: 'c', kind: 'truck', points: 3 },
        { id: 'd', kind: 'truck', points: 3 },
      ]
      const two = planConvertTransportToExtender({
        kind: 'truck',
        count: 2,
        entries: enough,
        newRecordId: 'ax-extender-truck',
      })
      expect(two.ok).toBe(true)
      if (!two.ok) return
      expect(two.data.consumedPoints).toBe(10)
      // 四枚 3 点 = 12 点（唯一能凑够 10 的组合）⇒ 消耗 10 点、余 2 点按面额拆回
      expect(two.data.removedPoints).toBe(12)
      expect(two.data.leftoverPoints).toBe(2)
      expect(two.data.leftoverPlacement).toEqual([2])
      expect(two.data.totalCostMa).toBe(20) // 2 队 × MA 20 × 0.5
    })

    it('数量不够 → notEnoughPoints', () => {
      const result = planConvertTransportToExtender({
        kind: 'truck',
        count: 1,
        entries: [{ id: 'a', kind: 'truck', points: 4 }],
        newRecordId: 'ax-extender-truck',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('notEnoughPoints')
    })
  })

  describe('planFlipExtenderToTransport（12.7d / 9.14d 翻面计划）', () => {
    it('玩家主动翻面（12.7d，移动阶段）→ 消耗半 MA', () => {
      const result = planFlipExtenderToTransport({
        phase: 'movement',
        kind: 'truck',
        extenderMa: 20,
        transportRecordId: 'ax-transport-truck-5',
        playerInitiated: true,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.rule).toBe('12.7d')
        expect(result.data.costMa).toBe(10)
        expect(result.data.playerInitiated).toBe(true)
        expect(result.data.newRecordId).toBe('ax-transport-truck-5')
      }
    })
    it('玩家主动翻面但在战斗阶段 → wrongSegment', () => {
      const result = planFlipExtenderToTransport({
        phase: 'combat' as unknown as 'movement',
        kind: 'wagon',
        extenderMa: 10,
        transportRecordId: 'ax-transport-wagon-5',
        playerInitiated: true,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('wrongSegment')
    })
    it('被动崩溃（9.14d）→ 无 MA 代价、任意环节允许', () => {
      const result = planFlipExtenderToTransport({
        phase: 'combat' as unknown as 'movement',
        kind: 'truck',
        extenderMa: 20,
        transportRecordId: 'su-transport-truck-5',
        playerInitiated: false,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.rule).toBe('9.14d')
        expect(result.data.costMa).toBe(0)
        expect(result.data.playerInitiated).toBe(false)
      }
    })
    it('wagon 延补队主动翻面 → MA 10 × 0.5 = 5', () => {
      const result = planFlipExtenderToTransport({
        phase: 'reaction',
        kind: 'wagon',
        extenderMa: 10,
        transportRecordId: 'ax-transport-wagon-5',
        playerInitiated: true,
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data.costMa).toBe(5)
    })
  })

  describe('pickExtenderRecordId（按 side + kind 查 record）', () => {
    const ref = {
      axisTruckExtenderId: 'ax-extender-truck',
      axisWagonExtenderId: 'ax-extender-wagon',
      sovietTruckExtenderId: 'su-extender-truck',
      sovietWagonExtenderId: 'su-extender-wagon',
      truckTransportRecordId: 't-5',
      wagonTransportRecordId: 'w-5',
    }
    it('四种组合都能正确命中', () => {
      expect(pickExtenderRecordId('axis', 'truck', ref)).toBe('ax-extender-truck')
      expect(pickExtenderRecordId('axis', 'wagon', ref)).toBe('ax-extender-wagon')
      expect(pickExtenderRecordId('soviet', 'truck', ref)).toBe('su-extender-truck')
      expect(pickExtenderRecordId('soviet', 'wagon', ref)).toBe('su-extender-wagon')
    })
  })
})

/* ─── B48（12.7d）：**装载的运输点数不能转延补队**（必须先卸载） ─── */

/**
 * 原文 **12.7d**：「……装载的运输点数**不能**切换为延补队（它**必须先卸载**）。」
 *
 * 病灶：转换计划只判"同型点数够不够"，**不看装载** ⇒ 一辆装着 SP 的 5 点卡车能被直接转成延补队，
 *   而那枚算子会被移出地图 ⇒ **车上的 SP 凭空消失**（既违反 12.7d，又是数据丢失）。
 *
 * 测法边界：本组只钉"计划层的拒绝与滤除"；"车上 SP 去哪了"由 store 的端到端用例覆盖。
 */
describe('B48：12.7d 装载禁令', () => {
  it('★ 选中项里有装载者 ⇒ 直接拒（理由码 loadedMustUnloadFirst，规则号 12.7d）', () => {
    const outcome = planConvertTransportToExtender({
      kind: 'truck',
      count: 1,
      newRecordId: 'x',
      entries: [{ id: 'a', kind: 'truck', points: 5, loaded: true }],
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok)
      expect(outcome).toMatchObject({ rule: '12.7d', reason: 'loadedMustUnloadFirst' })
  })

  it('★ 装载者**不参与凑数**：5 点装油车 + 5 点空车 ⇒ **只用空车**（转换照旧合法）', () => {
    const outcome = planConvertTransportToExtender({
      kind: 'truck',
      count: 1,
      newRecordId: 'x',
      entries: [
        { id: 'loaded', kind: 'truck', points: 5, loaded: true },
        { id: 'empty', kind: 'truck', points: 5 },
      ],
    })
    /*
     * 12.7d 的禁令是**按算子**算的：装着 SP 的那辆不能转（它得先卸载），空车照用 ⇒ 本次转换合法。
     * （第一版实现把"格内有装油车"当成整笔拒绝，会把合法转换一起卡掉 —— 已修正，见回执 §17.83。）
     */
    expect(outcome.ok).toBe(true)
    if (outcome.ok)
      expect(outcome.data.swaps.map((swap) => swap.transportUnitId)).toEqual(['empty'])
  })

  it('★ 只有装载者够量 ⇒ 同样拒（不会拿它凑够 5 点）', () => {
    const outcome = planConvertTransportToExtender({
      kind: 'truck',
      count: 1,
      newRecordId: 'x',
      entries: [
        { id: 'a', kind: 'truck', points: 3, loaded: true },
        { id: 'b', kind: 'truck', points: 3, loaded: true },
      ],
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok)
      expect(outcome).toMatchObject({ rule: '12.7d', reason: 'loadedMustUnloadFirst' })
  })

  it('★ 全空车 ⇒ 照旧可转（现状不变）', () => {
    const outcome = planConvertTransportToExtender({
      kind: 'truck',
      count: 1,
      newRecordId: 'x',
      entries: [{ id: 'a', kind: 'truck', points: 5 }],
    })
    expect(outcome.ok).toBe(true)
  })
})

/* ─── 批 F 切片 4②：12.7 的**判据只有一处**（收敛两份实现） ─── */

/**
 * 收敛的背景（§17.83 的登记）：12.7 曾经有**两份实现** ——
 *   ① `trace-supply.ts` 的 `extenderCreationCost({transportPoints, ma, organicTruck, loaded})`：
 *      只看"一个聚合数"，**没有**算子级信息（不知道是哪几枚、谁是装载者）⇒ 只能在测试里用；
 *   ② `extender.ts` 的 `planConvertTransportToExtender`：store 实际走的那份（按算子滤装载者）。
 * 两份并存 ⇒ 同一件事两套口径，改一处必然漂移。本轮**只留 ②**，并让"能建几队"的判定
 * （`canConvertTransportToExtender`）与 ② **共用同一个装载者滤除口径**（此前它把装油车的点数也算进阈值）。
 *
 * 测法边界：本组钉"判据同口径 + 旧实现不得复活"；**不重复**已有用例覆盖的阈值/MA 数字
 * （那几条见上方 `canConvertTransportToExtender` 与 `planConvertTransportToExtender` 两组）。
 */
describe('批 F 切片 4②：12.7 收敛到一处实现', () => {
  /** 全树（src + tests + scripts）文本，供源码守卫扫描 */
  function allSources(): Map<string, string> {
    const map = new Map<string, string>()
    const roots = ['src', 'tests', 'scripts']
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'release', 'backup', '.git'].includes(entry.name)) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(path)
          continue
        }
        if (/\.(ts|vue|mjs|mts)$/.test(entry.name))
          map.set(path.replace(/\\/g, '/'), readFileSync(path, 'utf8'))
      }
    }
    for (const root of roots) walk(root)
    return map
  }

  it('★ 源码守卫：旧的 `extenderCreationCost` 一处都不剩（不许第二份 12.7 判据复活）', () => {
    /*
     * 钉**生产代码里的声明**（`src/` 下不得再有这份实现）——注释与回执里以文字提到
     * "它已被删除"不算复活（`trace-supply.ts` 的指针注释就是这种）；测试文件自身也不参与扫描。
     */
    const hits: string[] = []
    for (const [file, text] of allSources()) {
      if (!file.startsWith('src/')) continue
      if (/(export\s+)?function\s+extenderCreationCost/.test(text)) hits.push(file)
    }
    expect(hits).toEqual([])
  })

  it('★ judge 与 plan 同口径：装载者不参与凑数（3 空 + 3 装 ⇒ 12.7d，不是"可转 1 队"）', () => {
    const entries: TransportPointEntry[] = [
      { id: 'empty', kind: 'truck', points: 3 },
      { id: 'loaded', kind: 'truck', points: 3, loaded: true },
    ]
    const judge = canConvertTransportToExtender({ phase: 'movement', entries })
    expect(judge.ok).toBe(false)
    if (!judge.ok) expect(judge).toMatchObject({ rule: '12.7d', reason: 'loadedMustUnloadFirst' })

    const plan = planConvertTransportToExtender({
      kind: 'truck',
      count: 1,
      newRecordId: 'x',
      entries,
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan).toMatchObject({ rule: '12.7d', reason: 'loadedMustUnloadFirst' })
  })

  it('★ 一致性矩阵：judge 说"能建 N 队" ⇒ plan 建 N 队必成、建 N+1 队必拒', () => {
    const cases: readonly {
      name: string
      entries: readonly TransportPointEntry[]
      kind: 'truck' | 'wagon'
      expectOk: boolean
      expectRule?: string
    }[] = [
      {
        name: '空车 3+2 = 5 点',
        entries: [
          { id: 'a', kind: 'truck', points: 3 },
          { id: 'b', kind: 'truck', points: 2 },
        ],
        kind: 'truck',
        expectOk: true,
      },
      {
        name: '单车 12 点（可建 2 队）',
        entries: [{ id: 'a', kind: 'truck', points: 12 }],
        kind: 'truck',
        expectOk: true,
      },
      {
        name: '仅 2 点',
        entries: [{ id: 'a', kind: 'truck', points: 2 }],
        kind: 'truck',
        expectOk: false,
        expectRule: '12.7a',
      },
      {
        name: '3 空 + 3 装',
        entries: [
          { id: 'a', kind: 'truck', points: 3 },
          { id: 'b', kind: 'truck', points: 3, loaded: true },
        ],
        kind: 'truck',
        expectOk: false,
        expectRule: '12.7d',
      },
      {
        name: '4 空 + 4 装',
        entries: [
          { id: 'a', kind: 'truck', points: 4 },
          { id: 'b', kind: 'truck', points: 4, loaded: true },
        ],
        kind: 'truck',
        expectOk: false,
        expectRule: '12.7d',
      },
      {
        name: '只有 5 点装油车',
        entries: [{ id: 'a', kind: 'truck', points: 5, loaded: true }],
        kind: 'truck',
        expectOk: false,
        expectRule: '12.7d',
      },
      {
        name: '5 空 + 5 装',
        entries: [
          { id: 'a', kind: 'truck', points: 5 },
          { id: 'b', kind: 'truck', points: 5, loaded: true },
        ],
        kind: 'truck',
        expectOk: true,
      },
      {
        name: '卡车 5 + 马车 5（各 1 队）',
        entries: [
          { id: 'a', kind: 'truck', points: 5 },
          { id: 'b', kind: 'wagon', points: 5 },
        ],
        kind: 'wagon',
        expectOk: true,
      },
    ]
    for (const item of cases) {
      const judge = canConvertTransportToExtender({ phase: 'movement', entries: item.entries })
      expect(judge.ok, `${item.name}：judge 的结论`).toBe(item.expectOk)
      if (!judge.ok && item.expectRule !== undefined)
        expect(judge.rule, `${item.name}：judge 的规则号`).toBe(item.expectRule)

      const plan = planConvertTransportToExtender({
        kind: item.kind,
        count: 1,
        newRecordId: 'x',
        entries: item.entries,
      })
      // 两边必须同结论（这就是"判据只有一处"的可执行口径）
      expect(plan.ok, `${item.name}：plan 与 judge 同结论`).toBe(item.expectOk)
      if (!plan.ok && item.expectRule !== undefined)
        expect(plan.rule, `${item.name}：plan 的规则号`).toBe(item.expectRule)

      if (judge.ok) {
        const option = judge.data.options.find((entry) => entry.kind === item.kind)
        expect(option, `${item.name}：judge 给出该型的队数`).toBeDefined()
        const teams = option?.count ?? 0
        for (let count = 1; count <= teams; count += 1) {
          const ok = planConvertTransportToExtender({
            kind: item.kind,
            count,
            newRecordId: 'x',
            entries: item.entries,
          })
          expect(ok.ok, `${item.name}：建 ${String(count)} 队应可成`).toBe(true)
        }
        const over = planConvertTransportToExtender({
          kind: item.kind,
          count: teams + 1,
          newRecordId: 'x',
          entries: item.entries,
        })
        expect(over.ok, `${item.name}：建 ${String(teams + 1)} 队应拒`).toBe(false)
      }
    }
  })
})
