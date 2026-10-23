import { defineStore } from 'pinia'
import { ref } from 'vue'

import { createId } from '@/shared'

import type { ViewName } from '@/views/types'

/** 通知消息类别 */
export type ToastKind = 'info' | 'success' | 'warning' | 'danger'

/** 通知消息（由 ToastHost 消费渲染） */
export interface UiToastMessage {
  id: string
  kind: ToastKind
  text: string
  /** 自动关闭毫秒数；0 表示常驻直至手动关闭 */
  duration: number
}

const DEFAULT_TOAST_DURATION = 4000

/**
 * 界面状态 store（视图路由 + 通知）
 *
 * 只放界面状态；游戏状态属引擎，由 stores/game.ts 提供只读投影（后续单元）。
 */
export const useUiStore = defineStore('ui', () => {
  // ── 视图路由 ──────────────────────────────────────────
  /** 当前视图名（默认 'home'） */
  const currentView = ref<ViewName>('home')
  /** 视图历史栈（back() 弹出） */
  const viewHistory = ref<ViewName[]>([])

  // ── 通知 ──────────────────────────────────────────────
  const toasts = ref<UiToastMessage[]>([])

  /* ── W7 C15：存档 / 读档对话框 ── */

  /**
   * 存档 / 读档对话框是否打开
   *
   * 放在 ui store（而不是某个组件的局部状态）是为了让**两个入口共用一个对话框**：
   * 顶栏按钮（任意视图都在）与待答面板底部的「存档 / 读档」（待答时遮罩挡住了顶栏，
   * 故须由面板自己给入口）——两处都调到同一个开关，不会出现两份各说各话的存档界面。
   */
  const saveDialogOpen = ref(false)

  /** 打开存档对话框 */
  function openSaveDialog(): void {
    saveDialogOpen.value = true
  }

  /** 关闭存档对话框 */
  function closeSaveDialog(): void {
    saveDialogOpen.value = false
  }

  /** 切换视图；保存当前到历史栈，供 back() 返回 */
  function navigate(name: ViewName): void {
    if (name === currentView.value) return
    viewHistory.value.push(currentView.value)
    currentView.value = name
  }

  /** 返回上一视图（无可返回时留在原地） */
  function back(): void {
    const previous = viewHistory.value.pop()
    if (previous) currentView.value = previous
  }

  /** 推送一条通知；返回其 id，便于手动关闭 */
  function pushToast(kind: ToastKind, text: string, duration = DEFAULT_TOAST_DURATION): string {
    const id = createId('toast')
    toasts.value.push({ id, kind, text, duration })
    return id
  }

  /** 按 id 移除通知 */
  function dismissToast(id: string): void {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  return {
    currentView,
    viewHistory,
    toasts,
    navigate,
    back,
    pushToast,
    dismissToast,
    // W7 C15：存档 / 读档对话框（顶栏按钮与待答面板共用）
    saveDialogOpen,
    openSaveDialog,
    closeSaveDialog,
  }
})
