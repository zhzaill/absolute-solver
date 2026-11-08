# face-bridge.mjs — 交接说明

## 用途 / 入口

主界面的服务端桥：**SSE 下行**（Cortico 事件）+ **HTTPS 上行**（注入同一 Coo Persona）+ 主机 ASR + Live2D 模型导入。由 `host-projection.mjs` 创建并调用，不单独启动。

- 创建：`createFaceBridge({ cooBaseUrl, corticoBaseUrl, asrBaseUrl, faceRoot, ttsHandles, WebSocket })`
- 分发：`await bridge.handle(request, response, pathname)`，返回 `true` 表示已处理。
- 关闭：`bridge.close()`（`host-projection.mjs` 的 shutdown 调用）。

## 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/face/events?role=chat\|figure` | SSE：`hello` / `message` / `voice` / `cue` / `error`，`id:` 为 Cortico cursor，支持 `Last-Event-ID` 从环形缓冲续播。**按角色分发**：`message`/`error` 给所有；`cue` 只给 `figure`；`voice` 只给**同一个** `figure`（音频所有者） |
| GET | `/face/status` | `{ok, pet, clients, figures, asr}`；`clients` 为连接总数，`figures` 为模型页数，`asr` 为 `online`/`offline`/`http-<code>` |
| POST | `/face/say` | `{text}`（≤500 字）→ Coo watcher socket |
| POST | `/face/asr` | 原始 16 kHz WAV（≤12 MB）→ `${asrBaseUrl}/v1/audio/transcriptions` → `{text}` |
| GET | `/face/models` | 读 `tools/face/models.json`（缺失时返回内置 deepseek） |
| POST | `/face/models/import-path` | `{path,id?,label?}`，主机路径，跑官方转换器 |
| POST | `/face/models/upload?id=&path=` | 单文件上传（浏览器 `webkitdirectory` 逐文件）；`&finish=1` 触发转换 |
| POST | `/face/models/remove` | `{id}`，仅能删非 builtin |

## 关键实现

- **上行**：`WebSocket('ws://<coo>/socket?role=pet&host=tab', {origin})`，发 `{t:'text', text}`。watcher 不抢占桌面 pet；绝不用 `host=window`，绝不发二进制。
- **下行**：每 700 ms 轮询 `GET <cortico>/api/events?from=<cursor>&limit=40&archive=1`。`desktop-pet.self` 的 `say` 必须 `archive=1` 才拿得到。
- **事件映射**：`desktop-pet.self(kind=say)` → `message`（assistant，`meta.beats` 拼文本、`mood.id` 同时发 `cue`）；`desktop-pet.message` → 用户消息；`tts.voice` 的 `blobs[]` 注册 handle 后发 `voice`（URL 走 `/api/coo/blob`）；`tts.voice-failed` → `error`。
- **模型导入**：`faceRoot/import/convert.mjs --model <dir> --out live2d/packs/<id> --runtime live2d/pack --max-texture 2048 --force`；成功后删掉 20+ MB 的 `moc3.js` 回退模块并写注册表。

## 输入 / 输出与影响范围

- 读 `tools/face/models.json`；写同文件与 `tools/face/live2d/packs|imports/<id>/`（均已 gitignore）。
- 不写 Coo 安装目录；不持有密钥。
- 上行/下行都只与本机 upstream（或 SSH 隧道 loopback）通信。

## 验证方法

```powershell
curl.exe -s http://127.0.0.1:18111/face/status
curl.exe -s -X POST -H "content-type: application/json" -d "{\"text\":\"你好\"}" http://127.0.0.1:18111/face/say
curl.exe -N http://127.0.0.1:18111/face/events
```

## 已知限制 / 未决项

- ASR 接口按 OpenAI 风格 `/v1/audio/transcriptions` 实现，**已用本地假 ASR 验证契约**（原样转发 multipart 的 `file` 字段、返回 `{text}`），但未接真实 ASR 模型实测。ASR 位置由宿主配置（`face.asrBaseUrl` / `SOLVER_ASR_BASE_URL`），本桥不假设它在服务器上。
- 轮询间隔 700 ms、并发 40 条；高频事件下未做背压。
- watcher 文本注入依赖 Coo 的 `WATCHER_MESSAGES` 允许 `text`（`server.ts` 已确认）。
- **单声道**：`clients` 是 `Map<response, {role}>`；`audioOwner` 取第一个存活的 `figure` 客户端，它断开后自动顺延给下一个，避免两个模型页同时播放同一段 TTS 造成回声。`Last-Event-ID` 重放走同一套过滤。
- **多客户端同时观看时共享同一 cursor 与环形缓冲（200 条）。**
