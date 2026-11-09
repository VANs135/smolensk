# 3.4 族规则实施规格：3.4b 可选开关 / 3.4a 常开 / 19 Aug 失效

- 仓库：`D:\OCS\smolensk`
- 分支：`codex/command-table-ui`
- 工作语言：中文
- 类型：规则接线 + UI 收敛 + 回归测试（**先红后绿**）
- 提交要求：本批单独提交、推送；六门槛报实数；`src/data` 若无必要不动
- 存档字段：**本规格不新增持久化字段**（见 §8）

---

## 1. 结论摘要

| 项            | 现状                                                                   | 本批动作                                                 |
| ------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| 3.4b 可选条目 | 已在 `scenarios.json` 共识清单，默认不勾                               | 不改数据；补齐「未选归属不得完成初设 / 不得落账到货 SP」 |
| 3.4b 付款限制 | 引擎与 store 已接（`checkPanzerGroupSpPayment` / `panzerGroupSpGate`） | 只补回归测试，不改判据                                   |
| 3.4b 初设归属 | 玩家可选，但**按分界线自动预填默认归属**                               | **删除按线预填**；每个轴方补给站必须由玩家选             |
| 3.4b 到货归属 | 落账后才进「待归属」；未选也落账                                       | **落账前强制归属**；未选则拒绝整笔                       |
| 3.4b 均分     | 纯函数 `splitSupplyTableSp` 已实现，未接入到货分配                     | 按用户口径**如实报告为缺口**，不擅自强制（§5）           |
| 3.4a 越线判定 | 已常开（无共识开关），19 Aug 起失效                                    | 只补测试 + 修正面板文案                                  |
| 3.4a DG 后果  | 只提示义务，**没有投 DG 的落盘入口**                                   | 新增单一入口，按 5.10 落 `unit.mode.dg`（§7.3）          |
| 19 Aug 失效   | `isPanzerGroupConstraintLifted` 已集中判 `date >= 1941-08-19`          | 补边界测试；确认历史归属不清空、付款限制自动解除         |

**一句话**：规则判据大多已在引擎；本批修的是「初设按线预填」「到货未选就落账」「3.4a 只能看不能投 DG」三处，并用测试钉住 19 Aug 边界。

---

## 2. 原文依据（含绝对路径与行号）

### 2.1 3.4 时限首段

文件：`D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\raw_text\专规及表格__Smolensk_Rules_v1.1.txt`，行 247–283。

> This rule only applies before 19 August and only affects multi-unit formations. It does not limit infantry divisions and independent units at all!

判读：**「before 19 August」= 18 August 仍生效，19 August 起失效**。与增援表一致（下条）。

### 2.2 增援表启停节点

文件：`D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\raw_text\专规及表格__Smolensk_Axis_Arrivals_v1.1.txt`

- 行 7–13：`8 Jul 41` 栏下 `Begin Guderian & Hoth (3.4).`
- 行 84：`19 Aug 41` 栏标题
- 行 90：同栏 `No more Guderian & Hoth (3.4).`

判读：启停节点与 3.4 首段一致；**19 Aug 当天起不再适用**。无第二种口径。

### 2.3 3.4a 分界线

同 §2.1 文件，行 284–308。

> 3.4a Dividing Line. The multi-track railroad that runs generally east from 19.19 to 62.23 divides the two panzer groups. Guderian’s multi-unit formations should stay on or south of this line; Hoth’s should stay on or north of it.
> DG a unit from a multi-unit formation at the end of any phase if it is…
> • Stacked with or adjacent to a unit from the other panzer group, or
> • On the “wrong side” of the dividing line and in a hex east of Orsha.
> Note the boundary line is not a concern for units in hexes west of 19.xx.

判定输入：`src/data/map-config.json:174-185` 的 `panzerGroupBoundary = [[19,19],[62,23]]`；Orsha 格由既有多轨铁路/城市数据给出。本批不新增数据。

判读：

- 约束对象：**多单位编队**（步兵师、独立单位不受限）。
- 地理豁免：**19.xx 以西**不判；越线条件还要求 **Orsha 以东**。
- 后果：对该编队**一个单位投 DG**（机制按通规 **5.10**）。
- 原文用 `should` 描述站位，但 DG 触发句是祈使式；真正强制的是 DG 后果。
- **常开**，不可由 3.4b 的开关替代或关闭。

### 2.4 3.4b 补给限制

同 §2.1 文件，行 309–329。

> 3.4b Supply Restrictions. The Axis must evenly divide Supply Table arrivals between Guderian and Hoth, with the odd point going to Guderian. SP from the “wrong” panzer group cannot be used to pay the fuel, combat, or barrage costs of a multi-unit formation. Aside from this, use of SP is not restricted.
> Example: If 7 SP are obtained, Hoth must be given 3 and Guderian 4.
> • At the start of a scenario, SP must be divided per Setup Note ‘F’ (p. 5).
> • All new Axis SP must immediately be assigned to a panzer group.

判读：

- 均分：**must**；7 SP ⇒ Hoth 3 / Guderian 4。
- 付款：错误集群 SP **cannot** 付多单位编队的燃油/战斗/轰炸；其它用途不限。
- 新到轴方 SP：**must immediately be assigned**。
- 3.4b 属 4.1a 可选项，本作做成**开局共识开关**（默认关闭）。

### 2.5 Setup Note F

同 §2.1 文件，行 394–400。

> F) When using 3.4b (part of “Guderian & Hoth”), on-map SP should be assigned to a Pz Grp during setup. Use the Dividing Line as a guide, but the player can freely decide ownership of dumps.

判读：分界线只是 **guide**；归属由**玩家自由决定**。故实现上不得用线自动定归属。

---

## 3. 现状核查（已存在，不重复造）

| 能力            | 位置                                                                     | 状态                                                           |
| --------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 可选条目文本    | `src/engine/rules/panzer-groups.ts:297`；`src/data/scenarios.json:10-18` | 已有 `装甲集群 SP 归属约束（3.4b，4.1a 可选）`，共识默认全不勾 |
| 3.4b 生效判据   | `src/engine/rules/panzer-groups.ts:309-314`                              | `constraintApplies && agreedByConsensus`                       |
| 3.4b 付款判据   | `src/engine/rules/panzer-groups.ts:323-357`、`369-387`                   | 三用途限制、未归属拒付                                         |
| 3.4b 到期解除   | `src/engine/rules/panzer-groups.ts:346`                                  | `date >= 1941-08-19` ⇒ `restricted:false`                      |
| 时效集中判据    | `src/engine/rules/timing.ts:42-43, 90-93`                                | `isPanzerGroupConstraintLifted(date)`                          |
| 3.4a 义务判定   | `src/engine/rules/panzer-groups.ts:209-273`                              | 两条件、19.xx 以西豁免、非多单位编队豁免、19 Aug 失效          |
| 3.4a store 投影 | `src/stores/workbench.ts:19494-19506`                                    | 常开，不读 3.4b 共识                                           |
| 初设归属校验    | `src/engine/rules/setup.ts:1076-1131`                                    | 未点名 ⇒ `spOwnershipMissing:<id>`                             |
| 初设归属 UI     | `src/components/setup/SetupPanel.vue:506-553`                            | 已有逐站下拉 + 核验按钮                                        |
| 到货 SP 落账    | `src/stores/workbench.ts:16783-16840`、`11387-11466`                     | 落账后才登记待归属                                             |
| 归属台账持久化  | `src/stores/workbench.ts:21081-21082, 21329-21334`                       | `spDumpPanzerGroups` / `pendingSpGroupAssignment` 已在存档     |

**现有缺口（本批要修）**

1. `src/stores/setup.ts:1540-1555, 2482-2499, 2511-2513` 按分界线自动预填默认归属，并提示「不必逐个点名」——违反 Setup Note F 与用户裁定 5。
2. `src/stores/workbench.ts:11443-11459` 新到轴方 SP **先落账**再挂待归属——违反「未选不得落账」。
3. 到货落位界面 `src/components/reinforcement/ReinforcementPanel.vue:775-860` 没有按落点选集群的入口。
4. `src/components/exclusive/ExclusiveRulesPanel.vue:226-229` 3.4a 文案把 Guderian/Hoth 的合规侧写反（现行「Guderian 上方、Hoth 上或下方」）。
5. 3.4a 只有义务提示，没有投 DG 的落盘入口（`applyDgToUnit` 只被战斗结果调用）。
6. 3.4b 均分仅有 `splitSupplyTableSp` 展示，未接入到货校验——按用户裁定「若没有，先如实报告缺口，不臆造规则」，本批**不实现强制均分**。

---

## 4. 口径裁定（本次已确认部分）

| 问题                 | 结论                                                                  | 依据                                                     |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| 3.4 失效时点         | **1941-08-19 当天起失效**（18 Aug 仍生效）                            | 3.4「before 19 August」；增援表行 90 位于「19 Aug 41」栏 |
| 3.4a 是否可开关      | **不可**；常开                                                        | 用户裁定 + 3.4a 原文祈使句                               |
| 3.4b 开关默认        | **关闭**；关闭时无归属界面、无待办、无付款限制                        | 4.1a 可选项 + 用户裁定                                   |
| 失效后历史归属       | **保留不清空**（`spDumpPanzerGroups` 原样）                           | 用户裁定第 2 条                                          |
| 失效后付款           | 不再按集群限制（`checkPanzerGroupSpPayment` 返回 `restricted:false`） | 3.4 时限；现有引擎已如此                                 |
| 分界线在归属中的作用 | **只展示/提示，不参与初设归属判定**                                   | Setup Note F「guide / freely decide」                    |

---

## 5. 待裁定（必须先定，才能收口 3.4a）

原文写「at the end of **any phase**」。现有产品只在**轴方 C/G 移动环节的段末**提示（闸门 `exclusive.panzerObligation`）。两种读法如下，**不择一实现，等裁定**：

- **读法 A（字面）**：每个相位末都判一次——包括苏军相位、轴方其它阶段；同一编队同一相位末至多投 1 个 DG，下一相位若条件仍成立可再次触发。
  - 影响：`panzerObligationActive` 需要扩到所有相位末；需要「本相位已结算」台账，避免同一相位重复弹窗。
- **读法 B（现行）**：只在轴方 C/G 移动环节段末判——理由：位置变化主要发生在轴方移动；其它相位末条件通常未变。
  - 影响：保持 `exclusive.panzerObligation` 闸门不变，只补 DG 落盘入口。

**请选择 A 或 B。** 选择前，本规格 §7.3 的 DG 入口只做「有义务即可投」，不改变触发窗口。

---

## 6. 本批范围

### 做

1. 删除初设按分界线预填归属；改为玩家逐站必选。
2. 到货 SP 落账前强制选择集群；未选整笔拒绝。
3. 3.4a 面板文案修正；新增投 DG 入口（按 5.10）。
4. 19 Aug 边界回归：18 日生效、19 日失效；失效后历史归属保留、付款解除、归属界面消失。
5. 红测先行；六门槛；单独提交推送。

### 不做

- 不改 3.4b 付款判据本身（已实现）。
- 不强制 Supply Table 均分（缺接线；按用户要求只报告，不臆造）。
- 不新增/改名共识条目；`src/data` 不动。
- 不新增持久化字段。
- 不扩大 3.4a 对象（步兵师、独立单位仍豁免）。

---

## 7. 实现设计

### 7.1 初设：玩家逐站选归属

文件：`src/stores/setup.ts`

- 删除 `defaultPanzerGroupOf`（1540-1555）、`fillDefaultPanzerGroups`（2482-2499）与两处调用（1967、2513）。
- **保留** `defaultFilledIds` 字段（2480、2685、2733；`board-validation.ts:111`）：它是既有存档字段，本批不再填充（始终为空），以免改动存档结构。新增逻辑不得依赖它。
- `confirmSpOwnership()`（2511-2545）不再预填；直接把 `spAssignments` 交给 `planSupplyOwnership`。未选满 ⇒ 引擎返回 `spOwnershipMissing:<dumpId>`，`requiredSetupIssues` 保持 `spOwnership` 未完成，`startGameNow` 拒绝。
- `startGameNow` 的自动核验（2303-2310）保持：未逐站选满时自动核验失败并回退，不自动补默认值。
- 归属提交仍走 `workbench.setDumpPanzerGroupNow`（2522-2527），只在核验通过后写台账。
- 不改 `engine/rules/setup.ts#planSupplyOwnership` 的判据。

文件：`src/components/setup/SetupPanel.vue`

- 改写 506-512 的说明：删除「已按分界线自动填好默认归属…不必逐个点名」，改为：
  「分界线只作地图提示，不参与归属判定（Setup Note F：guide / 玩家自定）。每个轴方补给站必须选择 Guderian 或 Hoth；未选不能通过核验，也不能开局。」
- 逐站下拉与核验按钮保持（528-552）。

### 7.2 到货 SP：先选归属再落账

文件：`src/stores/workbench.ts`

- `addSpAtHex`（11387）新增可选 `panzerGroup?: PanzerGroup`。
  - 新建条目：若传了 `panzerGroup`，立即 `setDumpPanzerGroupNow(id, group)`；否则当 `panzerGroupRulesOn && side==='axis'` 时**仍登记待归属**（保留手工/方面军预备队等既有路径的行为，本批不扩大强制面）。
  - 并入既有条目：若既有条目未归属且传了 `panzerGroup`，补写归属；已有归属不覆盖。
- 新增瞬态状态（**不持久化**）：
  - `arrivalSpGroups = ref<Record<string, PanzerGroup>>({})`，键为 `hexLabel(hex)`。
  - `arrivalSpGroupTargets`：由 `freeRailPlan.placements` 按格去重，输出 `{ hex, sp }`；若该格已有归属，输出 `group` 供只读展示。
  - `setArrivalSpGroup(hexText, group|null)`。
  - `clearArrivalSpGroups()`：在落账成功、清空勾选、重开环节时调用。
- `applySupplyArrivalsNow`（16783）：
  1. 计划可用后，若 `panzerGroupRulesOn && activeSide==='axis'`，逐目标格取有效归属（既有台账优先，其次 `arrivalSpGroups`）；任一为空 ⇒ `pushLog('warning', '德军 SP 未选择归属（3.4b）：<格>')`，**return false**，不调用 `addSpAtHex`，不改 `spDumps`。
  2. 全部有归属 ⇒ 按格合并后调用 `addSpAtHex({..., panzerGroup})`。
  3. 成功后清空 `arrivalSpGroups`。
- 3.4b 关闭或 19 Aug 起：不校验、不显示选择、不写归属，行为与现状一致。
- 不改 `addSpDump`（手工新增）与方面军预备队路径；两处仍可走「待归属」面板。此为本批明确边界。

文件：`src/components/reinforcement/ReinforcementPanel.vue`

- 在 775-860 的到货段落里，`v-if="workbench.panzerGroupRulesOn && workbench.activeSide === 'axis'"` 增加一行：
  - 每个 `arrivalSpGroupTargets` 一格一个下拉：`（未选）` / `Guderian` / `Hoth`。
  - 已有归属的格显示只读标签「跟随既有：Guderian/Hoth」，不给下拉。
  - 紧跟一句一行提示：「3.4b：德军 SP 须先选归属，未选不落账」。
- 不新增长段说明；不把集群选择做成选项列表弹窗。

### 7.3 3.4a：文案修正与 DG 落盘入口

文件：`src/components/exclusive/ExclusiveRulesPanel.vue`

- 修正 226-229：
  - 「Guderian 编队须在分界线**沿线或以南**、Hoth 须在**沿线或以北**」。
  - 保留「19.xx 以西不受约束」「非多单位编队不受限」。
- 在义务行（284-287）下方，为每条义务渲染该编队的可选单位按钮（`item.unitIds` 对应 `workbench.units`）：
  - 按钮文案 `投 DG：<unit.name> @ <hex>`。
  - 点击调用 `workbench.applyPanzerGroupDgNow(unitId)`。
  - 仅 `actsPanzer` 时可点；`panzerObligationActive` 决定这一节是否置顶（按 §5 裁定后调整）。

文件：`src/stores/workbench.ts`

- 新增 `applyPanzerGroupDgNow(unitId: string): boolean`：
  1. 在 `panzerGroupObligations` 的 `unitIds` 中查找 `unitId`；不属任何义务 ⇒ `pushLog` 拒绝并 return false。
  2. 找到单位；若已 `mode.dg === true`，仍视为成功（幂等），记 info 日志。
  3. 调用现有 `applyDgToUnit(unit)`（5.10：清预备/战略/进击，保留朝向）。
  4. `pushLog('success', '<unit> 因 3.4a 分界线义务投 DG（5.10）', '3.4a')`；`recordSettlement` 记事实（action `panzerObligationDg`，带 unitId/hex/reason）。
  5. 不修改 `panzerGroupAssignments`、不清义务；条件仍在时下一相位仍会提示。
- 不新增罚则；DG 恢复仍走 5.10 既有流程。

### 7.4 19 Aug 失效

- 不改 `timing.ts` 与 `panzer-groups.ts:346`。
- 验证：
  - `date = '1941-08-18'`：3.4a 义务可触发；3.4b（已勾选）要求归属、错集群付款被拒。
  - `date = '1941-08-19'`：`dividingLineObligations` 返回 `[]`；`panzerGroupRulesOn === false`；初设/到货不再要求归属；`checkPanzerGroupSpPayment` 返回 `restricted:false`；`spDumpPanzerGroups` 原值不变；归属 UI 条件为假。
- 初设场景的首回合若已 ≥ 19 Aug，`requiresPanzerGroupSpAssignment` 本来就是 false（现有实现），补一条测试。

---

## 8. 数据与存档字段

- **不新增持久化字段。**
- 已持久化：`spDumpPanzerGroups`、`pendingSpGroupAssignment`（`src/stores/workbench.ts:21081-21082`、`21329-21334`）。
- 共识勾选已在会话/存档：现有 `agreedOptions` 机制。
- 新增的 `arrivalSpGroups` 为**环节内瞬态**，不写入存档；刷新/重开环节即清空。
- `src/data/scenarios.json` **不改**：条目已存在（行 17：`装甲集群 SP 归属约束（3.4b，4.1a 可选）`）且默认关闭。若要求显示文案精确改为「3.4b SP 须按装甲集群分配」，属数据 + 常量改动，需另行确认后做。
- 如果实现中发现必须持久化新的选择状态，**停下报告字段名与最小形状**，不绕过。

---

## 9. 红测清单（先红后绿）

### T1 初设（改 `tests/stores/setup-sp-ownership-commit.test.ts`）

1. **3.4b 关闭**：不要求归属；`confirmSpOwnership()` 成功；`spDumpPanzerGroups` 为空。
2. **3.4b 开启 + 自动初设**：`spAssignments` 为空（红：现状被线预填）；`confirmSpOwnership()` 失败，错误含 `spOwnershipMissing:`；`requiredSetupIssues` 仍要求 `spOwnership`。
3. **3.4b 开启 + 逐站指派**：全部指派后成功；台账写入所选集群。
4. **反证分界线不参与**：把线北的补给站指派 `guderian`，核验通过且台账为 `guderian`（红：现状可能会按线改回/预填）。

### T2 到货（新增 `tests/stores/supply-arrival-panzer-group.test.ts`）

1. **开启 + 轴方 + 未选**：`applySupplyArrivalsNow()` 返回 false；`spDumps` 长度不变；日志含 3.4b 拒绝。
2. **开启 + 轴方 + 逐格选了**：返回 true；台账每格归属正确；`pendingSpGroupAssignment` 不新增。
3. **关闭**：不选也返回 true（现状基线）。
4. **19 Aug（已勾选）**：不选也返回 true；不写新归属；既有归属保留。
5. **苏方**：不要求选择（3.4b 只约束轴方）。

### T3 3.4a 与 19 Aug 边界

- 复用 `tests/engine/panzer-groups.test.ts` 已有的三类（越线触发 / 西侧豁免 / 非多单位编队豁免）与 18→19 失效断言，断言指到 `rule === '3.4a'`。
- 新增 `tests/stores/panzer-group-dg.test.ts`：
  1. 越线义务存在时 `applyPanzerGroupDgNow(unitId)` 落 `mode.dg === true`（红：现状无此入口）。
  2. 不在义务名单里的单位被拒。
  3. 19 Aug 起无义务，调用被拒。
- 新增 `tests/stores/panzer-group-expiry.test.ts`：
  1. 18 Aug：`panzerGroupRulesOn` 真、待归属存在、错集群付款拒。
  2. 19 Aug：`panzerGroupRulesOn` 假、待归属清空/不要求、错集群付款放行、`spDumpPanzerGroups` 不变。

### T4 源码守卫 / 文案

- `ExclusiveRulesPanel.vue` 文案出现「Guderian … 沿线或以南」「Hoth … 沿线或以北」；不再出现「Guderian … 上方」。
- `ReinforcementPanel.vue` 含 `arrivalSpGroupTargets` 与 3.4b 未选提示（若有既有源码守卫，按同结构加成，不放宽）。

### 受影响既有用例

`arrival-hand-flow`、`free-rail-arrival-flow`、`setup-flow`、`panzer-group-sp-flow`、`b37-boundary-flow`、`session-steps`、`save-slot`，以及 `tests/data/scenarios.test.ts`。

---

## 10. 验收与六门槛

每批完成后在 `D:\OCS\smolensk` 依次跑并报实数：

1. `npm run lint`
2. `npm run format:check`
3. `npm run typecheck`
4. `npx vitest run --maxWorkers=4`（报文件数 / 通过数 / 跳过数）
5. `npm run arch`（报各段计数）
6. `npm run build`（报耗时、包体、gzip）

另外核对：`src/engine`、`src/data` 改动为 0（若确有需要，逐条说明原因）；无新增持久化字段。

---

## 11. 提交与回滚

- 单批提交（含代码 + 测试 + 本规格若有改动），提交信息用临时文件 + `git commit -F`。
- 提交信息写清：3.4b 初设/到货强制归属、3.4a DG 入口、19 Aug 边界；以及「不实现均分强制」的现状说明。
- 回滚：本批不删既有判据；如需回退，`git revert <本批提交>` 即可恢复「自动预填 + 到货后待归属」。
