# UI 组件清单 —— 组件 · 页面 · 入口 · 无界面入口的能力

> 建档 2026-09-15。**只登记事实，不含改动**。规模：`.vue` 33 个（组件 29 + 页面 4）+ 外壳 `App.vue` + 路由表 `views/registry.ts`。
> 事实取自代码（脚本提取：`backup/2026-09-15-lists/audit-scripts/_ui-facts.cjs` / `_ui-tree.cjs` / `_ui-noentry.cjs`），
> 判据为**文本级引用**（见 §0 的口径与已知偏差）。

## 0. 分层口径与判定偏差

- **依赖方向**（唯一）：`views/components → stores → engine`；`render/` 只读引擎输出。
  组件**不做规则计算**：只画表、收输入、把输入写回 store（`docs/程序目录与清单.md` §3）。
- **「入口」的含义**：玩家能否在界面上**到达**这项操作（不是「store 里有没有这个动作」）。
- **判定偏差（必须知道）**：
  1. 本清单的引用关系是**文本级**的（正则找成员名），模板里经 `storeToRefs` 解构、
     经 computed 间接暴露、或名字动态拼接的，会**漏判**；反向地，注释里提到名字会**误判为已接线**；
  2. 「全树无人引用」只说明**没有静态调用点**，不等于该能力没生效——可能由**会话/回合驱动路径**
     （`stores/session.ts` 的 `stepNow`）内部完成，需逐条确认；
  3. 因此 §3/§4 用来**排工作**，不用来下结论。

## 1. 组件总表（29 个）

### 1.1 域面板（10）——每个对应规则书一章，走引擎状态机

| 组件                                   | 行数 | 职责（首段注释）                                                          | 规则章                                            | 入口            |
| -------------------------------------- | ---- | ------------------------------------------------------------------------- | ------------------------------------------------- | --------------- |
| `air/AirPanel.vue`                     | 714  | 空军全流程：任务分配→空战→拦截→防空→结算→返航，含整备/基地修建与扩建      | 14.0 / 15.0 全章、14.2f 七步                      | 对局台、操作台  |
| `barrage/BarragePanel.vue`             | 469  | 轰炸：整体目标与轰炸值分配→付炮击补给→列横移→掷骰→结算                    | 10.0 全章、10.1b、10.2b/c                         | 对局台、操作台  |
| `combat/CombatPanel.vue`               | 32k  | 战斗：九步完整流程（9.2）与快速结算两种模式；含撤退/推进/贴随/2.3c        | 9.0 全章、9.5、9.6、9.8、9.12g、9.13              | 对局台、操作台  |
| `supply/SupplyPanel.vue`               | 38k  | 补给：追溯与投递可视化、吃图上补给、补给阶段总计划、消耗与损耗、内部储备  | 12.0 全章、12.1、12.3a–d、12.4、12.6c/d、12.5     | 对局台、操作台  |
| `reinforcement/ReinforcementPanel.vue` | 21k  | 增援：到达/落点、重建与整编、拆分与吸收、3.3c 撤离、方面军预备队          | 13.5 / 13.6 / 13.9 / 20.0 + 专规 1.6 / 2.1 / 2.3b | 对局台、操作台  |
| `setup/SetupPanel.vue`                 | 23k  | 初设与开局：自动初设→自由项→编内卡车装载（13.2h）→SP 归属→空军摆放        | 12.1d、13.2h、14.1a、4.0、3.4b                    | 对局台、操作台  |
| `containers/ContainersPanel.vue`       | 25k  | 记录轨（回合/天气/铁路容量）与各盒的查看与操作（死亡堆、拆分、编队盒）    | 2.2、13.3b、13.5、13.7、1.5、20.0g                | 对局台、操作台  |
| `exclusive/ExclusiveRulesPanel.vue`    | 24k  | 专规机制八件事（装甲集群边界与 SP 校验、训练/拆解、可变撤离、随机事件等） | 专规 1.2 / 1.7 / 2.1a / 2.2 / 3.3b / 3.4 / 3.5    | 对局台、操作台  |
| `victory/VictoryPanel.vue`             | 8k   | 胜利判定：双方条件、控制格刷新、裁定与终局                                | 专规 5.0 / 5.0a–c                                 | 对局台、操作台  |
| `save/SaveLoadDialog.vue`              | 12k  | 存档/读档对话框（顶栏按钮打开，任意视图可达）                             | W7 C15                                            | 顶栏（App.vue） |

### 1.2 地图（3）——「能在地图上做的选择不搬到侧栏」

| 组件                 | 行数 | 职责                                                                     | 规则章 | 入口                   |
| -------------------- | ---- | ------------------------------------------------------------------------ | ------ | ---------------------- |
| `map/MapCanvas.vue`  | 16k  | Canvas 绘制 + 收输入 + 视口控制（几何来自 `render/`，要素来自 `@/data`） | C2     | 对局台、地图页、操作台 |
| `map/MapDock.vue`    | 4.5k | 地图上可拖动面板（战斗/轰炸/突袭的结算页面，默认右上角）                 | W7 C16 | 对局台                 |
| `map/MapPopover.vue` | 6k   | 就近小窗**公共外壳**（被 MapDock / MapActionPopover 复用）               | W7 C16 | 组件内部               |

### 1.3 对局与会话（8）

| 组件                             | 行数 | 职责                                                                            | 规则章                          | 入口           |
| -------------------------------- | ---- | ------------------------------------------------------------------------------- | ------------------------------- | -------------- |
| `game/MapActionPopover.vue`      | 32k  | 地图动作小窗：按「当前盘面上正进行的那件事」分派（战斗/轰炸/移动损耗/临时选项） | 9.2、10.0e、14.2f-A、4.9a、6.1f | 对局台         |
| `game/ActionFeedbackStrip.vue`   | 3.1k | 操作反馈区（M9②）：把引擎带规则编号的拒绝/落账显示出来                          | —                               | 对局台         |
| `game/HotkeyHelpPanel.vue`       | 1.9k | 快捷键说明（与 `stores/hotkeys.ts` 的 `HOTKEY_DOCS` 同源）                      | W7 C16                          | 对局台（`?`）  |
| `session/FlowStrip.vue`          | 10k  | 完整流程条：一回合 19 步的逐步引导                                              | 2.2 / 2.3 / 4.0 / 5.0a–b        | 对局台、操作台 |
| `session/QuestionPrompt.vue`     | 5.5k | 待答面板：由会话 `awaiting.question` 驱动，组件自身不持问题                     | 0.45                            | 对局台、操作台 |
| `session/SettlementLogPanel.vue` | 12k  | 结算日志：结构化/可检索/可展开（规则号、掷骰、明细）                            | W7 D2                           | 对局台、操作台 |
| `session/DerivationSteps.vue`    | 3.6k | 结算复核明细（骰点→修正→合计→取列/查表→结果），纯展示                           | W7 C11                          | 操作台         |
| `session/TerminationNotice.vue`  | 2.9k | 终止提示（回合耗尽 / 提前终止），会话终止幂等                                   | 5.0a–c                          | 对局台、操作台 |

### 1.4 热坐（2）

| 组件                             | 行数 | 职责                                                       | 规则章                             | 入口           |
| -------------------------------- | ---- | ---------------------------------------------------------- | ---------------------------------- | -------------- |
| `hotseat/ConsensusChecklist.vue` | 4.8k | 开局共识清单（地图外盒隐藏、秘密掷骰、同步回合、可选规则） | 专规 4.0、4.1a–4.3、1.4、4.9e、2.4 | 对局台、操作台 |
| `hotseat/HandoffOverlay.vue`     | 4.2k | 交接全屏遮罩：接手方确认前盘面完全不可见                   | 4.9a、1.4                          | 对局台、操作台 |

### 1.5 基础组件（6）

| 组件                  | 行数 | 职责                                               | props / emits                                 |
| --------------------- | ---- | -------------------------------------------------- | --------------------------------------------- |
| `base/BaseButton.vue` | 163  | 四变体按钮（primary / secondary / ghost / danger） | `variant,size,disabled,loading,type`／`click` |
| `base/BaseDialog.vue` | ~    | 对话框外壳                                         | `open`（v-model）                             |
| `base/BasePanel.vue`  | ~    | 面板外壳（可选标题）                               | `title`                                       |
| `base/BaseTag.vue`    | ~    | 语义标签                                           | 类别                                          |
| `base/ToastHost.vue`  | ~    | 全局通知宿主（挂 `body`，随 `ui.toasts`）          | —                                             |
| `base/ToastItem.vue`  | ~    | 单条通知（被 ToastHost 内部使用）                  | —                                             |

## 2. 页面与外壳（6）

| 页面                          | 行数      | 定位                                                               | 直接可达的组件                                                                                    |
| ----------------------------- | --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `App.vue`                     | —         | 外壳：顶栏（存档/读档、路由名、环境标记）+ 视图容器 + ToastHost    | BaseButton、ToastHost、SaveLoadDialog                                                             |
| `views/HomeView.vue`          | 6.3k      | 开始台                                                             | 基础组件                                                                                          |
| **`views/GameTableView.vue`** | **16.7k** | **对局台：按规则书操作方式的正式界面（「能打完整一局」的主入口）** | 22 个：全部域面板 + 地图 + 会话 + 热坐                                                            |
| `views/WorkbenchView.vue`     | 32k       | 操作台：引擎验证入口（面板平铺、操作对象是表单）                   | 20 个（不含 ActionFeedbackStrip / HotkeyHelpPanel / MapActionPopover / MapDock / SaveLoadDialog） |
| `views/MapView.vue`           | 7k        | 地图页（图层开关、选中/悬停；不引引擎）                            | MapCanvas + 基础组件                                                                              |
| `views/registry.ts`           | 1.4k      | 轻量路由表（不引 vue-router）；新增视图固定三步见文件头注释        | —                                                                                                 |

**注意**：域面板在**两个页面**里各有一套入口（对局台 = 正式玩法；操作台 = 引擎验证）。
**新功能只要接到 store，就必须在两个页面各接一次**，否则「操作台能点、对局台不能点」——
这是本项目最容易出现「半接线」的地方。

## 3. 「界面无入口」的 store 成员（161 个）

判定：`stores/*.ts` setup store 的 `return {}` 成员（共 702 个）里，**未被 `App.vue` + `components/**` + `views/**` 引用**者。
其中**动作类 37 个**（玩家点了会有反应的那些），分三类：

| 类别           | 数量 | 含义                                                                          | 处置                               |
| -------------- | ---- | ----------------------------------------------------------------------------- | ---------------------------------- |
| 产品层内部在用 | 11   | 被另一个 store 调用（如 `setActiveSide` 被 `hotseat` 调用）⇒ **玩家仍无入口** | 需要 UI 入口或明确「不由玩家触发」 |
| 仅测试在用     | 14   | 只有测试会调用 ⇒ 规则可验证但玩家到不了                                       | 按「真正实现」判据补入口           |
| 全树无人调用   | 12   | 连测试都不调用 ⇒ 疑似**死动作**或由会话驱动路径内部完成                       | **逐条确认**后再决定补入口或删     |

**12 个「全树无人调用」的动作**（重点核查对象）：

| 成员                                                  | 对应规则/功能                  | 备注                                     |
| ----------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| `workbench.assessTurnEndVictoryNow`                   | 20.0d 阶段末胜利判定           | 可能由会话回合驱动覆盖，需确认           |
| `workbench.settleAbsorbObligationsNow`                | 20.0d 阶段末吸收（**强制项**） | 同上                                     |
| `workbench.constructionGateNow`                       | 16.0b/c 工事建造闸门           | 建造动作本身已接线，这条是**前置判定**   |
| `workbench.moveStackHex`                              | 堆叠整体移动的辅助             | 移动链已接线，可能是遗留                 |
| `workbench.moveMinRemainingMp`                        | 移动预算的下限口径             | 同上                                     |
| `workbench.settleOverrunMove`                         | 突袭后的移动结算               | 突袭已接线（`overrunNow`），此为分支     |
| `workbench.moveRuntime`                               | 移动运行期聚合                 | 可能是给 UI 用但被其它派生态取代         |
| `workbench.clearSupply` / `clearBarrage` / `clearAir` | 三个面板的清理动作             | UI 用的是 `cancelXxx` 系列               |
| `workbench.pickedHedgehogEngineer`                    | 16.0b/c 所选工兵               | 建工事由 `buildHedgehogNow` 走另一条入参 |
| `hotseat.revealFor`                                   | 4.9a 交接后对某方的可见性      | 雾显相关，热坐核心                       |

**「仅测试在用」的 14 个**（规则可验证、玩家到不了，按「真正实现」判据应补入口）：
`hotseat.rollVisibleToViewer`、`session.setAgreedAdopt`、`session.setSaveStorage`、`setup.finishSetup`、
`workbench.moveContext`、`setFuelPool`、`rollCombatShiftDie`、`applyAirStepLoss`、`setSpDumpHoldings`、
`reducedBases`、`resolveAirCargoNow`、`resolveSpecialCombatAt`、`refitBaseNow`、`setReplHoldingsNow`。

**「产品层内部在用」的 11 个**（被别的 store 调用，玩家仍无直接入口）：
`containers.setScenario`、`session.setSessionRng`、`session.setScenarioId`、`workbench.setScenarioId`、
`setup.placeAtHex`、`workbench.setActiveSide`、`setRetreatDestinationNow`、`overrunNow`、
`setSpecialDisplacement`、`pickRefitPayDump`、`sendToDeadPileNow`
（注意其中 5 条由 `stores/map-view.ts` 调用 —— 即**地图点击路径**，属已接线）。

其余 **124 个状态/派生类**（`spDumps`、`combatChecklist`、`airInputs`…）多为内部账本或已由其它派生态暴露，
**不必逐个接线**；完整名单见 `backup/2026-09-15-lists/audit-artifacts/_ui-noentry.md`。

## 4. 「引擎有、界面没有」：零调用导出（34 条，白名单冻结）

`scripts/check-arch.mjs` 第五关扫出、白名单冻结的「导出后全树无人引用」符号（**纪律：只许删不许加**）：

| 类别                  | 数量 | 例子                                                                                                                                                                                                  | 处置                                             |
| --------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 规则数值常量 / 清单   | 23   | `RAIL_CAP_BEFORE`、`AIR_COMBAT_DEFENDER_ABORT_MIN_DICE`、`RIVER_FEATURES`、`VICTORY_RULE`、`RE_SCALE_BATTALION`、`BOARD_EXTENT`                                                                       | 是条文取值的**单一出处**，留着等接线时用，不必删 |
| 待接线谓词 / 渲染辅助 | 11   | `classifyForMode`、`unitMoveBudget`、`extenderBridgesRailLines`、`movementMpValue`、`isBefore/isAfter`、`hexPolygonPoints`、`formatHexPath`、`resultTextOf`、`parseResultCell`、`resolveAirCargoStep` | **属接线清单**；接上后应从白名单删除             |

「删净白名单」＝这一关的自然收敛，可作为「接线进度」的一个量化指标（当前 34/34 未删）。

## 5. 已知功能缺口（人工登记，按「打不完一局」排序）

| #   | 缺口                                    | 证据                                                                                                                                 | 影响                                      |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 1   | **14.1b 空军重建无路径**                | `stores/workbench.ts` 的 `rebuildUnitNow` 对空军**显式拒绝**并记日志「空军重建尚未接线」                                             | 飞机只进得出，14.1b/13.5 空军补员不可玩通 |
| 2   | **P1-1 追溯覆盖集未上界面**             | `supplyCoverageHexes` 定义于 store，但界面层零引用（`map-view.ts` 内部持有）                                                         | 玩家看不到「哪些格有追溯补给」            |
| 3   | **13.3a 运输点数作铁路货物**            | 全树无「把运输点数当铁路货物运输」的入口（单位沿铁路移动 `railMoveNow` 与装卸 `loadTransportPointNow` 已接线；缺的是**第三类货物**） | 三类货物里的第三类不可用（登记为剩余项）  |
| 4   | **9.14d 主动崩溃替代常规移动**          | SupplyPanel 有「按崩溃流程」入口，仓储层 `collapseExtenderNow` 已就绪；**需在界面上确认走完整链**                                    | 延补队非常规位移                          |
| 5   | **§3 表里的 12 个「全树无人调用」动作** | 见 §3                                                                                                                                | 逐条确认后才能判断是否算缺口              |

## 6. 自检与复现

```bat
:: 架构五关（含规则字面量 / 未定义 CSS 变量 / 零调用导出）
npm run arch
:: 组件事实提取（条款、props/emits、调用的 store 动作）
node backup\2026-09-15-lists\audit-scripts\_ui-facts.cjs
:: 页面 → 组件可达关系
node backup\2026-09-15-lists\audit-scripts\_ui-tree.cjs
:: 界面无入口清单（161 个成员，动作类 37）
node backup\2026-09-15-lists\audit-scripts\_ui-noentry.cjs
```

| 产物                                                 | 路径                                                     |
| ---------------------------------------------------- | -------------------------------------------------------- |
| 组件事实全表（29 个，含条款/props/emits/store 动作） | `backup/2026-09-15-lists/audit-artifacts/_ui-facts.md`   |
| 界面无入口全名单                                     | `backup/2026-09-15-lists/audit-artifacts/_ui-noentry.md` |
| 页面-组件可达关系输出                                | 见 `_ui-tree.cjs` 运行输出                               |
