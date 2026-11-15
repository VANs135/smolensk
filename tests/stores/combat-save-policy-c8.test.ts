import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * C8（4-9 / 检查文档 C8）的三条**防回潮**守卫
 *
 * 9.2 的既定取舍：**战斗态不序列化**；补给一旦提交，`settlementBlockedReason` 就拒绝保存 / 读取，
 * 玩家必须在「确认战斗补给」前知道「本场战斗须一次打完」。C8（`2eac979`）只做提示，不改存档结构、
 * 也不新增退出拦截。本文件把这三点钉住，防止以后有人动存档时把取舍悄悄改掉：
 *
 *   ① 提示不新增退出拦截：确认补给前 `combatCancelBlocker()` 为 null 且 `cancelCombat()` 真能退出；
 *      提交后只剩既有的 9.2 原因（`战斗结果待结算…`）。C8 的两处 `<p>` 也不含点击 / 禁用逻辑。
 *   ② 战斗未收束时 `saveBlockedReason`（＝`settlementBlockedReason()` 的唯一投影）确实拒绝，
 *      且文案就是那句「请先完成当前战斗、移动、付款或其他结算，再保存或读取对局」。
 *   ③ 盘面快照（存档实际落盘的 `board`）**没有** combat 字段；`save-file.ts` 的存档类型也不含它。
 *
 * ★ 只加测试，不改实现：提示与闸门都读同一份 store 判据，这里不复制规则。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

type Store = ReturnType<typeof newStore>

/** 该阶段的「允许做该动作」环节（与既有战斗测试同口径） */
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

/** 防御格：六邻皆图内（不要求防御地形；本文件不走撤退） */
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
  if (found === undefined) throw new Error('地图上找不到「六邻皆图内」的格')
  return { col: found.col, row: found.row }
})()

const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (
      isOnMap(candidate) &&
      mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row)
    ) {
      return candidate
    }
  }
  throw new Error('防御格没有图内邻格')
})()

function pickRecord(
  side: 'axis' | 'soviet',
  predicate: (record: ReturnType<typeof unitChoices>[number]) => boolean,
): ReturnType<typeof unitChoices>[number] {
  const found = unitChoices(side).find(predicate)
  if (found === undefined) throw new Error(`单位库中没有满足条件的 ${side} 记录`)
  return found
}

function place(
  store: Store,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex: { ...hex }, side })
  store.units.push(unit)
  return unit
}

/** 摆好一对攻守 → 进入 9.2 第 1 步「战斗补给」 */
function setupBattle(store: Store): ConsoleUnit {
  store.setPhase('combat')
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  store.setFuelPool(0, 20)
  const attacker = place(
    store,
    pickRecord(
      'axis',
      (record) =>
        record.isCombat === true &&
        record.attackCapable === true &&
        record.classes?.movementClass === 'leg' &&
        (record.factors?.combat?.attack ?? 0) >= 3,
    ),
    ATTACKER_HEX,
    'axis',
    'c8-a1',
  )
  place(
    store,
    pickRecord(
      'soviet',
      (record) =>
        record.isCombat === true &&
        record.attackCapable === true &&
        (record.factors?.combat?.attack ?? 0) >= 1,
    ),
    DEFENDER_HEX,
    'soviet',
    'c8-d1',
  )
  store.clickHex(DEFENDER_HEX)
  if (!store.combatAttackerIds.includes(attacker.instanceId))
    store.toggleCombatAttacker(attacker.instanceId)
  expect(store.beginCombatNow()).toBe(true)
  expect(store.combatState?.step).toBe('combatSupply')
  return attacker
}

/** 12.4：双方各放一座足量补给站并声明来源（在 `beginCombatNow()` 之后） */
function declareSupplyForBoth(store: Store): void {
  store.spDumps.push({ id: 'c8-axis', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 8, t: 0 })
  store.spDumps.push({ id: 'c8-soviet', hex: { ...DEFENDER_HEX }, side: 'soviet', sp: 8, t: 0 })
  for (const entry of store.combatSupplyDumps) {
    if (store.combatSupplyDumpIds[entry.side] !== null) continue
    const dump = entry.dumps[0]
    if (dump !== undefined) store.pickCombatSupplyDump(entry.side, dump.id)
  }
}

const SAVE_REFUSAL = '请先完成当前战斗、移动、付款或其他结算，再保存或读取对局'

describe('C8：9.2「战斗中不可存档」的取舍守卫（只加测试）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('① 提示不新增退出拦截：确认前可放弃，提交后只剩既有的 9.2 原因', () => {
    const store = newStore()
    setupBattle(store)

    // 确认补给前：提示已可见（按钮旁，见下方源码守卫），但「放弃 / ×」没有任何 combat 侧拦截
    expect(store.combatSupplyCommitted).toBe(false)
    expect(store.combatCancelBlocker()).toBeNull()
    store.cancelCombat()
    expect(store.combatState).toBeNull()
    // 退出真的可用：战斗清掉后保存闸门也随之解除（拒绝只针对「未收束的战斗」）
    expect(store.saveBlockedReason).toBeNull()

    // 源码守卫（2026-11-15 口径）：战斗窗不再铺说明；拒绝原因只作存档窗的一行状态
    const panel = readFileSync('src/components/combat/CombatPanel.vue', 'utf8')
    expect(panel).not.toContain('本场战斗须一次打完')
    expect(panel).not.toContain('v-if="workbench.combatSupplyCommitted"')

    const save = readFileSync('src/components/save/SaveLoadDialog.vue', 'utf8')
    const statusStart = save.indexOf('暂不可保存')
    expect(statusStart).toBeGreaterThanOrEqual(0)
    const status = save.slice(statusStart, save.indexOf('</p>', statusStart))
    expect(status).toContain('workbench.saveBlockedReason')
    expect(status).not.toContain('@click')
    expect(status).not.toContain('disabled')
  })

  it('② 战斗未收束时保存/读取确实被 settlementBlockedReason 拒绝', () => {
    const store = newStore()
    // 未开战 ⇒ 可存（证明拒绝不是永久锁）
    expect(store.saveBlockedReason).toBeNull()

    setupBattle(store)
    // 未提交补给也算「战斗进行中」：闸门用的是 combatState 未收束，不只 combatIsCommitted
    expect(store.saveBlockedReason).toBe(SAVE_REFUSAL)

    declareSupplyForBoth(store)
    expect(store.confirmCombatSupply()).toBe(true)
    expect(store.saveBlockedReason).toBe(SAVE_REFUSAL)

    // 提交后「放弃 / ×」被既有的 9.2 原因挡住（C8 没有另加一条）
    expect(store.combatCancelBlocker()).toBe('战斗结果待结算：请先完成损失、选项、撤退与推进')
    store.cancelCombat()
    expect(store.combatState).not.toBeNull()
    expect(store.saveBlockedReason).toBe(SAVE_REFUSAL)
  })

  it('③ 存档结构里没有 combat 字段（board 快照与 SaveFile 类型都不含）', () => {
    const store = newStore()
    const board = store.snapshotBoard() as { version: number; fields: Record<string, unknown> }
    const keys = Object.keys(board.fields)
    for (const forbidden of [
      'combat',
      'combatState',
      'combatInputs',
      'combatSupplyCommitted',
      'overrunContext',
      'barrageState',
      'airState',
      'moveInteraction',
    ]) {
      expect(keys).not.toContain(forbidden)
    }
    // 9.2 的取舍：战斗态连字段都不存在，读档不可能「T 已扣、战斗消失」半截恢复
    expect(readFileSync('src/engine/save-file.ts', 'utf8')).not.toMatch(/\bcombat\b/i)
  })
})
