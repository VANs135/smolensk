/**
 * C9 第 1 步的派生（环节 / 加机余量 / 参战机阵列 / 基地分组 / 图外盒 / 环节闸）
 *
 * 从 `workbench.ts` 整段搬出（B3-2b22）：9 个值声明 / 206 行，外加从前邻后段前移的
 * `airMissionAllowedInPhase`（9 行，物理在轰炸入口闸之前，语义属本节 —— 它的消费点只有
 * 本切片的 `airMissionJoinChoices` 与 facade 的 `bombingEntryEligible`）。函数体零改写。
 * 两个 `interface AirMissionBaseRosterItem` / `AirMissionBaseRoster` 只被本节用，不导出。
 * 端口 22 项 = 13 依赖 + 9 返回；依赖全部按值（装配点就在原声明位置）。
 */
import { computed, ref } from 'vue'
import type { HexRef, Side } from '@/data'
import {
  airBoxEdgeColumn,
  canAddAircraftAtStep,
  canFlyMission,
  canJoinMission,
  canMissionInPhase,
  canPerformMissionThisPhase,
  missionSegmentOf,
  SHORT_RANGE_BARRAGE_HEXES,
} from '@/engine/rules'
import type { AirInteractionState, AirMissionKind, AirMissionSegment } from '@/engine/rules'
import type { AirMissionJoinChoice, ConsoleAirUnit, ConsolePhase } from './workbench-model'

export interface AirMissionDerivedDeps {
  /** 当前任务类型（null＝未选，分组与阵列都返回空） */
  airMissionKind: { value: AirMissionKind }
  /** 已勾选的参战机体 */
  airMissionAirIds: { value: string[] }
  /** 14.2f-B 的选定任务格（未定则距离留空） */
  airTargetHex: { value: HexRef | null }
  /** 交互状态机（14.2f 加机窗口看 step） */
  airState: { value: AirInteractionState | null }
  /** 14.1g / 专规 2.2d 判「本阶段能否出击」用的一方 */
  airActingSide: { value: Side }
  /** 本方空军单位 */
  ownAirUnits: { readonly value: readonly ConsoleAirUnit[] }
  /** 本方空军基地（15.0/15.2 的等级与简易机场） */
  ownAirBases: {
    readonly value: readonly { id: string; hex: HexRef; level: number; isAirstrip?: boolean }[]
  }
  /** 停在该格的飞机 */
  airUnitsAt: (hex: HexRef, side: Side) => readonly ConsoleAirUnit[]
  /** 该机型能不能执行该任务类型 */
  airTypeCanPerformKind: (air: ConsoleAirUnit, kind: AirMissionKind) => boolean
  /** 到真实基地的航程（14.2d 格距同源） */
  airDistanceFromRealBase: (air: ConsoleAirUnit, hex: HexRef) => number
  /** 是否停在图外空军盒（14.9 的离图盒） */
  isAirInOffMapBox: (air: ConsoleAirUnit) => boolean
  /** 地图悬停高亮通道 */
  setHoverHex: (hex: HexRef) => void
  /** 当前阶段（环节闸的输入） */
  phase: { value: ConsolePhase }
}

export function createAirMissionDerivedDomain(deps: AirMissionDerivedDeps) {
  const {
    airMissionKind,
    airMissionAirIds,
    airTargetHex,
    airState,
    airActingSide,
    ownAirUnits,
    ownAirBases,
    airUnitsAt,
    airTypeCanPerformKind,
    airDistanceFromRealBase,
    isAirInOffMapBox,
    setHoverHex,
    phase,
  } = deps

  /**
   * 专规 2.2d / 14.1g：**本阶段本方能否出击**（空军任务全链共用一条判据）
   *
   * 修前只有 `airMissionJoinChoices` 判这一条，`bombingEntryEligible` 只看环节闸 ⇒
   * 苏军进击段右键敌方格仍出「轰炸」，点进去参战机阵列是空的、宣布时才被 专规 2.2d 拒。
   */
  const airMissionAllowedInPhase = computed<boolean>(() => {
    const airPhase =
      phase.value === 'reaction'
        ? 'reaction'
        : phase.value === 'exploitation'
          ? 'exploitation'
          : 'movement'
    return canMissionInPhase(airActingSide.value, airPhase)
  })

  /** C9 14.2e：当前任务类型所属的**环节**（移动 / 轰炸 / 拦截步），供界面标注与路由 */
  const airMissionSegment = computed<AirMissionSegment>(() =>
    missionSegmentOf(airMissionKind.value),
  )

  /** C9：本阶段还能加几架（14.2a 的余量；供界面禁用按钮与提示） */
  const airJoinRemaining = computed<number>(() => {
    const limit = canJoinMission(0, 0)
    const max = limit.ok ? limit.data.limit : 0
    return Math.max(0, max - airMissionAirIds.value.length)
  })

  /**
   * B14（用户口径⑪）：**参战机**的算子图阵列数据（逐机给出可选性与原因）
   *
   * 面板原先是一排文字按钮（名字 + ✓），既看不出是哪一枚算子，也看不出**为什么点不动**。
   * 四道闸都用引擎的唯一实现，本处只把结论逐机摊开：
   *   · **14.1a** 激活状态（`canFlyMission`；非激活飞机不能执行任务，需先按 14.1d 整备 15.1）；
   *   · **14.2f** 加机窗口（`canAddAircraftAtStep`；任务过移动步后不能再加）；
   *   · **14.2a** 一次任务合计上限（`canJoinMission`）；
   *   · **14.2e** 同一机一阶段只执行一次任务（`canPerformMissionThisPhase`）。
   * 已选中飞机的减机由 `toggleAirMissionUnit` 检查主动返航窗口。
   *
   * ★ 14.1a 的「起飞机必须停在本方空军基地格」**不在本闸内**：那条在**宣布任务**时
   *   由 `beginAirMissionNow` 经引擎裁定（此处标不了，也不该由界面去猜）。
   */
  const airMissionJoinChoices = computed<readonly AirMissionJoinChoice[]>(() => {
    /*
     * 专规 2.2d：苏军不得在本方反应 / 进击阶段出击（通规 14.1g 允许三段，专规覆盖苏联）。
     * 不可用的机不就该列进「参战机」阵列 —— 修前它照列，点进窗口后才在宣布时被 专规 2.2d 拒。
     * 引擎侧判据仍在 `beginAirMissionNow`（旁路直接写状态仍会被拒）。
     */
    if (!airMissionAllowedInPhase.value) return []
    const step = airState.value?.step
    const canAdd = step === undefined ? true : step === 'done' ? false : canAddAircraftAtStep(step)
    const limit = canJoinMission(0, 0)
    const max = limit.ok ? limit.data.limit : 0
    const selectedCount = airMissionAirIds.value.length
    return ownAirUnits.value.map((air) => {
      const selected = airMissionAirIds.value.includes(air.instanceId)
      const disabledReason = selected
        ? null
        : !canFlyMission(air.airStatus)
          ? '14.1a：非激活飞机不能执行任务（14.1d：需在整备阶段 15.1 整备后才转激活）'
          : !canAdd
            ? `14.2f：任务已过移动步（当前 ${String(step)}）⇒ 不能再加机`
            : airMissionKind.value === 'hip_shoot' && selectedCount >= 1
              ? '14.7d-B：低空扫射必须由**单独一个**飞机完成 ⇒ 已选 1 架'
              : selectedCount >= max
                ? `14.2a：一次任务合计上限 ${max} 架 ⇒ 已满`
                : canPerformMissionThisPhase(air.missionsFlownThisPhase)
                  ? // 条 19（A1）：**按航程列机** —— 已定任务格时，够不到目标格的机在阵列里灰显（14.1）
                    airTargetHex.value !== null &&
                    airDistanceFromRealBase(air, airTargetHex.value) > air.rangeHexes
                    ? '14.1：该机航程够不到任务格'
                    : null
                  : '14.2e：本机本阶段已执行过一次任务'
      return { air, selected, disabledReason }
    })
  })

  /**
   * 用户 2026-11-09 追加批：**空军任务窗口按基地分栏**（只在轰炸 / 低空扫射时展开）
   *
   * 目的：玩家要判断 14.7c 的短程修正（全体参战机都在起飞基地 10 格内）时，得先把
   * 「哪架机在哪座基地、离任务格几格」摆在一屏。这里只做**分组与事实**，不判规则：
   *   · 基地＝本方空军基地（`ownAirBases`，15.0/15.2 的等级与简易机场照旧）；
   *   · 驻机＝该基地格上的本方飞机（`airUnitsAt`，只列停在这里的，不跨格凑数）；
   *   · 可选性 / 不可选原因直接取 `airMissionJoinChoices`（14.1a/14.2a/14.2e/14.1），
   *     本处不另写一份判据；
   *   · 距离＝到当前任务格的格距（14.2d），任务格未定就留空，不拿默认格去猜；
   *   · `withinShortRange` 只报「≤10 格」这一条**原文事实**（14.7c），且只在轰炸任务上
   *     有意义（低空扫射没有这条修正）；加成结论仍由引擎在宣布任务时给。
   */
  interface AirMissionBaseRosterItem {
    air: ConsoleAirUnit
    selected: boolean
    disabledReason: string | null
    distanceToTarget: number | null
    inRange: boolean | null
    withinShortRange: boolean
  }
  interface AirMissionBaseRoster {
    baseId: string
    hex: HexRef
    level: number
    isAirstrip: boolean
    aircraft: AirMissionBaseRosterItem[]
  }

  /** 最近一次点开的基地（面板上高亮这一栏；地图高亮走 `hoverHex`） */
  const airMissionBaseFocus = ref<string | null>(null)

  const airMissionBaseGroups = computed<AirMissionBaseRoster[]>(() => {
    // 用户 2026-11-12：所有主动任务都按基地分组列参战机（不再只限轰炸/低空扫射）
    if (airMissionKind.value === null) return []
    const side = airActingSide.value
    const target = airTargetHex.value
    const choices = new Map(
      airMissionJoinChoices.value.map((choice) => [choice.air.instanceId, choice] as const),
    )
    return ownAirBases.value
      .map((base) => {
        const aircraft = airUnitsAt(base.hex, side)
          // 用户 2026-11-12：只列能执行该任务的飞机（不能执行的整架不出现，不摆灰项）
          .filter((air) => airTypeCanPerformKind(air, airMissionKind.value as AirMissionKind))
          .map((air) => {
            const choice = choices.get(air.instanceId)
            const distance = target === null ? null : airDistanceFromRealBase(air, target)
            return {
              air,
              selected: choice?.selected ?? false,
              disabledReason:
                choice?.disabledReason ??
                (choice === undefined ? '14.2：本机不能执行该任务类型' : null),
              distanceToTarget: distance,
              inRange: distance === null ? null : distance <= air.rangeHexes,
              withinShortRange:
                airMissionKind.value === 'barrage' &&
                distance !== null &&
                distance <= SHORT_RANGE_BARRAGE_HEXES,
            }
          })
        return {
          baseId: base.id,
          hex: base.hex,
          level: base.level,
          isAirstrip: base.isAirstrip === true,
          aircraft,
        }
      })
      .filter((group) => group.aircraft.length > 0)
  })

  /**
   * 规格 §4（2026-11-10 裁定③）：**图外空军盒＝独立基地分组**
   *
   * 2.1C 只禁「地图外储存区域内不允许进行战斗」，未禁从盒里出击 ⇒ 盒内驻机
   * 与图上基地同构地参与第 1 步候选（取机范围、可选性、距离都与图上基地同一套）。
   * 盒没有真实格号 ⇒ `hex` 只取「盒连接列 × 目标行」作显示锚点（与 `airDistanceFromRealBase` 同源）。
   */
  const AIR_BOX_GROUP_ID = '__offmap_air_box__'

  const airBoxMissionGroup = computed<AirMissionBaseRoster | null>(() => {
    if (airMissionKind.value === null) return null
    const planes = ownAirUnits.value
      .filter((air) => isAirInOffMapBox(air))
      // 用户 2026-11-12：与图上基地同口径，只列能执行该任务的机型
      .filter((air) => airTypeCanPerformKind(air, airMissionKind.value as AirMissionKind))
    if (planes.length === 0) return null
    const choices = new Map(
      airMissionJoinChoices.value.map((choice) => [choice.air.instanceId, choice] as const),
    )
    const target = airTargetHex.value
    const aircraft = planes.map((air) => {
      const choice = choices.get(air.instanceId)
      const distance = target === null ? null : airDistanceFromRealBase(air, target)
      return {
        air,
        selected: choice?.selected ?? false,
        disabledReason: choice?.disabledReason ?? null,
        distanceToTarget: distance,
        inRange: distance === null ? null : distance <= air.rangeHexes,
        withinShortRange:
          airMissionKind.value === 'barrage' &&
          distance !== null &&
          distance <= SHORT_RANGE_BARRAGE_HEXES,
      }
    })
    return {
      baseId: AIR_BOX_GROUP_ID,
      hex: { col: airBoxEdgeColumn(airActingSide.value), row: target?.row ?? 0 },
      level: 0,
      isAirstrip: false,
      aircraft,
    }
  })

  /** 第 1 步候选分组：图上各基地（既有）＋ 图外盒（独立一组，同构） */
  const airMissionBaseGroupsWithBox = computed<AirMissionBaseRoster[]>(() => {
    const box = airBoxMissionGroup.value
    return box === null ? airMissionBaseGroups.value : [...airMissionBaseGroups.value, box]
  })

  /** 点某座基地 ⇒ 面板聚焦该栏 + 地图高亮该格（高亮通道就是已有的 `setHoverHex`） */
  function focusAirMissionBase(baseId: string): boolean {
    const base = ownAirBases.value.find((item) => item.id === baseId)
    if (base === undefined) return false
    airMissionBaseFocus.value = baseId
    setHoverHex(base.hex)
    return true
  }

  /**
   * 条 19（A1）：**按航程**判断——本方是否有**可出击**的飞机够得到目标格
   *
   * 用于「点地面格出空军对话框」的入口闸门（点一格才决定要不要开空军会话）。
   * 判据与 `barrageAirFacts` 的 `inRange` 同源：`airRangeFromBase(air, hex) <= air.rangeHexes`，
   * 另要求 14.1a 的 `canFlyMission`（非激活不出击）。真正航程校验仍在 `beginAirMissionNow`，
   * 此处只判"这一格值不值得开空军入口"。
   */
  function anyOwnAircraftReaches(hex: HexRef): boolean {
    return ownAirUnits.value.some(
      (air) => canFlyMission(air.airStatus) && airDistanceFromRealBase(air, hex) <= air.rangeHexes,
    )
  }

  /**
   * 公开面清单（P2）：原 facade `workbench.ts` return 区属于本域的键，搬回域内。
   *
   * 为什么搬：这批键是对外承诺的接口，以前登记在 facade 的 1,005 键 return 表里，
   * 于是任何本域改动都要去共享文件登记一次 —— 两人并行改 store 必在 return 区冲突。
   * 搬到域内后，本域的改动人只改本文件；facade 只留一行 `...xxx.publicSurface`。
   *
   * 纪律：增删对外键时**同步改这里的清单**，否则公开面快照（1,013 键）会红。
   */
  const publicSurface = {
    airMissionSegment,
    airJoinRemaining,
    airMissionJoinChoices,
    airMissionBaseGroups,
    airMissionBaseFocus,
    focusAirMissionBase,
    anyOwnAircraftReaches,
    airMissionBaseGroupsWithBox,
  }
  return {
    publicSurface,
    airMissionSegment,
    airJoinRemaining,
    airMissionJoinChoices,
    airMissionBaseFocus,
    airMissionBaseGroups,
    airMissionBaseGroupsWithBox,
    focusAirMissionBase,
    anyOwnAircraftReaches,
    airMissionAllowedInPhase,
  }
}
