import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useMapViewStore, useWorkbenchStore, toConsoleUnit, unitChoices } from '@/stores'

/**
 * B17a：**右栏只读化的第一步**（用户决定 ①「右侧栏只读」，方案 §5 验收「右栏无任何可写控件」）
 *
 * 做法与 B15d/B15e 同一套：给面板加 `only` 分段属性——
 *   · **只读信息**留右栏（当日到达清单与落点、1.6a/2.1a 提示、结果摘要、补员账本当前值、计数…）；
 *   · **动作**进**会话框**，由"当前环节属于增援段"触发（环节名本身就说明此刻允许做这些事，
 *     不必再让玩家先点开某个入口）。
 *
 * 本文件钉三件事：
 *   ① **触发**：环节落在 `reinforcement.*` ⇒ 会话出现；换到别的环节 ⇒ 消失；
 *   ② **可收起**：`Esc`/× 收起它（记在环节键上），**换环节自然重现**（不是永久关掉）；
 *   ③ **同屏不出现两套控件**：对局台挂 `only="info"`（右栏）与 `only="actions"`（会话），
 *      验证页仍挂全量那一份（引擎验证页不跟随新交互）。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { workbench: useWorkbenchStore(), mapView: useMapViewStore() }
}

/** 走到增援段的某个环节（不写死序号：从 `playerSegmentSteps` 里找第一个 `reinforcement.` 步） */
function goToReinforcementStep(store: ReturnType<typeof newStores>['workbench']): void {
  store.setPhase('reinforcement')
  const index = store.playerSegmentSteps.findIndex((step) => step.id.startsWith('reinforcement.'))
  if (index < 0) throw new Error('增援段没有玩家环节？')
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('B17a：增援动作进会话框（由环节触发）', () => {
  it('★ 走进增援段某环节 ⇒ 出现「增援与编制」会话；别的环节不出现', () => {
    const { workbench, mapView } = newStores()
    expect(mapView.session).toBeNull()

    goToReinforcementStep(workbench)
    expect(mapView.session).toMatchObject({ kind: 'reinforce' })
    /*
     * ★ B34：增援段**按子环节分成两个窗口** —— 到货落位环节的窗口叫「可下增援单位」，
     *   重建环节的窗口叫「重建与整编」；两者标题都带**环节名**（环节表是唯一出处）。
     */
    const stepLabel = workbench.segmentStep?.label ?? ''
    expect(mapView.session?.title).toContain(stepLabel)

    // 换到别的段（如 C 移动段）⇒ 不再是增援会话
    workbench.setPhase('movement')
    expect(mapView.session?.kind).not.toBe('reinforce')
  })

  it('★ 收起（`Esc`/×）：本次环节内不再出现，**换环节/换回合自然重现**', () => {
    const { workbench, mapView } = newStores()
    goToReinforcementStep(workbench)
    expect(mapView.session?.kind).toBe('reinforce')

    expect(mapView.cancelSession()).toBe(true)
    expect(mapView.session).toBeNull()

    // 换回合 ⇒ 环节键变了 ⇒ 重现（收起只对"这一次"有效）
    workbench.setTurn(workbench.turn + 1)
    goToReinforcementStep(workbench)
    expect(mapView.session?.kind).toBe('reinforce')
  })

  it('会话标题带当前环节名与规则号（环节表是唯一出处）', () => {
    const { workbench, mapView } = newStores()
    goToReinforcementStep(workbench)
    const step = workbench.segmentStep
    expect(step).not.toBeNull()
    expect(mapView.session?.title).toContain(step?.label ?? '')
    expect(mapView.session?.rule).toBe(step?.rule ?? '')
  })
})

/**
 * B34（用户口径 #13）：增援段**按子环节分成两个窗口**
 *
 * 「增援环节要弹出玩家**可下增援单位**的会话窗口，**然后是重建窗口**，
 *   此时地图上可点击可拆分合并的单位」。
 *
 * 判据都出自**环节表**（不在组件里比规则字面量）：
 *   · `reinforcement.arrival`（13.6 / 专规 1.6a）⇒ `kind:'reinforce'`，标题「可下增援单位：<环节名>」；
 *   · `reinforcement.rebuild`（13.5 / 13.9）⇒ `kind:'rebuild'`，标题「重建与整编（<环节名>）」、规则号 13.5 / 13.9。
 */
describe('B34：增援段的两个窗口（按子环节分派）', () => {
  /** 走到增援段里**指定**的子环节（id 精确匹配） */
  function goToStep(store: ReturnType<typeof newStores>['workbench'], id: string): void {
    store.setPhase('reinforcement')
    const index = store.playerSegmentSteps.findIndex((step) => step.id === id)
    if (index < 0) throw new Error('增援段没有环节 ' + id)
    expect(store.setSegmentStepIndex(index)).toBe(true)
  }

  it('★ 到货落位 ⇒ 「可下增援单位」窗；重建 ⇒ 「重建与整编」窗（kind 与规则号都对）', () => {
    const { workbench, mapView } = newStores()

    goToStep(workbench, 'reinforcement.arrival')
    expect(mapView.session).toMatchObject({ kind: 'reinforce' })
    expect(mapView.session?.title).toContain('到货落位')
    expect(mapView.session?.title).toContain(workbench.segmentStep?.label ?? '')

    goToStep(workbench, 'reinforcement.rebuild')
    // R1（条 5）：仍是同一个会话框（kind 不变），只是标题/内容渐变到「重建与整编」
    expect(mapView.session).toMatchObject({ kind: 'reinforce' })
    expect(mapView.session?.title).toContain('重建与整编')
    expect(mapView.session?.rule).toBe(workbench.segmentStep?.rule ?? '')
  })

  it('★ 同一会话框可收起（记在**环节键**上，换环节自然重现）', () => {
    const { workbench, mapView } = newStores()
    goToStep(workbench, 'reinforcement.rebuild')
    expect(mapView.session?.kind).toBe('reinforce')

    expect(mapView.cancelSession()).toBe(true)
    expect(mapView.session).toBeNull()
    // 换到同一个增援段的**另一个**子环节 ⇒ 新环节，窗口照常出现（不是"永久关掉"）
    goToStep(workbench, 'reinforcement.arrival')
    expect(mapView.session?.kind).toBe('reinforce')
  })

  it('★ 接线（源码守卫）：面板有 rebuild 段、视图只挂一个 `reinforce` 会话框（R1 已作废 rebuild 会话种类）', () => {
    const panel = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')
    expect(panel).toContain("'info' | 'actions' | 'rebuild'")
    expect(panel).toContain('showsRebuild')
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    // R1：视图里**不再**有 `kind === 'rebuild'` 这个分支
    expect(game).not.toContain("session.kind === 'rebuild'")
    expect(game).not.toContain('only="rebuild"')
    expect((game.match(/session\.kind === 'reinforce'/gu) ?? []).length).toBeGreaterThanOrEqual(1)
  })
})

describe('B17a：分段渲染与两处入口（源码守卫）', () => {
  it('★ 面板支持 `only` 分段，且默认全渲染（验证页不受影响）', () => {
    const panel = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')
    // ★ B34：props 已加 rebuild 段（增援段的第二个窗口）
    expect(panel).toContain("'info' | 'actions' | 'rebuild'")
    expect(panel).toContain('showsInfo')
    expect(panel).toContain('showsActions')
    expect(panel).toContain('showsRebuild')
    /*
     * 各段"管着哪些动作"按 B34 的新分工核对：
     *   · actions 段（**可下增援单位**窗）：到达投放与强制移除、可变增援、补员账本、方面军预备队；
     *   · rebuild 段（**重建与整编**窗）：重建、拆分（20.0a）、合并（13.9）—— 用户 #13 的第二个窗口。
     */
    const checkGated = (gate: string, markers: readonly string[]): void => {
      for (const marker of markers) {
        const at = panel.indexOf(marker)
        expect(at, `${marker} 应在面板里`).toBeGreaterThan(0)
        const before = panel.lastIndexOf(gate, at)
        expect(before, `${marker} 应由 ${gate} 管着`).toBeGreaterThan(0)
        // 区间内不应先出现 `</template>` 把作用域关掉（粗判：最近的分段标记比最近的闭合更靠后）
        const closed = panel.lastIndexOf('</template>', at)
        expect(before).toBeGreaterThan(closed)
      }
    }
    checkGated('showsActions', [
      'workbench.applyArrivalRemovalsNow()',
      // B21：投放那一行现在点的是 `onPlaceArrival`（它带上"库中型号"选型后交给引擎）
      '@click="onPlaceArrival(index)"',
      'workbench.rollVariableReplNow()',
      'workbench.claimFrontalReservesNow()',
    ])
    checkGated('showsRebuild', [
      'workbench.rebuildUnitNow({',
      'workbench.createBreakdownNow(',
      'workbench.consolidateUnitsNow(',
    ])
  })

  it('★ 对局台：右栏 `only="info"`、会话只挂**一个** `reinforce` 会话框（R1：不再按子环节分两框）；验证页仍挂全量', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    const verify = readFileSync('src/views/WorkbenchView.vue', 'utf8')
    // 右栏只读信息
    expect(game).toContain('<ReinforcementPanel only="info" />')
    // 会话框：增援段全程同一个 `reinforce` 框（不按子环节拆成 arrival/rebuild 两框）
    expect(game).toContain('<ReinforcementPanel v-else-if="session.kind === \'reinforce\'" />')
    // 验证页那一份不带 only（两段都画）
    expect(verify).toMatch(/<ReinforcementPanel\s*\/>/)
  })

  it('会话路由按**环节段**判断（不在组件里比规则字面量）', () => {
    const store = readFileSync('src/stores/map-view.ts', 'utf8')
    expect(store).toContain("stepId.startsWith('reinforcement.')")
    expect(store).toContain("kind: 'reinforce'")
    expect(store).toContain('collapsedSessionKey')
  })
})

/**
 * B21：**对局台不摆算子**，投放自带选型（用户口径 2026-09-16）
 *
 * 「正式游戏界面不应有摆算子的操作，应该完全由流程驱动」
 *
 * 关键风险：13.6 的投放要求指认"用单位库里的哪一枚算子"（工程库未落条目→算子的映射），
 * 而修前这个指认要去**摆算子工具的单位清单**里选 ⇒ 直接删工具会让投放永远找不到算子。
 * 故本文件钉住：①对局台与热键都没有摆算子；②指认入口长在**投放那一行**上。
 */
describe('B21：对局台不摆算子，到达投放自带选型', () => {
  it('★ 对局台没有摆算子工具，也**不再有任何工具按钮**（B35 口径 #10）', () => {
    const game = readFileSync('src/views/GameTableView.vue', 'utf8')
    // 判据落在**代码**上（注释里可以提到"摆算子已删"，那不算残留）
    expect(game).not.toContain("key: 'place'")
    expect(game).not.toContain('pendingRecord')
    expect(game).not.toContain('pickRecord')
    expect(game).not.toContain('gt__place')
    expect(game).not.toContain('choiceOptions')
    /*
     * B35（用户口径 #10「地图窗口上方的移动和战斗按钮在对局界面是不需要的」）：
     * 连 `move` / `battle` 两个按钮也删了 ⇒ 这里从"只留两个"升级为"**一个都没有**"，
     * 判据改由闸门推（`workbench.combatPickActive` ＝ 本环节允许 `combat.declare`）。
     */
    expect(game).not.toContain('TOOL_OPTIONS')
    expect(game).not.toContain('workbench.setTool(')
    const wb = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(wb).toContain('const combatPickActive = computed<boolean>(')
  })

  it('★ 热键里也没有摆算子（`3 / P` 不再被吞）', () => {
    const hotkeys = readFileSync('src/stores/hotkeys.ts', 'utf8')
    expect(hotkeys).not.toContain("'tool.place'")
    expect(hotkeys).not.toContain("case '3'")
    // 自由摆放只在验证页（可见按钮），所以 store 的能力本身保留
    const verify = readFileSync('src/views/WorkbenchView.vue', 'utf8')
    expect(verify).toContain('pickRecord')
  })

  it('★ 到达投放的"库中型号"选型在**那一行**上，并把选型交给引擎', () => {
    const panel = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')
    expect(panel).toContain('arrivalRecordIds')
    expect(panel).toContain('onArrivalRecordPick(index')
    expect(panel).toContain('@click="onPlaceArrival(index)"')
    // 选型真的传下去了（空串 ⇒ undefined，交给引擎按显示名匹配）
    expect(panel).toContain("picked === '' ? undefined : picked")
  })
})

/**
 * B34 余项①：`u1 / k1 / r1` 文本框 → **算子图阵列点选**
 *
 * 用户口径 2026-09-16 #13 的后半句：「此时地图上**可点击可拆分合并的单位**，进行操作」；
 * 与 #9「需要玩家输入格子编号的所有项目全改为点地图」同一条思路 ——
 * 玩家不该手打实例 id（那是引擎验证页的填法）。
 *
 * ★ 一条**测法边界（如实）**：本文件钉的是「投影只列本方」与「投影给出的 id 喂得动既有动作」，
 *   以及面板**源码**上四处已换成阵列。至于"阵列里列了不该列的单位"这件事**故意不筛**：
 *   20.0a 的创建时机、13.9 的"两面完全相同 / 非 DG"都是**引擎在提交时**判的规则条件，
 *   界面提前筛一遍就等于在组件里写了第二份判据（架构闸门不允许，也容易与引擎走散）。
 *   ⇒ 因此**没有**"阵列里只出现合法单位"这类断言：那是引擎用例（本目录其余文件）的地盘。
 */
describe('B34：拆并四处"指认单位"改成点算子图', () => {
  /** 夹具：两枚本方单位（一枚敌方）——`ownUnitsOnMap` 只该列出本方那两枚 */
  function withUnits(store: ReturnType<typeof newStores>['workbench']): void {
    const record = unitChoices('axis')[0]!
    const enemyRecord = unitChoices('soviet')[0]!
    store.units.push(
      toConsoleUnit({ record, instanceId: 'f1', hex: { col: 10, row: 10 }, side: 'axis' }),
      toConsoleUnit({ record, instanceId: 'f2', hex: { col: 11, row: 10 }, side: 'axis' }),
      toConsoleUnit({
        record: enemyRecord,
        instanceId: 'e1',
        hex: { col: 12, row: 10 },
        side: 'soviet',
      }),
    )
  }

  it('★ 投影＝图上**本方**单位（敌方那枚不在候选里；不是"全库单位"）', () => {
    const { workbench } = newStores()
    expect(workbench.ownUnitsOnMap).toEqual([])
    withUnits(workbench)
    expect(workbench.ownUnitsOnMap.map((unit) => unit.instanceId)).toEqual(['f1', 'f2'])
  })

  it('★ 投影给出的 id 喂得动既有动作（拿它去锁定，真的锁上的是那一枚）', () => {
    const { workbench } = newStores()
    withUnits(workbench)
    const picked = workbench.ownUnitsOnMap[1]!.instanceId
    workbench.setUnitLockedNow(picked, true)
    expect(workbench.units.find((unit) => unit.instanceId === picked)?.locked).toBe(true)
    // 没被点的那一枚不受影响（不是"锁了第一枚"）
    expect(workbench.units.find((unit) => unit.instanceId === 'f1')?.locked).toBe(false)
  })

  it('★ 面板四处已是算子图阵列（`u1 / k1 / r1` 手打 id 的输入框全没了）', () => {
    const panel = readFileSync('src/components/reinforcement/ReinforcementPanel.vue', 'utf8')
    for (const dead of ['placeholder="u1"', 'placeholder="k1"', 'placeholder="r1"']) {
      expect(panel).not.toContain(dead)
    }
    // 四处各自绑自己的选中态（母单位 / 保留 / 移除 / 锁定的"母单位"复用同一份）
    expect(panel).toContain(':items="rebuildUnitItems(breakdownParentId)"')
    expect(panel).toContain(':items="rebuildUnitItems(keepId)"')
    expect(panel).toContain(':items="rebuildUnitItems(removeId)"')
    expect(panel.match(/rebuildUnitItems\(/gu)?.length).toBe(4)
    // 候选来自 store 的投影（组件不自己筛单位）
    expect(panel).toContain('workbench.ownUnitsOnMap')
    const store = readFileSync('src/stores/workbench.ts', 'utf8')
    expect(store).toContain('const ownUnitsOnMap = computed<ConsoleUnit[]>')
    // 悬停同步地图高亮（与其余面板同一手感）
    expect(panel).toContain('function hoverUnit(id: string | null): void')
  })
})
