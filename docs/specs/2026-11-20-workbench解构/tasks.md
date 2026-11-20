# `stores/workbench.ts` 解构 — 任务分解

日期：2026-11-20　状态：待批　配套：`spec.md`、`migration.csv`

> 全程在 `refactor/workbench-decouple` 分支；每完成一项即 commit + push，不攒。门禁一律 `npm run check`（约 250s，不含 AI 套件）。

## 0. 前置（B-1，0.5 天）

- [x] `package.json` 拆 `test:fast` / `test:ai`，`check` 改用 `test:fast`，新增 `check:all`
- [x] `git config diff.renames copies`（仓库级，不入库）
- [x] 接通 SSH（`core.sshCommand` 指向 `~/.ssh/id_ed25519_smolensk`），`ssh -T` 返回 `Hi VANs135!`
- [x] 建分支 `refactor/workbench-decouple` 并 `git push -u origin`
- [x] 新增 `tests/stores/workbench-public-surface.test.ts` + `tests/stores/fixtures/workbench-public-surface.snapshot.json`，实测冻结 **1,013** 键（先绿再动刀）；反向验证过：从基线删一个键即红，并报出键名

## 1. B0 核心服务（切片 1 已落地）

- [x] 新建 `src/stores/workbench-core.ts`：`createWorkbenchCore(deps)`，deps 9 项（全部传引用或 getter）
- [x] 迁入 `pushLog`（669 处调用）/ `recordSettlement`（77 处）/ `noteRecord`；facade 只留同名薄转发，**存量调用点零改动**
- [x] 实测：`workbench.ts` 32,193 → 32,146；公开面 1,013 键不变；test:fast 623 文件 / 6,256 用例全绿
- [x] 迁入 `requireAction` / `actionAllowedNow`（47 + 23 处）—— 见 `workbench-gates.ts`
- [x] 迁入 `refuseWhileSettling`（5 处）
- [ ] 迁入撤销账（`undoTrail` / `noteUndoable` / `captureUndoSnapshot` / `dropUndoOf` / `undoFamilyHandlers`）—— **延后到 B7 之后**，理由见 `B0-审查记录.md` §3
- [ ] `segmentStep` / `segmentAdvanceBlock` 仅打成 port 透传（留给 B7）
      **B2-2a 施工单（2026-11-21 抽签名后定稿）**：区间 `17197–17992`（796 行 / 16 声明 = 14 function + 2 computed）。

先说一个上一版没看出来的类别：**"facade 自己 export 出去的符号"既不是端口、也不能 import**。

| 符号                   | 位置                    | 处理                                                                                                                                       |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `movementPhaseOf`      | `export function` @673  | **搬进 `workbench-model.ts`**（纯映射，只依赖 `ConsolePhase`/`MovementSegmentPhase`），facade 原地 `export { movementPhaseOf }` 兼容旧导入 |
| `SpecialCombatPending` | `export interface` @654 | 同样搬进 `workbench-model.ts` 并 re-export                                                                                                 |

理由（复核后的精确版）：**值**不能从 `./workbench` import——会造运行时的 facade ⇄ 切片环。现有切片里**没有一个**这么做（已扫全 `workbench-*.ts`）；唯一带回边的是 `workbench-model.ts`，而且它明确写着这是"类型环、编译期擦除、但 `tsc` 要顺环再解析一遍，B1 撞过 2,611 errors 的类型退化"，P2-1 把 4 个共享类型搬进 model 就是为了消掉这类回边。⇒ `SpecialCombatPending` 按同一政策搬 model，不是"技术上非搬不可"，而是**不给自己留回边**。

扣除这两项后，**端口 34 项 = 按值 27 + 晚绑定 7**（下表逐行数出来正好 27+7；文字里的 33/26 是嘴算错的，2026-11-21 用脚本复核修正）：

| 端口                                                                                                                                      | 类型（照声明抄）                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `phase` `turn`                                                                                                                            | `ComputedRef<ConsolePhase>` / `ComputedRef<number>`                                         |
| `rng`                                                                                                                                     | `ComputedRef<RngState>`                                                                     |
| `units` `airUnits` `airBoxMembers`                                                                                                        | `Ref<ConsoleUnit[]>` / `Ref<ConsoleAirUnit[]>` / `Ref<string[]>`                            |
| `groundMovement`                                                                                                                          | `ReturnType<typeof createGroundMovementDomain>`                                             |
| `moveInteraction`                                                                                                                         | `ReturnType<typeof createGroundMovementDomain>['moveInteraction']`                          |
| `spDumps` `offMapSupplyStocks` `supplyState`                                                                                              | `Ref<SpDump[]>` / `Ref<Record<string, SpHoldings>>` / `Ref<SupplyInteractionState \| null>` |
| `pushLog` `recordSettlement`                                                                                                              | 既有签名                                                                                    |
| `clearMoveInteraction`                                                                                                                    | `() => void`                                                                                |
| `refuseWhileSettling`                                                                                                                     | `(action: string) => boolean`                                                               |
| `eliminateEntry`                                                                                                                          | `(entry: DeadPileEntry, rule: string, text: string, refresh?: boolean) => void`             |
| `setAirInBoxMembership` `addSpAtHex` `airUnloadedTAt` `acceptAir` `setAirStatus`                                                          | 既有签名                                                                                    |
| `applyAirStepLoss`                                                                                                                        | `(instanceId: string) => void`                                                              |
| `drawAir2d6` `drawAir1d6`                                                                                                                 | `() => number`                                                                              |
| `airMissionKindLabel`                                                                                                                     | `(kind: string) => string`                                                                  |
| `requireAction`                                                                                                                           | `(key: ActionKey, action: string) => boolean`                                               |
| `noteUnitEnteredHex`                                                                                                                      | `(unit: ConsoleUnit, hex: HexRef) => void`                                                  |
| **接法实测**：14 个已有端口全部是**按值**且判定已在切片解构表里 ⇒ 本批不需要给它们做 `.value` 改写，只有 7 个晚绑定要写 `ports.x.value`。 |

**晚绑定 7 项的精确类型（TS 编译器 API 打印，可直接抄进接口）**：

| 成员                    | 类型                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `barrageFacts`          | `ComputedRef<{ enemyREInHex: (hex: HexRef) => number; hedgehogLevelInHex: (hex: HexRef) => number; stratModeInHex: (hex: HexRef) => boolean; hasSpotter: (hex: HexRef) => boolean }>` |
| `railMoveFacts`         | `ComputedRef<RailFacts>`                                                                                                                                                              |
| `airUnloadLedger`       | `Ref<Record<string, number>>`                                                                                                                                                         |
| `airMissionJoinChoices` | `ComputedRef<readonly AirMissionJoinChoice[]>`                                                                                                                                        |
| `specialPending`        | `Ref<SpecialCombatPending \| null>`                                                                                                                                                   |
| `airMissionSegmentKind` | `ComputedRef<AirMissionSegment \| null>`                                                                                                                                              |
| `airMissionKindChoices` | `ComputedRef<readonly { key: AirMissionKind; label: string }[]>`                                                                                                                      |

取法：`scripts/tmp-port-types.mjs`（`ts.createProgram` + `typeToString`，`tsconfig.json` 的 paths 生效）。其中 `barrageFacts` / `specialPending` 是**推断**类型，其余 5 项有显式类型参数可对拍。

| **晚绑定 7** | `barrageFacts`(computed 3682) / `railMoveFacts`(computed 4520) / `airUnloadLedger`(ref 15966) / `airMissionJoinChoices`(computed 16814) / `specialPending`(ref 18126) / `airMissionSegmentKind`(computed 22401) / `airMissionKindChoices`(computed 22425) |

**剪端口那一侧的连带义务（复核补，第二次实测已排掉 ports 实参 2239–2378）**：

| 名字                                 | 真实区外引用                                             | 要不要 return + 解构     |
| ------------------------------------ | -------------------------------------------------------- | ------------------------ |
| `airDistanceFromRealBase`            | 9（含 3799 与 16.8k 三处校验）                           | **要**                   |
| `airUnitsAt`                         | 3（其中 `29754` 是**别的域的 ports 实参**）              | **要**                   |
| `onMapAirUnits`                      | 2（`28888`/`29362` 都在 `createBarrageDomain` 的实参里） | **要**（轰炸域还在吃它） |
| `isAirInOffMapBox` / `airUnitsInHex` | 1 / 1                                                    | **要**                   |
| `applyAirCargoDelivery`              | **0**（唯一那处就是 ports 实参本身）                     | **不要**，剪干净即可     |

⇒ 5 个要回补、1 个不用；"回补"不只是 facade 自己用，**还因为其它域（轰炸）的 ports 实参在吃这些名字**。

**同时要剪掉的 6 个既有端口**（定义就在本区间里）：`isAirInOffMapBox`/`onMapAirUnits`/`airUnitsAt`/`airDistanceFromRealBase`/`airUnitsInHex`/`applyAirCargoDelivery`——接口成员、`createAirDomain` 解构、facade ports 实参（含 `get` 访问器）三处同删，并把切片里已有的 `ports.X` 改回裸名。

端口总数：36 − 6 + 20 = **50**（34 端口 − 已有 14 = 新增 20；单批新增 20 < 40 红线 ✓，但接口本身开始变宽，B3 之后应考虑把 `pushLog`/`recordSettlement`/`requireAction` 这类基础设施挪进 `workbench-core` 的共享固定面）。

- 验收：`npm run check` 绿 + `tests/stores/*` 日志/撤销/存档用例绿 + 公开面键集不变

### B2-2a 空军动作块（**已落地 2026-11-21**）

- [x] 区间 `17197–17992` 全数搬进 `workbench-air.ts`：**796 行 / 16 声明（14 function + 2 computed）**
- [x] 逐字对拍：搬入块 796 行 ↔ HEAD 区间 796 行，**只去 `ports.` 前缀（`.value` 与空白保留）⇒ 不一致 0 行**
- [x] 端口实装 **50 项 = 按值 43 + 晚绑定 7**（施工单预算 50 项 ✓；本批新增 20 = 按值 13 + 晚绑定 7，其余 14 是 B2-1/B2-1b 既有）
- [x] 剪掉 6 个既有端口（`isAirInOffMapBox`/`onMapAirUnits`/`airUnitsAt`/`airDistanceFromRealBase`/`airUnitsInHex`/`applyAirCargoDelivery`）：接口成员、`createAirDomain` 解构、facade 实参（含 `get onMapAirUnits`）三处同删；实测 ports 实参里残留 **0** 处
- [x] 切片内既有 `ports.onMapAirUnits` 改回裸名 **3 处**（它现在是切片内部声明）
- [x] `return` **104 名 = 88 + 16**，重复 **0**；facade 解构回补 21（16 声明 + 5 回补），去重 5 行（那 5 个本来就在 16 声明里，回补是重复计算）
- [x] `movementPhaseOf`（`export function`）+ `SpecialCombatPending`/`SpecialTransportSplit`/`SpecialDisplacementItem`（3 个 interface）搬进 `workbench-model.ts`；facade 用 `export type {…} from './workbench-model'` + `export { movementPhaseOf } from './workbench-model'` 原样转出，**外部导入路径不变**
- [x] 回边归零：切片 `import … from './workbench'` 实测 **0 处**
- [x] 规模：`workbench.ts` **30,074 → 29,253 行（−821 = 796 搬走 + 25 条搬后失效的 import/解构项被删）**；`workbench-air.ts` **1,201 → 2,070**；`workbench-model.ts` **4,104 → 4,162**
- [x] 门禁：`npm run typecheck` 通过 → `npm run check` **623 文件 / 6,256 用例 / 195.66s / exit 0**；`arch` 源码 950（不变）；`audit:ports` 5 个域全绿
- [x] 公开面快照 1,013 键不变（`workbench-public-surface` 用例绿）

**落地时才暴露的四个坑（施工单里没有）**：

1. **晚绑定改写不能只匹配 `x.value` 前面不是 `.`**：`...airUnloadLedger.value`（展开运算符）的 `.` 会被 `(?<![\w.$])` 当成属性访问而漏掉 ⇒ `airUnloadLedger.value = { ...airUnloadLedger.value, … }` 只改到一半。必须单独处理 `...x.value`。实测该处补漏 1 处。
2. **"回补 5 项"在 `return` 侧是重复劳动**：那 5 个名字**本身就是区间内声明**（16 声明里就有），`return` 与 facade 解构各补一遍 ⇒ 对象字面量重复键（TS1117）+ 解构重复绑定。正确做法：回补清单只用于"确认它们确实在 return 里"，不额外插入。
3. **type-only import**：`verbatimModuleSyntax` 打开着，`AirMissionJoinChoice`/`DeadPileEntry`/`SpecialCombatPending`/`AirMissionCargo`/`AirMissionSegment`/`AirTargetHexFacts`/`SupplyInteractionState`/`AirUnitTransportState` 必须写 `type X`；`createGroundMovementDomain` 只在 `ReturnType<typeof …>` 里出现 ⇒ 必须 `import type`（否则 eslint `consistent-type-imports` 报红）。
4. **"删除自身行号"批量清 unused 会误删整条 import**：`import { airCargoTransportT, checkAirTransportMovementHandoff } from …` 里只有后者未用，按行删把前者也带走，后续 `airCargoTransportT` 找不到名。清 unused 必须按**导入名**删，不能按行删。

**第五个坑（测试与切片脱节，与 B2-1b 同源）**：`tests/engine/single-implementation.test.ts` 有两处直接 `readSource('src/stores/workbench.ts')` 找 `weatherLimited: airInputs.value…` 这段字；搬到切片后守门假红。改成 `readStoreSource()`（facade + 全部切片聚合）后 15 用例全绿。⇒ **凡是"源码里必须有这段字"的守卫，一律走 `readStoreSource()`**。

## 2. B1 轰炸（已落地，`e0f…`→待填）

- [x] 新建 `src/stores/workbench-barrage.ts`（1,479 行）：`createBarrageDomain(ports)` ← section 8（1,212 行 / **39 动作 + 18 账本派生**）
- [x] ports **51 项**（`BarragePorts`）：按 AST 自由变量分析实测，不是按 CSV 的 inbound 猜的；其中 13 项声明在 24k–29k 行 ⇒ 装配点必须放 setup 末尾（`return` 前），早装配会踩 TDZ
- [x] 39 个动作中 38 个在 facade 留同名转发（唯一例外 `bestDefenderTerrainLine` 仅切片内自用），`acceptBarrage` 等 5 处被 `createFireResolutionDomain` 裸引用的老写法**一字未改**
- [x] 18 个账本/派生在装配点解构绑定；`barrageAutoOpened`（唯一非 ref 跨切片状态）用 getter/setter 槽对象承接，保持非响应式语义
- [x] 实测：`workbench.ts` 32,132 → **31,075**（-1,057，与净下降公式吻合）；公开面 1,013 键不变；`npm run check` 全绿（623 文件 / 6,256 用例 / 180s）
- [x] 文案对拍：原文分节 68 条字符串 ↔ 切片 68 条，**双向 0 缺 0 增**
- [x] 函数名集合：main 708 / HEAD 707，唯一差异是 `bestDefenderTerrainLine`（转为切片内部）
- [x] **源码守卫测试改造**：tests 里 35 处 `readFileSync('src/stores/workbench.ts')` → `tests/shared/store-source.ts` 的 `readStoreSource()`（facade + 全部 `workbench-*.ts` 切片；**切片排在前**，否则 `indexOf('function X')` 会撞到 facade 的同名转发壳）
- 验收：`npm run check` 绿

## 3. B2 空军（**2026-11-20 重划：按域切，且分两步**）

原计划「section 10 + section 11」实测端口 **82 项**（43 + 65），超过「> 40 就再拆」的红线；改按域切后复测仍有 **48 项**（详见 spec §6.1）。故分两个提交。

### B2-1 状态 + 派生（先做，无函数体）

- [x] 新建 `src/stores/workbench-air.ts`（**487 行**），搬 **状态块 2416–2543 + 整备块 2558–2592**（26 个 ref）+ **派生块 5949–6086**（12 个 computed）
- [x] 建域点落在 2416（替换原状态块首行），**没有压到 setup 末尾**——只有 5 项晚绑定，其余按值即可
- [x] 实装端口 **25 项 = 20 按值 + 5 晚绑定**（⚠ 上一版写的"6 直连 / 19 getter"被实装推翻：**函数声明会提升，无论声明多晚都能按值传**，真正需要晚绑定的只有 `const`/`computed` 五个——`zocOnlySupplyFacts`(4192)、`onMapAirUnits`(18612)、`airCargoLossPending`(19673)、`segmentGateQuery`(23302)、`constructionMarkerPieces`(27836)；`constructionMarkerAirBaseId`(27821) 是函数，按值传）
- [x] 不能漏的三个端口 `setAirStatus`(:17440)、`markAirMissionFlown`(:17459)、`pushLog`(:7075) 已在端口表内（靠 `scripts/port-crosscheck.mjs` 对拍才发现）
- [x] `AirInputs`(:819–927) + `createAirInputs`(:936–976) 整块搬进 `workbench-model.ts` 并 `export`；facade 补 `createAirInputs` / `createAirDomain`、清掉 13 个搬后失效的 import
- [x] 切口落实：2416–2543（**2550–2557 的 weather watch 与其注释留在 facade**——切片内 watch 会双触发）/ 2558–2592 / 5949–6086
- [x] 切片 `return` **40 个名**，公开面 **1,013 键不变**
- 命名：**域对象叫 `airDomain`，不要叫 `air`**——facade 里已有 `airSupply` / `airUnitTransit` / `airMissionDomain` / `airCargoResolution` 四个 air 开头的域，再加一个 `air` 无法区分（另：`(air) => …` 这种回调参数在文件里出现几十次，`air` 这个名字太容易被误读成本地变量）
- **验收实测**：`npm run check` → 623 文件 / 6,256 用例 / 201.16s / exit 0；`arch` 949 源码（+1 切片）；`workbench.ts` **31,036 → 30,649 行（−387，注意 31,074 是 P2-1 之前的旧读数）**；测试零改动（`tests/shared/store-source.ts` 用 `readdirSync` 自动纳入新切片，38 处源码守卫无需改）

### B2-1b 派生补遗（**第七轮复核发现，排在 B2-2a 之前**）

B2-1 只搬了派生的一半——`5949–6086` 那一簇；`5701–6321` 的 **48 个声明（621 行）**还留在 facade，且都是空军域的东西（返航三选一 / 空战轮对 / 巡逻区 / 任务格敌方事实 / 可夺基地 / 整备套件 / 转移 / 缩减）。漏的原因是**按分节横幅 `/* ── C9 空军交互：派生 ── */` 取 range，而横幅只覆盖后半**。

- [x] 搬 `5701–6321`（`airMissionReturnChoices` … `reducedBases`；621 行 / **48 个声明 = 14 function + 34 const/computed**）到 `workbench-air.ts`
- [x] 端口：**预判 16 → 实装 25 候选 → 净增 11**（`phase`(953) / `airBoxMembers`(1767) / `allSpDumps`(3849,晚绑定) / `supplyFacts`(3911,晚绑定) / `hqDeliveryDumpKeys`(14205) / `isAirInOffMapBox`(18220) / `airUnitsAt`(18229) / `airDistanceFromRealBase`(18343) / `airUnitsInHex`(18352) / `actionAllowedNow`(23285) / `isConstructionMarkerAirBaseId`(27439)）；`units`/`airUnits`/`pushLog`/`setAirInBoxMembership` 早已在 B2-1 的 25 项里，`onMapAirUnits` 也是（**晚绑定，本簇只是使用者**）。`AirDomainPorts` **25 → 36 项**
- [x] **预判被推翻的一处**：`onMapAirUnits` 在切片里不能写裸名——它已是 B2-1 的晚绑定端口，正文必须改写成 `ports.onMapAirUnits.value`，否则 `Cannot find name`（生成脚本必须做这个改写，逐字对拍也要按此归一化）
- [x] **`TS6133` 的正确解读**：facade 报"未使用"的名字分两类——(a) **引擎导出**（`refitCapacity`/`isFighterAircraft`/`hexLabel`/`planOffMapAirBoxFlightFromHex`/`airInteractionChecklist`/`inPatrolZoneOf`/`patrolZoneHexes`/`planInterceptionResponse`/`drawableDumpsFor`/`type AirBaseView`/`type InterceptionResponse`/`canUseTransport`/`isAirTransportableUnit`）⇒ facade 删、**切片重新 import**，不进端口；(b) **facade 自有**（`onMapAirUnits` 等）⇒ 进端口。把 (a) 当端口会白加 12 个端口
- [x] 这簇里含**动作**（`toggleAirCargoUnit`/`beginTransferNow`/`toggleTransferAircraft`/`cancelTransferNow`/`completeTransferToBaseNow`），搬的是行为而不只是派生——公开面 **1,013 键不变**
- [x] 边界：start 取 **5701**（`airMissionReturnChoices` 的文档注释首行；上一条 `supplyPickupRequirement` 在 5699 收尾）；end 取 **6321**（`reducedBases` 的 `)`；6323 起是 `moveRuntime` 的注释）。**按 5711/6319 切会把注释留成孤儿、把函数切在中间**
- [x] **源码级测试要跟着改**：`tests/stores/action-wiring.test.ts` 的 `STORE_FILES` 是硬编码清单，只列了 `workbench.ts` ⇒ 搬走的 `cancelTransferNow` 立刻"不是 store 函数"。改为 `globSync('src/stores/workbench-*.ts')`，且**必须排在卫星 store 之后**——`rollAttritionNow` 在 facade 已只剩三行转发壳（壳里没有 `requireAction`），先扫会抢到壳、报"标了已加闸其实没加"
- **验收实测**：`npm run check` → 623 文件 / 6,256 用例 / **208.62s** / exit 0；`arch` 949 源码；`workbench.ts` **30,649 → 30,075 行（−574）**、`workbench-air.ts` **487 → 1,202 行（+715）**；逐字对拍**只去 `ports.` 前缀、`.value` 与空白都不动** ⇒ **621 行完整命中**（2026-11-21 收紧口径复核）；重复定义 0、僵尸函数 0；`/= airDomain` 解构 **85 项 = 88 公开名 − 3 个只有切片自己用的**（`transferBaseId`/`airDistanceToBox`/`canTransferAirToBox`，已核公开面快照里从来没有这 3 个键）

### B2-2 动作块（后做，**2026-11-20 重测：拆 4 批，全部 < 40 端口**）

B2-1 落地后行号全部漂移（facade 少了 387 行），旧编号 **全部作废**。按符号名重新定位、用 `port-crosscheck.mjs` 扣掉"已属切片内部"的 40 个名字后实测：

| 批次         | 当前区间                  | 内容                                                                                                                                                                                                                                                                                                                                                                          | 真端口                              | 行数                |
| ------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------- |
| **B2-2a** ✅ | `17197–17992`             | `beginAirMissionNow` … `captureAirBaseNow`（含 `confirmAirCombatNow`、`airTargetFactsAt`、`airTypeCanPerformKind`、`airPlaneCanPerformKind`、`airMissionTargetCandidates`、`resolveAirCargoNow`、`applyAirCargoDelivery`）                                                                                                                                                    | **35**                              | 796                 |
| **B2-2b** ✅ | `17880–18318`（搬前坐标） | `airMissionCargoCapacityNow` / `airCargoLossPending` / `airCargoLossPicked` / `queueAirCargoLoss` / `toggleAirCargoLossPick` / `confirmAirCargoLossNow` / `hasCargoOwnership` / `resolveFlakNow` / 任务执行前半（`beginAirTargetHexPickNow`、`runAirMissionNow`、`previewAirCombatRoles`、`autoResolveAirMissionNow`、`finishAutomaticAirReturn`、`finishAbortedAirMission`） | **8**（原估 27，B2-2a 已内部化 19） | **439**（原估 438） |
| **B2-2c** ✅ | `17879–18209`（搬前坐标） | `beginAirBarrageNow` / `runBarrageChainNow` / `airMissionResultReady` / `confirmAirMissionNow` / `settleAirMissionNow` / `recordAbortedAirBarrage` / `completeAirCargoReturn` / `completeAirReturnNow`                                                                                                                                                                        | **18**（原估 31）                   | **331**（原估 319） |
| **B2-2d** ✅ | `17902–18335`（搬前坐标） | `cancelAir` / `toggleAirstripBase` / `refitBaseNow` / `beginRefitNow` / `confirmRefitSelectionNow` / `toggleRefitAircraft` / `cancelRefitNow` / `pickRefitPayDump` / `confirmRefitPaymentNow` / `transferAircraftNow` / `toggleAirReductionUnit` / `reduceBaseNow` / `airMissionKindLabel` / `airStatusLabel`                                                                 | **6**（原估 21）                    | **434**（原估 443） |

（合并量过一次：`19283–20490` 一起切要 **90 项**、扣掉切片内部仍剩 65 项，超红线 ⇒ 必须拆。）

**每批搬动前先按 spec §6.1.2 剪端口**：`onMapAirUnits`(18225)、`applyAirCargoDelivery`(18368) 属 a 批；`airCargoLossPending`(19286) 属 b 批；`airMissionResultReady`(19821)、`completeAirCargoReturn`(19931) 属 c 批。搬到时要从 `AirDomainPorts`、解构表、facade 的 ports 实参（含 `get` 访问器）三处同时删，否则要么重复声明、要么 getter 自指。

- [x] 顺序：a → b → c → d（d 里的 `airMissionKindLabel`(20473) 被 a/b/c 引用，先做 d 可少一个端口；先做 a 则它按值传，也无妨）（**四批已全部落地**；d 最后做，如预期只剩 6 个端口）
- [ ] 边界（**2026-11-21 重测，推翻上一版的 `18578`**）：`captureAirBaseNow` 现 **17851** 起、**17992** 止（`return true` 后紧接 `}`），`17993` 空行、`17994` 是 C6 的分节横幅 `/* ── 9.14 特殊战斗 … ── */`；`18005` 起才是 `printedHedgehogOwners`，它上面的 `/** … * */`（17996–18004）属 C6。**上一版写的 `18578` 落在这个 C6 注释块的 `*/` 上** ⇒ 按它切会把别人家的注释尾吞掉（`*/` 进切片、`/**` 留 facade，直接语法错）。**教训：符号定位只给"起点"，终点必须看闭合 `}` 的下一行是什么**——下一行是 `*/` 就说明切进了别人的注释块
- [ ] 端口报数 **35 项**（工具口径；其中 `movementPhaseOf` 按施工单搬 model ⇒ **实际进端口 34 项**）：`port-crosscheck` 报 51 项、`port-report` 报 52 项，两者扣掉 B2-1/1b 已搬成切片内部的 17 项后**取并集 = 35**。差的那一项是 `movementPhaseOf`(673，`export function`)——它写在 facade 里但**是 export**，`crosscheck` 的规则把它归进「未在 setup 体内声明（真·外部）」那一栏，而那一栏平时被当成噪音跳过。按值 28（`movementPhaseOf`/`phase`/`turn`/`rng`/`units`/`groundMovement`/`moveInteraction`/`airUnits`/`airBoxMembers`/`spDumps`/`offMapSupplyStocks`/`supplyState`/`pushLog`/`recordSettlement`/`clearMoveInteraction`/`refuseWhileSettling`/`eliminateEntry`/`setAirInBoxMembership`/`addSpAtHex`/`airUnloadedTAt` /`acceptAir`/`setAirStatus`/`applyAirStepLoss`/`drawAir2d6`/`drawAir1d6`/`airMissionKindLabel`/`requireAction`/`noteUnitEnteredHex`）＋ **晚绑定 7**（`barrageFacts`(computed 3682)/`railMoveFacts`(computed 4520)/`airUnloadLedger`(const 15966)/`airMissionJoinChoices`(computed 16814)/`specialPending`(const 18126)/`airMissionSegmentKind`(computed 22401)/`airMissionKindChoices`(computed 22425)）
- **工具口径（本轮补）**：两套工具必须各跑一遍再**取并集**，不能只信一套——
  ① `port-report.mjs --json <路径>` 是**写文件**，不是打到 stdout（不带路径会 `path.resolve(undefined)` 崩）；
  ② 它把"facade 自己 export 的函数"（如 `movementPhaseOf`）算成"真·外部"，而 `port-crosscheck` 又只导「端口」栏 ⇒ **两套都会漏掉这一类的同一个名字**，只有把两栏并起来才看得见；
  ③ `movementPhaseOf` 若要进切片，**不能**从 `./workbench` import（会造 facade ⇄ 切片环），当端口传（它是函数声明，按值安全）或先搬进 `workbench-model.ts` 再 re-export。
- [ ] **本批要剪 6 个端口**（它们的定义就在 a 批区间里，搬完即内部）：`isAirInOffMapBox`(17646)/`onMapAirUnits`(17651,晚绑定)/`airUnitsAt`(17655)/`airDistanceFromRealBase`(17769)/`airUnitsInHex`(17778)/`applyAirCargoDelivery`(17794)。三处同删（接口成员 + `createAirDomain` 解构 + facade ports 实参含 getter），并把切片里已有的 `ports.X`（B2-1b 用过 `isAirInOffMapBox`/`airUnitsAt`/`airDistanceFromRealBase`/`airUnitsInHex`/`ports.onMapAirUnits.value`）**改回裸名**——否则 `Ports` 上已无此成员，typecheck 报错；`onMapAirUnits` 改裸名后它是切片内的 computed，仍须进 `return`（facade 别处还在用）
- [ ] 不含 `airMissionAllowedInPhase`(17710) 与 `bombingEntryEligible`(17721)/`barrageTargetsNow`(17737)/`hipShootEntryEligible`(17761)：§19 跨轰炸+空军的入口判据，留 B5 之后
- [ ] 不含 `airMissionKindChoices`(22999)、`airMissionSegmentKind`(22975)：单点派生，随 B5/B6 走
- [ ] 不含 `airUnits`(1755) / `airBoxMembers`(1767)（与地图/到货/轰炸共享，留 facade）
- 验收：`npm run check` 绿 + 公开面 1,013 键不变 + facade 函数数 707 递减到对应值 + 画面/文案对拍 0 差

**工具口径提醒（本轮实测）**：`port-crosscheck.mjs` 的「端口」一栏可信，但它的「未在 setup 体内声明（真·外部）」一栏**不可信**——函数局部变量与回调参数（`unit`/`entry`/`index`/`target` 等）会被列进去（a 批就列了 128 项假外部）。只看端口那一栏，剩下靠 `vue-tsc` 收口。

### B2-2b 货物损失 / 防空 / 任务执行前半（**已落地 2026-11-21**）

- [x] 搬 `17880–18318`：**439 行 / 14 顶层声明（11 function + 1 computed + 2 ref）** —— 区间首行是 `airMissionCargoCapacityNow` 的文档注释，末行是 `finishAbortedAirMission` 的 `}`；下一行空行、再下一行是 `beginAirBarrageNow`（B2-2c）的文档注释
- [x] **台账口径被实测修正两处**：① 原写 `19283–19720`（438 行）是 **B2-2a 之前的坐标**，搬走 821 行后应为 `17880–18318`（439 行）；② 原写"12 个符号"漏了 `airCargoLossPicked`（`ref<string[]>`）与 `toggleAirCargoLossPick`，实际 **14 个顶层声明**
- [x] 端口：`AirDomainPorts` **50 → 57**（−1 `airCargoLossPending` 转内部，+8 新增）
      · 新增 8 项全部**按值**：`barrageState`(`Ref<BarrageInteractionState|null>`，facade 在 1608 行解构出来的)、`beginHexPick`(`(pick: PendingHexPick)=>void`)、`hexTextOf`(`(hex: HexRef)=>string`)、`setAirTargetFromText`(`(text:string)=>boolean`)、`declareInterceptionNow` / `resolveInterceptionCombatNow` / `confirmAirMissionNow` / `completeAirReturnNow`（均 `()=>boolean`）
      · **实测推翻"27 端口"的预判**：那 27 项里 19 项已被 B2-2a 搬成切片内部（`beginAirMissionNow`/`confirmAirCombatNow`/`airMissionTargetCandidates`/`airUnitsInHex`/`enemySide` 等），且 5 个"看起来晚绑定"的其实是**函数声明（会提升）**，不需要 getter ⇒ 真·新增 8
- [x] 剪端口 `airCargoLossPending`：接口成员、facade `get` 访问器、切片正文 `ports.airCargoLossPending.value`（1 处）三处同删/改裸名；facade 16665 仍在用它 ⇒ 经 `= airDomain` 解构回补
- [x] `PendingHexPick` / `HexPickCandidates`（facade 1719–1731，非 export）搬进 `workbench-model.ts` 并 `export`，两侧 `import type`
- [x] 切片 `return` **104 → 116**（+12），重复 0；facade 解构 +12
      · **刻意不进 `return`/`解构` 的 2 个**：`queueAirCargoLoss`、`previewAirCombatRoles` 区外引用 **各 0**，属切片内部自用（`prefer` 少暴露）
- [x] 连带清理：facade 解构里 `enemySide`、`airUnitsInHex` 因正文搬走而变成未使用（TS6133）⇒ 从解构中删掉；facade 删 7 个搬后失效的 import（`airCargoTransportT`/`skipEmptyAirMissionFlak`/`planCargoLoss`/`validateCargoLossChoice`/`declareAirCombatStep`/`resolveFlakStep`/`toAirMissionAircraftView`）
- [x] 回边归零：切片 `import … from './workbench'` 仍是 **0 处**
- [x] 规模：`workbench.ts` **29,252 → 28,811（−441 = −466 + 25）**；`workbench-air.ts` **2,069 → 2,542（+473 = +491 − 18）**；`workbench-model.ts` **4,161 → 4,177（+16）**
- [x] 门禁：`npm run typecheck` 通过 → `npm run check` **623 文件 / 6,256 用例 / 196.40s / exit 0**；`arch` 源码 950；`audit:ports` 全绿（`createAirDomain` 按值 **45** 项全部安全）
- [x] 公开面快照 **1,013 键不变**（本提交未触碰 fixture）
- [x] 复核：逐字对拍 **439 行 ↔ 439 行、只去 `ports.` 前缀、不一致 0 行**；文案多重集 **53 ↔ 53、缺 0 增 0**；**零使用端口 0 / 57**；facade 新增 25 行 = 注释 2 + import 3 + 单个标识符 20（8 实参 + 12 解构），**非预期 0**

**落地期暴露的三个坑**：

1. **一个脚本里既"删上方小块"又"按原始行号删大区间" ⇒ 必然删错。** 脚本先删掉 `PendingHexPick`（14 行）再按 `START-1` 删区间，区间整体上移 14 行，结果从块中间切开，留下半截正文（`TS1005` 一片）。修法：**先删大区间（用原始坐标），再处理上方小块**（上方小块删除不影响其自身坐标）。
2. **"函数声明晚于建域点"不等于"必须晚绑定"。** 本批 5 个候选（`declareInterceptionNow`/`resolveInterceptionCombatNow`/`confirmAirMissionNow`/`completeAirReturnNow`/`setAirTargetFromText`）声明在 16k–18k，但都是 `function` ⇒ 提升 ⇒ 按值传即安全。判据仍是"**是 `const`/`computed` 吗**"，不是行号。
3. **`airBarrageStrengthOf` 在 `workbench-model.ts`（2153），不在 `@/engine/rules` 桶里。** 按"看着像引擎导出"就往 `@/engine/rules` 加 import 会报 `TS2305`；**符号归属只能靠报错或 grep 定义**，不能靠命名风格猜。

### B2-2c 空军轰炸任务 / 任务结算 / 中止与返航收尾（**已落地 2026-11-21**）

- [x] 搬 `17879–18209`：**331 行 / 8 顶层声明（全 `function`）** —— `beginAirBarrageNow`(17892) / `runBarrageChainNow`(17965) / `airMissionResultReady`(17984) / `confirmAirMissionNow`(18009) / `settleAirMissionNow`(18023) / `recordAbortedAirBarrage`(18082) / `completeAirCargoReturn`(18094) / `completeAirReturnNow`(18206)。首行是 `beginAirBarrageNow` 的文档注释 `/**`，末行 `  }`、再下一行空行、再下一行是 `cancelAir`（B2-2d）的注释
- [x] **台账两处口径被实测修正**：① 原写 `19729–20047`（319 行）是 B2-2a 之前的坐标（B2-2a 821 行 + B2-2b 441 行搬走后整体上移），实际 **`17879–18209` / 331 行**；② 原估"31 端口" → 实装新增 **18**
- [x] 端口：`AirDomainPorts` **57 → 71**（−4 内部化、+18 新增）
      · `port-report` 报 **40** 项；扣掉**已是端口 9**（`barrageState`/`airUnits`/`pushLog`/`recordSettlement`/`airUnloadLedger`/`airUnloadedTAt`/`acceptAir`/`airMissionKindLabel`/`noteUnitEnteredHex`）＋ **切片内已有 13**（`airTargetHex`/`airMissionAbortPending`/`airSupply`/`airUnitTransit`/`airUnitCargoManifest`/`airMissionDomain`/`airState`/`airError`/`airInputs`/`airMissionFlyingUnits`/`resolveAirCargoNow`/`finishAutomaticAirReturn`/`finishAbortedAirMission`，均为切片自己的声明或 `= airMissionDomain` 解构）⇒ **真新增 18**
      · 按值 **15**：`barrageInputs`(1601)/`barrageKind`(1618)/`barrageTargetKind`(1620)/`barrageUnitIds`(1622)/`barragedHexesThisPhase`(1642)/`barragedUnitIdsThisPhase`(1643)/`barrageAirIds`(1690) 七个 `Ref` ＋ `canReplaceBarrage`/`clearBarrage`/`beginBarrageNow`/`confirmBarrageSupplyStep`/`confirmBarrageShiftsStep`/`confirmBarrageLossNow`/`rollBarrageDiceStep`/`confirmBarrageOutcomeStep` 八个函数声明（声明在 11k–13k，**提升 ⇒ 按值安全**）
      · 晚绑定 **3**（facade 用 `get` 访问器传、切片正文写 `ports.x.value`）：`barragePickHex`(`Ref<HexRef|null>`, 3644) / `barrageLossRequired`(`ComputedRef<number>`, 27646) / `barrageLossReady`(`ComputedRef<boolean>`, 27648)
- [x] 内部化 **4 个**（声明就在本区间内）：`airMissionResultReady` / `completeAirCargoReturn`（原只被 ports 实参喂给 `createAirMissionDomain` 的 `resultReady`/`returnCargo`，搬后为切片内裸名，**不回补**）；`confirmAirMissionNow` / `completeAirReturnNow`（区外各 2 处：16748/16749 与 store 公开面 28209–28211 ⇒ **回补**）
- [x] 额外回补 3 个（**不在原施工单的 4 个候选里，是彻底扫 8 个声明名才发现的**）：`beginAirBarrageNow`(27979) / `settleAirMissionNow`(28210) 出现在 **store 公开面**、`recordAbortedAirBarrage`(16758) 被区外代码用 ⇒ 三者都进切片 `return` 并被 facade 解构回补
- [x] **反向剪除 2 个**（B2-2b 加进 return/解构的）：`finishAutomaticAirReturn` / `finishAbortedAirMission` —— 它们唯一的取用点（`autoResolveAirMissionNow` 尾部 `return finishAutomaticAirReturn()`、`beginAirTargetHexPickNow` 里 `return finishAbortedAirMission()`）都在本批区间内，搬完 facade 侧立刻 TS6133 ⇒ 从 `return` 与解构**两边同时删**
- [x] 切片内既有晚绑定端口 `airUnloadLedger`（本区间 2 处，其中 1 处是 `...airUnloadLedger.value` 展开）改写成 `ports.airUnloadLedger.value`；`barragePickHex`/`barrageLossRequired`/`barrageLossReady` 各 1 处同改写
- [x] 解构 **44 → 55**（−4 +15，晚绑定 3 项**不进解构**，否则建域时取 getter 撞 TDZ）；getter **12 → 15**；切片 `return` **116 → 119**（+5 −2），重复 0
- [x] 连带 import：切片补 `planRetainedCargoReturn`（并入 air-mission-roster 那行）、`type BarrageInputs`（`./engagement-inputs`）、`type BarrageKind`/`type BarrageTargetKind`（并入 `@/engine/rules` 块）；facade 删 `planRetainedCargoReturn`、`transportCapacityOf`、`type AirInteractionState` 三处失效 import
- [x] 回边归零：切片 `import … from './workbench'` 仍 **0 处**
- [x] 规模：`workbench.ts` **28,811 → 28,503（−308 = −340 + 32）**；`workbench-air.ts` **2,542 → 2,906（+364 = +380 − 16）**；`workbench-model.ts` 未动
- [x] 门禁：`npm run typecheck` 通过 → `npm run check` **623 文件 / 6,256 用例 / 195.96s / exit 0**；`arch` 源码 950；`audit:ports` 全绿（`createAirDomain @2155` 按值 **56** 项、`createBarrageDomain @27268` 按值 50 项）
- [x] 公开面快照 **1,013 键不变**（本提交未触碰 fixture）
- [x] 复核 R1（行文本口径）：逐字对拍 **331 ↔ 331 行 / 非空 324 ↔ 324 / 不一致 0**，8 声明序列完全一致，4 个 `ports.x.value` 改写点各就位
- [x] 复核 R2（AST 口径，换工具）：**TS 语法树签名 1,775 ↔ 1,775 节点 / 不一致 0**（拆掉 `ports.` 那一层 PropertyAccess 后比对）；接口 71 = 解构 55 + getter 15 + 走 `ports` 的 1（`constructionMarkerAirBaseId`，按值传但不解构）；**零使用端口 0/71**；facade 新增 32 行 = 注释 3 + 单标识符 20 + getter 9 片段，**非预期 0**

**落地期暴露的四个坑**：

1. **区间里用到的既有晚绑定端口也必须改写。** `airUnloadLedger` 在 B2-1b 就已改成"走 `ports`"，但本批搬入的正文里仍是裸名 ⇒ `TS2304: Cannot find name 'airUnloadLedger'`。判据：搬入块的每一个外部名，若它**已在端口表里且是 getter 传的**，必须补 `ports.`。
2. **"搬完要不要在 facade 回补"必须扫全部声明名，不能只核施工单列的候选。** 施工单只说 4 个，实测另外 5 个都有区外引用（`beginAirBarrageNow`/`settleAirMissionNow` 在 store 公开面、`recordAbortedAirBarrage` 在 16758）。漏扫的代价是 `TS2552` + `TS18004`。
3. **上一批加进解构的名字，若唯一取用点就在本批区间内，搬完必成 TS6133。** `finishAutomaticAirReturn`/`finishAbortedAirMission` 就是这样；正确处理是**在 `return` 与解构两边一起剪**，只剪一边会留半边泄漏（`return` 里多一个没人解构的名字不报错，但会污染端口面）。
4. **`(?<![\w.$])` 会漏展开运算符 `...x`**（第二次踩，B2-2a 已记过）：`...ports.airUnloadLedger` 需要一个"前一个字符不是 `.`"的 lookbehind 才能命中裸名，但 `...` 的最后一个字符正是 `.`。改用 `(?<![\w$])`，并把替换**限幅在搬入块之内**（否则会打坏顶部注释里的名单）。

**工具口径（本轮补）**：

- 临时脚本放**项目根**会被 `format:check`（`prettier --check .`）抓住 ⇒ 跑门禁前必须删；取型脚本又必须放项目内才能解析 `typescript`（`E:\Temp` 下 `ERR_MODULE_NOT_FOUND`）。折中：放根目录、跑完立即删，或在 `E:\Temp` 里用绝对路径 `import 'file:///D:/OCS/smolensk/node_modules/typescript/lib/typescript.js'`。
- **复核脚本自身要先自检**：本轮第一版 R2 报"解构 0 / 零使用端口 8"，全是量具错——解构块的锚点是 `} = ports`（不是 `: AirDomainPorts)`）、零使用正则需要 `(?<![\w$])` 标识符边界（用前后字符白名单会漏 `!canReplaceBarrage()`）。量具出错时**先修量具、再下结论**。

### B2-2d 放弃任务 / 简易机场 / 整备 / 转移 / 缩减 / 标签（**已落地 2026-11-21**）

- [x] 搬 `17902–18335`：**434 行 / 14 顶层声明（全 `function`）** —— `cancelAir`(17903) / `toggleAirstripBase`(17910) / `refitBaseNow`(17934) / `beginRefitNow`(18010) / `confirmRefitSelectionNow`(18065) / `toggleRefitAircraft`(18094) / `cancelRefitNow`(18111) / `pickRefitPayDump`(18123) / `confirmRefitPaymentNow`(18138) / `transferAircraftNow`(18157) / `toggleAirReductionUnit`(18254) / `reduceBaseNow`(18267) / `airMissionKindLabel`(18328) / `airStatusLabel`(18333)。首行是 `cancelAir` 的文档注释 `/**`，末行 `  }`；下一行空行、再下一行是 `/* ── W6 B18：到达、补员与编制调整 … ── */` 横幅
- [x] **台账两处口径被实测修正**：原估"21 端口 / 443 行" → 实测新增 **6**、行数 **434**
- [x] 端口：`AirDomainPorts` **71 → 76**（−1 内部化 `airMissionKindLabel`、+6 新增）
      · 对 `port-crosscheck` 端口栏的 34 项**逐名判归属**：**11 项本身已是接口成员**（`phase`/`units`/`airUnits`/`airBoxMembers`/`pushLog`/`recordSettlement`/`setAirInBoxMembership`/`acceptAir`/`setAirStatus`/`requireAction`/`isConstructionMarkerAirBaseId`）、**19 项是切片已存在的状态/派生**（B2-1 已把整备/转移/缩减的 ref 全带进去了：`refitStage`@427 / `refitDoneBaseIds`@414 / `airstripBaseIds`@441 / `reducedBaseIds`@439 / `lastRefit`@443 / `lastTransfer`@445 / `lastReduction`@447 / `refitTargetBaseId`@421 / `refitSelectLimit`@983 / `refitBase`@951 / `refitPayDumps`@988 / `airRefitPayDumps`@903 / `airInactiveAtBase`@883 / `refitSelectLimitAt`@971 / `airActingSide`@451 / `allAirViews`@466 / `airBases`@483 / `airInputs`@411 / `airMissionDomain`@338），剩 **6 项**才是真新增，**全部按值（无一项晚绑定）**
      · 按值 6：`captureUndoSnapshot`(1206，`function`) / `dropUndoBySeq`(1214，`function`) / `setSpDumpHoldings`(13914，`function`) / `clearAir`(16443，`function`) / `AIR_MISSION_KIND_LABELS`(731，**模块级 `const` 表**，声明在 setup 体之外) / `AIR_STATUS_LABELS`(753，同)
      · **本批是唯一一批"搬入正文一行都不用改"的**：区间里没有任何一个已存在的 `ports.X` 晚绑定端口被引用 ⇒ 434 行原样搬，无 `ports.` 改写
- [x] 内部化 1 个：`airMissionKindLabel` 既是接口成员(180) 又被 facade 当实参传(2231)，但**它的声明就在本区间(18328)** ⇒ 接口成员、解构(258)、facade 实参三处同删；搬后切片内 8 处引用由切片自己的（提升）函数声明满足
- [x] 回补 **14 个（全量，无遗漏）**：每个声明名都有区外引用——store 公开面 28211–28224 覆盖 12 个，`toggleAirstripBase`(16245)、`refitBaseNow`(5698)、`airStatusLabel`(16505) 各另有 1 处 ⇒ 全部进切片 `return` 并被 facade 解构回补
- [x] 反向剪除 1 个：`refitSelectLimitAt`（切片 computed@971）搬后只剩切片内部用（facade 区外引用 0）⇒ `return` 与 facade 解构两边一起剪
- [x] 连带 import：切片补 `engineerCapableNow`（`./workbench-model`）、`planBaseRefit`/`planBaseTransfer`/`planAirBaseReduction`/`planSpPayment`（并入 `@/engine/rules` 块）、`hasUnitMovementThisPhase`（`air-unit-movement` 那行拆成多行）；facade 删 **5 处**失效 import（`airDistanceToOffMapBox`/`planAirBaseReduction`/`planBaseRefit`/`planBaseTransfer`/`isFighterAircraft`）
- [x] 顺手改正切片头注释的过期数字（"四批 / 57 端口 / 44 解构 + 13 走 ports" → **六批 / 76 端口 / 60 解构 + 16 走 ports**），接口上方注释同步（"29 按值、7 晚绑定" → "60 按值解构、16 走 ports"）
- [x] 回边归零：切片 `import … from './workbench'` 仍 **0 处**
- [x] 规模：`workbench.ts` **28,503 → 28,083（−420）**；`workbench-air.ts` **2,906 → 3,379（+473）**；`workbench-model.ts` 未动
- [x] 门禁：`npm run typecheck` 通过 → `npm run check` **623 文件 / 6,256 用例 / 196.57s / exit 0**；`arch` 源码 950；`format:check` 全 matched
- [x] 公开面快照 **1,013 键不变**（本提交未触碰 fixture）
- [x] **空军域六批（B2-1 / B2-1b / B2-2a / B2-2b / B2-2c / B2-2d）全部完成**；`workbench-air.ts` 3,379 行 / 76 端口
- [x] 复核 R1（**换证据源**：`git show HEAD~2` 取搬前原文逐行对拍）：**434 ↔ 434 行 / 非空 420 ↔ 420 / 逐行不一致 0**；14 声明序列一致；接口 76 = 解构 60 + 走 ports 16、覆盖差集 0、**零使用端口 0/76**；facade 解构 **109 → 122**（+14 −1，缺回补 0）；公开面 **1,013 键**
- [x] 复核 R2（**换工具/口径 + 反向验证**）：14 ↔ 14 个函数声明、**AST 结构签名 3,201 节点 / 不一致 0**；反向——facade(HEAD) 残留同名声明 **0**、切片 `return` **132** 个简写属性且 14 名全在、6 个新端口形态 = 4 × `function` + 2 × 模块级 `var`；`audit:ports` 报 `createAirDomain @2150` 按值 **61** 项全安全（61 按值 + 15 getter = 76，与接口数自洽）
- [x] 两次复核**均未推翻**结论 ⇒ 无返工、无需改代码

**落地期暴露的三个坑**：

1. **"名字出现在 `port-crosscheck` 端口栏" ≠ "要新增端口"**。34 项里 19 项其实是**切片自己的状态/派生**（B2-1 就把整备/转移/缩减的 ref 搬进去了），facade 只是从 `airDomain` 解构回来用。判据是"**它在切片里有没有自己的顶层声明**"（在 `workbench-air.ts` 里 grep `^  const X`），不是它出现在哪一栏。
2. **模块级常量表也必须是端口，而两套工具都会把它藏起来**：`AIR_MISSION_KIND_LABELS`(731)/`AIR_STATUS_LABELS`(753) 声明在 setup 体**之外**，`port-crosscheck` 把它们归进"未在 setup 体内声明（真·外部）"那一栏——该栏混着上百项局部变量、平时整栏跳过 ⇒ 只有"逐名核对接口成员 + 两文件声明位置"才看得见。漏了必 `TS2304`。
3. **统计脚本的锚点必须先 `grep` 原文再写**：facade 解构的收尾是 `} = airDomain`（**没有右括号**），写成 `/^s*}) = airDomain/` 会 `while` 死循环（本轮 PowerShell 统计脚本就这样空转 3 分钟，得 `TaskStop` 掐掉）。

## 4. B3 移动三切片

- [x] `workbench-move.ts` ← section 3（台账原估 451 行 / 15 个函数 ⇒ **实测 443 行 / 21 个声明**：15 `function` + 6 `const`；**已落地 2026-11-21**）

### B3-1 移动交互（**已落地 2026-11-21**）

- [x] 搬 `7527–7969`：**443 行 / 21 顶层声明（15 function + 6 const；AST `getFullStart` 口径 445 行，多含前置 2 行空行）** —— `nameOf`(7530) / `unitNameOf`(7539) / `applyMovePatches`(7544) / `settlementInProgress`(7570, computed) / `refuseWhileSettling`(7585) / `beginMoveFor`(7587) / `breakdownWindows`(7678, ref) / `setupWiggleParents`(7686, ref) / `setupWiggleOn`(7689, computed) / `setupWiggleRemaining`(7691, computed) / `setupWiggleEligible`(7694) / `setupBreakdownCandidates`(7706) / `openBreakdownWindow`(7713) / `closeBreakdownWindows`(7725) / `breakdownTimingOf`(7733, const 箭头) / `canCreateBreakdownNow`(7753) / `breakdownRecordChoicesFor`(7775) / `breakdownAbsorbChoicesFor`(7792) / `canAbsorbBreakdownNow`(7812) / `retryBeginMove`(7823) / `selectForMove`(7853)。首行是 `/* ─ C5 移动交互 …` 横幅，末行 `  }`，下一行空行、再下一行是 `movePickHex`(7974)
- [x] 端口 **40 项**，`audit:ports` 实测 `createMovementDomain @7520` **按值 37 项全部安全**（37 + 3 getter = 40，自洽）
      · **按值 24**（状态/派生，声明在 519–7171）：`NO_MOVEMENT_PHASES`(519 模块级) / `session`(830) / `activeSide`(858) / `phase`(866) / `segmentLocked`(887) / `units`(1000) / `selectedId`(1068) / `lastStep`(1076) / `groundMovement`(1110) / `moveBlocked`+`moveInteraction`(1131，从 `groundMovement` 解构) / `moveSessionSeq`(1150) / `transportHandlingBaseline`(1354) / `stackSelect`(1371) / `movePick`(1383) / `pausedTransportIds`(1432) / `transportHandlingUndo`(1474) / `combatState`(1582) / `barrageState`(1591) / `airUnitTransit`(2272) / `selectedUnit`(2408) / `choices`(2412) / `moveUnits`(5960) / `PHASE_LABELS`(7171)
      · **按值 13**（函数声明，**可提升** ⇒ 声明在 8k–25k 也按值安全）：`refuseWhileLocked`(890) / `noteUnitLeftOwnBridgeHex`(2466) / `unitOfInstance`(5100) / `pushLog`(6126) / `unitsAt`(6179) / `friendlyUnitsAt`(7044) / `movePickPoolAt`(7985) / `defaultMovePickIdsAt`(8017) / `applyFormationFuelCoverageToIds`(9735) / `actionAllowedNow`(20720) / `requireAction`(20724) / `noteUnitEnteredHex`(24898) / `nationalityOfUnit`(25200)
      · **晚绑定 3**（声明在建域点之后，facade 用 `get` 访问器传、正文写 `ports.x`）：`breakdownPool`(18046, `Ref`) / `initialSetupInProgress`(19481, `Ref`) / `gates`(20698, `WorkbenchGates` 对象，写 `ports.gates` 不带 `.value`)
- [x] **本批的结构难题（按代价口径解出来的）：建域点的位置决定 getter 数。** 这 4 个函数（`nameOf` / `applyMovePatches` / `refuseWhileSettling` / `closeBreakdownWindows`）被**更早创建**的域当端口吃（`groundMovement` 1113–1122、轰炸 1567、空军 2159/2222、7066），而区块自己的状态（`movePick` / `stackSelect` / `moveUnits` / `PHASE_LABELS` …）声明在 1.1k–7.2k。**若把域提前到 `groundMovement`(1110) 之前**，就要为 18 项状态开 getter（其中 `moveBlocked`/`moveInteraction` 还是从 `groundMovement` 解构来的，成环）；**原地建域**只要 3 个 getter，代价是那 4 个名字在 facade 各留一行薄转发 ⇒ 选后者
- [x] 薄转发 **4 个**（facade 1110 前，各一行）：`nameOf` / `applyMovePatches` / `refuseWhileSettling` / `closeBreakdownWindows` —— forward 到 `movementDomain.x`，行为不变、**1.1k–7.0k 的调用点一个都没改**
- [x] 回补 **15 个**、切片内部自用 **2 个**（`breakdownWindows` / `setupWiggleEligible` 区外引用 0 ⇒ 不进 facade 解构，避免 TS6133）；`unitNameOf` 只有 1 处区外引用（27496）⇒ 解构即可，无需转发
- [x] 新类型迁移：`TransportHandlingUndoEntry`（facade 1453–1473 的**非导出** `interface`，含 8 行文档注释）搬进 `workbench-model.ts` 并 `export`，facade 补 `import type`；model 顺带补 `import type { SpHoldings } from '@/engine/rules'`
- [x] 连带 import：切片新增 `hexesWithin` / `canMoveInPhase` / `SETUP_WIGGLE_*` / `isSetupWiggleParent` / `type SettlementLock` 等；facade 删 5 处搬后失效 import（`hexesWithin` / `isSetupWiggleParent` / `SETUP_WIGGLE_BREAKDOWN_RADIUS` / `SETUP_WIGGLE_MAX_DIVISIONS` / `type SettlementLock`）
- [x] 回边归零：切片 `import … from './workbench'` **0 处**（只 `import type` 自 `./workbench-model` / `./workbench-air` / `./ground-movement` / `./workbench-gates` / `./movement-types`）
- [x] 规模：`workbench.ts` **28,083 → 27,702（净 −381；`git numstat` −475/+94）**：删 443 行区间 + 29 行接口/文档 + 5 行失效 import；加 69 行装配 + 23 行薄转发 + 2 行 import（`type SettlementLock` 那行由新 `TransportHandlingUndoEntry` 顶替）；`workbench-move.ts` **607 行**（新建）；`workbench-model.ts` **4,177 → 4,208（+31 = +21 接口 +8 文档 +1 import +1 空行）**
- [x] 门禁：`npm run typecheck` 通过 → `npm run check` **623 文件 / 6,256 用例 / 196.38s / exit 0**；`arch` 源码 **951**（+1 新文件）；`format:check` 全 matched；`audit:ports` 六域全绿
- [x] 复核 R1（**换证据源**：`git show HEAD~2` 取搬前原文逐行对拍，只去 `ports.` 前缀、保留 `.value`）：**443 ↔ 443 行 / 非空 422 ↔ 422 / 不一致 0**；块内 `ports.` 恰好 **4**（gates 1 + initialSetupInProgress 2 + breakdownPool 1）；接口 **40** = 解构 **37** + getter **3**、覆盖差集 0、**零使用端口 0/40**；切片 `return` **19**（重复 0，缺的正是 `breakdownWindows`/`setupWiggleEligible`）；公开面 **1,013 键**
- [x] 复核 R2（**换口径 + 反向验证**）：21 个声明 token 流 **1,737 ↔ 1,737、不一致 0/21**（AST 节点 1,959 ↔ 1,967，多出的 **8** 恰为 3 个 `ports.` 前缀带来的 8 个节点）；反向——facade(HEAD) 残留（除 4 个薄转发）**0**、4 个薄转发各 **1 条语句**且指向 `movementDomain.<同名>`、晚绑定裸名 **0/3**、接口−解构−3 晚绑定 **0**、切片回边 **0**、快照与 HEAD~2 **字节完全一致**
- [x] **R1 推翻了本批自己的一个数字**：文档原写「445 行」——那是 AST `getFullStart` 口径（含区间前 2 行空行），**真正搬走的正文是 443 行（7527–7969）**，已改；R2 未再推翻其它结论
- [x] 公开面快照 **1,013 键不变**（本提交未触碰 fixture）

**落地期暴露的四个坑**：

1. **建域点选位要按"getter 数"算，不是按"哪一段代码看起来更内聚"。** 提前建域是 18 getter + 与 `groundMovement` 的环；原地建域是 3 getter + 4 行薄转发。以后同类批次先数"建域点之前有多少 `const`"再决定。
2. **`choices` 的端口类型不能按字面猜。** `const choices = computed(() => unitChoices(activeSide.value))` 的真实类型是 `ComputedRef<UnitRecordView[]>`（`unitChoices` 返回单位**记录视图**，不是 `{unit,selected}`）；按"看着像"写成 `{ unit: ConsoleUnit; selected: boolean }[]` 会把公开面类型带歪，连累 2 个 Vue 组件 + 2 个测试文件。取型必须走 checker。
3. **接口搬出后忘补 import ⇒ 类型名变 any，连锁 4 处 TS7006。** `TransportHandlingUndoEntry` 搬进 model 但 facade 没 import 时，`ref<TransportHandlingUndoEntry[]>` 的 `T` 解析失败，跟着报 `_`/`at`/`lock` 隐式 any（5050–5063），看着像"函数体搬坏了"，其实是类型丢了。
4. **新加的装配块会被 prettier 重排** ⇒ 跑门禁前先 `prettier --write` 三文件，否则 `format:check` 必红（本轮第一次门禁就红在这里，不是逻辑问题）。

---

- [ ] `workbench-stack-pick.ts` ← section 4（台账原估 3,381 / 81 ⇒ **实测 3,377 行 / 81 声明**，7593–10969）

### B3-2a 堆叠取子（**已落地 2026-11-21**）

- [x] 新建 `workbench-stack-pick.ts`，搬 `7590–7800`：**211 行 / 13 顶层声明（11 `function` + 2 `computed`）** —— `movePickHex`(7593) / `movePickPoolAt`(7604) / `defaultMovePickIdsAt`(7636) / `movePickChoices`(7643) / `toggleMovePick`(7649) / `setMovePickOnly`(7664) / `setMovePickAll`(7671) / `beginMovePick`(7688) / `setMovePickIds`(7713) / `cancelMovePick`(7722) / `confirmMovePick`(7726) / `stepTextOf`(7773) / `snapshotOf`(7787)
- [x] 端口 **13 项** = **按值 12** + **晚绑定 1**
      · 按值 12：`activeSide`(855) / `phase`(863) / `units`(997) / `nameOf`(1114 薄转发) / `moveBlocked`(1173) / `movePick`(1403) / `pausedTransportIds`(1452) / `pushLog`(6117) / `friendlyUnitsAt`(7035) / `beginMoveFor`(7575) / `applyFormationFuelCoverage`(9342) / `applyFormationFuelCoverageToIds`(9354)
      · 晚绑定 1：`initialSetupInProgress`(19100) —— facade 用 `get` 访问器传，切片正文写 `ports.initialSetupInProgress.value`
      · 正文引用这 13 个端口共 **42** 处（AST 逐标识符统计，注释不计）：`movePick` 12 / `nameOf` 8 / `ToIds` 4 / `phase` 3 / `moveBlocked` 3 / `pushLog` 3 / `friendlyUnitsAt` 3 / 其余各 1
- [x] 建域位置仍是「原地」（`createStackPickDomain` @7612）：提前到 `groundMovement` 之前要给 `moveBlocked` / `movePick` / `pausedTransportIds` / `beginMoveFor` / `initialSetupInProgress` 开 **5 个 getter**；原地只要 **1 个 getter + 4 个薄转发**
- [x] 薄转发 4 个（1131–1150，各一行）：`snapshotOf`(1160) / `stepTextOf`(1161) 被 `createGroundMovementDomain` 当端口吃；`movePickPoolAt`(5768、7552) / `defaultMovePickIdsAt`(7553) 被移动域吃
- [x] 解构回补 9 个：`movePickHex` / `movePickChoices` / `toggleMovePick` / `setMovePickOnly` / `setMovePickAll` / `beginMovePick` / `setMovePickIds` / `cancelMovePick` / `confirmMovePick`；切片 `return` 13 名；回边 0（只 `import type` 引 `./workbench-move` / `./ground-movement`）
- [x] 连带 import：facade 删 `canMoveInPhase`（切片接管）；切片新增 `computed` / `isReplUnit` / `canMoveInPhase` / `MoveStepRecord` / `MoveStepSnapshot` / `HexRef` / `Side` / `ConsolePhase` / `ConsoleUnit` / `WorkbenchLogEntry` / `Derivation`
- [x] 规模：`workbench.ts` **27,703 → 27,542（−161；`git numstat` +51/−211）**；`workbench-stack-pick.ts` **303 行**（新建）
- [x] 门禁：`npm run typecheck` 通过 → `npm run check` **623 文件 / 6,256 用例 / 197.39s / exit 0**；`audit:ports` 新增 `createStackPickDomain @7612` **按值 12 项全部安全**（12 + 1 getter = 13，自洽）；`arch` 源码 **952**（+1 新文件）；`format:check` 全 matched
- [x] 公开面快照 **1,013 键不变**（未触碰 fixture）
- [x] 复核 R1（**换证据源**：`git show HEAD~1` 取搬前原文 7590–7800 逐行对拍，只去 `ports.` 前缀、保留 `.value`）：**211 ↔ 211 行 / 不一致 0**；接口 **13** = 解构 **12** + 晚绑定 **1**、覆盖差集 0、**零使用端口 0/13**；切片 `return` 恰为 13 个声明（重复 0）；facade 内 13 个名字只剩 4 个薄转发（无其它残留）；快照 blob `a2fcb6e…` 与 HEAD~1 **同一 blob**
- [x] 复核 R2（**换口径 + 反向验证**）：token 流 **1,109 ↔ 1,109、不一致 0**；AST 节点 **1,104 ↔ 1,106**（差 2 = 唯一 1 个 `ports.` 前缀的 Identifier + PropertyAccess）；反向 5 项全过 —— facade AST 残留问题 **0**、4 个薄转发各 **1 条** `return stackPickDomain.<同名>(…)`、`slice import './workbench'` **0**、裸 `initialSetupInProgress` **0**（只有 `ports.` 形式 1 处）、facade **27,542** / 切片 **303** 行与文档一致、numstat **+51/−211** 吻合
- [x] 两次复核均未推翻本轮结论；但 R1/R2 的**量具自身**各误报一次，已修：① 取域级 `return {` 不能用首个匹配（`snapshotOf` 内部也有 `return {`，会截短 13 行）；② 检查未使用端口必须先去掉 `ports.` 前缀（否则把唯一晚绑定端口误判为 0 引用）；③ 行数按 `wc -l`（`split('\n')` 结果减 1）；④ 0-based 区间断言的偏移要跟着 `END-1/END+2`

**落地期暴露的两个新坑**：

1. **「所有端口都写 `ports.`」⇒ TS6198「解构元素全部未使用」**：按值端口必须走解构、用裸名；只有晚绑定写 `ports.x`。AST 批量加大前缀时若一律加，typecheck 立刻红（本批第一次 typecheck 就是这么红的）。
2. **prettier 会把 `ports.friendlyUnitsAt(hex).filter(...)` 拆成 `ports` + 换行 + `.friendlyUnitsAt(...)`**：按字面 `ports.` 计数/替换会漏 **3 处**；去前缀必须用允许空白的正则（`ports\s*\.\s*name`）。

**section 4 剩余 68 声明 / 约 3,166 行的实测分解**：推进族 7770–8379（24 声明，**44 端口** ⇒ 需再切两刀）→ 模式族 8379–8726（9）→ 预备族 8743–8934（6）→ 燃油族 8934–9732（8，跨 3 个空档）→ 突围族 9894–10413（12）→ 工具族 10565–10969（9）。

- [ ] `workbench-raid.ts` ← section 2（1,344 / 28）
- [ ] 暴露 `nameOf`(4)、`applyMovePatches`(2)、`refuseWhileSettling`(2)、`retryBeginMove`(2)、`selectForMove`、`openBreakdownWindow`、`closeBreakdownWindows`
- 注意：`4→1` 有 10 条出边（铁路），port 化后不要把铁路逻辑拖进来
- 验收：同上（≈24,246 行）

## 5. B4 补给

- [ ] `workbench-supply.ts` ← section 9（2,734 / 91）
- [ ] 暴露 15 个 inbound 函数（CSV 查 `section=9`）
- 验收：同上（≈21,512 行）

## 6. B5 战斗四节

- [ ] `workbench-combat.ts` ← section 5（1,643 / 33）
- [ ] `workbench-combat-draft.ts` ← section 7（591 / 14，选项战果草稿账本）
- [ ] `workbench-combat-finish.ts` ← section 0（963 / 9，9.12g 撤退/推进/补给站）
- [ ] `workbench-special-combat.ts` ← section 12（2,424 / 51，9.14）
- [ ] 暴露 `combatCancelBlocker`(7)、`clearCombat`(4)、`applyCombatPatches`(4)、`resolveSpecialCombatAt`(2) 等
- 注意：`12→8` 8 条、`12→10` 8 条（特战要调轰炸与空军），走 ports
- 验收：同上（≈15,891 行）

## 7. B6 到货与铁路

- [ ] `workbench-arrival.ts` ← section 13（1,044 / 26）
- [ ] `workbench-rail.ts` ← section 1（2,903 / 61）
- [ ] 暴露 `clearArrivalSpGroups`(3) 等 18 个；铁路 23 个
- 验收：同上（≈11,944 行）

## 8. B7 环节闸门（唯一巨型枢纽，拆 4 个子提交）

- [ ] `workbench-segment-gate.ts` ← 段状态机（`segmentStep` / `segmentAdvanceBlock`）
- [ ] `workbench-placement.ts` ← 放置阶段
- [ ] `workbench-spec-rules.ts` ← 专规机制
- [ ] `workbench-victory.ts` ← 胜利判定
- 注意：`14→13` 有 18 条最紧边，先在 CSV 里把 18 个函数列全再动手
- 验收：每子提交 ≤ 1,500 行、`npm run check` 绿（≈5,206 行）

## 9. B8 快照与 facade 收口

- [ ] `workbench-snapshot.ts` ← section 15（1,792 / 12）
- [ ] facade 只留装配 + `watch` + `return` 汇编 + 薄转发
- [ ] 加 `max-lines` / `forbidden-imports` 到 `scripts/check-arch.mjs`
- 验收：按上面切分，`workbench.ts` 落到 **≈3,400 行**（不是 ≤3,000）—— 分节外的核心区实测 3,414 行、`return` 字面量 1,155 行，B8 之后余量比目标多约 400 行
- [ ] 若要真正 ≤3,000：**二选一**（a）B0 里把核心区再拆成 `core-state.ts` / `core-undo.ts`；（b）`return` 改按域拼装（`Object.assign(..., barrageSurface(), airSurface(), …)`），facade 可降到 ≈600 行
- 验收（最终）：`workbench.ts` ≤ 3,000；`npm run check:all`（含 AI）绿一次；打 tag `decouple-b8`

## 10. 收尾

- [ ] `docs/待办清单.md` 更新为"已完成"并写清各批 commit
- [ ] 合并 `refactor/workbench-decouple` → `main`（PR 里贴每批 `git show -C --find-copies-harder` 摘要）
