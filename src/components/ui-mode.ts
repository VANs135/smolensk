import { inject, provide, type App, type InjectionKey } from 'vue'

/**
 * 条 24 / §5-F：**正式 / 验证模式**
 *
 * ## 为什么要有它
 *   对局台（`GameTableView`）与引擎验证页（`WorkbenchView`）**共用同一批面板**，
 *   除 `VictoryPanel referee` 外没有任何区分 ⇒ 若直接把 63 处手输删掉，验证页会一起被扣掉输入
 *   （第六批 §5-F 原话：去手输**必须先加模式开关**）。
 *
 * ## 口径
 *   · `formal`（对局台）：正式界面**无文本输入**——格号类改点图、数值类由引擎/骰子自动带出；
 *   · `verify`（验证页）：**保留全部手输**（逐步复核、复现、裁判补记都要手输这条路）。
 *
 * ## 为什么是 provide/inject 而不是全局 store
 *   模式是**宿主视图**的属性（同一个面板在两处表现不同），不是跨会话的盘面事实；
 *   用注入可以让"谁声明的"就近可见，也避免一条全局状态被两处视图互相覆盖。
 */

export type UiMode = 'formal' | 'verify'

const UI_MODE: InjectionKey<UiMode> = Symbol('ui-mode')

/** 宿主视图声明自己的模式（在 `setup` 里调一次） */
export function provideUiMode(mode: UiMode): void {
  provide(UI_MODE, mode)
}

/**
 * **应用级**声明（宿主之外的场景：`app.provide` ⇒ `app.runWithContext` 能取到）
 *
 * 组件那一支用上面的 `provideUiMode`；这一支给"没有组件实例"的场合
 * （服务端渲染、以及本模块的用例——仓库不打 DOM，故用例靠它验证注入链）。
 */
export function bindUiMode(app: App, mode: UiMode): void {
  app.provide(UI_MODE, mode)
}

/**
 * 面板读当前模式
 *
 * ★ 缺省取 `verify`：**宿主没声明就保留手输**。宁可多给一个输入框，
 *   也不能把验证页/裁判的手输退路悄悄删掉（条 24 只说"正式界面无需手输"，没说要废掉手输）。
 */
export function useUiMode(): UiMode {
  return inject(UI_MODE, 'verify')
}

/** 是否处在正式模式（面板里写 `v-if="formal"` 的语义化别名） */
export function useFormalMode(): boolean {
  return useUiMode() === 'formal'
}

/**
 * **纯判据**：这个模式该不该显示**裁判工具**
 *
 * ## 判据为什么是"模式"而不是 `only === null`
 *   对局台存在**不带 `only`** 的挂载（`<ReinforcementPanel />` 的 reinforce 会话、
 *   `<BarragePanel />`、`<VictoryPanel />`）⇒ 拿 `only === null` 当"验证页"会把这些
 *   会话里的裁判按钮一并放出来。而宿主是否声明 `formal` 是**视图的属性**，两处视图都声明了。
 *
 * ## 反向失败也安全
 *   `useUiMode()` 的缺省是 `verify`（宿主没声明就保留手输/裁判退路）⇒ 这里同样：
 *   没声明就当验证页，宁可多给裁判一个退路，也不把它的退路悄悄删掉。
 */
export function refereeToolsIn(mode: UiMode): boolean {
  return mode === 'verify'
}

/**
 * 面板里读"该不该显示裁判工具"（`showsReferee`）
 *
 * 语义：**改值 / 订正 / 摆件 / 自动环节的手动重掷** —— 规则里不是"玩家在某环节的动作"，
 * 故只在引擎验证页出现（对局台一铺，就等于让玩家改账本）。
 *
 * ★ 必须与"玩家步骤"区分开：`placePendingReplNow`（13.5 补员落子）、`pickFreeRailEdgeHex`
 *   （专规 2.1 入场格）、`pickSupplyTrainHex`（专规 3.6）、`rollVariableReplNow`（13.6b 掷表）、
 *   `setUnitLockedNow` / `unlockSlowMobilizationNow`（专规 2.4「rotate the 'locked' units」）都是
 *   **玩家要做的事**，对局台必须留着；把它们塞进 `showsReferee` 会把流程锁死。
 */
export function useRefereeTools(): boolean {
  return refereeToolsIn(useUiMode())
}
