import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { scenarios } from '@/data'
import type { Side } from '@/data'
import { createRngState } from '@/engine/rng'
import {
  advanceSession,
  answerQuestion,
  appendLog,
  currentQuestion,
  isTerminated,
  sessionForm,
  startSession,
  terminationOf,
  type SessionAdvanceKind,
} from '@/engine/session'
import {
  agreedChecklist,
  applyAgreedChecklist,
  applyAnswerToRecords,
  consensusDecisions,
  CONSENSUS_RULE,
  guidanceFor,
  makeSessionStepper,
  pendingAgreedOptionIndex,
  type AgreedChecklistRow,
  type SessionFlowContext,
  type SopGuidance,
  type SopStepDriver,
} from '@/engine/session-flow'
import { scenarioTurnRange, type VictoryAssessment } from '@/engine/rules'
import {
  buildLogBook,
  queryLogBook,
  replaySessionLog,
  type LogBook,
  type LogBookEntry,
  type LogQuery,
  type ReplayReport,
} from '@/engine/log-book'
import {
  describeSaveFile,
  deserializeSaveFile,
  serializeSaveFile,
  type SaveSlotInfo,
} from '@/engine/save-file'
import type { SessionAnswer, SessionQuestion, TerminationReason } from '@/engine/session-types'
import type {
  FlightWeather,
  GameSession,
  Records,
  RngState,
  SessionLogEntry,
  VictoryLocationState,
} from '@/engine/state-types'
import { browserStorage, createId, type KeyValueStorage } from '@/shared'

/**
 * 会话流程条（W6 C10）——**独立**的整局流程驱动器
 *
 * ## 它是什么
 *   按 **2.2 流程表**逐步推进一个回合（Pre-Turn 2 步 → 先手方 A–H → 后手方 A–H → 回合结束，
 *   共 19 步），在规则要求玩家决策处（2.3 先手选择、开局共识开关）停下**待答**，
 *   在 5.0a（回合用尽）/ 5.0b（提前决胜）处分出**终止**结论。
 *
 * ## 与操作台的分工（为什么它是「独立」的）
 *   本 store 只驱动**流程**（段与回合），**不承载盘面算子**：移动、战斗、补给等算子动作仍在
 *   操作台（`useWorkbenchStore`）里做。因此它可以脱离盘面单独跑通整局流程，用于验收与演示；
 *   反之操作台不做流程裁决（面板关闭与否只听这里的会话形态）。
 *
 * ## 盘面事实靠注入
 *   5.0b 的达成与否是**盘面事实**，由调用方用 B20 的 `victory.ts` 求值后经 `earlyDecisionMet` 注入；
 *   本 store 不自行判断控制区（引擎不持盘面）。
 */

/** 剧本数据的首回合天气写法与引擎 `FlightWeather` 的**同义**对照（受限飞行 = Limited Flight） */
const FIRST_TURN_WEATHER: Record<'restricted' | 'normal', FlightWeather> = {
  restricted: 'limited',
  normal: 'normal',
}

/**
 * 存档槽键名（W6 D1：本作只有**一个**存档槽，放在浏览器 `localStorage`）
 *
 * 单槽是刻意的：本期形态为双人同机热坐、单局推进，多槽位属后续单元。
 */
export const SAVE_SLOT_KEY = 'smolensk-ocs.save.slot1'

/**
 * 持久化错误的原因码前缀
 *
 * 存档/读档不是规则条款，故 `rule` 字段记**本工作项编号 `D1`**（可回溯到任务），
 * 便于与内核裁决（2.2 / 2.3 / 5.0a…）区分开。
 */
const SAVE_RULE = 'D1'

/**
 * 「连跑到下一个需要玩家的地方」的**硬上限**（B5 防呆）
 *
 * 正常一个回合只有 19 步，且每回合的 Pre-Turn 先手判定必停下待答 ⇒ 真实连跑远小于此数。
 * 上限存在的意义是：万一将来某段被标成自动却**永不落到玩家步**，宁可停下并如实报 `limit`，
 * 也不要在一次点击里空转到卡死界面。
 */
export const AUTO_ADVANCE_LIMIT = 64

/** 连跑停下时的**去向**（B5；每一档都对应一句能给玩家看的话） */
export type AdvanceStop =
  /** 停下等玩家作答（2.3 先手选择 / 开局共识） */
  | 'question'
  /** 落在需要玩家的环节（A–G） */
  | 'player'
  /** 会话终止（5.0a / 5.0b） */
  | 'terminated'
  /** 被内核拒绝（原因在 `error` 里） */
  | 'refused'
  /** 触到连跑上限（异常；见 `AUTO_ADVANCE_LIMIT`） */
  | 'limit'

/** 连跑的结论（步数 + 去向 + 停下时那一步的驱动方式） */
export interface AdvanceOutcome {
  /** 本次连跑实际推进了几步（0 = 一步没走，例如本来就停在待答处） */
  steps: number
  stoppedBy: AdvanceStop
  /** 停下时所在步的驱动方式（null = 会话未开局/无法确定） */
  driver: SopStepDriver | null
}

/**
 * **盘面快照**的编解码器（P0 修复：存档带盘面）
 *
 * 为什么要有这个注册口：存档文件（引擎 `save-file.ts`）只认识"会话"——记录轨 / 日志 / 种子 /
 * 形态；而**盘面**（算子、补给站、飞机、各类回合与阶段账本）活在 `stores/workbench` 里。
 * 让会话层直接 import 操作台会成环（操作台已 import 会话层：`useGameSessionStore`），
 * 故这里留一个注册口：操作台建店时把自己那对 capture/accepts/restore 挂上来。
 *
 * **未注册**（例如只建会话层的单测）时行为与修前一致：存档里不出现 `board` 字段、读档也不要求它。
 */
export interface BoardCodec {
  /** 抓取当前盘面（返回**可 JSON 化**的载荷；序列化由存档层做） */
  capture(): unknown
  /** 这份载荷认识吗（**先验后改**：不认识就拒读，此刻尚未改动任何状态） */
  accepts(board: unknown): boolean
  /** 还原盘面（调用前应已 `accepts` 通过；本方法不做半途落值） */
  restore(board: unknown): void
}

export const useGameSessionStore = defineStore('gameSession', () => {
  /** 当前剧本（流程条的剧本旋钮；与操作台的剧本各自独立，互不干扰） */
  const scenarioId = ref<string>(scenarios.scenarios[0]?.id ?? '1')

  /** 当前对局会话（null = 尚未开局） */
  const session = ref<GameSession | null>(null)

  /**
   * 5.0b 提前决胜是否达成（**注入的盘面事实**）
   *
   * 由调用方按 B20 的 `decisiveVictory` 结论写入（见 VictoryPanel）；本 store 只接收结论。
   */
  const earlyDecisionMet = ref(false)

  /**
   * ⑬ 接线：操作台推来的**判定结论**（盘面事实的求值结果）
   *
   * 控制事实属于盘面（只有操作台摆着算子），胜负由引擎 `victory.ts` 求值；
   * 本 store 只接收结论、不重算（CODE_SPEC §3.1）：
   *   - `decisive`：5.0b 的提前决胜结论（`ongoing` 即未达成）；
   *   - `final`：5.0a 的最终评估结论，随末回合的收束条目一并写进日志。
   */
  const pushedVerdicts = ref<{
    decisive: VictoryAssessment | null
    final: VictoryAssessment | null
  }>({
    decisive: null,
    final: null,
  })

  /** 内核裁决错误（会话框架抛出的拒绝原因；界面据此保持面板不关） */
  const error = ref<{ rule: string; reason: string } | null>(null)

  /** 最近一次步进的去向 */
  const lastAdvanceKind = ref<SessionAdvanceKind | null>(null)

  /** 最近一次「连跑到下一个需要玩家的地方」的结果（B5；界面据此说话） */
  const lastAdvanceOutcome = ref<AdvanceOutcome | null>(null)

  /* ── W6 D1：存档槽（序列化与会话持久化） ── */

  /** 存档介质（默认浏览器 localStorage；不可用为 null，测试可注入内存实现） */
  const storage = ref<KeyValueStorage | null>(browserStorage())

  /** 当前存档槽的摘要（null = 无档或读不出） */
  const slot = ref<SaveSlotInfo | null>(null)

  /** 存档错误（与内核裁决的 `error` 分开，避免把读档失败显示成「内核拒绝」） */
  const saveError = ref<{ rule: string; reason: string } | null>(null)

  /**
   * 盘面快照编解码器（由 `stores/workbench` 建店时注册；见 `BoardCodec` 的说明）
   *
   * 用普通变量而非 `ref`：它不是界面要看的状态，改它也不该触发任何渲染。
   */
  let boardCodec: BoardCodec | null = null

  /* ────────────────────────────── 派生 ────────────────────────────── */

  /** 当前剧本记录 */
  const scenarioInfo = computed(() =>
    scenarios.scenarios.find((item) => item.id === scenarioId.value),
  )

  /** 共识开关条目（scenarios.agreedOptions：需双方一致同意才生效，必须写入存档） */
  const agreedOptionItems = computed<readonly string[]>(() => scenarios.agreedOptions.items)

  /** 会话形态（null = 未开局） */
  const form = computed(() => (session.value === null ? null : sessionForm(session.value)))

  /** 当前待答问题（null = 无待答） */
  const question = computed<SessionQuestion | null>(() =>
    session.value === null ? null : currentQuestion(session.value),
  )

  /** 是否停下待答（界面据此弹出**不可关闭**的待答面板） */
  const awaiting = computed(() => form.value === 'awaiting')

  /** 是否已终止（界面据此显示终止提示 P3） */
  const terminated = computed(() => session.value !== null && isTerminated(session.value))

  /** 终止原因（null = 未终止） */
  const termination = computed<TerminationReason | null>(() =>
    session.value === null ? null : terminationOf(session.value),
  )

  /** 当前记录轨（回合 / 阶段 / 行动方 / 先手方 / 天气） */
  const records = computed<Records | null>(() => session.value?.state.records ?? null)

  /** 逐步引导（P2）：当前步 + 序号 + 总数 */
  const guidance = computed<SopGuidance | null>(() =>
    session.value === null ? null : guidanceFor(session.value.state.records),
  )

  /** 共识开关的已答结论（逐项 采纳 / 不采纳 / 未作答） */
  const consensus = computed(() =>
    session.value === null ? [] : consensusDecisions(session.value, agreedOptionItems.value),
  )

  /* ── W7 C13：共识开关的**勾选列表**（开局前第一回合的先决条件） ── */

  /**
   * 勾选状态（与 `agreedOptionItems` 等长；true = 该项已与对手达成一致并采纳）
   *
   * 为什么要在 store 里持一份：勾选是**开局前的准备动作**，此时会话可能刚刚建立、
   * 每勾一条就写日志会让「未全部勾选」也留下半截结论；故勾选先记在这里，
   * 由 `confirmAgreedChecklist()`（或 `stepNow()` 的自动补写）一次性经内核
   * （`applyAgreedChecklist`）写成日志结论。
   *
   * ★ 用户口径：勾选框 = 「用不用这一条」——**默认全部不勾（都不用）**，玩家要哪条就勾哪条。
   *   故不再有「全部勾选才放行」的门禁（见 `applyAgreedChecklist`）。
   */
  const agreedChecks = ref<boolean[]>(agreedOptionItems.value.map(() => false))

  /**
   * 每项的**生效选择**（true = 采用；缺省跟随勾选）
   *
   * 界面只有一个勾选框 ⇒ 正常情况下与 `agreedChecks` 完全一致；保留本数组是为了
   * 存档回读（`loadNow` 会把日志里的结论镜像回来）。
   */
  const agreedAdopted = ref<boolean[]>([])

  /** 勾选列表（行 = 条目 + 题号 + 是否采用 + 已写入日志的结论） */
  const agreedChecklistRows = computed<
    readonly (AgreedChecklistRow & {
      /** 勾选 = 采用该条 */
      checked: boolean
      /** 该项是否生效（与勾选一致；存档回读时可能不同） */
      adopted: boolean
      /** 已写入日志的结论（null = 尚未写入） */
      decided: boolean | null
    })[]
  >(() =>
    agreedChecklist(agreedOptionItems.value).map((row) => ({
      ...row,
      checked: agreedChecks.value[row.index] === true,
      adopted: agreedAdopted.value[row.index] ?? agreedChecks.value[row.index] === true,
      decided: consensus.value[row.index]?.adopted ?? null,
    })),
  )

  /**
   * 4.0：**某条共识本局是否采纳**（按**条目文本**查，不按序号 —— 清单增删不会串行）
   *
   * 两段口径，缺一不可：
   *   · 已写入日志的结论优先（`consensus`，读档后也成立）；
   *   · 尚未写入时退回**界面上的实时勾选**（`agreedAdopted` / `agreedChecks`）——
   *     初设（选剧本后的准备）发生在"开始游戏 / 推进第一回合"之前，那时日志里还没有结论，
   *     而 3.4b 这类可选项**在初设就要用**（要不要逐一点名装甲集群）。
   *
   * 未开局（`session === null`）时勾选仍可读 ⇒ 初设面板据此决定默认归属与是否强制点名。
   */
  const agreedOptionAdoptedOf = computed(() => (item: string) => {
    const index = agreedOptionItems.value.indexOf(item)
    if (index < 0) return false
    const decided = consensus.value[index]?.adopted
    if (decided !== null && decided !== undefined) return decided
    return agreedAdopted.value[index] ?? agreedChecks.value[index] === true
  })

  /** 勾选了几条（界面显示「采用 N 条」） */
  const agreedCheckedCount = computed(
    () =>
      agreedOptionItems.value.filter((_item, index) => agreedChecks.value[index] === true).length,
  )

  /** 是否已把勾选写成日志结论（＝存档里已有共识结论） */
  const agreedRecorded = computed(
    () =>
      session.value === null ||
      pendingAgreedOptionIndex(session.value, agreedOptionItems.value) === null,
  )

  /** 勾选 / 取消勾选一项（勾 = 采用该条；不勾 = 不用） */
  function setAgreedCheck(index: number, checked: boolean): void {
    if (index < 0 || index >= agreedOptionItems.value.length) return
    const next = [...agreedChecks.value]
    while (next.length < agreedOptionItems.value.length) next.push(false)
    next[index] = checked
    agreedChecks.value = next
    // 单勾选框语义：生效跟随勾选（清掉历史里可能残留的「谈过但不用」）
    const adopted = [...agreedAdopted.value]
    while (adopted.length < agreedOptionItems.value.length) adopted.push(false)
    adopted[index] = checked
    agreedAdopted.value = adopted
  }

  /** 设定该项是否**生效**（仅存档回读/测试用；界面已统一为单个勾选框） */
  function setAgreedAdopt(index: number, adopted: boolean): void {
    if (index < 0 || index >= agreedOptionItems.value.length) return
    const next = [...agreedAdopted.value]
    while (next.length < agreedOptionItems.value.length) next.push(false)
    next[index] = adopted
    agreedAdopted.value = next
  }

  /** 一键全选 / 全不选（同时把「是否采纳」对齐到勾选） */
  function setAllAgreedChecks(checked: boolean): void {
    agreedChecks.value = agreedOptionItems.value.map(() => checked)
    agreedAdopted.value = agreedOptionItems.value.map(() => checked)
  }

  /** 重置勾选与采纳（开局 / 换剧本 / 重置时调用）——默认**全部不勾（都不用）** */
  function resetAgreedChecklist(): void {
    agreedChecks.value = agreedOptionItems.value.map(() => false)
    // 「是否生效」留空 ⇒ 界面与内核都按「勾选即采纳」的缺省理解（未勾选即不生效）
    agreedAdopted.value = []
  }

  /**
   * 专规 4.0：把勾选列表写成人人对局共识（逐条结论进日志）
   *
   * 勾 = 采用，不勾 = 不用 ⇒ 一条都不勾也照样写入（门禁只要求「结论在日志里」）。
   */
  function confirmAgreedChecklist(): boolean {
    const current = session.value
    if (current === null) {
      error.value = { rule: CONSENSUS_RULE, reason: 'sessionNotStarted' }
      return false
    }
    const plan = applyAgreedChecklist({
      session: current,
      context: flowContext.value,
      checks: agreedChecks.value,
      // 归一化：未显式设定「是否生效」的条目按「勾选即采纳」处理
      adopted: agreedOptionItems.value.map(
        (_item, index) => agreedAdopted.value[index] ?? agreedChecks.value[index] === true,
      ),
    })
    if (!plan.ok) {
      error.value = { rule: plan.rule, reason: plan.reason }
      return false
    }
    session.value = plan.data.session
    lastAdvanceKind.value = null
    error.value = null
    return true
  }

  /** 会话日志（审计与复算用） */
  const log = computed(() => session.value?.log ?? [])

  /* ── W7 D2：结算日志数据层（结构化 / 可检索 / 可展开 / 重放复算） ── */

  /** 日志手册（无会话 ⇒ 空手册，界面无需到处判空） */
  const logBook = computed<LogBook>(() => buildLogBook(log.value))

  /** 当前检索条件（界面绑定；空条件 = 全部） */
  const logQuery = ref<LogQuery>({})

  /** 按检索条件过滤后的日志条目（顺序与日志一致） */
  const logEntries = computed<readonly LogBookEntry[]>(() =>
    queryLogBook(logBook.value, logQuery.value),
  )

  /** 固定种子重放复算报告（无会话为 null） */
  const replayReport = computed<ReplayReport | null>(() =>
    session.value === null ? null : replaySessionLog(session.value),
  )

  /** 当前检索是否生效（有任一条件即视为筛选中） */
  const logFiltered = computed(() =>
    Object.values(logQuery.value).some((value) => value != null && value !== false && value !== ''),
  )

  /** 增改检索条件（只覆盖传入的键；传 null 表示清除该条件） */
  function setLogQuery(patch: LogQuery): void {
    logQuery.value = { ...logQuery.value, ...patch }
  }

  /** 清除全部检索条件 */
  function clearLogQuery(): void {
    logQuery.value = {}
  }

  /* ── ⑭ 接线：操作台各机制的结算通道 ── */

  /**
   * 把**操作台的一笔结算**写进会话日志（D2 的检索与重放随即覆盖它）
   *
   * 会话日志是**唯一**可复算的结算记录（`turn/phase/side/action/rolls/outcome`），
   * 操作台原先只写自己的界面记事（`pushLog`），D2 看不到；本函数补上这一条通道。
   *
   * 约定：
   *   - **未开局**（无会话）⇒ 返回 false，操作台照常独立运行（不凭空造会话）；
   *   - **entry 的 turn/phase** 由调用方（操作台）按**自己的局面钟**填好——操作台是裁判台，
   *     它记的是「这手棋发生在哪一段」；不在这里改写成记录钟，避免两套钟互相覆盖；
   *   - 掷骰必须来自**同一颗 PRNG**（见 `setSessionRng`），否则 D2 的固定种子重放会报分歧。
   */
  function appendSettlement(entry: SessionLogEntry): boolean {
    const current = session.value
    if (current === null) return false
    session.value = appendLog(current, entry)
    return true
  }

  /**
   * 把推进过的骰子状态写回会话（**唯一骰源**）
   *
   * D2 的重放是「按日志逐条、以同一颗 PRNG 重掷并比对骰面」，故操作台的掷骰必须真的
   * 推进 `session.state.rng`——否则重放读到的是一颗没被用过的 PRNG，必然分歧。
   */
  function setSessionRng(next: RngState): void {
    const current = session.value
    if (current === null) return
    session.value = { ...current, state: { ...current.state, rng: next } }
  }

  /**
   * 联调接线：把**操作台**对流程事实的手动改动写回记录轨（当前方 / 阶段 / 回合）
   *
   * ## 为什么需要它
   *   2.2 流程表的事实（当前方 / 阶段 / 回合）**只能有一个权威**：本会话的 `Records`。
   *   操作台（`stores/workbench.ts`）的这三个量是**投影**——有会话时读记录轨、无会话时读本地演练值。
   *   玩家在操作台上手动切方（Tab）/ 切段 / 改回合时，经本函数落回记录轨，
   *   于是「流程条推进」与「操作台手动拨动」写的是同一处，不会再出现两套钟各说各话。
   *
   * ## ★ 第三套钟：`Records.phase` 与 SOP **步指针**的关系（口径，2026-09-14 实测后写死）
   *   流程推进（`stepNow`）走的是 `advanceSession` 内部的**步指针**（`stepIndex`），并按该步
   *   在 `PLAYER_TURN_PHASES` 里的位置写 `Records.phase`。**步指针只由流程条掌握**，本函数不碰它。
   *
   *   由此确定的行为（**手动切段是临时的**）：
   *     - 手动切段 ⇒ `Records.phase` 立即变，操作台的段投影跟着变（可用于裁判临时演练）；
   *     - 下一次 `stepNow()` ⇒ 流程按**自己的步序**写回 `Records.phase`，手动那次被覆盖。
   *   实测：停在 A 飞机整备 → 手动切 `movement` → `stepNow()` ⇒ `Records.phase` 变成 `supply`
   *   （流程的下一步），手动切段消失。
   *
   *   ⇒ 若要"手动切段也必须让流程跟着走到那一段"，需让步指针同步跳步（`session-flow` 暴露
   *     "按段找步"），影响面大于收益，**本期不做**；此处把口径固定下来并加用例
   *     （`tests/stores/integration-sync.test.ts` 的"手动切段是临时的"一条）。
   *
   * 未开局（无会话）⇒ 返回 `false`，调用方退回本地演练值（保持「未开局也能演练」的语义）。
   */
  function patchRecords(patch: Partial<Pick<Records, 'activeSide' | 'phase' | 'turn'>>): boolean {
    const current = session.value
    if (current === null) return false
    session.value = {
      ...current,
      state: { ...current.state, records: { ...current.state.records, ...patch } },
    }
    return true
  }

  /**
   * ⑬ 接线：接收操作台推来的 **5.0c 控制事实**与 **5.0a/5.0b 判定结论**
   *
   * 三件事一次办完：
   *   ① `locations` 落到 `Records.victoryLocations`（5.0c 的「最后控制者」账本）——
   *      引擎侧的 5.0 判定从此可直接消费 `Records`，不再依赖盘面外账本；
   *   ② `decisive` 的结论驱动 5.0b 的提前决胜（等价于勾选「已达成」）；
   *   ③ `final` 存起来，供末回合的 5.0a 收束条目写入结论。
   *
   * `undefined` 的字段表示「本次不更新」，避免单推一项时把另一项清空。
   */
  function pushVictory(input: {
    locations?: readonly VictoryLocationState[]
    decisive?: VictoryAssessment | null
    final?: VictoryAssessment | null
  }): void {
    const current = session.value
    if (current !== null && input.locations !== undefined) {
      const records: Records = { ...current.state.records, victoryLocations: [...input.locations] }
      session.value = { ...current, state: { ...current.state, records } }
    }
    const decisive = input.decisive === undefined ? pushedVerdicts.value.decisive : input.decisive
    const final = input.final === undefined ? pushedVerdicts.value.final : input.final
    pushedVerdicts.value = { decisive, final }
    if (input.decisive !== undefined) {
      earlyDecisionMet.value =
        input.decisive !== null &&
        (input.decisive.outcome === 'axis' || input.decisive.outcome === 'soviet')
    }
  }

  /** 步进依赖（每次步进前按当前会话构造；全部为注入事实） */
  const flowContext = computed<SessionFlowContext>(() => {
    const info = scenarioInfo.value
    const range = scenarioTurnRange(scenarioId.value)
    return {
      firstTurn: range.firstTurn,
      lastTurn: range.lastTurn,
      scenarioFirstPlayer: (info?.firstPlayer ?? 'axis') as Side,
      firstTurnWeather: FIRST_TURN_WEATHER[info?.firstWeather ?? 'normal'],
      earlyDecisionMet: earlyDecisionMet.value,
      // ⑬ 接线：判定结论（操作台推来的盘面求值结果）
      decisiveVictory: pushedVerdicts.value.decisive,
      finalVictory: pushedVerdicts.value.final,
      agreedOptionItems: agreedOptionItems.value,
    }
  })

  /* ────────────────────────────── 动作 ────────────────────────────── */

  /** 换剧本（未开局的会话可用；已开局即拒绝，避免流程与剧本错配） */
  function setScenarioId(next: string): boolean {
    if (session.value !== null && form.value !== 'terminated') {
      error.value = { rule: '2.2', reason: 'scenarioLockedWhilePlaying' }
      return false
    }
    scenarioId.value = next
    session.value = null
    // W7 C13：换剧本即重置共识勾选（新剧本要重新逐项一致同意，专规 4.0）
    resetAgreedChecklist()
    lastAdvanceKind.value = null
    error.value = null
    return true
  }

  /** 开局：建一个空白盘面的会话并置为 advancing（共识开关在首次步进时逐项提问） */
  function startGame(seed = 20260913): boolean {
    const info = scenarioInfo.value
    if (info === undefined) {
      error.value = { rule: '2.2', reason: `scenarioNotFound:${scenarioId.value}` }
      return false
    }
    const now = new Date().toISOString()
    const created: GameSession = {
      meta: { sessionId: createId('session'), createdAt: now, updatedAt: now, schemaVersion: 1 },
      state: {
        scenarioId: scenarioId.value,
        records: {
          turn: scenarioTurnRange(scenarioId.value).firstTurn,
          phase: 'preTurn',
          preTurnSegment: 'weatherDetermination',
          activeSide: null,
          firstPlayer: null,
          weather: { air: FIRST_TURN_WEATHER[info.firstWeather], ground: 'good' },
          railCapacity: railCapacityAtStart(),
          markerTracks: {},
          victoryLocations: [],
          counters: {
            reserveMarkers: info.setup.reserveMarkers,
            supplyCache: { axis: info.setup.supplyCache, soviet: info.setup.supplyCache },
            constructionMarkers: info.setup.constructionMarkers,
          },
        },
        units: [],
        stacks: [],
        markers: [],
        rng: createRngState(seed),
      },
      log: [],
      status: { form: 'created' },
    }
    session.value = startSession(created)
    // W7 C13：每次开局都把共识勾选清空 —— 勾选列表是**本局**的开局准备（专规 4.0）
    resetAgreedChecklist()
    lastAdvanceKind.value = null
    error.value = null
    return true
  }

  /** 开局铁路容量（专规 1.2：取自剧本初设 `setup.railCap`） */
  function railCapacityAtStart(): Record<Side, number> {
    const railCap = scenarioInfo.value?.setup.railCap
    return { axis: railCap?.axis ?? 0, soviet: railCap?.soviet ?? 0 }
  }

  /** 推进一步（自动段直接结算；遇玩家决策停下待答；到收束点即终止） */
  function stepNow(): boolean {
    let current = session.value
    if (current === null) {
      error.value = { rule: '2.2', reason: 'sessionNotStarted' }
      return false
    }
    /*
     * 手点一步 ⇒ 上一次「连跑」的结论已不再描述最近的推进（界面按它措辞，不能让它过期说假话）；
     * 连跑路径会在结束后重新写入。
     */
    lastAdvanceOutcome.value = null
    // W7 C13 + ★ 用户口径：共识列表**默认全部不勾（都不用）**，不再要求先逐条勾选。
    //   4.0 只要求「结论在日志里」⇒ 未写入时在此**用当前勾选自动补写**（默认＝一条都不用），
    //   玩家不必先做一轮勾选；想启用某条可选规则，就在共识面板勾上它再推进（重开一局生效）。
    if (pendingAgreedOptionIndex(current, agreedOptionItems.value) !== null) {
      if (!confirmAgreedChecklist()) return false
      const refreshed = session.value
      if (refreshed === null) return false
      current = refreshed
    }
    try {
      const advance = advanceSession(current, makeSessionStepper(flowContext.value))
      session.value = advance.session
      lastAdvanceKind.value = advance.kind
      error.value = null
      return true
    } catch (cause) {
      // 内核拒绝（待答未答 / 未开局 / 已终止后推进等）：原样记下，不做静默兜底
      error.value = { rule: '2.2', reason: (cause as Error).message }
      return false
    }
  }

  /**
   * 连跑到**下一个需要玩家的地方**（B5：用户口径「自动进行的阶段不需要玩家介入」）
   *
   * 用户口径（2026-09-16 ⑩）：「点击进入下一个阶段后，自动进行的阶段不需要玩家介入，
   * 直到开始玩家要介入的环节 …… 新的必须是点击**自动进入下一环节**」；
   * 且「自动阶段一定要自动进行，例如后手玩家进击阶段的战斗环节结束后自动清理、自动判天气、事件，
   * 玩家要做的第一件事：如果存在需要由玩家决定的事件先让玩家决定，然后判定先后手选择」。
   *
   * 故本函数＝反复 `stepNow()`，直到：
   *   · **停下待答**（`awaiting`：2.3 先手选择 / 开局共识）——玩家先决定，决定完再点；
   *   · **落在玩家环节**（该步 `driver === 'player'`）——该环节的动作由玩家在盘面上做；
   *   · **终止**（5.0a 回合用尽 / 5.0b 提前决胜）；
   *   · 被内核拒绝（把 `error` 留给界面，不吞）。
   *
   * ★ 判"要不要停"的是**运行时的 `awaiting`**，不是静态的 `driver`：标着 `question` 的步
   *   （先手判定 2.3）**未必真的发问**——首回合由剧本指定、玩家已答过时会直接算完并前进。
   *   若按静态 `driver` 停，首回合就会在"其实不用玩家说话"的先手判定上白白停一次，
   *   与用户口径「自动阶段一定要自动进行」相悖。故：**只有在真的挂起了一个待答问题时才停**；
   *   `question` 步若没发问，就继续走。
   *
   * `stepNow()` 本身**保持不变**（引擎验证页与既有流程用例仍按"一步一停"驱动）；
   * 本函数只是把"连跑"这件事收在一处，界面不再自己写循环。
   */
  function advanceToNextStop(): AdvanceOutcome {
    // 已经停在待答处：一步都不要走（玩家没作答，步进也会被内核拒绝）
    if (awaiting.value) return { steps: 0, stoppedBy: 'question', driver: 'question' }

    let steps = 0
    let stoppedBy: AdvanceOutcome['stoppedBy'] = 'refused'
    let driver: SopStepDriver | null = guidance.value?.step.driver ?? null

    for (let guard = 0; guard < AUTO_ADVANCE_LIMIT; guard += 1) {
      if (!stepNow()) {
        stoppedBy = 'refused'
        break
      }
      steps += 1
      if (lastAdvanceKind.value === 'terminated') {
        stoppedBy = 'terminated'
        break
      }
      if (awaiting.value) {
        stoppedBy = 'question'
        driver = 'question'
        break
      }
      driver = guidance.value?.step.driver ?? null
      if (driver === 'automatic' || driver === 'question') {
        // 自动段继续；`question` 步尚未发问（见上），也继续
        if (guard === AUTO_ADVANCE_LIMIT - 1) stoppedBy = 'limit'
        continue
      }
      stoppedBy = 'player'
      break
    }

    lastAdvanceOutcome.value = { steps, stoppedBy, driver }
    return lastAdvanceOutcome.value
  }

  /**
   * 作答题（强制选择）
   *
   * 校验交给会话框架（题号 / 应答方 / 选项在列），**拒绝即面板不关**；
   * 通过后按问题类别落地（2.3 先手选择写入 `firstPlayer`；共识开关只入日志）。
   */
  function answerNow(optionId?: string): boolean {
    const current = session.value
    if (current === null || current.status.form !== 'awaiting') {
      error.value = { rule: '2.2', reason: 'noPendingQuestion' }
      return false
    }
    const pending = current.status.question
    const answer: SessionAnswer = {
      questionId: pending.id,
      side: pending.responder,
      ...(optionId === undefined ? {} : { optionId }),
    }
    try {
      const answered = answerQuestion(current, answer)
      const nextRecords = applyAnswerToRecords({
        records: answered.state.records,
        question: pending,
        answer,
      })
      session.value = { ...answered, state: { ...answered.state, records: nextRecords } }
      lastAdvanceKind.value = null
      error.value = null
      return true
    } catch (cause) {
      error.value = { rule: pending.rule, reason: (cause as Error).message }
      return false
    }
  }

  /** 重置：清空会话（保留剧本选择） */
  function resetGame(): void {
    session.value = null
    lastAdvanceKind.value = null
    earlyDecisionMet.value = false
    error.value = null
    // W7 C13：勾选列表随会话一起清空
    resetAgreedChecklist()
  }

  /* ────────────────────────────── W6 D1：存档 / 读档 / 清档 ────────────────────────────── */

  /** 注入存档介质（测试用内存实现；`null` 表示禁用持久化） */
  function setSaveStorage(adapter: KeyValueStorage | null): void {
    storage.value = adapter
    saveError.value = null
  }

  /**
   * 注册盘面快照编解码器（P0 修复：存档带盘面）
   *
   * 由操作台建店时调用一次；传 `null` 即摘掉（操作台没建起来时，存档退回"只有会话"的旧行为）。
   */
  function setBoardCodec(codec: BoardCodec | null): void {
    boardCodec = codec
  }

  /** 读存档槽文本（取不到即 null） */
  function readSlotText(): string | null {
    const adapter = storage.value
    if (adapter === null) return null
    try {
      return adapter.getItem(SAVE_SLOT_KEY)
    } catch (cause) {
      saveError.value = { rule: SAVE_RULE, reason: `storageReadFailed:${(cause as Error).message}` }
      return null
    }
  }

  /**
   * 保存到存档槽
   *
   * 写盘时间戳由本层盖章（引擎无时钟）；写入后**立刻用同一套读档校验回读一次摘要**，
   * 保证「存进去的一定读得出来」——若回读失败，说明落盘内容有问题，当场报错。
   */
  function saveNow(): boolean {
    const current = session.value
    if (current === null) {
      saveError.value = { rule: SAVE_RULE, reason: 'noSessionToSave' }
      return false
    }
    const adapter = storage.value
    if (adapter === null) {
      saveError.value = { rule: SAVE_RULE, reason: 'storageUnavailable' }
      return false
    }
    /*
     * P0 修复（B48）：存档必须**带盘面**。
     * 修前这里只序列化会话（记录轨 / 日志 / 种子）——而盘面（算子、补给站、飞机、账本）全在
     * 操作台里，谁都没存过 ⇒ 读档后"时钟走了、盘面没走"，两者互相矛盾。
     * 抓取失败时**不落盘**：宁可当场报错，也不要存出一份"没有盘面"的档去骗后面的读档。
     */
    let board: unknown
    if (boardCodec !== null) {
      try {
        board = boardCodec.capture()
      } catch (cause) {
        saveError.value = {
          rule: SAVE_RULE,
          reason: `boardCaptureFailed:${(cause as Error).message}`,
        }
        return false
      }
    }
    const text = serializeSaveFile(current, new Date().toISOString(), undefined, board)
    try {
      adapter.setItem(SAVE_SLOT_KEY, text)
      slot.value = describeSaveFile(text)
    } catch (cause) {
      saveError.value = {
        rule: SAVE_RULE,
        reason: `storageWriteFailed:${(cause as Error).message}`,
      }
      return false
    }
    saveError.value = null
    return true
  }

  /**
   * 从存档槽读档
   *
   * 逐层校验（存档文件版本 → 数据契约版本 → 剧本存在 → 会话信封与形态 → 内外剧本一致），
   * **任一层不符即拒**，且**不动当前会话**（不静默清空、不半途替换）；
   * 通过后恢复：剧本、会话本体（含待答问题形态）、共识结论（在日志里）。
   */
  function loadNow(): boolean {
    const text = readSlotText()
    if (text === null) {
      // 取不到槽文本有两种情形，原因要分清（否则界面会把「无档」误报成上一次的错误）：
      //   · 存储本身读失败 ⇒ 保留 `readSlotText` 记下的原因；
      //   · 存储正常但槽里没东西 ⇒ 记为 emptySlot。
      if (saveError.value === null || !saveError.value.reason.startsWith('storageReadFailed')) {
        saveError.value = { rule: SAVE_RULE, reason: 'emptySlot' }
      }
      return false
    }
    try {
      const file = deserializeSaveFile(text)
      /*
       * P0 修复（B48）：**先验后改**——注册了编解码器就必须认这份盘面，两条拒绝路径都在
       * 改动任何状态之前返回：
       *   · 没有 `board` 字段 ⇒ 这是修前写的旧档（或槽内容被手工改过）。读它必然得到"记录轨
       *     走了、盘面留在原处"的错位态，正是本项要消灭的东西 ⇒ 拒读并说明原因；
       *   · 有字段但形态不认识（版本号或字段表不符）⇒ 同样拒读，不半途落值。
       */
      const boardPayload = file.board
      if (boardCodec !== null) {
        if (boardPayload === undefined) {
          saveError.value = {
            rule: SAVE_RULE,
            reason: 'boardMissing:该档不含盘面快照（修前存档）——读它会让记录轨与盘面错位，故拒读',
          }
          return false
        }
        if (!boardCodec.accepts(boardPayload)) {
          saveError.value = {
            rule: SAVE_RULE,
            reason: 'boardUnrecognized:盘面快照的版本或字段表不认识（快照来自别的构建？）',
          }
          return false
        }
      }
      scenarioId.value = file.scenarioId
      session.value = file.session
      // 新会话上台：上一次的裁决记录与盘面注入值一并复位（不沿用上一局）
      lastAdvanceKind.value = null
      earlyDecisionMet.value = false
      error.value = null
      // W7 C13：读档即按存档里的共识结论回填勾选与采纳（结论已是「已写入日志」态，勾选只是界面镜像）
      const loaded = consensusDecisions(file.session, agreedOptionItems.value)
      agreedChecks.value = loaded.map((decision) => decision.adopted !== null)
      agreedAdopted.value = loaded.map((decision) => decision.adopted === true)
      /*
       * 盘面还原**排在最后**：上面 `scenarioId.value = …` 触发的那两个同步 watch
       * （`refreshScenarioBoundLedgers` / `seedVictoryControlFromScenario`）会按**新剧本**重播
       * 13.3f 换轨账本与 5.0c 胜利格控制账本；顺序反了，这两本账会被那次重播冲掉。
       */
      if (boardCodec !== null && boardPayload !== undefined) boardCodec.restore(boardPayload)
      slot.value = describeSaveFile(text)
      saveError.value = null
      return true
    } catch (cause) {
      saveError.value = { rule: SAVE_RULE, reason: (cause as Error).message }
      return false
    }
  }

  /** 清空存档槽（不影响当前会话） */
  function clearSlotNow(): boolean {
    const adapter = storage.value
    if (adapter === null) {
      saveError.value = { rule: SAVE_RULE, reason: 'storageUnavailable' }
      return false
    }
    try {
      adapter.removeItem(SAVE_SLOT_KEY)
    } catch (cause) {
      saveError.value = {
        rule: SAVE_RULE,
        reason: `storageRemoveFailed:${(cause as Error).message}`,
      }
      return false
    }
    slot.value = null
    saveError.value = null
    return true
  }

  /** 刷新存档槽摘要（读不出即置空并记原因；不抛错，供界面随时调用） */
  function refreshSlotNow(): void {
    const text = readSlotText()
    if (text === null) {
      slot.value = null
      return
    }
    try {
      slot.value = describeSaveFile(text)
      saveError.value = null
    } catch (cause) {
      // 槽里有内容但读不出（版本不符/内容损坏）：摘要置空并如实报因
      slot.value = null
      saveError.value = { rule: SAVE_RULE, reason: (cause as Error).message }
    }
  }

  // 建店时先看一眼槽里有没有档（浏览器里 localStorage 可用；测试环境为 null）
  refreshSlotNow()

  return {
    // 状态
    scenarioId,
    session,
    earlyDecisionMet,
    error,
    lastAdvanceKind,
    // B5：连跑到下一个需要玩家的地方（唯一「进入下一环节」的底座）
    lastAdvanceOutcome,
    // 派生
    scenarioInfo,
    agreedOptionItems,
    form,
    question,
    awaiting,
    terminated,
    termination,
    records,
    guidance,
    consensus,
    // W7 C13：共识勾选列表（专规 4.0；勾 = 采用该条，默认全部不勾）
    agreedChecks,
    agreedAdopted,
    agreedChecklistRows,
    agreedCheckedCount,
    agreedRecorded,
    // B50：按条目文本读共识结论（3.4b 可选项等）
    agreedOptionAdoptedOf,
    setAgreedCheck,
    setAgreedAdopt,
    setAllAgreedChecks,
    confirmAgreedChecklist,
    resetAgreedChecklist,
    log,
    flowContext,
    // W7 D2：结算日志
    logBook,
    logQuery,
    logEntries,
    logFiltered,
    replayReport,
    setLogQuery,
    clearLogQuery,
    // ⑭/⑬ 接线：操作台结算入账 / 唯一骰源写回 / 判定结论接收
    appendSettlement,
    setSessionRng,
    patchRecords,
    pushVictory,
    pushedVerdicts,
    // 动作
    setScenarioId,
    startGame,
    stepNow,
    advanceToNextStop,
    answerNow,
    resetGame,
    // W6 D1：存档
    storage,
    slot,
    saveError,
    setSaveStorage,
    // P0 修复（B48）：盘面快照编解码器的注册口（由操作台建店时挂上）
    setBoardCodec,
    saveNow,
    loadNow,
    clearSlotNow,
    refreshSlotNow,
  }
})
