# OCS 斯摩棱斯克 · 电子裁判台

OCS《斯摩棱斯克》（Smolensk: Barbarossa Derailed, OCS #17）的兵棋推演程序：掷骰、查表、路径与补给追溯、状态记录交由引擎完成，玩家只做决策与反应。

- 规则底本：OCS 系列规则 v4.3 + Smolensk 专规 Living Rules 1.1
- 对局形态：单地图、19 回合（1941/7/8–9/8），双人同机热坐
- 生产形态：纯静态前端，无后端

## 快速开始

```bash
npm ci          # 按 package-lock.json 安装依赖
npm run dev     # 开发服务器 http://127.0.0.1:5173
npm run build   # 构建到 dist/
npm run check   # 门禁：lint → format:check → typecheck → test → arch
```

打包发布（dist + 静态服务器 + 双击启动脚本）：

```bash
npm run pack
npm run serve:dist
```

## 安卓安装包（触摸屏）

盘面是手机/平板上"摊开看"的东西，故提供安卓壳：Capacitor 包一层 WebView，
产物是可直接侧载的 `release/SmolenskOCS-v<版本>-android.apk`。

```bash
npm run android:apk     # build → cap sync → gradle assembleRelease → 搬到 release/
```

首次构建需要本机具备 **JDK 21** 与 **Android SDK**（`platforms;android-35` +
`build-tools;35.0.0`）。JDK 必须是 21：`@capacitor/android` 7.6 的库以 Java 21 编译，
17 会在编译期报「无效源发行版: 21」：

```bash
export JAVA_HOME=<jdk21 目录>
export ANDROID_HOME=<android sdk 目录>
# 也可写进 android/local.properties：sdk.dir=<android sdk 目录>（该文件不入库）
```

签名用本地自签密钥 `android/keystore/ocs-release.jks`（口令在
`android/keystore.properties`，两者都**不入库**）。换机器打包时这两样要一起带走，
否则签名不一致，只能卸载重装——而卸载会连同 WebView 域里的存档一起清掉。

桌面端不受影响：`src-tauri/` 原样保留，`npm run tauri:build` 仍出 Windows 安装包；
网页端就是 `npm run build` 出来的 `dist/`。三端共用同一份前端产物。

触摸端与鼠标端的差异（同一套代码、按 `pointer` 类型分派）：

| 操作         | 鼠标 / 桌面 | 触摸屏                                  |
| ------------ | ----------- | --------------------------------------- |
| 打开单位菜单 | 右键        | **长按 500ms**                          |
| 地图缩放     | 滚轮        | **双指捏合**（同时可拖）                |
| 平移地图     | 左键拖动    | 单指拖动                                |
| 控件命中区   | 36 / 28px   | 46 / 36px（`@media (pointer: coarse)`） |

实现落点：`src/shared/long-press.ts`（长按判定与 `v-long-press` 指令）、
`src/render/viewport.ts#pinchViewport`（捏合几何）、`src/components/map/MapCanvas.vue`
（地图侧接线）、`src/styles/base.css` 与 `src/styles/tokens.css`（触摸基线）。

## 技术栈

TypeScript（strict）· Vue 3（组合式 API）· Vite · Pinia · Canvas 2D 自绘 · Zod · Vitest。

依赖方向固定为 `components/views → stores → engine`，`render/` 只读引擎输出；`engine/` 不引 Vue/Pinia/DOM，随机一律走 `engine/rng.ts`（种子可重放）。完整约定见 [CODE_SPEC.md](CODE_SPEC.md)。

## 目录

```
src/engine/   规则内核（纯 TS）
src/data/     JSON 数据 + Zod schema + 唯一加载入口
src/render/   Canvas 绘制与命中检测
src/stores/   Pinia 状态与投影
src/components/  Vue 组件
src/views/    布局视图
public/       地图、算子图档、字体等运行时素材
scripts/      数据同步/校验、发布打包、静态服务器
tests/        引擎规则用例、数据校验、固定种子整局回归
docs/         方案、清单与修改记录
```

**第一次接触本项目，先读 [开发文档](docs/开发文档.md)**：环境搭建、架构地图、一次点击的完整链路、规则改动 SOP、测试与门禁、存档兼容、构建发版（含安卓）都在那里。

改动前先看 [docs/程序目录与清单.md](docs/程序目录与清单.md)（功能落点）与 [docs/数值修改指南.md](docs/数值修改指南.md)（数值落点）。

后续重构顺序、已知缺口及每批验收条件见 [重构计划（已归档）](docs/archive/重构计划.md)。

模块职责、状态所有权与性能优化依据见 [解耦与优化方案（已归档）](docs/archive/解耦与优化方案.md)。

## 仓库口径

以下内容**不入库**：

- `backup/`：手工备份，须逐字节保持原样
- `dist/`、`release/`、`node_modules/`、`coverage/`：构建与依赖产物
- `.env.local` / `.env.*.local`：本地环境覆盖

素材（地图扫描、算子图）版权归原作出版方所有，仅用于本机推演，请勿再分发。
