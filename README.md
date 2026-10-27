# Absolute Solver

Absolute Solver 是一个部署在可信局域网内的个人私有实时语音运行时：Cortico 负责 Persona 决策，Hub 编排回合和权限，ASR、LLM、TTS 作为 Provider 接入，一个 Native Audio Body 执行真实音频 I/O。Hub 是逻辑协调点，但当前没有中心身份认证，不能直接暴露到公网。

## 当前状态

- 应用版本：`0.3.0`；协议：WebSocket v1，支持可选 PCM16 二进制音频帧。
- Native TTS、分段生成与播放、首段先播、打断、active Body handoff、段级回执、整轮预算和 trace 重启恢复已有代码与运行验收证据。
- ASR Provider 与完整音频经 Hub 的回放链路已验证；实麦人工朗读条件由任务制定者因环境免除，源 WAV 直连 Provider 逐字正确。实麦设备诊断保留为可选补证。
- 当前测试与计数以 `D:\11\Logs` 的最新验收报告和 `docs/ABSOLUTE_SOLVER_CURRENT_STATE.md` 为准；不要使用历史 README 中的旧测试数字。
- 远程 Git 仓库为私有仓库。当前没有对外 `v0.3.0` tag 或 Release。

测试通过不等于运行证据齐全。凭据轮换、Hub 网络边界、构建哈希、部署回滚和 trace 归档映射仍是长期运行或内部版本标记前的收束项，不构成公开发布计划。

权威当前快照与证据索引见[当前可信项目现状](docs/ABSOLUTE_SOLVER_CURRENT_STATE.md)；需求入口见[需求索引](docs/REQUIREMENTS_INDEX.md)。运行状态以代码、测试输出和 `D:\11\Logs` 验收证据为准，计划文档不能单独改变状态。

## 架构

```text
Native Audio Body ── WebSocket v1 ──> Hub ──> ASR / LLM / TTS Provider
       │                               │
       ├─ 麦克风采集                  ├─ 回合编排与权限判断
       ├─ 本地播放                    ├─ Body 路由与 active handoff
       └─ 字幕/渲染                   ├─ 记忆与运行监控
                                       └─ JSONL trace
```

- **Hub**：持有回合状态，编排 Provider，选择 active Body，并记录可观测元数据。
- **Body**：执行麦克风采集、音频播放和渲染；不持有会话主状态。当前核心验收对象是 Native Audio Body；其他 Body 属于扩展。
- **Provider**：ASR、LLM 和 TTS 通过适配器接入，可与 Hub/Body 分机部署。
- **Host Panel/Presence**：提供可选的用户发起 Host presence 流程；Presence token 不是 Hub 全局认证机制。

## 协议与边界

线上规范以 [协议 v1](docs/protocol.md)、`src/wire.rs` 和 `schemas/` 为准。`docs/WIRE_PROTOCOL_V2.md` 是未采纳设计稿，不代表线上协议。当前保持 WebSocket v1 + 二进制媒体，没有迁移 gRPC。

当前安全边界：Hub HTTP API 与局域网 WebSocket 尚无中心认证且未加密；不要将 Hub 暴露到公网。历史部署日志中的明文凭据已脱敏，但凭据轮换仍未执行。

主要未完成事项：Provider 流式 PCM、Presence 生命周期审计、凭据轮换、trace 连续性说明，以及可选的机器人实体导航/运动验收。面板和多 Body 不属于当前核心运行时前置条件。

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
