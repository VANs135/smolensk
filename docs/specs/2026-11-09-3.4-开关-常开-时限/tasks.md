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
- [x] 六门槛：lint 0 错；format:check 全通过；typecheck 0 错；vitest 402 文件 / 4773 passed / 1 skipped；arch 组件 50 / 样式 53 / 源码 686 / CSS 变量 91 / 零调用白名单 27；build 1.37s，2,663.21 kB，gzip 572.11 kB。
- [x] 核对 `src/data` 仅按授权改共识条目文字；无新增持久化字段（`arrivalSpGroups` 为瞬态）。

## T6 提交与推送

- [x] 单独提交（代码 + 测试 + 规格变更），提交信息写清三项行为与均分口径。
- [x] `git push` 到 `codex/command-table-ui`；报提交号与推送结果。

## T7 3.4a 读法 A（所有相位末，含苏军）

- [x] 红测 `tests/stores/b37-exclusive-timing.test.ts`：闸门 `where` 不按方限定、含 combat/supply；苏军移动末、轴方战斗末、苏军补给末均放行，段中不放行。
- [x] 改 `src/stores/workbench-model.ts` 的 `exclusive.panzerObligation.where`：覆盖所有玩家相位末、去掉 `sides`，反应段单列 `role: 'nonActive'`。
- [x] 定向跑绿；更新 `panzerObligationActive` 注释为读法 A。
- [x] 在读法 A 说明里写清触发时机、检查对象、越线与同堆叠相邻判法（spec.md §7.5）。

## T8 3.4b 条目文案

- [x] 改 `src/engine/rules/panzer-groups.ts` 的 `PANZER_GROUP_OPTION_ITEM` 为「3.4b SP 须按装甲集群分配」。
- [x] 改 `src/data/scenarios.json` 同一文字（**仅文字**，位置与默认值不动），说明数据改动原因。
- [x] `tests/data/scenarios.test.ts` 同源断言保持绿。

## T9 3.4b Supply Table 均分

- [x] 回原文核对：均分对象是 **Supply Table arrivals**，数量关系可判定（7 ⇒ G4/H3）；初设按 Setup Note F 自由决定，不判。
- [x] 红测 `tests/stores/supply-arrival-panzer-group.test.ts`：2 SP 全给 Hoth ⇒ 拒绝；G1/H1 ⇒ 落账。
- [x] 改 `applySupplyArrivalsNow`：剔除 `supplyTrain` 后按 `splitSupplyTableSp(tableSp)` 校验，不等即整笔拒绝并记 3.4b。
- [x] 定向跑绿。

## 明确未做（记录，不实现）

- 初设均分：Setup Note F 原文 "player can freely decide ownership of dumps" ⇒ 初设只要求逐站归属，不判 4/3。
- 补给列车（3.6）不进均分：3.4b 的均分对象只有 "Supply Table arrivals"。
- 手工新增 SP、方面军预备队：仍走「待归属」面板，不在本批强制。
- 不新增持久化字段；`src/data` 仅按授权改上述文字。
