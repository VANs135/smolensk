# `stores/workbench.ts` 解构 — 规格

日期：2026-11-20　状态：待批　范围：`src/stores/**`（不动 `engine/`、`data/`、文案与任何规则行为）

## 0. 问题与目标

**现象**：`src/stores/workbench.ts` 单文件 **32,193 行 / 1.38 MB**、707 个内部函数、589 个 `ref+computed`、公开面 1,013 个键。改一行就整文件进 diff 与 blame，冲突面覆盖全部规则域；任何单次阅读（人也好、模型也好）都读不完，回归只能靠 6,254 条用例兜底。

**目标**：facade ≤ 3,000 行；`stores/flows/*` ≤ 3,000 行；`stores/services/*` ≤ 1,500 行；**公开面 1,013 键零漂移**；每个切片能脱离 Pinia 单独单测（`createXxxDomain(ports)` 直接断言）。

**纪律**：

1. 纯搬移，不混逻辑改动与文案改动 —— 每批一次 commit，可单独 revert；
2. 每批门禁为 `npm run check`（`test:fast`，约 250s），**不跑 AI 套件**；全部完成后手动 `npm run check:all` 总回归一次；
3. 不许"拆一半停在工作区"：一批做完即提交并 push；
4. 公开面键名一个都不许改，只许加。

---

## 1. 已读代码事实（定位依据）

| 指标             | 数值                                   | 说明                                                                                                                                                                                                  |
| ---------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件行数         | **32,193**                             | 占 `stores/` 54,656 行的 **59%**                                                                                                                                                                      |
| 内部函数         | **707**                                | 其中 48 个在首个分节之前（核心区：state / 撤销 / 日志）                                                                                                                                               |
| 最长函数         | 431 / 399 / 397 / 386 行               | `placeArrivalNow` / `payFuel` / `pickCombatSupplyDump` / `confirmCombatSupply`                                                                                                                        |
| `ref + computed` | **589**                                | 同一个 setup store 的响应式闭包                                                                                                                                                                       |
| `watch`          | 12                                     | 全部在装配期注册（好现象，切片里不许出现 `watch`）                                                                                                                                                    |
| 公开面           | **1,013 键**，`return` 字面量 1,155 行 | 组件按名取用，键名即契约                                                                                                                                                                              |
| 规则号注释       | 2,225 行                               | 说明它承担大量规则前置条件编排，不只是搬状态                                                                                                                                                          |
| 已拆出的 domain  | 10 个                                  | `air-mission` / `ground-movement` / `fire-resolution` / `supply-phase` / `air-supply` / `air-cargo-resolution` / `air-unit-transit` / `phase-coordinator` / `snapshot-registry` / `engagement-inputs` |

**已有的拆分先例就是模板**：`createGroundMovementDomain(ports)`，切片顶部 `const { pushLog, applyMovePatches, … } = ports`，函数体原样不动。`AirMissionPorts` 现为 **17 个成员**，是 ports 规模的标尺（但 B1 实测一个 1,212 行的切片要 51 项，见 §6 的 P2-4 结论：**端口 > 40 就该再拆一刀**）。

---

## 1.5 坐标与编号（每次搬家后必须重算）

**本文件与 `tasks.md` 里出现的所有行号，都是"动手之前"的坐标。** 每搬完一批，facade 会短上千行，其余分节的坐标全部漂移；照旧坐标切下一批会切错位置。

B0 + B1 之后的实测漂移量：

| 符号                     | 旧坐标 | 现坐标 | 偏差   |
| ------------------------ | ------ | ------ | ------ |
| `requireAction`          | 24,900 | 23,715 | -1,185 |
| `setSpDumpHoldings`      | 16,120 | 14,917 | -1,203 |
| `resolveSpecialCombatAt` | 20,346 | 19,143 | -1,203 |

偏差 ≈ **1,185–1,203 行**，由 B0 的 -61、B1 的净减（-1,057，含把 119 行转发壳放回原位置）与顺手清掉的 import（≈-40）累计而成。注意偏差**不是一个全文件统一的常数**：同一批里，落在不同位置的符号偏差会差十几行（谁在被删段落之前、之后各不一样）——所以别拿一个数字去平移推算，只能重算。

所以坐标一律**重算，不手抄**：

```bash
node scripts/migration-report.mjs --out docs/specs/2026-11-20-workbench解构/migration-当前坐标.csv
```

脚本用类型检查器解析**真实调用边**（不是"名字出现过"的近似），输出 `section, section_title, function, kind, line, inbound_sections_count, inbound_from_sections`。

**编号不可跨文档互换**：旧 `migration.csv` 的 0–15 是"粗粒度分节序"（只认 16 处注释），新脚本认 31 处（连后来新增的注释也算）——所以同一个 `section 8` 在旧表里是「C7 轰炸」，在新表里是「21.10 补给缓存」。**跨批引用请用 `section_title` 的关键词，不要用编号**。B1 之后的分节对照（节选）：

| 新编号 | 标题关键词         | 函数(fn) | 账本/派生(const) | CSV 行数（fn+const） | 对应旧编号    |
| ------ | ------------------ | -------- | ---------------- | -------------------- | ------------- |
| 10     | C7 轰炸（已迁出）  | 38       | 0                | 38                   | 旧 8          |
| 11     | C8 补给交互        | 29       | 3                | 32                   | 旧 9          |
| **18** | **C9 空军交互**    | **16**   | **8**            | **24**               | 旧 10         |
| **19** | **三操作统一流程** | **22**   | **4**            | **26**               | 旧 11         |
| 20     | 9.14 特殊战斗      | 44       | 6                | 50                   | 旧 12         |
| 22     | 批 F 到货 SP 落点  | 26       | 42               | 68                   | 旧 13         |
| 23     | B8 环节状态与闸门  | 5        | 9                | 14                   | 旧 14（部分） |
| 24     | v7.1 放置阶段      | 93       | 50               | 143                  | 旧 14（主体） |
| 30     | B48 盘面快照       | 12       | 11               | 24                   | 旧 15         |

**读表提醒（第三列 vs 第五列）**：`migration-当前坐标.csv` 一个符号一行，**函数和账本 `const` 都在里面**。在 CSV 上按 section 筛，数到的是第五列；要数"这一批要搬几个函数"用第三列。这两个数在 `24`（93 vs 143）、`22`（26 vs 68）差得很大——早期文档只写"函数数"，读者拿 CSV 数行会以为对不上，所以现在两列都列出来。

（B2 要动的就是上表加粗的 **18 + 19 = 16 + 22 = 38 个函数**，另带 12 个 const 的绑定。）

---

## 2. 切分依据（不能按分节注释机械切）

文件里有 16 个 `────────` 分节注释，但**注释与内容已经漂移**，按注释切会把无关职责绑在一起：

| 分节注释写的                | 里面实际住着什么                             |
| --------------------------- | -------------------------------------------- |
| section 12「9.14 特殊战斗」 | `confirmAirMissionNow` / `placeReplCounters` |
| section 15「B48 盘面快照」  | `segmentAdvanceBlock`（环节闸门）            |
| section 4「C5 堆叠取子」    | 突围（8.1g/h）与补给缓存                     |

**真正的切缝是状态归属**：谁拥有那批 `ref`，谁就是切片边界。跨切片的只有"函数调用"与"共享 state"，前者用 ports 解，后者只能在 `workbench-core.ts` 声明。

---

## 3. 依赖实测（决定谁先切）

`in` = 被其它分节引用的次数，`out` = 引用其它分节的次数（越低越适合先切，`in` 高者必须保留稳定接口）。

⚠️ 本节用的是**旧编号**（只认 16 处 `────────` 注释），行数与函数数是 **B0 动手之前**的快照。B0+B1 之后现坐标请看 §1.5 与 `migration-当前坐标.csv`（31 个分节、行号已漂移 1,185–1,203 行）。两套编号**不可互换**。

| section | 标题                                                          | 行数  | 函数 | in  | out |
| ------- | ------------------------------------------------------------- | ----- | ---- | --- | --- |
| -1      | 首节之前的核心区（state / 撤销 / 日志 / 选择）                | —     | 48   | —   | —   |
| 0       | 战斗收尾·地图优先交互（9.12g 撤退/推进/补给站）               | 963   | 9    | 5   | 6   |
| 1       | 铁路与运货（13.3f 轨距 / 13.3 铁路运货 / 13.2f 装载）         | 2,903 | 61   | 49  | 20  |
| 2       | 移动中的突袭（8.0 / 8.1）                                     | 1,344 | 28   | 17  | 23  |
| 3       | C5 移动交互（选子→范围→逐格→结束/撤销）                       | 451   | 15   | 14  | 11  |
| 4       | C5 堆叠取子（6.1f / 8.1g / 8.1h）+ 突围 + 补给缓存            | 3,381 | 81   | 8   | 37  |
| 5       | C6 战斗交互（9.2 九步流程）                                   | 1,643 | 33   | 17  | 14  |
| 7       | 批 F·F1 选项战果草稿账本                                      | 591   | 14   | 5   | 17  |
| 8       | C7 轰炸交互（10.0 通用流程）                                  | 1,212 | 38   | 14  | 12  |
| 9       | C8 补给交互与 SP 管理（12.x）                                 | 2,734 | 91   | 15  | 17  |
| 10      | C9 空军交互（14.2f / 15.1 / 14.11 / 15.4）                    | 560   | 16   | 9   | 14  |
| 11      | 三操作统一流程（入口判据 + 候选集合）                         | 999   | 22   | 9   | 20  |
| 12      | 9.14 特殊战斗（进入敌方设施格）                               | 2,424 | 51   | 12  | 36  |
| 13      | 批 F·切片3 到货 SP 落点（专规 2.1 / 3.1 / 3.6）               | 1,044 | 26   | 18  | 5   |
| 14      | **B8 环节状态与统一闸门**（含放置阶段 / 专规机制 / 胜利判定） | 6,738 | 162  | 51  | 49  |
| 15      | B48 盘面快照（存读档）                                        | 1,792 | 12   | 2   | 23  |

**最紧的跨节边**：`14→13` 18、`4→1` 10、`14→1` 9、`12→8` 8、`12→10` 8、`15→14` 8、`7→5` 7、`2→5` 6。

**三个全局服务的调用规模**（`workbench.ts` 内计数，决定它们必须先抽）：

| 服务                                 | 位置                | 调用点          |
| ------------------------------------ | ------------------- | --------------- |
| `pushLog`                            | `:7155`             | **669**         |
| `recordSettlement`                   | `:7220`             | **77**          |
| `requireAction` / `actionAllowedNow` | `:24900` / `:24893` | **47** + **23** |
| `refuseWhileSettling`                | `:8675`             | 5               |

---

## 4. 目标结构

| 文件                         | 职责                                                    | 行预算  |
| ---------------------------- | ------------------------------------------------------- | ------- |
| `stores/workbench.ts`        | facade：装配、`watch`、`return` 汇编、转发              | ≤ 3,000 |
| `stores/workbench-core.ts`   | 全局服务（日志/结算账/写门禁/撤销账）+ 共享 state       | ≤ 1,500 |
| `stores/workbench-<域>.ts`   | 单域交互流程（轰炸/空军/移动/补给/战斗/到货/铁路/特战） | ≤ 3,000 |
| `stores/workbench-<机制>.ts` | 闸门与阶段机制（段状态机/放置阶段/专规机制/胜利判定）   | ≤ 1,500 |

（早先写的是 `stores/flows/*.ts` / `stores/services/*.ts`，B1 实测后统一改成 `workbench-<域>.ts` 同族命名，理由见 §6 的「命名修正」。）

---

## 5. B0：先把全局服务抽出来

`createWorkbenchCore(deps)`，`deps` 只传 state 的 getter/setter。**800+ 处调用点一处都不用改**：facade 里 `const { pushLog, … } = core`，切片里 `const { … } = ports`，函数体原样不动。

| 服务                                  | 抽出到                                   | 备注                            |
| ------------------------------------- | ---------------------------------------- | ------------------------------- |
| `pushLog` / `recordSettlement`        | `core.pushLog` / `core.recordSettlement` | 669 + 77 处调用靠解构承接       |
| `requireAction` / `actionAllowedNow`  | `core.require` / `core.allowed`          | 写门禁，任何切片必过            |
| `refuseWhileSettling`                 | `core.refuseWhileSettling`               | 与移动耦合，一并搬              |
| 撤销账（`undoTrail` 等）              | `core.undo`                              | 保留后注册机制，别改直接 import |
| `segmentStep` / `segmentAdvanceBlock` | 留给 B7                                  | B0 只打成 port 透传             |

---

## 6. 批次（每批一次 commit，可独立回滚）

| 批  | 切出                                                                         | 源分节                                                      | 规模                       |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------- |
| B0  | `workbench-core.ts`                                                          | 核心区 48 函数 + 上表服务                                   | ≤ 1,500                    |
| B1  | `workbench-barrage.ts`                                                       | 8（C7 轰炸）                                                | 1,212 / 39 动作 + 18 派生  |
| B2  | `flows/air-ops.ts`                                                           | 10（C9 空军）+ 11（三操作统一流程）                         | 560 + 999                  |
| B3  | `flows/move.ts` + `flows/raid.ts`                                            | 3（C5 移动）+ 4（堆叠取子）+ 2（移动中的突袭）              | 451 + 3,381 + 1,344        |
| B4  | `flows/supply.ts`                                                            | 9（C8 补给 12.x）                                           | 2,734 / 91                 |
| B5  | `flows/combat.ts` + `combat-finish.ts` + `special-combat.ts`                 | 5（C6 战斗）+ 7（战果草稿）+ 0（战斗收尾）+ 12（9.14 特战） | 1,643 + 591 + 963 + 2,424  |
| B6  | `flows/arrival.ts` + `flows/rail.ts`                                         | 13（到货 SP 落点）+ 1（铁路与运货）                         | 1,044 + 2,903              |
| B7  | `services/segment-gate.ts` → `placement.ts` → `spec-rules.ts` → `victory.ts` | 14（B8 环节闸门）                                           | 6,738 / 162，拆 4 个子提交 |
| B8  | `services/snapshot.ts` + facade 收口                                         | 15（盘面快照）+ `return` 汇编                               | 1,792 / 12                 |

**批次表的一处命名修正（B1 实测后确定）**：切片一律放 `src/stores/workbench-<域>.ts`，**不放 `flows/`**。理由：① B0 已经用 `workbench-core.ts` / `workbench-gates.ts` 立了先例，同族文件放同目录，找起来不用跨目录；② `flows/` 现有内容全是「整局流程」编排（`tests/flows/` 也是这个含义），把某个动作域塞进去会混淆两次词义；③ `forbidden-imports` 对 `stores/*` 的限制（不得 import `@/components`、`@/views`）本来就更适合这类纯状态切片。下面表里的 `flows/xxx.ts` 一律读作 `stores/workbench-xxx.ts`。

**下面是修正后的净下降公式（B1 实测校准）**：

```
净下降 = 迁出量 − 3 × 仍需在 facade 保留转发的动作数 − 装配段（约 40–80 行） + 顺手清掉的 import 行
```

原因：真正搬走的是实现，但**动作的调用点没有改**（669 处 `pushLog` 的先例），所以每个动作要在 facade 留一个三行壳（`function x(...) { return slice.x(...) }`）。这个成本随函数数线性增长——B1 是 39 个动作 → 114 行壳；B7 有 162 个函数，照这个做法要 486 行壳。**所以给 B2 之后一条可选优化**：只有被"setup 期立即求值"引用的动作必须有提升的函数壳（用 AST 扫一遍就能列出，B1 实测只有 5 个：`acceptBarrage` / `applyBarragePatches` / `applyBarrageFacilityPatch` / `barrageFacilityFacts` / `deliverableDumpsFor`），其余可以在装配点用一行 `const { a, b, … } = slice` 集体绑定。函数数 < 40 时差别不大（30 行），B7 能省 400+ 行。

**每批 DoD（缺一不可）**：

1. `npm run check` 绿（lint / format / typecheck / test:fast / arch）；
2. 公开面键集快照 diff 为空；
3. `workbench.ts` 行数下降 ≈ 上式（±50 行）；B1 实测 1,212 − 114 − 75 + 39 = **1,062**，实际 **1,057**，差 5；
4. 新增文件 ≤ 预算上限（切片 ≤ 3,000 行）；
5. commit message 写明「纯搬移，无行为变化」，且 **push 成功**；
6. **双向文案对拍**：原文分节的字符串字面量 ↔ 切片，缺/增都必须为 0（B1：68 ↔ 68）；
7. **函数名集合对拍**：facade 的函数声明集合只允许"内部自用者转进切片"这一种差异（B1：708 → 707，差 `bestDefenderTerrainLine`）。

### 6.1 B2 重划：按"域"切，不按函数区间切（2026-11-20 实测后的修正）

上表 B2 写的是「§18（C9 空军）+ §19（三操作统一流程）」。**按这个切法算出来的端口是 82 项**，是 B1（51 项）的 1.6 倍，也远超本文件自己定的「端口 > 40 就该再拆一刀」。实测（`scripts/port-report.mjs`，符号级解析）：

| 区间                                     | 内容                        | 本地声明 | 端口   |
| ---------------------------------------- | --------------------------- | -------- | ------ |
| 17391–17950                              | §18 C9 空军交互             | 27       | **43** |
| 17951–18949                              | §19 三操作统一流程          | 26       | **65** |
| 两段合并                                 |                             |          | **82** |
| 2416–2592                                | 空军**状态块**（26 个 ref） | 26       | 23     |
| 2416–2592 + 17391–17950（状态+动作并切） |                             |          | **46** |

关键读法：**把状态块并进来只降到 46，因为状态块自己还要向更外层借 23 项**。也就是说"把相邻的函数区间凑一批"这条路走不通——要么一直超阈值，要么越凑越大。

真正的原因在 §2 早就写过：**切缝是状态归属**。B1 能按分节切，是因为轰炸的状态恰好就写在那个分节里；**空军的 26 个 ref 住在 2416–2592，离它的动作有 15,000 行**。所以 B2 必须按**域**切：

> **B2 = `workbench-air.ts`（空军域整体）**：状态块 2416–2592 + §18 全部 + §19 的空军半段（18503–18953：`airCombatPicksPayload` / `confirmAirCombatNow` / `airUnitsAt` / `canAirMissionTarget` / `resolveAirCargoNow` / `captureAirBaseNow` 等）+ 散落在 18092–20860 的空军函数（`beginAirMissionNow` / `confirmAirMissionNow` / `recordAbortedAirBarrage` / `completeAirReturnNow` / `airStatusLabel` 等）。

**⚠ 上面这段是"意图"，不是"已核实的切口"——本节初稿写的「预计端口 15–20 项、切口 1,100–1,300 行」是错的，实测推翻了自己**（2026-11-20 二次测量）：

| 合并口径                                                      | 端口   |
| ------------------------------------------------------------- | ------ |
| 状态块 2416–2592 + §18 17391–17950 + §19 空军半段 18503–18953 | **48** |

48 项里 16 项在 2593 之前声明（可直连注入），**32 项必须走 getter 延迟绑定**。而且这 32 项里有 **20 项本来就是空军域的成员，只是不在我列的那三段里**：

- 派生块 **5944–6063**：`airActingSide` / `ownAirUnits` / `airBases` / `ownAirBases` / `airTransportProfiles` / `airOverLimitAircraftInactive` / `airMissionAirUnits` / `airMissionRosterNow`（8 项）
- 空军账本 **16927–16930**：`airUnloadLedger` / `airUnloadedTAt`
- 空军动作 **18136–18148 / 18198–18502 / 19673–20865**：`airMissionAllowedInPhase` / `beginAirMissionNow` / `airCargoLossPending` / `hasCargoOwnership` / `airMissionResultReady` / `confirmAirMissionNow` / `recordAbortedAirBarrage` / `completeAirCargoReturn` / `completeAirReturnNow` / `airStatusLabel` / `airMissionKindChoices`(23386)

⇒ **空军域在 facade 里不是一段，是 6 段不连续的区间**（2416–2592、5944–6063、16927–16930、18136–18148、18198–18502、18503–18953、19673–20865、23386）。这也解释了它为什么端口大：**同一个域被 15,000 行切成了 6 截**。

**因此 B2 拆成两个提交，第一步只搬"状态 + 派生"：**

- **B2-1（先做）**：搬 2416–2592（状态，26 ref）+ **5944–6088**（派生，12 computed；**不能用 5944–6063**——6063 切在 `airMissionRosterNow` 的函数体里）。**端口经两套口径交叉复核后定为 29 项**（原写 26 / 25 都是错的，见 §6.1.1）。这两个块是纯声明、无函数体、互相引用密集；搬完 `airDomain` 就**拥有自己的状态**，后续函数搬进同一文件时不再需要把状态当端口。此时建域点可以放在 2593 附近（新出现的外部依赖全是 2593 之后声明的，走 getter），**不会像 B1 那样被迫把装配点压到 setup 末尾**。
- **B2-2（后做）**：搬函数块（18136–18148 / 18198–18502 / 18503–18953 / 19673–20865 / 23386）。到这一步端口应显著低于 48（因为状态与派生已进切片），仍需先 `port-report` 复测确认 < 40。
- **§19 的 18003–18135（轰炸/炮击入口判据）不进空军切片**，它是跨轰炸+空军的协调层，留到 B5 之后。

**切割时必须人工确认边界**：`captureAirBaseNow` 实际占 **18812–18953**，而 §20 的分节横幅在 **18950**——**横幅落在函数体内部**。任何按横幅取 `--end` 的切法都会把它的后半段切给下一个切片。（`port-report` 现在会在"区间在函数体中间截断"时报警，别忽略那条警告。）

**另一类假端口**：区间**起点**落在函数体中间时，函数内的 `const state = …` / 回调参数 `(air) => …` 会被算成"外部符号"（它们的声明行在区间之外）。测 5944–6063 就这样凭空多出 `state` 与 `air` 两项。**测量前先确认两端都落在声明之间，不是表达式内部。**

**命名还有一处坑**：facade 已有 `airSupply` / `airUnitTransit` / `airMissionDomain` / `airCargoResolution` 四个 air 开头的域，新域**不能叫 `air`**（文件里还有几十处 `(air) => …` 回调参数，会读成本地变量）。用 `airDomain`。

**方法论定下来**：每批开工第一步跑 `node scripts/port-report.mjs --start <首> --end <尾>`；**> 40 就重新划批**，不要硬切；**看它的截断警告**，预警说明 `--end` 取错了。这条替代了 B1 时那三个一次性脚本。

### 6.1.1 端口口径纠错（第三轮复核，2026-11-20）

`port-report.mjs` 走 TypeScript 符号解析，快且类型准，但**已证实会漏报**：`createAirMissionDomain({ … })` 实参里的 `setAirStatus`、`markAirMissionFlown`、`pushLog` 三个简写属性，工具一个都没报出来——它们既不在「端口」列表，也不在「直接 import」列表。同区间里同样写法的 `recordSettlement` / `nameOf` / `acceptAir` 却正常报出。

**（第四轮复核实测，推翻上一轮的猜测）** 上一轮我把原因写成"在聚合阶段被当作零声明的全局丢了"。插桩验证（插桩标记先确认已落盘，再跑）打印出的是：

```
HIT setAirStatus        decls=1 2485
HIT markAirMissionFlown decls=1 2487
HIT pushLog             decls=1 2489
HIT recordSettlement    decls=1 7123   ← 对照组，正确定位到函数声明
```

即这三个简写属性被 `getSymbolAtLocation` 解析成了 `declarations = 简写属性节点自身`，于是 `allInside = decls.every(d => inRange(d))` 为真，聚类直接 `continue` 当成"区间内声明"，**方向不是漏收引用，而是把端口误判成本地**。所以工具报的是"没有这回事"，而不是"少了一条"。这类误判无法靠工具自证，只能靠另一套口径对拍。

由此也得出一条更硬的结论：**端口清单的最终闸门是 `vue-tsc` 而不是这个工具**——切片里少一个端口会直接报未定义符号。B1 那 51 项是被类型检查验收的（漏一项就红），工具只负责开切前估规模。

因为我上一轮把端口数当成了既成事实（先报 15–20、再报 26、再报 25），**这次不再用单一工具的口径**：新增 `scripts/port-crosscheck.mjs`（纯语法、无符号解析），规则是「区间内出现的标识符 − 区间内声明的名字 − setup 体里声明过的名字 = 端口」，与 `port-report` 交叉对拍。B2-1 三段实测：

| 区间                            | port-report | crosscheck | 结论                                                                                                                  |
| ------------------------------- | ----------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| 2416–2549（状态块前段 14 ref）  | 22          | **23**     | crosscheck 多出 3 个漏收符号；工具多算了 2 个模块级函数                                                               |
| 2558–2592（状态块后段 12 ref）  | —           | 0          | 纯声明，只用到 3 个 import 的类型                                                                                     |
| 5949–6086（派生块 12 computed） | 12          | 12         | 但其中 4 项（`airState`/`airMissionAirIds`/`airMissionDomain`/`airstripBaseIds`）是状态块里的本地声明，搬完就同属切片 |

**两处口径修正**：

- `AirInputs`（:825 `export interface`）与 `createAirInputs`（:937，**无 export**）是**模块级**声明，不在 setup 体内。工具把它们错算成"端口"，crosscheck 把它们算成"外部"。**已逐字段核对（:825–927 全部是 `string`/`number`/`boolean`/内联对象，无一处依赖 facade 内部类型；`createAirInputs` 只返回这个字面量）** ⇒ 两者都可整块搬进 `workbench-model.ts`，切片从 model 取，既不增端口也不造回边。这比上一轮写的"createAirInputs 只能留作端口"更省事。
- 派生块的 12 项里 4 项随状态块一起进切片，**不重复计入端口**。
- 三段各自的顶层声明（逐行实点，不是估计）：2416–2549 = **15 条**（14 个 `const` + 2492 的解构 `const { airState, airError }`）；2558–2592 = **12 条**；5949–6086 = **12 条**。⇒ 切片要 `return` 的公开名是 **40 个**（上一轮写 38 是漏算了解构出来的 `airState`/`airError`）。
- 四条切口已逐行确认干净：**2549** 是 `watch` 那段文档注释的 `*/`（2550–2557 的 `watch` 与它的注释一起留在 facade）；**2558** 起新注释新声明；**2592** 是 `lastReduction` 的收尾、2593 空行；**5949** 是 `/* ── C9 空军交互：派生 ── */` 分节横幅；**6086** 是 `airMissionReturnOrigins` 的收尾，6087 空行、6088 起是下一组（`departureAvailable` 系列，不属于本批）。
- 另修正一处行号：`airUnits` 的声明在 **1921**（tasks 里 B2-2 写的 1916 是它的文档注释首行，不是声明行）。

⇒ **B2-1 端口 = 25 项**。算法必须按"三段一起搬"来做减法，否则会把切片自己的声明当端口：2416–2549 报 23 项，但其中 `airBases`(5983) / `airTransportProfiles`(6027) / `airOverLimitAircraftInactive`(6047) / `airMissionRosterNow`(6063) **四项就声明在派生块里**，随派生块一起进切片 ⇒ 剩 19；派生块另外只需要 6 项（`activeSide`/`zocOnlySupplyFacts`/`onMapAirUnits`/`segmentGateQuery`/`constructionMarkerAirBaseId`/`constructionMarkerPieces`，`units`/`airUnits` 与状态块重复已去重）⇒ 19 + 6 = **25**。

其中只有 6 项（`rng` 1230 / `units` 1253 / `selectedId` 1321 / `airUnits` 1921 / `offMapSupplyStocks` 2305 / `activeSide` 1111）声明在建域点（≈2593）之前，可直连注入；**其余 19 项必须走 getter**（`pushLog` 7075、`recordSettlement` 7123、`nameOf` 8479、`setAirInBoxMembership` 14562、`addSpAtHex` 14697、`airUnloadedTAt` 16930、`acceptAir` 17429、`setAirStatus` 17440、`markAirMissionFlown` 17459、`drawAir2d6` 17474、`applyAirCargoDelivery` 18755、`airCargoLossPending` 19673、`airMissionResultReady` 20208、`completeAirCargoReturn` 20318、`zocOnlySupplyFacts` 4192、`onMapAirUnits` 18612、`segmentGateQuery` 23302、`constructionMarkerAirBaseId` 27821、`constructionMarkerPieces` 27836）。

**这条减法规则写进方法论**：端口 = （各段 ref 集合的并集）− （各段声明集合的并集）− （真外部）。单独量一段必然偏大。

**B2-1 落地后的两条实测修正（第五轮，2026-11-20）**：

1. **"须走 getter" 的判据不是行号，是声明形态。** 上一版本节写"19 项须 getter"，实装时发现：**`function` 声明会提升，声明在 27k 行也能在建域点按值传**；只有 `const`/`computed` 才受 TDZ 约束。所以真实切分是 **20 按值 + 5 晚绑定**（`zocOnlySupplyFacts` / `onMapAirUnits` / `airCargoLossPending` / `segmentGateQuery` / `constructionMarkerPieces`），`constructionMarkerAirBaseId`(:27821) 虽然最晚，但它是函数，照样按值。往后每批都按这个判据数，不要按"行号 > 建域点"数。
2. **晚绑定端口在切片里的写法是 `ports.x.value`，不 destructure。** 若切片顶部 `const { zocOnlySupplyFacts } = ports`，getter 会在建域那一刻被求值 ⇒ 撞 TDZ。B2-1 只有 6 处引用，改写成 `ports.x.value` 即成（`lateFix` 的正则命中数 1/2/1/1/1/1，与预期一致）。
3. 顺带验证了一个一直没被证明的假设：**`tests/shared/store-source.ts` 用 `readdirSync` 自动纳入新切片**，38 处源码守卫测试零改动即全绿——不需要为每批新增切片去改测试。

实装结果：`workbench.ts` **31,036 → 30,649 行（−387）**，`workbench-air.ts` 487 行，`workbench-model.ts` +153 行，公开面 1,013 键不变，`npm run check` 623 文件 / 6,256 用例 / 201.16s / exit 0。

**⚠ 上一条落地记录里的「31,074 → 30,648（−426）」是错的**（第六轮复核抓出）：31,074 是 **P2-1 之前**的行数，P2-1 把四个共享类型搬进 `workbench-model.ts` 时已经先减了 38 行。B2-1 的真实基线是 31,036。**教训与 §1.5 同源**：跨批引用规模数字必须重新量，不能沿用上一批的读数。

**B2-1 只搬了空军派生的一半（第七轮复核，2026-11-20 夜）**

⚠ 我先前写的"搬完 `airDomain` 就拥有自己的状态 + 派生"是不准确的。**派生被分成了两簇**，B2-1 只搬了后一簇：

- 搬走的：`5949–6086`（含 `/* ── C9 空军交互：派生 ── */` 横幅之后的 12 个 computed）
- **没搬的：`5701–6321`（621 行 / 48 个声明）**——`airMissionReturnChoices`（返航三选一）、`airReturnSelectionLabel` / `airReturnChosen`、`airCombatAttackerPlanes` / `airCombatDefenderPlanes` / `airCombatRoundBudget` / `airInterceptionDefender`、`toggleAirCargoUnit` / `airCargoUnitChoices`、`airMissionHasFighter` / `airChecklist` / `airTargetInEnemyPatrolZone` / `airInterceptionResponse` / `airInterceptorCandidates` / `airTargetBaseLevel` / `airTargetBaseIsAirstrip` / `airEnemyAtTarget` / `capturableEnemyAirBases` / `airPatrolZoneHexes` / `airEnemyPatrolZoneHexes`、`airInactiveAtBase` / `airRefitPayDumps` / `airReductionCandidates` / `refitDoneBases` / `refitBase` / `refitCandidates` / `refitSelectedIds` / `refitSelectLimitAt` / `refitSelectLimit` / `refitPayDumps` / `refitPayNeedT`、`transferBase` / `transferCandidates` / `airDistanceToBox` / `canTransferAirToBox` / `transferBoxReady` / `transferBaseCandidates` / `transferHasBoxOption` / `transferHasBaseOption` / `canTransferAirToBaseNow` / `beginTransferNow` / `toggleTransferAircraft` / `cancelTransferNow` / `completeTransferToBaseNow`、`refitStartBases` / `refitAirbaseHexes` / `refitBlockReasonAt` / `reducedBases`

**（第七轮复核的数字更正）** 上一版本节先写「`5711–6319`、609 行、44 个声明」，**三项全错**：逐行实点为 **`5701–6321`、621 行、48 个声明**。

- 左端 `5711` 是 `airMissionReturnChoices` 的 `const` 行，但它的文档注释在 **5701–5710**；从 5711 起切会把注释留在 facade 变成孤注释。正确左端 = **5701**（上一条 `supplyPickupRequirement` 在 5699 收尾、5700 空行）。
- 右端 `6319` 是 `reducedBases` 的**起始行**，它的体到 **6321** 的 `)` 才结束，6323 才是下一条 `moveRuntime` 的注释。取 6319 等于把 `reducedBases` 切在函数体中间——**这正是 `port-report` 的"区间在函数体中间截断"告警专门要抓的那类错**，只是这次我用的是 crosscheck（它不打这个告警）。
- 声明数 44 是我手抄 `5711–6319` 清单时的漏计，实点 48。

**取 range 的两端纪律（补进方法论）**：`--start` 取「目标语句自己的文档注释首行」（上一条语句收尾的下一行），`--end` 取「目标语句最后一行 `}`/`)`」，两端都不许落在语句内部；而 **crosscheck 不检查这一点**，只有 `port-report` 的截断告警会提醒——所以**两套工具都要跑一遍**，各管一头。

**为什么漏了**：我按分节横幅 `/* ── C9 空军交互：派生 ── */` 取切口，而横幅**只标记了后半**；前半（5711 起）在它上面，紧挨着 `supplyPickupRequirement`(5661) 这样的非空军内容，所以按横幅取 range 时看不见它。**教训：分节横幅是"作者写文档时的分组"，不是"域边界"** —— 这与 §6.1 抓 `captureAirBaseNow` 被横幅切开的坑同源，只是方向相反（那次是横幅落在函数体里，这次是横幅只覆盖半个域）。

**这簇的端口只有 16 项**（扣掉切片内部 18 项后）：`phase`/`units`/`airUnits`/`airBoxMembers`/`allSpDumps`/`supplyFacts`/`pushLog`/`setAirInBoxMembership`/`hqDeliveryDumpKeys`/`isAirInOffMapBox`/`onMapAirUnits`/`airUnitsAt`/`airDistanceFromRealBase`/`airUnitsInHex`/`actionAllowedNow`/`isConstructionMarkerAirBaseId`。⇒ 补一批 **B2-1b** 即可，而且**它应该排在 B2-2a 之前**：这 16 项里有 5 项（`isAirInOffMapBox`/`onMapAirUnits`/`airUnitsAt`/`airDistanceFromRealBase`/`airUnitsInHex`）就在 B2-2a 的区间里，先做 B2-1b 能让它们变成切片内部；同理 B2-2d 的 21 项里有 5 项（`airInactiveAtBase`/`airRefitPayDumps`/`refitSelectLimitAt`/`refitSelectLimit`/`refitPayDumps`）是本簇自己的派生，做完 1b 也一并消失。

### 6.1.2 每批的共同动作：搬走的名字要从端口表里剪掉

B2-1 的 `AirDomainPorts` 里有 **5 个成员会被后续批次搬进切片本身**，实测（用 `^  (function|const) <名>` 在 facade 里定位）：

| 端口成员                 | facade 声明行 | 会被哪批搬走 |
| ------------------------ | ------------- | ------------ |
| `onMapAirUnits`          | 18225         | **B2-2a**    |
| `applyAirCargoDelivery`  | 18368         | **B2-2a**    |
| `airCargoLossPending`    | 19286         | **B2-2b**    |
| `airMissionResultReady`  | 19821         | **B2-2c**    |
| `completeAirCargoReturn` | 19931         | **B2-2c**    |

所以每批搬动时必须同步做四件事，**少一件就编译不过或行为重复**：

1. 从 `AirDomainPorts` 接口里删掉该成员；
2. 从 `createAirDomain` 顶部的解构里删掉（或从 `ports.x` 改写改回裸名）；
3. 从 facade 传给 `createAirDomain` 的 ports 实参里删掉，**连 `get` 访问器一起删**（`onMapAirUnits`/`airCargoLossPending` 现在是用 getter 传的）；
4. 若该名字还被 facade 其余代码用，facade 的解构表（40 名那张）本身不用改——它们本来就在里面。

反过来，**搬走一个名字时不要顺手把它从 facade 的 40 名解构里删掉**：那个解构是公开面的一部分（`return` 里按原名暴露 1,013 键），删了会破快照。

1. **逐字对拍**：把 `git show HEAD~2:src/stores/workbench.ts` 的同三个区间取出来、施加同样的 6 处 `ports.x` 改写，再在切片里 `indexOf` —— 三段 **128 / 35 / 138 行全部完整命中**，字节级没有丢行。
   （第一次跑这条是拿 `HEAD~1` 比的，结果三段全部"未命中"，因为 `HEAD~1` 已是 B2-1 之后的文件——**基线提交取错了，差点误判成丢内容**。）
2. **TDZ 扫描**：40 个公开名在 facade 里逐名找首次出现行，只有 3 项出现在建域点（2251）之前——`airState`@1210、`ownAirBases`@2036、`airInputs`@2051，三者分别落在 `mayMutate() {}`、`beginAirPlacementHexPickNow()`、`beginAirTransferHexPickNow()` 的函数体内，**调用时才求值，不构成 TDZ**。
3. **`ports.x` 逐个归位**：切片里 11 处 `ports.` 命中，去掉文档注释 2 处与 `transports.length` 的假命中 1 处，其余 8 处全在 `computed(...)` 体内或 `lossPending: () => …` 这类回调里。**没有一处是在建域那一刻执行的**——这正是晚绑定能成立的前提。

### 6.1.3 B2-1b 落地（2026-11-21 实测，含三条被推翻的预判）

搬 `5701–6321`（621 行 / **48 个声明 = 14 function + 34 const/computed**）进 `workbench-air.ts`：

| 量                          | 搬前   | 搬后                                                  |
| --------------------------- | ------ | ----------------------------------------------------- |
| `workbench.ts` 行           | 30,649 | **30,075**（−574）                                    |
| `workbench-air.ts` 行       | 487    | **1,202**（+715，含 1b 之后补的头注释与 import 归并） |
| `AirDomainPorts` 成员       | 25     | **36**（+11，含 2 晚绑定）                            |
| 切片 `return` 公开名        | 40     | **88**                                                |
| facade `= airDomain` 解构项 | 40     | **85**（88 − 3 个只有切片自己用的）                   |
| 公开面键（快照 1,013）      | 1,013  | 1,013（不变）                                         |

**被推翻的预判**（这三条是下一批还要用的判据，记清楚）：

1. **"这簇端口 16 项"** → 实装 25 候选、**净增 11**。原因是 crosscheck 只认"区间标识符 − 区间内声明"，而 `hqDeliveryDumpKeys`(14205)、`actionAllowedNow`(23285)、`isConstructionMarkerAirBaseId`(27439) 这三个**被调用的函数声明在区间之后**，落在 crosscheck 的"真外部"栏——而那一栏本来就不可信（§6.1.1 第 5 条）。**端口数只能靠 `vue-tsc` 收口。**
2. **"facade 报 TS6133 的 import 都要变成端口"** → 错。13 个里 12 个是**引擎导出**（`refitCapacity`/`isFighterAircraft`/`hexLabel`/`planOffMapAirBoxFlightFromHex`/`airInteractionChecklist`/`inPatrolZoneOf`/`patrolZoneHexes`/`planInterceptionResponse`/`drawableDumpsFor`/`canUseTransport`/`isAirTransportableUnit`/`type AirBaseView`）：facade 删 import、**切片重新 import 就够**，一个端口都不用加；只有**facade 自有符号**才进端口。判据：在 `src/engine/**`、`src/data/**` 有 `export` 就算"免费"，否则算端口。把免费的当端口会白加 12 项。
3. **"裸名可以原样搬"** → 不成立。`onMapAirUnits` 已是 B2-1 的晚绑定端口，本簇里 `airEnemyAtTarget`、`airEnemyPatrolZoneHexes` 两个 computed 各有一处裸名使用，必须改写为 `ports.onMapAirUnits.value`，否则切片里 `Cannot find name`。**推论**：凡是被搬的簇"使用"了某端口而端口是晚绑定，正文改写与逐字对拍都要把这个前缀算进去。

**两个新坑（不是代码逻辑问题，而是"工具/测试与切片脱节"）**：

1. **源码级测试有硬编码文件清单。** `tests/stores/action-wiring.test.ts` 的 `STORE_FILES` 只列 `workbench.ts` ⇒ 切片搬走的 `cancelTransferNow` 立刻"不是 store 里的函数"。修法：`...globSync('src/stores/workbench-*.ts')`。
2. **转发壳会抢到"函数体"。** 同一张表里 `rollAttritionNow` 在 facade 只剩 `return supplyPhaseDomain.rollAttritionNow(...)` 三行，而 `bodiesOf` 取**第一个**命中；把 workbench 族排前面就抢到壳（壳里没有 `requireAction`）⇒ 报"标了已加闸其实没加"。修法：**卫星 store 先扫、workbench 族（含切片）在后**。
   **通用结论**：拆域后，"函数体扫描型"测试的语义从"这个函数在不在 store 里"变成"在不在**这一族文件里、且不是转发壳**"。每搬一个域都要跑一遍 `grep -rn "src/stores/workbench.ts'" tests/` 找出同类硬编码清单（`tests/shared/store-source.ts` 那种 `readdirSync` 自动纳入的不受影响）。

第三个坑只属于生成脚本：找 `return {` 的收尾**不能用 `findIndex('  }')`**（正文里全是 `  }`）；要取**最后一个** `  return {`，并要求它的收尾 `  }` 紧接 `createAirDomain` 的 `}`。

验收证据（可复跑）：`npm run check` → 623 文件 / 6,256 用例 / **208.62s** / exit 0；逐字对拍**只去 `ports.` 前缀**（`.value`、空白原样保留）⇒ **621 行完整命中**；重复定义 0、僵尸函数 0（`dup-b21b.mjs`）；装配点按值实参 29 项经 `audit:ports` 核为全安全。

**口径提醒（复核时踩到的）**：函数计数受泛型影响——`function acceptAir<T>(…)` 不匹配 `function (\w+)(` 这条正则，会少数 6 个；`migration-report` 用 `function (\w+)` 口径得出 693，两套数对不上时先对齐口径再谈"递减了多少"。

---

### 6.1.4 B2-2a 落地（2026-11-21 实测）

搬 `17197–17992`（796 行 / 16 声明 = 14 function + 2 computed）进 `workbench-air.ts`：

| 量                      | 搬前   | 搬后                                                          |
| ----------------------- | ------ | ------------------------------------------------------------- |
| `workbench.ts` 行       | 30,074 | **29,253**（−821 = 796 搬走 + 25 条搬后失效的 import/解构项） |
| `workbench-air.ts` 行   | 1,201  | **2,070**                                                     |
| `workbench-model.ts` 行 | 4,104  | **4,162**（+58：3 个 interface + `movementPhaseOf`）          |
| `AirDomainPorts` 成员   | 36     | **50**（+20 = 按值 13 + 晚绑定 7；另 6 项剪掉、14 项既有）    |
| 切片 `return` 公开名    | 88     | **104**（+16）                                                |
| 公开面键（快照 1,013）  | 1,013  | 1,013（不变）                                                 |

**三条落地期才暴露的坑（下一批直接引用）**：

1. **晚绑定改写的 lookbehind 会漏展开运算符。** `(?<![\w.$])x.value` 对 `...x.value` 失效（`...` 的 `.` 被当成属性访问）⇒ `airUnloadLedger.value = { ...airUnloadLedger.value, … }` 只改到赋值一半，切片报 `Cannot find name`。**必须单独处理 `\.\.\.x\.value`**。
2. **"回补清单"在 `return` / 解构侧是重复劳动。** 那 5 个名字（`isAirInOffMapBox`/`onMapAirUnits`/`airUnitsAt`/`airDistanceFromRealBase`/`airUnitsInHex`）**本身就是区间内声明**，已随 16 声明进了 `return`；再按回补清单插一遍 ⇒ 对象字面量重复键（**TS1117**）+ 解构重复绑定。回补清单的用途是"确认它们确实在 `return` 里"，不是"再插一次"。
3. **按行号批量清 unused 会误伤同一条 import 的其它名字。** `import { airCargoTransportT, checkAirTransportMovementHandoff } from …` 中只有后者未用，按行删把前者也带走 ⇒ 后续 `Cannot find name airCargoTransportT`。**按导入名删，不按行删。**

**门禁与取证**：`npm run typecheck` 通过；`npm run check` → 623 文件 / 6,256 用例 / **195.66s** / exit 0；`arch` 源码 950；`audit:ports` 5 域全绿。逐字对拍只去 `ports.` 前缀 ⇒ **796 行对 796 行、不一致 0 行**；文案多重集对拍 110 种 / 169 条**双向 0 差异**；切片内 `ports.X` 只出现 7 次（正是 7 个晚绑定）；切片 → facade 回边 **0 处**。

---

### 6.1.5 B2-2b 落地（2026-11-21 实测，两条预判被推翻）

搬 `17880–18318`（**439 行 / 14 顶层声明**）进 `workbench-air.ts`；同时把 `PendingHexPick`/`HexPickCandidates` 两个 facade 私有类型搬进 `workbench-model.ts`。

| 量                    | 搬前   | 搬后                                        |
| --------------------- | ------ | ------------------------------------------- |
| `workbench.ts` 行     | 29,252 | **28,811**（−441 = −466 搬走/删 + 25 新增） |
| `workbench-air.ts` 行 | 2,069  | **2,542**（+473）                           |
| `workbench-model.ts`  | 4,161  | **4,177**（+16：两个待点格类型 + 注释）     |
| `AirDomainPorts`      | 50     | **57**（−1 内部化 + 8 新增，全部按值）      |
| 切片 `return`         | 104    | **116**（+12；2 个内部自用刻意不暴露）      |
| 公开面键（1,013）     | 1,013  | 1,013（不变）                               |

**被推翻的两条预判**：

1. **"27 个端口"** → 实装 **8**。那 27 项里 19 项已被 **B2-2a 搬成切片内部**（`beginAirMissionNow`/`confirmAirCombatNow`/`airMissionTargetCandidates`/`airUnitsInHex`/`enemySide`/…），剩下 8 项里 5 项是**函数声明（提升 ⇒ 按值）**。教训：**端口预算必须"在上一批落地之后"重测**；跨批沿用计划期的端口数是系统性偏高。
2. **"区间 19283–19720 / 438 行 / 12 符号"** → 实为 **17880–18318 / 439 行 / 14 声明**。原因：(a) 计划期坐标在 B2-2a 之前，搬走 821 行后整体上移；(b) 漏记 `airCargoLossPicked`(`ref<string[]>`) 与 `toggleAirCargoLossPick`。

**新增的三个坑（第 1 个比 B2-2a 的任何坑都危险）**：

1. **同一脚本里"先删上方小块、再按原始行号删大区间"会让区间整体错位。** 表现是 `TS1005: ',' expected` 连片、删剩的半截函数留在 facade。修法：**先按原始坐标删大区间，再处理上方小块**；或所有删除都从后往前做。这条同时解释了为什么"边界断言全绿"仍然能删错——断言的坐标是原始的，删除发生在之后的偏移坐标系。
2. **"声明晚于建域点" ≠ "必须晚绑定"。** 判据是 **`const`/`computed` 还是 `function`**：本批 5 个声明在 16k–18k 的函数都能按值传（提升）。
3. **符号归属不能靠命名风格猜。** `airBarrageStrengthOf` 长得像引擎规则函数，实际是 `workbench-model.ts:2153` 的导出；往 `@/engine/rules` 加 import 直接 `TS2305`。

**取证**：`npm run check` → 623 文件 / 6,256 用例 / **196.40s** / exit 0；逐字对拍 **439↔439、不一致 0**；文案多重集 **53↔53、缺 0 增 0**；**零使用端口 0/57**；facade `+25` 行全部落在"注释 2 + import 3 + 标识符 20"，**非预期新增 0**；`audit:ports` 报 `createAirDomain` 按值 **45** 项全安全。

---

### 6.1.6 B2-2c 落地（2026-11-21 实测，两处台账口径被推翻）

搬 `17879–18209`（**331 行 / 8 顶层声明，全 `function`**）进 `workbench-air.ts`。这批是空军域的"轰炸任务链 + 任务结算 + 中止记账 + 留存货物退运"，也是 B2-2 四批里**唯一一批全是函数声明**的区间。

| 量                    | 搬前    | 搬后                                              |
| --------------------- | ------- | ------------------------------------------------- |
| `workbench.ts` 行     | 28,811  | **28,503**（−308 = −340 搬走 + 32 新增）          |
| `workbench-air.ts` 行 | 2,542   | **2,906**（+364 = +380 − 16）                     |
| `AirDomainPorts`      | 57      | **71**（−4 内部化 + 18 新增：15 按值 + 3 晚绑定） |
| 切片解构 / getter     | 44 / 12 | **55 / 15**                                       |
| 切片 `return`         | 116     | **119**（+5 回补 − 2 反剪）                       |
| 公开面键（1,013）     | 1,013   | 1,013（不变）                                     |

**被推翻的两处台账口径**：

1. **"区间 19729–20047 / 319 行"** → 实为 **17879–18209 / 331 行**。两批（B2-2a 821 行、B2-2b 441 行）搬走后再按旧坐标找，会落在完全不同的函数里。
2. **"31 端口"** → 实装 **18**。40 项报告里 **9 项已是接口成员**、**13 项在切片作用域内已有**（切片自己的 ref，或 `const { airState, airError } = airMissionDomain` 解构出来的）。这 13 项是最隐蔽的一类：`port-report` 看到"facade 2255 行声明"就当成外部，其实那是 facade 从 `airDomain` **解构回来**的行——名字属于切片，不属于 facade。

**回补/反剪的判据**（比端口计数更容易错）：

- 搬走后要回补到 facade 的，**必须扫全部声明名在 facade 的剩余引用**，不能只核施工单候选。本批另外扫出 3 个（`beginAirBarrageNow`/`settleAirMissionNow` 进了 store 公开面、`recordAbortedAirBarrage` 在 16758）。
- 反向也要扫：**上一批加进 `return`/解构的名字，若唯一取用点就在本批区间，搬完立刻 `TS6133`**（本批的 `finishAutomaticAirReturn`/`finishAbortedAirMission`）。
- 晚绑定端口**绝不进解构**：`} = ports` 在 `createAirDomain` 入口处求值，解构 getter 会在建 store 时读 TDZ 常量，直接 `ReferenceError`。

**取证**：`npm run check` → 623 文件 / 6,256 用例 / **195.96s** / exit 0；R1 行文本对拍 **331↔331 / 非空 324↔324 / 不一致 0**、8 声明序列一致；R2 换 AST 口径 **1,775↔1,775 节点 / 不一致 0**、零使用端口 **0/71**、facade `+32` 行 = 注释 3 + 标识符 20 + getter 9 片段、非预期 0；`audit:ports` 报 `createAirDomain` 按值 56 项、`createBarrageDomain` 按值 50 项全安全。

---

### 6.1.7 B2-2d 落地（2026-11-21 实测，空军域收口）

搬 `17902–18335`（**434 行 / 14 顶层声明，全 `function`**）进 `workbench-air.ts`。这是空军域最后一批：放弃任务、简易机场声明、基地整备三步（选机 → 选付款堆 → 确认）、基地转移、基地缩减，以及两个中文名标签函数。**本批 434 行原样搬入，一个字都不用改**（区间里没有任何已存在的晚绑定端口被引用）——这是六批里唯一一次。

| 量                    | 搬前    | 搬后                                         |
| --------------------- | ------- | -------------------------------------------- |
| `workbench.ts` 行     | 28,503  | **28,083**（−420 = −442 搬走/删 + 22 新增）  |
| `workbench-air.ts` 行 | 2,906   | **3,379**（+473 = +434 区间 + 39 端口/注释） |
| `AirDomainPorts`      | 71      | **76**（−1 内部化 + 6 新增，全部按值）       |
| 切片解构 / 走 ports   | 55 / 16 | **60 / 16**（−1 + 6；走 ports 侧未变）       |
| 切片 `return`         | 119     | **132**（+14 回补 − 1 反剪）                 |
| 公开面键（1,013）     | 1,013   | 1,013（不变）                                |

**被推翻的两处台账口径**：

1. **"443 行"** → 实为 **434 行**（B2-2c 之后按符号名重测；`cancelAir` 17903 起、`airStatusLabel` 的 `}` 在 18335，18336 空行、18337 是 W6 B18 横幅）。
2. **"21 端口"** → 实装 **6**。`port-crosscheck` 端口栏列的 34 项里，11 项本来就在接口里、19 项是切片已有的状态/派生（B2-1 已把整备/转移/缩减的 ref 搬进切片），真新增只剩 6 项，且**全按值**——本批一个晚绑定都没有。

**本批特有的一类坑（值得单独记）：模块级常量表也会是端口。** `AIR_MISSION_KIND_LABELS`(731)、`AIR_STATUS_LABELS`(753) 是两个中文名表，声明在 `defineStore` 的 setup 函数**体之外**（模块级）。`port-crosscheck` 的规则是"区间引用 − setup 体内声明"，于是它们被丢进"真·外部"栏；而那一栏长期被当成噪音（上百项函数局部变量、回调参数）整栏跳过。本次靠"逐名核对接口成员 + 两文件声明位置"才发现。教训：**端口的判据是"切片里有没有这个绑定"，不是工具把它分到哪一栏**。

**回补/反剪**：14 个声明名**全部**有区外引用 ⇒ 全量回补（store 公开面 12 个 + `toggleAirstripBase`(16245) / `refitBaseNow`(5698) / `airStatusLabel`(16505)）；`refitSelectLimitAt` 搬后只剩切片内部用 ⇒ `return` 与 facade 解构两边同时剪。

**取证**：`npm run typecheck` 通过 → `npm run check` **623 文件 / 6,256 用例 / 196.57s / exit 0**；`arch` 源码 950；公开面 **1,013 键不变**；切片回边 `import './workbench'` **0 处**。

---

### 6.1.8 B3-1 落地（2026-11-21 实测，移动交互域起步）

搬 `7527–7969`（**443 行 / 21 顶层声明**：15 `function` + 6 `const`）进新切片 `workbench-move.ts`：选子 → 范围 → 逐格 → 结束/撤销、20.0a 拆分窗口、4.3 初设摆位（Setup Wiggle）。

| 量                    | 搬前   | 搬后                                        |
| --------------------- | ------ | ------------------------------------------- |
| `workbench.ts` 行     | 28,083 | **27,702**（−381）                          |
| `workbench-move.ts`   | —      | **607**（新建）                             |
| `workbench-model.ts`  | 4,177  | **4,208**（+31：接口 21 + 文档 8 + import） |
| `MovementDomainPorts` | —      | **40**（37 按值 + 3 晚绑定）                |
| 公开面键（1,013）     | 1,013  | 1,013（不变）                               |

**台账口径修正**：原估「section 3 = 451 行 / 15 个函数」→ 实测 **443 行 / 21 个声明**（AST `getFullStart` 口径 445 行，多含区间前 2 行空行；**搬运正文 7527–7969 = 443 行**）。多出的 6 个是 `const` 状态与派生（`settlementInProgress` / `breakdownWindows` / `setupWiggleParents` / `setupWiggleOn` / `setupWiggleRemaining` / `breakdownTimingOf`）——迁移清单只统计 `function`，**按清单数区间会漏掉状态块**。

**本批的结构性发现：建域点的位置由「谁先吃这些函数」决定，而它直接决定端口成本。**

- 反向约束：`nameOf` / `applyMovePatches` / `refuseWhileSettling` / `closeBreakdownWindows` 在 1113–1122、1567、2159、2222、7066 就被 `groundMovement` / 轰炸 / 空军当端口吃掉，早于区块位置（7527）。
- 若把移动域提前到 `groundMovement`(1110) 之前：需要为 18 项状态开 getter，其中 `moveBlocked` / `moveInteraction` 是从 `groundMovement` 解构来的 ⇒ 与它成环（只能靠 getter 晚读绕开）。
- 原地建域（7527）：只要 **3** 个 getter（`breakdownPool` 18046 / `initialSetupInProgress` 19481 / `gates` 20698），代价是那 4 个名字在 facade 各留 **一行薄转发**（`function nameOf(id) { return movementDomain.nameOf(id) }`）。⇒ 选后者。
- 一般化判据：**先数「建域点之前的 `const` 有多少」**（= getter 数）与「建域点之前被外域消费的函数有多少」（= 薄转发数），取总代价小的那个。

**其它两处口径**：

1. **`choices` 的端口类型是 `ComputedRef<UnitRecordView[]>`**，不是 `{ unit: ConsoleUnit; selected: boolean }[]`。`unitChoices()` 返回单位记录视图；按字面猜类型会让公开面 `choices` 变窄，连带 2 个组件 + 2 个测试报 TS2339。
2. **`TransportHandlingUndoEntry`（facade 1453 的非导出接口）必须随批搬进 `workbench-model.ts`**；漏在 facade 补 `import type` 时，`ref<T[]>` 的 `T` 解析失败 ⇒ 4 处 `TS7006` 隐式 any，症状像「函数体搬坏了」。

**取证**：`npm run typecheck` 通过 → `npm run check` **623 文件 / 6,256 用例 / 196.38s / exit 0**；`arch` 源码 **951**；`audit:ports` 报 `createMovementDomain @7520` 按值 **37** 项全安全（37 + 3 getter = 40）；切片回边 **0 处**；公开面 **1,013 键不变**。 **两轮复核**：R1（`git show HEAD~2` 逐行对拍，只去 `ports.`）443 ↔ 443 行、不一致 0，零使用端口 0/40；R2（token/AST 口径）1,737 ↔ 1,737 token、不一致 0，节点 +8 恰为 3 个 `ports.` 前缀，反向验证 5 项全过（残留 0 / 薄转发 4×1 语句 / 晚绑定裸名 0 / 快照字节一致）。**R1 推翻了本批自报的「445 行」→ 443 行**（445 是 AST 全范围含 2 行前置空行）。

### 6.1.9 B3-2a 落地（2026-11-21 实测，堆叠取子族）

section 4（B3 第二批）实测 **3,377 行 / 81 声明**（7593–10969），端口远超单批 40 红线 ⇒ 按功能族切。本批只取**取子族** `7590–7800`（**211 行 / 13 声明**：11 `function` + 2 `computed`）进新切片 `workbench-stack-pick.ts`。

| 量                        | 搬前   | 搬后                                 |
| ------------------------- | ------ | ------------------------------------ |
| `workbench.ts` 行         | 27,703 | **27,542**（−161；numstat +51/−211） |
| `workbench-stack-pick.ts` | —      | **303**（新建）                      |
| `StackPickDomainPorts`    | —      | **13**（12 按值 + 1 晚绑定）         |
| 公开面键（1,013）         | 1,013  | 1,013（不变）                        |

**section 4 的实测分解**（81 声明，不一次搬完）：取子族 7590–7800（13 声明）→ 推进族 7770–8379（24 声明，**44 端口**，超红线 ⇒ 下一批还要再切两刀）→ 模式族 8379–8726（9）→ 预备族 8743–8934（6）→ 燃油族 8934–9732（8，跨 3 个空档）→ 突围族 9894–10413（12）→ 工具族 10565–10969（9）。

**建域点判据第二次生效**：提前到 `groundMovement`(1152) 之前，要给 `moveBlocked`(1173) / `movePick`(1403) / `pausedTransportIds`(1452) / `beginMoveFor`(7575) / `initialSetupInProgress`(19100) 开 **5 个 getter**；原地建域（7612）只要 **1 个 getter**，代价是 4 个薄转发（`snapshotOf` 1160 / `stepTextOf` 1161 被 `createGroundMovementDomain` 吃；`movePickPoolAt` 5768、7552 / `defaultMovePickIdsAt` 7553 被移动域吃）。

**取证**：`npm run typecheck` 通过 → `npm run check` **623 文件 / 6,256 用例 / 197.39s / exit 0**；`audit:ports` 七域全绿（新增 `createStackPickDomain @7612` **按值 12 项全安全**，12 + 1 getter = 13 自洽）；`arch` 源码 **952**（+1 新文件）；切片回边 **0**（只用 `import type` 引 `./workbench-move`）；公开面 **1,013 键不变**。

**两轮复核**：R1（`git show HEAD~1` 逐行对拍，只去 `ports.` 前缀）**211 ↔ 211 行、不一致 0**，零使用端口 0/13，facade 13 名只剩 4 个薄转发，快照 blob 与 HEAD~1 相同；R2（token 流 + AST 反向）**1,109 ↔ 1,109 token、不一致 0**，AST 节点 +2 恰为唯一 1 个 `ports.` 前缀，反向 5 项全过（facade 残留 0 / 薄转发 4×1 条且指向 `stackPickDomain.<同名>` / 切片 `import './workbench'` 0 / 裸 `initialSetupInProgress` 0 / 行数 27,542·303 与 numstat +51/−211 吻合）。两次复核**未推翻**本轮结论，但量具自身各误报一次（域级 `return {` 被 `snapshotOf` 内部返回抢先匹配、未用端口检查漏去前缀、行数口径、0-based 偏移），已改。

**本批两个新坑**：

1. **「所有端口都写 `ports.`」会触发 TS6198「解构元素全部未使用」**：按值端口必须走解构、用裸名；只有晚绑定写 `ports.x`。AST 批量加前缀时若一律加，typecheck 立刻红。
2. **prettier 会把 `ports.friendlyUnitsAt(hex).filter(...)` 拆成 `ports` + 换行 + `.friendlyUnitsAt(...)`**：按字面 `ports.` 计数或替换会漏 3 处；去前缀必须用允许空白的正则（`ports\s*\.\s*name`），否则切片里留下散落的 `ports` 行首。

---

## 7. 搬运的 8 条机械规则

1. **类型先立**：`export type Workbench = ReturnType<typeof useWorkbenchStore>`；切片之间只互认 `Ports` 接口，**不要 import 对方的返回类型**（会造类型环）。
2. **延迟绑定**：互调一律走 getter（`combat: () => slices.combat`），`bind()` 之后才解引用 —— 撤销账的后注册就是同一招。
3. **ref 归属**：切片内部就地 `ref()`；跨切片共享的 ref 只能在 `workbench-core.ts` 声明，用 `Ref<T>` 传入。
4. **computed 只读**：允许依赖 ports getter；**禁止**在 computed 里写状态。
5. **`watch` 全在 facade**：切片里出现 `watch`，会在切片被创建两次时双触发。
6. **撤销只登记 family**：新 family 要同时加 `undoScopeKeyOf()` 的作用域键，否则会跨段误撤（现有 `move.step / transport / setup / draft / arrival / cache / snapshot` 七族是标尺）。
7. **`return` 只增不删**：新键插到对应注释块；**旧键名一个都不许改**（组件按名取用，改了就是静默 `undefined`）。
8. **搬一段 = 顶部加一次 ports 解构，函数体不动**；只有跨切片互调才改写成 `ports.combat.clearCombat()`。

---

## 8. 机器闸（否则三个月后又长回 32k）

1. **`max-lines`**：`stores/workbench.ts` ≤ 3,000（起手先按现值卡住、只降不升）、`flows/*` ≤ 3,000、`services/*` ≤ 1,500、`components/**/*.vue` ≤ 1,600。
2. **`forbidden-imports`**：`flows/*`、`services/*` 不得 import `./workbench`（只能 import `./workbench-core`、`@/engine/*`）；`stores/*` 不得 import `@/components`、`@/views`；`engine/*` 不得 import `vue` / `pinia` / `@/stores` / `@/render`。
3. **公开面快照**：`tests/stores/public-surface.test.ts` 把键集写成基线；新增键必须显式更新基线，删键/改名直接红。

---

## 9. Git 落地（每批都必须能 push）

| 约束                         | 做法                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------- |
| 一批 = 一 commit = 一 push   | DoD 第 5 条；`git status --porcelain` 为空才提交                                 |
| 纯搬移不混改动               | 同一 commit 不出现逻辑/文案改动，便于二分定位                                    |
| 新文件一律 LF + UTF-8 无 BOM | `.gitattributes` 已是 `* text=auto eol=lf`；禁止用 PowerShell `>` 重定向生成源码 |
| 分支                         | `refactor/workbench-decouple`，每批一 commit 推远端                              |
| 回退                         | 每批合并后本地打 tag `decouple-b<N>`                                             |

**关于"让 git 认得出搬家"——这条原方案是错的，B1 实测推翻**：

原来写的是「`git config diff.renames copies`（已配）；审阅用 `git show -C --find-copies-harder`」。B1 提交实测：

```
git show --find-copies-harder --stat 62c128c
 src/stores/workbench-barrage.ts | 1478 ++++++++++++++++++++++++++++++++++++++++
 src/stores/workbench.ts         | 1326 ++++++---------------------------
```

git 报的是「新增 1,478 行 + 删除 1,192 行」，**不是** copy/rename。`-C -C`、`-C50%` 全试过，都不认。原因是 copy 检测要求目标文件与源文件的相似度过阈，而切出来的切片只有源文件的 **4.6%**（1,478 / 32,132）——"从巨型文件里切一小块"这类搬家，git 的启发式天生不适用。

所以审阅不能指望 `-C`，改用三条可复现的机器证据（B1 已实际跑通）：

1. **函数名集合对拍**（AST 口径）：facade 的 `FunctionDeclaration` 名字集前后比对，只允许"转为切片内部"这一种差异；
2. **双向文案对拍**：原文分节的字符串字面量 ↔ 切片，缺/增必须为 0（B1：68 ↔ 68）；
3. **规模对拍**：`git diff --stat` 的 deletion 与 slice 的 insertion 量应大致相当（B1：删 1,192 / 增 1,478，差额 286 = 切片新增的 ports 接口 51 行 + 文档注释 + `return` 汇编）。

这三条脚本都在 `E:\Temp\ocs-review-pw\verify-b1*.mjs`，属于一次性工具；若要长期留，建议合进 `scripts/migration-report.mjs` 一族。

---

## 10. 完成判据

`stores/workbench.ts` ≤ 3,000 行；无任何文件 > 4,000 行；每个切片可脱离 Pinia 单独单测；`npm run check:all`（含 AI 套件）绿一次。

**一处实测修正**：分节外的核心区（section -1）实测 **3,414 行**，`return` 字面量 1,155 行 —— 只按 §6 的批次表切完，`workbench.ts` 会落在 **≈3,400 行**，比 3,000 目标多约 400 行。要真正达标，B8 必须二选一：

- (a) B0 把核心区再拆成 `core-state.ts`（ref 声明）与 `core-undo.ts`（撤销账）；
- (b) `return` 改为按域拼装（`Object.assign({}, barrageSurface(), airSurface(), …)`），facade 可降到 ≈600 行。

推荐 (b)：它同时解决"1,155 行 `return` 字面量改一处要读全文"的问题，且 `public-surface.test.ts` 基线能直接证明拼装结果等价。

---

## 11. 明确不做

- ❌ 不引入 Pinia 嵌套 store（会破 `toRaw`、整盘快照与撤销语义）。
- ❌ 不动 `engine/`、`data/`、文案与任何规则行为。
- ❌ 不做一次性大搬（32k 行一把梭，冲突与回归都不可控）。
- ❌ 不为"好切"去改测试；测试是这次重构的安全网。

---

## 12. 两轮独立复核的结论（只记"被证据推翻的回答"）

复核的口径是**不看我自己写的结论，只重跑证据**。两轮下来，被推翻的有 4 条，被确认的有 3 条。

### 12.1 已被推翻（文档已改）

| #   | 原说法                         | 实测                                                         | 处置                           |
| --- | ------------------------------ | ------------------------------------------------------------ | ------------------------------ |
| R1  | 审阅搬家用 `git show -C`       | `-C`、`-C -C`、`-C50%` 全部只报"新增+删除"，不是 copy        | §9 改为三条机器证据            |
| R2  | `migration.csv` 的行号可直接用 | B0+B1 后漂移 1,185–1,203 行，且**逐符号不等**                | §1.5 改为脚本重算              |
| R3  | 表格只写"函数数"               | CSV 里函数与 `const` 同表，读者按 section 数行会得到另一个数 | §1.5 补 fn/const 两列          |
| R4  | 切片放 `stores/flows/*.ts`     | 与 `tests/flows/`（整局流程）撞词义                          | §4/§6 统一 `workbench-<域>.ts` |

R3 是 R2 的下游事故：**同一份数据两种口径**（fn-only vs fn+const）会让"文档错"和"脚本错"看起来一样。R4 同理——同一个词（`flows`）指两种东西。

### 12.2 被确认（B1 的转发层没有问题）

1. **38 个转发壳的参数一一对应**：逐壳比"形参个数/顺序/名字 ↔ 实参数"，并对齐切片里同名函数的声明元数 → 0 处丢参、0 处错位（脚本 `audit-shells.mjs`）。这是纯搬移最容易悄悄坏掉的地方（掉一个可选参数不报错，行为变了）。
2. **`barrageAutoOpened` 只有一份**：facade 里一个 `let barrageAutoOpened`（C7 状态块内）+ 装配点的 getter/setter 槽，切片内改一行 `autoOpened.value = false`，**没有影子副本**。
3. **重跑坐标脚本字节级一致**：`node scripts/migration-report.mjs --out <临时路径>` 与已提交的 `migration-当前坐标.csv` **完全相同**（1,322 行）。可复现这条不是声明，是实测。

### 12.3 仍然存在的风险：装配点后置 → TDZ 面

`barrage` 这个域在 **setup 末尾**（`return {` 之前那一段装配区）才初始化（因为 51 个端口里有 13 个声明在 24k–29k 行）。facade 里 38 个转发壳是**函数声明**（会提升），所以：

- **只是"把函数当值传出去"** → 安全（`createFireResolutionDomain` 调用处那 5 处裸引用就是这种）；
- **在装配点之前同步调用** → `barrage` 处于暂时性死区，**建 store 这一步就抛 `ReferenceError`**。

现状实测（`find-tdz-sites.mjs`：把 38 个名字在 facade 的全部出现点扫出来，排除壳块与装配点）：22k–29.8k 段只剩 6 个名字有引用，**全部在函数体里**（`reset` 全家桶 / 到货落点 / `afterRestore` / 两个 `flush:'sync'` 但非 `immediate` 的 watch 回调），setup 期一个都不会执行 → 当前**不炸**。

但这不是安全的，只是**还没踩**。同一个文件里已经记过一次同类事故（`seedVictoryControlFromScenario` 上方那段注释：把播种塞进 `immediate` watch，"建 store 这一步就抛错，全套用例一起红（660 条）"）。所以给后续批次一条硬约束：

> **禁止在装配点之前注册 `immediate: true` 的 watch，去触达任何转发名。** 需要 setup 期初值 → 直接调切片方法（`fireResolution.resetBarrage()` 这种），或在装配点之后再注册。

配套闸门（建议 B2 一起加）：`scripts/check-tdz.mjs` — 扫 facade 里"装配点之前"的 `watch(..., { immediate: true })` 回调体，若出现转发名就报错。比人工看注释可靠。

> 注：本节原稿写了一串行号（`~:1917`、`~:29898`、`~:23469` 等），已改成符号引用——这正是 §1.5 那个毛病：**坐标会随每批搬家漂移，写进文档当日有效、次日误导**。要定位用符号名或重跑 `scripts/migration-report.mjs`。

### 12.4 一条给自己（也适用于后续审查）的教训

**源码扫描不能行首锚定 `function`。** 本仓库存在 "JSDoc 与 `function` 同一行" 的写法（`setBarrageKind` 就是），正则 `^function` 会静默漏掉它——第一轮 AST 对拍与正则对拍差 1 就是这个原因，第二轮我自己的审计脚本又栽了一次（报"缺实现"，其实是工具错）。**结论：判断"符号是否存在/搬迁是否完整"一律用类型检查器或 AST，正则只用来找线索。**

---

## 附录 A：迁移清单怎么用

`migration.csv`（707 行，**旧口径**，行号已过期）：`section, section_title, function, line, inbound_sections_count, inbound_from_sections`。
`migration-当前坐标.csv`（1,322 行，**现口径**，脚本生成）：多一列 `kind`（`function` / `const`），`section` 为 31 分节制。

- 开工某批前：筛 `section = N and inbound_sections_count > 0` → 该批**必须对外暴露**的函数清单；
- 搬完后：筛该 section 剩余函数 → 应只剩 ports 装配与薄转发；
- `inbound_from_sections` 是跨切片改写清单：**本切片出边 = 写进自己 ports 的对方函数；入边 = 对方切片要在自己 ports 里接收的你**；
- **筛之前先按 `section_title` 的关键词确认编号**（两套编号不可互换，见 §1.5）；要数"搬几个函数"只看 `kind=function`。
