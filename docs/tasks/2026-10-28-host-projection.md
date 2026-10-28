# 阶段一：服务与 Host 投影

日期：2026-10-28
状态：实现完成，World 已发布并接入本机 Coo；部分运行验收待第二台设备

## 目标

提供独立于 Hub/Body 控制流的只读 LAN 服务目录。目录显示 Host、服务类型、实际健康状态、版本、能力和入口；状态来自健康请求，不由配置文件单独推断。

## 已实现

- `tools/host-projection.mjs`：只读 HTTP 目录，默认 `0.0.0.0:18111`，可用 `SOLVER_PROJECTION_PORT` 覆盖。
- `tools/host-projection-lib.mjs`：地址清洗、健康探测、目录摘要；公开摘要不含凭据、查询参数、片段或完整服务响应。
- `tools/host-projection.example.json`：Cortico World、ASR、LLM、TTS 的示例 Host 配置。
- `tools/projection.*`：无执行能力的目录页面，仅展示状态和必要元数据。
- loopback 原生界面不向远端浏览器提供链接；Coo `/pet` 仍由 Coo 自己的 renderer/World 运行时提供，待后续安全桥接后再投影。
- `packages/cortico-world-absolute-solver` 发布为 `cortico-world-absolute-solver@0.1.0`，Coo 以 API 6 World 加载，提供 `solver_services` 只读工具和控制台入口。

## 验收与限制

- `node --test tools/host-projection.test.mjs`：3/3 通过。
- `node --check`、`cargo fmt --check`、`git diff --check`：通过。
- 本机 LAN 地址 `192.168.1.178:18111` 实测目录 HTTP 200、服务 JSON HTTP 200；POST 返回 405。
- 实测 Cortico World 与 TTS 为在线，ASR 与 LLM 当时离线；这是探测结果，不是配置推断。
- Coo 本机配置已备份后启用 `worlds.absolute-solver`，目录地址为 `http://192.168.1.178:18111`；从安装目录直接 import 成功，World id/tool 分别为 `absolute-solver`/`solver_services`。
- 本次没有第二台 LAN 设备，也没有跨机 Coo 原页面验收，因此阶段整体暂不标记 `accepted`。旧端口 `18110` 被其他进程占用，目录默认端口调整为 18111。

## 回滚

阶段一是独立 Node 进程和静态文件，不改 Hub、Body 或 Cortico。停止 `host-projection.mjs` 即可回滚；不需要替换生产二进制。
