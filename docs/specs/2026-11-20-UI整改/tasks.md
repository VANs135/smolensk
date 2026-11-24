# 界面硬伤整改与打磨 — 任务分解

日期：2026-11-20　最后更新：2026-11-25　配套：`spec.md`

> 门禁 `npm run check`（约 250s，不含 AI 套件）。2026-11-25 夜间口径：**先做完整套 UI 改动再 review**，
> commit 按"可回滚的一组"切；push 待凭据确认后统一补。

## 0. 前置

- [x] `npm i -D playwright-core`（已进 `package.json`）
- [ ] `scripts/ui-regression.mjs` 建脚本并跑基线（**仍未做**，见 §5）

## 1. commit ①：档位与入口收敛（`51f13b9`）

- [x] 缺省窗宽 430：`MapDock` 缺省宽、`VictoryDialog` `width="430px"`
- [x] 存档窗 620：`SaveLoadDialog` `width="620px"`
- [x] 存档入口只留两处：对局台左栏最下、开始台顶栏；`HomeView` 主区「读取存档」删；待答面板 footer 删
- [x] 左栏压在待答遮罩之上：`.gt__rail { z-index: calc(var(--z-panel) + 10) }`
- 验收：`vue-tsc` / `eslint` / `prettier` 全绿

## 2. commit ②：表进左栏 + 托盘只剩盒段（`5e040db`）

- [x] 新增 `src/components/game/ChartTableDrawer.vue`：四 chip（CRT / 补给与补员 / TEC / 变量与事件）、初值 `null`、只画印卡
- [x] `GameTableView`：抽屉 `cards`→`charts`（标签「表」）；安卓快捷菜单同步「表」
- [x] `BottomTray`：删表段与两段互斥；只剩盒段，`setup.applied` 后常驻地图下方（`gt__tray-dock`）
- [x] 重建教学不再代开抽屉；文案「盒表」→「盒」
- [x] 守卫测试改靶（表抽屉 / 托盘盒段），判据不放松

## 3. commit ③：五处硬伤（`d4e0bd6`）

- [x] UI-1 `FlowStrip`：当前步 `accent` 底 + `on-accent` 字
- [x] UI-2 `ToastHost`：`top: 72px`（顶栏约 64px），宿主 `pointer-events:none` 保留
- [x] UI-3 `DecisionQueue`：空军选机提示去 `nowrap/ellipsis`
- [x] UI-3b / UI-4：`src/render/action-labels.ts`（70 键），战报三处统一，未知键「未分类」
- [x] UI-5：`MapCanvas` 可选 `boardColor`，深色传 `#141712`
- [x] 删 `QuestionPrompt` 遗留 `.prompt__footer`
- [x] 新增 `tests/render/action-labels.test.ts`

## 4. 打磨（commit ④）

- [x] P2-3 `.queue__stack-btn` `min-height` 24→32
- [x] P2-4 `MapPopover` 与增援面板三处 `?` 补 `aria-label`
- [x] P2-7 深色 `accent-solid` `#244840`→`#2e5a4e`、hover `#3a6d5e`
- [x] 会话窗 `MapDock`：补 `⌄` 收起（状态保留）与 `▣` 不可关
- [x] `tests/render/ui-hardening.test.ts`：UI-1/2/3、P2-3、P2-7 源码守卫
- [—] P2-1 已核：id 列 `space-10` 定宽、行高 `space-12`，无需改
- [—] P2-2 已核：`sizeChanged && !userAdjusted` 闸门在位
- [—] P2-5 废弃：右侧「盒表」抽屉已不存在
- [ ] P2-6 首帧黑带：未复现，挂起

## 5. 收尾（未做）

- [ ] `scripts/ui-regression.mjs`：本机 Edge + `playwright-core` 跑 6 项判据（UI-1/2/3/3b/4/5）
- [ ] 6 槽存档扩槽（用户口径：最后做、优先级低）
- [ ] 安卓壳入口（齿轮菜单存读档、quickBox）随 PC 收口后再动
- [ ] commit 统一 push（`git@github.com:VANs135/smolensk.git`，凭据待确认）

## 6. 已知不动的项

- `map-view.ts` 的 `unit` / `containers` 两个会话分支**保留**：分别是设施动作窗与盒卡"需要窗时"的唯一入口，删了会丢功能。
