# 环节 × UI 缺口清单（2026-10-25 审计）

> 问题：**现在能不能做到"每个环节只能响应对应的 UI 和操作"？**
> 结论：**操作层基本做到，UI 层没做到，另有一批动作压根没有环节闸门。**

## 0. 三句话结论

1. **操作层（引擎 + store）：基本做到。** 30 类"宣布类动作"由 `ACTION_GATES` 钉在各自环节，
   store 侧 31 个入口调 `requireAction`；越权点下去会被拒、写日志、带规则号与"只能在「C 移动·移动」进行"。
   实测矩阵（§1）是收敛的：`move.*` 只落在 C/E/G 的移动环节，`combat.declare` 只在 F/G 战斗环节，
   `supply.*` 只在 D 段，`air.refit` 只在 A 段。
2. **UI 层：没做到。** 组件里共有 **207 个** store 调用、其中 **35 个**`@click` 能直接映射到动作键，
   **只有 2 处**（上一轮修的地图小窗「炮击」「空军任务」）用 `actionAllowedNow(...)` 做了环节收敛。
   其余面板一律常显 ⇒ 玩家在 B 增援段照样看得见「修筑工事」「换轨」「铁路运输」「整备」「补给恢复」。
3. **还有一批动作没有环节闸门**（§3）——这些点下去**会真的执行**，不是"点了被拒"。
   典型：`applyArrivalRemovalsNow`（1.6a 强制移除）、`rollVariableReplNow`（13.6b 可变增援）、
   `buildAirstripNow`（15.3 建机场）、`transferAircraftNow`（14.1c 转场）、`runAirMissionNow`（14.7）。
   ⇒ 这才是"任意环节都能做"的真缺口。

## 1. 已验证的闸门矩阵（30 个动作键）

关键判据：本表由 `ACTION_GATES.where` 与 `sop-segments` 的玩家环节交叉实测（两方都扫），
不是抄注释。`segment` 只写末段名（`movement.modeAndMovement` 记作「C 移动·modeAndMovement」）。

| 动作键                       | 名称                               | 规则                           | 允许的环节                                                                                                                                                   | store 入口                                                                |
| ---------------------------- | ---------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `air.refit`                  | 整备基地飞机                       | 15.1                           | A 飞机整备·refit                                                                                                                                             | beginRefitNow()、refitBaseNow()                                           |
| `air.baseReduce`             | 缩减己方空军基地                   | 15.4                           | C 移动·modeAndMovement                                                                                                                                       | reduceBaseNow()                                                           |
| `rein.arrival`               | 到货落位                           | 13.6                           | B 增援·arrival                                                                                                                                               | placeArrivalNow()                                                         |
| `rein.supplyArrival`         | 到货 SP 落位（免费铁运）           | 专规 2.1 / 3.1                 | B 增援·arrival                                                                                                                                               | applySupplyArrivalsNow()                                                  |
| `rein.rebuild`               | 重建 / 整编                        | 13.5 / 13.9                    | B 增援·rebuild                                                                                                                                               | consolidateUnitsNow()、rebuildUnitNow()                                   |
| `rein.formationDraw`         | 编队抽取                           | 专规 13.7                      | B 增援·formationDraw（axis）                                                                                                                                 | drawAndApplyStepNow()                                                     |
| `rein.specialRepl`           | 特殊补员抽取                       | 专规 1.6c                      | B 增援·specialRepl（**双方**）                                                                                                                               | `containers.drawSpecialRepl()`（★ 2026-10-25 接线）                       |
| `rein.frontalReserves`       | 领取方面军预备队                   | 专规 2.3c                      | B 增援·frontalReserves（soviet）                                                                                                                             | claimFrontalReservesNow()                                                 |
| `move.breakout`              | 突围尝试                           | 12.8e                          | C 移动·breakout                                                                                                                                              | breakoutNow()                                                             |
| `move.modeChange`            | 改模式 / 翻朝向                    | 5.4a                           | C 移动·modeAndMovement                                                                                                                                       | flipUnitOrientation()、switchUnitMode()                                   |
| `move.order`                 | 移动                               | 6.x                            | C 移动·modeAndMovement / E 反应·movement / G 进击·movement                                                                                                   | beginMoveFor()                                                            |
| `move.overrun`               | 突袭                               | 8.0                            | C 移动·modeAndMovement / E 反应·movement / G 进击·movement                                                                                                   | overrunNow()                                                              |
| `move.railTransport`         | 铁路运输                           | 13.3                           | C 移动·modeAndMovement                                                                                                                                       | railMoveNow()                                                             |
| `move.railConversion`        | 换轨                               | 13.3f                          | C 移动·modeAndMovement                                                                                                                                       | convertRailGaugeNow()                                                     |
| `move.loadUnload`            | 装载 / 卸载 SP                     | 13.2f                          | C 移动·modeAndMovement                                                                                                                                       | loadTransportPointNow()、unloadTransportPointNow()                        |
| `move.construction`          | 建造（基地 / 简易机场 / 建造标记） | 13.8d / 15.3 / 15.2 / 专规 3.5 | C 移动·modeAndMovement                                                                                                                                       | buildAirBaseNow()、useConstructionMarkerNow()                             |
| `move.hedgehog`              | 修建 / 缩减环形工事                | 16.0b·c                        | C 移动·modeAndMovement                                                                                                                                       | buildHedgehogNow()、reduceHedgehogNow()                                   |
| `move.breakdown`             | 创建拆分单位                       | 20.0a                          | C 移动·modeAndMovement / F 战斗·combat / G 进击·combat                                                                                                       | createBreakdownNow()                                                      |
| `move.dumpBlow`              | 销毁己方补给站                     | 12.11a                         | C 移动·modeAndMovement / E 反应·movement / G 进击·movement                                                                                                   | destructDumpNow()                                                         |
| `move.extenderConvert`       | 运输点数 ⇄ 延补队                  | 12.7a·d                        | C 移动·modeAndMovement / E 反应·movement / G 进击·movement                                                                                                   | convertTransportToExtenderNow()                                           |
| `barrage.declare`            | 宣布轰炸                           | 10.0                           | C 移动·barrage / C 移动·modeAndMovement / E 反应·barrage / F 战斗·barrage / G 进击·barrage                                                                   | beginBarrageNow()                                                         |
| `combat.declare`             | 宣告并结算战斗                     | 9.2                            | F 战斗·combat / G 进击·combat                                                                                                                                | beginCombatNow()、openBattle()                                            |
| `supply.recovery`            | 恢复部队储备                       | 12.10e                         | D 补给·recovery                                                                                                                                              | applySupplyPhaseRecoveryNow()                                             |
| `supply.draw`                | 拖取 / 投递补给                    | 12.3a·b                        | D 补给·recovery / D 补给·check                                                                                                                               | applySupplyPhaseFeedingNow()、beginSupplyCheckNow()、planSupplyPhaseNow() |
| `supply.fuel`                | 加油                               | 12.5                           | C 移动·modeAndMovement / E 反应·movement / G 进击·movement                                                                                                   | payFuel()                                                                 |
| `supply.attrition`           | 断补损耗处置                       | 12.8b                          | D 补给·check                                                                                                                                                 | applyAttritionNow()                                                       |
| `reserve.release`            | 释放预备                           | 5.7b                           | E 反应·movement / G 进击·movement                                                                                                                            | releaseReserveNow()                                                       |
| `exclusive.forage`           | 补给缓存：Forage（就地取给）       | 专规 1.7 / 21.10               | D 补给·recovery / D 补给·check                                                                                                                               | spendSupplyCacheNow()                                                     |
| `exclusive.panzerObligation` | 3.4a 分界线义务（段末结算）        | 专规 3.4a                      | C 移动·breakout（axis） / C 移动·modeAndMovement（axis） / C 移动·barrage（axis） / G 进击·movement（axis） / G 进击·barrage（axis） / G 进击·combat（axis） | **（无入口）**                                                            |
| `air.mission`                | 执行空军任务                       | 14.2e                          | C 移动·modeAndMovement / C 移动·barrage / E 反应·movement / E 反应·barrage / F 战斗·barrage / G 进击·movement / G 进击·barrage                               | beginAirMissionNow()                                                      |

**两个例外（都不是越权漏洞）**

- `move.breakout`：环节标了 `skipWhenIdle`（本局无人可突围 ⇒ 环节自动跳过），所以平常扫不到；
- ~~`rein.specialRepl`：功能未实现~~ ⇒ ★ 2026-10-25 **已接线**（`containers.drawSpecialRepl()`，过环节闸＋日期闸）；本表其余项仍是缺口。
- `exclusive.panzerObligation` 属"段末义务"判定（3.4b），不是玩家手里的按钮。

## 2. 缺口 A：UI 未按环节收敛（已受闸门，但界面常显）

统计口径：`@click` 里直接或经组件内包装函数调用到**已受闸门**的动作键。

共 **35 处**，**0 处**按环节禁用（`✅`＝已接 `actionAllowedNow`，`✗`＝未接）：

| 位置                                                 | 调用                               | 动作键              | 已接闸门 |
| ---------------------------------------------------- | ---------------------------------- | ------------------- | -------- |
| src/components\air\AirPanel.vue:932                  | `workbench.beginRefitNow(base.id)` | `air.refit`         | ✗        |
| src/components\air\AirPanel.vue:990                  | `workbench.buildAirBaseNow()`      | `move.construction` | ✗        |
| src/components\air\AirPanel.vue:1046                 | `workbench.reduceBaseNow(base.id)` | `air.baseReduce`    | ✗        |
| src/components\barrage\BarragePanel.vue:378          | `workbench.beginBarrageNow()`      | `barrage.declare`   | ✗        |
| src/components\combat\CombatPanel.vue:300            | `workbench.beginCombatNow()`       | `combat.declare`    | ✗        |
| src/components\exclusive\ExclusiveRulesPanel.vue:466 | `workbench.buildHedgehogNow()`     | `move.hedgehog`     | ✗        |
| src/components\exclusive\ExclusiveRulesPanel.vue:469 | `workbench.reduceHedgehogNow()`    | `move.hedgehog`     | ✗        |
| src/components\exclusive\ExclusiveRulesPanel.vue:581 | `                                  |

              workbench.useConstructionMarkerNow(
         ` | `move.construction` | ✗ |

| src/components\exclusive\ExclusiveRulesPanel.vue:680 | `workbench.spendSupplyCacheNow()` | `exclusive.forage` | ✗ |
| src/components\game\MapActionPopover.vue:741 | `workbench.beginRefitNow(baseAtHex.id)` | `air.refit` | ✗ |
| src/components\game\MapActionPopover.vue:826 | `beginMission()` | `air.mission` | ✗ |
| src/components\move\MovePanel.vue:266 | `workbench.switchUnitMode('combat')` | `move.modeChange` | ✗ |
| src/components\move\MovePanel.vue:274 | `workbench.switchUnitMode('move')` | `move.modeChange` | ✗ |
| src/components\move\MovePanel.vue:282 | `workbench.switchUnitMode('reserve')` | `move.modeChange` | ✗ |
| src/components\move\MovePanel.vue:290 | `workbench.switchUnitMode('strat')` | `move.modeChange` | ✗ |
| src/components\move\MovePanel.vue:320 | `workbench.releaseReserveNow()` | `reserve.release` | ✗ |
| src/components\move\MovePanel.vue:519 | `workbench.payFuel()` | `supply.fuel` | ✗ |
| src/components\reinforcement\ReinforcementPanel.vue:473 | `onPlaceArrival(index)` | `rein.arrival` | ✗ |
| src/components\reinforcement\ReinforcementPanel.vue:601 | `workbench.applySupplyArrivalsNow()` | `rein.supplyArrival` | ✗ |
| src/components\reinforcement\ReinforcementPanel.vue:720 | `
          workbench.rebuildUnitNow({
            unitId: re` | `rein.rebuild` | ✗ |
| src/components\reinforcement\ReinforcementPanel.vue:798 | `workbench.createBreakdownNow(breakdownParentId, breakdownRec` | `move.breakdown` | ✗ |
| src/components\reinforcement\ReinforcementPanel.vue:830 | `workbench.consolidateUnitsNow(keepId, removeId)` | `rein.rebuild` | ✗ |
| src/components\reinforcement\ReinforcementPanel.vue:938 | `workbench.claimFrontalReservesNow()` | `rein.frontalReserves` | ✗ |
| src/components\supply\SupplyPanel.vue:432 | `workbench.destructDumpNow(destroyDumpId, destroyT ?? undefin` | `move.dumpBlow` | ✗ |
| src/components\supply\SupplyPanel.vue:532 | `workbench.loadTransportPointNow()` | `move.loadUnload` | ✗ |
| src/components\supply\SupplyPanel.vue:540 | `workbench.unloadTransportPointNow()` | `move.loadUnload` | ✗ |
| src/components\supply\SupplyPanel.vue:571 | `
              workbench.convertTransportToExtenderNow(workb` | `move.extenderConvert` | ✗ |
| src/components\supply\SupplyPanel.vue:718 | `workbench.convertRailGaugeNow(gaugeUnitId, workbench.railGau` | `move.railConversion` | ✗ |
| src/components\supply\SupplyPanel.vue:768 | `workbench.railMoveNow('unit')` | `move.railTransport` | ✗ |
| src/components\supply\SupplyPanel.vue:792 | `workbench.railMoveNow('sp')` | `move.railTransport` | ✗ |
| src/components\supply\SupplyPanel.vue:799 | `workbench.railMoveNow('transportPoint')` | `move.railTransport` | ✗ |
| src/components\supply\SupplyPanel.vue:838 | `workbench.planSupplyPhaseNow()` | `supply.draw` | ✗ |
| src/components\supply\SupplyPanel.vue:861 | `workbench.applySupplyPhaseRecoveryNow()` | `supply.recovery` | ✗ |
| src/components\supply\SupplyPanel.vue:868 | `workbench.applySupplyPhaseFeedingNow()` | `supply.draw` | ✗ |
| src/components\supply\SupplyPanel.vue:946 | `workbench.applyAttritionNow(dutyKey(duty))` | `supply.attrition` | ✗ |

> 还有约 **130 处** `@click` 通过"选择/切换/草稿"类调用（`setAirMissionKind`、`toggleCombatTagalong` 等）
> 或流程内步骤（`confirmCombatLosses`、`rollCombatDice` 等）改状态，**不属于环节闸门范畴**（见 §4）。

**症状**：在 B 增援段打开右侧任一动作面板 → 按钮全在 → 点「修筑工事」/「换轨」/「铁路运输」/「整备」
→ 弹一行"只能在「C 移动·移动」进行（6.）"。**操作没做错，但界面像在骗人。**

## 3. 缺口 B（已结案）：那约 48 条"能点到但没过闸门"的落盘动作

> ★ **2026-10-25 已处理完毕**。逐条核过原文后，它们并不是同一种东西 —— 只有第一类是真缺口。
> **唯一在案的账本**是代码里的 `src/stores/action-wiring.ts`（`UNGATED_ACTIONS`），
> 由 `tests/stores/action-wiring.test.ts` 逐条核对（覆盖 / 已加闸核对 / 不该有闸核对 / 理由非空）。
> 本表只留**结论摘要**，明细看代码。

| 归类                        | 条数 | 含义                                                                                                       | 处理                                                                       |
| --------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **gated**（真缺口，已补闸） | 11   | 原文给了**明确时机**                                                                                       | store 入口加 `requireAction(key)`；行为验证在 `action-gates-batch.test.ts` |
| referee（裁判工具）         | 33   | 改值 / 订正 / 摆件 / 自动环节的手动退路                                                                    | 规则里不是"玩家在某环节的动作" ⇒ 不设环节闸；对局台按 `showsReferee` 不铺  |
| flowState（状态机）         | 46   | `combatState` / `barrageState` / `airState` / `supplyState` / `moveInteraction` / `breakoutReturns` 的步进 | 没开局这些入口根本走不通（比环节闸更窄）                                   |
| noTiming（原文没给时机）    | 10   | 原文有动作、未给时机（或明说"任何阶段"）                                                                   | **不加闸** —— 加闸就是发明规则（铁律：取保守值）                           |
| pickMode / draft / pregame  | 75   | 选格态 / 待提交输入 / 初设                                                                                 | 不落盘或不在环节体系内                                                     |

（本轮登记 **175** 条；另有约 23 条入口在函数体里直接带 `requireAction`，不入本表。）

### 3.1 这轮真正补上的 11 个入口（9 道不同的闸）

| 入口                                                 | 键                     | 原文                                                                               |
| ---------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `applyArrivalRemovalsNow`                            | `rein.arrival`         | 1.6a「is **immediately** removed from play」（到达卡的一部分）                     |
| `removeForeverNow`                                   | `rein.arrival`         | 13.5c 永久移出，入口在到达卡侧                                                     |
| `buildAirstripNow` / `upgradeAirstripNow`            | `move.construction`    | 15.3「只能在**移动阶段**中修建或改进」/ 15.2A                                      |
| `rollAttritionNow`                                   | `supply.attrition`     | 12.8a「在**补给阶段**中……并检查损耗」                                              |
| `setUnitFuelled`                                     | `supply.fuel`          | 12.5c「在燃料消耗时支付」（修前 `payFuel` 有闸、这个开关没有 ⇒ 可绕过付款）        |
| `flipExtenderToTransport` / `collapseExtenderNow`    | `move.extenderConvert` | 12.7d「翻面要消耗一半的 MA」/ 9.14d「可在**移动环节**用它替代常规移动」            |
| `mergeTransportPointsNow` / `splitTransportPointNow` | `move.transportMerge`  | 13.2c「只能在**友方移动阶段**中进行」                                              |
| `useConstructionMarkerNow`                           | `move.construction`    | 专规 3.5「任一轴方移动阶段、在单位移动之前」                                       |
| `drawFormations` / `applyDraw`                       | ——（**故意不加**）     | 初设自动抽签也走这两个函数；带闸的是 `drawAndApplyStepNow`（`rein.formationDraw`） |

### 3.2 明确"不加闸"的几条（附原文，防止以后有人手痒加回去）

- **13.9 第 4) 项**：「这可以**在任何阶段**进行（不仅仅是增援阶段）」⇒ 飞机合并随时可做。
- **专规 3.3b**：「可在**任意相位**放置」⇒ 治安检查随时可做。
- **12.1a**：SP 的拆分/加总**没有时机限制**（与 13.2c 的运输点数不同）。
- **14.11 基地转移**：原文未给阶段限制（它不是 14.1g 的"任务"）。
- **1.4a/1.4b 盒**、**13.7 编队收纳**：原文未给时机。

## 4. 不属于环节闸门的三类（不算缺口）

| 类别            | 例子                                                                                                       | 为什么不需要闸门                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 输入草稿 / 勾选 | `setAirMissionKind`、`toggleCombatTagalong`、`setHoverHex`、`setSupplyPreview`、`clearSupplyPhasePlan`     | 只改"待提交的输入"，不落盘                                           |
| 结算内部步骤    | `rollCombatDice`、`confirmCombatLosses`、`confirmBarrageOutcomeStep`、`advanceNow`、`confirmCombatAdvance` | 由 `combatState` / `barrageState` 的**步进状态机**约束：没开局点不动 |
| 纯投影 / 查询   | `airInactiveAtBase`、`formationFuelThrowOf`、`supplyStatusLabel`、`resolveArrivalFormation`                | 只读，不改状态                                                       |

## 5. 建议的改造顺序

1. **先补 §3 的闸门**（真缺口，约 50 条，每条 3–6 行）：逐条核原文 → 在 `ACTION_GATES` 加 where →
   在 store 入口加 `requireAction` → 补用例。这一层做完，"越权操作"才真正绝迹。
2. **再做 UI 收口（§2）**，两步走：
   - **面板级**：每个面板声明服务的环节（由 §1 矩阵反查），当前环节用不到的面板折叠成
     一条「本环节不可用（可展开看数据）」——改动面小、体验提升最大；
   - **按钮级**：统一 `ActionButton`（读 `actionAllowedNow(key)`），禁用 + tooltip 给规则号与出路。
3. **加一条不变量测试**：凡 `begin*/apply*/roll*/confirm*` 里写盘面的函数，必须
   `requireAction(...)` 或**显式**登记在"由状态机约束"的白名单里（防止以后又漏）。

---

### 附：本次审计的统计口径

- 组件里 `workbench.xxx(` 调用去重后 **207 个函数**；其中 **31 个**函数体内有 `requireAction`；
  **105 个**"写盘面但无闸门"，再剔除草稿/结算内部/投影后余 **约 50 个**真缺口候选。
- `@click` 能直接或经组件内包装映射到动作键的 **35 处**，其中接闸门的 **2 处**（`MapActionPopover`）。
- 闸门矩阵由脚本实测（`ACTION_GATES.where` × `sop-segments` 玩家环节 × 两方），不引用注释。
