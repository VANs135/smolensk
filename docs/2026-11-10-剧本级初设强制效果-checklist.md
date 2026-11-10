# 核对清单：剧本级 setupEffects（2026-11-10）

- [ ] 数据：S1/S3/S5 的 `poolFormations` 数量分别 12/14/14，且与 `formationDraw.pool` 相等
- [ ] 数据：`formationDraw` 只在 `setup.effects[0]` 一处出现，无重复数据
- [ ] 数据：缺失 `modeConstraints` 时按默认执行并写 `setupGaps`
- [ ] 引擎：`setup.effects` 执行不出现剧本编号分支
- [ ] 引擎：`shiftWestDestination` 每步都在 `edges.road` 上；无路 `walked=0`
- [ ] 流程：确认前不抽签、无状态；确认后按钮出现；点击一次执行并进第一阶段
- [ ] 流程：刷新/回看/重复点击不重抽（台账随存档）
- [ ] 流程：新局清空台账并重新抽
- [ ] 种子：日志头含本局种子；测试固定
- [ ] 模式：默认战斗；剧本 3 初设禁预备、正式回合可转入；苏军 0 预备被拒
- [ ] 日志：抽中名单 + 每师 `原格 → 落点` + 所走道路边；结果区极简
- [ ] 门槛：lint / format:check / typecheck / vitest / arch / build 全绿
- [ ] 提交：单个提交、`--ff-only` 并入 main、报 HEAD 与实数
