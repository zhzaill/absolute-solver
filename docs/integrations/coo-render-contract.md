# Coo 表现适配契约

更新时间：2026-10-28

## 结论

Coo（`cortico-world-desktop-pet@0.2.0`）已经有正式的桌宠表现契约。当前安装配置的默认形象是 `figure: "whale"`、`scheme: "deepseek"`，即 DeepSeek 大肥鱼。形象包在 `figure.json` 的 `vocab` 中声明 `expression` 和 `motion` 词，桌宠运行时最终调用形象 body 的 `do(word)`。`pet_say` 的 `【…】`/`<…>` 标记和 `pet_act` 都先按当前形象词表解析，再执行这些词。

Absolute Solver 不复制这套 World、Persona、工具或形象包。Solver 协议的 `render.cue.expression` 与 `render.cue.motion` 是表现提示；Coo 侧需要一个 Body 适配器将它们映射到现有 renderer 的 `body.do(word)`。

## 当前投影服务

- Coo 的真实桌宠页面是 World 提供的 `/pet`（本机当前端口 `7797`），不是 Cortico 管理 WebUI `17788`。它会读取 `/api/state` 中的 `whale/deepseek` skin，加载 `/api/figures` 对应的形象包和 sandbox body，再连接自己的 `/socket?role=pet` 运行桌宠动作。
- Coo 服务绑定 `127.0.0.1`，不是 LAN 服务。Absolute Solver Host 现在提供同源反向代理，把 Coo 原页面、原生 `/socket` 和 sandbox 资源投影到可信 LAN；页面 CSP 由代理只改写必要的同源与 WebSocket 来源。
- `/overlay` 是另一路 OBS 位图帧流，当前 Coo 配置未开启，实测返回 404；它也不等价于 Solver 的 Body 协议。
- Cortico Electron 主进程有受限的本机设置页代理，但 WebSocket 不经该代理，代理只允许 Core/桌宠来源，不能作为 Solver LAN 客户端代理。

所以，Solver 不再另画 Coo 界面。LAN 根入口直接返回 Coo 原 `/pet` 页面，原页面的菜单、打字、语音输入、气泡、动作和 WebSocket 交互全部由 Coo 自己运行；`/services` 只保留独立的服务健康目录。

TTS 不再依赖 Coo Host 的本机扬声器才能在 LAN 页面出现。Host 监听 Coo 事件库中新产生的 `tts.voice` 音频附件，经同源 `/api/coo/audio` 与 `/api/coo/blob` 交给当前浏览器播放；首次用户手势解锁浏览器音频上下文，历史语音不在首次打开时回放。Coo Host 的 `audio-play` 仍可继续本机播放，浏览器投影是同一事件的另一受控消费端。

## 复用边界

| Coo 已有内容 | Solver 的处理 |
|---|---|
| 形象包、动作词表、`pet_say`/`pet_act`、桌宠窗口和 WebView | 通过本机 Body/投影桥复用，不在 Solver 重画或重写 |
| Persona、Session、Memory、World 工具调用 | 由 Cortico 保持，Solver 只接收受控事件/表达 |
| PCM 播放和本地设备事实 | Coo Host 继续由 `audio-play` 负责；LAN 浏览器消费同一 `tts.voice` 附件，不复制 TTS 合成或 Persona 决策 |
| 局域网客户端连接、turn、权限和回执 | 由 Solver Hub 负责，Coo 不持有第二份权威状态 |
