# Absolute Solver

Cortico 的跨设备运行时：**把 Cortico 的能力投影到你的各种设备**——桌宠/对话界面、声音、工作区与工具。通过 SSH 抵达设备，每台设备本地同时运行 ASR、TTS 和 LLM。

## 主线

- **Cortico/DSH（大脑）** — Persona、会话、记忆、代码工作、工具选择。
- **SSH（通道与门）** — 加密传输、主机身份校验、账户授权、端口转发。
- **每台设备（本地算力）** — 本地同时跑 ASR / TTS / LLM，是可独立工作的感知、表达和推理节点。
- **设备登记表（可选，事实）** — 记录地址、账户、能力和最近回执；不代理消息、不颁发临时授权。

一句话：Cortico 用 SSH 把自己的能力投影到设备上，用设备本地的语音和模型干活，并拿回真实回执。

## 当前状态（2026-11-06）

方向已切换为 SSH 优先：

- 旧的 Hub / Presence（存在位置）/ 无门权限实现已归档到 `archive/pre-ssh-2026-11-06` 分支，不再是主线；
- SSH 传输与设备本地 ASR/TTS/LLM 调用的最小实现**尚未落地**，`main` 当前只是干净基线。

详见 [宪法](docs/SOLVER_CONSTITUTION.md)、[North Star](docs/north-star.md) 和 [方向切换任务卡](docs/tasks/2026-11-06-ssh-first-pivot.md)。

## 网络：局域网直连 + Tailscale 广播

- **局域网直连**：同网设备直接访问 `https://<局域网IP>:18112`（自签证书）。
- **Tailscale 广播**：运行 `node tools/host-projection.mjs` 后，再 `node tools/tailscale-broadcast.mjs`，tailnet 内用有效证书访问 `https://<machine>.<tailnet>.ts.net/`；`--reset` 撤销。
- **SSH**：`device.host` 可填局域网 IP、`100.x` Tailscale IP 或 MagicDNS 名。

## 主界面：Live2D 面对面

```powershell
node tools/sync-face-assets.mjs   # 首次：从 Coo 复制图包/kit/转换器
node tools/host-projection.mjs
```

浏览器打开 `https://<IP>:18112/`（本机也可 `http://127.0.0.1:18111/`）：

- `/` = **第一界面：Cortico 对话**。只有消息、输入框、麦克风；设置键不投影，模型/TTS/ASR 都在主机侧。
- `/figure` = **第二界面：Live2D 人物**。一个按键都没有，自己收表情指令与 TTS 音频。
- **复用 Coo 图包渲染**（Cubism Core + `backends/live2d.js` + `kit/body.js`），不自研引擎；同源、非 iframe；按窗口大小自适应取景。
- **SSE 下行 + HTTPS 上行**，两个界面接同一个 Cortico/Coo Persona。
- **兼容桌宠**：旧页仍在 `/pet`；可选的桌面悬浮窗 `node tools/face-window.mjs`（透明/无边框/置顶/穿透），网页仍是主线。
- 模型导入走 API（`POST /face/models/import-path`），开源时与一键导入插件对接。

## 原则

- **复用优先**：`ssh`/`scp`/`rsync`/端口转发、设备自带的服务管理、Cortico 既有能力；不重写传输和认证。
- **一台设备一个本地栈**：ASR、TTS、LLM 在设备上同时运行，不集中到单机。
- **权限就是账户权限**：由 SSH 账户在操作系统和 sudo 策略中的实际权限决定；Solver 不放大、不绕过。高风险动作沿用操作系统或 Cortico 的确认。
- **回执必须真实**：成功、失败、超时都来自真实 SSH 会话的退出码和输出。

## 开发与验证

需要 Rust stable 和 Node 22：

```powershell
cargo fmt --check
cargo test
node --test tools/*.test.mjs packages/cortico-world-absolute-solver/test/world.test.mjs
```

原始运行证据在 `D:\11\Logs`。不要把 API key、token、服务器密码或私钥提交到仓库。
