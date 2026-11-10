# 西移判据并入铁路（Batch B）— 规格

日期：2026-11-10　状态：已实施　范围：Batch B（`road ∪ rail`）

## 0. 裁定与目标

用户 2026-11-10 裁定：**铁路和道路都算「路」**。ch10「抽中的师须沿道路向所列位置西移三格」的判据，从「只认 `edges.road`」改为「道路类边 ∪ 铁路边」。

**纪律**：先红后绿、单独提交、报实数、不放宽判据；落点若与已确认值冲突先报、不直接改。

---

## 1. 地图边类别盘点（`src/data/map-layers.json`，实测）

边总数 **1547**。schema（[map-layers.schema.ts](../../../src/data/schema/map-layers.schema.ts)）只允许以下字段：

| 字段         | 取值                       | 边数          | 含义                                          |
| ------------ | -------------------------- | ------------- | --------------------------------------------- |
| `road`       | `secondary`                | 236           | 二级路                                        |
| `road`       | `track`                    | 356           | 土路                                          |
| `rail`       | `true`                     | 360           | 铁路（轨距为全局值，专规 1.2）                |
| `multiTrack` | `true`                     | 125           | 多轨铁路（仅 `rail: true` 的边可带）          |
| `river`      | `minor` / `major` / `lake` | 688 / 92 / 24 | 河 / 大河 / 湖（湖＝禁入）                    |
| `bridge`     | `true`                     | 73            | 桥（均同时有 `river`，且带 `road` 或 `rail`） |
| `offMapStub` | `true`                     | 36            | 至少一端在图外（引擎不得作为可进入边）        |

> **数据里没有 `primary`。** 本作道路只有 `secondary` / `track` 两级；`primary` 仅出现在口头描述中，未落库，不能作为判据。

### 1.1 归类：算路 / 不算路

| 组合                                  |    边数 | 归类                   | 依据                                                                  |
| ------------------------------------- | ------: | ---------------------- | --------------------------------------------------------------------- |
| `road` 存在（`secondary` 或 `track`） |     592 | **算路**               | 用户裁定「道路算路」                                                  |
| `rail: true`                          |     360 | **算路**               | 用户裁定「铁路也算路」                                                |
| `road` 且 `rail`                      |     136 | **算路**               | 并集（上述两类重叠）                                                  |
| 仅 `road`                             |     456 | **算路**               | —                                                                     |
| 仅 `rail`                             |     224 | **算路**               | —                                                                     |
| **并集合计**                          | **816** | **算路**               | 592 + 360 − 136                                                       |
| 仅 `river`（无 `road`/`rail`）        |     731 | **不算路**             | 河/湖本身不是路                                                       |
| `bridge: true` 但无 `road`/`rail`     |       0 | —                      | 本作不存在这种边                                                      |
| `offMapStub: true`                    |      36 | **不算路（移动判据）** | 至少一端在图外；西移目标必须 `isOnMap`，两端都在图内的 stub 边为 0 条 |

补充实测：`multiTrack` 全部依附于 `rail: true`（0 条例外）；`offMapStub` 中含 `road` 15 条、`rail` 5 条、两者兼有 1 条，但**没有一条两端都在图内**，故西移不会用到 stub 边。

**落地判据**：`edge.road !== undefined || edge.rail === true`。

---

## 2. 代码变更

| 位置                                                                           | 变更                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [containers.ts](../../../src/stores/containers.ts) `ROAD_OR_RAIL_SIDES`        | 过滤条件改为 `edge.road !== undefined \|\| edge.rail === true`                       |
| 同文件 `hasRoadOrRailEdge`                                                     | 原 `hasRoadEdge` 改名，语义改为并集                                                  |
| 同文件 `shiftWestDestination(anchor, steps, hasRoadOrRailEdge)`                | 接线改用新谓词；缺口日志改「无西向道路/铁路边」                                      |
| [containers.ts](../../../src/engine/rules/containers.ts) `RoadOrRailEdgeQuery` | 原 `RoadEdgeQuery` 改名；`shiftWestDestination` 形参改 `hasRoadOrRail`，文档注明并集 |
| [setup.ts](../../../src/stores/setup.ts)                                       | 注释同步「道路/铁路边」                                                              |

引擎算法本身不变：每步只取 `SW → NW`，须 `isOnMap` 且该格边满足谓词；走不满 N 格即 `exact=false`，原地不动。

---

## 3. 四编队重算（起始格 → 落点 → 每步边类型 → 是否合法）

起点取剧本 1 初设：29 Mtr `4.18`、12 Pz `4.25`、7 Pz `15.25`、4 Pz `8.08`；步数 3。

| 编队       | 起点  | 逐步（方向・边类型）                                                  | 落点      | 合法         | 与已确认值           |
| ---------- | ----- | --------------------------------------------------------------------- | --------- | ------------ | -------------------- |
| 29 Mtr Div | 4.18  | SW・`rail`(multi) → SW・`rail`(multi) → NW・`secondary`+`rail`(multi) | **1.19**  | `exact=true` | **不变**             |
| 12 Pz Div  | 4.25  | SW・`secondary` → NW・`secondary` → NW・`secondary`                   | **1.26**  | `exact=true` | **不变**             |
| 7 Pz Div   | 15.25 | SW・`track` → SW・`track` → NW・`track`                               | **12.24** | `exact=true` | **不变**             |
| 4 Pz Div   | 8.08  | SW・`rail`(multi) → SW・`rail`(multi) → NW・`rail`(multi)             | **5.8**   | `exact=true` | **由不可动变为可动** |

**冲突结论**：29 Mtr / 12 Pz / 7 Pz 三个已确认落点**均未变化**，无需重新点头。  
**4 Pz 新路径（单列）**：`8.08 → 7.8 → 6.7 → 5.8`，三步全部走多轨铁路（`rail: true, multiTrack: true`，`road` 缺省），是纯铁路链。

> 29 Mtr 的第一步由旧判据的 `4.18 → 3.19`（二级路）变为 `4.18 → 3.18`（铁路），但终点仍为 `1.19`；落点不变，仅路径不同。

---

## 4. 断言（`tests/engine/shift-west-road-rail.test.ts`）

1. `4.18 → 3.18 → 2.18 → 1.19`，`exact=true`，每步满足并集谓词。
2. `4.25 → 3.25 → 2.25 → 1.26`、`15.25 → 14.24 → 13.24 → 12.24`，均 `exact=true`。
3. **★ 只连铁轨也算合法落点**：`8.8 → 7.8 → 6.7 → 5.8`，每步边的 `rail===true` 且 `road===undefined`。
4. 只走 `SW`/`NW`（列必须 −1）。
5. 边链中途断掉 ⇒ 停在最后一格，`exact=false`（不放宽为几何回退）。

---

## 5. 待裁定（沿用，不因本批改变）

- Q-A1 / Q-A2 仍待用户按 9.10a / 9.10c / 9.12 / 9.12e / 8.1 原文裁定；本批只改西移边集合，不触碰战斗结算口径。
