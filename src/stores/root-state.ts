/**
 * 根状态容器（P1-a）
 *
 * 目的：把 facade `workbench.ts` 里的根级状态搬到独立模块，让各域（先自 air 试点）
 * 有一个明确的「根状态」来源，而不是继续穿过 facade 的 ports 取值。
 *
 * ⚠ 本模块**不是** Pinia store，是普通工厂。原因见方案 §4.4：
 * Pinia store 是 reactive 代理，读属性会自动解包 `.value`，`const { x } = store` 拿到的是
 * **当前值快照**，会当场破坏 facade 现有的逐名解构与响应性；普通对象解构拿到的仍是同一个
 * ref 对象，读写与响应性零变化，因而 facade 可以原样保留解构写法。
 *
 * 迁移纪律：每批只搬「纯状态」（ref / 无副作用派生），不搬函数；搬完立刻全量 check。
 */

import { ref } from 'vue'
import type { ConsoleUnit, UnitRecordView } from './workbench-model'

export function createRootState() {
  // ── 摆子 ──
  /** 场上全部算子实例 */
  const units = ref<ConsoleUnit[]>([])
  /** 当前选中的算子实例 id */
  const selectedId = ref<string | null>(null)
  /** 待摆放的单位库记录（从单位列表里点选后进入「摆放模式」） */
  const pendingRecord = ref<UnitRecordView | null>(null)

  return { units, selectedId, pendingRecord }
}

export type RootState = ReturnType<typeof createRootState>
