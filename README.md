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

改动前先看 [docs/程序目录与清单.md](docs/程序目录与清单.md)（功能落点）与 [docs/数值修改指南.md](docs/数值修改指南.md)（数值落点）。

## 仓库口径

以下内容**不入库**：

- `backup/`：手工备份，须逐字节保持原样
- `dist/`、`release/`、`node_modules/`、`coverage/`：构建与依赖产物
- `.env.local` / `.env.*.local`：本地环境覆盖

素材（地图扫描、算子图）版权归原作出版方所有，仅用于本机推演，请勿再分发。
