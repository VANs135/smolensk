# 界面硬伤整改与打磨 — 规格

日期：2026-11-20　状态：待批　范围：`src/components/**`、`src/styles/**`、`src/stores/theme.ts`、`src/render/**`（只改呈现，不动规则与文案语义）

## 0. 问题与目标

**现象**：实机走查（Edge 无头 + Playwright 脚本，1600/1280/1024 三档 × 浅深两套皮肤）发现 5 处**功能级**硬伤：文字隐形、控件被遮挡、文案被裁、内部键外泄、深色底板漏白。另有 7 处观感/一致性瑕疵。

**目标**：5 处硬伤全部消除，且**可回归**——不是"改完看一眼"，而是 6 条机器判据从 6/6 FAIL 变成 6/6 PASS：

| 判据  | 内容                                                                               |
| ----- | ---------------------------------------------------------------------------------- |
| UI-1  | 浅色主题下环节条"当前环节"文字对背景 ≥ 4.5:1；且语义色不得压在 `accent-solid` 底上 |
| UI-2  | toast 与顶栏「存档/读档」矩形不重叠（剧本页、棋桌）                                |
| UI-3  | 初设飞机提示 `scrollWidth ≤ clientWidth`（不裁字）                                 |
| UI-3b | 战报每行不含内部键（`answer` 等 66 个）                                            |
| UI-5  | 深色主题下地图外围底板为深色（无浅色白框）                                         |
| UI-4  | 战报动作标签走中文映射，未知键显示"未分类"                                         |

判据脚本：`scripts/ui-regression.mjs`（本机 Edge + `playwright-core`），当前实测 **6 项全 FAIL**。

**纪律**：一个 commit 只修一组问题；每 commit 单独 push；不改规则数值、不改文案语义（文案改写另开批次）。

---

## 1. 已读代码事实（定位依据）

| 位置                                    | 事实                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `FlowStrip.vue:598-603`                 | `background: var(--color-accent-2)` + `color: var(--color-accent)`；浅色下两色都是深色 → 实测 **1.15:1** |
| `ToastHost.vue:29-32`                   | `position:fixed; top:var(--space-5); right:var(--space-5); z-index:var(--z-toast)`（300）                |
| `DecisionQueue.vue:627 / :666`          | 父容器单行；`.queue__hint` 不换行 → 实测 `scrollWidth 213 / clientWidth 165`，「入盒」丢失               |
| `SettlementLogPanel.vue:237 / :159-160` | 直接渲染 `{{ entry.action }}`；筛选下拉同样裸键 → 每行显示 `answer`                                      |
| `map-render.ts:168 / :501`              | board 常量 `#f6f4ee`；`fillStyle = options.boardColor ?? MAP_PALETTE.board`                              |
| `MapCanvas.vue:526`                     | 仅 android 传 `boardColor:'#141712'`，桌面深色不传                                                       |
| `MapCanvas.vue:603-605`                 | `sizeChanged && !userAdjusted → fitToWindow()`：开 498px 抽屉时地图 20%→17%                              |
| `DecisionQueue.vue:963`                 | `queue__stack-btn { min-height: 24px }`                                                                  |

**令牌实测（浅色 / 深色）**：`bg #f2efe7 / #101820`、`panel #f8f5ee / #16232d`、`ink #26231e / #eef5f6`、`muted #6b665c / #a3b7c2`、`teal #2f6b5f / #78e2ce`、`amber #8a6420 / #ffc576`、`danger #8c2f22 / #ffada8`、`accent-solid #3d5f4d / #244840`、`on-accent #f7f4ec / #eef5f6`。

**对比度实测（浅 / 深）**：`ink/bg` 13.62 / 16.21；`muted/bg` 4.97 / 8.61；`on-accent on accent-solid` 6.49 / 9.17；**`teal on accent-solid` 1.15 / 6.54、`amber` 1.33 / 6.50、`danger` 1.16 / 5.68** —— 浅色下三种语义色压在强调底上全部不可读，深色下全部可用，这是系统性缺陷而非单点。

---

## 2. P0 / P1 五处硬伤

### 2.1 环节条"当前环节"隐形（UI-1）

改 `FlowStrip.vue:598-603`：`aria-current` 徽标前景改用 `on-accent` 家族（浅 6.49 / 深 9.17）。**不要就地换一个颜色了事** —— 见 §3 的两条硬规则。

### 2.2 toast 压住「存档/读档」（UI-2）

```css
/* ToastHost.vue */
.toast-host {
  top: var(--toast-top, var(--space-5));
}
```

棋桌 root 设 `--toast-top: 112px`（`Teleport` 到 `body`，挂 `.gt` 上继承不到），剧本/首页设 `72px`。备选：常驻左下角。**二选一，别做半透明压住。**

### 2.3 初设飞机提示被裁（UI-3）

`.queue__hint` 加 `white-space: normal`，父容器允许两行；不再用 `overflow:hidden` 掩盖。

### 2.4 战报漏内部键（UI-3b / UI-4）

`SettlementLogPanel.vue` 引入 `SETTLEMENT_ACTION_LABELS`（66 键，见附录 A），`:237` 与筛选下拉都走映射；**未知键一律显示"未分类"**，并在测试里逼着补表（禁止"原样回显"后门）。

### 2.5 深色主题地图外围白框（UI-5）

`map-render.ts` 导出 `DARK_BOARD_COLOR = '#101820'`（与 `--color-command-bg` 深色值同步，画布读不到 CSS 变量），`MapCanvas.vue` 在非 android 的深色下也传；加守卫测试断言两处常量一致。**地图纸面不要整体压暗**（扫描件压暗会脏）。

---

## 3. 设计系统两条硬规则（治本）

1. **`accent-solid` 底上只允许 `on-accent` 前景**：语义色（teal/amber/danger）一律不得作为 `accent-solid` 上的文字色。
2. **语义色做文字时，必须自证对比度**：新增配对要在 `tokens.css` 旁注释实测值。

守卫测试读 `tokens.css`，解析两套皮肤，断言上述两条；这条测试才是防复发的关键（现有测试只覆盖正文/次要/链接，没覆盖"语义色压强调底"这一族）。

---

## 4. P2 七条打磨（可一批做完）

| 编号 | 问题                                                                       | 改法                                                            |
| ---- | -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| P2-1 | 剧本列表 Intro 行 id 列 40px@x228–268 与日期贴字、行高 79px（其余约 60px） | 给 id 列与日期列定宽，行高统一                                  |
| P2-2 | 开 498px「盒表」抽屉后地图 20%→17%                                         | 缩放只在用户未手动调过时 fit；`userAdjusted` 一旦为真不再自动缩 |
| P2-3 | 抽屉「堆叠」按钮 `min-height:24px` 偏小（实测判据之一）                    | 抬到与其它次级按钮一致（≥32px）                                 |
| P2-4 | 面板标题后 4 个裸 `?`                                                      | 统一为带 `aria-label` 的提示控件                                |
| P2-5 | 盒表抽屉 90% 空白                                                          | 空态文案 + 分组骨架，不要空抽屉                                 |
| P2-6 | 偶发首帧左侧 144px 黑带（重绘后消失，复现不稳定）                          | 首帧前先 `fitToWindow`，或首帧不画、等尺寸就绪                  |
| P2-7 | 深色主按钮层级偏弱                                                         | 深色 `accent-solid` 对比底不够，提亮一档并复核文字对比          |

---

## 5. 验收矩阵

每格只看三件事：**文字有没有被切、控件有没有被盖、深色下还有没有亮块**。

- 尺寸：1600 / 1280 / 1024
- 皮肤：浅色 / 深色
- 页面：首页、剧本列表、初设（含飞机阵列）、棋桌（四抽屉各一次）、战报抽屉

机器验收：`OCS_PW_DIR=<playwright-core 目录> node scripts/ui-regression.mjs` → **6/6 PASS**，并产出 `ui-shots/` 对比图。

---

## 6. 提交节奏（3 个 commit，各自可回滚、各自单独 push）

| commit                                                           | 内容                               | 验收             |
| ---------------------------------------------------------------- | ---------------------------------- | ---------------- |
| ① `fix(ui): 环节条对比度 + toast 避让顶栏`                       | UI-1、UI-2 + 令牌守卫测试          | UI-1 / UI-2 PASS |
| ② `fix(ui): 初设提示换行 + 战报动作中文化 + 深色底板`            | UI-3/3b、UI-4、UI-5 + 两条守卫测试 | 6 项全 PASS      |
| ③ `polish(ui): 剧本行/抽屉缩放/分组头/规则提示/盒表/首帧/主按钮` | P2-1 ~ P2-7                        | 截图矩阵人工核对 |

门禁：`npm run check`（含 `test:fast`，约 250s）。

---

## 7. 风险与注意事项

1. **`--toast-top` 必须挂 `:root`**：`ToastHost` 走 `Teleport`，挂在 `.gt` 上不生效。
2. **深色底板别顺手压暗纸面**：先只换外围，再按截图评估是否加 ≤8% 压暗。
3. **`DARK_BOARD_COLOR` 是常量镜像**：必须靠守卫测试锁定与令牌一致。
4. **战报标签别用"未知键原样"**：等于留后门，未知一律"未分类"。
5. **只改 `aria-current` 不够**：病在"语义色压强调底"，守卫测试才是治本。
6. **P2-2 改缩放要回归移动**：必做实拖一次 + 四个抽屉开合，确认无缩放跳变与视口跑偏。

---

## 附录 A：66 个结算动作键

`acceptOutOfSupply`、`airBaseCapture`、`airBaseReduce`、`airCargo`、`airCargoLoss`、`airCargoReturn`、`airCombat`、`airFlak`、`airIntercept`、`airInterceptCombat`、`airMission`、`airMissionResolve`、`airRefit`、`airReturn`、`airSupplyLoad`、`airSupplyReturn`、`airTransfer`、`airUnitLoad`、`answer`、`arrival`、`arrivalRail`、`attack`、`attritionRoll`、`barrageDeclare`、`barrageDice`、`barrageOutcome`、`barrageShifts`、`barrageSupply`、`breakdown`、`breakoutAttempt`、`cancel`、`cleanUp`、`combatAdvance`、`combatAr`、`combatDice`、`combatLosses`、`combatOptions`、`combatRetreat`、`combatSupply`、`combatSurprise`、`combatTerrain`、`consolidate`、`eatOffTheMap`、`engineer`、`frontalReserves`、`fuel`、`manualRoll`、`move`、`offMapSupplyDeposit`、`overrun`、`panzerObligationDg`、`place`、`railMove`、`rebuild`、`reserveRelease`、`securityNeeds`、`slowMobilizationUnlock`、`specialCombat`、`specialRepl`、`supplyArrival`、`supplyCache`、`supplyOos`、`supplyPickup`、`supplyTrace`、`supplyTrain`、`transportLoad`、`transportUnload`、`variableExit`、`variableRepl`（共 66 个，中文标签按规则书动作名逐条核定）。
