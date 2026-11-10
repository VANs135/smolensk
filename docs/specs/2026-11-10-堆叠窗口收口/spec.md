# 堆叠窗口收口（2026-11-10）

用户口径（按给定顺序，不跳）：

1. **列全**：左键堆叠窗列出该格**全部可见令牌**，不再按「本环节参与」或「战斗单位」筛选；
2. **默认全选**：摊开/开窗时，该格**本方全部可开拔算子**默认选中（地图扇面金环与窗内 chip 同一份
   `workbench.movePick`），点一枚取消、再点恢复；
3. **地图同格展开**：窗内提供「地图展开 / 收起展开」，对**同一格**在图上摊开/收起扇面，
   不换格、不关窗；
4. **删说明文字**：窗内只留算子、状态与操作按钮，删掉规则解释段落。

## 1. 现状与缺口

| 项       | 现状（HEAD 2b05e20）                                                                                                                                       | 缺口                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 列全     | `popupContent.units` 已是该格全部地面令牌；但组件 `visibleGroundUnits` 把本方非参与项滤掉、`combatUnits` 又把非战斗滤掉；`airUnits`、`blockedOwn` 从未渲染 | 窗口只看得见「敌方全部 + 本方参与中的战斗单位」 |
| 默认全选 | `expandStackAt` 依条 8 裁定把 `stackSelection` 置空（不预选）；chip 的默认选中只读 `movePick.ids`                                                          | 地图扇面无金环，与「默认全选」相反              |
| 同格展开 | 地图空闲点击会摊开（≥2 枚），但窗内没有对应的展开入口；摊开与否无法从窗内控制                                                                              | 窗内无法「就地展开这一格」                      |
| 说明文字 | 9.14 / 整备块仍留规则解释段落                                                                                                                              | 与「窗内不写说明」冲突                          |

## 2. 落地

### 2.1 store（`src/stores/map-view.ts`）

`expandStackAt(hex)`：

- 传给 `beginMovePick` 的候选集改为**该格本方地面令牌**（排除飞机、本阶段已结束移动者）；
  池过滤仍由 `movePickPoolAt` 负责，敌方 / 补员 / 编内卡车不会进入 `movePick`；
- `stackSelection = defaultSelectionOf(workbench.movePick?.ids ?? [])` ⇒ 恢复**默认全选**；
- 该格没有本方算子时 `movePick = null`，`stackSelection = []`（没有可选对象）。

### 2.2 组件（`src/components/game/MapActionPopover.vue`）

- 删除 `visibleGroundUnits` / `combatUnits` 两层过滤，改为 `stackUnits = popupContent.units`；
  同格飞机用 `popupContent.airUnits` 单列（只读）。
- chip 可点选的条件收窄为「本窗就是取子格（6.1）且该枚在 `movePickChoices` 里」；
  其余 chip 照列、不可点、不显示选中态。
- 新增「地图展开 / 收起展开」按钮：读 `mapView.isStackExpanded(hex)`，调
  `mapView.expandStackAt(hex)` / `mapView.collapseStack()`；只作用于窗内那一格。
- 删掉窗内规则解释段落（9.14 的静态说明、整备的容量/费用说明与「本格没有非激活飞机」），
  保留状态回执与操作按钮。

## 3. 验收断言

1. `expandStackAt` 后 `stackSelection` ＝ 该格全部本方可开拔算子（默认全选）；
2. 同格敌方算子不进 `stackSelection`，也不进 `movePick`；
3. 组件源码不再按 `actionableOwnIds` / 战斗单位过滤（列全）；
4. 窗内有「地图展开」入口并调用 `expandStackAt` / `collapseStack`（同格展开）；
5. 窗内不再出现规则解释段落（删说明文字）。

先红后绿；六门槛后单独提交。
