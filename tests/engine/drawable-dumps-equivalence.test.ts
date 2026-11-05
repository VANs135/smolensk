import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import {
  canDrawFromDump,
  countSupplyDistanceToAny,
  drawableDumpsFor,
  planSupplyPhase,
  type DrawableDump,
  type SupplyMobility,
  type TraceSupplyFacts,
  type TraceSupplyUnitView,
} from '@/engine/rules'

/**
 * P1a（12.3a/12.3c）：`drawableDumpsFor` 的**行为等价性基准**
 *
 * 背景：补给计划链（`deliverableDumpsFor` / `hqDeliveryDumpKeys`）只读 `ok` 与 `hex`，
 * 但修前每次调用会为**每座 dump**跑 1 次「到任一目标」+ 7 次「到指定目标」+ 1 次造路径的
 * Dijkstra（profile：`nearestTarget` 独占 29.0% 总时长）。改造后：
 *   ① 距离/可达性/最近目标格由**同一次有界搜索**给出（判据不变，见下）；
 *   ② `path` 改为**惰性构建**（只在读 `.path` 时算，只算一次）。
 *
 * 本文件是那次改造的**基准快照**：用注入式假事实摆出「多 dump / 多单位 / EZOC 抵消 /
 * 不可达 / 绕行加价 / 两种机动类型 / 两方阵营」的局面，把改造前
 * `drawableDumpsFor`（含 `nearestTarget` 的可观测结果：路径终点与 `viaAdjacency`）
 * 与 `countSupplyDistanceToAny` 的**全部输出**固化成下面那段文本，
 * 改造后逐字段比对（任何一处漂移都会让 `toEqual` 失败）。
 *
 * 边界（如实）：`nearestTarget` 不是导出函数，故它的输出通过「路径末格 + `viaAdjacency`」观测；
 * 快照文本对每个 dump 记录 `hex | distanceMp | path | viaAdjacency | ok | rule | reason | detail`
 * ——即 `DrawableDump` 的**全部字段**（`path` 记整条，首末点自然在内）。
 */

const label = (hex: HexRef): string => `${hex.col}.${hex.row}`
const at = (col: number, row: number): HexRef => ({ col, row })

/* ────────────────────────────── 假盘面（完全确定，不读真实地图） ────────────────────────────── */

/** 棋盘范围：列 30–44、行 0–14（假事实自定，与真实地图削角无关） */
function inBoard(hex: HexRef): boolean {
  return hex.col >= 30 && hex.col <= 44 && hex.row >= 0 && hex.row <= 14
}

/** 进入这些格要 3 MP（制造「绕行 vs 直穿」的路径差） */
const ROUGH = new Set(['34.7', '34.8'])

/** 敌方 ZOC 原始覆盖格（4.5b 的抵消另算） */
const RAW_ZOC = new Set(['36.11', '35.10', '35.9'])

/** 围死 dump（33.9）的敌方战斗单位：其六邻格 + 目标格 36.9 本身 */
const ENEMY_COMBAT_HEXES: HexRef[] = [
  at(33, 10),
  at(34, 9),
  at(34, 8),
  at(33, 8),
  at(32, 8),
  at(32, 9),
  at(36, 9),
]

/** 双方战斗单位（4.5b：格内有己方战斗单位即抵消 ZOC） */
const UNITS: TraceSupplyUnitView[] = [
  ...ENEMY_COMBAT_HEXES.map((hex) => ({
    id: `enemy-${label(hex)}`,
    side: 'soviet' as Side,
    hex,
    isCombat: true,
    attackCapable: true,
    inCombatMode: true,
    hasTraceSupply: true,
  })),
  // 35.10 在敌方 ZOC 原始表里，但有己方战斗单位 ⇒ 抵消（4.5b）
  {
    id: 'axis-35.10',
    side: 'axis' as Side,
    hex: at(35, 10),
    isCombat: true,
    attackCapable: false,
    inCombatMode: false,
    hasTraceSupply: true,
  },
]

const ENEMY_COMBAT = new Set(ENEMY_COMBAT_HEXES.map(label))
const FRIENDLY_COMBAT = new Set(
  UNITS.filter((unit) => unit.isCombat && unit.hex !== null).map(
    (unit) => `${unit.side}|${unit.hex === null ? '' : label(unit.hex)}`,
  ),
)
const friendlyCombatAt = (hex: HexRef, side: Side): boolean =>
  FRIENDLY_COMBAT.has(`${side}|${label(hex)}`)

const DUMPS: { hex: HexRef; side: Side }[] = [
  { hex: at(30, 4), side: 'axis' },
  { hex: at(31, 6), side: 'axis' },
  { hex: at(40, 12), side: 'axis' },
  { hex: at(33, 9), side: 'axis' }, // 被敌方战斗单位围死 ⇒ 不可达
  { hex: at(31, 4), side: 'soviet' },
]

/** 注入式假事实（与 supply-interaction.test.ts 同法：每步 1 MP，粗糙格 3 MP） */
function makeFacts(dumps: { hex: HexRef; side: Side }[] = DUMPS): TraceSupplyFacts {
  return {
    onMap: (hex) => inBoard(hex),
    sourcesFor: () => [],
    extendersFor: () => [],
    throwHqsFor: () => [],
    dumpsFor: (side) => dumps.filter((item) => item.side === side).map((item) => item.hex),
    hasEnemyCombatUnit: (hex) => ENEMY_COMBAT.has(label(hex)),
    inEnemyZoc: (hex, side) => RAW_ZOC.has(label(hex)) && !friendlyCombatAt(hex, side),
    stepCost: (from, to) => (inBoard(from) && inBoard(to) ? (ROUGH.has(label(to)) ? 3 : 1) : null),
  }
}

const FACTS = makeFacts()

/**
 * 2b 专项夹具：在原有盘面上**再加两座与 (37,3) 等距的 dump**（(36,3) 与 (38,3) 都是其六邻格，
 * 到该格的受益格集合均为 0 MP），用来锁「等距 / 多可达 ⇒ 源集合必须完整、顺序必须稳定」，以及 12.6c 的分组键。
 * 该格还有一座 5 MP 边界的 31.6 可达 —— 正好检验「集合里既有等距的两座、也有更远但仍在预算内的站」。
 */
const TIE_DUMPS: { hex: HexRef; side: Side }[] = [
  ...DUMPS,
  { hex: at(36, 3), side: 'axis' },
  { hex: at(38, 3), side: 'axis' },
]

const TIE_FACTS = makeFacts(TIE_DUMPS)

/* ────────────────────────────── 快照 ────────────────────────────── */

/** 被观测的「受益格」（12.3c 的终点集合 = 该格及其六邻格） */
const CASES: { hex: HexRef; side: Side; mobility: SupplyMobility }[] = [
  { hex: at(30, 5), side: 'axis', mobility: 'truck' }, // 与 dump 相邻 ⇒ 1 MP、终点为自身
  { hex: at(36, 6), side: 'axis', mobility: 'truck' }, // 绕行加价格附近
  { hex: at(36, 6), side: 'axis', mobility: 'leg' }, // 同格换机动类型（EZOC 不阻挡步行）
  { hex: at(36, 9), side: 'axis', mobility: 'truck' }, // 自身格被敌战斗单位占据 ⇒ 只能够到邻格
  { hex: at(42, 2), side: 'axis', mobility: 'truck' }, // 全部 dump 都 > 5 MP ⇒ 不可达
  { hex: at(35, 10), side: 'axis', mobility: 'truck' }, // EZOC 被己方战斗单位抵消（4.5b）
  { hex: at(36, 11), side: 'axis', mobility: 'truck' }, // EZOC 未抵消 ⇒ 卡车进不去自身格
  { hex: at(36, 11), side: 'axis', mobility: 'leg' }, // 同格换步行 ⇒ 不受 EZOC 阻挡
  { hex: at(40, 12), side: 'axis', mobility: 'truck' }, // 与 dump 同格
  { hex: at(31, 5), side: 'soviet', mobility: 'truck' }, // 另一方的 dump 集合
]

/** 2b 快照用例：原有用例 + 一个与两座 dump 等距的格（源集合恰好两座） */
const TIE_CASES: typeof CASES = [...CASES, { hex: at(37, 3), side: 'axis', mobility: 'truck' }]

/** 有界/无界距离查询的直接探针（`countSupplyDistanceToAny` 的对外输出） */
const PROBES: {
  from: HexRef
  targets: HexRef[]
  side: Side
  mobility: SupplyMobility
  maxMp?: number
}[] = [
  { from: at(30, 4), targets: [at(30, 5)], side: 'axis', mobility: 'truck', maxMp: 5 },
  { from: at(30, 4), targets: [at(36, 6)], side: 'axis', mobility: 'truck', maxMp: 5 },
  { from: at(30, 4), targets: [at(36, 6)], side: 'axis', mobility: 'truck' },
  { from: at(30, 4), targets: [at(36, 6), at(35, 10)], side: 'axis', mobility: 'truck', maxMp: 5 },
  { from: at(36, 11), targets: [at(36, 11)], side: 'axis', mobility: 'truck', maxMp: 5 },
  { from: at(36, 11), targets: [at(36, 11)], side: 'axis', mobility: 'leg', maxMp: 5 },
  { from: at(40, 12), targets: [at(36, 11)], side: 'axis', mobility: 'truck', maxMp: 5 },
  { from: at(40, 12), targets: [at(36, 11)], side: 'axis', mobility: 'leg', maxMp: 5 },
  { from: at(33, 9), targets: [at(33, 10), at(33, 8)], side: 'axis', mobility: 'truck', maxMp: 5 },
  { from: at(29, 4), targets: [at(30, 5)], side: 'axis', mobility: 'truck', maxMp: 5 },
  { from: at(30, 4), targets: [at(29, 4)], side: 'axis', mobility: 'truck', maxMp: 5 },
  { from: at(30, 4), targets: [], side: 'axis', mobility: 'truck', maxMp: 5 },
]

function dumpLine(dump: DrawableDump): string {
  return [
    label(dump.hex),
    dump.distanceMp === null ? 'null' : String(dump.distanceMp),
    dump.path === null ? 'null' : dump.path.map(label).join('>'),
    dump.viaAdjacency ? 'viaAdjacency' : 'self',
    dump.ok ? 'ok' : 'blocked',
    dump.rule,
    dump.reason ?? '-',
    dump.detail,
  ].join(' | ')
}

function buildSnapshot(
  facts: TraceSupplyFacts = FACTS,
  cases: { hex: HexRef; side: Side; mobility: SupplyMobility }[] = CASES,
  probes = PROBES,
): string {
  const lines: string[] = []
  for (const item of cases) {
    lines.push(`# ${item.side} ${label(item.hex)} ${item.mobility}`)
    for (const dump of drawableDumpsFor(facts, {
      hex: item.hex,
      side: item.side,
      mobility: item.mobility,
    }))
      lines.push(dumpLine(dump))
    // 聚合结论也必须一致（它只读 ok/距离，但同样受本次改造影响）
    const verdict = canDrawFromDump(facts, {
      hex: item.hex,
      side: item.side,
      mobility: item.mobility,
    })
    lines.push(
      `canDrawFromDump: ${verdict.ok ? `ok ${verdict.rule} ${verdict.detail ?? '-'}` : `blocked ${verdict.reason ?? '-'}`}`,
    )
    // 12.10a/b 的归属 = **全部可达 dump 的有序集合**（workbench 的 `sourceKey` 即此串）；
    // 它同时是 12.6c 的批量分组键，所以必须逐字符稳定，不能退化成「最近的某一个 dump」。
    const sourceSet = drawableDumpsFor(facts, {
      hex: item.hex,
      side: item.side,
      mobility: item.mobility,
    })
      .filter((dump) => dump.ok)
      .map((dump) => label(dump.hex))
      .sort()
    lines.push(`sourceKey(12.6c 分组键): ${sourceSet.length === 0 ? 'null' : sourceSet.join('|')}`)
  }
  for (const probe of probes) {
    const result = countSupplyDistanceToAny(facts, {
      from: probe.from,
      targets: probe.targets,
      side: probe.side,
      mobility: probe.mobility,
      ...(probe.maxMp === undefined ? {} : { maxMp: probe.maxMp }),
    })
    lines.push(
      `@ ${label(probe.from)} -> [${probe.targets.map(label).join(',')}] ${probe.side} ${probe.mobility} ` +
        `maxMp=${probe.maxMp ?? 'inf'}: ${
          result.ok ? `ok ${result.mp} MP` : `blocked ${result.reason}`
        }`,
    )
  }
  return lines.join('\n')
}

/**
 * 改造前的基准快照（2026-11-05 由**未改造代码**生成，逐行一字段：
 * `dump | distanceMp | path | viaAdjacency | ok | rule | reason | detail`）
 */
const BASELINE = `
# axis 30.5 truck
30.4 | 0 | 30.4 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：0 MP ≤ 5 MP
31.6 | 0 | 31.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：0 MP ≤ 5 MP
40.12 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 0 MP
sourceKey(12.6c 分组键): 30.4|31.6
# axis 36.6 truck
30.4 | 5 | 30.4>31.5>32.5>33.6>34.6>35.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：5 MP ≤ 5 MP
31.6 | 4 | 31.6>32.6>33.7>34.6>35.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：4 MP ≤ 5 MP
40.12 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 4 MP
sourceKey(12.6c 分组键): 30.4|31.6
# axis 36.6 leg
30.4 | 5 | 30.4>31.5>32.5>33.6>34.6>35.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：5 MP ≤ 5 MP
31.6 | 4 | 31.6>32.6>33.7>34.6>35.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：4 MP ≤ 5 MP
40.12 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 4 MP
sourceKey(12.6c 分组键): 30.4|31.6
# axis 36.9 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 4 | 40.12>39.12>38.11>37.11>36.10 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：4 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 4 MP
sourceKey(12.6c 分组键): 40.12
# axis 42.2 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: blocked directDrawOutOfRange
sourceKey(12.6c 分组键): null
# axis 35.10 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 4 | 40.12>39.12>38.11>37.11>36.10 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：4 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 4 MP
sourceKey(12.6c 分组键): 40.12
# axis 36.11 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 3 | 40.12>39.12>38.11>37.12 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：3 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 3 MP
sourceKey(12.6c 分组键): 40.12
# axis 36.11 leg
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 3 | 40.12>39.12>38.11>37.12 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：3 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 3 MP
sourceKey(12.6c 分组键): 40.12
# axis 40.12 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 0 | 40.12 | self | ok | 12.3a | - | 可直接拖取（12.3a）：0 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 0 MP
sourceKey(12.6c 分组键): 40.12
# soviet 31.5 truck
31.4 | 0 | 31.4 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：0 MP ≤ 5 MP
canDrawFromDump: ok 12.3a 0 MP
sourceKey(12.6c 分组键): 31.4
@ 30.4 -> [30.5] axis truck maxMp=5: ok 1 MP
@ 30.4 -> [36.6] axis truck maxMp=5: blocked unreachable
@ 30.4 -> [36.6] axis truck maxMp=inf: ok 6 MP
@ 30.4 -> [36.6,35.10] axis truck maxMp=5: blocked unreachable
@ 36.11 -> [36.11] axis truck maxMp=5: ok 0 MP
@ 36.11 -> [36.11] axis leg maxMp=5: ok 0 MP
@ 40.12 -> [36.11] axis truck maxMp=5: blocked unreachable
@ 40.12 -> [36.11] axis leg maxMp=5: ok 4 MP
@ 33.9 -> [33.10,33.8] axis truck maxMp=5: blocked unreachable
@ 29.4 -> [30.5] axis truck maxMp=5: blocked offMap
@ 30.4 -> [29.4] axis truck maxMp=5: blocked offMap
@ 30.4 -> [] axis truck maxMp=5: blocked offMap
`.trim()

describe('P1a（12.3a/12.3c）：`drawableDumpsFor` 行为等价性基准', () => {
  it('逐字段与改造前的基准快照完全一致', () => {
    expect(buildSnapshot()).toBe(BASELINE)
  })
})

/*
 * ─────────────────────────── 2b：阶段级「源格距离表」的等价性基准 ───────────────────────────
 *
 * 改造前后都必须满足：
 *   ① 每个 dump 的 `hex | distanceMp | path 全链 | viaAdjacency | ok | rule | reason | detail` 逐字符相同；
 *   ② `sourceKey`（= 全部可达 dump 的有序集合，也是 12.6c 的分组键）逐字符相同 —— **不得**退化为 argmin；
 *   ③ 等距/多可达时集合**完整**（两座等距站都要在），顺序由 `.sort()` 固定。
 *
 * 下表由**未改造代码**（P1a 状态）生成并固化，2b 实施后原样断言。
 */
const TIE_BASELINE = `
# axis 30.5 truck
30.4 | 0 | 30.4 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：0 MP ≤ 5 MP
31.6 | 0 | 31.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：0 MP ≤ 5 MP
40.12 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
36.3 | 5 | 36.3>35.4>34.4>33.5>32.5>31.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：5 MP ≤ 5 MP
38.3 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 0 MP
sourceKey(12.6c 分组键): 30.4|31.6|36.3
# axis 36.6 truck
30.4 | 5 | 30.4>31.5>32.5>33.6>34.6>35.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：5 MP ≤ 5 MP
31.6 | 4 | 31.6>32.6>33.7>34.6>35.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：4 MP ≤ 5 MP
40.12 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
36.3 | 2 | 36.3>36.4>36.5 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：2 MP ≤ 5 MP
38.3 | 3 | 38.3>38.4>38.5>37.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：3 MP ≤ 5 MP
canDrawFromDump: ok 12.3a 2 MP
sourceKey(12.6c 分组键): 30.4|31.6|36.3|38.3
# axis 36.6 leg
30.4 | 5 | 30.4>31.5>32.5>33.6>34.6>35.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：5 MP ≤ 5 MP
31.6 | 4 | 31.6>32.6>33.7>34.6>35.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：4 MP ≤ 5 MP
40.12 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
36.3 | 2 | 36.3>36.4>36.5 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：2 MP ≤ 5 MP
38.3 | 3 | 38.3>38.4>38.5>37.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：3 MP ≤ 5 MP
canDrawFromDump: ok 12.3a 2 MP
sourceKey(12.6c 分组键): 30.4|31.6|36.3|38.3
# axis 36.9 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 4 | 40.12>39.12>38.11>37.11>36.10 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：4 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
36.3 | 5 | 36.3>36.4>36.5>36.6>36.7>36.8 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：5 MP ≤ 5 MP
38.3 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 4 MP
sourceKey(12.6c 分组键): 36.3|40.12
# axis 42.2 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
36.3 | 5 | 36.3>37.4>38.3>39.3>40.2>41.2 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：5 MP ≤ 5 MP
38.3 | 3 | 38.3>39.3>40.2>41.2 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：3 MP ≤ 5 MP
canDrawFromDump: ok 12.3a 3 MP
sourceKey(12.6c 分组键): 36.3|38.3
# axis 35.10 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 4 | 40.12>39.12>38.11>37.11>36.10 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：4 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
36.3 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
38.3 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 4 MP
sourceKey(12.6c 分组键): 40.12
# axis 36.11 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 3 | 40.12>39.12>38.11>37.12 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：3 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
36.3 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
38.3 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 3 MP
sourceKey(12.6c 分组键): 40.12
# axis 36.11 leg
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 3 | 40.12>39.12>38.11>37.12 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：3 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
36.3 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
38.3 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 3 MP
sourceKey(12.6c 分组键): 40.12
# axis 40.12 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 0 | 40.12 | self | ok | 12.3a | - | 可直接拖取（12.3a）：0 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
36.3 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
38.3 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 0 MP
sourceKey(12.6c 分组键): 40.12
# soviet 31.5 truck
31.4 | 0 | 31.4 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：0 MP ≤ 5 MP
canDrawFromDump: ok 12.3a 0 MP
sourceKey(12.6c 分组键): 31.4
# axis 37.3 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | 5 | 31.6>32.5>33.5>34.4>35.4>36.3 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：5 MP ≤ 5 MP
40.12 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
36.3 | 0 | 36.3 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：0 MP ≤ 5 MP
38.3 | 0 | 38.3 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：0 MP ≤ 5 MP
canDrawFromDump: ok 12.3a 0 MP
sourceKey(12.6c 分组键): 31.6|36.3|38.3
@ 30.4 -> [30.5] axis truck maxMp=5: ok 1 MP
@ 30.4 -> [36.6] axis truck maxMp=5: blocked unreachable
@ 30.4 -> [36.6] axis truck maxMp=inf: ok 6 MP
@ 30.4 -> [36.6,35.10] axis truck maxMp=5: blocked unreachable
@ 36.11 -> [36.11] axis truck maxMp=5: ok 0 MP
@ 36.11 -> [36.11] axis leg maxMp=5: ok 0 MP
@ 40.12 -> [36.11] axis truck maxMp=5: blocked unreachable
@ 40.12 -> [36.11] axis leg maxMp=5: ok 4 MP
@ 33.9 -> [33.10,33.8] axis truck maxMp=5: blocked unreachable
@ 29.4 -> [30.5] axis truck maxMp=5: blocked offMap
@ 30.4 -> [29.4] axis truck maxMp=5: blocked offMap
@ 30.4 -> [] axis truck maxMp=5: blocked offMap
`.trim()

describe('2b（阶段级源格距离表）：等距 / 多可达 / 12.6c 分组', () => {
  it('逐字段 + 源集合与未改造代码完全一致（等距夹具）', () => {
    expect(buildSnapshot(TIE_FACTS, TIE_CASES)).toBe(TIE_BASELINE)
  })

  it('等距多 dump：源集合完整且顺序稳定（不退化 argmin）', () => {
    const sourceKeyOf = (hex: HexRef, side: Side): string =>
      drawableDumpsFor(TIE_FACTS, { hex, side })
        .filter((dump) => dump.ok)
        .map((dump) => label(dump.hex))
        .sort()
        .join('|')
    // (36,3) 与 (38,3) 都在 (37,3) 的六邻格内 ⇒ 到受益格集合均为 0 MP（等距）；
    // 两座都必须 `ok` 且距离相等，但集合里还包含 5 MP 边界的 31.6 ⇒ 断言**完整集合**。
    const dumps = drawableDumpsFor(TIE_FACTS, { hex: at(37, 3), side: 'axis' })
    const byHex = new Map(dumps.map((dump) => [label(dump.hex), dump]))
    expect(byHex.get('36.3')?.distanceMp).toBe(0)
    expect(byHex.get('38.3')?.distanceMp).toBe(0)
    expect(byHex.get('36.3')?.distanceMp).toBe(byHex.get('38.3')?.distanceMp)
    expect(byHex.get('36.3')?.ok).toBe(true)
    expect(byHex.get('38.3')?.ok).toBe(true)
    expect(sourceKeyOf(at(37, 3), 'axis')).toBe('31.6|36.3|38.3')
    // 同一格重复求值必须稳定（两次调用不许出现顺序/成员漂移）
    expect(sourceKeyOf(at(37, 3), 'axis')).toBe(sourceKeyOf(at(37, 3), 'axis'))
  })

  it('12.6c：同一源集合仍按批次取整（2 个 1RE 单位 = 1T）', () => {
    const sourceKey = drawableDumpsFor(TIE_FACTS, { hex: at(37, 3), side: 'axis' })
      .filter((dump) => dump.ok)
      .map((dump) => label(dump.hex))
      .sort()
      .join('|')
    const unit = (id: string) => ({
      id,
      side: 'axis' as Side,
      hex: at(37, 3),
      isCombat: true,
      steps: 2,
      re: 1,
      ar: 2,
      mode: 'combat' as const,
      internalStocks: null,
      outOfSupply: false,
      multiStep: false,
    })
    const plan = planSupplyPhase(TIE_FACTS, {
      activeSide: 'axis',
      units: [unit('a'), unit('b')],
      mobility: 'truck',
      availableT: 9,
      eatOffTheMap: () => true,
      feedingSources: {
        a: { sourceKey, availableT: 9 },
        b: { sourceKey, availableT: 9 },
      },
    })
    expect(plan.feeding.map((item) => item.sourceKey)).toEqual([sourceKey, sourceKey])
    expect(plan.feeding.map((item) => item.costT)).toEqual([1, 0])
    expect(plan.remainingT).toBe(8)
  })
})
