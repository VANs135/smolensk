import type { HexRef, Side } from '@/data'

import { fail, succeed, type RuleOutcome } from '../result-types'
import type { GamePhase } from '../state-types'

/**
 * H 清理阶段的**通用自动清理**（2.2 末段 + 5.9 / 5.10 / 12.5d / 10.0c-C）
 *
 * ## 条文索引
 *   - **2.2**（流程表·清理阶段）：「当前阶段玩家为他的单位移除所有**进击**和**混乱(DG)**标记，
 *     并**移除(或翻面)他所有的燃料标记**。移除由**非阶段玩家**生成的**运输破坏标记**。」
 *   - **5.9**（进击）：「在清理阶段，移除所有进击标记。此时这些单位处于战斗模式或移动模式，
 *     具体取决于它们**当前的朝向**」⇒ 只摘标记，**不改朝向**。
 *   - **5.10**（混乱 DG）：同上，「从**当前阶段玩家**的单位上移除所有 DG 标记」。
 *   - **12.5d**（燃料）：「当前阶段玩家必须在自己的清理阶段移除他**指挥部的燃料已补给标记**，
 *     并将他的**编队标记翻面至燃料未补给的一面**」——两种标记都表示 12.5c-A/B 的
 *     「持续到下一个友方清理阶段」，故在本段一并失效（12.5c-C 的单单位法本就更短，见下）。
 *   - **10.0c-C / 14.8c**（运输破坏）：「运输破坏标记会在**下一个敌方的**清理阶段移除」
 *     ⇒ 本段玩家移除的是**对手放下的**那些标记。
 *
 * ## 本作的数据模型与两处口径（如实说明，不静默改规则）
 *   1. **燃料**：本作把「燃料已补给」记为单位上的 `fuelled` 布尔量，另以 `fuelMethod` 记住**加油方法**
 *      （12.5c-A 编队法 / 12.5c-B HQ 法 / 12.5c-C 单单位法），因为三者的**持续期不同**：
 *      编队法/HQ 法「持续到下一个友方清理阶段」（12.5d 明文如此，正是本段要摘的）；
 *      单单位法「只在**当前阶段**有效」⇒ 更早，在换阶段时即失效（判据见 fuel.ts 的
 *      `fuelExpiresOnPhaseChange`），随之的清理由状态层在换段时完成，本段只兜底。
 *   2. **运输破坏标记**：本作只登记「标记 + 放置方」（`side`），故本段按「放置方 ≠ 本段玩家」
 *      移除。3.3b 的苏军游击队标记另有一套**放置**判据（需求未满足即立即放置），其**移除**
 *      与 2.2 同一条出路，故本泛化实现一并覆盖。
 *
 * 引擎不写状态（CODE_SPEC §3.1）：本模块只产出「清哪些标记」的补丁清单。
 */

/** 允许执行清理的段（2.2：清理阶段） */
export const CLEANUP_PHASE: GamePhase = 'cleanUp'

/* ────────────────────────────── 输入视图 ────────────────────────────── */

/** 参与清理的单位视图（只取判定用到的字段） */
export interface CleanUpUnitView {
  id: string
  side: Side
  /** 5.10：是否处于 DG 模式 */
  dg: boolean
  /** 5.9：是否有进击标记 */
  exploit: boolean
  /** 12.5：是否处于「燃料已补给」（编队标记 / HQ 标记 / 单单位法） */
  fuelled: boolean
}

/** 运输破坏标记视图（**放置方**是关键：移除的是对手放下的） */
export interface CleanUpMarkerView {
  id: string
  hex: HexRef
  /** 放置该标记的一方（10.0c-C：需 `*` 结果；14.8：运输破坏任务） */
  side: Side
}

/* ────────────────────────────── 输出计划 ────────────────────────────── */

/** 单个单位的清理补丁（只列**确有标记可摘**的单位） */
export interface CleanUpUnitPatch {
  unitId: string
  /** 5.10：摘掉 DG 标记（朝向不变） */
  clearDg: boolean
  /** 5.9：摘掉进击标记（朝向不变） */
  clearExploit: boolean
  /** 12.5d：清除燃料已补给状态（HQ 标记移除 / 编队标记翻回未补给面） */
  clearFuel: boolean
}

export interface CleanUpPlan {
  rule: string
  /** 本段玩家（清理的是「他的」单位与「对手的」标记） */
  side: Side
  patches: CleanUpUnitPatch[]
  /** 10.0c-C / 14.8c：应予移除的运输破坏标记 id（由**非**本段玩家放置者） */
  removeMarkerIds: string[]
  /** 逐类计数（供日志与测试直接核对） */
  counts: { dg: number; exploit: number; fuel: number; trainbusting: number }
  detail: string
}

/* ────────────────────────────── 主函数 ────────────────────────────── */

/**
 * 2.2 / 5.9 / 5.10 / 12.5d / 10.0c-C：产出一方的 H 段清理计划
 *
 * 只看**本段玩家**的单位（对手的标记原样留着，等对手自己的清理阶段再摘）；
 * 运输破坏标记反向：只摘**对手放置**的那些。
 */
export function planCleanUp(input: {
  phase: GamePhase
  side: Side
  units: readonly CleanUpUnitView[]
  trainbustingMarks?: readonly CleanUpMarkerView[]
}): RuleOutcome<CleanUpPlan> {
  if (input.phase !== CLEANUP_PHASE) return fail('2.2', `notCleanUpPhase:${input.phase}`)

  const patches: CleanUpUnitPatch[] = []
  const counts = { dg: 0, exploit: 0, fuel: 0, trainbusting: 0 }

  // 5.9 / 5.10 / 12.5d：本段玩家的单位——摘 DG、摘进击、清燃料（都不动朝向）
  for (const unit of input.units) {
    if (unit.side !== input.side) continue
    const clearDg = unit.dg
    const clearExploit = unit.exploit
    // 12.5d：本段把该方**剩下**的燃料一律摘掉——编队法 / HQ 法（12.5c-A/B）正是到本段到期；
    // 单单位法（12.5c-C）「只在当前阶段有效」，本该在换段时就失效（见 fuel.ts 的
    // `fuelExpiredAtMoment(·, 'phaseChange')`），万一仍残存到本段也一并清掉，不留陈旧燃料。
    const clearFuel = unit.fuelled
    if (!clearDg && !clearExploit && !clearFuel) continue
    if (clearDg) counts.dg += 1
    if (clearExploit) counts.exploit += 1
    if (clearFuel) counts.fuel += 1
    patches.push({ unitId: unit.id, clearDg, clearExploit, clearFuel })
  }

  // 10.0c-C / 14.8c：运输破坏标记——移除**非本段玩家**放置的
  const marks = input.trainbustingMarks ?? []
  const removeMarkerIds = marks.filter((mark) => mark.side !== input.side).map((mark) => mark.id)
  counts.trainbusting = removeMarkerIds.length

  return succeed('2.2', {
    rule: '2.2',
    side: input.side,
    patches,
    removeMarkerIds,
    counts,
    detail:
      `H 清理（2.2）：摘 DG ${counts.dg} 枚 / 进击 ${counts.exploit} 枚（朝向不变，5.9/5.10）；` +
      `清燃料已补给 ${counts.fuel} 枚（12.5d）；移除对手的运输破坏标记 ${counts.trainbusting} 枚（10.0c-C）`,
  })
}

/* ────────────────────────────── 清理结果的应用形态 ────────────────────────────── */

/** 把计划折成「单位 id → 清哪些标记」的查表（状态层落盘用；同一 id 只出现一次） */
export function cleanupPatchById(plan: CleanUpPlan): Map<string, CleanUpUnitPatch> {
  const map = new Map<string, CleanUpUnitPatch>()
  for (const patch of plan.patches) map.set(patch.unitId, patch)
  return map
}

/** 该清理计划是否**无事可做**（界面据此提示，而不是静默「成功但零效果」） */
export function isCleanUpNoop(plan: CleanUpPlan): boolean {
  const { dg, exploit, fuel, trainbusting } = plan.counts
  return dg === 0 && exploit === 0 && fuel === 0 && trainbusting === 0
}
