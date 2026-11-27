# 双人联机（大厅版）

## 当前形态

远程热座 + 全量状态复制，外加一层**公开大厅 + 房间密码**：

- 玩家在大厅先设置自己的显示 ID；房主再设置房间名、房间密码与阵营建房；
- 大厅列表只公开房名、房主/客人 ID、人数、阶段与剧本，**不显示密码或写房令牌**；
- 加入者在大厅选房间、输入房主私下分享的密码，服务端校验后才下发写房令牌；
- 每间房固定两人；房主离开会关闭房间，客人离开会释放座位；超过 TTL 未活动的房间自动清理；
- 邀请链接只带房间号（`#online=CODE`），**不再带房钥**；打开链接后仍要输密码，避免链接绕过密码。

## 对局协议（房间内容）

房间分三阶段：

- `lobby`：只带协议/数据版本与已选剧本；房主此时去选剧本；
- `setup`：带完整初设现场但 `session.session=null`；双方各自布设本方，按
  `setup.setupSideCursor` 交棒，当前布设方才能写；
- `game`：双方完成初设并开局，房间带完整对局状态。

每个客户端固定一个阵营（`online.mySide`），`setup` / `game` 阶段
`hotseat.viewerSide` 都会被锁住。房间只存一份完整状态，写入用 `seq` CAS、读取用轮询；
**不做服务端反作弊**：玩家可信，服务端只存不透明 JSON。

房间恒为 PVP 外壳：新建 `lobby` 不复制本机旧盘面/会话；进入 `setup` / `game`
强制 `pvp`、`aiSide=null`。

先手判定确认窗仍覆盖每回合 2.3：双方 2d6 骰面、点数、重掷次数与胜者选择先手/后手。
首回合先手由剧本指定，不掷骰。

## 两种通道

### 1. 本机双标签（默认，无后端）

未设置 `VITE_ONLINE_ROOM_URL` 时使用 `LocalRoomTransport`：房间行写进 `localStorage`，
同一浏览器两个标签共享。大厅/密码流程同样可用，但密码只存在本机存储里，不是安全边界。
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

中继接口：

- `GET /rooms`：大厅列表；只返回公开摘要；
- `POST /rooms`：创建房间，body 含 `name` / `password` / `hostId` / `hostSide` / `state` /
  `stateHash`；服务端用 scrypt 存密码哈希，返回带令牌的完整房间行；
- `POST /rooms/:code/join`：body 含 `password` / `playerId`；校验密码后下发令牌；
- `GET /rooms/:code` + `x-room-token`：读取最新房间；
- `PUT /rooms/:code` + `x-room-token` + `If-Match: <seq>`：CAS 写入；冲突返回
  `409 { latest }`；
- `POST /rooms/:code/leave`：body 含 `password` / `playerId`；房主离开删房，客人离开释放座位；
- `GET /health`：存活与房间数。

`server/online-rooms.json` 是本地房间表，已加入 `.gitignore`；生产建议挂持久卷。
密码不落明文；服务端只保存 `passwordSalt` / `passwordHash`，任何列表/读取接口都不返回它们。
同一 IP 连续输错密码会触发短时 429；反向代理部署时按 `x-forwarded-for` 识别客户端。

## 使用流程

1. 开始台点「联机大厅」；
2. 设置自己的显示 ID；
3. 房主填房间名、房间密码、选自己执的阵营，点「创建房间并选剧本」；
4. 房主进入选剧本页；客人刷新大厅，选中房名、输入密码加入；
5. 房主选剧本并进入初设；房间转 `setup`，客人自动进入棋桌；
6. 初设按剧本的先后手交棒：轮到苏联时客人布苏联，轮到轴心时房主布轴心；当前方点「确认」
   后自动交给下一位。等待方只读，但能看到“某某正在初设”；
7. 两方确认后游标归空：房主面板显示「完成初设」，客人显示“等待房主开局”。房主收束后，
   同一房间从 `setup` 转成 `game`，客人自动进入对局；
8. 双方各自只看到自己阵营、自己的盒与本方可见信息；进入 `setup` / `game` 后切视角入口收起。

## 已知边界

- 初设必须由两位玩家各自完成本方，不能由一人替对方落子；当前布设方未确认时，另一方只读等待。
- 联机 PVP 只列可双人推进的常规剧本；单回合 `1 player turn` 的 Intro 不进入联机列表。
- 先手判定窗只覆盖需要掷骰的常规回合（2.3）；首回合先手由剧本指定、不掷骰。
- 双方必须使用**同一构建 / 同一 `DATA_VERSION`**；协议头不匹配会拒收。
- 全量状态复制是可信对局方案，不是排位/防作弊方案；客户端能读到自己的完整状态（包含对方算子数据），
  战雾只是显示层。用户已接受该边界。
- 房间不保存历史版本；最新状态在房间行里。刷新/断线后可用同一 ID + 密码重连，但当前页面还没有
  “自动恢复上次房间”的会话持久化，刷新后需重新进入大厅加入。
- 房主关闭浏览器而没有点「离开房间」时，房间会保留到 TTL（默认 24h）或房主下次用同一 ID + 密码重连后关闭。
