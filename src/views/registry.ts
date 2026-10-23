import GameTableView from './GameTableView.vue'
import HomeView from './HomeView.vue'
import MapView from './MapView.vue'
import ScenarioSetupView from './ScenarioSetupView.vue'
import WorkbenchView from './WorkbenchView.vue'
import type { ViewRegistry } from './types'

/**
 * 全局路由表（轻量视图路由）
 *
 * 本作为本地热坐单页应用，架构确定不引入 vue-router：
 * 「路由表集中在本文件，切换状态在 stores/ui.ts，渲染入口在 App.vue」。
 * 新增视图的固定三步：
 *   1. ViewName 联合类型加成员（views/types.ts）
 *   2. 此处注册路由项
 *   3. stores/ui.ts 无需改动（navigate 泛化到 ViewName）
 */
export const viewRegistry: ViewRegistry = {
  home: {
    name: 'home',
    path: '/',
    component: HomeView,
    meta: { title: '开始台' },
  },
  // B10：进入游戏前的**剧本 + 共识**（用户口径⑨：先选剧本与共识，再进游戏开始初设）
  scenario: {
    name: 'scenario',
    path: '/scenario',
    component: ScenarioSetupView,
    meta: { title: '剧本与共识（进入游戏前）' },
  },
  game: {
    name: 'game',
    path: '/game',
    component: GameTableView,
    meta: { title: '对局台（全流程可玩 + 快捷键）' },
  },
  workbench: {
    name: 'workbench',
    path: '/workbench',
    component: WorkbenchView,
    meta: { title: '骨架操作台（引擎验证入口）' },
  },
  map: {
    name: 'map',
    path: '/map',
    component: MapView,
    meta: { title: '地图（C2 渲染与视口）' },
  },
}

/** 取当前视图路由项（App.vue 渲染用）；未匹配时回退 home */
export function getView(name: keyof ViewRegistry): ViewRegistry[keyof ViewRegistry] {
  return viewRegistry[name] ?? viewRegistry.home
}
