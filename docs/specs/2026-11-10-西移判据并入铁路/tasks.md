# 西移判据并入铁路 — 任务拆解

对应规格：[spec.md](./spec.md)　基线：`main` HEAD `42fefcc`（工作区干净）

## T1　盘点边类别并写规格

- [x] 统计 `map-layers.json` 的 `edges` 各字段取值与组合（总数 1547；`road` 592、`rail` 360、并集 816）
- [x] 明确数据中**无 `primary`**，道路只有 `secondary` / `track`
- [x] 「算路 / 不算路」归类写入 [spec.md](./spec.md) §1

## T2　改判据（road ∪ rail）

- [x] `src/stores/containers.ts`：`ROAD_OR_RAIL_SIDES` + `hasRoadOrRailEdge`
- [x] 缺口日志文案改为「无西向道路/铁路边」
- [x] `src/engine/rules/containers.ts`：`RoadOrRailEdgeQuery` + 形参 `hasRoadOrRail` + 文档
- [x] `src/stores/setup.ts` 与其余注释同步

## T3　断言（先红后绿）

- [x] 重命名 `tests/engine/shift-west-road.test.ts` → `shift-west-road-rail.test.ts`
- [x] 更新四编队路径断言（29 Mtr 第一步改走 `3.18`）
- [x] 新增「只连铁轨也算合法落点」：`8.8 → 7.8 → 6.7 → 5.8`，每步 `rail===true && road===undefined`
- [x] 运行：`npx vitest run tests/engine/shift-west-road-rail.test.ts tests/stores/formation-draw-at-setup.test.ts tests/stores/formation-draw-step.test.ts`

## T4　四编队重算与冲突核对

- [x] 重算表见 spec §3
- [x] 29 Mtr `1.19` / 12 Pz `1.26` / 7 Pz `12.24` 均未变化 ⇒ 无冲突
- [x] 4 Pz `8.8 → 5.8` 新路径单列

## T5　六门槛

```bash
npm run typecheck
npm run lint
npm run format:check
npx vitest run --maxWorkers=4
npm run arch
npm run build
```

- [x] 全绿后单独提交
- [x] 报告实数：423 文件、4932 通过、1 跳过、0 失败；build `dist/assets/index-B69G0bWT.js 2672.69 kB（gzip 575.58 kB）`
