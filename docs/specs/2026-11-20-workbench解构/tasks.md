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

- [ ] 新建 `src/stores/workbench-air.ts`，搬 **状态块 2416–2592**（26 个 ref）+ **派生块 5944–6088**（12 个 computed；**不是 5944–6063**——6063 正好切在 `airMissionRosterNow` 的函数体里，会把它的局部 `state` / `air` 误算成端口）
- [ ] 建域点可放在 2593 附近（新出现的外部依赖全在 2593 之后 ⇒ 走 getter 延迟绑定），**不必像 B1 那样压到 setup 末尾**
- [ ] 实测端口 **25 项**（口径见 spec §6.1.1：三段并集再减掉切片自己的声明），其中仅 6 项（`rng`/`units`/`selectedId`/`airUnits`/`offMapSupplyStocks`/`activeSide`）可在建域点直连，**19 项须走 getter**（含 `segmentGateQuery` @23302、`constructionMarkerAirBaseId` @27821、`constructionMarkerPieces` @27836、`pushLog` @7075）
- [ ] 不能漏的三个端口：`setAirStatus`(:17440)、`markAirMissionFlown`(:17459)、`pushLog`(:7075)——`port-report.mjs` 会把它们漏掉，**必须用 `node scripts/port-crosscheck.mjs --start .. --end ..` 对拍**
- [ ] `AirInputs`(:825 `export interface`) 搬进 `workbench-model.ts`；`createAirInputs`(:937，无 export) 保留为端口或同搬 model（二选一）
- 命名：**域对象叫 `airDomain`，不要叫 `air`**——facade 里已有 `airSupply` / `airUnitTransit` / `airMissionDomain` / `airCargoResolution` 四个 air 开头的域，再加一个 `air` 无法区分（另：`(air) => …` 这种回调参数在文件里出现几十次，`air` 这个名字太容易被误读成本地变量）
- 验收：`npm run check` 绿 + 公开面 1,013 键不变（状态与派生仍在 `return` 里按原名暴露）

### B2-2 动作块（后做）

- [ ] 搬函数块 **18136–18148 / 18198–18502 / 18503–18953 / 19673–20865 / 23386**
- [ ] 开工先复测端口，**> 40 再拆一刀**
- [ ] 边界：`captureAirBaseNow` 实际 18812–**18953**，分节横幅在 **18950**（横幅落在函数体内）⇒ 按横幅取 end 会把后半段切给下一批
- [ ] 不含 §19 的 18003–18135（轰炸/炮击入口判据，跨域协调层，留 B5 之后）
- [ ] 不含 `airUnits`(1916) / `airBoxMembers`(1928)（与地图/到货/轰炸共享，留 facade/core）
- 验收：`npm run check` 绿 + 公开面不变 + 文案/函数名双对拍 0 差

## 4. B3 移动三切片

- [ ] `flows/move.ts` ← section 3（451 / 15）
- [ ] `flows/stack-pick.ts` ← section 4（3,381 / 81，含突围与补给缓存）
- [ ] `flows/raid.ts` ← section 2（1,344 / 28）
- [ ] 暴露 `nameOf`(4)、`applyMovePatches`(2)、`refuseWhileSettling`(2)、`retryBeginMove`(2)、`selectForMove`、`openBreakdownWindow`、`closeBreakdownWindows`
- 注意：`4→1` 有 10 条出边（铁路），port 化后不要把铁路逻辑拖进来
- 验收：同上（≈24,246 行）

## 5. B4 补给

- [ ] `flows/supply.ts` ← section 9（2,734 / 91）
- [ ] 暴露 15 个 inbound 函数（CSV 查 `section=9`）
- 验收：同上（≈21,512 行）

## 6. B5 战斗四节

- [ ] `flows/combat.ts` ← section 5（1,643 / 33）
- [ ] `flows/combat-draft.ts` ← section 7（591 / 14，选项战果草稿账本）
- [ ] `flows/combat-finish.ts` ← section 0（963 / 9，9.12g 撤退/推进/补给站）
- [ ] `flows/special-combat.ts` ← section 12（2,424 / 51，9.14）
- [ ] 暴露 `combatCancelBlocker`(7)、`clearCombat`(4)、`applyCombatPatches`(4)、`resolveSpecialCombatAt`(2) 等
- 注意：`12→8` 8 条、`12→10` 8 条（特战要调轰炸与空军），走 ports
- 验收：同上（≈15,891 行）

## 7. B6 到货与铁路

- [ ] `flows/arrival.ts` ← section 13（1,044 / 26）
- [ ] `flows/rail.ts` ← section 1（2,903 / 61）
- [ ] 暴露 `clearArrivalSpGroups`(3) 等 18 个；铁路 23 个
- 验收：同上（≈11,944 行）

## 8. B7 环节闸门（唯一巨型枢纽，拆 4 个子提交）

- [ ] `services/segment-gate.ts` ← 段状态机（`segmentStep` / `segmentAdvanceBlock`）
- [ ] `services/placement.ts` ← 放置阶段
- [ ] `services/spec-rules.ts` ← 专规机制
- [ ] `services/victory.ts` ← 胜利判定
- 注意：`14→13` 有 18 条最紧边，先在 CSV 里把 18 个函数列全再动手
- 验收：每子提交 ≤ 1,500 行、`npm run check` 绿（≈5,206 行）

## 9. B8 快照与 facade 收口

- [ ] `services/snapshot.ts` ← section 15（1,792 / 12）
- [ ] facade 只留装配 + `watch` + `return` 汇编 + 薄转发
- [ ] 加 `max-lines` / `forbidden-imports` 到 `scripts/check-arch.mjs`
- 验收：按上面切分，`workbench.ts` 落到 **≈3,400 行**（不是 ≤3,000）—— 分节外的核心区实测 3,414 行、`return` 字面量 1,155 行，B8 之后余量比目标多约 400 行
- [ ] 若要真正 ≤3,000：**二选一**（a）B0 里把核心区再拆成 `core-state.ts` / `core-undo.ts`；（b）`return` 改按域拼装（`Object.assign(..., barrageSurface(), airSurface(), …)`），facade 可降到 ≈600 行
- 验收（最终）：`workbench.ts` ≤ 3,000；`npm run check:all`（含 AI）绿一次；打 tag `decouple-b8`

## 10. 收尾

- [ ] `docs/待办清单.md` 更新为"已完成"并写清各批 commit
- [ ] 合并 `refactor/workbench-decouple` → `main`（PR 里贴每批 `git show -C --find-copies-harder` 摘要）
