# ⑦ 补给改为地图点选 · 实施规格

2026-11-09 · 分支 `codex/command-table-ui` · 基线 `7b6fd31`

## 1. 现状勾对（只列未完成）

来源：`docs/2026-11-08-棋桌UI重做任务方案.md` 与 `docs/2026-11-09-后续待办-装甲集群归属与补给点选.md`。

| 条目                                                              | 状态                                                  | 本批处理                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| 实施表 1–6（开始台/流程会话/选格堆叠/设施盒区/信息渲染/验收推送） | 已交付（首批 + B1–B6）                                | 不重做                                   |
| TODO P0-01a/01b/02a/02b/02c                                       | 已完成                                                | 不重做                                   |
| TODO P1-01 人工签收（七局闭环 + 5 条边界项）                      | **未完成**，须用户上机                                | 不在本批，等用户在场                     |
| TODO P1-02 首屏/输入延迟                                          | 实测已交（进入对局台 508 ms > 250 ms 目标），实现未做 | **需拍板**：属性能瓶颈拆分，不是 UI 结构 |
| 后续待办 ⑥ 装甲集群自动归属                                       | 已核原文与数据，结论「现状达标、无需改代码」          | 不改                                     |
| 后续待办 ⑦ 补给改为地图点选                                       | **未完成**                                            | **本批主任务**                           |

结论：剩余可执行的 UI 结构任务只有 ⑦；⑧ 与其后无待办。P1-01 与 P1-02 列入「需要拍板」。

## 2. ⑦ 的口径（沿用已定稿的 ⑦-2/⑦-3/⑦-4/⑦-5）

- 地图是主入口：点受补给单位 → 地图高亮**可点来源格** → 点格选定；再点同一格取消。
- 不新造优先级：同格多座可用来源属**并列**，地图不隐式择一，回面板点选。
- 判据全部来自既有事实层，组件不写规则；`src/engine`、`src/data` **零改动**（含 3.4 文案不再扩）。
- 不新增存档字段：选源态沿用 `supplyState` / `supplyPreviewIndex`。

## 3. 事实层（已有，直接复用）

| 事实           | 位置                                                               | 说明                                                                                          |
| -------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 来源清单       | `src/stores/workbench.ts:4131` `supplySources`                     | 引擎 `SupplySourceOption[]`，含 `kind/hex/path/distanceMp/viaAdjacency/ok/rule/reason/detail` |
| 可带 SP 的来源 | `src/engine/rules/supply-interaction.ts:501` `isSpBearingSource`   | 仅 `dump` / `hqThrow`；引擎在选源时已用它拒 `sourceHasNoSp`（`:740`）                         |
| 选源入口       | `src/stores/workbench.ts:11723` `chooseSupplySourceNow(index)`     | 12.3a/12.3b；成功后 `step='pickup'`、清预览、重置付款站                                       |
| 已选来源投影   | `src/stores/workbench.ts:4361` `supplySummary.chosenSource`        | 面板「已选来源」行已读它                                                                      |
| 地图点选分派   | `src/stores/map-view.ts:2473` `onHexClick`                         | 待点格在 `:2526`，堆叠展开在 `:2507`，战斗付款站在 `:2601`                                    |
| 补给覆盖层     | `src/stores/map-view.ts:473-482` + `src/render/token-layer.ts:962` | 悬停/已选来源画覆盖与最省路径（12.3d），不改                                                  |
| 补给站方框画法 | `src/render/token-layer.ts:894-912`                                | `payDumps` + `refitPay` 合成 `payHints`，方框 + 可选标签 + `selected` 色                      |

## 4. 改动清单

### 4.1 `src/stores/workbench.ts`

新增（放在 `chooseSupplySourceNow` 附近，均导出到 return API）：

1. `supplyPickSourceIndexesAt(hex: HexRef): number[]`（内部函数，不导出）
   - 返回 `supplySources` 中满足 `hex` 同格且 `ok === true` 且 `isSpBearingSource(kind)` 的下标。
2. `supplyPickSourceHints: ComputedRef<readonly SupplyPickHint[]>`
   - 条件：`supplyState !== null && (step === 'selectSource' || step === 'pickup')`，否则空数组。
   - 对可点来源按 **hex 去重**（同格并列只出一条提示）；`selected` = 已选来源同格。
   - `label` 留空（不新增长文案）；吃图上补给 `hex === null` 天然不出现。
3. `pickSupplySourceAtHexNow(hex: HexRef): boolean`
   - `supplyState === null` ⇒ `false`（不拦截其它点击）。
   - `step === 'pickup'` 且 `chosenSource.hex` 同格 ⇒ 取消：`supplyState = { ...state, chosenSource: undefined, step: 'selectSource' }`，`pushLog('info', …)`，返回 `true`。
   - `step !== 'selectSource'` ⇒ `false`。
   - 可点下标 **1 条** ⇒ 调 `chooseSupplySourceNow(index)`，返回 `true`。
   - 可点下标 **>1** ⇒ `pushLog('warning', '该格有 N 个并列来源，请在面板选择（12.3）')`，返回 `true`，不改状态。
   - 该格有来源但不可点（`ok === false`，或 `ok === true` 但非 SP 承载）⇒ `pushLog('warning', '${hexLabel}：${rule} ${reason ?? detail}')`（**一行**），返回 `true`。
   - 该格无任何来源 ⇒ `false`。

不改 `chooseSupplySourceNow` 的引擎调用与参数；不改 `supplySources` 生成逻辑。

### 4.2 `src/stores/map-view.ts`

- `overlay` 计算新增 `supplyPick: workbench.supplyPickSourceHints`（放在 `refitPay` 旁）。
- `onHexClick`：在 `handleStackClick` 调用（`:2507`）**之前**插入
  `if (workbench.pickSupplySourceAtHexNow(hex)) { closePopup(); return }`。
  理由：来源格若正好有展开堆叠、或点击会落到 `pickCombatSupplyDump`（`:2601`）的误提示，都需要本轮选源优先。
- 不新增 map-view 私有规则判据。

### 4.3 `src/render/token-layer.ts`

- `MovementOverlay` 新增 `supplyPick?: readonly SupplyPickHint[] | null`（注释指 12.3 选源）。
- `cullOverlay` 按 `visibleKeys` 过滤 `supplyPick`（与 `refitPay` 同写法，`VisibleKeys` 约束不变）。
- `drawMovementOverlay`：把 `visible.supplyPick` 并入现有 `payHints` 循环（`:894`），不改绘制样式与调色板。

### 4.4 `src/components/supply/SupplyPanel.vue`

- 删除 `:1101-1105` 的解释性长段（`RuleNote` 内的 `<p class="muted">`）；规则号已由 `RuleNote` 标题与 `RuleTip` 承载。
- `CounterPicker` 的 `title/hint` 改为：`title="来源（图上点格，或在此选）"`、`hint="同格并列时在此点选"`。
- 保留来源分组、悬停预览（`hoverSource`）、「已选来源」行、付款站阵列与余额展示。

### 4.5 不做

- 不改 `src/engine`、`src/data`；不新增存档字段；不改 12.3/12.6 判据与 `chooseSupplySource` 引擎函数。
- 不动 `SupplyPhasePanel.vue`（D 段总计划）与加油入口 `payFuel`。

## 5. 先红后绿（测试）

新增 `tests/stores/supply-source-map-pick.test.ts`（夹具沿用 `supply-interaction-flow.test.ts`：真实地图 `CORE_HEX` + 真实单位库 + `setPhase('supply')`）：

1. 进入 `selectSource` 后 `supplyPickSourceHints` 的格集合 = `supplySources` 中 `ok && dump/hqThrow` 的格集合；不含 `ok === false`、不含 `hex === null`。
2. 点可点来源格 ⇒ `chosenSource` 指向该来源、`step === 'pickup'`。
3. 再点同一格 ⇒ `chosenSource === undefined`、`step === 'selectSource'`。
4. 点 `ok === false` 的来源格 ⇒ 状态不变、`log[0]` 含该来源 `rule`；返回 `true`。
5. 点 `ok === true` 但 `baseSource` 的格 ⇒ 状态不变、日志一行（12.1b/12.3a），返回 `true`。
6. `step === 'done'` 或未开检查时点来源格 ⇒ 返回 `false`（不拦截常规分派）。
7. 点无来源的格 ⇒ 返回 `false`。
8. 同格两条可用来源（造两枚 HQ 同格或 dump+同格 HQ 的可行夹具；若真实数据不可造，则用 `supplyState` 直接注入两条同格来源后断言不隐式选）⇒ `chosenSource` 不变、日志含「并列」。

`tests/render/supply-overlay.test.ts` 补一条：`supplyPick` 经 `cullOverlay` 按可见性过滤；`payHints` 循环包含 `supplyPick`（可用纯函数级断言，不起画布）。

回归：`tests/stores/supply-panel-picker-flow.test.ts`、`tests/stores/supply-interaction-flow.test.ts`、`tests/flows/40-phase-d-supply.test.ts`、`tests/stores/hex-pick.test.ts`。

## 6. 六门槛（cwd `D:\OCS\smolensk`，报实数）

```
npm run lint
npm run format:check
npm run typecheck
npx vitest run --maxWorkers=4
npm run arch
npm run build
```

另报 `git diff --stat 7b6fd31 -- src/engine src/data` 必须为空。

## 7. 提交与推送

- 单独提交（测试 + 实现同一提交或红/绿两提交，按实际执行），推 `origin/codex/command-table-ui`。
- 文档（本 spec 与 tasks）同批并入 `main`：`git checkout main` → `git merge --ff-only <sha>` → `git push origin main`，非 force；回报 HEAD 与工作区状态。

## 8. 需要拍板（实施前请确认）

1. **同格并列来源**：地图不隐式择一，只高亮并提示回面板点选——是否接受该口径（spec 默认如此）。
2. **面板来源分组清单**：保留为并列/回退入口，仅删解释长段——是否与「面板只要标题 + 必要数字」冲突到需要整段移除。
3. **P1-02 首屏 508 ms**：本批只做 ⑦，性能拆分另立批次——是否同意。
4. **P1-01 人工签收**：需用户上机逐剧本走查，我不代签——确认留待用户。
