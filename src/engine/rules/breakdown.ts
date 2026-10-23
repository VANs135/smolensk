import { rulesConstants } from '@/data'
import type { Side } from '@/data'

import { fail, succeed, type RuleOutcome } from '../result-types'

/**
 * 拆分单位（通规 20.0 / 13.9 的拆分面）
 *
 * ## 条文索引（中文规则书 20.0）
 *   - 20.0  拆分单位是从**多军力单位**（通常是步兵师）拆出的通用单位；它是 **1RE 单位**，
 *           有的带「拆分/Brkdown」标识、有的没有；通常不受算子数量限制（玩家愿自制额外算子的话）。
 *           多军力单位通过**拆分其中一点军力**在其所在格创建拆分单位，用军力损失标记记录
 *           （本质上就像战斗损失一样）。**单位的最后一点军力永远不能创建拆分单位。**
 *   - 20.0   「**装甲**或**机械化**（3.2a）的多军力单位无法创建或吸收拆分单位。**只有「其他」类型**可以。」
 *   - 20.0a  创建时机：多军力单位在**开始移动、战后推进或战后撤退**时，可以创建一个或多个拆分单位；
 *           **只有在这些时机**才能创建。
 *   - 20.0b  只能创建 **AR 等于或小于自己**的拆分单位；只能吸收 **AR 大于或等于自己**的拆分单位。
 *   - 20.0c  创建或吸收时，多军力单位的「**标记和模式**」（如部队储备低下或 DG）必须与拆分单位**相同**。
 *   - 20.0d  减损的多军力单位在**任何阶段结束时**都必须吸收与之堆叠、且符合吸收规则的拆分单位
 *           （在 20.0b / 20.0c 的限制范围内）。**只有在这种时机**才能吸收拆分单位。
 *   - 20.0e  创建或吸收**不消耗 MP**；拆分单位可在被创建或被吸收的阶段内移动。
 *   - 20.0f  拆分单位规模 **1RE**、有一点军力；它们是**独立单位**。
 *   - 20.0g  一般来说，同一国籍的所有多军力单位使用**相同的拆分单位算子池**（单位类型不必完全匹配）；
 *           轴心国盟国（意/罗/匈）各有自己的池，既不能创建也不能吸收德军的拆分单位。
 *
 * ## 专规覆盖
 *   - 专规 **2.4**（Slow Mobilization）：被「锁定」的师**不能拆解**（拆 breakdown）。
 *   - 专规 **3.3d**：轴心国**多单位编队不能使用 Consolidation**（见 `consolidation.ts`）。
 *
 * ## 设计口径
 *   - 本模块**只判规则**、不写状态：返回母单位军力与拆分单位的落点（patches 由调用方落盘）；
 *   - 数值只取自 `rules-constants.json` 的 `breakdown` 段，无硬编码；
 *   - 「类型」判据用 3.2a 的 `combatClass`（armor / mech / other），由调用方从数据给出，不按兵种推定。
 */

/** 3.2a 的战斗类型（20.0：只有 `other` 能创建/吸收拆分单位） */
export type BreakdownClassKind = 'armor' | 'mech' | 'other'

/** 20.0a：允许创建拆分单位的三个时机（战后推进 / 战后撤退归在战斗结算内） */
export const BREAKDOWN_CREATE_TIMINGS = [
  'startMove',
  'advanceAfterCombat',
  'retreatAfterCombat',
] as const
export type BreakdownCreateTiming = (typeof BREAKDOWN_CREATE_TIMINGS)[number]

/** 20.0d：吸收的唯一时机——**任何阶段结束时** */
export const BREAKDOWN_ABSORB_TIMINGS = ['segmentEnd'] as const
export type BreakdownAbsorbTiming = (typeof BREAKDOWN_ABSORB_TIMINGS)[number]

/** 20.0：创建所需的最少母单位军力（最后一点军力永远不能创建 ⇒ ≥ 2） */
export const MIN_PARENT_STEPS_TO_CREATE = rulesConstants.breakdown.minParentStepsToCreate

/** 20.0f：拆分单位的规模（1 RE） */
export const BREAKDOWN_RE = rulesConstants.breakdown.breakdownRe

/** 20.0f：拆分单位的军力（1 点） */
export const BREAKDOWN_STEPS = rulesConstants.breakdown.breakdownSteps

/**
 * 20.0c：参与创建/吸收的一方视图
 *
 * 「标记和模式」在引擎里拆成三项可比较的状态：DG（5.10）、部队储备（12.10）、基础模式（5.4）。
 * AR 只用于 20.0b 的方向性比较，不参与「相同」判定。
 */
export interface BreakdownSideView {
  id: string
  side: Side
  /** 20.0g：国籍/池归属（德、意、罗、匈各一池；苏方单一池） */
  nationality: string
  /** 3.2a 战斗类型（20.0：只有 `other` 可参与） */
  classKind: BreakdownClassKind
  /** 行动值（20.0b） */
  ar: number
  /** 当前军力与印值军力（20.0：最后一点不能创建） */
  steps: number
  printedSteps: number
  /** 5.10 混乱 */
  dg: boolean
  /** 12.10 部队储备（null ＝ 就绪） */
  internalStocks: 'low' | 'exhausted' | null
  /** 5.4 基础模式 */
  mode: 'combat' | 'move' | 'strat' | 'reserve'
}

/** 创建拆分单位的请求（20.0 / 20.0a / 20.0b / 20.0c / 20.0g + 专规 2.4） */
export interface BreakdownCreateRequest {
  parent: BreakdownSideView
  /** 从池中取出的拆分单位（20.0g：同国籍池） */
  breakdown: BreakdownSideView
  /** 20.0a：本次创建的时机 */
  timing: BreakdownCreateTiming
  /** 20.0g：该国籍池中可用的拆分单位数量（0 ⇒ 不可创建） */
  poolCount: number
  /** 专规 2.4：母单位是否被 Slow Mobilization 锁定（锁定师不能拆解） */
  locked?: boolean
  /** 20.0e：一次创建几个（缺省 1；每个耗母单位 1 点军力） */
  count?: number
}

/** 创建结论 */
export interface BreakdownCreateResult {
  rule: string
  /** 母单位剩余军力 */
  parentStepsAfter: number
  /** 拆分单位落点即母单位所在格（20.0：在其所在格中创建） */
  count: number
  detail: string
}

/**
 * 20.0 / 20.0a–c / 20.0g + 专规 2.4：能否创建拆分单位
 *
 * 判定顺序照条文：① 类型（只有「其他」）→ ② 专规 2.4 锁定 → ③ 时机（20.0a）→ ④ 母单位军力（20.0）
 * → ⑤ AR 方向（20.0b）→ ⑥ 标记与模式相同（20.0c）→ ⑦ 池可用（20.0g）。
 */
export function planBreakdownCreate(
  input: BreakdownCreateRequest,
): RuleOutcome<BreakdownCreateResult> {
  const { parent, breakdown } = input

  // ① 20.0：装甲 / 机械化单位不能创建拆分单位
  if (parent.classKind !== 'other')
    return fail('20.0', `armorOrMechCannotBreakdown:${parent.id}:${parent.classKind}`)
  if (breakdown.classKind !== 'other')
    return fail('20.0', `armorOrMechBreakdownCounter:${breakdown.id}:${breakdown.classKind}`)

  // ② 专规 2.4：被锁的师不能拆解
  if (input.locked === true) return fail('专规 2.4', `lockedDivisionCannotBreakdown:${parent.id}`)

  // ③ 20.0a：只有开始移动 / 战后推进 / 战后撤退三个时机
  if (!(BREAKDOWN_CREATE_TIMINGS as readonly string[]).includes(input.timing))
    return fail('20.0a', `breakdownCreateNotAtAllowedTiming:${String(input.timing)}`)

  const count = Math.max(1, Math.trunc(input.count ?? 1))
  // ④ 20.0：最后一点军力永远不能创建拆分单位
  if (parent.steps - count < 1)
    return fail('20.0', `lastStepCannotCreateBreakdown:${parent.id}:${parent.steps}`)

  // ⑤ 20.0b：只能创建 AR ≤ 自己的拆分单位
  if (breakdown.ar > parent.ar)
    return fail('20.0b', `breakdownArTooHigh:${breakdown.ar}>${parent.ar}`)

  // ⑥ 20.0c：标记与模式必须相同
  const mismatch = stateMismatch(parent, breakdown)
  if (mismatch !== null) return fail('20.0c', `breakdownStateMismatch:${mismatch}`)

  // ⑦ 20.0g：池中没有可用拆分单位
  if (input.poolCount < count)
    return fail('20.0g', `breakdownPoolExhausted:${input.poolCount}<${count}`)

  return succeed('20.0', {
    rule: '20.0',
    parentStepsAfter: parent.steps - count,
    count,
    detail:
      `${parent.id} 拆出 ${count} 个拆分单位（${breakdown.id}，${BREAKDOWN_RE} RE / ${BREAKDOWN_STEPS} 军力）：` +
      `军力 ${parent.steps} → ${parent.steps - count}（20.0：如同战斗损失，不耗 MP 20.0e）；` +
      `AR ${breakdown.ar} ≤ ${parent.ar}（20.0b）、标记与模式一致（20.0c）、同国籍池（20.0g）`,
  })
}

/** 吸收拆分单位的请求（20.0b–e） */
export interface BreakdownAbsorbRequest {
  parent: BreakdownSideView
  breakdown: BreakdownSideView
  /** 20.0d：吸收的唯一时机——阶段结束时 */
  timing: BreakdownAbsorbTiming
  /** 20.0d：拆分单位须与母单位**堆叠**（同格或同一图外区域） */
  stacked: boolean
  /** 20.0d：母单位是否减损（减损者**必须**吸收） */
  parentReduced: boolean
  /** 20.0e：吸收后母单位是否仍可在本阶段移动（缺省 true） */
  mayStillMove?: boolean
}

/** 吸收结论 */
export interface BreakdownAbsorbResult {
  rule: string
  /** 母单位吸收后的军力（不得超过印值；超出部分丢失） */
  parentStepsAfter: number
  /** 是否有军力因超出印值而丢失 */
  overflowLost: number
  /** 20.0d：该吸收是否为**强制**（母单位减损即强制） */
  mandatory: boolean
  detail: string
}

/**
 * 20.0b–e：能否吸收拆分单位
 *
 * 判定：① 类型 → ② 时机（阶段结束）→ ③ 堆叠 → ④ AR 方向（母单位只能吸收 AR ≥ 自己的）→ ⑤ 标记与模式相同。
 * 20.0d 的「**必须**吸收」由返回值 `mandatory` 表达（母单位减损即强制），调用方据此在阶段末列义务。
 */
export function planBreakdownAbsorb(
  input: BreakdownAbsorbRequest,
): RuleOutcome<BreakdownAbsorbResult> {
  const { parent, breakdown } = input

  if (parent.classKind !== 'other')
    return fail('20.0', `armorOrMechCannotAbsorbBreakdown:${parent.id}:${parent.classKind}`)
  if (!(BREAKDOWN_ABSORB_TIMINGS as readonly string[]).includes(input.timing))
    return fail('20.0d', `breakdownAbsorbNotAtSegmentEnd:${String(input.timing)}`)
  if (!input.stacked) return fail('20.0d', `breakdownNotStackedWithParent:${breakdown.id}`)

  // 20.0b：只能吸收 AR ≥ 自己的拆分单位
  if (breakdown.ar < parent.ar)
    return fail('20.0b', `breakdownArTooLow:${breakdown.ar}<${parent.ar}`)

  const mismatch = stateMismatch(parent, breakdown)
  if (mismatch !== null) return fail('20.0c', `breakdownStateMismatch:${mismatch}`)

  const raw = parent.steps + breakdown.steps
  const parentStepsAfter = Math.min(parent.printedSteps, raw)
  const overflowLost = raw - parentStepsAfter
  const mandatory = input.parentReduced

  return succeed('20.0d', {
    rule: '20.0d',
    parentStepsAfter,
    overflowLost,
    mandatory,
    detail:
      `${parent.id} 吸收 ${breakdown.id}（+${breakdown.steps} 军力）：${parent.steps} → ${parentStepsAfter}` +
      (overflowLost > 0 ? `（超印值的 ${overflowLost} 点直接丢失，13.9-1）` : '') +
      `；AR ${breakdown.ar} ≥ ${parent.ar}（20.0b）、标记与模式一致（20.0c）` +
      (mandatory ? '；母单位减损 ⇒ 本阶段末**必须**吸收（20.0d）' : ''),
  })
}

/**
 * 20.0d：阶段末的**强制吸收义务**
 *
 * 「减损的多军力单位在任何阶段结束时，都必须吸收与之堆叠、且符合吸收规则的拆分单位」
 * ⇒ 对每个「减损且与合格拆分单位堆叠」的母单位给出义务（供界面与日志在阶段末逐条结清）。
 */
export function breakdownAbsorbObligations(input: {
  units: readonly BreakdownSideView[]
  /** 与给定母单位同格/同区域的拆分单位（20.0d：须堆叠） */
  breakdownsStackedWith(parentId: string): readonly BreakdownSideView[]
}): readonly { parentId: string; breakdownIds: readonly string[]; rule: string; detail: string }[] {
  const obligations: {
    parentId: string
    breakdownIds: readonly string[]
    rule: string
    detail: string
  }[] = []
  for (const parent of input.units) {
    if (parent.classKind !== 'other') continue
    if (parent.steps >= parent.printedSteps) continue // 未减损 ⇒ 不强制
    const eligible = input
      .breakdownsStackedWith(parent.id)
      .filter(
        (breakdown) =>
          breakdown.classKind === 'other' &&
          breakdown.ar >= parent.ar &&
          stateMismatch(parent, breakdown) === null,
      )
    if (eligible.length === 0) continue
    obligations.push({
      parentId: parent.id,
      breakdownIds: eligible.map((breakdown) => breakdown.id),
      rule: '20.0d',
      detail: `${parent.id} 减损（${parent.steps}/${parent.printedSteps}）⇒ 阶段末必须吸收堆叠的拆分单位 ${eligible
        .map((breakdown) => breakdown.id)
        .join('、')}（20.0d）`,
    })
  }
  return obligations
}

/** 20.0c：标记与模式是否**相同**（返回不同项的描述；相同即 null） */
function stateMismatch(parent: BreakdownSideView, breakdown: BreakdownSideView): string | null {
  if (parent.dg !== breakdown.dg) return `dg:${String(parent.dg)}≠${String(breakdown.dg)}`
  if ((parent.internalStocks ?? 'ready') !== (breakdown.internalStocks ?? 'ready'))
    return `internalStocks:${parent.internalStocks ?? 'ready'}≠${breakdown.internalStocks ?? 'ready'}`
  if (parent.mode !== breakdown.mode) return `mode:${parent.mode}≠${breakdown.mode}`
  return null
}
