# Host Projection

`host-projection.mjs` 把 **Live2D 面对面主界面**（`/`）、Coo 原版 `/pet` 页面、`/socket`、TTS 音频和 `/services` 服务目录投影到浏览器，并且可以经 SSH 隧道落到远端设备的本地服务上。

## 运行

```powershell
node tools/sync-face-assets.mjs   # 首次：从 Coo 复制 Live2D 图包/kit/转换器
node tools/host-projection.mjs
```

默认读取 gitignored 的 `tools/host-projection.local.json`（存在时），否则读 `host-projection.example.json`；也可用 `SOLVER_PROJECTION_CONFIG` 指定。

## 面对面界面：两个投影

- `/` = **第一界面：Cortico 对话**。只有消息、输入框、麦克风；不投影任何设置键（模型、TTS/ASR、导入都在主机侧）。顶部「人物」小入口跳到 `/figure`（视图切换，不是设置）。
- `/figure` = **第二界面：Live2D 人物**。一个按键都没有，自己收表情指令与 TTS 音频并播放。
- 两者共用同一个桥：SSE 下行 `/face/events`、HTTPS 上行 `/face/say`、语音 `/face/asr`，接同一个 Cortico/Coo Persona。
- 协议只有一份实现；两页用 `?role=chat|figure` 声明订阅：对话页只收消息，人物页收表情与语音，且**同一时刻只有一个**人物页拿到音频（多开不回声，关掉后自动顺延）。
- 渲染复用 Coo 图包（Cubism Core + `backends/live2d.js` + `kit/body.js`），同源、非 iframe，因此 HTTPS 下能正常出图。
- 桌宠兼容：`/pet`、`/coo/pet`、`/socket` 原样保留。
- 可选的桌面悬浮窗（透明/无边框/置顶/穿透）：`node tools/face-window.mjs`；**主线仍是网页**。
- 一键导入走 API（`POST /face/models/import-path`），前端不再有入口。

## HTTPS 为主

- 默认同时监听 HTTP `18111` 与 HTTPS `18112`；非 loopback 的 HTTP 请求一律 `308` 跳到 HTTPS（本机/tailscale serve 等 loopback 调用不受限）。
- 没有证书时用 OpenSSL 自动生成自签证书到 `tools/certs/`（已 gitignore）；证书/端口可用配置 `tls` 块或环境变量覆盖。
- 用 `SOLVER_PROJECTION_HTTPS=0` 可关闭 HTTPS（仅调试）。
- 手机浏览器要用麦克风必须走 HTTPS。
- **手机连不上/SSE 断**多半是自签证书不受信：用 tailnet 域名（有效证书），或把证书装进手机。临时排查可设 `SOLVER_PROJECTION_ALLOW_HTTP=1`（或配置 `tls.redirectHttp: false`）让局域网走明文 HTTP——SSE 能用，但麦克风会被浏览器禁用。

## 网络：局域网直连 + Tailscale 广播

- **局域网直连**：同网设备直接访问 `https://<局域网IP>:18112`（自签证书），或直接访问 HTTP `18111`。
- **Tailscale 广播**：先跑投影服务，再 `node tools/tailscale-broadcast.mjs`，在 tailnet 内用有效证书访问 `https://<machine>.<tailnet>.ts.net/`。用 `--status` 查看、`--reset` 撤销。
- **SSH**：`device.host` 可填局域网 IP、`100.x` Tailscale IP 或 MagicDNS 名；两条路都走同一套 SSH。
- `/api/device` 会报告检测到的 Tailscale 名称与 IP。

## SSH 设备

配置 `device` 块后，投影服务用 `ssh -L` 把设备本地的 Coo/Cortico/ASR/TTS/LLM 端口转发到本机，再把上游地址改指到隧道端口；浏览器仍然只连投影服务的 HTTPS。

```json
"device": {
  "enabled": true,
  "host": "192.168.1.166",
  "port": 22,
  "user": "your-ssh-user",
  "identityFile": "C:/Users/you/.ssh/id_ed25519",
  "knownHostsFile": "C:/Users/you/.ssh/known_hosts",
  "strictHostKeyChecking": "yes",
  "tunnels": { "coo": { "remotePort": 7797, "localPort": 27797 } }
}
```

- 只接受密钥登录（`BatchMode=yes`），`known_hosts` 固定，不连任意地址。
- 隧道断开后每 3 秒自动重连；`/api/device` 显示每个隧道的状态。
- 未配置 `device` 时，上游就是本机 `127.0.0.1` 的服务。

## 路由

- `/`：Live2D 面对面主界面（`tools/face/`）。
- `/face/*`：主界面对话桥（SSE `/face/events`、上行 `/face/say`、语音 `/face/asr`、模型 `/face/models*`）与静态资源。
- `/pet` 与 `/coo/pet`：Coo 原版 `/pet` 页面（同源代理，桌宠兼容）。
- `/socket`：Coo 的 `wss` 双向协议；`/ws`：Hub 的旧协议（保留）。
- `/api/services`：只读服务健康目录。
- `/api/coo/status`、`/api/coo/audio`、`/api/coo/blob`：Cortico 状态与 `tts.voice` 音频。
- `/api/health`、`/api/device`：投影服务自身与 SSH 隧道状态。
- `/services`：服务目录页面。

## 验证

```powershell
node --test tools/host-projection.test.mjs
```

启动后：

```powershell
curl -k https://127.0.0.1:18112/api/health
curl -k https://127.0.0.1:18112/api/device
```
