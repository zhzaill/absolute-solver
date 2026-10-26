# Absolute Solver

Absolute Solver 是一个跨主机运行的实时语音协作系统：一个 Hub 编排回合，多个 Body 连接真实设备，ASR、LLM、TTS 等 Provider 可独立部署。Hub 是逻辑协调点，但当前没有中心身份认证；部署目标仅限可信局域网，不能直接暴露到公网。

## 当前状态

- 应用版本：`0.3.0`；协议：WebSocket v1，支持可选 PCM16 二进制音频帧。
- Native TTS、分段生成与播放、首段先播、打断、active Body handoff、整轮预算和 trace 重启恢复已有代码与运行验收证据。
- ASR Provider 与 WAV 回放链路可用；两次真实麦克风回合都只识别为“嗯”，实时语音识别仍在排查中。
- 当前测试：`cargo fmt --check` 通过；Rust 测试 39 个库、11 个 Body、20 个 Hub 全部通过。
- GitHub `main` 已同步到 `3e695c2`。当前没有 `v0.3.0` tag 或 GitHub Release。

测试通过不等于已发布。正式 Release 还需要补齐 ASR 实麦验收、凭据轮换与 Hub 网络边界记录、版本/构建产物校验、部署回滚和 trace 归档映射，然后创建 tag 并发布对应构建产物。

权威当前快照与证据索引见[当前可信项目现状](docs/ABSOLUTE_SOLVER_CURRENT_STATE.md)；需求入口见[需求索引](docs/REQUIREMENTS_INDEX.md)。运行状态以代码、测试输出和 `D:\11\Logs` 验收证据为准，计划文档不能单独改变状态。

## 架构

```text
Body / Host Panel ── WebSocket v1 ──> Hub ──> ASR / LLM / TTS Provider
       │                               │
       ├─ 麦克风采集                  ├─ 回合编排与权限判断
       ├─ 本地播放                    ├─ Body 路由与 active handoff
       └─ 字幕/渲染                   ├─ 记忆与运行监控
                                       └─ JSONL trace
```

- **Hub**：持有回合状态，编排 Provider，选择 active Body，并记录可观测元数据。
- **Body**：执行麦克风采集、音频播放和渲染；不持有会话主状态。当前原生麦克风采集为显式启用的一次性有界采集。
- **Provider**：ASR、LLM 和 TTS 通过适配器接入，可与 Hub/Body 分机部署。
- **Host Panel/Presence**：提供用户发起的 Host presence 流程；Presence token 不是 Hub 全局认证机制。

## 协议与边界

线上规范以 [协议 v1](docs/protocol.md)、`src/wire.rs` 和 `schemas/` 为准。`docs/WIRE_PROTOCOL_V2.md` 是未采纳设计稿，不代表线上协议。当前保持 WebSocket v1 + 二进制媒体，没有迁移 gRPC。

当前安全边界：Hub HTTP API 与局域网 WebSocket 尚无中心认证且未加密；不要将 Hub 暴露到公网。历史部署日志中的明文凭据已脱敏，但凭据轮换仍未执行。

主要未完成事项：ASR 实麦识别质量、Body 分段播放回执上报、Provider 流式 PCM、Presence 生命周期审计、机器人实体导航/运动验收，以及发布与部署回滚证据收束。

## 构建与测试

需要 Rust stable 工具链。运行：

```powershell
cargo fmt --check
cargo test
cargo build --release
```

主要程序：

- `absolute-solver-hub`
- `absolute-solver-body`
- `absolute-solver-protocol-schema`

生成协议 schema：

```powershell
cargo run --bin absolute-solver-protocol-schema -- schemas
```

## 核心配置

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `SOLVER_HUB_LISTEN` | `0.0.0.0:18100` | Hub 监听地址 |
| `SOLVER_TRACE` | `trace/absolute-solver.jsonl` | JSONL 运行 trace |
| `SOLVER_MEMORY_DB` | `data/absolute-solver-memory.sqlite3` | SQLite 记忆数据库 |
| `SOLVER_ASR_URL` | `http://127.0.0.1:9881` | ASR 兼容接口 |
| `SOLVER_TTS_URL` | `http://127.0.0.1:18080` | TTS 兼容接口 |
| `SOLVER_LLM_URL` | 空 | LLM 兼容接口 |
| `SOLVER_LLM_MODEL` | 空 | LLM 模型名 |
| `SOLVER_LLM_API_KEY` | 空 | 可选 bearer token；不得提交到仓库 |
| `SOLVER_CAPTURE_SECONDS` | `0` | Body 单次麦克风采集时长；仅显式设为 1-30 秒时启用 |

## 目录

```text
src/wire.rs                  协议类型与兼容规则
src/bin/hub.rs               Hub 运行时
src/bin/body.rs              原生音频 Body
src/bin/protocol_schema.rs   schema 生成器
docs/                        协议、要求、现状与任务卡
schemas/                     生成的版本化 schema
tools/                        smoke 与本地辅助工具
desktop/tauri-host/          Tauri Host Panel
```
