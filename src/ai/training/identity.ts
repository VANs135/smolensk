/**
 * 训练投影的稳定 ID 表
 *
 * 现有 `instanceId` / `dump.id` 由 `createId` 生成（含 `Date.now()` 与进程内递增序号），
 * 只适合同一进程内定位。训练数据要跨进程同盘面同字节，因此这里按「稳定库键 + 首次出现序号」
 * 建立别名：
 *
 *   ground  u:<side>:<unitId>:<copy#>
 *   air     a:<side>:<aircraftId>:<copy#>
 *   dump    d:<side>:ground:<c.r>:<copy#>（地面站）/ d:<side>:carrier:<unit alias>:<copy#>（装载点）
 *   base    b:<side>:<c.r>:<copy#>
 *
 * ★ 别名只用于训练投影；执行动作仍用原始 action，由候选表持有 key → action 的映射。
 * ★ 新增实体必须在下一次 observe 前 `refresh()`，否则动作 key 会退回原始实例 id。
 * ★ 死亡堆与盘面单位共用 `instanceId` 命名空间，也必须登记；`rebuild` 的 unitId 来自死亡堆。
 * ★ 补给站别名不含 `sp/t`：持仓变化不改站身份；装载点在运输点上的 SP 跟随承运单位。
 * ★ 地面单位 / 空军基地可能共用同一个原始 id（如 `neutral-airbase` 既是地面堆叠，也是基地）；
 *   故别名按 kind 分桶，`baseId` / `dumpId` 字段由 `aliasFor()` 分流，避免同一别名覆盖两种实体。
 */

import type { AiContext } from '../driver'
import type { ActionIdResolver } from './action-key'
import type { TrainingEntity } from './contract'

type Workbench = AiContext['workbench']
type Bucket = 'unit' | 'dump' | 'base'

interface RegisterInput {
  raw: string
  kind: 'u' | 'a' | 'd' | 'b' | 'f'
  side: string
  stableKey: string
}

export interface TrainingIdentity {
  /** 刷新实体别名表（每次 reset/step 后、observe 前调用） */
  refresh(): void
  /** 原始地面/飞机/运输点 ID → 稳定别名；未知值原样返回 */
  stableOf(raw: string): string
  /** 原始基地 ID → `b:` 稳定别名（与地面单位同名 ID 不冲突） */
  baseOf(raw: string): string
  /** 原始补给站 ID → `d:` 稳定别名 */
  dumpOf(raw: string): string
  /** 按字段名把原始 id 分流到 unit/dump/base（观测序列化用） */
  aliasFor(field: string, raw: string): string
  /** 单位/补给站别名只读视图（调试/测试用；基地另有独立桶） */
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

function looksLikeBase(field: string): boolean {
  return /base/i.test(field)
}

function looksLikeDump(field: string): boolean {
  return /dump/i.test(field)
}

function looksLikeUnit(field: string): boolean {
  return /(unit|point|aircraft|selected|participating|keep|remove).*ids?$/i.test(field)
}

export function createTrainingIdentity(ctx: AiContext): TrainingIdentity {
  const w: Workbench = ctx.workbench
  const unitAliases = new Map<string, string>()
  const dumpAliases = new Map<string, string>()
  const baseAliases = new Map<string, string>()
  const aliases = new Map<string, string>()
  const counters = new Map<string, number>()

  function register(input: RegisterInput, bucket: Bucket, target: Map<string, string>): string {
    const existing = target.get(input.raw)
    if (existing !== undefined) return existing
    const counterKey = `${input.kind}|${input.side}|${input.stableKey}`
    const next = (counters.get(counterKey) ?? 0) + 1
    counters.set(counterKey, next)
    const alias = `${input.kind}:${input.side}:${input.stableKey}:${String(next)}`
    target.set(input.raw, alias)
    // 调试视图保留「kind + 原始 id」键，基地不会覆盖同名地面单位。
    aliases.set(bucket === 'base' ? `base:${input.raw}` : input.raw, alias)
    return alias
  }

  function refresh(): void {
    // 先地面/飞机，再死亡堆/补给站/基地；顺序只影响同一轮新增实体的别名序号，不改变任何规则判断。
    for (const unit of w.units) {
      register(
        {
          raw: unit.instanceId,
          kind: 'u',
          side: unit.side,
          stableKey: unit.unitId,
        },
        'unit',
        unitAliases,
      )
    }
    for (const air of w.airUnits) {
      register(
        {
          raw: air.instanceId,
          kind: 'a',
          side: air.side,
          stableKey: air.aircraftId,
        },
        'unit',
        unitAliases,
      )
    }
    /*
     * 死亡堆与盘面单位共用 `instanceId` 命名空间，但不在 `w.units` / `w.airUnits` 里。
     * `rebuild` 的 `unitId` 直接来自死亡堆；不先登记就只能回退原始 `instanceId`，
     * 训练 key 会跨进程分叉。地面/空军都按各自库键登记到 unit 别名表。
     */
    for (const dead of w.deadPile) {
      if ('aircraftId' in dead) {
        register(
          {
            raw: dead.instanceId,
            kind: 'a',
            side: dead.side,
            stableKey: dead.aircraftId,
          },
          'unit',
          unitAliases,
        )
      } else {
        register(
          {
            raw: dead.instanceId,
            kind: 'u',
            side: dead.side,
            stableKey: dead.unitId,
          },
          'unit',
          unitAliases,
        )
      }
    }
    for (const dump of w.allSpDumps) {
      /*
       * 补给站身份不能含 `sp/t`：扣款、装载、拆分都会改持仓，但仍是同一个站。
       * 地面站按 `side + hex` 分桶；装在运输点上的 SP 跟着承运单位走，
       * 用承运单位的稳定别名，避免车一动就换身份。
       */
      const stableKey =
        dump.carriedBy === undefined
          ? `ground:${hexKey(dump.hex)}`
          : `carrier:${stableOf(dump.carriedBy)}`
      register(
        {
          raw: dump.id,
          kind: 'd',
          side: dump.side,
          stableKey,
        },
        'dump',
        dumpAliases,
      )
    }
    for (const base of w.airBases) {
      register(
        {
          raw: base.id,
          kind: 'b',
          side: base.side,
          stableKey: hexKey(base.hex),
        },
        'base',
        baseAliases,
      )
    }
  }

  function stableOf(raw: string): string {
    return unitAliases.get(raw) ?? dumpAliases.get(raw) ?? raw
  }

  function baseOf(raw: string): string {
    return baseAliases.get(raw) ?? raw
  }

  function dumpOf(raw: string): string {
    return dumpAliases.get(raw) ?? raw
  }

  function aliasFor(field: string, raw: string): string {
    if (looksLikeBase(field)) return baseOf(raw)
    if (looksLikeDump(field)) return dumpAliases.get(raw) ?? raw
    if (looksLikeUnit(field)) return stableOf(raw)
    // 无字段线索的字符串只走单位/补给站聚合表；基地必须由字段名分流。
    return unitAliases.get(raw) ?? dumpAliases.get(raw) ?? raw
  }

  const actionIds: ActionIdResolver = {
    unit: stableOf,
    // 运输点在盘面上就是 ConsoleUnit，和地面/运输单位共用一张别名表。
    point: stableOf,
    dump: dumpOf,
    base: baseOf,
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
        id: dumpOf(dump.id),
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
        id: baseOf(base.id),
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
    baseOf,
    dumpOf,
    aliasFor,
    aliases,
    actionIds,
    entities,
  }
}
