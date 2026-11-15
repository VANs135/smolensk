import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { unitsAxis, unitsSoviet } from '@/data'
import { useSetupStore, useWorkbenchStore } from '@/stores'

/**
 * 13.3g：铁路修理单位的**识别链**（数据 → 初设 → 盘面实例 → store 投影）
 *
 * 背景：补给面板曾显示「本作尚未入库」，验收清单据此把 13.3f 判成 N/A；实际三支单位早已入库。
 * 根因不是判据错，而是面板空态文案过期 + 候选只列盘面实例、且未按当前行动方过滤。
 * 本文件把「数据里到底有没有 / 哪个剧本有 / 落位后能不能认出来」逐层钉住。
 */

const RR_IDS = [
  'su-engineer-west-rr-rgt',
  'ax-engineer-ge-i-2-rr-bn',
  'ax-engineer-ge-ii-2-rr-bn',
] as const

const ALL_RECORDS = [...unitsSoviet.units, ...unitsAxis.units]

function freshStores() {
  setActivePinia(createPinia())
  return { setup: useSetupStore(), workbench: useWorkbenchStore() }
}

describe('13.3g：铁路修理单位识别链', () => {
  let setup: ReturnType<typeof freshStores>['setup']
  let workbench: ReturnType<typeof freshStores>['workbench']

  beforeEach(() => {
    const stores = freshStores()
    setup = stores.setup
    workbench = stores.workbench
  })

  it('数据层：三支 RR 单位都在运行时库，且 specialized 含 rail_repair', () => {
    for (const id of RR_IDS) {
      const record = ALL_RECORDS.find((unit) => unit.id === id)
      expect(record, `运行时库缺少 ${id}`).toBeDefined()
      expect(record?.specialized, `${id} 未带 rail_repair`).toContain('rail_repair')
    }
    expect(
      ALL_RECORDS.filter((unit) => (unit.specialized ?? []).includes('rail_repair')),
    ).toHaveLength(3)
  })

  it('初设层：剧本 1/2 只有苏支；3/4/5/6/7 三支齐备（4/6 继承 3/5）', () => {
    /*
     * 每换一次剧本都要重建整份初设条目（同步、CPU 重活）。修前同一剧本调两次
     * `selectScenario`，等于把 7 个剧本各建两遍；在 500 文件并行满载下超出 5s 默认超时。
     * 这里按剧本缓存一份条目（断言不变），并给这条重活用例单独的 30s 上限。
     */
    const idsByScenario = new Map<string, (typeof setup.entries)[number]['unitId'][]>()
    const idsOf = (scenarioId: string) => {
      const cached = idsByScenario.get(scenarioId)
      if (cached !== undefined) return cached
      setup.selectScenario(scenarioId)
      const ids = setup.entries
        .filter((entry) => entry.unitId !== null)
        .map((entry) => entry.unitId)
      idsByScenario.set(scenarioId, ids)
      return ids
    }

    for (const scenarioId of ['1', '2']) {
      expect(idsOf(scenarioId)).toEqual(expect.arrayContaining(['su-engineer-west-rr-rgt']))
      expect(idsOf(scenarioId)).not.toEqual(
        expect.arrayContaining(['ax-engineer-ge-i-2-rr-bn', 'ax-engineer-ge-ii-2-rr-bn']),
      )
    }
    for (const scenarioId of ['3', '4', '5', '6', '7']) {
      expect(idsOf(scenarioId)).toEqual(expect.arrayContaining([...RR_IDS]))
    }
  }, 30000)

  it('实例层：剧本 1 苏支落位后 isRailRepairUnit 为真，普通单位恒为假', () => {
    setup.selectScenario('1')
    setup.runAutoSetup()
    const entry = setup
      .choicesOf('soviet')
      .find((view) => view.unitId === 'su-engineer-west-rr-rgt')
    expect(entry, '剧本 1 找不到苏军铁路修理单位条目').toBeDefined()
    if (entry === undefined) return
    const anchor = entry.anchors[0]
    expect(anchor).toBeDefined()
    if (anchor === undefined) return
    const before = new Set(workbench.units.map((unit) => unit.instanceId))
    setup.setSelfChoice(entry.index, `${anchor.col}.${anchor.row}`)
    expect(setup.placeSelfEntry(entry.index)).toBe(true)

    const added = workbench.units.filter((unit) => !before.has(unit.instanceId))
    const rr = added.find((unit) => unit.specialized.includes('rail_repair'))
    expect(rr, '落位后盘面上找不到苏军 RR Rgt 实例').toBeDefined()
    if (rr === undefined) return
    expect(workbench.isRailRepairUnit(rr.instanceId)).toBe(true)
    expect(rr.specialized).toContain('rail_repair')

    const ordinary = workbench.units.find((unit) => !unit.specialized.includes('rail_repair'))
    expect(ordinary).toBeDefined()
    if (ordinary === undefined) return
    expect(workbench.isRailRepairUnit(ordinary.instanceId)).toBe(false)
  }, 30000)

  it('投影层：railRepairUnits 只列当前行动方的铁路修理单位', () => {
    // selectScenario 已跑自动初设（脚本固定格），不要再调 runAutoSetup 造成重复落位
    setup.selectScenario('3')

    const rrUnits = workbench.units.filter((unit) => unit.specialized.includes('rail_repair'))
    expect(rrUnits).toHaveLength(3)
    for (const unit of rrUnits) expect(workbench.isRailRepairUnit(unit.instanceId)).toBe(true)

    expect(workbench.railRepairUnits.length).toBeGreaterThan(0)
    // 投影口径＝盘面实例 ∩ 当前行动方 ∩ 13.3g 谓词；与逐条过滤结果严格一致
    expect(workbench.railRepairUnits.map((unit) => unit.instanceId)).toEqual(
      workbench.units
        .filter(
          (unit) => unit.side === workbench.activeSide && unit.specialized.includes('rail_repair'),
        )
        .map((unit) => unit.instanceId),
    )
  }, 30000)
})
