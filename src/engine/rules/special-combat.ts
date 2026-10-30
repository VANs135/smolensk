import { rulesConstants } from '@/data'
import type { HexRef, Side } from '@/data'

import { hexDistance } from '../hex-geometry'
import { fail, succeed, type RuleOutcome } from '../result-types'
import type { GamePhase } from '../state-types'
import { captureLookup } from '../tables/capture'
import { resolveAirBaseCapture } from './air'
import { SP_TO_T } from './supply'
import { resolveExtenderCollapse, extenderDisplacementCandidates } from './supply-phase'

/**
 * 特殊战斗（B13，OCS 9.14）
 *
 * 「特殊战斗」＝**进入**某格时对格内**设施与后勤目标**的处置，与 9.0 的野战战斗是两套流程：
 * 它不看 CRT，而看夺取表（9.14b/c）与空军基地夺取表（9.14f）。触发前提统一是
 * **「（敌方）可攻击单位进入该格」**——故本模块第一个入参就是「是否有可攻击单位进入」。
 *
 * ## 条文索引（中文规则书 9.14）
 *   - 9.14a 战斗值为零的单位：打零战斗值守方 → 从**最右列**起查表（横移亦从最右列起算）；
 *           零战斗值方进攻 → 从**最左列**起（且**必须照常支付战斗补给**）；**双方皆零 → 1:1 列**。
 *           ★ 该列位口径由 B12 的 `battle.ts#battleColumnIndex` 统一实现（避免两处判据漂移），
 *           本模块不重复；测试里对其三种零战斗值组合做覆盖。
 *   - 9.14b 补给站：敌方可攻击单位进入有 dump 的格 → 查夺取表，**一部分 SP 被夺取**
 *           （取整到最近的 T），**其余补充被摧毁**
 *   - 9.14c 运输点数：**MA 大于 10 者合计**用「卡车」列、**MA 小于等于 10 者合计**用「马车」列
 *           （先把同类合并再掷骰，故取整发生在**组**这一层）；结果对**运输点数与装载其上的 SP**
 *           同等生效；被夺取的部分改归进入方，**其余位移**（类似撤退，由原主放置）；
 *           敌方单位、ZOC、禁入地形**都不影响位移**；**移动阶段**被夺取的运输点可**立即移动**
 *           （其他阶段不行）；运输点夺取取整到最近**整点**，**SP 夺取永远取整到最近的 T**；
 *           **重要提示：延补队永不受夺取表损失，也不计入卡车/马车总数，改为按 9.14d 崩溃**；
 *           混合类型（普通卡车与编内卡车、马车与骡子）时**由拥有者决定哪些被夺取、哪些被位移**
 *   - 9.14d 延补队崩溃：可攻击单位进入含延补队的格 → **必须崩溃**（位移到「特殊拖取距离」内、
 *           且该格**此时有追溯补给**的任意格；敌方单位/ZOC/禁入地形不影响；无损失与夺取；
 *           落点翻面到常规运输点数面）。**无合法格**时留在原格翻面，改按 9.14c 判夺取
 *   - 9.14e 环形工事：可攻击单位进入有敌环工事格 → 工事被夺取。
 *           ★ 降级取自通规 **21.11c（工事夺取降 1 级）**；本作专规 **1.3a** 规定地图印刷的永久工事
 *           不可降低、**1.3b** 规定任何一方都不得把工事提升到 1 级以上
 *   - 9.14f 空军基地：可攻击单位进入有敌方基地的格 → 基地被夺取且**可立即使用**；
 *           **无论天气**都要为格内**每架飞机**掷基地夺取表（+2 该机 Active；+2 由**战后推进**夺取）；
 *           幸存飞机**必须**转移到**距离 2 倍内**的任意友方空军基地并**变为非激活**；
 *           若 2 倍距离内没有友方基地则**摧毁**这些飞机
 *   - 9.14g/h 海军与港口：**本作不适用**（专规 1.1c：双方均无海运额度，港口仅装饰性；
 *           见项目决断「18.0 海军 / 19.0 港口不做」）
 *
 * ## 「初设归属」与「战斗后归属」的交互（本模块的核心模型）
 *   格内每件设施/后勤单位都带 `owner`：
 *     - `owner` 由**剧本初设**给出（剧本把 dump、运输点、空军基地、环形工事分配给某方），
 *       此后**只可能被「敌方可攻击单位进入该格」这一件事**改变；
 *     - 故判定第一步是**比较进入方与物件归属方**：相同 ⇒ 一律 `unchanged`（友军进入自家设施无效果）；
 *       不同 ⇒ 才走 9.14b/c/e/f 的处置；
 *     - 处置结果分：`captured`（归属改为进入方）、`destroyed`（dump 未被夺取的部分）、
 *       `displaced`（运输点残余被原主移走）、`ownerChoice`（混合类型由原主挑选谁被夺取）、
 *       `collapsed`（延补队崩溃位移）；
 *     - 「立即生效」的差别也落在归属上：空军基地被夺取后**可立即使用**（9.14f）；运输点只在
 *       **移动阶段**被夺取时才能**立即移动**（9.14c）——故结果里单独给出
 *       `capturedTransportMayMoveNow`，由命令层决定是否授予这些算子本阶段移动权。
 */

/* ────────────────────────────── 常量 ────────────────────────────── */

/** 9.14c 分组阈值：MA **大于** 10 归「卡车」列，**小于等于** 10 归「马车」列 */
export const TRANSPORT_TRUCK_MIN_MA = 10

/** 9.14f 基地夺取表的掷骰修正（+2 Active；+2 由战后推进夺取） */
export const AIR_BASE_CAPTURE_DRM = rulesConstants.combat.airBaseCaptureDrm

/* ────────────────────────────── 词表 ────────────────────────────── */

/** 9.14c 位移上限：运输点（格距；原文示例「最远 10 格」）——数值唯一出处 rules-constants.json */
export const TRANSPORT_DISPLACE_MAX_HEXES = rulesConstants.specialCombat.transportDisplaceMaxHexes

/** 会被「进入」改变归属的物件类别（9.14b/c/d/e/f） */
export type SpecialObjectKind = 'dump' | 'transport' | 'extender' | 'airBase' | 'hedgehog'

/** 运输点分组（9.14c 的两列） */
export type TransportGroup = 'trucks' | 'wagons'

/** 单个物件的处置结果（`kind` 按类别收窄，便于调用方按类别安全取字段） */
export type SpecialObjectOutcome =
  | { kind: SpecialObjectKind; id: string; result: 'unchanged'; detail: string }
  /**
   * 归属改为进入方（dump 的 SP、运输点、空军基地、环形工事）
   *
   * `hedgehogLevelAfter`（9.14e + 21.11c）：环形工事被夺取后的**新等级**，供状态层落盘
   * （夺取降 1 级；专规 1.3a 的永久工事保持原级）。其余类别此字段无意义。
   */
  | {
      kind: 'dump' | 'transport' | 'airBase' | 'hedgehog'
      id: string
      result: 'captured'
      to: Side
      hedgehogLevelAfter?: number
      /** 9.14b：地面 dump 被夺取的 T（其余被摧毁） */
      capturedT?: number
      destroyedT?: number
      detail: string
    }
  /** 9.14b：未被夺取的补充被摧毁 */
  | { kind: 'dump'; id: string; result: 'destroyed'; detail: string }
  /** 9.14c：未被夺取的运输点（及其装载 SP）被原主位移到别处 */
  | { kind: 'transport'; id: string; result: 'displaced'; by: Side; detail: string }
  /** 9.14c：混合类型 ⇒ 由原主决定哪些被夺取、哪些被位移（见 `applyTransportOwnerChoice`） */
  | {
      kind: 'transport'
      id: string
      result: 'ownerChoice'
      group: TransportGroup
      detail: string
    }
  /** 9.14d：延补队崩溃（位移 + 翻面） */
  | {
      kind: 'extender'
      id: string
      result: 'collapsed'
      /** 实际落点（玩家选择；null ⇒ 无合法格，留在原格翻面并按 9.14c 判夺取） */
      hex: HexRef | null
      /** 9.14d：全部合法落点（`hexDistance ≤ 特殊拖取距离` 且该格此时有追溯补给），供界面高亮 */
      legalHexes: readonly HexRef[]
      capturesCheckRequired: boolean
      detail: string
    }

/** 9.14c：分组聚合结果（取整发生在**组**这一层，符合「先把同类合并再掷骰」） */
export interface TransportGroupResult {
  group: TransportGroup
  die: number
  percent: number
  /** 该组运输点总数（不含延补队，9.14c 重要提示） */
  totalPoints: number
  /** 被夺取的运输点数（取整到最近整点） */
  capturedPoints: number
  /** 被原主位移的运输点数 */
  displacedPoints: number
  /** 该组装载的 SP 总量（T） */
  totalLoadedT: number
  /** 被夺取的装载 SP（取整到最近 T） */
  capturedLoadedT: number
  /** 随运输点位移的装载 SP（T） */
  displacedLoadedT: number
  /** 该组内是否需要原主挑选（混合类型） */
  needsOwnerChoice: boolean
}

/** 9.14f：单架飞机的结果 */
export interface AircraftOutcome {
  id: string
  /** 基地夺取表结果（已含 DRM） */
  baseCapture: 'no_loss' | 'step_loss'
  /** 是否损失 1 军力（由调用方施加；单军力飞机即被消灭） */
  stepLoss: boolean
  /** 修正后的 2d6 */
  modifiedRoll: number
  /** 'transferred'＝转移并变非激活；'destroyed'＝2 倍距离内无友方基地（9.14f） */
  fate: 'transferred' | 'destroyed'
  /** 转移落点（fate='transferred' 时给出） */
  hex: HexRef | null
  /**
   * 专规 1.4a：这次转移是**飞回地图外空军盒**（盒即基地、容量无限），不是图上基地
   *
   * 用户 2026-10-30 口径：「不可能没有空军基地，因为至少有图外的」⇒ 图上 2 倍航程内
   * 没有友方基地时，先看能不能飞回盒（代价固定 20/30 格）；连盒都够不着才摧毁。
   */
  toOffMapBox?: boolean
  /** 9.14f：无论掷骰前状态如何，幸存者一律**非激活** */
  inactiveAfter: true
}

/** 特殊战斗总结果 */
export interface SpecialCombatResult {
  rule: string
  enteringSide: Side
  hex: HexRef
  objects: SpecialObjectOutcome[]
  /** 9.14c：逐组聚合（trucks / wagons） */
  transportGroups: TransportGroupResult[]
  aircraft: AircraftOutcome[]
  /** 9.14c：本次被夺取的运输点能否**立即**移动（仅移动阶段可） */
  capturedTransportMayMoveNow: boolean
  notes: string[]
}

/** 格内物件视图（`owner` ＝当前归属：剧本初设或上次夺取之后） */
export interface SpecialObjectView {
  id: string
  kind: SpecialObjectKind
  hex: HexRef
  /** 当前归属（初设给出；此后只被「敌方可攻击单位进入」改变） */
  owner: Side
  /** 9.14b：地面 dump 的 SP 总量（T；1 SP = 4 T） */
  spT?: number
  /** 9.14c：运输点数量、印值 MA、是否编内卡车、装载的 SP（T） */
  transportPoints?: number
  transportMa?: number
  organic?: boolean
  loadedSpT?: number
  /** 9.14d：延补队距后方被连接格的最远距离（12.7b） */
  rangeMp?: number
  /** 9.14f：空军基地等级与是否简易机场 */
  level?: number
  isAirstrip?: boolean
  /** 9.14e：环形工事等级；`permanent` ＝地图印刷的永久工事 */
  hedgehogLevel?: number
  permanent?: boolean
}

/** 9.14c：运输点归组（MA > 10 → trucks；MA ≤ 10 → wagons） */
export function transportGroupOf(ma: number): TransportGroup {
  return ma > TRANSPORT_TRUCK_MIN_MA ? 'trucks' : 'wagons'
}

/**
 * 9.14b–f：特殊战斗结算
 *
 * 骰面由调用方注入（种子化 RNG，可复算）：`dump`＝9.14b 的地面 SP、`trucks`/`wagons`＝9.14c 的两组。
 */
export function resolveSpecialCombat(input: {
  hex: HexRef
  enteringSide: Side
  /** 是否有（进入方的）**可攻击**单位进入该格；false 时一律 unchanged（9.14 全体前提） */
  attackCapableUnitEnters: boolean
  /** 当前 SOP 段（9.14c：只有移动阶段被夺取的运输点可立即移动） */
  phase: GamePhase
  objects: readonly SpecialObjectView[]
  dice?: { dump?: number; trucks?: number; wagons?: number }
  /** 9.14d 崩溃所需的落点候选与追溯补给判定（调用方按 12.7b / 12.6 提供） */
  extenderCollapse?: {
    /**
     * 候选落点池（通常给**图内全部格**；本模块再按**各延补队自身**的特殊拖取距离筛选，
     * 故同格内多个距离不同的延补队也能各自正确 —— 9.14d「该延补队特殊拖取距离内的任意格」）
     */
    candidates: readonly HexRef[]
    hasTraceSupplyAt(hex: HexRef, side: Side): boolean
    /**
     * 9.14d：**玩家选定的落点**（须在合法候选中）
     *
     * 规则把落点交给原主选择（「位移到该延补队特殊拖取距离内的**任意格**，前提是该格此时拥有追溯补给」），
     * 故界面须先在合法候选中高亮、由玩家点选后传入；缺省时取第一个合法格（仅作无界面调用的默认值）。
     */
    chosenHex?: HexRef
  }
  /** 9.14f：格内每架飞机的 2d6 与是否 Active */
  aircraft?: readonly { id: string; active: boolean; roll2d6: number }[]
  /** 9.14f：基地是否由**战后推进**夺取（+2 DRM） */
  capturedByAdvanceAfterCombat?: boolean
  /** 9.14f：幸存飞机落点判定（「距离 2 倍内」由调用方按 14.11 的转移距离判） */
  aircraftEscape?: {
    friendlyBases(side: Side): readonly HexRef[]
    canTransferTo(aircraftId: string, baseHex: HexRef): boolean
    /**
     * 专规 1.4a：**图外空军盒**作为最后的逃避目的地
     *
     * 返回值＝盒的落点标记（用于日志/记录；`null` ＝该机连盒都飞不到）。
     * 判据由调用方给（射程 ≥ 盒到对应列的固定航程 20/30 格），本函数不猜航程。
     * 顺序：先试图上友方基地（14.11 两倍航程），**再**试盒——不改变既有结果，只补一条生路。
     */
    offMapBox?(aircraftId: string): HexRef | null
  }
}): RuleOutcome<SpecialCombatResult> {
  const here = input.objects.filter((item) => sameHex(item.hex, input.hex))
  const objects: SpecialObjectOutcome[] = []
  const notes: string[] = []
  const base: Omit<SpecialCombatResult, 'objects' | 'transportGroups' | 'aircraft' | 'notes'> = {
    rule: '9.14',
    enteringSide: input.enteringSide,
    hex: input.hex,
    capturedTransportMayMoveNow: false,
  }

  if (!input.attackCapableUnitEnters) {
    for (const item of here)
      objects.push({
        kind: item.kind,
        id: item.id,
        result: 'unchanged',
        detail: '无可攻击单位进入，不触发 9.14',
      })
    return succeed('9.14', { ...base, objects, transportGroups: [], aircraft: [], notes })
  }

  // 9.14c：先把同类运输点**分组**（只统计**敌方**运输点——友军运输点不参与夺取；
  //   延补队既不计入总数、也不走夺取表）
  const groups = buildTransportGroups(here, input.dice, input.enteringSide)
  if (!groups.ok) return groups

  for (const item of here) {
    // ① 初设归属 vs 战斗后归属：进入方＝归属方 ⇒ 友军进入自家设施，无效果
    if (item.owner === input.enteringSide) {
      objects.push({
        kind: item.kind,
        id: item.id,
        result: 'unchanged',
        detail: '友军进入自家设施',
      })
      continue
    }

    switch (item.kind) {
      case 'dump': {
        const die = input.dice?.dump
        if (die === undefined) return fail('9.14b', `missingDumpDie:${item.id}`)
        objects.push(captureGroundSp(item, die, input.enteringSide))
        break
      }
      case 'transport': {
        const group = groups.data.find(
          (result) => result.group === transportGroupOf(item.transportMa ?? 0),
        )
        if (group === undefined) return fail('9.14c', `missingGroup:${item.id}`)
        const head = `掷 ${group.die}（${group.group} 列）→ ${group.percent}%：`
        if (group.capturedPoints >= group.totalPoints) {
          objects.push({
            kind: 'transport',
            id: item.id,
            result: 'captured',
            to: input.enteringSide,
            detail: `${head}全组 ${group.totalPoints} 点与 ${group.totalLoadedT} T 装载 SP 被夺取（9.14c）`,
          })
        } else if (group.capturedPoints === 0) {
          objects.push({
            kind: 'transport',
            id: item.id,
            result: 'displaced',
            by: item.owner,
            detail: `${head}全组 ${group.totalPoints} 点与 ${group.totalLoadedT} T 由 ${item.owner} 位移（9.14c）`,
          })
        } else {
          // 组内部分被夺取、部分被位移：**由原主决定哪些算子被夺取**（9.14c 末段，混合类型时必选）
          objects.push({
            kind: 'transport',
            id: item.id,
            result: 'ownerChoice',
            group: group.group,
            detail:
              `${head}夺取 ${group.capturedPoints}/${group.totalPoints} 点与 ${group.capturedLoadedT} T，` +
              `其余 ${group.displacedPoints} 点与 ${group.displacedLoadedT} T 位移；` +
              `由 ${item.owner} 决定哪些算子被夺取、哪些被位移（9.14c）`,
          })
        }
        break
      }
      case 'extender': {
        // 9.14d：延补队必须崩溃（位移到「特殊拖取距离」内且有追溯补给的格；落点由原主选择）
        if (input.extenderCollapse === undefined)
          return fail('9.14d', `missingCollapseContext:${item.id}`)
        const collapse = resolveExtenderCollapse({
          extender: { id: item.id, hex: item.hex, side: item.owner, rangeMp: item.rangeMp ?? 0 },
          // 9.14d：先按**该延补队自身**的特殊拖取距离从候选池里筛（同格多队距离不同也各自正确）
          candidates: extenderDisplacementCandidates(
            { hex: item.hex, rangeMp: item.rangeMp ?? 0 },
            input.extenderCollapse.candidates,
          ),
          hasTraceSupplyAt: input.extenderCollapse.hasTraceSupplyAt,
        })
        // 玩家选定的落点须在合法候选内（否则拒绝，便于界面纠正）
        const chosen = input.extenderCollapse.chosenHex
        if (chosen !== undefined && !collapse.legalHexes.some((hex) => sameHex(hex, chosen)))
          return fail('9.14d', `chosenHexNotLegal:${chosen.col}.${chosen.row}`)
        const target = chosen ?? collapse.hex
        objects.push({
          kind: 'extender',
          id: item.id,
          result: 'collapsed',
          hex: target,
          legalHexes: collapse.legalHexes,
          capturesCheckRequired: target === null,
          detail:
            chosen === undefined
              ? collapse.detail
              : `${collapse.detail}；落点按玩家选择：${chosen.col}.${chosen.row}`,
        })
        break
      }
      case 'airBase': {
        // 9.14f：基地被夺取，且**可立即使用**
        objects.push({
          kind: 'airBase',
          id: item.id,
          result: 'captured',
          to: input.enteringSide,
          detail: '空军基地被夺取，可立即使用（9.14f）',
        })
        break
      }
      case 'hedgehog': {
        const level = item.hedgehogLevel ?? 0
        // 通规 9.14e「可攻击单位进入 ⇒ 环形工事即被夺取」；
        // 降级取自通规 21.11c（工事夺取降 1 级）；地图印刷的**永久工事**按专规 1.3a 保持等级。
        // ★ 专规 1.3b：任何一方都不得把环形工事提升到 1 级以上（故本作实际只会见到 0/1 级）。
        const reduced = item.permanent === true ? level : Math.max(0, level - 1)
        objects.push({
          kind: 'hedgehog',
          id: item.id,
          result: 'captured',
          to: input.enteringSide,
          hedgehogLevelAfter: reduced,
          detail:
            item.permanent === true
              ? `永久工事被夺取，等级保持 ${level}（专规 1.3a：印刷工事不可降低）`
              : reduced === 0
                ? `环形工事被夺取：等级 ${level} → 0（21.11c 夺取降 1 级，等同移除）`
                : `环形工事被夺取：等级 ${level} → ${reduced}（21.11c 夺取降 1 级）`,
        })
        break
      }
      default:
        objects.push({ kind: item.kind, id: item.id, result: 'unchanged', detail: '未登记类别' })
    }
  }

  // 9.14c 重要提示：延补队不受夺取表影响
  if (here.some((item) => item.kind === 'extender' && item.owner !== input.enteringSide))
    notes.push('9.14c：延补队不受夺取表损失、亦不计入卡车/马车总数，改按 9.14d 崩溃')

  // 9.14f：格内每架飞机各掷基地夺取表（无论天气）；幸存者必须转移并变非激活
  const aircraft: AircraftOutcome[] = []
  const capturedBase = objects.some((item) => item.kind === 'airBase' && item.result === 'captured')
  if (input.aircraft !== undefined && input.aircraft.length > 0) {
    if (!capturedBase) {
      notes.push('格内无被夺取的敌方空军基地：飞机不掷基地夺取表（9.14f 以基地被夺取为前提）')
    } else {
      if (input.aircraftEscape === undefined) return fail('9.14f', 'missingAircraftEscapeContext')
      const ownerSide = enemyOf(input.enteringSide)
      const drm =
        input.capturedByAdvanceAfterCombat === true ? AIR_BASE_CAPTURE_DRM.byAdvanceAfterCombat : 0
      for (const plane of input.aircraft) {
        const modifiedRoll = plane.roll2d6 + (plane.active ? AIR_BASE_CAPTURE_DRM.active : 0) + drm
        const result = resolveAirBaseCapture(modifiedRoll)
        const toMapBase =
          input.aircraftEscape
            .friendlyBases(ownerSide)
            .find((hex) => input.aircraftEscape?.canTransferTo(plane.id, hex) === true) ?? null
        // 专规 1.4a：图上无处可去 ⇒ 先看能不能飞回**图外空军盒**（盒即基地）
        const toBox =
          toMapBase === null
            ? ((input.aircraftEscape.offMapBox?.(plane.id) ?? null) as HexRef | null)
            : null
        const destination = toMapBase ?? toBox
        aircraft.push({
          id: plane.id,
          baseCapture: result,
          stepLoss: result === 'step_loss',
          modifiedRoll,
          fate: destination === null ? 'destroyed' : 'transferred',
          hex: destination,
          inactiveAfter: true,
          ...(toBox === null ? {} : { toOffMapBox: true }),
        })
      }
      notes.push(
        '9.14f：幸存飞机必须转移并变为非激活；2 倍距离内无友方基地者**先看能否飞回图外盒（专规 1.4a）**，' +
          '连盒都够不着才被摧毁',
      )
    }
  }

  // 9.14c：只有**移动阶段**被夺取的运输点才可立即移动（部分夺取走 ownerChoice，同样算「被夺取」）
  const transportCaptured = objects.some(
    (item) =>
      item.kind === 'transport' && (item.result === 'captured' || item.result === 'ownerChoice'),
  )
  const capturedTransportMayMoveNow = transportCaptured && input.phase === 'movement'
  if (transportCaptured && !capturedTransportMayMoveNow)
    notes.push('9.14c：非移动阶段被夺取的运输点本阶段不能移动')

  return succeed('9.14', {
    ...base,
    objects,
    transportGroups: groups.data,
    aircraft,
    capturedTransportMayMoveNow,
    notes,
  })
}

/* ────────────────────────────── 9.14b 补给站 ────────────────────────────── */

/** 9.14b：地面 dump 的 SP 夺取（夺取部分归进入方，**其余被摧毁**，取整到最近 T） */
function captureGroundSp(
  item: SpecialObjectView,
  die: number,
  enteringSide: Side,
): SpecialObjectOutcome {
  const spT = item.spT ?? 0
  const percent = captureLookup(die, 'dump')
  const capturedT = Math.round((spT * percent) / 100)
  const destroyedT = spT - capturedT
  return {
    kind: 'dump',
    id: item.id,
    result: 'captured',
    to: enteringSide,
    capturedT,
    destroyedT,
    detail:
      `掷 ${die} → ${percent}%：夺取 ${capturedT} T（${tokensText(capturedT)}），` +
      `其余 ${destroyedT} T 被摧毁（9.14b）`,
  }
}

/* ────────────────────────────── 9.14c 分组聚合 ────────────────────────────── */

/**
 * 9.14c：运输点分组聚合
 *
 * 「将 MA 大于 10 的运输点数**结合在一起**计算，并使用『卡车』列；将 MA 小于等于 10 的运输点数
 *   结合在一起计算，并使用『马车』列」——故**先合并同类再掷骰**，取整发生在**组**这一层
 * （逐件取整会算错：3 个单点运输点在 25% 下应为 1 点被夺取，而非 0）。
 * ★ 只统计**归属≠进入方**的运输点：夺取表只处置**敌方**运输点数，同格的己方（或已被夺取的）
 *   运输点既不参与掷骰也不影响百分比。
 * 组内既有普通卡车又有编内卡车（或马车与骡子）时 `needsOwnerChoice`＝true（9.14c 末段）。
 */
function buildTransportGroups(
  here: readonly SpecialObjectView[],
  dice: { dump?: number; trucks?: number; wagons?: number } | undefined,
  enteringSide: Side,
): RuleOutcome<TransportGroupResult[]> {
  const results: TransportGroupResult[] = []
  for (const group of ['trucks', 'wagons'] as const) {
    const members = here.filter(
      (item) =>
        item.kind === 'transport' &&
        item.owner !== enteringSide &&
        transportGroupOf(item.transportMa ?? 0) === group,
    )
    if (members.length === 0) continue
    const die = group === 'trucks' ? dice?.trucks : dice?.wagons
    if (die === undefined) return fail('9.14c', `missingGroupDie:${group}`)
    const percent = captureLookup(die, group)
    const totalPoints = members.reduce((sum, item) => sum + (item.transportPoints ?? 0), 0)
    const totalLoadedT = members.reduce((sum, item) => sum + (item.loadedSpT ?? 0), 0)
    const capturedPoints = Math.round((totalPoints * percent) / 100)
    const distinctKinds = new Set(
      members.map((item) => `${item.organic === true ? 'organic' : 'normal'}`),
    )
    results.push({
      group,
      die,
      percent,
      totalPoints,
      capturedPoints,
      displacedPoints: totalPoints - capturedPoints,
      totalLoadedT,
      // SP 夺取永远取整到最近的 T（9.14c）；运输点取整到最近整点
      capturedLoadedT: Math.round((totalLoadedT * percent) / 100),
      displacedLoadedT: totalLoadedT - Math.round((totalLoadedT * percent) / 100),
      needsOwnerChoice: distinctKinds.size > 1,
    })
  }
  return succeed('9.14c', results)
}

/**
 * 9.14c：施加原主的选择（混合类型时）
 *
 * 「当不同运输点数混合在一起时（如普通卡车和编内卡车，或马车和骡子），则由**拥有者玩家**决定
 *   哪些被夺取，哪些被转移」——本函数校验其选择与组聚合结果**数额相符**（不擅自替玩家分配）。
 */
export function applyTransportOwnerChoice(input: {
  group: TransportGroupResult
  /** 原主指定被夺取的运输点数与装载 SP（T） */
  captured: { points: number; loadedT: number }
}): RuleOutcome<{ accepted: true; displaced: { points: number; loadedT: number } }> {
  const { group, captured } = input
  if (captured.points !== group.capturedPoints || captured.loadedT !== group.capturedLoadedT)
    return fail(
      '9.14c',
      `ownerChoiceMismatch:期望 ${group.capturedPoints} 点 / ${group.capturedLoadedT} T，实选 ${captured.points} 点 / ${captured.loadedT} T`,
    )
  return succeed('9.14c', {
    accepted: true,
    displaced: { points: group.displacedPoints, loadedT: group.displacedLoadedT },
  })
}

/** 9.14c：把**组级**结果落到**具体算子**上的分配方案 */
export interface TransportSplitPlan {
  rule: string
  /** 被夺取的算子（归进入方） */
  capturedUnitIds: string[]
  /** 被位移的算子（仍属原主，落点由原主选） */
  displacedUnitIds: string[]
  capturedPoints: number
  capturedLoadedT: number
  /**
   * 是否与夺取表的组级数额**完全一致**
   *
   * 组级取整（「取整到最近整点」）不一定能用整算子拼出（如需要 2 点而组内只有 3 点的算子），
   * 此时给出**最接近**的分配，并把 `exact=false` 如实报给界面。
   */
  exact: boolean
  detail: string
}

/**
 * 9.14c：把组级数额分配到**具体算子**（供界面给默认分配，并让人工分配可校验）
 *
 * 做法：枚举子集（组内算子数很小，2^n 可行），取「点数差 ×1000 + 装载 T 差」最小者；
 * 平手时优先**不超过**表值的一侧（与原主「其余位移」的口径一致）。
 * 玩家仍可在界面上改（最终数额由 `applyTransportOwnerChoice` 校验）。
 */
export function planTransportSplit(input: {
  group: TransportGroupResult
  counters: readonly { id: string; points: number; loadedT: number }[]
}): TransportSplitPlan {
  const { group, counters } = input
  const target = group.capturedPoints
  const score = (points: number, loadedT: number): number =>
    Math.abs(points - target) * 1000 + Math.abs(loadedT - group.capturedLoadedT)
  let best: { ids: string[]; points: number; loadedT: number } | null = null
  const total = counters.length
  const subsets = total <= 16 ? 1 << total : 0
  for (let mask = 0; mask < (subsets === 0 ? 1 : subsets); mask += 1) {
    const ids: string[] = []
    let points = 0
    let loadedT = 0
    if (subsets === 0) {
      // 算子过多（理论上不会出现）⇒ 退化为「按点数从大到小贪心、不超过表值」
      for (const counter of [...counters].sort((a, b) => b.points - a.points)) {
        if (points + counter.points > target) continue
        ids.push(counter.id)
        points += counter.points
        loadedT += counter.loadedT
      }
    } else {
      for (let index = 0; index < total; index += 1) {
        if ((mask & (1 << index)) === 0) continue
        const counter = counters[index]!
        ids.push(counter.id)
        points += counter.points
        loadedT += counter.loadedT
      }
    }
    if (best === null || score(points, loadedT) < score(best.points, best.loadedT)) {
      best = { ids, points, loadedT }
    }
  }
  const chosen = best ?? { ids: [], points: 0, loadedT: 0 }
  const chosenSet = new Set(chosen.ids)
  const exact = chosen.points === target && chosen.loadedT === group.capturedLoadedT
  return {
    rule: '9.14c',
    capturedUnitIds: chosen.ids,
    displacedUnitIds: counters.filter((item) => !chosenSet.has(item.id)).map((item) => item.id),
    capturedPoints: chosen.points,
    capturedLoadedT: chosen.loadedT,
    exact,
    detail: exact
      ? `按夺取表分配：夺取 ${chosen.points} 点 / ${chosen.loadedT} T（与表值一致）`
      : `夺取表要求 ${target} 点 / ${group.capturedLoadedT} T；组内算子可拼出 ${chosen.points} 点 / ${chosen.loadedT} T（取最接近者）`,
  }
}

/**
 * 9.14c：运输点位移的**落点候选**
 *
 * 「其余的则会被转移（有点像撤退）」＋原文示例「转移到**最远 10 格**的地方」；
 * 且明文「敌方单位、ZOC 和禁入地形都**不会影响**运输点数的转移，只需拿起并放到新的位置」——
 * 故候选＝图内且格距 ≤ 上限的任意格（`hexes` 由调用方给图内格清单），**不做**地形/敌情过滤。
 * 落点由**原主玩家**从中挑选（本函数只给合法集合）。
 */
export function transportDisplacementCandidates(
  from: HexRef,
  hexes: readonly HexRef[],
  maxHexes: number = TRANSPORT_DISPLACE_MAX_HEXES,
): HexRef[] {
  return hexes
    .filter((hex) => !sameHex(hex, from) && hexDistance(from, hex) <= maxHexes)
    .sort((a, b) => a.col - b.col || a.row - b.row)
}

/* ────────────────────────────── 工具 ────────────────────────────── */

/** T → 「N SP + M T」文本（12.1a：1 SP = 4 T） */
export function tokensText(t: number): string {
  const whole = Math.max(0, Math.trunc(t))
  const sp = Math.floor(whole / SP_TO_T)
  const rest = whole % SP_TO_T
  return rest === 0 ? `${sp} SP` : `${sp} SP + ${rest} T`
}

function sameHex(a: HexRef, b: HexRef): boolean {
  return a.col === b.col && a.row === b.row
}

/** 对方阵营：基地被夺取后，幸存飞机要找**自己方**（＝夺取方之敌）的基地 */
function enemyOf(side: Side): Side {
  return side === 'axis' ? 'soviet' : 'axis'
}
