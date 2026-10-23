import { markers } from '@/data'
import type { Side } from '@/data'

import { roll1d6, roll2d6 } from './rng'
import { resolveWeather } from './rules/weather'
import type { SessionQuestion } from './session-types'
import type {
  DiceRoll,
  FlightWeather,
  GamePhase,
  Initiative,
  Records,
  RngState,
  WeatherState,
} from './state-types'

/**
 * 阶段机与回合驱动（B5）
 *
 * 全部行为取自规则书，未加臆造。条文出处：
 *   - **2.2 流程表**（源库 charts.json → tables.sop，v4.3 图表页 1）：
 *       Pre-Turn：天气判定 → 先手判定
 *       行动方回合：A 飞机整备 / B 增援 / C 移动 / D 补给 / E 反应 / F 战斗 / G 进击 / H 清理
 *       第二方：角色互换重做 A–H
 *       回合结束：推进回合标记
 *   - **2.3 先手判定**（源库 exclusive_rules_smolensk.initiative）：
 *       常规回合「双方各掷两枚骰子，点数高者选择本回合成为先手或后手，平局重掷」；
 *       首回合由剧本指定、不掷骰；此后每回合恢复常规掷骰。
 *       源库引擎注记明写：「引擎只负责掷骰与比较，先后手的选择必须由胜者输入」——
 *       故胜者的先后手选择在 B4 会话框架里以**待答问题**表达，不作为自动后果。
 *       可选房规 4.2a：上一回合先动的一方赢得平局骰。
 *   - **专规 1.5 / 天气表**（源库 charts.json → tables.weather）：
 *       掷 1 骰，1 = 受限飞行（Exploitation/Reaction 禁飞、禁低空扫射），2–6 = 正常飞行；
 *       本作地面条件恒为良好。
 *   - **回合轨**（源库 charts.json weather.turn_track → 产物 markers.json → turnTrack）：
 *       19 回合；第 1 回合 = 1941-07-08，第 19 回合 = 1941-09-08。
 *       日号取轮盘的 `[1,5,8,12,15,19,22,26,29]`（每月重复），游戏自 8 Jul 起、至 8 Sep 止 ⇒
 *       July 8/12/15/19/22/26/29、August 1/5/8/12/15/19/22/26/29、September 1/5/8。
 *
 * 本模块为纯函数：收 Records（或 RngState）→ 返回新值，不改入参、不取系统时间。
 */

/* ────────────────────────────── 阶段常量（2.2） ────────────────────────────── */

/** 玩家回合阶段（2.2 流程表 A–H，共八段）：先手方与后手方各做一遍 */
export const PLAYER_TURN_PHASES = [
  'aircraftRefit',
  'reinforcement',
  'movement',
  'supply',
  'reaction',
  'combat',
  'exploitation',
  'cleanUp',
] as const

/**
 * 玩家**决策**阶段（六个：B–G）——需求口径的「六个阶段」
 *
 * 这六段是作战阶段：移动 / 射击 / 反应 / 战斗 / 进击等玩家主动作都在其中。
 * 其余两段 A 飞机整备、H 清理属后勤与事务阶段（见 SERVICE_PHASES）。
 */
export const DECISION_PHASES = [
  'reinforcement',
  'movement',
  'supply',
  'reaction',
  'combat',
  'exploitation',
] as const

/**
 * 后勤与事务阶段（A 飞机整备 15.1 / H 清理 2.2）
 *
 * 注意**不是**「全自动阶段」：H 清理完全自动；A 整备仍需玩家决定
 * 「是否付费、整备哪些机」，引擎只自动算基准（1 T / 基地、2 机 / 基地等级）与
 * 限制校验（未抵消敌方 ZOC 内不可整备；天气不影响整备）。
 */
export const SERVICE_PHASES = ['aircraftRefit', 'cleanUp'] as const

/*
 * ── 2.2 流程逐步分类：自动 / 玩家参与（据流程表与各章条文逐段核对） ──
 *
 * 【全自动】引擎掷骰并直接结算，玩家无输入，故永不产生待答（B4 契约）：
 *   · Pre-Turn 天气判定 ………………… 专规 1.5：掷 1 骰查天气表（1 受限 / 2–6 正常），地面恒良好
 *   · H 清理 ……………………………… 2.2 注：移除 DG 与进击标记、翻面燃料标记、移除敌方交通破坏标记
 *   · Turn End 推进回合标记 ………… 2.2：回合 +1，日期随回合轨
 *   · B 段内的子步骤 ………………… 1.6b：掷补员表与补给表（双方各自）；
 *                                     1.6a：被点名 Removed 的单位立即移除；
 *                                     3.3c：19 Aug 起轴方掷可变撤离（结果为整队移除，无选择）；
 *                                     3.6：轴方随机事件掷表（空军转非激活等后果自动）
 *
 * 【玩家参与】需要输入；其中「引擎必须当场拿到的二选一/数值」才升级为待答问题（B4）：
 *   · Pre-Turn 先手判定 ……………… 2.3：引擎各掷 2d6、高者为胜者，**先/后手由胜者选择**
 *                                     （源库引擎注记：选择必须由胜者输入 → 待答）
 *   · A 飞机整备 ……………………… 15.1：玩家决定是否付费与整备哪些机（引擎自动算容量与限制）
 *   · B 增援 ……………………………… 2.1/3.1：到货单位的放置位置（可拖取补给的 HQ / 边补给源格）；
 *                                     13.5：Pax / Eq 的使用与留存；3.6 Supply Train 的落格
 *   · C 移动 ……………………………… 12.8e 突围（是否尝试）；5.x/6.x 模式与移动；10.0 空军轰炸
 *   · D 补给 ……………………………… 12.3–12.7：追溯 / 直接拖取、吃 SP、加油的分配（路径计算自动）
 *   · E 反应 ……………………………… 非行动方的反应移动 / 轰炸
 *   · F 战斗 ……………………………… 9.5–9.13：宣告攻击与炮兵轰炸；结果中的 **9.10 选项**（撤退或损失）
 *                                     与损失分配需输入 → 待答
 *   · G 进击 ……………………………… 9.13 / 11.0：进击标记单位的移动 / 轰炸 / 战斗
 *
 * 结论：全自动的**段**仅有 H 清理与 Turn End（外加 Pre-Turn 内的天气判定）；
 * A–G 均需玩家参与。玩家主导的段（移动/战斗宣告）由界面操作驱动，
 * 只有引擎中途必须拿到的决策才成为待答问题——二者不可混为一谈。
 */

/** 回合轨总回合数（= 产物 markers.json turnTrack 长度，19） */
export const TOTAL_TURNS = markers.turnTrack.length

/** 先手判定的规则依据（2.3 / 专规 Setup Notes A） */
export const INITIATIVE_RULE = '2.3'

/** 天气判定的规则依据（专规 1.5） */
export const WEATHER_RULE = '1.5'

/** 平局重掷的安全上限：连续平局概率按 1/6 递减，超出即视为数据/实现异常 */
const MAX_INITIATIVE_REROLLS = 100

/** 阶段机错误：前置条件不满足（阶段/子步骤/回合轨越界） */
export class TurnDriverError extends Error {
  constructor(message: string) {
    super(`[turn-driver] ${message}`)
    this.name = 'TurnDriverError'
  }
}

/* ────────────────────────────── 基础工具 ────────────────────────────── */

/** 对手方 */
export function opponentOf(side: Side): Side {
  return side === 'axis' ? 'soviet' : 'axis'
}

/** 回合号 → 日期（ISO；取自产物 markers.json 的回合轨）；越界即抛错 */
export function turnDate(turn: number): string {
  const entry = markers.turnTrack.find((item) => item.turn === turn)
  if (!entry) {
    throw new TurnDriverError(`回合轨无第 ${turn} 回合（轨共 ${TOTAL_TURNS} 回合）`)
  }
  return entry.date
}

/** 回合轨的全部日期（ISO，升序） */
export function turnDates(): readonly string[] {
  return markers.turnTrack.map((item) => item.date)
}

/**
 * **日程日期 → 执行它的那个回合的日期**（到达卡 / rules-constants 的日程归位）
 *
 * ## 口径
 * 日程日期归到**轨上第一个 ≥ 它的回合**（reinforcement 的惯例）；每张日程因此**有且只有一个**
 * 执行回合（不会重复触发，也不会跳过）。日程晚于轨末 ⇒ 返回 `null`（本局永不触发）。
 *
 * ## 历史（为什么当初要加这一步，以及它现在为什么是"兜底"）
 * 本函数是在**回合轨日期有误**的前提下引入的：当时 `derived_turn_dates` 把 8 月与 9 月的首回合
 * 错推成 `1941-08-02` / `1941-09-02`（轨上没有 08-01 / 09-01），而到达卡写的是 `1 Aug 41` /
 * `1 Sep 41`，于是 `planArrivals`（月+日精确相等）与 `frontalReservesBatch`（日期相等）对这两个批次
 * **永不命中**——双方的整个到达块与专规 2.3c 的后两批方面军预备队都静默失效。
 *
 * ★ 2026-09-15 用户裁定后**源数据已修正**（见 `scripts/sync-markers.mjs` 上游的
 *   `charts.json.weather.turn_track`）：轮盘日号是 `[1,5,8,12,15,19,22,26,29]` 每月重复，
 *   游戏自 8 Jul 起、至 8 Sep 止 ⇒ 8 月与 9 月的首回合就是 **1 日**。修正后：
 *   到货卡 26 块**全部精确命中**、7 个剧本的首末回合**逐条一致**、全部日期常量都落在轨上。
 *   ⇒ 本函数如今对既有日程是**恒等映射**（"第一个 ≥ 它"就是它自己），保留它是为了
 *     ① 对**未来**任何卡面日期与轨不同日的日程提供确定性归位；② 让归位口径只有一处。
 */
export function arrivalTurnOf(scheduled: string): string | null {
  const dates = turnDates()
  return dates.find((date) => date >= scheduled) ?? null
}

/** 该 ISO 日期是否就是 `scheduled` 日程的执行回合（`arrivalTurnOf` 的唯一判据） */
export function isArrivalTurnOf(scheduled: string, date: string): boolean {
  return arrivalTurnOf(scheduled) === date
}

/** 是否为玩家决策阶段（六段之一） */
export function isDecisionPhase(phase: GamePhase): boolean {
  return (DECISION_PHASES as readonly GamePhase[]).includes(phase)
}

/**
 * 当前处于先手方回合还是后手方回合（2.2 Player Turn / Second Player）
 *
 * Pre-Turn（先手未判定）/ Turn-End（无行动方）→ null；否则由 activeSide 与 firstPlayer 比对得出。
 */
export function turnRoleOf(records: Records): Initiative | null {
  if (records.activeSide === null || records.firstPlayer === null) return null
  return records.activeSide === records.firstPlayer ? 'first' : 'second'
}

/* ────────────────────────────── 先手判定（2.3） ────────────────────────────── */

/** 先手判定一次的双方掷骰 */
export interface InitiativeRolls {
  axis: DiceRoll
  soviet: DiceRoll
}

/**
 * 先手判定结果
 *
 * - `specified` 首回合：由剧本指定先手，不掷骰
 * - `choice`    常规回合：胜者（chooser）**待输入**选择先手或后手
 */
export type InitiativeResolution =
  | { kind: 'specified'; firstPlayer: Side }
  | { kind: 'choice'; chooser: Side; rolls: InitiativeRolls; rerolls: number }

/** 先手判定输入 */
export interface ResolveInitiativeInput {
  /**
   * 是否为本**剧本**首回合（2.3 first_turn：首回合不掷骰）
   *
   * 注意：**不是**「回合轨第 1 回合」。各剧本起始回合不同——
   * 剧本 1/2 自回合轨第 1 回合（8 Jul）起，剧本 3/4 自第 5 回合（22 Jul）、
   * 剧本 5/6 自第 10 回合（8 Aug）、剧本 7 自第 15 回合（26 Aug）起
   * （见 scenarios.json 的 firstTurn 与 markers.json turnTrack 的日期对齐）。
   */
  isFirstTurn: boolean
  /** 剧本指定的首回合先手（scenarios.json firstPlayer）；isFirstTurn 时必填 */
  scenarioFirstPlayer?: Side
  /** 可选房规 4.2a：平局时判胜的一方（通常传上一回合先手） */
  tieBreaker?: Side
}

/** 一次先手判定的产出 */
export interface InitiativeDraw {
  /** 推进后的 RNG 状态 */
  rng: RngState
  resolution: InitiativeResolution
  /** 本次判定产生的全部掷骰（按发生顺序，每次尝试两条：各方一条 2d6；供会话日志与复算） */
  rolls: DiceRoll[]
}

/**
 * 先手判定（2.3）
 *
 * 常规回合双方各掷 2 骰，点数高者为 chooser；平局重掷（房规 4.2a 时由指定方判胜）。
 * 引擎只掷骰与比较，**先后手的选择留给胜者输入**（源库引擎注记）。
 */
export function resolveInitiative(rng: RngState, input: ResolveInitiativeInput): InitiativeDraw {
  if (input.isFirstTurn) {
    if (!input.scenarioFirstPlayer) {
      throw new TurnDriverError('首回合先手由剧本指定，须提供 scenarioFirstPlayer（2.3）')
    }
    return {
      rng,
      resolution: { kind: 'specified', firstPlayer: input.scenarioFirstPlayer },
      rolls: [],
    }
  }

  const rolls: DiceRoll[] = []
  let state = rng
  let rerolls = 0

  for (;;) {
    const axisDraw = roll2d6(state)
    state = axisDraw.rng
    rolls.push(axisDraw.value)

    const sovietDraw = roll2d6(state)
    state = sovietDraw.rng
    rolls.push(sovietDraw.value)

    const pair: InitiativeRolls = { axis: axisDraw.value, soviet: sovietDraw.value }

    if (pair.axis.total !== pair.soviet.total) {
      const chooser: Side = pair.axis.total > pair.soviet.total ? 'axis' : 'soviet'
      return { rng: state, resolution: { kind: 'choice', chooser, rolls: pair, rerolls }, rolls }
    }

    // 平局：房规 4.2a 直接判胜，否则重掷
    if (input.tieBreaker) {
      return {
        rng: state,
        resolution: { kind: 'choice', chooser: input.tieBreaker, rolls: pair, rerolls },
        rolls,
      }
    }

    rerolls += 1
    if (rerolls > MAX_INITIATIVE_REROLLS) {
      throw new TurnDriverError(
        `先手判定连续平局超过 ${MAX_INITIATIVE_REROLLS} 次（2.3 平局重掷），疑似随机源异常`,
      )
    }
  }
}

/**
 * 胜者的先后手选择，作为**待答问题**交给会话框架（2.3）
 *
 * 选项 id 与 `Initiative` 取值一致（'first' / 'second'），作答后经 applyInitiativeChoice 落地。
 * `payload.chooser` 供作答落地时还原「谁在选择」（见 session-flow 的 applyAnswerToRecords）。
 */
export function initiativeQuestion(chooser: Side): SessionQuestion {
  return {
    id: 'initiative',
    responder: chooser,
    kind: 'initiative',
    rule: INITIATIVE_RULE,
    prompt: `${chooser === 'axis' ? '轴心' : '苏联'}方先手判定胜出：选择本回合先手或后手`,
    options: [
      { id: 'first', label: '先手（本方先行动）' },
      { id: 'second', label: '后手（对手先行动）' },
    ],
    payload: { chooser },
  }
}

/** 落地剧本指定的首回合先手（2.3 first_turn：首回合不掷骰） */
export function setFirstPlayer(records: Records, firstPlayer: Side): Records {
  return { ...records, firstPlayer }
}

/**
 * 落地胜者的先后手选择（2.3）
 *
 * 只改 `firstPlayer`：Pre-Turn 期间仍无行动方，进入 A 飞机整备时才把 activeSide 置为先手方
 * （见 nextPhase）。
 */
export function applyInitiativeChoice(
  records: Records,
  chooser: Side,
  choice: Initiative,
): Records {
  const firstPlayer = choice === 'first' ? chooser : opponentOf(chooser)
  return { ...records, firstPlayer }
}

/* ────────────────────────────── 天气判定（专规 1.5） ────────────────────────────── */

/** 天气判定结果 */
export interface WeatherResolution {
  weather: WeatherState
  /** 是否掷骰（首回合按剧本指定，不掷） */
  rolled: boolean
  /** 掷骰记录（首回合为空数组） */
  rolls: DiceRoll[]
}

/** 天气判定输入 */
export interface ResolveTurnWeatherInput {
  /** 是否为本**剧本**首回合（首回合按剧本指定，不掷骰；同 ResolveInitiativeInput 的语义说明） */
  isFirstTurn: boolean
  /** 剧本指定的首回合天气（scenarios.json firstWeather）；isFirstTurn 时必填 */
  firstTurnWeather?: FlightWeather
}

/**
 * 天气判定（专规 1.5 / 天气表）
 *
 * 首回合按剧本指定（不掷骰）；此后每回合掷 1 骰：1 = 受限飞行，2–6 = 正常飞行。
 * 地面条件本作恒为良好。
 */
export function resolveTurnWeather(
  rng: RngState,
  input: ResolveTurnWeatherInput,
): { rng: RngState; resolution: WeatherResolution } {
  if (input.isFirstTurn) {
    if (!input.firstTurnWeather) {
      throw new TurnDriverError('首回合天气由剧本指定，须提供 firstTurnWeather（专规 1.5）')
    }
    return {
      rng,
      resolution: {
        weather: { air: input.firstTurnWeather, ground: 'good' },
        rolled: false,
        rolls: [],
      },
    }
  }

  const draw = roll1d6(rng)
  const result = resolveWeather(draw.value.total)
  return {
    rng: draw.rng,
    resolution: {
      weather: { air: result.air, ground: result.ground },
      rolled: true,
      rolls: [draw.value],
    },
  }
}

/* ────────────────────────────── 阶段流转（2.2） ────────────────────────────── */

/**
 * 推进一个阶段（2.2）
 *
 * 顺序：Pre-Turn（天气判定 → 先手判定）→ 先手方 A–H → 后手方 A–H → 回合结束。
 * 末段 turnEnd 不在本函数处理，须调用 advanceTurn 进入下一回合。
 */
export function nextPhase(records: Records): Records {
  switch (records.phase) {
    case 'preTurn': {
      if (records.preTurnSegment === 'weatherDetermination') {
        return { ...records, preTurnSegment: 'firstPlayerDetermination' }
      }
      if (records.preTurnSegment === 'firstPlayerDetermination') {
        // 先手必须已判定（首回合剧本指定 / 常规回合胜者选择），否则不得进入玩家回合——
        // 否则会静默沿用上一回合的先手，属危险默认值
        if (records.firstPlayer === null) {
          throw new TurnDriverError(
            '先手尚未判定（firstPlayer 为空）：须先完成首回合剧本指定或常规回合胜者选择（2.3）',
          )
        }
        // 先手已定 → 进入先手方回合的第一段
        return {
          ...records,
          phase: 'aircraftRefit',
          preTurnSegment: null,
          activeSide: records.firstPlayer,
        }
      }
      throw new TurnDriverError(
        `Pre-Turn 子步骤缺失（2.2）：preTurnSegment = ${String(records.preTurnSegment)}`,
      )
    }
    case 'aircraftRefit':
      return { ...records, phase: 'reinforcement' }
    case 'reinforcement':
      return { ...records, phase: 'movement' }
    case 'movement':
      return { ...records, phase: 'supply' }
    case 'supply':
      return { ...records, phase: 'reaction' }
    case 'reaction':
      return { ...records, phase: 'combat' }
    case 'combat':
      return { ...records, phase: 'exploitation' }
    case 'exploitation':
      return { ...records, phase: 'cleanUp' }
    case 'cleanUp': {
      const { activeSide, firstPlayer } = records
      if (activeSide === null || firstPlayer === null) {
        throw new TurnDriverError(
          `清理阶段缺少行动方或先手方（2.2）：activeSide = ${String(activeSide)}，firstPlayer = ${String(firstPlayer)}`,
        )
      }
      // 先手方走完 A–H → 交给后手方重做 A–H
      if (activeSide === firstPlayer) {
        return { ...records, phase: 'aircraftRefit', activeSide: opponentOf(activeSide) }
      }
      // 后手方也走完 → 回合结束
      return { ...records, phase: 'turnEnd', activeSide: null }
    }
    case 'turnEnd':
      throw new TurnDriverError(
        '回合已结束（turnEnd），须用 advanceTurn 推进下一回合（2.2 Turn End）',
      )
  }
}

/**
 * 回合推进（2.2 Turn End → 下一回合 Pre-Turn）
 *
 * 仅允许在 turnEnd 调用；推进后回到 Pre-Turn 的天气判定子步骤，
 * 行动方与先手方**一并清空**（先手须在新回合重新判定，见 nextPhase 的护栏）。
 * 天气沿用上一回合值，直到天气判定子步骤重新掷出后覆盖。
 *
 * @param lastTurn 本次对局的末回合（默认回合轨末回合 19）。短剧本（2/4/6）须传入
 *                 其剧本末回合（由剧本数据派生），到该回合即抛错——此时应由终止判定收束（5.0a）。
 */
export function advanceTurn(records: Records, lastTurn: number = TOTAL_TURNS): Records {
  if (records.phase !== 'turnEnd') {
    throw new TurnDriverError(`仅回合结束（turnEnd）可推进回合，当前阶段为 ${records.phase}`)
  }
  if (!Number.isInteger(lastTurn) || lastTurn < 1 || lastTurn > TOTAL_TURNS) {
    throw new TurnDriverError(`末回合参数非法：${lastTurn}（应在 1..${TOTAL_TURNS}）`)
  }
  if (records.turn >= lastTurn) {
    throw new TurnDriverError(
      `回合轨已到本对局末回合（第 ${lastTurn} 回合），应由终止判定收束（5.0a）`,
    )
  }
  return {
    ...records,
    turn: records.turn + 1,
    phase: 'preTurn',
    preTurnSegment: 'weatherDetermination',
    activeSide: null,
    firstPlayer: null,
  }
}
