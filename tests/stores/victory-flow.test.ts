import { describe, expect, it } from 'vitest'

import { TURN_TRACK } from '@/stores'
import { axisVictoryCities, listedVictoryHexes, sovietVictoryCities } from '@/engine/rules'

import { combatRecord, label, newConsole, placeGround } from '../flows/sop-harness'

/**
 * W6 B20 的**端到端流程**（store 级）：胜利判定 5.0a / 5.0b / 5.0c
 *
 * 用**真实剧本数据、真实地图格与真实单位库**（不造数）；结论全部来自引擎，
 * 故断言的是「流程走通 + 账本写对 + 时点闸门生效」。
 */

/** 1941-08-19（5.0b 起始日）与 1941-08-15（早于起始日）对应的回合号 */
const TURN_19_AUG = TURN_TRACK.find((entry) => entry.date === '1941-08-19')?.turn ?? 13
const TURN_15_AUG = TURN_TRACK.find((entry) => entry.date === '1941-08-15')?.turn ?? 12

/** 剧本 1 的通用清单 11 格 */
const LISTED = listedVictoryHexes('1')
/** 苏方两城格（Vyazma 56.20 / Rzhev 60.34） */
const SOVIET_CITIES = sovietVictoryCities().flatMap((city) => [...city.hexes])
/** 轴方五城格 */
const AXIS_CITIES = axisVictoryCities().flatMap((city) => [...city.hexes])

/** 用控制账本把一组格指定给某一方 */
function assignControl(
  store: ReturnType<typeof newConsole>,
  hexes: readonly { col: number; row: number }[],
  side: 'axis' | 'soviet',
): void {
  for (const hex of hexes) store.setVictoryControlNow(label(hex), side)
}

describe('W6 B20：剧本与回合区间（5.0a 的检查时点）', () => {
  it('剧本 1：首回合 1（8 Jul）、末回合 19（8 Sep）', () => {
    const store = newConsole()
    expect(store.victoryTurnRange).toMatchObject({ firstTurn: 1, lastTurn: 19, dataNote: null })
    expect(store.atFinalTurn).toBe(false)
  })

  it('剧本 2：末回合为第 8 回合，且与印值「1 Aug 41」一致 ⇒ 无自检提示', () => {
    const store = newConsole()
    store.setScenarioId('2')
    expect(store.victoryTurnRange.lastTurn).toBe(8)
    // ★ 2026-09-15 回合轨修正后（8 月首回合＝1 日），印值即该回合 ⇒ dataNote 为空
    expect(store.victoryTurnRange.dataNote).toBeNull()
  })

  it('切到末回合 ⇒ atFinalTurn 为真（5.0a 的判定时点）', () => {
    const store = newConsole()
    store.setTurn(19)
    expect(store.atFinalTurn).toBe(true)
  })
})

describe('W6 B20：5.0c 控制账本（B17-1：**进入即触发** + 初设按剧本与战线播种）', () => {
  it('★ 播种：新开局的控制账本**不是空的**——按剧本与战线给出（剧本 1 全部属苏军）', () => {
    const store = newConsole()
    const keys = Object.keys(store.victoryLastControl)
    expect(keys.length).toBeGreaterThan(0)
    // 剧本 1（8 Jul 战役开局）的战线数据里没有"开局属德军"的格 ⇒ 全部归苏军
    for (const hex of LISTED) expect(store.victoryLastControl[label(hex)]).toBe('soviet')
    for (const hex of SOVIET_CITIES) expect(store.victoryLastControl[label(hex)]).toBe('soviet')
  })

  it('★ 触发：可攻击单位**进入**胜利格 ⇒ 控制立即易手（不必等回合末，也不必手点刷新）', () => {
    const store = newConsole()
    const hex = LISTED[0]!
    expect(store.victoryLastControl[label(hex)]).toBe('soviet')
    // 直接摆进该格（等价于"移动进入"：位置一变，触发就跑）
    placeGround(store, combatRecord('axis'), hex, 'axis', 'u1')
    expect(store.victoryLastControl[label(hex)]).toBe('axis')
    expect(store.victorySummary.listedBySide.axis).toBe(1)
  })

  it('★ 触发之后：单位撤走 ⇒ 账本**保留**最后控制者（5.0c 的空格口径）', () => {
    const store = newConsole()
    const hex = LISTED[1]!
    placeGround(store, combatRecord('axis'), hex, 'axis', 'u1')
    expect(store.victoryLastControl[label(hex)]).toBe('axis')
    store.units = store.units.filter((unit) => unit.instanceId !== 'u1')
    expect(store.victoryLastControl[label(hex)]).toBe('axis')
    expect(store.victorySummary.listedBySide.axis).toBe(1)
  })

  it('5.0c：按盘面刷新仍可用（裁判手动那一份）——格内有可攻击单位 ⇒ 该方', () => {
    const store = newConsole()
    const hex = LISTED[0]!
    placeGround(store, combatRecord('axis'), hex, 'axis', 'u1')
    store.refreshVictoryControlNow()
    expect(store.victoryLastControl[label(hex)]).toBe('axis')
  })

  it('5.0c：非战斗/非可攻击单位不算控制（触发与刷新都不为它改归属）', () => {
    const store = newConsole()
    const hex = LISTED[0]!
    /*
     * 顺序说明：`placeGround` 建的算子**创建时可攻击** ⇒ 落格那一刻触发就已经把它记成轴方
     * （这正是"进入即记账"）。所以要验证"不可攻击者不算控制"，得先把它的可攻击位关掉、
     * 再用裁判工具把该格判回苏方，然后看**触发与刷新**会不会又把它改回轴方（不该）。
     */
    const unit = placeGround(store, combatRecord('axis'), hex, 'axis', 'nc1')
    unit.attackCapable = false
    store.setVictoryControlNow(label(hex), 'soviet')
    expect(store.victoryLastControl[label(hex)]).toBe('soviet')

    store.refreshVictoryControlNow()
    expect(store.victoryLastControl[label(hex)]).toBe('soviet')
  })

  it('5.0c：裁判可直接指定 / 清除某格控制（格号非法 ⇒ 报错且不写入）', () => {
    const store = newConsole()
    store.setVictoryControlNow(label(LISTED[0]!), 'axis')
    expect(store.victoryLastControl[label(LISTED[0]!)]).toBe('axis')
    store.setVictoryControlNow(label(LISTED[0]!), null)
    expect(store.victoryLastControl[label(LISTED[0]!)]).toBeUndefined()

    store.setVictoryControlNow('不是格号', 'axis')
    expect(store.victoryError).toMatchObject({ rule: '5.0c' })
  })

  it('5.0c：账本随剧本切换**重新播种**（清单与阈值都按剧本号取）', () => {
    const store = newConsole()
    store.setVictoryControlNow(label(LISTED[0]!), 'axis')
    expect(store.victoryLastControl[label(LISTED[0]!)]).toBe('axis')
    store.setScenarioId('3')
    // 换剧本 ⇒ 按新剧本的战线重播种（手改的那一笔不再保留）
    expect(Object.keys(store.victoryLastControl).length).toBeGreaterThan(0)
    expect(store.victoryLastControl[label(LISTED[0]!)]).not.toBe('axis')
    // 剧本 3 的战线有"开局属德军"的格 ⇒ 账本里应当出现轴方（数据驱动，不写死格号）
    expect(Object.values(store.victoryLastControl)).toContain('axis')
  })
})

describe('W6 B20：5.0a 回合末检查（仅最终回合）', () => {
  it('5.0a：未到最终回合 ⇒ 拒，并给出末回合提示', () => {
    const store = newConsole()
    store.setTurn(18)
    expect(store.checkVictoryNow('turnEnd')).toBe(false)
    expect(store.victoryError).toMatchObject({ rule: '5.0a' })
  })

  it('5.0a：末回合 + 苏控两城与 ≥7 所列格 ⇒ 苏军胜', () => {
    const store = newConsole()
    store.setTurn(19)
    assignControl(store, SOVIET_CITIES, 'soviet')
    assignControl(store, LISTED.slice(0, 7), 'soviet')
    expect(store.finalVictory.outcome).toBe('soviet')
    expect(store.checkVictoryNow('turnEnd')).toBe(true)
  })

  it('5.0a：末回合但双方都不达标 ⇒ Draw', () => {
    const store = newConsole()
    store.setTurn(19)
    /*
     * ★ B17-1 之后构造 Draw 要**真的夺走**：控制账本开局按战线播种（剧本 1 全属苏军），
     * 所以"什么都不指定"不再等于"没人控制"。这一步把苏方的两个城市与 4 个所列格判给轴方：
     *   · 苏方：缺 Vyazma / Rzhev，且所列格 11−4 = 7 ⇒ 城市条件不成立 ⇒ 未达成；
     *   · 轴方：五城未全控、所列格只有 4 ⇒ 未达成 ⇒ Draw。
     */
    assignControl(store, SOVIET_CITIES, 'axis')
    assignControl(store, LISTED.slice(0, 4), 'axis')
    expect(store.finalVictory.outcome).toBe('draw')
    expect(store.checkVictoryNow('turnEnd')).toBe(true)
    expect(store.victoryError).toBeNull()
  })

  it('5.0a：五城缺一格（Vitebsk 只控 19.27）⇒ 轴方条件不成立', () => {
    const store = newConsole()
    store.setTurn(19)
    const partial = AXIS_CITIES.filter((hex) => !(hex.col === 19 && hex.row === 28))
    assignControl(store, partial, 'axis')
    assignControl(store, LISTED.slice(0, 8), 'axis')
    expect(store.victorySummary.axisCitiesAllHeld).toBe(false)
    expect(store.finalVictory.outcome).toBe('draw')
  })

  it('5.0a：五城全部格 + 6 所列格 ⇒ 轴心胜', () => {
    const store = newConsole()
    store.setTurn(19)
    assignControl(store, AXIS_CITIES, 'axis')
    assignControl(store, LISTED.slice(0, 6), 'axis')
    expect(store.finalVictory.outcome).toBe('axis')
  })
})

describe('W6 B20：5.0b 提前决胜（任一回合开始、19 August 起）', () => {
  it('5.0b：19 August 之前不做检查 ⇒ 拒', () => {
    const store = newConsole()
    store.setTurn(TURN_15_AUG)
    assignControl(store, SOVIET_CITIES, 'soviet')
    assignControl(store, LISTED.slice(0, 9), 'soviet')
    expect(store.decisiveVictory.outcome).toBe('ongoing')
    expect(store.checkVictoryNow('turnStart')).toBe(false)
  })

  it('5.0b：19 August 起苏控两城 + ≥9 所列格 ⇒ 苏军达成 Decisive', () => {
    const store = newConsole()
    store.setTurn(TURN_19_AUG)
    assignControl(store, SOVIET_CITIES, 'soviet')
    assignControl(store, LISTED.slice(0, 9), 'soviet')
    expect(store.decisiveVictory.outcome).toBe('soviet')
    expect(store.checkVictoryNow('turnStart')).toBe(true)
  })

  it('5.0b：19 August 起但苏只有 8 所列格 ⇒ 未达成（游戏继续）', () => {
    const store = newConsole()
    store.setTurn(TURN_19_AUG)
    assignControl(store, SOVIET_CITIES, 'soviet')
    // B17-1：开局账本已按战线播种（苏军 11 格）⇒ 要让"苏只有 8 格"，得把 3 格判给轴方
    assignControl(store, LISTED.slice(0, 3), 'axis')
    expect(store.victorySummary.listedBySide.soviet).toBe(LISTED.length - 3)
    expect(store.decisiveVictory.outcome).toBe('ongoing')
    expect(store.checkVictoryNow('turnStart')).toBe(false)
  })

  it('5.0b：剧本 2 属 5.0a 明文例外 ⇒ 无提前决胜档（阈值 null）', () => {
    const store = newConsole()
    store.setScenarioId('2')
    store.setTurn(TURN_19_AUG)
    expect(store.decisiveVictory.thresholds).toBeNull()
    expect(store.decisiveVictory.outcome).toBe('ongoing')
  })
})

describe('W6 B20：重置与剧本切换', () => {
  it('重置局 ⇒ 控制账本与控制错误一并清空', () => {
    const store = newConsole()
    store.setVictoryControlNow(label(LISTED[0]!), 'axis')
    store.resetAll()
    expect(store.victoryLastControl).toEqual({})
    expect(store.victoryError).toBeNull()
  })

  it('5.0c：胜利条件涉及格数（11 所列格 + 五城 7 格 + 两城 2 格，无重叠）', () => {
    const store = newConsole()
    expect(store.victoryHexes.length).toBe(20)
  })
})
