import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  participatesIn,
  toConsoleUnit,
  unitChoices,
  useMapViewStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * 批 A 切片 3③：**9.1c 的战斗环节攻击账本**
 *
 * 原文（`_ocs_v43_clean.txt:1091-1097`）：
 *   「在一个战斗环节中，**同一个单位只能攻击一次，同一格只能被攻击一次**。一个格可以被任意数量的
 *     相邻格攻击，由攻击方玩家决定。」
 *   「在一个移动环节中，同一个单位可以进行多次突袭，**突袭同一个格的次数没有限制**。」
 * ⇒ 两条限制只作用于**常规战斗**（战斗环节），突袭不受限；换环节 / 换段 / 换方 / 换回合即清空。
 *
 * 记账时点＝**战斗补给过关之后**（9.5b 允许"减少参战单位 / 动用储备 / 根本不攻击"——那份作废的
 * 战斗不占本环节的这一次；与 10.1b 的轰炸账本"付不出则不视为已轰炸过"同一口径）。
 *
 * ## 测法边界（如实交代）
 *   · 用真实地图与真实单位库；`spDumps` 用**引擎认的**补给站条目（12.3a：只能从己方补给站扣）；
 *   · **不覆盖**：突袭（8.1）走的是 `attackType: 'overrun'`，本文件的 store 级夹具造不出"移动段里
 *     两次突袭同一格"的完整链路 ⇒ 该侧由 `tests/engine/combat-interaction.test.ts` 的
 *     "9.1c 不管突袭"用例覆盖（直接喂 `attackType` 与账本事实）；
 *   · **不覆盖**：UI 层的灰显（那部分在 `map-view-flow.test.ts` 里按 `popupContent` 断言）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 目标格：六邻皆图内（攻方可以从任一邻格发起，且守方与攻方都在图上） */
const DEFENDER_HEX: HexRef = (() => {
  const found = mapLayers.hexes.find((hex) => {
    const ref = { col: hex.col, row: hex.row }
    return HEX_DIRECTIONS.every((direction) => {
      const candidate = neighbor(ref, direction)
      return (
        isOnMap(candidate) &&
        mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
      )
    })
  })
  if (found === undefined) throw new Error('地图上找不到六邻皆图内的格')
  return { col: found.col, row: found.row }
})()

/** 攻方格：目标格的图内邻格 */
const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)) continue
    return candidate
  }
  throw new Error('目标格没有图内邻格')
})()

/** 第二个攻方格（用于"同一格被第二个单位攻击"） */
const ATTACKER_HEX_2: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)) continue
    if (candidate.col === ATTACKER_HEX.col && candidate.row === ATTACKER_HEX.row) continue
    return candidate
  }
  throw new Error('目标格没有第二个图内邻格')
})()

function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

/** 攻方：轴心国可攻击的徒步战斗单位（不需燃料 ⇒ 与 12.5 无关，本文件只考 9.1c） */
const attackerRecord = () =>
  pickRecord(
    'axis',
    (record) =>
      record.isCombat === true &&
      record.attackCapable === true &&
      (record.factors?.combat?.attack ?? 0) >= 3 &&
      record.classes?.movementClass === 'leg',
  )

/** 守方：苏联战斗单位（9.1d 防御格内全部单位参战） */
const defenderRecord = () =>
  pickRecord('soviet', (record) => record.isCombat === true && record.attackCapable === true)

function place(
  store: ReturnType<typeof newStores>['workbench'],
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

/** B8：把 store 放到本段里允许做该动作的那个环节 */
function goToActionStep(
  store: {
    phase: ConsolePhase
    playerSegmentSteps: readonly { id: string }[]
    setSegmentStepIndex(index: number): boolean
  },
  key: ActionKey,
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  if (index < 0) throw new Error(`${store.phase} 段没有允许 ${key} 的环节`)
  if (!store.setSegmentStepIndex(index)) throw new Error(`进入环节失败（${key}）`)
}

/**
 * F 段战斗环节的常规战斗前置
 *
 * 攻守摆好、进入战斗环节、选好攻方与防御格，停在"战斗构成已生成"（9.2 的补给步）。
 */
function prepareCombat(
  stores: ReturnType<typeof newStores>,
  options: { attackerIds?: string[]; attackerHex?: HexRef } = {},
): { attackerId: string; defenderId: string } {
  const { workbench } = stores
  workbench.setPhase('combat')
  goToActionStep(workbench, 'combat.declare')
  const attackerId = options.attackerIds?.[0] ?? 'a1'
  const defenderId = 'd1'
  place(workbench, attackerRecord(), options.attackerHex ?? ATTACKER_HEX, 'axis', attackerId)
  place(workbench, defenderRecord(), DEFENDER_HEX, 'soviet', defenderId)
  workbench.battleTarget = { hex: DEFENDER_HEX, defenderIds: [defenderId] }
  workbench.combatAttackerIds = [attackerId]
  return { attackerId, defenderId }
}

/** 给某一方摆一处"引擎认的"补给站（12.3a：付款只能落在己方补给站上） */
function putDump(
  store: ReturnType<typeof newStores>['workbench'],
  hex: HexRef,
  side: 'axis' | 'soviet',
  sp: number,
): string {
  const id = `dump-${side}-${hex.col}-${hex.row}`
  store.spDumps.push({ id, hex: { ...hex }, side, sp, t: 0 })
  return id
}

/**
 * 把这一场战斗的补给输入备齐，并**走完补给步**
 *
 * ★ 次序是**硬约束**：`beginCombatNow()` 会用 `createCombatInputs()` 重建输入对象
 *   （只预填双方 AR 单位）⇒ 在它**之前**设的 `availableT` 会被清成 0（本轮踩到：
 *   表现为 `confirmCombatSupply` 返回 false、`combatError.reason = attackSupplyNotFull`）。
 *   供给站与可用 T 都必须在宣布之后设。
 */
function runSupplyStep(
  stores: ReturnType<typeof newStores>,
  hexes: { attacker: HexRef; defender: HexRef } = {
    attacker: ATTACKER_HEX,
    defender: DEFENDER_HEX,
  },
): boolean {
  const { workbench } = stores
  putDump(workbench, hexes.attacker, 'axis', 12)
  putDump(workbench, hexes.defender, 'soviet', 12)
  if (!workbench.beginCombatNow()) return false
  workbench.combatSupplyDumpIds = {
    attacker: `dump-axis-${hexes.attacker.col}-${hexes.attacker.row}`,
    defender: `dump-soviet-${hexes.defender.col}-${hexes.defender.row}`,
  }
  workbench.combatInputs.attackerAvailableT = 12
  workbench.combatInputs.defenderAvailableT = 12
  return workbench.confirmCombatSupply()
}

describe('批 A 切片 3③：9.1c 的攻击账本（每战斗环节一次）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('前提自检：这一对格真能打常规战斗（攻守相邻、守方在图上、攻方不需燃料）', () => {
    const { workbench } = stores
    expect(
      mapLayers.hexes.some((h) => h.col === DEFENDER_HEX.col && h.row === DEFENDER_HEX.row),
    ).toBe(true)
    expect(attackerRecord().classes?.movementClass).toBe('leg')
    // 攻方与守方相邻（9.0：攻击单位必须与被攻击的格相邻）
    expect(
      HEX_DIRECTIONS.some((direction) => {
        const candidate = neighbor(DEFENDER_HEX, direction)
        return candidate.col === ATTACKER_HEX.col && candidate.row === ATTACKER_HEX.row
      }),
    ).toBe(true)
    expect(workbench.attackPhaseLedger.unitIds).toEqual([])
  })

  it('① 补给过关 ⇒ 记账（参战单位 + 被攻击的格）；同一单位再攻被引擎拒并给 9.1c', () => {
    const { workbench } = stores
    const { attackerId } = prepareCombat(stores)
    expect(runSupplyStep(stores)).toBe(true)

    // 记账：单位与格都在账本里（补给过关那一刻记，见文件头的口径说明）
    expect(workbench.attackPhaseLedger.unitIds).toEqual([attackerId])
    expect(workbench.attackPhaseLedger.hexes).toEqual([`${DEFENDER_HEX.col}.${DEFENDER_HEX.row}`])

    // 收掉这一场（9.1c 只管"打没打过"，不要求打完）
    workbench.cancelCombat()
    expect(workbench.combatState).toBeNull()

    // 同一单位、同一格再攻一次 ⇒ 引擎按 9.1c 拒
    workbench.combatAttackerIds = [attackerId]
    workbench.battleTarget = { hex: DEFENDER_HEX, defenderIds: ['d1'] }
    expect(workbench.beginCombatNow()).toBe(false)
    expect(workbench.combatError?.rule).toBe('9.1c')
  })

  it('② 同一格被**第二个单位**攻击同样被拒（"同一格只能被攻击一次"）', () => {
    const { workbench } = stores
    prepareCombat(stores)
    expect(runSupplyStep(stores)).toBe(true)
    workbench.cancelCombat()

    // 换一枚**没打过**的单位，打**同一个格** ⇒ 仍被 9.1c 拒（该格本环节已被攻击过）
    place(workbench, attackerRecord(), ATTACKER_HEX_2, 'axis', 'a2')
    workbench.combatAttackerIds = ['a2']
    workbench.battleTarget = { hex: DEFENDER_HEX, defenderIds: ['d1'] }
    expect(workbench.beginCombatNow()).toBe(false)
    expect(workbench.combatError?.rule).toBe('9.1c')
  })

  it('③ 同一单位打**另一个格**也被拒（"一个单位只能攻击一次"与打哪个格无关）', () => {
    const { workbench } = stores
    prepareCombat(stores)
    expect(runSupplyStep(stores)).toBe(true)
    workbench.cancelCombat()

    // 另一处守方格（攻方 a1 与它相邻）⇒ 攻方那一枚已打过 ⇒ 9.1c 拒
    const other = ATTACKER_HEX_2
    place(workbench, defenderRecord(), other, 'soviet', 'd2')
    workbench.combatAttackerIds = ['a1']
    workbench.battleTarget = { hex: other, defenderIds: ['d2'] }
    expect(workbench.beginCombatNow()).toBe(false)
    expect(workbench.combatError?.rule).toBe('9.1c')
  })

  it('④ 付不出战斗补给的战斗**不记账**（9.5b「根本不攻击」⇒ 不占本环节这一次）', () => {
    const { workbench } = stores
    prepareCombat(stores)
    // 一处补给站都不摆 ⇒ 12.4 的付款无从谈起
    expect(workbench.beginCombatNow()).toBe(true)
    expect(workbench.confirmCombatSupply()).toBe(false)
    // 未发生攻击 ⇒ 账本仍空
    expect(workbench.attackPhaseLedger.unitIds).toEqual([])
    expect(workbench.attackPhaseLedger.hexes).toEqual([])
    // 且**构成本身没被账本挡**：补上来源后这一单位仍可正常开打（"作废不占额"的反向证明）
    workbench.cancelCombat()
    // cancelCombat 会清掉选格与攻方名单（`clearCombat`）⇒ 重新指一次
    workbench.combatAttackerIds = ['a1']
    workbench.battleTarget = { hex: DEFENDER_HEX, defenderIds: ['d1'] }
    expect(runSupplyStep(stores)).toBe(true)
    expect(workbench.attackPhaseLedger.unitIds).toEqual(['a1'])
  })

  it('⑤ 换段即清空（下一段的战斗环节是新的账本）', () => {
    const { workbench } = stores
    prepareCombat(stores)
    expect(runSupplyStep(stores)).toBe(true)
    expect(workbench.attackPhaseLedger.unitIds).toEqual(['a1'])

    workbench.setPhase('exploitation')
    expect(workbench.attackPhaseLedger.unitIds).toEqual([])
    expect(workbench.attackPhaseLedger.hexes).toEqual([])
  })

  it('⑥ 同段内**换环节**即清空（F 段：战斗环节 ↔ 炮击环节是两份账本）', () => {
    const { workbench } = stores
    prepareCombat(stores)
    expect(runSupplyStep(stores)).toBe(true)
    workbench.cancelCombat()
    expect(workbench.attackPhaseLedger.unitIds).toEqual(['a1'])

    // 回到本段的第一环（炮击）⇒ 环节变了，账本随之清空（`setSegmentStepIndex` 是验证页/测试路径）
    expect(workbench.setSegmentStepIndex(0)).toBe(true)
    expect(workbench.attackPhaseLedger.unitIds).toEqual([])
    expect(workbench.attackPhaseLedger.hexes).toEqual([])
  })

  it('⑦ 候选过滤：已攻击过的单位在**本环节**不再可参与（participatesIn ⇒ 9.1c）', () => {
    const { workbench } = stores
    const unit = place(workbench, attackerRecord(), ATTACKER_HEX, 'axis', 'a1')
    const verdict = participatesIn({
      unit,
      phase: 'combat',
      segment: 'combat.combat',
      activeSide: 'axis',
      attackedUnitIds: ['a1'],
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.rule).toBe('9.1c')
      expect(verdict.reason).toContain('已攻击过')
    }
    // 同一条判据下，没打过的单位照常可参与
    expect(
      participatesIn({
        unit,
        phase: 'combat',
        segment: 'combat.combat',
        activeSide: 'axis',
        attackedUnitIds: [],
      }).ok,
    ).toBe(true)
    /*
     * 9.1c 的下一条（移动环节同一单位可多次突袭）：账本**不影响**移动环节的参与判定
     * —— 同一枚单位在 `movement.modeAndMovement` 上的结论与账本无关（带不带账本都一样）。
     */
    const moveVerdict = participatesIn({
      unit,
      phase: 'movement',
      segment: 'movement.modeAndMovement',
      activeSide: 'axis',
      attackedUnitIds: ['a1'],
    })
    const moveVerdictNoLedger = participatesIn({
      unit,
      phase: 'movement',
      segment: 'movement.modeAndMovement',
      activeSide: 'axis',
    })
    expect(moveVerdict).toEqual(moveVerdictNoLedger)
  })
})
