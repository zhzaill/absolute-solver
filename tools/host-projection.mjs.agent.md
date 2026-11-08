# host-projection.mjs — 交接说明

## 用途 / 入口

把 **Live2D 面对面主界面**（`/`）、Coo 原版 `/pet` 页、`/socket`、`tts.voice` 音频和 `/services` 服务目录投影给浏览器；可选地用 SSH 隧道把远端设备本地服务接到本机。

- 入口：`node tools/host-projection.mjs`
- 配置文件：`SOLVER_PROJECTION_CONFIG` → 否则 `tools/host-projection.local.json` → 否则 `tools/host-projection.example.json`
- 依赖模块：`tools/host-projection-lib.mjs`（目录构建/CSP 重写）、`tools/face-bridge.mjs`（面对面对话桥）、`tools/face/`（主界面静态页）、`coo-audio.js`、`ws`（`tools/package.json`）

## 前置条件与依赖

- Node 22+；`ws` 已安装在 `tools/node_modules`。
- HTTPS 需要 `openssl` 在 PATH；缺省时自动生成自签证书到 `tools/certs/`（已 gitignore）。
- SSH 设备模式需要系统 `ssh` 客户端、目标机已部署公钥、`known_hosts` 已含目标主机。
- 远端设备本地需运行 Coo（默认 7797）、Cortico（17788）及 ASR/TTS/LLM（9881/18080/18081）。
- 主界面首次使用前先跑 `node tools/sync-face-assets.mjs` 同步 Coo 的 Live2D 图包；否则 `/` 只能显示空舞台。

## 输入 / 输出与影响范围

输入：配置文件的 `listenHost/listenPort`、`tls`、`device`、`services`、`face.asrBaseUrl`；环境变量 `SOLVER_*`。

输出：
- HTTP `18111`（非 loopback 308 跳转到 HTTPS）与 HTTPS `18112`（默认）。
- 路由：`/`（Live2D 面对面主界面）、`/face/*`（SSE 下行 `/face/events`、上行 `/face/say`、语音 `/face/asr`、模型 `/face/models*`）、`/pet` 与 `/coo/pet`（Coo 原桌宠页，兼容保留）、`/socket`、`/ws`、`/api/services`、`/api/coo/status|audio|blob`、`/services`、`/api/health`、`/api/device`。
- 影响范围：只代理到配置的 upstream；配置 `device` 时通过 `ssh -L` 隧道访问设备，不改设备文件。模型导入会写入 `tools/face/live2d/packs/<id>/`（已 gitignore）。

敏感信息：不写 token、密码、私钥内容；配置只引用 `identityFile` 路径。

## 常用安全调用

```powershell
node tools/host-projection.mjs                      # HTTPS + 本机服务
$env:SOLVER_PROJECTION_HTTPS='0'; node tools/host-projection.mjs   # 仅 HTTP 调试
```

设备模式：在配置 `device` 块填 `host/port/user/identityFile/knownHostsFile`，并保持 `strictHostKeyChecking: "yes"`。不要为了省事关掉主机校验。

## 验证方法

```powershell
node --test tools/host-projection.test.mjs
curl -k https://127.0.0.1:18112/api/health
curl -k https://127.0.0.1:18112/api/device
```

已实测：自动生成自签证书、HTTP→HTTPS 308、`/api/health` 200、`/services` 200。

## 已知限制 / 未决项

- SSH 隧道用 `BatchMode=yes`，只支持密钥登录；密码交互登录不可用。
- 隧道只做端口转发，不执行远程命令；设备上服务的启动/停止仍由设备自己的服务管理负责。
- `/ws`（旧 Hub 协议）仍保留以兼容旧页面，新主线不再依赖 Hub。
- 尚未在真实远端设备上做端到端验收（缺目标 host/user）。
