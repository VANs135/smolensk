# 同格多 SP / 右键菜单 · 任务清单

- [x] T0 基线：`git rev-parse HEAD` 记 `cbea7c8`；`git status --short` 仅本批改动；`src/engine`、`src/data` 零改动
- [x] T1 红测：`tests/stores/supply-same-hex-panzer-group.test.ts` 九例（同格一条来源 / 失效期合并 / 双集群二选一 / 单集群自动 / 编队错集群拒付 / 编队自动本集群 / 苏军无选择 / 8.19 后无选择 / 地图两枚令牌）
- [x] T2 红测：`tests/stores/supply-source-map-pick.test.ts` 并列用例改为「同格一个站、直接取一条」
- [x] T3 账本：`addSpAtHex` 在 3.4b 生效时同格两集群分账，未归属/未带集群仍并入
- [x] T4 store：新增 `supplySourceGroups`（同格折一条，3.4b 按集群展开）并导出
- [x] T5 store：`pickSupplySourceAtHexNow` 去并列；`supplyPayDumpCandidates` dump 双集群候选；`resolvePayDump` 按选择/本集群/首条；`confirmSupplyPickupNow` 3.4b 闸门
- [x] T6 地图：`spDumpTokens` 按集群拆两枚（G/H 标注，失效期并回）；`counterActionsAt` 前缀匹配
- [x] T7 渲染：`collapsedStackViews` 两枚 SP 并排 0.74
- [x] T8 面板：`sourceItems` 按格去重；`payDumpItems` 标注集群
- [x] T9 转绿：T1/T2 全绿；回归 `supply-panel-picker-flow`、`supply-interaction-flow`、`40-phase-d-supply`、`hex-pick`、`panzer-group-sp-flow`、`panzer-group-expiry`、`panzer-group-dg`、`sp-dump-same-hex-merge`、`sp-map-projection`、`sp-ownership-load-merge`、`supply-arrival-panzer-group`、`carried-sp-source`、`setup-sp-merge`、`supply-overlay`、`supply-reachability-flow`
- [ ] T10 六门槛：lint / format:check / typecheck / vitest --maxWorkers=4 / arch / build，报实数
- [ ] T11 提交推送：单独提交；`git diff --stat cbea7c8 -- src/engine src/data` 为空；推 `origin/codex/command-table-ui`
- [ ] T12 文档并入 main：`--ff-only` 合并并推送，非 force，回报 HEAD 与工作区状态
