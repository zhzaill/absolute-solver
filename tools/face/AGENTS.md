# tools/face/ — Live2D 投影界面（目录交接说明）

覆盖的文件：`index.html`、`chat.js`、`figure.html`、`figure.js`、`face-client.js`、`render-live2d.js`、`face-audio.js`、`face-util.js`、`face.css`、`manifest.webmanifest`、`icon.svg`，以及同步/导入产物 `live2d/`、`import/`。

## 两个界面（按用户要求拆开）

| 路由 | 页面 | 内容 |
|---|---|---|
| `/` | `index.html` + `chat.js` | **第一界面：Cortico 对话**。只有消息流 + 输入框 + 麦克风。**不投影任何设置键**（模型、TTS/ASR、导入都在主机侧）。顶部有一个「人物」小入口跳到 `/figure`，那是视图切换，不是设置。 |
| `/figure` | `figure.html` + `figure.js` | **第二界面：Live2D 人物**。**一个按键都没有**，没有对话、没有设置；自己走 SSE 收表情指令和 TTS 音频并播放。 |
| `/pet` | Coo 原页 | 桌宠兼容，原样保留。 |

对话与人物共用同一个桥：`POST /face/say` 上行、`GET /face/events` 下行、`POST /face/asr` 语音。人物页面**不**重复播放对话文字，只播语音。

协议只有一份实现（`face-client.js`）；两个页面只是用 `connect({role})` 声明自己订阅什么：`chat` 只收消息，`figure` 收表情与语音。桥保证同一时刻只有一个 `figure` 拿到 `voice`，所以开两个模型页也不会出现双份音频；关掉出声的那个，另一个自动接手。

## 设计要点

- **不自己写渲染引擎。** 全部复用 Coo 图包：`live2d/pack/sdk/live2dcubismcore.min.js` + `backends/live2d.js` + `live2d/kit/body.js`。`render-live2d.js` 只是约 100 行引导层：加载、取景、把音量写进 `globalThis.__l2dDrive.set({mouthOpen})`。
- **同源、非 iframe**，避开 Coo `/figure-frame` 的 http-only CSP 与 `ACAO:null`。
- **自适应取景**：`geometry()` 每次按容器 `clientWidth/clientHeight` 计算。S 受 kit 走动边界限制（约 `(W-16)/208`），再乘 CSS `scale(zoom)` 把画面裁到腰部；宽度受限时自动加大 zoom，窄屏/竖屏会裁掉两侧只留头肩。改 `CROWN`/`WAIST`/`0.94` 系数即可调构图。
- **人物页面无按键**：关闭、拖动、置顶全部交给可选的宿主窗口（`tools/face-window.mjs`）。
- **语音输入**：浏览器录音 → 16 kHz 单声道 WAV → `/face/asr` → 主机 ASR；只在对话页出现。
- **麦克风权限**：只要在安全上下文（HTTPS 或 localhost），麦克风按钮就可点；点一下即触发浏览器权限框，即使主机 ASR 还没起来也会先申请权限并提示「未就绪」。被浏览器拒绝时提示去地址栏站点设置放行；非安全上下文才禁用按钮。
- **模型导入**：不再有前端入口，走 API（见下）；开源时与一键导入插件对接。

## 前置条件与依赖

- 先跑 `node tools/sync-face-assets.mjs`（需要本机装有 Coo：`D:\11\Tools\coo`，可用 `COO_HOME` 覆盖）。
- HTTPS/安全上下文才有麦克风（`127.0.0.1` 或 tailnet 证书）。
- 人物页与对话页都无第三方前端依赖。

## 输入 / 输出与影响范围

- 读 `tools/face/models.json`（运行时注册表，已 gitignore）；模型包在 `live2d/packs/<id>/`。
- 导入接口：`POST /face/models/import-path {path,id,label}` 或逐文件 `POST /face/models/upload?...`，由 `../face-bridge.mjs` 处理。
- 不改 Coo 安装目录；`live2d/`、`import/` 都是拷贝，可重跑同步覆盖。

## 验证方法

```powershell
node tools/sync-face-assets.mjs
node tools/host-projection.mjs
curl.exe -s http://127.0.0.1:18111/face/models
```

浏览器：`http://127.0.0.1:18111/`（对话）、`http://127.0.0.1:18111/figure`（人物）。

## 已知限制 / 未决项

- 默认模型 `LipSync` 组为空，口型靠 `profile.js` 的 `mouthOpen → ParamMouthOpenY` 覆盖；换模型若没有该 role 则口型不动。
- 人物页音频需要一次用户手势解锁（浏览器自动播放策略）；Electron 宿主已设 `autoplayPolicy: no-user-gesture-required`。
- 对话页不播放 TTS，避免与人物页双播；只开对话页时听不到声音，这是有意的分工。
- 导入的贴图未缩（转换器的缩图脚本未随包），大模型包可能 60 MB 级。
- 尚未在真机手机 + tailnet 上完成端到端验收。
