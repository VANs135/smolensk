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
    // 40.31（Zharkovskiy）在剧本 3 的 Soviet 初设栏（29th Army HQ 等）⇒ 用它检验"手改被重播种覆盖"
    const sovietHeld = { col: 40, row: 31 }
    store.setVictoryControlNow(label(sovietHeld), 'axis')
    expect(store.victoryLastControl[label(sovietHeld)]).toBe('axis')
    store.setScenarioId('3')
    // 换剧本 ⇒ 按新剧本的战线重播种（手改的那一笔不再保留）
    expect(Object.keys(store.victoryLastControl).length).toBeGreaterThan(0)
    expect(store.victoryLastControl[label(sovietHeld)]).toBe('soviet')
    // 剧本 3 的战线有"开局属德军"的格 ⇒ 账本里应当出现轴方（数据驱动，不写死格号）
    expect(Object.values(store.victoryLastControl)).toContain('axis')
  })
})

/**
 * 5.0c 开局归属：逐剧本对照**剧本页初设栏**（Axis Set-Up Information）与导言
 *
 * 判据（原文）：
 *  - 剧本 1/2（8 Jul 41）：Axis 栏 `2.02: 1 Cav Div … Level 2 Airbase …`（Bobruysk）；
 *    五城其余格由苏军初设占据（15.10/18.18/19.27/19.28/34.17/34.18 均列在 Soviet 栏）。
 *  - 剧本 3/4（22 Jul 41）：Axis 栏 `34.17: 46th Mtr Corps HQ …` 与
 *    `2.18, 23.20, and 34.18 (each): Level 1 Airbase` ⇒ Smolensk 两格均属轴方；
 *    15.10（Mogilev）仍在 Soviet 栏 `110 Inf Div`。
 *  - 剧本 5/6（8 Aug 41）：导言「the Soviets still in control of seven objective hexes」，
 *    Axis 栏占 36.13/37.24/38.05/43.14 四格 ⇒ 其余七个所列格属苏方；
 *    五城格见 Axis 栏 2.02/15.10/18.18/19.28/34.17/34.18 与 Vitebsk 19.27（同城 19.28 轴方）。
 *  - 剧本 7（26 Aug 41）：导言「recapture an objective hex」⇒ 苏方持六个所列格，已在剧本数据显式列出。
 *  - 剧本 2/4/6 与 1/3/5 共用初设（`inherits`），故开局归属同母剧本。
 */
describe('5.0c：各剧本胜利格的开局归属与剧本页初设栏一致', () => {
  const CASES: readonly {
    id: string
    axis: readonly string[]
    soviet: readonly string[]
  }[] = [
    {
      id: '1',
      axis: ['2.2'],
      soviet: ['15.10', '18.18', '19.27', '19.28', '34.17', '34.18', '36.13', '37.24', '38.5'],
    },
    {
      id: '2',
      axis: ['2.2'],
      // 27.05 Krichev / 32.25 Demidov 属剧本 2/4 专属清单；当前控制账本只覆盖
      // allVictoryConditionHexes（通用清单 + 城市），未纳入这两格（见本轮核对报告）。
      soviet: ['19.27', '19.28', '34.17', '34.18'],
    },
    {
      id: '3',
      axis: ['2.2', '18.18', '19.27', '19.28', '34.17', '34.18', '36.13', '37.24', '43.14'],
      soviet: ['15.10', '38.5', '40.31', '41.21', '46.17', '46.20', '46.29', '48.25', '52.9'],
    },
    {
      id: '4',
      axis: ['2.2', '18.18', '19.27', '19.28', '34.17', '34.18', '36.13', '37.24', '43.14'],
      // 27.05 Krichev / 32.25 Demidov 属剧本 2/4 专属清单；当前控制账本未覆盖（见本轮核对报告）。
      soviet: ['15.10', '38.5', '40.31', '41.21', '46.17', '46.20', '46.29'],
    },
    {
      id: '5',
      axis: [
        '2.2',
        '15.10',
        '18.18',
        '19.27',
        '19.28',
        '34.17',
        '34.18',
        '36.13',
        '37.24',
        '38.5',
        '43.14',
      ],
      soviet: ['40.31', '41.21', '46.17', '46.20', '46.29', '48.25', '52.9'],
    },
    {
      id: '6',
      axis: [
        '2.2',
        '15.10',
        '18.18',
        '19.27',
        '19.28',
        '34.17',
        '34.18',
        '36.13',
        '37.24',
        '38.5',
        '43.14',
      ],
      soviet: ['40.31', '41.21', '46.17', '46.20', '46.29', '48.25', '52.9'],
    },
    {
      id: '7',
      axis: [
        '2.2',
        '15.10',
        '18.18',
        '19.27',
        '19.28',
        '34.17',
        '34.18',
        '36.13',
        '37.24',
        '38.5',
        '41.21',
        '43.14',
      ],
      soviet: ['40.31', '46.17', '46.20', '46.29', '48.25', '52.9'],
    },
  ]

  for (const testCase of CASES) {
    it(`剧本 ${testCase.id}：轴方格 / 苏方格与初设栏逐格一致`, () => {
      const store = newConsole()
      store.setScenarioId(testCase.id)
      for (const key of testCase.axis) {
        expect(store.victoryLastControl[key], `${key} 应属轴方`).toBe('axis')
      }
      for (const key of testCase.soviet) {
        expect(store.victoryLastControl[key], `${key} 应属苏方`).toBe('soviet')
      }
    })
  }
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
