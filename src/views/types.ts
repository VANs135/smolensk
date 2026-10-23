/**
 * 视图路由契约（类型层）
 *
 * 本作为本地热坐单页应用，架构未引入 vue-router；
 * 以「视图注册表 + Pinia 驱动的轻量路由」实现同等职责：
 * 路由表集中在 views/registry.ts，切换与状态在 stores/ui.ts。
 */

import type { Component } from 'vue'

/** 视图名称（新增视图时在此扩展，并在 registry 注册） */
export type ViewName = 'home' | 'scenario' | 'game' | 'workbench' | 'map'

/** 视图路由项 */
export interface ViewRoute {
  /** 路由名（与 ViewName 一致） */
  name: ViewName
  /** 逻辑路径（仅作标识与可读性，不做真实 URL 解析） */
  path: string
  /** 渲染组件 */
  component: Component
  /** 展示元信息 */
  meta: {
    /** 顶栏标题 */
    title: string
  }
}

/** 路由表：见 views/registry.ts */
export type ViewRegistry = Record<ViewName, ViewRoute>
