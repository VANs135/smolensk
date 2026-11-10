# Q-A1 / Q-A2 裁定落地 + 9.12f 复核 — 规格

日期：2026-11-10　状态：实施中　基线：`main` `a8c29e9`

## 0. 裁定来源

用户 2026-11-10 按 OCS v4.3 原文裁定 Q-A1 / Q-A2，并要求复核 9.12f。本批**只落这三条**，不扩口径。

---

## 1. Q-A1：突袭中攻方选项撤退

**原文**：

- 8.1f："Should the attacking units choose to take one or more of their options as retreats from an overrun, they end their movement for the phase."
- 9.10c："The attacker must always fulfill his option results."
- 9.10 例 E：攻方 `o1`、守方被 `L1` 消灭 ⇒ "attacker must take his option (as loss or retreat)"。

**裁定 ⇒ 实现要求**：

| #      | 要求                                                      | 现状                                                                                                                                                                                          | 本批动作                          |
| ------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Q-A1-1 | 攻方选项撤退 ⇒ **本阶段移动结束**，不得推进、不得继续移动 | `resolveOverrunAftermath` 在 `attackerRetreatedInOptions` 时返回 `movementEndsThisPhase: true` / `mustEnterDefenderHex: false` / `mayContinueMoving: false`；`planOverrunMove` 据此置 `ended` | 补「守方全灭 + 攻方撤退」组合断言 |
| Q-A1-2 | 攻方**必须履行选项**，不因守方全灭而免除                  | Batch A `liveRetreatSides` 只按攻方自身 `retreatHexes>0` 与存活单位判定，守方不在场不影响                                                                                                     | 沿用，不加新分支                  |
| Q-A1-3 | 守方全灭 ⇒ 无守方选项；9.10c 忽略权只属守方               | 既有 `planOptions` / `optionsSkipped` 已如此                                                                                                                                                  | 沿用                              |
| Q-A1-4 | 「突袭是否成功」原文未定义 ⇒ 登记 **N/A**，不实现成功口径 | 代码中无此判定（`exploitGranted: false` 只是 8.1e 的进击标记，不是“成功”）                                                                                                                    | 只在规格登记，不新增字段          |

**结论**：Q-A1 无代码语义变更，只补断言，防止将来回归。

---

## 2. Q-A2：双方全灭时的 9.12e

**原文**：9.12e 只在「战斗单位撤退进入敌方 ZOC」时触发 DG 与「撤退前已 DG ⇒ 损一步」。

**裁定 ⇒ 实现要求**：

- 无撤退单位 ⇒ 9.12e **不适用**，按 0 记；
- 日志写明「无撤退对象，9.12e 不适用」；
- 不得给已灭单位补记损失，不得让双方全灭的场次多一步损失。

**现状**：`resolveRetreats` 在 `retreatingSides` 为空时返回 `extraLoss.points = 0`，不给已灭单位打补丁——数值已正确；缺口只在**日志**：当前仅在「某方被点名但无存活单位」时写「无撤退对象（原需 N 格记 0）」，双方选项均为 0 时没有任何 9.12e 说明。

**本批动作**：`confirmCombatRetreats` 在 `data.results.length === 0` 时补一条：

```text
9.12e：无撤退对象，9.12e 不适用（按 0 记）
```

副作用：无撤退步骤的常规战斗也会多这一行（可接受，属于如实记录）。

---

## 3. 9.12f 复核

**原文**："A retreat cannot go through a hex that contained enemy combat units at the start of the combat (so no retreats through a hex vacated by an attacking unit's loss or option)."

**现状核查**：

| 位置                                                   | 事实                                                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/stores/workbench.ts` `captureCombatStartSnapshot` | 常规战斗（9.2 第 1 步）与突袭（`openOverrunCombat`）各拍一次快照                                                                                               |
| `createRetreatFacts`                                   | 传了快照就用快照判 `enemyCombatUnitAt`；攻方被打空/选项腾空的格仍为真                                                                                          |
| `retreatPathTo`                                        | `passable` 已排除 `enemyCombatUnitAt` ⇒ 合法路径不穿这些格                                                                                                     |
| `planRetreatDestinations`                              | **缺口**：`retreatPathTo` 返回 null 后回退到纯几何路径，标 `forcedDestruction`；该回退不查 9.12f，可能把「只能穿过战斗开始时敌方格」的落点当成可选（必死）落点 |

**本批动作**：

1. `RetreatFacts` 新增可选谓词 `startOfCombatEnemyCombatUnitAt(hex, side)`（9.12f 的**绝对禁穿**，与「当前敌方占据 ⇒ 9.12 消灭」区分）。
2. `createRetreatFacts` 用快照实现该谓词；无快照时返回 `false`（不臆造）。
3. `retreatPathTo` 的 `passable` 同时排除该谓词。
4. `planRetreatDestinations` 的几何回退：若路径任一步命中 `startOfCombatEnemyCombatUnitAt` ⇒ **该落点不列出**（不是必死，而是不可选）。
5. `resolveRetreat` 保留现有「穿越即消灭」终局（防御性，正常路径规划不会产出）。

---

## 4. 断言

`tests/engine/overrun.test.ts`

- Q-A1：`resolveOverrunAftermath({ mpRemainingBefore: 9, attackerRetreatedInOptions: true, defenderLeftHex: true })` ⇒ `mustEnterDefenderHex=false`、`movementEndsThisPhase=true`、`mayContinueMoving=false`、`exploitGranted=false`；`planOverrunMove` 的 `endedIds` 含参突者、`hex=null`。

`tests/engine/battle.test.ts`

- 9.12f-1：`startOfCombatEnemyCombatUnitAt` 命中唯一落点 ⇒ `retreatPathTo` 返回 `null`。
- 9.12f-2：同一 facts 下 `planRetreatDestinations` **不包含**该落点（不得以 `forcedDestruction` 混入）。
- 9.12f-3：`enemyCombatUnitAt`（当前敌方占据）仍照 9.12 标 `forcedDestruction`，不被新谓词误伤。

`tests/stores/combat-terminal-states.test.ts`

- A5 追加：`retreatLogs` 含「无撤退对象，9.12e 不适用」；`extraLoss` 未产生补丁（双方均 0 军力）。
- A2 追加：守方全灭 + 攻方选项撤退 ⇒ 攻方撤退落盘、不推进、`finished`（既有流程，补 8.1f 文案不强制）。

---

## 4.1 P0-2：14.8c 运输破坏区 +1 MP（裁定：**不登记 N/A**，按原文实现）

原文（14.8）：

- **14.8c**：「运输破坏区会影响**敌方**地面单位的移动和铁路费用。**地面单位每进入一个处于 TZ 中的格，地形消耗必须增加 1MP。**」「通过 TZ 的铁路货物需要使用正常双倍的铁路运量……」「舰船、飞机、海运容量和补给路径不受 TZ 影响。」「请注意，**绝不会因为多个 TZ 重叠而对一个格产生额外效果**，而且 **TZ 对撤退也没有影响**。」
- **14.8b**：「运输破坏区(TZ)是指带有运输破坏标记的格加上相邻的六个格。（**例外：使用步行 MP 移动时，运输破坏区仅限于标记所在格**）。」

裁定：原文写的是「地面单位**每进入一个**处于 TZ 中的格」（不是只限铁路/道路）⇒ 按原文叠加 +1 MP；8.1b 的「进入格 MP（**格内＋格边＋运输破坏**）≤ 3」表明**突袭进格也计这一格**。不登记 N/A。

实现：

- `MoveContext.trainbustingMarksBySide`（标记按**放置方**分组）＋ `move.ts#trainbustingSurcharge`：只对「移动方 ≠ 放置方」的地面移动步 +1；标记格与相邻六格都算，步行 MP 只认标记格；重叠不叠计；撤退走 `battle.ts` 的另一条路，不受影响。
- `StepSuccess.trainbustingCost` 为第三段（`cost = hexCost + hexsideCost + trainbustingCost`），`move-interaction` 的步记录同步。
- 账本接线：`workbench.trainbustingMarks` ⇒ `moveContext.trainbustingMarksBySide`。

断言（`tests/engine/trainbusting-zone.test.ts`）：

- 标记格 / 相邻六格各 +1（Open 1 ⇒ 2）；步行 MP 邻格不 +1、标记格 +1；
- 只影响敌方（放置方自己进入不加）；两个 TZ 重叠仍只 +1；
- 突袭 `entryCost` 含 +1（Open+TZ=2），并在 Forest+小河+TZ=4 时按 8.1b 拒绝；
- store 接线按放置方分组。

---

## 5. 六门槛

```bash
npm run typecheck
npm run lint
npm run format:check
npx vitest run --maxWorkers=4
npm run arch
npm run build
```

先红后绿、单独提交、报实数。
