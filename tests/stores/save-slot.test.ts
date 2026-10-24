import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { DATA_VERSION } from '@/data'
import { SAVE_FILE_VERSION, classifySaveError } from '@/engine/save-file'
import { createMemoryStorage, type KeyValueStorage } from '@/shared'
import { mapLayers } from '@/data'
import { PANZER_GROUP_OPTION_ITEM } from '@/engine/rules'
import type { HexRef } from '@/data'
import {
  SAVE_SLOT_KEY,
  toConsoleUnit,
  unitChoices,
  useGameSessionStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * 存档序列化与会话持久化（W6 D1）的**端到端流程**（store 级）
 *
 * 用**内存存储**顶替 localStorage（Vitest 为 node 环境，无浏览器 API）：
 * 断言「存得下、读得回、版本不符即拒且不动当前会话」。
 */

/** 建一个注入了内存存储的会话 store */
function newStore(adapter: KeyValueStorage = createMemoryStorage()) {
  setActivePinia(createPinia())
  const store = useGameSessionStore()
  store.setSaveStorage(adapter)
  return { store, adapter }
}

/**
 * W7 C13：专规 4.0 的开局共识勾选列表
 *
 * 「选择剧本后，第一个回合开始前，全部勾选才开始」⇒ 推进之前先把共识一次性写入日志。
 */
function confirmConsensus(store: ReturnType<typeof newStore>['store']): void {
  store.setAllAgreedChecks(true)
  expect(store.confirmAgreedChecklist()).toBe(true)
}

/** 一路推进到**停下待答**（首回合先手由剧本指定 ⇒ 首个真待答在第 2 回合先手判定，2.3） */
function stepToAwaiting(store: ReturnType<typeof newStore>['store']): void {
  for (let guard = 0; guard < 200; guard += 1) {
    if (store.awaiting || store.terminated) return
    if (!store.stepNow()) throw new Error(`推进被拒：${store.error?.rule}/${store.error?.reason}`)
  }
  throw new Error('未在合理步数内停下待答')
}

describe('W6 D1：保存到存档槽', () => {
  it('D1：开局后可保存；槽里是合法存档文件，摘要与当前会话一致', () => {
    const { store, adapter } = newStore()
    store.startGame()
    expect(store.saveNow()).toBe(true)
    expect(store.saveError).toBeNull()

    const text = adapter.getItem(SAVE_SLOT_KEY)
    expect(text).not.toBeNull()
    const parsed = JSON.parse(text ?? '{}') as Record<string, unknown>
    expect(parsed['saveVersion']).toBe(SAVE_FILE_VERSION)
    expect(parsed['dataVersion']).toBe(DATA_VERSION)
    expect(parsed['scenarioId']).toBe(store.scenarioId)

    expect(store.slot).not.toBeNull()
    expect(store.slot?.scenarioId).toBe('1')
    expect(store.slot?.turn).toBe(1)
    expect(store.slot?.form).toBe('advancing')
    // 种子与游标随档保存（刚开局尚未掷骰 ⇒ 游标 0）
    expect(store.slot?.seed).toBe(20260913)
    expect(store.slot?.drawCount).toBe(0)
  })

  it('D1：未开局 / 无存储介质 ⇒ 拒并给出原因码', () => {
    const { store } = newStore()
    expect(store.saveNow()).toBe(false)
    expect(store.saveError?.reason).toBe('noSessionToSave')

    store.startGame()
    store.setSaveStorage(null)
    expect(store.saveNow()).toBe(false)
    expect(store.saveError?.reason).toBe('storageUnavailable')
  })

  it('D1：多次推进后保存，摘要反映当时的回合 / 阶段 / 掷骰游标', () => {
    const { store } = newStore()
    store.startGame()
    confirmConsensus(store)
    store.stepNow() // 天气（掷骰：首回合按剧本指定，不掷 ⇒ 游标仍为 0）
    store.stepNow() // 先手判定（首回合指定）
    expect(store.records?.phase).toBe('aircraftRefit')
    expect(store.saveNow()).toBe(true)
    expect(store.slot).toMatchObject({ turn: 1, phase: 'aircraftRefit', form: 'advancing' })
    expect(store.slot?.drawCount).toBe(0)
  })

  /*
   * P0 修复（B48）的**分层边界**：盘面快照由操作台提供（它才是盘面的家）。
   * 只建会话层（没建操作台）时没有编解码器 ⇒ 存档里**不出现** `board`、读档也不要求它，
   * 即"会话层单独可用"这一修前的行为原样保留（引擎与 store 的其它单测都靠它）。
   */
  it('D1：只建会话层（无操作台）时存档不含盘面快照，读档照旧通过 —— 与修前一致', () => {
    const { store, adapter } = newStore()
    store.startGame()
    expect(store.saveNow()).toBe(true)
    const parsed = JSON.parse(adapter.getItem(SAVE_SLOT_KEY) ?? '{}') as Record<string, unknown>
    expect(parsed['board']).toBeUndefined()
    expect(store.loadNow()).toBe(true)
  })
})

describe('W6 D1：读档恢复（含进行中会话）', () => {
  it('D1：读档恢复剧本与会话本体（状态 / 日志 / 游标）', () => {
    const { store, adapter } = newStore()
    store.setScenarioId('3')
    store.startGame()
    confirmConsensus(store)
    expect(store.saveNow()).toBe(true)
    const before = store.records

    // 在新 store 实例里读档（证明结论来自存档文件，而非内存里的旧对象）
    const second = newStore(adapter)
    expect(second.store.session).toBeNull()
    second.store.refreshSlotNow()
    expect(second.store.slot?.scenarioId).toBe('3')
    expect(second.store.loadNow()).toBe(true)
    expect(second.store.scenarioId).toBe('3')
    expect(second.store.records).toStrictEqual(before)
    expect(second.store.form).toBe('advancing')
  })

  it('D1：**进行中会话**（待答中）连问题一起恢复 —— 读回后仍停在待答', () => {
    const { store } = newStore()
    store.startGame()
    // W7 C13：先过开局共识（专规 4.0），再推进到首个真待答（第 2 回合先手判定，2.3）
    confirmConsensus(store)
    stepToAwaiting(store)
    expect(store.awaiting).toBe(true)
    const questionId = store.question?.id
    expect(store.saveNow()).toBe(true)
    expect(store.slot?.form).toBe('awaiting')
    expect(store.slot?.awaiting?.questionId).toBe(questionId)

    // 在原 store 里把这一问答掉（形态变 advancing），再读档 ⇒ 回到待答那一刻
    expect(store.answerNow('first')).toBe(true)
    expect(store.awaiting).toBe(false)
    expect(store.loadNow()).toBe(true)
    expect(store.awaiting).toBe(true)
    expect(store.question?.id).toBe(questionId)
  })

  it('D1：共识开关结论随档恢复（已答的保留原选择，读回后可继续推进）', () => {
    const { store, adapter } = newStore()
    store.startGame()
    // 全部勾选（都已谈过），但第 1 条一致决定不用 ⇒ 结论是「不采纳」（勾选 ≠ 采纳）
    store.setAllAgreedChecks(true)
    store.setAgreedAdopt(0, false)
    expect(store.confirmAgreedChecklist()).toBe(true)
    expect(store.consensus[0]).toMatchObject({ adopted: false })
    expect(store.saveNow()).toBe(true)

    const second = newStore(adapter)
    expect(second.store.loadNow()).toBe(true)
    // 逐条结论从日志回读：第 1 条不采纳，其余采纳
    expect(second.store.consensus[0]).toMatchObject({ adopted: false })
    expect(second.store.consensus.slice(1).every((entry) => entry.adopted === true)).toBe(true)
    // 勾选镜像与结论一致：勾选按「已写入日志的条目」回填，第 1 条不生效 ⇒ 门禁放行，第一回合得以开始
    expect(second.store.agreedCheckedCount).toBe(second.store.agreedOptionItems.length)
    expect(second.store.agreedChecklistRows[0]?.adopted).toBe(false)
    expect(second.store.agreedRecorded).toBe(true)
    expect(second.store.stepNow()).toBe(true)
    expect(second.store.records?.preTurnSegment).toBe('firstPlayerDetermination')
  })

  it('D1：读档不带上一局的注入值与裁决记录（盘面注入复位）', () => {
    const { store } = newStore()
    store.startGame()
    store.saveNow()
    confirmConsensus(store)
    stepToAwaiting(store)
    expect(store.lastAdvanceKind).toBe('question')
    // 盘面注入值属**本局内存态**：读档后不得沿用（否则会把上一局的决胜结论带进新盘面）
    store.earlyDecisionMet = true
    expect(store.loadNow()).toBe(true)
    expect(store.earlyDecisionMet).toBe(false)
    expect(store.lastAdvanceKind).toBeNull()
  })
})

describe('W6 D1：读档逐层校验（不符即拒，且不动当前会话）', () => {
  /** 篡改槽里的某个字段后读档 */
  function tamper(adapter: KeyValueStorage, patch: (file: Record<string, unknown>) => void) {
    const file = JSON.parse(adapter.getItem(SAVE_SLOT_KEY) ?? '{}') as Record<string, unknown>
    patch(file)
    adapter.setItem(SAVE_SLOT_KEY, JSON.stringify(file))
  }

  it('D1：数据契约版本不符 ⇒ 拒，且**当前会话保持不动**', () => {
    const { store, adapter } = newStore()
    store.startGame()
    store.saveNow()
    const turnBefore = store.records?.turn
    const formBefore = store.form

    tamper(adapter, (file) => {
      file['dataVersion'] = '0.0.1'
    })
    expect(store.loadNow()).toBe(false)
    expect(store.saveError?.rule).toBe('D1')
    expect(store.saveError?.reason).toContain('#/dataVersion')
    // 会话未被替换、未被清空
    expect(store.form).toBe(formBefore)
    expect(store.records?.turn).toBe(turnBefore)
  })

  it('D1：存档文件版本 / 剧本号 / 掷骰算法不符 ⇒ 各自带路径拒', () => {
    const cases: { patch: (file: Record<string, unknown>) => void; path: string }[] = [
      { patch: (file) => (file['saveVersion'] = 99), path: '#/saveVersion' },
      { patch: (file) => (file['scenarioId'] = '99'), path: '#/scenarioId' },
      { patch: (file) => (file['rngAlgorithm'] = 'other-prng'), path: '#/rngAlgorithm' },
      { patch: (file) => (file['savedAt'] = ''), path: '#/savedAt' },
    ]
    for (const item of cases) {
      const { store, adapter } = newStore()
      store.startGame()
      store.saveNow()
      tamper(adapter, item.patch)
      expect(store.loadNow()).toBe(false)
      expect(store.saveError?.reason).toContain(item.path)
    }
  })

  it('D1：槽为空 / 内容不是 JSON ⇒ 拒并给出原因码', () => {
    const { store, adapter } = newStore()
    store.startGame()
    expect(store.loadNow()).toBe(false)
    expect(store.saveError?.reason).toBe('emptySlot')

    adapter.setItem(SAVE_SLOT_KEY, '{ not json')
    expect(store.loadNow()).toBe(false)
    expect(store.saveError?.reason).toContain('不是合法 JSON')
    // 摘要刷新时也不抛错，只置空并记原因
    store.refreshSlotNow()
    expect(store.slot).toBeNull()
    expect(store.saveError?.rule).toBe('D1')
  })
})

describe('W6 D1：清档与槽摘要刷新', () => {
  it('D1：清档只清槽，不影响当前会话', () => {
    const { store, adapter } = newStore()
    store.startGame()
    store.saveNow()
    expect(store.slot).not.toBeNull()

    expect(store.clearSlotNow()).toBe(true)
    expect(store.slot).toBeNull()
    expect(adapter.getItem(SAVE_SLOT_KEY)).toBeNull()
    // 会话仍在
    expect(store.form).toBe('advancing')
  })

  it('D1：建店时可从已有槽读出摘要（列表/续玩入口）', () => {
    const adapter = createMemoryStorage()
    const first = newStore(adapter)
    first.store.startGame()
    first.store.saveNow()

    // 新建 store 实例后刷新摘要，即可看到「有一档可续」
    const second = newStore(adapter)
    second.store.refreshSlotNow()
    expect(second.store.slot?.savedAt).not.toBe('')
    expect(second.store.slot?.logEntries).toBeGreaterThanOrEqual(0)
    expect(second.store.saveError).toBeNull()
  })
})

describe('W7 C15：存档界面所需的四件事（任意环节可存 / 恢复提示 / 版本提示）', () => {
  it('C15：**任意环节都可存档** —— 待答中与已终止的会话都能落盘，摘要如实反映形态', () => {
    const { store } = newStore()
    store.startGame()
    confirmConsensus(store)

    // ① 待答中存档（进行中会话）
    stepToAwaiting(store)
    expect(store.awaiting).toBe(true)
    expect(store.saveNow()).toBe(true)
    expect(store.slot).toMatchObject({ form: 'awaiting' })
    expect(store.slot?.awaiting?.questionId).toBe(store.question?.id)

    // ② 已终止的会话也能存（跑到剧本 2 结束）
    store.resetGame()
    store.setScenarioId('2')
    store.startGame()
    confirmConsensus(store)
    let guard = 0
    while (!store.terminated) {
      guard += 1
      if (guard > 2000) throw new Error('流程未在合理步数内终止（疑似死循环）')
      if (store.awaiting) store.answerNow('first')
      else if (!store.stepNow()) throw new Error(`推进被拒：${store.error?.reason}`)
    }
    expect(store.saveNow()).toBe(true)
    expect(store.slot).toMatchObject({ form: 'terminated' })
    expect(store.slot?.termination).toBe('turnsExhausted')
  })

  it('C15：**进行中会话的恢复提示**所需信息齐备（题号 / 类别 / 应答方 / 题面）', () => {
    const { store } = newStore()
    store.startGame()
    confirmConsensus(store)
    stepToAwaiting(store)
    store.saveNow()

    const awaiting = store.slot?.awaiting
    expect(awaiting).not.toBeNull()
    expect(awaiting?.questionId).not.toBe('')
    expect(awaiting?.kind).not.toBe('')
    expect(['axis', 'soviet']).toContain(awaiting?.responder)
    expect(awaiting?.prompt).not.toBe('')
  })

  it('C15：**版本不匹配**提示的判据来自存档层原因（界面不再自己解析字符串）', () => {
    const { store, adapter } = newStore()
    store.startGame()
    store.saveNow()
    // 篡改数据契约版本 ⇒ 读档被拒，归类应落到「数据契约」层
    const file = JSON.parse(adapter.getItem(SAVE_SLOT_KEY) ?? '{}') as Record<string, unknown>
    file['dataVersion'] = '0.0.1'
    adapter.setItem(SAVE_SLOT_KEY, JSON.stringify(file))
    expect(store.loadNow()).toBe(false)
    const info = classifySaveError(store.saveError?.reason ?? '')
    expect(info.kind).toBe('versionMismatch')
    expect(info.layer).toBe('数据契约')
    expect(info.expected).toBe(DATA_VERSION)
    expect(info.actual).toBe('0.0.1')

    // 存档文件版本篡改 ⇒ 落到「存档文件格式」层
    file['dataVersion'] = DATA_VERSION
    file['saveVersion'] = SAVE_FILE_VERSION + 1
    adapter.setItem(SAVE_SLOT_KEY, JSON.stringify(file))
    expect(store.loadNow()).toBe(false)
    expect(classifySaveError(store.saveError?.reason ?? '').layer).toBe('存档文件格式')
  })

  it('C15：无档 / 无介质 / 无会话三种情形都能给出可显示提示', () => {
    const { store } = newStore()
    // 无会话就保存
    expect(store.saveNow()).toBe(false)
    expect(classifySaveError(store.saveError?.reason ?? '').kind).toBe('noSessionToSave')
    // 无档就读
    expect(store.loadNow()).toBe(false)
    expect(classifySaveError(store.saveError?.reason ?? '').kind).toBe('emptySlot')
    // 无介质
    store.startGame()
    store.setSaveStorage(null)
    expect(store.saveNow()).toBe(false)
    expect(classifySaveError(store.saveError?.reason ?? '').kind).toBe('storageUnavailable')
  })
})

/*
 * B48 P0 修复：**存档带盘面**（摆子 → 存 → 读 → 盘面一致）
 *
 * 病灶（§17.85 的 P0）：修前存档 payload 只有 `{scenarioId, session}`，而**盘面**（算子 / 补给站 /
 * 飞机 / 各类账本）全在操作台 store 里、从无人写盘 ⇒ 读档只把记录轨（时钟 / 日志 / 种子 / 共识）
 * 搬回去，盘面留在原处，两边互相矛盾；而界面（`SaveLoadDialog`）写着"任意环节都可存档"。
 *
 * 本组把四条判据各自钉一条：
 *   · **可达**：两店齐备时存档，payload 里**有** `board`；读档把盘面搬回来；
 *   · **强制**：缺 `board` 的档 / 版本或字段表不认识的档一律**拒读**，且此刻会话与盘面都不动；
 *   · **留痕**：拒读的原因码（`boardMissing:` / `boardUnrecognized:`）能归类成界面能说的话；
 *   · **可玩通**：读档后的盘面真的能继续用（在还原出的盘面上再推进一步）。
 *
 * ## 测法边界（诚实交代）
 *   · 快照**口径**由 `workbench` 的 `boardSnapshotFields()` 白纸黑字给出（46 项，唯一真源：
 *     capture / 校验 / restore 同表）；本组只钉其中**有代表性**的几类（算子 / 补给站 / 3.4b 待办 /
 *     城市控制账本 / 胜利格控制账本），不逐项穷举 —— 逐项穷举由"同表"这一结构保证；
 *   · 不断言 `session.log`（属会话本体，上方已有用例覆盖）；不断言**交互进行态**（`moveInteraction`
 *     / 中途战斗选人 / 各面板草稿 —— 字段表里**刻意不收**），即"读到一半的移动或战斗不会跨存档续上"，
 *     这是刻意划出的边界，不是漏收。
 */

/** 两格：都在图内、都远离地图边缘（避免边角地形干扰后续把子） */
const [P0_HEX_A, P0_HEX_B] = (() => {
  for (const hex of mapLayers.hexes) {
    if (hex.col < 12 || hex.row < 12 || hex.col > 40 || hex.row > 24) continue
    const a: HexRef = { col: hex.col, row: hex.row }
    const b: HexRef = { col: hex.col + 1, row: hex.row }
    if (!mapLayers.hexes.some((item) => item.col === b.col && item.row === b.row)) continue
    return [a, b] as const
  }
  throw new Error('地图上找不到合适的两格')
})()

/** 建**两店齐备**的局（操作台建店时会把自己的盘面快照编解码器注册给会话层） */
function newBoardStore(adapter: KeyValueStorage = createMemoryStorage()) {
  setActivePinia(createPinia())
  const workbench = useWorkbenchStore()
  const session = useGameSessionStore()
  session.setSaveStorage(adapter)
  return { workbench, session, adapter }
}

/** 取槽里的存档文件并改写（`patch` 直接改传入的对象；改完写回） */
function tamperSlot(
  adapter: KeyValueStorage,
  patch: (file: Record<string, unknown>) => void,
): void {
  const file = JSON.parse(adapter.getItem(SAVE_SLOT_KEY) ?? '{}') as Record<string, unknown>
  patch(file)
  adapter.setItem(SAVE_SLOT_KEY, JSON.stringify(file))
}

/** 取快照载荷（读档拒了也要能看，故直接解析槽文本） */
function boardPayloadOf(adapter: KeyValueStorage): Record<string, unknown> {
  const file = JSON.parse(adapter.getItem(SAVE_SLOT_KEY) ?? '{}') as Record<string, unknown>
  return file['board'] as Record<string, unknown>
}

/** 深拷贝：与快照的落盘语义一致（JSON 化后再比） */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 摆一枚算子上盘（夹具同突围用例：直接用 `toConsoleUnit` 造盘面事实） */
function placeFixtureUnit(
  workbench: ReturnType<typeof useWorkbenchStore>,
  side: 'axis' | 'soviet',
  instanceId: string,
  hex: HexRef,
): void {
  workbench.units.push(toConsoleUnit({ record: unitChoices(side)[0]!, instanceId, hex, side }))
}

describe('B48 P0：存档带盘面（摆子 → 存 → 读 → 盘面一致）', () => {
  it('P0：摆子后存档，读档把盘面原样搬回来，且能继续推进', () => {
    const { workbench, session, adapter } = newBoardStore()
    session.startGame()
    // 专规 4.0：开局共识未过，推进会被门禁拦下（"可玩通"那一步需要它）
    confirmConsensus(session)

    placeFixtureUnit(workbench, 'axis', 'p0-axis', P0_HEX_A)
    placeFixtureUnit(workbench, 'soviet', 'p0-soviet', P0_HEX_B)
    // B50：先把「装甲集群 SP 归属约束」这条**可选项**勾上 —— 否则新落的轴方 SP 不进待办
    // （勾上是为了让下面的往返断言**非空**有东西可验，不是这个用例要考的规则本身）
    const optionIndex = session.agreedOptionItems.indexOf(PANZER_GROUP_OPTION_ITEM)
    expect(optionIndex).toBeGreaterThanOrEqual(0)
    session.setAgreedCheck(optionIndex, true)

    // 走**真实入口**落一处补给站（12.1b），顺带生成 3.4b 的装甲集群待办
    workbench.spDumpDraft = {
      hexText: `${String(P0_HEX_A.col)}.${String(P0_HEX_A.row)}`,
      sp: 2,
      t: 0,
    }
    expect(workbench.addSpDump()).toBe(true)
    // 一处城市控制账本（3.3b）
    workbench.toggleAxisCityControlNow(`${String(P0_HEX_B.col)}.${String(P0_HEX_B.row)}`)

    const boardBefore = {
      units: clone(workbench.units),
      spDumps: clone(workbench.spDumps),
      pendingSpGroupAssignment: [...workbench.pendingSpGroupAssignment],
      cityKeys: [...workbench.axisControlledCityKeys],
      victoryLastControl: clone(workbench.victoryLastControl),
    }
    expect(session.saveNow()).toBe(true)

    // 存档 payload 里**有** board —— 修的正是"修前这里什么都没有"
    expect(boardPayloadOf(adapter)).toBeDefined()
    /*
     * 契约变更（**不是放宽**）：批 A 切片 3 加了 9.1c 两个攻击账本 ⇒ 版本 2；
     * 第六批条 5 又加到达"已投放"账本（`arrivalPlacedKey`/`arrivalPlacedRaw`）⇒ 版本 3；
     * §5-D 补员盘面化（`replHoldings` → `replPending`/`replFtrTac`，Pax/Eq 改随 `units` 存档）
     * ⇒ 版本 4（v3 旧档由 `migrateBoardV3ToV4` 迁成盘面算子，见 store 里那行注释）。
     */
    expect(boardPayloadOf(adapter)['version']).toBe(4)

    // 把盘面改乱：清算子、清补给站、把城市账本改回去
    workbench.units.splice(0, workbench.units.length)
    workbench.spDumps = []
    workbench.toggleAxisCityControlNow(`${String(P0_HEX_B.col)}.${String(P0_HEX_B.row)}`)
    expect(workbench.units).toHaveLength(0)
    expect(workbench.spDumps).toHaveLength(0)
    expect(workbench.axisControlledCityKeys).toHaveLength(0)

    // 读档 ⇒ 盘面回到存档那一刻
    expect(session.loadNow()).toBe(true)
    expect(clone(workbench.units)).toStrictEqual(boardBefore.units)
    expect(clone(workbench.spDumps)).toStrictEqual(boardBefore.spDumps)
    expect(boardBefore.pendingSpGroupAssignment).toHaveLength(1) // 3.4b 待办确实进了快照
    expect([...workbench.pendingSpGroupAssignment]).toStrictEqual(
      boardBefore.pendingSpGroupAssignment,
    )
    expect([...workbench.axisControlledCityKeys]).toStrictEqual(boardBefore.cityKeys)
    expect(clone(workbench.victoryLastControl)).toStrictEqual(boardBefore.victoryLastControl)

    // 可玩通：在还原出的盘面上继续推进（会话与盘面同拍）
    expect(session.stepNow()).toBe(true)
  })

  it('P0：缺盘面快照的档（修前存档）⇒ 拒读，且会话与盘面都不动', () => {
    const { workbench, session, adapter } = newBoardStore()
    session.startGame()
    placeFixtureUnit(workbench, 'axis', 'p0-keep', P0_HEX_A)
    expect(session.saveNow()).toBe(true)
    // 模拟"修前写下的档"：把 board 字段整个删掉
    tamperSlot(adapter, (file) => {
      delete file['board']
    })
    expect(boardPayloadOf(adapter)).toBeUndefined()

    expect(session.loadNow()).toBe(false)
    expect(session.saveError?.reason).toContain('boardMissing')
    // 此刻尚未改动任何状态：盘面还在、会话形态不变
    expect(workbench.units).toHaveLength(1)
    expect(session.form).toBe('advancing')
    // 留痕：原因码能归类成界面能说的话
    expect(classifySaveError(session.saveError?.reason ?? '').kind).toBe('corrupt')
  })

  it('P0：盘面快照版本不认识 ⇒ 拒读（归到「盘面快照」层），盘面不动', () => {
    const { workbench, session, adapter } = newBoardStore()
    session.startGame()
    placeFixtureUnit(workbench, 'axis', 'p0-v', P0_HEX_A)
    expect(session.saveNow()).toBe(true)
    tamperSlot(adapter, (file) => {
      const board = file['board'] as Record<string, unknown>
      board['version'] = 99
    })

    expect(session.loadNow()).toBe(false)
    expect(session.saveError?.reason).toContain('boardUnrecognized')
    expect(workbench.units).toHaveLength(1)
    const info = classifySaveError(session.saveError?.reason ?? '')
    expect(info.kind).toBe('versionMismatch')
    expect(info.layer).toBe('盘面快照')
  })

  it('§5-D：v3 旧档（补员还是账本）⇒ 读档迁成盘面补员算子', () => {
    const { workbench, session, adapter } = newBoardStore()
    session.startGame()
    // 摆一座己方指挥部：迁移规则是"落到档里记的补员格，没有则落到第一座己方 HQ"
    // （SOP 游戏提示的"训练分队"），再不行才退回待放置
    workbench.units.push(
      toConsoleUnit({
        record: unitChoices('axis').find((item) => item.specialized?.includes('hq') === true)!,
        instanceId: 'p0-hq',
        hex: P0_HEX_B,
        side: 'axis',
      }),
    )
    placeFixtureUnit(workbench, 'axis', 'p0-repl', P0_HEX_A)
    expect(session.saveNow()).toBe(true)

    // 手工把存档改成 v3 形态：补员是账本四个数字，没有 replPending/replFtrTac
    tamperSlot(adapter, (file) => {
      const board = file['board'] as { version: number; fields: Record<string, unknown> }
      board.version = 3
      board.fields['replHoldings'] = { pax: 3, eq: 1, ftr: 0, tac: 0 }
      delete board.fields['replPending']
      delete board.fields['replFtrTac']
    })

    // 读档不拒（只接受上一个版本），且迁移把账本摆成盘面算子
    expect(session.loadNow()).toBe(true)
    const repls = workbench.units.filter((unit) => unit.replKind != null)
    expect(repls).toHaveLength(4)
    expect(repls.filter((unit) => unit.replKind === 'pax')).toHaveLength(3)
    expect(repls.filter((unit) => unit.replKind === 'eq')).toHaveLength(1)
    // 盘面为唯一事实：投影读出来就是那四个数
    expect(workbench.replHoldings).toMatchObject({ pax: 3, eq: 1 })
    // 落点＝第一座己方 HQ（P0_HEX_B），不是任意格
    expect(
      repls.every((unit) => unit.hex.col === P0_HEX_B.col && unit.hex.row === P0_HEX_B.row),
    ).toBe(true)
  })

  it('P0：快照字段表缺项（结构改过却忘了递增版本号）⇒ 拒读', () => {
    const { workbench, session, adapter } = newBoardStore()
    session.startGame()
    placeFixtureUnit(workbench, 'axis', 'p0-m', P0_HEX_A)
    expect(session.saveNow()).toBe(true)
    tamperSlot(adapter, (file) => {
      const board = file['board'] as { fields: Record<string, unknown> }
      delete board.fields['units']
    })

    expect(session.loadNow()).toBe(false)
    expect(session.saveError?.reason).toContain('boardUnrecognized')
    expect(workbench.units).toHaveLength(1)
  })

  it('P0：可空账本"当前为 null、快照里有值"**不**被误拒（种类判据对着字段自身）', () => {
    const { workbench, session, adapter } = newBoardStore()
    session.startGame()
    /*
     * 9.14 的特殊战斗待决是**可空账本**。真实场景正是本用例：存档那一刻有一起待决（对象），
     * 而读档时的当前盘面是空的（null）⇒ 若拿"快照 vs 当前值"比种类，这份合法档会被误拒。
     * 故此处把快照里的该项改成一份**完整形状**的待决（不是糊一个假对象：它会被界面的
     * 计算属性读到，形状不对会连带把别的用例拖红）。
     */
    workbench.specialPending = null
    expect(session.saveNow()).toBe(true)
    const pending = {
      hex: { col: P0_HEX_A.col, row: P0_HEX_A.row },
      enteringSide: 'axis',
      splits: [],
      items: [],
      notes: ['测试夹具：无即时处置'],
      dice: {},
    }
    tamperSlot(adapter, (file) => {
      const board = file['board'] as { fields: Record<string, unknown> }
      board.fields['specialPending'] = pending
    })
    // 版本与字段表都齐 ⇒ 认，读档应当通过并把该账本落值
    expect(session.loadNow()).toBe(true)
    expect(workbench.specialPending).toStrictEqual(pending)
  })
})
