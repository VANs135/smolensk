# 任务清单：3.4 族规则（3.4b 开关 / 3.4a 常开 / 19 Aug 失效）

> 顺序执行；每个任务先写红测再改实现。3.4a 的触发窗口（§5 A/B）未定前，T4 的 DG 入口只做「有义务即可投」，不得扩大相位范围。

## T0 冻结现状与基线

- [x] 在 `D:\OCS\smolensk` 记录当前六门槛基线（只报数，不改代码）。
- [x] 确认工作树无既有代码改动（仅新增规格文档）；确认本批不新增持久化字段、不动 `src/data`。

验收：六门槛基线实数、`git status` 干净。

## T1 初设：删除按线预填，改为玩家逐站选归属

- [x] 红测：改 `tests/stores/setup-sp-ownership-commit.test.ts`，加入「自动初设后 `spAssignments` 为空」「未选满 `confirmSpOwnership()` 失败且原因 `spOwnershipMissing`」「线北格指派 guderian 不被线改回」。
- [x] 跑定向用例，确认红。
- [x] 改 `src/stores/setup.ts`：删 `defaultPanzerGroupOf` / `fillDefaultPanzerGroups` 及调用；**保留** `defaultFilledIds` 存档字段（不再填充）；`confirmSpOwnership` 不再预填。
- [x] 改 `src/components/setup/SetupPanel.vue:506-512`：删除「已按分界线自动填好默认归属…不必逐个点名」，改为「分界线只提示，不参与判定；每站必须选，未选不能核验/开局」。
- [x] 跑定向用例至绿。

验收：3.4b 关闭时行为不变；开启时未选满不能开局；所选归属与分界线无关。

## T2 到货 SP：未选归属不得落账

- [x] 红测：新增 `tests/stores/supply-arrival-panzer-group.test.ts`，覆盖「开启+轴方+未选 ⇒ 拒绝且账本不变」「逐格选 ⇒ 落账并写归属」「关闭 ⇒ 不选也落账」「18→19 边界」（苏方由 `activeSide==='axis'` 条件覆盖）。
- [x] 跑定向用例，确认红（旧 workbench 下未选也落账，返回 true）。
- [x] 改 `src/stores/workbench.ts`：
  - `addSpAtHex` 接受可选 `panzerGroup`；新建/并入时按 §7.2 写归属，已有归属不覆盖。
  - 新增瞬态 `arrivalSpGroups`、`arrivalSpGroupTargets`、`setArrivalSpGroup`、`clearArrivalSpGroups`。
  - `applySupplyArrivalsNow` 在开启+轴方时逐目标校验；任一未选整笔拒绝；成功后清空选择。
- [x] 改 `src/components/reinforcement/ReinforcementPanel.vue`：在到货段落加逐格归属下拉/只读标签与一句提示，不加长说明。
- [x] 跑定向用例至绿。

验收：未选不落账；选了才落；3.4b 关闭与 19 Aug 起行为与现状一致。

## T3 19 Aug 失效回归

- [x] 红测/补测：新增 `tests/stores/panzer-group-expiry.test.ts`，覆盖 15 Aug 生效、19 Aug 失效、历史归属保留、错集群付款解除、归属界面条件为假（轨道无 18 Aug，边界口径由引擎 `date >= 1941-08-19` 钉住）。
- [x] 不改 `timing.ts` / `panzer-groups.ts:346`（现有判据正确）；若测试暴露口径不一致，只改调用点，不另建时间表。
- [x] 跑定向用例至绿。

验收：18/19 边界断言指到 3.4 / `isPanzerGroupConstraintLifted`；失效后历史标记不被清空。

## T4 3.4a：文案修正 + DG 落盘入口

- [x] 红测：新增 `tests/stores/panzer-group-dg.test.ts`，覆盖「义务内单位可投 DG」「非义务单位被拒」「19 Aug 后无义务被拒」。
- [x] 跑定向用例，确认红（现状无入口/无方法）。
- [x] 改 `src/components/exclusive/ExclusiveRulesPanel.vue:226-229`：Guderian＝沿线或以南，Hoth＝沿线或以北；保留 19.xx 以西豁免与非多单位编队豁免。
- [x] 改 `src/stores/workbench.ts`：新增 `applyPanzerGroupDgNow(unitId)`，校验义务名单，调用 `applyDgToUnit`（5.10），记 3.4a 日志与结算事实。
- [x] 改 `ExclusiveRulesPanel.vue`：义务行下给该编队可选单位按钮；仅在动作可写时显示。
- [x] 跑定向用例至绿。
- [ ] **等待 §5 裁定**：A（所有相位末）或 B（轴方 C/G 段末）。裁定后若选 A，再单独扩 `panzerObligationActive` 与「本相位已结算」台账；选 B 则保持现状。

验收：3.4a 不依赖 3.4b 开关；越线/相邻义务可实际落 DG；文案不再写反。

## T5 全量回归与六门槛

- [x] 跑受影响既有用例：`arrival-hand-flow` 6、`free-rail-arrival-flow` 8、`setup-flow` 28、`panzer-group-sp-flow` 21、`b37-boundary-flow` 8、`exclusive-session` 6、`save-slot` 23、`tests/data/scenarios.test.ts` 42、`tests/engine/panzer-groups.test.ts` 17 全绿。
- [x] 六门槛：lint 0 错；format:check 全通过；typecheck 0 错；vitest 402 文件 / 4772 passed / 1 skipped；arch 组件 50 / 样式 53 / 源码 686 / CSS 变量 91 / 零调用白名单 27；build 1.43s，2,662.15 kB，gzip 571.86 kB。
- [x] 核对 `src/engine`、`src/data` 改动为 0；无新增持久化字段（`arrivalSpGroups` 为瞬态）。

## T6 提交与推送

- [x] 单独提交（代码 + 测试 + 规格变更），提交信息写清三项行为与「不强制均分」的现状。
- [x] `git push` 到 `codex/command-table-ui`；报提交号与推送结果。

## 明确未做（记录，不实现）

- 3.4b「Supply Table 到货均分」：引擎只有 `splitSupplyTableSp` 展示，未接入到货校验；按用户要求**如实报告缺口，不臆造规则**。
- 手工新增 SP、方面军预备队：仍走「待归属」面板，不在本批强制。
- 不新增/改名共识条目；`src/data` 不动。
