# Q-A1 / Q-A2 裁定落地 — 任务拆解

对应规格：[spec.md](./spec.md)　基线：`main` `a8c29e9`

## T1 规格先落

- [x] 把 Q-A1 四条、Q-A2 一条、9.12f 复核结论写进 [spec.md](./spec.md)

## T2 9.12f：路径与落点双层排除

- [x] `RetreatFacts` 增加 `startOfCombatEnemyCombatUnitAt?`
- [x] `createRetreatFacts` 用 `combatStartSnapshot` 实现
- [x] `retreatPathTo` 排除该谓词命中的格
- [x] `planRetreatDestinations` 几何回退遇到该谓词 ⇒ 不列该落点
- [x] `resolveRetreat` 保留「穿越即消灭」终局

## T3 Q-A2：9.12e 日志

- [x] `confirmCombatRetreats` 在 `data.results.length === 0` 时写「无撤退对象，9.12e 不适用（按 0 记）」
- [x] 确认 `extraLoss.points === 0`，不给已灭单位打补丁

## T4 断言（先红后绿）

- [x] `tests/engine/overrun.test.ts`：守方全灭 + 攻方选项撤退 ⇒ 不进入防御格、`ended`、不继续移动
- [x] `tests/engine/battle.test.ts`：9.12f 落点/路径排除；当前敌方格仍按 9.12 标必死
- [x] `tests/stores/combat-terminal-states.test.ts`：A5 日志含「无撤退对象，9.12e 不适用」

## T5 六门槛与提交

- [x] `typecheck` / `lint` / `format:check` / `vitest --maxWorkers=4` / `arch` / `build`
- [ ] 单独提交
- [ ] 报实数（文件数 / 用例数 / 失败数 / 构建产物）

## T6 完成后

- [ ] 按用户顺序继续「堆叠窗口」：列全 → 默认全选 → 地图同格展开 → 删说明文字
