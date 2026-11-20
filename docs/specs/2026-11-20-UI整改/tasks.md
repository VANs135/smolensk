# 界面硬伤整改与打磨 — 任务分解

日期：2026-11-20　状态：待批　配套：`spec.md`

> 门禁 `npm run check`（约 250s，不含 AI 套件）；每完成一条 commit 即 push，不攒到最后。

## 0. 前置

- [ ] `npm i -D playwright-core`，`ui-regression.mjs` 改成本地解析（去掉对 `OCS_PW_DIR` 外部目录的依赖）
- [ ] 把回归脚本放 `scripts/ui-regression.mjs`，跑一次确认**基线为 6 项全 FAIL**

## 1. commit ①：对比度与遮挡

- [ ] `styles/tokens.css` 核对两套皮肤语义色与 `accent-solid` 的配对（附实测值注释）
- [ ] `FlowStrip.vue:598-603`：`aria-current` 前景改 `on-accent` 家族
- [ ] 新增 `tests/styles/tokens-contrast.test.ts`：解析 `tokens.css`，断言「`accent-solid` 底上只允许 `on-accent`」与「`color-accent` on `color-accent-2` ≥ 4.5」
- [ ] `ToastHost.vue`：`top: var(--toast-top, var(--space-5))`
- [ ] 棋桌 `--toast-top: 112px`（挂 `document.documentElement`），剧本页/首页 `72px`
- 验收：`ui-regression.mjs` → UI-1 / UI-2 PASS；浅深两套各截一张环节条

## 2. commit ②：裁字、内部键、深色底板

- [ ] `DecisionQueue.vue:666` `.queue__hint` 允许换行，父容器两行
- [ ] `SettlementLogPanel.vue`：引入 `SETTLEMENT_ACTION_LABELS`（66 键），`:237` 与 `:159-160` 全部走映射，未知键→"未分类"
- [ ] `map-render.ts` 导出 `DARK_BOARD_COLOR`；`MapCanvas.vue` 深色下传 boardColor（android 保持 `#141712`）
- [ ] 守卫测试：`DARK_BOARD_COLOR === tokens.css` 深色 `--color-command-bg`
- 验收：6 项全 PASS；深色 1600/1280/1024 三张 + 浅色回归一张

## 3. commit ③：七条打磨

- [ ] P2-1 剧本列表：id 列与日期列定宽，行高统一
- [ ] P2-2 `MapCanvas.vue:603-605`：`userAdjusted` 为真后不再自动 `fitToWindow()`
- [ ] P2-3 `DecisionQueue.vue:963` `min-height` 抬到 ≥32px
- [ ] P2-4 面板标题后 4 个裸 `?` 改为带 `aria-label` 的提示控件
- [ ] P2-5 盒表抽屉空态文案 + 分组骨架
- [ ] P2-6 首帧左侧黑带：首帧前先 `fitToWindow`，或等尺寸就绪再画
- [ ] P2-7 深色主按钮提亮一档并复核文字对比
- 验收：截图矩阵人工核对 + `ui-regression.mjs` 仍 6/6 PASS

## 4. 收尾

- [ ] `docs/待办清单.md` 更新
- [ ] 三个 commit 合并 `main`，PR 附 6/6 PASS 截图
