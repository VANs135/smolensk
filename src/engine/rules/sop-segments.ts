import type { Side } from '@/data'

import type { SopStepDriver } from '../session-flow-steps'
import { GAME_PHASES, type GamePhase } from '../state-types'
import type { ActionKind } from './legality'
import { actionNeedsFuel, type FuelRelevantAction } from './fuel'

/**
 * **环节链**：一个 SOP 段里玩家依次过哪几个环节（B6）
 *
 * ## 这张表不是设计出来的，是**抄**出来的
 *
 * 「环节」不是我发明的粒度——**2.2 流程表的段名原文里就带子步**（源库 `charts.json → tables.sop`，
 * 状态 `confirmed`，出处 `OCS_SOP_CN.pdf / v4.3 charts p1`）：
 *
 * ```
 * C. Movement Phase:      Breakout / Mode & Movement / Barrage (air & ship only)
 * E. Reaction Phase:      Movement / Barrage
 * F. Combat Phase:        Barrage (artillery only) / Combat
 * G. Exploitation Phase:  Movement / Barrage / Combat
 * ```
 *
 * 只有 A / B / D / H 四段原文**没有**子步，它们的链条按下面两种方式给出（**不是**一刀切）：
 *   · **A（整备）与 H（清理）**：原文只有一块，且这一块里就是一个动作 ⇒ 链条**只有一环**；
 *   · **B（增援）与 D（补给）**：原文也只有一块，但这一块里装着**若干条各自成文的动作**
 *     （13.6 到货 / 13.5 重建 / 20.0c 吸收 / 专规 3.6 事件 … ＋ 12.10e 恢复部队储备 / 12.6 检定与 12.8 损耗）
 *     ⇒ 按条文**各成一环**，次序为"条文与既有实现的自然次序"，并在各环 `note` 里标明
 *     「次序未由条文固定」。这样界面才能逐环引导（否则 B/D 会变成"一块里塞十件事"）。
 *     ★ D 段两环＝12.10e 恢复部队储备 → 12.6/12.6c/12.6d/12.8 补给检定（用户 2026-09-19 口径）；
 *       **燃料不属本段**（12.5c 绑在消耗时刻 ⇒ 见 `OPERATION_TIMINGS` 与 `TIMING_DEFERRED_ACTIONS`）。
 *
 * 用户 2026-09-16 举的例子与原文完全对得上：「**战斗阶段先是炮击环节**，玩家不想轰炸后点击下一环节进入
 * **战斗环节**」＝「Barrage (artillery only) / Combat」；「移动环节……还能**突袭**、对非战斗单位发起**特殊效果**」
 * ＝都在「Mode & Movement」这一环内（8.0 突袭原文即「发生在**各个移动环节**」，不是独立环节）。
 *
 * ## 与既有实现的两处接缝（本模块只**汇总**，不另立口径）
 *
 *   1. **动作族**直接用 `legality.ts#ACTIONS_BY_PHASE` 的 `ActionKind` 词表，并把每个动作**挂到它所属的那一环**；
 *      不变量由测试钉住：**每段「各环节动作的并集」必须恰好等于 `ACTIONS_BY_PHASE[该段]`**
 *      ——少一个（动作无家可归）或多一个（凭空发明动作）都会红。这样两张表不可能各走各的。
 *   2. **空中任务的环节**沿用 `air-mission.ts#AIR_MISSION_SEGMENT`（14.2e：低空扫射/空运/空投/基地转移/战机扫荡
 *      在**移动环节**，空军轰炸/运输破坏在**轰炸环节**），本模块不重列，只在该环节的 `note` 里点名。
 *
 * ## 两处**纠正**（原 UI 方案 §4.1.6 的表写错了，以条文与既有实现为准）
 *
 *   - **15.4 空军基地缩减不在 A 段**：`air-mission.ts` 的判据是 `reductionOnlyInMovementPhase`
 *     （条文「同一个友方空军基地在一个**阶段**只能被缩减一次」＋ 移动阶段限定）⇒ 归 **C 段**的「模式与移动」。
 *   - **随机事件（专规 3.6）与可变撤离（专规 3.3c）不在 Pre-Turn**：两条原文都写「每个**轴方增援阶段**」
 *     ⇒ 归 **B 段**。故 Pre-Turn 只有「天气判定 → 先手判定」两环，用户要的
 *     「先让玩家决定事件、再判先后手」在**回合内**仍成立：事件在 B 段（早于本回合的任何移动/战斗）。
 *
 * ## 三处**不是环节**的东西（别把它们放进环节链）
 *
 *   - **20.0d 吸收拆分单位**：原文「减损的多军力单位在**任何阶段结束时**都必须吸收……**只有在这些时机**
 *     才能吸收拆分单位」⇒ 它是**段末的强制收束**，不属于任何环节（B8 因此**不**给它补环节闸门；
 *     store 的 `settleAbsorbObligationsNow` / `absorbBreakdownNow` 走的就是 20.0d 的 `segmentEnd` 时机）。
 *     20.0a 的**创建**才是环节内动作（「开始移动」⇒ C 段；「战后推进/撤退」⇒ F/G 段的战斗环节）。
 *   - **12.8a 断补损耗**：D 段的**段末**检查（故它作为 D 的最后一环登记，但判定口径是"段末"，见该环 `note`）。
 *   - **5.10 / 2.2 注的清理**：H 段全自动，无玩家动作。
 *
 * ## 次序纪律
 *   SOP 原文给了子步的段（C/E/F/G）**照原文次序**；A/H 原文一块一环；
 *   B/D 原文虽只给一块，但块内动作**各自成文**（见上），故按条文分环、次序取自然次序并注明。
 *   环节**可空过**（不想做就点同一个按钮过去），但已做的动作不可撤销（除既有的 6.1h 撤销一步）。
 *
 * ## 本批不做
 *   B7 才据此写「资格表」（`allowedActionsOf` / `participatesIn`）；B9 才接线到界面。
 *   本模块只提供**结构**（有哪些环节、次序如何、每环许可哪些动作族、谁能过这一环），不含任何结算。
 */

/* ────────────────────────────── 类型 ────────────────────────────── */

/** 一个**环节**（2.2 段名原文里的子步，或原文未列子步时该段唯一的那个环节） */
export interface SopSegmentStep {
  /** 稳定标识：`<段>.<环节>`（如 `movement.barrage`、`combat.combat`） */
  id: string
  /** 环节名（中文；原文有子步的段照原文字面翻译，并在 `note` 里附原文） */
  label: string
  /** 规则出处（条文号；多处以 ` / ` 分隔） */
  rule: string
  /** 驱动方式：自动 / 玩家 / 待答（与 `session-flow-steps` 的段级驱动同一词表） */
  driver: SopStepDriver
  /** 本环节许可的动作族（空数组＝本环节没有"要玩家在盘面上做"的动作族） */
  actions: readonly ActionKind[]
  /** 该环节只属于某一方（缺省＝双方都过） */
  sides?: readonly Side[]
  /**
   * 该环节的**动作是否已在 store 实现**（缺省 true）
   *
   * `false` ＝ 条文要求有这一环，但 store 里**一个入口都没有**（B8 补闸门时逐项核出来）。
   * 这种环节**不能占住"当前环节"**：它在规则上存在、在实现上是空的，若让玩家停在上面，
   * 就变成"每次移动阶段先点一次没有任何作用的空环节，期间还动不了任何单位"——纯摩擦。
   * 故流程推进时会像自动环节一样**跳过**它；等实现落地，把本标志去掉它就成了真环节。
   * 目前只剩一处（见该环 `note` 的"实现缺口"）：特殊补员抽取 专规 1.6c。
   * （突围 12.8e 已由 B47 接线；编队抽取 专规 13.7 已由批 E 切片 2 接线 —— `containers.drawAndApplyStepNow()`。）
   */
  implemented?: boolean
  /**
   * 该环节**无事可做时可自动跳过**（用户 2026-09-16 裁定②：「如果玩家在自己的突围环节无事可做，那么可以自动跳过」）
   *
   * 「有事可做」的判据由调用方给（要读盘面：本处只能看条文，看不见算子）——
   * 唯一实现是 `workbench` 里那条与闸门同源的 `participatesIn`：**本环节有谁参与，就有活可做**。
   * 目前只有**突围**（12.8e）标了这一条：一个断补单位都没有时，本方的突围环节无事可做 ⇒ 自动跳过，
   * 不必让玩家点一次空环节（同时段内其余环节照旧）。
   */
  skipWhenIdle?: boolean
  /** 补充说明（次序依据 / 与其它模块的接缝 / 已知缺口） */
  note?: string
}

/** 一个段的**环节链** */
export interface SopSegmentChain {
  phase: GamePhase
  /** 段名（2.2 流程表的中文名） */
  label: string
  /** SOP 段名原文（逐字照录，便于与源库对账） */
  sopText: string
  /** 环节链（按 SOP 原文次序；原文无子步的段只一环） */
  steps: readonly SopSegmentStep[]
}

/* ────────────────────────────── 环节链 ────────────────────────────── */

/** 2.2 流程表：Pre-Turn + A–H + Turn End 共 10 段的环节链 */
export const SOP_SEGMENT_CHAINS: readonly SopSegmentChain[] = [
  {
    phase: 'preTurn',
    label: '回合准备',
    sopText: 'Weather Determination / First Player Determination',
    steps: [
      {
        id: 'preTurn.weatherDetermination',
        label: '天气判定',
        rule: '1.5',
        driver: 'automatic',
        actions: [],
        note: '掷 1 骰查天气表（1 受限飞行 / 2–6 正常；本作地面恒良好）；首回合按剧本指定不掷骰。★ 原文（`charts.json → tables.sop`）把「天气判定 / 先手判定」列在**段**一级，引擎把它们建成 `preTurn` 段的两个子步 ⇒ 本表按引擎口径把它们当**环节**；界面据此显示「阶段＝回合准备，环节＝天气判定 / 先手判定」（同一件事的两个层级视角，不在界面上并列两遍）',
      },
      {
        id: 'preTurn.firstPlayerDetermination',
        label: '先手判定',
        rule: '2.3',
        driver: 'question',
        actions: [],
        note: '双方各掷 2d6、高者选择本回合先手或后手（选择必须由胜者输入 ⇒ 待答）；首回合由剧本指定',
      },
    ],
  },
  {
    phase: 'aircraftRefit',
    label: 'A 飞机整备',
    sopText: 'A. Aircraft Refit Phase',
    steps: [
      {
        id: 'aircraftRefit.refit',
        label: '整备',
        rule: '15.1',
        driver: 'player',
        actions: ['refit'],
        note: '1T/基地、2 机/基地等级；未抵消的敌方 ZOC 内不可整备；天气不影响整备。★15.4 基地缩减属 C 段（见 C 段）',
      },
    ],
  },
  {
    phase: 'reinforcement',
    label: 'B 增援',
    sopText: 'B. Reinforcement Phase',
    steps: [
      {
        id: 'reinforcement.replRoll',
        label: '补员表与补给表掷骰',
        rule: '1.6b',
        driver: 'automatic',
        actions: [],
        note: '双方各自掷；段内次序未由条文固定（SOP 原文未列子步）',
      },
      {
        id: 'reinforcement.arrival',
        label: '到货落位',
        rule: '13.6 / 1.6a',
        driver: 'player',
        actions: ['arrival'],
        note: '到达表投放（入口格 / 空军基地 / 死亡堆 1.6a）；编内卡车满载 SP 入场 13.6c',
      },
      {
        id: 'reinforcement.randomEvent',
        label: '随机事件（轴方）',
        rule: '专规 3.6',
        driver: 'automatic',
        actions: [],
        sides: ['axis'],
        note: '19 July–15 Aug（含）每个轴方增援阶段掷 2 骰；后果多为自动（空军转非激活等），个别结果需玩家落位（如补给列车）',
      },
      {
        id: 'reinforcement.variableExit',
        label: '可变撤离（轴方）',
        rule: '专规 3.3c',
        driver: 'automatic',
        actions: [],
        sides: ['axis'],
        note: '19 Aug 起每个轴方增援阶段掷 1 骰：1 移除 SS Reich、6 移除 14 Mtr、2–5 下回合再掷（无选择）',
      },
      {
        id: 'reinforcement.rebuild',
        label: '重建与整编',
        rule: '13.5 / 13.9',
        driver: 'player',
        actions: ['rebuild', 'consolidate'],
        note: 'Pax / Eq 的使用与留存；13.9 的第 4 项（飞机）可在任何阶段进行',
      },
      {
        id: 'reinforcement.formationDraw',
        label: '编队抽取（轴方）',
        rule: '专规 13.7',
        driver: 'player',
        actions: [],
        sides: ['axis'],
        implemented: true,
        note: '从抽取盒抽编队标记（辅助卡 `formation_draw` 分区，仅轴方）。★批 E 切片 2：入口已接线 —— `containers.drawAndApplyStepNow()`（B 段该环节内：抽签 → 落盘 → 回写初设台账），闸门照 `ACTION_GATES.rein.formationDraw`（仅轴方）',
      },
      {
        id: 'reinforcement.specialRepl',
        label: '特殊补员抽取（苏方）',
        rule: '专规 1.6c',
        driver: 'player',
        actions: [],
        sides: ['soviet'],
        implemented: false,
        note: '19 Aug 起停止（`exclusive-timing` 的 specialReplEnd）。★实现缺口：store 里**没有**对应入口（`specialRepl` 全仓 0 处），故 B8 无从补闸门',
      },
      {
        id: 'reinforcement.frontalReserves',
        label: '方面军预备队（苏方）',
        rule: '专规 2.3c',
        driver: 'player',
        actions: [],
        sides: ['soviet'],
        note: '22 Jul / 1 Aug / 1 Sep 三批，**必须当即领取**（SP ＋ 编制转化 ＋ 两次免费重建）',
      },
    ],
  },
  {
    phase: 'movement',
    label: 'C 移动',
    sopText: 'C. Movement Phase: Breakout / Mode & Movement / Barrage (air & ship only)',
    steps: [
      {
        id: 'movement.breakout',
        label: '突围',
        rule: '12.8e',
        driver: 'player',
        actions: ['breakout'],
        skipWhenIdle: true,
        note: 'SOP 注：「before any other movement」⇒ **先于其它一切移动**；仅断补单位可尝试（运输点数首回合豁免）。★ 用户裁定②：**本方无事可做时自动跳过**（判据＝本环节无人参与 ⇒ 见 `workbench.playerSegmentSteps`）。★ **B47（2026-09-17）已接线**：store 的 `breakoutNow` / `breakoutCandidates` + 移动面板的「可尝试突围的单位」一节；12.8e-A 的路径事实由 store 的 `breakoutPathFacts` 备齐，判据仍在 `engine/rules/breakout.ts#canBreakout`。',
      },
      {
        id: 'movement.modeAndMovement',
        label: '模式与移动',
        rule: '5.4a / 6.x / 8.0 / 13.3 / 13.8d / 16.0b',
        driver: 'player',
        actions: [
          'modeChange',
          'move',
          'overrun',
          'railTransport',
          'railConversion',
          'loadUnload',
          'engineer',
          'buildHedgehog',
          'breakdown',
        ],
        note:
          '原文本环括住这些动作：改模式 5.4a、常规移动 6.x（含 4.5a-A 确认）、突袭 8.0（原文「发生在各个移动环节」）、' +
          '铁路运输 13.3、换轨 13.3f、装载/卸载 13.2f、建造 13.8d / 工事 16.0b / 基地 15.3 / **基地缩减 15.4**、' +
          '20.0a 拆分（「开始移动」时机）；另含 12.11a 销毁补给站（原文即「己方移动/反应/进击阶段的移动环节」）',
      },
      {
        id: 'movement.barrage',
        label: '轰炸（仅空中与舰炮）',
        rule: '10.0 / 14.7b',
        driver: 'player',
        actions: ['barrage'],
        note: '原文限定（air & ship only）；炮兵轰炸属 F 段（见 `BARRAGE_SOURCES_BY_PHASE`）。低空扫射 14.7d 按 10.0 结算但属**移动环节**的空军任务',
      },
    ],
  },
  {
    phase: 'supply',
    label: 'D 补给',
    sopText: 'D. Supply Phase',
    steps: [
      {
        id: 'supply.recovery',
        label: '恢复部队储备',
        rule: '12.10e',
        driver: 'player',
        actions: [],
        note:
          '12.10e：为带 low/exhausted 标志的单位恢复部队储备（低下 2T、耗尽 4T；多军力单位按 RE 计），' +
          '且**优先级高于**把 SP 用于追溯补给（12.10e-A）；SP 不足以完全恢复时消耗现有的**全部**补给，' +
          '只剩 1T 则直接浪费（12.10e-C）；恢复经 12.10e-B 的直接拖取 / 指挥部投递取得（12.3a·b）。' +
          '★ 2.2 原文只给段名、未列子步 ⇒ 本环按用户 2026-09-19 口径分出，次序＝条文的自然次序',
      },
      {
        id: 'supply.check',
        label: '补给检定',
        rule: '12.6 / 12.6c / 12.6d / 12.8a–c',
        driver: 'player',
        actions: ['supplyTrace', 'hqThrow'],
        note:
          '12.6：逐个战斗单位判「能否追溯到补给源」（12.6a 三种源；12.6b 源格有未抵消敌方 ZOC 即不可用）；' +
          '追溯不到者可「吃图上补给」（12.6c：每 1T 喂最多 2RE、小数向上取整，**永不强迫**）' +
          '或按 12.6d 标断补 ⇒ 12.8a 对**所有**断补堆叠检查损耗（12.8b 掷骰、12.8c 取列）。' +
          '★ 12.5 燃料**不在本段**：12.5c 把付款绑在**消耗时刻**（「在发生燃料消耗的任何阶段」），' +
          '故加油在 C/E/G 三段的**移动环节**当场付（用户 2026-09-19 口径：删掉原先多出来的「加油」环节）',
      },
    ],
  },
  {
    phase: 'reaction',
    label: 'E 反应',
    sopText: 'E. Reaction Phase: Movement / Barrage',
    steps: [
      {
        id: 'reaction.movement',
        label: '反应移动',
        rule: '7.0a / 5.7b / 8.0',
        driver: 'player',
        /*
         * 7.0 首句：「反应阶段是非阶段玩家可利用**移动、突袭和轰炸**打乱敌方计划的机会」；
         * 7.0b：「反应阶段中，轰炸和**突袭**的结算照常」。
         * ⇒ 突袭属本环（8.0 亦云「发生在各个移动环节」）。修前本环只给了 `move`
         *   ⇒ 反应阶段按 4.5a-A 停车的轮式单位**无处突袭**（第六批 BUG ①）。
         */
        actions: ['reserveRelease', 'move', 'overrun'],
        note: '非行动方的**已释放预备**单位才可动（7.0a）；释放动作本身即 5.7b；7.0b：本阶段的轰炸与**突袭**照常结算',
      },
      {
        id: 'reaction.barrage',
        label: '反应轰炸',
        rule: '10.0',
        driver: 'player',
        actions: ['barrage'],
        note: '轰炸来源不受 C 段（air & ship only）限制，见 `BARRAGE_SOURCES_BY_PHASE`',
      },
    ],
  },
  {
    phase: 'combat',
    label: 'F 战斗',
    sopText: 'F. Combat Phase: Barrage (artillery only) / Combat',
    steps: [
      {
        id: 'combat.barrage',
        label: '炮击环节',
        rule: '10.0',
        driver: 'player',
        actions: ['barrage'],
        note: '原文限定（artillery only）；空军轰炸在本段的**轰炸环节**内由 14.7b 宣布（`AIR_MISSION_SEGMENT`）',
      },
      {
        id: 'combat.combat',
        label: '战斗环节',
        rule: '9.2–9.13',
        driver: 'player',
        actions: ['attack', 'breakdown'],
        note: '9.2 九步（含 9.10 选项、9.12 撤退、9.12g 推进）；9.13 进击标记**只在战斗阶段发起的攻击**才判（`battle.ts`：`exploitOnlyInCombatPhase`）；20.0a 的战后推进/撤退同属本环',
      },
    ],
  },
  {
    phase: 'exploitation',
    label: 'G 进击',
    sopText: 'G. Exploitation Phase: Movement / Barrage / Combat',
    steps: [
      {
        id: 'exploitation.movement',
        label: '进击移动',
        rule: '11.0a / 5.7b',
        driver: 'player',
        actions: ['reserveRelease', 'move', 'overrun'],
        note: '只有行动方的**进击标记**单位或**已释放预备**可动（11.0a）；移动规则同 6.0，故含突袭 8.0',
      },
      {
        id: 'exploitation.barrage',
        label: '进击轰炸',
        rule: '11.0 / 10.0',
        driver: 'player',
        actions: ['barrage'],
      },
      {
        id: 'exploitation.combat',
        label: '进击战斗',
        rule: '11.0 / 9.13b-B',
        driver: 'player',
        actions: ['attack', 'breakdown'],
        note: '9.13b-B：进击阶段的攻击**不再产生**进击标记',
      },
    ],
  },
  {
    phase: 'cleanUp',
    label: 'H 清理',
    sopText: 'H. Clean Up Phase',
    steps: [
      {
        id: 'cleanUp.auto',
        label: '自动清理',
        rule: '2.2 注',
        driver: 'automatic',
        actions: ['cleanUp'],
        note: '摘 DG 与进击标记、翻面燃料标记、移除敌方运输破坏标记——**无玩家动作**',
      },
    ],
  },
  {
    phase: 'turnEnd',
    label: '回合结束',
    sopText: 'advance turn marker',
    steps: [
      {
        id: 'turnEnd.advance',
        label: '推进回合标记',
        rule: '2.2',
        driver: 'automatic',
        actions: [],
        note: '回合 +1、日期随回合轨；到本剧本末回合即按 5.0a 收束',
      },
    ],
  },
]

/* ────────────────────────────── 取用与派生 ────────────────────────────── */

/** 该段的环节链（段名与 SOP 原文一并给出；段号非法即抛错，不做静默兜底） */
export function sopChainOf(phase: GamePhase): SopSegmentChain {
  const found = SOP_SEGMENT_CHAINS.find((chain) => chain.phase === phase)
  if (found === undefined) throw new RangeError(`2.2 流程表没有这一段：${phase}`)
  return found
}

/**
 * 该段的环节链（按方过滤）
 *
 * B 段的随机事件 / 可变撤离只对轴方、特殊补员与方面军预备队只对苏方 ⇒ 传 `side` 即得该方真正要过的环。
 * 不传 `side` 则给出**双方环节的并集**（用于"这一段一共有哪些环节"这类结构性问题）。
 */
export function sopStepsOf(phase: GamePhase, side?: Side): readonly SopSegmentStep[] {
  const steps = sopChainOf(phase).steps
  if (side === undefined) return steps
  return steps.filter((step) => step.sides === undefined || step.sides.includes(side))
}

/** 按 id 取环节（查不到返回 null；id 是跨批次的稳定键，B7/B9 都用它） */
export function sopStepById(id: string): SopSegmentStep | null {
  for (const chain of SOP_SEGMENT_CHAINS) {
    const found = chain.steps.find((step) => step.id === id)
    if (found !== undefined) return found
  }
  return null
}

/**
 * 本环节链**覆盖到的全部动作族**（并集，去重、保持首次出现次序）
 *
 * 用途有两个：① 测试的不变量「并集 == `ACTIONS_BY_PHASE[phase]`」；② B7 建资格表时按环取动作全集。
 */
export function sopActionsOf(phase: GamePhase): readonly ActionKind[] {
  const seen: ActionKind[] = []
  for (const step of sopChainOf(phase).steps) {
    for (const action of step.actions) if (!seen.includes(action)) seen.push(action)
  }
  return seen
}

/**
 * 某个动作在本段**属于哪一环**（B7 的闸门表要按环判"这个动作现在能不能做"）
 *
 * 段内一个动作只可能属于一环（本表的构造保证）；查不到返回 null（例如该动作在此时机表里
 * 被 `TIMING_DEFERRED_ACTIONS` 列为"时机不由 SOP 段文字定义"）。
 */
export function sopStepForAction(phase: GamePhase, action: ActionKind): SopSegmentStep | null {
  for (const step of sopChainOf(phase).steps) {
    if (step.actions.includes(action)) return step
  }
  return null
}

/** 本模块覆盖的段数（= 2.2 流程表的段数；测试用它钉住"一段不落"） */
export const SOP_CHAIN_PHASE_COUNT = GAME_PHASES.length

/* ────────────────────────────── 各操作的**时机**（12.5b 那张表） ────────────────────────────── */

/**
 * 一个操作**发生在哪些环节**、以及**是否需要先付燃料**
 *
 * ## 为什么单列这张表（用户 2026-09-16 指出）
 *   「注意这些操作的**时机**，**并不限于某个环节**，你得理清楚各个操作在什么环节什么时机发生」——
 *   燃料（12.5）就是典型：12.5b 把七个操作的燃料要求分成两类，而它们**分散在 C/E/F/G 四个段的
 *   多个环节里**（移动与突袭在**移动环节**、轰炸在**轰炸环节**、攻击/防御/撤退/推进在**战斗环节**）。
 *   只看"燃料属 D 段补给"就会漏掉"突袭也要燃料"与"攻击不需要燃料"这两半。
 *
 * ## 两类（12.5b 原文）
 *   · **要燃料**：移动（耗 MP 即付，12.5a「即使就移动一格」）、**突袭**（「即使堆叠开始移动时
 *     已经与防御方相邻」也要付）；
 *   · **不要燃料**：攻击、防御、轰炸、撤退、战后推进。
 *   `needsFuel` 一律由 `fuel.ts#actionNeedsFuel` 给出（**唯一判据**，本表只登记"在哪一环"）。
 *
 * ## 支付时机（12.5c）
 *   「三种方法均在**消耗发生的那一刻**支付」⇒ 支付本身必须能在**任何需要燃料的环节**当场做：
 *   `payFuel` 一行的 `segments` 必须覆盖所有 `needsFuel` 操作所在环节——这一条由测试钉住
 *   （否则会出现"必须在移动环节付燃料，却只能在别的段付款"这种死结）。
 *   ★ 反过来的那一半同样成立：燃料**只**发生在这些环节 ⇒ 补给段（D）**没有**加油环节
 *   （用户 2026-09-19 口径；12.5c 把付款绑在消耗时刻，D 段不发生消耗）。
 */
export interface OperationTiming {
  /** 操作（12.5b 的七个 + 「支付燃料」本身） */
  operation: FuelRelevantAction | 'payFuel'
  label: string
  rule: string
  /** 发生在哪些环节（`SopSegmentStep.id`；**允许跨段跨环节**——这正是这张表要讲清的事） */
  segments: readonly string[]
  /** 做这件事是否**必须先付燃料**（12.5b） */
  needsFuel: boolean
  /** 时机补充说明 */
  note: string
}

/** 各操作的环节与燃料时机（12.5a / 12.5b / 12.5c；环节 id 出自本文件的链） */
export const OPERATION_TIMINGS: readonly OperationTiming[] = [
  {
    operation: 'move',
    label: '移动（消耗 MP）',
    rule: '12.5a',
    segments: ['movement.modeAndMovement', 'reaction.movement', 'exploitation.movement'],
    needsFuel: true,
    note: '轮式/履带**战斗单位**只要消耗 MP 就必须已付燃料，「即使就移动一格」；步行单位与运输点数永不需燃料',
  },
  {
    operation: 'overrun',
    label: '突袭',
    rule: '12.5b',
    // 8.0「各个移动环节」+ 7.0 首句 / 7.0b（反应阶段的突袭照常结算）⇒ 三个移动环节都在内
    segments: ['movement.modeAndMovement', 'reaction.movement', 'exploitation.movement'],
    needsFuel: true,
    note: '★ 与"已相邻"无关：堆叠开始移动时就与防御方相邻，也要先付燃料（`canOverrun` 逐单位无条件判）',
  },
  {
    operation: 'attack',
    label: '攻击（宣告与结算）',
    rule: '12.5b',
    segments: ['combat.combat', 'exploitation.combat'],
    needsFuel: false,
    note: '战斗段（与进击段的战斗环节）内宣告与结算，**不需燃料**',
  },
  {
    operation: 'defend',
    label: '防御',
    rule: '12.5b',
    segments: ['combat.combat', 'exploitation.combat'],
    needsFuel: false,
    note: '被动发生（对方在战斗环节宣告攻击时），**不需燃料**',
  },
  {
    operation: 'barrage',
    label: '轰炸',
    rule: '12.5b',
    segments: [
      /*
       * 10.0e-C/D 与 14.7d：
       *   · 四个段的**轰炸环节**各有轰炸（来源限定见 `BARRAGE_SOURCES_BY_PHASE`：C 段 air/ship、
       *     F 段 artillery only、E/G 三者皆可）；
       *   · **低空扫射**（14.7d）「是在**移动环节**而非轰炸环节中进行的一种特殊类型的轰炸」
       *     （clean txt 2690–2691、2874）⇒ C 段的**移动环节**也必须放行"宣布轰炸"这一手
       *     （炮兵在该段仍被 10.0e-D 拒：`wrongPhaseForartillery:movement`）。
       */
      'movement.barrage',
      'movement.modeAndMovement',
      'reaction.barrage',
      'combat.barrage',
      'exploitation.barrage',
    ],
    needsFuel: false,
    note: '四个段各有轰炸环节（来源限定见 `BARRAGE_SOURCES_BY_PHASE`），另 C 段**移动环节**可低空扫射（14.7d）；**不需燃料**',
  },
  {
    operation: 'retreat',
    label: '撤退（9.12）',
    rule: '12.5b',
    segments: ['combat.combat', 'exploitation.combat'],
    needsFuel: false,
    note: '9.2 九步流程内的**撤退步**（不是独立环节），**不需燃料**',
  },
  {
    operation: 'advanceAfterCombat',
    label: '战后推进（9.12g）',
    rule: '12.5b',
    segments: ['combat.combat', 'exploitation.combat'],
    needsFuel: false,
    note: '9.2 九步流程内的**推进步**，**不需燃料**',
  },
  {
    operation: 'payFuel',
    label: '支付燃料（12.5c 三种方法）',
    rule: '12.5c',
    segments: [
      // 12.5c：「均在**消耗发生的那一刻**支付」⇒ 支付只在"会用燃料的环节"发生
      'movement.modeAndMovement',
      'reaction.movement',
      'exploitation.movement',
    ],
    needsFuel: false,
    note:
      '★ 燃料**不在 D 段**（用户 2026-09-19 口径）：12.5c 把付款绑在**消耗时刻**' +
      '（「在发生燃料消耗的**任何阶段**，单位都应在燃料消耗时支付」），而补给段不发生燃料消耗 ⇒ ' +
      '付款只在 C/E/G 三段的**移动环节**当场做（12.5a/12.5f：开拔与离开入场格前须已付）。' +
      '燃料的时机由 12.5c 给出，2.2 段名未列它 ⇒ 引擎时机表把它记在 `TIMING_DEFERRED_ACTIONS`',
  },
]

/** 取某操作的时机（查不到返回 null；`payFuel` 也在这张表里） */
export function operationTimingOf(
  operation: FuelRelevantAction | 'payFuel',
): OperationTiming | null {
  return OPERATION_TIMINGS.find((item) => item.operation === operation) ?? null
}

/** 哪些环节里**必须先付燃料**才能做事（界面据此提示"这一步要先加油"） */
export function segmentsNeedingFuel(): readonly string[] {
  const needing: string[] = []
  for (const item of OPERATION_TIMINGS) {
    if (!item.needsFuel) continue
    for (const segment of item.segments) if (!needing.includes(segment)) needing.push(segment)
  }
  return needing
}

/**
 * 反向守卫用：`needsFuel` 的判据只此一处
 *
 * 本表只登记"在哪一环"，**不另写一份规则**——测试逐项断言它与 `actionNeedsFuel` 一致。
 */
export function operationNeedsFuel(operation: FuelRelevantAction): boolean {
  return actionNeedsFuel(operation)
}
