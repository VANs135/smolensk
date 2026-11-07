import type { HexRef, Side } from '@/data'
import { mapLayers } from '@/data'

import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import { computeReachableHexes, createMapFacts } from '@/engine/rules'
import type { MoveContext, MoveUnitView } from '@/engine/rules'

/**
 * 可达格 BFS 的等价性夹具（性能优化 A 的闸门）
 *
 * 只负责**摆盘 + 取快照**，不写断言：基准由**未改造代码**生成后固化在
 * `move-reachable-equivalence.test.ts`，改造后必须逐字符一致。
 *
 * 关键：所有场景都用**产品真实地图**（`createMapFacts()`）与真实 TEC 费率，
 * 覆盖开阔地、道路、过河、EZOC（抵消/未抵消）、敌方占格、战略断补、
 * 预备 + 工事、6.1c 最小移动与地图边界。
 */

const key = (hex: HexRef): string => `${hex.col}.${hex.row}`

/** 找一个六邻全在图内的内部格（避免边界把场景判死） */
const INTERIOR: HexRef = (() => {
  for (const hex of mapLayers.hexes) {
    if (hex.col < 12 || hex.col > 40 || hex.row < 12 || hex.row > 24) continue
    const here: HexRef = { col: hex.col, row: hex.row }
    if (HEX_DIRECTIONS.every((direction) => isOnMap(neighbor(here, direction)))) return here
  }
  throw new Error('地图上找不到全邻居的内部格')
})()

/** 最西侧边界格（边界分支） */
const BORDER: HexRef = (() => {
  const minCol = Math.min(...mapLayers.hexes.map((hex) => hex.col))
  const row = mapLayers.hexes.find((hex) => hex.col === minCol)!.row
  return { col: minCol, row }
})()

const at = (index: number, from: HexRef = INTERIOR): HexRef =>
  neighbor(from, HEX_DIRECTIONS[index]!)

function unit(over: Partial<MoveUnitView> & { id: string }): MoveUnitView {
  return {
    side: 'axis',
    isCombat: true,
    attackCapable: true,
    hasTraceSupply: true,
    hex: INTERIOR,
    mobility: 'leg',
    ma: 6,
    re: 2,
    mode: 'combat',
    orientation: 'combat',
    dg: false,
    exploit: false,
    releasedFromReserve: false,
    fuelled: true,
    mpLockedThisPhase: false,
    ...over,
  }
}

function enemy(id: string, hex: HexRef, over: Partial<MoveUnitView> = {}): MoveUnitView {
  return unit({ id, side: 'soviet' as Side, hex, ...over })
}

interface Scenario {
  name: string
  units: MoveUnitView[]
  over?: Partial<MoveContext>
  /** 取哪些单位的可达格（缺省全部本方单位） */
  probeIds?: string[]
}

const scenarios: Scenario[] = [
  {
    name: 'S1 步行·开阔地',
    units: [unit({ id: 'leg-open', mobility: 'leg', ma: 6 })],
  },
  {
    name: 'S2 履带·相邻敌方 ZOC（履带不受 4.5a-A 限制）',
    units: [unit({ id: 'track-zoc', mobility: 'track', ma: 8 }), enemy('e-track', at(0))],
  },
  {
    name: 'S3 轮式·相邻敌方 ZOC（进入即被迫停）',
    units: [unit({ id: 'truck-zoc', mobility: 'truck', ma: 8 }), enemy('e-truck', at(0))],
  },
  {
    name: 'S4 轮式·EZOC 被己方垫人抵消',
    units: [
      unit({ id: 'truck-cancel', mobility: 'truck', ma: 8 }),
      enemy('e-cancel', at(0)),
      unit({ id: 'f-cancel', hex: at(1), mpLockedThisPhase: true }),
    ],
  },
  {
    name: 'S5 敌方战斗单位占格（6.3b 不可直接进入）',
    units: [unit({ id: 'leg-blocked', ma: 6 }), enemy('e-block', at(2))],
  },
  {
    name: 'S6 战略模式·断补格必须停（5.8b）',
    units: [unit({ id: 'strat', mode: 'strat', orientation: 'move', ma: 4 })],
    over: { traceSupplyAt: (hex) => hex.col < INTERIOR.col },
  },
  {
    name: 'S7 预备 + 工事格只可路过不可停（5.7g）',
    units: [unit({ id: 'reserve', mode: 'reserve', ma: 3 })],
    over: { hedgehogLevelAt: (hex) => (key(hex) === key(at(0)) ? 1 : 0) },
  },
  {
    name: 'S8 6.1c 最小移动（MA 只有 1，地形要 2）',
    units: [unit({ id: 'min-move', mobility: 'leg', ma: 1 })],
  },
  {
    name: 'S9 边界格',
    units: [unit({ id: 'edge', hex: BORDER, ma: 3 })],
  },
  {
    name: 'S10 堆叠两枚（各自 BFS 独立）',
    units: [
      unit({ id: 'stack-a', ma: 5 }),
      unit({ id: 'stack-b', ma: 3, mobility: 'track' }),
      enemy('e-stack', at(1)),
    ],
  },
]

function renderResult(result: ReturnType<typeof computeReachableHexes>): string {
  if (!result.ok) return `reject ${result.reason} ${result.rule} ${result.detail ?? '-'}`
  const nodes = result.reachable.map(
    (node) =>
      `${key(node.hex)}@${node.mpSpent}${node.minimumMove ? ':min' : ''}${
        node.forcedStop ? ':stop' : ''
      }:${node.path.map(key).join('>')}`,
  )
  return `ok ma=${result.ma} n=${result.reachable.length} :: ${nodes.join(' | ')}`
}

/** 全量快照（逐场景、逐单位） */
export function reachableSnapshots(): string {
  const lines: string[] = []
  for (const scenario of scenarios) {
    const context: MoveContext = {
      phase: 'movement',
      activeSide: 'axis',
      map: createMapFacts(),
      units: scenario.units,
      ...scenario.over,
    }
    lines.push(`# ${scenario.name}`)
    const ids =
      scenario.probeIds ??
      scenario.units.filter((item) => item.side === 'axis').map((item) => item.id)
    for (const id of ids) {
      lines.push(`${id} :: ${renderResult(computeReachableHexes(context, id))}`)
    }
  }
  return lines.join('\n')
}

/** 供断言使用的内部格（个别用例需要据此构造期望） */
export const FIXTURE_INTERIOR = INTERIOR
export const FIXTURE_BORDER = BORDER
export const FIXTURE_AT = at
