/**
 * 训练投影的稳定 ID 表
 *
 * 现有 `instanceId` / `dump.id` 由 `createId` 生成（含 `Date.now()` 与进程内递增序号），
 * 只适合同一进程内定位。训练数据要跨进程同盘面同字节，因此这里按「稳定库键 + 首次出现序号」
 * 建立别名：
 *
 *   ground  u:<side>:<unitId>:<copy#>
 *   air     a:<side>:<aircraftId>:<copy#>
 *   dump    d:<side>:<c.r>:<sp>:<t>:<copy#>
 *   base    b:<side>:<c.r>:<copy#>
 *
 * ★ 别名只用于训练投影；执行动作仍用原始 action，由候选表持有 key → action 的映射。
 * ★ 新增实体必须在下一次 observe 前 `refresh()`，否则动作 key 会退回原始实例 id。
 */

import type { AiContext } from '../driver'
import type { ActionIdResolver } from './action-key'
import type { TrainingEntity } from './contract'

type Workbench = AiContext['workbench']

interface RegisterInput {
  raw: string
  kind: 'u' | 'a' | 'd' | 'b' | 'f'
  side: string
  stableKey: string
}

export interface TrainingIdentity {
  /** 刷新实体别名表（每次 reset/step 后、observe 前调用） */
  refresh(): void
  /** 原始 ID → 稳定别名；未知值原样返回（不用于决定训练动作） */
  stableOf(raw: string): string
  /** 别名表只读视图（调试/测试用） */
  readonly aliases: ReadonlyMap<string, string>
  /** 给 canonical action key 的解析端口 */
  readonly actionIds: ActionIdResolver
  /** 当前盘面的实体 roster（已按稳定别名排序） */
  entities(): TrainingEntity[]
}

const KIND_ORDER: Record<TrainingEntity['kind'], number> = {
  ground: 0,
  air: 1,
  dump: 2,
  base: 3,
}

const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function hexKey(hex: { col: number; row: number }): string {
  return `${String(hex.col)}.${String(hex.row)}`
}

export function createTrainingIdentity(ctx: AiContext): TrainingIdentity {
  const w: Workbench = ctx.workbench
  const aliases = new Map<string, string>()
  const counters = new Map<string, number>()

  function register(input: RegisterInput): string {
    const existing = aliases.get(input.raw)
    if (existing !== undefined) return existing
    const counterKey = `${input.kind}|${input.side}|${input.stableKey}`
    const next = (counters.get(counterKey) ?? 0) + 1
    counters.set(counterKey, next)
    const alias = `${input.kind}:${input.side}:${input.stableKey}:${String(next)}`
    aliases.set(input.raw, alias)
    return alias
  }

  function refresh(): void {
    // 先地面/飞机，再补给站/基地；顺序只影响同一轮新增实体的别名序号，不改变任何规则判断。
    for (const unit of w.units) {
      register({
        raw: unit.instanceId,
        kind: 'u',
        side: unit.side,
        stableKey: unit.unitId,
      })
    }
    for (const air of w.airUnits) {
      register({
        raw: air.instanceId,
        kind: 'a',
        side: air.side,
        stableKey: air.aircraftId,
      })
    }
    for (const dump of w.allSpDumps) {
      register({
        raw: dump.id,
        kind: 'd',
        side: dump.side,
        stableKey: `${hexKey(dump.hex)}:${String(dump.sp)}:${String(dump.t)}`,
      })
    }
    for (const base of w.airBases) {
      register({
        raw: base.id,
        kind: 'b',
        side: base.side,
        stableKey: hexKey(base.hex),
      })
    }
  }

  function stableOf(raw: string): string {
    return aliases.get(raw) ?? raw
  }

  const actionIds: ActionIdResolver = {
    unit: stableOf,
    // 运输点在盘面上就是 ConsoleUnit，和地面/运输单位共用一张别名表。
    point: stableOf,
    dump: stableOf,
    base: stableOf,
    // 编队 id 来自剧本数据，本身稳定；加前缀避免和其它实体别名撞形。
    formation: (id) => `f:${id}`,
  }

  function entities(): TrainingEntity[] {
    refresh()
    const out: TrainingEntity[] = []
    for (const unit of w.units) {
      out.push({
        id: stableOf(unit.instanceId),
        kind: 'ground',
        side: unit.side,
        libraryId: unit.unitId,
        label: unit.name,
        hex: { col: unit.hex.col, row: unit.hex.row },
        steps: unit.steps,
        mode: unit.mode.mode,
        re: unit.re,
      })
    }
    for (const air of w.airUnits) {
      out.push({
        id: stableOf(air.instanceId),
        kind: 'air',
        side: air.side,
        libraryId: air.aircraftId,
        label: air.name,
        hex: { col: air.hex.col, row: air.hex.row },
        steps: air.steps,
        airStatus: air.airStatus,
      })
    }
    for (const dump of w.allSpDumps) {
      out.push({
        id: stableOf(dump.id),
        kind: 'dump',
        side: dump.side,
        label: `${hexKey(dump.hex)} · ${String(dump.sp)}SP/${String(dump.t)}T`,
        hex: { col: dump.hex.col, row: dump.hex.row },
        sp: dump.sp,
        t: dump.t,
      })
    }
    for (const base of w.airBases) {
      out.push({
        id: stableOf(base.id),
        kind: 'base',
        side: base.side,
        label: `${hexKey(base.hex)} 空军基地`,
        hex: { col: base.hex.col, row: base.hex.row },
        level: base.level,
        isAirstrip: base.isAirstrip === true,
      })
    }
    return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || cmpText(a.id, b.id))
  }

  refresh()

  return {
    refresh,
    stableOf,
    aliases,
    actionIds,
    entities,
  }
}
