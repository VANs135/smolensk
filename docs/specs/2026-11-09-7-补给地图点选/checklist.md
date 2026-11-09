# ⑦ 补给地图点选 · 检查清单

- [x] 地图是主入口：点受补给单位后，来源格在地图上高亮；点格即选定（7）
- [x] 再点已选来源同格即取消，退回 `selectSource`（7 / 12.3）
- [x] 高亮集合不多不少：只含 `ok && dump/hqThrow` 的来源格，一格一条（12.3a / 12.3b）
- [x] 不可用来源点不动，只出一行带规则号的原因；无来源格不拦截（12.1b / 12.3a）
- [x] 同格并列来源不隐式择一，提示回面板点选（7-3）
- [x] 组件不写规则：判据全部复用 `supplySources` / `isSpBearingSource` / `chooseSupplySourceNow`
- [x] `src/engine`、`src/data` 零改动（`git diff --stat 7b6fd31 -- src/engine src/data` 为空）
- [x] 无新增存档字段：选源态沿用 `supplyState` / `supplyPreviewIndex`
- [x] 面板删解释长段，`CounterPicker` 文案改为「图上点格，或在此选」（标题 + 必要数字）
- [x] 先红后绿：`supply-source-map-pick` 8 例 + `supply-overlay` 2 例，转绿前后均有记录
- [x] 回归：`supply-panel-picker-flow` / `supply-interaction-flow` / `40-phase-d-supply` / `hex-pick` 全绿
- [x] 六门槛：lint、format:check、typecheck、vitest（403 文件 / 4783 通过）、arch、build 全过
- [x] 单独提交推送；文档同批并入 `main`（`--ff-only`，非 force）
