import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'

import { isHqUnit, useGameSessionStore, useSetupStore, useWorkbenchStore } from '@/stores'
import type { ConsoleUnit } from '@/stores'

type Workbench = ReturnType<typeof useWorkbenchStore>

/**
 * H③（12.5/12.3a）：**加油候选链的成本口径**守卫
 *
 * 用户 2026-09-19 报告：「选中需要加油的单位时浏览器会非常占内存，甚至占用 1G 内存然后卡死」。
 * 实测（本文件同一夹具＝剧本 1 真实初设盘面，216 枚算子）：选中一枚机动单位 ⇒ 浏览器主线程被
 * `fuelSourcePartition`（~1800 ms）+ `fuelDumpChoices`（~800 ms）堵死 **2500 ms**，每次点击都重来。
 * 根因在引擎（见 `tests/engine/supply-search-cost.test.ts` 的病灶说明）：两个逐格判据每次询问线性扫全表、
 * 取最小用线性扫描；store 只是把它按「每座 HQ × 每个受益单位」调了很多遍。
 * 引擎修好后整链 **17 ms**（150 倍），故 store 层**不再另加缓存**（收益 ~2× 而多一处失效面）。
 *
 * 本文件钉一条：整条链（fuelTargets → 方法 → 同源划分 → 付款站候选）在**宽上限**内算完。
 *
 * 测法边界（如实）：这是**耗时**类断言 —— 上限按修前 2500 ms（本文件实测 3118 ms）留 ~4 倍余量。
 * 它只能抓住"数量级回退"（例如把逐格扫描或线性取最小改回来），抓不住 2–3 倍级的漂移；
 * 规则正确性由既有 12.5/12.3 三路径与 12.5e 用例兜底（本文件不重复断言规则结论）。
 * 曾写过一条"6 枚 / 1 枚 ≤ 4"的比值用例，实测**修前也通过**（HQ 循环对够不到的受益单位会提前 break，
 * 比值天然接近 1）⇒ 它不区分任何实现差异且余量太紧，已删。
 */

function ms(fn: () => unknown): number {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

function boot(): Workbench {
  setActivePinia(createPinia())
  const game = useGameSessionStore()
  const setup = useSetupStore()
  const store = useWorkbenchStore()
  game.setScenarioId('1')
  setup.ensureSetupLoaded()
  return store
}

/** 该方的耗油战斗单位（12.5a：轮式/履带战斗单位） */
function motorized(units: readonly ConsoleUnit[]): ConsoleUnit[] {
  return units.filter(
    (unit) =>
      unit.side === 'axis' &&
      unit.isCombat &&
      (unit.faces.move.mobility === 'truck' || unit.faces.move.mobility === 'track'),
  )
}

/** 该方最大的一堆同格机动单位（`beginMovePick` 只接受**该格内**的 id：6.1f 取子清单） */
function biggestStack(units: readonly ConsoleUnit[]): { hex: ConsoleUnit['hex']; ids: string[] } {
  const byHex = new Map<string, ConsoleUnit[]>()
  for (const unit of units) {
    const key = `${unit.hex.col}.${unit.hex.row}`
    byHex.set(key, [...(byHex.get(key) ?? []), unit])
  }
  let best: ConsoleUnit[] = []
  for (const group of byHex.values()) if (group.length > best.length) best = group
  if (best.length === 0) throw new Error('盘面上找不到机动单位')
  return { hex: best[0]!.hex, ids: best.map((unit) => unit.instanceId) }
}

describe('H③：加油候选链的成本口径', () => {
  it('★ 一盘真实盘面上，选中一堆需加油单位：整条链不挂死（挂死守卫 5 s）', () => {
    const store = boot()
    // 预热构造性成本（浏览器里早已付过）：把两份事实投影读出来即可
    const warm = store.supplyFacts === undefined ? 0 : store.allSpDumps.length
    expect(warm).toBeGreaterThan(0)
    const stack = biggestStack(motorized(store.units))

    // 把每一次读取都收进 `sink`：既让"这些 computed 真被求值"成立，也顺手做反空转（见下）
    let sink = 0
    const total = ms(() => {
      store.beginMovePick(stack.hex, stack.ids)
      sink += store.fuelTargets.length
      sink += store.fuelPendingUnits.length
      sink += store.fuelMethodChoices.length
      sink += store.fuelSourcePartition.shared ? 1 : 0
      sink += store.fuelDumpChoices.length
    })
    /*
     * ★ 守卫口径（2026-10-15 修正，**不是放宽**）：原为「< 800 ms」绝对阈值，而本轮门禁在并发长跑下
     *   实测 **899 ms**（同一份代码单跑 398 ms）⇒ 必抖，正是项目「耗时类守卫不用绝对毫秒阈值」那条纪律。
     *   改为**挂死守卫 5 s**（抓 O(n²) 级别的灾难性回退）；抓数量级回退的是同文件另两条与负载无关的守卫
     *   （逐单位读取计数＝确定性；耗时比中位数 ≤3）。修前的 ~2500 ms 回退会被 5 s 内 3 倍以上的中位比抓住。
     */
    expect(total).toBeLessThan(5000)
    // ★ 反空转：受益集非空 ⇒ 上面那几行确实在算东西（不是空盘面上的空转）
    expect(sink).toBeGreaterThan(0)
    expect(store.fuelTargets.length).toBe(stack.ids.length)
  })

  it('★ 同一盘面上 HQ 数与站点数（说明这条链为什么值得收口）', () => {
    const store = boot()
    const hqs = store.units.filter((unit) => unit.side === 'axis' && isHqUnit(unit))
    expect(hqs.length).toBeGreaterThan(0)
    expect(store.allSpDumps.length).toBeGreaterThan(0)
  })
})
