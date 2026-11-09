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
- [x] T10 六门槛（第 1 批）：lint 0 / format ok / typecheck 0 / vitest 404 文件 4792 通过 1 跳过 / arch 通过 / build 1.32s 2,666kB
- [x] T11 提交推送（第 1 批）：`b658eb8`；`git diff --stat cbea7c8 -- src/engine src/data` 为空
- [x] T12 文档并入 main（第 1 批）：`--ff-only` 已推送

## 第 2 批：右键敌方单位 ⇒「低空扫射」

- [x] T20 红测：`tests/stores/enemy-counter-hip-shoot-menu.test.ts` 六例；撤实现验证前两例先红
- [x] T21 store：`hipShootEntryEligible`（环节闸 + 14.2f + 2.2a/3.2a + 10.0b 观察员 + 有能力的机在航程内）
- [x] T22 地图：`enemyCounterAt`（战雾可见）；`counterActionsAt` 敌方分支只给「低空扫射（14.7d）」
- [x] T23 地图：`onHexContext` 本方优先、无本方时取敌方；`contextOptions` 标题取敌名
- [x] T24 执行：`openContextAction` 的 `hipShoot` 落到 `setAirActive/setAirMissionKind/setAirTargetFromText`
- [x] T25 回归：`context-menu-capabilities`、`map-view-session`、`unit-action-session`、`air-box-entry` 全绿
- [x] T26 六门槛（第 2 批）、提交推送 `bd6322b`、并入 main

## 第 3 批：右键己方单位 ⇒ 能力菜单

- [x] T30 红测：`tests/stores/own-counter-ability-menu.test.ts` 七例；撤实现验证四例先红
- [x] T31 store：`transportLoadReadyAt` / `transportUnloadReadyAt` / `transportHandlingReadyAt`（复用 13.2f/13.2g 引擎校验）
- [x] T32 地图：`facilityActionKeysNow`；`unitActionOptions` / `unitActionAvailableAt` / `unitActionFamily` / `counterActionsAt` 统一走它
- [x] T33 回归：`transport-load-flow`、`context-menu-capabilities`、`unit-action-session`、`map-view-session`、`facility-*`
- [x] T34 六门槛（第 3 批）与提交推送 `b74c00d`、并入 main

## 第 4 批：同格未归属 SP 单列 + 告警

- [x] T40 红测：`tests/stores/supply-same-hex-unassigned.test.ts` 六例（第三本账 / 告警 / 来源三行 / 地图 `?` 令牌 / 纯未归属仍合并 / 失效期照旧合并）；先红（4 例失败，`G 4 SP` 被并成 `G 6 SP`）后绿
- [x] T41 账本：`addSpAtHex` 同格 G/H 并存时未带集群另立第三本账；日志 `3.4b` warning 区分「漏归属」；单集群/纯未归属仍按 12.1a 并入
- [x] T42 地图：`spDumpTokens` 未归属组标 `?`（令牌约 36px，三汉字会溢出；面板/日志仍写全称）
- [x] T43 渲染：`collapsedStackViews` 2–3 枚 SP 并排同高（3 枚 0.64 / spread 0.32）
- [x] T44 六门槛（第 4 批）、提交推送、并入 main
