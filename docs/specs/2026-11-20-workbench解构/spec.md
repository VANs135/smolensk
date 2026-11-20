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

**已有的拆分先例就是模板**：`createGroundMovementDomain(ports)`，切片顶部 `const { pushLog, applyMovePatches, … } = ports`，函数体原样不动。`AirMissionPorts` 现为 **17 个成员**，是 ports 规模的标尺。

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

| 文件                       | 职责                                                    | 行预算  |
| -------------------------- | ------------------------------------------------------- | ------- |
| `stores/workbench.ts`      | facade：装配、`watch`、`return` 汇编、转发              | ≤ 3,000 |
| `stores/workbench-core.ts` | 全局服务（日志/结算账/写门禁/撤销账）+ 共享 state       | ≤ 1,500 |
| `stores/flows/*.ts`        | 单域交互流程（轰炸/空军/移动/补给/战斗/到货/铁路/特战） | ≤ 3,000 |
| `stores/services/*.ts`     | 闸门与阶段机制（段状态机/放置阶段/专规机制/胜利判定）   | ≤ 1,500 |

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

| 约束                         | 做法                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| 一批 = 一 commit = 一 push   | DoD 第 5 条；`git status --porcelain` 为空才提交                                    |
| 纯搬移不混改动               | 同一 commit 不出现逻辑/文案改动，便于二分定位                                       |
| 让 git 认得出"搬家"          | `git config diff.renames copies`（已配）；审阅用 `git show -C --find-copies-harder` |
| 新文件一律 LF + UTF-8 无 BOM | `.gitattributes` 已是 `* text=auto eol=lf`；禁止用 PowerShell `>` 重定向生成源码    |
| 分支                         | `refactor/workbench-decouple`，每批一 commit 推远端                                 |
| 回退                         | 每批合并后本地打 tag `decouple-b<N>`                                                |

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

## 附录 A：迁移清单怎么用

`migration.csv`（707 行）：`section, section_title, function, line, inbound_sections_count, inbound_from_sections`。

- 开工某批前：筛 `section = N and inbound_sections_count > 0` → 该批**必须对外暴露**的函数清单；
- 搬完后：筛该 section 剩余函数 → 应只剩 ports 装配与薄转发；
- `inbound_from_sections` 是跨切片改写清单：**本切片出边 = 写进自己 ports 的对方函数；入边 = 对方切片要在自己 ports 里接收的你**。
