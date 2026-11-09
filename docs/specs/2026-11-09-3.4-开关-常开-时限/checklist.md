# 检查清单：3.4 族规则（3.4b 开关 / 3.4a 常开 / 19 Aug 失效）

## 3.4b 可选开关

- [x] 开局共识清单有「装甲集群 SP 归属约束（3.4b，4.1a 可选）」，默认不勾；未勾时初设与到货行为与现状一致（无归属选择、无需点名）。
- [x] 勾选后初设每个轴方补给站必须由玩家选 Guderian / Hoth；未选满 `confirmSpOwnership()` 失败（`spOwnershipMissing`），不能开局。
- [x] 初设归属只认玩家选择，分界线只作提示，不自动改写选择。
- [x] 勾选后到货 SP 未选归属整笔拒绝，账本不新增；逐格选好才落账，并把归属写入 `spDumpPanzerGroups`。
- [x] 归属落到既有 SP 账本，供 `checkPanzerGroupSpPayment` / `checkPanzerGroupSpBeneficiaries` 原文判据使用。
- [x] 未新增持久化字段（`arrivalSpGroups` 为瞬态选择；`spDumpPanzerGroups` 是既有字段）。

## 3.4a 专规（常开）

- [x] 3.4a 判定常开，不读取 3.4b 共识开关；越线 / 同堆叠相邻即产生义务。
- [x] 19.xx 以西豁免、Orsha 以西不触发；非多单位编队（步兵师 / 独立单位）不触发。
- [x] 分界线取 `map-config.json` 的 `[[19,19],[62,23]]` 并参与判定。
- [x] 义务行提供落 DG 入口 `applyPanzerGroupDgNow`：义务名单内可投、非义务单位被拒，走 5.10 的 `applyDgToUnit`。
- [x] 面板文案改为 Guderian 沿线或以南、Hoth 沿线或以北（不再写反）。

## 19 August 失效

- [x] 失效口径：`date >= 1941-08-19` 起 3.4/3.4a/3.4b 全部失效（18 Aug 仍生效）；增援表行 13 / 90 两处与原文一致。
- [x] 失效后 3.4a 不产生义务，DG 入口拒绝。
- [x] 失效后即使勾选 3.4b，也不要求 SP 归属；德军 SP 共用，付款不再受集群限制。
- [x] 失效前已落账的归属标记保留，不被反向改写。

## 数据与门槛

- [x] `src/data`、`src/engine` 改动为 0；`src/data` 无数据需求变更。
- [x] 六门槛全绿：lint、format:check、typecheck、vitest（402 文件 / 4772 passed / 1 skipped）、arch、build。
