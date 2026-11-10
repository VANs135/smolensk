# 战斗终局组合收束 — 任务拆解

对应规格：[spec.md](./spec.md)　基线：`main` HEAD `340f43e`（工作区干净）

## T1　先红：终局组合断言（8 条）

- [x] 新建 `tests/stores/combat-terminal-states.test.ts`
  - [x] 复用 `combat-interaction-flow.test.ts` 的夹具（`newStore` / `setupBattle` / `driveToResolution` / `straightPath` / `setRetreatDestinationNow` 口径）
  - [x] A1–A8 见规格 §5；每条都断言「能收束 + 日志完整」：
        `combatState.finished === true`、`combatLiveStep === null`、`log` 含该组合的关键行、`recordSettlement` 台账含对应 `action`
- [x] 在 `tests/engine/combat-interaction.test.ts` 追加：
  - [x] `liveRetreatSides` 16 组真值表
  - [x] `resolveRetreats` 对“需撤退但无存活单位”返回 `skipped`、不报 `retreatPathMissing`
- [x] 运行：`npx vitest run tests/stores/combat-terminal-states.test.ts tests/engine/combat-interaction.test.ts`
- [x] 交付：失败输出（A9 在旧口径下 `confirmCombatRetreats()` 返回 false 复现卡死；补 A9 覆盖死亡堆成员滞留）
- [x] 提交：`test(combat): 固定 7 种终局组合与连续两场突袭的收束断言（红）`

## T2　引擎：`liveRetreatSides` + `resolveRetreats` 存活过滤

- [x] `src/engine/rules/combat-interaction.ts`
  - [x] 导出 `liveRetreatSides(state, stepsById)`
  - [x] `resolveRetreats`：`sideUnits` 过滤 `steps > 0`；`retreatingSides` 改用该函数；返回 `skipped`
  - [x] 保持“无撤退方 ⇒ `step='advance'`”与既有 `step` 取值
- [x] 运行 T1 的引擎用例 + `tests/engine/combat-interaction.test.ts`
- [x] 提交：`fix(combat): 撤退步只接受存活参战单位，终局按 9.10a/9.12 归一`

## T3　状态层：计划/事实/台账不再引用已进死亡堆的 id

- [x] `src/stores/workbench.ts`
  - [x] `combatRetreatPlans`：`steps>0` 过滤；空行方不建计划
  - [x] `combatRetreatFacts` / `combatTagalongCandidates` / `combatAdvanceCandidates`：同样过滤
  - [x] `confirmCombatRetreats`：消费 `data.skipped` 写日志；`pending.unitIds` 改存活 id
- [x] 运行 `tests/stores/combat-interaction-flow.test.ts` + `tests/stores/combat-panel-picker-flow.test.ts` + `tests/stores/overrun-auto-advance.test.ts`
- [x] 提交：`fix(combat): 撤退计划与台账排除死亡堆单位，空计划不再“已完成”`

## T4　界面：撤退步无计划时给出可收束入口

- [x] `src/components/combat/CombatPanel.vue` 第 9 步
  - [x] `combatRetreatPlans.length === 0` 时保留原文案；若 `combatRetreatRequirement` 非 0，加 `9.12 / 无存活单位` 标签
  - [x] 确认按钮不因计划为空而禁用
- [x] 不新增说明段落
- [x] 提交：`fix(combat): 撤退步无存活单位时可继续收束`

## T5　收束日志统一 + 突袭上下文清理

- [x] `confirmCombatRetreats` / `confirmCombatAdvance` 的两个收束点补 `本场战斗收束（9.2）`
- [x] 核对 `settleOverrunAdvanceIfRequired` / `settleOverrunMove`：组合 1/2/5/7 都必须清 `overrunContext` 并结束移动
- [x] 运行 A8（连续两场突袭）
- [x] 提交：`fix(combat): 终局收束统一落账并清理突袭上下文`

## T6　六门槛

```bash
npm run typecheck
npm run lint
npm run format:check
npx vitest run --maxWorkers=4
npm run arch
npm run build
```

- [x] 全绿后单条提交（如无额外改动则并入 T5 后的最终提交）
- [x] 报告实数：通过文件数/用例数/失败数、构建产物结果
      `typecheck 0` / `lint 0` / `format:check 0` / `vitest 423 文件、4932 通过、1 跳过、0 失败` /
      `arch 通过` / `build dist/assets/index-B-nFgOKc.js 2672.67 kB（gzip 575.57 kB）`

## T7　报告

- [x] 组合表：组合 → 实际 `step` 轨迹 → 是否收束 → 日志关键行
- [x] 9 条断言（A1–A9）逐条 PASS 证据
- [x] 待裁定 R/Q 清单（规格 §3）

## 队列（不并入本批）

- [ ] **Batch B**：西移「道路类边 ∪ 铁路边」并集判据 + 四编队重算表 + 冲突先报 + 「只连铁轨」断言
- [ ] E0/E1 抽签池入剧本数据、E3 抽签按钮、E4 种子写日志头、E5 初设模式限制
- [ ] D2 点格浮签改悬停、D4 段内切换清 `stackSelection`/`expandedStack`、D5 14.11 与 13.3g 补 `ACTION_GATES`
