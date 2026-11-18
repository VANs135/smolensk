import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { scenarios } from '@/data'
import {
  useGameSessionStore,
  useHotseatStore,
  useSetupStore,
  useUiStore,
  useWorkbenchStore,
} from '@/stores'

/**
 * B10：前置「剧本 + 共识」视图
 *
 * 用户口径⑨：「可以在进入游戏界面前加一个**剧本选择界面**，选择剧本和共识后点击进入游戏，
 * 进入游戏界面**开始初设**」；「共识开关**默认全不勾**」。
 *
 * 本文件钉四件事：
 *   ① 剧本列表是 `scenarios.json` 的**投影**（不多不少、字段齐）；
 *   ② `enterSetup` 的语义：**换剧本才清盘**，同一剧本再进**不抹掉初设进度**；
 *   ③ 进游戏**不等于开局**（不建会话、不进 Pre-Turn）——开局仍在初设收束的「开始游戏」；
 *   ④ 路由确实注册了（源码守卫：注册表 + 视图里真的 navigate 到 game）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  // 2026-11-09：模式前移到选剧本，进初设前必须先选
  useHotseatStore().setMode('solo')
  return {
    setup: useSetupStore(),
    session: useGameSessionStore(),
    workbench: useWorkbenchStore(),
    ui: useUiStore(),
  }
}

describe('B10：剧本列表是 scenarios.json 的投影', () => {
  it('逐个剧本都在列表里，且带选择器要用的字段（不解释、不改写）', () => {
    setActivePinia(createPinia())
    const setup = useSetupStore()
    const choices = setup.scenarioChoices

    expect(choices).toHaveLength(scenarios.scenarios.length)
    for (const item of scenarios.scenarios) {
      const row = choices.find((choice) => choice.id === item.id)
      expect(row, `剧本 ${item.id} 不在列表里`).toBeDefined()
      expect(row!.name).toBe(item.name)
      expect(row!.turns).toBe(item.turns)
      expect(row!.firstTurn).toBe(item.firstTurn)
      expect(row!.lastTurn).toBe(item.lastTurn)
      expect(row!.firstPlayer).toBe(item.firstPlayer)
      expect(row!.hasSetup).toBe(item.hasSetup === true)
      expect(row!.sharedSetupWith).toEqual(item.sharedSetupWith ?? [])
    }
  })

  it('默认选中项就是会话/初设当前认的那个剧本（选择只有一处口径）', () => {
    setActivePinia(createPinia())
    const setup = useSetupStore()
    const selected = setup.scenarioChoices.filter((choice) => choice.selected)
    expect(selected).toHaveLength(1)
    expect(selected[0]!.id).toBe(setup.scenarioId)
  })
})

describe('B10：进入初设（enterSetup）', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('换剧本 ⇒ 按新剧本重跑自动初设（清盘 + 落固定项）', () => {
    const { setup, workbench } = stores
    const target = scenarios.scenarios.find((item) => item.id !== setup.scenarioId)!

    expect(setup.enterSetup(target.id)).toBe(true)

    expect(setup.scenarioId).toBe(target.id)
    // 盘面已是新剧本的固定初设（自动初设会落一批算子）
    expect(workbench.units.length).toBeGreaterThan(0)
    expect(setup.applied).toBe(true)
  })

  it('★同一剧本再进 ⇒ **不重复清盘**（初设进度不被抹掉）', () => {
    const { setup, workbench } = stores
    // 先按当前剧本加载一次
    expect(setup.enterSetup(setup.scenarioId)).toBe(true)
    const before = workbench.units.length
    expect(before).toBeGreaterThan(0)

    // 玩家在初设里动了一枚（模拟"初设进度"）：把它挪走，再退回前置视图后重新进入
    const moved = workbench.units[0]!
    moved.hex = { col: moved.hex.col, row: moved.hex.row } // 占位：只要求"盘面没被清"
    workbench.units = workbench.units.slice(0, Math.max(1, before - 1))

    expect(setup.enterSetup(setup.scenarioId)).toBe(true)

    // 盘面仍是玩家动过的那一份（没有被自动初设覆盖回全量）
    expect(workbench.units).toHaveLength(Math.max(1, before - 1))
  })

  it('进入初设**不等于开局**：不建会话、不进 Pre-Turn（开局仍在「开始游戏」）', () => {
    const { setup, session } = stores
    const target = scenarios.scenarios[0]!

    expect(setup.enterSetup(target.id)).toBe(true)

    expect(session.session).toBeNull()
    expect(session.records).toBeNull()
    expect(setup.finished).toBe(false)
  })

  it('会话已开局时换剧本被拒（2.2），且**不改动**当前剧本', () => {
    const { setup, session } = stores
    expect(session.startGame()).toBe(true)
    const current = setup.scenarioId
    const other = scenarios.scenarios.find((item) => item.id !== current)!

    expect(setup.enterSetup(other.id)).toBe(false)

    expect(setup.scenarioId).toBe(current)
    expect(setup.lastAction?.ok).toBe(false)
    expect(setup.lastAction?.rule).toBe('2.2')
  })
})

describe('B10：路由接线（源码守卫）', () => {
  const registry = readFileSync('src/views/registry.ts', 'utf8')
  const viewTypes = readFileSync('src/views/types.ts', 'utf8')
  const view = readFileSync('src/views/ScenarioSetupView.vue', 'utf8')

  it('注册表里有 scenario 视图，且 ViewName 联合类型同步扩了', () => {
    expect(registry).toContain("import ScenarioSetupView from './ScenarioSetupView.vue'")
    expect(registry).toContain("name: 'scenario'")
    expect(viewTypes).toContain("'scenario'")
  })

  it('前置视图：先过目标窗，确认后＝进入初设 + `navigate(game)`（不自己建会话）', () => {
    // 用户 2026-11-18 第 1 条：进初设前先弹「任务目标 / 胜利条件」，确认后才进初设
    expect(view).toContain('setup.requestEnterSetup')
    expect(view).toContain('setup.confirmBriefing')
    expect(view).toContain('<ScenarioBriefingDialog')
    expect(view).toContain("ui.navigate('game')")
    /*
     * 它不**调用**开局动作（开局属初设收束时的「开始游戏」）。
     * 断言写成带括号的调用形式：注释里提到 `startGameNow` 是说明性的，不算违规——
     * 守卫要防的是"这里偷偷开局"，不是"文档里提了名字"。
     */
    expect(view).not.toContain('startGameNow(')
    expect(view).not.toContain('session.startGame(')
  })

  it('共识清单复用既有组件（默认全不勾的口径只有一处）', () => {
    expect(view).toContain("import { ConsensusChecklist } from '@/components/hotseat'")
    expect(view).toContain('<ConsensusChecklist />')
  })
})

/**
 * 2026-11-14：960×571 实测裁切
 *
 * 展开「开局共识」后，`.scenario` 只吃 `flex: 1` 且没有 overflow，外层壳把溢出藏掉：
 * 4.3 那条复选框落在视口外，页面滚不到、面板也裁掉 ⇒ 「窄高窗口下每条可选规则都要能点到」不成立。
 * 守卫只钉两件不可回退的事：① 剧本页自己能纵向滚；② 共识条目不进任何固定高度/裁切盒子。
 */
describe('Intro: Vitebsk 的剧本卡（教学/单回合）', () => {
  const view = readFileSync('src/views/ScenarioSetupView.vue', 'utf8')

  it('卡片按剧本数据标「教学 · 单回合」，不写死 Intro 字样', () => {
    expect(view).toContain("import { scenarios } from '@/data'")
    expect(view).toContain('singlePlayerTurn')
    expect(view).toContain('教学 · 单回合')
  })

  it('选中 Intro 时不铺教学摘要；剧本事实仍在数据侧，局面选项照旧', () => {
    // 2026-11-15 口径：玩家已熟知实体规则，窗内不放胜利条件/教学式摘要
    expect(view).not.toContain('两格维捷布斯克')
    expect(view).not.toContain('Minor Victory')
    expect(view).not.toContain('introSummary')
    expect(view).toContain('firstWeather')
  })
})

describe('任务目标 / 胜利条件窗（用户 2026-11-18 第 1 条）', () => {
  const dialog = readFileSync('src/components/setup/ScenarioBriefingDialog.vue', 'utf8')

  it('只有「确定」一个出口，不给「不再显示」之类选项', () => {
    expect(dialog).toContain('确定')
    expect(dialog).not.toContain('不再显示')
    expect(dialog).not.toContain('跳过')
  })

  it('条款号只进 `?`（RuleTip），条目正文不写条款号', () => {
    expect(dialog).toContain('<RuleTip :rule="item.rule" />')
  })
})

describe('960×571：剧本页可滚动、共识条目不裁切（源码守卫）', () => {
  const view = readFileSync('src/views/ScenarioSetupView.vue', 'utf8')
  const checklist = readFileSync('src/components/hotseat/ConsensusChecklist.vue', 'utf8')

  /** 取某个选择器的声明块（到第一个 `}` 为止） */
  const declarations = (css: string, selector: string): string => {
    const start = css.indexOf(`${selector} {`)
    expect(start, `样式里没找到 ${selector}`).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('}', start))
  }

  it('剧本页自身纵向可滚，且能在 flex 列里收缩', () => {
    const base = declarations(view, '.scenario')
    expect(base).toContain('overflow-y: auto')
    expect(base).toContain('min-height: 0')
  })

  it('共识面板与清单没有固定高度、也不裁切溢出', () => {
    expect(view).not.toContain('overflow: hidden')
    expect(declarations(view, '.scenario__sheet')).not.toMatch(/\bheight:\s*\d/)
    const formal = declarations(checklist, '.consensus--formal')
    expect(formal).not.toContain('overflow: hidden')
    expect(formal).not.toMatch(/\bheight:\s*\d/)
    expect(checklist).not.toContain('max-height')
  })
})

describe('教学模式：苏军是人机对手（2026-11-19，源码守卫）', () => {
  const view = readFileSync('src/views/ScenarioSetupView.vue', 'utf8')

  it('勾教学 ⇒ PVE + AI 打苏联，不再固定为单人', () => {
    expect(view).toContain("hotseat.setMode('pve')")
    expect(view).toContain("hotseat.setAiSide('soviet')")
    // 修前两处都写死 solo（苏军由玩家自己点，不能算人机对手）
    expect(view).not.toContain("hotseat.setMode('solo')")
    expect(view).toContain('人机（苏军 AI · 教学固定）')
  })
})
