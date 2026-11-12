import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers, scenarios } from '@/data'
import { convertedRailRun } from '@/engine/rules'

/**
 * 剧本初设换轨**快照基线**（专规 1.2 / 13.3f；数据方案 A）
 *
 * 运行期事实来源仍是 `setup.convertedAxisRails.runs` + 地图铁路图：每段 `A to B` 取**唯一最短路径**，
 * 路径上的边即该剧本的标准轨段；`setup.railheads` 只存各段 B 端（= 初设标准轨东端终点，mk-38 所在格）。
 * `map-layers.edges[].gauge` 不参与（保持缺省 broad），因为它无法表达逐剧本差异。
 *
 * 夹具 `tests/fixtures/converted-axis-rails.snapshot.json` 把每个剧本推出来的**边清单**固化下来：
 * 地图数据或路径算法一动，这里就会红，并能直接看出是哪个剧本的哪一段、哪几条边变了。
 * 改动若属预期，必须重新生成夹具，不得手改运行逻辑绕过。
 */
interface SnapshotRun {
  declaration: string
  hexes: string
  edges: string[]
}

interface SnapshotFile {
  note: string
  scenarios: Record<string, { railheads: string[]; runs: SnapshotRun[] }>
}

const snapshot = JSON.parse(
  readFileSync(new URL('../fixtures/converted-axis-rails.snapshot.json', import.meta.url), 'utf8'),
) as SnapshotFile

const keyOf = (hex: HexRef): string => `${hex.col}.${hex.row}`

const hexOf = (text: string): HexRef => {
  const [col, row] = text.split('.').map((value) => Number(value))
  return { col: col!, row: row! }
}

/** 与 `map_edges.json` 的 `edge_key` 同规：两端 `列.行` 按字符串字典序排序后以 `|` 连接 */
const edgeKey = (a: HexRef, b: HexRef): string => [keyOf(a), keyOf(b)].sort().join('|')

const railNeighborSource = {
  railNeighbors: (hex: HexRef): HexRef[] => {
    const found: HexRef[] = []
    for (const edge of mapLayers.edges) {
      if (edge.rail !== true) continue
      if (edge.a.col === hex.col && edge.a.row === hex.row) found.push(edge.b)
      if (edge.b.col === hex.col && edge.b.row === hex.row) found.push(edge.a)
    }
    return found
  },
}

const railEdgeKeys = new Set(
  mapLayers.edges.filter((edge) => edge.rail === true).map((edge) => edgeKey(edge.a, edge.b)),
)

describe('剧本初设换轨快照（专规 1.2）', () => {
  it('快照覆盖的剧本与数据一一对应（7 个剧本、18 段走线）', () => {
    expect(Object.keys(snapshot.scenarios).sort()).toEqual(
      scenarios.scenarios.map((s) => s.id).sort(),
    )
    const runs = Object.values(snapshot.scenarios).reduce((sum, item) => sum + item.runs.length, 0)
    expect(runs).toBe(18)
  })

  it('每个剧本都有 railheads，且逐段等于原文 B 端（段数一致）', () => {
    for (const scenario of scenarios.scenarios) {
      const declared = scenario.setup.convertedAxisRails
      expect(declared, `剧本 ${scenario.id} 缺 convertedAxisRails`).toBeTruthy()
      const railheads = scenario.setup.railheads
      expect(railheads, `剧本 ${scenario.id} 缺 setup.railheads`).toBeTruthy()
      const runEnds = declared!.runs.map((run) => run.split(/\s+to\s+/i)[1]!.trim())
      expect(railheads!.hexes, `剧本 ${scenario.id} 端头与段数不一致`).toEqual(runEnds)
      expect(railheads!.hexes).toEqual(snapshot.scenarios[scenario.id]!.railheads)
    }
  })

  it('逐剧本逐段：唯一路径推导出的边清单与快照完全一致', () => {
    for (const scenario of scenarios.scenarios) {
      const snapshotScenario = snapshot.scenarios[scenario.id]!
      const runs = scenario.setup.convertedAxisRails!.runs
      expect(runs, `剧本 ${scenario.id} 段数变化`).toEqual(
        snapshotScenario.runs.map((run) => run.declaration),
      )
      for (const [index, declaration] of runs.entries()) {
        const [fromText, toText] = declaration.split(/\s+to\s+/i)
        const outcome = convertedRailRun(railNeighborSource, {
          from: hexOf(fromText!),
          to: hexOf(toText!),
        })
        expect(`${scenario.id} ${declaration} ${outcome.ok ? 'ok' : outcome.reason}`).toBe(
          `${scenario.id} ${declaration} ok`,
        )
        if (!outcome.ok) continue
        const hexes = outcome.data.hexes
        const edges = hexes.slice(1).map((hex, edgeIndex) => edgeKey(hexes[edgeIndex]!, hex))
        const expected = snapshotScenario.runs[index]!
        expect(edges, `剧本 ${scenario.id}「${declaration}」边清单变化`).toEqual(expected.edges)
        expect(hexes.map(keyOf).join(' '), `剧本 ${scenario.id}「${declaration}」逐格变化`).toBe(
          expected.hexes,
        )
        // 快照里的每条边必须真的是地图上的铁路边
        for (const edge of edges) expect(railEdgeKeys.has(edge), `非铁路边：${edge}`).toBe(true)
      }
    }
  })
})
