import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import type { HexRef } from '@/data'
import { mapLayers } from '@/data'
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
 * 批 A 切片 2：**环节驱动的点击分派**（用户口径：正式界面由流程驱动，不让玩家先切"工具"）
 *
 * 病灶（§17.87 的族①，用户 2026-09-17 备忘第 1/4/5 条）：
 *   · 轰炸的**目标格**取自战斗工具的选定（\`barrageTargetHex = battleTarget?.hex\`）⇒ 对局台删掉工具按钮后
 *     **炮兵连防御格都点不了**，面板还提示"请在「打一仗」工具里点敌方算子所在格"；
 *   · 地图点击按 \`tool\` 分派，而 \`tool\` 默认 'move' ⇒ **战斗环节点己方单位弹出的是移动对话框**；
 *   · 轰炸面板让玩家**自由选** artillery/air/ship，而"哪个环节允许哪种来源"原文里是死的
 *     （SOP：C 段 air & ship only、F 段 artillery only；引擎侧 \`BARRAGE_SOURCES_BY_PHASE\` 早有表）。
 *
 * ## 本切片定的分派规则（**环节优先**，其余照旧）
 *   ① 当前环节是**某段的轰炸环节** ⇒ 点地图＝选**轰炸目标格**（10.0d）；
 *   ② 当前环节是**战斗段的战斗环节** ⇒ 点敌方格＝选防御格、点己方单位＝加入/移出攻方（9.1b/c）；
 *   ③ 其余情形照旧（验证页的工具分派 + 对局台的移动交互）——**兼容层**：既有夹具仍可用
 *      \`battleTarget\` 提供轰炸目标（后备），但**环节点格优先**。
 *
 * ## 测法边界（如实交代）
 *   · 用真实地图与单位库；只钉"点击分派"这一层（宣布是否合法仍由引擎判，不在此重复）；
 *   · **不覆盖**：空军轰炸的完整链路（C 段的 \`air\` 来源要选机+任务格，见既有 14.x 用例组）；
 *     本组只断言**该环节允许的来源清单**（\`barrageKindsInSegment\`）。
 */

const newStore = () => {
  setActivePinia(createPinia())
  return useWorkbenchStore()
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

/** 目标格：六邻皆图内 */
const TARGET_HEX: HexRef = (() => {
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

/** 参炸格：目标格的图内邻格（10.1a 射程按格） */
const FIRING_HEX: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(TARGET_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)) continue
    return candidate
  }
  throw new Error('目标格没有图内邻格')
})()

/** 另一处参炸格（用于战斗环节的攻方点选，离目标格一格） */
const FIRING_HEX_2: HexRef = (() => {
  for (const direction of HEX_DIRECTIONS) {
    const candidate = neighbor(TARGET_HEX, direction)
    if (!isOnMap(candidate)) continue
    if (!mapLayers.hexes.some((h) => h.col === candidate.col && h.row === candidate.row)) continue
    if (candidate.col === FIRING_HEX.col && candidate.row === FIRING_HEX.row) continue
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

const artilleryRecord = () =>
  pickRecord(
    'axis',
    (record) => record.isCombat === true && (record.factors?.combat?.barrage ?? 0) > 0,
  )

const rifleRecord = () =>
  pickRecord('axis', (record) => record.isCombat === true && record.attackCapable === true)

const enemyRecord = () => pickRecord('soviet', (record) => record.isCombat === true)

function place(
  store: ReturnType<typeof newStore>,
  record: ReturnType<typeof unitChoices>[number],
  hex: HexRef,
  side: 'axis' | 'soviet',
  instanceId: string,
): ConsoleUnit {
  const unit = toConsoleUnit({ record, instanceId, hex, side })
  store.units.push(unit)
  return unit
}

describe('批 A 切片 2：环节驱动的点击分派', () => {
  let store: ReturnType<typeof newStore>

  beforeEach(() => {
    store = newStore()
  })

  it('① F 段（战斗）轰炸环节：**点地图即选目标格**，炮兵可直接宣布轰炸（不需要"打一仗"工具）', () => {
    store.setPhase('combat')
    goToActionStep(store, 'barrage.declare')
    expect(store.segmentStep?.id).toBe('combat.barrage')
    // SOP 原文：F 段轰炸只允许炮兵（air & ship 在 C 段）
    expect([...store.barrageKindsInSegment]).toEqual(['artillery'])
    // 进入轰炸环节即自动开好轰炸工具（不再要玩家先点开关）
    expect(store.barrageActive).toBe(true)
    expect(store.barrageTargetHex).toBeNull()

    const gun = place(store, artilleryRecord(), FIRING_HEX, 'axis', 'gun-1')
    // ★ 只点一下地图：目标格就定了（修前必须先用「打一仗」工具点敌方格）
    store.clickHex(TARGET_HEX)
    expect(store.barrageTargetHex).toEqual(TARGET_HEX)
    // 再点别的格 ⇒ 目标格随之改（10.0d：目标就是轰炸环节里点的那一格，可随时改；
    // 目标**可以是任意格**：敌单位 / 空军基地 / 铁路格（运输破坏）都行，故此处不按格内有无单位过滤）
    // ★ 第六批条 20（10.1a）：射程按**格距**判 ⇒ 改用的目标格必须仍是"够得着"的格
    //   （修前改点 `FIRING_HEX`＝炮兵自己所在的格，格距 0，10.1a 明写射程自 1 格起 ⇒ 那条路径本就不合法）
    store.clickHex(FIRING_HEX_2)
    expect(store.barrageTargetHex).toEqual(FIRING_HEX_2)

    // 选参炸单位并宣布：走的是**既有**引擎判据（10.0d/10.0e）
    store.toggleBarrageUnit(gun.instanceId)
    expect(store.barrageUnitIds).toEqual([gun.instanceId])
    expect(store.beginBarrageNow()).toBe(true)
    expect(store.barrageState?.kind).toBe('artillery')
  })

  it('② C 段（移动）轰炸环节：来源清单是 **air / ship**（炮兵不在此段）', () => {
    store.setPhase('movement')
    /*
     * ★ 契约变更（G①，2026-09-19，**不是放宽**）：`barrage.declare` 现在也挂在 C 段的
     *   **移动环节**（14.7d 的低空扫射就在那个环节宣布）⇒ 用"按动作族反查环节"的
     *   `goToActionStep` 会落在 `movement.modeAndMovement`。本用例要验的是**轰炸环节**的来源清单，
     *   故直接走到 `movement.barrage`。
     */
    const barrageIndex = store.playerSegmentSteps.findIndex(
      (step) => step.id === 'movement.barrage',
    )
    expect(barrageIndex).toBeGreaterThanOrEqual(0)
    expect(store.setSegmentStepIndex(barrageIndex)).toBe(true)
    expect(store.segmentStep?.id).toBe('movement.barrage')
    expect([...store.barrageKindsInSegment]).toEqual(['air', 'ship'])
  })

  it('③ F 段战斗环节：点敌方格＝选防御格、点己方单位＝加入攻方（不需要工具）', () => {
    store.setPhase('combat')
    goToActionStep(store, 'combat.declare')
    expect(store.segmentStep?.id).toBe('combat.combat')

    const enemy = place(store, enemyRecord(), TARGET_HEX, 'soviet', 'def-1')
    const atk1 = place(store, rifleRecord(), FIRING_HEX, 'axis', 'atk-1')
    place(store, rifleRecord(), FIRING_HEX_2, 'axis', 'atk-2')

    // 点敌方格 ⇒ 选防御格（守方格内全部战斗单位自动入守方名单，9.1d）
    store.clickHex(TARGET_HEX)
    expect(store.battleTarget?.hex).toEqual(TARGET_HEX)
    expect(store.battleTarget?.defenderIds).toEqual([enemy.instanceId])

    // 点己方单位 ⇒ **切换**它在攻方名单里的去留（9.1b「可只用堆叠中一部分单位攻击」）
    const before = [...store.combatAttackerIds]
    expect(before.length).toBeGreaterThan(0) // 选防御格时已自动填了相邻攻方（9.1b 的便捷）
    const wasSelected = before.includes(atk1.instanceId)
    store.clickHex(FIRING_HEX)
    expect(store.combatAttackerIds.includes(atk1.instanceId)).toBe(!wasSelected)
    store.clickHex(FIRING_HEX)
    expect([...store.combatAttackerIds].sort()).toEqual([...before].sort())
  })

  it('④ 兼容层：非轰炸环节时，战斗目标仍可作为轰炸目标（既有夹具/验证页依赖），**环节点格优先**', () => {
    store.setPhase('combat')
    // 不在轰炸环节：直接把"战斗目标"设上（等价于验证页用「打一仗」工具点敌方格的结果）
    place(store, enemyRecord(), TARGET_HEX, 'soviet', 'def-2')
    store.battleTarget = { hex: { ...TARGET_HEX }, defenderIds: ['def-2'] }
    // 后备生效：轰炸目标读到了战斗目标（既有夹具靠这条继续可用）
    expect(store.barrageTargetHex).toEqual(TARGET_HEX)

    // 切到轰炸环节后：**环节里点的格优先**，后备不再顶掉它
    goToActionStep(store, 'barrage.declare')
    store.clickHex(FIRING_HEX)
    expect(store.barrageTargetHex).toEqual(FIRING_HEX)
  })
})
