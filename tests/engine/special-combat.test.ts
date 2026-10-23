import { describe, expect, it } from 'vitest'

import { chartsCrt, mapLayers, rulesConstants } from '@/data'
import type { HexRef } from '@/data'
import { hexDistance } from '@/engine/hex-geometry'
import {
  AIR_BASE_CAPTURE_DRM,
  TRANSPORT_DISPLACE_MAX_HEXES,
  TRANSPORT_TRUCK_MIN_MA,
  applyTransportOwnerChoice,
  battleColumnIndex,
  planTransportSplit,
  resolveSpecialCombat,
  tokensText,
  transportDisplacementCandidates,
  transportGroupOf,
  type SpecialObjectView,
  type TransportGroupResult,
} from '@/engine/rules'

/**
 * 特殊战斗（B13，OCS 9.14）测试
 *
 * 断言到条文一级：9.14a 零战斗值列位（委托 B12 的 battleColumnIndex）/ 9.14b 补给站 /
 * 9.14c 运输点分组夺取与位移（含规则书完整算例）/ 9.14d 延补队崩溃（委托 B11）/
 * 9.14e 环形工事（通规 21.11c 夺取降 1 级；专规 1.3a 印刷永久工事不降）/ 9.14f 空军基地与飞机损失。
 * 另覆盖「初设归属 vs 战斗后归属」：友军进入自家设施无效果、无可攻击单位进入不触发；
 * 以及 9.14c/d 的**落点候选与玩家选定**（`transportDisplacementCandidates` / `planTransportSplit`
 * / `chosenHex`）。
 */

const HEX: HexRef = { col: 36, row: 13 }

function object(
  over: Partial<SpecialObjectView> & Pick<SpecialObjectView, 'id' | 'kind'>,
): SpecialObjectView {
  return { hex: HEX, owner: 'soviet', ...over }
}

/** 无 9.14d 上下文时的最小崩溃环境（本文件多数用例不含延补队） */
const collapseContext = {
  candidates: [{ col: 36, row: 12 }] as readonly HexRef[],
  hasTraceSupplyAt: () => true,
}

function run(over: Partial<Parameters<typeof resolveSpecialCombat>[0]>) {
  return resolveSpecialCombat({
    hex: HEX,
    enteringSide: 'axis',
    attackCapableUnitEnters: true,
    phase: 'movement',
    objects: [],
    extenderCollapse: collapseContext,
    ...over,
  })
}

/* ────────────────────────────── 9.14a 零战斗值 ────────────────────────────── */

describe('9.14a 战斗值为零的单位：列位口径（由 B12 的 battleColumnIndex 统一实现）', () => {
  const columns = chartsCrt.crt.terrainColumns.Open ?? []

  it('打零战斗值守方 ⇒ 从最右列开始；零战斗值方进攻 ⇒ 从最左列开始', () => {
    expect(battleColumnIndex(columns, 10, 0)).toMatchObject({
      index: columns.length - 1,
      rule: '9.14a',
    })
    expect(battleColumnIndex(columns, 0, 10)).toMatchObject({ index: 0, rule: '9.14a' })
  })

  it('双方皆零 ⇒ 用 1:1 列（9.14a 末句）', () => {
    const even = columns.indexOf('1:1')
    expect(even).toBeGreaterThanOrEqual(0)
    expect(battleColumnIndex(columns, 0, 0)).toMatchObject({ index: even, rule: '9.14a' })
  })
})

/* ────────────────────────────── 9.14b 补给站 ────────────────────────────── */

describe('9.14b 补给站：一部分 SP 被夺取（取整到最近 T），其余被摧毁', () => {
  it('规则书算例：地面 9 SP（36 T）掷 5（50%）⇒ 夺取 18 T = 4 SP + 2 T，其余 18 T 被摧毁', () => {
    const outcome = run({
      objects: [object({ id: 'dump1', kind: 'dump', spT: 36 })],
      dice: { dump: 5 },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const dump = outcome.data.objects[0]!
    expect(dump).toMatchObject({ kind: 'dump', result: 'captured', to: 'axis' })
    expect(dump.detail).toContain('夺取 18 T（4 SP + 2 T）')
    expect(dump.detail).toContain('其余 18 T 被摧毁')
  })

  it('骰 1（0%）⇒ 全部被摧毁；骰 6（75%）⇒ 3/4 被夺取', () => {
    const none = run({
      objects: [object({ id: 'dump1', kind: 'dump', spT: 40 })],
      dice: { dump: 1 },
    })
    expect(none.ok && none.data.objects[0]?.detail).toContain('夺取 0 T')
    const most = run({
      objects: [object({ id: 'dump2', kind: 'dump', spT: 40 })],
      dice: { dump: 6 },
    })
    expect(most.ok && most.data.objects[0]?.detail).toContain('夺取 30 T')
  })

  it('缺 dump 骰面即报错（不默默按 0 处理）', () => {
    expect(
      run({ objects: [object({ id: 'dump1', kind: 'dump', spT: 40 })], dice: {} }),
    ).toMatchObject({ ok: false, rule: '9.14b' })
  })
})

/* ────────────────────────────── 9.14c 运输点数 ────────────────────────────── */

describe('9.14c 运输点数：分组夺取与位移（含规则书完整算例）', () => {
  it('规则书算例：3 个 MA20 卡车 + 12 T 装载，掷 3（25%）⇒ 夺取 1 点与 3 T，位移 2 点与 9 T', () => {
    const outcome = run({
      objects: [
        object({ id: 'tk', kind: 'transport', transportMa: 20, transportPoints: 3, loadedSpT: 12 }),
      ],
      dice: { trucks: 3 },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.transportGroups).toEqual([
      expect.objectContaining({
        group: 'trucks',
        die: 3,
        percent: 25,
        totalPoints: 3,
        capturedPoints: 1,
        displacedPoints: 2,
        totalLoadedT: 12,
        capturedLoadedT: 3,
        displacedLoadedT: 9,
      }),
    ])
    // 3 个点里只有 1 个被夺取 ⇒ 由原主决定哪一个是它（9.14c 末段）
    expect(outcome.data.objects[0]).toMatchObject({ result: 'ownerChoice', group: 'trucks' })
    // 移动阶段被夺取 ⇒ 可立即移动
    expect(outcome.data.capturedTransportMayMoveNow).toBe(true)
  })

  it('9.14c：MA ≤ 10 走「马车」列；非移动阶段被夺取的不可立即移动', () => {
    const wagons = run({
      objects: [
        object({
          id: 'wagon',
          kind: 'transport',
          transportMa: 10,
          transportPoints: 4,
          loadedSpT: 8,
        }),
      ],
      dice: { wagons: 5 },
    })
    expect(wagons.ok && wagons.data.transportGroups[0]).toMatchObject({
      group: 'wagons',
      percent: 75,
      capturedPoints: 3,
      displacedPoints: 1,
    })
    const inCombatPhase = run({
      phase: 'combat',
      objects: [object({ id: 'wagon', kind: 'transport', transportMa: 10, transportPoints: 4 })],
      dice: { wagons: 5 },
    })
    expect(inCombatPhase.ok && inCombatPhase.data.capturedTransportMayMoveNow).toBe(false)
    expect(inCombatPhase.ok && inCombatPhase.data.notes).toContain(
      '9.14c：非移动阶段被夺取的运输点本阶段不能移动',
    )
  })

  it('MA 分组阈值：>10 归卡车、≤10 归马车', () => {
    expect(TRANSPORT_TRUCK_MIN_MA).toBe(10)
    expect(transportGroupOf(20)).toBe('trucks')
    expect(transportGroupOf(11)).toBe('trucks')
    expect(transportGroupOf(10)).toBe('wagons')
    expect(transportGroupOf(5)).toBe('wagons')
  })

  it('9.14c 末段：混合类型（普通卡车与编内卡车）⇒ 原主决定谁被夺取，数额须与组结果相符', () => {
    const outcome = run({
      objects: [
        object({
          id: 'normal',
          kind: 'transport',
          transportMa: 20,
          transportPoints: 1,
          loadedSpT: 4,
        }),
        object({
          id: 'organic',
          kind: 'transport',
          transportMa: 20,
          transportPoints: 1,
          organic: true,
        }),
      ],
      dice: { trucks: 4 },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const group = outcome.data.transportGroups[0]!
    expect(group).toMatchObject({ totalPoints: 2, capturedPoints: 1, displacedPoints: 1 })
    expect(outcome.data.objects.map((item) => item.result)).toEqual(['ownerChoice', 'ownerChoice'])

    expect(
      applyTransportOwnerChoice({ group, captured: { points: 1, loadedT: group.capturedLoadedT } }),
    ).toMatchObject({ ok: true })
    expect(
      applyTransportOwnerChoice({ group, captured: { points: 2, loadedT: group.capturedLoadedT } }),
    ).toMatchObject({ ok: false, rule: '9.14c' })
  })

  it('9.14c 重要提示：延补队不计入卡车/马车总数、也不走夺取表', () => {
    const outcome = run({
      objects: [
        object({ id: 'ex', kind: 'extender', rangeMp: 20 }),
        object({ id: 'normal', kind: 'transport', transportMa: 20, transportPoints: 2 }),
      ],
      dice: { trucks: 6 },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // 组内只有运输点 2 点，延补队不在其中
    expect(outcome.data.transportGroups[0]).toMatchObject({ totalPoints: 2 })
    const extender = outcome.data.objects.find((item) => item.id === 'ex')
    expect(extender).toMatchObject({ result: 'collapsed' })
    expect(outcome.data.notes).toContain(
      '9.14c：延补队不受夺取表损失、亦不计入卡车/马车总数，改按 9.14d 崩溃',
    )
  })

  it('9.14c：同格的**己方**运输点不计入夺取分组（夺取表只处置敌方运输点数）', () => {
    const outcome = run({
      objects: [
        object({
          id: 'enemy-tk',
          kind: 'transport',
          owner: 'soviet',
          transportMa: 20,
          transportPoints: 2,
        }),
        object({
          id: 'own-tk',
          kind: 'transport',
          owner: 'axis',
          transportMa: 20,
          transportPoints: 3,
        }),
      ],
      dice: { trucks: 3 },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // 只按敌方的 2 点计算：25% → 取整 1 点被夺取、1 点位移
    expect(outcome.data.transportGroups).toEqual([
      expect.objectContaining({
        group: 'trucks',
        totalPoints: 2,
        capturedPoints: 1,
        displacedPoints: 1,
      }),
    ])
    expect(outcome.data.objects.find((item) => item.id === 'own-tk')).toMatchObject({
      result: 'unchanged',
    })
  })
})

/* ────────────────────────────── 9.14d 延补队崩溃 ────────────────────────────── */

describe('9.14d 延补队崩溃：位移到有追溯补给的格并翻面（委托 B11）', () => {
  it('有合法落点 ⇒ collapsed + 落点；无合法落点 ⇒ 留在原格并须按 9.14c 判夺取', () => {
    const moved = run({
      objects: [object({ id: 'ex', kind: 'extender', rangeMp: 20 })],
      extenderCollapse: { candidates: [{ col: 37, row: 13 }], hasTraceSupplyAt: () => true },
    })
    expect(moved.ok && moved.data.objects[0]).toMatchObject({
      result: 'collapsed',
      hex: { col: 37, row: 13 },
      capturesCheckRequired: false,
    })

    const stuck = run({
      objects: [object({ id: 'ex', kind: 'extender', rangeMp: 20 })],
      extenderCollapse: { candidates: [{ col: 37, row: 13 }], hasTraceSupplyAt: () => false },
    })
    expect(stuck.ok && stuck.data.objects[0]).toMatchObject({
      result: 'collapsed',
      hex: null,
      capturesCheckRequired: true,
    })
  })
})

/* ────────────────────────────── 9.14e 环形工事 ────────────────────────────── */

describe('9.14e 环形工事夺取（通规 21.11c：夺取降 1 级；本作专规 1.3a 永久工事不降）', () => {
  it('动态工事夺取降 1 级；1 级工事夺取后等同移除', () => {
    const two = run({ objects: [object({ id: 'hh', kind: 'hedgehog', hedgehogLevel: 2 })] })
    expect(two.ok && two.data.objects[0]).toMatchObject({ result: 'captured', to: 'axis' })
    expect(two.ok && two.data.objects[0]?.detail).toContain('等级 2 → 1')

    const one = run({ objects: [object({ id: 'hh', kind: 'hedgehog', hedgehogLevel: 1 })] })
    expect(one.ok && one.data.objects[0]?.detail).toContain(
      '等级 1 → 0（21.11c 夺取降 1 级，等同移除）',
    )
  })

  it('夺取结果带出「夺取后的新等级」（供状态层落盘，不必在界面重算）', () => {
    const one = run({ objects: [object({ id: 'hh', kind: 'hedgehog', hedgehogLevel: 1 })] })
    expect(one.ok && one.data.objects[0]).toMatchObject({ hedgehogLevelAfter: 0 })
  })

  it('地图印刷的永久工事按专规 1.3a 保持等级（不降级）', () => {
    const permanent = run({
      objects: [object({ id: 'hh', kind: 'hedgehog', hedgehogLevel: 2, permanent: true })],
    })
    expect(permanent.ok && permanent.data.objects[0]?.detail).toContain('等级保持 2')
  })
})

/* ────────────────────────────── 9.14f 空军基地与飞机 ────────────────────────────── */

describe('9.14f 空军基地夺取与飞机损失', () => {
  const escape = {
    friendlyBases: (side: string) => (side === 'soviet' ? [{ col: 40, row: 13 }] : []),
    canTransferTo: () => true,
  }

  it('基地被夺取且可立即使用；每机掷基地夺取表（+2 Active、+2 由战后推进夺取）', () => {
    expect(AIR_BASE_CAPTURE_DRM).toEqual({ active: 2, byAdvanceAfterCombat: 2 })
    const outcome = run({
      objects: [object({ id: 'ab', kind: 'airBase', level: 2 })],
      aircraft: [
        { id: 'p1', active: true, roll2d6: 3 }, // 3 + 2 = 5 ≤ 6 ⇒ 损失 1 军力
        { id: 'p2', active: false, roll2d6: 5 }, // 5 ⇒ 损失 1 军力
        { id: 'p3', active: true, roll2d6: 6 }, // 6 + 2 = 8 ≥ 7 ⇒ 无损失
      ],
      aircraftEscape: escape,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.objects[0]).toMatchObject({
      kind: 'airBase',
      result: 'captured',
      to: 'axis',
    })
    expect(outcome.data.aircraft[0]).toMatchObject({
      id: 'p1',
      modifiedRoll: 5,
      baseCapture: 'step_loss',
      stepLoss: true,
      fate: 'transferred',
      hex: { col: 40, row: 13 },
      inactiveAfter: true,
    })
    expect(outcome.data.aircraft[2]).toMatchObject({
      id: 'p3',
      modifiedRoll: 8,
      baseCapture: 'no_loss',
    })
  })

  it('+2 由战后推进夺取时生效（同一骰面从损失变为无损失）', () => {
    const withoutAdvance = run({
      objects: [object({ id: 'ab', kind: 'airBase', level: 1 })],
      aircraft: [{ id: 'p1', active: false, roll2d6: 5 }],
      aircraftEscape: escape,
    })
    expect(withoutAdvance.ok && withoutAdvance.data.aircraft[0]?.baseCapture).toBe('step_loss')
    const withAdvance = run({
      objects: [object({ id: 'ab', kind: 'airBase', level: 1 })],
      aircraft: [{ id: 'p1', active: false, roll2d6: 5 }],
      capturedByAdvanceAfterCombat: true,
      aircraftEscape: escape,
    })
    expect(withAdvance.ok && withAdvance.data.aircraft[0]).toMatchObject({
      modifiedRoll: 7,
      baseCapture: 'no_loss',
    })
  })

  it('2 倍距离内无友方基地 ⇒ 幸存飞机被摧毁', () => {
    const outcome = run({
      objects: [object({ id: 'ab', kind: 'airBase', level: 1 })],
      aircraft: [{ id: 'p1', active: false, roll2d6: 12 }],
      aircraftEscape: { friendlyBases: () => [], canTransferTo: () => false },
    })
    expect(outcome.ok && outcome.data.aircraft[0]).toMatchObject({
      fate: 'destroyed',
      hex: null,
      inactiveAfter: true,
    })
  })

  it('格内无被夺取的敌方基地 ⇒ 飞机不掷基地夺取表', () => {
    const outcome = run({
      objects: [],
      aircraft: [{ id: 'p1', active: false, roll2d6: 2 }],
    })
    expect(outcome.ok && outcome.data.aircraft).toEqual([])
    expect(outcome.ok && outcome.data.notes).toContain(
      '格内无被夺取的敌方空军基地：飞机不掷基地夺取表（9.14f 以基地被夺取为前提）',
    )
  })
})

/* ────────────────────────────── 归属交互 ────────────────────────────── */

describe('初设归属 vs 战斗后归属：只有「敌方可攻击单位进入」才改变归属', () => {
  it('无可攻击单位进入 ⇒ 全部 unchanged（不掷骰、不夺取）', () => {
    const outcome = run({
      attackCapableUnitEnters: false,
      objects: [
        object({ id: 'dump1', kind: 'dump', spT: 40 }),
        object({ id: 'hh', kind: 'hedgehog', hedgehogLevel: 2 }),
      ],
      dice: { dump: 6 },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.objects.map((item) => item.result)).toEqual(['unchanged', 'unchanged'])
    expect(outcome.data.transportGroups).toEqual([])
  })

  it('友军进入自家设施 ⇒ unchanged；敌方进入 ⇒ 按 9.14 处置（同一物件两种归属）', () => {
    const friendly = run({
      enteringSide: 'soviet',
      objects: [object({ id: 'dump1', kind: 'dump', spT: 40, owner: 'soviet' })],
      dice: { dump: 6 },
    })
    expect(friendly.ok && friendly.data.objects[0]).toMatchObject({
      result: 'unchanged',
      detail: '友军进入自家设施',
    })

    // 该 dump 一旦在战斗后改归轴心国，苏军再进入就不再有处置效果（归属已变）
    const capturedOwner = run({
      enteringSide: 'soviet',
      objects: [object({ id: 'dump1', kind: 'dump', spT: 40, owner: 'axis' })],
      dice: { dump: 6 },
    })
    expect(capturedOwner.ok && capturedOwner.data.objects[0]).toMatchObject({
      result: 'captured',
      to: 'soviet',
    })
  })

  it('9.14 只作用于**本格**物件（他格物件不受影响）', () => {
    const outcome = run({
      objects: [
        object({ id: 'here', kind: 'dump', spT: 8 }),
        object({ id: 'elsewhere', kind: 'dump', spT: 8, hex: { col: 1, row: 1 } }),
      ],
      dice: { dump: 6 },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data.objects.map((item) => item.id)).toEqual(['here'])
  })

  it('12.1a：T ↔ SP 文本换算', () => {
    expect(tokensText(18)).toBe('4 SP + 2 T')
    expect(tokensText(8)).toBe('2 SP')
    expect(tokensText(0)).toBe('0 SP')
  })
})

/* ──────────── 9.14c/d：落点候选与「由拥有者玩家挑选」的分配 ──────────── */

describe('9.14c 位移落点候选：格距上限内任意格（敌方单位/ZOC/禁入地形都不影响）', () => {
  it('上限取自 rules-constants（原文示例「最远 10 格」）', () => {
    expect(rulesConstants.specialCombat.transportDisplaceMaxHexes).toBe(10)
    expect(TRANSPORT_DISPLACE_MAX_HEXES).toBe(10)
  })

  it('候选＝图内且 0 < 格距 ≤ 上限的格，且按 列→行 排序', () => {
    const hexes = mapLayers.hexes.map((hex) => ({ col: hex.col, row: hex.row }))
    const from = hexes[0]!
    const candidates = transportDisplacementCandidates(from, hexes, 3)
    expect(candidates.length).toBeGreaterThan(0)
    for (const hex of candidates) {
      const distance = hexDistance(from, hex)
      expect(distance).toBeGreaterThan(0)
      expect(distance).toBeLessThanOrEqual(3)
    }
    const sorted = [...candidates].sort((a, b) => a.col - b.col || a.row - b.row)
    expect(candidates).toEqual(sorted)
  })

  it('格距超出上限者不入候选（上限 1 时只剩紧邻格）', () => {
    const hexes = mapLayers.hexes.map((hex) => ({ col: hex.col, row: hex.row }))
    const from = hexes[0]!
    const candidates = transportDisplacementCandidates(from, hexes, 1)
    expect(candidates.every((hex) => hexDistance(from, hex) === 1)).toBe(true)
  })
})

describe('9.14c 组级数额 → 算子级分配（planTransportSplit；界面给默认值，玩家可改）', () => {
  const group = (over: Partial<TransportGroupResult> = {}): TransportGroupResult => ({
    group: 'trucks',
    die: 3,
    percent: 25,
    totalPoints: 3,
    capturedPoints: 1,
    displacedPoints: 2,
    totalLoadedT: 12,
    capturedLoadedT: 3,
    displacedLoadedT: 9,
    needsOwnerChoice: true,
    ...over,
  })

  it('能精确拼出表值 ⇒ exact=true，且夺取/位移两集合互补', () => {
    const plan = planTransportSplit({
      group: group(),
      counters: [
        { id: 'a', points: 1, loadedT: 3 },
        { id: 'b', points: 2, loadedT: 9 },
      ],
    })
    expect(plan.exact).toBe(true)
    expect(plan.capturedPoints).toBe(1)
    expect(plan.capturedLoadedT).toBe(3)
    expect(plan.capturedUnitIds).toEqual(['a'])
    expect(plan.displacedUnitIds).toEqual(['b'])
    expect(plan.detail).toContain('与表值一致')
  })

  it('算子规格拼不出表值 ⇒ exact=false，取最接近并把差额如实报出', () => {
    const plan = planTransportSplit({
      group: group({ totalPoints: 6, capturedPoints: 2, displacedPoints: 4 }),
      counters: [{ id: 'a', points: 3, loadedT: 0 }],
    })
    expect(plan.exact).toBe(false)
    // 只有 0 点与 3 点两种可能；|3−2| < |0−2| ⇒ 取 3 点，超出表值 1 点
    expect(plan.capturedUnitIds).toEqual(['a'])
    expect(plan.detail).toContain('取最接近者')
  })

  it('0 点需求（骰 1 的 0%）⇒ 全部位移，无人被夺取', () => {
    const plan = planTransportSplit({
      group: group({
        capturedPoints: 0,
        capturedLoadedT: 0,
        displacedPoints: 3,
        displacedLoadedT: 12,
      }),
      counters: [
        { id: 'a', points: 1, loadedT: 4 },
        { id: 'b', points: 2, loadedT: 8 },
      ],
    })
    expect(plan.capturedPoints).toBe(0)
    expect(plan.capturedUnitIds).toEqual([])
    expect(plan.displacedUnitIds).toEqual(['a', 'b'])
    expect(plan.exact).toBe(true)
  })
})

describe('9.14d 延补队崩溃：落点由玩家选定（chosenHex），并按各队自身拖取距离筛', () => {
  it('玩家选定的落点在合法候选内 ⇒ 用该落点', () => {
    const outcome = run({
      objects: [object({ id: 'ex', kind: 'extender', rangeMp: 20 })],
      extenderCollapse: {
        candidates: [
          { col: 37, row: 13 },
          { col: 38, row: 13 },
        ],
        hasTraceSupplyAt: () => true,
        chosenHex: { col: 38, row: 13 },
      },
    })
    expect(outcome.ok && outcome.data.objects[0]).toMatchObject({
      result: 'collapsed',
      hex: { col: 38, row: 13 },
      capturesCheckRequired: false,
    })
    expect(outcome.ok && outcome.data.objects[0]?.detail).toContain('落点按玩家选择：38.13')
  })

  it('玩家选定的落点不在合法候选内 ⇒ 拒绝（便于界面纠正）', () => {
    const outcome = run({
      objects: [object({ id: 'ex', kind: 'extender', rangeMp: 20 })],
      extenderCollapse: {
        candidates: [{ col: 37, row: 13 }],
        hasTraceSupplyAt: () => true,
        chosenHex: { col: 99, row: 99 },
      },
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.rule).toBe('9.14d')
      expect(outcome.reason).toContain('chosenHexNotLegal')
    }
  })

  it('同格多个延补队：各自按自身拖取距离筛候选（候选池给图内全部格）', () => {
    const outcome = run({
      objects: [
        object({ id: 'far', kind: 'extender', rangeMp: 5 }),
        object({ id: 'near', kind: 'extender', rangeMp: 1 }),
      ],
      extenderCollapse: {
        candidates: [
          { col: 36, row: 12 }, // 距 36.13 一格
          { col: 36, row: 10 }, // 距 36.13 三格
        ],
        hasTraceSupplyAt: () => true,
      },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const far = outcome.data.objects.find((item) => item.id === 'far')
    const near = outcome.data.objects.find((item) => item.id === 'near')
    expect(far !== undefined && far.result === 'collapsed' && far.legalHexes.length).toBe(2)
    expect(near !== undefined && near.result === 'collapsed' && near.legalHexes.length).toBe(1)
    expect(near !== undefined && near.result === 'collapsed' ? near.legalHexes[0] : null).toEqual({
      col: 36,
      row: 12,
    })
  })
})
