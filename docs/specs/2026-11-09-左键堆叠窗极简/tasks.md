# 任务清单（左键堆叠窗极简 + 五项能力进右键）

## 第 1 批：左键窗

- [x] T1 红测 `tests/stores/popup-stack-selection.test.ts` 三例；先红（`toggleStackPick` 不存在）后绿
- [x] T2 `map-view.ts`：`stackPickIds` + `resetStackPicks` + `toggleStackPick`，`openPopup('content')` 时重置
- [x] T3 `MapActionPopover.vue`：只留战斗单位 chip（可点选、默认全选）、删非战斗栏与说明文字
- [x] T4 `MapPopover.vue`：规则号改成 `?`（只在悬停）
- [x] T5 六门槛（第 1 批）、提交推送、并入 main

## 第 2 批：五项能力进右键

- [ ] T6 核对五项能力的既有入口与可用判据（转换延补队 / 拆分 / 合并 / 补员 / 加油）
- [ ] T7 红测：可用才出现、不可用不出现（不灰按钮）
- [ ] T8 接线（复用既有 store 入口；规则号只进 `title`）
- [ ] T9 六门槛（第 2 批）、提交推送、并入 main
