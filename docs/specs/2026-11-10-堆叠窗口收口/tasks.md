# 任务清单（堆叠窗口收口 + 右键体系）

- [x] T1 红测：`tests/stores/popup-stack-selection.test.ts` 增补（默认全选 / 敌我不串 / 列全 / 自动摊开 / 切格收起 / 删说明），先红
- [x] T2 `map-view.ts`：`expandStackAt` 候选集改全格地面令牌、`stackSelection` 默认全选
- [x] T3 `MapActionPopover.vue`：列全（含飞机）、chip 可点条件、删说明文字
- [x] T4 删「地图展开 / 收起展开」按钮；改为点己方堆叠自动摊开、切格 / 关窗 / 取消即收起
- [x] T5 右键体系：地图右键敌方堆叠 → 低空扫射（14.7d）；窗内右键该单位；`App.vue` 拦图片原生右键
- [x] T6 六门槛（typecheck / lint / format / vitest / arch / build）
- [x] T7 单独提交并报实数
