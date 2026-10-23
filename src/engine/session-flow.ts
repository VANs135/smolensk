import type { Side } from '@/data'

import { DERIVATION_KEY } from './derivation'
import { initiativeDerivation, weatherDerivation } from './derivation-builders'
import { fail, succeed, type RuleOutcome } from './result-types'
import type { VictoryAssessment } from './rules/victory'
import {
  advanceSession,
  answerQuestion,
  appendLog,
  askQuestion,
  terminateSession,
  type SessionStepper,
} from './session'
import {
  agreedOptionQuestion,
  agreedOptionQuestionId,
  AGREED_OPTION_IDS,
  AGREED_OPTION_QUESTION_KIND,
  CONSENSUS_RULE,
  INITIATIVE_QUESTION_KIND,
  turnLevelLogSide,
} from './session-flow-steps'
import type { SessionAnswer, SessionQuestion } from './session-types'
import type { DiceRoll, FlightWeather, GameSession, Records, SessionLogEntry } from './state-types'
import { PRE_TURN_SEGMENTS } from './state-types'
import {
  advanceTurn,
  applyInitiativeChoice,
  initiativeQuestion,
  nextPhase,
  resolveInitiative,
  resolveTurnWeather,
  setFirstPlayer,
} from './turn-driver'

/**
 * 会话流程驱动（W6 C10：2.2 流程表逐步引导 + 待答问题 + 终止判定）
 *
 * ## 规范依据
 *   - **2.2 流程表**（SOP）：Pre-Turn（天气判定 → 先手判定）→ 先手方 A–H → 后手方 A–H → 回合结束，
 *     共 **19 步**（2 + 8×2 + 1），步骤清单见 `session-flow-steps.ts`；
 *   - **2.3 先手判定**：常规回合双方各掷 2d6、胜者**选择**先手或后手 ⇒ 待答问题（`initiativeQuestion`）；
 *     首回合由剧本指定、不掷骰；
 *   - **专规 1.5 天气判定**：掷 1 骰（1 受限飞行 / 2–6 正常飞行），首回合由剧本指定 ⇒ **自动结算**；
 *   - **5.0b 提前决胜**：任一回合**开始**（19 August 起）达成即**游戏立即结束**；
 *   - **5.0a 最终评估**：**最终回合结束**后收束（回合数用尽）；
 *   - **共识开关**（`scenarios.agreedOptions`：地图外盒是否隐藏 / 秘密掷骰 / 同步操作回合 / 可选规则与房规）
 *     —— 原文「**需双方一致同意才生效，必须写入存档**」⇒ 开局前逐项**强制选择**（采纳 / 不采纳），
 *     答案经 `answerQuestion` 自动入日志（即存档的一部份）。
 *
 * ## 与 B4 会话框架的分工（硬性约定）
 *   - **强制动作与自动后果不进待答**（见 session-types 文件头）：天气判定、段推进、回合推进、
 *     终止判定一律由本模块**直接结算**并经 `appendLog` 入账；
 *   - 只有**真正的玩家决策**才经 `askQuestion` 产生待答：先手/后手的选择（2.3）、开局共识开关（agreed options）；
 *   - 本模块**不持盘面**：控制区等盘面事实由调用方注入（如 5.0b 的达成结论来自 `victory.ts`）。
 *
 * ## 用途声明
 *   - 本模块是**流程驾驶**：它只推进 SOP 段与回合，不承载算子动作（移动/战斗/补给仍在各自机制里做）。
 *     故它可与操作台并行使用（操作台做盘面、本模块跑流程），也可单独跑整局流程做验收测试。
 */

export {
  SOP_STEPS,
  SOP_STEP_COUNT,
  guidanceFor,
  stepIndexFor,
  agreedOptionQuestion,
  agreedOptionQuestionId,
  AGREED_OPTION_IDS,
  AGREED_OPTION_QUESTION_KIND,
  CONSENSUS_RULE,
  INITIATIVE_QUESTION_KIND,
} from './session-flow-steps'
export type { SopGuidance, SopStep, SopStepDriver, SopStepRole } from './session-flow-steps'

/* ────────────────────────────── 步进依赖（注入） ────────────────────────────── */

/**
 * 步进所需的对局事实（**全部注入**；引擎不读时钟、不读盘面）
 *
 * 调用方在每次步进前按当前会话构造一份（见 stores/session.ts 的 `flowContext`）。
 */
export interface SessionFlowContext {
  /** 本剧本首回合号（`scenarios` 的 firstTurn 经回合轨对齐；首回合先手/天气由剧本指定） */
  firstTurn: number
  /** 本剧本末回合号（5.0a 的收束点；由 victory.ts 的 `scenarioLastTurn` 给出） */
  lastTurn: number
  /** 剧本指定的首回合先手（2.3） */
  scenarioFirstPlayer: Side
  /** 剧本指定的首回合天气（专规 1.5） */
  firstTurnWeather: FlightWeather
  /**
   * 本回合是否**已达成 5.0b 提前决胜**（由调用方用 `victory.ts` 对当前盘面求值）
   *
   * 本模块只接收结论——控制事实属于盘面，不在这里重算。
   */
  earlyDecisionMet: boolean
  /**
   * ⑬ 接线：**5.0b 提前决胜**的判定结论（由调用方用 `victory.ts` 对当前盘面求值）
   *
   * 给出后以它为准（`outcome` 为 `axis`/`soviet` 即已达成），`earlyDecisionMet` 退为
   * 「无盘面时的开关」；不给出（`undefined`）则只看 `earlyDecisionMet`。
   */
  decisiveVictory?: VictoryAssessment | null
  /**
   * ⑬ 接线：**5.0a 最终评估**的结论（末回合收束时写进 `terminate` 条目）
   *
   * 未接线（`undefined`/`null`）时收束条目只记 `reason`（与既有行为一致）。
   */
  finalVictory?: VictoryAssessment | null
  /** 共识开关条目（`scenarios.agreedOptions.items`）；空数组表示本作无需开局共识 */
  agreedOptionItems: readonly string[]
}

/** 5.0b 是否已达成（结论优先，其次才是「无盘面时的开关」） */
function decisiveMet(context: SessionFlowContext): boolean {
  const verdict = context.decisiveVictory
  if (verdict !== undefined && verdict !== null) {
    return verdict.outcome === 'axis' || verdict.outcome === 'soviet'
  }
  return context.earlyDecisionMet
}

/**
 * 把判定结论折成可入账的字段（5.0a/5.0b）
 *
 * 只放「复算/检索需要的结论」，不搬整个 `summary`（控制事实属于盘面，`Records.victoryLocations`
 * 已是它的正式落点）：胜方 / 层级 / 阈值 / 控制计数 / 一行详述。
 */
function victoryLogData(assessment: VictoryAssessment): Record<string, unknown> {
  return {
    level: assessment.level,
    outcome: assessment.outcome,
    winner: assessment.winner,
    rule: assessment.rule,
    listedAxis: assessment.summary.listedBySide.axis,
    listedSoviet: assessment.summary.listedBySide.soviet,
    listedTotal: assessment.summary.listedTotal,
    axisCitiesAllHeld: assessment.summary.axisCitiesAllHeld,
    sovietCitiesAllHeld: assessment.summary.sovietCitiesAllHeld,
    detail: assessment.detail,
  }
}

/* ────────────────────────────── 日志助手 ────────────────────────────── */

/** 自动结算入账（强制动作与自动后果的通道；`action` 只作审计标签） */
function autoLog(
  records: Records,
  side: Side,
  action: string,
  rule: string,
  rolls: readonly DiceRoll[],
  data: Record<string, unknown>,
): SessionLogEntry {
  return {
    turn: records.turn,
    phase: records.phase,
    side,
    action,
    rolls: [...rolls],
    outcome: succeed(rule, data),
  }
}

/** 写回 Records（不改动形态；`appendLog` 与本函数都只做纯替换） */
function withRecords(session: GameSession, records: Records): GameSession {
  return { ...session, state: { ...session.state, records } }
}

/* ────────────────────────────── 共识开关（scenarios.agreedOptions） ────────────────────────────── */

/** 该共识条目是否已作答（按日志里的题号判定；题号由条目序号生成） */
export function isAgreedOptionAnswered(session: GameSession, index: number): boolean {
  const id = agreedOptionQuestionId(index)
  return session.log.some(
    (entry) =>
      entry.action === 'answer' && entry.outcome.ok && entry.outcome.data['questionId'] === id,
  )
}

/** 共识开关待办序号（未作答的第一项；全部已答 ⇒ null） */
export function pendingAgreedOptionIndex(
  session: GameSession,
  items: readonly string[],
): number | null {
  for (let index = 0; index < items.length; index += 1) {
    if (!isAgreedOptionAnswered(session, index)) return index
  }
  return null
}

/**
 * 已作答的共识开关（从日志读出；供界面显示「必须写入存档」的结论）
 *
 * `adopted === null` 表示该项尚未作答。
 */
export function consensusDecisions(
  session: GameSession,
  items: readonly string[],
): readonly { item: string; adopted: boolean | null }[] {
  return items.map((item, index) => {
    const id = agreedOptionQuestionId(index)
    const entry = session.log.find(
      (log) => log.action === 'answer' && log.outcome.ok && log.outcome.data['questionId'] === id,
    )
    if (entry === undefined || !entry.outcome.ok) return { item, adopted: null }
    return { item, adopted: entry.outcome.data['optionId'] === AGREED_OPTION_IDS.adopt }
  })
}

/* ────────────────────────────── 共识勾选列表（W7 C13） ────────────────────────────── */

/** 共识勾选列表的一行（专规 4.0：开局前双方逐项达成一致） */
export interface AgreedChecklistRow {
  index: number
  item: string
  /** 该行的规则依据（统一为 4.0：条目横跨 1.4 / 4.9e / 2.4 / 4.1–4.3） */
  rule: string
}

/** 4.0：把 `scenarios.agreedOptions.items` 铺成**勾选列表**（界面按此渲染，顺序即题号） */
export function agreedChecklist(items: readonly string[]): readonly AgreedChecklistRow[] {
  return items.map((item, index) => ({ index, item, rule: CONSENSUS_RULE }))
}

/**
 * 4.0：把勾选列表**一次性**写成人人对局共识（逐条结论进日志 —— 即存档的一部份）
 *
 * ## 为什么这样落地
 *   共识结论的**唯一权威记录**是会话日志里的 `answer` 条目（`consensusDecisions` 从日志反推），
 *   故本函数**不新开写状态的旁路**：它按 SOP 逐步推进内核（内核会在共识阶段停下给出 `agreedOption` 待答），
 *   再按勾选结果作答（采纳 / 不采纳），直到全部条目答完 —— 与逐条点「待答面板」走的是**同一条路**，
 *   只是把选择提前收进了勾选列表。
 *
 * ## 门禁（★ 用户口径：不再是「全部勾选」）
 *   勾选框即「用不用这一条」：**勾 = 采用，不勾 = 不用，默认全部不勾**。
 *   本函数只要求勾选数组与条目等长；逐条都写日志结论（`adopted` ＝ 该条是否勾选）。
 *   4.0 的门禁退化为「结论须写入日志」（`consensusChecklistNotRecorded`）——
 *   由会话层在步进前自动补写，故玩家不必先做一轮勾选。
 *
 * ## 勾选 与 采纳 的一致性
 *   `checks` 是**该项是否采用**（界面只有一个勾选框）；`adopted` 缺省跟随 `checks`。
 *   两数组分开保留只是为了兼容存档里已有的「谈过但不用」结论。
 *
 * @param input.session 已 `startSession` 的会话（形态须可推进）
 * @param input.checks  与 `context.agreedOptionItems` 等长的勾选数组（true = 采用该条）
 * @param input.adopted 与 `checks` 等长的生效数组（缺省 = `checks`）
 */
export function applyAgreedChecklist(input: {
  session: GameSession
  context: SessionFlowContext
  checks: readonly boolean[]
  adopted?: readonly boolean[]
}): RuleOutcome<{
  session: GameSession
  decisions: readonly { item: string; adopted: boolean | null }[]
  detail: string
}> {
  const items = input.context.agreedOptionItems
  if (input.checks.length !== items.length)
    return fail(
      CONSENSUS_RULE,
      `consensusChecklistLengthMismatch:${input.checks.length}≠${items.length}`,
    )

  let session = input.session
  const stepper = makeSessionStepper(input.context)
  for (let guard = 0; guard <= items.length; guard += 1) {
    if (pendingAgreedOptionIndex(session, items) === null) break
    const advance = advanceSession(session, stepper)
    session = advance.session
    if (session.status.form !== 'awaiting') break
    const question = session.status.question
    if (question.kind !== AGREED_OPTION_QUESTION_KIND) break
    const index = Number(question.id.split(':')[1] ?? Number.NaN)
    const effective = input.adopted?.[index] ?? input.checks[index] === true
    session = answerQuestion(session, {
      questionId: question.id,
      side: question.responder,
      optionId: effective ? AGREED_OPTION_IDS.adopt : AGREED_OPTION_IDS.decline,
    })
  }

  const pending = pendingAgreedOptionIndex(session, items)
  if (pending !== null) return fail(CONSENSUS_RULE, `consensusChecklistNotRecorded:${pending}`)

  const decisions = consensusDecisions(session, items)
  const adoptedCount = decisions.filter((decision) => decision.adopted === true).length
  return succeed(CONSENSUS_RULE, {
    session,
    decisions,
    detail:
      `开局共识已逐项写入日志（${adoptedCount}/${items.length} 项采纳，4.0）：` +
      decisions
        .map((decision, index) => `${index + 1}.${decision.adopted === true ? '采纳' : '不采纳'}`)
        .join('、'),
  })
}

/* ────────────────────────────── 作答落地 ────────────────────────────── */

/**
 * 作答落地：把玩家选择写回 Records（纯函数）
 *
 * - `initiative`（2.3）：按选项把先手方写入 `firstPlayer`（`payload.chooser` 还原选择者）；
 * - `agreedOption`（共识开关）：**不改 Records**——它是对局外部约定，答案已由 `answerQuestion` 记入日志；
 * - 其它类别（各机制自己的待答）由对应机制自行落地，本模块原样返回。
 */
export function applyAnswerToRecords(input: {
  records: Records
  question: SessionQuestion
  answer: SessionAnswer
}): Records {
  const { question, answer, records } = input
  if (question.kind !== INITIATIVE_QUESTION_KIND) return records

  const chooser = question.payload?.['chooser']
  if (chooser !== 'axis' && chooser !== 'soviet') return records
  if (answer.optionId !== 'first' && answer.optionId !== 'second') return records
  return applyInitiativeChoice(records, chooser, answer.optionId)
}

/* ────────────────────────────── 步进 ────────────────────────────── */

/** 该步是否为「回合开始」的第一帧（Pre-Turn 天气判定；5.0b 在此判定） */
function isTurnStart(records: Records): boolean {
  return records.phase === 'preTurn' && records.preTurnSegment === PRE_TURN_SEGMENTS[0]
}

/** 该步是否处于开局前的共识阶段（首回合、Pre-Turn、尚未进入玩家段） */
function isConsensusStage(records: Records, context: SessionFlowContext): boolean {
  return records.turn === context.firstTurn && records.phase === 'preTurn'
}

/**
 * 造一个步进函数（`SessionStepper`）
 *
 * 每次调用推进**恰好一步**，三种去向：`advanced`（自动结算）/ `question`（停下待答）/ `terminated`（终止）。
 * 形态守卫与一致性校验由 `advanceSession` 统一负责（见 session.ts）。
 */
export function makeSessionStepper(context: SessionFlowContext): SessionStepper {
  return (session: GameSession) => {
    const records = session.state.records

    // ① 开局前的共识开关（scenarios.agreedOptions：需双方一致同意才生效，必须写入存档）
    if (isConsensusStage(records, context)) {
      const index = pendingAgreedOptionIndex(session, context.agreedOptionItems)
      if (index !== null) {
        const item = context.agreedOptionItems[index] ?? ''
        return {
          kind: 'question',
          session: askQuestion(
            session,
            agreedOptionQuestion(index, item, context.scenarioFirstPlayer),
          ),
        }
      }
    }

    // ② 回合开始（5.0b）：达成提前决胜 ⇒ 立即终止（不掷天气、不进入玩家段）
    if (isTurnStart(records) && decisiveMet(context)) {
      const side = turnLevelLogSide(records, context.scenarioFirstPlayer)
      const verdict = context.decisiveVictory ?? null
      return {
        kind: 'terminated',
        session: appendLog(
          terminateSession(session, 'earlyDecision'),
          autoLog(records, side, 'terminate', '5.0b', [], {
            reason: 'earlyDecision',
            turn: records.turn,
            // ⑬ 接线：收束条目带上判定结论（胜方 / 控制计数 / 详述）
            ...(verdict === null ? {} : { victory: victoryLogData(verdict) }),
          }),
        ),
      }
    }

    // ③ Pre-Turn：天气判定（专规 1.5）
    if (records.phase === 'preTurn' && records.preTurnSegment === PRE_TURN_SEGMENTS[0]) {
      const isFirstTurn = records.turn === context.firstTurn
      const draw = resolveTurnWeather(session.state.rng, {
        isFirstTurn,
        ...(isFirstTurn ? { firstTurnWeather: context.firstTurnWeather } : {}),
      })
      const side = turnLevelLogSide(records, context.scenarioFirstPlayer)
      const next = nextPhase(records)
      const logged = appendLog(
        withRecords(session, next),
        autoLog(records, side, 'weather', '1.5', draw.resolution.rolls, {
          air: draw.resolution.weather.air,
          ground: draw.resolution.weather.ground,
          rolled: draw.resolution.rolled,
          // C11：把「骰点 → 查表 → 结论」摊开，供日志逐项复核
          [DERIVATION_KEY]: weatherDerivation({
            roll: draw.resolution.rolls[0] ?? null,
            air: draw.resolution.weather.air,
            specified: !draw.resolution.rolled,
          }),
        }),
      )
      return {
        kind: 'advanced',
        session: { ...logged, state: { ...logged.state, rng: draw.rng } },
      }
    }

    // ④ Pre-Turn：先手判定（2.3）——首回合剧本指定；常规回合胜者**待选**
    if (records.phase === 'preTurn' && records.preTurnSegment === PRE_TURN_SEGMENTS[1]) {
      if (records.firstPlayer !== null) {
        const next = nextPhase(records)
        return {
          kind: 'advanced',
          session: appendLog(
            withRecords(session, next),
            autoLog(records, records.firstPlayer, 'phase', '2.2', [], {
              to: next.phase,
              activeSide: next.activeSide,
            }),
          ),
        }
      }
      const isFirstTurn = records.turn === context.firstTurn
      const draw = resolveInitiative(session.state.rng, {
        isFirstTurn,
        ...(isFirstTurn ? { scenarioFirstPlayer: context.scenarioFirstPlayer } : {}),
      })
      if (draw.resolution.kind === 'specified') {
        const next = nextPhase(setFirstPlayer(records, draw.resolution.firstPlayer))
        return {
          kind: 'advanced',
          session: appendLog(
            withRecords(session, next),
            autoLog(records, draw.resolution.firstPlayer, 'initiative', '2.3', [], {
              specified: draw.resolution.firstPlayer,
              // C11：首回合先手由剧本指定（不掷骰）也给出复核行
              [DERIVATION_KEY]: initiativeDerivation({
                specifiedFirstPlayer: draw.resolution.firstPlayer,
              }),
            }),
          ),
        }
      }
      const rolled = appendLog(
        withRecords(session, records),
        autoLog(records, draw.resolution.chooser, 'initiative', '2.3', draw.rolls, {
          chooser: draw.resolution.chooser,
          rerolls: draw.resolution.rerolls,
          // C11：双方掷骰 + 重掷次数 + 胜者，逐项摊开
          [DERIVATION_KEY]: initiativeDerivation({
            axisRoll: draw.resolution.rolls.axis,
            sovietRoll: draw.resolution.rolls.soviet,
            chooser: draw.resolution.chooser,
            rerolls: draw.resolution.rerolls,
          }),
        }),
      )
      const withRng: GameSession = { ...rolled, state: { ...rolled.state, rng: draw.rng } }
      return {
        kind: 'question',
        session: askQuestion(withRng, initiativeQuestion(draw.resolution.chooser)),
      }
    }

    // ⑤ 玩家段（A–H）：本模块只推进段，不代替各机制结算算子动作
    if (records.phase !== 'turnEnd') {
      const next = nextPhase(records)
      const side = records.activeSide ?? context.scenarioFirstPlayer
      return {
        kind: 'advanced',
        session: appendLog(
          withRecords(session, next),
          autoLog(records, side, 'phase', '2.2', [], {
            to: next.phase,
            activeSide: next.activeSide,
          }),
        ),
      }
    }

    // ⑥ 回合结束（2.2 Turn End）：到本剧本末回合 ⇒ 5.0a 收束；否则推进回合
    if (records.turn >= context.lastTurn) {
      const side = turnLevelLogSide(records, context.scenarioFirstPlayer)
      const verdict = context.finalVictory ?? null
      return {
        kind: 'terminated',
        session: appendLog(
          terminateSession(session, 'turnsExhausted'),
          autoLog(records, side, 'terminate', '5.0a', [], {
            reason: 'turnsExhausted',
            turn: records.turn,
            lastTurn: context.lastTurn,
            // ⑬ 接线：5.0a 的最终评估结论（胜方 / Draw / 控制计数）随收束条目入账
            ...(verdict === null ? {} : { victory: victoryLogData(verdict) }),
          }),
        ),
      }
    }
    const next = advanceTurn(records, context.lastTurn)
    const side = turnLevelLogSide(records, context.scenarioFirstPlayer)
    return {
      kind: 'advanced',
      session: appendLog(
        withRecords(session, next),
        autoLog(records, side, 'turnEnd', '2.2', [], { turn: next.turn }),
      ),
    }
  }
}
