/**
 * 会话框投影：**直接读 web 的 `mapView` store**（标题 / 规则角标 / 关闭语义 / 待决清单全复用）
 *
 * 为什么这么做：Godot 客户端原先自己抄了一份"这一步要办什么"的中文文案，那是第二份真相。
 * 上一版尝试是在训练侧重建 facts 再调 `planSessionSteps`——文字确实同源了，
 * 但"哪一类会话该开""能不能关"仍在训练侧另写了一遍（`panelKindOf` / `closeOf`）。
 * 现在改为直接问 `map-view` store：它本来就负责"会话开不开、标题叫什么、关不关得掉"，
 * 训练环境（无头 pinia）里可以正常实例化（已实测）。
 *
 * 纪律：本模块只读 store，不新增任何规则判定，也不往 store 写任何东西。
 */

import { useMapViewStore } from '@/stores/map-view'

/** 会话种类（与 web `MapSessionKind` 同集合；`null`＝本刻没有会话） */
export type PanelKind = string | null

/** 会话框投影（形状照 Godot 客户端要渲染的几处） */
export interface PanelProjection {
  kind: PanelKind
  /** 标题（如「战斗结算（9.2） · 格 12.31」），原样来自 `mapView.session.title` */
  title: string
  /** 规则角标（如 `9.2`），原样来自 `mapView.session.rule` */
  rule: string
  /**
   * 关闭语义（原样来自 `mapView.session.closePolicy`，判据在 web `closePolicyOf`）
   *
   * - `cancel`：✕ / Esc 真的收起这次会话；
   * - `collapse`：只折叠、不中止（增援/突围/专规这类事务窗）；
   * - `refused`：域已提交/待结算 ⇒ **不给关闭路径**（连 Esc 也吞），只显示原因。
   */
  close: { policy: string; reason: string }
  /** 当前暴露的那一件（web 一次只暴露一件；null＝没有待决事项） */
  step: { id: string; title: string; why: string; decision: string; optional: boolean } | null
  /** 整张待决清单（客户端可显示「2/6」——`sessionSteps` 里当前那件的位置） */
  steps: readonly { id: string; title: string; why: string; decision: string; optional: boolean }[]
  /** 当前那件在清单里的位置（0 基；-1＝不在清单里） */
  stepIndex: number
}

const EMPTY: PanelProjection = {
  kind: null,
  title: '',
  rule: '',
  close: { policy: 'cancel', reason: '' },
  step: null,
  steps: [],
  stepIndex: -1,
}

export function projectPanel(): PanelProjection {
  const mapView = useMapViewStore()
  const session = mapView.session
  if (session === null) return EMPTY
  const steps = mapView.sessionSteps
  const step = mapView.sessionStep
  return {
    kind: session.kind,
    title: session.title,
    rule: session.rule ?? '',
    close: {
      policy: session.closePolicy,
      reason: session.closeBlockedReason ?? '',
    },
    step: step === null ? null : { ...step },
    steps,
    stepIndex: step === null ? -1 : steps.findIndex((entry) => entry.id === step.id),
  }
}
