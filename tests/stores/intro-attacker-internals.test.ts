import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers, scenarios } from '@/data'
import type { HexRef } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor } from '@/engine/hex-geometry'
import {
  actionGateOf,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useWorkbenchStore,
  type ActionKey,
  type ConsolePhase,
  type ConsoleUnit,
} from '@/stores'

/**
 * Intro: Vitebsk：**攻方不得动用部队储备**（剧本页明文 `Attacking units can never use Internals`）
 *
 * 口径：剧本级规则（`setup.attackerInternalsForbidden`），不改 12.10 全局。
 * 界面按「不可用项不出现」：`combatAttackerStocksApplicable` 为 false，勾选不渲染；
 * 即便旧状态里残留 `attackerUsesInternalStocks = true`，结算也必须忽略。
 */
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

const ATTACKER_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(DEFENDER_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((item) => item.col === candidate.col && item.row === candidate.row))
      continue
    return candidate
  }
  throw new Error('防御格没有图内邻格')
})()

/** 段内动作只在对应环节放行（与 internal-stocks-flow 同一辅助） */
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

function place(
  store: ReturnType<typeof useWorkbenchStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side, face: 'combat' })
  store.units.push(unit)
  return unit
}

/** Intro 下的「图上不够」战斗：攻方只有 0 T 的补给站，勾选储备也不得使用 */
function setupIntroUnderSupplied() {
  setActivePinia(createPinia())
  const session = useGameSessionStore()
  expect(session.setScenarioId('Intro')).toBe(true)
  const store = useWorkbenchStore()

  const attackerRecord = unitChoices('axis').find(
    (record) => record.attackCapable === true && record.isCombat === true,
  )
  const defenderRecord = unitChoices('soviet').find((record) => record.isCombat === true)
  if (attackerRecord === undefined || defenderRecord === undefined)
    throw new Error('单位库缺可用样本')

  const attacker = place(store, attackerRecord, ATTACKER_HEX, 'axis', 'a1')
  place(store, defenderRecord, DEFENDER_HEX, 'soviet', 'd1')
  store.setPhase('combat')
  goToActionStep(store, 'combat.declare')
  store.setTool('battle')
  store.clickHex(ATTACKER_HEX)
  store.clickHex(DEFENDER_HEX)
  expect(store.beginCombatNow()).toBe(true)
  store.spDumps.push({ id: 'sd-thin', hex: { ...ATTACKER_HEX }, side: 'axis', sp: 0, t: 0 })
  store.pickCombatSupplyDump('attacker', 'sd-thin')
  store.combatInputs.defenderProvides = false
  return { store, attacker }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('Intro: Vitebsk 的剧本级攻方 Internals 禁令', () => {
  it('剧本数据登记了禁令', () => {
    const intro = scenarios.scenarios.find((item) => item.id === 'Intro')
    expect(intro?.setup.attackerInternalsForbidden).toBe(true)
  })

  it('图上不够时也不出现「攻方用储备」（不可用项不出现，不是置灰）', () => {
    const { store } = setupIntroUnderSupplied()
    expect(store.combatAttackerStocksApplicable).toBe(false)
  })

  it('残留勾选也不得动用：结算被拒且单位储备不降级', () => {
    const { store, attacker } = setupIntroUnderSupplied()
    store.combatInputs.attackerUsesInternalStocks = true
    expect(store.confirmCombatSupply()).toBe(false)
    expect(store.combatState?.step).toBe('combatSupply')
    expect(attacker.internalStocks).toBeNull()
  })
})
