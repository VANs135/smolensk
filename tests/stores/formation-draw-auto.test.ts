import { readFileSync } from 'node:fs'

import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { scenarioSetup, scenarios } from '@/data'
import { deriveDrawComposition } from '@/engine/rules'
import { useContainersStore, useGameSessionStore, useSetupStore, useWorkbenchStore } from '@/stores'

import type { Workbench } from '../flows/sop-harness'

/**
 * I②（用户 2026-09-18 报告第 5 条）：**编队抽取真正可用** —— 组成自动推、死亡堆交互自动做
 *
 * 用户原话：「剧本特殊规则中的编队抽取**还是没有实现**，与死亡堆有关的交互应该是**自动抽取**后
 *   **放入死亡堆**或者**与死亡堆里的单位交换**，应该调整位置的编队应该**放入初设**里让玩家设置位置」。
 *
 * 原文（专规 ch10/ch11 的抽取块，`scenarios.json.setup.formationDraw` 原样保留）：
 *   · 剧本 1/2：12 枚编队标记入杯、抽 4 **沿道路西移 3 格**；另 4 **以摩托化团换死亡堆中的侦察营**
 *     （「Mtr 进入死亡堆、Aufk 返场」）；
 *   · 剧本 3/4：抽 5 个师**全部战斗单位以 Move Mode 初设**；另 5 个做同样的 Mtr↔Aufk 互换；
 *   · 剧本 5/6：抽 5 个师的 **Krd 营**直接加入死亡堆；另 7 个师的 **Aufk 营**加入死亡堆。
 *
 * 病灶：`planScenarioDraw` 的组成事实（哪个单位是该师的 Mtr / Aufk / Krd）被当成**数据缺口**，
 *   要求**调用方注入** —— 面板于是让**玩家手输 unit id**（`ContainersPanel.applyDrawNow` 把文本按
 *   `mtr, aufk, krd` 顺序切）。玩家不可能知道这些 id ⇒ 抽签落盘必被 `swapUnitsMissing` /
 *   `moveModeUnitIdsMissing` 拒（＝用户说的"没有实现"）。返场落点还**写死** `1.03`。
 *
 * 改法（本文件钉住）：
 *   ① 组成从 `scenario-setup.json` 的**初设行**自动推（引擎 `deriveDrawComposition`：每个下属直接带
 *      单位库 `unitId` 与落点）⇒「抽签 → 落盘」一步到位，玩家不需要知道任何 id；
 *   ② 死亡堆交互（Mtr 进 / Aufk 返）**自动执行**，返场落点＝该编队初设行里的图上格号（不再写死）；
 *   ③ 缺项（例如死亡堆里没有该师的 Aufk）**不猜**：如实拒并说明。
 */

/** 走到 B 段「编队抽取」环节（轴方；`rein.formationDraw` 的闸门在该环节） */
function goToDrawStep(workbench: Workbench): void {
  workbench.setPhase('reinforcement')
  workbench.setActiveSide('axis')
  const index = workbench.playerSegmentSteps.findIndex(
    (step) => step.id === 'reinforcement.formationDraw',
  )
  if (index < 0) throw new Error('B 段没有「编队抽取」环节')
  if (!workbench.setSegmentStepIndex(index)) throw new Error('进入编队抽取环节失败')
}

function boot(scenarioId: string) {
  setActivePinia(createPinia())
  const game = useGameSessionStore()
  const workbench = useWorkbenchStore()
  const containers = useContainersStore()
  const setup = useSetupStore()
  game.setScenarioId(scenarioId)
  containers.setScenario(scenarioId)
  // 真实盘面：抽签要改的是**盘上**的单位与死亡堆（先按该剧本落一次初设）
  setup.selectScenario(scenarioId)
  return { workbench, containers }
}

describe('I②：编队组成的自动推导（12.5 之外的 ch10/ch11 抽取）', () => {
  it('★ 引擎：剧本 1 的 `3 Pz Div` ⇒ Mtr＝同号摩托化团、Aufk＝**死亡堆里**那一个、落点＝初设格号', () => {
    const rows = scenarioSetup.entries.filter((entry) => entry.scenarioId === '1')
    const outcome = deriveDrawComposition({ rows, formationId: '3 Pz Div' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const data = outcome.data
    // ch10 的 B 组互换要的是"图上那个摩托化团"与"**开局在死亡堆里的** Aufk 营"
    expect(data.mtrRegimentUnitId).toBe('ax-armor_pz-ge-3-pz-3-mot-inf')
    expect(data.aufkBattalionUnitId).toBe('ax-armor_pz-ge-3-pz-1-arm-rec')
    expect(data.deadPileUnitIds).toContain('ax-armor_pz-ge-3-pz-1-arm-rec')
    expect(data.deadPileUnitIds).not.toContain('ax-armor_pz-ge-3-pz-3-mot-inf')
    // 图上落点＝初设行的固定格号（`11.03`）—— 返场/西移的参照
    expect(data.anchorHex).toEqual({ col: 11, row: 3 })
    expect(data.note).toContain('Mtr')
  })

  it('★ 引擎：找不齐就**不猜**（未知编队 ⇒ 拒；返回原因码）', () => {
    const rows = scenarioSetup.entries.filter((entry) => entry.scenarioId === '1')
    const outcome = deriveDrawComposition({ rows, formationId: '99 Pz Div' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('formationNotFoundInSetup')
  })

  it('★ 入杯池与初设行**对得上**（每个池成员的组成都推得出来，且至少一个 Mtr 候选）', () => {
    const rows = scenarioSetup.entries.filter((entry) => entry.scenarioId === '1')
    const pool =
      scenarios.scenarios.find((item) => item.id === '1')?.setup.formationDraw?.groups ?? []
    expect(pool.length).toBeGreaterThan(0)
    const poolIds = rows
      .filter((entry) => entry.kind === 'formation' && String(entry.unitId).endsWith('Pz Div'))
      .map((entry) => String(entry.unitId))
    expect(poolIds.length).toBeGreaterThan(0)
    for (const formationId of poolIds) {
      const outcome = deriveDrawComposition({ rows, formationId })
      expect(outcome.ok, `${formationId} 的组成推不出来`).toBe(true)
      if (!outcome.ok) continue
      expect(outcome.data.mtrRegimentUnitId, `${formationId} 没有可用的摩托化团`).not.toBeNull()
    }
  })
})

describe('I②：抽签落盘是**自动**的（不再手输 unit id）', () => {
  it('★ 剧本 1（ch10）B 组：抽签 ⇒ Mtr 进死亡堆、Aufk 返场到该师的初设格（不是写死的 1.03）', () => {
    const { workbench, containers } = boot('1')
    goToDrawStep(workbench)
    const group = (
      scenarios.scenarios.find((item) => item.id === '1')?.setup.formationDraw?.groups ?? []
    ).find((item) => item.kind === 'mtrAufkSwap')
    expect(group, '剧本 1 应有 mtrAufkSwap 组').toBeDefined()
    const drawn = containers.drawFormations(group!)
    expect(drawn.length).toBe(group!.count)
    // 每一抽中师的组成都必须推得出来（自动抽取的前提）
    for (const formationId of drawn) {
      const derived = deriveDrawComposition({
        rows: scenarioSetup.entries.filter((entry) => entry.scenarioId === '1'),
        formationId,
      })
      expect(derived.ok, `${formationId} 组成缺失 ⇒ 该组按数据落不了盘`).toBe(true)
    }

    // 落盘：**不给任何 facts**（修前这一步必被拒）
    expect(containers.applyDraw(group!, {})).toBe(true)

    // 死亡堆里：每个抽中师的 Mtr 团都在；返场的 Aufk 已离开死亡堆
    // ★ 盘上实例 id 由 `createId` 生成 ⇒ 一律按**库 id**（`unitId`）比对
    const rows = scenarioSetup.entries.filter((entry) => entry.scenarioId === '1')
    for (const formationId of drawn) {
      const derived = deriveDrawComposition({ rows, formationId })
      if (!derived.ok) continue
      const mtr = derived.data.mtrRegimentUnitId!
      const aufk = derived.data.aufkBattalionUnitId!
      expect(
        workbench.units.some((unit) => unit.unitId === mtr),
        `${formationId} 的 Mtr（${mtr}）不该还在图上`,
      ).toBe(false)
      expect(
        workbench.deadPile.some((entry) => !('aircraftId' in entry) && entry.unitId === mtr),
        `${formationId} 的 Mtr（${mtr}）应在死亡堆`,
      ).toBe(true)
      const returned = workbench.units.find((unit) => unit.unitId === aufk)
      expect(returned, `${formationId} 的 Aufk（${aufk}）应已返场`).toBeDefined()
      // 返场落点＝该师初设行的图上格号（`11.03` 一类），**不是**写死的 `1.03`
      expect(returned!.hex.col * 100 + returned!.hex.row).toBe(
        derived.data.anchorHex!.col * 100 + derived.data.anchorHex!.row,
      )
    }
  })

  it('★ 自动落盘写进台账（初设那边读它），且日志交代"组成自动推"', () => {
    const { workbench, containers } = boot('1')
    goToDrawStep(workbench)
    const group = (
      scenarios.scenarios.find((item) => item.id === '1')?.setup.formationDraw?.groups ?? []
    ).find((item) => item.kind === 'mtrAufkSwap')!
    containers.drawFormations(group)
    expect(containers.applyDraw(group, {})).toBe(true)
    const outcome = containers.formationDrawOutcomes.find((row) => row.groupKind === 'mtrAufkSwap')
    expect(outcome, '落盘后应有台账').toBeDefined()
    expect(outcome!.formationIds.length).toBe(group.count)
    expect(workbench.log.map((entry) => entry.text).join('\n')).toContain('编队组成（自动推）')
  })

  it('★ 剧本 5（ch11）A 组：抽中师的 Krd 营自动加入死亡堆（无 facts 也落得下）', () => {
    const { workbench, containers } = boot('5')
    goToDrawStep(workbench)
    const group = (
      scenarios.scenarios.find((item) => item.id === '5')?.setup.formationDraw?.groups ?? []
    ).find((item) => item.kind === 'deadPileKrd')
    expect(group, '剧本 5 应有 deadPileKrd 组').toBeDefined()
    const drawn = containers.drawFormations(group!)
    if (drawn.length === 0) return // 该剧本池为空时如实跳过（入杯名单由数据推）
    expect(containers.applyDraw(group!, {})).toBe(true)
    const rows = scenarioSetup.entries.filter((entry) => entry.scenarioId === '5')
    let checked = 0
    for (const formationId of drawn) {
      const derived = deriveDrawComposition({ rows, formationId })
      if (!derived.ok || derived.data.krdBattalionUnitId === null) continue
      checked += 1
      expect(
        workbench.deadPile.some(
          (entry) => !('aircraftId' in entry) && entry.unitId === derived.data.krdBattalionUnitId,
        ),
        `${formationId} 的 Krd 应进入死亡堆`,
      ).toBe(true)
    }
    expect(checked, '至少应有一枚推得出 Krd 的抽中师').toBeGreaterThan(0)
  })

  it('★ 源码守卫：面板不再要求玩家**手输** unit id（自动推的入口在 store）', () => {
    const panel = readFileSync('src/components/containers/ContainersPanel.vue', 'utf8')
    // 修前：`splitIds(drawFactsText...)` 把玩家输入的文本切成 mtr/aufk/krd
    expect(panel).not.toContain('drawFactsText')
    const store = readFileSync('src/stores/containers.ts', 'utf8')
    expect(store).toContain('deriveFactsFor')
    expect(store).toContain('deriveDrawComposition')
  })
})
