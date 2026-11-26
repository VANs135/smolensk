import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { scenarios } from '@/data'
import { actingSideFor } from '@/engine/game-lifecycle'
import type { SaveHotseat } from '@/engine/save-file'
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
import {
  airCombatRatingOf,
  supplyStatusOf,
  type ConsoleAirUnit,
  type ConsoleUnit,
} from './workbench-model'

/**
 * 切方与信息展示纪律（W7 C13）
 *
 * ## 它解决什么
 *   1. **观察方由玩家手动选定**（用户 2026-11-11 口径）：轮到对方行动时**不再遮挡换手、
 *      也不再自动切视角**；`viewerSide` 只由 `setViewerSide` 改写，玩家自己决定看哪一方；
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
   * 对局模式（B36；用户口径 #7；2026-11-09 前移到选剧本）
   *
   *   · `null`：**尚未选择** —— 选剧本页必须显式选一个，未选不得进入初设；
   *   · `pvp`：双人同机热坐 —— 换手**不遮屏、不自动切视角**（玩家自选看哪一方），信息纪律按 4.9a 裁剪；
   *   · `solo`：单人（自己跟自己推演）—— **双方内容都可见**（见 `fogDisabled`）；
   *   · `pve`：人机 —— AI 打 `aiSide` 指定的一方，玩家操作另一方（AI 只走既有具名入口）。
   */
  const mode = ref<HotseatMode | null>(null)

  /** PVE 下 AI 控制的一方（PVP/solo 恒为 null；换模式即清空，逼出一次显式选择） */
  const aiSide = ref<Side | null>(null)

  /**
   * 初设已开始 ⇒ 模式锁定（用户口径：初设一旦开始就不可再改）
   *
   * 由 `setup.enterSetup` 成功进入初设时调用 `lockMode()`；换剧本（`selectScenario`）是
   * 唯一的新局入口，会 `resetModeLock()` 让玩家重新选。
   */
  const setupLocked = ref(false)

  /** 模式选择的缺口说明（null ＝ 已选齐、可进初设） */
  const modeIssue = computed<string | null>(() => {
    if (mode.value === null) return '请先选择对局模式（PVE / PVP / solo）'
    if (mode.value === 'pve' && aiSide.value === null) return 'PVE 需要指定 AI 控制的一方'
    return null
  })

  /** 模式是否选齐（初设入口的唯一放行条件） */
  const modeReady = computed<boolean>(() => modeIssue.value === null)

  /**
   * 棋桌「对局模式」闸门是否要开（读档后未记模式时）
   *
   * 判据是「没选齐 **或** 还没确认锁定」：`modeIssue` 只覆盖前者，选完单选就变 null
   * ⇒ 视图若只读它，面板会在玩家点「确认并继续」（`lockMode`）之前自己消失，
   * `setupLocked` 永远停在 false（模式随时可改）。故闸门必须以本判据为准。
   */
  const modeGateNeeded = computed<boolean>(() => modeIssue.value !== null || !setupLocked.value)

  /** 一键预设的归属方：只有 PVE 才预设，且只预设 AI 一方；PVP/solo 恒 null（不替任何人落位） */
  const presetSide = computed<Side | null>(() => (mode.value === 'pve' ? aiSide.value : null))
  const canPreset = computed<boolean>(() => mode.value === 'pve' && aiSide.value !== null)

  /**
   * 是否双人/人机同机对局（pvp / pve；solo 与「尚未选择」都不算）
   *
   * ★ 由 `mode` **推出**（一个来源）。2026-11-11 起它**只**表示对局组织方式，
   *   不再驱动任何遮屏或自动切视角。
   */
  const hotseatEnabled = computed<boolean>(() => mode.value === 'pvp' || mode.value === 'pve')

  /**
   * **战雾是否关闭**（solo：桌边只有一个玩家，没有要隐瞒的对手）
   *
   * 依据：4.9a 的"不得看穿**敌方**堆叠"与专规 1.4 的"外盒对**对手**隐藏"都是对手之间的约定。
   * 关掉后 `displayOf` / `visibleUnitIdsInHex` 传 `viewer: null`（引擎里的一条分支），
   * 于是堆叠明细、枚数、状态都照实给 —— 这不是"放宽规则"，而是没有对手时那两条约定无从适用。
   */
  const fogDisabled = computed<boolean>(() => mode.value === 'solo')

  /* ────────────────────────────── 观察方（玩家手动选定） ────────────────────────────── */

  /** 当前决策方（2.2：行动方就是能看到己方全貌的一方） */
  const decisionSide = computed<Side>(() => {
    if (session.question !== null) return session.question.responder
    const attacker =
      actingSideFor({ phase: workbench.phase, activeSide: workbench.activeSide }) ??
      workbench.activeSide
    return workbench.engagementDecisionRole === 'defender' ? otherSide(attacker) : attacker
  })

  /**
   * 当前观察方（**玩家手动选定，不随行动方自动切换**）
   *
   * 用户 2026-11-11 口径：轮到对方玩家行动时不再自动切屏/切视角，玩家自己决定看哪。
   * 本 ref 只由 `setViewerSide` 改写；全文件没有任何 watch 会因为 `decisionSide` 变化而改它。
   */
  const viewerSide = ref<Side>(workbench.activeSide)
  watch(
    viewerSide,
    () => {
      workbench.selectedId = null
      workbench.movePick = null
    },
    { flush: 'sync' },
  )

  /** 手动切观察方（只改视角；不翻行动方、不遮屏、不触发交接） */
  function setViewerSide(next: Side): void {
    viewerSide.value = next
  }

  /**
   * **本局玩家自己执的一方**（用户 2026-11-18：视角默认值必须跟玩家阵营一致）
   *
   *   · `pve`：AI 执 `aiSide` ⇒ 玩家执另一方（未指定 AI 方时无解，返回 null）；
   *   · `pvp` / `solo`：同机没有"唯一玩家方"，返回 null（默认跟行动方，见 `defaultViewerSide`）。
   */
  const playerSide = computed<Side | null>(() => {
    if (mode.value !== 'pve' || aiSide.value === null) return null
    return otherSide(aiSide.value)
  })

  /**
   * 视角方的**默认值**（选完模式 / 换 AI 方 / 换剧本时用）
   *
   *   · `pve` ⇒ 玩家执的一方（AI 方选定后才有解；未选定 ⇒ null＝保持当前）；
   *   · `pvp` / `solo` ⇒ 行动方（热座双方轮流动，开局跟先手方；solo 无对手、双方内容都可见）；
   *   · 尚未选模式 ⇒ null＝保持当前（主页时的行动方，不要凭空改写）。
   *
   * 依据：4.9a 的"不得看穿敌方"只对**对手**成立 ⇒ 人机里玩家的视角就是自己一方；
   * 热座/solo 没有唯一玩家方，跟行动方是最不会误导的默认（且玩家仍可手动切）。
   */
  function defaultViewerSide(): Side | null {
    if (mode.value === null) return null
    if (mode.value === 'pve') return playerSide.value
    return workbench.activeSide
  }

  /**
   * 把视角方**重置为默认值**（用户 2026-11-18 第 3 条：换阵营/换局不留上一局的旧值）
   *
   * 只在"模式/执方/剧本"这类**对局组织方式**变化时调用；对局中的行动方轮转**不**触发
   * （2026-11-11 口径：轮到对方行动不自动切视角）。
   */
  function syncViewerToDefault(): void {
    const next = defaultViewerSide()
    if (next !== null) viewerSide.value = next
  }

  /** 对手方（相对**观察方**；如地图画敌方 ZOC） */
  const opponentSide = computed<Side>(() => otherSide(viewerSide.value))

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
    // 12.6 / 4.5：唯一派生（`supplyStatusOf`）—— 12.8e 续命当回合不算断补
    const supply = supplyStatusOf(unit, workbench.turn)
    return {
      id: unit.instanceId,
      side: unit.side,
      name: unit.name,
      kind: 'ground',
      isCombat: unit.isCombat,
      attackCapable: unit.attackCapable,
      inCombatMode,
      // 4.5：可攻击 ∧ 战斗模式 ∧ 非断补（与 zoc.ts 同一判据）
      projectsZoc: unit.attackCapable && inCombatMode && !supply.marked,
      mode: unit.mode.mode,
      dg: unit.mode.dg,
      outOfSupply: supply.marked,
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

  /** 一架飞机的战雾视图（4.8b E / 4.9a 的「最上方激活飞机」） */
  function fogAirView(air: ConsoleAirUnit): FogUnitView {
    return {
      id: air.instanceId,
      side: air.side,
      name: air.name,
      kind: 'air' as const,
      isCombat: false,
      attackCapable: false,
      inCombatMode: false,
      projectsZoc: false,
      airStatus: air.airStatus,
    }
  }

  /**
   * 档2性能：按格索引战雾视图
   *
   * `fogUnitsAt` 原实现每查一格都 `workbench.units.filter(...)` 全表扫描；`fogVisibleTokens`
   * 对每一枚敌牌各查一次其所在格，347 枚/百格时单步约 18ms。
   * 这里一次建 `格 -> 视图[]`，查询 O(1)；任一单位的战雾字段变化时 computed 整体重建，
   * 仍是 347 次 `toFogUnit`，但不再有 O(枚数 × 格数) 的扫描。
   */
  const fogUnitsByHex = computed<ReadonlyMap<string, FogUnitView[]>>(() => {
    const byHex = new Map<string, FogUnitView[]>()
    const push = (hex: HexRef, view: FogUnitView): void => {
      const key = `${hex.col}.${hex.row}`
      const list = byHex.get(key)
      if (list === undefined) byHex.set(key, [view])
      else list.push(view)
    }
    for (const unit of workbench.units) push(unit.hex, toFogUnit(unit))
    for (const air of workbench.onMapAirUnits) push(air.hex, fogAirView(air))
    return byHex
  })

  /** 该格的战雾视图序列（地面先、飞机后 —— 4.8b E 要求激活飞机在所有地面单位之上） */
  function fogUnitsAt(hex: HexRef): FogUnitView[] {
    return fogUnitsByHex.value.get(`${hex.col}.${hex.row}`) ?? []
  }

  /** 图上全部有算子的格（渲染与提示遍历用） */
  const occupiedHexes = computed<HexRef[]>(() => {
    const hexes: HexRef[] = []
    const seen = new Set<string>()
    const push = (hex: HexRef): void => {
      const key = `${hex.col}.${hex.row}`
      if (seen.has(key)) return
      seen.add(key)
      hexes.push({ ...hex })
    }
    for (const unit of workbench.units) push(unit.hex)
    for (const air of workbench.onMapAirUnits) push(air.hex)
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

  /**
   * 切换对局模式（B36；2026-11-09 前移到选剧本 + 初设后锁定）
   *
   * 返回是否改动：初设已开始（`setupLocked`）⇒ 拒绝，模式不可再改。
   * 离开 PVE 时清空 `aiSide`，下次进 PVE 必须重新点一次 AI 方。
   * 模式随存档保存（`hotseat: { mode, aiSide }`）——它只记录组织方式，不参与规则判定。
   */
  function setMode(next: HotseatMode | null): boolean {
    if (setupLocked.value) return false
    mode.value = next
    if (next !== 'pve') aiSide.value = null
    // 用户 2026-11-18：模式一变就把视角默认值跟上（PVE 选定 AI 方时再同步一次）
    syncViewerToDefault()
    return true
  }

  /** 指定 PVE 的 AI 控制方（初设后同样锁定；非 PVE 下不登记） */
  function setAiSide(next: Side | null): boolean {
    if (setupLocked.value) return false
    if (mode.value !== 'pve') return false
    aiSide.value = next
    // 用户 2026-11-18：玩家执的一方＝AI 的另一方 ⇒ 视角默认值随之更新，不留上一局的旧值
    syncViewerToDefault()
    return true
  }

  /** 初设开始 ⇒ 锁定模式（`setup.enterSetup` 成功后调用） */
  function lockMode(): void {
    setupLocked.value = true
    // 用户 2026-11-18：进初设即按玩家阵营归位视角（PVE ⇒ 非 AI 方；热座/solo ⇒ 行动方）
    syncViewerToDefault()
  }

  /** 换剧本 ＝ 重开一局 ⇒ 解锁，让玩家在选剧本页重新定模式 */
  function resetModeLock(): void {
    setupLocked.value = false
    // 用户 2026-11-18：换局不留上一局的旧视角（随后 `lockMode` 进初设时还会再同步一次）
    syncViewerToDefault()
  }

  /**
   * 存档用：当前对局组织方式
   *
   * 尚未选择（`mode === null`）⇒ `undefined`，存档不写该键（读回仍是「未设置」）。
   */
  function snapshotForSave(): SaveHotseat | undefined {
    if (mode.value === null) return undefined
    return { mode: mode.value, aiSide: aiSide.value }
  }

  /**
   * 读档后恢复
   *
   *   · 档里有 ⇒ 原样恢复，并视为**已锁定**（这一局早就开始了，初设不可再进）；
   *   · 档里没有 ⇒ 读成「未设置」：`mode=null`、解锁，等玩家在棋桌重选后才继续；
   *     选择前 AI 不接管（`aiControlMode` 由 mode 推出）、热坐遮罩也不按 PVP 口径亮起。
   */
  function restoreFromSave(saved: SaveHotseat | undefined): void {
    /*
     * 2026-11-14：读档时观察方**归位到档内行动方**。
     * 建店时 `viewerSide` 取的是当时（主页）的 `activeSide`＝axis；读一份苏军回合的档后
     * `activeSide` 变成 soviet 而观察方仍停在 axis，`canOpenCounterContext` /
     * `counterActionsAt` 的「观察方＝行动方」闸门把整张盘的右键菜单全挡掉（表现成"某格没菜单"）。
     * 这是读档初始化，不属于「对局中随行动方自动切视角」，与 2026-11-11 口径不冲突。
     */
    viewerSide.value = workbench.activeSide
    if (saved === undefined) {
      mode.value = null
      aiSide.value = null
      setupLocked.value = false
      return
    }
    mode.value = saved.mode
    aiSide.value = saved.mode === 'pve' ? saved.aiSide : null
    setupLocked.value = true
    /*
     * 用户 2026-11-18：读档也按**玩家阵营**归位视角（PVE ⇒ 非 AI 方）。
     * 上面已先把观察方设成档内行动方；这里只在有明确默认值时覆盖（pvp/solo 仍跟行动方）。
     */
    syncViewerToDefault()
  }

  // 把「模式随档保存 / 读档恢复」挂到会话层的存档口（与 board/setup 编解码器同一惯例）
  session.setHotseatCodec({ capture: snapshotForSave, restore: restoreFromSave })

  /** 模式的中文名与说明（界面直接取，不各处硬写） */
  const MODE_LABELS: readonly { key: HotseatMode; label: string; note: string }[] = [
    { key: 'solo', label: 'SOLO（单人）', note: '同一人操作双方；双方内容都可见' },
    {
      key: 'pvp',
      label: 'PVP（双人热坐）',
      note: '换手不遮屏、不自动切视角（玩家自选看哪一方）；信息纪律按 4.9a 裁剪',
    },
    { key: 'pve', label: 'PVE（人机）', note: 'AI 打一方、玩家打另一方；AI 只走既有具名入口' },
  ]

  /**
   * 2026-11-21：**脚本接管的一方**（教学等固定流程用）
   *
   * 教学模式不是另一种对局类型，而是 **PvE 外壳**：玩家执一方、UI 与隐藏信息照常隔离，
   * 玩家按引导操作；苏军的行动由 `tutorial.ts` 的脚本固定代替 AI 决策。
   * 登记期间通用 AI 一律让位 —— 否则同一个 `airInputs` 会被脚本和 AI 抢写。
   * 教学在 `startFor()` 登记 `'soviet'`、`stop()` 清空。
   */
  const scriptedSide = ref<Side | null>(null)
  function setScriptedSide(side: Side | null): void {
    scriptedSide.value = side
  }

  /**
   * 2026-11-21（用户口径）：**教学模式的入口是单独的**
   *
   * 玩家不需要在选剧本页先选 PVE/PVP —— 教学自带 PvE 外壳：玩家执一方（轴心）、
   * 苏军是 AI、视角与隐藏信息照常隔离。故这里无视 `setupLocked`（从教学入口进来时
   * 模式可能还没定、甚至初设已经锁），直接落定外壳并归位视角。
   */
  function adoptTutorialShell(): void {
    mode.value = 'pve'
    aiSide.value = 'soviet'
    syncViewerToDefault()
  }

  /*
   * 2026-11-21：拦截由拦截方自己决定（14.5）
   *
   * 判据是**语义判据**，不是 `mode === 'pve'`：拦截方由引擎定（`airInterceptionResponse`
   * 用 `enemySide` 出候选），所以只要「候选拦截机的阵营 === AI 阵营」，拦截就归 AI。
   * 这样教学模式与普通 PvE 走同一条规则，但各有各的驱动者：
   *   · 教学 → 由 `tutorial.ts` 的脚本决定（本 watch 因 `scriptedSide` 让位，不插手）；
   *   · 普通 PvE → 由本 watch 的通用 AI 决定。
   */
  watch(
    () =>
      `${String(mode.value)}|${String(aiSide.value)}|${String(scriptedSide.value)}|${String(workbench.airState?.step ?? '')}|${String(workbench.airState?.interception?.declared ?? false)}|${String(workbench.airInterceptorCandidates.length)}`,
    () => {
      if (aiSide.value === null) return
      // 脚本接管时不插手：教学有自己的定死流程
      if (scriptedSide.value !== null) return
      if (workbench.airState?.step !== 'interception') return
      if (workbench.airState.interception?.declared === true) return
      const candidates = workbench.airInterceptorCandidates
      if (candidates.length === 0) return
      // 拦截方＝候选机的阵营（引擎按 enemySide 出候选）；拦截方不是 AI 就不归 AI 决定
      const intercepting = candidates[0]?.side ?? null
      if (intercepting !== aiSide.value) return
      // 14.1b：ACV 取当前面，与引擎缺省口径一致
      const best = candidates.reduce((a, b) =>
        airCombatRatingOf(b) > airCombatRatingOf(a) ? b : a,
      )
      workbench.airInputs = {
        ...workbench.airInputs,
        interceptDeclared: true,
        interceptorId: best.instanceId,
      }
      workbench.declareInterceptionNow()
    },
    { flush: 'post' },
  )

  return {
    // 状态
    mode,
    // 脚本接管的一方（教学等固定流程；登记后通用 AI 让位）
    scriptedSide,
    setScriptedSide,
    // 教学入口专用：直接落定 PvE 外壳（玩家不必另选模式）
    adoptTutorialShell,
    aiSide,
    setupLocked,
    modeIssue,
    modeReady,
    modeGateNeeded,
    presetSide,
    canPreset,
    setMode,
    setAiSide,
    lockMode,
    resetModeLock,
    snapshotForSave,
    restoreFromSave,
    MODE_LABELS,
    fogDisabled,
    hotseatEnabled,
    // 观察方（玩家手动选，不随行动方自动切）
    decisionSide,
    viewerSide,
    setViewerSide,
    playerSide,
    defaultViewerSide,
    syncViewerToDefault,
    opponentSide,
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
    // 规则号（供界面直接标注，避免各处硬写字面量）
    FOG_RULE,
    STACK_ORDER_RULE,
  }
})
