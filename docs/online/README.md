# 双人联机（页面侧）

## 当前形态

第一版是**远程热座 + 全量状态复制**：

- 房间在**选剧本前**建立：开始台先建房，房主随后选剧本、完成初设；对方可提前加入等待；
- 房间分两阶段：`lobby` 只带协议/数据版本与已选剧本，`game` 才带完整对局状态；
- 每个客户端固定一个阵营（`online.mySide`）；`game` 阶段 `hotseat.viewerSide` 被锁住。
  `lobby` 阶段房主独自完成双方初设，视角跟布设游标走，不锁本人阵营（否则执轴心时无人能布苏联）；
- 房间只存一份完整对局状态，包含会话记录轨、日志、RNG 游标、盘面、初设进度、
  战斗/轰炸现场与输入。守方因此能在自己的设备上完成 AR/地形/损失/撤退选择；
- 房间写入用 `seq` 做 CAS（`UPDATE ... WHERE seq = ?` 语义），轮询读取；
- **房间恒为 PVP 外壳**：新建 `lobby` 不复制本机任何旧盘面/会话；进入 `game` 的状态强制 `pvp`、
  `aiSide=null`，避免把双面可见或 AI 接管带进联机房间；
- **不是本方写入窗口时只读**：隐藏「进入下一环节」、收起地图会话/超堆叠/补给/初设队列，
  左栏盒只列本阵营 + 共用盒；待答问题只有应答方能选项；
- **不做服务端反作弊**：玩家可信，服务端只存储不透明 JSON。用户 2026-11-27 明确接受这一前提。

## 两种通道

### 1. 本机双标签（默认，无后端）

未设置 `VITE_ONLINE_ROOM_URL` 时使用 `LocalRoomTransport`：房间行写进 `localStorage`，
同一浏览器两个标签共享。用于验收“各看各的阵营、各自点自己的战斗步骤”。

这**不是跨设备联机**；主页/棋桌会显示“本机双标签”。

### 2. HTTP 中继（跨设备）

部署 `server/online-room-relay.mjs`：

```bash
PORT=8787 ROOMS_FILE=/var/lib/ocs-online/rooms.json node server/online-room-relay.mjs
```

用 HTTPS 反向代理暴露该端口（静态站点是 HTTPS，浏览器不允许 HTTPS 页面请求 HTTP 中继），
构建时注入地址：

```bash
VITE_ONLINE_ROOM_URL=https://rooms.example.com npm run build
```

也可以给中继直接配证书：

```bash
TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem node server/online-room-relay.mjs
```

中继只提供：

- `POST /rooms`：创建房间（返回 `code` / `token` / `seq` / `state`）
- `GET /rooms/:code` + `x-room-token`：读取最新房间
- `PUT /rooms/:code` + `x-room-token` + `If-Match: <seq>`：CAS 写入；冲突返回 `409 { latest }`

`server/online-rooms.json` 是本地房间表，已加入 `.gitignore`；生产建议挂持久卷。

## 使用流程

1. 主机在开始台点「创建联机对局」→ 选自己执的阵营 → 创建房间（此时还是 `lobby`）；
2. 主机复制邀请链接发给对方，然后进入选剧本；初设由主机独自完成**双方**，客人可先加入等待；
3. 主机开局后，同一房间从 `lobby` 转成 `game`，客人自动进入棋桌；
4. 双方各自只看到自己阵营、自己的盒与本方可见信息；进入 `game` 后切视角入口收起。

## 已知边界

- 房间在**选剧本前**创建，但初设仍由房主单机完成，且要由房主独自布完双方；客人在 `lobby`
  只占座等待，不参与初设。初设期间房主视角跟布设游标走，开局后才锁回本人阵营。
- 联机 PVP 只列可双人推进的常规剧本；单回合 `1 player turn` 的 Intro 不进入联机列表。
- 双方必须使用**同一构建 / 同一 `DATA_VERSION`**；协议头不匹配会拒收。
- 全量状态复制是可信对局方案，不是排位/防作弊方案；客户端能读到自己的完整状态（包含对方算子数据），
  战雾只是显示层。用户已接受该边界。
- 房间不保存历史版本；最新状态在房间行里。刷新/断线后重新加入可继续，但当前页面还没有
  “自动恢复上次房间”的会话持久化，刷新后需重新加入。
