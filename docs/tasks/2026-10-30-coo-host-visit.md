# 第三阶段任务卡：Coo 跨 Host 串门与环境感知

日期：2026-10-30
状态：**in_progress（协议、状态机、World 与 Host 窗口控制已实现；服务器桌面真实回合未验收）**

## 固定目标

本阶段跳过 ASR。普通“服务器”均指 `192.168.1.166`；`118.178.174.172` 只有显式写 ECS 时才出现。

```text
Coo 本机运行
→ Cortico 决定申请投影
→ 192.168.1.166 本地 Host 确认
→ Host 打开 Coo 原生 /pet
→ 本机桌宠隐藏、本机 audio-play 自动播放关闭
→ 服务器浏览器成为显示和声音输出
→ Cortico 读取结构化 remote 事实
→ 返回/撤销/过期/断线后恢复本机
```

## 本次实现

- `src/projection.rs`：独立 ProjectionVisit 状态机，固定 `coo-pet`、`bottom`、`remote_active`，支持 Host 绑定、单飞、TTL、批准与实际 active 分离、返回、过期、断线和重连快照。
- `src/wire.rs` / `schemas/absolute-solver.wire.v1.schema.json`：新增 `projection.visit.*` 消息；状态消息携带来源实例和目标 Host，不能伪造为控制请求。
- `src/bin/hub.rs`：新增投影申请、当前状态、目标 Host 状态和返回接口；Hub 只做登记、TTL、撤销、广播和审计，不启动 Persona 或浏览器。
- `desktop/tauri-host`：Host caps 声明 `projection_host`；本地面板显示来源、原因、目标、底部锚点、远端声音和剩余 TTL；批准后用固定 URL 打开无装饰底部窗口，撤销/过期/断线关闭窗口并回报事实。
- `packages/cortico-world-absolute-solver`：新增 `solver_request_visit`、`solver_return_visit`、`solver_environment`；World 读取投影与 Host 快照，Host-online 只是事实，不自动替 Persona 决定。
- 本机 Cortico 运行时适配：使用原生 `world:desktop-pet/pet/hideWindow`、`openWindow`；通过 `world:audio-play` 配置热更新关闭 `autoPlay`，清空当前播放队列，返回时恢复此前值。适配结果放在 `local_output` 中，失败不伪报隐藏或静音。
- Tauri Host 监听投影窗口销毁事件；服务器浏览器窗口被关闭时回报 `browser_closed`，由 Hub 进入失败/恢复事实链。
- Host 结束上报遵循 Hub 状态机：Hub 发起的 `persona_return`/`hub_revoked` 在 `returning` 后回报 `returned`；浏览器关闭、TTL、本地托盘结束和连接失败从 `active` 回报 `failed`，不再发送会被 Hub 拒绝的 `active → returned`。

## 已验证

- ProjectionManager Rust 单元测试覆盖固定入口、单飞、错误 Host、批准后 active、返回、TTL、断线。
- World Node 测试覆盖固定投影请求、结构化环境快照、无 token 暴露、本机隐藏/静音 RPC 适配和返回请求。
- `cargo test`：51 lib / 12 Body / 24 Hub 全绿。
- `cargo check --all-targets` 与 `cargo check --manifest-path desktop/tauri-host/Cargo.toml` 通过。
- `cargo fmt`、Node 语法检查、`git diff --check` 通过；schema 已重新生成。
- 本机运行时实测：`world:desktop-pet/pet/state`、`hideWindow`、`openWindow` 返回成功；`world:audio-play/queue/clear` 返回成功；`world:audio-play` 的 `autoPlay` 配置可通过 `/api/config` 热更新。

## 尚未通过的真实验收

必须在 `192.168.1.166` 有可见交互桌面后完成：Host 本地 Allow、服务器浏览器出现原版 whale `/pet` 且位于底部、服务器播放固定 TTS、本机桌宠隐藏且本机 TTS 不播放、Cortico 读到 `current_location=remote`、返回恢复、TTL/撤销/浏览器关闭/断线恢复。证据必须包含本机截图、服务器桌面截图、`visit_id`、Hub trace、Host 事件和 TTS 播放事实。

在上述证据完成前，第三阶段不得标记 `accepted`。报告位置：`D:\11\Logs\2026-10-30-coo-host-visit.md`；截图目录：`D:\11\Logs\artifacts\coo-host-visit\`。

无交互桌面时可使用 `tools/stage3-approve-standin.mjs` 做协议状态回归；该工具明确上报 `standin_no_interactive_desktop`，不得作为服务器窗口、声音或截图验收证据。
