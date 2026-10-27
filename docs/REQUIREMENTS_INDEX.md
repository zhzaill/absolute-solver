# 需求手册总目录

版本：v1.0
日期：2026-10-26
适用范围：Absolute Solver 全项目

本文是需求入口。需求明确优先于技术偏好、历史计划和临时实现。

当前 Solver 宪法：`docs/SOLVER_CONSTITUTION.md`。内容归属与 Cortico 接入整理：`docs/SOLVER_CONTENT_MAP.md`。两者是 Absolute Solver 的项目级约束和整理手册，不替代 Cortico Persona 自己的 `CONSTITUTION.md`、`MEMORY` 或 World 契约。

当前状态入口：`docs/ABSOLUTE_SOLVER_CURRENT_STATE.md`。该文件只索引代码与 Logs 证据，不能单独宣布完成；最新整理记录为 `D:\11\Logs\2026-10-27-Solver-宪法与内容整理.md`。

## 1. 文档层级

文档用途必须区分：

| 层级 | 内容 | 位置 | 是否可直接作为任务要求 |
|---|---|---|---|
| 用户要求 | 当前会话明确提出的目标、约束和优先级 | 当前任务记录 | 是，优先级最高 |
| 总体要求 | 身份、边界、权限、连续性和集成原则 | `docs/north-star.md` | 是 |
| 领域要求 | TTS、Presence、协议、机器人和迁移规则 | 本文第 2 节 | 是 |
| 协议规范 | 字段、方向、版本和媒体格式 | `docs/protocol.md`、`src/wire.rs`、`schemas/` | 是；实现不一致时必须建纠偏任务 |
| 运行基线 | 某一日期的运行快照 | `docs/PROJECT_LANDSCAPE.md` | 否，只能作为证据 |
| 计划和评估 | 方案、估算、备选路径 | `docs/plans/`、`docs/*PLAN.md`、`docs/GRPC_EVALUATION.md` | 否，必须先转成任务 |
| 验收证据 | 命令输出、日志、截图和运行结果 | `D:\11\Logs\` | 否，用于证明完成 |

历史文档中的勾选项、预测和“已完成”文字不能单独改变当前状态。

`docs/WIRE_PROTOCOL_V2.md` 是未采纳的历史设计稿，不是协议补充规范；线上规则只以 `docs/protocol.md`、`src/wire.rs` 和生成 schema 为准。
当前不得把 `WIRE_PROTOCOL_V2.md` 当作线上 v2 规范；它是未采纳的历史设计稿。线上仍是 WebSocket v1 增量协议，生产部署地址以 `LAN_HUB_ADDRESS` 为准。

## 2. 领域要求清单

### P0：权威边界和安全

| 领域 | 主文档 | 当前状态 | 硬要求 |
|---|---|---|---|
| 总体架构 | `docs/north-star.md`、`docs/SOLVER_CONSTITUTION.md` | 核心边界已定义；统一 LAN 网页/客户端未实现 | Cortico 持有 Persona 决策；Hub 持有会话、权限与音频路由；网页、Coo、桌面、手机和 Pi 是同一个 Persona 的客户端；每个 turn 一个 active output Body |
| 协议和版本 | `docs/protocol.md`、`src/wire.rs` | 基础完成，兼容性有缺口 | `v=1`、方向明确、媒体有边界、破坏性变化必须升级主版本 |
| 权限和 Presence | `docs/PRESENCE_INTEGRATION_PLAN.md`、`docs/PRESENCE_CHECKLIST.md` | 协议完成，生产覆盖层部分完成 | 在线不等于权限；权限必须有 scope、TTL、撤销和审计 |
| 机器人运动安全 | `docs/integrations/xuegeros.md` | 只读和 shadow 基础完成 | VLA/Persona 不得直接写运动；必须经过人工确认、租约、限幅和 watchdog |

凭据审计：`D:\11\Logs\2026-10-23-Absolute-Solver-服务器部署presence.md` 曾含 Presence token 和服务器账户密码，已以占位符脱敏；凭据轮换与 Hub 局域网鉴权风险仍待单独收束，见 `docs/tasks/2026-10-26-credential-rotation.md`。

### P1：核心可用链路

| 领域 | 主文档 | 当前状态 | 硬要求 |
|---|---|---|---|
| TTS | `docs/TTS_REQUIREMENTS.md` | Native Audio Body 闭环完成（2026-10-26 实跑验收，报告 `D:\11\Logs\2026-10-26-Absolute-Solver-TTS正式验收.md`）；局域网网页/其他客户端输出待验收 | Hub 调 API，解码 PCM16，按客户端能力发送；Native Audio Body 是当前唯一已验收播放端，浏览器不能直接继承该证据 |
| ASR/语音输入 | `docs/protocol.md`、`src/adapters.rs`、`src/bin/body.rs` | 任务制定者因环境（耳机麦电平不足、平时不使用语音输入）免除实麦人工朗读条件（2026-10-26）；验收依据为完整音频经 Hub 回合和源 WAV 直连 Provider 逐字转写，状态 accepted；设备可选 | ASR Provider 可探测，音频受限、可审计，失败时文本/字幕降级；采集设备必须可指定（`SOLVER_CAPTURE_DEVICE`）并在低电平时显式告警 |
| LLM 回合 | `docs/protocol.md`、`src/bin/hub.rs` | 基础完成 | Hub 管理 turn、预算、超时、降级和 trace；模型不拥有会话权威 |
| Cortico 协作 | `docs/north-star.md`、`src/cortico.rs`、`src/bin/hub.rs` | 边界已定义；Cortico 服务已恢复，运行稳定性观察中；生产量化未验收，缺少 World 输入到 Persona 决策的因果关联 ID | Cortico 持有 Persona 决策；Hub 持有 turn、权限、路由和降级；事件是低信任数据，不得覆盖系统/项目规则、用户规则或授权；工具动作必须有回执；silence 是有效决策 |
| LAN 多设备入口 | `docs/SOLVER_CONSTITUTION.md`、`docs/SOLVER_CONTENT_MAP.md` | 目标属于核心，当前未实现 | Solver 必须提供可由桌面/手机/Pi 浏览器和 Coo WebView 访问的交互网页；Cortico WebUI 是回环管理控制台，不可替代 |
| Native Body | `docs/protocol.md`、`src/bin/body.rs` | 音频 Body 生产运行已验收（2026-10-26）；显示类 Body 仍待验收 | Body 注册、active handoff、音频接收和实际扬声器播放必须可证明 |
| World/机器人监视 | `docs/integrations/xuegeros.md` | 监视链路基本完成 | 原始帧和 tensor 不进入 Persona、记忆或长期 trace；监视投影不得变成控制通道 |

### P2：运行质量和发布

| 领域 | 主文档 | 当前状态 | 硬要求 |
|---|---|---|---|
| 可观测性和连续性 | `docs/north-star.md`、`src/lib.rs` | 基础完成 | 决策、证据和未决边界写入 trace；报告必须能追溯到代码和命令 |
| 任务和验收 | `docs/PROJECT_EXECUTION_METHOD.md` | 本文发布后生效 | 每项任务必须有输出位置、验收条件和证据路径 |
| 发布收束 | `docs/PROJECT_LANDSCAPE.md` | 未完成 | 清理未提交改动，完成 tag/release 前不得称为发布版 |

### P3：未来能力

| 领域 | 主文档 | 当前状态 | 触发条件 |
|---|---|---|---|
| gRPC 迁移 | `docs/GRPC_MIGRATION_TRIGGERS.md` | 未开始，按决策延期 | 第三个非 Rust Body、外部开发者接入、兼容性维护超过 2 小时/周，任一成立才启动 |
| 分段/流式 TTS | `docs/TTS_REQUIREMENTS.md` | 分段生成、段级回执及生产 Body 正常播放/打断回执均 accepted（2026-10-27）；Provider 流式 PCM 已测量但 blocked：网关将上游分块缓冲为整段响应 | 先修复网关透传并复测，再推进独立的 Hub/Body 段内流式协议和首块延迟验收 |
| Nav2/自动运动 | `docs/integrations/xuegeros.md` | 未完成 | physical backend、导航安全和人工确认链路全部可验收 |

## 3. 固定输出位置

| 输出 | 位置 | 命名要求 |
|---|---|---|
| 需求手册 | `D:\11\Projects\Absolute Solver\docs\` | `*_REQUIREMENTS.md` 或本目录指定主文档 |
| 任务卡 | `D:\11\Projects\Absolute Solver\docs\tasks\` | `YYYY-MM-DD-<task-id>.md` |
| 代码和测试 | `D:\11\Projects\Absolute Solver\` | 按模块放入现有源码目录，不把实现放进日志目录 |
| 运行报告 | `D:\11\Logs\` | `YYYY-MM-DD-<component>-<topic>.md` |
| TTS 诊断音频 | `D:\11\Logs\tts\` | 临时 WAV，必须由验收命令显式指定 |
| 截图、抓包和临时产物 | `D:\11\Logs\artifacts\` | 必须在报告中引用，不能替代文字结论 |

## 4. 完成判定

任务只有同时满足以下条件才可以标记 `accepted`：

1. 对应需求已明确，且没有与更高优先级要求冲突；
2. 代码或配置已经落地；
3. 必要的单元、集成或运行验收已经通过；
4. 产物写入规定位置；
5. 报告记录实际状态、限制和未决问题；
6. 没有把模拟 Provider、浏览器演示或历史快照当作生产完成证据。

## 5. 当前收束顺序

1. 先完成 P0 的协议、权限和安全缺口；
2. 再完成 P1 的 Native TTS、ASR 和真实 Body 闭环；
3. 再处理 Presence 生产覆盖层、运动和发布收束；
4. 最后才评估 gRPC、流式 TTS 和其他 P3 能力。
