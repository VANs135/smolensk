import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { mapLayers, scenarios } from '@/data'
import type { HexRef } from '@/data'
import { STACKING_LIMIT_RE } from '@/engine/rules'
import { toConsoleUnit, unitChoices, useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 待审批⑭/⑮/⑯ 的**预置用例**（沿用 3.3d 的做法：先写期望、不实现语义）
 *
 * | 编号 | 条款 | 期望 | 现状 |
 * | --- | --- | --- | --- |
 * | ⑭ | IV-F / IV-I | 初设放置拒绝超堆叠、拒绝不可进入格 | 引擎 `planSetupPlacement` 已支持 `existingRe`/`canEnter`，但 `stores/setup.ts#factsFor` 只注入 HQ/机场格 ⇒ 初设路径不校验 |
 * | ⑮ | IV-J | 初设新建单位一律未加注燃料 | **已覆盖**：`toConsoleUnit` 默认 `fuelled: false`（12.5a，2026-09-16 用户裁定）⇒ 本文件用活动用例锁住该行为，不再作为待批项 |
 * | ⑯ | 剧本 1 首回合 | 苏方地面单位以 1/2 MA 移动 | 数据 `setupInfo.sovietFirstTurnHalfMa` 有字符串，运行期无读取方；**取整方向原文未写明** ⇒ `it.skip` 留待口径裁定 |
 *
 * 启用前置：⑭ 需先接线 `factsFor`；⑯ 需先定取整方向。均见
 * `docs/2026-11-05-待审批事项汇总.md`。
 */

const newStores = () => {
  setActivePinia(createPinia())
  return { setup: useSetupStore(), workbench: useWorkbenchStore() }
}

/** 地图上首个沼泽格（TEC：track/truck 为 P，leg 可进） */
const SWAMP_HEX: HexRef | null = (() => {
  const found = mapLayers.hexes.find((hex) => /swamp/i.test(hex.terrain))
  return found === undefined ? null : { col: found.col, row: found.row }
})()

/** 某条自由项的候选格中，第一个指定地形 */
function candidateOfTerrain(
  setup: ReturnType<typeof newStores>['setup'],
  pattern: RegExp,
): { index: number; hex: HexRef } | null {
  for (const entry of setup.selfChoiceEntries) {
    const hex = setup
      .candidatesOf(entry.index)
      .find((item) =>
        pattern.test(
          mapLayers.hexes.find((h) => h.col === item.col && h.row === item.row)?.terrain ?? '',
        ),
      )
    if (hex !== undefined) return { index: entry.index, hex }
  }
  return null
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('⑮ IV-J：初设/增援新建单位一律未加注燃料（已覆盖，锁行为）', () => {
  it('新建算子默认 fuelled=false（12.5a）', () => {
    const record = unitChoices('axis')[0]
    if (record === undefined) throw new Error('单位库为空')
    const unit = toConsoleUnit({
      record,
      instanceId: 'iv-j',
      hex: { col: 1, row: 1 },
      side: 'axis',
    })
    expect(unit.fuelled).toBe(false)
  })
})

describe.skip('待审批⑭：IV-F / IV-I 接线后的期望（审批后启用）', () => {
  it('IV-F：目标格已有满堆叠 ⇒ 拒绝放置，规则号 IV-F', () => {
    const { setup, workbench } = newStores()
    setup.selectScenario('1')
    const entry = setup.selfChoiceEntries.find(
      (item) => item.side === 'axis' && item.kind === 'unit',
    )
    if (entry === undefined) throw new Error('剧本 1 没有可自由放置的轴方单位条目')
    const target = setup.candidatesOf(entry.index)[0]
    if (target === undefined) throw new Error('该条目没有候选格')

    const record = unitChoices('axis')[0]!
    const blocker = toConsoleUnit({ record, instanceId: 'blk', hex: target, side: 'axis' })
    blocker.re = STACKING_LIMIT_RE
    workbench.units.push(blocker)

    expect(setup.placeSelfEntry(entry.index, target)).toBe(false)
    expect(setup.lastAction?.rule).toBe('IV-F')
  })

  it('IV-I：目标格为沼泽（truck 禁入）⇒ 拒绝放置，规则号 IV-I', () => {
    if (SWAMP_HEX === null) throw new Error('地图上没有沼泽格，无法构成 IV-I 用例')
    const { setup } = newStores()
    setup.selectScenario('1')
    const hit = candidateOfTerrain(setup, /swamp/i)
    if (hit === null) throw new Error('没有自由项的候选范围覆盖沼泽格')

    expect(setup.placeSelfEntry(hit.index, hit.hex)).toBe(false)
    expect(setup.lastAction?.rule).toBe('IV-I')
  })
})

describe.skip('待审批⑯：苏方首回合 1/2 MA（口径待裁定）', () => {
  it.skip('口径待裁定：原文未写明 1/2 MA 的取整方向（A 向下 / B 向上 / C 保留小数）', () => {
    // 启用前须先裁定取整方向；本用例故意留空，避免把猜测写成期望。
  })
})

/** 数据存在性（活动用例）：剧本 1 确实写了这条专规，避免"字段没了没人发现" */
describe('⑯ 数据存在性（不涉及取整口径）', () => {
  it('剧本 1 带有苏方首回合 1/2 MA 的原文', () => {
    expect(scenarios.scenarios[0]?.sovietFirstTurnHalfMa).toMatch(/1\/2/)
  })
})
