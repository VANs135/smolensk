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
- 验收：`npm run check` 绿 + `tests/stores/*` 日志/撤销/存档用例绿 + 公开面键集不变

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
- **验收实测**：`npm run check` → 623 文件 / 6,256 用例 / **208.62s** / exit 0；`arch` 949 源码；`workbench.ts` **30,649 → 30,075 行（−574）**、`workbench-air.ts` **487 → 1,197 行（+710）**；逐字对拍（归一化去 `ports.`/`.value`/空白）**621 行完整命中**；重复定义 0、僵尸函数 0；`/= airDomain` 解构 **85 项 = 88 公开名 − 3 个只有切片自己用的**（`transferBaseId`/`airDistanceToBox`/`canTransferAirToBox`）

### B2-2 动作块（后做，**2026-11-20 重测：拆 4 批，全部 < 40 端口**）

B2-1 落地后行号全部漂移（facade 少了 387 行），旧编号 **全部作废**。按符号名重新定位、用 `port-crosscheck.mjs` 扣掉"已属切片内部"的 40 个名字后实测：

| 批次      | 当前区间      | 内容                                                                                                                                                                                                                                                                                                                        | 真端口 | 行数 |
| --------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| **B2-2a** | `17197–17992` | `beginAirMissionNow` … `captureAirBaseNow`（含 `confirmAirCombatNow`、`airTargetFactsAt`、`airTypeCanPerformKind`、`airPlaneCanPerformKind`、`airMissionTargetCandidates`、`resolveAirCargoNow`、`applyAirCargoDelivery`）                                                                                                  | **34** | 796  |
| **B2-2b** | `19283–19720` | `airMissionCargoCapacityNow` / `airCargoLossPending` / `queueAirCargoLoss` / `confirmAirCargoLossNow` / `hasCargoOwnership` / `resolveFlakNow` / 任务执行前半（`beginAirTargetHexPickNow`、`runAirMissionNow`、`previewAirCombatRoles`、`autoResolveAirMissionNow`、`finishAutomaticAirReturn`、`finishAbortedAirMission`） | **27** | 438  |
| **B2-2c** | `19729–20047` | `beginAirBarrageNow` / `runBarrageChainNow` / `airMissionResultReady` / `confirmAirMissionNow` / `settleAirMissionNow` / `recordAbortedAirBarrage` / `completeAirCargoReturn` / `completeAirReturnNow`                                                                                                                      | **31** | 319  |
| **B2-2d** | `20048–20490` | `cancelAir` / `toggleAirstripBase` / `refitBaseNow` / `beginRefitNow` / `confirmRefitSelectionNow` / `toggleRefitAircraft` / `cancelRefitNow` / `pickRefitPayDump` / `confirmRefitPaymentNow` / `transferAircraftNow` / `toggleAirReductionUnit` / `reduceBaseNow` / `airMissionKindLabel` / `airStatusLabel`               | **21** | 443  |

（合并量过一次：`19283–20490` 一起切要 **90 项**、扣掉切片内部仍剩 65 项，超红线 ⇒ 必须拆。）

**每批搬动前先按 spec §6.1.2 剪端口**：`onMapAirUnits`(18225)、`applyAirCargoDelivery`(18368) 属 a 批；`airCargoLossPending`(19286) 属 b 批；`airMissionResultReady`(19821)、`completeAirCargoReturn`(19931) 属 c 批。搬到时要从 `AirDomainPorts`、解构表、facade 的 ports 实参（含 `get` 访问器）三处同时删，否则要么重复声明、要么 getter 自指。

- [ ] 顺序：a → b → c → d（d 里的 `airMissionKindLabel`(20473) 被 a/b/c 引用，先做 d 可少一个端口；先做 a 则它按值传，也无妨）
- [ ] 边界（**2026-11-21 重测，推翻上一版的 `18578`**）：`captureAirBaseNow` 现 **17851** 起、**17992** 止（`return true` 后紧接 `}`），`17993` 空行、`17994` 是 C6 的分节横幅 `/* ── 9.14 特殊战斗 … ── */`；`18005` 起才是 `printedHedgehogOwners`，它上面的 `/** … * */`（17996–18004）属 C6。**上一版写的 `18578` 落在这个 C6 注释块的 `*/` 上** ⇒ 按它切会把别人家的注释尾吞掉（`*/` 进切片、`/**` 留 facade，直接语法错）。**教训：符号定位只给"起点"，终点必须看闭合 `}` 的下一行是什么**——下一行是 `*/` 就说明切进了别人的注释块
- [ ] 端口实测 **34 项**（`port-crosscheck` 报 51 项，扣掉 B2-1/1b 已搬成切片内部的 17 项）：按值 27（`phase`/`turn`/`rng`/`units`/`groundMovement`/`moveInteraction`/`airUnits`/`airBoxMembers`/`spDumps`/`offMapSupplyStocks`/`supplyState`/`pushLog`/`recordSettlement`/`clearMoveInteraction`/`refuseWhileSettling`/`eliminateEntry`/`setAirInBoxMembership`/`addSpAtHex`/`airUnloadedTAt` /`acceptAir`/`setAirStatus`/`applyAirStepLoss`/`drawAir2d6`/`drawAir1d6`/`airMissionKindLabel`/`requireAction`/`noteUnitEnteredHex`）＋ **晚绑定 7**（`barrageFacts`(computed 3682)/`railMoveFacts`(computed 4520)/`airUnloadLedger`(const 15966)/`airMissionJoinChoices`(computed 16814)/`specialPending`(const 18126)/`airMissionSegmentKind`(computed 22401)/`airMissionKindChoices`(computed 22425)）
- [ ] **本批要剪 6 个端口**（它们的定义就在 a 批区间里，搬完即内部）：`isAirInOffMapBox`(17646)/`onMapAirUnits`(17651,晚绑定)/`airUnitsAt`(17655)/`airDistanceFromRealBase`(17769)/`airUnitsInHex`(17778)/`applyAirCargoDelivery`(17794)。三处同删（接口成员 + `createAirDomain` 解构 + facade ports 实参含 getter），并把切片里已有的 `ports.X`（B2-1b 用过 `isAirInOffMapBox`/`airUnitsAt`/`airDistanceFromRealBase`/`airUnitsInHex`/`ports.onMapAirUnits.value`）**改回裸名**——否则 `Ports` 上已无此成员，typecheck 报错；`onMapAirUnits` 改裸名后它是切片内的 computed，仍须进 `return`（facade 别处还在用）
- [ ] 不含 `airMissionAllowedInPhase`(17710) 与 `bombingEntryEligible`(17721)/`barrageTargetsNow`(17737)/`hipShootEntryEligible`(17761)：§19 跨轰炸+空军的入口判据，留 B5 之后
- [ ] 不含 `airMissionKindChoices`(22999)、`airMissionSegmentKind`(22975)：单点派生，随 B5/B6 走
- [ ] 不含 `airUnits`(1755) / `airBoxMembers`(1767)（与地图/到货/轰炸共享，留 facade）
- 验收：`npm run check` 绿 + 公开面 1,013 键不变 + facade 函数数 707 递减到对应值 + 画面/文案对拍 0 差

**工具口径提醒（本轮实测）**：`port-crosscheck.mjs` 的「端口」一栏可信，但它的「未在 setup 体内声明（真·外部）」一栏**不可信**——函数局部变量与回调参数（`unit`/`entry`/`index`/`target` 等）会被列进去（a 批就列了 128 项假外部）。只看端口那一栏，剩下靠 `vue-tsc` 收口。

## 4. B3 移动三切片

- [ ] `workbench-move.ts` ← section 3（451 / 15）
- [ ] `workbench-stack-pick.ts` ← section 4（3,381 / 81，含突围与补给缓存）
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
