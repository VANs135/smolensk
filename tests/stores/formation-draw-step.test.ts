import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { scenarios } from '@/data'
import {
  ACTION_KEYS_WITHOUT_STORE_ENTRY,
  actionGateOf,
  useContainersStore,
  useSetupStore,
  useWorkbenchStore,
  type ConsolePhase,
} from '@/stores'

/**
 * 批 E 切片 2（用户 9.17③a）：**编队抽签补 store 入口 ＋ 抽签结果回写初设**
 *
 * 病灶（方案族⑥原文）：「剧本特殊规则抽取的轴心编队，其变化**没自动列入初设**」——
 *   ① `rein.formationDraw` 这个 SOP 环节**没有任何 store 入口**（`ACTION_KEYS_WITHOUT_STORE_ENTRY` 挂着它，
 *     `sop-segments.ts` 里标 `implemented: false`），走到 B 段「编队抽取（轴方）」时玩家点不动东西；
 *   ② ch10 的 A 组要求「抽中的师沿道路向**所列位置**西移三格」，而那个位置印在**剧本卡**上、数据里没有
 *     ⇒ 需要玩家点地图给出；**修前面板没有这个输入** ⇒ 引擎按 `shiftWestDestinationMissing` 拒，
 *     A 组**永远落不了盘**；
 *   ③ 落盘只改盘面（Mtr→死亡堆 / Aufk 返场 / Move Mode），**初设那边看不见变化**。
 *
 * ## 测法边界（如实交代）
 *   · 用**真实剧本数据**（`scenarios.json` 的 groups 与池）与真实 store；抽签名额由 `rng` 定 ⇒ 只断言
 *     "抽中数＝剧本页给的名额"与"落盘结果进了台账"，不写死抽中哪个师；
 *   · **不覆盖**"师原地西移 3 格的盘面平移"：数据里没有"所列位置"的**逐格落点**（原文在剧本卡上），
 *     本切片把落点**收进台账并在初设侧显示**；把整师按队形平移属新增几何判据（含 4.8a 堆叠上限），
 *     登记为后续项（见回执的如实边界）；
 *   · 组件渲染无测试（本仓库不挂）⇒ "面板真的画出了落点按钮与回写行"由源码守卫承担。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return {
    containers: useContainersStore(),
    setup: useSetupStore(),
    workbench: useWorkbenchStore(),
  }
}

/** 剧本 1 的 A 组（ch10：抽 4 个师沿道路西移 3 格） */
const scenarioOneGroups = () =>
  scenarios.scenarios.find((item) => item.id === '1')?.setup.formationDraw?.groups ?? []

/** B8：把 store 放到本段里允许做该动作的那个环节 */
function goToStep(
  store: ReturnType<typeof newStores>['workbench'],
  key: 'rein.formationDraw',
): void {
  const allowed = actionGateOf(key)
    .where.filter((item) => item.phase === store.phase)
    .map((item) => item.segment)
  const index = store.playerSegmentSteps.findIndex((step) => allowed.includes(step.id))
  expect(index).toBeGreaterThanOrEqual(0)
  expect(store.setSegmentStepIndex(index)).toBe(true)
}

describe('批 E 切片 2：编队抽签入口与回写初设', () => {
  let stores: ReturnType<typeof newStores>

  beforeEach(() => {
    stores = newStores()
  })

  it('★ 入口已接线：`rein.formationDraw` 不在"无 store 入口"名单里，且 SOP 该步标记为已实现', () => {
    expect(ACTION_KEYS_WITHOUT_STORE_ENTRY).not.toContain('rein.formationDraw')
    const segments = readFileSync('src/engine/rules/sop-segments.ts', 'utf8')
    expect(segments).toContain('containers.drawAndApplyStepNow()')
    /*
     * `★实现缺口` 现在**只剩一处**（`reinforcement.specialRepl`，专规 1.6c —— 另一个登记在案的缺口）；
     * 修前是两处（编队抽取也在其中）。
     */
    expect((segments.match(/★实现缺口/g) ?? []).length).toBe(1)
    // 面板层：抽签入口与"西移落点"点地图按钮都在
    const panel = readFileSync('src/components/containers/ContainersPanel.vue', 'utf8')
    expect(panel).toContain('containers.beginDrawShiftHexPickNow(formation)')
    expect(panel).toContain('containers.formationDrawOutcomes')
  })

  it('★ 剧本 1 的 A 组**能落盘**（修前缺"西移落点"必被引擎拒）', () => {
    const group = scenarioOneGroups().find((item) => item.kind === 'shiftWest')!
    expect(group.count).toBe(4)

    // 先抽签（名额＝剧本页给的 4；抽中谁由 rng 定，不写死）
    const drawn = stores.containers.drawFormations(group)
    expect(drawn).toHaveLength(group.count)

    // ① 没有落点时：引擎按 ch10 拒（这就是修前 A 组的下场）
    const facts = Object.fromEntries(drawn.map((id) => [id, {}]))
    expect(stores.containers.applyDraw(group, facts)).toBe(false)
    expect(stores.containers.lastAction?.detail).toBe('shiftWestDestinationMissing:' + drawn[0])

    // ② 逐编队「点地图选落点」⇒ 写回该编队的落点
    for (const id of drawn) {
      stores.containers.beginDrawShiftHexPickNow(id)
      expect(stores.workbench.hexPickView).toMatchObject({ rule: 'ch10 Formation Chit Draw' })
      expect(stores.workbench.pickHexFor({ col: 9, row: 1 })).toBe(true)
      expect(stores.containers.drawShiftHexOf(id)).toBe('9.1')
    }
    // ③ 有落点 ⇒ 落盘通过，落点进台账
    expect(stores.containers.applyDraw(group, facts)).toBe(true)

    const outcome = stores.containers.formationDrawOutcomes.find(
      (row) => row.groupKind === 'shiftWest',
    )
    expect(outcome?.formationIds).toEqual(drawn)
    expect(outcome?.destinations.map((item) => item.hexText)).toEqual(drawn.map(() => '9.1'))
  })

  it('★ 回写初设：落盘后 `setup.formationDrawNotes` 如实列出（抽中谁 / 处置 / 落点）', () => {
    const group = scenarioOneGroups().find((item) => item.kind === 'shiftWest')!
    const drawn = stores.containers.drawFormations(group)
    for (const id of drawn) {
      stores.containers.beginDrawShiftHexPickNow(id)
      stores.workbench.pickHexFor({ col: 9, row: 1 })
    }
    expect(
      stores.containers.applyDraw(group, Object.fromEntries(drawn.map((id) => [id, {}]))),
    ).toBe(true)

    const notes = stores.setup.formationDrawNotes
    expect(notes).toHaveLength(1)
    expect(notes[0]?.groupLabel).toBe(group.label)
    expect(notes[0]?.formations).toEqual(drawn)
    expect(notes[0]?.destinations).toEqual(drawn.map((id) => `${id} → 9.1`))
  })

  it('★ B 段入口：`drawAndApplyStepNow` 只在「编队抽取」环节放行（闸门照 ACTION_GATES）', () => {
    const group = scenarioOneGroups().find((item) => item.kind === 'shiftWest')!

    // ① 不在 B 段（初始是 Pre-Turn）⇒ 被闸门拒，不落盘
    expect(
      stores.containers.drawAndApplyStepNow(
        group,
        Object.fromEntries(
          (stores.containers.scenarioDrawBox?.pool ?? []).map((item) => [item.formationId, {}]),
        ),
      ),
    ).toBe(false)
    expect(stores.containers.drawnOf(group)).toEqual([])

    // ② 切到 B 段并进「编队抽取」环节 ⇒ 一次动作完成"抽签 + 落盘"
    stores.workbench.setPhase('reinforcement' as ConsolePhase)
    goToStep(stores.workbench, 'rein.formationDraw')
    // 先给本组所有可能抽中的编队都备一个落点（抽中谁由 rng 定 ⇒ 逐个备齐）
    const pool = stores.containers.scenarioDrawBox?.pool.map((item) => item.formationId) ?? []
    expect(pool.length).toBeGreaterThan(0)
    for (const id of pool) {
      stores.containers.beginDrawShiftHexPickNow(id)
      stores.workbench.pickHexFor({ col: 9, row: 1 })
    }
    /*
     * 组成事实按**整个池**备齐（抽中谁由 rng 定 ⇒ 不能只给某一个）：
     * 本组是 shiftWest ⇒ 只需落点（`drawShiftHexText` 已逐个备好），组成留空即可
     * （engine 只对"用得到的项"要求在场：`drawCompositionFactsMissing` 是按抽中名单查的）。
     */
    /*
     * 组成事实按**整个池**备齐（抽中谁由 rng 定 ⇒ 不能只给某一个）：
     * 本组是 shiftWest ⇒ 只需落点（`drawShiftHexText` 已逐个备好），组成留空即可
     * （engine 只对"用得到的项"要求在场：`drawCompositionFactsMissing` 是按抽中名单查的）。
     */
    expect(
      stores.containers.drawAndApplyStepNow(group, Object.fromEntries(pool.map((id) => [id, {}]))),
    ).toBe(true)
    expect(stores.containers.drawnOf(group)).toHaveLength(group.count)
    expect(
      stores.containers.formationDrawOutcomes.some((row) => row.groupKind === 'shiftWest'),
    ).toBe(true)
  })
})
