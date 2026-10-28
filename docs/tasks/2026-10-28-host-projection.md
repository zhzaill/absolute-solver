# 阶段一：服务与 Host 投影

日期：2026-10-28
状态：实现完成，World 已发布并接入本机 Coo；部分运行验收待第二台设备

## 目标

提供独立于 Hub/Body 控制流的只读 LAN 服务目录。目录显示 Host、服务类型、实际健康状态、版本、能力和入口；状态来自健康请求，不由配置文件单独推断。

## 已实现

- `tools/host-projection.mjs`：只读 HTTP 目录，默认 `0.0.0.0:18111`，可用 `SOLVER_PROJECTION_PORT` 覆盖。
- `tools/host-projection-lib.mjs`：地址清洗、健康探测、目录摘要；公开摘要不含凭据、查询参数、片段或完整服务响应。
- `tools/host-projection.example.json`：Cortico World、ASR、LLM、TTS 的示例 Host 配置。
- `tools/projection.*`：同一 LAN 页面提供服务目录、Coo 原 `/pet` renderer 观察视图和 Hub `/app` 对话/TTS 视图。
- `/coo/pet` 与 `/socket` 复用 Coo 自己的 renderer/World 运行时；投影 WebSocket 丢弃浏览器上行消息，保持观察模式。
- `/hub/app`、`/ws` 和 `/cortico/event` 复用 Hub 对话与 TTS 链路，浏览器仍作为 Hub Body 接收 PCM 与发送段回执。
- `packages/cortico-world-absolute-solver` 发布为 `cortico-world-absolute-solver@0.1.0`，Coo 以 API 6 World 加载，提供 `solver_services` 只读工具和控制台入口。

## 验收与限制

- `node --test tools/host-projection.test.mjs`：3/3 通过。
- `node --check`、`cargo fmt --check`、`git diff --check`：通过。
- Tabbit 浏览器实测三视图：服务表显示 Host/服务状态；桌宠 iframe 标题为“Cortico 桌宠”，原 `whale`（DeepSeek 大肥鱼）renderer 已绘制；对话 iframe 加载 Hub `/app`。
- Coo watcher WebSocket 收到 `init`/`watching`；Hub WebSocket 完成浏览器 Body `hello`。Coo 沙箱的 `Origin: null` CORS 与 CSP 已由代理保留/重写。
- 本机 LAN 地址 `192.168.1.178:18111` 实测目录 HTTP 200、服务 JSON HTTP 200；POST 返回 405。
- 实测 Cortico World 与 TTS 为在线，ASR 与 LLM 当时离线；这是探测结果，不是配置推断。
- Coo 本机配置已备份后启用 `worlds.absolute-solver`，目录地址为 `http://192.168.1.178:18111`；从安装目录直接 import 成功，World id/tool 分别为 `absolute-solver`/`solver_services`。
- 页面本机 HTTP 与代理路由已验收；Coo `init`/`watching` 和 Hub Body hello 的 WebSocket 握手已验收。尚未有第二台 LAN 设备人工打开、实际 Coo 画面截图或一条真实对话/TTS 回合，因此阶段整体暂不标记 `accepted`。旧端口 `18110` 被其他进程占用，目录默认端口调整为 18111。

## 回滚

阶段一是独立 Node 进程和静态文件，不改 Hub、Body 或 Cortico。停止 `host-projection.mjs` 即可回滚；不需要替换生产二进制。
