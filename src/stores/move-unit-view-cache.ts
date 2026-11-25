import { computed, type ComputedRef } from 'vue'

import type { MoveUnitView } from '@/engine/rules'

import { toMoveUnitView, type ConsoleUnit } from './workbench-model'

/**
 * 档1性能：按单位缓存 `MoveUnitView`
 *
 * `buildMoveContext` 过去每次换格都把 347 枚单位重新 `toMoveUnitView`，每枚读约二十项
 * Vue 响应式字段；实测单步同步段 20–38ms，profile 里对应 `wrappedFn`/`get` 的代理开销。
 *
 * 这里把每个单位的视图做成独立 computed：字段没动 ⇒ 命中缓存；某一枚换格/切模式 ⇒
 * 只重算那一枚，外层 `moveContext` 仍会因依赖变化而重建（规则语义不变）。
 * `maFactorOf` 读取的回合/剧本位也由内层 computed 跟踪，首回合 1/2 MA 不会失活。
 */
export function createMoveUnitViewCache(
  maFactorOf: (unit: ConsoleUnit) => number,
): (unit: ConsoleUnit) => MoveUnitView {
  const views = new WeakMap<ConsoleUnit, ComputedRef<MoveUnitView>>()
  return (unit) => {
    let view = views.get(unit)
    if (view === undefined) {
      view = computed(() => toMoveUnitView(unit, { scenarioMaFactor: maFactorOf(unit) }))
      views.set(unit, view)
    }
    return view.value
  }
}
