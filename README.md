# matrix-bridge

把 DS Bot 的群聊实时镜像到 Matrix（tuxai.org），**每个 Bot 一个独立 Matrix 账号**，
所以 Element 里每条消息的发送者就是那个 Bot 本人。

当前阶段：**① 群聊 → Matrix 单向**已跑通。② Matrix → 群聊、③ E2EE 是后续两步。

## 它怎么工作

```
~/.dsh/bot/state.json ──只读──▶ matrix-bridge ──client-server API──▶ mx.tuxai.org
   (ds-bot 宿主写)               (本仓库，独立进程)                    (continuwuity)
```

- 宿主把群聊消息写进 `state.json` 的 `rooms[<组id>].log[]`，每条有单调递增的 `seq`，
  文件整体原子替换，所以第三方只读就能拿到全量状态，**不需要改 ds-bot、不需要动 profile**。
- 桥接监听 `state.json` 所在目录（`fs.watch`，80ms 去抖）+ 每 `pollMs`（默认 1500ms）轮询兜底。
- 每个群对应一个 Matrix 房间；每个 Bot 对应一个 Matrix 账号；映射与游标存在
  `state/bridge.json`（600，含 token），对外可查的账号清单在 `state/accounts.json`（不含 token）。
- 发送带确定性事务 id（`dsbot.<组id>.<seq>`），**只有服务器确认后才推进游标**：
  丢响应 / 重启 / 断线重连都不会重复发，也不会丢。

## 自动化行为（不写死任何映射）

| 宿主侧发生什么 | 桥接做什么 |
|---|---|
| 新建 Bot | 注册 `@<拼音slug>:tuxai.org`（重名加 `-2`），设显示名 = Bot 名，建独立 crypto 目录 |
| Bot 改名 | 改 profile 显示名 + 每个房间的 per-room 昵称；**账号 ID 不变** |
| 新建群聊 | 自动建房（房名 = 群名），邀请用户和各成员 Bot，成员 Bot 各自 join |
| 群成员变化 | 新成员 Bot 自动建号、邀请、join；退出的 Bot 保留 Matrix 历史 |
| 群被删除 | 在房间发一条 notice 说明，之后不再写入（房间与历史保留） |
| 长消息 | 从 `<ds-bot home>/group-lines/<组id>/<seq>.txt` 读全文再发 |
| 断线/重启 | 从 `state/bridge.json` 的游标续传，幂等重试 |

## 安装

```bash
cd ~/.dsh/bot/workspace/matrix-bridge
npm install                     # 只有一个依赖：pinyin-pro
cp .env.example .env && chmod 600 .env
# 编辑 .env，填 MATRIX_HOMESERVER_URL / MATRIX_USER_ID / MATRIX_REGISTRATION_TOKEN_FILE
```

`.env` 里的键：

| 键 | 说明 |
|---|---|
| `MATRIX_HOMESERVER_URL` | 例如 `https://mx.tuxai.org` |
| `MATRIX_USER_ID` | 被邀请进每个房间的用户，例如 `@yuanjing:tuxai.org` |
| `MATRIX_REGISTRATION_TOKEN_FILE` | 注册 token 的 600 文件路径（**token 本身不进 .env、不进仓库**） |
| `MATRIX_REGISTRATION_TOKEN` | 也可以直接给 token（优先级更高，不推荐） |
| `MATRIX_BRIDGE_POLL_MS` | 轮询间隔，默认 1500 |
| `MATRIX_BRIDGE_LOG` | JSONL 日志路径，默认 `logs/bridge.jsonl` |
| `DSH_BOT_STATE` | 宿主 state.json 路径，默认 `~/.dsh/bot/state.json` |

`config.json`（可选，不含凭据）：

```json
{
  "userDisplayName": "用户",
  "extraInvites": ["@verify-a:tuxai.org"],
  "pollMs": 1500,
  "encrypted": false,
  "onGroupDeleted": "notify",
  "registrationTokenFile": "/path/to/matrix_registration_token"
}
```

`extraInvites` 是每个自动建的房间都额外邀请的账号（验收观察账号，验收结束置空即可）。

## 运行

首次先空跑一遍，看会不会建号建房：

```bash
node src/index.js --once
cat state/accounts.json        # 每个 Bot 的 mxid / device_id / crypto store 路径
```

常驻（两种都行）：

```bash
# A. 前台/自己管
node src/index.js

# B. systemd 用户服务（推荐，开机自启、崩溃重启）
mkdir -p ~/.config/systemd/user
cp deploy/matrix-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now matrix-bridge
systemctl --user status matrix-bridge
```

重启（改配置、升级代码、轮换 token 之后都要）：

```bash
systemctl --user restart matrix-bridge     # systemd 方式
pkill -f 'matrix-bridge/src/index.js'      # 手管方式；然后重新 node src/index.js
```

**不需要重启 DS Bot**，也不需要动 `~/.dsh/profiles/web`：桥接只读宿主的团队文件。

## 日志（验收用）

`logs/bridge.jsonl`，一行一条 JSON：

| 字段 | 含义 |
|---|---|
| `t_recv_ds` | 宿主写入这条消息的时间（state.json 的 mtime，epoch ms） |
| `t_sent_mx` | 桥接发出请求的时间 |
| `t_ack_mx` | homeserver 确认的时间 |
| `event_id` | Matrix 事件 id |
| `group_id` / `room_id` / `seq` | DS 群、Matrix 房间、群内序号 |
| `latency_ms` | `t_ack_mx - t_recv_ds` |

其它事件：`room-created`、`room-renamed`、`room-gone`、`account-failed`、`send-failed`、`gap`、`started`/`stopped`。
正文不进日志。

## 边界与已知取舍

- **不登录 verify-a / verify-b**：验收账号由验收自己持 device，桥接只邀请、不代管。
- MVP 房间**不加密**（`encrypted: false`）：E2EE 是第③步，加密房间要么一开始就带
  `m.room.encryption` 建好，不能后补，所以开启开关前先确认验收房间另行准备。
- 用户自己在群里发的消息没有对应 Bot，由房间创建者（群管理员）代发，带
  `org.dsbot.from_user: true` 和 `用户:` 前缀。
- 群聊只镜像最近 60 条（宿主 `ROOM_LOG_MAX`）；桥接启动较晚而宿主已丢弃的老消息会记一条
  `gap` 日志并跳过。
- Bot 的私人会话（一对一）暂不镜像，等第②步反向同步时一起做。

## E2EE（第③步，设计已定，未实现）

- 每个 Bot 账号在 `state/crypto/<botId>/` 有独立 crypto store（建号时已创建目录，权限 0700），
  绝不复用 Dito 的 `~/.pi/agent/dito/matrix-crypto-store`。
- 设备验证流程要绕开 matrix-bot-sdk 0.8 的 `SignatureUpload` 直接 throw 的坑：自签
  cross-signing 时走 matrix-js-sdk 的 Rust crypto 或直接发 `/keys/signatures/upload`，
  不依赖 SDK 内部封装；设备在 Element 里用恢复密钥验证，验证前只读不清。
- 服务端 identity 私钥丢失会让历史消息永远解不开，所以 crypto store 要纳入备份
  （`state/crypto/` 与 `state/bridge.json` 一起备）。

## 测试

```bash
npm test     # 8 个用例，跑在本地 mock homeserver 上，不碰真服务器
```

覆盖：一人一号一房、顺序、重启不重发、丢响应重试幂等、新成员自动建号入房、改名不改 ID、
删群只通知一次、账号清单不含 token、长消息从文件读全文。

## 许可

本项目以 **GNU General Public License v3.0 或更新版本**（GPL-3.0-or-later）发布，全文见
[LICENSE](LICENSE)。你可以自由使用、修改和再分发；再分发衍生作品时须以同一许可开源，
并保留版权与许可声明。

## 参考与致谢

这个桥接没有直接复用下面这些项目的代码（加密部分只用了官方的 WASM 绑定，收发是手写的
client-server API），但设计上大量参考了它们的文档、源码和踩坑记录：

- [matrix-rust-sdk](https://github.com/matrix-org/matrix-rust-sdk)（Apache-2.0）——
  加密状态机 `OlmMachine` 的语义、`outgoingRequests` 请求泵模型、交叉签名流程，
  都是按它的实现和文档推的。
- [matrix-sdk-crypto-nodejs](https://github.com/matrix-org/matrix-rust-sdk/tree/main/bindings/matrix-sdk-crypto-nodejs)
  —— 最初选型用的原生绑定；它在 Node 上 napi/tokio 的崩溃行为（本机 Node 24/26 均复现）
  促成了改用 WASM 的路线。
- [matrix-sdk-crypto-wasm](https://www.npmjs.com/package/@matrix-org/matrix-sdk-crypto-wasm)
  （Apache-2.0）—— 当前实际使用的加密机（`OlmMachine` + IndexedDB 存储）。
- [matrix-bot-sdk](https://github.com/turt2live/matrix-bot-sdk)（MIT）—— 它的
  `SignatureUpload` 直 throw、设备永不被自签名的问题在网上有完整记录，帮我们提前避坑。
- [matrix-js-sdk](https://github.com/matrix-org/matrix-js-sdk)（Apache-2.0）—— 客户端
  侧对加密事件、未验证设备警告的呈现逻辑，验收标准是对着它定的。
- [continuwuity](https://continuwuity.org/) / [conduwuit](https://github.com/x86pup/conduwuit)
  —— 服务端行为参考：注册 token 的用法、创建者在 `power_levels` 里的隐式 100
  （显式列进 `users` 会让整条事件 403），都是照它的实现和实测结论来的。
- [pinyin-pro](https://github.com/zh-lx/pinyin-pro)（MIT）—— Bot 中文名转 Matrix localpart。
- [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB)（Apache-2.0）—— 让 WASM
  加密机在 Node 里拿到 IndexedDB 实现，再由桥接把内容落盘。
- [DS Bot / DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）——
  宿主侧 `state.json` 的结构（`rooms[].log[]`、单调 `seq`、原子替换）是本桥接唯一的
  输入来源；GUI 的 `/api/bot` 与启动 token 是反向注入的入口。
- [Element](https://github.com/element-hq/element-web)（AGPL-3.0）—— 作为验收时的
  参照客户端，用于核对发送者身份、未验证设备提示和加密事件展示。

如果你认为某处应当明确署名而没有写到，告诉我补上。
