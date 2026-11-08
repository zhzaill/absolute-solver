# Live2D 面对面投影：两个界面、一套协议、语音闭环

日期：2026-11-08

## 这次大更新做了什么

把「把 Cortico 投影到设备上」从概念做成了可用的界面：浏览器打开投影地址，就是一张会说话的脸和一个只有对话的聊天窗。渲染**复用 Coo 已有的 Live2D 图包与 kit**，没有另写引擎。

### 两个界面

| 路由 | 界面 | 内容 |
|---|---|---|
| `/` | 第一界面 · Cortico 对话 | 消息流、输入框、麦克风。**不投影任何设置键**（模型、TTS/ASR、导入都在主机侧）。顶部一个「人物」小入口做视图切换。 |
| `/figure` | 第二界面 · Live2D 人物 | **零按键**。自己收表情指令与 TTS 音频并播放，口型跟随实际音量。 |
| `/pet` | 桌宠兼容 | Coo 原版页面，原样保留。 |

可选的桌面悬浮窗（透明、无边框、置顶、默认鼠标穿透）用 `node tools/face-window.mjs`；**主线仍是网页**。

### 一套协议

`tools/face/face-client.js` 是唯一的协议实现，两个页面只是用 `connect({role})` 声明订阅：

- `chat` 只收 `message`，不再白收表情与语音；
- `figure` 收 `cue`，`voice` 只发给**第一个**模型页（音频所有者），它断开后自动顺延给下一个。

所以同时开对话页和人物页不会双播，开两个人物页也不会回声。

### 语音闭环

- **下行**：SSE `/face/events`，带 `Last-Event-ID` 续播。
- **上行**：`/face/say` 注入同一个 Coo Persona。
- **语音输入**：浏览器录音 → 16 kHz 单声道 WAV → `/face/asr` → 宿主 ASR。
- **TTS 网关修复**：`gateway.py` 由计划任务拉起时会卡死（进程在、工作集 19 MB、累计 CPU 0.078 s、从不 bind 18080）；`tools/speaker.mjs` 改为用长驻 SSH 同时持有网关与上游，不再依赖计划任务。

### ASR 不绑定位置

ASR 由宿主配置（`face.asrBaseUrl` / `SOLVER_ASR_BASE_URL`），可能在本机、服务器或远端设备。投影服务只负责把 WAV 转成 OpenAI 风格 `/v1/audio/transcriptions` 请求并取回文本。

## 验证证据

- `node --test tools/*.test.mjs packages/cortico-world-absolute-solver/test/world.test.mjs` → 23/23 通过。
- 文字链路：SSE 收到 user → assistant（约 2 秒）→ 表情 `cue`。
- 语音链路：收到 `voice` 事件，音频为 398 KB 的真 WAV；`/figure` 解码 5.78 秒音频、播放启动、口型峰值 1.0。
- 角色分发：三条流分别收到 `chat: message×2`、`figA: message×2 + cue + voice`、`figB: message×2 + cue`（无 voice）。
- 所有权顺延：断开 figA 后 figB 接替拿到 `voice`。
- ASR 契约：本地假 ASR 收到原样 multipart（`file` 字段），返回 `{"ok":true,"text":"这是测试转写"}`。
- 服务端：从 `192.168.67.166` 访问 `/` 与 `/figure` 均 200，HTTP `18111` 非回环请求 308 到 HTTPS。

## 已知限制

- 网关、上游、ASR 都靠长驻 SSH 持有，本机重启或断网后需要重新 `on`。
- 默认模型的 `LipSync` 组为空，口型依赖 `profile.js` 的 `mouthOpen → ParamMouthOpenY`；换模型若没有该 role 则口型不动。
- 导入的贴图未缩，大模型包可能 60 MB 级。
- 尚未在真机手机 + tailnet 上完成端到端验收。
