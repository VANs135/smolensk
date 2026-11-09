# ⑦ 补给地图点选 · 任务清单

- [x] T0 基线：`git rev-parse HEAD` 记 `7b6fd31`；`git status --short` 干净；确认 `src/engine`、`src/data` 零改动
- [x] T1 红测：`tests/stores/supply-source-map-pick.test.ts` 八例（高亮集合 / 点选 / 再点取消 / 不可点一行原因 / 非 SP 来源 / 非选源阶段不拦截 / 非来源格不拦截 / 同格并列不隐式选）
- [x] T2 红测：`tests/render/supply-overlay.test.ts` 补 `supplyPick` 可见性过滤与绘制并入
- [x] T3 实现 store：`supplyPickSourceHints`、`pickSupplySourceAtHexNow`（含取消分支与并列提示），导出 return API
- [x] T4 实现接线：`map-view.ts` overlay 字段 + `onHexClick` 前置分派（在 `handleStackClick` 之前）
- [x] T5 实现渲染：`token-layer.ts` `MovementOverlay.supplyPick`、`cullOverlay`、并入 `payHints` 循环
- [x] T6 面板收字：`SupplyPanel.vue` 删解释长段，改 `CounterPicker` 标题/提示，保留分组与已选行
- [x] T7 转绿：T1/T2 全绿；回归 `supply-panel-picker-flow`、`supply-interaction-flow`、`40-phase-d-supply`、`hex-pick`
- [x] T8 六门槛：lint / format:check / typecheck / vitest --maxWorkers=4 / arch / build，报实数
- [x] T9 提交推送：单独提交；`git diff --stat 7b6fd31 -- src/engine src/data` 为空；推 `origin/codex/command-table-ui`
- [ ] T10 文档并入 main：`--ff-only` 合并并推送，非 force，回报 HEAD 与工作区状态
