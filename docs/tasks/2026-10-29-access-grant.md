# 二阶段任务卡：Cortico 插件一次性跨主机访问许可

日期：2026-10-29
状态：**in_progress（代码闭环与隔离环境收尾已验证；双机真实 TTS/ASR 未验收）**

## 目标

让 Coo/Cortico 现有 TTS、ASR 插件在保持原 OpenAI 兼容接口和 `tts.voice` / `audio-play` 语义的前提下，访问另一台自有 Host 上的固定服务。目标 Host 本地用户确认一次，Hub 只维护短时、单次许可和事实回执。

## 已实现

- `src/access.rs`：独立于 Presence 的访问状态机，绑定 `source_instance`、目标 Host、服务、操作、TTL 和一次性 grant；支持拒绝、撤销、过期、断线和结果回执。
- `src/wire.rs`：新增 `access.request/decision/grant/revoke/result`，保持 WebSocket v1；schema 已由 generator 重生成。
- `src/bin/hub.rs`：新增 `/access/request`、`/access/state`（含路径/查询形式）、`/access/claim`、`/access/consume`、`/access/result`、`/access/revoke`；Hub 不接收或保存完整音频、完整正文、服务端密钥。`/access/claim` 只原子领取唯一匹配的已批准许可，不允许 Agent 自行创建许可。
- `desktop/tauri-host`：目标 Host 本地面板显示来源、目标服务、操作、原因和 TTL，提供一次性“允许/拒绝”；Host hello 声明 `host_access`。
- `tools/access-agent.mjs`：固定 OpenAI 兼容 `/v1/audio/speech` 与 `/v1/audio/transcriptions` 适配器。必须配置 Hub token、Host ID 和 Agent token；不接受任意 URL、HTTP 方法、命令或 shell 参数。来源实例由 Agent 部署配置固定，忽略客户端自报来源；转发固定上游，并回报 HTTP 状态/耗时。
- `tools/coo-access-broker.mjs`：Coo 侧许可登记层。Coo TTS 插件的 `baseUrl` 指向这里；`solver_request_access` 拿到 Hub 受理的 `request_id` 后立即在 Broker 登记，Broker 只在登记过的那一条处于 ready 时，把它的 `x-solver-request-id` 头顶给 Agent。未登记、重复 ready、已过期一律拒绝，不自行创建 `request_id`。

## 许可关联（2026-10-29 补）

原实现依赖 `/access/claim` 的元组匹配（来源 + Host + 服务 + 操作 + 唯一 Granted）。这在结构上是**相似匹配**而不是**身份校验**，且两条同元组许可同时 Granted 时会返回 `AmbiguousGrant`，使真实双机对话偶发哑火。已改为三层：

1. **Hub 单飞**（`src/access.rs::issue`）：同一 `(source_instance, target_host_id, target_service)` 同时只允许一条 Pending/Granted，第二条返回 `AccessError::Busy` → HTTP 409 `access_busy`。元组分支因此在构造上不可能歧义。
2. **标识优先**（`src/access.rs::claim` + `AccessClaimInput.request_id`）：调用方带 `request_id` 时执行身份校验（来源/Host/服务/操作任一不符 → `RouteMismatch`，不存在则 `Unknown`），**不回落**到元组搜索。已消费返回 `AlreadyConsumed`，过期返回 `Expired`。
3. **适配层显式关联**（`tools/coo-access-broker.mjs` + World 的 `registerApproval`）：`cortico-world-tts@0.1.4` 只发 `Content-Type`（和可选 `Authorization`），没有可放 `request_id` 的字段、配置或钩子，因此插件物理上无法携带标识。关联做成**登记制**：World 拿到 Hub 受理的 id 后写入 Broker；Broker 对该服务的唯一 ready 条目注入 `x-solver-request-id`。这是标识关联，不是目的端模糊匹配。登记失败时 World 明确回报 `spendable: false` 并说明该许可不会被使用，避免"有许可但用不了"的静默失败。

## 部署前接入项

- Cortico World 当前从 Cortico 进程环境读取 `SOLVER_PRESENCE_TOKEN`。尚未从本机安装包核实 World factory 是否提供受支持的 secret 注入 API；部署时应由 Cortico 服务进程环境注入，不能写入 World 普通配置或模型可见 prompt。
- 新增 `SOLVER_BROKER_TOKEN`（World 用）与 `SOLVER_AGENT_TOKEN`（Broker 用）两个独立密钥；Broker 的 `SOLVER_BROKER_PORT` 默认 18081，只需监听 `127.0.0.1`。
- Host WebSocket `device_id` 是客户端 hello 自报值。当前现场确认表示“运行 Host UI 的本地操作员点击”，网络身份仍依赖可信 LAN 和共享 Hub token，不构成强设备身份认证。

## 证据

- `cargo test`：48 个库测试、12 个 Body 测试、24 个 Hub 测试全部通过。
- `cargo check --manifest-path desktop/tauri-host/Cargo.toml`：通过。
- `node --test tools/access-agent.test.mjs`：5/5；新增覆盖"只花费携带的许可、绝不自行生成第二条"与"他人许可被拒时不上游"。
- `node --test tools/coo-access-broker.test.mjs`：6/6；覆盖未登记不转发、登记项精确注入、denied 终态、登记形状拒绝、同服务双 ready 失败关闭、过期不可花费。
- `node --test tools/*.test.mjs`：16/16；`node --test packages/cortico-world-absolute-solver/test/world.test.mjs`：6/6（新增登记失败与未配置两条）。
- 许可关联：单飞使元组分支不再可歧义；标识优先使带 id 的调用无法被"另一条相似许可"顶替；Broker 使未登记的许可在到达 Agent 前即被拒绝。
- 运行报告：`D:\11\Logs\2026-10-29-absolute-solver-access-grant.md`。

## 未完成的真实验收

1. 在 `192.168.1.166` 部署隔离端口 Agent 与 Broker，确认目标 Host 用户会话可显示本地确认面。
2. 用现有 Coo TTS 插件 `baseUrl` 指向 Broker，完成一条固定短句：无许可拒绝 → 目标机点击允许 → 一次转发 → `tts.voice` → 原版 `audio-play` 播放 → 回执，记录 `request_id`、HTTP 状态/耗时。
3. 独立完成一条 WAV ASR。
4. 再验证撤销、TTL、Host 断线和直连回滚。
5. 核实生产 Hub 的 Host allowlist、token 轮换和可信 LAN 边界。当前 WebSocket/HTTP 仍无中心认证和加密，不能宣称抵抗恶意局域网中间人。
6. **ECS（`118.178.174.172`）单独验收，不得并入 LAN 结果**：当前 SSH `22` 超时，反向 `-R 18111` 未建立，无实测证据。恢复后需新增反向隧道，再单独跑一遍 1–4。

## 2026-10-29 Windows 启动复核

- `access-agent.mjs` 与 `coo-access-broker.mjs` 原直接启动判断在 Windows 上比较错误的 `file://` URL，导致模块导入测试通过但进程不监听。已改用 `pathToFileURL(process.argv[1]).href` 与 `import.meta.url` 比较。
- 本机以临时测试凭据分别直接启动 Agent（18082）和 Broker（18081），两者均成功监听；凭据未复用正式服务。
- 双机真实调用未完成。服务器隔离 Host 与 Agent 后续已由计划任务启动，Host 可连接；TTS 请求已登记但服务器网络随后中断，尚未本地确认、调用 TTS/ASR 或更改生产 Cortico 配置。
- 真实上游密钥在一次交互式远程启动尝试中被终端回显。该密钥不得继续用于验收；服务所有者需在上游服务侧轮换后，再配置新的部署密钥。此次回显的临时 Hub/Agent token 和本机隔离 Hub/隧道均已停止或清理。
- 回归：`cargo fmt --check` 与 `cargo test`（48 lib / 12 Body / 24 Hub）通过；Agent、Broker、World Node 测试 17/17 通过；Windows 两个直接启动冒烟通过；`git diff --check` 通过。

## 隔离真实验收准备

- 为避免 SSH 断开回收子进程，新增 `tools/stage2-service-run.ps1` 与 `tools/stage2-host-launch.cmd`，由服务器本机计划任务承载隔离 Hub/Gateway/Agent/Broker/Host。
- 隔离端口固定为 Hub `18201`、真实上游网关 `18083`、Agent `18082`、Broker `18084`；隔离网关复制生产音色/上游配置，但使用新生成的临时客户端 key，生产 `18080` 不变。
- 服务器实际达到：Hub、Agent、Broker、隔离 Gateway 监听；Host 在 Console session 1 连接，`monitor.json` 显示 `solver-server-stage2` / `host_access=true`。
- 已创建并登记一条 TTS 请求（`request_id` 记录在隔离 Hub trace；状态为 `pending`，Broker 状态为 `ready`），但服务器随后 SSH/网络超时，无法确认目标 Host 本地点击，也没有发出 TTS 请求。不可标记 accepted。
- 服务器恢复后，先检查该 request 是否已 `expired`；若已过期，重新创建短 TTL 请求，再由服务器桌面本地点击允许，随后通过 Broker 发送固定短句并保存 WAV/HTTP 回执。
- 停止隔离任务：删除 `AbsoluteSolverStage2-hub`、`AbsoluteSolverStage2-gateway`、`AbsoluteSolverStage2-agent`、`AbsoluteSolverStage2-broker`、`AbsoluteSolverStage2-host`；停止 `absolute-solver-host.exe`，清理 `E:\Absolute-Solver\stage2\` 下 `stage2-secrets.xml`、`tts-stage2-config.json` 和 stage2 日志。

## 2026-10-30 收尾复核

- SSH 恢复后确认五个 `AbsoluteSolverStage2-*` 计划任务均已停止，`18201/18082/18083/18084` 无监听；生产 TTS `127.0.0.1:18080/healthz` 返回 HTTP 200。
- 已删除服务器隔离五个计划任务及 `E:\Absolute-Solver\stage2\` 临时目录，未触碰生产 `Absolute-Solver-*` 任务、Hub、Gateway、Coo 或 Body。
- 本地回归：Rust `48 lib / 12 Body / 24 Hub`，Agent/Broker/World 测试 `22/22`；`cargo fmt --check`、JS 语法和 `git diff --check` 通过。
- 仍不得标记 `accepted`：目标 Host 本地用户尚未对新的短 TTL 请求点击 Allow，未取得真实 `access.result`、TTS WAV/`tts.voice` 播放回执或 ASR WAV 回执。
- 一次历史启动尝试回显了生产 TTS API key；真实验收前必须由 TTS 服务管理端轮换该 key，并验证旧 key 返回 401。文档不记录 key 值。

## 2026-10-30 TTS 重启与本机声音复验

- 按依赖顺序重启服务器任务 `Absolute-Solver-TTS-Upstream` 和 `Absolute-Solver-TTS`，没有重启 Hub/Cortico。上游 `127.0.0.1:9880/docs` 返回 HTTP 200；TTS `127.0.0.1:18080/healthz` 返回 `ok=true`、`upstream_alive=true`。
- 通过本机 Coo 桌宠页面发送测试输入“请用现有的桌宠气泡和语音播放，说一句：本机语音测试完成。”；Cortico 真实处理事件，调用 `tts_speak`、`audio_play`，产生 `tts.voice` WAV，约 2 秒，音色 `xxx_trained`。
- Coo `audio-play` 状态为 active，后端 Windows WPF MediaPlayer、音量 80%、监听 `tts.voice`、自动播放开启；播放后面板读回 `current=null`、`pending=[]`，没有 `audio-play.failed`。本机声音链路复验通过。
- `node tools/access-acceptance-rehearsal.mjs`：10/10 通过，覆盖无许可拒绝、未 Allow 不转发、允许后一次转发、重放拒绝、单飞、撤销拒绝和审计关联。该脚本使用本地模拟 Hub/上游，不是目标 Host 真人确认的双机实测。
- 二阶段整体仍为 `in_progress`：本轮没有新的目标机本地 Allow、生产 `access.result`、真实 Agent 转发或 ASR WAV 验收；历史生产 TTS key 的轮换与旧 key 401 验证也未完成。

## 回滚

本轮没有替换生产 Hub、Body、Coo 或 TTS/ASR 配置。停止 Agent 并恢复原插件 `baseUrl` 即可回到已验证直连路径；Hub 新路由不参与旧回合控制流。
