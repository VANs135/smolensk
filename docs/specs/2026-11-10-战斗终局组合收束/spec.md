# 战斗/突袭结算：终局组合穷举与收束 — 规格

日期：2026-11-10　状态：待批　范围：Batch A（阻断级）

## 0. 问题与目标

**现象**：突袭结算里「进攻方需要撤退」与「防御方被全部消灭」同时出现时，流程卡死（用户截图 17.17 一带突袭后的盘面，格已标红叉）。

**目标**：把突袭/战斗结算的状态机按**终局组合**穷举，7 种组合都必须走到收束：关窗、落账、写日志、可继续下一步；追加「连续两场突袭」互不污染。

**纪律**：先红后绿、单独提交、报实数、不放宽判据；原文判不出的登记待裁定，不自编规则。

---

## 1. 已读代码事实（定位依据）

| 位置                                                          | 事实                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/rules/combat-interaction.ts:686-771` `planLosses` | 强制损失后按 `wipedOut = patches.every(steps<=0)` 决定 `step`：攻灭→`losses`(跳攻选项)；守灭→`retreat` 且 `stage='done'`                                                                                |
| `:779-928` `planOptions`                                      | 攻方选项完成→`losses`/`defenderLosses`；守方选项完成或行使 9.10c 忽略→`retreat` 且 `stage='done'`                                                                                                       |
| `:943-1117` `resolveRetreats`                                 | `retreatingSides` 只由 `option.retreatHexes > 0` 决定；`unitsOfSide` 把「不在 `input.units` 里的构成成员」静默丢弃；`missing` 只对保留下来的单位要求路径；`retreatingSides` 为空时直接 `step='advance'` |
| `:1128-1228` `resolveAdvance`                                 | `attackerRetreated` ⇒ 不推进（9.12g-B），仍置 `finished:true`                                                                                                                                           |
| `src/engine/rules/engagement-progress.ts:12-38`               | `step==='retreat'` 时有撤退计划→按计划；无计划→按攻方撤退格数归角色                                                                                                                                     |
| `src/stores/workbench.ts:2187` `combatAttackers`              | 构成 id 投影到 `units.value`；进死亡堆者被丢弃                                                                                                                                                          |
| `:2706-2779` `combatRetreatPlans`                             | 只为 `needsRetreat` 的一方建计划；`complete = rows.every(chosen)` —— **rows 为空时恒为 true（空洞真）**                                                                                                 |
| `:2522-2529` `combatRetreatRequirement`                       | 直接读 `option.retreatHexes`，不区分该方是否还有存活单位                                                                                                                                                |
| `:10606-10725` `confirmCombatRetreats`                        | 交 `resolveRetreats`；`pending.unitIds` 取 `composition.attackerIds`（含可能已阵亡者）；无推进候选时自行调 `confirmCombatAdvance()`                                                                     |
| `:15871-15881` `settleOverrunAdvanceIfRequired`               | 只在 `step==='advance'` 时自动收束突袭推进                                                                                                                                                              |
| `src/components/combat/CombatPanel.vue:672-682`               | 「确认撤退」按钮 `disabled = retreatPlan !== null && !retreatPlan.complete`；`retreatPlan === null` 时按钮可点，但面板只显示「无人需要撤退」                                                            |

**结论（卡死主因假设，red 测试逐条钉死）**：

1. 守方在强制损失中全灭后 `step='retreat'`/`stage='done'`，攻方仍有 `retreatHexes>0`；撤退步本身没有“终局归一”逻辑——只要某方“需要撤退但已无存活单位”，或计划列表为空/空洞完成，界面与引擎对「该不该等、等谁」判断分叉。
2. `combatRetreatPlans` 可能产出 `units: []` 且 `complete: true` 的计划（空洞真），地图侧选中它，按钮看似可用但状态机没有推进；或反过来计划里有已进死亡堆的单位，永远 `chosen === null`。
3. `pending.unitIds` 与 `combatRetreatFacts.retreatingUnitIds` 仍引用 `composition.*`，其中可能含已进死亡堆的 id。

---

## 2. 终局组合矩阵（裁定 ⇒ 期望）

原文依据：

- **9.10a**：选项为「撤退格数与损失军力任意组合，但选项总数必须完全被满足」。
- **9.10b**：攻方先结算，守方后结算。
- **9.10c**：攻方用选项撤退、或攻方在承受选项前被摧毁时，**守方可以忽略**自己的选项（仅守方有此权利）。
- **9.11c**：强制军力损失；单位军力归零即被消灭（离场进入死亡堆）。
- **9.12**：「所有参与战斗的单位必须撤退，且必须撤退的格数等于剩余的选项数量」；撤退以**单位**为对象。
- **9.12b/c/d/e/f/g**：撤退地形/ZOC/跟随/额外损失/路径限制/战后推进。
- **8.1 / 8.1f**：突袭成功（防御格清空）必须战后推进进格。
- **9.12g-B**：攻方在选项中选择撤退 ⇒ 不得推进。

| #   | 组合                         | 守方状态           | 攻方义务                | 状态机期望                                                      | 收束动作                                                                    |
| --- | ---------------------------- | ------------------ | ----------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | 守灭、攻存                   | 全灭（9.11c）      | 攻方选项 0 点 ⇒ 无撤退  | `losses → retreat → advance`，`retreat` 步无撤退对象            | 无委托撤退；9.12g 有可推进者则推进，否则直接收束（overrun 强制推进走 8.1f） |
| 2   | **守灭、攻需退（当前卡死）** | 全灭               | 攻方自身选项含撤退格数  | 攻方按**自己的** `retreatHexes` 撤退；守方无对象不参与          | 撤退落盘 + 9.12e 结算 + 日志；9.12g-B 不推进；`finished`                    |
| 3   | 攻灭、守存                   | 存                 | 攻方无存活单位 ⇒ 无撤退 | `losses → defenderLosses → defenderOptions → retreat → advance` | 跳过攻方选项（9.10c 例 B）并写日志；守方按自己的选项走                      |
| 4   | 攻灭、守需退                 | 存且守方选项含撤退 | 攻方无对象              | 守方按自身撤退格数撤退（9.10b：攻方先、守方后）                 | 撤退落盘、日志；收束                                                        |
| 5   | 双方全灭                     | 全灭               | 无对象                  | 撤退步 `retreatingSides` 为空 ⇒ `advance`                       | 无撤退、无可推进单位 ⇒ 直接收束                                             |
| 6   | 双方留存、各自需退           | 存                 | 双方各自撤退            | 攻方先撤、守方后撤（同一次 `resolveRetreats` 内按方处理）       | 全落盘 + 日志；9.12g 按攻方未撤退判推进                                     |
| 7   | 一方全灭、另一方无需任何后续 | 全灭或攻灭         | 撤退 0、无推进候选      | 不进选项（如适用）→ 撤退空转 → 收束                             | `finished=true`，不残留窗口                                                 |
| 8   | 连续两场突袭                 | —                  | —                       | 第二场 `composition` / 计划 / 日志 / 参突名单不得含第一场单位   | 第一场 `finished` 态与 `overrunContext` 在第二场开始前清空                  |

**裁定 R1（守方全灭后攻方是否仍须撤退）**：**仍须**。依据 **9.10a**（选项总数必须完全满足；撤退格数已由攻方自己选择）+ **9.12**（所有参战单位必须撤退，格数＝剩余选项数）。**9.10c 的“忽略”权只属于守方**，原文没有给攻方免除义务的条款。⇒ 组合 ② 按攻方已选格数撤退，不因守方消失而取消。

**裁定 R2（无存活单位的一方）**：9.12 以单位为对象，该方已无存活参战单位 ⇒ 撤退格数记 0、跳过该方，并**写一条日志**说明「无撤退对象」。不得把已进死亡堆的 id 放进等待集合。

**裁定 R3（双方全灭）**：无撤退对象、无推进对象，直接收束（8.1f/9.12g 均无主体）。

**裁定 R4（撤退目标格）**：落点与路径只按**当前存活**单位的位置/机动、地图地形与**当前存活敌方单位**的 ZOC 计算；已进死亡堆的单位不得提供 ZOC、不得被要求给路径。这是 9.12b 判据的落地，不新增规则。

---

## 3. 待裁定（本批不实现，只登记）

| 编号 | 空白点                                                                  | 现状处理（不改）                                                                  |
| ---- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Q-A1 | 突袭中攻方在选项里撤退时，8.1 是否仍算“成功突袭”、3 MP 与 8.1f 后果如何 | 沿用现有 `resolveOverrunAftermath`（攻方撤退 ⇒ 不进格、结束移动），本批不新增口径 |
| Q-A2 | 双方全灭时 9.12e 的 DG 额外损失无承受者                                 | 记 0；日志注明无承受者                                                            |
| Q-A3 | 守方已灭后，撤退路径能否穿过原守方格                                    | 按 **9.12f** 以“战斗开始时快照”判禁穿 —— 原文明确，无需裁定                       |

---

## 4. 设计变更（精确到函数）

### 4.1 引擎：终局归一（`src/engine/rules/combat-interaction.ts`）

新增导出纯函数（不改现有导出语义）：

```ts
/** 9.10a/9.12：仍须撤退的一方（要求 retreatHexes>0 且该方尚有存活参战单位） */
export function liveRetreatSides(
  state: CombatInteractionState,
  stepsById: ReadonlyMap<string, number>,
): CombatRole[]
```

实现：遍历 `attacker/defender`，取 `option?.retreatHexes > 0` 且 `composition` 中**至少一个** id 满足 `(stepsById.get(id) ?? 0) > 0`。无该 map 条目视为已离场（`unitsOfSide` 同一口径）。

**`resolveRetreats` 改动**：

1. 构造 `stepsById`（来自 `input.units`）。
2. `sideUnits` 过滤 `steps > 0`（已进死亡堆者不参与 9.12；R2/R4）。
3. `retreatingSides` 改用 `liveRetreatSides` 的结果；被排除但 `retreatHexes>0` 的一方记入 `skipped`。
4. 返回体新增 `skipped: { side: CombatRole; retreatHexes: number }[]`。
5. 无任何可撤方 ⇒ 仍 `step='advance'`（保持现有行为），并回传 `skipped`。
6. `missing` 判据不变（只对存活 `sideUnits` 要求路径）。

**`planLosses` / `planOptions` 不改判据**，只补注释引用 R1–R3；`step` 的既有取值（守灭→`retreat`）保持，避免破坏既有 12.1–12.3 用例与 9.2 流程清单。

### 4.2 状态层（`src/stores/workbench.ts`）

| 函数/计算                                 | 改动                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `combatRetreatPlans`（2706）              | `sideUnits` 过滤 `steps > 0`；`rows.length === 0` 时 `continue`（不再产出空洞完成的计划）；`complete` 语义只在 `rows.length>0` 时成立                  |
| `combatRetreatRequirement`（2522）        | 保持返回选项值（面板标签仍显示原文格数）；新增派生 `combatRetreatSkippedSides` 供面板显示“无对象”事实（不新增描述段落，只在标签后加 `（无存活单位）`） |
| `combatRetreatFacts`（2610）              | `retreatingUnitIds` 只取存活单位；不把 `composition` 中已离场 id 传给 `createRetreatFacts`                                                             |
| `combatTagalongCandidates`（2567）        | 宿主堆叠过滤 `steps > 0`                                                                                                                               |
| `combatAdvanceCandidates`（2643）         | 过滤 `steps > 0`（9.12b 之外再加“必须存在”）                                                                                                           |
| `confirmCombatRetreats`（10606）          | 读取 `data.skipped`，每方写一条日志：`9.12：<方>已无存活参战单位 ⇒ 无撤退对象（原需 N 格记 0）`；`recordSettlement.pending.unitIds` 改为存活攻方 id    |
| `settleOverrunAdvanceIfRequired`（15871） | 不变；确认从 `confirmCombatRetreats` 与 `cancelSpecialCombatNow` 两条路径都能到达                                                                      |
| 收束日志                                  | 两处收束点（无推进候选 / 推进完成）统一补一条 `本场战斗收束（9.2）` 的 `success` 日志，便于断言“日志完整”                                              |

### 4.3 界面（`src/components/combat/CombatPanel.vue`）

- 第 9 步（603-683）：当 `combatRetreatPlans.length === 0` 时，显示现有「无人需要撤退」文案 + 若 `combatRetreatRequirement` 非 0，加一枚 `9.12 / 无存活单位` 标签；「确认撤退」按钮保持可点（收束路径）。
- 不新增说明段落、不新增按钮。

---

## 5. 断言清单（先红后绿）

新文件 `tests/stores/combat-terminal-states.test.ts`（沿用 `combat-interaction-flow.test.ts` 的真实地图/单位库夹具；组合 3–7 用引擎直接构态补足 CRT 难以自然出现的结果）：

| #   | 用例                   | 断言                                                                                                                                                                                                                                     |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 守灭、攻存             | `confirmCombatLosses` 后 `step='retreat'`；`confirmCombatRetreats()` 为 true；`combatLiveStep===null`；`finished===true`；日志含「跳过守方的选项」与「本场战斗收束」                                                                     |
| A2  | 守灭、攻需退           | 攻方选项撤退 N>0；守方 L# 全灭；`combatRetreatPlans` 只有 `attacker` 且每行 `steps>0`；逐行 `setRetreatDestinationNow` 成功；`confirmCombatRetreats()` true；`step='advance'`；`finished`；日志含每单位撤退落点；`overrunContext===null` |
| A3  | 攻灭、守存             | 攻方 L# 全灭 ⇒ `optionsSkipped='attackerWipedOut'`；守方选项可结算；收束；日志含「跳过攻方的选项」                                                                                                                                       |
| A4  | 攻灭、守需退           | 攻方全灭后守方选项撤退 N>0；守方存活；撤退成功并落盘；收束；日志含守方撤退记录                                                                                                                                                           |
| A5  | 双方全灭               | `skipped` 含两方或撤退空转；`confirmCombatRetreats()` true；`finished`；日志含「无撤退对象」                                                                                                                                             |
| A6  | 双方留存各自需退       | `combatRetreatPlans` 顺序为 attacker→defender；双方路径都能写入；`confirmCombatRetreats()` true；按攻方是否撤退判 9.12g                                                                                                                  |
| A7  | 一方全灭、另一方无后续 | 守灭且攻方选项 0、无推进候选 ⇒ `confirmCombatRetreats()` 直接收束；`finished`；没有停在任何步                                                                                                                                            |
| A8  | 连续两场突袭           | 第一场收束后发起第二场：`combatState.composition.attackerIds` 不含第一场 id；`combatRetreatPlans` 不含第一场单位；日志按场次可区分                                                                                                       |

引擎单测 `tests/engine/combat-interaction.test.ts` 追加：

- `liveRetreatSides` 真值表：{攻有存活/无存活} × {攻撤退0/N} × {守有存活/无存活} × {守撤退0/N} 共 16 组，只返回“有存活且格数>0”的一方。
- `resolveRetreats` 对“需撤退但该方无存活单位”返回 `skipped` 且不报 `retreatPathMissing`。

---

## 6. 验证（六门槛）

```bash
npm run typecheck
npm run lint
npm run format:check
npx vitest run --maxWorkers=4
npm run arch
npm run build
```

报告：8 条用例逐条 PASS + 实际日志条数；六门槛实数；组合表（组合 → 实际 `step` 轨迹 → 日志关键行）。

---

## 7. 不在本批（队列）

- **Batch B（用户最新裁定）**：西移判据改为「道路类边 ∪ 铁路边」并集；重算四编队落点、核对 29 Mtr/12 Pz/7 Pz 是否冲突、补「只连铁轨的格子也算合法落点」断言。需先盘点 `mapLayers` 边类别取值，另出规格后再实施。
- 其余队列：E0/E1 抽签池入剧本数据、E3 抽签按钮、E4 种子写日志头、E5 初设模式限制、D2/D4/D5 等。
