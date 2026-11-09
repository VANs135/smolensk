# 同格多 SP 一个站 · 右键菜单（低空扫射 / 己方能力） · 实施规格

2026-11-09 · 分支 `codex/command-table-ui` · 基线 `cbea7c8`

本批三件事，按顺序各自单独提交推送：

| 项  | 内容                                                        | 状态     |
| --- | ----------------------------------------------------------- | -------- |
| 1   | 同格多 SP = 一个补给站；3.4b 下按集群拆算子（含非编队可选） | 本批第一 |
| 2   | 移动阶段右键**敌方**单位 ⇒ 「低空扫射」菜单项               | 本批第二 |
| 3   | 右键**己方**单位 ⇒ 能力菜单（装载/卸载/工程/模式）          | 本批第三 |

约束：`src/engine`、`src/data` 零改动；先红后绿；六门槛报实数；文档与 `main` 同批并入（`--ff-only`，非 force）。

## 1. 同格多 SP：一个补给站（推翻「并列来源回面板选」）

用户裁定（原文）：

- 同一格内的多个 SP 视为**一个来源**，选源只出现一条，不再产生「并列来源」提示。
- 仅当 3.4b 勾选且当前生效（8.19 前）时，同一格 SP 按集群**拆成两个算子显示**（Guderian / Hoth）。
- 该区分**只对德军多单位编队付款生效**；苏联单位、德军非编队单位仍按同一个补给站处理。
- 拆成两个算子后，取用按付款对象所属集群扣对应算子；不属于任何集群的对象可从任一算子扣，累计仍按同格总量。
- 补充裁定：3.4b 生效时德军**非编队**单位在同格 G/H 两份并存时**可二选一**；只有一个集群有 SP 时不弹选择、直接扣。
- 多单位编队仍强制本集群，扣错集群被拒并给条款号 `3.4b`。

### 1.1 事实层（不改）

| 事实       | 位置                                                   | 说明                                           |
| ---------- | ------------------------------------------------------ | ---------------------------------------------- |
| 来源清单   | `workbench.ts` `supplySources`                         | 引擎按账本条目给来源（同格两集群是两条）       |
| 账本       | `spDumps` + `spDumpPanzerGroups`                       | 同格两集群两本账，`panzerGroupOfDump` 取归属   |
| 3.4b 生效  | `panzerGroupRulesOn`（`date < 1941-08-19` × 采纳选项） | 唯一开关                                       |
| 付款闸门   | `panzerGroupSpGate` / `panzerGroupSpRefusal`           | 编队错集群拒付（`fuel`/`combat`/`barrage`）    |
| 付款站候选 | `supplyPayDumpCandidates`                              | 原只服务 12.3b HQ 投递；本批扩到 dump 直接拖取 |

### 1.2 改动清单

`src/stores/workbench.ts`

1. `addSpAtHex`：3.4b 生效时轴方**同格不同集群不合并**（两本账）；未声明归属的站与未带集群的落账仍并入（12.1b 一条账本）。
2. 新增 `supplySourceGroups`（导出）：同格 dump 来源折一条；3.4b 轴方按集群展开成 G/H 两行，`sourceIndex` 指向同一条引擎来源。苏军/失效期/单集群不拆。
3. `pickSupplySourceAtHexNow`：去掉「并列」分支，可点即取第一条来源（12.1b 同格一个站）。
4. `supplyPayDumpCandidates`：新增 dump 分支——3.4b 轴方且同格 `groups.size > 1` 时给出同格两枚候选（G/H），否则空（不弹选择）。
5. `resolvePayDump`：dump 分支按 `supplyInputs.payFromDumpId` → 编队本集群 → 第一条 的顺序取付款站。
6. `confirmSupplyPickupNow`：`fuel`/`combat` 付款前过 `panzerGroupSpGate`，被拒则落 `3.4b` 日志并返回 false。

`src/stores/map-view.ts`

7. `spDumpTokens()`：3.4b 轴方按 `(hex, group)` 拆两枚，id `sp:c,r:guderian|hoth|-`，label `G 4 SP` / `H 3 SP`；失效期自动并回一枚。
8. `counterActionsAt`：SP id 改按格前缀匹配（兼容 `:group` 后缀），找对应账本。

`src/render/token-layer.ts`

9. `collapsedStackViews`：同格两枚 `sp` 令牌并排、`0.74` 尺寸（避免其二被裁掉）。

`src/components/supply/SupplyPanel.vue`

10. `sourceItems`：dump 来源按格去重（一格一条，不再并列）。
11. `payDumpItems`：3.4b 下标注 `（Guderian/Hoth/未归属）`，`selected` 读 `payFromDumpId`。

### 1.3 红测

`tests/stores/supply-same-hex-panzer-group.test.ts`（9 例）

1. 同格两本账（不同集群）⇒ 来源只一条、`supplySourceGroups` 拆两行、点格无「并列」。
2. 8.19 起 ⇒ 合并一条、`group === null`。
3. 双集群并存 ⇒ 非编队德军 `supplyPayDumpCandidates` 两枚；点 `sd-h` 后只扣 H、G 不变。
4. 只有一个集群有 SP ⇒ 候选 0（不弹选择），直接扣该站。
5. Guderian 编队选 Hoth ⇒ 拒付、账本不动、日志含 `3.4b`。
6. Guderian 编队未点选 ⇒ 自动取本集群、Hoth 不动。
7. 苏军同格多份 ⇒ 候选 0、来源一条。
8. 8.19 后 ⇒ 候选 0 可付。
9. 地图：生效期内两枚 `G 4 SP` / `H 3 SP`，失效后一枚 `7 SP`。

`tests/stores/supply-source-map-pick.test.ts`：原「并列」用例改为「同格视为一个站、直接取一条、不出『并列』」。

### 1.4 不做

- 不改 `src/engine`、`src/data`；不另建账本（选择只写 `supplyInputs.payFromDumpId`，扣减仍走既有付款路径与同格总量）。
- 不新增存档字段。

## 2. 移动阶段右键敌方单位 ⇒ 「低空扫射」

口径（用户原文）：

- 只在 `actionAllowedNow` 放行时出现；点击后走既有入口，组件不写判据。
- 观察员等前置条件按 14.7d / 10.0b 复用既有校验；缺前置就不出菜单项，不灰按钮。
- 若原文要求先选机再选目标，菜单项只负责把目标带进去，选机仍在既有会话里完成。

（本项实施细节见 tasks.md T20 起的勾选记录。）

## 3. 右键己方单位 ⇒ 能力菜单

口径（用户原文）：

- 按能力分类，先接：运输队/卡车的装载与卸载、普通单位的装船/上车（若原文明文允许）、既有已实现的工程与模式切换等项。
- 只列当前真正可用的项，判据复用 store 谓词；没有对应入口的能力先报告缺什么，不硬做。

（本项实施细节见 tasks.md T30 起的勾选记录。）

## 4. 六门槛（cwd `D:\OCS\smolensk`）

```
npm run lint
npm run format:check
npm run typecheck
npx vitest run --maxWorkers=4
npm run arch
npm run build
```

另报 `git diff --stat cbea7c8 -- src/engine src/data` 必须为空。

## 5. 提交与推送

每项单独提交、推 `origin/codex/command-table-ui`；文档同批并入 `main`（`--ff-only`，非 force）。
