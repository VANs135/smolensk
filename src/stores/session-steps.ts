/**
 * U1-b：**会话步骤投影**（一次只暴露一个待决事项）
 *
 * 用户口径：对话框必须拆分，一个会话只办一件事，按游戏流程顺序逐件推进；
 * 完成一件才出下一件，不并列堆在一屏。先强制义务，再选做事项；同一环节内按规则先后，
 * 不按字母或字典序。
 *
 * 本模块**只做顺序与文案**：所有事实都由调用方从既有 store 投影 / 引擎状态机读来，
 * 不新增任何规则判定（`src/engine`、`src/data` 与本批无关）。
 */

import type { AirMissionStep } from '@/engine/rules/air-mission'
import type { BarrageStep } from '@/engine/rules/barrage-interaction'
import type { CombatStep } from '@/engine/rules/combat-interaction'
import type { SupplyStep } from '@/engine/rules/supply-interaction'
import { reinforcementSegmentOf } from '@/engine/rules'

import type { MapSessionKind, ExclusiveSessionSection, OpsFlowKind } from './map-view'

/** 一步待决事项 */
export interface SessionStepItem {
  /** 稳定标识（面板用 `<SessionStep :item="…">` 对齐） */
  id: string
  /** 这一步是什么（一句） */
  title: string
  /** 为什么出现（一句，不写条款号） */
  why: string
  /** 需要玩家做的唯一决定 */
  decision: string
  /** 选做事项（排在强制义务之后） */
  optional: boolean
}

/**
 * 空军任务链的事实（`air` 会话与三操作里的空军分支共用一份形状）
 *
 * 名称用"当前待办"的口径：`step` 就是引擎给的下一步，调用方不自己推。
 */
export interface AirSessionFacts {
  step: AirMissionStep | 'done'
  declared: boolean
  cargoLossPending: boolean
  /** 14.5：拦截已宣布、拦截空战还没结算 ⇒ 这一步单独成卡（不叫「防空」） */
  interceptionCombatPending?: boolean
}

/**
 * 会话事实（**只读**；全部来自既有 store 投影与引擎状态机）
 *
 * 名称用"当前待办"的口径：`step` 就是引擎给的下一步，调用方不自己推。
 */
export interface SessionStepFacts {
  kind: MapSessionKind | null
  combat: { started: boolean; step: CombatStep; attackerArDeclared: boolean } | null
  /** 未宣布时调用方传 `step: 'declare'` */
  barrage: { step: BarrageStep } | null
  /** 未宣布时调用方传 `step: 'declare'`、`declared: false`；`done` 为已收束 */
  air: AirSessionFacts | null
  /**
   * 三操作统一流程（右键炮击 / 轰炸 / 低空扫射；2026-11-10 规格）
   *
   * `step` 是流程自己的步（1 选单位 / 2 分叉 / 3 炮击受损）；
   * 空军第 2 步不另起一套步骤名，直接把任务链的当前子步带在 `air` 上
   * ⇒ 门 id 与 `AirPanel` 同源，面板不再自己判到哪一步。
   */
  ops: { kind: OpsFlowKind; step: 1 | 2 | 3; air: AirSessionFacts | null } | null
  supply: { step: SupplyStep } | null
  move: {
    fuelPending: boolean
    pickPending: boolean
    moving: boolean
    overrunZocHeld: boolean
  }
  reinforce: {
    stepId: string
    /** 本回合本方已经点过「本步完成」的窗口 id（只影响推进，不改账本） */
    acked: readonly string[]
    arrivalPending: boolean
    randomEventPending: boolean
    /** 3.6：随机事件掷出 Supply Train 且尚未落 2 SP */
    supplyTrainPending: boolean
    variableExitPending: boolean
    replTablePending: boolean
    specialReplPending: boolean
    supplyPlacePending: boolean
    /** 第二段统一手牌：还有未落位的补员点 / SP / 补给列车 */
    handPending: boolean
    /** 第二段已落位的补员枚数（>0 时手牌窗保留，供"再点收回"） */
    handPlacedCount: number
    rebuildAvailable: boolean
    frontalReservesPending: boolean
    slowMobilizationVisible: boolean
    consolidationAvailable: boolean
  } | null
  /** 突围会话是否打开 */
  breakout: boolean
  /** 突围会话里是否有"待返场"的单位要放回（与突围尝试是两件事） */
  breakoutReturnPending: boolean
  containers: boolean
  exclusive: boolean
  /**
   * 专规会话本环节可做的分节（顺序即步骤顺序）
   *
   * 用户 2026-11-09「一个框不能装多件事」：专规块按节拆成多件，一次只暴露一件。
   * 判据由 store 的 `exclusiveSectionPins` 给出，本模块只负责文案与顺序。
   */
  exclusiveSections: readonly ExclusiveSessionSection[]
  unit: boolean
}

function item(
  id: string,
  title: string,
  why: string,
  decision: string,
  optional = false,
): SessionStepItem {
  return { id, title, why, decision, optional }
}

/** 战斗：引擎步骤 → 单一事项（surprise / battleDice 为自动步） */
function combatItems(facts: NonNullable<SessionStepFacts['combat']>): SessionStepItem[] {
  if (!facts.started) {
    return [
      item(
        'combat:declare',
        '发起战斗',
        '已选好攻方与防御格，等待确认开打。',
        '开始这场战斗，或清除本次选择。',
      ),
    ]
  }
  switch (facts.step) {
    case 'composition':
      return [
        item(
          'combat:declare',
          '发起战斗',
          '已选好攻方与防御格，等待确认开打。',
          '开始这场战斗，或清除本次选择。',
        ),
      ]
    case 'combatSupply':
      return [
        item(
          'combat:supply',
          '战斗补给',
          '双方要用战斗补给换出这一仗的火力。',
          '给出攻守两方的补给与参战名单，然后确认补给。',
        ),
      ]
    case 'declareAr':
      return facts.attackerArDeclared
        ? [
            item(
              'combat:ar:defender',
              '守方宣布行动值',
              '攻方已宣布行动值，现在轮到守方。',
              '从守方参战单位中指定担任行动值的那一枚。',
            ),
          ]
        : [
            item(
              'combat:ar:attacker',
              '攻方宣布行动值',
              '开打前双方要各指定一个单位代表本方的行动值。',
              '从攻方参战单位中指定担任行动值的那一枚。',
            ),
          ]
    case 'declareTerrain':
      return [
        item(
          'combat:terrain',
          '宣布地形',
          '地形决定战斗表的横行与攻防比。',
          '确认每个攻击堆叠与守方所用的地形。',
        ),
      ]
    /*
     * 9.8 / 9.9 是**自动步**：奇袭、横移、战斗骰与查表在「确认地形」的同一拍内连跑
     * （`autoResolveCombatToOutcome`），玩家没有任何待决动作 ⇒ **不占屏**。
     * 这里显式返回空，宿主模式下这两步不渲染任何一节。
     */
    case 'surprise':
    case 'battleDice':
      return []
    case 'losses':
      return [
        item(
          'combat:losses',
          '强制军力损失',
          '战斗表要求当前一方先承受军力损失。',
          '确认这一方的损失由哪些单位、各受几点。',
        ),
      ]
    case 'options':
      return [
        item(
          'combat:options',
          '结算选项',
          '战斗表的选项点数要换成撤退格数或军力损失。',
          '把这几个选项点数分配完并提交。',
        ),
      ]
    case 'retreat':
      return [
        item(
          'combat:retreat',
          '撤退落点',
          '选项里有撤退格数，撤走的单位需要落到具体格。',
          '给每一枚要撤的单位选定落点。',
        ),
      ]
    case 'advance':
      return [
        item(
          'combat:advance',
          '战后推进',
          '防御格已空，攻方可以进入（突袭则必须进入）。',
          '确认哪些单位推进并收束本场战斗。',
        ),
      ]
    default:
      return []
  }
}

/** 轰炸：未宣布 → 宣布；之后按引擎步骤 */
function barrageItems(facts: NonNullable<SessionStepFacts['barrage']>): SessionStepItem[] {
  switch (facts.step) {
    case 'declare':
      return [
        item(
          'barrage:declare',
          '宣布轰炸',
          '已选好参炸单位，等待宣布目标与轰炸值。',
          '确认类别、整体目标与参炸单位后宣布。',
        ),
      ]
    case 'supply':
      return [
        item(
          'barrage:supply',
          '轰炸补给',
          '火炮轰炸要先按初始列付补给。',
          '选定付款来源并确认补给。',
        ),
      ]
    case 'shifts':
      return [
        item(
          'barrage:shifts',
          '列横移',
          '目标格的情况会让轰炸列左右移动。',
          '确认目标格地形带来的横移。',
        ),
      ]
    case 'dice':
      return [item('barrage:dice', '掷骰', '列位已定，等待掷骰出结果。', '掷骰。')]
    case 'outcome':
      return [
        item(
          'barrage:outcome',
          '结果确认',
          '骰子已出，目标方要落实结果。',
          '确认损失/命中如何落到目标单位上。',
        ),
      ]
    default:
      return []
  }
}

/** 空军任务：货物损失优先，然后按引擎步骤 */
function airItems(facts: NonNullable<SessionStepFacts['air']>): SessionStepItem[] {
  const items: SessionStepItem[] = []
  if (facts.cargoLossPending) {
    items.push(
      item(
        'air:cargoLoss',
        '货物损失',
        '防空的容量变化导致机上货物装不下了。',
        '选出要摧毁的货物直到不超过现容量。',
      ),
    )
  }
  if (!facts.declared) {
    items.push(
      item(
        'air:declare',
        '选飞机发起任务',
        '任务类型与任务格已定，等待挑选参战机。',
        '点选参战机，然后发起任务。',
      ),
    )
    return items
  }
  switch (facts.step) {
    case 'declare':
      items.push(
        item(
          'air:declare',
          '选飞机发起任务',
          '任务类型与任务格已定，等待挑选参战机。',
          '点选参战机，然后发起任务。',
        ),
      )
      break
    /*
     * `air:move` 是死项：任务机在 B 步没有玩家决定，自动连跑会直接进 C 步
     * （用户 2026-11-13：删掉这一步，不再占窗）。
     */
    case 'move':
      break
    case 'airCombat':
      items.push(
        item(
          'air:airCombat',
          '空战',
          '任务格内双方都有激活飞机。',
          '指定迎战的那一架（不指定则由系统取最高）。',
        ),
      )
      break
    case 'interception':
      items.push(
        item('air:interception', '拦截', '对方在航路上有可拦截的战斗机。', '决定是否宣布拦截。'),
      )
      break
    case 'flak':
      /*
       * 用户 2026-11-13：防空已自动结算 ⇒ 正常路径不停在防空。
       *   只有两种"停住"要占窗：① 拦截已宣布、拦截空战待结算（14.5，标题「拦截空战」）；
       *   ② 防空被拒（面板里给错误与取消出口）。
       */
      items.push(
        facts.interceptionCombatPending === true
          ? item(
              'air:interceptionCombat',
              '拦截空战',
              '拦截方已宣布拦截，拦截机与迎战机还没结算。',
              '结算这次拦截空战。',
            )
          : item('air:flak', '防空', '防空结算被拒，需要处置。', '按提示处置或取消本次任务。'),
      )
      break
    case 'resolveMission':
      items.push(item('air:resolve', '结算任务', '飞机已抵达任务格。', '确认任务本身的结果。'))
      break
    case 'returnToBase':
      items.push(item('air:return', '返航', '任务已结算，飞机要回基地。', '确认返航落位。'))
      break
    case 'done':
      break
    default:
      break
  }
  return items
}

/**
 * 三操作统一流程：一步一件事
 *
 * 前两步由流程自己定（选单位 / 炮击付补给）；空军第 2 步交给任务链的 `airItems`，
 * 门 id 与 `AirPanel` 完全相同 —— 面板只按门渲染，不再自己判 `flow.step`。
 */
function opsItems(facts: NonNullable<SessionStepFacts['ops']>): SessionStepItem[] {
  if (facts.kind === 'barrage') {
    if (facts.step === 1) {
      return [
        item(
          'ops:barrage:units',
          '选参炸炮兵',
          '目标格已定，等待挑选这一炮的参炸单位。',
          '只从射程覆盖该格的炮兵里选，然后确认单位。',
        ),
      ]
    }
    if (facts.step === 2) {
      return [
        item(
          'ops:barrage:supply',
          '支付炮击补给',
          '宣布后要按初始列付补给（10.1b）。',
          '在地图上点一座高亮的补给站完成支付。',
        ),
      ]
    }
    return [
      item(
        'ops:barrage:loss',
        '目标方受损',
        '轰炸结果要求目标方先落实军力损失。',
        '在目标格内给受损单位各记一点，然后确认受损。',
      ),
    ]
  }
  /*
   * 用户 2026-11-13：「选机」并入面板 1 ⇒ 空军不再有独立的「选参战机」步，
   *   从右键定好类型与目标格起，第 1 张卡就是 `air:declare`（选飞机 + 发起）。
   */
  return facts.air === null ? [] : airItems(facts.air)
}

function supplyItems(facts: NonNullable<SessionStepFacts['supply']>): SessionStepItem[] {
  switch (facts.step) {
    case 'assess':
      return [
        item(
          'supply:assess',
          '判定补给状态',
          '这枚单位要先确认此刻是否在补给范围内。',
          '确认判定结论并继续。',
        ),
      ]
    case 'selectSource':
      return [
        item(
          'supply:selectSource',
          '选择补给来源',
          '判定为可受补给，需要指定从哪一处取用。',
          '从候选来源中选定一处。',
        ),
      ]
    case 'pickup':
      return [
        item(
          'supply:pickup',
          '取用补给',
          '来源已选定，等待确定用途与数量。',
          '确认用途与应付数量后提交。',
        ),
      ]
    case 'resolveOos':
      return [
        item(
          'supply:resolveOos',
          '断补处置',
          '这枚单位拿不到追溯补给。',
          '选择吃图上补给或接受断补标记。',
        ),
      ]
    default:
      return []
  }
}

function moveItems(facts: SessionStepFacts['move']): SessionStepItem[] {
  const items: SessionStepItem[] = []
  /*
   * ★ 用户 2026-11-10：加油不是"移动的一步"，而是右键菜单里的一项。
   *   付款已移出移动准备窗（`FuelPanel` 承载）⇒ 这里不再生成 `move:fuel` 步。
   */
  if (facts.pickPending) {
    items.push(
      item('move:pick', '开拔', '已选好要一起移动的单位。', '确认参移名单、模式与燃料后开始移动。'),
    )
  }
  if (facts.overrunZocHeld) {
    items.push(
      item(
        'move:continue',
        '突袭后的处置',
        '突袭强行进入敌方控制区后，该格单位不得离开。',
        '再突袭一个相邻敌方格，或就地停止。',
      ),
    )
  } else if (facts.moving) {
    items.push(
      item('move:continue', '继续移动', '单位已在移动中。', '继续走下一步，或结束这次移动。'),
    )
  }
  return items
}

/**
 * 增援事项 → 所属 SOP 子环节（唯一归属表）
 *
 * 用户 2026-11-11（批三「增援段专审」）：B 段在 `sop-segments` 里已切成多个环节，
 * 一个环节的窗里**不能出现别的环节的待办**。修前这里只按"谁还没办"排全局顺序，
 * 于是在到达环节也会冒出重建/整编窗（典型：把"能获得什么"和"能修什么"混在一屏）。
 *
 * 环节次序本身仍由 `sop-segments` 的 B 段给出；本表只回答"这一件事归哪一环"。
 */
const REINFORCE_STEP_OF: Readonly<Record<string, string>> = {
  // 1.6b 可变增援：掷表是自动步，玩家只负责把到货的 Pax/Eq 与 SP **落位**
  'reinforce:replTable': 'reinforcement.replRoll',
  'reinforce:supplyTable': 'reinforcement.replRoll',
  // 13.6 / 1.6a 到达落位；2.4 慢动员在收到锁定师之后当场解锁
  'reinforce:arrival': 'reinforcement.arrival',
  'reinforce:slow': 'reinforcement.arrival',
  // 轴方专规
  'reinforce:randomEvent': 'reinforcement.randomEvent',
  'reinforce:supplyTrain': 'reinforcement.supplyTrain',
  'reinforce:variableExit': 'reinforcement.variableExit',
  // 13.5a / 13.9 重建与整编（第三段只保留「结束本段」；重建/整编改走盘面右键）
  'reinforce:endRebuild': 'reinforcement.rebuild',
  // 专规 1.6c / 2.3c
  'reinforce:specialRepl': 'reinforcement.specialRepl',
  'reinforce:frontalReserves': 'reinforcement.frontalReserves',
  // v7.1 第二段：批量手牌与"结束本段"都属于宿主环
  'reinforce:hand': 'reinforcement.replRoll',
  'reinforce:endRoll': 'reinforcement.replRoll',
}

/**
 * 第二段段内次序（v7.1 §3，按原文先后）
 *
 * 只影响**显示顺序**，不改归属；未列出的条目排在列出的之后（保持 push 原序）。
 * 1.6c 最前（条件必现且决定后续可重建对象），随后 3.6 随机事件/补给列车、3.3c 撤离，
 * 再到 1.6b 两张表，2.3c 方面军预备队，最后统一手牌与结束本段。
 */
const REINFORCE_ROLL_ORDER: readonly string[] = [
  'reinforce:specialRepl',
  'reinforce:randomEvent',
  'reinforce:supplyTrain',
  'reinforce:variableExit',
  'reinforce:replTable',
  'reinforce:supplyTable',
  'reinforce:frontalReserves',
  'reinforce:hand',
  'reinforce:endRoll',
]

function reinforceItems(facts: NonNullable<SessionStepFacts['reinforce']>): SessionStepItem[] {
  const acked = new Set(facts.acked)
  const items: SessionStepItem[] = []
  const push = (id: string, title: string, why: string, decision: string): void => {
    const owner = REINFORCE_STEP_OF[id]
    if (owner === undefined) return
    /*
     * v7.1 第二段（用户 Q2）：B 段叠加「段」分组后，段内各环节不再各占流程条一环，
     * 而是挂到**宿主环**（到达 / 掷骰与统一放置 / 重建）下按 §3 次序逐张出现。
     * 归属表仍记"这件事原文属于哪一节"，这里只比宿主，不改 7/5 节链。
     */
    const host = reinforcementSegmentOf(owner)?.host ?? owner
    if (host !== facts.stepId) return
    items.push(item(id, title, why, decision))
  }

  // 3.6：轴方 19 Jul–15 Aug 的随机事件（原文未定段内位置，建议开场）
  if (facts.randomEventPending && !acked.has('reinforce:randomEvent')) {
    push(
      'reinforce:randomEvent',
      '随机事件（3.6）',
      '19 Jul–15 Aug 的轴方增援阶段要掷一次随机事件。',
      '看本回合事件结果；若为补给列车，下一窗点地图高亮铁路格放置 2 SP。',
    )
  }
  // 3.6：补给列车落点（只对轴方；未掷出则本窗空过）
  if (facts.supplyTrainPending && !acked.has('reinforce:supplyTrain')) {
    push(
      'reinforce:supplyTrain',
      '补给列车落点（3.6）',
      '随机事件掷出 Supply Train：地图高亮全部可卸货铁路格，点一格即落 2 SP（不用 Rail Cap）。',
      '在窗口确认 3.4b 归属后，点地图任意高亮铁路格。',
    )
  }
  // 13.6 / 1.6a：当日到达落位与强制移除
  if (facts.arrivalPending) {
    push(
      'reinforce:arrival',
      '当日到达落位（13.6 / 1.6a）',
      '当回合有单位到场，还没有全部放到地图上。',
      '为每一条到达条目选定落点并投放；Remove 条目立即执行。',
    )
  }
  // 2.4：苏方慢动员解锁（到达确认放完后、第二段之前；原文只给日期，不设硬闸）
  if (facts.slowMobilizationVisible && !acked.has('reinforce:slow')) {
    push(
      'reinforce:slow',
      '慢动员解锁（2.4）',
      '本回合有仍被锁定的师可以解锁。',
      '勾选当日应解锁的师并提交解锁；配额大于剩余时剩余全部解锁。',
    )
  }
  // 3.3c：轴方 19 Aug 起的可变撤离（到达之后，14 Mtr 才在场）
  if (facts.variableExitPending && !acked.has('reinforce:variableExit')) {
    push(
      'reinforce:variableExit',
      '可变撤离（3.3c）',
      '19 Aug 起每个轴方增援阶段掷一次，直到 SS Reich 或 14 Mtr 被撤走。',
      '掷骰并按 1.6a 移除；2–5 则本回合不撤，下一回合再掷。',
    )
  }
  // 2.3c：苏方三批方面军预备队，必须当即领取
  if (facts.frontalReservesPending) {
    push(
      'reinforce:frontalReserves',
      '方面军预备队（2.3c）',
      '今天有一批方面军预备队到场，必须当即领取。',
      '落 2 SP、完成换装，并选两次免费重建的对象。',
    )
  }
  // 13.5 / 1.6b：可变增援的补员表
  if (facts.replTablePending && !acked.has('reinforce:replTable')) {
    push(
      'reinforce:replTable',
      '可变增援·补员表（13.5 / 1.6b）',
      '本方的增援阶段要掷一次补员表，并把 Pax/Eq 放成算子。',
      '掷表、放置 Pax/Eq；Ftr/Tac 立即用掉，Pax/Eq 可留存。',
    )
  }
  // 1.6c / 1.6b：判定全部并入 `reinforce:replTable` 的「掷骰检定」一处，不再单列两张卡
  /*
   * 第三段（重建 · 合并 · 整编）：**只问「是否结束本段」**（v7.1 §4.3 / §4.6）。
   *
   * 重建与整编都已改成**盘面入口**（死亡堆右键 / 盘面多选右键），不再开大窗；
   * 本段没有"待放项"，所以唯一事项就是结束本段（补员点留在盘面，不清空、不作废）。
   */
  if (facts.stepId === 'reinforcement.rebuild' && !acked.has('reinforce:endRebuild')) {
    push(
      'reinforce:endRebuild',
      '结束本段（第三段）',
      '重建与整编都在盘面右键办理；补员点数用不完留在图上，跨段跨回合继续可用。',
      '结束本段，进入后续环节。',
    )
  }
  // ── 第二段收尾：批量手牌 + 结束本段（唯一出口） ──
  if ((facts.handPending || facts.handPlacedCount > 0) && !acked.has('reinforce:hand')) {
    push(
      'reinforce:hand',
      '待放上手牌（13.5a / 1.6b）',
      '骰子已判完，落位统一在这里办：点一条 → 点高亮格 → 落下；再点已落下的算子可收回。',
      '把 Pax / Eq / SP 逐枚放到合法格；点完即生效，不弹二次确认。',
    )
  }
  if (facts.stepId === 'reinforcement.replRoll' && !acked.has('reinforce:endRoll')) {
    push(
      'reinforce:endRoll',
      '结束本段（第二段）',
      '本段的掷骰与落位都办完了。',
      '结束本段并进入重建；若手牌非空会先问一次是否放弃上场。',
    )
  }
  // 段内显示次序按 §3；未列出的条目保持 push 原序排在后面
  const rank = (id: string): number => {
    const index = REINFORCE_ROLL_ORDER.indexOf(id)
    return index < 0 ? REINFORCE_ROLL_ORDER.length : index
  }
  return items
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry.id) - rank(b.entry.id) || a.index - b.index)
    .map(({ entry }) => entry)
}

/** 专规各节的会话文案（一节一件事；不写条款号，条款留在面板里） */
const EXCLUSIVE_SECTION_TEXT: Readonly<
  Record<ExclusiveSessionSection, { title: string; why: string; decision: string }>
> = {
  panzer: {
    title: '装甲集群',
    why: '本环节可结算分界线义务，或有新到的补给点要归属。',
    decision: '选定要结算的编队（或补给点的归属），然后执行。',
  },
  security: {
    title: '治安检查',
    why: '轴控城市有未驻防/未盖 ZOC 的，或有标记到了该移除的时点。',
    decision: '逐城放标记，或在清理段移除已满足条件的标记。',
  },
  hedgehog: {
    title: '环形工事',
    why: '本环节该格允许修建或缩减环形工事。',
    decision: '选定施工格与施工单位，然后执行。',
  },
  marker: {
    title: '建造标记',
    why: '本环节有建造标记可用。',
    decision: '选定用途与目标格，然后放下标记。',
  },
}

/** 专规会话标题里用的单节名（一次只出一个） */
export function exclusiveSectionTitle(section: ExclusiveSessionSection): string {
  return EXCLUSIVE_SECTION_TEXT[section].title
}

/**
 * 按规则顺序给出现有会话的全部待决事项（增援段按规则顺序，一次只暴露第一件）
 *
 * 顺序写死在这里（与引擎状态机的推进顺序一致），不排序、不按字母序。
 */
export function planSessionSteps(facts: SessionStepFacts): SessionStepItem[] {
  if (facts.kind === null) return []
  const breakoutReturnItem = item(
    'breakout:return',
    '突围返场',
    '上一回合突围离图的单位到了返场回合。',
    '选定入场格，把这些单位放回地图。',
  )
  const breakoutItem = item(
    'breakout:act',
    '突围',
    '有断补单位可以在本环节尝试突围。',
    '点一枚单位宣布突围（或留在地图上不突围）。',
    true,
  )
  const containersItem = item(
    'containers:actions',
    '盒内动作',
    '已展开一张盒卡，等待对该盒执行一项动作。',
    '从该盒允许的动作中选一项执行。',
  )
  const exclusiveItem = item(
    'exclusive:actions',
    '专规动作',
    '本环节有可执行的专规动作。',
    '选择其中一项专规动作执行。',
  )
  const unitItem = item(
    'unit:actions',
    '单位动作',
    '已点选一枚非战斗单位，等待对它执行一项动作。',
    '从该单位允许的动作中选一项执行。',
  )
  switch (facts.kind) {
    case 'combat':
      return facts.combat === null ? [] : combatItems(facts.combat)
    case 'barrage':
      return facts.barrage === null ? [] : barrageItems(facts.barrage)
    case 'air':
      return facts.air === null ? [] : airItems(facts.air)
    case 'ops':
      return facts.ops === null ? [] : opsItems(facts.ops)
    case 'supply':
      return facts.supply === null ? [] : supplyItems(facts.supply)
    case 'move':
      return moveItems(facts.move)
    case 'reinforce':
      return facts.reinforce === null ? [] : reinforceItems(facts.reinforce)
    case 'breakout': {
      // 返场是已发生突围的收尾（强制义务），突围尝试是可选动作 ⇒ 先返场、后突围
      const items: SessionStepItem[] = []
      if (facts.breakoutReturnPending) items.push(breakoutReturnItem)
      if (facts.breakout) items.push(breakoutItem)
      return items
    }
    case 'containers':
      return facts.containers ? [containersItem] : []
    case 'exclusive': {
      if (facts.exclusiveSections.length > 0) {
        return facts.exclusiveSections.map((section) => {
          const text = EXCLUSIVE_SECTION_TEXT[section]
          return item(`exclusive:${section}`, text.title, text.why, text.decision)
        })
      }
      return facts.exclusive ? [exclusiveItem] : []
    }
    case 'unit':
      return facts.unit ? [unitItem] : []
    default:
      return []
  }
}

/**
 * 当前**暴露**的那一个事项（恰好 0 或 1）
 *
 * 强制义务优先；没有强制时给第一个选做事项。
 */
export function exposedSessionStep(items: readonly SessionStepItem[]): SessionStepItem | null {
  return items.find((entry) => !entry.optional) ?? items[0] ?? null
}

/**
 * 某一节是否渲染
 *
 * - 无宿主（验证页 / 右栏）：全量渲染，照旧；
 * - 有宿主且无待决：**一节都不渲染**（批二：无待决 ≠ 全量渲染）；
 * - 有宿主：只认当前暴露的那一项。
 */
export function sessionStepVisible(
  hosted: boolean,
  exposedId: string | null,
  itemId: string,
): boolean {
  return !hosted || exposedId === itemId
}
