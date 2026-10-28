# 阶段一：服务与 Host 投影

日期：2026-10-28
状态：服务、桌宠、对话和 TTS 能力已接入并部署本机；第二台设备仍待验收

## 目标

提供独立于 Hub/Body 控制流的只读 LAN 服务目录。目录显示 Host、服务类型、实际健康状态、版本、能力和入口；状态来自健康请求，不由配置文件单独推断。

## 已实现

- `tools/host-projection.mjs`：只读 HTTP 目录，默认 `0.0.0.0:18111`，可用 `SOLVER_PROJECTION_PORT` 覆盖。
- `tools/host-projection-lib.mjs`：地址清洗、健康探测、目录摘要；公开摘要不含凭据、查询参数、片段或完整服务响应。
- `tools/host-projection.example.json`：Cortico World、ASR、LLM、TTS 的示例 Host 配置。
- `tools/projection.*`：`/services` 的只读健康目录；不再承载桌宠或对话界面。
- 根入口与 `/coo/pet` 同源代理 Coo 自己的 `/pet` 页面；原页面的菜单、打字、语音输入、气泡、动作和 World 运行时由 Coo 保持。
- `/socket` 双向透传 Coo 原生桌宠协议；网页上行消息不再被丢弃，因此触摸、打字、语音输入和动作控制沿用 Coo 原实现。
- `/api/coo/audio`、`/api/coo/blob` 只为当前 LAN 页面转发新 `tts.voice` 音频附件；不复制模型、Persona 或音频合成。
- 同源 CSP 与 sandbox opaque-origin 的 `Origin: null` 资源访问由代理适配；代理保留 Coo 原生消息方向，不替换 watcher/交互语义。
- `packages/cortico-world-absolute-solver` 更新为 `cortico-world-absolute-solver@0.2.1`，使用 API 6 `webUi()` 接口加载；控制台入口分别显示当前投影网页和 `/services`，环境提示给出打开、使用和 HTTP 麦克风限制说明；`solver_services` 仍是只读工具。

## 验收与限制

- `node --test tools/host-projection.test.mjs`：5/5 通过。
- `node --check`、`cargo fmt --check`、`git diff --check`：通过。
- Tabbit 浏览器实测根页面标题为“Cortico 桌宠”，原 `whale`（DeepSeek 大肥鱼）renderer、底部原生工具入口和原页面布局已绘制；没有自制导航或聊天 DOM。原页面的打字、菜单、气泡和动作入口仍在，`/services` 单独显示服务健康目录。
- Coo watcher WebSocket 收到 `init`/`watching`；Hub WebSocket 完成浏览器 Body `hello`。Coo 沙箱的 `Origin: null` CORS 与 CSP 已由代理保留/重写。
- 本机 LAN 地址 `192.168.1.178:18111` 实测根页面、`/services`、服务 JSON、Coo `/pet`、Coo figures 均 HTTP 200；目录 POST 返回 405；原生 `/socket?role=pet&host=tab` 收到 `init` 和 `watching`，根页面加载 `pet-app.js`。
- 实测 Cortico World 与 TTS 为在线，ASR 与 LLM 当时离线；这是探测结果，不是配置推断。
- Coo 本机配置已备份后启用 `worlds.absolute-solver`，目录地址为 `http://192.168.1.178:18111`；从安装目录直接 import 成功，World id/tool 分别为 `absolute-solver`/`solver_services`。
- 原页面、原 renderer、原生桌宠交互和 TTS 音频投影已验收：`/api/coo/audio` 首次打开不回放历史；从 `after=117` 读取新 `tts.voice` 后，`/api/coo/blob` 返回 361004 字节 RIFF WAV，LAN 浏览器 `AudioContext` 解码并播放约 5.6 秒。HTTP LAN 页面不是 secure context，Coo 原语音输入的 `navigator.mediaDevices` 不可用，需 HTTPS 证书后再验收麦克风。第二台 LAN 设备尚未人工打开，且 Cortico paused 时未验证 Persona 自动回复；旧端口 `18110` 被其他进程占用，目录默认端口调整为 18111。
- 插件 v0.2.1 本地测试 3/3 通过，`npm pack --dry-run` 包含 README、World 定义和环境提示；已修复 API 6 控制台钩子必须叫 `webUi()` 的问题。npm `latest=0.2.1`，本机 Coo 已安装并重启加载 0.2.1；WebUI manifest 实测显示投影网页、`/services` 和使用说明。

## 回滚

阶段一是独立 Node 进程和静态文件，不改 Hub、Body 或 Cortico。停止 `host-projection.mjs` 即可回滚；不需要替换生产二进制。
