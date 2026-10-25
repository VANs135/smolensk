import { describe, expect, it } from 'vitest'

import { GAME_PHASES } from '@/engine/state-types'
import {
  ACTIONS_BY_PHASE,
  AIR_MISSION_SEGMENT,
  BARRAGE_SOURCES_BY_PHASE,
  SOP_CHAIN_PHASE_COUNT,
  SOP_SEGMENT_CHAINS,
  sopActionsOf,
  sopChainOf,
  sopStepById,
  OPERATION_TIMINGS,
  operationNeedsFuel,
  operationTimingOf,
  segmentsNeedingFuel,
  sopStepForAction,
  sopStepsOf,
  type ActionKind,
} from '@/engine/rules'

/**
 * B6：SOP **环节链**（2.2 段名原文里的子步）
 *
 * 这个模块的价值全在「**与既有两张表不可能各走各的**」——故本文件的重点是**不变量**，
 * 而不是逐条抄一遍数据：
 *   ① 一段不落、一段不重；
 *   ② 每段「各环节动作的并集」**恰好等于** `ACTIONS_BY_PHASE[该段]`（少一个＝动作无家可归，多一个＝凭空发明）；
 *   ③ 段内每个动作都能找到**唯一**所属环节（B7 的闸门表按环判许可，靠的就是这条）。
 *   ④ **三级一致性**（用户 2026-09-16 复核要求：「环节是按流程表里来的，回合、阶段、环节，三个层级」）
 *      ——见文件末尾的 `三级一致性（对齐流程表原文）`。
 *
 * 另钉住**两条原文次序**（用户原话的例子）与**两处纠正**（15.4 缩减归 C、事件/撤离归 B），
 * 免得日后有人凭印象把环节搬回错段。
 */

const sorted = (values: readonly string[]): string[] => [...values].sort()

describe('B6：环节链的结构不变量', () => {
  it('2.2 的每一段恰好一条环节链（不重不漏）', () => {
    expect(SOP_SEGMENT_CHAINS.length).toBe(SOP_CHAIN_PHASE_COUNT)
    const phases = SOP_SEGMENT_CHAINS.map((chain) => chain.phase)
    expect(sorted(phases)).toEqual(sorted([...GAME_PHASES]))
    // 每段至少一环（没有空链）
    for (const chain of SOP_SEGMENT_CHAINS) expect(chain.steps.length).toBeGreaterThan(0)
  })

  it('★核心不变量：每段环节覆盖的动作族**恰好等于** ACTIONS_BY_PHASE（双向）', () => {
    const problems: string[] = []
    for (const phase of GAME_PHASES) {
      const expected = [...ACTIONS_BY_PHASE[phase]]
      const covered = [...sopActionsOf(phase)]
      for (const action of expected) {
        if (!covered.includes(action)) problems.push(`${phase}：动作 ${action} 没有任何环节收留`)
      }
      for (const action of covered) {
        if (!expected.includes(action)) {
          problems.push(`${phase}：环节覆盖了动作 ${action}，但 ACTIONS_BY_PHASE 里没有`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('★段内每个动作都能找到**唯一**所属环节（B7 按环判许可的基石）', () => {
    for (const phase of GAME_PHASES) {
      for (const action of ACTIONS_BY_PHASE[phase]) {
        const step = sopStepForAction(phase, action)
        expect(step, `${phase} 的动作 ${action} 找不到所属环节`).not.toBeNull()
        // 唯一性：本表里不会有两环同时收同一个动作（否则"现在能不能做"会有两个答案）
        const owners = sopChainOf(phase).steps.filter((item) => item.actions.includes(action))
        expect(owners).toHaveLength(1)
      }
    }
  })

  it('环节 id 形如 `<段>.<环节>` 且全局唯一', () => {
    const ids: string[] = []
    for (const chain of SOP_SEGMENT_CHAINS) {
      for (const step of chain.steps) {
        expect(step.id.startsWith(`${chain.phase}.`), `${step.id} 的前缀与所属段不符`).toBe(true)
        expect(ids, `${step.id} 重复`).not.toContain(step.id)
        ids.push(step.id)
      }
    }
    // 反空转：确实收集到了一批 id（不是空数组让上面循环空转）
    expect(ids.length).toBeGreaterThanOrEqual(GAME_PHASES.length)
  })

  it('驱动方式只用三种词，且自动/玩家的归类与 2.2 核对结果一致', () => {
    const allowed = ['automatic', 'player', 'question']
    for (const chain of SOP_SEGMENT_CHAINS) {
      for (const step of chain.steps) expect(allowed).toContain(step.driver)
    }
    // 全自动的段：H 清理、Turn End、天气判定（turn-driver 的【全自动】清单）
    expect(sopStepById('cleanUp.auto')!.driver).toBe('automatic')
    expect(sopStepById('turnEnd.advance')!.driver).toBe('automatic')
    expect(sopStepById('preTurn.weatherDetermination')!.driver).toBe('automatic')
    // 先手判定必须由胜者输入 ⇒ 待答
    expect(sopStepById('preTurn.firstPlayerDetermination')!.driver).toBe('question')
  })
})

describe('B6：两处原文次序（用户原话的例子）', () => {
  it('F 战斗：炮击环节 → 战斗环节（用户原话）', () => {
    const ids = sopStepsOf('combat').map((step) => step.id)
    expect(ids).toEqual(['combat.barrage', 'combat.combat'])
    expect(sopStepById('combat.barrage')!.label).toContain('炮击')
    expect(sopStepById('combat.combat')!.label).toContain('战斗')
  })

  it('C 移动：突围 → 模式与移动 → 轰炸（仅空中与舰炮），突围在最前', () => {
    const ids = sopStepsOf('movement').map((step) => step.id)
    expect(ids).toEqual(['movement.breakout', 'movement.modeAndMovement', 'movement.barrage'])
    // 12.8e 的「before any other movement」⇒ 突围必须是第一环
    expect(ids[0]).toBe('movement.breakout')
  })

  it('轰炸来源的段限定与既有 BARRAGE_SOURCES_BY_PHASE 一致（C 段不准炮兵、F 段只准炮兵）', () => {
    // C 段：原文「Barrage (air & ship only)」⇒ 炮兵轰炸不在本段
    expect(BARRAGE_SOURCES_BY_PHASE.movement).toEqual(['air', 'ship'])
    expect(BARRAGE_SOURCES_BY_PHASE.movement).not.toContain('artillery')
    // F 段：原文「Barrage (artillery only)」
    expect(BARRAGE_SOURCES_BY_PHASE.combat).toEqual(['artillery'])
    // 凡是许可轰炸的段，都要有一个环节收它（B7 据此判"本环节能不能炸"）
    for (const phase of ['movement', 'reaction', 'combat', 'exploitation'] as const) {
      expect(sopStepForAction(phase, 'barrage'), `${phase} 缺轰炸环节`).not.toBeNull()
    }
  })

  it('G 进击：移动 → 轰炸 → 战斗（原文次序）', () => {
    expect(sopStepsOf('exploitation').map((step) => step.id)).toEqual([
      'exploitation.movement',
      'exploitation.barrage',
      'exploitation.combat',
    ])
  })

  it('E 反应：移动 → 轰炸；且反应移动只许"已释放预备"（7.0a；突袭照常 7.0 首句 / 7.0b）', () => {
    expect(sopStepsOf('reaction').map((step) => step.id)).toEqual([
      'reaction.movement',
      'reaction.barrage',
    ])
    /*
     * 7.0 首句：「反应阶段是非阶段玩家可利用**移动、突袭和轰炸**打乱敌方计划的机会」；
     * 7.0b：「反应阶段中，轰炸和**突袭**的结算照常」。
     * ⇒ 本环含 `overrun`（8.0 亦云突袭「发生在各个移动环节」）。
     *   修前本环只给了 `move` ⇒ 反应阶段按 4.5a-A 停车的轮式单位**无处突袭**（第六批 BUG ①）。
     */
    expect(sopStepById('reaction.movement')!.actions).toEqual(['reserveRelease', 'move', 'overrun'])
    expect(sopStepById('reaction.movement')!.rule).toContain('7.0a')
  })
})

describe('B6：两处纠正（原 UI 方案的表写错了，以条文与既有实现为准）', () => {
  it('15.4 基地缩减**不在 A 段**（air-mission 的判据是 movement-only）⇒ 由 C 段的"模式与移动"收留', () => {
    const refit = sopStepById('aircraftRefit.refit')!
    expect(refit.note ?? '').toContain('15.4')
    // A 段只有整备一环，且不含"缩减"的字样
    expect(sopStepsOf('aircraftRefit').map((step) => step.id)).toEqual(['aircraftRefit.refit'])
    expect(refit.label).not.toContain('缩减')
    // C 段的模式与移动环里点名了 15.4（它在那里发生）
    expect(sopStepById('movement.modeAndMovement')!.note ?? '').toContain('15.4')
  })

  it('随机事件（专规 3.6）与可变撤离（专规 3.3c）**不在 Pre-Turn**，归轴方 B 段', () => {
    expect(sopStepsOf('preTurn').map((step) => step.id)).toEqual([
      'preTurn.weatherDetermination',
      'preTurn.firstPlayerDetermination',
    ])
    expect(sopStepById('reinforcement.randomEvent')!.sides).toEqual(['axis'])
    expect(sopStepById('reinforcement.variableExit')!.sides).toEqual(['axis'])
    expect(sopStepById('reinforcement.randomEvent')!.rule).toContain('3.6')
    expect(sopStepById('reinforcement.variableExit')!.rule).toContain('3.3c')
  })
})

describe('B6：按方过滤与已知缺口登记', () => {
  it('B 段的轴方链不含苏方专有环；苏方链不含轴方专有环', () => {
    const axis = sopStepsOf('reinforcement', 'axis').map((step) => step.id)
    const soviet = sopStepsOf('reinforcement', 'soviet').map((step) => step.id)

    expect(axis).toContain('reinforcement.randomEvent')
    expect(axis).toContain('reinforcement.variableExit')
    expect(axis).toContain('reinforcement.formationDraw')
    /*
     * ★ 2026-10-25（专规 1.6c 原文）：「Each turn before 19 August, **the players** also get to roll
     *   a die on their **Special Repl Table**… **The Soviets always get two and the Axis one**」
     *   ＋ 表里的 `Soviet Table` / `Axis Table` ⇒ 这一环**双方都有**（各自的表）。
     *   修前只给苏方（`sides: ['soviet']`），轴方那一掷无处安放。
     */
    expect(axis).toContain('reinforcement.specialRepl')
    expect(axis).not.toContain('reinforcement.frontalReserves')

    expect(soviet).toContain('reinforcement.specialRepl')
    expect(soviet).toContain('reinforcement.frontalReserves')
    expect(soviet).not.toContain('reinforcement.randomEvent')
    expect(soviet).not.toContain('reinforcement.formationDraw')

    // 双方共有的环两边都在
    expect(axis).toContain('reinforcement.arrival')
    expect(soviet).toContain('reinforcement.arrival')
    // 不传 side ⇒ 并集（比任一方都全）
    expect(sopStepsOf('reinforcement').length).toBeGreaterThan(axis.length)
  })

  it('动作词表未覆盖的玩家环节被**显式登记**（不静默漏掉）', () => {
    /*
     * 判据（批 E 切片 2 收紧为**双向**；`implemented` 的缺省是 `true`，只有 `false` 才表示"没入口"）：
     *   ① `implemented === false` 的环节 ⇒ `note` 必须写明"实现缺口"（不静默漏掉）；
     *   ② 反过来，`note` 里挂着"实现缺口"的环节 ⇒ 必须真的 `implemented === false`
     *      （防"已接线却留着陈旧登记"——13.7 编队抽取本轮接线，正是被这一条逼着清掉了缺口字样）。
     */
    const draw = sopStepById('reinforcement.formationDraw')!
    expect(draw.implemented).toBe(true)
    expect(draw.note ?? '').not.toContain('实现缺口')
    /*
     * ★ 2026-10-25：专规 1.6c 的**入口已接线**（`containers.drawSpecialRepl`，且过
     *   `ACTION_GATES['rein.specialRepl']` 的环节闸）⇒ `implemented` 不再是 false，
     *   note 里也不再有"实现缺口"——本条守卫正是逼着清掉陈旧登记的那只手。
     */
    const repl = sopStepById('reinforcement.specialRepl')!
    // `implemented` 缺省即 true ⇒ 这里断言"不是 false"（显式写 true 也行）
    expect(repl.implemented).not.toBe(false)
    expect(repl.note ?? '').not.toContain('实现缺口')

    const allSteps = SOP_SEGMENT_CHAINS.flatMap((chain) => chain.steps)
    // ① 未实现 ⇒ 必须登记
    expect(
      allSteps
        .filter((step) => step.implemented === false && !(step.note ?? '').includes('实现缺口'))
        .map((step) => step.id),
    ).toEqual([])
    // ② 登记了缺口 ⇒ 必须真的未实现（否则登记陈旧）
    expect(
      allSteps
        .filter((step) => (step.note ?? '').includes('实现缺口') && step.implemented !== false)
        .map((step) => step.id),
    ).toEqual([])
    // 12.8 损耗：掷骰自动，但"谁承受"要玩家决定 ⇒ 与 12.6 同属 D 段**第二环**（补给检定），
    // 动作词表里没有对应项（该动作族的 store 键 `supply.attrition` 登记在 ACTION_KEYS_WITHOUT_KIND）
    const check = sopStepById('supply.check')!
    expect(check.rule).toContain('12.8')
    expect(check.actions).toEqual(['supplyTrace', 'hqThrow'])
  })

  it('H④（用户 2026-09-19 口径）：D 段**恰好两环** —— 恢复部队储备 → 补给检定；且**没有加油环节**', () => {
    /*
     * 用户原话：「规则里补给阶段没有具体环节，但应该是这样两步：1. 恢复部队储备：要为有 low/exhausted
     *   标志的单位恢复部队储备（12.10e） 2. 补给检定：确定哪些单位无法追溯补给线（12.6）。它们可以
     *   选择吃地图上的 SP 补给（12.6c）或者被放置断补标志。之后，检定所有断补单位堆叠的损耗（12.8）。」
     * 以及：「里面在补给阶段有燃料环节，但是燃料环节不应该存在，未加油单位是在移动前加油」。
     *
     * 12.5c 原文把付款绑在**消耗时刻**（「在发生燃料消耗的任何阶段，单位都应在燃料消耗时支付」）——
     * 补给段没有燃料消耗，故燃料不属本段；其时机由 12.5c 给出（见 `TIMING_DEFERRED_ACTIONS`），
     * 落在 C/E/G 三段的**移动环节**（开拔前当场付，`payFuel` 的闸门）。
     */
    const chain = sopChainOf('supply')
    expect(chain.steps.map((step) => step.id)).toEqual(['supply.recovery', 'supply.check'])

    const [recovery, check] = chain.steps
    // ① 恢复部队储备（12.10e；用户口径的第一条）
    expect(recovery!.label).toContain('恢复部队储备')
    expect(recovery!.rule).toContain('12.10e')
    expect(recovery!.driver).toBe('player')
    // ② 补给检定（12.6 判定 → 12.6c/12.6d 处置 → 12.8 损耗；用户口径的第二条）
    expect(check!.label).toContain('补给检定')
    for (const rule of ['12.6', '12.8']) expect(check!.rule).toContain(rule)

    // 燃料不在 D 段：环节动作、以及引擎时机表里都没有它
    for (const step of chain.steps) expect(step.actions).not.toContain('fuel')
    expect([...ACTIONS_BY_PHASE.supply]).toEqual(['supplyTrace', 'hqThrow'])

    // 支付燃料的时机只有 C/E/G 的移动环节（12.5a/12.5f：开拔前必须已付）
    const payFuel = operationTimingOf('payFuel')!
    expect([...payFuel.segments].sort()).toEqual([
      'exploitation.movement',
      'movement.modeAndMovement',
      'reaction.movement',
    ])
    for (const id of payFuel.segments) expect(sopStepById(id)).not.toBeNull()
    // 反空转：这些环节确实"要燃料"（否则"只在移动环节付"就成了空话）
    expect(segmentsNeedingFuel()).toContain('movement.modeAndMovement')
  })

  it('★20.0d 吸收**不是环节**（原文：任何阶段结束时）⇒ 不在任何段的链条里', () => {
    for (const chain of SOP_SEGMENT_CHAINS) {
      for (const step of chain.steps) expect(step.id).not.toContain('absorb')
    }
    // 但 20.0a 的**创建**在环节内（C 段「开始移动」与 F/G 段的战斗环节）
    expect(sopStepById('movement.modeAndMovement')!.actions).toContain('breakdown')
    expect(sopStepById('combat.combat')!.actions).toContain('breakdown')
  })

  it('SOP 原文逐段照录（对账用）；原文未列子步的段，分环口径也说得清', () => {
    expect(sopChainOf('movement').sopText).toContain('Breakout / Mode & Movement')
    expect(sopChainOf('combat').sopText).toContain('Barrage (artillery only) / Combat')
    expect(sopChainOf('reaction').sopText).toContain('Movement / Barrage')
    expect(sopChainOf('exploitation').sopText).toContain('Movement / Barrage / Combat')
    // 原文一块一环的段（那一块里就一个动作）：A 整备、H 清理 —— 只有一环
    for (const phase of ['aircraftRefit', 'cleanUp'] as const) {
      expect(sopChainOf(phase).steps).toHaveLength(1)
    }
    // 原文也只给一块、但块内有若干**各自成文**的动作：B 增援、D 补给 ⇒ 按条文分环（不是漏写、也不是抄错）
    for (const phase of ['reinforcement', 'supply'] as const) {
      expect(sopChainOf(phase).steps.length).toBeGreaterThan(1)
      // 每一环都要有自己的规则号（分环的依据是条文，不是随手切）
      for (const step of sopChainOf(phase).steps) expect(step.rule.length).toBeGreaterThan(0)
    }
  })

  it('与 air-mission 的接缝：非轰炸类空中任务在**移动环节**、空军轰炸/运输破坏在**轰炸环节**', () => {
    expect(AIR_MISSION_SEGMENT.hip_shoot).toBe('movementSegment')
    expect(AIR_MISSION_SEGMENT.air_transport).toBe('movementSegment')
    expect(AIR_MISSION_SEGMENT.barrage).toBe('barrageSegment')
    expect(AIR_MISSION_SEGMENT.trainbusting).toBe('barrageSegment')
    // 本表里"轰炸环节"在 C（空中与舰炮）/F（炮兵）/G 各有一处，且都在该段的环节链内
    for (const phase of ['movement', 'combat', 'exploitation'] as const) {
      const step = sopStepForAction(phase, 'barrage' as ActionKind)!
      expect(step.id.endsWith('.barrage')).toBe(true)
    }
  })

  it('段名非法即抛错（不静默兜底）', () => {
    expect(() => sopChainOf('nope' as never)).toThrow(RangeError)
    expect(sopStepById('nope.nope')).toBeNull()
  })
})

/**
 * 三级一致性（对齐**流程表原文**；用户 2026-09-16 复核要求）
 *
 * 用户口径：「**环节是按流程表里来的**，回合、阶段、环节，三个层级」。
 * 故这里把源库原文（`charts.json → tables.sop`，状态 `confirmed`）的段与子步**逐条抄进测试**，
 * 与实现逐项对齐——将来有人改链条，这里是第一道红。
 *
 * | 层级     | 原文出处                                            | 条数 |
 * | -------- | --------------------------------------------------- | ---- |
 * | **回合** | 回合轨（本作 19 回合）                              | 19   |
 * | **阶段** | 流程表的段：天气 / 先手 / A–H（先手方与后手方各一遍）/ 推进回合标记 | 2 + 8×2 + 1 = 19 |
 * | **环节** | **段名原文里的子步**（只有 C/E/F/G 有）             | 3 + 2 + 2 + 3 = 10 |
 */
describe('B6：三级一致性（回合 / 阶段 / 环节 ↔ 流程表原文）', () => {
  /** 流程表原文的**段**（逐字照抄源库 `tables.sop.phases[].segments`，含 Pre-Turn 两项） */
  const SOURCE_SEGMENTS = [
    'Weather Determination',
    'First Player Determination',
    'A. Aircraft Refit Phase',
    'B. Reinforcement Phase',
    'C. Movement Phase: Breakout / Mode & Movement / Barrage (air & ship only)',
    'D. Supply Phase',
    'E. Reaction Phase: Movement / Barrage',
    'F. Combat Phase: Barrage (artillery only) / Combat',
    'G. Exploitation Phase: Movement / Barrage / Combat',
    'H. Clean Up Phase',
    'advance turn marker',
  ] as const

  /**
   * 原文**段名里写出来的子步**（= 环节；只有 C/E/F/G 的段名带 "/"）
   *
   * 这是"环节按流程表来"的**权威清单**：段名写了几段子步，实现就得有几环、且次序一致。
   */
  const SOURCE_SUBSTEPS: Readonly<Record<string, readonly string[]>> = {
    C: ['Breakout', 'Mode & Movement', 'Barrage (air & ship only)'],
    E: ['Movement', 'Barrage'],
    F: ['Barrage (artillery only)', 'Combat'],
    G: ['Movement', 'Barrage', 'Combat'],
  }

  it('阶段：流程表原文的 11 个段都在链条里有对应（Pre-Turn 两项由 `preTurn` 段的两环承担）', () => {
    // 原文 11 段 → 本表的 10 段（preTurn 一个段承担"天气判定 + 先手判定"两项）
    expect(SOURCE_SEGMENTS).toHaveLength(11)
    expect(SOP_SEGMENT_CHAINS).toHaveLength(10)

    const sopTexts = SOP_SEGMENT_CHAINS.map((chain) => chain.sopText)
    for (const segment of SOURCE_SEGMENTS) {
      const covered =
        sopTexts.includes(segment) ||
        // Pre-Turn 的两项被合成 `preTurn` 段的原文串（"Weather Determination / First Player Determination"）
        (segment === 'Weather Determination' || segment === 'First Player Determination'
          ? sopChainOf('preTurn').sopText.includes(segment)
          : false)
      expect(covered, `原文的段「${segment}」在链条里没有对应`).toBe(true)
    }
  })

  it('★核心：原文段名里写出的子步 = 该段的环节，且**次序一致**', () => {
    const phaseOf: Readonly<Record<string, string>> = {
      C: 'movement',
      E: 'reaction',
      F: 'combat',
      G: 'exploitation',
    }
    for (const [letter, substeps] of Object.entries(SOURCE_SUBSTEPS)) {
      const phase = phaseOf[letter]!
      const ids = sopStepsOf(phase as never).map((step) => step.id)
      expect(ids, `原文 ${letter} 段写了 ${substeps.length} 个子步`).toHaveLength(substeps.length)
      // 次序：第 n 环的中文名里要含第 n 个子步的关键词（英文原文 → 中文标签的对照）
      const keywords: Readonly<Record<string, string>> = {
        Breakout: '突围',
        'Mode & Movement': '模式与移动',
        'Barrage (air & ship only)': '轰炸',
        'Barrage (artillery only)': '炮击',
        Movement: '移动',
        Barrage: '轰炸',
        Combat: '战斗',
      }
      for (let index = 0; index < substeps.length; index += 1) {
        const keyword = keywords[substeps[index]!]!
        const label = sopChainOf(phase as never).steps[index]!.label
        expect(
          label,
          `原文 ${letter} 第 ${index + 1} 个子步「${substeps[index]}」应对应环节「${label}」`,
        ).toContain(keyword)
      }
    }
  })

  it('原文**没有**子步的段（A/B/D/H）：链条要么一环、要么按条文细分（B/D 为用户口径）', () => {
    // 原文只有一块、且那一块里就是一个动作的段 ⇒ 一环
    for (const phase of ['aircraftRefit', 'cleanUp'] as const) {
      expect(sopChainOf(phase).steps).toHaveLength(1)
    }
    // B/D：原文未列子步，但块内动作**各自成文**（用户 §4.1.6 表：B 到货→重建→抽取 / D 总计划→拖取→吃图上→断补）
    expect(sopChainOf('reinforcement').steps.length).toBeGreaterThan(1)
    expect(sopChainOf('supply').steps.length).toBeGreaterThan(1)
  })

  it('回合：一个回合 = Pre-Turn 2 + 先手方 A–H + 后手方 A–H + 回合结束（段级 19 项）', () => {
    // 段级 19 项＝2 + 8×2 + 1；环节数只与"段内"有关，不改变回合的段级结构
    const perPlayerSegment = 8
    expect(2 + perPlayerSegment * 2 + 1).toBe(19)
    // 链条覆盖的段正好是 10 个（Pre-Turn / A–H / Turn End）
    expect(SOP_SEGMENT_CHAINS.filter((chain) => chain.phase !== 'turnEnd')).toHaveLength(9)
  })
})

/**
 * 各操作的**环节与燃料时机**（用户 2026-09-16 指出：燃料这类要求"并不限于某个环节"）
 *
 * 12.5b 把七个操作分成两类（移动/突袭要燃料；攻击/防御/轰炸/撤退/推进不要），
 * 而它们**散在 C/E/F/G 四个段的多个环节**里。本组用例钉三件事：
 *   ① 表里写的环节 id **真实存在**；
 *   ② `needsFuel` 与 `fuel.ts#actionNeedsFuel` **逐项一致**（判据只一处，本表不另写规则）；
 *   ③ ★ **能在用得上的地方付款**：`payFuel` 覆盖了所有"要燃料"的环节
 *      （12.5c「均在**消耗发生的那一刻**支付」）——否则会出现"移动环节必须付、却只能在补给段付"的死结。
 */
describe('B6：各操作的环节与燃料时机（12.5a / 12.5b / 12.5c）', () => {
  it('表里的环节 id 都真实存在，且每项都有规则号与说明', () => {
    for (const item of OPERATION_TIMINGS) {
      expect(item.rule.length, `${item.operation} 缺规则号`).toBeGreaterThan(0)
      expect(item.note.length, `${item.operation} 缺时机说明`).toBeGreaterThan(0)
      expect(item.segments.length, `${item.operation} 没有登记环节`).toBeGreaterThan(0)
      for (const segment of item.segments) {
        expect(sopStepById(segment), `${item.operation} 所指环节 ${segment} 不存在`).not.toBeNull()
      }
    }
  })

  it('★ needsFuel 与 `actionNeedsFuel` 逐项一致（判据只有一处）', () => {
    for (const item of OPERATION_TIMINGS) {
      if (item.operation === 'payFuel') continue
      expect(item.needsFuel, `${item.operation} 的 needsFuel 与 fuel.ts 不一致`).toBe(
        operationNeedsFuel(item.operation),
      )
    }
    // 反空转：12.5b 的两类都真的出现在表里（不是"全是 false"混过去）
    expect(
      OPERATION_TIMINGS.filter((item) => item.needsFuel).map((item) => item.operation),
    ).toEqual(['move', 'overrun'])
  })

  it('★ 12.5c：`payFuel` 的环节**覆盖**所有"要燃料"的环节（付款没有死结）', () => {
    const paySegments = new Set(operationTimingOf('payFuel')!.segments)
    for (const segment of segmentsNeedingFuel()) {
      expect(paySegments.has(segment), `环节 ${segment} 需要燃料，但那里付不了款`).toBe(true)
    }
    // 反空转：确实有"要燃料"的环节（否则上面是空转）
    expect(segmentsNeedingFuel().length).toBeGreaterThan(0)
  })

  it('跨环节串起来看：移动/突袭在**移动环节**、轰炸在**轰炸环节**、攻击等在**战斗环节**', () => {
    const segmentsOf = (operation: 'move' | 'overrun' | 'barrage' | 'attack' | 'retreat') =>
      operationTimingOf(operation)!.segments

    // 移动与突袭：**同三个**移动环节（8.0「各个移动环节」+ 7.0 首句 / 7.0b「反应阶段中……突袭的结算照常」）
    expect(segmentsOf('move')).toEqual([
      'movement.modeAndMovement',
      'reaction.movement',
      'exploitation.movement',
    ])
    expect(segmentsOf('overrun')).toEqual(segmentsOf('move'))
    /*
     * 轰炸：四个段的轰炸环节（与 BARRAGE_SOURCES_BY_PHASE 的四个段一致）＋ **C 段的移动环节**。
     * ★ G① 契约变更（2026-09-19，**不是放宽**）：14.7d 明写「低空扫射是在**移动环节**而非轰炸环节中
     *   进行的一种特殊类型的轰炸」（clean txt 2690–2691、2874）⇒ 这一手必须能在 C 段移动环节宣布；
     *   炮兵在该段仍被 10.0e-D 拒（`wrongPhaseForartillery:movement`），来源限定不变。
     */
    expect(segmentsOf('barrage')).toEqual([
      'movement.barrage',
      'movement.modeAndMovement',
      'reaction.barrage',
      'combat.barrage',
      'exploitation.barrage',
    ])
    // 攻击 / 撤退 / 推进：都在战斗环节（F 与 G）
    for (const operation of ['attack', 'retreat', 'advanceAfterCombat'] as const) {
      expect(operationTimingOf(operation)!.segments).toEqual([
        'combat.combat',
        'exploitation.combat',
      ])
    }
  })
})
// ★ 与**闸门表**的对账（"要燃料的动作，其环节里闸门确实放行"）放在 `tests/stores/phase-gate.test.ts`：
//   闸门表在 stores 层，引擎测试不反向依赖 store（分层纪律）。
