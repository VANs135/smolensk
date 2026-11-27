/**
 * 会话框「这一步要办什么」的投影（**文字与顺序复用 web 版**）
 *
 * 为什么要有它：Godot 客户端原先自己抄了一份中文文案（战斗/炮击每一步叫什么、为什么出现），
 * 那是第二份真相——web 改了文案，Godot 不会跟着变。这里改成把 web 版
 * `@/stores/session-steps` 的 `planSessionSteps` 直接拿来算，再把结果投影进观察，
 * 客户端只渲染，不造句。
 *
 * 判据一律照 `map-view.ts` 的同一口径读 store（会话种类＝当前活着的那个交互）；
 * 本模块不新增任何规则，只做「读事实 → 交给 planSessionSteps」。
 */

import type { SessionStepFacts, SessionStepItem } from '@/stores/session-steps'
import { exposedSessionStep, planSessionSteps } from '@/stores/session-steps'
import type { useWorkbenchStore } from '@/stores/workbench'

type Workbench = ReturnType<typeof useWorkbenchStore>

/** 会话种类（训练/桥接端只认这几类；web 的 fuel/air/ops/reinforce 等仍由 web 自己开） */
export type PanelKind = 'combat' | 'barrage' | 'supply' | 'move' | null

/**
 * 当前活着的会话种类
 *
 * 顺序照 `map-view.ts::sessionBase`：战斗 → 轰炸（含"已选参炸单位、尚未宣布"）→ 补给 → 移动。
 * 只比 web 少「fuel/ops/air/reinforce/exclusive/breakout/containers/unit」这些 web 独立开的窗，
 * 桥接端暂不投影，返回 null 时客户端退回到"按 segment 显示"的老路。
 */
export function panelKindOf(wb: Workbench): PanelKind {
  const combat = wb.combatState
  if (combat !== null && !combat.finished) return 'combat'
  const barrage = wb.barrageState
  if (barrage !== null && !barrage.finished) return 'barrage'
  if (barrage === null && wb.barrageActive && wb.barrageSelectionAllowedNow) return 'barrage'
  if (wb.supplyState !== null) return 'supply'
  const moving = wb.moveInteraction
  if (moving !== null || wb.movePick !== null) return 'move'
  return null
}

/** 空事实表（`planSessionSteps` 只在 kind 命中的那一支读字段，其余给安全默认） */
function emptyFacts(kind: PanelKind): SessionStepFacts {
  return {
    kind,
    combat: null,
    barrage: null,
    air: null,
    ops: null,
    supply: null,
    move: { fuelPending: false, pickPending: false, moving: false, overrunZocHeld: false },
    reinforce: null,
    breakout: false,
    breakoutReturnPending: false,
    containers: false,
    exclusive: false,
    exclusiveSections: [],
    unit: false,
  }
}

/** 按 web 同一口径读出事实（只填本次 kind 用到的那几项） */
export function panelFactsOf(wb: Workbench, kind: PanelKind): SessionStepFacts {
  const facts = emptyFacts(kind)
  if (kind === 'combat') {
    const combat = wb.combatState
    facts.combat =
      combat === null || combat.finished
        ? { started: false, step: 'composition', attackerArDeclared: false }
        : {
            started: true,
            step: combat.step,
            attackerArDeclared: combat.declaredAttackerArUnitId !== undefined,
          }
  }
  if (kind === 'barrage') {
    const barrage = wb.barrageState
    facts.barrage =
      barrage === null || barrage.finished ? { step: 'declare' } : { step: barrage.step }
  }
  if (kind === 'supply') {
    const supply = wb.supplyState
    facts.supply = supply === null ? null : { step: supply.step }
  }
  if (kind === 'move') {
    const moving = wb.moveInteraction
    facts.move = {
      fuelPending:
        wb.actionAllowedNow('move.order') &&
        wb.fuelPaymentDue &&
        wb.actionAllowedNow('supply.fuel'),
      pickPending:
        wb.actionAllowedNow('move.order') &&
        wb.movePick !== null &&
        (moving === null || moving.finished),
      moving: moving !== null && !moving.finished,
      overrunZocHeld: wb.overrunZocHeld !== null,
    }
  }
  return facts
}

/** 会话框投影：当前窗的一句话 + 整张待决清单（顺序由 `planSessionSteps` 决定） */
export interface PanelProjection {
  kind: PanelKind
  /**
   * 关闭语义（照 web `map-view.ts::closePolicyOf` 的同一口径，判据取 workbench 的同源查询）
   *
   * - `cancel`：✕ / Esc 真的收起这次会话；
   * - `collapse`：只折叠、不中止（增援/突围/专规这类事务窗）；
   * - `refused`：域已提交/待结算 ⇒ **不给关闭路径**（连 Esc 也吞），只显示原因。
   *   注意 web 的约定：`refused` 不许用按钮 disabled 装样子。
   */
  close: { policy: 'cancel' | 'collapse' | 'refused'; reason?: string }
  /** 当前暴露的那一件（web 一次只暴露一件；null＝本环节没有待决事项） */
  step: SessionStepItem | null
  /** 整张清单（客户端可用它显示「2/6」这类位置） */
  steps: readonly SessionStepItem[]
}

/** 关闭语义（与 `map-view.ts::closePolicyOf` 同口径；不重算"是否已提交"，只问 workbench） */
function closeOf(
  wb: Workbench,
  kind: PanelKind,
): { policy: 'cancel' | 'collapse' | 'refused'; reason?: string } {
  if (kind === 'combat') {
    const reason = wb.combatCancelBlocker()
    return reason === null ? { policy: 'cancel' } : { policy: 'refused', reason }
  }
  if (kind === 'barrage') {
    const reason = wb.barrageCancelBlocker()
    return reason === null ? { policy: 'cancel' } : { policy: 'refused', reason }
  }
  // 补给 / 移动是"操作链"，随时可收（web 这两类也是 cancel）
  return { policy: 'cancel' }
}

export function projectPanel(wb: Workbench): PanelProjection {
  const kind = panelKindOf(wb)
  if (kind === null) return { kind: null, close: { policy: 'cancel' }, step: null, steps: [] }
  const steps = planSessionSteps(panelFactsOf(wb, kind))
  return { kind, close: closeOf(wb, kind), steps, step: exposedSessionStep(steps) }
}
