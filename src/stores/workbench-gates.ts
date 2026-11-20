import type { Ref } from 'vue'

import { sopStepById } from '@/engine/rules'

import {
  actionGateOf,
  allowedActionsOf,
  type ActionGateQuery,
  type ActionKey,
} from './workbench-model'
import type { WorkbenchCore } from './workbench-core'
import type { ConsolePhase, SettlementLock } from './workbench'

/**
 * 环节闸门（B8 的唯一判据出口）：`actionAllowedNow` 给界面判"能不能点"，
 * `requireAction` 给动作入口判"要不要拒"，两者共用引擎的权威表，不许组件另拼口径。
 *
 * 解构 B0 切片 2（见 `docs/specs/2026-11-20-workbench解构/`）：
 * 这两个函数被 47 + 23 处调用，是所有写盘面动作的入口，先搬出 facade。
 * facade 保留同名薄转发 ⇒ 存量调用点零改动。
 *
 * 依赖全部是 getter / 引用：`segmentGateQuery` / `segmentActionKeys` / `initialSetupInProgress`
 * 在 `workbench.ts` 里声明得很晚，装配期取值会是 `undefined`。
 */

export interface WorkbenchGatesDeps {
  initialSetupInProgress: () => boolean
  terminated: () => boolean
  segmentLocked: () => boolean
  segmentGateQuery: () => ActionGateQuery
  segmentActionKeys: () => ReadonlySet<ActionKey>
  /** 拒绝回执（界面据此显示"为什么点不动"） */
  actionRefusal: Ref<{ key: ActionKey; rule: string; reason: string } | null>
  /** 回合准备等"整段锁"的拒绝出口，仍留在 facade */
  refuseWhileLocked: (action: string) => boolean
  /** 阶段中文名（`PHASE_LABELS` 是 facade 内的局部表，走 getter 注入） */
  phaseLabel: (phase: ConsolePhase) => string
  /** 9.2 / 10.0：当前是否有战斗或轰炸正在结算（null = 无锁） */
  settlementLock: () => SettlementLock | null
  /** 移动被拒的状态条（由 ground-movement 切片持有，这里只写） */
  moveBlocked: Ref<{ rule: string; reason: string } | null>
  /** 拒绝要写日志：直接用 core 的 pushLog，避免绕回 facade */
  log: WorkbenchCore['pushLog']
}

export interface WorkbenchGates {
  actionAllowedNow(key: ActionKey): boolean
  requireAction(key: ActionKey, action: string): boolean
  refuseWhileSettling(action: string): boolean
}

export function createWorkbenchGates(deps: WorkbenchGatesDeps): WorkbenchGates {
  /**
   * 闸门**预测**（供界面判断"这个动作此刻能不能点"；无副作用、不写日志、不改拒绝状态）
   *
   * ★ 用户 2026-10-25 实测 BUG②「增援的时候点格子可能出现空军轰炸的 UI」——
   *   修前地图小窗里"炮击 / 空军轰炸"按钮只看"这枚算子有没有印刷轰炸值"，
   *   **没问环节闸门** ⇒ B 增援段点己方火炮照样给出轰炸入口。
   *   界面一律用本函数判可点，不要自己拿规则号/阶段名再拼一套口径。
   */
  function actionAllowedNow(key: ActionKey): boolean {
    if (deps.initialSetupInProgress() || deps.terminated() || deps.segmentLocked()) return false
    if (deps.segmentGateQuery().segment === '') return false
    // 与 `segmentActionKeys` 同一条投影（权威表），不在组件或本函数里另拼判据
    return deps.segmentActionKeys().has(key)
  }

  function requireAction(key: ActionKey, action: string): boolean {
    if (deps.initialSetupInProgress() || deps.terminated()) {
      deps.actionRefusal.value = { key, rule: '2.2', reason: '请先完成初设，且对局须处于进行中' }
      deps.log('warning', `${action}被拒绝：${deps.actionRefusal.value.reason}`, '2.2')
      return false
    }
    if (deps.segmentLocked()) return deps.refuseWhileLocked(action)
    const query = deps.segmentGateQuery()
    if (query.segment === '') {
      deps.actionRefusal.value = { key, rule: '2.2', reason: 'noSegmentStep' }
      deps.log('warning', `${action}被拒绝：当前段没有环节表（2.2）`, '2.2')
      return false
    }
    if (allowedActionsOf(query).has(key)) {
      deps.actionRefusal.value = null
      return true
    }
    const gate = actionGateOf(key)
    const where = gate.where
      .map((item) => {
        const label = sopStepById(item.segment)?.label ?? item.segment
        return `${deps.phaseLabel(item.phase as ConsolePhase) ?? item.phase} · ${label}`
      })
      .join(' / ')
    const reason = `只能在「${where}」进行`
    deps.actionRefusal.value = { key, rule: gate.rule, reason }
    deps.log('warning', `${action}被拒绝：${reason}（${gate.rule}）`, gate.rule)
    return false
  }

  /**
   * 9.2 / 10.0：结算进行中 ⇒ 拒绝移动（唯一的拒绝出口；三个移动入口都问它）
   *
   * 不静默：`moveBlocked` 给对局台状态条、日志给侧栏，玩家看得见"为什么动不了"以及怎么办。
   */
  function refuseWhileSettling(action: string): boolean {
    const lock = deps.settlementLock()
    if (lock === null) return false
    const reason =
      `${lock.label}正在结算：先走完流程或按 Esc 放弃，之后才能${action}（${lock.rule}）——` +
      `否则这一场的结果（8.1a 的 3 MP / 9.12 的推进与撤退 / 10.0 的 DG 与损失）无处落盘`
    deps.moveBlocked.value = { rule: lock.rule, reason }
    deps.log('warning', reason, lock.rule)
    return true
  }

  return { actionAllowedNow, requireAction, refuseWhileSettling }
}
