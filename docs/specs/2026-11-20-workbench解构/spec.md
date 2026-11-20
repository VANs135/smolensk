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

> **B2 = `workbench-air.ts`（空军域整体）**：状态块 2416–2592 + §18 全部 + §19 的空军半段（18503–18851：`airCombatPicksPayload` / `confirmAirCombatNow` / `airUnitsAt` / `canAirMissionTarget` / `resolveAirCargoNow` / `captureAirBaseNow` 等）+ 散落在 18092–20860 的空军函数（`beginAirMissionNow` / `confirmAirMissionNow` / `recordAbortedAirBarrage` / `completeAirReturnNow` / `airStatusLabel` 等）。

预计端口 **15–20 项**，切口 ≈ 1,100–1,300 行。开工前先用 `scripts/port-report.mjs` 对齐一次真实区间（把上面几段的首尾行取准），**别照抄本节的行号**（§1.5 的老毛病）。

同期判据：

- **§19 的另一半（轰炸/炮击入口判据 18003–18198）不进空军切片**——它是"三操作"的**协调层**，同时依赖轰炸与空军两域；留到 B5 之后单独做，或与 §19 剩余部分一起并进协调层。
- `airUnits`（1916，盘面飞机算子）与 `airBoxMembers`（1928）**不属于空军切片**：它们与地图/到货/轰炸共享，留在 facade 或 `workbench-core.ts`，由 ports 传入。这是"域"的边界，不是"名字里有 air"就该搬。

**方法论定下来**：每批开工第一步跑 `node scripts/port-report.mjs --start <首> --end <尾>`；**> 40 就重新划批**，不要硬切。这条替代了 B1 时那三个一次性脚本。

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
