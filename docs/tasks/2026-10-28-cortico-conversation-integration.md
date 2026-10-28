# Cortico 对话接入

日期：2026-10-28  
状态：Host 根入口已直接复用 Coo 原 `/pet` 及其原生聊天/桌宠交互并完成本机合同验证；Coo TTS 整条链路已由操作者确认正常，Cortico paused 时未做 Persona 自动回复回合

## 已确认事实

- Coo 的对话权威在 Cortico Core 与 `desktop-pet` World，不在 Absolute Solver Hub。
- Coo `desktop-pet` World 已有聊天流：网页发送 `send { id, text, images }`，World 记录 `desktop-pet.message`，再由 Cortico 正常投递给 Persona；回答、工具过程和 `desktop-pet.self` 事件由同一条流回传。
- Coo 的 `world:console` 是现有管理 WebUI 的控制台对话入口；管理 WebUI 当前绑定 loopback，并带自己的登录、会话和 WebSocket 边界。
- Coo `world:tts` 已接入 Absolute Solver 的 OpenAI 兼容 TTS 服务；`tts.voice` 交付给 `audio-play`，合成与播放链路按 Coo 原生路径已由操作者确认正常。旧 Hub TTS 探针不作为本链路判据。
- Absolute Solver 当前 LAN 根页面直接使用 Coo 原 `/pet`，由该页面自带菜单、打字、语音输入、气泡和动作交互；`/socket` 双向透传 Coo 原生桌宠协议。网页不复制 Persona、会话、工具、权限或 TTS。Host 只增加同源 TTS 附件消费接口；Hub `/app` 仅保留为 Solver 协议原型/回退入口。

## 候选路径

| 路径 | 含义 | 当前判断 |
|---|---|---|
| 保留 Hub `/app` | 网页作为 Solver Body，文本进入 Hub，Hub 负责 TTS/段回执 | 保留为 Solver 协议原型/回退入口；不能称为 Coo 原生对话 |
| 代理完整 Coo WebUI | 页面嵌入 `17788` 的管理控制台，复用现有 console chat、登录、会话和 World 页面 | 权限面和 API 面过大，会把 loopback 管理界面暴露到 LAN；暂不采用 |
| 代理 Coo 原生桌宠页面 | 复用 Coo `/pet`、`/socket`、菜单、打字、语音输入和动作运行时；Host 只做同源代理及 TTS 音频附件转发 | 已采用；当前实现为根 `/`、`/socket`、`/api/coo/audio` 和 `/api/coo/blob`，后续补 LAN 配对、认证和断线恢复 |

## 当前边界

不修改 Hub 的 Persona 路径、不把 Coo 管理 WebUI 整体暴露到 LAN，也不复制 Cortico 的会话/工具/权限系统。网页直接展示并运行 Coo 原 `/pet`；Hub `/app` 仍是独立原型/回退入口。

## 下一次可验收任务

继续补强原生投影合同测试：验证 `/socket` 的 `hello`/`watching`、打字/语音输入、重连后的快照恢复，以及新 `tts.voice` 附件在 LAN 浏览器的播放；完整 Persona/TTS 自动回合需在 Cortico 非 paused 时由操作者复验。

证据：`D:\11\Logs\2026-10-28-coo-tts-接入.md`、Coo `cortico-world-desktop-pet` 源码中的 `onChat`/`ChatSockets`、`tools/projection.*`。
