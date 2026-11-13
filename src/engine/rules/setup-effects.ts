import { scenarios } from '@/data'
import type { DeepReadonly, SetupEffect } from '@/data'

/**
 * 初设强制效果（`setup.effects[]`）的注册表与执行器
 *
 * ## 口径（规格 `docs/2026-11-10-剧本级初设强制效果-规格.md` §2 / §4）
 *   · 数据里**声明过**的 kind 才配 handler：当前只有 `formationDraw`（剧本 1/3/5；
 *     剧本 2/4/6 经 `sharedSetupWith` 取源）。`applyStatus`（剧本 1 混乱）因原文缺失未落库，
 *     故本注册表**不建空分支**——先有数据再扩。
 *   · 执行时机：`timing === 'afterSetupConfirm'`（初设确认后、开局前），`once === 'perGame'`。
 *   · 引擎不掷骰、不持盘面：`formationDraw` 的实际抽签与落盘由调用方（`stores/setup.ts`）
 *     注入，本模块只做「声明校验 → 按数组顺序派发 → 汇总结果」。
 *   · 失败不半执行：先整体校验，任一条不成立就一条都不执行；执行中某条失败即中止并返回 `issues`。
 */

/** 注册表里登记的 kind（与剧本数据声明的类型一一对应） */
export const SETUP_EFFECT_KINDS = ['formationDraw'] as const
export type SetupEffectKind = (typeof SETUP_EFFECT_KINDS)[number]

/** 数据层是深度只读的（`bootstrapData` 冻结），故入参一律按只读取用 */
export type SetupEffectView = DeepReadonly<SetupEffect>

/** 一条效果的结论（失败带原因码；`followUps` 是须玩家后续处理的提示） */
export interface SetupEffectOutcome {
  ok: boolean
  detail: string
  /** 失败原因码（写回执与日志） */
  reason?: string
  /** 须玩家后续处理的提示（例：旧存档西移缺落点） */
  followUps?: readonly string[]
}

export interface SetupEffectResult extends SetupEffectOutcome {
  effectId: string
  kind: SetupEffectKind
  rule: string
}

/** 校验缺口（`effectId` 指回效果条目） */
export interface SetupEffectIssue {
  effectId: string
  rule: string
  reason: string
}

/** 执行上下文：效果的实际落盘由状态层注入（方向 `stores` → `engine`） */
export interface SetupEffectContext {
  /** 编队抽签（抽签 + 西移/改模式/死亡堆处置落盘）；由 `containers.runSetupDrawsNow()` 提供 */
  formationDraw: (effect: SetupEffectView) => SetupEffectOutcome
}

export type SetupEffectHandler = (
  effect: SetupEffectView,
  ctx: SetupEffectContext,
) => SetupEffectResult

/* ────────────────────────────── 剧本声明 ────────────────────────────── */

/**
 * 该剧本声明的初设效果（数组顺序＝执行顺序；缺失＝该剧本无强制效果）
 *
 * 剧本 2/4/6 与 1/3/5 共用初设 ⇒ 本剧本未声明时取 `sharedSetupWith` 持有者的声明
 * （与 `setupSourceOf` / `formationDrawOf` 同一口径，不另立一份剧本映射）。
 */
export function setupEffectsOf(scenarioId: string): readonly SetupEffectView[] {
  const own = scenarios.scenarios.find((scenario) => scenario.id === scenarioId)
  if (own?.setup.effects !== undefined) return own.setup.effects
  const holder = scenarios.scenarios.find(
    (scenario) =>
      scenario.setup.effects !== undefined &&
      scenario.sharedSetupWith?.includes(scenarioId) === true,
  )
  return holder?.setup.effects ?? []
}

/** 该剧本声明的某类效果（取第一条；无则 null） */
export function setupEffectOf(scenarioId: string, kind: SetupEffectKind): SetupEffectView | null {
  return setupEffectsOf(scenarioId).find((effect) => effect.kind === kind) ?? null
}

/* ────────────────────────────── 校验 ────────────────────────────── */

/** 校验所需的盘面外事实（全部可选；缺项只跳过对应核对，不臆造） */
export interface SetupEffectFacts {
  /** 引擎按名单取池后的池规模（`axisDrawPool(...).length`） */
  poolSize?: number
  /** `formations.json` 已登记的编队 id（核对名单成员是否可解析） */
  knownFormationIds?: ReadonlySet<string>
}

/**
 * 效果的声明校验（执行前一次性跑完）
 *
 * 只核**数据自身是否自洽**（池规模/名单/组参数），不代替玩家决定、不触碰盘面。
 */
export function validateSetupEffects(
  effects: readonly SetupEffectView[],
  facts: SetupEffectFacts = {},
): readonly SetupEffectIssue[] {
  const issues: SetupEffectIssue[] = []
  const seenIds = new Set<string>()
  for (const effect of effects) {
    if (seenIds.has(effect.id))
      issues.push({
        effectId: effect.id,
        rule: effect.rule,
        reason: `effects.id 重复：${effect.id}`,
      })
    seenIds.add(effect.id)

    if (effect.pool !== effect.poolFormations.length) {
      issues.push({
        effectId: effect.id,
        rule: effect.rule,
        reason: `池规模与名单不一致：pool=${effect.pool}，poolFormations=${effect.poolFormations.length}`,
      })
    }
    if (facts.poolSize !== undefined && facts.poolSize !== effect.pool) {
      issues.push({
        effectId: effect.id,
        rule: effect.rule,
        reason: `剧本声明的池 ${effect.pool} 与引擎按名单取池 ${facts.poolSize} 不一致`,
      })
    }
    const duplicates = effect.poolFormations.filter(
      (formationId, index) => effect.poolFormations.indexOf(formationId) !== index,
    )
    if (duplicates.length > 0) {
      issues.push({
        effectId: effect.id,
        rule: effect.rule,
        reason: `入池名单有重复编队：${[...new Set(duplicates)].join('、')}`,
      })
    }
    if (facts.knownFormationIds !== undefined) {
      const unknown = effect.poolFormations.filter(
        (formationId) => !facts.knownFormationIds!.has(formationId),
      )
      if (unknown.length > 0) {
        issues.push({
          effectId: effect.id,
          rule: effect.rule,
          reason: `入池名单含 formations.json 未登记的编队：${unknown.join('、')}`,
        })
      }
    }
    const drawCount = effect.groups.reduce((sum, group) => sum + group.count, 0)
    if (drawCount > effect.pool) {
      issues.push({
        effectId: effect.id,
        rule: effect.rule,
        reason: `各组抽取数合计 ${drawCount} 超过入杯数 ${effect.pool}`,
      })
    }
    for (const group of effect.groups) {
      if (group.kind === 'shiftWest' && (group.shiftHexes ?? 0) <= 0) {
        issues.push({
          effectId: effect.id,
          rule: group.rule,
          reason: `shiftWest 组缺西移格数（${group.label}）`,
        })
      }
    }
  }
  return issues
}

/* ────────────────────────────── 处理器 ────────────────────────────── */

/**
 * `formationDraw`：把声明原样交给状态层执行
 *
 * 抽取/西移/改模式/死亡堆处置的算法在 `stores/containers.ts`（`runSetupDrawsNow`），
 * 本处理器不重写、不改判，只负责把结果折成统一回执。
 */
function applyFormationDraw(effect: SetupEffectView, ctx: SetupEffectContext): SetupEffectResult {
  const outcome = ctx.formationDraw(effect)
  return {
    effectId: effect.id,
    kind: 'formationDraw',
    rule: effect.rule,
    ok: outcome.ok,
    detail: outcome.detail,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.followUps === undefined ? {} : { followUps: outcome.followUps }),
  }
}

/** 已声明类型 → 处理器（新增类型前必须先有剧本数据，见模块头） */
export const SETUP_EFFECT_HANDLERS: Readonly<Record<SetupEffectKind, SetupEffectHandler>> = {
  formationDraw: applyFormationDraw,
}

/* ────────────────────────────── 执行 ────────────────────────────── */

export interface RunSetupEffectsResult {
  ok: boolean
  /** 已执行效果的结论（失败时含失败那条；校验失败时为空＝一条都没执行） */
  executed: readonly SetupEffectResult[]
  issues: readonly SetupEffectIssue[]
}

/**
 * 按数组顺序执行 `effects[]`
 *
 * 事务性：**先整体校验，再开始执行**——任一条声明不成立即整体不执行（不半执行）；
 * 执行中某条失败立即中止，返回已执行的结论与失败原因（状态层的回滚由调用方负责）。
 */
export function runSetupEffects(
  effects: readonly SetupEffectView[],
  ctx: SetupEffectContext,
  facts: SetupEffectFacts = {},
): RunSetupEffectsResult {
  const invalid = validateSetupEffects(effects, facts)
  if (invalid.length > 0) return { ok: false, executed: [], issues: invalid }

  const executed: SetupEffectResult[] = []
  for (const effect of effects) {
    const result = SETUP_EFFECT_HANDLERS[effect.kind](effect, ctx)
    executed.push(result)
    if (!result.ok) {
      return {
        ok: false,
        executed,
        issues: [
          {
            effectId: result.effectId,
            rule: result.rule,
            reason: result.reason ?? result.detail,
          },
        ],
      }
    }
  }
  return { ok: true, executed, issues: [] }
}

/* ────────────────────────────── 加载期缺口（setupGaps） ────────────────────────────── */

/**
 * 初设字段缺失的登记（规格 §3.4）
 *
 * 缺字段 ⇒ **跳过该限制/效果并按注释默认值执行**，同时在加载期登记一条；
 * 这条登记不等于「剧本特殊处理」：不猜测剧本意图、不静默套用别处口径。
 * 唯一例外是抽签池名单缺失 ⇒ schema 在加载期直接拒绝（抽签无安全默认），不走本登记。
 */
export interface SetupGap {
  scenarioId: string
  /** 缺失的字段路径（如 `modeConstraints`） */
  field: string
  action: 'skip+default'
  /** 缺省口径（照规格注释写，不写规则解释） */
  note: string
}

/**
 * 该剧本在加载期应登记的初设缺口
 *
 * 只登记**真正缺的字段**：当前唯一带缺省语义的是 `setup.modeConstraints`
 * （E5 的初设模式闸门按缺省集合/`reserveMarkers`/旧 `reserveSetupForbidden` 执行）。
 * `setup.effects` 缺失＝该剧本本就没有强制效果（不是缺口）；`poolFormations` 缺失已由 schema 拒绝。
 */
export function collectSetupGaps(scenarioId: string): readonly SetupGap[] {
  const scenario = scenarios.scenarios.find((item) => item.id === scenarioId)
  if (scenario === undefined) return []
  const gaps: SetupGap[] = []
  if (scenario.setup.modeConstraints === undefined) {
    gaps.push({
      scenarioId,
      field: 'modeConstraints',
      action: 'skip+default',
      note: '未声明初设模式约束 ⇒ 允许集合＝默认（战斗/移动/预备/战略），预备上限＝reserveMarkers，不禁预备',
    })
  }
  return gaps
}

/** 缺口的一行可读文本（加载提示与首局日志同源，口径只写一处） */
export function setupGapText(gap: SetupGap): string {
  return `初设数据缺口（剧本 ${gap.scenarioId} · ${gap.field}）：${gap.note}（${gap.action}）`
}

/* ────────────────────────────── 抽签台账（随存档持久化） ────────────────────────────── */

/** 台账里的一条效果回执（只记成功执行的；失败不写台账） */
export interface SetupEffectLedgerEntry {
  effectId: string
  kind: SetupEffectKind
  rule: string
  detail: string
}

/**
 * 初设效果台账（规格 §4.3）
 *
 * `executedAt` 存在 ⇒ 按钮不出现、不重放；新局（`selectScenario`）清空。
 * 与 `units` / 抽签处置同层随存档持久化，刷新或读档后仍判「已执行」。
 */
export interface SetupEffectLedger {
  scenarioId: string
  /** 执行时间（ISO；只作「已执行」判据与回看，不参与任何规则计算） */
  executedAt: string
  entries: readonly SetupEffectLedgerEntry[]
}

/** 该剧本是否已执行过初设效果（台账按剧本隔离，换剧本不串用） */
export function setupEffectsExecuted(
  ledger: SetupEffectLedger | null | undefined,
  scenarioId: string,
): boolean {
  return ledger !== null && ledger !== undefined && ledger.scenarioId === scenarioId
}

/** 由执行器结论生成台账（仅成功时；失败返回 null，调用方回滚且不写台账） */
export function buildSetupEffectLedger(input: {
  scenarioId: string
  executedAt: string
  result: RunSetupEffectsResult
}): SetupEffectLedger | null {
  if (!input.result.ok) return null
  return {
    scenarioId: input.scenarioId,
    executedAt: input.executedAt,
    entries: input.result.executed.map((item) => ({
      effectId: item.effectId,
      kind: item.kind,
      rule: item.rule,
      detail: item.detail,
    })),
  }
}
