# 任务清单（左键堆叠窗极简 + 五项能力进右键）

## 第 1 批：左键窗

- [x] T1 红测 `tests/stores/popup-stack-selection.test.ts` 三例；先红（`toggleStackPick` 不存在）后绿
- [x] T2 `map-view.ts`：`stackPickIds` + `resetStackPicks` + `toggleStackPick`，`openPopup('content')` 时重置
- [x] T3 `MapActionPopover.vue`：只留战斗单位 chip（可点选、默认全选）、删非战斗栏与说明文字
- [x] T4 `MapPopover.vue`：规则号改成 `?`（只在悬停）
- [x] T5 六门槛（第 1 批）、提交推送、并入 main

## 第 2 批：五项能力进右键

- [x] T6 核对五项能力的既有入口与可用判据：12.7 `move.extenderConvert` / 20.0a `move.breakdown` 已在；
      13.9-1 走 `planConsolidation` 预演、12.5 走 `needsFuelOf`；13.5 行键须玩家选 ⇒ 缺口（见 spec §4）
- [x] T7 红测 `tests/stores/context-menu-unit-abilities.test.ts`（10 例）：可用才出现、不可用不出现；
      先红（暂撤实现 3 例失败）后绿
- [x] T8 接线：`mergePartnerAt` / `needsFuelNow`（store）+ 右键「合并单位 / 加油」+ 全局去灰 + 增援段放开右键 + 3.3d 纯判据；规则号只进 `?` 的 `title`
- [x] T9 六门槛（第 2 批）、提交推送、并入 main
- [ ] T10 待拍板：13.5 补员要不要进右键（行键费用不能静默猜）
