import { createPinia, setActivePinia } from 'pinia'

import { mapLayers } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, neighbor } from '@/engine/hex-geometry'
import { toConsoleUnit, unitChoices, useWorkbenchStore } from '@/stores'
import { isTransportUnit } from '@/stores/workbench-model'

/**
 * 12.8e-A「档 1（索引化 + 脱响应式）」的等价性夹具
 *
 * 只负责**摆盘 + 取快照**，不写断言：基准由**未改造代码**生成后固化在
 * `breakout-index-equivalence.test.ts`，改造后逐字符比对。
 *
 * 覆盖分支：可突围 / 不可突围、追踪友军相邻、敌方战斗单位挡路、EZOC（轮式）、
 * 双方阵营、地图边界格、无友军（B 距离不可达）。
 */

type Spec = {
  id: string
  hex: HexRef
  side: Side
  traced: boolean
  /** 该单位用轮式机动（12.8e-A 末句：轮式才受 EZOC 限制） */
  truck?: boolean
  /** 取运输单位记录（非战斗；验证 12.8e-A 的"友军"含非战斗、敌方只算战斗） */
  transport?: boolean
}

/** 全 6 邻居都在图内的内部格（避免边角地形/出图把路径判死） */
const INTERIOR: HexRef = (() => {
  for (const hex of mapLayers.hexes) {
    if (hex.col < 12 || hex.col > 40 || hex.row < 12 || hex.row > 24) continue
    const here: HexRef = { col: hex.col, row: hex.row }
    const ok = HEX_DIRECTIONS.every((direction) => {
      const next = neighbor(here, direction)
      return mapLayers.hexes.some((item) => item.col === next.col && item.row === next.row)
    })
    if (ok) return here
  }
  throw new Error('地图上找不到全邻居的内部格')
})()

/** 最西侧的边界格（12.8e 边界格分支） */
const BORDER: HexRef = (() => {
  const minCol = Math.min(...mapLayers.hexes.map((hex) => hex.col))
  const row = mapLayers.hexes.find((hex) => hex.col === minCol)!.row
  return { col: minCol, row }
})()

const at = (index: number, from: HexRef = INTERIOR): HexRef =>
  neighbor(from, HEX_DIRECTIONS[index]!)

const combats = (side: Side) =>
  unitChoices(side).filter((record) => record.isCombat === true && (record.steps?.total ?? 1) <= 1)

const RECORD_AXIS = combats('axis')[0]!
const RECORD_SOVIET = combats('soviet')[0]!

const transports = (side: Side) => unitChoices(side).filter((record) => isTransportUnit(record))

const TRANSPORT_AXIS = transports('axis')[0]!
const TRANSPORT_SOVIET = transports('soviet')[0]!

/**
 * 摆盘：先 `setPhase('movement')`（会触发一次全场重判），**之后**再经 store 代理钉补给状态
 * （与 `breakout-flow.test.ts` 同一时序，否则会被重判覆盖）。
 */
function build(specs: Spec[], active: Side = 'axis'): string {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  store.setActiveSide(active)
  store.setPhase('movement')
  for (const spec of specs) {
    const record = spec.transport
      ? spec.side === 'axis'
        ? TRANSPORT_AXIS
        : TRANSPORT_SOVIET
      : spec.side === 'axis'
        ? RECORD_AXIS
        : RECORD_SOVIET
    const unit = toConsoleUnit({
      record,
      instanceId: spec.id,
      hex: spec.hex,
      side: spec.side,
    })
    if (spec.truck === true) unit.faces.move.mobility = 'truck'
    store.units.push(unit)
  }
  for (const spec of specs) {
    const live = store.units.find((unit) => unit.instanceId === spec.id)!
    live.hasTraceSupply = spec.traced
  }
  const lines = store.breakoutCandidates.map(
    (entry) =>
      `${entry.unit.instanceId} | ${entry.ok ? 'ok' : 'reject'} | ${entry.reason ?? '-'} | ${entry.detail}`,
  )
  // 顺序稳定性：同一份状态连读两次必须相同（computed 缓存不得改变顺序）
  const again = store.breakoutCandidates.map((entry) => entry.unit.instanceId).join('>')
  return [...lines, `order: ${again}`].join('\n')
}

/** 全量快照（逐场景、逐单位） */
export function breakoutSnapshots(): string {
  const scenarios: { name: string; specs: Spec[]; active?: Side }[] = [
    {
      // 可突围：追踪友军就在相邻格
      name: 'S1 axis 相邻追踪友军',
      specs: [
        { id: 'a-trap', hex: INTERIOR, side: 'axis', traced: false },
        { id: 'a-friend', hex: at(0), side: 'axis', traced: true },
      ],
    },
    {
      // 双方：苏军，追踪友军隔 3 格
      name: 'S2 soviet 3 格外追踪友军',
      active: 'soviet',
      specs: [
        { id: 's-trap', hex: INTERIOR, side: 'soviet', traced: false },
        { id: 's-friend', hex: at(3), side: 'soviet', traced: true },
      ],
    },
    {
      // 不可突围：6 邻居全是敌方战斗单位（口袋），追踪友军在口袋外
      name: 'S3 口袋：敌战斗单位环绕',
      specs: [
        { id: 'p-trap', hex: INTERIOR, side: 'axis', traced: false },
        ...HEX_DIRECTIONS.map((_, index) => ({
          id: `p-enemy-${index}`,
          hex: at(index),
          side: 'soviet' as Side,
          traced: false,
        })),
        { id: 'p-friend', hex: at(1, at(0)), side: 'axis', traced: true },
      ],
    },
    {
      // 敌方战斗单位挡路（无包围，只有一条方向被堵）
      name: 'S4 单侧敌战斗单位挡路',
      specs: [
        { id: 'b-trap', hex: INTERIOR, side: 'axis', traced: false },
        { id: 'b-enemy', hex: at(2), side: 'soviet', traced: false },
        { id: 'b-friend', hex: at(2, at(2)), side: 'axis', traced: true },
      ],
    },
    {
      // 轮式 + EZOC：敌方战斗单位投射 EZOC，路径上无己方战斗单位抵消
      name: 'S5 轮式：EZOC 未抵消',
      specs: [
        { id: 'e-trap', hex: INTERIOR, side: 'axis', traced: false, truck: true },
        { id: 'e-enemy', hex: at(2), side: 'soviet', traced: false },
        { id: 'e-friend', hex: at(1, at(1)), side: 'axis', traced: true },
      ],
    },
    {
      // 轮式 + EZOC 被己方战斗单位抵消
      name: 'S6 轮式：EZOC 被抵消',
      specs: [
        { id: 'c-trap', hex: INTERIOR, side: 'axis', traced: false, truck: true },
        { id: 'c-enemy', hex: at(2), side: 'soviet', traced: false },
        { id: 'c-cancel', hex: at(1, at(1)), side: 'axis', traced: false },
        { id: 'c-friend', hex: at(3), side: 'axis', traced: true },
      ],
    },
    {
      // 与追踪友军同格（`isTracedFriend` 的"同格不算"分支）
      name: 'S9 与追踪友军同格',
      specs: [
        { id: 'same-trap', hex: INTERIOR, side: 'axis', traced: false },
        { id: 'same-friend', hex: INTERIOR, side: 'axis', traced: true },
      ],
    },
    {
      // 追踪友军是运输单位（非战斗）：12.8e-A 的"友军"包含它
      name: 'S10 追踪友军为非战斗运输单位',
      specs: [
        { id: 'tr-trap', hex: INTERIOR, side: 'axis', traced: false },
        { id: 'tr-friend', hex: at(0), side: 'axis', traced: true, transport: true },
      ],
    },
    {
      // 相邻敌方**非战斗**单位不构成 pathHasEnemyCombatUnit
      name: 'S11 相邻敌方非战斗单位',
      specs: [
        { id: 'nc-trap', hex: INTERIOR, side: 'axis', traced: false },
        { id: 'nc-enemy', hex: at(0), side: 'soviet', traced: false, transport: true },
        { id: 'nc-friend', hex: at(3), side: 'axis', traced: true },
      ],
    },
    {
      // 边界格
      name: 'S7 边界格',
      specs: [
        { id: 'edge-trap', hex: BORDER, side: 'axis', traced: false },
        { id: 'edge-friend', hex: at(0, BORDER), side: 'axis', traced: true },
      ],
    },
    {
      // 无友军：A 摸不到人、B 也无（距离 null）
      name: 'S8 无追踪友军',
      specs: [{ id: 'lonely', hex: INTERIOR, side: 'axis', traced: false }],
    },
  ]
  return scenarios
    .map(({ name, specs, active }) => `# ${name}\n${build(specs, active ?? 'axis')}`)
    .join('\n\n')
}

/**
 * 依赖追踪探针：把追踪友军从 3 格外挪到相邻格，`breakoutCandidates` **必须随之变化**。
 * 脱响应式改造若把 computed 的依赖一起脱掉，这里会读到旧结论。
 */
export function breakoutReactivityProbe(): { before: string; after: string } {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  store.setActiveSide('axis')
  store.setPhase('movement')
  for (const spec of [
    { id: 'r-trap', hex: INTERIOR, side: 'axis' as Side, traced: false },
    { id: 'r-friend', hex: at(3), side: 'axis' as Side, traced: true },
    { id: 'r-enemy', hex: at(2), side: 'soviet' as Side, traced: false },
  ]) {
    store.units.push(
      toConsoleUnit({
        record: spec.side === 'axis' ? RECORD_AXIS : RECORD_SOVIET,
        instanceId: spec.id,
        hex: spec.hex,
        side: spec.side,
      }),
    )
  }
  for (const id of ['r-trap', 'r-friend', 'r-enemy']) {
    const live = store.units.find((unit) => unit.instanceId === id)!
    live.hasTraceSupply = id === 'r-friend'
  }
  const render = () =>
    store.breakoutCandidates
      .map((entry) => `${entry.unit.instanceId}:${entry.ok}:${entry.detail}`)
      .join('|')
  const before = render()
  /**
   * 只改**非候选**单位（追踪友军）的补给状态：索引必须重建，否则会读到旧的"有友军"结论。
   * （候选自身的字段本来就经代理读，测不出索引的失效问题。）
   */
  const friend = store.units.find((unit) => unit.instanceId === 'r-friend')!
  friend.hasTraceSupply = false
  const after = render()
  return { before, after }
}
