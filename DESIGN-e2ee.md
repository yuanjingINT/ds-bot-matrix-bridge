# E2EE 设计（第 ③ 步）

目标：群聊对应的 Matrix 房间开 `m.megolm.v1.aes-sha2`，每个 Bot 的账号是一个独立设备，设备可被主人验证，重启后密钥不丢。

## 已核实的既有事实（不是猜测）

1. **`matrix-bot-sdk` 0.8 的 `RustEngine` 对 `RequestType.SignatureUpload` 直接抛**：
   `lib/e2ee/RustEngine.js` 里 `case 4: throw new Error("Bindings error: Backup feature not possible")`。
   同一处 `case 6 KeysBackup` 也抛。这就是「设备永远验不过」的根因。
2. **bot-sdk 0.8 没有 cross-signing API**：`RustEngine` 里没有 `bootstrapCrossSigning`，identity keys 归 Rust machine 所有但没暴露。所以「让 SDK 自己完成设备验证」这条路不存在。
3. **`matrix-js-sdk` 45 在 Node 里没有持久化 crypto store**：`initRustCrypto({useIndexedDB})` 只支持 IndexedDB（浏览器）或纯内存；Node 侧没有文件存储选项。用它就意味着每次重启设备身份全换，验过的设备天天掉。
4. **原生库可装**：`@matrix-org/matrix-sdk-crypto-nodejs@0.4.0` 的 `matrix-sdk-crypto.linux-x64-gnu.node`（22 MB）从
   `https://gh-proxy.com/https://github.com/.../releases/download/v0.4.0/...` 取得，`require()` 加载正常（本机 node 26.13 实测）。
   GitHub 直连会卡死，`ghfast.top` 也不通，`gh-proxy.com` 通。
5. **continuwuity 的媒体上传只在旧路径**：`/_matrix/media/v3/upload` 可用，`/_matrix/client/v1/media/upload` 返回 `M_UNRECOGNIZED`。（非 E2EE，但同一个服务端的脾气。）

## 架构：自带 HTTP 客户端 + 只借 Rust machine

不用 bot-sdk 的 `MatrixClient`（它把 sync/加解密/请求泵绑在一起，且带着上面两个 bug），只借两样：

```
src/matrix.js        ← 现有的 fetch 客户端，负责 /sync、发送、media
src/crypto.js（新）  ← RustSdkCryptoStorageProvider + OlmMachine + 自己的请求泵
```

请求泵按 `machine.outgoingRequests()` 的类型自己发：

| 类型 | 我们做什么 |
| --- | --- |
| 0 `KeysUpload` | `POST /keys/upload` |
| 1 `KeysQuery` | `POST /keys/query` |
| 2 `KeysClaim` | `POST /keys/claim` |
| 3 `ToDevice` | `PUT /sendToDevice/{type}/{txn}` |
| 4 `SignatureUpload` | **记录并跳过**（见下：签名由我们自己的验证流程上传，不经过 machine） |
| 5 `RoomMessage` / 6 `KeysBackup` | 记录并跳过（本桥接不需要服务端备份） |

这样绕开 bot-sdk 那个 `throw`：我们不是给 bug 打补丁，而是根本不走那条分支，签名由下面独立的验证流程负责。

收发一侧：
- 发：`machine.encryptRoomEvent(roomId, 'm.room.message', content)` → `sendMessage` 带 `m.room.encrypted`。
- 收：`machine.decryptRoomEvent(event)`，失败（缺 megolm session / 没通过设备信任）就记 `decrypt-failed` 并**不推进该事件的 handled 标记**，等 key 到了再解。

## 设备验证流程（三步，全部在桥接自己的工具里）

每个 Bot 一个设备、一个 store（`state/crypto/<botId>`），验证靠**服务端签名链**，不靠 SDK：

1. **生成身份密钥**：用 node 的 `ed25519` 生成三对（master / self_signing / user_signing），
   private key 存 `state/crypto/<botId>/identity.json`（0600），public key 用 unpadded base64。
2. **上传身份**：`POST /_matrix/client/v3/keys/device_signing/upload`，
   带 `master_key` / `self_signing_key` / `user_signing_key`，UIA 用账号自己的密码认证
   （`m.login.password`，bot 账号的密码在 `state/bridge.json` 里，注册时随机生成并保存）。
3. **签设备 + 上传签名**：
   - 取当前设备 keys（`GET /keys/query` 里 `device_keys[userId][deviceId]`）；
   - 用 self_signing 私钥签 `{user_id, device_id, keys}`，用 master 私钥签 self_signing 公钥；
   - `POST /_matrix/client/v3/keys/signatures/upload`，body 直接是 `{userId: {deviceId: signedDeviceKeys}}`
     （Synapse 不认 `signed_keys` 包装，会 200 但 `failures` 里报；continuwuity 同样按裸格式验）。
4. **自检**：重新 `GET /keys/query`，确认设备 key 的 `signatures` 里有 self_signing 的签名，
   并且 self_signing key 的 `signatures` 里有 master 的签名 → 验证链完整，Element 里显示为已验证。

主人 `@yuanjing:tuxai.org` 与每个 Bot 设备之间：设备被自己的身份签名后，Element 侧不再提示未验证；
跨用户验证（主人签 Bot，或 Bot 签主人设备）不自动做，需要时用 `user_signing` 走一遍同样的签名上传。

**幽灵 identity 的坑**：如果服务端已经有 identity 的公钥而私钥不在我们手上（Dito 的旧 store 就是这样），
新的私钥上传会 `M_FORBIDDEN`/冲突，且旧 key 永远解不开。所以：
- 只在拿到账号密码、且 `keys/query` 显示该账号**没有** master_key 时上传身份；
- 已有 master_key 且不是我们这份 → 记 `identity-conflict` 并人工介入（重新建账号最干净），绝不覆盖。

## 落地顺序

1. `src/crypto.js`：machine + 持久化 store + 请求泵（可单测：mock homeserver 走一遍 keys/upload → query → claim）。
2. 收发接入：`sync.js` 里对 `encrypted` 房间走加解密；`config.json` 的 `encrypted: true` 只对新房生效。
3. `scripts/device-verify.mjs`：对单个 Bot 或全部 Bot 跑上面的验证流程，输出每台设备的签名链状态。
4. 验收点：Element 里设备显示「已验证」；Bot 重启后 `state/crypto/<botId>` 复用，设备 ID 不变、签名仍有效；旧消息（Bot 上线前的密文）解不开是预期行为，README 里写明。

## 风险

- **Rust machine 与我们自签的身份不是同一套**：machine 的 device keys 由 machine 生成，我们的 self_signing 只签服务端看到的那份 device keys。如果 machine 在启动时因为 `SignatureUpload`/`KeysUpload` 的顺序问题重新生成了 device keys，签名就失效 → 每次启动后跑一次自检，签名不在就重签。
- **continuwuity 的 `/keys/*` 行为**要和 Synapse 区分验证：先跑 `scripts/device-verify.mjs --dry-run` 记录服务端返回。
- **不给 bot 开服务端密钥备份**（case 6 跳过），所以换设备等于丢历史密文；这是可接受的取舍，写进 README。
