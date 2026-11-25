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
- [x] 存档窗：初设中不再铺整段操作说明，只留「初设未确认 · 暂不能存档」一行（`ui-field` 守卫反向钉住长句）
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

## 7. v5 左栏收口（`e256d25`，2026-11-26 用户定稿）

- [x] 用户口径：V3 左侧盒按钮是对的；把「盒」「表」两个字去掉，表只留一枚无字图标排在盒组下面；下方不留栏
- [x] 左栏＝盒组（轴/苏/共 单字小标，一盒一枚 → BoxCard 浮窗）＋ 战况/表/战报纯图标 ＋ 栏底 存档/设置/撤销纯图标（磁盘/齿轮/回转）
- [x] 盒组逻辑与四枚可辨盒图标抽到 `src/components/game/box-rail.ts`（棋桌页触顶 `max-lines`；隔离口径单独守）
- [x] `BottomTray.vue` 删除；`.gt__tray-dock` / `.gt__rail-label` 残留样式清掉；`game/index.ts` 出口同步
- [x] 顶栏右上「开始台」→「☰ 主菜单」（回主页面）；回合 / 阶段 / 流程仍在第二行信息栏（`FlowStrip`）
- [x] `BoxCard` 浮窗居中修正（`translateX(-50%)`）：720 宽不再右溢出视口
- [x] 守卫改靶不放松：p6 / charts-view / box-side-isolation / rail-cap-track / ui-diet-batch6 / ui-hardening(UI-7)
- [x] `npm run check` 全绿（633 文件 / 6348 测试）；arch 组件 58 / 样式 62
- [x] review 收尾（`4cceffa`）：浮窗＝「展开」（盒内动作 / 拆分取用判据改认 `popupCardId`）、记录轨不再弹空窗、关会话一并收浮窗、左栏 44px + 粘底（1400×900 与 1366×768 均一屏）
- [x] 盒窗无留边（v5 小样原话「只有贴图本身，无标题栏、无边框、无留边」）：删标题栏，贴图即拖动把手，右上 26px 半透明圆 ×，透明底 + `drop-shadow`；卡面 `margin 0` / 图圆角 3px；安卓 `.boxpopup` `padding 0`、清掉与 `translateX(-50%)` 叠加的定位覆盖与失效 `.boxpopup__title`；`headerHeight 0` 让整张图夹在视口内
- [x] 顶栏一行（2026-11-26 用户：「顶栏收成一行」）：对局页应用头整条隐藏、品牌与「☰ 主菜单」并入 `FlowStrip` 的 44px 单行；「该做什么」从第二行收进同一行右段，`nowrap` + 窄屏按 日期→提示→分数 让位；顶区 133 → 44
- [x] 宽度收小（用户：「各宽度减小」）：左栏 62 → 46、按钮 44 → 34、图标 22、gap 4、组标签 10px；盒窗 720 → 660；实测 13 枚在 1400×900 与 1366×768 均一屏无滚动（856/856、724/724）
- [x] 撤底部「格 —」视口条 + 缩放竖排右上（用户：「把下面那个格-的这栏去掉，地图缩放按钮从上到下排列在右上方顶栏下部位置」）：`MapCanvas` fill 形态不再渲染 `.mapcanvas__tools`，改 `.mapcanvas__zoomer`——`.mapcanvas` 加 `position: relative`，簇贴右上 8px、顶栏 44 之下，30×30 三键竖排（＋／－／全图）+ 百分比小字；簇在视口之外，点它不连带点格；右栏抽屉打开时随地图宽度左移，地图净得 40px 高
