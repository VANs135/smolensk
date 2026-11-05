import { describe, expect, it } from 'vitest'

import type { HexRef, Side } from '@/data'
import {
  canDrawFromDump,
  countSupplyDistanceToAny,
  drawableDumpsFor,
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
function makeFacts(): TraceSupplyFacts {
  return {
    onMap: (hex) => inBoard(hex),
    sourcesFor: () => [],
    extendersFor: () => [],
    throwHqsFor: () => [],
    dumpsFor: (side) => DUMPS.filter((item) => item.side === side).map((item) => item.hex),
    hasEnemyCombatUnit: (hex) => ENEMY_COMBAT.has(label(hex)),
    inEnemyZoc: (hex, side) => RAW_ZOC.has(label(hex)) && !friendlyCombatAt(hex, side),
    stepCost: (from, to) => (inBoard(from) && inBoard(to) ? (ROUGH.has(label(to)) ? 3 : 1) : null),
  }
}

const FACTS = makeFacts()

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

function buildSnapshot(): string {
  const lines: string[] = []
  for (const item of CASES) {
    lines.push(`# ${item.side} ${label(item.hex)} ${item.mobility}`)
    for (const dump of drawableDumpsFor(FACTS, {
      hex: item.hex,
      side: item.side,
      mobility: item.mobility,
    }))
      lines.push(dumpLine(dump))
    // 聚合结论也必须一致（它只读 ok/距离，但同样受本次改造影响）
    const verdict = canDrawFromDump(FACTS, {
      hex: item.hex,
      side: item.side,
      mobility: item.mobility,
    })
    lines.push(
      `canDrawFromDump: ${verdict.ok ? `ok ${verdict.rule} ${verdict.detail ?? '-'}` : `blocked ${verdict.reason ?? '-'}`}`,
    )
  }
  for (const probe of PROBES) {
    const result = countSupplyDistanceToAny(FACTS, {
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
# axis 36.6 truck
30.4 | 5 | 30.4>31.5>32.5>33.6>34.6>35.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：5 MP ≤ 5 MP
31.6 | 4 | 31.6>32.6>33.7>34.6>35.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：4 MP ≤ 5 MP
40.12 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 4 MP
# axis 36.6 leg
30.4 | 5 | 30.4>31.5>32.5>33.6>34.6>35.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：5 MP ≤ 5 MP
31.6 | 4 | 31.6>32.6>33.7>34.6>35.6 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：4 MP ≤ 5 MP
40.12 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 4 MP
# axis 36.9 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 4 | 40.12>39.12>38.11>37.11>36.10 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：4 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 4 MP
# axis 42.2 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: blocked directDrawOutOfRange
# axis 35.10 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 4 | 40.12>39.12>38.11>37.11>36.10 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：4 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 4 MP
# axis 36.11 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 3 | 40.12>39.12>38.11>37.12 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：3 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 3 MP
# axis 36.11 leg
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 3 | 40.12>39.12>38.11>37.12 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：3 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 3 MP
# axis 40.12 truck
30.4 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
31.6 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
40.12 | 0 | 40.12 | self | ok | 12.3a | - | 可直接拖取（12.3a）：0 MP ≤ 5 MP
33.9 | null | null | self | blocked | 12.3a | directDrawOutOfRange | 过远（12.3a）：Infinity MP > 5 MP，且不与 dump 相邻
canDrawFromDump: ok 12.3a 0 MP
# soviet 31.5 truck
31.4 | 0 | 31.4 | viaAdjacency | ok | 12.3a | - | 可直接拖取（12.3a）：0 MP ≤ 5 MP
canDrawFromDump: ok 12.3a 0 MP
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
