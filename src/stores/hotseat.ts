import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { scenarios } from '@/data'
import type { HexRef, Side } from '@/data'
import { HEX_DIRECTIONS, isOnMap, neighbor, sameHex } from '@/engine/hex-geometry'
import { exertsZoc } from '@/engine/rules'
import {
  COMBAT_REVEAL_RULE,
  FOG_RULE,
  hexDisplay,
  hiddenInfoPolicy,
  otherSide,
  rollVisibleTo as engineRollVisibleTo,
  sideLabel,
  STACK_ORDER_RULE,
  stackOrderIssues as engineStackOrderIssues,
  visibleUnitIds,
  type CombatReveal,
  type FogUnitView,
  type HexDisplay,
  type StackFacts,
  type StackOrderIssue,
} from '@/engine/rules'

import { useGameSessionStore } from './session'
import { useWorkbenchStore } from './workbench'
import type { ConsoleUnit } from './workbench-model'

/**
 * 切方与信息展示纪律（W7 C13）
 *
 * ## 它解决什么
 *   1. **热坐切屏**：双人同机轮流操作时，交接触发一块全屏遮罩（`handoffPending`），
 *      接手方点「确认」之前**不显示盘面**。规则书里没有 hot-seat 条文（已核实「未找到」），
 *      这里实现的是**设备交接的礼仪**，其依据是 4.9 的信息纪律（对手不该看到己方堆叠明细）；
 *   2. **未参战敌方堆叠明细隐藏（4.9a）**：敌方格只给「最上方战斗单位 + 最上方激活飞机 + 工事」
 *      与「是否战略模式 / DG / 断补」；**枚数与其余算子一律隐藏**（`stackSizeHidden`）；
 *   3. **堆叠顺序（4.8b）**：给所有者报「有 ZOC 的单位应在最上方」「相邻有敌方地面单位时 HQ 不得置顶」
 *      之类的**合规提示**，不替玩家重排（4.8b 开头：顺序由所有者自行安排）；
 *   4. **共识开关生效（专规 4.0 / 1.4 / 4.9e / 2.4）**：把勾选结论译成 `HiddenInfoPolicy`
 *      —— 地图外盒是否对对手隐藏、掷骰是否秘密进行。
 *
 * ## 判据都在引擎
 *   本 store 只做两件事：把盘面算子**投影**成引擎要的 `FogUnitView`，以及把玩家点击转成动作；
 *   「谁可见」「谁置顶」全部由 `engine/rules/fog.ts` 判定（本文件不含任何可见性规则）。
 */

/** B36：对局模式（用户口径 #7） */
export type HotseatMode = 'solo' | 'pvp' | 'pve'

export const useHotseatStore = defineStore('hotseat', () => {
  const workbench = useWorkbenchStore()
  const session = useGameSessionStore()

  /**
   * 对局模式（B36；用户口径 #7）
   *
   *   · `pvp`（默认）：双人同机热坐 —— 交接亮**交接屏**，信息纪律按 4.9a 裁剪；
   *   · `solo`：单人（自己跟自己推演）—— **不遮交接屏**、**双方内容都可见**（见 `fogDisabled`）；
   *   · `pve`：人机 —— 本轮**只登记枚举**，行为与 `pvp` 相同，界面明示"未实现"。
   */
  const mode = ref<HotseatMode>('pvp')

  /**
   * 热坐交接是否启用（pvp / pve 启用；solo 不遮屏）
   *
   * ★ 由 `mode` **推出**（原来是一个独立 ref）⇒ 一个来源，免得"模式是 solo 但交接屏还开着"。
   */
  const hotseatEnabled = computed<boolean>(() => mode.value !== 'solo')

  /**
   * **战雾是否关闭**（solo：桌边只有一个玩家，没有要隐瞒的对手）
   *
   * 依据：4.9a 的"不得看穿**敌方**堆叠"与专规 1.4 的"外盒对**对手**隐藏"都是对手之间的约定。
   * 关掉后 `displayOf` / `visibleUnitIdsInHex` 传 `viewer: null`（引擎里的一条分支），
   * 于是堆叠明细、枚数、状态都照实给 —— 这不是"放宽规则"，而是没有对手时那两条约定无从适用。
   */
  const fogDisabled = computed<boolean>(() => mode.value === 'solo')

  /** 交接屏是否待确认（true ⇒ 盘面被遮罩，直到接手方确认） */
  const handoffPending = ref(false)

  /* ────────────────────────────── 观察方（＝当前行动方） ────────────────────────────── */

  /** 当前观察方（2.2：行动方就是能看到己方全貌的一方） */
  const viewerSide = computed<Side>(() => workbench.activeSide)
  /** 对手方 */
  const opponentSide = computed<Side>(() => otherSide(viewerSide.value))
  /** 交接提示语（给接手方看的那一句） */
  const handoffNotice = computed(() => `请把设备交给「${sideLabel(viewerSide.value)}」玩家`)

  /* ────────────────────────────── 信息纪律（共识开关 → 生效） ────────────────────────────── */

  /** 由共识结论推导的纪律开关（专规 1.4 / 4.9e / 2.4 / 4.1–4.3；未采纳即默认态） */
  const policy = computed(() =>
    hiddenInfoPolicy(
      session.consensus.map((decision) => ({ item: decision.item, adopted: decision.adopted })),
      Object.keys(scenarios.optionalRules),
    ),
  )

  /** 4.9e：该次掷骰的骰面是否对当前观察方可见（未启用秘密掷骰时恒可见） */
  function rollVisibleToViewer(rollingSide: Side): boolean {
    return engineRollVisibleTo({
      viewer: viewerSide.value,
      rollingSide,
      policy: policy.value,
    })
  }

  /* ────────────────────────────── 盘面 → 引擎视图 ────────────────────────────── */

  /** 操作台算子 → 战雾视图（模式判定复用 modes.exertsZoc，不在本文件另立口径） */
  function toFogUnit(unit: ConsoleUnit): FogUnitView {
    const inCombatMode = exertsZoc(unit.mode)
    return {
      id: unit.instanceId,
      side: unit.side,
      name: unit.name,
      kind: 'ground',
      isCombat: unit.isCombat,
      attackCapable: unit.attackCapable,
      inCombatMode,
      // 4.5：可攻击 ∧ 战斗模式 ∧ 非断补（与 zoc.ts 同一判据）
      projectsZoc: unit.attackCapable && inCombatMode && unit.hasTraceSupply,
      mode: unit.mode.mode,
      dg: unit.mode.dg,
      outOfSupply: !unit.hasTraceSupply,
      steps: unit.steps,
      printedSteps: unit.printedSteps,
      internalStocks: unit.internalStocks,
      // B31b：设施类算子（机场 / SP / 工事）——战雾对它们放行
      //（不是"部队"，枚数口径与堆叠无关；"这格有设施"是盘面事实）
      isFacility:
        unit.noncombatKind === 'air_base' ||
        unit.noncombatKind === 'sp' ||
        unit.noncombatKind === 'hedgehog',
    }
  }

  /** 该格的空中算子（4.8b E / 4.9a 的「最上方激活飞机」） */
  function fogAirUnitsAt(hex: HexRef): FogUnitView[] {
    return workbench.airUnits
      .filter((air) => sameHex(air.hex, hex))
      .map((air) => ({
        id: air.instanceId,
        side: air.side,
        name: air.name,
        kind: 'air' as const,
        isCombat: false,
        attackCapable: false,
        inCombatMode: false,
        projectsZoc: false,
        airStatus: air.airStatus,
      }))
  }

  /** 该格的战雾视图序列（地面先、飞机后 —— 4.8b E 要求激活飞机在所有地面单位之上） */
  function fogUnitsAt(hex: HexRef): FogUnitView[] {
    const ground = workbench.units.filter((unit) => sameHex(unit.hex, hex)).map(toFogUnit)
    return [...ground, ...fogAirUnitsAt(hex)]
  }

  /** 图上全部有算子的格（渲染与提示遍历用） */
  const occupiedHexes = computed<HexRef[]>(() => {
    const hexes: HexRef[] = []
    for (const unit of workbench.units) {
      if (!hexes.some((hex) => sameHex(hex, unit.hex))) hexes.push({ ...unit.hex })
    }
    for (const air of workbench.airUnits) {
      if (!hexes.some((hex) => sameHex(hex, air.hex))) hexes.push({ ...air.hex })
    }
    return hexes
  })

  /** 4.8b(D) 的事实：该格**相邻格**是否有敌方地面单位（不限模式与补给；与 ZOC 不是一回事） */
  function enemyGroundUnitAdjacent(hex: HexRef, ownerSide: Side): boolean {
    const enemy = otherSide(ownerSide)
    return HEX_DIRECTIONS.some((direction) => {
      const target = neighbor(hex, direction)
      if (!isOnMap(target)) return false
      return workbench.units.some((unit) => unit.side === enemy && sameHex(unit.hex, target))
    })
  }

  /** 某格（以其占有方为准）的堆叠事实 */
  function factsFor(hex: HexRef): StackFacts {
    const owner = fogUnitsAt(hex)[0]?.side ?? viewerSide.value
    return { enemyGroundUnitAdjacent: enemyGroundUnitAdjacent(hex, owner) }
  }

  /* ────────────────────────────── 4.9b：参战格须公开的数值 ────────────────────────────── */

  /** 当前战斗涉及的格（攻方格集合 + 防御格）；未开战时为空 */
  const combatHexes = computed<HexRef[]>(() => {
    const state = workbench.combatState
    if (state === null) return []
    const hexes: HexRef[] = [...state.composition.attackerHexes]
    const target = state.composition.defendingHex
    if (!hexes.some((hex) => sameHex(hex, target))) hexes.push(target)
    return hexes
  })

  /** 该格是否正在结算战斗（4.9b 的「参战」） */
  function inCombat(hex: HexRef): boolean {
    return combatHexes.value.some((item) => sameHex(item, hex))
  }

  /**
   * 4.9b：该格参战方须公开的**数值**
   *
   * 「双方必须展示各自的行动值、反坦克效果（9.4e）和战斗值总值。**双方并不需要展示实际的单位**」
   * ⇒ 这里只从战斗交互状态取数值；算子面仍按 4.9a 朝下（`countersRevealed: false`）。
   */
  function revealFor(hex: HexRef): CombatReveal | null {
    const state = workbench.combatState
    if (state === null || state.odds === undefined || state.ar === undefined) return null
    if (!inCombat(hex)) return null
    const owner = fogUnitsAt(hex)[0]?.side ?? viewerSide.value
    const attackerHere = state.composition.attackerHexes.some((item) => sameHex(item, hex))
    const participants = attackerHere
      ? state.composition.attackerIds
      : state.composition.defenderIds
    const atEffects =
      participants
        .map((id) => workbench.units.find((unit) => unit.instanceId === id)?.atEffects ?? 'none')
        .join('、') || 'none'
    const actionRating = attackerHere ? state.ar.attackerAr : state.ar.defenderAr
    const totalStrength = attackerHere ? state.odds.attackerTotal : state.odds.defenderTotal
    return {
      rule: COMBAT_REVEAL_RULE,
      actionRating,
      atEffects,
      totalStrength,
      countersRevealed: false,
      detail:
        `4.9b：${sideLabel(owner)} 在该格公布 行动值 ${actionRating}、反坦克效果 ${atEffects}、` +
        `战斗值总值 ${totalStrength}（**不展示具体算子**，4.9a 规定除外）`,
    }
  }

  /* ────────────────────────────── 展示结论（界面据此画 / 隐） ────────────────────────────── */

  /** 某格对当前观察方的展示结论（4.9a：己方全见 / 敌方只见最上方） */
  function displayOf(hex: HexRef): HexDisplay {
    return hexDisplay({
      viewer: fogDisabled.value ? null : viewerSide.value,
      hex,
      units: fogUnitsAt(hex),
      facts: factsFor(hex),
      reveal: revealFor(hex),
    })
  }

  /**
   * 渲染用：某格对当前观察方**可见的算子 id**（敌方格只给最上方两枚；枚数不外露）
   *
   * solo（`fogDisabled`）传 `viewer: null` ⇒ 全部可见（见 `fogDisabled` 的依据）。
   */
  function visibleUnitIdsInHex(hex: HexRef): readonly string[] {
    return visibleUnitIds({
      viewer: fogDisabled.value ? null : viewerSide.value,
      units: fogUnitsAt(hex),
    })
  }

  /** 某格是否对观察方隐藏了内容（界面可提示「有隐藏单位」，但**不得**显示枚数）；solo 恒 false */
  function hasHiddenContent(hex: HexRef): boolean {
    if (fogDisabled.value) return false
    const units = fogUnitsAt(hex)
    const own = units.filter((unit) => unit.side === viewerSide.value).length
    return own < units.length
  }

  /** 4.8b：当前观察方（作为所有者）的堆叠顺序合规提示（不替玩家重排） */
  const stackOrderIssues = computed<readonly { hex: HexRef; issue: StackOrderIssue }[]>(() =>
    occupiedHexes.value.flatMap((hex) => {
      const units = fogUnitsAt(hex).filter((unit) => unit.side === viewerSide.value)
      if (units.length === 0) return []
      return engineStackOrderIssues(units, factsFor(hex)).map((issue) => ({ hex, issue }))
    }),
  )

  /* ────────────────────────────── 交接（热坐切屏） ────────────────────────────── */

  /** 2.2：交接到对手方；启用热坐（pvp/pve）时亮起交接屏（未确认前不显示盘面）；solo 直接切方 */
  function beginHandoff(): void {
    workbench.setActiveSide(opponentSide.value)
    handoffPending.value = hotseatEnabled.value
  }

  /** 确认交接：接手方已就位，亮出盘面（回到 4.9 的可见性纪律） */
  function confirmHandoff(): void {
    handoffPending.value = false
  }

  /** 反悔：把行动方改回原方（仅在交接屏未确认时可用） */
  function cancelHandoff(): void {
    if (!handoffPending.value) return
    workbench.setActiveSide(opponentSide.value)
    handoffPending.value = false
  }

  /**
   * 切换对局模式（B36）
   *
   * 换到 `solo` 时顺手收掉交接屏（否则会留一块"没人接手"的遮罩）；换到 pvp/pve 即恢复热坐纪律。
   * 模式**不写进存档**（本步范围：它是本机偏好，不是盘面事实）——已在回执里如实登记。
   */
  function setMode(next: HotseatMode): void {
    mode.value = next
    if (!hotseatEnabled.value) handoffPending.value = false
  }

  /** 开关热坐交接（单人试算可关掉）——保留旧入口：关＝切到 solo、开＝切回 pvp */
  function setHotseatEnabled(on: boolean): void {
    setMode(on ? 'pvp' : 'solo')
  }

  /** 模式的中文名与说明（界面直接取，不各处硬写） */
  const MODE_LABELS: readonly { key: HotseatMode; label: string; note: string }[] = [
    { key: 'solo', label: 'SOLO（单人）', note: '不遮交接屏，双方内容都可见（无对手可隐瞒）' },
    { key: 'pvp', label: 'PVP（双人热坐）', note: '交接亮屏；信息纪律按 4.9a 裁剪' },
    { key: 'pve', label: 'PVE（人机）', note: '**未实现**：本轮只登记该模式，行为与 PVP 相同' },
  ]

  return {
    // 状态
    mode,
    setMode,
    MODE_LABELS,
    fogDisabled,
    hotseatEnabled,
    handoffPending,
    // 观察方
    viewerSide,
    opponentSide,
    handoffNotice,
    // 纪律
    policy,
    rollVisibleToViewer,
    // 展示
    occupiedHexes,
    displayOf,
    visibleUnitIdsInHex,
    hasHiddenContent,
    inCombat,
    revealFor,
    stackOrderIssues,
    // 交接
    beginHandoff,
    confirmHandoff,
    cancelHandoff,
    setHotseatEnabled,
    // 规则号（供界面直接标注，避免各处硬写字面量）
    FOG_RULE,
    STACK_ORDER_RULE,
  }
})
