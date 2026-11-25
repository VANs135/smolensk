# scripts/ 目录说明

这个目录混着三类东西，**它们的地位完全不同**，改数据/改构建前先看清自己在哪一类。

## 1. 在役 · 构建与门禁（会被 `npm run check` 或发版调用）

| 脚本                                      | 谁调用                                           | 干什么                                                                 |
| ----------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| `check-arch.mjs`                          | `npm run arch` / `check`                         | 架构扫描：规则字面量、CSS 变量、零调用导出、白名单过期                 |
| `arch-scan.mjs`                           | 被 `check-arch.mjs` 引用                         | 扫描实现（纯函数 + 白名单表）                                          |
| `check-tdz.mjs`                           | `npm run tdz` / `check`                          | 模块顶层暂时性死区（跨模块常量互引）                                   |
| `audit-clause-prefix.mjs`                 | `npm run audit:clauses`                          | 条款号前缀真实性（防编造规则号）                                       |
| `audit-error-text.mjs`                    | `npm run audit:error-text`                       | 失败码 → 文案映射完整性                                                |
| `port-tdz-audit.mjs`                      | `npm run audit:ports`                            | 端口/启动期依赖方向                                                    |
| `gen-counter-data.mjs`                    | `npm run gen:counters`（`check` 里带 `--check`） | 算子图 → 打包期 data URI（产物须与源一致）                             |
| `overwrite-guard.mjs`                     | 被 sync 脚本引用                                 | 挡「同步产物覆盖人手改过的文件」                                       |
| `sync-*.mjs`                              | 人手（改权威源之后）                             | 权威源 → `src/data                                                     | public` 生成物（units/counters/scenarios/map/…） |
| `pack-release.mjs`                        | `npm run pack`                                   | dist + 静态服务器 + 双击启动脚本 → `release/`                          |
| `serve-dist.mjs`                          | `npm run serve:dist`                             | 单文件零依赖静态服务器（也供探针复用）                                 |
| `probe-ui.mjs`                            | `npm run probe:ui`                               | UI 探针：开生产包、进对局、按需操作、截图（见 docs/开发文档.md §11.4） |
| `android-apk.mjs`                         | `npm run android:apk`                            | Capacitor 同步 + Gradle 出 APK                                         |
| `perf-compare.mjs`                        | `npm run perf:compare`                           | Web / 桌面壳同探针性能对照                                             |
| `migration-report.mjs`、`port-report.mjs` | 人手                                             | 一次性报表，输出给人看                                                 |

`*.d.mts` 是同名脚本的 TypeScript 声明（只为 `tests/scripts/*` 能类型化引用，模块本体是纯 JS）。

## 2. 一次性 · 数据导入历史（**不参与任何门禁**）

`sov_*_ocr.py`、`axis_*_ocr.py`、`counter_ocr.py`、`import_all_ocr.py`、`import_ocr_to_units.py`、
`artillery_import.py`、`hq_import.py`、`peek*.py`、`pixel_analyze.py`、`sample_imgs.py`、
`scan_tk_base.py`、`check_units*.py`、`check_sources.py`、`check_special.py`、`final_status.py`、
`fix_*.py`、`analyze_ocr.py` 等 `*.py`。

- 它们是**当初把规则书/算子扫描图转成 JSON** 的一次性工具，跑一次就完成使命；
- 依赖本机截图路径与 OCR 中间产物，**在别的机器上多半不可复现**；
- 保留只为可追溯（"这个字段怎么来的"还能翻到当时的脚本），**不要**把它们当在役数据流程；
- 真要重跑数据：改**权威源**，然后跑对应的 `sync-*.mjs`（见 `docs/数值修改指南.md`）。

## 3. 约定

- 新增在役脚本 → 在本文件第 1 节加一行；有纯函数就配 `tests/scripts/*.test.ts` + 同名 `.d.mts`。
- `scripts/**/*.mjs` 受 ESLint 约束（含「禁用 `Math.random`，随机走 `engine/rng.ts`」）。
- 脚本里不要写规则号字面量：会被 `audit:clauses` / `check-arch` 当作视图层规则判断。
