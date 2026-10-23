# CODE_SPEC — 开发规范（随仓库流转）

> 本文件是斯摩棱斯克项目的开发规范速查层：任何协作者、代码生成器在写代码前先读本文件。
> 详细设计决策见 `docs/`（定位/范围/技术栈/架构/交互/单位库），冲突时以 `docs/` 为准。
> 改数值/初设/常量的落点速查见 [docs/数值修改指南.md](docs/数值修改指南.md)。
> 每个文件是干什么的、改动后的联动清单见 [docs/程序目录与清单.md](docs/程序目录与清单.md)。

## 0. 项目是什么

OCS《斯摩棱斯克》（Smolensk: Barbarossa Derailed, OCS #17）兵棋推演电子裁判台：
把掷骰、查表、路径与补给追溯、状态记录全部交给引擎计算，玩家只保留决策与反应。
底本 = OCS 系列规则 v4.3 + Smolensk 专规 Living Rules 1.1；单地图、19 回合（1941/7/8–9/8）。
本期唯一对局形态 = 双人同机热坐；AI 与多人同步属二期。

## 1. 技术栈（锁死，禁止替换）

| 领域 | 选型                                                    | 版本线 |
| ---- | ------------------------------------------------------- | ------ |
| 语言 | TypeScript（strict，禁用 `any`）                        | ~5.7   |
| 框架 | Vue 3（组合式 API，`<script setup lang="ts">`）         | ^3.5   |
| 构建 | Vite                                                    | ^8     |
| 状态 | Pinia（setup store）                                    | ^3     |
| 渲染 | Canvas 2D 自绘（禁第三方渲染库）                        | —      |
| 样式 | 原生 CSS + 设计令牌（`src/styles/tokens.css`）          | —      |
| 数据 | JSON + Zod 校验（类型由 schema 推导）                   | ^3.24  |
| 测试 | Vitest                                                  | ^5     |
| 门禁 | ESLint + Prettier + vue-tsc + Vitest（`npm run check`） | —      |

版本一经锁定不回滚不追新；生产构建产物为纯静态文件，用单文件静态服务器本地打开（无后端）。

## 2. 目录结构与依赖方向

```
smolensk/
├── index.html  package.json  tsconfig.json  vite.config.ts
├── eslint.config.js  .prettierrc  .editorconfig  CODE_SPEC.md
├── public/
│   ├── map/ map 静态资源（仅经 public 引用）  计数与算子图档
│   ├── counters/（axis/soviet/markers/）
│   └── fonts/
├── src/
│   ├── main.ts  App.vue
│   ├── engine/    规则内核：纯 TS，禁引 vue/pinia/DOM/Canvas/网络/Math.random
│   ├── data/      JSON + Zod schema + 唯一加载入口（校验→冻结→版本号）
│   ├── render/    Canvas 绘制与命中检测：纯 TS，只读引擎输出
│   ├── stores/    Pinia：界面状态 + 引擎状态的只读投影
│   ├── components/  Vue 组件（面板/对话框/引导条）
│   ├── views/     布局视图 + 视图路由注册表（不引 vue-router）
│   ├── styles/    tokens.css（唯一色/尺度来源）+ base.css
│   └── shared/    无业务纯工具：id/format/assert/math/is/request
├── scripts/       构建期 Node 脚本（数据校验/同步/常量生成 + 静态服务器/发布装配）
└── tests/         引擎规则用例 + 数据校验 + 固定种子整局回归
```

**依赖只能从上往下走**：`components/views → stores → engine`，`render` 只读引擎类型与状态；
`engine/` 下任何文件不得 import Vue、Pinia、组件或 DOM。单向线是整套约定的地基。

| 目录          | 允许放                          | 禁止放                                       |
| ------------- | ------------------------------- | -------------------------------------------- |
| `src/engine/` | 纯函数、类型、常量              | Vue、Pinia、DOM、Canvas、网络、`Math.random` |
| `src/data/`   | JSON、Zod schema、加载入口      | 业务逻辑、格式化、组件                       |
| `src/render/` | Canvas 绘制、坐标换算、命中检测 | 规则判断、状态修改、组件                     |
| `src/stores/` | Pinia store、投影               | 规则计算、数据解析、Canvas 调用              |
| `src/shared/` | 无业务纯工具                    | 任何与规则有关的逻辑                         |

## 3. 硬纪律（违反即视为事故）

1. **规则结算只在引擎**：UI 不重算规则，render 无状态写入。
2. **数值只有一个来源**：表格与常量只来自 `src/data/*.json` 与 `engine/rules/*`；组件中禁止出现规则数字字面量。
3. **掷骰必须可重放**：禁 `Math.random`；所有随机走 `engine/rng.ts`（种子入存档）。
4. **数据先过校验**：任何 JSON 载入先经 Zod 解析，失败即报错并指出字段路径；类型由 schema 推导，不手写第二份接口。
5. **样式只用令牌**：颜色、字号、间距一律引用 CSS 变量（`tokens.css`），组件内不写死十六进制。
6. **规则编号落字符串**：如 `'9.5'`、`'12.8e'`，写在注释、返回值与测试名中，便于反向检索规则书。

## 4. 命名规则

| 对象         | 规则                                        | 示例                            |
| ------------ | ------------------------------------------- | ------------------------------- |
| 目录名       | 小写短横线                                  | `engine/`, `map-config/`        |
| 引擎模块文件 | 小写短横线 `.ts`，单文件单一职责            | `loss-allocation.ts`            |
| 类型文件     | 领域名 + `-types.ts`                        | `combat-types.ts`               |
| Vue 组件     | 大驼峰双词以上 `.vue`                       | `CombatPanel.vue`               |
| 视图         | 大驼峰以 `View` 结尾                        | `TableLayoutView.vue`           |
| Pinia store  | 文件小写，导出 `useXxxStore`                | `ui.ts → useUiStore()`          |
| 数据文件     | 小写短横线 `.json`                          | `units-axis.json`               |
| Zod schema   | 同名 `.schema.ts`，导出 `XxxSchema`         | `units.schema.ts`               |
| 测试文件     | 与被测文件同名 `.test.ts`                   | `combat.test.ts`                |
| 图档         | 沿用现有文件名，一律不改                    | `Smolensk-map-011717.png`       |
| 类型/接口    | 大驼峰，不加 `I` 前缀、不加 `Type` 后缀     | `GameState`, `HexRef`           |
| 函数/变量    | 小驼峰，函数动词开头                        | `resolveCombat()`, `stepCost()` |
| 布尔量       | `is`/`has`/`can`/`should` 开头              | `canOverrun`, `hasTraceSupply`  |
| 模块常量     | 全大写下划线                                | `COMBAT_SUPPLY`                 |
| 事件处理器   | `on` + 动作，禁止匿名箭头直写逻辑           | `onHexClick`                    |
| CSS 变量     | `--` + 领域 + 名称                          | `--map-bg`                      |
| 单位 id      | `<国籍>-<兵种>-<番号>[-<部件>]`，创建后不变 | `de-pz-3-krd`                   |
| 六角格坐标   | 一律对象 `{ col, row }`，禁拼字符串作键     | `{ col: 36, row: 13 }`          |

注释中文，标识符英文；JSDoc 涉及规则处须标 OCS 规则章节号。

## 5. 术语与代码标识符对齐（唯一来源 = 中文规则书）

> 正文与图表页说法不一致时以正文为准，图表页说法登记为别名。
> 代码标识符照此表的代码列，不得另造同义词（含"低空扫射/hipShoot"等英文歧义）。

### 补给与后勤

| 规则书用词          | 代码标识符                             | 规则         |
| ------------------- | -------------------------------------- | ------------ |
| 追溯补给            | `traceSupply`                          | 12.6         |
| 直接拖取            | `directDraw`                           | 12.3a        |
| 投递距离            | `throwRange`                           | 12.3b        |
| 补给点数 / SP       | `sp`                                   | 3.3a         |
| 运输点数            | `transportPoint`                       | 13.2         |
| 战斗补给            | `combatSupply`                         | 9.5 / 12.4   |
| 燃料补给            | `fuel`                                 | 12.5         |
| 部队储备（低/耗尽） | `internalStocks: 'low' \| 'exhausted'` | 12.10        |
| 延补队              | `extender`                             | 12.7         |
| 补给站              | `dump`                                 | 12.11        |
| 断补                | `outOfSupply`                          | 12.8         |
| 补给储备标记        | `supplyCache`                          | 1.7 / 21.10  |
| 铁路容量            | `railCapacity`                         | 4.7a / 13.3b |
| 火车卸货格          | `isDetrainable`                        | 13.3c        |

### 战斗与结算

| 规则书用词         | 代码标识符            | 规则         |
| ------------------ | --------------------- | ------------ |
| 行动值             | `actionRating`        | 3.2c / 9.6   |
| 军力（点数）       | `step`                | 3.2          |
| 战斗值             | `combatStrength`      | 3.1 / 3.2b   |
| 团级当量           | `re`                  | 4.6          |
| 攻防比             | `odds`                | 9.7          |
| 奇袭               | `surprise`            | 9.8          |
| 突袭               | `overrun`             | 8.0          |
| 进击               | `exploit`             | 9.13 / 11.0  |
| 混乱               | `dg`                  | 5.10         |
| 选项（撤退或损失） | `option`              | 9.10         |
| 战后推进           | `advanceAfterCombat`  | 9.12g        |
| 反坦克效果         | `antiTank`            | 9.4e         |
| 轰炸 / 观察员      | `barrage` / `spotter` | 10.0 / 10.0b |

### 移动、模式与地形

| 规则书用词       | 代码标识符                                   | 规则        |
| ---------------- | -------------------------------------------- | ----------- |
| 移动力上限（MA） | `ma`                                         | 3.1a        |
| 模式             | `'combat' \| 'move' \| 'reserve' \| 'strat'` | 5.5–5.8     |
| 控制区           | `zoc`                                        | 4.5         |
| 堆叠 / 超堆叠    | `stacking` / `overStack`                     | 4.8         |
| 运输当量         | `transportEquivalent`                        | 4.7         |
| 最小移动         | `minimumMove`                                | 6.1c        |
| 环形工事（等级） | `hedgehog` / `hedgehogLevel`                 | 16.0        |
| 轨道转换         | `gaugeConversion`                            | 1.2 / 13.3f |
| 铁路修理         | `railRepair`                                 | 13.3g       |
| 运输破坏         | `trainbusting`                               | 14.8        |
| 地形效果 / 禁入  | `terrainEffects` / `movementProhibited`      | 6.2 / 9.3   |

### 空军与设施

| 规则书用词       | 代码标识符                 | 规则                |
| ---------------- | -------------------------- | ------------------- |
| 空军基地（等级） | `airBase` / `airBaseLevel` | 15.0                |
| 简易机场         | `airStrip`                 | 15.2                |
| 整备             | `refit`                    | 15.1                |
| 激活 / 非激活    | `'active' \| 'inactive'`   | 14.1a               |
| 巡逻区           | `patrolZone`               | 14.4c               |
| 防空             | `flak`                     | 14.4e               |
| 拦截             | `interception`             | 14.5                |
| 战机扫荡         | `fighterSweep`             | 14.6                |
| **低空扫射**     | `hipShoot`                 | 14.7d / 2.2a / 3.2a |
| 空运 / 空投      | `airTransport` / `airDrop` | 14.9 / 14.10        |
| 基地转移         | `baseTransfer`             | 14.11               |

> 中文规则书把 Hip Shoot 译作"低空扫射"，是在移动环节执行的轰炸类任务，不是独立任务类型。
> 苏军不得执行（专规 2.2a），德军天气允许时可以（专规 3.2a）。工程里不存在 `strafing` 任务。

### 本作专有机制

| 规则书用词         | 代码标识符                           | 规则                            |
| ------------------ | ------------------------------------ | ------------------------------- |
| 入口格（字母 A–L） | `entryHex`                           | 1.1a / 2.1 / 3.1                |
| 安全边             | `safeEdge`                           | 1.1b                            |
| 地图外盒           | `offMapBox: 'air' \| 'edge'`         | 1.4                             |
| 东北盒 / 东南盒    | `'northeast' \| 'southeast'`         | 1.4b                            |
| 补给源关闭         | `supplyShutdown`                     | 2.1a                            |
| 缓慢动员           | `mobilization`                       | 2.4                             |
| 警报单位           | `alarmUnit`                          | 2.3a                            |
| 方面军预备队       | `frontalReserves`                    | 2.3c                            |
| 治安需求           | `securityNeeds`                      | 3.3b                            |
| 可变撤离           | `variableExit`                       | 3.3c                            |
| 装甲集群分界线     | `panzerGroupBoundary`                | 3.4a                            |
| 装甲集群           | `panzerGroup: 'guderian' \| 'hoth'`  | 3.4                             |
| 建设标记           | `constructionMarker`                 | 3.5                             |
| 随机事件           | `randomEvent`                        | 3.6                             |
| 胜利格 / 提前决胜  | `victoryLocation` / `earlyDecision`  | 5.0b / 5.0c                     |
| 死亡堆             | `deadPile`                           | 到达表 Remove                   |
| 初设抽取堆         | `setupDrawPile`                      | 剧本初设                        |
| 记录轨             | `recordTrack`                        | 辅助卡                          |
| 先手/后手          | `initiative` / `'first' \| 'second'` | 2.3 / Setup Notes A             |
| 双方共识开关       | `agreedOptions`                      | 专规 4.1–4.3 / 2.4 / 1.4 / 4.9e |

### 坐标与标识（本作关键）

- 单幅地图，**编号无字母前缀**，印刷编号即 `列.行`（如 `36.13`、`62.23`）。
- **朝向（★ 用户裁定）：上北下南左西右东** → 行号增大＝向北，列号增大＝向东；故 `N` 行+1、`S` 行−1、`NE`/`SE` 列+1、`NW`/`SW` 列−1（引擎唯一实现在 `engine/hex-geometry.ts`，配真实地名锚点测试）。
- 地图**不是矩形**：四边削角，`bounds` 只是矩形外框；「图内」以格清单（`map-layers.hexes`）为准，**上/下边缘与西南角的 62 个半格属正常图内格**。
- 入口字母（A–L）是**入口标识**，不是编号前缀，禁止与坐标拼成同一个字符串。
- 印刷行号与程序行号用 `rowDecode` 换算，写在配置里，业务代码不做二次转换。
- 剧本地理引用原样保留为位置约束数据：`w/i 3 of 60.34`、`North edge, east of 32.xx`。

## 6. 门禁（一道命令定生死）

```bash
npm run check   # = eslint . + prettier --check . + vue-tsc --noEmit + vitest run
```

四关全绿才算完成；未过门禁的单元不进入下一波次。常用脚本：

```bash
npm run dev          # 开发服务器（127.0.0.1:5173）
npm run build        # 生产构建（dist/）
npm run serve:dist   # 单文件静态服务器打开 dist/（127.0.0.1:5174，零依赖）
npm run pack         # 构建并装配「双击即开」发布包（release/）
npm run test:watch   # 单测监听
npm run lint:fix     # ESLint 自动修复
npm run format       # Prettier 全量写入
```

## 7. 测试要求

- 引擎单元必须配规则条款级单测（测试名含规则编号）。
- 数据文件配 schema 校验用例。
- 追加整局回归：固定种子回放，比对结算结果与日志。
- 组件/工具测试与被测文件同名 + `.test.ts`，无 DOM 依赖的用例用 node 环境。
