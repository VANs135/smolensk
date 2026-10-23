import { fail, succeed, type RuleOutcome } from '../result-types'

/**
 * 单位的合并（通规 13.9）
 *
 * ## 条文索引（中文规则书 13.9）
 *   「玩家可在**他的增援阶段**中合并瘫痪的部队。单位即使与敌方单位**相邻**或**断补**，也可进行合并。
 *     被交换或合并的地面单位必须在**算子两面都完全相同**，而且参与合并的单位**不能是部队储备低下或耗尽**的，
 *     也**不能是 DG 的**。」
 *
 *   合并有四种类型：
 *     1) **多军力单位**：两个单位必须在**同一格**内（或地图外区域内）。移除其中一个单位，
 *        并更改剩余那个单位的军力损失，以体现它增加的军力。任何单位都不能以这种方式**超出其完整的军力**，
 *        超出的军力**直接丢失**。
 *     2) **多单位编队**：玩家可将**任何单位（包括编内卡车）**替换为**死亡堆中**、所属**多单位编队不同**的
 *        同等单位。模式和标记保持不变，编内卡车上装载的 SP 仍保持装载状态（这样可以将补给传递给另一个师）。
 *     3) **独立单位**（包括常规的运输点数）可以转换为一个**多单位编队**的一部分（与第 2 项类似），
 *        但多单位编队中的单位**永远不能**转换为独立单位。
 *     4) **飞机**：如果两架**类型、数值和状态（非激活或激活）相同**的军力减损的飞机位于同一格内
 *        （或地图外区域内），则可合并为一个完整军力的飞机。这可以在**任何阶段**进行（不仅仅是增援阶段）。
 *
 * ## 专规覆盖
 *   - 专规 **3.3d**：轴心国**多单位编队不能使用 Consolidation**（OCS 13.9）。
 *
 * ## 设计口径
 *   - 本模块**只判规则**、不写状态：返回「移除谁、留下谁、军力改到多少」的结论，由调用方落盘；
 *   - 「两面完全相同」用调用方给出的 `facesIdentical`（数据层比对结果），不在引擎里比对算子文本。
 */

/** 13.9 的四种合并类型 */
export type ConsolidationKind =
  'multiStepUnits' | 'formations' | 'independentsIntoFormation' | 'aircraft'

/** 13.9 全文中「增援阶段」是 1–3 项的时机；第 4 项（飞机）可在**任何阶段**进行 */
export const CONSOLIDATION_PHASE_KINDS: readonly ConsolidationKind[] = [
  'multiStepUnits',
  'formations',
  'independentsIntoFormation',
]

/** 13.9：算子一面的印值（用于判「两个单位两面都完全相同」） */
export interface ConsolidationFaceView {
  attack: number
  ar: number
  ma: number
  barrage?: number
}

/** 13.9 参与合并的地面单位视图 */
export interface ConsolidationGroundView {
  id: string
  /** 13.9：**战斗面**印值 */
  combatFace: ConsolidationFaceView
  /** 13.9：**移动面**印值 */
  moveFace: ConsolidationFaceView
  /** 13.9：部队储备不得为 low / exhausted */
  internalStocks: 'low' | 'exhausted' | null
  /** 13.9：不得为 DG */
  dg: boolean
  /** 13.9-1：同一格（或同一图外区域）判定键 */
  locationKey: string
  /** 13.9-1：当前军力与印值军力 */
  steps: number
  printedSteps: number
  /** 13.9-2/3：所属多单位编队（null ＝ 独立单位） */
  formationId: string | null
  /** 13.9-2：是否编内卡车（其装载的 SP 保持装载） */
  isOrganicTruck?: boolean
  /** 13.9-2：是否在死亡堆中（替换来源必须来自死亡堆） */
  inDeadPile?: boolean
}

/**
 * 13.9：两个地面单位是否「**算子两面都完全相同**」
 *
 * 条文说的是**两个单位之间**的两面印值一致（不是同一个单位的两面互相比），故逐面逐项比对。
 */
export function facesIdentical(a: ConsolidationGroundView, b: ConsolidationGroundView): boolean {
  return faceEquals(a.combatFace, b.combatFace) && faceEquals(a.moveFace, b.moveFace)
}

function faceEquals(a: ConsolidationFaceView, b: ConsolidationFaceView): boolean {
  return (
    a.attack === b.attack &&
    a.ar === b.ar &&
    a.ma === b.ma &&
    (a.barrage ?? null) === (b.barrage ?? null)
  )
}

/** 13.9-4 参与的飞机视图 */
export interface ConsolidationAircraftView {
  id: string
  /** 13.9-4：类型与数值相同（由调用方按机型记录比对后给出） */
  sameTypeAndValues: boolean
  /** 13.9-4：状态（非激活/激活）相同 */
  sameStatus: boolean
  /** 13.9-4：军力减损 */
  reduced: boolean
  locationKey: string
  steps: number
  printedSteps: number
}

/** 合并请求 */
export type ConsolidationRequest =
  | {
      kind: 'multiStepUnits'
      /** 13.9 总则：是否在本方增援阶段 */
      phaseIsReinforcement: boolean
      /** 专规 3.3d：轴心国多单位编队不得使用 Consolidation */
      axisFormationConsolidation?: boolean
      keep: ConsolidationGroundView
      remove: ConsolidationGroundView
    }
  | {
      kind: 'formations' | 'independentsIntoFormation'
      phaseIsReinforcement: boolean
      /** 专规 3.3d：本项若涉及轴心国多单位编队则非法 */
      axisFormationConsolidation?: boolean
      /** 场上被替换的单位（13.9-3 的独立单位，或 13.9-2 的编队内单位） */
      replaced: ConsolidationGroundView
      /** 死亡堆中用来替换的单位（13.9-2：须属**不同的**多单位编队） */
      replacement: ConsolidationGroundView
    }
  | {
      kind: 'aircraft'
      keep: ConsolidationAircraftView
      remove: ConsolidationAircraftView
      /** 13.9-4：可在**任何阶段**进行 ⇒ 此处不判阶段 */
    }

/** 合并结论（由调用方落盘） */
export interface ConsolidationPlan {
  rule: string
  /** 要移除的单位（军力并入 keep 后原算子移出游戏 / 回池） */
  removeIds: readonly string[]
  /** 保留单位的军力变化 */
  keepStepsAfter: number
  /** 13.9-1：因超出印值而直接丢失的军力 */
  overflowLost: number
  /** 13.9-2/3：不发生军力合并（换装），仅替换身份 */
  replacesIdentity: boolean
  detail: string
}

/**
 * 13.9（含专规 3.3d）：合并判定
 *
 * 通用前提（1–3 项）：**本方增援阶段**、两面完全相同、非 Low/Exhausted、非 DG；
 * 第 4 项（飞机）：不受阶段与上述标记限制，只要求类型/数值/状态相同且都减损。
 */
export function planConsolidation(input: ConsolidationRequest): RuleOutcome<ConsolidationPlan> {
  if (input.kind === 'aircraft') {
    const { keep, remove } = input
    if (keep.id === remove.id) return fail('13.9', `sameUnit:${keep.id}`)
    if (keep.locationKey !== remove.locationKey)
      return fail('13.9', `aircraftNotSameHexOrBox:${keep.id}:${remove.id}`)
    if (!keep.sameTypeAndValues || !remove.sameTypeAndValues)
      return fail('13.9', `aircraftTypeOrValuesDiffer:${keep.id}:${remove.id}`)
    if (!keep.sameStatus || !remove.sameStatus)
      return fail('13.9', `aircraftStatusDiffer:${keep.id}:${remove.id}`)
    if (!keep.reduced || !remove.reduced)
      return fail('13.9', `aircraftNotReduced:${keep.id}:${remove.id}`)
    const raw = keep.steps + remove.steps
    const keepStepsAfter = Math.min(keep.printedSteps, raw)
    return succeed('13.9', {
      rule: '13.9',
      removeIds: [remove.id],
      keepStepsAfter,
      overflowLost: raw - keepStepsAfter,
      replacesIdentity: false,
      detail:
        `飞机合并（13.9-4）：${remove.id} 并入 ${keep.id} ⇒ 军力 ${keep.steps} → ${keepStepsAfter}` +
        `（可在任何阶段进行；类型/数值/状态相同且均减损）`,
    })
  }

  // 1–3 项：时机 = 本方增援阶段
  if (!input.phaseIsReinforcement)
    return fail('13.9', `consolidationOnlyInReinforcementPhase:${input.kind}`)
  // 专规 3.3d：轴心国多单位编队不得使用 Consolidation
  if (input.axisFormationConsolidation === true)
    return fail('专规 3.3d', 'axisFormationCannotConsolidate')

  if (input.kind === 'multiStepUnits') {
    const { keep, remove } = input
    if (keep.id === remove.id) return fail('13.9', `sameUnit:${keep.id}`)
    if (keep.locationKey !== remove.locationKey)
      return fail('13.9', `unitsNotSameHexOrBox:${keep.id}:${remove.id}`)
    const common = groundPrerequisites(keep)
    if (common !== null) return common
    const removeCheck = groundPrerequisites(remove)
    if (removeCheck !== null) return removeCheck
    if (!facesIdentical(keep, remove))
      return fail('13.9', `facesNotIdentical:${keep.id}:${remove.id}`)

    const raw = keep.steps + remove.steps
    const keepStepsAfter = Math.min(keep.printedSteps, raw)
    return succeed('13.9', {
      rule: '13.9',
      removeIds: [remove.id],
      keepStepsAfter,
      overflowLost: raw - keepStepsAfter,
      replacesIdentity: false,
      detail:
        `13.9-1 多军力单位合并：${remove.id} 并入 ${keep.id} ⇒ 军力 ${keep.steps} → ${keepStepsAfter}` +
        (raw > keepStepsAfter ? `（超印值的 ${raw - keepStepsAfter} 点直接丢失）` : '') +
        `（13.9：相邻敌方或断补均可合并）`,
    })
  }

  // 13.9-2 多单位编队 / 13.9-3 独立单位并入编队
  const { replaced, replacement } = input
  if (replaced.id === replacement.id) return fail('13.9', `sameUnit:${replaced.id}`)
  const replacedCheck = groundPrerequisites(replaced)
  if (replacedCheck !== null) return replacedCheck
  if (!facesIdentical(replaced, replacement))
    return fail('13.9', `facesNotIdentical:${replaced.id}:${replacement.id}`)
  if (replacement.internalStocks !== null)
    return fail('13.9', `replacementHasLowStocks:${replacement.id}`)
  if (replacement.dg) return fail('13.9', `replacementDg:${replacement.id}`)
  if (replacement.inDeadPile !== true)
    return fail('13.9', `replacementNotInDeadPile:${replacement.id}`)

  if (input.kind === 'formations') {
    // 13.9-2：替换来源须属**不同的**多单位编队
    if (replacement.formationId === null)
      return fail('13.9', `replacementNotFormationUnit:${replacement.id}`)
    if (replaced.formationId === null)
      return fail('13.9', `replacedNotFormationUnit:${replaced.id}`)
    if (replaced.formationId === replacement.formationId)
      return fail('13.9', `sameFormation:${replaced.formationId}`)
    return succeed('13.9', {
      rule: '13.9',
      removeIds: [replacement.id],
      keepStepsAfter: replaced.steps,
      overflowLost: 0,
      replacesIdentity: true,
      detail:
        `13.9-2 编队间换装：${replaced.id}（${replaced.formationId}）↔ 死亡堆中的 ${replacement.id}` +
        `（${replacement.formationId}）；模式与标记保持不变` +
        (replaced.isOrganicTruck === true ? '；编内卡车装载的 SP 保持装载（13.9-2）' : ''),
    })
  }

  // 13.9-3：独立单位 → 编队；编队单位**永远不能**转为独立单位
  if (replaced.formationId !== null)
    return fail('13.9', `formationUnitCannotBecomeIndependent:${replaced.id}`)
  if (replacement.formationId === null)
    return fail('13.9', `replacementNotFormationUnit:${replacement.id}`)
  return succeed('13.9', {
    rule: '13.9',
    removeIds: [replacement.id],
    keepStepsAfter: replaced.steps,
    overflowLost: 0,
    replacesIdentity: true,
    detail:
      `13.9-3 独立单位并入编队：${replaced.id}（独立）↔ 死亡堆中的编队单位 ${replacement.id}` +
      `（${replacement.formationId}）；反方向（编队 → 独立）永不许可`,
  })
}

/** 13.9 总则对地面单位的共同前提（返回失败即不可参与合并） */
function groundPrerequisites(unit: ConsolidationGroundView): ReturnType<typeof fail> | null {
  if (unit.internalStocks !== null)
    return fail('13.9', `lowStocksCannotConsolidate:${unit.id}:${unit.internalStocks}`)
  if (unit.dg) return fail('13.9', `dgCannotConsolidate:${unit.id}`)
  return null
}
